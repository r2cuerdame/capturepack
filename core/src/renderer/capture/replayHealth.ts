/**
 * Small, deterministic policies used by the replay recorder's readiness and
 * pixel-health checks. The DOM/capture plumbing lives in capture.ts; keeping the
 * decisions pure makes the two dangerous false-positive cases executable in
 * CI: a deliberately black screen and an unchanged desktop.
 */

/** First renderer lifetime only: exclude the measured high-load startup span. */
export const PRIMARY_STARTUP_OBSERVATION_MS = 2_000
/** Every acquired primary stream must prove two frames within this bound. */
export const PRIMARY_READY_TIMEOUT_MS = 2_000
export const REPLAY_HEALTH_SAMPLE_MS = 4_000
export const SUSTAINED_BLACK_MS = 4_000
export const SUSTAINED_IDENTICAL_MS = 16_000
export const INCONCLUSIVE_PROBE_COOLDOWN_MS = 60_000

const BLACK_MEAN_LUMA = 8
const BLACK_DARK_RATIO = 0.98
const SAME_FRAME_DELTA = 2
const DIFFERENT_SCREEN_DELTA = 14

export interface FrameFingerprint {
  readonly meanLuma: number
  readonly darkRatio: number
  /**
   * Replay-health uses a tiny number[], while the calibration-only model uses
   * a compact Uint8Array. Both consumers require only indexed, bounded cells.
   */
  readonly cells: ArrayLike<number>
}

export type ReplayHealthSuspicion =
  | 'meaningful-then-black'
  | 'unchanged-too-long'

export interface ReplayHealthState {
  last: FrameFingerprint | null
  meaningfulSeen: boolean
  blackSinceMs: number | null
  identicalSinceMs: number | null
  lastProbeMs: number | null
}

export function createReplayHealthState(
  initial: FrameFingerprint | null = null,
): ReplayHealthState {
  return {
    last: initial,
    meaningfulSeen: initial !== null && !isNearBlack(initial),
    blackSinceMs: null,
    identicalSinceMs: null,
    lastProbeMs: null,
  }
}

/**
 * Creates a resolution-independent 8x8 luma signature from RGBA pixels.
 * Callers normally pass a tiny 64x36 canvas, so this is hundreds of operations
 * every four seconds rather than a second full-resolution video pipeline.
 */
export function fingerprintRgba(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): FrameFingerprint {
  if (
    width <= 0 ||
    height <= 0 ||
    rgba.length < width * height * 4
  ) {
    throw new Error('invalid frame pixels')
  }
  const grid = 8
  const cells: number[] = []
  let sum = 0
  let dark = 0
  for (let gy = 0; gy < grid; gy += 1) {
    const y0 = Math.floor((gy * height) / grid)
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / grid))
    for (let gx = 0; gx < grid; gx += 1) {
      const x0 = Math.floor((gx * width) / grid)
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / grid))
      let cellSum = 0
      let count = 0
      for (let y = y0; y < Math.min(height, y1); y += 1) {
        for (let x = x0; x < Math.min(width, x1); x += 1) {
          const offset = (y * width + x) * 4
          // Integer Rec.709 approximation. Alpha is intentionally ignored.
          const luma =
            (54 * (rgba[offset] ?? 0) +
              183 * (rgba[offset + 1] ?? 0) +
              19 * (rgba[offset + 2] ?? 0)) >>
            8
          cellSum += luma
          sum += luma
          if (luma < 16) dark += 1
          count += 1
        }
      }
      cells.push(count === 0 ? 0 : cellSum / count)
    }
  }
  const pixels = width * height
  return {
    meanLuma: sum / pixels,
    darkRatio: dark / pixels,
    cells,
  }
}

export function fingerprintDelta(
  left: FrameFingerprint,
  right: FrameFingerprint,
): number {
  const count = Math.min(left.cells.length, right.cells.length)
  if (count === 0) return Number.POSITIVE_INFINITY
  let difference = 0
  for (let i = 0; i < count; i += 1) {
    difference += Math.abs((left.cells[i] ?? 0) - (right.cells[i] ?? 0))
  }
  return difference / count
}

export function isNearBlack(fingerprint: FrameFingerprint): boolean {
  return (
    fingerprint.meanLuma <= BLACK_MEAN_LUMA &&
    fingerprint.darkRatio >= BLACK_DARK_RATIO
  )
}

export function retainMeaningfulFingerprint(
  retained: FrameFingerprint | null,
  candidate: FrameFingerprint,
): FrameFingerprint | null {
  return isNearBlack(candidate) ? retained : candidate
}

function probeAllowed(state: ReplayHealthState, nowMs: number): boolean {
  return (
    state.lastProbeMs === null ||
    nowMs - state.lastProbeMs >= INCONCLUSIVE_PROBE_COOLDOWN_MS
  )
}

/**
 * Observe one low-frequency primary frame. A suspicion is not a verdict: the
 * caller must compare it with an independently captured GDI frame.
 */
export function observePrimaryFingerprint(
  state: ReplayHealthState,
  current: FrameFingerprint,
  nowMs: number,
): ReplayHealthSuspicion | null {
  const previous = state.last
  const black = isNearBlack(current)
  if (!black) state.meaningfulSeen = true

  if (black && state.meaningfulSeen) {
    state.blackSinceMs ??= nowMs
  } else {
    state.blackSinceMs = null
  }

  if (
    previous !== null &&
    fingerprintDelta(previous, current) <= SAME_FRAME_DELTA
  ) {
    state.identicalSinceMs ??= nowMs
  } else {
    state.identicalSinceMs = null
  }
  state.last = current

  if (!probeAllowed(state, nowMs)) return null
  if (
    state.blackSinceMs !== null &&
    nowMs - state.blackSinceMs >= SUSTAINED_BLACK_MS
  ) {
    return 'meaningful-then-black'
  }
  if (
    state.identicalSinceMs !== null &&
    nowMs - state.identicalSinceMs >= SUSTAINED_IDENTICAL_MS
  ) {
    return 'unchanged-too-long'
  }
  return null
}

export function markReplayHealthProbe(
  state: ReplayHealthState,
  nowMs: number,
): void {
  state.lastProbeMs = nowMs
}

/**
 * Cross-validation is deliberately asymmetric. We only condemn Chromium when
 * the independent GDI pixels prove that the desktop currently differs.
 */
export function nativeProbeConfirmsFailure(
  suspicion: ReplayHealthSuspicion,
  primary: FrameFingerprint,
  native: FrameFingerprint,
): boolean {
  const delta = fingerprintDelta(primary, native)
  if (suspicion === 'meaningful-then-black') {
    return (
      isNearBlack(primary) &&
      !isNearBlack(native) &&
      delta >= DIFFERENT_SCREEN_DELTA
    )
  }
  // A single native sample cannot distinguish a truly frozen Chromium stream
  // from a legitimate static desktop plus cursor/scaling/colour differences.
  // Frozen recovery needs two native samples that themselves prove motion; the
  // RC deliberately reports the suspicion but does not switch backends.
  return false
}

/**
 * A recorder may start as soon as two distinct, monotonic presentation
 * timestamps arrive. At the timeout, one real frame is sufficient for a
 * genuinely static source; zero frames is an explicit source failure.
 */
export class PrimaryReadiness {
  private firstPresentationMs: number | null = null
  private lastPresentationMs: number | null = null
  private count = 0

  observe(presentationMs: number): boolean {
    if (!Number.isFinite(presentationMs)) return false
    if (
      this.lastPresentationMs !== null &&
      presentationMs <= this.lastPresentationMs
    ) {
      return false
    }
    this.firstPresentationMs ??= presentationMs
    this.lastPresentationMs = presentationMs
    this.count += 1
    return this.count >= 2
  }

  canStart(
    nowMs: number,
    observationStartedMs: number,
    minimumObservationMs: number,
  ): boolean {
    return (
      this.count >= 2 &&
      nowMs - observationStartedMs >= minimumObservationMs
    )
  }

  /** At the hard deadline one actual presentation is enough for a static UI. */
  canStartAtDeadline(): boolean {
    return this.count >= 1
  }

  observedFrames(): number {
    return this.count
  }

  observedSpanMs(): number {
    if (
      this.firstPresentationMs === null ||
      this.lastPresentationMs === null
    ) {
      return 0
    }
    return Math.max(0, this.lastPresentationMs - this.firstPresentationMs)
  }
}
