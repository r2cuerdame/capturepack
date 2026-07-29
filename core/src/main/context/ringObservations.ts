// The bridge between the surface ring Core RECORDS and the frame the editor
// INDEXES — the seam that made object picking answer only at the capture
// instant.
//
// WHAT WAS WRONG. Two halves of the temporal system were built in parallel from
// one design document, and each assumed the other side existed. The recording
// half fills a ring at 10 Hz for the whole replay and freezes it at capture
// (`runtime.ts`, `timeline.ts`); the answering half restores a surface stack at
// the requested time and mints Core's WINDOW rung from it (`session.ts`). Both
// were correct. Nothing carried the ring across: `openContextSession` was handed
// a single capture-instant observation, so `adoptAll` filed the session as
// `single-instant` and every time except the last restored nothing. Three
// hundred and sixty-four recorded samples were frozen and never read, and the
// user reported exactly that — "context 창 선택이 마지막 정보에만 맞아".
//
// THE ONE REAL DIFFICULTY IS SPACE. The ring stores rectangles in
// VIRTUAL-DESKTOP PHYSICAL PIXELS (`RectSpace`, the protocol's normative
// space). An annotation's coordinates are one display's SNAPSHOT pixels
// (SPEC 8.2), and a box belongs to exactly one screen (SPEC 8.8). So every
// surface has to be placed on the display it is actually on and translated into
// that display's image.
//
// AND THE PART THAT IS NOT INHERITED. `uia.ts` carries forty lines of DPI
// un-virtualisation because the UIA helper is not per-monitor DPI aware:
// Windows hands such a process rectangles scaled by (system DPI / monitor DPI),
// and NOT uniformly across monitors. `scripts/context-host.ps1` declares
// per-monitor-v2 awareness as the first thing it does, so its rectangles are
// physical by construction on every monitor whatever the scale factors are.
// None of that correction belongs here, and copying it would introduce the very
// error it exists to undo.
import type { SurfaceInfo } from '../../shared/context/protocol'
import type { EditorUiaElement, EditorUiaWindow } from '../../shared/ipc'
import type { HostMonitor } from './surfaceLane'
import type { ContextObservation } from './buffer'
import type { ContextDisplayTarget } from './session'
import type { TrackedControl } from './controlLane'

/**
 * The fallback cadence for reading the ring back, when the caller cannot say
 * WHEN it actually sampled.
 *
 * Prefer the real sample times (#87). A grid — any grid — lands between two
 * samples and asks for a rectangle that was never observed, and the answer is
 * an interpolation dressed as a reading. The ring now samples once per captured
 * frame, so its own times are exactly the moments a pack can show.
 */
const READ_INTERVAL_MS = 100

/** Shared empty lookup, so the no-lane-A path allocates nothing per observation. */
const EMPTY_CONTROLS: ReadonlyMap<string, readonly TrackedControl[]> = new Map()

/** A display's mapping space: which host monitor it is, and how to get onto its image. */
interface DisplaySpace {
  index: number
  focused: boolean
  /** The snapshot's own size, which a rectangle on it is clipped to. */
  width: number
  height: number
  monitor: HostMonitor
  toSnapshot: (bounds: SurfaceInfo['bounds']) => EditorUiaWindow['bounds']
}

/**
 * The host monitor that IS this display.
 *
 * Matched by SIZE in physical pixels rather than by name or order: the host
 * enumerates in Windows' order and Electron in its own, device names are not
 * stable across a hot-plug, and the one thing both agree on is how many pixels
 * a screen has. A display whose physical size matches no monitor gets no space
 * and its surfaces are left where they were, which is honest — a rectangle
 * placed on a guess is worse than one that was never placed.
 */
function monitorFor(
  monitors: readonly HostMonitor[],
  target: ContextDisplayTarget,
  taken: ReadonlySet<HostMonitor>,
): HostMonitor | null {
  let best: HostMonitor | null = null
  let bestError = Number.POSITIVE_INFINITY
  for (const monitor of monitors) {
    if (taken.has(monitor)) continue
    const error =
      Math.abs(monitor.bounds.width - target.width) + Math.abs(monitor.bounds.height - target.height)
    if (error < bestError) {
      best = monitor
      bestError = error
    }
  }
  // A few pixels of slack absorbs a rounding difference between the snapshot
  // and the monitor rect; anything larger is a different screen.
  return best !== null && bestError <= 4 ? best : null
}

function buildSpaces(
  monitors: readonly HostMonitor[],
  targets: readonly ContextDisplayTarget[],
): DisplaySpace[] {
  const taken = new Set<HostMonitor>()
  const spaces: DisplaySpace[] = []
  for (const target of targets) {
    if (target.width <= 0 || target.height <= 0) continue
    const monitor = monitorFor(monitors, target, taken)
    if (monitor === null) continue
    taken.add(monitor)
    // Translate by the monitor's own origin, then scale onto the snapshot. The
    // scale is 1 whenever the snapshot is the monitor's native size, which is
    // the normal case; it is not assumed to be.
    const sx = target.width / monitor.bounds.width
    const sy = target.height / monitor.bounds.height
    spaces.push({
      index: target.index,
      focused: target.focused,
      width: target.width,
      height: target.height,
      monitor,
      toSnapshot: (b) => ({
        x: Math.round((b.x - monitor.bounds.x) * sx),
        y: Math.round((b.y - monitor.bounds.y) * sy),
        width: Math.max(0, Math.round(b.width * sx)),
        height: Math.max(0, Math.round(b.height * sy)),
      }),
    })
  }
  return spaces
}

/** Every display the surface overlaps at all, in board order. */
function spacesOver(
  spaces: readonly DisplaySpace[],
  bounds: SurfaceInfo['bounds'],
): DisplaySpace[] {
  return spaces.filter((space) => overlapArea(bounds, space.monitor.bounds) > 0)
}

/** The surface in one display's snapshot pixels, clipped to it; null if none of it is there. */
function clipToSpace(
  space: DisplaySpace,
  bounds: SurfaceInfo['bounds'],
): EditorUiaWindow['bounds'] | null {
  const b = space.toSnapshot(bounds)
  const x = Math.max(0, b.x)
  const y = Math.max(0, b.y)
  const right = Math.min(space.width, b.x + b.width)
  const bottom = Math.min(space.height, b.y + b.height)
  if (right <= x || bottom <= y) return null
  return { x, y, width: right - x, height: bottom - y }
}

function overlapArea(a: SurfaceInfo['bounds'], b: HostMonitor['bounds']): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * The display a surface is ON: the one it overlaps most.
 *
 * Overlap rather than the origin or the centre, because a window is routinely
 * dragged half off a screen and the visible half is the one worth picking on.
 * A surface touching no captured display belongs to none of them.
 */
function spaceOf(spaces: readonly DisplaySpace[], bounds: SurfaceInfo['bounds']): DisplaySpace | null {
  let best: DisplaySpace | null = null
  let bestArea = 0
  for (const space of spaces) {
    const area = overlapArea(bounds, space.monitor.bounds)
    if (area > bestArea) {
      best = space
      bestArea = area
    }
  }
  return best
}

/**
 * One ring sample as the observation the editor's session already understands.
 *
 * `hasControls` is FALSE and `tree` is `'skipped'` on purpose: this is Core's
 * window rung, and Core does not read control trees. Claiming otherwise would
 * make the editor promise a refinement that will never arrive — SPEC 11.3's
 * "silence is not absence" cuts both ways, and "I never looked" is the true
 * statement here. A provider that DID look contributes its controls separately,
 * through the frame's provider candidates.
 */
function observationOf(
  tMs: number,
  surfaces: readonly SurfaceInfo[],
  spaces: readonly DisplaySpace[],
  controlsByHwnd: ReadonlyMap<string, readonly TrackedControl[]>,
): ContextObservation {
  const windows: EditorUiaWindow[] = []
  const elements: EditorUiaElement[] = []
  for (const surface of surfaces) {
    if (surface.minimized || !surface.visible) continue
    const tracked = surface.hwnd === undefined ? [] : (controlsByHwnd.get(surface.hwnd) ?? [])
    // ONE ENTRY PER SCREEN THE SURFACE IS ON (#103).
    //
    // A window dragged between monitors is visible on BOTH, and a single entry
    // could only ever describe one of them — so the half on the other screen
    // was unmarked, both for picking and for the box that follows it. Here the
    // surface still has its virtual-desktop rectangle and every display's
    // mapping is in hand, which is the only place the split can be made
    // correctly: each entry is that screen's own snapshot pixels, clipped to
    // that screen, because the part past an edge is in no image.
    //
    // They share `surface_id` and `hwnd`, so everything downstream knows they
    // are ONE object: one box, one number, drawn wherever it can be seen.
    for (const space of spacesOver(spaces, surface.bounds)) {
    const clipped = clipToSpace(space, surface.bounds)
    if (clipped === null) continue
    windows.push({
      // Carried, not re-derived (#90): this id is stable across the whole
      // session, and re-deriving one from name and list order is what let two
      // same-titled windows trade identities when their order changed.
      surface_id: surface.surfaceId,
      // The OS handle, so the control dump and this ring can be joined on the
      // one value they both observe rather than on descriptions they spell
      // differently (#97).
      ...(surface.hwnd === undefined ? {} : { hwnd: surface.hwnd }),
      title: surface.windowTitle ?? '',
      process: surface.executableName ?? '',
      class_name: surface.className ?? '',
      bounds: clipped,
      display: space.index,
      focused: surface.foreground,
      z: surface.zOrder,
      hasControls: tracked.length > 0,
      tree: tracked.length > 0 ? 'collected' : 'skipped',
    })
    // LANE A'S CONTROLS, PLACED IN THE SAME SPACE AS THEIR WINDOW (#111).
    //
    // The tracker reports physical virtual-desktop pixels, exactly as lane S
    // does, so a control maps onto a snapshot through the same space its own
    // window was just mapped through — never through a space chosen for it
    // separately, which is how a control and its window end up disagreeing
    // about which screen they are on.
    //
    // A control clipped to nothing on this screen is not emitted HERE, which
    // is not the same as dropping it: the window loop above runs once per
    // screen the window is on, so a control on the other half of a straddling
    // window is emitted on that screen's pass instead.
    for (const control of tracked) {
      const box = clipToSpace(space, control)
      if (box === null) continue
      elements.push({
        name: control.name,
        control_type: control.controlType,
        automation_id: control.automationId,
        class_name: control.className,
        bounds: box,
        display: space.index,
        // Which window this control was walked from. `candidatesOf` resolves a
        // control's owner by this number, and an owner it cannot resolve is a
        // control it silently drops.
        window: surface.zOrder,
      })
    }
    }
  }
  return { tMs, windows, elements }
}

/**
 * Reads the frozen ring back as the observations a context session adopts.
 *
 * `surfacesAt` is the public door: it already converts pack time to session
 * time and refuses a time the freeze does not hold, so this walks the replay on
 * the editor's own clock and never reaches inside the ring. A time the ring
 * cannot answer contributes no observation rather than an empty one — an empty
 * observation would read as "nothing was on screen then", which is a different
 * and false statement from "this moment was not recorded".
 */
export function frozenRingObservations(
  surfacesAt: (packTMs: number) => { surfaces: SurfaceInfo[] } | null,
  monitors: readonly HostMonitor[],
  targets: readonly ContextDisplayTarget[],
  replayDurationMs: number,
  sampleTimesMs?: readonly number[],
  // LANE A, OPTIONAL BY CONSTRUCTION (#111). Absent — no tracker, a platform
  // without one, a harness — means every observation carries no elements and
  // the capture-instant dump answers exactly as it did before this lane
  // existed. Silence here is "nobody looked", never "there was nothing".
  controlsAt?: (packTMs: number) => ReadonlyMap<string, readonly TrackedControl[]>,
): ContextObservation[] {
  const spaces = buildSpaces(monitors, targets)
  if (spaces.length === 0) return []
  const observations: ContextObservation[] = []
  const end = Math.max(0, Math.round(replayDurationMs))
  // THE RING'S OWN TIMES WHEN THEY ARE KNOWN (#87), a grid only as a fallback.
  //
  // KEPT EXACT, AND ONLY THE LABEL IS ROUNDED (#110). The ring's times are
  // fractional — a sample's time is frameMs + measured lag + measured age —
  // and `restoreAt` answers with the newest sample AT OR BEFORE the asked
  // time, deliberately (the past desktop, never the live one). So a query
  // rounded DOWN by even 0.2 ms lands just before the very sample it names,
  // and the answer is the PREVIOUS sample: a rectangle from a whole frame
  // earlier, republished under this frame's time.
  //
  // That is not a corner case, it is a coin flip per sample, and consecutive
  // flips repeat a rectangle whenever a round-up is followed by a round-down:
  // P = 1/4 for uniform fractions. Measured in the packs: 25%, 27%, 31% of
  // moving samples repeated — while the OS (4 ms updates through a 52 s
  // shake), the host (0 repeats in 644 driven samples), and the lane + ring
  // read back with EXACT times (0 in 433) all measured clean, which is what
  // finally cornered the fault here. This one line — `Math.round(t)` where
  // `t` went on to be the QUERY — was the whole "움직일때 어긋나" bug.
  const times: number[] = []
  if (sampleTimesMs !== undefined && sampleTimesMs.length > 0) {
    for (const t of sampleTimesMs) if (t >= 0 && t <= end) times.push(t)
  } else {
    for (let t = 0; t <= end; t += READ_INTERVAL_MS) times.push(t)
  }
  let previousLabel = -1
  for (const t of times) {
    const stack = surfacesAt(t)
    if (stack === null || stack.surfaces.length === 0) continue
    // The label is an integer because pack times are integer ms (SPEC §8.7);
    // half a millisecond of label error is bounded and harmless. Two samples
    // under 1 ms apart would round to one label — the first keeps it, the
    // other is skipped rather than published twice under one instant.
    const label = Math.round(t)
    if (label === previousLabel) continue
    previousLabel = label
    observations.push(observationOf(label, stack.surfaces, spaces, controlsAt?.(t) ?? EMPTY_CONTROLS))
  }
  // The capture instant itself, which the walk only lands on when a sample
  // happened to fall exactly there. It is the one moment the user is guaranteed
  // to look at.
  if (times[times.length - 1] !== end) {
    const last = surfacesAt(end)
    if (last !== null && last.surfaces.length > 0) {
      observations.push(observationOf(end, last.surfaces, spaces, controlsAt?.(end) ?? EMPTY_CONTROLS))
    }
  }
  return observations
}
