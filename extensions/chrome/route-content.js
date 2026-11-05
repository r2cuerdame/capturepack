// Bridge route changes from the page's MAIN world into the extension's
// isolated world, where chrome.runtime is available.
;(() => {
  if (window.top !== window || window.__capturepackRouteReceiver) return
  window.__capturepackRouteReceiver = true

  window.addEventListener('message', (event) => {
    const data = event.data
    if (event.source !== window || !data || data.__capturepackRoute !== true) return
    try {
      chrome.runtime.sendMessage({
        type: 'route-changed',
        url: window.location.href,
        title: document.title,
      }).catch(() => {})
    } catch {
      // The extension worker may be restarting while the route changes.
    }
  })
})()
