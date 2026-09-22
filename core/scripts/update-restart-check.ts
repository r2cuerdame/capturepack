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
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import {
  beginRun,
  endRun,
  previousRunVanished,
  resetLifecycleForTesting,
} from '../src/main/lifecycle'
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

console.log('\nATOMIC MARKER WRITES VIA TEMPORARY FILE (#223)')
resetLifecycleForTesting()
if (existsSync(markerFile)) unlinkSync(markerFile)
if (existsSync(`${markerFile}.tmp`)) unlinkSync(`${markerFile}.tmp`)

check('fresh profile has no previous run', beginRun() === null)
check('previousRunVanished is false on fresh profile', previousRunVanished() === false)
check('marker is written on beginRun', existsSync(markerFile))
check('no temporary marker is left lingering after writeMarker', !existsSync(`${markerFile}.tmp`))
endRun()
check('no temporary marker is left lingering after endRun', !existsSync(`${markerFile}.tmp`))

console.log('\nRECOVERY FROM 0-BYTE CORRUPTED MARKER FILE (#223)')
resetLifecycleForTesting()
writeFileSync(markerFile, '', 'utf8')
if (existsSync(`${markerFile}.tmp`)) unlinkSync(`${markerFile}.tmp`)

const prevFromZeroByte = beginRun()
check(
  'a 0-byte corrupted marker is recognized as an existing previous run',
  prevFromZeroByte !== null,
)
check(
  'previousRunVanished() reports true for 0-byte corrupted marker',
  previousRunVanished() === true,
)
check(
  'status is vanished for 0-byte corrupted marker',
  prevFromZeroByte?.status === 'vanished',
  `status=${String(prevFromZeroByte?.status)}`,
)
check(
  'record has valid date string for lastAliveAt',
  typeof prevFromZeroByte?.record.lastAliveAt === 'string' &&
    !Number.isNaN(new Date(prevFromZeroByte.record.lastAliveAt).getTime()),
  `lastAliveAt=${String(prevFromZeroByte?.record.lastAliveAt)}`,
)
endRun()

console.log('\nRECOVERY FROM TRUNCATED JSON MARKER FILE (#223)')
resetLifecycleForTesting()
const truncatedTargetJson =
  '{"version":"0.5.0","startedAt":"2026-09-22T01:00:00.000Z","lastAliveAt":"2026-09-22T01:05:00.000Z"'
writeFileSync(markerFile, truncatedTargetJson, 'utf8')
if (existsSync(`${markerFile}.tmp`)) unlinkSync(`${markerFile}.tmp`)

const prevFromTruncated = beginRun()
check(
  'a truncated JSON marker is recognized as a previous run',
  prevFromTruncated !== null,
)
check(
  'previousRunVanished() reports true for truncated JSON marker',
  previousRunVanished() === true,
)
check(
  'status is vanished for truncated JSON marker',
  prevFromTruncated?.status === 'vanished',
  `status=${String(prevFromTruncated?.status)}`,
)
check(
  'forensic version is recovered from truncated JSON',
  prevFromTruncated?.record.version === '0.5.0',
  `version=${String(prevFromTruncated?.record.version)}`,
)
check(
  'forensic startedAt is recovered from truncated JSON',
  prevFromTruncated?.record.startedAt === '2026-09-22T01:00:00.000Z',
  `startedAt=${String(prevFromTruncated?.record.startedAt)}`,
)
check(
  'forensic lastAliveAt is recovered from truncated JSON',
  prevFromTruncated?.record.lastAliveAt === '2026-09-22T01:05:00.000Z',
  `lastAliveAt=${String(prevFromTruncated?.record.lastAliveAt)}`,
)
endRun()

console.log('\nRECOVERY FROM LINGERING .TMP FILE (VALID JSON) (#223)')
resetLifecycleForTesting()
writeFileSync(
  markerFile,
  JSON.stringify({
    version: '0.5.0',
    startedAt: '2026-09-22T00:00:00.000Z',
    lastAliveAt: '2026-09-22T00:01:00.000Z',
    exit: 'user-quit',
    faults: 0,
    firstFaultAt: null,
    firstFaultSummary: null,
  }),
  'utf8',
)
writeFileSync(
  `${markerFile}.tmp`,
  JSON.stringify({
    version: '0.5.0',
    startedAt: '2026-09-22T02:00:00.000Z',
    lastAliveAt: '2026-09-22T02:10:00.000Z',
    exit: null,
    faults: 2,
    firstFaultAt: '2026-09-22T02:05:00.000Z',
    firstFaultSummary: 'fatal test error',
  }),
  'utf8',
)

const prevFromValidTmp = beginRun()
check(
  'lingering .tmp prevents false clean exit report from old marker',
  prevFromValidTmp !== null && prevFromValidTmp.status === 'vanished',
  `status=${String(prevFromValidTmp?.status)}`,
)
check(
  'previousRunVanished() reports true when lingering .tmp exists',
  previousRunVanished() === true,
)
check(
  'in-flight lastAliveAt from .tmp is preserved',
  prevFromValidTmp?.record.lastAliveAt === '2026-09-22T02:10:00.000Z',
  `lastAliveAt=${String(prevFromValidTmp?.record.lastAliveAt)}`,
)
check(
  'in-flight faults from .tmp are preserved',
  prevFromValidTmp?.record.faults === 2,
  `faults=${String(prevFromValidTmp?.record.faults)}`,
)
check(
  'lingering .tmp file is cleaned up after detection',
  !existsSync(`${markerFile}.tmp`),
)
endRun()

console.log('\nRECOVERY FROM LINGERING .TMP FILE (TRUNCATED JSON) (#223)')
resetLifecycleForTesting()
writeFileSync(
  markerFile,
  JSON.stringify({
    version: '0.5.0',
    startedAt: '2026-09-22T00:00:00.000Z',
    lastAliveAt: '2026-09-22T00:01:00.000Z',
    exit: 'user-quit',
    faults: 0,
    firstFaultAt: null,
    firstFaultSummary: null,
  }),
  'utf8',
)
writeFileSync(
  `${markerFile}.tmp`,
  '{"version":"0.5.0","startedAt":"2026-09-22T03:00:00.000Z","lastAliveAt":"2026-09-22T03:08:00.000Z"',
  'utf8',
)

const prevFromTruncTmp = beginRun()
check(
  'truncated .tmp overrides old clean marker and reports vanished',
  prevFromTruncTmp !== null && prevFromTruncTmp.status === 'vanished',
  `status=${String(prevFromTruncTmp?.status)}`,
)
check(
  'previousRunVanished() reports true for truncated .tmp',
  previousRunVanished() === true,
)
check(
  'forensic lastAliveAt recovered from truncated .tmp',
  prevFromTruncTmp?.record.lastAliveAt === '2026-09-22T03:08:00.000Z',
  `lastAliveAt=${String(prevFromTruncTmp?.record.lastAliveAt)}`,
)
endRun()

console.log('\nCRASH DURING FIRST RUN WRITE (#223)')
resetLifecycleForTesting()
if (existsSync(markerFile)) unlinkSync(markerFile)
writeFileSync(`${markerFile}.tmp`, '', 'utf8')

const prevFirstRunCrash = beginRun()
check(
  '0-byte .tmp on first run is not treated as clean empty install',
  prevFirstRunCrash !== null && prevFirstRunCrash.status === 'vanished',
  `status=${String(prevFirstRunCrash?.status)}`,
)
check(
  'previousRunVanished() reports true for first run crash',
  previousRunVanished() === true,
)
endRun()
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

console.log('\nATOMICITY AND RECOVERY CONTRACT IN LIFECYCLE SOURCE (#223)')
const lifecycleSource = readFileSync(path.join(process.cwd(), 'src/main/lifecycle.ts'), 'utf8')
check(
  'writeMarker uses a temporary file and renameSync',
  /const\s+temporary\s*=\s*`\$\{target\}\.tmp`/u.test(lifecycleSource) &&
    /fs\.renameSync\(temporary,\s*target\)/u.test(lifecycleSource),
)
check(
  'writeMarker does not write target directly in-place',
  !/fs\.writeFileSync\(target,/u.test(lifecycleSource) &&
    !/fs\.writeFileSync\(runStateFile\(\),/u.test(lifecycleSource),
)
check(
  'readPreviousRun handles lingering .tmp files and corrupted markers',
  lifecycleSource.includes('temporaryExists') &&
    lifecycleSource.includes('recoverInterruptedRun'),
)

if (failed > 0) {
  console.error(`\nupdate-restart-check failed: ${failed}`)
  process.exitCode = 1
} else {
  console.log('\nupdate-restart-check ok')
}
