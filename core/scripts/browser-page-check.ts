// THE APP'S HALF OF A ONE-CLICK FULL-PAGE CAPTURE (#157).
//
// The extension photographs a page and sends it as a header and base64 chunks
// (`full-page-capture-check.mjs` holds that side to account). This is what the
// app must do with them, without a browser and without a window:
//
//   the bridge gathers the chunks, verifies the bytes against the header and
//     the PNG's own IHDR against the declared size, hands ONE capture to its
//     listener, and answers the extension — for a good bundle and every kind
//     of bad one;
//   the DOM provider places the page's elements on the picture through the
//     SAME derivation a desktop still uses, to the pixel, including the
//     rounding a picture height carries;
//   the pack's chrome-dom payload writes the document scope and the page
//     geometry, and reads them back through the same parser a re-edit uses;
//   and the flow that opens the editor is the desktop still's own — pinned as
//     a source contract, because a second editor path is the failure this
//     issue was written to prevent.
//
// Run: npm run check:browser-page

import * as net from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { greyPng } from './fixtures/greyPng'
import {
  domBridgeStatus,
  browserPageStats,
  onBrowserPageCaptured,
  parseDomPayload,
  startDomBridge,
  stopDomBridge,
  type BrowserPageCapture,
  type DomEvent,
} from '../src/main/chrome/domBridge'
import { domPipePath } from '../src/main/chrome/nativeHost'
import { ChromeDomProvider } from '../src/main/context/domProvider'
import { domEventForPack, writeDomPlugin, DOM_PLUGIN_VERSION } from '../src/main/exporter'
import type { SurfaceInfo } from '../src/shared/context/protocol'

let passed = 0
let failed = 0
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) passed += 1
  else failed += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${!condition && detail !== undefined ? ` — ${detail}` : ''}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await sleep(25)
  }
  return predicate()
}

// ---------------------------------------------------------------------------
// A bundle the way the extension sends one: a real PNG, a document walked in
// document scope, the page's geometry, and the picture in four-aligned chunks.
// ---------------------------------------------------------------------------

const PAGE = {
  cssWidth: 40,
  cssHeight: 60,
  scale: 2,
  pixelWidth: 80,
  pixelHeight: 120,
}
const PNG = greyPng(PAGE.pixelWidth, PAGE.pixelHeight)

function bundle(options: {
  captureId?: string
  bytes?: number
  png?: Buffer
  pixelWidth?: number
  chunkChars?: number
  document?: boolean
} = {}): { header: Record<string, unknown>; chunks: Record<string, unknown>[] } {
  const png = options.png ?? PNG
  const base64 = png.toString('base64')
  const chunkChars = options.chunkChars ?? 64
  const count = Math.max(1, Math.ceil(base64.length / chunkChars))
  const captureId = options.captureId ?? 'p1'
  const header = {
    type: 'page.captured',
    protocol: 1,
    timestamp: 1_700_000_000_000,
    capture_id: captureId,
    via: 'toolbar',
    tab: { url: 'https://example.test/long', title: 'A long page' },
    page: {
      url: 'https://example.test/long',
      title: 'A long page',
      cssWidth: PAGE.cssWidth,
      cssHeight: PAGE.cssHeight,
      pixelWidth: options.pixelWidth ?? PAGE.pixelWidth,
      pixelHeight: PAGE.pixelHeight,
      devicePixelRatio: 2,
      scale: PAGE.scale,
      clientWidth: 40,
      clientHeight: 20,
      scrollWidth: 40,
      scrollHeight: 60,
      tiles: [{ index: 0, scrollY: 0 }, { index: 1, scrollY: 20 }, { index: 2, scrollY: 40 }],
      truncated: false,
      downscaled: false,
      exactScale: true,
      hiddenRepeating: 1,
      captureMs: 1234,
    },
    document: options.document === false ? null : {
      viewport: { width: 40, height: 60, devicePixelRatio: 2, scrollX: 0, scrollY: 0 },
      scope: 'document',
      url: 'https://example.test/long',
      title: 'A long page',
      elements: [
        { i: 0, tag: 'header', role: 'banner', bounds: { x: 0, y: 0, width: 40, height: 5 }, text: 'Top' },
        { i: 1, tag: 'section', role: '', bounds: { x: 2, y: 50, width: 30, height: 8 }, text: 'Bottom' },
      ],
      truncated: false,
      visitedCount: 3,
      elapsedMs: 1,
      omitted: ['elements outside the captured page area'],
    },
    png: { bytes: options.bytes ?? png.length, chunks: count, chunkChars },
  }
  const chunks = []
  for (let index = 0; index < count; index += 1) {
    chunks.push({
      type: 'page.chunk',
      protocol: 1,
      timestamp: 1_700_000_000_000,
      capture_id: captureId,
      index,
      data: base64.slice(index * chunkChars, (index + 1) * chunkChars),
    })
  }
  return { header, chunks }
}

// ---------------------------------------------------------------------------

async function bridgeHalf(): Promise<void> {
  console.log('\nThe bridge gathers a page and answers the extension')
  process.env['CAPTUREPACK_DOM_PIPE_SUFFIX'] = `page-check-${String(process.pid)}`
  startDomBridge()
  const listening = await waitFor(() => domBridgeStatus().listening, 5_000)
  check('the bridge listens on an isolated pipe', listening)

  const received: BrowserPageCapture[] = []
  let answer: { ok: boolean; reason?: string } = { ok: true }
  onBrowserPageCaptured(async (capture) => {
    received.push(capture)
    return answer
  })

  const socket = net.connect(domPipePath())
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('error', reject)
  })
  const replies: Record<string, unknown>[] = []
  let inbound = ''
  socket.on('data', (chunk: Buffer) => {
    inbound += chunk.toString('utf8')
    let cut = inbound.indexOf('\n')
    while (cut !== -1) {
      const line = inbound.slice(0, cut)
      inbound = inbound.slice(cut + 1)
      if (line.trim() !== '') replies.push(JSON.parse(line) as Record<string, unknown>)
      cut = inbound.indexOf('\n')
    }
  })
  const send = (message: unknown): void => {
    socket.write(`${JSON.stringify(message)}\n`)
  }
  const replyFor = (id: string): Record<string, unknown> | undefined =>
    replies.find((r) => r['type'] === 'page.received' && r['capture_id'] === id)

  send({ type: 'host.hello', protocol: 1, timestamp: Date.now(), app: 'capturepack-extension', version: '0.4.0' })
  check('the extension is greeted', await waitFor(() => replies.some((r) => r['type'] === 'host.hello'), 5_000))

  // A good bundle, chunks deliberately out of order: the wire keeps order, but
  // the assembler must key on the index, not on arrival.
  {
    const { header, chunks } = bundle({ captureId: 'good' })
    send(header)
    for (const chunk of [...chunks].reverse()) send(chunk)
    const done = await waitFor(() => replyFor('good') !== undefined, 5_000)
    check('a complete bundle reaches the listener once', done && received.length === 1, JSON.stringify(replies))
    const capture = received[0]
    check('with exactly the bytes that were sent', capture !== undefined && capture.png.equals(PNG))
    check('and the size the PNG itself declares',
      capture !== undefined && capture.width === PAGE.pixelWidth && capture.height === PAGE.pixelHeight)
    check('the page geometry, tab and timestamp come through validated',
      capture !== undefined && capture.page.cssHeight === 60 && capture.page.scale === 2 && capture.page.tiles === 3
      && capture.page.hiddenRepeating === 1 && capture.tab.title === 'A long page'
      && capture.capturedAtMs === 1_700_000_000_000 && capture.via === 'toolbar'
      && capture.extensionVersion === '0.4.0')
    check('the document arrives in document scope with its rectangles intact',
      capture?.document?.scope === 'document' && capture.document.elements.length === 2
      && capture.document.elements[1]?.bounds.y === 50 && capture.document.viewport.height === 60)
    check('the extension is told it went through', replyFor('good')?.['ok'] === true)
  }

  console.log('\nEvery kind of bad bundle is refused out loud, and answered')
  {
    const { header, chunks } = bundle({ captureId: 'short', bytes: PNG.length + 7 })
    send(header)
    for (const chunk of chunks) send(chunk)
    await waitFor(() => replyFor('short') !== undefined, 5_000)
    const reply = replyFor('short')
    check('a byte count that disagrees with the chunks is refused',
      reply?.['ok'] === false && /picture-bytes-mismatch/u.test(String(reply?.['reason'])), JSON.stringify(reply))
  }
  {
    const { header, chunks } = bundle({ captureId: 'size', pixelWidth: PAGE.pixelWidth + 1 })
    send(header)
    for (const chunk of chunks) send(chunk)
    await waitFor(() => replyFor('size') !== undefined, 5_000)
    const reply = replyFor('size')
    check('a declared size the PNG header contradicts is refused',
      reply?.['ok'] === false && /picture-size-mismatch/u.test(String(reply?.['reason'])), JSON.stringify(reply))
  }
  {
    const fake = Buffer.from('not a png at all, just bytes that are long enough to look like one')
    const { header, chunks } = bundle({ captureId: 'fake', png: fake })
    send(header)
    for (const chunk of chunks) send(chunk)
    await waitFor(() => replyFor('fake') !== undefined, 5_000)
    const reply = replyFor('fake')
    check('bytes that are not a PNG are refused',
      reply?.['ok'] === false && /picture-not-png/u.test(String(reply?.['reason'])), JSON.stringify(reply))
  }
  {
    const { header } = bundle({ captureId: 'huge', bytes: 65 * 1024 * 1024 })
    send(header)
    await waitFor(() => replyFor('huge') !== undefined, 5_000)
    const reply = replyFor('huge')
    check('a picture over the memory bound is refused at the announcement',
      reply?.['ok'] === false && /page-picture-size-refused/u.test(String(reply?.['reason'])), JSON.stringify(reply))
  }
  {
    const before = domBridgeStatus().rejected
    send({ type: 'page.chunk', protocol: 1, capture_id: 'orphan', index: 0, data: 'AAAA' })
    await waitFor(() => domBridgeStatus().rejected > before, 5_000)
    check('a chunk with no announcement is counted as a refusal',
      domBridgeStatus().rejected > before && /page-chunk-without-header/u.test(String(domBridgeStatus().lastRejection)))
  }
  {
    const { header, chunks } = bundle({ captureId: 'dup' })
    send(header)
    send(chunks[0])
    send(chunks[0])
    await waitFor(() => replyFor('dup') !== undefined, 5_000)
    const reply = replyFor('dup')
    check('a repeated chunk drops the capture rather than trusting either copy',
      reply?.['ok'] === false && /chunk-repeated/u.test(String(reply?.['reason'])), JSON.stringify(reply))
  }
  {
    answer = { ok: false, reason: 'editor-already-open' }
    const { header, chunks } = bundle({ captureId: 'busy' })
    send(header)
    for (const chunk of chunks) send(chunk)
    await waitFor(() => replyFor('busy') !== undefined, 5_000)
    const reply = replyFor('busy')
    check('the flow\'s own refusal is relayed to the extension',
      reply?.['ok'] === false && reply?.['reason'] === 'editor-already-open', JSON.stringify(reply))
    answer = { ok: true }
  }
  {
    const { header, chunks } = bundle({ captureId: 'nodoc', document: false })
    send(header)
    for (const chunk of chunks) send(chunk)
    await waitFor(() => replyFor('nodoc') !== undefined, 5_000)
    const last = received[received.length - 1]
    check('a picture without a document is still a picture',
      replyFor('nodoc')?.['ok'] === true && last?.captureId === 'nodoc' && last.document === null)
  }
  const stats = browserPageStats()
  check('the bridge counts what it received and refused',
    stats.received === 3 && stats.refused >= 5 && stats.pending === 0, JSON.stringify(stats))
  check('nothing above was mistaken for a pick', domBridgeStatus().elementPicks === 0)

  socket.destroy()
  onBrowserPageCaptured(null)
  stopDomBridge()
}

// ---------------------------------------------------------------------------

function placementHalf(): void {
  console.log('\nThe page is placed on the picture through the desktop still\'s own derivation')
  const pageSurface = (width: number, height: number): SurfaceInfo => ({
    surfaceId: 'sfc1',
    bounds: { x: 0, y: 0, width, height },
    clientBounds: { x: 0, y: 0, width, height },
    space: 'display-snapshot',
    display: 1,
    zOrder: 0,
    visible: true,
    minimized: false,
    foreground: true,
    executableName: 'chrome',
    windowTitle: 'A long page',
    className: 'Chrome_WidgetWin_1',
  })
  const pageEvent = (cssWidth: number, cssHeight: number, scale: number, elements: Array<{ x: number; y: number; w: number; h: number }>): DomEvent => ({
    tMs: 0,
    type: 'dom.document.captured',
    tab: { url: 'https://example.test/long', title: 'A long page' },
    viewport: { width: cssWidth, height: cssHeight, dpr: scale, screenX: null, screenY: null, outerWidth: null, outerHeight: null },
    document: {
      viewport: { width: cssWidth, height: cssHeight, devicePixelRatio: scale, scrollX: 0, scrollY: 0 },
      scope: 'document',
      url: 'https://example.test/long',
      title: 'A long page',
      elements: elements.map((e, i) => ({ i, tag: 'div', role: '', bounds: { x: e.x, y: e.y, width: e.w, height: e.h }, id: `e${String(i)}` })),
      truncated: false,
      visitedCount: elements.length,
      elapsedMs: 0,
      omitted: [],
    },
  })

  {
    // 1262 CSS px wide at 1.5 = 1893 px exactly; 6500 tall = 9750.
    const surface = pageSurface(1893, 9750)
    const provider = new ChromeDomProvider(
      [pageEvent(1262, 6500, 1.5, [{ x: 20, y: 6100, w: 600, h: 300 }, { x: 0, y: 0, w: 1262, h: 60 }])],
      () => [surface],
    )
    check('every element of a long page is offered, none refused',
      provider.pickCount === 2 && provider.placementRefusals.length === 0,
      JSON.stringify(provider.placementRefusals))
    void provider.frame({ sessionId: 's1', timeMs: 0, surfaces: [surface], maxCandidates: 100 }).then((frame) => {
      const bottom = frame.candidates.find((c) => c.identity?.['dom_id'] === 'e0')
      const header = frame.candidates.find((c) => c.identity?.['dom_id'] === 'e1')
      check('an element at the bottom of the page lands at its CSS position times the scale, to the pixel',
        bottom !== undefined && bottom.bounds.x === 30 && bottom.bounds.y === 9150 && bottom.bounds.width === 900 && bottom.bounds.height === 450,
        JSON.stringify(bottom?.bounds))
      check('the header at the top lands at the top',
        header !== undefined && header.bounds.y === 0 && header.bounds.width === 1893 && header.bounds.height === 90,
        JSON.stringify(header?.bounds))
      check('the candidates are the page\'s, not an explicit pick',
        frame.candidates.every((c) => c.explicit === false && c.authority === 'document-native'))
    })
  }
  {
    // 1260 CSS px at 1.25 = 1575 exactly; 6501 tall = 8126.25, rounded DOWN to
    // 8126 — the picture is a quarter pixel shorter than the viewport claims.
    const surface = pageSurface(1575, 8126)
    const provider = new ChromeDomProvider(
      [pageEvent(1260, 6501, 1.25, [{ x: 100, y: 6400, w: 200, h: 80 }])],
      () => [surface],
    )
    check('a picture height rounded below the viewport is rounding, not a disagreement',
      provider.pickCount === 1, JSON.stringify(provider.placementRefusals))
    void provider.frame({ sessionId: 's1', timeMs: 0, surfaces: [surface], maxCandidates: 10 }).then((frame) => {
      const only = frame.candidates[0]
      check('and the element is still placed at CSS times scale',
        only !== undefined && only.bounds.x === 125 && only.bounds.y === 8000 && only.bounds.width === 250 && only.bounds.height === 100,
        JSON.stringify(only?.bounds))
    })
  }
  {
    // A whole pixel short is still what it always was: refused.
    const surface = pageSurface(1575, 8124)
    const provider = new ChromeDomProvider(
      [pageEvent(1260, 6501, 1.25, [{ x: 100, y: 6400, w: 200, h: 80 }])],
      () => [surface],
    )
    check('a picture two pixels shorter than its viewport is still refused', provider.pickCount === 0)
  }
  {
    // The title stands in for the window match: an unrelated window is not the page.
    const surface = { ...pageSurface(1893, 9750), windowTitle: 'Something else entirely' }
    const provider = new ChromeDomProvider(
      [pageEvent(1262, 6500, 1.5, [{ x: 20, y: 100, w: 600, h: 300 }])],
      () => [surface],
    )
    check('a surface that is not titled as the tab places nothing', provider.pickCount === 0)
  }
}

// ---------------------------------------------------------------------------

async function payloadHalf(): Promise<void> {
  console.log('\nThe pack writes the page and reads it back')
  const dir = mkdtempSync(path.join(tmpdir(), 'capturepack-page-'))
  try {
    const event: DomEvent = {
      tMs: 0,
      type: 'dom.document.captured',
      tab: { url: 'https://example.test/long', title: 'A long page' },
      viewport: { width: 1262, height: 6500, dpr: 1.5, screenX: null, screenY: null, outerWidth: null, outerHeight: null },
      document: {
        viewport: { width: 1262, height: 6500, devicePixelRatio: 1.5, scrollX: 0, scrollY: 0 },
        scope: 'document',
        url: 'https://example.test/long',
        title: 'A long page',
        elements: [{ i: 0, tag: 'section', role: '', bounds: { x: 20, y: 6100, width: 600, height: 300 }, text: 'Bottom' }],
        truncated: false,
        visitedCount: 1,
        elapsedMs: 2,
        omitted: ['elements outside the captured page area'],
      },
      page: {
        url: 'https://example.test/long',
        title: 'A long page',
        cssWidth: 1262,
        cssHeight: 6500,
        pixelWidth: 1893,
        pixelHeight: 9750,
        devicePixelRatio: 1.5,
        scale: 1.5,
        clientWidth: 1263,
        clientHeight: 800,
        scrollWidth: 1263,
        scrollHeight: 6500,
        tiles: 9,
        truncated: false,
        downscaled: false,
        exactScale: true,
        hiddenRepeating: 2,
        captureMs: 6100,
      },
    }
    const payload = { protocol: 1, extension_version: '0.4.0', events: [domEventForPack(event, 0, 0)] }
    await writeDomPlugin(dir, payload)
    const written = JSON.parse(readFileSync(path.join(dir, 'plugins', 'chrome-dom', 'elements.json'), 'utf8')) as {
      events: Array<Record<string, unknown>>
    }
    const first = written.events[0] ?? {}
    const doc = first['document'] as Record<string, unknown>
    const page = first['page'] as Record<string, unknown>
    check('the document\'s scope is written', doc['scope'] === 'document')
    check('the page geometry is written in the pack\'s own spelling',
      page['css_width'] === 1262 && page['pixel_height'] === 9750 && page['exact_scale'] === true
      && page['hidden_repeating'] === 2 && page['tiles'] === 9 && page['capture_ms'] === 6100,
      JSON.stringify(page))
    check('the meta names the payload version that defines these fields',
      (JSON.parse(readFileSync(path.join(dir, 'plugins', 'chrome-dom', 'meta.json'), 'utf8')) as { version: string }).version
        === DOM_PLUGIN_VERSION && DOM_PLUGIN_VERSION === '0.4.0')
    const back = parseDomPayload(readFileSync(path.join(dir, 'plugins', 'chrome-dom', 'elements.json'), 'utf8'))
    check('a re-edit reads the scope, the viewport and the page back',
      back.length === 1 && back[0]?.document?.scope === 'document' && back[0].viewport?.dpr === 1.5
      && back[0].page?.pixelHeight === 9750 && back[0].page?.hiddenRepeating === 2 && back[0].page?.exactScale === true,
      JSON.stringify(back[0]?.page))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------

function sourceHalf(): void {
  console.log('\nOne editor path, pinned in the source')
  // The bundle runs from a temp directory; the runner runs from core/.
  const core = process.cwd()
  const read = (relative: string): string =>
    readFileSync(path.join(core, relative), 'utf8').replace(/\r\n?/gu, '\n')
  const code = (text: string): string =>
    text.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/u.test(line)).join('\n')
  const section = (text: string, start: string, end: string): string => {
    const from = text.indexOf(start)
    const to = text.indexOf(end, from + start.length)
    return from >= 0 && to > from ? text.slice(from, to) : ''
  }
  const session = code(read('src/main/session.ts'))
  const index = code(read('src/main/index.ts'))
  const desktop = section(session, 'async function runImageFlowWithContext(', 'interface PreparedStill')
  const shared = section(session, 'async function runImageEditor(', 'async function runFlow(')
  const page = section(session, 'export function startBrowserPageFlow(', 'function prepareBrowserPageStill(')
  const prepare = section(session, 'function prepareBrowserPageStill(', 'interface FrozenDisplay')

  check('the desktop still hands its pixels to runImageEditor', /await runImageEditor\(settings, \{/u.test(desktop))
  check('the browser page hands its picture to the same function', /await runImageEditor\(settings, prepareBrowserPageStill\(/u.test(page))
  check('and the editor is created in that one place only',
    (shared.match(/createEditorWindow\(/gu) ?? []).length === 1
    && !desktop.includes('createEditorWindow(') && !page.includes('createEditorWindow(') && !prepare.includes('createEditorWindow('))
  check('save-first, the chrome-dom write and the UIA write live there too',
    shared.includes('await savePack(initialSave)') && shared.includes('tryWriteDomPlugin(') && shared.includes('writeUiaPlugin('))
  check('the page is declared as a browser-page still, with no desktop crop',
    /scope: 'browser-page'/u.test(prepare) && !/cropBounds/u.test(prepare))
  check('the picture is the window: one floor window whose client rectangle is the whole picture',
    /client_bounds: \{ \.\.\.whole \}/u.test(prepare) && /process: 'chrome'/u.test(prepare) && /mergeImageWindowFloor\(null, floor/u.test(prepare))
  check('the event\'s viewport is the document in CSS px at the picture\'s scale',
    /dpr: page\.scale/u.test(prepare) && /width: page\.cssWidth/u.test(prepare) && /height: page\.cssHeight/u.test(prepare))
  check('a page that arrives while a flow is busy is refused, not queued',
    /if \(flowActive\)/u.test(page) && /'editor-already-open'/u.test(page))
  check('the app registers the page listener at startup',
    /onBrowserPageCaptured\(\(page\) => startBrowserPageFlow\(settings, page\)\)/u.test(index))
  check('the extension is answered only once the editor is visible or the flow ended',
    /prepareBrowserPageStill\(capture, \(\) => settle\(\{ ok: true \}\)\)/u.test(page)
    && /onEditorVisible,/u.test(prepare) && /still\.onEditorVisible\?\.\(\)/u.test(shared))
}

async function main(): Promise<void> {
  await bridgeHalf()
  placementHalf()
  await sleep(50)
  await payloadHalf()
  sourceHalf()
  console.log(`\nresult: ${failed === 0 ? 'OK' : 'BROKEN'} — ${String(passed)} passed, ${String(failed)} failed\n`)
  if (failed > 0) process.exitCode = 1
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
