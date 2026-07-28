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
 * gigabyte of stills. Extra state changes are dropped from the END (the
 * earliest changes tell the story).
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
 * - Past MAX_KEYFRAMES the EARLIEST changes are kept, except that the LAST
 *   instant always keeps its slot: that is the capture instant whenever any box
 *   has no lifetime, and it is the one instant SPEC §5.7 names explicitly.
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
  }
  if (raw.length === 0) raw.push(durationMs)

  const sorted = raw
    .map((t) => Math.min(Math.max(0, Math.round(t)), durationMs))
    .sort((p, q) => p - q)

  // Merge against the last KEPT frame (not the previous candidate), so a dense
  // run of changes cannot drift a cluster arbitrarily far from its first frame.
  const times: number[] = []
  for (const t of sorted) {
    const last = times[times.length - 1]
    if (last === undefined || t - last > KEYFRAME_MERGE_MS) times.push(t)
  }
  if (times.length <= MAX_KEYFRAMES) return { times, dropped: 0 }
  // Over the cap: the earliest changes tell the story, but the LAST slot is
  // reserved for the final instant. A box with no lifetime contributes the
  // capture instant (SPEC §5.7) — dropping it would mean the frame the trigger
  // actually froze has no still at all.
  const final = times[times.length - 1] as number
  return {
    times: [...times.slice(0, MAX_KEYFRAMES - 1), final],
    dropped: times.length - MAX_KEYFRAMES,
  }
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
