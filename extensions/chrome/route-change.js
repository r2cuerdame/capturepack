// Resolve a content-script route hint against the current tab before forwarding
// it. Tab updates can race the message, so the current URL is authoritative.
self.capturepackRouteChanged = async function capturepackRouteChanged(msg, sender, tabs, send, protocol) {
  const tabId = sender.tab && sender.tab.id
  const hintedUrl = typeof msg.url === 'string' ? msg.url.slice(0, 2048) : ''
  if (tabId === undefined || !hintedUrl) return

  try {
    const tab = await tabs.get(tabId)
    if (!tab.active) return
    const currentUrl = typeof tab.url === 'string' ? tab.url.slice(0, 2048) : ''
    if (!currentUrl || new URL(currentUrl).origin !== new URL(hintedUrl).origin) return
    send({
      type: 'url.changed',
      protocol,
      timestamp: Date.now(),
      tab: {
        url: currentUrl,
        title: (typeof tab.title === 'string' ? tab.title : '').slice(0, 512),
      },
    })
  } catch {
    // The tab may have closed or its URL may be unavailable.
  }
}
