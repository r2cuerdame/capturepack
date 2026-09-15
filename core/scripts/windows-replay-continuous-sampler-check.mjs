import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import {
  continuousSamplerScript,
  createContinuousProcessSampler,
} from './windows-replay-continuous-sampler.mjs'

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = 9876
  return child
}

async function scenario(options, exercise) {
  const child = fakeChild()
  const samples = []
  const errors = []
  let stops = 0
  const sampler = createContinuousProcessSampler({
    rootPid: 123,
    intervalMs: 1000,
    onSample: sample => samples.push(sample),
    onError: error => errors.push(error.message),
    spawnProcess: () => child,
    stopProcess: async owned => {
      assert.equal(owned, child, 'cleanup must target the owned sampler handle')
      stops += 1
    },
    silenceTimeoutMs: 50,
    ...options,
  })
  await exercise({ child, sampler, samples, errors })
  return { child, sampler, samples, errors, stops: () => stops }
}

assert.match(continuousSamplerScript(123, 1000), /while\(.*-lt \$samplingDeadline\)/)
assert.match(continuousSamplerScript(123, 1000), /\$samplingDeadline=\$nextSample\+900000/)
assert.match(continuousSamplerScript(123, 1000), /Get-Counter/)
assert.match(continuousSamplerScript(123, 1000), /handle_count=/)
assert.match(continuousSamplerScript(123, 1000), /thread_count=/)
assert.match(continuousSamplerScript(123, 1000), /parent_pid=/)
assert.match(continuousSamplerScript(123, 1000), /executable_path=/)
assert.match(continuousSamplerScript(123, 1000), /creation_date=/)

{
  const state = await scenario({}, async ({ child, sampler, samples, errors }) => {
    child.stdout.write('{"wall_time_ms":1,"process')
    child.stdout.write('es":[]}\r\n{"wall_time_ms":2,"gpu_available":false}\n')
    assert.deepEqual(samples.map(sample => sample.wall_time_ms), [1, 2], 'split and joined NDJSON lines parse')
    assert.deepEqual(errors, [])
    await sampler.stop()
  })
  assert.equal(state.stops(), 1, 'normal stop cleans up exactly the owned process')
}

for (const test of [
  { options: {}, write: child => child.stdout.write('not-json\n'), error: /invalid JSON/ },
  { options: { maxLineBytes: 8 }, write: child => child.stdout.write('123456789'), error: /line exceeded 8 bytes/ },
  { options: { maxStderrBytes: 8 }, write: child => child.stderr.write('123456789'), error: /stderr exceeded 8 bytes/ },
]) {
  const state = await scenario(test.options, async ({ child, errors }) => {
    test.write(child)
    await new Promise(resolve => setImmediate(resolve))
    assert.match(errors[0], test.error)
  })
  assert.equal(state.stops(), 1, 'parse/bound failure cleans up the owned process')
}

{
  const state = await scenario({}, async ({ child, errors }) => {
    child.emit('error', new Error('spawn-fixture'))
    await new Promise(resolve => setImmediate(resolve))
    assert.match(errors[0], /spawn-fixture/)
  })
  assert.equal(state.stops(), 1, 'process error cleans up the owned process')
}

{
  const state = await scenario({}, async ({ child, errors }) => {
    child.emit('close', 7)
    await new Promise(resolve => setImmediate(resolve))
    assert.match(errors[0], /exited unexpectedly \(code 7\)/)
  })
  assert.equal(state.stops(), 1, 'unexpected exit runs owned cleanup exactly once')
}

{
  const state = await scenario({ silenceTimeoutMs: 10 }, async ({ errors }) => {
    await new Promise(resolve => setTimeout(resolve, 25))
    assert.match(errors[0], /deadline exceeded/)
  })
  assert.equal(state.stops(), 1, 'sample deadline cleans up the owned process')
}

console.log('continuous process sampler regression: PASS (split lines, parse/process errors, bounds, timeout, owned cleanup)')

if (process.argv.includes('--live')) {
  const samples = []
  const errors = []
  const sampler = createContinuousProcessSampler({
    rootPid: process.pid,
    intervalMs: 1000,
    onSample: sample => {
      if (Array.isArray(sample.processes)) samples.push(sample)
      else errors.push(`PowerShell sample error: ${String(sample.error ?? 'missing process array')}`)
    },
    onError: error => errors.push(error.message),
    silenceTimeoutMs: 15_000,
  })
  // Each observation retains the production 15s silence bound; allow two observations.
  const deadline = Date.now() + 2 * 15_000 + 1_000
  while (samples.length < 2 && errors.length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  await sampler.stop()
  if (errors.length > 0) {
    assert.ok(errors.every(error => /access is denied|access denied/i.test(error)), errors.join('; '))
    console.log(`continuous process sampler live: SKIP (${errors.join('; ')})`)
  } else {
    assert.ok(samples.length >= 2, 'live sampler must deliver two samples')
    assert.ok(samples.every(sample => sample.processes.some(row => row.pid === process.pid)))
    console.log(JSON.stringify({ live_samples: samples.length, gpu_available: samples.map(sample => sample.gpu_available) }))
  }
}
