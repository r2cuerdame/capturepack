// Static object picking (GOAL "Static object picking (v0 — before full
// tracking)"): the editor's index over the capture-instant Windows UI
// Automation elements that arrived in EditorInitPayload.uiaElements.
//
// Built ONCE at init; a pointer probe is then a couple of array scans, so
// hovering costs nothing per frame (and editor.ts probes only when the pointer
// actually moved to a new snapshot pixel).
import type { EditorUiaElement } from '../../shared/ipc'

/** Uniform grid cell, in snapshot pixels. */
const CELL = 64
/** Elements thinner than this in either axis are noise, not pick targets. */
const MIN_SIDE = 6
/**
 * An element covering most of the screen is a container (the window, its client
 * area, the desktop) — snapping a box onto it is never a useful annotation, and
 * including it would turn every click on empty space into a box. Left clicks on
 * anything bigger keep their old meaning: clear the selection.
 */
const MAX_AREA_FRACTION = 0.8
/**
 * Elements spanning more cells than this go into a linear overflow list instead
 * of being written into every cell they touch — an index build is O(elements),
 * never O(elements x screen area).
 */
const MAX_CELLS_PER_ELEMENT = 96

/** One pickable object: the element, clipped to the snapshot, with its area. */
export interface PickableObject {
  element: EditorUiaElement
  // Clipped to the snapshot rect — what a picked box snaps to.
  x: number
  y: number
  width: number
  height: number
  area: number
}

/** The label the hover chip shows: the element's name, else its control type. */
export function objectLabel(o: PickableObject): string {
  const name = o.element.name.trim()
  return name !== '' ? name : o.element.control_type.trim()
}

export class ObjectIndex {
  private readonly objects: readonly PickableObject[]
  private readonly cells: ReadonlyMap<number, number[]>
  private readonly wide: readonly number[]
  private readonly cols: number
  private readonly rows: number

  private constructor(
    objects: readonly PickableObject[],
    cells: ReadonlyMap<number, number[]>,
    wide: readonly number[],
    cols: number,
    rows: number,
  ) {
    this.objects = objects
    this.cells = cells
    this.wide = wide
    this.cols = cols
    this.rows = rows
  }

  /** Number of pickable objects — 0 means picking is simply off. */
  get size(): number {
    return this.objects.length
  }

  /**
   * Builds the index for one snapshot coordinate space. Elements are clipped to
   * the snapshot, filtered (see the constants above), and sorted by area
   * ascending so the FIRST hit of any scan is the smallest containing element.
   */
  static build(elements: readonly EditorUiaElement[], width: number, height: number): ObjectIndex {
    const maxArea = width * height * MAX_AREA_FRACTION
    const objects: PickableObject[] = []
    for (const element of elements) {
      const x0 = Math.max(0, Math.round(element.bounds.x))
      const y0 = Math.max(0, Math.round(element.bounds.y))
      const x1 = Math.min(width, Math.round(element.bounds.x + element.bounds.width))
      const y1 = Math.min(height, Math.round(element.bounds.y + element.bounds.height))
      const w = x1 - x0
      const h = y1 - y0
      // Off-screen elements (another display, a scrolled-away control) clip to
      // nothing and drop out here.
      if (w < MIN_SIDE || h < MIN_SIDE) continue
      const area = w * h
      if (area > maxArea) continue
      objects.push({ element, x: x0, y: y0, width: w, height: h, area })
    }
    objects.sort((a, b) => a.area - b.area)

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
    return new ObjectIndex(objects, cells, wide, cols, rows)
  }

  /** The smallest object containing the snapshot point, or null. */
  pick(x: number, y: number): PickableObject | null {
    if (this.objects.length === 0) return null
    const c = Math.floor(x / CELL)
    const r = Math.floor(y / CELL)
    let best: PickableObject | null = null
    if (c >= 0 && r >= 0 && c < this.cols && r < this.rows) {
      best = this.firstHit(this.cells.get(r * this.cols + c), x, y)
    }
    // Both lists are area-ascending, so one hit from each is enough.
    const wideHit = this.firstHit(this.wide, x, y)
    if (best === null) return wideHit
    if (wideHit === null) return best
    return wideHit.area < best.area ? wideHit : best
  }

  private firstHit(indices: readonly number[] | undefined, x: number, y: number): PickableObject | null {
    if (indices === undefined) return null
    for (const index of indices) {
      const o = this.objects[index]
      if (o === undefined) continue
      if (x >= o.x && y >= o.y && x <= o.x + o.width && y <= o.y + o.height) return o
    }
    return null
  }
}
