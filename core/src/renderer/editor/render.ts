// Canvas drawing for the annotation overlay and the exported snapshot.
// All coordinates are native snapshot pixels; `ui` (= 1 / effective on-screen
// scale, zoom included) converts desired on-screen pixel sizes into native
// units so strokes look constant.
import type { Annotation, BlurAnnotation, TextAnnotation } from '../../shared/types'

const BLUR_BLOCK = 12 // native px per pixelation block
const PIN_R = 12

interface Box {
  x: number
  y: number
  w: number
  h: number
}

function must<T>(v: T | null): T {
  if (v === null) throw new Error('canvas 2d context unavailable')
  return v
}

function textFont(a: TextAnnotation): string {
  return `700 ${a.size ?? 24}px "Segoe UI", system-ui, sans-serif`
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
  const tiny = document.createElement('canvas')
  tiny.width = Math.max(1, Math.round(cw / BLUR_BLOCK))
  tiny.height = Math.max(1, Math.round(ch / BLUR_BLOCK))
  const tctx = must(tiny.getContext('2d'))
  tctx.drawImage(source, x0, y0, cw, ch, 0, 0, tiny.width, tiny.height)
  ctx.save()
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(tiny, 0, 0, tiny.width, tiny.height, x0, y0, cw, ch)
  ctx.restore()
}

export function drawScene(
  ctx: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  annotations: readonly Annotation[],
  selectedId: string | null,
  ui: number,
): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  const ordered = [...annotations].sort((a, b) => a.z - b.z)
  for (const a of ordered) {
    ctx.save()
    drawAnnotation(ctx, source, a, ui)
    ctx.restore()
  }
  if (selectedId !== null) {
    const sel = annotations.find((a) => a.id === selectedId)
    if (sel) drawSelection(ctx, sel, ui)
  }
}

function drawAnnotation(
  ctx: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  a: Annotation,
  ui: number,
): void {
  switch (a.type) {
    case 'pin': {
      const r = PIN_R * ui
      ctx.beginPath()
      ctx.arc(a.x, a.y, r, 0, Math.PI * 2)
      ctx.fillStyle = a.color
      ctx.fill()
      ctx.lineWidth = 2 * ui
      ctx.strokeStyle = '#ffffff'
      ctx.stroke()
      ctx.fillStyle = '#ffffff'
      ctx.font = `700 ${Math.round(13 * ui)}px "Segoe UI", system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(a.label ?? '', a.x, a.y + ui)
      break
    }
    case 'arrow': {
      const dx = a.x2 - a.x1
      const dy = a.y2 - a.y1
      const len = Math.hypot(dx, dy)
      if (len < 1) break
      const ux = dx / len
      const uy = dy / len
      const head = Math.min(16 * ui, len * 0.5)
      ctx.strokeStyle = a.color
      ctx.fillStyle = a.color
      ctx.lineWidth = 3.5 * ui
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(a.x1, a.y1)
      ctx.lineTo(a.x2 - ux * head * 0.8, a.y2 - uy * head * 0.8)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(a.x2, a.y2)
      ctx.lineTo(a.x2 - ux * head - uy * head * 0.45, a.y2 - uy * head + ux * head * 0.45)
      ctx.lineTo(a.x2 - ux * head + uy * head * 0.45, a.y2 - uy * head - ux * head * 0.45)
      ctx.closePath()
      ctx.fill()
      break
    }
    case 'rect':
      ctx.strokeStyle = a.color
      ctx.lineWidth = 3 * ui
      ctx.strokeRect(a.x, a.y, a.w, a.h)
      break
    case 'blur':
      pixelate(ctx, source, a.x, a.y, a.w, a.h)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)'
      ctx.lineWidth = ui
      ctx.strokeRect(a.x, a.y, a.w, a.h)
      break
    case 'text':
      ctx.font = textFont(a)
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.lineJoin = 'round'
      ctx.lineWidth = 3 * ui
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)'
      ctx.strokeText(a.text, a.x, a.y)
      ctx.fillStyle = a.color
      ctx.fillText(a.text, a.x, a.y)
      break
  }
}

function annotationBounds(ctx: CanvasRenderingContext2D, a: Annotation, ui: number): Box {
  switch (a.type) {
    case 'pin': {
      const r = PIN_R * ui
      return { x: a.x - r, y: a.y - r, w: r * 2, h: r * 2 }
    }
    case 'arrow':
      return {
        x: Math.min(a.x1, a.x2),
        y: Math.min(a.y1, a.y2),
        w: Math.abs(a.x2 - a.x1),
        h: Math.abs(a.y2 - a.y1),
      }
    case 'rect':
    case 'blur':
      return { x: a.x, y: a.y, w: a.w, h: a.h }
    case 'text': {
      ctx.save()
      ctx.font = textFont(a)
      const w = ctx.measureText(a.text).width
      ctx.restore()
      const size = a.size ?? 24
      return { x: a.x, y: a.y, w, h: size * 1.25 }
    }
  }
}

function drawSelection(ctx: CanvasRenderingContext2D, a: Annotation, ui: number): void {
  const b = annotationBounds(ctx, a, ui)
  const pad = 6 * ui
  ctx.save()
  ctx.strokeStyle = '#8ab4ff'
  ctx.lineWidth = 1.5 * ui
  ctx.setLineDash([6 * ui, 4 * ui])
  ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2)
  ctx.restore()
}

function inBox(x: number, y: number, b: Box, pad: number): boolean {
  return x >= b.x - pad && y >= b.y - pad && x <= b.x + b.w + pad && y <= b.y + b.h + pad
}

function segDist(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

/** Returns the id of the topmost annotation at native point (x, y), or null. */
export function hitTest(
  ctx: CanvasRenderingContext2D,
  annotations: readonly Annotation[],
  x: number,
  y: number,
  ui: number,
): string | null {
  const tol = 6 * ui
  const ordered = [...annotations].sort((a, b) => b.z - a.z)
  for (const a of ordered) {
    if (hits(ctx, a, x, y, ui, tol)) return a.id
  }
  return null
}

function hits(
  ctx: CanvasRenderingContext2D,
  a: Annotation,
  x: number,
  y: number,
  ui: number,
  tol: number,
): boolean {
  switch (a.type) {
    case 'pin':
      return Math.hypot(x - a.x, y - a.y) <= PIN_R * ui + tol * 0.5
    case 'arrow':
      return segDist(x, y, a.x1, a.y1, a.x2, a.y2) <= tol
    case 'blur':
      return inBox(x, y, a, tol)
    case 'rect':
      // Stroke-only shape: hit near the border, not deep inside.
      return inBox(x, y, a, tol) && !inBox(x, y, a, -tol)
    case 'text':
      return inBox(x, y, annotationBounds(ctx, a, ui), tol * 0.5)
  }
}

/** Original snapshot with blur regions destructively pixelated, as PNG bytes. */
export async function composeExportPng(
  source: HTMLCanvasElement,
  blurs: readonly BlurAnnotation[],
): Promise<ArrayBuffer> {
  const out = document.createElement('canvas')
  out.width = source.width
  out.height = source.height
  const ctx = must(out.getContext('2d'))
  ctx.drawImage(source, 0, 0)
  for (const b of blurs) pixelate(ctx, source, b.x, b.y, b.w, b.h)
  const blob = await new Promise<Blob>((resolve, reject) => {
    out.toBlob((b) => (b ? resolve(b) : reject(new Error('snapshot encode failed'))), 'image/png')
  })
  return blob.arrayBuffer()
}
