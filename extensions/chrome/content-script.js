// CapturePack element picker. Injected on demand when the user clicks the
// toolbar action; picks ONE element, reports it, and removes itself.
;(() => {
  if (window.__capturepackPickerActive) return
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
