/**
 * `--save-now` — the half of an unattended capture that nobody can press (#63).
 *
 * `--capture-now` opens the editor exactly the way the hotkey does, and then the
 * flow waits for a person: Save, Discard, or the window closing. On a CI runner
 * there is no person, so the run either hung until the job timed out or left a
 * save-first folder nobody had asserted on — which is why every investigation
 * this cycle still ended with "please make one more capture and send it to me".
 *
 * `--save-now` supplies the missing decision: the editor exports with nothing
 * authored, the flow saves, and the app exits with a code that says which of the
 * three things happened. It is deliberately a MAIN-process decision. The editor
 * renderer is not asked to save itself, because then the pack would depend on a
 * renderer being healthy enough to answer — and proving the pack is exactly what
 * the run is for.
 *
 * WHAT THE EXIT PROMISES, AND WHAT IT DOES NOT. The verdict lands when the
 * capture flow RETURNS, which is when source-first save has published the
 * manifest, the annotations, the timeline and the pack documents (see
 * sourceFirstFinalSave.ts). The derived media — the exact ring cut, the
 * annotated replay, the keyframe stills — starts on the next turn of the event
 * loop and is abandoned by the exit that follows. That is the honest boundary
 * and it is the one CI asserts on: waiting for a minutes-long render would make
 * the job's duration a property of the runner's CPU, and a render that failed
 * would be reported as a capture that failed. scripts/assert-capturepack.mjs
 * asserts on the source pack for exactly this reason.
 */
import type { EditorExportPayload } from '../shared/ipc'

/** How long an armed run waits for the flow before giving up. */
export const SAVE_NOW_DEFAULT_DEADLINE_MS = 180_000

/**
 * The exit codes an unattended run can produce.
 *
 * They are deliberately away from 1: an Electron main process that throws
 * during startup already exits 1, and a CI job has to be able to tell "the app
 * fell over" apart from "the app ran and saved nothing".
 */
export const SAVE_NOW_EXIT = {
  /** A pack was saved and its sources are durable. */
  saved: 0,
  /** The flow finished without saving a pack (a cancelled or crashed editor). */
  noPack: 20,
  /** The deadline expired first: the flow never finished at all. */
  deadline: 21,
} as const

export type SaveNowResult = 'saved' | 'no-pack' | 'deadline'

export interface SaveNowRequest {
  deadlineMs: number
}

/** What an unattended run observes. Order matters; the first decisive one wins. */
export type SaveNowEvent =
  | { kind: 'pack-saved'; dirPath: string }
  | { kind: 'flow-ended' }
  | { kind: 'deadline' }

export interface SaveNowVerdict {
  result: SaveNowResult
  exitCode: number
  /** The folder to assert on, when there is one — reported even on a failure. */
  dirPath: string | null
}

/**
 * `--save-now[=SECONDS]`, or null when this launch is not an unattended one.
 *
 * A malformed or non-positive deadline falls back to the default rather than to
 * zero: a typo in a workflow file must not turn into an app that exits before
 * the capture it was asked for can possibly have happened.
 */
export function saveNowRequest(argv: readonly string[]): SaveNowRequest | null {
  const arg = argv.find((candidate) => candidate === '--save-now' || candidate.startsWith('--save-now='))
  if (arg === undefined) return null
  const seconds = Number(arg.split('=')[1] ?? '')
  const deadlineMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : SAVE_NOW_DEFAULT_DEADLINE_MS
  return { deadlineMs }
}

/**
 * The verdict a sequence of events produces, or null while it is still open.
 *
 * A saved pack is NOT on its own a verdict. Source-first save publishes the
 * manifest, then copies the prompt path to the clipboard and raises the save
 * toast, all inside the same promise the flow is awaiting; exiting the instant
 * the folder appeared would cut that in half. The flow ENDING is the signal,
 * and by then everything the pack promises has been written.
 */
export function saveNowVerdict(events: readonly SaveNowEvent[]): SaveNowVerdict | null {
  let dirPath: string | null = null
  for (const event of events) {
    // The first pack of a flow is the one reported: a flow saves one pack, and
    // a second would mean the gate that serializes captures had been bypassed.
    if (event.kind === 'pack-saved') {
      dirPath ??= event.dirPath
      continue
    }
    if (event.kind === 'deadline') {
      return { result: 'deadline', exitCode: SAVE_NOW_EXIT.deadline, dirPath }
    }
    return dirPath === null
      ? { result: 'no-pack', exitCode: SAVE_NOW_EXIT.noPack, dirPath: null }
      : { result: 'saved', exitCode: SAVE_NOW_EXIT.saved, dirPath }
  }
  return null
}

/**
 * What the editor would have sent if a person had opened it and pressed Save
 * without touching anything.
 *
 * Every field is the neutral one on purpose. `snapshotTMs: null` is the CAPTURE
 * INSTANT rather than a scrub position, so the snapshot is the frame the
 * capture was actually about. The trim is absent on both sides because a trim
 * moves the replay bytes into a background re-encode — and a pack whose replay
 * is still being written is a pack CI cannot assert on.
 */
export function unattendedExportPayload(snapshotPng: ArrayBuffer): EditorExportPayload {
  return {
    annotations: [],
    snapshotPng,
    title: '',
    note: '',
    snapshotTMs: null,
    trimStartMs: null,
    trimEndMs: null,
  }
}

// The live run. There is at most one: a process is armed once, at startup, and
// the capture flow is serialized behind a single gate.
let events: SaveNowEvent[] | null = null
let announce: ((verdict: SaveNowVerdict) => void) | null = null
let deadline: ReturnType<typeof setTimeout> | null = null

function record(event: SaveNowEvent): void {
  if (events === null) return
  events.push(event)
  const verdict = saveNowVerdict(events)
  if (verdict === null) return
  const settle = announce
  announce = null
  events = null
  if (deadline !== null) clearTimeout(deadline)
  deadline = null
  settle?.(verdict)
}

/**
 * Arms this process for an unattended save and resolves with the verdict.
 *
 * The deadline is not decoration. Everything between the hotkey and the saved
 * folder can stall — a recorder that never delivers a frame, an editor whose
 * renderer never paints — and a CI job that hangs teaches nobody anything,
 * while an exit code names the failure in the job list.
 */
export function armSaveNow(request: SaveNowRequest): Promise<SaveNowVerdict> {
  events = []
  return new Promise<SaveNowVerdict>((resolve) => {
    announce = resolve
    // Deliberately NOT unref'd: the deadline is the last thing keeping an
    // unattended run answerable, and a timer that lets the loop drain would
    // turn a stalled capture back into the silent hang this flag exists to
    // end. It is cleared the moment a verdict lands, so it never delays one.
    deadline = setTimeout(() => record({ kind: 'deadline' }), request.deadlineMs)
  })
}

/** Source-first save published a pack. A no-op when this run is not armed. */
export function notePackSaved(dirPath: string): void {
  record({ kind: 'pack-saved', dirPath })
}

/** The capture flow returned, whatever it did. A no-op when not armed. */
export function noteFlowEnded(): void {
  record({ kind: 'flow-ended' })
}
