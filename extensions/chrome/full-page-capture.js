// The full-page capture, as one procedure with its browser calls injected (#157).
//
// `background.js` hands this the real Chrome APIs — inject a script, call into
// the page, photograph the viewport, decode a tile, make a canvas — and
// `scripts/full-page-capture-check.mjs` hands it a fake page and a fake canvas.
// The procedure between them is the same code either way, which is the only
// reason a long page, a sticky header, a lazy-loading feed, a restricted page
// and the wire bundle can be tested at all: the service worker they run in is
// not something a test can open.
//
// THE ORDER OF OPERATIONS IS THE CONTRACT.
//
//   1. inject — a page Chrome refuses (chrome://, the Web Store, a PDF) fails
//      HERE, before anything on the page was touched, so there is nothing to
//      restore and the failure is reported honestly.
//   2. begin — remember scroll position and inline styles; disable smooth
//      scrolling so a scroll lands where it is asked to.
//   3. a pre-pass over the page (no photographs) so lazy-loading content has
//      appeared and the final height is known BEFORE the picture is sized.
//   4. tile by tile: scroll, wait for a paint, photograph, place the tile at
//      the position the page ACTUALLY reached. After the first tile, fixed
//      and stuck-sticky elements are hidden so a header appears once.
//   5. back to the top, everything shown again, the whole document walked in
//      document coordinates — the same walker a pick uses, in document scope.
//   6. end, in a finally: scroll and styles restored whatever happened above.
//
// Nothing is streamed. The bundle exists only after the user's click, and it
// goes to the CapturePack app on this machine and nowhere else.
;(() => {
  const plan = globalThis.__capturepackFullPagePlan

  /** Two frames plus this, after every scroll: enough for a paint. */
  const SETTLE_MS = 120
  /** The pre-pass gives lazy content a little longer per viewport. */
  const PREPASS_SETTLE_MS = 160
  /** Chrome allows two `captureVisibleTab` calls a second. */
  const CAPTURE_SPACING_MS = 520
  const QUOTA_RETRY_MS = 650
  const QUOTA_RETRIES = 4
  /** A capture that runs longer than this is abandoned and the page restored. */
  const MAX_CAPTURE_MS = 90_000
  /** Base64 characters per wire chunk (a multiple of four). */
  const CHUNK_CHARS = 512 * 1024

  function reason(err) {
    return String(err && err.message ? err.message : err).slice(0, 200)
  }

  function isQuotaError(err) {
    return /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/iu.test(reason(err))
  }

  /**
   * @param {{
   *   inject: (tabId: number) => Promise<void>,
   *   call: (tabId: number, name: string, args?: unknown[]) => Promise<any>,
   *   captureTile: (tab: { id: number, windowId?: number }) => Promise<string>,
   *   decode: (dataUrl: string) => Promise<{ width: number, height: number, close?: () => void }>,
   *   createCanvas: (width: number, height: number) => {
   *     drawImage: (bitmap: unknown, sx: number, sy: number, sw: number, sh: number,
   *                 dx: number, dy: number, dw: number, dh: number) => void,
   *     toPng: () => Promise<Uint8Array>,
   *   },
   *   sleep: (ms: number) => Promise<void>,
   *   now: () => number,
   *   progress?: (done: number, total: number) => void,
   *   limits?: { maxDimension?: number, maxArea?: number, maxTiles?: number },
   *   settleMs?: number,
   *   captureSpacingMs?: number,
   *   maxCaptureMs?: number,
   * }} io
   */
  function createFullPageCapturer(io) {
    const settleMs = io.settleMs ?? SETTLE_MS
    const prepassSettleMs = io.prepassSettleMs ?? PREPASS_SETTLE_MS
    const spacingMs = io.captureSpacingMs ?? CAPTURE_SPACING_MS
    const maxCaptureMs = io.maxCaptureMs ?? MAX_CAPTURE_MS

    async function photograph(tab, lastCaptureAt) {
      const wait = spacingMs - (io.now() - lastCaptureAt)
      if (wait > 0) await io.sleep(wait)
      let attempt = 0
      for (;;) {
        try {
          return await io.captureTile(tab)
        } catch (err) {
          attempt += 1
          if (!isQuotaError(err) || attempt > QUOTA_RETRIES) throw err
          await io.sleep(QUOTA_RETRY_MS)
        }
      }
    }

    /**
     * @param {{ id: number, windowId?: number, url?: string, title?: string }} tab
     * @returns {Promise<
     *   | { ok: true, png: Uint8Array, page: object, document: object | null }
     *   | { ok: false, reason: string, stage: string, restored: object | null }
     * >}
     */
    async function capture(tab, state) {
      const started = io.now()
      const deadline = started + maxCaptureMs
      const call = (name, ...args) => io.call(tab.id, name, args)
      const expired = () => io.now() > deadline

      try {
        await io.inject(tab.id)
      } catch (err) {
        return { ok: false, stage: 'inject', reason: reason(err) }
      }

      let begun = false
      try {
        const first = await call('begin')
        begun = true
        let measure = first
        let page = plan.planPage(measure, io.limits)
        if (page === null) {
          return { ok: false, stage: 'plan', reason: 'the page could not be measured' }
        }

        // PRE-PASS: walk the page once without photographing it. Lazy images and
        // infinite feeds append as they scroll into view; the height measured
        // AFTER that pass is what the picture is sized to, so a tile never lands
        // below the bottom of a canvas that was cut at the height the page had
        // before it loaded.
        if (page.tiles.length > 1) {
          for (const tile of page.tiles) {
            if (expired()) throw new Error('timeout')
            await call('scrollTo', tile.scrollY)
            await call('settle', prepassSettleMs)
          }
          measure = { ...measure, ...(await call('measure')) }
          page = plan.planPage(measure, io.limits)
          if (page === null) {
            return { ok: false, stage: 'plan', reason: 'the page could not be re-measured' }
          }
        }

        await call('scrollTo', 0)
        await call('settle', settleMs)

        const canvas = io.createCanvas(page.pixelWidth, page.pixelHeight)
        let hidden = 0
        let lastCaptureAt = -Infinity
        const placed = []
        for (const tile of page.tiles) {
          if (expired()) throw new Error('timeout')
          const at = await call('scrollTo', tile.scrollY)
          await call('settle', settleMs)
          const dataUrl = await photograph(tab, lastCaptureAt)
          lastCaptureAt = io.now()
          const bitmap = await io.decode(dataUrl)
          try {
            const place = plan.placeTile(page, at.scrollY, bitmap)
            if (place === null) {
              throw new Error(
                `tile ${String(tile.index)} could not be placed `
                + `(scrolled to ${String(at.scrollY)}, bitmap ${String(bitmap.width)}x${String(bitmap.height)})`,
              )
            }
            canvas.drawImage(
              bitmap,
              place.sx, place.sy, place.sw, place.sh,
              place.dx, place.dy, place.dw, place.dh,
            )
            placed.push({ index: tile.index, scrollY: at.scrollY, y: place.dy, height: place.dh })
          } finally {
            if (typeof bitmap.close === 'function') bitmap.close()
          }
          // After the FIRST tile only: a fixed header has now been photographed
          // where the user saw it, and would otherwise be photographed again at
          // the top of every tile below.
          if (tile.index === 0 && page.tiles.length > 1) hidden = await call('hideRepeating')
          if (io.progress) io.progress(tile.index + 1, page.tiles.length)
        }

        // THE DOCUMENT, FROM THE TOP, WITH EVERYTHING SHOWING. That is the state
        // the first tile photographed, so a fixed element's rectangle in the
        // walk is where it is in the picture.
        await call('scrollTo', 0)
        await call('showRepeating')
        await call('settle', 0)
        const documentSnapshot = await call('snapshot', { width: page.cssWidth, height: page.cssHeight })
        const finalMeasure = await call('measure')

        const png = await canvas.toPng()
        const chunking = plan.chunkPlan(0, CHUNK_CHARS)
        return {
          ok: true,
          png,
          document: documentSnapshot,
          page: {
            url: finalMeasure.url ?? tab.url ?? '',
            title: finalMeasure.title ?? tab.title ?? '',
            cssWidth: page.cssWidth,
            cssHeight: page.cssHeight,
            pixelWidth: page.pixelWidth,
            pixelHeight: page.pixelHeight,
            devicePixelRatio: page.dpr,
            scale: page.scale,
            clientWidth: measure.clientWidth,
            clientHeight: measure.clientHeight,
            scrollWidth: finalMeasure.scrollWidth,
            scrollHeight: finalMeasure.scrollHeight,
            tiles: placed,
            truncated: page.truncated,
            downscaled: page.downscaled,
            exactScale: page.exact,
            hiddenRepeating: hidden,
            captureMs: io.now() - started,
            chunkChars: chunking === null ? CHUNK_CHARS : chunking.chunkChars,
          },
        }
      } catch (err) {
        return {
          ok: false,
          stage: reason(err) === 'timeout' ? 'timeout' : 'capture',
          reason: reason(err),
        }
      } finally {
        if (begun) {
          try {
            state.restored = await call('end')
          } catch {
            // The page navigated or closed under the capture; there is nothing
            // left to restore on.
            state.restored = null
          }
        }
      }
    }

    /**
     * The result plus the restoration record — attached AFTER the `finally`
     * above ran, because a value captured in a `return` expression is frozen
     * before the `finally` block executes.
     */
    async function captureAndRestore(tab) {
      const state = { restored: null }
      const result = await capture(tab, state)
      return { ...result, restored: state.restored }
    }

    return { capture: captureAndRestore }
  }

  /**
   * The wire form of one capture: a header naming the page, the document and
   * the byte count, then the PNG as base64 chunks the app concatenates.
   */
  function bundleMessages(result, options) {
    const { protocol, captureId, tab, via, timestamp, base64 } = options
    const chunking = plan.chunkPlan(base64.length, result.page.chunkChars)
    if (chunking === null) throw new Error('the picture could not be chunked')
    const header = {
      type: 'page.captured',
      protocol,
      timestamp,
      capture_id: captureId,
      via,
      tab,
      page: {
        ...result.page,
        capturedAt: timestamp,
      },
      document: result.document,
      png: { bytes: result.png.byteLength, chunks: chunking.chunks, chunkChars: chunking.chunkChars },
    }
    const chunks = []
    for (let index = 0; index < chunking.chunks; index += 1) {
      chunks.push({
        type: 'page.chunk',
        protocol,
        timestamp,
        capture_id: captureId,
        index,
        data: base64.slice(index * chunking.chunkChars, (index + 1) * chunking.chunkChars),
      })
    }
    return { header, chunks }
  }

  const api = { createFullPageCapturer, bundleMessages, CHUNK_CHARS, MAX_CAPTURE_MS }
  if (typeof globalThis !== 'undefined') globalThis.__capturepackFullPageCapture = api
  if (typeof self !== 'undefined') self.__capturepackFullPageCapture = api
})()
