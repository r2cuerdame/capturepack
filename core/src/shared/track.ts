// Where a tracked box is at one moment (#86).
//
// SHARED ON PURPOSE. The editor draws the box, the annotated replay renders it
// into video, and the keyframe stills render it again. If those three answered
// the question separately they would drift apart, and the pack would disagree
// with the picture of itself — which is the exact failure this project keeps
// removing. One function, three callers.
//
// EVERY RECTANGLE IT SHOWS WAS OBSERVED (#89) — reaffirmed as a decision, not
// an accident, after interpolation shipped for one release candidate and was
// ordered out ("보간하면 안되지"). A drawn rectangle nobody measured is a
// statement the record cannot back, however plausible its position, and it
// hides the actual defect: the observations are not dense enough at the
// moments that matter. The remedy is getting exact positions at their exact
// times (the host's location-change events), never manufacturing positions
// between the ones we have.
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

/** The rectangle a tracked box occupies at `tMs`, or null when it has no track. */
export function trackedBoundsAt(a: Annotation, tMs: number): AnnotationBounds | null {
  const s = trackedSampleAt(a, tMs)
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
  const s = trackedSampleAt(a, tMs)
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
