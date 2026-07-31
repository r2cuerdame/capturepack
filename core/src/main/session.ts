// Capture flow state machine: pick target display -> snapshot -> replay fetch
// -> save-first -> fullscreen editor on that display -> in-place pack update on
// Save -> save toast + background annotated-replay render.
//
// Also owns the RE-EDIT flow (GOAL "History — Open & re-edit"): startEditFlow
// loads a saved pack folder back into the SAME editor window and saves through
// the same pipeline — updatePack in keepReplay mode (the declared replay is
// never rewritten) or saveAsNewPack for [Save As New CapturePack].
import { app, BrowserWindow, dialog, ipcMain, nativeImage, screen } from 'electron'
import type { Event as ElectronEvent, IpcMainEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { IPC } from '../shared/ipc'
import { REPLAY_TIMEOUT_MS } from '../shared/captureTimeouts'
import type {
  EditorAnnotationAddedPayload,
  EditorDisplayPayload,
  EditorExportPayload,
  EditorInitPayload,
  RecorderFailureReason,
  ReplayUnavailablePayload,
} from '../shared/ipc'
import type {
  Annotation,
  EditorWindowBounds,
  EditorWindowMode,
  Manifest,
  ManifestCadence,
  ManifestDisplayMedia,
  Settings,
  TimelineEvent,
  TimelineFile,
  UiaPluginPayload,
} from '../shared/types'
import { annotationsOnDisplay, focusedDisplayIndex } from '../shared/types'
import { computeDisplayNumbers } from '../shared/numbering'
import type {
  CaptureKind,
  ImageCaptureScope,
  ImageCropBounds,
} from '../shared/captureMedia'
import { rebaseAnnotationClock } from '../shared/motion'
import {
  displayReplayRangeMs,
  observedReplayClockOffsetMs,
  retainedDisplayReplayMask,
  resolveFocusedReplayTimelineClock,
  replayCoverage,
  resolvedReplayClockOffsetMs,
} from '../shared/displayClock'
import {
  createObservedReplayClockMap,
  measuredEdgeExtrapolationMs,
  ptsToSessionMs,
  sessionToPtsMs,
} from '../shared/replayClockMap'
import type { ObservedReplayClockMap } from '../shared/replayClockMap'
import type { AuthoredMotionSpace } from '../shared/track'
import type { Language } from '../shared/i18n'
import {
  renderTrimmedReplay,
  startAnnotatedRender,
  startDisplayRender,
  startKeyframeStill,
} from './annotatedRender'
import {
  captureWindowForDisplay,
  replayUnavailableReason,
  requestReplay,
  resumeReplay,
  resolveCaptureTargets,
  resolveTargetDisplay,
  takeDisplaySnapshots,
  recorderCadence,
} from './capture'
import type { DisplaySnapshot, ReplayFetch } from './capture'
import {
  freezeContext,
  contextObservationFromSurfaceSample,
  frozenObservations,
  frozenPackTimeAt,
  frozenWindow,
  logContextCost,
  refreshContextSurfaceSample,
  releaseContext,
} from './context/runtime'
import {
  DOM_PROTOCOL_VERSION,
  domBridgeStatus,
  domEventsBetween,
  parseDomPayload,
} from './chrome/domBridge'
import type { DomEvent } from './chrome/domBridge'
import {
  addManifestPlugin,
  savePack,
  saveAsNewPack,
  uiaPluginDeclaration,
  domPluginDeclaration,
  tryWriteDomPlugin,
  updateInitialPack,
  updatePack,
  displayMediaName,
  displayReplayName,
  copyAfterSave,
  displaySnapshotName,
  isoWithOffset,
  replayFileName,
  replayMimeType,
  writeUiaPlugin,
  UIA_PLUGIN_NAME,
  DOM_PLUGIN_NAME,
  WINDOWS_CONTEXT_PLUGIN_NAME,
  type DisplayCapture,
  type ExportInput,
  type InitialSaveInput,
  type PackHandle,
} from './exporter'
import type { ContextObservation } from './context/buffer'
import { editorUiaElements, editorUiaWindows } from './context/legacyPack'
import {
  exportWindowsContextTimeline,
  loadWindowsContextHistory,
  trimWindowsContextTimeline,
  type WindowsContextTimelineV1,
} from './context/windowsContextTimeline'
import { openContextSession, pushContextFrame } from './context/service'
import { createEditorCloseWatchdog } from './editorCloseWatchdog'
import { reopenedContextDisplayTargets } from './reopenDisplay'
import { packDocLanguage, uiLanguage, uiT } from './locale'
import { copyPngToClipboard } from './clipboard'
import { logError, logInfo, logWarn } from './log'
import { openPack } from './mcp/store'
import { showSaveToast, updateToastRenderStatus } from './saveToast'
import { startSourceFirstFinalSave } from './sourceFirstFinalSave'
import { persistSettings } from './settings'
import {
  imageRegionSelectorWindowHandles,
  selectImageRegion,
  type ImageRegionSelection,
} from './imageRegionSelector'
import {
  composeUiaForImageDesktop,
  cropUiaForImage,
  imageWindowObservation,
  mergeImageWindowFloor,
} from './imageContext'
import {
  createImageDesktopBitmap,
  layoutImageDesktop,
  placeImageDesktopBitmap,
  type ImageDesktopLayout,
} from './imageDesktop'
import {
  mapUiaToSnapshot,
  parseUiaPayload,
  recordUiaSkipped,
  startUiaDump,
  type UiaDisplayTarget,
  type UiaRawDump,
} from './uia'

const EDITOR_CLOSE_RESPONSE_TIMEOUT_MS = 5_000
// A hidden editor must never own the global capture/edit gate forever. This is
// deliberately much longer than a normal load, but finite: if the renderer
// never reaches its first show (load failure, crash, or a preparation promise
// that accidentally hangs), destroying the hidden window lets runEditor settle
// and releases Ctrl+Alt+C for the next request.
const EDITOR_STARTUP_TIMEOUT_MS = 10_000

// Electron emits before-quit before it starts closing BrowserWindows. Native
// close interception is for the user's X/Alt+F4 only; blocking app.quit() or an
// updater restart would turn a confirmation affordance into an exit deadlock.
let appIsQuitting = false
app.on('before-quit', () => {
  appIsQuitting = true
})

/** Plugin name pattern from SPEC §5.4 — also what makes a name path-safe. */
const PLUGIN_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

/**
 * How long the READY editor may wait for the object dump before opening without
 * it (GOAL: "never delaying the editor").
 *
 * Measured from the moment the editor is ready to show — NOT from the capture
 * trigger, which is the bug that killed object picking outright: the dump's own
 * budget and kill are spent against the trigger, so by the time the editor was
 * ready (after the snapshot, the replay fetch and save-first) a trigger-relative
 * deadline was routinely already in the past, and the wait returned null WITHOUT
 * LOOKING at a promise that had resolved with a full dump hundreds of ms
 * earlier. Nothing is dropped any more either: a dump that lands after this
 * grace is PUSHED to the editor as a new context frame (IPC.contextFrame) and
 * picking starts working mid-session.
 */
const UIA_EDITOR_GRACE_MS = 400

type EditorOutcome =
  | { kind: 'export' | 'saveAsNew'; payload: EditorExportPayload }
  | { kind: 'cancel' }

// One flow at a time, shared across capture AND re-edit: two fullscreen
// editors (or an editor over a capture in progress) must never coexist.
let flowActive = false
let activeEditor: BrowserWindow | null = null

/**
 * Makes a repeated request useful while an editor is already open. Starting a
 * second capture would destroy the first flow's ownership, but silently doing
 * nothing made a background/covered editor indistinguishable from a broken
 * hotkey. A visible editor is restored and focused; a still-hidden preparation
 * is left to the startup deadline below.
 */
function focusActiveEditor(): boolean {
  const editor = activeEditor
  if (editor === null || editor.isDestroyed()) return false
  if (editor.isMinimized()) editor.restore()
  if (!editor.isVisible()) return false
  editor.show()
  editor.focus()
  return true
}

export async function startCaptureFlow(settings: Settings): Promise<void> {
  // Every capture REQUEST is recorded, including the ones that do nothing
  // (issue #60): "I pressed the hotkey and nothing happened" has to be
  // answerable, and "an editor was already open" is one of the answers.
  if (flowActive) {
    const focused = focusActiveEditor()
    logWarn(
      focused
        ? '[capture] capture requested while an editor was already open — focused that editor'
        : '[capture] capture requested while another flow was still preparing — ignored',
    )
    return
  }
  logInfo('[capture] capture requested')
  flowActive = true
  try {
    await runFlow(settings)
  } catch (err) {
    logError('[capture] capture failed:', err)
    // 'CapturePack' is the product name — never translated.
    dialog.showErrorBox('CapturePack', uiT(settings)('app.captureFailed', { error: errorMessage(err) }))
  } finally {
    flowActive = false
  }
}

/**
 * Re-edit entry point (History [Edit]).
 *
 * Returns synchronously so History can distinguish "accepted" from "another
 * editor/capture already owns the gate". The actual editor lifetime stays
 * detached; awaiting it from an IPC invoke would leave the card button pending
 * until the user eventually closed the editor.
 */
export function startEditFlow(dirPath: string, settings: Settings): boolean {
  if (flowActive) {
    focusActiveEditor()
    logWarn(`[capture] re-edit of ${path.basename(dirPath)} requested while a flow was already open`)
    return false
  }
  logInfo(`[capture] re-edit requested: ${path.basename(dirPath)}`)
  flowActive = true
  // Let the invoke response reach History before reading replay files and
  // rebuilding provider indexes. runEditFlow necessarily does some synchronous
  // pack I/O before its first await; starting it on this call stack made the
  // Edit button look dead and kept History painted over the new window.
  setImmediate(() => {
    void runEditFlow(dirPath, settings)
      .catch((err: unknown) => {
        logError(`[capture] re-edit of ${path.basename(dirPath)} failed:`, err)
        dialog.showErrorBox('CapturePack', uiT(settings)('app.reeditFailed', { error: errorMessage(err) }))
      })
      .finally(() => {
        flowActive = false
      })
  })
  return true
}

/**
 * Explicit still-image capture. Source frames are frozen before the selector
 * appears, but only the user-selected raster is ever handed to a pack writer.
 * The replay recorder is neither queried nor stopped by this flow.
 */
export async function startImageCaptureFlow(settings: Settings): Promise<void> {
  if (flowActive) {
    const focused = focusActiveEditor()
    logWarn(
      focused
        ? '[image] capture requested while an editor was already open — focused that editor'
        : '[image] capture requested while another flow was still preparing — ignored',
    )
    return
  }
  logInfo('[image] capture requested')
  flowActive = true
  try {
    await runImageFlow(settings)
  } catch (err) {
    logError('[image] capture failed:', err)
    dialog.showErrorBox(
      'CapturePack',
      uiT(settings)('app.captureFailed', { error: errorMessage(err) }),
    )
  } finally {
    flowActive = false
  }
}

// ---------------------------------------------------------------------------
// Freezing the displays (GOAL "Multi-Monitor Support")
// ---------------------------------------------------------------------------

/** One display frozen by the trigger: its snapshot, its replay, its geometry. */
interface FrozenDisplay {
  // Electron display id — main-process bookkeeping only, never written to the
  // pack (it is not stable across reboots).
  id: number
  // 1-based position in manifest.environment.screens.
  index: number
  focused: boolean
  bounds: { x: number; y: number; width: number; height: number }
  scale: number
  snapshotPng: Buffer
  width: number
  height: number
  replayWebm: Buffer | null
  replayDurationMs: number
  /** The tick clock's value at this replay's t=0 (#112); absent if unknown. */
  replayOriginMs?: number
  /** Exact same-frame encoded PTS -> shared presentation-clock observations. */
  replayClockAnchors?: readonly {
    ptsMs: number
    wallMs: number
  }[]
  /** Encoded PTS -> independently measured desktop-pixel exposure clock. */
  replaySourceClockAnchors?: readonly {
    ptsMs: number
    wallMs: number
  }[]
  /** Main's wall time immediately before requesting this display's replay. */
  replayRequestWallMs?: number
  replayMimeType: string | null
  replayFile: 'replay.webm' | 'replay.mp4' | null
  // Set when this display came back WITHOUT a replay: why its buffer was not
  // running (GOAL "Say that you are recording"). A capture may never present a
  // missing replay as if nothing were wrong — the editor and the save toast
  // both name this reason. null = the replay is here.
  replayUnavailableReason: RecorderFailureReason | null
}

/**
 * Validate renderer observations. Interior interpolation and the bounded
 * projection of at most one observed edge segment map clocks only; UIA, DOM
 * and window geometry remain nearest observed samples without interpolation.
 */
function observedReplayClockMap(
  display: FrozenDisplay,
  axis: 'presentation' | 'source' = 'presentation',
): ObservedReplayClockMap | null {
  const anchors =
    axis === 'source'
      ? display.replaySourceClockAnchors
      : display.replayClockAnchors
  if (anchors === undefined || anchors.length < 2) return null
  const mappedAnchors = anchors.map((anchor) => ({
      ptsMs: anchor.ptsMs,
      // At this boundary the renderer clock is epoch-based and comparable
      // across processes. context/runtime converts it to SessionClock later.
      sessionMs: anchor.wallMs,
    }))
  const decision = createObservedReplayClockMap(
    mappedAnchors,
    measuredEdgeExtrapolationMs(mappedAnchors),
  )
  return decision.status === 'ready' ? decision.map : null
}

function observedReplayWallTimeAt(
  display: FrozenDisplay | undefined,
  ptsMs: number,
): number | undefined {
  if (display === undefined || !Number.isFinite(ptsMs)) return undefined
  const map = observedReplayClockMap(display)
  const mapped = map === null ? undefined : ptsToSessionMs(map, ptsMs)
  if (mapped !== undefined) return mapped
  return display.replayOriginMs === undefined
    ? undefined
    : display.replayOriginMs + ptsMs
}

function observedReplayPtsAtWallTime(
  display: FrozenDisplay | undefined,
  wallMs: number,
): number | undefined {
  if (display === undefined || !Number.isFinite(wallMs)) return undefined
  const map = observedReplayClockMap(display)
  const mapped = map === null
    ? undefined
    : sessionToPtsMs(map, wallMs)
  if (mapped !== undefined) return mapped
  return display.replayOriginMs === undefined
    ? undefined
    : wallMs - display.replayOriginMs
}

/**
 * Freezes what the trigger covers: every connected display in "all" mode, the
 * cursor/fixed display otherwise.
 *
 * Every display's replay boundary is acquired in parallel first. Only then is
 * the FOCUSED display snapshotted first and alone; that one call already carries
 * every same-sized display's frame, so an ordinary desk of identical monitors
 * costs exactly ONE screen capture round trip (see takeDisplaySnapshots).
 * Differently-sized groups follow concurrently while each old replay epoch is
 * held/discard-only. A per-display failure is logged and that display stays
 * screenshot-only; the focused display's snapshot failure remains fatal.
 */
async function freezeDisplays(settings: Settings): Promise<{
  screens: Array<{ width: number; height: number; scale: number }>
  focused: FrozenDisplay
  displays: FrozenDisplay[]
}> {
  const targets = resolveCaptureTargets(settings)
  const screens = targets.allDisplays.map((d) => ({
    width: Math.round(d.size.width * d.scaleFactor),
    height: Math.round(d.size.height * d.scaleFactor),
    scale: d.scaleFactor,
  }))
  const indexById = new Map(targets.allDisplays.map((d, i) => [d.id, i + 1]))
  // resolveCaptureTargets prepends the focused display when getDisplayNearestPoint
  // returned something getAllDisplays does not contain. It is then absent from
  // environment.screens AND from indexById — and a default index would COLLIDE
  // with a real display's (media.displays[].index MUST be unique, SPEC §5.6).
  // Give it the next free position in both lists instead.
  if (!indexById.has(targets.focused.id)) {
    const focused = targets.focused
    screens.push({
      width: Math.round(focused.size.width * focused.scaleFactor),
      height: Math.round(focused.size.height * focused.scaleFactor),
      scale: focused.scaleFactor,
    })
    indexById.set(focused.id, screens.length)
  }

  // Acquire every recorder boundary before touching desktopCapturer. This is a
  // barrier, not a serial loop: one slow/failed display cannot move another
  // display's replay end to the far side of the full-native snapshot.
  const heldRequests = targets.displays.map((display) => {
    const win = captureWindowForDisplay(display.id)
    const requestId = win === null ? null : randomUUID()
    // Fallback end anchor for a renderer too old to report originMs. Captured
    // before stop/flush/IPC so mux latency cannot become pixel time.
    const replayRequestWallMs = Date.now()
    const result: Promise<ReplayFetch> =
      win === null || requestId === null
        ? Promise.resolve({ replay: null, miss: 'no-recorder' })
        : requestReplay(win, requestId, REPLAY_TIMEOUT_MS, {
            holdAfterCapture: true,
          }).catch((error: unknown) => {
            logError(
              `[capture] display ${display.id}: replay freeze failed independently:`,
              error,
            )
            return { replay: null, miss: 'window-gone' }
          })
    return { display, win, requestId, replayRequestWallMs, result }
  })

  try {
    const replayResults = await Promise.all(
      heldRequests.map(async (request) => ({
        request,
        fetched: await request.result,
      })),
    )
    const replayByDisplay = new Map(
      replayResults.map(({ request, fetched }) => [
        request.display.id,
        {
          fetched,
          replayRequestWallMs: request.replayRequestWallMs,
        },
      ]),
    )

    // ONE grouped full-native observation after every replay is frozen.
    // Snapshot-time pixels are therefore in neither the returned replay nor
    // the fresh ring that RESUME creates.
    const snaps = await takeDisplaySnapshots(targets.displays, targets.focused)
    const focusedSnap = snaps.get(targets.focused.id)
    if (focusedSnap === undefined) {
      throw new Error(`no screen source available for display ${targets.focused.id}`)
    }

    const frozen = (
      display: (typeof targets.displays)[number],
      isFocused: boolean,
      snap: { png: Buffer; width: number; height: number },
    ): FrozenDisplay => {
      const request = replayByDisplay.get(display.id)
      const fetched = request?.fetched ?? {
        replay: null,
        miss: 'no-recorder' as const,
      }
      const replay = fetched.replay
      if (replay === null) {
        const reason = replayUnavailableReason(
          display.id,
          fetched.miss ?? 'no-recorder',
        )
        logWarn(
          `[capture] display ${display.id}: no replay for this capture (${reason}) — ` +
            'the pack keeps its frozen frame only',
        )
        return {
          id: display.id,
          index: indexById.get(display.id) ?? 1,
          focused: isFocused,
          bounds: { ...display.bounds },
          scale: display.scaleFactor,
          snapshotPng: snap.png,
          width: snap.width,
          height: snap.height,
          replayWebm: null,
          replayDurationMs: 0,
          replayMimeType: null,
          replayFile: null,
          replayRequestWallMs: request?.replayRequestWallMs,
          replayUnavailableReason: reason,
        }
      }
      return {
        id: display.id,
        index: indexById.get(display.id) ?? 1,
        focused: isFocused,
        bounds: { ...display.bounds },
        scale: display.scaleFactor,
        snapshotPng: snap.png,
        width: snap.width,
        height: snap.height,
        replayWebm: replay.buffer,
        replayDurationMs: replay.durationMs,
        ...(replay.originMs === undefined ? {} : { replayOriginMs: replay.originMs }),
        ...(replay.clockAnchors === undefined
          ? {}
          : { replayClockAnchors: replay.clockAnchors }),
        ...(replay.sourceClockAnchors === undefined
          ? {}
          : { replaySourceClockAnchors: replay.sourceClockAnchors }),
        replayRequestWallMs: request?.replayRequestWallMs,
        replayMimeType: replay.mimeType,
        replayFile: replay.replayFile,
        replayUnavailableReason: null,
      }
    }

    const focused = frozen(targets.focused, true, focusedSnap)
    const others: FrozenDisplay[] = []
    for (const display of targets.displays) {
      if (display.id === targets.focused.id) continue
      const snap = snaps.get(display.id)
      if (snap === undefined) continue
      others.push(frozen(display, false, snap))
    }
    const displays = [focused, ...others].sort((a, b) => a.index - b.index)
    const focusedFrozen = displays.find((display) => display.focused) ?? focused
    return { screens, focused: focusedFrozen, displays }
  } finally {
    // Includes snapshot exceptions, per-display replay timeout and callers that
    // abandon/cancel after freeze. A dead renderer is a safe no-op; a lost main
    // resume is independently bounded by the renderer watchdog.
    for (const request of heldRequests) {
      if (request.win !== null && request.requestId !== null) {
        resumeReplay(request.win, request.requestId)
      }
    }
  }
}

/**
 * What the save toast has to say about missing replays (GOAL "Say that you are
 * recording"): how many captured displays came back without one, whether the
 * pack itself is therefore screenshot-only, and the recorder's reason — worded
 * exactly as the tray words it. null when every display delivered.
 */
function replayUnavailableForToast(
  displays: readonly FrozenDisplay[],
): ReplayUnavailablePayload | null {
  const missing = displays.filter((d) => d.replayWebm === null)
  const first = missing[0]
  if (first === undefined) return null
  return {
    // A capture with several dead recorders is one failure to the user; the
    // focused display's reason leads when it is one of them.
    reason: (missing.find((d) => d.focused) ?? first).replayUnavailableReason ?? 'did-not-start',
    screens: missing.length,
    total: displays.length,
    focused: missing.some((d) => d.focused),
  }
}

/** The exporter's write-side view of the frozen displays (focused bytes are the top-level files). */
function toDisplayCaptures(
  displays: readonly FrozenDisplay[],
  focusedSourceStartMs = 0,
): DisplayCapture[] {
  const focused = displays.find((d) => d.focused)
  // Fresh editor time zero may start inside the focused recorder's raw ring.
  // Put that exact source in-point on the shared origin axis before comparing
  // it with the other recorders; duration difference only approximated this
  // when every recorder happened to stop on precisely the same instant.
  const packOriginMs =
    observedReplayWallTimeAt(focused, focusedSourceStartMs)
  return displays.map((d) => ({
    index: d.index,
    focused: d.focused,
    bounds: d.bounds,
    scale: d.scale,
    hasReplay: d.replayWebm !== null,
    replayDurationMs: d.replayDurationMs,
    ...(d.replayWebm === null
      ? {}
      : d.focused
        ? { replayClockOffsetMs: 0 }
        : (() => {
            const offsetMs = observedReplayClockOffsetMs(
              packOriginMs,
              observedReplayWallTimeAt(d, 0),
            )
            return offsetMs === undefined ? {} : { replayClockOffsetMs: offsetMs }
          })()),
    // The recorder's own account of what it managed (#82), carried into the
    // pack so the replay's quality is a fact a reader can see.
    ...(() => {
      const cadence = manifestCadence(d.id)
      return cadence === undefined ? {} : { cadence }
    })(),
    // A fresh capture writes the canonical names; they travel with the entry so
    // every writer uses the SAME string the manifest declares.
    snapshotFile: displaySnapshotName(d.index),
    replayFile:
      d.replayWebm !== null && d.replayFile !== null
        ? displayReplayName(d.index, d.replayFile)
        : null,
    snapshotPng: d.focused ? null : d.snapshotPng,
    replayWebm: d.focused ? null : d.replayWebm,
  }))
}

/**
 * The editor BOARD payload (GOAL "Multi-Monitor Support"): every frozen
 * display's frame, geometry and replay, so the editor can draw them all at once
 * in their real arrangement and scrub them from one clock. Empty for a
 * single-display capture — the editor then builds a one-display board from the
 * top-level media and behaves exactly as it always did.
 */
function toEditorDisplays(
  displays: readonly FrozenDisplay[],
  focusedWindowDurationMs: number,
): EditorDisplayPayload[] {
  if (displays.length < 2) return []
  const focused = displays.find((d) => d.focused)
  const focusedSourceStartMs = Math.max(
    0,
    (focused?.replayDurationMs ?? focusedWindowDurationMs) - focusedWindowDurationMs,
  )
  const packOriginMs = observedReplayWallTimeAt(
    focused,
    focusedSourceStartMs,
  )
  return displays.map((d) => ({
    index: d.index,
    focused: d.focused,
    // The FOCUSED display's frame is already EditorInitPayload.snapshotPng and
    // the editor never decodes this copy — sending it again would put another
    // 3-8 MB into the editor-open critical path per 4K display. Its replay is
    // EditorInitPayload.replayWebm for the same reason.
    snapshotPng: d.focused ? null : toArrayBuffer(d.snapshotPng),
    width: d.width,
    height: d.height,
    bounds: { ...d.bounds },
    scale: d.scale,
    replayWebm: d.focused || d.replayWebm === null ? null : toArrayBuffer(d.replayWebm),
    replayMimeType: d.focused ? null : d.replayMimeType,
    // The board labels a display that recorded nothing with THIS reason
    // instead of a bare "frozen frame".
    replayUnavailableReason: d.replayUnavailableReason,
    replayDurationMs: d.replayDurationMs,
    // Prefer the recorders' OBSERVED shared-clock origins. Only a recorder that
    // could not report an origin falls back to the legacy end-alignment rule.
    replayOffsetMs: d.focused
      ? 0
        : resolvedReplayClockOffsetMs(
          observedReplayClockOffsetMs(
            packOriginMs,
            observedReplayWallTimeAt(d, 0),
          ),
          d.replayDurationMs,
          focusedWindowDurationMs,
        ),
  }))
}

function manifestCadence(displayId: number): ManifestCadence | undefined {
  const measured = recorderCadence(displayId)
  if (measured === null) return undefined
  return {
    achieved_fps: measured.achievedFps,
    worst_stall_ms: measured.worstStallMs,
    ...(measured.discardedFrames === undefined || measured.discardedFrames === null
      ? {}
      : { discarded_frames: measured.discardedFrames }),
    ...(measured.requestedFps === undefined
      ? {}
      : { requested_fps: measured.requestedFps }),
    ...(measured.backend === undefined ? {} : { backend: measured.backend }),
    ...(measured.quality === undefined ? {} : { quality: measured.quality }),
    ...(measured.recorderCount === undefined
      ? {}
      : { recorder_count: measured.recorderCount }),
  }
}

function imageCropBounds(
  selection: ImageRegionSelection,
): ImageCropBounds | undefined {
  if (selection.mode !== 'region') return undefined
  return {
    ...selection.desktopDipRect,
    coordinate_space: 'virtual-desktop-dip',
  }
}

function captureMetadataFromManifest(manifest: Manifest): {
  captureKind: CaptureKind
  imageScope?: ImageCaptureScope
  cropBounds?: ImageCropBounds
} {
  // Packs predating explicit image capture came from the video hotkey, even if
  // their recorder failed and only snapshot.png survived. Do not rewrite that
  // ambiguous legacy evidence as an explicitly requested full-screen still.
  if (manifest.capture_kind !== 'image') return { captureKind: 'video' }
  if (manifest.media.replay !== null || manifest.media.displays !== undefined) {
    throw new Error('image CapturePack must not declare replay or per-display media')
  }
  const scope = manifest.media.image_scope
  if (scope !== 'region' && scope !== 'fullscreen') {
    throw new Error('image CapturePack has no valid media.image_scope')
  }
  if (scope === 'fullscreen') {
    if (manifest.media.crop_bounds !== undefined) {
      throw new Error('fullscreen image CapturePack must not declare crop_bounds')
    }
    return { captureKind: 'image', imageScope: scope }
  }
  const crop = manifest.media.crop_bounds
  if (
    crop === undefined ||
    !Number.isFinite(crop.x) ||
    !Number.isFinite(crop.y) ||
    !Number.isFinite(crop.width) ||
    crop.width <= 0 ||
    !Number.isFinite(crop.height) ||
    crop.height <= 0 ||
    crop.coordinate_space !== 'virtual-desktop-dip'
  ) {
    throw new Error('region image CapturePack has invalid media.crop_bounds')
  }
  return {
    captureKind: 'image',
    imageScope: scope,
    cropBounds: { ...crop },
  }
}

function cropSnapshot(
  png: Buffer,
  selection: ImageRegionSelection,
): Buffer {
  const source = nativeImage.createFromBuffer(png)
  if (source.isEmpty()) throw new Error('captured image could not be decoded')
  const rect = selection.pixelRect
  const cropped = source.crop({
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  })
  const size = cropped.getSize()
  if (
    cropped.isEmpty() ||
    size.width !== rect.width ||
    size.height !== rect.height
  ) {
    throw new Error(
      `captured image crop mismatch: expected ${rect.width}x${rect.height}, ` +
        `got ${size.width}x${size.height}`,
    )
  }
  return cropped.toPNG()
}

/**
 * Joins every frozen display into one native-pixel PNG.
 *
 * The placement helper has already resolved mixed-DPI topology without
 * resampling. This copier therefore moves complete BGRA scanlines only: every
 * source pixel reaches the pack unchanged and uncovered virtual-desktop gaps
 * are opaque black, matching the Windows full-screen capture surface.
 */
function composeImageDesktop(
  layout: ImageDesktopLayout,
  snapshots: ReadonlyMap<number, DisplaySnapshot>,
): Buffer {
  const bitmap = createImageDesktopBitmap(layout)
  for (const placement of layout.placements) {
    const displayId = Number(placement.id)
    const snapshot = Number.isFinite(displayId)
      ? snapshots.get(displayId)
      : undefined
    if (snapshot === undefined) {
      throw new Error(`captured display ${placement.id} disappeared before composition`)
    }
    const source = nativeImage.createFromBuffer(snapshot.png)
    const size = source.getSize()
    if (
      source.isEmpty() ||
      size.width !== placement.width ||
      size.height !== placement.height
    ) {
      throw new Error(
        `captured display ${placement.index} size mismatch: expected ` +
          `${placement.width}x${placement.height}, got ${size.width}x${size.height}`,
      )
    }
    const sourceBitmap = source.toBitmap()
    placeImageDesktopBitmap(
      layout,
      placement,
      {
        id: placement.id,
        width: size.width,
        height: size.height,
        bgra: sourceBitmap,
      },
      bitmap,
    )
  }

  const composed = nativeImage.createFromBitmap(bitmap, {
    width: layout.width,
    height: layout.height,
  })
  const size = composed.getSize()
  if (
    composed.isEmpty() ||
    size.width !== layout.width ||
    size.height !== layout.height
  ) {
    throw new Error(
      `full-desktop image composition mismatch: expected ` +
        `${layout.width}x${layout.height}, got ${size.width}x${size.height}`,
    )
  }
  return composed.toPNG()
}

async function runImageFlow(settings: Settings): Promise<void> {
  const triggerAt = Date.now()
  // Read full Win32 membership immediately before the pixels. Projection waits
  // until the native snapshot sizes are known, but the observed geometry does
  // not move to a post-screenshot instant.
  const triggerSurfaceSample = await refreshContextSurfaceSample()
  const contextFreezeId = freezeContext(triggerAt, 0)
  try {
    await runImageFlowWithContext(
      settings,
      triggerAt,
      contextFreezeId,
      triggerSurfaceSample,
    )
  } finally {
    releaseContext(contextFreezeId)
  }
}

function physicalContextBounds(
  bounds: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } | undefined {
  try {
    return screen.dipToScreenRect(null, bounds)
  } catch {
    // Windows production exposes dipToScreenRect. Non-Windows and deterministic
    // harnesses can omit the identity and use their explicit fixture mapping.
    return undefined
  }
}

async function runImageFlowWithContext(
  settings: Settings,
  triggerAt: number,
  contextFreezeId: string | null,
  triggerSurfaceSample: Awaited<ReturnType<typeof refreshContextSurfaceSample>>,
): Promise<void> {
  let uiaDump: Promise<UiaRawDump | null>
  if (settings.uiaEnabled) {
    uiaDump = startUiaDump()
  } else {
    recordUiaSkipped()
    uiaDump = Promise.resolve(null)
  }

  // Freeze first, reveal overlays second. No selector pixel can therefore
  // appear in the image, and a cancelled selection never reaches persistence.
  const allDisplays = screen.getAllDisplays()
  if (allDisplays.length === 0) throw new Error('no display is available')
  const focused = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const snapshots = await takeDisplaySnapshots(allDisplays, focused)
  const indexById = new Map(allDisplays.map((display, index) => [display.id, index + 1]))
  const selectable = allDisplays.flatMap((display) => {
    const snapshot = snapshots.get(display.id)
    if (snapshot === undefined) return []
    return [{
      id: String(display.id),
      index: indexById.get(display.id) ?? 1,
      bounds: { ...display.bounds },
      scaleFactor: display.scaleFactor,
      pixelSize: { width: snapshot.width, height: snapshot.height },
    }]
  })
  if (selectable.length === 0) throw new Error('no screen source is available')
  const desktop = layoutImageDesktop(selectable)
  const focusedDisplay =
    allDisplays.find((display) => display.id === focused.id) ?? allDisplays[0]
  if (focusedDisplay === undefined) throw new Error('the focused display disappeared')
  const focusedPlacement =
    desktop.placements.find((placement) => placement.id === String(focused.id)) ??
    desktop.placements[0]
  const contextFocusedDisplay = focusedPlacement?.index ?? 1
  const displayById = new Map(
    allDisplays.map((display) => [String(display.id), display]),
  )
  const targets: UiaDisplayTarget[] = desktop.placements.flatMap((placement) => {
    const display = displayById.get(placement.id)
    if (display === undefined) return []
    const desktopBounds = physicalContextBounds(display.bounds)
    return [{
      index: placement.index,
      focused: placement.index === contextFocusedDisplay,
      bounds: { ...display.bounds },
      ...(desktopBounds === undefined ? {} : { desktopBounds }),
      width: placement.width,
      height: placement.height,
    }]
  })
  const frozenImageWindows =
    contextFreezeId === null
      ? []
      : frozenObservations(contextFreezeId, targets, 0)
  // The source pixels are already frozen and the selector does not exist yet.
  // Ask the resident Win32 host for one complete membership snapshot now, so a
  // program created since the last cadence sample is not omitted. This direct
  // result avoids depending on whether the video frame clock has started.
  const exactImageWindows = await contextObservationFromSurfaceSample(
    triggerSurfaceSample,
    targets,
  )
  const selectionPending = selectImageRegion({
    displays: selectable,
    focusedDisplayId: String(focused.id),
    uiLanguage: uiLanguage(settings),
  })
  const selectorHwnds = imageRegionSelectorWindowHandles()
  const selection = await selectionPending
  if (selection === null) {
    snapshots.clear()
    logInfo('[image] selection cancelled — no pack was written')
    return
  }
  const selectedDisplay =
    allDisplays.find((display) => String(display.id) === selection.displayId) ??
    focusedDisplay
  const desktopUia = uiaDump
    .then((raw) => {
      if (raw === null) return null
      return composeUiaForImageDesktop(
        mapUiaToSnapshot(raw, targets),
        desktop.placements,
        contextFocusedDisplay,
      )
    })
    .catch((err: unknown) => {
      logError('[image] mapping full-desktop UI Automation context failed:', err)
      return null
    })

  let desktopPng: Buffer | null = composeImageDesktop(desktop, snapshots)
  let snapshotPng: Buffer
  let width: number
  let height: number
  const screenDeclaration = desktop.placements.map((placement) => ({
    width: placement.pixelSize.width,
    height: placement.pixelSize.height,
    scale: placement.scaleFactor,
  }))
  let uiaReady: Promise<UiaPluginPayload | null>
  let imageWindows: ContextObservation | null

  if (selection.mode === 'fullscreen') {
    if (selectable.length !== allDisplays.length) {
      snapshots.clear()
      throw new Error(
        `full-desktop image needs every display: captured ` +
          `${selectable.length} of ${allDisplays.length}`,
      )
    }
    // "Full screen" follows Windows' snipping semantics: the complete virtual
    // desktop, not only the monitor that held the toolbar.
    snapshotPng = desktopPng
    width = desktop.width
    height = desktop.height
    uiaReady = desktopUia
    imageWindows = imageWindowObservation(
      exactImageWindows ?? frozenImageWindows[frozenImageWindows.length - 1],
      desktop.placements,
    )
  } else {
    // Cross-monitor drags crop the lossless all-display composition. Only this
    // explicit rectangle survives; the temporary full desktop is released
    // before save/editor IPC and is never written to the CapturePack.
    snapshotPng = cropSnapshot(desktopPng, selection)
    width = selection.pixelRect.width
    height = selection.pixelRect.height
    uiaReady = desktopUia
      .then((mapped) => {
        return cropUiaForImage(
          mapped,
          {
            display: 1,
            ...selection.pixelRect,
          },
          1,
        )
      })
      .catch((err: unknown) => {
        logError('[image] mapping/cropping UI Automation context failed:', err)
        return null
      })
    imageWindows = imageWindowObservation(
      exactImageWindows ?? frozenImageWindows[frozenImageWindows.length - 1],
      desktop.placements,
      selection.pixelRect,
    )
  }
  uiaReady = uiaReady.then((payload) =>
    mergeImageWindowFloor(
      payload,
      imageWindows,
      isoWithOffset(new Date(triggerAt)),
      selectorHwnds,
    ),
  )
  // From this point onward the only reachable raster is the explicit crop or
  // the explicitly requested all-display composition.
  desktopPng = null
  snapshots.clear()

  const capturedAt = new Date(triggerAt)
  const events: TimelineEvent[] = [{
    t_ms: 0,
    type: 'core.image.capture.triggered',
    source: 'core',
    data: {
      hotkey: settings.imageCaptureHotkey,
      scope: selection.mode,
    },
  }]
  const timeline: TimelineFile = {
    t0: isoWithOffset(capturedAt),
    events,
  }
  const cropBounds = imageCropBounds(selection)
  const initialSave: InitialSaveInput = {
    captureKind: 'image',
    imageScope: selection.mode,
    ...(cropBounds === undefined ? {} : { cropBounds }),
    snapshotPng,
    width,
    height,
    capturedAt,
    replayWebm: null,
    replayDurationMs: 0,
    timeline,
    outputDir: settings.outputDir,
    screens: screenDeclaration,
    windowsContext: null,
    docLanguage: packDocLanguage(settings),
  }

  let handle: PackHandle | null = null
  try {
    handle = await savePack(initialSave)
    logInfo(
      `[image] save-first wrote ${path.basename(handle.dirPath)} ` +
        `(${selection.mode}, ${width}x${height})`,
    )
  } catch (err) {
    logError('[image] save-first failed; Save will retry:', err)
  }

  const uiaWrite: Promise<UiaPluginPayload | null> = uiaReady.then(async (payload) => {
    const saved = handle
    if (payload === null || saved === null) return payload
    try {
      await writeUiaPlugin(saved.dirPath, payload)
      await addManifestPlugin(saved, uiaPluginDeclaration(), packDocLanguage(settings))
    } catch (err) {
      logError(`[image] writing plugins/${UIA_PLUGIN_NAME} failed:`, err)
    }
    return payload
  })

  const { win: editor, mode: windowMode } = createEditorWindow(
    selectedDisplay.bounds,
    settings,
  )
  editor.webContents.on('console-message', (_event, level, message) => {
    if (!message.startsWith('capturepack:')) return
    if (level >= 2) logWarn(`[editor] ${message}`)
    else logInfo(`[editor] ${message}`)
  })
  editor.once('ready-to-show', () => {
    void (async () => {
      const settled = await settleWithin(uiaReady, UIA_EDITOR_GRACE_MS)
      if (editor.isDestroyed()) return
      const uia = settled.ready ? settled.value : null
      const contextSession = openContextSession(editor, {
        displays: [{ index: 1, focused: true, width, height }],
        replayDurationMs: 0,
        observation: contextObservation(uia, 1, 0),
        dropped: settled.ready && uiaEmpty(uia),
        domEvents: [],
      })
      const init: EditorInitPayload = {
        captureKind: 'image',
        snapshotPng: toArrayBuffer(snapshotPng),
        width,
        height,
        hasReplay: false,
        replayDurationMs: 0,
        replaySourceStartMs: 0,
        displays: [],
        replayWebm: null,
        replayMimeType: null,
        replayUnavailableReason: null,
        context: {
          sessionId: contextSession.sessionId,
          frame: await contextSession.frameAt(0),
        },
        fps: settings.fps,
        scrubInvert: settings.scrubInvert,
        scrubSensitivityMs: settings.scrubSensitivityMs,
        defaultManualDurationMs: settings.defaultManualDurationMs,
        showDurationLabel: settings.showDurationLabel,
        showShortcutOverlay: settings.showShortcutOverlay,
        showEditorTutorial: settings.showEditorTutorial,
        annotations: [],
        title: '',
        note: '',
        editMode: false,
        uiLanguage: uiLanguage(settings),
        windowMode,
      }
      if (editor.isDestroyed()) return
      await initializeAndShowEditor(editor, init)

      if (!settled.ready) {
        void uiaReady.then(
          (payload) => {
            if (editor.isDestroyed()) return
            contextSession.adopt(contextObservation(payload, 1, 0))
            contextSession.markDropped(uiaEmpty(payload))
            pushContextFrame(editor, contextSession, 0)
          },
          (err: unknown) => {
            logError('[image] pushing delayed object context failed:', err)
          },
        )
      }
    })().catch((err: unknown) => {
      logError('[image] preparing the editor failed — closing it:', err)
      if (!editor.isDestroyed()) editor.destroy()
    })
  })

  const outcome = await runEditor(editor, events, triggerAt)
  logInfo(`[image] editor closed: ${outcome.kind}`)
  if (outcome.kind === 'cancel') {
    // The explicit image choice is already a valid save-first pack. Its only
    // source raster is the selected crop/fullscreen image.
    void uiaWrite.catch((err: unknown) =>
      logError('[image] finishing cancelled image context failed:', err),
    )
    return
  }

  const uiaPayload = await uiaWrite
  const annotations = outcome.payload.annotations.map(withoutReplayTimes)
  const imagePackClipboardMode =
    settings.imageClipboardAfterSave === 'image'
      ? 'off'
      : settings.imageClipboardAfterSave
  const input: ExportInput = {
    captureKind: 'image',
    imageScope: selection.mode,
    ...(cropBounds === undefined ? {} : { cropBounds }),
    snapshotPng: Buffer.from(outcome.payload.snapshotPng),
    width,
    height,
    capturedAt,
    replayWebm: null,
    replayDurationMs: 0,
    annotations,
    title: outcome.payload.title,
    note: outcome.payload.note,
    snapshotTMs: null,
    timeline,
    screens: screenDeclaration,
    uia: uiaPayload ?? undefined,
    windowsContext: null,
    clipboardAfterSave: imagePackClipboardMode,
    docLanguage: packDocLanguage(settings),
  }

  try {
    if (handle === null) handle = await savePack(initialSave)
    const savedHandle = handle
    await updatePack(savedHandle, input)
    logInfo(
      `[image] saved ${path.basename(savedHandle.dirPath)}: ` +
        `${annotations.length} annotation(s), no video`,
    )
    // Confirm the configured automatic copy before presenting "Saved". This is
    // bounded to 80 ms under clipboard contention and avoids a visible toast
    // winning the race with the clipboard write.
    await copyAfterSave(imagePackClipboardMode, savedHandle.dirPath)
    showSaveToast({
      folderPath: savedHandle.dirPath,
      hasBlur: annotations.some((annotation) => annotation.blur),
      replayUnavailable: null,
      renderState:
        settings.imageClipboardAfterSave === 'image' ? 'image-rendering' : 'none',
      uiLanguage: uiLanguage(settings),
    })
    startKeyframeStill(
      savedHandle,
      {
        snapshotPng: input.snapshotPng,
        annotations,
        displayNumbers: globalDisplayNumbers(annotations),
        focusedDisplay: 1,
        width,
        height,
        docLanguage: packDocLanguage(settings),
      },
      settings.imageClipboardAfterSave === 'image'
        ? {
            onRendered: async (png) => {
              const copied = await copyPngToClipboard(png)
              if (copied) {
                updateToastRenderStatus(savedHandle.dirPath, 'image-copied')
              } else {
                logWarn('[image] final annotated image could not be copied to the clipboard')
                updateToastRenderStatus(savedHandle.dirPath, 'image-copy-failed')
              }
            },
            onFailed: () => {
              updateToastRenderStatus(savedHandle.dirPath, 'image-copy-failed')
            },
          }
        : {},
    )
  } catch (err) {
    logError('[image] save failed:', err)
    dialog.showErrorBox(uiT(settings)('app.saveFailedTitle'), errorMessage(err))
  }
}

async function runFlow(settings: Settings): Promise<void> {
  const triggerAt = Date.now()
  // Static object picking (GOAL "Static object picking (v0)"): the Windows UI
  // Automation dump is fired FIRST and never awaited on the critical path. It
  // runs concurrently with the snapshot, the replay fetch, and save-first, is
  // hard-killed at its budget, and resolves null on any failure — a capture can
  // neither fail nor slow down because of it.
  //
  // The Plugins switch is REAL (issue #57): off means no helper process is
  // spawned at all, so the sub-second cost genuinely leaves every capture. The
  // rest of the flow needs no branch — a disabled plugin resolves exactly like
  // a dump that produced nothing, which the editor already reports honestly as
  // "object picking is off for this capture".
  //
  // The skip is RECORDED, because the Plugins row reports what the LAST capture
  // did. Without this a capture taken while the switch was off left the previous
  // capture's counts in place, and re-enabling the plugin showed "Active — last
  // capture: 9 windows, 264 controls" about a capture two captures ago — exactly
  // the constant #57 forbids.
  let uiaDump: Promise<UiaRawDump | null>
  if (settings.uiaEnabled) {
    uiaDump = startUiaDump()
  } else {
    recordUiaSkipped()
    uiaDump = Promise.resolve(null)
  }
  // "all": every connected display is frozen, the cursor's display is the
  // FOCUSED one. "cursor"/fixed: that display alone. Snapshot, replay, editor,
  // and annotations all target the focused display.
  let frozen = await freezeDisplays(settings)
  // Every display replay is expressed on the focused recorder's pack clock.
  // If that clock master failed while a secondary recorder succeeded, keeping
  // the secondary would write an unclocked, unscrubbable and potentially
  // oversized ring segment. This RC intentionally degrades the whole capture
  // to its frozen frames instead of silently promoting a different monitor.
  const retainedReplays = retainedDisplayReplayMask(
    frozen.displays.map((candidate) => ({
      focused: candidate.focused,
      hasReplay: candidate.replayWebm !== null,
    })),
  )
  const orphanedSecondaryReplays = frozen.displays.reduce(
    (count, candidate, index) =>
      count + (candidate.replayWebm !== null && retainedReplays[index] !== true ? 1 : 0),
    0,
  )
  if (orphanedSecondaryReplays > 0) {
    const displays = frozen.displays.map((candidate, index) =>
      retainedReplays[index] === true ? candidate : withoutFrozenReplay(candidate),
    )
    logWarn(
      `[capture] focused replay unavailable — discarded ${orphanedSecondaryReplays} ` +
        'secondary replay(s) and kept a multi-display screenshot-only capture',
    )
    frozen = {
      ...frozen,
      displays,
      focused: displays.find((candidate) => candidate.focused) ??
        withoutFrozenReplay(frozen.focused),
    }
  }
  const allReplaysReadyAt = Date.now()
  const display = frozen.focused
  const snap = { png: display.snapshotPng, width: display.width, height: display.height }
  const replay =
    display.replayWebm === null
      ? null
      : {
          buffer: display.replayWebm,
          durationMs: display.replayDurationMs,
          mimeType: display.replayMimeType ?? 'video/webm',
          replayFile: display.replayFile ?? 'replay.webm',
        }
  const rawReplayDurationMs = replay === null ? 0 : replay.durationMs
  // The editor and every final pack clock expose only the last configured N
  // seconds. The raw recorder file remains 1x..2x N until the background plain
  // trim cuts it; a just-started buffer stays at its honest shorter duration.
  const replayDurationMs = Math.min(rawReplayDurationMs, settings.replaySeconds * 1000)
  const replaySourceStartMs = rawReplayDurationMs - replayDurationMs
  // PIXELS OWN THE CLOCK (#112). The renderer measured where the focused
  // replay's first byte lies on the shared wall-comparable axis before it began
  // stop/flush assembly. Receiving those bytes later — or waiting for a slower
  // secondary recorder in Promise.all — cannot move time already recorded.
  //
  // Save-first declares the raw ring, while the editor/final pack exposes its
  // logical last-N window. Resolve both from the same measured origin and add
  // the source in-point exactly once. Only an origin-less legacy renderer uses
  // main's pre-request wall time as an end anchor.
  let replayClock = resolveFocusedReplayTimelineClock({
    replayOriginMs: display.replayOriginMs,
    replayRequestWallMs: display.replayRequestWallMs,
    captureWallMs: triggerAt,
    rawDurationMs: rawReplayDurationMs,
    logicalDurationMs: replayDurationMs,
  })
  const presentationClockMap = observedReplayClockMap(display)
  const sourceClockMap = observedReplayClockMap(display, 'source')
  const contextClockMap = sourceClockMap ?? presentationClockMap
  let measuredClockCoversMediaEdges = false
  if (presentationClockMap !== null) {
    const mappedRawT0Ms = ptsToSessionMs(presentationClockMap, 0)
    const mappedPackT0Ms = ptsToSessionMs(
      presentationClockMap,
      replaySourceStartMs,
    )
    const mappedPackEndMs = ptsToSessionMs(
      presentationClockMap,
      replaySourceStartMs + replayDurationMs,
    )
    if (
      mappedRawT0Ms === undefined
      || mappedPackT0Ms === undefined
      || mappedPackEndMs === undefined
    ) {
      logWarn(
        '[context] replay pixel-clock anchors do not cover the saved media edges — ' +
          'absolute t0 uses the recorder-origin/wall fallback while observed ' +
          'context remains mapped inside the measured interval',
      )
    } else {
      measuredClockCoversMediaEdges = true
      replayClock = {
        rawT0Ms: mappedRawT0Ms,
        packT0Ms: mappedPackT0Ms,
        packEndMs: mappedPackEndMs,
        measured: true,
      }
    }
  }
  const rawT0Ms = replayClock.rawT0Ms
  const t0Ms = replayClock.packT0Ms
  const packWallTimeAt = (packTMs: number): number => {
    if (presentationClockMap !== null) {
      const measured = ptsToSessionMs(
        presentationClockMap,
        replaySourceStartMs + packTMs,
      )
      if (measured !== undefined) return measured
    }
    return t0Ms + packTMs
  }
  // PINS THE SURFACE TIMELINE for exactly the range this pack covers (#64
  // `onFreeze`, #65). From here the editor can ask "which window was where at
  // pack time T" for any T in the replay, and pruning may not touch that range
  // until it is released below.
  //
  // Frozen HERE and not at the trigger, because the range's start is
  // `trigger - replayDurationMs` and replayDurationMs is only known once the
  // replay has been fetched: a just-started buffer is shorter than the
  // configured length, and a range that claimed otherwise would put every pack
  // time a few seconds off. The delay costs nothing — retention keeps the
  // replay length plus a slack, and the prune runs at 1 Hz.
  // The tick clock's value at the SAVED replay's t=0, plus whatever the exact
  // -length cut drops from its head — that is where the pack clock starts (#112).
  const replayOriginWallMs =
    replayClock.measured ? replayClock.packT0Ms : undefined
  const contextFreezeId = freezeContext(
    replayClock.packEndMs,
    replayDurationMs,
    replayOriginWallMs,
    contextClockMap === null
      ? undefined
      : {
          anchors: contextClockMap.anchors.map((anchor) => ({
            ptsMs: anchor.ptsMs,
            wallMs: anchor.sessionMs,
          })),
          sourceStartPtsMs: replaySourceStartMs,
          maxExtrapolationMs: contextClockMap.maxExtrapolationMs,
        },
  )
  logInfo(
    `[context] pack clock: ${
      contextClockMap !== null
        ? `measured ${contextClockMap.anchors.length}-anchor ${
            sourceClockMap === null ? 'presentation' : 'source-exposure'
          } pixel map` +
          `${measuredClockCoversMediaEdges ? '' : ' (partial; absolute t0 fallback)'}`
        : replayClock.measured
          ? 'measured recorder origin'
          : 'wall fallback'
    }, ` +
      `end ${String(replayClock.packEndMs - triggerAt)} ms from trigger, ` +
      `${String(replayDurationMs)} ms long (raw ${String(rawReplayDurationMs)} ms); ` +
      `all display replies ready ${String(allReplaysReadyAt - triggerAt)} ms from trigger`,
  )
  logContextCost()
  // media.displays[] exists only when the capture actually covered more than
  // one display (SPEC §5.3): a single-display pack stays exactly what 0.1.2
  // wrote. The editor's board follows the same rule: one display, one screen.
  const multiDisplay = frozen.displays.length > 1
  // The focused recorder is the top-level media object even for a one-display
  // pack. Snapshot its measured cadence now: the recorder registry may rotate
  // or be torn down before the detached exact-cut/render finalizer runs.
  const focusedCadence = manifestCadence(display.id)
  // Save-first writes the uncut recorder files, so its per-display offsets are
  // measured from the focused RAW origin. The editor/final declaration starts
  // at the logical source in-point instead. Keeping both prevents a transient
  // save-first manifest from mixing a raw replay with the last-N pack clock.
  const rawDisplayCaptures = multiDisplay
    ? toDisplayCaptures(frozen.displays)
    : undefined
  const displayCaptures = multiDisplay
    ? toDisplayCaptures(frozen.displays, replaySourceStartMs)
    : undefined

  // ONE MAPPING SPACE PER CAPTURED DISPLAY (GOAL "Multi-Monitor Support").
  // These targets are shared by all three consumers — UIA dump mapping, the
  // live editor ring, and the persisted ring — so save/reopen cannot drift into
  // a different monitor or DPI conversion.
  const uiaTargets: UiaDisplayTarget[] = multiDisplay
    ? frozen.displays.map((d) => ({
        index: d.index,
        focused: d.focused,
        bounds: d.bounds,
        width: d.focused ? snap.width : d.width,
        height: d.focused ? snap.height : d.height,
      }))
    : [{ index: 1, focused: true, bounds: display.bounds, width: snap.width, height: snap.height }]
  const uiaFocusedIndex = uiaTargets.find((target) => target.focused)?.index ?? 1
  const snapshotScaleByIndex = new Map(
    multiDisplay
      ? frozen.displays.map((captured) => [captured.index, captured.scale] as const)
      : [[1, display.scale] as const],
  )
  const contextDisplays = uiaTargets.map((target) => {
    const snapshotPixelsPerDip = snapshotScaleByIndex.get(target.index)
    const desktopBounds = physicalContextBounds(target.bounds)
    return {
      index: target.index,
      focused: target.focused,
      width: target.width,
      height: target.height,
      ...(desktopBounds === undefined ? {} : { desktopBounds }),
      ...(snapshotPixelsPerDip === undefined ? {} : { snapshotPixelsPerDip }),
    }
  })

  // Freeze-to-observations happens ONCE. The fresh editor adopts this exact
  // array and the pack stores a lossless delta encoding of the same values;
  // reopening therefore cannot rerun coordinate projection through a different
  // path. Object history remains best effort — a failure yields no plugin and
  // cannot fail or delay the media save beyond this bounded in-memory read.
  let windowsContextObservations: ContextObservation[] = []
  let saveFirstWindowsContext: WindowsContextTimelineV1 | null = null
  if (contextFreezeId !== null) {
    try {
      windowsContextObservations = frozenObservations(
        contextFreezeId,
        contextDisplays,
        replayDurationMs,
      )
      // Save-first still declares the recorder's RAW file. Its last-N context
      // therefore begins at replaySourceStartMs on that raw clock. Final save
      // and cancel-finalize both trim/rebase this payload alongside the media.
      saveFirstWindowsContext = exportWindowsContextTimeline(
        windowsContextObservations,
        {
          startMs: 0,
          endMs: replayDurationMs,
          rebaseToMs: replaySourceStartMs,
        },
      )
      if (windowsContextObservations.length > 0 && saveFirstWindowsContext === null) {
        logWarn('[context] Windows history could not be encoded; capture continues without it')
      }
    } catch (err) {
      logError(
        `[context] Windows history could not be frozen; capture continues without it: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      windowsContextObservations = []
      saveFirstWindowsContext = null
    }
  }

  // SPEC §10.2: the trigger event carries the accelerator that fired it in
  // `data.hotkey` (report.md renders it). It is configurable, so it is read
  // from the live settings rather than spelled out anywhere.
  const events: TimelineEvent[] = [
    {
      t_ms: replayDurationMs,
      type: 'core.capture.triggered',
      source: 'core',
      data: { hotkey: settings.captureHotkey },
    },
  ]

  // Save-first (GOAL): the raw capture hits disk before the editor opens, so a
  // cancelled editor or a crash never loses it. Failure is non-fatal — the
  // editor still opens and Save retries the write from scratch.
  const initialSave: InitialSaveInput = {
    captureKind: 'video',
    snapshotPng: snap.png,
    width: snap.width,
    height: snap.height,
    capturedAt: new Date(triggerAt),
    replayWebm: replay === null ? null : replay.buffer,
    ...(replay === null ? {} : { replayFile: replay.replayFile }),
    // Save-first describes the raw bytes honestly. Finalization replaces this
    // declaration and clock together after the exact background cut.
    replayDurationMs: rawReplayDurationMs,
    cadence: focusedCadence,
    timeline: {
      t0: new Date(rawT0Ms).toISOString(),
      events: events.map((e) =>
        e.type === 'core.capture.triggered' ? { ...e, t_ms: rawReplayDurationMs } : e,
      ),
    },
    outputDir: settings.outputDir,
    // Save-first writes EVERY display (GOAL "Multi-Monitor Support"): a
    // cancelled editor or a crash must not lose the other screens either.
    displays: rawDisplayCaptures,
    screens: frozen.screens,
    ...(saveFirstWindowsContext === null
      ? {}
      : { windowsContext: saveFirstWindowsContext }),
    docLanguage: packDocLanguage(settings),
  }
  // The OUTCOME of the capture itself, before any editing: how many displays it
  // froze and how many of them actually had a replay (issue #60). This is the
  // line that turns "recording did not work" into a checkable fact.
  const withReplay = frozen.displays.filter((d) => d.replayWebm !== null).length
  logInfo(
    `[capture] captured ${frozen.displays.length} display(s), ${withReplay} with a replay ` +
      `(${Math.round(replayDurationMs)}ms on the focused display)`,
  )
  // WHAT THE RECORDER ACTUALLY ACHIEVED (#82), per display, on the record.
  //
  // The replay is the evidence a pack is built on and nothing in the app knew
  // how good it was: a capture that stalled for nearly a second, twice, wrote
  // exactly the same log line as a clean one, and it took ffprobe on the saved
  // file to tell them apart. Reported next to the configured rate, because a
  // number without the target it is being compared against says nothing.
  for (const d of frozen.displays) {
    const measured = recorderCadence(d.id)
    if (measured === null) continue
    const short = measured.achievedFps < settings.fps * 0.8
    const stalled = measured.worstStallMs >= 400
    // A LOW RATE IS TWO DIFFERENT FACTS (#82). A screen capture makes a frame
    // when the screen changes, so a monitor nobody touched delivers almost
    // nothing and has lost nothing. Frames MADE and thrown away are the case
    // where the replay really is missing time. `discardedFrames` is the only
    // thing that tells them apart, so the verdict waits on it rather than
    // calling every quiet monitor a fault.
    const discarded = measured.discardedFrames
    const line =
      `[capture] display ${d.index}: recorded ${measured.achievedFps} fps of ${settings.fps} ` +
      `requested, worst stall ${measured.worstStallMs} ms` +
      (discarded === undefined || discarded === null ? '' : `, ${discarded} frame(s) discarded`)
    // Frames that were never made are not frames that were lost. The shortfall
    // is what the target rate would have produced over the same window; if
    // almost none of it was discarded, it was never produced — measured on this
    // desk, display 1 came up 486 frames short and discarded two of them.
    const expected =
      measured.sampledMs === undefined ? null : (settings.fps * measured.sampledMs) / 1000
    const shortfall =
      expected === null || measured.gainedFrames === undefined
        ? null
        : Math.max(0, expected - measured.gainedFrames)
    const still =
      discarded !== undefined && discarded !== null && shortfall !== null && shortfall >= 1
        ? discarded < shortfall * 0.2
        : discarded === 0
    // AND WHAT THAT DID TO ITS CLOCK (#110). "The screen did not change" is
    // true and was where the account stopped. What it left out is that the
    // frames which WERE made are laid end to end, so the media is shorter than
    // the capture and its timeline is no longer the capture's — the thing that
    // actually puts a box in the wrong second.
    // The offset is what pays for a shorter secondary (SPEC 5.3), so it is
    // read from the captures already built above rather than guessed at.
    const declaredOffsetMs = displayCaptures?.find(
      (capture) => capture.index === d.index,
    )?.replayClockOffsetMs
    const coverage = replayCoverage(d.replayDurationMs ?? 0, replayDurationMs, declaredOffsetMs)
    const axis = coverage.compressed
      ? `, and ${(coverage.mediaMs / 1000).toFixed(1)}s of media for a ` +
        `${(coverage.captureMs / 1000).toFixed(1)}s capture is not this capture's clock`
      : ''
    if (still && (short || stalled)) {
      logInfo(
        `${line} — the missing frames were never made, not dropped, so this screen simply did not change${axis}`,
      )
    } else if (short || stalled) {
      logWarn(`${line} — the replay is missing time the user was looking at`)
    } else {
      logInfo(line)
    }
  }

  let handle: PackHandle | null = null
  try {
    handle = await savePack(initialSave)
    logInfo(`[capture] save-first wrote ${path.basename(handle.dirPath)}`)
  } catch (err) {
    logError('capturepack: save-first failed:', err)
  }

  // The dump's coordinates only become meaningful once the FOCUSED display is
  // known, which is why the mapping happens here rather than in the helper.
  // Neither promise may EVER reject: a rejection here would surface as
  // "Capture failed", and object data must never be able to fail a capture.
  //
  const uiaReady: Promise<UiaPluginPayload | null> = uiaDump
    .then((raw) => (raw === null ? null : mapUiaToSnapshot(raw, uiaTargets)))
    .catch((err: unknown) => {
      logError('capturepack: mapping the UI Automation dump failed:', err)
      return null
    })
  // Landing the payload in the SAVE-FIRST folder means a cancelled editor (or a
  // crash) still keeps the object data, exactly like the raw media.
  const uiaWrite: Promise<UiaPluginPayload | null> = uiaReady.then(async (payload) => {
    const saved = handle
    if (payload === null || saved === null) return payload
    try {
      await writeUiaPlugin(saved.dirPath, payload)
      await addManifestPlugin(saved, uiaPluginDeclaration(), packDocLanguage(settings))
    } catch (err) {
      logError(`capturepack: writing plugins/${UIA_PLUGIN_NAME} failed:`, err)
    }
    return payload
  })

  // The browser's half of the same instant (GOAL "Chrome Extension"). Written
  // beside the UIA payload, into the same save-first folder, and declared only
  // when there is something to declare — a capture made with no browser
  // talking has no chrome-dom directory at all, which SPEC §11.3 reads as
  // "nobody was watching" rather than "nothing happened".
  const domWindow = frozenWindow(contextFreezeId)
  const capturedDomEvents =
    domWindow === null ? [] : domEventsBetween(domWindow.startMs, domWindow.endMs)
  const domStatus = domBridgeStatus()
  const writeCapturedDomPlugin = async (saved: PackHandle | null): Promise<void> => {
    if (saved === null || domWindow === null || capturedDomEvents.length === 0) return
    const wrote = await tryWriteDomPlugin(saved.dirPath, {
      protocol: DOM_PROTOCOL_VERSION,
      extension_version: domStatus.extensionVersion,
      events: capturedDomEvents.flatMap((e: DomEvent) => {
        const packTMs = frozenPackTimeAt(contextFreezeId, e.tMs)
        if (packTMs === null) return []
        return [{
          // On the encoded replay's pack clock, like everything drawn beside it.
          t_ms: Math.max(0, Math.round(packTMs)),
          type: e.type,
          tab: e.tab,
          ...(e.element === undefined ? {} : { element: e.element }),
          // Without this a saved pick is unplaceable forever: bounds are viewport
          // CSS pixels and this is the only thing that says where that viewport
          // was. Absent for an event from an extension older than 0.1.4.
          ...(e.viewport === undefined ? {} : { viewport: e.viewport }),
        }]
      }),
    })
    if (!wrote) return
    try {
      await addManifestPlugin(saved, domPluginDeclaration(), packDocLanguage(settings))
      logInfo(`[chrome] pack carries ${capturedDomEvents.length} DOM event(s) from the browser`)
    } catch (err) {
      logError('capturepack: declaring plugins/chrome-dom failed:', err)
    }
  }
  const saveFirstHandle = handle
  const domWrite = writeCapturedDomPlugin(saveFirstHandle).catch((err: unknown) => {
    // Browser context is a source refinement, never permission to fail the
    // capture. Final save still waits for this settled result before publishing
    // its manifest, so a successful payload cannot race behind the save toast.
    logError('capturepack: saving plugins/chrome-dom failed:', err)
  })

  const { win: editor, mode: windowMode } = createEditorWindow(display.bounds, settings)
  // THE EDITOR'S OWN DIAGNOSTICS BELONG IN THE LOG (#113).
  //
  // The editor is the only place that sees both a track and the frames actually
  // being shown, so it is the only place that can say whether they line up. It
  // has been saying so to a console nobody reads, which is why every one of
  // these questions has needed a pack sent back and forth and ffprobe run over
  // it. Only its own lines are taken: a renderer's console is otherwise full of
  // Chromium's business.
  editor.webContents.on('console-message', (_event, level, message) => {
    if (!message.startsWith('capturepack:')) return
    if (level >= 2) logWarn(`[editor] ${message}`)
    else logInfo(`[editor] ${message}`)
  })
  editor.once('ready-to-show', () => {
    void (async () => {
      // The dump was started at the trigger and can never outlive its budget,
      // so this is a no-op wait in the normal case. When it IS still running,
      // the editor opens without objects and takes them the moment they land
      // (below) — a slow dump costs picking for a few hundred ms, never for the
      // session.
      const settled = await settleWithin(uiaReady, UIA_EDITOR_GRACE_MS)
      if (editor.isDestroyed()) return
      const uia = settled.ready ? settled.value : null
      // The Surface Resolver's session for this editor window (#66). Core's own
      // surface record and the Windows UI Automation provider both hang off it,
      // and the provider is registered through the same public registry an
      // external one would use — no private path into Core.
      // The browser's element picks, REBASED ONTO THE PACK CLOCK — the same
      // clock the ring and the video already agree on (SPEC §10.1), which is
      // what lets the DOM provider place an element against the very window
      // observation Core recorded at that instant.
      const domWindow = frozenWindow(contextFreezeId)
      const domPicks =
        domWindow === null
          ? []
          : domEventsBetween(domWindow.startMs, domWindow.endMs).flatMap((e) => {
              const packTMs = frozenPackTimeAt(contextFreezeId, e.tMs)
              return packTMs === null
                ? []
                : [{
                    ...e,
                    tMs: Math.max(0, Math.round(packTMs)),
                  }]
            })
      const contextSession = openContextSession(editor, {
        displays: contextDisplays,
        replayDurationMs,
        observation: contextObservation(uia, uiaFocusedIndex, replayDurationMs),
        dropped: settled.ready && uiaEmpty(uia),
        domEvents: domPicks,
      })
      // THE WHOLE FROZEN RANGE, not just the instant the hotkey was pressed.
      //
      // Core's surface ring holds the entire replay at 10 Hz and was frozen at
      // capture, but nothing handed it here — so the session filed itself as
      // `single-instant` and answered nothing anywhere except the last frame,
      // which is exactly what was reported ("context 창 선택이 마지막 정보에만
      // 맞아"). With the ring adopted the session becomes a `ring` and the
      // WINDOW rung answers at every recorded moment.
      //
      // The capture-instant UIA dump above keeps its own job: it is the CONTROL
      // rung, a refinement offered where a provider actually looked. The two
      // stay separate deliberately — Core mints windows, providers refine.
      if (contextFreezeId !== null) {
        // RULE 1 OF OBJECT DATA: IT MAY NEVER BREAK ANYTHING ELSE (#85).
        //
        // The editor already obeys this — a context frame that fails to build
        // leaves the previous one in place — but the save path did not, and it
        // is the save path that owns the capture flow. A `RangeError` from deep
        // inside the ring became an unhandled rejection here, the flow never
        // closed, and every later press of the hotkey was answered with
        // "capture requested while a flow was already open — ignored". The user
        // pressed it seventeen times and had to restart the app.
        //
        // A capture is the replay, the snapshot and the annotations. Picking is
        // a refinement on top. Losing the refinement must cost the refinement
        // and nothing else.
        const ring = windowsContextObservations
        if (ring.length > 1) {
          contextSession.adoptAll(ring)
          logInfo(
            `[context] editor session reads ${ring.length} surface observations ` +
              `across ${replayDurationMs} ms`,
          )
        } else {
          // Honest silence: no ring means picking answers where the dump does
          // and says so through `accuracy.coverage`, rather than pretending.
          logWarn(
            '[context] no surface ring for this capture — picking answers at the capture instant only',
          )
        }
      }
      if (settled.ready && uiaEmpty(uia)) {
        // GOAL "Silence is not absence": the editor is about to open with
        // picking off, and until this line the only trace was an empty index.
        logWarn(
          'capturepack: object picking: the UI Automation dump produced nothing usable for this capture',
        )
      }
      const init: EditorInitPayload = {
        captureKind: 'video',
        snapshotPng: toArrayBuffer(snap.png),
        width: snap.width,
        height: snap.height,
        hasReplay: replay !== null,
        replayDurationMs,
        replaySourceStartMs,
        // The editor BOARD (GOAL "Multi-Monitor Support"): every frozen display
        // with its geometry and its own replay, drawn side by side in the real
        // arrangement and all of them annotatable.
        displays: toEditorDisplays(frozen.displays, replayDurationMs),
        // Replay bytes are already in memory; the editor scrubs its own copy and
        // never re-requests them at export time.
        replayWebm: replay === null ? null : toArrayBuffer(replay.buffer),
        replayMimeType: replay?.mimeType ?? null,
        // No replay for the focused display: the editor says WHY rather than
        // opening on a bare "No replay" chip (GOAL "Say that you are
        // recording"), so the failure is met here and not in the saved folder.
        replayUnavailableReason: replay === null ? display.replayUnavailableReason : null,
        // OBJECT PICKING AT A TIME (#64/#65/#66): the session the editor asks
        // frames on, opened with the frame at the CAPTURE INSTANT, which is
        // where the editor opens. Empty when the observation has not landed yet
        // — the push below then carries the real one.
        context: { sessionId: contextSession.sessionId, frame: await contextSession.frameAt(replayDurationMs) },
        fps: settings.fps,
        scrubInvert: settings.scrubInvert,
        scrubSensitivityMs: settings.scrubSensitivityMs,
        defaultManualDurationMs: settings.defaultManualDurationMs,
        showDurationLabel: settings.showDurationLabel,
        showShortcutOverlay: settings.showShortcutOverlay,
        showEditorTutorial: settings.showEditorTutorial,
        annotations: [],
        title: '',
        note: '',
        editMode: false,
        uiLanguage: uiLanguage(settings),
        // Fullscreen overlay or real window (GOAL "Editor Window Mode") — how
        // the user left it last time.
        windowMode,
      }
      await initializeAndShowEditor(editor, init)
      // The dump was not back in time: hand it over the moment it is, rather
      // than throwing away a payload the capture already paid for. The editor
      // rebuilds its object indexes and picking simply starts working.
      if (!settled.ready) {
        void uiaReady
          .then((payload) => {
            if (editor.isDestroyed()) return
            if (uiaEmpty(payload)) {
              logWarn(
                'capturepack: object picking: the UI Automation dump produced nothing usable for this capture',
              )
            }
            contextSession.adopt(contextObservation(payload, uiaFocusedIndex, replayDurationMs))
            contextSession.markDropped(uiaEmpty(payload))
            pushContextFrame(editor, contextSession, replayDurationMs)
          })
          // Rule 1 again: object data may never be able to fail a capture, and
          // an unhandled rejection here would be an uncaughtException.
          //
          // The editor was told `uiaDropped: false` because the dump was still
          // RUNNING, and it is waiting for this push: a failure that only logged
          // would leave picking silently off for the whole session, which is the
          // one thing "Silence is not absence" forbids. However this promise
          // ended, the editor gets an answer.
          .catch((err: unknown) => {
            logError('capturepack: pushing object data to the editor failed:', err)
            try {
              if (editor.isDestroyed()) return
              contextSession.adopt(null)
              contextSession.markDropped(true)
              pushContextFrame(editor, contextSession, replayDurationMs)
            } catch {
              // A window that went away mid-send: nothing left to tell.
            }
          })
      }
    })().catch((err: unknown) => {
      // NOTHING IN HERE MAY STRAND THE FLOW (#85).
      //
      // This block is detached — `ready-to-show` cannot await it — so a throw
      // inside it became an unhandled rejection, `editor.show()` never ran, and
      // `runEditor` below waited forever on a window the user could not see.
      // `flowActive` stayed true in a `finally` that was never reached, and the
      // capture hotkey answered "a flow was already open" until the app was
      // restarted. That is what a user hit: seventeen presses, nothing.
      //
      // The pack itself is already on disk by now (save-first), so the honest
      // recovery is to close the editor rather than show one that was never
      // initialised: `runEditor` resolves on the window closing, the flow ends,
      // and the next press of the hotkey works.
      logError('[capture] preparing the editor failed — closing it so the flow can end:', err)
      if (!editor.isDestroyed()) editor.destroy()
    })
  })

  let outcome: EditorOutcome
  try {
    outcome = await runEditor(editor, events, t0Ms)
  } finally {
    // The pin comes off when the editor closes (#64 `onFreeze`: "pin the
    // captured range so it survives until the editor closes or the pack is
    // saved"), in a finally so a throw cannot leak it — a leaked freeze would
    // keep the ring from ever pruning that range again.
    //
    // NOTE for the export step: docs/temporal-protocol.md GAP 14b wants the
    // provider's export SET requested at freeze time and held until release, so
    // saving from History minutes later still works. Nothing writes provider
    // context into the pack yet, so releasing here is currently exact.
    releaseContext(contextFreezeId)
  }
  logInfo(`[capture] editor closed: ${outcome.kind}`)
  if (outcome.kind === 'cancel') {
    // A cancelled editor still leaves the save-first pack behind. Its raw ring
    // segment may exceed N, so cut that pack in the same serialized background
    // renderer even though there are no annotations to finalize.
    const savedHandle = handle
    if (savedHandle !== null && replay !== null && replaySourceStartMs > 0) {
      void uiaWrite
        .then(() =>
          finalizeCancelledExactReplay(
            savedHandle,
            initialSave,
            frozen,
            replayDurationMs,
            replaySourceStartMs,
            settings,
          ),
        )
        .catch((err: unknown) =>
          logError('capturepack: cancelled capture finalization failed:', err),
        )
    }
    return
  }

  // Every source plugin must settle before final source publication. UIA and
  // Chrome write on independent capture-time paths; allowing either manifest
  // declaration to trail updatePack made a just-saved pack look randomly
  // under-captured through MCP until that detached write happened to finish.
  // Awaiting here normally costs nothing — both capture budgets elapsed while
  // the user was editing.
  const [uiaPayload] = await Promise.all([uiaWrite, domWrite])

  // The replay is ALWAYS kept when one exists (GOAL "No include-replay
  // toggle"): what leaves the machine is decided at share time, not here. It
  // stays null for a screenshot-only capture (no recorder / recorder failure /
  // replay timeout), which every path below still handles.
  const replayWebm = replay !== null ? replay.buffer : null

  // The exporter appends the core.export.created event itself.
  // t0 is the start of the declared replay (SPEC §10.1). No rebase is possible here:
  // the replay is always kept when one exists, so a null replayWebm means the
  // capture had none, replayDurationMs is 0, and t0Ms IS the trigger instant.
  // (The re-edit flow below DOES rebase — there a declared replay can be
  // missing from the folder.)
  const timeline: TimelineFile = { t0: new Date(t0Ms).toISOString(), events }

  // Same reason: replay positions have no timeline to anchor to without the
  // replay, so drop snapshot_t_ms (SPEC §5.3) and annotation lifetimes
  // (start_ms/end_ms) (SPEC §8.4).
  const annotations =
    replayWebm === null
      ? outcome.payload.annotations.map(withoutReplayTimes)
      : outcome.payload.annotations
  const snapshotTMs = replayWebm === null ? null : outcome.payload.snapshotTMs

  // User trim handles operate inside the logical last-N-second editor clock.
  // The mandatory ring-buffer cut is outside that clock: combine the two only
  // when selecting the raw source range, and rebase metadata for the user trim
  // alone because editor-authored times are already last-N-relative.
  const trim = replayWebm === null ? null : resolveTrim(outcome.payload, replayDurationMs)
  const keptRange: TrimRange =
    trim ?? { startMs: 0, endMs: replayDurationMs, lengthMs: replayDurationMs }
  const finalAnnotations = trim === null ? annotations : rebaseAnnotationsForTrim(annotations, trim)
  const finalSnapshotTMs =
    trim === null ? snapshotTMs : rebaseSnapshotTMsForTrim(snapshotTMs, trim)
  const finalTimeline: TimelineFile =
    trim === null
      ? timeline
      : {
          t0: new Date(packWallTimeAt(trim.startMs)).toISOString(),
          events: events.map((e) => ({ ...e, t_ms: Math.max(0, e.t_ms - trim.startMs) })),
        }
  const sourceTrimStartMs = replaySourceStartMs + keptRange.startMs
  const needsExactCut =
    replayWebm !== null &&
    (sourceTrimStartMs > 0 || replaySourceStartMs + keptRange.endMs < rawReplayDurationMs)
  let finalWindowsContext: WindowsContextTimelineV1 | null = null
  try {
    if (windowsContextObservations.length > 0) {
      finalWindowsContext = exportWindowsContextTimeline(
        windowsContextObservations,
        {
          startMs: keptRange.startMs,
          endMs: keptRange.endMs,
          rebaseToMs: 0,
        },
      )
    }
  } catch (err) {
    logError(
      `[context] Windows history could not be trimmed; final save omits it: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }

  const input: ExportInput = {
    captureKind: 'video',
    snapshotPng: Buffer.from(outcome.payload.snapshotPng),
    width: snap.width,
    height: snap.height,
    capturedAt: new Date(triggerAt),
    replayWebm,
    ...(replay === null ? {} : { replayFile: replay.replayFile }),
    replayDurationMs: keptRange.lengthMs,
    cadence: focusedCadence,
    annotations: finalAnnotations,
    title: outcome.payload.title,
    note: outcome.payload.note,
    snapshotTMs: finalSnapshotTMs,
    ...(sourceTrimStartMs > 0 ? { trimOffsetMs: sourceTrimStartMs } : {}),
    timeline: finalTimeline,
    displays: displayCaptures,
    screens: frozen.screens,
    // Rewritten (and declared) by the finalize save too, so a save-first that
    // failed and had to be retried below still ends up with the object data.
    uia: uiaPayload ?? undefined,
    // Concrete value replaces the raw-clock save-first payload; null removes
    // it so an encoding failure can never leave stale coordinates declared.
    windowsContext: finalWindowsContext,
    clipboardAfterSave: settings.clipboardAfterSave,
    docLanguage: packDocLanguage(settings),
  }

  try {
    // Save-first failed earlier? Retry the initial write now. Final source
    // publication below is still the visible save boundary.
    if (handle === null) handle = await savePack(initialSave)
    const savedHandle = handle
    if (saveFirstHandle === null) {
      // The detached save-first attempt had no folder to enrich. The DOM
      // snapshot itself was already frozen above, so land that exact source in
      // the retry folder before its final manifest is published.
      await writeCapturedDomPlugin(savedHandle)
    }
    const hasReplay = replayWebm !== null
    // Save-first already owns every raw display byte. Final source publication
    // only needs their declarations, not another tens-of-megabytes rewrite.
    // Keeping the buffers null also makes this completion time independent of
    // replay size — annotations, timeline, docs and plugins become readable
    // before any exact trim or annotated render can begin.
    const sourceInput: ExportInput = {
      ...input,
      displays: input.displays?.map((candidate) => ({
        ...candidate,
        snapshotPng: null,
        replayWebm: null,
      })),
    }

    await startSourceFirstFinalSave({
      persistSource: async () => {
        // keepReplay preserves the raw save-first media while publishing the
        // final authored source revision. A later exact cut replaces only the
        // derived media declaration/bytes; it does not create the annotations.
        await updatePack(savedHandle, sourceInput, { keepReplay: true })
        logInfo(
          `[capture] source saved ${path.basename(savedHandle.dirPath)}: ` +
            `${input.annotations.length} annotation(s), replay ${hasReplay ? 'included' : 'MISSING'}; ` +
            `derived media ${needsExactCut ? 'trim pending' : 'render pending'}`,
        )
        // The prompt/path and every source document are readable before the
        // visible completion signal. copyAfterSave verifies/retries clipboard.
        await copyAfterSave(settings.clipboardAfterSave, savedHandle.dirPath)
        showSaveToast({
          folderPath: savedHandle.dirPath,
          hasBlur: input.annotations.some((a) => a.blur),
          // "Saved" means the source is durable, never that a minute-long
          // derived render has already completed.
          replayUnavailable: replayUnavailableForToast(frozen.displays),
          renderState: hasReplay ? (needsExactCut ? 'trimming' : 'rendering') : 'none',
          uiLanguage: uiLanguage(settings),
        })
        return savedHandle.dirPath
      },
      renderDerived: async (sourceDirPath) => {
        logInfo(
          `[capture] derived media started ${path.basename(savedHandle.dirPath)}: ` +
            `${needsExactCut ? 'exact trim then annotated render' : 'annotated render'}`,
        )
        const finalDisplays =
          replayWebm !== null && needsExactCut
            ? await cutCapturedDisplays(
                frozen.displays,
                display.index,
                replayDurationMs,
                keptRange,
                settings.fps,
              )
            : frozen.displays
        const finalFocused = finalDisplays.find((candidate) => candidate.focused) ?? display
        const finalInput: ExportInput = {
          ...input,
          replayWebm: finalFocused.replayWebm,
          ...(finalFocused.replayFile === null
            ? {}
            : { replayFile: finalFocused.replayFile }),
          replayDurationMs: finalFocused.replayDurationMs,
          displays: multiDisplay ? toDisplayCaptures(finalDisplays) : undefined,
        }
        if (needsExactCut) {
          // The source revision is already durable. This second update only
          // swaps the raw media declaration/bytes for the exact cut result.
          await updatePack(savedHandle, finalInput)
          if (finalFocused.replayWebm !== null) {
            updateToastRenderStatus(sourceDirPath, 'rendering')
          }
        }
        startFreshCaptureRenders(
          savedHandle,
          finalInput,
          finalDisplays,
          display.index,
          settings,
          sourceDirPath,
        )
      },
      onDerivedFailure: async (err) => {
        if (appIsQuitting) {
          // The source revision is already durable. Queue shutdown on app quit
          // is intentional cancellation, not permission to rewrite that source
          // into the screenshot-only trim-failure fallback while Windows is
          // tearing the process down.
          logInfo(
            `[capture] derived media cancelled during shutdown: ${path.basename(savedHandle.dirPath)}`,
          )
          return
        }
        if (needsExactCut) {
          await handleExactCutFailure(
            savedHandle,
            input,
            frozen,
            display.index,
            settings,
            err,
          )
          return
        }
        logError('capturepack: derived annotated render failed after source save:', err)
        updateToastRenderStatus(savedHandle.dirPath, 'failed')
      },
    })
  } catch (err) {
    logError('[capture] save failed:', err)
    dialog.showErrorBox(uiT(settings)('app.saveFailedTitle'), errorMessage(err))
  }
}

/**
 * Cuts every recorded display to the same observed wall-clock interval. The
 * focused display defines the pack clock; an origin-less legacy recorder falls
 * back to end-alignment, and a shorter secondary remains honestly shorter
 * rather than being padded. All jobs pass through the global render queue, so
 * multi-display finalization never fans out encoders.
 */
async function cutCapturedDisplays(
  displays: readonly FrozenDisplay[],
  focusedIndex: number,
  focusedWindowDurationMs: number,
  keptRange: TrimRange,
  fps: number,
): Promise<FrozenDisplay[]> {
  const focused = displays.find((d) => d.index === focusedIndex && d.focused)
  if (focused === undefined) throw new Error('focused display is missing from exact replay cut')

  const focusedSourceStart = focused.replayDurationMs - focusedWindowDurationMs
  const packOriginMs = observedReplayWallTimeAt(
    focused,
    focusedSourceStart,
  )
  const keptStartWallMs = observedReplayWallTimeAt(
    focused,
    focusedSourceStart + keptRange.startMs,
  )
  const keptEndWallMs = observedReplayWallTimeAt(
    focused,
    focusedSourceStart + keptRange.endMs,
  )
  const cutFocused = await cutFrozenDisplay(
    focused,
    focusedSourceStart + keptRange.startMs,
    focusedSourceStart + keptRange.endMs,
    fps,
  )

  const result: FrozenDisplay[] = []
  for (const display of displays) {
    if (display.index === focused.index) {
      result.push(cutFocused)
      continue
    }
    const mappedStartMs =
      keptStartWallMs === undefined
        ? undefined
        : observedReplayPtsAtWallTime(display, keptStartWallMs)
    const mappedEndMs =
      keptEndWallMs === undefined
        ? undefined
        : observedReplayPtsAtWallTime(display, keptEndWallMs)
    const { startMs, endMs } =
      mappedStartMs !== undefined
      && mappedEndMs !== undefined
      && mappedEndMs >= mappedStartMs
        ? { startMs: mappedStartMs, endMs: mappedEndMs }
        : displayReplayRangeMs(
            keptRange.startMs,
            keptRange.endMs,
            observedReplayClockOffsetMs(
              packOriginMs,
              observedReplayWallTimeAt(display, 0),
            ),
            display.replayDurationMs,
            focusedWindowDurationMs,
          )
    try {
      result.push(await cutFrozenDisplay(display, startMs, endMs, fps))
    } catch (err) {
      // A secondary replay must never hold up or invalidate the focused pack.
      // Drop that replay declaration; its native snapshot remains annotatable.
      logError(`capturepack: exact replay cut failed for display ${display.index}:`, err)
      result.push(withoutFrozenReplay(display))
    }
  }
  return result
}

async function cutFrozenDisplay(
  display: FrozenDisplay,
  rawStartMs: number,
  rawEndMs: number,
  fps: number,
): Promise<FrozenDisplay> {
  if (
    display.replayWebm === null ||
    display.replayMimeType === null ||
    display.replayFile === null ||
    display.replayDurationMs <= 0
  ) {
    return display
  }
  const startMs = Math.min(
    display.replayDurationMs,
    Math.max(0, Math.round(rawStartMs)),
  )
  const endMs = Math.min(
    display.replayDurationMs,
    Math.max(0, Math.round(rawEndMs)),
  )
  if (endMs <= startMs) return withoutFrozenReplay(display)
  if (startMs === 0 && endMs === display.replayDurationMs) return display

  const replayWebm = await renderTrimmedReplay({
    replayWebm: display.replayWebm,
    replayMimeType: display.replayMimeType,
    width: display.width,
    height: display.height,
    fps,
    sourceDurationMs: display.replayDurationMs,
    trimStartMs: startMs,
    trimEndMs: endMs < display.replayDurationMs ? endMs : null,
  })
  const measuredMap = observedReplayClockMap(display)
  const mappedOriginMs =
    measuredMap === null ? undefined : ptsToSessionMs(measuredMap, startMs)
  // renderTrimmedReplay re-encodes onto a new WebM PTS grid. Raw MP4
  // same-frame anchors cannot be relabelled as observations of those newly
  // encoded frames, so retain only the mapped cut-boundary origin when it was
  // actually inside the measured range.
  const {
    replayClockAnchors: _discardedRawClockAnchors,
    replaySourceClockAnchors: _discardedRawSourceClockAnchors,
    ...displayWithoutRawClockAnchors
  } = display
  return {
    ...displayWithoutRawClockAnchors,
    replayWebm,
    replayDurationMs: endMs - startMs,
    ...(mappedOriginMs !== undefined
      ? { replayOriginMs: mappedOriginMs }
      : display.replayOriginMs === undefined
        ? {}
        : { replayOriginMs: display.replayOriginMs + startMs }),
    replayMimeType: 'video/webm',
    replayFile: 'replay.webm',
  }
}

function withoutFrozenReplay(display: FrozenDisplay): FrozenDisplay {
  const {
    replayOriginMs: _discardedReplayOrigin,
    replayClockAnchors: _discardedReplayClockAnchors,
    replaySourceClockAnchors: _discardedReplaySourceClockAnchors,
    ...displayWithoutReplayClock
  } = display
  return {
    ...displayWithoutReplayClock,
    replayWebm: null,
    replayDurationMs: 0,
    replayMimeType: null,
    replayFile: null,
  }
}

function startFreshCaptureRenders(
  handle: PackHandle,
  input: ExportInput,
  displays: readonly FrozenDisplay[],
  focusedIndex: number,
  settings: Settings,
  dirPath: string,
): void {
  const focused = displays.find((d) => d.index === focusedIndex) ?? displays.find((d) => d.focused)
  const focusedAnnotations = annotationsOnDisplay(input.annotations, focusedIndex, focusedIndex)
  const numbers = globalDisplayNumbers(input.annotations)
  const motionSpace = motionSpaceFromFrozenDisplays(displays, focusedIndex)
  if (
    input.replayWebm !== null &&
    focused?.replayMimeType !== null &&
    focused?.replayMimeType !== undefined
  ) {
    startAnnotatedRender(
      handle,
      {
        replayWebm: input.replayWebm,
        replayMimeType: focused.replayMimeType,
        annotations: focusedAnnotations,
        motionSpace,
        displayNumbers: numbers,
        focusedDisplay: focusedIndex,
        width: input.width,
        height: input.height,
        fps: settings.fps,
        replayDurationMs: input.replayDurationMs,
        docLanguage: packDocLanguage(settings),
      },
      (state) => updateToastRenderStatus(dirPath, state),
      (ratio) => updateToastRenderStatus(dirPath, 'rendering', ratio),
    )
  } else {
    startKeyframeStill(handle, {
      snapshotPng: input.snapshotPng,
      annotations: focusedAnnotations,
      motionSpace,
      displayNumbers: numbers,
      focusedDisplay: focusedIndex,
      width: input.width,
      height: input.height,
      docLanguage: packDocLanguage(settings),
    })
  }

  if (displays.length > 1) {
    const focusedDurationMs = focused?.replayDurationMs ?? 0
    const packOriginMs = observedReplayWallTimeAt(focused, 0)
    startDisplayRenders(
      handle,
      displays.map((d) => ({
        index: d.index,
        width: d.width,
        height: d.height,
        snapshotPng: d.snapshotPng,
        replayWebm: d.replayWebm,
        replayMimeType: d.replayMimeType,
        replayDurationMs: d.replayDurationMs,
        offsetMs: resolvedReplayClockOffsetMs(
          observedReplayClockOffsetMs(
            packOriginMs,
            observedReplayWallTimeAt(d, 0),
          ),
          d.replayDurationMs,
          focusedDurationMs,
        ),
      })),
      input.annotations,
      focusedIndex,
      motionSpace,
      settings.fps,
      packDocLanguage(settings),
    )
  }
}

async function handleExactCutFailure(
  handle: PackHandle,
  input: ExportInput,
  frozen: { displays: FrozenDisplay[] },
  focusedIndex: number,
  settings: Settings,
  err: unknown,
): Promise<void> {
  // Never fall back to the oversized ring segment: screenshot-only is the
  // honest degradation and preserves the "never longer than N" guarantee.
  logError('capturepack: exact replay cut failed; saving screenshot-only:', err)
  const displays = frozen.displays.map(withoutFrozenReplay)
  const fallback: ExportInput = {
    ...input,
    replayWebm: null,
    replayDurationMs: 0,
    annotations: input.annotations.map(withoutReplayTimes),
    snapshotTMs: null,
    trimOffsetMs: null,
    timeline: {
      t0: isoWithOffset(input.capturedAt),
      events: input.timeline.events.map((e) => ({
        ...e,
        t_ms: Math.max(0, e.t_ms - input.replayDurationMs),
      })),
    },
    displays: displays.length > 1 ? toDisplayCaptures(displays) : undefined,
    windowsContext:
      input.windowsContext === undefined || input.windowsContext === null
        ? null
        : trimWindowsContextTimeline(
            input.windowsContext,
            input.snapshotTMs ?? input.replayDurationMs,
            input.snapshotTMs ?? input.replayDurationMs,
          ),
  }
  try {
    await updatePack(handle, fallback)
    updateToastRenderStatus(handle.dirPath, 'failed')
    startFreshCaptureRenders(handle, fallback, displays, focusedIndex, settings, handle.dirPath)
  } catch (fallbackErr) {
    logError('capturepack: screenshot-only trim fallback failed:', fallbackErr)
  }
  void dialog.showMessageBox({
    type: 'error',
    title: 'CapturePack',
    message: uiT(settings)('app.trimFailed', { error: errorMessage(err) }),
  })
}

async function finalizeCancelledExactReplay(
  handle: PackHandle,
  initial: InitialSaveInput,
  frozen: { displays: FrozenDisplay[] },
  replayDurationMs: number,
  replaySourceStartMs: number,
  settings: Settings,
): Promise<void> {
  const focused = frozen.displays.find((d) => d.focused)
  if (focused === undefined) return
  let displays: FrozenDisplay[]
  try {
    displays = await cutCapturedDisplays(
      frozen.displays,
      focused.index,
      replayDurationMs,
      { startMs: 0, endMs: replayDurationMs, lengthMs: replayDurationMs },
      settings.fps,
    )
  } catch (err) {
    logError('capturepack: cancelled capture exact cut failed; keeping it screenshot-only:', err)
    displays = frozen.displays.map(withoutFrozenReplay)
  }
  const finalFocused = displays.find((d) => d.focused) ?? withoutFrozenReplay(focused)
  const initialRawT0Ms = Date.parse(initial.timeline.t0)
  const finalReplayT0Ms =
    finalFocused.replayOriginMs ??
    (Number.isFinite(initialRawT0Ms)
      ? initialRawT0Ms + replaySourceStartMs
      : initial.capturedAt.getTime() - replayDurationMs)
  const finalWindowsContext =
    initial.windowsContext === undefined
      ? undefined
      : initial.windowsContext === null
        ? null
        : trimWindowsContextTimeline(
            initial.windowsContext,
            finalFocused.replayWebm === null ? initial.replayDurationMs : replaySourceStartMs,
            initial.replayDurationMs,
          )
  await updateInitialPack(handle, {
    ...initial,
    replayWebm: finalFocused.replayWebm,
    ...(finalFocused.replayFile === null ? {} : { replayFile: finalFocused.replayFile }),
    replayDurationMs: finalFocused.replayDurationMs,
    ...(finalFocused.replayWebm !== null && replaySourceStartMs > 0
      ? { trimOffsetMs: replaySourceStartMs }
      : {}),
    timeline:
      finalFocused.replayWebm === null
        ? {
            t0: isoWithOffset(initial.capturedAt),
            events: initial.timeline.events.map((e) => ({ ...e, t_ms: 0 })),
          }
        : {
            // Exact-cut media and timeline share the same rebased origin. When
            // the renderer measured it, cutFrozenDisplay already advanced that
            // origin by the removed source interval; old origin-less saves
            // advance their persisted raw t0 by the same amount.
            t0: new Date(finalReplayT0Ms).toISOString(),
            events: initial.timeline.events.map((e) => ({
              ...e,
              t_ms: Math.max(0, e.t_ms - replaySourceStartMs),
            })),
          },
    displays: displays.length > 1 ? toDisplayCaptures(displays) : undefined,
    windowsContext: finalWindowsContext,
  })
}

// Re-edit (GOAL "History — Open & re-edit"): the Folder IS the project — no
// conversion step. Everything is read back from the pack folder, the editor
// restores it, and Save updates the SAME folder through the existing pipeline
// with one hard rule: the declared replay file is NEVER rewritten on re-edit.
async function runEditFlow(dirPath: string, settings: Settings): Promise<void> {
  const pack = openPack(dirPath, 'dir', path.basename(dirPath))
  const manifest = pack.manifest()
  if (manifest === null || typeof manifest.id !== 'string') {
    throw new Error('manifest.json is missing or malformed')
  }
  const loadedCapture = captureMetadataFromManifest(manifest)
  const snapshotPng = pack.readBinary('snapshot.png')
  if (snapshotPng === null) throw new Error('snapshot.png is missing')

  const annotationsFile = pack.annotations()
  // Entry-level validation (matching History's annotationsOf): a hand-edited
  // annotations.json can hold null/non-object elements — they must never reach
  // EditorState.restore(), where a.annotation_id on null would blow up the
  // fullscreen editor with an unhandled rejection.
  const loadedAnnotations: Annotation[] = Array.isArray(annotationsFile?.annotations)
    ? annotationsFile.annotations.filter((a) => a !== null && typeof a === 'object')
    : []
  // The annotation coordinate space: reference size from annotations.json,
  // falling back to the snapshot's own pixel size for external packs.
  let width = typeof annotationsFile?.reference_width === 'number' ? annotationsFile.reference_width : 0
  let height = typeof annotationsFile?.reference_height === 'number' ? annotationsFile.reference_height : 0
  if (width <= 0 || height <= 0) {
    const size = nativeImage.createFromBuffer(snapshotPng).getSize()
    width = size.width
    height = size.height
  }
  if (width <= 0 || height <= 0) throw new Error('snapshot.png is unreadable')

  // Replay: the manifest declares it, the bytes come from the folder. Declared
  // but missing on disk degrades to screenshot-only editing (like a capture
  // without a replay) — lifetimes are then stripped on save.
  // The name the pack DECLARES (SPEC §5.3 allows replay.mp4), validated before
  // it is used as a path or written back into the regenerated manifest.
  const replayRel = typeof manifest.media?.replay === 'string' ? replayFileName(manifest.media.replay) : null
  const replayWebm = replayRel !== null ? pack.readBinary(replayRel) : null
  // The duration the manifest DECLARES, kept even when the replay file is
  // missing on disk: the degraded save must rebase the loaded timeline off it.
  const declaredDurationMs =
    replayRel !== null && typeof manifest.media.replay_duration_ms === 'number'
      ? Math.max(0, manifest.media.replay_duration_ms)
      : 0
  const replayDurationMs = replayWebm !== null ? declaredDurationMs : 0
  const loadedSnapshotTMs =
    typeof manifest.media?.snapshot_t_ms === 'number' ? manifest.media.snapshot_t_ms : null
  // trim_offset_ms provenance (GOAL "Replay Trim"): a re-edit save regenerates
  // the manifest, so a loaded value must survive — re-edit can never trim
  // further, only carry the original in-point through.
  const loadedTrimOffsetMs =
    typeof manifest.media?.trim_offset_ms === 'number' ? manifest.media.trim_offset_ms : null
  // Plugin declarations from the loaded manifest (entry-validated): this pack
  // may carry the exporter's own windows-uia payload, and an external one may
  // declare anything else — a re-edit save regenerates the manifest, so the
  // declaration must survive (GOAL "Open & re-edit" restores DOM/UIA metadata).
  // Entries whose payload directory has since vanished are dropped, the same
  // rule the per-display media follows: never declare a missing file.
  const loadedPlugins: Manifest['plugins'] = Array.isArray(manifest.plugins)
    ? manifest.plugins.filter(
        (p) =>
          p !== null &&
          typeof p === 'object' &&
          // The SPEC §5.4 name pattern, checked BEFORE the name is joined into
          // a path: a hand-edited manifest must not be able to point the
          // existence check anywhere outside the pack's own plugins/ folder.
          typeof p.name === 'string' &&
          PLUGIN_NAME_RE.test(p.name) &&
          existsSync(path.join(dirPath, 'plugins', p.name, 'meta.json')),
      )
    : []
  const loadedWindowsContextDeclared = loadedPlugins.some(
    (plugin) =>
      plugin !== null
      && typeof plugin === 'object'
      && plugin.name === WINDOWS_CONTEXT_PLUGIN_NAME,
  )
  let loadedWindowsContext: WindowsContextTimelineV1 | null = null
  let loadedWindowsContextObservations: ContextObservation[] = []
  if (loadedWindowsContextDeclared) {
    const history = loadWindowsContextHistory(pack, declaredDurationMs)
    if (history.status === 'loaded') {
      loadedWindowsContext = history.timeline
      loadedWindowsContextObservations = history.observations
    } else {
      logWarn(
        `[context] plugins/${WINDOWS_CONTEXT_PLUGIN_NAME}/timeline.json was dropped ` +
          `(${history.reason}${history.bytes === null ? '' : `, ${String(history.bytes)} bytes`}); ` +
          're-edit continues without temporal object history',
      )
    }
  }
  // The pack's own capture-instant object data (GOAL "Static object picking"):
  // re-editing offers exactly the same picking as the original session.
  const loadedUiaText = pack.readText(`plugins/${UIA_PLUGIN_NAME}/elements.json`)
  const loadedUia = parseUiaPayload(loadedUiaText)
  // A pack that never had object data is not a pack whose object data was
  // DROPPED: the flag is only for a payload that is there and unreadable, so
  // the editor can say so instead of behaving like the pre-feature editor for
  // no visible reason.
  const loadedUiaDropped = loadedUiaText !== null && uiaEmpty(loadedUia)
  // The pack's own BROWSER picks, so re-editing offers the same document rung
  // the original session did (GAP 9). Stored on the pack clock already
  // (`t_ms`), which is the clock the editor session runs on, so nothing is
  // rebased here. Validated rather than trusted, like every other payload read
  // back off disk: a pick without a viewport anchor cannot be placed and is
  // simply not offered — the same outcome as a pack written by an extension
  // older than 0.1.4.
  const loadedDomEvents = parseDomPayload(pack.readText(`plugins/${DOM_PLUGIN_NAME}/elements.json`))
  // Which display an entry without a `display` field belongs to (SPEC §5.6,
  // §11.3) — the same index the editor's board gives the focused screen.
  const loadedFocusedIndex = focusedDisplayIndex(manifest.media?.displays)
  // All-displays pack (GOAL "Multi-Monitor Support"): the per-display files
  // stay on disk untouched, so the re-edit save carries their DECLARATION
  // through with null buffers — dropping entries whose files have since
  // vanished, so the regenerated manifest never declares a missing file.
  const loadedDisplays = loadedDisplayCaptures(manifest, dirPath)
  // The displays present at CAPTURE time — media.displays indices point into
  // this list, so it must survive the regenerated manifest too.
  // MAPPED, never filtered: media.displays[].index is the 1-based POSITION in
  // this list (SPEC §5.6), so dropping a malformed entry would shift every
  // later screen and silently point each display's index at the wrong one.
  // A placeholder keeps the positions; the bounds x scale of the display that
  // refers to it is the honest substitute where one exists.
  const loadedScreens = Array.isArray(manifest.environment?.screens)
    ? manifest.environment.screens.map((s, i) =>
        s !== null && typeof s === 'object' && typeof s.width === 'number' && typeof s.height === 'number'
          ? { width: s.width, height: s.height, scale: typeof s.scale === 'number' && s.scale > 0 ? s.scale : 1 }
          : screenFromDisplay(manifest, i + 1),
      )
    : []

  const capturedAtMs = typeof manifest.created_at === 'string' ? Date.parse(manifest.created_at) : NaN
  const capturedAt = Number.isFinite(capturedAtMs) ? new Date(capturedAtMs) : new Date()

  const loadedTimeline = pack.timeline()
  const t0 =
    typeof loadedTimeline?.t0 === 'string' ? loadedTimeline.t0 : isoWithOffset(capturedAt)
  // Annotation-added events during the session append to the LOADED events.
  const events: TimelineEvent[] = Array.isArray(loadedTimeline?.events)
    ? [...loadedTimeline.events]
    : []
  const t0Parsed = Date.parse(t0)
  const t0Ms = Number.isFinite(t0Parsed) ? t0Parsed : Date.now()

  // The SAME editor window flow as a fresh capture; display per settings
  // (cursor/fixed), since the captured display may no longer exist.
  const display = resolveTargetDisplay(settings)
  // Resolve every pack-backed display before creating a native window. Reading
  // a malformed/missing per-display file may throw; doing that first means a
  // failed History edit cannot leave an ownerless hidden BrowserWindow behind.
  const loadedEditorDisplayList = loadedEditorDisplays(pack, loadedDisplays, replayDurationMs)
  const reopenedContextDisplays = reopenedContextDisplayTargets({
    snapshotWidth: width,
    snapshotHeight: height,
    screens: manifest.environment.screens,
    displays: manifest.media.displays,
    loadedDisplays: loadedEditorDisplayList,
  })
  const { win: editor, mode: windowMode } = createEditorWindow(display.bounds, settings)
  // THE SAME DIAGNOSTICS, ON THE PATH THAT NEEDED THEM MOST (#106).
  //
  // Both capture flows forward the editor's own console lines to the log. This
  // one never did, so a re-edit was the one session that could not be asked
  // what it had done: a failed display decode, a failed bounded pick, any
  // `capturepack:` line the editor emitted between "editor shown" and "editor
  // closed" went nowhere. A report of the editor misbehaving on reopen was
  // therefore unanswerable from the machine it happened on, which is the whole
  // reason this forwarding exists.
  editor.webContents.on('console-message', (_event, level, message) => {
    if (!message.startsWith('capturepack:')) return
    if (level >= 2) logWarn(`[editor] ${message}`)
    else logInfo(`[editor] ${message}`)
  })
  // Picking works on re-edit too, from the pack's own saved observation — which
  // for every pack written before v0.2.0 describes exactly one instant, and the
  // frame says so for every other time rather than offering that instant's
  // rectangles as if they were the moment on screen (#66).
  let contextSession: ReturnType<typeof openContextSession>
  try {
    contextSession = openContextSession(editor, {
      displays: reopenedContextDisplays,
      replayDurationMs,
      observation: contextObservation(loadedUia, loadedFocusedIndex, replayDurationMs),
      dropped: loadedUiaDropped,
      domEvents: loadedDomEvents,
    })
    // A zero-duration image, a very short video, or an exact trim can
    // legitimately contain one checkpoint. Dropping it here made the Core
    // window floor present in the fresh editor and absent after reopen.
    if (
      loadedWindowsContextObservations.length > 0 &&
      loadedWindowsContextObservations.some((observation) => observation.windows.length > 0)
    ) {
      try {
        contextSession.adoptAll(loadedWindowsContextObservations)
        logInfo(
          `[context] reopened editor adopted ${loadedWindowsContextObservations.length} ` +
            `persisted Windows observations across ${declaredDurationMs} ms`,
        )
      } catch (err) {
        // Object history is an optional refinement; a corrupt provider payload
        // must never strand or prevent the editor window.
        logError(
          `[context] persisted Windows history could not be adopted; re-edit continues ` +
            `capture-instant-only: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  } catch (err) {
    // From this line on the BrowserWindow exists. Any synchronous context/setup
    // failure must destroy it before the detached re-edit flow reports failure,
    // otherwise it survives without a runEditor owner or visible close path.
    if (!editor.isDestroyed()) editor.destroy()
    throw err
  }
  editor.once('ready-to-show', () => {
    void (async () => {
      // Context enriches the editor; it may never be the price of opening it.
      // rc.36 awaited this promise without an outer deadline. A History click
      // could therefore create a hidden editor, keep flowActive true forever,
      // and make every later Ctrl+Alt+C log "flow already open". Open on time
      // with no initial frame, then push the same answer when it arrives.
      const initialFramePromise = contextSession.frameAt(replayDurationMs)
      const settledFrame = await settleWithin(initialFramePromise, UIA_EDITOR_GRACE_MS)
      const init: EditorInitPayload = {
        captureKind: loadedCapture.captureKind,
        snapshotPng: toArrayBuffer(snapshotPng),
        width,
        height,
        hasReplay: replayWebm !== null,
        replayDurationMs,
        replaySourceStartMs: 0,
        // The saved pack's other frozen displays, read back for the same BOARD a
        // fresh multi-display capture opens: all of them at once, all annotatable.
        displays: loadedEditorDisplayList,
        replayWebm: replayWebm === null ? null : toArrayBuffer(replayWebm),
        replayMimeType: replayRel === null ? null : replayMimeType(replayRel),
        // Re-edit: a screenshot-only pack is simply what was saved; no live
        // recorder failure to report.
        replayUnavailableReason: null,
        context: settledFrame.ready
          ? { sessionId: contextSession.sessionId, frame: settledFrame.value }
          : null,
        fps: settings.fps,
        scrubInvert: settings.scrubInvert,
        scrubSensitivityMs: settings.scrubSensitivityMs,
        defaultManualDurationMs: settings.defaultManualDurationMs,
        showDurationLabel: settings.showDurationLabel,
        showShortcutOverlay: settings.showShortcutOverlay,
        showEditorTutorial: settings.showEditorTutorial,
        annotations: loadedAnnotations,
        title: typeof manifest.title === 'string' ? manifest.title : '',
        note: typeof manifest.note === 'string' ? manifest.note : '',
        editMode: true,
        uiLanguage: uiLanguage(settings),
        // Re-edit opens in the same remembered mode as a fresh capture.
        windowMode,
      }
      if (editor.isDestroyed()) return
      await initializeAndShowEditor(editor, init)
      logInfo(`[capture] re-edit editor shown: ${path.basename(dirPath)}`)

      if (!settledFrame.ready) {
        void initialFramePromise.then(
          (frame) => {
            if (!editor.isDestroyed()) editor.webContents.send(IPC.contextFrame, frame)
          },
          (err: unknown) => {
            logError('capturepack: building the delayed re-edit context frame failed:', err)
          },
        )
      }
    })().catch((err: unknown) => {
      // A detached ready-to-show failure used to strand an invisible
      // BrowserWindow and the global flow gate. Destroying it makes runEditor
      // resolve, so the error is visible and the next hotkey works.
      logError('capturepack: opening the re-edit editor failed — closing the hidden editor:', err)
      if (!editor.isDestroyed()) editor.destroy()
    })
  })

  const outcome = await runEditor(editor, events, t0Ms)
  logInfo(`[capture] re-edit editor closed: ${outcome.kind}`)
  if (outcome.kind === 'cancel') return // Discard: close without writing

  const hasReplay = replayWebm !== null
  // Without a replay on disk, replay-relative data has nothing to anchor to
  // (SPEC §5.3, §8.4) — same rule as the fresh flow's exclude-replay save.
  const annotations = hasReplay
    ? outcome.payload.annotations
    : outcome.payload.annotations.map(withoutReplayTimes)
  // Declared replay missing on disk: the loaded t0 is anchored to the start of
  // a video the saved pack will not contain. Rebase t0 onto the capture
  // instant and shift every event, exactly like the fresh flow's
  // exclude-replay save (SPEC §10.1); clamp so loaded events cannot go negative.
  const timeline: TimelineFile =
    !hasReplay && declaredDurationMs > 0
      ? {
          t0: new Date(t0Ms + declaredDurationMs).toISOString(),
          events: events.map((e) => ({ ...e, t_ms: Math.max(0, e.t_ms - declaredDurationMs) })),
        }
      : { t0, events }
  // The declared focused replay is missing on disk: the save above rebased t0
  // onto the capture instant, so there is no pack clock left for a per-display
  // replay to be aligned against (SPEC §5.6 aligns them by the difference of
  // the declared replay durations, and this pack will declare none). Keep the
  // files — undeclared per-display files are explicitly ignored by readers —
  // but stop declaring them rather than declaring a clock that cannot resolve.
  const savedDisplays =
    hasReplay || declaredDurationMs === 0
      ? loadedDisplays
      : loadedDisplays.map((d) => ({ ...d, hasReplay: false, replayFile: null, replayDurationMs: 0 }))
  // A box may only name a display the save actually DECLARES (SPEC §8.8).
  // loadedDisplayCaptures drops entries whose files have vanished — and
  // collapses the whole array when fewer than two survive — so a re-edit can
  // legitimately declare fewer displays than the boxes were drawn on. Left
  // alone, those boxes would fail the validator, render into nothing, and
  // disappear from report.md, while the editor happily kept showing them on the
  // focused display. Resolving them to the focused display instead is exactly
  // what the editor already drew, and it never loses a box.
  const savedAnnotations = withResolvedDisplays(annotations, savedDisplays)
  const savedContextInstant =
    loadedWindowsContext === null
      ? null
      : Math.max(
          loadedWindowsContext.range.start_ms,
          Math.min(
            loadedSnapshotTMs ?? declaredDurationMs,
            loadedWindowsContext.range.end_ms,
          ),
        )
  const savedWindowsContext: WindowsContextTimelineV1 | null | undefined =
    loadedWindowsContextDeclared && loadedWindowsContext === null
      ? null
      : !hasReplay && loadedWindowsContext !== null && savedContextInstant !== null
        ? trimWindowsContextTimeline(
            loadedWindowsContext,
            savedContextInstant,
            savedContextInstant,
          )
        : undefined
  const editAfterSaveMode =
    loadedCapture.captureKind === 'image'
      ? settings.imageClipboardAfterSave
      : settings.clipboardAfterSave
  const editPackClipboardMode =
    editAfterSaveMode === 'image' ? 'off' : editAfterSaveMode
  const input: ExportInput = {
    captureKind: loadedCapture.captureKind,
    ...(loadedCapture.imageScope === undefined
      ? {}
      : { imageScope: loadedCapture.imageScope }),
    ...(loadedCapture.cropBounds === undefined
      ? {}
      : { cropBounds: loadedCapture.cropBounds }),
    snapshotPng: Buffer.from(outcome.payload.snapshotPng),
    width,
    height,
    capturedAt, // created_at stays the ORIGINAL capture instant
    replayWebm: null, // never carried through a re-edit save
    // The pack keeps the replay it already has, under the name it declares.
    ...(replayRel !== null ? { replayFile: replayRel } : {}),
    replayDurationMs,
    cadence: manifest.media.cadence,
    annotations: savedAnnotations,
    title: outcome.payload.title,
    note: outcome.payload.note,
    // The editor's "now" frame IS the loaded snapshot.png in edit mode, so a
    // null position keeps the original snapshot_t_ms; a scrubbed export wins.
    snapshotTMs: hasReplay ? (outcome.payload.snapshotTMs ?? loadedSnapshotTMs) : null,
    // Provenance carried through (only meaningful while the replay exists).
    trimOffsetMs: hasReplay ? loadedTrimOffsetMs : null,
    timeline,
    // External packs may declare plugins the current exporter never writes:
    // carry the declaration through a re-edit save (the plugins/ files on disk
    // stay untouched and must not become undeclared).
    plugins: loadedPlugins,
    windowsContext: savedWindowsContext,
    // Same rule for per-display media: the files stay, the declaration is
    // regenerated from what the folder actually holds.
    displays:
      loadedCapture.captureKind === 'video' && savedDisplays.length > 0
        ? savedDisplays
        : undefined,
    screens: loadedScreens.length > 0 ? loadedScreens : undefined,
    clipboardAfterSave: editPackClipboardMode,
    // Re-edit saves regenerate the docs too — in the CURRENT pack language.
    docLanguage: packDocLanguage(settings),
  }

  try {
    const handle: PackHandle =
      outcome.kind === 'saveAsNew'
        ? await saveAsNewPack(dirPath, input)
        : { id: manifest.id, dirPath }
    if (outcome.kind === 'export') {
      await updatePack(handle, input, { keepReplay: true })
      // Save As New copied inside saveAsNewPack, which is where its folder came
      // into existence; a re-edit save has to do it here for the same reason a
      // fresh capture does — before the render, not after it.
      await copyAfterSave(editPackClipboardMode, handle.dirPath)
    }
    // Same save pipeline as a fresh capture: toast, then background render.
    showSaveToast({
      folderPath: handle.dirPath,
      hasBlur: savedAnnotations.some((a) => a.blur),
      // Re-edit: nothing was recorded during this save, so there is no recorder
      // failure to report — the pack's replay is whatever it already had.
      replayUnavailable: null,
      renderState: hasReplay
        ? 'rendering'
        : editAfterSaveMode === 'image'
          ? 'image-rendering'
          : 'none',
      uiLanguage: uiLanguage(settings),
    })
    // Same per-display rule as a fresh save: the pack's own annotated views are
    // the FOCUSED display's, and every other annotated screen renders its own.
    const focusedIndex = savedDisplays.find((d) => d.focused)?.index ?? 1
    const focusedAnnotations = annotationsOnDisplay(savedAnnotations, focusedIndex, focusedIndex)
    // GLOBAL over everything the save wrote (SPEC §8.5), never over the subset
    // one render receives.
    const numbers = globalDisplayNumbers(savedAnnotations)
    const motionSpace = motionSpaceFromDisplayCaptures(savedDisplays, focusedIndex)
    if (replayWebm !== null) {
      startAnnotatedRender(
        handle,
        {
          replayWebm,
          replayMimeType: replayMimeType(replayRel),
          annotations: focusedAnnotations,
          motionSpace,
          displayNumbers: numbers,
          focusedDisplay: focusedIndex,
          width,
          height,
          fps: settings.fps,
          replayDurationMs,
          docLanguage: packDocLanguage(settings),
        },
        (state) => updateToastRenderStatus(handle.dirPath, state),
      )
    } else {
      // Same rule on re-edit: a pack without a replay re-renders its single
      // annotated still from the saved snapshot (SPEC §7.3).
      startKeyframeStill(
        handle,
        {
          snapshotPng: input.snapshotPng,
          annotations: focusedAnnotations,
          motionSpace,
          displayNumbers: numbers,
          focusedDisplay: focusedIndex,
          width,
          height,
          docLanguage: packDocLanguage(settings),
        },
        editAfterSaveMode === 'image'
          ? {
              onRendered: async (png) => {
                const copied = await copyPngToClipboard(png)
                if (copied) {
                  updateToastRenderStatus(handle.dirPath, 'image-copied')
                } else {
                  logWarn('[image] re-rendered final image could not be copied to the clipboard')
                  updateToastRenderStatus(handle.dirPath, 'image-copy-failed')
                }
              },
              onFailed: () => {
                updateToastRenderStatus(handle.dirPath, 'image-copy-failed')
              },
            }
          : {},
      )
    }
    if (loadedCapture.captureKind === 'video') {
      startDisplayRenders(
        handle,
        // Read back from the SOURCE pack (the same bytes Save As New copied),
        // and only for displays that actually carry boxes — a re-edit must not
        // pull 45 MB of webm per untouched screen back into memory.
        displayRenderSources(pack, savedDisplays, savedAnnotations, focusedIndex),
        savedAnnotations,
        focusedIndex,
        motionSpace,
        settings.fps,
        packDocLanguage(settings),
      )
    }
  } catch (err) {
    logError('[capture] re-edit save failed:', err)
    dialog.showErrorBox(uiT(settings)('app.saveFailedTitle'), errorMessage(err))
  }
}

// ---------------------------------------------------------------------------
// Per-display annotated renders (GOAL "Multi-Monitor Support"): a box belongs
// to the display it was drawn on, so each display's rendered views carry ITS
// OWN boxes and only those — drawing a second screen's box into the first
// would place it at coordinates that mean something entirely different there.
//
// The focused display keeps the top-level outputs (replay_annotated.webm,
// frames/); every other ANNOTATED display gets replay_annotated-d<N>.webm and
// frames-d<N>/, declared inside its media.displays entry (SPEC §5.6). A display
// nobody annotated gets nothing — the cost is proportional to the work done.
// ---------------------------------------------------------------------------

/** One display's media, as a render job needs it. */
interface DisplayRenderSource {
  index: number
  width: number
  height: number
  snapshotPng: Buffer
  replayWebm: Buffer | null
  replayMimeType: string | null
  replayDurationMs: number
  /**
   * ms to ADD to a pack-clock time to reach this display's own replay clock.
   * Lifetimes are stored on the pack clock (the focused replay, SPEC §8.4), so
   * every one of them is rebased through this before it is rendered here.
   */
  offsetMs: number
}

/**
 * The pack's display numbers (SPEC §8.5) as IPC-transferable pairs, computed
 * ONCE per save over the WHOLE annotation set.
 *
 * Every rendered view — the top-level replay_annotated/frames and each
 * per-display one — receives only the boxes of the display it draws, so none of
 * them may derive the numbering itself: SPEC §8.5 requires one global sequence,
 * identical in every rendered view, and report.md prints exactly that sentence.
 */
function globalDisplayNumbers(annotations: readonly Annotation[]): Array<[string, number]> {
  return [...computeDisplayNumbers(annotations)]
}

function motionSpaceFromFrozenDisplays(
  displays: readonly FrozenDisplay[],
  focusedIndex: number,
): AuthoredMotionSpace | undefined {
  if (displays.length < 2) return undefined
  return {
    focusedIndex,
    displays: displays.map((display) => ({
      index: display.index,
      width: display.width,
      height: display.height,
      bounds: { ...display.bounds },
    })),
  }
}

function motionSpaceFromDisplayCaptures(
  displays: readonly DisplayCapture[],
  focusedIndex: number,
): AuthoredMotionSpace | undefined {
  if (displays.length < 2) return undefined
  return {
    focusedIndex,
    displays: displays.map((display) => ({
      index: display.index,
      width: Math.max(1, Math.round(display.bounds.width * display.scale)),
      height: Math.max(1, Math.round(display.bounds.height * display.scale)),
      bounds: { ...display.bounds },
    })),
  }
}

/**
 * Annotations whose `display` names a display this save DECLARES (SPEC §8.8).
 *
 * A re-edit can declare fewer displays than the loaded boxes were drawn on
 * (files removed from the folder since, or the whole per-display set collapsing
 * to a single-display pack). A box naming a display that is no longer there
 * resolves to the FOCUSED display — the field is dropped, which is what "absent
 * = focused" means — instead of being written as an unresolvable index that
 * fails validation, renders nowhere, and vanishes from the documents.
 */
function withResolvedDisplays(
  annotations: readonly Annotation[],
  displays: readonly DisplayCapture[],
): Annotation[] {
  // Fewer than two declared displays IS a single-display pack: media.displays
  // is not written at all, so no box may carry `display`.
  const declared = displays.length > 1 ? new Set(displays.map((d) => d.index)) : new Set<number>()
  return annotations.map((a) => {
    if (a.display === undefined) return a
    if (declared.has(a.display)) return a
    const { display: _dropped, ...rest } = a
    return rest
  })
}

/** Every temporal field moved onto one display's own replay clock, clamped to it. */
function rebaseLifetimeTo(a: Annotation, offsetMs: number, durationMs: number): Annotation {
  return rebaseAnnotationClock(a, offsetMs, durationMs)
}

/**
 * Starts one background render per NON-FOCUSED display that carries
 * annotations. Fire-and-forget, serialized behind the pack's own render by the
 * shared queue (annotatedRender.ts) so N screens never become N render windows.
 */
function startDisplayRenders(
  handle: PackHandle,
  sources: readonly DisplayRenderSource[],
  annotations: readonly Annotation[],
  focusedIndex: number,
  motionSpace: AuthoredMotionSpace | undefined,
  fps: number,
  docLanguage: Language,
): void {
  // The numbering is the PACK's, not this display's: box 2 is box 2 in every
  // rendered view (SPEC §8.5). Computed from the un-rebased set, so a per-
  // display clock shift cannot reorder it either.
  const displayNumbers = globalDisplayNumbers(annotations)
  for (const s of sources) {
    if (s.index === focusedIndex) continue
    const own = annotationsOnDisplay(annotations, s.index, focusedIndex)
    if (own.length === 0) continue
    if (s.replayWebm !== null && s.replayMimeType !== null && s.replayDurationMs > 0) {
      startDisplayRender(handle, {
        replayWebm: s.replayWebm,
        replayMimeType: s.replayMimeType,
        annotations: own.map((a) => rebaseLifetimeTo(a, s.offsetMs, s.replayDurationMs)),
        motionSpace,
        displayNumbers,
        focusedDisplay: focusedIndex,
        width: s.width,
        height: s.height,
        fps,
        replayDurationMs: s.replayDurationMs,
        docLanguage,
        display: s.index,
      })
    } else {
      // No replay on this screen: one still from its frozen frame, exactly like
      // a screenshot-only pack (SPEC §7.3). A lifetime has nothing to anchor to
      // without a replay, so it is dropped rather than reinterpreted.
      startKeyframeStill(handle, {
        snapshotPng: s.snapshotPng,
        annotations: own.map(withoutReplayTimes),
        motionSpace,
        displayNumbers,
        focusedDisplay: focusedIndex,
        width: s.width,
        height: s.height,
        docLanguage,
        display: s.index,
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Re-edit: reading an all-displays pack back (GOAL "Multi-Monitor Support")
// ---------------------------------------------------------------------------

function isBoundsLike(v: unknown): v is { x: number; y: number; width: number; height: number } {
  if (v === null || typeof v !== 'object') return false
  const b = v as Record<string, unknown>
  return (
    typeof b['x'] === 'number' &&
    typeof b['y'] === 'number' &&
    typeof b['width'] === 'number' &&
    typeof b['height'] === 'number'
  )
}

/**
 * manifest.media.displays as the exporter re-declares it on a re-edit save:
 * entry-validated, restricted to files that still exist in the folder, and
 * carrying NO bytes (the files on disk are the original evidence).
 */
function loadedDisplayCaptures(manifest: Manifest, dirPath: string): DisplayCapture[] {
  const raw: unknown = manifest.media?.displays
  if (!Array.isArray(raw)) return []
  const result: DisplayCapture[] = []
  for (const item of raw as unknown[]) {
    if (item === null || typeof item !== 'object') continue
    const e = item as Partial<ManifestDisplayMedia>
    if (typeof e.index !== 'number' || !Number.isInteger(e.index) || e.index < 1) continue
    if (typeof e.snapshot !== 'string' || typeof e.focused !== 'boolean') continue
    if (!isBoundsLike(e.bounds)) continue
    // The DECLARED names travel with the entry: SPEC §5.6 permits
    // `replay-d<N>.mp4`, so re-deriving `.webm` from the index on save would
    // declare a file the pack does not contain and orphan the one it does.
    // displayMediaName() also keeps a hand-edited name from reaching a path.
    const snapshotFile = displayMediaName(e.snapshot, displaySnapshotName(e.index), 'snapshot')
    const replayFile =
      typeof e.replay === 'string'
        ? displayMediaName(e.replay, displayReplayName(e.index), 'replay')
        : null
    // The focused display's files are the top-level ones, which the caller
    // already validated; a non-focused display without its snapshot on disk
    // must not be declared again.
    if (!e.focused && !existsSync(path.join(dirPath, snapshotFile))) continue
    const hasReplay =
      replayFile !== null && (e.focused || existsSync(path.join(dirPath, replayFile)))
    result.push({
      index: e.index,
      focused: e.focused,
      bounds: { ...e.bounds },
      scale: typeof e.scale === 'number' && e.scale > 0 ? e.scale : 1,
      hasReplay,
      replayDurationMs: typeof e.replay_duration_ms === 'number' ? Math.max(0, e.replay_duration_ms) : 0,
      ...(typeof e.replay_clock_offset_ms === 'number' &&
      Number.isSafeInteger(e.replay_clock_offset_ms)
        ? { replayClockOffsetMs: e.replay_clock_offset_ms }
        : {}),
      snapshotFile,
      replayFile: hasReplay ? replayFile : null,
      snapshotPng: null,
      replayWebm: null,
    })
  }
  return result
}

/**
 * A stand-in for a malformed environment.screens entry, derived from the
 * media.displays entry that points at it (bounds x scale IS that screen's
 * physical size, SPEC §5.6). 1x1 when nothing refers to it — a placeholder that
 * holds the POSITION is what the display indices need.
 */
function screenFromDisplay(
  manifest: Manifest,
  index: number,
): { width: number; height: number; scale: number } {
  const displays = manifest.media?.displays
  const match = Array.isArray(displays)
    ? displays.find((d) => d !== null && typeof d === 'object' && d.index === index)
    : undefined
  if (match !== undefined && isBoundsLike(match.bounds) && typeof match.scale === 'number' && match.scale > 0) {
    return {
      width: Math.round(match.bounds.width * match.scale),
      height: Math.round(match.bounds.height * match.scale),
      scale: match.scale,
    }
  }
  return { width: 1, height: 1, scale: 1 }
}

/**
 * The per-display render sources of a SAVED pack, read back from its files —
 * only for the displays that actually carry annotations, since every other one
 * would just be tens of megabytes of webm read for nothing.
 *
 * ALIGNMENT (SPEC §5.6): a current pack persists the observed recorder-origin
 * conversion. That survives reopen and exact cutting without assuming the
 * independent stop/flush operations ended together. A legacy pack has no such
 * measurement, so and only so it uses the declared duration difference.
 */
function displayRenderSources(
  pack: { readBinary(rel: string): Buffer | null },
  displays: readonly DisplayCapture[],
  annotations: readonly Annotation[],
  focusedIndex: number,
): DisplayRenderSource[] {
  if (displays.length < 2) return []
  const focusedDurationMs = displays.find((d) => d.focused)?.replayDurationMs ?? 0
  const sources: DisplayRenderSource[] = []
  for (const d of displays) {
    if (d.focused) continue
    if (annotationsOnDisplay(annotations, d.index, focusedIndex).length === 0) continue
    const png = pack.readBinary(d.snapshotFile)
    if (png === null) continue
    const size = nativeImage.createFromBuffer(png).getSize()
    if (size.width <= 0 || size.height <= 0) continue
    const replay = d.hasReplay && d.replayFile !== null ? pack.readBinary(d.replayFile) : null
    sources.push({
      index: d.index,
      width: size.width,
      height: size.height,
      snapshotPng: png,
      replayWebm: replay,
      replayMimeType: replay === null ? null : replayMimeType(d.replayFile),
      replayDurationMs: replay === null ? 0 : d.replayDurationMs,
      offsetMs: resolvedReplayClockOffsetMs(
        d.replayClockOffsetMs,
        d.replayDurationMs,
        focusedDurationMs,
      ),
    })
  }
  return sources
}

/**
 * The saved pack's per-display media, read back for the editor board: the same
 * payload a fresh capture ships, so re-editing an all-displays pack gives the
 * same board — every screen drawn at once, every screen annotatable, one clock.
 *
 * Both this board path and displayRenderSources() resolve the saved observed
 * offset first and use the legacy duration difference only when it is absent,
 * so reopened pixels and regenerated views cannot disagree (SPEC §5.6).
 */
function loadedEditorDisplays(
  pack: { readBinary(rel: string): Buffer | null },
  displays: readonly DisplayCapture[],
  focusedDurationMs: number,
): EditorDisplayPayload[] {
  const result: EditorDisplayPayload[] = []
  for (const d of displays) {
    // The DECLARED filename, not one re-derived from the index — otherwise a
    // spec-legal name the pack actually uses silently disappears from the board.
    const rel = d.focused ? 'snapshot.png' : d.snapshotFile
    const png = pack.readBinary(rel)
    if (png === null) continue
    const size = nativeImage.createFromBuffer(png).getSize()
    if (size.width <= 0 || size.height <= 0) continue
    // This display's own replay, so the board's one clock can move it too. A
    // declared file missing on disk degrades that display to its frozen frame,
    // which the board labels — the same rule the focused replay follows.
    const replay =
      d.focused || !d.hasReplay || d.replayFile === null ? null : pack.readBinary(d.replayFile)
    const durationMs = replay === null ? 0 : d.replayDurationMs
    result.push({
      index: d.index,
      focused: d.focused,
      // The focused frame is already EditorInitPayload.snapshotPng; the editor
      // never decodes this copy (see toEditorDisplays).
      snapshotPng: d.focused ? null : toArrayBuffer(png),
      width: size.width,
      height: size.height,
      bounds: { ...d.bounds },
      scale: d.scale,
      replayWebm: replay === null ? null : toArrayBuffer(replay),
      replayMimeType: replay === null ? null : replayMimeType(d.replayFile),
      // Re-edit: a missing replay is a property of the SAVED pack, not a live
      // recorder failure — there is no reason to name.
      replayUnavailableReason: null,
      replayDurationMs: durationMs,
      replayOffsetMs: d.focused
        ? 0
        : resolvedReplayClockOffsetMs(
            d.replayClockOffsetMs,
            durationMs,
            focusedDurationMs,
          ),
    })
  }
  return result
}

// ---------------------------------------------------------------------------
// The editor window (GOAL "Editor Window Mode")
//
// The fullscreen overlay is the DEFAULT — it is the fastest way to annotate and
// what every capture opened with before this existed. But the editor is a real
// window too: ⧉ in the top bar (and F11) switches it to a movable, resizable,
// not-always-on-top window, and the mode + rectangle are remembered so the next
// capture opens the way the user left it.
//
// Main owns the window state. The renderer asks for an ABSOLUTE mode and paints
// only what main pushes back, so the two can never disagree about which mode
// the window is in.
// ---------------------------------------------------------------------------

/** Floor for the windowed editor: below this the top bar stops being usable. */
const EDITOR_MIN_WIDTH = 720
const EDITOR_MIN_HEIGHT = 460
/** Share of the work area a first-ever windowed editor takes (then remembered). */
const EDITOR_DEFAULT_FILL = 0.82
/**
 * How long a setFullScreen() transition is given to announce itself before the
 * windowed geometry is applied regardless. enter/leave-full-screen normally
 * arrives in a few frames; this only guarantees that a platform that never
 * emits it cannot leave the window half-switched.
 */
const FULLSCREEN_SETTLE_MS = 400

interface EditorWindow {
  win: BrowserWindow
  /** The mode the window opened in — what EditorInitPayload.windowMode carries. */
  mode: EditorWindowMode
}

function sameBounds(a: EditorWindowBounds | null, b: EditorWindowBounds | null): boolean {
  if (a === null || b === null) return a === b
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/** Fits `bounds` inside `workArea`, keeping as much of the asked-for rect as fits. */
function clampToWorkArea(bounds: EditorWindowBounds, workArea: EditorWindowBounds): EditorWindowBounds {
  const width = Math.round(Math.max(Math.min(bounds.width, workArea.width), Math.min(EDITOR_MIN_WIDTH, workArea.width)))
  const height = Math.round(
    Math.max(Math.min(bounds.height, workArea.height), Math.min(EDITOR_MIN_HEIGHT, workArea.height)),
  )
  return {
    x: Math.round(Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width)),
    y: Math.round(Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height)),
    width,
    height,
  }
}

/**
 * The rectangle a windowed editor opens at on THIS capture's display.
 *
 * The remembered rectangle is honored when its centre is on the capture's
 * display; otherwise only its SIZE is kept and the window is centred on the
 * capture's work area. That is what makes "opens the way the user left it" and
 * "opens on the display the capture froze" both true — and why a monitor that
 * has since been unplugged can never strand the editor off-screen.
 */
function openingWindowedBounds(
  stored: EditorWindowBounds | null,
  workArea: EditorWindowBounds,
): EditorWindowBounds {
  const size =
    stored === null
      ? {
          width: Math.round(workArea.width * EDITOR_DEFAULT_FILL),
          height: Math.round(workArea.height * EDITOR_DEFAULT_FILL),
        }
      : { width: stored.width, height: stored.height }
  const centred = {
    x: Math.round(workArea.x + (workArea.width - size.width) / 2),
    y: Math.round(workArea.y + (workArea.height - size.height) / 2),
    ...size,
  }
  if (stored === null) return clampToWorkArea(centred, workArea)
  const cx = stored.x + stored.width / 2
  const cy = stored.y + stored.height / 2
  const onThisDisplay =
    cx >= workArea.x && cx < workArea.x + workArea.width && cy >= workArea.y && cy < workArea.y + workArea.height
  return clampToWorkArea(onThisDisplay ? stored : centred, workArea)
}

/**
 * The annotation editor, opened on the FOCUSED display (GOAL "Multi-Monitor
 * Support") in the remembered window mode (GOAL "Editor Window Mode"). Takes
 * the display's bounds rather than a live Display so the editor lands on
 * exactly the display the capture froze, even if the cursor moved on since the
 * trigger.
 *
 * `settings` is the live settings object the whole app shares: the mode and the
 * windowed rectangle are written back into it (and to disk) as the user
 * toggles, moves, and resizes.
 */
function createEditorWindow(bounds: EditorWindowBounds, settings: Settings): EditorWindow {
  const openingWorkArea = screen.getDisplayMatching(bounds).workArea
  // ONE MODE, AND IT IS A MAXIMIZED WINDOW.
  //
  // The fullscreen overlay is gone. It was the default, it was alwaysOnTop,
  // and it could not be moved off whatever the user wanted to look at behind
  // it — a strange thing for a tool whose job is explaining something that is
  // on the screen. Keeping both also meant keeping two layouts honest against
  // every change, for a choice nobody needed to make.
  //
  // A stored 'fullscreen' from an earlier version reads as 'windowed'
  // (settings.ts migrates it), so this can only ever be one value now.
  const mode: EditorWindowMode = 'windowed'
  // Resolved even when opening fullscreen: a later ⧉ / F11 has to land
  // somewhere sane too.
  let windowedBounds = openingWindowedBounds(settings.editorWindowBounds, openingWorkArea)
  const windowed = mode === 'windowed'
  const editor = new BrowserWindow({
    ...(windowed ? windowedBounds : bounds),
    // A FRAMELESS title strip looked like a caption but removed the Windows
    // contract that matters: Minimize / Maximize / Close. Keep the web content
    // in the title-bar area while letting Windows own those three buttons.
    // The renderer reserves this exact 32 px strip and draws only the product
    // name in it; native hit targets stay native (#113).
    title: 'CapturePack',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#16161b',
      symbolColor: '#e8e8ea',
      height: 32,
    },
    // Windowed mode is a REAL window: movable, resizable, and not hovering over
    // everything else — the user may want to look at the app behind it.
    fullscreen: !windowed,
    alwaysOnTop: !windowed,
    resizable: true,
    movable: true,
    minWidth: Math.min(EDITOR_MIN_WIDTH, openingWorkArea.width),
    minHeight: Math.min(EDITOR_MIN_HEIGHT, openingWorkArea.height),
    backgroundColor: '#111',
    show: false,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist', 'preload', 'editor.js'),
      // Chromium may throttle requestAnimationFrame in a hidden native window.
      // Initialization deliberately crosses two paint boundaries before ACK,
      // so keep only this short bootstrap interval unthrottled.
      backgroundThrottling: false,
    },
  })
  activeEditor = editor
  // The default application menu binds F11 to "Toggle Full Screen" on Windows
  // and Linux. The editor owns F11 itself, and two handlers racing over one key
  // would flip the window twice — so this window carries no menu at all.
  if (typeof editor.removeMenu === 'function') editor.removeMenu()

  let current: EditorWindowMode = mode
  // True only while a setFullScreen transition is in flight: the resize/move
  // events it fires describe the transition, not a rectangle worth remembering.
  let transitioning = false
  // Whether windowed mode was ever actually on screen this session. Until it
  // was, `windowedBounds` is only a proposal — an overlay-only session must not
  // write a rectangle the user never saw (and must not touch the disk at all).
  let windowedUsed = windowed

  /** Remembers where the user put the window (windowed mode only). */
  const trackBounds = (): void => {
    if (transitioning || current !== 'windowed') return
    if (editor.isDestroyed() || editor.isFullScreen()) return
    // Normal bounds, so a maximized editor remembers the size it will restore
    // to rather than the work area it currently covers.
    windowedBounds = editor.getNormalBounds()
  }
  editor.on('resize', trackBounds)
  editor.on('move', trackBounds)

  const pushMode = (): void => {
    if (editor.isDestroyed()) return
    editor.webContents.send(IPC.editorWindowMode, current)
  }

  /**
   * Writes the mode + rectangle back into the shared settings object and to
   * disk. Never fatal: an unwritable settings file must not disturb a capture,
   * it only costs the memory of how the editor was left.
   */
  const persist = (): void => {
    const bounds = windowedUsed ? windowedBounds : settings.editorWindowBounds
    if (settings.editorWindowMode === current && sameBounds(settings.editorWindowBounds, bounds)) {
      return // Nothing changed — no disk write.
    }
    settings.editorWindowMode = current
    settings.editorWindowBounds = bounds === null ? null : { ...bounds }
    try {
      persistSettings({ ...settings })
    } catch (err) {
      logError('capturepack: saving the editor window mode failed:', err)
    }
  }

  /**
   * Runs `fn` on the fullscreen transition event, or at the settle deadline —
   * whichever comes first, exactly once. (The event name is branched on rather
   * than passed through: BrowserWindow's listener signature is per-event.)
   */
  const settle = (event: 'enter-full-screen' | 'leave-full-screen', fn: () => void): void => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let done = false
    const run = (): void => {
      if (done) return
      done = true
      if (timer !== null) clearTimeout(timer)
      if (event === 'enter-full-screen') editor.removeListener('enter-full-screen', run)
      else editor.removeListener('leave-full-screen', run)
      if (!editor.isDestroyed()) fn()
    }
    if (event === 'enter-full-screen') editor.once('enter-full-screen', run)
    else editor.once('leave-full-screen', run)
    timer = setTimeout(run, FULLSCREEN_SETTLE_MS)
  }

  const applyMode = (next: EditorWindowMode): void => {
    if (editor.isDestroyed() || transitioning || next === current) return
    // Wherever the window is now is what windowed mode returns to; sample it
    // before the transition starts moving it.
    trackBounds()
    transitioning = true
    current = next
    if (next === 'windowed') {
      windowedUsed = true
      const finish = (): void => {
        editor.setResizable(true)
        editor.setMovable(true)
        editor.setAlwaysOnTop(false)
        // Re-clamped against the display the window is actually on now.
        windowedBounds = clampToWorkArea(windowedBounds, screen.getDisplayMatching(editor.getBounds()).workArea)
        editor.setBounds(windowedBounds)
        transitioning = false
        persist()
        pushMode()
      }
      // Applied only once leaving fullscreen has settled: Windows restores its
      // own pre-fullscreen rectangle on the way out, which would otherwise
      // overwrite a setBounds() made too early.
      if (editor.isFullScreen()) {
        settle('leave-full-screen', finish)
        editor.setFullScreen(false)
      } else {
        finish()
      }
      return
    }
    const finish = (): void => {
      transitioning = false
      persist()
      pushMode()
    }
    // resizable/movable are deliberately NOT turned off for the overlay: on
    // Windows a non-resizable window cannot enter fullscreen, and a fullscreen
    // window is neither movable nor resizable by the user anyway.
    editor.setAlwaysOnTop(true)
    if (editor.isFullScreen()) {
      finish()
    } else {
      settle('enter-full-screen', finish)
      editor.setFullScreen(true)
    }
  }

  const onSetWindowMode = (event: IpcMainEvent, payload: unknown): void => {
    if (editor.isDestroyed() || event.sender !== editor.webContents) return
    // An absolute target from the renderer, validated here: anything else is
    // ignored rather than trusted into a window call.
    if (payload !== 'fullscreen' && payload !== 'windowed') return
    applyMode(payload)
  }
  ipcMain.on(IPC.editorSetWindowMode, onSetWindowMode)

  /**
   * The shortcut sheet's `?` / F1 toggle (GOAL "Editor Chrome": the state
   * persists, so turning it off is permanent until turned back on). Written
   * straight through — it is one boolean of chrome, and an unwritable settings
   * file must not disturb a capture any more than it does for the window mode.
   */
  /**
   * "Don't show again" on the first-run tutorial (GOAL "First-Run Tutorial").
   *
   * Same contract as the shortcut sheet below it: absolute state, written
   * straight through, and a settings file that cannot be written costs the
   * preference rather than the capture the user is in the middle of.
   */
  const onSetTutorial = (event: IpcMainEvent, payload: unknown): void => {
    if (editor.isDestroyed() || event.sender !== editor.webContents) return
    if (typeof payload !== 'boolean' || settings.showEditorTutorial === payload) return
    settings.showEditorTutorial = payload
    try {
      persistSettings({ ...settings })
    } catch (err) {
      logError('capturepack: saving the tutorial state failed:', err)
    }
  }

  const onSetShortcutOverlay = (event: IpcMainEvent, payload: unknown): void => {
    if (editor.isDestroyed() || event.sender !== editor.webContents) return
    if (typeof payload !== 'boolean' || settings.showShortcutOverlay === payload) return
    settings.showShortcutOverlay = payload
    try {
      persistSettings({ ...settings })
    } catch (err) {
      logError('capturepack: saving the shortcut overlay state failed:', err)
    }
  }
  ipcMain.on(IPC.editorSetShortcutOverlay, onSetShortcutOverlay)
  ipcMain.on(IPC.editorSetTutorial, onSetTutorial)

  editor.on('closed', () => {
    if (activeEditor === editor) activeEditor = null
    ipcMain.removeListener(IPC.editorSetWindowMode, onSetWindowMode)
    ipcMain.removeListener(IPC.editorSetShortcutOverlay, onSetShortcutOverlay)
    ipcMain.removeListener(IPC.editorSetTutorial, onSetTutorial)
    // Final rectangle (the move/resize listeners kept it current while the
    // window lived) — this is what the next capture opens at.
    persist()
  })

  // Last-resort lifecycle guard for BOTH fresh captures and History re-edits.
  // The editor starts hidden; if loading or first-paint initialization never
  // reaches show(), there is otherwise no native window the user can close and
  // the exclusive flow gate can remain held indefinitely.
  let startupTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    startupTimer = null
    if (editor.isDestroyed() || editor.isVisible()) return
    logError(
      `capturepack: editor did not become visible within ${EDITOR_STARTUP_TIMEOUT_MS} ms — closing the hidden editor`,
    )
    editor.destroy()
  }, EDITOR_STARTUP_TIMEOUT_MS)
  startupTimer.unref()
  const clearStartupTimer = (): void => {
    if (startupTimer === null) return
    clearTimeout(startupTimer)
    startupTimer = null
  }
  editor.once('show', clearStartupTimer)
  editor.once('closed', clearStartupTimer)
  editor.webContents.once('render-process-gone', (_event, details) => {
    logError(`capturepack: editor renderer exited (${details.reason})`)
    if (!editor.isDestroyed()) editor.destroy()
  })

  void editor
    .loadFile(path.join(app.getAppPath(), 'dist', 'renderer', 'editor', 'editor.html'))
    .catch((err: unknown) => {
      logError('capturepack: loading the editor failed:', err)
      if (!editor.isDestroyed()) editor.destroy()
    })
  return { win: editor, mode }
}

/**
 * Sends the one-shot editor payload and reveals the native window only after
 * the renderer has decoded its pixels and crossed a paint boundary.
 *
 * The createEditorWindow startup timer remains the outer bound. If the
 * renderer rejects, crashes or never answers, the hidden window is destroyed
 * and this promise rejects through `closed`; callers already catch that path
 * and release the capture flow.
 */
function initializeAndShowEditor(
  editor: BrowserWindow,
  init: EditorInitPayload,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (editor.isDestroyed()) {
      reject(new Error('editor closed before initialization'))
      return
    }
    let settled = false
    const cleanup = (): void => {
      ipcMain.removeListener(IPC.editorInitialized, onInitialized)
      ipcMain.removeListener(IPC.editorInitFailed, onFailed)
      editor.removeListener('closed', onClosed)
    }
    const finish = (error: Error | null): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error === null) resolve()
      else reject(error)
    }
    const fromEditor = (event: IpcMainEvent): boolean =>
      !editor.isDestroyed() && event.sender === editor.webContents
    const onInitialized = (event: IpcMainEvent): void => {
      if (!fromEditor(event)) return
      finish(null)
    }
    const onFailed = (event: IpcMainEvent, payload: unknown): void => {
      if (!fromEditor(event)) return
      const detail =
        typeof payload === 'string' && payload.trim() !== ''
          ? `: ${payload.trim().slice(0, 2_000)}`
          : ''
      finish(new Error(`editor renderer initialization failed${detail}`))
    }
    const onClosed = (): void => finish(new Error('editor closed before initialization'))

    ipcMain.on(IPC.editorInitialized, onInitialized)
    ipcMain.on(IPC.editorInitFailed, onFailed)
    editor.once('closed', onClosed)
    try {
      editor.webContents.send(IPC.editorInit, init)
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)))
    }
  }).then(() => {
    if (editor.isDestroyed()) throw new Error('editor closed after initialization')
    // Restore the normal minimized/background CPU policy before the user sees
    // the window; the exception above exists only for the hidden paint ACK.
    editor.webContents.setBackgroundThrottling(true)
    editor.maximize()
    editor.show()
    editor.focus()
  })
}

// Resolves when the editor session ends: export, cancel, or the window closing.
// Annotation events are appended to `events` as they arrive.
function runEditor(editor: BrowserWindow, events: TimelineEvent[], t0Ms: number): Promise<EditorOutcome> {
  return new Promise((resolve) => {
    // loadFile/startup guards can close the hidden window before the caller has
    // finished assembling init data and reaches runEditor(). Waiting for a
    // `closed` event that already happened would recreate the same permanent
    // flow lock those guards are meant to prevent.
    if (editor.isDestroyed()) {
      resolve({ kind: 'cancel' })
      return
    }
    let settled = false
    const closeResponseWatchdog = createEditorCloseWatchdog(
      EDITOR_CLOSE_RESPONSE_TIMEOUT_MS,
      () => {
        logWarn('[editor] close confirmation timed out; closing the unresponsive editor')
        settle({ kind: 'cancel' })
      },
    )

    const settle = (outcome: EditorOutcome): void => {
      if (settled) return
      settled = true
      closeResponseWatchdog.dispose()
      ipcMain.removeListener(IPC.editorAnnotationAdded, onAnnotation)
      ipcMain.removeListener(IPC.editorExport, onExport)
      ipcMain.removeListener(IPC.editorSaveAsNew, onSaveAsNew)
      ipcMain.removeListener(IPC.editorCancel, onCancel)
      ipcMain.removeListener(IPC.editorClosePromptShown, onClosePromptShown)
      editor.removeListener('close', onCloseAttempt)
      editor.removeListener('closed', onClosed)
      if (!editor.isDestroyed()) editor.close()
      resolve(outcome)
    }

    const fromEditor = (event: IpcMainEvent): boolean =>
      !editor.isDestroyed() && event.sender === editor.webContents

    // The editor preload sends { id, type } matching the annotation's eventual
    // entry in annotations.json (SPEC §10.2 conventional data fields).
    const onAnnotation = (event: IpcMainEvent, payload: unknown): void => {
      if (!fromEditor(event)) return
      const p = (payload ?? {}) as Partial<EditorAnnotationAddedPayload>
      events.push({
        t_ms: Date.now() - t0Ms,
        type: 'core.annotation.added',
        source: 'core',
        data: {
          annotation_id: typeof p.id === 'string' ? p.id : 'unknown',
          annotation_type: typeof p.type === 'string' ? p.type : 'unknown',
        },
      })
    }

    const onExport = (event: IpcMainEvent, payload: EditorExportPayload): void => {
      if (!fromEditor(event)) return
      settle({ kind: 'export', payload })
    }

    // Edit mode only (the fresh-capture editor never sends it): Save As New.
    const onSaveAsNew = (event: IpcMainEvent, payload: EditorExportPayload): void => {
      if (!fromEditor(event)) return
      settle({ kind: 'saveAsNew', payload })
    }

    const onCancel = (event: IpcMainEvent): void => {
      if (!fromEditor(event)) return
      settle({ kind: 'cancel' })
    }

    const onClosePromptShown = (event: IpcMainEvent): void => {
      if (!fromEditor(event)) return
      // The renderer is responsive and the modal is visible. This is not a
      // close decision: Save/Discard settle later, and Esc deliberately keeps
      // the editor open. A later native Close request arms a fresh deadline.
      closeResponseWatchdog.acknowledge()
    }

    const onCloseAttempt = (event: ElectronEvent): void => {
      if (settled || editor.isDestroyed() || appIsQuitting) return
      event.preventDefault()
      if (editor.webContents.isDestroyed()) {
        settle({ kind: 'cancel' })
        return
      }
      // A crashed or wedged renderer cannot answer the IPC. Do not leave a
      // native window that can never be closed; five seconds is deliberately
      // much longer than the synchronous dirty-state/modal-shown response.
      closeResponseWatchdog.arm()
      editor.webContents.send(IPC.editorCloseRequested)
    }

    const onClosed = (): void => settle({ kind: 'cancel' })

    ipcMain.on(IPC.editorAnnotationAdded, onAnnotation)
    ipcMain.on(IPC.editorExport, onExport)
    ipcMain.on(IPC.editorSaveAsNew, onSaveAsNew)
    ipcMain.on(IPC.editorCancel, onCancel)
    ipcMain.on(IPC.editorClosePromptShown, onClosePromptShown)
    editor.on('close', onCloseAttempt)
    editor.on('closed', onClosed)
  })
}

// ---------------------------------------------------------------------------
// Replay Trim (GOAL "Replay Trim") — fresh-capture flow only

interface TrimRange {
  startMs: number
  endMs: number
  lengthMs: number
}

/**
 * The payload's in/out points validated against the manifest replay clock.
 * Returns null when there is no ACTIVE trim — payload null/null (edit mode
 * always sends that), a degenerate range, or a range covering the full replay
 * — so the caller falls through to exactly the untrimmed save path.
 */
function resolveTrim(payload: EditorExportPayload, replayDurationMs: number): TrimRange | null {
  if (replayDurationMs <= 0) return null
  const rawStart = typeof payload.trimStartMs === 'number' ? payload.trimStartMs : null
  const rawEnd = typeof payload.trimEndMs === 'number' ? payload.trimEndMs : null
  if (rawStart === null && rawEnd === null) return null
  const startMs = Math.min(Math.max(0, Math.round(rawStart ?? 0)), replayDurationMs)
  const endMs = Math.min(Math.max(0, Math.round(rawEnd ?? replayDurationMs)), replayDurationMs)
  if (endMs <= startMs) return null
  if (startMs === 0 && endMs === replayDurationMs) return null
  return { startMs, endMs, lengthMs: endMs - startMs }
}

/**
 * Rebases lifetimes onto the trimmed clock (start/end minus the in-point,
 * clamped into [0, trim length]). Boxes whose lifetime falls WHOLLY outside
 * the kept range are dropped — the editor showed the count hint before saving.
 * Boxes without a lifetime apply to the whole capture and pass through as-is.
 */
function rebaseAnnotationsForTrim(annotations: Annotation[], trim: TrimRange): Annotation[] {
  const result: Annotation[] = []
  for (const a of annotations) {
    if (a.start_ms === undefined || a.end_ms === undefined) {
      result.push(a)
      continue
    }
    if (a.end_ms < trim.startMs || a.start_ms > trim.endMs) continue // wholly outside
    result.push({
      ...a,
      start_ms: clampToTrim(a.start_ms - trim.startMs, trim.lengthMs),
      end_ms: clampToTrim(a.end_ms - trim.startMs, trim.lengthMs),
    })
  }
  return result
}

/**
 * snapshot_t_ms on the trimmed clock.
 *
 * null in means null out: the snapshot IS the capture instant (SPEC §5.3) and
 * stays unstamped. Everything else is CLAMPED into the kept range rather than
 * degraded to null — a video frame that lands outside the trim (only reachable
 * from a hand-built payload now that the editor clamps its own position onto
 * the manifest clock) still is not the capture instant, and saying it is would
 * be the one lie this field can tell.
 */
function rebaseSnapshotTMsForTrim(snapshotTMs: number | null, trim: TrimRange): number | null {
  if (snapshotTMs === null) return null
  return clampToTrim(snapshotTMs - trim.startMs, trim.lengthMs)
}

function clampToTrim(ms: number, lengthMs: number): number {
  return Math.min(Math.max(0, Math.round(ms)), lengthMs)
}

// Replay-relative lifetimes are meaningless in a pack without the replay.
function withoutReplayTimes(a: Annotation): Annotation {
  if (a.start_ms === undefined && a.end_ms === undefined) return a
  const copy = { ...a }
  delete copy.start_ms
  delete copy.end_ms
  return copy
}

/**
 * Waits at most `graceMs` for `promise` and reports WHICH happened: a settled
 * value, or "not yet". The promise itself is never abandoned — its own work
 * still completes, and the caller can keep waiting on it (the object dump is
 * pushed to the editor when it lands late).
 *
 * The grace is a DURATION from this call, never an absolute instant computed
 * somewhere else: a deadline that has already passed used to short-circuit to
 * null WITHOUT LOOKING at the promise, so a payload that had resolved long ago
 * was discarded. And `ready` is the answer to a different question than the
 * value: `{ ready: true, value: null }` means the work finished with nothing —
 * which is worth telling the user — while `{ ready: false }` means it is still
 * running, which is not. A rejection is reported as not-ready: this helper
 * never invents a value, and only the promise's owner can say what its failure
 * means (the object dump's owner catches its own, so it never rejects).
 */
/**
 * "The dump produced nothing usable" — which is EMPTINESS, not null.
 *
 * A helper that printed its window-list header and was then killed (or whose
 * windows were all filtered out, or that ran against a locked/secure desktop)
 * parses into a perfectly valid payload with `windows: []` and `elements: []`.
 * Keying the dropped flag on `payload === null` alone told the editor picking
 * was FINE and then handed it empty lists, so no chip at open, no answer on
 * hover, and a dead click that said nothing — exactly the invisible failure
 * "Silence is not absence" (GOAL, SPEC §11.3) exists to end.
 */
function uiaEmpty(payload: UiaPluginPayload | null): boolean {
  return payload === null || (payload.windows.length === 0 && payload.elements.length === 0)
}

/**
 * The capture-instant observation, on the PACK CLOCK (SPEC §10.1).
 *
 * The dump describes the moment the hotkey was pressed, which is the END of the
 * replay — so it is timestamped `replayDurationMs`, exactly where
 * `core.capture.triggered` sits in timeline.json. Getting this wrong is wrong
 * in a way nobody notices for months (design §3.1), which is why the mapping
 * lives in one place instead of being re-derived per caller.
 */
function contextObservation(
  payload: UiaPluginPayload | null,
  focusedIndex: number,
  replayDurationMs: number,
): ContextObservation | null {
  if (uiaEmpty(payload)) return null
  return {
    tMs: replayDurationMs,
    windows: editorUiaWindows(payload, focusedIndex),
    elements: editorUiaElements(payload, focusedIndex),
  }
}

function settleWithin<T>(
  promise: Promise<T>,
  graceMs: number,
): Promise<{ ready: true; value: T } | { ready: false }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ready: false }), Math.max(0, graceMs))
    void promise.then(
      (value) => {
        clearTimeout(timer)
        resolve({ ready: true, value })
      },
      () => {
        clearTimeout(timer)
        resolve({ ready: false })
      },
    )
  })
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  const ab = new ArrayBuffer(buf.byteLength)
  new Uint8Array(ab).set(buf)
  return ab
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
