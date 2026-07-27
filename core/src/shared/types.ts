// CapturePack format types — mirror SPEC.md (format_version 0.1.0).
// These types describe data written into a .capturepack; keep them in sync with the spec.

export const FORMAT_NAME = 'capturepack'
export const FORMAT_VERSION = '0.1.0'

// Per-display media of an all-displays capture (SPEC §5.3, GOAL "Multi-Monitor
// Support"). One entry per display frozen by the trigger.
export interface ManifestDisplayMedia {
  // 1-based position in manifest.environment.screens (OS enumeration order).
  index: number
  // "snapshot-d<index>.png" — except the FOCUSED display, whose media IS the
  // top-level media: snapshot === "snapshot.png" (the bytes are never
  // duplicated, so a reader ignoring displays[] still sees the focused one).
  snapshot: string
  // "replay-d<index>.webm", the top-level replay filename on the focused
  // display, or null when this display recorded nothing.
  replay: string | null
  replay_duration_ms?: number
  // The display's rectangle in the OS virtual-desktop coordinate space
  // (device-independent pixels); multiply by `scale` for physical pixels.
  bounds: { x: number; y: number; width: number; height: number }
  scale: number
  // Exactly one entry is focused: the display the cursor was on at the
  // trigger. The editor opens there and annotations anchor to it.
  focused: boolean
}

// One annotated keyframe still (SPEC §5.7, GOAL "Annotated keyframes"): a PNG
// rendered at one annotation state change, with the SAME overlays the annotated
// replay draws. LLMs read images, not video.
export interface ManifestKeyframe {
  // Pack-relative filename, "frames/frame-<NN>_<MM-SS.mmm>.png" — NN is the
  // entry's 1-based position in the array (shared/keyframes.ts owns the rule).
  file: string
  // Position on the replay clock (ms) of the frame this still shows. 0 in a
  // screenshot-only pack, whose single still comes from snapshot.png.
  t_ms: number
}

export interface Manifest {
  format: typeof FORMAT_NAME
  format_version: string
  id: string
  created_at: string
  generator: { name: string; version: string }
  title?: string
  note?: string
  environment: {
    os: string
    os_version: string
    screens: Array<{ width: number; height: number; scale: number }>
    app?: string
  }
  media: {
    snapshot: string
    replay: string | null
    replay_duration_ms?: number
    // All-displays capture (SPEC §5.3): the media of EVERY display the trigger
    // froze, focused one included. Absent when only one display was captured
    // (settings.captureDisplay "cursor"/"<id>"), which is exactly the 0.1.2
    // single-display pack.
    displays?: ManifestDisplayMedia[]
    // Annotated replay ("replay_annotated.webm"/".mp4", SPEC §7.2): the replay
    // with annotation boxes rendered into the pixels. Absent while not yet
    // rendered (it renders in the background after save) and always absent
    // when replay is null. Regenerable from replay + annotations.json.
    replay_annotated?: string
    // Annotated keyframe stills (SPEC §5.7, §7.3): one PNG per annotation state
    // change, ordered by t_ms ascending. Written by the SAME render pass as
    // replay_annotated and declared with it, so it is absent until that render
    // completes. A screenshot-only pack gets exactly one entry (t_ms 0),
    // rendered from snapshot.png. Regenerable from the media + annotations.json.
    keyframes?: ManifestKeyframe[]
    // Replay-timeline position (ms, same clock as timeline t_ms) of the frame
    // shown in snapshot.png. Absent = the capture instant ("now").
    snapshot_t_ms?: number
    // Provenance only (GOAL "Replay Trim"): the in-point (ms) in the ORIGINAL
    // recording that this replay was trimmed from at save time. Every other
    // time in the pack is already on the trimmed replay clock — readers never
    // need to apply this offset. Absent = the replay was never trimmed.
    trim_offset_ms?: number
  }
  plugins: Array<{ name: string; version: string; path: string }>
}

// Format 0.1.0 defines exactly ONE annotation type: the box (SPEC §8). A box
// composes its roles through properties — numbered:true is a numbered marker,
// blur:true is a sensitive region, text is its description; any combination is
// valid on a single box.
export type AnnotationType = 'box'

// The rectangle of a box in snapshot pixel coordinates (SPEC §8.2, §8.3).
// width and height are > 0.
export interface AnnotationBounds {
  x: number
  y: number
  width: number
  height: number
}

// Object-tracking state (SPEC §8.3). In format 0.1.0 `enabled` is always
// false — frame-by-frame tracking data is reserved for a future version; the
// object shape exists so richer data can arrive without a breaking change.
export interface AnnotationTracking {
  enabled: boolean
}

// Semantic object metadata (SPEC §8.3, §8.7): what real UI object the box
// points at. The old "element" annotation concept lives here — a box WITH a
// target is a semantic annotation; there is no separate element type.
//
// `source` is the discriminator. Format 0.1.0 defines exactly one source,
// "uia" (see UiaAnnotationTarget); readers ignore sources they do not know and
// still render the box from `bounds`.
export type AnnotationTarget = Record<string, unknown>

/**
 * `target` for source "uia" (SPEC §8.7): a Windows UI Automation element the
 * user picked in the editor, from the capture-instant dump in
 * plugins/windows-uia/ (GOAL "Static object picking (v0 — before full
 * tracking)"). Every field but `source` is omitted when the element had no
 * value for it — an empty string is never written.
 */
export type UiaAnnotationTarget = {
  source: 'uia'
  // UIA Name — what the user sees (also the box's pre-filled text).
  name?: string
  // UIA ControlType without the "ControlType." prefix, e.g. "Button".
  control_type?: string
  // UIA AutomationId — the stable, non-localized id when the app provides one.
  automation_id?: string
  // Win32 window class of the element, e.g. "Chrome_WidgetWin_1".
  class_name?: string
}

// ---------------------------------------------------------------------------
// plugins/windows-uia (SPEC §11.3, GOAL "Static object picking")
// ---------------------------------------------------------------------------

/** A rectangle in the pack's snapshot pixel coordinate space (SPEC §8.2). */
export interface UiaBounds {
  x: number
  y: number
  width: number
  height: number
}

/** One top-level window that existed at the capture instant. */
export interface UiaWindowRecord {
  title: string
  // Process name without extension, e.g. "chrome". '' when unavailable.
  process: string
  bounds: UiaBounds
  // Exactly the window that had focus; false for every other window. A dump
  // that could not determine the foreground window has no focused entry.
  focused: boolean
}

/** One control of the FOREGROUND window's UI Automation tree. */
export interface UiaElementRecord {
  name: string
  control_type: string
  automation_id: string
  class_name: string
  bounds: UiaBounds
  // 0 = the foreground window itself; a pre-order walk of its control view.
  depth: number
}

/** plugins/windows-uia/elements.json (SPEC §11.3). */
export interface UiaPluginPayload {
  // When the dump was taken — the capture instant, ISO 8601 with offset.
  captured_at: string
  // The budget (ms) the dump was given; it is killed at that point.
  budget_ms: number
  // true = the walk hit the budget, the element cap, or the depth cap, so the
  // tree below is INCOMPLETE. Never a reason to distrust what IS there.
  truncated: boolean
  windows: UiaWindowRecord[]
  elements: UiaElementRecord[]
}

// Display styling (SPEC §8.3). `color` is CSS hex ("#RRGGBB"/"#RRGGBBAA"),
// used for the border, number badge, and text.
export interface AnnotationStyle {
  color: string
}

export interface BoxAnnotation {
  // Permanent identity: "ann_" + 6 lowercase hex (SPEC §8.3). Never changes;
  // display numbers do.
  annotation_id: string
  type: 'box'
  bounds: AnnotationBounds
  // The description the user typed. May be empty (spec default: "").
  text: string
  // Lifetime interval [start_ms, end_ms] on the replay clock (SPEC §8.4).
  // BOTH present or BOTH absent; start_ms <= end_ms. Absent = whole capture.
  // The representative instant of a box is the lifetime MIDPOINT — there is
  // no separately stored anchor.
  start_ms?: number
  end_ms?: number
  // Whether the box takes part in display numbering (SPEC §8.5). The number is
  // computed via computeDisplayNumbers(), never stored.
  numbered: boolean
  // Whether the interior is blurred in RENDERED views only (SPEC §9): the
  // original snapshot.png and replay are never modified.
  blur: boolean
  tracking: AnnotationTracking
  target?: AnnotationTarget
  style?: AnnotationStyle
  created_at: string
  z: number
}

export type Annotation = BoxAnnotation

export interface AnnotationsFile {
  reference_width: number
  reference_height: number
  annotations: Annotation[]
}

// Display numbers are computed, never stored (SPEC §8.5): every consumer — the
// editor canvas, the annotated-replay renderer, report.md, README.md, skills/
// documents, MCP responses — MUST derive them from this one function so video
// numbers and document numbers can never differ.
//
// Rule: take the boxes with numbered:true and sort by start_ms ascending
// (absent lifetime = 0), then z ascending (absent z = array position, for
// externally written packs), then annotation_id ascending; number contiguously
// from 1. Returns annotation_id -> display number; unnumbered boxes are absent.
export function computeDisplayNumbers(
  annotations: readonly Annotation[],
): Map<string, number> {
  const numbered = annotations
    .map((a, index) => ({ a, index }))
    .filter(({ a }) => a.numbered)
  numbered.sort((p, q) => {
    const pStart = typeof p.a.start_ms === 'number' ? p.a.start_ms : 0
    const qStart = typeof q.a.start_ms === 'number' ? q.a.start_ms : 0
    if (pStart !== qStart) return pStart - qStart
    const pZ = typeof p.a.z === 'number' ? p.a.z : p.index
    const qZ = typeof q.a.z === 'number' ? q.a.z : q.index
    if (pZ !== qZ) return pZ - qZ
    return p.a.annotation_id < q.a.annotation_id
      ? -1
      : p.a.annotation_id > q.a.annotation_id
        ? 1
        : 0
  })
  const numbers = new Map<string, number>()
  numbered.forEach(({ a }, i) => numbers.set(a.annotation_id, i + 1))
  return numbers
}

export interface TimelineEvent {
  t_ms: number
  type: string
  source: string
  data?: Record<string, unknown>
}

export interface TimelineFile {
  t0: string
  events: TimelineEvent[]
}

// App settings (not part of the pack format).

// The out-of-the-box capture accelerator (GOAL "Settings GUI" > Capture). Both
// the settings default and the settings GUI's reset-to-default read this one
// constant so the two can never drift.
export const DEFAULT_CAPTURE_HOTKEY = 'Ctrl+Alt+C'

// How the annotation editor opens (GOAL "Editor Window Mode"): the fullscreen
// overlay (DEFAULT — fastest annotation) or a real movable/resizable window.
export type EditorWindowMode = 'fullscreen' | 'windowed'

/** Remembered windowed-mode editor rectangle, in device-independent pixels. */
export interface EditorWindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface Settings {
  // UI language: "system" (default — app.getLocale() at runtime) or a
  // supported language code from shared/i18n.ts (en/ko/ja/zh/es/fr/de/pt/ru).
  language: string
  // Pack document language (README/report/skills templates): "ui" (default —
  // follow the resolved UI language) or a supported language code.
  packLanguage: string
  autoUpdateCheck: boolean
  outputDir: string
  copyToClipboard: boolean
  // The first-launch welcome window has been shown (GOAL "Welcome (first launch
  // after install)"): written the moment the window opens, so it appears once
  // and never again on its own. Showing it is gated on a genuinely fresh
  // install (no settings file existed at load) AND this flag — an update, which
  // always finds a settings file, never shows it. About's "Show welcome again"
  // re-opens it on demand.
  welcomeShown: boolean
  // Global capture accelerator in Electron syntax, e.g. "Ctrl+Alt+C" (default
  // DEFAULT_CAPTURE_HOTKEY). At least one modifier plus exactly one key; an
  // unusable value falls back to the default when settings load.
  captureHotkey: string
  replaySeconds: number
  fps: number
  // Capture display (GOAL "Multi-Monitor Support"):
  //  - "all" (DEFAULT) — the trigger freezes EVERY connected display; the pack
  //    carries per-display media (manifest.media.displays) and the display
  //    under the cursor becomes the focused one.
  //  - "cursor" — record every display, but keep only the cursor display.
  //  - "<displayId>" — an Electron display id as a string (fixed display; one
  //    recorder pair, lowest CPU).
  // "all" and "cursor" run the same recorder set, so "all" costs export work,
  // not capture work.
  captureDisplay: string
  scrubInvert: boolean
  scrubSensitivityMs: number
  // Default lifetime duration (ms) stamped on manual annotations in the editor.
  defaultManualDurationMs: number
  // Show the duration chip on the selected annotation in the editor.
  showDurationLabel: boolean
  // Editor window mode (GOAL "Editor Window Mode"): "fullscreen" (DEFAULT — the
  // overlay every capture opened with before this existed) or "windowed". The
  // editor writes it back whenever the user toggles (⧉ / F11), so the next
  // capture opens the way the user left it.
  editorWindowMode: EditorWindowMode
  // The windowed editor's last rectangle, remembered with the mode. null until
  // the user has been in windowed mode once (a default rectangle is then
  // centered on the capture's display). Re-opened on the CAPTURE's display and
  // clamped to its work area, so a remembered rectangle can never strand the
  // editor off-screen after a monitor change.
  editorWindowBounds: EditorWindowBounds | null
  // Always-On MCP Server (read-only, Streamable HTTP on 127.0.0.1:<mcpPort>/mcp).
  mcpEnabled: boolean
  mcpPort: number
  mcpAutoStart: boolean
  mcpReadOnly: boolean
  mcpWatchExportFolder: boolean
  mcpLogRequests: boolean
}
