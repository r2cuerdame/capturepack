// Every "Restart and update" leaves an honest exit marker (#182).
//
// The tray menu recorded noteExitIntent('update-restart') before calling
// restartAndUpdate(); the About window's Restart button and the update toast
// called restartAndUpdate() directly, so the two most common update paths
// closed run-state.json as 'unknown' and the next start read "(unknown)" where
// it should have read "(update-restart)". The intent belongs INSIDE
// restartAndUpdate(), where no caller can forget it.
//
// Runs against the real updater.ts and lifecycle.ts with electron and
// electron-updater stubbed: quitAndInstall is recorded, not executed, and
// will-quit is stood in for by calling endRun() the way index.ts does.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { beginRun, endRun } from '../src/main/lifecycle'
import { restartAndUpdate } from '../src/main/updater'

let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (!condition) failed += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

const recorded = (autoUpdater as unknown as { calls: unknown[][] }).calls
const markerFile = path.join(app.getPath('userData'), 'run-state.json')
const readMarker = (): { exit: unknown; faults: unknown } =>
  JSON.parse(readFileSync(markerFile, 'utf8')) as { exit: unknown; faults: unknown }

console.log('A RESTART FROM ANY CALLER')
// First run: nothing came before it.
check('a fresh profile has no previous run', beginRun() === null)
check('the marker opens with no exit recorded', readMarker().exit === null)

// This is exactly what the About window's Restart button and the update toast
// do — restartAndUpdate() and nothing else. No caller-side noteExitIntent.
restartAndUpdate()

check(
  'restartAndUpdate still performs the one permitted quitAndInstall(false, true)',
  recorded.length === 1 && recorded[0]?.[0] === false && recorded[0]?.[1] === true,
  JSON.stringify(recorded),
)

// will-quit follows the quitAndInstall; index.ts closes the marker there.
endRun()
const closed = readMarker()
check(
  'run-state.json records the exit as update-restart, not unknown',
  closed.exit === 'update-restart',
  `exit=${String(closed.exit)}`,
)

console.log('\nTHE NEXT START READS IT BACK')
const previous = beginRun()
check(
  'the next run sees the previous one as a clean update-restart',
  previous !== null && previous.status === 'clean' && previous.record.exit === 'update-restart',
  previous === null ? 'no previous run' : `${previous.status}/${String(previous.record.exit)}`,
)
endRun()

// A CHECK CAN EXIST, BE CORRECT, AND BE WIRED TO NOTHING.
//
// The runtime proof above is the fix; the source assertions below stop a
// refactor from moving the intent back to a caller site, where the About
// window and the toast would forget it again.
console.log('\nTHE INTENT LIVES IN ONE PLACE')
const updaterSource = readFileSync(path.join(process.cwd(), 'src/main/updater.ts'), 'utf8')
const indexSource = readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8')
const aboutSource = readFileSync(path.join(process.cwd(), 'src/main/aboutWindow.ts'), 'utf8')

check(
  'updater.ts records the intent itself',
  updaterSource.includes("import { noteExitIntent } from './lifecycle'") &&
    /export function restartAndUpdate\(\): void \{[\s\S]*?noteExitIntent\('update-restart'\)[\s\S]*?quitAndInstall\(false, true\)/u.test(
      updaterSource,
    ),
)
check(
  'the intent is recorded BEFORE quitAndInstall, so a synchronous quit path cannot outrun it',
  updaterSource.indexOf("noteExitIntent('update-restart')") !== -1 &&
    updaterSource.indexOf("noteExitIntent('update-restart')") <
      updaterSource.indexOf('quitAndInstall(false, true)'),
)
check(
  'no caller records update-restart on its own any more',
  !indexSource.includes("noteExitIntent('update-restart')") &&
    !aboutSource.includes("noteExitIntent('update-restart')"),
)
// Statements only: the comments explaining #182 name the function too.
const callSites = (source: string): number =>
  source
    .split(/\r?\n/u)
    .filter((line) => !line.trimStart().startsWith('//'))
    .filter((line) => line.includes('restartAndUpdate()')).length
check(
  'the three callers — tray, About window, toast — all still go through restartAndUpdate()',
  callSites(indexSource) === 2 && callSites(aboutSource) === 1,
  `index.ts=${callSites(indexSource)} aboutWindow.ts=${callSites(aboutSource)}`,
)

if (failed > 0) {
  console.error(`\nupdate-restart-check failed: ${failed}`)
  process.exitCode = 1
} else {
  console.log('\nupdate-restart-check ok')
}
