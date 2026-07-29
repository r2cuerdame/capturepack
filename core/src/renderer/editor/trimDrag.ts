export type TrimHandleKind = 'in' | 'out'

export interface TrimDragInput {
  kind: TrimHandleKind
  requestedMs: number
  durationMs: number
  currentMs: number
  inMs: number
  outMs: number | null
  minGapMs: number
}

export interface TrimDragPlan {
  inMs: number
  outMs: number | null
  cursorMs: number
  previewMs: number | null
}

/**
 * One pointer update from a replay-trim handle.
 *
 * Kept separate from the DOM event so the handle, playhead, and selected-box
 * relationship is pinned without synthesizing pointer input on the owner's
 * desktop.
 */
export function planTrimDrag(input: TrimDragInput): TrimDragPlan {
  const durationMs = Math.max(0, input.durationMs)
  const currentMs = Math.max(0, Math.min(durationMs, input.currentMs))
  if (input.kind === 'in') {
    const out = input.outMs ?? durationMs
    // THE START HANDLE EDITS THE RANGE, NOT THE FRAME (#112).
    //
    // The end handle deliberately previews its endpoint, and that seek was
    // accidentally shared with the start handle. On the reported 30 s replay,
    // dragging In from 0 to 8 s while annotating 20 s moved the playhead
    // -12,000 ms and a tracked selection -400 px. In never needs that preview:
    // the pixels under annotation are the evidence being kept, not a view of
    // the boundary. It also stops at the current frame, so keeping that frame
    // still can never strand it to the left of the kept range.
    const inMs = Math.max(
      0,
      Math.min(input.requestedMs, out - input.minGapMs, currentMs),
    )
    return { inMs, outMs: input.outMs, cursorMs: currentMs, previewMs: null }
  }

  // THE END HANDLE ALSO EDITS THE RANGE, NOT THE FRAME.
  //
  // It used to seek to every requested endpoint as a live preview. That made
  // the playhead and every tracked/keyframed box follow the handle even while
  // the current frame was safely inside the kept range — the exact mirror of
  // the old In-handle bug above. Keep the evidence frame still. setRange owns
  // the one necessary clamp when a scrubbed playhead is actually cut away;
  // the native "now" frame deliberately remains native (ScrubController's
  // snapshot-quality guarantee), so an out point can still be authored there.
  const value = Math.min(
    durationMs,
    Math.max(input.requestedMs, input.inMs + input.minGapMs),
  )
  const outMs = value >= durationMs ? null : value
  return {
    inMs: input.inMs,
    outMs,
    cursorMs: currentMs,
    previewMs: null,
  }
}
