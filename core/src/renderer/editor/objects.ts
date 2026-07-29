// The editor's index over the candidates Core resolved FOR ONE MOMENT (#66).
//
// WHAT CHANGED IN v0.2.0, and what deliberately did not. The index used to be
// built once, at load, over the capture-instant Windows UI Automation dump —
// which is why picking only ever matched the last instant ("context 창 선택이
// 마지막 정보에만 맞아. 이동시켰는데 안 맞아"). It is now built over a
// ContextFrame: the surface stack and every provider's candidates AT THE
// REQUESTED TIME, rebuilt whenever the scrub settles somewhere new.
//
// Everything below the time is unchanged, on purpose. The clipping, the frame
// filters and the grid carry MEASURED behaviour (#58): fixing
// WINDOW_FRAME_FRACTION from 0.95 to 0.35 moved the median rectangle offered
// under the cursor from 1.58 Mpx (19% of a 3840x2160 screen) to 23,912 px and
// the share of points offering a precise target from 28.5% to 66.9%. Those
// numbers are an assertion now, not taste, so the temporal work happens
// UNDERNEATH them — and they now filter every provider's candidates, not only
// UI Automation's. A Chrome DOM provider offering <body> is the same bug as UIA
// offering a client-area pane, and it gets caught by the same constant.
//
// TWO LEVELS, and the order between them is still the whole point:
//
//   WINDOW  — the guaranteed floor, minted by CORE from the Surface Timeline
//             (#65), never by a provider. Wherever a surface is, picking has an
//             answer: hovering outlines the window, clicking snaps a box to it.
//   CONTROL — a refinement, from whichever provider holds a claim on that
//             region. Holding the modifier the editor documents forces the
//             window level back.
//
// ONE INDEX PER CAPTURED DISPLAY, each over that display's slice of the frame
// (SPEC §11.3). A pointer probe is a couple of array scans, so hovering costs
// nothing per frame — and it must keep costing nothing, which is why the
// candidate set arrives per SETTLED TIME rather than per pointer move.
import type {
  ContextCandidate,
  ProviderSurfaceClaim,
  SurfaceCoverage,
  SurfaceInfo,
} from '../../shared/context/protocol'
import type { ResolvableCandidate, ResolvedStack, ResolveOptions } from '../../shared/context/resolver'
import { resolveCandidates } from '../../shared/context/resolver'

/** Uniform grid cell, in snapshot pixels. */
const CELL = 64
/** Objects thinner than this in either axis are noise, not pick targets. */
const MIN_SIDE = 6
/**
 * How much of a rectangle must SURVIVE clipping for this display to be able to
 * offer it at all.
 *
 * Clipping alone CLAMPS: a window that lives entirely on another screen (or far
 * off the edge of this one) comes out as a sliver pinned to x=0 or y=0 —
 * measured on a two-monitor desk, two Chrome windows became 10px-wide strips
 * down the left edge of the neighbouring snapshot, where they shadowed
 * everything actually visible there. A rectangle with essentially nothing of
 * itself on this image is not a pick target on it.
 */
const MIN_VISIBLE_FRACTION = 0.02
/**
 * ...but the fraction alone scales with the object, so it is STRICTEST for the
 * biggest windows: on a 3840x2160 screen a maximized window would have to keep
 * ~166 kpx — a ~77 px wide strip — before it counted as visible at all, and a
 * window genuinely peeking out from behind another one by a couple of hundred
 * pixels would vanish from the index (its controls with it, since only the top
 * surface at a point may offer any). A rectangle that survives with real size
 * on BOTH axes is on this image whatever fraction of itself that is; the sliver
 * case above is metres away from these numbers.
 */
const MIN_VISIBLE_SIDE = 32
/**
 * A CONTROL covering most of the screen is a container (the window, its client
 * area, a full-bleed pane) — snapping a box onto it is never a useful
 * annotation, and it would shadow every smaller control under the cursor. The
 * window level below covers exactly that case properly, with the window's own
 * title, so nothing is lost by dropping these.
 */
const MAX_AREA_FRACTION = 0.8
/**
 * A second, dimensional guard on the same idea. A control can be a window /
 * client area / pane without covering 80% of the SNAPSHOT — a half-screen
 * maximized 1920x2160 window on a 3840x2160 desktop is only 50% of it — and
 * snapping a box onto a whole window is the WINDOW level's job. A control that
 * is large in BOTH axes is a frame, not a control; large in one axis (a
 * toolbar, a list, a side panel) still is one.
 */
const MAX_SIDE_FRACTION = 0.7
/**
 * Controls spanning more cells than this go into a linear overflow list instead
 * of being written into every cell they touch — an index build is O(controls),
 * never O(controls x screen area).
 */
const MAX_CELLS_PER_ELEMENT = 96
/**
 * A control this much of its OWN window is that window — the client-area pane
 * at depth 0/1 that every tree starts with. The window level covers exactly
 * that rectangle already, and covers it better: "Notepad" instead of "Pane".
 * Dropping these is what keeps the two levels from being two labels for one
 * box, and it is why a window whose whole tree is frames (Chromium, Electron)
 * correctly reports that it has nothing finer to offer.
 *
 * Relative to the WINDOW, not to the snapshot: the guards above cannot catch
 * the full-window pane of a small window.
 *
 * MEASURED, not guessed (issue #58). At the 0.95 this started life as, the test
 * never fired: on a real two-monitor capture the median control offered under
 * the cursor was 1.58 Mpx — 19% of a 3840x2160 screen, 55% of the window it
 * belonged to — because a half-window container clears 0.95 easily and, being
 * the smallest rectangle containing the point, then beats the window level.
 * That is what "hover select doesn't work" was: not an empty index (0.0% of
 * 5184 probes came back empty) but an index answering with containers.
 *
 * Sweeping the same capture at 0.95 / 0.70 / 0.50 / 0.35 moved the median to
 * 19.1% / 19.1% / 7.6% / 0.4% of the screen while the share of points offering
 * a control under 100 kpx — a target precise enough to annotate — stayed at
 * 19.6% throughout. Tightening this costs no useful target whatsoever; it only
 * sends containers down to the window level, which names them properly.
 */
const WINDOW_FRAME_FRACTION = 0.35
/**
 * The same test on a single AXIS, because area is only a proxy for what makes
 * a rectangle a frame. A content column can span its window's full height at
 * 30% of its width — 30% of the area, under the threshold above, and still
 * plainly a container rather than a thing to annotate.
 *
 * It CANNOT stand on its own, which is what the area floor below is for: a
 * toolbar is 100% of its window's width too, and is the most annotatable thing
 * on screen. What separates them is that the toolbar is SHORT — it spans an
 * axis while occupying almost none of the window.
 */
const WINDOW_FRAME_SIDE_FRACTION = 0.9
/** How much of its window a full-axis control must also cover to be a frame. */
const WINDOW_FRAME_SIDE_MIN_AREA = 0.25
/**
 * The wallpaper is a top-level window (class Progman, or a WorkerW behind the
 * icons) covering the whole desktop. Offering it would turn every click on
 * empty space into a full-desktop box, so the desktop is the one window picking
 * does not offer — the editor says "no object data here" instead. The frame
 * still records it; this is an editor-level decision.
 *
 * It is also the only thing left of "click empty canvas = clear the selection":
 * a point no ordinary window covers offers nothing, so the click there does
 * exactly what it always did. On a normal desk that is a point that does not
 * exist — every pixel belongs to some window — so the honest statement is that
 * clearing the selection is Esc's job now, and the click gesture survives only
 * on a bare desktop.
 */
const DESKTOP_CLASSES = new Set(['progman', 'workerw'])

function isDesktopClass(value: string | undefined): boolean {
  return DESKTOP_CLASSES.has((value ?? '').trim().toLowerCase())
}

export type PickLevel = 'control' | 'window'

/**
 * WINDOW LEVEL ONLY: why (or whether) a finer level exists inside this window.
 * SPEC §11.3's "Silence is not absence" is a normative reader rule, and these
 * are the different statements it distinguishes — one message for all of them
 * is exactly the misreading the spec calls out.
 */
export type WindowRefinement =
  // A control of this window is pickable on this snapshot: nothing to say.
  | 'controls'
  // No provider recorded this surface's contents at this time (past the window
  // cap, out of budget, a window that exposes none, or an interval no
  // checkpoint covers). NO DATA was recorded — not "no objects".
  | 'noData'
  // Contents WERE recorded and hold candidates, but none of them land on this
  // display's snapshot: they are off this screen, not absent.
  | 'offDisplay'
  // Recorded, on this screen, and every candidate is a frame/pane the window
  // level already covers better. Genuinely nothing finer to offer here.
  | 'none'

/**
 * One pickable object: a candidate clipped to the snapshot.
 *
 * It satisfies ResolvableCandidate structurally, so the Surface Resolver
 * arbitrates over exactly the rectangles a box would snap to — not over the raw
 * bounds, which for a window straddling two screens are a different rectangle
 * on each of them.
 */
export interface PickableObject extends ResolvableCandidate {
  level: PickLevel
  /** The candidate Core resolved, with its provider identity and accuracy. */
  candidate: ContextCandidate
  /** The surface this object is on (level 'window': the surface it IS). */
  surface: SurfaceInfo | null
  // WINDOW LEVEL ONLY: whether a finer level exists, and if not, WHY not —
  // which is what the editor turns into an honest one-time message. Always
  // 'controls' at level 'control' (the finer level is what you are looking at).
  refinement: WindowRefinement
}

/**
 * The stable identity used by the editor's "one box per object per moment"
 * guard.
 *
 * A surface is a WINDOW, not every object inside it. Matching only surfaceId
 * made the first picked child control shadow every sibling in that window:
 * clicking a second child merely re-selected the first child's box. Provider
 * + surface + object is the identity contract ContextCandidate publishes; the
 * level stays explicit so Core's window floor can never collide with a
 * provider control that happens to reuse an opaque id.
 */
export interface PickIdentity {
  providerId: string
  surfaceId: string
  objectId: string
  level: PickLevel
}

export function pickIdentityOf(o: PickableObject): PickIdentity {
  return {
    providerId: o.providerId,
    surfaceId: o.surfaceId,
    objectId: o.candidate.objectId,
    level: o.level,
  }
}

export function samePickIdentity(a: PickIdentity, b: PickIdentity): boolean {
  return (
    a.providerId === b.providerId &&
    a.surfaceId === b.surfaceId &&
    a.objectId === b.objectId &&
    a.level === b.level
  )
}

/**
 * The text a picked box is pre-filled with: the object's name (falling back to
 * its type), or the window's title (falling back to its process).
 */
export function objectLabel(o: PickableObject): string {
  const identity = o.candidate.identity ?? {}
  if (o.level === 'window') {
    const title = (identity['title'] ?? o.candidate.name ?? '').trim()
    return title !== '' ? title : (identity['process'] ?? '').trim()
  }
  const name = (o.candidate.name ?? '').trim()
  return name !== '' ? name : o.candidate.objectType.trim()
}

/**
 * The hover chip's text: the label plus, for a window, the process behind it —
 * "Untitled - Notepad" alone does not say WHICH app, and a window whose title
 * is empty says nothing at all without it. Falls back to the Win32 class rather
 * than showing an empty chip: an unnamed object is still worth naming.
 */
export function objectHoverLabel(o: PickableObject): string {
  const label = objectLabel(o)
  const identity = o.candidate.identity ?? {}
  if (o.level !== 'window') {
    return label !== '' ? label : (identity['class_name'] ?? '').trim()
  }
  const process = (identity['process'] ?? '').trim()
  if (label === '') return process !== '' ? process : (identity['class_name'] ?? '').trim()
  if (process === '' || label.toLowerCase().includes(process.toLowerCase())) return label
  return `${label} — ${process}`
}

export class ObjectIndex {
  private readonly objects: readonly PickableObject[]
  private readonly cells: ReadonlyMap<number, number[]>
  private readonly wide: readonly number[]
  private readonly cols: number
  private readonly rows: number
  // Z-ASCENDING: the first window containing a point is the one on top of it.
  private readonly windows: readonly PickableObject[]
  private readonly surfaces: readonly SurfaceInfo[]
  private readonly claims: readonly ProviderSurfaceClaim[]

  private constructor(
    objects: readonly PickableObject[],
    cells: ReadonlyMap<number, number[]>,
    wide: readonly number[],
    cols: number,
    rows: number,
    windows: readonly PickableObject[],
    surfaces: readonly SurfaceInfo[],
    claims: readonly ProviderSurfaceClaim[],
  ) {
    this.objects = objects
    this.cells = cells
    this.wide = wide
    this.cols = cols
    this.rows = rows
    this.windows = windows
    this.surfaces = surfaces
    this.claims = claims
  }

  /**
   * Number of pickable objects, both levels. 0 means the frame has nothing for
   * this display — no observation, nothing of it landed here, or the requested
   * time is not covered — and picking stays silently off, exactly as it behaved
   * before the feature existed. (Silence is right ONLY here: within a frame
   * that has data, an empty spot says so.)
   */
  get size(): number {
    return this.objects.length + this.windows.length
  }

  /** The surface stack this index was built over, z ascending. */
  get surfaceStack(): readonly SurfaceInfo[] {
    return this.surfaces
  }

  /**
   * Builds the index for one display's slice of a ContextFrame. Candidates are
   * clipped to the snapshot and filtered (see the constants above); controls
   * are stored area-ascending so a scan meets the smallest first, windows z
   * ascending so the first hit is the top-most.
   */
  static build(
    candidates: readonly ContextCandidate[],
    surfaces: readonly SurfaceInfo[],
    coverage: readonly SurfaceCoverage[],
    claims: readonly ProviderSurfaceClaim[],
    width: number,
    height: number,
  ): ObjectIndex {
    const maxArea = width * height * MAX_AREA_FRACTION
    const maxW = width * MAX_SIDE_FRACTION
    const maxH = height * MAX_SIDE_FRACTION
    // Surfaces clipped once: every candidate looks its owner up here rather
    // than scanning the list per candidate.
    const bySurface = new Map<
      string,
      { surface: SurfaceInfo; clip: { width: number; height: number; area: number } | null }
    >()
    for (const s of surfaces) {
      bySurface.set(s.surfaceId, { surface: s, clip: clip(s.bounds, width, height) })
    }
    // A surface with nothing left of it on THIS snapshot cannot occlude
    // anything on it. Without this filter a sliver of a window that lives on
    // the neighbouring screen would become the "top surface" at a point and
    // silently swallow every candidate under it — which is the cross-display
    // failure MIN_VISIBLE_SIDE exists to prevent, one layer up.
    // THE SHELL DESKTOP IS BACKDROP, NEVER AN OCCLUDER.
    //
    // Core now preserves Progman/WorkerW's enumerated bottom z even when the
    // shell owns keyboard focus, but an old/external frame may still mark it
    // foreground. CapturePack_2026-07-29_194912 did: the full-desktop Progman
    // surface became top-most and swallowed every Orca/taskbar candidate even
    // though the desktop's own window candidate was correctly filtered below.
    // Keeping it in the ContextFrame preserves the observation; excluding it
    // from this editor-only resolver stack makes bare wallpaper remain a miss
    // and prevents legacy desktop focus from hiding visible windows.
    const present = surfaces.filter(
      (s) => bySurface.get(s.surfaceId)?.clip != null && !isDesktopClass(s.className),
    )
    const detail = new Map<string, SurfaceCoverage['state']>()
    for (const c of coverage) detail.set(c.surfaceId, c.state)

    const objects: PickableObject[] = []
    // Which surfaces had a candidate that landed on THIS display at all, before
    // the frame filters below removed any of them: that is what separates "its
    // controls are on another screen" from "its controls are all frames".
    const onThisDisplay = new Set<string>()
    const recorded = new Set<string>()
    for (const candidate of candidates) {
      if (candidate.authority === 'window') continue
      recorded.add(candidate.surfaceId)
      const clipped = clip(candidate.bounds, width, height)
      // Off-screen objects (another display, a scrolled-away control) clip to
      // nothing and drop out here.
      if (clipped === null) continue
      onThisDisplay.add(candidate.surfaceId)
      if (clipped.area > maxArea) continue
      if (clipped.width > maxW && clipped.height > maxH) continue
      // A CONTROL WHOSE WINDOW IS NOT ON THIS SNAPSHOT IS NOT OFFERED HERE.
      //
      // The frame test below is the only thing that keeps a window's own
      // client-area pane out of the control level, and it needs the owner's
      // rectangle. This used to skip the test when the owner could not be
      // resolved (`owner?.clip != null && ...`), so an unresolvable candidate
      // was offered UNFILTERED — and what reaches the control level unfiltered
      // is, by construction, the biggest thing in the window.
      //
      // Measured on CapturePack_2026-07-29_173246: a control 1914x2082 was
      // offered and picked. Its window (Orca, 1932x2091) makes it 98.6% of that
      // window — five times over the 0.35 frame threshold — so it could only
      // have been offered by the owner lookup failing. The pack shows the same
      // for a second container-sized "control".
      //
      // Dropping is the same rule the surrounding code already applies to a
      // surface with nothing left of it on this snapshot (see `present`): this
      // index is per display, and a candidate whose window is not here cannot
      // be clipped, frame-tested or occlusion-tested against anything real.
      const owner = bySurface.get(candidate.surfaceId)
      if (owner?.clip == null) continue
      if (isWindowFrame(clipped, owner.clip)) continue
      objects.push({
        level: 'control',
        candidate,
        surface: owner.surface,
        refinement: 'controls',
        providerId: candidate.providerId,
        surfaceId: candidate.surfaceId,
        authority: candidate.authority,
        depth: candidate.depth,
        paintOrder: candidate.paintOrder,
        confidence: candidate.confidence,
        visible: candidate.visible,
        occluded: candidate.occluded,
        ...clipped,
      })
    }
    objects.sort((a, b) => a.area - b.area)

    // Which surfaces a finer level actually exists for, AFTER the filters above.
    const refinable = new Set<string>()
    for (const o of objects) refinable.add(o.surfaceId)

    const windows: PickableObject[] = []
    for (const candidate of candidates) {
      if (candidate.authority !== 'window') continue
      const owner = bySurface.get(candidate.surfaceId)
      if (isDesktopClass(owner?.surface.className)) continue
      const clipped = clip(candidate.bounds, width, height)
      if (clipped === null) continue
      windows.push({
        level: 'window',
        candidate,
        surface: owner?.surface ?? null,
        refinement: refinementOf(candidate.surfaceId, detail, refinable, recorded, onThisDisplay),
        providerId: candidate.providerId,
        surfaceId: candidate.surfaceId,
        authority: candidate.authority,
        depth: candidate.depth,
        paintOrder: candidate.paintOrder,
        confidence: candidate.confidence,
        visible: candidate.visible,
        occluded: candidate.occluded,
        ...clipped,
      })
    }
    windows.sort((a, b) => zOf(a, bySurface) - zOf(b, bySurface))

    const cols = Math.max(1, Math.ceil(width / CELL))
    const rows = Math.max(1, Math.ceil(height / CELL))
    const cells = new Map<number, number[]>()
    const wide: number[] = []
    objects.forEach((o, index) => {
      const c0 = Math.max(0, Math.floor(o.x / CELL))
      const r0 = Math.max(0, Math.floor(o.y / CELL))
      const c1 = Math.min(cols - 1, Math.floor((o.x + o.width) / CELL))
      const r1 = Math.min(rows - 1, Math.floor((o.y + o.height) / CELL))
      if ((c1 - c0 + 1) * (r1 - r0 + 1) > MAX_CELLS_PER_ELEMENT) {
        wide.push(index)
        return
      }
      for (let r = r0; r <= r1; r += 1) {
        for (let c = c0; c <= c1; c += 1) {
          const key = r * cols + c
          const bucket = cells.get(key)
          if (bucket === undefined) cells.set(key, [index])
          else bucket.push(index)
        }
      }
    })
    return new ObjectIndex(objects, cells, wide, cols, rows, windows, present, claims)
  }

  /**
   * The object offered at a snapshot point, or null when the frame knows
   * nothing about it. The first of the resolved stack — everything else at that
   * point is still there, in `stack`.
   */
  pick(x: number, y: number, forceWindow = false): PickableObject | null {
    return this.stackAt(x, y, forceWindow).offered[0] ?? null
  }

  /**
   * THE CANDIDATE STACK AT A POINT (#66: "never discard the losing
   * candidates"). Ordered by the six criteria; the first is what a click takes,
   * the rest is what Tab / Shift+Tab cycle through, and `surfaces` is what
   * Alt+Click would cycle when it ships.
   */
  stackAt(x: number, y: number, forceWindow = false, surfaceDepth = 0): ResolvedStack<PickableObject> {
    const options: ResolveOptions = { surfaceDepth }
    if (forceWindow) options.forceAuthority = 'window'
    return resolveCandidates<PickableObject>({
      surfaces: this.surfaces,
      claims: this.claims,
      candidatesAtPoint: this.candidatesAt(x, y),
      point: { x, y },
      options,
    })
  }

  /** The top-most window covering the point — the floor under every pick. */
  windowAt(x: number, y: number): PickableObject | null {
    for (const w of this.windows) {
      if (contains(w, x, y)) return w
    }
    return null
  }

  /**
   * Every pickable object whose rectangle contains the point, both levels and
   * every surface. Arbitration is the resolver's job, not the index's: the
   * index answers "what is here", the resolver answers "which of these was the
   * user looking at".
   *
   * CLAMPED into the grid, not bounds-checked out of it. A probe point is never
   * negative and never past the last pixel (board.ts toNativePoint clamps to
   * width - 1), but a caller with raw coordinates could still land outside, and
   * skipping the grid there would silently degrade that point to the window
   * level; contains() still rejects a real miss.
   */
  private candidatesAt(x: number, y: number): PickableObject[] {
    const out: PickableObject[] = []
    if (this.objects.length > 0) {
      const c = Math.min(this.cols - 1, Math.max(0, Math.floor(x / CELL)))
      const r = Math.min(this.rows - 1, Math.max(0, Math.floor(y / CELL)))
      collect(this.objects, this.cells.get(r * this.cols + c), x, y, out)
      collect(this.objects, this.wide, x, y, out)
    }
    for (const w of this.windows) {
      if (contains(w, x, y)) out.push(w)
    }
    return out
  }
}

function collect(
  objects: readonly PickableObject[],
  indices: readonly number[] | undefined,
  x: number,
  y: number,
  out: PickableObject[],
): void {
  if (indices === undefined) return
  for (const i of indices) {
    const o = objects[i]
    if (o === undefined || !contains(o, x, y)) continue
    out.push(o)
  }
}

/**
 * The honest answer for one window (SPEC §11.3, "Silence is not absence").
 * Order matters: whether data was RECORDED beats anything about what the data
 * contains.
 */
function refinementOf(
  surfaceId: string,
  detail: ReadonlyMap<string, SurfaceCoverage['state']>,
  refinable: ReadonlySet<string>,
  recorded: ReadonlySet<string>,
  onThisDisplay: ReadonlySet<string>,
): WindowRefinement {
  if (refinable.has(surfaceId)) return 'controls'
  // Only surfaces a provider actually recorded can say anything about their
  // contents; for any other state the frame says NOTHING about this window.
  const state = detail.get(surfaceId)
  if (state !== 'recorded' && state !== 'truncated') return 'noData'
  // Contents were recorded, hold candidates, but none reach this snapshot: the
  // window straddles the board and its controls are elsewhere.
  if (recorded.has(surfaceId) && !onThisDisplay.has(surfaceId)) return 'offDisplay'
  return 'none'
}

/** Surface z-order, which the timeline already put the focused window on top of. */
function zOf(
  o: PickableObject,
  bySurface: ReadonlyMap<string, { surface: SurfaceInfo }>,
): number {
  const surface = bySurface.get(o.surfaceId)?.surface ?? o.surface
  return surface?.zOrder ?? Number.MAX_SAFE_INTEGER
}

function contains(o: PickableObject, x: number, y: number): boolean {
  return x >= o.x && y >= o.y && x <= o.x + o.width && y <= o.y + o.height
}

/**
 * Whether a control is really its window's frame — the client-area pane, the
 * full-height content column, the wrapper every tree starts with (issue #58).
 *
 * Two ways to be one, because area alone missed the case that mattered: most of
 * the window's AREA, or nearly all of one of its AXES while still being bulky.
 * Either way the window level already offers that rectangle, under the window's
 * own title, so the control is dropped and the pick falls through to it.
 *
 * The area floor on the axis test is what keeps a toolbar — full width, and the
 * most annotatable thing in the window — from being read as its frame.
 */
function isWindowFrame(
  control: { width: number; height: number; area: number },
  window: { width: number; height: number; area: number },
): boolean {
  if (control.area >= window.area * WINDOW_FRAME_FRACTION) return true
  if (control.area < window.area * WINDOW_FRAME_SIDE_MIN_AREA) return false
  const spansWidth = window.width > 0 && control.width >= window.width * WINDOW_FRAME_SIDE_FRACTION
  const spansHeight =
    window.height > 0 && control.height >= window.height * WINDOW_FRAME_SIDE_FRACTION
  return spansWidth || spansHeight
}

/** Snapshot-clipped rectangle, or null when nothing usable is left of it. */
function clip(
  bounds: { x: number; y: number; width: number; height: number },
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number; area: number } | null {
  const x0 = Math.max(0, Math.round(bounds.x))
  const y0 = Math.max(0, Math.round(bounds.y))
  const x1 = Math.min(width, Math.round(bounds.x + bounds.width))
  const y1 = Math.min(height, Math.round(bounds.y + bounds.height))
  const w = x1 - x0
  const h = y1 - y0
  if (w < MIN_SIDE || h < MIN_SIDE) return null
  // ...and what is left has to be a meaningful part of the object, OR big
  // enough in absolute terms to be an object on this image in its own right.
  // Either test passing keeps the rectangle: the first is what rejects an
  // off-screen window clamped into frame, the second is what stops that
  // rejection from swallowing a large window that really is peeking in from the
  // side (MIN_VISIBLE_SIDE).
  const whole = Math.max(0, Math.round(bounds.width)) * Math.max(0, Math.round(bounds.height))
  const bigEnough = w >= MIN_VISIBLE_SIDE && h >= MIN_VISIBLE_SIDE
  if (whole > 0 && !bigEnough && w * h < whole * MIN_VISIBLE_FRACTION) return null
  return { x: x0, y: y0, width: w, height: h, area: w * h }
}
