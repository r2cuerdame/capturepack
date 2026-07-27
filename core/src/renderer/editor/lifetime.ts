// Annotation lifetime helpers: visibility on the replay timeline, the default
// interval stamped at commit, and duration parsing/formatting for the inline
// duration editor. Pure functions only.
import type { Annotation } from '../../shared/types'

/**
 * True when annotation `a` applies at replay position `tMs` (ms, manifest
 * replay clock). Annotations without a lifetime always apply; a half-open
 * lifetime defaults the absent bound to the corresponding capture edge
 * (SPEC §8.3). At the "now" / native-snapshot state (`atNow`), lifetimes
 * that include the end of the replay also apply.
 */
export function visibleAt(
  a: Annotation,
  tMs: number,
  atNow: boolean,
  replayDurationMs: number,
): boolean {
  if (a.t_start_ms === undefined && a.t_end_ms === undefined) return true
  const start = a.t_start_ms ?? 0
  const end = a.t_end_ms ?? replayDurationMs
  if (atNow) return start <= replayDurationMs && end >= replayDurationMs
  return tMs >= start && tMs <= end
}

/** The default lifetime: `durationMs` centered on the anchor, clamped to the replay. */
export function lifetimeAround(
  anchorMs: number,
  durationMs: number,
  replayDurationMs: number,
): { t_start_ms: number; t_end_ms: number } {
  const half = durationMs / 2
  return {
    t_start_ms: Math.max(0, Math.round(anchorMs - half)),
    t_end_ms: Math.min(replayDurationMs, Math.round(anchorMs + half)),
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
