/**
 * Pure accounting for one screen-capture track's delivered-frame counter.
 *
 * Chromium exposes cumulative counters, not individual delivery timestamps.
 * Polling therefore measures only a LOWER BOUND on stalls: an unchanged count
 * proves that one whole interval had no delivery, while an increased count says
 * only that one or more frames arrived somewhere inside that interval.
 */
export interface CaptureCadenceState {
  startedAtMs: number
  firstCountedAtMs: number | null
  baseFrames: number
  lastFrames: number
  lastObservedAtMs: number
  noAdvanceSinceMs: number | null
  worstStallMs: number
  baseDiscarded: number
}

export interface CaptureCadenceReport {
  achievedFps: number
  /** Proven lower bound from complete unchanged polling intervals, not a PTS gap. */
  worstStallMs: number
  discardedFrames: number | null
  sampledMs: number
  gainedFrames: number
}

/** IPC/main accepts older renderers that did not yet include count provenance. */
export interface CaptureCadenceSummary {
  achievedFps: number
  worstStallMs: number
  discardedFrames?: number | null
  sampledMs?: number
  gainedFrames?: number
  backend?: 'chromium-desktop-capture' | 'windows-gdi-bitblt'
  quality?: 'full' | 'degraded'
  requestedFps?: number
  recorderCount?: number
}

export function beginCaptureCadence(
  nowMs: number,
  deliveredFrames: number,
  discardedFrames: number | null,
): CaptureCadenceState {
  return {
    startedAtMs: nowMs,
    firstCountedAtMs: null,
    baseFrames: deliveredFrames,
    lastFrames: deliveredFrames,
    lastObservedAtMs: nowMs,
    noAdvanceSinceMs: null,
    worstStallMs: 0,
    baseDiscarded: discardedFrames ?? 0,
  }
}

/**
 * Incorporates one cumulative-counter reading.
 *
 * Counter regressions are treated as a new baseline, never as negative frame
 * delivery. A normal recorder restart creates a new state before this point;
 * this guard keeps a browser counter reset from producing impossible metrics.
 */
export function observeCaptureCadence(
  state: CaptureCadenceState,
  nowMs: number,
  deliveredFrames: number,
  discardedFrames: number | null,
  warmupMs: number,
): void {
  if (deliveredFrames < state.lastFrames) {
    state.startedAtMs = nowMs
    state.firstCountedAtMs = null
    state.baseFrames = deliveredFrames
    state.lastFrames = deliveredFrames
    state.lastObservedAtMs = nowMs
    state.noAdvanceSinceMs = null
    state.worstStallMs = 0
    state.baseDiscarded = discardedFrames ?? 0
    return
  }

  if (state.firstCountedAtMs === null) {
    state.lastFrames = deliveredFrames
    state.lastObservedAtMs = nowMs
    state.noAdvanceSinceMs = null
    if (nowMs - state.startedAtMs >= warmupMs) {
      state.firstCountedAtMs = nowMs
      state.baseFrames = deliveredFrames
      state.baseDiscarded = discardedFrames ?? 0
    }
    return
  }

  if (deliveredFrames > state.lastFrames) {
    // A frame arrived somewhere after the previous poll. The interval that
    // contains that arrival cannot be claimed as fully stalled. Any complete
    // unchanged intervals before it were already committed below.
    state.lastFrames = deliveredFrames
    state.noAdvanceSinceMs = null
  } else {
    state.noAdvanceSinceMs ??= state.lastObservedAtMs
    state.worstStallMs = Math.max(
      state.worstStallMs,
      Math.max(0, nowMs - state.noAdvanceSinceMs),
    )
  }
  state.lastObservedAtMs = nowMs
}

/** A report at the exact instant capture asks for it. */
export function captureCadenceReport(
  state: CaptureCadenceState,
  nowMs: number,
  deliveredFrames: number,
  discardedFrames: number | null,
  warmupMs: number,
  minimumSampleMs = 1_000,
): CaptureCadenceReport | null {
  observeCaptureCadence(
    state,
    nowMs,
    deliveredFrames,
    discardedFrames,
    warmupMs,
  )
  if (state.firstCountedAtMs === null) return null
  const elapsedMs = nowMs - state.firstCountedAtMs
  if (elapsedMs < minimumSampleMs) return null
  const gainedFrames = Math.max(0, state.lastFrames - state.baseFrames)
  return {
    achievedFps: Math.round((gainedFrames / elapsedMs) * 1_000 * 10) / 10,
    // observeCaptureCadence incorporated the terminal reading above. If its
    // count stayed unchanged, that extends the proven interval to `nowMs`; if
    // it advanced, the final poll interval correctly remains unclaimed.
    worstStallMs: Math.round(state.worstStallMs),
    discardedFrames:
      discardedFrames === null
        ? null
        : Math.max(0, discardedFrames - state.baseDiscarded),
    sampledMs: Math.round(elapsedMs),
    gainedFrames,
  }
}

/**
 * Main-process ownership of the latest report per recorder generation.
 *
 * A display id is stable across window recreation, so a plain Map retains the
 * old renderer's cadence and can write it beside a new recorder. Explicit
 * reset/retain operations make the generation boundary unavoidable.
 */
export class CaptureCadenceRegistry {
  private readonly reports = new Map<number, CaptureCadenceSummary>()

  get(displayId: number): CaptureCadenceSummary | null {
    return this.reports.get(displayId) ?? null
  }

  set(displayId: number, report: CaptureCadenceSummary): void {
    this.reports.set(displayId, report)
  }

  reset(displayId: number): void {
    this.reports.delete(displayId)
  }

  retain(displayIds: ReadonlySet<number>): void {
    for (const displayId of this.reports.keys()) {
      if (!displayIds.has(displayId)) this.reports.delete(displayId)
    }
  }

  get size(): number {
    return this.reports.size
  }
}
