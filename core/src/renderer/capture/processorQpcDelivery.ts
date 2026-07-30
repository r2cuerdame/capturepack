export interface ProcessorTimestampSample {
  /** Epoch-comparable DOMHighResTimeStamp recorded when the frame was read. */
  readonly observedAtMs: number
  /** Raw VideoFrame.timestamp. WebCodecs defines this unit as microseconds. */
  readonly frameTimestampUs: number
}

export interface ProcessorQpcAnchor {
  /** QueryPerformanceCounter value captured with the independent native frame. */
  readonly capturedQpc: number
  /** QueryPerformanceFrequency reported by that same native helper. */
  readonly qpcFrequency: number
  /** Epoch wall time paired with capturedQpc by the helper. */
  readonly capturedAtMs: number
}

export interface ProcessorQpcDeliveryOptions {
  /**
   * Explicit runtime evidence, not platform inference.
   *
   * The caller may provide this only where the Windows native helper supplied
   * QPC/frequency and the processor timestamp is being tested as QPC
   * microseconds. Other platforms and unknown origins remain diagnostic-only.
   */
  readonly clockEvidence: 'windows-qpc' | 'unknown'
}

export type ProcessorQpcDeliveryReason =
  | 'measured'
  | 'unsupported-clock-evidence'
  | 'invalid-native-anchor'
  | 'insufficient-samples'
  | 'non-finite-sample'
  | 'non-monotonic-timestamp'
  | 'wall-clock-discontinuity'
  | 'unbracketed-native-qpc'
  | 'clock-scale-mismatch'
  | 'negative-delivery-latency'
  | 'delivery-latency-out-of-bounds'
  | 'unstable-delivery-latency'

export interface ProcessorQpcDeliveryDecision {
  readonly status: 'measured' | 'ambiguous' | 'unavailable'
  readonly reason: ProcessorQpcDeliveryReason
  readonly sampleCount: number
  readonly timestampMonotonic?: boolean
  readonly nativeQpcBracketed?: boolean
  readonly timestampSpanMs?: number
  readonly observedSpanMs?: number
  readonly spanErrorRatio?: number
  readonly deliveryLatencyMs?: number
  readonly deliveryLatencyP05Ms?: number
  readonly deliveryLatencyP50Ms?: number
  readonly deliveryLatencyP95Ms?: number
  readonly deliveryLatencyMadMs?: number
  readonly deliveryLatencyBoundMs?: number
}

const MINIMUM_SAMPLES = 5
// Dimensionless clock-contract checks. They reject incompatible clocks; they
// are not latency estimates or FPS-derived corrections.
const MAXIMUM_SPAN_ERROR_RATIO = 0.1
const MAXIMUM_MAD_AS_STEP_RATIO = 0.25
const MAXIMUM_P05_P95_AS_STEP_RATIO = 0.75

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((left, right) => left - right)
  const position =
    Math.max(0, Math.min(1, quantile)) * (sorted.length - 1)
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

function decision(
  status: ProcessorQpcDeliveryDecision['status'],
  reason: ProcessorQpcDeliveryReason,
  sampleCount: number,
  metrics: Omit<
    Partial<ProcessorQpcDeliveryDecision>,
    'status' | 'reason' | 'sampleCount'
  > = {},
): ProcessorQpcDeliveryDecision {
  return { status, reason, sampleCount, ...metrics }
}

/**
 * Tests whether this runtime's raw processor timestamps are the Windows QPC
 * clock and, only then, measures processor-to-JS delivery latency.
 *
 * Mapping (all observed values):
 *
 *   frameEpoch = nativeEpoch
 *              + (frameTimestampUs / 1000 - nativeQpc * 1000 / frequency)
 *   deliveryLatency = observedEpoch - frameEpoch
 *
 * No requested FPS, frame-count correction or fixed millisecond offset enters
 * this calculation. This is NOT desktop pixel/source latency: field artifact
 * qpc-hold30-20260730-181739 measured this path at 0.529 ms while the
 * independent decoded-pixel match was 53.07..76.07 ms. A measured decision may
 * therefore map processor sample timestamps, but can never retime replay by
 * itself.
 */
export function decideProcessorQpcDeliveryLatency(
  samples: readonly ProcessorTimestampSample[],
  anchor: ProcessorQpcAnchor,
  options: ProcessorQpcDeliveryOptions,
): ProcessorQpcDeliveryDecision {
  if (options.clockEvidence !== 'windows-qpc') {
    return decision(
      'ambiguous',
      'unsupported-clock-evidence',
      samples.length,
    )
  }
  if (
    !Number.isFinite(anchor.capturedQpc) ||
    anchor.capturedQpc < 0 ||
    !Number.isFinite(anchor.qpcFrequency) ||
    anchor.qpcFrequency <= 0 ||
    !Number.isFinite(anchor.capturedAtMs)
  ) {
    return decision('unavailable', 'invalid-native-anchor', samples.length)
  }
  if (samples.length < MINIMUM_SAMPLES) {
    return decision('ambiguous', 'insufficient-samples', samples.length)
  }
  if (
    samples.some(
      (sample) =>
        !Number.isFinite(sample.frameTimestampUs) ||
        !Number.isFinite(sample.observedAtMs),
    )
  ) {
    return decision('ambiguous', 'non-finite-sample', samples.length)
  }

  const timestampMs = samples.map(
    (sample) => sample.frameTimestampUs / 1_000,
  )
  const observedMs = samples.map((sample) => sample.observedAtMs)
  const timestampSteps: number[] = []
  const observedSteps: number[] = []
  for (let index = 1; index < samples.length; index += 1) {
    const previousTimestamp = timestampMs[index - 1]
    const currentTimestamp = timestampMs[index]
    const previousObserved = observedMs[index - 1]
    const currentObserved = observedMs[index]
    if (
      previousTimestamp === undefined ||
      currentTimestamp === undefined ||
      currentTimestamp <= previousTimestamp
    ) {
      return decision(
        'ambiguous',
        'non-monotonic-timestamp',
        samples.length,
        { timestampMonotonic: false },
      )
    }
    if (
      previousObserved === undefined ||
      currentObserved === undefined ||
      currentObserved <= previousObserved
    ) {
      return decision(
        'ambiguous',
        'wall-clock-discontinuity',
        samples.length,
        { timestampMonotonic: true },
      )
    }
    timestampSteps.push(currentTimestamp - previousTimestamp)
    observedSteps.push(currentObserved - previousObserved)
  }

  const firstTimestamp = timestampMs[0]
  const lastTimestamp = timestampMs[timestampMs.length - 1]
  const firstObserved = observedMs[0]
  const lastObserved = observedMs[observedMs.length - 1]
  if (
    firstTimestamp === undefined ||
    lastTimestamp === undefined ||
    firstObserved === undefined ||
    lastObserved === undefined
  ) {
    return decision('ambiguous', 'insufficient-samples', samples.length)
  }
  const timestampSpanMs = lastTimestamp - firstTimestamp
  const observedSpanMs = lastObserved - firstObserved
  const nativeQpcMs =
    (anchor.capturedQpc * 1_000) / anchor.qpcFrequency
  const nativeQpcBracketed =
    nativeQpcMs >= firstTimestamp && nativeQpcMs <= lastTimestamp
  const commonMetrics = {
    timestampMonotonic: true,
    nativeQpcBracketed,
    timestampSpanMs,
    observedSpanMs,
  }
  if (!nativeQpcBracketed) {
    return decision(
      'ambiguous',
      'unbracketed-native-qpc',
      samples.length,
      commonMetrics,
    )
  }
  if (
    timestampSpanMs <= 0 ||
    observedSpanMs <= 0 ||
    timestampSteps.length === 0 ||
    observedSteps.length === 0
  ) {
    return decision(
      'ambiguous',
      'clock-scale-mismatch',
      samples.length,
      commonMetrics,
    )
  }
  const spanErrorRatio =
    Math.abs(observedSpanMs - timestampSpanMs) / timestampSpanMs
  const scaleMetrics = { ...commonMetrics, spanErrorRatio }
  if (
    !Number.isFinite(spanErrorRatio) ||
    spanErrorRatio > MAXIMUM_SPAN_ERROR_RATIO
  ) {
    return decision(
      'ambiguous',
      'clock-scale-mismatch',
      samples.length,
      scaleMetrics,
    )
  }

  const latencies = timestampMs.map(
    (frameTimestampMs, index) =>
      (observedMs[index] ?? Number.NaN) -
      (
        anchor.capturedAtMs +
        (frameTimestampMs - nativeQpcMs)
      ),
  )
  if (latencies.some((latency) => !Number.isFinite(latency))) {
    return decision(
      'ambiguous',
      'non-finite-sample',
      samples.length,
      scaleMetrics,
    )
  }
  if (latencies.some((latency) => latency < 0)) {
    return decision(
      'ambiguous',
      'negative-delivery-latency',
      samples.length,
      scaleMetrics,
    )
  }

  const deliveryLatencyP05Ms = percentile(latencies, 0.05)
  const deliveryLatencyP50Ms = median(latencies)
  const deliveryLatencyP95Ms = percentile(latencies, 0.95)
  const deliveryLatencyMadMs = median(
    latencies.map((latency) =>
      Math.abs(latency - deliveryLatencyP50Ms),
    ),
  )
  // A clock-origin error is constant and can otherwise look perfectly stable.
  // The observed sample span is the only data-derived bound available here:
  // if the claimed latency is longer than all evidence observed around the
  // native bracket, the clock origin has not been established.
  const deliveryLatencyBoundMs = Math.max(timestampSpanMs, observedSpanMs)
  const latencyMetrics = {
    ...scaleMetrics,
    deliveryLatencyP05Ms,
    deliveryLatencyP50Ms,
    deliveryLatencyP95Ms,
    deliveryLatencyMadMs,
    deliveryLatencyBoundMs,
  }
  if (deliveryLatencyP95Ms > deliveryLatencyBoundMs) {
    return decision(
      'ambiguous',
      'delivery-latency-out-of-bounds',
      samples.length,
      latencyMetrics,
    )
  }

  const typicalTimestampStepMs = median(timestampSteps)
  if (
    !Number.isFinite(typicalTimestampStepMs) ||
    typicalTimestampStepMs <= 0 ||
    deliveryLatencyMadMs >
      typicalTimestampStepMs * MAXIMUM_MAD_AS_STEP_RATIO ||
    deliveryLatencyP95Ms - deliveryLatencyP05Ms >
      typicalTimestampStepMs * MAXIMUM_P05_P95_AS_STEP_RATIO
  ) {
    return decision(
      'ambiguous',
      'unstable-delivery-latency',
      samples.length,
      latencyMetrics,
    )
  }

  return decision('measured', 'measured', samples.length, {
    ...latencyMetrics,
    deliveryLatencyMs: deliveryLatencyP50Ms,
  })
}

/**
 * Maps one processor timestamp onto the helper's epoch anchor only after the
 * clock decision was measured. This removes JS reader scheduling jitter from
 * the pixel match's sample axis; the mapped time is still processor
 * presentation/delivery time and is not a source-latency measurement.
 */
export function mapProcessorFrameEpochMs(
  frameTimestampUs: number,
  anchor: ProcessorQpcAnchor,
  decision: ProcessorQpcDeliveryDecision,
): number | undefined {
  if (
    decision.status !== 'measured' ||
    !Number.isFinite(frameTimestampUs) ||
    !Number.isFinite(anchor.capturedQpc) ||
    !Number.isFinite(anchor.qpcFrequency) ||
    anchor.qpcFrequency <= 0 ||
    !Number.isFinite(anchor.capturedAtMs)
  ) {
    return undefined
  }
  const nativeQpcMs =
    (anchor.capturedQpc * 1_000) / anchor.qpcFrequency
  const mapped =
    anchor.capturedAtMs + frameTimestampUs / 1_000 - nativeQpcMs
  return Number.isFinite(mapped) ? mapped : undefined
}
