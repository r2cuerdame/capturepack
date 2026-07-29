import {
  detachRecorderHandlers,
  recorderChunkEndAtMs,
  releaseRecorderReferences,
  releaseRecorderReferencesOnStop,
  stopRecorderWithDeadline,
} from '../src/renderer/capture/recorderRetention'
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
    let stopAccepted = false
    const stopped = await stopRecorderWithDeadline(
      recorder,
      8_000,
      timers,
      () => undefined,
      () => {
        stopAccepted = true
      },
    )
    check('a normal stop resolves successfully', stopped)
    check('a normal stop clears its deadline', timers.callback === null)
    check('replacement may start immediately after stop is accepted', stopAccepted)
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

void checkStopDeadline()
