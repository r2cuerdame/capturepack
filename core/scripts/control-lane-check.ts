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
import { EventEmitter } from 'node:events'
import { spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import {
  ControlLane,
  type ControlLaneOptions,
  type TrackedControl,
} from '../src/main/context/controlLane'
import {
  freezeContext,
  frozenObservations,
  startContextRuntime,
  stopContextRuntime,
  updateContextUiaEnabled,
} from '../src/main/context/runtime'
import { frozenRingObservations } from '../src/main/context/ringObservations'
import type { HostMonitor, SurfaceLane } from '../src/main/context/surfaceLane'
import type { SurfaceInfo } from '../src/shared/context/protocol'

/** The lane, with its child process replaced by lines we hand it directly. */
interface Injectable {
  onMessage(message: Record<string, unknown>): void
}

interface RetentionInspectable extends Injectable {
  prune(): void
  logs: Map<string, {
    trees: { tMs: number; dead?: number[] }[]
    moves: { tMs: number }[]
    deaths: { tMs: number; index: number }[]
  }>
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
// GitHub's Windows image can spend more than ten seconds starting the first
// powershell.exe while Defender scans the freshly checked-out scripts. The
// behavior under test still has its own <250 ms assertion below; this outer
// allowance measures process startup, not the wake path's latency.
const POWERSHELL_PROBE_TIMEOUT_MS = 30_000

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

const hwndNormalization = spawnSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(process.cwd(), 'scripts', 'uia-dump.ps1'),
  ],
  {
    encoding: 'utf8',
    env: { ...process.env, CAPTUREPACK_UIA_SELFTEST_HWND: '-1' },
    timeout: POWERSHELL_PROBE_TIMEOUT_MS,
    windowsHide: true,
  },
)
check(
  'UIA signed HWNDs are normalized to Lane S unsigned decimal identity',
  {
    status: hwndNormalization.status,
    stdout: hwndNormalization.stdout.trim(),
    stderr: hwndNormalization.stderr.trim(),
  },
  { status: 0, stdout: '4294967295', stderr: '' },
)

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly writes: string[] = []
  kills = 0

  constructor() {
    super()
    this.stdin.on('data', (chunk: Buffer) => this.writes.push(chunk.toString('utf8').trim()))
  }

  close(code: number | null): void {
    this.emit('close', code, null)
  }

  kill(): boolean {
    this.kills += 1
    return true
  }

  asChild(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams
  }
}

interface FakeRestart {
  callback: () => void
  delayMs: number
  cancelled: boolean
  fired: boolean
}

class FakeRestartScheduler {
  readonly jobs: FakeRestart[] = []

  readonly schedule: NonNullable<ControlLaneOptions['scheduleRestart']> = (callback, delayMs) => {
    const job: FakeRestart = { callback, delayMs, cancelled: false, fired: false }
    this.jobs.push(job)
    return job as unknown as ReturnType<typeof setTimeout>
  }

  readonly cancel: NonNullable<ControlLaneOptions['cancelRestart']> = (timer) => {
    ;(timer as unknown as FakeRestart).cancelled = true
  }

  active(): FakeRestart[] {
    return this.jobs.filter((job) => !job.cancelled && !job.fired)
  }

  fireNext(): void {
    const job = this.active()[0]
    if (job === undefined) throw new Error('no restart is scheduled')
    job.fired = true
    job.callback()
  }
}

async function main(): Promise<void> {
  console.log('lane A: a control that moves inside a still window\n')

  // MIXED-DPI NEGATIVE-ORIGIN DESKTOP — the exact rc.37 failure.
  //
  // On the reported desk the left display is 1x at x=-1200 and the primary is
  // 1.5x. An unaware Lane A read the true global control
  // (-580,51,153,24) as (-870,77,230,36); ringObservations then subtracted the
  // physical monitor origin and wrote (330,77,230,36), while the dump correctly
  // reopened it at (620,51,153,24). The helper must declare PMv2 before its
  // first UIA read, and must expose that mode in hello so the contract is
  // diagnosable instead of assumed.
  const trackerScript = readFileSync('scripts/uia-track.ps1', 'utf8')
  const initDpiAt = trackerScript.indexOf('[CapturePack.ControlLane]::InitDpi()')
  const firstInputAt = trackerScript.indexOf('[CapturePack.TrackInput]::Start()')
  check(
    'lane A declares per-monitor DPI before starting its resident loop',
    initDpiAt >= 0 && firstInputAt >= 0 && initDpiAt < firstInputAt,
    true,
  )
  check(
    'lane A hello reports its DPI contract',
    /"dpi":/.test(trackerScript),
    true,
  )
  const changeSignalAt = trackerScript.indexOf('[CapturePack.ControlLane]::StartChangeSignal()')
  check(
    'native change signaling starts before the resident request loop',
    changeSignalAt >= 0 && firstInputAt >= 0 && changeSignalAt < firstInputAt,
    true,
  )
  check(
    'lane A never subscribes to the process-crashing managed UIA event',
    trackerScript.includes('Automation.AddStructureChangedEventHandler'),
    false,
  )
  check(
    'lane A change detection uses a rooted out-of-context WinEvent message loop',
    /SetWinEventHook[\s\S]*WineventOutOfContext/.test(trackerScript) &&
      /GetMessage\(out message/.test(trackerScript) &&
      /GCHandle\.Alloc\(WinEventCallback\)/.test(trackerScript) &&
      /DrainChangeSignals/.test(trackerScript),
    true,
  )
  const callbackStart = trackerScript.indexOf('static void OnWinEvent(')
  const callbackEnd = trackerScript.indexOf('public static void DrainChangeSignals()')
  const callbackBody =
    callbackStart >= 0 && callbackEnd > callbackStart
      ? trackerScript.slice(callbackStart, callbackEnd)
      : ''
  check(
    'the WinEvent callback queues and wakes but performs no cross-thread UIA work',
    callbackBody !== '' &&
      !/AutomationElement|\.Walk\(|\.Refresh\(/.test(callbackBody),
    true,
  )
  check(
    'released UIA wrappers have a count-and-time-bounded collection policy',
    /CollectReleasedReferences\([\s\S]*ReferenceCollectionThreshold[\s\S]*ReferenceCollectionFloorMs/.test(
      trackerScript,
    ),
    true,
  )
  check(
    'dirty and stdin signals share one blocking wait instead of polling',
    /WaitHandle\.WaitAny\([\s\S]*WaitSignals/.test(trackerScript) &&
      /WaitSignals[\s\S]*Signal,\s*ControlLane\.ChangeWakeHandle/.test(trackerScript) &&
      /DirtySignals\[target\] = 0;[\s\S]*NotifyChangeWaiters\(\)/.test(trackerScript) &&
      /NextDirtyDueInMs\(\$ReWalkFloorMs\)/.test(trackerScript),
    true,
  )
  if (process.platform === 'win32') {
    const wakeProbe = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        'scripts/uia-track.ps1',
        '-WakeSelfTest',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: POWERSHELL_PROBE_TIMEOUT_MS,
        windowsHide: true,
      },
    )
    const wakeLine = wakeProbe.stdout
      .split(/\r?\n/)
      .find((line) => line.includes('"event":"wake-selftest"'))
    let wakeResult: { woke?: unknown; elapsedMs?: unknown } | null = null
    try {
      wakeResult =
        wakeLine === undefined
          ? null
          : JSON.parse(wakeLine) as { woke?: unknown; elapsedMs?: unknown }
    } catch {
      wakeResult = null
    }
    check('the wake self-test exits successfully', wakeProbe.status, 0)
    check('a dirty signal issued before Wait is not lost', wakeResult?.woke, true)
    check(
      'a dirty signal bypasses the two-second sleep ceiling',
      typeof wakeResult?.elapsedMs === 'number' && wakeResult.elapsedMs < 250,
      true,
    )
  }

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

  // A re-walk (native WinEvent marked this window dirty): NEW tree/version.
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

  // ---- RETENTION: A LONG-LIVED TREE IS A REAL CHECKPOINT -------------------
  //
  // A tree may live for hours while its held references emit thousands of
  // rectangles. The former prune predicate retained every one because its
  // ordinal was still current. Drive 50,000 changes across 100 seconds with a
  // one-second replay and the production two-second prune cadence: retained
  // records must depend on the time window, never on session age.
  console.log()
  console.log('lane A retention compaction')
  let compactNow = 0
  const compactLane = new ControlLane(() => compactNow, 1_000)
  const compact = compactLane as unknown as RetentionInspectable
  compact.onMessage({
    event: 'tree',
    h: '7777',
    v: 1,
    e: [rect(0, 0), rect(20, 20), rect(30, 30)],
  })
  let maximumMovesAfterPrune = 0
  for (let index = 1; index <= 50_000; index += 1) {
    compactNow = index * 2
    compact.onMessage({
      event: 'rects',
      h: '7777',
      v: 1,
      e: [[0, index, index, 100, 40]],
      ...(index === 10_000 ? { g: [1] } : {}),
      ...(index === 49_750 ? { g: [2] } : {}),
    })
    // 1,000 samples × 2 ms is the shipping two-second prune interval.
    if (index % 1_000 === 0) {
      compact.prune()
      const retained = compact.logs.get('7777')
      maximumMovesAfterPrune = Math.max(
        maximumMovesAfterPrune,
        retained?.moves.length ?? 0,
      )
    }
  }
  const retained = compact.logs.get('7777')
  check('50,000 moves compact to the one-second retained suffix', retained?.moves.length, 501)
  check('periodic pruning stays bounded instead of growing with session age',
    maximumMovesAfterPrune, 501)
  check('an old death is folded into the checkpoint tombstones',
    retained?.trees[0]?.dead, [1])
  check('only the death still inside retention remains as a delta',
    retained?.deaths.map((death) => [death.tMs, death.index]), [[99_500, 2]])
  const compactAt = (tMs: number): Array<[number, number]> =>
    compactLane.controlsAt(tMs)
      .find((entry) => entry.hwnd === '7777')
      ?.controls.map((control) => [control.x, control.y] as [number, number]) ?? []
  check('the cutoff frame restores the compacted move and ancient death exactly',
    compactAt(99_000), [[49_500, 49_500], [30, 30]])
  check('a retained death removes its element at its observed instant',
    compactAt(99_500), [[49_750, 49_750]])
  check('the latest retained movement still restores after compaction',
    compactAt(100_000), [[50_000, 50_000]])

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

  // The reported two-monitor geometry, end to end in the shared physical
  // virtual-desktop space. This complements the helper-contract assertion
  // above: the helper must emit this physical rectangle, and the existing
  // projection must then land on the exact snapshot pixels the final dump
  // uses. Both halves are pinned, so neither can silently change coordinate
  // spaces again.
  console.log()
  console.log('lane A mixed-DPI negative-origin projection')
  const mixedMonitors: HostMonitor[] = [
    {
      device: 'LEFT-1X',
      primary: false,
      bounds: { x: -1200, y: 0, width: 1200, height: 1920 },
    },
    {
      device: 'PRIMARY-1.5X',
      primary: true,
      bounds: { x: 0, y: 0, width: 3840, height: 2160 },
    },
  ]
  const mixedSurface = (): { surfaces: SurfaceInfo[] } => ({
    surfaces: [
      {
        surfaceId: 'chrome-left',
        hwnd: '918516',
        bounds: { x: -1200, y: 0, width: 1200, height: 900 },
        zOrder: 0,
        visible: true,
        minimized: false,
        foreground: true,
        executableName: 'chrome.exe',
        windowTitle: 'Chrome',
        className: 'Chrome_WidgetWin_1',
      },
    ],
  })
  const google: TrackedControl = {
    x: -580,
    y: 51,
    width: 153,
    height: 24,
    name: 'Google에 물어보기',
    controlType: 'Button',
    automationId: '',
    className: 'PageActionView',
  }
  const mixed = frozenRingObservations(
    mixedSurface,
    mixedMonitors,
    [
      { index: 1, focused: false, width: 1200, height: 1920 },
      { index: 2, focused: true, width: 3840, height: 2160 },
    ],
    1000,
    [1000],
    () => new Map([['918516', [google]]]),
  )
  const googleBounds = mixed[0]?.elements.find((element) => element.name === google.name)?.bounds
  check(
    'the rc.37 Google control lands at the dump/reopen geometry on display 1',
    googleBounds,
    { x: 620, y: 51, width: 153, height: 24 },
  )
  check(
    'the historical system-DPI-virtualized annotation geometry is gone',
    JSON.stringify(googleBounds) !== JSON.stringify({ x: 330, y: 77, width: 230, height: 36 }),
    true,
  )

  // ---- PROCESS LIFECYCLE: A DEAD TRACKER COMES BACK, STOP STAYS STOPPED ----
  //
  // No PowerShell and no OS input: spawn and time are both fake. This is the
  // production lifecycle state machine driven with the two events that caused
  // the reported loss — code 2 close, then an explicit application stop.
  console.log()
  console.log('lane A process lifecycle')
  const scheduler = new FakeRestartScheduler()
  const children: FakeChild[] = []
  let restartNow = 0
  const restarting = new ControlLane(() => restartNow, 30_000, {
    resolveTrackerScript: () => 'fake-uia-track.ps1',
    spawnTracker: () => {
      const child = new FakeChild()
      children.push(child)
      return child.asChild()
    },
    scheduleRestart: scheduler.schedule,
    cancelRestart: scheduler.cancel,
  })
  // The visible set is remembered even before the first process exists, then
  // replayed to every replacement. Without this a successful restart would be
  // alive but track zero windows until lane S happened to change its set.
  restarting.setVisible(['4242'], '4242')
  restarting.start()
  check('start creates exactly one tracker', children.length, 1)
  check(
    'the first tracker receives hello and the remembered visible set',
    children[0]?.writes.map((line) => JSON.parse(line).method),
    ['hello', 'track'],
  )
  restarting.start()
  check('a repeated start cannot create a duplicate process', children.length, 1)

  // A live helper emits status every 5 s even when no rectangles change. ACK
  // and status output both re-arm the 20 s silence ceiling; a cancelled timeout
  // whose callback was already queued cannot kill that healthy idle process.
  const watchdogScheduler = new FakeRestartScheduler()
  const watchdogRestartScheduler = new FakeRestartScheduler()
  const watchdogChildren: FakeChild[] = []
  const watched = new ControlLane(() => 0, 30_000, {
    resolveTrackerScript: () => 'fake-uia-track.ps1',
    spawnTracker: () => {
      const child = new FakeChild()
      watchdogChildren.push(child)
      return child.asChild()
    },
    scheduleRestart: watchdogRestartScheduler.schedule,
    cancelRestart: watchdogRestartScheduler.cancel,
    scheduleWatchdog: watchdogScheduler.schedule,
    cancelWatchdog: watchdogScheduler.cancel,
  })
  watched.start()
  const watchedChild = watchdogChildren[0] as FakeChild
  check(
    'a tracker starts with one 20 s silence watchdog',
    watchdogScheduler.active().map((job) => job.delayMs),
    [20_000],
  )
  const staleBeforeAck = watchdogScheduler.active()[0] as FakeRestart
  watchedChild.stdout.write(`${JSON.stringify({ id: 1, ok: true })}\n`)
  check(
    'an idle handshake ACK re-arms one watchdog',
    watchdogScheduler.active().map((job) => job.delayMs),
    [20_000],
  )
  staleBeforeAck.callback()
  check('a cancelled ACK-era watchdog cannot kill the helper', watchedChild.kills, 0)
  const staleBeforeStatus = watchdogScheduler.active()[0] as FakeRestart
  watchedChild.stdout.write(
    `${JSON.stringify({ event: 'status', dutyCycle: 0, tracked: 0, elements: 0 })}\n`,
  )
  check(
    'the normal idle status heartbeat re-arms one watchdog',
    watchdogScheduler.active().map((job) => job.delayMs),
    [20_000],
  )
  staleBeforeStatus.callback()
  check('a cancelled status-era watchdog cannot kill the helper', watchedChild.kills, 0)
  watchedChild.stdout.write(
    `${JSON.stringify({ event: 'error', message: 'provider warning' })}\n`,
  )
  watchedChild.stderr.write('fatal provider diagnostic\n')
  check(
    'the first stderr of this child replaces an earlier nonfatal protocol error',
    watched.status().lastError,
    'fatal provider diagnostic',
  )
  watchdogScheduler.fireNext()
  check('20 s with no output terminates the silent helper', watchedChild.kills, 1)
  check(
    'the silence failure is visible in lane status',
    watched.status().lastError,
    'tracker produced no output for 20000 ms',
  )
  watchedChild.close(null)
  check(
    'a watchdog termination uses the existing bounded restart',
    watchdogRestartScheduler.active().map((job) => job.delayMs),
    [250],
  )
  watched.stop()
  check('stop cancels the pending watchdog restart', watchdogRestartScheduler.active().length, 0)

  // UIA allocates unmanaged provider caches behind small managed wrappers. A
  // status heartbeat is the only reliable cross-process resource measurement;
  // retain all observations already received, but replace the helper before its
  // working set reaches the rc.37 failure range (~500 MB).
  const resourceScheduler = new FakeRestartScheduler()
  const resourceChildren: FakeChild[] = []
  const resourceBounded = new ControlLane(() => 0, 30_000, {
    resolveTrackerScript: () => 'fake-uia-track.ps1',
    spawnTracker: () => {
      const child = new FakeChild()
      resourceChildren.push(child)
      return child.asChild()
    },
    scheduleRestart: resourceScheduler.schedule,
    cancelRestart: resourceScheduler.cancel,
  })
  resourceBounded.setVisible(['4242'], '4242')
  resourceBounded.start()
  const resourceChild = resourceChildren[0] as FakeChild
  resourceChild.stdout.write(
    `${JSON.stringify({ event: 'status', ws: 384 * 1024 * 1024 })}\n`,
  )
  check('the 384 MB ceiling itself does not churn a healthy helper', resourceChild.kills, 0)
  resourceChild.stdout.write(
    `${JSON.stringify({ event: 'status', ws: 384 * 1024 * 1024 + 1 })}\n`,
  )
  check('one byte beyond the resource ceiling requests one replacement', resourceChild.kills, 1)
  resourceChild.stdout.write(
    `${JSON.stringify({ event: 'status', ws: 512 * 1024 * 1024 })}\n`,
  )
  check('repeated over-budget heartbeats cannot issue duplicate kills', resourceChild.kills, 1)
  check(
    'the resource replacement reason is observable',
    resourceBounded.status().lastError,
    'tracker working set exceeded 384 MB',
  )
  resourceChild.close(null)
  check(
    'the resource replacement uses the same bounded restart state machine',
    resourceScheduler.active().map((job) => job.delayMs),
    [250],
  )
  resourceScheduler.fireNext()
  check('resource recovery creates exactly one replacement', resourceChildren.length, 2)
  check(
    'resource recovery restores the remembered visible set',
    resourceChildren[1]?.writes.map((line) => JSON.parse(line).method),
    ['hello', 'track'],
  )
  resourceBounded.stop()

  // Repeated pre-protocol crashes walk the bounded backoff and then stay at its
  // 30 s ceiling. Duplicate close/start signals while a timer is pending must
  // not create another timer or process.
  const expectedDelays = [250, 1_000, 5_000, 15_000, 30_000, 30_000]
  for (const delayMs of expectedDelays) {
    const child = children[children.length - 1] as FakeChild
    child.close(2)
    child.close(2)
    restarting.start()
    check(
      `code 2 schedules one ${String(delayMs)} ms restart`,
      scheduler.active().map((job) => job.delayMs),
      [delayMs],
    )
    const before = children.length
    scheduler.fireNext()
    check('the scheduled restart creates one replacement', children.length, before + 1)
    check(
      'the replacement receives the remembered visible set',
      children[children.length - 1]?.writes.map((line) => JSON.parse(line).method),
      ['hello', 'track'],
    )
  }

  // An ACK proves only that PowerShell reached its request loop. A status line
  // proves only that JSON still flows. Neither is a control observation, so a
  // helper that crashes immediately after either must remain at the ceiling
  // instead of becoming a 250 ms spawn storm.
  const acknowledged = children[children.length - 1] as FakeChild
  acknowledged.stdout.write(`${JSON.stringify({ id: 1, ok: true })}\n`)
  acknowledged.close(2)
  check(
    'a handshake ACK cannot reset a crash storm',
    scheduler.active().map((job) => job.delayMs),
    [30_000],
  )
  scheduler.fireNext()
  const statusOnly = children[children.length - 1] as FakeChild
  statusOnly.stdout.write(`${JSON.stringify({ event: 'status', tracked: 1 })}\n`)
  statusOnly.close(2)
  check(
    'a status line cannot reset a crash storm',
    scheduler.active().map((job) => job.delayMs),
    [30_000],
  )
  scheduler.fireNext()
  const malformed = children[children.length - 1] as FakeChild
  malformed.stdout.write(`${JSON.stringify({ event: 'tree', h: '', v: 1, e: [rect(1, 1)] })}\n`)
  malformed.close(2)
  check(
    'a malformed tree cannot reset a crash storm',
    scheduler.active().map((job) => job.delayMs),
    [30_000],
  )
  scheduler.fireNext()

  // A valid tree proves the tracker reached UIA, but an immediate death is
  // still the same crash loop. It must also survive one maximum-backoff window
  // before the failure budget is forgiven.
  const observedButShort = children[children.length - 1] as FakeChild
  observedButShort.stdout.write(
    `${JSON.stringify({ event: 'tree', h: '4242', v: 1, e: [rect(1, 1)] })}\n`,
  )
  restartNow = 29_999
  observedButShort.close(2)
  check(
    'a valid observation without a healthy lifetime keeps the ceiling',
    scheduler.active().map((job) => job.delayMs),
    [30_000],
  )
  scheduler.fireNext()
  const healthy = children[children.length - 1] as FakeChild
  restartNow = 30_000
  healthy.stdout.write(
    `${JSON.stringify({ event: 'tree', h: '4242', v: 1, e: [rect(2, 2)] })}\n`,
  )
  restartNow = 60_000
  healthy.close(2)
  check(
    'a valid observation plus 30 s healthy lifetime resets to 250 ms',
    scheduler.active().map((job) => job.delayMs),
    [250],
  )
  const cancelled = scheduler.active()[0] as FakeRestart
  const beforeStop = children.length
  restarting.stop()
  check('stop cancels a pending restart', scheduler.active().length, 0)
  // Even a racy timer callback already queued by the event loop is harmless:
  // desiredRunning is false, so it cannot spawn.
  cancelled.callback()
  check('a cancelled callback cannot create a tracker after stop', children.length, beforeStop)

  // Stopping a currently running child is the other side of the race: its
  // eventual non-zero close is shutdown completion, not a restart request.
  const stopScheduler = new FakeRestartScheduler()
  const stoppedChildren: FakeChild[] = []
  const stopped = new ControlLane(() => 0, 30_000, {
    resolveTrackerScript: () => 'fake-uia-track.ps1',
    spawnTracker: () => {
      const child = new FakeChild()
      stoppedChildren.push(child)
      return child.asChild()
    },
    scheduleRestart: stopScheduler.schedule,
    cancelRestart: stopScheduler.cancel,
  })
  stopped.start()
  const stoppingChild = stoppedChildren[0] as FakeChild
  stopped.stop()
  stoppingChild.close(2)
  check('a child closing after stop schedules no restart', stopScheduler.active().length, 0)
  check('stop leaves only the original process', stoppedChildren.length, 1)

  // ---- LIVE SETTINGS: OFF IS A HARD OUTPUT AND CAPTURE BOUNDARY ------------
  //
  // Drive runtime.ts through the same public function settingsWindow.ts calls.
  // Lane S and PowerShell are injected, but the runtime, timeline, frozen-ring
  // conversion and ControlLane process lifecycle are the shipping code.
  console.log()
  console.log('lane A live OFF/ON boundary')
  const runtimeChildren: FakeChild[] = []
  const runtimeRestartScheduler = new FakeRestartScheduler()
  const runtimeWatchdogScheduler = new FakeRestartScheduler()
  const runtimeState: { controls?: ControlLane } = {}
  let runtimeVisible = { hwnds: ['4242'] as readonly string[], focusHwnd: '4242' as string | null }
  startContextRuntime({
    replayMs: 1_000,
    uiaEnabled: true,
    testing: {
      platform: 'win32',
      readVisibleWindows: () => runtimeVisible,
      createControls: (readNowMs, retentionMs) => {
        const controls = new ControlLane(readNowMs, retentionMs, {
          resolveTrackerScript: () => 'fake-uia-track.ps1',
          spawnTracker: () => {
            const child = new FakeChild()
            runtimeChildren.push(child)
            return child.asChild()
          },
          scheduleRestart: runtimeRestartScheduler.schedule,
          cancelRestart: runtimeRestartScheduler.cancel,
          scheduleWatchdog: runtimeWatchdogScheduler.schedule,
          cancelWatchdog: runtimeWatchdogScheduler.cancel,
        })
        runtimeState.controls = controls
        return controls
      },
      createSurfaceLane: (clock, timeline) => {
        timeline.append({
          timeMs: clock.nowMs(),
          windows: [
            {
              hwnd: '4242',
              ownerHwnd: '0',
              processId: 42,
              zOrder: 0,
              bounds: { x: 0, y: 0, width: 800, height: 600 },
              clientBounds: { x: 0, y: 0, width: 800, height: 600 },
              visible: true,
              minimized: false,
              foreground: true,
              cloaked: false,
              executableName: 'app.exe',
              windowTitle: 'Bench',
              className: 'BenchCls',
            },
          ],
        })
        return {
          start: () => {},
          stop: () => {},
          monitors: () => MONITORS,
          clockErrorMs: () => 0,
        } as unknown as SurfaceLane
      },
    },
  })
  const liveControls = runtimeState.controls
  const firstRuntimeChild = runtimeChildren[0]
  check('runtime startup creates Lane A when UIA is on', runtimeChildren.length, 1)
  check(
    'runtime startup seeds the visible handles before Lane A starts',
    firstRuntimeChild?.writes.map((line) => {
      const message = JSON.parse(line) as { method?: string; params?: unknown }
      return [message.method, message.params ?? null]
    }),
    [
      ['hello', null],
      ['track', { hwnds: ['4242'], focus: '4242' }],
    ],
  )
  if (liveControls !== undefined && firstRuntimeChild !== undefined) {
    firstRuntimeChild.stdout.write(
      `${JSON.stringify({ event: 'tree', h: '4242', v: 1, e: [rect(20, 20)] })}\n`,
    )
    check('the running lane caches a control observation', liveControls.hasObservations, true)
  }
  // Date.now() is integer-ms while the lane files on hrtime. Place the
  // synthetic capture one second later so this check cannot depend on whether
  // the two reads happened within the same wall-clock millisecond.
  const runtimeFreezeId = freezeContext(Date.now() + 1_000, 0)
  const runtimeTargets = [{ index: 1, focused: true, width: 1920, height: 1080 }]
  const observationsWhileOn =
    runtimeFreezeId === null ? [] : frozenObservations(runtimeFreezeId, runtimeTargets, 0)
  check(
    'a frozen capture can include Lane A while UIA is on',
    observationsWhileOn.flatMap((observation) => observation.elements.map((element) => element.name)),
    ['Save'],
  )

  updateContextUiaEnabled(false)
  check(
    'OFF sends the running helper a shutdown request',
    firstRuntimeChild?.writes.map((line) => JSON.parse(line).method).at(-1),
    'shutdown',
  )
  check('OFF detaches Lane A synchronously', liveControls?.status().running, false)
  check('OFF clears every cached control observation', liveControls?.hasObservations, false)
  if (liveControls !== undefined && firstRuntimeChild !== undefined) {
    firstRuntimeChild.stdout.write(
      `${JSON.stringify({ event: 'tree', h: '4242', v: 2, e: [rect(999, 999)] })}\n`,
    )
    firstRuntimeChild.stderr.write('late shutdown noise\n')
  }
  check('stdout arriving after OFF cannot refill the cache', liveControls?.hasObservations, false)
  check('stderr arriving after OFF cannot refill lane status', liveControls?.status().lastError, null)

  // Put one observation behind the gate by calling the parser directly. This
  // cannot happen through the detached child (proved above); it makes the next
  // assertion independent of clearObservations, so removing the runtime's
  // controlsEnabled guard would make the check fail.
  if (liveControls !== undefined) {
    ;(liveControls as unknown as Injectable).onMessage({
      event: 'tree',
      h: '4242',
      v: 99,
      e: [rect(30, 30)],
    })
  }
  check('the frozen-output sentinel exists behind the disabled gate', liveControls?.hasObservations, true)
  const observationsWhileOff =
    runtimeFreezeId === null ? [] : frozenObservations(runtimeFreezeId, runtimeTargets, 0)
  check(
    'a frozen capture cannot include Lane A while UIA is off',
    observationsWhileOff.flatMap((observation) => observation.elements.map((element) => element.name)),
    [],
  )
  liveControls?.clearObservations()

  runtimeVisible = { hwnds: ['9002'], focusHwnd: '9002' }
  updateContextUiaEnabled(true)
  const secondRuntimeChild = runtimeChildren[1]
  check('ON immediately creates a fresh helper without waiting for the old close', runtimeChildren.length, 2)
  check(
    'ON seeds the fresh helper with the currently visible handles',
    secondRuntimeChild?.writes.map((line) => {
      const message = JSON.parse(line) as { method?: string; params?: unknown }
      return [message.method, message.params ?? null]
    }),
    [
      ['hello', null],
      ['track', { hwnds: ['9002'], focus: '9002' }],
    ],
  )
  firstRuntimeChild?.stdout.write(
    `${JSON.stringify({ event: 'tree', h: '4242', v: 3, e: [rect(777, 777)] })}\n`,
  )
  check('old stdout stays ignored after ON starts its replacement', liveControls?.hasObservations, false)
  secondRuntimeChild?.stdout.write(
    `${JSON.stringify({ event: 'tree', h: '4242', v: 1, e: [rect(40, 40)] })}\n`,
  )
  check('the replacement accepts new observations', liveControls?.hasObservations, true)
  stopContextRuntime()

  // A replacement begins its remote tree versions at 1 again. Past samples
  // must keep the first process's tree/deltas, while future samples use the
  // replacement's tree and must not inherit a same-numbered old delta.
  const recoveryScheduler = new FakeRestartScheduler()
  const recoveryChildren: FakeChild[] = []
  let recoveryNow = 100
  const recovering = new ControlLane(() => recoveryNow, 30_000, {
    resolveTrackerScript: () => 'fake-uia-track.ps1',
    spawnTracker: () => {
      const child = new FakeChild()
      recoveryChildren.push(child)
      return child.asChild()
    },
    scheduleRestart: recoveryScheduler.schedule,
    cancelRestart: recoveryScheduler.cancel,
  })
  recovering.setVisible(['9001'], '9001')
  recovering.start()
  const original = recoveryChildren[0] as FakeChild
  original.stdout.write(
    `${JSON.stringify({ event: 'tree', h: '9001', v: 1, e: [rect(10, 10)] })}\n`,
  )
  recoveryNow = 110
  original.stdout.write(
    `${JSON.stringify({ event: 'rects', h: '9001', v: 1, e: [[0, 15, 15, 100, 40]] })}\n`,
  )
  recoveryNow = 120
  original.close(2)
  check(
    'a dead tracker schedules automatic recovery',
    recoveryScheduler.active().map((job) => job.delayMs),
    [250],
  )
  recoveryScheduler.fireNext()
  check('automatic recovery creates one replacement', recoveryChildren.length, 2)
  check(
    'the replacement is told to track the remembered windows',
    recoveryChildren[1]?.writes.map((line) => JSON.parse(line).method),
    ['hello', 'track'],
  )
  recoveryNow = 200
  const replacement = recoveryChildren[1] as FakeChild
  replacement.stdout.write(
    `${JSON.stringify({ event: 'tree', h: '9001', v: 1, e: [rect(30, 30)] })}\n`,
  )
  const recoveredAt = (tMs: number): Array<[number, number]> =>
    recovering.controlsAt(tMs).flatMap((entry) =>
      entry.hwnd === '9001'
        ? entry.controls.map((control) => [control.x, control.y] as [number, number])
        : [],
    )
  check('recovery keeps the pre-crash tree in the past', recoveredAt(105), [[10, 10]])
  check('recovery keeps the pre-crash delta in the past', recoveredAt(150), [[15, 15]])
  check('recovery serves the replacement tree in the future', recoveredAt(250), [[30, 30]])
  recovering.stop()
  replacement.close(0)

  console.log(
    `\nlane A status: ${lane.status().trees} tree(s), ${lane.status().moves} move(s), ` +
      `${lane.status().deaths} death(s)`,
  )
  console.log(failures === 0 ? '\nPASS — controls are tracked, versioned and honest about death' : `\nFAIL — ${failures} assertion(s)`)
  process.exitCode = failures === 0 ? 0 : 1
}

void main()
