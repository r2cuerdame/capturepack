import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const core = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const quick = process.argv.includes('--quick')
const baseline = process.argv.includes('--baseline')
const baselineRef = 'af30c383299eae470b55dfb2ab04b90054fa26c4'
const laneSource = baseline
  ? execFileSync('git', ['show', `${baselineRef}:core/src/main/context/controlLane.ts`], { cwd: core, encoding: 'utf8', windowsHide: true })
  : readFileSync(resolve(core, 'src/main/context/controlLane.ts'), 'utf8')
const args = process.argv.slice(2)
for (const arg of args) {
  if (!['--quick', '--baseline'].includes(arg) && !arg.startsWith('--artifacts=')) throw new Error(`Unknown argument: ${arg}`)
}
const output = resolve(args.find(a => a.startsWith('--artifacts='))?.slice(12)
  ?? resolve(core, 'out', 'issue240', `${baseline ? 'before' : 'after'}-${Date.now()}`))
if (existsSync(output)) throw new Error('Use a new artifact directory; previous evidence must not be overwritten')
mkdirSync(output, { recursive: true })
const bundle = resolve(output, 'worker.cjs')
await build({
  entryPoints: [resolve(core, 'scripts/longrun-resource-worker.ts')],
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs',
  plugins: [{ name: 'isolated-lane', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
    b.onResolve({ filter: /(^|\/)log$/ }, () => ({ path: 'log', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: args.path === 'electron'
      ? 'export const app={getAppPath:()=>".",isPackaged:false};'
      : 'export const logInfo=()=>{};export const logWarn=()=>{};export const logError=()=>{};' }))
    if (baseline) b.onLoad({ filter: /context[\\/]controlLane\.ts$/ }, () => ({
      contents: laneSource,
      loader: 'ts', resolveDir: resolve(core, 'src/main/context'),
    }))
  } }],
})

// Every process here belongs to this harness. Hard wall timeout and V8 heap
// limit make a failing baseline bounded too. No app single-instance/profile use.
function run(exe, childArgs, timeoutMs, onStart) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(exe, childArgs, { cwd: core, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', overflow = false, timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
    const collect = (key, chunk) => {
      if (key === 'out') stdout += chunk.toString()
      else stderr += chunk.toString()
      if (stdout.length + stderr.length > 2 * 1024 * 1024) { overflow = true; child.kill() }
    }
    child.stdout.on('data', chunk => collect('out', chunk))
    child.stderr.on('data', chunk => collect('err', chunk))
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => { clearTimeout(timer); resolveRun({ code, stdout, stderr, overflow, timedOut }) })
    if (onStart) child.once('spawn', () => onStart(child.pid))
  })
}
let sampling
const worker = await run(process.execPath,
  ['--max-old-space-size=256', bundle, ...(quick ? ['--quick'] : []), ...(baseline ? ['--observe-only'] : [])],
  60_000, pid => {
    if (!quick && process.platform === 'win32') sampling = run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-File', resolve(core, 'scripts/sample-process-resources.ps1'),
      '-TargetProcessId', String(pid), '-DurationSeconds', '60', '-IntervalMs', '1000',
    ], 65_000)
  })
const sampler = sampling ? await sampling : null
writeFileSync(resolve(output, 'worker.ndjson'), worker.stdout)
writeFileSync(resolve(output, 'sampler.ndjson'), sampler?.stdout ?? '')
writeFileSync(resolve(output, 'stderr.txt'), worker.stderr + (sampler?.stderr ?? ''))
assert.equal(worker.timedOut || worker.overflow, false, 'worker resource watchdog fired')
assert.equal(worker.code, 0, worker.stderr)
if (sampler) {
  assert.equal(sampler.timedOut || sampler.overflow, false, 'sampler watchdog fired')
  assert.equal(sampler.code, 0, sampler.stderr)
}
const checkpoints = worker.stdout.trim().split(/\r?\n/).map(JSON.parse).filter(row => row.type === 'checkpoint')
const measurements = sampler?.stdout.trim() ? sampler.stdout.trim().split(/\r?\n/).map(JSON.parse) : []
const steady = checkpoints.filter(row => row.phase === 'churn')
const violations = steady.flatMap(row => [
  ...(row.retainedWindows > 6 ? [`${row.simulatedMs}ms: ${row.retainedWindows} windows exceed 6`] : []),
  ...(row.retainedElements > 384 ? [`${row.simulatedMs}ms: ${row.retainedElements} elements exceed 384`] : []),
])
if (checkpoints.at(-1).retainedWindows !== 0) violations.push('retired history did not expire')
if (!quick && process.platform === 'win32') assert.ok(measurements.length >= 3, 'OS sampler supplied fewer than three samples')
const bounds = {}
for (const key of ['cpuMs', 'cpuPercentOneCore', 'privateBytes', 'workingSetBytes', 'handles', 'threads']) {
  const values = measurements.map(row => row[key]).filter(value => typeof value === 'number')
  bounds[key] = values.length ? { min: Math.min(...values), max: Math.max(...values), first: values[0], last: values.at(-1) } : null
}
const report = {
  schema: 1, mode: baseline ? 'baseline-observation' : 'regression', quick,
  workload: `${quick ? 2 : 120} simulated minutes, 30s retention, one static window plus a new 64-control window every 10s; prune every 2s`,
  identity: { baselineRef: baseline ? baselineRef : null, node: process.version, platform: process.platform,
    sourceSha256: createHash('sha256').update(laneSource).digest('hex'),
    bundleSha256: createHash('sha256').update(readFileSync(bundle)).digest('hex') },
  limit: '60s worker watchdog, 256MiB V8 old-space; exact PID-only OS sampler',
  qualification: 'Accelerated isolated bookkeeping test. Not a two-hour desktop, installed-app, UIA-provider, MediaRecorder, or GPU soak.',
  checkpoints, osSampleCount: measurements.length, processBounds: bounds,
  passed: violations.length === 0, violations,
}
writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ output, mode: report.mode, checkpoints: checkpoints.map(({ memory, cpu, resources, ...row }) => row), osSampleCount: measurements.length, processBounds: bounds }, null, 2))
assert.deepEqual(violations, [], 'control-history steady-state bounds failed; see report.json')
