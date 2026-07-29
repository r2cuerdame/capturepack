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
  const sendAt = runEdit.indexOf('editor.webContents.send(IPC.editorInit, init)')
  const showAt = runEdit.indexOf('editor.show()', sendAt)
  check(
    'a reopened replay is read from the manifest-declared media path',
    runEdit.includes('replayFileName(manifest.media.replay)')
      && replayReadAt >= 0
      && runEdit.includes('hasReplay: replayWebm !== null')
      && runEdit.includes('replayWebm: replayWebm === null ? null : toArrayBuffer(replayWebm)'),
  )
  check(
    'the replay editor receives editMode before its native window is shown',
    runEdit.includes('editMode: true') && sendAt >= 0 && showAt > sendAt,
    `send=${sendAt}, show=${showAt}`,
  )
  check(
    'slow context restoration cannot keep the replay editor hidden forever',
    runEdit.includes('settleWithin(initialFramePromise, UIA_EDITOR_GRACE_MS)'),
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
