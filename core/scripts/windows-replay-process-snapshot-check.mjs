import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
const source = readFileSync(new URL('./windows-replay-field-check.mjs', import.meta.url), 'utf8')
const start = source.indexOf('async function processTreeSnapshot(')
const end = source.indexOf('\nfunction readJson(', start)
assert.ok(start >= 0 && end > start, 'actual field sampler must be present')
const factory = new Function('runBounded', 'encodedPowerShell', 'sampleIntervalMs', source.slice(start, end) + '\nreturn processTreeSnapshot')
const encode = value => Buffer.from(value, 'utf16le').toString('base64')
let observed
let result = { code: 0, timed_out: false, overflow: false, stdout: '{"processes":[],"gpu_available":true}', stderr: '#< CLIXML progress', error: null }
const snapshot = factory(async (command, args, options) => {
  observed = { command, args, options, script: Buffer.from(args.at(-1), 'base64').toString('utf16le') }
  return result
}, encode, 2000)
await snapshot(123)
assert.match(observed.script, /if \(\$true\)/)
assert.equal(observed.options.timeoutMs, 15000, 'resource deadline must not be increased')
assert.equal(observed.options.maxStdoutBytes, 4 * 1024 * 1024)
await snapshot(123, { includeGpu: false })
assert.match(observed.script, /if \(\$false\)/)
assert.match(observed.script, /not sampled \(identity-only\)/)
for (const [delta, message] of [[{ timed_out: true }, /deadline exceeded/], [{ overflow: true }, /output limit exceeded/], [{ code: 1, stderr: 'fixture-failure' }, /fixture-failure/]]) {
  const prior = result
  result = { ...prior, ...delta }
  await assert.rejects(snapshot(123), message)
  result = prior
}
result = { ...result, stdout: '{}' }
await assert.rejects(snapshot(123), /no process array/)
result = { ...result, stdout: 'not-json' }
await assert.rejects(snapshot(123), SyntaxError)
console.log('process snapshot regression: PASS (GPU/identity split, deadline, overflow, errors, invalid JSON)')
if (process.argv.includes('--live')) {
  const real = factory((command, args, options) => new Promise(resolve => {
    execFile(command, args, { encoding: 'utf8', windowsHide: true, timeout: options.timeoutMs, maxBuffer: options.maxStdoutBytes }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, timed_out: Boolean(error?.killed), overflow: error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout, stderr, error: error?.message ?? null })
    })
  }), encode, 2000)
  for (const includeGpu of [true, false]) {
    const began = Date.now()
    const sample = await real(process.pid, { includeGpu })
    assert.ok(sample.processes.some(row => row.pid === process.pid), 'own process identity must be sampled')
    console.log(JSON.stringify({ includeGpu, elapsed_ms: Date.now() - began, gpu_available: sample.gpu_available, process_count: sample.processes.length }))
  }
}
