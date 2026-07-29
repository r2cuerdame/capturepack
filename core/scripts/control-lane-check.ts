// DO TRACKED CONTROLS REACH THE RING, AND DO THEY RESTORE AT THE RIGHT TIME?
// (#111, lane A)
//
// WHAT THIS EXISTS TO CATCH. Before lane A, a control's rectangle was read once
// — at the capture instant — and every earlier frame was served that reading,
// translated by how far its WINDOW had moved (provider.ts `anchored`). Right
// for a dragged window; wrong for a control that moved INSIDE its window, which
// is what a scroll, a resize or a layout change does. This drives the real
// ControlLane with the real tracker protocol and asserts that a control which
// moved inside a still window is restored where it ACTUALLY WAS at each time —
// not where it was at the dump.
//
// It also pins the three failure modes the measurements said would bite:
//  - a delta tagged with a tree VERSION the lane no longer holds must be
//    ignored, never applied to a different tree,
//  - a dead reference must REMOVE its control from that moment on, never freeze
//    it where it last was (measured: 4.4% of held refs die within 50 s with
//    nothing driven at all),
//  - a control's position at a time BEFORE its first tree is not invented.
//
// Run: npm run check:controls
import { ControlLane, type TrackedControl } from '../src/main/context/controlLane'
import { frozenRingObservations } from '../src/main/context/ringObservations'
import type { HostMonitor } from '../src/main/context/surfaceLane'
import type { SurfaceInfo } from '../src/shared/context/protocol'

/** The lane, with its child process replaced by lines we hand it directly. */
interface Injectable {
  onMessage(message: Record<string, unknown>): void
}

let now = 0
const lane = new ControlLane(() => now, 30_000)
// The tracker is a child process; this check is about the PROTOCOL and the
// replay, so the lines are handed straight to the parser the child would feed.
const inject = (message: Record<string, unknown>): void => {
  ;(lane as unknown as Injectable).onMessage(message)
}

const rect = (x: number, y: number) => ({ b: [x, y, 100, 40], n: 'Save', c: 'Button', a: 'save', k: 'Btn' })

let failures = 0
function check(what: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) console.log(`         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`)
}

const at = (tMs: number): Array<[number, number]> => {
  const entry = lane.controlsAt(tMs).find((e) => e.hwnd === '4242')
  return entry === undefined ? [] : entry.controls.map((c) => [c.x, c.y] as [number, number])
}

async function main(): Promise<void> {
  console.log('lane A: a control that moves inside a still window\n')

  // t=100: the window is walked. Two controls.
  now = 100
  inject({ event: 'tree', h: '4242', v: 1, e: [rect(10, 20), rect(10, 80)] })

  // t=200 and t=300: the FIRST control scrolls up. The window never moved, so
  // anchoring could not have found this — only a re-read can.
  now = 200
  inject({ event: 'rects', h: '4242', v: 1, e: [[0, 10, 5, 100, 40]] })
  now = 300
  inject({ event: 'rects', h: '4242', v: 1, e: [[0, 10, -30, 100, 40]] })

  check('at t=100 both controls sit where they were walked', at(100), [[10, 20], [10, 80]])
  check('at t=250 the scrolled control is at its t=200 reading', at(250), [[10, 5], [10, 80]])
  check('at t=1000 it is at its latest reading', at(1000), [[10, -30], [10, 80]])
  check('at t=50, before the walk, nothing is invented', at(50), [])

  // A dead reference: the second control's element goes away at t=400.
  now = 400
  inject({ event: 'rects', h: '4242', v: 1, e: [], g: [1] })
  check('after it dies the control is gone, not frozen', at(500), [[10, -30]])
  check('before it died it is still there', at(350), [[10, -30], [10, 80]])

  // A re-walk (StructureChanged fired): NEW tree, new version, both back.
  now = 600
  inject({ event: 'tree', h: '4242', v: 2, e: [rect(70, 20), rect(70, 80)] })
  check('a re-walk replaces the tree wholesale', at(700), [[70, 20], [70, 80]])
  check('the older tree still answers for older times', at(500), [[10, -30]])

  // A STALE delta — tagged v1, arriving after the v2 walk. Applying it would
  // move the wrong control: index 0 means something different in each tree.
  now = 700
  inject({ event: 'rects', h: '4242', v: 1, e: [[0, 999, 999, 100, 40]] })
  check('a delta for a superseded tree is ignored', at(800), [[70, 20], [70, 80]])

  // And a live one for the current tree still applies.
  now = 800
  inject({ event: 'rects', h: '4242', v: 2, e: [[1, 70, 130, 100, 40]] })
  check('a delta for the current tree applies', at(900), [[70, 20], [70, 130]])

  // ---- END TO END: do they reach ContextObservation.elements? --------------
  //
  // Everything above is the lane's own replay. This is the seam that actually
  // matters: frozenRingObservations is what the editor's ContextBuffer is built
  // from, and a control that does not arrive HERE is a control no pick can ever
  // reach, however correctly the lane tracked it.
  console.log()
  console.log('lane A -> the ring the editor reads')
  const MONITORS: HostMonitor[] = [
    { device: 'BENCH', primary: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
  ]
  const surfaceAt = (): { surfaces: SurfaceInfo[] } => ({
    surfaces: [
      {
        surfaceId: 's1',
        hwnd: '4242',
        // The window stands STILL the whole time — so anything that moves in
        // the output moved because it was RE-READ, never because it was
        // translated by its window. That is the whole point of this lane.
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        zOrder: 0,
        visible: true,
        minimized: false,
        foreground: true,
        executableName: 'app.exe',
        windowTitle: 'Bench',
        className: 'BenchCls',
      },
    ],
  })
  const observations = frozenRingObservations(
    surfaceAt,
    MONITORS,
    [{ index: 1, focused: true, width: 1920, height: 1080 }],
    1000,
    [100, 250, 500, 900],
    (packTMs) => {
      const map = new Map<string, readonly TrackedControl[]>()
      for (const entry of lane.controlsAt(packTMs)) map.set(entry.hwnd, entry.controls)
      return map
    },
  )
  const seen = observations.map((o) => ({
    t: o.tMs,
    e: o.elements.map((el) => [el.bounds.x, el.bounds.y] as [number, number]),
  }))
  check('each observation carries the controls live at ITS OWN time', seen, [
    { t: 100, e: [[10, 20], [10, 80]] },
    { t: 250, e: [[10, 5], [10, 80]] },
    // Two behaviours of the surrounding code are pinned here rather than
    // asserted away, because both surprised this check when it was written:
    //
    // t=500 has ONE control, not none. The scrolled one is at y=-30 by now —
    // partly above the snapshot — and `clipToSpace` CLAMPS rather than drops,
    // so it survives as the 10 px of itself that is still on screen. That is
    // right: a control half off the top edge is still half visible, and
    // whether a 10 px sliver is worth OFFERING is the editor index's question
    // (MIN_SIDE, MIN_VISIBLE_SIDE), not this lane's. The other control died at
    // t=400 and is correctly absent.
    { t: 500, e: [[10, 0]] },
    { t: 900, e: [[70, 20], [70, 130]] },
    // frozenRingObservations always appends the CAPTURE INSTANT when no sample
    // landed exactly on it — it is the one moment the user is guaranteed to
    // look at. It carries the same controls as t=900, which is the last thing
    // the lane read before it.
    { t: 1000, e: [[70, 20], [70, 130]] },
  ])
  check(
    'every control names the window it was walked from',
    observations.find((o) => o.tMs === 900)?.elements.map((el) => el.window),
    [0, 0],
  )
  check(
    'the window reports that its tree WAS collected',
    observations[0]?.windows.map((w) => w.tree),
    ['collected'],
  )

  console.log(
    `\nlane A status: ${lane.status().trees} tree(s), ${lane.status().moves} move(s), ` +
      `${lane.status().deaths} death(s)`,
  )
  console.log(failures === 0 ? '\nPASS — controls are tracked, versioned and honest about death' : `\nFAIL — ${failures} assertion(s)`)
  process.exitCode = failures === 0 ? 0 : 1
}

void main()
