// Capture flow state machine: pick target display -> snapshot -> replay fetch
// -> save-first -> fullscreen editor on that display -> in-place pack update on
// Save -> save toast + background annotated-replay render.
//
// Also owns the RE-EDIT flow (GOAL "History — Open & re-edit"): startEditFlow
// loads a saved pack folder back into the SAME editor window and saves through
// the same pipeline — updatePack in keepReplay mode (replay.webm is never
// rewritten) or saveAsNewPack for [Save As New CapturePack].
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
import { renderTrimmedReplay, startAnnotatedRender, startKeyframeStill } from './annotatedRender'
import {
  captureWindowForDisplay,
  requestReplay,
  resolveCaptureTargets,
  resolveTargetDisplay,
  takeSnapshot,
} from './capture'
import {
  addManifestPlugin,
  savePack,
  saveAsNewPack,
  uiaPluginDeclaration,
  updatePack,
  displaySnapshotName,
  isoWithOffset,
  writeUiaPlugin,
  UIA_PLUGIN_NAME,
  type DisplayCapture,
  type ExportInput,
  type InitialSaveInput,
  type PackHandle,
} from './exporter'
import { packDocLanguage, uiLanguage, uiT } from './locale'
import { openPack } from './mcp/store'
import { showSaveToast, updateToastRenderStatus } from './saveToast'
import { persistSettings } from './settings'
import {
  editorUiaElements,
  mapUiaToSnapshot,
  parseUiaPayload,
  startUiaDump,
  UIA_BUDGET_MS,
} from './uia'

const REPLAY_TIMEOUT_MS = 5_000

/** Plugin name pattern from SPEC §5.4 — also what makes a name path-safe. */
const PLUGIN_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

// How long past the UIA budget the editor may wait for the object dump before
// opening without it (GOAL: "never delaying the editor"). The dump is started
// at the trigger and killed at UIA_BUDGET_MS, so by the time the editor window
// is ready — after the snapshot, the replay fetch, and save-first — it has
// almost always resolved and this deadline is never reached. It exists so that
// a pathological child (kill signal ignored) cannot hold the editor at all.
const UIA_EDITOR_DEADLINE_MS = UIA_BUDGET_MS + 400

type EditorOutcome =
  | { kind: 'export' | 'saveAsNew'; payload: EditorExportPayload }
  | { kind: 'cancel' }

// One flow at a time, shared across capture AND re-edit: two fullscreen
// editors (or an editor over a capture in progress) must never coexist.
let flowActive = false

export async function startCaptureFlow(settings: Settings): Promise<void> {
  if (flowActive) return
  flowActive = true
  try {
    await runFlow(settings)
  } catch (err) {
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
}

/**
 * Freezes what the trigger covers: every connected display in "all" mode, the
 * cursor/fixed display otherwise.
 *
 * The FOCUSED display is snapshotted first and alone, so its frame stays as
 * close to the trigger instant as it was before all-displays capture existed;
 * the other displays follow concurrently (recording already runs for them —
 * "all" costs export work, not capture work). A per-display failure is logged
 * and that display simply drops out of the pack; the focused display's failure
 * is fatal to the capture, exactly as before.
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

  const freeze = async (
    display: (typeof targets.displays)[number],
    focused: boolean,
  ): Promise<FrozenDisplay> => {
    const snap = await takeSnapshot(display, { exact: !focused })
    return {
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
    }
  }

  const focused = await freeze(targets.focused, true)
  const others = await Promise.all(
    targets.displays
      .filter((d) => d.id !== targets.focused.id)
      .map(async (d) => {
        try {
          return await freeze(d, false)
        } catch (err) {
          console.error(`capturepack: display ${d.id} snapshot failed:`, errorMessage(err))
          return null
        }
      }),
  )
  const displays = [focused, ...others.filter((d): d is FrozenDisplay => d !== null)].sort(
    (a, b) => a.index - b.index,
  )

  // Replay fetch runs in parallel: each request is an independent round trip to
  // that display's own recorder window. On timeout, recorder failure, or no
  // recorder window (hotplug rebuild in progress) the display stays
  // screenshot-only.
  await Promise.all(
    displays.map(async (d, i) => {
      const win = captureWindowForDisplay(d.id)
      const replay = win === null ? null : await requestReplay(win, randomUUID(), REPLAY_TIMEOUT_MS)
      if (replay === null) return
      displays[i] = { ...d, replayWebm: replay.buffer, replayDurationMs: replay.durationMs }
    }),
  )
  const focusedFrozen = displays.find((d) => d.focused) ?? focused
  return { screens, focused: focusedFrozen, displays }
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
    snapshotPng: d.focused ? null : d.snapshotPng,
    replayWebm: d.focused ? null : d.replayWebm,
  }))
}

/** The editor's read-only display switcher payload (empty for a single display). */
function toEditorDisplays(displays: readonly FrozenDisplay[]): EditorDisplayPayload[] {
  if (displays.length < 2) return []
  return displays.map((d) => ({
    index: d.index,
    focused: d.focused,
    snapshotPng: toArrayBuffer(d.snapshotPng),
    width: d.width,
    height: d.height,
  }))
}

async function runFlow(settings: Settings): Promise<void> {
  const triggerAt = Date.now()
  // Static object picking (GOAL "Static object picking (v0)"): the Windows UI
  // Automation dump is fired FIRST and never awaited on the critical path. It
  // runs concurrently with the snapshot, the replay fetch, and save-first, is
  // hard-killed at its budget, and resolves null on any failure — a capture can
  // neither fail nor slow down because of it.
  const uiaDump = startUiaDump()
  // "all": every connected display is frozen, the cursor's display is the
  // FOCUSED one. "cursor"/fixed: that display alone. Snapshot, replay, editor,
  // and annotations all target the focused display.
  const frozen = await freezeDisplays(settings)
  const display = frozen.focused
  const snap = { png: display.snapshotPng, width: display.width, height: display.height }
  const replay =
    display.replayWebm === null
      ? null
      : { buffer: display.replayWebm, durationMs: display.replayDurationMs }
  const replayDurationMs = replay === null ? 0 : replay.durationMs
  const t0Ms = triggerAt - replayDurationMs
  // media.displays[] exists only when the capture actually covered more than
  // one display (SPEC §5.3): a single-display pack stays exactly what 0.1.2
  // wrote. The editor's display switcher follows the same rule.
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
    replayDurationMs,
    timeline: { t0: new Date(t0Ms).toISOString(), events: [...events] },
    outputDir: settings.outputDir,
    // Save-first writes EVERY display (GOAL "Multi-Monitor Support"): a
    // cancelled editor or a crash must not lose the other screens either.
    displays: displayCaptures,
    screens: frozen.screens,
    docLanguage: packDocLanguage(settings),
  }
  let handle: PackHandle | null = null
  try {
    handle = await savePack(initialSave)
  } catch (err) {
    console.error('capturepack: save-first failed:', errorMessage(err))
  }

  // The dump's coordinates only become meaningful once the FOCUSED display is
  // known, which is why the mapping happens here rather than in the helper.
  // Neither promise may EVER reject: a rejection here would surface as
  // "Capture failed", and object data must never be able to fail a capture.
  const uiaReady: Promise<UiaPluginPayload | null> = uiaDump
    .then((raw) =>
      raw === null
        ? null
        : mapUiaToSnapshot(raw, {
            bounds: display.bounds,
            // The snapshot's ACTUAL pixel size — the annotation coordinate space
            // the picked bounds have to land in (SPEC §8.2).
            width: snap.width,
            height: snap.height,
          }),
    )
    .catch((err: unknown) => {
      console.error('capturepack: mapping the UI Automation dump failed:', errorMessage(err))
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
      console.error(`capturepack: writing plugins/${UIA_PLUGIN_NAME} failed:`, errorMessage(err))
    }
    return payload
  })

  const { win: editor, mode: windowMode } = createEditorWindow(display.bounds, settings)
  editor.once('ready-to-show', () => {
    void (async () => {
      // Bounded by construction: the dump was started at the trigger and can
      // never outlive its budget, so this is a no-op wait in the normal case.
      const uia = await withDeadline(uiaReady, triggerAt + UIA_EDITOR_DEADLINE_MS)
      if (editor.isDestroyed()) return
      const init: EditorInitPayload = {
        snapshotPng: toArrayBuffer(snap.png),
        width: snap.width,
        height: snap.height,
        hasReplay: replay !== null,
        replayDurationMs,
        // Read-only display switcher (GOAL "Multi-Monitor Support"): the other
        // frozen displays, viewable but not annotatable in this version.
        displays: toEditorDisplays(frozen.displays),
        // Replay bytes are already in memory; the editor scrubs its own copy and
        // never re-requests them at export time.
        replayWebm: replay === null ? null : toArrayBuffer(replay.buffer),
        // Pickable objects (GOAL "Static object picking"); [] when the dump
        // produced nothing, which is exactly the pre-feature editor.
        uiaElements: editorUiaElements(uia),
        fps: settings.fps,
        scrubInvert: settings.scrubInvert,
        scrubSensitivityMs: settings.scrubSensitivityMs,
        defaultManualDurationMs: settings.defaultManualDurationMs,
        showDurationLabel: settings.showDurationLabel,
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
    })()
  })

  const outcome = await runEditor(editor, events, t0Ms)
  if (outcome.kind === 'cancel') return

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
  // t0 is the start of replay.webm (SPEC §10.1). No rebase is possible here:
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

  const input: ExportInput = {
    snapshotPng: Buffer.from(outcome.payload.snapshotPng),
    width: snap.width,
    height: snap.height,
    capturedAt: new Date(triggerAt),
    replayWebm,
    replayDurationMs, // already 0 whenever replayWebm is null
    annotations,
    title: outcome.payload.title,
    note: outcome.payload.note,
    snapshotTMs,
    timeline,
    displays: displayCaptures,
    screens: frozen.screens,
    // Rewritten (and declared) by the finalize save too, so a save-first that
    // failed and had to be retried below still ends up with the object data.
    uia: uiaPayload ?? undefined,
    copyToClipboard: settings.copyToClipboard,
    docLanguage: packDocLanguage(settings),
  }

  // Replay Trim (GOAL "Replay Trim") — fresh-capture flow only. null when the
  // capture has no replay or the payload carries no active trim: the save
  // below is then exactly the untrimmed path.
  const trim = replayWebm === null ? null : resolveTrim(outcome.payload, replayDurationMs)

  try {
    // Save-first failed earlier? Retry the initial write now, then finalize.
    if (handle === null) handle = await savePack(initialSave)
    // What updatePack writes and what the annotated render consumes; the trim
    // step below swaps in the trimmed bytes + the rebased (trimmed-clock) data.
    let finalInput = input
    let renderWebm = replayWebm
    let renderAnnotations = annotations
    let renderDurationMs = replayDurationMs
    let toastShown = false
    if (trim !== null && replayWebm !== null) {
      // Trim save: the toast opens EARLY ("Trimming replay…") because the
      // plain-trim render plays the kept range in real time before the pack
      // can be updated; the annotated render then flips it to 'rendering'.
      const trimmedAnnotations = rebaseAnnotationsForTrim(annotations, trim)
      showSaveToast({
        folderPath: handle.dirPath,
        hasBlur: trimmedAnnotations.some((a) => a.blur),
        renderState: 'trimming',
        uiLanguage: uiLanguage(settings),
      })
      toastShown = true
      try {
        // The TRIMMED replay bytes first, via the render pipeline in plain
        // mode (empty overlay set, arbitrary range) — then everything else is
        // rebased onto the trimmed clock and the normal pipeline runs.
        //
        // Only the FOCUSED display's replay is trimmed: re-encoding every
        // display would cost one real-time render per screen. The non-focused
        // replays keep the original recording's clock, which readers align by
        // adding media.trim_offset_ms (SPEC §5.3).
        const trimmedWebm = await renderTrimmedReplay({
          replayWebm,
          width: snap.width,
          height: snap.height,
          fps: settings.fps,
          sourceDurationMs: replayDurationMs,
          trimStartMs: trim.startMs,
          trimEndMs: trim.endMs < replayDurationMs ? trim.endMs : null,
        })
        finalInput = {
          ...input,
          replayWebm: trimmedWebm,
          replayDurationMs: trim.lengthMs,
          annotations: trimmedAnnotations,
          snapshotTMs: rebaseSnapshotTMsForTrim(input.snapshotTMs, trim),
          // t0 stays the instant of the replay's first frame (SPEC §10.1) —
          // which is now the trim in-point; events shift with it (clamped so
          // pre-in-point events cannot go negative, like every other rebase).
          timeline: {
            t0: new Date(t0Ms + trim.startMs).toISOString(),
            events: events.map((e) => ({ ...e, t_ms: Math.max(0, e.t_ms - trim.startMs) })),
          },
          trimOffsetMs: trim.startMs,
        }
        renderWebm = trimmedWebm
        renderAnnotations = trimmedAnnotations
        renderDurationMs = trim.lengthMs
      } catch (err) {
        // The trim is best-effort — never lose the capture over it: fall back
        // to saving the full-range replay (the untrimmed path) and say so.
        // Async on purpose (like index.ts's hotkey dialog): showErrorBox would
        // block the main-process event loop mid-save, freezing the visible
        // "Trimming replay…" toast, the fallback updatePack write below, and
        // the always-on MCP server until dismissed.
        console.error('capturepack: replay trim failed:', errorMessage(err))
        void dialog.showMessageBox({
          type: 'error',
          title: 'CapturePack', // product name — never translated
          message: uiT(settings)('app.trimFailed', { error: errorMessage(err) }),
        })
      }
    }
    const dirPath: string = await updatePack(handle, finalInput)
    // Save pipeline (GOAL): update folder -> toast -> background render. The
    // toast never waits for the render; its status line flips when it ends.
    const hasReplay = renderWebm !== null
    if (toastShown) {
      updateToastRenderStatus(dirPath, hasReplay ? 'rendering' : 'none')
    } else {
      showSaveToast({
        folderPath: dirPath,
        hasBlur: finalInput.annotations.some((a) => a.blur),
        renderState: hasReplay ? 'rendering' : 'none',
        uiLanguage: uiLanguage(settings),
      })
    }
    if (renderWebm !== null) {
      startAnnotatedRender(
        handle,
        {
          replayWebm: renderWebm,
          annotations: renderAnnotations,
          width: snap.width,
          height: snap.height,
          fps: settings.fps,
          replayDurationMs: renderDurationMs,
        },
        (state) => updateToastRenderStatus(dirPath, state),
      )
    } else {
      // Screenshot-only pack: no video to render, but it still gets its ONE
      // annotated still (GOAL "Annotated keyframes", SPEC §7.3) so an LLM sees
      // the annotations without opening snapshot.png + annotations.json.
      startKeyframeStill(handle, {
        snapshotPng: finalInput.snapshotPng,
        annotations: finalInput.annotations,
        width: snap.width,
        height: snap.height,
      })
    }
  } catch (err) {
    dialog.showErrorBox(uiT(settings)('app.saveFailedTitle'), errorMessage(err))
  }
}

// Re-edit (GOAL "History — Open & re-edit"): the Folder IS the project — no
// conversion step. Everything is read back from the pack folder, the editor
// restores it, and Save updates the SAME folder through the existing pipeline
// with one hard rule: replay.webm is NEVER rewritten on re-edit.
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
  const replayRel = manifest.media?.replay
  const replayWebm = typeof replayRel === 'string' ? pack.readBinary(replayRel) : null
  // The duration the manifest DECLARES, kept even when the replay file is
  // missing on disk: the degraded save must rebase the loaded timeline off it.
  const declaredDurationMs =
    typeof replayRel === 'string' && typeof manifest.media.replay_duration_ms === 'number'
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
  const loadedUia = parseUiaPayload(pack.readText(`plugins/${UIA_PLUGIN_NAME}/elements.json`))
  // All-displays pack (GOAL "Multi-Monitor Support"): the per-display files
  // stay on disk untouched, so the re-edit save carries their DECLARATION
  // through with null buffers — dropping entries whose files have since
  // vanished, so the regenerated manifest never declares a missing file.
  const loadedDisplays = loadedDisplayCaptures(manifest, dirPath)
  // The displays present at CAPTURE time — media.displays indices point into
  // this list, so it must survive the regenerated manifest too.
  const loadedScreens = Array.isArray(manifest.environment?.screens)
    ? manifest.environment.screens.filter(
        (s): s is { width: number; height: number; scale: number } =>
          s !== null && typeof s === 'object' && typeof s.width === 'number' && typeof s.height === 'number',
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
  editor.once('ready-to-show', () => {
    const init: EditorInitPayload = {
      snapshotPng: toArrayBuffer(snapshotPng),
      width,
      height,
      hasReplay: replayWebm !== null,
      replayDurationMs,
      // The saved pack's other frozen displays, read back for the same
      // read-only switcher a fresh multi-display capture shows.
      displays: loadedEditorDisplays(pack, loadedDisplays),
      replayWebm: replayWebm === null ? null : toArrayBuffer(replayWebm),
      // Picking works on re-edit too, from the pack's own saved dump.
      uiaElements: editorUiaElements(loadedUia),
      fps: settings.fps,
      scrubInvert: settings.scrubInvert,
      scrubSensitivityMs: settings.scrubSensitivityMs,
      defaultManualDurationMs: settings.defaultManualDurationMs,
      showDurationLabel: settings.showDurationLabel,
      annotations: loadedAnnotations,
      title: typeof manifest.title === 'string' ? manifest.title : '',
      note: typeof manifest.note === 'string' ? manifest.note : '',
      editMode: true,
      uiLanguage: uiLanguage(settings),
      // Re-edit opens in the same remembered mode as a fresh capture.
      windowMode,
    }
    editor.webContents.send(IPC.editorInit, init)
    editor.show()
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
  const input: ExportInput = {
    snapshotPng: Buffer.from(outcome.payload.snapshotPng),
    width,
    height,
    capturedAt, // created_at stays the ORIGINAL capture instant
    replayWebm: null, // never carried through a re-edit save
    replayDurationMs,
    annotations,
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
    displays: loadedDisplays.length > 0 ? loadedDisplays : undefined,
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
      hasBlur: annotations.some((a) => a.blur),
      renderState: hasReplay ? 'rendering' : 'none',
      uiLanguage: uiLanguage(settings),
    })
    if (replayWebm !== null) {
      startAnnotatedRender(
        handle,
        {
          replayWebm,
          annotations,
          width,
          height,
          fps: settings.fps,
          replayDurationMs,
        },
        (state) => updateToastRenderStatus(handle.dirPath, state),
      )
    } else {
      // Same rule on re-edit: a pack without a replay re-renders its single
      // annotated still from the saved snapshot (SPEC §7.3).
      startKeyframeStill(handle, {
        snapshotPng: input.snapshotPng,
        annotations,
        width,
        height,
      })
    }
  } catch (err) {
    dialog.showErrorBox(uiT(settings)('app.saveFailedTitle'), errorMessage(err))
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
    // The focused display's files are the top-level ones, which the caller
    // already validated; a non-focused display without its snapshot on disk
    // must not be declared again.
    if (!e.focused && !existsSync(path.join(dirPath, e.snapshot))) continue
    const hasReplay =
      typeof e.replay === 'string' && (e.focused || existsSync(path.join(dirPath, e.replay)))
    result.push({
      index: e.index,
      focused: e.focused,
      bounds: { ...e.bounds },
      scale: typeof e.scale === 'number' && e.scale > 0 ? e.scale : 1,
      hasReplay,
      replayDurationMs: typeof e.replay_duration_ms === 'number' ? Math.max(0, e.replay_duration_ms) : 0,
      snapshotPng: null,
      replayWebm: null,
    })
  }
  return result.length > 1 ? result : []
}

/** The saved pack's per-display snapshots, for the editor's read-only switcher. */
function loadedEditorDisplays(
  pack: { readBinary(rel: string): Buffer | null },
  displays: readonly DisplayCapture[],
): EditorDisplayPayload[] {
  if (displays.length < 2) return []
  const result: EditorDisplayPayload[] = []
  for (const d of displays) {
    const rel = d.focused ? 'snapshot.png' : displaySnapshotName(d.index)
    const png = pack.readBinary(rel)
    if (png === null) continue
    const size = nativeImage.createFromBuffer(png).getSize()
    if (size.width <= 0 || size.height <= 0) continue
    result.push({
      index: d.index,
      focused: d.focused,
      snapshotPng: toArrayBuffer(png),
      width: size.width,
      height: size.height,
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
      console.error('capturepack: saving the editor window mode failed:', errorMessage(err))
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
  editor.on('closed', () => {
    ipcMain.removeListener(IPC.editorSetWindowMode, onSetWindowMode)
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

/** snapshot_t_ms on the trimmed clock; a frame outside the kept range has no
 * position in the saved replay, so it degrades to null (the capture instant). */
function rebaseSnapshotTMsForTrim(snapshotTMs: number | null, trim: TrimRange): number | null {
  if (snapshotTMs === null) return null
  if (snapshotTMs < trim.startMs || snapshotTMs > trim.endMs) return null
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
 * `promise` if it settles by `deadlineAtMs` (an absolute Date.now() instant),
 * otherwise null. The promise itself is never abandoned — its own work still
 * completes, this only stops the CALLER from waiting on it.
 */
function withDeadline<T>(promise: Promise<T>, deadlineAtMs: number): Promise<T | null> {
  const remaining = deadlineAtMs - Date.now()
  if (remaining <= 0) return Promise.resolve(null)
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), remaining)
    void promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
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
