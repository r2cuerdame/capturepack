// The Temporal Context Provider protocol (issue #64) and the Platform Surface
// Timeline's public shapes (issue #65).
//
// THIS FILE IS THE API. Everything an external provider is allowed to know about
// CapturePack is declared here, and everything CapturePack knows about a
// provider is one of these calls. GOAL.md > "Plugin System, redesigned (v0.2.0)"
// makes that a hard rule and names the failure it prevents:
//
//   > Windows UI Automation is the reference implementation of the Provider
//   > protocol. It consumes the same public API an external Provider gets — the
//   > same clock, the same surface claims, the same hitTest, the same timeouts,
//   > the same failure isolation. It gets no private path into Core.
//
// So if the built-in Windows provider ever needs something that is not in this
// file, that is A GAP IN THE PROTOCOL to be closed for every provider — never a
// private hook. A plugin API whose most important consumer does not use it is
// decorative, and we would find that out years later from someone else's bug
// report.
//
// STATUS: DOCUMENTED AND EXPLICITLY UNSTABLE (issue #64). It will change,
// `protocolVersion` is checked strictly, and an incompatible plugin is refused
// with a clear message rather than half-working. It goes to v1 with a
// compatibility promise at whichever comes first — a provider we did not write
// running in the wild, or the first serious external request to build one.
// Until then: design for correctness, not backward compatibility.
//
// THE TWO RULES THE SIGNATURES DO NOT CARRY, both from GOAL.md and both on the
// "explicitly NOT how this gets built" list when broken:
//
//  1. `onTick` is NOT an order to snapshot. It hands the provider the current
//     monotonic time; the provider decides whether that instant is worth
//     sampling. Core requiring a full tree per tick ("Forcing a full DOM/UI tree
//     copy per frame") is prohibited, and it is also unaffordable: a measured
//     full UI Automation desktop checkpoint costs 183.8 ms, so sampling one at
//     10 Hz would be 184% of a CPU core — against an app that costs 26.3% of one
//     core in total (docs/temporal-protocol.md §1).
//  2. `materialize()` PREPARES state at a time; it does not ship the structure
//     to the UI. Selection goes through `hitTest()`/`frame()`, which return only
//     the candidates at a point or in a rectangle.
//
// AND THE RULE `TemporalAccuracy` EXISTS FOR (GOAL.md, "Approximate, but never
// silently"): a provider that cannot produce the exact requested instant returns
// its nearest sample TOGETHER WITH THE ERROR. An answer 80 ms off is useful; an
// answer 80 ms off that claims to be exact is the same class of lie as a tray
// icon that says "recording".

/**
 * The protocol version this build speaks. A manifest declaring anything else is
 * REFUSED — see `isSupportedProtocolVersion`.
 *
 * Strictness is deliberate (#64): a half-working provider produces "CapturePack
 * picked the wrong thing", which the user blames us for and we cannot fix. A
 * refusal names the plugin and the version it wanted.
 */
export const CONTEXT_PROTOCOL_VERSION = '1'

/**
 * Exactly what it says: this build speaks one version. There is no compatibility
 * range yet, because there is nothing to be compatible with — the first external
 * provider is what turns this into a range (#64's stabilisation trigger).
 */
export function isSupportedProtocolVersion(version: string): boolean {
  return version === CONTEXT_PROTOCOL_VERSION
}

// ---------------------------------------------------------------------------
// Geometry — and the one thing the design document had to add to it
// ---------------------------------------------------------------------------

/**
 * A rectangle in VIRTUAL-DESKTOP PHYSICAL PIXELS.
 *
 * The coordinate space is part of the type's meaning and is normative
 * (docs/temporal-protocol.md GAP 10). Nothing in the protocol as first written
 * declared a space, and the two official providers do not agree by default:
 * Chrome reports CSS/DIP pixels, Windows UI Automation reports whatever space
 * its process was DPI-virtualized into, and the Surface Timeline reads physical
 * pixels. One of them had to be normative and the cheapest, least fakeable one
 * wins — the Surface Timeline's, because it is produced by a deliberately
 * per-monitor-DPI-aware process (see scripts/context-host.ps1).
 *
 * PROVIDERS CONVERT INTO THIS SPACE. Core maps from it into one display's
 * snapshot pixels (SPEC §8.2) when a pack is written, using the per-display
 * affine transform — the mapping that must be available to EVERY provider, not
 * trapped inside the built-in one.
 */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** A point in the same space as `Rect`. */
export interface ScreenPoint {
  x: number
  y: number
}

/**
 * The monotonic session clock Core hands out (GOAL.md "One clock").
 *
 * Every provider event is timestamped against this and never against the
 * provider's own wall clock, or "the semantic timeline drifts from the visual
 * one and every answer is subtly wrong". Replay frame time, DOM event time, UIA
 * event time, window z-order time and annotation time are all comparable on this
 * one `timeMs`.
 *
 * `nowMs` counts from session start and NEVER from an epoch: it is read from a
 * monotonic source, so a clock change, an NTP step or DST cannot move a sample
 * that already happened.
 */
export interface CaptureClock {
  sessionId: string
  nowMs: number
  /** Oldest time still retained. Rises as the ring prunes. */
  bufferStartMs: number
  /** Newest time observed. Equals `nowMs` while the buffer is live. */
  bufferEndMs: number
}

/**
 * WHY the requested instant and the answered instant differ, when they do.
 *
 * `errorMs` alone cannot distinguish "80 ms off" from "25 seconds off because
 * this pack only ever recorded one moment" (GAP 16), and those two answers
 * deserve completely different treatment in the UI: the first is offered, the
 * second is refused. `coverage` is the verdict; Core additionally enforces a
 * staleness ceiling and refuses to offer a candidate past it.
 */
export type TemporalCoverage =
  /** A sample at or near the requested time genuinely exists. */
  | 'covered'
  /** The requested time is older than anything this provider ever buffered. */
  | 'before-start'
  /** It existed and was dropped by retention (`onPrune`). */
  | 'pruned'
  /** Covered, but at reduced resolution — the governor or a memory budget cut it. */
  | 'degraded'
  /** This provider only ever described one instant (a v0.1.x pack, §10.1). */
  | 'single-instant'
  /** Nothing to offer at this time at all. */
  | 'none'

/** Mandatory on every temporal answer. See the file header. */
export interface TemporalAccuracy {
  requestedTimeMs: number
  materializedTimeMs: number
  /** `materializedTimeMs - requestedTimeMs`, absolute, INCLUDING measured cross-process clock error. */
  errorMs: number
  /** True only when the provider actually holds the requested instant. */
  exact: boolean
  coverage: TemporalCoverage
}

// ---------------------------------------------------------------------------
// Surfaces — the Platform Surface Timeline's vocabulary (#65)
// ---------------------------------------------------------------------------

/**
 * The authority ladder (GOAL.md). Authority is SPECIFICITY, not rank: a DOM
 * element is a more specific answer than the window that contains it, which is
 * why an Unreal widget beats a DOM element beats a UIA element beats an HWND.
 * "manual rectangle" is the editor's fallback and is not a provider authority.
 */
export type SurfaceAuthority = 'application-native' | 'document-native' | 'accessibility' | 'window'

/** Most specific first — index IS the ordering key (#66 criterion 3). */
export const AUTHORITY_ORDER: readonly SurfaceAuthority[] = [
  'application-native',
  'document-native',
  'accessibility',
  'window',
]

/**
 * One top-level window as the Surface Timeline recorded it at one instant (#65).
 *
 * This is Core's record and NOT a UI tree: it answers exactly one question —
 * which top-level window was where, in what order, at time T — and must not grow
 * into a UI Automation interpreter. Core does not interpret an Unreal, a Unity
 * or a UIA object tree.
 */
export interface SurfaceInfo {
  /**
   * Core-minted and STABLE ACROSS THE SESSION, not per sample.
   *
   * It is not the HWND: Windows recycles handles, and a provider's claim keyed
   * on a recycled handle would silently inherit a dead window's identity. The id
   * carries a creation ordinal so a reused HWND becomes a new surface.
   */
  surfaceId: string
  /** Decimal string: an HWND exceeds Number.MAX_SAFE_INTEGER on Win64 in principle. */
  hwnd?: string
  processId?: number
  /**
   * The DWM EXTENDED FRAME bounds, not `GetWindowRect` — the latter includes the
   * invisible resize border Windows 10/11 adds, which would make every surface a
   * few pixels too big and every edge hit-test wrong.
   */
  bounds: Rect
  /** The client area, in the same space. Empty rect when it could not be read. */
  clientBounds?: Rect
  /**
   * The parts of `bounds` no window above it covers, computed by Core from the
   * z-ordered stack at that sample. This is what lets a provider claim a REGION
   * rather than a window, and what makes "drop occluded candidates" mean
   * something across surfaces. Absent = not computed yet (it is computed lazily
   * at query time, not stored).
   */
  visibleRegion?: Rect[]
  /** 0 = topmost. The window manager's own order at that instant. */
  zOrder: number
  visible: boolean
  minimized: boolean
  foreground: boolean
  /** DWM-cloaked (a UWP app on another virtual desktop): present but not on screen. */
  cloaked?: boolean
  /** Owner window (a dialog's parent), as a surfaceId — SPEC of #65's "surface ownership". */
  ownerSurfaceId?: string
  executableName?: string
  windowTitle?: string
  className?: string
}

/** #65's question, as a call. */
export interface SurfaceQuery {
  sessionId: string
  timeMs: number
  point: ScreenPoint
}

/**
 * The whole stack at a point, not just the winner (#65): the topmost visible
 * surface is the default target, and the ones behind it are kept so the user can
 * cycle back through them (Alt+Click, #66).
 */
export interface SurfaceStack {
  timeMs: number
  accuracy: TemporalAccuracy
  /** Topmost first. Empty only on a bare desktop or outside the recorded range. */
  surfaces: SurfaceInfo[]
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface BufferStartContext {
  sessionId: string
  /** Session-clock time of the start (0 for the first session of a run). */
  startedAtMs: number
  /** How far back the ring must reach. Settings can change this MID-SESSION. */
  retentionMs: number
  /**
   * The provider's memory ceiling for its whole buffer (GAP 4).
   *
   * `onPrune` is a TIME bound and cannot stop a page doing 10,000 mutations a
   * second from blowing memory inside the retained window. A provider over
   * budget MUST drop RESOLUTION (coarser checkpoints, dropped delta lanes) and
   * NEVER RANGE, and MUST mark the affected intervals `degraded` so
   * `TemporalAccuracy` stays truthful. Core measures actual usage and disables a
   * provider that ignores it, with a named row in Settings > Plugins.
   */
  memoryBudgetBytes: number
}

export interface BufferTickContext {
  sessionId: string
  /** Core's monotonic time. NOT an order to sample — see the file header. */
  timeMs: number
  bufferStartMs: number
  bufferEndMs: number
  /**
   * The instant Core sent this tick, on Core's clock (GAP 3). With the two
   * instants in `TickAck` it gives an NTP-style offset and round-trip bound, and
   * the residual is folded into every `TemporalAccuracy.errorMs` Core publishes
   * for this provider. Without it, a provider in another process has its own
   * clock and NOTHING measures the drift.
   */
  sentAtMs: number
}

/** What a provider is doing, in one word (GAP 1). Settings > Plugins shows it. */
export type ProviderRunState = 'starting' | 'running' | 'degraded' | 'disconnected' | 'error'

/**
 * The provider→Core status channel (GAP 1), and the reason `onTick` returns
 * something at all.
 *
 * Settings > Plugins promises "Status: Connected / Buffer: Running / Resolution:
 * 100 ms" and, as the protocol was first written, NO METHOD PRODUCED ANY OF IT.
 * A provider also had no way to say "not ready — and I will tell you when I am",
 * which is the ordinary state of a Chrome extension whose MV3 service worker
 * Chrome just killed.
 *
 * A provider that never acks is treated as having an UNBOUNDED clock error and
 * its candidates are marked approximate.
 */
export interface TickAck {
  state: ProviderRunState
  /** The provider's own monotonic clock when it RECEIVED the tick. */
  receivedAtLocalMs: number
  /** The provider's own monotonic clock when it REPLIED. */
  providerLocalMs: number
  /** Oldest / newest time the provider can actually restore, on Core's clock. */
  bufferedFromMs: number
  bufferedToMs: number
  /** The provider's current sampling resolution, in ms between samples. */
  resolutionMs: number
  /** Samples taken and samples dropped since the last tick. */
  samples: number
  dropped: number
  /** Bytes the provider's buffer currently occupies — checked against the budget. */
  bytes: number
  /** Human-readable, English, for the log and the Plugins row. Optional. */
  detail?: string
}

export interface BufferPruneContext {
  sessionId: string
  /**
   * Drop everything before this time, KEEPING the last checkpoint still needed
   * to restore what remains (#64). A provider that drops that checkpoint has
   * dropped range, not resolution.
   */
  beforeTimeMs: number
}

export interface BufferFreezeContext {
  sessionId: string
  /**
   * Identifies THIS freeze (GAP 5). Several editors can be open at once — a
   * capture plus a pack re-opened from History — so freezes are ref-counted and
   * a pinned range with no identity leaks until the session ends.
   */
  freezeId: string
  range: { startMs: number; endMs: number }
}

export interface BufferReleaseContext {
  sessionId: string
  freezeId: string
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface MaterializeContext {
  sessionId: string
  timeMs: number
  /**
   * SCOPE HINTS (GAP 6). A provider MAY ignore them, but one that honours them
   * must still be correct for what it returns. Without a scope, a Chrome
   * provider with 20 tabs across 3 windows would have to restore every tab at T
   * to answer about one point — which is the "forcing a full DOM/UI tree copy"
   * GOAL.md explicitly forbids.
   */
  surfaceIds?: string[]
  regions?: Rect[]
}

/**
 * What `materialize` returns: the provider has PREPARED its state at that time.
 * It deliberately does not carry the structure — selection goes through
 * `hitTest`/`frame`.
 */
export interface ProviderState {
  providerId: string
  timeMs: number
  accuracy: TemporalAccuracy
  surfaces: ProviderSurfaceClaim[]
  metadata?: Record<string, unknown>
}

export interface SurfaceClaimContext {
  sessionId: string
  /**
   * Claims are TIME-VARYING: a window did not exist 20 seconds ago, and a tab
   * was showing a different page. The context was undefined in the issue (GAP 8).
   */
  timeMs: number
  /** The resolved stack at that time, so a provider can echo a `surfaceId`. */
  surfaces: SurfaceInfo[]
}

/**
 * "I own this region of that surface." Providers claim REGIONS, not whole
 * windows (GOAL.md): one Chrome window is shared — the DOM provider owns the web
 * content viewport, the Windows UI provider owns the address bar, tabs and frame.
 */
export interface ProviderSurfaceClaim {
  providerId: string
  /**
   * The surface this claim is about. A provider that CAN echo a `surfaceId` from
   * `SurfaceClaimContext.surfaces` must do so.
   */
  surfaceId: string
  hwnd?: string
  processId?: number
  region: Rect
  authority: SurfaceAuthority
  /** 0..1. Ordering criterion 5, and only ever a tie-break. */
  confidence: number
  /**
   * For a provider that CANNOT know an HWND (GAP 9) — a Chrome extension knows
   * `chrome.windows.get` bounds and `window.screenX/screenY`, and nothing else.
   * Core attributes such a claim to the topmost visible surface at the region's
   * centre whose executable name matches this hint (case-insensitive, extension
   * stripped), and clips the claim to that surface's visible region. A claim
   * matching no surface is DROPPED and the drop is logged, never silently ignored.
   */
  executableHint?: string
}

export interface HitTestContext {
  sessionId: string
  timeMs: number
  point: ScreenPoint
  surface: SurfaceInfo
}

/**
 * One thing a provider offers at a point. Core never interprets `objectId`,
 * `objectType` or `metadata` — they are the provider's vocabulary and travel
 * into the pack unchanged.
 */
export interface ContextCandidate {
  providerId: string
  surfaceId: string
  /**
   * OPAQUE TO CORE (GAP 12). It MUST be unique within
   * (providerId, sessionId, surfaceId) at any instant, and MUST denote the same
   * object over time for as long as the provider can prove continuity. Where it
   * cannot, the provider MUST mint a NEW id — an honest discontinuity beats a
   * silent identity swap.
   *
   * Measured on the evidence packs: 17–24 of ~450 UIA elements share
   * (control_type, automation_id, class_name, name, depth, window), so the
   * natural key is NOT unique and a provider must not use it as one.
   */
  objectId: string
  objectType: string
  name?: string
  bounds: Rect
  /**
   * SEMANTIC SPECIFICITY, MONOTONE ALONG CONTAINMENT (GAP 11) — computed from
   * GEOMETRY, not from tree-walk depth.
   *
   * A candidate MUST carry a strictly greater `depth` than any candidate that
   * encloses it. Core's "deeper wins" is then equivalent to the editor's
   * measured "smallest containing wins", which is what issue #58 fixed: ordering
   * by UIA walk depth never once beat containment and lost on 31.9% of contested
   * points. Handing tree depth to this field would re-introduce that regression.
   */
  depth: number
  /**
   * Within ONE surface, higher is drawn LATER, i.e. in front (GAP 17).
   *
   * 29% of contested points have two candidates where neither encloses the
   * other, and only paint order resolves them. A pre-order walk index is a valid
   * paint order for UIA; a DOM provider's answer is stacking context then
   * document order. Both are required; neither is optional.
   */
  paintOrder: number
  authority: SurfaceAuthority
  /** 0..1. */
  confidence: number
  visible: boolean
  occluded: boolean
  parentId?: string
  metadata?: Record<string, unknown>
}

/**
 * The candidate set inside a rectangle at a time (GAP 7) — the biggest hole the
 * two-consumer walkthrough found.
 *
 * NOTHING in the protocol as written could feed an interactive hover:
 * `materialize` returns surfaces and metadata and no candidates, and a per-point
 * async `hitTest` on every mouse move is 100–300 ms of latency per pixel. Core
 * asks for a frame when the scrub settles, indexes it locally, and hover becomes
 * a local lookup. `hitTest` remains the authoritative low-rate path for a click
 * and for the candidate stack.
 *
 * A provider that cannot serve frames MAY decline (return `declined: true`), and
 * Core degrades to hit-test-on-hover-settle with a visible "resolving" state.
 */
export interface FrameContext {
  sessionId: string
  timeMs: number
  /** The region of interest — normally one display. */
  region: Rect
  surfaceIds?: string[]
  maxCandidates: number
}

export interface ProviderFrame {
  providerId: string
  timeMs: number
  accuracy: TemporalAccuracy
  candidates: ContextCandidate[]
  /** True when `maxCandidates` cut the list: the editor must not claim completeness. */
  truncated: boolean
  /** This provider does not serve frames; Core falls back to `hitTest`. */
  declined?: boolean
}

export interface TrackContext {
  sessionId: string
  /** GAP 12c: without it, two surfaces of one provider collide on `objectId`. */
  surfaceId: string
  objectId: string
  range: { startMs: number; endMs: number }
  /** Sampling hint; the provider may return fewer samples. */
  intervalMs: number
}

export interface ObjectSample {
  timeMs: number
  bounds: Rect
  visible: boolean
}

/**
 * "I lost it here; it may still exist" (GAP 12b). A checkpoint gap, a degraded
 * interval or a disconnected extension all produce this, and reporting any of
 * them as `removedAtMs` is a lie about an object's lifetime.
 */
export interface TrackGap {
  startMs: number
  endMs: number
  reason: 'pruned' | 'degraded' | 'disconnected' | 'invalidated'
}

export interface ObjectTrack {
  providerId: string
  surfaceId: string
  objectId: string
  samples: ObjectSample[]
  createdAtMs?: number
  /** OBSERVED REMOVAL and nothing else. Not "I stopped seeing it" — that is a gap. */
  removedAtMs?: number
  gaps: TrackGap[]
  accuracy: TemporalAccuracy
}

/** One captured display, in the shape a provider needs to write SPEC-conformant bounds. */
export interface ExportDisplayTarget {
  /** 1-based pack display index (SPEC §5.6). */
  index: number
  /** Exactly one target is focused: the display whose media is the top-level media. */
  focused: boolean
  /** The display's rectangle in the protocol's space (virtual-desktop physical pixels). */
  bounds: Rect
  /** That display's snapshot size in pixels — the annotation coordinate space (SPEC §8.2). */
  width: number
  height: number
}

/** What Core selected, that the provider is being asked to describe (SPEC §8.7). */
export interface ExportTarget {
  surfaceId: string
  objectId: string
  timeMs: number
}

export interface ProviderExportContext {
  sessionId: string
  freezeId: string
  /** The saved pack folder. READ-ONLY to the provider — Core writes the files. */
  packPath: string
  /** `plugins/<provider-id>/` — the provider's namespace, and the only path Core will write to. */
  outputDir: string
  selectedTimeMs: number
  /** The SAVED (post-trim) range, on the session clock. */
  range: { startMs: number; endMs: number }
  targets: ExportTarget[]
  displays: ExportDisplayTarget[]
}

/** A file the provider wants written into its namespace. */
export interface ProviderExportFile {
  /** Matched against `^[a-z0-9][a-z0-9._-]*\.json$`. No directories, ever. */
  name: string
  bytes: string
}

/**
 * CORE WRITES THESE FILES (GAP 14). `write-plugin-files` was a permission with
 * nothing enforcing it, and SPEC §5.4 requires a `manifest.plugins[]` entry only
 * Core can write. Returning bytes instead of writing them makes the permission a
 * fact rather than a promise, and makes SPEC §11.1's "plugins own nothing except
 * their directory" true by construction.
 */
export interface ProviderExportResult {
  providerId: string
  files: ProviderExportFile[]
  warnings?: string[]
}

// ---------------------------------------------------------------------------
// The provider itself
// ---------------------------------------------------------------------------

/**
 * What a provider implements. Every method may reject or hang: Core wraps each
 * one in its own timeout and failure isolation, and a provider that fails is
 * disabled with a named reason rather than being allowed to take Core down
 * (GOAL.md: "No plugin failure may ever cost a capture").
 *
 * The lifecycle callbacks are OPTIONAL because not every provider needs them; a
 * provider that implements none of them still works, it just never buffers.
 */
export interface TemporalContextProvider {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly protocolVersion: string
  readonly type: 'temporal-context-provider'

  onBufferStart?(context: BufferStartContext): Promise<void>
  /** Returns a `TickAck` — the provider's only channel back to Core (GAP 1). */
  onTick?(context: BufferTickContext): Promise<TickAck>
  onPrune?(context: BufferPruneContext): Promise<void>
  onFreeze?(context: BufferFreezeContext): Promise<void>
  onRelease?(context: BufferReleaseContext): Promise<void>

  materialize(context: MaterializeContext): Promise<ProviderState>
  getSurfaceClaims(context: SurfaceClaimContext): Promise<ProviderSurfaceClaim[]>
  hitTest(context: HitTestContext): Promise<ContextCandidate[]>
  frame?(context: FrameContext): Promise<ProviderFrame>
  track(context: TrackContext): Promise<ObjectTrack>
  export(context: ProviderExportContext): Promise<ProviderExportResult>
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/**
 * Timeouts are BUDGETS, NOT SUGGESTIONS (GOAL.md). The numbers come from issue
 * #64 and from what the calls actually are once `hitTest` runs over the
 * provider's own restored state instead of asking the OS
 * (docs/temporal-protocol.md §1.4): a lookup in a structure the provider already
 * built is microseconds, so these are generous rather than tight.
 *
 * A SLOW PROVIDER MUST NEVER HOLD THE EDITOR SHUT. Nothing here is on the
 * editor's first-paint path: late results update the candidate list
 * asynchronously.
 */
export const PROVIDER_TIMEOUTS = {
  /** #64: "hitTest in the low hundreds of ms". The upper end of 100–300 ms. */
  hitTest: 300,
  /** Interactive hover feeds from this, so it may not be slower than a hit test. */
  frame: 300,
  /** #64: "materialize under ~500 ms". */
  materialize: 500,
  /** Claims are answered from the provider's own tables; this is a liveness check. */
  claims: 250,
  /** Lifecycle notifications are bookkeeping, not work. */
  lifecycle: 1_000,
  /** #64: "background work allowed seconds". A track spans the whole range. */
  track: 3_000,
  /** Export runs after the pack is already saved; nothing is waiting on it. */
  export: 5_000,
} as const

/**
 * Default buffer ceiling per provider (GAP 4). Derived from a measured shape —
 * 32 B per element, 551 elements on the reference desk, 1367 for a full desktop
 * checkpoint — plus an assumed hostile case, so it is ~20x the measured need
 * (docs/temporal-protocol.md §4.5) and exists to bound a pathological provider
 * rather than to constrain an ordinary one.
 */
export const PROVIDER_MEMORY_BUDGET_BYTES = 8 * 1024 * 1024

/**
 * How far a covering sample may be from the requested time before a candidate is
 * NOT OFFERED AT ALL (GAP 16).
 *
 * This is what makes deleting v0.1.7's `objectsDescribeNow()` gate honest rather
 * than replacing one lie with another: without a ceiling, removing the gate just
 * moves the lie from "picking is off" to "here is a rectangle from nine seconds
 * ago". Geometry is not subject to it — the Surface Timeline re-anchors at
 * 100 ms — so what it actually withholds is CONTROL detail during an uncovered
 * interval, and the window level answers instead.
 */
export const STALENESS_CEILING_MS = 3_000
