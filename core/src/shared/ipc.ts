// IPC contract between main, the hidden capture window, and the editor window.
// Every channel is listed here; no module may invent channels outside this file.

import type { Annotation } from './types'

export const IPC = {
  // main -> capture window: begin recording this desktop source id
  captureStart: 'capture:start',
  // main -> capture window: deliver the replay blob for an export in progress
  captureRequestReplay: 'capture:request-replay',
  // capture window -> main: replay bytes (webm) + duration for the pending export
  captureReplayResult: 'capture:replay-result',
  // capture window -> main: recorder failed; capture continues screenshot-only
  captureError: 'capture:error',

  // main -> editor window: everything the editor needs to open
  editorInit: 'editor:init',
  // editor -> main: user confirmed export
  editorExport: 'editor:export',
  // editor -> main: user cancelled (Esc)
  editorCancel: 'editor:cancel',
  // editor -> main: an annotation was added (EditorAnnotationAddedPayload, for the timeline)
  editorAnnotationAdded: 'editor:annotation-added',

  // main -> tray/editor: updater state changed
  updaterStatus: 'updater:status',
  // renderer -> main: user chose "Restart and update"
  updaterRestart: 'updater:restart',
} as const

export interface CaptureStartPayload {
  sourceId: string
  fps: number
  segmentSeconds: number // recorder rotation interval (replay guarantee = 1x..2x this)
}

export interface CaptureReplayResultPayload {
  requestId: string
  // webm bytes; empty when no replay is available (screenshot-only capture)
  buffer: ArrayBuffer
  durationMs: number
}

export interface EditorInitPayload {
  // PNG bytes of the snapshot at native resolution
  snapshotPng: ArrayBuffer
  width: number
  height: number
  hasReplay: boolean
  replayDurationMs: number
  // webm bytes of the replay for scrubbing; null when screenshot-only
  replayWebm: ArrayBuffer | null
  fps: number
  scrubInvert: boolean
  scrubSensitivityMs: number
  // Default lifetime duration (ms) stamped on committed manual annotations
  defaultManualDurationMs: number
  // Show the duration chip on the selected annotation
  showDurationLabel: boolean
}

export interface EditorAnnotationAddedPayload {
  // id/type of the new annotation, matching its entry in annotations.json so
  // core.annotation.added timeline events can be correlated (SPEC §10.2)
  id: string
  type: string
}

export interface EditorExportPayload {
  annotations: Annotation[]
  // Snapshot with blur destructively applied (equals original when no blur used)
  snapshotPng: ArrayBuffer
  title: string
  note: string
  includeReplay: boolean
  // Replay position (ms) of the exported frame; null = the capture instant ("now")
  snapshotTMs: number | null
}

export interface UpdaterStatusPayload {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'
  version?: string
  message?: string
}
