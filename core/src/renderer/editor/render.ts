// Canvas drawing for the board: the base image of every captured display and
// the box-annotation overlay on top of it (GOAL "Multi-Monitor Support" — every
// display is drawn at once and every one of them is annotatable).
//
// Coordinates are NATIVE snapshot pixels OF ONE DISPLAY. Each draw call puts
// the display's own transform on the context (board.ts owns that geometry), so
// everything below reads exactly as it did when the editor had a single canvas:
// bounds are native, and `ui` (= 1 / effective on-screen scale, zoom included)
// converts desired on-screen pixel sizes into native units so strokes look
// constant on every display of the board at once.
//
// Per-frame draw order matches the annotated-replay renderer (SPEC §7.2):
// original frame -> blur pass -> border/badge/text per box (z ascending).
// Selection chrome (dashed rect + corner handles) and the per-display frame and
// label are EDITOR-ONLY: they live on the overlay canvas, which is never part
// of any exported pixels.
import type { Annotation } from '../../shared/types'

const BLUR_BLOCK = 12 // native px per pixelation block (matches render/render.ts)
const FALLBACK_COLOR = '#FF3B30' // boxes without style.color (palette default)
const HANDLE_R = 4.5 // on-screen px, half the side of a corner resize handle
const OBJECT_HOVER_COLOR = '#8ab4ff' // same accent the selection rect uses
const FOCUSED_FRAME_COLOR = '#3574f0' // the focused display's accent
const FRAME_COLOR = 'rgba(255, 255, 255, 0.22)'

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/**
 * One display's place on the board canvases — structurally the subset of
 * BoardDisplay these drawing functions need.
 */
export interface DrawRegion {
  /** Backing-store rectangle of this display on the board canvases. */
  cx: number
  cy: number
  cw: number
  ch: number
  /** Canvas pixels per NATIVE pixel of this display. */
  cscale: number
  /** Native snapshot pixel size (the annotation coordinate space). */
  width: number
  height: number
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

/**
 * Puts one display's coordinate space on the context: native snapshot pixels,
 * clipped to that display's region so nothing can bleed onto its neighbour
 * (a box dragged to the very edge, a text label wider than the screen).
 * The caller restores.
 */
function enterDisplay(ctx: CanvasRenderingContext2D, region: DrawRegion): void {
  ctx.save()
  ctx.setTransform(region.cscale, 0, 0, region.cscale, region.cx, region.cy)
  ctx.beginPath()
  ctx.rect(0, 0, region.width, region.height)
  ctx.clip()
}

/**
 * Draws one display's base frame into its region of the board base canvas.
 * `source` is that display's current frame: a replay video seeked to the board
 * clock, or its frozen snapshot bitmap.
 */
export function drawDisplayBase(
  ctx: CanvasRenderingContext2D,
  region: DrawRegion,
  source: CanvasImageSource,
): void {
  ctx.save()
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, region.cx, region.cy, region.cw, region.ch)
  ctx.restore()
}

/** Clears one display's region (used when a frame is not available at all). */
export function clearDisplayRegion(ctx: CanvasRenderingContext2D, region: DrawRegion): void {
  ctx.save()
  ctx.fillStyle = '#0b0b0f'
  ctx.fillRect(region.cx, region.cy, region.cw, region.ch)
  ctx.restore()
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

/**
 * Draws a pixelated copy of a box's interior, sampling the BASE board canvas.
 *
 * The source rectangle is in canvas pixels (the base canvas is the board), the
 * destination in native pixels (the display transform is active). That split is
 * the only place the two spaces meet, and it is why the blur preview follows a
 * box across the board without a per-display scratch canvas.
 */
function pixelate(
  ctx: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  region: DrawRegion,
  b: Box,
): void {
  // Native rect, clamped into the display.
  const nx0 = Math.max(0, Math.floor(b.x))
  const ny0 = Math.max(0, Math.floor(b.y))
  const nx1 = Math.min(region.width, Math.ceil(b.x + b.w))
  const ny1 = Math.min(region.height, Math.ceil(b.y + b.h))
  const nw = nx1 - nx0
  const nh = ny1 - ny0
  if (nw < 1 || nh < 1) return
  // The same rect on the base canvas.
  const sx = Math.max(0, Math.round(region.cx + nx0 * region.cscale))
  const sy = Math.max(0, Math.round(region.cy + ny0 * region.cscale))
  const sw = Math.min(Math.round(nw * region.cscale), source.width - sx)
  const sh = Math.min(Math.round(nh * region.cscale), source.height - sy)
  if (sw < 1 || sh < 1) return
  const tiny = scratchCanvas(
    Math.max(1, Math.round(nw / BLUR_BLOCK)),
    Math.max(1, Math.round(nh / BLUR_BLOCK)),
  )
  const tctx = must(tiny.getContext('2d'))
  // Setting width/height already clears it; this only matters if a future
  // caller reuses the same size back to back.
  tctx.clearRect(0, 0, tiny.width, tiny.height)
  tctx.drawImage(source, sx, sy, sw, sh, 0, 0, tiny.width, tiny.height)
  ctx.save()
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(tiny, 0, 0, tiny.width, tiny.height, nx0, ny0, nw, nh)
  ctx.restore()
}

/**
 * Paints one display's boxes onto the overlay. `annotations` is the set to draw
 * for THIS display (already filtered by display and by lifetime; may include
 * ephemeral drafts); `numbers` is the GLOBAL display-number map from
 * computeDisplayNumbers over ALL annotations of the pack, so numbering is one
 * sequence across the whole board and never re-compresses to one screen.
 */
export function drawDisplayScene(
  ctx: CanvasRenderingContext2D,
  base: HTMLCanvasElement,
  region: DrawRegion,
  annotations: readonly Annotation[],
  selectedId: string | null,
  numbers: ReadonlyMap<string, number>,
  ui: number,
): void {
  enterDisplay(ctx, region)
  const ordered = [...annotations].sort((a, b) => a.z - b.z)
  // Blur pass first (live non-destructive preview — the base canvas keeps the
  // original pixels), so borders and badges are never pixelated.
  for (const a of ordered) {
    if (a.blur) pixelate(ctx, base, region, annotationBounds(a))
  }
  for (const a of ordered) {
    ctx.save()
    drawBox(ctx, a, numbers.get(a.annotation_id), ui, region)
    ctx.restore()
  }
  if (selectedId !== null) {
    const sel = annotations.find((a) => a.annotation_id === selectedId)
    if (sel) drawSelection(ctx, sel, ui)
  }
  ctx.restore()
}

/**
 * The per-display frame and caption — with no display picker in the top bar
 * (GOAL "Multi-Monitor Support"), THIS is what says which screen is which and
 * which one is focused. Drawn in BOARD canvas space, not inside the display
 * transform: the caption must stay the same size on every screen of the board,
 * whatever each one's pixel density is.
 *
 * `uiBoard` = 1 / on-screen scale of one board canvas pixel.
 */
export function drawDisplayFrame(
  ctx: CanvasRenderingContext2D,
  region: DrawRegion,
  label: string,
  focused: boolean,
  uiBoard: number,
): void {
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.strokeStyle = focused ? FOCUSED_FRAME_COLOR : FRAME_COLOR
  ctx.lineWidth = (focused ? 2 : 1) * uiBoard
  ctx.strokeRect(region.cx, region.cy, region.cw, region.ch)
  const text = label.trim()
  if (text !== '') {
    const fontPx = Math.round(12 * uiBoard)
    ctx.font = `600 ${fontPx}px "Segoe UI", system-ui, sans-serif`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    const pad = 5 * uiBoard
    const lineH = 15 * uiBoard
    const width = ctx.measureText(text).width
    // Inside the display's top-left corner: the caption belongs to the screen
    // it names, and a caption outside the frame would sit in the gutter
    // between two displays and read as belonging to either.
    const x = region.cx + pad
    const y = region.cy + pad
    ctx.fillStyle = focused ? 'rgba(53, 116, 240, 0.85)' : 'rgba(10, 10, 14, 0.72)'
    ctx.fillRect(x, y, width + pad * 2, lineH + pad)
    ctx.fillStyle = '#ffffff'
    ctx.fillText(text, x + pad, y + pad * 0.5)
  }
  ctx.restore()
}

/** Border + number badge (top-left corner) + text label for one box. */
function drawBox(
  ctx: CanvasRenderingContext2D,
  a: Annotation,
  displayNumber: number | undefined,
  ui: number,
  region: DrawRegion,
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
    // Below the box when it fits, above otherwise; clamped into THIS DISPLAY —
    // the board's other screens are not this box's canvas.
    let ty = y + h + pad
    if (ty + lineH + pad > region.height) ty = y - lineH - pad * 2
    ty = Math.max(pad, ty)
    const tx = Math.min(Math.max(pad, x), Math.max(pad, region.width - metrics.width - pad * 2))
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
 * object under the cursor, outlined thin in the selection accent with a tiny
 * label naming it. Pure editor chrome, like the selection rect — it lives on
 * the overlay canvas and is never part of any exported pixels.
 *
 * The two levels look different on purpose, because clicking gives different
 * boxes: a CONTROL is a solid outline, a WINDOW a lighter dashed one (it is
 * usually a big rectangle, and a solid frame that size reads as a selection).
 * The label says which level in words — the outline only has to make the
 * difference visible at a glance.
 */
export function drawObjectHover(
  ctx: CanvasRenderingContext2D,
  region: DrawRegion,
  box: Box,
  label: string,
  ui: number,
  level: 'control' | 'window' = 'control',
): void {
  enterDisplay(ctx, region)
  ctx.strokeStyle = OBJECT_HOVER_COLOR
  ctx.lineWidth = (level === 'window' ? 1 : 1.5) * ui
  if (level === 'window') ctx.setLineDash([7 * ui, 5 * ui])
  ctx.strokeRect(box.x, box.y, box.w, box.h)
  ctx.setLineDash([])
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
    const tx = Math.min(Math.max(pad, box.x), Math.max(pad, region.width - width - pad * 2))
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
 * visible at the cursor — callers pass the lifetime-filtered set of the display
 * the cursor is on, so a box can only ever be hit on its own screen.
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
 * The exported snapshot: the FOCUSED display's frame at its NATIVE resolution,
 * untouched (SPEC §9). Composed from the live frame source rather than from the
 * board canvas — the board is a bounded-memory VIEW of every display at once
 * (board.ts), and snapshot.png must keep every pixel the capture froze.
 *
 * Blur is non-destructive: it renders only into derived views
 * (replay_annotated.webm, the editor preview), never into snapshot.png.
 */
export async function composeExportPng(
  source: CanvasImageSource,
  width: number,
  height: number,
): Promise<ArrayBuffer> {
  const out = document.createElement('canvas')
  out.width = width
  out.height = height
  const ctx = must(out.getContext('2d'))
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, width, height)
  const blob = await new Promise<Blob>((resolve, reject) => {
    out.toBlob((b) => (b ? resolve(b) : reject(new Error('snapshot encode failed'))), 'image/png')
  })
  return blob.arrayBuffer()
}
