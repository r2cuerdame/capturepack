// The editor BOARD (GOAL "Multi-Monitor Support" — "All captured displays are
// shown at once"): the geometry that lays every frozen display side by side in
// its REAL arrangement, and the one place that decides how many pixels the
// board canvases are allowed to cost.
//
// Three coordinate spaces meet here, and keeping them apart is the whole job:
//
//   NATIVE  — one display's snapshot pixels. Annotation bounds live here
//             (SPEC §8.2) and never leave it: a box belongs to a display.
//   BOARD   — device-independent pixels of the virtual desktop, origin moved to
//             the top-left of the bounding box of all displays. This is the
//             arrangement the user sees on their desk: a 1x 1920x1080 screen
//             beside a 1.5x 2560x1440 one keeps its true physical proportion,
//             which raw native pixel counts would not.
//   CANVAS  — the backing store of the two board canvases, `ratio` canvas
//             pixels per board unit.
//
// Pure functions and plain data only — no DOM, so the layout is testable and
// the editor stays the only place that draws.

/** One display's place on the board. */
export interface BoardDisplay {
  // 1-based manifest.media.displays[].index — the value an annotation's
  // `display` field carries.
  index: number
  focused: boolean
  // Native snapshot pixel size (the annotation coordinate space).
  width: number
  height: number
  // Whether this display recorded a replay. A display without one shows its
  // frozen snapshot for every scrub position and is labelled as such.
  hasReplay: boolean
  // Board-unit rectangle (origin-normalized virtual desktop, DIPs).
  bx: number
  by: number
  bw: number
  bh: number
  // Backing-store rectangle on the board canvases.
  cx: number
  cy: number
  cw: number
  ch: number
  // Canvas pixels per NATIVE pixel of this display (cw / width).
  cscale: number
}

export interface BoardLayout {
  displays: BoardDisplay[]
  /** Board-unit size of the whole arrangement. */
  width: number
  height: number
  /** Canvas pixels per board unit. */
  ratio: number
  canvasWidth: number
  canvasHeight: number
  /** Index (the manifest display index) of the focused display. */
  focusedIndex: number
}

/** What buildBoard needs about one display. */
export interface BoardInput {
  index: number
  focused: boolean
  width: number
  height: number
  hasReplay: boolean
  bounds: { x: number; y: number; width: number; height: number }
}

/**
 * Total backing-store pixels the two board canvases may each cost.
 *
 * A 4K display is 8.3 MP, so a single-display board keeps its native
 * resolution exactly as the pre-board editor did (12 MP is never reached, and
 * `ratio` is capped at native anyway). A two-4K-display board would want 16 MP;
 * this holds it at 12 MP (~48 MB per canvas, base + overlay = ~96 MB), which is
 * the same order as the ONE 4K pair the editor already allocated, and it stays
 * flat as displays are added — a third screen shrinks `ratio`, not the budget.
 *
 * The price is honest and bounded: on a board that hits the cap, each display
 * is rendered at slightly under its native resolution, so zooming far in shows
 * a softer image than a single-display capture does. Annotation geometry is
 * unaffected — bounds are stored in native pixels, never in canvas pixels.
 */
const BOARD_PIXEL_BUDGET = 12_000_000

/** Below this, a board canvas is too coarse to annotate on at all. */
const MIN_RATIO = 0.25

/**
 * Lays the displays out in their real arrangement and sizes the board canvases.
 *
 * `bounds` is trusted only as far as it is usable: entries that are missing,
 * degenerate, or that OVERLAP each other (a mirrored/cloned setup, or a
 * hand-edited manifest) fall back to a simple left-to-right strip in index
 * order. Both layouts are real arrangements of real displays; the fallback just
 * cannot claim to be the desk.
 */
export function buildBoard(inputs: readonly BoardInput[]): BoardLayout {
  const usable = inputs.length > 0 ? inputs : []
  if (usable.length === 0) {
    // Never happens through the editor (it always synthesizes at least the
    // focused display), but a layout with no displays must still be a layout.
    return { displays: [], width: 1, height: 1, ratio: 1, canvasWidth: 1, canvasHeight: 1, focusedIndex: 0 }
  }
  const rects = arrange(usable)
  let width = 0
  let height = 0
  for (const r of rects) {
    width = Math.max(width, r.bx + r.bw)
    height = Math.max(height, r.by + r.bh)
  }
  width = Math.max(1, width)
  height = Math.max(1, height)

  // Never upscale: the sharpest a display can be drawn is its own native
  // resolution, so the ratio that gives every display native pixels is the
  // ceiling. The budget then pulls it down if the board is large.
  let nativeRatio = 0
  for (const r of rects) {
    nativeRatio = Math.max(nativeRatio, r.bw > 0 ? r.width / r.bw : 1)
  }
  if (!(nativeRatio > 0)) nativeRatio = 1
  const budgetRatio = Math.sqrt(BOARD_PIXEL_BUDGET / (width * height))
  const ratio = Math.max(MIN_RATIO, Math.min(nativeRatio, budgetRatio))

  const canvasWidth = Math.max(1, Math.round(width * ratio))
  const canvasHeight = Math.max(1, Math.round(height * ratio))
  const displays: BoardDisplay[] = rects.map((r) => {
    const cx = Math.round(r.bx * ratio)
    const cy = Math.round(r.by * ratio)
    const cw = Math.max(1, Math.round(r.bw * ratio))
    const ch = Math.max(1, Math.round(r.bh * ratio))
    return {
      index: r.index,
      focused: r.focused,
      width: r.width,
      height: r.height,
      hasReplay: r.hasReplay,
      bx: r.bx,
      by: r.by,
      bw: r.bw,
      bh: r.bh,
      cx,
      cy,
      cw,
      ch,
      cscale: r.width > 0 ? cw / r.width : 1,
    }
  })
  const focusedIndex = displays.find((d) => d.focused)?.index ?? displays[0]?.index ?? 0
  return { displays, width, height, ratio, canvasWidth, canvasHeight, focusedIndex }
}

interface Placed extends BoardInput {
  bx: number
  by: number
  bw: number
  bh: number
}

function arrange(inputs: readonly BoardInput[]): Placed[] {
  const real = fromBounds(inputs)
  if (real !== null) return real
  return strip(inputs)
}

/** The real desk: virtual-desktop rectangles, origin-normalized. */
function fromBounds(inputs: readonly BoardInput[]): Placed[] | null {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  for (const d of inputs) {
    const b = d.bounds
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) return null
    if (!(b.width > 0) || !(b.height > 0)) return null
    minX = Math.min(minX, b.x)
    minY = Math.min(minY, b.y)
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null
  const placed = inputs.map((d) => ({
    ...d,
    bx: d.bounds.x - minX,
    by: d.bounds.y - minY,
    bw: d.bounds.width,
    bh: d.bounds.height,
  }))
  // Overlapping rectangles are a cloned/mirrored setup (or a hand-edited
  // manifest): drawing them on top of each other would hide a whole screen and
  // make half the board unclickable.
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      if (overlaps(placed[i], placed[j])) return null
    }
  }
  return placed
}

/** Fallback: a left-to-right strip, top-aligned, in index order. */
function strip(inputs: readonly BoardInput[]): Placed[] {
  const ordered = [...inputs].sort((a, b) => a.index - b.index)
  let x = 0
  const placed: Placed[] = []
  for (const d of ordered) {
    // Board units are DIPs; without usable bounds, native pixels are the only
    // size this display has, and `scale` is not knowable from here.
    const bw = d.bounds.width > 0 ? d.bounds.width : d.width
    const bh = d.bounds.height > 0 ? d.bounds.height : d.height
    placed.push({ ...d, bx: x, by: 0, bw, bh })
    x += bw
  }
  return placed
}

function overlaps(a: Placed | undefined, b: Placed | undefined): boolean {
  if (a === undefined || b === undefined) return false
  return a.bx < b.bx + b.bw && b.bx < a.bx + a.bw && a.by < b.by + b.bh && b.by < a.by + a.bh
}

/** The board display a board-unit point falls on, or null (a gutter/outside). */
export function displayAtBoardPoint(
  board: BoardLayout,
  bx: number,
  by: number,
): BoardDisplay | null {
  for (const d of board.displays) {
    if (bx >= d.bx && by >= d.by && bx <= d.bx + d.bw && by <= d.by + d.bh) return d
  }
  return null
}

/** A board-unit point expressed in one display's NATIVE snapshot pixels. */
export function toNativePoint(
  d: BoardDisplay,
  bx: number,
  by: number,
): { x: number; y: number } {
  const sx = d.bw > 0 ? d.width / d.bw : 1
  const sy = d.bh > 0 ? d.height / d.bh : 1
  return {
    x: clamp(Math.round((bx - d.bx) * sx), 0, d.width),
    y: clamp(Math.round((by - d.by) * sy), 0, d.height),
  }
}

/** A display's NATIVE point back in board units (for screen-space chrome). */
export function toBoardPoint(d: BoardDisplay, x: number, y: number): { x: number; y: number } {
  const sx = d.width > 0 ? d.bw / d.width : 1
  const sy = d.height > 0 ? d.bh / d.height : 1
  return { x: d.bx + x * sx, y: d.by + y * sy }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}
