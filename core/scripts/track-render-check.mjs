// Tracked-box resolution checks (#86): where is a following box at time T?
//
// WHY THIS EXISTS. Three places draw a tracked box — the editor, the annotated
// replay, and the keyframe stills — and they all call one function so they
// cannot disagree. That makes the function worth pinning down: if it is wrong,
// every view of the pack is wrong together and consistently, which is the
// hardest kind of wrong to notice.
//
// The rules under test are the ones SPEC §8.3 states, because a reader outside
// this repo has to be able to implement them from the spec alone and land on
// the same rectangle. The central one since #89: EVERY rectangle it returns was
// recorded. Nothing is averaged, so no answer can be a position the object
// never occupied.
//
//   node scripts/track-render-check.mjs

import { build } from 'esbuild'

const bundle = await build({
  entryPoints: ['scripts/track-render-check.entry.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
})
const { annotationAt, trackedBoundsAt } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
)

let passed = 0
let failed = 0
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log(`  PASS  ${name}`) }
  else { failed += 1; console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`) }
}

function box(tracking, bounds = { x: 0, y: 0, width: 100, height: 50 }) {
  return {
    annotation_id: 'a1', type: 'box', bounds, text: '', numbered: false, blur: false,
    tracking, style: { color: '#FF3B30' }, created_at: '', z: 1,
  }
}

const moving = box({
  enabled: true,
  samples: [
    { t_ms: 1000, x: 0, y: 0, width: 100, height: 50 },
    { t_ms: 2000, x: 200, y: 100, width: 100, height: 50 },
  ],
})

console.log('\nA box following a moving object — every answer is an OBSERVATION (#89)')
check('on a sample, it is that sample', trackedBoundsAt(moving, 1000).x === 0)
check('nearer the first sample, it IS the first sample',
  trackedBoundsAt(moving, 1400).x === 0, String(trackedBoundsAt(moving, 1400).x))
check('nearer the second, it IS the second',
  trackedBoundsAt(moving, 1600).x === 200, String(trackedBoundsAt(moving, 1600).x))
check('no answer is ever a rectangle that was not recorded',
  [0, 200].includes(trackedBoundsAt(moving, 1500).x),
  JSON.stringify(trackedBoundsAt(moving, 1500)))
check('size is carried, not invented',
  trackedBoundsAt(moving, 1400).width === 100 && trackedBoundsAt(moving, 1400).height === 50)

console.log('\nOutside the samples')
check('before the first sample it is held at the first', trackedBoundsAt(moving, 0).x === 0)
check('after the last it is held at the last', trackedBoundsAt(moving, 99999).x === 200)

console.log('\nBoxes that do not follow anything')
check('no tracking at all resolves to null', trackedBoundsAt(box(undefined), 1500) === null)
check('enabled false resolves to null', trackedBoundsAt(box({ enabled: false }), 1500) === null)
check('enabled true with no samples resolves to null',
  trackedBoundsAt(box({ enabled: true }), 1500) === null)
check('enabled true with an empty sample list resolves to null',
  trackedBoundsAt(box({ enabled: true, samples: [] }), 1500) === null)

console.log('\nThe view an untracked box gets is the box itself')
{
  const plain = box({ enabled: false })
  check('same object, not a copy — the untracked path costs nothing',
    annotationAt(plain, 1500) === plain)
}

console.log('\nThe view a tracked box gets')
{
  const view = annotationAt(moving, 1600)
  check('carries the resolved rectangle', view.bounds.x === 200)
  check('leaves the stored annotation alone', moving.bounds.x === 0)
  check('keeps everything else', view.annotation_id === 'a1' && view.z === 1)
}

console.log('\nA single-sample track (an object that never moved)')
{
  const still = box({ enabled: true, samples: [{ t_ms: 500, x: 7, y: 9, width: 100, height: 50 }] })
  check('answers that sample at every time',
    trackedBoundsAt(still, 0).x === 7 && trackedBoundsAt(still, 99999).x === 7)
}

console.log('\nAn object dragged onto another monitor')
{
  const crossing = box(
    {
      enabled: true,
      samples: [
        { t_ms: 1000, display: 2, x: 200, y: 0, width: 100, height: 50 },
        { t_ms: 1100, display: 2, x: 100, y: 0, width: 100, height: 50 },
        // Same window, other screen: these numbers are pixels of a DIFFERENT image.
        { t_ms: 1200, display: 1, x: 900, y: 0, width: 100, height: 50 },
        { t_ms: 1300, display: 1, x: 800, y: 0, width: 100, height: 50 },
      ],
    },
    { x: 200, y: 0, width: 100, height: 50 },
  )

  check('before the crossing it is on the screen it started on',
    annotationAt(crossing, 1040).display === 2)
  check('and reports a rectangle recorded there', trackedBoundsAt(crossing, 1040).x === 200)
  check('after the crossing it is on the other screen',
    annotationAt(crossing, 1240).display === 1)
  check('and reports a rectangle recorded there', trackedBoundsAt(crossing, 1240).x === 900)

  // The two ends of a crossing are in different coordinate spaces; a blend
  // would name a rectangle that exists on neither screen. Nothing blends now,
  // so the answer is simply whichever observation is nearer.
  const mid = annotationAt(crossing, 1160)
  check('a time inside the crossing resolves to one real sample',
    (mid.display === 1 && mid.bounds.x === 900) || (mid.display === 2 && mid.bounds.x === 100),
    `got display ${mid.display} x=${mid.bounds.x}`)
}

console.log('\nA window straddling two monitors: two rectangles, one instant (#93)')
{
  // The same window seen twice at 26304 ms, each clipped to its own screen —
  // the shape the reported capture actually contained.
  const straddling = box({
    enabled: true,
    samples: [
      { t_ms: 26304, display: 1, x: 292, y: 588, width: 908, height: 634 },
      { t_ms: 26304, x: 0, y: 588, width: 52, height: 634 },
    ],
  })
  check('the box keeps the rectangle measured on its OWN screen',
    trackedBoundsAt(straddling, 26304).x === 0 && trackedBoundsAt(straddling, 26304).width === 52,
    JSON.stringify(trackedBoundsAt(straddling, 26304)))
  check('and does not claim to have moved to the other one',
    annotationAt(straddling, 26304).display === undefined)

  // Order must not decide it: the same two samples the other way round.
  const reversed = box({
    enabled: true,
    samples: [
      { t_ms: 26304, x: 0, y: 588, width: 52, height: 634 },
      { t_ms: 26304, display: 1, x: 292, y: 588, width: 908, height: 634 },
    ],
  })
  check('array order does not change the answer',
    trackedBoundsAt(reversed, 26304).x === 0, JSON.stringify(trackedBoundsAt(reversed, 26304)))

  // Once the object is wholly on the other screen there is no tie, and the box
  // must follow it rather than stay behind.
  const left = box({
    enabled: true,
    samples: [
      { t_ms: 1000, x: 10, y: 0, width: 100, height: 50 },
      { t_ms: 2000, display: 1, x: 900, y: 0, width: 100, height: 50 },
    ],
  })
  check('a tie-break for its own screen does not stop it crossing',
    annotationAt(left, 2000).display === 1 && trackedBoundsAt(left, 2000).x === 900)
}

console.log('\nA track whose samples name no display (one screen)')
{
  const plain = box({
    enabled: true,
    samples: [
      { t_ms: 0, x: 0, y: 0, width: 100, height: 50 },
      { t_ms: 100, x: 100, y: 0, width: 100, height: 50 },
    ],
  })
  check("leaves the annotation's own display alone",
    annotationAt(plain, 40).display === undefined)
  check('and answers with a recorded rectangle', trackedBoundsAt(plain, 40).x === 0)
}

console.log(`\nresult: ${failed === 0 ? 'OK' : 'BROKEN'} — ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
