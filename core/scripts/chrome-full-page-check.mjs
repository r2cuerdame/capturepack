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
const appMain = readFileSync(resolve(here, '..', 'src', 'main', 'index.ts'), 'utf8')

const sandbox = {
  self: {},
  TextEncoder,
  btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
}
runInNewContext(source, sandbox)
const fullPage = sandbox.self.__capturepackFullPageCapture

async function captureLifecycle({ failRestore = false } = {}) {
  const events = []
  const tab = { id: 7, windowId: 3, url: 'https://example.test/', title: 'Fixture', active: true }
  const geometry = {
    documentWidth: 1,
    documentHeight: 1,
    viewportWidth: 1,
    viewportHeight: 1,
    deviceScaleFactor: 1,
    originalScrollX: 0,
    originalScrollY: 0,
  }
  sandbox.chrome = {
    runtime: { getManifest: () => ({ version: 'test' }) },
    tabs: {
      get: async () => tab,
      captureVisibleTab: async () => 'data:image/png;base64,aQ==',
    },
    scripting: {
      executeScript: async (details) => {
        if (details.files) return []
        const name = details.func?.name
        events.push(`script:${name}`)
        if (name === 'preparePage' || name === 'movePage') return [{ result: geometry }]
        if (name === 'snapshotPage') {
          return [{ result: {
            viewport: { width: 1, height: 1, devicePixelRatio: 1, scrollX: 0, scrollY: 0 },
            url: tab.url,
            title: tab.title,
            elements: [],
            truncated: false,
            visitedCount: 0,
            elapsedMs: 0,
            omitted: [],
          } }]
        }
        if (name === 'restorePage' && failRestore) throw new Error('restore failed')
        return []
      },
    },
  }
  let rejected = false
  try {
    await fullPage.run(tab, (message) => {
      events.push(`send:${message.type}`)
      return true
    })
  } catch {
    rejected = true
  }
  return { events, rejected }
}

const successfulLifecycle = await captureLifecycle()
const failedRestoreLifecycle = await captureLifecycle({ failRestore: true })

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
check('the original active tab remains eligible', fullPage.sameCaptureTab(
  { id: 7, windowId: 3, url: 'https://example.test/' },
  { id: 7, windowId: 3, url: 'https://example.test/', active: true },
))
check('a switched tab is rejected before its pixels can be adopted', !fullPage.sameCaptureTab(
  { id: 7, windowId: 3, url: 'https://example.test/' },
  { id: 7, windowId: 3, url: 'https://example.test/', active: false },
))

console.log('\nQuality and restoration contract')
check('lazy content is warmed before metadata is frozen', source.includes('Warm the complete vertical range'))
check('fixed and sticky elements are suppressed after the first tile, including wide pages',
  source.includes("position !== 'fixed' && position !== 'sticky'") && source.includes('index > 0'))
check('scrollbars are suppressed during capture and removed during restoration',
  source.includes('html::-webkit-scrollbar, body::-webkit-scrollbar') &&
    !source.includes(' } ::-webkit-scrollbar') &&
    source.includes('state.scrollbarStyle?.remove()'))
check('tile capture respects Chrome\'s two-per-second quota',
  source.includes('const CAPTURE_DELAY_MS = 550'))
check('the exact original scroll is restored in a finally path',
  /finally\s*\{[\s\S]*restorePage/.test(source) && source.includes('window.scrollTo(state.scrollX, state.scrollY)'))
check('capture completion is sent only after page restoration succeeds',
  successfulLifecycle.events.indexOf('script:restorePage') <
    successfulLifecycle.events.indexOf('send:page.capture.finish') &&
    failedRestoreLifecycle.rejected &&
    !failedRestoreLifecycle.events.includes('send:page.capture.finish'),
  JSON.stringify({ successfulLifecycle, failedRestoreLifecycle }))
check('DPR participates in the bounded-pixel decision',
  source.includes('geometry.deviceScaleFactor ** 2'))
check('restricted-page/injection errors surface through the toolbar',
  background.includes("type: 'page.capture.failed'") && background.includes("text: '✕'"))
check('captureVisibleTab is guarded on both sides against tab switches',
  (source.match(/await assertCaptureTab\(tab\)/g) ?? []).length === 2)

console.log('\nPrivacy and UX contract')
check('toolbar click runs full-page capture, not the picker',
  /action\.onClicked[\s\S]{0,1600}__capturepackFullPageCapture\.run\(/.test(background) &&
    !/armPicker\(tab, 'toolbar'\)/.test(background))
check('host readiness is refused before the page is scrolled',
  background.indexOf('if (!pageCaptureReady())') <
    background.indexOf('self.__capturepackFullPageCapture.run('))
check('an app-side rejection cancels the running tile loop',
  source.includes("shouldContinue(captureId)") &&
    background.includes('(startedId) => pageCaptureResults.has(startedId)'))
check('element picking remains an explicit shortcut',
  manifest.commands?.['pick-element'] !== undefined && background.includes("command !== 'pick-element'"))
check('no debugger or standing host permission was added',
  !manifest.permissions.includes('debugger') && !('host_permissions' in manifest))
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
  appCapture.includes('await savePack({') && appCapture.includes('await writeDomPlugin'))
check('the saved page surface and viewport feed the normal context-session path',
  appCapture.includes('browserPageCaptureContext') &&
    appCapture.includes('windowsContext: browserContext.windowsContext') &&
    appCapture.includes('viewport: {') &&
    appCapture.includes("'plugins', 'windows-context', 'timeline.json'"))
check('failure to open the normal editor is not acknowledged as success',
  appMain.includes("{ ok: false, reason: 'Capture saved, but another editor is already open' }"))
check('the app acknowledges only after the capture handler settles',
  /pageCaptureHandler\(capture\)\.then/.test(bridge) && bridge.includes("type: 'page.capture.result'"))

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — Chrome full-page: ${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
