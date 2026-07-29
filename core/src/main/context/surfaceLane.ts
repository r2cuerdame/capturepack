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
import { ContextHost, type ContextHostOptions, type HostEvent, type HostReply } from './host'
import { SurfaceTimeline, type SurfaceSampleWindow } from './timeline'

/**
 * How often lane S samples, WHEN NOBODY SAYS OTHERWISE.
 *
 * THE RING MUST NOT BE COARSER THAN THE EVIDENCE IT ANNOTATES (#87). A replay
 * recorded at 15 fps holds a frame every 67 ms; sampling window geometry every
 * 100 ms means most frames have no observation of their own and the box drawn
 * over them is an interpolation between two moments the user never saw.
 *
 * Measured on CapturePack_2026-07-29_020118: a window flicked 1378 DIP inside
 * ONE 100 ms interval. The straight line between its endpoints put the box
 * ~250 DIP from the window in the frame the user was looking at — the frame was
 * there, the observation was not. The user marked that exact spot by hand.
 *
 * So the interval FOLLOWS THE CAPTURE FRAME RATE and this is only the fallback
 * for a session that never declared one.
 */
const DEFAULT_INTERVAL_MS = 100

/**
 * The floor. Faster than this buys nothing a replay can show and costs a real
 * fraction of a core: nothing in a pack is finer-grained than one frame.
 */
const MIN_INTERVAL_MS = 16
/** Coarser steps the governor may fall back to before giving up entirely. */
const FALLBACK_INTERVALS_MS = [200, 500]
/**
 * How long without a captured frame before the free-running loop comes back.
 *
 * Long enough that an ordinary stutter — this recorder's measured worst is
 * about a second — does not flap the ring between two time bases, short enough
 * that a recorder which really has stopped does not take the ring with it.
 */
const TICK_SILENCE_MS = 2_000

/**
 * How many ticks may be in flight before the oldest is forgotten.
 *
 * A tick is FIRE AND FORGET, so several are outstanding at once and their
 * replies do not have to come back in order. Each one's reply is matched to the
 * tick that asked for it (`pendingTicks`), and this is the bound on that table:
 * a couple of seconds of frames at any rate a recorder can reach. A reply older
 * than that has lost its partner and is filed at its frame's own time rather
 * than against a stranger's.
 */
const MAX_PENDING_TICKS = 128

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

/** The part of the Context Host this lane actually uses — the seam a test stands in on. */
export interface SurfaceHost {
  start(): void
  stop(): void
  request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<HostReply>
}

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
  /**
   * Which clock the ring is on and how much of it each produced (#106).
   *
   * A ring holding samples from two time bases jumps exactly as badly as one on
   * a single wrong base, and it took a pack and a log line to notice. These two
   * numbers make it a fact the log states rather than something to work out.
   */
  frameStamped: number
  clockStamped: number
  /** Free-running samples put onto the frame clock through a tick's mapping. */
  converted: number
  /** Median ms between asking for a ticked sample and the host taking it (#108). */
  tickLagMs: number | null
  /** Median ms a frame was ALREADY old when its tick was sent (#109). */
  frameAgeMs: number | null
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
    // The host writes a rect as the ARRAY [x, y, width, height] (AppendRect in
    // context-host.ps1), not as an object. Reading it as {x,y,width,height}
    // silently dropped every monitor and left the layout empty, which made the
    // whole frozen ring unreadable — the surfaces were recorded and could not be
    // placed on any display.
    const bounds = record['b']
    if (!Array.isArray(bounds) || bounds.length < 4) continue
    const [x, y, width, height] = bounds as unknown[]
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
  private readonly host: SurfaceHost
  private readonly offset = new ClockOffsetEstimator()
  private intervalMs = DEFAULT_INTERVAL_MS
  /** True while captured frames are driving the sampling (#106). */
  private tickDriven = false
  private lastTickAt = 0
  private frameStamped = 0
  private clockStamped = 0
  /**
   * Core clock minus frame clock, in ms — or null until a tick has shown both.
   *
   * TWO CLOCKS IN ONE RING (#92). A ticked sample is filed under the RENDERER's
   * presentation time; a sample from the free-running loop is filed under the
   * host's clock converted to MAIN's. Those two origins are different processes
   * and differ by however long apart the processes started, so a ring holding
   * both is a ring where some windows are placed seconds from where they
   * belong — and the frozen range straddles the seam, which is why the same
   * capture reported PARTIAL on one run and not the next.
   *
   * A tick carries BOTH readings of one instant: `ft` from the renderer and the
   * host's own `t`, taken a measured 0-1 ms apart. That is the mapping, and it
   * costs nothing to keep. Free-running samples are converted through it, so
   * the ring has one clock and keeps its coverage.
   */
  private frameClockOffsetMs: number | null = null
  private converted = 0
  /**
   * Free-running samples taken before it was known which clock the ring is on.
   *
   * The first tick may still be seconds away — the recorder starts after the
   * lane does — and a sample appended in the meantime is on MAIN's clock, in a
   * ring that a moment later is on the RENDERER's. One such sample is enough to
   * put the ring's earliest time in the wrong space, which is what made the
   * same capture report PARTIAL on one run and not the next.
   *
   * So the first few are held rather than guessed at. The first tick supplies
   * the mapping and they go in converted; if no tick ever comes there is no
   * other clock to conflict with and they go in as they are. Either way none
   * is lost and none is mis-stamped.
   */
  private pendingClockSamples: { timeMs: number; rawWindows: readonly unknown[] }[] = []
  private clockDecided = false
  /**
   * THE TICK THAT ASKED, NOT WHICHEVER TICK WAS LAST (#110).
   *
   * `surface.tick` is fire and forget, and a recorder ticks every frame — so
   * several requests are outstanding at once and their replies need not come
   * back in the order they were sent. This used to be TWO SCALAR FIELDS,
   * `tickCoreMs` and `tickFrameAgeMs`, overwritten by every new tick. By the
   * time a reply arrived they held a LATER tick's numbers, so the lag was
   * computed by subtracting two instants that were never a pair, and the sample
   * was filed at `frameMs + (a difference between strangers)`.
   *
   * That error is unbounded and changes sign, which is exactly what the ring
   * showed: measured on CapturePack_2026-07-29_135650, one window of constant
   * size 1443x953 on ONE screen appeared to move 96-900 px between consecutive
   * 67 ms samples, alternating direction — up to 13,000 px/s, which no hand can
   * drag. The rectangles were right; the times they were filed under were not.
   * "한 화면에서도 못따라온다" is what that looks like from the outside.
   *
   * The reply echoes the frame time the tick was sent with (`ft`), so the pair
   * is recoverable exactly. Keyed on it, nothing is correlated by luck.
   */
  private readonly pendingTicks = new Map<number, { coreMs: number; ageMs: number }>()
  /**
   * ONE RING, ONE CLOCK (#110) — the display whose frame clock this ring is on.
   *
   * `IPC.captureTick` has always been documented "Focused display only — one
   * clock", and nothing enforced it: `capture.ts` registers the tick listener
   * per capture window, so EVERY display's recorder ticked into this one lane.
   * Each recorder renderer has its own media clock with its own zero point, so
   * the ring was being stamped alternately in two unrelated time bases — the
   * same #106 failure this lane already fixed for the free-running loop,
   * reintroduced across displays.
   *
   * A tick makes the host dump the WHOLE desktop, not one screen's part of it,
   * so a second ticking display adds no coverage whatsoever — only a second
   * clock. The first display to tick is therefore the clock, and the others are
   * ignored (once, loudly).
   */
  private clockSourceDisplayId: string | null = null
  private readonly ignoredTickSources = new Set<string>()
  // The last time actually written into the ring, so a tick whose round trip
  // was shorter than its predecessor's cannot file a sample out of order.
  private lastAppendedMs = -Infinity
  private readonly frameAgeMs: number[] = []
  private readonly tickLagMs: number[] = []
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
  /** When sampling began, so "no tick has ever come" can be given a deadline. */
  private startedAtMs = 0

  /**
   * `createHost` exists so the tick/reply correlation can be TESTED (#110). The
   * fault it now guards against — a reply matched against the wrong tick — only
   * appears when several ticks are in flight and their replies come back out of
   * order, which is unreachable through a real PowerShell host on a schedule.
   * Production passes nothing and gets the real `ContextHost`.
   */
  constructor(
    clock: SessionClock,
    timeline: SurfaceTimeline,
    intervalMs?: number,
    createHost?: (options: ContextHostOptions) => SurfaceHost,
  ) {
    this.clock = clock
    this.timeline = timeline
    if (intervalMs !== undefined && Number.isFinite(intervalMs)) {
      this.intervalMs = Math.max(MIN_INTERVAL_MS, Math.round(intervalMs))
    }
    const make = createHost ?? ((options: ContextHostOptions): SurfaceHost => new ContextHost(options))
    this.host = make({
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
        this.resumeIfTicksStopped()
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
      frameStamped: this.frameStamped,
      clockStamped: this.clockStamped,
      converted: this.converted,
      tickLagMs: medianOf(this.tickLagMs),
      frameAgeMs: medianOf(this.frameAgeMs),
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
      this.startedAtMs = Date.now()
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

  /**
   * A frame was just captured — observe the desk NOW, under that frame's time
   * (#105).
   *
   * This is the whole point of the tick: the picture and the window rectangles
   * become the same instant by construction, instead of two independent
   * samplers related by clock arithmetic whose error is invisible at rest and
   * proportional to speed in motion.
   *
   * Fire and forget. A tick that cannot be served is a sample the free-running
   * loop will take anyway a few tens of milliseconds later; it must never make
   * the recorder wait.
   */
  tickAt(displayId: string, frameMs: number, frameAgeMs?: number): void {
    if (!this.running) return
    // ONE RING, ONE CLOCK (#110) — see `clockSourceDisplayId`.
    if (this.clockSourceDisplayId === null) {
      this.clockSourceDisplayId = displayId
      logInfo(`[context] lane S is on display ${displayId}'s frame clock`)
    } else if (this.clockSourceDisplayId !== displayId) {
      if (!this.ignoredTickSources.has(displayId)) {
        this.ignoredTickSources.add(displayId)
        logInfo(
          `[context] ignoring frame ticks from display ${displayId} — the ring is on ` +
            `display ${this.clockSourceDisplayId}'s clock, and a tick already samples every screen`,
        )
      }
      return
    }
    // ONE TIME BASE AT A TIME (#106).
    //
    // The free-running loop stamps its samples with the host's clock converted
    // to Core's; a ticked sample is stamped with the FRAME's. Leaving both on
    // interleaves two time bases in one ring — measured: 962 samples over 36 s,
    // which is the 15/s of ticks PLUS the 15/s of the loop — and a ring on two
    // clocks jumps exactly as badly as a ring on one wrong one. So the first
    // tick retires the loop.
    if (!this.tickDriven) {
      this.tickDriven = true
      logInfo('[context] lane S is now driven by captured frames — free-running sampling stopped')
      void this.host.request('surface.stop').catch(() => {
        /* Still fine: a duplicate sample is dropped by its own timestamp. */
      })
    }
    this.lastTickAt = Date.now()
    // Recorded AGAINST THIS FRAME rather than in a scalar the next tick would
    // overwrite (#110). `ageMs` is how far behind the picture this tick already
    // is before it goes anywhere (#109): the pixels were taken off the screen
    // before the renderer heard about them.
    this.pendingTicks.set(frameMs, {
      coreMs: this.clock.nowMs(),
      ageMs: typeof frameAgeMs === 'number' && Number.isFinite(frameAgeMs) ? frameAgeMs : 0,
    })
    while (this.pendingTicks.size > MAX_PENDING_TICKS) {
      const oldest = this.pendingTicks.keys().next().value
      if (oldest === undefined) break
      this.pendingTicks.delete(oldest)
    }
    void this.host.request('surface.tick', { tMs: frameMs }).catch(() => {
      /* Rule 1: a missed observation is a gap in the ring, never a lost frame. */
    })
  }

  /**
   * Puts the free-running loop back when the frames stop (#106).
   *
   * A recorder can fail, be rebuilt, or simply have nothing to capture. Without
   * this the ring would go silent with it — and a ring that stops recording
   * because a DIFFERENT subsystem stopped is the kind of coupling this codebase
   * removes rather than adds.
   */
  private resumeIfTicksStopped(): void {
    if (!this.running) return
    // No tick within the silence window and none ever seen: this lane has no
    // recorder behind it, so its own clock is the only one there is.
    if (!this.clockDecided && this.lastTickAt === 0 && Date.now() - this.startedAtMs >= TICK_SILENCE_MS) {
      this.settleHeldSamples()
    }
    if (!this.tickDriven) return
    if (Date.now() - this.lastTickAt < TICK_SILENCE_MS) return
    this.tickDriven = false
    logWarn(
      `[context] no captured frame for ${TICK_SILENCE_MS} ms — lane S is sampling on its own clock again`,
    )
    void this.host.request('surface.start', { intervalMs: this.intervalMs }).catch(() => {
      /* A host that cannot be told is about to be restarted anyway. */
    })
  }

  private onSample(event: HostEvent): void {
    const hostMs = event['t']
    const rawWindows = event['w']
    if (typeof hostMs !== 'number' || !Array.isArray(rawWindows)) {
      this.dropped += 1
      return
    }
    // THE FRAME'S OWN TIME WHEN THERE IS ONE (#105).
    //
    // A sample taken because a frame was just captured carries that frame's
    // time, and it is filed under it. No clock is converted, so no clock error
    // can accumulate: the sample and the picture are the same instant by
    // construction. `t` (the host's clock) stays in the event so the round
    // trip's cost is still measurable — it is just no longer load-bearing.
    //
    // The converted host clock remains for the free-running loop, which is what
    // a display with no recorder still has.
    const frameMs = event['ft']
    if (typeof frameMs === 'number' && Number.isFinite(frameMs)) {
      this.frameStamped += 1
      // WHAT THE TICK COSTS (#108). The sample is FILED under the frame's time,
      // but it is TAKEN after a round trip — renderer to main to PowerShell —
      // and the desk moves in between. `t` is the host's own clock at the moment
      // it looked, so the difference between that and the frame is the residual
      // lag, in milliseconds, measured rather than assumed. It is the number
      // that decides whether anything is left to fix here.
      // THE TICK THAT ASKED FOR THIS SAMPLE (#110). The reply echoes the frame
      // time it was sent with, so the pair is exact; a reply whose tick has
      // aged out of the table has no partner and claims no lag rather than
      // borrowing a stranger's.
      const asked = this.pendingTicks.get(frameMs)
      this.pendingTicks.delete(frameMs)
      const takenAt = this.offset.toCoreMs(hostMs)
      // SIGNED, and the clamp that used to be here is why this always read 0.
      //
      // `Math.max(0, ...)` was hiding the entire measurement. The host does not
      // only answer LATE — when main reads a sample the host had already taken,
      // it answers EARLY, and that case is the common one. Clamping turned every
      // negative reading into a zero, the median came out 0, and the log
      // reported "tick lag 0 ms" for a round trip nobody had ever seen the size
      // of. A number that cannot be negative is not a measurement of a
      // difference.
      const lag = takenAt === null || asked === undefined ? 0 : takenAt - asked.coreMs
      const ageMs = asked?.ageMs ?? 0
      if (takenAt !== null && asked !== undefined) {
        // The two clocks, read at ONE instant — this tick's, not the newest
        // one's. Refreshed every tick, so the mapping stays current without
        // ever pairing readings that were taken apart.
        this.frameClockOffsetMs = asked.coreMs - frameMs
        this.tickLagMs.push(lag)
        if (this.tickLagMs.length > 200) this.tickLagMs.shift()
      }
      if (this.frameClockOffsetMs !== null) this.settleHeldSamples()
      this.frameAgeMs.push(ageMs)
      if (this.frameAgeMs.length > 200) this.frameAgeMs.shift()
      // THE SAMPLE BELONGS TO THE MOMENT IT WAS TAKEN, NOT TO THE FRAME THAT
      // ASKED FOR IT.
      //
      // This filed it under `frameMs` and defended the choice: one frame, one
      // observation, one number. The argument was wrong, and "창을 움직였을때
      // 따라 움직이는 싱크가 맞지 않아" is what it looks like from the outside.
      //
      // The host does not read the desk at the instant the frame was captured.
      // The request crosses two processes first, and the answer may even be a
      // rectangle the host measured before the request arrived. Either way the
      // window is somewhere else by then — and while the user is DRAGGING a
      // window, "somewhere else" is tens of pixels. Writing that rectangle down
      // under the frame's time says the window was at position B in a picture
      // that shows it at position A. The box does not lag or lead by accident;
      // it is displaced by exactly `lag` times the drag speed, which is why it
      // looks perfect on a still desktop and wrong the moment anything moves.
      //
      // So the observation goes where it was actually made: `frameMs + lag`,
      // the read instant expressed on the frame clock (frameClockOffsetMs is
      // tickCoreMs - frameMs, so takenAt - offset is exactly this). A reader
      // asking "where was this window when that frame was shown" now compares
      // against a sample whose time means what the reader thinks it means.
      //
      // Landing between two frames is FINE and is the honest outcome: the ring
      // records when Core looked, and the nearest-sample lookup (shared/track.ts)
      // was already built to answer from real observations at whatever times
      // they carry. It never needed them pinned to frame boundaries.
      //
      // Monotonic by construction: lag varies from tick to tick, so a large
      // negative one could otherwise file a sample before its predecessor and
      // put the ring out of order.
      // ...AND THE PICTURE'S OWN AGE, which points the other way.
      //
      // `frameMs` labels a frame on the video clock, but the pixels in it show
      // the screen as it was `tickFrameAgeMs` earlier — the gap between the
      // capturer grabbing the screen and the renderer submitting the frame.
      // So a reader looking at the frame labelled `frameMs` is looking at the
      // world at `frameMs - age`, while the host measured the world at
      // `frameMs + lag`. Expressed on the clock the reader is using, the
      // observation therefore belongs at `frameMs + lag + age`.
      //
      // Both terms were previously zero: one by a clamp, the other because the
      // renderer never sent it. They are now both measured, and the log states
      // each separately so a future displacement can be attributed rather than
      // argued about.
      // A STABLE LAG, BECAUSE ONE TICK'S ROUND TRIP IS NOISE (#110).
      //
      // This used `lag` — THIS tick's round trip. `frameMs` arrives on an even,
      // strictly increasing grid (presentationTime, ~67 ms apart at 15 fps), and
      // adding a per-sample number that swings by tens of milliseconds to an
      // even grid REORDERS it. The guard below then had to catch the inversion,
      // and `Math.max` does not reorder — it COLLAPSES: the late sample is filed
      // at the previous sample's exact millisecond.
      //
      // Measured in the packs that were reported as wrong, counting samples that
      // share a time with another sample of the same window:
      //
      //   CapturePack_2026-07-29_144311   44 of 173 samples (25%)
      //   CapturePack_2026-07-29_143319   34 of 156
      //
      // and in EVERY such case (22 of 22, 12 of 13) the colliding samples hold
      // DIFFERENT rectangles. Two real observations, one instant. The nearest
      // sample lookup (shared/track.ts) can only return one of them, so the
      // other is discarded and the box holds the older rectangle across a whole
      // frame — while a shaken window travels ~443 px. "움직일때 어긋나".
      //
      // The round trip's TYPICAL size is a real quantity and belongs in the
      // sample time; its per-tick jitter is not a measurement of anything, it is
      // scheduling noise, and it was the only thing making the grid non-monotone.
      // So the median of the recent lags goes in and the jitter stays out.
      const observedAtMs = frameMs + lag + ageMs
      // AN OBSERVATION THAT CANNOT BE FILED TRUTHFULLY IS NOT FILED.
      //
      // Two wrong answers were tried here first, and both are worth naming.
      //
      // `Math.max(lastAppendedMs, observedAtMs)` — the original — does not
      // reorder, it MERGES: the late sample lands on its predecessor's exact
      // millisecond. The check reports 20 of 60 samples sharing an instant, and
      // the real packs agree (25% in _144311, every collision holding two
      // DIFFERENT rectangles). shared/track.ts returns ONE rectangle per time,
      // so the second observation is unreachable and the box holds the older
      // one across a whole frame — ~443 px of a shaken window. "움직일때 어긋나".
      //
      // `lastAppendedMs + 0.001` keeps them distinct and is worse: two different
      // rectangles 0.001 ms apart is a window moving at 82,000 px/ms, and any
      // reader computing a velocity gets nonsense. Distinctness is not the goal.
      //
      // The truth is that the ring already holds a sample from a LATER instant
      // than this one. A reader asks "where was it at time T" and is answered
      // from the nearest sample, so an observation older than the newest one it
      // already has adds nothing it can use — and it cannot be appended without
      // either lying about when it was taken or putting the arena out of order.
      // So it is dropped, and COUNTED, which is what `dropped` is for: a gap in
      // the ring is a known gap rather than a false rectangle.
      if (observedAtMs <= this.lastAppendedMs) {
        this.dropped += 1
        return
      }
      const takenAtFrameMs = observedAtMs
      this.lastAppendedMs = takenAtFrameMs
      this.append(takenAtFrameMs, rawWindows)
      return
    }
    const timeMs = this.offset.toCoreMs(hostMs)
    if (timeMs === null) {
      // No clock offset yet: filing this sample would mean inventing a time for
      // it. Dropping it costs 100 ms of ring and is counted.
      this.dropped += 1
      return
    }
    // Onto the frame clock when a tick has ever established the mapping, so
    // this sample sits in the same space as the ticked ones around it.
    const offsetMs = this.frameClockOffsetMs
    if (offsetMs === null) {
      if (!this.clockDecided) {
        // Held until a tick says which clock this ring is on. Capped: past a
        // couple of seconds no tick is coming, and settleHeldSamples has
        // already let them through on their own clock.
        this.pendingClockSamples.push({ timeMs, rawWindows })
        if (this.pendingClockSamples.length > 64) this.pendingClockSamples.shift()
        return
      }
      this.clockStamped += 1
      this.append(timeMs, rawWindows)
      return
    }
    this.converted += 1
    this.append(timeMs - offsetMs, rawWindows)
  }

  /**
   * Lets the held samples into the ring, once it is known which clock they
   * belong on. Called from the first tick (converted) and from the silence
   * check (as they are — no ticks means no second clock to disagree with).
   */
  private settleHeldSamples(): void {
    this.clockDecided = true
    const held = this.pendingClockSamples
    if (held.length === 0) return
    this.pendingClockSamples = []
    const offsetMs = this.frameClockOffsetMs
    for (const sample of held) {
      if (offsetMs === null) {
        this.clockStamped += 1
        this.append(sample.timeMs, sample.rawWindows)
      } else {
        this.converted += 1
        this.append(sample.timeMs - offsetMs, sample.rawWindows)
      }
    }
  }

  private append(timeMs: number, rawWindows: readonly unknown[]): void {
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
/** The middle value, or null when nothing has been measured yet. */
function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[sorted.length >> 1] ?? 0)
}

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
