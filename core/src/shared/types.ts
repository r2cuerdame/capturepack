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
    // Replay-timeline position (ms, same clock as timeline t_ms) of the frame
    // shown in snapshot.png. Absent = the capture instant ("now").
    snapshot_t_ms?: number
  }
  plugins: Array<{ name: string; version: string; path: string }>
}

// SPEC reserves type "element" (Tracked Element — alive while the tracked
// object exists, bounds following it) for a future format version; readers
// MUST ignore unknown types, so it stays out of this union until then.
export type AnnotationType = 'pin' | 'arrow' | 'rect' | 'blur' | 'text'

interface AnnotationBase {
  id: string
  type: AnnotationType
  z: number
  created_at: string
  // Replay position (ms) the annotation refers to — the ANCHOR frame: the
  // scrub position when it was created. Absent for screenshot-only captures.
  t_ms?: number
  // OPTIONAL lifetime interval on the replay timeline (same clock as t_ms,
  // t_start_ms <= t_end_ms): the annotation applies while the scrub position
  // lies inside it. When present the anchor SHOULD lie inside the interval.
  // Absent lifetime = the annotation applies to the whole capture.
  t_start_ms?: number
  t_end_ms?: number
}

// Display color; SPEC §8.3 declares it meaningless for blur, so blur omits it.
interface ColoredAnnotationBase extends AnnotationBase {
  color: string
}

export interface PinAnnotation extends ColoredAnnotationBase {
  type: 'pin'
  x: number
  y: number
  label?: string
}

export interface ArrowAnnotation extends ColoredAnnotationBase {
  type: 'arrow'
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface RectAnnotation extends ColoredAnnotationBase {
  type: 'rect'
  x: number
  y: number
  w: number
  h: number
  label?: string
}

export interface BlurAnnotation extends AnnotationBase {
  type: 'blur'
  color?: never // SPEC §8.3: SHOULD be omitted for blur — `never` keeps writers honest
  x: number
  y: number
  w: number
  h: number
}

export interface TextAnnotation extends ColoredAnnotationBase {
  type: 'text'
  x: number
  y: number
  text: string
  size?: number
}

export type Annotation =
  | PinAnnotation
  | ArrowAnnotation
  | RectAnnotation
  | BlurAnnotation
  | TextAnnotation

export interface AnnotationsFile {
  reference_width: number
  reference_height: number
  annotations: Annotation[]
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
