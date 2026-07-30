import { readFileSync } from 'node:fs'
import {
  measuredFrameTimelineAcrossRotations,
  measureEncodedPtsContextAlignment,
  nearestObservedSample,
  type TemporalAlignmentInput,
} from '../src/shared/temporalAlignment'
import { trackedSampleAt } from '../src/shared/track'
import type { Annotation } from '../src/shared/types'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) passed += 1
  else failed += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

function close(actual: number | undefined, expected: number, epsilon = 1e-6): boolean {
  return actual !== undefined && Math.abs(actual - expected) <= epsilon
}

// ---------------------------------------------------------------------------
// Saved MP4/WebM PTS -> pack clock -> nearest observed context sample.
// These are format-shaped fixtures (fractional MP4 timescale, integral WebM
// milliseconds); the helper deliberately does not care which muxer produced
// them.
// ---------------------------------------------------------------------------

const mediaFixtures: Array<{
  name: string
  input: TemporalAlignmentInput
}> = [
  {
    name: 'MP4',
    input: {
      encodedPtsMs: [17, 50.367, 83.733],
      replayClockOffsetMs: 17,
      contextSampleTimesMs: [0, 33.367, 66.733],
    },
  },
  {
    name: 'WebM',
    input: {
      encodedPtsMs: [12, 45, 78],
      replayClockOffsetMs: 12,
      contextSampleTimesMs: [0, 33, 66],
    },
  },
]

for (const fixture of mediaFixtures) {
  const report = measureEncodedPtsContextAlignment(fixture.input)
  check(
    `${fixture.name} PTS uses the measured display offset on the pack clock`,
    report.status === 'measured'
      && report.frameCount === 3
      && report.comparedFrameCount === 3
      && report.distribution?.maxMs !== undefined
      && close(report.distribution.maxMs, 0),
    JSON.stringify(report),
  )
}

const distribution = measureEncodedPtsContextAlignment({
  encodedPtsMs: [100, 200, 300, 400, 500],
  replayClockOffsetMs: 0,
  contextSampleTimesMs: [0, 98, 204, 290, 430, 505, 600],
})
check(
  'nearest error distribution reports p50/p95/max and signed bias',
  distribution.distribution?.p50Ms === 5
    && distribution.distribution.p95Ms === 30
    && distribution.distribution.maxMs === 30
    && close(distribution.distribution.signedBiasMs, 5.4),
  JSON.stringify(distribution.distribution),
)

const uncovered = measureEncodedPtsContextAlignment({
  encodedPtsMs: [0, 100, 200, 300],
  replayClockOffsetMs: 0,
  contextSampleTimesMs: [90, 200, 250],
})
check(
  'frames outside the observed context range are coverage gaps, not drift',
  uncovered.status === 'measured'
    && uncovered.frameCount === 4
    && uncovered.comparedFrameCount === 2
    && uncovered.outsideContextRangeFrameCount === 2,
  JSON.stringify(uncovered),
)

const visibleBias = measureEncodedPtsContextAlignment({
  encodedPtsMs: [100, 200, 300],
  replayClockOffsetMs: 0,
  contextSampleTimesMs: [0, 130, 230, 330, 500],
})
check(
  'a constant 30 ms mismatch remains visible instead of being corrected away',
  visibleBias.distribution?.p50Ms === 30
    && visibleBias.distribution.maxMs === 30
    && visibleBias.distribution.signedBiasMs === 30,
  JSON.stringify(visibleBias.distribution),
)

// ---------------------------------------------------------------------------
// Rotation: generation-local PTS is put on the common measured origin axis.
// ---------------------------------------------------------------------------

const rotated = measuredFrameTimelineAcrossRotations(
  [
    { originMs: 100_000, ptsMs: [0, 33, 66, 99] },
    { originMs: 100_100, ptsMs: [0, 33, 66] },
  ],
  100_000,
)
check(
  'measured recorder origins keep PTS monotonic across a rotation',
  rotated.monotonic
    && rotated.regressionCount === 0
    && rotated.packPtsMs.join(',') === '0,33,66,99,100,133,166',
  JSON.stringify(rotated),
)
check(
  'rotation uses the observed origin rather than a configured segment duration',
  rotated.packPtsMs[4] === 100,
)

const regressedRotation = measuredFrameTimelineAcrossRotations(
  [
    { originMs: 100_000, ptsMs: [0, 33, 66, 99] },
    { originMs: 100_080, ptsMs: [0, 33, 66] },
  ],
  100_000,
)
check(
  'an overlapping recorder generation fails instead of hiding a backward PTS',
  !regressedRotation.monotonic && regressedRotation.regressionCount === 1,
  JSON.stringify(regressedRotation),
)

const malformedPts = measureEncodedPtsContextAlignment({
  encodedPtsMs: [0, 40, 20],
  replayClockOffsetMs: 0,
  contextSampleTimesMs: [0, 20, 40],
})
check(
  'a saved replay with regressing PTS is invalid',
  malformedPts.status === 'invalid'
    && !malformedPts.monotonic
    && malformedPts.regressionCount === 1,
  JSON.stringify(malformedPts),
)

// ---------------------------------------------------------------------------
// N displays: independent offsets, one failed recorder, exact reopen.
// ---------------------------------------------------------------------------

const threeDisplayInputs = [
  {
    display: 1,
    input: {
      encodedPtsMs: [63, 163, 263],
      replayClockOffsetMs: -37,
      contextSampleTimesMs: [0, 100, 200, 300, 400],
    } satisfies TemporalAlignmentInput,
  },
  {
    display: 2,
    input: {
      encodedPtsMs: null,
      replayClockOffsetMs: undefined,
      contextSampleTimesMs: [0, 100, 200, 300, 400],
    } satisfies TemporalAlignmentInput,
  },
  {
    display: 3,
    input: {
      encodedPtsMs: [100, 200, 300],
      replayClockOffsetMs: 0,
      contextSampleTimesMs: [0, 100, 200, 300, 400],
    } satisfies TemporalAlignmentInput,
  },
]
const firstOpen = threeDisplayInputs.map(({ display, input }) => ({
  display,
  report: measureEncodedPtsContextAlignment(input),
}))
const reopenedInputs = JSON.parse(JSON.stringify(threeDisplayInputs)) as typeof threeDisplayInputs
const secondOpen = reopenedInputs.map(({ display, input }) => ({
  display,
  report: measureEncodedPtsContextAlignment(input),
}))
check(
  'focus 3 and display 1 retain independent measured offsets',
  firstOpen[0]?.report.distribution?.maxMs === 0
    && firstOpen[2]?.report.distribution?.maxMs === 0,
  JSON.stringify(firstOpen),
)
check(
  'one failed display remains replay-less without invalidating healthy peers',
  firstOpen[1]?.report.status === 'no-replay'
    && firstOpen[0]?.report.status === 'measured'
    && firstOpen[2]?.report.status === 'measured',
)
check(
  'saved offsets and alignment are byte-equivalent after close and reopen',
  JSON.stringify(firstOpen) === JSON.stringify(secondOpen),
)

const dishonestFailedDisplay = measureEncodedPtsContextAlignment({
  encodedPtsMs: null,
  replayClockOffsetMs: 84,
  contextSampleTimesMs: [0, 100],
})
check(
  'a failed recorder cannot retain a phantom replay clock offset',
  dishonestFailedDisplay.status === 'invalid',
  JSON.stringify(dishonestFailedDisplay),
)

// ---------------------------------------------------------------------------
// Historical object tracks: nearest observation, unchanged, earlier on tie.
// ---------------------------------------------------------------------------

const tracked: Annotation = {
  annotation_id: 'ann_abc123',
  type: 'box',
  bounds: { x: 10, y: 20, width: 30, height: 40 },
  display: 1,
  text: 'observed object',
  numbered: true,
  blur: false,
  tracking: {
    enabled: true,
    samples: [
      { t_ms: 100, x: 10, y: 20, width: 30, height: 40 },
      { t_ms: 300, display: 3, x: 610, y: 220, width: 50, height: 60 },
    ],
  },
  created_at: '2026-07-30T00:00:00.000Z',
  z: 1,
}
const pastTie = trackedSampleAt(tracked, 200)
const pastNearLater = trackedSampleAt(tracked, 260)
check(
  'past object lookup returns the earlier recorded rectangle on an exact tie',
  pastTie === tracked.tracking.samples?.[0]
    && pastTie?.x === 10
    && pastTie.display === undefined,
)
check(
  'past object lookup crosses displays using the nearest observed sample unchanged',
  pastNearLater === tracked.tracking.samples?.[1]
    && pastNearLater?.display === 3
    && pastNearLater.x === 610,
)
check(
  'past object lookup never invents the midpoint rectangle',
  pastTie?.x !== 310 && pastTie?.width !== 40,
)

const observedValues = [
  { tMs: 100, value: { display: 1, x: 10 } },
  { tMs: 300, value: { display: 3, x: 610 } },
]
check(
  'generic nearest lookup returns the original persisted sample object',
  nearestObservedSample(observedValues, 200) === observedValues[0],
)

const reopenedTracked = JSON.parse(JSON.stringify(tracked)) as Annotation
check(
  'tracked sample time/display/rectangle survive serialization and reopen',
  JSON.stringify(trackedSampleAt(reopenedTracked, 200)) === JSON.stringify(pastTie)
    && JSON.stringify(trackedSampleAt(reopenedTracked, 260)) === JSON.stringify(pastNearLater),
)

// Guard the central rule against a future "temporary" fixed/FPS adjustment.
// Source latency is allowed to move the recorder origin only through the
// separately tested observation-backed decision.
const helperSource = readFileSync('src/shared/temporalAlignment.ts', 'utf8')
check(
  'alignment helper has no configurable or fixed latency correction path',
  !/correctionMs|latencyAllowanceMs|FIXED_OFFSET/i.test(helperSource)
    && helperSource.includes('encodedPts - offsetMs'),
)

const captureSource = readFileSync('src/renderer/capture/capture.ts', 'utf8')
check(
  'replay origin comes only from same-frame decoded PTS/presentation evidence',
  captureSource.includes('measureReplayPixelClock(')
    && captureSource.includes("clock.status === 'measured'")
    && !captureSource.includes('alignReplayOriginToMeasuredPixels(')
    && !/sourceLatencyCalibration[^;\n]*originMs|originMs[^;\n]*sourceLatencyCalibration/.test(
      captureSource,
    )
    && !/originMs\s*[+-]=|originMs\s*=\s*[^;\n]*(?:30|1_?000\s*\/\s*payload\.fps)/.test(
      captureSource,
  ),
)
const sourceClockStart = captureSource.indexOf(
  'function measuredReplaySourceClockAnchors(',
)
const sourceClockEnd = captureSource.indexOf(
  'async function handleReplayRequest(',
  sourceClockStart,
)
const sourceClockSource = captureSource.slice(sourceClockStart, sourceClockEnd)
check(
  'source clock uses the DXGI-calibrated media axis, never one startup latency subtraction',
  sourceClockStart >= 0
    && sourceClockEnd > sourceClockStart
    && sourceClockSource.includes('sourceClockAnchorsFromMeasuredMediaTime(')
    && !sourceClockSource.includes('measuredPixelExposureLatencyMs(')
    && !sourceClockSource.includes('presentedAtMs -'),
)
check(
  'observed getDisplayMedia captureTime is preferred as the same-frame source clock',
  sourceClockSource.includes('sourceClockAnchorsFromObservedCaptureTime(')
    && captureSource.includes('capturedAtMs: wallComparableTimeMs(')
    && captureSource.includes('metadata.captureTime,'),
)
check(
  'readiness hands the exact calibrated video sink to the long-running tick chain',
  captureSource.includes('clockVideo: video')
    && captureSource.includes('startFrameTicks(startupReadiness?.clockVideo)')
    && captureSource.includes('preparedVideo?.srcObject === active'),
)

const seekStart = captureSource.indexOf('function seekReplayPresentation(')
const seekEnd = captureSource.indexOf(
  'async function decodeReplayPixelClockSamples(',
  seekStart,
)
const seekSource = captureSource.slice(seekStart, seekEnd)
check(
  'replay pixel decoder uses declared fMP4 PTS and seeked pixels without playback',
  seekStart >= 0
    && seekEnd > seekStart
    && captureSource.includes('enumerateFmp4VideoSamples(buffer)')
    && captureSource.includes('const ptsMs = target.presentationTimeMs')
    && seekSource.includes("video.addEventListener('seeked'")
    && !seekSource.includes('requestVideoFrameCallback(')
    && !seekSource.includes('video.play()'),
)
const decodeStart = captureSource.indexOf(
  'async function decodeReplayPixelClockSamples(',
)
const decodeEnd = captureSource.indexOf(
  'async function measureReplayPixelClock(',
  decodeStart,
)
const decodeSource = captureSource.slice(decodeStart, decodeEnd)
check(
  'measured pixel-clock decoding still covers the full retained replay',
  decodeStart >= 0
    && decodeEnd > decodeStart
    && decodeSource.includes('for (const target of targets)')
    && !decodeSource.includes('decideReplayPixelClock(presented, decoded)'),
)
const targetStart = captureSource.indexOf(
  'function replayPixelClockTargets(',
)
const targetEnd = captureSource.indexOf(
  'function waitForReplayMetadata(',
  targetStart,
)
const targetSource = captureSource.slice(targetStart, targetEnd)
check(
  'pixel-clock decoding searches three declared neighbouring samples for normal encoder drift',
  targetStart >= 0
    && targetEnd > targetStart
    && captureSource.includes(
      'const REPLAY_PIXEL_CLOCK_DECODE_SAMPLE_LIMIT = 64',
    )
    && targetSource.includes(
      'for (const sampleOffset of [0, -1, 1, -2, 2, -3, 3])',
    ),
)

const captureHtml = readFileSync('src/renderer/capture/capture.html', 'utf8')
check(
  'capture renderer permits only its local and in-memory replay media',
  /media-src\s+'self'\s+blob:/.test(captureHtml)
    && !/media-src[^"]*https?:/i.test(captureHtml),
)

const sessionSource = readFileSync('src/main/session.ts', 'utf8')
check(
  'DOM save and editor conversion use the observed inverse replay clock',
  sessionSource.match(
    /frozenPackTimeAt\(contextFreezeId,\s*e\.tMs\)/g,
  )?.length === 2
    && !sessionSource.includes('e.tMs - domWindow.startMs'),
)

// THE TERMS THAT MOVE A SAMPLE IN TIME MUST BE PRINTED (#89).
//
// Three numbers decide how much of the reported lead each stage owns, all three
// have been measured since the frame clock landed, and none of them was ever
// written down: `frameClockOffsetMs`, which is subtracted from every converted
// sample and is the ~90% majority path; the lane's dropped-sample count; and the
// memory governor's stride, which silently coarsens the ring under the answer.
// Without them every question about #89 is settled by argument instead of by
// reading a log line.
const runtimeSource = readFileSync('src/main/context/runtime.ts', 'utf8')
const costStart = runtimeSource.indexOf('export function logContextCost(')
const costEnd = runtimeSource.indexOf('function sessionTimeOf(', costStart)
const costSource = runtimeSource.slice(costStart, costEnd)
check(
  'the lane cost line reports the frame-clock offset, dropped samples and stride',
  costStart >= 0
    && costEnd > costStart
    && costSource.includes('frame->core')
    && costSource.includes('lane.frameClockOffsetMs')
    && costSource.includes('lane.droppedSamples')
    && costSource.includes('status.timeline.stride'),
)

const laneSource = readFileSync('src/main/context/surfaceLane.ts', 'utf8')
check(
  'the lane publishes the frame-clock offset it applies',
  laneSource.includes('frameClockOffsetMs: number | null')
    && laneSource.includes('frameClockOffsetMs: this.frameClockOffsetMs'),
)

console.log(`\nresult: ${failed === 0 ? 'OK' : 'FAILED'} — ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
