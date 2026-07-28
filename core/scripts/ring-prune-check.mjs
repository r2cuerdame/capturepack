// Ring prune/compact checks (#85): can a pruned ring still be read?
//
// WHY THIS EXISTS. A user pressed the capture hotkey on a desktop that had been
// recording for 55 seconds and got this, from inside the save path:
//
//   ERROR [app] unhandled rejection RangeError: Offset is outside the bounds of
//   the DataView
//       at SurfaceTimeline.handleAt / restoreAt / surfacesAt
//       at frozenRingObservations
//
// and then, seventeen times, "capture requested while a flow was already open —
// ignored". One bad read inside the flow left the flow open forever, so the
// hotkey did nothing until the app was restarted. Two defects, one log line.
//
// The read only fails on a ring that has PRUNED — which is why every earlier
// capture worked and a long one did not. So this harness drives the ring past
// its retention window with traffic that a real desktop produces and a bench
// with constant windows does not: windows that close, samples where nothing
// moved, and checkpoints landing on samples that carry only removals.
//
// It runs the shipping SurfaceTimeline, bundled from TypeScript at run time.
//
//   node scripts/ring-prune-check.mjs

import { build } from 'esbuild'

const bundle = await build({
  entryPoints: ['scripts/ring-prune-check.entry.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  plugins: [
    {
      name: 'log-stub',
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /(^|\/)log$/ }, () => ({ path: 'log-stub', namespace: 'stub' }))
        pluginBuild.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: `
            export const logInfo = () => {}
            export const logWarn = () => {}
            export const logError = () => {}
          `,
          loader: 'js',
        }))
      },
    },
  ],
})
const { SurfaceTimeline } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
)

let passed = 0
let failed = 0
function check(name, fn) {
  try {
    const detail = fn()
    passed += 1
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } catch (err) {
    failed += 1
    console.log(`  FAIL  ${name} — ${err instanceof Error ? err.message : String(err)}`)
  }
}

function win(hwnd, x, title = `w${hwnd}`) {
  return {
    hwnd: String(hwnd),
    ownerHwnd: '0',
    processId: 100 + Number(hwnd),
    executableName: 'explorer.exe',
    className: 'CabinetWClass',
    windowTitle: title,
    bounds: { x, y: 400, width: 1440, height: 952 },
    clientBounds: { x, y: 430, width: 1440, height: 900 },
    zOrder: 0,
    visible: true,
    minimized: false,
    foreground: true,
    cloaked: false,
  }
}

/** Reads every recorded time; any RangeError is the defect this file is about. */
function readEverything(ring, fromMs, toMs, stepMs = 100) {
  let stacks = 0
  for (let t = fromMs; t <= toMs; t += stepMs) {
    const restored = ring.surfacesAt(t)
    if (restored.surfaces.length > 0) stacks += 1
  }
  return stacks
}

console.log('\nA ring that pruned, read back across its whole retained range')
check('55 s of a desk where windows come and go', () => {
  const ring = new SurfaceTimeline(16 * 1024) // small on purpose: force growth and compaction
  // 10 Hz for 55 s, the length of the capture that failed.
  for (let i = 0; i <= 550; i += 1) {
    const tMs = i * 100
    const windows = [win(1, 100 + i * 3)]
    // A second window that opens and closes repeatedly. Its disappearance is
    // what writes a removal run, and the sample that carries ONLY a removal —
    // nothing else moved — is the shape the arena layout gets wrong.
    if (i % 40 < 20) windows.push(win(2, 2000, 'transient'))
    ring.append({ timeMs: tMs, windows })
    // Retention: keep the last 30 s, exactly as the app does.
    if (tMs > 30_000) ring.prune(tMs - 30_000)
  }
  const range = ring.rangeMs()
  const stacks = readEverything(ring, range.startMs, range.endMs)
  if (stacks === 0) throw new Error('the ring answered nothing anywhere')
  return `${stacks} stacks read over ${range.endMs - range.startMs} ms`
})

console.log('\nThe exact shape suspected of breaking it')
check('a sample carrying ONLY removals becomes the first survivor', () => {
  const ring = new SurfaceTimeline(16 * 1024)
  ring.append({ timeMs: 0, windows: [win(1, 100), win(2, 500)] })
  // Nothing moves, one window closes: no changed records, one removal.
  ring.append({ timeMs: 100, windows: [win(1, 100)] })
  for (let i = 2; i <= 60; i += 1) ring.append({ timeMs: i * 100, windows: [win(1, 100 + i)] })
  ring.prune(200)
  const range = ring.rangeMs()
  readEverything(ring, range.startMs, range.endMs)
  return 'read without throwing'
})

console.log('\nA freeze pinned across a prune, which is what the save path does')
check('freeze, keep recording, then read the frozen range', () => {
  const ring = new SurfaceTimeline(16 * 1024)
  for (let i = 0; i <= 300; i += 1) {
    const windows = [win(1, 100 + i * 3)]
    if (i % 30 < 12) windows.push(win(2, 2000, 'transient'))
    ring.append({ timeMs: i * 100, windows })
  }
  ring.freeze('f1', 0, 30_000)
  // The desktop keeps moving while the pack is written — the window in which
  // the failing read happened.
  for (let i = 301; i <= 400; i += 1) {
    ring.append({ timeMs: i * 100, windows: [win(1, 100 + i * 3)] })
    ring.prune(i * 100 - 30_000)
  }
  const stacks = readEverything(ring, 0, 30_000)
  ring.release('f1')
  if (stacks === 0) throw new Error('the frozen range answered nothing')
  return `${stacks} stacks read inside the frozen range`
})

console.log('\nTitles that churn — the blind spot surface-bench.mjs was written around')
check('every window retitles every sample, over a pruning ring', () => {
  const ring = new SurfaceTimeline(16 * 1024)
  for (let i = 0; i <= 550; i += 1) {
    const tMs = i * 100
    // A downloading browser, a terminal progress line, a media player: the title
    // differs every sample, so the string table churns and compactStrings does
    // real work on every prune. This is the traffic surface-bench.mjs omits.
    const windows = [win(1, 100 + i * 3, `download 12.${i} MB of 400 MB`)]
    if (i % 40 < 20) windows.push(win(2, 2000, `build ${i} of 550 — running tests`))
    if (i % 7 === 0) windows.push(win(3, 900 + i, `tab ${i} — some page title ${i}`))
    ring.append({ timeMs: tMs, windows })
    if (tMs > 30_000) ring.prune(tMs - 30_000)
  }
  const range = ring.rangeMs()
  const stacks = readEverything(ring, range.startMs, range.endMs)
  if (stacks === 0) throw new Error('the ring answered nothing anywhere')
  return `${stacks} stacks read over ${range.endMs - range.startMs} ms`
})

console.log('\nChurning titles AND a freeze held across prunes — the save path on a real desk')
check('freeze the retained range, keep recording and pruning, then read it', () => {
  const ring = new SurfaceTimeline(16 * 1024)
  const push = (i) => {
    const windows = [win(1, 100 + i * 3, `download 12.${i} MB of 400 MB`)]
    if (i % 30 < 12) windows.push(win(2, 2000, `build ${i} — running tests`))
    if (i % 5 === 0) windows.push(win(3, 900 + i, `tab ${i} title`))
    ring.append({ timeMs: i * 100, windows })
  }
  for (let i = 0; i <= 550; i += 1) {
    push(i)
    if (i * 100 > 30_000) ring.prune(i * 100 - 30_000)
  }
  const range = ring.rangeMs()
  ring.freeze('f1', range.startMs, range.endMs)
  // The desk keeps moving while the pack is written — the window the failing
  // read happened in.
  for (let i = 551; i <= 700; i += 1) {
    push(i)
    ring.prune(i * 100 - 30_000)
  }
  const stacks = readEverything(ring, range.startMs, range.endMs)
  ring.release('f1')
  if (stacks === 0) throw new Error('the frozen range answered nothing')
  return `${stacks} stacks read inside the frozen range`
})

console.log('\nA real desktop\'s window COUNT, on an arena that has to compact')
check('60 windows all moving, small arena, pruning throughout', () => {
  // The checks above use one to three windows. A real desk has dozens, and that
  // is what makes a sample's record run long enough to hit the end of the arena
  // PART WAY THROUGH writing it — the one moment where a compaction moves bytes
  // that the sample being written has already recorded the address of.
  const ring = new SurfaceTimeline(8 * 1024)
  for (let i = 0; i <= 550; i += 1) {
    const tMs = i * 100
    const windows = []
    for (let w = 1; w <= 60; w += 1) {
      windows.push(win(w, (w * 37 + i * 3) % 3800, `window ${w} — step ${i}`))
    }
    ring.append({ timeMs: tMs, windows })
    if (tMs > 30_000) ring.prune(tMs - 30_000)
  }
  const range = ring.rangeMs()
  const stacks = readEverything(ring, range.startMs, range.endMs)
  if (stacks === 0) throw new Error('the ring answered nothing anywhere')
  return `${stacks} stacks read over ${range.endMs - range.startMs} ms`
})

console.log(`\nresult: ${failed === 0 ? 'OK' : 'BROKEN'} — ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
