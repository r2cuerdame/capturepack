// Capture flow state machine: snapshot -> replay fetch -> fullscreen editor -> export.
import { app, BrowserWindow, dialog, ipcMain, Notification, screen } from 'electron'
import type { IpcMainEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import { IPC } from '../shared/ipc'
import type { EditorAnnotationAddedPayload, EditorExportPayload, EditorInitPayload } from '../shared/ipc'
import type { Annotation, Settings, TimelineEvent, TimelineFile } from '../shared/types'
import { requestReplay, takeSnapshot } from './capture'
import { exportPack, type ExportInput } from './exporter'

const REPLAY_TIMEOUT_MS = 5_000

type EditorOutcome = { kind: 'export'; payload: EditorExportPayload } | { kind: 'cancel' }

let flowActive = false

export async function startCaptureFlow(captureWindow: BrowserWindow, settings: Settings): Promise<void> {
  if (flowActive) return
  flowActive = true
  try {
    await runFlow(captureWindow, settings)
  } catch (err) {
    dialog.showErrorBox('CapturePack', `Capture failed: ${errorMessage(err)}`)
  } finally {
    flowActive = false
  }
}

async function runFlow(captureWindow: BrowserWindow, settings: Settings): Promise<void> {
  const triggerAt = Date.now()
  const snap = await takeSnapshot()
  // On timeout or recorder failure, replay is null: proceed screenshot-only.
  const replay = await requestReplay(captureWindow, randomUUID(), REPLAY_TIMEOUT_MS)
  const replayDurationMs = replay === null ? 0 : replay.durationMs
  const t0Ms = triggerAt - replayDurationMs

  const events: TimelineEvent[] = [{ t_ms: replayDurationMs, type: 'core.capture.triggered', source: 'core' }]

  const editor = createEditorWindow()
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
  // replay, so drop snapshot_t_ms (SPEC §5.3) and annotation anchors (t_ms)
  // plus lifetime intervals (t_start_ms/t_end_ms) (SPEC §8.3).
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
    outputDir: settings.outputDir,
    copyToClipboard: settings.copyToClipboard,
  }

  try {
    const packPath: string = await exportPack(input)
    new Notification({ title: 'CapturePack saved', body: path.basename(packPath) }).show()
  } catch (err) {
    dialog.showErrorBox('CapturePack export failed', errorMessage(err))
  }
}

function createEditorWindow(): BrowserWindow {
  const { bounds } = screen.getPrimaryDisplay()
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

    const onCancel = (event: IpcMainEvent): void => {
      if (!fromEditor(event)) return
      settle({ kind: 'cancel' })
    }

    const onClosed = (): void => settle({ kind: 'cancel' })

    ipcMain.on(IPC.editorAnnotationAdded, onAnnotation)
    ipcMain.on(IPC.editorExport, onExport)
    ipcMain.on(IPC.editorCancel, onCancel)
    editor.on('closed', onClosed)
  })
}

// Replay-relative positions (the anchor and the lifetime interval) are
// meaningless in a pack without the replay.
function withoutReplayTimes(a: Annotation): Annotation {
  if (a.t_ms === undefined && a.t_start_ms === undefined && a.t_end_ms === undefined) return a
  const copy = { ...a }
  delete copy.t_ms
  delete copy.t_start_ms
  delete copy.t_end_ms
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
