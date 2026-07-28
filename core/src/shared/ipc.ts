// IPC contract between main, the hidden capture window, and the editor window.
// Every channel is listed here; no module may invent channels outside this file.

import type { Annotation, EditorWindowMode, Settings, UiaTreeStatus } from './types'

export const IPC = {
  // main -> capture window: begin recording this desktop source id
  captureStart: 'capture:start',
  // main -> capture window: deliver the replay blob for an export in progress
  captureRequestReplay: 'capture:request-replay',
  // capture window -> main: replay bytes (webm) + duration for the pending export
  captureReplayResult: 'capture:replay-result',
  // capture window -> main: selected recorder format + negotiated stream size
  captureReady: 'capture:ready',
  // capture window -> main: PROOF that video is actually flowing (see
  // CaptureFramesPayload). Only this makes a display count as recording.
  captureFrames: 'capture:frames',
  // capture window -> main: recorder failed; capture continues screenshot-only
  captureError: 'capture:error',

  // main -> editor window: everything the editor needs to open
  editorInit: 'editor:init',
  // main -> editor window: the capture-instant object dump, LATE (GOAL "Static
  // object picking"). Payload: EditorUiaObjectsPayload.
  //
  // Object data is the one part of the editor that is allowed to arrive after
  // the window does: the dump is budgeted and killed independently, so on a
  // slow machine it can settle a few hundred ms after the editor is on screen.
  // Before this channel existed the editor simply opened with an empty index
  // and picking was dead for the whole session — a settled payload thrown away
  // because a stopwatch started at the capture trigger had run out. The editor
  // MUST accept this message at any time after editor:init and rebuild its
  // object index from it; `dropped` says the dump produced nothing and none is
  // coming, so it can say so once instead of failing silently.
  editorUiaObjects: 'editor:uia-objects',
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
  // editor -> main: put the editor window into this mode (GOAL "Editor Window
  // Mode"). Payload: EditorWindowMode — an ABSOLUTE target, never a toggle, so
  // the window state can never end up inverted against the renderer's.
  editorSetWindowMode: 'editor:set-window-mode',
  // main -> editor: the mode the window is ACTUALLY in, pushed once a switch
  // has settled (and after any other fullscreen change). Main owns the truth;
  // the renderer only paints what it is told.
  editorWindowMode: 'editor:window-mode',
  // editor -> main: remember whether the shortcut sheet is showing (GOAL
  // "Editor Chrome" — settings.showShortcutOverlay). Payload: boolean, the
  // ABSOLUTE new state. Fire-and-forget: the panel is chrome, so a failed disk
  // write costs the preference, never the capture.
  editorSetShortcutOverlay: 'editor:set-shortcut-overlay',

  // about window -> main (invoke): version, icon, language, updater state
  aboutGet: 'about:get',
  // main -> about window: fresh about state (the updater state changed, or the
  // UI language did while the window is open)
  aboutState: 'about:state',
  // about window -> main: open one of the hardcoded links. The renderer sends an
  // AboutLinkKey, never a URL — main maps it through its own allowlist.
  aboutOpenLink: 'about:open-link',
  // about window -> main: user chose "Restart and update"
  updaterRestart: 'updater:restart',
  // about window -> main: "Show welcome again" — re-opens the first-launch
  // welcome window (GOAL "Welcome (first launch after install)")
  aboutShowWelcome: 'about:show-welcome',

  // welcome window -> main (invoke): live hotkey, output folder, replay
  // length, MCP endpoint, language — everything the window prints
  welcomeGet: 'welcome:get',
  // welcome window -> main: [Try it now] — close the window, then fire a
  // capture through the SAME entry point the global hotkey triggers
  welcomeTryNow: 'welcome:try-now',
  // welcome window -> main: [Settings] — open the settings GUI
  welcomeOpenSettings: 'welcome:open-settings',

  // settings window -> main (invoke): current settings + display list + app info
  settingsGet: 'settings:get',
  // settings window -> main (invoke): partial update, validated per-key main-side;
  // returns the settings actually applied (invalid values are rejected, not written)
  settingsSet: 'settings:set',
  // settings window -> main (invoke): directory picker; resolves the chosen path or null
  settingsPickOutputDir: 'settings:pick-output-dir',
  // settings window -> main (invoke): open the output folder in the file manager
  settingsOpenOutput: 'settings:open-output',
  // settings window -> main (invoke): LIVE state of the things settings only
  // *requests* (issues #54, #57) — the MCP server as it is actually running, and
  // what the Windows UI Automation plugin actually did on the last capture.
  // Re-read after every patch and whenever the window regains focus, because
  // both change behind the window's back (a capture happens, a port frees up).
  settingsStatus: 'settings:status',
  // settings window -> main (invoke): stop and restart the MCP server IN PLACE
  // with the current settings (issue #54), then report the outcome. Nothing else
  // is touched: the capture buffer, the hotkey and any open editor keep running.
  settingsMcpRestart: 'settings:mcp-restart',

  // main -> hidden render window: render replay_annotated.webm from this job
  renderStart: 'render:start',
  // render window -> main: ONE annotated keyframe still, sent the moment it
  // finishes encoding (SPEC §7.3). Streamed rather than batched into the
  // result: up to MAX_KEYFRAMES full-resolution PNGs are 100-200 MB on a 4K
  // capture, and holding them all for the length of a real-time render — then
  // structured-cloning them in one message — is a spike in two processes at
  // once (and the classic way to lose a renderer with no error surfaced).
  renderFrame: 'render:frame',
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

/**
 * Why a display's replay buffer is not running (GOAL "Say that you are
 * recording"). Shared by the tray tooltip/balloon, the editor and the save
 * toast, so a failure is worded the same wherever the user meets it.
 *
 * 'no-frames' is the #39 case: the recorder STARTED and reports state
 * "recording", but the desktop capturer delivers nothing (on Windows a failing
 * Desktop Duplication), so the buffer is empty. It is distinct from
 * 'did-not-start', which means the recorder never answered at all.
 *
 * The last two belong to a recorder that is PROVABLY STILL RECORDING and simply
 * had no replay to give for THIS capture. They exist so that case can never be
 * worded as a dead recorder while the tray says "recording · last 30s ready":
 *  - 'replay-timeout'    — the request did not come back in time.
 *  - 'buffer-too-short'  — it came back with less than a decodable video (a slot
 *    that just started or just rotated; on MP4 its payload is still entirely
 *    inside the muxer).
 */
export type RecorderFailureReason =
  | 'screen-unavailable'
  | 'recorder-unavailable'
  | 'stream-ended'
  | 'process-stopped'
  | 'did-not-start'
  | 'no-frames'
  | 'replay-timeout'
  | 'buffer-too-short'

export interface CaptureStartPayload {
  // Electron display id (as a string) this recorder window is assigned to.
  // Routing happens in the main process (display-media handler keyed by the
  // requesting webContents); the renderer carries this for diagnostics only.
  displayId: string
  fps: number
  segmentSeconds: number // recorder rotation interval (replay guarantee = 1x..2x this)
  // Longest edge of the recorded stream; 0 = native. Snapshot capture is a
  // separate main-process path and stays at native resolution.
  replayMaxWidth: number
  // Aspect-preserving target dimensions computed from the assigned display.
  // Both are 0 when replayMaxWidth is 0 (native).
  replayWidth: number
  replayHeight: number
  // TEST PATH for the frame-evidence machinery (--simulate-no-frames, issue
  // #39): the recorder starts for real, but every chunk it produces is dropped
  // and the track's frame count is read as 0 — exactly what a machine with a
  // broken Windows Desktop Duplication looks like from in here. Absent in every
  // normal run.
  simulateNoFrames?: boolean
}

export interface CaptureReadyPayload {
  displayId: string
  mimeType: string
  replayFile: 'replay.webm' | 'replay.mp4'
  width: number
  height: number
}

/**
 * Frame evidence from one recorder window (GOAL "Say that you are recording",
 * issue #39). MediaRecorder.start() succeeding proves NOTHING: with Desktop
 * Duplication failing the recorder sits in state "recording" over an empty
 * buffer, and the tray used to claim "recording · last 30s ready" all the same.
 *
 * The renderer sends this the FIRST time it can prove video is flowing —
 * non-trivial recorder output, or a growing delivered-frame count on the video
 * track — and main only then lets that display count as recording.
 */
export interface CaptureFramesPayload {
  displayId: string
  // Recorder bytes behind this proof; a header-only blob is not evidence.
  bytes: number
  // MediaStreamTrack delivered-frame count, or 0 where the API is unavailable.
  frames: number
}

export interface CaptureReplayResultPayload {
  requestId: string
  // Recorder bytes; empty when no replay is available (screenshot-only capture).
  buffer: ArrayBuffer
  durationMs: number
  mimeType: string
  replayFile: 'replay.webm' | 'replay.mp4'
}

// One frozen display on the editor's BOARD (GOAL "Multi-Monitor Support"):
// every captured display is drawn at once, in its real arrangement, and every
// one of them is annotatable. The focused display is only special in that its
// media IS the pack's top-level media and that a box drawn on it writes no
// `display` field.
export interface EditorDisplayPayload {
  // 1-based manifest display index (manifest.media.displays[].index)
  index: number
  focused: boolean
  // PNG bytes of that display's frozen frame, at its native resolution.
  // NULL on the FOCUSED entry: those exact bytes are already
  // EditorInitPayload.snapshotPng, and the editor draws the focused display
  // from the live base frame — a second copy would only add megabytes to the
  // editor-open message and to the renderer's retained memory.
  snapshotPng: ArrayBuffer | null
  // Native snapshot pixel size — the annotation coordinate space of boxes that
  // carry this display's index.
  width: number
  height: number
  // This display's rectangle in the OS virtual-desktop space, in
  // device-independent pixels (manifest.media.displays[].bounds). THIS is what
  // lays the board out in the real arrangement: the offsets place the screens
  // relative to each other, and a 1x screen next to a 1.5x one keeps its true
  // physical proportion (which native pixel counts would not).
  bounds: { x: number; y: number; width: number; height: number }
  scale: number
  // This display's OWN replay bytes, so the board's one clock can seek every
  // screen together. NULL on the focused entry (its bytes are
  // EditorInitPayload.replayWebm) and on a display that recorded nothing —
  // the latter shows its frozen snapshot and is labelled as such.
  replayWebm: ArrayBuffer | null
  // MIME type of replayWebm. null wherever replayWebm is null.
  replayMimeType: string | null
  // WHY this display has no replay, when it has none (GOAL "Say that you are
  // recording"): a capture taken while a display's buffer was not running must
  // say so on that display instead of quietly handing back a frozen frame.
  // null = the replay is present, or this is a re-edited pack (where a missing
  // replay is a property of the pack, not a live recorder failure).
  replayUnavailableReason: RecorderFailureReason | null
  replayDurationMs: number
  // Milliseconds to ADD to the pack clock (the focused display's replay clock,
  // which every annotation lifetime uses) to reach THIS display's own replay
  // clock. 0 on the focused display. Every recorder is stopped by the same
  // trigger, so the replays are END-aligned and the offset is simply
  // thisDuration - focusedDuration (SPEC §5.6). A trimmed focused replay needs
  // no separate rule: its declared duration is already the trimmed one, so the
  // same difference equals trim_offset_ms plus the difference of the untrimmed
  // lengths.
  replayOffsetMs: number
}

/**
 * One pickable CONTROL in the editor (GOAL "Static object picking (v0)"):
 * a Windows UI Automation element from the CAPTURE-INSTANT dump that also
 * became plugins/windows-uia/elements.json. `bounds` is already in snapshot
 * pixels — the annotation coordinate space (SPEC §8.2) — so a pick snaps a box
 * straight onto it. Fields are raw app data, never translated; an element that
 * had no value for one carries ''.
 */
export interface EditorUiaElement {
  name: string
  control_type: string
  automation_id: string
  class_name: string
  bounds: { x: number; y: number; width: number; height: number }
  // WHICH display's snapshot space `bounds` is in: the 1-based board/manifest
  // display index (GOAL "Multi-Monitor Support"). ALWAYS resolved — a payload
  // that names no display (a pack written before the dump was mapped
  // per-display) reports the focused display here, which is the only space it
  // was ever mapped into. The editor builds ONE object index per display and
  // must only ever feed an entry to the index of THIS display.
  display: number
  // `z` of the window this control was walked from — which window covers a
  // pixel decides which controls may be offered there. -1 when the dump did
  // not say (a pack written before the dump covered more than one window).
  window: number
}

/**
 * One pickable WINDOW in the editor — the GUARANTEED FLOOR of object picking
 * (GOAL: "windows are always selectable"). Every visible top-level window is
 * here, including the ones that expose no control tree at all (Chromium and
 * Electron windows typically do not), so hovering always highlights something
 * and clicking always snaps a box.
 */
export interface EditorUiaWindow {
  title: string
  process: string
  class_name: string
  bounds: { x: number; y: number; width: number; height: number }
  // The display `bounds` is in — see EditorUiaElement.display. A window is
  // reported on the display it mostly covers; a window straddling two screens
  // keeps ONE space (its controls have to stay with it) and simply reaches off
  // the edge of that display's snapshot.
  display: number
  focused: boolean
  // Z-order at the capture instant: 0 is the top-most window. Decides which
  // window owns a pixel when several overlap.
  z: number
  // Whether the dump actually collected controls inside this window. false =
  // "no object data for this window" — never "this window has no objects".
  hasControls: boolean
  // How much of this window's control tree the dump ended up with (SPEC §11.3).
  // Carried through UNCHANGED so the editor can honour "Silence is not
  // absence": a window whose tree is "skipped"/"unavailable" recorded NO data,
  // which is a different statement from a collected tree that simply holds
  // nothing pickable — and hasControls alone conflates the two.
  tree: UiaTreeStatus
}

export interface EditorInitPayload {
  // PNG bytes of the snapshot at native resolution
  snapshotPng: ArrayBuffer
  width: number
  height: number
  hasReplay: boolean
  replayDurationMs: number
  // Position on the RAW recorder file that logical editor time 0 maps to.
  // Fresh captures use this to expose only the last configured N seconds while
  // the exact cut runs later in the background; saved packs use 0.
  replaySourceStartMs: number
  // Every display this capture froze, focused included — EMPTY when only one
  // display was captured, in which case the editor builds a one-display board
  // from width/height above and behaves exactly as a single-monitor editor
  // always did. The focused display's snapshot is the same frame as
  // snapshotPng above.
  displays: EditorDisplayPayload[]
  // webm bytes of the replay for scrubbing; null when screenshot-only
  replayWebm: ArrayBuffer | null
  // Actual MIME type of replayWebm (MP4/AVC or WebM VP8/VP9).
  replayMimeType: string | null
  // WHY the FOCUSED display has no replay (GOAL "Say that you are recording").
  // Set only on a fresh capture whose recorder was not running: the editor then
  // names the reason instead of showing a bare "No replay", so a screenshot-only
  // pack can never be mistaken for a normal one. null whenever there IS a
  // replay, and on every re-edited pack.
  replayUnavailableReason: RecorderFailureReason | null
  // Pickable UI objects from the capture instant (GOAL "Static object
  // picking"). BOTH lists are EMPTY whenever there is no object data — no
  // Windows UI Automation dump, a dump that timed out, or a re-edited pack
  // without plugins/windows-uia — and the editor then behaves exactly as it
  // did before the feature existed. Controls refine; windows are the floor,
  // so uiaWindows is routinely non-empty while uiaElements is not.
  //
  // EMPTY IS NOT FINAL on a fresh capture: when the dump has not settled by the
  // time the editor is ready, these open empty and the real lists arrive on
  // IPC.editorUiaObjects moments later (see uiaDropped below).
  uiaElements: EditorUiaElement[]
  uiaWindows: EditorUiaWindow[]
  // The object dump was attempted and produced NOTHING usable, so picking is
  // off for this session and no editor:uia-objects message is coming (GOAL:
  // "Silence is not absence" — the editor says so once instead of looking
  // broken). FALSE both when objects are present AND when they are still on
  // their way; it is never true for a pack that simply never had object data
  // (a non-Windows capture, or a re-edited pack without the plugin), because
  // nothing was dropped there.
  uiaDropped: boolean
  fps: number
  scrubInvert: boolean
  scrubSensitivityMs: number
  // Default lifetime duration (ms) stamped on committed manual annotations
  defaultManualDurationMs: number
  // Show the duration chip on the selected annotation
  showDurationLabel: boolean
  // Whether the shortcut sheet opens with the editor (GOAL "Editor Chrome":
  // on by default, and the `?`/F1 toggle is remembered) — the persisted
  // settings.showShortcutOverlay.
  showShortcutOverlay: boolean
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
  // The mode the window OPENED in (GOAL "Editor Window Mode") — the persisted
  // settings.editorWindowMode. The renderer paints its top-bar drag region and
  // the ⧉ button from this, then follows the editorWindowMode pushes.
  windowMode: EditorWindowMode
}

/**
 * IPC.editorUiaObjects — the object dump, delivered after the editor opened.
 *
 * The editor treats this as a REPLACEMENT for the (empty) lists it opened with:
 * it rebuilds its per-display object indexes and picking starts working
 * mid-session, with no other state touched. Annotations already drawn are
 * unaffected — this only ever adds what can be picked.
 *
 * Preload bridge: expose it as `onUiaObjects(cb)` beside `onInit(cb)`.
 */
export interface EditorUiaObjectsPayload {
  uiaElements: EditorUiaElement[]
  uiaWindows: EditorUiaWindow[]
  // Same meaning as EditorInitPayload.uiaDropped: the dump settled with nothing
  // usable. Both lists are then empty and this is the LAST word on picking for
  // the session.
  dropped: boolean
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
  // null = STILL job (SPEC §7.3): nothing is played or recorded — the single
  // annotated keyframe of a screenshot-only pack is drawn from snapshotPng.
  replayWebm: ArrayBuffer | null
  // Actual MIME type of replayWebm. Required for MP4/AVC input; ignored by a
  // still job where replayWebm is null.
  replayMimeType?: string
  // Still job only: the frame the keyframe is drawn from (snapshot.png bytes).
  snapshotPng?: ArrayBuffer
  annotations: Annotation[]
  // GLOBAL display numbers (SPEC §8.5) as annotation_id -> number pairs,
  // computed ONCE per save over the pack's WHOLE annotation set and shipped in
  // rather than derived here.
  //
  // `annotations` above is a SUBSET on every multi-display job — a display's
  // rendering may only ever carry its own boxes (SPEC §5.6) — so recomputing
  // the numbering from it would renumber from 1 inside each view and make the
  // badges in replay_annotated disagree with report.md, the editor and MCP,
  // which all number globally. Absent = single-display job: the subset IS the
  // whole set and the renderer computes it itself.
  displayNumbers?: Array<[string, number]>
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
  // Also capture annotated keyframe stills (GOAL "Annotated keyframes",
  // SPEC §7.3): the SAME render pass hands back a PNG of the canvas at every
  // annotation state change. Absent/false on the plain-trim job, which renders
  // no overlays and produces no stills.
  keyframes?: boolean
}

/** One annotated still handed back by the render window (SPEC §7.3). */
export interface RenderFramePayload {
  // Replay-clock position (ms) the still was captured at
  t_ms: number
  // PNG bytes of the composited canvas at that instant
  png: ArrayBuffer
}

export interface RenderResultPayload {
  ok: boolean
  // webm bytes of replay_annotated when ok; absent on a still job
  webm?: ArrayBuffer
  // How many stills this job SENT over IPC.renderFrame (the bytes themselves
  // never travel in this message). A still that failed to encode is dropped and
  // not counted, and is never fatal to the render.
  frameCount?: number
  error?: string
}

// 'trimming' = the plain-trim render is producing the trimmed replay bytes
// (GOAL "Replay Trim") — it precedes 'rendering' (the annotated render) when
// the save carries an active trim.
export type ToastRenderState = 'none' | 'trimming' | 'rendering' | 'done' | 'failed'

/**
 * A saved pack that is (partly) screenshot-only because a display's replay
 * buffer was not running at the trigger (GOAL "Say that you are recording",
 * issue #39). The save toast states it; null means every captured display
 * delivered its replay.
 */
export interface ReplayUnavailablePayload {
  // The recorder's own reason, worded exactly as the tray words it.
  reason: RecorderFailureReason
  // Captured displays with no replay, and how many were captured in total.
  screens: number
  total: number
  // The FOCUSED display is one of them — i.e. the pack itself has no replay.
  focused: boolean
}

export interface ToastInitPayload {
  folderName: string
  folderPath: string
  // Any blur box in the pack: show the unredacted-original warning line
  hasBlur: boolean
  // A display was not recording at the trigger: the toast says the replay is
  // unavailable rather than letting the user discover it in the folder.
  replayUnavailable: ReplayUnavailablePayload | null
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

// Updater state as the tray label and the About window render it.
// 'up-to-date' is the transient answer to a finished check ("You're up to
// date"), which the updater itself reverts to 'idle' after a few seconds;
// 'dev' is an unpackaged run, where electron-updater is never touched.
export interface UpdaterStatusPayload {
  state:
    | 'idle'
    | 'checking'
    | 'up-to-date'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'error'
    | 'dev'
  version?: string
  message?: string
}

// ---------------------------------------------------------------------------
// About window

/** The links the About window may ask main to open. Never a URL: main owns the
 * hardcoded allowlist, so a compromised renderer cannot open arbitrary pages. */
export type AboutLinkKey = 'website' | 'github' | 'issues' | 'sponsor'

export interface AboutInfoResult {
  // app.getVersion() — the running version, shown as "Version {version}"
  version: string
  // dist/assets/icon.png as a data: URL (CSP img-src 'self' data:); '' when the
  // icon could not be read, and the renderer then shows no image at all
  iconDataUrl: string
  // Resolved UI language (shared/i18n Language) for the window's strings
  uiLanguage: string
  updater: UpdaterStatusPayload
  // Version of an already-downloaded update waiting for a restart, else null.
  // STICKY across later checks (which momentarily report 'checking'/'available'
  // while revalidating the cached file), so the About window's Restart button
  // follows the same rule as the tray's "Restart and update (vX)" item instead
  // of blinking out during every scheduled re-check.
  downloadedVersion: string | null
}

// ---------------------------------------------------------------------------
// Welcome window (GOAL "Welcome (first launch after install)")

/** Everything the welcome window prints — all of it LIVE, none of it hardcoded. */
export interface WelcomeInfoResult {
  // Resolved UI language (shared/i18n Language) for the window's strings
  uiLanguage: string
  // settings.captureHotkey, the accelerator actually configured right now
  // (e.g. "Ctrl+Alt+C") — the window never spells a default of its own
  hotkey: string
  // settings.outputDir — the real folder a saved pack lands in
  outputDir: string
  // settings.replaySeconds — "the last N seconds are already recorded"
  replaySeconds: number
  // Streamable HTTP endpoint of the built-in MCP server, e.g.
  // "http://127.0.0.1:39393/mcp" — the port the RUNNING server bound at boot.
  // EMPTY when MCP is disabled: the window then explains the feature without
  // printing an endpoint nothing is listening on.
  mcpUrl: string
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

// ---------------------------------------------------------------------------
// Live MCP server state (GOAL "Always-On MCP Server", issue #54)
// ---------------------------------------------------------------------------

/**
 * What the MCP server is ACTUALLY doing right now — never what settings ask
 * for. `mcpEnabled` says nothing about whether a socket is listening: the port
 * may be taken (the server logs one line and the app keeps running), autostart
 * may be off, or a changed port may not have been applied yet.
 */
export type McpServerState = 'starting' | 'running' | 'stopped' | 'failed'

/** WHY nothing is listening. null while the server is starting or running. */
export type McpStoppedReason =
  // settings.mcpEnabled is off — the master switch.
  | 'disabled'
  // settings.mcpAutoStart is off and nothing has started it since; the settings
  // window's [Restart] starts it anyway (that button IS the manual start).
  | 'autostart-off'
  // EADDRINUSE: another process owns the configured port.
  | 'port-in-use'
  // Any other socket error; `detail` carries the OS message.
  | 'bind-failed'
  // Stopped deliberately (a restart in flight, or app shutdown).
  | 'stopped'

export interface McpStatus {
  state: McpServerState
  // The endpoint the socket REALLY bound, e.g. "http://127.0.0.1:39393/mcp".
  // '' unless state is 'running' — every surface that advertises the URL (the
  // settings window, the welcome window, the setup snippets) reads it from here
  // so none of them can ever print an endpoint nothing is listening on.
  endpoint: string
  // The port really bound; 0 unless running.
  port: number
  // The port settings ASK for — what a restart would try next. Shown when the
  // configured port is taken, so "port 39393 is already in use" names the port
  // the user typed rather than the (absent) bound one.
  configuredPort: number
  reason: McpStoppedReason | null
  // Raw OS error text for 'bind-failed' (never localized); '' otherwise.
  detail: string
}

// ---------------------------------------------------------------------------
// Windows UI Automation plugin state (GOAL "Static object picking", issue #57)
// ---------------------------------------------------------------------------

/** What the object-picking plugin is doing, from reality — never a constant. */
export type UiaPluginState =
  // Windows, enabled, and the last dump (if any) produced data.
  | 'active'
  // settings.uiaEnabled is off: the helper is not spawned at all.
  | 'off'
  // Not Windows — the helper is a UI Automation client and cannot exist here.
  | 'unsupported'
  // Enabled, but the last capture's dump produced nothing usable (`reason`).
  | 'failing'

/** Why the last dump produced nothing (SPEC §11.3 collection failures). */
export type UiaFailureReason =
  // dist/scripts/uia-dump.ps1 is missing from the install.
  | 'no-helper'
  // powershell.exe could not be started (AppLocker/WDAC, AV, shutdown).
  | 'spawn-failed'
  // Execution policy refused the script; the next capture retries as a command.
  | 'policy'
  // The helper was killed at its budget before printing anything usable.
  | 'budget'
  // It ran and exited, but printed nothing this side could parse.
  | 'no-output'

export interface UiaPluginStatus {
  state: UiaPluginState
  // What the LAST dump of this app session actually collected. null when no
  // capture has run yet — the row then says what the plugin does rather than
  // inventing a count.
  lastWindows: number | null
  lastControls: number | null
  // That dump hit its budget or a cap, so the counts above are a floor.
  lastTruncated: boolean
  // Only set for state 'failing'.
  reason: UiaFailureReason | null
}

/**
 * Everything in the settings window that is LIVE rather than configured
 * (issues #54, #57). Returned by settings:get, re-fetched by settings:status,
 * and returned again by settings:mcp-restart so one code path renders it.
 */
export interface SettingsStatusResult {
  mcp: McpStatus
  // The settings the RUNNING MCP server actually honors — a snapshot taken at
  // its last start attempt, NOT at app startup. The GUI's "press Restart to
  // apply" hints compare against THIS, so a pending change keeps its hint when
  // the window is closed and reopened, and loses it the moment a restart in
  // place has actually applied it (issue #54). It travels WITH the status so a
  // restart's answer carries both halves of the truth at once.
  mcpSettings: Settings
  uia: UiaPluginStatus
}

export interface SettingsGetResult {
  settings: Settings
  displays: SettingsDisplayOption[]
  appVersion: string
  status: SettingsStatusResult
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
