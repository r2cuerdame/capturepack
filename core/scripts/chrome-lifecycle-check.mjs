import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const work = mkdtempSync(path.join(tmpdir(), 'capturepack-chrome-lifecycle-'))

try {
  const bundle = path.join(work, 'check.cjs')
  execFileSync(
    process.execPath,
    [
      path.join(here, '..', 'node_modules', 'esbuild', 'bin', 'esbuild'),
      path.join(here, 'chrome-lifecycle-check.ts'),
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--outfile=${bundle}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  execFileSync(process.execPath, [bundle], { stdio: 'inherit' })

  let failed = 0
  let connected = 0
  let reloads = 0
  let loadedExtensionVersion = '0.1.8'
  let runtimeLastError = null
  let runtimeLastErrorReads = 0
  let nextTimer = 1
  const timers = new Map()
  const ports = []
  const storageData = {}
  const event = () => ({ addListener() {} })

  function makePort() {
    const disconnectListeners = []
    const messageListeners = []
    const sent = []
    const port = {
      onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      postMessage: (message) => sent.push(message),
      disconnect() {
        for (const listener of disconnectListeners) listener()
      },
      sent,
      deliver(message) {
        for (const listener of messageListeners) listener(message)
      },
    }
    ports.push(port)
    return port
  }

  const chrome = {
    alarms: { create() {}, onAlarm: event() },
    runtime: {
      connectNative() {
        connected += 1
        return makePort()
      },
      getManifest: () => ({ version: loadedExtensionVersion }),
      reload() {
        reloads += 1
      },
      get lastError() {
        if (runtimeLastError !== null) runtimeLastErrorReads += 1
        return runtimeLastError
      },
      onInstalled: event(),
      onStartup: event(),
      onMessage: event(),
    },
    action: { setBadgeText() {}, onClicked: event() },
    storage: {
      local: {
        get(key, callback) {
          callback({ [key]: storageData[key] })
        },
        set(values, callback) {
          Object.assign(storageData, values)
          callback()
        },
        remove(key, callback) {
          delete storageData[key]
          callback()
        },
      },
    },
    tabs: { onActivated: event(), onUpdated: event() },
    scripting: { executeScript: async () => undefined },
  }
  const context = {
    chrome,
    console,
    Date,
    setTimeout(callback, delay) {
      const id = nextTimer++
      timers.set(id, { callback, delay })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
  }
  vm.runInNewContext(
    readFileSync(path.join(here, '..', '..', 'extensions', 'chrome', 'background.js'), 'utf8'),
    context,
  )

  const check = (name, condition) => {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}`)
    if (!condition) failed += 1
  }

  console.log('\nChrome extension service worker')
  const manifest = JSON.parse(
    readFileSync(path.join(here, '..', '..', 'extensions', 'chrome', 'manifest.json'), 'utf8'),
  )
  check('manifest ships the worker version under test', manifest.version === loadedExtensionVersion)
  check('manifest grants persistence for the one-shot reload guard',
    manifest.permissions?.includes('storage') === true)
  check('worker startup dials immediately', connected === 1)
  check('startup sends a hello', ports[0]?.sent[0]?.type === 'host.hello')
  ports[0].deliver({
    type: 'host.hello',
    protocol: 1,
    extensionVersion: '0.1.8',
  })
  check('a matching app hello keeps the current worker', reloads === 0)

  runtimeLastError = { message: 'Specified native messaging host not found.' }
  const lastErrorReadsBeforeDisconnect = runtimeLastErrorReads
  ports[0].disconnect()
  runtimeLastError = null
  check(
    'an expected native disconnect consumes runtime.lastError before retrying',
    runtimeLastErrorReads === lastErrorReadsBeforeDisconnect + 1,
  )
  const reconnectTimer = [...timers.values()].find((timer) => timer.delay === 2_000)
  check('a dropped native port schedules a reconnect', reconnectTimer !== undefined)
  reconnectTimer?.callback()
  check('the retry redials without a tab event', connected === 2)

  ports[1].deliver({
    type: 'host.hello',
    protocol: 1,
    extensionVersion: '0.1.9',
  })
  check('a newer bundled folder asks Chromium for one reload', reloads === 1)
  ports[1].deliver({
    type: 'host.hello',
    protocol: 1,
    extensionVersion: '0.1.9',
  })
  check('an unchanged manual folder cannot enter a reload loop', reloads === 1)

  loadedExtensionVersion = '0.2.0'
  ports[1].deliver({
    type: 'host.hello',
    protocol: 1,
    extensionVersion: '0.1.9',
  })
  check('an extension newer than the app is never reloaded or downgraded', reloads === 1)

  console.log('\nInstaller/native-host handoff')
  const installer = readFileSync(path.join(here, '..', 'build', 'installer.nsh'), 'utf8')
  const installerTemplate = readFileSync(
    path.join(here, '..', 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'installer.nsi'),
    'utf8',
  )
  const installSectionTemplate = readFileSync(
    path.join(here, '..', 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'installSection.nsh'),
    'utf8',
  )
  const runningTemplate = readFileSync(
    path.join(
      here,
      '..',
      'node_modules',
      'app-builder-lib',
      'templates',
      'nsis',
      'include',
      'allowOnlyOneInstallerInstance.nsh',
    ),
    'utf8',
  )
  const extractionTemplate = readFileSync(
    path.join(
      here,
      '..',
      'node_modules',
      'app-builder-lib',
      'templates',
      'nsis',
      'include',
      'extractAppPackage.nsh',
    ),
    'utf8',
  )
  const uninstallerTemplate = readFileSync(
    path.join(here, '..', 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'uninstaller.nsh'),
    'utf8',
  )
  const nativeEntry = readFileSync(
    path.join(here, '..', 'src', 'main', 'chrome', 'nativeHostEntry.ts'),
    'utf8',
  )
  const supervisor = readFileSync(
    path.join(here, '..', 'src', 'main', 'supervisor.ts'),
    'utf8',
  )
  const macro = (name) =>
    new RegExp(`!macro ${name}\\b([\\s\\S]*?)!macroend`, 'u').exec(installer)?.[1] ?? ''
  const closeGate = macro('customCheckAppRunning')
  const success = macro('customInstall')
  const uninstall = macro('customUnInstall')
  const oldUninstallResult = macro('customUnInstallCheck')
  check(
    'setup handoff starts after the installer mutex and inside the real process gate',
    !installer.includes('!macro preInit') &&
      closeGate.indexOf('!insertmacro IS_POWERSHELL_AVAILABLE') <
        closeGate.indexOf('!insertmacro FIND_PROCESS') &&
      closeGate.includes('!insertmacro BeginCapturePackShutdown') &&
      runningTemplate.includes('!insertmacro customCheckAppRunning') &&
      installerTemplate.indexOf('!insertmacro ALLOW_ONLY_ONE_INSTALLER_INSTANCE') <
        installerTemplate.indexOf('!include "installSection.nsh"') &&
      installSectionTemplate.indexOf('!insertmacro CHECK_APP_RUNNING') <
        installSectionTemplate.indexOf('!insertmacro uninstallOldVersion'),
  )
  check(
    'the shared install/uninstall gate unregisters every native host before killing processes',
    macro('BeginCapturePackShutdown').includes('!insertmacro DisableCapturePackNativeHost') &&
      closeGate.indexOf('!insertmacro BeginCapturePackShutdown') <
        closeGate.indexOf('taskkill /f /im "${APP_EXECUTABLE_FILENAME}"') &&
      ['Google\\Chrome', 'Microsoft\\Edge', 'BraveSoftware\\Brave-Browser', 'Chromium']
        .every((browser) => installer.includes(`${browser}\\NativeMessagingHosts\\com.capturepack.host`)),
  )
  check(
    'stand-down remains armed through replacement and releases only on success',
    success.includes('!insertmacro RestoreCapturePackIntegration') &&
      success.indexOf('!insertmacro RestoreCapturePackIntegration') <
        success.indexOf('Delete "$APPDATA\\CapturePack\\supervision-standdown"'),
  )
  check(
    'a cached Chrome host immediately stands down during install',
    nativeEntry.includes("'supervision-standdown'") &&
      nativeEntry.includes('if (installerStandingDown)') &&
      nativeEntry.includes('process.exit(0)'),
  )
  check(
    'an old updater cannot erase Chrome, login or fallback integration',
    macro('SnapshotCapturePackIntegration').includes('com.capturepack.host.json') &&
      macro('SnapshotCapturePackIntegration').includes('capturepack-host.cmd') &&
      macro('SnapshotCapturePackIntegration').includes('CurrentVersion\\Run') &&
      macro('SnapshotCapturePackIntegration').includes('capturepack-installer-state.ps1') &&
      macro('SnapshotCapturePackIntegration').includes('-Mode save') &&
      macro('RestoreCapturePackIntegration').includes('-Mode restore') &&
      macro('SnapshotCapturePackIntegration').includes('CapturePack Capture.lnk') &&
      macro('SnapshotCapturePackIntegration').includes('$PLUGINSDIR\\com.capturepack.host.json') &&
      uninstall.includes('${IfNot} ${isUpdated}'),
  )
  check(
    'browser registration is restored exactly rather than enabled by assumption',
    closeGate.includes('!insertmacro SnapshotCapturePackBrowserRegistration') &&
      macro('RestoreCapturePackBrowserRegistration').includes('$CapturePackChromeReg') &&
      macro('RestoreCapturePackBrowserRegistration').includes('$CapturePackEdgeReg') &&
      macro('RestoreCapturePackBrowserRegistration').includes('$CapturePackBraveReg') &&
      macro('RestoreCapturePackBrowserRegistration').includes('$CapturePackChromiumReg'),
  )
  check(
    'cancel, old-uninstaller and standalone-uninstall failures all recover',
    closeGate.includes('!insertmacro AbortCapturePackShutdown') &&
      installer.includes('!macro customUnInstallCheck') &&
      oldUninstallResult.includes('${ElseIf} ${Errors}') &&
      installer.includes('Function .onInstFailed') &&
      installer.includes('Function un.onUninstFailed') &&
      installer.includes('Call RestoreCapturePackAfterInstallFailure'),
  )
  check(
    'no uninstall string is not misreported as a removed previous install',
    macro('SnapshotCapturePackIntegration').includes(
      'ReadRegStr $0 HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"',
    ) &&
      oldUninstallResult.includes(
        '${If} $CapturePackHadOldUninstaller != "1"',
      ) &&
      oldUninstallResult.indexOf(
        '${If} $CapturePackHadOldUninstaller != "1"',
      ) <
        oldUninstallResult.indexOf('StrCpy $CapturePackOldUninstallCompleted "1"'),
  )
  check(
    'a cancelled close reports failure and restarts a previously running intact app',
    closeGate.indexOf('capturepack_close_abort:') <
      closeGate.indexOf('SetErrorLevel 2') &&
      closeGate.indexOf('SetErrorLevel 2') < closeGate.indexOf('Quit') &&
      macro('AbortCapturePackShutdown').includes('!insertmacro RestartCapturePackIfNeeded') &&
      macro('RestartCapturePackIfNeeded').includes('$CapturePackWasRunning') &&
      macro('RestartCapturePackIfNeeded').includes('resources\\app.asar'),
  )
  check(
    'bare extraction Quit cannot bypass durable post-removal recovery',
    extractionTemplate.includes('AbortExtract7za:') &&
      extractionTemplate.indexOf('AbortExtract7za:') <
        extractionTemplate.indexOf('Quit', extractionTemplate.indexOf('AbortExtract7za:')) &&
      macro('PersistCapturePackPendingSnapshot').includes('-Mode persist-pending') &&
      oldUninstallResult.indexOf('StrCpy $CapturePackOldUninstallCompleted "1"') <
        oldUninstallResult.indexOf('!insertmacro PersistCapturePackPendingSnapshot') &&
      oldUninstallResult.indexOf('!insertmacro PersistCapturePackPendingSnapshot') <
        oldUninstallResult.indexOf('StrCpy $CapturePackLoadedPending "1"') &&
      installSectionTemplate.indexOf('!insertmacro handleUninstallResult') <
        installSectionTemplate.indexOf('!insertmacro installApplicationFiles'),
  )
  check(
    'post-removal extraction failure preserves data without reactivating a missing app',
    installer.includes('$CapturePackOldUninstallCompleted == "1"') &&
      macro('DeactivateCapturePackAfterRemovedInstall').includes('!insertmacro RestoreCapturePackSnapshotFiles') &&
      macro('DeactivateCapturePackAfterRemovedInstall').includes('!insertmacro DisableCapturePackNativeHost') &&
      !macro('DeactivateCapturePackAfterRemovedInstall').includes('RestartCapturePackIfNeeded'),
  )
  check(
    'post-removal state survives the failed installer and is consumed only after a successful retry',
    installer.includes('$CapturePackLoadedPending') &&
      macro('SnapshotCapturePackIntegration').includes('installer-pending\\state.json') &&
      macro('SnapshotCapturePackIntegration').includes('-Mode save-pending') &&
      macro('DeactivateCapturePackAfterRemovedInstall').includes(
        '!insertmacro PersistCapturePackPendingSnapshot',
      ) &&
      macro('PersistCapturePackPendingSnapshot').includes('-Mode persist-pending') &&
      macro('PersistCapturePackPendingSnapshot').includes('$CapturePackLoadedPending != "1"') &&
      oldUninstallResult.includes('StrCpy $CapturePackLoadedPending "1"') &&
      success.includes('-Mode restore-pending') &&
      success.includes('$CapturePackLoadedPending == "1"') &&
      success.indexOf('-Mode restore-pending') <
        success.indexOf('Delete "$APPDATA\\CapturePack\\supervision-standdown"') &&
      closeGate.includes('Call RestoreCapturePackAfterInstallFailure') &&
      uninstall.includes('Delete "$APPDATA\\CapturePack\\installer-pending\\state.json"'),
  )
  if (process.platform === 'win32') {
    const stateScript = path.join(here, '..', 'build', 'installer-state.ps1')
    const nsisPowerShell = path.join(
      process.env['WINDIR'] ?? 'C:\\Windows',
      'SysWOW64',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    )
    const installerPowerShell = existsSync(nsisPowerShell) ? nsisPowerShell : 'powershell.exe'
    const stateFile = path.join(work, 'startup-approved.txt')
    const keySuffix = `Software\\CapturePack-QA\\installer-state-${process.pid}`
    const regKey = `HKCU\\${keySuffix}`
    const psKey = `HKCU:\\${keySuffix}`
    const binary = '030000000000000000000000'
    let restored = false
    let staleSaveRejected = false
    try {
      execFileSync('reg.exe', ['add', regKey, '/v', 'CapturePack', '/t', 'REG_BINARY', '/d', binary, '/f'])
      execFileSync(installerPowerShell, [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        stateScript,
        '-Mode',
        'save',
        '-StateFile',
        stateFile,
        '-RegistryPath',
        psKey,
        '-ValueName',
        'CapturePack',
      ])
      execFileSync('reg.exe', ['delete', regKey, '/v', 'CapturePack', '/f'])
      execFileSync(installerPowerShell, [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        stateScript,
        '-Mode',
        'restore',
        '-StateFile',
        stateFile,
        '-RegistryPath',
        psKey,
        '-ValueName',
        'CapturePack',
      ])
      const query = execFileSync('reg.exe', ['query', regKey, '/v', 'CapturePack'], {
        encoding: 'utf8',
      })
      restored = query.replace(/\s/gu, '').toLowerCase().includes(binary)

      // A failed second save must not leave the first run's marker behind.
      // NSIS treats existence as success, so stale content here would restore
      // a value that was never captured by the current installer.
      writeFileSync(stateFile, 'stale')
      execFileSync('reg.exe', ['delete', regKey, '/v', 'CapturePack', '/f'])
      try {
        execFileSync(
          installerPowerShell,
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            stateScript,
            '-Mode',
            'save',
            '-StateFile',
            stateFile,
            '-RegistryPath',
            psKey,
            '-ValueName',
            'CapturePack',
          ],
          { stdio: 'ignore' },
        )
      } catch {
        staleSaveRejected = !existsSync(stateFile)
      }
    } finally {
      try {
        execFileSync('reg.exe', ['delete', regKey, '/f'], { stdio: 'ignore' })
      } catch {
        // The test key is already absent, which is the desired cleanup state.
      }
    }
    check('StartupApproved REG_BINARY round-trips without exporting unrelated values', restored)
    check('a failed StartupApproved save cannot leave a stale success marker', staleSaveRejected)

    const pendingRoot = path.join(work, 'pending-roundtrip')
    const pendingAppData = path.join(pendingRoot, 'appdata')
    const pendingStartMenu = path.join(pendingRoot, 'start-menu')
    const pendingStage = path.join(pendingRoot, 'stage')
    const pendingRetryStage = path.join(pendingRoot, 'retry-stage')
    const pendingDurable = path.join(pendingRoot, 'durable')
    const pendingRegistrySuffix = `Software\\CapturePack-QA\\pending-${process.pid}`
    const pendingRegistryRoot = `HKCU\\${pendingRegistrySuffix}`
    const scoped = (relative) => `${pendingRegistryRoot}\\${relative}`
    const runPendingHelper = (args) =>
      execFileSync(
        installerPowerShell,
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          stateScript,
          ...args,
          '-RegistrySandboxRoot',
          pendingRegistrySuffix,
        ],
        { stdio: 'inherit' },
      )
    mkdirSync(pendingAppData, { recursive: true })
    mkdirSync(pendingStartMenu, { recursive: true })
    const pendingManifest = path.join(pendingAppData, 'com.capturepack.host.json')
    const pendingLauncher = path.join(pendingAppData, 'capturepack-host.cmd')
    const pendingShortcut = path.join(pendingStartMenu, 'CapturePack Capture.lnk')
    writeFileSync(pendingManifest, '{"allowed_origins":["chrome-extension://qa/"]}\n')
    writeFileSync(pendingLauncher, '@echo off\r\necho qa\r\n')
    writeFileSync(pendingShortcut, 'shortcut-qa')
    const chromePendingKey = scoped('Software\\Google\\Chrome\\NativeMessagingHosts\\com.capturepack.host')
    const edgePendingKey = scoped('Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.capturepack.host')
    const bravePendingKey = scoped(
      'Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\com.capturepack.host',
    )
    const runPendingKey = scoped('Software\\Microsoft\\Windows\\CurrentVersion\\Run')
    const startupPendingKey = scoped(
      'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run',
    )
    let pendingRoundTrip = false
    let pendingSurvivedRetrySnapshot = false
    try {
      execFileSync('reg.exe', [
        'add',
        chromePendingKey,
        '/ve',
        '/t',
        'REG_SZ',
        '/d',
        pendingManifest,
        '/f',
      ])
      execFileSync('reg.exe', [
        'add',
        bravePendingKey,
        '/ve',
        '/t',
        'REG_EXPAND_SZ',
        '/d',
        '%LOCALAPPDATA%\\CapturePack-QA\\host.json',
        '/f',
      ])
      execFileSync('reg.exe', [
        'add',
        runPendingKey,
        '/v',
        'CapturePack',
        '/t',
        'REG_EXPAND_SZ',
        '/d',
        '"%LOCALAPPDATA%\\Programs\\capturepack\\CapturePack.exe" --openAsHidden',
        '/f',
      ])
      execFileSync('reg.exe', [
        'add',
        startupPendingKey,
        '/v',
        'CapturePack',
        '/t',
        'REG_BINARY',
        '/d',
        binary,
        '/f',
      ])
      runPendingHelper([
        '-Mode',
        'save-pending',
        '-PendingDir',
        pendingStage,
        '-AppDataDir',
        pendingAppData,
        '-StartMenuPrograms',
        pendingStartMenu,
      ])
      runPendingHelper([
        '-Mode',
        'persist-pending',
        '-SourceDir',
        pendingStage,
        '-PendingDir',
        pendingDurable,
      ])
      const durableBeforeRetry = readFileSync(path.join(pendingDurable, 'state.json'), 'utf8')

      execFileSync('reg.exe', ['delete', pendingRegistryRoot, '/f'])
      execFileSync('reg.exe', [
        'add',
        edgePendingKey,
        '/ve',
        '/t',
        'REG_SZ',
        '/d',
        'must-be-removed',
        '/f',
      ])
      unlinkSync(pendingManifest)
      unlinkSync(pendingLauncher)
      unlinkSync(pendingShortcut)
      // This is the beginning of the second installer run. It may inspect the
      // deliberately deactivated live state, but it must not replace the
      // durable source of truth left by the failed first run.
      runPendingHelper([
        '-Mode',
        'save-pending',
        '-PendingDir',
        pendingRetryStage,
        '-AppDataDir',
        pendingAppData,
        '-StartMenuPrograms',
        pendingStartMenu,
      ])
      pendingSurvivedRetrySnapshot =
        readFileSync(path.join(pendingDurable, 'state.json'), 'utf8') === durableBeforeRetry

      runPendingHelper([
        '-Mode',
        'restore-pending',
        '-PendingDir',
        pendingDurable,
        '-AppDataDir',
        pendingAppData,
        '-StartMenuPrograms',
        pendingStartMenu,
      ])
      const chromeQuery = execFileSync('reg.exe', ['query', chromePendingKey, '/ve'], {
        encoding: 'utf8',
      })
      const braveQuery = execFileSync('reg.exe', ['query', bravePendingKey, '/ve'], {
        encoding: 'utf8',
      })
      const runQuery = execFileSync('reg.exe', ['query', runPendingKey, '/v', 'CapturePack'], {
        encoding: 'utf8',
      })
      const startupQuery = execFileSync(
        'reg.exe',
        ['query', startupPendingKey, '/v', 'CapturePack'],
        { encoding: 'utf8' },
      )
      let edgeAbsent = false
      try {
        execFileSync('reg.exe', ['query', edgePendingKey], { stdio: 'ignore' })
      } catch {
        edgeAbsent = true
      }
      pendingRoundTrip =
        chromeQuery.includes(pendingManifest) &&
        braveQuery.includes('REG_EXPAND_SZ') &&
        braveQuery.includes('%LOCALAPPDATA%\\CapturePack-QA\\host.json') &&
        runQuery.includes('REG_EXPAND_SZ') &&
        runQuery.includes('"%LOCALAPPDATA%\\Programs\\capturepack\\CapturePack.exe" --openAsHidden') &&
        startupQuery.replace(/\s/gu, '').toLowerCase().includes(binary) &&
        edgeAbsent &&
        readFileSync(pendingManifest, 'utf8').includes('chrome-extension://qa/') &&
        readFileSync(pendingLauncher, 'utf8').includes('echo qa') &&
        readFileSync(pendingShortcut, 'utf8') === 'shortcut-qa' &&
        !existsSync(path.join(pendingDurable, 'state.json'))
    } finally {
      try {
        execFileSync('reg.exe', ['delete', pendingRegistryRoot, '/f'], { stdio: 'ignore' })
      } catch {
        // The private QA key is already absent.
      }
    }
    check(
      'durable pending state restores exact files, registry kinds, absence and REG_BINARY, then consumes',
      pendingRoundTrip && pendingSurvivedRetrySnapshot,
    )
  } else {
    check(
      'StartupApproved helper is narrowly parameterized for one value',
      readFileSync(path.join(here, '..', 'build', 'installer-state.ps1'), 'utf8')
        .includes("[string]$ValueName = 'CapturePack'"),
    )
  }
  check(
    'stand-down self-heals even when supervision is off or gave up',
    supervisor.indexOf('fs.rmSync(standDownFile(), { force: true })') <
      supervisor.indexOf('if (recoveryState.gaveUp)') &&
      supervisor.indexOf('fs.rmSync(standDownFile(), { force: true })') <
        supervisor.indexOf('if (!options.enabled)') &&
      uninstallerTemplate.indexOf('call un.checkAppRunning') <
        uninstallerTemplate.indexOf('!insertmacro customUnInit'),
  )

  if (failed > 0) process.exitCode = 1
} finally {
  rmSync(work, { recursive: true, force: true })
}
