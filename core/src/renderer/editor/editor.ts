// Annotation editor renderer: toolless box annotation over the captured
// snapshot (GOAL "Unified Annotation Box"). One annotation type — the box —
// created with a RIGHT-DRAG, selected with a LEFT CLICK; a floating header on
// the selection toggles number/blur, edits the lifetime, and deletes.
// Annotations live in native snapshot pixel coords; display is a CSS-scaled
// fit. The base canvas shows either the native snapshot ("now") or a replay
// frame scaled to the same native rect, so annotations and export share one
// space.
import type {
  EditorDisplayPayload,
  EditorExportPayload,
  EditorInitPayload,
} from '../../shared/ipc'
import { applyDomI18n, makeT } from '../../shared/i18n'
import type { TranslateFn } from '../../shared/i18n'
import type {
  Annotation,
  AnnotationBounds,
  AnnotationTarget,
  EditorWindowMode,
  UiaAnnotationTarget,
} from '../../shared/types'
import { computeDisplayNumbers } from '../../shared/numbering'
import { ObjectIndex, objectLabel } from './objects'
import type { PickableObject } from './objects'
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
  drawObjectHover,
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
  saveAsNew(payload: EditorExportPayload): void
  cancel(): void
  annotationAdded(payload: { id: string; type: string }): void
  // Editor Window Mode (GOAL): an ABSOLUTE request; main applies it and pushes
  // back the mode the window actually ended up in.
  setWindowMode(mode: EditorWindowMode): void
  onWindowMode(cb: (mode: EditorWindowMode) => void): void
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
const colorBtn = el<HTMLButtonElement>('colorBtn')
const colorSwatch = el<HTMLSpanElement>('colorSwatch')
const exportBtn = el<HTMLButtonElement>('exportBtn')
const windowModeBtn = el<HTMLButtonElement>('windowModeBtn')
const boxHeader = el<HTMLDivElement>('boxHeader')
const numberBtn = el<HTMLButtonElement>('numberBtn')
const durationChip = el<HTMLButtonElement>('durationChip')
const blurBtn = el<HTMLButtonElement>('blurBtn')
const deleteBtn = el<HTMLButtonElement>('deleteBtn')
const durationEditor = el<HTMLDivElement>('durationEditor')
const durationInput = el<HTMLInputElement>('durationInput')
const untilEndBtn = el<HTMLButtonElement>('untilEndBtn')
const entireCaptureBtn = el<HTMLButtonElement>('entireCaptureBtn')
const displaySwitcher = el<HTMLSpanElement>('displaySwitcher')
const displayHint = el<HTMLSpanElement>('displayHint')
const objectHint = el<HTMLSpanElement>('objectHint')
const dirtyChip = el<HTMLSpanElement>('dirtyChip')
const trimDropChip = el<HTMLSpanElement>('trimDropChip')
const unsavedBar = el<HTMLDivElement>('unsavedBar')
const unsavedSaveBtn = el<HTMLButtonElement>('unsavedSaveBtn')
const unsavedSaveAsBtn = el<HTMLButtonElement>('unsavedSaveAsBtn')
const unsavedDiscardBtn = el<HTMLButtonElement>('unsavedDiscardBtn')
const timebarEl = el<HTMLElement>('timebar')

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
// Active-language t(); replaced at init from the payload's uiLanguage (the
// language is fixed for the session — the editor window is transient).
let t: TranslateFn = makeT('en')
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
// Re-edit mode (GOAL "History — Save after re-edit"): dirty tracking against
// the loaded state, and Esc-when-dirty offers Save / Save As New / Discard.
let editMode = false
let baselineSig = ''
let dirty = false
// The unsaved bar was open when the user looked at another display: hidden
// while that frame is on screen, restored on return (see schedulePaint).
let unsavedBarHiddenByDisplay = false
// Original desktop snapshot, kept for restoring the "now" frame after scrubbing.
let nativeBitmap: ImageBitmap | null = null
let scrub: ScrubController | null = null
// Read-only display switcher (GOAL "Multi-Monitor Support"): every display the
// capture froze. Empty for a single-display capture — the switcher never
// appears then, and every path below behaves exactly as it did before.
interface DisplayView extends Omit<EditorDisplayPayload, 'snapshotPng'> {
  // null on the FOCUSED entry: its frame is the live base canvas, never this
  // copy (see showDisplay) — main does not ship those bytes twice.
  png: ArrayBuffer | null
  // Decoded lazily on first view: decoding every display up front would delay
  // the editor for frames the user may never look at.
  bitmap: ImageBitmap | null
  // Set when this display's PNG could not be decoded: its switcher button is
  // disabled rather than silently doing nothing.
  broken?: boolean
}
let displayViews: DisplayView[] = []
let focusedDisplayIndex = 0
let viewDisplayIndex = 0
// Native size of the FOCUSED display (nativeW/H follow the display on screen).
let focusedW = 0
let focusedH = 0
// The base frame showing when the user left the focused display — restored on
// return, so a scrubbed position survives a look at another screen.
let focusedBaseFrame: ImageBitmap | null = null
// Static object picking (GOAL "Static object picking (v0)"): the capture-instant
// UI Automation elements, indexed once at init. An empty index (no dump, a
// timed-out dump, a pack without plugins/windows-uia) leaves every path below
// behaving exactly as it did before the feature existed.
let objectIndex: ObjectIndex | null = null
let hoverObject: PickableObject | null = null
// Last probed snapshot pixel: hovering does NO work until the pointer moves off it.
let lastProbeX = -1
let lastProbeY = -1
// Honesty (GOAL): the objects come from the capture instant, so a scrubbed-away
// view is showing pixels they no longer describe. Said once per session.
let objectHintShown = false
let objectHintTimer: number | null = null
// Replay Trim (GOAL "Replay Trim"), on the scrub (parsed video) clock.
// trimInMs 0 = untrimmed start; trimOutMs null = untrimmed end. Fresh-capture
// flow only — edit mode never enables trimming (the saved replay is already
// the original evidence).
let trimInMs = 0
let trimOutMs: number | null = null
// Editor Window Mode (GOAL "Editor Window Mode"): mirrors the window state main
// reports. The fullscreen overlay is the default; windowed mode is a real
// movable/resizable window whose top bar is the drag region.
let windowMode: EditorWindowMode = 'fullscreen'
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

// ---------------------------------------------------------------------------
// Window mode (GOAL "Editor Window Mode"): fullscreen overlay (default) or a
// real window. Main owns the window state — the renderer asks for a mode and
// paints only what is pushed back, so the ⧉ button can never claim a mode the
// window is not in. Everything else (Esc, Enter, scrubbing, picking, the box
// header) behaves identically in both modes.
// ---------------------------------------------------------------------------

/** Paints the mode main reported: drag region, button state, canvas re-fit. */
function applyWindowMode(mode: EditorWindowMode): void {
  windowMode = mode
  // The CSS drag region hangs off this: the top bar is only draggable — and
  // only steals clicks from its own padding — while the editor is a window.
  document.body.dataset['windowMode'] = mode
  windowModeBtn.setAttribute('aria-pressed', String(mode === 'windowed'))
  // The window size just changed under us; the resize event does this too, but
  // not every platform guarantees one for a fullscreen transition.
  layout()
  syncSelectionUi()
  schedulePaint()
}

function toggleWindowMode(): void {
  window.editorBridge.setWindowMode(windowMode === 'windowed' ? 'fullscreen' : 'windowed')
}

// ---------------------------------------------------------------------------
// Display switcher (GOAL "Multi-Monitor Support") — the other displays this
// capture froze are VIEWABLE, never annotatable in this version. Annotation,
// scrubbing, and the exported frame always belong to the focused display.
// ---------------------------------------------------------------------------

/** True while the focused display is on screen — i.e. editing is live. */
function viewingFocused(): boolean {
  return displayViews.length < 2 || viewDisplayIndex === focusedDisplayIndex
}

function buildDisplaySwitcher(): void {
  displaySwitcher.replaceChildren()
  if (displayViews.length < 2) {
    displaySwitcher.hidden = true
    displayHint.hidden = true
    return
  }
  for (const d of displayViews) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = String(d.index)
    btn.title = d.focused
      ? t('editor.displayFocusedTooltip', { index: d.index })
      : t('editor.displayTooltip', { index: d.index })
    btn.classList.toggle('focusedDisplay', d.focused)
    btn.addEventListener('click', () => {
      btn.blur() // keyboard shortcuts belong to the canvas, not this button
      void showDisplay(d.index)
    })
    displaySwitcher.append(btn)
  }
  displaySwitcher.hidden = false
  syncDisplaySwitcher()
}

function syncDisplaySwitcher(): void {
  if (displayViews.length < 2) return
  const buttons = displaySwitcher.querySelectorAll('button')
  displayViews.forEach((d, i) => {
    const btn = buttons[i]
    if (btn === undefined) return
    btn.classList.toggle('viewing', d.index === viewDisplayIndex)
    // A frame that could not be decoded: the button says so instead of
    // looking live and doing nothing.
    btn.disabled = d.broken === true
  })
  const focused = viewingFocused()
  displayHint.hidden = focused
  if (!focused) {
    displayHint.textContent = t('editor.displayReadOnly', {
      index: viewDisplayIndex,
      focused: focusedDisplayIndex,
    })
  }
  // Scrubbing applies to the focused display only.
  timebarEl.classList.toggle('readonlyDisplay', !focused)
  overlay.style.pointerEvents = focused ? '' : 'none'
}

/** Canvas backing store = the displayed display's native pixel size. */
function resizeCanvases(): void {
  snapshot.width = nativeW
  snapshot.height = nativeH
  overlay.width = nativeW
  overlay.height = nativeH
}

/**
 * Shows one captured display: the focused one (editable) or a frozen frame.
 *
 * Re-entrant by design: a click (or Save) landing while a switch is in flight
 * gets the SAME promise back and therefore waits for the real completion,
 * instead of the no-op that made the first Enter after a switch look like a
 * dropped keystroke.
 */
let switchInFlight: Promise<void> | null = null

function showDisplay(index: number): Promise<void> {
  if (switchInFlight !== null) return switchInFlight
  if (!loaded || exporting) return Promise.resolve()
  const target = displayViews.find((d) => d.index === index)
  if (target === undefined || target.broken === true || index === viewDisplayIndex) {
    return Promise.resolve()
  }
  // Never rejects: every caller is a `void`/`await` on a UI gesture, and an
  // unhandled rejection here would take the editor's console with it.
  const run = runDisplaySwitch(target, index)
    .catch((err: unknown) => {
      console.error('capturepack: switching the displayed screen failed:', err)
    })
    .finally(() => {
      switchInFlight = null
    })
  switchInFlight = run
  return run
}

async function runDisplaySwitch(target: DisplayView, index: number): Promise<void> {
  // Picked objects belong to the focused display's coordinate space; a stale
  // outline must never survive onto another screen's frame.
  probeObjectHover(null)
  if (viewingFocused()) {
    // Leaving the focused display: settle any in-flight seek and keep the
    // exact frame on screen, so coming back needs no re-seek.
    commitTextEditor(false)
    closeDurationEditor(false)
    scrub?.pause()
    await scrub?.whenSettled()
  }
  if (!target.focused && target.bitmap === null) {
    // A truncated/corrupt per-display PNG (an interrupted copy of a re-edited
    // pack) rejects here. Leaving it unhandled would surface as an unhandled
    // rejection and a switcher button that silently does nothing — and, worse,
    // would already have thrown away the focused base frame below.
    try {
      const png = target.png
      if (png === null) throw new Error('display carries no frame')
      target.bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }))
    } catch (err) {
      console.error('capturepack: decoding a captured display failed:', err)
      target.broken = true
      syncDisplaySwitcher()
      return
    }
  }
  if (viewingFocused()) {
    focusedBaseFrame?.close()
    focusedBaseFrame = await createImageBitmap(snapshot)
  }
  viewDisplayIndex = index
  nativeW = target.focused ? focusedW : target.width
  nativeH = target.focused ? focusedH : target.height
  // The coordinate space genuinely changed (a 4K display and a 1080p one do not
  // share a pan): keeping the old pan would translate the smaller frame clean
  // out of the overflow:hidden stage and leave a black editor.
  viewport.reset()
  resizeCanvases()
  const frame = target.focused ? (focusedBaseFrame ?? nativeBitmap) : target.bitmap
  if (frame) snapCtx.drawImage(frame, 0, 0, nativeW, nativeH)
  syncDisplaySwitcher()
  layout()
  syncPanCursor()
  schedulePaint()
}

/** Paints the base image: a scrubbed replay frame or the native snapshot. */
function drawBase(source: HTMLVideoElement | 'native'): void {
  if (!loaded) return
  // A non-focused display shows its frozen frame; a late seek must not paint
  // the focused display's replay over it.
  if (!viewingFocused()) return
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
    // A non-focused display is shown READ-ONLY: no boxes, no selection chrome
    // (annotations belong to the focused display's coordinate space).
    if (!viewingFocused()) {
      overlayCtx.clearRect(0, 0, overlay.width, overlay.height)
      boxHeader.hidden = true
      closeDurationEditor(false)
      // The Esc [Save][Save As New][Discard] bar belongs to the focused
      // display's edits: floating it over another screen's frozen frame reads
      // as if Save would write what is on screen. Remembered and restored.
      if (!unsavedBar.hidden) {
        unsavedBarHiddenByDisplay = true
        unsavedBar.hidden = true
      }
      return
    }
    if (unsavedBarHiddenByDisplay) {
      unsavedBarHiddenByDisplay = false
      // Never during a save: doExport switches back to the focused display and
      // then hides the bar, and this must not put it up again behind it.
      if (editMode && dirty && !exporting) unsavedBar.hidden = false
    }
    // Display numbers are GLOBAL (SPEC §8.5): computed over ALL boxes via the
    // one shared implementation, so toggling a number renumbers instantly and
    // the editor can never disagree with replay_annotated/report/README/MCP.
    const ui = uiScale()
    drawScene(
      overlayCtx,
      snapshot,
      sceneAnnotations(),
      state.selectedId,
      computeDisplayNumbers(state.annotations),
      ui,
    )
    // Object hover last, on top of everything (GOAL "Static object picking") —
    // and never while a drag or a pending description is in progress.
    if (hoverObject !== null && drag === null && textSession === null && !exporting) {
      drawObjectHover(
        overlayCtx,
        { x: hoverObject.x, y: hoverObject.y, w: hoverObject.width, h: hoverObject.height },
        objectLabel(hoverObject),
        ui,
      )
    }
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
  updateDirty()
  syncTrimDropChip() // lifetime edits move boxes in/out of the trim range
}

// ---------------------------------------------------------------------------
// Edit-mode dirty tracking + the Esc [Save][Save As New][Discard] bar
// ---------------------------------------------------------------------------

/** Everything a save would write, as a comparable string. */
function editSig(): string {
  return `${JSON.stringify(state.annotations)}\u0000${titleInput.value.trim()}\u0000${noteInput.value.trim()}`
}

// Compare-based dirty: undoing back to the loaded state clears the chip.
function updateDirty(): void {
  if (!editMode || !loaded) return
  const d = editSig() !== baselineSig
  if (d === dirty) return
  dirty = d
  dirtyChip.hidden = !d
  // Back at the baseline: the bar has nothing to offer. No refocus — the user
  // may be typing in the title/note input right now.
  if (!d) hideUnsavedBar(false)
}

function showUnsavedBar(): void {
  unsavedBar.hidden = false
  unsavedSaveBtn.focus()
}

function hideUnsavedBar(refocus = true): void {
  if (unsavedBar.hidden) return
  unsavedBar.hidden = true
  if (refocus) overlay.focus()
}

unsavedSaveBtn.addEventListener('click', () => void doExport('save'))
unsavedSaveAsBtn.addEventListener('click', () => void doExport('saveAsNew'))
unsavedDiscardBtn.addEventListener('click', () => window.editorBridge.cancel())

titleInput.addEventListener('input', updateDirty)
noteInput.addEventListener('input', updateDirty)

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
// Replay Trim (GOAL "Replay Trim") — in/out handles on the timebar, fresh
// capture flow only. Scrubbing outside the trim stays allowed; the trim only
// decides what Save keeps.
// ---------------------------------------------------------------------------

// Minimum kept range, so in/out can never cross or collapse to nothing.
const TRIM_MIN_GAP_MS = 100

function trimEnabled(): boolean {
  // The replay is ALWAYS kept when one exists (GOAL "No include-replay
  // toggle"), so trimming is available whenever a fresh capture has one.
  return scrub !== null && !editMode
}

function trimActive(): boolean {
  return trimEnabled() && (trimInMs > 0 || trimOutMs !== null)
}

/** Sets the in-point (ms on the scrub clock), clamped below the out-point. */
function setTrimIn(ms: number): void {
  if (!trimEnabled() || !scrub) return
  const out = trimOutMs ?? scrub.durationMs
  trimInMs = Math.max(0, Math.min(ms, out - TRIM_MIN_GAP_MS))
  syncTrim()
}

/** Sets the out-point; dragging to (or past) the end resets that side. */
function setTrimOut(ms: number): void {
  if (!trimEnabled() || !scrub) return
  const d = scrub.durationMs
  const v = Math.min(d, Math.max(ms, trimInMs + TRIM_MIN_GAP_MS))
  trimOutMs = v >= d ? null : v
  syncTrim()
}

function syncTrim(): void {
  timebar.setTrim(trimInMs, trimOutMs)
  syncTrimDropChip()
}

/**
 * The trim range as the export payload carries it (null = that side is
 * untrimmed), clamped to the manifest replay clock — the parsed video clock
 * can run slightly past the recorder's wall clock, like every lifetime stamp.
 */
function payloadTrim(): { start: number | null; end: number | null } {
  if (!trimActive() || !scrub) return { start: null, end: null }
  const start = trimInMs > 0 ? Math.min(Math.round(trimInMs), replayDurationMs) : null
  const end =
    trimOutMs !== null && trimOutMs < scrub.durationMs
      ? Math.min(Math.round(trimOutMs), replayDurationMs)
      : null
  // Degenerate after clamping (sub-ms replays): behave as untrimmed.
  if (start !== null && end !== null && end <= start) return { start: null, end: null }
  return { start, end }
}

/** Boxes whose lifetime falls WHOLLY outside the trim — dropped at save. */
function droppedByTrimCount(): number {
  const t = payloadTrim()
  if (t.start === null && t.end === null) return 0
  const start = t.start ?? 0
  const end = t.end ?? replayDurationMs
  let n = 0
  for (const a of state.annotations) {
    if (a.start_ms === undefined || a.end_ms === undefined) continue
    if (a.end_ms < start || a.start_ms > end) n += 1
  }
  return n
}

/** The subtle near-Save hint: "2 boxes outside trim will be dropped". */
function syncTrimDropChip(): void {
  const n = droppedByTrimCount()
  trimDropChip.hidden = n === 0
  if (n > 0) {
    trimDropChip.textContent =
      n === 1 ? t('editor.trimDropOne') : t('editor.trimDropMany', { count: n })
  }
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
 * Right-drag released on a viable rect — or a left click on a picked UI object
 * (GOAL "Static object picking"), which passes that object's identity and name:
 * build the real box (identity, z, default lifetime = scrub position ±
 * defaultManualDurationMs/2 clamped to the replay) and open the inline text
 * input focused. Enter commits, Esc discards.
 */
function beginPendingBox(b: Box, picked?: PickableObject): void {
  const stamp = state.nextStamp()
  const draft: Annotation = {
    annotation_id: stamp.annotation_id,
    type: 'box',
    bounds: { x: b.x, y: b.y, width: b.w, height: b.h },
    // Pre-filled from the object's name, falling back to its control type so a
    // nameless control still says what it is (SPEC §8.7).
    text: picked === undefined ? '' : objectLabel(picked),
    numbered: false,
    blur: false,
    tracking: { enabled: false },
    style: { color: state.color },
    created_at: stamp.created_at,
    z: stamp.z,
  }
  if (picked !== undefined) {
    draft.target = uiaTargetOf(picked)
    // Remembered so a later move/resize can tell whether the box still
    // annotates the object it claims to.
    pickedRects.set(draft.annotation_id, { x: b.x, y: b.y, w: b.w, h: b.h })
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
  // A pre-filled description opens SELECTED: keeping it is one Enter, replacing
  // it is just typing.
  openTextEditor(draft.bounds, draft.text, draft.text !== '')
  schedulePaint()
}

// ---------------------------------------------------------------------------
// Inline text input (new-box description / double-click text edit)
// ---------------------------------------------------------------------------

function openTextEditor(anchor: AnnotationBounds, value: string, selectAll = false): void {
  textAnchor = anchor
  textEditor.value = value
  textEditor.hidden = false
  positionTextEditor()
  textEditor.focus()
  if (selectAll) textEditor.select()
}

function positionTextEditor(): void {
  if (!textAnchor) return
  // Clamped inside #frame for the same reason the box header is: a 140px-min
  // input anchored to a box near the right edge would otherwise run off it.
  const maxLeft = Math.max(0, frame.clientWidth - textEditor.offsetWidth)
  textEditor.style.left = `${Math.max(0, Math.min(textAnchor.x * fitScale, maxLeft))}px`
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
  // F11 is a window shortcut, not an editing key: forwarded rather than
  // swallowed, so the advertised "works from anywhere" holds while typing a
  // box description (which is where re-edit spends most of its time).
  if (e.key === 'F11') return
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
    : t('editor.lifetimeAll')
}

function syncSelectionUi(): void {
  // Never while another display is on screen: that view is read-only, and the
  // header would float over a frame the selection does not belong to.
  const a = loaded && !exporting && viewingFocused() ? selectedVisibleAnnotation() : null
  if (a === null) {
    boxHeader.hidden = true
    closeDurationEditor(false)
    return
  }
  const b = annotationBounds(a)
  const pad = SELECTION_PAD * uiScale() // the header hugs the dashed selection rect
  const topLeft = toScreen(b.x - pad, b.y - pad)
  boxHeader.hidden = false
  // Clamped on BOTH edges (#stage is overflow:hidden). The fullscreen overlay
  // almost always leaves horizontal margin, but a windowed editor can be
  // resized until the image fills the stage — and a header pushed off the right
  // edge takes the blur toggle, the number toggle and the duration chip with it,
  // none of which have a keyboard fallback. offsetWidth is read after unhiding.
  const maxLeft = Math.max(4, stage.clientWidth - boxHeader.offsetWidth - 4)
  boxHeader.style.left = `${Math.max(4, Math.min(topLeft.x, maxLeft))}px`
  boxHeader.style.top = `${Math.max(28, topLeft.y - 4)}px`
  // [#|N]: shows the computed display number while numbering is on.
  const number = computeDisplayNumbers(state.annotations).get(a.annotation_id)
  numberBtn.textContent = a.numbered && number !== undefined ? String(number) : '#'
  numberBtn.classList.toggle('on', a.numbered)
  blurBtn.textContent = a.blur ? t('editor.blurOn') : t('editor.blur')
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
  // Same as the text input: F11 belongs to the window, so it is forwarded to
  // the window handler instead of dying in the popover.
  if (e.key === 'F11') return
  e.stopPropagation()
  if (e.key === 'Escape') closeDurationEditor()
})

durationInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return
  const ms = parseDurationMs(durationInput.value)
  if (ms !== null) setSelectedDuration(ms)
})

// ---------------------------------------------------------------------------
// Static object picking (GOAL "Static object picking (v0 — before full
// tracking)"): a left click that hits no box probes the real UI object under
// the cursor from the capture-instant Windows UI Automation dump. Hovering
// outlines it; clicking creates a box snapped to its exact bounds, pre-filled
// with its name and carrying its identity in `target` (SPEC §8.7).
// ---------------------------------------------------------------------------

/** The object under the cursor, or null when there is none (or picking is off). */
function objectAt(p: { x: number; y: number }): PickableObject | null {
  if (objectIndex === null || !viewingFocused()) return null
  return objectIndex.pick(p.x, p.y)
}

/** Hover probe. Cheap by design: nothing happens until the pointer moves. */
function probeObjectHover(p: { x: number; y: number } | null): void {
  if (objectIndex === null || objectIndex.size === 0) return
  if (p === null) {
    lastProbeX = -1
    lastProbeY = -1
    setHoverObject(null)
    return
  }
  if (p.x === lastProbeX && p.y === lastProbeY) return
  lastProbeX = p.x
  lastProbeY = p.y
  setHoverObject(objectAt(p))
}

function setHoverObject(next: PickableObject | null): void {
  if (next === hoverObject) return
  hoverObject = next
  if (next !== null) showObjectHintOnce()
  schedulePaint()
}

/**
 * The one honesty hint: object data is from the capture instant, so while the
 * user is scrubbed away from "now" the outlines describe a moment that is not
 * on screen. Picking stays allowed — the hint just says what it means.
 */
function showObjectHintOnce(): void {
  if (objectHintShown || scrub === null || scrub.atNow) return
  objectHintShown = true
  objectHint.textContent = t('editor.objectFromCapture')
  objectHint.hidden = false
  if (objectHintTimer !== null) window.clearTimeout(objectHintTimer)
  objectHintTimer = window.setTimeout(() => {
    objectHint.hidden = true
    objectHintTimer = null
  }, 6000)
}

// The rect a box was SNAPPED to when its `target` was stamped, per annotation
// id. `target` carries no geometry (name/control_type/automation_id/class_name
// only), so nothing downstream could ever notice that the box was later dragged
// somewhere else — and annotations.json, packdocs and the MCP tools would keep
// telling every AI reader that the box annotating one thing targets another.
const pickedRects = new Map<string, Box>()

/**
 * Drops `target` once the box no longer covers the element it was picked from.
 * Called after a committed move or resize; a box that still contains the
 * picked rect's centre is considered to be annotating the same object.
 */
function invalidateTargetIfMoved(id: string): void {
  const a = state.byId(id)
  if (!a || a.target === undefined) return
  const picked = pickedRects.get(id)
  if (picked === undefined) return
  const cx = picked.x + picked.w / 2
  const cy = picked.y + picked.h / 2
  const b = a.bounds
  const stillOn = cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height
  if (stillOn) return
  delete a.target
  pickedRects.delete(id)
}

/** `target` for a picked element (SPEC §8.7): empty fields are never written. */
function uiaTargetOf(o: PickableObject): AnnotationTarget {
  const target: UiaAnnotationTarget = { source: 'uia' }
  const name = o.element.name.trim()
  const controlType = o.element.control_type.trim()
  const automationId = o.element.automation_id.trim()
  const className = o.element.class_name.trim()
  if (name !== '') target.name = name
  if (controlType !== '') target.control_type = controlType
  if (automationId !== '') target.automation_id = automationId
  if (className !== '') target.class_name = className
  return target
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
  setHoverObject(null) // the outline has served its purpose the moment it is used
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
    syncLanes()
    schedulePaint()
    return
  }
  // No box here: probe the real UI object under the cursor (GOAL "Static object
  // picking"). A hit snaps a pre-filled box onto its exact bounds; a miss keeps
  // the old behavior — the click simply cleared the selection.
  const picked = objectAt(p)
  if (picked !== null) {
    beginPendingBox({ x: picked.x, y: picked.y, w: picked.width, h: picked.height }, picked)
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
    // A box dragged off the UI object it was snapped to stops claiming it.
    invalidateTargetIfMoved(d.id)
    state.pushUndoSnapshot(d.before)
  }
  schedulePaint()
  updateDirty() // move/resize commits bypass refresh()
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
      probeObjectHover(null)
      return
    }
  }
  const overBox = hitTest(visibleAnnotations(), p.x, p.y, ui) !== null
  overlay.style.cursor = overBox ? 'move' : 'default'
  // Object picking is what a left click on empty canvas does now, so the
  // outline is only offered where no box would take the click instead.
  probeObjectHover(overBox ? null : p)
}

// The outline must not linger once the pointer leaves the canvas.
overlay.addEventListener('pointerleave', () => probeObjectHover(null))

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
    // Zoom stays available while viewing another display; scrubbing does not
    // (it belongs to the focused display's replay).
    if (!scrub || !scrub.ready || !viewingFocused()) return
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
  // F11 toggles windowed/fullscreen from ANYWHERE in the editor (GOAL "Editor
  // Window Mode"): it is never an editing key (nor a composition key), so it is
  // answered FIRST — before the inline-input, typing, read-only-display and
  // unsaved-bar gates below. The inline inputs stopPropagation their keydowns,
  // so they forward this one explicitly (see their handlers).
  if (e.key === 'F11') {
    e.preventDefault()
    toggleWindowMode()
    return
  }
  // Inline inputs own their keys (their handlers stopPropagation; the contains
  // check covers focus landing on the duration editor's buttons).
  if (e.isComposing || e.target === textEditor) return
  if (e.target instanceof Node && durationEditor.contains(e.target)) return
  // The Esc bar's focused button owns Enter/Space: its native activation must
  // fire THAT button's click (Save / Save As New / Discard). Without this,
  // tabbing to [Save As New] or [Discard] and pressing Enter would fall
  // through to the global Enter-saves shortcut and overwrite the original
  // pack; Space would be swallowed by the pan modifier below.
  if (
    !unsavedBar.hidden &&
    e.target instanceof Node &&
    unsavedBar.contains(e.target) &&
    (e.key === 'Enter' || e.key === ' ')
  ) {
    return
  }
  const typing = e.target === titleInput || e.target === noteInput
  // Viewing another display is a read-only detour: Esc returns to the focused
  // display, Enter still saves (doExport switches back first), and every
  // editing shortcut below is inert until the focused display is back.
  if (!viewingFocused() && e.key !== 'Enter' && e.key !== ' ') {
    if (e.key === 'Escape') {
      e.preventDefault()
      void showDisplay(focusedDisplayIndex)
    }
    return
  }
  if (e.key === 'Escape') {
    // Cancel-current first: duration editor, then the unsaved-changes bar,
    // then an active selection. A bare Esc with nothing in progress closes the
    // editor — except in edit mode with unsaved changes, where it opens the
    // [Save] [Save As New CapturePack] [Discard] bar instead of discarding.
    if (durationEditorOpen) {
      closeDurationEditor()
      return
    }
    if (!unsavedBar.hidden) {
      hideUnsavedBar()
      return
    }
    if (state.selectedId !== null) {
      state.selectedId = null
      syncLanes()
      schedulePaint()
      return
    }
    if (editMode && dirty) {
      showUnsavedBar()
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
    // Replay Trim (GOAL "Replay Trim"): I/O set the in/out point at the
    // current scrub position ("now" = the end of the replay). Fresh-capture
    // flow only — the setters no-op in edit mode.
    case 'i':
      if (scrub?.ready) setTrimIn(scrub.atNow ? scrub.durationMs : scrub.tMs)
      break
    case 'o':
      if (scrub?.ready) setTrimOut(scrub.atNow ? scrub.durationMs : scrub.tMs)
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

windowModeBtn.addEventListener('click', () => {
  windowModeBtn.blur() // keyboard shortcuts belong to the canvas, not this button
  toggleWindowMode()
})

// ---------------------------------------------------------------------------
// Timeline bar
// ---------------------------------------------------------------------------

// Every callback is inert while a non-focused display is on screen (the bar is
// pointer-events:none then, but keyboard-driven paths reach it too).
const timebar = new Timebar(timebarEl, {
  scrubToFraction: (fraction) => {
    if (scrub && viewingFocused()) scrub.scrubTo(fraction * scrub.durationMs)
  },
  togglePlay: () => {
    if (viewingFocused()) scrub?.togglePlay()
  },
  // Clicking a lifetime bar selects the box and scrubs to its lifetime
  // midpoint (SPEC §8.4 — absent lifetime = the capture instant, i.e. "now").
  selectAnnotation: (id) => {
    if (!viewingFocused()) return
    const a = state.byId(id)
    if (!a) return
    state.selectedId = id
    if (scrub) scrub.scrubTo(lifetimeMidpoint(a, scrub.durationMs))
    syncLanes()
    schedulePaint()
  },
  // Trim handle drags (GOAL "Replay Trim"): fraction of the track -> ms.
  trimTo: (kind, fraction) => {
    if (!scrub || !viewingFocused()) return
    const ms = fraction * scrub.durationMs
    if (kind === 'in') setTrimIn(ms)
    else setTrimOut(ms)
  },
  // Double-click a handle: reset that side to the track edge.
  resetTrim: (kind) => {
    if (!trimEnabled() || !viewingFocused()) return
    if (kind === 'in') trimInMs = 0
    else trimOutMs = null
    syncTrim()
  },
})

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

async function doExport(kind: 'save' | 'saveAsNew' = 'save'): Promise<void> {
  if (!loaded || exporting) return
  // snapshot.png is composed from the base canvas, so the FOCUSED display must
  // be the one on screen — saving while viewing another display would ship the
  // wrong screen's pixels under the focused display's annotations.
  if (!viewingFocused()) {
    // showDisplay returns the IN-FLIGHT switch when one is running, so this
    // waits for the real completion; the second call then performs the switch
    // back to the focused display. (Pressing Enter within the ~100 ms a 4K
    // decode takes used to hit a no-op and look like a dropped keystroke.)
    await showDisplay(focusedDisplayIndex)
    if (!viewingFocused()) await showDisplay(focusedDisplayIndex)
    // Still not focused: the focused frame is unusable — refuse the save rather
    // than ship another display's pixels as snapshot.png.
    if (!viewingFocused()) return
  }
  exporting = true
  exportBtn.disabled = true
  scrub?.pause()
  commitTextEditor()
  closeDurationEditor(false)
  hideUnsavedBar(false)
  try {
    // A wheel burst right before Enter can leave a seek in flight; wait until
    // the base canvas shows the frame snapshotTMs will describe.
    if (scrub) await scrub.whenSettled()
    // Blur is NON-destructive (SPEC §9): snapshot.png keeps original pixels;
    // blur renders only into derived views (replay_annotated, editor preview).
    // The base canvas now shows the frame being exported (native snapshot or
    // scrubbed replay frame upscaled to native resolution).
    const snapshotPng = await composeExportPng(snapshot)
    // Edit mode ALWAYS ships null/null (GOAL "Replay Trim": re-edit cannot
    // trim — the pack's replay is already the original evidence); payloadTrim
    // itself returns null/null then, but the contract stays explicit here.
    const trim = editMode ? { start: null, end: null } : payloadTrim()
    const payload: EditorExportPayload = {
      annotations: state.annotations,
      snapshotPng,
      title: titleInput.value.trim(),
      note: noteInput.value.trim(),
      snapshotTMs: scrub ? scrub.exportTMs() : null,
      trimStartMs: trim.start,
      trimEndMs: trim.end,
    }
    if (kind === 'saveAsNew') window.editorBridge.saveAsNew(payload)
    else window.editorBridge.export(payload)
  } catch (err) {
    exporting = false
    exportBtn.disabled = false
    throw err
  }
}

async function initEditor(payload: EditorInitPayload): Promise<void> {
  // Language first: everything below may render user-visible text.
  t = makeT(payload.uiLanguage)
  applyDomI18n(t)
  timebar.setT(t)
  nativeW = payload.width
  nativeH = payload.height
  hasReplay = payload.hasReplay
  replayDurationMs = payload.replayDurationMs
  fps = payload.fps
  scrubInvert = payload.scrubInvert
  scrubSensitivityMs = payload.scrubSensitivityMs
  defaultManualDurationMs = payload.defaultManualDurationMs
  showDurationLabel = payload.showDurationLabel
  editMode = payload.editMode
  // The mode the window opened in (GOAL "Editor Window Mode") — the one the
  // user left behind last time. Applied before anything is laid out.
  applyWindowMode(payload.windowMode === 'windowed' ? 'windowed' : 'fullscreen')
  // Re-edit: adopt the saved pack's boxes (undo baseline; ids registered so
  // new ann_ ids continue past the loaded ones) and prefill title/note.
  state.restore(payload.annotations)
  // A loaded box carrying `target` was snapped to that object at its CURRENT
  // bounds, so those bounds are the picked rect: dragging it away in this
  // session drops the claim, exactly as it would for a freshly picked box.
  pickedRects.clear()
  for (const a of payload.annotations) {
    if (a.target === undefined) continue
    pickedRects.set(a.annotation_id, {
      x: a.bounds.x,
      y: a.bounds.y,
      w: a.bounds.width,
      h: a.bounds.height,
    })
  }
  titleInput.value = payload.title
  noteInput.value = payload.note
  // Kept alive: scrubbing back to "now" restores this sharpest frame.
  nativeBitmap = await createImageBitmap(new Blob([payload.snapshotPng], { type: 'image/png' }))
  focusedW = nativeW
  focusedH = nativeH
  // Captured displays (GOAL "Multi-Monitor Support"): the switcher appears only
  // when more than one was frozen; the focused one opens, as always.
  displayViews = payload.displays.map((d) => ({
    index: d.index,
    focused: d.focused,
    width: d.width,
    height: d.height,
    png: d.snapshotPng,
    bitmap: null,
  }))
  focusedDisplayIndex = displayViews.find((d) => d.focused)?.index ?? displayViews[0]?.index ?? 0
  viewDisplayIndex = focusedDisplayIndex
  // Static object picking (GOAL): one index build over the capture-instant UI
  // Automation elements, in the FOCUSED display's snapshot coordinate space.
  // An empty payload yields an empty index and picking stays silently off.
  objectIndex = ObjectIndex.build(payload.uiaElements, focusedW, focusedH)
  resizeCanvases()
  snapCtx.drawImage(nativeBitmap, 0, 0, nativeW, nativeH)
  buildDisplaySwitcher()
  replayChip.textContent = hasReplay
    ? t('editor.replaySeconds', { seconds: Math.round(payload.replayDurationMs / 1000) })
    : t('editor.noReplay')
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
    // Trim handles exist only in the fresh-capture flow (GOAL "Replay Trim");
    // in edit mode they stay hidden and the export payload stays null/null.
    timebar.setTrimEnabled(!editMode)
    timebar.update(controller)
    syncLanes()
  }
  // Dirty baseline = the loaded state exactly as restored above.
  baselineSig = editSig()
  layout()
  schedulePaint()
  overlay.focus()
}

// Windowed mode makes resizing a normal thing to do (GOAL "Editor Window
// Mode"): the canvas re-fits, and the SCREEN-SPACE chrome — the inline text
// input (via layout), the selected-box header, and the duration popover — is
// re-anchored to boxes that have just moved on screen. (The timebar is
// percentage-positioned and follows on its own.)
window.addEventListener('resize', () => {
  layout()
  syncSelectionUi()
  schedulePaint()
})

window.editorBridge.onInit((payload) => {
  void initEditor(payload)
})

// Main is the authority on the window state: every mode change lands here,
// including the ones this renderer asked for.
window.editorBridge.onWindowMode((mode) => {
  applyWindowMode(mode === 'windowed' ? 'windowed' : 'fullscreen')
})

colorSwatch.style.background = state.color
