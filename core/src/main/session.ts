// Capture flow state machine: pick target display -> snapshot -> replay fetch
// -> save-first -> fullscreen editor on that display -> in-place pack update on
// Save -> save toast + background annotated-replay render.
//
// Also owns the RE-EDIT flow (GOAL "History — Open & re-edit"): startEditFlow
// loads a saved pack folder back into the SAME editor window and saves through
// the same pipeline — updatePack in keepReplay mode (the declared replay is
// never rewritten) or saveAsNewPack for [Save As New CapturePack].
import { app, BrowserWindow, dialog, ipcMain, nativeImage, screen } from 'electron'
import type { IpcMainEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { IPC } from '../shared/ipc'
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
  ManifestDisplayMedia,
  Settings,
  TimelineEvent,
  TimelineFile,
  UiaPluginPayload,
} from '../shared/types'
import { annotationsOnDisplay, focusedDisplayIndex } from '../shared/types'
import { computeDisplayNumbers } from '../shared/numbering'
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
  resolveCaptureTargets,
  resolveTargetDisplay,
  takeDisplaySnapshots,
} from './capture'
import type { ReplayFetch } from './capture'
import { freezeContext, frozenObservations, logContextCost, releaseContext } from './context/runtime'
import {
  addManifestPlugin,
  savePack,
  saveAsNewPack,
  uiaPluginDeclaration,
  updateInitialPack,
  updatePack,
  displayMediaName,
  displayReplayName,
  displaySnapshotName,
  isoWithOffset,
  replayFileName,
  replayMimeType,
  writeUiaPlugin,
  UIA_PLUGIN_NAME,
  type DisplayCapture,
  type ExportInput,
  type InitialSaveInput,
  type PackHandle,
} from './exporter'
import type { ContextObservation } from './context/buffer'
import { editorUiaElements, editorUiaWindows } from './context/legacyPack'
import { openContextSession, pushContextFrame } from './context/service'
import { packDocLanguage, uiLanguage, uiT } from './locale'
import { logError, logInfo, logWarn } from './log'
import { openPack } from './mcp/store'
import { showSaveToast, updateToastRenderStatus } from './saveToast'
import { persistSettings } from './settings'
import {
  mapUiaToSnapshot,
  parseUiaPayload,
  recordUiaSkipped,
  startUiaDump,
  type UiaDisplayTarget,
  type UiaRawDump,
} from './uia'

const REPLAY_TIMEOUT_MS = 5_000

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

export async function startCaptureFlow(settings: Settings): Promise<void> {
  // Every capture REQUEST is recorded, including the ones that do nothing
  // (issue #60): "I pressed the hotkey and nothing happened" has to be
  // answerable, and "an editor was already open" is one of the answers.
  if (flowActive) {
    logWarn('[capture] capture requested while a flow was already open — ignored')
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

/** Re-edit entry point (History [Open]): loads dirPath into the editor. */
export async function startEditFlow(dirPath: string, settings: Settings): Promise<void> {
  if (flowActive) return
  flowActive = true
  try {
    await runEditFlow(dirPath, settings)
  } catch (err) {
    logError(`[capture] re-edit of ${path.basename(dirPath)} failed:`, err)
    dialog.showErrorBox('CapturePack', uiT(settings)('app.reeditFailed', { error: errorMessage(err) }))
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
  replayMimeType: string | null
  replayFile: 'replay.webm' | 'replay.mp4' | null
  // Set when this display came back WITHOUT a replay: why its buffer was not
  // running (GOAL "Say that you are recording"). A capture may never present a
  // missing replay as if nothing were wrong — the editor and the save toast
  // both name this reason. null = the replay is here.
  replayUnavailableReason: RecorderFailureReason | null
}

/**
 * Freezes what the trigger covers: every connected display in "all" mode, the
 * cursor/fixed display otherwise.
 *
 * The FOCUSED display is snapshotted first and alone, so its frame stays as
 * close to the trigger instant as it was before all-displays capture existed —
 * and that one call already carries every same-sized display's frame, so an
 * ordinary desk of identical monitors costs exactly ONE screen capture round
 * trip (see takeDisplaySnapshots). Differently-sized displays follow
 * concurrently (recording already runs for them — "all" costs export work, not
 * capture work). A per-display failure is logged and that display simply drops
 * out of the pack; the focused display's failure is fatal to the capture,
 * exactly as before.
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

  const frozen = (
    display: (typeof targets.displays)[number],
    focused: boolean,
    snap: { png: Buffer; width: number; height: number },
  ): FrozenDisplay => ({
    id: display.id,
    index: indexById.get(display.id) ?? 1,
    focused,
    bounds: { ...display.bounds },
    scale: display.scaleFactor,
    snapshotPng: snap.png,
    width: snap.width,
    height: snap.height,
    replayWebm: null,
    replayDurationMs: 0,
    replayMimeType: null,
    replayFile: null,
    // Filled in by the replay fetch below; a display that never gets one keeps
    // the reason its recorder reports.
    replayUnavailableReason: null,
  })

  // ONE grouped capture for the whole trigger: desktopCapturer's thumbnail size
  // is global, so a call per display would grab every screen N times over (see
  // takeDisplaySnapshots). The focused display's frame is still taken first and
  // alone; a display whose frame did not come back drops out of the pack, and
  // the focused display's failure is fatal to the capture, exactly as before.
  const snaps = await takeDisplaySnapshots(targets.displays, targets.focused)
  const focusedSnap = snaps.get(targets.focused.id)
  if (focusedSnap === undefined) {
    throw new Error(`no screen source available for display ${targets.focused.id}`)
  }
  const focused = frozen(targets.focused, true, focusedSnap)
  const others: FrozenDisplay[] = []
  for (const d of targets.displays) {
    if (d.id === targets.focused.id) continue
    const snap = snaps.get(d.id)
    if (snap === undefined) continue
    others.push(frozen(d, false, snap))
  }
  const displays = [focused, ...others].sort((a, b) => a.index - b.index)

  // Replay fetch runs in parallel: each request is an independent round trip to
  // that display's own recorder window. On timeout, recorder failure, or no
  // recorder window (hotplug rebuild in progress) the display stays
  // screenshot-only.
  await Promise.all(
    displays.map(async (d, i) => {
      const win = captureWindowForDisplay(d.id)
      const fetched: ReplayFetch =
        win === null
          ? { replay: null, miss: 'no-recorder' }
          : await requestReplay(win, randomUUID(), REPLAY_TIMEOUT_MS)
      const replay = fetched.replay
      if (replay === null) {
        // Screenshot-only for this display — and the user is told WHY, in the
        // editor and in the save toast (GOAL "Say that you are recording"). The
        // silent version of this line is exactly what issue #39 reported: a
        // capture that quietly hands back a screenshot-only pack while the tray
        // still claimed a running buffer.
        //
        // The OUTCOME of this request goes with the display id: a recorder that
        // is provably still running (it just answered too late, or with a slot
        // the muxer has not flushed yet) must not be reported as one that never
        // produced video — the tray is saying the opposite at that very moment.
        const reason = replayUnavailableReason(d.id, fetched.miss ?? 'no-recorder')
        logWarn(
          `[capture] display ${d.id}: no replay for this capture (${reason}) — ` +
            'the pack keeps its frozen frame only',
        )
        displays[i] = { ...d, replayUnavailableReason: reason }
        return
      }
      displays[i] = {
        ...d,
        replayWebm: replay.buffer,
        replayDurationMs: replay.durationMs,
        replayMimeType: replay.mimeType,
        replayFile: replay.replayFile,
        replayUnavailableReason: null,
      }
    }),
  )
  const focusedFrozen = displays.find((d) => d.focused) ?? focused
  return { screens, focused: focusedFrozen, displays }
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
function toDisplayCaptures(displays: readonly FrozenDisplay[]): DisplayCapture[] {
  return displays.map((d) => ({
    index: d.index,
    focused: d.focused,
    bounds: d.bounds,
    scale: d.scale,
    hasReplay: d.replayWebm !== null,
    replayDurationMs: d.replayDurationMs,
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
    // Every recorder was stopped by the SAME trigger, so the replays all END at
    // the capture instant even though they started at slightly different times
    // (independent segment rotation). End-alignment is therefore the exact
    // conversion from the pack clock to this display's own clock. A fresh
    // capture is never trimmed at this point — the trim is applied at save.
    replayOffsetMs: d.focused ? 0 : d.replayDurationMs - focusedWindowDurationMs,
  }))
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
  const frozen = await freezeDisplays(settings)
  // WHEN THE REPLAY ACTUALLY ENDS, which is not when the hotkey was pressed.
  //
  // `replay.durationMs` is measured in the RENDERER at the moment it stops the
  // recorder and assembles the blob — after the trigger, after the IPC round
  // trip, after however long muxing thirty seconds of H.264 takes. So the file
  // spans [thisInstant - durationMs, thisInstant], and anchoring the pack clock
  // to `triggerAt` instead shifts every replay time by the assembly cost.
  //
  // Nothing noticed while the pack clock only had to agree with itself. It
  // stopped being invisible the moment surfaces recorded on the wall clock were
  // compared against video frames: every window sat where it had been a moment
  // earlier, uniformly, at every scrub position.
  const replayEndAt = Date.now()
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
  // Anchored to the replay's own end, not the trigger — see `replayEndAt`.
  const t0Ms = replayEndAt - replayDurationMs
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
  const contextFreezeId = freezeContext(replayEndAt, replayDurationMs)
  logInfo(
    `[context] pack clock: replay ends ${String(replayEndAt - triggerAt)} ms after the trigger, ` +
      `${String(replayDurationMs)} ms long (raw ${String(rawReplayDurationMs)} ms)`,
  )
  logContextCost()
  // media.displays[] exists only when the capture actually covered more than
  // one display (SPEC §5.3): a single-display pack stays exactly what 0.1.2
  // wrote. The editor's board follows the same rule: one display, one screen.
  const multiDisplay = frozen.displays.length > 1
  const displayCaptures = multiDisplay ? toDisplayCaptures(frozen.displays) : undefined

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
    snapshotPng: snap.png,
    width: snap.width,
    height: snap.height,
    capturedAt: new Date(triggerAt),
    replayWebm: replay === null ? null : replay.buffer,
    ...(replay === null ? {} : { replayFile: replay.replayFile }),
    // Save-first describes the raw bytes honestly. Finalization replaces this
    // declaration and clock together after the exact background cut.
    replayDurationMs: rawReplayDurationMs,
    timeline: {
      t0: new Date(replayEndAt - rawReplayDurationMs).toISOString(),
      events: events.map((e) =>
        e.type === 'core.capture.triggered' ? { ...e, t_ms: rawReplayDurationMs } : e,
      ),
    },
    outputDir: settings.outputDir,
    // Save-first writes EVERY display (GOAL "Multi-Monitor Support"): a
    // cancelled editor or a crash must not lose the other screens either.
    displays: displayCaptures,
    screens: frozen.screens,
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
  // ONE MAPPING SPACE PER CAPTURED DISPLAY (GOAL "Multi-Monitor Support"): the
  // editor draws every frozen screen and every one of them is annotatable, so
  // every one of them gets its objects in ITS OWN snapshot pixels. The indices
  // are the ones the PACK declares (SPEC §5.6) — which for a single-display
  // capture is 1 and nothing else, exactly what the editor's one-display board
  // calls it, so the payload it writes is byte-for-byte what it always was.
  const uiaTargets: UiaDisplayTarget[] = multiDisplay
    ? frozen.displays.map((d) => ({
        index: d.index,
        focused: d.focused,
        bounds: d.bounds,
        // The snapshot's ACTUAL pixel size — the annotation coordinate space
        // the picked bounds have to land in (SPEC §8.2).
        width: d.focused ? snap.width : d.width,
        height: d.focused ? snap.height : d.height,
      }))
    : [{ index: 1, focused: true, bounds: display.bounds, width: snap.width, height: snap.height }]
  // What an entry WITHOUT a `display` field means, here and in the editor.
  const uiaFocusedIndex = uiaTargets.find((t) => t.focused)?.index ?? 1
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
      await addManifestPlugin(saved, uiaPluginDeclaration())
    } catch (err) {
      logError(`capturepack: writing plugins/${UIA_PLUGIN_NAME} failed:`, err)
    }
    return payload
  })

  const { win: editor, mode: windowMode } = createEditorWindow(display.bounds, settings)
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
      const contextDisplays = uiaTargets.map((target) => ({
        index: target.index,
        focused: target.focused,
        width: target.width,
        height: target.height,
      }))
      const contextSession = openContextSession(editor, {
        displays: contextDisplays,
        replayDurationMs,
        observation: contextObservation(uia, uiaFocusedIndex, replayDurationMs),
        dropped: settled.ready && uiaEmpty(uia),
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
        const ring = frozenObservations(contextFreezeId, contextDisplays, replayDurationMs)
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
        annotations: [],
        title: '',
        note: '',
        editMode: false,
        uiLanguage: uiLanguage(settings),
        // Fullscreen overlay or real window (GOAL "Editor Window Mode") — how
        // the user left it last time.
        windowMode,
      }
      editor.webContents.send(IPC.editorInit, init)
      editor.show()
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
    })()
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

  // Both writers of manifest.json must never interleave: the save-first plugin
  // declaration above patches it in place, updatePack below rewrites it whole.
  // Awaiting here costs nothing — the dump resolved long before the user saved.
  const uiaPayload = await uiaWrite

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
          t0: new Date(t0Ms + trim.startMs).toISOString(),
          events: events.map((e) => ({ ...e, t_ms: Math.max(0, e.t_ms - trim.startMs) })),
        }
  const sourceTrimStartMs = replaySourceStartMs + keptRange.startMs
  const needsExactCut =
    replayWebm !== null &&
    (sourceTrimStartMs > 0 || replaySourceStartMs + keptRange.endMs < rawReplayDurationMs)

  const input: ExportInput = {
    snapshotPng: Buffer.from(outcome.payload.snapshotPng),
    width: snap.width,
    height: snap.height,
    capturedAt: new Date(triggerAt),
    replayWebm,
    ...(replay === null ? {} : { replayFile: replay.replayFile }),
    replayDurationMs: keptRange.lengthMs,
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
    copyToClipboard: settings.copyToClipboard,
    docLanguage: packDocLanguage(settings),
  }

  try {
    // Save-first failed earlier? Retry the initial write now, then finalize.
    if (handle === null) handle = await savePack(initialSave)
    const savedHandle = handle
    const hasReplay = replayWebm !== null
    // The SAVE result (issue #60): pack name, annotation count, and whether a
    // replay went in — the three things every later question about a pack asks.
    logInfo(
      `[capture] saved ${path.basename(savedHandle.dirPath)}: ` +
        `${input.annotations.length} annotation(s), replay ${hasReplay ? 'included' : 'MISSING'}`,
    )
    showSaveToast({
      folderPath: savedHandle.dirPath,
      hasBlur: input.annotations.some((a) => a.blur),
      // "Saved" must not read as "saved everything": a display whose buffer was
      // not running produced no replay, and the toast is the last place the user
      // looks before moving on (GOAL "Say that you are recording").
      replayUnavailable: replayUnavailableForToast(frozen.displays),
      renderState: hasReplay ? (needsExactCut ? 'trimming' : 'rendering') : 'none',
      uiLanguage: uiLanguage(settings),
    })

    const finalize = async (): Promise<void> => {
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
      const finalFocused = finalDisplays.find((d) => d.focused) ?? display
      const finalInput: ExportInput = {
        ...input,
        replayWebm: finalFocused.replayWebm,
        ...(finalFocused.replayFile === null ? {} : { replayFile: finalFocused.replayFile }),
        replayDurationMs: finalFocused.replayDurationMs,
        displays: multiDisplay ? toDisplayCaptures(finalDisplays) : undefined,
      }
      const dirPath = await updatePack(savedHandle, finalInput)
      if (needsExactCut && finalFocused.replayWebm !== null) {
        updateToastRenderStatus(dirPath, 'rendering')
      }
      startFreshCaptureRenders(
        savedHandle,
        finalInput,
        finalDisplays,
        display.index,
        settings,
        dirPath,
      )
    }

    if (needsExactCut) {
      // Fire-and-forget: the editor closes and the folder toast appears before
      // any real-time cut. The serialized render queue performs the exact cut,
      // updates every clock-bearing file, then starts replay_annotated.
      void finalize().catch((err: unknown) =>
        handleExactCutFailure(savedHandle, input, frozen, display.index, settings, err),
      )
    } else {
      await finalize()
    }
  } catch (err) {
    logError('[capture] save failed:', err)
    dialog.showErrorBox(uiT(settings)('app.saveFailedTitle'), errorMessage(err))
  }
}

/**
 * Cuts every recorded display to the same end-aligned pack interval. The
 * focused display defines the pack clock; a shorter secondary buffer remains
 * honestly shorter rather than being padded. All jobs pass through the global
 * render queue, so multi-display finalization never fans out encoders.
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
  const cutFocused = await cutFrozenDisplay(
    focused,
    focusedSourceStart + keptRange.startMs,
    focusedSourceStart + keptRange.endMs,
    fps,
  )

  const distanceFromEndAtStart = focusedWindowDurationMs - keptRange.startMs
  const distanceFromEndAtEnd = focusedWindowDurationMs - keptRange.endMs
  const result: FrozenDisplay[] = []
  for (const display of displays) {
    if (display.index === focused.index) {
      result.push(cutFocused)
      continue
    }
    const startMs = display.replayDurationMs - distanceFromEndAtStart
    const endMs = display.replayDurationMs - distanceFromEndAtEnd
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
  return {
    ...display,
    replayWebm,
    replayDurationMs: endMs - startMs,
    replayMimeType: 'video/webm',
    replayFile: 'replay.webm',
  }
}

function withoutFrozenReplay(display: FrozenDisplay): FrozenDisplay {
  return {
    ...display,
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
        displayNumbers: numbers,
        width: input.width,
        height: input.height,
        fps: settings.fps,
        replayDurationMs: input.replayDurationMs,
        docLanguage: packDocLanguage(settings),
      },
      (state) => updateToastRenderStatus(dirPath, state),
    )
  } else {
    startKeyframeStill(handle, {
      snapshotPng: input.snapshotPng,
      annotations: focusedAnnotations,
      displayNumbers: numbers,
      width: input.width,
      height: input.height,
      docLanguage: packDocLanguage(settings),
    })
  }

  if (displays.length > 1) {
    const focusedDurationMs = focused?.replayDurationMs ?? 0
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
        offsetMs: d.replayDurationMs - focusedDurationMs,
      })),
      input.annotations,
      focusedIndex,
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
            t0: new Date(initial.capturedAt.getTime() - replayDurationMs).toISOString(),
            events: initial.timeline.events.map((e) => ({
              ...e,
              t_ms: Math.max(0, e.t_ms - replaySourceStartMs),
            })),
          },
    displays: displays.length > 1 ? toDisplayCaptures(displays) : undefined,
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
  // The pack's own capture-instant object data (GOAL "Static object picking"):
  // re-editing offers exactly the same picking as the original session.
  const loadedUiaText = pack.readText(`plugins/${UIA_PLUGIN_NAME}/elements.json`)
  const loadedUia = parseUiaPayload(loadedUiaText)
  // A pack that never had object data is not a pack whose object data was
  // DROPPED: the flag is only for a payload that is there and unreadable, so
  // the editor can say so instead of behaving like the pre-feature editor for
  // no visible reason.
  const loadedUiaDropped = loadedUiaText !== null && uiaEmpty(loadedUia)
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
  const { win: editor, mode: windowMode } = createEditorWindow(display.bounds, settings)
  const loadedEditorDisplayList = loadedEditorDisplays(pack, loadedDisplays, replayDurationMs)
  // Picking works on re-edit too, from the pack's own saved observation — which
  // for every pack written before v0.2.0 describes exactly one instant, and the
  // frame says so for every other time rather than offering that instant's
  // rectangles as if they were the moment on screen (#66).
  const contextSession = openContextSession(editor, {
    displays:
      loadedEditorDisplayList.length === 0
        ? [{ index: 1, focused: true, width, height }]
        : loadedEditorDisplayList.map((d) => ({
            index: d.index,
            focused: d.focused,
            width: d.width,
            height: d.height,
          })),
    replayDurationMs,
    observation: contextObservation(loadedUia, loadedFocusedIndex, replayDurationMs),
    dropped: loadedUiaDropped,
  })
  editor.once('ready-to-show', () => {
    void (async () => {
    const init: EditorInitPayload = {
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
      context: {
        sessionId: contextSession.sessionId,
        frame: await contextSession.frameAt(replayDurationMs),
      },
      fps: settings.fps,
      scrubInvert: settings.scrubInvert,
      scrubSensitivityMs: settings.scrubSensitivityMs,
      defaultManualDurationMs: settings.defaultManualDurationMs,
      showDurationLabel: settings.showDurationLabel,
      showShortcutOverlay: settings.showShortcutOverlay,
      annotations: loadedAnnotations,
      title: typeof manifest.title === 'string' ? manifest.title : '',
      note: typeof manifest.note === 'string' ? manifest.note : '',
      editMode: true,
      uiLanguage: uiLanguage(settings),
      // Re-edit opens in the same remembered mode as a fresh capture.
      windowMode,
    }
    if (editor.isDestroyed()) return
    editor.webContents.send(IPC.editorInit, init)
    editor.show()
    })().catch((err: unknown) => {
      // Rule 1 of object data: it may never break anything else. An editor that
      // could not build its first frame still opens — it simply opens without
      // picking, and the log says why.
      logError('capturepack: opening the re-edit editor failed:', err)
    })
  })

  const outcome = await runEditor(editor, events, t0Ms)
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
  const input: ExportInput = {
    snapshotPng: Buffer.from(outcome.payload.snapshotPng),
    width,
    height,
    capturedAt, // created_at stays the ORIGINAL capture instant
    replayWebm: null, // never carried through a re-edit save
    // The pack keeps the replay it already has, under the name it declares.
    ...(replayRel !== null ? { replayFile: replayRel } : {}),
    replayDurationMs,
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
    // Same rule for per-display media: the files stay, the declaration is
    // regenerated from what the folder actually holds.
    displays: savedDisplays.length > 0 ? savedDisplays : undefined,
    screens: loadedScreens.length > 0 ? loadedScreens : undefined,
    copyToClipboard: settings.copyToClipboard,
    // Re-edit saves regenerate the docs too — in the CURRENT pack language.
    docLanguage: packDocLanguage(settings),
  }

  try {
    const handle: PackHandle =
      outcome.kind === 'saveAsNew'
        ? await saveAsNewPack(dirPath, input)
        : { id: manifest.id, dirPath }
    if (outcome.kind === 'export') await updatePack(handle, input, { keepReplay: true })
    // Same save pipeline as a fresh capture: toast, then background render.
    showSaveToast({
      folderPath: handle.dirPath,
      hasBlur: savedAnnotations.some((a) => a.blur),
      // Re-edit: nothing was recorded during this save, so there is no recorder
      // failure to report — the pack's replay is whatever it already had.
      replayUnavailable: null,
      renderState: hasReplay ? 'rendering' : 'none',
      uiLanguage: uiLanguage(settings),
    })
    // Same per-display rule as a fresh save: the pack's own annotated views are
    // the FOCUSED display's, and every other annotated screen renders its own.
    const focusedIndex = savedDisplays.find((d) => d.focused)?.index ?? 1
    const focusedAnnotations = annotationsOnDisplay(savedAnnotations, focusedIndex, focusedIndex)
    // GLOBAL over everything the save wrote (SPEC §8.5), never over the subset
    // one render receives.
    const numbers = globalDisplayNumbers(savedAnnotations)
    if (replayWebm !== null) {
      startAnnotatedRender(
        handle,
        {
          replayWebm,
          replayMimeType: replayMimeType(replayRel),
          annotations: focusedAnnotations,
          displayNumbers: numbers,
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
      startKeyframeStill(handle, {
        snapshotPng: input.snapshotPng,
        annotations: focusedAnnotations,
        displayNumbers: numbers,
        width,
        height,
        docLanguage: packDocLanguage(settings),
      })
    }
    startDisplayRenders(
      handle,
      // Read back from the SOURCE pack (the same bytes Save As New copied), and
      // only for displays that actually carry boxes — a re-edit must not pull
      // 45 MB of webm per untouched screen back into memory.
      displayRenderSources(pack, savedDisplays, savedAnnotations, focusedIndex),
      savedAnnotations,
      focusedIndex,
      settings.fps,
      packDocLanguage(settings),
    )
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

/** Lifetimes moved onto one display's own replay clock, clamped to it. */
function rebaseLifetimeTo(a: Annotation, offsetMs: number, durationMs: number): Annotation {
  if (a.start_ms === undefined || a.end_ms === undefined) return a
  const clamp = (ms: number): number => Math.min(Math.max(0, Math.round(ms)), durationMs)
  return { ...a, start_ms: clamp(a.start_ms + offsetMs), end_ms: clamp(a.end_ms + offsetMs) }
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
        displayNumbers,
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
        displayNumbers,
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
      snapshotFile,
      replayFile: hasReplay ? replayFile : null,
      snapshotPng: null,
      replayWebm: null,
    })
  }
  return result.length > 1 ? result : []
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
 * ALIGNMENT (SPEC §5.6): every recorder was stopped by the same trigger, so the
 * replays are END-aligned and the offset from the pack clock onto a display's
 * own clock is the difference of the DECLARED durations — this display's minus
 * the focused one's. That expression already contains the trim: after an
 * in-point trim at s the focused declaration is F - s, so D - (F - s) is
 * exactly `trim_offset_ms + (D - F)`, which is what the fresh flow computes
 * from the live durations. Using trim_offset_ms ALONE (SPEC §5.6's older, and
 * for unequal-length displays incomplete, wording) dropped the end-alignment
 * term and put every other screen seconds off — see SPEC §5.6.
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
      offsetMs: d.replayDurationMs - focusedDurationMs,
    })
  }
  return sources
}

/**
 * The saved pack's per-display media, read back for the editor board: the same
 * payload a fresh capture ships, so re-editing an all-displays pack gives the
 * same board — every screen drawn at once, every screen annotatable, one clock.
 *
 * `focusedDurationMs` is the SAVED focused replay length, so the end-alignment
 * below already carries any trim the pack was written with — the same
 * expression displayRenderSources() uses, so the board and the per-display
 * renders can never disagree about where a display's clock is (SPEC §5.6).
 */
function loadedEditorDisplays(
  pack: { readBinary(rel: string): Buffer | null },
  displays: readonly DisplayCapture[],
  focusedDurationMs: number,
): EditorDisplayPayload[] {
  if (displays.length < 2) return []
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
      replayOffsetMs: d.focused ? 0 : durationMs - focusedDurationMs,
    })
  }
  return result.length > 1 ? result : []
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
  const mode: EditorWindowMode = settings.editorWindowMode === 'windowed' ? 'windowed' : 'fullscreen'
  // Resolved even when opening fullscreen: a later ⧉ / F11 has to land
  // somewhere sane too.
  let windowedBounds = openingWindowedBounds(settings.editorWindowBounds, openingWorkArea)
  const windowed = mode === 'windowed'
  const editor = new BrowserWindow({
    ...(windowed ? windowedBounds : bounds),
    frame: false,
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
    },
  })
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

  editor.on('closed', () => {
    ipcMain.removeListener(IPC.editorSetWindowMode, onSetWindowMode)
    ipcMain.removeListener(IPC.editorSetShortcutOverlay, onSetShortcutOverlay)
    // Final rectangle (the move/resize listeners kept it current while the
    // window lived) — this is what the next capture opens at.
    persist()
  })

  void editor.loadFile(path.join(app.getAppPath(), 'dist', 'renderer', 'editor', 'editor.html'))
  return { win: editor, mode }
}

// Resolves when the editor session ends: export, cancel, or the window closing.
// Annotation events are appended to `events` as they arrive.
function runEditor(editor: BrowserWindow, events: TimelineEvent[], t0Ms: number): Promise<EditorOutcome> {
  return new Promise((resolve) => {
    let settled = false

    const settle = (outcome: EditorOutcome): void => {
      if (settled) return
      settled = true
      ipcMain.removeListener(IPC.editorAnnotationAdded, onAnnotation)
      ipcMain.removeListener(IPC.editorExport, onExport)
      ipcMain.removeListener(IPC.editorSaveAsNew, onSaveAsNew)
      ipcMain.removeListener(IPC.editorCancel, onCancel)
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

    const onClosed = (): void => settle({ kind: 'cancel' })

    ipcMain.on(IPC.editorAnnotationAdded, onAnnotation)
    ipcMain.on(IPC.editorExport, onExport)
    ipcMain.on(IPC.editorSaveAsNew, onSaveAsNew)
    ipcMain.on(IPC.editorCancel, onCancel)
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
