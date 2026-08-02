// Bundles n-display-format-check.ts against an electron stub so the WRITER
// (buildManifest), the editor BOARD, report.md's numbering, and the toast and
// tray rules for a partial recorder failure can all be held to the same
// three-display desk, in one check.
//
// THE STUB GREW when #76's fixture desk arrived. It now has to satisfy the
// module-level side effects of src/main/session.ts and src/main/capture.ts,
// because that is where two of the four rules under test live: the toast's
// "no replay on N of M screens" wording and the tray's one-state-for-N-recorders
// aggregate. Both were unreachable from any check until they were given their
// inputs as arguments — see their definitions for why.
//
// Every member below is a no-op that exists only so an import does not throw at
// load time; nothing in the check calls Electron. If a future import makes this
// stub insufficient the check fails loudly with a TypeError naming the missing
// member, which is the right failure — silently skipping the desk would not be.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const work = mkdtempSync(path.join(tmpdir(), 'capturepack-n-display-runner-'))
try {
  const stub = path.join(work, 'electron-stub.cjs')
  writeFileSync(
    stub,
    `const noop = () => {};\n` +
      `const emitter = { on: noop, once: noop, off: noop, removeListener: noop, removeAllListeners: noop, emit: noop, handle: noop, handleOnce: noop, removeHandler: noop };\n` +
      `exports.app = Object.assign({}, emitter, { getVersion: () => '0.0.0-check', getName: () => 'capturepack-check', getPath: () => '.', isPackaged: false, whenReady: () => Promise.resolve(), quit: noop, exit: noop, requestSingleInstanceLock: () => true, setLoginItemSettings: noop, getLoginItemSettings: () => ({}), setAppUserModelId: noop });\n` +
      `exports.clipboard = { writeText: noop, writeImage: noop, readText: () => '' };\n` +
      `exports.screen = Object.assign({}, emitter, { getAllDisplays: () => [], getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 }), getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 }) });\n` +
      `exports.ipcMain = Object.assign({}, emitter);\n` +
      `exports.BrowserWindow = class { static getAllWindows() { return [] } static fromWebContents() { return null } constructor() {} on() {} once() {} loadFile() { return Promise.resolve() } destroy() {} };\n` +
      `exports.Menu = { buildFromTemplate: () => ({}), setApplicationMenu: noop };\n` +
      `exports.Tray = class { constructor() {} on() {} setImage() {} setToolTip() {} setContextMenu() {} displayBalloon() {} };\n` +
      `exports.Notification = class { constructor() {} show() {} };\n` +
      `exports.nativeImage = { createFromPath: () => ({}), createEmpty: () => ({}), createFromBuffer: () => ({}) };\n` +
      `exports.nativeTheme = Object.assign({}, emitter, { shouldUseDarkColors: false });\n` +
      `exports.shell = { openPath: () => Promise.resolve(''), showItemInFolder: noop, openExternal: () => Promise.resolve() };\n` +
      `exports.dialog = { showMessageBox: () => Promise.resolve({ response: 0 }), showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }), showErrorBox: noop };\n` +
      `exports.session = { defaultSession: { setDisplayMediaRequestHandler: noop, setPermissionRequestHandler: noop } };\n` +
      `exports.desktopCapturer = { getSources: () => Promise.resolve([]) };\n` +
      `exports.globalShortcut = { register: () => true, unregister: noop, unregisterAll: noop, isRegistered: () => false };\n` +
      `exports.powerMonitor = Object.assign({}, emitter);\n` +
      `exports.webContents = Object.assign({}, emitter, { fromFrame: () => undefined, fromId: () => undefined, getAllWebContents: () => [] });\n` +
      `exports.protocol = { registerFileProtocol: noop, handle: noop };\n`,
  )
  const bundle = path.join(work, 'check.cjs')
  execFileSync(
    process.execPath,
    [
      path.join(here, '..', 'node_modules', 'esbuild', 'bin', 'esbuild'),
      path.join(here, 'n-display-format-check.ts'),
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--outfile=${bundle}`,
      `--alias:electron=${stub}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  execFileSync(process.execPath, [bundle], { stdio: 'inherit' })
} finally {
  rmSync(work, { recursive: true, force: true })
}
