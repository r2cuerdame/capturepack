// CapturePack extension background: forwards protocol v1 messages to the
// CapturePack native host. The DOM is never streamed — messages flow only when
// the user picks an element or the tab context changes.

const HOST = 'com.capturepack.host'
const PROTOCOL = 1

let port = null
// When the app's hello was received on the CURRENT port, or null when this
// extension is not holding an end-to-end connection it has proved.
let handshakeAt = null
// How long to wait before dialling again after a failed or dropped connection.
// It backs off so a browser running without CapturePack installed does not
// spend its life starting a process that is not there, and it resets the
// moment a connection succeeds.
const RETRY_MIN_MS = 2000
const RETRY_MAX_MS = 60000
let retryMs = RETRY_MIN_MS
let retryTimer = null
let helloTimer = null
const UPDATE_ATTEMPT_KEY = 'capturepackUpdateAttempt'

function clearHelloTimer() {
  if (!helloTimer) return
  clearTimeout(helloTimer)
  helloTimer = null
}

function scheduleRetry() {
  if (retryTimer) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS)
    connect()
  }, retryMs)
}

function compareManifestVersions(left, right) {
  const parse = (value) => {
    if (typeof value !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(value)) return null
    return value.split('.').map((part) => Number(part))
  }
  const a = parse(left)
  const b = parse(right)
  if (!a || !b) return null
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0)
    if (difference !== 0) return Math.sign(difference)
  }
  return 0
}

function acceptHandshake(candidate) {
  if (port !== candidate) return
  handshakeAt = Date.now()
  retryMs = RETRY_MIN_MS
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  chrome.action.setBadgeText({ text: '' })
}

function requestOneReload(candidate, loadedVersion, targetVersion) {
  const attempt = `${loadedVersion}->${targetVersion}`
  chrome.storage.local.get(UPDATE_ATTEMPT_KEY, (stored) => {
    if (port !== candidate) return
    if (chrome.runtime.lastError || stored?.[UPDATE_ATTEMPT_KEY] === attempt) {
      // A manually loaded or legacy folder may never acquire the app's files.
      // Accept the old worker after one attempt instead of entering an
      // app-hello -> reload -> app-hello loop forever. Settings still exposes
      // the version/path mismatch so the user can load the stable folder.
      acceptHandshake(candidate)
      return
    }
    chrome.storage.local.set({ [UPDATE_ATTEMPT_KEY]: attempt }, () => {
      if (port !== candidate) return
      if (chrome.runtime.lastError) {
        acceptHandshake(candidate)
        return
      }
      chrome.runtime.reload()
    })
  })
}

// A TIMER CANNOT OUTLIVE THE WORKER THAT SET IT.
//
// The retry above is the fast path and it is not enough on its own. An MV3
// service worker is TERMINATED when it goes idle, and every setTimeout in it
// dies with it — so once the port dropped and the worker went to sleep, nothing
// remained to dial again and Settings sat on "확장 핸드셰이크 ✖" until the user
// happened to switch tabs. That is the state this was reported in twice.
//
// chrome.alarms is the one timer that survives, because firing it is what WAKES
// the worker. One minute is the practical floor for a persistent alarm, which is
// the right cadence for "the app was restarted, try again" — the fast backoff
// above still covers the seconds after a drop, while the worker is still alive.
//
// A live native messaging port also keeps the worker from being torn down, so
// the moment either path succeeds this stops costing anything at all.
const RECONNECT_ALARM = 'capturepack-reconnect'
// UNCONDITIONAL, AND SYNCHRONOUS AT WORKER START.
//
// 0.1.2 tried to be clever here: creating an alarm that already exists resets
// its schedule, so it asked `chrome.alarms.get` first and created the alarm only
// when it was missing. That made the ONE timer meant to survive worker
// termination depend on an ASYNC callback running — and a worker that starts
// with nothing holding it open can be torn down before that callback ever fires.
// The alarm then never exists at all. Measured: after the app restarted, the
// extension went from redialling every 2.3 s to complete silence, and Settings
// sat on "호스트가 접속함 ✖" until the extension was reloaded by hand.
//
// So it is created every time, unconditionally, in the first turn of the worker.
// The reset it causes costs nothing: a worker start ALSO calls connect() below,
// which is the same thing the alarm would have done, and `delayInMinutes` keeps
// the first firing one minute out rather than a full period away.
chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: 1, periodInMinutes: 1 })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RECONNECT_ALARM) return
  retryMs = RETRY_MIN_MS
  // A PORT OBJECT IS NOT A CONNECTION.
  //
  // Reported as "재설치할때마다 캡쳐팩 다시 리로드 안하면 연결이 안돼": reinstalling
  // the app kills the host it was talking to, and the extension then sat
  // disconnected until the user pressed Reload in chrome://extensions.
  //
  // `connect()` returns early whenever `port` is non-null, so everything
  // depends on `onDisconnect` having fired and nulled it. When the host dies
  // mid-handshake — which is exactly what an installer replacing the executable
  // does — the extension can be left holding a port it believes in and never
  // dials again. `handshakeAt` is the only proof of a LIVE connection: it is
  // set when the app answers hello and cleared on every disconnect, so a port
  // that has not proved itself by the time this alarm comes round is dropped
  // and redialled rather than trusted.
  if (port && handshakeAt === null) {
    try {
      port.disconnect()
    } catch {
      // Already gone; the point was only to stop believing in it.
    }
    port = null
  }
  connect()
})

function connect() {
  if (port) return port
  try {
    const candidate = chrome.runtime.connectNative(HOST)
    port = candidate
    candidate.onDisconnect.addListener(() => {
      // Chrome reports expected connectNative failures through lastError only
      // for the lifetime of this callback. Reading it marks the error handled;
      // leaving it unread pollutes chrome://extensions even though the bounded
      // retry below is the intended recovery path.
      void chrome.runtime.lastError
      // Host not installed, app not running, or this extension's ID not yet in
      // the host manifest. All three are temporary, and all three used to end
      // here — see the note on the startup connect below.
      if (port !== candidate) return
      clearHelloTimer()
      port = null
      handshakeAt = null
      scheduleRetry()
    })
    candidate.onMessage.addListener((message) => {
      if (port !== candidate) return
      if (message && message.type === 'dom.request' && message.protocol === PROTOCOL) {
        void answerDomRequest(message.request_id)
        return
      }
      if (!message || message.type !== 'host.hello' || message.protocol !== PROTOCOL) return
      // STATE ON CONNECT, NOT ONLY ON CHANGE.
      //
      // The first version announced the grant from permissions.onAdded/onRemoved
      // alone, so an app that started AFTER the user granted — or after this
      // service worker was recycled, which MV3 does constantly — believed the
      // grant did not exist and never asked for a page. Silently. The handshake
      // is the one moment both sides are known to be listening.
      void hasBrowserGrant().then(announceGrant)
      clearHelloTimer()
      const loadedVersion = chrome.runtime.getManifest().version
      // CapturePack updates the stable unpacked folder before opening its
      // bridge. Chromium must reload an unpacked extension to execute changed
      // files, so current versions ask it to do that themselves. Version 0.1.8
      // persists a one-shot guard: a legacy or manually copied folder whose
      // files never change must not reload forever. Moving from a worker older
      // than 0.1.7 still needs one manual Reload because that worker contains
      // no self-update branch at all.
      const targetVersion = typeof message.extensionVersion === 'string'
        ? message.extensionVersion
        : null
      const comparison = targetVersion === null
        ? null
        : compareManifestVersions(targetVersion, loadedVersion)
      if (targetVersion !== null && comparison === 1) {
        requestOneReload(candidate, loadedVersion, targetVersion)
        return
      }
      if (comparison === 0) {
        chrome.storage.local.remove(UPDATE_ATTEMPT_KEY, () => void chrome.runtime.lastError)
      }
      // An extension newer than an older app is compatible at protocol v1 and
      // must never be downgraded or bounced merely because versions differ.
      acceptHandshake(candidate)
    })
    candidate.postMessage({
      type: 'host.hello',
      protocol: PROTOCOL,
      timestamp: Date.now(),
      app: 'capturepack-extension',
      version: chrome.runtime.getManifest().version,
    })
    // Writing only proves Chrome accepted the bytes. The app's hello above is
    // proof that the whole browser → host → app → host → browser path is live.
    handshakeAt = null
    clearHelloTimer()
    helloTimer = setTimeout(() => {
      helloTimer = null
      if (port !== candidate || handshakeAt !== null) return
      try {
        candidate.disconnect()
      } catch {
        // onDisconnect owns the retry when the port is already gone.
      }
    }, 5000)
  } catch {
    clearHelloTimer()
    port = null
    handshakeAt = null
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
      handshakeAt = null
      scheduleRetry()
    }
  }
  // No host available: surface briefly on the toolbar icon instead of failing.
  chrome.action.setBadgeText({ text: '!' })
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2000)
}

// Toolbar click: arm the picker in the active tab.
//
// EVERY STEP OF THIS REPORTS ITSELF. Picking an element failed twice in the
// field with nothing to look at: the native port was healthy (tab.updated
// events arrived in the same capture), the extension was the current version,
// and `dom.element.selected` simply never appeared. Arming is the one step
// that had no observable outcome at all — an executeScript that throws on a
// restricted page (chrome://, the Web Store, a PDF viewer) looked exactly like
// a user who had not clicked the icon. So arming, disarming and failing all go
// down the same wire the picks do, and land in main.log.
async function armPicker(tab, via) {
  if (!tab || !tab.id) {
    send({ type: 'picker.failed', protocol: PROTOCOL, timestamp: Date.now(), reason: 'no-tab', via })
    return
  }
  const url = tab.url || ''
  try {
    // EVERY FRAME, NOT JUST THE TOP ONE (#104). A click inside a cross-origin
    // iframe never reaches the top document, so a top-only injection armed a
    // picker that could not see the click at all — silently, on every page that
    // puts its UI in a frame. The content script carries a pick up the frame
    // chain from wherever it happened.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      // All three share one isolated world, in this order: the geometry and
      // the document walker are already defined by the time the picker looks
      // for them.
      files: ['frame-geometry.js', 'document-snapshot.js', 'content-script.js'],
    })
  } catch (err) {
    // A page the extension may not touch is the common case, and the user has
    // no way to know which pages those are — so say it on the icon AND on the
    // wire, rather than failing silently.
    chrome.action.setBadgeBackgroundColor({ color: '#d93025' })
    chrome.action.setBadgeText({ text: '✕', tabId: tab.id })
    setTimeout(() => chrome.action.setBadgeText({ text: '', tabId: tab.id }), 4000)
    send({
      type: 'picker.failed',
      protocol: PROTOCOL,
      timestamp: Date.now(),
      reason: String(err && err.message ? err.message : err).slice(0, 200),
      via,
      tab: { url: url.slice(0, 2048), title: (tab.title || '').slice(0, 512) },
    })
  }
}

// TWO WAYS IN, ONE PERMISSION STORY.
//
// The toolbar button is not a ceremony we invented — `activeTab` is granted
// only by a user gesture, and it is what lets this extension read the page you
// point at WITHOUT holding permission to read every page you ever open. The
// alternative is `<all_urls>`, which Chrome describes to the user as "read your
// data on all websites", and which would be true.
//
// But Chrome grants `activeTab` for a KEYBOARD SHORTCUT just as it does for a
// toolbar click, so the gesture never had to be a trip to the corner of the
// window. `_execute_action` maps a shortcut straight onto the handler below;
// the user assigns it at chrome://extensions/shortcuts, and nothing about the
// permission model changes.
/**
 * THE ONE-TIME GRANT, AND WHY IT IS THE ONLY WAY TO GET OUT OF TWO STEPS.
 *
 * CapturePack's capture hotkey is a GLOBAL, OS-level key. Chrome never sees it,
 * and `activeTab` is granted only for a gesture made inside Chrome — so "press
 * Ctrl+Alt+S and the page comes with it" cannot be built out of gestures. The
 * native-messaging channel is not the obstacle: it is bidirectional and the app
 * already writes down it. Chrome simply will not hand over a page for a request
 * that did not start in Chrome.
 *
 * Which leaves exactly one mechanism: a host permission the user grants once.
 * It is declared OPTIONAL, so installing this extension still shows no warning
 * and the grant does not exist until it is asked for. When it is granted, the
 * app can fetch the visible document at the moment of a capture and the user
 * does nothing at all.
 *
 * The grant is revocable at any time from chrome://extensions, and the app
 * reports its state so a pack without a `chrome-dom` payload can say WHY.
 */
const ALL_URLS = { origins: ['<all_urls>'] }

async function hasBrowserGrant() {
  try {
    return await chrome.permissions.contains(ALL_URLS)
  } catch {
    return false
  }
}

function announceGrant(granted) {
  send({
    type: 'browser.grant',
    protocol: PROTOCOL,
    timestamp: Date.now(),
    granted: granted === true,
  })
}

if (chrome.permissions && chrome.permissions.onAdded) {
  chrome.permissions.onAdded.addListener(() => { void hasBrowserGrant().then(announceGrant) })
}
if (chrome.permissions && chrome.permissions.onRemoved) {
  chrome.permissions.onRemoved.addListener(() => { void hasBrowserGrant().then(announceGrant) })
}

/**
 * The app asking for the visible document at the moment of a capture.
 *
 * Answered ONLY when the user has granted the browser to CapturePack. Without
 * the grant this refuses and says so, rather than failing in a way that looks
 * like an empty page — the difference a reader needs (SPEC §11.4).
 */
async function answerDomRequest(requestId) {
  const reply = (extra) => send({
    type: 'dom.response',
    protocol: PROTOCOL,
    timestamp: Date.now(),
    request_id: requestId,
    ...extra,
  })
  if (!(await hasBrowserGrant())) {
    reply({ ok: false, reason: 'not-granted' })
    return
  }
  let tab = null
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    tab = tabs[0] ?? null
    if (!tab || !tab.id) { reply({ ok: false, reason: 'no-tab' }); return }
    // Top frame only: a document snapshot is placed by a viewport a reader can
    // locate, and that is the top one.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['frame-geometry.js', 'document-snapshot.js'],
    })
    const [out] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => (window.__capturepackDocumentSnapshot ? window.__capturepackDocumentSnapshot() : null),
    })
    const document_ = out && out.result ? out.result : null
    if (document_ === null) { reply({ ok: false, reason: 'no-snapshot' }); return }
    reply({
      ok: true,
      tab: { url: (tab.url || '').slice(0, 2048), title: (tab.title || '').slice(0, 512) },
      document: document_,
    })
  } catch (err) {
    // chrome://, the Web Store and the PDF viewer are refused even WITH the
    // grant. The capture still happens; it just carries no page.
    reply({
      ok: false,
      reason: String(err && err.message ? err.message : err).slice(0, 200),
      tab: tab ? { url: (tab.url || '').slice(0, 2048), title: (tab.title || '').slice(0, 512) } : null,
    })
  }
}

// TOOLBAR: the grant first, the picker after.
//
// The first click is where the user is actually asked — `permissions.request`
// needs a user gesture, and this is the only one the extension reliably gets.
// Once granted, the button goes back to being the element picker.
chrome.action.onClicked.addListener((tab) => {
  // NOT `async`, AND NOTHING IS AWAITED BEFORE THE REQUEST.
  //
  // `permissions.request` is only allowed inside a live user-gesture context,
  // and an `await` ENDS that context — the continuation runs on a later
  // microtask with no gesture left. The first version checked
  // `hasBrowserGrant()` first, so by the time it asked, Chrome refused to show
  // the prompt at all. Measured: three toolbar clicks, no dialog, and the
  // rejection swallowed by a `catch` that assumed a refusal could only mean the
  // user had said no.
  //
  // So the request goes first, synchronously. Asking for a permission that is
  // already held resolves `true` immediately and shows nothing, which is why the
  // check it replaced was never needed.
  let settled = false
  const thenArm = () => {
    if (settled) return
    settled = true
    void armPicker(tab, 'toolbar')
  }
  try {
    chrome.permissions.request(ALL_URLS).then(
      (granted) => {
        announceGrant(granted)
        if (granted) {
          chrome.action.setBadgeBackgroundColor({ color: '#1a7f37' })
          chrome.action.setBadgeText({ text: '✓', tabId: tab?.id })
          setTimeout(() => chrome.action.setBadgeText({ text: '', tabId: tab?.id }), 4000)
        }
        // The button keeps its second job either way: pick one element here.
        thenArm()
      },
      (err) => {
        // A REFUSAL AND A BROKEN CALL ARE DIFFERENT FACTS. The first is the user
        // answering; the second is this extension asking wrongly, and it must
        // never again look like the first.
        send({
          type: 'picker.failed',
          protocol: PROTOCOL,
          timestamp: Date.now(),
          reason: `grant-request-failed: ${String(err && err.message ? err.message : err).slice(0, 160)}`,
          via: 'toolbar',
        })
        thenArm()
      },
    )
  } catch (err) {
    send({
      type: 'picker.failed',
      protocol: PROTOCOL,
      timestamp: Date.now(),
      reason: `grant-request-threw: ${String(err && err.message ? err.message : err).slice(0, 160)}`,
      via: 'toolbar',
    })
    thenArm()
  }
})



if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener(async (command, tab) => {
    if (command !== 'pick-element') return
    // The shortcut can fire with no tab argument on some Chrome versions; ask
    // for the active one rather than failing on a technicality.
    const target =
      tab ??
      (await chrome.tabs.query({ active: true, currentWindow: true }).then((t) => t[0]))
    await armPicker(target, 'shortcut')
  })
}

// Element selections from the content script.
chrome.runtime.onMessage.addListener((msg, sender) => {
  // ARMED IS A STATE THE USER CAN SEE. Clicking the toolbar icon used to do
  // nothing visible at all, so a picker that failed to arm and a picker
  // waiting for a click looked identical — and when the injection guard was
  // stuck (see content-script.js) the user had no way to tell which they were
  // looking at. The badge is that difference.
  if (msg && msg.type === 'picker.armed') {
    chrome.action.setBadgeBackgroundColor({ color: '#7c5cff' })
    chrome.action.setBadgeText({ text: '◎', ...(sender.tab ? { tabId: sender.tab.id } : {}) })
    send({
      type: 'picker.armed',
      protocol: PROTOCOL,
      timestamp: Date.now(),
      tab: {
        url: sender.tab && sender.tab.url ? sender.tab.url : '',
        title: sender.tab && sender.tab.title ? sender.tab.title : '',
      },
    })
    return
  }
  if (msg && msg.type === 'picker.disarmed') {
    chrome.action.setBadgeText({ text: '', ...(sender.tab ? { tabId: sender.tab.id } : {}) })
    send({
      type: 'picker.disarmed',
      protocol: PROTOCOL,
      timestamp: Date.now(),
      tab: {
        url: sender.tab && sender.tab.url ? sender.tab.url : '',
        title: sender.tab && sender.tab.title ? sender.tab.title : '',
      },
    })
    return
  }
  // A PICK THAT DIED IN THE FRAME CHAIN STILL REPORTS. The content script can
  // fail after arming — a frame whose geometry does not agree, a parent that
  // cannot be reached — and that is the one outcome the user experiences as
  // "I clicked and nothing happened".
  if (msg && msg.type === 'picker.failed') {
    send({
      type: 'picker.failed',
      protocol: PROTOCOL,
      timestamp: Date.now(),
      reason: String(msg.reason || 'unknown').slice(0, 200),
      tab: {
        url: sender.tab && sender.tab.url ? sender.tab.url : '',
        title: sender.tab && sender.tab.title ? sender.tab.title : '',
      },
    })
    return
  }
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
