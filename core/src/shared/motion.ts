// Editing a manual box's AUTHORED motion (SPEC §8.9).
//
// THE REPORT THIS EXISTS FOR: "수동으로 박스 만들고 몇프레임 뒤에 박스를
// 움직였는데 통째로 옴겨지던데?" — draw a box, scrub forward, drag it, and it
// moved across its whole lifetime. It had to: a manual box carried exactly one
// `bounds` for every moment it was drawn, so there was nowhere for a second
// position to live.
//
// SHARED, NOT IN THE EDITOR, for the same reason shared/track.ts is: the rules
// below decide what a pack CONTAINS, and a check can only hold them to account
// if it can call them without a renderer. The editor owns the gestures; this
// owns what they mean.
//
// WHY THESE ARE NOT `tracking.samples`. SPEC §8.3 says every sample is an
// observation and forbids interpolating between them, in as many words. These
// are the opposite kind of statement — the user saying where their own
// annotation belongs — so they interpolate, and they live in their own field so
// that neither rule can ever be applied to the other kind. See
// `keyframedBoundsAt` in shared/track.ts for the drawing side of the same
// argument.
import type { Annotation, AnnotationBounds, AnnotationKeyframe } from './types'
import { keyframedPlacementAt, type AuthoredMotionSpace } from './track'

/**
 * How close two authored moments have to be to be the SAME moment.
 *
 * A user dragging the box twice without scrubbing means one keyframe, not two:
 * the second drag is a correction, not a second statement. 16 ms is just under
 * one frame at the fastest rate this app captures (30 fps), so two genuinely
 * different frames are never merged, and two drags on one frame never split.
 */
export const KEYFRAME_SAME_MOMENT_MS = 16

/** A box's authored keyframes, or an empty list — never undefined. */
export function keyframesOf(a: Annotation): readonly AnnotationKeyframe[] {
  return a.keyframes ?? []
}

/** Whether this box carries authored motion at all. */
export function hasMotion(a: Annotation): boolean {
  return keyframesOf(a).length > 0
}

/** Index of the keyframe at `tMs` within `KEYFRAME_SAME_MOMENT_MS`, or -1. */
export function keyframeIndexAt(a: Annotation, tMs: number): number {
  const frames = keyframesOf(a)
  let best = -1
  let bestGap = KEYFRAME_SAME_MOMENT_MS
  for (let i = 0; i < frames.length; i += 1) {
    const gap = Math.abs(frames[i]!.t_ms - tMs)
    if (gap <= bestGap) {
      best = i
      bestGap = gap
    }
  }
  return best
}

/**
 * The moment a box's FIRST authored position belongs to: where it starts being
 * drawn.
 *
 * Not the lifetime midpoint, which is the box's *representative* instant
 * (§8.4). A box drawn at 17.0 s with a one-second life has its midpoint at
 * 17.5 s, and anchoring the original position there would mean the very first
 * drag — the one that establishes the motion — silently declared the box had
 * already been somewhere else for half a second.
 */
function baseMomentOf(a: Annotation): number {
  return a.start_ms ?? 0
}

/**
 * Records that the box should be at `bounds` at `tMs`, and returns the index of
 * the keyframe now holding that, or -1 when the box should stay a plain
 * constant rectangle.
 *
 * THE FIRST MOVE IS THE INTERESTING ONE. A box with no motion yet that is
 * dragged at the moment it already begins has simply been repositioned — there
 * is one statement, and one authored position is not motion, so it stays a
 * plain `bounds` and the pack gains nothing it does not need. Dragged at any
 * OTHER moment, the drag is the second statement, so the first one has to be
 * written down too: the box was where it was, from where it began, until here.
 * That pair is what makes the box hold still and then move, instead of jumping
 * from nowhere.
 */
export function setKeyframe(
  a: Annotation,
  tMs: number,
  bounds: AnnotationBounds,
  display?: number,
  baseDisplay?: number,
): number {
  const at = Math.round(tMs)
  const frames = [...keyframesOf(a)]
  const frame = (
    t: number,
    b: AnnotationBounds,
    on?: number,
  ): AnnotationKeyframe => ({
    t_ms: Math.round(t),
    ...(on === undefined ? {} : { display: on }),
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.round(b.width),
    height: Math.round(b.height),
  })

  if (frames.length === 0) {
    const base = baseMomentOf(a)
    if (Math.abs(at - base) <= KEYFRAME_SAME_MOMENT_MS) return -1
    a.keyframes = [
      frame(base, a.bounds, baseDisplay ?? a.display),
      frame(at, bounds, display),
    ]
    return 1
  }

  const existing = keyframeIndexAt(a, at)
  if (existing >= 0) {
    frames[existing] = frame(
      frames[existing]!.t_ms,
      bounds,
      display ?? frames[existing]!.display,
    )
    a.keyframes = frames
    return existing
  }
  frames.push(frame(at, bounds, display))
  frames.sort((p, q) => p.t_ms - q.t_ms)
  a.keyframes = frames
  return frames.findIndex((f) => f.t_ms === at)
}

/** Moves the keyframe at `index` to `bounds`, for a drag in progress. */
export function moveKeyframe(
  a: Annotation,
  index: number,
  bounds: AnnotationBounds,
  display?: number,
): void {
  const frames = a.keyframes
  const frame = frames?.[index]
  if (frame === undefined) return
  frame.x = Math.round(bounds.x)
  frame.y = Math.round(bounds.y)
  frame.width = Math.round(bounds.width)
  frame.height = Math.round(bounds.height)
  if (display !== undefined) frame.display = display
}

/**
 * Drops the keyframe at `tMs`. True when one was there.
 *
 * ONE KEYFRAME IS NOT MOTION, so removing the second-to-last removes the last
 * as well: what is left is a box that sits in one place, which is exactly a
 * plain `bounds` and is written as one. The surviving position becomes the
 * box's rectangle, so the box does not jump when its motion is deleted.
 */
export function removeKeyframeAt(
  a: Annotation,
  tMs: number,
  focusedDisplay?: number,
): boolean {
  const index = keyframeIndexAt(a, tMs)
  if (index < 0) return false
  const frames = [...keyframesOf(a)]
  frames.splice(index, 1)
  if (frames.length <= 1) {
    const survivor = frames[0]
    if (survivor !== undefined) {
      a.bounds = {
        x: survivor.x,
        y: survivor.y,
        width: survivor.width,
        height: survivor.height,
      }
      if (survivor.display !== undefined) {
        if (survivor.display === focusedDisplay) delete a.display
        else a.display = survivor.display
      }
    }
    delete a.keyframes
    return true
  }
  a.keyframes = frames
  return true
}

/**
 * Re-points `bounds` at the box's representative instant (§8.4's midpoint),
 * so a reader that ignores `keyframes` still draws the box in a place it
 * genuinely occupies.
 *
 * The same contract §8.3 already puts on a tracked box's `bounds`, applied to
 * the same purpose: forward compatibility is a promise the writer keeps, not a
 * courtesy the reader is owed.
 */
export function syncBoundsToRepresentative(
  a: Annotation,
  replayDurationMs: number,
  authoredSpace?: AuthoredMotionSpace,
): void {
  const frames = keyframesOf(a)
  if (frames.length === 0) return
  const start = a.start_ms
  const end = a.end_ms
  const mid =
    start === undefined || end === undefined ? replayDurationMs : (start + end) / 2
  if (authoredSpace !== undefined) {
    const placement = keyframedPlacementAt(a, mid, authoredSpace)
    if (placement === null) return
    a.bounds = placement.bounds
    if (placement.display === authoredSpace.focusedIndex) delete a.display
    else a.display = placement.display
    return
  }
  const at = boundsAtAuthored(frames, mid)
  if (at !== null) a.bounds = at
}

/**
 * Moves every replay-clock field onto one captured display's local replay
 * clock.
 *
 * Per-display recordings can start at slightly different instants. Rebasing
 * only the lifetime makes authored keyframes and observed samples drift away
 * from the video they are rendered over, so the entire temporal annotation is
 * shifted as one value. Keyframes clipped onto the same boundary collapse with
 * the later source placement winning — that is the state visible at the first
 * frame of the retained replay.
 */
/**
 * Move one annotation's OBSERVATIONS onto the picture's clock (#89).
 *
 * Only the observations. A lifetime is when the author wanted the box shown and
 * a keyframe is where the author put it — neither is a measurement of the
 * recorder, so neither moves. `picked_at_ms` does move, because it names the
 * instant an observation was taken from and must keep naming the same one.
 *
 * `bounds` is left alone: it is the rectangle at the box's own moment, and that
 * moment is `picked_at_ms`, which moved with the samples it indexes.
 */
export function shiftAnnotationToPicture(a: Annotation, latencyMs: number): Annotation {
  const tracking = a.tracking
  if (tracking?.enabled !== true) return a
  const samples = tracking.samples
  if (samples === undefined || samples.length === 0) return a
  const shift = Math.round(latencyMs)
  if (!Number.isFinite(shift) || shift === 0) return a
  return {
    ...a,
    tracking: {
      ...tracking,
      ...(tracking.picked_at_ms === undefined
        ? {}
        : { picked_at_ms: tracking.picked_at_ms + shift }),
      samples: samples.map((sample) => ({ ...sample, t_ms: sample.t_ms + shift })),
    },
  }
}

export function rebaseAnnotationClock(
  a: Annotation,
  offsetMs: number,
  durationMs: number,
): Annotation {
  const duration =
    Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : 0
  const offset = Number.isFinite(offsetMs) ? offsetMs : 0
  const clamp = (ms: number): number =>
    Math.min(Math.max(0, Math.round(ms + offset)), duration)

  const keyframes: AnnotationKeyframe[] | undefined =
    a.keyframes === undefined
      ? undefined
      : a.keyframes.reduce<AnnotationKeyframe[]>((shifted, frame) => {
          const next = { ...frame, t_ms: clamp(frame.t_ms) }
          const previous = shifted[shifted.length - 1]
          if (previous?.t_ms === next.t_ms) shifted[shifted.length - 1] = next
          else shifted.push(next)
          return shifted
        }, [])

  return {
    ...a,
    ...(a.start_ms === undefined || a.end_ms === undefined
      ? {}
      : { start_ms: clamp(a.start_ms), end_ms: clamp(a.end_ms) }),
    ...(keyframes === undefined ? {} : { keyframes }),
    tracking: {
      ...a.tracking,
      ...(a.tracking.picked_at_ms === undefined
        ? {}
        : { picked_at_ms: clamp(a.tracking.picked_at_ms) }),
      ...(a.tracking.samples === undefined
        ? {}
        : {
            samples: a.tracking.samples.map((sample) => ({
              ...sample,
              t_ms: clamp(sample.t_ms),
            })),
          }),
    },
  }
}

/** The interpolated rectangle at `tMs`; kept beside the edits it has to agree with. */
function boundsAtAuthored(
  frames: readonly AnnotationKeyframe[],
  tMs: number,
): AnnotationBounds | null {
  if (frames.length === 0) return null
  const first = frames[0]!
  if (frames.length === 1 || tMs <= first.t_ms) return rectOf(first)
  const last = frames[frames.length - 1]!
  if (tMs >= last.t_ms) return rectOf(last)
  let prev = first
  let next = last
  for (let i = 1; i < frames.length; i += 1) {
    const candidate = frames[i]!
    if (candidate.t_ms >= tMs) {
      next = candidate
      prev = frames[i - 1]!
      break
    }
  }
  const span = next.t_ms - prev.t_ms
  if (span <= 0) return rectOf(next)
  const w = (tMs - prev.t_ms) / span
  return {
    x: Math.round(prev.x + (next.x - prev.x) * w),
    y: Math.round(prev.y + (next.y - prev.y) * w),
    width: Math.round(prev.width + (next.width - prev.width) * w),
    height: Math.round(prev.height + (next.height - prev.height) * w),
  }
}

function rectOf(f: AnnotationKeyframe): AnnotationBounds {
  return { x: f.x, y: f.y, width: f.width, height: f.height }
}
