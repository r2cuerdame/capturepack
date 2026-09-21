import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createContinuousProcessSampler } from './windows-replay-continuous-sampler.mjs'
for (const record of [{ wall_time_ms: 4, error: 'CIM fixture failure' }, { wall_time_ms: 4 }, null]) {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  const errors = [], samples = []
  let stops = 0
  const sampler = createContinuousProcessSampler({
    rootPid: 123, intervalMs: 1000, spawnProcess: () => child,
    onSample: sample => samples.push(sample), onError: error => errors.push(error.message),
    stopProcess: async owned => { assert.equal(owned, child); stops += 1 },
  })
  for (let i = 1; i <= 3; i++) child.stdout.write(JSON.stringify({ wall_time_ms: i, processes: [] }) + '\n')
  child.stdout.write(JSON.stringify(record) + '\n')
  await sampler.stop()
  assert.equal(errors.length, 1, 'collection errors must remain fatal after three valid samples')
  assert.equal(stops, 1, 'sample failure cleans only its owned collector exactly once')
  assert.equal(samples.filter(sample => Array.isArray(sample?.processes)).length, 3)
}
console.log('sampler quality: PASS (collection failure cannot be hidden by earlier valid samples)')
