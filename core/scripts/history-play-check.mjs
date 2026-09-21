import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const work = mkdtempSync(path.join(tmpdir(), 'capturepack-history-play-'))

try {
  const electronStub = path.join(work, 'electron-stub.cjs')
  writeFileSync(
    electronStub,
    `const noop = () => {};\n` +
      `const emitter = { on: noop, once: noop, off: noop, removeListener: noop, removeAllListeners: noop, emit: noop, handle: noop, handleOnce: noop, removeHandler: noop };\n` +
      `const handlers = new Map();\n` +
      `const openedPaths = [];\n` +
      `let historyWebContents = { send: noop, isDestroyed: () => false, once: noop, on: noop };\n` +
      `class MockBrowserWindow {\n` +
      `  static getAllWindows() { return [] }\n` +
      `  static fromWebContents() { return null }\n` +
      `  constructor() { this.webContents = historyWebContents; this._destroyed = false; }\n` +
      `  on() {}\n` +
      `  once() {}\n` +
      `  loadFile() { return Promise.resolve() }\n` +
      `  destroy() { this._destroyed = true; }\n` +
      `  isDestroyed() { return this._destroyed; }\n` +
      `  isVisible() { return true; }\n` +
      `  setMenuBarVisibility() {}\n` +
      `  show() {}\n` +
      `  focus() {}\n` +
      `  close() { this._destroyed = true; }\n` +
      `};\n` +
      `exports.app = Object.assign({}, emitter, { getAppPath: () => '.', getVersion: () => '0.0.0-check', getName: () => 'capturepack-check', getPath: (name) => ${JSON.stringify(work)} + '/' + (name || 'app'), getLocale: () => 'en', getPreferredSystemLanguages: () => ['en'], isPackaged: false, whenReady: () => Promise.resolve(), quit: noop, exit: noop, requestSingleInstanceLock: () => true, setLoginItemSettings: noop, getLoginItemSettings: () => ({}), setAppUserModelId: noop });\n` +
      `exports.clipboard = { writeText: noop, writeImage: noop, readText: () => '' };\n` +
      `exports.screen = Object.assign({}, emitter, { getAllDisplays: () => [], getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 }), getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 }) });\n` +
      `exports.ipcMain = Object.assign({}, emitter, {\n` +
      `  handle: (channel, fn) => { handlers.set(channel, fn); },\n` +
      `  removeHandler: (channel) => { handlers.delete(channel); },\n` +
      `});\n` +
      `exports.BrowserWindow = MockBrowserWindow;\n` +
      `exports.Menu = { buildFromTemplate: () => ({}), setApplicationMenu: noop };\n` +
      `exports.nativeImage = { createFromPath: () => ({}), createEmpty: () => ({}), createFromBuffer: () => ({}) };\n` +
      `exports.nativeTheme = Object.assign({}, emitter, { shouldUseDarkColors: false });\n` +
      `exports.shell = { openPath: async (p) => { openedPaths.push(p); return ''; }, showItemInFolder: noop, openExternal: () => Promise.resolve() };\n` +
      `exports.dialog = { showMessageBox: () => Promise.resolve({ response: 0 }), showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }), showErrorBox: noop };\n` +
      `globalThis.__electronStub = {\n` +
      `  __handlers: handlers,\n` +
      `  __openedPaths: openedPaths,\n` +
      `  __historyWebContents: historyWebContents,\n` +
      `};\n`,
  )
  const bundle = path.join(work, 'check.cjs')
  execFileSync(
    process.execPath,
    [
      path.join(here, '..', 'node_modules', 'esbuild', 'bin', 'esbuild'),
      path.join(here, 'history-play-check.ts'),
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--outfile=${bundle}`,
      `--alias:electron=${electronStub}`,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  )
  execFileSync(process.execPath, [bundle], { stdio: 'inherit' })
} finally {
  rmSync(work, { recursive: true, force: true })
}
