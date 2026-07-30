import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createReplayHealthState,
  fingerprintRgba,
  markReplayHealthProbe,
  nativeProbeConfirmsFailure,
  observePrimaryFingerprint,
  PrimaryReadiness,
  retainMeaningfulFingerprint,
  SUSTAINED_BLACK_MS,
  SUSTAINED_IDENTICAL_MS,
} from '../src/renderer/capture/replayHealth'

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

function solid(value: number): Uint8ClampedArray {
  const bytes = new Uint8ClampedArray(64 * 36 * 4)
  for (let index = 0; index < bytes.length; index += 4) {
    bytes[index] = value
    bytes[index + 1] = value
    bytes[index + 2] = value
    bytes[index + 3] = 255
  }
  return bytes
}

const black = fingerprintRgba(solid(0), 64, 36)
const gray = fingerprintRgba(solid(96), 64, 36)
const white = fingerprintRgba(solid(240), 64, 36)

console.log('Primary presentation readiness')
{
  const ready = new PrimaryReadiness()
  check('one observed presentation does not construct a recorder yet', !ready.observe(100))
  check('a duplicate PTS is not a second frame', !ready.observe(100))
  check('two increasing PTS values complete frame evidence', ready.observe(166))
  check('the observed presentation span is measured', ready.observedSpanMs() === 66)
  check(
    'the first recorder is still excluded at 1999ms',
    !ready.canStart(1_999, 0, 2_000),
  )
  check(
    'the first recorder starts at 2s only with two measured frames',
    ready.canStart(2_000, 0, 2_000),
  )
  check(
    'a later stream reacquisition does not repeat the startup sleep',
    ready.canStart(166, 0, 0),
  )
}
{
  const staticSource = new PrimaryReadiness()
  staticSource.observe(100)
  check(
    'one real frame is accepted only at the bounded static-source deadline',
    !staticSource.canStart(1_999, 0, 2_000) &&
      staticSource.canStartAtDeadline(),
  )
  check(
    'elapsed time without a presented frame is never readiness',
    !new PrimaryReadiness().canStartAtDeadline(),
  )
}

console.log('\nBlack and frozen cross-validation')
{
  let retained = retainMeaningfulFingerprint(null, white)
  retained = retainMeaningfulFingerprint(retained, black)
  const state = createReplayHealthState(retained ?? black)
  observePrimaryFingerprint(state, black, 1_000)
  const suspicion = observePrimaryFingerprint(
    state,
    black,
    1_000 + SUSTAINED_BLACK_MS,
  )
  check(
    'warmup meaningful frame 1 survives black frame 2 and arms the watchdog',
    suspicion === 'meaningful-then-black',
  )
}
{
  const state = createReplayHealthState(white)
  let suspicion = observePrimaryFingerprint(state, black, 1_000)
  check('one black sample after content is not condemned', suspicion === null)
  suspicion = observePrimaryFingerprint(
    state,
    black,
    1_000 + SUSTAINED_BLACK_MS,
  )
  check(
    'meaningful content followed by sustained black becomes suspicious',
    suspicion === 'meaningful-then-black',
  )
  check(
    'GDI meaningful pixels confirm Chromium black failure',
    suspicion !== null &&
      nativeProbeConfirmsFailure(suspicion, black, white),
  )
  check(
    'a legitimately black GDI desktop rejects the fallback verdict',
    suspicion !== null &&
      !nativeProbeConfirmsFailure(suspicion, black, black),
  )
}
{
  const state = createReplayHealthState(black)
  let suspicion = null
  for (let now = 4_000; now <= 24_000; now += 4_000) {
    suspicion = observePrimaryFingerprint(state, black, now)
  }
  check(
    'an always-black source is never called meaningful-then-black',
    suspicion === 'unchanged-too-long',
  )
  check(
    'identical native black pixels preserve an intentionally black screen',
    suspicion !== null &&
      !nativeProbeConfirmsFailure(suspicion, black, black),
  )
}
{
  const state = createReplayHealthState(gray)
  let suspicion = null
  for (let now = 4_000; now <= SUSTAINED_IDENTICAL_MS + 4_000; now += 4_000) {
    suspicion = observePrimaryFingerprint(state, gray, now)
  }
  check('a static desktop is only a suspicion', suspicion === 'unchanged-too-long')
  check(
    'matching native pixels reject a static-desktop false positive',
    suspicion !== null &&
      !nativeProbeConfirmsFailure(suspicion, gray, gray),
  )
  check(
    'one different native sample cannot condemn a possibly static desktop',
    suspicion !== null &&
      !nativeProbeConfirmsFailure(suspicion, gray, white),
  )
  markReplayHealthProbe(state, SUSTAINED_IDENTICAL_MS + 4_000)
  check(
    'an inconclusive probe enters a long cooldown',
    observePrimaryFingerprint(
      state,
      gray,
      SUSTAINED_IDENTICAL_MS + 8_000,
    ) === null,
  )
}
{
  // Delivered callbacks may continue over a black compositor surface. Pixel
  // evidence remains independent from that counter and still reaches a probe.
  const state = createReplayHealthState(white)
  let deliveredFrames = 100
  observePrimaryFingerprint(state, black, 1_000)
  deliveredFrames += 60
  const suspicion = observePrimaryFingerprint(
    state,
    black,
    1_000 + SUSTAINED_BLACK_MS,
  )
  check(
    'growing pixel callbacks cannot mask sustained black pixels',
    deliveredFrames === 160 && suspicion === 'meaningful-then-black',
  )
}

console.log('\nProduction wiring')
{
  const source = readFileSync(
    join(process.cwd(), 'src', 'renderer', 'capture', 'capture.ts'),
    'utf8',
  )
  const readinessCall = source.lastIndexOf('waitForPrimaryReadiness(')
  const gateBeforeRecorder =
    readinessCall >= 0 &&
    source.indexOf('beginInstalledRecording(', readinessCall) > readinessCall
  check('primary source readiness gates recorder construction', gateBeforeRecorder)
  check(
    'teardown cancels an in-flight readiness timer',
    source.includes('primaryReadinessCancel?.()'),
  )
  check(
    'the two-second startup observation is renderer-lifetime one-shot',
    source.includes('primaryStartupObservationAttempted') &&
      source.includes('? 0') &&
      source.includes(': PRIMARY_STARTUP_OBSERVATION_MS'),
  )
  check(
    'production records the measured excluded startup interval',
    source.includes('excluded-before-recorder='),
  )
  const installStart = source.indexOf('function installRecordingStream(')
  const installEnd = source.indexOf(
    'function beginInstalledRecording(',
    installStart,
  )
  const installSource = source.slice(installStart, installEnd)
  check(
    'source-latency calibration spends clone setup inside first-start readiness exclusion',
    installSource.indexOf('const readiness = waitForPrimaryReadiness(') >= 0 &&
      installSource.indexOf('startChromiumSourceLatencyCalibration(') <
        installSource.indexOf('const readiness = waitForPrimaryReadiness(') &&
      installSource.indexOf('startChromiumSourceLatencyCalibration(') <
        installSource.indexOf('beginInstalledRecording(') &&
      installSource.includes('minimumObservationMs > 0'),
  )
  check(
    'readiness cancels a slow sampler before constructing the recorder',
    installSource.indexOf('closeCalibrationWindow()') >= 0 &&
      installSource.indexOf('closeCalibrationWindow()') <
        installSource.indexOf('beginInstalledRecording(') &&
      installSource.includes('cancelCalibration?.()'),
  )
  check(
    'teardown cancels source-latency sampling without awaiting it',
    source.includes('sourceLatencyCalibrationCancel?.()') &&
      source.includes('sourceLatencyCalibrationCancel = null'),
  )
  check(
    'late native calibration acquisition is bounded and stopped on arrival',
    source.includes('SOURCE_LATENCY_NATIVE_START_TIMEOUT_MS') &&
      source.includes('void operation.then(') &&
      source.includes(
        '(late) => window.captureBridge.stopNativeFallback(late.sessionId)',
      ),
  )
  check(
    'async calibration survives in replay diagnostics without delaying ready',
    source.includes('{ sourceLatencyCalibration }') &&
      source.includes('ringDiagnostics = {'),
  )
  const sampleStart = source.indexOf(
    'async function samplePrimaryFingerprint(',
  )
  const sampleEnd = source.indexOf(
    'async function fingerprintNativeJpeg(',
    sampleStart,
  )
  const sampleSource = source.slice(sampleStart, sampleEnd)
  check(
    'pixel-health fallback uses only the existing bounded presentation sink',
    sampleSource.includes('tickVideo !== null') &&
      sampleSource.includes('return fingerprintDrawable(tickVideo)') &&
      !sampleSource.includes('new Constructor(track)'),
  )
  const processorStart = source.indexOf(
    'function startPrimaryTrackProcessorSampler(',
  )
  const processorEnd = source.indexOf(
    'async function samplePrimaryFingerprint(',
    processorStart,
  )
  const processorSource = source.slice(processorStart, processorEnd)
  check(
    'source-latency sampling feature-detects a raw track processor and owns a clone',
    processorSource.includes('trackProcessorConstructor()') &&
      processorSource.includes('sourceTrack.clone()') &&
      processorSource.includes(
        'new Constructor({ track: sampleTrack, maxBufferSize: 1 })',
      ),
  )
  check(
    'latency matching uses the bounded 128x72 compact RGB signature',
    source.includes('SOURCE_LATENCY_FINGERPRINT_WIDTH,') &&
      source.includes('SOURCE_LATENCY_FINGERPRINT_HEIGHT,') &&
      source.includes('SOURCE_LATENCY_RETAINED_SAMPLE_LIMIT,') &&
      source.includes('buildSourceLatencyFingerprint(') &&
      source.includes(
        'samples.length > SOURCE_LATENCY_RETAINED_SAMPLE_LIMIT',
      ) &&
      processorSource.includes(
        'fingerprint: sourceLatencyFingerprintDrawable(frame)',
      ) &&
      source.includes('width: SOURCE_LATENCY_FINGERPRINT_WIDTH') &&
      source.includes('height: SOURCE_LATENCY_FINGERPRINT_HEIGHT'),
  )
  const redLuma = (54 * 255) >> 8
  const nearIsoLumaGreen = (183 * 75) >> 8
  check(
    'RGB calibration distinguishes colours that the health luma signature nearly aliases',
    Math.abs(redLuma - nearIsoLumaGreen) <= 1 &&
      (Math.abs(255 - 0) + Math.abs(0 - 75) + Math.abs(0 - 0)) / 3 >
        100,
  )
  check(
    'native reference and presentation fallback use the same RGB calibration signature',
    source.includes(
      'return sourceLatencyFingerprintDrawable(bitmap)',
    ) &&
      source.includes(
        'return sourceLatencyFingerprintDrawable(tickVideo)',
      ),
  )
  check(
    'processor sampling closes direct and late VideoFrames',
    processorSource.includes('frame.close()') &&
      processorSource.includes('lateRead.then(closeReadResult'),
  )
  check(
    'processor timestamp is retained but requires explicit Windows QPC proof',
    processorSource.includes('frameTimestampUs: frame.timestamp') &&
      source.includes('decideProcessorQpcDeliveryLatency(') &&
      source.includes(
        '{ clockEvidence: qpcAnchor.clockEvidence }',
      ) &&
      source.includes('mapProcessorFrameEpochMs(') &&
      source.includes('nativeQpcBracketed') &&
      source.includes('timestampSpanMs') &&
      source.includes('observedSpanMs'),
  )
  check(
    'processor sampling has read and cleanup bounds plus generation guards',
    processorSource.includes('SOURCE_LATENCY_PROCESSOR_READ_TIMEOUT_MS') &&
      processorSource.includes('SOURCE_LATENCY_PROCESSOR_CLEANUP_TIMEOUT_MS') &&
      processorSource.includes('generation === captureGeneration') &&
      processorSource.includes('generation !== captureGeneration'),
  )
  check(
    'processor cleanup stops the clone, cancels the reader and releases its lock',
    processorSource.includes('sampleTrack?.stop()') &&
      processorSource.includes('reader.cancel()') &&
      processorSource.includes('reader.releaseLock()'),
  )
  const measureStart = source.indexOf(
    'async function measureChromiumSourceLatency(',
  )
  const measureEnd = source.indexOf(
    'function startChromiumSourceLatencyCalibration(',
    measureStart,
  )
  const measureSource = source.slice(measureStart, measureEnd)
  check(
    'processor collection starts before native reference acquisition can left-censor it',
    measureSource.indexOf('startPrimaryTrackProcessorSampler(') >= 0 &&
      measureSource.indexOf('startPrimaryTrackProcessorSampler(') <
        measureSource.indexOf('await startNativeLatencyReference()'),
  )
  check(
    'bounded pre-reference processor fingerprints remain available to bracket the match',
    measureSource.includes(
      'sample.latencyMs >= -SOURCE_LATENCY_NATIVE_START_TIMEOUT_MS',
    ),
  )
  check(
    'VideoFrame timestamp enters only the QPC decision and never a raw latency assignment',
    measureSource.includes(
      'processorAtMs: qpcEpochMs ?? sample.observedAtMs',
    ) &&
      measureSource.includes(
        'sample.processorAtMs - referenceAtMs',
      ) &&
      measureSource.indexOf('decideProcessorQpcDeliveryLatency(') <
        measureSource.indexOf('sourceLatencyDiagnostic(') &&
      !measureSource.includes(
        'latencyMs: sample.frameTimestampUs',
      ),
  )
  check(
    'only an unavailable processor falls back to presentation diagnostics',
    measureSource.includes('if (processorSampler !== null)') &&
      measureSource.indexOf('await samplePrimaryCalibrationFingerprint()') >
        measureSource.indexOf('if (processorSampler !== null)') &&
      measureSource.includes(
        'sample-source=video-presentation-callback',
      ),
  )
  check(
    'QPC refines only the sample axis; the pixel matcher remains the sole source-latency verdict',
    measureSource.includes('decideProcessorQpcDeliveryLatency(') &&
      measureSource.includes('mapProcessorFrameEpochMs(') &&
      measureSource.includes('sample.processorAtMs - referenceAtMs') &&
      !source.includes('reconcileProcessorLatency') &&
      source.includes('decideSourceLatencyCalibration(') &&
      measureSource.includes("'media-stream-track-processor'"),
  )
  check(
    'presentation fallback is explicitly provenance-rejected by the same decision',
    measureSource.includes("'video-presentation-callback'") &&
      source.includes('decideSourceLatencyCalibration(samples, {'),
  )
  check(
    'only observed same-frame clocks can move the replay source map',
    source.includes('sourceClockAnchorsFromObservedCaptureTime(') &&
      source.includes('sourceClockAnchorsFromMeasuredMediaTime(') &&
      source.includes('capturedAtMs: wallComparableTimeMs(') &&
      source.indexOf('sourceClockAnchorsFromObservedCaptureTime(') <
        source.lastIndexOf('sourceClockAnchorsFromMeasuredMediaTime(') &&
      !source.includes('alignReplayOriginToMeasuredPixels('),
  )
  const ipcSource = readFileSync(
    join(process.cwd(), 'src', 'shared', 'ipc.ts'),
    'utf8',
  )
  check(
    'calibration IPC diagnostics preserve additive verdict evidence',
    [
      'reason?',
      'method?',
      'sampleSource?',
      'confidence?',
      'motionTransitions?',
      'nativeQpcBracketed?',
      'deliveryLatencyP05Ms?',
      'deliveryLatencyP50Ms?',
      'deliveryLatencyP95Ms?',
      'deliveryLatencyMadMs?',
      'timestampSpanMs?',
      "method: 'processor-qpc-clock'",
    ].every(
      (field) => ipcSource.includes(field),
    ),
  )
  check(
    'a suspicious primary uses an independent native frame before fallback',
    source.includes('nativeProbeConfirmsFailure(') &&
      source.includes('startNativeFallback({'),
  )
  const inspectStart = source.indexOf(
    'async function inspectReplayPixels(',
  )
  const inspectEnd = source.indexOf(
    'function startReplayHealthWatchdog(',
    inspectStart,
  )
  const inspectSource = source.slice(inspectStart, inspectEnd)
  check(
    'pixel health owns its single-flight lease before sampling can wait',
    inspectSource.indexOf('replayHealthProbeActive = true') >= 0 &&
      inspectSource.indexOf('replayHealthProbeActive = true') <
        inspectSource.indexOf('samplePrimaryFingerprint()'),
  )
  check(
    'a slow pixel sample is bounded and quarantines overlapping probes',
    inspectSource.includes('HEALTH_SAMPLE_TIMEOUT_MS') &&
      inspectSource.includes('releaseOnReturn = false') &&
      inspectSource.includes('void primaryOperation.then(') &&
      inspectSource.includes('releaseReplayHealthProbe(probeToken)'),
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
