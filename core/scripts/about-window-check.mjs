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
