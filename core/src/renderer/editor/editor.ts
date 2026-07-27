// Annotation editor renderer: keyboard-first tools over the captured snapshot.
// Annotations live in native snapshot pixel coords; display is a CSS-scaled fit.
import type {
  EditorAnnotationAddedPayload,
  EditorExportPayload,
  EditorInitPayload,
} from '../../shared/ipc'
import type { Annotation, BlurAnnotation } from '../../shared/types'
import { EditorState, type Tool } from './state'
import { composeExportPng, drawScene, hitTest } from './render'

interface EditorBridge {
  onInit(cb: (payload: EditorInitPayload) => void): void
  export(payload: EditorExportPayload): void
  cancel(): void
  annotationAdded(payload: EditorAnnotationAddedPayload): void
}

declare global {
  interface Window {
    editorBridge: EditorBridge
  }
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`missing #${id}`)
  return node as T
}

const stage = el<HTMLElement>('stage')
const frame = el<HTMLDivElement>('frame')
const snapshot = el<HTMLCanvasElement>('snapshot')
const overlay = el<HTMLCanvasElement>('overlay')
const textEditor = el<HTMLInputElement>('textEditor')
const titleInput = el<HTMLInputElement>('titleInput')
const noteInput = el<HTMLInputElement>('noteInput')
const replayChip = el<HTMLSpanElement>('replayChip')
const replayToggle = el<HTMLLabelElement>('replayToggle')
const includeReplay = el<HTMLInputElement>('includeReplay')
const blurWarning = el<HTMLDivElement>('blurWarning')
const excludeReplayBtn = el<HTMLButtonElement>('excludeReplayBtn')
const colorBtn = el<HTMLButtonElement>('colorBtn')
const colorSwatch = el<HTMLSpanElement>('colorSwatch')
const exportBtn = el<HTMLButtonElement>('exportBtn')
const toolButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>('#tools .tool[data-tool]'),
)

function ctx2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d context unavailable')
  return ctx
}

const snapCtx = ctx2d(snapshot)
const overlayCtx = ctx2d(overlay)

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const MIN_DRAG = 3 // native px below which a drag commits nothing

const state = new EditorState()
let tool: Tool = 'rect'
let nativeW = 0
let nativeH = 0
let hasReplay = false
let fitScale = 1
let loaded = false
let exporting = false

type DrawTool = 'arrow' | 'rect' | 'blur'
type Drag =
  | { kind: 'draw'; tool: DrawTool; x0: number; y0: number; x: number; y: number }
  | { kind: 'move'; id: string; lastX: number; lastY: number; before: Annotation[]; moved: boolean }
let drag: Drag | null = null
let pendingText: { x: number; y: number; size: number } | null = null

// ---------------------------------------------------------------------------
// Layout + painting
// ---------------------------------------------------------------------------

function layout(): void {
  if (!loaded) return
  const pad = 24
  const availW = Math.max(1, stage.clientWidth - pad * 2)
  const availH = Math.max(1, stage.clientHeight - pad * 2)
  fitScale = Math.min(availW / nativeW, availH / nativeH, 1)
  frame.style.width = `${nativeW * fitScale}px`
  frame.style.height = `${nativeH * fitScale}px`
  positionTextEditor()
}

let paintQueued = false
function schedulePaint(): void {
  if (paintQueued) return
  paintQueued = true
  requestAnimationFrame(() => {
    paintQueued = false
    if (!loaded) return
    drawScene(overlayCtx, snapshot, sceneAnnotations(), state.selectedId, 1 / fitScale)
  })
}

function sceneAnnotations(): readonly Annotation[] {
  const draft = drag?.kind === 'draw' ? draftFromDrag(drag) : null
  return draft ? [...state.annotations, draft] : state.annotations
}

function refresh(): void {
  syncBlurWarning()
  schedulePaint()
}

function syncBlurWarning(): void {
  const show = hasReplay && includeReplay.checked && state.annotations.some((a) => a.type === 'blur')
  blurWarning.hidden = !show
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function setTool(next: Tool): void {
  tool = next
  if (next !== 'select') state.selectedId = null
  for (const btn of toolButtons) btn.classList.toggle('active', btn.dataset['tool'] === next)
  overlay.style.cursor = next === 'select' ? 'default' : next === 'text' ? 'text' : 'crosshair'
  overlay.focus()
  schedulePaint()
}

function cycleColor(): void {
  state.cycleColor()
  colorSwatch.style.background = state.color
  textEditor.style.color = state.color
}

function toNative(e: PointerEvent): { x: number; y: number } {
  const r = overlay.getBoundingClientRect()
  const x = Math.round((e.clientX - r.left) / fitScale)
  const y = Math.round((e.clientY - r.top) / fitScale)
  return { x: Math.max(0, Math.min(nativeW, x)), y: Math.max(0, Math.min(nativeH, y)) }
}

function draftFromDrag(d: {
  tool: DrawTool
  x0: number
  y0: number
  x: number
  y: number
}): Annotation | null {
  // Blur carries no color (SPEC §8.3), so color joins per-branch, not the base.
  const base = { id: 'draft', z: Number.MAX_SAFE_INTEGER, created_at: '' }
  if (d.tool === 'arrow') {
    if (Math.hypot(d.x - d.x0, d.y - d.y0) < MIN_DRAG) return null
    return { ...base, type: 'arrow', color: state.color, x1: d.x0, y1: d.y0, x2: d.x, y2: d.y }
  }
  const box = {
    x: Math.min(d.x0, d.x),
    y: Math.min(d.y0, d.y),
    w: Math.abs(d.x - d.x0),
    h: Math.abs(d.y - d.y0),
  }
  if (box.w < MIN_DRAG || box.h < MIN_DRAG) return null
  if (d.tool === 'rect') return { ...base, type: 'rect', color: state.color, ...box }
  return { ...base, type: 'blur', ...box }
}

function commitDraw(d: { tool: DrawTool; x0: number; y0: number; x: number; y: number }): void {
  const a = draftFromDrag(d)
  if (!a) return
  Object.assign(a, state.nextStamp())
  state.add(a)
  window.editorBridge.annotationAdded({ id: a.id, type: a.type })
  refresh()
}

function placePin(p: { x: number; y: number }): void {
  const a: Annotation = {
    ...state.nextStamp(),
    type: 'pin',
    x: p.x,
    y: p.y,
    color: state.color,
    label: state.nextPinLabel(),
  }
  state.add(a)
  window.editorBridge.annotationAdded({ id: a.id, type: a.type })
  refresh()
}

function moveAnnotation(a: Annotation, dx: number, dy: number): void {
  if (a.type === 'arrow') {
    a.x1 += dx
    a.y1 += dy
    a.x2 += dx
    a.y2 += dy
  } else {
    a.x += dx
    a.y += dy
  }
}

function deleteSelected(): void {
  if (state.selectedId === null) return
  state.remove(state.selectedId)
  refresh()
}

// ---------------------------------------------------------------------------
// Inline text annotation input
// ---------------------------------------------------------------------------

function openTextEditor(p: { x: number; y: number }): void {
  pendingText = { x: p.x, y: p.y, size: Math.max(14, Math.round(18 / fitScale)) }
  textEditor.value = ''
  textEditor.style.color = state.color
  textEditor.hidden = false
  positionTextEditor()
  textEditor.focus()
}

function positionTextEditor(): void {
  if (!pendingText) return
  textEditor.style.left = `${pendingText.x * fitScale}px`
  textEditor.style.top = `${pendingText.y * fitScale}px`
  textEditor.style.fontSize = `${pendingText.size * fitScale}px`
}

function commitTextEditor(refocus = true): void {
  if (!pendingText) return
  const p = pendingText
  const text = textEditor.value.trim()
  closeTextEditor(refocus)
  if (!text) return
  const a: Annotation = { ...state.nextStamp(), type: 'text', x: p.x, y: p.y, text, size: p.size, color: state.color }
  state.add(a)
  window.editorBridge.annotationAdded({ id: a.id, type: a.type })
  refresh()
}

function closeTextEditor(refocus = true): void {
  pendingText = null
  textEditor.hidden = true
  textEditor.value = ''
  if (refocus) overlay.focus()
}

textEditor.addEventListener('keydown', (e) => {
  e.stopPropagation()
  if (e.key === 'Enter') commitTextEditor()
  else if (e.key === 'Escape') closeTextEditor()
})
textEditor.addEventListener('blur', () => commitTextEditor(false))

// ---------------------------------------------------------------------------
// Pointer input
// ---------------------------------------------------------------------------

overlay.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !loaded) return
  const p = toNative(e)
  if (tool === 'text') {
    // Keep focus under our control: default mousedown focus would blur the
    // inline input the moment we open it.
    e.preventDefault()
    commitTextEditor()
    openTextEditor(p)
    return
  }
  commitTextEditor()
  if (tool === 'pin') {
    placePin(p)
    return
  }
  if (tool === 'select') {
    const id = hitTest(overlayCtx, state.annotations, p.x, p.y, 1 / fitScale)
    state.selectedId = id
    if (id !== null) {
      overlay.setPointerCapture(e.pointerId)
      drag = { kind: 'move', id, lastX: p.x, lastY: p.y, before: state.cloneAnnotations(), moved: false }
    }
    schedulePaint()
    return
  }
  if (tool === 'arrow' || tool === 'rect' || tool === 'blur') {
    overlay.setPointerCapture(e.pointerId)
    drag = { kind: 'draw', tool, x0: p.x, y0: p.y, x: p.x, y: p.y }
  }
})

overlay.addEventListener('pointermove', (e) => {
  if (!drag) return
  const p = toNative(e)
  if (drag.kind === 'draw') {
    drag.x = p.x
    drag.y = p.y
  } else {
    const a = state.byId(drag.id)
    if (a && (p.x !== drag.lastX || p.y !== drag.lastY)) {
      moveAnnotation(a, p.x - drag.lastX, p.y - drag.lastY)
      drag.moved = true
    }
    drag.lastX = p.x
    drag.lastY = p.y
  }
  schedulePaint()
})

function endDrag(): void {
  if (!drag) return
  const d = drag
  drag = null
  if (d.kind === 'draw') commitDraw(d)
  else if (d.moved) state.pushUndoSnapshot(d.before)
  schedulePaint()
}

overlay.addEventListener('pointerup', endDrag)
overlay.addEventListener('pointercancel', endDrag)

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  if (e.isComposing || e.target === textEditor) return
  const typing = e.target === titleInput || e.target === noteInput
  if (e.key === 'Escape') {
    window.editorBridge.cancel()
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    void doExport()
    return
  }
  if (typing) return
  if (e.ctrlKey || e.metaKey) {
    const k = e.key.toLowerCase()
    if (k === 'z' || k === 'y') {
      e.preventDefault()
      if (k === 'y' || e.shiftKey) state.redo()
      else state.undo()
      refresh()
    }
    return
  }
  if (e.altKey) return
  switch (e.key.toLowerCase()) {
    case 'v':
      setTool('select')
      break
    case 'p':
      setTool('pin')
      break
    case 'a':
      setTool('arrow')
      break
    case 'r':
      setTool('rect')
      break
    case 'b':
      setTool('blur')
      break
    case 't':
      setTool('text')
      break
    case 'c':
      cycleColor()
      break
    case 'delete':
    case 'backspace':
      deleteSelected()
      break
  }
})

// ---------------------------------------------------------------------------
// Top bar controls
// ---------------------------------------------------------------------------

for (const btn of toolButtons) {
  btn.addEventListener('click', () => setTool(btn.dataset['tool'] as Tool))
}
colorBtn.addEventListener('click', () => {
  cycleColor()
  colorBtn.blur()
})
exportBtn.addEventListener('click', () => void doExport())
includeReplay.addEventListener('change', syncBlurWarning)
excludeReplayBtn.addEventListener('click', () => {
  includeReplay.checked = false
  syncBlurWarning()
})

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

async function doExport(): Promise<void> {
  if (!loaded || exporting) return
  exporting = true
  exportBtn.disabled = true
  commitTextEditor()
  try {
    const blurs = state.annotations.filter((a): a is BlurAnnotation => a.type === 'blur')
    const snapshotPng = await composeExportPng(snapshot, blurs)
    window.editorBridge.export({
      annotations: state.annotations,
      snapshotPng,
      title: titleInput.value.trim(),
      note: noteInput.value.trim(),
      includeReplay: hasReplay && includeReplay.checked,
    })
  } catch (err) {
    exporting = false
    exportBtn.disabled = false
    throw err
  }
}

async function initEditor(payload: EditorInitPayload): Promise<void> {
  nativeW = payload.width
  nativeH = payload.height
  hasReplay = payload.hasReplay
  const bitmap = await createImageBitmap(new Blob([payload.snapshotPng], { type: 'image/png' }))
  snapshot.width = nativeW
  snapshot.height = nativeH
  overlay.width = nativeW
  overlay.height = nativeH
  snapCtx.drawImage(bitmap, 0, 0, nativeW, nativeH)
  bitmap.close()
  replayChip.textContent = hasReplay
    ? `Replay: ${Math.round(payload.replayDurationMs / 1000)}s`
    : 'No replay'
  replayToggle.hidden = !hasReplay
  loaded = true
  layout()
  schedulePaint()
  overlay.focus()
}

window.addEventListener('resize', () => {
  layout()
  schedulePaint()
})

window.editorBridge.onInit((payload) => {
  void initEditor(payload)
})

setTool('rect')
colorSwatch.style.background = state.color
