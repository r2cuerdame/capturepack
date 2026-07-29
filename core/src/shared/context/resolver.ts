// The Surface Resolver (#66): ask only who owns the pixel.
//
// CORE PLATFORM INFRASTRUCTURE, NOT A PROVIDER (GOAL, #66). A numeric plugin
// priority cannot settle a Notepad window in front of a windowed Unreal game:
// both providers legitimately claim an object at that point and the user is
// looking at Notepad. So the SURFACE STACK for that time is restored FIRST,
// from Core's own timeline, and only then is anyone asked.
//
// THE ALGORITHM, exactly as #66 specifies it:
//
//   1. restore the surface stack at T                    (SurfaceTimeline)
//   2. topmost visible surface at the point              (surfaceStackAt)
//   3. only providers holding a claim there              (claimCovers)
//   4. hit-test each, in parallel, each with its budget  (ProviderHost)
//   5. drop candidates that are !visible or occluded
//   6. order by the six criteria below
//   7. offer the first; KEEP THE REST as the candidate stack
//   8. no candidate -> the window level; no window -> a manual rectangle
//
// Step 8 is the reason the v0.1.7 stopgap could be deleted: the window rung of
// the authority ladder is populated wherever the surface timeline has a sample,
// so "nothing at all" only happens on bare desktop.
import type {
  ContextCandidate,
  ProviderSurfaceClaim,
  Rect,
  ScreenPoint,
  SemanticAuthority,
  SurfaceInfo,
} from './protocol'
import { authorityRank } from './protocol'
import { rectContains, surfaceStackAt } from './surfaces'

/**
 * The minimum a thing needs to be arbitrated. Structural on purpose: the editor
 * resolves over its own index entries (which carry the CLIPPED, snapshot-space
 * geometry a box would actually snap to), and main resolves over raw
 * candidates. One comparator, two callers, no duplicated ordering rules.
 */
export interface ResolvableCandidate {
  providerId: string
  surfaceId: string
  authority: SemanticAuthority
  depth: number
  paintOrder: number
  confidence: number
  visible: boolean
  occluded: boolean
  x: number
  y: number
  width: number
  height: number
  area: number
}

export interface ResolveOptions {
  /**
   * CRITERION 6, USER PREFERENCE. Shift forces the window level back when a
   * control is on top (GOAL "Static object picking"), which is the only user
   * preference this editor has today.
   */
  forceAuthority?: SemanticAuthority
  /**
   * ALT+CLICK CYCLES SURFACES BEHIND (#66). It need not ship in the first
   * version, but the data model must support it from the start: 0 is the
   * top-most surface at the point, 1 the one behind it, and the resolver
   * arbitrates within whichever one is selected.
   */
  surfaceDepth?: number
  /** Final tiebreak only — never a priority number that outranks the ladder. */
  preferredProviderId?: string
}

export interface ResolvedStack<C extends ResolvableCandidate> {
  /** Every surface covering the point, top-most first. Losers are KEPT. */
  surfaces: readonly SurfaceInfo[]
  /** The surface arbitration ran on (surfaceDepth into `surfaces`). */
  surface: SurfaceInfo | null
  /** Ordered; the first is what a click takes, the rest is what Tab cycles. */
  offered: readonly C[]
  /** On the surfaces BEHIND the chosen one: kept for Alt+Click, never offered. */
  behind: readonly C[]
  /**
   * Candidates dropped because their provider holds no claim covering the
   * point. Counted rather than silently ignored: a provider answering about
   * pixels it never claimed is a provider bug, and one that is invisible in
   * production is a provider bug nobody will ever fix (#66 GAP 9).
   */
  unclaimed: number
}

/** Whether a provider's claims cover this point on this surface (#66). */
export function claimCovers(
  claims: readonly ProviderSurfaceClaim[],
  providerId: string,
  surfaceId: string,
  point: ScreenPoint,
  display?: number,
): boolean {
  for (const claim of claims) {
    if (claim.providerId !== providerId || claim.surfaceId !== surfaceId) continue
    if (
      display !== undefined
      && claim.display !== undefined
      && claim.display !== display
    ) {
      continue
    }
    if (rectContains(claim.region, point)) return true
  }
  return false
}

/**
 * PROVIDERS CLAIM REGIONS, NOT WINDOWS (#66). One Chrome window is shared: the
 * DOM provider owns the content viewport, the Windows UI provider owns the
 * address bar, tabs and frame. This is the clip that makes a region claim mean
 * something — a claim is only ever honoured inside the surface it names.
 */
export function clipClaimToSurface(claim: ProviderSurfaceClaim, surface: SurfaceInfo): Rect | null {
  const x0 = Math.max(claim.region.x, surface.bounds.x)
  const y0 = Math.max(claim.region.y, surface.bounds.y)
  const x1 = Math.min(claim.region.x + claim.region.width, surface.bounds.x + surface.bounds.width)
  const y1 = Math.min(claim.region.y + claim.region.height, surface.bounds.y + surface.bounds.height)
  if (x1 <= x0 || y1 <= y0) return null
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/**
 * Whether `a` fully encloses `b` — `b` is then the more specific of the two.
 * This IS criterion 4 in its geometric form: containment-monotone specificity
 * (design GAP 11), not the depth of a tree walk.
 */
function encloses(a: ResolvableCandidate, b: ResolvableCandidate): boolean {
  return (
    b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height
  )
}

/**
 * THE SIX CRITERIA, IN ORDER (#66). Returns < 0 when `a` should be offered
 * before `b`.
 *
 *   1. surface visibility and z-order  — done by the caller: arbitration runs
 *      on ONE surface, because the front window is what the user was looking at.
 *   2. provider claim                  — done by the caller: an unclaimed
 *      candidate never reaches the sort.
 *   3. semantic authority              — the fixed ladder, most specific first.
 *   4. semantic depth                  — containment first (see below), then the
 *      provider's declared depth.
 *   5. confidence
 *   6. user preference
 *
 * CRITERION 4 IS WHERE #58 LIVES, so it is spelled out. "Deeper wins" is
 * implemented as CONTAINMENT: where one candidate encloses another, the inner
 * one is the finer annotation and is what is on top. Where NEITHER encloses the
 * other — 29% of contested points, measured — containment says nothing at all,
 * and the tie goes to PAINT ORDER (design GAP 17), because a later-painted
 * sibling is drawn over an earlier one and that is the only occlusion signal
 * inside a surface.
 *
 * The provider's declared `depth` is consulted only AFTER paint order, and the
 * reason is measured, not stylistic: ordering by walk depth never once beat
 * ordering by containment and lost on 31.9% of contested points (#58). It earns
 * its place for providers whose specificity is not geometric — a DOM element
 * with a `transform` escapes its ancestor's box while still being deeper in the
 * document — and it can never override the two signals that were measured.
 */
export function compareCandidates(
  a: ResolvableCandidate,
  b: ResolvableCandidate,
  preferredProviderId?: string,
): number {
  // 3. authority: application-native -> document-native -> accessibility ->
  //    window -> manual.
  const authority = authorityRank(a.authority) - authorityRank(b.authority)
  if (authority !== 0) return authority
  // 4a. containment.
  if (encloses(a, b) !== encloses(b, a)) return encloses(a, b) ? 1 : -1
  // 4b. paint order within one surface (GAP 17). Higher = drawn later = in front.
  if (a.paintOrder !== b.paintOrder) return b.paintOrder - a.paintOrder
  // 4c. the provider's declared containment-monotone specificity.
  if (a.depth !== b.depth) return b.depth - a.depth
  // 5. confidence.
  if (a.confidence !== b.confidence) return b.confidence - a.confidence
  // 6. user preference, as a tiebreak and never as a priority number.
  if (preferredProviderId !== undefined && a.providerId !== b.providerId) {
    if (a.providerId === preferredProviderId) return -1
    if (b.providerId === preferredProviderId) return 1
  }
  // Last resort: the smaller rectangle is the more precise annotation.
  return a.area - b.area
}

export interface ResolveInput<C extends ResolvableCandidate> {
  surfaces: readonly SurfaceInfo[]
  claims: readonly ProviderSurfaceClaim[]
  /** Candidates whose geometry contains the point, any surface, any provider. */
  candidatesAtPoint: readonly C[]
  point: ScreenPoint
  display?: number
  options?: ResolveOptions
}

/**
 * Steps 2 and 5–8 of the algorithm. Steps 1 (restore) and 4 (ask) happen above
 * this, because they are I/O; everything decided here is pure and therefore
 * testable against a fixture.
 */
export function resolveCandidates<C extends ResolvableCandidate>(
  input: ResolveInput<C>,
): ResolvedStack<C> {
  const options = input.options ?? {}
  // 2. the surface stack at the point, top-most first. The whole stack is kept.
  const stack = surfaceStackAt(input.surfaces, input.point, input.display)
  const depth = Math.max(0, Math.min(options.surfaceDepth ?? 0, Math.max(0, stack.length - 1)))
  const surface = stack[depth] ?? null
  if (surface === null) {
    // 8. no surface at all: bare desktop. Nothing to offer, and that is the
    //    honest answer — not a full-desktop rectangle.
    return { surfaces: stack, surface: null, offered: [], behind: [], unclaimed: 0 }
  }
  const behindIds = new Set(stack.slice(depth + 1).map((s) => s.surfaceId))
  const offered: C[] = []
  const behind: C[] = []
  let unclaimed = 0
  for (const candidate of input.candidatesAtPoint) {
    // 5. drop what was not visible or was covered at that time.
    if (!candidate.visible || candidate.occluded) continue
    if (candidate.surfaceId !== surface.surfaceId) {
      if (behindIds.has(candidate.surfaceId)) behind.push(candidate)
      continue
    }
    // 6. user preference, applied as a filter: Shift forces the window rung.
    if (options.forceAuthority !== undefined && candidate.authority !== options.forceAuthority) {
      continue
    }
    // 3. only providers holding a claim on this region may answer here. Core's
    //    own window level is not a provider and needs no claim — it IS the
    //    surface, and it is the floor the ladder ends on.
    if (
      candidate.authority !== 'window' &&
      !claimCovers(
        input.claims,
        candidate.providerId,
        candidate.surfaceId,
        input.point,
        input.display,
      )
    ) {
      unclaimed += 1
      continue
    }
    offered.push(candidate)
  }
  // NOT A TOTAL ORDER, and it cannot be: containment is a partial order, so two
  // candidates can each be "in front of" a third by different tests. v0.1.7
  // avoided the question by scanning for a single best rather than sorting; the
  // candidate stack needs the whole list ordered, so this sorts. What makes that
  // safe is measurement, not argument — the checked-in fixture asserts that the
  // offer at all 5184 probe points on both displays is identical to what the
  // scan produced (test/temporal/check.mjs).
  offered.sort((a, b) => compareCandidates(a, b, options.preferredProviderId))
  return { surfaces: stack, surface, offered, behind, unclaimed }
}
