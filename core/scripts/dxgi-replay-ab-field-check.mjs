// Release-only managed-Windows A/B. This intentionally runs outside qa-gate:
// every trial owns the physical desktop and launches the production app.
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const {
  DEFAULT_DXGI_REPLAY_AB_THRESHOLDS,
  compareDxgiReplayAb,
  canContinueDxgiReplayAbTrial,
} = require('./fixtures/dxgi-replay-ab.cjs')
const here = path.dirname(fileURLToPath(import.meta.url))
const fieldScript = path.join(here, 'windows-replay-field-check.mjs')

function option(name, fallback = null) {
  const prefix = `--${name}=`
  const value = process.argv.slice(2).find((item) => item.startsWith(prefix))
  return value === undefined ? fallback : value.slice(prefix.length)
}

function integerOption(name, fallback, minimum, maximum) {
  const parsed = Number(option(name, String(fallback)))
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`--${name} must be an integer in ${minimum}..${maximum}`)
  }
  return parsed
}

function usage() {
  console.log(`DXGI replay release A/B field check

Required:
  --artifacts-dir=PATH       Empty/new root for every trial and ab-report.json

Release case:
  --trials=N                 At least 3 per backend (default 3)
  --fps=5..30                Same production setting for both backends (default 15)
  --duration-seconds=30..60 Same retention and steady window (default 30)
  --target=all|primary|ID    Same display selection (default primary)

Optional fields accepted by windows-replay-field-check are forwarded unchanged.
The runner alternates backend order between trials and fixes sampling to 2s
unless --sample-interval-ms is supplied.`)
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  usage()
  process.exit(0)
}

const artifactsValue = option('artifacts-dir')
if (artifactsValue === null || artifactsValue.trim() === '') {
  usage()
  throw new Error('--artifacts-dir is required')
}
const artifactsDir = path.resolve(artifactsValue)
if (existsSync(artifactsDir) && readdirSync(artifactsDir).length > 0) {
  throw new Error(`refusing non-empty A/B artifact directory: ${artifactsDir}`)
}
mkdirSync(artifactsDir, { recursive: true })

const trials = integerOption(
  'trials',
  DEFAULT_DXGI_REPLAY_AB_THRESHOLDS.minimum_trials,
  DEFAULT_DXGI_REPLAY_AB_THRESHOLDS.minimum_trials,
  10,
)
const durationSeconds = integerOption('duration-seconds', 30, 30, 60)
const common = process.argv.slice(2).filter((argument) => (
  !argument.startsWith('--artifacts-dir=')
  && !argument.startsWith('--trials=')
  && !argument.startsWith('--replay-backend=')
  && !argument.startsWith('--duration-seconds=')
))
common.push(`--duration-seconds=${durationSeconds}`)
if (!common.some((argument) => argument.startsWith('--sample-interval-ms='))) {
  common.push('--sample-interval-ms=2000')
}
if (!common.some((argument) => argument.startsWith('--target='))) {
  common.push('--target=primary')
}

const reports = { shipping: [], native: [] }
const executionOrder = []
const fieldFailures = []
let cleanupConfirmed = true
for (let trial = 1; trial <= trials && cleanupConfirmed; trial += 1) {
  const order = trial % 2 === 1
    ? ['shipping', 'native-dxgi']
    : ['native-dxgi', 'shipping']
  for (const backend of order) {
    const label = backend === 'shipping' ? 'shipping' : 'native'
    const runDir = path.join(artifactsDir, `${label}-${String(trial)}`)
    executionOrder.push({ trial, backend, artifacts: runDir })
    console.log(`\n[A/B] trial ${trial}/${trials}: ${backend}`)
    const child = spawnSync(
      process.execPath,
      [
        fieldScript,
        ...common,
        `--replay-backend=${backend}`,
        `--artifacts-dir=${runDir}`,
      ],
      {
        cwd: path.resolve(here, '..'),
        stdio: 'inherit',
        windowsHide: true,
        timeout: 30 * 60 * 1000,
      },
    )
    const reportPath = path.join(runDir, 'report.json')
    const report = existsSync(reportPath)
      ? JSON.parse(readFileSync(reportPath, 'utf8').replace(/^\uFEFF/u, ''))
      : null
    if (child.status !== 0 || report === null) {
      fieldFailures.push(
        `${backend} trial ${trial} failed or timed out ` +
        `(status=${String(child.status)}, signal=${String(child.signal)})`,
      )
    }
    if (report !== null) reports[label].push(report)
    cleanupConfirmed = canContinueDxgiReplayAbTrial(child, report)
    if (!cleanupConfirmed) {
      fieldFailures.push(`${backend} trial ${trial} did not confirm cleanup; later trials were not started`)
      break
    }
  }
}

const comparison = compareDxgiReplayAb(reports)
comparison.generated_at = new Date().toISOString()
comparison.execution_order = executionOrder
comparison.failures.unshift(...fieldFailures)
for (const file of comparison.evidence.raw_process_samples) {
  if (typeof file !== 'string' || !existsSync(file)) {
    comparison.failures.push(`raw process sample artifact missing: ${String(file)}`)
  }
}
comparison.result = comparison.failures.length === 0 ? 'PASS' : 'FAIL'
const reportPath = path.join(artifactsDir, 'ab-report.json')
writeFileSync(reportPath, `${JSON.stringify(comparison, null, 2)}\n`, 'utf8')

console.log(`\nA/B result: ${comparison.result}`)
console.log(`report: ${reportPath}`)
for (const [name, metric] of Object.entries(comparison.metrics)) {
  console.log(
    `${name}: shipping=${String(metric.shipping.mean)}, native=${String(metric.native.mean)}, ` +
    `delta=${String(metric.delta_mean)}, pass=${String(metric.pass)}`,
  )
}
for (const failure of comparison.failures) console.error(`FAIL: ${failure}`)
if (comparison.result !== 'PASS') process.exitCode = 1
