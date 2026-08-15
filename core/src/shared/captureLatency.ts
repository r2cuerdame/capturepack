/**
 * Pure accounting for how long a capture kept the user waiting.
 *
 * ROADMAP states one constraint over every milestone — "never sacrifice the
 * 5-second workflow" — and until this module existed it was the only quantity
 * in the product nobody measured. `session.ts` logged how soon the display
 * recorders answered, which is a fraction of the flow and the fraction that was
 * never in doubt.
 *
 * WHAT IS MEASURED. Four instants on ONE monotonic clock: the trigger, the
 * pixels frozen, the source pack durable, and the editor visible with its first
 * annotation frame painted. The last one is the boundary that matters, because
 * it is the first moment the person can do the thing they pressed the hotkey
 * for.
 *
 * WHAT IS DELIBERATELY NOT CHARGED TO THE PRODUCT. The image flow contains a
 * human choosing a rectangle, and a video flow can wait on a dialog. That time
 * is the user's. It is subtracted from the hands-off total and REPORTED
 * separately rather than dropped, because a total that quietly excluded an
 * unstated quantity would be the same kind of lie as one that included it.
 *
 * RULE 1 — this may never cost a capture. Nothing here throws. A reading that
 * cannot be trusted sets a refusal, and a refused measurement reports no number
 * at all rather than a plausible one. A capture whose editor never opened is
 * NOT a refusal: it is evidence of how far the flow got, and it is exactly the
 * run a user complains about.
 */
export type CaptureFlowKind = 'video' | 'image' | 're-edit'

/**
 * Ordered. `frozen` and `saved` are absent from a re-edit, which reopens a pack
 * that was written on some earlier day; a missing stage is normal and never a
 * refusal.
 */
export type CaptureLatencyStage = 'frozen' | 'saved' | 'editor-visible'

interface CaptureLatencyMark {
  stage: CaptureLatencyStage
  atMs: number
}

export interface CaptureLatencyState {
  kind: CaptureFlowKind
  triggerAtMs: number
  marks: CaptureLatencyMark[]
  waitedForUserMs: number
  /** First reason this measurement stopped being trustworthy; never cleared. */
  refused: string | null
}

export interface CaptureLatencyReport {
  kind: CaptureFlowKind
  /** Wall offsets from the trigger, user wait INCLUDED — what actually elapsed. */
  stages: { stage: CaptureLatencyStage; fromTriggerMs: number }[]
  /** Trigger to editor-visible with the user's own time removed. */
  handsOffMs: number | null
  waitedForUserMs: number
  refused: string | null
}

function usable(value: number): boolean {
  return Number.isFinite(value)
}

export function beginCaptureLatency(kind: CaptureFlowKind, nowMs: number): CaptureLatencyState {
  return {
    kind,
    triggerAtMs: nowMs,
    marks: [],
    waitedForUserMs: 0,
    refused: usable(nowMs) ? null : 'the trigger has no usable timestamp',
  }
}

/**
 * Records one stage boundary.
 *
 * The first refusal wins and later marks are ignored: once the clock or the
 * call sites have proved unreliable, continuing to append readings would build
 * a report out of the evidence that just failed.
 */
export function markCaptureLatency(
  state: CaptureLatencyState,
  stage: CaptureLatencyStage,
  nowMs: number,
): void {
  if (state.refused !== null) return
  if (!usable(nowMs)) {
    state.refused = `${stage} has no usable timestamp`
    return
  }
  if (state.marks.some((m) => m.stage === stage)) {
    state.refused = `${stage} was recorded twice`
    return
  }
  if (nowMs < state.triggerAtMs) {
    state.refused = `${stage} is stamped before its own trigger`
    return
  }
  const previous = state.marks.at(-1)
  if (previous !== undefined && nowMs < previous.atMs) {
    state.refused = `${stage} is stamped before ${previous.stage}`
    return
  }
  state.marks.push({ stage, atMs: nowMs })
}

/**
 * Adds time the flow spent waiting on the person rather than on itself.
 *
 * Additive because one flow can wait more than once, and each wait is a
 * separate span the caller already measured.
 */
export function noteCaptureLatencyUserWait(state: CaptureLatencyState, waitedMs: number): void {
  if (state.refused !== null) return
  if (!usable(waitedMs)) {
    state.refused = 'a wait on the user has no usable duration'
    return
  }
  if (waitedMs < 0) {
    state.refused = 'a wait on the user cannot be negative'
    return
  }
  state.waitedForUserMs += waitedMs
}

export function captureLatencyReport(state: CaptureLatencyState): CaptureLatencyReport {
  const stages = state.marks.map((m) => ({
    stage: m.stage,
    fromTriggerMs: m.atMs - state.triggerAtMs,
  }))
  const visible = state.marks.find((m) => m.stage === 'editor-visible')
  let refused = state.refused
  let handsOffMs: number | null = null

  if (refused === null) {
    const last = state.marks.at(-1)
    if (last !== undefined && state.waitedForUserMs > last.atMs - state.triggerAtMs) {
      // The user cannot have held the flow longer than the flow lasted. Either
      // a wait was double counted or the spans overlap; both make the total
      // meaningless, and a negative one would look like an impossibly fast app.
      refused = 'the recorded wait on the user is longer than the flow itself'
    } else if (visible !== undefined) {
      handsOffMs = visible.atMs - state.triggerAtMs - state.waitedForUserMs
    }
  }

  return {
    kind: state.kind,
    stages: refused === null ? stages : [],
    handsOffMs: refused === null ? handsOffMs : null,
    waitedForUserMs: state.waitedForUserMs,
    refused,
  }
}

/**
 * The single line this measurement leaves in `main.log`.
 *
 * A refused measurement prints its reason and NO duration. A reader scanning
 * for a number must never find one that the module itself does not stand
 * behind.
 */
export function formatCaptureLatency(report: CaptureLatencyReport): string {
  if (report.refused !== null) {
    return `[capture] latency ${report.kind} — refused: ${report.refused}`
  }
  const stages = report.stages.map((s) => `${s.stage} ${String(s.fromTriggerMs)} ms`).join(', ')
  const parts: string[] = []
  if (stages !== '') parts.push(stages)
  parts.push(
    report.handsOffMs === null
      ? 'hands-off unmeasured — the editor never became visible'
      : `hands-off ${String(report.handsOffMs)} ms`,
  )
  if (report.waitedForUserMs > 0) {
    parts.push(`waited on user ${String(report.waitedForUserMs)} ms`)
  }
  return `[capture] latency ${report.kind} — ${parts.join('; ')}`
}
