// FROZEN: the v0.1.7 object index, kept verbatim as the thing the temporal
// path has to reproduce.
//
// test/temporal/check.mjs builds this and the current ObjectIndex over the SAME
// pack and compares all 5184 probes on every display. That comparison is the
// strongest available statement that making picking follow time (#66) cost none
// of the picking quality #58 measured — stronger than any aggregate, which can
// hide a swap. It is only worth anything while this file stays exactly as the
// previous release shipped it, so DO NOT EDIT IT. When picking behaviour is
// deliberately changed, replace it with the newly-shipped version in the same
// commit that changes the behaviour, and say so.
//
// Only the import path is rewritten (it lives outside src/).
// Static object picking (GOAL "Static object picking (v0 — before full
// tracking)"): the editor's index over the capture-instant Windows UI
// Automation objects that arrived in EditorInitPayload.
//
// TWO LEVELS, and the order between them is the whole point:
//
//   WINDOW  — the guaranteed floor. The dump lists every visible top-level
//             window, so wherever a window is, picking has an answer: hovering
//             outlines the window, clicking snaps a box to its bounds. This is
//             what makes picking work over Chromium/Electron windows, over
//             apps that expose no accessibility tree, and over every window the
//             budget never reached.
//   CONTROL — a refinement. Where a control tree was collected, the smallest
//             control containing the cursor wins over its window, because that
//             is the more precise annotation. Holding the modifier the editor
//             documents forces the window level back.
//
// Occlusion is respected: only the controls of the TOP-MOST window at a point
// may be offered there, so a button of a window buried behind another one is
// never picked through it.
//
// ONE INDEX PER CAPTURED DISPLAY, each built over the objects whose bounds are
// in THAT display's snapshot space (SPEC §11.3): every screen of the board is
// annotatable, so a single index could only ever answer for one of them. A
// pointer probe is then a couple of array scans, so hovering costs nothing per
// frame (and editor.ts probes only when the pointer actually moved to a new
// snapshot pixel).
import type { EditorUiaElement, EditorUiaWindow } from '../../src/shared/ipc'

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
 * window at a point may offer any). A rectangle that survives with real size on
 * BOTH axes is on this image whatever fraction of itself that is; the sliver
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
 * does not offer — the editor says "no object data here" instead. The dump
 * still records it; this is an editor-level decision.
 *
 * It is also the only thing left of "click empty canvas = clear the selection":
 * a point no ordinary window covers offers nothing, so the click there does
 * exactly what it always did. On a normal desk that is a point that does not
 * exist — every pixel belongs to some window — so the honest statement is that
 * clearing the selection is Esc's job now, and the click gesture survives only
 * on a bare desktop. (The editor no longer refuses window-level picks that had
 * a selection to clear; that made a plain click unable to pick a window at all,
 * which is the single most common thing there is to annotate.)
 */
const DESKTOP_CLASSES = new Set(['progman', 'workerw'])

export type PickLevel = 'control' | 'window'

/**
 * WINDOW LEVEL ONLY: why (or whether) a finer level exists inside this window.
 * SPEC §11.3's "Silence is not absence" is a normative reader rule, and these
 * are the three different statements it distinguishes — one message for all of
 * them is exactly the misreading the spec calls out.
 */
export type WindowRefinement =
  // A control of this window is pickable on this snapshot: nothing to say.
  | 'controls'
  // The dump never read this window's tree (past the window cap, out of budget,
  // or a window that exposes none). NO DATA was recorded — not "no objects".
  | 'noData'
  // The tree WAS read and holds controls, but none of them land on this
  // display's snapshot: they are off this screen, not absent.
  | 'offDisplay'
  // The tree was read, its controls are on this screen, and every one of them
  // is a frame/pane the window level already covers better. Genuinely nothing
  // finer to offer here.
  | 'none'

/** One pickable object: the control or window, clipped to the snapshot. */
export interface PickableObject {
  level: PickLevel
  // The control, at level 'control'; null at level 'window'.
  element: EditorUiaElement | null
  // The window this object IS (level 'window'), or the window whose tree the
  // control came from (null when the dump did not say which).
  window: EditorUiaWindow | null
  // WINDOW LEVEL ONLY: whether a finer level exists, and if not, WHY not —
  // which is what the editor turns into an honest one-time message. Always
  // 'controls' at level 'control' (the finer level is what you are looking at).
  refinement: WindowRefinement
  // Clipped to the snapshot rect — what a picked box snaps to.
  x: number
  y: number
  width: number
  height: number
  area: number
  // CONTROL LEVEL: this control's position in the dump's tree walk. UIA exposes
  // no z-order between siblings, but it walks them in tree order and a later
  // sibling is painted over an earlier one — so this is the only occlusion
  // signal there is inside a window (issue #58). 0 at the window level.
  //
  // Deliberately NOT the element's `depth`. Depth is how deep the WALK was, not
  // what is in front: measured on a real capture, ordering by depth never once
  // beat ordering by containment and lost on 31.9% of contested points, because
  // a small control in a shallow branch and a big pane in a deep one are
  // ordinary neighbours in a UIA tree.
  order: number
}

/**
 * The text a picked box is pre-filled with: the control's name (falling back to
 * its type), or the window's title (falling back to its process).
 */
export function objectLabel(o: PickableObject): string {
  if (o.level === 'window') {
    const w = o.window
    if (w === null) return ''
    const title = w.title.trim()
    return title !== '' ? title : w.process.trim()
  }
  const e = o.element
  if (e === null) return ''
  const name = e.name.trim()
  return name !== '' ? name : e.control_type.trim()
}

/**
 * The hover chip's text: the label plus, for a window, the process behind it —
 * "Untitled - Notepad" alone does not say WHICH app, and a window whose title
 * is empty says nothing at all without it. Falls back to the Win32 class rather
 * than showing an empty chip: an unnamed object is still worth naming.
 */
export function objectHoverLabel(o: PickableObject): string {
  const label = objectLabel(o)
  if (o.level !== 'window' || o.window === null) {
    return label !== '' ? label : (o.element?.class_name.trim() ?? '')
  }
  const process = o.window.process.trim()
  if (label === '') return process !== '' ? process : o.window.class_name.trim()
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

  private constructor(
    objects: readonly PickableObject[],
    cells: ReadonlyMap<number, number[]>,
    wide: readonly number[],
    cols: number,
    rows: number,
    windows: readonly PickableObject[],
  ) {
    this.objects = objects
    this.cells = cells
    this.wide = wide
    this.cols = cols
    this.rows = rows
    this.windows = windows
  }

  /**
   * Number of pickable objects, both levels. 0 means there is no object data at
   * all — no dump, or nothing of it landed on this display — and picking stays
   * silently off, exactly as it behaved before the feature existed. (Silence is
   * right ONLY here: within a dump that has data, an empty spot says so.)
   */
  get size(): number {
    return this.objects.length + this.windows.length
  }

  /**
   * Builds the index for one snapshot coordinate space. Objects are clipped to
   * the snapshot and filtered (see the constants above); controls are sorted by
   * area ascending so the FIRST hit of any scan is the smallest containing one,
   * windows by z ascending so the first hit is the top-most.
   */
  static build(
    elements: readonly EditorUiaElement[],
    uiaWindows: readonly EditorUiaWindow[],
    width: number,
    height: number,
  ): ObjectIndex {
    const maxArea = width * height * MAX_AREA_FRACTION
    const maxW = width * MAX_SIDE_FRACTION
    const maxH = height * MAX_SIDE_FRACTION
    // Windows by z, clipped once: every control looks its owner up here rather
    // than scanning the list per element.
    const byZ = new Map<
      number,
      { window: EditorUiaWindow; clip: { width: number; height: number; area: number } | null }
    >()
    for (const w of uiaWindows) byZ.set(w.z, { window: w, clip: clip(w.bounds, width, height) })
    const objects: PickableObject[] = []
    // Which windows had a control that landed on THIS display at all, before
    // the frame filters below removed any of them: that is what separates
    // "its controls are on another screen" from "its controls are all frames".
    const onThisDisplay = new Set<number>()
    elements.forEach((element, order) => {
      const clipped = clip(element.bounds, width, height)
      // Off-screen objects (another display, a scrolled-away control) clip to
      // nothing and drop out here.
      if (clipped === null) return
      if (element.window >= 0) onThisDisplay.add(element.window)
      if (clipped.area > maxArea) return
      if (clipped.width > maxW && clipped.height > maxH) return
      const owner = byZ.get(element.window)
      if (owner?.clip != null && isWindowFrame(clipped, owner.clip)) return
      objects.push({
        level: 'control',
        element,
        window: owner?.window ?? null,
        refinement: 'controls',
        order,
        ...clipped,
      })
    })
    objects.sort((a, b) => a.area - b.area)

    // Which windows a finer level actually exists for, AFTER the filters above.
    const legacy = elements.length > 0 && elements.every((e) => e.window < 0)
    const refinable = new Set<number>()
    for (const o of objects) {
      const z = o.element?.window ?? -1
      if (z >= 0) refinable.add(z)
    }
    // How many controls the dump RECORDED per window, before clipping — a
    // window with recorded controls that all clip away has its controls on
    // another screen, which is a different fact from having none.
    const recorded = new Set<number>()
    for (const e of elements) {
      if (e.window >= 0) recorded.add(e.window)
    }

    const windows: PickableObject[] = []
    for (const window of uiaWindows) {
      if (DESKTOP_CLASSES.has(window.class_name.trim().toLowerCase())) continue
      const clipped = clip(window.bounds, width, height)
      if (clipped === null) continue
      windows.push({
        level: 'window',
        element: null,
        window,
        refinement: legacy
          ? // A pack whose controls do not name their window (0.1.0 payload)
            // walked the focused window alone, and those controls are offered
            // everywhere — so hasControls, which main derived under exactly
            // that rule, is all such a pack can honestly say.
            window.hasControls
            ? 'controls'
            : 'none'
          : refinementOf(window, refinable, recorded, onThisDisplay),
        // Windows are ordered by z, never by tree order.
        order: 0,
        ...clipped,
      })
    }
    // The focused window was on top at the capture instant by definition, so it
    // wins over whatever z the dump gave it.
    windows.sort((a, b) => zOf(a) - zOf(b))

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
    return new ObjectIndex(objects, cells, wide, cols, rows, windows)
  }

  /**
   * The object offered at a snapshot point, or null when the dump knows nothing
   * about it. The smallest control of the top-most window wins; `forceWindow`
   * (the editor's modifier) skips straight to that window.
   */
  pick(x: number, y: number, forceWindow = false): PickableObject | null {
    const window = this.windowAt(x, y)
    if (!forceWindow) {
      const control = this.controlAt(x, y, window)
      if (control !== null) return control
    }
    return window
  }

  /** The top-most window covering the point — the floor under every pick. */
  windowAt(x: number, y: number): PickableObject | null {
    for (const w of this.windows) {
      if (contains(w, x, y)) return w
    }
    return null
  }

  /**
   * The smallest control containing the point that the top window may offer.
   * Occlusion: a control belongs to exactly one window, and only the window on
   * top at that pixel gets to speak for it. Controls from a dump that did not
   * record their window (window < 0, a pack written before the walk covered
   * more than the foreground window) are always eligible — that pack's controls
   * all came from the one window it walked.
   */
  private controlAt(x: number, y: number, window: PickableObject | null): PickableObject | null {
    if (this.objects.length === 0) return null
    const top = window?.window?.z ?? -1
    const eligible = (o: PickableObject): boolean => {
      const owner = o.element?.window ?? -1
      return owner < 0 || owner === top
    }
    // CLAMPED into the grid, not bounds-checked out of it. A probe point is
    // never negative and never past the last pixel (board.ts toNativePoint
    // clamps to width - 1), but a caller with raw coordinates could still land
    // outside, and skipping the grid there would silently degrade that point to
    // the window level; contains() below still rejects a real miss.
    const c = Math.min(this.cols - 1, Math.max(0, Math.floor(x / CELL)))
    const r = Math.min(this.rows - 1, Math.max(0, Math.floor(y / CELL)))
    const best = this.bestHit(this.cells.get(r * this.cols + c), x, y, eligible, null)
    return this.bestHit(this.wide, x, y, eligible, best)
  }

  /**
   * The control at a point, scanning EVERY hit rather than stopping at the first
   * (issue #58).
   *
   * Both lists are area-ascending, so the first hit is the smallest — which is
   * the right answer for the 71% of contested points where the candidates nest
   * cleanly, one inside the next. It is NOT the right answer for the other 29%,
   * where two controls genuinely overlap without either containing the other:
   * there, smallest-wins can offer the one that is visually behind. Only the
   * window level did occlusion before this; inside a window nothing did.
   */
  private bestHit(
    indices: readonly number[] | undefined,
    x: number,
    y: number,
    eligible: (o: PickableObject) => boolean,
    seed: PickableObject | null,
  ): PickableObject | null {
    if (indices === undefined) return seed
    let best = seed
    for (const i of indices) {
      const o = this.objects[i]
      if (o === undefined || !contains(o, x, y) || !eligible(o)) continue
      if (best === null || inFrontOf(o, best)) best = o
    }
    return best
  }

}

/**
 * The honest three-way answer for one window (SPEC §11.3, "Silence is not
 * absence"). Order matters: whether data was RECORDED beats anything about
 * what the data contains.
 */
function refinementOf(
  window: EditorUiaWindow,
  refinable: ReadonlySet<number>,
  recorded: ReadonlySet<number>,
  onThisDisplay: ReadonlySet<number>,
): WindowRefinement {
  if (refinable.has(window.z)) return 'controls'
  // `elements` covers only windows whose tree is "collected"/"truncated"; for
  // any other status the payload says NOTHING about this window's contents.
  if (window.tree !== 'collected' && window.tree !== 'truncated') return 'noData'
  // A tree that was read, holds controls, but none of them reach this
  // snapshot: the window straddles the board and its controls are elsewhere.
  if (recorded.has(window.z) && !onThisDisplay.has(window.z)) return 'offDisplay'
  return 'none'
}

/** The focused window was on top at the capture instant, whatever z it got. */
function zOf(o: PickableObject): number {
  const w = o.window
  if (w === null) return Number.MAX_SAFE_INTEGER
  return w.focused ? -1 : w.z
}

function contains(o: PickableObject, x: number, y: number): boolean {
  return x >= o.x && y >= o.y && x <= o.x + o.width && y <= o.y + o.height
}

/** Whether `a` fully encloses `b` — `b` is then the finer of the two. */
function encloses(a: PickableObject, b: PickableObject): boolean {
  return (
    b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height
  )
}

/**
 * Which of two controls containing the same point should be offered there.
 *
 * NESTED — one encloses the other: the inner one wins. It is the more precise
 * annotation and it is what is actually on top.
 *
 * OVERLAPPING — neither encloses the other: the one LATER in the tree walk wins,
 * because that is the one painted over the other. UIA gives siblings no z-order,
 * so tree order is the only occlusion signal available inside a window; the
 * element's `depth` is not one (see PickableObject.order).
 *
 * Not a total order — two controls can each be "in front" of a third by
 * different tests — so this is a scan, not a sort. That matches how a hit test
 * works anyway: every candidate is compared against the best so far.
 */
function inFrontOf(a: PickableObject, best: PickableObject): boolean {
  if (encloses(best, a)) return true
  if (encloses(a, best)) return false
  if (a.order !== best.order) return a.order > best.order
  return a.area < best.area
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
