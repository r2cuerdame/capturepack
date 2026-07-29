// Can a box be picked in a PAST frame? (#90)
//
// The user's report: "과거프레임에서는 못잡는다". The recording side was healthy
// on that capture — 469 samples at 67 ms, and the editor session logged that it
// read 449 observations across the whole 30 s — so whatever is wrong is in the
// half that turns those observations into something hoverable.
//
// This runs the SHIPPING ContextSession, which is Electron-free for exactly this
// reason, over a ring the same shape a real capture produces, and asks it for a
// frame at every second of the replay. A time that offers no candidate is the
// defect, and the harness says which time and why.
//
//   node scripts/past-picking-check.mjs

import { build } from 'esbuild'

const bundle = await build({
  entryPoints: ['scripts/past-picking-check.entry.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  plugins: [
    {
      name: 'log-stub',
      setup(b) {
        b.onResolve({ filter: /(^|\/)log$/ }, () => ({ path: 'log-stub', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export const logInfo=()=>{};export const logWarn=()=>{};export const logError=()=>{}',
          loader: 'js',
        }))
      },
    },
  ],
})
const { ContextSession, ObjectIndex } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
)

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${name}`) }
  else { failed += 1; console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`) }
}

const REPLAY_MS = 30_000
const INTERVAL_MS = 67 // one sample per frame at 15 fps (#87)

/** A desk of `n` windows, the one at index 0 sliding right over time. */
function windowsAt(tMs, n = 12) {
  const out = []
  for (let i = 0; i < n; i += 1) {
    out.push({
      // Ring observations carry Core's own stable id (#90). Reproduced here
      // because it is what production hands the session.
      surface_id: `sfc-${i}`,
      // Both sources observe the handle; only the handle (#97).
      hwnd: `${1000 + i}`,
      title: i === 0 ? 'CapturePack - 파일 탐색기' : `window ${i}`,
      process: i === 0 ? 'explorer.exe' : 'app.exe',
      class_name: i === 0 ? 'CabinetWClass' : 'Cls',
      bounds: {
        x: i === 0 ? Math.round((tMs / REPLAY_MS) * 2000) : 100 + i * 90,
        y: 400,
        width: 1443,
        height: 953,
      },
      display: 2,
      focused: i === 0,
      z: i,
      hasControls: false,
      tree: 'skipped',
    })
  }
  return out
}

const observations = []
for (let t = 0; t <= REPLAY_MS; t += INTERVAL_MS) {
  observations.push({ tMs: t, windows: windowsAt(t), elements: [] })
}

const session = new ContextSession('ctx-test', {
  displays: [
    { index: 1, focused: false, width: 1200, height: 1920 },
    { index: 2, focused: true, width: 3840, height: 2160 },
  ],
  replayDurationMs: REPLAY_MS,
  observation: null,
  dropped: false,
})
session.adoptAll(observations)

console.log(`\n${observations.length} observations every ${INTERVAL_MS} ms across ${REPLAY_MS} ms`)
console.log('asking the shipping session for a frame at each second:\n')

const empty = []
const rows = []
for (let t = 0; t <= REPLAY_MS; t += 1000) {
  const frame = await session.frameAt(t)
  const d2 = frame.displays.find((d) => d.display === 2)
  const n = d2?.candidates.length ?? 0
  rows.push({ t, n, coverage: frame.accuracy.coverage, errorMs: frame.accuracy.errorMs })
  if (n === 0) empty.push(t)
}
for (const r of rows.filter((r, i) => i % 5 === 0 || r.n === 0)) {
  console.log(`   t=${String(r.t).padStart(5)}  candidates ${String(r.n).padStart(3)}  coverage ${r.coverage}  errorMs ${r.errorMs}`)
}

check('every second of the replay offers at least one candidate', empty.length === 0,
  `no candidates at ${empty.length} time(s): ${empty.slice(0, 8).join(', ')}${empty.length > 8 ? ' ...' : ''}`)
check('the capture instant offers candidates', (rows[rows.length - 1]?.n ?? 0) > 0)
check('an early time offers as many as a late one',
  (rows[1]?.n ?? 0) === (rows[rows.length - 1]?.n ?? 0),
  `t=1000 -> ${rows[1]?.n}, t=${REPLAY_MS} -> ${rows[rows.length - 1]?.n}`)
check('every answer is reported as covered',
  rows.every((r) => r.coverage === 'covered'),
  rows.filter((r) => r.coverage !== 'covered').map((r) => `${r.t}:${r.coverage}`).slice(0, 6).join(' '))

// The point of picking: the candidate must be WHERE THE WINDOW WAS, not where
// it ended up. The sliding window is at a different x at every time.
const early = await session.frameAt(2000)
const late = await session.frameAt(28_000)
const xOf = (f) => f.displays.find((d) => d.display === 2)?.candidates[0]?.bounds.x
check('the answer MOVES with the object across the replay', xOf(early) !== xOf(late),
  `t=2000 -> x=${xOf(early)}, t=28000 -> x=${xOf(late)}`)

// ---------------------------------------------------------------------------
// AND THE HALF THE USER ACTUALLY TOUCHES: hovering the editor's own index.
// A frame full of candidates that the index then refuses is indistinguishable,
// from the outside, from a frame with no candidates at all — which is what
// "과거프레임에서는 못잡는다" looks like from the pointer's side.
console.log('\nhovering the editor index over the same frames:')
const misses = []
for (let t = 0; t <= REPLAY_MS; t += 1000) {
  const frame = await session.frameAt(t)
  const slice = frame.displays.find((d) => d.display === 2)
  const index = ObjectIndex.build(
    slice?.candidates ?? [],
    slice?.surfaces ?? [],
    slice?.coverage ?? [],
    frame.claims,
    3840,
    2160,
  )
  // The sliding window's own centre at this time — where a user pointing at it
  // would actually be.
  const w = windowsAt(t)[0]
  const px = w.bounds.x + Math.round(w.bounds.width / 2)
  const py = w.bounds.y + Math.round(w.bounds.height / 2)
  const picked = index.pick(px, py)
  if (picked === null) misses.push(t)
  if (t % 5000 === 0) {
    console.log(
      `   t=${String(t).padStart(5)}  index ${String(index.size).padStart(3)} objects  ` +
        `hover (${px},${py}) -> ${picked === null ? 'NOTHING' : `${picked.level} "${picked.candidate.name}"`}`,
    )
  }
}
check('hovering the object finds it at every second of the replay', misses.length === 0,
  `nothing under the pointer at ${misses.length} time(s): ${misses.slice(0, 8).join(', ')}`)

// ---------------------------------------------------------------------------
// A REAL DESK HAS WINDOWS THAT SHARE AN IDENTITY (#90).
//
// `surfaceKey` is process + class + title, and a surface's id is that key plus
// its ORDINAL among the windows sharing it IN THAT OBSERVATION. Two windows of
// the same app with the same (often empty) title therefore have ids decided by
// their ORDER — and the order changes whenever the user brings one forward. The
// id is meant to be stable for the whole session; under that shape it is not.
console.log('\nTwo windows an app gives the same title, whose order swaps')
{
  const twins = []
  for (let t = 0; t <= REPLAY_MS; t += INTERVAL_MS) {
    // Same process, same class, same (empty) title — told apart ONLY by the id
    // the ring minted for each. That is the whole point: nothing else about
    // them is distinguishable, and their order in the list changes.
    const a = { surface_id: 'sfc-left', title: '', process: 'chrome.exe', class_name: 'Chrome_WidgetWin_1',
      bounds: { x: 100, y: 100, width: 800, height: 600 }, display: 2, focused: false, z: 0,
      hasControls: false, tree: 'skipped' }
    const b = { surface_id: 'sfc-right', title: '', process: 'chrome.exe', class_name: 'Chrome_WidgetWin_1',
      bounds: { x: 2000, y: 100, width: 800, height: 600 }, display: 2, focused: false, z: 1,
      hasControls: false, tree: 'skipped' }
    twins.push({ tMs: t, windows: t < REPLAY_MS / 2 ? [a, b] : [b, a], elements: [] })
  }
  const s2 = new ContextSession('ctx-twins', {
    displays: [{ index: 2, focused: true, width: 3840, height: 2160 }],
    replayDurationMs: REPLAY_MS, observation: null, dropped: false,
  })
  s2.adoptAll(twins)

  const early = await s2.frameAt(1000)
  const left = early.displays[0].candidates.find((c) => c.bounds.x === 100)
  const track = s2.trackOf(left.surfaceId, 0, REPLAY_MS)
  const last = track === null ? null : track.samples[track.samples.length - 1]
  console.log(`   picked surfaceId ${left.surfaceId} at t=1000 (x=100)`)
  console.log(`   track: ${track === null ? 'NONE' : `${track.samples.length} samples, ${track.samples[0].tMs}..${last.tMs} ms, endedAtMs ${track.endedAtMs}`}`)
  const xs = track === null ? [] : [...new Set(track.samples.map((s) => s.x))]
  console.log(`   x values along it: ${xs.join(', ')}`)

  check('the track covers the whole replay, not just up to the swap',
    last !== null && last.tMs >= REPLAY_MS - INTERVAL_MS * 2,
    last === null ? 'no track at all' : `ends at ${last.tMs} of ${REPLAY_MS}`)
  check('and it never jumps to the OTHER window of the same name',
    xs.length === 1 && xs[0] === 100,
    `followed x=${xs.join(' then ')} — reordering the list renamed the object`)

  const late = await s2.frameAt(REPLAY_MS - 1000)
  const stillLeft = late.displays[0].candidates.find((c) => c.bounds.x === 100)
  check('the same window keeps the same surfaceId across the swap',
    stillLeft !== undefined && stillLeft.surfaceId === left.surfaceId,
    `was ${left.surfaceId}, now ${stillLeft?.surfaceId}`)
}

// ---------------------------------------------------------------------------
// THE TWO RUNGS MUST NOT DESTROY EACH OTHER (#91).
//
// Core's ring says where every WINDOW was for the whole replay. The capture
// instant's UI Automation dump says what CONTROLS were inside them, at one
// moment. They arrive independently — the dump is budgeted and can land after
// the editor opened — and they used to be stored in one field, so whichever
// came second erased the first. It was always the ring, which is why no control
// could ever be picked: 585 of them were collected, adopted, and thrown away.
console.log('\nA control dump and a window ring, adopted in both orders')
for (const order of ['dump first, then ring', 'ring first, then dump']) {
  const s3 = new ContextSession(`ctx-${order}`, {
    displays: [{ index: 2, focused: true, width: 3840, height: 2160 }],
    replayDurationMs: REPLAY_MS,
    observation: null,
    dropped: false,
  })
  // The dump numbers its windows its OWN way (#94): UIA walked them in its own
  // order, so the z it reports for a window is not the z Core's host reports.
  // A control points at its window BY THAT NUMBER, so the merge has to
  // translate — untranslated, every control belongs to a window that is not
  // there and none of them can ever be offered.
  const DUMP_Z = 77
  const w0 = windowsAt(REPLAY_MS, 1)[0]
  const dump = {
    tMs: REPLAY_MS,
    windows: [
      {
        ...w0,
        // The SAME window as the ring's, and everything the two sources merely
        // DESCRIBE is spelled differently — exactly as measured on a real pack:
        // the surface host says "explorer.exe" where the dump says "explorer",
        // and the dump writes a window's CLASS into its title when it has none.
        // Only `hwnd` is observed by both.
        surface_id: undefined,
        process: w0.process.replace(/\.exe$/, ''),
        title: `${w0.title} (as the dump spells it)`,
        z: DUMP_Z,
        bounds: {
          x: w0.bounds.x - 9,
          y: w0.bounds.y - 4,
          width: w0.bounds.width + 18,
          height: w0.bounds.height + 9,
        },
        hasControls: true,
        tree: 'collected',
      },
    ],
    elements: [
      {
        name: '저장',
        control_type: 'Button',
        automation_id: 'saveBtn',
        class_name: 'Button',
        bounds: {
          x: w0.bounds.x + 200,
          y: w0.bounds.y + 200,
          width: 120,
          height: 40,
        },
        display: 2,
        window: DUMP_Z,
      },
    ],
  }
  if (order === 'dump first, then ring') {
    s3.adopt(dump)
    s3.adoptAll(observations)
  } else {
    s3.adoptAll(observations)
    s3.adopt(dump)
  }

  const atNow = await s3.frameAt(REPLAY_MS)
  const atPast = await s3.frameAt(5000)
  const controls = (atNow.displays[0]?.candidates ?? []).filter((c) => c.authority !== 'window')
  const named = controls.find((c) => c.name === '저장')
  const pastWindows = (atPast.displays[0]?.candidates ?? []).length

  console.log(`   ${order}: controls at the capture instant ${controls.length}, window candidates at t=5000 ${pastWindows}`)
  check(`[${order}] controls survive`, controls.length > 0,
    'the dump was thrown away — no control can ever be picked')
  check(`[${order}] the control is the one the dump described`, named !== undefined,
    `offered ${controls.map((c) => c.name).join(', ') || 'nothing'}`)
  check(`[${order}] the window ring survives`, pastWindows > 1,
    'the ring was thrown away — picking in the past falls back to one instant')
}

// A pack whose dump predates the handle (#97) must still resolve its controls.
console.log('\nAn older dump that reports no handle at all')
{
  const s4 = new ContextSession('ctx-nohwnd', {
    displays: [{ index: 2, focused: true, width: 3840, height: 2160 }],
    replayDurationMs: REPLAY_MS,
    observation: null,
    dropped: false,
  })
  const w0 = windowsAt(REPLAY_MS, 1)[0]
  s4.adoptAll(observations)
  s4.adopt({
    tMs: REPLAY_MS,
    // No hwnd, and the process spelled the dump's way: the description
    // fallback has to carry it, which is what an already-saved pack needs.
    windows: [
      {
        ...w0,
        surface_id: undefined,
        hwnd: undefined,
        z: 55,
        process: w0.process.replace(/\.exe$/, ''),
        hasControls: true,
        tree: 'collected',
      },
    ],
    elements: [
      {
        name: '열기',
        control_type: 'Button',
        automation_id: 'openBtn',
        class_name: 'Button',
        bounds: { x: w0.bounds.x + 40, y: w0.bounds.y + 40, width: 90, height: 30 },
        display: 2,
        window: 55,
      },
    ],
  })
  const f = await s4.frameAt(REPLAY_MS)
  const named = (f.displays[0]?.candidates ?? []).find((c) => c.name === '열기')
  check('an older dump still resolves through the description fallback', named !== undefined,
    'a pack already on disk lost its controls')
}

console.log(`\nresult: ${failed === 0 ? 'OK' : 'BROKEN'} — ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
