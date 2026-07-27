// Annotation editor renderer: keyboard-first tools over the captured snapshot.
// Annotations live in native snapshot pixel coords; display is a CSS-scaled fit.
// The base canvas shows either the native snapshot ("now") or a replay frame
// scaled to the same native rect, so annotations and export share one space.
import type {
  EditorAnnotationAddedPayload,
  EditorExportPayload,
  EditorInitPayload,
} from '../../shared/ipc'
import type { Annotation, BlurAnnotation, RectAnnotation } from '../../shared/types'
import { EditorState, type Tool } from './state'
import { formatDurationLabel, lifetimeAround, parseDurationMs, visibleAt } from './lifetime'
import { annotationBounds, composeExportPng, drawScene, hitTest, SELECTION_PAD } from './render'
import { ScrubController, wheelScrubDeltaMs } from './scrub'
import { Timebar } from './timebar'
import { Viewport } from './viewport'

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
const labelEditor = el<HTMLInputElement>('labelEditor')
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
const durationChip = el<HTMLButtonElement>('durationChip')
const deleteChip = el<HTMLButtonElement>('deleteChip')
const durationEditor = el<HTMLDivElement>('durationEditor')
const durationInput = el<HTMLInputElement>('durationInput')
const untilEndBtn = el<HTMLButtonElement>('untilEndBtn')
const entireCaptureBtn = el<HTMLButtonElement>('entireCaptureBtn')
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
let replayDurationMs = 0 // manifest replay_duration_ms; caps every t_ms stamp
let fitScale = 1
let loaded = false
let exporting = false
let fps = 15
let scrubInvert = false
let scrubSensitivityMs = 100
let defaultManualDurationMs = 1000
let showDurationLabel = true
// Original desktop snapshot, kept for restoring the "now" frame after scrubbing.
let nativeBitmap: ImageBitmap | null = null
let scrub: ScrubController | null = null
const viewport = new Viewport(frame)
let spaceDown = false
let panning: { pointerId: number; x: number; y: number } | null = null

type DrawTool = 'arrow' | 'rect' | 'blur'
type Drag =
  // `label: true` = right-click drag: opens the inline label input on release
  | { kind: 'draw'; tool: DrawTool; x0: number; y0: number; x: number; y: number; label: boolean }
  | { kind: 'move'; id: string; lastX: number; lastY: number; before: Annotation[]; moved: boolean }
let drag: Drag | null = null
let pendingText: { x: number; y: number; size: number } | null = null
// Right-click rectangle awaiting its label (committed on Enter/blur, discarded on Esc).
let pendingRect: { x: number; y: number; w: number; h: number } | null = null

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
  positionLabelEditor()
}

/** Paints the base image: a scrubbed replay frame or the native snapshot. */
function drawBase(source: HTMLVideoElement | 'native'): void {
  if (!loaded) return
  if (source === 'native') {
    if (nativeBitmap) snapCtx.drawImage(nativeBitmap, 0, 0, nativeW, nativeH)
  } else {
    // Video frames fill the native snapshot rect — one coordinate space.
    snapCtx.drawImage(source, 0, 0, nativeW, nativeH)
  }
  schedulePaint() // blur previews sample the base canvas
}

let paintQueued = false
function schedulePaint(): void {
  if (paintQueued) return
  paintQueued = true
  requestAnimationFrame(() => {
    paintQueued = false
    if (!loaded) return
    // ui = 1 / effective on-screen scale, so strokes stay constant under zoom
    // and drawn sizes match hitTest's.
    drawScene(overlayCtx, snapshot, sceneAnnotations(), state.selectedId, 1 / (fitScale * viewport.zoom))
    syncSelectionUi()
  })
}

/** True when `a` applies at the current scrub position (always, without a replay). */
function annotationVisibleNow(a: Annotation): boolean {
  if (!scrub) return true
  // The parsed video clock can run slightly past the manifest's wall-clock
  // replay_duration_ms, which lifetimes are clamped to.
  return visibleAt(a, Math.min(scrub.tMs, replayDurationMs), scrub.atNow, replayDurationMs)
}

function visibleAnnotations(): readonly Annotation[] {
  return scrub ? state.annotations.filter(annotationVisibleNow) : state.annotations
}

function sceneAnnotations(): readonly Annotation[] {
  const extras: Annotation[] = []
  if (drag?.kind === 'draw') {
    const draft = draftFromDrag(drag)
    if (draft) extras.push(draft)
  }
  if (pendingRect) {
    extras.push({
      id: 'draft-label',
      z: Number.MAX_SAFE_INTEGER,
      created_at: '',
      type: 'rect',
      color: state.color,
      ...pendingRect,
    })
  }
  const base = visibleAnnotations()
  return extras.length > 0 ? [...base, ...extras] : base
}

function refresh(): void {
  syncBlurWarning()
  syncLanes()
  schedulePaint()
}

// Duration the lane strip was last built against; when ScrubController adopts
// the parsed webm duration (replacing the manifest fallback) the bars must be
// rebuilt so they keep sharing the playhead's time→x mapping.
let laneDurationMs = -1

/** Rebuilds the timebar lane strip (cheap, but DOM churn — keep out of the rAF). */
function syncLanes(): void {
  if (!scrub) return
  laneDurationMs = scrub.durationMs
  timebar.setAnnotations(state.annotations, state.selectedId, scrub.durationMs)
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
  syncLanes() // deselecting clears the highlighted lifetime bar
  schedulePaint()
}

function cycleColor(): void {
  state.cycleColor()
  colorSwatch.style.background = state.color
  textEditor.style.color = state.color
}

function toNative(e: PointerEvent): { x: number; y: number } {
  // Derive the effective scale from the on-screen rect so the mapping stays
  // correct under the viewport's zoom/pan transform.
  const r = overlay.getBoundingClientRect()
  const scale = r.width > 0 ? r.width / nativeW : fitScale
  const x = Math.round((e.clientX - r.left) / scale)
  const y = Math.round((e.clientY - r.top) / scale)
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

// Single commit path: stamps the anchor replay position (t_ms) the annotation
// refers to plus its default lifetime, then stores and reports. Mirrors
// exportTMs(): "now" (the capture instant) is encoded by t_ms absence, exactly
// like manifest snapshot_t_ms, and a scrubbed stamp is clamped to the
// manifest's wall-clock replay_duration_ms — the parsed video clock can run
// slightly past it. Screenshot-only captures get neither anchor nor lifetime.
function commitAnnotation(a: Annotation): void {
  if (scrub) {
    const anchor = scrub.atNow ? replayDurationMs : Math.min(Math.round(scrub.tMs), replayDurationMs)
    if (!scrub.atNow) a.t_ms = anchor
    // Default lifetime: settings.defaultManualDurationMs centered on the
    // anchor, clamped to [0, replay duration].
    const life = lifetimeAround(anchor, defaultManualDurationMs, replayDurationMs)
    a.t_start_ms = life.t_start_ms
    a.t_end_ms = life.t_end_ms
  }
  state.add(a)
  window.editorBridge.annotationAdded({ id: a.id, type: a.type })
  refresh()
}

function commitDraw(d: { tool: DrawTool; x0: number; y0: number; x: number; y: number }): void {
  const a = draftFromDrag(d)
  if (!a) return
  Object.assign(a, state.nextStamp())
  commitAnnotation(a)
}

function placePin(p: { x: number; y: number }): void {
  commitAnnotation({
    ...state.nextStamp(),
    type: 'pin',
    x: p.x,
    y: p.y,
    color: state.color,
    label: state.nextPinLabel(),
  })
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

// Delete mirrors the × chip: both act only while the selection is visible at
// the current scrub position — a hidden annotation never vanishes silently.
function deleteSelected(): void {
  const a = selectedVisibleAnnotation()
  if (a === null) return
  state.remove(a.id)
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
  commitAnnotation({ ...state.nextStamp(), type: 'text', x: p.x, y: p.y, text, size: p.size, color: state.color })
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
// Inline label input for right-click rectangles
// ---------------------------------------------------------------------------

function openLabelEditor(box: { x: number; y: number; w: number; h: number }): void {
  pendingRect = box
  labelEditor.value = ''
  labelEditor.hidden = false
  positionLabelEditor()
  labelEditor.focus()
  schedulePaint()
}

function positionLabelEditor(): void {
  if (!pendingRect) return
  labelEditor.style.left = `${pendingRect.x * fitScale}px`
  labelEditor.style.top = `${(pendingRect.y + pendingRect.h) * fitScale + 6}px`
}

function commitLabelEditor(refocus = true): void {
  if (!pendingRect) return
  const box = pendingRect
  const label = labelEditor.value.trim()
  closeLabelEditor(refocus)
  const a: RectAnnotation = { ...state.nextStamp(), type: 'rect', color: state.color, ...box }
  if (label !== '') a.label = label
  commitAnnotation(a)
}

function closeLabelEditor(refocus = true): void {
  pendingRect = null
  labelEditor.hidden = true
  labelEditor.value = ''
  if (refocus) overlay.focus()
  schedulePaint()
}

labelEditor.addEventListener('keydown', (e) => {
  e.stopPropagation()
  if (e.key === 'Enter') commitLabelEditor()
  else if (e.key === 'Escape') closeLabelEditor()
})
labelEditor.addEventListener('blur', () => commitLabelEditor(false))

// ---------------------------------------------------------------------------
// Selected-annotation chips: duration (top-left) + × delete (top-right), and
// the inline duration editor. All live in #stage screen space, repositioned
// from the annotation bounds so zoom/pan never detaches them.
// ---------------------------------------------------------------------------

let durationEditorOpen = false

/** The selected annotation, if it applies at the current scrub position. */
function selectedVisibleAnnotation(): Annotation | null {
  if (state.selectedId === null) return null
  const a = state.byId(state.selectedId)
  return a !== undefined && annotationVisibleNow(a) ? a : null
}

/** Maps a native snapshot point to #stage-relative screen coordinates. */
function toScreen(x: number, y: number): { x: number; y: number } {
  const or = overlay.getBoundingClientRect()
  const sr = stage.getBoundingClientRect()
  const scale = or.width > 0 ? or.width / nativeW : fitScale
  return { x: or.left - sr.left + x * scale, y: or.top - sr.top + y * scale }
}

function chipLabel(a: Annotation): string {
  return a.t_start_ms !== undefined && a.t_end_ms !== undefined
    ? formatDurationLabel(a.t_end_ms - a.t_start_ms)
    : 'all'
}

function syncSelectionUi(): void {
  const a = loaded && !exporting ? selectedVisibleAnnotation() : null
  if (a === null) {
    durationChip.hidden = true
    deleteChip.hidden = true
    closeDurationEditor(false)
    return
  }
  const ui = 1 / (fitScale * viewport.zoom)
  const b = annotationBounds(overlayCtx, a, ui)
  const pad = SELECTION_PAD * ui // chips hug the dashed selection rect's corners
  const topLeft = toScreen(b.x - pad, b.y - pad)
  const topRight = toScreen(b.x + b.w + pad, b.y - pad)
  // Duration is only meaningful with a replay; respect settings.showDurationLabel.
  const showChip = scrub !== null && showDurationLabel
  durationChip.hidden = !showChip
  if (showChip) {
    durationChip.textContent = chipLabel(a)
    durationChip.style.left = `${topLeft.x}px`
    durationChip.style.top = `${topLeft.y - 4}px`
  } else {
    closeDurationEditor(false)
  }
  deleteChip.hidden = false
  deleteChip.style.left = `${topRight.x}px`
  deleteChip.style.top = `${topRight.y}px`
  if (durationEditorOpen) positionDurationEditor()
}

function openDurationEditor(): void {
  if (selectedVisibleAnnotation() === null || !scrub) return
  durationEditorOpen = true
  durationInput.value = ''
  durationEditor.hidden = false
  positionDurationEditor()
  durationInput.focus()
}

/** Esc / outside-click path: closes without applying anything. */
function closeDurationEditor(refocus = true): void {
  if (!durationEditorOpen) return
  durationEditorOpen = false
  durationEditor.hidden = true
  if (refocus) overlay.focus()
}

function positionDurationEditor(): void {
  const cr = durationChip.getBoundingClientRect()
  const sr = stage.getBoundingClientRect()
  const left = Math.max(8, Math.min(cr.left - sr.left, stage.clientWidth - durationEditor.offsetWidth - 8))
  const top = Math.max(8, Math.min(cr.bottom - sr.top + 6, stage.clientHeight - durationEditor.offsetHeight - 8))
  durationEditor.style.left = `${left}px`
  durationEditor.style.top = `${top}px`
}

/** The replay position a lifetime centers on; absent anchor = the capture instant. */
function anchorMs(a: Annotation): number {
  return a.t_ms ?? replayDurationMs
}

// Applies a lifetime mutation to the selected annotation through the undo
// stack (same snapshot pattern as drag-moves), then closes the editor.
function applyLifetime(mutate: (a: Annotation) => void): void {
  const a = selectedVisibleAnnotation()
  if (!a) return
  const before = state.cloneAnnotations()
  mutate(a)
  state.pushUndoSnapshot(before)
  closeDurationEditor()
  refresh()
}

function setSelectedDuration(ms: number): void {
  applyLifetime((a) => {
    const life = lifetimeAround(anchorMs(a), ms, replayDurationMs)
    a.t_start_ms = life.t_start_ms
    a.t_end_ms = life.t_end_ms
  })
}

durationChip.addEventListener('click', () => {
  if (durationEditorOpen) closeDurationEditor()
  else openDurationEditor()
})

deleteChip.addEventListener('click', deleteSelected)

for (const btn of durationEditor.querySelectorAll<HTMLButtonElement>('button[data-ms]')) {
  btn.addEventListener('click', () => {
    const ms = Number(btn.dataset['ms'])
    if (Number.isFinite(ms) && ms > 0) setSelectedDuration(ms)
  })
}

untilEndBtn.addEventListener('click', () => {
  applyLifetime((a) => {
    a.t_start_ms = a.t_start_ms ?? Math.max(0, Math.min(anchorMs(a), replayDurationMs))
    a.t_end_ms = replayDurationMs
  })
})

// Absent lifetime = the annotation applies to the whole capture.
entireCaptureBtn.addEventListener('click', () => {
  applyLifetime((a) => {
    delete a.t_start_ms
    delete a.t_end_ms
  })
})

// Keyboard shortcuts stay dead while typing here (stopPropagation keeps the
// window handler out); Esc closes without applying.
durationEditor.addEventListener('keydown', (e) => {
  e.stopPropagation()
  if (e.key === 'Escape') closeDurationEditor()
})

durationInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return
  const ms = parseDurationMs(durationInput.value)
  if (ms !== null) setSelectedDuration(ms)
})

// ---------------------------------------------------------------------------
// Pointer input
// ---------------------------------------------------------------------------

overlay.addEventListener('pointerdown', (e) => {
  if (!loaded) return
  scrub?.pause() // annotating targets a moment; freeze it
  closeDurationEditor(false) // any canvas interaction dismisses it, unapplied
  if (e.button === 2) {
    // Right-click drag draws a rectangle regardless of the active tool, then
    // takes a label inline.
    commitTextEditor()
    commitLabelEditor()
    const p = toNative(e)
    overlay.setPointerCapture(e.pointerId)
    drag = { kind: 'draw', tool: 'rect', x0: p.x, y0: p.y, x: p.x, y: p.y, label: true }
    return
  }
  if (e.button !== 0) return
  const p = toNative(e)
  if (tool === 'text') {
    // Keep focus under our control: default mousedown focus would blur the
    // inline input the moment we open it.
    e.preventDefault()
    commitTextEditor()
    commitLabelEditor()
    openTextEditor(p)
    return
  }
  commitTextEditor()
  commitLabelEditor()
  if (tool === 'pin') {
    placePin(p)
    return
  }
  if (tool === 'select') {
    // Only annotations visible at the current scrub position are clickable.
    const id = hitTest(overlayCtx, visibleAnnotations(), p.x, p.y, 1 / (fitScale * viewport.zoom))
    state.selectedId = id
    if (id !== null) {
      overlay.setPointerCapture(e.pointerId)
      drag = { kind: 'move', id, lastX: p.x, lastY: p.y, before: state.cloneAnnotations(), moved: false }
    }
    syncLanes()
    schedulePaint()
    return
  }
  if (tool === 'arrow' || tool === 'rect' || tool === 'blur') {
    overlay.setPointerCapture(e.pointerId)
    drag = { kind: 'draw', tool, x0: p.x, y0: p.y, x: p.x, y: p.y, label: false }
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
  if (d.kind === 'draw') {
    if (d.label) {
      const a = draftFromDrag(d)
      if (a && a.type === 'rect') openLabelEditor({ x: a.x, y: a.y, w: a.w, h: a.h })
    } else {
      commitDraw(d)
    }
  } else if (d.moved) {
    state.pushUndoSnapshot(d.before)
  }
  schedulePaint()
}

overlay.addEventListener('pointerup', endDrag)
overlay.addEventListener('pointercancel', endDrag)

// ---------------------------------------------------------------------------
// Scrub wheel, zoom, and pan
// ---------------------------------------------------------------------------

// Right-click is the rectangle tool; never show a context menu.
window.addEventListener('contextmenu', (e) => e.preventDefault())

window.addEventListener(
  'wheel',
  (e) => {
    if (!loaded) return
    const target = e.target
    if (
      target instanceof HTMLElement &&
      (target.closest('#topbar') || target.closest('#durationEditor') || target instanceof HTMLInputElement)
    ) {
      return // wheel over the top bar, the duration editor, or an inline input is not a scrub
    }
    e.preventDefault()
    if (e.ctrlKey || e.metaKey) {
      viewport.zoomAt(e.clientX, e.clientY, e.deltaY < 0)
      syncPanCursor()
      schedulePaint() // stroke/handle sizes are zoom-dependent
      return
    }
    if (!scrub || !scrub.ready) return
    // Any wheel while playing pauses instantly and scrubs (ScrubController).
    const deltaMs = wheelScrubDeltaMs(e, fps, scrubSensitivityMs, scrubInvert)
    if (deltaMs !== 0) scrub.scrubBy(deltaMs)
  },
  { passive: false },
)

// Space+drag pan, captured on the stage so it wins over annotation tools.
stage.addEventListener(
  'pointerdown',
  (e) => {
    if (e.button !== 0 || !spaceDown || !viewport.panEnabled) return
    e.preventDefault()
    e.stopPropagation()
    panning = { pointerId: e.pointerId, x: e.clientX, y: e.clientY }
    stage.setPointerCapture(e.pointerId)
    syncPanCursor()
  },
  { capture: true },
)
stage.addEventListener(
  'pointermove',
  (e) => {
    if (!panning || e.pointerId !== panning.pointerId) return
    e.stopPropagation()
    viewport.panBy(e.clientX - panning.x, e.clientY - panning.y)
    panning.x = e.clientX
    panning.y = e.clientY
    syncSelectionUi() // pan skips repaint (transform-glued), chips are screen-space
  },
  { capture: true },
)
const endPan = (e: PointerEvent): void => {
  if (!panning || e.pointerId !== panning.pointerId) return
  e.stopPropagation()
  panning = null
  syncPanCursor()
}
stage.addEventListener('pointerup', endPan, { capture: true })
stage.addEventListener('pointercancel', endPan, { capture: true })

function syncPanCursor(): void {
  const canPan = spaceDown && viewport.panEnabled
  stage.style.cursor = panning ? 'grabbing' : canPan ? 'grab' : ''
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  // Inline inputs own their keys (their handlers stopPropagation; the contains
  // check covers focus landing on the duration editor's buttons).
  if (e.isComposing || e.target === textEditor || e.target === labelEditor) return
  if (e.target instanceof Node && durationEditor.contains(e.target)) return
  const typing = e.target === titleInput || e.target === noteInput
  if (e.key === 'Escape') {
    // Esc closes the duration editor without applying before it can cancel.
    if (durationEditorOpen) {
      closeDurationEditor()
      return
    }
    window.editorBridge.cancel()
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    void doExport()
    return
  }
  if (typing) return
  if (e.key === ' ') {
    // Space is the pan modifier; keep it away from focused buttons/scrolling.
    e.preventDefault()
    if (!spaceDown) {
      spaceDown = true
      syncPanCursor()
    }
    return
  }
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

window.addEventListener('keyup', (e) => {
  if (e.key === ' ') {
    spaceDown = false
    panning = null
    syncPanCursor()
  }
})

window.addEventListener('blur', () => {
  spaceDown = false
  panning = null
  syncPanCursor()
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
// Timeline bar
// ---------------------------------------------------------------------------

const timebar = new Timebar(el<HTMLElement>('timebar'), {
  scrubToFraction: (fraction) => {
    if (scrub) scrub.scrubTo(fraction * scrub.durationMs)
  },
  togglePlay: () => scrub?.togglePlay(),
  // Clicking a lifetime bar selects the annotation and scrubs to its anchor
  // (absent anchor = the capture instant, i.e. "now").
  selectAnnotation: (id) => {
    const a = state.byId(id)
    if (!a) return
    setTool('select')
    state.selectedId = id
    if (scrub) scrub.scrubTo(a.t_ms ?? scrub.durationMs)
    syncLanes()
    schedulePaint()
  },
})

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

async function doExport(): Promise<void> {
  if (!loaded || exporting) return
  exporting = true
  exportBtn.disabled = true
  scrub?.pause()
  commitTextEditor()
  commitLabelEditor()
  closeDurationEditor(false)
  try {
    // A wheel burst right before Enter can leave a seek in flight; wait until
    // the base canvas shows the frame snapshotTMs will describe.
    if (scrub) await scrub.whenSettled()
    // Every blur region burns into the exported snapshot regardless of its
    // lifetime — redaction is a privacy guarantee, not a display state (SPEC §9).
    const blurs = state.annotations.filter((a): a is BlurAnnotation => a.type === 'blur')
    // The base canvas now shows the frame being exported (native snapshot or
    // scrubbed replay frame upscaled to native resolution).
    const snapshotPng = await composeExportPng(snapshot, blurs)
    window.editorBridge.export({
      annotations: state.annotations,
      snapshotPng,
      title: titleInput.value.trim(),
      note: noteInput.value.trim(),
      includeReplay: hasReplay && includeReplay.checked,
      snapshotTMs: scrub ? scrub.exportTMs() : null,
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
  replayDurationMs = payload.replayDurationMs
  fps = payload.fps
  scrubInvert = payload.scrubInvert
  scrubSensitivityMs = payload.scrubSensitivityMs
  defaultManualDurationMs = payload.defaultManualDurationMs
  showDurationLabel = payload.showDurationLabel
  // Kept alive: scrubbing back to "now" restores this sharpest frame.
  nativeBitmap = await createImageBitmap(new Blob([payload.snapshotPng], { type: 'image/png' }))
  snapshot.width = nativeW
  snapshot.height = nativeH
  overlay.width = nativeW
  overlay.height = nativeH
  snapCtx.drawImage(nativeBitmap, 0, 0, nativeW, nativeH)
  replayChip.textContent = hasReplay
    ? `Replay: ${Math.round(payload.replayDurationMs / 1000)}s`
    : 'No replay'
  replayToggle.hidden = !hasReplay
  loaded = true
  // The replay loads asynchronously behind the instantly-usable snapshot;
  // the timebar shows "loading replay…" until scrubbing is ready.
  if (payload.replayWebm !== null) {
    const controller = new ScrubController(payload.replayWebm, payload.replayDurationMs, {
      drawFrame: drawBase,
      // Scrubbing moves annotations in/out of their lifetimes: repaint the
      // overlay and re-evaluate the selection chips alongside the timebar.
      onState: () => {
        timebar.update(controller)
        // Lanes rebuild only on a duration change (webm parse resolving), not
        // per tick — setAnnotations is DOM churn unfit for the playback rAF.
        if (controller.durationMs !== laneDurationMs) syncLanes()
        schedulePaint()
      },
    })
    scrub = controller
    timebar.show()
    timebar.update(controller)
    syncLanes()
  }
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
