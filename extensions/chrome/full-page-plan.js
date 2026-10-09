// How a whole page becomes ONE picture (#157).
//
// The toolbar click asks for the entire document, and Chrome only ever hands an
// extension the VISIBLE viewport (`tabs.captureVisibleTab`). So the page is
// scrolled one viewport at a time, each viewport is photographed, and the tiles
// are laid down in a canvas at the position the page actually scrolled to.
// This file is the arithmetic of that: which scroll positions, what size the
// picture is, where a tile lands, and what is refused. It is kept as PURE
// FUNCTIONS on purpose, like `frame-geometry.js`: the capture runs inside a
// service worker a test cannot open, so the only way to hold this to account is
// to hand it numbers — `scripts/full-page-capture-check.mjs` does exactly that.
//
// Loaded by `background.js` through importScripts and by the check through a
// vm sandbox; both find it on `globalThis.__capturepackFullPagePlan`.
;(() => {
  /** A Chromium canvas edge; larger and `OffscreenCanvas` silently draws nothing. */
  const MAX_DIMENSION = 16384
  /** Pixels in the stitched picture: 40 M px is 160 MB of RGBA in the worker. */
  const MAX_AREA = 40_000_000
  /** Viewports per page. Chrome allows two captures a second, so this is ~30 s. */
  const MAX_TILES = 60
  /** Below this the picture is not a rendering of the page any more. */
  const MIN_SCALE = 0.1
  /** How far down from the measured width to look for an exact pixel width. */
  const EXACT_SEARCH_PX = 16

  const finite = (v) => typeof v === 'number' && Number.isFinite(v)

  /**
   * The widest CSS width at or below `cssWidth` whose product with `scale` is
   * an integer, or null when none is within reach.
   *
   * WHY EXACTNESS IS WORTH A FEW COLUMNS. The app places every DOM rectangle
   * with ONE scale, derived as `pixelWidth / cssWidth` (see `domProvider.ts`).
   * If the picture's width were merely rounded, that derived scale would differ
   * from the real device pixel ratio by up to half a pixel over the width — and
   * an element at the bottom of a 20,000 px page would be drawn several pixels
   * from where it is. Giving up at most 16 columns on the right edge (part of
   * the scrollbar gutter on most pages) makes the ratio a measurement rather
   * than an approximation.
   */
  function exactCssWidth(cssWidth, scale) {
    for (let w = Math.floor(cssWidth); w > cssWidth - EXACT_SEARCH_PX && w > 0; w -= 1) {
      const px = w * scale
      if (Math.abs(px - Math.round(px)) < 1e-6) return w
    }
    return null
  }

  /**
   * The picture a page becomes.
   *
   * @param {{
   *   clientWidth: number, clientHeight: number,
   *   scrollWidth: number, scrollHeight: number,
   *   dpr: number,
   * }} measure  What the page said about itself, in CSS pixels.
   * @param {{ maxDimension?: number, maxArea?: number, maxTiles?: number }} [limits]
   * @returns {null | {
   *   cssWidth: number, cssHeight: number, clientHeight: number,
   *   dpr: number, scale: number, pixelWidth: number, pixelHeight: number,
   *   tiles: Array<{ index: number, scrollY: number }>,
   *   truncated: boolean, downscaled: boolean, exact: boolean,
   * }}
   */
  function planPage(measure, limits = {}) {
    if (!measure || typeof measure !== 'object') return null
    const { clientWidth, clientHeight, scrollHeight, dpr } = measure
    if (![clientWidth, clientHeight, scrollHeight, dpr].every(finite)) return null
    if (clientWidth <= 0 || clientHeight <= 0 || dpr <= 0) return null
    const maxDimension = limits.maxDimension ?? MAX_DIMENSION
    const maxArea = limits.maxArea ?? MAX_AREA
    const maxTiles = limits.maxTiles ?? MAX_TILES

    // A page shorter than its viewport is one viewport; a page taller than the
    // tile budget is cut at the budget and SAYS SO rather than capturing forever
    // (an infinite-scroll feed grows every time it is scrolled).
    let cssHeight = Math.max(Math.floor(scrollHeight), Math.floor(clientHeight))
    let truncated = false
    const maxCssHeight = Math.floor(clientHeight) * maxTiles
    if (cssHeight > maxCssHeight) {
      cssHeight = maxCssHeight
      truncated = true
    }

    // The scale is the device pixel ratio unless the picture would not fit the
    // canvas or the memory bound; then the whole page is kept at a smaller
    // scale rather than a part of it at full scale. Both are recorded.
    let scale = dpr
    scale = Math.min(scale, maxDimension / clientWidth, maxDimension / cssHeight)
    scale = Math.min(scale, Math.sqrt(maxArea / (clientWidth * cssHeight)))
    if (!Number.isFinite(scale) || scale < MIN_SCALE) return null
    let downscaled = scale < dpr - 1e-9

    let cssWidth = exactCssWidth(clientWidth, scale)
    let exact = cssWidth !== null
    if (cssWidth === null) cssWidth = Math.floor(clientWidth)
    if (cssWidth <= 0) return null
    let pixelWidth = Math.round(cssWidth * scale)
    let pixelHeight = Math.round(cssHeight * scale)
    const overBound = () => pixelWidth > maxDimension || pixelHeight > maxDimension
      || pixelWidth * pixelHeight > maxArea
    // A bound-derived scale is an irrational number, so rounding both sides up
    // can land a few pixels past the bound — QA measured thousands of ordinary
    // page heights at device scale 2 refused that way. When the scale is
    // already a compromise, pick the WIDTH as a whole pixel count at or below
    // it and make the scale exactly `pixelWidth / cssWidth`: the product can
    // then only shrink, and the ratio the app derives is the one the tiles were
    // drawn at.
    if (downscaled || overBound()) {
      cssWidth = Math.floor(clientWidth)
      pixelWidth = Math.floor(cssWidth * scale)
      if (pixelWidth <= 0) return null
      scale = pixelWidth / cssWidth
      pixelHeight = Math.floor(cssHeight * scale)
      downscaled = scale < dpr - 1e-9
      exact = true
      if (scale < MIN_SCALE) return null
    }
    if (pixelWidth <= 0 || pixelHeight <= 0) return null
    if (pixelWidth > maxDimension || pixelHeight > maxDimension) return null
    if (pixelWidth * pixelHeight > maxArea) return null
    exact = exact && Math.abs(cssWidth * scale - pixelWidth) < 1e-6

    // One tile per viewport, the last one pulled up so it ends exactly at the
    // bottom of the page. It overlaps the tile before it, and that is fine: the
    // same pixels land in the same place.
    const tiles = []
    const step = Math.floor(clientHeight)
    const last = Math.max(0, cssHeight - step)
    for (let y = 0; ; y += step) {
      const scrollY = Math.min(y, last)
      tiles.push({ index: tiles.length, scrollY })
      if (scrollY >= last) break
    }

    return {
      cssWidth,
      cssHeight,
      clientHeight: step,
      dpr,
      scale,
      pixelWidth,
      pixelHeight,
      tiles,
      truncated,
      downscaled,
      exact,
    }
  }

  /**
   * Where one photographed viewport lands in the picture.
   *
   * `actualScrollY` is what the page reported AFTER scrolling — never the
   * position that was asked for, because a page clamps at its end, a sticky
   * layout may refuse, and the last tile is deliberately short of a full step.
   * The tile bitmap is at the page's own device pixel ratio and may include the
   * scrollbar gutter on the right, so the source rectangle is cropped to the
   * picture's exact width and the destination is scaled only when the plan is.
   *
   * @returns {null | {
   *   sx: number, sy: number, sw: number, sh: number,
   *   dx: number, dy: number, dw: number, dh: number,
   * }}
   */
  function placeTile(plan, actualScrollY, bitmap) {
    if (!plan || !bitmap || !finite(actualScrollY)) return null
    if (!finite(bitmap.width) || !finite(bitmap.height)) return null
    if (bitmap.width <= 0 || bitmap.height <= 0) return null
    if (actualScrollY < 0) return null
    const sw = Math.min(bitmap.width, Math.round(plan.cssWidth * plan.dpr))
    const sh = Math.min(bitmap.height, Math.round(plan.clientHeight * plan.dpr))
    if (sw <= 0 || sh <= 0) return null
    const dy = Math.round(actualScrollY * plan.scale)
    if (dy >= plan.pixelHeight) return null
    const dw = Math.min(plan.pixelWidth, Math.round((sw / plan.dpr) * plan.scale))
    // The bottom edge is rounded as a POSITION, not as a length added to dy:
    // at a fractional scale two roundings would leave a one-row gap between
    // this tile and the next one, which starts at the same position rounded.
    const dh = Math.min(plan.pixelHeight, Math.round((actualScrollY + sh / plan.dpr) * plan.scale)) - dy
    if (dw <= 0 || dh <= 0) return null
    // Keep source and destination describing the same rows when the bottom of
    // the picture cuts the tile short.
    const keptSh = plan.scale === plan.dpr ? dh : Math.round((dh / plan.scale) * plan.dpr)
    return { sx: 0, sy: 0, sw, sh: Math.min(sh, keptSh), dx: 0, dy, dw, dh }
  }

  /**
   * How a byte count splits into wire messages.
   *
   * A native messaging frame is bounded on the host side, so the PNG travels
   * as base64 chunks of a fixed character count. Every chunk boundary is a
   * multiple of four characters, which is what lets the app concatenate the
   * pieces before decoding once.
   */
  function chunkPlan(base64Length, chunkChars) {
    if (!finite(base64Length) || base64Length < 0) return null
    if (!finite(chunkChars) || chunkChars < 4 || chunkChars % 4 !== 0) return null
    const chunks = Math.max(1, Math.ceil(base64Length / chunkChars))
    return { chunks, chunkChars }
  }

  const api = {
    planPage,
    placeTile,
    chunkPlan,
    exactCssWidth,
    MAX_DIMENSION,
    MAX_AREA,
    MAX_TILES,
    MIN_SCALE,
  }
  if (typeof globalThis !== 'undefined') globalThis.__capturepackFullPagePlan = api
  if (typeof self !== 'undefined') self.__capturepackFullPagePlan = api
})()
