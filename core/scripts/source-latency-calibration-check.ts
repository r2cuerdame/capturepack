import {
  alignReplayOriginToMeasuredPixels,
  buildSourceLatencyFingerprint,
  buildSourceLatencyFingerprintFromRgb,
  decideProcessorPresentationLatency,
  decideSourceLatencyCalibration,
  decideSourcePresentationLatency,
  mapDxgiTimingReferenceEpoch,
  measuredPixelExposureLatencyMs,
  SOURCE_LATENCY_CALIBRATION_FINGERPRINT_BYTES,
  SOURCE_LATENCY_FINGERPRINT_BYTES,
  SOURCE_LATENCY_FINGERPRINT_HEIGHT,
  SOURCE_LATENCY_FINGERPRINT_WIDTH,
  SOURCE_LATENCY_RETAINED_FINGERPRINT_BYTES,
  SOURCE_LATENCY_RETAINED_SAMPLE_LIMIT,
  sourceLatencyFingerprintDelta,
  type SourceLatencyCalibrationSample,
} from '../src/renderer/capture/sourceLatencyCalibration'
import { readFileSync } from 'node:fs'
import path from 'node:path'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) passed += 1
  else failed += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

function sample(latencyMs: number, value: number, reference = 100): SourceLatencyCalibrationSample {
  return {
    latencyMs,
    delta: Math.abs(value - reference),
    fingerprint: {
      meanLuma: value,
      darkRatio: value < 24 ? 1 : 0,
      cells: [value, value + 1, value - 1, value],
    },
  }
}

function samples(
  startMs: number,
  stepMs: number,
  values: readonly number[],
): SourceLatencyCalibrationSample[] {
  return values.map((value, index) => sample(startMs + index * stepMs, value))
}

function processorRange(min: number, max: number) {
  return {
    candidateRangeMs: { min, max },
    sampleSource: 'media-stream-track-processor' as const,
    referenceTiming: 'pixel-exposure' as const,
  }
}

function rgbFrame(
  width: number,
  height: number,
  paint: (
    x: number,
    y: number,
  ) => readonly [red: number, green: number, blue: number],
): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      const [red, green, blue] = paint(x, y)
      rgba[offset] = red
      rgba[offset + 1] = green
      rgba[offset + 2] = blue
      rgba[offset + 3] = 255
    }
  }
  return rgba
}

function jpegLikeReference(
  width: number,
  height: number,
  paint: (
    x: number,
    y: number,
  ) => readonly [red: number, green: number, blue: number],
): Uint8ClampedArray {
  return rgbFrame(width, height, (x, y) => {
    const source = paint(x, y)
    const block = ((Math.floor(x / 8) * 11 + Math.floor(y / 8) * 7) % 7) - 3
    return source.map((channel, channelIndex) => {
      const ringing = ((x * 3 + y * 5 + channelIndex * 7) % 5) - 2
      const perturbed = channel + block + ringing
      return Math.max(0, Math.min(255, Math.round(perturbed / 4) * 4))
    }) as unknown as readonly [number, number, number]
  })
}

function largeStaticScene(
  targetX: number,
  targetY: number,
): (
  x: number,
  y: number,
) => readonly [red: number, green: number, blue: number] {
  return (x, y) => {
    if (
      x >= targetX
      && x < targetX + 10
      && y >= targetY
      && y < targetY + 8
    ) {
      return [238, 22, 206]
    }
    if (x < 92 && y < 58) {
      const stripe = (Math.floor(x / 12) + Math.floor(y / 9)) % 2
      return stripe === 0 ? [31, 36, 47] : [35, 40, 51]
    }
    if (x >= 104 || y >= 62) return [19, 23, 31]
    return [42, 47, 58]
  }
}

function legacyExpanded64Delta(
  left: Uint8ClampedArray,
  right: Uint8ClampedArray,
): number {
  const width = 64
  const height = 36
  let difference = 0
  let count = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        const cell = (y * width + x) * 4 + channel
        difference += Math.abs((left[cell] ?? 0) - (right[cell] ?? 0))
        count += 1
        const previous = (y * width + Math.max(0, x - 1)) * 4 + channel
        difference += Math.abs(
          ((left[cell] ?? 0) - (left[previous] ?? 0)) * 2
          - ((right[cell] ?? 0) - (right[previous] ?? 0)) * 2,
        )
        count += 1
        const above = (Math.max(0, y - 1) * width + x) * 4 + channel
        difference += Math.abs(
          ((left[cell] ?? 0) - (left[above] ?? 0)) * 2
          - ((right[cell] ?? 0) - (right[above] ?? 0)) * 2,
        )
        count += 1
      }
    }
  }
  return difference / count
}

function legacy64Scene(
  targetX: number,
  targetY: number,
): (
  x: number,
  y: number,
) => readonly [red: number, green: number, blue: number] {
  return (x, y) => {
    if (
      x >= targetX
      && x < targetX + 4
      && y >= targetY
      && y < targetY + 3
    ) {
      return [238, 22, 206]
    }
    if (x < 46 && y < 29) {
      const stripe = (Math.floor(x / 6) + Math.floor(y / 5)) % 2
      return stripe === 0 ? [31, 36, 47] : [35, 40, 51]
    }
    if (x >= 52 || y >= 31) return [19, 23, 31]
    return [42, 47, 58]
  }
}

function jpegPerturbedTrough(
  expectedLatencyMs: number,
  vertical: boolean,
): {
  readonly decision: ReturnType<typeof decideSourceLatencyCalibration>
  readonly deltas: readonly number[]
} {
  const width = 128
  const height = 72
  const stepMs = 23
  const expectedIndex = 4
  const referenceX = vertical ? 62 : 58
  const referenceY = vertical ? 30 : 28
  const reference = buildSourceLatencyFingerprint(
    jpegLikeReference(
      width,
      height,
      largeStaticScene(referenceX, referenceY),
    ),
    width,
    height,
  )
  const calibrationSamples = Array.from({ length: 9 }, (_, index) => {
    const offset = (index - expectedIndex) * 7
    const fingerprint = buildSourceLatencyFingerprint(
      rgbFrame(
        width,
        height,
        largeStaticScene(
          vertical ? referenceX : referenceX + offset,
          vertical ? referenceY + offset : referenceY,
        ),
      ),
      width,
      height,
    )
    return {
      latencyMs: expectedLatencyMs + (index - expectedIndex) * stepMs,
      delta: sourceLatencyFingerprintDelta(reference, fingerprint),
      fingerprint,
    }
  })
  return {
    decision: decideSourceLatencyCalibration(
      calibrationSamples,
      processorRange(
        expectedLatencyMs - expectedIndex * stepMs,
        expectedLatencyMs + expectedIndex * stepMs,
      ),
    ),
    deltas: calibrationSamples.map(({ delta }) => delta),
  }
}

function movingTargetFingerprint(left: number) {
  return buildSourceLatencyFingerprint(
    rgbFrame(64, 36, (x, y) =>
      x >= left && x < left + 18 && y >= 9 && y < 27
        ? [238, 22, 206]
        : [18, 22, 30],
    ),
    64,
    36,
  )
}

const compactFingerprint = buildSourceLatencyFingerprint(
  rgbFrame(128, 72, largeStaticScene(58, 28)),
  128,
  72,
)
const compactRgbFingerprint = buildSourceLatencyFingerprintFromRgb(
  compactFingerprint.rgb,
  128,
  72,
)
check(
  'same-resource DXGI RGB constructs the exact calibration fingerprint without RGBA/JPEG conversion',
  compactRgbFingerprint.width === compactFingerprint.width
    && compactRgbFingerprint.height === compactFingerprint.height
    && compactRgbFingerprint.meanLuma === compactFingerprint.meanLuma
    && compactRgbFingerprint.darkRatio === compactFingerprint.darkRatio
    && compactRgbFingerprint.rgb.every(
      (value, index) => value === compactFingerprint.rgb[index],
    ),
)
const mappedDxgi = mapDxgiTimingReferenceEpoch({
  lastPresentQpc: '91000000',
  qpcFrequency: '10000000',
  anchor: {
    qpc: '92000000',
    unixNs: '1785000000000000000',
    spanQpc: '20',
  },
})
check(
  'DXGI LastPresentTime maps onto epoch from exact decimal QPC/Unix fields',
  mappedDxgi.presentedAtMs === 1_784_999_999_900
    && mappedDxgi.presentedAtUnixNs === '1784999999900000000',
  JSON.stringify(mappedDxgi),
)
check(
  'DXGI epoch mapping retains the full anchor bracket and midpoint uncertainty',
  mappedDxgi.anchorSpanQpc === '20'
    && mappedDxgi.anchorSpanMs === 0.002
    && mappedDxgi.anchorUncertaintyMs === 0.001,
  JSON.stringify(mappedDxgi),
)
check(
  'the 128x72 calibration fingerprint retains compact RGB bytes only',
  compactFingerprint.cells instanceof Uint8Array
    && compactFingerprint.rgb === compactFingerprint.cells
    && compactFingerprint.cells.length === 128 * 72 * 3
    && compactFingerprint.cells.byteLength === 128 * 72 * 3,
  `constructor=${compactFingerprint.cells.constructor.name}; cells=${compactFingerprint.cells.length}`,
)
check(
  '128 retained 128x72 RGB fingerprints stay below a four MiB byte budget',
  SOURCE_LATENCY_FINGERPRINT_WIDTH === 128
    && SOURCE_LATENCY_FINGERPRINT_HEIGHT === 72
    && SOURCE_LATENCY_RETAINED_SAMPLE_LIMIT === 128
    && SOURCE_LATENCY_FINGERPRINT_BYTES === compactFingerprint.cells.byteLength
    && SOURCE_LATENCY_RETAINED_FINGERPRINT_BYTES
      === compactFingerprint.cells.byteLength * 128
    && SOURCE_LATENCY_CALIBRATION_FINGERPRINT_BYTES <= 4 * 1024 * 1024,
  `retainedBytes=${SOURCE_LATENCY_RETAINED_FINGERPRINT_BYTES}; peakWithReference=${SOURCE_LATENCY_CALIBRATION_FINGERPRINT_BYTES}`,
)

let oversizedFingerprintRejected = false
try {
  buildSourceLatencyFingerprint(
    new Uint8ClampedArray(129 * 72 * 4),
    129,
    72,
  )
} catch {
  oversizedFingerprintRejected = true
}
check(
  'the builder rejects rasters beyond the declared calibration memory bound',
  oversizedFingerprintRejected,
)

const jpegTrough53 = jpegPerturbedTrough(53, false)
const legacy64Reference = jpegLikeReference(
  64,
  36,
  legacy64Scene(29, 14),
)
const legacy64Frames = Array.from({ length: 9 }, (_, index) =>
  rgbFrame(64, 36, legacy64Scene(29 + (index - 4) * 3, 14)),
)
const legacy64Motion = legacy64Frames.slice(1).map((frame, index) =>
  legacyExpanded64Delta(legacy64Frames[index] ?? frame, frame),
)
const legacy64ReferenceDeltas = legacy64Frames.map((frame) =>
  legacyExpanded64Delta(legacy64Reference, frame),
)
check(
  'the field-shaped fixture reproduces legacy 64x36 mean-delta dilution',
  Math.max(...legacy64Motion) < 2
    && Math.max(...legacy64ReferenceDeltas)
      - Math.min(...legacy64ReferenceDeltas) < 2,
  `motion=${JSON.stringify(legacy64Motion)}; reference=${JSON.stringify(legacy64ReferenceDeltas)}`,
)
check(
  'large static/JPEG-like pixels retain one unique horizontal trough near 53ms',
  jpegTrough53.decision.status === 'measured'
    && jpegTrough53.decision.latencyMs === 53,
  `${JSON.stringify(jpegTrough53.decision)}; deltas=${JSON.stringify(jpegTrough53.deltas)}`,
)

const jpegTrough76 = jpegPerturbedTrough(76, true)
check(
  'large static/JPEG-like pixels retain one unique vertical trough near 76ms',
  jpegTrough76.decision.status === 'measured'
    && jpegTrough76.decision.latencyMs === 76,
  `${JSON.stringify(jpegTrough76.decision)}; deltas=${JSON.stringify(jpegTrough76.deltas)}`,
)

const subBlockMotion = sourceLatencyFingerprintDelta(
  movingTargetFingerprint(20),
  movingTargetFingerprint(21),
)
check(
  'one 64x36 block of real local motion survives the calibration fingerprint',
  subBlockMotion >= 2,
  `delta=${subBlockMotion}`,
)

const redFingerprint = buildSourceLatencyFingerprint(
  rgbFrame(64, 36, () => [255, 0, 0]),
  64,
  36,
)
const isoLumaGreenFingerprint = buildSourceLatencyFingerprint(
  rgbFrame(64, 36, () => [0, 75, 0]),
  64,
  36,
)
check(
  'same-luma chroma cannot alias in the calibration metric',
  sourceLatencyFingerprintDelta(
    redFingerprint,
    isoLumaGreenFingerprint,
  ) >= 20,
)

const staticRgbFingerprint = movingTargetFingerprint(20)
const staticRgb = decideSourceLatencyCalibration(
  Array.from({ length: 10 }, (_, index) => ({
    latencyMs: index * 20,
    delta: 0,
    fingerprint: staticRgbFingerprint,
  })),
  processorRange(0, 200),
)
check(
  'the richer fingerprint still rejects a static calibration scene',
  staticRgb.status === 'ambiguous' && staticRgb.reason === 'no-motion-witness',
  JSON.stringify(staticRgb),
)

const repeatedReference = movingTargetFingerprint(20)
const repeatedRgb = decideSourceLatencyCalibration(
  [15, 17, 19, 20, 21, 23, 25, 23, 21, 20, 19, 17, 15].map(
    (left, index) => {
      const fingerprint = movingTargetFingerprint(left)
      return {
        latencyMs: index * 20,
        delta: sourceLatencyFingerprintDelta(
          repeatedReference,
          fingerprint,
        ),
        fingerprint,
      }
    },
  ),
  processorRange(0, 260),
)
check(
  'the richer edge signature still rejects a repeated visit to the reference',
  repeatedRgb.status === 'ambiguous' &&
    repeatedRgb.reason === 'competing-match-clusters',
  JSON.stringify(repeatedRgb),
)

const chromaAlias = decideSourceLatencyCalibration(
  Array.from({ length: 10 }, (_, index) => ({
    latencyMs: index * 20,
    delta: sourceLatencyFingerprintDelta(
      redFingerprint,
      isoLumaGreenFingerprint,
    ),
    fingerprint: isoLumaGreenFingerprint,
  })),
  processorRange(0, 200),
)
check(
  'same-luma but different chroma remains ambiguous instead of becoming a false match',
  chromaAlias.status === 'ambiguous' &&
    chromaAlias.reason === 'no-motion-witness',
  JSON.stringify(chromaAlias),
)

const fiveFpsPlateau = decideSourceLatencyCalibration(
  samples(250, 30, [50, 65, 80, 92, 98, 100, 102, 103, 109, 120, 135, 150]),
  processorRange(200, 650),
)
check(
  'a bounded coherent plateau uses its first observed matching frame, not an interpolated midpoint',
  fiveFpsPlateau.status === 'measured'
    && fiveFpsPlateau.latencyMs === 370
    && (fiveFpsPlateau.confidence ?? 0) >= 0.65,
  JSON.stringify(fiveFpsPlateau),
)

const fifteenFpsTrough = decideSourceLatencyCalibration(
  samples(70, 15, [45, 58, 72, 86, 96, 100, 105, 116, 132, 149, 165]),
  processorRange(50, 260),
)
check(
  'a sharp 15 fps-like trough keeps its observed latency instead of adding a frame constant',
  fifteenFpsTrough.status === 'measured'
    && fifteenFpsTrough.latencyMs !== undefined
    && fifteenFpsTrough.latencyMs >= 125
    && fifteenFpsTrough.latencyMs <= 160,
  JSON.stringify(fifteenFpsTrough),
)

const shiftedTrough = decideSourceLatencyCalibration(
  samples(580, 35, [40, 55, 73, 90, 98, 100, 103, 112, 130, 151, 170]),
  processorRange(500, 1_100),
)
check(
  'latency is data-derived even when the same shape occurs much later',
  shiftedTrough.status === 'measured'
    && shiftedTrough.latencyMs === 720,
  JSON.stringify(shiftedTrough),
)

const observationallyEquivalentSamples = samples(
  0,
  20,
  [45, 62, 82, 96, 100, 106, 124, 145, 166],
)
const exposureTimedEvidence = decideSourceLatencyCalibration(
  observationallyEquivalentSamples,
  processorRange(0, 180),
)
const postBitbltEvidence = decideSourceLatencyCalibration(
  observationallyEquivalentSamples,
  {
    candidateRangeMs: { min: 0, max: 180 },
    sampleSource: 'media-stream-track-processor',
    referenceTiming: 'post-bitblt-completion',
  },
)
const unknownReferenceEvidence = decideSourceLatencyCalibration(
  observationallyEquivalentSamples,
  {
    candidateRangeMs: { min: 0, max: 180 },
    sampleSource: 'media-stream-track-processor',
    referenceTiming: 'unknown',
  },
)
check(
  'a pixel-exposure timestamp chooses the first observed frame in its deterministic trough',
  exposureTimedEvidence.status === 'measured'
    && exposureTimedEvidence.latencyMs === 60,
  JSON.stringify(exposureTimedEvidence),
)
check(
  'the same evidence cannot measure absolute latency from post-BitBlt completion',
  postBitbltEvidence.status === 'ambiguous'
    && postBitbltEvidence.reason === 'unsupported-reference-timing',
  JSON.stringify(postBitbltEvidence),
)
check(
  'observationally equivalent unknown reference timing cannot move replay origin',
  unknownReferenceEvidence.status === 'ambiguous'
    && unknownReferenceEvidence.reason === 'unsupported-reference-timing'
    && alignReplayOriginToMeasuredPixels(10_000, unknownReferenceEvidence)
      === 10_000,
  JSON.stringify(unknownReferenceEvidence),
)

const staticScene = decideSourceLatencyCalibration(
  samples(0, 16, [100, 100, 100, 100, 100, 100, 100, 100, 100, 100]),
  processorRange(0, 300),
)
check(
  'a static scene stays ambiguous even with a perfect reference delta',
  staticScene.status === 'ambiguous' && staticScene.reason === 'no-motion-witness',
  JSON.stringify(staticScene),
)

const deltaOnly = decideSourceLatencyCalibration(
  Array.from({ length: 12 }, (_, index) => ({
    latencyMs: 20 + index * 16,
    delta: Math.abs(index - 5),
  })),
  processorRange(0, 300),
)
check(
  'delta-only candidates cannot invent a motion witness',
  deltaOnly.status === 'ambiguous' && deltaOnly.reason === 'no-motion-witness',
  JSON.stringify(deltaOnly),
)

const tooShort = decideSourceLatencyCalibration(
  samples(0, 200, [50, 80, 100, 130]),
  processorRange(0, 800),
)
check(
  'fewer than five decoded frames cannot establish a bracketed calibration',
  tooShort.status === 'ambiguous' && tooShort.reason === 'insufficient-samples',
  JSON.stringify(tooShort),
)

const repeatedScene = decideSourceLatencyCalibration(
  samples(40, 20, [55, 72, 91, 100, 112, 134, 151, 132, 111, 100, 91, 70, 52]),
  processorRange(0, 340),
)
check(
  'two equally plausible visits to the reference are rejected as repeating content',
  repeatedScene.status === 'ambiguous' && repeatedScene.reason === 'competing-match-clusters',
  JSON.stringify(repeatedScene),
)

const flatTrough = decideSourceLatencyCalibration(
  samples(0, 20, [45, 75, 96, 99, 100, 100, 100, 100, 100, 99, 96, 75, 45]),
  processorRange(0, 260),
)
check(
  'a trough spanning most of the observed motion stays ambiguous',
  flatTrough.status === 'ambiguous' && flatTrough.reason === 'flat-match-trough',
  JSON.stringify(flatTrough),
)

const leftCensoredSink = decideSourceLatencyCalibration(
  samples(145, 16, [100, 103, 108, 116, 129, 145, 165, 180, 195, 208]),
  {
    candidateRangeMs: { min: 0, max: 500 },
    sampleSource: 'video-presentation-callback',
    referenceTiming: 'pixel-exposure',
  },
)
check(
  'a presentation sink is provenance-rejected before its plausible-looking plateau can win',
  leftCensoredSink.status === 'ambiguous'
    && leftCensoredSink.reason === 'unsupported-sample-source',
  JSON.stringify(leftCensoredSink),
)

const imageCaptureSink = decideSourceLatencyCalibration(
  samples(70, 15, [45, 58, 72, 86, 96, 100, 105, 116, 132, 149, 165]),
  {
    candidateRangeMs: { min: 50, max: 260 },
    sampleSource: 'image-capture',
    referenceTiming: 'pixel-exposure',
  },
)
check(
  'ImageCapture timing remains diagnostic-only even with a sharp match',
  imageCaptureSink.status === 'ambiguous'
    && imageCaptureSink.reason === 'unsupported-sample-source',
  JSON.stringify(imageCaptureSink),
)

const rightCensored = decideSourceLatencyCalibration(
  samples(20, 16, [25, 42, 61, 76, 88, 95, 98, 100]),
  processorRange(0, 200),
)
check(
  'a match that has not left the reference by the last observation is not accepted',
  rightCensored.status === 'ambiguous' && rightCensored.reason === 'unbracketed-match',
  JSON.stringify(rightCensored),
)

const oneTransitionSink = decideSourceLatencyCalibration(
  samples(0, 16, [
    60, 60, 60, 60, 60, 60, 60, 60,
    100, 100, 100, 100, 100, 100, 100, 100,
  ]),
  processorRange(0, 300),
)
check(
  'a throttled sink with only one presented transition is not a motion calibration',
  oneTransitionSink.status === 'ambiguous'
    && (
      oneTransitionSink.reason === 'insufficient-motion-transitions'
      || oneTransitionSink.reason === 'unbracketed-match'
    ),
  JSON.stringify(oneTransitionSink),
)

const incoherentTrough = decideSourceLatencyCalibration(
  [0, 20, 40, 60, 80, 100, 300, 320, 340, 360, 380].map(
    (latencyMs, index) =>
      sample(
        latencyMs,
        [50, 65, 80, 90, 98, 100, 102, 110, 125, 145, 165][index] ?? 0,
      ),
  ),
  processorRange(0, 400),
)
check(
  'near-minimum samples separated by a decode hole are not one coherent match',
  incoherentTrough.status === 'ambiguous'
    && incoherentTrough.reason === 'incoherent-match-cluster',
  JSON.stringify(incoherentTrough),
)

const bounded = decideSourceLatencyCalibration(
  [
    ...samples(-100, 20, [100, 100, 100]),
    ...samples(20, 20, [40, 62, 82, 96, 100, 106, 120, 143, 166]),
    ...samples(500, 20, [100, 100, 100]),
  ],
  processorRange(0, 240),
)
check(
  'samples outside the declared candidate range cannot win',
  bounded.status === 'measured'
    && bounded.latencyMs === 80
    && bounded.sampleCount === 9,
  JSON.stringify(bounded),
)

const malformedRange = decideSourceLatencyCalibration(
  samples(0, 16, [50, 75, 100, 125, 150]),
  processorRange(200, 100),
)
check(
  'an invalid candidate bound is unavailable rather than guessed',
  malformedRange.status === 'unavailable' && malformedRange.reason === 'invalid-candidate-range',
  JSON.stringify(malformedRange),
)

const nonFinite = decideSourceLatencyCalibration(
  [
    { latencyMs: Number.NaN, delta: 0 },
    { latencyMs: 10, delta: Number.POSITIVE_INFINITY },
  ],
  processorRange(0, 100),
)
check(
  'a calibration with no finite samples is unavailable',
  nonFinite.status === 'unavailable' && nonFinite.reason === 'no-finite-samples',
  JSON.stringify(nonFinite),
)

const shallowCrossSourceTrough = decideSourceLatencyCalibration(
  [
    [-56.554, 18.954],
    [-23.060, 17.992],
    [12.533, 16.894],
    [45.875, 15.729],
    [79.535, 16.574],
    [113.679, 16.657],
    [148.702, 17.822],
    [181.413, 19.419],
  ].map(([latencyMs, delta], index) => ({
    latencyMs: latencyMs ?? 0,
    delta: delta ?? Number.POSITIVE_INFINITY,
    fingerprint: {
      meanLuma: 20 + index * 10,
      darkRatio: 0,
      cells: [20 + index * 10, 21 + index * 10, 19 + index * 10],
    },
  })),
  processorRange(-100, 250),
)
check(
  'a coherent shallow cross-source trough uses its observed frame despite colour-path baseline',
  shallowCrossSourceTrough.status === 'measured'
    && shallowCrossSourceTrough.latencyMs === 45.875,
  JSON.stringify(shallowCrossSourceTrough),
)

const exposureEvidence = {
  status: 'measured',
  method: 'pixel-match',
  sampleSource: 'media-stream-track-processor',
  latencyMs: 56.25,
  qpc: { status: 'measured' },
  pixel: { status: 'measured' },
  reference: {
    source: 'dxgi-desktop-duplication',
    timing: 'pixel-exposure',
  },
}
check(
  'DXGI-to-processor latency alone cannot translate an rVFC replay clock',
  measuredPixelExposureLatencyMs(exposureEvidence) === undefined,
)
const composedExposureEvidence = {
  ...exposureEvidence,
  presentation: {
    status: 'measured',
    method: 'dxgi-processor-rvfc-pixel-join',
    latencyMs: 87.5,
  },
}
check(
  'the fully measured DXGI-processor-rVFC pixel chain translates context time',
  measuredPixelExposureLatencyMs(composedExposureEvidence) === 87.5,
)
check(
  'a measured presentation value without the composed pixel-join method is rejected',
  measuredPixelExposureLatencyMs({
    ...composedExposureEvidence,
    presentation: {
      status: 'measured',
      latencyMs: 87.5,
    },
  }) === undefined,
)
check(
  'GDI completion time cannot pose as desktop pixel exposure',
  measuredPixelExposureLatencyMs({
    ...composedExposureEvidence,
    reference: {
      source: 'windows-gdi-bitblt',
      timing: 'post-bitblt-completion',
    },
  }) === undefined,
)
check(
  'an unproved processor clock cannot translate context time',
  measuredPixelExposureLatencyMs({
    ...composedExposureEvidence,
    qpc: { status: 'ambiguous' },
  }) === undefined,
)
check(
  'presentation-callback diagnostics cannot translate source exposure',
  measuredPixelExposureLatencyMs({
    ...composedExposureEvidence,
    sampleSource: 'video-presentation-callback',
  }) === undefined,
)

const sourcePresentationReference = {
  meanLuma: 100,
  darkRatio: 0.1,
  cells: [100, 101, 99, 100],
}
const sourcePresentationMatch = decideSourcePresentationLatency(
  1_000,
  sourcePresentationReference,
  [
    {
      presentedAtMs: 1_012,
      fingerprint: {
        meanLuma: 180,
        darkRatio: 0,
        cells: [180, 181, 179, 180],
      },
    },
    {
      presentedAtMs: 1_031,
      mediaTimeMs: 531,
      fingerprint: sourcePresentationReference,
    },
    {
      presentedAtMs: 1_064,
      fingerprint: {
        meanLuma: 35,
        darkRatio: 0.25,
        cells: [35, 36, 34, 35],
      },
    },
  ],
)
check(
  'the independent reference joins to one uniquely matching rVFC frame',
  sourcePresentationMatch.status === 'measured'
    && sourcePresentationMatch.latencyMs === 31
    && sourcePresentationMatch.matchedMediaTimeMs === 531
    && sourcePresentationMatch.sourceMediaTimeOriginMs === 469,
  JSON.stringify(sourcePresentationMatch),
)
check(
  'the exact DXGI pixel match calibrates source wall time onto the observed media clock',
  sourcePresentationMatch.status === 'measured'
    && sourcePresentationMatch.sourceMediaTimeOriginMs !== undefined
    && sourcePresentationMatch.sourceMediaTimeOriginMs + 531 === 1_000,
  JSON.stringify(sourcePresentationMatch),
)

const sparsePresentationWitnessMatch = decideSourcePresentationLatency(
  1_000,
  sourcePresentationReference,
  [
    {
      presentedAtMs: 100,
      fingerprint: {
        meanLuma: 180,
        darkRatio: 0,
        cells: [180, 181, 179, 180],
      },
    },
    {
      presentedAtMs: 1_072,
      mediaTimeMs: 572,
      fingerprint: sourcePresentationReference,
    },
    {
      presentedAtMs: 2_200,
      fingerprint: {
        meanLuma: 35,
        darkRatio: 0.25,
        cells: [35, 36, 34, 35],
      },
    },
  ],
)
check(
  'sparse rVFC witnesses outside the claimed latency window can still bracket an exact source match',
  sparsePresentationWitnessMatch.status === 'measured'
    && sparsePresentationWitnessMatch.latencyMs === 72
    && sparsePresentationWitnessMatch.sourceMediaTimeOriginMs === 428,
  JSON.stringify(sparsePresentationWitnessMatch),
)

const preReferencePresentationMatch = decideSourcePresentationLatency(
  1_000,
  sourcePresentationReference,
  [
    {
      presentedAtMs: 100,
      fingerprint: {
        meanLuma: 180,
        darkRatio: 0,
        cells: [180, 181, 179, 180],
      },
    },
    {
      presentedAtMs: 900,
      mediaTimeMs: 400,
      fingerprint: sourcePresentationReference,
    },
    {
      presentedAtMs: 2_200,
      fingerprint: {
        meanLuma: 35,
        darkRatio: 0.25,
        cells: [35, 36, 34, 35],
      },
    },
  ],
)
check(
  'a bracketing witness before the native exposure cannot become a source clock',
  preReferencePresentationMatch.status === 'unavailable'
    && preReferencePresentationMatch.reason === 'invalid-latency',
  JSON.stringify(preReferencePresentationMatch),
)

const repeatedPresentationMatch = decideSourcePresentationLatency(
  1_000,
  sourcePresentationReference,
  [
    {
      presentedAtMs: 1_031,
      fingerprint: sourcePresentationReference,
    },
    {
      presentedAtMs: 1_048,
      fingerprint: {
        meanLuma: 180,
        darkRatio: 0,
        cells: [180, 181, 179, 180],
      },
    },
    {
      presentedAtMs: 1_064,
      fingerprint: sourcePresentationReference,
    },
  ],
)
check(
  'two indistinguishable rVFC frames remain ambiguous',
  repeatedPresentationMatch.status === 'ambiguous'
    && repeatedPresentationMatch.reason === 'weak-pixel-match',
  JSON.stringify(repeatedPresentationMatch),
)

const singlePresentationSample = decideSourcePresentationLatency(
  1_000,
  sourcePresentationReference,
  [
    {
      presentedAtMs: 1_031,
      fingerprint: sourcePresentationReference,
    },
  ],
)
check(
  'one rVFC witness is insufficient to claim a source presentation latency',
  singlePresentationSample.status === 'ambiguous'
    && singlePresentationSample.reason === 'insufficient-samples',
  JSON.stringify(singlePresentationSample),
)

function bridgeFingerprint(value: number, cellCount = 4) {
  return {
    meanLuma: value,
    darkRatio: value < 24 ? 1 : 0,
    cells: Array.from({ length: cellCount }, (_unused, index) =>
      value + (index % 2),
    ),
  }
}

const bridgeFrames = [20, 80, 140, 200].map((value) =>
  bridgeFingerprint(value),
)
const measuredProcessorPresentation = decideProcessorPresentationLatency(
  bridgeFrames.map((fingerprint, index) => ({
    processorAtMs: [1_000, 1_033, 1_067, 1_100][index] ?? 0,
    fingerprint,
  })),
  bridgeFrames.map((fingerprint, index) => ({
    presentedAtMs: [1_048, 1_081, 1_115, 1_148][index] ?? 0,
    fingerprint,
  })),
)
check(
  'processor and rVFC same-pixel observations measure a 48ms bridge without an FPS correction',
  measuredProcessorPresentation.status === 'measured'
    && measuredProcessorPresentation.latencyMs === 48
    && measuredProcessorPresentation.matchedPairCount === 4
    && measuredProcessorPresentation.dispersionMs === 0
    && measuredProcessorPresentation.matches.every(
      (match) =>
        match.processorIndex === match.presentedIndex
        && match.latencyMs === 48,
    ),
  JSON.stringify(measuredProcessorPresentation),
)

const repeatedBridgeFingerprint = decideProcessorPresentationLatency(
  [bridgeFrames[0], bridgeFrames[0], bridgeFrames[1], bridgeFrames[2]].map(
    (fingerprint, index) => ({
      processorAtMs: 2_000 + index * 30,
      fingerprint: fingerprint ?? bridgeFingerprint(0),
    }),
  ),
  [bridgeFrames[0], bridgeFrames[1], bridgeFrames[2]].map(
    (fingerprint, index) => ({
      presentedAtMs: 2_048 + index * 30,
      fingerprint: fingerprint ?? bridgeFingerprint(0),
    }),
  ),
)
check(
  'a repeated processor fingerprint cannot create a non-unique bridge',
  repeatedBridgeFingerprint.status === 'ambiguous'
    && repeatedBridgeFingerprint.reason === 'non-unique-pixel-match'
    && repeatedBridgeFingerprint.matchedPairCount === 2,
  JSON.stringify(repeatedBridgeFingerprint),
)

const reverseBridgeOrder = decideProcessorPresentationLatency(
  bridgeFrames.slice(0, 3).map((fingerprint, index) => ({
    processorAtMs: 3_000 + index * 30,
    fingerprint,
  })),
  [...bridgeFrames.slice(0, 3)].reverse().map((fingerprint, index) => ({
    presentedAtMs: 3_048 + index * 30,
    fingerprint,
  })),
)
check(
  'unique pixels observed in reverse processor order remain ambiguous',
  reverseBridgeOrder.status === 'ambiguous'
    && reverseBridgeOrder.reason === 'non-monotonic-match-order',
  JSON.stringify(reverseBridgeOrder),
)

const oneBridgeMatch = decideProcessorPresentationLatency(
  bridgeFrames.slice(0, 3).map((fingerprint, index) => ({
    processorAtMs: 4_000 + index * 30,
    fingerprint,
  })),
  [bridgeFrames[0], bridgeFingerprint(230), bridgeFingerprint(255)].map(
    (fingerprint, index) => ({
      presentedAtMs: 4_048 + index * 30,
      fingerprint: fingerprint ?? bridgeFingerprint(0),
    }),
  ),
)
check(
  'one same-pixel processor/rVFC pair is insufficient evidence',
  oneBridgeMatch.status === 'ambiguous'
    && oneBridgeMatch.reason === 'insufficient-matches'
    && oneBridgeMatch.matchedPairCount === 1,
  JSON.stringify(oneBridgeMatch),
)

const bridgeShapeMismatch = decideProcessorPresentationLatency(
  bridgeFrames.slice(0, 3).map((fingerprint, index) => ({
    processorAtMs: 5_000 + index * 30,
    fingerprint,
  })),
  [20, 80, 140].map((value, index) => ({
    presentedAtMs: 5_048 + index * 30,
    fingerprint: bridgeFingerprint(value, 3),
  })),
)
check(
  'processor/rVFC fingerprints with different shapes are never compared as pixels',
  bridgeShapeMismatch.status === 'ambiguous'
    && bridgeShapeMismatch.reason === 'fingerprint-shape-mismatch',
  JSON.stringify(bridgeShapeMismatch),
)

const excessiveBridgeSpread = decideProcessorPresentationLatency(
  bridgeFrames.slice(0, 3).map((fingerprint, index) => ({
    processorAtMs: 6_000 + index * 30,
    fingerprint,
  })),
  bridgeFrames.slice(0, 3).map((fingerprint, index) => ({
    presentedAtMs: [6_048, 6_108, 6_178][index] ?? 0,
    fingerprint,
  })),
)
check(
  'bridge offset spread cannot exceed the actually observed processor spacing',
  excessiveBridgeSpread.status === 'ambiguous'
    && excessiveBridgeSpread.reason === 'excessive-offset-dispersion'
    && excessiveBridgeSpread.dispersionMs === 70
    && excessiveBridgeSpread.observedProcessorSpacingMs === 30,
  JSON.stringify(excessiveBridgeSpread),
)

const directOneSidedMatch = decideSourcePresentationLatency(
  7_000,
  bridgeFrames[0] ?? bridgeFingerprint(0),
  bridgeFrames.slice(0, 3).map((fingerprint, index) => ({
    presentedAtMs: 7_048 + index * 30,
    fingerprint,
  })),
)
check(
  'a direct source match without observed motion on both sides is rejected',
  directOneSidedMatch.status === 'ambiguous'
    && directOneSidedMatch.reason === 'unbracketed-match',
  JSON.stringify(directOneSidedMatch),
)

const directRepeatedVisit = decideSourcePresentationLatency(
  8_000,
  bridgeFrames[0] ?? bridgeFingerprint(0),
  [
    bridgeFrames[0],
    bridgeFrames[1],
    bridgeFrames[0],
    bridgeFrames[2],
  ].map((fingerprint, index) => ({
    presentedAtMs: 8_048 + index * 30,
    fingerprint: fingerprint ?? bridgeFingerprint(0),
  })),
)
check(
  'a direct source fingerprint visited twice is not a unique presentation match',
  directRepeatedVisit.status === 'ambiguous'
    && directRepeatedVisit.reason === 'weak-pixel-match',
  JSON.stringify(directRepeatedVisit),
)

const directShapeMismatch = decideSourcePresentationLatency(
  9_000,
  bridgeFingerprint(20, 4),
  [20, 80, 140].map((value, index) => ({
    presentedAtMs: 9_048 + index * 30,
    fingerprint: bridgeFingerprint(value, 3),
  })),
)
check(
  'a direct source/presentation shape mismatch remains ambiguous',
  directShapeMismatch.status === 'ambiguous'
    && directShapeMismatch.reason === 'fingerprint-shape-mismatch',
  JSON.stringify(directShapeMismatch),
)

check(
  'source-to-processor latency never retimes the independently muxed replay clock',
  alignReplayOriginToMeasuredPixels(10_000, {
    ...fifteenFpsTrough,
    status: 'measured',
    reason: 'measured',
    latencyMs: 145,
  }) === 10_000,
)

check(
  'an ambiguous calibration cannot silently retime a replay',
  alignReplayOriginToMeasuredPixels(10_000, {
    ...fifteenFpsTrough,
    status: 'ambiguous',
    reason: 'weak-match-contrast',
    latencyMs: 145,
  }) === 10_000,
)

check(
  'an unavailable calibration cannot silently retime a replay',
  alignReplayOriginToMeasuredPixels(10_000, {
    status: 'unavailable',
    reason: 'probe-failed',
    sampleSource: 'media-stream-track-processor',
    sampleCount: 0,
    latencyMs: 145,
  }) === 10_000,
)

check(
  'an invalid measured latency cannot move replay time zero',
  alignReplayOriginToMeasuredPixels(10_000, {
    ...fifteenFpsTrough,
    status: 'measured',
    reason: 'measured',
    latencyMs: -1,
  }) === 10_000,
)

check(
  'a non-finite measured latency cannot move replay time zero',
  alignReplayOriginToMeasuredPixels(10_000, {
    status: 'measured',
    reason: 'measured',
    sampleSource: 'media-stream-track-processor',
    sampleCount: 10,
    latencyMs: Number.NaN,
  }) === 10_000,
)


// THE ONE MEASUREMENT THAT ONLY LUCK PRODUCES IS REMEMBERED (#115).
//
// Calibration runs once per capture, inside the startup observation window
// and never inside retained replay - the call site refuses to tax the
// recorder for it, and this session measured why: a second sink cost its
// display 14.8 fps against 10.1. So there is no retry to add. What there is,
// is a measurement that succeeds only when the desk happened to move during
// those two seconds and was then thrown away. Every capture in this
// machine's log before 2026-07-31 19:54 reported no-motion-witness or
// insufficient-motion-transitions; the one that succeeded measured 37.69 ms
// on display 1 at 0.92 confidence, and the focused display still measured
// nothing.
console.log('\nA measured source latency outlives the capture that found it')
{
  const main = readFileSync(
    path.join(process.cwd(), 'src/main/capture.ts'),
    'utf8',
  )
  check(
    'main keeps the last measured latency per display',
    main.includes('const displaySourceLatency = new Map<number, RememberedSourceLatency>()')
      && main.includes('export function recorderSourceLatency('),
  )
  check(
    'only a measured result is remembered',
    main.includes("if (c.status === 'measured' && typeof c.latencyMs === 'number')"),
  )
  check(
    'an ambiguous result reports what is remembered instead of nothing',
    main.includes('source latency not measured now;')
      && main.includes('last measured '),
  )
  check(
    'a backend change voids it, because that is a different path to the glass',
    main.includes('displaySourceLatency.delete(displayId)')
      && main.includes('remembered.backend !== backend'),
  )
  check(
    'a display that goes away takes its measurement with it',
    main.includes('if (!wantedDisplayIds.has(id)) displaySourceLatency.delete(id)'),
  )
  // The constraint that rules a retry out, so a later reader does not add one
  // without meeting the cost this codebase already refused.
  const renderer = readFileSync(
    path.join(process.cwd(), 'src/renderer/capture/capture.ts'),
    'utf8',
  )
  check(
    'calibration still runs only inside the startup observation window',
    renderer.includes('never inside retained replay')
      && renderer.includes('minimumObservationMs > 0'),
  )
}
console.log(`\nsource latency calibration checks: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
