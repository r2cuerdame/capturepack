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
import {
  annotationAt,
  keyframedPlacementAt,
  renderedAnnotationAt,
  trackedBoundsAt,
  type AuthoredMotionSpace,
} from '../src/shared/track'
import {
  buildBoard,
  displayAtBoardPoint,
  toBoardPoint,
  toNativePoint,
} from '../src/renderer/editor/board'
import {
  hasMotion,
  keyframeIndexAt,
  keyframesOf,
  moveKeyframe,
  rebaseAnnotationClock,
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

console.log('\nAN EXACT DISTANCE TIE IS TEMPORAL BEFORE IT IS DISPLAY-LOCAL')
{
  const a: Annotation = {
    ...pickedBox(),
    display: 1,
    tracking: {
      enabled: true,
      samples: [
        { t_ms: 10_100, display: 2, x: 100, y: 40, width: 80, height: 30 },
        { t_ms: 10_300, x: 700, y: 40, width: 80, height: 30 },
      ],
    },
  }
  check(
    'the earlier observation wins a midpoint tie even when the future sample is on the own display',
    annotationAt(a, 10_200),
    {
      ...a,
      display: 2,
      bounds: { x: 100, y: 40, width: 80, height: 30 },
    },
  )
  const reopened = JSON.parse(JSON.stringify(a)) as Annotation
  check(
    'save, reopen and render preserve the temporal tie before the display tie-break',
    renderedAnnotationAt(reopened, 10_200, 1, 1),
    renderedAnnotationAt(a, 10_100, 1, 1),
  )
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

// The exact desk behind CapturePack_2026-07-29_223519: a 1x portrait display
// at the left of a 1.5x 4K display. Board/display bounds are DIPs; annotation
// rectangles are each display's native snapshot pixels.
const MIXED_DPI_BOARD: AuthoredMotionSpace = {
  focusedIndex: 2,
  displays: [
    {
      index: 1,
      width: 1200,
      height: 1920,
      bounds: { x: 0, y: 0, width: 1200, height: 1920 },
    },
    {
      index: 2,
      width: 3840,
      height: 2160,
      bounds: { x: 1200, y: 0, width: 2560, height: 1440 },
    },
  ],
}

// The minimum N-monitor fixture the product contract calls for: a portrait
// monitor at a negative origin, a 1.5x centre display, and a 1.25x display
// above/right. The focused display is deliberately index 3 — index 1 is not a
// synonym for focus anywhere in the board, annotation, or replay contracts.
const THREE_MONITOR_BOARD: AuthoredMotionSpace = {
  focusedIndex: 3,
  displays: [
    {
      index: 1,
      width: 1200,
      height: 1920,
      bounds: { x: -1200, y: -480, width: 1200, height: 1920 },
    },
    {
      index: 2,
      width: 3840,
      height: 2160,
      bounds: { x: 0, y: 0, width: 2560, height: 1440 },
    },
    {
      index: 3,
      width: 2400,
      height: 1350,
      bounds: { x: 2560, y: -360, width: 1920, height: 1080 },
    },
  ],
}

console.log('\nTHREE MONITORS: NEGATIVE ORIGIN, PORTRAIT, MIXED DPI, FOCUS INDEX 3')
{
  const board = buildBoard(
    THREE_MONITOR_BOARD.displays.map((display) => ({
      ...display,
      focused: display.index === THREE_MONITOR_BOARD.focusedIndex,
      hasReplay: display.index !== 2,
    })),
  )
  check('the board keeps all three displays', board.displays.map((d) => d.index), [1, 2, 3])
  check('focus is the declared third display, never array index one', board.focusedIndex, 3)
  check(
    'negative virtual-desktop origins are normalized without changing arrangement',
    board.displays.map((d) => ({ index: d.index, x: d.bx, y: d.by, w: d.bw, h: d.bh })),
    [
      { index: 1, x: 0, y: 0, w: 1200, h: 1920 },
      { index: 2, x: 1200, y: 480, w: 2560, h: 1440 },
      { index: 3, x: 3760, y: 120, w: 1920, h: 1080 },
    ],
  )
  const third = board.displays.find((d) => d.index === 3)!
  const native = { x: 300, y: 450 }
  const boardPoint = toBoardPoint(third, native.x, native.y)
  check('mixed-DPI native -> board -> native is stable on display 3', toNativePoint(
    third,
    boardPoint.x,
    boardPoint.y,
  ), native)
  check(
    'a point on display 3 is owned by display 3',
    displayAtBoardPoint(board, boardPoint.x, boardPoint.y)?.index,
    3,
  )
}

console.log('\nONE MANUAL BOX CROSSES DISPLAY 1 -> 2 -> 3')
{
  const a: Annotation = {
    ...manualBox(),
    display: 1,
    bounds: { x: 100, y: 800, width: 200, height: 100 },
  }
  check('the source placement is display 1', setKeyframe(a, 10_000, a.bounds, 1), -1)
  check(
    'the destination authors one cross-display keyframe',
    setKeyframe(a, 10_600, { x: 300, y: 450, width: 250, height: 125 }, 3),
    1,
  )
  check('the path begins on display 1', keyframedPlacementAt(a, 10_000, THREE_MONITOR_BOARD), {
    display: 1,
    bounds: { x: 100, y: 800, width: 200, height: 100 },
  })
  check('the path crosses the centre display in desktop space', keyframedPlacementAt(
    a,
    10_300,
    THREE_MONITOR_BOARD,
  ), {
    display: 2,
    bounds: { x: 1275, y: 240, width: 300, height: 150 },
  })
  check('the path ends on focused display 3', keyframedPlacementAt(
    a,
    10_600,
    THREE_MONITOR_BOARD,
  ), {
    display: 3,
    bounds: { x: 300, y: 450, width: 250, height: 125 },
  })
  const reopened = JSON.parse(JSON.stringify(a)) as Annotation
  check(
    'save, close, reopen and render preserve the same three-display midpoint',
    renderedAnnotationAt(reopened, 10_300, 1, 1, THREE_MONITOR_BOARD),
    renderedAnnotationAt(a, 10_300, 1, 1, THREE_MONITOR_BOARD),
  )
}

console.log('\nONE OBSERVED OBJECT CROSSES DISPLAY 1 -> 2 -> 3 WITHOUT INTERPOLATION')
{
  const a: Annotation = {
    ...manualBox(),
    display: 1,
    tracking: {
      enabled: true,
      samples: [
        { t_ms: 10_000, x: 100, y: 800, width: 200, height: 100 },
        { t_ms: 10_300, display: 2, x: 1275, y: 240, width: 300, height: 150 },
        { t_ms: 10_600, display: 3, x: 300, y: 450, width: 250, height: 125 },
      ],
    },
  }
  check('before the midpoint the exact display-2 observation wins', annotationAt(a, 10_440), {
    ...a,
    display: 2,
    bounds: { x: 1275, y: 240, width: 300, height: 150 },
  })
  check('after the midpoint the exact display-3 observation wins', annotationAt(a, 10_460), {
    ...a,
    display: 3,
    bounds: { x: 300, y: 450, width: 250, height: 125 },
  })
  const reopened = JSON.parse(JSON.stringify(a)) as Annotation
  check(
    'the observed display and rectangle survive save and reopen unchanged',
    annotationAt(reopened, 10_460),
    annotationAt(a, 10_460),
  )
}

console.log('\nONE MANUAL BOX MOVES FROM THE 1X DISPLAY TO THE 1.5X DISPLAY')
{
  const a = { ...manualBox(), display: 1 }
  const first = setKeyframe(a, 10_000, a.bounds, 1)
  check('moving at its own start remains an ordinary placement', first, -1)
  const second = setKeyframe(
    a,
    10_600,
    { x: 300, y: 300, width: 450, height: 225 },
    2,
  )
  check('a later placement creates the cross-display keyframe', second, 1)
  check('the source keyframe remembers display 1', keyframesOf(a)[0]?.display, 1)
  check('the destination keyframe remembers display 2', keyframesOf(a)[1]?.display, 2)
  check('the path begins on display 1', keyframedPlacementAt(a, 10_000, MIXED_DPI_BOARD), {
    display: 1,
    bounds: { x: 100, y: 200, width: 300, height: 150 },
  })
  check('the path ends on display 2', keyframedPlacementAt(a, 10_600, MIXED_DPI_BOARD), {
    display: 2,
    bounds: { x: 300, y: 300, width: 450, height: 225 },
  })
  const middle = keyframedPlacementAt(a, 10_300, MIXED_DPI_BOARD)
  check('the midpoint is interpolated in one desktop space', middle, {
    display: 1,
    bounds: { x: 750, y: 200, width: 300, height: 150 },
  })
  const reopened = JSON.parse(JSON.stringify(a)) as Annotation
  check(
    'cross-display interpolation survives save and re-open',
    keyframedPlacementAt(reopened, 10_300, MIXED_DPI_BOARD),
    middle,
  )
}

console.log('\nAUTHORED KEYFRAMES SCALE WITH A DOWNSAMPLED ANNOTATED VIDEO')
{
  const a = manualBox()
  dragTo(a, 10_600, 900, 200)
  check(
    'a 0.5x render scales the interpolated keyframe, not only stored bounds',
    renderedAnnotationAt(a, 10_300, 0.5, 0.5).bounds,
    { x: 250, y: 100, width: 150, height: 75 },
  )
}

console.log('\nONE DISPLAY REPLAY CLOCK SHIFTS THE WHOLE ANNOTATION')
{
  const a = pickedBox()
  a.keyframes = [
    { t_ms: 10_000, x: 100, y: 200, width: 300, height: 150 },
    { t_ms: 10_600, x: 900, y: 200, width: 300, height: 150 },
  ]
  a.tracking.picked_at_ms = 10_500
  const shifted = rebaseAnnotationClock(a, -10_200, 1_000)
  check('lifetime shifts and clamps', [shifted.start_ms, shifted.end_ms], [0, 800])
  check(
    'authored placements use the same local clock',
    shifted.keyframes?.map((frame) => frame.t_ms),
    [0, 400],
  )
  check(
    'observed samples and picked instant use the same local clock',
    {
      picked: shifted.tracking.picked_at_ms,
      samples: shifted.tracking.samples?.map((sample) => sample.t_ms),
    },
    { picked: 300, samples: [0, 300] },
  )
}

console.log(failed === 0 ? '\nbox-motion-check ok' : `\nbox-motion-check FAILED (${failed})`)
process.exitCode = failed === 0 ? 0 : 1
