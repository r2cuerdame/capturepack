// CapturePack extension background: forwards protocol v1 messages to the
// CapturePack native host. The DOM is never streamed — messages flow only when
// the user picks an element or the tab context changes.

const HOST = 'com.capturepack.host'
const PROTOCOL = 1

let port = null
// How long to wait before dialling again after a failed or dropped connection.
// It backs off so a browser running without CapturePack installed does not
// spend its life starting a process that is not there, and it resets the
// moment a connection succeeds.
const RETRY_MIN_MS = 2000
const RETRY_MAX_MS = 60000
let retryMs = RETRY_MIN_MS
let retryTimer = null

function scheduleRetry() {
  if (retryTimer) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS)
    connect()
  }, retryMs)
}

function connect() {
  if (port) return port
  try {
    port = chrome.runtime.connectNative(HOST)
    port.onDisconnect.addListener(() => {
      // Host not installed, app not running, or this extension's ID not yet in
      // the host manifest. All three are temporary, and all three used to end
      // here — see the note on the startup connect below.
      port = null
      scheduleRetry()
    })
    port.postMessage({
      type: 'host.hello',
      protocol: PROTOCOL,
      timestamp: Date.now(),
      app: 'capturepack-extension',
      version: chrome.runtime.getManifest().version,
    })
    retryMs = RETRY_MIN_MS
  } catch {
    port = null
    scheduleRetry()
  }
  return port
}

// CONNECT BECAUSE WE EXIST, NOT BECAUSE SOMETHING HAPPENED.
//
// This used to dial the host only from send(), i.e. only once the user changed
// tab or picked an element. That made the ordinary install look broken: loading
// the folder is step 2, registering the ID it was given is step 3, and by then
// nothing had ever tried to connect — so Settings sat on "not connected" until
// the user happened to switch tabs, and reported it as "설치했는데 연결됨이 안됨".
// The handshake is what the panel is waiting to see, so it is sent as soon as
// there is a service worker to send it, and retried when it fails.
chrome.runtime.onInstalled.addListener(() => connect())
chrome.runtime.onStartup.addListener(() => connect())
connect()

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
