// Box lifetime helpers: visibility on the replay timeline, the default
// interval stamped at creation, the representative midpoint, and duration
// parsing/formatting for the inline duration editor. Pure functions only.
import type { Annotation } from '../../shared/types'

/**
 * True when box `a` applies at replay position `tMs` (ms, manifest replay
 * clock). start_ms/end_ms are both present or both absent (SPEC §8.4); an
 * absent lifetime means the box applies to the whole capture. At the "now" /
 * native-snapshot state (`atNow`), lifetimes that include the end of the
 * replay also apply.
 */
export function visibleAt(
  a: Annotation,
  tMs: number,
  atNow: boolean,
  replayDurationMs: number,
): boolean {
  if (a.start_ms === undefined || a.end_ms === undefined) return true
  if (atNow) return a.start_ms <= replayDurationMs && a.end_ms >= replayDurationMs
  return tMs >= a.start_ms && tMs <= a.end_ms
}

/**
 * The representative instant of a box: its lifetime MIDPOINT (SPEC §8.4 — the
 * midpoint replaced the old stored t_ms anchor). Absent lifetime = the capture
 * instant ("now"), i.e. the end of the replay.
 */
export function lifetimeMidpoint(a: Annotation, replayDurationMs: number): number {
  if (a.start_ms === undefined || a.end_ms === undefined) return replayDurationMs
  return (a.start_ms + a.end_ms) / 2
}

/**
 * The lifetime a NEW box gets: `durationMs` STARTING at the anchor.
 *
 * It used to be centered on it, and centering is wrong for the gesture that
 * creates it. The anchor is the frame the user was looking at when they
 * clicked — the moment the thing they are annotating is happening. Centering
 * put half the box's life BEFORE that, so a one-second box on a click at 17.9 s
 * began at 17.4 s, showing the annotation over half a second in which the thing
 * it names had not happened yet. Reported three times as "박스 만들면 시간이
 * 가운데 정렬이야".
 *
 * Starting at the anchor also matches how the box is read back: `picked_at_ms`
 * is where the track is anchored (SPEC §8.3), and a lifetime that begins there
 * means the first frame the box is drawn on is the frame it was picked from.
 *
 * AND IT NEVER MOVES THE START BACK TO PROTECT THE DURATION. It used to: a box
 * created near the end of the replay had its start pulled earlier so the
 * nominal duration survived — the same mistake `lifetimeExtending` made until
 * #109, one function along, which is why that one now comes through here rather
 * than restating the rule. A box clicked at 29.5 s of a
 * 30 s replay is a 0.5 s box starting at 29.5 s, not a 1 s box starting at
 * 29.0 s that is drawn over half a second in which the thing it names had not
 * happened yet. The duration shortens, honestly, and the anchor is kept.
 */
export function lifetimeFrom(
  anchorMs: number,
  durationMs: number,
  replayDurationMs: number,
): { start_ms: number; end_ms: number } {
  const start = Math.max(0, Math.min(Math.round(anchorMs), replayDurationMs))
  return { start_ms: start, end_ms: Math.min(replayDurationMs, Math.round(start + durationMs)) }
}

/**
 * A box's lifetime RE-LENGTHENED FROM ITS OWN START.
 *
 * This used to centre the new duration on the box's midpoint, and the defence
 * written here — "the only reading of 'make this 2 seconds' that does not move
 * the box out from under the thing it names" — was wrong about the thing it
 * names. A box STARTS when what it points at happens: that is what
 * `lifetimeFrom` establishes at creation, and what `picked_at_ms` records
 * (SPEC §8.3). Centering moved the start EARLIER every time the duration grew,
 * so making a box longer walked it backwards into frames where the thing had
 * not happened yet — and it moved the end by only half of what was asked for,
 * which is why it read as a bug: "박스 시간 늘리면 이전과 이후로 가운데 중심
 * 으로 시간이 늘어나는 버그".
 *
 * So the START is kept and the END moves — including at the end of the replay,
 * where there is simply less room than was asked for (#109).
 *
 * That last part was written here as an exception, and it was the same bug one
 * step along: a ten-second lifetime asked for on a box starting at 12.0 s of a
 * 14.656 s replay came back as 4.656..14.656, moving the start 7.3 seconds
 * earlier into frames where the window had not been picked yet. The comment
 * above `lifetimeFrom` already claimed this function "was just corrected" for
 * it. It had not been, because nothing tested either of them.
 *
 * It is now the same rule by construction rather than by agreement: extending
 * IS creating, from the box's own start instead of a fresh anchor. Two names
 * because the gestures differ; one behaviour because the box means the same
 * thing either way.
 */
export function lifetimeExtending(
  startMs: number,
  durationMs: number,
  replayDurationMs: number,
): { start_ms: number; end_ms: number } {
  return lifetimeFrom(startMs, durationMs, replayDurationMs)
}

/** "1.0s"-style label for a lifetime duration. */
export function formatDurationLabel(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * Parses free duration input: "1500" / "1500ms" are milliseconds, "1.5s" is
 * seconds. Returns null for anything that is not a positive duration.
 */
export function parseDurationMs(raw: string): number | null {
  const m = /^([0-9]+(?:\.[0-9]+)?)\s*(ms|s)?$/.exec(raw.trim().toLowerCase())
  if (!m || m[1] === undefined) return null
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(m[2] === 's' ? n * 1000 : n)
}
