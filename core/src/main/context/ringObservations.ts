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
import type { EditorUiaWindow } from '../../shared/ipc'
import type { HostMonitor } from './surfaceLane'
import type { ContextObservation } from './buffer'
import type { ContextDisplayTarget } from './session'

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

/** A display's mapping space: which host monitor it is, and how to get onto its image. */
interface DisplaySpace {
  index: number
  focused: boolean
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
): ContextObservation {
  const windows: EditorUiaWindow[] = []
  for (const surface of surfaces) {
    if (surface.minimized || !surface.visible) continue
    const space = spaceOf(spaces, surface.bounds)
    if (space === null) continue
    windows.push({
      title: surface.windowTitle ?? '',
      process: surface.executableName ?? '',
      class_name: surface.className ?? '',
      bounds: space.toSnapshot(surface.bounds),
      display: space.index,
      focused: surface.foreground,
      z: surface.zOrder,
      hasControls: false,
      tree: 'skipped',
    })
  }
  return { tMs, windows, elements: [] }
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
): ContextObservation[] {
  const spaces = buildSpaces(monitors, targets)
  if (spaces.length === 0) return []
  const observations: ContextObservation[] = []
  const end = Math.max(0, Math.round(replayDurationMs))
  // THE RING'S OWN TIMES WHEN THEY ARE KNOWN (#87), a grid only as a fallback.
  const times: number[] = []
  if (sampleTimesMs !== undefined && sampleTimesMs.length > 0) {
    for (const t of sampleTimesMs) if (t >= 0 && t <= end) times.push(Math.round(t))
  } else {
    for (let t = 0; t <= end; t += READ_INTERVAL_MS) times.push(t)
  }
  for (const t of times) {
    const stack = surfacesAt(t)
    if (stack === null || stack.surfaces.length === 0) continue
    observations.push(observationOf(t, stack.surfaces, spaces))
  }
  // The capture instant itself, which the walk only lands on when a sample
  // happened to fall exactly there. It is the one moment the user is guaranteed
  // to look at.
  if (times[times.length - 1] !== end) {
    const last = surfacesAt(end)
    if (last !== null && last.surfaces.length > 0) {
      observations.push(observationOf(end, last.surfaces, spaces))
    }
  }
  return observations
}
