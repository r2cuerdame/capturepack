// Where a tracked box is at one moment (#86).
//
// SHARED ON PURPOSE. The editor draws the box, the annotated replay renders it
// into video, and the keyframe stills render it again. If those three answered
// the question separately they would drift apart, and the pack would disagree
// with the picture of itself — which is the exact failure this project keeps
// removing. One function, three callers.
//
// TWO KINDS OF RECTANGLE, AND ONLY ONE IS A MEASUREMENT (SPEC §8.9). A tracked
// box's `tracking.samples` are observations of a real window. A manual box's
// `keyframes` are where the USER put their own annotation. They live in
// separate fields, and the rule below governs the observed ones alone.
//
// EVERY OBSERVED RECTANGLE IT SHOWS WAS OBSERVED (#89) — reaffirmed as a
// decision, not an accident, after interpolation shipped for one release
// candidate and was ordered out ("보간하면 안되지"). A drawn rectangle nobody
// measured is a statement the record cannot back, however plausible its
// position, and it hides the actual defect: the observations are not dense
// enough at the moments that matter. The remedy is getting exact positions at
// their exact times (the host's location-change events), never manufacturing
// positions between the ones we have.
import type {
  Annotation,
  AnnotationBounds,
  AnnotationKeyframe,
  AnnotationTrackSample,
} from './types'

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
 * The rectangle an AUTHORED box occupies at `tMs`, or null when it has none.
 *
 * INTERPOLATED, and for the exact reason `tracking.samples` are not (#89, SPEC
 * §8.9). A tracked sample is a measurement, and a point between two
 * measurements is a position nobody saw — inventing it puts a fiction in the
 * same numbers as a fact. A keyframe is the user saying where their own
 * annotation belongs at that moment; the path between two of their statements
 * is the annotation's presentation, not a claim about the world, so drawing the
 * straight line between them invents nothing. The two kinds live in different
 * fields precisely so this rule cannot leak onto the other.
 *
 * Held flat before the first and after the last, the same way a track is: the
 * LIFETIME says when a box stops being drawn (§8.4), never the keyframe range.
 */
export function keyframedBoundsAt(a: Annotation, tMs: number): AnnotationBounds | null {
  const frames = a.keyframes
  if (frames === undefined || frames.length === 0) return null
  const first = frames[0]!
  if (frames.length === 1 || tMs <= first.t_ms) return boundsOf(first)
  const last = frames[frames.length - 1]!
  if (tMs >= last.t_ms) return boundsOf(last)
  // Ascending by construction — the editor keeps them sorted and SPEC requires
  // it — so the first frame at or past `tMs` and its predecessor bracket it.
  let next = last
  let prev = first
  for (let i = 1; i < frames.length; i += 1) {
    const candidate = frames[i]!
    if (candidate.t_ms >= tMs) {
      next = candidate
      prev = frames[i - 1]!
      break
    }
  }
  const span = next.t_ms - prev.t_ms
  // Two keyframes at one instant carry no direction, and the later one wins:
  // that is what an edit replacing the earlier one meant.
  if (span <= 0) return boundsOf(next)
  const w = (tMs - prev.t_ms) / span
  return {
    x: Math.round(prev.x + (next.x - prev.x) * w),
    y: Math.round(prev.y + (next.y - prev.y) * w),
    width: Math.round(prev.width + (next.width - prev.width) * w),
    height: Math.round(prev.height + (next.height - prev.height) * w),
  }
}

/**
 * The rectangle a box occupies at `tMs` from whichever path it has, or null
 * when it has neither.
 *
 * OBSERVED BEATS AUTHORED when a box somehow carries both. The editor cannot
 * produce that — a tracked box refuses to be dragged at all (#99, "Selected,
 * never dragged, when Core owns the rectangle") — but a hand-edited pack can,
 * and a reader must not be left to guess. A measurement outranks a preference.
 */
export function trackedBoundsAt(a: Annotation, tMs: number): AnnotationBounds | null {
  const s = trackedSampleAt(a, tMs)
  if (s !== null) return boundsOf(s)
  return keyframedBoundsAt(a, tMs)
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
  const s = trackedSampleAt(a, tMs)
  if (s !== null) {
    return {
      ...a,
      bounds: boundsOf(s),
      ...(s.display === undefined ? {} : { display: s.display }),
    }
  }
  // An authored path never crosses screens: the user drew this box on one
  // display and it is theirs to place, so `display` is left exactly as it was
  // (§8.9). A box with neither path is returned unchanged, which is what keeps
  // the ordinary untracked case byte-identical and free.
  const authored = keyframedBoundsAt(a, tMs)
  if (authored === null) return a
  return { ...a, bounds: authored }
}

function boundsOf(s: AnnotationTrackSample | AnnotationKeyframe): AnnotationBounds {
  return {
    x: Math.round(s.x),
    y: Math.round(s.y),
    width: Math.round(s.width),
    height: Math.round(s.height),
  }
}
