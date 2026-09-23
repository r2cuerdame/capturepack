// The page's side of a full-page capture (#157).
//
// Injected into the TOP frame when the user clicks the toolbar icon. The
// service worker cannot scroll a page or ask it how tall it is; only code in
// the page can. So this exposes a handful of small operations the worker calls
// one at a time through `scripting.executeScript` — measure, scroll, settle,
// hide what would repeat, take the document, put everything back — and holds
// the state needed to undo every one of them.
//
// EVERYTHING IT CHANGES, IT RECORDS FIRST, AND `end()` RESTORES IN REVERSE.
// A capture that leaves the page scrolled to the bottom with its header
// invisible is a bug the user sees before the picture. `end()` is called from a
// `finally` in the worker, and a second injection on a page whose previous
// capture never finished restores that one before starting.
//
// It never reads anything the picture will not show: the document walk is
// `document-snapshot.js` in its document scope, which keeps that file's
// refusals (no field values, nothing hidden, no attribute sweep).
;(() => {
  const STATE_KEY = '__capturepackFullPageState'

  /** The last capture's undo, if it never ran. */
  const previous = window[STATE_KEY]
  if (previous && typeof previous.end === 'function') {
    try {
      previous.end()
    } catch {
      // Beyond saving; taking over is the point.
    }
  }

  const root = document.documentElement
  const body = document.body

  function measure() {
    return {
      clientWidth: root.clientWidth,
      clientHeight: root.clientHeight,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollWidth: Math.max(root.scrollWidth, body ? body.scrollWidth : 0),
      scrollHeight: Math.max(root.scrollHeight, body ? body.scrollHeight : 0),
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      dpr: window.devicePixelRatio || 1,
      url: location.href,
      title: document.title,
    }
  }

  /** An inline style value and priority, so it can be put back exactly. */
  function remember(el, property) {
    return {
      value: el.style.getPropertyValue(property),
      priority: el.style.getPropertyPriority(property),
    }
  }

  function restoreProperty(el, property, saved) {
    if (saved.value === '') el.style.removeProperty(property)
    else el.style.setProperty(property, saved.value, saved.priority)
  }

  /** Walk bound: a page with more elements than this is described, not scanned twice. */
  const MAX_CANDIDATE_WALK = 20000

  const state = {
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    behavior: remember(root, 'scroll-behavior'),
    bodyBehavior: body ? remember(body, 'scroll-behavior') : null,
    /** Elements positioned fixed or sticky at `begin()`, with their inline visibility. */
    candidates: [],
    hidden: [],
    ended: false,
  }

  function begin() {
    state.scrollX = window.scrollX
    state.scrollY = window.scrollY
    // Smooth scrolling would make `scrollTo` land somewhere on its way; the
    // capture needs the position it asked for, now.
    root.style.setProperty('scroll-behavior', 'auto', 'important')
    if (body) body.style.setProperty('scroll-behavior', 'auto', 'important')
    state.candidates = []
    const all = document.getElementsByTagName('*')
    const count = Math.min(all.length, MAX_CANDIDATE_WALK)
    for (let i = 0; i < count; i += 1) {
      const el = all[i]
      const position = window.getComputedStyle(el).position
      if (position === 'fixed' || position === 'sticky') {
        state.candidates.push({ el, position, visibility: remember(el, 'visibility') })
      }
    }
    return { ...measure(), candidates: state.candidates.length }
  }

  function scrollTo(y, x = 0) {
    window.scrollTo(x, y)
    return { scrollX: window.scrollX, scrollY: window.scrollY }
  }

  /** Two frames plus a grace period: a paint, and whatever the scroll started loading. */
  function settle(ms) {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(() => resolve({ scrollY: window.scrollY, scrollHeight: measure().scrollHeight }), ms)
        })
      })
    })
  }

  /**
   * Whether a sticky element is currently STUCK — held at its offset by the
   * viewport rather than sitting where the flow put it. Only a stuck element
   * repeats between tiles; one still in its natural place appears once.
   */
  function isStuck(el) {
    const style = window.getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    const top = parseFloat(style.top)
    if (Number.isFinite(top) && Math.abs(rect.top - top) < 1) return true
    const bottom = parseFloat(style.bottom)
    if (Number.isFinite(bottom) && Math.abs(window.innerHeight - rect.bottom - bottom) < 1) return true
    return false
  }

  /**
   * Hide what would be photographed again on every tile: fixed elements, and
   * sticky elements that are stuck right now. Called after the first tile, so
   * each of them appears exactly once, where the user saw it at the top.
   */
  function hideRepeating() {
    let hidden = 0
    for (const candidate of state.candidates) {
      if (!candidate.el.isConnected) continue
      if (candidate.position === 'sticky' && !isStuck(candidate.el)) continue
      if (state.hidden.includes(candidate)) continue
      candidate.el.style.setProperty('visibility', 'hidden', 'important')
      state.hidden.push(candidate)
      hidden += 1
    }
    return hidden
  }

  function showRepeating() {
    let shown = 0
    for (const candidate of state.hidden) {
      restoreProperty(candidate.el, 'visibility', candidate.visibility)
      shown += 1
    }
    state.hidden = []
    return shown
  }

  /** The whole document as structure, in document CSS pixels. */
  function snapshot(bounds) {
    const walk = window.__capturepackDocumentSnapshot
    if (typeof walk !== 'function') return null
    return walk({ scope: 'document', width: bounds.width, height: bounds.height })
  }

  function end() {
    if (state.ended) return { scrollX: window.scrollX, scrollY: window.scrollY, restored: true }
    state.ended = true
    showRepeating()
    window.scrollTo(state.scrollX, state.scrollY)
    const restored =
      Math.abs(window.scrollX - state.scrollX) < 1 && Math.abs(window.scrollY - state.scrollY) < 1
    restoreProperty(root, 'scroll-behavior', state.behavior)
    if (body && state.bodyBehavior) restoreProperty(body, 'scroll-behavior', state.bodyBehavior)
    if (window[STATE_KEY] === api) window[STATE_KEY] = null
    return {
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      wantedX: state.scrollX,
      wantedY: state.scrollY,
      restored,
    }
  }

  const api = { measure, begin, scrollTo, settle, hideRepeating, showRepeating, snapshot, end }
  window[STATE_KEY] = api
  window.__capturepackFullPage = api
})()
