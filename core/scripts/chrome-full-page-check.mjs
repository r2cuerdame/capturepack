import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

let passed = 0
let failed = 0
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const here = dirname(fileURLToPath(import.meta.url))
const extension = resolve(here, '..', '..', 'extensions', 'chrome')
const source = readFileSync(resolve(extension, 'full-page-capture.js'), 'utf8')
const background = readFileSync(resolve(extension, 'background.js'), 'utf8')
const documentSource = readFileSync(resolve(extension, 'document-snapshot.js'), 'utf8')
const manifest = JSON.parse(readFileSync(resolve(extension, 'manifest.json'), 'utf8'))
const bridge = readFileSync(resolve(here, '..', 'src', 'main', 'chrome', 'domBridge.ts'), 'utf8')
const appCapture = readFileSync(resolve(here, '..', 'src', 'main', 'chrome', 'pageCapture.ts'), 'utf8')

const sandbox = { self: {}, TextEncoder, btoa: (value) => Buffer.from(value, 'binary').toString('base64') }
runInNewContext(source, sandbox)
const fullPage = sandbox.self.__capturepackFullPageCapture

function listenerChannel() {
  const listeners = new Set()
  return {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
    emit: (...args) => listeners.forEach((listener) => listener(...args)),
    size: () => listeners.size,
  }
}

async function runExtensionCapture({ activateDuringScreenshot = false, injectionError = null } = {}) {
  const geometry = {
    documentWidth: 1800,
    documentHeight: 1800,
    viewportWidth: 1000,
    viewportHeight: 900,
    deviceScaleFactor: 1,
    originalScrollX: 12,
    originalScrollY: 34,
  }
  const activated = listenerChannel()
  const updated = listenerChannel()
  const messages = []
  const moves = []
  let restored = false
  let captures = 0
  sandbox.chrome = {
    runtime: { getManifest: () => ({ version: '0.4.0' }) },
    tabs: {
      onActivated: activated,
      onUpdated: updated,
      query: async () => [{ id: 7 }],
      captureVisibleTab: async () => {
        captures += 1
        if (activateDuringScreenshot) activated.emit({ tabId: 8, windowId: 3 })
        return 'data:image/png;base64,iVBORw0KGgo='
      },
    },
    scripting: {
      executeScript: async (request) => {
        if (request.files) {
          if (injectionError !== null) throw injectionError
          return []
        }
        if (request.func.name === 'preparePage') return [{ result: geometry }]
        if (request.func.name === 'movePage') {
          moves.push(request.args)
          return [{ result: {
            x: request.args[1],
            y: request.args[2],
            documentWidth: geometry.documentWidth,
            documentHeight: geometry.documentHeight,
            viewportWidth: geometry.viewportWidth,
            viewportHeight: geometry.viewportHeight,
            deviceScaleFactor: geometry.deviceScaleFactor,
          } }]
        }
        if (request.func.name === 'snapshotPage') {
          return [{ result: { elements: [], space: { width: 1800, height: 1800 } } }]
        }
        if (request.func.name === 'restorePage') {
          restored = true
          return [{ result: null }]
        }
        throw new Error(`unexpected injected function ${request.func.name}`)
      },
    },
  }
  let error = null
  try {
    await fullPage.run(
      { id: 7, windowId: 3, url: 'https://example.test/', title: 'Example' },
      (message) => { messages.push(message); return true },
    )
  } catch (caught) {
    error = caught
  }
  return { activated, captures, error, messages, moves, restored, updated }
}

console.log('\nDeterministic tiling')
check('the shipped helper is loadable', typeof fullPage?.captureGrid === 'function')
check(
  'a short page is one tile',
  JSON.stringify(fullPage.captureGrid({
    documentWidth: 800,
    documentHeight: 600,
    viewportWidth: 800,
    viewportHeight: 700,
  })) === JSON.stringify([{ x: 0, y: 0 }]),
)
check(
  'the last tile is anchored to the document edge (no blank tail)',
  JSON.stringify(fullPage.axisPositions(2500, 900)) === JSON.stringify([0, 900, 1600]),
)
check(
  'a wide and tall page forms a complete row-major grid',
  fullPage.captureGrid({
    documentWidth: 1800,
    documentHeight: 2500,
    viewportWidth: 1000,
    viewportHeight: 900,
  }).length === 6,
)

console.log('\nQuality and restoration contract')
check('lazy content is warmed before metadata is frozen', source.includes('Warm the complete vertical range'))
const completed = await runExtensionCapture()
const captureMoves = completed.moves.filter((args) => args[4] === 550)
let styleCapError = null
sandbox.window = { __capturepackFullPageState: { captureId: 'cap', floating: null } }
sandbox.document = { getElementsByTagName: () => ({ length: 20_001 }) }
try {
  await fullPage.movePage('cap', 0, 900, true, 0, 20_000, false)
} catch (caught) {
  styleCapError = caught
}
let stickyNeutralized = false
let stickyRemainsVisible = false
const stickyStyle = {
  hidden: false,
  position: '',
  offsets: new Map(),
  getPropertyValue: (name) => name === 'position'
    ? stickyStyle.position
    : (stickyStyle.offsets.get(name) || ''),
  getPropertyPriority: () => '',
  setProperty: (name, value) => {
    if (name === 'visibility') stickyStyle.hidden = value === 'hidden'
    if (name === 'position') stickyStyle.position = value
    if (['top', 'right', 'bottom', 'left'].includes(name)) stickyStyle.offsets.set(name, value)
  },
  removeProperty: (name) => {
    if (name === 'visibility') stickyStyle.hidden = false
    if (name === 'position') stickyStyle.position = ''
    stickyStyle.offsets.delete(name)
  },
}
const sticky = {
  style: stickyStyle,
  getBoundingClientRect: () => ({ left: 0, top: 150, right: 100, bottom: 180 }),
}
const root = { scrollWidth: 100, scrollHeight: 200 }
sandbox.window = {
  __capturepackFullPageState: { captureId: 'sticky', floating: null },
  scrollX: 0,
  scrollY: 0,
  innerWidth: 100,
  innerHeight: 100,
  getComputedStyle: () => ({ position: 'sticky' }),
  scrollTo: (x, y) => { sandbox.window.scrollX = x; sandbox.window.scrollY = y },
}
sandbox.document = {
  documentElement: root,
  body: null,
  getElementsByTagName: () => ({ 0: sticky, length: 1 }),
}
sandbox.requestAnimationFrame = (callback) => callback()
sandbox.setTimeout = (callback) => callback()
await fullPage.movePage('sticky', 0, 0, true, 0, 20_000, true)
stickyNeutralized = stickyStyle.position === 'relative' &&
  ['top', 'right', 'bottom', 'left'].every((name) => stickyStyle.offsets.get(name) === 'auto') &&
  !stickyStyle.hidden
await fullPage.movePage('sticky', 0, 100, true, 0, 20_000, false)
stickyRemainsVisible = !stickyStyle.hidden
check('fixed elements are shown only in the first tile, including wide pages',
  source.includes("position !== 'fixed' && position !== 'sticky'") &&
    captureMoves.every((args) => args[3] === true) &&
    JSON.stringify(captureMoves.map((args) => args[6])) === JSON.stringify([true, false, false, false]))
check('sticky positioning is neutralized without hiding its normal-flow content',
  stickyNeutralized && stickyRemainsVisible &&
    source.includes("setProperty('position', 'relative', 'important')") &&
    source.includes("element.style.setProperty(name, 'auto', 'important')") &&
    source.includes("saved.position === 'fixed' && !showFixed"))
check('the fixed-element scan has a hard element cap and avoids an unbounded snapshot',
  styleCapError?.message.includes('fixed-element scan limit is 20000') &&
    source.includes('MAX_STYLE_SCAN_ELEMENTS = 20_000') &&
    source.includes("document.getElementsByTagName('*')") &&
    !source.includes("document.querySelectorAll('*')"))
check('tile capture respects Chrome\'s two-per-second quota',
  source.includes('const CAPTURE_DELAY_MS = 550'))
check('the exact original scroll is restored in a finally path',
  completed.restored && /finally\s*\{[\s\S]*restorePage/.test(source) &&
    source.includes('window.scrollTo(state.scrollX, state.scrollY)'))
check('DPR participates in the bounded-pixel decision',
  source.includes('geometry.deviceScaleFactor ** 2'))
check('restricted-page/injection errors surface through the toolbar',
  background.includes("type: 'page.capture.failed'") && background.includes("text: '✕'"))
const restricted = await runExtensionCapture({ injectionError: new Error('restricted page') })
check('a restricted page fails before any bundle or screenshot is emitted',
  restricted.error?.message === 'restricted page' && restricted.messages.length === 0 &&
    restricted.captures === 0 && restricted.activated.size() === 0 && restricted.updated.size() === 0)

console.log('\nPrivacy and UX contract')
check('toolbar click runs full-page capture, not the picker',
  /action\.onClicked[\s\S]{0,900}__capturepackFullPageCapture\.run\(tab, sendPageCapture,/.test(background) &&
    !/armPicker\(tab, 'toolbar'\)/.test(background))
check('element picking remains an explicit shortcut',
  manifest.commands?.['pick-element'] !== undefined && background.includes("command !== 'pick-element'"))
check('no debugger or standing host permission was added',
  !manifest.permissions.includes('debugger') && !('host_permissions' in manifest))
const switched = await runExtensionCapture({ activateDuringScreenshot: true })
check('switching tabs during capture aborts before another tab can enter the bundle',
  switched.error?.message.includes('source tab changed') && switched.captures === 1 &&
    !switched.messages.some((message) => message.type === 'page.capture.tile.end') &&
    !switched.messages.some((message) => message.type === 'page.capture.finish') &&
    switched.restored && switched.activated.size() === 0 && switched.updated.size() === 0)
check('the optional app-hotkey grant is still reachable explicitly',
  manifest.permissions.includes('contextMenus') && background.includes('GRANT_CONTEXT_MENU'))
check('DOM full-page mode admits only the captured document rectangle',
  documentSource.includes('options.fullPage === true') &&
    documentSource.includes('elements outside the captured document rectangle'))

console.log('\nBundle transport and integrity')
check('large rasters cross the existing host as bounded chunks',
  source.includes('CHUNK_CHARS = 512 * 1024') && bridge.includes('PAGE_CAPTURE_MAX_BASE64_CHARS'))
check('the app validates PNG signatures before adopting tiles', bridge.includes('function decodePng'))
check('the app assembles without resampling and enforces a bitmap bound',
  appCapture.includes('source.copy(') && appCapture.includes('MAX_BITMAP_BYTES'))
check('the normal save-first image pack path is reused',
  appCapture.includes('await savePack({') && appCapture.includes('tryWriteDomPlugin'))
check('a complete mocked extension run emits one aligned document and every tile',
  completed.error === null && completed.captures === 4 &&
    completed.messages.filter((message) => message.type === 'page.capture.tile.end').length === 4 &&
    completed.messages.at(-1)?.type === 'page.capture.finish')
check('an abandoned streamed capture is identified so the app can release it',
  background.includes("{ capture_id: captureId }") &&
    /page\.capture\.failed[\s\S]{0,500}pageCaptures\.delete\(captureId\)/.test(bridge))
check('the app acknowledges only after the capture handler settles',
  /pageCaptureHandler\(capture\)\.then/.test(bridge) && bridge.includes("type: 'page.capture.result'"))
check('a saved capture reports failure when the normal editor path is busy',
  readFileSync(resolve(here, '..', 'src', 'main', 'index.ts'), 'utf8')
    .includes("return { ok: false, reason: 'capture-saved-editor-busy' }"))

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — Chrome full-page: ${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
