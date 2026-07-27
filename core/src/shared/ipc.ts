// IPC contract between main, the hidden capture window, and the editor window.
// Every channel is listed here; no module may invent channels outside this file.

import type { Annotation, Settings } from './types'

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

  // settings window -> main (invoke): current settings + display list + app info
  settingsGet: 'settings:get',
  // settings window -> main (invoke): partial update, validated per-key main-side;
  // returns the settings actually applied (invalid values are rejected, not written)
  settingsSet: 'settings:set',
  // settings window -> main (invoke): directory picker; resolves the chosen path or null
  settingsPickOutputDir: 'settings:pick-output-dir',
  // settings window -> main (invoke): open the output folder in the file manager
  settingsOpenOutput: 'settings:open-output',

  // main -> hidden render window: render replay_annotated.webm from this job
  renderStart: 'render:start',
  // render window -> main: rendered webm bytes (or failure) for the job
  renderResult: 'render:result',

  // main -> toast window: everything the save-complete toast shows
  toastInit: 'toast:init',
  // main -> toast window: background annotated-replay render state changed
  toastRenderStatus: 'toast:render-status',
  // toast -> main: open the pack folder in the file manager
  toastOpenFolder: 'toast:open-folder',
  // toast -> main: copy the absolute pack folder path to the clipboard
  toastCopyPath: 'toast:copy-path',
  // toast -> main (invoke): create {folder}.capturepack next to the folder
  toastCreateZip: 'toast:create-zip',
  // toast -> main: copy the analyze-this-pack prompt to the clipboard
  toastCopyPrompt: 'toast:copy-prompt',
  // toast -> main: close the toast window (× button / auto-close)
  toastClose: 'toast:close',
} as const

export interface CaptureStartPayload {
  // Electron display id (as a string) this recorder window is assigned to.
  // Routing happens in the main process (display-media handler keyed by the
  // requesting webContents); the renderer carries this for diagnostics only.
  displayId: string
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
  // The exported snapshot frame (native snapshot or the scrubbed replay frame).
  // Blur is NEVER burned in (SPEC §9): blur boxes render only into derived
  // views (replay_annotated.webm, editor previews) — snapshot.png stays original.
  snapshotPng: ArrayBuffer
  title: string
  note: string
  includeReplay: boolean
  // Replay position (ms) of the exported frame; null = the capture instant ("now")
  snapshotTMs: number | null
}

// main -> hidden render window: one annotated-replay render job (SPEC §7.2).
// The renderer plays the original replay into a canvas, draws per-frame
// overlays (blur first, then border, number badge, text — lifetime-gated,
// GLOBAL display numbers, no editor controls), and records the canvas.
export interface RenderStartPayload {
  replayWebm: ArrayBuffer
  annotations: Annotation[]
  // Canvas size = snapshot reference size (annotation coordinate space)
  width: number
  height: number
  fps: number
  // manifest replay_duration_ms — the lifetime clock cap
  durationMs: number
}

export interface RenderResultPayload {
  ok: boolean
  // webm bytes of replay_annotated when ok
  webm?: ArrayBuffer
  error?: string
}

export type ToastRenderState = 'none' | 'rendering' | 'done' | 'failed'

export interface ToastInitPayload {
  folderName: string
  folderPath: string
  // Any blur box in the pack: show the unredacted-original warning line
  hasBlur: boolean
  renderState: ToastRenderState
}

export interface ToastRenderStatusPayload {
  state: ToastRenderState
}

export interface ToastCreateZipResult {
  ok: boolean
  zipPath?: string
  error?: string
}

export interface UpdaterStatusPayload {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'
  version?: string
  message?: string
}

// Partial settings update from the settings GUI. Every value is validated
// main-side with the same per-key rules as settings.json loading; invalid or
// unknown keys are rejected and never written.
export type SettingsPatch = Partial<Settings>

export interface SettingsDisplayOption {
  // String(display.id) — the value stored in settings.captureDisplay
  id: string
  // e.g. "2560×1440 at 0,0 — primary" (physical pixels, matching the snapshot)
  label: string
}

export interface SettingsGetResult {
  settings: Settings
  // Settings as they were at app startup — what the running MCP server, watcher,
  // and updater actually honor. The GUI's "restart to apply" hints compare
  // against THIS (not a window-open snapshot) so a pending change keeps its
  // hint when the window is closed and reopened without a restart.
  bootSettings: Settings
  displays: SettingsDisplayOption[]
  appVersion: string
  // e.g. "http://127.0.0.1:39393/mcp" — the port the RUNNING server listens on
  // (the boot-time mcpPort), not the configured port a pending change would use
  mcpUrl: string
}

export interface SettingsSetResult {
  // The full settings after the patch was validated and applied — the GUI
  // resyncs from this so a rejected value visibly snaps back.
  settings: Settings
}
