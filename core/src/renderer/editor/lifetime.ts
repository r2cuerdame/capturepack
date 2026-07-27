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

/** The default lifetime: `durationMs` centered on the anchor, clamped to the replay. */
export function lifetimeAround(
  anchorMs: number,
  durationMs: number,
  replayDurationMs: number,
): { start_ms: number; end_ms: number } {
  const half = durationMs / 2
  return {
    start_ms: Math.max(0, Math.round(anchorMs - half)),
    end_ms: Math.min(replayDurationMs, Math.round(anchorMs + half)),
  }
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
