// CapturePack element picker. Injected on demand when the user clicks the
// toolbar action; picks ONE element, reports it, and removes itself.
;(() => {
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

  function cleanup() {
    document.removeEventListener('mousemove', onMove, true)
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('keydown', onKey, true)
    highlight.remove()
    window.__capturepackPickerActive = false
    window.__capturepackPickerCleanup = null
    // The toolbar badge is the only thing that says the picker was ever armed;
    // clearing it is how "armed" stops being a claim nobody can check.
    try {
      chrome.runtime.sendMessage({ type: 'picker.disarmed' })
    } catch {
      // The worker may be gone; the badge expires on its own.
    }
  }
  window.__capturepackPickerCleanup = cleanup
  try {
    chrome.runtime.sendMessage({ type: 'picker.armed' })
  } catch {
    // No worker: the picker still works, it just cannot light the badge.
  }

  function onClick(e) {
    e.preventDefault()
    e.stopPropagation()
    const el = current || e.target
    const r = el.getBoundingClientRect()
    chrome.runtime.sendMessage({
      type: 'dom.element.selected',
      timestamp: Date.now(),
      element: {
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        role: implicitRole(el),
        text: (el.innerText || '').trim().slice(0, 200),
        selector: buildSelector(el),
        bounds: { x: r.x, y: r.y, width: r.width, height: r.height },
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
    cleanup()
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault()
      cleanup()
    }
  }

  document.addEventListener('mousemove', onMove, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('keydown', onKey, true)
})()
