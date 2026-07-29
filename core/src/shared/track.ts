// Where a tracked box is at one moment (#86).
//
// SHARED ON PURPOSE. The editor draws the box, the annotated replay renders it
// into video, and the keyframe stills render it again. If those three answered
// the question separately they would drift apart, and the pack would disagree
// with the picture of itself — which is the exact failure this project keeps
// removing. One function, three callers.
//
// THE PACK KEEPS OBSERVATIONS; THE SCREEN SHOWS THE TRAJECTORY (#89, #110).
// annotations.json holds observed rectangles only — an average written into
// the record would be a rectangle nobody saw, indistinguishable from a
// measurement. DRAWING is bounded interpolation between adjacent observations
// when they are close enough to leave no room for a hidden reversal, and a
// jump between observations when they are not; see LERP_MAX_SPAN_MS for the
// two measurements that set the boundary.
import type { Annotation, AnnotationBounds, AnnotationTrackSample } from './types'

/**
 * The nearest RECORDED sample to `tMs`, unchanged, or null when the box has no
 * track.
 *
 * Before the first sample and after the last that is the end it is nearest to,
 * so a box whose lifetime reaches a little past the track does not blink out —
 * its LIFETIME says when it stops (clamped to the object's own end, #77), not
 * the sample list.
 */
export function trackedSampleAt(a: Annotation, tMs: number): AnnotationTrackSample | null {
  const samples = a.tracking?.samples
  if (a.tracking?.enabled !== true || samples === undefined || samples.length === 0) return null
  let best = samples[0]!
  let bestGap = Math.abs(best.t_ms - tMs)
  for (const s of samples) {
    const gap = Math.abs(s.t_ms - tMs)
    if (gap < bestGap) {
      best = s
      bestGap = gap
      continue
    }
    // TWO SAMPLES CAN SHARE AN INSTANT (#93). A window straddling two monitors
    // is observed once per screen, each clipped to that screen — the same
    // object, the same millisecond, two rectangles in two coordinate spaces.
    // Measured on CapturePack_2026-07-29_110219: at 26304 ms the same window
    // was 908x634 at (292,588) on one screen and 52x634 at (0,588) on the
    // other. Picking by time alone leaves the choice to array order, so the box
    // could be drawn with the OTHER screen's rectangle — a real observation, in
    // the wrong space, off by most of a monitor.
    //
    // A sample carries `display` only when it is NOT on the box's own screen
    // (SPEC §8.3), so the tie goes to the one without it: the box stays on the
    // screen it belongs to. When the object leaves that screen entirely there
    // is no tie left and the box follows it across.
    if (gap === bestGap && best.display !== undefined && s.display === undefined) {
      best = s
    }
  }
  return best
}

/**
 * How close two observations must be before DRAWING between them is more
 * honest than jumping (#110). Both regimes are measured, on the same window,
 * the same shake, the same pipeline:
 *
 *   67 ms apart (rc.20, 15 obs/s): interpolation p90 163 snapshot px vs
 *     nearest's 80 — WORSE. A 5–7 Hz shake fits a direction reversal between
 *     two samples, and a straight line across a reversal cuts the corner.
 *   20–45 ms apart (rc.21, ~48 obs/s): interpolation p10/p90 −52/+40 vs
 *     nearest's −76/+56 — BETTER. Half a reversal no longer fits.
 *
 * So interpolation is gated on the gap it would span: under this, the segment
 * is too short to hide a turn; over it, the box jumps between observations as
 * it always did. 40 is under the shortest half-period a hand reaches (~70 ms)
 * with margin for sampling phase.
 */
const LERP_MAX_SPAN_MS = 40

/**
 * The sample to DRAW at `tMs`: the nearest observation's screen space, with
 * the position interpolated between the two observations bracketing `tMs`
 * when — and only when — they are close enough (`LERP_MAX_SPAN_MS`).
 *
 * Pack data is untouched: annotations.json keeps observed rectangles only
 * (#89), and this runs in the three renderers this file exists to keep in
 * agreement. Falls back to the nearest observation outside the track, at an
 * exact sample time, across a display change, or over a wide gap.
 */
function displayedSampleAt(a: Annotation, tMs: number): AnnotationTrackSample | null {
  const nearest = trackedSampleAt(a, tMs)
  if (nearest === null) return nearest
  const samples = a.tracking?.samples
  if (samples === undefined) return nearest
  // The nearest sample decides WHICH SCREEN'S numbers the answer is in (#93);
  // interpolation then only ever runs between two samples of that screen.
  let prev: AnnotationTrackSample | null = null
  let next: AnnotationTrackSample | null = null
  for (const s of samples) {
    if (s.display !== nearest.display) continue
    if (s.t_ms <= tMs && (prev === null || s.t_ms > prev.t_ms)) prev = s
    if (s.t_ms > tMs && (next === null || s.t_ms < next.t_ms)) next = s
  }
  if (prev === null || next === null) return nearest
  const span = next.t_ms - prev.t_ms
  if (span <= 0 || span > LERP_MAX_SPAN_MS) return nearest
  const w = (tMs - prev.t_ms) / span
  return {
    t_ms: tMs,
    x: prev.x + (next.x - prev.x) * w,
    y: prev.y + (next.y - prev.y) * w,
    width: prev.width + (next.width - prev.width) * w,
    height: prev.height + (next.height - prev.height) * w,
    ...(nearest.display === undefined ? {} : { display: nearest.display }),
  }
}

/** The rectangle a tracked box occupies at `tMs`, or null when it has no track. */
export function trackedBoundsAt(a: Annotation, tMs: number): AnnotationBounds | null {
  const s = displayedSampleAt(a, tMs)
  return s === null ? null : boundsOf(s)
}

/**
 * `a` as it should be DRAWN and HIT-TESTED at `tMs`.
 *
 * Returns the annotation itself when it has no track, so the untracked path is
 * byte-identical to what it always was and costs nothing. When it does have
 * one, the copy carries the observed rectangle in `bounds` — and, when the
 * object has crossed to another monitor, that sample's `display` too. Both are
 * fields every existing routine already reads to decide where a box goes, so
 * drawing, blurring, selection and hit-testing follow the object across screens
 * without a line of change and without a time argument threaded through any of
 * them.
 *
 * The copy is a VIEW. Editing writes to the stored annotation, never to this.
 */
export function annotationAt(a: Annotation, tMs: number): Annotation {
  const s = displayedSampleAt(a, tMs)
  if (s === null) return a
  return {
    ...a,
    bounds: boundsOf(s),
    ...(s.display === undefined ? {} : { display: s.display }),
  }
}

function boundsOf(s: AnnotationTrackSample): AnnotationBounds {
  return {
    x: Math.round(s.x),
    y: Math.round(s.y),
    width: Math.round(s.width),
    height: Math.round(s.height),
  }
}
