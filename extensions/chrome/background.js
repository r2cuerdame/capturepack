// CapturePack extension background: forwards protocol v1 messages to the
// CapturePack native host. The DOM is never streamed — messages flow only when
// the user picks an element or the tab context changes.

const HOST = 'com.capturepack.host'
const PROTOCOL = 1

let port = null

function connect() {
  if (port) return port
  try {
    port = chrome.runtime.connectNative(HOST)
    port.onDisconnect.addListener(() => {
      // Host not installed or app not running — stay quiet, retry on next send.
      port = null
    })
    port.postMessage({
      type: 'host.hello',
      protocol: PROTOCOL,
      timestamp: Date.now(),
      app: 'capturepack-extension',
      version: chrome.runtime.getManifest().version,
    })
  } catch {
    port = null
  }
  return port
}

function send(message) {
  const p = connect()
  if (p) {
    try {
      p.postMessage(message)
      return
    } catch {
      port = null
    }
  }
  // No host available: surface briefly on the toolbar icon instead of failing.
  chrome.action.setBadgeText({ text: '!' })
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2000)
}

// Toolbar click: arm the picker in the active tab.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['content-script.js'],
  })
})

// Element selections from the content script.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'dom.element.selected') {
    send({
      ...msg,
      protocol: PROTOCOL,
      tab: {
        url: sender.tab && sender.tab.url ? sender.tab.url : '',
        title: sender.tab && sender.tab.title ? sender.tab.title : '',
      },
    })
  }
})

// Tab context events.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId)
    send({
      type: 'tab.updated',
      protocol: PROTOCOL,
      timestamp: Date.now(),
      tab: { url: tab.url || '', title: tab.title || '' },
    })
  } catch {
    // tab may be gone
  }
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab.active) return
  if (changeInfo.url || changeInfo.status === 'complete') {
    send({
      type: 'url.changed',
      protocol: PROTOCOL,
      timestamp: Date.now(),
      tab: { url: tab.url || '', title: tab.title || '' },
    })
  }
})
