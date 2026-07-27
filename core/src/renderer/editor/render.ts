// Canvas drawing for the box-annotation overlay and the exported snapshot.
// All coordinates are native snapshot pixels; `ui` (= 1 / effective on-screen
// scale, zoom included) converts desired on-screen pixel sizes into native
// units so strokes look constant.
//
// Per-frame draw order matches the annotated-replay renderer (SPEC §7.2):
// original frame -> blur pass -> border/badge/text per box (z ascending).
// Selection chrome (dashed rect + corner handles) is EDITOR-ONLY: it lives on
// the overlay canvas, which is never part of the exported snapshot.
import type { Annotation } from '../../shared/types'

const BLUR_BLOCK = 12 // native px per pixelation block (matches render/render.ts)
const FALLBACK_COLOR = '#FF3B30' // boxes without style.color (palette default)
const HANDLE_R = 4.5 // on-screen px, half the side of a corner resize handle
const OBJECT_HOVER_COLOR = '#8ab4ff' // same accent the selection rect uses

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

// Pad between a box's bounds and its dashed selection rect; the floating
// selection header anchors to the padded top-left corner too.
export const SELECTION_PAD = 6

export type HandleId = 'nw' | 'ne' | 'sw' | 'se'

function must<T>(v: T | null): T {
  if (v === null) throw new Error('canvas 2d context unavailable')
  return v
}

export function boxColor(a: Annotation): string {
  return a.style?.color ?? FALLBACK_COLOR
}

// ONE reusable downscale buffer for the blur pass. The overlay repaints on
// every pointer move that changes the hovered UI object (GOAL "Static object
// picking"), so allocating a canvas per blurred box per frame was allocating —
// and garbage-collecting — several canvases per frame while the user simply
// swept the mouse across the image.
let blurScratch: HTMLCanvasElement | null = null

function scratchCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = blurScratch ?? document.createElement('canvas')
  blurScratch = canvas
  canvas.width = width
  canvas.height = height
  return canvas
}

/** Draws a pixelated copy of a source region onto ctx (both in native coords). */
function pixelate(
  ctx: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const x0 = Math.max(0, Math.floor(x))
  const y0 = Math.max(0, Math.floor(y))
  const cw = Math.min(Math.ceil(w), source.width - x0)
  const ch = Math.min(Math.ceil(h), source.height - y0)
  if (cw < 1 || ch < 1) return
  const tiny = scratchCanvas(
    Math.max(1, Math.round(cw / BLUR_BLOCK)),
    Math.max(1, Math.round(ch / BLUR_BLOCK)),
  )
  const tctx = must(tiny.getContext('2d'))
  // Setting width/height already clears it; this only matters if a future
  // caller reuses the same size back to back.
  tctx.clearRect(0, 0, tiny.width, tiny.height)
  tctx.drawImage(source, x0, y0, cw, ch, 0, 0, tiny.width, tiny.height)
  ctx.save()
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(tiny, 0, 0, tiny.width, tiny.height, x0, y0, cw, ch)
  ctx.restore()
}

/**
 * Paints all given boxes onto the overlay. `annotations` is the set to draw
 * (already lifetime-filtered by the caller; may include ephemeral drafts);
 * `numbers` is the GLOBAL display-number map from computeDisplayNumbers over
 * ALL annotations, so numbering never re-compresses to the visible subset.
 */
export function drawScene(
  ctx: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  annotations: readonly Annotation[],
  selectedId: string | null,
  numbers: ReadonlyMap<string, number>,
  ui: number,
): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  const ordered = [...annotations].sort((a, b) => a.z - b.z)
  // Blur pass first (live non-destructive preview — the base canvas keeps the
  // original pixels), so borders and badges are never pixelated.
  for (const a of ordered) {
    if (a.blur) pixelate(ctx, source, a.bounds.x, a.bounds.y, a.bounds.width, a.bounds.height)
  }
  for (const a of ordered) {
    ctx.save()
    drawBox(ctx, a, numbers.get(a.annotation_id), ui)
    ctx.restore()
  }
  if (selectedId !== null) {
    const sel = annotations.find((a) => a.annotation_id === selectedId)
    if (sel) drawSelection(ctx, sel, ui)
  }
}

/** Border + number badge (top-left corner) + text label for one box. */
function drawBox(
  ctx: CanvasRenderingContext2D,
  a: Annotation,
  displayNumber: number | undefined,
  ui: number,
): void {
  const { x, y, width: w, height: h } = a.bounds
  const color = boxColor(a)

  ctx.strokeStyle = color
  ctx.lineWidth = 3 * ui
  ctx.strokeRect(x, y, w, h)

  if (a.numbered) {
    const r = 12 * ui
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    ctx.lineWidth = 2 * ui
    ctx.strokeStyle = '#ffffff'
    ctx.stroke()
    ctx.fillStyle = '#ffffff'
    ctx.font = `700 ${Math.round(13 * ui)}px "Segoe UI", system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(displayNumber !== undefined ? String(displayNumber) : '·', x, y + ui)
  }

  const text = a.text.trim()
  if (text !== '') {
    ctx.font = `700 ${Math.round(14 * ui)}px "Segoe UI", system-ui, sans-serif`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    const pad = 5 * ui
    const metrics = ctx.measureText(text)
    const lineH = 18 * ui
    // Below the box when it fits, above otherwise; clamped into the frame.
    let ty = y + h + pad
    if (ty + lineH + pad > ctx.canvas.height) ty = y - lineH - pad * 2
    ty = Math.max(pad, ty)
    const tx = Math.min(Math.max(pad, x), Math.max(pad, ctx.canvas.width - metrics.width - pad * 2))
    ctx.fillStyle = 'rgba(0, 0, 0, 0.65)'
    ctx.fillRect(tx - pad, ty - pad * 0.5, metrics.width + pad * 2, lineH + pad)
    ctx.fillStyle = '#ffffff'
    ctx.fillText(text, tx, ty)
  }
}

/** Native-pixel bounding box of a box annotation. */
export function annotationBounds(a: Annotation): Box {
  return { x: a.bounds.x, y: a.bounds.y, w: a.bounds.width, h: a.bounds.height }
}

/** The four corner-handle centers of a box (editor-only resize chrome). */
function handleCenters(a: Annotation): Array<{ id: HandleId; x: number; y: number }> {
  const { x, y, width: w, height: h } = a.bounds
  return [
    { id: 'nw', x, y },
    { id: 'ne', x: x + w, y },
    { id: 'sw', x, y: y + h },
    { id: 'se', x: x + w, y: y + h },
  ]
}

function drawSelection(ctx: CanvasRenderingContext2D, a: Annotation, ui: number): void {
  const b = annotationBounds(a)
  const pad = SELECTION_PAD * ui
  ctx.save()
  ctx.strokeStyle = '#8ab4ff'
  ctx.lineWidth = 1.5 * ui
  ctx.setLineDash([6 * ui, 4 * ui])
  ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2)
  ctx.setLineDash([])
  const r = HANDLE_R * ui
  for (const c of handleCenters(a)) {
    ctx.fillStyle = '#ffffff'
    ctx.strokeStyle = '#3574f0'
    ctx.lineWidth = 1.5 * ui
    ctx.fillRect(c.x - r, c.y - r, r * 2, r * 2)
    ctx.strokeRect(c.x - r, c.y - r, r * 2, r * 2)
  }
  ctx.restore()
}

/**
 * Static object picking hover (GOAL "Static object picking (v0)"): the UI
 * Automation element under the cursor, outlined thin in the selection accent
 * with a tiny label naming it. Pure editor chrome, like the selection rect —
 * it lives on the overlay canvas and is never part of any exported pixels.
 */
export function drawObjectHover(
  ctx: CanvasRenderingContext2D,
  box: Box,
  label: string,
  ui: number,
): void {
  ctx.save()
  ctx.strokeStyle = OBJECT_HOVER_COLOR
  ctx.lineWidth = 1.5 * ui
  ctx.strokeRect(box.x, box.y, box.w, box.h)
  const text = label.trim()
  if (text !== '') {
    const clipped = text.length > 64 ? `${text.slice(0, 63)}…` : text
    ctx.font = `600 ${Math.round(11 * ui)}px "Segoe UI", system-ui, sans-serif`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    const pad = 4 * ui
    const lineH = 14 * ui
    const width = ctx.measureText(clipped).width
    // Above the outline when it fits, inside its top edge otherwise.
    let ty = box.y - lineH - pad * 2
    if (ty < pad) ty = box.y + pad
    const tx = Math.min(Math.max(pad, box.x), Math.max(pad, ctx.canvas.width - width - pad * 2))
    ctx.fillStyle = 'rgba(10, 10, 14, 0.82)'
    ctx.fillRect(tx - pad, ty, width + pad * 2, lineH + pad)
    ctx.fillStyle = OBJECT_HOVER_COLOR
    ctx.fillText(clipped, tx, ty + pad * 0.5)
  }
  ctx.restore()
}

function inBox(x: number, y: number, b: Box, pad: number): boolean {
  return x >= b.x - pad && y >= b.y - pad && x <= b.x + b.w + pad && y <= b.y + b.h + pad
}

/**
 * Returns the id of the topmost box at native point (x, y), or null. Toolless
 * selection (GOAL): a left click selects the topmost box whose lifetime is
 * visible at the cursor — callers pass the lifetime-filtered set.
 */
export function hitTest(
  annotations: readonly Annotation[],
  x: number,
  y: number,
  ui: number,
): string | null {
  const tol = 6 * ui
  const ordered = [...annotations].sort((a, b) => b.z - a.z)
  for (const a of ordered) {
    if (inBox(x, y, annotationBounds(a), tol)) return a.annotation_id
  }
  return null
}

/** The corner resize handle of `a` at native point (x, y), or null. */
export function handleAt(a: Annotation, x: number, y: number, ui: number): HandleId | null {
  const r = (HANDLE_R + 3) * ui // slightly generous hit area
  for (const c of handleCenters(a)) {
    if (Math.abs(x - c.x) <= r && Math.abs(y - c.y) <= r) return c.id
  }
  return null
}

/**
 * The exported snapshot: the ORIGINAL base frame, untouched (SPEC §9). Blur is
 * non-destructive — it renders only into derived views (replay_annotated.webm,
 * the editor preview), never into snapshot.png.
 */
export async function composeExportPng(source: HTMLCanvasElement): Promise<ArrayBuffer> {
  const out = document.createElement('canvas')
  out.width = source.width
  out.height = source.height
  const ctx = must(out.getContext('2d'))
  ctx.drawImage(source, 0, 0)
  const blob = await new Promise<Blob>((resolve, reject) => {
    out.toBlob((b) => (b ? resolve(b) : reject(new Error('snapshot encode failed'))), 'image/png')
  })
  return blob.arrayBuffer()
}
