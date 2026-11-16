// Log rotation must never be what switches the log off (issue #531).
//
// rotateLogFiles dropped the oldest generation outside the per-step guard, so a
// main.5.log held open by an antivirus scan or an editor threw on every rotation;
// write() counted each throw as a failed write and, after MAX_WRITE_FAILURES,
// stopped writing main.log for the rest of the run. This drives the real
// logInfo() against a temporary userData folder. A held-open generation is a
// non-empty directory sitting in that generation's slot: it can be neither
// deleted nor renamed over, on Windows and elsewhere alike.
//
// log.ts keeps its byte counter and its enabled flag in module state, so each
// scenario runs in its own process (see log-rotation-check.mjs).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { logInfo } from '../src/main/log'

const MAX_LOG_BYTES = 1_048_576
const KEPT_GENERATIONS = 5
// About ten lines to a megabyte: every scenario rotates many times without
// writing thousands of lines.
const LINE_PAYLOAD = 'x'.repeat(100_000)

let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (!condition) failed += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

// The electron stub's app.getPath reads this on every call, which is when
// log.ts asks for it — never at import.
const userData = mkdtempSync(path.join(tmpdir(), 'capturepack-log-rotation-'))
process.env.CAPTUREPACK_LOG_CHECK_USERDATA = userData
const logs = path.join(userData, 'logs')
const live = path.join(logs, 'main.log')
const generation = (n: number): string => path.join(logs, `main.${String(n)}.log`)

// The module under test echoes every line to the console; a megabyte of x's
// per rotation would bury the verdicts. What it reports through console.error
// is kept, because "file logging disabled" is one of the things checked.
const consoleErrors: string[] = []
const quiet = <T>(fn: () => T): T => {
  const saved = { info: console.info, warn: console.warn, error: console.error }
  console.info = () => {}
  console.warn = () => {}
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(' '))
  }
  try {
    return fn()
  } finally {
    Object.assign(console, saved)
  }
}

function writeLine(seq: number): void {
  quiet(() => logInfo(`seq=${String(seq)} ${LINE_PAYLOAD}`))
}

function seqsIn(file: string): number[] {
  if (!existsSync(file) || !statSync(file).isFile()) return []
  return [...readFileSync(file, 'utf8').matchAll(/seq=(\d+) /gu)].map((m) => Number(m[1]))
}

function lockSlot(file: string): void {
  mkdirSync(file, { recursive: true })
  writeFileSync(path.join(file, 'held-open'), 'held by another program')
}

function stillLocked(file: string): boolean {
  return (
    existsSync(file) &&
    statSync(file).isDirectory() &&
    readFileSync(path.join(file, 'held-open'), 'utf8') === 'held by another program'
  )
}

function scenarioRotation(): void {
  console.log('NOTHING LOCKED: five generations, oldest dropped first')
  const total = 80
  for (let seq = 0; seq < total; seq += 1) writeLine(seq)
  const liveSeqs = seqsIn(live)
  check('the last line is in main.log', liveSeqs.includes(total - 1))
  check(
    `main.log stays at or under ${String(MAX_LOG_BYTES)} bytes`,
    statSync(live).size <= MAX_LOG_BYTES,
    `${String(statSync(live).size)} bytes`,
  )
  const kept = Array.from({ length: KEPT_GENERATIONS }, (_, i) => seqsIn(generation(i + 1)))
  check(
    `main.1.log .. main.${String(KEPT_GENERATIONS)}.log all exist and hold lines`,
    kept.every((seqs) => seqs.length > 0),
    kept.map((seqs, i) => `main.${String(i + 1)}: ${String(seqs.length)}`).join(', '),
  )
  const names = readdirSync(logs).sort()
  check(
    `nothing past main.${String(KEPT_GENERATIONS)}.log is kept`,
    names.length === KEPT_GENERATIONS + 1 && !existsSync(generation(KEPT_GENERATIONS + 1)),
    names.join(', '),
  )
  // Newest first, contiguous: each generation ends right where the next newer
  // one begins, so no rotation skipped or duplicated a file.
  const ordered = [...kept].reverse().concat([liveSeqs])
  const flat = ordered.flat()
  const contiguous = flat.every((seq, i) => i === 0 || seq === (flat[i - 1] ?? -2) + 1)
  check(
    'generations run oldest (main.5) to newest (main.log) with no gap',
    contiguous && flat.at(-1) === total - 1,
    `first kept ${String(flat[0])}, last ${String(flat.at(-1))}`,
  )
  check(
    'the oldest lines are the ones that were dropped',
    (flat[0] ?? 0) > 0 && !flat.includes(0),
  )
  check('file logging was never disabled', consoleErrors.length === 0, consoleErrors.join(' | '))
}

function scenarioLockedOldest(): void {
  console.log('OLDEST GENERATION HELD OPEN: the rotation still happens')
  mkdirSync(logs, { recursive: true })
  lockSlot(generation(KEPT_GENERATIONS))

  // Fill main.log to the point where the next line must rotate it.
  let seq = 0
  while (!existsSync(generation(1))) {
    writeLine(seq)
    seq += 1
    if (seq > 40) break
  }
  const firstRotationAt = seq - 1
  check('main.log rotated to main.1.log despite the held-open main.5.log', existsSync(generation(1)))
  check(
    'the line that triggered the rotation is in the new main.log',
    seqsIn(live).includes(firstRotationAt) && !seqsIn(generation(1)).includes(firstRotationAt),
    `main.log holds ${JSON.stringify(seqsIn(live))}`,
  )
  check(
    'main.1.log holds what main.log held before the rotation',
    seqsIn(generation(1)).length > 0 && seqsIn(generation(1)).at(-1) === firstRotationAt - 1,
  )

  // Keep going well past MAX_WRITE_FAILURES rotations against the same lock.
  const rotationsBefore = seq
  for (let i = 0; i < 100; i += 1) {
    writeLine(seq)
    seq += 1
  }
  const marker = seq
  writeLine(marker)
  check(
    `still writing after ~${String(Math.floor((seq - rotationsBefore) / 10))} more rotations against the lock`,
    seqsIn(live).includes(marker),
    `main.log last seq ${String(seqsIn(live).at(-1))}`,
  )
  check(
    'file logging was never disabled',
    !consoleErrors.some((line) => line.includes('file logging disabled')),
    consoleErrors.join(' | '),
  )
  check('the held-open generation was left as it was', stillLocked(generation(KEPT_GENERATIONS)))
  const newest = [1, 2, 3, 4].map((n) => seqsIn(generation(n)))
  const flat = [...newest].reverse().concat([seqsIn(live)]).flat()
  check(
    'main.4.log .. main.log still hold the newest lines, in order, with no gap',
    newest.every((seqs) => seqs.length > 0) &&
      flat.every((s, i) => i === 0 || s === (flat[i - 1] ?? -2) + 1) &&
      flat.at(-1) === marker,
    newest.map((s, i) => `main.${String(i + 1)}: ${String(s[0])}..${String(s.at(-1))}`).join(', '),
  )
}

function scenarioLockedLive(): void {
  console.log('MAIN.LOG ITSELF CANNOT MOVE: still a write failure, as before')
  mkdirSync(logs, { recursive: true })
  for (let n = 1; n <= KEPT_GENERATIONS; n += 1) lockSlot(generation(n))
  // A full main.log, so the very first line has to rotate it.
  writeFileSync(live, `${'y'.repeat(MAX_LOG_BYTES - 10)}\n`)
  const before = statSync(live).size

  writeLine(0)
  writeLine(1)
  check(
    'two failed rotations do not yet disable file logging',
    !consoleErrors.some((line) => line.includes('file logging disabled')),
  )
  writeLine(2)
  check(
    'the third consecutive failure disables file logging, exactly as before',
    consoleErrors.filter((line) => line.includes('file logging disabled')).length === 1,
    consoleErrors.join(' | '),
  )
  check('main.log was neither rotated nor appended to', statSync(live).size === before)
  for (let n = 1; n <= KEPT_GENERATIONS; n += 1) rmSync(generation(n), { recursive: true, force: true })
  writeLine(3)
  check(
    'once disabled it stays disabled for the run',
    statSync(live).size === before && !existsSync(generation(1)),
  )
}

const scenarios: Record<string, () => void> = {
  rotation: scenarioRotation,
  'locked-oldest': scenarioLockedOldest,
  'locked-live': scenarioLockedLive,
}

const name = process.argv[2] ?? ''
const scenario = scenarios[name]
try {
  if (scenario === undefined) {
    console.error(`unknown scenario "${name}"; expected one of ${Object.keys(scenarios).join(', ')}`)
    failed += 1
  } else {
    scenario()
  }
} finally {
  rmSync(userData, { recursive: true, force: true })
}

console.log(`${failed === 0 ? `log-rotation-check ${name} ok` : `${String(failed)} failure(s)`}\n`)
if (failed > 0) process.exitCode = 1
