// Regression for the event-driven lane-S cost path.
//
// The old hook only set MovePending; every "delta" still called EnumWindows and
// read geometry for every visible top-level window. The shipping host exposes a
// test-only queue that names one HWND exactly as WinEvent does. One initial full
// snapshot followed by N such reads must therefore leave FullScanCount at one.
//
// This runs the real PowerShell/C# host. It never creates, moves, focuses, or
// closes a window and starts no resident process.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const core = path.join(here, '..')
const host = path.join(here, 'context-host.ps1')
const hostSource = readFileSync(host, 'utf8')
const samples = 300

function run(args) {
  const stdout = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', host, ...args],
    { cwd: core, encoding: 'utf8', windowsHide: true },
  )
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
  const last = lines.at(-1)
  if (last === undefined) throw new Error('context host produced no result')
  return JSON.parse(last)
}

const full = run(['-SelfTest', String(samples), '-Interval', '0'])
const dirty = run(['-DirtySelfTest', String(samples), '-Interval', '0'])
const failures = []

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL ${label} — ${detail}`)
  }
}

console.log('Context host dirty-HWND check')
check(
  'a newly moving captionless window uses its visible client bounds instead of stale DWM or invisible borders',
  hostSource.includes('GetWindowLong') &&
    hostSource.includes('GetDpiForWindow') &&
    hostSource.includes('captionless') &&
    hostSource.includes('compactNonClient') &&
    hostSource.includes('if (clientOwnsFrame) {') &&
    hostSource.includes('frame = client;'),
  'captionless/custom-titlebar client-frame branch is missing',
)
check('full baseline completed', full.event === 'selftest' && full.samples === samples, JSON.stringify(full))
check(
  'one initial EnumWindows snapshot only',
  dirty.fullScansBeforeStructural === 1,
  `fullScans=${String(dirty.fullScansBeforeStructural)}`,
)
check(
  'every synthetic WinEvent queued one known HWND',
  dirty.queued === samples,
  `queued=${String(dirty.queued)}`,
)
check(
  'every dirty request used the dirty path',
  dirty.dirtySamplesBeforeStructural === samples + 1 && dirty.dirtyFallbacksBeforeStructural === 0,
  `dirtySamples=${String(dirty.dirtySamplesBeforeStructural)} ` +
    `fallbacks=${String(dirty.dirtyFallbacksBeforeStructural)}`,
)
check(
  'exactly one HWND was read per regular dirty request',
  dirty.dirtyWindows === samples + 1,
  `dirtyWindows=${String(dirty.dirtyWindows)}`,
)
check(
  'one-HWND event storm coalesces to one read',
  dirty.burstQueued === dirty.burstEvents &&
    dirty.burstEvents === 100 &&
    dirty.burstWindowReads === 1,
  `queued=${String(dirty.burstQueued)} reads=${String(dirty.burstWindowReads)}`,
)
check(
  'a structural event forces one full reconciliation',
  dirty.fullScans === 2 &&
    dirty.dirtyFallbacks === 1 &&
    dirty.dirtySamples === samples + 2 &&
    dirty.structuralWasFull === true,
  `fullScans=${String(dirty.fullScans)} dirtyFallbacks=${String(dirty.dirtyFallbacks)} ` +
    `structuralWasFull=${String(dirty.structuralWasFull)}`,
)
check(
  'dirty path is cheaper than a full desktop pass',
  Number.isFinite(dirty.perDirtyMs) &&
    Number.isFinite(full.perSampleMs) &&
    dirty.perDirtyMs < full.perSampleMs,
  `dirty=${String(dirty.perDirtyMs)}ms full=${String(full.perSampleMs)}ms`,
)
check(
  'QPC callback-to-read lag is measured and non-negative',
  Number.isFinite(dirty.eventToReadMs) && dirty.eventToReadMs >= 0,
  `eventToReadMs=${String(dirty.eventToReadMs)}`,
)

console.log(
  `  measured full ${String(full.perSampleMs)} ms/sample; ` +
    `dirty ${String(dirty.perDirtyMs)} ms/sample; ` +
    `${String(full.bytesPerSample)} vs ${String(dirty.bytesPerDirty)} bytes`,
)

if (failures.length > 0) {
  console.error(`context-host dirty check failed: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  console.log('context-host dirty check passed')
}
