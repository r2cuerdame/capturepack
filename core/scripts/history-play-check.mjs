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
      `const listeners = new Map();\n` +
      `const emitter = {\n` +
      `  on(channel, fn) { const set = listeners.get(channel) || new Set(); set.add(fn); listeners.set(channel, set); return this; },\n` +
      `  once(channel, fn) { const wrapped = (...args) => { this.removeListener(channel, wrapped); fn(...args); }; return this.on(channel, wrapped); },\n` +
      `  off(channel, fn) { return this.removeListener(channel, fn); },\n` +
      `  removeListener(channel, fn) { listeners.get(channel)?.delete(fn); return this; },\n` +
      `  removeAllListeners(channel) { if (channel === undefined) listeners.clear(); else listeners.delete(channel); return this; },\n` +
      `  emit(channel, ...args) { for (const fn of [...(listeners.get(channel) || [])]) fn(...args); return true; },\n` +
      `  handle: noop, handleOnce: noop, removeHandler: noop,\n` +
      `};\n` +
      `const handlers = new Map();\n` +
      `const openedPaths = [];\n` +
      `const renderStarts = [];\n` +
      `const sentMessages = [];\n` +
      `const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');\n` +
      `let historyWebContents = {\n` +
      `  send: (channel, payload) => {\n` +
      `    sentMessages.push({ channel, payload });\n` +
      `    if (channel !== 'render:start') return;\n` +
      `    renderStarts.push(payload);\n` +
      `    queueMicrotask(() => {\n` +
      `      exports.ipcMain.emit('render:frame', { sender: historyWebContents }, { t_ms: 0, png });\n` +
      `      exports.ipcMain.emit('render:result', { sender: historyWebContents }, { ok: true });\n` +
      `    });\n` +
      `  },\n` +
      `  isDestroyed: () => false, once: noop, on: noop,\n` +
      `};\n` +
      `class MockBrowserWindow {\n` +
      `  static getAllWindows() { return [] }\n` +
      `  static fromWebContents() { return null }\n` +
      `  constructor() { this.webContents = historyWebContents; this._destroyed = false; }\n` +
      `  on() {}\n` +
      `  once() {}\n` +
      `  removeListener() {}\n` +
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
      `  __renderStarts: renderStarts,\n` +
      `  __sentMessages: sentMessages,\n` +
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
