// Capture flow state machine: pick target display -> snapshot -> replay fetch
// -> save-first -> fullscreen editor on that display -> in-place pack update on
// Save -> save toast + background annotated-replay render.
//
// Also owns the RE-EDIT flow (GOAL "History — Open & re-edit"): startEditFlow
// loads a saved pack folder back into the SAME editor window and saves through
// the same pipeline — updatePack in keepReplay mode (replay.webm is never
// rewritten) or saveAsNewPack for [Save As New CapturePack].
import { app, BrowserWindow, dialog, ipcMain, nativeImage } from 'electron'
import type { Display, IpcMainEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import { IPC } from '../shared/ipc'
import type { EditorAnnotationAddedPayload, EditorExportPayload, EditorInitPayload } from '../shared/ipc'
import type { Annotation, Manifest, Settings, TimelineEvent, TimelineFile } from '../shared/types'
import { startAnnotatedRender } from './annotatedRender'
import { captureWindowForDisplay, requestReplay, resolveTargetDisplay, takeSnapshot } from './capture'
import {
  savePack,
  saveAsNewPack,
  updatePack,
  isoWithOffset,
  type ExportInput,
  type InitialSaveInput,
  type PackHandle,
} from './exporter'
import { openPack } from './mcp/store'
import { showSaveToast, updateToastRenderStatus } from './saveToast'

const REPLAY_TIMEOUT_MS = 5_000

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
    dialog.showErrorBox('CapturePack', `Capture failed: ${errorMessage(err)}`)
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
    dialog.showErrorBox('CapturePack', `Re-edit failed: ${errorMessage(err)}`)
  } finally {
    flowActive = false
  }
}

async function runFlow(settings: Settings): Promise<void> {
  const triggerAt = Date.now()
  // Cursor mode: the display the mouse is on at trigger time; fixed mode: the
  // configured display. Snapshot, replay, and editor all target THIS display.
  const display = resolveTargetDisplay(settings)
  const snap = await takeSnapshot(display)
  // On timeout, recorder failure, or no recorder window for this display
  // (hotplug rebuild in progress), replay is null: proceed screenshot-only.
  const captureWindow = captureWindowForDisplay(display.id)
  const replay =
    captureWindow === null ? null : await requestReplay(captureWindow, randomUUID(), REPLAY_TIMEOUT_MS)
  const replayDurationMs = replay === null ? 0 : replay.durationMs
  const t0Ms = triggerAt - replayDurationMs

  const events: TimelineEvent[] = [{ t_ms: replayDurationMs, type: 'core.capture.triggered', source: 'core' }]

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
  }
  let handle: PackHandle | null = null
  try {
    handle = await savePack(initialSave)
  } catch (err) {
    console.error('capturepack: save-first failed:', errorMessage(err))
  }

  const editor = createEditorWindow(display)
  editor.once('ready-to-show', () => {
    const init: EditorInitPayload = {
      snapshotPng: toArrayBuffer(snap.png),
      width: snap.width,
      height: snap.height,
      hasReplay: replay !== null,
      replayDurationMs,
      // Replay bytes are already in memory; the editor scrubs its own copy and
      // never re-requests them at export time.
      replayWebm: replay === null ? null : toArrayBuffer(replay.buffer),
      fps: settings.fps,
      scrubInvert: settings.scrubInvert,
      scrubSensitivityMs: settings.scrubSensitivityMs,
      defaultManualDurationMs: settings.defaultManualDurationMs,
      showDurationLabel: settings.showDurationLabel,
      annotations: [],
      title: '',
      note: '',
      editMode: false,
    }
    editor.webContents.send(IPC.editorInit, init)
    editor.show()
  })

  const outcome = await runEditor(editor, events, t0Ms)
  if (outcome.kind === 'cancel') return

  const replayWebm = outcome.payload.includeReplay && replay !== null ? replay.buffer : null

  // The exporter appends the core.export.created event itself.
  // When a recorded replay is excluded from the pack, t0 must not reference a
  // video the reader cannot see (SPEC §10.1): rebase on the trigger instant.
  const timeline: TimelineFile =
    replayWebm === null && replayDurationMs > 0
      ? {
          t0: new Date(triggerAt).toISOString(),
          events: events.map((e) => ({ ...e, t_ms: e.t_ms - replayDurationMs })),
        }
      : { t0: new Date(t0Ms).toISOString(), events }

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
    replayDurationMs: replayWebm === null ? 0 : replayDurationMs,
    annotations,
    title: outcome.payload.title,
    note: outcome.payload.note,
    snapshotTMs,
    timeline,
    copyToClipboard: settings.copyToClipboard,
  }

  try {
    // Save-first failed earlier? Retry the initial write now, then finalize.
    if (handle === null) handle = await savePack(initialSave)
    const dirPath: string = await updatePack(handle, input)
    // Save pipeline (GOAL): update folder -> toast -> background render. The
    // toast never waits for the render; its status line flips when it ends.
    const hasReplay = replayWebm !== null
    showSaveToast({
      folderPath: dirPath,
      hasBlur: annotations.some((a) => a.blur),
      renderState: hasReplay ? 'rendering' : 'none',
    })
    if (replayWebm !== null) {
      startAnnotatedRender(
        handle,
        {
          replayWebm,
          annotations,
          width: snap.width,
          height: snap.height,
          fps: settings.fps,
          replayDurationMs,
        },
        (state) => updateToastRenderStatus(dirPath, state),
      )
    }
  } catch (err) {
    dialog.showErrorBox('CapturePack save failed', errorMessage(err))
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
  // Plugin declarations from the loaded manifest (entry-validated): the
  // current exporter never writes plugins, but an external pack may declare
  // them and a re-edit save regenerates the manifest — the declaration must
  // survive (GOAL "Open & re-edit" restores DOM/UIA metadata).
  const loadedPlugins: Manifest['plugins'] = Array.isArray(manifest.plugins)
    ? manifest.plugins.filter((p) => p !== null && typeof p === 'object')
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
  const editor = createEditorWindow(display)
  editor.once('ready-to-show', () => {
    const init: EditorInitPayload = {
      snapshotPng: toArrayBuffer(snapshotPng),
      width,
      height,
      hasReplay: replayWebm !== null,
      replayDurationMs,
      replayWebm: replayWebm === null ? null : toArrayBuffer(replayWebm),
      fps: settings.fps,
      scrubInvert: settings.scrubInvert,
      scrubSensitivityMs: settings.scrubSensitivityMs,
      defaultManualDurationMs: settings.defaultManualDurationMs,
      showDurationLabel: settings.showDurationLabel,
      annotations: loadedAnnotations,
      title: typeof manifest.title === 'string' ? manifest.title : '',
      note: typeof manifest.note === 'string' ? manifest.note : '',
      editMode: true,
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
    timeline,
    // External packs may declare plugins the current exporter never writes:
    // carry the declaration through a re-edit save (the plugins/ files on disk
    // stay untouched and must not become undeclared).
    plugins: loadedPlugins,
    copyToClipboard: settings.copyToClipboard,
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
    }
  } catch (err) {
    dialog.showErrorBox('CapturePack save failed', errorMessage(err))
  }
}

// The annotation editor always opens fullscreen on the CAPTURED display
// (GOAL "Multi-Monitor Support"), not on the primary.
function createEditorWindow(display: Display): BrowserWindow {
  const { bounds } = display
  const editor = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    fullscreen: true,
    alwaysOnTop: true,
    backgroundColor: '#111',
    show: false,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist', 'preload', 'editor.js'),
    },
  })
  void editor.loadFile(path.join(app.getAppPath(), 'dist', 'renderer', 'editor', 'editor.html'))
  return editor
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

// Replay-relative lifetimes are meaningless in a pack without the replay.
function withoutReplayTimes(a: Annotation): Annotation {
  if (a.start_ms === undefined && a.end_ms === undefined) return a
  const copy = { ...a }
  delete copy.start_ms
  delete copy.end_ms
  return copy
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  const ab = new ArrayBuffer(buf.byteLength)
  new Uint8Array(ab).set(buf)
  return ab
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
