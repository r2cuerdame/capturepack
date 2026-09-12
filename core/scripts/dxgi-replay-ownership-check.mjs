// #243: native READY must retire Chromium's long-lived MP4 MediaRecorder.
// Execute the production ownership seams, with only browser/Electron boundaries
// faked. Source-string presence alone cannot establish that stop() actually ran.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))
const core = path.resolve(here, '..')
const { default: ts } = await import(pathToFileURL(path.join(core, 'node_modules/typescript/lib/typescript.js')).href)
const parse = (relative) => ts.createSourceFile(relative,
  readFileSync(path.join(core, relative), 'utf8'), ts.ScriptTarget.Latest, true)
const main = parse('src/main/capture.ts')
const renderer = parse('src/renderer/capture/capture.ts')
const retention = parse('src/renderer/capture/recorderRetention.ts')
function fn(source, name) {
  if (name === 'measuredReplaySourceClockAnchors' && process.argv.includes('--mutate-unverified-source-clock')) {
    return 'function measuredReplaySourceClockAnchors(clock, durationMs) { return sourceClockAnchorsFromObservedCaptureTime(replayClockAnchorsWithinDuration(clock, durationMs)); }'
  }
  const node = source.statements.find((statement) =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name)
  assert.ok(node, `production function ${name} must exist`)
  return node.getText(source).replace(/^export\s+/, '')
}
const workloadNode = renderer.statements.find((node) =>
  ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(renderer) === 'window.captureBridge.onReplayWorkload')
assert.ok(workloadNode, 'production workload IPC callback must exist')
let suspend = fn(renderer, 'suspendReplayEncoding')
// Mutation mode is the RED half: the unchanged ownership assertions must detect
// a regression that leaves Chromium recording, despite dropping JS references.
if (process.argv.includes('--mutate-omit-recorder-stop')) {
  assert.ok(suspend.includes('recorder.stop()'))
  suspend = suspend.replace('recorder.stop()', 'void recorder')
}
const rendererCode = [
  fn(retention, 'detachRecorderHandlers'), fn(retention, 'releaseRecorderReferences'),
  suspend, fn(renderer, 'retainNativeReplayClock'), fn(renderer, 'teardown'), fn(renderer, 'terminalCaptureFailure'),
  fn(renderer, 'startCapture'), workloadNode.getText(renderer),
].join('\n')
const mainCode = ['setShippingReplayWorkload', 'stopDxgiReplayServices',
  'reconcileDxgiReplayServices'].map((name) => fn(main, name)).join('\n')
let errorHandler
function findErrorHandler(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(main) === 'onError') {
    errorHandler = node.initializer.getText(main)
  }
  ts.forEachChild(node, findErrorHandler)
}
findErrorHandler(main)
assert.ok(errorHandler, 'production recorder error callback must exist')
function run(code, context) {
  vm.runInContext(ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, context)
}

function harness() {
  const events = []
  const payload = { displayId: 17, focused: true, fps: 15, segmentSeconds: 30, replayMaxWidth: 0 }
  const originalEndedListeners = []
  const originalStream = {
    getTracks: () => [{ stop: () => events.push('lane-s-track-stop') }],
    getVideoTracks: () => [{ addEventListener: (_type, listener) => originalEndedListeners.push(listener) }],
    end: () => originalEndedListeners.forEach((listener) => listener()),
  }
  const recorder = {
    state: 'recording', onstop: null,
    ondataavailable: () => events.push('unexpected-old-data'), onerror: () => {},
    stop() { this.state = 'inactive'; events.push('recorder-stop') },
  }
  const oldSession = { recorder, flushTimer: 'flush', flushBatch: { cancel: () => events.push('flush-cancel') } }
  let workloadCallback
  const rendererContext = vm.createContext({
    console: { info: () => {} }, captureGeneration: 7, captureStreamGeneration: 0, replayWorkloadActive: true,
    startPayload: payload, stream: originalStream,
    tickVideo: {}, sourceLatencyCalibrationCancel: null, sourceLatencyPresentationObserver: null,
    nativeFallbackStartupErrors: { cancel: () => {} }, nativeFallbackSessionId: null,
    nativeFallbackCanvas: null, nativeFallbackRequestedFrames: 0, nativeFallbackPresentedFrames: 0,
    nativeFallbackPresentationQueue: { stats: () => ({}), clear: () => {} },
    nativeFallbackFrameClock: { reset: () => {} },
    primaryReadinessCancel: () => events.push('readiness-cancel'),
    stopReplayHealthWatchdog: () => events.push('watchdog-stop'),
    ingestQueue: { cancel: () => events.push('ingest-cancel') }, recorderQueue: Promise.resolve(),
    replayHold: { watchdog: 'hold' }, replayResumeTokens: { clear: () => events.push('resume-tokens-clear') },
    retryTimer: 'retry', evidenceTimer: 'evidence', cadenceTimer: 'cadence', cadence: {},
    activeRecorder: oldSession, replayRing: { clear: () => events.push('ring-clear') },
    webmRing: { clear: () => events.push('webm-clear') },
    stopFrameTicks: () => { events.push('lane-s-ticks-stop'); rendererContext.tickVideo = null },
    startFrameTicks: () => {
      assert.ok(rendererContext.stream, 'clock needs an installed stream')
      events.push('lane-s-ticks-start'); rendererContext.tickVideo = { stream: rendererContext.stream }
    },
    window: {
      clearTimeout: (timer) => { if (timer !== undefined) events.push(`timeout-clear:${timer}`) },
      clearInterval: (timer) => { if (timer !== undefined) events.push(`interval-clear:${timer}`) },
      captureBridge: {
        onReplayWorkload: (callback) => { workloadCallback = callback },
        sendError: (message) => events.push(`capture-error:${message}`),
      },
    },
    // Browser boundary for the production startCapture() fallback path.
    pickRecorderFormat: () => ({ mimeType: 'video/mp4' }),
    MediaRecorder: { isTypeSupported: () => true },
    navigator: { mediaDevices: { getDisplayMedia: async () => {
      events.push('shipping-get-display-media')
      return { identity: 'fresh-shipping-stream', getTracks: () => [] }
    } } },
    installRecordingStream: (actualPayload, generation, stream, backend) => {
      assert.equal(actualPayload, payload)
      assert.ok(generation > 7)
      assert.equal(stream.identity, 'fresh-shipping-stream')
      assert.equal(backend, 'chromium-desktop-capture')
      events.push('fresh-shipping-installed')
    },
    failCapture: (message) => { throw new Error(message) },
    describe: (error) => String(error),
  })
  run(rendererCode, rendererContext)
  const managers = []
  class Manager {
    constructor(options) { this.options = options; this.selection = { backend: 'shipping', reason: 'native-not-ready' }; managers.push(this) }
    start() { events.push('native-start'); return new Promise((resolve) => { this.resolveStart = resolve }) }
    currentSelection() { return this.selection }
    stop() { events.push('native-stop') }
    ready() {
      this.selection = { backend: 'native-dxgi', ready: { kind: 'ready', status: 'ok', width: 1920, height: 1080, targetFps: 15 } }
      this.options.onReady(this.selection)
      this.resolveStart(this.selection)
    }
    fail() {
      this.selection = { backend: 'shipping', reason: 'native-runtime-failed' }
      this.options.onFallback(this.selection)
    }
  }
  const display = { id: 17 }
  const wanted = new Map([[display.id, display]])
  const settings = { recordingEnabled: true, replaySeconds: 30 }
  let sendFails = false
  const mainContext = vm.createContext({
    dxgiReplayServices: new Map(), shippingReplaySuspended: new Set(),
    captureWindows: new Map([[17, { isDestroyed: () => false, webContents: { send: (_channel, packet) => {
      if (sendFails) throw new Error('renderer unavailable')
      events.push(`workload:${packet.active}`); workloadCallback(packet)
    } } }]]),
    IPC: { captureReplayWorkload: 'capture:replay-workload' },
    displayCadence: { reset: () => {} }, setDisplayRecorderState: (_id, state) => events.push(`state:${state.status}`),
    clearRecorderProbe: () => {}, probesInFlight: new Set(), recoveryAttempts: new Map(), probesSinceProof: new Map(),
    DxgiReplayRuntimeManager: Manager, dxgiReplayRuntimeOptedIn: () => true,
    dxgiDisplayIdentity: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
    dxgiReplayServiceSignature: () => 'display-17-retention-30s',
    app: { getPath: () => 'test-output' }, path, process: { argv: [] }, logWarn: () => {}, logInfo: () => {}, logError: () => {},
    display, ownsTicks: true,
    isCurrentRecorderResource: (current, candidate) => current === candidate,
    failureReason: () => 'process-stopped',
  })
  mainContext.win = mainContext.captureWindows.get(17)
  run(mainCode, mainContext)
  run(`globalThis.handleCaptureError = ${errorHandler}`, mainContext)
  return { events, recorder, oldSession, originalStream, rendererContext, mainContext, managers,
    workload: (active) => workloadCallback({ active }),
    connectErrors: () => {
      const sender = mainContext.win.webContents
      rendererContext.window.captureBridge.sendError = (message) => {
        events.push(`capture-error:${message}`)
        // Electron IPC crosses processes after renderer terminal teardown.
        queueMicrotask(() => mainContext.handleCaptureError({ sender }, message))
      }
    },
    start: () => mainContext.reconcileDxgiReplayServices(wanted, settings),
    failSend: () => { sendFails = true },
  }
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
const count = (events, name) => events.filter((event) => event === name).length
let passed = 0
async function check(name, test) {
  await test()
  passed += 1
  console.log(`  PASS  #243 ${name}`)
}
await check('native READY stops/releases shipping MP4 while retaining focused Lane-S clock', async () => {
  const h = harness(); h.start()
  assert.equal(h.recorder.state, 'recording', 'shipping must cover native warm-up')
  assert.equal(count(h.events, 'workload:false'), 0)
  h.managers[0].ready(); await flush()
  assert.equal(h.recorder.state, 'inactive', 'native READY must call MediaRecorder.stop(); dropping references leaves Chromium encoding')
  assert.equal(count(h.events, 'recorder-stop'), 1)
  for (const name of ['onstop', 'ondataavailable', 'onerror']) assert.equal(h.recorder[name], null)
  for (const name of ['activeRecorder', 'replayRing', 'webmRing', 'ingestQueue', 'replayHold']) assert.equal(h.rendererContext[name], null)
  assert.equal(h.oldSession.flushBatch, null)
  for (const event of ['flush-cancel', 'ingest-cancel', 'ring-clear', 'webm-clear', 'watchdog-stop', 'resume-tokens-clear',
    'timeout-clear:flush', 'timeout-clear:hold', 'timeout-clear:retry', 'timeout-clear:evidence', 'interval-clear:cadence']) {
    assert.equal(count(h.events, event), 1, event)
  }
  assert.equal(h.rendererContext.captureGeneration, 8, 'pending shipping continuations must become stale')
  assert.equal(h.rendererContext.stream, h.originalStream)
  assert.equal(count(h.events, 'lane-s-track-stop'), 0)
  assert.equal(count(h.events, 'lane-s-ticks-stop'), 0)
  assert.equal(count(h.events, 'workload:false'), 1, 'callback and start completion must not duplicate suspension')
  h.managers[0].fail(); await flush()
  assert.equal(count(h.events, 'workload:true'), 1)
  assert.equal(count(h.events, 'shipping-get-display-media'), 1)
  assert.equal(count(h.events, 'fresh-shipping-installed'), 1, 'failure must resume the production shipping start path')
  h.managers[0].fail(); await flush()
  assert.equal(count(h.events, 'fresh-shipping-installed'), 1, 'duplicate fallback must not create duplicate recorders')
})
await check('stale READY after service teardown cannot suspend the replacement shipping owner', async () => {
  const h = harness(); h.start()
  const old = h.managers[0]
  h.mainContext.stopDxgiReplayServices()
  old.ready(); await flush()
  assert.equal(count(h.events, 'workload:false'), 0)
  assert.equal(h.recorder.state, 'recording')
  assert.equal(h.mainContext.dxgiReplayServices.size, 0)
})
await check('native teardown resumes fresh shipping capture after native ownership', async () => {
  const h = harness(); h.start(); h.managers[0].ready(); await flush()
  h.mainContext.stopDxgiReplayServices(); await flush()
  assert.equal(count(h.events, 'native-stop'), 1)
  assert.equal(count(h.events, 'fresh-shipping-installed'), 1)
  assert.equal(h.mainContext.dxgiReplayServices.size, 0)
  assert.equal(h.mainContext.shippingReplaySuspended.size, 0)
})
await check('obsolete service callbacks cannot change replacement native ownership', async () => {
  const h = harness(); h.start()
  const old = h.managers[0]
  h.mainContext.stopDxgiReplayServices(); h.start()
  old.ready(); await flush()
  assert.equal(count(h.events, 'workload:false'), 0, 'obsolete READY cannot retire the warming owner')
  h.managers[1].ready(); await flush()
  old.fail(); await flush()
  assert.equal(count(h.events, 'workload:true'), 0, 'obsolete failure cannot restart shipping beside replacement native')
  assert.equal(h.mainContext.shippingReplaySuspended.has(17), true)
})
await check('failed workload IPC discards native instead of selecting duplicate encoders', async () => {
  const h = harness(); h.start(); h.failSend(); h.managers[0].ready(); await flush()
  assert.equal(h.mainContext.dxgiReplayServices.size, 0)
  assert.equal(h.mainContext.shippingReplaySuspended.size, 0)
  assert.ok(count(h.events, 'native-stop') >= 1)
  assert.equal(h.recorder.state, 'recording')
})
function deferredCapture(h) {
  const pending = []
  h.rendererContext.navigator.mediaDevices.getDisplayMedia = () => new Promise((resolve, reject) => pending.push({ resolve, reject }))
  const acquired = (name) => {
    const endedListeners = []
    return {
      name, active: true,
      getTracks: () => [{ stop: () => h.events.push(`track-stop:${name}`) }],
      getVideoTracks: () => [{ addEventListener: (_type, listener) => endedListeners.push(listener) }],
      end: () => endedListeners.forEach((listener) => listener()),
    }
  }
  return { pending, acquired }
}
await check('READY during deferred focused acquisition establishes Lane-S without shipping recorder', async () => {
  const h = harness(); const d = deferredCapture(h)
  const started = h.rendererContext.startCapture(h.rendererContext.startPayload)
  h.workload(false)
  const clockStream = d.acquired('focused-clock')
  d.pending[0].resolve(clockStream); await started
  assert.equal(h.rendererContext.stream, clockStream, 'native READY must not discard the pending focused clock stream')
  assert.equal(h.rendererContext.tickVideo?.stream, clockStream)
  assert.equal(count(h.events, 'fresh-shipping-installed'), 0)
  assert.equal(count(h.events, 'track-stop:focused-clock'), 0)
})
await check('focused start while native already owns replay still acquires only a Lane-S clock', async () => {
  const h = harness(); const d = deferredCapture(h); h.workload(false)
  const started = h.rendererContext.startCapture(h.rendererContext.startPayload)
  assert.equal(d.pending.length, 1)
  const clockStream = d.acquired('already-native')
  d.pending[0].resolve(clockStream); await started
  assert.equal(h.rendererContext.tickVideo?.stream, clockStream)
  assert.equal(count(h.events, 'fresh-shipping-installed'), 0)
})
await check('real teardown rejects an old pending clock acquisition', async () => {
  const h = harness(); const d = deferredCapture(h)
  const started = h.rendererContext.startCapture(h.rendererContext.startPayload)
  h.workload(false); h.rendererContext.teardown()
  d.pending[0].resolve(d.acquired('stale')); await started
  assert.equal(h.rendererContext.stream, null)
  assert.equal(h.rendererContext.tickVideo, null)
  assert.equal(count(h.events, 'track-stop:stale'), 1)
})
await check('replacement capture rejects pending old clock even with identical payload', async () => {
  const h = harness(); const d = deferredCapture(h)
  const old = h.rendererContext.startCapture(h.rendererContext.startPayload)
  h.workload(false)
  const replacement = h.rendererContext.startCapture(h.rendererContext.startPayload)
  assert.equal(d.pending.length, 2)
  const fresh = d.acquired('replacement')
  d.pending[1].resolve(fresh); await replacement
  d.pending[0].resolve(d.acquired('obsolete')); await old
  assert.equal(h.rendererContext.stream, fresh)
  assert.equal(h.rendererContext.tickVideo?.stream, fresh)
  assert.equal(count(h.events, 'track-stop:obsolete'), 1)
})
await check('clock acquisition failure after READY is reported instead of silently discarded', async () => {
  const h = harness(); const d = deferredCapture(h)
  const started = h.rendererContext.startCapture(h.rendererContext.startPayload)
  h.workload(false); d.pending[0].reject(new Error('clock unavailable')); await started
  assert.ok(h.events.some((event) => event.startsWith('capture-error:') && event.includes('clock unavailable')))
  assert.equal(h.rendererContext.stream, null)
})
await check('READY during recorder readiness establishes clock and rejects late recorder continuation', async () => {
  const h = harness(); const d = deferredCapture(h)
  let finishReadiness
  Object.assign(h.rendererContext, {
    primaryStartupObservationAttempted: true,
    waitForPrimaryReadiness: () => new Promise((resolve) => {
      finishReadiness = resolve
      h.rendererContext.primaryReadinessCancel = () => h.events.push('pending-readiness-cancel')
    }),
    releaseVideoSink: () => h.events.push('stale-readiness-sink-released'),
    beginInstalledRecording: () => h.events.push('forbidden-recorder-start'),
  })
  run(fn(renderer, 'installRecordingStream'), h.rendererContext)
  const started = h.rendererContext.startCapture(h.rendererContext.startPayload)
  const clockStream = d.acquired('pending-readiness')
  d.pending[0].resolve(clockStream); await started
  assert.equal(h.rendererContext.tickVideo, null, 'recorder readiness has not installed Lane-S yet')
  // Readiness can resolve before READY, with its promise continuation queued.
  finishReadiness({ clockVideo: {} }); h.workload(false); await flush()
  assert.equal(h.rendererContext.tickVideo?.stream, clockStream)
  assert.equal(count(h.events, 'lane-s-ticks-start'), 1)
  assert.equal(count(h.events, 'forbidden-recorder-start'), 0)
  assert.equal(count(h.events, 'stale-readiness-sink-released'), 1)
  h.workload(false)
  assert.equal(count(h.events, 'lane-s-ticks-start'), 1, 'duplicate suspension must retain one clock sink')
})
await check('fallback rejects pending native clock before installing a fresh shipping acquisition', async () => {
  const h = harness(); const d = deferredCapture(h)
  const old = h.rendererContext.startCapture(h.rendererContext.startPayload)
  h.workload(false); h.workload(true)
  assert.equal(d.pending.length, 2)
  d.pending[0].resolve(d.acquired('pre-fallback')); await old
  assert.equal(count(h.events, 'track-stop:pre-fallback'), 1)
  assert.equal(h.rendererContext.stream, null)
  const fresh = d.acquired('fallback'); fresh.identity = 'fresh-shipping-stream'
  d.pending[1].resolve(fresh); await flush()
  assert.equal(count(h.events, 'fresh-shipping-installed'), 1)
  assert.equal(count(h.events, 'lane-s-ticks-start'), 0)
})
await check('existing clock ending after READY reports terminal failure without shipping restart', async () => {
  const h = harness(); h.workload(false); h.originalStream.end()
  assert.ok(h.events.includes('capture-error:focused presentation clock stream ended'))
  assert.equal(h.rendererContext.stream, null)
  assert.equal(count(h.events, 'shipping-get-display-media'), 0)
  assert.equal(count(h.events, 'fresh-shipping-installed'), 0)
})
await check('late-acquired native clock ending reports failure but obsolete clock ending is ignored', async () => {
  const h = harness(); const d = deferredCapture(h)
  const old = h.rendererContext.startCapture(h.rendererContext.startPayload); h.workload(false)
  const oldClock = d.acquired('old-clock'); d.pending[0].resolve(oldClock); await old
  const replacement = h.rendererContext.startCapture(h.rendererContext.startPayload)
  const fresh = d.acquired('fresh-clock'); d.pending[1].resolve(fresh); await replacement
  oldClock.end()
  assert.equal(h.rendererContext.stream, fresh)
  assert.ok(!h.events.some((event) => event.startsWith('capture-error:')))
  fresh.end()
  assert.ok(h.events.includes('capture-error:focused presentation clock stream ended'))
  assert.equal(h.rendererContext.stream, null)
  assert.equal(count(h.events, 'fresh-shipping-installed'), 0)
})
await check('current native clock fatal crosses sendError to retire native and resume shipping', async () => {
  const h = harness(); h.connectErrors(); h.start(); h.managers[0].ready(); await flush()
  h.originalStream.end(); await flush()
  assert.equal(h.mainContext.dxgiReplayServices.size, 0, 'main must not keep native selected after its focused clock dies')
  assert.equal(h.mainContext.shippingReplaySuspended.size, 0)
  assert.equal(count(h.events, 'native-stop'), 1)
  assert.equal(count(h.events, 'fresh-shipping-installed'), 1)
  assert.ok(h.events.includes('state:starting'))
})
await check('suspended shipping and obsolete sender errors cannot demote current native owner', async () => {
  const h = harness(); h.start(); h.managers[0].ready(); await flush()
  h.mainContext.handleCaptureError({ sender: h.mainContext.win.webContents }, 'old MediaRecorder failed')
  h.mainContext.handleCaptureError({ sender: {} }, 'focused presentation clock stream ended')
  assert.equal(h.mainContext.dxgiReplayServices.size, 1)
  assert.equal(h.mainContext.shippingReplaySuspended.has(17), true)
  assert.equal(count(h.events, 'native-stop'), 0)
  assert.equal(count(h.events, 'fresh-shipping-installed'), 0)
})
function calibrationHarness() {
  const h = harness()
  let finishCalibration
  let rejectCalibration
  let finishReadiness
  let control
  Object.assign(h.rendererContext, {
    recorderFormat: { mimeType: 'video/mp4' }, primaryStartupObservationAttempted: false,
    PRIMARY_STARTUP_OBSERVATION_MS: 2000, REPLAY_PIXEL_CLOCK_SAMPLE_LIMIT: 64,
    sourceLatencyCalibrationGeneration: null,
    measureChromiumSourceLatency: (_payload, _generation, _stream, observedControl) => {
      control = observedControl
      control.stopSampler = () => h.events.push('calibration-sampler-stop')
      return new Promise((resolve, reject) => { finishCalibration = resolve; rejectCalibration = reject })
    },
    waitForPrimaryReadiness: () => new Promise((resolve) => { finishReadiness = resolve }),
    beginInstalledRecording: () => h.events.push('recording-after-readiness'),
    releaseVideoSink: () => {},
    performance: { timeOrigin: 1000 }, wallComparableTimeMs: (origin, value) => origin + value,
    replayPixelClockFingerprint: () => ({}),
    retainReplayPixelClockPresentedSample: (samples, sample) => samples.push(sample),
    replayPixelClockPresentedSamples: [], segmentMs: 30000,
  })
  run([fn(renderer, 'startChromiumSourceLatencyCalibration'), fn(renderer, 'installRecordingStream'),
    fn(renderer, 'retainReplayPixelClockFrame')].join('\n'), h.rendererContext)
  h.rendererContext.installRecordingStream(h.rendererContext.startPayload, 7, h.originalStream, 'chromium-desktop-capture', 'full')
  return { ...h, control: () => control, ready: () => finishReadiness({ clockVideo: {} }), finish: (value) => finishCalibration(value), fail: (error) => rejectCalibration(error) }
}
await check('bounded calibration survives recorder readiness and collects live clock witnesses', async () => {
  const h = calibrationHarness()
  h.rendererContext.retainReplayPixelClockFrame({}, 5, 15, 4)
  assert.equal(h.control().presentedSamples.length, 1, 'first readiness samples use the same observer')
  h.ready(); await flush()
  assert.equal(count(h.events, 'recording-after-readiness'), 1)
  assert.equal(h.control().cancelled, false, 'recorder readiness must not discard bounded calibration still in flight')
  h.rendererContext.retainReplayPixelClockFrame({}, 10, 20, 9)
  assert.equal(h.control().presentedSamples.length, 2, 'live sink must continue the same bounded calibration observations')
  const proof = { status: 'measured' }
  h.finish(proof); await flush()
  assert.equal(h.rendererContext.sourceLatencyCalibration, proof)
  assert.equal(h.rendererContext.sourceLatencyPresentationObserver, null)
  assert.equal(h.rendererContext.sourceLatencyCalibrationCancel, null)
})
await check('native READY and actual teardown cancel calibration and reject late proof', async () => {
  for (const action of ['native-ready', 'teardown']) {
    const h = calibrationHarness(); h.ready(); await flush()
    if (action === 'native-ready') h.workload(false)
    else h.rendererContext.teardown()
    assert.equal(h.control().cancelled, true)
    assert.equal(count(h.events, 'calibration-sampler-stop'), 1)
    h.finish({ status: 'measured' }); await flush()
    assert.equal(h.rendererContext.sourceLatencyCalibration, undefined)
    assert.equal(h.rendererContext.sourceLatencyPresentationObserver, null)
  }
})
await check('rejected calibration settles unavailable and releases live observers', async () => {
  const h = calibrationHarness(); h.ready(); await flush()
  h.fail(new Error('bounded probe failed')); await flush()
  assert.equal(h.rendererContext.sourceLatencyCalibration?.status, 'unavailable')
  assert.equal(h.rendererContext.sourceLatencyCalibration?.reason, 'probe-failed')
  assert.equal(h.rendererContext.sourceLatencyPresentationObserver, null)
  assert.equal(h.rendererContext.sourceLatencyCalibrationCancel, null)
})
await check('only independent DXGI pixel exposure can select the replay source clock', async () => {
  const h = harness()
  Object.assign(h.rendererContext, {
    replayClockAnchorsWithinDuration: () => [{ ptsMs: 0, presentedAtMs: 1000, capturedAtMs: 999, mediaTimeMs: 50 }],
    sourceClockAnchorsFromObservedCaptureTime: () => [{ ptsMs: 0, wallMs: 999 }],
    sourceClockAnchorsFromMeasuredMediaTime: (_anchors, origin) => [{ ptsMs: 0, wallMs: origin + 50 }],
    sourceLatencyCalibration: {
      reference: { source: 'dxgi-desktop-duplication', timing: 'pixel-exposure' },
      presentation: { sourceMediaTimeOriginMs: 750, direct: { status: 'measured', sourceMediaTimeOriginMs: 750 } },
    },
  })
  run(fn(renderer, 'measuredReplaySourceClockAnchors'), h.rendererContext)
  assert.equal(h.rendererContext.measuredReplaySourceClockAnchors({}, 1000)[0].wallMs, 800,
    'independent same-pixel exposure must win over misleading raw rVFC captureTime')
  h.rendererContext.sourceLatencyCalibration.reference.source = 'windows-gdi-bitblt'
  assert.equal(h.rendererContext.measuredReplaySourceClockAnchors({}, 1000), undefined)
  h.rendererContext.sourceLatencyCalibration = undefined
  assert.equal(h.rendererContext.measuredReplaySourceClockAnchors({}, 1000), undefined,
    'raw captureTime alone is not a verified source exposure clock')
})
console.log(`dxgi replay ownership behavior check: ${passed} passed`)
