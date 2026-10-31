import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import {
  INSTALL_IDLE_POLL_MS,
  RUN_ONCE_KEY,
  RUN_ONCE_VALUE,
  compareVersions,
  createIdleGate,
  nextPendingUpdate,
  pendingUpdateFile,
  readPendingUpdate,
  runOnceArgs,
  sessionEndRelaunch,
  startupInstallArgs,
  startupUpdateDecision,
  writePendingUpdate,
  type IdleGateTimers,
  type PendingUpdate,
} from '../src/main/updateInstall'
import {
  installPendingUpdateBeforeCapture,
  restartAndUpdate,
  setUpdateInstallBusyProbe,
} from '../src/main/updater'

let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (!condition) failed += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

const sha = (bytes: Buffer): string => createHash('sha512').update(bytes).digest('base64')
const pending = (overrides: Partial<PendingUpdate> = {}): PendingUpdate => ({
  version: '0.6.1',
  installerPath: 'C:\\cache\\CapturePack-Setup-0.6.1.exe',
  sha512: 'abc',
  startupAttemptFrom: null,
  ...overrides,
})

async function main(): Promise<void> {
  console.log('VERSION ORDER')
  check('newer patch is newer', compareVersions('0.6.1', '0.6.0') === 1)
  check('same version is equal', compareVersions('0.6.0', 'v0.6.0') === 0)
  check('older minor is older', compareVersions('0.5.9', '0.6.0') === -1)
  check('a prerelease precedes its release', compareVersions('0.7.0-rc.1', '0.7.0') === -1)
  check('rc.10 follows rc.2', compareVersions('0.7.0-rc.10', '0.7.0-rc.2') === 1)
  check('an unreadable version has no order', compareVersions('latest', '0.6.0') === null)

  console.log('\nA KILLED RUN: THE NEXT START INSTALLS BEFORE CAPTURE')
  const decide = (p: PendingUpdate | null, hash: string | null = 'abc', autoInstall = true) =>
    startupUpdateDecision({ pending: p, currentVersion: '0.6.0', autoInstall, installerSha512: hash })
  check('nothing waiting starts normally', decide(null).kind === 'none')
  check('a verified newer download installs first', decide(pending()).kind === 'install')
  check('the already installed version is dropped', decide(pending({ version: '0.6.0' })).kind === 'clear')
  check('an older download is dropped', decide(pending({ version: '0.5.0' })).kind === 'clear')
  check('a vanished installer is dropped', decide(pending(), null).kind === 'clear')
  check('an installer whose bytes changed is never executed', decide(pending(), 'tampered').kind === 'clear')
  check('automatic updates turned off keep the download without installing', decide(pending(), 'abc', false).kind === 'keep')
  check(
    'a failed attempt from this version is not retried at every start',
    decide(pending({ startupAttemptFrom: '0.6.0' })).kind === 'keep',
  )
  check(
    'an attempt recorded by an older build does not block this one',
    decide(pending({ startupAttemptFrom: '0.5.9' })).kind === 'install',
  )
  check(
    'the startup install is silent and relaunches the app',
    JSON.stringify(startupInstallArgs()) === JSON.stringify(['--updated', '/S', '--force-run']),
  )

  console.log('\nTHE DOWNLOAD RECORD')
  const attempted = pending({ startupAttemptFrom: '0.6.0' })
  check(
    'a re-validated identical download keeps its attempt',
    nextPendingUpdate(attempted, { version: '0.6.1', installerPath: attempted.installerPath, sha512: 'abc' })
      .startupAttemptFrom === '0.6.0',
  )
  check(
    'a newer download gets a fresh attempt',
    nextPendingUpdate(attempted, { version: '0.6.2', installerPath: 'C:\\cache\\b.exe', sha512: 'def' })
      .startupAttemptFrom === null,
  )

  console.log('\nWINDOWS SHUTDOWN: RELAUNCH AT NEXT BOOT')
  const relaunch = (overrides: Partial<Parameters<typeof sessionEndRelaunch>[0]> = {}) =>
    sessionEndRelaunch({
      reasons: ['shutdown'],
      pending: pending(),
      currentVersion: '0.6.0',
      autoInstall: true,
      launchAtLogin: false,
      ...overrides,
    })
  check('shutdown with an update waiting arms the next sign-in run', relaunch())
  check('logoff counts as the session ending', relaunch({ reasons: ['logoff'] }))
  check('launch at login already relaunches, so no second launcher is added', !relaunch({ launchAtLogin: true }))
  check('Restart Manager close-app is not a shutdown', !relaunch({ reasons: ['close-app'] }))
  check('nothing waiting arms nothing', !relaunch({ pending: null }))
  check('automatic updates off arms nothing', !relaunch({ autoInstall: false }))
  check('an installed version arms nothing', !relaunch({ pending: pending({ version: '0.6.0' }) }))
  check(
    'an already failed attempt arms nothing',
    !relaunch({ pending: pending({ startupAttemptFrom: '0.6.0' }) }),
  )
  const runOnce = runOnceArgs('C:\\Apps\\CapturePack\\CapturePack.exe', '--openAsHidden')
  check(
    'the relaunch is a one-shot per-user RunOnce entry started hidden',
    runOnce.includes(RUN_ONCE_KEY) &&
      runOnce.includes(RUN_ONCE_VALUE) &&
      RUN_ONCE_KEY.startsWith('HKCU\\') &&
      runOnce.includes('"C:\\Apps\\CapturePack\\CapturePack.exe" --openAsHidden'),
    runOnce.join(' '),
  )

  console.log('\nCAPTURE/SAVE IN PROGRESS: DEFERRED, NEVER CANCELLED')
  const queue: Array<{ run: () => void; ms: number; live: boolean }> = []
  const timers: IdleGateTimers = {
    set: (run, ms) => {
      const entry = { run, ms, live: true }
      queue.push(entry)
      return entry
    },
    clear: (handle) => {
      ;(handle as { live: boolean }).live = false
    },
  }
  const tick = (): void => {
    const next = queue.shift()
    if (next?.live === true) next.run()
  }
  let busy = false
  let installs = 0
  let deferrals = 0
  const gate = createIdleGate({
    isBusy: () => busy,
    run: () => {
      installs += 1
    },
    onDeferred: () => {
      deferrals += 1
    },
    timers,
  })
  check('idle installs at once', gate.request() === 'now' && installs === 1)
  busy = true
  check('busy defers', gate.request() === 'deferred' && installs === 1 && deferrals === 1)
  check('a second request while waiting is not a second install', gate.request() === 'already-pending')
  tick()
  tick()
  check('still busy, still waiting', installs === 1 && gate.pending())
  busy = false
  tick()
  check('installs exactly once when the work is done', installs === 2 && !gate.pending())
  check('nothing else is left scheduled', queue.every((entry) => !entry.live) || queue.length === 0)
  const throwing = createIdleGate({
    isBusy: () => {
      throw new Error('probe broke')
    },
    run: () => {
      installs += 1
    },
    timers,
  })
  check('a broken busy probe is read as busy, not idle', throwing.request() === 'deferred' && installs === 2)
  throwing.cancel()

  console.log('\nTHE APP DEFERS RESTART AND UPDATE')
  const calls = (autoUpdater as unknown as { calls: unknown[][] }).calls
  let appBusy = true
  setUpdateInstallBusyProbe(() => appBusy)
  restartAndUpdate()
  restartAndUpdate()
  check('no installer is started while a capture/save runs', calls.length === 0, JSON.stringify(calls))
  appBusy = false
  await new Promise((resolve) => setTimeout(resolve, INSTALL_IDLE_POLL_MS + 300))
  check(
    'the install follows exactly once after the work ends',
    calls.length === 1 && calls[0]?.[0] === false && calls[0]?.[1] === true,
    JSON.stringify(calls),
  )

  console.log('\nTHE STARTUP INSTALL, END TO END')
  const userData = app.getPath('userData')
  mkdirSync(userData, { recursive: true })
  const marker = pendingUpdateFile(userData)
  check('no record means a normal start', (await installPendingUpdateBeforeCapture(true)) === false)

  const installer = process.execPath
  const installerSha = sha(readFileSync(installer))
  writePendingUpdate(marker, pending({ installerPath: installer, sha512: installerSha }))
  check('a verified newer download starts the installer', (await installPendingUpdateBeforeCapture(true)) === true)
  check(
    'the attempt is recorded before the app quits',
    readPendingUpdate(marker)?.startupAttemptFrom === app.getVersion(),
    JSON.stringify(readPendingUpdate(marker)),
  )
  check(
    'a start after a failed install continues on the current version instead of looping',
    (await installPendingUpdateBeforeCapture(true)) === false,
  )

  writePendingUpdate(marker, pending({ installerPath: installer, sha512: 'not-the-bytes' }))
  check('mismatched bytes are not executed', (await installPendingUpdateBeforeCapture(true)) === false)
  check('and their record is dropped', !existsSync(marker))

  writePendingUpdate(marker, pending({ version: app.getVersion(), installerPath: installer, sha512: installerSha }))
  check('the installed version starts normally', (await installPendingUpdateBeforeCapture(true)) === false)
  check('and its record is dropped', !existsSync(marker))

  const notAnExecutable = path.join(userData, 'not-an-installer.txt')
  writeFileSync(notAnExecutable, 'plain text', 'utf8')
  writePendingUpdate(
    marker,
    pending({ installerPath: notAnExecutable, sha512: sha(readFileSync(notAnExecutable)) }),
  )
  check(
    'an installer that cannot start leaves the app running',
    (await installPendingUpdateBeforeCapture(true)) === false,
  )
  check(
    'and is not retried at the next start',
    readPendingUpdate(marker)?.startupAttemptFrom === app.getVersion(),
  )

  console.log('\nWIRING')
  const indexSource = readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8')
  const updaterSource = readFileSync(path.join(process.cwd(), 'src/main/updater.ts'), 'utf8')
  const at = (needle: string): number => indexSource.indexOf(needle)
  const install = at('await installPendingUpdateBeforeCapture(settings.autoUpdateCheck)')
  check('index.ts installs a waiting update at startup', install !== -1)
  check(
    'the startup install runs before MCP, capture, the tray and the updater start',
    install !== -1 &&
      install > at('loadSettings()') &&
      install < at('startMcpAtBoot(settings)') &&
      install < at('await startCapture(settings)') &&
      install < at('initUpdater({'),
  )
  check(
    'a started install quits instead of continuing startup',
    /await installPendingUpdateBeforeCapture\(settings\.autoUpdateCheck\)\)\s*\{\s*app\.quit\(\)\s*return\s*\}/u.test(
      indexSource,
    ),
  )
  check(
    'the restart waits on the capture flow and pack operations',
    /setUpdateInstallBusyProbe\(\(\) => captureFlowActive\(\) \|\| anyPackOperationActive\(\)\)/u.test(indexSource),
  )
  check(
    'session end arms the next-boot relaunch',
    /window\.on\('session-end'[\s\S]*?relaunchAfterSessionEnd\(/u.test(indexSource),
  )
  check(
    'every download is remembered for a killed run',
    /'update-downloaded'[\s\S]*?rememberDownloadedUpdate\(info\.version, info\.downloadedFile\)/u.test(updaterSource),
  )
  check(
    'a graceful quit still installs through autoInstallOnAppQuit',
    updaterSource.includes('autoUpdater.autoInstallOnAppQuit = opts.autoCheck'),
  )
}

main()
  .catch((err: unknown) => {
    failed += 1
    console.error(err)
  })
  .finally(() => {
    if (failed > 0) {
      console.error(`\nupdate-install-check failed: ${failed}`)
      process.exitCode = 1
    } else {
      console.log('\nupdate-install-check ok')
    }
  })
