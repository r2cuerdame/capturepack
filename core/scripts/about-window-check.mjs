import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const read = (relative) => readFileSync(resolve(root, relative), 'utf8')

const ipc = read('src/shared/ipc.ts')
const main = read('src/main/aboutWindow.ts')
const preload = read('src/preload/about.ts')
const renderer = read('src/renderer/about/about.ts')
const html = read('src/renderer/about/about.html')
const tray = read('src/main/tray.ts')
const index = read('src/main/index.ts')
const i18n = read('src/shared/i18n.ts')
const updater = read('src/main/updater.ts')

const checks = [
  ['About owns a dedicated log action', ipc.includes("aboutOpenLogs: 'about:open-logs'")],
  ['About renders the localized log button', /id="openLogsBtn"[^>]+data-i18n="about\.openLogs"/u.test(html)],
  ['Preload exposes only a path-free action', preload.includes('openLogs(): void') && preload.includes('ipcRenderer.send(IPC.aboutOpenLogs)')],
  ['Renderer wires the About button', renderer.includes("el<HTMLButtonElement>('openLogsBtn')") && renderer.includes('bridge.openLogs()')],
  ['Main rejects non-About senders', main.includes('ipcMain.on(IPC.aboutOpenLogs') && main.includes('if (!fromAboutWindow(event)) return')],
  ['Main resolves and creates its own log directory', main.includes('const directory = logsDir()') && main.includes('fs.mkdirSync(directory, { recursive: true })')],
  ['Main reports openPath failures', main.includes('.openPath(directory)') && main.includes('could not open the logs folder')],
  ['Tray handler contract no longer owns logs', !tray.includes('onOpenLogs') && !tray.includes("t('tray.openLogs')")],
  ['Tray wiring no longer owns logs', !index.includes('onOpenLogs:')],
  [
    'A manual second launch opens Information instead of disappearing',
    index.includes("logInfo('[app] manual second launch: opening About')") &&
      /app\.on\('second-instance'[\s\S]*openAboutWindow\(\)/u.test(index),
  ],
  [
    'A second launch waits until every window IPC bridge is registered',
    index.includes('let launchUiReady = false') &&
      index.includes('queuedLaunchArgv = argv') &&
      index.indexOf('registerWelcomeIpc(') < index.indexOf('launchUiReady = true') &&
      index.includes('openSecondLaunchUi(argv)'),
  ],
  [
    'Installed About reveal has an independent load fallback',
    main.includes("win.once('ready-to-show', reveal)") &&
      main.includes("win.webContents.once('did-finish-load', reveal)") &&
      main.includes('if (revealed || win.isDestroyed()) return'),
  ],
  [
    'About load failure is recorded and leaves a retryable state',
    main.includes('could not load the Information window') &&
      main.includes('if (aboutWindow === win) aboutWindow = null') &&
      main.includes('win.destroy()'),
  ],
  ['Every locale contains the About label', (i18n.match(/'about\.openLogs':/gu) ?? []).length === 9],
  ['Obsolete tray localization key is gone', !i18n.includes("'tray.openLogs':")],
  // #103: a lock screen with private notification content turns the routine
  // update toast into an app name, a red badge and the word "비공개", which
  // reads as a recording failure. It is HELD, not dropped — the user still
  // learns about the update, at a moment they can act on it.
  [
    'A routine update notice is held over a locked screen, not shown to it',
    index.includes("powerMonitor.on('lock-screen'") &&
      index.includes("powerMonitor.on('unlock-screen'") &&
      index.includes('if (sessionLocked)') &&
      index.includes('deferredUpdateToast = readyVersion'),
  ],
  [
    'and it is released when the session comes back',
    /deferredUpdateToast = null[\s\S]{0,300}showUpdateToast\(held\)/u.test(index),
  ],
  [
    // One construction, so the held path and the immediate path cannot drift.
    // Other notifications here are capture/hotkey failures and are deliberately
    // untouched: a real failure still announces itself, locked screen or not.
    'the update toast has exactly one implementation',
    (index.match(/'app\.updateReady'/gu) ?? []).length === 1 &&
      index.includes('const showUpdateToast = (version: string): void =>'),
  ],
  [
    // A CHECK THE USER ASKED FOR IS OWED AN ANSWER (#111).
    //
    // "Check for updates…" with nothing to report changed a tray label for a
    // few seconds and did nothing else, so pressing it looked the same as
    // pressing it while it was broken.
    'pressing Check for updates says so when there is nothing to update',
    index.includes("status.state === 'up-to-date' && status.userRequested === true") &&
      (index.match(/'app\.upToDate'/gu) ?? []).length === 1,
  ],
  [
    // The four-hourly automatic check must NOT toast: that is exactly the
    // routine update noise #103 removed, which a locked screen reduces to an
    // app name and a red badge indistinguishable from a failed capture.
    'the automatic check stays silent, because only a question gets an answer',
    updater.includes('let manualCheckPending = false') &&
      updater.includes('manualCheckPending = true') &&
      /answersTheUser[\s\S]{0,200}manualCheckPending = false/u.test(updater) &&
      // Progress is not an answer; the flag survives 'checking' and waits.
      updater.includes("incoming.state !== 'checking' && incoming.state !== 'downloading'"),
  ],
  [
    // A flag that outlives its question would attach the user's answer to the
    // next automatic result instead.
    'a request that cannot produce a new answer clears itself',
    (updater.match(/manualCheckPending = false/gu) ?? []).length >= 4,
  ],
  [
    'every locale answers, not just the one that was tested',
    (i18n.match(/'app\.upToDate'/gu) ?? []).length ===
      (i18n.match(/'app\.updateReady'/gu) ?? []).length,
  ],
]

let failed = 0
for (const [name, passed] of checks) {
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`)
  if (!passed) failed += 1
}

if (failed !== 0) {
  console.error(`\n${failed}/${checks.length} About window checks failed.`)
  process.exitCode = 1
} else {
  console.log(`\n${checks.length}/${checks.length} About window checks passed.`)
}
