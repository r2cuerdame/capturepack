// Native editor-close requests have a bounded renderer-response wait, but a
// correctly displayed unsaved-changes modal hands control back to the user.
// Exercise the production watchdog with a deterministic scheduler: no Electron
// process and no timing-dependent sleeps.
import {
  createEditorCloseWatchdog,
  type WatchdogScheduler,
  type WatchdogTimer,
} from '../src/main/editorCloseWatchdog'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { replayOnce } from '../src/preload/replayOnce'

interface FakeTimer extends WatchdogTimer {
  id: number
  callback: () => void
  delayMs: number
  unrefCount: number
}

class FakeScheduler implements WatchdogScheduler {
  private nextId = 1
  readonly pending = new Map<number, FakeTimer>()

  set(callback: () => void, delayMs: number): FakeTimer {
    const timer: FakeTimer = {
      id: this.nextId,
      callback,
      delayMs,
      unrefCount: 0,
      unref() {
        this.unrefCount += 1
      },
    }
    this.nextId += 1
    this.pending.set(timer.id, timer)
    return timer
  }

  clear(timer: WatchdogTimer): void {
    this.pending.delete((timer as FakeTimer).id)
  }

  fireOnly(): void {
    const timer = [...this.pending.values()][0]
    if (timer === undefined) throw new Error('no pending timer')
    this.pending.delete(timer.id)
    timer.callback()
  }
}

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

function sectionBetween(contents: string, start: string, end: string): string {
  const from = contents.indexOf(start)
  const to = contents.indexOf(end, from + start.length)
  return from >= 0 && to > from ? contents.slice(from, to) : ''
}

console.log('\nEditor native-close response watchdog')
{
  const scheduler = new FakeScheduler()
  let timedOut = 0
  const watchdog = createEditorCloseWatchdog(5_000, () => {
    timedOut += 1
  }, scheduler)

  watchdog.arm()
  const first = [...scheduler.pending.values()][0]
  check('first close request arms one deadline', watchdog.isArmed() && scheduler.pending.size === 1)
  check('deadline is five seconds and does not keep Node alive', first?.delayMs === 5_000 && first.unrefCount === 1)

  watchdog.arm()
  check('duplicate request cannot extend an unanswered deadline', scheduler.pending.size === 1)

  watchdog.acknowledge()
  check('modal-shown acknowledgement clears without timing out', !watchdog.isArmed() && timedOut === 0)

  watchdog.arm()
  const second = [...scheduler.pending.values()][0]
  check('a later Close after Esc re-arms a fresh deadline', second !== undefined && second.id !== first?.id)
  scheduler.fireOnly()
  check('no renderer acknowledgement fires the bounded fallback', timedOut === 1 && !watchdog.isArmed())

  watchdog.arm()
  check('watchdog may re-arm after a fired request until flow disposal', watchdog.isArmed())
  watchdog.dispose()
  check('flow disposal cancels the pending deadline', !watchdog.isArmed() && scheduler.pending.size === 0)
  watchdog.arm()
  check('disposed flow can never arm again', !watchdog.isArmed() && scheduler.pending.size === 0)
}

// `ready-to-show` is a paint milestone, not a renderer-listener handshake.
// The reported blank image editor was the untouched HTML shell: Main sent
// editor:init before editor.ts subscribed, so the snapshot, locale and
// window-mode title strip were never initialized. Exercise both event orders.
console.log('\nEditor bootstrap IPC mailbox')
{
  const beforeSubscribe = replayOnce<{ id: number }>()
  const beforeReceived: number[] = []
  beforeSubscribe.push({ id: 1 })
  beforeSubscribe.subscribe((value) => beforeReceived.push(value.id))
  check(
    'init sent before renderer subscription is replayed exactly once',
    JSON.stringify(beforeReceived) === JSON.stringify([1]),
  )

  const afterSubscribe = replayOnce<{ id: number }>()
  const afterReceived: number[] = []
  afterSubscribe.subscribe((value) => afterReceived.push(value.id))
  afterSubscribe.push({ id: 2 })
  check(
    'init sent after renderer subscription is delivered directly',
    JSON.stringify(afterReceived) === JSON.stringify([2]),
  )

  const replacedPending = replayOnce<{ id: number }>()
  const replacedReceived: number[] = []
  replacedPending.push({ id: 3 })
  replacedPending.push({ id: 4 })
  replacedPending.subscribe((value) => replacedReceived.push(value.id))
  check(
    'only the latest pre-subscription bootstrap can initialize the page',
    JSON.stringify(replacedReceived) === JSON.stringify([4]),
  )
  replacedPending.push({ id: 5 })
  replacedPending.subscribe((value) => replacedReceived.push(value.id))
  check(
    'a delivered bootstrap cannot initialize the editor a second time',
    JSON.stringify(replacedReceived) === JSON.stringify([4]),
  )

  const preload = source('src/preload/editor.ts')
  const renderer = source('src/renderer/editor/editor.ts')
  const session = source('src/main/session.ts')
  const html = source('src/renderer/editor/editor.html')
  const listenerAt = preload.indexOf('ipcRenderer.on(IPC.editorInit')
  const bridgeAt = preload.indexOf("contextBridge.exposeInMainWorld('editorBridge'")
  check(
    'preload owns editor:init before exposing the renderer bridge',
    listenerAt >= 0 &&
      bridgeAt > listenerAt &&
      preload.includes('editorInit.push(payload)') &&
      preload.includes('editorInit.subscribe(cb)'),
  )
  check(
    'windowed title strip reserves native caption space before init arrives',
    html.includes('<body data-window-mode="windowed">'),
  )
  check(
    'renderer acknowledges only after decode and a paint boundary, and reports rejection',
    renderer.includes('.then(() => window.editorBridge.initialized())') &&
      renderer.includes('requestAnimationFrame(() => requestAnimationFrame(() => resolve()))') &&
      renderer.includes('window.editorBridge.initializationFailed(message)') &&
      preload.includes('ipcRenderer.send(IPC.editorInitialized)') &&
      preload.includes('ipcRenderer.send(IPC.editorInitFailed'),
  )
  const handshake = sectionBetween(
    session,
    'function initializeAndShowEditor(',
    '// Resolves when the editor session ends:',
  )
  check(
    'Main listens before sending init and reveals only after renderer success',
    handshake.indexOf('ipcMain.on(IPC.editorInitialized') <
      handshake.indexOf('editor.webContents.send(IPC.editorInit') &&
      handshake.indexOf('editor.webContents.send(IPC.editorInit') <
        handshake.indexOf('editor.show()') &&
      handshake.includes('ipcMain.on(IPC.editorInitFailed') &&
      handshake.includes("editor.once('closed', onClosed)") &&
      (session.match(/await initializeAndShowEditor\(editor, init\)/g) ?? []).length === 3 &&
      (session.match(/editor\.webContents\.send\(IPC\.editorInit/g) ?? []).length === 1,
  )
}

// History's Edit button and the main re-edit flow are an asynchronous contract.
// The rc.36 failure was not a malformed pack: the invoke stayed pending while
// main synchronously entered the long-lived editor flow, so History remained
// painted above a hidden editor and the button looked dead. This source-level
// contract complements the watchdog state-machine test without starting
// Electron or touching a real user pack.
console.log('\nHistory -> replay editor reopen contract')
{
  const mainSource = source('src/main/session.ts')
  const historyMainSource = source('src/main/historyWindow.ts')
  const historyRendererSource = source('src/renderer/history/history.ts')

  const startEdit = sectionBetween(
    mainSource,
    'export function startEditFlow',
    '// Freezing the displays',
  )
  const scheduleAt = startEdit.indexOf('setImmediate(')
  const runAt = startEdit.indexOf('runEditFlow(')
  const acceptedAt = startEdit.lastIndexOf('return true')
  check(
    're-edit acceptance returns before detached pack I/O begins',
    scheduleAt >= 0 && runAt > scheduleAt && acceptedAt > runAt,
    `setImmediate=${scheduleAt}, runEditFlow=${runAt}, return=true=${acceptedAt}`,
  )

  const handler = sectionBetween(
    historyMainSource,
    'ipcMain.handle(IPC.historyOpenPack',
    'ipcMain.handle(IPC.historyPlay',
  )
  check(
    'History receives an explicit accepted/busy result from startEditFlow',
    handler.includes('return startEditFlow(entry.path, liveSettings)')
      && handler.includes('? { ok: true }')
      && handler.includes("history.errFlowBusy"),
  )

  const actions = sectionBetween(
    historyRendererSource,
    'function buildActions',
    'function buildMenu',
  )
  const invokeAt = actions.indexOf('.openPack(p.path)')
  const acceptedResultAt = actions.indexOf('if (result.ok)')
  const closeAt = actions.indexOf('window.close()')
  const errorAt = actions.indexOf('showCardError', acceptedResultAt)
  check(
    'History closes only after main accepts the editor',
    invokeAt >= 0
      && acceptedResultAt > invokeAt
      && closeAt > acceptedResultAt
      && errorAt > closeAt,
    `invoke=${invokeAt}, accepted=${acceptedResultAt}, close=${closeAt}, error=${errorAt}`,
  )
  check(
    'a rejected or failed reopen re-enables the Edit button',
    (actions.match(/editBtn\.disabled = false/g)?.length ?? 0) >= 2,
  )

  const runEdit = sectionBetween(
    mainSource,
    'async function runEditFlow',
    '// The editor window',
  )
  const replayReadAt = runEdit.indexOf('pack.readBinary(replayRel)')
  const editModeAt = runEdit.indexOf('editMode: true')
  const initializeAt = runEdit.indexOf('await initializeAndShowEditor(editor, init)')
  check(
    'a reopened replay is read from the manifest-declared media path',
    runEdit.includes('replayFileName(manifest.media.replay)')
      && replayReadAt >= 0
      && runEdit.includes('hasReplay: replayWebm !== null')
      && runEdit.includes('replayWebm: replayWebm === null ? null : toArrayBuffer(replayWebm)'),
  )
  check(
    'the replay editor receives editMode before the acknowledged initialization flow starts',
    editModeAt >= 0 && initializeAt > editModeAt,
    `editMode=${editModeAt}, initialize=${initializeAt}`,
  )
  check(
    'slow context restoration cannot keep the replay editor hidden forever',
    runEdit.includes('settleWithin(initialFramePromise, UIA_EDITOR_GRACE_MS)'),
  )

  const delayedAttachAt = runEdit.indexOf('if (!settledFrame.ready)')
  const delayedSendAt = runEdit.indexOf('editor.webContents.send(IPC.contextFrame, frame)')
  check(
    'a context frame that misses the open deadline is pushed after acknowledged editor init',
    delayedAttachAt > initializeAt && delayedSendAt > delayedAttachAt,
    `initialize=${initializeAt}, delayed attach=${delayedAttachAt}, send=${delayedSendAt}`,
  )

  const editorSource = source('src/renderer/editor/editor.ts')
  const initEditor = sectionBetween(
    editorSource,
    'async function initEditor',
    '// Windowed mode makes resizing',
  )
  const pushedFrame = sectionBetween(
    editorSource,
    'window.editorBridge.onContextFrame',
    '// Main is the authority on the window state',
  )
  const frameRequest = sectionBetween(
    editorSource,
    'function requestContextFrames',
    '/** Schedules a re-query',
  )
  check(
    'a null init context cannot erase a session adopted from a delayed frame',
    initEditor.includes('if (payload.context !== null) {')
      && initEditor.includes('contextSessionId = payload.context.sessionId')
      && !initEditor.includes('contextSessionId = payload.context?.sessionId ?? null'),
  )
  check(
    'the delayed frame adopts only the first session and rejects another session',
    pushedFrame.includes('if (!adoptPushedContextSession(frame.sessionId)) return')
      && editorSource.includes('function adoptPushedContextSession(')
      && editorSource.includes('return contextSessionId === sessionId'),
  )
  check(
    'late or requested frames from another session cannot replace active indexes',
    editorSource.includes('function contextFrameBelongsToActiveSession(')
      && editorSource.includes('if (!contextFrameBelongsToActiveSession(frame)) return false')
      && frameRequest.includes('answer.frame.sessionId !== sessionId'),
  )
  check(
    'a delayed capture-instant push at another shown time immediately re-queries that time',
    pushedFrame.includes('requestContextFrameNow()')
      && !pushedFrame.includes('scheduleContextFrame()'),
  )

  // EVERY EDITOR WINDOW FORWARDS ITS OWN CONSOLE (#106).
  //
  // Both capture flows did; the re-edit flow never did, so a re-edit was the
  // one session that could not be asked what it had done. A failed display
  // decode, a failed object pick, and every diagnostic added below went nowhere
  // on exactly the path a user reports a problem from. Counting is the point:
  // the next flow that creates an editor gets the same treatment, or this fails.
  const sessionSource = source('src/main/session.ts')
  const editorWindows = sessionSource.split('createEditorWindow(').length - 2 // minus the definition
  const forwarders = sessionSource.split("webContents.on('console-message'").length - 1
  check(
    'every editor window forwards its renderer console to the log',
    editorWindows > 0 && forwarders === editorWindows,
    `${editorWindows} editor window(s), ${forwarders} forwarder(s)`,
  )
  check(
    'the forwarder takes only CapturePack lines, at the level the renderer used',
    sessionSource.includes("if (!message.startsWith('capturepack:')) return"),
  )

  // A CLICK THAT CHANGED NOTHING SAYS SO (#106).
  //
  // Three gates in pointerdown return before anything can happen, and from the
  // user's side all three are indistinguishable from a box that refuses to
  // move. "재편집으로 박스를 못옮기던데" was unanswerable from the machine it
  // happened on because none of them left a trace.
  const pointerDown = sectionBetween(
    editorSource,
    "overlay.addEventListener('pointerdown'",
    'function endDrag(',
  )
  check(
    'the editor reports a click it could not act on',
    editorSource.includes('function reportInertClick(')
      && editorSource.includes('function boardGeometryDescription('),
  )
  for (const [gate, needle] of [
    ['the editor is still loading', 'the editor has not finished loading'],
    ['the point belongs to no display', 'the point belongs to no display'],
    ['the context frame has not settled', 'the context frame for this display has not settled'],
  ] as const) {
    check(`a silent pointerdown return names its reason: ${gate}`, pointerDown.includes(needle))
  }
  check(
    'the no-display report carries the board geometry that would explain it',
    pointerDown.includes('boardGeometryDescription(e)'),
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
