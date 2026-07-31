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
import type { ContextObservation } from './buffer'
import { ControlLane, type ControlsAt } from './controlLane'
import { frozenRingObservations } from './ringObservations'
import type { ContextDisplayTarget } from './session'
import type { SurfaceStack } from '../../shared/context/protocol'
import {
  createObservedReplayClockMap,
  ptsToSessionMs,
  sessionToPtsMs,
} from '../../shared/replayClockMap'
import type { ObservedReplayClockMap } from '../../shared/replayClockMap'
import { logInfo, logWarn } from '../log'
import { SessionClock } from './clock'
import { ProviderHost, TICK_INTERVAL_MS } from './providerHost'
import { SurfaceLane, type SurfaceLaneStatus } from './surfaceLane'
import {
  SurfaceTimeline,
  surfaceTimelineBudgetForRetention,
  type SurfaceTimelineStats,
} from './timeline'
import type { SurfaceSampleWindow } from './timeline'

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
  /** Lane A (#111) — the resident control tracker. Optional in behaviour, not in shape. */
  controls: ControlLane
  controlsEnabled: boolean
  readVisibleWindows: () => { hwnds: readonly string[]; focusHwnd: string | null }
  providers: ProviderHost
  maintenance: ReturnType<typeof setInterval>
}

let runtime: Runtime | null = null

/** A range pinned for one open editor (#64 `onFreeze`, ref-counted by GAP 5). */
interface Freeze {
  freezeId: string
  startMs: number
  endMs: number
  packDurationMs: number
  sourceStartPtsMs: number
  replayClockMap?: ObservedReplayClockMap
}

const freezes = new Map<string, Freeze>()

export interface ContextRuntimeOptions {
  /** The configured replay length; the ring keeps this plus a few seconds. */
  replayMs: number
  /**
   * The capture frame rate. The surface ring samples ONCE PER FRAME (#87): a
   * pack cannot show anything finer than a frame, and sampling coarser than one
   * leaves frames whose box is an interpolation rather than an observation.
   */
  fps?: number
  /** Whether the resident Windows UI Automation control lane may run. */
  uiaEnabled?: boolean
  /**
   * Deterministic dependency seams for the in-process runtime harness. The app
   * never supplies these; keeping them here lets the OFF privacy boundary be
   * exercised through the same public functions Settings calls.
   */
  testing?: {
    platform?: NodeJS.Platform
    createControls?: (nowMs: () => number, retentionMs: number) => ControlLane
    createSurfaceLane?: (
      clock: SessionClock,
      timeline: SurfaceTimeline,
      intervalMs?: number,
    ) => SurfaceLane
    readVisibleWindows?: () => { hwnds: readonly string[]; focusHwnd: string | null }
  }
}

export interface FrozenReplayClockInput {
  /** Exact same-frame observations on the renderer's epoch-based clock. */
  anchors: readonly {
    ptsMs: number
    wallMs: number
  }[]
  /** Raw replay PTS at pack t=0 after the logical last-N cut. */
  sourceStartPtsMs: number
  /** Maximum measured-edge distance that may use the nearest clock segment. */
  maxExtrapolationMs: number
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
  if ((options.testing?.platform ?? process.platform) !== 'win32') return
  // Headed testing and incident response: one flag turns the resident host off
  // without touching settings or rebuilding.
  if (process.argv.includes('--no-context-host')) {
    logInfo('[context] not started (--no-context-host)')
    return
  }
  const retentionMs = Math.max(1_000, options.replayMs) + RETENTION_SLACK_MS
  const clock = new SessionClock(retentionMs)
  const timeline = new SurfaceTimeline(
    64 * 1024,
    surfaceTimelineBudgetForRetention(retentionMs),
  )
  // ONE SAMPLE PER FRAME. Not a cadence of its own: the replay is the evidence,
  // and the ring exists to say where things were in it.
  const intervalMs =
    options.fps !== undefined && options.fps > 0 ? 1000 / options.fps : undefined
  const lane =
    options.testing?.createSurfaceLane?.(clock, timeline, intervalMs) ??
    new SurfaceLane(clock, timeline, intervalMs)
  const readVisibleWindows =
    options.testing?.readVisibleWindows ??
    (() => ({
      hwnds: budgetedWindowHandlesNow(),
      focusHwnd: foregroundWindowHandleNow(),
    }))
  // The real log sink. `ProviderHost` takes it by injection rather than
  // importing it, so the same class can run in the Electron-free harnesses —
  // this is the Electron side, so it passes the real thing.
  const providers = new ProviderHost(clock, { info: logInfo, warn: logWarn })
  const maintenance = setInterval(() => {
    void providers.tick()
    void providers.prune(clock.bufferStartMs())
    // WHICH WINDOWS LANE A LOOKS INSIDE — lane S's answer, not lane A's.
    // `budgetedWindowHandlesNow` already excludes a window occluded to nothing,
    // and a control that cannot be seen cannot be hovered, so walking it is
    // pure cost. Sent on the maintenance tick rather than per sample: the set
    // changes when windows open, close or come forward, not at 100 Hz.
    const current = runtime
    if (current !== null && current.controlsEnabled) {
      const visible = current.readVisibleWindows()
      current.controls.setVisible(visible.hwnds, visible.focusHwnd)
    }
  }, TICK_INTERVAL_MS)
  // Never the reason the process stays alive at quit.
  maintenance.unref()
  // LANE A (#111): the resident control tracker. Started AFTER lane S for the
  // same reason lane S starts after the recorder — a machine where the cheap
  // lane is already failing should not also pay for the expensive one — and it
  // is entirely optional: every reader below treats its absence as "nobody
  // looked inside the windows", which is what was true before it existed.
  const controls =
    options.testing?.createControls?.(() => clock.nowMs(), retentionMs) ??
    new ControlLane(() => clock.nowMs(), retentionMs)
  const controlsEnabled = options.uiaEnabled !== false
  runtime = {
    clock,
    timeline,
    lane,
    controls,
    controlsEnabled,
    readVisibleWindows,
    providers,
    maintenance,
  }
  if (controlsEnabled) {
    const visible = readVisibleWindows()
    controls.setVisible(visible.hwnds, visible.focusHwnd)
    controls.start()
  }
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
  current.controls.stop()
  const controlStatus = current.controls.status()
  if (controlStatus.trees > 0 || chromiumWindowsNotWalked > 0) {
    logInfo(
      `[context] lane A: ${controlStatus.trees} tree(s), ${controlStatus.moves} rectangle change(s), ` +
        `${controlStatus.deaths} element(s) gone, ` +
        `${controlStatus.dutyCycle === null ? 'duty unmeasured' : `${(controlStatus.dutyCycle * 100).toFixed(2)}% of a core`}` +
        `${controlStatus.blockedWindows > 0 ? `, ${controlStatus.blockedWindows} window(s) blocked` : ''}` +
        // Not walking a window is a choice with a consequence, so it is counted
        // where the rest of this lane's cost is counted (#108).
        `${chromiumWindowsNotWalked > 0 ? `, ${chromiumWindowsNotWalked} Chromium window(s) left to their own document rung` : ''}` +
        // What was affordable, beside what was tracked. Over budget is not an
        // error — it is the one fact that explains a thin capture (#108).
        `, ${controlStatus.liveElements} control(s) against a ${controlRefreshBudget()} ` +
        `estimated ${CONTROL_BUDGET_FPS} fps refresh budget`,
    )
    if (controlStatus.liveElements > controlRefreshBudget()) {
      logWarn(
        `[context] lane A: ${controlStatus.liveElements} control(s) is past the ` +
          `${controlRefreshBudget()} that fit a ${CONTROL_BUDGET_FPS} fps rectangle refresh — ` +
          `their geometry cannot have kept up with the picture`,
      )
    }
  }
  chromiumWindowsNotWalked = 0
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
  const retentionMs = Math.max(1_000, replayMs) + RETENTION_SLACK_MS
  runtime?.clock.setRetentionMs(retentionMs)
  runtime?.controls.setRetentionMs(retentionMs)
  runtime?.timeline.setBudgetBytes(surfaceTimelineBudgetForRetention(retentionMs))
}

/**
 * Applies the Windows UI Automation switch immediately without restarting the
 * cheap surface lane. OFF terminates Lane A and erases its retained control
 * history; ON starts a fresh helper and seeds it with the current visible
 * windows. Thus the checkbox controls both capture-time dumps and continuous
 * recording cost, rather than only the next hotkey press.
 */
export function updateContextUiaEnabled(enabled: boolean): void {
  const current = runtime
  if (current === null || current.controlsEnabled === enabled) return
  current.controlsEnabled = enabled
  if (!enabled) {
    current.controls.stop()
    current.controls.clearObservations()
    logInfo('[context] lane A stopped and cleared — Windows UI Automation is off')
    return
  }
  // Seed before start so a replacement receives one current track command,
  // never a stale remembered set followed by a correction.
  const visible = current.readVisibleWindows()
  current.controls.setVisible(visible.hwnds, visible.focusHwnd)
  current.controls.start()
  logInfo('[context] lane A enabled — Windows UI Automation control tracking resumed')
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
export function freezeContext(
  fallbackEndAtWallMs: number,
  replayDurationMs: number,
  replayOriginWallMs?: number,
  replayClock?: FrozenReplayClockInput,
): string | null {
  const current = runtime
  if (current === null) return null
  const packDurationMs = Math.max(0, replayDurationMs)
  let replayClockMap: ObservedReplayClockMap | undefined
  let mappedStartMs: number | undefined
  let mappedEndMs: number | undefined
  if (
    replayClock !== undefined
    && Number.isFinite(replayClock.sourceStartPtsMs)
  ) {
    const mapped = createObservedReplayClockMap(
      replayClock.anchors.map((anchor) => ({
        ptsMs: anchor.ptsMs,
        sessionMs: current.clock.fromWallClockMs(anchor.wallMs),
      })),
      replayClock.maxExtrapolationMs,
    )
    if (mapped.status === 'ready') {
      const coverageStartPtsMs = replayClock.sourceStartPtsMs
      const coverageEndPtsMs =
        replayClock.sourceStartPtsMs + packDurationMs
      mappedStartMs = ptsToSessionMs(
        mapped.map,
        coverageStartPtsMs,
      )
      mappedEndMs = ptsToSessionMs(
        mapped.map,
        coverageEndPtsMs,
      )
      if (
        coverageEndPtsMs >= coverageStartPtsMs
        &&
        mappedStartMs !== undefined
        && mappedEndMs !== undefined
        && mappedEndMs >= mappedStartMs
      ) {
        replayClockMap = mapped.map
      } else {
        mappedStartMs = undefined
        mappedEndMs = undefined
      }
    }
  }
  // THE REPLAY'S OWN ORIGIN WHEN THE RECORDER GAVE ONE (#112).
  //
  // Ticks and replay origins carry epoch-based DOMHighRes timestamps. They are
  // comparable across renderer processes, but the resident ring itself uses
  // this runtime's monotonic SessionClock. Convert at this one boundary.
  //
  // The wall-clock anchor stays for the case with no ticks at all: a display
  // with no recorder, or a platform with no host, where the free-running loop
  // is what filled the ring.
  const endMs =
    mappedEndMs
    ?? (
      replayOriginWallMs === undefined
        ? current.clock.fromWallClockMs(fallbackEndAtWallMs)
        : current.clock.fromWallClockMs(replayOriginWallMs) + packDurationMs
    )
  const startMs = mappedStartMs ?? (endMs - packDurationMs)
  const freezeId = randomUUID()
  current.timeline.freeze(freezeId, startMs, endMs)
  freezes.set(freezeId, {
    freezeId,
    startMs,
    endMs,
    packDurationMs,
    sourceStartPtsMs: replayClock?.sourceStartPtsMs ?? 0,
    ...(replayClockMap === undefined ? {} : { replayClockMap }),
  })
  void current.providers.freeze(freezeId, startMs, endMs)
  const stats = current.timeline.stats()
  const covered = stats.rangeStartMs <= startMs && stats.rangeEndMs >= endMs - 200
  logInfo(
    `[context] froze ${Math.round(packDurationMs)}ms of surface timeline ` +
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
 * Refreshes the complete Win32 window floor immediately before a still image.
 *
 * The ordinary resident cadence is enough for video history, but a window can
 * be created between its last sample and Ctrl+Alt+S. Waiting at most 250 ms for
 * one full resident-host sample closes that omission window without starting a
 * second helper or making a failed context provider hold the capture flow.
 */
export async function refreshContextSurfaceSample(): Promise<
  readonly SurfaceSampleWindow[] | null
> {
  const current = runtime
  return current === null ? null : current.lane.sampleNow(250)
}

export function contextObservationFromSurfaceSample(
  windows: readonly SurfaceSampleWindow[] | null,
  targets: readonly ContextDisplayTarget[],
): Promise<ContextObservation | null> {
  const current = runtime
  if (current === null || windows === null) return Promise.resolve(null)
  const snapshot = new SurfaceTimeline()
  snapshot.append({ timeMs: 0, windows: [...windows] })
  const surfaces = snapshot.surfacesAt(0).surfaces
  return Promise.resolve(
    frozenRingObservations(
      () => ({ surfaces }),
      current.lane.monitors(),
      targets,
      0,
      [0],
    )[0] ?? null,
  )
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
  if (timeMs === null) return null
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
  if (timeMs === null) return null
  const result = current.timeline.surfacesAt(timeMs, freeze.endMs)
  return {
    timeMs: packTMs,
    accuracy: withClockError(result.accuracy, current.lane.clockErrorMs()),
    surfaces: result.surfaces,
  }
}

/**
 * The frozen ring, as the observations an editor context session adopts.
 *
 * THE SEAM THIS CLOSES. The ring is filled at 10 Hz for the whole replay and
 * frozen at capture; the editor's session restores a surface stack at the
 * requested time and mints Core's WINDOW rung from it. Both halves were built
 * and correct, and nothing carried the ring from one to the other — so the
 * session was handed a single capture-instant observation, filed itself as
 * `single-instant`, and answered nothing at every other time. Three hundred and
 * sixty-four samples were recorded, frozen, and never read.
 *
 * Returns an empty array when there is no runtime, no freeze, or no monitor
 * layout to translate with. Empty means the caller keeps whatever it already
 * had — never that the desktop was empty.
 */
export function frozenObservations(
  freezeId: string,
  targets: readonly ContextDisplayTarget[],
  replayDurationMs: number,
): ContextObservation[] {
  const current = runtime
  if (current === null || !freezes.has(freezeId)) return []
  // The ring's OWN sample times, in pack time — not a grid (#87). Every
  // observation the editor adopts is then a moment Core really looked at, and
  // the box drawn at it is measured rather than interpolated.
  const freeze = freezes.get(freezeId)
  const times =
    freeze === undefined
      ? []
      : current.timeline
          .sampleTimesBetween(freeze.startMs, freeze.endMs)
          .map((sessionMs) => packTimeOf(freeze, sessionMs))
          .filter((packTMs): packTMs is number => packTMs !== null)
  return frozenRingObservations(
    (packTMs) => surfacesAt(freezeId, packTMs),
    current.lane.monitors(),
    targets,
    replayDurationMs,
    times,
    // Pack time -> session time is the freeze's own mapping, and lane A files
    // on the session clock, so the conversion happens HERE rather than inside
    // a lane that has no idea a freeze exists.
    (packTMs) => {
      const at = new Map<string, ControlsAt>()
      if (freeze === undefined) return at
      if (!current.controlsEnabled) return at
      const sessionMs = sessionTimeOf(freeze, packTMs)
      if (sessionMs === null) return at
      for (const entry of current.controls.controlsAt(sessionMs)) {
        at.set(entry.hwnd, entry)
      }
      return at
    },
  )
}

/**
 * A frame was captured — observe the desk under THAT frame's time (#105).
 *
 * The one call that replaces relating two clocks with observing one instant.
 * Silent when there is no runtime, which is every non-Windows platform and any
 * session started with --no-context-host.
 */
export function tickSurfaces(
  displayId: string,
  frameWallMs: number,
  frameAgeMs?: number,
  tickDelayMs?: number,
): void {
  const current = runtime
  if (current === null) return
  current.lane.tickAt(
    displayId,
    current.clock.fromWallClockMs(frameWallMs),
    frameAgeMs,
    tickDelayMs,
  )
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

/**
 * "Now" on the replay clock, or null before the runtime exists.
 *
 * The browser extension's events have to land on the SAME clock the surface
 * ring and the video already agree on (SPEC §10.1) — otherwise a DOM element
 * and the window rectangle recorded at the same instant would carry different
 * numbers, and nothing downstream could put them beside each other.
 */
/**
 * The window a freeze covers, on the context clock — the anchor anything
 * recorded outside the ring has to be expressed against to land on the pack's
 * clock (SPEC §10.1).
 */
export function frozenWindow(freezeId: string | null): { startMs: number; endMs: number } | null {
  if (freezeId === null) return null
  const frozen = freezes.get(freezeId)
  return frozen === undefined ? null : { startMs: frozen.startMs, endMs: frozen.endMs }
}

/**
 * Convert one observed context/DOM session timestamp onto the pack's encoded
 * PTS axis. This maps clocks only; the associated object sample remains the
 * exact observation made at `sessionMs`.
 */
export function frozenPackTimeAt(
  freezeId: string | null,
  sessionMs: number,
): number | null {
  if (freezeId === null) return null
  const frozen = freezes.get(freezeId)
  return frozen === undefined ? null : packTimeOf(frozen, sessionMs)
}

export function contextNowMs(): number | null {
  return runtime === null ? null : runtime.clock.nowMs()
}

/**
 * The windows a user can actually SEE right now, top of the z-order first.
 *
 * WHY THIS EXISTS, in the reporter's words: "창이 14개라 하는데 실제로 보이는
 * 창은 몇개 안돼". They were both right — UI Automation's top-level list really
 * did hold fourteen windows, and only a handful of them were on screen. The
 * rest were the ordinary furniture of a Windows desktop: suspended store apps,
 * windows parked on another virtual desktop, background windows that keep a
 * real rectangle while being drawn nowhere. UI Automation reports them as
 * on-screen, and walking one costs the same as walking a window in front of the
 * user — sometimes far more, because a suspended app answers slowly.
 *
 * That is where the control budget was going, and it is why most windows
 * reached the editor with no controls to pick inside them.
 *
 * The surface lane already answers this question better than the helper can. It
 * samples every window rectangle in z-order once per captured frame and
 * subtracts what covers what, so it knows not just which windows exist but
 * which are visible AND unoccluded. That is exactly the set worth spending a
 * control walk on: a window nobody can see is a window nobody can click.
 *
 * Returns an empty list when the lane has nothing yet, which the caller must
 * read as "no opinion" — never as "the desktop is empty".
 */
/**
 * The FOREGROUND window's handle right now, or null.
 *
 * Lane A visits this window every pass and rotates through the rest: it is the
 * one the user is working in, so it is the one whose controls are most likely
 * to have moved since they were last read.
 */
export function foregroundWindowHandleNow(): string | null {
  const current = runtime
  if (current === null) return null
  const { surfaces } = current.timeline.surfacesAt(current.clock.nowMs())
  for (const surface of surfaces) {
    if (surface.foreground && surface.hwnd !== undefined) return surface.hwnd
  }
  return null
}

/**
 * CHROMIUM'S TREE IS NOT LANE A'S TO WALK (#108).
 *
 * Measured on the reporting machine: one `FindAll(Subtree)` per visible window
 * costs 1672.6 ms across the desktop, and 1534 of those milliseconds — 92% —
 * are windows of this one class. ChatGPT 565, Discord 347, Chrome 238 and 151,
 * Orca 231. Every window that is NOT this class, added together, is 138 ms.
 *
 * They are also what breaks the lane rather than merely slowing it: `FindAll`
 * is a provider call that cannot be interrupted, so one of these stalling took
 * the whole lane down for 20 s in CapturePack_2026-07-31_173159 and that
 * capture saved with no control geometry at all — including for the cheap
 * windows it never got to.
 *
 * Depth-capping them was measured and rejected: it is 10-45x faster and returns
 * 6 to 12 of 749 controls, because these trees are narrow and deep.
 *
 * What is given up, plainly: a real browser has a document-native rung and
 * loses nothing, while an Electron application has no such source and is
 * reduced to its window. That is what it already got — these are precisely the
 * windows the per-pass budget was dropping — but now it is a decision instead
 * of an accident, and the count is on the record below.
 */
const CHROMIUM_WINDOW_CLASS = 'Chrome_WidgetWin_1'
let chromiumWindowsNotWalked = 0

/**
 * WHAT THIS LANE CAN AFFORD, AS A NUMBER OF CONTROLS (#108).
 *
 * Structural discovery and rectangle refresh are separate costs, and only the
 * second one has to keep up with the picture. Measured on the reporting
 * machine, re-reading `BoundingRectangle` on held references costs about
 * **80 µs a control** — 13.9 ms for the 202 controls of the whole non-Chromium
 * desktop, against 326 ms for the 3504 controls of the Chromium windows that
 * are no longer walked. One Chrome window alone carried 1033.
 *
 * So the ceiling is a control count, and it is worth writing down: a capture
 * that quietly tracks fewer controls than it should is otherwise
 * indistinguishable from a desktop that has fewer.
 *
 * This is a model built from one measurement on one machine, not a promise.
 * It is here to make the budget legible, and the number it prints is an
 * estimate labelled as one.
 */
const CONTROL_RECT_REFRESH_US = 80
const CONTROL_BUDGET_FPS = 15

export function controlRefreshBudget(
  refreshUsPerControl = CONTROL_RECT_REFRESH_US,
  fps = CONTROL_BUDGET_FPS,
): number {
  if (!(refreshUsPerControl > 0) || !(fps > 0)) return 0
  return Math.floor(1_000_000 / fps / refreshUsPerControl)
}

/**
 * Every window a user can currently see.
 *
 * Occluded to nothing = behind another window at every pixel. It is on screen
 * in the sense that it has a rectangle, and invisible in the sense that
 * matters.
 */
function visibleSurfaceHandles(
  keep: (className: string | undefined, hwnd: string) => boolean,
): string[] {
  const current = runtime
  if (current === null) return []
  const nowMs = current.clock.nowMs()
  const { surfaces } = current.timeline.surfacesAt(nowMs)
  const handles: string[] = []
  for (const surface of surfaces) {
    if (surface.hwnd === undefined) continue
    if (surface.visibleRegion !== undefined && surface.visibleRegion.length === 0) continue
    if (!keep(surface.className, surface.hwnd)) continue
    if (!handles.includes(surface.hwnd)) handles.push(surface.hwnd)
  }
  return handles
}

/**
 * EVERY visible window, Chromium included.
 *
 * For a walk that happens ONCE and carries its own budget — the capture
 * instant, and a still image, which has no frame rate to keep up with at all.
 *
 * Measured on CapturePack_2026-08-01_000034: a still capture of a region filled
 * by an Electron application recorded `"tree": "skipped", "element_count": 0`
 * for the FOCUSED window and 82 elements belonging to a File Explorer behind
 * it. That capture used almost none of its 3000 ms budget and reported
 * `truncated: false`. The window the user had selected was the one thing the
 * semantic layer could not see.
 *
 * The cause was `budgetedWindowHandlesNow` below, whose exclusion is a
 * statement about what a 15 fps lane can afford. Reusing it here applied a
 * frame budget to something that has no frames — and the applications people
 * capture most (an editor, a chat client, a browser, this app's own editor) are
 * exactly the ones it hid.
 */
export function visibleWindowHandlesNow(): string[] {
  return visibleSurfaceHandles(() => true)
}

/**
 * What a PER-FRAME lane can afford to walk (#108).
 *
 * Chromium windows are excluded here and only here. A real browser has a
 * document-native rung and loses nothing; an Electron application is reduced to
 * its window, which is what the per-pass budget was already doing to it by
 * accident. The count is on the record in the lane's own cost line.
 */
export function budgetedWindowHandlesNow(): string[] {
  const skipped = new Set<string>()
  const handles = visibleSurfaceHandles((className, hwnd) => {
    if (className !== CHROMIUM_WINDOW_CLASS) return true
    skipped.add(hwnd)
    return false
  })
  if (skipped.size > chromiumWindowsNotWalked) chromiumWindowsNotWalked = skipped.size
  return handles
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
      `clock ±${Number.isFinite(lane.clockErrorMs) ? lane.clockErrorMs.toFixed(1) : '∞'} ms, ` +
      // WHICH CLOCK THE RING IS ON (#106). Two bases in one ring is the defect
      // that hid behind a healthy-looking sample count, so the count is split.
      `${lane.frameStamped} frame-stamped / ${lane.clockStamped} clock-stamped` +
      (lane.converted > 0 ? ` / ${lane.converted} converted onto the frame clock` : '') +
      // SIGNED, and the sign is the whole point: negative means the host had
      // already looked before the frame's tick reached it, positive means it
      // looked after. Either way it is the distance between the picture and the
      // rectangle filed against it, and it is now folded into the sample's time
      // rather than left for the box to wear as displacement.
      (lane.tickLagMs === null
        ? ''
        : `, tick lag ${lane.tickLagMs > 0 ? '+' : ''}${lane.tickLagMs} ms (folded into the sample time)`) +
      // The compositor's callback delay (#110): median AND p90, because the
      // failure mode is bursts and a median of a bursty series reads healthy.
      // This line is what convicts or acquits the compositor in the next pack.
      (lane.tickDelayMs === null || lane.tickDelayP90Ms === null
        ? ''
        : `, callback late ${lane.tickDelayMs} ms p50 / ${lane.tickDelayP90Ms} ms p90 (folded in)`) +
      (lane.frameAgeMs === null ? '' : `, frame already ${lane.frameAgeMs} ms old`) +
      // THE THREE NUMBERS THAT MAKE THE REST ATTRIBUTABLE (#89).
      //
      // All three have been measured for releases and printed nowhere, so every
      // question about them has been answered with a guess. `frame->core` is
      // subtracted from every converted sample — the ~90% majority — and is
      // renderer-to-main IPC transport, not a clock conversion; `dropped` says
      // whether the lane is silently thinning the ring; `stride` says whether
      // the memory governor coarsened the timeline under the answer.
      `, frame->core ${lane.frameClockOffsetMs === null ? 'unmeasured' : `${lane.frameClockOffsetMs > 0 ? '+' : ''}${lane.frameClockOffsetMs.toFixed(1)} ms`}` +
      `, ${lane.droppedSamples} dropped` +
      `, stride ${String(status.timeline.stride)}`
      + (status.timeline.degradedSamples > 0
        ? ` (${String(status.timeline.degradedSamples)} degraded)`
        : ''),
  )
  if (!lane.running) {
    // "Silence is not absence": a surface timeline that is not running is the
    // reason picking will fall back, and it says so before anyone asks.
    logWarn(`[context] lane S is NOT running${lane.lastError === null ? '' : ` — ${lane.lastError}`}`)
  }
}

function sessionTimeOf(freeze: Freeze, packTMs: number): number | null {
  const finitePackTMs = Number.isFinite(packTMs) ? packTMs : 0
  const clamped = Math.min(
    Math.max(finitePackTMs, 0),
    freeze.packDurationMs,
  )
  if (freeze.replayClockMap !== undefined) {
    const mapped = ptsToSessionMs(
      freeze.replayClockMap,
      freeze.sourceStartPtsMs + clamped,
    )
    if (mapped !== undefined) return mapped
    return null
  }
  return freeze.startMs + clamped
}

function packTimeOf(freeze: Freeze, sessionMs: number): number | null {
  if (!Number.isFinite(sessionMs)) return null
  if (freeze.replayClockMap !== undefined) {
    const ptsMs = sessionToPtsMs(freeze.replayClockMap, sessionMs)
    if (ptsMs === undefined) return null
    return Math.min(
      Math.max(ptsMs - freeze.sourceStartPtsMs, 0),
      freeze.packDurationMs,
    )
  }
  return Math.min(
    Math.max(sessionMs - freeze.startMs, 0),
    freeze.packDurationMs,
  )
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
