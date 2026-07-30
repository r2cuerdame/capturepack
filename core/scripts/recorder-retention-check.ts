import {
  detachRecorderHandlers,
  recorderMaintenanceDecision,
  recorderChunkEndAtMs,
  releaseRecorderReferences,
  releaseRecorderReferencesOnStop,
  stopRecorderWithDeadline,
} from '../src/renderer/capture/recorderRetention'
import {
  BoundedBlobIngestQueue,
  commitRecorderBatchBeforeReplacement,
} from '../src/renderer/capture/boundedBlobIngestQueue'
import './recorder-ring-check'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

class FakeRecorder {
  ondataavailable: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onstop: (() => void) | null = null

  stop(): void {
    // MediaRecorder's required event order: the last data event precedes stop.
    this.ondataavailable?.({ data: 'final' })
    this.onstop?.()
  }
}

console.log('\nRecorder Blob retention')
{
  const recorder = new FakeRecorder()
  const chunks = ['old-1', 'old-2']
  let sawFinal = false
  recorder.ondataavailable = (event) => {
    sawFinal = event.data === 'final'
    chunks.push(event.data)
  }
  recorder.onerror = () => undefined
  releaseRecorderReferencesOnStop(recorder, chunks)
  recorder.stop()

  check('rotation accepts the final data event before release', sawFinal)
  check('rotation drops the completed segment after stop', chunks.length === 0)
  check(
    'rotation detaches every handler after stop',
    recorder.ondataavailable === null && recorder.onerror === null && recorder.onstop === null,
  )
}

{
  const recorder = new FakeRecorder()
  const chunks = ['discarded']
  recorder.ondataavailable = (event) => chunks.push(event.data)
  recorder.onerror = () => undefined
  recorder.onstop = () => undefined
  releaseRecorderReferences(recorder, chunks)

  check('discarded recorder drops all Blob references immediately', chunks.length === 0)
  check(
    'discarded recorder cannot append another chunk',
    recorder.ondataavailable === null && recorder.onerror === null && recorder.onstop === null,
  )
}

{
  const recorder = new FakeRecorder()
  const chunks = ['kept-until-assembly']
  recorder.ondataavailable = () => undefined
  recorder.onerror = () => undefined
  recorder.onstop = () => undefined
  detachRecorderHandlers(recorder)

  check('replay assembly may retain chunks after handlers detach', chunks.length === 1)
  check(
    'replay assembly no longer retains chunks through the recorder',
    recorder.ondataavailable === null && recorder.onerror === null && recorder.onstop === null,
  )
}

console.log('\nRecorder chunk timing')
{
  check(
    'an ordinary queued timeslice keeps its pre-stop event time',
    recorderChunkEndAtMs(990, 1_050, 1_000, true) === 990,
  )
  check(
    'the final stop flush is anchored to the requested capture instant',
    recorderChunkEndAtMs(1_001, 1_050, 1_000, true) === 1_000,
  )
  check(
    'an active recorder chunk uses its event time instead of delivery backlog',
    recorderChunkEndAtMs(500, 750, null, false) === 500,
  )
  check(
    'an unavailable final event timestamp falls back to the flush instant',
    recorderChunkEndAtMs(0, 1_050, 1_000, true) === 1_000,
  )
  check(
    'a foreign event clock cannot become a replay timestamp',
    recorderChunkEndAtMs(1_700_000_000_000, 1_050, null, false) === 1_050,
  )
}

console.log('\nRecorder maintenance gate')
{
  const healthy = recorderMaintenanceDecision({
    nowMs: 12_000,
    startedAtMs: 0,
    lastFragmentAtMs: 11_800,
    intervalMs: 12_000,
    minimumDelayMs: 200,
    sessionActive: true,
  })
  check(
    'recent complete MP4 output keeps the healthy encoder alive',
    healthy.action === 'reschedule' && healthy.delayMs === 11_800,
    JSON.stringify(healthy),
  )

  const noOutput = recorderMaintenanceDecision({
    nowMs: 12_000,
    startedAtMs: 0,
    lastFragmentAtMs: null,
    intervalMs: 12_000,
    minimumDelayMs: 200,
    sessionActive: true,
  })
  check(
    'a muxer with no timeslice output still receives the bounded stop flush',
    noOutput.action === 'flush' && noOutput.delayMs === 0,
    JSON.stringify(noOutput),
  )

  const stale = recorderMaintenanceDecision({
    nowMs: 13_000,
    startedAtMs: 0,
    lastFragmentAtMs: 500,
    intervalMs: 12_000,
    minimumDelayMs: 200,
    sessionActive: true,
  })
  check(
    'stale output cannot postpone maintenance forever',
    stale.action === 'flush' && stale.delayMs === 0,
    JSON.stringify(stale),
  )

  const retired = recorderMaintenanceDecision({
    nowMs: 12_000,
    startedAtMs: 0,
    lastFragmentAtMs: 11_800,
    intervalMs: 12_000,
    minimumDelayMs: 200,
    sessionActive: false,
  })
  check(
    'a retired session neither flushes nor creates another timer',
    retired.action === 'retired' && retired.delayMs === 0,
    JSON.stringify(retired),
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1

class FakeDeadlineTimers {
  callback: (() => void) | null = null

  set(callback: () => void): unknown {
    this.callback = callback
    return 1
  }

  clear(): void {
    this.callback = null
  }

  fire(): void {
    const callback = this.callback
    this.callback = null
    callback?.()
  }
}

async function checkStopDeadline(): Promise<void> {
  console.log('\nRecorder stop deadline')
  {
    const recorder = new FakeRecorder()
    const timers = new FakeDeadlineTimers()
    const stopped = await stopRecorderWithDeadline(
      recorder,
      8_000,
      timers,
      () => undefined,
    )
    check('a normal stop resolves successfully', stopped)
    check('a normal stop clears its deadline', timers.callback === null)
    check('a completed stop detaches its one-shot stop callback', recorder.onstop === null)
  }

  {
    const recorder = new FakeRecorder()
    recorder.stop = () => {
      // Simulate a muxer which accepted stop() but never emitted stop.
    }
    const timers = new FakeDeadlineTimers()
    let releasedLate = false
    const pending = stopRecorderWithDeadline(
      recorder,
      8_000,
      timers,
      () => {
        releasedLate = true
      },
      () => undefined,
    )
    timers.fire()
    check('a missing stop event resolves at the deadline', (await pending) === false)
    check('a permanently missing stop event releases retained handlers at the deadline', releasedLate)
    check('the deadline leaves no stale stop callback behind', recorder.onstop === null)
  }

  {
    const recorder = new FakeRecorder()
    recorder.stop = () => {
      throw new Error('stop rejected')
    }
    const timers = new FakeDeadlineTimers()
    let released = 0
    const stopped = await stopRecorderWithDeadline(
      recorder,
      8_000,
      timers,
      () => {
        released += 1
        releaseRecorderReferences(recorder, [])
      },
    )
    check('a thrown stop resolves as failure without waiting for the deadline', stopped === false)
    check('a thrown stop releases handlers exactly once', released === 1 && recorder.onstop === null)
    check('a thrown stop clears its deadline', timers.callback === null)
  }

  console.log(`\n${passed} passed, ${failed} failed (including stop deadline)`)
  if (failed > 0) process.exitCode = 1
}

class DeferredBlob extends Blob {
  arrayBufferCalls = 0
  private settle: ((value: ArrayBuffer) => void) | null = null

  override arrayBuffer(): Promise<ArrayBuffer> {
    this.arrayBufferCalls += 1
    return new Promise<ArrayBuffer>((resolve) => {
      this.settle = resolve
    })
  }

  finish(fill = 1): void {
    const bytes = new Uint8Array(this.size)
    bytes.fill(fill)
    const settle = this.settle
    this.settle = null
    settle?.(bytes.buffer)
  }

  finishBytes(bytes: Uint8Array): void {
    if (bytes.byteLength !== this.size) {
      throw new Error(`DeferredBlob size mismatch: ${bytes.byteLength} !== ${this.size}`)
    }
    const settle = this.settle
    this.settle = null
    settle?.(bytes.slice().buffer)
  }
}

async function drainMicrotasks(turns = 4): Promise<void> {
  for (let i = 0; i < turns; i += 1) await Promise.resolve()
}

async function checkBoundedBlobIngestQueue(): Promise<void> {
  console.log('\nBounded recorder Blob ingest')
  {
    const consumed: Uint8Array[] = []
    const queue = new BoundedBlobIngestQueue<string>(
      18,
      (bytes) => {
        consumed.push(bytes)
      },
    )
    // One legal 20-byte top-level fMP4 box split across three recorder events.
    // Losing the middle pending Blob while retaining its later tail makes the
    // parser read arbitrary payload bytes as the next box header.
    const splitBox = Uint8Array.from([
      0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70,
      0x69, 0x73, 0x6f, 0x6d, 1, 2, 3, 4, 5, 6, 7, 8,
    ])
    const active = new DeferredBlob([splitBox.slice(0, 12)])
    const middle = new DeferredBlob([splitBox.slice(12, 16)])
    const tail = new DeferredBlob([splitBox.slice(16)])

    check('a split box prefix enters the one bounded active slot', queue.enqueue(active, 'prefix'))
    check('the split box middle waits inside the remaining byte budget', queue.enqueue(middle, 'middle'))
    check(
      'capacity pressure rejects the later tail instead of evicting an earlier stream byte range',
      !queue.enqueue(tail, 'tail'),
    )
    check(
      'rejection preserves the already accepted contiguous stream prefix within the cap',
      queue.stats().activeBlobBytes + queue.stats().queuedBlobBytes <= 18 &&
        queue.stats().queuedBlobCount === 1 &&
        queue.stats().droppedBlobCount === 1,
    )
    check('the rejected tail is never converted', tail.arrayBufferCalls === 0)

    active.finishBytes(splitBox.slice(0, 12))
    await drainMicrotasks()
    check('the accepted middle still starts after the active conversion settles', middle.arrayBufferCalls === 1)
    middle.finishBytes(splitBox.slice(12, 16))
    await queue.flush()
    const contiguousPrefix = new Uint8Array(
      consumed.reduce((sum, bytes) => sum + bytes.byteLength, 0),
    )
    let prefixOffset = 0
    for (const bytes of consumed) {
      contiguousPrefix.set(bytes, prefixOffset)
      prefixOffset += bytes.byteLength
    }
    check(
      'flush never turns prefix plus tail into a syntactically corrupt fMP4 byte stream',
      contiguousPrefix.byteLength === 16 &&
        contiguousPrefix.every((value, index) => value === splitBox[index]),
      `${contiguousPrefix.byteLength} bytes`,
    )
    check(
      'flush leaves no queued Blob references or byte reservations',
      queue.stats().activeBlobBytes === 0 &&
        queue.stats().queuedBlobBytes === 0 &&
        queue.stats().queuedBlobCount === 0,
    )
  }

  {
    const consumed: string[] = []
    const queue = new BoundedBlobIngestQueue<string>(
      10,
      (_bytes, label) => {
        consumed.push(label)
      },
    )
    const active = new DeferredBlob([new Uint8Array(6)])
    const pending = new DeferredBlob([new Uint8Array(3)])
    queue.enqueue(active, 'old-active')
    queue.enqueue(pending, 'old-pending')
    const stopBatch = queue.createBatch()
    check('a stop-flush batch reserves Blob bytes in the same cap', stopBatch.append(new Blob(['x'])))

    queue.cancel()
    const afterCancel = queue.stats()
    check(
      'restart cancellation drops every pending and stop-batch Blob reference immediately',
      afterCancel.cancelled &&
        afterCancel.queuedBlobCount === 0 &&
        afterCancel.queuedBlobBytes === 0 &&
        afterCancel.batchedBlobCount === 0 &&
        afterCancel.batchedBlobBytes === 0 &&
        !afterCancel.activePayloadRetained &&
        pending.arrayBufferCalls === 0,
    )
    let canceledFlushSettled = false
    void queue.flush().then(() => {
      canceledFlushSettled = true
    })
    await Promise.resolve()
    check('a canceled old queue cannot delay a replacement generation', canceledFlushSettled)

    active.finish()
    await drainMicrotasks()
    check('a Blob finishing after cancellation cannot reach the retired consumer', consumed.length === 0)
  }

  {
    const queue = new BoundedBlobIngestQueue<string>(3, () => undefined)
    const first = new DeferredBlob(['1'])
    const beforeBarrier = new DeferredBlob(['2'])
    const afterBarrier = new DeferredBlob(['3'])
    queue.enqueue(first, 'first')
    queue.enqueue(beforeBarrier, 'before')
    let barrierSettled = false
    void queue.flush().then(() => {
      barrierSettled = true
    })
    queue.enqueue(afterBarrier, 'after')
    first.finish()
    await drainMicrotasks()
    beforeBarrier.finish()
    await drainMicrotasks()
    check(
      'flush is a bounded barrier and does not wait on recorder events queued later',
      barrierSettled && afterBarrier.arrayBufferCalls === 1,
    )
    queue.cancel()
    afterBarrier.finish()
    await drainMicrotasks()
  }

  {
    const delayedStop = {
      finish: null as (() => void) | null,
    }
    const recorder = new FakeRecorder()
    recorder.stop = () => {
      delayedStop.finish = () => recorder.onstop?.()
    }
    const timers = new FakeDeadlineTimers()
    const consumed: string[] = []
    const queue = new BoundedBlobIngestQueue<string>(
      32,
      (_bytes, session) => consumed.push(session),
    )
    const oldBatch = queue.createBatch()
    check('the delayed old stop batch accepts its first piece', oldBatch.append(new Blob(['old-1'])))
    check('the delayed old stop batch accepts its final piece', oldBatch.append(new Blob(['old-2'])))
    let replacementStarted = false
    const stopped = stopRecorderWithDeadline(
      recorder,
      8_000,
      timers,
      () => undefined,
    )
    await Promise.resolve()
    check('a replacement cannot start merely because old stop() was accepted', !replacementStarted)
    delayedStop.finish?.()
    check('the delayed old recorder eventually reports a complete stop', await stopped)
    const committed = await commitRecorderBatchBeforeReplacement(
      queue,
      oldBatch,
      'old-session',
      () => {
        replacementStarted = true
        queue.enqueue(new Blob(['new-session']), 'new-session')
      },
    )
    await queue.flush()
    check(
      'old committed stop batch reaches the parser before replacement recorder bytes',
      committed &&
        replacementStarted &&
        consumed.join(',') === 'old-session,new-session',
      consumed.join(','),
    )
    queue.cancel()
    const released = queue.stats()
    check(
      'ordered rotation leaves no Blob or payload references after teardown',
      released.cancelled &&
        released.activeBlobBytes === 0 &&
        released.queuedBlobBytes === 0 &&
        released.batchedBlobBytes === 0 &&
        !released.activePayloadRetained,
    )
  }

  {
    const consumed: string[] = []
    const queue = new BoundedBlobIngestQueue<string>(
      32,
      (_bytes, session) => consumed.push(session),
    )
    check(
      'a recorder session can publish ordinary MP4 output before stop',
      queue.enqueue(new Blob(['old-timeslice']), 'old-session'),
    )
    const emptyFinalBatch = queue.createBatch()
    let replacementStarted = false
    const committed = await commitRecorderBatchBeforeReplacement(
      queue,
      emptyFinalBatch,
      'unused-empty-final',
      () => {
        replacementStarted = true
        queue.enqueue(new Blob(['new-timeslice']), 'new-session')
      },
      true,
    )
    await queue.flush()
    check(
      'a zero-byte final event is a valid barrier only after prior session output',
      committed &&
        replacementStarted &&
        consumed.join(',') === 'old-session,new-session',
      consumed.join(','),
    )
    const noOutputBatch = queue.createBatch()
    check(
      'an empty recorder session cannot claim a valid MP4 rotation',
      !noOutputBatch.commit('no-output'),
    )
    queue.cancel()
  }

  {
    const queue = new BoundedBlobIngestQueue<string>(5, () => undefined)
    const batch = queue.createBatch()
    check('a final-stop batch accepts parts while it fits the shared byte cap', batch.append(new Blob(['123'])))
    check('a final-stop batch rejects overflow instead of retaining an unbounded Blob list', !batch.append(new Blob(['456'])))
    check(
      'overflow invalidates and releases the entire partial recorder batch',
      !batch.commit('overflow') &&
        queue.stats().batchedBlobCount === 0 &&
        queue.stats().batchedBlobBytes === 0,
    )
    queue.cancel()
  }

  console.log(`\n${passed} passed, ${failed} failed (including bounded Blob ingest)`)
  if (failed > 0) process.exitCode = 1
}

async function runAsyncChecks(): Promise<void> {
  await checkStopDeadline()
  await checkBoundedBlobIngestQueue()
}

const asyncCheckDeadline = setTimeout(() => {
  check('bounded Blob ingest async checks complete before their deadline', false)
  process.exitCode = 1
}, 2_000)
void runAsyncChecks().finally(() => {
  clearTimeout(asyncCheckDeadline)
})
