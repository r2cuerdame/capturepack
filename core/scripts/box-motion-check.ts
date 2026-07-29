// DOES MOVING A BOX AT A LATER FRAME MOVE IT ONLY FROM THERE? (SPEC §8.9)
//
// The report: "수동으로 박스 만들고 몇프레임 뒤에 박스를 움직였는데 통째로
// 옴겨지던데?" — a manual box carried one `bounds` for its whole lifetime, so
// a drag at any frame moved it at every frame.
//
// This drives the SAME functions the editor's drag calls (shared/motion.ts) and
// reads the result back through the SAME function the editor, the annotated
// replay and the keyframe stills all draw with (shared/track.ts). If those two
// ever disagree, a pack disagrees with the picture of itself — which is the
// failure this project keeps removing.
//
// Run: npm run check:motion
import { annotationAt, trackedBoundsAt } from '../src/shared/track'
import {
  hasMotion,
  keyframeIndexAt,
  keyframesOf,
  moveKeyframe,
  removeKeyframeAt,
  setKeyframe,
  syncBoundsToRepresentative,
} from '../src/shared/motion'
import type { Annotation, AnnotationBounds } from '../src/shared/types'

const DURATION = 30_000
let failed = 0

function check(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  const ok = g === w
  if (!ok) failed += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) console.log(`        got  ${g}\n        want ${w}`)
}

/** A manual box: no tracking, one rectangle, a one-second life from 10 s. */
function manualBox(): Annotation {
  return {
    annotation_id: 'ann_aaaaaa',
    type: 'box',
    bounds: { x: 100, y: 200, width: 300, height: 150 },
    text: '',
    start_ms: 10_000,
    end_ms: 11_000,
    numbered: false,
    blur: false,
    tracking: { enabled: false },
    created_at: '2026-07-29T00:00:00+09:00',
    z: 0,
  }
}

/** A PICKED box: observed samples, which must keep behaving exactly as before. */
function pickedBox(): Annotation {
  return {
    ...manualBox(),
    annotation_id: 'ann_bbbbbb',
    tracking: {
      enabled: true,
      samples: [
        { t_ms: 10_000, x: 0, y: 0, width: 10, height: 10 },
        { t_ms: 10_500, x: 500, y: 0, width: 10, height: 10 },
      ],
    },
  }
}

const at = (a: Annotation, t: number): AnnotationBounds => annotationAt(a, t).bounds

/** What the editor's move drag does: author at `t`, then push the rectangle. */
function dragTo(a: Annotation, t: number, x: number, y: number): void {
  const index = setKeyframe(a, t, trackedBoundsAt(a, t) ?? a.bounds)
  if (index < 0) {
    a.bounds = { ...a.bounds, x, y }
  } else {
    moveKeyframe(a, index, { ...a.bounds, x, y })
  }
  syncBoundsToRepresentative(a, DURATION)
}

console.log('A BOX THAT WAS NEVER MOVED AT A SECOND MOMENT')
{
  const a = manualBox()
  check('no keyframes exist', keyframesOf(a).length, 0)
  check('drawn at its start', at(a, 10_000), { x: 100, y: 200, width: 300, height: 150 })
  check('drawn the same later', at(a, 11_000), { x: 100, y: 200, width: 300, height: 150 })
  // Dragging at the moment it already begins is a reposition, not motion.
  dragTo(a, 10_000, 700, 800)
  check('dragging at its own start authors nothing', keyframesOf(a).length, 0)
  check('and simply moves it', at(a, 10_500), { x: 700, y: 800, width: 300, height: 150 })
}

console.log('\nTHE REPORTED CASE — MOVED A FEW FRAMES LATER')
{
  const a = manualBox()
  dragTo(a, 10_600, 900, 200) // scrubbed forward ~9 frames at 15 fps, then dragged
  check('two keyframes now exist', keyframesOf(a).length, 2)
  check('the first holds the original position', keyframesOf(a)[0], {
    t_ms: 10_000,
    x: 100,
    y: 200,
    width: 300,
    height: 150,
  })
  check('the box is untouched where it started', at(a, 10_000), {
    x: 100,
    y: 200,
    width: 300,
    height: 150,
  })
  check('and is where it was put at the authored moment', at(a, 10_600), {
    x: 900,
    y: 200,
    width: 300,
    height: 150,
  })
  // THE WHOLE POINT: before the change this rectangle was the dragged one at
  // every time, including 10_000.
  check('halfway between, halfway there', at(a, 10_300), {
    x: 500,
    y: 200,
    width: 300,
    height: 150,
  })
  check('held flat past the last keyframe', at(a, 11_000), {
    x: 900,
    y: 200,
    width: 300,
    height: 150,
  })
}

console.log('\nA THIRD MOMENT, AND A REPLACEMENT')
{
  const a = manualBox()
  dragTo(a, 10_600, 900, 200)
  dragTo(a, 10_900, 900, 600)
  check('three keyframes', keyframesOf(a).length, 3)
  check('the earlier two still hold', at(a, 10_600), { x: 900, y: 200, width: 300, height: 150 })
  check('the new one holds', at(a, 10_900), { x: 900, y: 600, width: 300, height: 150 })
  // Dragging the SAME frame again corrects it rather than adding a second.
  dragTo(a, 10_900, 40, 60)
  check('re-dragging one frame replaces it', keyframesOf(a).length, 3)
  check('with the correction', at(a, 10_900), { x: 40, y: 60, width: 300, height: 150 })
}

console.log('\nREMOVING MOTION')
{
  const a = manualBox()
  dragTo(a, 10_600, 900, 200)
  dragTo(a, 10_900, 900, 600)
  check('K at a frame with no keyframe finds nothing', keyframeIndexAt(a, 10_300), -1)
  removeKeyframeAt(a, 10_900)
  check('one removed leaves two', keyframesOf(a).length, 2)
  removeKeyframeAt(a, 10_600)
  check('down to one keyframe drops motion entirely', hasMotion(a), false)
  check('and the box stays where the survivor was', at(a, 10_500), {
    x: 100,
    y: 200,
    width: 300,
    height: 150,
  })
}

console.log('\nAN OBSERVED BOX IS UNAFFECTED — NEAREST, NEVER INTERPOLATED (#89)')
{
  const a = pickedBox()
  check('at its first sample', at(a, 10_000), { x: 0, y: 0, width: 10, height: 10 })
  check('at its second', at(a, 10_500), { x: 500, y: 0, width: 10, height: 10 })
  // The midpoint is the proof: interpolation would answer x=250 here.
  check('nearer sample wins in between', at(a, 10_240), { x: 0, y: 0, width: 10, height: 10 })
  check('and just past the middle', at(a, 10_260), { x: 500, y: 0, width: 10, height: 10 })
  check('no keyframes were invented', keyframesOf(a).length, 0)
}

console.log('\nWHAT A READER THAT IGNORES KEYFRAMES SEES')
{
  const a = manualBox()
  dragTo(a, 10_600, 900, 200)
  // `bounds` must be the box's rectangle at its representative instant — the
  // lifetime midpoint (SPEC §8.4) — so an old reader draws it somewhere the
  // box genuinely is. 10_500 is the midpoint of 10_000..11_000.
  check('bounds is the position at the lifetime midpoint', a.bounds, at(a, 10_500))
}

console.log('\nROUND TRIP THROUGH THE PACK')
{
  const a = manualBox()
  dragTo(a, 10_600, 900, 200)
  const reloaded = JSON.parse(JSON.stringify(a)) as Annotation
  check('keyframes survive save and re-open', keyframesOf(reloaded).length, 2)
  check('and draw identically', at(reloaded, 10_300), at(a, 10_300))
}

console.log(failed === 0 ? '\nbox-motion-check ok' : `\nbox-motion-check FAILED (${failed})`)
process.exitCode = failed === 0 ? 0 : 1
