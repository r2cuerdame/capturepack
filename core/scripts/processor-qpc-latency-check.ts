import {
  decideProcessorQpcDeliveryLatency,
  mapProcessorFrameEpochMs,
  type ProcessorQpcAnchor,
  type ProcessorTimestampSample,
} from '../src/renderer/capture/processorQpcDelivery'
import {
  alignReplayOriginToMeasuredPixels,
  decideSourceLatencyCalibration,
} from '../src/renderer/capture/sourceLatencyCalibration'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) passed += 1
  else failed += 1
  console.log(
    `  ${condition ? 'PASS' : 'FAIL'}  ${name}${
      detail === '' ? '' : ` — ${detail}`
    }`,
  )
}

const evidence = {
  clockEvidence: 'windows-qpc' as const,
}
const anchor: ProcessorQpcAnchor = {
  capturedQpc: 1_000_000_000,
  qpcFrequency: 10_000_000,
  capturedAtMs: 1_780_000_000_000,
}
const timestampMs = [99_900, 99_933, 99_966, 99_999, 100_032, 100_065, 100_098]

function mappedEpoch(frameTimestampMs: number): number {
  return (
    anchor.capturedAtMs +
    (frameTimestampMs -
      (anchor.capturedQpc * 1_000) / anchor.qpcFrequency)
  )
}

function samplesWithLatency(
  latencies: readonly number[],
  observedScale = 1,
): ProcessorTimestampSample[] {
  const first = timestampMs[0] ?? 0
  return latencies.map((latency, index) => {
    const timestamp = timestampMs[index] ?? timestampMs.at(-1) ?? first
    return {
      frameTimestampUs: timestamp * 1_000,
      observedAtMs:
        mappedEpoch(first) +
        (timestamp - first) * observedScale +
        latency,
    }
  })
}

const steady = decideProcessorQpcDeliveryLatency(
  samplesWithLatency([80, 81, 79, 80, 82, 81, 80]),
  anchor,
  evidence,
)
check(
  'a bracketed stable Windows QPC processor clock is measured',
  steady.status === 'measured' &&
    steady.deliveryLatencyMs !== undefined &&
    steady.deliveryLatencyMs >= 79 &&
    steady.deliveryLatencyMs <= 82 &&
    steady.timestampMonotonic === true &&
    steady.nativeQpcBracketed === true,
  JSON.stringify(steady),
)

check(
  'static pixels do not prevent processor-delivery clock measurement',
  steady.status === 'measured' && steady.sampleCount === 7,
)
check(
  'measured diagnostics retain QPC span, bracket and robust distribution',
  steady.nativeQpcBracketed === true &&
    steady.timestampSpanMs !== undefined &&
    steady.observedSpanMs !== undefined &&
    steady.deliveryLatencyP05Ms !== undefined &&
    steady.deliveryLatencyP50Ms !== undefined &&
    steady.deliveryLatencyP95Ms !== undefined &&
    steady.deliveryLatencyMadMs !== undefined &&
    steady.reason === 'measured',
  JSON.stringify(steady),
)

const tooShort = decideProcessorQpcDeliveryLatency(
  samplesWithLatency([80, 80, 80, 80]),
  anchor,
  evidence,
)
check(
  'fewer than five timestamps stay ambiguous',
  tooShort.status === 'ambiguous' &&
    tooShort.reason === 'insufficient-samples',
  JSON.stringify(tooShort),
)

const noEvidence = decideProcessorQpcDeliveryLatency(
  samplesWithLatency([80, 80, 80, 80, 80]),
  anchor,
  { clockEvidence: 'unknown' },
)
check(
  'an unproven processor clock can never be adopted',
  noEvidence.status === 'ambiguous' &&
    noEvidence.reason === 'unsupported-clock-evidence',
  JSON.stringify(noEvidence),
)

const nonMonotonic = samplesWithLatency([80, 80, 80, 80, 80, 80])
nonMonotonic[3] = {
  ...(nonMonotonic[3] ?? { observedAtMs: 0, frameTimestampUs: 0 }),
  frameTimestampUs: nonMonotonic[2]?.frameTimestampUs ?? 0,
}
const reversed = decideProcessorQpcDeliveryLatency(nonMonotonic, anchor, evidence)
check(
  'duplicate or reversed processor timestamps stay ambiguous',
  reversed.status === 'ambiguous' &&
    reversed.reason === 'non-monotonic-timestamp',
  JSON.stringify(reversed),
)

const outsideAnchor: ProcessorQpcAnchor = {
  ...anchor,
  capturedQpc: 1_001_500_000,
}
const unbracketed = decideProcessorQpcDeliveryLatency(
  samplesWithLatency([80, 80, 80, 80, 80, 80, 80]),
  outsideAnchor,
  evidence,
)
check(
  'a native QPC outside the processor timestamp range stays ambiguous',
  unbracketed.status === 'ambiguous' &&
    unbracketed.reason === 'unbracketed-native-qpc',
  JSON.stringify(unbracketed),
)

const scaleMismatch = decideProcessorQpcDeliveryLatency(
  samplesWithLatency([80, 80, 80, 80, 80, 80, 80], 2),
  anchor,
  evidence,
)
check(
  'a processor/observed clock scale mismatch stays ambiguous',
  scaleMismatch.status === 'ambiguous' &&
    scaleMismatch.reason === 'clock-scale-mismatch',
  JSON.stringify(scaleMismatch),
)

const originMismatch = decideProcessorQpcDeliveryLatency(
  samplesWithLatency([5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000]),
  anchor,
  evidence,
)
check(
  'a stable but incompatible clock origin stays ambiguous',
  originMismatch.status === 'ambiguous' &&
    originMismatch.reason === 'delivery-latency-out-of-bounds',
  JSON.stringify(originMismatch),
)

const negative = decideProcessorQpcDeliveryLatency(
  samplesWithLatency([-5, -5, -5, -5, -5, -5, -5]),
  anchor,
  evidence,
)
check(
  'negative mapped delivery latency stays ambiguous',
  negative.status === 'ambiguous' &&
    negative.reason === 'negative-delivery-latency',
  JSON.stringify(negative),
)

const jitter = decideProcessorQpcDeliveryLatency(
  samplesWithLatency([40, 68, 42, 70, 44, 72, 46]),
  anchor,
  evidence,
)
check(
  'unstable delivery jitter stays ambiguous',
  jitter.status === 'ambiguous' &&
    jitter.reason === 'unstable-delivery-latency',
  JSON.stringify(jitter),
)

const wallJumpSamples = samplesWithLatency([80, 80, 80, 80, 80, 80, 80])
for (let index = 3; index < wallJumpSamples.length; index += 1) {
  const sample = wallJumpSamples[index]
  if (sample !== undefined) {
    wallJumpSamples[index] = {
      ...sample,
      observedAtMs: sample.observedAtMs + 1_000,
    }
  }
}
const wallJump = decideProcessorQpcDeliveryLatency(
  wallJumpSamples,
  anchor,
  evidence,
)
check(
  'an observed wall-clock jump stays ambiguous',
  wallJump.status === 'ambiguous' &&
    (
      wallJump.reason === 'clock-scale-mismatch' ||
      wallJump.reason === 'wall-clock-discontinuity'
    ),
  JSON.stringify(wallJump),
)

const malformedAnchor = decideProcessorQpcDeliveryLatency(
  samplesWithLatency([80, 80, 80, 80, 80]),
  { ...anchor, qpcFrequency: 0 },
  evidence,
)
check(
  'a malformed native QPC anchor is unavailable',
  malformedAnchor.status === 'unavailable' &&
    malformedAnchor.reason === 'invalid-native-anchor',
  JSON.stringify(malformedAnchor),
)

const anchorEpoch = mapProcessorFrameEpochMs(
  (anchor.capturedQpc * 1_000_000) / anchor.qpcFrequency,
  anchor,
  steady,
)
check(
  'a proven processor QPC clock maps timestamps onto epoch without read jitter',
  anchorEpoch === anchor.capturedAtMs,
  String(anchorEpoch),
)
check(
  'an ambiguous processor clock cannot map a frame epoch',
  mapProcessorFrameEpochMs(
    (anchor.capturedQpc * 1_000_000) / anchor.qpcFrequency,
    anchor,
    noEvidence,
  ) === undefined,
)

const staticFingerprint = {
  meanLuma: 100,
  darkRatio: 0,
  cells: [100, 100, 100, 100],
}
const staticSource = decideSourceLatencyCalibration(
  timestampMs.map((frameTimestampMs) => ({
    latencyMs:
      (mapProcessorFrameEpochMs(
        frameTimestampMs * 1_000,
        anchor,
        steady,
      ) ?? Number.NaN) - anchor.capturedAtMs,
    delta: 0,
    fingerprint: staticFingerprint,
  })),
  {
    candidateRangeMs: { min: -200, max: 200 },
    sampleSource: 'media-stream-track-processor',
    referenceTiming: 'pixel-exposure',
  },
)
check(
  'stable QPC plus static pixels remains ambiguous source latency',
  staticSource.status === 'ambiguous' &&
    staticSource.reason === 'no-motion-witness',
  JSON.stringify(staticSource),
)
check(
  'stable processor delivery timing cannot move replay origin without a pixel match',
  alignReplayOriginToMeasuredPixels(10_000, {
    status: staticSource.status,
    latencyMs: steady.deliveryLatencyMs,
  }) === 10_000,
)

const source = decideProcessorQpcDeliveryLatency.toString()
check(
  'the decision has no FPS input or fixed latency correction',
  !source.includes('fps') &&
    !source.includes('requestedFps') &&
    !source.includes('frameInterval'),
)

console.log(`\nprocessor QPC delivery checks: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
