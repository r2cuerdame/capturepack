// Where a tracked box is at one moment (#86).
//
// SHARED ON PURPOSE. The editor draws the box, the annotated replay renders it
// into video, and the keyframe stills render it again. If those three answered
// the question separately they would drift apart, and the pack would disagree
// with the picture of itself — which is the exact failure this project keeps
// removing. One function, three callers.
//
// The interpolation rule is the same one Core uses between surface samples: a
// straight line between the two the requested time falls between. It is stated
// in SPEC §8.3 as part of the format, because a reader that rounds to the
// nearest sample instead would draw a box that visibly steps while the window
// it names moves smoothly.
import type { Annotation, AnnotationBounds, AnnotationTrackSample } from './types'

/**
 * The rectangle a tracked box occupies at `tMs`, or null when it has no track.
 *
 * Before the first sample and after the last, the box is held at the end it is
 * nearest rather than being hidden: the track says where the object was while
 * it was recorded, and a box whose lifetime reaches a little past that should
 * not blink out — its LIFETIME is what says when it stops (clamped to the
 * object's own end, #77), not the sample list.
 */
export function trackedSampleAt(a: Annotation, tMs: number): AnnotationTrackSample | null {
  const samples = a.tracking?.samples
  if (a.tracking?.enabled !== true || samples === undefined || samples.length === 0) return null
  if (samples.length === 1 || tMs <= samples[0]!.t_ms) return samples[0]!
  const last = samples[samples.length - 1]!
  if (tMs >= last.t_ms) return last
  for (let i = 1; i < samples.length; i += 1) {
    const end = samples[i]!
    if (end.t_ms < tMs) continue
    const start = samples[i - 1]!
    const span = end.t_ms - start.t_ms
    if (span <= 0) return end
    // A CROSSING IS A JUMP, NOT A BLEND. The two samples are pixels of two
    // DIFFERENT images, so there is no rectangle "between" them — averaging
    // them would produce coordinates that mean nothing on either screen. The
    // crossing takes effect at the sample that observed it.
    if (start.display !== end.display) return end
    const r = (tMs - start.t_ms) / span
    return {
      t_ms: tMs,
      ...(end.display === undefined ? {} : { display: end.display }),
      x: start.x + (end.x - start.x) * r,
      y: start.y + (end.y - start.y) * r,
      width: start.width + (end.width - start.width) * r,
      height: start.height + (end.height - start.height) * r,
    }
  }
  return last
}

/**
 * The rectangle a tracked box occupies at `tMs`, or null when it has no track.
 */
export function trackedBoundsAt(a: Annotation, tMs: number): AnnotationBounds | null {
  const s = trackedSampleAt(a, tMs)
  return s === null ? null : boundsOf(s)
}

/**
 * `a` as it should be DRAWN and HIT-TESTED at `tMs`.
 *
 * Returns the annotation itself when it has no track, so the untracked path is
 * byte-identical to what it always was and costs nothing. When it does have
 * one, the copy carries the tracked rectangle in `bounds` — and, when the
 * object has crossed to another monitor, that sample's `display` too. Both are
 * the fields every existing routine already reads to decide where a box goes,
 * so drawing, blurring, selection and hit-testing follow the object across
 * screens without a line of change and without a time argument threaded
 * through any of them (#86).
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
