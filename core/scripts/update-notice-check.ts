// The update-ready announcement policy (#147): when a waiting update is allowed
// to speak again, and proof that the rule is actually wired to the app.
//
// This machine ran 0.4.4 for twenty hours with 0.4.5 downloaded and waiting. The
// updater logged "downloaded v0.4.5" six times, the toast fired once — at the
// moment the user was away from the desk — and the process was then killed
// rather than quit, so autoInstallOnAppQuit never ran. Every unit was correct
// and the user stayed a release behind.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { UPDATE_RENOTICE_MS, shouldAnnounceUpdate } from '../src/main/updateNotice'

let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (!condition) failed += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

const DAY = 24 * 60 * 60 * 1000
const announce = (input: {
  readyVersion: string | null
  announcedVersion: string | null
  announcedAtMs: number
  nowMs: number
  renoticeMs?: number
}): boolean => shouldAnnounceUpdate(input)

console.log('THE INTERVAL')
check('the re-notice interval is one day', UPDATE_RENOTICE_MS === DAY, `${UPDATE_RENOTICE_MS} ms`)

console.log('\nNOTHING IS WAITING')
check(
  'no ready version says nothing, however long it has been',
  !announce({ readyVersion: null, announcedVersion: null, announcedAtMs: 0, nowMs: 10 * DAY }),
)
check(
  'no ready version says nothing even after a version was once announced',
  !announce({ readyVersion: null, announcedVersion: '0.4.5', announcedAtMs: 0, nowMs: 10 * DAY }),
)

console.log('\nAN UPDATE ARRIVES')
check(
  'a version nobody has been told about is announced at once',
  announce({ readyVersion: '0.4.5', announcedVersion: null, announcedAtMs: 0, nowMs: 1_000 }),
)
check(
  'a NEWER update arriving while an older one waits does not serve out the old timer',
  announce({
    readyVersion: '0.4.6',
    announcedVersion: '0.4.5',
    announcedAtMs: 1_000,
    nowMs: 1_000 + 60_000,
  }),
)

console.log('\nTHE SAME UPDATE, STILL WAITING')
const waiting = { readyVersion: '0.4.5', announcedVersion: '0.4.5', announcedAtMs: 1_000 }
check('one millisecond later: silent', !announce({ ...waiting, nowMs: 1_001 }))
check('four hours later — a whole check cycle: silent', !announce({ ...waiting, nowMs: 1_000 + 4 * 60 * 60 * 1000 }))
check('one minute short of a day: still silent', !announce({ ...waiting, nowMs: 1_000 + DAY - 60_000 }))
check('exactly a day: announced', announce({ ...waiting, nowMs: 1_000 + DAY }))
check('a week later: announced', announce({ ...waiting, nowMs: 1_000 + 7 * DAY }))

console.log('\nTHE CLOCK IS NOT TRUSTED TO MOVE FORWARDS')
check(
  'a clock that went backwards is not read as a day having passed',
  !announce({ ...waiting, nowMs: 1_000 - 10 * DAY }),
)

console.log('\nNEGATIVE CONTROLS')
check(
  'NEGATIVE CONTROL: with the interval set to zero the same version speaks again immediately — so the silence above is the INTERVAL, not a version comparison that can never fire',
  announce({ ...waiting, nowMs: 1_001, renoticeMs: 0 }),
)
check(
  'NEGATIVE CONTROL: an enormous interval silences even a week — so "announced" above is the interval elapsing, not the function returning true regardless',
  !announce({ ...waiting, nowMs: 1_000 + 7 * DAY, renoticeMs: 365 * DAY }),
)

// A CHECK CAN EXIST, BE CORRECT, AND BE WIRED TO NOTHING.
//
// That trap has cost this project a release cycle before. The policy above is
// only worth anything if the running app asks it, so the wiring is asserted too.
console.log('\nTHE APP ACTUALLY ASKS')
const indexSource = readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8')
const noticeSource = readFileSync(path.join(process.cwd(), 'src/main/updateNotice.ts'), 'utf8')

check(
  'index.ts imports the policy from its own module',
  indexSource.includes("import { shouldAnnounceUpdate } from './updateNotice'"),
)
check(
  'index.ts asks it before showing the notice',
  indexSource.includes('!shouldAnnounceUpdate({'),
)
check(
  'index.ts remembers WHEN it announced, not only what',
  indexSource.includes('let notifiedAtMs = 0') && indexSource.includes('notifiedAtMs = Date.now()'),
)
check(
  'the once-per-process guard that caused #147 is gone',
  !indexSource.includes('readyVersion === notifiedVersion'),
  'index.ts still short-circuits on the remembered version alone',
)
check(
  'the policy module imports nothing, so this check needs no Electron stub and cannot drift behind one',
  // Statements only — the prose above the code says the word "import" and an
  // includes() on it passed for the wrong reason until this was tightened.
  noticeSource.split(/\r?\n/u).every((line) => !line.trimStart().startsWith('import ')),
  noticeSource
    .split(/\r?\n/u)
    .filter((line) => line.trimStart().startsWith('import '))
    .join(' | '),
)

if (failed > 0) {
  console.error(`\nupdate-notice-check failed: ${failed}`)
  process.exitCode = 1
} else {
  console.log('\nupdate-notice-check ok')
}
