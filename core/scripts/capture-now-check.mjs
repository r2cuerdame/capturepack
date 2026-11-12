import { readFileSync } from 'node:fs'
import { scheduleCaptureWhenRecording } from '../src/main/captureNow.ts'

let passed = 0
let failed = 0

function check(name, condition) {
  if (condition) passed += 1
  else failed += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}`)
}

function harness(initialStatus = 'starting') {
  let state = { status: initialStatus }
  let listener = null
  let nextTimer = 0
  const scheduled = new Map()
  const cancelled = new Set()
  let captures = 0
  const dispose = scheduleCaptureWhenRecording(
    6_000,
    () => state,
    (nextListener) => {
      listener = nextListener
      return () => { listener = null }
    },
    () => { captures += 1 },
    (callback, delay) => {
      const id = ++nextTimer
      scheduled.set(id, { callback, delay })
      return id
    },
    (id) => { cancelled.add(id) },
  )
  return {
    scheduled,
    cancelled,
    dispose,
    get captures() { return captures },
    setStatus(status) {
      state = { status }
      listener?.(state)
    },
    fire(id) {
      scheduled.get(id)?.callback()
    },
    get listenerActive() { return listener !== null },
  }
}

console.log('Unattended capture waits for proven recorder readiness')
{
  const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  check(
    'normal delayed captures use recorder readiness while the starved-recorder case stays runnable',
    main.includes('scheduleCaptureWhenRecording(') &&
      main.includes("process.argv.includes('--simulate-no-frames')"),
  )
}
{
  const run = harness()
  check('startup does not begin the replay countdown', run.scheduled.size === 0)
  run.setStatus('recording')
  check('recording starts a full six-second countdown', run.scheduled.get(1)?.delay === 6_000)
  run.fire(1)
  check('capture begins after the healthy interval', run.captures === 1)
  check('the readiness listener is removed after capture', !run.listenerActive)
}
{
  const run = harness()
  run.setStatus('recording')
  run.setStatus('stopped')
  check('a recorder failure cancels the pending countdown', run.cancelled.has(1))
  run.setStatus('recording')
  check('recovery starts a fresh full countdown', run.scheduled.get(2)?.delay === 6_000)
  run.fire(2)
  check('recovered recorder produces one capture', run.captures === 1)
}
{
  const run = harness('recording')
  run.setStatus('recording')
  check('already-ready and repeated-ready notifications do not duplicate timers', run.scheduled.size === 1)
  run.dispose()
  check('dispose cancels countdown and detaches listener', run.cancelled.has(1) && !run.listenerActive)
  run.fire(1)
  check('disposed countdown cannot capture', run.captures === 0)
}

console.log(`capture-now checks: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
