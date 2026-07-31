// IPC contract between main, the hidden capture window, and the editor window.
// Every channel is listed here; no module may invent channels outside this file.

import type { Annotation, EditorWindowMode, Settings, UiaTreeStatus } from './types'
import type { ContextFrame } from './context/protocol'
import type { AuthoredMotionSpace } from './track'
import type { Language } from './i18n'
import type {
  ImageRegionCompositeLayout,
  ImageRegionPoint,
  ImageRegionRect,
  ImageRegionSelectorDisplay,
} from './imageRegion'

export const IPC = {
  // main -> capture window: begin recording this desktop source id
  captureStart: 'capture:start',
  // main -> capture window: deliver the replay blob for an export in progress
  captureRequestReplay: 'capture:request-replay',
  // main -> capture window: the full-native snapshot phase is complete. A held
  // replay boundary must discard every post-request byte and start an empty
  // recorder/ring immediately.
  captureResumeReplay: 'capture:resume-replay',
  // capture window -> main: replay bytes (webm) + duration for the pending export
  captureReplayResult: 'capture:replay-result',
  // capture window -> main: selected recorder format + negotiated stream size
  captureReady: 'capture:ready',
  // capture window -> main: PROOF that video is actually flowing, repeated as a
  // heartbeat (see CaptureFramesPayload). Only this makes a display count as
  // recording, and its repetition is what lets that state self-heal (#43).
  captureFrames: 'capture:frames',
  // capture window -> main: A FRAME WAS JUST CAPTURED, and this is its own time
  // on the recording's clock (#105). Core answers by observing the desk right
  // then and filing the result under that number, so the picture and the window
  // rectangles are the same instant by construction rather than by clock
  // arithmetic. Payload: CaptureTickPayload. Focused display only — one clock.
  captureTick: 'capture:tick',
  // capture window -> main: recorder failed; capture continues screenshot-only
  captureError: 'capture:error',
  // capture window -> main (invoke): one bounded Desktop Duplication timing
  // reference for this sender's assigned display. Available pixels and
  // LastPresentTime come from the same acquired DXGI resource.
  captureDxgiTimingReference: 'capture:dxgi-timing-reference',
  // capture window -> main (invoke): Chromium's display stream explicitly
  // failed or proved empty; start the per-display Windows GDI replay source.
  captureNativeFallbackStart: 'capture:native-fallback-start',
  // main -> capture window: one timestamped JPEG from that native source.
  captureNativeFallbackFrame: 'capture:native-fallback-frame',
  // capture window -> main: the JPEG was decoded/dropped; release at most one
  // pending latest frame. This bounds main-to-renderer IPC under renderer load.
  captureNativeFallbackFrameAck: 'capture:native-fallback-frame-ack',
  // capture window -> main: first CanvasCaptureMediaStreamTrack frame was
  // actually presented. Separate from ACK so a throttled hidden compositor
  // cannot throttle the bounded GDI producer itself.
  captureNativeFallbackFramePresented:
    'capture:native-fallback-frame-presented',
  // main -> capture window: the native source exited unexpectedly.
  captureNativeFallbackError: 'capture:native-fallback-error',
  // capture window -> main: this generation no longer owns the native source.
  captureNativeFallbackStop: 'capture:native-fallback-stop',

  // Image capture opens one overlay per frozen display AFTER main has already
  // taken the screenshots. These channels carry geometry only: there is no
  // image byte/path field through which the selector could persist an
  // unrequested full-desktop context image.
  imageRegionInit: 'image-region:init',
  imageRegionFocus: 'image-region:focus',
  imageRegionReady: 'image-region:ready',
  imageRegionDrag: 'image-region:drag',
  imageRegionPreview: 'image-region:preview',
  imageRegionCommit: 'image-region:commit',
  imageRegionCancel: 'image-region:cancel',

  // main -> editor window: everything the editor needs to open
  editorInit: 'editor:init',
  // editor -> main: the bootstrap payload decoded and the first annotation
  // frame reached a paint boundary. Main does not reveal the window before it.
  editorInitialized: 'editor:initialized',
  // editor -> main: bootstrap/decode failed. Main logs and closes the still
  // hidden editor instead of showing an unrecoverable dark shell.
  editorInitFailed: 'editor:init-failed',
  // main -> editor: the native caption Close button was pressed. The renderer
  // owns dirty state, so it either confirms unsaved edits or answers with
  // editorCancel; main keeps the window alive until one of those answers.
  editorCloseRequested: 'editor:close-requested',
  // editor -> main: the unsaved-changes modal is visibly handling the native
  // Close request. Clears only the renderer-response watchdog; Save, Discard,
  // Cancel/Esc remain renderer-owned decisions.
  editorClosePromptShown: 'editor:close-prompt-shown',
  // editor -> main (invoke): the candidate set at ONE time (#66, design GAP 7).
  // Payload: ContextFrameRequest; resolves to ContextFrame, or null when the
  // session is gone. Asked whenever the SCRUB SETTLES on a new position — never
  // per pointer move, which is why hovering still costs nothing per frame.
  contextRequestFrame: 'context:request-frame',
  // editor -> main: where ONE object was, for as long as it was there (#86).
  // Asked once when a box is picked, not per frame: the answer is a path the
  // renderer interpolates over, so following costs nothing while scrubbing.
  contextRequestTrack: 'context:request-track',
  // main -> editor window: a REPLACEMENT frame, pushed rather than requested.
  //
  // Two things produce one: a provider that answered after its budget expired
  // (GOAL: "late candidates update the list asynchronously rather than delaying
  // the first paint"), and the capture-instant observation settling after the
  // editor opened — the helper is budgeted and killed independently of the
  // window, so on a slow machine it lands a few hundred ms late. Before this
  // existed the editor opened with an empty index and picking was dead for the
  // whole session. The editor MUST accept this at any time after editor:init.
  contextFrame: 'context:frame',
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
  // editor -> main: remember whether the first-run tutorial should ever appear
  // again (GOAL "First-Run Tutorial" — settings.showEditorTutorial). Payload:
  // boolean, the ABSOLUTE new state. Fire-and-forget for the same reason as
  // the shortcut sheet: a failed disk write costs a preference, not a capture.
  editorSetTutorial: 'editor:set-tutorial',

  // about window -> main (invoke): version, icon, language, updater state
  aboutGet: 'about:get',
  // main -> about window: fresh about state (the updater state changed, or the
  // UI language did while the window is open)
  aboutState: 'about:state',
  // about window -> main: open one of the hardcoded links. The renderer sends an
  // AboutLinkKey, never a URL — main maps it through its own allowlist.
  aboutOpenLink: 'about:open-link',
  // about window -> main: open CapturePack's own log directory. No path crosses
  // the bridge; main resolves the fixed userData/logs location itself.
  aboutOpenLogs: 'about:open-logs',
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
  // settings window -> main: open the online manual in the user's browser
  // (GOAL "First-Run Tutorial": "Settings -> General gets a Guide link").
  // No payload — the URL lives in main, so the renderer cannot name a
  // destination of its own.
  settingsOpenGuide: 'settings:open-guide',
  // Settings > Integrations (GOAL "Extension Install & Management UX"). The
  // status channel reports what is ACTUALLY on disk, in the registry and on the
  // wire — never a remembered verdict, because every one of those three can be
  // changed by something other than this app.
  settingsChromeStatus: 'settings:chrome-status',
  settingsChromeInstall: 'settings:chrome-install',
  settingsChromeUninstall: 'settings:chrome-uninstall',
  settingsChromeOpenFolder: 'settings:chrome-open-folder',
  // Chrome forbids a program from installing an unpacked extension, so the one
  // manual step cannot be removed — only made short. These two do the fetching
  // and the typing: open the page, and put the path on the clipboard.
  settingsChromeOpenExtensionsPage: 'settings:chrome-open-extensions-page',
  settingsChromeCopyPath: 'settings:chrome-copy-path',
  // Ask the browser what ID it gave our folder, then register with it. The one
  // step a user cannot be spared is loading the folder; finding out what came
  // of it is not their job.
  settingsChromeDetect: 'settings:chrome-detect',
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
  // render window -> main: how far through the replay this render has played.
  // The annotated render is REAL-TIME playback, so the only honest source of a
  // progress number is the playhead itself — main cannot compute one without
  // guessing, and a progress bar that guesses is a progress bar that lies.
  renderProgress: 'render:progress',
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
  // history window -> main (invoke): request re-editing and report accepted/busy
  historyOpenPack: 'history:open-pack',
  // history window -> main (invoke): open replay_annotated.webm in the system player
  historyPlay: 'history:play',
  // history window -> main (invoke): create the sibling {folder}.capturepack zip
  historyCreateZip: 'history:create-zip',
  // history window -> main: open the pack folder in the file manager
  historyOpenFolder: 'history:open-folder',
  // settings -> main (invoke): how much the output folder is holding, and what
  // an "older than N days" purge WOULD remove. Read-only; asked before every
  // delete so the confirmation can state real numbers.
  settingsStorageUsage: 'settings:storage-usage',
  // settings -> main (invoke): move packs older than N days to the Recycle Bin.
  settingsStoragePurge: 'settings:storage-purge',
  // history window -> main: open Settings. History is the window a user lingers
  // in, so it is the one place a settings change is wanted without a trip back
  // to the tray; main owns the window, as it does for every other opener.
  historyOpenSettings: 'history:open-settings',
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

// ---------------------------------------------------------------------------
// Image region selector

export interface ImageRegionSelectorInitPayload {
  requestId: string
  /** This renderer owns exactly one native monitor-sized overlay. */
  display: ImageRegionSelectorDisplay
  desktopBounds: ImageRegionRect
  /** Frozen display geometry; no pixels or filesystem paths cross this IPC. */
  displays: ImageRegionSelectorDisplay[]
  /** Native-pixel placement of those displays in the lossless composite. */
  layout: ImageRegionCompositeLayout
  focused: boolean
  uiLanguage: Language
}

export interface ImageRegionSelectorFocusPayload {
  requestId: string
  focused: boolean
}

export interface ImageRegionSelectorReadyPayload {
  requestId: string
}

export interface ImageRegionSelectorDragPayload {
  requestId: string
  phase: 'start' | 'move' | 'end'
  /** Windows virtual-desktop DIP coordinates. */
  desktopDipPoint: ImageRegionPoint
}

export interface ImageRegionSelectorPreviewPayload {
  requestId: string
  /** Null clears a rejected/abandoned drag on every monitor. */
  desktopDipRect: ImageRegionRect | null
}

export type ImageRegionSelectorCommitPayload =
  | {
      requestId: string
      mode: 'region'
      /** Local to the seamless virtual-desktop overlay, in CSS/DIP units. */
      localDipRect: ImageRegionRect
    }
  | {
      requestId: string
      mode: 'fullscreen'
    }

export interface ImageRegionSelectorCancelPayload {
  requestId: string
}

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
  /**
   * Whether this is the display that owns the pack clock (SPEC §10.1).
   *
   * Only that one ticks the surface ring (#105): a second display's frames
   * carry a different recording's numbers, and filing samples under those would
   * put the ring on two clocks at once — which is the problem, not the fix.
   */
  focused?: boolean
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
  // TEST PATH for the RECOVERY machinery (--simulate-slow-replay[=ms], issue
  // #43): the recorder is genuinely healthy and its ring buffer genuinely holds
  // footage — but the machine is too busy to tell main so. The frame heartbeat
  // is withheld and every replay answer is held back by this many milliseconds,
  // which is #43's own scenario: a wrong displayed state over a recording that
  // works. The delay is a parameter because both sides of the line matter — a
  // stall main can still wait out must end in "recording", and one it cannot
  // must end in no verdict at all rather than a destroyed buffer.
  // Absent in every normal run.
  simulateSlowReplayMs?: number
}

export interface CaptureReadyPayload {
  displayId: string
  mimeType: string
  replayFile: 'replay.webm' | 'replay.mp4'
  width: number
  height: number
  backend?: CaptureReplayBackend
  quality?: CaptureReplayQuality
  requestedFps?: number
  recorderCount?: number
  /** Browser-reported source latency, only when the track exposes it. */
  sourceLatencyMs?: number
  sourceLatencyCalibration?: {
    status: 'measured' | 'ambiguous' | 'unavailable'
    /** Conservative matcher verdict; never inferred from requested FPS. */
    reason?: string
    /** Source latency is measured only by the independent decoded-pixel match. */
    method?: 'pixel-match'
    /** Provenance of the sampled pixels used by the matcher. */
    sampleSource?:
      | 'media-stream-track-processor'
      | 'image-capture'
      | 'video-presentation-callback'
      | 'unknown'
    latencyMs?: number
    sampleCount: number
    confidence?: number
    bestDelta?: number
    observedChange?: number
    motionTransitions?: number
    candidates?: Array<{ latencyMs: number; delta: number }>
    /**
     * Processor clock/delivery diagnostic. This may refine pixel sample times,
     * but is never itself desktop pixel/source latency.
     */
    qpc?: {
      method: 'processor-qpc-clock'
      status: 'measured' | 'ambiguous' | 'unavailable'
      reason: string
      sampleCount: number
      timestampMonotonic?: boolean
      nativeQpcBracketed?: boolean
      timestampSpanMs?: number
      observedSpanMs?: number
      spanErrorRatio?: number
      deliveryLatencyMs?: number
      deliveryLatencyP05Ms?: number
      deliveryLatencyP50Ms?: number
      deliveryLatencyP95Ms?: number
      deliveryLatencyMadMs?: number
      deliveryLatencyBoundMs?: number
    }
    /** Independent decoded-pixel verdict used as fallback and conflict witness. */
    pixel?: {
      status: 'measured' | 'ambiguous' | 'unavailable'
      reason: string
      latencyMs?: number
    }
    /**
     * Direct same-pixel join from the independent desktop-exposure reference
     * to the startup rVFC presentation sink. No configured FPS or frame delay
     * participates in this measurement.
     */
    presentation?: {
      status: 'measured' | 'ambiguous' | 'unavailable'
      reason: string
      method?: 'dxgi-processor-rvfc-pixel-join'
      sampleCount: number
      latencyMs?: number
      matchedPairCount?: number
      processorToPresentationMs?: number
      dispersionMs?: number
      observedProcessorSpacingMs?: number
      bestDelta?: number
      contrast?: number
      /** Exact DXGI exposure wall time minus the matched rVFC mediaTime. */
      sourceMediaTimeOriginMs?: number
      direct?: {
        status: 'measured' | 'ambiguous' | 'unavailable'
        reason: string
        sampleCount: number
        latencyMs?: number
        bestDelta?: number
        contrast?: number
        matchedMediaTimeMs?: number
        sourceMediaTimeOriginMs?: number
      }
    }
    reference?: {
      source: 'dxgi-desktop-duplication' | 'windows-gdi-bitblt'
      timing: 'pixel-exposure' | 'post-bitblt-completion'
      /** Full QPC bracket retained from the helper, when DXGI was available. */
      anchorSpanQpc?: string
      anchorSpanMs?: number
      /** Midpoint projection uncertainty, equal to half the full bracket. */
      anchorUncertaintyMs?: number
      presentedAtUnixNs?: string
    }
    detail?: string
  }
  /**
   * Measured primary-source startup exclusion. The recorder is intentionally
   * created only after this observation, so the value belongs in the main log
   * rather than being inferred later from IPC arrival or flush time.
   */
  startupReadiness?: {
    observedWaitMs: number
    presentedFrames: number
    timedOut: boolean
    excludedBeforeRecorderMs: number
    observedSpanMs: number
  }
}

export type CaptureReplayBackend =
  | 'chromium-desktop-capture'
  | 'windows-gdi-bitblt'

export type CaptureReplayQuality = 'full' | 'degraded'

export interface CaptureDxgiTimingBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface CaptureDxgiTimingMetadataPayload {
  deviceName: string
  adapterIndex: number
  outputIndex: number
  bounds: CaptureDxgiTimingBounds
  /** BigInt values cross Electron IPC only as exact base-10 strings. */
  qpcFrequency: string
  anchor: {
    qpc: string
    unixNs: string
    /** Full before↔after QPC bracket around the Unix clock read. */
    spanQpc: string
  }
}

export interface CaptureDxgiTimingAvailablePayload
  extends CaptureDxgiTimingMetadataPayload {
  status: 'available'
  referenceTiming: 'pixel-exposure'
  resourceProvenance: 'same-acquired-dxgi-resource'
  clockProvenance: 'windows-qpc'
  width: 128
  height: 72
  channels: 3
  lastPresentQpc: string
  accumulatedFrames: number
  rgb: ArrayBuffer
}

export interface CaptureDxgiTimingUnavailablePayload {
  status: 'unavailable'
  reason: string
  detail?: string
  deviceName?: string
  adapterIndex?: number
  outputIndex?: number
  bounds?: CaptureDxgiTimingBounds
  qpcFrequency?: string
  anchor?: {
    qpc: string
    unixNs: string
    spanQpc: string
  }
}

export type CaptureDxgiTimingReferencePayload =
  | CaptureDxgiTimingAvailablePayload
  | CaptureDxgiTimingUnavailablePayload

export interface CaptureNativeFallbackRequest {
  requestedFps: number
  width: number
  height: number
  purpose?: 'fallback' | 'health-probe'
}

export interface CaptureNativeFallbackFramePayload {
  sessionId: string
  sequence: number
  /** Stamped only by the Windows helper protocol parser. */
  clockProvenance: 'windows-qpc'
  capturedQpc: number
  qpcFrequency: number
  capturedAtMs: number
  width: number
  height: number
  jpeg: ArrayBuffer
}

export interface CaptureNativeFallbackStartPayload {
  sessionId: string
  backend: 'windows-gdi-bitblt'
  quality: 'degraded'
  requestedFps: number
  fps: number
  width: number
  height: number
  firstFrame: CaptureNativeFallbackFramePayload
}

export interface CaptureNativeFallbackErrorPayload {
  sessionId: string
  message: string
}

/**
 * Frame evidence from one recorder window (GOAL "Say that you are recording",
 * issue #39). MediaRecorder.start() succeeding proves NOTHING: with Desktop
 * Duplication failing the recorder sits in state "recording" over an empty
 * buffer, and the tray used to claim "recording · last 30s ready" all the same.
 *
 * The renderer sends this EVERY time it can prove video is flowing —
 * non-trivial recorder output, or a growing delivered-frame count on the video
 * track — and main only then lets that display count as recording.
 *
 * Repeating it makes it a HEARTBEAT (issue #43): main's state used to be able
 * to latch on "stopped" after two early probes missed, and stayed wrong for the
 * life of the process (and through a restart, which simply repeated them). A
 * proof that keeps arriving lets the displayed state climb back to "recording"
 * on its own, without main ever stopping a healthy recorder to ask.
 *
 * IT ONLY WORKS IN ONE DIRECTION, deliberately. A message that stops arriving
 * NEVER demotes a display, because silence is not evidence: where the runtime
 * exposes no delivered-frame counter, the only thing left is recorder bytes,
 * and the MP4 muxer this app picks first emits ZERO of those between flushes —
 * a healthy recorder proves itself only when something flushes it (a slot
 * rotation, a capture, main's backstop probe), which on the default settings is
 * roughly every segment rather than every evidence window. Demoting on a quiet
 * heartbeat would therefore condemn perfectly good recorders on exactly the
 * machines this was built for. Failures arrive on their own channels instead:
 * capture:error, a renderer that vanishes, a stream that ended, or a probe that
 * came back with a flushed and empty buffer. (The earlier wording here claimed
 * convergence "in both directions"; the code has never done that, and saying so
 * in the contract was the thing that needed fixing, not the asymmetry.)
 */
export interface CaptureFramesPayload {
  displayId: string
  // Recorder bytes behind this proof; a header-only blob is not evidence.
  bytes: number
  // MediaStreamTrack delivered-frame count, or 0 where the API is unavailable.
  frames: number
  /** Exact native request↔presentation accounting, absent on Chromium capture. */
  nativePresentation?: {
    requestedFrames: number
    exactCallbacks: number
    unreportedPresented: number
    ambiguousDropped: number
    capacityDropped: number
    pending: number
  }
  /**
   * THE RECORDER'S OWN ACCOUNT OF ITS CADENCE (#82).
   *
   * A replay is the evidence a pack is built on, and until now nothing in the
   * app knew how good it was — a capture that dropped a fifth of its frames and
   * stalled for nearly a second twice looked exactly like a healthy one, and it
   * took ffprobe on the saved file to find out. Two numbers make that visible
   * from the log and from the pack itself.
   *
   * Absent where the runtime exposes no frame counter: a rate nobody measured
   * must not be reported as a rate.
   */
  cadence?: {
    /** Frames per second actually achieved since recording steadied. */
    achievedFps: number
    /** The longest the frame counter went without advancing, in ms. */
    worstStallMs: number
    /**
     * Frames the source made and threw away, or null when unknown (#82).
     *
     * Zero next to a low `achievedFps` means the screen produced no frames —
     * nobody touched that monitor — and a still screen is missing nothing.
     */
    discardedFrames?: number | null
    /** How long the counts above were measured over, in ms. */
    sampledMs?: number
    /** Frames delivered during that window. */
    gainedFrames?: number
    /** The source that supplied pixels to this recorder. */
    backend?: CaptureReplayBackend
    /** `degraded` is an explicit alternate capture path, never full quality. */
    quality?: CaptureReplayQuality
    /** User-configured target, kept distinct from achievedFps. */
    requestedFps?: number
    /** Active MediaRecorder encoders for this display. */
    recorderCount?: number
  }
}

/** One captured frame announcing itself (#105). */
export interface CaptureTickPayload {
  displayId: string
  /**
   * The frame's epoch-based DOMHighRes timestamp, in ms.
   *
   * `performance.timeOrigin + presentationTime`, so ticks from independent
   * capture renderers are comparable. This is NOT the track's `mediaTime`,
   * which starts when the stream did and which the spec allows to be zero for a
   * live source (#109).
   */
  mediaTimeMs: number
  /**
   * How old the frame already was when this tick was sent, in ms — if the
   * runtime can say (#109).
   *
   * Primary Chromium capture uses `VideoFrameCallbackMetadata.captureTime`
   * when available. Native fallback anchors the helper's first wall/QPC pair
   * onto this renderer's DOMHighRes axis, then advances only by QPC deltas.
   * Absent means unknown end-to-end — never a measured zero.
   */
  frameAgeMs?: number
  /**
   * How late the frame callback itself ran, in ms: the callback's own
   * timestamp minus `presentationTime` (#110).
   *
   * Under encoder load the compositor delivers frame callbacks in bursts, so a
   * tick can be sent tens of ms after the frame it names. The desk is read at
   * SEND time, and without this number that read is filed against the frame's
   * time — a one-frame-stale rectangle whenever callbacks bunch, which is 25 to
   * 40% of samples during a fast drag. Measured per frame; never assumed.
   */
  tickDelayMs?: number
}

export interface CaptureReplayResultPayload {
  requestId: string
  /**
   * The epoch-based DOMHighRes timestamp at this replay's t=0 (#112).
   *
   * `performance.timeOrigin + slot.startedAt` is comparable with ticks from
   * another display renderer. A bare per-renderer `startedAt` is not. Turning
   * this into a position in the file happens after Core converts both onto its
   * one monotonic session clock.
   *
   * Absent where the recorder could not say, in which case the ring keeps its
   * own clock and nothing is mis-stated.
  */
  originMs?: number
  /**
   * Exact same-frame observations joining encoded PTS to the epoch-based
   * presentation clock. Unlike `originMs`, this can represent a measured clock
   * whose rate changes slightly across the retained replay.
   *
   * The main process validates monotonicity again before using these. They map
   * clocks only; they never authorize interpolation of object geometry/state.
   */
  clockAnchors?: readonly {
    ptsMs: number
    wallMs: number
  }[]
  /**
   * Same PTS anchors translated onto independently measured desktop-pixel
   * exposure time. Present only when the DXGI/QPC/pixel calibration is proved;
   * context uses these while the media clock above remains unchanged.
   */
  sourceClockAnchors?: readonly {
    ptsMs: number
    wallMs: number
  }[]
  // Recorder bytes; empty when no replay is available (screenshot-only capture).
  buffer: ArrayBuffer
  durationMs: number
  mimeType: string
  replayFile: 'replay.webm' | 'replay.mp4'
  /** Bounded in-memory ownership measured at the exact replay request. */
  ringDiagnostics?: {
    retainedFragmentCount: number
    retainedBytes: number
    retainedDurationMs: number
    selectedFragmentCount: number
    /**
     * WHERE THIS CAPTURE'S TIME WENT (#116). Recorded, never acted on.
     *
     * These separate the layers that a compressed replay could have been
     * flattened by: the encoder's own span against the media sum says whether
     * `tfdt` carried a gap, the longest sample says whether the sample
     * durations did, and the delivery count says how much independent wall
     * evidence there was to check either against.
     */
    ringTiming?: {
      sampleCount: number
      maxSampleDurationMs: number
      sourceSpanMs: number
      fragmentsWithSourceTime: number
      deliveryCount: number
      /**
       * WHY the timeline came out the length it did (#116).
       *
       * A refused `tfdt` and a privacy-window trim both produce a short replay,
       * and without this they are indistinguishable from each other and from
       * success.
       */
      assembly?: {
        retentionMs: number
        selectedBeforeRetention: number
        selectedAfterRetention: number
        timelineBeforeRetentionMs: number
        verdicts: ReadonlyArray<{
          trusted: boolean
          reason?: string
          claimedMs: number | null
          wallSpanMs: number
        }>
      } | null
    }
    /** Async source/presentation comparison; diagnostic until measured. */
    sourceLatencyCalibration?: CaptureReadyPayload['sourceLatencyCalibration']
    /**
     * Encoded PTS -> shared presentation clock evidence. Only an exact
     * same-frame pixel match may report a measured origin.
     */
    replayPixelClock?: {
      status: 'measured' | 'ambiguous' | 'unavailable'
      reason: string
      presentedSampleCount: number
      decodedSampleCount: number
      matchCount: number
      originMs?: number
      originSpreadMs?: number
      motionTransitions?: number
      bestDelta?: number
      minimumContrast?: number
      candidateOriginsMs?: readonly number[]
      clockAnchors?: readonly {
        ptsMs: number
        presentedAtMs: number
        mediaTimeMs?: number
      }[]
    }
    /** Measured renderer-clock samples used to audit encoder delivery latency. */
    clockSamples?: Array<{
      recorderStartedAtMs: number
      eventTimeStampMs: number
      blobTimecodeMs: number
      deliveredAtMs: number
      latestPresentationTimeMs?: number
      latestCaptureTimeMs?: number
      latestMediaTimeMs?: number
    }>
  }
}

export interface CaptureReplayRequestPayload {
  requestId: string
  /**
   * Stop at the exact replay boundary and wait for captureResumeReplay instead
   * of starting a replacement encoder. Health probes leave this false.
   */
  holdAfterCapture?: boolean
}

export interface CaptureReplayResumePayload {
  /** Matches the request that owns the held recorder boundary. */
  requestId: string
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
  // clock. 0 on the focused display. Fresh captures use the observed difference
  // between recorder origins; reopened legacy packs fall back to the former
  // duration-difference rule (SPEC §5.6).
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
  /**
   * The OS window handle, decimal — the one identifier every source of window
   * data is looking at the same value of (#97).
   *
   * Everything else is a description two sources can disagree about: the
   * surface host reports a process as "explorer.exe" and the UI Automation dump
   * as "explorer"; an untitled window has its class written into its title by
   * the dump and left empty by the host. Matching on those is guesswork, and it
   * silently matched nothing at all.
   *
   * Absent on a pack written before the dump reported it.
   */
  hwnd?: string
  /**
   * Core's own surface id, when this window came from the surface ring (#90).
   *
   * Stable for the whole session — hwnd plus a creation ordinal, so a recycled
   * handle becomes a new surface — and unaffected by the window's position in
   * any list. Absent for a window that came from a UI Automation dump, which
   * describes one instant and is identified by name and order instead.
   */
  surface_id?: string
  title: string
  process: string
  class_name: string
  bounds: { x: number; y: number; width: number; height: number }
  /**
   * The CLIENT area in the same space as `bounds` — the drawable rectangle
   * inside the frame, with the title bar and borders removed.
   *
   * Carried because a provider that measures in a document's own coordinates
   * (a browser extension: viewport CSS pixels) has no other way onto the
   * screen. The frame rectangle cannot do it — the distance from the frame's
   * top to the first drawable row is the window's chrome, which varies by app,
   * theme and DPI — while the client rectangle IS that row. The surface ring
   * has recorded it since #65; it simply never reached this side.
   *
   * Absent for a window from a UI Automation dump (which reports frames only)
   * and for a pack written before this field existed.
   */
  client_bounds?: { x: number; y: number; width: number; height: number }
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
  /**
   * A prior control tree exists, but an observed owner resize invalidated its
   * cached absolute rectangles before Lane A supplied a newer geometry revision.
   *
   * This is distinct from ordinary `tree: "skipped"`: skipped normally permits
   * a richer checkpoint fallback, while invalidated geometry must remain absent
   * through save/reopen until a fresh UIA tree/rectangle observation arrives.
   */
  control_geometry_invalidated?: true
}

export interface EditorInitPayload {
  captureKind: 'image' | 'video'
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
  // OBJECT PICKING, AT A TIME (#64/#65/#66): the session the editor asks for
  // candidate frames on, plus the frame at the capture instant — which is where
  // the editor opens, so picking works from the first paint without a round
  // trip. null when this build could not open a context session at all, and the
  // editor then behaves exactly as it did before picking existed.
  //
  // NOT FINAL on a fresh capture: when the observation has not settled by the
  // time the editor is ready, the initial frame is empty and a real one arrives
  // on IPC.contextFrame moments later.
  context: EditorContextInit | null
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
  // Whether to open the first-run tutorial with this editor (GOAL "First-Run
  // Tutorial"). Main decides; the renderer only paints what it is told.
  showEditorTutorial: boolean
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
 * What the editor needs to ask Core "what was at this point, at this time".
 *
 * The frame is the one at the CAPTURE INSTANT, because that is where the editor
 * opens; every other position is a `context:request-frame` away, asked when the
 * scrub settles.
 */
export interface EditorContextInit {
  sessionId: string
  frame: ContextFrame
}

/** IPC.contextRequestFrame — the editor asking for one scrub position. */
export interface ContextFrameRequest {
  sessionId: string
  // Pack-clock ms (SPEC §10.1), the same clock the editor scrubs on and the
  // same one annotation lifetimes use. Providers never see this number: Core
  // converts to the session clock, because a provider guessing that mapping is
  // wrong in a way nobody notices for months (design §3.1).
  timeMs: number
}

/** One rectangle on one display's snapshot, at one moment of the pack clock. */
export interface ObjectTrackSample {
  tMs: number
  /** Which display these numbers are pixels of — a window can cross screens (#86). */
  display: number
  x: number
  y: number
  width: number
  height: number
}

/**
 * An object's path through the replay (#86) — what lets a box FOLLOW the thing
 * it points at instead of sitting where that thing used to be.
 *
 * Samples are ascending on the pack clock and are pixels in `display`'s own
 * snapshot, the same space an annotation's `bounds` is in (SPEC §8.2, §8.8).
 * Between two samples a reader interpolates; outside them the object was not
 * being recorded, and a box has nothing to follow.
 */
export interface ObjectTrackResult {
  /** The display the object STARTED on; individual samples may name another. */
  display: number
  samples: ObjectTrackSample[]
  /**
   * When the object stopped being there, or null if it lasted the whole range.
   *
   * A box may not outlive this (#77): past it the box would point at whatever
   * moved in behind, and nothing in the pack would say so.
   */
  endedAtMs: number | null
}

/** IPC.contextRequestTrack — the editor asking where one picked object went. */
export interface ObjectTrackRequest {
  sessionId: string
  surfaceId: string
  startMs: number
  endMs: number
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
  /** Present = measure, do not draw. See ExposureMeasureRequest. */
  measure?: ExposureMeasureRequest
  annotations: Annotation[]
  // All display coordinate spaces for authored keyframes that cross monitors.
  // Absent for a single-display render or an older caller.
  motionSpace?: AuthoredMotionSpace
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
  // WHICH display this job is drawing (SPEC §5.6 index), absent = the focused
  // one. Only tracked boxes need it: a box follows its object onto another
  // screen (#86), so a job has to know which rectangles are its own to draw and
  // which belong to the neighbour's video.
  display?: number
  // The pack's focused display index, which is what an ABSENT `display` means —
  // on the job above and on an annotation alike (SPEC §8.8). Carried so the two
  // can be compared without the renderer guessing. Absent in a single-display
  // pack, where every box is on the one screen and there is nothing to compare.
  focusedDisplay?: number
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
  /** Container the TRIM should re-encode into when supported (#113). */
  preferMimeType?: string
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

/**
 * A MEASUREMENT JOB, NOT A DRAWING ONE (#89).
 *
 * Present = this render window decodes frames and scores them, and draws and
 * records nothing. It exists because the pixels the correction is measured
 * against are the pack's OWN replay, and this window is the only place in the
 * app that can decode one.
 *
 * It runs AFTER the pack is written, so it costs the save nothing, and its
 * answer is applied to the NEXT capture of the same display — which is what
 * `media.cadence.source_latency`'s `age_ms` was designed to declare.
 */
export interface ExposureMeasureRequest {
  /** The observed rectangles, in the replay's own display pixels. */
  candidates: Array<{
    tMs: number
    x: number
    y: number
    width: number
    height: number
  }>
  /** Desktop pixels to replay pixels: the recorder's downscale, nothing else. */
  scale: number
  /** How many frames to sample across the moving range. */
  sampleCount: number
  /** Only rectangles this close to a frame are scored against it. */
  candidateWindowMs: number
}

export interface RenderResultPayload {
  ok: boolean
  /** Measurement job only: one row per frame that could be decoded and scored. */
  scoreRows?: Array<{ ptsMs: number; scores: Array<{ tMs: number; score: number }> }>
  // webm bytes of replay_annotated when ok; absent on a still job
  webm?: ArrayBuffer
  /** The container/codec the encoder actually produced (#113). */
  producedMimeType?: string
  // How many stills this job SENT over IPC.renderFrame (the bytes themselves
  // never travel in this message). A still that failed to encode is dropped and
  // not counted, and is never fatal to the render.
  frameCount?: number
  error?: string
}

// 'trimming' = the plain-trim render is producing the trimmed replay bytes
// (GOAL "Replay Trim") — it precedes 'rendering' (the annotated render) when
// the save carries an active trim.
export type ToastRenderState =
  | 'none'
  | 'trimming'
  | 'rendering'
  | 'done'
  | 'failed'
  | 'image-rendering'
  | 'image-copied'
  | 'image-copy-failed'

/** What the toast is told about a render in flight (#96). */
export interface ToastRenderStatusPayload {
  state: ToastRenderState
  /**
   * How far through, 0..1 — ABSENT while nothing real is known.
   *
   * The bar is indeterminate until the render reports a playhead, rather than
   * animating from a number nobody measured.
   */
  progress?: number
}

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
  /**
   * This state is the answer to a check the USER asked for, from the tray or
   * About (#111).
   *
   * "Already up to date" is worth saying exactly once, to the person who just
   * pressed the button and is waiting to hear something. On the four-hourly
   * automatic check it is the noise #103 removed: a routine toast that the lock
   * screen reduces to a red badge and an app name, indistinguishable from a
   * capture that failed. So the answer travels with the question.
   */
  userRequested?: boolean
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
  /**
   * How the PREVIOUS run ended (issue #61). "Is CapturePack actually running,
   * and has it been?" was unanswerable without a terminal; this is the answer,
   * in the one window that already exists to describe the app to its user.
   *
   * Every value main can reach is rendered on its own. Collapsing them cost the
   * user the truth twice over: an update-replaced marker was drawn as "closed
   * normally", which nobody had observed, and which also silently relabelled a
   * genuine crash of the old build that happened just before the update.
   *
   *  - 'none'     nothing recorded yet (fresh install).
   *  - 'clean'    exited through the app's own quit path, nothing unhandled.
   *  - 'faulted'  exited, but ran on after errors nobody handled: not a crash,
   *               and not a normal close either.
   *  - 'unclean'  vanished rather than exited. `endedAt` is when it was last
   *               known to be alive — the start of a window in which the replay
   *               buffer did not exist.
   *  - 'unknown'  a DIFFERENT version left the marker open: an update replaced
   *               that build, so it is never called a crash — but how it ended
   *               was never observed, and saying otherwise would invent it.
   */
  lastRun: {
    status: 'none' | 'clean' | 'faulted' | 'unclean' | 'unknown'
    // ISO timestamp; null only for 'none'. The renderer formats it in the UI
    // locale — main must not bake a date format into an IPC payload.
    endedAt: string | null
  }
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
/**
 * The six-point health check the GOAL asks for, as facts rather than a verdict
 * (GOAL "Integration Operations": "invaluable for bug reports").
 */
export interface ChromeIntegrationStatus {
  /** The app is listening for a native host. */
  listening: boolean
  /** A host process has dialled in at least once this run. */
  hostSeen: boolean
  /** The extension completed its handshake. */
  extensionConnected: boolean
  extensionVersion: string | null
  /**
   * The version of the extension folder THIS BUILD ships, or null when it
   * cannot be read.
   *
   * The extension is loaded unpacked, so nothing updates it when the app
   * updates: the browser keeps running whatever was on disk the day it was
   * loaded. Carrying both halves is what lets Settings say "reload it" instead
   * of leaving a stale extension to fail in ways that look like a broken app.
   */
  bundledExtensionVersion: string | null
  protocolVersion: number | null
  appProtocolVersion: number
  protocolCompatible: boolean
  /** The native messaging manifest exists where the browsers were told. */
  manifestWritten: boolean
  manifestPath: string
  allowedExtensionIds: readonly string[]
  browsers: readonly { id: string; label: string; registered: boolean }[]
  extensionDir: string
  extensionDirExists: boolean
  /**
   * A browser is still loading the extension from inside the INSTALL directory
   * — the folder an update replaces (see install.ts `extensionDir`). It works
   * right now and breaks at the next update, and nothing about the outside
   * distinguishes the two states, so the panel has to say it.
   */
  legacyExtensionLoaded: boolean
  legacyExtensionDir: string
  /** DOM events held for the current replay window. */
  events: number
  /**
   * THE PICKER'S OWN STATE, BECAUSE A HANDSHAKE IS NOT A PICK (#104).
   *
   * Every light on this panel could be green while element picking was
   * completely dead: the extension connects, tab events flow, and the pick that
   * never happens leaves no mark. These three carry the other half — how many
   * picks actually arrived, how many messages were refused and why, and what
   * the picker last reported doing.
   */
  elementPicks: number
  rejected: number
  lastRejection: string | null
  picker: {
    phase: 'armed' | 'disarmed' | 'failed'
    atMs: number
    reason: string | null
    tab: { url: string; title: string } | null
  } | null
  /** IDs the browser assigned to our extension folder, if it has loaded it. */
  detected: readonly { id: string; browser: string; profile: string }[]
}

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
/**
 * What the output folder holds, and what an "older than N days" purge would
 * take with it.
 *
 * The per-age counts are computed alongside the total in ONE walk of the
 * folder, so the three buttons can each state their own consequence without
 * three separate scans — and so the number the user is shown is from the same
 * moment as the number the delete will act on.
 */
export interface StorageUsage {
  totalBytes: number
  totalPacks: number
  /** Keyed by age in days: what deleting everything older than that removes. */
  olderThan: { days: number; packs: number; bytes: number }[]
}

export interface StoragePurgeResult {
  ok: boolean
  packsDeleted: number
  bytesFreed: number
  error?: string
}

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
  // Same contract for the explicit still-image shortcut. Kept separate so the
  // renderer can report the failure beside the field that actually failed.
  imageHotkeyFailed?: boolean
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
  captureKind: 'image' | 'video' | 'unknown'
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
  // 0..1 while the render reports a real playhead. ABSENT means "no measurement
  // yet" — queued behind another render, or a stage that cannot say — and the
  // card draws an indeterminate bar rather than inventing a fraction.
  ratio?: number
}
