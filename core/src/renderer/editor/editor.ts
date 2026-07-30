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
import type {
  ContextFrameRequest,
  EditorExportPayload,
  EditorInitPayload,
  ObjectTrackRequest,
  ObjectTrackResult,
  RecorderFailureReason,
} from '../../shared/ipc'
import type { ContextFrame } from '../../shared/context/protocol'
import { applyDomI18n, makeT, recorderFailureText } from '../../shared/i18n'
import type { TranslateFn } from '../../shared/i18n'
import type {
  Annotation,
  AnnotationBounds,
  AnnotationTarget,
  EditorWindowMode,
  UiaAnnotationTarget,
} from '../../shared/types'
import {
  annotationHasSemanticGeometry,
  MANUAL_BOX_COLOR,
  SEMANTIC_BOX_COLOR,
} from '../../shared/annotationStyle'
import { annotationAt, trackedBoundsAt } from '../../shared/track'
import type { AuthoredMotionSpace } from '../../shared/track'
import {
  hasMotion,
  keyframeIndexAt,
  keyframesOf,
  moveKeyframe,
  removeKeyframeAt,
  setKeyframe,
  syncBoundsToRepresentative,
} from '../../shared/motion'
import { computeDisplayNumbers } from '../../shared/numbering'
import { contextFrameRequestsForDisplays } from '../../shared/displayClock'
import {
  ObjectIndex,
  objectHoverLabel,
  objectLabel,
  pickIdentityOf,
  samePickIdentity,
} from './objects'
import type { PickableObject, PickIdentity } from './objects'
import { EditorState } from './state'
import {
  formatDurationLabel,
  lifetimeExtending,
  lifetimeFrom,
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
  onBoxEdge,
  SELECTION_PAD,
  type HandleId,
} from './render'
import { buildBoard, displayAtBoardPoint, toBoardPoint, toNativePoint } from './board'
import type { BoardDisplay, BoardInput, BoardLayout } from './board'
import { BoardScrub, wheelScrubDeltaMs } from './scrub'
import type { BoardReplayInput } from './scrub'
import { Timebar } from './timebar'
import { planTrimDrag } from './trimDrag'
import { projectControlTrack } from './objectTrack'
import type { ControlTrackAnchor } from './objectTrack'
import {
  clampZoom,
  initialImageViewMode,
  nativeImageZoomCeiling,
  Viewport,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
} from './viewport'

interface EditorBridge {
  onInit(cb: (payload: EditorInitPayload) => void): void
  // Main reveals the native window only after image decode and one paint
  // boundary succeed. A failure closes the still-hidden editor.
  initialized(): void
  initializationFailed(message: string): void
  // Native caption Close is only a request until the renderer has checked its
  // dirty edit state.
  onCloseRequested(cb: () => void): void
  // The unsaved modal is visible, so main can stop treating the renderer as
  // unresponsive while Save / Discard / Esc remains the user's decision.
  closePromptShown(): void
  // OBJECT PICKING FOLLOWS TIME (#66): the candidate set at one scrub position.
  // Asked when the scrub settles, never per pointer move.
  requestContextFrame(request: ContextFrameRequest): Promise<ContextFrame | null>
  // A frame Core pushed: a provider that answered after its budget, or the
  // capture-instant observation settling after the editor opened. The editor
  // rebuilds its per-display indexes and picking starts working mid-session.
  onContextFrame(cb: (frame: ContextFrame) => void): void
  // WHERE A PICKED OBJECT WENT (#86). Asked once per picked box; the answer is
  // a path the box is drawn along, so following costs nothing while scrubbing.
  requestObjectTrack(request: ObjectTrackRequest): Promise<ObjectTrackResult | null>
  export(payload: EditorExportPayload): void
  saveAsNew(payload: EditorExportPayload): void
  cancel(): void
  annotationAdded(payload: { id: string; type: string }): void
  // Editor Window Mode (GOAL): an ABSOLUTE request; main applies it and pushes
  // back the mode the window actually ended up in.
  setWindowMode(mode: EditorWindowMode): void
  onWindowMode(cb: (mode: EditorWindowMode) => void): void
  // Shortcut overlay (GOAL "Editor Chrome"): the `?`/F1 toggle state, persisted
  // as settings.showShortcutOverlay — turning it off is permanent until turned
  // back on.
  setShortcutOverlay(show: boolean): void
  // First-run tutorial (GOAL "First-Run Tutorial"): whether it may ever appear
  // again, persisted as settings.showEditorTutorial.
  setTutorial(show: boolean): void
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
const exportBtn = el<HTMLButtonElement>('exportBtn')
const titleBarLabel = el<HTMLSpanElement>('titleBarLabel')
const boxHeader = el<HTMLDivElement>('boxHeader')
const numberBtn = el<HTMLButtonElement>('numberBtn')
const numberPinBtn = el<HTMLButtonElement>('numberPinBtn')
const numberPicker = el<HTMLDivElement>('numberPicker')
const durationChip = el<HTMLButtonElement>('durationChip')
const blurBtn = el<HTMLButtonElement>('blurBtn')
const deleteBtn = el<HTMLButtonElement>('deleteBtn')
const durationEditor = el<HTMLDivElement>('durationEditor')
const durationInput = el<HTMLInputElement>('durationInput')
const untilEndBtn = el<HTMLButtonElement>('untilEndBtn')
const entireCaptureBtn = el<HTMLButtonElement>('entireCaptureBtn')
const helpBtn = el<HTMLButtonElement>('helpBtn')
const helpSheet = el<HTMLElement>('helpSheet')
const helpGroups = el<HTMLElement>('helpGroups')
const tutorialScrim = el<HTMLDivElement>('tutorialScrim')
const tutorialGotIt = el<HTMLButtonElement>('tutorialGotIt')
const tutorialDontShow = el<HTMLInputElement>('tutorialDontShow')
const zoomControl = el<HTMLDivElement>('zoomControl')
const zoomInBtn = el<HTMLButtonElement>('zoomInBtn')
const zoomOutBtn = el<HTMLButtonElement>('zoomOutBtn')
const zoomSlider = el<HTMLInputElement>('zoomSlider')
const zoomPct = el<HTMLSpanElement>('zoomPct')
const oneToOneBtn = el<HTMLButtonElement>('oneToOneBtn')
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
let captureKind: 'image' | 'video' = 'video'
// WHY a display has no replay, per display index (GOAL "Say that you are
// recording"): a capture taken while a buffer was not running must say the
// replay is unavailable and name the reason, not just show a frozen frame.
// Empty for a re-edited pack, where a missing replay is simply what was saved.
const replayUnavailableReasons = new Map<number, RecorderFailureReason>()
// Which displays actually move when the board scrubs. A display without replay
// keeps showing its capture-instant bitmap and must keep querying context at
// that instant too, not at the focused video's historical time.
const replayDisplayIndices = new Set<number>()
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
  // its caption on the board says so, rather than silently showing the wrong
  // screen.
  broken: boolean
}
const runtimes = new Map<number, DisplayRuntime>()
let focusedDisplayIndex = 0
// Native size of the FOCUSED display — the coordinate space of snapshot.png and
// of every annotation that carries no `display`.
let focusedW = 0
let focusedH = 0
// OBJECT PICKING, AT THE TIME ON SCREEN (#64/#65/#66): the surface stack and
// every provider's candidates AS THEY WERE at the current scrub position, asked
// of Core whenever that position settles somewhere new.
//
// This is the whole fix. The index used to be built once, at load, over the
// capture-instant dump — so scrubbing back left it describing a moment that was
// no longer on screen, reported from live use as "it only matches the last
// information; I moved it and it does not match". Now the DATA moves with the
// clock, and where it cannot (a pack that recorded one instant, an interval no
// checkpoint covers) the frame says so and picking declines for that reason
// rather than for the clock position.
//
// ONE INDEX PER CAPTURED DISPLAY, keyed by the manifest display index (GOAL
// "Multi-Monitor Support", issue #30). Every candidate says which display's
// snapshot space its bounds are in (SPEC §11.3), every screen of the board is
// annotatable, and a pick therefore comes from the index of the display UNDER
// THE POINTER.
const objectIndexes = new Map<number, ObjectIndex>()
// The frame EACH display's index was built from. Secondary replays can present
// a different nearest frame than the focused one, so one global accuracy/frame
// would describe pixels that are not actually on that screen.
const contextFramesByDisplay = new Map<number, ContextFrame>()
let contextSessionId: string | null = null
// A frame that arrived before initEditor finished (it awaits image decoding):
// held rather than dropped, and applied the moment the board exists.
let pendingContextFrame: ContextFrame | null = null
const pendingDisplayContextFrames = new Map<number, ContextFrame>()
// The scrub position the current frame describes, and the request in flight.
// A wheel burst is dozens of positions; only the one it SETTLES on is worth a
// round trip (GOAL: a slow provider must never hold the editor shut, and a fast
// one must not be asked sixty times a second either).
const frameTimesByDisplay = new Map<number, number>()
let frameRequestSeq = 0
let frameSettleTimer: number | null = null
let hoverObject: PickableObject | null = null
// THE LOSING CANDIDATES ARE KEPT (#66). Tab / Shift+Tab cycle the objects at
// the hovered point; `hoverStack` is that list and `hoverStackIndex` is where
// the cycle currently is. Reset whenever the probed point changes, because a
// cycle is about ONE point.
let hoverStack: readonly PickableObject[] = []
let hoverStackIndex = 0
// The board display the hovered object belongs to — the one under the pointer,
// kept explicitly so the outline is drawn with that display's transform and
// never on a neighbour.
let hoverDisplay: BoardDisplay | null = null
// Last probed snapshot pixel: hovering does NO work until the pointer moves off it.
let lastProbeX = -1
let lastProbeY = -1
let lastProbeDisplay = -1
// The pending box a PLAIN LEFT CLICK on a picked object just opened. A second
// click of the same gesture (a double-click aimed at the box that click landed
// on) discards it instead of committing a box the user never asked for; cleared
// the moment any text session ends, so it can only ever name a live draft.
let clickPickDraftId: string | null = null
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
  // TIPS — something the user could do, raised while merely hovering.
  | 'fromCapture'
  | 'windowModifier'
  | 'windowOnly'
  | 'windowNoTree'
  | 'windowOffDisplay'
  // Object picking is off for this capture entirely (the dump produced nothing).
  | 'dropped'
  // ANSWERS — why the thing the user just did produced nothing. Each has its OWN
  // kind so a tip the hover path already burnt can never swallow one (the window
  // modifier tip used to be the only feedback a refused click had).
  | 'noData'
  | 'displayNoData'
  | 'gutter'
  // COVERAGE, not clock position (#66, design GAP 16). Two different statements
  // the old single 'scrubbedAway' refusal could not tell apart:
  //   uncovered    — no provider has a checkpoint near THIS moment (an interval
  //                  the buffer never covered, or one the governor degraded).
  //   singleInstant— this pack recorded objects at the capture instant only,
  //                  which is every pack written before v0.2.0.
  // Both fire from the frame's own accuracy, never from a blanket rule about
  // where the playhead is.
  | 'uncovered'
  | 'singleInstant'
  // More than one object is on offer at this point, and Tab moves through them.
  | 'cycle'
  | 'boxTookClick'
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
// Whether the current trim-handle drag began on the native capture instant.
let trimDragWasAtNow = false
// Editor Window Mode (GOAL "Editor Window Mode"): mirrors the window state main
// reports. The fullscreen overlay is the default; windowed mode is a real
// movable/resizable window whose top bar is the drag region.
let windowMode: EditorWindowMode = 'fullscreen'
const viewport = new Viewport(frame)
// WHICH display the view is currently FRAMED on (null = the whole board, or a
// free zoom/pan the user drove). Viewport.focusRect derives its pan from the
// CURRENT fit scale and stage size, so a stage that changes size — a window
// resize, or the fullscreen<->windowed toggle, which is a first-class editor
// control — invalidates it: layout() re-derives the framing from this instead
// of leaving the board displaced by the ratio of the fit change.
let framedDisplay: number | null = null
// True while an image is deliberately shown at native 100%. Unlike a free
// zoom factor, that is an ABSOLUTE on-screen scale and must be re-derived when
// a maximize/window-mode change changes fitScale.
let nativeImageView = false
let spaceDown = false
// Space serves two gestures: HELD it is the pan modifier, TAPPED (pressed and
// released without ever panning) it toggles playback. This stays true from the
// keydown until a pan actually starts, which is what tells the two apart.
let spaceTap = false
let panning: { pointerId: number; x: number; y: number } | null = null

// A draw/resize belongs to one display. A MOVE carries a desktop-DIP rectangle
// as well: the same authored box can cross from one monitor to another even
// when their native-pixel scales differ.
type Drag =
  | { kind: 'draw'; d: BoardDisplay; x0: number; y0: number; x: number; y: number }
  | {
      kind: 'move'
      d: BoardDisplay
      id: string
      lastBx: number
      lastBy: number
      boardBounds: AnnotationBounds
      before: Annotation[]
      moved: boolean
      /**
       * WHICH RECTANGLE THIS DRAG IS MOVING (SPEC §8.9).
       *
       * A manual box used to carry one `bounds` for its whole life, so dragging
       * it at a later frame moved it at EVERY frame — reported as "수동으로
       * 박스 만들고 몇프레임 뒤에 박스를 움직였는데 통째로 옴겨지던데?". A drag
       * at a moment the box has not been placed at before now authors a
       * keyframe there, and this is its index; -1 means the box is still a
       * plain constant rectangle and `bounds` is what moves, which is what a
       * drag at the box's own starting moment means.
       */
      keyframe: number
      /** The moment this drag is authoring, on the pack clock. */
      atMs: number
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
// text of an existing box — which is now every SELECTION of one (issue #42),
// not just a double-click.
type TextSession = { kind: 'new'; draft: Annotation } | { kind: 'edit'; id: string }
let textSession: TextSession | null = null
// Bounds the text input hangs under (live object: repositions track the box).
let textAnchor: AnnotationBounds | null = null
// The display those bounds belong to — the input is positioned in board space.
let textDisplay: BoardDisplay | null = null
// Whether anything has been TYPED into the description since it opened. An
// untouched field has no text edit of its own to undo, which is what lets
// Ctrl+Z keep meaning the board's undo there (see the keydown handler).
let textEdited = false

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
  // A FRAMED display is a pan computed from the fit scale and the stage size,
  // both of which just changed: re-derive it, or the first resize (and the
  // window-mode toggle, which resizes without a resize event on every platform)
  // would shove the framed screen off the stage with nothing but the zoom
  // percentage to explain it.
  if (framedDisplay !== null) applyFraming(framedDisplay)
  else if (nativeImageView) showNativeImageView()
  positionTextEditor()
  // The percentage is fitScale x zoom, so a resize changes it without the
  // viewport moving at all — and the help sheet's proximity box just moved.
  syncZoomUi()
  syncHelpGeometry()
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
/**
 * A SEMANTIC BOX IS NOT DRAGGED (#52, #99).
 *
 * Its rectangle is Core's record of where the object actually was, at every
 * moment of the replay. Moving or resizing it does not adjust an annotation —
 * it replaces a measurement with a guess, and the box then follows nothing
 * while still carrying a `target` that says which object it means. The user
 * asked for exactly this: "파란색에 이동 크기 편집 못하게 해야지".
 *
 * Everything else stays available: select it, describe it, number it, blur it,
 * change its lifetime, delete it. Only the geometry is Core's.
 */
function coreOwnsGeometry(a: Annotation): boolean {
  // `target` and active tracking survive a save/reopen. The in-memory identity
  // covers a freshly picked provider object whose provenance cannot yet be
  // represented by SPEC §8.7 (for example Chrome DOM) without falsely calling
  // it UIA. Either way, blue object geometry never becomes a manual keyframe.
  return (
    annotationHasSemanticGeometry(a) ||
    pickedObjectIdentities.has(a.annotation_id)
  )
}

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

/** The caption is the product name; the editable pack title belongs below. */
function syncTitleBar(): void {
  titleBarLabel.textContent = 'CapturePack'
}

/** Paints the mode main reported: drag region, button state, canvas re-fit. */
function applyWindowMode(mode: EditorWindowMode): void {
  windowMode = mode
  // The CSS drag region hangs off this: the title bar EXISTS (and the top bar's
  // gaps become draggable) only while the editor is a window — the fullscreen
  // overlay has nothing to move, so it carries no drag region at all.
  document.body.dataset['windowMode'] = mode
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
// Board navigation (GOAL "Multi-Monitor Support": "No display picker in the top
// bar"). Every captured display is on the board, drawn with its own caption and
// an accent frame around the focused one, so a row of monitor buttons in the
// one place that must stay uncluttered was redundant chrome. Framing a single
// display is a keyboard gesture — 1..9, and the key left of 1 (`, or 0) to fit
// the whole board — discoverable through the help sheet. NEVER Esc (issue #53):
// framing is a VIEW state, and Esc undoes no other view state either.
// ---------------------------------------------------------------------------

/** The caption drawn inside a display's own frame on the board. */
function displayLabel(d: BoardDisplay): string {
  const base = d.focused
    ? t('editor.displayLabelFocused', { index: d.index })
    : t('editor.displayLabel', { index: d.index })
  if (runtimes.get(d.index)?.broken === true) return `${base} · ${t('editor.displayBroken')}`
  // A display whose recorder was not running is a FAILURE, not a layout fact:
  // it is named here whether or not the board has a clock, because in a
  // screenshot-only capture this caption is the only place it can be read.
  const reason = replayUnavailableReasons.get(d.index)
  if (reason !== undefined) {
    return `${base} · ${t('editor.displayNotRecording', { reason: recorderFailureText(t, reason) })}`
  }
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
  if (!applyFraming(index)) return
  nativeImageView = false
  framedDisplay = index
  syncPanCursor()
  syncSelectionUi()
  schedulePaint()
  syncZoomUi()
}

/**
 * The transform alone: everything framing needs that DERIVES from the current
 * fit scale and stage size, so layout() can re-run it after either changed.
 */
function applyFraming(index: number): boolean {
  const d = displayByIndex(index)
  if (d === null || board === null || !loaded) return false
  viewport.focusRect(
    { x: d.bx * fitScale, y: d.by * fitScale, width: d.bw * fitScale, height: d.bh * fitScale },
    board.width * fitScale,
    board.height * fitScale,
    stage.clientWidth,
    stage.clientHeight,
  )
  return true
}

/**
 * Back to the whole board, unzoomed — the state a video editor opens in, and
 * the ONLY way back from a framed display (GOAL, issue #53): framing is a VIEW
 * like zoom and pan, so ` (the key left of 1) undoes it and Esc never does.
 */
function fitBoard(): void {
  viewport.reset()
  nativeImageView = false
  framedDisplay = null
  syncPanCursor()
  syncSelectionUi()
  schedulePaint()
  syncZoomUi()
}

/**
 * A free zoom or pan (Ctrl+wheel, the zoom control, Space/middle-button drag):
 * the view is the user's own now — it is no longer the framing of any one
 * display, so layout() must stop re-deriving one.
 */
function markViewNavigated(): void {
  nativeImageView = false
  framedDisplay = null
}

// ---------------------------------------------------------------------------
// Zoom control (GOAL "Editor Chrome"): "[-] slider [+], showing the current
// percentage. It mirrors Ctrl+wheel (same range and steps), snaps to Fit and
// 100%, and double-clicking the slider returns to Fit. The board's zoom is a
// first-class control, not a hidden gesture."
//
// The percentage is the board's REAL on-screen scale (fitScale x viewport
// zoom), not the viewport factor: 100% means one board unit per CSS pixel,
// which is the only reading of "100%" a user can check against their screen.
// Fit is therefore a different number on every window size, and both are snap
// points.
// ---------------------------------------------------------------------------

/** Slider resolution. Fine enough that the log mapping feels continuous. */
const ZOOM_SLIDER_MAX = 1000
/** Within this relative distance of a snap point, the control lands on it. */
const ZOOM_SNAP_RATIO = 0.05

/** Viewport factor at which the board is drawn 1:1 ("100%"), inside the range. */
function hundredPercentZoom(): number {
  return clampZoom(
    fitScale > 0 ? 1 / fitScale : 1,
    captureKind === 'image' ? nativeImageZoomCeiling(fitScale) : ZOOM_MAX,
  )
}

/** Images may reach native 1:1; video and normal-sized images retain 4x. */
function zoomCeiling(): number {
  return captureKind === 'image' ? nativeImageZoomCeiling(fitScale) : ZOOM_MAX
}

/**
 * `target`, pulled onto a snap point when it lands near one — or when this step
 * would step OVER one. Fit (viewport 1) and 100% are the two; on a board small
 * enough to fit unscaled they are the same point and nothing changes.
 */
function snapZoom(target: number, from: number): number {
  for (const snap of [1, hundredPercentZoom()]) {
    const crossed = (from < snap && target > snap) || (from > snap && target < snap)
    if (crossed || Math.abs(target - snap) / snap <= ZOOM_SNAP_RATIO) return snap
  }
  return target
}

/** Slider position <-> zoom factor: logarithmic, so each pixel is a ratio. */
function zoomToSlider(zoom: number): number {
  const ceiling = zoomCeiling()
  const span = Math.log(ceiling / ZOOM_MIN)
  return Math.round(
    (Math.log(clampZoom(zoom, ceiling) / ZOOM_MIN) / span) * ZOOM_SLIDER_MAX,
  )
}

function sliderToZoom(position: number): number {
  const t = Math.max(0, Math.min(1, position / ZOOM_SLIDER_MAX))
  const ceiling = zoomCeiling()
  return clampZoom(
    ZOOM_MIN * Math.exp(t * Math.log(ceiling / ZOOM_MIN)),
    ceiling,
  )
}

/**
 * Zooms to an absolute factor from the CONTROL (buttons/slider), anchored on
 * the stage centre — there is no cursor to keep fixed, and the middle of the
 * view is what the user is looking at.
 */
function applyControlZoom(target: number, snap = true): void {
  if (!loaded) return
  const ceiling = zoomCeiling()
  const clamped = clampZoom(target, ceiling)
  const next = snap ? snapZoom(clamped, viewport.zoom) : clamped
  // Fit is the whole board, centred: snapping to it has to undo the pan too, or
  // "Fit" would leave the board pushed half off screen at fit scale.
  if (next === 1) {
    fitBoard()
    return
  }
  const r = stage.getBoundingClientRect()
  viewport.zoomTo(next, r.left + r.width / 2, r.top + r.height / 2, ceiling)
  markViewNavigated()
  syncPanCursor()
  syncSelectionUi()
  schedulePaint()
  syncZoomUi()
}

/**
 * Images no larger than the content viewport open at native 1:1. Oversized
 * images open contained, like video, so the complete captured resource is
 * visible at a glance instead of beginning cropped and requiring a pan.
 * Neither branch upscales or crops. Video keeps its whole-board fit opening.
 */
function openInitialView(): void {
  if (captureKind === 'image') {
    if (initialImageViewMode(fitScale) === 'native') showNativeImageView()
    else fitBoard()
    return
  }
  fitBoard()
}

function showNativeImageView(): void {
  // Programmatic 1:1 is exact: the control's 5% magnetic fit snap is useful
  // for a hand-operated slider, but would turn a 99%-fit image back into 99%.
  applyControlZoom(hundredPercentZoom(), false)
  nativeImageView = true
}

/** Paints the control from the viewport — the single source of the zoom. */
function syncZoomUi(): void {
  const percent = Math.round(fitScale * viewport.zoom * 100)
  const label = `${percent}%`
  zoomPct.textContent = label
  zoomSlider.value = String(zoomToSlider(viewport.zoom))
  // The slider's own value is an opaque log position; the percentage is what a
  // screen reader must read out.
  zoomSlider.setAttribute('aria-valuetext', label)
  zoomOutBtn.disabled = viewport.zoom <= ZOOM_MIN + 1e-6
  zoomInBtn.disabled = viewport.zoom >= zoomCeiling() - 1e-6
}

zoomInBtn.addEventListener('click', () => applyControlZoom(viewport.zoom * ZOOM_STEP))
zoomOutBtn.addEventListener('click', () => applyControlZoom(viewport.zoom / ZOOM_STEP))
zoomSlider.addEventListener('input', () => applyControlZoom(sliderToZoom(Number(zoomSlider.value))))
// Double-click the slider returns to Fit (GOAL).
zoomSlider.addEventListener('dblclick', () => fitBoard())
oneToOneBtn.addEventListener('click', showNativeImageView)

// Same rule as the box header: adjusting the zoom must never end the box
// description being typed. The buttons never take focus at all; the slider has
// to (it is dragged), so it hands the keyboard straight back on release — and
// the description's blur handler knows focus landing in here is not the end of
// the pending box.
zoomInBtn.addEventListener('mousedown', (e) => e.preventDefault())
zoomOutBtn.addEventListener('mousedown', (e) => e.preventDefault())
zoomSlider.addEventListener('pointerup', () => refocusEditing())

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
    // and never while a drag is in progress (the box being dragged is what the
    // pointer means then).
    //
    // A pending description does NOT suppress it: the probe keeps running while
    // one is open, so the outline was the only part of the answer that went
    // missing — the pointer moved over object after object with nothing to show
    // for it, in the state where the next pick is most likely to come.
    if (hoverObject !== null && hoverDisplay !== null && drag === null && !exporting) {
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

/**
 * The scrub position everything on screen is resolved at (#86).
 *
 * The PICTURE's clock, not the playhead's (#81): a tracked box has to agree
 * with the frame it is drawn over, and those differ by up to one frame gap.
 */
function nowMs(): number {
  return presentedOn(focusedDisplayIndex)
}

/**
 * The pack time ONE SCREEN is showing (#88).
 *
 * Every screen has its own frames: the recorders run independently, so two
 * replays seeked to the same position land on two different moments. A box
 * drawn on a screen is resolved on THAT screen's clock or it is placed for a
 * picture the neighbour is showing.
 */
function presentedOn(displayIndex: number): number {
  if (!scrub) return replayDurationMs
  if (scrub.atNow) return replayDurationMs
  return Math.min(scrub.presentedMsFor(displayIndex), replayDurationMs)
}

/**
 * One annotation as it should be DRAWN, on the clock of the screen it is on.
 *
 * Two passes, because a tracked box can MOVE between screens: resolving it
 * needs a clock, and which clock depends on where it resolved to. The first
 * pass asks the screen it is stored on, and if that says it is somewhere else
 * now, the second asks that screen instead. Both clocks are within a frame of
 * each other, so this converges immediately and never oscillates.
 */
function resolveForBoard(a: Annotation): Annotation {
  const stored = displayIndexOf(a)
  const motionSpace = authoredMotionSpace()
  const first = annotationAt(a, presentedOn(stored), motionSpace)
  const landed = displayIndexOf(first)
  return landed === stored ? first : annotationAt(a, presentedOn(landed), motionSpace)
}

/**
 * The annotations to DRAW and HIT-TEST, each already resolved to where it is
 * at the current position (#86).
 *
 * This is the one place a track becomes a rectangle. Everything downstream —
 * drawing, blurring, selection chrome, hit-testing — keeps reading `bounds` and
 * is right without knowing tracking exists. Editing writes to
 * `state.annotations`, which is untouched by this.
 */
function visibleAnnotations(): readonly Annotation[] {
  const live = scrub ? state.annotations.filter(annotationVisibleNow) : state.annotations
  return live.map(resolveForBoard)
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

let unsavedReturnFocus: HTMLElement | null = null
const unsavedInertBefore = new Map<HTMLElement, boolean>()

/**
 * Makes the centred confirmation a real modal. `#unsavedBar` lives inside
 * `#stage`, so the stage itself must stay live while its siblings and every
 * other body child become inert.
 */
function setUnsavedBackgroundInert(inert: boolean): void {
  if (inert) {
    unsavedInertBefore.clear()
    const background: HTMLElement[] = []
    for (const child of Array.from(document.body.children)) {
      if (!(child instanceof HTMLElement)) continue
      if (child === stage) {
        for (const stageChild of Array.from(stage.children)) {
          if (stageChild instanceof HTMLElement && stageChild !== unsavedBar) {
            background.push(stageChild)
          }
        }
      } else {
        background.push(child)
      }
    }
    for (const node of background) {
      unsavedInertBefore.set(node, node.inert)
      node.inert = true
    }
    return
  }
  for (const [node, wasInert] of unsavedInertBefore) {
    if (node.isConnected) node.inert = wasInert
  }
  unsavedInertBefore.clear()
}

function showUnsavedBar(): void {
  if (!unsavedBar.hidden) {
    unsavedSaveBtn.focus()
    return
  }
  unsavedReturnFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  setUnsavedBackgroundInert(true)
  unsavedBar.hidden = false
  unsavedSaveBtn.focus()
}

function hideUnsavedBar(refocus = true): void {
  if (unsavedBar.hidden) return
  unsavedBar.hidden = true
  setUnsavedBackgroundInert(false)
  const target = unsavedReturnFocus
  unsavedReturnFocus = null
  if (refocus) {
    if (target?.isConnected && !target.inert) target.focus()
    else overlay.focus()
  }
}

unsavedSaveBtn.addEventListener('click', () => void doExport('save'))
unsavedSaveAsBtn.addEventListener('click', () => void doExport('saveAsNew'))
unsavedDiscardBtn.addEventListener('click', () => window.editorBridge.cancel())
unsavedBar.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    hideUnsavedBar()
    return
  }
  if (e.key !== 'Tab') return
  const first = unsavedSaveBtn
  const last = unsavedDiscardBtn
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
})

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
  // THE LANE APPEARS WITH THE BOX, NOT AFTER IT IS COMMITTED (#92).
  //
  // A box being created lives in the text session, not in the store, so a
  // timeline drawn from the store alone stayed empty until the user pressed
  // Enter — while the box itself was already on screen with a lifetime the
  // header was offering to change. The lane is where that lifetime is edited,
  // so it has to exist as soon as the lifetime does.
  //
  // Only the TEXT-session draft, never the rectangle being dragged out: that
  // one has no lifetime yet and its lane would appear and vanish under the
  // pointer.
  const pending = pendingDraft()
  const lanes =
    pending === null || pending.start_ms === undefined
      ? state.annotations
      : [...state.annotations, pending]
  timebar.setAnnotations(lanes, pending?.annotation_id ?? state.selectedId, scrub.durationMs)
}

// ---------------------------------------------------------------------------
// Shortcut sheet (GOAL "Editor Chrome"): ONE `?` affordance in the top bar,
// toggled by that button or F1, replacing the long inline key hint that used to
// sit above the frozen capture as a wall of text.
//
// ON BY DEFAULT, so a new user sees the whole vocabulary without asking; the
// toggle state persists (settings.showShortcutOverlay), so turning it off is
// permanent until turned back on.
//
// It is a PASSIVE LAYER, never a modal: click-through (pointer-events: none in
// the CSS), it never takes focus, and it answers NO Esc — Esc always means what
// it meant, so the sheet can never cost the user a second press to close the
// editor. The only two things that toggle it are the `?` button and F1. It dims
// further while the pointer is near it, so it can never hide the thing being
// annotated.
// ---------------------------------------------------------------------------

let helpOpen = false
/** Screen box the proximity dim measures against; null until measured. */
let helpRect: DOMRect | null = null
let helpNear = false
/** Last pointer position seen anywhere in the window (proximity dim input). */
let helpPointerX = Number.NEGATIVE_INFINITY
let helpPointerY = Number.NEGATIVE_INFINITY
/** How close the pointer has to get before the sheet gets out of the way. */
const HELP_NEAR_PADDING = 90

/** One line of the sheet: the gesture/keys, and what they do. */
type HelpRow = readonly [keys: string, what: string]

/** ' + '-joined key atoms; the modifier caps are key names, not prose. */
function keys(...parts: string[]): string {
  return parts.join(' + ')
}

/**
 * The sheet's content, built fresh on every open so the CONFIGURABLE steps
 * show their live values (scrub sensitivity ms/notch, capture FPS) instead of
 * the defaults they had in the docs. Groups that describe things this capture
 * cannot do are left out entirely: no replay = no time group, one display = no
 * display framing.
 */
function helpContent(): Array<{ title: string; rows: HelpRow[] }> {
  const groups: Array<{ title: string; rows: HelpRow[] }> = []
  const captureRows: HelpRow[] = [[t('editor.keyLeftClick'), t('editor.helpPickObject')]]
  // The window-level modifier only means something where there IS object data
  // (GOAL "Static object picking"); a pack without a UIA dump would be told
  // about a modifier that can never do anything.
  if (hasObjectData()) {
    captureRows.push([keys('Shift', t('editor.keyLeftClick')), t('editor.helpForceWindow')])
    // The candidate stack is a feature, not a debug view (#66) — a user who is
    // never told about Tab has one object per point, which is exactly the
    // behaviour the stack exists to replace.
    captureRows.push([t('editor.keyTab'), t('editor.helpCycleObjects')])
  }
  captureRows.push([t('editor.keyRightDrag'), t('editor.helpNewBox')])
  groups.push({ title: t('editor.helpGroupCapture'), rows: captureRows })
  if (scrub !== null) {
    const timeRows: HelpRow[] = [
      [t('editor.keyWheel'), t('editor.helpWheelStep', { ms: scrubSensitivityMs })],
      [keys('Shift', t('editor.keyWheel')), t('editor.helpWheelSecond')],
      [keys('Alt', t('editor.keyWheel')), t('editor.helpWheelFrame', { fps })],
    ]
    // Trim is the fresh-capture flow only: re-editing a saved pack never
    // trims further, so I/O do nothing there and are not advertised.
    if (trimEnabled()) timeRows.push(['I / O', t('editor.helpTrim')])
    timeRows.push(['Space', t('editor.helpPlay')])
    groups.push({ title: t('editor.helpGroupTime'), rows: timeRows })
  }
  const viewRows: HelpRow[] = [
    [keys('Ctrl', t('editor.keyWheel')), t('editor.helpZoom')],
    // Two ways to pan, listed together (issue #55): the middle-button drag is
    // one hand and no key, and a gesture nobody is told about is a gesture
    // nobody has.
    [keys('Space', t('editor.keyDrag')), t('editor.helpPan')],
    [t('editor.keyMiddleDrag'), t('editor.helpPan')],
  ]
  if (board !== null && board.displays.length > 1) {
    // The key left of 1 (issue #41), with the old 0 still accepted — the sheet
    // teaches the new one and admits the alias in the same row.
    viewRows.push(['1…9', t('editor.helpFrameDisplay')], ['` / 0', t('editor.helpFitBoard')])
  }
  groups.push({ title: t('editor.helpGroupView'), rows: viewRows })
  groups.push({
    title: t('editor.helpGroupEdit'),
    rows: [
      // Ctrl/Shift/Alt/Space stay as the app spells them everywhere else (the
      // capture accelerator is shown untranslated too); the caps that ARE
      // printed differently per locale — Enter/Esc/Del — come from i18n.
      ['Ctrl+Z / Ctrl+Y', t('editor.helpUndoRedo')],
      ['Alt+1…9 / Alt+0', t('editor.helpPinNumber')],
      [t('editor.keyDelete'), t('editor.helpDeleteBox')],
      [t('editor.keyEnter'), t('editor.save')],
      [t('editor.keyEsc'), t('editor.helpClose')],
    ],
  })
  return groups
}

function buildHelpSheet(): void {
  helpGroups.replaceChildren()
  for (const group of helpContent()) {
    const section = document.createElement('div')
    section.className = 'helpGroup'
    const title = document.createElement('div')
    title.className = 'helpGroupTitle'
    title.textContent = group.title
    section.append(title)
    for (const [k, what] of group.rows) {
      const row = document.createElement('div')
      row.className = 'helpRow'
      const keyCell = document.createElement('span')
      keyCell.className = 'helpKeys'
      keyCell.textContent = k
      const whatCell = document.createElement('span')
      whatCell.className = 'helpWhat'
      whatCell.textContent = what
      row.append(keyCell, whatCell)
      section.append(row)
    }
    helpGroups.append(section)
  }
}

function openHelp(): void {
  if (helpOpen) return
  helpOpen = true
  helpSheet.hidden = false
  // Built while VISIBLE: the panel is an aria-live region and nothing inside it
  // is focusable, so an announcement on reveal is the only way a screen-reader
  // user ever hears the shortcut list.
  buildHelpSheet()
  helpBtn.setAttribute('aria-expanded', 'true')
  syncHelpGeometry()
}

function closeHelp(): void {
  if (!helpOpen) return
  helpOpen = false
  helpSheet.hidden = true
  helpBtn.setAttribute('aria-expanded', 'false')
}

/** The `?` button and F1 — the ONLY two toggles — and the choice is remembered. */
function toggleHelp(): void {
  if (helpOpen) closeHelp()
  else openHelp()
  window.editorBridge.setShortcutOverlay(helpOpen)
}

helpBtn.addEventListener('click', () => toggleHelp())

// Same rule as the box header: reaching for the `?` mid-task must never end the
// box description being typed. Without this, mousedown moves focus, #textEditor
// blurs onto a target that is neither the header nor the duration popover, and
// the pending box commits itself while the user is still typing it.
helpBtn.addEventListener('mousedown', (e) => e.preventDefault())

/** Re-measures the sheet (open, rebuilt, or the window resized) and re-dims. */
function syncHelpGeometry(): void {
  if (!helpOpen) {
    helpRect = null
    return
  }
  helpRect = helpSheet.getBoundingClientRect()
  syncHelpProximity()
}

/**
 * Dims the sheet while the pointer is near it (GOAL: "it dims further while the
 * pointer is near it so it can never hide the thing being annotated"). The
 * panel is click-through, so it can never be told this itself — the test is a
 * distance against a rect measured once per open/resize, never per move.
 */
function syncHelpProximity(): void {
  const r = helpRect
  const near =
    helpOpen &&
    r !== null &&
    helpPointerX >= r.left - HELP_NEAR_PADDING &&
    helpPointerX <= r.right + HELP_NEAR_PADDING &&
    helpPointerY >= r.top - HELP_NEAR_PADDING &&
    helpPointerY <= r.bottom + HELP_NEAR_PADDING
  if (near === helpNear) return
  helpNear = near
  helpSheet.dataset['near'] = near ? 'true' : 'false'
}

window.addEventListener(
  'pointermove',
  (e) => {
    helpPointerX = e.clientX
    helpPointerY = e.clientY
    if (helpOpen) syncHelpProximity()
  },
  { capture: true, passive: true },
)

// ---------------------------------------------------------------------------
// Replay Trim (GOAL "Replay Trim") — in/out handles on the timebar, fresh
// capture flow only. The trim decides what Save keeps AND bounds the clock:
// once set, scrubbing, playback and timeline drags stay inside it.
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
  // THE TRIM RANGE IS THE BOUNDARY (GOAL "Editor Input System"): the clock
  // itself is bounded, so wheel scrubbing, playback and timeline drags all
  // clamp at the handles — and moving a handle past the playhead pulls the
  // playhead (every display's, the board has one clock) into the new range.
  // Untrimmed values (0 / null) hand the whole buffer back.
  scrub?.setRange(trimInMs, trimOutMs)
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

/**
 * Live right-drag preview: an ephemeral box that never enters the store, drawn
 * exactly as the committed box will be (same colour, same border).
 *
 * IT CARRIES ITS DISPLAY, like every real box does (SPEC §8.8). Without that,
 * `displayIndexOf` resolved the draft to the FOCUSED display and schedulePaint
 * grouped it there — so a right-drag on any other screen of the board painted
 * its live rectangle on the focused one (measured: a drag at x 200..400 of the
 * left screen drew at canvas x 999..1200, i.e. on the right screen), and the
 * rectangle only appeared under the pointer on release, where beginPendingBox
 * stamps the display properly. That is issue #40: the drag looked like it drew
 * nothing at all.
 */
function dragDraft(d: {
  d: BoardDisplay
  x0: number
  y0: number
  x: number
  y: number
}): Annotation | null {
  const b = normBox(d)
  if (b.w < MIN_DRAG || b.h < MIN_DRAG) return null
  return {
    annotation_id: 'draft',
    type: 'box',
    bounds: { x: b.x, y: b.y, width: b.w, height: b.h },
    // Same rule as beginPendingBox: the focused display writes nothing.
    ...(d.d.index === focusedDisplayIndex ? {} : { display: d.d.index }),
    text: '',
    numbered: false,
    blur: false,
    tracking: { enabled: false },
    style: { color: MANUAL_BOX_COLOR },
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
  // ONE BOX PER OBJECT PER MOMENT (#101).
  //
  // "같은프레임에 같은 윈도우는 셀렉트 또 안생기게 해줘". Clicking a window that
  // is already annotated at this position produced a SECOND box on top of the
  // first — same rectangle, same target, indistinguishable in the pack, and the
  // one underneath unreachable. The click means "this object", and this object
  // already has a box here, so the click SELECTS it instead of duplicating it.
  //
  // Scoped to the moment, not the whole replay: the same window annotated at
  // 4 s and again at 20 s is two statements about two different times, which is
  // the entire point of a lifetime.
  const already = picked === undefined ? null : existingBoxFor(picked)
  if (already !== null) {
    selectBox(already.annotation_id, on)
    return
  }
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
    // A picked box carries the SEMANTIC colour explicitly (#52) rather than
    // relying on a reader's default: the pack should say what it looks like.
    style: { color: picked === undefined ? MANUAL_BOX_COLOR : SEMANTIC_BOX_COLOR },
    created_at: stamp.created_at,
    z: stamp.z,
  }
  if (picked !== undefined) {
    draft.target = annotationTargetOf(picked)
    pickedObjectIdentities.set(draft.annotation_id, pickIdentityOf(picked))
    // Remembered so a later move/resize can tell whether the box still
    // annotates the object it claims to.
    pickedRects.set(draft.annotation_id, { x: b.x, y: b.y, w: b.w, h: b.h })
  }
  // THE FRAME THE USER CLICKED ON (#90).
  //
  // Everything below anchors to this one number, so it is computed once, from
  // the picture, before any lifetime exists to be a midpoint of.
  //
  // From the screen the click LANDED on, not the focused one: the board shows
  // every captured display at once and they present independently, so a click
  // on the second monitor's picture must be timed by that monitor's picture —
  // the same frame the rectangle above was read out of.
  const pickedAt = presentedOn(on.index)
  if (scrub) {
    // "Now" (the capture instant) anchors at the end of the replay; a scrubbed
    // stamp is clamped to the manifest's wall-clock replay_duration_ms — the
    // parsed video clock can run slightly past it.
    // ON THE PICTURE'S CLOCK, like the geometry above (#81/#85). The box was
    // drawn over a frame, and after #81 its rectangle comes from that frame's
    // time. Stamping the lifetime with the PLAYHEAD's time instead would put the
    // two on different clocks and the pack would contradict the screen: a reader
    // comparing the box against the replay at the box's own time sees an error
    // of up to one frame gap that the user never saw while drawing it.
    // FROM the pick, not around it: the clicked frame is the first frame the
    // box is drawn on (see lifetime.ts).
    const life = lifetimeFrom(Math.round(pickedAt), defaultManualDurationMs, replayDurationMs)
    draft.start_ms = life.start_ms
    draft.end_ms = life.end_ms
  }
  if (picked?.surface != null) {
    // THE PICK INSTANT IS THE FRAME, NOT THE MIDDLE OF ANYTHING (#90).
    //
    // #111 moved `bounds` off the lifetime midpoint because editing the
    // lifetime moved it — but it then recorded the pick instant AS that
    // midpoint, so the anchor was still a derived number and still not the
    // moment the user clicked. When the default lifetime is a second wide and
    // the track therefore spans a second, an anchor even slightly outside it
    // clamps to the track's FIRST sample: measured on
    // CapturePack_2026-07-29_092305, the track ran 15648–16589 ms and `bounds`
    // was the 15648 ms rectangle — the window as it had been before the frame
    // on screen, which is exactly the "it locks onto a time ahead of my pick"
    // the report describes.
    //
    // The frame the box was drawn over is the only instant that means anything
    // here, and it is the same clock the rectangle itself came from (#81).
    pickedAtMs.set(draft.annotation_id, pickedAt)
    const controlAnchor: ControlTrackAnchor | null =
      picked.level === 'control' && board !== null
        ? {
            display: on.index,
            bounds: { x: b.x, y: b.y, width: b.w, height: b.h },
            surfaceBounds: { ...picked.surface.bounds },
            displays: board.displays.map((d) => ({
              index: d.index,
              width: d.width,
              height: d.height,
              pixelsPerDip: d.bw > 0 ? d.width / d.bw : 1,
            })),
          }
        : null
    attachTrack(draft, picked.surface.surfaceId, controlAnchor)
  }
  textSession = { kind: 'new', draft }
  // The lane belongs to the box, and the box exists now (#92).
  syncLanes()
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

/**
 * SELECTS a box and puts the caret in its DESCRIPTION with the existing text
 * selected (issue #42) — whatever the box was selected BY: a click on the
 * canvas, a double-click, a lane on the timebar.
 *
 * Creating a box has always opened its description this way, and the editor is
 * built around typing immediately; a selected box that made the user click into
 * its text first was the one place that rhythm broke. Selected-with-text-
 * selected means typing REPLACES the description and Esc leaves it exactly as
 * it was, which is the same contract the pending-box input has.
 *
 * Two consequences, both intended and both already the editor's rule: the
 * keyboard shortcuts are dead while a text field has focus (so Delete edits the
 * description instead of deleting the box — the header × is what deletes a
 * selected box now), and a move/resize drag must NOT pull focus back to the
 * canvas (overlay's mousedown handler suppresses the focus it would otherwise
 * take, and the drag path never focuses anything).
 *
 * ONE exception, because this path made it necessary: Ctrl+Z/Ctrl+Y on a
 * description nothing has been typed into still undoes the BOARD (see the
 * #textEditor keydown handler). Every move and resize ends here, so the undo
 * the sheet advertises has to survive the selection it just made.
 */
function selectBox(id: string, on?: BoardDisplay): void {
  const a = state.byId(id)
  if (a === undefined) return
  state.selectedId = id
  const display = on ?? displayOf(a)
  if (display === null) return
  textSession = { kind: 'edit', id }
  // The bounds OBJECT, not a copy: a move/resize mutates it in place and
  // positionTextEditor re-reads it, so the input rides along with the box.
  openTextEditor(display, a.bounds, a.text, true)
}

// ---------------------------------------------------------------------------
// Inline text input (new-box description / box-selection text edit)
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
  textEdited = false
  textEditor.hidden = false
  positionTextEditor()
  textEditor.focus()
  if (selectAll) textEditor.select()
}

/**
 * Gap between the description input and the bottom of its box, in #frame's own
 * (untransformed) space — so it rides the viewport zoom exactly as the box does,
 * unlike the box header's gap, which is screen px because the header is not in
 * the frame at all.
 */
const TEXT_EDITOR_GAP = 6

function positionTextEditor(): void {
  if (!textAnchor || textDisplay === null) return
  // A selected annotation may be somewhere other than its stored base bounds
  // at the frame on screen (authored keyframes, object tracking, or a
  // cross-display move). The dashed selection and header already use that
  // resolved rectangle; the description input must use the same one or it
  // appears detached at the old/base position.
  let anchor = textAnchor
  let display = textDisplay
  if (textSession?.kind === 'edit') {
    const stored = state.byId(textSession.id)
    if (stored !== undefined) {
      const painted = resolveForBoard(stored)
      anchor = painted.bounds
      display = displayOf(painted) ?? display
    }
  } else if (textSession?.kind === 'new') {
    anchor = textSession.draft.bounds
    display = displayOf(textSession.draft) ?? display
  }
  // The input lives in #frame (BOARD CSS space), so the box's native anchor is
  // converted through its own display first — otherwise a box on the second
  // screen would get its description input over the first one.
  const topLeft = toBoardPoint(display, anchor.x, anchor.y + anchor.height)
  const w = textEditor.offsetWidth
  const h = textEditor.offsetHeight
  // THE INPUT MUST BE ON SCREEN, not merely inside the board. #frame is
  // transformed (zoom/pan) and #stage clips it, so "inside #frame" and "visible"
  // are two different constraints, and only the second one matters: this element
  // is FOCUSED the instant it is shown (openTextEditor), and a focused field the
  // user cannot see is a field they type into blind.
  //
  // It used to be rescued by accident. Under `overflow: hidden` #stage was a
  // scroll container, so focus() scrolled the caret back into view — the very
  // mechanism that turned out to be issue #50's suspect and the reason #stage is
  // now `overflow: clip`. Nothing scrolls any more, so the band of #frame that
  // #stage actually shows is computed here instead.
  const fr = frame.getBoundingClientRect()
  const sr = stage.getBoundingClientRect()
  // Frame-local px -> viewport px: clientWidth is the UNtransformed width and the
  // client rect is the transformed one, so their ratio is exactly the viewport
  // zoom. Guarded because a frame with no width would divide by zero on the very
  // first layout, before the board has been sized.
  const scale = frame.clientWidth > 0 && fr.width > 0 ? fr.width / frame.clientWidth : 1
  // The visible band, expressed as the range `left`/`top` may take.
  const minLeft = Math.max(0, (sr.left - fr.left) / scale)
  const maxLeft = Math.min(
    // Held inside #frame horizontally for the reason it always was: a 140px-min
    // input anchored to a box near the right edge would otherwise run off the
    // board. There is deliberately no such limit VERTICALLY — the anchor sits
    // below the box, and for a box on the board's bottom row that is a few px of
    // dark stage background, which is visible and correct; pulling it back inside
    // #frame would drop it onto the box instead.
    Math.max(0, frame.clientWidth - w),
    (sr.right - fr.left) / scale - w,
  )
  const minTop = Math.max(0, (sr.top - fr.top) / scale)
  const maxTop = (sr.bottom - fr.top) / scale - h
  // Math.max LAST, so the lower bound wins when the visible band is narrower than
  // the input itself: showing the start of the field beats showing none of it.
  textEditor.style.left = `${Math.max(minLeft, Math.min(topLeft.x * fitScale, maxLeft))}px`
  textEditor.style.top = `${Math.max(minTop, Math.min(topLeft.y * fitScale + TEXT_EDITOR_GAP, maxTop))}px`
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
  if (pending !== null) {
    pickedRects.delete(pending.annotation_id)
    trackedSurfaces.delete(pending.annotation_id)
    pickedObjectIdentities.delete(pending.annotation_id)
    trackedControlAnchors.delete(pending.annotation_id)
    pickedAtMs.delete(pending.annotation_id)
  }
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
  // Whatever ended it — commit, cancel, a click elsewhere — the click-pick draft
  // is no longer live, and a stale id here could only ever mean the wrong box.
  clickPickDraftId = null
  textEditor.hidden = true
  textEditor.value = ''
  if (refocus) overlay.focus()
}

textEditor.addEventListener('input', () => {
  textEdited = true
})
textEditor.addEventListener('keydown', (e) => {
  // F11 (window mode) and F1 (the shortcut sheet) are window shortcuts, not
  // editing keys: forwarded rather than swallowed, so the advertised "works
  // from anywhere" holds while typing a box description (which is where
  // re-edit spends most of its time).
  if (e.key === 'F11' || e.key === 'F1') return
  // Ctrl+Z / Ctrl+Y on an UNTOUCHED description of an EXISTING box is the
  // board's undo, and is answered here.
  //
  // Selecting a box opens its description (issue #42) — and a move or resize
  // drag selects it — so after the one gesture undo is most wanted for, the
  // caret sits in a text field that swallows every shortcut. With nothing typed
  // there is no text edit for the field's own undo to revert, so the keystroke
  // can only mean the board's; the standing rule (shortcuts are dead while
  // typing) takes over again the moment anything is typed, and the field keeps
  // its native undo from then on.
  //
  // A box being CREATED is excluded: it is not in the store yet, so "undo"
  // there would step past a box the user is still writing. Esc discards it,
  // which is what the sheet says.
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !textEdited && textSession?.kind === 'edit') {
    const k = e.key.toLowerCase()
    if (k === 'z' || k === 'y') {
      e.preventDefault()
      e.stopPropagation()
      // undo/redo swaps the whole annotation array and clears the selection, so
      // this text session is over — and with nothing typed there is nothing to
      // commit on the way out.
      closeTextEditor()
      if (k === 'y' || e.shiftKey) state.redo()
      else state.undo()
      refresh()
      return
    }
  }
  e.stopPropagation()
  if (e.key === 'Enter') {
    // Enter commits the box WITH whatever the header toggles were set to while
    // typing — number, lifetime, blur are all already on the draft.
    commitTextEditor()
  } else if (e.key === 'Escape') {
    // Cancel-current first, like the canvas Esc ladder: an open duration
    // popover is dismissed before the box it belongs to. Otherwise Esc
    // discards the WHOLE pending box, not just the text.
    if (numberPickerOpen) closeNumberPicker()
    else if (durationEditorOpen) closeDurationEditor()
    else cancelTextEditor()
  }
})
textEditor.addEventListener('blur', (e) => {
  // Focus landing inside the box's OWN header (or the duration editor it opens)
  // is an edit of the box being created, not the end of it — the description
  // stays open and the pending box uncommitted. The header buttons also
  // preventDefault their mousedown, so they never take focus at all; this
  // covers the two controls that legitimately do: the custom-duration input and
  // the zoom slider (a range input cannot be dragged without focus — it hands
  // the keyboard back on pointerup).
  const next = e.relatedTarget
  if (
    next instanceof Node &&
    (boxHeader.contains(next) ||
      durationEditor.contains(next) ||
      numberPicker.contains(next) ||
      zoomControl.contains(next))
  ) {
    return
  }
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
let numberPickerOpen = false

/** The box being created (right-drag released, description still open). */
function pendingDraft(): Annotation | null {
  return textSession?.kind === 'new' ? textSession.draft : null
}

/** The selected box, if it applies at the current scrub position. */
/**
 * The selected box AS STORED — the object every edit writes into.
 *
 * MUST NOT be the resolved view (#86). A tracked box resolves to a COPY, and a
 * mutation applied to a copy is a mutation the user watches happen and then
 * loses: colour, blur, numbering and duration all silently reverting on exactly
 * the boxes that follow something. Anything GEOMETRIC wants
 * `selectedPaintedAnnotation` instead.
 */
function selectedVisibleAnnotation(): Annotation | null {
  if (state.selectedId === null) return null
  const a = state.byId(state.selectedId)
  return a !== undefined && annotationVisibleNow(a) ? a : null
}

/**
 * The selected box WHERE IT IS DRAWN, for chrome that has to sit on it (#86).
 *
 * Resize handles and the header hug the rectangle the user can see. On a
 * tracked box that is the tracked rectangle, not the stored one — handles on
 * the stored rect would be grab points floating where no box is.
 */
function selectedPaintedAnnotation(): Annotation | null {
  const a = selectedVisibleAnnotation()
  return a === null ? null : resolveForBoard(a)
}

/**
 * The box every header control acts on: the pending one while a box is being
 * created (its lifetime is irrelevant — it is drawn regardless), else the
 * selection.
 */
function headerAnnotation(): Annotation | null {
  // Painted, not stored (#86): this positions the header over the box, and on a
  // tracked box those are different rectangles.
  return pendingDraft() ?? selectedPaintedAnnotation()
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
 * sentence to the shortcut ladder (Delete deletes the box).
 * The header's mousedown preventDefault already keeps focus out of the buttons
 * themselves, so leaving it exactly where it is, is right.
 */
function refocusEditing(): void {
  // The custom-duration field is the one control here that is TYPED IN. Pulling
  // focus off it mid-number would hand the digits to the shortcut ladder while
  // its popover is still open and visible (Enter would save the pack), so a
  // still-open duration editor keeps what it has.
  const active = document.activeElement
  if (durationEditorOpen && active instanceof Node && durationEditor.contains(active)) return
  if (numberPickerOpen && active instanceof Node && numberPicker.contains(active)) return
  if (textSession !== null && !textEditor.hidden) textEditor.focus()
  else if (active !== titleInput && active !== noteInput) overlay.focus()
}

/**
 * A VIEWPORT point — what getBoundingClientRect() speaks — in the space #stage's
 * absolutely positioned chrome (#boxHeader, #durationEditor) is laid out in.
 * THE ONE PLACE that conversion happens, because getting it wrong is issue #50.
 *
 * The two spaces are not the same the moment #stage can scroll: a `top`/`left`
 * on an absolute child is measured from the padding box and rides the scroll
 * offset, while a client rect never does — so they differ by exactly
 * scrollTop/scrollLeft. `overflow: hidden` made #stage a scroll container, a
 * zoomed board overflows it, and anything that scrolls an element into view
 * (overlay.focus() on the framed board the editor opens with, the caret in a
 * box description) scrolled it for good. That is the header landing far above
 * its box, in open space, at no particular viewport edge.
 *
 * #stage is now `overflow: clip` (see editor.css) so the offset can never
 * become non-zero; it stays in the formula because that makes the conversion
 * correct BY CONSTRUCTION rather than by the CSS staying the way it is today.
 */
function toStagePoint(clientX: number, clientY: number): { x: number; y: number } {
  const sr = stage.getBoundingClientRect()
  return { x: clientX - sr.left + stage.scrollLeft, y: clientY - sr.top + stage.scrollTop }
}

/** Maps a point in ONE display's native pixels to #stage's positioning space. */
function toScreen(d: BoardDisplay, x: number, y: number): { x: number; y: number } {
  const or = overlay.getBoundingClientRect()
  const p = toBoardPoint(d, x, y)
  const scale =
    board !== null && board.width > 0 && or.width > 0 ? or.width / board.width : fitScale
  return toStagePoint(or.left + p.x * scale, or.top + p.y * scale)
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
  // #stage clips, and the board makes "the selection is somewhere off screen"
  // routine: zoomToDisplay (1..9) does not clear the selection, so framing
  // another display leaves the box outside the viewport entirely. A header
  // pinned to the stage edge then floats over a screen the box is not on and
  // points at nothing, which is worse than no header.
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
  // CONTENT BEFORE MEASUREMENT (issue #50). Every label here changes the
  // header's size — [#] becomes [7], [Blur] becomes [Blur On], the duration chip
  // appears and disappears with the replay — and the position below is computed
  // from offsetWidth/offsetHeight. Written after them, the measurement described
  // the PREVIOUS selection's header and the box got someone else's offset.
  // [#|N]: shows the computed display number while numbering is on — for a
  // pending box, the number it will carry the moment Enter commits it.
  const number = displayNumbers().get(a.annotation_id)
  numberBtn.textContent = a.numbered && number !== undefined ? String(number) : '#'
  numberBtn.classList.toggle('on', a.numbered)
  // Choosing WHICH number is meaningless for a box that shows none, so the
  // caret follows the toggle. A pin the user set while numbering was on is
  // kept, not cleared, when they turn it off and on again — see `number_pin`.
  numberPinBtn.hidden = !a.numbered
  if (!a.numbered && numberPickerOpen) closeNumberPicker(false)
  syncNumberPicker(a)
  blurBtn.textContent = a.blur ? t('editor.blurOn') : t('editor.blur')
  blurBtn.classList.toggle('on', a.blur)
  // Duration is only meaningful with a replay; respect settings.showDurationLabel.
  const showChip = scrub !== null && showDurationLabel
  durationChip.hidden = !showChip
  if (showChip) durationChip.textContent = chipLabel(a)
  else closeDurationEditor(false)
  positionBoxHeader(topLeft, bottomRight)
  if (durationEditorOpen) positionDurationEditor()
  if (numberPickerOpen) positionNumberPicker()
}

/** Screen px between the header and the dashed selection rect it belongs to. */
const BOX_HEADER_GAP = 4
/**
 * How far INSIDE the box the header sits when there is no room above it — far
 * enough to clear the 3 px border and read as inside, close enough that it is
 * still the corner's label rather than a floating chip.
 */
const BOX_HEADER_INSET = 8

/**
 * Places the header against the selection rect, in #stage's own positioning
 * space (see toScreen — both corners arrive in it, not in viewport pixels).
 *
 * Read after the labels are written and after the element is visible, so
 * offsetWidth/offsetHeight are this box's header and not the last one's
 * (issue #50). The offsets are SCREEN pixels applied to a screen-space
 * measurement, so the gap is the same 4px at every zoom.
 */
function positionBoxHeader(
  topLeft: { x: number; y: number },
  bottomRight: { x: number; y: number },
): void {
  const w = boxHeader.offsetWidth
  const h = boxHeader.offsetHeight
  // Clamped on BOTH edges (#stage clips). The fullscreen overlay almost always
  // leaves horizontal margin, but a windowed editor can be resized until the
  // image fills the stage — and a header pushed off the right edge takes the
  // blur toggle, the number toggle and the duration chip with it, none of which
  // have a keyboard fallback.
  // ABOVE the box by default; INSIDE ITS TOP-LEFT when there is no room above.
  //
  // The fallback used to be BELOW the box, and it was disorienting: the header
  // carries the box's own controls (blur, number, duration), so flipping it to
  // the far side of a tall box put them a whole window away from the corner the
  // eye is on, and on a box taller than the stage the header could land off the
  // bottom entirely and get clamped to a random edge. Reported as "박스 위에
  // 툴팁이 위에가 가려지면 밑으로 내려오는데 내 생각에는 box 안쪽 좌상단에
  // 있어야 맞는 거 같아", and that reading is right: the top-left corner is
  // where the number badge already is, so the label stays with the corner that
  // identifies the box whichever side of the edge it has to sit on.
  //
  // Inside means ON the annotated pixels, which is the cost — bounded to the
  // box's first rows, never its middle, and only when the box is against the
  // top of the stage.
  const above = topLeft.y - BOX_HEADER_GAP - h
  const inside = above < 0
  const maxLeft = Math.max(4, stage.clientWidth - w - 4)
  const left = inside ? topLeft.x + BOX_HEADER_INSET : topLeft.x
  boxHeader.style.left = `${Math.max(4, Math.min(left, maxLeft))}px`
  boxHeader.classList.toggle('inside', inside)
  // Never past the box's own bottom edge: on a box shorter than the header,
  // sitting inside would otherwise overhang the box it belongs to.
  const insideTop = Math.min(topLeft.y + BOX_HEADER_INSET, Math.max(topLeft.y, bottomRight.y - h))
  const top = inside ? insideTop : above
  const maxTop = Math.max(0, stage.clientHeight - h)
  boxHeader.style.top = `${Math.max(0, Math.min(top, maxTop))}px`
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
/** The lifetime a track's range is made of — compared to notice it changed. */
function lifeKey(a: Annotation): string {
  return `${a.start_ms ?? 'x'}..${a.end_ms ?? 'x'}`
}

function applyMutation(mutate: (a: Annotation) => void): void {
  const pending = pendingDraft()
  if (pending !== null) {
    const before = lifeKey(pending)
    mutate(pending)
    // A track was fetched for the lifetime the box had when it was picked. Any
    // change to that lifetime — a preset, "until the end", "entire capture" —
    // makes the path we hold the wrong length (#86).
    // The lifetime moved, so the representative instant did. Do NOT re-anchor
    // yet (#107): the track in hand was fetched for the OLD range and cannot
    // reach the new midpoint, so anchoring against it clamps to the track's end
    // — one big visible jump, and then a second one when the real track lands.
    // `attachTrack` re-anchors once, on the path that actually has the answer.
    if (lifeKey(pending) !== before) refreshTrack(pending)
    // Repaints the live preview (blur, number badge, border), re-syncs the
    // header labels, and moves the pending box's own lane (#92).
    syncLanes()
    schedulePaint()
    syncSelectionUi()
    return
  }
  const a = selectedVisibleAnnotation()
  if (a === null) return
  const snapshot = state.cloneAnnotations()
  const life = lifeKey(a)
  mutate(a)
  // Same rule as the pending path (#107): the refreshed track re-anchors it.
  if (lifeKey(a) !== life) refreshTrack(a)
  state.pushUndoSnapshot(snapshot)
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
  // The description that selecting this box opened (issue #42) belongs to it:
  // it closes with the box, and the keyboard goes back to the canvas — an input
  // left floating over a deleted box would commit its text into nothing.
  if (textSession?.kind === 'edit' && textSession.id === a.annotation_id) closeTextEditor()
  state.remove(a.annotation_id)
  // Same reason as cancelTextEditor: the box is gone, so its picked rect is too.
  pickedRects.delete(a.annotation_id)
  trackedSurfaces.delete(a.annotation_id)
  pickedObjectIdentities.delete(a.annotation_id)
  trackedControlAnchors.delete(a.annotation_id)
  pickedAtMs.delete(a.annotation_id)
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

numberPinBtn.addEventListener('click', () => {
  if (numberPickerOpen) closeNumberPicker()
  else openNumberPicker()
})

numberPicker.addEventListener('click', (e) => {
  const btn = e.target instanceof Element ? e.target.closest<HTMLButtonElement>('button[data-pin]') : null
  if (btn === null) return
  const v = btn.dataset.pin
  setSelectedNumberPin(v === 'auto' ? null : Number(v))
})
numberPicker.addEventListener('keydown', (e) => {
  if (e.key === 'F11' || e.key === 'F1') return
  e.stopPropagation()
  if (e.key === 'Escape') closeNumberPicker()
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
  // ONE QUESTION AT A TIME. The number and lifetime popovers share the same
  // box-header anchor; leaving both open put the number grid behind the larger
  // lifetime panel. Opening the thing the user just asked for dismisses the
  // other one instead of making z-index decide which question is visible.
  closeNumberPicker(false)
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

/** Marks the picker's current answer, so it shows the state as well as offers. */
function syncNumberPicker(a: Annotation): void {
  const pin = typeof a.number_pin === 'number' ? a.number_pin : null
  for (const btn of numberPicker.querySelectorAll<HTMLButtonElement>('button[data-pin]')) {
    const v = btn.dataset.pin
    btn.classList.toggle('on', v === 'auto' ? pin === null : Number(v) === pin)
  }
}

function openNumberPicker(): void {
  const a = headerAnnotation()
  if (a === null || !a.numbered) return
  // Symmetric with openDurationEditor(): the last header control clicked owns
  // the one popover slot, so neither panel can obscure the other.
  closeDurationEditor(false)
  numberPickerOpen = true
  numberPicker.hidden = false
  syncNumberPicker(a)
  positionNumberPicker()
}

function closeNumberPicker(refocus = true): void {
  if (!numberPickerOpen) return
  numberPickerOpen = false
  numberPicker.hidden = true
  if (refocus) refocusEditing()
}

function positionNumberPicker(): void {
  // Hangs off the caret that opened it, through toStagePoint, for the same
  // reason the duration popover does (issue #50).
  const cr = numberPinBtn.getBoundingClientRect()
  const anchor = toStagePoint(cr.left, cr.bottom + 6)
  const left = Math.max(8, Math.min(anchor.x, stage.clientWidth - numberPicker.offsetWidth - 8))
  const top = Math.max(8, Math.min(anchor.y, stage.clientHeight - numberPicker.offsetHeight - 8))
  numberPicker.style.left = `${left}px`
  numberPicker.style.top = `${top}px`
}

/**
 * Pins the selected box to `pin`, or back to automatic with null.
 *
 * Setting a pin also turns numbering ON: asking for number 3 on a box that
 * shows no number is a request nobody means, and silently doing nothing is the
 * worse answer.
 */
function setSelectedNumberPin(pin: number | null): void {
  applyMutation((a) => {
    if (pin === null) delete a.number_pin
    else {
      a.number_pin = pin
      a.numbered = true
    }
  })
  closeNumberPicker()
}

function positionDurationEditor(): void {
  // Hangs off the chip that opened it — through toStagePoint, for the same
  // reason the header does (issue #50): the chip is measured in the viewport
  // and the popover is positioned inside #stage.
  const cr = durationChip.getBoundingClientRect()
  const anchor = toStagePoint(cr.left, cr.bottom + 6)
  const left = Math.max(8, Math.min(anchor.x, stage.clientWidth - durationEditor.offsetWidth - 8))
  const top = Math.max(8, Math.min(anchor.y, stage.clientHeight - durationEditor.offsetHeight - 8))
  durationEditor.style.left = `${left}px`
  durationEditor.style.top = `${top}px`
}

// Where a re-lengthened lifetime KEEPS ITS START: the box's own start, or —
// for a box that never had a lifetime (it applies to the whole capture) — the
// capture instant, which is where such a box is anchored.
function lifetimeStartMs(a: Annotation): number {
  return a.start_ms ?? lifetimeMidpoint(a, replayDurationMs)
}

function setSelectedDuration(ms: number): void {
  applyMutation((a) => {
    const life = lifetimeExtending(lifetimeStartMs(a), ms, replayDurationMs)
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
    const start = Math.max(0, Math.min(Math.round(lifetimeStartMs(a)), replayDurationMs))
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
  // Same as the text input: F11/F1 belong to the window, so they are forwarded
  // to the window handler instead of dying in the popover.
  if (e.key === 'F11' || e.key === 'F1') return
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

/** This display's object index — empty (or absent) means picking is off there. */
function objectIndexOf(index: number): ObjectIndex | null {
  return objectIndexes.get(index) ?? null
}

/** Whether ANY display of this board has something pickable RIGHT NOW. */
function hasObjectData(): boolean {
  for (const index of objectIndexes.values()) {
    if (index.size > 0) return true
  }
  return false
}

/**
 * Whether picking has anything to SAY, which is not the same question.
 *
 * With no observation at all — a non-Windows capture, a re-edited pack with no
 * plugin, a dump that never ran — picking is simply off and silence is the
 * truth. But a pack that HAS object data and is being scrubbed to a moment that
 * data does not cover has an empty index and a great deal to say: that is the
 * case the v0.1.7 gate existed for, and it is exactly the case where silence
 * would read as "picking is broken" (GOAL: "Silence is not absence").
 */
function objectPickingCanSpeak(): boolean {
  if (hasObjectData()) return true
  for (const frame of contextFramesByDisplay.values()) {
    if (frame.accuracy.coverage !== 'none') return true
  }
  return false
}

/**
 * Builds one display's index from the ContextFrame resolved at the time of the
 * frame THAT display actually presented. Core splits candidates into native
 * display spaces; claims and accuracy must come from the same temporal frame as
 * the selected slice.
 */
function buildObjectIndex(displayIndex: number, frame: ContextFrame): void {
  if (board === null) return
  const d = board.displays.find((display) => display.index === displayIndex)
  if (d === undefined) return
  const slice = frame.displays.find((candidate) => candidate.display === displayIndex)
  contextFramesByDisplay.set(displayIndex, frame)
  objectIndexes.set(
    displayIndex,
    ObjectIndex.build(
      slice?.candidates ?? [],
      slice?.surfaces ?? [],
      slice?.coverage ?? [],
      frame.claims,
      d.width,
      d.height,
      displayIndex,
    ),
  )
}

/** Initial/capture-instant frame: every native snapshot shows this one time. */
function buildObjectIndexes(frame: ContextFrame): void {
  objectIndexes.clear()
  contextFramesByDisplay.clear()
  if (board === null) return
  for (const d of board.displays) buildObjectIndex(d.index, frame)
}

/**
 * THE EDITOR RE-QUERIES AS THE SCRUB POSITION MOVES (#66).
 *
 * Debounced on SETTLE, not on every tick: a wheel burst is dozens of positions
 * and playback is sixty a second, and Core's answer for a position the user
 * left 16 ms ago is work nobody asked for. Hovering itself stays free — it
 * probes the local index, never Core.
 *
 * The frame in hand keeps answering while a new one is on its way, so picking
 * never blinks off mid-scrub; a stale-but-honest offer is corrected the moment
 * the new frame lands, and its accuracy is what says whether it was honest.
 */
const FRAME_SETTLE_MS = 120

/** The context clock of the pixels currently shown on every board display. */
function displayedContextFrameRequests(): Array<{ display: number; timeMs: number }> {
  if (scrub === null || board === null) return []
  return contextFrameRequestsForDisplays(
    scrub.atNow,
    replayDurationMs,
    board.displays.map((display) => ({
      display: display.index,
      hasReplay: replayDisplayIndices.has(display.index),
      presentedMs: scrub?.presentedMsFor(display.index) ?? replayDurationMs,
    })),
  )
}

function requestContextFrames(
  requests: readonly { display: number; timeMs: number }[],
): void {
  const sessionId = contextSessionId
  if (sessionId === null) return
  const wanted = requests
    .map((request) => ({
      display: request.display,
      timeMs: Math.max(0, Math.round(request.timeMs)),
    }))
    .filter((request) => frameTimesByDisplay.get(request.display) !== request.timeMs)
  if (wanted.length === 0) return
  // Most displays usually present the same pack instant. Query each UNIQUE
  // time once and reuse its frame slices, while still allowing a lagging slave
  // replay to request its own time.
  const displaysByTime = new Map<number, number[]>()
  for (const request of wanted) {
    const displays = displaysByTime.get(request.timeMs) ?? []
    displays.push(request.display)
    displaysByTime.set(request.timeMs, displays)
  }
  frameRequestSeq += 1
  const seq = frameRequestSeq
  void Promise.all(
    [...displaysByTime].map(async ([timeMs, displays]) => {
      try {
        const frame = await window.editorBridge.requestContextFrame({
          sessionId,
          timeMs,
        })
        return { displays, timeMs, frame }
      } catch (err) {
        // One display's object provider may never take the rest of the board
        // down with it. Its previous honest index stays in place.
        console.error(
          `capturepack: requesting display(s) ${displays.join(', ')} context frame failed:`,
          err,
        )
        return { displays, timeMs, frame: null }
      }
    }),
  )
    .then((answers) => {
      // A later request already answered: this one is history, and applying it
      // would move picking BACK in time.
      if (seq !== frameRequestSeq) return
      const resolved: Array<{ display: number; timeMs: number; frame: ContextFrame }> = []
      for (const answer of answers) {
        if (answer.frame === null) continue
        for (const display of answer.displays) {
          frameTimesByDisplay.set(display, answer.timeMs)
          resolved.push({ display, timeMs: answer.timeMs, frame: answer.frame })
        }
      }
      if (resolved.length > 0) applyDisplayContextFrames(resolved)
    })
    .catch((err: unknown) => {
      // Promise.all above catches every per-display request. This is only a
      // defensive boundary against an error in the composition itself.
      console.error('capturepack: composing display context frames failed:', err)
    })
}

/** Schedules a re-query for the position the scrub has settled on. */
function scheduleContextFrame(): void {
  if (contextSessionId === null || scrub === null) return
  if (frameSettleTimer !== null) window.clearTimeout(frameSettleTimer)
  frameSettleTimer = window.setTimeout(() => {
    frameSettleTimer = null
    if (scrub === null) return
    // "Now" is the capture instant, which is the END of the pack clock — the
    // native snapshot, not a video position.
    //
    // Otherwise ask for the time of the frame ON SCREEN, not the playhead's
    // (#81). A seek to T shows the last frame at or before T; asking the ring
    // for T instead returns where the window HAD GOT TO by then, and the box
    // lands beside the window the user can see. Measured in rc.4: the displayed
    // frame ran up to 498 ms behind the playhead, worth 1304 px on a dragged
    // window, while the boxes themselves were accurate to a median of 9 ms.
    requestContextFrames(displayedContextFrameRequests())
  }, FRAME_SETTLE_MS)
}

/** Shared repaint after either one full frame or per-display frame updates. */
function contextFramesApplied(frames: readonly ContextFrame[]): void {
  if (frames.some((frame) => frame.dropped)) {
    showObjectHintOnce('dropped', t('editor.objectDropped'))
  }
  // The sheet advertises the picking modifiers only where object data exists.
  if (helpOpen) buildHelpSheet()
  // A pointer already resting on an object must not have to move to find out
  // that the answer changed.
  hoverStack = []
  hoverStackIndex = 0
  reprobeObjectHover()
  schedulePaint()
}

/** A capture-instant frame applies to every display's native snapshot. */
function applyContextFrame(frame: ContextFrame): void {
  if (!loaded || board === null) {
    pendingContextFrame = frame
    return
  }
  buildObjectIndexes(frame)
  contextFramesApplied([frame])
}

/** Historical updates, each resolved at that display's presented frame time. */
function applyDisplayContextFrames(
  updates: readonly { display: number; frame: ContextFrame }[],
): void {
  if (!loaded || board === null) {
    for (const update of updates) {
      pendingDisplayContextFrames.set(update.display, update.frame)
    }
    return
  }
  for (const update of updates) buildObjectIndex(update.display, update.frame)
  contextFramesApplied(updates.map((update) => update.frame))
}

/** The topmost box under a native point of `d` — the one a click could take. */
function boxUnder(d: BoardDisplay, x: number, y: number): Annotation | null {
  const id = hitTest(visibleAnnotationsOn(d.index), x, y, uiOf(d))
  if (id === null) return null
  return state.byId(id) ?? null
}

/** Two rectangles that are the same object, within a pixel of rounding. */
function sameRect(b: Box, o: PickableObject): boolean {
  return (
    Math.abs(b.x - o.x) <= 1 &&
    Math.abs(b.y - o.y) <= 1 &&
    Math.abs(b.w - o.width) <= 1 &&
    Math.abs(b.h - o.height) <= 1
  )
}

/** Whether `a` is the box that already annotates exactly `picked`. */
function annotatesPick(a: Annotation, picked: PickableObject): boolean {
  const b = a.bounds
  if (sameRect({ x: b.x, y: b.y, w: b.width, h: b.height }, picked)) return true
  // The rect the box was SNAPPED to, which a resize may have moved it off.
  const snapped = pickedRects.get(a.annotation_id)
  return snapped !== undefined && sameRect(snapped, picked)
}

/**
 * A pick has to be a REAL refinement of the box to take its click: half its area
 * or less. A control within a hair of the box's own rectangle refines nothing,
 * and the box is the thing the user drew.
 */
const PICK_REFINE_RATIO = 2

/** Everything about the click (or hover) that decides box-vs-pick precedence. */
interface AimAt {
  x: number
  y: number
  /** 1 / on-screen scale of one native pixel — the grab band is screen-sized. */
  ui: number
  /** A repeat click (`PointerEvent.detail >= 2`): the second half of a gesture. */
  repeat?: boolean
}

/**
 * WHO TAKES THE CLICK when a pick and an existing box are both under the cursor.
 *
 * Both are real offers, and on a normal Windows desktop they overlap EVERYWHERE:
 * every pixel belongs to some window, so a box always has something pickable
 * under it. Neither may simply win.
 *
 *   The BOX wins when the user can still be aiming at it —
 *     · it is the SELECTED box (select, then drag to move / drag a corner to
 *       resize: the gesture this editor is built on, and the pick under it is
 *       one Esc away),
 *     · this is a REPEAT click (a double-click has to reach the box, or a box
 *       with anything under it could never have its text edited),
 *     · the pointer is on its OUTLINE (render.ts onBoxEdge) — a box is a
 *       rectangle drawn around something, so its stroke is always a grip on it,
 *     · or the pick is the object it already annotates / not meaningfully
 *       smaller than it.
 *   The PICK wins in the box's empty middle, where it genuinely refines it —
 *     one click per control inside an already-boxed window.
 *
 * Both halves are load-bearing. Letting the box win over its whole AREA turned
 * the first box ever drawn into a permanent hole in picking (snapping a window
 * box made every control in that window unpickable). Letting a smaller pick win
 * over the whole area cost the reverse: a committed window box could not be
 * selected, moved or resized anywhere inside itself, because every interior
 * pixel of it holds a smaller control.
 */
function pickBeatsBox(picked: PickableObject, a: Annotation, at: AimAt): boolean {
  // THE SELECTED BOX DOES NOT SWALLOW A REFINEMENT (bug: "앱 선택하고 내부
  // 컨트롤 클릭하면 박스가 안 그려져").
  //
  // This returned false for the selected box unconditionally, and the flow it
  // killed is the most natural one there is: pick a window — which SELECTS the
  // box it creates (commitTextEditor) — then click a control inside it. Every
  // interior click landed on the still-selected window box and moved it a few
  // pixels instead of drawing anything. The user had to know to press Esc
  // first, and nothing on screen says so.
  //
  // A MANUAL selected box keeps its whole interior: clicking inside it is the
  // move gesture, and a pick stealing that grab would trade one surprise for
  // another. A TRACKED selected box has no interior gesture to protect —
  // "Selected, never dragged, when Core owns the rectangle" (#99, the
  // pointerdown below) — so for it the gate defended nothing and cost the
  // refinement flow; it now applies the same area bar as every other box.
  if (a.annotation_id === state.selectedId && !coreOwnsGeometry(a)) return false
  if (at.repeat === true) return false
  if (onBoxEdge(a, at.x, at.y, at.ui)) return false
  if (annotatesPick(a, picked)) return false
  return picked.area * PICK_REFINE_RATIO <= Math.max(1, a.bounds.width * a.bounds.height)
}

/** Hover probe. Cheap by design: nothing happens until the pointer moves. */
function probeObjectHover(p: { d: BoardDisplay; x: number; y: number } | null): void {
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
  answerProbe(p.d, p.x, p.y)
}

/** The outline (and its one-time explanations) for one probed point. */
function answerProbe(d: BoardDisplay, x: number, y: number): void {
  const index = objectIndexOf(d.index)
  if (index === null || index.size === 0) {
    hoverStack = []
    hoverStackIndex = 0
    setHoverObject(null, null)
    // A SCREEN the dump had nothing for, on a board whose other screens do have
    // object data: hovering it is exactly when that is worth saying — the
    // outline that appears everywhere else simply never comes here, and silence
    // reads as "this screen's windows have no objects" (issue #30). With no data
    // anywhere, picking is off as a whole and silence is the truth.
    if (objectPickingCanSpeak()) {
      const answer = emptyAnswer(d)
      showObjectHintOnce(answer.kind, answer.text, 'answer')
    }
    return
  }
  // THE WHOLE STACK, not just the winner (#66): the first is what a click
  // takes, the rest is what Tab / Shift+Tab cycle through, and it is kept for
  // exactly as long as the pointer stays on this point.
  const stack = index.stackAt(x, y, windowLevelKey)
  hoverStack = stack.offered
  hoverStackIndex = 0
  offerHover(d, x, y)
  const next = hoverStack[0]
  // A point with more than one object on it is where Tab means something, and
  // a shortcut nobody is told about is a shortcut nobody has.
  if (next !== undefined && hoverStack.length > 1) {
    showObjectHintOnce('cycle', t('editor.objectCycle'))
  }
}

/**
 * Paints (and explains) whichever candidate of the current stack is on offer.
 * Split out of answerProbe because Tab moves through the stack WITHOUT
 * re-probing: re-probing would rebuild the stack and reset the cycle.
 */
function offerHover(d: BoardDisplay, x: number, y: number): void {
  const next = hoverStack[hoverStackIndex] ?? null
  // The PROBE runs over boxes too (that is what stops a box from shadowing
  // picking), but the outline must not promise a pick the click will not make:
  // where the box under the cursor wins, only the outline is suppressed.
  const box = next === null ? null : boxUnder(d, x, y)
  const shadowed =
    next !== null && box !== null && !pickBeatsBox(next, box, { x, y, ui: uiOf(d) })
  setHoverObject(shadowed ? null : next, shadowed ? null : d)
  // HOVER only ever describes an offer that IS on screen. "No object data here"
  // is an answer to an ACTION that failed, and merely sweeping the pointer over
  // wallpaper would otherwise fire it within seconds of every capture opening,
  // for a user who never touched object picking. The pointerdown path says it
  // when a click actually snapped nothing.
  if (next !== null && !shadowed) announceObject(next)
}

/**
 * TAB / SHIFT+TAB CYCLE THE OBJECTS AT A POINT (#66: "never discard the losing
 * candidates"). Wraps, because a cycle that stops at the end makes the user
 * work out how long the list was.
 */
function cycleHoverCandidate(delta: number): boolean {
  if (hoverStack.length < 2) return false
  const d = displayByIndex(lastProbeDisplay)
  if (d === null || lastProbeX < 0 || lastProbeY < 0) return false
  const count = hoverStack.length
  hoverStackIndex = (hoverStackIndex + delta + count) % count
  offerHover(d, lastProbeX, lastProbeY)
  return true
}

/** Re-probes the last point after the modifier (or the data) changed the answer. */
function reprobeObjectHover(): void {
  if (lastProbeX < 0 || lastProbeY < 0) return
  const d = displayByIndex(lastProbeDisplay)
  if (d === null) return
  answerProbe(d, lastProbeX, lastProbeY)
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
 * Honest feedback about an offer that IS on screen (GOAL). Picking is a
 * best-effort extra built on a dump that is budgeted, one instant old, and blind
 * to some windows — so every gap in what it can offer says so once.
 *
 * Order matters: the first hint that has not been shown yet wins the chip, and
 * staleness of the data beats anything about levels. The empty cases are not
 * here — they are answers to an action (emptyAnswer), not to a hover.
 */
function announceObject(o: PickableObject): void {
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
  if (objectHintsShown.has('windowModifier') || windowLevelKey) return
  const index = hoverDisplay === null ? null : objectIndexOf(hoverDisplay.index)
  if (index !== null && index.windowAt(o.x, o.y) !== null) {
    showObjectHintOnce('windowModifier', t('editor.objectWindowModifier'))
  }
}

/**
 * The honest answer for a point that offered NOTHING: this whole screen has no
 * object data, or the dump has data here and simply knows nothing about that
 * pixel. Two different statements, so two hint kinds (SPEC §11.3, "Silence is
 * not absence").
 */
function emptyAnswer(on: BoardDisplay): { kind: ObjectHintKind; text: string } {
  // FIRST, because it is the reason there is nothing to offer at all — and the
  // one the user cannot work out for themselves. Everything below is about
  // WHERE they clicked; this is about whether the data COVERS the moment on
  // screen, which is a property of the data and not of the playhead (#66,
  // design GAP 16). The v0.1.7 stopgap asked the clock; this asks the frame.
  const coverage = contextFramesByDisplay.get(on.index)?.accuracy.coverage ?? 'none'
  if (coverage === 'single-instant') {
    // Every pack written before v0.2.0: the dump describes the instant the
    // hotkey was pressed and nothing else, so scrubbing away leaves it with
    // nothing honest to say — and it says which, rather than looking broken.
    return { kind: 'singleInstant', text: t('editor.objectSingleInstant') }
  }
  if (coverage === 'before-start' || coverage === 'pruned' || coverage === 'degraded') {
    return { kind: 'uncovered', text: t('editor.objectUncovered') }
  }
  const index = objectIndexOf(on.index)
  if (index === null || index.size === 0) {
    return {
      kind: 'displayNoData',
      text: t('editor.objectDisplayNoData', { index: on.index }),
    }
  }
  return { kind: 'noData', text: t('editor.objectNoData') }
}

/** How long one hint holds the chip before the next queued one may have it. */
const OBJECT_HINT_MS = 6000

/**
 * TWO PRIORITIES, because a proactive tip must never cost a reactive answer its
 * slot — which is exactly what used to happen: the only feedback a refused click
 * had was the window-modifier TIP, whose one showing the hover path had almost
 * always consumed already, so the click was silent.
 *
 *   'tip'    — something the user COULD do (the Shift modifier, stale object
 *              data, picking being off for this capture). Queued behind whatever
 *              the chip is showing.
 *   'answer' — why what the user just did produced nothing. Pre-empts a tip in
 *              the chip immediately; the interrupted tip goes back to the FRONT
 *              of the queue, so nothing that is shown once is ever lost.
 */
type ObjectHintPriority = 'tip' | 'answer'

/**
 * Shows `text` in the hint chip if `kind` has not been said yet this session.
 *
 * QUEUED, never overwritten: every one of these is shown exactly once and can
 * never be re-shown, so a message replaced after half a second is lost
 * permanently. A hint raised while the chip is busy waits for it instead.
 */
function showObjectHintOnce(
  kind: ObjectHintKind,
  text: string,
  priority: ObjectHintPriority = 'tip',
): boolean {
  if (objectHintsShown.has(kind)) return false
  objectHintsShown.add(kind)
  showObjectHintText(text, priority)
  return true
}

/**
 * ALWAYS shown, whatever has been said before: the answer to an ACTION that just
 * produced nothing. A click that snapped no box must say why every time — a
 * user who tries again after the once-per-session hint has been spent would
 * otherwise be met with the silence this whole feature is meant to end.
 */
function showObjectAnswer(kind: ObjectHintKind, text: string): void {
  // Hovering need not repeat what the click has just said.
  objectHintsShown.add(kind)
  showObjectHintText(text, 'answer')
}

function showObjectHintText(text: string, priority: ObjectHintPriority): void {
  if (objectHintTimer === null) {
    displayObjectHint(text)
    return
  }
  if (priority === 'tip') {
    objectHintQueue.push(text)
    return
  }
  const interrupted = objectHint.textContent ?? ''
  window.clearTimeout(objectHintTimer)
  objectHintTimer = null
  if (interrupted !== '' && interrupted !== text) objectHintQueue.unshift(interrupted)
  displayObjectHint(text)
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
 * Puts `bounds` back on the object's rectangle at this box's representative
 * instant (#102) — the lifetime's midpoint, per SPEC §8.4.
 *
 * A no-op for a box with no track: a hand-drawn rectangle IS the answer, and
 * there is nothing to re-anchor it to.
 */
function reanchorBounds(a: Annotation): void {
  if (a.tracking?.enabled !== true) return
  // THE INSTANT THE USER PICKED IT, NOT THE MIDDLE OF ITS LIFETIME (#111).
  //
  // #102 anchored `bounds` to the lifetime's midpoint, which SPEC §8.4 calls
  // the representative instant. Correct for a box someone drew, wrong for a box
  // someone PICKED: extending the lifetime moves the midpoint, so the stored
  // rectangle walked away from the thing the user had clicked on. Measured on
  // CapturePack_2026-07-29_091123 — picked at 3656 ms where the window was at
  // (1814,684), extended to the end, and `bounds` ended up at (119,271), the
  // midpoint's rectangle, seventeen hundred pixels away.
  //
  // The pick instant is what the box MEANS. The track says where the object was
  // at every other moment, so nothing is lost by holding this one still.
  const at = trackedBoundsAt(a, pickedAtMs.get(a.annotation_id) ?? lifetimeMidpoint(a, replayDurationMs))
  if (at !== null) a.bounds = at
}

/**
 * The box that already annotates this object AT THIS MOMENT, if there is one.
 *
 * Matched on the surface the object IS (#90's stable id), not on its rectangle:
 * two clicks a few pixels apart on the same window are the same window, and a
 * window that has moved since is still the same window.
 */
function existingBoxFor(picked: PickableObject): Annotation | null {
  const identity = pickIdentityOf(picked)
  for (const a of state.annotations) {
    const existing = pickedObjectIdentities.get(a.annotation_id)
    if (existing === undefined || !samePickIdentity(existing, identity)) continue
    if (!annotationVisibleNow(a)) continue
    return a
  }
  return null
}

/**
 * Gives a freshly picked box the path of the object it names (#86).
 *
 * Asked once, for the box's own lifetime, and applied when it lands: the
 * request is a round trip and the box has to appear immediately. Until the
 * answer arrives the box behaves exactly as it did before tracking existed —
 * which is also what happens for good if Core has no path to offer.
 *
 * `endedAtMs` CLAMPS THE LIFETIME (#77). A box may not outlive the thing it
 * points at: past that moment it sits on whatever moved in behind, and neither
 * the picture nor the pack would say so. Shortening is the only direction this
 * ever moves an end — a user who wants less still gets less.
 */
/**
 * Which object each tracked box follows, by annotation id.
 *
 * Kept because a track is fetched for the box's lifetime AT THE MOMENT IT IS
 * PICKED, and the lifetime is routinely changed afterwards — "until the end" is
 * one click. Without this the path would still stop where the original
 * one-second default did, and the box would follow for a moment and then freeze
 * for the rest of its life. Measured on a real capture before this existed: a
 * box alive for 15.6 s carried 0.9 s of path.
 */
const trackedSurfaces = new Map<string, string>()

/**
 * Which exact object each snapped box names.
 *
 * trackedSurfaces remains the owner-window key used to request geometry, but
 * it is intentionally too coarse for duplicate detection: one surface can
 * contain hundreds of independently pickable controls.
 */
const pickedObjectIdentities = new Map<string, PickIdentity>()

/** The picked control's rectangle within its owner window, retained on refresh. */
const trackedControlAnchors = new Map<string, ControlTrackAnchor>()

/**
 * The replay instant each picked box was placed at (#111).
 *
 * Its lifetime moves — "until the end" is one click — but the moment the user
 * pointed at the object does not, and that moment is what the box means.
 */
const pickedAtMs = new Map<string, number>()

/**
 * The replay times the editor has actually SHOWN, most recent last (#113).
 *
 * Kept so the app can answer, for itself, the question every one of these
 * captures has been sent back and forth to settle: does a track's sample sit on
 * a frame, or between two? A sample was produced BY a frame, so the distance to
 * the nearest frame the editor has presented should be zero. Anything else is
 * the residual, in milliseconds, and it belongs in the log rather than in a
 * measurement someone has to run ffprobe for.
 */
const presentedTimes: number[] = []

/** Reports where a freshly fetched track sits relative to the frames on screen. */
/**
 * The first-run tutorial (GOAL "First-Run Tutorial").
 *
 * The editor is toolless on purpose: there is no palette naming the gestures,
 * so someone opening it for the first time has nothing to read. It says the
 * three of them once and then stays out of the way for good — a panel that
 * explains a five-second workflow must never be part of it twice.
 */
function openTutorial(): void {
  tutorialScrim.hidden = false
  tutorialGotIt.focus()
}

function closeTutorial(): void {
  if (tutorialScrim.hidden) return
  tutorialScrim.hidden = true
  // What the checkbox means is "never again", so the unchecked case leaves the
  // setting alone and the tutorial returns on the next capture. Written on
  // dismissal rather than on toggle: the state that matters is the one the
  // user left it in when they closed the panel.
  window.editorBridge.setTutorial(!tutorialDontShow.checked)
  overlay.focus()
}

function tutorialOpen(): boolean {
  return !tutorialScrim.hidden
}

tutorialGotIt.addEventListener('click', closeTutorial)
// Clicking the dimmed area behind it dismisses it the same way the button does;
// clicking the panel itself must not.
tutorialScrim.addEventListener('mousedown', (e) => {
  if (e.target === tutorialScrim) closeTutorial()
})

function reportTrackAlignment(samples: readonly { t_ms: number }[]): void {
  if (presentedTimes.length < 8 || samples.length === 0) return
  // MEASURED FROM THE PICTURES, NOT FROM THE SAMPLES (#93).
  //
  // The first version of this asked, for every sample, how far the nearest
  // SHOWN frame was — and reported -855 ms on a capture whose rendered output
  // was later measured correct to two pixels during a 5000 px/s drag. It was
  // not measuring sync. A user who picks at 11 s and drags the lifetime out to
  // 30 s has a track covering twenty seconds of replay they never played, and
  // samples out in that unwatched stretch have no nearby frame by construction.
  // The number was coverage wearing a sync number's clothes, which is worse
  // than no number at all.
  //
  // Turned around, it means something: for each frame this editor actually put
  // on screen, how far away was the nearest observation? In sync that is at
  // most half a sample interval, whatever the rate, and it cannot be inflated
  // by parts of the replay nobody looked at.
  const first = samples[0]!.t_ms
  const last = samples[samples.length - 1]!.t_ms
  const gaps: number[] = []
  let outside = 0
  for (const t of presentedTimes) {
    if (t < first || t > last) {
      // A frame from outside the track's span says nothing about alignment.
      outside += 1
      continue
    }
    let best = Number.POSITIVE_INFINITY
    for (const s of samples) {
      const d = s.t_ms - t
      if (Math.abs(d) < Math.abs(best)) best = d
    }
    if (Number.isFinite(best)) gaps.push(best)
  }
  if (gaps.length === 0) {
    console.info(
      `capturepack: track alignment — none of the ${presentedTimes.length} frames shown so far ` +
        `fall inside the track (${Math.round(first)}..${Math.round(last)} ms), so there is nothing to compare yet`,
    )
    return
  }
  gaps.sort((a, b) => a - b)
  const median = Math.round(gaps[gaps.length >> 1] ?? 0)
  const worst = Math.round(Math.abs(gaps[0]!) > Math.abs(gaps[gaps.length - 1]!) ? gaps[0]! : gaps[gaps.length - 1]!)
  console.info(
    `capturepack: track alignment — over ${gaps.length} frame(s) this editor has shown inside the track, ` +
      `the nearest observation sits a median of ${median} ms away (worst ${worst} ms; 0 is exact). ` +
      `${outside} shown frame(s) fell outside the track and were not counted`,
  )
}

/** Re-asks for the path over the box's CURRENT lifetime (see `trackedSurfaces`). */
function refreshTrack(a: Annotation): void {
  const surfaceId = trackedSurfaces.get(a.annotation_id)
  if (surfaceId !== undefined) {
    attachTrack(a, surfaceId, trackedControlAnchors.get(a.annotation_id) ?? null)
  }
}

/** One native annotation rectangle expressed in the board's common DIP space. */
function nativeRectOnBoard(d: BoardDisplay, b: AnnotationBounds): AnnotationBounds {
  const origin = toBoardPoint(d, b.x, b.y)
  return {
    x: origin.x,
    y: origin.y,
    width: b.width * (d.width > 0 ? d.bw / d.width : 1),
    height: b.height * (d.height > 0 ? d.bh / d.height : 1),
  }
}

/** A board-DIP rectangle projected into one display's native snapshot pixels. */
function boardRectOnDisplay(d: BoardDisplay, b: AnnotationBounds): AnnotationBounds {
  const sx = d.bw > 0 ? d.width / d.bw : 1
  const sy = d.bh > 0 ? d.height / d.bh : 1
  return {
    x: Math.round((b.x - d.bx) * sx),
    y: Math.round((b.y - d.by) * sy),
    width: Math.round(b.width * sx),
    height: Math.round(b.height * sy),
  }
}

/** The manifest/board geometry shared with authored-motion interpolation. */
function authoredMotionSpace(): AuthoredMotionSpace | undefined {
  if (board === null) return undefined
  return {
    focusedIndex: focusedDisplayIndex,
    displays: board.displays.map((d) => ({
      index: d.index,
      width: d.width,
      height: d.height,
      bounds: { x: d.bx, y: d.by, width: d.bw, height: d.bh },
    })),
  }
}

function setAnnotationDisplay(a: Annotation, index: number): void {
  if (index === focusedDisplayIndex) delete a.display
  else a.display = index
}

function attachTrack(
  draft: Annotation,
  surfaceId: string,
  controlAnchor: ControlTrackAnchor | null,
): void {
  if (contextSessionId === null) return
  const id = draft.annotation_id
  trackedSurfaces.set(id, surfaceId)
  if (controlAnchor === null) trackedControlAnchors.delete(id)
  else trackedControlAnchors.set(id, controlAnchor)
  const start = draft.start_ms ?? 0
  const end = draft.end_ms ?? replayDurationMs
  void window.editorBridge
    .requestObjectTrack({ sessionId: contextSessionId, surfaceId, startMs: start, endMs: end })
    .then((track) => {
      if (track === null) return
      // requestObjectTrack records the owner HWND. That IS the picked object
      // for a window, but it is only the moving coordinate frame for a control.
      // Copying those samples verbatim produced rc.36's exact contradiction:
      // target={level:"control", name:"..."} beside a window-sized bounds box.
      const samples =
        controlAnchor === null ? track.samples : projectControlTrack(track.samples, controlAnchor)
      if (samples.length < 2) return
      // The draft may have been committed, renamed or discarded while this was
      // in flight; the stored annotation is the one that matters.
      const live = state.byId(id) ?? (textSession?.kind === 'new' && textSession.draft.annotation_id === id ? textSession.draft : undefined)
      if (live === undefined) return
      // What an ABSENT sample display means for THIS box (SPEC §8.8): the box's
      // own screen, which is the focused one when the box does not name it.
      const ownDisplay = live.display ?? focusedDisplayIndex
      live.tracking = {
        enabled: true,
        // Recorded, not derived: a reader can now check `bounds` against the
        // track without guessing which instant the box was anchored at (#90).
        ...(pickedAtMs.has(id) ? { picked_at_ms: Math.round(pickedAtMs.get(id)!) } : {}),
        // WHICH SCREEN EACH SAMPLE IS MEASURED IN (#86). Dropping it here was
        // not a missing nicety: a window straddling two monitors changes which
        // display owns it as it crosses the middle, and its rectangle is then
        // pixels of the OTHER snapshot — different origin, and on this desk a
        // different scale too (1443x953 on the 1.5x screen is the same window as
        // 960x634 on the 1x one). Without the field those two spaces are mixed
        // in one list and nothing downstream can tell them apart, so the box
        // jumps between two readings of the same position.
        // Written only where it SAYS something: absent means the annotation's
        // own display (SPEC §8.3), so a capture whose object never left one
        // screen produces exactly the samples it did before this field existed.
        samples: samples.map((s) => ({
          t_ms: s.tMs,
          ...(s.display === ownDisplay ? {} : { display: s.display }),
          x: s.x,
          y: s.y,
          width: s.width,
          height: s.height,
        })),
      }
      if (track.endedAtMs !== null && live.end_ms !== undefined && live.end_ms > track.endedAtMs) {
        live.end_ms = Math.max(live.start_ms ?? 0, track.endedAtMs)
      }
      // `bounds` IS THE RECTANGLE AT THIS BOX'S OWN MOMENT (#102).
      //
      // SPEC §8.3 defines it that way and §8.4 says the moment is the lifetime's
      // MIDPOINT — but it was left as the rectangle the object had when the user
      // clicked, and the midpoint moves the instant the lifetime is changed.
      // Measured on CapturePack_2026-07-29_081922: `bounds` was (1784,608),
      // the object's rectangle at that box's own midpoint was (75,941), and
      // every reader that honours `bounds` — a 0.1.0 reader, our own still
      // renderer, report.md — placed the box 1709 px from the thing it names.
      //
      // So it is re-anchored from the track, which is the record of where the
      // object actually was. Nothing is estimated: this is the nearest OBSERVED
      // sample (#89), the same one the editor draws.
      reanchorBounds(live)
      reportTrackAlignment(live.tracking.samples ?? [])
      schedulePaint()
    })
    .catch((err: unknown) => {
      // Rule 1 of object data: a box that cannot follow is a box that does not
      // follow, never an editor that broke.
      console.error('capturepack: requesting an object track failed:', err)
    })
}

/**
 * Drops `target` once the box no longer covers the element it was picked from.
 * Called after a committed move or resize; a box that still contains the
 * picked rect's centre is considered to be annotating the same object.
 */
function invalidateTargetIfMoved(id: string): void {
  const a = state.byId(id)
  if (a === undefined) return
  // A HAND-MOVED BOX STOPS FOLLOWING (#86). The track describes where the
  // OBJECT went; once the user has put the box somewhere of their own choosing,
  // continuing to fly it along the object's path would move the box out from
  // under them at the next frame. The rectangle they placed is the answer.
  if (a.tracking?.enabled === true) a.tracking = { enabled: false }
  // ...and stays stopped. Without this, the next duration change would re-ask
  // for the path and put the box back on the object's rails, undoing the move
  // the user made by hand.
  trackedSurfaces.delete(id)
  pickedObjectIdentities.delete(id)
  trackedControlAnchors.delete(id)
  pickedAtMs.delete(id)
  if (a.target === undefined) return
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

/**
 * `target` for a picked object (SPEC §8.7): empty fields are never written.
 *
 * UIA and Core's window floor keep the established `source:"uia"` shape.
 * Other providers retain their own source and stable identity. That additive
 * target is what lets a Chrome DOM box remain semantic (blue and
 * geometry-owned) after save/reopen instead of silently becoming a manual
 * rectangle just because the editor process forgot its in-memory pick map.
 */
function annotationTargetOf(o: PickableObject): AnnotationTarget {
  if (o.providerId !== 'windows-uia' && o.providerId !== 'core') {
    const target: AnnotationTarget = {
      source: o.providerId,
      level: o.level,
      object_id: o.candidate.objectId,
    }
    const identity = o.candidate.identity ?? {}
    for (const key of ['selector', 'tag', 'dom_id', 'role', 'url', 'title']) {
      const value = (identity[key] ?? '').trim()
      if (value !== '') target[key] = value
    }
    const name = (o.candidate.name ?? '').trim()
    if (name !== '') target.name = name
    return target
  }
  const identity = o.candidate.identity ?? {}
  const target: UiaAnnotationTarget = { source: 'uia', level: o.level }
  const value = (key: string): string => (identity[key] ?? '').trim()
  if (o.level === 'window') {
    // A window target names the window, not a control: title + process are what
    // identify it to a human and to an AI reader.
    const title = value('title')
    const process = value('process')
    const className = value('class_name')
    if (title !== '') target.title = title
    if (process !== '') target.process = process
    if (className !== '') target.class_name = className
    return target
  }
  const name = value('name')
  const controlType = value('control_type')
  const automationId = value('automation_id')
  const className = value('class_name')
  if (name !== '') target.name = name
  if (controlType !== '') target.control_type = controlType
  if (automationId !== '') target.automation_id = automationId
  if (className !== '') target.class_name = className
  // The window a control lives in is context an AI reader cannot recover from
  // the control alone ("the Save button" — of which app?).
  const process = value('process')
  if (process !== '') target.process = process
  return target
}

// ---------------------------------------------------------------------------
// Pointer input: LEFT click selects / drags (move, corner-resize); RIGHT drag
// creates a box. No tool modes.
// ---------------------------------------------------------------------------

/**
 * Is this left press the SECOND (or third) of one multi-click gesture?
 *
 * Tracked here rather than read off `PointerEvent.detail`: the Pointer Events
 * spec defines `detail` as 0 for pointerdown, so the click count a `mousedown`
 * would carry cannot be relied on — and this decides whether a box or the
 * object under it takes the press, which the double-click-to-edit gesture
 * depends on. Same shape as every platform's own rule: soon enough, and close
 * enough, on screen.
 */
const REPEAT_CLICK_MS = 500 // the Windows double-click default
const REPEAT_CLICK_PX = 6 // screen px of slop, as forgiving as the box grab band
let lastClickMs = Number.NEGATIVE_INFINITY
let lastClickX = 0
let lastClickY = 0

function isRepeatClick(e: PointerEvent): boolean {
  const repeat =
    e.detail >= 2 ||
    (e.timeStamp - lastClickMs <= REPEAT_CLICK_MS &&
      Math.abs(e.clientX - lastClickX) <= REPEAT_CLICK_PX &&
      Math.abs(e.clientY - lastClickY) <= REPEAT_CLICK_PX)
  lastClickMs = e.timeStamp
  lastClickX = e.clientX
  lastClickY = e.clientY
  return repeat
}

/**
 * Keeps a box inside the display it belongs to (issue #74).
 *
 * A box's coordinates ARE that display's snapshot pixels (SPEC §8.2), so a
 * negative x is not a position in the space the annotation declares — it is a
 * number no reader can interpret, and `report.md` prints it as a fact. Found in
 * a pack the user made to report it: `box at (-202, 864)` on a 3840x2160
 * snapshot, its left border rendered off the screen entirely.
 *
 * The pointer is already clamped to the display (board.ts toNativePoint), but a
 * MOVE adds a delta: grab a box by its right edge, drag left past the screen,
 * and the pointer stops while the delta keeps pushing the origin negative.
 *
 * A box wider than its display keeps the inverted range, so it can still be
 * positioned to cover the screen rather than snapping to a corner.
 */
function clampBoxTo(b: { x: number; y: number; width: number; height: number }, d: BoardDisplay): void {
  const spanX = d.width - b.width
  const spanY = d.height - b.height
  b.x = spanX >= 0 ? Math.max(0, Math.min(b.x, spanX)) : Math.min(0, Math.max(b.x, spanX))
  b.y = spanY >= 0 ? Math.max(0, Math.min(b.y, spanY)) : Math.min(0, Math.max(b.y, spanY))
}

function applyResize(
  a: Annotation,
  handle: HandleId,
  px: number,
  py: number,
  d: BoardDisplay,
): void {
  const b = a.bounds
  const right = b.x + b.width
  const bottom = b.y + b.height
  // Every edge is clamped to the display as it moves (issue #74). Resizing is
  // the other way a box leaves its own coordinate space: the pointer stops at
  // the edge, but an opposite edge already outside it would stay there.
  if (handle === 'nw' || handle === 'sw') {
    b.x = Math.max(0, Math.min(px, right - MIN_SIZE))
    b.width = right - b.x
  } else {
    b.width = Math.max(MIN_SIZE, Math.min(px, d.width) - b.x)
  }
  if (handle === 'nw' || handle === 'ne') {
    b.y = Math.max(0, Math.min(py, bottom - MIN_SIZE))
    b.height = bottom - b.y
  } else {
    b.height = Math.max(MIN_SIZE, Math.min(py, d.height) - b.y)
  }
}

overlay.addEventListener('pointerdown', (e) => {
  if (!loaded) return
  // The MIDDLE button belongs to panning and to nothing else (issue #55). A
  // press only reaches here when the board CANNOT pan — the stage's capture
  // handler swallows the rest — and "nothing to pan" has to mean nothing
  // happens: not a paused replay, not a dismissed duration popover, and
  // certainly not a selection change.
  if (e.button === 1) return
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
  const repeat = isRepeatClick(e)
  // A REPEAT click is the second half of one gesture, and the pending box the
  // FIRST half opened was never asked for: "double-click a box to edit its
  // text" starts with a plain click, which — over a box with something pickable
  // under it — snaps a pick and opens its description. Committing that here
  // would file a junk annotation AND leave the dblclick handler editing THAT
  // instead of the box that was aimed at. Discarding it is what the user meant;
  // anything else pending (a right-drag box, a text edit) still commits.
  if (repeat && clickPickDraftId !== null && pendingDraft()?.annotation_id === clickPickDraftId) {
    cancelTextEditor()
  } else {
    commitTextEditor()
  }
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
  const sel = selectedPaintedAnnotation()
  if (sel !== null && !coreOwnsGeometry(sel) && displayIndexOf(sel) === hit.d.index) {
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
      // Grabbing a corner is not "leave this box": the description the
      // selection opened stays open, with its text still selected (issue #42).
      // commitTextEditor above closed it, so it is re-opened here rather than
      // left behind on the canvas.
      selectBox(sel.annotation_id, hit.d)
      return
    }
  }
  // LEFT CLICK: the box under the cursor and the UI object under it are BOTH
  // offers, and pickBeatsBox decides between them — the box keeps its outline,
  // its selected state and any repeat click; the pick gets the box's empty
  // middle, where it genuinely refines it. The object is probed even where a box
  // is: a box is hit over its whole AREA, so letting it shadow the probe turned
  // the first picked box into a permanent hole in picking.
  //
  // Shift is read from the EVENT, not from the tracked key state: a window that
  // has just regained focus with Shift already down never saw the keydown.
  const shiftChanged = windowLevelKey !== e.shiftKey
  windowLevelKey = e.shiftKey
  // The click takes whatever the hover is CURRENTLY OFFERING, which after a Tab
  // is not the first candidate any more (#66: the candidate stack is the
  // feature, not a debug view). Re-answer first when this point was never
  // probed — a click with no preceding pointermove, or one whose modifier the
  // probe never saw — so the outline and the click can never disagree.
  const probed =
    hit.d.index === lastProbeDisplay && p.x === lastProbeX && p.y === lastProbeY && !shiftChanged
  if (!probed) {
    lastProbeDisplay = hit.d.index
    lastProbeX = p.x
    lastProbeY = p.y
    answerProbe(hit.d, p.x, p.y)
  }
  const box = boxUnder(hit.d, p.x, p.y)
  const picked = hoverStack[hoverStackIndex] ?? null
  const pickWins =
    picked !== null && (box === null || pickBeatsBox(picked, box, { x: p.x, y: p.y, ui, repeat }))
  if (box !== null && !pickWins) {
    // The box takes the click: select it and start the move drag, exactly as
    // this editor always did. A pick it refused is a real refusal, so it gets
    // its own one-time chip rather than looking like nothing was there — but
    // only where the refusal could SURPRISE. A box the user has already
    // selected, and the second click of a double-click, are aimed at the box by
    // definition, and explaining those would be nagging about a gesture that
    // did exactly what it looked like.
    if (
      picked !== null &&
      !repeat &&
      box.annotation_id !== state.selectedId &&
      !annotatesPick(box, picked)
    ) {
      showObjectHintOnce('boxTookClick', t('editor.objectBoxTookClick'), 'answer')
    }
    // Selected, never dragged, when Core owns the rectangle (#99).
    if (!coreOwnsGeometry(box)) {
      overlay.setPointerCapture(e.pointerId)
      // The moment being authored is the frame ON SCREEN for this display, not
      // the playhead (#81): the user is placing the box over what they can see.
      const atMs = presentedOn(hit.d.index)
      // Established BEFORE the first pointermove, because for a box that
      // already has motion the drag has to move that keyframe rather than
      // `bounds` — otherwise the drawn position would be recomputed from the
      // untouched keyframes and the box would sit still under the cursor.
      //
      // Seeded with where the box IS at this moment, which for a box that
      // already moves is its interpolated position and not `bounds` (that is
      // the rectangle at its representative instant, somewhere else entirely).
      // A keyframe inserted mid-drag must start under the pointer.
      const painted = resolveForBoard(box)
      const keyframe = setKeyframe(
        box,
        atMs,
        painted.bounds,
        hit.d.index,
        displayIndexOf(box),
      )
      const pointerBoard = toBoardPoint(hit.d, p.x, p.y)
      drag = {
        kind: 'move',
        d: hit.d,
        id: box.annotation_id,
        lastBx: pointerBoard.x,
        lastBy: pointerBoard.y,
        boardBounds: nativeRectOnBoard(hit.d, painted.bounds),
        before: state.cloneAnnotations(),
        moved: false,
        keyframe,
        atMs,
      }
    }
    // Selecting a box opens its description with the text selected (issue
    // #42): the click that starts a move is also the click that says "this
    // box", and typing must land in it without a second click into the text.
    // The move drag below never touches focus, and #overlay's mousedown
    // handler suppresses the focus mousedown would otherwise steal back.
    selectBox(box.annotation_id, hit.d)
    syncLanes()
    schedulePaint()
    return
  }
  // No box takes this click. Pick the real UI object under the cursor (GOAL
  // "Static object picking") — the smallest control, or the window itself when
  // there is no control (or Shift is held).
  //
  // A WINDOW-level pick is a PICK, with or without a modifier and whatever was
  // selected. It used to defer to "click empty space clears the selection"
  // whenever anything was selected, which on a tiled desktop (where every pixel
  // belongs to some window) meant a plain click could not pick a window at all —
  // the single most common thing there is to annotate.
  //
  // What that costs, said plainly: on a desk where every pixel belongs to some
  // window, there is NO empty canvas left, so clearing the selection by clicking
  // beside a box is gone — a click there picks. Esc clears the selection from
  // anywhere and is the gesture to reach for; the click below still clears it
  // over a point no window covers (objects.ts never offers the desktop), which
  // is a bare desktop, not a normal one.
  state.selectedId = null
  if (pickWins && picked !== null) {
    beginPendingBox(hit.d, { x: picked.x, y: picked.y, w: picked.width, h: picked.height }, picked)
    // Remembered so the SECOND click of a double-click can discard it (above)
    // rather than committing a box nobody asked for.
    clickPickDraftId = pendingDraft()?.annotation_id ?? null
  } else if (objectPickingCanSpeak()) {
    // The click snapped nothing (it still did what it always did: cleared the
    // selection). Say why — EVERY time, under the kind that belongs to this
    // refusal. Gated on picking having anything to say at all: with no
    // observation, picking is simply OFF and silence is the truth; with an
    // observation that does not cover this moment, the refusal is the answer.
    const answer = emptyAnswer(hit.d)
    showObjectAnswer(answer.kind, answer.text)
  }
  syncLanes()
  schedulePaint()
})

overlay.addEventListener('pointermove', (e) => {
  if (!drag) {
    if (loaded) syncHoverCursor(e)
    return
  }
  if (drag.kind === 'draw') {
    const p = pointOn(drag.d, e)
    drag.x = p.x
    drag.y = p.y
  } else if (drag.kind === 'move') {
    const point = toBoardUnits(e)
    const a = state.byId(drag.id)
    if (a && point !== null && (point.x !== drag.lastBx || point.y !== drag.lastBy)) {
      drag.boardBounds.x += point.x - drag.lastBx
      drag.boardBounds.y += point.y - drag.lastBy
      const target =
        board === null ? drag.d : (displayAtBoardPoint(board, point.x, point.y) ?? drag.d)
      const moving = boardRectOnDisplay(target, drag.boardBounds)
      // The endpoint is a rectangle in TARGET-display pixels. Clamping there
      // keeps the authored data valid while still allowing the gesture to cross
      // the seam; the board-space copy is then synchronized to that clamp so
      // the next pointer delta cannot reintroduce an off-screen origin.
      clampBoxTo(moving, target)
      drag.boardBounds = nativeRectOnBoard(target, moving)
      if (drag.keyframe >= 0) {
        moveKeyframe(a, drag.keyframe, moving, target.index)
      } else {
        a.bounds = moving
        setAnnotationDisplay(a, target.index)
      }
      drag.d = target
      drag.moved = true
    }
    if (point !== null) {
      drag.lastBx = point.x
      drag.lastBy = point.y
    }
    // The description of the box being dragged is open (issue #42) and anchors
    // to bounds that just moved: it rides along instead of being left behind.
    positionTextEditor()
  } else {
    const p = pointOn(drag.d, e)
    const a = state.byId(drag.id)
    if (a) {
      applyResize(a, drag.handle, p.x, p.y, drag.d)
      drag.moved = true
    }
    positionTextEditor()
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
    // `bounds` goes back to meaning the box's rectangle at its representative
    // instant (SPEC §8.4, §8.9), so a reader that ignores `keyframes` still
    // draws it somewhere the box genuinely is. Cheap, and only for a box that
    // actually carries motion.
    const moved = state.byId(d.id)
    if (moved) syncBoundsToRepresentative(moved, replayDurationMs, authoredMotionSpace())
    state.pushUndoSnapshot(d.before)
  } else if (d.kind === 'move' && d.keyframe >= 0) {
    // A press that authored a keyframe and then never moved has added a
    // rectangle identical to the one already there. Taking it back keeps a
    // click from quietly growing the pack — and keeps "this box has motion"
    // meaning the user actually moved it somewhere.
    const touched = state.byId(d.id)
    if (touched) {
      removeKeyframeAt(touched, d.atMs, focusedDisplayIndex)
      syncBoundsToRepresentative(touched, replayDurationMs, authoredMotionSpace())
    }
  }
  schedulePaint()
  updateDirty() // move/resize commits bypass refresh()
}

overlay.addEventListener('pointerup', endDrag)
overlay.addEventListener('pointercancel', endDrag)

// Double-click a box to edit its text inline (Enter applies, Esc abandons).
// Since issue #42 the FIRST click already does this, so what is left here is
// making the gesture land on the same box when the double-click's own second
// press was answered by something else (a repeat click discarding a click-pick
// draft), and doing it through the one selection path.
overlay.addEventListener('dblclick', (e) => {
  if (!loaded || e.button !== 0) return
  const hit = pointAt(e)
  if (hit === null) return
  const id = hitTest(visibleAnnotationsOn(hit.d.index), hit.x, hit.y, uiOf(hit.d))
  if (id === null) return
  if (state.byId(id) === undefined) return
  e.preventDefault()
  selectBox(id, hit.d)
  syncLanes()
  schedulePaint()
})

/**
 * The answer the last idle-hover probe gave — 'move', a resize arrow, or
 * 'default'. Remembered because the pan modifier OVERRIDES the overlay's cursor
 * while it is held, and letting go has to put THIS back rather than a bare arrow
 * (issue #55): the pointer has not moved, so no probe is coming to re-answer it,
 * and a box sitting right under the cursor would stop advertising that it can be
 * dragged until the user jiggled the mouse.
 */
let hoverCursor = 'default'

/** Applies an idle-hover answer and records it for syncPanCursor to restore. */
function setHoverCursor(cursor: string): void {
  hoverCursor = cursor
  overlay.style.cursor = cursor
}

/** Idle-hover cursor: resize arrows over handles, move over a box, else default. */
function syncHoverCursor(e: PointerEvent): void {
  // Space is the PAN MODIFIER only where panning is possible, which is exactly
  // what the pan handler requires — and at the zoom the editor opens in it is
  // not. Returning on `spaceDown` alone killed the hover probe while a click at
  // the same moment still picked, so hover and click disagreed about Space.
  if (spaceDown && viewport.panEnabled) return // pan cursor owns the stage
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
    // A board point NO captured display covers: the gap between two screens,
    // and equally the empty band above or below a shorter one (screens of
    // different heights are the common desk, so "between displays" would be a
    // lie there). It belongs to no display, so there is nothing to hover,
    // nothing to pick and nothing a click could snap. Said once, because a
    // pointer that finds no outline there is otherwise indistinguishable from
    // picking being broken.
    setHoverCursor('default')
    probeObjectHover(null)
    if (board !== null && board.displays.length > 1 && hasObjectData()) {
      showObjectHintOnce('gutter', t('editor.objectGutter'), 'answer')
    }
    return
  }
  const ui = uiOf(hit.d)
  const sel = selectedPaintedAnnotation()
  if (sel !== null && !coreOwnsGeometry(sel) && displayIndexOf(sel) === hit.d.index) {
    const handle = handleAt(sel, hit.x, hit.y, ui)
    if (handle !== null) {
      setHoverCursor(handle === 'nw' || handle === 'se' ? 'nwse-resize' : 'nesw-resize')
      probeObjectHover(null)
      return
    }
  }
  // The PROBE runs wherever the pointer is, boxes included: it is the probe that
  // decides who would take the click, and skipping it over a box is what made
  // every picked box a permanent hole in picking. The cursor follows that same
  // answer — 'move' only where the box really would take the click.
  probeObjectHover(hit)
  const box = boxUnder(hit.d, hit.x, hit.y)
  const pickWins =
    hoverObject !== null &&
    (box === null || pickBeatsBox(hoverObject, box, { x: hit.x, y: hit.y, ui }))
  setHoverCursor(
    box !== null && !pickWins && !coreOwnsGeometry(box) ? 'move' : 'default',
  )
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
      (target.closest('#topbar') ||
        target.closest('#durationEditor') ||
        target instanceof HTMLInputElement)
    ) {
      return // wheel over the top bar, a popover, or an inline input is not a scrub
    }
    e.preventDefault()
    if (e.ctrlKey || e.metaKey) {
      viewport.zoomAt(e.clientX, e.clientY, e.deltaY < 0, zoomCeiling())
      markViewNavigated()
      syncPanCursor()
      schedulePaint() // stroke/handle sizes are zoom-dependent
      syncZoomUi() // the top-bar control mirrors the gesture, always
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

// ANY pointer press while Space is held ends the play/pause tap, whatever that
// press turns out to be. The pan handler below cannot be the one to clear it:
// it returns early while `panEnabled` is false — and `panEnabled` is false in
// the state the editor OPENS in (fit zoom, no pan), so the very gesture the
// shortcut sheet advertises, performed at the default zoom, would otherwise
// start playback on release. Same for a Space-held right-drag or a drag on the
// timebar, neither of which reaches the stage handler at all.
window.addEventListener(
  'pointerdown',
  () => {
    if (spaceDown) spaceTap = false
  },
  { capture: true },
)

/**
 * Whether this press is a pan: Space held with the LEFT button, or the MIDDLE
 * button on its own (GOAL "Editor Input System", issue #55 — the one-handed
 * gesture every image and map viewer has). Both need something to pan: on a
 * fully fitted board there is nothing to move, so the press is left to whatever
 * else wants it rather than swallowed.
 */
function isPanPress(e: PointerEvent): boolean {
  if (!viewport.panEnabled) return false
  // Never mid-box. A mouse gives every button the same pointerId, so taking
  // capture here would redirect the RIGHT-drag's own pointerup to the stage and
  // leave the box being drawn hanging, uncommitted, forever.
  if (drag !== null) return false
  return (e.button === 0 && spaceDown) || e.button === 1
}

// Pan, captured on the stage so it wins over box interactions — a middle-button
// press must never start a box, never move one, and never clear the selection,
// so it can never be allowed to reach the overlay's own pointerdown.
stage.addEventListener(
  'pointerdown',
  (e) => {
    if (!isPanPress(e)) return
    e.preventDefault()
    e.stopPropagation()
    panning = { pointerId: e.pointerId, x: e.clientX, y: e.clientY }
    // Pointer capture, so a drag that leaves the window still tracks and still
    // ENDS — the button is released out there and pointerup would otherwise
    // never arrive, leaving the board glued to the cursor.
    stage.setPointerCapture(e.pointerId)
    syncPanCursor()
  },
  { capture: true },
)

// Chromium answers a middle press with AUTOSCROLL — the little four-way scroll
// widget — and it is the MOUSE event that carries that default action.
//
// This is for the presses that are NOT pans. When a pan starts, the handler
// above already calls preventDefault() on the pointerdown, and a cancelled
// pointerdown suppresses its compatibility mousedown outright, so this listener
// never even runs. What is left is exactly the middle presses isPanPress()
// turns down — a board with nothing to pan (the zoom the editor OPENS at) and a
// press arriving mid-box-drag — where nothing else would stop the widget from
// appearing over the capture.
//
// Stage only, middle button only, so nothing else about the wheel changes:
// rotating it still scrubs the clock and Ctrl+wheel still zooms (issue #55).
stage.addEventListener('mousedown', (e) => {
  if (e.button === 1) e.preventDefault()
})
// A middle press that never moved must do NOTHING — not paste, not scrub, not
// select. `auxclick` is the click the middle button fires; nothing in the
// editor listens for it, so cancelling it only removes what the platform would
// have added.
stage.addEventListener('auxclick', (e) => {
  if (e.button === 1) e.preventDefault()
})
stage.addEventListener(
  'pointermove',
  (e) => {
    if (!panning || e.pointerId !== panning.pointerId) return
    e.stopPropagation()
    viewport.panBy(e.clientX - panning.x, e.clientY - panning.y)
    markViewNavigated()
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
  // `grab` is the STANDING offer (Space is held and there is something to move);
  // `grabbing` says a pan is happening, which is equally true of the
  // middle-button drag that has no modifier to advertise (issue #55).
  const canPan = spaceDown && viewport.panEnabled
  const cursor = panning !== null ? 'grabbing' : canPan ? 'grab' : ''
  stage.style.cursor = cursor
  // #overlay covers the whole board and carries its OWN hover cursor (move,
  // resize arrows), so the stage's would never be seen over the very pixels
  // being panned. Overridden while a pan is possible or in progress, and on
  // release the LAST HOVER ANSWER goes back — not 'default'. Releasing Space (or
  // the middle button) over a box does not move the pointer, so nothing would
  // re-probe: a plain 'default' left an arrow sitting on a box the user can drag
  // until they jiggled the mouse (issue #55).
  overlay.style.cursor = cursor !== '' ? cursor : hoverCursor
}

// ---------------------------------------------------------------------------
// Keyboard: Enter save, Esc cancel-current/close, F1 shortcuts, Ctrl+Z/Y,
// Delete, C color, I/O trim, Space play (held: pan) — the sheet documents them.
// ---------------------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  // The tutorial is modal, so it answers keys before anything else can: Enter,
  // Escape and Space all mean "got it". Nothing behind it is reachable while
  // it is up, which is the point — a first-time user pressing keys at random
  // should not be editing a capture they have not read about yet.
  if (tutorialOpen()) {
    if (e.key === 'Enter' || e.key === 'Escape' || e.key === ' ') {
      e.preventDefault()
      closeTutorial()
    }
    // Tab still moves between the checkbox and the button.
    if (e.key !== 'Tab') e.preventDefault()
    return
  }
  // F11 toggles windowed/fullscreen from ANYWHERE in the editor (GOAL "Editor
  // Window Mode"): it is never an editing key (nor a composition key), so it is
  // answered FIRST — before the inline-input, unsaved-bar and typing gates
  // below. The inline inputs stopPropagation their keydowns, so they forward
  // this one explicitly (see their handlers).
  // F1 opens/closes the shortcut sheet (GOAL "Editor Chrome"), from anywhere
  // and for the same reason F11 is answered here: it is never an editing key,
  // and "press F1 for the shortcuts" has to hold while typing a description.
  if (e.key === 'F1') {
    e.preventDefault()
    toggleHelp()
    return
  }
  // Inline inputs own their keys (their handlers stopPropagation; the contains
  // check covers focus landing on the duration editor's buttons).
  if (e.isComposing || e.target === textEditor) return
  if (e.target instanceof Node && durationEditor.contains(e.target)) return
  if (e.target instanceof Node && numberPicker.contains(e.target)) return
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
    // Cancel-current first: the duration editor, then a pending box, then the
    // unsaved-changes bar, then an active selection. A bare Esc with nothing in
    // progress closes the editor — except in edit mode with unsaved changes,
    // where it opens the [Save] [Save As New CapturePack] [Discard] bar instead
    // of discarding.
    //
    // DISPLAY FRAMING IS NOT A RUNG (issue #53). Framing one display with 1..9
    // is a VIEW state, exactly like zoom and pan, and Esc undoes neither of
    // those; the key that fits the whole board (`, the key left of 1) is the
    // way back. Giving a view state its own rung also stole the press users
    // expect to close the editor — leaving took two.
    //
    // The shortcut sheet is deliberately NOT in this ladder (GOAL "Editor
    // Chrome": "no Esc handling"). It is a passive layer that may be left open
    // for the whole session, so answering Esc would cost every user a second
    // press to close the editor for a panel they were not interacting with.
    if (numberPickerOpen) {
      closeNumberPicker()
      return
    }
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
  // TAB / SHIFT+TAB CYCLE THE CANDIDATES AT THE HOVERED POINT (#66: the losing
  // candidates are kept, and this is what they are kept FOR).
  //
  // Only taken when there IS a stack of more than one under the pointer, and
  // never while typing (the gates above already returned) — so Tab keeps
  // reaching the top bar's controls for a keyboard user everywhere else, which
  // is the one thing this must not cost.
  if (e.key === 'Tab' && cycleHoverCandidate(e.shiftKey ? -1 : 1)) {
    e.preventDefault()
    return
  }
  if (e.key === ' ') {
    // A FOCUSED CONTROL owns Space: on a button it is that button's native
    // activation, and a keyboard user pressing Space on [?] or [Save] must get
    // the button — not the pan modifier, and certainly not playback, which
    // moves the clock and with it the frame snapshot.png is composed from. The
    // top bar as a whole is excluded for the same reason (the zoom slider is
    // not a button). Space belongs to the canvas, and only to the canvas.
    if (e.target instanceof HTMLElement && e.target.closest('button, #topbar') !== null) return
    // Space is the pan modifier; keep it away from page scrolling.
    e.preventDefault()
    if (!spaceDown) {
      spaceDown = true
      spaceTap = true // until a pan starts, this press is still a play/pause tap
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
  // PIN THE SELECTED BOX'S NUMBER (SPEC §8.5). Alt, because bare 1..9 already
  // frames a captured display and that binding is older, documented, and used
  // one-handed while panning — taking it would be a silent regression for a
  // multi-display user. Matched on `e.code` so it follows the PHYSICAL key: Alt
  // +1 produces different characters on different layouts, and the sheet
  // advertises the digits, not whatever the layout makes of them. Alt+0 goes
  // back to automatic, the same "0 resets" idiom the board fit already uses.
  if (e.altKey && !e.ctrlKey && !e.metaKey && headerAnnotation() !== null) {
    const digit = /^Digit([0-9])$/.exec(e.code)
    if (digit !== null) {
      e.preventDefault()
      const n = Number(digit[1])
      setSelectedNumberPin(n === 0 ? null : n)
      return
    }
  }
  if (e.altKey) return
  // Board navigation (GOAL "Multi-Monitor Support"): 1..9 frames one captured
  // display at the largest usable scale, and the key LEFT OF 1 fits the whole
  // board again. Free keys — the editor is toolless, so digits were never a
  // tool selector.
  //
  // Fit is bound to the PHYSICAL key (`e.code === 'Backquote'`), not to the
  // character it produces: it sits next to 1..9 so the whole group is under one
  // hand, and that is only true if the binding follows the key rather than the
  // layout — the same physical key types ` on US, ² on AZERTY, ^ on a German
  // board. The literal backtick is accepted too (layouts that put it
  // elsewhere), and so is 0, which is where this lived until issue #41: there
  // is no reason to break the muscle memory of anyone who already has it.
  if (board !== null && board.displays.length > 1) {
    // Unmodified only, exactly like the 1..9 branch below (where Shift+1 types
    // ! and no longer matches). Shift+` is ~ on a US/Korean board and something
    // else again elsewhere; the sheet advertises "` / 0" precisely, so binding
    // the shifted key too would be an undocumented shortcut on a combination
    // the sheet describes.
    if (!e.shiftKey && (e.code === 'Backquote' || e.key === '`' || e.key === '0')) {
      e.preventDefault()
      fitBoard()
      return
    }
    if (/^[1-9]$/.test(e.key)) {
      e.preventDefault()
      zoomToDisplay(Number(e.key))
      return
    }
  }
  switch (e.key.toLowerCase()) {
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
    // AUTHORED MOTION HAS TO BE REMOVABLE (SPEC §8.9). A drag can add a
    // keyframe; without this the only way to take one back is undo, which also
    // takes back everything else done since. K drops the keyframe at the frame
    // on screen, and dropping the second-to-last drops the motion entirely —
    // one authored position is not motion, so the box becomes a plain
    // rectangle again where it currently sits.
    case 'k':
      removeSelectedKeyframe()
      break
  }
})

/**
 * Drops the selected box's keyframe at the frame on screen, if it has one.
 *
 * SILENT WHEN THERE IS NOTHING THERE, and that is legible rather than mute: the
 * timebar draws a mark at every keyframe of the selected box, so whether the
 * playhead is on one is visible before the key is pressed. A transient toast
 * would say less, later.
 */
function removeSelectedKeyframe(): void {
  const selected = state.selectedId === null ? undefined : state.byId(state.selectedId)
  if (selected === undefined || coreOwnsGeometry(selected) || !hasMotion(selected)) return
  const atMs = presentedOn(displayIndexOf(selected))
  if (keyframeIndexAt(selected, atMs) < 0) return
  applyMutation((box) => {
    removeKeyframeAt(box, atMs, focusedDisplayIndex)
    syncBoundsToRepresentative(box, replayDurationMs, authoredMotionSpace())
  })
  syncLanes()
  schedulePaint()
}

window.addEventListener('keyup', (e) => {
  if (e.key === ' ') {
    // A press that never panned is a PLAY/PAUSE tap. `spaceDown` gates it on
    // the keydown having been accepted at all, so a space typed into the pack
    // title or a box description never reaches playback.
    const tapped = spaceDown && spaceTap
    spaceDown = false
    spaceTap = false
    panning = null
    syncPanCursor()
    if (tapped) scrub?.togglePlay()
  }
  if (e.key === 'Shift' && windowLevelKey) {
    windowLevelKey = false
    reprobeObjectHover()
  }
})

window.addEventListener('blur', () => {
  spaceDown = false
  // The keyup will never arrive: this press ends here, and silently — a window
  // switch is not a play command.
  spaceTap = false
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

exportBtn.addEventListener('click', () => void doExport())


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
  // A box selected from the timebar is a box selected (issue #42): its
  // description opens with the text selected, exactly as a click on the canvas
  // does. The scrub happens FIRST so the input is positioned over the box at
  // the moment it is actually visible.
  selectAnnotation: (id) => {
    const a = state.byId(id)
    if (!a) return
    if (scrub) scrub.scrubTo(lifetimeMidpoint(a, scrub.durationMs))
    selectBox(id)
    syncLanes()
    schedulePaint()
  },
  // Trim handle drags (GOAL "Replay Trim"): fraction of the track -> ms.
  //
  // A TRIM HANDLE EDITS THE RANGE, NOT THE FRAME. planTrimDrag requests no
  // preview seek, so moving either end while the current frame remains kept
  // cannot drag the playhead or a selected moving box along with it. If a
  // scrubbed frame is genuinely cut away, syncTrim/setRange performs the one
  // necessary clamp. The native capture frame stays native by design.
  trimTo: (kind, fraction) => {
    if (!scrub) return
    const plan = planTrimDrag({
      kind,
      requestedMs: fraction * scrub.durationMs,
      durationMs: scrub.durationMs,
      currentMs: scrub.atNow ? scrub.durationMs : scrub.tMs,
      inMs: trimInMs,
      outMs: trimOutMs,
      minGapMs: TRIM_MIN_GAP_MS,
    })
    trimInMs = plan.inMs
    trimOutMs = plan.outMs
    syncTrim()
    if (plan.previewMs !== null) scrub.scrubTo(plan.previewMs)
  },
  trimDragStart: () => {
    trimDragWasAtNow = scrub?.atNow ?? false
  },
  trimDragEnd: () => {
    if (trimDragWasAtNow) scrub?.toNow()
    trimDragWasAtNow = false
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

/**
 * The exported frame's position, or null for the capture instant ("now").
 *
 * Clamped onto the MANIFEST replay clock, which is the clock payloadTrim()
 * reports the trim range on: the parsed webm clock can run a few ms past
 * replay_duration_ms (the same overrun every lifetime stamp is capped for), and
 * a position past the clamped out point would be dropped to null when main
 * rebases it onto the trimmed clock — turning a mid-replay frame into a claim
 * that the still is the native capture instant.
 */
function exportSnapshotTMs(): number | null {
  const ms = scrub?.exportTMs() ?? null
  if (ms === null) return null
  return Math.max(0, Math.min(ms, replayDurationMs))
}

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
      // On the SAME clock payloadTrim() reports the range on (the manifest's
      // replay_duration_ms): the parsed video clock can run slightly past it, and
      // a position outside the trim it was derived from would be rebased away to
      // null main-side — i.e. the pack would claim "this is the capture instant"
      // (SPEC §5.3) for a mid-replay frame.
      snapshotTMs: exportSnapshotTMs(),
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
  captureKind = payload.captureKind
  hasReplay = payload.hasReplay
  oneToOneBtn.hidden = captureKind !== 'image'
  // Recorders that were not running when the trigger fired (GOAL "Say that you
  // are recording"): keyed by board/manifest display index, so both the chip
  // and every display caption can name the reason.
  replayUnavailableReasons.clear()
  replayDisplayIndices.clear()
  const focusedInitIndex = payload.displays.find((d) => d.focused)?.index ?? 1
  if (payload.replayWebm !== null) replayDisplayIndices.add(focusedInitIndex)
  if (payload.replayUnavailableReason !== null) {
    replayUnavailableReasons.set(focusedInitIndex, payload.replayUnavailableReason)
  }
  for (const d of payload.displays) {
    if (!d.focused && d.replayWebm !== null) replayDisplayIndices.add(d.index)
    if (d.replayUnavailableReason !== null) {
      replayUnavailableReasons.set(d.index, d.replayUnavailableReason)
    }
  }
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
  pickedObjectIdentities.clear()
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
  // After applyDomI18n and the title prefill: a re-edited pack opens with its
  // own name on the windowed title bar, a fresh capture with the app's.
  syncTitleBar()
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
  // OBJECT PICKING (#66): ONE index per captured display over the candidates
  // Core resolved for the CAPTURE INSTANT, which is where the editor opens.
  // Windows are the floor, controls the refinement, each in that display's own
  // snapshot coordinate space (SPEC §11.3). No session (or an empty frame)
  // yields empty indexes and picking stays silently off.
  contextSessionId = payload.context?.sessionId ?? null
  frameTimesByDisplay.clear()
  if (payload.context !== null) {
    buildObjectIndexes(payload.context.frame)
    for (const display of board?.displays ?? []) {
      frameTimesByDisplay.set(display.index, payload.context.frame.requestedTimeMs)
    }
  }
  resizeCanvases()
  loaded = true
  drawAllFrozen()
  // The chip is the first thing a capture says about its replay. "No replay" on
  // its own reads like a property of the capture; when the buffer was not
  // running it is a FAILURE, so the reason is named and the chip is styled as
  // the warning it is (GOAL "Say that you are recording").
  const focusedFailure = payload.replayUnavailableReason
  replayChip.classList.toggle(
    'warn',
    captureKind === 'video' && focusedFailure !== null,
  )
  replayChip.textContent =
    captureKind === 'image'
      ? t('editor.imageCapture')
      : hasReplay
        ? t('editor.replaySeconds', { seconds: Math.round(payload.replayDurationMs / 1000) })
        : focusedFailure === null
          ? t('editor.noReplay')
          : t('editor.replayUnavailableReason', { reason: recorderFailureText(t, focusedFailure) })
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
        mimeType: payload.replayMimeType ?? 'video/webm',
        durationMs: payload.replayDurationMs,
        sourceStartMs: payload.replaySourceStartMs,
        offsetMs: 0,
      },
    ]
    for (const d of payload.displays) {
      if (d.focused || d.replayWebm === null) continue
      replays.push({
        displayIndex: d.index,
        focused: false,
        webm: d.replayWebm,
        mimeType: d.replayMimeType ?? 'video/webm',
        durationMs: d.replayDurationMs,
        sourceStartMs: 0,
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
        // PICKING FOLLOWS THE CLOCK (#66). Debounced on settle, so a wheel
        // burst and a playback rAF cost one request between them, not one per
        // tick — and the frame already in hand keeps answering meanwhile.
        scheduleContextFrame()
        schedulePaint()
      },
      // AND PICKING FOLLOWS THE PICTURE (#81). A seek can outlast the settle
      // timer above, so the frame that arrives afterwards must re-ask — the
      // request is time-keyed and de-duplicated, so when the timer was already
      // right this costs nothing.
      onFrame: () => {
        // Every frame the editor actually shows, remembered so a track can be
        // checked against the pictures it was built from (#113).
        const shown = Math.round(controller.presentedMs)
        if (Number.isFinite(shown)) {
          presentedTimes.push(shown)
          if (presentedTimes.length > 400) presentedTimes.shift()
        }
        scheduleContextFrame()
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
  // VIDEO opens on the whole board, every captured display visible at once.
  // IMAGE opens at native 1:1 only when it fits the content viewport; an
  // oversized raster opens contained so none of the captured resource begins
  // outside the viewport.
  //
  // This used to open framed on the focused display, because framing is sharper
  // — measured on a two-monitor desk, 0.578 vs 0.430 zoom, every control ~44%
  // smaller by area on the board. That trade was wrong. A capture whose whole
  // point is that it took EVERY screen must not open showing one of them: the
  // first thing the editor says should be what was captured, and a user who
  // cannot see the other screens has no reason to believe they are in the pack.
  // Sharpness is one keystroke away (1..9 frames a display, and it is on the
  // help sheet); the existence of the other displays is not discoverable at all
  // if they are off screen when the editor opens.
  //
  // openInitialView() also clears/synchronizes the relevant view state, so a
  // re-edit opens in the same state as a fresh capture.
  openInitialView()
  schedulePaint()
  // A frame that landed while the editor was decoding its images: apply it now
  // that there is a board to index it against.
  if (pendingContextFrame !== null) {
    const late = pendingContextFrame
    pendingContextFrame = null
    applyContextFrame(late)
  } else if (payload.context?.frame.dropped === true) {
    // GOAL "Silence is not absence": the observation was attempted and produced
    // nothing, so picking is off for this capture. Until this was said, that was
    // indistinguishable from an editor whose picking is broken.
    showObjectHintOnce('dropped', t('editor.objectDropped'))
  }
  if (pendingDisplayContextFrames.size > 0) {
    const late = [...pendingDisplayContextFrames].map(([display, frame]) => ({
      display,
      frame,
    }))
    pendingDisplayContextFrames.clear()
    applyDisplayContextFrames(late)
  }
  // The shortcut sheet is ON BY DEFAULT (GOAL "Editor Chrome"), and remembers
  // being turned off. Opened LAST: its rows describe what this capture can
  // actually do — the time group only exists with a replay, display framing
  // only on a multi-display board — so the board and the clock have to be in
  // place first.
  if (payload.showShortcutOverlay) openHelp()
  overlay.focus()
  // LAST, and over everything: this is the one panel that should have the
  // user's attention before they touch anything, and it is the one panel that
  // only ever appears once.
  if (payload.showEditorTutorial) openTutorial()
}

// Windowed mode makes resizing a normal thing to do (GOAL "Editor Window
// Mode"): the canvas re-fits, and the SCREEN-SPACE chrome — the inline text
// input (via layout), the selected-box header, and the duration popover — is
// re-anchored to boxes that have just moved on screen. (The timebar is
// percentage-positioned and follows on its own.)
window.addEventListener('resize', () => {
  layout() // also re-measures the zoom percentage and the help sheet's box
  syncSelectionUi()
  schedulePaint()
})

window.editorBridge.onInit((payload) => {
  void initEditor(payload)
    .then(
      () =>
        new Promise<void>((resolve) => {
          // The first callback runs the paint scheduled by initEditor; the
          // second proves a frame boundary passed with decoded pixels ready.
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        }),
    )
    .then(() => window.editorBridge.initialized())
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      console.error('capturepack: editor initialization failed:', err)
      window.editorBridge.initializationFailed(message)
    })
})

window.editorBridge.onCloseRequested(() => {
  // Caption X/Alt+F4 does not guarantee that the inline input blurs first.
  // Commit an edit-mode draft before comparing against the loaded baseline so
  // typed text or a newly picked box cannot be discarded as "not dirty".
  if (editMode && textSession !== null) commitTextEditor(false)
  if (editMode) updateDirty()
  if (editMode && dirty) {
    showUnsavedBar()
    window.editorBridge.closePromptShown()
  } else {
    window.editorBridge.cancel()
  }
})

// A frame Core pushed on its own: an observation that settled after the editor
// opened (the helper is budgeted and killed independently of the window), or a
// provider that answered after its budget expired. Rebuilding the per-display
// indexes from it makes picking start working mid-session; nothing else is
// touched, so boxes already drawn are unaffected.
window.editorBridge.onContextFrame((frame) => {
  // A re-edit opens after a short deadline even when its initial provider frame
  // is still pending. That late push is also the hand-off of the session id,
  // enabling all subsequent scrub requests without making first paint wait.
  if (contextSessionId === null) contextSessionId = frame.sessionId
  else if (contextSessionId !== frame.sessionId) return
  // A pushed replacement supersedes every outstanding batch assembled from an
  // older view of the board clock.
  frameRequestSeq += 1
  // A push for a position the editor has already left is NEWS, not an answer:
  // an observation that settled late lands at the capture instant while the
  // user may have scrubbed elsewhere. Applying it would move picking back in
  // time behind their own scrub, and dropping it would leave picking dead until
  // they scrub again — so the moment actually on screen is re-asked instead.
  const desired = displayedContextFrameRequests()
  if (
    desired.length > 0 &&
    desired.some((request) => request.timeMs !== frame.requestedTimeMs)
  ) {
    frameTimesByDisplay.clear()
    scheduleContextFrame()
    return
  }
  applyContextFrame(frame)
  for (const display of board?.displays ?? []) {
    frameTimesByDisplay.set(display.index, frame.requestedTimeMs)
  }
})

// Main is the authority on the window state: every mode change lands here,
// including the ones this renderer asked for.
window.editorBridge.onWindowMode((mode) => {
  applyWindowMode(mode === 'windowed' ? 'windowed' : 'fullscreen')
})

// The zoom control reads true from the first paint, not from the markup's
// placeholder value: an editor that has not loaded a board yet is at Fit.
syncZoomUi()
