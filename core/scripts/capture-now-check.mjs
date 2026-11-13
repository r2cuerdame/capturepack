import { readFileSync } from 'node:fs'
import { scheduleCaptureWhenRecording } from '../src/main/captureNow.ts'
import { shouldSimulateNoFrames } from '../src/main/displayMediaPolicy.ts'

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

// Execute the actual launch branch without booting Electron. Keep the real
// recorder policy and readiness scheduler; substitute only the desktop/state
// boundary and timers so a permanently stopped display is deterministic.
const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const launchStart = main.indexOf('      const captureNow = process.argv.find(')
const launchEnd = main.indexOf('      // `--save-now[=SECONDS]`', launchStart)
if (launchStart < 0 || launchEnd < 0) throw new Error('capture-now launch branch not found')
const launch = new Function(
  'process', 'capture', 'setTimeout', 'getRecorderState', 'onRecorderStateChanged',
  'scheduleCaptureWhenRecording', 'getRecorderDisplayIds', 'shouldSimulateNoFrames', 'logInfo',
  main.slice(launchStart, launchEnd),
)

function launchHarness(extraArgs, displayIds = [11, 22], initialStatus = 'stopped') {
  let now = 0
  let nextTimer = 0
  let state = { status: initialStatus }
  let listener = null
  let captures = 0
  const timers = new Map()
  const schedule = (callback, delay) => {
    const id = ++nextTimer
    timers.set(id, { callback, at: now + delay })
    return id
  }
  const cancel = (id) => { timers.delete(id) }
  launch(
    { argv: ['CapturePack.exe', '--capture-now=6', ...extraArgs] },
    () => { captures += 1 },
    schedule,
    () => state,
    (nextListener) => {
      listener = nextListener
      return () => { listener = null }
    },
    (delay, getState, subscribe, capture) =>
      scheduleCaptureWhenRecording(delay, getState, subscribe, capture, schedule, cancel),
    () => [...displayIds],
    shouldSimulateNoFrames,
    () => {},
  )
  return {
    get captures() { return captures },
    get listenerActive() { return listener !== null },
    setStatus(status) {
      state = { status }
      listener?.(state)
    },
    advance(ms) {
      const until = now + ms
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (next === undefined) break
        const [id, timer] = next
        now = timer.at
        timers.delete(id)
        timer.callback()
      }
      now = until
    },
  }
}

console.log('Unattended launch options and stopped recorders')
for (const flag of ['--simulate-no-frames', '--simulate-no-frames=22']) {
  const run = launchHarness([flag])
  run.advance(5_999)
  check(`${flag}: capture does not run before the requested delay`, run.captures === 0)
  run.advance(1)
  check(`${flag}: a permanently stopped recorder still permits the capture`, run.captures === 1)
  run.advance(60_000)
  check(`${flag}: launch requests exactly one capture`, run.captures === 1)
  check(`${flag}: no readiness subscription remains`, !run.listenerActive)
}
for (const [flag, targets] of [
  ['--simulate-no-frames=', [11, 22]],
  ['--simulate-no-frames=99', [11, 22]],
  ['--simulate-no-frames=22', [11]],
  ['--simulate-no-frames-extra=22', [11, 22]],
]) {
  const run = launchHarness([flag], targets)
  run.advance(60_000)
  check(`${flag} on ${targets}: unrelated options cannot bypass readiness`, run.captures === 0)
  run.setStatus('recording')
  run.advance(5_999)
  check(`${flag} on ${targets}: a ready recorder retains the full delay`, run.captures === 0)
  run.advance(1)
  check(`${flag} on ${targets}: a ready recorder captures once`, run.captures === 1)
}
{
  const run = launchHarness([], [11, 22], 'starting')
  run.advance(60_000)
  check('normal launch waits for proven recording', run.captures === 0)
  run.setStatus('recording')
  run.advance(5_999)
  check('normal launch waits the full interval after readiness', run.captures === 0)
  run.advance(1)
  check('normal launch captures once after readiness and the interval', run.captures === 1)
}

console.log('Unattended capture waits for proven recorder readiness')
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
  run.fire(1)
  check('a queued cancelled callback cannot capture the recovered short replay', run.captures === 0)
  run.setStatus('recording')
  check('a stale callback cannot clear the recovery timer', run.scheduled.size === 2)
  run.fire(2)
  check('recovered recorder produces one capture', run.captures === 1)
}

// Run 43169244932: the launch countdown expired at 06:37:17.032,
// before frames were confirmed at 06:37:17.525, yielding only 537 ms.
// Advance an actual fake clock so startup time cannot count as replay time.
{
  let now = 0
  let state = { status: 'starting' }
  let listener
  let captureAt = null
  let timer
  scheduleCaptureWhenRecording(
    6_000,
    () => state,
    (next) => { listener = next; return () => { listener = null } },
    () => { captureAt = now },
    (callback, delay) => { timer = { callback, due: now + delay }; return timer },
    () => { timer = null },
  )
  now = 6_000
  check('the old launch deadline cannot capture before frames are confirmed', timer === undefined && captureAt === null)
  now = 6_493
  state = { status: 'recording' }
  listener(state)
  check('delayed startup receives six seconds of proven recording', timer.due === 12_493)
  now = timer.due
  timer.callback()
  check('capture follows readiness by the full interval', captureAt === 12_493)
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
