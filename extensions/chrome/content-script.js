// CapturePack element picker. Injected on demand when the user clicks the
// toolbar action; picks ONE element, reports it, and removes itself.
//
// IT RUNS IN EVERY FRAME (#104). It used to be injected into the top document
// only, and a click inside a cross-origin iframe never reaches the top
// document's listener at all — so on any page that puts its UI in a frame the
// picker armed, highlighted nothing, and swallowed the click. No message, no
// failure, no cleanup: exactly the "nothing happens" that was reported.
//
// A frame can only measure itself, so a pick made below the top document is
// carried UP the frame chain, and each host frame translates the rectangle into
// its own viewport using the iframe element it can see. Every term is measured
// there — the frame's position, its borders and padding, and the scale implied
// by its rendered width against the child's own viewport width. Nothing is
// assumed, and a hop whose numbers do not agree refuses instead of guessing.
//
// The payload passes through the ancestor pages on its way up. That is a real
// exposure and it is accepted deliberately: the picker only ever runs after the
// user clicks the toolbar icon on that tab, and the element they picked is
// being written into a pack of that very page. It is never sent to a page that
// was not already hosting the element.
;(() => {
  const IS_TOP = window.top === window

  // RE-ARMING RE-ARMS. This used to `return` when the flag was already set, so
  // any injection that did not reach its own cleanup — an Escape that raced a
  // navigation, a page that swapped the DOM under it, an exception — left the
  // flag true and the picker SILENTLY never armed again. The user clicks the
  // toolbar icon, nothing visible happens, they click an element, nothing
  // happens: "크롬 dom 에 element가 안잡혀", with no error anywhere to find.
  // A second click now tears the old one down and starts fresh, which is also
  // what a user pressing the button twice means.
  if (window.__capturepackPickerActive && typeof window.__capturepackPickerCleanup === 'function') {
    try {
      window.__capturepackPickerCleanup()
    } catch {
      // The old picker is beyond saving; taking its flag is the point.
    }
  }
  window.__capturepackPickerActive = true

  const highlight = document.createElement('div')
  highlight.style.cssText = [
    'position: fixed',
    'z-index: 2147483647',
    'pointer-events: none',
    'border: 2px solid #7c5cff',
    'background: rgba(124, 92, 255, 0.12)',
    'border-radius: 3px',
    'transition: all 40ms linear',
  ].join(';')
  document.documentElement.appendChild(highlight)

  let current = null

  function cssEscape(v) {
    return window.CSS && CSS.escape ? CSS.escape(v) : v.replace(/([^\w-])/g, '\\$1')
  }

  // Shortest stable selector: unique id → unique tag+attribute → positional path.
  function buildSelector(el) {
    if (el.id && document.querySelectorAll('#' + cssEscape(el.id)).length === 1) {
      return '#' + cssEscape(el.id)
    }
    const parts = []
    let node = el
    while (node && node !== document.body && parts.length < 8) {
      let part = node.tagName.toLowerCase()
      if (node.id) {
        parts.unshift('#' + cssEscape(node.id))
        break
      }
      const parent = node.parentElement
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === node.tagName)
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')'
      }
      parts.unshift(part)
      node = parent
    }
    const selector = parts.join(' > ')
    return selector || el.tagName.toLowerCase()
  }

  function implicitRole(el) {
    const tag = el.tagName.toLowerCase()
    const map = { button: 'button', a: 'link', input: 'textbox', select: 'listbox', textarea: 'textbox', img: 'img', nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo' }
    return el.getAttribute('role') || map[tag] || ''
  }

  function onMove(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY)
    if (!el || el === highlight) return
    current = el
    const r = el.getBoundingClientRect()
    highlight.style.left = r.x + 'px'
    highlight.style.top = r.y + 'px'
    highlight.style.width = r.width + 'px'
    highlight.style.height = r.height + 'px'
  }

  function childFrames() {
    return Array.from(document.querySelectorAll('iframe, frame'))
  }

  function postDown(message) {
    for (const frame of childFrames()) {
      try {
        if (frame.contentWindow) frame.contentWindow.postMessage(message, '*')
      } catch {
        // A frame that cannot be addressed is a frame that has no picker in it.
      }
    }
  }

  function cleanup() {
    document.removeEventListener('mousemove', onMove, true)
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('keydown', onKey, true)
    window.removeEventListener('message', onFrameMessage, true)
    highlight.remove()
    window.__capturepackPickerActive = false
    window.__capturepackPickerCleanup = null
    // The toolbar badge is the only thing that says the picker was ever armed;
    // clearing it is how "armed" stops being a claim nobody can check. Only the
    // top frame speaks, or a page with forty ad frames would report forty times.
    if (!IS_TOP) return
    try {
      chrome.runtime.sendMessage({ type: 'picker.disarmed' })
    } catch {
      // The worker may be gone; the badge expires on its own.
    }
  }
  window.__capturepackPickerCleanup = cleanup

  /** Tear every frame down, from wherever the pick or the Escape happened. */
  function disarmEverywhere() {
    if (IS_TOP) {
      postDown({ __capturepack: 'disarm' })
      cleanup()
      return
    }
    try {
      window.top.postMessage({ __capturepack: 'disarm' }, '*')
    } catch {
      // Nothing above will hear it; this frame still stops.
    }
    cleanup()
  }

  if (IS_TOP) {
    try {
      chrome.runtime.sendMessage({ type: 'picker.armed' })
    } catch {
      // No worker: the picker still works, it just cannot light the badge.
    }
  }

  /**
   * A child frame's pick, in THIS frame's viewport coordinates.
   *
   * Reads the DOM here and hands numbers to `frame-geometry.js`, which owns the
   * arithmetic and is the part a test can reach. A null answer from it is a
   * refusal — the two measurements are not describing the same box — and a
   * refused pick is reported rather than placed somewhere plausible.
   */
  function translateFromFrame(payload, host) {
    const geometry = window.__capturepackFrameGeometry
    if (!geometry) return null
    const rect = host.getBoundingClientRect()
    const style = window.getComputedStyle(host)
    const px = (value) => {
      const n = parseFloat(value)
      return Number.isFinite(n) ? n : 0
    }
    const translated = geometry.translateFrameRect({
      hostRect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      hostInsets: {
        left: px(style.borderLeftWidth) + px(style.paddingLeft),
        top: px(style.borderTopWidth) + px(style.paddingTop),
        right: px(style.borderRightWidth) + px(style.paddingRight),
        bottom: px(style.borderBottomWidth) + px(style.paddingBottom),
      },
      childViewportWidth: payload.viewportWidth,
      bounds: payload.bounds,
    })
    if (translated === null) return null
    return {
      element: payload.element,
      frameDepth: payload.frameDepth + 1,
      viewportWidth: window.innerWidth,
      bounds: {
        x: translated.x,
        y: translated.y,
        width: translated.width,
        height: translated.height,
      },
    }
  }

  function sendPick(payload) {
    chrome.runtime.sendMessage({
      type: 'dom.element.selected',
      timestamp: Date.now(),
      element: {
        ...payload.element,
        frameDepth: payload.frameDepth,
        bounds: {
          x: payload.bounds.x,
          y: payload.bounds.y,
          width: payload.bounds.width,
          height: payload.bounds.height,
        },
      },
      // WHERE THAT RECTANGLE IS ON THE SCREEN.
      //
      // `bounds` above is viewport CSS pixels — the only space a page can
      // measure itself in, and one that says nothing about where the browser
      // window is. Sent alone it cannot be placed on a snapshot at all, which
      // is why picking an element in Chrome produced a box around the WHOLE
      // WINDOW: with no candidate to offer, the editor fell back to the window
      // rung. "크롬에서 잡은건 select하면 전체창이 잡혀".
      //
      // The app supplies the other half from the surface ring, which already
      // records this window's CLIENT rectangle in physical pixels. Given the
      // viewport's size in CSS px and the device pixel ratio, the viewport's
      // physical size is known — and a viewport is anchored to the BOTTOM of
      // the client area (tab strip and omnibox sit above it), so the offset
      // falls out of the two heights without the page having to guess at
      // browser chrome. Scroll position is deliberately NOT sent:
      // getBoundingClientRect is already viewport-relative.
      //
      // Only the TOP frame ever sends this, because only the top frame's
      // viewport is the one the window's client rectangle describes.
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
        // Best-effort screen anchor for a reader that has no ring sample of
        // this window (an older pack, a browser the host never saw). CSS px,
        // and on a scaled display Chrome reports these in the OS's own scaled
        // space — usable as a fallback, never preferred over the client rect.
        screenX: typeof window.screenX === 'number' ? window.screenX : null,
        screenY: typeof window.screenY === 'number' ? window.screenY : null,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight,
      },
    })
  }

  function reportFailure(reason) {
    try {
      chrome.runtime.sendMessage({ type: 'picker.failed', reason })
    } catch {
      // Nothing to report to; the pick is lost either way, loudly is better.
    }
  }

  /** Hand a pick to the frame above, or send it if this frame is the top. */
  function deliver(payload) {
    if (IS_TOP) {
      sendPick(payload)
      disarmEverywhere()
      return
    }
    try {
      window.parent.postMessage({ __capturepack: 'pick', payload }, '*')
    } catch {
      reportFailure('frame-chain-unreachable')
      disarmEverywhere()
    }
  }

  function onFrameMessage(e) {
    const data = e.data
    if (!data || typeof data !== 'object') return
    if (data.__capturepack === 'disarm') {
      // FORWARDED FIRST, TORN DOWN SECOND. The frame that made the pick has
      // already cleaned itself up, so gating the forward on "am I still armed"
      // would stop the broadcast dead at it and leave every frame nested INSIDE
      // it armed forever — listeners and a highlight on a page that thinks the
      // picker is gone. Forwarding only ever goes downward, so it cannot loop.
      postDown({ __capturepack: 'disarm' })
      if (window.__capturepackPickerActive) cleanup()
      return
    }
    if (data.__capturepack !== 'pick') return
    // ONLY WHILE ARMED, AND ONLY FROM A FRAME THIS DOCUMENT ACTUALLY HOSTS.
    // A page can post whatever it likes; a pick is accepted only when the user
    // has armed the picker AND the sender is one of this document's own frames.
    if (!window.__capturepackPickerActive) return
    const payload = data.payload
    if (!payload || typeof payload !== 'object' || !payload.bounds || !payload.element) return
    const host = childFrames().find((frame) => frame.contentWindow === e.source)
    if (host === undefined) return
    const translated = translateFromFrame(payload, host)
    if (translated === null) {
      reportFailure(`frame-geometry-disagrees (depth ${String(payload.frameDepth)})`)
      disarmEverywhere()
      return
    }
    deliver(translated)
  }

  function onClick(e) {
    e.preventDefault()
    e.stopPropagation()
    const el = current || e.target
    const r = el.getBoundingClientRect()
    deliver({
      element: {
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        role: implicitRole(el),
        text: (el.innerText || '').trim().slice(0, 200),
        selector: buildSelector(el),
      },
      frameDepth: 0,
      viewportWidth: window.innerWidth,
      bounds: { x: r.x, y: r.y, width: r.width, height: r.height },
      // THE INTERFACE THE PICKED ELEMENT SAT IN (GOAL "The still carries the
      // context").
      //
      // Taken here, on the click, and not on a request from the app — because
      // this is the one moment Chrome has granted permission to read the page.
      // `activeTab` is given for a user gesture on the extension, and the app's
      // own capture hotkey is not a gesture Chrome can see. Asking for
      // `<all_urls>` instead would buy a standing right to read every page in
      // order to avoid a click the user has already made.
      //
      // Only the TOP document, and only once: a pick inside an iframe still
      // reports its element up the chain, but the snapshot belongs to the frame
      // whose client rectangle the app can translate.
      document: IS_TOP && window.__capturepackDocumentSnapshot
        ? window.__capturepackDocumentSnapshot()
        : undefined,
    })
    if (!IS_TOP) cleanup()
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault()
      disarmEverywhere()
    }
  }

  document.addEventListener('mousemove', onMove, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('keydown', onKey, true)
  window.addEventListener('message', onFrameMessage, true)
})()
