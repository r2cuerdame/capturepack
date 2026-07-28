// Annotation editor renderer: toolless box annotation over the captured
// desktop (GOAL "Unified Annotation Box"). One annotation type — the box —
// created with a RIGHT-DRAG, selected with a LEFT CLICK; a floating header on
// the selection toggles number/blur, edits the lifetime, and deletes.
//
// THE BOARD (GOAL "Multi-Monitor Support"): every display the capture froze is
// drawn AT ONCE, side by side in its real arrangement (board.ts owns that
// geometry), and every one of them is annotatable. A box belongs to the display
// it was drawn on and its bounds stay in THAT display's snapshot pixel space;
// one clock scrubs every display's replay together. A single-display capture
// builds a one-display board and behaves exactly as this editor always did.
import type { EditorExportPayload, EditorInitPayload } from '../../shared/ipc'
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
import { ObjectIndex, objectHoverLabel, objectLabel } from './objects'
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
  clearDisplayRegion,
  composeExportPng,
  drawDisplayBase,
  drawDisplayFrame,
  drawDisplayScene,
  drawObjectHover,
  handleAt,
  hitTest,
  SELECTION_PAD,
  type HandleId,
} from './render'
import { buildBoard, displayAtBoardPoint, toBoardPoint, toNativePoint } from './board'
import type { BoardDisplay, BoardInput, BoardLayout } from './board'
import { BoardScrub, wheelScrubDeltaMs } from './scrub'
import type { BoardReplayInput } from './scrub'
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
const displayLegend = el<HTMLSpanElement>('displayLegend')
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
// FOCUSED display's original snapshot, kept for restoring the "now" frame after
// scrubbing AND for composing snapshot.png at full native resolution.
let nativeBitmap: ImageBitmap | null = null
let scrub: BoardScrub | null = null
// THE BOARD (GOAL "Multi-Monitor Support"): the geometry of every captured
// display, laid out in its real arrangement. Always present once loaded — a
// single-display capture is a one-display board.
let board: BoardLayout | null = null
/** Per-display runtime state, keyed by the manifest display index. */
interface DisplayRuntime {
  index: number
  // The frozen frame. Kept alive only while it can still be needed: a display
  // with a replay must restore this whenever the clock returns to "now", while
  // a display WITHOUT one is drawn once and its bitmap released (a 4K frame is
  // 33 MB, and a board holds several).
  bitmap: ImageBitmap | null
  // This display's frame could not be decoded: its region is drawn empty and
  // its legend chip says so, rather than silently showing the wrong screen.
  broken: boolean
}
const runtimes = new Map<number, DisplayRuntime>()
let focusedDisplayIndex = 0
// Native size of the FOCUSED display — the coordinate space of snapshot.png and
// of every annotation that carries no `display`.
let focusedW = 0
let focusedH = 0
// Static object picking (GOAL "Static object picking (v0)"): the capture-instant
// UI Automation objects — every visible WINDOW plus the CONTROLS of the windows
// whose tree the dump reached — indexed once at init. An empty index (no dump, a
// timed-out dump, a pack without plugins/windows-uia) leaves every path below
// behaving exactly as it did before the feature existed.
let objectIndex: ObjectIndex | null = null
let hoverObject: PickableObject | null = null
// The board display the hovered object belongs to — always the focused one (the
// dump is mapped into ITS snapshot space, SPEC §11.3), kept explicitly so the
// outline is drawn with that display's transform and never on a neighbour.
let hoverDisplay: BoardDisplay | null = null
// Last probed snapshot pixel: hovering does NO work until the pointer moves off it.
let lastProbeX = -1
let lastProbeY = -1
let lastProbeDisplay = -1
// WINDOW-LEVEL MODIFIER (GOAL "Static object picking"): a control on top of a
// window normally wins, because it is the more precise annotation. Holding
// SHIFT forces the window level back — Shift is free on the canvas (it is a
// wheel-scrub step modifier, never a pointer one) and, unlike Alt, Windows does
// not claim it for menu activation.
let windowLevelKey = false
// One-time hints (GOAL: honest feedback). Each says its thing once per editor
// session — object data is a best-effort extra, and repeating any of these
// would be nagging.
type ObjectHintKind =
  | 'fromCapture'
  | 'windowModifier'
  | 'windowOnly'
  | 'windowNoTree'
  | 'windowOffDisplay'
  | 'noData'
  | 'otherDisplay'
const objectHintsShown = new Set<ObjectHintKind>()
let objectHintTimer: number | null = null
// Each hint is shown ONCE per session, so one that is replaced mid-read is lost
// for good: a second one raised while the chip is busy waits its turn instead.
const objectHintQueue: string[] = []
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

// Every drag remembers the DISPLAY it started on: a box belongs to one screen,
// so the pointer is mapped into that screen's native pixels (clamped at its
// edges) for the whole gesture. Dragging past the edge stops at it instead of
// teleporting the box onto the neighbour, where its bounds would mean something
// entirely different.
type Drag =
  | { kind: 'draw'; d: BoardDisplay; x0: number; y0: number; x: number; y: number }
  | {
      kind: 'move'
      d: BoardDisplay
      id: string
      lastX: number
      lastY: number
      before: Annotation[]
      moved: boolean
    }
  | {
      kind: 'resize'
      d: BoardDisplay
      id: string
      handle: HandleId
      before: Annotation[]
      moved: boolean
    }
let drag: Drag | null = null

// The inline text input serves two flows: a freshly right-dragged box waiting
// for its description (Enter commits the box, Esc discards it) and editing the
// text of an existing box (double-click).
type TextSession = { kind: 'new'; draft: Annotation } | { kind: 'edit'; id: string }
let textSession: TextSession | null = null
// Bounds the text input hangs under (live object: repositions track the box).
let textAnchor: AnnotationBounds | null = null
// The display those bounds belong to — the input is positioned in board space.
let textDisplay: BoardDisplay | null = null

// ---------------------------------------------------------------------------
// Board scales. Three spaces meet in the editor (see board.ts): NATIVE pixels
// of one display, BOARD units (device-independent pixels of the arrangement),
// and the board CANVAS backing store. Everything below converts between them,
// and every one of them accounts for the viewport's zoom by measuring the
// canvas's ACTUAL on-screen rect.
// ---------------------------------------------------------------------------

/** On-screen CSS pixels per BOARD unit, zoom included. */
function screenPerBoardUnit(): number {
  const r = overlay.getBoundingClientRect()
  if (board !== null && board.width > 0 && r.width > 0) return r.width / board.width
  return fitScale
}

/** 1 / on-screen scale of one NATIVE pixel of `d` — stroke sizes on that display. */
function uiOf(d: BoardDisplay): number {
  const perNative = screenPerBoardUnit() * (d.bw > 0 ? d.bw / d.width : 1)
  return perNative > 0 ? 1 / perNative : 1
}

/** 1 / on-screen scale of one board CANVAS pixel — the per-display chrome. */
function uiBoard(): number {
  const per = screenPerBoardUnit() / (board?.ratio ?? 1)
  return per > 0 ? 1 / per : 1
}

// ---------------------------------------------------------------------------
// Layout + painting
// ---------------------------------------------------------------------------

function layout(): void {
  if (!loaded || board === null) return
  const pad = 24
  const availW = Math.max(1, stage.clientWidth - pad * 2)
  const availH = Math.max(1, stage.clientHeight - pad * 2)
  // The WHOLE board is fitted, never one display: seeing both screens at once
  // is the point of the feature (a two-monitor capture that can only be read
  // one screen at a time is the bug this replaces). Zoom then takes over for
  // detail work, on the board as a whole.
  fitScale = Math.min(availW / board.width, availH / board.height, 1)
  frame.style.width = `${board.width * fitScale}px`
  frame.style.height = `${board.height * fitScale}px`
  positionTextEditor()
}

/** The board display an index names, or null when the board does not have it. */
function displayByIndex(index: number): BoardDisplay | null {
  return board?.displays.find((d) => d.index === index) ?? null
}

/** The focused display — the board always has one once loaded. */
function focusedDisplay(): BoardDisplay | null {
  return displayByIndex(focusedDisplayIndex)
}

/**
 * WHICH display a box belongs to (SPEC §8.8). An absent `display` means the
 * focused one, which is what every box on the focused screen — and every box in
 * every pack written before the board existed — carries.
 *
 * An index the board does not have (a hand-edited annotations.json) resolves to
 * the focused display rather than vanishing: an unreachable box could never be
 * selected, moved, or deleted.
 */
function displayOf(a: Annotation): BoardDisplay | null {
  if (typeof a.display === 'number') {
    const d = displayByIndex(a.display)
    if (d !== null) return d
  }
  return focusedDisplay()
}

/** The index `displayOf` resolves to — the grouping key for per-display draws. */
function displayIndexOf(a: Annotation): number {
  return displayOf(a)?.index ?? focusedDisplayIndex
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
// The board legend (GOAL "Multi-Monitor Support"): a compact chip per captured
// display marking which one is focused. It is a NAVIGATION aid, not a switcher
// — every display is on screen and annotatable all the time; clicking a chip
// only zooms the board onto that screen, and Esc/0 fits the whole board again.
// Hidden entirely for a single-display capture.
// ---------------------------------------------------------------------------

function buildDisplayLegend(): void {
  displayLegend.replaceChildren()
  const displays = board?.displays ?? []
  if (displays.length < 2) {
    displayLegend.hidden = true
    return
  }
  for (const d of displays) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = String(d.index)
    btn.title = d.focused
      ? t('editor.displayFocusedTooltip', { index: d.index })
      : t('editor.displayTooltip', { index: d.index })
    btn.classList.toggle('focusedDisplay', d.focused)
    btn.addEventListener('click', () => {
      btn.blur() // keyboard shortcuts belong to the canvas, not this button
      zoomToDisplay(d.index)
    })
    displayLegend.append(btn)
  }
  displayLegend.hidden = false
  syncDisplayLegend()
}

function syncDisplayLegend(): void {
  const displays = board?.displays ?? []
  if (displays.length < 2) return
  const buttons = displayLegend.querySelectorAll('button')
  displays.forEach((d, i) => {
    const btn = buttons[i]
    if (btn === undefined) return
    // A frame that could not be decoded: the chip says so rather than looking
    // live over an empty region.
    btn.classList.toggle('brokenDisplay', runtimes.get(d.index)?.broken === true)
  })
}

/** The caption drawn inside a display's own frame on the board. */
function displayLabel(d: BoardDisplay): string {
  const base = d.focused
    ? t('editor.displayLabelFocused', { index: d.index })
    : t('editor.displayLabel', { index: d.index })
  if (runtimes.get(d.index)?.broken === true) return `${base} · ${t('editor.displayBroken')}`
  // Only worth saying while there IS a clock: in a screenshot-only pack every
  // display is a frozen frame and the marker would be noise on all of them.
  if (scrub !== null && !d.hasReplay) return `${base} · ${t('editor.displayFrozen')}`
  return base
}

/**
 * Frames one display in the stage at the largest usable scale (GOAL: the
 * focused display "opens centered and at the largest scale" — here on demand,
 * for any display, because every one of them is now a place work happens).
 */
function zoomToDisplay(index: number): void {
  const d = displayByIndex(index)
  if (d === null || board === null || !loaded) return
  viewport.focusRect(
    { x: d.bx * fitScale, y: d.by * fitScale, width: d.bw * fitScale, height: d.bh * fitScale },
    board.width * fitScale,
    board.height * fitScale,
    stage.clientWidth,
    stage.clientHeight,
  )
  syncPanCursor()
  syncSelectionUi()
  schedulePaint()
}

/** Back to the whole board, unzoomed — the state the editor opens in. */
function fitBoard(): void {
  viewport.reset()
  syncPanCursor()
  syncSelectionUi()
  schedulePaint()
}

/** Canvas backing store = the board's bounded-budget size (board.ts). */
function resizeCanvases(): void {
  if (board === null) return
  snapshot.width = board.canvasWidth
  snapshot.height = board.canvasHeight
  overlay.width = board.canvasWidth
  overlay.height = board.canvasHeight
}

/**
 * Paints ONE display's base frame into its region of the shared board canvas:
 * a replay frame seeked to the board clock, or that display's frozen snapshot.
 *
 * There is exactly one base canvas and one overlay canvas for the whole board —
 * N canvases per display is what would make a three-screen 4K capture
 * unaffordable (board.ts owns the budget).
 */
function drawDisplayBaseFrame(index: number, source: HTMLVideoElement | 'native'): void {
  if (!loaded || board === null) return
  const d = displayByIndex(index)
  if (d === null) return
  const image = source === 'native' ? (runtimes.get(index)?.bitmap ?? null) : source
  if (image === null) {
    clearDisplayRegion(snapCtx, d)
  } else {
    drawDisplayBase(snapCtx, d, image)
  }
  schedulePaint() // blur previews sample the base canvas
}

/** Draws every display's frozen frame — the board's opening state. */
function drawAllFrozen(): void {
  if (board === null) return
  for (const d of board.displays) {
    drawDisplayBaseFrame(d.index, 'native')
    // A display that will never move (no replay of its own) needs its bitmap
    // only for this one draw; the board canvas keeps the pixels from here on.
    const rt = runtimes.get(d.index)
    if (rt !== undefined && !d.hasReplay && rt.bitmap !== null && !d.focused) {
      rt.bitmap.close()
      rt.bitmap = null
    }
  }
}

let paintQueued = false
function schedulePaint(): void {
  if (paintQueued) return
  paintQueued = true
  requestAnimationFrame(() => {
    paintQueued = false
    if (!loaded || board === null) return
    overlayCtx.setTransform(1, 0, 0, 1, 0, 0)
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height)
    // Display numbers are GLOBAL (SPEC §8.5) — over ALL boxes of the pack, on
    // every screen, via the one shared implementation. The board is one
    // document: box ② is ② whichever monitor it sits on, and the editor can
    // never disagree with replay_annotated/report/README/MCP.
    const numbers = displayNumbers()
    const scene = sceneAnnotations()
    const selected = paintedSelectionId()
    const chrome = uiBoard()
    for (const d of board.displays) {
      const own = scene.filter((a) => displayIndexOf(a) === d.index)
      drawDisplayScene(overlayCtx, snapshot, d, own, selected, numbers, uiOf(d))
      drawDisplayFrame(overlayCtx, d, displayLabel(d), d.focused, chrome)
    }
    // Object hover last, on top of everything (GOAL "Static object picking") —
    // and never while a drag or a pending description is in progress.
    if (
      hoverObject !== null &&
      hoverDisplay !== null &&
      drag === null &&
      textSession === null &&
      !exporting
    ) {
      drawObjectHover(
        overlayCtx,
        hoverDisplay,
        { x: hoverObject.x, y: hoverObject.y, w: hoverObject.width, h: hoverObject.height },
        hoverChipLabel(hoverObject),
        uiOf(hoverDisplay),
        hoverObject.level,
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

/** The boxes of ONE display that apply at the current board position. */
function visibleAnnotationsOn(index: number): readonly Annotation[] {
  return visibleAnnotations().filter((a) => displayIndexOf(a) === index)
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

/** A pointer position in BOARD units, or null before the board exists. */
function toBoardUnits(e: PointerEvent | MouseEvent): { x: number; y: number } | null {
  if (board === null) return null
  // Derived from the on-screen rect so the mapping stays correct under the
  // viewport's zoom/pan transform.
  const r = overlay.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0) return null
  return {
    x: ((e.clientX - r.left) * board.width) / r.width,
    y: ((e.clientY - r.top) * board.height) / r.height,
  }
}

/** The display under the pointer and the point in ITS native pixels, or null. */
function pointAt(e: PointerEvent | MouseEvent): { d: BoardDisplay; x: number; y: number } | null {
  const b = toBoardUnits(e)
  if (b === null || board === null) return null
  const d = displayAtBoardPoint(board, b.x, b.y)
  if (d === null) return null // the gutter between screens belongs to no display
  return { d, ...toNativePoint(d, b.x, b.y) }
}

/**
 * The pointer in ONE display's native pixels, whatever it is over. Drags use
 * this: a box belongs to the screen it was started on, so pulling the pointer
 * onto the neighbour clamps at the edge instead of jumping the box into a
 * coordinate space where its bounds would mean something else.
 */
function pointOn(d: BoardDisplay, e: PointerEvent | MouseEvent): { x: number; y: number } {
  const b = toBoardUnits(e)
  if (b === null) return { x: 0, y: 0 }
  return toNativePoint(d, b.x, b.y)
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
 *
 * `on` is the display the box was drawn on: its index is stamped into
 * `display` — except on the FOCUSED display, which writes nothing, so a
 * single-monitor pack (and every box on the focused screen) is byte-identical
 * to what this editor wrote before the board existed (SPEC §8.8).
 */
function beginPendingBox(on: BoardDisplay, b: Box, picked?: PickableObject): void {
  const stamp = state.nextStamp()
  const draft: Annotation = {
    annotation_id: stamp.annotation_id,
    type: 'box',
    bounds: { x: b.x, y: b.y, width: b.w, height: b.h },
    ...(on.index === focusedDisplayIndex ? {} : { display: on.index }),
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
  openTextEditor(on, draft.bounds, draft.text, draft.text !== '')
  // GOAL "Unified Annotation Box" — the header appears WITH the description
  // input: [#] [1.0s] [Blur] [×] are placed over the pending rect now, not
  // after a commit + re-select, so number/duration/blur can be set while
  // typing. Synchronous (schedulePaint's rAF would show it a frame late).
  syncSelectionUi()
  schedulePaint()
}

// ---------------------------------------------------------------------------
// Inline text input (new-box description / double-click text edit)
// ---------------------------------------------------------------------------

function openTextEditor(
  on: BoardDisplay,
  anchor: AnnotationBounds,
  value: string,
  selectAll = false,
): void {
  textAnchor = anchor
  textDisplay = on
  textEditor.value = value
  textEditor.hidden = false
  positionTextEditor()
  textEditor.focus()
  if (selectAll) textEditor.select()
}

function positionTextEditor(): void {
  if (!textAnchor || textDisplay === null) return
  // The input lives in #frame (BOARD CSS space), so the box's native anchor is
  // converted through its own display first — otherwise a box on the second
  // screen would get its description input over the first one.
  const topLeft = toBoardPoint(textDisplay, textAnchor.x, textAnchor.y + textAnchor.height)
  // Clamped inside #frame for the same reason the box header is: a 140px-min
  // input anchored to a box near the right edge would otherwise run off it.
  const maxLeft = Math.max(0, frame.clientWidth - textEditor.offsetWidth)
  textEditor.style.left = `${Math.max(0, Math.min(topLeft.x * fitScale, maxLeft))}px`
  textEditor.style.top = `${topLeft.y * fitScale + 6}px`
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
  // A discarded object-pick must not leave its remembered rect behind: the box
  // it belonged to never reaches the store, so nothing would ever clean up the
  // entry beginPendingBox registered under an id that now means nothing.
  const pending = pendingDraft()
  if (pending !== null) pickedRects.delete(pending.annotation_id)
  // The pending box's own chrome goes with it (the duration editor may have
  // been opened from the header while typing).
  closeDurationEditor(false)
  closeTextEditor()
  refresh()
}

function closeTextEditor(refocus = true): void {
  textSession = null
  textAnchor = null
  textDisplay = null
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
  if (e.key === 'Enter') {
    // Enter commits the box WITH whatever the header toggles were set to while
    // typing — number, lifetime, blur are all already on the draft.
    commitTextEditor()
  } else if (e.key === 'Escape') {
    // Cancel-current first, like the canvas Esc ladder: an open duration
    // popover is dismissed before the box it belongs to. Otherwise Esc
    // discards the WHOLE pending box, not just the text.
    if (durationEditorOpen) closeDurationEditor()
    else cancelTextEditor()
  }
})
textEditor.addEventListener('blur', (e) => {
  // Focus landing inside the box's OWN header (or the duration editor it opens)
  // is an edit of the box being created, not the end of it — the description
  // stays open and the pending box uncommitted. The header buttons also
  // preventDefault their mousedown, so they never take focus at all; this
  // covers the one control that legitimately does: the custom-duration input.
  const next = e.relatedTarget
  if (next instanceof Node && (boxHeader.contains(next) || durationEditor.contains(next))) return
  commitTextEditor(false)
})

// ---------------------------------------------------------------------------
// Box header: [#|N] number toggle, duration chip, blur toggle, and × delete,
// floating above the box. Lives in #stage screen space, repositioned from the
// box bounds so zoom/pan never detaches it.
//
// It serves TWO boxes (GOAL "Unified Annotation Box" — "the header appears with
// the description input"): the box being CREATED, from the instant the
// right-drag ends until Enter/Esc, and — with nothing pending — the selected
// box. The pending box always wins: it is the one the user is looking at.
// ---------------------------------------------------------------------------

let durationEditorOpen = false

/** The box being created (right-drag released, description still open). */
function pendingDraft(): Annotation | null {
  return textSession?.kind === 'new' ? textSession.draft : null
}

/** The selected box, if it applies at the current scrub position. */
function selectedVisibleAnnotation(): Annotation | null {
  if (state.selectedId === null) return null
  const a = state.byId(state.selectedId)
  return a !== undefined && annotationVisibleNow(a) ? a : null
}

/**
 * The box every header control acts on: the pending one while a box is being
 * created (its lifetime is irrelevant — it is drawn regardless), else the
 * selection.
 */
function headerAnnotation(): Annotation | null {
  return pendingDraft() ?? selectedVisibleAnnotation()
}

/**
 * Display numbers over every box on screen — the PENDING one included, so the
 * [#] toggle shows the number the box will actually get once committed (SPEC
 * §8.5 ordering, one shared implementation). The draft sorts by the same rules
 * as any committed box, so nothing renumbers on commit.
 */
function displayNumbers(): ReadonlyMap<string, number> {
  const pending = pendingDraft()
  return computeDisplayNumbers(
    pending === null ? state.annotations : [...state.annotations, pending],
  )
}

/** The box drawn with selection chrome: the pending one, else the selection. */
function paintedSelectionId(): string | null {
  return pendingDraft()?.annotation_id ?? state.selectedId
}

/**
 * Where focus belongs once a header popover closes: back in the description
 * input while a box is being created — the header must never end the typing it
 * appeared alongside — and on the canvas otherwise.
 *
 * "Otherwise" excludes the top bar's title/note fields: the header is also
 * shown for a merely SELECTED box, so [#]/[Blur] can be clicked mid-sentence in
 * the pack title. Yanking focus to the canvas there would feed the rest of the
 * sentence to the shortcut ladder (c cycles the colour, Delete deletes the box).
 * The header's mousedown preventDefault already keeps focus out of the buttons
 * themselves, so leaving it exactly where it is, is right.
 */
function refocusEditing(): void {
  if (textSession !== null && !textEditor.hidden) textEditor.focus()
  else if (document.activeElement !== titleInput && document.activeElement !== noteInput) overlay.focus()
}

/** Maps a point in ONE display's native pixels to #stage-relative screen px. */
function toScreen(d: BoardDisplay, x: number, y: number): { x: number; y: number } {
  const or = overlay.getBoundingClientRect()
  const sr = stage.getBoundingClientRect()
  const p = toBoardPoint(d, x, y)
  const scale =
    board !== null && board.width > 0 && or.width > 0 ? or.width / board.width : fitScale
  return { x: or.left - sr.left + p.x * scale, y: or.top - sr.top + p.y * scale }
}

function chipLabel(a: Annotation): string {
  return a.start_ms !== undefined && a.end_ms !== undefined
    ? formatDurationLabel(a.end_ms - a.start_ms)
    : t('editor.lifetimeAll')
}

function syncSelectionUi(): void {
  const a = loaded && !exporting ? headerAnnotation() : null
  const on = a === null ? null : displayOf(a)
  if (a === null || on === null) {
    boxHeader.hidden = true
    closeDurationEditor(false)
    return
  }
  const b = annotationBounds(a)
  // The header hugs the dashed selection rect — in the box's OWN display's
  // pixels, so it stays glued to a box on any screen of the board.
  const pad = SELECTION_PAD * uiOf(on)
  const topLeft = toScreen(on, b.x - pad, b.y - pad)
  // #stage is overflow:hidden, and the board makes "the selection is somewhere
  // off screen" routine: zoomToDisplay (1..9, a legend chip) does not clear the
  // selection, so framing another display leaves the box outside the viewport
  // entirely. A header pinned to the stage edge then floats over a screen the
  // box is not on and points at nothing, which is worse than no header.
  const bottomRight = toScreen(on, b.x + b.w + pad, b.y + b.h + pad)
  if (
    bottomRight.x < 0 ||
    bottomRight.y < 0 ||
    topLeft.x > stage.clientWidth ||
    topLeft.y > stage.clientHeight
  ) {
    boxHeader.hidden = true
    closeDurationEditor(false)
    return
  }
  boxHeader.hidden = false
  // The box is not committed yet (Enter commits, Esc discards it): the header
  // says so with the same accent the dashed selection rect uses.
  boxHeader.classList.toggle('pending', pendingDraft() !== null)
  // Clamped on BOTH edges (#stage is overflow:hidden). The fullscreen overlay
  // almost always leaves horizontal margin, but a windowed editor can be
  // resized until the image fills the stage — and a header pushed off the right
  // edge takes the blur toggle, the number toggle and the duration chip with it,
  // none of which have a keyboard fallback. offsetWidth is read after unhiding.
  const maxLeft = Math.max(4, stage.clientWidth - boxHeader.offsetWidth - 4)
  boxHeader.style.left = `${Math.max(4, Math.min(topLeft.x, maxLeft))}px`
  // Clamped on BOTH edges for the same reason as `left`: a selection panned or
  // zoomed below the viewport used to take the whole header — number, blur,
  // duration, delete — off the bottom of an overflow:hidden stage.
  const maxTop = Math.max(28, stage.clientHeight - boxHeader.offsetHeight - 4)
  boxHeader.style.top = `${Math.max(28, Math.min(topLeft.y - 4, maxTop))}px`
  // [#|N]: shows the computed display number while numbering is on — for a
  // pending box, the number it will carry the moment Enter commits it.
  const number = displayNumbers().get(a.annotation_id)
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

/**
 * Applies a mutation to the header's box, then refreshes all views.
 *
 * A PENDING box is mutated in place with no undo snapshot: it is not in the
 * store yet, Esc (or the header ×) discards the whole box, and pushing a
 * snapshot of a state the box does not exist in would make Ctrl+Z after the
 * commit undo the wrong step. A committed box goes through the normal
 * undoable path.
 */
function applyMutation(mutate: (a: Annotation) => void): void {
  const pending = pendingDraft()
  if (pending !== null) {
    mutate(pending)
    // Repaints the live preview (blur, number badge, border) and re-syncs the
    // header labels — the pending box is in neither the store nor the lanes.
    schedulePaint()
    syncSelectionUi()
    return
  }
  const a = selectedVisibleAnnotation()
  if (a === null) return
  const before = state.cloneAnnotations()
  mutate(a)
  state.pushUndoSnapshot(before)
  refresh()
}

// Delete mirrors the header ×: both act only while the box is visible at the
// current scrub position — a hidden box never vanishes silently. On a pending
// box it discards the box being created, exactly like Esc.
function deleteSelected(): void {
  if (pendingDraft() !== null) {
    cancelTextEditor()
    return
  }
  const a = selectedVisibleAnnotation()
  if (a === null) return
  state.remove(a.annotation_id)
  // Same reason as cancelTextEditor: the box is gone, so its picked rect is too.
  pickedRects.delete(a.annotation_id)
  refresh()
}

// Typing must survive every header control (GOAL: "Toggling a control never
// steals focus from the input"). Suppressing the default mousedown action keeps
// focus wherever it is — in the description input of the box being created —
// so no blur fires, nothing commits early, and Enter still ends the box.
// Clicks are unaffected: preventDefault on mousedown does not cancel them.
boxHeader.addEventListener('mousedown', (e) => e.preventDefault())

// The SAME rule for the canvas, and for the same reason. #overlay carries
// tabindex="-1", so it is mouse-focusable: focusing is a default action of
// mousedown, which Chromium dispatches AFTER the pointerdown handler has
// already opened a pending box's description input (the static-object-picking
// path). Without this, focus is pulled straight back to the canvas, textEditor
// blurs with relatedTarget === overlay, and the box commits itself instantly —
// no description, no [#] [1.0s] [Blur] [×] header, no Esc-discards. Guarded on
// an open session so an ordinary click on empty canvas still focuses the
// overlay and keeps the keyboard shortcuts working.
overlay.addEventListener('mousedown', (e) => {
  if (textSession !== null) e.preventDefault()
})

numberBtn.addEventListener('click', () => {
  applyMutation((a) => {
    a.numbered = !a.numbered
  })
  refocusEditing()
})

blurBtn.addEventListener('click', () => {
  applyMutation((a) => {
    a.blur = !a.blur
  })
  refocusEditing()
})

deleteBtn.addEventListener('click', deleteSelected)

// ---------------------------------------------------------------------------
// Inline duration editor (opened from the header's duration chip)
// ---------------------------------------------------------------------------

function openDurationEditor(): void {
  if (headerAnnotation() === null || !scrub) return
  durationEditorOpen = true
  durationInput.value = ''
  durationEditor.hidden = false
  positionDurationEditor()
  // While a box is being created the description input keeps focus: the presets
  // are one click away and Enter must still commit the box, not a duration the
  // user never typed. Otherwise the custom field takes focus as it always did.
  if (pendingDraft() === null) durationInput.focus()
}

/** Esc / outside-click path: closes without applying anything. */
function closeDurationEditor(refocus = true): void {
  if (!durationEditorOpen) return
  durationEditorOpen = false
  durationEditor.hidden = true
  if (refocus) refocusEditing()
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

// Same rule as the header (see boxHeader's mousedown): a preset click edits the
// lifetime of the box being created without taking focus off its description.
// The custom-duration input is the one exception — it has to be typed in, and
// the description's blur handler knows that focus landing in here is not the
// end of the pending box.
durationEditor.addEventListener('mousedown', (e) => {
  if (e.target !== durationInput) e.preventDefault()
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
//
// TWO LEVELS. The WINDOW is the floor — the dump lists every visible top-level
// window, so picking has an answer wherever a window is, including over the
// Chromium/Electron windows that expose no control tree. A CONTROL refines it
// where one was collected; SHIFT forces the window level back. The hover chip
// always says which level a click would take.
// ---------------------------------------------------------------------------

/**
 * The object under the cursor, or null when there is none.
 *
 * The dump is mapped into the FOCUSED display's snapshot space (SPEC §11.3), so
 * that is the only screen it can answer for. On any other display picking is
 * simply off — and says so once (announceObject), because the index is not
 * empty and silence there would read as "this window has no objects".
 */
function objectAt(d: BoardDisplay, p: { x: number; y: number }): PickableObject | null {
  if (objectIndex === null || d.index !== focusedDisplayIndex) return null
  return objectIndex.pick(p.x, p.y, windowLevelKey)
}

/** Hover probe. Cheap by design: nothing happens until the pointer moves. */
function probeObjectHover(p: { d: BoardDisplay; x: number; y: number } | null): void {
  if (objectIndex === null || objectIndex.size === 0) return
  if (p === null) {
    lastProbeX = -1
    lastProbeY = -1
    setHoverObject(null, null)
    return
  }
  if (p.d.index === lastProbeDisplay && p.x === lastProbeX && p.y === lastProbeY) return
  lastProbeDisplay = p.d.index
  lastProbeX = p.x
  lastProbeY = p.y
  const next = objectAt(p.d, p)
  setHoverObject(next, p.d)
  // HOVER only ever describes an offer that IS on screen. The empty cases —
  // "no object data here", "object data covers display N only" — are answers to
  // an ACTION that failed, and merely sweeping the pointer over wallpaper (or
  // onto the second screen of a board) would otherwise fire them within seconds
  // of every capture opening, for a user who never touched object picking. The
  // pointerdown path says them when a click actually snapped nothing.
  if (next !== null) announceObject(p.d, next)
}

/** Re-probes the last point after the modifier changed the answer. */
function reprobeObjectHover(): void {
  if (objectIndex === null || lastProbeX < 0 || lastProbeY < 0) return
  const d = displayByIndex(lastProbeDisplay)
  if (d === null) return
  const next = objectAt(d, { x: lastProbeX, y: lastProbeY })
  setHoverObject(next, d)
  // Same rule as the hover probe: only a real offer speaks here.
  if (next !== null) announceObject(d, next)
}

function setHoverObject(next: PickableObject | null, on: BoardDisplay | null): void {
  if (next === hoverObject && (next === null || on === hoverDisplay)) return
  hoverObject = next
  hoverDisplay = next === null ? null : on
  schedulePaint()
}

/** The hover chip's text: what would be picked, and at which level. */
function hoverChipLabel(o: PickableObject): string {
  const label = objectHoverLabel(o)
  return o.level === 'window'
    ? t('editor.objectLevelWindow', { label })
    : t('editor.objectLevelControl', { label })
}

/**
 * Honest feedback (GOAL). Picking is a best-effort extra built on a dump that
 * is budgeted, one instant old, and blind to some windows — so every gap says
 * so once, instead of leaving a click that does nothing to speak for it.
 *
 * Priority matters: the first hint that has not been shown yet wins the chip,
 * and staleness of the data beats anything about levels.
 */
function announceObject(on: BoardDisplay, o: PickableObject | null): void {
  if (o === null) {
    // Another screen of the board: the dump lives in the FOCUSED display's
    // coordinate space (SPEC §11.3), so there is nothing to offer here — which
    // is a fact about the DATA, not about this screen's windows. Annotating
    // works exactly the same; only the snap-to-object shortcut does not.
    if (on.index !== focusedDisplayIndex) {
      showObjectHintOnce(
        'otherDisplay',
        t('editor.objectOtherDisplay', { index: focusedDisplayIndex }),
      )
      return
    }
    // Nothing here at all — not even a window. Over the desktop wallpaper, or
    // outside every window the dump saw.
    showObjectHintOnce('noData', t('editor.objectNoData'))
    return
  }
  // The objects come from the capture instant, so while the user is scrubbed
  // away from "now" the outlines describe a moment that is not on screen.
  // Picking stays allowed — the hint just says what it means.
  if (scrub !== null && !scrub.atNow) {
    if (showObjectHintOnce('fromCapture', t('editor.objectFromCapture'))) return
  }
  if (o.level === 'window') {
    // A window with no control to offer — and WHY not, because SPEC §11.3
    // ("Silence is not absence") makes these three different statements and
    // requires a reader to keep them apart. The window itself stays pickable in
    // every one of them.
    switch (o.refinement) {
      case 'noData':
        // The dump never read this window's tree (Chromium/Electron expose
        // none, or the budget/window cap never reached it).
        showObjectHintOnce('windowNoTree', t('editor.objectWindowNoTree'))
        return
      case 'offDisplay':
        // Its tree WAS read and has controls — they are just not on this
        // screen. Claiming there is no control data would contradict the pack's
        // own elements.json.
        showObjectHintOnce('windowOffDisplay', t('editor.objectWindowOffDisplay'))
        return
      case 'none':
        // Read, on this screen, and everything in it is a frame the window
        // level already covers better.
        showObjectHintOnce('windowOnly', t('editor.objectWindowOnly'))
        return
      default:
        return
    }
  }
  // A control is on offer and a window is under it: the modifier is worth
  // knowing about exactly now. (The membership test first — this runs on every
  // pointer move, and the window scan must not.)
  if (objectHintsShown.has('windowModifier') || windowLevelKey || objectIndex === null) return
  if (objectIndex.windowAt(o.x, o.y) !== null) {
    showObjectHintOnce('windowModifier', t('editor.objectWindowModifier'))
  }
}

/** How long one hint holds the chip before the next queued one may have it. */
const OBJECT_HINT_MS = 6000

/**
 * Shows `text` in the hint chip if `kind` has not been said yet this session.
 *
 * QUEUED, never overwritten: every one of these is shown exactly once and can
 * never be re-shown, so a message replaced after half a second is lost
 * permanently. A hint raised while the chip is busy waits for it instead.
 */
function showObjectHintOnce(kind: ObjectHintKind, text: string): boolean {
  if (objectHintsShown.has(kind)) return false
  objectHintsShown.add(kind)
  if (objectHintTimer !== null) {
    objectHintQueue.push(text)
    return true
  }
  displayObjectHint(text)
  return true
}

function displayObjectHint(text: string): void {
  objectHint.textContent = text
  objectHint.hidden = false
  objectHintTimer = window.setTimeout(() => {
    objectHintTimer = null
    const next = objectHintQueue.shift()
    if (next === undefined) {
      objectHint.hidden = true
      return
    }
    displayObjectHint(next)
  }, OBJECT_HINT_MS)
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

/** `target` for a picked object (SPEC §8.7): empty fields are never written. */
function uiaTargetOf(o: PickableObject): AnnotationTarget {
  const target: UiaAnnotationTarget = { source: 'uia', level: o.level }
  if (o.level === 'window') {
    // A window target names the window, not a control: title + process are what
    // identify it to a human and to an AI reader.
    const w = o.window
    if (w === null) return target
    const title = w.title.trim()
    const process = w.process.trim()
    const className = w.class_name.trim()
    if (title !== '') target.title = title
    if (process !== '') target.process = process
    if (className !== '') target.class_name = className
    return target
  }
  const e = o.element
  if (e === null) return target
  const name = e.name.trim()
  const controlType = e.control_type.trim()
  const automationId = e.automation_id.trim()
  const className = e.class_name.trim()
  if (name !== '') target.name = name
  if (controlType !== '') target.control_type = controlType
  if (automationId !== '') target.automation_id = automationId
  if (className !== '') target.class_name = className
  // The window a control lives in is context an AI reader cannot recover from
  // the control alone ("the Save button" — of which app?).
  const owner = o.window
  if (owner !== null) {
    const process = owner.process.trim()
    if (process !== '') target.process = process
  }
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
  setHoverObject(null, null) // the outline has served its purpose once it is used
  // Which SCREEN of the board was clicked. The gutter between displays belongs
  // to none of them: it clears the selection and starts nothing.
  const hit = pointAt(e)
  if (e.button === 2) {
    // RIGHT-DRAG creates a box (live preview; text input opens on release).
    commitTextEditor()
    if (hit === null) return
    overlay.setPointerCapture(e.pointerId)
    drag = { kind: 'draw', d: hit.d, x0: hit.x, y0: hit.y, x: hit.x, y: hit.y }
    return
  }
  if (e.button !== 0) return
  commitTextEditor()
  if (hit === null) {
    state.selectedId = null
    syncLanes()
    schedulePaint()
    return
  }
  const p = { x: hit.x, y: hit.y }
  const ui = uiOf(hit.d)
  // Corner resize handles (editor-only chrome) win over box stacking — but only
  // for a selection that lives on THIS screen.
  const sel = selectedVisibleAnnotation()
  if (sel !== null && displayIndexOf(sel) === hit.d.index) {
    const handle = handleAt(sel, p.x, p.y, ui)
    if (handle !== null) {
      overlay.setPointerCapture(e.pointerId)
      drag = {
        kind: 'resize',
        d: hit.d,
        id: sel.annotation_id,
        handle,
        before: state.cloneAnnotations(),
        moved: false,
      }
      return
    }
  }
  // LEFT CLICK selects the topmost box whose lifetime is visible at the cursor,
  // among the boxes of the display that was clicked.
  const id = hitTest(visibleAnnotationsOn(hit.d.index), p.x, p.y, ui)
  // Whether this click had a selection to CLEAR — read before it is cleared,
  // because a window-level pick below defers to that gesture.
  const hadSelection = state.selectedId !== null
  state.selectedId = id
  if (id !== null) {
    overlay.setPointerCapture(e.pointerId)
    drag = {
      kind: 'move',
      d: hit.d,
      id,
      lastX: p.x,
      lastY: p.y,
      before: state.cloneAnnotations(),
      moved: false,
    }
    syncLanes()
    schedulePaint()
    return
  }
  // No box here: pick the real UI object under the cursor (GOAL "Static object
  // picking") — the smallest control, or the window itself when there is no
  // control (or Shift is held). Only a point no window covers at all still
  // means what it always did: the click cleared the selection.
  //
  // Shift is read from the EVENT, not from the tracked key state: a window that
  // has just regained focus with Shift already down never saw the keydown.
  windowLevelKey = e.shiftKey
  const picked = objectAt(hit.d, p)
  // A WINDOW-level pick never takes a click that was a DESELECT. On a normally
  // tiled desktop the windows cover the screen completely, so without this
  // every single pixel snaps a whole-window box and "click empty space = clear
  // the selection" — the gesture the desktop-class exclusion in objects.ts
  // exists to preserve — has nowhere left to happen: deselecting would cost a
  // click plus an Esc to dismiss the description input that opened.
  //
  // A CONTROL pick is precise enough to be unambiguous intent, and Shift is the
  // explicit "I mean the window" modifier, so both still snap immediately. A
  // modifier-free window pick with nothing selected does too — there is no
  // deselect to protect then.
  const deselecting = picked !== null && picked.level === 'window' && !e.shiftKey && hadSelection
  if (deselecting) {
    // The click did clear the selection; say once how to get the window box it
    // did not create. This chip is the only place Shift is ever mentioned.
    showObjectHintOnce('windowModifier', t('editor.objectWindowModifier'))
  }
  if (picked !== null && !deselecting) {
    beginPendingBox(hit.d, { x: picked.x, y: picked.y, w: picked.width, h: picked.height }, picked)
  } else if (picked === null && objectIndex !== null && objectIndex.size > 0) {
    // Says once why the click snapped nothing (the click itself still did what
    // it always did: cleared the selection). Gated on the index having data at
    // all — with no dump, picking is simply OFF and silence is the truth.
    announceObject(hit.d, null)
  }
  syncLanes()
  schedulePaint()
})

overlay.addEventListener('pointermove', (e) => {
  if (!drag) {
    if (loaded) syncHoverCursor(e)
    return
  }
  const p = pointOn(drag.d, e)
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
    if (b.w >= MIN_DRAG && b.h >= MIN_DRAG) beginPendingBox(d.d, b)
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
  const hit = pointAt(e)
  if (hit === null) return
  const id = hitTest(visibleAnnotationsOn(hit.d.index), hit.x, hit.y, uiOf(hit.d))
  if (id === null) return
  const a = state.byId(id)
  if (!a) return
  e.preventDefault()
  state.selectedId = id
  textSession = { kind: 'edit', id }
  openTextEditor(hit.d, a.bounds, a.text)
  syncLanes()
  schedulePaint()
})

/** Idle-hover cursor: resize arrows over handles, move over a box, else default. */
function syncHoverCursor(e: PointerEvent): void {
  if (spaceDown) return // pan cursor owns the stage
  // The pointer event carries the modifier state the OS actually has, which the
  // keydown/keyup tracking below can miss (Shift held while the window was not
  // focused). A change here re-answers the hover on the next probe.
  if (e.shiftKey !== windowLevelKey) {
    windowLevelKey = e.shiftKey
    lastProbeX = -1
    lastProbeY = -1
  }
  const hit = pointAt(e)
  if (hit === null) {
    // The gutter between two screens: nothing to hover, nothing to pick.
    overlay.style.cursor = 'default'
    probeObjectHover(null)
    return
  }
  const ui = uiOf(hit.d)
  const sel = selectedVisibleAnnotation()
  if (sel !== null && displayIndexOf(sel) === hit.d.index) {
    const handle = handleAt(sel, hit.x, hit.y, ui)
    if (handle !== null) {
      overlay.style.cursor = handle === 'nw' || handle === 'se' ? 'nwse-resize' : 'nesw-resize'
      probeObjectHover(null)
      return
    }
  }
  const overBox = hitTest(visibleAnnotationsOn(hit.d.index), hit.x, hit.y, ui) !== null
  overlay.style.cursor = overBox ? 'move' : 'default'
  // Object picking is what a left click on empty canvas does now, so the
  // outline is only offered where no box would take the click instead.
  probeObjectHover(overBox ? null : hit)
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
    // ONE CLOCK: a wheel anywhere over the board scrubs every display's replay
    // together, whichever screen the pointer happens to be over.
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
  if (e.key === 'Escape') {
    // Cancel-current first: duration editor, then a zoomed board, then the
    // unsaved-changes bar, then an active selection. A bare Esc with nothing in
    // progress closes the editor — except in edit mode with unsaved changes,
    // where it opens the [Save] [Save As New CapturePack] [Discard] bar
    // instead of discarding.
    if (durationEditorOpen) {
      closeDurationEditor()
      return
    }
    // A box being CREATED is the most-current thing on screen, so Esc discards
    // it whole — text, number, duration and blur together (GOAL "Unified
    // Annotation Box"). The description input handles this itself while it has
    // focus; this covers focus having landed elsewhere (a header control, the
    // duration popover) with the box still pending.
    if (textSession !== null) {
      cancelTextEditor()
      return
    }
    // A board zoomed onto one screen is a VIEW, not a mode — but it is the most
    // current thing on screen, so Esc gives the whole desk back before it
    // starts undoing selections or closing the editor.
    //
    // MULTI-DISPLAY ONLY. On a single-display capture, zoom is what it always
    // was — a look at some pixels, not a place you can get lost in — and Esc
    // has meant "clear the selection, then close" since the first version. A
    // user who zoomed in to read something must not have to press Esc twice
    // more than they used to.
    if (board !== null && board.displays.length > 1 && viewport.panEnabled) {
      fitBoard()
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
  // Shift forces the WINDOW level of object picking (GOAL "Static object
  // picking"). Tracked here so a stationary pointer re-answers its hover the
  // moment the key goes down, not on the next mouse move. It modifies nothing
  // else on the canvas, so it never consumes the key.
  //
  // BELOW every text gate on purpose: typing a capital letter in the pack title
  // or a box description is not a canvas modifier, and handling it above would
  // repaint a window-level outline (and burn a one-time hint) mid-sentence.
  // Nothing is lost by waiting — pointerdown reads e.shiftKey from the event
  // and syncHoverCursor re-syncs from the pointer.
  if (e.key === 'Shift' && !windowLevelKey) {
    windowLevelKey = true
    reprobeObjectHover()
  }
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
  // Board navigation (GOAL "Multi-Monitor Support"): 1..9 frames one captured
  // display at the largest usable scale, 0 fits the whole board again. Free
  // keys — the editor is toolless, so digits were never a tool selector.
  if (board !== null && board.displays.length > 1 && /^[0-9]$/.test(e.key)) {
    e.preventDefault()
    if (e.key === '0') fitBoard()
    else zoomToDisplay(Number(e.key))
    return
  }
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
  if (e.key === 'Shift' && windowLevelKey) {
    windowLevelKey = false
    reprobeObjectHover()
  }
})

window.addEventListener('blur', () => {
  spaceDown = false
  panning = null
  syncPanCursor()
  // A modifier released while another window had focus never reaches keyup.
  windowLevelKey = false
  // ...and the outline + chip still on screen were drawn for the WINDOW level a
  // click would no longer take. Re-answer them now, exactly as keyup does,
  // instead of leaving the chip lying until the pointer happens to move.
  reprobeObjectHover()
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
// Timeline bar — the board's ONE clock (GOAL "Multi-Monitor Support"): every
// callback below moves EVERY display's replay, never just one.
// ---------------------------------------------------------------------------

const timebar = new Timebar(timebarEl, {
  scrubToFraction: (fraction) => {
    if (scrub) scrub.scrubTo(fraction * scrub.durationMs)
  },
  togglePlay: () => {
    scrub?.togglePlay()
  },
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
  // Trim handle drags (GOAL "Replay Trim"): fraction of the track -> ms.
  trimTo: (kind, fraction) => {
    if (!scrub) return
    const ms = fraction * scrub.durationMs
    if (kind === 'in') setTrimIn(ms)
    else setTrimOut(ms)
  },
  // Double-click a handle: reset that side to the track edge.
  resetTrim: (kind) => {
    if (!trimEnabled()) return
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
  exporting = true
  exportBtn.disabled = true
  scrub?.pause()
  commitTextEditor()
  closeDurationEditor(false)
  hideUnsavedBar(false)
  try {
    // A wheel burst right before Enter can leave seeks in flight on SEVERAL
    // videos; wait until every display's painted frame matches the clock.
    if (scrub) await scrub.whenSettled()
    // Blur is NON-destructive (SPEC §9): snapshot.png keeps original pixels;
    // blur renders only into derived views (replay_annotated, editor preview).
    //
    // snapshot.png stays the FOCUSED display at its FULL native resolution, and
    // is composed from that display's live frame source — never from the board
    // canvas, which is a bounded-memory view of every screen at once (board.ts)
    // and would silently downscale the saved file.
    const source = scrub !== null ? scrub.focusedSource : 'native'
    const image = source === 'native' ? nativeBitmap : source
    if (image === null) throw new Error('the focused display has no frame to export')
    const snapshotPng = await composeExportPng(image, focusedW, focusedH)
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
  // Kept alive: scrubbing back to "now" restores this sharpest frame, and
  // snapshot.png is composed from it at full native resolution.
  nativeBitmap = await createImageBitmap(new Blob([payload.snapshotPng], { type: 'image/png' }))
  focusedW = payload.width
  focusedH = payload.height

  // THE BOARD (GOAL "Multi-Monitor Support"). A capture that froze more than
  // one display lays them out in their real arrangement from the manifest
  // bounds; a single-display capture is a one-display board, which is exactly
  // the editor that shipped before this existed.
  const multi = payload.displays.length > 1
  const inputs: BoardInput[] = multi
    ? payload.displays.map((d) => ({
        index: d.index,
        focused: d.focused,
        // ONE source for the focused display's native size, on both branches:
        // payload.width/height, which IS the annotation coordinate space
        // (annotations.json reference size on re-edit) and the size
        // composeExportPng writes snapshot.png at. The per-display entry
        // derives its size from the decoded PNG instead, and an externally
        // written pack whose reference size differs from snapshot.png's pixels
        // would otherwise scale the focused screen's board region by one number
        // while its boxes are hit-tested in the other.
        width: d.focused ? focusedW : d.width,
        height: d.focused ? focusedH : d.height,
        hasReplay: d.focused ? payload.replayWebm !== null : d.replayWebm !== null,
        bounds: d.bounds,
      }))
    : [
        {
          index: payload.displays[0]?.index ?? 1,
          focused: true,
          width: focusedW,
          height: focusedH,
          hasReplay: payload.replayWebm !== null,
          bounds: { x: 0, y: 0, width: focusedW, height: focusedH },
        },
      ]
  board = buildBoard(inputs)
  focusedDisplayIndex = board.focusedIndex
  runtimes.clear()
  for (const d of board.displays) {
    runtimes.set(d.index, { index: d.index, bitmap: null, broken: false })
  }
  const focusedRuntime = runtimes.get(focusedDisplayIndex)
  if (focusedRuntime !== undefined) focusedRuntime.bitmap = nativeBitmap
  // Every OTHER display's frozen frame, decoded CONCURRENTLY: they are all on
  // screen from the first paint, so there is nothing to defer any more. A frame
  // that will not decode (a truncated per-display PNG in a copied pack) marks
  // its display broken — an empty, labelled region beats a wrong screen.
  await Promise.all(
    payload.displays.map(async (d) => {
      if (d.focused || d.snapshotPng === null) return
      const rt = runtimes.get(d.index)
      if (rt === undefined) return
      try {
        rt.bitmap = await createImageBitmap(new Blob([d.snapshotPng], { type: 'image/png' }))
      } catch (err) {
        console.error(`capturepack: decoding display ${d.index} failed:`, err)
        rt.broken = true
      }
    }),
  )
  // Static object picking (GOAL): one index build over the capture-instant UI
  // Automation objects — windows (the floor) and controls (the refinement) — in
  // the FOCUSED display's snapshot coordinate space (SPEC §11.3), which is the
  // only space the dump was mapped into. An empty payload yields an empty index
  // and picking stays silently off.
  objectIndex = ObjectIndex.build(payload.uiaElements, payload.uiaWindows, focusedW, focusedH)
  resizeCanvases()
  loaded = true
  drawAllFrozen()
  buildDisplayLegend()
  replayChip.textContent = hasReplay
    ? t('editor.replaySeconds', { seconds: Math.round(payload.replayDurationMs / 1000) })
    : t('editor.noReplay')
  // ONE CLOCK for the board: the focused display's replay is the pack clock
  // (every lifetime is on it) and every other display's replay is slaved to it,
  // so scrubbing moves the whole desktop through one moment. The replays load
  // asynchronously behind the instantly-usable snapshots; the timebar shows
  // "loading replay…" until scrubbing is ready.
  if (payload.replayWebm !== null) {
    const replays: BoardReplayInput[] = [
      {
        displayIndex: focusedDisplayIndex,
        focused: true,
        webm: payload.replayWebm,
        durationMs: payload.replayDurationMs,
        offsetMs: 0,
      },
    ]
    for (const d of payload.displays) {
      if (d.focused || d.replayWebm === null) continue
      replays.push({
        displayIndex: d.index,
        focused: false,
        webm: d.replayWebm,
        durationMs: d.replayDurationMs,
        offsetMs: d.replayOffsetMs,
      })
    }
    const controller = new BoardScrub(replays, {
      drawFrame: drawDisplayBaseFrame,
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
