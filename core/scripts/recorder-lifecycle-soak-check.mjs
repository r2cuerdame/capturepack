// Bounded, synthetic ownership soak for #243. No Electron, desktop capture,
// native helper, forced GC, or wall-clock sleep is used. esbuild compiles once;
// the simulation cannot launch capture processes or workers.
// Bundle the shipped renderer with TEST-ONLY accessors in memory: the paths
// under test are its actual install/ingest/flush/HOLD/resume/teardown functions.
// This measures explicit JS ownership, not Chromium/GPU allocations or RSS.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { buildSync } from 'esbuild'

const core = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = resolve(core, 'src/renderer/capture/capture.ts')
const source = readFileSync(sourcePath, 'utf8')
const accessors = `
globalThis.soak = {
  install(acquiredStream) {
    teardown();
    stream = acquiredStream;
    startPayload = { displayId: 'synthetic', fps: 15, focused: false };
    segmentMs = 30000;
    recorderFormat = { strategy: 'fragmented-mp4', mimeType: 'video/mp4;codecs=avc1', replayFile: 'replay.mp4' };
    if (!installFreshReplayStorage(captureGeneration)) throw new Error('storage installation failed');
  },
  drain: () => ingestQueue?.flush(),
  flush: () => flushRecorderSession(activeRecorder, performance.now()),
  async hold(id) {
    if (!await flushRecorderSession(activeRecorder, performance.now(), false)) throw new Error('hold flush failed');
    if (!enterReplayHold(id, captureGeneration)) throw new Error('hold failed');
  },
  resume: (id) => resumeHeldReplay(id, captureGeneration, 'main'),
  settle: () => recorderQueue,
  teardown,
  sampler: () => startPrimaryTrackProcessorSampler(stream, captureGeneration),
  snapshot: () => ({
    ring: replayRing?.stats() ?? null,
    ingest: ingestQueue?.stats() ?? null,
    clockSamples: activeRecorder?.clockSamples.length ?? 0,
    pixelSamples: replayPixelClockPresentedSamples.length,
    resumeTokens: replayResumeTokens.size,
    recorder: activeRecorder?.recorder ?? null,
    // Inspect the actual queue/ring owners after teardown too, without adding
    // production instrumentation or a new long-lived diagnostic owner.
    ringOwner: replayRing,
    queueOwner: ingestQueue,
  }),
};
`
const compiled = buildSync({
  stdin: { contents: source + accessors, resolveDir: dirname(sourcePath), loader: 'ts' },
  bundle: true, platform: 'browser', format: 'iife', write: false,
}).outputFiles[0].text

function u32(value) {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value)
  return bytes
}
function join(parts) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) { result.set(part, offset); offset += part.length }
  return result
}
function box(type, ...parts) {
  const body = join(parts)
  return join([u32(8 + body.length), new TextEncoder().encode(type), body])
}
const init = join([
  box('ftyp', new TextEncoder().encode('isom')),
  box('moov', box('trak', box('mdia',
    box('mdhd', u32(0), u32(0), u32(0), u32(1000), u32(0)),
    box('hdlr', u32(0), u32(0), new TextEncoder().encode('vide')),
  ))),
])
function fragment(sequence) {
  return join([
    box('moof', box('mfhd', u32(0), u32(sequence + 1)), box('traf',
      box('tfhd', u32(8), u32(1), u32(1000)),
      box('tfdt', u32(0), u32(sequence * 1000)),
      box('trun', u32(0x100), u32(1), u32(1000)),
    )),
    box('mdat', new Uint8Array(512)),
  ])
}

function renderer() {
  let now = 1000
  let nextTimer = 0
  let readResolve = null
  let lockedReaders = 0
  let openFrames = 0
  let clones = 0
  let conversions = 0
  const timers = new Map()
  const recorders = new Set()
  const subscriptions = new Map()
  const errors = []
  const maximum = { timers: 0, recorders: 0, ringBytes: 0, fragments: 0, queuedBytes: 0 }
  const setTimer = (callback, delay) => {
    const id = ++nextTimer
    timers.set(id, { callback, at: now + delay })
    maximum.timers = Math.max(maximum.timers, timers.size)
    return id
  }
  class Track {
    stopped = false
    constructor(isClone = false) { this.isClone = isClone; if (isClone) clones++ }
    stop() { if (!this.stopped && this.isClone) clones--; this.stopped = true }
    clone() { return new Track(true) }
  }
  class Recorder {
    state = 'inactive'
    onstop = null
    onerror = null
    ondataavailable = null
    sequence = 0
    initialized = false
    constructor() { recorders.add(this) }
    start() {
      this.state = 'recording'
      maximum.recorders = Math.max(maximum.recorders, [...recorders].filter(r => r.state === 'recording').length)
    }
    emit(overrideBlob) {
      const bytes = fragment(this.sequence++)
      this.ondataavailable?.({
        data: overrideBlob ?? new Blob(this.initialized ? [bytes] : [init, bytes]),
        timeStamp: now, timecode: now,
      })
      this.initialized = true
    }
    stop() {
      this.state = 'inactive'
      // Browser order: stop is asynchronous and final data precedes onstop.
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob([]), timeStamp: now, timecode: now })
        this.onstop?.()
      })
    }
  }
  class Processor {
    constructor({ maxBufferSize, track }) {
      assert.equal(maxBufferSize, 1)
      assert.equal(track.isClone, true)
      this.readable = { getReader: () => {
        lockedReaders++
        return {
          read: () => new Promise(resolve => { assert.equal(readResolve, null); readResolve = resolve }),
          cancel: () => { readResolve?.({ done: true }); readResolve = null; return Promise.resolve() },
          releaseLock: () => { lockedReaders--; assert.equal(lockedReaders, 0) },
        }
      } }
    }
  }
  const bridge = Object.fromEntries([
    'onStart', 'onNativeFallbackFrame', 'onNativeFallbackError', 'onRequestReplay', 'onResumeReplay',
  ].map(name => [name, callback => { assert.equal(subscriptions.has(name), false); subscriptions.set(name, callback) }]))
  bridge.sendError = message => errors.push(message)
  const context = vm.createContext({
    Blob, Uint8Array, ArrayBuffer, DataView, console, MediaRecorder: Recorder,
    MediaStreamTrackProcessor: Processor,
    performance: { now: () => now, timeOrigin: 1_700_000_000_000 },
    window: {
      captureBridge: bridge, MediaStreamTrackProcessor: Processor,
      setTimeout: setTimer, clearTimeout: id => timers.delete(id),
      setInterval: () => { throw new Error('cadence/health intervals are outside this harness') },
      clearInterval: id => timers.delete(id),
    },
    document: { createElement: type => {
      assert.equal(type, 'canvas')
      return { getContext: () => ({
        drawImage() {},
        getImageData: (_x, _y, width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
      }) }
    } },
    // Fail closed if this harness starts exercising any real external path.
    Worker: class { constructor() { throw new Error('unexpected worker') } },
    URL: { createObjectURL() { throw new Error('unexpected object URL') } },
    navigator: { mediaDevices: { getDisplayMedia() { throw new Error('live capture prohibited') } } },
  })
  vm.runInContext(compiled, context, { timeout: 5000 })
  const api = context.soak
  const sweep = () => {
    for (const recorder of recorders) {
      if (recorder.state !== 'inactive') continue
      assert.equal(recorder.ondataavailable, null, 'retired recorder keeps data handler')
      assert.equal(recorder.onerror, null, 'retired recorder keeps error handler')
      assert.equal(recorder.onstop, null, 'retired recorder keeps stop handler')
      recorders.delete(recorder)
    }
  }
  const check = () => {
    const stats = api.snapshot()
    if (stats.ring) {
      assert.ok(stats.ring.retainedBytes <= stats.ring.retainedBudgetBytes)
      assert.ok(stats.ring.fragmentCount <= 30, `unbounded fragments: ${stats.ring.fragmentCount}`)
      maximum.ringBytes = Math.max(maximum.ringBytes, stats.ring.retainedBytes)
      maximum.fragments = Math.max(maximum.fragments, stats.ring.fragmentCount)
    }
    if (stats.ingest) {
      const bytes = stats.ingest.activeBlobBytes + stats.ingest.queuedBlobBytes + stats.ingest.batchedBlobBytes
      assert.ok(bytes <= stats.ingest.capacityBytes)
      assert.equal(stats.ingest.droppedBlobCount, 0)
      maximum.queuedBytes = Math.max(maximum.queuedBytes, bytes)
    }
    assert.ok(stats.clockSamples <= 8)
    assert.ok(stats.resumeTokens <= 4)
    assert.equal(subscriptions.size, 5)
    assert.deepEqual(errors, [])
    sweep()
    assert.ok(recorders.size <= 1)
    assert.ok(timers.size <= 1, `unexpected surviving timers: ${timers.size}`)
  }
  return {
    api, maximum,
    install() {
      const track = new Track()
      api.install({ active: true, getTracks: () => [track], getVideoTracks: () => [track] })
      return track
    },
    async tick() {
      now += 1000
      api.snapshot().recorder.emit()
      conversions++
      check()
      await api.drain()
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue
        timers.delete(id)
        timer.callback()
      }
      await api.settle()
      check()
    },
    async dispose(track) {
      const { ringOwner, queueOwner } = api.snapshot()
      api.teardown()
      await queueOwner?.flush()
      await Promise.resolve()
      assert.equal(track.stopped, true)
      assert.equal(ringOwner?.stats().retainedBytes ?? 0, 0)
      if (queueOwner) {
        const stats = queueOwner.stats()
        assert.equal(stats.queuedBlobBytes + stats.batchedBlobBytes, 0)
        assert.equal(stats.activePayloadRetained, false)
      }
      check()
      assert.equal(timers.size, 0)
      assert.equal(recorders.size, 0)
    },
    async sampleFrames() {
      const started = api.sampler()
      assert.equal(started.status, 'active')
      for (let i = 0; i < 180; i++) {
        assert.ok(readResolve)
        const resolveRead = readResolve
        readResolve = null
        openFrames++
        resolveRead({ done: false, value: { timestamp: now * 1000, close() { openFrames-- } } })
        for (let turn = 0; turn < 8; turn++) await Promise.resolve()
        assert.equal(openFrames, 0)
        assert.ok(started.sampler.samples.length <= 128)
      }
      assert.equal(started.sampler.samples.length, 128, 'sampler reached its retention limit')
      await started.sampler.stop()
      assert.equal(clones, 0)
      assert.equal(lockedReaders, 0)
      assert.equal(openFrames, 0)
      check()
    },
    summary: () => ({ simulatedMs: now - 1000, conversions, subscriptions: subscriptions.size, ...maximum }),
    check,
  }
}

const startedAt = performance.now()
const instance = renderer()
// 180,000 fragments / 50 simulated hours / 6,000 retention windows. A healthy
// maintenance timer must reschedule; no periodic replacement is allowed.
for (let cycle = 0; cycle < 300; cycle++) {
  const track = instance.install()
  const initialRecorder = instance.api.snapshot().recorder
  for (let fragmentIndex = 0; fragmentIndex < 600; fragmentIndex++) await instance.tick()
  assert.equal(instance.api.snapshot().clockSamples, 8, 'clock sample cap was exercised')
  assert.equal(instance.api.snapshot().recorder, initialRecorder, 'healthy recorder was periodically restarted')
  await instance.sampleFrames()
  await instance.api.flush()
  await instance.tick()
  const id = `hold-${cycle}`
  await instance.api.hold(id)
  assert.equal(instance.api.resume(id), true)
  await instance.tick()
  await instance.dispose(track)
}
// A cancelled browser Blob conversion can finish after its replacement starts.
// Keep the old owner for this assertion only; late bytes cannot refill its ring
// or consume the replacement's queue. Cancellation does NOT abort the browser
// operation, and this test deliberately does not claim otherwise.
for (let cycle = 0; cycle < 100; cycle++) {
  const track = instance.install()
  let finishConversion
  class DelayedBlob extends Blob {
    arrayBuffer() { return new Promise(resolve => { finishConversion = resolve }) }
  }
  instance.api.snapshot().recorder.emit(new DelayedBlob([init, fragment(0)]))
  const old = instance.api.snapshot()
  assert.ok(old.ingest.activeBlobBytes > 0)
  await instance.dispose(track)
  const replacementTrack = instance.install()
  finishConversion(join([init, fragment(0)]).buffer)
  for (let turn = 0; turn < 8; turn++) await Promise.resolve()
  assert.equal(old.queueOwner.stats().activeBlobBytes, 0)
  assert.equal(old.ringOwner.stats().retainedBytes, 0)
  assert.equal(instance.api.snapshot().ring.retainedBytes, 0)
  await instance.tick()
  await instance.dispose(replacementTrack)
}
// Recreate the renderer's script realm and IPC registrations independently.
// This exercises script initialization, not Electron BrowserWindow/process
// destruction; garbage-collector and native lifetime are outside the model.
for (let realm = 0; realm < 30; realm++) {
  const fresh = renderer()
  const track = fresh.install()
  for (let i = 0; i < 35; i++) await fresh.tick()
  await fresh.dispose(track)
}
console.log(JSON.stringify({
  result: 'PASS', scope: 'synthetic renderer JS owners; native/process/GPU allocations unmeasured',
  captureGenerations: 500, recorderFlushes: 600, processorFrames: 54_000,
  cancelledLateConversions: 100,
  additionalScriptRealms: 30,
  ...instance.summary(), wallMs: Math.round(performance.now() - startedAt),
}, null, 2))
