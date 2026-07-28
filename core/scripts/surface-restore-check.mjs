// Surface restore checks (#83): what a window's rectangle is BETWEEN samples.
//
// WHY THIS EXISTS. The ring is written at 10 Hz, so nearest-sample restore
// answers on a 100 ms grid. Under a dragged window that grid is pixels — a fast
// drag across a 4K screen runs about 2500 px/s, so half a step is ~125 px. That
// is what the user saw: a picked box beside its window rather than on it.
//
// Interpolation is the fix, and interpolation is exactly the kind of change that
// looks right and quietly invents positions a window never occupied. A snap to
// the screen edge is instantaneous: the window is at A, then at B, and never at
// the midpoint. So these checks assert BOTH halves — that continuous motion is
// reconstructed, and that discontinuous motion is left alone.
//
// It runs the shipping SurfaceTimeline, bundled from TypeScript at run time so
// it can never drift from the code that ships. No Electron, no host process.
//
//   node scripts/surface-restore-check.mjs

import { build } from 'esbuild'

const bundle = await build({
  entryPoints: ['scripts/surface-restore-check.entry.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
})
const { SurfaceTimeline } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
)

let passed = 0
let failed = 0

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** One window, at `x`, 1440 wide — the size the reported captures actually used. */
function surface(x, y, width = 1440, height = 952, id = 'w1') {
  return {
    surfaceId: id,
    bounds: { x, y, width, height },
    zOrder: 0,
    visible: true,
    minimized: false,
    foreground: true,
  }
}

function timeline(samples) {
  const times = samples.map((s) => s.tMs)
  return new SurfaceTimeline(samples, 'ring', {
    startMs: Math.min(...times),
    endMs: Math.max(...times),
  })
}

function xAt(line, tMs) {
  return line.restore(tMs).surfaces[0]?.bounds.x
}

// ---------------------------------------------------------------------------
console.log('\nA window dragged at a constant speed')
// 2500 px/s — the speed that produced the reported error — sampled at 10 Hz.
{
  const samples = []
  for (let i = 0; i <= 10; i++) samples.push({ tMs: i * 100, surfaces: [surface(i * 250, 400)] })
  const line = timeline(samples)

  // Worst case for nearest-sample is the midpoint between two samples.
  const truthAt = (t) => t * 2.5
  let worst = 0
  for (let t = 0; t <= 1000; t += 7) worst = Math.max(worst, Math.abs(xAt(line, t) - truthAt(t)))

  check(
    'every off-grid time is reconstructed within 1 px',
    worst <= 1,
    `worst error ${worst.toFixed(1)} px (nearest-sample would be ~125 px)`,
  )
  check('a time exactly on a sample is unchanged', xAt(line, 300) === 750)
  check('the answer is flagged as an estimate', line.restore(350).accuracy.interpolated === true)
  check(
    'an on-sample answer is NOT flagged as an estimate',
    line.restore(300).accuracy.interpolated === undefined,
  )
}

// ---------------------------------------------------------------------------
console.log('\nA window that jumped (snap, maximise, another monitor)')
{
  // Stationary at 100, then instantly at 2000 — 1900 px in one 100 ms step,
  // far past what a drag of a 1440-wide window could cover.
  const line = timeline([
    { tMs: 0, surfaces: [surface(100, 400)] },
    { tMs: 100, surfaces: [surface(100, 400)] },
    { tMs: 200, surfaces: [surface(2000, 400)] },
    { tMs: 300, surfaces: [surface(2000, 400)] },
  ])
  const mid = xAt(line, 150)
  check(
    'the midpoint of a jump is never invented',
    mid === 100 || mid === 2000,
    `got ${mid}, which is a position the window never occupied`,
  )
  check('a jumped answer is not flagged as an estimate', line.restore(150).accuracy.interpolated === undefined)
}

// ---------------------------------------------------------------------------
console.log('\nA window that changed shape')
{
  const line = timeline([
    { tMs: 0, surfaces: [surface(100, 400, 1440, 952)] },
    { tMs: 100, surfaces: [surface(100, 400, 1900, 1200)] },
  ])
  check('a resize is not treated as a translation', xAt(line, 50) === 100)
}

// ---------------------------------------------------------------------------
console.log('\nA gap the ring never filled')
{
  // 900 ms apart: anything could have happened in there, including a drag out
  // and back that leaves the endpoints looking like slow motion.
  const line = timeline([
    { tMs: 0, surfaces: [surface(100, 400)] },
    { tMs: 900, surfaces: [surface(500, 400)] },
  ])
  const mid = xAt(line, 450)
  check('a gap wider than the ceiling falls back to nearest', mid === 100 || mid === 500, `got ${mid}`)
}

// ---------------------------------------------------------------------------
console.log('\nSurfaces that are not in both samples')
{
  const line = timeline([
    { tMs: 0, surfaces: [surface(100, 400, 1440, 952, 'w1')] },
    { tMs: 100, surfaces: [surface(300, 400, 1440, 952, 'w1'), surface(50, 50, 400, 300, 'w2')] },
  ])
  const restored = line.restore(50)
  const w1 = restored.surfaces.find((s) => s.surfaceId === 'w1')
  check('a window present in both is still interpolated', w1.bounds.x === 200, `got ${w1.bounds.x}`)
  const w2 = restored.surfaces.find((s) => s.surfaceId === 'w2')
  check('a window that appeared mid-gap is left where it was observed', w2 === undefined || w2.bounds.x === 50)
}

// ---------------------------------------------------------------------------
console.log('\nA timeline that holds one instant (every v0.1.x pack)')
{
  const line = new SurfaceTimeline([{ tMs: 0, surfaces: [surface(100, 400)] }], 'single-instant', {
    startMs: 0,
    endMs: 0,
  })
  check('nothing is interpolated from a single sample', xAt(line, 5000) === 100)
  check('and it still reports single-instant coverage', line.restore(5000).accuracy.coverage === 'single-instant')
}

console.log(`\nresult: ${failed === 0 ? 'OK' : 'BROKEN'} — ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
