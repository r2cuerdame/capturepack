// Annotation editor renderer: toolless box annotation over the captured
// snapshot (GOAL "Unified Annotation Box"). One annotation type — the box —
// created with a RIGHT-DRAG, selected with a LEFT CLICK; a floating header on
// the selection toggles number/blur, edits the lifetime, and deletes.
// Annotations live in native snapshot pixel coords; display is a CSS-scaled
// fit. The base canvas shows either the native snapshot ("now") or a replay
// frame scaled to the same native rect, so annotations and export share one
// space.
import type {
  EditorExportPayload,
  EditorInitPayload,
} from '../../shared/ipc'
import type { Annotation, AnnotationBounds } from '../../shared/types'
import { computeDisplayNumbers } from '../../shared/numbering'
import { EditorState } from './state'
import {
  formatDurationLabel,
  lifetimeAround,
  lifetimeMidpoint,
  parseDurationMs,
  visibleAt,
} from './lifetime'
import {
  annotationBounds,
  composeExportPng,
  drawScene,
  handleAt,
  hitTest,
  SELECTION_PAD,
  type HandleId,
} from './render'
import { ScrubController, wheelScrubDeltaMs } from './scrub'
import { Timebar } from './timebar'
import { Viewport } from './viewport'

interface EditorBridge {
  onInit(cb: (payload: EditorInitPayload) => void): void
  export(payload: EditorExportPayload): void
  cancel(): void
  annotationAdded(payload: { id: string; type: string }): void
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
const colorBtn = el<HTMLButtonElement>('colorBtn')
const colorSwatch = el<HTMLSpanElement>('colorSwatch')
const exportBtn = el<HTMLButtonElement>('exportBtn')
const boxHeader = el<HTMLDivElement>('boxHeader')
const numberBtn = el<HTMLButtonElement>('numberBtn')
const durationChip = el<HTMLButtonElement>('durationChip')
const blurBtn = el<HTMLButtonElement>('blurBtn')
const deleteBtn = el<HTMLButtonElement>('deleteBtn')
const durationEditor = el<HTMLDivElement>('durationEditor')
const durationInput = el<HTMLInputElement>('durationInput')
const untilEndBtn = el<HTMLButtonElement>('untilEndBtn')
const entireCaptureBtn = el<HTMLButtonElement>('entireCaptureBtn')

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

const MIN_DRAG = 3 // native px below which a right-drag creates nothing
const MIN_SIZE = 2 // native px floor for resize (bounds sizes must stay > 0)

const state = new EditorState()
let nativeW = 0
let nativeH = 0
let hasReplay = false
let replayDurationMs = 0 // manifest replay_duration_ms; caps every lifetime stamp
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

type Drag =
  | { kind: 'draw'; x0: number; y0: number; x: number; y: number }
  | { kind: 'move'; id: string; lastX: number; lastY: number; before: Annotation[]; moved: boolean }
  | { kind: 'resize'; id: string; handle: HandleId; before: Annotation[]; moved: boolean }
let drag: Drag | null = null

// The inline text input serves two flows: a freshly right-dragged box waiting
// for its description (Enter commits the box, Esc discards it) and editing the
// text of an existing box (double-click).
type TextSession = { kind: 'new'; draft: Annotation } | { kind: 'edit'; id: string }
let textSession: TextSession | null = null
// Bounds the text input hangs under (live object: repositions track the box).
let textAnchor: AnnotationBounds | null = null

/** 1 / effective on-screen scale: converts on-screen px into native units. */
function uiScale(): number {
  return 1 / (fitScale * viewport.zoom)
}

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
    // Display numbers are GLOBAL (SPEC §8.5): computed over ALL boxes via the
    // one shared implementation, so toggling a number renumbers instantly and
    // the editor can never disagree with replay_annotated/report/README/MCP.
    drawScene(
      overlayCtx,
      snapshot,
      sceneAnnotations(),
      state.selectedId,
      computeDisplayNumbers(state.annotations),
      uiScale(),
    )
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
    const draft = dragDraft(drag)
    if (draft) extras.push(draft)
  }
  if (textSession?.kind === 'new') extras.push(textSession.draft)
  const base = visibleAnnotations()
  return extras.length > 0 ? [...base, ...extras] : base
}

function refresh(): void {
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

// ---------------------------------------------------------------------------
// Box creation (right-drag) + commit
// ---------------------------------------------------------------------------

function cycleColor(): void {
  state.cycleColor()
  colorSwatch.style.background = state.color
}

function toNative(e: PointerEvent | MouseEvent): { x: number; y: number } {
  // Derive the effective scale from the on-screen rect so the mapping stays
  // correct under the viewport's zoom/pan transform.
  const r = overlay.getBoundingClientRect()
  const scale = r.width > 0 ? r.width / nativeW : fitScale
  const x = Math.round((e.clientX - r.left) / scale)
  const y = Math.round((e.clientY - r.top) / scale)
  return { x: Math.max(0, Math.min(nativeW, x)), y: Math.max(0, Math.min(nativeH, y)) }
}

function normBox(d: { x0: number; y0: number; x: number; y: number }): Box {
  return {
    x: Math.min(d.x0, d.x),
    y: Math.min(d.y0, d.y),
    w: Math.abs(d.x - d.x0),
    h: Math.abs(d.y - d.y0),
  }
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** Live right-drag preview: an ephemeral box that never enters the store. */
function dragDraft(d: { x0: number; y0: number; x: number; y: number }): Annotation | null {
  const b = normBox(d)
  if (b.w < MIN_DRAG || b.h < MIN_DRAG) return null
  return {
    annotation_id: 'draft',
    type: 'box',
    bounds: { x: b.x, y: b.y, width: b.w, height: b.h },
    text: '',
    numbered: false,
    blur: false,
    tracking: { enabled: false },
    style: { color: state.color },
    created_at: '',
    z: Number.MAX_SAFE_INTEGER,
  }
}

/**
 * Right-drag released on a viable rect: build the real box (identity, z,
 * default lifetime = scrub position ± defaultManualDurationMs/2 clamped to the
 * replay) and open the inline text input focused. Enter commits, Esc discards.
 */
function beginPendingBox(b: Box): void {
  const stamp = state.nextStamp()
  const draft: Annotation = {
    annotation_id: stamp.annotation_id,
    type: 'box',
    bounds: { x: b.x, y: b.y, width: b.w, height: b.h },
    text: '',
    numbered: false,
    blur: false,
    tracking: { enabled: false },
    style: { color: state.color },
    created_at: stamp.created_at,
    z: stamp.z,
  }
  if (scrub) {
    // "Now" (the capture instant) anchors at the end of the replay; a scrubbed
    // stamp is clamped to the manifest's wall-clock replay_duration_ms — the
    // parsed video clock can run slightly past it.
    const anchor = scrub.atNow ? replayDurationMs : Math.min(Math.round(scrub.tMs), replayDurationMs)
    const life = lifetimeAround(anchor, defaultManualDurationMs, replayDurationMs)
    draft.start_ms = life.start_ms
    draft.end_ms = life.end_ms
  }
  textSession = { kind: 'new', draft }
  openTextEditor(draft.bounds, '')
  schedulePaint()
}

// ---------------------------------------------------------------------------
// Inline text input (new-box description / double-click text edit)
// ---------------------------------------------------------------------------

function openTextEditor(anchor: AnnotationBounds, value: string): void {
  textAnchor = anchor
  textEditor.value = value
  textEditor.hidden = false
  positionTextEditor()
  textEditor.focus()
}

function positionTextEditor(): void {
  if (!textAnchor) return
  textEditor.style.left = `${textAnchor.x * fitScale}px`
  textEditor.style.top = `${(textAnchor.y + textAnchor.height) * fitScale + 6}px`
}

/** Enter/blur path: commits the pending box or applies the text edit. */
function commitTextEditor(refocus = true): void {
  if (!textSession) return
  const session = textSession
  const value = textEditor.value.trim()
  closeTextEditor(refocus)
  if (session.kind === 'new') {
    session.draft.text = value
    state.add(session.draft)
    state.selectedId = session.draft.annotation_id
    // The timeline event carries the SAVED identity: the ann_… id this box
    // keeps in annotations.json, and the one real type "box" (SPEC §10.2).
    window.editorBridge.annotationAdded({ id: session.draft.annotation_id, type: 'box' })
  } else {
    const a = state.byId(session.id)
    if (a && a.text !== value) {
      const before = state.cloneAnnotations()
      a.text = value
      state.pushUndoSnapshot(before)
    }
  }
  refresh()
}

/** Esc path: discards a pending box entirely; abandons a text edit unchanged. */
function cancelTextEditor(): void {
  if (!textSession) return
  closeTextEditor()
  refresh()
}

function closeTextEditor(refocus = true): void {
  textSession = null
  textAnchor = null
  textEditor.hidden = true
  textEditor.value = ''
  if (refocus) overlay.focus()
}

textEditor.addEventListener('keydown', (e) => {
  e.stopPropagation()
  if (e.key === 'Enter') commitTextEditor()
  else if (e.key === 'Escape') cancelTextEditor()
})
textEditor.addEventListener('blur', () => commitTextEditor(false))

// ---------------------------------------------------------------------------
// Selected-box header: [#|N] number toggle, duration chip, blur toggle, and ×
// delete, floating above the box. Lives in #stage screen space, repositioned
// from the box bounds so zoom/pan never detaches it.
// ---------------------------------------------------------------------------

let durationEditorOpen = false

/** The selected box, if it applies at the current scrub position. */
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
  return a.start_ms !== undefined && a.end_ms !== undefined
    ? formatDurationLabel(a.end_ms - a.start_ms)
    : 'all'
}

function syncSelectionUi(): void {
  const a = loaded && !exporting ? selectedVisibleAnnotation() : null
  if (a === null) {
    boxHeader.hidden = true
    closeDurationEditor(false)
    return
  }
  const b = annotationBounds(a)
  const pad = SELECTION_PAD * uiScale() // the header hugs the dashed selection rect
  const topLeft = toScreen(b.x - pad, b.y - pad)
  boxHeader.hidden = false
  boxHeader.style.left = `${Math.max(4, topLeft.x)}px`
  boxHeader.style.top = `${Math.max(28, topLeft.y - 4)}px`
  // [#|N]: shows the computed display number while numbering is on.
  const number = computeDisplayNumbers(state.annotations).get(a.annotation_id)
  numberBtn.textContent = a.numbered && number !== undefined ? String(number) : '#'
  numberBtn.classList.toggle('on', a.numbered)
  blurBtn.textContent = a.blur ? 'Blur On' : 'Blur'
  blurBtn.classList.toggle('on', a.blur)
  // Duration is only meaningful with a replay; respect settings.showDurationLabel.
  const showChip = scrub !== null && showDurationLabel
  durationChip.hidden = !showChip
  if (showChip) durationChip.textContent = chipLabel(a)
  else closeDurationEditor(false)
  if (durationEditorOpen) positionDurationEditor()
}

/** Applies an undoable mutation to the selected box, then refreshes all views. */
function applyMutation(mutate: (a: Annotation) => void): void {
  const a = selectedVisibleAnnotation()
  if (a === null) return
  const before = state.cloneAnnotations()
  mutate(a)
  state.pushUndoSnapshot(before)
  refresh()
}

// Delete mirrors the header ×: both act only while the selection is visible at
// the current scrub position — a hidden box never vanishes silently.
function deleteSelected(): void {
  const a = selectedVisibleAnnotation()
  if (a === null) return
  state.remove(a.annotation_id)
  refresh()
}

numberBtn.addEventListener('click', () => {
  applyMutation((a) => {
    a.numbered = !a.numbered
  })
  overlay.focus()
})

blurBtn.addEventListener('click', () => {
  applyMutation((a) => {
    a.blur = !a.blur
  })
  overlay.focus()
})

deleteBtn.addEventListener('click', deleteSelected)

// ---------------------------------------------------------------------------
// Inline duration editor (opened from the header's duration chip)
// ---------------------------------------------------------------------------

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

// The representative instant a lifetime re-centers on: the current lifetime's
// MIDPOINT (SPEC §8.4 — the midpoint replaced the stored t_ms anchor); a box
// without a lifetime anchors at the capture instant ("now").
function anchorMs(a: Annotation): number {
  return lifetimeMidpoint(a, replayDurationMs)
}

function setSelectedDuration(ms: number): void {
  applyMutation((a) => {
    const life = lifetimeAround(anchorMs(a), ms, replayDurationMs)
    a.start_ms = life.start_ms
    a.end_ms = life.end_ms
  })
  closeDurationEditor()
}

durationChip.addEventListener('click', () => {
  if (durationEditorOpen) closeDurationEditor()
  else openDurationEditor()
})

for (const btn of durationEditor.querySelectorAll<HTMLButtonElement>('button[data-ms]')) {
  btn.addEventListener('click', () => {
    const ms = Number(btn.dataset['ms'])
    if (Number.isFinite(ms) && ms > 0) setSelectedDuration(ms)
  })
}

untilEndBtn.addEventListener('click', () => {
  applyMutation((a) => {
    const start = a.start_ms ?? Math.max(0, Math.min(Math.round(anchorMs(a)), replayDurationMs))
    a.start_ms = start
    a.end_ms = replayDurationMs
  })
  closeDurationEditor()
})

// Absent lifetime = the box applies to the whole capture (SPEC §8.4).
entireCaptureBtn.addEventListener('click', () => {
  applyMutation((a) => {
    delete a.start_ms
    delete a.end_ms
  })
  closeDurationEditor()
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
// SEMANTIC TARGET HOOK (future work — GOAL "Annotation Interaction"): when a
// left click hits no box, probe the real UI object under the cursor (UIA /
// DOM accessibility data captured alongside the screen) and offer a
// snap-to-object box whose reserved `target` field (SPEC §8.3) carries the
// semantic metadata. Format 0.1.0 ships no probing data, so this is a no-op;
// wire the probe result into beginPendingBox-style creation when it arrives.
// ---------------------------------------------------------------------------
function probeSemanticTarget(_point: { x: number; y: number }): void {
  // Intentionally empty in 0.1.0.
}

// ---------------------------------------------------------------------------
// Pointer input: LEFT click selects / drags (move, corner-resize); RIGHT drag
// creates a box. No tool modes.
// ---------------------------------------------------------------------------

function applyResize(a: Annotation, handle: HandleId, px: number, py: number): void {
  const b = a.bounds
  const right = b.x + b.width
  const bottom = b.y + b.height
  if (handle === 'nw' || handle === 'sw') {
    b.x = Math.min(px, right - MIN_SIZE)
    b.width = right - b.x
  } else {
    b.width = Math.max(MIN_SIZE, px - b.x)
  }
  if (handle === 'nw' || handle === 'ne') {
    b.y = Math.min(py, bottom - MIN_SIZE)
    b.height = bottom - b.y
  } else {
    b.height = Math.max(MIN_SIZE, py - b.y)
  }
}

overlay.addEventListener('pointerdown', (e) => {
  if (!loaded) return
  scrub?.pause() // annotating targets a moment; freeze it
  closeDurationEditor(false) // any canvas interaction dismisses it, unapplied
  if (e.button === 2) {
    // RIGHT-DRAG creates a box (live preview; text input opens on release).
    commitTextEditor()
    const p = toNative(e)
    overlay.setPointerCapture(e.pointerId)
    drag = { kind: 'draw', x0: p.x, y0: p.y, x: p.x, y: p.y }
    return
  }
  if (e.button !== 0) return
  commitTextEditor()
  const p = toNative(e)
  const ui = uiScale()
  // Corner resize handles (editor-only chrome) win over box stacking.
  const sel = selectedVisibleAnnotation()
  if (sel !== null) {
    const handle = handleAt(sel, p.x, p.y, ui)
    if (handle !== null) {
      overlay.setPointerCapture(e.pointerId)
      drag = { kind: 'resize', id: sel.annotation_id, handle, before: state.cloneAnnotations(), moved: false }
      return
    }
  }
  // LEFT CLICK selects the topmost box whose lifetime is visible at the cursor.
  const id = hitTest(visibleAnnotations(), p.x, p.y, ui)
  state.selectedId = id
  if (id !== null) {
    overlay.setPointerCapture(e.pointerId)
    drag = { kind: 'move', id, lastX: p.x, lastY: p.y, before: state.cloneAnnotations(), moved: false }
  } else {
    probeSemanticTarget(p)
  }
  syncLanes()
  schedulePaint()
})

overlay.addEventListener('pointermove', (e) => {
  if (!drag) {
    if (loaded) syncHoverCursor(e)
    return
  }
  const p = toNative(e)
  if (drag.kind === 'draw') {
    drag.x = p.x
    drag.y = p.y
  } else if (drag.kind === 'move') {
    const a = state.byId(drag.id)
    if (a && (p.x !== drag.lastX || p.y !== drag.lastY)) {
      a.bounds.x += p.x - drag.lastX
      a.bounds.y += p.y - drag.lastY
      drag.moved = true
    }
    drag.lastX = p.x
    drag.lastY = p.y
  } else {
    const a = state.byId(drag.id)
    if (a) {
      applyResize(a, drag.handle, p.x, p.y)
      drag.moved = true
    }
  }
  schedulePaint()
})

function endDrag(): void {
  if (!drag) return
  const d = drag
  drag = null
  if (d.kind === 'draw') {
    const b = normBox(d)
    if (b.w >= MIN_DRAG && b.h >= MIN_DRAG) beginPendingBox(b)
  } else if (d.moved) {
    state.pushUndoSnapshot(d.before)
  }
  schedulePaint()
}

overlay.addEventListener('pointerup', endDrag)
overlay.addEventListener('pointercancel', endDrag)

// Double-click a box to edit its text inline (Enter applies, Esc abandons).
overlay.addEventListener('dblclick', (e) => {
  if (!loaded || e.button !== 0) return
  const p = toNative(e)
  const id = hitTest(visibleAnnotations(), p.x, p.y, uiScale())
  if (id === null) return
  const a = state.byId(id)
  if (!a) return
  e.preventDefault()
  state.selectedId = id
  textSession = { kind: 'edit', id }
  openTextEditor(a.bounds, a.text)
  syncLanes()
  schedulePaint()
})

/** Idle-hover cursor: resize arrows over handles, move over a box, else default. */
function syncHoverCursor(e: PointerEvent): void {
  if (spaceDown) return // pan cursor owns the stage
  const p = toNative(e)
  const ui = uiScale()
  const sel = selectedVisibleAnnotation()
  if (sel !== null) {
    const handle = handleAt(sel, p.x, p.y, ui)
    if (handle !== null) {
      overlay.style.cursor = handle === 'nw' || handle === 'se' ? 'nwse-resize' : 'nesw-resize'
      return
    }
  }
  overlay.style.cursor = hitTest(visibleAnnotations(), p.x, p.y, ui) !== null ? 'move' : 'default'
}

// ---------------------------------------------------------------------------
// Scrub wheel, zoom, and pan
// ---------------------------------------------------------------------------

// Right-click starts a box; never show a context menu.
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

// Space+drag pan, captured on the stage so it wins over box interactions.
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
    syncSelectionUi() // pan skips repaint (transform-glued), the header is screen-space
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
// Keyboard: Enter save, Esc cancel-current/close, Ctrl+Z/Y, Delete, C color.
// ---------------------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  // Inline inputs own their keys (their handlers stopPropagation; the contains
  // check covers focus landing on the duration editor's buttons).
  if (e.isComposing || e.target === textEditor) return
  if (e.target instanceof Node && durationEditor.contains(e.target)) return
  const typing = e.target === titleInput || e.target === noteInput
  if (e.key === 'Escape') {
    // Cancel-current first: duration editor, then an active selection; a bare
    // Esc with nothing in progress closes the editor without saving.
    if (durationEditorOpen) {
      closeDurationEditor()
      return
    }
    if (state.selectedId !== null) {
      state.selectedId = null
      syncLanes()
      schedulePaint()
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

colorBtn.addEventListener('click', () => {
  cycleColor()
  colorBtn.blur()
})
exportBtn.addEventListener('click', () => void doExport())

// ---------------------------------------------------------------------------
// Timeline bar
// ---------------------------------------------------------------------------

const timebar = new Timebar(el<HTMLElement>('timebar'), {
  scrubToFraction: (fraction) => {
    if (scrub) scrub.scrubTo(fraction * scrub.durationMs)
  },
  togglePlay: () => scrub?.togglePlay(),
  // Clicking a lifetime bar selects the box and scrubs to its lifetime
  // midpoint (SPEC §8.4 — absent lifetime = the capture instant, i.e. "now").
  selectAnnotation: (id) => {
    const a = state.byId(id)
    if (!a) return
    state.selectedId = id
    if (scrub) scrub.scrubTo(lifetimeMidpoint(a, scrub.durationMs))
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
  closeDurationEditor(false)
  try {
    // A wheel burst right before Enter can leave a seek in flight; wait until
    // the base canvas shows the frame snapshotTMs will describe.
    if (scrub) await scrub.whenSettled()
    // Blur is NON-destructive (SPEC §9): snapshot.png keeps original pixels;
    // blur renders only into derived views (replay_annotated, editor preview).
    // The base canvas now shows the frame being exported (native snapshot or
    // scrubbed replay frame upscaled to native resolution).
    const snapshotPng = await composeExportPng(snapshot)
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
      // Scrubbing moves boxes in/out of their lifetimes: repaint the overlay
      // and re-evaluate the selection header alongside the timebar.
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

colorSwatch.style.background = state.color
