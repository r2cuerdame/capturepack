// ONE CLICK, THE WHOLE PAGE — held to account without a browser (#157).
//
// The toolbar click photographs the current page one viewport at a time and
// stitches the tiles into a single picture, with the document walked in the
// same coordinates. Every part of that runs inside a service worker and a page
// a test cannot open, so the extension keeps the procedure in files that take
// their browser calls as arguments (`full-page-capture.js`), its arithmetic in
// pure functions (`full-page-plan.js`), and the page-side helper as plain
// functions over the DOM (`full-page-content.js`). This check loads the REAL
// three into a vm, gives them a fake page and a fake canvas, and asks the
// questions the issue asks:
//
//   a long page lands every viewport where the page actually scrolled to;
//   a sticky header and a fixed banner are photographed once, not per tile;
//   content that appears as the page scrolls (lazy-load) is in the picture;
//   a page Chrome refuses fails honestly, before anything on it was touched;
//   the page is put back exactly — scroll and inline styles — on every path;
//   the bundle that crosses the wire reassembles to the bytes that were sent.
//
//   node scripts/full-page-capture-check.mjs

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const EXTENSION = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extensions', 'chrome')

let passed = 0
let failed = 0
function check(name, condition, detail = '') {
  if (condition) passed += 1
  else failed += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' || condition ? '' : ` — ${detail}`}`)
}

function extensionSource(name) {
  return readFileSync(resolve(EXTENSION, name), 'utf8')
}

// ---------------------------------------------------------------------------
// The worker: the plan and the procedure, loaded as `background.js` loads them.
// ---------------------------------------------------------------------------

function loadWorker() {
  const sandbox = { console, Math, Number, String, Object, Array, Error, JSON, Infinity, setTimeout, clearTimeout }
  sandbox.self = sandbox
  runInNewContext(extensionSource('full-page-plan.js'), sandbox)
  runInNewContext(extensionSource('full-page-capture.js'), sandbox)
  return {
    plan: sandbox.__capturepackFullPagePlan,
    capture: sandbox.__capturepackFullPageCapture,
  }
}

// ---------------------------------------------------------------------------
// The page: a small DOM that knows its own geometry, scrolls, clamps, grows
// when scrolled far enough (lazy-load), and remembers every inline style so a
// restoration can be checked exactly.
// ---------------------------------------------------------------------------

function inlineStyle() {
  const props = new Map()
  return {
    getPropertyValue: (name) => props.get(name)?.value ?? '',
    getPropertyPriority: (name) => props.get(name)?.priority ?? '',
    setProperty: (name, value, priority = '') => props.set(name, { value, priority }),
    removeProperty: (name) => props.delete(name),
    _props: props,
  }
}

function makePage(options = {}) {
  const page = {
    clientWidth: options.clientWidth ?? 1263,
    clientHeight: options.clientHeight ?? 800,
    scrollbar: 17,
    dpr: options.dpr ?? 1.5,
    scrollHeight: options.scrollHeight ?? 5000,
    lazyGrowAt: options.lazyGrowAt ?? null,
    lazyGrowTo: options.lazyGrowTo ?? null,
    scrollX: 0,
    scrollY: options.initialScrollY ?? 0,
    scrollCalls: [],
    elements: [],
    title: 'Fixture page',
    href: 'https://example.invalid/long',
  }

  function element(tag, def) {
    const el = {
      tagName: tag.toUpperCase(),
      def,
      attrs: def.attrs ?? {},
      style: inlineStyle(),
      isConnected: true,
      children: [],
      childNodes: [],
      hasAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attrs, name)
      },
      getAttribute(name) {
        return this.hasAttribute(name) ? this.attrs[name] : null
      },
      getBoundingClientRect() {
        const d = this.def
        let top
        if (d.position === 'fixed') {
          top = d.bottom !== undefined ? page.clientHeight - d.bottom - d.height : d.top
        } else if (d.position === 'sticky') {
          // Stuck at `top` once the page has scrolled past its natural place.
          top = Math.max(d.top ?? 0, d.y - page.scrollY)
        } else {
          top = d.y - page.scrollY
        }
        const left = (d.x ?? 0) - page.scrollX
        return { top, left, width: d.width, height: d.height, right: left + d.width, bottom: top + d.height }
      },
    }
    if (def.text) el.childNodes.push({ nodeType: 3, nodeValue: def.text })
    for (const property of Object.keys(def.inline ?? {})) {
      const [value, priority] = def.inline[property]
      el.style.setProperty(property, value, priority)
    }
    page.elements.push(el)
    return el
  }

  const html = element('html', { y: 0, width: page.clientWidth, height: page.scrollHeight })
  const body = element('body', { y: 0, width: page.clientWidth, height: page.scrollHeight })
  html.children.push(body)
  html.childNodes.push(body)
  Object.defineProperty(html, 'clientWidth', { get: () => page.clientWidth })
  Object.defineProperty(html, 'clientHeight', { get: () => page.clientHeight })
  Object.defineProperty(html, 'scrollWidth', { get: () => page.clientWidth })
  Object.defineProperty(html, 'scrollHeight', { get: () => page.scrollHeight })
  Object.defineProperty(body, 'scrollWidth', { get: () => page.clientWidth })
  Object.defineProperty(body, 'scrollHeight', { get: () => page.scrollHeight })

  const header = element('header', {
    position: 'sticky', top: 0, y: 0, x: 0, width: page.clientWidth, height: 60, text: 'Sticky header',
    inline: { visibility: ['visible', 'important'] },
  })
  const banner = element('div', {
    position: 'fixed', bottom: 0, y: 0, x: 0, width: page.clientWidth, height: 40, text: 'Cookie banner',
    attrs: { id: 'cookie' },
  })
  const blocks = []
  for (let y = 100; y < 7000; y += 500) {
    blocks.push(element('section', { y, x: 20, width: 600, height: 300, text: `Block at ${String(y)}` }))
  }
  const secret = element('input', { y: 350, x: 20, width: 200, height: 30, attrs: { type: 'password' } })
  for (const child of [header, banner, ...blocks, secret]) {
    body.children.push(child)
    body.childNodes.push(child)
  }

  const sandbox = {
    console, Math, Number, String, Object, Array, Error, JSON, Date, Promise,
    setTimeout, clearTimeout,
    Node: { TEXT_NODE: 3 },
    location: { href: page.href },
    document: {
      documentElement: html,
      body,
      get title() { return page.title },
      getElementsByTagName: (name) => (name === '*' ? page.elements : []),
    },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    getComputedStyle: (el) => ({
      position: el.def.position ?? 'static',
      top: el.def.position && el.def.top !== undefined ? `${String(el.def.top)}px` : 'auto',
      bottom: el.def.position && el.def.bottom !== undefined ? `${String(el.def.bottom)}px` : 'auto',
      visibility: el.style.getPropertyValue('visibility') || 'visible',
      display: 'block',
      opacity: '1',
    }),
    scrollTo: (x, y) => {
      page.scrollCalls.push({ x, y })
      const maxY = Math.max(0, page.scrollHeight - page.clientHeight)
      page.scrollX = Math.max(0, x)
      page.scrollY = Math.max(0, Math.min(y, maxY))
      if (page.lazyGrowAt !== null && page.scrollY >= page.lazyGrowAt && page.scrollHeight < page.lazyGrowTo) {
        // A feed that appends when the reader reaches it.
        page.scrollHeight = page.lazyGrowTo
        for (const el of [html, body]) el.def.height = page.scrollHeight
      }
    },
  }
  Object.defineProperty(sandbox, 'innerWidth', { get: () => page.clientWidth + page.scrollbar })
  Object.defineProperty(sandbox, 'innerHeight', { get: () => page.clientHeight })
  Object.defineProperty(sandbox, 'scrollX', { get: () => page.scrollX })
  Object.defineProperty(sandbox, 'scrollY', { get: () => page.scrollY })
  Object.defineProperty(sandbox, 'devicePixelRatio', { get: () => page.dpr })
  sandbox.window = sandbox
  sandbox.globalThis = sandbox

  page.sandbox = sandbox
  page.html = html
  page.body = body
  page.header = header
  page.banner = banner
  page.blocks = blocks
  page.inject = () => {
    for (const file of ['frame-geometry.js', 'document-snapshot.js', 'full-page-content.js']) {
      runInNewContext(extensionSource(file), sandbox)
    }
  }
  return page
}

// ---------------------------------------------------------------------------
// The browser calls, faked: tiles are labelled with what the page looked like
// at the instant they were photographed, and the canvas records where each
// one was drawn.
// ---------------------------------------------------------------------------

function fakeIo(page, options = {}) {
  const tiles = []
  const canvases = []
  let quotaFailuresLeft = options.quotaFailures ?? 0
  const io = {
    inject: async () => {
      if (options.restricted) throw new Error('Cannot access a chrome:// URL')
      page.inject()
    },
    call: async (_tabId, name, args) => {
      const api = page.sandbox.window.__capturepackFullPage
      if (!api || typeof api[name] !== 'function') throw new Error(`full-page helper missing: ${name}`)
      return api[name](...(args ?? []))
    },
    captureTile: async () => {
      if (quotaFailuresLeft > 0) {
        quotaFailuresLeft -= 1
        throw new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.')
      }
      const record = {
        scrollY: page.scrollY,
        headerVisibility: page.header.style.getPropertyValue('visibility'),
        bannerVisibility: page.banner.style.getPropertyValue('visibility'),
        scrollHeight: page.scrollHeight,
      }
      tiles.push(record)
      return `tile:${String(tiles.length - 1)}`
    },
    decode: async (dataUrl) => ({
      id: dataUrl,
      width: Math.round((page.clientWidth + page.scrollbar) * page.dpr),
      height: Math.round(page.clientHeight * page.dpr),
      closed: false,
      close() { this.closed = true },
    }),
    createCanvas: (width, height) => {
      const canvas = { width, height, draws: [] }
      canvases.push(canvas)
      return {
        drawImage: (bitmap, sx, sy, sw, sh, dx, dy, dw, dh) =>
          canvas.draws.push({ tile: bitmap.id, sx, sy, sw, sh, dx, dy, dw, dh }),
        toPng: async () => new TextEncoder().encode(JSON.stringify({ width, height, draws: canvas.draws.length })),
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 2))),
    now: () => Date.now(),
    progress: (done, total) => io.progress.calls.push([done, total]),
    settleMs: 1,
    prepassSettleMs: 1,
    captureSpacingMs: 0,
    ...options.io,
  }
  io.progress.calls = []
  return { io, tiles, canvases }
}

const worker = loadWorker()
const { planPage, placeTile, chunkPlan, exactCssWidth } = worker.plan
const { createFullPageCapturer, bundleMessages } = worker.capture

// ---------------------------------------------------------------------------

console.log('The plan: what the picture is, and where the tiles go')
{
  const plan = planPage({ clientWidth: 1263, clientHeight: 800, scrollWidth: 1263, scrollHeight: 5000, dpr: 1.5 })
  check('a long page is one tile per viewport, the last pulled up to the bottom',
    plan !== null && plan.tiles.map((t) => t.scrollY).join(',') === '0,800,1600,2400,3200,4000,4200',
    JSON.stringify(plan?.tiles))
  check('the width is chosen so that CSS px times scale is an integer (1263 -> 1262 at 1.5)',
    plan !== null && plan.cssWidth === 1262 && plan.pixelWidth === 1893 && plan.exact === true,
    JSON.stringify({ cssWidth: plan?.cssWidth, pixelWidth: plan?.pixelWidth, exact: plan?.exact }))
  check('the picture height is the page height at the device pixel ratio',
    plan !== null && plan.cssHeight === 5000 && plan.pixelHeight === 7500)
  check('exactCssWidth gives up an integer width when one is close', exactCssWidth(1000, 1.25) === 1000 && exactCssWidth(1001, 1.25) === 1000)
  const short = planPage({ clientWidth: 1000, clientHeight: 800, scrollWidth: 1000, scrollHeight: 500, dpr: 1 })
  check('a page shorter than its viewport is a single tile at the top',
    short !== null && short.tiles.length === 1 && short.tiles[0].scrollY === 0 && short.cssHeight === 800)
  const tall = planPage({ clientWidth: 1000, clientHeight: 800, scrollWidth: 1000, scrollHeight: 1_000_000, dpr: 1 }, { maxTiles: 5 })
  check('a page taller than the tile budget is cut at the budget and says so',
    tall !== null && tall.truncated === true && tall.cssHeight === 4000 && tall.tiles.length === 5,
    JSON.stringify({ truncated: tall?.truncated, cssHeight: tall?.cssHeight, tiles: tall?.tiles.length }))
  const wide = planPage({ clientWidth: 1000, clientHeight: 800, scrollWidth: 1000, scrollHeight: 20000, dpr: 2 }, { maxDimension: 16384 })
  check('a page that would exceed the canvas edge is kept whole at a smaller scale',
    wide !== null && wide.downscaled === true && wide.scale < 2 && wide.pixelHeight <= 16384 && wide.cssHeight === 20000,
    JSON.stringify({ downscaled: wide?.downscaled, scale: wide?.scale, pixelHeight: wide?.pixelHeight }))
  const heavy = planPage({ clientWidth: 4000, clientHeight: 800, scrollWidth: 4000, scrollHeight: 8000, dpr: 2 }, { maxArea: 10_000_000 })
  check('the memory bound is honoured by scale, not by dropping the bottom',
    heavy !== null && heavy.pixelWidth * heavy.pixelHeight <= 10_000_000 && heavy.truncated === false && heavy.downscaled === true)
  check('nonsense is refused rather than planned',
    planPage(null) === null
    && planPage({ clientWidth: 0, clientHeight: 800, scrollWidth: 0, scrollHeight: 10, dpr: 1 }) === null
    && planPage({ clientWidth: 100, clientHeight: 100, scrollWidth: 100, scrollHeight: Number.NaN, dpr: 1 }) === null)

  const bitmap = { width: 1920, height: 1200 }
  const first = placeTile(plan, 0, bitmap)
  check('a tile is cropped to the picture width (the scrollbar gutter is not in the picture)',
    first !== null && first.sw === 1893 && first.sh === 1200 && first.dx === 0 && first.dy === 0 && first.dw === 1893 && first.dh === 1200,
    JSON.stringify(first))
  const last = placeTile(plan, 4200, bitmap)
  check('the last tile lands where the page ACTUALLY scrolled to, not where it was asked to',
    last !== null && last.dy === 6300 && last.dh === 1200 && last.dy + last.dh === plan.pixelHeight,
    JSON.stringify(last))
  const clamped = placeTile(plan, 4400, bitmap)
  check('a tile past the bottom is cut at the picture edge, source and destination alike',
    clamped !== null && clamped.dy === 6600 && clamped.dh === 900 && clamped.sh === 900,
    JSON.stringify(clamped))
  check('a tile beyond the picture is refused', placeTile(plan, 5000, bitmap) === null)
  check('a chunk plan needs a four-aligned size',
    chunkPlan(1000, 8) !== null && chunkPlan(1000, 8).chunks === 125 && chunkPlan(1000, 6) === null && chunkPlan(0, 8).chunks === 1)
}

console.log('\nHiDPI pages near the memory bound are planned, never refused (QA REJECT on #157)')
{
  // QA measured, with the REAL limits, that a downscaled plan whose rounded
  // width times rounded height landed a few pixels past 40 M px returned null,
  // and the user saw "the page could not be re-measured". 1418x902 at 2 with a
  // 7760 px page is the one reproduced in a real Chromium; the rest are the
  // arithmetic sweep bands QA listed.
  const viewports = [
    { clientWidth: 1920, clientHeight: 1080, dpr: 2 },
    { clientWidth: 1440, clientHeight: 900, dpr: 2 },
    { clientWidth: 1536, clientHeight: 864, dpr: 2 },
    { clientWidth: 1920, clientHeight: 1080, dpr: 1.5 },
    { clientWidth: 1418, clientHeight: 902, dpr: 2 },
    { clientWidth: 1263, clientHeight: 800, dpr: 1.25 },
  ]
  const reproduced = planPage({ clientWidth: 1418, clientHeight: 902, scrollWidth: 1418, scrollHeight: 7760, dpr: 2 })
  check('the page QA reproduced at device scale 2 is planned',
    reproduced !== null && reproduced.pixelWidth * reproduced.pixelHeight <= worker.plan.MAX_AREA,
    JSON.stringify(reproduced && { scale: reproduced.scale, w: reproduced.pixelWidth, h: reproduced.pixelHeight }))
  for (const vp of viewports) {
    let refused = 0
    let overBound = 0
    let inexact = 0
    let gaps = 0
    let firstBad = ''
    for (let scrollHeight = 5000; scrollHeight <= 13000; scrollHeight += 1) {
      const p = planPage({ ...vp, scrollWidth: vp.clientWidth, scrollHeight })
      if (p === null) {
        refused += 1
        firstBad ||= `refused at ${scrollHeight}`
        continue
      }
      if (p.pixelWidth * p.pixelHeight > worker.plan.MAX_AREA
        || p.pixelWidth > worker.plan.MAX_DIMENSION || p.pixelHeight > worker.plan.MAX_DIMENSION) {
        overBound += 1
        firstBad ||= `over the bound at ${scrollHeight}`
      }
      // The app derives the DOM scale as pixelWidth / cssWidth; it must be the
      // scale the tiles were drawn at.
      if (Math.abs(p.pixelWidth / p.cssWidth - p.scale) > 1e-9) {
        inexact += 1
        firstBad ||= `derived scale drifts at ${scrollHeight}`
      }
      // Lay every tile down as the worker would (the bitmap carries a
      // scrollbar gutter) and require the rows to cover the canvas exactly.
      const bitmap = { width: Math.round((vp.clientWidth + 15) * vp.dpr), height: Math.round(vp.clientHeight * vp.dpr) }
      let covered = 0
      let ok = true
      for (const tile of p.tiles) {
        const placed = placeTile(p, tile.scrollY, bitmap)
        if (placed === null || placed.dw !== p.pixelWidth || placed.dy > covered) { ok = false; break }
        covered = Math.max(covered, placed.dy + placed.dh)
      }
      if (!ok || covered !== p.pixelHeight) {
        gaps += 1
        firstBad ||= `tiles leave a gap at ${scrollHeight}`
      }
    }
    check(`${vp.clientWidth}x${vp.clientHeight}@${vp.dpr}, pages 5000..13000 px: every plan fits the bound and its tiles fill the canvas`,
      refused === 0 && overBound === 0 && inexact === 0 && gaps === 0,
      JSON.stringify({ refused, overBound, inexact, gaps, firstBad }))
  }
}

console.log('\nA long page with a sticky header, a fixed banner and lazy-loading content')
{
  const page = makePage({ scrollHeight: 5000, lazyGrowAt: 3000, lazyGrowTo: 6500, initialScrollY: 1234 })
  const { io, tiles, canvases } = fakeIo(page)
  const result = await createFullPageCapturer(io).capture({ id: 7, windowId: 1, url: page.href, title: page.title })
  check('the capture succeeds', result.ok === true, JSON.stringify(result))
  if (result.ok) {
    const canvas = canvases[0]
    check('the picture was sized AFTER the page finished growing (6500 CSS px, not 5000)',
      result.page.cssHeight === 6500 && canvas.height === 9750 && canvas.width === 1893,
      JSON.stringify({ cssHeight: result.page.cssHeight, canvas: [canvas.width, canvas.height] }))
    check('every viewport of the grown page was photographed',
      tiles.map((t) => t.scrollY).join(',') === '0,800,1600,2400,3200,4000,4800,5600,5700',
      tiles.map((t) => t.scrollY).join(','))
    check('each tile is drawn at its own scroll position, at device pixels',
      canvas.draws.every((d, i) => d.dy === Math.round(tiles[i].scrollY * 1.5) && d.dw === 1893)
      && canvas.draws[canvas.draws.length - 1].dy + canvas.draws[canvas.draws.length - 1].dh === 9750,
      JSON.stringify(canvas.draws.map((d) => [d.dy, d.dh])))
    check('the sticky header is in the first tile and hidden in every later one',
      tiles[0].headerVisibility === 'visible'
      && tiles.slice(1).every((t) => t.headerVisibility === 'hidden'),
      JSON.stringify(tiles.map((t) => t.headerVisibility)))
    check('the fixed banner likewise',
      tiles[0].bannerVisibility === '' && tiles.slice(1).every((t) => t.bannerVisibility === 'hidden'))
    check('the page reports how many repeating elements it hid', result.page.hiddenRepeating === 2)
    check('the header\'s inline visibility is restored EXACTLY, priority included',
      page.header.style.getPropertyValue('visibility') === 'visible'
      && page.header.style.getPropertyPriority('visibility') === 'important'
      && page.banner.style.getPropertyValue('visibility') === '',
      JSON.stringify([...page.header.style._props]))
    check('the scroll position is put back where the user left it',
      page.scrollY === 1234 && result.restored?.restored === true,
      JSON.stringify({ scrollY: page.scrollY, restored: result.restored }))
    check('smooth-scroll overrides are removed again',
      page.html.style.getPropertyValue('scroll-behavior') === '' && page.body.style.getPropertyValue('scroll-behavior') === '')
    check('progress was reported per tile', io.progress.calls.length === 9 && io.progress.calls[8][0] === 9)
    const doc = result.document
    check('the document walk covers the WHOLE page, in document coordinates',
      doc !== null && doc.scope === 'document' && doc.viewport.height === 6500 && doc.viewport.width === 1262
      && doc.viewport.scrollY === 0
      && doc.elements.some((e) => e.text === 'Block at 4100' && e.bounds.y === 4100),
      JSON.stringify({ scope: doc?.scope, viewport: doc?.viewport, sample: doc?.elements.find((e) => e.text === 'Block at 4100') }))
    check('and stops at the height the picture was cut at',
      doc !== null && !doc.elements.some((e) => e.bounds.y >= 6500))
    check('the header is recorded once, where the first tile photographed it',
      doc !== null && doc.elements.filter((e) => e.text === 'Sticky header').length === 1
      && doc.elements.find((e) => e.text === 'Sticky header').bounds.y === 0)
    check('the walker keeps its refusals in document scope (a password field is presence only)',
      doc !== null && doc.elements.some((e) => e.tag === 'input' && e.secret === true && e.filled === false && e.text === undefined)
      && doc.omitted.some((line) => /captured page area/u.test(line)))
    check('the page geometry names its scale and sizes',
      result.page.pixelWidth === 1893 && result.page.pixelHeight === 9750 && result.page.scale === 1.5
      && result.page.devicePixelRatio === 1.5 && result.page.exactScale === true && result.page.tiles.length === 9
      && result.page.truncated === false && result.page.downscaled === false)
  }
}

console.log('\nA restricted page fails honestly and untouched')
{
  const page = makePage({ initialScrollY: 300 })
  const { io, tiles } = fakeIo(page, { restricted: true })
  const result = await createFullPageCapturer(io).capture({ id: 8, windowId: 1 })
  check('the failure names the stage and Chrome\'s own reason',
    result.ok === false && result.stage === 'inject' && /chrome:\/\//u.test(result.reason),
    JSON.stringify(result))
  check('nothing on the page was scrolled or photographed',
    page.scrollCalls.length === 0 && tiles.length === 0 && page.scrollY === 300)
}

console.log('\nEvery failure path restores the page')
{
  const page = makePage({ scrollHeight: 4000, initialScrollY: 999 })
  const { io } = fakeIo(page, { io: { maxCaptureMs: 0 } })
  const result = await createFullPageCapturer(io).capture({ id: 9, windowId: 1 })
  check('a capture that overruns its budget stops and says timeout',
    result.ok === false && result.stage === 'timeout', JSON.stringify(result))
  check('and still puts the scroll position and styles back',
    page.scrollY === 999 && result.restored?.restored === true
    && page.html.style.getPropertyValue('scroll-behavior') === '',
    JSON.stringify({ scrollY: page.scrollY, restored: result.restored }))
}
{
  const page = makePage({ scrollHeight: 2000, initialScrollY: 50 })
  const { io } = fakeIo(page, { io: { captureTile: async () => { throw new Error('The tab was closed.') } } })
  const result = await createFullPageCapturer(io).capture({ id: 10, windowId: 1 })
  check('a photograph that fails is reported as a capture failure',
    result.ok === false && result.stage === 'capture' && /closed/u.test(result.reason), JSON.stringify(result))
  check('with the page restored', page.scrollY === 50 && page.header.style.getPropertyValue('visibility') === 'visible')
}

console.log('\nChrome\'s capture quota is waited out, not treated as failure')
{
  const page = makePage({ scrollHeight: 2400 })
  const { io, tiles } = fakeIo(page, { quotaFailures: 2 })
  const result = await createFullPageCapturer(io).capture({ id: 11, windowId: 1 })
  check('the capture completes after the quota error', result.ok === true && tiles.length === 3, JSON.stringify(result))
}

console.log('\nThe bundle that crosses the wire')
{
  const page = makePage({ scrollHeight: 1600 })
  const { io } = fakeIo(page)
  const result = await createFullPageCapturer(io).capture({ id: 12, windowId: 1, url: page.href, title: page.title })
  check('the capture succeeds', result.ok === true)
  if (result.ok) {
    const base64 = Buffer.from(result.png).toString('base64')
    const small = { ...result, page: { ...result.page, chunkChars: 8 } }
    const { header, chunks } = bundleMessages(small, {
      protocol: 1, captureId: 'p1', tab: { url: page.href, title: page.title }, via: 'toolbar', timestamp: 1234, base64,
    })
    check('the header names the page, its geometry, the document and the byte count',
      header.type === 'page.captured' && header.protocol === 1 && header.capture_id === 'p1'
      && header.page.pixelWidth === 1893 && header.page.cssHeight === 1600 && header.document?.scope === 'document'
      && header.png.bytes === result.png.byteLength && header.png.chunks === chunks.length && header.png.chunkChars === 8,
      JSON.stringify({ ...header, document: undefined }))
    check('every chunk is four-aligned base64 with its index',
      chunks.every((c, i) => c.type === 'page.chunk' && c.capture_id === 'p1' && c.index === i && (i === chunks.length - 1 || c.data.length === 8)))
    const joined = chunks.map((c) => c.data).join('')
    check('and they concatenate back to exactly the bytes that were sent',
      Buffer.from(joined, 'base64').equals(Buffer.from(result.png)) && Buffer.from(joined, 'base64').byteLength === header.png.bytes)
    check('the picture is the canvas the tiles were drawn on',
      JSON.parse(Buffer.from(result.png).toString('utf8')).height === 2400)
  }
}

console.log('\nThe worker wires it to the toolbar, and the picker keeps its doors')
{
  const background = extensionSource('background.js')
  const manifest = JSON.parse(extensionSource('manifest.json'))
  const code = background.split('\n').filter((l) => !/^\s*\/\//u.test(l)).join('\n')
  check('background.js loads the plan and the procedure before anything else',
    /importScripts\('full-page-plan\.js',\s*'full-page-capture\.js'\)/u.test(code))
  check('the toolbar click captures the page and no longer arms the picker',
    /captureFullPage\(tab, 'toolbar'\)/u.test(code) && !/armPicker\(tab, 'toolbar'\)/u.test(code))
  check('the page helper is injected into the top frame only, after the walker',
    /files:\s*\['frame-geometry\.js',\s*'document-snapshot\.js',\s*'full-page-content\.js'\]/u.test(code))
  check('a second click during a capture is refused, not queued',
    /if \(pageCaptureInFlight\)/u.test(code))
  check('without a live app the click fails before touching the page',
    /port === null \|\| handshakeAt === null/u.test(code.slice(code.indexOf('async function captureFullPage'))))
  check('every failure is shown on the icon AND reported on the wire',
    /page\.capture\.failed/u.test(code) && /showOutcome\(tab\.id, '✕'/u.test(code))
  check('the app\'s answer decides the success badge', /page\.received/u.test(code) && /showOutcome\(tab\.id, '✓'/u.test(code))
  check('the picker is still reachable from the shortcut and the icon menu',
    /armPicker\(target, 'shortcut'\)/u.test(code) && /armPicker\(tab, 'context-menu'\)/u.test(code)
    && manifest.permissions.includes('contextMenus') && manifest.commands['pick-element'] !== undefined)
  check('no permission beyond activeTab was bought for this',
    !manifest.permissions.includes('debugger') && !('host_permissions' in manifest)
    && !manifest.permissions.some((p) => p === '<all_urls>' || p.includes('://')))
  check('the icon says what a click now does', /whole page/u.test(manifest.action.default_title))
}

console.log(`\nresult: ${failed === 0 ? 'OK' : 'BROKEN'} — ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
