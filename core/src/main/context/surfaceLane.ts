// Lane S — the sampler that fills the Platform Surface Timeline (#65).
//
// It is Core's, it is always on while the app is recording, and it is the reason
// the window rung of the authority ladder is ALWAYS populated: measured at
// 0.585 ms per sample for 21 visible windows, it covers a whole 30 s ring at
// 100 ms resolution for ~0.6% of one CPU core. That is what makes "windows are
// always selectable" (GOAL.md) true at every time in the buffer rather than only
// at the capture instant.
//
// THE COMPARISON THAT DECIDED THE ARCHITECTURE (docs/temporal-protocol.md §1):
// a full UI Automation desktop checkpoint costs 183.8 ms and, on an idle desk,
// discovers between ZERO and TWO changed nodes per second. Win32 window geometry
// costs 0.585 ms for the same desktop. So the cheap lane runs on a clock and the
// expensive one (lane A, a later step) is driven by this lane's dirty signal —
// never the other way round.
//
// THE CLOCK. The host's timestamps are its own monotonic Stopwatch, and nothing
// synchronises two processes' clocks by itself (protocol GAP 3). Every sample is
// therefore converted through an NTP-style offset measured by ping/pong, the
// rolling median is the offset, and half the round-trip is an ERROR BOUND that
// is folded into every TemporalAccuracy this lane's answers carry. A lane that
// cannot state its clock error is not allowed to claim `exact`.

import { logInfo, logWarn } from '../log'
import { ClockOffsetEstimator, type SessionClock } from './clock'
import { ContextHost, type HostEvent, type HostReply } from './host'
import { SurfaceTimeline, type SurfaceSampleWindow } from './timeline'

/** How often lane S samples. 10 Hz — the design's cadence, and what was measured. */
const DEFAULT_INTERVAL_MS = 100
/** Coarser steps the governor may fall back to before giving up entirely. */
const FALLBACK_INTERVALS_MS = [200, 500]
/** How often Core re-measures the host clock offset. */
const PING_INTERVAL_MS = 2_000
/** How often the ring drops what retention no longer covers. */
const PRUNE_INTERVAL_MS = 1_000

/**
 * Rule 4 of the Context Host (docs/temporal-protocol.md §2.2): it must be
 * CHEAPER THAN THE THING IT OBSERVES. 5% of one core is the hard cap the design
 * fixes; lane S measures at 0.55%, so this exists to catch a machine where the
 * assumption does not hold — a desktop with hundreds of visible windows, a
 * pathological compositor — not to shape the ordinary case.
 */
const HOST_DUTY_CYCLE_CAP = 0.05
/** Consecutive status ticks over the cap before the governor acts. */
const DUTY_CYCLE_STRIKES = 3
/**
 * Working set above which the design says to replace the PowerShell host with a
 * native addon (§2.2). Logged, not enforced: the decision is a release decision,
 * and a warning in main.log is what makes it observable at all.
 */
const HOST_WORKING_SET_WARN_BYTES = 120 * 1024 * 1024

export interface SurfaceLaneStatus {
  running: boolean
  intervalMs: number
  /** Fraction of one core the HOST PROCESS is using, from its own status events. */
  hostDutyCycle: number | null
  hostWorkingSetBytes: number | null
  /** Fraction of one core spent inside the sampling function itself. */
  sampleDutyCycle: number | null
  windows: number | null
  samples: number
  droppedSamples: number
  /** `hostClock - coreClock`, null until the first ping answered. */
  clockOffsetMs: number | null
  /** Half the measured round trip. Infinity when the clock has never been measured. */
  clockErrorMs: number
  lastError: string | null
}

/**
 * One monitor as the HOST sees it, in the physical space its surface rectangles
 * share. Reported at every hello (`scripts/context-host.ps1`, `Monitors()`), so
 * a display hot-plug replaces the layout instead of leaving a stale one.
 */
export interface HostMonitor {
  device: string
  primary: boolean
  bounds: { x: number; y: number; width: number; height: number }
}

/**
 * The hello's `monitors` array, validated rather than cast.
 *
 * Everything crossing the host boundary is untrusted text: a truncated line, an
 * older host, a locale that formatted a number differently. A malformed entry
 * is dropped rather than believed, because a monitor rectangle that is wrong by
 * a field is worse than one that is missing — it would place surfaces on a
 * screen they were never on.
 */
export function parseHostMonitors(raw: unknown): HostMonitor[] {
  if (!Array.isArray(raw)) return []
  const monitors: HostMonitor[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const bounds = record['b']
    if (typeof bounds !== 'object' || bounds === null) continue
    const rect = bounds as Record<string, unknown>
    const x = rect['x']
    const y = rect['y']
    const width = rect['width']
    const height = rect['height']
    if (
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      typeof width !== 'number' ||
      typeof height !== 'number' ||
      width <= 0 ||
      height <= 0
    ) {
      continue
    }
    monitors.push({
      device: typeof record['d'] === 'string' ? record['d'] : '',
      primary: record['primary'] === true,
      bounds: { x, y, width, height },
    })
  }
  return monitors
}

export class SurfaceLane {
  private readonly clock: SessionClock
  private readonly timeline: SurfaceTimeline
  private readonly host: ContextHost
  private readonly offset = new ClockOffsetEstimator()
  private intervalMs = DEFAULT_INTERVAL_MS
  private fallbackIndex = -1
  private dutyStrikes = 0
  private warnedWorkingSet = false
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private pruneTimer: ReturnType<typeof setInterval> | null = null
  private samples = 0
  private dropped = 0
  private hostDutyCycle: number | null = null
  private sampleDutyCycle: number | null = null
  private hostWorkingSet: number | null = null
  /**
   * The host's own monitor rectangles, in the SAME physical space its surface
   * bounds are in. Kept because the ring stores virtual-desktop physical pixels
   * (protocol `RectSpace`) while an annotation's coordinates are one display's
   * SNAPSHOT pixels (SPEC 8.2) — and translating between them needs the
   * monitor a rectangle sits on. The host reports these at every hello, so a
   * display hot-plug replaces them rather than leaving a stale layout behind.
   */
  private hostMonitors: readonly HostMonitor[] = []

  /** The host's monitor layout, for translating ring rectangles onto a snapshot. */
  monitors(): readonly HostMonitor[] {
    return this.hostMonitors
  }
  /** Previous status event, so the duty cycle is a rate and not an average since boot. */
  private lastStatus: { tMs: number; cpuMs: number } | null = null
  private windows: number | null = null
  private lastError: string | null = null
  private running = false

  constructor(clock: SessionClock, timeline: SurfaceTimeline) {
    this.clock = clock
    this.timeline = timeline
    this.host = new ContextHost({
      onEvent: (event) => this.onEvent(event),
      onReady: (hello) => {
        void this.onReady(hello)
      },
      onLost: (reason, willRestart) => {
        this.running = false
        this.lastError = reason
        if (!willRestart) {
          logWarn('[context] lane S is off for the rest of this run — surface data stops here')
        }
      },
    })
  }

  start(): void {
    this.host.start()
    if (this.pruneTimer === null) {
      this.pruneTimer = setInterval(() => {
        // Retention is the ring's only shrink rule; a frozen range is exempt
        // (#64 onFreeze) and the timeline enforces that itself.
        this.timeline.prune(this.clock.bufferStartMs())
      }, PRUNE_INTERVAL_MS)
      // The prune timer must never be what keeps the app alive at quit.
      this.pruneTimer.unref()
    }
  }

  stop(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    if (this.pruneTimer !== null) {
      clearInterval(this.pruneTimer)
      this.pruneTimer = null
    }
    this.running = false
    this.host.stop()
  }

  status(): SurfaceLaneStatus {
    return {
      running: this.running,
      intervalMs: this.intervalMs,
      hostDutyCycle: this.hostDutyCycle,
      hostWorkingSetBytes: this.hostWorkingSet,
      sampleDutyCycle: this.sampleDutyCycle,
      windows: this.windows,
      samples: this.samples,
      droppedSamples: this.dropped,
      clockOffsetMs: this.offset.offsetMs(),
      clockErrorMs: this.offset.errorBoundMs(),
      lastError: this.lastError,
    }
  }

  /** The clock error every answer from this lane must carry (GAP 3). */
  clockErrorMs(): number {
    return this.offset.hasMeasurement() ? this.offset.errorBoundMs() : Number.POSITIVE_INFINITY
  }

  private async onReady(hello: HostReply): Promise<void> {
    // Seed the clock offset BEFORE the first sample arrives. A sample Core
    // cannot place on its own clock is worse than no sample: it would be filed
    // at a time it did not happen, and every answer near it would be wrong by an
    // unknown amount rather than by a measured one.
    const helloMs = hello['hostMs']
    if (typeof helloMs === 'number') this.lastError = null
    this.hostMonitors = parseHostMonitors(hello['monitors'])
    for (let i = 0; i < 5; i += 1) {
      const measured = await this.ping()
      if (!measured) break
    }
    if (!this.offset.hasMeasurement()) {
      logWarn('[context] host clock could not be measured — lane S will not start')
      return
    }
    try {
      const reply = await this.host.request('surface.start', { intervalMs: this.intervalMs })
      const granted = reply['intervalMs']
      if (typeof granted === 'number') this.intervalMs = granted
      this.running = true
      logInfo(
        `[context] lane S sampling every ${this.intervalMs} ms ` +
          `(clock offset ${formatMs(this.offset.offsetMs())}, ±${formatMs(this.offset.errorBoundMs())})`,
      )
    } catch (err) {
      this.lastError = errorMessage(err)
      logWarn(`[context] lane S did not start: ${this.lastError}`)
      return
    }
    if (this.pingTimer === null) {
      this.pingTimer = setInterval(() => {
        void this.ping()
      }, PING_INTERVAL_MS)
      this.pingTimer.unref()
    }
  }

  /** One NTP-style probe. Returns false when the host did not answer. */
  private async ping(): Promise<boolean> {
    const sentAtMs = this.clock.nowMs()
    try {
      const reply = await this.host.request('ping', undefined, 1_000)
      const hostMs = reply['hostMs']
      if (typeof hostMs !== 'number') return false
      const replyAtMs = this.clock.nowMs()
      // The host answers `ping` with one Stopwatch read and nothing else, so its
      // receive and reply instants are the same instant to within the read
      // itself — which is what makes the round trip a bound on the error rather
      // than a measurement of the host's own work.
      this.offset.observe(sentAtMs, hostMs, hostMs, replyAtMs)
      return true
    } catch {
      return false
    }
  }

  private onEvent(event: HostEvent): void {
    if (event.event === 'surface') {
      this.onSample(event)
      return
    }
    if (event.event === 'status') {
      this.onStatus(event)
      return
    }
    if (event.event === 'error') {
      const message = event['message']
      this.lastError = typeof message === 'string' ? message : 'host error'
      logWarn(`[context] host error: ${this.lastError}`)
    }
  }

  private onSample(event: HostEvent): void {
    const hostMs = event['t']
    const rawWindows = event['w']
    if (typeof hostMs !== 'number' || !Array.isArray(rawWindows)) {
      this.dropped += 1
      return
    }
    const timeMs = this.offset.toCoreMs(hostMs)
    if (timeMs === null) {
      // No clock offset yet: filing this sample would mean inventing a time for
      // it. Dropping it costs 100 ms of ring and is counted.
      this.dropped += 1
      return
    }
    const windows: SurfaceSampleWindow[] = []
    for (const raw of rawWindows) {
      const parsed = parseWindow(raw)
      if (parsed !== null) windows.push(parsed)
    }
    this.timeline.append({ timeMs, windows })
    this.clock.observe(timeMs)
    this.samples += 1
    this.windows = windows.length
  }

  private onStatus(event: HostEvent): void {
    const duty = event['dutyCycle']
    const ws = event['ws']
    const cpuMs = event['cpuMs']
    const t = event['t']
    if (typeof duty === 'number') this.sampleDutyCycle = duty
    if (typeof ws === 'number') this.hostWorkingSet = ws
    if (typeof cpuMs === 'number' && typeof t === 'number' && t > 0) {
      // WINDOWED, not cumulative. Cumulative CPU-since-start is the wrong number
      // for a governor in both directions: it is inflated for minutes by the
      // one-time PowerShell start and C# compile (measured 2.3% of a core at
      // 45 s against a 1.1% steady state), and after an hour of running it is so
      // diluted that a lane which started burning a core would never trip the
      // cap. The delta between two status events is the resident cost, which is
      // what GOAL.md's "runs all day" promise is actually about.
      const previous = this.lastStatus
      this.lastStatus = { tMs: t, cpuMs }
      this.hostDutyCycle =
        previous === null || t <= previous.tMs
          ? cpuMs / t
          : (cpuMs - previous.cpuMs) / (t - previous.tMs)
    }
    if (
      !this.warnedWorkingSet &&
      this.hostWorkingSet !== null &&
      this.hostWorkingSet > HOST_WORKING_SET_WARN_BYTES
    ) {
      this.warnedWorkingSet = true
      logWarn(
        `[context] host working set is ${Math.round(this.hostWorkingSet / (1024 * 1024))} MB, past the ` +
          '120 MB trigger for replacing the PowerShell host with a native addon',
      )
    }
    this.governor()
  }

  /**
   * Rule 4, enforced. Over the cap for three consecutive status ticks, lane S
   * halves its own resolution — and at the coarsest step it turns ITSELF OFF
   * rather than keep costing more than it is worth. Every step is logged,
   * because a lane that silently degrades is exactly the "silence is not
   * absence" failure this project keeps fixing.
   */
  private governor(): void {
    const duty = this.hostDutyCycle
    if (duty === null) return
    if (duty <= HOST_DUTY_CYCLE_CAP) {
      this.dutyStrikes = 0
      return
    }
    this.dutyStrikes += 1
    if (this.dutyStrikes < DUTY_CYCLE_STRIKES) return
    this.dutyStrikes = 0
    this.fallbackIndex += 1
    const next = FALLBACK_INTERVALS_MS[this.fallbackIndex]
    if (next === undefined) {
      logWarn(
        `[context] host is using ${(duty * 100).toFixed(1)}% of a core at ${this.intervalMs} ms — ` +
          'stopping lane S; the surface timeline ends here',
      )
      this.running = false
      void this.host.request('surface.stop').catch(() => {
        /* the host is already unhealthy; the stop is best-effort */
      })
      return
    }
    this.intervalMs = next
    logWarn(
      `[context] host is using ${(duty * 100).toFixed(1)}% of a core — dropping lane S to ${next} ms`,
    )
    void this.host.request('surface.start', { intervalMs: next }).catch(() => {
      /* a host that cannot be told is about to be restarted anyway */
    })
  }
}

/**
 * One window from the wire. Strict: a record missing a field is DROPPED rather
 * than defaulted, because a surface with a made-up rectangle is worse than a
 * surface that is not there — it would be offered for picking.
 */
function parseWindow(raw: unknown): SurfaceSampleWindow | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const hwnd = record['h']
  const owner = record['o']
  const pid = record['p']
  const z = record['z']
  const bounds = parseRect(record['b'])
  const client = parseRect(record['c'])
  if (typeof hwnd !== 'string' || typeof pid !== 'number' || typeof z !== 'number') return null
  if (bounds === null) return null
  return {
    hwnd,
    ownerHwnd: typeof owner === 'string' ? owner : '0',
    processId: pid,
    zOrder: z,
    bounds,
    clientBounds: client ?? bounds,
    visible: record['v'] === 1,
    minimized: record['m'] === 1,
    foreground: record['g'] === 1,
    cloaked: record['k'] === 1,
    windowTitle: typeof record['t'] === 'string' ? record['t'] : '',
    className: typeof record['cl'] === 'string' ? record['cl'] : '',
    executableName: typeof record['e'] === 'string' ? record['e'] : '',
  }
}

function parseRect(raw: unknown): { x: number; y: number; width: number; height: number } | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null
  const [x, y, width, height] = raw
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number'
  ) {
    return null
  }
  return { x, y, width, height }
}

function formatMs(value: number | null): string {
  if (value === null) return 'unmeasured'
  if (!Number.isFinite(value)) return 'unbounded'
  return `${value.toFixed(1)} ms`
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
