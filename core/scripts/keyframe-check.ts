// EVERY BOX HAS A STILL IT IS ALIVE IN (#112).
//
// `frames/` claims to be a reconstruction of the capture: one annotated still
// per annotation state change, readable without decoding any video. That claim
// is only true if every box appears in at least one of them — and two rules in
// computeKeyframes could quietly break it.
//
//   MERGING keeps the EARLIER of two times within KEYFRAME_MERGE_MS. A box
//   whose start AND end both fall inside a neighbour's merge window loses both,
//   and the kept frame is one it is not alive at. Short boxes lose first, and
//   the shortest boxes are the manual ones a user drew to mark one moment.
//
//   THE CAP keeps the earliest MAX_KEYFRAMES - 1 changes plus the final
//   instant. A box living entirely in the middle of a busy capture is dropped
//   outright.
//
// Run: npm run check:keyframes
import { computeKeyframes, KEYFRAME_MERGE_MS, MAX_KEYFRAMES } from '../src/shared/keyframes'
import type { Annotation } from '../src/shared/types'

let failures = 0

function box(id: string, start: number | undefined, end: number | undefined): Annotation {
  return {
    annotation_id: id,
    display: 1,
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    ...(start === undefined ? {} : { start_ms: start }),
    ...(end === undefined ? {} : { end_ms: end }),
  } as Annotation
}

/** The interval a box is alive over, on the same clamped clock as the times. */
function alive(a: Annotation, durationMs: number): { from: number; to: number } {
  const clamp = (v: number): number => Math.min(Math.max(0, Math.round(v)), durationMs)
  if (typeof a.start_ms !== 'number' || typeof a.end_ms !== 'number') {
    return { from: durationMs, to: durationMs }
  }
  const lo = clamp(a.start_ms)
  const hi = clamp(a.end_ms)
  return { from: Math.min(lo, hi), to: Math.max(lo, hi) }
}

function check(name: string, annotations: Annotation[], durationMs: number): void {
  const { times, dropped } = computeKeyframes(annotations, durationMs)
  const orphans = annotations.filter((a) => {
    const life = alive(a, durationMs)
    return !times.some((t) => t >= life.from && t <= life.to)
  })
  const sorted = times.every((t, i) => i === 0 || t > (times[i - 1] as number))
  const capped = times.length <= MAX_KEYFRAMES
  // MORE BOXES THAN SLOTS IS ARITHMETIC, NOT A BUG. With N boxes and a cap of
  // MAX_KEYFRAMES, at most MAX_KEYFRAMES of them can appear in a still — so the
  // bar is that every box is represented UNLESS the cap makes it impossible,
  // and that the number left out is the minimum the cap forces.
  const forced = Math.max(0, annotations.length - MAX_KEYFRAMES)
  const ok = orphans.length <= forced && sorted && capped
  if (!ok) failures += 1
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}\n` +
      `        ${annotations.length} boxes -> ${times.length} stills` +
      (dropped > 0 ? ` (${dropped} changes dropped by the cap)` : '') +
      `, ${orphans.length} box(es) with no still they are alive in` +
      (forced > 0 ? ` (${forced} unavoidable at a cap of ${MAX_KEYFRAMES})` : '') +
      (sorted ? '' : ', NOT ASCENDING') +
      (capped ? '' : `, OVER THE CAP OF ${MAX_KEYFRAMES}`),
  )
  if (orphans.length > 0) {
    for (const a of orphans.slice(0, 4)) {
      const life = alive(a, durationMs)
      console.log(`          orphan ${a.annotation_id}: alive ${life.from}..${life.to}`)
    }
  }
}

console.log(`keyframe coverage (merge window ${KEYFRAME_MERGE_MS} ms, cap ${MAX_KEYFRAMES})\n`)

// 1. THE MERGE HOLE, taken from a real pack. CapturePack_2026-07-29_173246 has
//    six window boxes on a one-second cadence and a MANUAL box at 11561..12561
//    whose start sits 14 ms after a window box's end at 11547 — inside the
//    merge window. Shorten that manual box so BOTH its ends fall inside their
//    neighbours' windows and it has nothing of its own left.
check(
  'a short manual box wedged between two merged neighbours',
  [
    box('w1', 6284, 7284),
    box('w2', 7367, 8367),
    box('w3', 8382, 9382),
    box('w4', 9462, 10462),
    box('w5', 10547, 11547),
    box('manual', 11561, 11600), // 14 ms and 53 ms from the kept 11547
  ],
  13000,
)

// 2. THE CAP HOLE: a busy first half fills the budget, and a box that lives
//    only in the second half would be dropped outright.
{
  const busy: Annotation[] = []
  for (let i = 0; i < MAX_KEYFRAMES + 6; i += 1) {
    busy.push(box(`b${String(i)}`, i * 1000, i * 1000 + 400))
  }
  busy.push(box('late-manual', 60_000, 60_200))
  check('a late manual box behind more changes than the cap allows', busy, 90_000)
}

// 3. Boxes with NO lifetime anchor at the capture instant (SPEC §5.7).
check(
  'a box with no lifetime is represented at the capture instant',
  [box('whole-capture', undefined, undefined), box('w1', 1000, 2000)],
  12_000,
)

// 4. The ordinary case must not have grown extra stills.
check(
  'well-spaced boxes still get exactly their own changes',
  [box('a', 1000, 2000), box('b', 4000, 5000), box('c', 8000, 9000)],
  12_000,
)

// 5. A screenshot-only pack: one still at 0, and no box is orphaned by it.
check('screenshot-only pack', [box('a', undefined, undefined)], 0)

// 6. Zero-length box (start === end) — a click with no duration.
check('a zero-length box', [box('w', 5000, 6000), box('point', 6010, 6010)], 12_000)

// 7. Authored motion changes the visible state even while the box remains
//    alive. The midpoint placement must therefore have its own still; otherwise
//    frames/ can show the start and end positions while omitting the position
//    the user explicitly authored between them.
{
  const moving = box('moving-manual', 1000, 9000)
  moving.keyframes = [
    { t_ms: 1000, x: 0, y: 0, width: 10, height: 10 },
    { t_ms: 5000, x: 50, y: 60, width: 10, height: 10 },
    { t_ms: 9000, x: 100, y: 120, width: 10, height: 10 },
  ]
  const { times } = computeKeyframes([moving], 10_000)
  const ok = times.includes(5000)
  if (!ok) failures += 1
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  an authored motion keyframe gets an annotated still` +
      (ok ? '' : ` — got ${times.join(', ')}`),
  )
}

console.log(failures === 0 ? '\nkeyframe-check ok' : `\nkeyframe-check FAILED (${failures})`)
process.exitCode = failures === 0 ? 0 : 1
