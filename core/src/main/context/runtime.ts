// The context runtime: one session clock, one Surface Timeline, one lane S, one
// Provider Host, wired to the app's lifecycle (issues #64, #65).
//
// This is the only module the rest of Core talks to. Everything above it — the
// capture flow, the editor, Settings — sees functions that take a PACK time and
// a point, and never the session clock, the ring or a provider. That boundary is
// what makes docs/temporal-protocol.md §3.1 enforceable: PROVIDERS NEVER SEE
// PACK TIME, and the conversion between the two clocks exists in exactly one
// place, here.
//
//   packTMs    ∈ [0, replayDurationMs]      capture instant = replayDurationMs
//   sessionMs  = freeze.range.startMs + packTMs
//
// AND THE PAST DESKTOP, STRUCTURALLY. A pack time cannot exceed its range, and
// every query is additionally clamped to the frozen range's end, so a surface
// sample taken AFTER the capture — one containing the editor's own fullscreen
// window — can never be returned. The editor would otherwise be the topmost
// surface at every point in its own replay: a bug that writes itself.

import { randomUUID } from 'node:crypto'
import type { SurfaceStack } from '../../shared/context/protocol'
import { logInfo, logWarn } from '../log'
import { SessionClock } from './clock'
import { ProviderHost, TICK_INTERVAL_MS } from './providerHost'
import { SurfaceLane, type SurfaceLaneStatus } from './surfaceLane'
import { SurfaceTimeline, type SurfaceTimelineStats } from './timeline'

/**
 * How much longer than the replay the ring keeps. The editor can only scrub the
 * replay, so anything older is dead weight — but a capture is saved from a
 * buffer that is already full, and the surface sample that covers the very start
 * of the replay is the one taken just before it. A few seconds of slack is what
 * makes the first frame of the replay covered rather than a coin flip.
 */
const RETENTION_SLACK_MS = 5_000

interface Runtime {
  clock: SessionClock
  timeline: SurfaceTimeline
  lane: SurfaceLane
  providers: ProviderHost
  maintenance: ReturnType<typeof setInterval>
}

let runtime: Runtime | null = null

/** A range pinned for one open editor (#64 `onFreeze`, ref-counted by GAP 5). */
interface Freeze {
  freezeId: string
  startMs: number
  endMs: number
}

const freezes = new Map<string, Freeze>()

export interface ContextRuntimeOptions {
  /** The configured replay length; the ring keeps this plus a few seconds. */
  replayMs: number
}

/**
 * Starts the runtime. Safe to call when it is already running, on a platform
 * that has no host, or with the escape hatch on — in every one of those cases it
 * does nothing and the rest of Core behaves exactly as it did before, which is
 * the "no plugin failure may ever cost a capture" rule applied to this subsystem
 * itself.
 */
export function startContextRuntime(options: ContextRuntimeOptions): void {
  if (runtime !== null) return
  // Lane S is Win32. On any other platform the Surface Timeline has no source,
  // and an empty ring answering "no coverage" is the honest behaviour.
  if (process.platform !== 'win32') return
  // Headed testing and incident response: one flag turns the resident host off
  // without touching settings or rebuilding.
  if (process.argv.includes('--no-context-host')) {
    logInfo('[context] not started (--no-context-host)')
    return
  }
  const retentionMs = Math.max(1_000, options.replayMs) + RETENTION_SLACK_MS
  const clock = new SessionClock(retentionMs)
  const timeline = new SurfaceTimeline()
  const lane = new SurfaceLane(clock, timeline)
  // The real log sink. `ProviderHost` takes it by injection rather than
  // importing it, so the same class can run in the Electron-free harnesses —
  // this is the Electron side, so it passes the real thing.
  const providers = new ProviderHost(clock, { info: logInfo, warn: logWarn })
  const maintenance = setInterval(() => {
    void providers.tick()
    void providers.prune(clock.bufferStartMs())
  }, TICK_INTERVAL_MS)
  // Never the reason the process stays alive at quit.
  maintenance.unref()
  runtime = { clock, timeline, lane, providers, maintenance }
  lane.start()
  void providers.bufferStart()
  logInfo(
    `[context] session ${clock.sessionId.slice(0, 8)} started — surface timeline retaining ` +
      `${Math.round(retentionMs / 1000)}s`,
  )
}

export function stopContextRuntime(): void {
  const current = runtime
  if (current === null) return
  runtime = null
  clearInterval(current.maintenance)
  current.lane.stop()
  const stats = current.timeline.stats()
  // The cost, on the record, once per run (GOAL "Capture must stay cheap" is a
  // promise this subsystem has to be able to be checked against).
  logInfo(
    `[context] session ended — ${stats.samples} surface samples, ${stats.checkpoints} checkpoints, ` +
      `${Math.round(stats.bytes / 1024)} KB ring`,
  )
}

/** Settings changed the replay length mid-session (GAP 2: no restart needed). */
export function updateContextRetention(replayMs: number): void {
  runtime?.clock.setRetentionMs(Math.max(1_000, replayMs) + RETENTION_SLACK_MS)
}

/**
 * Pins the captured range (#64 `onFreeze`) and returns the handle the editor
 * asks its questions with. Everything about the mapping from pack time to
 * session time is decided here and nowhere else.
 *
 * `triggerAtWallMs` is the capture flow's `Date.now()` trigger instant. It is
 * converted through the session clock IMMEDIATELY — the value is milliseconds
 * old, which is the only condition under which a wall-clock instant can be
 * placed on a monotonic clock without inventing precision.
 */
export function freezeContext(triggerAtWallMs: number, replayDurationMs: number): string | null {
  const current = runtime
  if (current === null) return null
  const endMs = current.clock.fromWallClockMs(triggerAtWallMs)
  const startMs = endMs - Math.max(0, replayDurationMs)
  const freezeId = randomUUID()
  current.timeline.freeze(freezeId, startMs, endMs)
  freezes.set(freezeId, { freezeId, startMs, endMs })
  void current.providers.freeze(freezeId, startMs, endMs)
  const stats = current.timeline.stats()
  const covered = stats.rangeStartMs <= startMs && stats.rangeEndMs >= endMs - 200
  logInfo(
    `[context] froze ${Math.round(replayDurationMs)}ms of surface timeline ` +
      `(${stats.samples} samples, ${Math.round(stats.bytes / 1024)} KB` +
      `${covered ? '' : ', PARTIAL — the ring does not cover the whole replay'})`,
  )
  return freezeId
}

/** Releases a pinned range. The ring can prune it again from here. */
export function releaseContext(freezeId: string | null): void {
  if (freezeId === null) return
  freezes.delete(freezeId)
  const current = runtime
  if (current === null) return
  current.timeline.release(freezeId)
  void current.providers.release(freezeId)
}

/**
 * #65's one question, asked in PACK time: which top-level window was where, in
 * what order, at time T.
 *
 * Returns null when there is no runtime or no such freeze — never a made-up
 * answer. The caller's fallback is the same one it always had.
 */
export function surfaceStackAt(
  freezeId: string,
  packTMs: number,
  point: { x: number; y: number },
): SurfaceStack | null {
  const current = runtime
  const freeze = freezes.get(freezeId)
  if (current === null || freeze === undefined) return null
  const timeMs = sessionTimeOf(freeze, packTMs)
  const result = current.timeline.stackAt(timeMs, point, freeze.endMs)
  return {
    timeMs: packTMs,
    accuracy: withClockError(result.accuracy, current.lane.clockErrorMs()),
    surfaces: result.surfaces,
  }
}

/** Every surface at a pack time, with visible regions — what claim attribution needs (#66). */
export function surfacesAt(freezeId: string, packTMs: number): SurfaceStack | null {
  const current = runtime
  const freeze = freezes.get(freezeId)
  if (current === null || freeze === undefined) return null
  const timeMs = sessionTimeOf(freeze, packTMs)
  const result = current.timeline.surfacesAt(timeMs, freeze.endMs)
  return {
    timeMs: packTMs,
    accuracy: withClockError(result.accuracy, current.lane.clockErrorMs()),
    surfaces: result.surfaces,
  }
}

export interface ContextStatus {
  sessionId: string
  lane: SurfaceLaneStatus
  timeline: SurfaceTimelineStats
  providers: ReturnType<ProviderHost['statuses']>
}

/** What Settings > Plugins and the log read. null when the runtime never started. */
export function contextStatus(): ContextStatus | null {
  const current = runtime
  if (current === null) return null
  return {
    sessionId: current.clock.sessionId,
    lane: current.lane.status(),
    timeline: current.timeline.stats(),
    providers: current.providers.statuses(),
  }
}

/** The Provider Host, for the registration of built-in providers (step 4). */
export function contextProviderHost(): ProviderHost | null {
  return runtime?.providers ?? null
}

/**
 * One line for main.log at capture time. Deliberately measured rather than
 * asserted: the cost of this subsystem is a release decision, and a number in
 * the log is what makes it one.
 */
export function logContextCost(): void {
  const status = contextStatus()
  if (status === null) return
  const lane = status.lane
  const duty = lane.hostDutyCycle === null ? 'unmeasured' : `${(lane.hostDutyCycle * 100).toFixed(2)}% of a core`
  const ws =
    lane.hostWorkingSetBytes === null
      ? 'unmeasured'
      : `${Math.round(lane.hostWorkingSetBytes / (1024 * 1024))} MB`
  logInfo(
    `[context] lane S: ${status.timeline.samples} samples over ` +
      `${Math.round((status.timeline.rangeEndMs - status.timeline.rangeStartMs) / 1000)}s, ` +
      `${Math.round(status.timeline.bytes / 1024)} KB, host ${duty}, ${ws}, ` +
      `clock ±${Number.isFinite(lane.clockErrorMs) ? lane.clockErrorMs.toFixed(1) : '∞'} ms`,
  )
  if (!lane.running) {
    // "Silence is not absence": a surface timeline that is not running is the
    // reason picking will fall back, and it says so before anyone asks.
    logWarn(`[context] lane S is NOT running${lane.lastError === null ? '' : ` — ${lane.lastError}`}`)
  }
}

function sessionTimeOf(freeze: Freeze, packTMs: number): number {
  const clamped = Math.min(Math.max(packTMs, 0), Math.max(0, freeze.endMs - freeze.startMs))
  return freeze.startMs + clamped
}

/**
 * Every answer carries the measured cross-process clock error (GAP 3). An
 * unmeasured clock makes the answer inexact by definition — never silently
 * exact — which is the whole point of TemporalAccuracy.
 */
function withClockError(
  accuracy: SurfaceStack['accuracy'],
  clockErrorMs: number,
): SurfaceStack['accuracy'] {
  if (clockErrorMs === 0) return accuracy
  return {
    ...accuracy,
    errorMs: accuracy.errorMs + clockErrorMs,
    exact: accuracy.exact && clockErrorMs < 1,
  }
}
