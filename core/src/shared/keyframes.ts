// Annotated keyframes (GOAL "Annotated keyframes (LLM-first)", SPEC §5.7/§7.3)
// — the ONE shared rule for WHICH instants get a still and WHAT the file is
// called. LLMs read images, not videos: the annotated-replay render pass also
// saves a PNG at every annotation state change, so a model reconstructs the
// whole story without decoding video.
//
// Every consumer derives from this file — the hidden render window (which
// captures the stills), the exporter (which names and declares them), and the
// document generators (which reference the files before the background render
// has even finished) — so a document can never point at a filename the render
// would not produce.

import type { Annotation } from './types'

/** State changes closer together than this merge into ONE frame (GOAL: ~300 ms). */
export const KEYFRAME_MERGE_MS = 300

/**
 * Upper bound on stills per pack. Each keyframe is a full-resolution PNG held
 * in memory during the render and written into the pack, so a pathological
 * annotation set (hundreds of boxes) must not turn a 30 s capture into a
 * gigabyte of stills.
 *
 * When the cap binds, the slots go to as many DIFFERENT BOXES as fit rather
 * than to the earliest changes — see computeKeyframes. With more boxes than
 * slots some box must go unshown; which one is a choice, and one still per box
 * shows strictly more of the capture than a dense burst of the opening seconds.
 */
export const MAX_KEYFRAMES = 24

/**
 * The replay-clock instants that get an annotated still, ascending.
 *
 * - Every box lifetime contributes its `start_ms` (appearance) and `end_ms`
 *   (disappearance); a box WITHOUT a lifetime contributes the capture instant.
 * - The capture instant is the END of the replay: the trigger froze the buffer,
 *   so its last frame is "now" (the same instant `core.capture.triggered`
 *   carries in timeline.json).
 * - Times within KEYFRAME_MERGE_MS of the previously kept frame merge into it.
 * - A pack with no replay (`replayDurationMs` 0) gets exactly ONE still at 0 —
 *   rendered from snapshot.png, since there is no video to play.
 * - A pack with a replay but no annotations still gets that one still at the
 *   capture instant, so "the render finished" always means "there is at least
 *   one keyframe".
 * - EVERY BOX APPEARS IN AT LEAST ONE STILL IT IS ALIVE IN, unless there are
 *   more boxes than MAX_KEYFRAMES allows. Merging and the cap could each leave
 *   a box represented by no frame at all; the merge hole is repaired before the
 *   cap, and the cap spends its slots on distinct boxes.
 * - Past MAX_KEYFRAMES the LAST instant always keeps its slot: that is the
 *   capture instant whenever any box has no lifetime, and it is the one instant
 *   SPEC §5.7 names explicitly.
 */
export function computeKeyframeTimes(
  annotations: readonly Annotation[],
  replayDurationMs: number,
): number[] {
  return computeKeyframes(annotations, replayDurationMs).times
}

/**
 * computeKeyframeTimes() plus how many state changes the MAX_KEYFRAMES cap
 * dropped — the documents say so rather than quietly claiming the stills
 * reconstruct the whole capture.
 */
export function computeKeyframes(
  annotations: readonly Annotation[],
  replayDurationMs: number,
): { times: number[]; dropped: number } {
  const durationMs =
    Number.isFinite(replayDurationMs) && replayDurationMs > 0 ? Math.round(replayDurationMs) : 0
  // Screenshot-only pack: one still, drawn from snapshot.png (SPEC §7.3).
  if (durationMs === 0) return { times: [0], dropped: 0 }

  const raw: number[] = []
  for (const a of annotations) {
    if (typeof a.start_ms === 'number' && typeof a.end_ms === 'number') {
      raw.push(a.start_ms, a.end_ms)
    } else {
      // No lifetime = visible for the whole capture: its one interesting
      // instant is the capture instant.
      raw.push(durationMs)
    }
    // Authored motion changes the picture without changing the box's
    // lifetime. Each explicit placement is therefore an annotation state
    // change of its own and must be eligible for frames/ just like appearance
    // and disappearance. (Near-identical instants are still merged below and
    // the global cap still applies.)
    for (const frame of a.keyframes ?? []) raw.push(frame.t_ms)
  }
  if (raw.length === 0) raw.push(durationMs)

  const sorted = raw
    .map((t) => Math.min(Math.max(0, Math.round(t)), durationMs))
    .sort((p, q) => p - q)

  // Merge against the last KEPT frame (not the previous candidate), so a dense
  // run of changes cannot drift a cluster arbitrarily far from its first frame.
  const merged: number[] = []
  for (const t of sorted) {
    const last = merged[merged.length - 1]
    if (last === undefined || t - last > KEYFRAME_MERGE_MS) merged.push(t)
  }

  // EVERY BOX GETS A STILL IT IS ACTUALLY ALIVE IN.
  //
  // Merging keeps the EARLIER of two nearby times, and a box's own instants can
  // both land inside a neighbour's merge window — a box living 11561..11600
  // next to a kept 11547 loses both ends and is alive at NO kept frame. The
  // cap does the same thing from the other direction: `slice(0, MAX - 1)`
  // drops the middle of the capture wholesale, and a box whose whole life is
  // in that middle vanishes from the stills. Either way the frames/ folder
  // silently stops being a reconstruction of the capture, and the box most
  // likely to be lost is the SHORT one — which is the manual box a user drew
  // by hand to point at a single moment ("수동 박스도 키프레임 보관 해줘야지").
  //
  // So coverage is checked per annotation and repaired, before the cap rather
  // than after: a rescue time is one the box is provably alive at, and it is
  // marked REQUIRED so the cap spends its budget on representation first and
  // on chronology second.
  const required = new Set<number>()
  for (const a of annotations) {
    const lo =
      typeof a.start_ms === 'number' && typeof a.end_ms === 'number'
        ? clampTo(a.start_ms, durationMs)
        : durationMs
    const hi =
      typeof a.start_ms === 'number' && typeof a.end_ms === 'number'
        ? clampTo(a.end_ms, durationMs)
        : durationMs
    const from = Math.min(lo, hi)
    const to = Math.max(lo, hi)
    if (merged.some((t) => t >= from && t <= to)) continue
    required.add(from)
  }
  const times = required.size === 0 ? merged : [...new Set([...merged, ...required])].sort((p, q) => p - q)

  if (times.length <= MAX_KEYFRAMES) return { times, dropped: 0 }

  // OVER THE CAP: SPEND THE SLOTS ON DIFFERENT BOXES, NOT ON THE EARLIEST
  // CHANGES.
  //
  // This used to keep `times.slice(0, MAX - 1)` — the earliest changes plus the
  // final instant — and on a busy capture that means the whole second half of
  // the recording is unrepresented, however many boxes live there. With more
  // boxes than slots SOMETHING has to go unshown; which something is a choice,
  // and one still per box for as many boxes as fit shows strictly more of the
  // capture than a dense burst of the opening seconds.
  //
  // The final instant keeps its reserved slot regardless: a box with no
  // lifetime contributes the capture instant (SPEC §5.7), and dropping it would
  // mean the frame the trigger actually froze has no still at all.
  const final = times[times.length - 1] as number
  const budget = Math.max(0, MAX_KEYFRAMES - 1)
  const keep = new Set<number>()
  // One representative per box, in the order the boxes appear, so the slots run
  // out at the END of the capture rather than in the middle of it.
  for (const a of [...annotations].sort((p, q) => lifeStart(p, durationMs) - lifeStart(q, durationMs))) {
    if (keep.size >= budget) break
    const from = lifeStart(a, durationMs)
    const to = lifeEnd(a, durationMs)
    if (times.some((t) => t !== final && keep.has(t) && t >= from && t <= to)) continue
    const own = times.find((t) => t !== final && t >= from && t <= to)
    if (own !== undefined) keep.add(own)
  }
  // Whatever budget is left goes back to chronology.
  for (const t of times) {
    if (keep.size >= budget) break
    if (t !== final) keep.add(t)
  }
  return {
    times: [...[...keep].sort((p, q) => p - q), final],
    dropped: times.length - (keep.size + 1),
  }
}

/** First instant a box is alive at, on the clamped replay clock. */
function lifeStart(a: Annotation, durationMs: number): number {
  if (typeof a.start_ms !== 'number' || typeof a.end_ms !== 'number') return durationMs
  return Math.min(clampTo(a.start_ms, durationMs), clampTo(a.end_ms, durationMs))
}

/** Last instant a box is alive at, on the clamped replay clock. */
function lifeEnd(a: Annotation, durationMs: number): number {
  if (typeof a.start_ms !== 'number' || typeof a.end_ms !== 'number') return durationMs
  return Math.max(clampTo(a.start_ms, durationMs), clampTo(a.end_ms, durationMs))
}

/** A replay-clock instant, rounded and held inside the recording. */
function clampTo(ms: number, durationMs: number): number {
  return Math.min(Math.max(0, Math.round(ms)), durationMs)
}

/** Replay-clock label for a keyframe FILENAME, e.g. 3200 -> "00-03.200".
 * Same shape as the documents' `00:03.200`, with ':' replaced — Windows and
 * every archive tool reject a colon in a filename. */
export function keyframeClock(ms: number): string {
  const total = Math.max(0, Math.round(ms))
  const pad = (n: number, w: number): string => String(n).padStart(w, '0')
  return `${pad(Math.floor(total / 60_000), 2)}-${pad(Math.floor((total % 60_000) / 1000), 2)}.${pad(total % 1000, 3)}`
}

/**
 * Pack-relative filename of the `order`-th (1-based) keyframe, e.g.
 * `frames/frame-01_00-03.200.png`. This exact string is what
 * manifest.media.keyframes[].file declares.
 *
 * `dir` is the stills directory: `frames/` for the pack's focused display, and
 * `frames-d<N>/` for another captured display's own stills, which are declared
 * in manifest.media.displays[].keyframes (SPEC §5.6, GOAL "Multi-Monitor
 * Support" — a box belongs to the display it was drawn on, so each display's
 * stills carry ITS OWN boxes).
 */
export function keyframeFileName(order: number, tMs: number, dir = 'frames'): string {
  return `${dir}/frame-${String(Math.max(1, Math.round(order))).padStart(2, '0')}_${keyframeClock(tMs)}.png`
}

/** The stills directory of one non-focused display: `frames-d<index>`. */
export function displayFramesDir(index: number): string {
  return `frames-d${index}`
}

/** The annotated replay of one non-focused display: `replay_annotated-d<index>.webm`. */
export function displayAnnotatedName(index: number): string {
  return `replay_annotated-d${index}.webm`
}
