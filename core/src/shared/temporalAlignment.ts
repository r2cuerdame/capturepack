/**
 * Deterministic replay/context clock comparison.
 *
 * `encodedPtsMs` is the presentation timestamp reported by the saved media
 * file (for example ffprobe's best_effort_timestamp_time, converted to ms).
 * Context samples use the pack/focused replay clock. SPEC §5.6 defines
 * replay_clock_offset_ms as the amount ADDED to pack time to reach one
 * display's replay time, therefore the inverse below is:
 *
 *     pack time = encoded PTS - replay_clock_offset_ms
 *
 * No latency allowance or fixed correction belongs here. A measured +30 ms
 * bias must remain +30 ms in the report instead of being silently erased.
 */

export interface ObservedTemporalSample<T> {
  tMs: number
  value: T
}

export interface TemporalAlignmentMatch {
  /** PTS as reported by the encoded display replay. */
  encodedPtsMs: number
  /** The same frame expressed on the pack/focused clock. */
  packTimeMs: number
  /** Index into the caller's contextSampleTimesMs array. */
  contextSampleIndex: number
  contextSampleTimeMs: number
  /** context sample minus frame; positive means context follows the pixels. */
  signedErrorMs: number
}

export interface TemporalAlignmentDistribution {
  /** Absolute nearest-sample error percentiles, in ms. */
  p50Ms: number
  p95Ms: number
  maxMs: number
  /** Mean signed error; positive means context follows the pixels. */
  signedBiasMs: number
}

export interface TemporalAlignmentReport {
  status: 'measured' | 'no-replay' | 'no-context' | 'invalid'
  frameCount: number
  comparedFrameCount: number
  outsideContextRangeFrameCount: number
  monotonic: boolean
  regressionCount: number
  issues: string[]
  matches: TemporalAlignmentMatch[]
  distribution: TemporalAlignmentDistribution | null
}

export interface TemporalAlignmentInput {
  encodedPtsMs: readonly number[] | null
  /**
   * The resolved, observed display offset. Callers handling a legacy pack must
   * resolve its compatibility fallback before using this measurement helper.
   */
  replayClockOffsetMs: number | undefined
  contextSampleTimesMs: readonly number[]
}

export interface MeasuredPtsSegment {
  /**
   * Epoch-based monotonic origin measured when this recorder generation
   * started. It must come from the same axis as packOriginMs.
   */
  originMs: number
  /** Presentation timestamps local to this recorder generation. */
  ptsMs: readonly number[]
}

export interface MeasuredFrameTimeline {
  packPtsMs: number[]
  monotonic: boolean
  regressionCount: number
  issues: string[]
}

/**
 * Return the nearest recorded sample without copying or interpolating it.
 *
 * Samples must be sorted by tMs. On an exact tie the earlier observation wins,
 * matching ContextBuffer and the persisted Windows-context decoder.
 */
export function nearestObservedSample<T>(
  samples: readonly ObservedTemporalSample<T>[],
  requestedTimeMs: number,
): ObservedTemporalSample<T> | null {
  if (samples.length === 0 || !Number.isFinite(requestedTimeMs)) return null
  let low = 0
  let high = samples.length - 1
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = samples[middle]
    if (candidate === undefined || candidate.tMs < requestedTimeMs) low = middle + 1
    else high = middle
  }
  const after = samples[low]
  if (after === undefined) return null
  const before = low > 0 ? samples[low - 1] : undefined
  if (before === undefined) return after
  return requestedTimeMs - before.tMs <= after.tMs - requestedTimeMs
    ? before
    : after
}

/**
 * Put independently restarted recorder generations on the measured pack axis.
 *
 * Nothing is rebased from a configured rotation duration or the previous
 * segment's final frame. If the measured origins overlap, the returned
 * timeline honestly reports the resulting regression.
 */
export function measuredFrameTimelineAcrossRotations(
  segments: readonly MeasuredPtsSegment[],
  packOriginMs: number,
): MeasuredFrameTimeline {
  const issues: string[] = []
  const packPtsMs: number[] = []
  if (!Number.isFinite(packOriginMs)) {
    return {
      packPtsMs,
      monotonic: false,
      regressionCount: 0,
      issues: ['pack origin is not finite'],
    }
  }

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex]
    if (segment === undefined || !Number.isFinite(segment.originMs)) {
      issues.push(`segment ${segmentIndex} origin is not finite`)
      continue
    }
    for (let ptsIndex = 0; ptsIndex < segment.ptsMs.length; ptsIndex += 1) {
      const ptsMs = segment.ptsMs[ptsIndex]
      if (ptsMs === undefined || !Number.isFinite(ptsMs)) {
        issues.push(`segment ${segmentIndex} PTS ${ptsIndex} is not finite`)
        continue
      }
      packPtsMs.push(segment.originMs + ptsMs - packOriginMs)
    }
  }
  const regressionCount = countRegressions(packPtsMs)
  return {
    packPtsMs,
    monotonic: issues.length === 0 && regressionCount === 0,
    regressionCount,
    issues,
  }
}

/**
 * Compare encoded frames with the nearest context observation on one display.
 *
 * Frames outside the observed context range are counted but excluded from the
 * error distribution: an absent observation is a coverage gap, not clock
 * drift. Invalid or time-regressing input is never massaged into a passing
 * measurement.
 */
export function measureEncodedPtsContextAlignment(
  input: TemporalAlignmentInput,
): TemporalAlignmentReport {
  if (input.encodedPtsMs === null) {
    if (input.replayClockOffsetMs !== undefined) {
      return {
        ...emptyReport('invalid', false),
        issues: ['replay clock offset is declared without a replay'],
      }
    }
    return emptyReport('no-replay', true)
  }

  const issues: string[] = []
  const encodedPtsMs = [...input.encodedPtsMs]
  const contextSampleTimesMs = [...input.contextSampleTimesMs]
  if (encodedPtsMs.length === 0) issues.push('encoded replay contains no frames')
  if (
    input.replayClockOffsetMs === undefined
    || !Number.isFinite(input.replayClockOffsetMs)
  ) {
    issues.push('replay clock offset is not finite')
  }
  for (let index = 0; index < encodedPtsMs.length; index += 1) {
    if (!Number.isFinite(encodedPtsMs[index])) issues.push(`encoded PTS ${index} is not finite`)
  }
  for (let index = 0; index < contextSampleTimesMs.length; index += 1) {
    if (!Number.isFinite(contextSampleTimesMs[index])) {
      issues.push(`context sample ${index} is not finite`)
    }
  }
  const encodedRegressionCount = countRegressions(encodedPtsMs)
  const contextRegressionCount = countRegressions(contextSampleTimesMs)
  if (encodedRegressionCount > 0) {
    issues.push(`encoded PTS regressed ${encodedRegressionCount} time(s)`)
  }
  if (contextRegressionCount > 0) {
    issues.push(`context samples regressed ${contextRegressionCount} time(s)`)
  }
  if (issues.length > 0) {
    return {
      ...emptyReport('invalid', false),
      frameCount: encodedPtsMs.length,
      regressionCount: encodedRegressionCount + contextRegressionCount,
      issues,
    }
  }
  if (contextSampleTimesMs.length === 0) {
    return {
      ...emptyReport('no-context', true),
      frameCount: encodedPtsMs.length,
    }
  }

  const offsetMs = input.replayClockOffsetMs as number
  const firstContextMs = contextSampleTimesMs[0] as number
  const lastContextMs = contextSampleTimesMs[contextSampleTimesMs.length - 1] as number
  const observed = contextSampleTimesMs.map((tMs, index) => ({ tMs, value: index }))
  const matches: TemporalAlignmentMatch[] = []
  let outsideContextRangeFrameCount = 0

  for (const encodedPts of encodedPtsMs) {
    const packTimeMs = encodedPts - offsetMs
    if (packTimeMs < firstContextMs || packTimeMs > lastContextMs) {
      outsideContextRangeFrameCount += 1
      continue
    }
    const nearest = nearestObservedSample(observed, packTimeMs)
    if (nearest === null) {
      outsideContextRangeFrameCount += 1
      continue
    }
    matches.push({
      encodedPtsMs: encodedPts,
      packTimeMs,
      contextSampleIndex: nearest.value,
      contextSampleTimeMs: nearest.tMs,
      signedErrorMs: nearest.tMs - packTimeMs,
    })
  }

  return {
    status: 'measured',
    frameCount: encodedPtsMs.length,
    comparedFrameCount: matches.length,
    outsideContextRangeFrameCount,
    monotonic: true,
    regressionCount: 0,
    issues,
    matches,
    distribution: distributionOf(matches.map((match) => match.signedErrorMs)),
  }
}

function emptyReport(
  status: TemporalAlignmentReport['status'],
  monotonic: boolean,
): TemporalAlignmentReport {
  return {
    status,
    frameCount: 0,
    comparedFrameCount: 0,
    outsideContextRangeFrameCount: 0,
    monotonic,
    regressionCount: 0,
    issues: [],
    matches: [],
    distribution: null,
  }
}

function countRegressions(values: readonly number[]): number {
  let regressions = 0
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1]
    const current = values[index]
    if (
      previous !== undefined
      && current !== undefined
      && Number.isFinite(previous)
      && Number.isFinite(current)
      && current < previous
    ) {
      regressions += 1
    }
  }
  return regressions
}

function distributionOf(errorsMs: readonly number[]): TemporalAlignmentDistribution | null {
  if (errorsMs.length === 0) return null
  const absolute = errorsMs.map((error) => Math.abs(error)).sort((a, b) => a - b)
  const total = errorsMs.reduce((sum, error) => sum + error, 0)
  return {
    p50Ms: nearestRank(absolute, 0.5),
    p95Ms: nearestRank(absolute, 0.95),
    maxMs: absolute[absolute.length - 1] as number,
    signedBiasMs: total / errorsMs.length,
  }
}

function nearestRank(sorted: readonly number[], quantile: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1)
  return sorted[Math.min(index, sorted.length - 1)] as number
}
