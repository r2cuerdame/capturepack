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
  SAVE_NOW_DEFAULT_DEADLINE_MS,
  SAVE_NOW_EXIT,
  armSaveNow,
  noteFlowEnded,
  notePackSaved,
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
  const armed = armSaveNow({ deadlineMs: 60_000 })
  notePackSaved('C:\\out\\CapturePack_live')
  noteFlowEnded()
  const verdict = await armed
  check(
    'the live path resolves the same verdict the reducer describes',
    verdict.result === 'saved' && verdict.exitCode === 0 && verdict.dirPath === 'C:\\out\\CapturePack_live',
    `${verdict.result} / ${String(verdict.exitCode)}`,
  )
  const timed = await armSaveNow({ deadlineMs: 1 })
  check(
    'an armed run that is never told anything exits on its deadline instead of hanging CI',
    timed.result === 'deadline' && timed.exitCode === SAVE_NOW_EXIT.deadline,
    `${timed.result} / ${String(timed.exitCode)}`,
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
