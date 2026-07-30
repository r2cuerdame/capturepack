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
const { ContextSession, ObjectIndex, projectControlTrack } = await import(
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

// A syntactically valid but empty singleton history used to replace the richer
// capture-instant UIA payload when a pack was reopened. The session now treats
// an all-empty ring as no refinement and keeps the selectable instant floor.
console.log('\nreopening with one empty persisted checkpoint:')
{
  const instantWindow = {
    surface_id: 'reopen-window',
    hwnd: '9001',
    title: 'Reopen app',
    process: 'reopen.exe',
    class_name: 'ReopenWindow',
    bounds: { x: 100, y: 100, width: 800, height: 600 },
    display: 1,
    focused: true,
    z: 0,
    hasControls: true,
    tree: 'collected',
  }
  const reopenSession = new ContextSession('ctx-empty-singleton', {
    displays: [{ index: 1, focused: true, width: 1920, height: 1080 }],
    replayDurationMs: 0,
    observation: {
      tMs: 0,
      windows: [instantWindow],
      elements: [{
        window: 0,
        bounds: { x: 160, y: 160, width: 120, height: 40 },
        control_type: 'Button',
        name: 'Still selectable',
        automation_id: 'reopen-action',
        class_name: 'Button',
        display: 1,
      }],
    },
    dropped: false,
  })
  reopenSession.adoptAll([{ tMs: 0, windows: [], elements: [] }])
  const reopenedFrame = await reopenSession.frameAt(0)
  const reopenedCandidate = reopenedFrame.displays[0]?.candidates.find(
    (candidate) => candidate.name === 'Still selectable',
  )
  check(
    'an empty singleton history cannot erase the capture-instant UIA floor',
    reopenedCandidate !== undefined,
    'the valid UIA window/control disappeared after adoptAll([empty])',
  )
}

// The point of picking: the candidate must be WHERE THE WINDOW WAS, not where
// it ended up. The sliding window is at a different x at every time.
const early = await session.frameAt(2000)
const late = await session.frameAt(28_000)
const xOf = (f) => f.displays.find((d) => d.display === 2)?.candidates[0]?.bounds.x
check('the answer MOVES with the object across the replay', xOf(early) !== xOf(late),
  `t=2000 -> x=${xOf(early)}, t=28000 -> x=${xOf(late)}`)

// ---------------------------------------------------------------------------
// A DOM PICK MAY ARRIVE BEFORE THE WINDOW RING (#112).
//
// An editor is constructed while the UIA grace is still open.  That first
// construction registers ChromeDomProvider and asks for its pick count, which
// deliberately fills the provider's placement cache.  At that moment there is
// no surface timeline yet, so the honest answer is no placed DOM pick.  The
// full ring is adopted moments later.  It MUST invalidate that first empty
// placement rather than leave every past Chrome frame permanently window-only.
console.log('\nA Chrome DOM pick whose surface ring arrives after the editor opens')
{
  const domEvent = {
    tMs: 1000,
    type: 'dom.element.selected',
    tab: { url: 'https://capturepack.dev/docs', title: 'CapturePack docs' },
    element: {
      tag: 'button',
      selector: '#save',
      bounds: { x: 200, y: 100, width: 120, height: 40 },
      id: 'save',
      role: 'button',
      text: 'Save',
    },
    viewport: {
      width: 1000,
      height: 600,
      dpr: 1,
      screenX: null,
      screenY: null,
      outerWidth: null,
      outerHeight: null,
    },
  }
  const chromeWindowAt = (tMs) => ({
    surface_id: 'sfc-dom-chrome',
    hwnd: '4242',
    title: 'CapturePack docs - Google Chrome',
    process: 'chrome.exe',
    class_name: 'Chrome_WidgetWin_1',
    bounds: { x: 100 + Math.round(tMs / 10), y: 200, width: 1020, height: 680 },
    client_bounds: { x: 110 + Math.round(tMs / 10), y: 230, width: 1000, height: 650 },
    display: 1,
    focused: true,
    z: 0,
    hasControls: false,
    tree: 'skipped',
  })
  const domSession = new ContextSession('ctx-dom-late-ring', {
    displays: [{ index: 1, focused: true, width: 1920, height: 1080, snapshotPixelsPerDip: 1 }],
    replayDurationMs: 2000,
    // The production race: the editor opens with no UIA observation/ring.
    observation: null,
    dropped: false,
    domEvents: [domEvent],
  })
  // This is deliberately after construction: registration above has already
  // cached the DOM pick against the empty timeline.
  domSession.adoptAll([0, 1000, 2000].map((tMs) => ({
    tMs,
    windows: [chromeWindowAt(tMs)],
    elements: [],
  })))
  const past = await domSession.frameAt(250)
  const domCandidate = past.displays[0]?.candidates.find(
    (candidate) => candidate.providerId === 'chrome-dom' && candidate.name === 'Save',
  )
  console.log(`   past t=250 -> ${domCandidate === undefined ? 'window only' : `${domCandidate.providerId} ${domCandidate.name}`}`)
  check('a late ring invalidates the initial empty DOM placement cache',
    domCandidate !== undefined,
    'the Chrome DOM pick remained cached as absent after adoptAll()')
}

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
// DESKTOP FOCUS IS NOT DESKTOP Z-ORDER.
//
// CapturePack_2026-07-29_194912 recorded the shell desktop as focused after the
// user clicked the wallpaper. Its raw z was 4 — behind Orca at 3 and the
// taskbar at 0 — but Core promoted every focused window to -1. Progman spans
// the whole virtual desktop, so the resolver then put all 161 candidates from
// the visible focused display behind a desktop candidate the editor correctly
// refuses to offer. The frame was full and the index was full; every hover
// still answered NOTHING.
console.log('\nA focused shell desktop behind a visible app (_194912 shape)')
{
  const packObservation = {
    tMs: REPLAY_MS,
    windows: [
      {
        surface_id: 'sfc-taskbar',
        hwnd: '65984',
        title: 'Shell_TrayWnd',
        process: 'explorer',
        class_name: 'Shell_TrayWnd',
        bounds: { x: 0, y: 2088, width: 3840, height: 72 },
        display: 2,
        focused: false,
        z: 0,
        hasControls: false,
        tree: 'skipped',
      },
      {
        surface_id: 'sfc-orca',
        hwnd: '395976',
        title: 'Orca',
        process: 'Orca',
        class_name: 'Chrome_WidgetWin_1',
        bounds: { x: 0, y: 0, width: 1932, height: 2091 },
        display: 2,
        focused: false,
        z: 3,
        hasControls: true,
        tree: 'collected',
      },
      {
        surface_id: 'sfc-desktop',
        hwnd: '66060',
        title: 'Program Manager',
        process: 'explorer',
        class_name: 'Progman',
        bounds: { x: -1200, y: 0, width: 5040, height: 2160 },
        display: 2,
        focused: true,
        z: 4,
        hasControls: false,
        tree: 'skipped',
      },
    ],
    elements: [
      {
        name: '명령',
        control_type: 'Button',
        automation_id: 'command',
        class_name: 'Button',
        bounds: { x: 120, y: 120, width: 240, height: 48 },
        display: 2,
        window: 3,
      },
    ],
  }
  const desktopSession = new ContextSession('ctx-desktop-focus', {
    displays: [{ index: 2, focused: true, width: 3840, height: 2160 }],
    replayDurationMs: REPLAY_MS,
    observation: packObservation,
    dropped: false,
  })
  const frame = await desktopSession.frameAt(REPLAY_MS)
  const slice = frame.displays[0]
  const desktop = slice.surfaces.find((s) => s.className === 'Progman')
  const index = ObjectIndex.build(
    slice.candidates,
    slice.surfaces,
    slice.coverage,
    frame.claims,
    3840,
    2160,
  )
  const picked = index.pick(200, 140)

  // Also feed the editor the exact malformed surface verdict rc.35 produced.
  // This exercises the index's compatibility boundary independently of Core's
  // fixed normalisation above: already-built/external frames cannot be allowed
  // to make the desktop an occluder either.
  const legacySurfaces = slice.surfaces.map((surface) =>
    surface.className === 'Progman'
      ? { ...surface, zOrder: -1, foreground: true }
      : surface,
  )
  const legacyIndex = ObjectIndex.build(
    slice.candidates,
    legacySurfaces,
    slice.coverage,
    frame.claims,
    3840,
    2160,
  )
  const legacyPicked = legacyIndex.pick(200, 140)

  console.log(
    `   desktop foreground=${desktop?.foreground} z=${desktop?.zOrder}; ` +
      `frame candidates=${slice.candidates.length}, index=${index.size}, ` +
      `hover -> ${picked?.candidate.name ?? 'NOTHING'}`,
  )
  check('focused Progman keeps its enumerated bottom z',
    desktop?.foreground === false && desktop.zOrder === 4,
    `foreground=${desktop?.foreground}, z=${desktop?.zOrder}`)
  check('_194912 offers a control instead of nothing',
    picked?.level === 'control' && picked.candidate.name === '명령',
    `offered ${picked === null ? 'nothing' : `${picked.level} ${picked.candidate.name}`}`)
  check('the editor rejects a legacy desktop occluder too',
    legacyPicked?.level === 'control' && legacyPicked.candidate.name === '명령',
    `offered ${legacyPicked === null ? 'nothing' : `${legacyPicked.level} ${legacyPicked.candidate.name}`}`)
}

// The desktop exception must not weaken the ordinary foreground invariant.
{
  const foregroundSession = new ContextSession('ctx-real-foreground', {
    displays: [{ index: 2, focused: true, width: 3840, height: 2160 }],
    replayDurationMs: REPLAY_MS,
    observation: {
      tMs: REPLAY_MS,
      windows: [{
        surface_id: 'sfc-foreground',
        hwnd: '7',
        title: 'Actual foreground app',
        process: 'app',
        class_name: 'ActualWindow',
        bounds: { x: 20, y: 20, width: 800, height: 600 },
        display: 2,
        focused: true,
        z: 7,
        hasControls: false,
        tree: 'skipped',
      }],
      elements: [],
    },
    dropped: false,
  })
  const frame = await foregroundSession.frameAt(REPLAY_MS)
  const surface = frame.displays[0].surfaces[0]
  check('a real focused window is still promoted above its enumerated z',
    surface?.foreground === true && surface.zOrder === -1,
    `foreground=${surface?.foreground}, z=${surface?.zOrder}`)
}

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

// The nearest Lane-A checkpoint can already contain controls for several
// owners. A capture-instant dump commonly reaches only the foreground one;
// replacing the checkpoint's whole element array with that one dump made every
// background app become window-only at the final frame.
console.log('\nCapture-instant UIA merges per owner, never as one global element array')
{
  const windowA = {
    surface_id: 'sfc-owner-a',
    hwnd: '8101',
    title: 'Owner A',
    process: 'a.exe',
    class_name: 'AppWindow',
    bounds: { x: 50, y: 50, width: 400, height: 300 },
    display: 1,
    focused: true,
    z: 0,
    hasControls: true,
    tree: 'collected',
  }
  const windowB = {
    surface_id: 'sfc-owner-b',
    hwnd: '8102',
    title: 'Owner B',
    process: 'b.exe',
    class_name: 'AppWindow',
    bounds: { x: 550, y: 50, width: 400, height: 300 },
    display: 1,
    focused: false,
    z: 1,
    hasControls: true,
    tree: 'collected',
  }
  const ring = [{
    tMs: 1000,
    windows: [windowA, windowB],
    elements: [
      {
        name: 'A from Lane A',
        control_type: 'Button',
        automation_id: 'a-action',
        class_name: 'Button',
        bounds: { x: 100, y: 100, width: 120, height: 40 },
        display: 1,
        window: 0,
      },
      {
        name: 'B from Lane A',
        control_type: 'Button',
        automation_id: 'b-action',
        class_name: 'Button',
        bounds: { x: 600, y: 100, width: 120, height: 40 },
        display: 1,
        window: 1,
      },
    ],
  }]
  const asymmetric = new ContextSession('ctx-owner-asymmetry', {
    displays: [{ index: 1, focused: true, width: 1000, height: 500 }],
    replayDurationMs: 1000,
    observation: {
      tMs: 1000,
      windows: [{
        ...windowA,
        surface_id: undefined,
        z: 77,
      }],
      elements: [{
        name: 'A from capture instant',
        control_type: 'Button',
        automation_id: 'a-action',
        class_name: 'Button',
        bounds: { x: 105, y: 105, width: 120, height: 40 },
        display: 1,
        window: 77,
      }],
    },
    dropped: false,
  })
  asymmetric.adoptAll(ring)
  const frame = await asymmetric.frameAt(1000)
  const slice = frame.displays[0]
  const names = (slice?.candidates ?? [])
    .filter((candidate) => candidate.authority !== 'window')
    .map((candidate) => candidate.name)
  check('a dump of owner A preserves owner B Lane-A controls',
    names.includes('A from capture instant') && names.includes('B from Lane A'),
    `offered ${names.join(', ') || 'nothing'}`)
  const index = ObjectIndex.build(
    slice?.candidates ?? [],
    slice?.surfaces ?? [],
    slice?.coverage ?? [],
    frame.claims,
    1000,
    500,
    1,
  )
  const ownerBPick = index.pick(660, 120)
  check('the real editor index still selects owner B after the asymmetric merge',
    ownerBPick?.level === 'control' && ownerBPick.candidate.name === 'B from Lane A',
    `picked ${ownerBPick?.level ?? 'nothing'} ${ownerBPick?.candidate.name ?? ''}`)
  check('an equally complete capture-instant tree remains authoritative for its owner',
    !names.includes('A from Lane A'),
    `offered stale owner-A controls: ${names.join(', ')}`)
}

// A timed-out capture dump is only a prefix. It must never replace a whole
// exact Lane-A tree for the same owner; AutomationId is deliberately repeated
// to ensure the decision does not accidentally rely on unique ids.
console.log('\nA truncated capture dump cannot regress a complete Lane-A owner tree')
{
  const owner = {
    surface_id: 'sfc-complete-owner',
    hwnd: '8201',
    title: 'Rows',
    process: 'rows.exe',
    class_name: 'RowsWindow',
    bounds: { x: 20, y: 20, width: 600, height: 700 },
    display: 1,
    focused: true,
    z: 0,
    hasControls: true,
    tree: 'collected',
  }
  const row = (index, prefix, window) => ({
    name: `${prefix} row ${index + 1}`,
    control_type: 'Button',
    automation_id: 'repeated-row',
    class_name: 'RowButton',
    bounds: { x: 60, y: 50 + index * 15, width: 140, height: 12 },
    display: 1,
    window,
  })
  const exact = Array.from({ length: 40 }, (_, index) => row(index, 'Lane', 0))
  const truncated = Array.from({ length: 32 }, (_, index) => row(index, 'Dump', 91))
  const session = new ContextSession('ctx-complete-beats-truncated', {
    displays: [{ index: 1, focused: true, width: 800, height: 800 }],
    replayDurationMs: 1000,
    observation: {
      tMs: 1000,
      windows: [{
        ...owner,
        surface_id: undefined,
        z: 91,
        tree: 'truncated',
      }],
      elements: truncated,
    },
    dropped: false,
  })
  session.adoptAll([{ tMs: 1000, windows: [owner], elements: exact }])
  const frame = await session.frameAt(1000)
  const rows = (frame.displays[0]?.candidates ?? []).filter(
    (candidate) => candidate.identity?.automation_id === 'repeated-row',
  )
  check('all 40 exact occurrences survive a 32-control capture timeout',
    rows.length === 40 && rows.some((candidate) => candidate.name === 'Lane row 40'),
    `offered ${rows.length} rows; last=${rows.at(-1)?.name ?? 'none'}`)
}

// When BOTH sources are partial, preserve their ordered multiset union. A Set
// would collapse the three repeated rows to one; concatenation would produce
// five. The correct result is max(3, 2) repeated occurrences plus the unique
// capture-instant action.
console.log('\nTwo partial owner trees merge controls as ordered occurrences')
{
  const owner = {
    surface_id: 'sfc-partial-owner',
    hwnd: '8301',
    title: 'Partial rows',
    process: 'partial.exe',
    class_name: 'RowsWindow',
    bounds: { x: 20, y: 20, width: 500, height: 400 },
    display: 1,
    focused: true,
    z: 0,
    hasControls: true,
    tree: 'truncated',
  }
  const repeat = (name, y, window) => ({
    name,
    control_type: 'Button',
    automation_id: 'same-row',
    class_name: 'RowButton',
    bounds: { x: 60, y, width: 140, height: 24 },
    display: 1,
    window,
  })
  const partial = new ContextSession('ctx-partial-occurrences', {
    displays: [{ index: 1, focused: true, width: 800, height: 600 }],
    replayDurationMs: 1000,
    observation: {
      tMs: 1000,
      windows: [{ ...owner, surface_id: undefined, z: 88 }],
      elements: [
        repeat('Instant repeated 1', 60, 88),
        repeat('Instant repeated 2', 100, 88),
        {
          ...repeat('Instant unique', 180, 88),
          automation_id: 'instant-unique',
        },
      ],
    },
    dropped: false,
  })
  partial.adoptAll([{
    tMs: 1000,
    windows: [owner],
    elements: [
      repeat('Lane repeated 1', 60, 0),
      repeat('Lane repeated 2', 100, 0),
      repeat('Lane repeated 3', 140, 0),
    ],
  }])
  const frame = await partial.frameAt(1000)
  const controls = (frame.displays[0]?.candidates ?? []).filter(
    (candidate) => candidate.authority !== 'window',
  )
  const repeated = controls.filter(
    (candidate) => candidate.identity?.automation_id === 'same-row',
  )
  check('partial trees retain three repeated occurrences without concatenating duplicates',
    repeated.length === 3,
    `offered ${repeated.length} repeated rows`)
  check('partial trees retain a unique capture-instant control',
    controls.some((candidate) => candidate.name === 'Instant unique'),
    `offered ${controls.map((candidate) => candidate.name).join(', ')}`)
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

// ---------------------------------------------------------------------------
// A CONTROL TRACK IS NOT ITS OWNER WINDOW'S RECTANGLE.
//
// CapturePack_2026-07-29_210107 preserves enough evidence to prove both halves:
// elements.json identifies two exact child controls, while annotations.json
// stores those controls' NAMES beside their OWNER WINDOWS' rectangles. The
// mismatch was introduced after the correct pick: attachTrack copied the
// surface path into the annotation instead of projecting that path onto the
// picked control.
console.log('\nrc.36 control metadata beside owner-window bounds (_210107 exact shape)')
{
  const PACK_END = 10_929
  const packWindows = () => [
    {
      surface_id: 'sfc-orca',
      hwnd: '34664',
      title: 'Orca',
      process: 'Orca',
      class_name: 'Chrome_WidgetWin_1',
      bounds: { x: 9, y: 0, width: 1914, height: 2082 },
      display: 2,
      focused: true,
      z: 3,
      hasControls: true,
      tree: 'collected',
    },
    {
      surface_id: 'sfc-chrome-left',
      hwnd: '6472',
      title: 'CapturePack — Capture context, not screenshots - Chrome',
      process: 'chrome.exe',
      class_name: 'Chrome_WidgetWin_1',
      bounds: { x: 0, y: 0, width: 1200, height: 1872 },
      display: 1,
      focused: false,
      z: 4,
      hasControls: true,
      tree: 'collected',
    },
  ]
  const dump = {
    tMs: PACK_END,
    windows: packWindows(),
    elements: [
      {
        name: 'loopoffice loopoffice에 대한 프로젝트 작업 loopoffice에 대한 새 작업 트리 만들기',
        control_type: 'Button',
        automation_id: 'worktree-list-option-project%3Agithub%3Ar2cuerdame%2Floopoffice',
        class_name: 'group relative flex h-7 w-full',
        bounds: { x: 17, y: 650, width: 414, height: 43 },
        // UIA points to its owner by the dump's z/index, as the real file does.
        window: 3,
      },
      {
        name: '스크린샷이 아니라, 맥락을 캡처하세요.',
        control_type: 'Text',
        automation_id: '',
        class_name: '',
        bounds: { x: 132, y: 402, width: 921, height: 139 },
        display: 1,
        window: 4,
      },
    ],
  }
  const packSession = new ContextSession('ctx-pack-210107', {
    displays: [
      // This display sits at virtual x=-1200 in the manifest. All candidate
      // coordinates must nevertheless remain LOCAL snapshot pixels.
      { index: 1, focused: false, width: 1200, height: 1920 },
      { index: 2, focused: true, width: 3840, height: 2160 },
    ],
    replayDurationMs: PACK_END,
    observation: dump,
    dropped: false,
  })
  packSession.adoptAll(
    [4937, 5243, 5937, 6243, PACK_END].map((tMs) => ({
      tMs,
      windows: packWindows(),
      elements: [],
    })),
  )

  const displayGeometry = [
    { index: 1, width: 1200, height: 1920, pixelsPerDip: 1 },
    { index: 2, width: 3840, height: 2160, pixelsPerDip: 1.5 },
  ]
  const rectEq = (a, b) =>
    a?.x === b.x && a?.y === b.y && a?.width === b.width && a?.height === b.height

  async function exactControlAt(timeMs, display, width, height, point, expected) {
    const frame = await packSession.frameAt(timeMs)
    const slice = frame.displays.find((d) => d.display === display)
    const index = ObjectIndex.build(
      slice?.candidates ?? [],
      slice?.surfaces ?? [],
      slice?.coverage ?? [],
      frame.claims,
      width,
      height,
    )
    const picked = index.pick(point.x, point.y)
    const track =
      picked?.surface == null ? null : packSession.trackOf(picked.surface.surfaceId, timeMs, timeMs + 1000)
    const projected =
      picked?.level !== 'control' || picked.surface == null || track === null
        ? []
        : projectControlTrack(track.samples, {
            display,
            bounds: { x: picked.x, y: picked.y, width: picked.width, height: picked.height },
            surfaceBounds: picked.surface.bounds,
            displays: displayGeometry,
          })
    return { picked, track, projected, expected }
  }

  const orca = await exactControlAt(
    4937,
    2,
    3840,
    2160,
    { x: 200, y: 670 },
    { x: 17, y: 650, width: 414, height: 43 },
  )
  const chrome = await exactControlAt(
    5243,
    1,
    1200,
    1920,
    { x: 300, y: 450 },
    { x: 132, y: 402, width: 921, height: 139 },
  )

  check('Orca target metadata still identifies the child Button',
    orca.picked?.level === 'control' &&
      orca.picked.candidate.identity?.automation_id ===
        'worktree-list-option-project%3Agithub%3Ar2cuerdame%2Floopoffice')
  check('the raw Orca track is demonstrably the 1914x2082 OWNER window',
    rectEq(orca.track?.samples[0], { x: 9, y: 0, width: 1914, height: 2082 }),
    JSON.stringify(orca.track?.samples[0]))
  check('the stored Orca control track stays 17,650 414x43',
    orca.projected.length >= 2 && orca.projected.every((s) => rectEq(s, orca.expected)),
    JSON.stringify(orca.projected[0]))

  check('negative-X monitor target remains on display 1',
    chrome.picked?.level === 'control' && chrome.picked.candidate.display === 1,
    `level=${chrome.picked?.level}, display=${chrome.picked?.candidate.display}`)
  check('the raw Chrome track is demonstrably the 1200x1872 OWNER window',
    rectEq(chrome.track?.samples[0], { x: 0, y: 0, width: 1200, height: 1872 }),
    JSON.stringify(chrome.track?.samples[0]))
  check('negative-X display stores LOCAL 132,402 921x139 control bounds',
    chrome.projected.length >= 2 && chrome.projected.every((s) =>
      s.display === 1 && rectEq(s, chrome.expected)),
    JSON.stringify(chrome.projected[0]))

  const translated = projectControlTrack(
    [{ tMs: 6000, display: 2, x: 109, y: 20, width: 1914, height: 2082 }],
    {
      display: 2,
      bounds: orca.expected,
      surfaceBounds: { x: 9, y: 0, width: 1914, height: 2082 },
      displays: displayGeometry,
    },
  )
  check('a control follows owner translation without becoming owner-sized',
    rectEq(translated[0], { x: 117, y: 670, width: 414, height: 43 }),
    JSON.stringify(translated[0]))

  const crossedScale = projectControlTrack(
    // The same 1276x1388 DIP window fully visible on the 1x display.
    [{ tMs: 7000, display: 1, x: 400, y: 200, width: 1276, height: 1388 }],
    {
      display: 2,
      bounds: orca.expected,
      surfaceBounds: { x: 9, y: 0, width: 1914, height: 2082 },
      displays: displayGeometry,
    },
  )
  check('cross-display control geometry converts 1.5x pixels through DIPs to 1x',
    crossedScale[0]?.display === 1 &&
      rectEq(crossedScale[0], { x: 405, y: 633, width: 276, height: 29 }),
    JSON.stringify(crossedScale[0]))
}

console.log(`\nresult: ${failed === 0 ? 'OK' : 'BROKEN'} — ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
