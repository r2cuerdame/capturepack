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
// the same rectangle.
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

console.log('\nA box following a moving object')
check('on a sample, it is that sample', trackedBoundsAt(moving, 1000).x === 0)
check('half way between, it is half way along',
  trackedBoundsAt(moving, 1500).x === 100 && trackedBoundsAt(moving, 1500).y === 50,
  JSON.stringify(trackedBoundsAt(moving, 1500)))
check('a quarter of the way', trackedBoundsAt(moving, 1250).x === 50)
check('size is carried, not invented',
  trackedBoundsAt(moving, 1500).width === 100 && trackedBoundsAt(moving, 1500).height === 50)

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
  const view = annotationAt(moving, 1500)
  check('carries the resolved rectangle', view.bounds.x === 100)
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
    annotationAt(crossing, 1050).display === 2)
  check('and interpolates there', trackedBoundsAt(crossing, 1050).x === 150,
    JSON.stringify(trackedBoundsAt(crossing, 1050)))
  check('after the crossing it is on the other screen',
    annotationAt(crossing, 1250).display === 1)
  check('and interpolates there', trackedBoundsAt(crossing, 1250).x === 850,
    JSON.stringify(trackedBoundsAt(crossing, 1250)))

  // The two ends of the crossing segment are in different coordinate spaces:
  // averaging them names a rectangle that exists on neither screen.
  const mid = annotationAt(crossing, 1150)
  check('the crossing itself is a jump, never a blend',
    mid.display === 1 && mid.bounds.x === 900,
    `got display ${mid.display} x=${mid.bounds.x}`)
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
    annotationAt(plain, 50).display === undefined)
  check('and still interpolates', trackedBoundsAt(plain, 50).x === 50)
}

console.log(`\nresult: ${failed === 0 ? 'OK' : 'BROKEN'} — ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
