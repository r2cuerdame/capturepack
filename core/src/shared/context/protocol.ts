// The Temporal Context Provider protocol (GOAL "Plugin System, redesigned
// (v0.2.0)", issues #64 / #65 / #66).
//
// DOCUMENTED AND EXPLICITLY UNSTABLE (#64). It will change; `protocolVersion`
// is checked strictly and an incompatible provider is refused with a clear
// message rather than half-working. It goes to v1 with a compatibility promise
// at whichever comes first — a provider we did not write running in the wild,
// or the first serious external request to build one.
//
// ONE RULE ABOVE ALL (#64, GOAL): Windows UI Automation is the REFERENCE
// IMPLEMENTATION of this protocol, not a privileged insider. It consumes the
// same clock, the same surface claims, the same hitTest, the same timeouts and
// the same failure isolation an external provider gets. If the built-in
// provider ever needs something this file does not offer, that is a GAP IN THE
// PROTOCOL to be closed for everyone — never a private hook.
//
// WHAT THIS PHASE IMPLEMENTS. Observation and picking: `getSurfaceClaims`,
// `frame`, `hitTest`, and the buffer lifecycle. `track` is declared because
// tracked annotations (#70 criterion 6) are built on it and its shape has to be
// right before anything depends on it; `export` deliberately is NOT here — it
// cannot be specified before SPEC §11.4 exists, and inventing it now would fix
// the wrong abstraction (the whole reason this protocol ships unstable).

/** Protocol version providers are checked against. Strict equality, no ranges. */
export const CONTEXT_PROTOCOL_VERSION = '1'

/** A rectangle. The space it is measured in is always declared — see RectSpace. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface ScreenPoint {
  x: number
  y: number
}

/**
 * WHICH PIXELS A `Rect` IS COUNTED IN.
 *
 * The design document's GAP 10 makes every protocol rect virtual-desktop
 * physical pixels. That cannot be honoured by a provider whose source data was
 * already mapped into a pack — a v0.1.x `plugins/windows-uia/elements.json`
 * carries snapshot pixels and the physical rectangle is not recoverable from it
 * — so the correction is stated the other way round: **every rect declares its
 * space**, and Core converts. Reported as a protocol gap rather than solved by
 * letting the built-in provider skip the declaration, which is exactly the
 * private path #64 forbids.
 *
 *   virtual-desktop-physical — the live desktop's own pixels, origin at the
 *                              primary display's top-left, DPI-unvirtualised.
 *                              What a live provider (Win32, UIA, Chrome after
 *                              its DIP conversion) reports.
 *   display-snapshot         — pixels of ONE captured display's snapshot image
 *                              (SPEC §8.2), which is the annotation coordinate
 *                              space. `display` then names which one.
 */
export type RectSpace = 'virtual-desktop-physical' | 'display-snapshot'

/**
 * AUTHORITY IS SPECIFICITY, NOT RANK (#66). The ladder is fixed, and a provider
 * does not get to promote itself up it: it declares what KIND of thing it
 * knows, and the ladder decides who is more specific about a pixel.
 *
 *   application-native  →  document-native  →  accessibility  →  window  →  manual
 *     (Unreal widget)       (DOM element)       (UIA element)    (HWND)
 */
export type SemanticAuthority =
  | 'application-native'
  | 'document-native'
  | 'accessibility'
  | 'window'
  | 'manual'

/** The ladder, most specific first. Index = rank; lower wins. */
export const AUTHORITY_LADDER: readonly SemanticAuthority[] = [
  'application-native',
  'document-native',
  'accessibility',
  'window',
  'manual',
]

/** Rank of an authority on the ladder. Lower is more specific, i.e. wins. */
export function authorityRank(authority: SemanticAuthority): number {
  const rank = AUTHORITY_LADDER.indexOf(authority)
  // An unknown authority sorts BELOW the manual rectangle rather than above
  // everything: a provider that invents a rung must never outrank the ones the
  // protocol defines.
  return rank < 0 ? AUTHORITY_LADDER.length : rank
}

/**
 * HOW WELL THE DATA COVERS THE QUESTION (design GAP 16).
 *
 * "80 ms off" and "25 seconds off" are not the same statement, and `errorMs`
 * alone cannot tell them apart — which is why the v0.1.7 stopgap had to refuse
 * everything. Coverage is the verdict; errorMs is the distance.
 *
 *   covered        — a sample at or near the requested time really exists.
 *   before-start   — the requested time is before this buffer began.
 *   pruned         — it fell out of the ring and is gone.
 *   degraded       — sampling was reduced here (the governor, a resize
 *                    invalidation): geometry may be re-anchored, structure is
 *                    coarser than requested.
 *   single-instant — this source describes exactly one moment (a v0.1.x pack).
 *                    Any other time is not covered at all.
 *   none           — nothing was ever recorded.
 */
export type TemporalCoverage =
  | 'covered'
  | 'before-start'
  | 'pruned'
  | 'degraded'
  | 'single-instant'
  | 'none'

/**
 * APPROXIMATE, BUT NEVER SILENTLY (GOAL). An answer that is 80 ms off is
 * useful; an answer that is 80 ms off and claims to be exact is the same class
 * of lie as a tray icon that says "recording".
 */
export interface TemporalAccuracy {
  requestedTimeMs: number
  materializedTimeMs: number
  errorMs: number
  exact: boolean
  coverage: TemporalCoverage
}

/** One monotonic session clock, handed out by Core (#64). */
export interface CaptureClock {
  sessionId: string
  nowMs: number
  bufferStartMs: number
  bufferEndMs: number
}

/**
 * A CANDIDATE MAY NOT BE OFFERED FROM FURTHER AWAY THAN THIS (design §5).
 *
 * Deleting the v0.1.7 gate without this would only move the lie from "picking
 * is off" to "here is a rectangle from nine seconds ago". Geometry is not
 * subject to it — the surface timeline re-anchors at its own resolution — so
 * what the ceiling actually withholds is structural detail during an uncovered
 * interval, and the window level answers instead.
 */
export const STALENESS_CEILING_MS = 3_000

/**
 * TIMEOUTS ARE BUDGETS, NOT SUGGESTIONS (GOAL, #64). A slow provider must never
 * hold the editor shut; late answers update the candidate list asynchronously.
 */
export const PROVIDER_BUDGET_MS = {
  hitTest: 200,
  frame: 300,
  materialize: 500,
  claims: 100,
} as const

/**
 * One top-level window as the Platform Surface Timeline recorded it (#65).
 *
 * Core platform infrastructure, NOT a provider: it answers which window was
 * where, in what order, at time T — for the PAST desktop, never the live one
 * the editor is sitting in front of.
 */
export interface SurfaceInfo {
  /**
   * Core-minted and STABLE ACROSS THE SESSION — not per sample (design §6).
   * A window that changes z-order, is re-focused or is re-created keeps its
   * identity so a provider's claim keyed on it stays valid across the ring.
   */
  surfaceId: string
  hwnd?: string
  processId?: number
  bounds: Rect
  space: RectSpace
  /** Which captured display `bounds` is in, when space is display-snapshot. */
  display?: number
  clientBounds?: Rect
  /**
   * The part of this surface not covered by any surface above it, computed by
   * Core from the z-ordered rectangles of the same sample. This is what lets a
   * provider claim a REGION rather than a window, and what makes "drop
   * candidates that are occluded" mean anything across surfaces.
   */
  visibleRegion?: readonly Rect[]
  /** 0 is top-most. */
  zOrder: number
  visible: boolean
  minimized: boolean
  foreground: boolean
  executableName?: string
  windowTitle?: string
  className?: string
}

/** The surface stack at one instant, z ascending (0 = top-most). */
export interface SurfaceSample {
  tMs: number
  surfaces: readonly SurfaceInfo[]
}

/**
 * PROVIDERS CLAIM REGIONS, NOT WINDOWS (#66). One Chrome window is shared: the
 * DOM provider owns the web content viewport, the Windows UI provider owns the
 * address bar, tabs and frame. A provider claiming a whole window it only
 * partly understands is the bug this prevents.
 */
export interface ProviderSurfaceClaim {
  providerId: string
  surfaceId: string
  hwnd?: string
  processId?: number
  region: Rect
  space: RectSpace
  display?: number
  authority: SemanticAuthority
  confidence: number
  /**
   * For a provider that cannot know an HWND (design GAP 9): Core attributes the
   * claim to the top-most visible surface at the region's centre whose
   * executable matches, and clips it to that surface's visible region. A claim
   * matching no surface is DROPPED and the drop is logged, never silently
   * ignored.
   */
  executableHint?: string
}

/**
 * WHAT A PROVIDER RECORDED FOR ONE SURFACE — the generalisation of SPEC §11.3's
 * "Silence is not absence" to every provider. "No candidates here" and "I never
 * looked here" are different statements and the editor says different things
 * about them, so the protocol has to be able to tell them apart.
 */
export type SurfaceDetailState = 'recorded' | 'truncated' | 'unavailable' | 'skipped'

export interface SurfaceCoverage {
  surfaceId: string
  state: SurfaceDetailState
}

/** One object a provider offers at a time and place (#66). */
export interface ContextCandidate {
  providerId: string
  surfaceId: string
  /**
   * OPAQUE TO CORE (design GAP 12). Unique within (providerId, sessionId,
   * surfaceId) at any instant, and denoting the same object over time for as
   * long as the provider can prove continuity — where it cannot, the provider
   * MUST mint a new id. An honest discontinuity beats a silent identity swap.
   */
  objectId: string
  objectType: string
  name?: string
  bounds: Rect
  space: RectSpace
  display?: number
  /**
   * SEMANTIC SPECIFICITY, MONOTONE ALONG CONTAINMENT (design GAP 11) — NOT the
   * depth of a tree walk. A candidate MUST carry a strictly greater `depth`
   * than any candidate enclosing it, and providers compute it from geometry.
   *
   * The distinction is measured, not stylistic: ordering by UIA walk depth
   * never once beat ordering by containment and lost on 31.9% of contested
   * points (#58). Redefining the field is what keeps #66's criterion 4 from
   * re-introducing the regression #58 fixed.
   */
  depth: number
  /**
   * Within one surface, higher is drawn LATER, i.e. in front (design GAP 17).
   * Required because 29% of contested points hold two candidates where neither
   * encloses the other, and only paint order resolves those.
   */
  paintOrder: number
  authority: SemanticAuthority
  confidence: number
  visible: boolean
  occluded: boolean
  parentId?: string
  /** How well this candidate's provider covers the requested time. */
  accuracy: TemporalAccuracy
  /**
   * Provider-defined identity fields, all strings so they survive IPC and so
   * nothing downstream needs a cast (`any` is not allowed in this codebase).
   * The Windows UI Automation provider fills name / control_type /
   * automation_id / class_name / process / title, which is exactly what SPEC
   * §8.7's `target` records.
   */
  identity?: Readonly<Record<string, string>>
}

export interface BufferStartContext {
  sessionId: string
  startedAtMs: number
  retentionMs: number
  /** design GAP 4: a provider cannot size its ring without being told. */
  memoryBudgetBytes: number
}

export interface BufferTickContext {
  sessionId: string
  timeMs: number
  bufferStartMs: number
  bufferEndMs: number
  /** design GAP 3: the instant Core sent this, for the offset estimate. */
  sentAtMs: number
}

/**
 * The provider→Core status channel the protocol was missing (design GAP 1) —
 * Settings promises "Status: Connected / Buffer: Running / Resolution: 100 ms"
 * and, before this, no method produced any of it.
 */
export interface TickAck {
  providerLocalMs: number
  receivedAtLocalMs: number
  state: 'running' | 'starting' | 'disconnected' | 'degraded' | 'error'
  bufferedFromMs: number
  bufferedToMs: number
  resolutionMs: number
  samples: number
  dropped: number
  bytes: number
}

export interface BufferPruneContext {
  sessionId: string
  beforeTimeMs: number
}

export interface BufferFreezeContext {
  sessionId: string
  /** design GAP 5: several editors may hold overlapping ranges. */
  freezeId: string
  range: { startMs: number; endMs: number }
}

export interface BufferReleaseContext {
  sessionId: string
  freezeId: string
}

/** design GAP 8: claims are time-varying — a window did not exist at T-20 s. */
export interface SurfaceClaimContext {
  sessionId: string
  timeMs: number
  surfaces: readonly SurfaceInfo[]
}

/**
 * THE CANDIDATE SET INSIDE A RECT AT A TIME (design GAP 7 — the big one).
 *
 * Nothing in #64/#66 as written could feed an interactive hover: `materialize`
 * returns surfaces and metadata and no candidates, and `hitTest` is per point,
 * which over IPC is a round trip per pointer move. Hovering costs nothing per
 * frame today and must keep costing nothing, so Core asks for a FRAME once per
 * settled scrub position and indexes it locally.
 *
 * A provider that cannot serve frames declines (returns `served: false`) and
 * Core degrades to hit-test-on-hover-settle with a visible resolving state.
 */
export interface FrameContext {
  sessionId: string
  timeMs: number
  /** The surface stack Core already restored — providers do NOT re-derive it. */
  surfaces: readonly SurfaceInfo[]
  /** Scope hint (design GAP 6). A provider MAY ignore it and stay correct. */
  region?: Rect
  maxCandidates: number
}

export interface ProviderFrame {
  providerId: string
  /** false = this provider cannot serve frames; Core falls back to hitTest. */
  served: boolean
  timeMs: number
  accuracy: TemporalAccuracy
  candidates: readonly ContextCandidate[]
  claims: readonly ProviderSurfaceClaim[]
  coverage: readonly SurfaceCoverage[]
  /** The cap was hit; the set is incomplete and the editor may say so. */
  truncated: boolean
}

export interface HitTestContext {
  sessionId: string
  timeMs: number
  point: ScreenPoint
  space: RectSpace
  display?: number
  surface: SurfaceInfo
}

/** design GAP 12b/12c: a track has to be able to say "I lost it here". */
export interface ObjectTrackGap {
  startMs: number
  endMs: number
  reason: 'pruned' | 'degraded' | 'disconnected' | 'invalidated'
}

export interface ObjectTrack {
  providerId: string
  surfaceId: string
  objectId: string
  samples: ReadonlyArray<{ tMs: number; bounds: Rect; visible: boolean }>
  /** OBSERVED removal, and nothing else. A gap is not a removal. */
  createdAtMs?: number
  removedAtMs?: number
  gaps: readonly ObjectTrackGap[]
}

export interface TrackContext {
  sessionId: string
  surfaceId: string
  objectId: string
  range: { startMs: number; endMs: number }
}

/** The fixed permission set a manifest may declare (GOAL, #64). */
export type ProviderPermission =
  | 'read-pack'
  | 'write-plugin-files'
  | 'network'
  | 'run-process'
  | 'read-browser-context'
  | 'read-active-window'
  | 'native-messaging'
  | 'create-zip'
  | 'open-browser'

/**
 * A Temporal Context Provider: observes, records, restores. Core chooses the
 * time and the screen position and never interprets a provider's object tree.
 */
export interface TemporalContextProvider {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly protocolVersion: string
  readonly type: 'temporal-context-provider'
  readonly permissions: readonly ProviderPermission[]

  onBufferStart?(c: BufferStartContext): Promise<void>
  onTick?(c: BufferTickContext): Promise<TickAck>
  onPrune?(c: BufferPruneContext): Promise<void>
  onFreeze?(c: BufferFreezeContext): Promise<void>
  onRelease?(c: BufferReleaseContext): Promise<void>

  getSurfaceClaims(c: SurfaceClaimContext): Promise<readonly ProviderSurfaceClaim[]>
  frame(c: FrameContext): Promise<ProviderFrame>
  hitTest(c: HitTestContext): Promise<readonly ContextCandidate[]>
  track?(c: TrackContext): Promise<ObjectTrack>
}

/** What Core reports about one provider, per frame (design GAP 1). */
export interface ProviderFrameStatus {
  providerId: string
  name: string
  state: 'ok' | 'declined' | 'timeout' | 'error' | 'incompatible'
  coverage: TemporalCoverage
  errorMs: number
  candidates: number
  truncated: boolean
  /** Wall time the provider took to answer, for the execution log. */
  elapsedMs: number
}

/**
 * ONE CAPTURED DISPLAY'S SLICE OF A RESOLVED FRAME.
 *
 * Core maps every provider's rects into the display's snapshot pixel space here
 * (SPEC §8.2 / §11.3), because that is the annotation coordinate space and the
 * editor must never do that conversion itself — the mapping is Core's, and it
 * is the same for every provider.
 */
export interface ContextDisplayFrame {
  display: number
  width: number
  height: number
  /** z ascending, 0 = top-most, already clipped to this display's snapshot. */
  surfaces: readonly SurfaceInfo[]
  candidates: readonly ContextCandidate[]
  coverage: readonly SurfaceCoverage[]
}

/**
 * What the editor gets for one scrub position: the restored surface stack plus
 * every provider's candidates, per display. Small enough to push (the reference
 * capture's is 451 candidates over 2 displays), and indexed locally so hovering
 * costs nothing per frame.
 */
export interface ContextFrame {
  sessionId: string
  protocolVersion: string
  requestedTimeMs: number
  accuracy: TemporalAccuracy
  displays: readonly ContextDisplayFrame[]
  providers: readonly ProviderFrameStatus[]
  /** The claims that decided who was asked, kept for the editor's arbitration. */
  claims: readonly ProviderSurfaceClaim[]
  /**
   * A provider has not answered yet and a replacement frame WILL follow. The
   * editor paints what it has rather than waiting — late candidates update the
   * list asynchronously (GOAL: "a slow provider must never hold the editor
   * shut").
   */
  pending: boolean
  /**
   * The observation was ATTEMPTED and produced nothing usable, and none is
   * coming (GOAL "Silence is not absence"). False both when there are
   * candidates AND when they are still on their way; never true for a pack that
   * simply never had object data, because nothing was dropped there.
   */
  dropped: boolean
}
