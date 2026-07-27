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
  // editor -> main: user cancelled (Esc). In edit mode this is Discard: close
  // without writing anything.
  editorCancel: 'editor:cancel',
  // editor -> main (edit mode only): Save As New CapturePack — same payload as
  // editor:export, but written to a NEW folder with a NEW manifest id while the
  // original pack stays untouched.
  editorSaveAsNew: 'editor:save-as-new',
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

  // history window -> main (invoke): list every pack with card metadata
  historyList: 'history:list',
  // history window -> main (invoke): snapshot thumbnail as a data URL (main-side
  // nativeImage resize to 320px width — the renderer never touches file://)
  historyThumb: 'history:thumb',
  // history window -> main (invoke): total pack size in bytes (computed async)
  historySize: 'history:size',
  // history window -> main (invoke): lazily loaded searchable text for one pack
  // (report.md + note + annotation texts), cached main-side until the pack changes
  historySearchText: 'history:search-text',
  // history window -> main: open the pack for re-editing (session.startEditFlow)
  historyOpenPack: 'history:open-pack',
  // history window -> main (invoke): open replay_annotated.webm in the system player
  historyPlay: 'history:play',
  // history window -> main (invoke): create the sibling {folder}.capturepack zip
  historyCreateZip: 'history:create-zip',
  // history window -> main: open the pack folder in the file manager
  historyOpenFolder: 'history:open-folder',
  // history window -> main: copy the absolute pack folder path to the clipboard
  historyCopyPath: 'history:copy-path',
  // history window -> main: copy the analyze-this-pack prompt (same text as the
  // save toast) to the clipboard
  historyCopyPrompt: 'history:copy-prompt',
  // history window -> main (invoke): re-run the background annotated-replay render
  historyRerender: 'history:rerender',
  // history window -> main (invoke): rename the pack folder AND its zip twin
  historyRename: 'history:rename',
  // history window -> main (invoke): move the pack folder + zip twin to the trash
  historyDelete: 'history:delete',
  // main -> history window: the pack index changed on disk — re-list
  historyChanged: 'history:changed',
  // main -> history window: an annotated-replay render for a pack started or
  // finished — pushed for EVERY render (save-time and History re-render)
  historyRenderStatus: 'history:render-status',
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
  // Existing boxes to restore (GOAL "History — Open & re-edit"). Empty for a
  // fresh capture. The editor adopts them as its undo baseline and registers
  // their ids so new ann_ ids can never collide with loaded ones.
  annotations: Annotation[]
  // manifest title/note to prefill the top-bar inputs ('' for a fresh capture)
  title: string
  note: string
  // True when re-editing a saved pack from History: the trim handles are
  // hidden (replay.webm is never touched on re-edit), dirty tracking shows
  // the "Unsaved changes" chip, and Esc when dirty offers
  // [Save] [Save As New CapturePack] [Discard] instead of closing.
  editMode: boolean
  // Resolved UI language (shared/i18n Language) the editor renders its
  // chrome in. Fixed for the session — the editor window is transient.
  uiLanguage: string
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
  // Replay position (ms) of the exported frame; null = the capture instant ("now")
  snapshotTMs: number | null
  // Replay trim range (GOAL "Replay Trim") on the replay clock. null on a
  // side = that side is untrimmed (start = 0 / end = the replay end); both
  // null = full range, no trim. FRESH capture flow only: in editMode the trim
  // handles are hidden and the payload is always null/null — a saved pack's
  // replay is already the original evidence and is never trimmed further.
  trimStartMs: number | null
  trimEndMs: number | null
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
  // manifest replay_duration_ms of the SOURCE video — the lifetime clock cap
  durationMs: number
  // Plain-trim render mode (GOAL "Replay Trim"): when set, only the
  // [trimStartMs, trimEndMs] range of the source video is played and recorded
  // (absent = 0 / the video end). The SAME pipeline serves both jobs: the
  // annotated render (no trim fields, overlays drawn) and the plain trim that
  // produces the trimmed replay.webm (trim range + an EMPTY annotation set).
  trimStartMs?: number
  trimEndMs?: number
}

export interface RenderResultPayload {
  ok: boolean
  // webm bytes of replay_annotated when ok
  webm?: ArrayBuffer
  error?: string
}

// 'trimming' = the plain-trim render is producing the trimmed replay bytes
// (GOAL "Replay Trim") — it precedes 'rendering' (the annotated render) when
// the save carries an active trim.
export type ToastRenderState = 'none' | 'trimming' | 'rendering' | 'done' | 'failed'

export interface ToastInitPayload {
  folderName: string
  folderPath: string
  // Any blur box in the pack: show the unredacted-original warning line
  hasBlur: boolean
  renderState: ToastRenderState
  // Resolved UI language (shared/i18n Language) for the toast strings.
  uiLanguage: string
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
  // Resolved UI language right now (settings.language with "system" resolved).
  uiLanguage: string
  // What "system" resolves to on this machine — lets the renderer re-resolve
  // the language locally the moment the dropdown changes (instant apply).
  systemLanguage: string
}

export interface SettingsSetResult {
  // The full settings after the patch was validated and applied — the GUI
  // resyncs from this so a rejected value visibly snaps back.
  settings: Settings
  // The patch changed captureHotkey but the OS refused to register it (another
  // app owns the combination): `settings` carries the REVERTED value, the old
  // accelerator still works, and the GUI shows its inline conflict error.
  hotkeyFailed?: boolean
}

// ---------------------------------------------------------------------------
// History window

// Annotated-replay presence for a listed pack: 'ready' = the file exists,
// 'none' = the pack has no replay (nothing to render), 'missing' = replay
// present but replay_annotated.webm absent (background render pending or
// failed) — the card shows [Retry Render].
export type HistoryAnnotatedState = 'ready' | 'none' | 'missing'

export interface HistoryPackSummary {
  // manifest id when readable, else the index id (relative folder/zip stem)
  id: string
  // Absolute path of the pack folder ('dir') or .capturepack file ('zip').
  // This is the ref every history:* action channel takes.
  path: string
  kind: 'dir' | 'zip'
  // Folder/file basename, e.g. "CapturePack_2026-07-27_120000"
  name: string
  title: string | null
  capturedAt: string | null
  app: string | null
  hasReplay: boolean
  replayDurationMs: number | null
  annotationCount: number
  numberedCount: number
  hasBlur: boolean
  annotated: HistoryAnnotatedState
  // A sibling {folder}.capturepack exists (always true for kind 'zip')
  zipTwin: boolean
  // Unreadable/malformed pack: the card renders degraded with this message
  warning: string | null
}

export interface HistoryListResult {
  outputDir: string
  // Newest-first, same order as the MCP pack index
  packs: HistoryPackSummary[]
  // Resolved UI language; the window re-applies it on every re-list, which is
  // how a language change reaches an already-open History window.
  uiLanguage: string
  // Current capture accelerator, for the "press {hotkey} to capture" empty
  // state. Travels with the list for the same reason uiLanguage does.
  captureHotkey: string
}

export interface HistoryActionResult {
  ok: boolean
  error?: string
}

export interface HistoryRenameResult {
  ok: boolean
  // New absolute pack path after a successful rename
  path?: string
  error?: string
}

export interface HistoryRenderStatusPayload {
  // The pack path the render was started for (its path at start time —
  // a concurrent rename orphans the status, which the re-list then corrects)
  path: string
  // 'rendering' marks a render start (save-time renders included) so the card
  // shows "Rendering…" instead of an enabled [Retry Render] while in flight
  state: 'rendering' | 'done' | 'failed'
}
