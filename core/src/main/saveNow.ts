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
 *
 * `--await-render[=SECONDS]` BUYS THE OTHER HALF, DELIBERATELY (#135). The
 * boundary above is right, and it left a contract with no end-to-end coverage:
 * a pack CI has ever seen carries no `media.keyframes`, so the rule that a
 * keyframe declares its own width/height and that those match the file (#133)
 * was only ever exercised against a fixture. The flag does NOT move the
 * boundary — an unattended run without it exits exactly where it always did.
 * It adds an OPT-IN second budget that starts when the source is already
 * durable, and its own exit codes, so the two questions stay separate in the
 * job list: "did the capture save a pack" and "did the render this pack asked
 * for finish". A render that fails or runs long is then reported as what it is
 * rather than as a capture that failed.
 */
import type { EditorExportPayload } from '../shared/ipc'

/** How long an armed run waits for the flow before giving up. */
export const SAVE_NOW_DEFAULT_DEADLINE_MS = 180_000

/**
 * How long `--await-render` waits for the derived render, once the source is
 * already on disk.
 *
 * Generous on purpose. This budget is spent re-encoding a replay in a hidden
 * window, so its length is a property of the runner's CPU — the very thing the
 * save deadline refuses to depend on. Keeping it separate is what lets the save
 * deadline stay tight while the render is allowed to take as long as it takes.
 */
export const AWAIT_RENDER_DEFAULT_DEADLINE_MS = 300_000

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
  /**
   * `--await-render` only: the pack IS saved and its sources are durable — the
   * render did not finish in time. Its own code, because it is its own fact: a
   * job that sees this has a pack worth uploading and a render worth chasing,
   * and calling it 21 would say the capture never finished.
   */
  renderDeadline: 22,
  /** `--await-render` only: the pack is saved and the render reported failure. */
  renderFailed: 23,
} as const

export type SaveNowResult =
  | 'saved'
  | 'rendered'
  | 'render-failed'
  | 'render-deadline'
  | 'no-pack'
  | 'deadline'

export interface SaveNowRequest {
  deadlineMs: number
  /**
   * How long to wait for the derived render AFTER the source is durable, or
   * null to exit at the source boundary — which is the default and the
   * behaviour every existing caller gets.
   */
  renderDeadlineMs: number | null
}

/** What an unattended run observes. Order matters; the first decisive one wins. */
export type SaveNowEvent =
  | { kind: 'pack-saved'; dirPath: string }
  | { kind: 'flow-ended' }
  | { kind: 'render-ended'; state: 'done' | 'failed' }
  | { kind: 'render-deadline' }
  | { kind: 'deadline' }

export interface SaveNowVerdict {
  result: SaveNowResult
  exitCode: number
  /** The folder to assert on, when there is one — reported even on a failure. */
  dirPath: string | null
}

/** Seconds out of `--flag=SECONDS`, in ms, or the fallback when it is not one. */
function deadlineFromArg(arg: string, fallbackMs: number): number {
  const seconds = Number(arg.split('=')[1] ?? '')
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : fallbackMs
}

/**
 * `--save-now[=SECONDS]`, or null when this launch is not an unattended one.
 *
 * A malformed or non-positive deadline falls back to the default rather than to
 * zero: a typo in a workflow file must not turn into an app that exits before
 * the capture it was asked for can possibly have happened.
 *
 * `--await-render[=SECONDS]` is read here too but means nothing on its own —
 * there is no run to extend unless `--save-now` armed one.
 */
export function saveNowRequest(argv: readonly string[]): SaveNowRequest | null {
  const arg = argv.find((candidate) => candidate === '--save-now' || candidate.startsWith('--save-now='))
  if (arg === undefined) return null
  const render = argv.find(
    (candidate) => candidate === '--await-render' || candidate.startsWith('--await-render='),
  )
  return {
    deadlineMs: deadlineFromArg(arg, SAVE_NOW_DEFAULT_DEADLINE_MS),
    renderDeadlineMs:
      render === undefined ? null : deadlineFromArg(render, AWAIT_RENDER_DEFAULT_DEADLINE_MS),
  }
}

/**
 * The verdict a sequence of events produces, or null while it is still open.
 *
 * A saved pack is NOT on its own a verdict. Source-first save publishes the
 * manifest, then copies the prompt path to the clipboard and raises the save
 * toast, all inside the same promise the flow is awaiting; exiting the instant
 * the folder appeared would cut that in half. The flow ENDING is the signal,
 * and by then everything the pack promises has been written.
 *
 * With `awaitRender`, the flow ending is where the SECOND question opens rather
 * than where the run closes: the pack is durable, and what is still unknown is
 * whether the derived media it declared arrives. A flow that saved nothing has
 * nothing to render and still decides immediately — waiting for a render that
 * was never started is just the hang this whole flag exists to end.
 */
export function saveNowVerdict(
  events: readonly SaveNowEvent[],
  options: { awaitRender?: boolean } = {},
): SaveNowVerdict | null {
  const awaitRender = options.awaitRender === true
  let dirPath: string | null = null
  let flowEnded = false
  let render: 'done' | 'failed' | 'deadline' | null = null
  for (const event of events) {
    switch (event.kind) {
      // The first pack of a flow is the one reported: a flow saves one pack, and
      // a second would mean the gate that serializes captures had been bypassed.
      case 'pack-saved':
        dirPath ??= event.dirPath
        break
      case 'deadline':
        return { result: 'deadline', exitCode: SAVE_NOW_EXIT.deadline, dirPath }
      case 'flow-ended':
        flowEnded = true
        break
      // Recorded whenever it arrives rather than only after the flow ended: the
      // render is started from inside the same save the flow is finishing, and
      // nothing guarantees which of the two messages is delivered first.
      case 'render-ended':
        render ??= event.state
        break
      case 'render-deadline':
        render ??= 'deadline'
        break
    }
    if (!flowEnded) continue
    if (dirPath === null) {
      return { result: 'no-pack', exitCode: SAVE_NOW_EXIT.noPack, dirPath: null }
    }
    if (!awaitRender) {
      return { result: 'saved', exitCode: SAVE_NOW_EXIT.saved, dirPath }
    }
    if (render === 'done') return { result: 'rendered', exitCode: SAVE_NOW_EXIT.saved, dirPath }
    if (render === 'failed') {
      return { result: 'render-failed', exitCode: SAVE_NOW_EXIT.renderFailed, dirPath }
    }
    if (render === 'deadline') {
      return { result: 'render-deadline', exitCode: SAVE_NOW_EXIT.renderDeadline, dirPath }
    }
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
let armedRequest: SaveNowRequest | null = null

/** True while this run has been asked to wait for the derived render. */
function awaitingRender(): boolean {
  return armedRequest !== null && armedRequest.renderDeadlineMs !== null
}

function record(event: SaveNowEvent): void {
  if (events === null) return
  events.push(event)
  const verdict = saveNowVerdict(events, { awaitRender: awaitingRender() })
  if (verdict === null) {
    // THE CLOCK IS HANDED OVER, NOT EXTENDED. The save deadline has done its
    // whole job the moment the source is durable; what is left to bound is the
    // render, which is a different length for a different reason. Sharing one
    // timer would report a slow render as a capture that never finished (21)
    // and make the save budget depend on the runner's encoder.
    const renderDeadlineMs = armedRequest?.renderDeadlineMs ?? null
    if (event.kind === 'flow-ended' && renderDeadlineMs !== null) {
      if (deadline !== null) clearTimeout(deadline)
      deadline = setTimeout(() => record({ kind: 'render-deadline' }), renderDeadlineMs)
    }
    return
  }
  const settle = announce
  announce = null
  events = null
  armedRequest = null
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
  armedRequest = request
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

/**
 * The pack whose derived render an armed run is waiting for, or null.
 *
 * Exported so the caller can decide whether a render lifecycle event belongs to
 * this run: filenames are compared where `node:path` lives, and this file stays
 * a reducer over plain values that a check can drive without a filesystem.
 */
export function awaitedRenderDirPath(): string | null {
  if (events === null || !awaitingRender()) return null
  const saved = events.find(
    (event): event is Extract<SaveNowEvent, { kind: 'pack-saved' }> => event.kind === 'pack-saved',
  )
  return saved?.dirPath ?? null
}

/**
 * The derived render of the awaited pack reached a terminal state.
 *
 * Only called for a render the caller has already matched to
 * awaitedRenderDirPath() AND confirmed to be the last one in flight for that
 * pack: a multi-display capture starts one render per display, and the first of
 * them finishing is not the pack being finished.
 */
export function noteRenderEnded(state: 'done' | 'failed'): void {
  record({ kind: 'render-ended', state })
}
