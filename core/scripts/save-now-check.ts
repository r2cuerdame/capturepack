// `--save-now` is the half of the CI capture that nobody can press (#63).
//
// `--capture-now` has existed for a while and proves nothing on its own: it
// opens the editor and then waits for a person. On a runner there is no person,
// so the flow ended by timeout with an unfinished pack and every investigation
// still ended with "please make one more capture and send it to me".
//
// What is checked here is the DECISION LOGIC, not Electron: which argv arms the
// flag, what verdict a sequence of flow events produces, what a person-less
// export payload contains, and — because an unwired flag is a flag that runs
// never — that the main process and the capture flow actually call into it.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  AWAIT_RENDER_DEFAULT_DEADLINE_MS,
  SAVE_NOW_DEFAULT_DEADLINE_MS,
  SAVE_NOW_EXIT,
  armSaveNow,
  awaitedRenderDirPath,
  noteFlowEnded,
  notePackSaved,
  noteRenderEnded,
  saveNowRequest,
  saveNowVerdict,
  unattendedExportPayload,
  type SaveNowEvent,
} from '../src/main/saveNow'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) passed += 1
  else failed += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

function verdictOf(...events: SaveNowEvent[]): ReturnType<typeof saveNowVerdict> {
  return saveNowVerdict(events)
}

console.log('--save-now (CI capture, #63)')

// --- argv -------------------------------------------------------------------

check(
  'an ordinary launch is not armed',
  saveNowRequest(['CapturePack.exe', '--capture-now=3']) === null,
)
check(
  'the bare flag arms the default deadline',
  saveNowRequest(['--save-now'])?.deadlineMs === SAVE_NOW_DEFAULT_DEADLINE_MS,
)
check(
  '--save-now=45 arms a 45 second deadline',
  saveNowRequest(['--save-now=45'])?.deadlineMs === 45_000,
)
check(
  'a deadline that is not a positive number falls back to the default rather than to zero',
  saveNowRequest(['--save-now=nonsense'])?.deadlineMs === SAVE_NOW_DEFAULT_DEADLINE_MS
    && saveNowRequest(['--save-now=0'])?.deadlineMs === SAVE_NOW_DEFAULT_DEADLINE_MS
    && saveNowRequest(['--save-now=-5'])?.deadlineMs === SAVE_NOW_DEFAULT_DEADLINE_MS,
)
check(
  'a flag that merely starts the same way does not arm it',
  saveNowRequest(['--save-nowhere']) === null,
)
check(
  'an unattended run does not wait for the derived render unless asked to',
  saveNowRequest(['--save-now'])?.renderDeadlineMs === null,
)
check(
  '--await-render adds a SECOND budget without touching the save deadline',
  saveNowRequest(['--save-now=45', '--await-render=90'])?.deadlineMs === 45_000
    && saveNowRequest(['--save-now=45', '--await-render=90'])?.renderDeadlineMs === 90_000,
)
check(
  'the bare --await-render arms its own default',
  saveNowRequest(['--save-now', '--await-render'])?.renderDeadlineMs
    === AWAIT_RENDER_DEFAULT_DEADLINE_MS,
)
check(
  '--await-render means nothing without a run to extend',
  saveNowRequest(['--await-render=90']) === null,
)

// --- verdicts ---------------------------------------------------------------

check(
  'nothing has happened yet, so there is no verdict to exit on',
  verdictOf() === null,
)
check(
  'a saved pack followed by the flow ending is the pass',
  verdictOf({ kind: 'pack-saved', dirPath: 'C:\\out\\CapturePack_1' }, { kind: 'flow-ended' })
    ?.result === 'saved'
    && verdictOf({ kind: 'pack-saved', dirPath: 'C:\\out\\CapturePack_1' }, { kind: 'flow-ended' })
      ?.exitCode === SAVE_NOW_EXIT.saved,
)
check(
  'the pass carries the folder CI has to assert on',
  verdictOf({ kind: 'pack-saved', dirPath: 'C:\\out\\CapturePack_1' }, { kind: 'flow-ended' })
    ?.dirPath === 'C:\\out\\CapturePack_1',
)
check(
  'a saved pack alone is NOT a verdict — the flow has not finished writing it',
  verdictOf({ kind: 'pack-saved', dirPath: 'C:\\out\\CapturePack_1' }) === null,
)
// The three codes are pinned as literals, not merely compared to each other: a
// CI job branches on them, and silently renumbering one would turn a failing
// capture into a green run. Move the pin here when the contract really changes.
check(
  'a flow that ended without a pack exits 20',
  verdictOf({ kind: 'flow-ended' })?.result === 'no-pack'
    && verdictOf({ kind: 'flow-ended' })?.exitCode === 20
    && SAVE_NOW_EXIT.noPack === 20,
)
check(
  'the deadline is its own exit, 21 — never confused with an empty flow',
  verdictOf({ kind: 'deadline' })?.result === 'deadline'
    && verdictOf({ kind: 'deadline' })?.exitCode === 21
    && SAVE_NOW_EXIT.deadline === 21
    && SAVE_NOW_EXIT.saved === 0,
)
check(
  'a pack saved before the deadline still fails, and still names its folder',
  verdictOf({ kind: 'pack-saved', dirPath: 'C:\\out\\CapturePack_1' }, { kind: 'deadline' })
    ?.result === 'deadline'
    && verdictOf({ kind: 'pack-saved', dirPath: 'C:\\out\\CapturePack_1' }, { kind: 'deadline' })
      ?.dirPath === 'C:\\out\\CapturePack_1',
)
check(
  'the first pack of a flow is the one reported',
  verdictOf(
    { kind: 'pack-saved', dirPath: 'first' },
    { kind: 'pack-saved', dirPath: 'second' },
    { kind: 'flow-ended' },
  )?.dirPath === 'first',
)
check(
  'nothing after the deciding event can change the verdict',
  verdictOf({ kind: 'deadline' }, { kind: 'pack-saved', dirPath: 'late' }, { kind: 'flow-ended' })
    ?.result === 'deadline',
)

// --- --await-render: the second question (#135) ------------------------------
//
// The source boundary is where an ordinary unattended run ends and it is right
// to. What it leaves untested is the derived media: a pack CI has ever seen
// declares no media.keyframes, so #133's "a keyframe declares its own size and
// the file agrees" had no end-to-end coverage at all. These verdicts are how a
// job tells the two questions apart in its exit code.

function awaited(...events: SaveNowEvent[]): ReturnType<typeof saveNowVerdict> {
  return saveNowVerdict(events, { awaitRender: true })
}

const savedPack: SaveNowEvent = { kind: 'pack-saved', dirPath: 'C:\\out\\CapturePack_1' }

check(
  'the source boundary is no longer the end: a saved pack and a finished flow keep waiting',
  awaited(savedPack, { kind: 'flow-ended' }) === null,
)
check(
  'a finished render is the pass, and still exits 0',
  awaited(savedPack, { kind: 'flow-ended' }, { kind: 'render-ended', state: 'done' })?.result === 'rendered'
    && awaited(savedPack, { kind: 'flow-ended' }, { kind: 'render-ended', state: 'done' })?.exitCode
      === SAVE_NOW_EXIT.saved,
)
// 22 and 23 are pinned as literals for the same reason 20 and 21 are: a job
// branches on them, and a pack that saved but did not render must never be
// reported as a capture that never finished.
check(
  'a render that failed is its own exit, 23 — the pack is still saved and still named',
  awaited(savedPack, { kind: 'flow-ended' }, { kind: 'render-ended', state: 'failed' })?.result
    === 'render-failed'
    && awaited(savedPack, { kind: 'flow-ended' }, { kind: 'render-ended', state: 'failed' })?.exitCode === 23
    && SAVE_NOW_EXIT.renderFailed === 23
    && awaited(savedPack, { kind: 'flow-ended' }, { kind: 'render-ended', state: 'failed' })?.dirPath
      === 'C:\\out\\CapturePack_1',
)
check(
  'a render that ran out of its own budget is 22, never the save deadline 21',
  awaited(savedPack, { kind: 'flow-ended' }, { kind: 'render-deadline' })?.result === 'render-deadline'
    && awaited(savedPack, { kind: 'flow-ended' }, { kind: 'render-deadline' })?.exitCode === 22
    && SAVE_NOW_EXIT.renderDeadline === 22
    && SAVE_NOW_EXIT.deadline === 21,
)
check(
  'a flow that saved nothing decides at once — there is no render to wait for',
  awaited({ kind: 'flow-ended' })?.result === 'no-pack',
)
check(
  'a render that finished before the flow did is still the render that finished',
  awaited(savedPack, { kind: 'render-ended', state: 'done' }, { kind: 'flow-ended' })?.result === 'rendered',
)
check(
  'the save deadline still wins while the flow is running',
  awaited(savedPack, { kind: 'deadline' })?.result === 'deadline',
)
check(
  'without --await-render the very same events end at the source boundary',
  verdictOf(savedPack, { kind: 'flow-ended' })?.result === 'saved',
)

// --- the person-less export -------------------------------------------------

const snapshot = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer
const payload = unattendedExportPayload(snapshot)
check('the unattended export carries the editor snapshot unchanged', payload.snapshotPng === snapshot)
check('it authors nothing', payload.annotations.length === 0 && payload.title === '' && payload.note === '')
check(
  'it exports the capture instant rather than a scrub position',
  payload.snapshotTMs === null,
)
check(
  'it trims nothing — a trim would put replay bytes behind a background render',
  payload.trimStartMs === null && payload.trimEndMs === null,
)

// --- the runtime arming is reachable ---------------------------------------

async function runtime(): Promise<void> {
  const armed = armSaveNow({ deadlineMs: 60_000, renderDeadlineMs: null })
  notePackSaved('C:\\out\\CapturePack_live')
  noteFlowEnded()
  const verdict = await armed
  check(
    'the live path resolves the same verdict the reducer describes',
    verdict.result === 'saved' && verdict.exitCode === 0 && verdict.dirPath === 'C:\\out\\CapturePack_live',
    `${verdict.result} / ${String(verdict.exitCode)}`,
  )
  check(
    'a run that was not asked to wait never reports a pack to watch a render for',
    awaitedRenderDirPath() === null,
  )
  const timed = await armSaveNow({ deadlineMs: 1, renderDeadlineMs: null })
  check(
    'an armed run that is never told anything exits on its deadline instead of hanging CI',
    timed.result === 'deadline' && timed.exitCode === SAVE_NOW_EXIT.deadline,
    `${timed.result} / ${String(timed.exitCode)}`,
  )

  const awaiting = armSaveNow({ deadlineMs: 60_000, renderDeadlineMs: 60_000 })
  notePackSaved('C:\\out\\CapturePack_rendered')
  noteFlowEnded()
  check(
    'an awaiting run names the pack whose render it is waiting for, so the caller can match it',
    awaitedRenderDirPath() === 'C:\\out\\CapturePack_rendered',
    String(awaitedRenderDirPath()),
  )
  noteRenderEnded('done')
  const rendered = await awaiting
  check(
    'the live path waits past the source boundary and exits 0 once the render lands',
    rendered.result === 'rendered' && rendered.exitCode === 0
      && rendered.dirPath === 'C:\\out\\CapturePack_rendered',
    `${rendered.result} / ${String(rendered.exitCode)}`,
  )

  // THE CLOCK IS HANDED OVER, NOT EXTENDED. A one-millisecond render budget
  // against a minute of save budget can only expire as 22 if the two timers are
  // genuinely separate — sharing one would report this as the save deadline.
  const handover = armSaveNow({ deadlineMs: 60_000, renderDeadlineMs: 1 })
  notePackSaved('C:\\out\\CapturePack_slow_render')
  noteFlowEnded()
  const expired = await handover
  check(
    'a render that never finishes expires on ITS budget, not on the save deadline',
    expired.result === 'render-deadline' && expired.exitCode === SAVE_NOW_EXIT.renderDeadline
      && expired.dirPath === 'C:\\out\\CapturePack_slow_render',
    `${expired.result} / ${String(expired.exitCode)}`,
  )
}

// --- the wiring (an unwired flag runs never) --------------------------------

function wiring(): void {
  const index = source('src/main/index.ts')
  check(
    'the main process reads --save-now from its own argv',
    index.includes('saveNowRequest(process.argv)'),
  )
  check(
    'it arms the run and exits with the verdict code',
    index.includes('armSaveNow(') && index.includes('app.exit(verdict.exitCode)'),
  )
  check(
    'the exit is recorded as deliberate, so the next start does not call the run a disappearance',
    index.includes("noteExitIntent('unattended-save')"),
  )
  // The other half of "a failure is announced exactly once": quitting closes the
  // recorder windows, the recorders report 'process-stopped', and announcing
  // that is telling the user a deliberate exit broke their recording. It also
  // put a second announcement in every log, which is precisely the count CI
  // asserts on.
  check(
    'a recorder shutting down during quit is not announced as a recording failure',
    index.includes("app.on('before-quit'") && index.includes('if (tray === null || quitting) return'),
  )

  const session = source('src/main/session.ts')
  check(
    'the capture flow reports the pack it saved',
    session.includes('notePackSaved('),
  )
  check(
    'and reports that the flow ended, so an editor that saved nothing still exits',
    session.includes('noteFlowEnded()'),
  )
  check(
    'the editor is handed the person-less export instead of waiting for a person',
    session.includes('unattendedExportPayload('),
  )

  // An unwired wait is a wait that never ends. --await-render is only real if
  // the main process subscribes to the render lifecycle and reports terminal
  // states back into the reducer.
  check(
    'the main process subscribes to the render lifecycle when --await-render armed one',
    index.includes('onRenderStateChange(') && index.includes('noteRenderEnded('),
  )
  check(
    'and waits for the LAST render of the pack, not the first',
    index.includes('isRenderInFlight('),
    'a multi-display capture starts one render per display',
  )
  check(
    'the subscription is matched to the pack this run saved',
    index.includes('awaitedRenderDirPath()'),
  )
}

void runtime()
  .then(() => {
    wiring()
    console.log(`\n${String(passed)} passed, ${String(failed)} failed`)
    if (failed > 0) process.exitCode = 1
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
    process.exitCode = 1
  })
