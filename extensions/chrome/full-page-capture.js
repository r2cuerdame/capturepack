// One explicit toolbar gesture -> one bounded full-page capture.
//
// Chromium does not expose captureBeyondViewport without the debugger
// permission. CapturePack deliberately does not ask for that standing power;
// activeTab plus captureVisibleTab is enough when the page is scrolled and the
// exact scroll positions are carried with every tile.
;(() => {
  const MAX_TILES = 256
  const MAX_DOCUMENT_DIMENSION_CSS = 50_000
  const MAX_DOCUMENT_PIXELS = 40_000_000
  const WARMUP_DELAY_MS = 120
  // Chrome allows at most two captureVisibleTab calls per second.
  const CAPTURE_DELAY_MS = 550
  const CHUNK_CHARS = 512 * 1024

  function axisPositions(length, viewport) {
    if (!(length > 0) || !(viewport > 0)) return []
    if (length <= viewport) return [0]
    const positions = []
    for (let value = 0; value < length - viewport; value += viewport) positions.push(value)
    const last = length - viewport
    if (positions[positions.length - 1] !== last) positions.push(last)
    return positions
  }

  function captureGrid(geometry) {
    const xs = axisPositions(geometry.documentWidth, geometry.viewportWidth)
    const ys = axisPositions(geometry.documentHeight, geometry.viewportHeight)
    const tiles = []
    for (const y of ys) for (const x of xs) tiles.push({ x, y })
    return tiles
  }

  function validateGeometry(geometry) {
    const values = [
      geometry.documentWidth,
      geometry.documentHeight,
      geometry.viewportWidth,
      geometry.viewportHeight,
      geometry.deviceScaleFactor,
    ]
    if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
      throw new Error('page geometry is not finite')
    }
    if (
      geometry.documentWidth > MAX_DOCUMENT_DIMENSION_CSS ||
      geometry.documentHeight > MAX_DOCUMENT_DIMENSION_CSS ||
      geometry.documentWidth * geometry.documentHeight * geometry.deviceScaleFactor ** 2 >
        MAX_DOCUMENT_PIXELS
    ) {
      throw new Error(
        `page is too large for a bounded capture (${geometry.documentWidth}x${geometry.documentHeight} CSS px)`,
      )
    }
    const count = captureGrid(geometry).length
    if (count < 1 || count > MAX_TILES) {
      throw new Error(`page needs ${count} tiles; the safe limit is ${MAX_TILES}`)
    }
  }

  // These functions are serialized by chrome.scripting.executeScript. Keep
  // every dependency inside their own bodies.
  async function preparePage(captureId) {
    const root = document.documentElement
    const body = document.body
    const state = {
      captureId,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      rootScrollBehavior: root.style.getPropertyValue('scroll-behavior'),
      rootScrollPriority: root.style.getPropertyPriority('scroll-behavior'),
      bodyScrollBehavior: body?.style.getPropertyValue('scroll-behavior') || '',
      bodyScrollPriority: body?.style.getPropertyPriority('scroll-behavior') || '',
      hidden: [],
      scrollbarStyle: null,
    }
    window.__capturepackFullPageState = state
    const scrollbarStyle = document.createElement('style')
    scrollbarStyle.textContent =
      'html, body { scrollbar-width: none !important; } ' +
      'html::-webkit-scrollbar, body::-webkit-scrollbar { display: none !important; }'
    ;(document.head || root).appendChild(scrollbarStyle)
    state.scrollbarStyle = scrollbarStyle
    root.style.setProperty('scroll-behavior', 'auto', 'important')
    body?.style.setProperty('scroll-behavior', 'auto', 'important')
    window.scrollTo(0, 0)
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const width = Math.max(root.scrollWidth, body?.scrollWidth || 0, window.innerWidth)
    const height = Math.max(root.scrollHeight, body?.scrollHeight || 0, window.innerHeight)
    return {
      documentWidth: width,
      documentHeight: height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      deviceScaleFactor: window.devicePixelRatio || 1,
      originalScrollX: state.scrollX,
      originalScrollY: state.scrollY,
    }
  }

  async function movePage(captureId, x, y, hideFixed, delayMs) {
    const state = window.__capturepackFullPageState
    if (!state || state.captureId !== captureId) throw new Error('capture state was lost')
    if (hideFixed && state.hidden.length === 0) {
      for (const element of document.querySelectorAll('*')) {
        const position = window.getComputedStyle(element).position
        if (position !== 'fixed' && position !== 'sticky') continue
        state.hidden.push({
          element,
          value: element.style.getPropertyValue('visibility'),
          priority: element.style.getPropertyPriority('visibility'),
        })
        element.style.setProperty('visibility', 'hidden', 'important')
      }
    }
    window.scrollTo(x, y)
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    const root = document.documentElement
    const body = document.body
    return {
      x: window.scrollX,
      y: window.scrollY,
      documentWidth: Math.max(root.scrollWidth, body?.scrollWidth || 0, window.innerWidth),
      documentHeight: Math.max(root.scrollHeight, body?.scrollHeight || 0, window.innerHeight),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      deviceScaleFactor: window.devicePixelRatio || 1,
    }
  }

  async function snapshotPage(captureId) {
    const state = window.__capturepackFullPageState
    if (!state || state.captureId !== captureId) throw new Error('capture state was lost')
    window.scrollTo(0, 0)
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    return window.__capturepackDocumentSnapshot
      ? window.__capturepackDocumentSnapshot({ fullPage: true })
      : null
  }

  async function restorePage(captureId) {
    const state = window.__capturepackFullPageState
    if (!state || state.captureId !== captureId) return
    for (const saved of state.hidden) {
      if (saved.value === '') saved.element.style.removeProperty('visibility')
      else saved.element.style.setProperty('visibility', saved.value, saved.priority)
    }
    const root = document.documentElement
    const body = document.body
    // Keep the forced instant scroll in place until the original position is
    // restored. Re-enabling a site's smooth scrolling first would let this
    // function return while the page was still animating.
    state.scrollbarStyle?.remove()
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    window.scrollTo(state.scrollX, state.scrollY)
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    window.scrollTo(state.scrollX, state.scrollY)
    if (state.rootScrollBehavior === '') root.style.removeProperty('scroll-behavior')
    else root.style.setProperty('scroll-behavior', state.rootScrollBehavior, state.rootScrollPriority)
    if (body) {
      if (state.bodyScrollBehavior === '') body.style.removeProperty('scroll-behavior')
      else body.style.setProperty('scroll-behavior', state.bodyScrollBehavior, state.bodyScrollPriority)
    }
    delete window.__capturepackFullPageState
  }

  function base64Body(dataUrl) {
    const comma = dataUrl.indexOf(',')
    if (comma < 0) throw new Error('Chrome returned a malformed screenshot')
    return dataUrl.slice(comma + 1)
  }

  function utf8Base64(value) {
    const bytes = new TextEncoder().encode(value)
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 32 * 1024) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32 * 1024))
    }
    return btoa(binary)
  }

  function sendChunked(send, type, captureId, tileIndex, base64) {
    let chunkIndex = 0
    for (let offset = 0; offset < base64.length; offset += CHUNK_CHARS) {
      const ok = send({
        type,
        protocol: 1,
        timestamp: Date.now(),
        capture_id: captureId,
        ...(tileIndex === null ? {} : { tile_index: tileIndex }),
        chunk_index: chunkIndex,
        data: base64.slice(offset, offset + CHUNK_CHARS),
      })
      if (!ok) throw new Error('CapturePack native host is unavailable')
      chunkIndex += 1
    }
    return chunkIndex
  }

  function sameCaptureTab(expected, current) {
    return Boolean(
      current &&
      current.id === expected.id &&
      current.windowId === expected.windowId &&
      current.active === true &&
      current.url === expected.url,
    )
  }

  async function assertCaptureTab(tab) {
    const current = await chrome.tabs.get(tab.id)
    if (!sameCaptureTab(tab, current)) {
      throw new Error('the captured tab changed or stopped being active')
    }
  }

  async function run(tab, send, onStarted = () => {}, shouldContinue = () => true) {
    if (!tab?.id || !Number.isInteger(tab.windowId)) throw new Error('no capturable tab')
    const captureId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    onStarted(captureId)
    let prepared = false
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['document-snapshot.js'],
      })
      const [initialResult] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: preparePage,
        args: [captureId],
      })
      prepared = true
      let geometry = initialResult?.result
      validateGeometry(geometry)

      // Warm the complete vertical range before freezing metadata. Lazy-loaded
      // content may extend the document, so repeat to a stable measurement. An
      // infinite feed fails honestly after three bounded passes.
      let stable = false
      for (let pass = 0; pass < 3; pass += 1) {
        const before = geometry
        for (const y of axisPositions(before.documentHeight, before.viewportHeight)) {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: movePage,
            args: [captureId, 0, y, false, WARMUP_DELAY_MS],
          })
        }
        const [remeasured] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: movePage,
          args: [captureId, 0, 0, false, WARMUP_DELAY_MS],
        })
        geometry = { ...before, ...remeasured?.result }
        validateGeometry(geometry)
        stable =
          geometry.documentWidth === before.documentWidth &&
          geometry.documentHeight === before.documentHeight &&
          geometry.viewportWidth === before.viewportWidth &&
          geometry.viewportHeight === before.viewportHeight
        if (stable) break
      }
      if (!stable) throw new Error('page kept growing during lazy-load warmup')

      const [snapshotResult] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: snapshotPage,
        args: [captureId],
      })
      const documentSnapshot = snapshotResult?.result
      if (!documentSnapshot) throw new Error('document snapshot was unavailable')
      const grid = captureGrid(geometry)
      if (!send({
        type: 'page.capture.start',
        protocol: 1,
        timestamp: Date.now(),
        capture_id: captureId,
        captured_at: Date.now(),
        extension_version: chrome.runtime.getManifest().version,
        tab_id: tab.id,
        tab: { url: (tab.url || '').slice(0, 2048), title: (tab.title || '').slice(0, 512) },
        geometry,
        tile_count: grid.length,
      })) throw new Error('CapturePack native host is unavailable')

      const documentChunks = sendChunked(
        send,
        'page.capture.document.chunk',
        captureId,
        null,
        utf8Base64(JSON.stringify(documentSnapshot)),
      )
      send({
        type: 'page.capture.document.end',
        protocol: 1,
        timestamp: Date.now(),
        capture_id: captureId,
        chunk_count: documentChunks,
      })

      for (let index = 0; index < grid.length; index += 1) {
        if (!shouldContinue(captureId)) throw new Error('CapturePack app rejected the capture')
        const target = grid[index]
        const [moved] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: movePage,
          args: [captureId, target.x, target.y, index > 0, CAPTURE_DELAY_MS],
        })
        const actual = moved?.result
        if (!actual) throw new Error('page stopped reporting its scroll position')
        if (
          actual.documentWidth !== geometry.documentWidth ||
          actual.documentHeight !== geometry.documentHeight ||
          actual.viewportWidth !== geometry.viewportWidth ||
          actual.viewportHeight !== geometry.viewportHeight
        ) {
          throw new Error('page geometry changed during capture; try again after it settles')
        }
        // captureVisibleTab targets a WINDOW, not a tab. Verify on both sides
        // of the await so a mid-capture tab switch can never pair foreign pixels
        // with the original page's DOM and URL.
        await assertCaptureTab(tab)
        const png = base64Body(await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }))
        await assertCaptureTab(tab)
        if (!shouldContinue(captureId)) throw new Error('CapturePack app rejected the capture')
        const chunks = sendChunked(send, 'page.capture.tile.chunk', captureId, index, png)
        if (!send({
          type: 'page.capture.tile.end',
          protocol: 1,
          timestamp: Date.now(),
          capture_id: captureId,
          tile_index: index,
          chunk_count: chunks,
          x: actual.x,
          y: actual.y,
        })) throw new Error('CapturePack native host is unavailable')
      }
    } finally {
      if (prepared) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: restorePage,
          args: [captureId],
        })
      }
    }
    // Core may start saving/opening as soon as it adopts `finish`, so publish
    // completion only after the page has been restored successfully.
    if (!send({
      type: 'page.capture.finish',
      protocol: 1,
      timestamp: Date.now(),
      capture_id: captureId,
    })) throw new Error('CapturePack native host is unavailable')
    return captureId
  }

  self.__capturepackFullPageCapture = {
    axisPositions,
    captureGrid,
    validateGeometry,
    sameCaptureTab,
    run,
  }
})()
