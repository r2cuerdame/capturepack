import {
  fingerprintDelta,
  type FrameFingerprint,
} from './replayHealth'

export const SOURCE_LATENCY_FINGERPRINT_WIDTH = 128
export const SOURCE_LATENCY_FINGERPRINT_HEIGHT = 72
export const SOURCE_LATENCY_FINGERPRINT_CHANNELS = 3
export const SOURCE_LATENCY_RETAINED_SAMPLE_LIMIT = 128
export const SOURCE_LATENCY_FINGERPRINT_BYTES =
  SOURCE_LATENCY_FINGERPRINT_WIDTH
  * SOURCE_LATENCY_FINGERPRINT_HEIGHT
  * SOURCE_LATENCY_FINGERPRINT_CHANNELS
export const SOURCE_LATENCY_RETAINED_FINGERPRINT_BYTES =
  SOURCE_LATENCY_FINGERPRINT_BYTES * SOURCE_LATENCY_RETAINED_SAMPLE_LIMIT
export const SOURCE_LATENCY_CALIBRATION_FINGERPRINT_BYTES =
  SOURCE_LATENCY_FINGERPRINT_BYTES
  * (SOURCE_LATENCY_RETAINED_SAMPLE_LIMIT + 1)

const SOURCE_LATENCY_FINGERPRINT_KIND = 'source-latency-rgb-v1'

/**
 * Calibration retains RGB bytes only. Gradients are evaluated when two
 * fingerprints are compared, so 128 decoded frames occupy 3.375 MiB instead
 * of retaining six additional JS-number gradient planes per frame.
 */
export interface SourceLatencyFingerprint extends FrameFingerprint {
  readonly kind: typeof SOURCE_LATENCY_FINGERPRINT_KIND
  readonly width: number
  readonly height: number
  readonly rgb: Uint8Array
  readonly cells: Uint8Array
}

export type SourceLatencySampleSource =
  | 'media-stream-track-processor'
  | 'image-capture'
  | 'video-presentation-callback'
  | 'unknown'

export type SourceLatencyReferenceTiming =
  | 'pixel-exposure'
  | 'post-bitblt-completion'
  | 'unknown'

export interface SourceLatencyCalibrationSample {
  /**
   * Elapsed monotonic time from the native reference capture to this decoded
   * source frame. This is an observation, not an FPS-derived estimate.
   */
  readonly latencyMs: number
  /** Distance from this frame's fingerprint to the native reference. */
  readonly delta: number
  /** Needed to prove that content moved through (and away from) the match. */
  readonly fingerprint?: FrameFingerprint
}

export interface SourceLatencyCalibrationOptions {
  /**
   * The caller's actually observed calibration interval. Samples outside it
   * are ineligible, so a stale sink cannot win outside the bounded probe.
   */
  readonly candidateRangeMs: {
    readonly min: number
    readonly max: number
  }
  /**
   * Only processor frames are decoded source frames. ImageCapture and
   * requestVideoFrameCallback can be delayed by their own presentation sink
   * and therefore remain diagnostic-only.
   */
  readonly sampleSource: SourceLatencySampleSource
  /**
   * Provenance of the independent reference timestamp. Operation completion
   * (including GDI BitBlt completion) is not a pixel exposure timestamp: the
   * copied DWM surface may already be stale by an unobserved amount.
   */
  readonly referenceTiming: SourceLatencyReferenceTiming
  readonly minimumSamples?: number
  readonly minimumMotionDelta?: number
  readonly minimumMotionTransitions?: number
  readonly maximumTroughFraction?: number
  readonly minimumConfidence?: number
}

export type SourceLatencyCalibrationReason =
  | 'measured'
  | 'cancelled'
  | 'probe-failed'
  | 'invalid-candidate-range'
  | 'no-finite-samples'
  | 'insufficient-samples'
  | 'unsupported-sample-source'
  | 'unsupported-reference-timing'
  | 'no-motion-witness'
  | 'insufficient-motion-transitions'
  | 'no-distinct-match'
  | 'competing-match-clusters'
  | 'unbracketed-match'
  | 'match-before-reference'
  | 'incoherent-match-cluster'
  | 'flat-match-trough'
  | 'weak-match-contrast'
  | 'low-confidence'

export interface SourceLatencyCalibrationDecision {
  readonly status: 'measured' | 'ambiguous' | 'unavailable'
  readonly reason: SourceLatencyCalibrationReason
  readonly sampleSource: SourceLatencySampleSource
  readonly sampleCount: number
  readonly latencyMs?: number
  readonly confidence?: number
  readonly bestDelta?: number
  readonly observedChange?: number
  readonly motionTransitions?: number
  readonly candidates?: readonly {
    readonly latencyMs: number
    readonly delta: number
  }[]
}

interface IndexedSample {
  readonly sample: SourceLatencyCalibrationSample
  readonly inputIndex: number
}

interface MatchCluster {
  readonly start: number
  readonly end: number
  readonly minimumDelta: number
}

// Five decoded frames are the smallest sequence that can bracket one match
// with two witnessed transitions. At 5 fps this keeps the calibration probe
// near one second without weakening the shape requirements below.
const DEFAULT_MINIMUM_SAMPLES = 5
const DEFAULT_MINIMUM_MOTION_DELTA = 2
const DEFAULT_MINIMUM_MOTION_TRANSITIONS = 2
const DEFAULT_MAXIMUM_TROUGH_FRACTION = 0.45
const DEFAULT_MINIMUM_CONFIDENCE = 0.65
// Native references cross a JPEG boundary while processor frames do not.
// Ignore a few levels of component/ringing noise before accumulating RMS
// energy. A real moving UI edge is orders of magnitude larger.
const SOURCE_LATENCY_RGB_NOISE_FLOOR = 2
const SOURCE_LATENCY_GRADIENT_NOISE_FLOOR = 4
const SOURCE_LATENCY_GRADIENT_WEIGHT = 2

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((left, right) => left - right)
  const position = clamp(quantile, 0, 1) * (sorted.length - 1)
  const lowerIndex = Math.floor(position)
  const upperIndex = Math.ceil(position)
  const lower = sorted[lowerIndex]
  const upper = sorted[upperIndex]
  if (lower === undefined || upper === undefined) return Number.NaN
  if (lowerIndex === upperIndex) return lower
  return lower + (upper - lower) * (position - lowerIndex)
}

function median(values: readonly number[]): number {
  return percentile(values, 0.5)
}

/**
 * Builds the calibration-only fingerprint from a raster no larger than the
 * 128x72 calibration canvas.
 *
 * Only row-major RGB bytes are retained. Signed horizontal and vertical RGB
 * gradients are derived on demand by sourceLatencyFingerprintDelta. This is
 * deliberately separate from the cheap 8x8 luma replay-health fingerprint.
 */
export function buildSourceLatencyFingerprint(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): SourceLatencyFingerprint {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > SOURCE_LATENCY_FINGERPRINT_WIDTH ||
    height > SOURCE_LATENCY_FINGERPRINT_HEIGHT ||
    rgba.length < width * height * 4
  ) {
    throw new Error('invalid source latency frame pixels')
  }
  const rgb = new Uint8Array(
    width * height * SOURCE_LATENCY_FINGERPRINT_CHANNELS,
  )
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      const rgbOffset =
        (y * width + x) * SOURCE_LATENCY_FINGERPRINT_CHANNELS
      const red = rgba[offset] ?? 0
      const green = rgba[offset + 1] ?? 0
      const blue = rgba[offset + 2] ?? 0
      rgb[rgbOffset] = red
      rgb[rgbOffset + 1] = green
      rgb[rgbOffset + 2] = blue
    }
  }
  return buildSourceLatencyFingerprintFromRgb(rgb, width, height)
}

/**
 * Constructs the matcher fingerprint directly from the DXGI helper's exact
 * row-major RGB bytes. There is no canvas, color conversion, or JPEG boundary.
 */
export function buildSourceLatencyFingerprintFromRgb(
  sourceRgb: Uint8Array,
  width: number,
  height: number,
): SourceLatencyFingerprint {
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width <= 0
    || height <= 0
    || width > SOURCE_LATENCY_FINGERPRINT_WIDTH
    || height > SOURCE_LATENCY_FINGERPRINT_HEIGHT
    || sourceRgb.length
      !== width * height * SOURCE_LATENCY_FINGERPRINT_CHANNELS
  ) {
    throw new Error('invalid source latency RGB pixels')
  }
  const pixels = width * height
  const rgb = Uint8Array.from(sourceRgb)
  let lumaSum = 0
  let dark = 0
  for (let offset = 0; offset < rgb.length; offset += 3) {
    const red = rgb[offset] ?? 0
    const green = rgb[offset + 1] ?? 0
    const blue = rgb[offset + 2] ?? 0
    const luma = (54 * red + 183 * green + 19 * blue) >> 8
    lumaSum += luma
    if (luma < 16) dark += 1
  }
  return {
    kind: SOURCE_LATENCY_FINGERPRINT_KIND,
    width,
    height,
    meanLuma: lumaSum / pixels,
    darkRatio: dark / pixels,
    rgb,
    cells: rgb,
  }
}

export interface DxgiTimingEpochInput {
  readonly lastPresentQpc: string
  readonly qpcFrequency: string
  readonly anchor: {
    readonly qpc: string
    readonly unixNs: string
    readonly spanQpc: string
  }
}

export interface DxgiTimingEpochMapping {
  readonly presentedAtMs: number
  readonly presentedAtUnixNs: string
  readonly anchorSpanQpc: string
  readonly anchorSpanMs: number
  readonly anchorUncertaintyMs: number
}

function decimalBigInt(value: string, field: string, allowZero = false): bigint {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error(`invalid DXGI ${field}`)
  }
  const parsed = BigInt(value)
  if (allowZero ? parsed < 0n : parsed <= 0n) {
    throw new Error(`invalid DXGI ${field}`)
  }
  return parsed
}

function unixNsToEpochMs(unixNs: bigint): number {
  const wholeMs = unixNs / 1_000_000n
  const fractionMs = Number(unixNs % 1_000_000n) / 1_000_000
  const result = Number(wholeMs) + fractionMs
  if (!Number.isFinite(result)) throw new Error('invalid DXGI epoch')
  return result
}

/**
 * Maps DXGI LastPresentTime through the helper's bracketed QPC/Unix anchor
 * without converting the large clock integers through IEEE-754 first.
 */
export function mapDxgiTimingReferenceEpoch(
  reference: DxgiTimingEpochInput,
): DxgiTimingEpochMapping {
  const lastPresentQpc = decimalBigInt(
    reference.lastPresentQpc,
    'LastPresentTime',
  )
  const qpcFrequency = decimalBigInt(
    reference.qpcFrequency,
    'QPC frequency',
  )
  const anchorQpc = decimalBigInt(reference.anchor.qpc, 'anchor QPC')
  const anchorUnixNs = decimalBigInt(
    reference.anchor.unixNs,
    'anchor Unix time',
  )
  const anchorSpanQpc = decimalBigInt(
    reference.anchor.spanQpc,
    'anchor span',
    true,
  )
  const presentedAtUnixNs =
    anchorUnixNs
    + ((lastPresentQpc - anchorQpc) * 1_000_000_000n) / qpcFrequency
  const anchorSpanNs =
    (anchorSpanQpc * 1_000_000_000n) / qpcFrequency
  const uncertaintyNs =
    (anchorSpanQpc * 500_000_000n) / qpcFrequency
  return {
    presentedAtMs: unixNsToEpochMs(presentedAtUnixNs),
    presentedAtUnixNs: presentedAtUnixNs.toString(10),
    anchorSpanQpc: anchorSpanQpc.toString(10),
    anchorSpanMs: unixNsToEpochMs(anchorSpanNs),
    anchorUncertaintyMs: unixNsToEpochMs(uncertaintyNs),
  }
}

function isSourceLatencyFingerprint(
  fingerprint: FrameFingerprint,
): fingerprint is SourceLatencyFingerprint {
  const candidate = fingerprint as Partial<SourceLatencyFingerprint>
  return candidate.kind === SOURCE_LATENCY_FINGERPRINT_KIND
    && Number.isSafeInteger(candidate.width)
    && Number.isSafeInteger(candidate.height)
    && (candidate.width ?? 0) > 0
    && (candidate.height ?? 0) > 0
    && candidate.rgb instanceof Uint8Array
    && candidate.cells === candidate.rgb
    && candidate.rgb.length
      === (candidate.width ?? 0)
        * (candidate.height ?? 0)
        * SOURCE_LATENCY_FINGERPRINT_CHANNELS
}

function squaredDifferenceAboveNoise(
  left: number,
  right: number,
  noiseFloor: number,
): number {
  const difference = Math.max(0, Math.abs(left - right) - noiseFloor)
  return difference * difference
}

/**
 * One metric for native↔processor matches and processor↔processor motion.
 *
 * RMS retains energy from a small moving object instead of diluting it into a
 * mostly static desktop. Horizontal and vertical signed-gradient differences
 * are calculated directly from compact RGB bytes; no gradient arrays survive
 * this call.
 */
export function sourceLatencyFingerprintDelta(
  left: FrameFingerprint,
  right: FrameFingerprint,
): number {
  const leftIsSourceLatency = isSourceLatencyFingerprint(left)
  const rightIsSourceLatency = isSourceLatencyFingerprint(right)
  if (!leftIsSourceLatency && !rightIsSourceLatency) {
    return fingerprintDelta(left, right)
  }
  if (!leftIsSourceLatency || !rightIsSourceLatency) {
    return Number.POSITIVE_INFINITY
  }
  if (left.width !== right.width || left.height !== right.height) {
    return Number.POSITIVE_INFINITY
  }

  let squaredDifference = 0
  let totalWeight = 0
  for (let y = 0; y < left.height; y += 1) {
    for (let x = 0; x < left.width; x += 1) {
      const offset =
        (y * left.width + x) * SOURCE_LATENCY_FINGERPRINT_CHANNELS
      for (
        let channel = 0;
        channel < SOURCE_LATENCY_FINGERPRINT_CHANNELS;
        channel += 1
      ) {
        const cell = offset + channel
        squaredDifference += squaredDifferenceAboveNoise(
          left.rgb[cell] ?? 0,
          right.rgb[cell] ?? 0,
          SOURCE_LATENCY_RGB_NOISE_FLOOR,
        )
        totalWeight += 1

        if (x > 0) {
          const previous = cell - SOURCE_LATENCY_FINGERPRINT_CHANNELS
          squaredDifference += SOURCE_LATENCY_GRADIENT_WEIGHT
            * squaredDifferenceAboveNoise(
              (left.rgb[cell] ?? 0) - (left.rgb[previous] ?? 0),
              (right.rgb[cell] ?? 0) - (right.rgb[previous] ?? 0),
              SOURCE_LATENCY_GRADIENT_NOISE_FLOOR,
            )
          totalWeight += SOURCE_LATENCY_GRADIENT_WEIGHT
        }
        if (y > 0) {
          const above =
            cell
            - left.width * SOURCE_LATENCY_FINGERPRINT_CHANNELS
          squaredDifference += SOURCE_LATENCY_GRADIENT_WEIGHT
            * squaredDifferenceAboveNoise(
              (left.rgb[cell] ?? 0) - (left.rgb[above] ?? 0),
              (right.rgb[cell] ?? 0) - (right.rgb[above] ?? 0),
              SOURCE_LATENCY_GRADIENT_NOISE_FLOOR,
            )
          totalWeight += SOURCE_LATENCY_GRADIENT_WEIGHT
        }
      }
    }
  }
  return totalWeight === 0
    ? Number.POSITIVE_INFINITY
    : Math.sqrt(squaredDifference / totalWeight)
}

function finiteSamplesInRange(
  samples: readonly SourceLatencyCalibrationSample[],
  min: number,
  max: number,
): IndexedSample[] {
  return samples
    .map((sample, inputIndex) => ({ sample, inputIndex }))
    .filter(({ sample }) =>
      Number.isFinite(sample.latencyMs)
      && Number.isFinite(sample.delta)
      && sample.latencyMs >= min
      && sample.latencyMs <= max,
    )
    .sort((left, right) =>
      left.sample.latencyMs - right.sample.latencyMs
      || left.inputIndex - right.inputIndex,
    )
}

function matchClusters(
  samples: readonly IndexedSample[],
  threshold: number,
): MatchCluster[] {
  const clusters: MatchCluster[] = []
  let start: number | null = null
  let minimumDelta = Number.POSITIVE_INFINITY
  for (let index = 0; index < samples.length; index += 1) {
    const delta = samples[index]?.sample.delta
    if (delta !== undefined && delta <= threshold) {
      if (start === null) {
        start = index
        minimumDelta = delta
      } else {
        minimumDelta = Math.min(minimumDelta, delta)
      }
      continue
    }
    if (start !== null) {
      clusters.push({ start, end: index - 1, minimumDelta })
      start = null
      minimumDelta = Number.POSITIVE_INFINITY
    }
  }
  if (start !== null) {
    clusters.push({ start, end: samples.length - 1, minimumDelta })
  }
  return clusters
}

function baseDecision(
  status: SourceLatencyCalibrationDecision['status'],
  reason: SourceLatencyCalibrationReason,
  sampleSource: SourceLatencySampleSource,
  samples: readonly IndexedSample[],
  extra: Partial<SourceLatencyCalibrationDecision> = {},
): SourceLatencyCalibrationDecision {
  const ranked = [...samples]
    .sort((left, right) => left.sample.delta - right.sample.delta)
    .slice(0, 8)
    .map(({ sample }) => ({ latencyMs: sample.latencyMs, delta: sample.delta }))
  return {
    status,
    reason,
    sampleSource,
    sampleCount: samples.length,
    ...(ranked.length === 0
      ? {}
      : {
          bestDelta: ranked[0]?.delta,
          candidates: ranked,
        }),
    ...extra,
  }
}

/**
 * Selects a source-latency observation only when the decoded frame sequence
 * proves a single, bounded passage through the native reference.
 *
 * The function deliberately has no FPS input and applies no frame-count or
 * millisecond correction. If the sequence cannot locate the match by itself,
 * the result remains ambiguous.
 */
export function decideSourceLatencyCalibration(
  inputSamples: readonly SourceLatencyCalibrationSample[],
  options: SourceLatencyCalibrationOptions,
): SourceLatencyCalibrationDecision {
  const min = options.candidateRangeMs.min
  const max = options.candidateRangeMs.max
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return baseDecision(
      'unavailable',
      'invalid-candidate-range',
      options.sampleSource,
      [],
    )
  }

  const samples = finiteSamplesInRange(inputSamples, min, max)
  if (samples.length === 0) {
    return baseDecision(
      'unavailable',
      'no-finite-samples',
      options.sampleSource,
      samples,
    )
  }
  if (options.sampleSource !== 'media-stream-track-processor') {
    return baseDecision(
      'ambiguous',
      'unsupported-sample-source',
      options.sampleSource,
      samples,
    )
  }
  if (options.referenceTiming !== 'pixel-exposure') {
    return baseDecision(
      'ambiguous',
      'unsupported-reference-timing',
      options.sampleSource,
      samples,
    )
  }

  const minimumSamples = options.minimumSamples ?? DEFAULT_MINIMUM_SAMPLES
  if (samples.length < minimumSamples) {
    return baseDecision(
      'ambiguous',
      'insufficient-samples',
      options.sampleSource,
      samples,
    )
  }

  const transitionDeltas: number[] = []
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]?.sample.fingerprint
    const current = samples[index]?.sample.fingerprint
    if (previous === undefined || current === undefined) continue
    const delta = sourceLatencyFingerprintDelta(previous, current)
    if (Number.isFinite(delta)) transitionDeltas.push(delta)
  }
  const observedChange = transitionDeltas.length === 0
    ? 0
    : Math.max(...transitionDeltas)
  const minimumMotionDelta =
    options.minimumMotionDelta ?? DEFAULT_MINIMUM_MOTION_DELTA
  const motionTransitions = transitionDeltas.filter(
    (delta) => delta >= minimumMotionDelta,
  )
  const motionExtra = { observedChange, motionTransitions: motionTransitions.length }
  if (observedChange < minimumMotionDelta) {
    return baseDecision(
      'ambiguous',
      'no-motion-witness',
      options.sampleSource,
      samples,
      motionExtra,
    )
  }
  const minimumMotionTransitions =
    options.minimumMotionTransitions ?? DEFAULT_MINIMUM_MOTION_TRANSITIONS
  if (motionTransitions.length < minimumMotionTransitions) {
    return baseDecision(
      'ambiguous',
      'insufficient-motion-transitions',
      options.sampleSource,
      samples,
      motionExtra,
    )
  }

  const deltas = samples.map(({ sample }) => sample.delta)
  const bestDelta = Math.min(...deltas)
  const upperDelta = percentile(deltas, 0.9)
  const motionScale = percentile(motionTransitions, 0.75)
  const totalContrast = upperDelta - bestDelta
  const minimumDistinctContrast = Math.max(0.75, motionScale * 0.15)
  if (
    !Number.isFinite(totalContrast)
    || !Number.isFinite(motionScale)
    || totalContrast < minimumDistinctContrast
  ) {
    return baseDecision(
      'ambiguous',
      'no-distinct-match',
      options.sampleSource,
      samples,
      motionExtra,
    )
  }

  const nearMinimumMargin = Math.max(
    0.75,
    Math.min(motionScale * 0.22, totalContrast * 0.25),
  )
  const clusters = matchClusters(samples, bestDelta + nearMinimumMargin)
  const winningClusters = clusters.filter(
    (cluster) => cluster.minimumDelta <= bestDelta + nearMinimumMargin * 0.5,
  )
  if (winningClusters.length !== 1) {
    return baseDecision(
      'ambiguous',
      'competing-match-clusters',
      options.sampleSource,
      samples,
      motionExtra,
    )
  }
  const winner = winningClusters[0]
  if (winner === undefined) {
    return baseDecision(
      'ambiguous',
      'no-distinct-match',
      options.sampleSource,
      samples,
      motionExtra,
    )
  }
  if (winner.start === 0 || winner.end === samples.length - 1) {
    return baseDecision(
      'ambiguous',
      'unbracketed-match',
      options.sampleSource,
      samples,
      motionExtra,
    )
  }

  const spacings: number[] = []
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]?.sample.latencyMs
    const current = samples[index]?.sample.latencyMs
    if (previous === undefined || current === undefined) continue
    const spacing = current - previous
    if (spacing > 0 && Number.isFinite(spacing)) spacings.push(spacing)
  }
  const typicalSpacing = median(spacings)
  const winnerSamples = samples.slice(winner.start, winner.end + 1)
  const winnerSpacings: number[] = []
  for (let index = 1; index < winnerSamples.length; index += 1) {
    const previous = winnerSamples[index - 1]?.sample.latencyMs
    const current = winnerSamples[index]?.sample.latencyMs
    if (previous !== undefined && current !== undefined) {
      winnerSpacings.push(current - previous)
    }
  }
  if (
    !Number.isFinite(typicalSpacing)
    || winnerSpacings.some((spacing) => spacing > typicalSpacing * 3)
  ) {
    return baseDecision(
      'ambiguous',
      'incoherent-match-cluster',
      options.sampleSource,
      samples,
      motionExtra,
    )
  }

  const firstLatency = samples[0]?.sample.latencyMs
  const lastLatency = samples[samples.length - 1]?.sample.latencyMs
  const winnerFirstLatency = winnerSamples[0]?.sample.latencyMs
  const winnerLastLatency = winnerSamples[winnerSamples.length - 1]?.sample.latencyMs
  if (
    firstLatency === undefined
    || lastLatency === undefined
    || winnerFirstLatency === undefined
    || winnerLastLatency === undefined
  ) {
    return baseDecision(
      'ambiguous',
      'incoherent-match-cluster',
      options.sampleSource,
      samples,
      motionExtra,
    )
  }
  const observedSpan = lastLatency - firstLatency
  const effectiveTroughSpan =
    winnerLastLatency - winnerFirstLatency + typicalSpacing
  const effectiveObservedSpan = observedSpan + typicalSpacing
  const troughFraction = effectiveObservedSpan <= 0
    ? 1
    : effectiveTroughSpan / effectiveObservedSpan
  const maximumTroughFraction =
    options.maximumTroughFraction ?? DEFAULT_MAXIMUM_TROUGH_FRACTION
  if (troughFraction > maximumTroughFraction) {
    return baseDecision(
      'ambiguous',
      'flat-match-trough',
      options.sampleSource,
      samples,
      motionExtra,
    )
  }

  const shoulderWindow = 2
  const leftShoulder = samples
    .slice(Math.max(0, winner.start - shoulderWindow), winner.start)
    .map(({ sample }) => sample.delta)
  const rightShoulder = samples
    .slice(winner.end + 1, winner.end + 1 + shoulderWindow)
    .map(({ sample }) => sample.delta)
  const winnerDeltas = winnerSamples.map(({ sample }) => sample.delta)
  const troughMedian = median(winnerDeltas)
  const shoulderDelta = Math.min(median(leftShoulder), median(rightShoulder))
  const shoulderContrast = shoulderDelta - troughMedian
  // DXGI and Chromium traverse different colour/conversion paths, so their
  // absolute cross-source trough depth is not on the same scale as adjacent
  // processor-to-processor motion. The full distribution already proved a
  // distinct, bracketed, non-repeating trough above; compare its shoulders to
  // that same cross-source distribution instead of demanding a fraction of an
  // unrelated within-source motion amplitude.
  const requiredShoulderContrast = Math.max(0.75, totalContrast * 0.15)
  if (
    !Number.isFinite(shoulderContrast)
    || shoulderContrast < requiredShoulderContrast
  ) {
    return baseDecision(
      'ambiguous',
      'weak-match-contrast',
      options.sampleSource,
      samples,
      motionExtra,
    )
  }

  const contrastScore = clamp(
    shoulderContrast / (requiredShoulderContrast * 2),
    0,
    1,
  )
  const shapeScore = clamp(
    1 - troughFraction / maximumTroughFraction,
    0,
    1,
  )
  const motionScore = clamp(
    motionTransitions.length / (minimumMotionTransitions * 2),
    0,
    1,
  )
  const sampleScore = clamp(samples.length / 10, 0, 1)
  const confidence =
    contrastScore * 0.45
    + shapeScore * 0.2
    + motionScore * 0.25
    + sampleScore * 0.1
  const minimumConfidence =
    options.minimumConfidence ?? DEFAULT_MINIMUM_CONFIDENCE
  if (confidence < minimumConfidence) {
    return baseDecision(
      'ambiguous',
      'low-confidence',
      options.sampleSource,
      samples,
      { ...motionExtra, confidence },
    )
  }

  // A desktop update may remain unchanged across several delivered frames.
  // Their pixels are all valid matches, but averaging their timestamps moves
  // the update into a frame that never introduced it. The measured latency is
  // the first non-negative decoded frame that actually contains the acquired
  // DXGI resource. This is a discrete observed boundary, not interpolation.
  const firstObservedMatch = winnerSamples.find(
    ({ sample }) => sample.latencyMs >= 0,
  )
  if (firstObservedMatch === undefined) {
    return baseDecision(
      'ambiguous',
      'match-before-reference',
      options.sampleSource,
      samples,
      motionExtra,
    )
  }
  const latencyMs = firstObservedMatch.sample.latencyMs
  return baseDecision(
    'measured',
    'measured',
    options.sampleSource,
    samples,
    {
      ...motionExtra,
      latencyMs,
      confidence,
      bestDelta,
      candidates: winnerSamples.map(({ sample }) => ({
        latencyMs: sample.latencyMs,
        delta: sample.delta,
      })),
    },
  )
}

export interface SourcePresentationSample {
  readonly presentedAtMs: number
  /** The rVFC media clock from the same sink epoch, when the runtime reports it. */
  readonly mediaTimeMs?: number
  readonly fingerprint: FrameFingerprint
}

export interface ProcessorPresentationSample {
  readonly processorAtMs: number
  readonly fingerprint: FrameFingerprint
}

export interface ProcessorPresentationMatch {
  readonly processorIndex: number
  readonly presentedIndex: number
  readonly processorAtMs: number
  readonly presentedAtMs: number
  readonly latencyMs: number
  readonly delta: number
}

export type ProcessorPresentationLatencyDecision =
  | {
      readonly status: 'measured'
      readonly reason: 'measured'
      readonly latencyMs: number
      readonly matchedPairCount: number
      readonly dispersionMs: number
      readonly observedProcessorSpacingMs: number
      readonly matches: readonly ProcessorPresentationMatch[]
    }
  | {
      readonly status: 'ambiguous' | 'unavailable'
      readonly reason:
        | 'insufficient-samples'
        | 'non-monotonic-processor-clock'
        | 'non-monotonic-presentation-clock'
        | 'fingerprint-shape-mismatch'
        | 'non-unique-pixel-match'
        | 'insufficient-matches'
        | 'non-monotonic-match-order'
        | 'invalid-latency'
        | 'excessive-offset-dispersion'
      readonly matchedPairCount: number
      readonly dispersionMs?: number
      readonly observedProcessorSpacingMs?: number
      readonly matches: readonly ProcessorPresentationMatch[]
    }

export type SourcePresentationLatencyDecision =
  | {
      readonly status: 'measured'
      readonly reason: 'measured'
      readonly latencyMs: number
      readonly bestDelta: number
      readonly contrast: number
      readonly sampleCount: number
      /** The exact matching rVFC media-clock observation, when available. */
      readonly matchedMediaTimeMs?: number
      /**
       * Source-wall origin measured from the same pixel:
       * `DXGI exposure wall time - rVFC mediaTime`.
       */
      readonly sourceMediaTimeOriginMs?: number
    }
  | {
      readonly status: 'ambiguous' | 'unavailable'
      readonly reason:
        | 'invalid-reference'
        | 'insufficient-samples'
        | 'no-bounded-samples'
        | 'non-monotonic-samples'
        | 'fingerprint-shape-mismatch'
        | 'weak-pixel-match'
        | 'unbracketed-match'
        | 'invalid-latency'
      readonly sampleCount: number
      readonly bestDelta?: number
      readonly contrast?: number
    }

const PRESENTATION_MINIMUM_SAMPLES = 3
const PRESENTATION_MAXIMUM_MATCH_DELTA = 24
const PRESENTATION_MINIMUM_MATCH_CONTRAST = 4
const PRESENTATION_WITNESS_WINDOW_MS = 2_000

function fingerprintsHaveSameShape(
  left: FrameFingerprint,
  right: FrameFingerprint,
): boolean {
  const leftIsSourceLatency = isSourceLatencyFingerprint(left)
  const rightIsSourceLatency = isSourceLatencyFingerprint(right)
  if (leftIsSourceLatency || rightIsSourceLatency) {
    return leftIsSourceLatency
      && rightIsSourceLatency
      && left.width === right.width
      && left.height === right.height
  }
  return left.cells.length > 0 && left.cells.length === right.cells.length
}

function strictlyIncreasing<T>(
  samples: readonly T[],
  timestampOf: (sample: T) => number,
): boolean {
  for (let index = 0; index < samples.length; index += 1) {
    const timestamp = timestampOf(samples[index] as T)
    if (!Number.isFinite(timestamp)) return false
    if (
      index > 0
      && timestamp <= timestampOf(samples[index - 1] as T)
    ) {
      return false
    }
  }
  return true
}

interface RankedPixelMatch {
  readonly index: number
  readonly delta: number
}

function uniquePixelMatch(
  distances: readonly number[],
): RankedPixelMatch | null {
  const ranked = distances
    .map((delta, index) => ({ index, delta }))
    .filter(({ delta }) => Number.isFinite(delta))
    .sort((left, right) => left.delta - right.delta || left.index - right.index)
  const best = ranked[0]
  const second = ranked[1]
  if (
    best === undefined
    || second === undefined
    || best.delta > PRESENTATION_MAXIMUM_MATCH_DELTA
    || second.delta - best.delta < PRESENTATION_MINIMUM_MATCH_CONTRAST
  ) {
    return null
  }
  return best
}

/**
 * Measures the processor -> rVFC delivery leg by joining identical observed
 * pixels. Every accepted pair is a mutual, unique nearest neighbour; neither
 * configured FPS nor a nominal frame interval participates in the result.
 */
export function decideProcessorPresentationLatency(
  processorSamples: readonly ProcessorPresentationSample[],
  presentedSamples: readonly SourcePresentationSample[],
): ProcessorPresentationLatencyDecision {
  const empty = {
    matchedPairCount: 0,
    matches: [] as readonly ProcessorPresentationMatch[],
  }
  if (
    processorSamples.length < PRESENTATION_MINIMUM_SAMPLES
    || presentedSamples.length < PRESENTATION_MINIMUM_SAMPLES
  ) {
    return {
      status: 'ambiguous',
      reason: 'insufficient-samples',
      ...empty,
    }
  }
  if (!strictlyIncreasing(processorSamples, (sample) => sample.processorAtMs)) {
    return {
      status: 'ambiguous',
      reason: 'non-monotonic-processor-clock',
      ...empty,
    }
  }
  if (!strictlyIncreasing(presentedSamples, (sample) => sample.presentedAtMs)) {
    return {
      status: 'ambiguous',
      reason: 'non-monotonic-presentation-clock',
      ...empty,
    }
  }

  const shapeReference = processorSamples[0]?.fingerprint
  if (
    shapeReference === undefined
    || processorSamples.some(
      ({ fingerprint }) =>
        !fingerprintsHaveSameShape(shapeReference, fingerprint),
    )
    || presentedSamples.some(
      ({ fingerprint }) =>
        !fingerprintsHaveSameShape(shapeReference, fingerprint),
    )
  ) {
    return {
      status: 'ambiguous',
      reason: 'fingerprint-shape-mismatch',
      ...empty,
    }
  }

  const matrix = presentedSamples.map(({ fingerprint: presented }) =>
    processorSamples.map(({ fingerprint: processor }) =>
      sourceLatencyFingerprintDelta(processor, presented),
    ),
  )
  const presentedBest = matrix.map((distances) => uniquePixelMatch(distances))
  const processorBest = processorSamples.map((_sample, processorIndex) =>
    uniquePixelMatch(
      matrix.map((distances) =>
        distances[processorIndex] ?? Number.POSITIVE_INFINITY,
      ),
    ),
  )
  const sawNonUniqueCandidate =
    matrix.some((distances) => {
      const ranked = [...distances]
        .filter((delta) => Number.isFinite(delta))
        .sort((left, right) => left - right)
      return (
        (ranked[0] ?? Number.POSITIVE_INFINITY)
          <= PRESENTATION_MAXIMUM_MATCH_DELTA
        && (ranked[1] ?? Number.POSITIVE_INFINITY) - (ranked[0] ?? 0)
          < PRESENTATION_MINIMUM_MATCH_CONTRAST
      )
    })
    || processorSamples.some((_sample, processorIndex) => {
      const ranked = matrix
        .map((distances) =>
          distances[processorIndex] ?? Number.POSITIVE_INFINITY,
        )
        .filter((delta) => Number.isFinite(delta))
        .sort((left, right) => left - right)
      return (
        (ranked[0] ?? Number.POSITIVE_INFINITY)
          <= PRESENTATION_MAXIMUM_MATCH_DELTA
        && (ranked[1] ?? Number.POSITIVE_INFINITY) - (ranked[0] ?? 0)
          < PRESENTATION_MINIMUM_MATCH_CONTRAST
      )
    })

  const matches: ProcessorPresentationMatch[] = []
  for (
    let presentedIndex = 0;
    presentedIndex < presentedBest.length;
    presentedIndex += 1
  ) {
    const forward = presentedBest[presentedIndex]
    if (forward === null || forward === undefined) continue
    const reverse = processorBest[forward.index]
    if (reverse === null || reverse?.index !== presentedIndex) continue
    const processor = processorSamples[forward.index]
    const presented = presentedSamples[presentedIndex]
    if (processor === undefined || presented === undefined) continue
    matches.push({
      processorIndex: forward.index,
      presentedIndex,
      processorAtMs: processor.processorAtMs,
      presentedAtMs: presented.presentedAtMs,
      latencyMs: presented.presentedAtMs - processor.processorAtMs,
      delta: forward.delta,
    })
  }

  if (matches.length < PRESENTATION_MINIMUM_SAMPLES) {
    return {
      status: 'ambiguous',
      reason: sawNonUniqueCandidate
        ? 'non-unique-pixel-match'
        : 'insufficient-matches',
      matchedPairCount: matches.length,
      matches,
    }
  }
  for (let index = 1; index < matches.length; index += 1) {
    const previous = matches[index - 1]
    const current = matches[index]
    if (
      previous === undefined
      || current === undefined
      || current.presentedIndex <= previous.presentedIndex
      || current.processorIndex <= previous.processorIndex
    ) {
      return {
        status: 'ambiguous',
        reason: 'non-monotonic-match-order',
        matchedPairCount: matches.length,
        matches,
      }
    }
  }

  const offsets = matches.map(({ latencyMs }) => latencyMs)
  if (offsets.some((offset) => !Number.isFinite(offset) || offset < 0)) {
    return {
      status: 'unavailable',
      reason: 'invalid-latency',
      matchedPairCount: matches.length,
      matches,
    }
  }
  const processorSpacings = processorSamples
    .slice(1)
    .map(
      (sample, index) =>
        sample.processorAtMs
        - (processorSamples[index]?.processorAtMs ?? sample.processorAtMs),
    )
  const observedProcessorSpacingMs = median(processorSpacings)
  const dispersionMs = Math.max(...offsets) - Math.min(...offsets)
  const comparisonEpsilon =
    Number.EPSILON
    * Math.max(1, Math.abs(observedProcessorSpacingMs), Math.abs(dispersionMs))
    * 8
  if (
    !Number.isFinite(observedProcessorSpacingMs)
    || observedProcessorSpacingMs <= 0
    || dispersionMs > observedProcessorSpacingMs + comparisonEpsilon
  ) {
    return {
      status: 'ambiguous',
      reason: 'excessive-offset-dispersion',
      matchedPairCount: matches.length,
      dispersionMs,
      observedProcessorSpacingMs,
      matches,
    }
  }

  return {
    status: 'measured',
    reason: 'measured',
    latencyMs: median(offsets),
    matchedPairCount: matches.length,
    dispersionMs,
    observedProcessorSpacingMs,
    matches,
  }
}

/**
 * Join an independent DXGI pixel-exposure reference to the startup rVFC sink.
 * No FPS or configured delay participates: a unique decoded-pixel match is the
 * only path that measures the missing source-exposure -> presentation leg.
 */
export function decideSourcePresentationLatency(
  referenceAtMs: number,
  reference: FrameFingerprint,
  samples: readonly SourcePresentationSample[],
): SourcePresentationLatencyDecision {
  if (!Number.isFinite(referenceAtMs)) {
    return {
      status: 'unavailable',
      reason: 'invalid-reference',
      sampleCount: 0,
    }
  }
  if (!strictlyIncreasing(samples, (sample) => sample.presentedAtMs)) {
    return {
      status: 'ambiguous',
      reason: 'non-monotonic-samples',
      sampleCount: samples.length,
    }
  }
  // Sparse hidden-video sinks can present roughly once a second before the
  // recorder starts. Frames immediately before the native reference and just
  // beyond the maximum latency we are willing to claim are still valuable
  // motion witnesses: they bracket the uniquely matching frame without
  // changing that frame's measured latency. Only the winning frame is allowed
  // to establish a non-negative, <= 1 second source latency below.
  const bounded = samples.filter((sample) => {
    const latencyMs = sample.presentedAtMs - referenceAtMs
    return (
      Number.isFinite(sample.presentedAtMs)
      && latencyMs >= -PRESENTATION_WITNESS_WINDOW_MS
      && latencyMs <= PRESENTATION_WITNESS_WINDOW_MS
    )
  })
  if (bounded.length < PRESENTATION_MINIMUM_SAMPLES) {
    return {
      status: 'ambiguous',
      reason:
        bounded.length === 0
          ? 'no-bounded-samples'
          : 'insufficient-samples',
      sampleCount: bounded.length,
    }
  }
  if (
    bounded.some(
      ({ fingerprint }) =>
        !fingerprintsHaveSameShape(reference, fingerprint),
    )
  ) {
    return {
      status: 'ambiguous',
      reason: 'fingerprint-shape-mismatch',
      sampleCount: bounded.length,
    }
  }
  const distances = bounded
    .map((sample) => ({
      sample,
      delta: sourceLatencyFingerprintDelta(reference, sample.fingerprint),
    }))
    .filter((candidate) => Number.isFinite(candidate.delta))
    .sort((left, right) => left.delta - right.delta)
  const best = distances[0]
  const second = distances[1]
  if (best === undefined || second === undefined) {
    return {
      status: 'ambiguous',
      reason: 'insufficient-samples',
      sampleCount: distances.length,
    }
  }
  const contrast = second.delta - best.delta
  if (
    best.delta > PRESENTATION_MAXIMUM_MATCH_DELTA
    || contrast < PRESENTATION_MINIMUM_MATCH_CONTRAST
  ) {
    return {
      status: 'ambiguous',
      reason: 'weak-pixel-match',
      sampleCount: distances.length,
      bestDelta: best.delta,
      contrast,
    }
  }
  const bestIndex = bounded.indexOf(best.sample)
  if (bestIndex <= 0 || bestIndex >= bounded.length - 1) {
    return {
      status: 'ambiguous',
      reason: 'unbracketed-match',
      sampleCount: distances.length,
      bestDelta: best.delta,
      contrast,
    }
  }
  const beforeMotion = bounded
    .slice(0, bestIndex)
    .some(
      ({ fingerprint }) =>
        sourceLatencyFingerprintDelta(reference, fingerprint)
          - best.delta
        >= PRESENTATION_MINIMUM_MATCH_CONTRAST,
    )
  const afterMotion = bounded
    .slice(bestIndex + 1)
    .some(
      ({ fingerprint }) =>
        sourceLatencyFingerprintDelta(reference, fingerprint)
          - best.delta
        >= PRESENTATION_MINIMUM_MATCH_CONTRAST,
    )
  if (!beforeMotion || !afterMotion) {
    return {
      status: 'ambiguous',
      reason: 'unbracketed-match',
      sampleCount: distances.length,
      bestDelta: best.delta,
      contrast,
    }
  }
  const latencyMs = best.sample.presentedAtMs - referenceAtMs
  if (!Number.isFinite(latencyMs) || latencyMs < 0 || latencyMs > 1_000) {
    return {
      status: 'unavailable',
      reason: 'invalid-latency',
      sampleCount: distances.length,
      bestDelta: best.delta,
      contrast,
    }
  }
  return {
    status: 'measured',
    reason: 'measured',
    latencyMs,
    bestDelta: best.delta,
    contrast,
    sampleCount: distances.length,
    ...(typeof best.sample.mediaTimeMs === 'number'
      && Number.isFinite(best.sample.mediaTimeMs)
      && best.sample.mediaTimeMs >= 0
      ? {
          matchedMediaTimeMs: best.sample.mediaTimeMs,
          sourceMediaTimeOriginMs: referenceAtMs - best.sample.mediaTimeMs,
        }
      : {}),
  }
}

export interface PixelExposureLatencyEvidence {
  readonly status?: string
  readonly method?: string
  readonly sampleSource?: string
  readonly latencyMs?: number
  readonly qpc?: {
    readonly status?: string
  }
  readonly pixel?: {
    readonly status?: string
  }
  readonly presentation?: {
    readonly status?: string
    readonly method?: string
    readonly latencyMs?: number
  }
  readonly reference?: {
    readonly source?: string
    readonly timing?: string
  }
}

/**
 * Return the independently measured desktop-exposure -> processor presentation
 * latency only when every provenance leg is proved.
 *
 * This value may translate a same-frame presentation clock onto the pixel
 * exposure axis used to query context. It must never retime the encoded replay
 * origin itself; `alignReplayOriginToMeasuredPixels` remains a no-op below.
 */
export function measuredPixelExposureLatencyMs(
  evidence: PixelExposureLatencyEvidence | undefined,
): number | undefined {
  const presentationLatencyMs = evidence?.presentation?.latencyMs
  if (
    evidence?.status !== 'measured'
    || evidence.method !== 'pixel-match'
    || evidence.sampleSource !== 'media-stream-track-processor'
    || evidence.reference?.source !== 'dxgi-desktop-duplication'
    || evidence.reference.timing !== 'pixel-exposure'
    || evidence.qpc?.status !== 'measured'
    || evidence.pixel?.status !== 'measured'
    || evidence.presentation?.status !== 'measured'
    || evidence.presentation.method
      !== 'dxgi-processor-rvfc-pixel-join'
    || typeof presentationLatencyMs !== 'number'
    || !Number.isFinite(presentationLatencyMs)
    || presentationLatencyMs < 0
    || presentationLatencyMs > 1_000
  ) {
    return undefined
  }
  return presentationLatencyMs
}

/**
 * Source-to-processor latency is diagnostic evidence, not an encoded-media
 * clock anchor. The recorder origin comes from a different observation
 * (muxed PTS versus wall time), so subtracting this value mixes two unrelated
 * clock legs and double-corrects the replay. Retained as a compatibility no-op
 * while callers migrate to same-frame encoded-PTS/presentation matching.
 */
export function alignReplayOriginToMeasuredPixels<
  T extends {
    readonly status: SourceLatencyCalibrationDecision['status']
    readonly latencyMs?: number
  },
>(
  recorderOriginMs: number,
  calibration: T | undefined,
): number {
  void calibration
  return recorderOriginMs
}
