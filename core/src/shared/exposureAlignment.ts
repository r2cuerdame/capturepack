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

/**
 * One decoded frame, and how well it matched every rectangle it was scored
 * against. The scoring itself belongs to whoever has the pixels — the offline
 * harness has ffmpeg, the app has a canvas — but the fit below must be the same
 * code in both, or they can disagree about the same capture.
 */
export interface FrameScoreRow {
  ptsMs: number
  scores: ReadonlyArray<{ tMs: number; score: number }>
}

/**
 * THE OFFSET A SLOW DRAG CAN STILL SHOW (#89).
 *
 * The measurement above asks each frame which rectangle it is showing, then
 * fits an offset to the answers. That needs consecutive observations to be
 * TELLABLE APART, and a slow drag moves the window a few pixels between them —
 * so no candidate clears the confidence margin, almost nothing survives, and
 * the whole segment refuses. Three field packs in a row refused exactly that
 * way while the owner was dragging deliberately slowly to look at the problem.
 *
 * This asks the question the other way round, in pixel space, and never
 * identifies anything: for each hypothesised offset, score every decoded frame
 * against the rectangle the context says was there at that frame's time plus
 * the offset, and total it. One frame's row is nearly flat on a slow drag; a
 * hundred of them summed is not, because the true offset is the only one that
 * lines up all of them at once.
 *
 * It is a different estimator, not a relaxed gate. Where the identification
 * path can answer, both are reported and they are expected to agree; where it
 * cannot, this one still can, and its own plateau says how sharply.
 */
export interface PixelScoreFit {
  /**
   * Positive = the picture is BEHIND its own timestamp, i.e. the frame stamped
   * t shows the desktop as it was at t - latencyMs. Same sign as
   * `measureExposureLatency`, so the two can be read against each other.
   */
  latencyMs: number
  resolutionMs: number
  comparedFrames: number
  /** Peak total against the flattest total in the sweep — 0 means no signal. */
  contrast: number
}

export function fitOffsetByPixelScore(
  frames: readonly FrameScoreRow[],
  search: { minMs: number; maxMs: number },
  stepMs: number,
  replayClockOffsetMs: number,
  candidateWindowMs: number,
): PixelScoreFit | null {
  const usable = frames.filter((frame) => frame.scores.length > 0)
  if (usable.length < 8 || !(stepMs > 0) || !(search.maxMs > search.minMs)) return null

  const totals: Array<{ offsetMs: number; total: number; count: number }> = []
  const steps = Math.round((search.maxMs - search.minMs) / stepMs)
  for (let index = 0; index <= steps; index += 1) {
    const offsetMs = search.minMs + index * stepMs
    let total = 0
    let count = 0
    for (const frame of usable) {
      // SPEC 5.6 defines the offset as `t_i = t + offset` — display time from
      // PACK time — so reaching pack time from a decoded frame subtracts it.
      const wanted = frame.ptsMs - replayClockOffsetMs + offsetMs
      // The nearest OBSERVED rectangle to the hypothesised instant. Nearest,
      // never interpolated: an interpolated rectangle is a position the window
      // never occupied, and scoring pixels against one would invent evidence.
      let nearest: { tMs: number; score: number } | null = null
      let nearestGap = Number.POSITIVE_INFINITY
      for (const entry of frame.scores) {
        const gap = Math.abs(entry.tMs - wanted)
        if (gap < nearestGap) {
          nearestGap = gap
          nearest = entry
        }
      }
      // Outside the scored window this frame has no opinion, and counting it as
      // zero would reward offsets that simply run off the end of the evidence.
      if (nearest === null || nearestGap > candidateWindowMs) continue
      total += nearest.score
      count += 1
    }
    if (count >= 8) totals.push({ offsetMs, total, count })
  }
  if (totals.length < 3) return null

  // Only offsets every frame could be compared over. A sweep whose ends drop
  // frames would otherwise prefer whichever end kept the easiest ones.
  let maxCount = 0
  for (const entry of totals) if (entry.count > maxCount) maxCount = entry.count
  const level = totals.filter((entry) => entry.count === maxCount)
  if (level.length < 3) return null

  let best = level[0] as { offsetMs: number; total: number; count: number }
  let worst = best
  for (const entry of level) {
    if (entry.total > best.total) best = entry
    if (entry.total < worst.total) worst = entry
  }
  const span = best.total - worst.total
  if (!(span > 0)) return null

  // The plateau is every offset within 2% of the peak, which is the same
  // "how sharply is this decided" question the identification path answers with
  // its own plateau. A wide one is a real answer that says it is imprecise.
  const threshold = best.total - span * 0.02
  let firstIndex = -1
  let lastIndex = -1
  for (let index = 0; index < level.length; index += 1) {
    const entry = level[index]
    if (entry === undefined || entry.total < threshold) continue
    if (firstIndex < 0) firstIndex = index
    lastIndex = index
  }
  const low = level[firstIndex]
  const high = level[lastIndex]
  if (low === undefined || high === undefined) return null
  return {
    // The sweep hypothesises "this frame shows the rectangle from ptsMs +
    // offset"; a match at a NEGATIVE offset is a picture lagging its stamp,
    // which is a POSITIVE latency.
    latencyMs: -((low.offsetMs + high.offsetMs) / 2),
    resolutionMs: (high.offsetMs - low.offsetMs) / 2 + stepMs / 2,
    comparedFrames: maxCount,
    contrast: span / Math.max(1, Math.abs(best.total)),
  }
}

/**
 * PUT THE OBSERVATIONS ON THE PICTURE'S CLOCK (#89).
 *
 * A tracked box must sit on the window as the PICTURE shows it, not where the
 * window truly was — GOAL "The box sits on the picture", and before it "The
 * picture is the clock" (#81). The recorder puts pixels on the glass late, so
 * the frame stamped `t` shows the desktop as it was at `t - latency`. Measured
 * at ~127 ms on the reference desk, agreed by three independent segments and by
 * two estimators that share no code.
 *
 * The correction is therefore to move each observation LATER by the latency:
 * the rectangle the window really occupied at `t` is the one a viewer sees at
 * `t + latency`, because that is when its pixels arrive.
 *
 * What this deliberately does NOT do:
 *
 * - It does not invent samples. Every `t_ms` moves by the same constant, so the
 *   set of rectangles is exactly the set that was observed (SPEC §8.3: a sample
 *   is a measurement of a real window, never an interpolation).
 * - It does not reorder them. A constant shift preserves the ascending order
 *   §8.3 requires.
 * - It does not clamp into a lifetime or a duration. That is a trim's job
 *   (`rebaseAnnotationClock`), and doing both here would silently drop the tail
 *   of a track whose last observations move past the end.
 *
 * Applying it is a decision recorded per pack, not a constant compiled in: the
 * value travels in `media.cadence.source_latency` so a reader can undo it.
 */
export function shiftObservationsToPicture<T extends { t_ms: number }>(
  samples: readonly T[],
  latencyMs: number,
): T[] {
  if (!Number.isFinite(latencyMs) || latencyMs === 0) return [...samples]
  const shift = Math.round(latencyMs)
  return samples.map((sample) => ({ ...sample, t_ms: sample.t_ms + shift }))
}

/**
 * Whether a measured latency may be applied at all.
 *
 * A number the estimator refused to produce is not a small correction, it is no
 * correction — the same rule the cadence fields obey. A negative one would mean
 * the picture leads its own timestamp, which is not a thing a recorder does; it
 * is a sign the measurement was wrong, and applying it would move boxes the
 * wrong way twice as far as leaving them alone.
 *
 * The ceiling is deliberately generous rather than tuned: this is a sanity
 * bound against a broken measurement, not a claim about what is plausible.
 */
export const MAXIMUM_APPLICABLE_LATENCY_MS = 1_000

export function isApplicableExposureLatency(latencyMs: number | null): boolean {
  return (
    latencyMs !== null
    && Number.isFinite(latencyMs)
    && latencyMs > 0
    && latencyMs <= MAXIMUM_APPLICABLE_LATENCY_MS
  )
}

/**
 * A GRAYSCALE PLANE, WHOEVER PRODUCED IT.
 *
 * ffmpeg hands the offline harness `-pix_fmt gray`; a canvas hands the app the
 * red channel of `getImageData`. Both are one byte per pixel in row order, and
 * the scorer must not care which, or the app and the harness can disagree about
 * the same capture — the thing sharing this file exists to prevent.
 */
export interface GrayPlane {
  data: Uint8Array | Uint8ClampedArray | Buffer
  width: number
  height: number
}

/**
 * How well a rectangle's four edges explain the gradients in one frame (#89).
 *
 * A window border is a step in luminance, so the measure is the gradient ON the
 * proposed edge minus the gradient a little way INSIDE it. Subtracting the
 * inside is what stops a busy wallpaper from scoring as well as a real border:
 * texture raises both terms and cancels, an edge raises only the first.
 *
 * `scale` converts the rectangle's desktop pixels into the replay's, which is
 * the recorder's downscale and nothing else.
 *
 * Returns null when too little of the rectangle lies inside the frame to judge
 * — a window mostly off-screen is not evidence, and scoring it on its visible
 * sliver would let a stray edge decide the whole fit.
 */
export function rectangleEdgeScore(
  frame: GrayPlane,
  scale: number,
  bounds: { x: number; y: number; width: number; height: number },
): number | null {
  const { width, height } = frame
  const px = frame.data
  const x0 = Math.round(bounds.x * scale)
  const y0 = Math.round(bounds.y * scale)
  const x1 = Math.round((bounds.x + bounds.width) * scale)
  const y1 = Math.round((bounds.y + bounds.height) * scale)
  let edge = 0
  let reference = 0
  let samples = 0
  for (let y = Math.max(1, y0 + 4); y < Math.min(height - 1, y1 - 4); y += 3) {
    const row = y * width
    for (const x of [x0, x1]) {
      if (x < 2 || x >= width - 2) continue
      edge += Math.abs((px[row + x] as number) - (px[row + x - 2] as number))
      const inside = x === x0 ? x + 12 : x - 12
      if (inside > 1 && inside < width - 1) {
        reference += Math.abs((px[row + inside] as number) - (px[row + inside - 2] as number))
      }
      samples += 1
    }
  }
  for (let x = Math.max(1, x0 + 4); x < Math.min(width - 1, x1 - 4); x += 3) {
    for (const y of [y0, y1]) {
      if (y < 2 || y >= height - 2) continue
      edge += Math.abs((px[y * width + x] as number) - (px[(y - 2) * width + x] as number))
      const inside = y === y0 ? y + 12 : y - 12
      if (inside > 1 && inside < height - 1) {
        reference += Math.abs(
          (px[inside * width + x] as number) - (px[(inside - 2) * width + x] as number),
        )
      }
      samples += 1
    }
  }
  if (samples < 40) return null
  return (edge - reference) / samples
}

/**
 * THE STRETCHES WHERE THE WINDOW ACTUALLY MOVED (#89).
 *
 * A frame of a stationary window cannot say when it was taken: every candidate
 * rectangle near it is the same rectangle, so every hypothesised offset scores
 * the same. Such frames do not merely fail to help — averaged in, they flatten
 * the peak and drag the answer toward zero.
 *
 * Measured, on two consecutive real captures that ran the fit over a whole
 * track without this:
 *
 *   48% of steps moving  ->  77.5 ms
 *   33% of steps moving  ->  37.0 ms
 *
 * against ~127 ms from the same estimator restricted to motion. The answer was
 * tracking the fraction of the track that was standing still.
 *
 * The offline harness never hit this because its observations come from a
 * change-driven timeline: a stationary window simply produces no records, so a
 * pause is a time gap and its segmenter splits there. An annotation's samples
 * are recorded at the ring's cadence whether the window moves or not, so
 * stillness has to be found in the POSITIONS.
 *
 * `pauseMs` is tolerance, not a threshold: a drag has moments of hesitation in
 * it, and cutting at the first still frame would shred one drag into dozens of
 * runs too short to measure.
 */
export function movingRanges(
  samples: ReadonlyArray<{ t_ms: number; x: number; y: number }>,
  options: {
    minTravelPx: number
    pauseMs: number
    stillPx?: number
  },
): Array<{ startMs: number; endMs: number; travelPx: number }> {
  const stillPx = options.stillPx ?? 2
  const out: Array<{ startMs: number; endMs: number; travelPx: number }> = []
  let startMs: number | null = null
  let lastMoveMs: number | null = null
  let travelPx = 0
  const close = (): void => {
    if (startMs !== null && lastMoveMs !== null && travelPx >= options.minTravelPx) {
      out.push({ startMs, endMs: lastMoveMs, travelPx })
    }
    startMs = null
    lastMoveMs = null
    travelPx = 0
  }
  for (let index = 1; index < samples.length; index += 1) {
    const a = samples[index - 1]
    const b = samples[index]
    if (a === undefined || b === undefined) continue
    const step = Math.hypot(b.x - a.x, b.y - a.y)
    if (step > stillPx) {
      if (startMs === null) startMs = a.t_ms
      lastMoveMs = b.t_ms
      travelPx += step
      continue
    }
    if (lastMoveMs !== null && b.t_ms - lastMoveMs > options.pauseMs) close()
  }
  close()
  return out
}
