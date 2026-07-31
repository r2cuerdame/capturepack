/**
 * Desktop pixel exposure, measured against a moving landmark (#89).
 *
 * `temporalAlignment.ts` answers a different question: whether a saved frame
 * and a context sample carry the same *timestamp*. On every capture this repo
 * has measured, they do — nearest-sample error stays inside one frame — and the
 * overlay is still visibly ahead of the picture. Comparing two clocks cannot
 * see that, because both clocks anchor on the same event (frame presentation)
 * and neither knows when the desktop compositor actually put those pixels on
 * the glass.
 *
 * The only axis that can see it is *position*. Give one landmark that moves at
 * an observed speed, read where the context track says it was at pack time T,
 * read where the decoded pixels of the frame at pack time T say it was, and the
 * disagreement is a distance. Divided by the observed speed it is the term
 * nothing in the product represents:
 *
 *     the pixels at pack time T show the world as it was at T - latencyMs
 *
 * Rules this module keeps, because #89 is easy to "fix" wrongly:
 *
 * - No fixed offset, no per-frame allowance, no FPS-derived guess. The number
 *   comes from correlating two observed series or it is not produced at all.
 * - A landmark that did not move cannot time anything. Stationary evidence
 *   returns `insufficient-motion`, never 0 ms.
 * - Nothing here reads or writes `replay_clock_offset_ms`. That quantity means
 *   the offset between one display's replay and the pack clock, and
 *   `focused => 0` is correct by definition. Exposure is a separate quantity
 *   and stays one.
 * - No observation is interpolated. Inversion uses the nearest recorded sample
 *   under the same tie rule as ContextBuffer, so the answer can never be finer
 *   than the sampling interval — and the report says so in `resolutionMs`
 *   instead of implying a precision it does not have.
 */

import { nearestObservedSample } from './temporalAlignment'

export interface LandmarkObservation {
  /** Pack clock, milliseconds. */
  tMs: number
  x: number
  y: number
}

export interface DecodedLandmarkFrame {
  /** Presentation timestamp as declared by the saved replay container. */
  ptsMs: number
  /** Where the landmark is in the decoded pixels of this frame. */
  x: number
  y: number
}

export interface ExposureAlignmentInput {
  /** Sorted by tMs, on the pack clock. */
  contextObservations: readonly LandmarkObservation[]
  /** Sorted by ptsMs, as declared by the saved replay. */
  decodedFrames: readonly DecodedLandmarkFrame[]
  /** SPEC §5.6: pack time = encoded PTS - replay_clock_offset_ms. */
  replayClockOffsetMs: number
  /** Candidate window for the search. Defaults to -100..+500 ms. */
  searchMs?: { minMs: number; maxMs: number }
  /** Search grid. Defaults to 1 ms. */
  stepMs?: number
  /** A landmark that travels less than this over the run cannot time anything. */
  minimumTravelPx?: number
  /**
   * The replay's own declared frame interval.
   *
   * Pass it whenever `decodedFrames` is a filtered subset - a harness that
   * drops frames it could not identify inflates the interval derived from what
   * survived, and the one-frame acceptance boundary would then be measured
   * against a frame rate the recorder never ran at.
   */
  frameIntervalMs?: number
}

export type ExposureAlignmentReason =
  | 'measured'
  | 'insufficient-samples'
  | 'non-monotonic-context-clock'
  | 'non-monotonic-presentation-clock'
  | 'insufficient-motion'
  | 'non-unique-minimum'
  | 'no-overlap'

export interface ExposureAlignmentReport {
  status: 'measured' | 'ambiguous' | 'unavailable'
  reason: ExposureAlignmentReason
  /** Pixels at pack time T show the world at T - latencyMs. */
  latencyMs: number | null
  /**
   * How coarsely this evidence can place the latency, in ms.
   *
   * Two things bound it and the wider one wins. The argmin is often a plateau,
   * and half its width is one bound. The other is a floor that no amount of
   * scanning can beat: inversion picks the NEAREST recorded observation, so the
   * answer cannot be finer than half the interval those observations arrive at.
   *
   * The floor matters most on real evidence, where noise makes exactly one grid
   * point win by a hair and the plateau collapses to a single step. Reporting
   * half a step there would claim a precision the sampling never had.
   */
  resolutionMs: number | null
  /** Mean positional disagreement at the estimate, in pixels. */
  residualPx: number | null
  /** residualPx expressed in ms at the observed speed. */
  residualMs: number | null
  /**
   * Median landmark speed across the steps on which it ACTUALLY MOVED, px/ms.
   *
   * A real context ring files a sample on its own cadence whether or not
   * anything moved, so most consecutive observations of a briefly dragged
   * window are identical. A median over all steps is therefore 0 on evidence
   * that plainly contains motion, and would refuse a measurable capture.
   */
  speedPxPerMs: number | null
  /** Declared PTS interval of the replay, ms. */
  frameIntervalMs: number | null
  comparedFrameCount: number
  /** The acceptance boundary: more than one frame of correlation error fails. */
  withinOneFrame: boolean
}

const DEFAULT_SEARCH: { minMs: number; maxMs: number } = { minMs: -100, maxMs: 500 }
const DEFAULT_STEP_MS = 1
const DEFAULT_MINIMUM_TRAVEL_PX = 24
const MINIMUM_SAMPLES = 8
/** Grid scores are exact arithmetic on the same inputs; only float noise needs slack. */
const PLATEAU_EPSILON_PX = 1e-9

/**
 * The single conversion the product would apply once a latency is measured.
 *
 * A frame at pack time T shows the world at T - latencyMs, so the context
 * observation that belongs beside it is the one recorded at that earlier
 * instant. Applying this in two places double-corrects, which is why it is one
 * exported function and not an inline subtraction.
 */
export function exposureCorrectedContextTimeMs(
  packTimeMs: number,
  latencyMs: number,
): number {
  if (!Number.isFinite(packTimeMs) || !Number.isFinite(latencyMs)) return packTimeMs
  return packTimeMs - latencyMs
}

/**
 * Mean positional disagreement left over when `latencyMs` is applied.
 *
 * Zero at the true latency, one landmark-travel of error when applied twice or
 * with the wrong sign. This is what makes a wrong correction fail loudly
 * instead of looking like progress.
 */
export function residualAfterExposureCorrection(
  input: ExposureAlignmentInput,
  latencyMs: number,
): { residualPx: number | null; residualMs: number | null; comparedFrameCount: number } {
  const observed = input.contextObservations.map((observation) => ({
    tMs: observation.tMs,
    value: observation,
  }))
  if (observed.length === 0) {
    return { residualPx: null, residualMs: null, comparedFrameCount: 0 }
  }
  const score = scoreCandidate(input, observed, latencyMs)
  const speedPxPerMs = medianSpeedPxPerMs(input.contextObservations)
  if (score === null) return { residualPx: null, residualMs: null, comparedFrameCount: 0 }
  return {
    residualPx: score.meanErrorPx,
    residualMs:
      speedPxPerMs === null || speedPxPerMs === 0 ? null : score.meanErrorPx / speedPxPerMs,
    comparedFrameCount: score.comparedFrameCount,
  }
}

/**
 * Correlate a moving landmark's decoded pixels against its context track.
 *
 * The search is a scan over candidate latencies, scored by how far the two
 * series disagree in pixels. The argmin is normally a plateau, because nearest
 * sample lookup cannot resolve finer than the context interval; the plateau's
 * centre is reported as the estimate and its half-width as `resolutionMs`. A
 * plateau with a hole in it is not a measurement and says so.
 */
export function measureExposureLatency(
  input: ExposureAlignmentInput,
): ExposureAlignmentReport {
  const contextObservations = input.contextObservations
  const decodedFrames = input.decodedFrames
  const speedPxPerMs = medianSpeedPxPerMs(contextObservations)
  const frameIntervalMs = input.frameIntervalMs
    ?? medianIntervalMs(decodedFrames.map((frame) => frame.ptsMs))
  const base = {
    latencyMs: null,
    resolutionMs: null,
    residualPx: null,
    residualMs: null,
    speedPxPerMs,
    frameIntervalMs,
    comparedFrameCount: 0,
    withinOneFrame: false,
  }

  if (
    contextObservations.length < MINIMUM_SAMPLES
    || decodedFrames.length < MINIMUM_SAMPLES
    || !Number.isFinite(input.replayClockOffsetMs)
  ) {
    return { ...base, status: 'unavailable', reason: 'insufficient-samples' }
  }
  if (!isMonotonic(contextObservations.map((observation) => observation.tMs))) {
    return { ...base, status: 'unavailable', reason: 'non-monotonic-context-clock' }
  }
  if (!isMonotonic(decodedFrames.map((frame) => frame.ptsMs))) {
    return { ...base, status: 'unavailable', reason: 'non-monotonic-presentation-clock' }
  }

  const travelPx = observedTravelPx(contextObservations)
  const minimumTravelPx = input.minimumTravelPx ?? DEFAULT_MINIMUM_TRAVEL_PX
  if (travelPx < minimumTravelPx || speedPxPerMs === null || speedPxPerMs <= 0) {
    return { ...base, status: 'unavailable', reason: 'insufficient-motion' }
  }

  const search = input.searchMs ?? DEFAULT_SEARCH
  const stepMs = input.stepMs ?? DEFAULT_STEP_MS
  if (!(stepMs > 0) || !(search.maxMs > search.minMs)) {
    return { ...base, status: 'unavailable', reason: 'insufficient-samples' }
  }

  const observed = contextObservations.map((observation) => ({
    tMs: observation.tMs,
    value: observation,
  }))
  const candidates: Array<{ latencyMs: number; meanErrorPx: number; comparedFrameCount: number }> =
    []
  const steps = Math.round((search.maxMs - search.minMs) / stepMs)
  for (let index = 0; index <= steps; index += 1) {
    const latencyMs = search.minMs + index * stepMs
    const score = scoreCandidate(input, observed, latencyMs)
    if (score !== null) candidates.push({ latencyMs, ...score })
  }
  if (candidates.length === 0) {
    return { ...base, status: 'unavailable', reason: 'no-overlap' }
  }

  let bestErrorPx = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    if (candidate.meanErrorPx < bestErrorPx) bestErrorPx = candidate.meanErrorPx
  }
  const plateauIndices: number[] = []
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    if (candidate !== undefined && candidate.meanErrorPx <= bestErrorPx + PLATEAU_EPSILON_PX) {
      plateauIndices.push(index)
    }
  }
  const firstIndex = plateauIndices[0]
  const lastIndex = plateauIndices[plateauIndices.length - 1]
  if (firstIndex === undefined || lastIndex === undefined) {
    return { ...base, status: 'unavailable', reason: 'no-overlap' }
  }
  if (lastIndex - firstIndex + 1 !== plateauIndices.length) {
    return { ...base, status: 'ambiguous', reason: 'non-unique-minimum' }
  }

  const low = candidates[firstIndex] as { latencyMs: number }
  const high = candidates[lastIndex] as { latencyMs: number }
  const latencyMs = (low.latencyMs + high.latencyMs) / 2
  const plateauHalfWidthMs = (high.latencyMs - low.latencyMs) / 2 + stepMs / 2
  const contextIntervalMs = medianIntervalMs(
    contextObservations.map((observation) => observation.tMs),
  )
  const samplingFloorMs = contextIntervalMs === null ? 0 : contextIntervalMs / 2
  const resolutionMs = Math.max(plateauHalfWidthMs, samplingFloorMs)
  const settled = scoreCandidate(input, observed, latencyMs)
  const residualPx = settled === null ? bestErrorPx : settled.meanErrorPx
  const comparedFrameCount = settled === null ? 0 : settled.comparedFrameCount

  return {
    status: 'measured',
    reason: 'measured',
    latencyMs,
    resolutionMs,
    residualPx,
    residualMs: residualPx / speedPxPerMs,
    speedPxPerMs,
    frameIntervalMs,
    comparedFrameCount,
    withinOneFrame:
      frameIntervalMs !== null && Math.abs(latencyMs) <= frameIntervalMs,
  }
}

function scoreCandidate(
  input: ExposureAlignmentInput,
  observed: ReadonlyArray<{ tMs: number; value: LandmarkObservation }>,
  latencyMs: number,
): { meanErrorPx: number; comparedFrameCount: number } | null {
  const first = observed[0]
  const last = observed[observed.length - 1]
  if (first === undefined || last === undefined) return null
  let total = 0
  let compared = 0
  for (const frame of input.decodedFrames) {
    const packTimeMs = frame.ptsMs - input.replayClockOffsetMs
    const worldTimeMs = exposureCorrectedContextTimeMs(packTimeMs, latencyMs)
    if (worldTimeMs < first.tMs || worldTimeMs > last.tMs) continue
    const nearest = nearestObservedSample(observed, worldTimeMs)
    if (nearest === null) continue
    total += Math.hypot(nearest.value.x - frame.x, nearest.value.y - frame.y)
    compared += 1
  }
  if (compared === 0) return null
  return { meanErrorPx: total / compared, comparedFrameCount: compared }
}

function observedTravelPx(observations: readonly LandmarkObservation[]): number {
  let travel = 0
  for (let index = 1; index < observations.length; index += 1) {
    const previous = observations[index - 1]
    const current = observations[index]
    if (previous === undefined || current === undefined) continue
    travel += Math.hypot(current.x - previous.x, current.y - previous.y)
  }
  return travel
}

/**
 * Median speed over the steps the landmark actually moved on.
 *
 * Steps with no displacement are held samples, not evidence of standing still
 * for the purpose of timing: a ring filing at 36 Hz produces several of them
 * between every real move. Counting them would drag the median to 0 and refuse
 * a capture that contains a perfectly good drag. If NO step moved there is
 * nothing to take a median of, and the caller refuses on that.
 */
function medianSpeedPxPerMs(observations: readonly LandmarkObservation[]): number | null {
  const speeds: number[] = []
  for (let index = 1; index < observations.length; index += 1) {
    const previous = observations[index - 1]
    const current = observations[index]
    if (previous === undefined || current === undefined) continue
    const deltaMs = current.tMs - previous.tMs
    if (!(deltaMs > 0)) continue
    const travelPx = Math.hypot(current.x - previous.x, current.y - previous.y)
    if (travelPx <= 0) continue
    speeds.push(travelPx / deltaMs)
  }
  return median(speeds)
}

function medianIntervalMs(times: readonly number[]): number | null {
  const intervals: number[] = []
  for (let index = 1; index < times.length; index += 1) {
    const previous = times[index - 1]
    const current = times[index]
    if (previous === undefined || current === undefined) continue
    intervals.push(current - previous)
  }
  return median(intervals)
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] as number
  return (((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2)
}

function isMonotonic(values: readonly number[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1]
    const current = values[index]
    if (previous === undefined || current === undefined) return false
    if (!Number.isFinite(previous) || !Number.isFinite(current)) return false
    if (current < previous) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// The fixture. Deterministic: no clock, no randomness, no hidden state.
// ---------------------------------------------------------------------------

export interface SyntheticMotionOptions {
  /** Landmark speed along x, px/ms. */
  velocityXPxPerMs?: number
  /** Landmark speed along y, px/ms. */
  velocityYPxPerMs?: number
  /** Ground truth: how long after the world moves its pixels reach the glass. */
  exposureLatencyMs: number
  /** Context sampling interval, ms. The ring runs near 16.7. */
  contextIntervalMs: number
  /** Declared PTS interval of the saved replay, ms. */
  frameIntervalMs: number
  durationMs: number
  /** SPEC §5.6 offset of this display's replay against the pack clock. */
  replayClockOffsetMs?: number
  originX?: number
  originY?: number
  /** Deterministic +/- jitter applied to context sample times, ms. */
  contextJitterMs?: number
  seed?: number
  /**
   * Restrict the landmark's travel to this window, holding it still outside.
   *
   * This is the shape real evidence has: a ring files on its own cadence for
   * the whole capture and the window is dragged for a fraction of a second in
   * the middle of it, so most consecutive observations are identical.
   */
  motionWindowMs?: { startMs: number; endMs: number }
}

/**
 * One landmark moving at a known speed, seen twice: live by the context track,
 * and `exposureLatencyMs` late by the pixels.
 *
 * Positions are rounded because pixels are integers, so a slow enough landmark
 * genuinely cannot express the latency — which is the point of the
 * insufficient-motion refusal rather than a defect of the fixture.
 */
export function syntheticMovingLandmark(
  options: SyntheticMotionOptions,
): ExposureAlignmentInput {
  const velocityX = options.velocityXPxPerMs ?? 0
  const velocityY = options.velocityYPxPerMs ?? 0
  const originX = options.originX ?? 0
  const originY = options.originY ?? 0
  const offsetMs = options.replayClockOffsetMs ?? 0
  const jitterMs = options.contextJitterMs ?? 0
  let seed = options.seed ?? 1

  const motion = options.motionWindowMs
  const positionAt = (worldMs: number): { x: number; y: number } => {
    let travelledMs = worldMs
    if (motion !== undefined) {
      travelledMs = Math.min(Math.max(worldMs, motion.startMs), motion.endMs) - motion.startMs
    }
    return {
      x: Math.round(originX + velocityX * travelledMs),
      y: Math.round(originY + velocityY * travelledMs),
    }
  }

  const contextObservations: LandmarkObservation[] = []
  for (let tMs = 0; tMs <= options.durationMs; tMs += options.contextIntervalMs) {
    let sampledMs = tMs
    if (jitterMs > 0) {
      seed = (seed * 1103515245 + 12345) % 2147483648
      sampledMs = tMs + ((seed / 2147483648) * 2 - 1) * jitterMs
    }
    if (sampledMs < 0) sampledMs = 0
    contextObservations.push({ tMs: sampledMs, ...positionAt(sampledMs) })
  }
  contextObservations.sort((a, b) => a.tMs - b.tMs)

  const decodedFrames: DecodedLandmarkFrame[] = []
  for (let packMs = 0; packMs <= options.durationMs; packMs += options.frameIntervalMs) {
    decodedFrames.push({
      ptsMs: packMs + offsetMs,
      ...positionAt(packMs - options.exposureLatencyMs),
    })
  }

  return {
    contextObservations,
    decodedFrames,
    replayClockOffsetMs: offsetMs,
  }
}
