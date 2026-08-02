// CapturePack format types — mirror SPEC.md (format_version 0.2.2).
// These types describe data written into a .capturepack; keep them in sync with the spec.
//
// 0.2.1 adds one OPTIONAL field, `number_pin` on a box (SPEC §8.5): the display
// number its author asked for. A PATCH, not a minor, and §13.1 is what decides
// that — while the major version is 0, minor carries the promises major
// normally does, so an additive optional field is a patch. A 0.2.0 reader
// ignores the field and computes numbers the automatic way, which is a valid,
// self-consistent pack; that is precisely the forward compatibility §13.1
// requires, so nothing older breaks.
//
// 0.2.2 widens that field from 1-9 to any integer >= 1 (#51). Also a patch, and
// for the same reason: 0.2.1 already defined a pin outside its range as IGNORED,
// so a 0.2.1 reader meeting a pin of 12 does exactly what 0.2.1 told it to and
// still computes a valid, contiguous sequence. Nothing on disk changes shape.

export const FORMAT_NAME = 'capturepack'
// 0.2.1 carries `number_pin` (SPEC §8.5) — an additive optional field, so a
// PATCH under §13.1's pre-1.0 rules, where minor holds the promises major
// normally would. 0.2.2 widens its range; still a patch, still nothing an older
// reader can be broken by.
//
// No pack this app writes declares it: every one of them uses a 0.3.0-or-later
// field and declares that instead (see exporter.ts). It is the base version the
// format's own history is written against, and §13.1 is why it still moves.
export const FORMAT_VERSION = '0.2.2'
/**
 * The version a pack declares once it carries 0.3 semantics: explicit
 * `capture_kind`/image scope or AUTHORED motion (`keyframes`, SPEC §8.9).
 * These are new optional fields, so MINOR under §13.1's rules.
 *
 * Declared only when a pack actually uses it. SPEC §13.1: "Writers SHOULD write
 * the oldest `format_version` that fully expresses their content," because
 * every unnecessary bump costs the pack an audience of older readers for
 * nothing.
 */
export const FORMAT_VERSION_KEYFRAMES = '0.3.0'
/** Capture backend/quality provenance in media.cadence (SPEC §5.3). */
export const FORMAT_VERSION_CAPTURE_DIAGNOSTICS = '0.4.0'
/** Measured source latency in media.cadence.source_latency (SPEC §5.3). */
export const FORMAT_VERSION_SOURCE_LATENCY = '0.6.0'
/**
 * HOW MANY DISPLAYS STOPS BEING A SPECIAL CASE A READER CAN FORGET TO ASK
 * (#75/#76, SPEC §5.6, §8.2).
 *
 * Through 0.6.0 the format's first-class citizen was ONE monitor:
 * `media.snapshot`/`media.replay` were the capture, and `media.displays` was an
 * optional extra that only a multi-monitor pack carried. A reader that followed
 * the obvious field got half the desk with no signal the rest existed — and
 * worse, `annotations.json` declared ONE `reference_width`/`reference_height`
 * while a box carrying `display: 2` was pixels in a DIFFERENT image. Our own MCP
 * tool descriptions warned about that trap in prose; the format did not say it.
 *
 * 0.7.0 says it:
 *  - `media.displays` is REQUIRED and ALWAYS PRESENT for a video capture. A
 *    single-display capture writes an array of ONE.
 *  - `media.snapshot`/`media.replay` stay, redefined as explicit ALIASES for the
 *    focused entry's files. Their bytes are still never duplicated, so an OLD
 *    reader meeting a 0.7.0 pack still works — which is why this is a minor and
 *    not a major even under §13.1's pre-1.0 rule that minor carries the major
 *    promises. What 0.7.0 binds is WRITERS, not readers.
 *  - Each entry declares `snapshot_width`/`snapshot_height`: the frame the
 *    annotations on that display live in, STATED rather than derived.
 *
 * Declared only by a pack that actually carries the required array (§13.1's
 * "oldest version that fully expresses the content"). An image capture never
 * does — see the media.displays comment below for why it is exempt.
 */
export const FORMAT_VERSION_REQUIRED_DISPLAYS = '0.7.0'

/**
 * How far the recorder's pixels lagged the glass, MEASURED (SPEC §5.3, #115).
 *
 * Not a configured delay and not derived from a frame rate: an independent
 * desktop-exposure reference is matched against decoded source pixels. What it
 * is measured AGAINST is part of the value, so `reference` and `timing` are as
 * required as the number — an operation-completion timestamp is not a pixel
 * exposure, and a bare "37.7" that does not say which one it is cannot be
 * compared with anything.
 */
export interface ManifestSourceLatency {
  measured_ms: number
  reference: 'dxgi-desktop-duplication' | 'windows-gdi-bitblt'
  timing: 'pixel-exposure' | 'post-bitblt-completion'
  confidence?: number
  uncertainty_ms?: number
  /** Absent means the recorder that produced this replay measured it. */
  age_ms?: number
}

/** What the main process remembers, in the shape it remembers it. */
export interface MeasuredSourceLatency {
  latencyMs: number
  confidence: number | undefined
  measuredAtMs: number
  referenceSource: string | undefined
  referenceTiming: string | undefined
  uncertaintyMs: number | undefined
  fromCurrentRecorder: boolean
}

/**
 * The published form of a remembered measurement, or undefined (SPEC §5.3).
 *
 * Undefined rather than a partial object: SPEC §5.3's rule for the cadence
 * this sits in — "a rate nobody measured MUST NOT be reported as a rate" —
 * governs the latency too, and a number that cannot say what it was matched
 * against has not measured one. An operation-completion reference is refused
 * outright: the copied surface may already have been stale by an unobserved
 * amount, so that value is not an exposure latency at all.
 */
export function manifestSourceLatencyFrom(
  remembered: MeasuredSourceLatency,
  nowMs: number,
): ManifestSourceLatency | undefined {
  const { referenceSource, referenceTiming } = remembered
  if (
    referenceSource !== 'dxgi-desktop-duplication' &&
    referenceSource !== 'windows-gdi-bitblt'
  ) {
    return undefined
  }
  if (referenceTiming !== 'pixel-exposure') return undefined
  if (!Number.isFinite(remembered.latencyMs) || remembered.latencyMs < 0) {
    return undefined
  }
  return {
    // One decimal. The matcher's resolution is bounded by the frame interval it
    // sampled; writing 37.69 would claim ten microseconds it never had.
    measured_ms: Math.round(remembered.latencyMs * 10) / 10,
    reference: referenceSource,
    timing: referenceTiming,
    ...(remembered.confidence === undefined || !Number.isFinite(remembered.confidence)
      ? {}
      : { confidence: Math.round(remembered.confidence * 100) / 100 }),
    ...(remembered.uncertaintyMs === undefined
      || !Number.isFinite(remembered.uncertaintyMs)
      || remembered.uncertaintyMs < 0
      ? {}
      : { uncertainty_ms: Math.round(remembered.uncertaintyMs * 10) / 10 }),
    // Absent means this recorder measured it. Present says how much older the
    // evidence is, so a reader is never told a borrowed number is fresh.
    ...(remembered.fromCurrentRecorder
      ? {}
      : { age_ms: Math.max(0, Math.round(nowMs - remembered.measuredAtMs)) }),
  }
}

/** Measured replay cadence written beside the replay it describes (SPEC §5.3). */
export interface ManifestCadence {
  achieved_fps: number
  worst_stall_ms: number
  discarded_frames?: number
  requested_fps?: number
  backend?: 'chromium-desktop-capture' | 'windows-gdi-bitblt'
  quality?: 'full' | 'degraded'
  recorder_count?: number
  source_latency?: ManifestSourceLatency
}

// Per-display media of a video capture (SPEC §5.3, §5.6, GOAL "Multi-Monitor
// Support"). One entry per display frozen by the trigger — INCLUDING a capture
// that froze exactly one, which writes an array of one (0.7.0).
export interface ManifestDisplayMedia {
  // 1-based position in manifest.environment.screens (OS enumeration order).
  index: number
  // "snapshot-d<index>.png" — except the FOCUSED display, whose media IS the
  // top-level media: snapshot === "snapshot.png" (the bytes are never
  // duplicated, so a reader ignoring displays[] still sees the focused one).
  snapshot: string
  // THE FRAME THIS DISPLAY'S ANNOTATIONS LIVE IN, STATED (0.7.0, SPEC §5.6,
  // §8.2). Pixel dimensions of the file named in `snapshot` above.
  //
  // It was always derivable — bounds.width x scale — and derivable is not the
  // same as stated. Every consumer recomputed it, and the arithmetic is not
  // exact: capture rounds with Math.max(1, Math.round(...)) at 1.25x/1.5x, which
  // is why the pack-assertion cross-check had to tolerate +-1 px. A field that
  // was recomputed instead of measured would be stated and still wrong at
  // exactly the scale factors the change exists to get right, so a WRITER MUST
  // populate these from the raster it actually wrote, never from bounds x scale.
  //
  // Named for the file rather than bare width/height because `bounds` sits in
  // the same object with its own width/height in DIP: `snapshot_width` cannot
  // be misread as the DIP one.
  snapshot_width: number
  snapshot_height: number
  // "replay-d<index>.webm", the top-level replay filename on the focused
  // display, or null when this display recorded nothing.
  replay: string | null
  replay_duration_ms?: number
  cadence?: ManifestCadence
  // Milliseconds to add to the pack/focused replay clock to reach this
  // display's replay clock. Observed from the recorders' shared origin clock;
  // optional so pre-0.3 writers remain readable. 0 on the focused entry.
  replay_clock_offset_ms?: number
  // Per-display annotated replay (SPEC §5.6, §7.2): "replay_annotated-d<index>.webm",
  // this display's own replay with ITS OWN annotation boxes rendered into the
  // pixels. Written only for a NON-focused display that actually carries
  // annotations — the focused display's annotated replay is the top-level
  // media.replay_annotated, and a display nobody annotated needs none.
  replay_annotated?: string
  // Per-display annotated stills (SPEC §5.6, §5.7): files under
  // "frames-d<index>/", ordered by t_ms ascending. Same rule as
  // replay_annotated — only a non-focused display with annotations gets them.
  keyframes?: ManifestKeyframe[]
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
  // A KEYFRAME IS TALLER THAN THE FRAME IT SHOWS, AND HAS TO SAY SO (#133).
  //
  // The render grows DOWNWARD to hold the labels of boxes sitting on the bottom
  // edge, rather than moving those boxes or flipping their callouts over what
  // they point at (renderedLabelBottomGutter). The source frame stays at (0, 0)
  // at its original scale, so annotation coordinates drawn straight onto this
  // image are correct — but the image is not the reference frame's size, and
  // the pack never said so. Measured on real packs: 116 px on a 5040x2160 desk,
  // 49 px on a smaller one, 0 when nothing carries text. A reader told the
  // still is "derived from the same pixels" and scaling it to
  // reference_height is wrong by that much.
  //
  // Declared per entry because the gutter depends on how many labels this
  // particular instant has.
  width?: number
  height?: number
}

export interface Manifest {
  format: typeof FORMAT_NAME
  format_version: string
  // Absent only in legacy packs. New writers declare the user's capture intent
  // even when a requested video capture had no usable replay.
  capture_kind?: 'image' | 'video'
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
    // ALIASES FOR THE FOCUSED DISPLAY'S ENTRY, not "the capture" (0.7.0, SPEC
    // §5.3/§5.6). Still REQUIRED, still the same bytes, still what an older
    // reader reads — the redefinition costs no reader anything. What changes is
    // that `displays` below is now the place a reader asks how many screens
    // this pack holds, instead of these two fields quietly implying "one".
    snapshot: string
    replay: string | null
    replay_duration_ms?: number
    cadence?: ManifestCadence
    // The media of EVERY display the trigger froze, focused one included.
    //
    // REQUIRED AND ALWAYS PRESENT for a video capture as of format 0.7.0 (SPEC
    // §5.6): a single-display capture writes an array of ONE rather than
    // omitting it, so "how many displays" is a question every reader asks the
    // same way instead of a special case half of them forget.
    //
    // Optional in the TYPE because this type also describes packs read back off
    // disk, and a pack written before 0.7.0 legitimately has none — SPEC §13.1
    // requires a 0.7.0 reader to accept those and read them as a single-display
    // pack whose one display is the focused one. Same shape, same reason, as
    // `capture_kind?` above.
    //
    // ALWAYS ABSENT for capture_kind "image", at every version. An image pack
    // ships ONE composed raster and no per-display rasters at all — a fullscreen
    // still is every screen stitched into one PNG, a region still is a crop that
    // may straddle two — so there is no per-display frame for an entry to name.
    // `image_scope` is where an image pack answers what its one raster covers.
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
    // Present only for capture_kind "image".
    image_scope?: 'region' | 'fullscreen'
    crop_bounds?: {
      x: number
      y: number
      width: number
      height: number
      coordinate_space: 'virtual-desktop-dip'
    }
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

/** One rectangle the tracked object occupied, at one moment of the pack clock. */
export interface AnnotationTrackSample {
  t_ms: number
  /**
   * Which display these numbers are pixels of — absent = the annotation's own
   * `display`.
   *
   * A window dragged to another monitor is still the same window, so a track
   * follows it there (#86). Each sample therefore says which image it is
   * measured in, and the box moves between screens with the object while every
   * rectangle stays unambiguous. The ANNOTATION's `display` is unchanged by
   * this: it is where the box was drawn, and where a reader that ignores
   * tracking puts it.
   */
  display?: number
  x: number
  y: number
  width: number
  height: number
}

/**
 * One AUTHORED position of a manual box, at one moment of the pack clock
 * (SPEC §8.9). Same shape as an observed sample so every consumer reads it the
 * same way — the difference is which field it lives in, and therefore whether
 * a reader may interpolate.
 */
export interface AnnotationKeyframe {
  t_ms: number
  /**
   * Which display these coordinates are pixels of. Absent means the
   * annotation's own display, exactly like a tracking sample.
   *
   * Authored motion may cross monitors. The display geometry in the manifest
   * supplies the common desktop space used to interpolate between two
   * different native-pixel coordinate systems.
   */
  display?: number
  x: number
  y: number
  width: number
  height: number
}

// Object-tracking state (SPEC §8.3).
//
// THE BOX FOLLOWS THE THING IT NAMES (#86). Until format 0.2.0 this could only
// say `enabled: false`, and a box therefore stayed where the object had been at
// one instant — wrong from the next frame on, with nothing in the pack to say
// so. Measured on a real capture: a picked box held for ten seconds ended up on
// a different window entirely, half a screen away.
//
// `samples` is the object's path: ascending on the pack clock, in the snapshot
// pixels of each sample's own display (SPEC §8.2, §8.8) — which is `bounds`'s
// display unless the sample says otherwise. Every sample is an OBSERVATION:
// between two samples a reader uses the nearer one unchanged and never
// invents an intermediate rectangle. Before/after the sample range the nearest
// endpoint remains the observation for as long as the annotation's lifetime
// says the box exists.
//
// `bounds` REMAINS the box's rectangle at its representative instant, so a
// reader that ignores `tracking` still draws a correct box — which is what lets
// a 0.1.0 reader open a 0.2.0 pack and be right rather than merely tolerant.
export interface AnnotationTracking {
  enabled: boolean
  samples?: AnnotationTrackSample[]
  /**
   * The instant the box MEANS, on the replay clock (SPEC §8.4, #90).
   *
   * A drawn box's representative instant is the midpoint of its lifetime. A
   * PICKED box's is the frame the user was looking at when they clicked, which
   * is not the same number and does not move when the lifetime is edited — so
   * it cannot be derived and has to be recorded. `bounds` is the observed
   * rectangle at this instant, which makes the pair checkable: nearest sample
   * to `picked_at_ms` must be `bounds`.
   */
  picked_at_ms?: number
}

// Semantic object metadata (SPEC §8.3, §8.7): what real UI object the box
// points at. The old "element" annotation concept lives here — a box WITH a
// target is a semantic annotation; there is no separate element type.
//
// `source` is the discriminator. "uia" is the standardized source (see
// UiaAnnotationTarget); providers may add their own additive source shapes.
// Readers ignore sources they do not know and still render the box from
// `bounds`.
export type AnnotationTarget = Record<string, unknown>

/**
 * `target` for source "uia" (SPEC §8.7): a Windows UI Automation object the
 * user picked in the editor, from the capture-instant dump in
 * plugins/windows-uia/ (GOAL "Static object picking (v0 — before full
 * tracking)"). Every field but `source` is omitted when the object had no
 * value for it — an empty string is never written.
 *
 * `level` says WHICH object: a control inside a window, or the window itself.
 * The window level is the guaranteed floor of picking (GOAL: "windows are
 * always selectable"), so it is a first-class target, not a degraded control.
 */
export type UiaAnnotationTarget = {
  source: 'uia'
  // "control" = a control from a window's UI Automation tree; "window" = the
  // top-level window itself. Absent on targets written before the window level
  // existed, which were always controls.
  level?: 'control' | 'window'
  // UIA Name — what the user sees (also the box's pre-filled text). Controls.
  name?: string
  // UIA ControlType without the "ControlType." prefix, e.g. "Button". Controls.
  control_type?: string
  // UIA AutomationId — the stable, non-localized id when the app provides one.
  automation_id?: string
  // Win32 window class, e.g. "Chrome_WidgetWin_1" — of the control, or of the
  // window at level "window".
  class_name?: string
  // Window title at the capture instant (level "window").
  title?: string
  // Process name without extension, e.g. "chrome" (level "window").
  process?: string
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

/**
 * How much of ONE window's control tree the dump ended up with (SPEC §11.3).
 * This is what lets a reader distinguish "this window has no objects" from "no
 * object data was collected for this window" — the honest answer for a window
 * the budget never reached, and for the Chromium/Electron windows that expose
 * no usable tree at all.
 */
export type UiaTreeStatus =
  // The whole control tree was collected.
  | 'collected'
  // The walk started but hit the budget, the depth cap, or the element cap.
  | 'truncated'
  // The walk was attempted and the window exposed no tree.
  | 'unavailable'
  // The window was never walked (past the window cap, or out of budget).
  | 'skipped'

/** One top-level window that existed at the capture instant. */
export interface UiaWindowRecord {
  // Native HWND as an unsigned decimal string. It is the only identity both
  // the capture-instant dump and the temporal surface lane directly observe.
  // Absent on payloads written before windows-uia 0.3.0.
  hwnd?: string
  title: string
  // Process name without extension, e.g. "chrome". '' when unavailable.
  process: string
  // Win32 window class, e.g. "Chrome_WidgetWin_1". '' when unavailable.
  class_name: string
  // WHICH captured display `bounds` is expressed in (SPEC §11.3, payload
  // 0.3.0) — the 1-based manifest.media.displays[].index, exactly the rule
  // annotations follow (SPEC §8.8). ABSENT = the focused display, which is what
  // a single-display pack and every window on the focused screen write, so a
  // 0.2.0 payload reads unchanged. A window is placed on the display it mostly
  // covers, and its controls are always in the SAME space as their window.
  display?: number
  bounds: UiaBounds
  // Exactly the window that had focus; false for every other window. A dump
  // that could not determine the foreground window has no focused entry.
  focused: boolean
  // Z-order index at the capture instant: 0 is the top-most window. What
  // decides which window covers a pixel when several overlap.
  z: number
  // Whether this window's control tree made it into `elements` — see above.
  tree: UiaTreeStatus
  // How many of `elements` belong to this window (0 for every status but
  // "collected"/"truncated").
  element_count: number
}

/** One control of a window's UI Automation tree. */
export interface UiaElementRecord {
  name: string
  control_type: string
  automation_id: string
  class_name: string
  // The captured display `bounds` is expressed in — same rule as the window
  // record above (SPEC §11.3, payload 0.3.0), and ALWAYS the display of the
  // window this control was walked from: a control and its window must be
  // pickable in one coordinate space or the window can never own it.
  display?: number
  bounds: UiaBounds
  // 0 = the window this control belongs to; a pre-order walk of its control view.
  depth: number
  // Index into `windows` of the window this control was walked from. -1 when
  // the dump did not say (a pack written before the dump covered more than the
  // foreground window).
  window: number
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
  // Web-content roots the walk REFUSED, because they were still measuring
  // themselves against a display their window had already left (payload 0.4.0).
  // A browser paints pages in a renderer carrying its own device scale factor;
  // move the window between displays of different scales and the frame re-lays
  // out while the renderer can still answer in the old one's coordinates. Such
  // rectangles land on the neighbouring thing, so they are dropped.
  //
  // Nonzero is a claim with teeth: those windows HAVE controls that this pack
  // cannot point at, which is a different statement from a page that exposed
  // none. Readers must not present a refused window as controlless.
  geometry_refused?: number
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
  // WHICH captured display this box was drawn on (SPEC §8.8, GOAL
  // "Multi-Monitor Support"): the 1-based manifest.media.displays[].index.
  // ABSENT = the focused display, which is what a single-display pack (and
  // every box drawn on the focused screen) writes — so nothing about an
  // existing pack changes. `bounds` is always in THAT display's snapshot pixel
  // space, never the board's.
  display?: number
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
  /**
   * The number the USER assigned this box — an integer >= 1 (SPEC §8.5).
   * Absent = it numbers automatically, in creation order, around the boxes that
   * carry one.
   *
   * NAMED `number_pin`, NOT `display_number`, and the name is the design. §8.5's
   * invariant is that display numbers are computed and never stored, and that
   * stays literally true: this is an INPUT to the rule, not its output. A reader
   * that ignores this field computes numbers the old way and still gets a valid,
   * self-consistent pack — which is exactly what §13.1 asks of an unknown
   * optional field.
   *
   * IT IS A CLAIM ON A SLOT, NOT A NUMBER STAMPED ON THE BOX. Numbering stays
   * contiguous from 1 whatever this says (#51), so a pin above the number of
   * numbered boxes claims the last slot rather than inventing a ⑤ the pack has
   * no ①-④ for.
   *
   * Only meaningful with `numbered: true`; a pin on an unnumbered box is inert
   * rather than an error, so a foreign writer's inactive pin cannot corrupt the
   * sequence. THIS EDITOR does not leave one behind: turning numbering off
   * releases the number (#51), and turning it back on assigns the next one,
   * because a user who re-numbers a box has just asked for it at the end.
   */
  number_pin?: number
  // Whether the interior is blurred in RENDERED views only (SPEC §9): the
  // original snapshot.png and replay are never modified.
  blur: boolean
  tracking: AnnotationTracking
  /**
   * AUTHORED motion for a MANUAL box (SPEC §8.9) — where the user put it, at
   * the moments they put it there.
   *
   * NOT `tracking.samples`, and the separation is the whole point. A tracked
   * box's samples are OBSERVATIONS of a real window, and SPEC §8.3 forbids
   * interpolating between them in as many words: an interpolated rectangle is
   * a position the object never occupied, written in the same numbers as a
   * measured one. That rule was reaffirmed by decision this release after
   * interpolation shipped once and was measured worse ("보간하면 안되지").
   *
   * These are a different kind of claim. A user placing the box at 100 ms and
   * again at 400 ms is not reporting where anything WAS — they are saying
   * where their own annotation should be at those two moments, and the path
   * between is the annotation's presentation, not a statement about the world.
   * So these DO interpolate, and putting them in a separate field is what makes
   * that safe: no reader can mistake one for the other, and the observed path's
   * drawing rule cannot be changed by anything done here.
   *
   * A box that never moved at a second moment has NONE of these — a single
   * authored position carries no motion and is just `bounds`, which is why the
   * editor collapses a lone keyframe away. Ascending on the pack clock.
   * `bounds` stays the rectangle at the box's representative instant, so a
   * reader that ignores this field still draws the box correctly (§8.3's rule
   * for `tracking`, applied to the same purpose).
   */
  keyframes?: AnnotationKeyframe[]
  target?: AnnotationTarget
  style?: AnnotationStyle
  created_at: string
  z: number
}

export type Annotation = BoxAnnotation

export interface AnnotationsFile {
  /**
   * THE FOCUSED DISPLAY'S FRAME — not the pack's, and not the desk's (SPEC
   * §8.1, §8.2).
   *
   * There is exactly one of these and there are N displays, so it cannot be
   * "the coordinate space" of a multi-display pack. It is the pixel size of
   * `snapshot.png`, which is the focused display's snapshot and the frame every
   * box that carries NO `display` field is read against. A box that DOES carry
   * one is pixels in THAT display's snapshot, whose size its
   * `media.displays[]` entry now states (`snapshot_width`/`snapshot_height`).
   *
   * Reading a `display: 2` box against these numbers puts it on the wrong
   * screen at coordinates that mean nothing — the trap #75 was filed for.
   */
  reference_width: number
  reference_height: number
  annotations: Annotation[]
}

// Display numbers are computed, never stored (SPEC §8.5): every consumer — the
// editor canvas, the annotated-replay renderer, report.md, README.md, skills/
// documents, MCP responses — MUST derive them from this one function so video
// numbers and document numbers can never differ.
//
// THE ORDER IS ASSIGNMENT ORDER (#51), and for a box nobody has re-numbered
// that is creation order — the sequence below. It used to be timeline order;
// sorting by `start_ms` first meant a box drawn LAST but scrubbed back to an
// earlier frame took number 1 and renumbered everything made before it, reported
// as "버튼 숫자도 버그가 있네 마지막에 누른게 뒤로 가야지". A number is how a
// person refers to the boxes THEY made, in the order they made them; where a box
// happens to sit on the replay clock is a different question, and the documents
// already answer it by printing each box's time beside its number.
//
// Creation order alone cannot express a RE-assignment, though, and that is what
// `number_pin` is for. Turning a box's number off and on again is the user
// saying "this one, now, at the end"; `created_at` is as fixed as the `start_ms`
// it replaced, so the app used to slide the box back into the middle of the
// sequence and overrule them. What the user assigned is written down instead —
// see nextDisplayNumber and planNumberPins below, which is where the editor
// turns an assignment into pins.
//
// `created_at` is parsed to an instant rather than compared as text: it carries
// a UTC offset (SPEC §8.3), so "…T18:22+09:00" and "…T10:22+01:00" are the same
// moment and lexicographic order would put them in the wrong sequence. A box
// with no parseable `created_at` — an externally written pack — sorts AFTER
// every box that has one and falls back to the old z / array-position / id
// chain, so such a pack numbers exactly as it always did.
//
// CONTIGUOUS FROM 1, ALWAYS. N numbered boxes carry exactly the numbers 1..N —
// no gaps, no duplicates, whatever the pins ask for. Everything below only
// decides WHICH box holds which number. A rule that could leave a hole would
// have the documents cite a ④ that no frame of the video contains, and a reader
// has no way to tell which of the two lied.
//
// PINS. `number_pin` is the number a box was ASSIGNED — an integer >= 1, an
// input to this rule. It claims a SLOT:
//
//  - A PIN NEVER LEAVES A GAP. A pin above the count claims the last slot: pin
//    the only box to 5 and it is ①, because 5 is not a number this pack has.
//    (0.2.1 let a pin leave a gap. #51 made contiguity absolute — a lone ⑤ with
//    no ①-④ was the counter-example that settled it.)
//  - AUTOMATIC BOXES FILL WHAT IS LEFT, in creation order, around the pins.
//  - TWO BOXES CLAIMING ONE SLOT: the earlier-created keeps it; the other takes
//    the nearest free slot, searching upward first. This editor never writes
//    that state — typing a number PUSHES the box that held it along, and stores
//    the result (planNumberPins) — so this is the rule for a pack written by
//    something else, where all it has to be is contiguous and the same twice.
//
// Returns annotation_id -> display number; unnumbered boxes are absent.

/** The slot a box claims: an integer >= 1, or null when it numbers automatically. */
function pinOf(a: Annotation): number | null {
  const raw = a.number_pin
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) return null
  return raw
}

/** The numbered boxes in creation order — the sequence described above. */
function numberedInCreationOrder(annotations: readonly Annotation[]): Annotation[] {
  const numbered = annotations
    .map((a, index) => ({ a, index }))
    .filter(({ a }) => a.numbered)
  numbered.sort((p, q) => {
    const pAt = Date.parse(p.a.created_at)
    const qAt = Date.parse(q.a.created_at)
    const pDated = Number.isFinite(pAt)
    const qDated = Number.isFinite(qAt)
    // A known creation moment beats an unknown one; among known ones, earlier
    // first. Undated boxes keep the ordering they have always had.
    if (pDated !== qDated) return pDated ? -1 : 1
    if (pDated && qDated && pAt !== qAt) return pAt - qAt
    const pZ = typeof p.a.z === 'number' ? p.a.z : p.index
    const qZ = typeof q.a.z === 'number' ? q.a.z : q.index
    if (pZ !== qZ) return pZ - qZ
    return p.a.annotation_id < q.a.annotation_id
      ? -1
      : p.a.annotation_id > q.a.annotation_id
        ? 1
        : 0
  })
  return numbered.map(({ a }) => a)
}

export function computeDisplayNumbers(
  annotations: readonly Annotation[],
): Map<string, number> {
  const ordered = numberedInCreationOrder(annotations)
  const total = ordered.length
  // As many slots as boxes: that is where contiguity comes from, not from a
  // rule anyone has to remember to apply.
  const slots: Array<Annotation | null> = new Array<Annotation | null>(total).fill(null)
  // Pass 1: the slots the pins claim. Ascending pin, and sort is stable, so
  // boxes claiming the same slot arrive in creation order.
  const pinned = ordered
    .filter((a) => pinOf(a) !== null)
    .sort((p, q) => (pinOf(p) ?? 0) - (pinOf(q) ?? 0))
  for (const a of pinned) {
    const want = Math.min(pinOf(a) ?? 1, total)
    let i = want - 1
    while (i < total && slots[i] != null) i += 1
    // Taken all the way up: fall back DOWN from the claim. There is always a
    // free slot below, because there are exactly as many slots as boxes.
    if (i >= total) {
      i = want - 1
      while (i >= 0 && slots[i] != null) i -= 1
    }
    if (i >= 0 && i < total) slots[i] = a
  }
  // Pass 2: everyone else fills the gaps, ascending, in creation order.
  let free = 0
  for (const a of ordered) {
    if (pinOf(a) !== null) continue
    while (free < total && slots[free] != null) free += 1
    if (free < total) slots[free] = a
  }
  const numbers = new Map<string, number>()
  for (let i = 0; i < total; i += 1) {
    const a = slots[i]
    if (a != null) numbers.set(a.annotation_id, i + 1)
  }
  return numbers
}

/**
 * The number a box takes the moment its numbering is turned ON: the next one
 * (SPEC §8.5, #51).
 *
 * The defect this exists to stop: "turning a box's number off and back on
 * returns it to the middle of the sequence". Nothing in the pack could say
 * otherwise — `created_at` is as fixed as the `start_ms` it replaced — so the
 * app kept re-inserting a box the user had just re-assigned, which reads as
 * the app overruling them. `id` is excluded from the count so this answers the
 * same whether the caller has already flipped `numbered` or not.
 */
export function nextDisplayNumber(annotations: readonly Annotation[], id: string): number {
  let others = 0
  for (const a of annotations) {
    if (a.numbered && a.annotation_id !== id) others += 1
  }
  return others + 1
}

/** A copy of the numbered boxes carrying `pins` instead of their stored ones. */
function withPins(
  ordered: readonly Annotation[],
  pins: ReadonlyMap<string, number>,
): Annotation[] {
  return ordered.map((a) => {
    const copy: Annotation = { ...a }
    const pin = pins.get(a.annotation_id)
    if (pin === undefined) delete copy.number_pin
    else copy.number_pin = pin
    return copy
  })
}

/**
 * The pins to STORE so that box `id` shows display number `wanted` — the whole
 * of "let the user type a number" (SPEC §8.5, #51).
 *
 * Typing a number another box holds PUSHES that box along: the answer is
 * today's order with `id` lifted out and dropped in at `wanted`, everyone it
 * displaced shifted by one, and no box that was not displaced moving at all.
 * That order is then expressed as pins — computed by asking the rule above what
 * it would do and pinning only the boxes it would put somewhere else, so a pack
 * carries the user's decisions and not a pin on every box restating what
 * creation order already said.
 *
 * `annotations` is the state the user is LOOKING AT — the box need not be
 * numbered in it yet, and the plan is for the state where it is. That is not a
 * convenience: the sequence being rearranged is the one on screen, and a box
 * that has just been given a number was not part of it a moment ago. Ask over
 * the after-state instead and the boxes AROUND the new one shuffle, because a
 * pin means a different slot in a sequence one longer.
 *
 * Returns annotation_id -> pin for every box whose STORED pin has to change —
 * apply them all in one edit, they are one decision.
 */
export function planNumberPins(
  annotations: readonly Annotation[],
  id: string,
  wanted: number,
): Map<string, number> {
  const after = annotations.map((a) =>
    a.annotation_id === id && !a.numbered ? { ...a, numbered: true } : a,
  )
  const ordered = numberedInCreationOrder(after)
  const total = ordered.length
  const changes = new Map<string, number>()
  const target = ordered.find((a) => a.annotation_id === id)
  if (target === undefined) return changes
  const slot = Math.min(Math.max(Math.trunc(wanted), 1), total)

  // The order being asked for: the sequence ON SCREEN with `id` taken out and
  // put back at `slot`. Everything it steps over shifts by one; everything else
  // stays exactly where the user last saw it.
  const now = computeDisplayNumbers(annotations)
  const desired = ordered
    .filter((a) => a.annotation_id !== id)
    .sort((p, q) => (now.get(p.annotation_id) ?? 0) - (now.get(q.annotation_id) ?? 0))
  desired.splice(slot - 1, 0, target)

  // Start from the pins the boxes already carry, then add one at a time — each
  // pin can fix several boxes at once, and pinning a box that was already going
  // to land there would write noise into the pack. The box being assigned gets
  // no head start for exactly that reason: numbering a box that is already going
  // to be ③ must leave the pack byte-identical.
  const pins = new Map<string, number>()
  for (const a of ordered) {
    const pin = pinOf(a)
    if (pin !== null) pins.set(a.annotation_id, pin)
  }
  // THE BOX THE USER TOUCHED IS PINNED FIRST, and that is what keeps the pack
  // small: pinning it usually settles every other box at once, while starting
  // from the top of the sequence would pin everything AROUND it instead and
  // store four decisions where the user made one.
  const places = desired.map((a, i) => ({ a, want: i + 1 }))
  const toFix = [
    ...places.filter(({ a }) => a.annotation_id === id),
    ...places.filter(({ a }) => a.annotation_id !== id),
  ]
  // Bounded by construction: every pass pins one more box to the number it is
  // supposed to have and never revisits it, and a full set of distinct pins
  // reproduces the order exactly.
  for (let pass = 0; pass <= total; pass += 1) {
    const got = computeDisplayNumbers(withPins(ordered, pins))
    let fixed = false
    for (const { a, want } of toFix) {
      if (got.get(a.annotation_id) === want) continue
      if (pins.get(a.annotation_id) === want) continue
      pins.set(a.annotation_id, want)
      fixed = true
      break
    }
    if (!fixed) break
  }

  for (const a of ordered) {
    const after = pins.get(a.annotation_id)
    if (after !== undefined && after !== pinOf(a)) changes.set(a.annotation_id, after)
  }
  return changes
}

/**
 * WHICH display a box belongs to (SPEC §8.8): its `display` when it carries
 * one, the FOCUSED display's index otherwise. Absent is the default because
 * that is what a single-display pack — and every box drawn on the focused
 * screen — writes, so nothing about an existing pack changes.
 *
 * A non-integer or out-of-range value is treated as absent: the box then still
 * renders, on the focused display, instead of being silently dropped.
 *
 * "Out of range" needs the declared display set to be knowable, so a caller
 * that has one passes it as `declared` (built from manifest.media.displays with
 * declaredDisplayIndices()). A value the pack does not declare then resolves to
 * `focusedIndex` — exactly what the editor already draws (editor.ts displayOf)
 * and what this comment has always promised. WITHOUT the set only the shape is
 * checked, which is all a caller that has no manifest can honestly do.
 */
export function annotationDisplayIndex(
  a: Annotation,
  focusedIndex: number,
  declared?: ReadonlySet<number>,
): number {
  const value = a.display
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return focusedIndex
  if (declared !== undefined && !declared.has(value)) return focusedIndex
  return value
}

/** The boxes of ONE display, in array order (SPEC §8.8). */
export function annotationsOnDisplay(
  annotations: readonly Annotation[],
  index: number,
  focusedIndex: number,
  declared?: ReadonlySet<number>,
): Annotation[] {
  return annotations.filter((a) => {
    if (annotationDisplayIndex(a, focusedIndex, declared) === index) return true
    // A TRACKED BOX BELONGS TO EVERY SCREEN ITS OBJECT VISITS (#86). The window
    // was dragged onto this display, so this display's rendering has to carry
    // the box — otherwise the video of the screen the window moved TO is the
    // one view of the capture where the annotation is missing. Each renderer
    // still draws it only while the resolved sample is on its own screen.
    return (
      a.tracking?.enabled === true &&
      (a.tracking.samples ?? []).some((s) => s.display === index)
    ) || (a.keyframes ?? []).some((frame) => frame.display === index)
  })
}

/**
 * The display indices a pack DECLARES (manifest.media.displays[].index), for
 * annotationDisplayIndex()/annotationsOnDisplay(). `undefined` for a pack that
 * declares no per-display media — a pack older than 0.7.0, or an image pack.
 * SPEC §13.1 makes those a single-display pack whose one screen is the focused
 * one: every box is on it, so there is no set to check against.
 */
export function declaredDisplayIndices(
  displays: readonly ManifestDisplayMedia[] | undefined,
): ReadonlySet<number> | undefined {
  if (!Array.isArray(displays) || displays.length === 0) return undefined
  const indices = new Set<number>()
  for (const d of displays) {
    if (d !== null && typeof d === 'object' && typeof d.index === 'number') indices.add(d.index)
  }
  return indices
}

/**
 * The 1-based index of the pack's FOCUSED display, i.e. the display
 * snapshot.png and every `display`-less annotation belong to. 1 for a pack that
 * declares no per-display media — a pre-0.7.0 or image pack, which SPEC §13.1
 * says to read as one display, and that one display is the focused one.
 */
export function focusedDisplayIndex(displays: readonly ManifestDisplayMedia[] | undefined): number {
  if (!Array.isArray(displays)) return 1
  const focused = displays.find((d) => d !== null && typeof d === 'object' && d.focused === true)
  return typeof focused?.index === 'number' ? focused.index : 1
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
/** Explicit still-image/region capture; independent from the replay hotkey. */
export const DEFAULT_IMAGE_CAPTURE_HOTKEY = 'Ctrl+Alt+S'
/**
 * Supported recorder request range. The achieved rate is recorded separately.
 * Persisted 1..4 fps profiles are legacy input and normalize to this floor.
 */
export const MIN_CAPTURE_FPS = 5
export const MAX_CAPTURE_FPS = 30

/** Normalizes persisted or patched recorder requests onto the supported grid. */
export function normalizeCaptureFps(value: unknown, fallback = 15): number {
  const clamp = (fps: number): number =>
    Math.min(MAX_CAPTURE_FPS, Math.max(MIN_CAPTURE_FPS, Math.round(fps)))
  const safeFallback =
    typeof fallback === 'number' && Number.isFinite(fallback) && fallback > 0
      ? clamp(fallback)
      : 15
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? clamp(value)
    : safeFallback
}

/**
 * Schema version of settings.json (GOAL "Multi-Monitor Support"). Stamped into
 * every profile the app writes; a profile WITHOUT it predates versioning, which
 * is what one-time migrations key off (see main/settings.ts migrateSettings).
 * Bump only when a stored value has to be reinterpreted, never for a new key —
 * an unknown key already falls back to its default.
 */
export const SETTINGS_VERSION = 2

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

export type ClipboardAfterSave = 'off' | 'folder' | 'path' | 'prompt'
export type ImageClipboardAfterSave = ClipboardAfterSave | 'image'

export interface Settings {
  // Schema version of this profile (SETTINGS_VERSION). Absent in a file written
  // before versioning existed — the ONE signal a one-time migration may use.
  // The app stamps the current version on every load, so a migration runs at
  // most once and a later deliberate choice is never second-guessed.
  settingsVersion: number
  // UI language: "system" (default — app.getLocale() at runtime) or a
  // supported language code from shared/i18n.ts (en/ko/ja/zh/es/fr/de/pt/ru).
  language: string
  // Pack document language (README/report/skills templates): "ui" (default —
  // follow the resolved UI language) or a supported language code.
  packLanguage: string
  autoUpdateCheck: boolean
  // Per-user Windows login item (GOAL "Start with Windows, by default.").
  // Fresh profiles opt in; the Settings > General toggle applies immediately.
  launchAtLogin: boolean
  // Show the once-per-launch "replay is ready" tray notification. Recorder
  // failures are always announced and are deliberately not controlled by it.
  notifyOnRecordingStart: boolean
  // The always-on replay buffer itself (GOAL "Replay Buffer"). OFF stops the
  // recorders and the hotkey answers with a notification instead of a capture
  // — a privacy switch, not a pause: nothing is recorded while it is off, so
  // there is nothing a capture could show. ON is the product's default state.
  recordingEnabled: boolean
  outputDir: string
  // WHAT lands on the clipboard the moment a pack is saved (GOAL "Folder-first
  // export"). Was a boolean; a boolean could only answer "the folder", and the
  // thing most often wanted next is not the folder — it is the sentence that
  // hands the folder to an LLM.
  //   "off"    nothing
  //   "folder" the folder itself, to paste into a chat or a file manager
  //   "path"   its path as text
  //   "prompt" the ready-made "Analyze the CapturePack at <path>..." sentence
  clipboardAfterSave: ClipboardAfterSave
  // Image capture has its own post-save action. "image" waits for the derived
  // annotated PNG (box/text/blur included) and copies that result; it never
  // substitutes the unannotated snapshot when rendering fails.
  imageClipboardAfterSave: ImageClipboardAfterSave
  // The first-launch welcome window has been shown (GOAL "Welcome (first launch
  // after install)"): written the moment the window opens, so it appears once
  // and never again on its own. Showing it is gated on a genuinely fresh
  // install (or a fresh profile deferred by a hidden login launch) AND this
  // flag — an update, which has neither fresh signal, never shows it. About's
  // "Show welcome again" re-opens it on demand.
  welcomeShown: boolean
  // A genuinely fresh profile was first created by a hidden login launch. The
  // next manual launch consumes this marker and shows the welcome without ever
  // exposing a window at boot.
  welcomeDeferredFromLogin: boolean
  // Global capture accelerator in Electron syntax, e.g. "Ctrl+Alt+C" (default
  // DEFAULT_CAPTURE_HOTKEY). At least one modifier plus exactly one key; an
  // unusable value falls back to the default when settings load.
  captureHotkey: string
  // Explicit still-image capture accelerator. It opens the region selector
  // without reading or stopping the replay recorder and must never alias the
  // video accelerator.
  imageCaptureHotkey: string
  replaySeconds: number
  fps: number
  // Longest edge of the continuously recorded replay stream in pixels.
  // 0 keeps the display's native resolution; otherwise 720..3840. The native
  // snapshot is captured separately and is never affected by this setting.
  replayMaxWidth: number
  // Capture display (GOAL "Multi-Monitor Support"):
  //  - "all" (DEFAULT) — the trigger freezes EVERY connected display; the pack
  //    carries per-display media (manifest.media.displays) and the display
  //    under the cursor becomes the focused one.
  //  - "cursor" — record every display, but keep only the cursor display.
  //  - "<displayId>" — an Electron display id as a string (fixed display; one
  //    encoder, lowest CPU).
  // "all" and "cursor" run the same recorder set, so "all" costs export work,
  // not capture work.
  captureDisplay: string
  // Windows UI Automation object picking (GOAL "Static object picking (v0)",
  // issue #57). ON by default — it is what left click picks real buttons and
  // windows with. Turning it OFF must genuinely stop the helper spawn, not grey
  // a row out: the dump costs a sub-second PowerShell process on EVERY capture,
  // which is exactly why the user is allowed to decline it. Off means captures
  // carry no plugins/windows-uia/ and picking falls back to manual boxes.
  uiaEnabled: boolean
  // Chrome DOM temporal context. OFF closes the local bridge and clears its
  // replay ring immediately; ON reopens it and lets an existing native host
  // reconnect without reloading the browser page.
  chromeDomEnabled: boolean
  scrubInvert: boolean
  scrubSensitivityMs: number
  // Default lifetime duration (ms) stamped on manual annotations in the editor.
  defaultManualDurationMs: number
  // Show the duration chip on the selected annotation in the editor.
  showDurationLabel: boolean
  // Shortcut overlay (GOAL "Editor Chrome"): the editor's `?` / F1 panel is ON
  // BY DEFAULT, so a new user sees the whole vocabulary without asking. The
  // editor writes this back whenever the user toggles it, so turning it off is
  // permanent until turned back on.
  showShortcutOverlay: boolean
  // First-run tutorial (GOAL "First-Run Tutorial"): the toolless editor has no
  // tool palette to read, so it explains its three gestures once. ON for a new
  // user; [Got it] with "Don't show again" left checked turns it off for good,
  // and Settings -> General turns it back on. Never blocks the five-second
  // workflow more than once.
  showEditorTutorial: boolean
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
