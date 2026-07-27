// CapturePack format types — mirror SPEC.md (format_version 0.1.0).
// These types describe data written into a .capturepack; keep them in sync with the spec.

export const FORMAT_NAME = 'capturepack'
export const FORMAT_VERSION = '0.1.0'

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
    // Annotated replay ("replay_annotated.webm"/".mp4", SPEC §7.2): the replay
    // with annotation boxes rendered into the pixels. Absent while not yet
    // rendered (it renders in the background after save) and always absent
    // when replay is null. Regenerable from replay + annotations.json.
    replay_annotated?: string
    // Replay-timeline position (ms, same clock as timeline t_ms) of the frame
    // shown in snapshot.png. Absent = the capture instant ("now").
    snapshot_t_ms?: number
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

// RESERVED (SPEC §8.3): semantic object metadata — what real UI object the box
// points at (DOM selector/role/text, UIA AutomationId/ControlType, ...). The
// old "element" annotation concept lives here now. Contents undefined in 0.1.0.
export type AnnotationTarget = Record<string, unknown>

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
export interface Settings {
  autoUpdateCheck: boolean
  outputDir: string
  copyToClipboard: boolean
  replaySeconds: number
  fps: number
  // Capture display: "cursor" (default — follow the mouse at trigger; a
  // recorder pair runs per connected display) or an Electron display id as a
  // string (fixed display — one recorder pair, lower CPU).
  captureDisplay: string
  scrubInvert: boolean
  scrubSensitivityMs: number
  // Default lifetime duration (ms) stamped on manual annotations in the editor.
  defaultManualDurationMs: number
  // Show the duration chip on the selected annotation in the editor.
  showDurationLabel: boolean
  // Always-On MCP Server (read-only, Streamable HTTP on 127.0.0.1:<mcpPort>/mcp).
  mcpEnabled: boolean
  mcpPort: number
  mcpAutoStart: boolean
  mcpReadOnly: boolean
  mcpWatchExportFolder: boolean
  mcpLogRequests: boolean
}
