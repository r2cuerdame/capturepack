// Windows UI Automation as a Temporal Context Provider — the REFERENCE
// IMPLEMENTATION of the protocol (#64, GOAL).
//
// It stays in Core because it is the floor under object picking on the platform
// CapturePack ships on: with no plugin installed at all, hovering any window
// must still offer something, and that guarantee cannot depend on a third
// party. But being maintained by us is about WHO FIXES IT, not about what it is
// allowed to do — this class reaches Core through exactly the interface an
// external provider gets, is registered through the same registry, is called
// with the same budgets, and its candidates go through the same Surface
// Resolver with no privileged ordering.
//
// It differs from an installed provider in exactly two ways, both about
// maintenance and neither about capability: it is enabled by default, and it
// cannot be uninstalled.
import type {
  ContextCandidate,
  FrameContext,
  HitTestContext,
  ProviderFrame,
  ProviderSurfaceClaim,
  SurfaceClaimContext,
  TemporalAccuracy,
  TemporalContextProvider,
} from '../../shared/context/protocol'
import { CONTEXT_PROTOCOL_VERSION } from '../../shared/context/protocol'
import type { ProviderManifest } from '../../shared/context/manifest'
import { rectContains } from '../../shared/context/surfaces'
import type { ContextBuffer, ContextObservation } from './buffer'
import { candidatesOf, surfaceIdOf, WINDOWS_UIA_PROVIDER_ID } from './buffer'

const WINDOWS_UIA_VERSION = '0.4.0'

/**
 * The built-in provider's manifest — a REAL one, checked by the same registry
 * against the same rules an installed plugin's is (#64). Permissions live here
 * and not on the class because a permission the user was never shown is a
 * permission they never granted, and Settings > Plugins renders this list.
 *
 * `entry` is empty: there is no module to load, because this provider is
 * compiled into Core. That is the ONLY field where being built-in shows.
 */
export const WINDOWS_UIA_MANIFEST: ProviderManifest = {
  id: WINDOWS_UIA_PROVIDER_ID,
  name: 'Windows UI Automation',
  version: WINDOWS_UIA_VERSION,
  type: 'temporal-context-provider',
  protocolVersion: CONTEXT_PROTOCOL_VERSION,
  entry: '',
  permissions: ['read-active-window', 'write-plugin-files'],
}

export class WindowsUiaProvider implements TemporalContextProvider {
  readonly id = WINDOWS_UIA_PROVIDER_ID
  readonly name = WINDOWS_UIA_MANIFEST.name
  readonly version = WINDOWS_UIA_VERSION
  readonly protocolVersion = CONTEXT_PROTOCOL_VERSION
  readonly type = 'temporal-context-provider' as const

  private buffer: ContextBuffer
  private ids: ReadonlyMap<string, string>
  // Restoring one instant costs an O(elements) pass plus an O(n^2)-per-surface
  // containment scan; a scrub that settles back on a time it has already been
  // to must not pay it again. Keyed by the OBSERVATION, not by the requested
  // time, because every time in a covered interval restores the same one.
  private readonly restored = new Map<number, readonly ContextCandidate[]>()
  /**
   * Best control-bearing checkpoint per surface. Lane A is intentionally
   * budgeted per window, so one observation can be complete for A, truncated
   * for B and skipped for C. A single global "this observation has elements"
   * bit cannot describe that shape.
   */
  private readonly bestBySurface = new Map<string, ContextObservation>()
  private readonly countsByObservation = new Map<ContextObservation, ReadonlyMap<string, number>>()

  constructor(buffer: ContextBuffer, ids: ReadonlyMap<string, string>) {
    this.buffer = buffer
    this.ids = ids
    this.reindexSources()
  }

  /**
   * A dump that settled AFTER the editor opened (the helper is budgeted and
   * killed independently of the window, so on a slow machine it lands a few
   * hundred ms late). The provider swaps its buffer and Core re-issues the
   * frame — nothing else in the editor is touched.
   */
  replace(buffer: ContextBuffer, ids: ReadonlyMap<string, string>): void {
    this.buffer = buffer
    this.ids = ids
    this.restored.clear()
    this.reindexSources()
  }

  get observations(): number {
    return this.buffer.size
  }

  getSurfaceClaims(c: SurfaceClaimContext): Promise<readonly ProviderSurfaceClaim[]> {
    const { observation } = this.buffer.restore(c.timeMs)
    return Promise.resolve(this.materialization(observation, c.surfaces).claims)
  }

  frame(c: FrameContext): Promise<ProviderFrame> {
    const { observation, accuracy } = this.buffer.restore(c.timeMs)
    // CONTROLS EXIST AT EVERY FRAME, ANCHORED TO THEIR WINDOW (#111,
    // "매프레임 하위 컨트롤러도 저장해야지").
    //
    // The UIA tree is dumped ONCE, at the capture instant — a full desktop walk
    // costs 183.8 ms and cannot run per frame. But a control does not float
    // free: it is drawn INSIDE its window, at an offset that survives the
    // window being dragged. The window's position at every frame is already in
    // the ring, exact to the move hook's cadence. So the dump's controls are
    // offered at EVERY requested time, each translated by how far its OWN
    // window has moved between the dump and that time.
    //
    // What this claims and what it does not: the POSITION is composed from two
    // real observations (window at T, control-in-window at dump time), and the
    // accuracy carries `interpolated` so a strict reader can tell. The CONTENT
    // (labels, tree shape, a list that scrolled) is still the dump's — the
    // dirty-driven lane A re-dump is the next step, recorded in GOAL.md.
    const materialized = this.materialization(observation, c.surfaces, accuracy)
    if (materialized.sources.size === 0) {
      // Served, and genuinely empty. NOT `declined` — declining means "I do not
      // do frames, ask me per point instead", and answering that here would send
      // Core down the hitTest path to be told the same nothing more slowly.
      return Promise.resolve({
        providerId: this.id,
        timeMs: c.timeMs,
        accuracy,
        candidates: [],
        claims: [],
        coverage: [],
        truncated: false,
      })
    }
    const all = materialized.candidates
    const region = c.region
    const inRegion =
      region === undefined ? all : all.filter((candidate) => overlaps(candidate.bounds, region))
    const truncated = inRegion.length > c.maxCandidates
    const offered = truncated ? fairPrefix(inRegion, c.maxCandidates) : inRegion
    return Promise.resolve({
      providerId: this.id,
      // Different surfaces can legitimately come from different checkpoints;
      // the frame's clock is the requested/materialized window-stack instant.
      timeMs: c.timeMs,
      accuracy,
      candidates: offered,
      claims: materialized.claims,
      coverage: materialized.coverage,
      truncated,
    })
  }

  /**
   * Index control coverage per surface, never per observation.
   *
   * The capture-instant dump is normally the richest source, while Lane A
   * contributes temporally exact complete trees where it can and honest
   * prefixes where it cannot. A collected tree at the requested instant wins
   * even when empty; otherwise the richest available source for THAT surface
   * fills only that surface.
   */
  private reindexSources(): void {
    this.bestBySurface.clear()
    this.countsByObservation.clear()
    for (const observation of this.buffer.all) {
      const counts = this.elementCounts(observation)
      this.countsByObservation.set(observation, counts)
      for (const [surfaceId, count] of counts) {
        if (count <= 0) continue
        const previous = this.bestBySurface.get(surfaceId)
        if (previous === undefined || this.sourceScore(observation, surfaceId) > this.sourceScore(previous, surfaceId)) {
          this.bestBySurface.set(surfaceId, observation)
        }
      }
    }
  }

  private elementCounts(observation: ContextObservation): ReadonlyMap<string, number> {
    const ownerByZ = new Map<number, string>()
    let fallbackOwner: string | undefined
    for (const window of observation.windows) {
      const surfaceId = surfaceIdOf(this.ids, observation, window)
      ownerByZ.set(window.z, surfaceId)
      if (fallbackOwner === undefined || window.focused) fallbackOwner = surfaceId
    }
    const counts = new Map<string, number>()
    for (const element of observation.elements) {
      const surfaceId =
        element.window >= 0
          ? ownerByZ.get(element.window)
          : fallbackOwner
      if (surfaceId === undefined) continue
      counts.set(surfaceId, (counts.get(surfaceId) ?? 0) + 1)
    }
    return counts
  }

  private sourceScore(observation: ContextObservation, surfaceId: string): number {
    const count = this.countsByObservation.get(observation)?.get(surfaceId) ?? 0
    const state = this.treeState(observation, surfaceId)
    // A truly collected tree dominates every prefix. Otherwise candidate data
    // is evidence even when an older payload lost its tree bit, so choose the
    // richest non-complete source instead of preferring a known 32-element
    // truncation over a larger capture-instant dump.
    const completeness = state === 'collected' ? 2 : count > 0 ? 1 : 0
    return completeness * 1_000_000 + count
  }

  private treeState(
    observation: ContextObservation,
    surfaceId: string,
  ): 'collected' | 'truncated' | 'unavailable' | 'skipped' {
    let state: 'collected' | 'truncated' | 'unavailable' | 'skipped' = 'skipped'
    for (const window of observation.windows) {
      if (surfaceIdOf(this.ids, observation, window) !== surfaceId) continue
      if (window.tree === 'collected') return 'collected'
      if (window.tree === 'truncated') state = 'truncated'
      else if (window.tree === 'unavailable' && state === 'skipped') state = 'unavailable'
    }
    return state
  }

  private sourcesFor(
    current: ContextObservation | null,
    surfaceId: string,
  ): readonly ContextObservation[] {
    const fallback = this.bestBySurface.get(surfaceId)
    if (current !== null) {
      const state = this.treeState(current, surfaceId)
      const currentCount = this.countsByObservation.get(current)?.get(surfaceId) ?? 0
      // A fully walked tree is authoritative even when it honestly contains
      // zero offerable controls. Older ring payloads, however, copied
      // `hasControls: true/tree: collected` onto samples without carrying the
      // elements; that internally inconsistent shape means "data omitted",
      // not an empty tree, and still needs the per-surface fallback.
      if (
        state === 'collected' &&
        (currentCount > 0 || !this.surfaceClaimsControls(current, surfaceId))
      ) {
        return [current]
      }
      // A prefix observed at the requested checkpoint is temporal truth, but a
      // timeout after (say) 32 elements must not make controls 33..247 vanish.
      // Put the exact prefix first, then fill only missing object identities
      // from the richest capture checkpoint. Per-candidate accuracy below marks
      // those supplements as interpolated; duplicates keep the exact current
      // candidate, so future labels cannot overwrite the observed prefix.
      if (currentCount > 0) {
        return fallback === undefined || fallback === current
          ? [current]
          : [current, fallback]
      }
      if (fallback !== undefined) return [fallback]
      // Preserve an honest empty truncated/unavailable observation so coverage
      // can say "looked, incomplete" instead of pretending nobody looked.
      if (state === 'truncated' || state === 'unavailable') return [current]
    }
    return fallback === undefined ? [] : [fallback]
  }

  private surfaceClaimsControls(observation: ContextObservation, surfaceId: string): boolean {
    return observation.windows.some(
      (window) =>
        surfaceIdOf(this.ids, observation, window) === surfaceId && window.hasControls,
    )
  }

  private materialization(
    current: ContextObservation | null,
    surfaces: readonly FrameContext['surfaces'][number][],
    accuracy?: TemporalAccuracy,
  ): {
    sources: ReadonlyMap<string, readonly ContextObservation[]>
    candidates: ContextCandidate[]
    claims: ProviderSurfaceClaim[]
    coverage: Array<{ surfaceId: string; state: 'recorded' | 'truncated' | 'unavailable' | 'skipped' }>
  } {
    const sources = new Map<string, readonly ContextObservation[]>()
    for (const surface of surfaces) {
      if (sources.has(surface.surfaceId)) continue
      const selected = this.sourcesFor(current, surface.surfaceId)
      if (selected.length > 0) sources.set(surface.surfaceId, selected)
    }

    const candidates: ContextCandidate[] = []
    if (accuracy !== undefined) {
      for (const [surfaceId, selected] of sources) {
        // A UIA AutomationId is not unique: measured trees contain 17–24
        // controls sharing every identity field. Deduplicate as an ordered
        // multiset, not a Set. If the exact prefix contains 32 repeated row
        // buttons and the fallback contains 40, skip the first 32 fallback
        // occurrences and retain 33..40.
        const priorCounts = new Map<string, number>()
        for (let sourceIndex = 0; sourceIndex < selected.length; sourceIndex += 1) {
          const source = selected[sourceIndex]!
          const sourceAccuracy =
            source === current ? accuracy : { ...accuracy, interpolated: true }
          const fromSource = this.candidatesFor(source, sourceAccuracy).filter(
            (candidate) => candidate.surfaceId === surfaceId,
          )
          const sourceCounts = new Map<string, number>()
          for (const candidate of this.anchored(fromSource, source, surfaces)) {
            const key = fallbackMergeKey(candidate)
            const occurrence = (sourceCounts.get(key) ?? 0) + 1
            sourceCounts.set(key, occurrence)
            if (sourceIndex > 0 && occurrence <= (priorCounts.get(key) ?? 0)) continue
            candidates.push(candidate)
          }
          for (const [key, count] of sourceCounts) {
            priorCounts.set(key, Math.max(priorCounts.get(key) ?? 0, count))
          }
        }
      }
    }

    // Claims live on the CURRENT surface rectangle. Anchoring only candidates
    // left claims behind at the dump rectangle, so a window moved farther than
    // its own width had every real control rejected as unclaimed.
    const claims: ProviderSurfaceClaim[] = []
    const coverage: Array<{
      surfaceId: string
      state: 'recorded' | 'truncated' | 'unavailable' | 'skipped'
    }> = []
    const covered = new Set<string>()
    for (const surface of surfaces) {
      const selected = sources.get(surface.surfaceId)
      const source = selected?.[0]
      if (source === undefined) continue
      claims.push({
        providerId: this.id,
        surfaceId: surface.surfaceId,
        region: { ...surface.bounds },
        ...(surface.space === undefined ? {} : { space: surface.space }),
        ...(surface.display === undefined ? {} : { display: surface.display }),
        authority: 'accessibility',
        confidence: 1,
        ...(surface.executableName === undefined
          ? {}
          : { executableHint: surface.executableName }),
      })
      if (covered.has(surface.surfaceId)) continue
      covered.add(surface.surfaceId)
      const tree = this.treeState(source, surface.surfaceId)
      const count = this.countsByObservation.get(source)?.get(surface.surfaceId) ?? 0
      coverage.push({
        surfaceId: surface.surfaceId,
        state:
          tree === 'collected'
            ? 'recorded'
            : tree === 'truncated' || count > 0
              ? 'truncated'
              : tree,
      })
    }
    return { sources, candidates, claims, coverage }
  }

  /**
   * Translates each control candidate by how far its window moved between the
   * dump and the requested time (#111). A control whose window has no surface
   * at the requested time is DROPPED — its window is not on this desk now, and
   * a rectangle floating without its window is exactly the lie the staleness
   * ceiling exists to stop. A shifted candidate's accuracy says `interpolated`:
   * the position is composed from two observations, not read in one.
   */
  private anchored(
    candidates: readonly ContextCandidate[],
    source: ContextObservation,
    surfaces: FrameContext['surfaces'],
  ): ContextCandidate[] {
    // KEYED ON THE SURFACE, NOT ON (surface, display).
    //
    // The first version of this keyed both maps on `${surfaceId}|${display}`
    // and dropped every candidate whose key missed. It missed ALL of them: a
    // UIA dump's ELEMENTS carry no display (SPEC §8.3 — absent means "the
    // annotation's own display"), while ring WINDOWS always carry a number, so
    // the lookup asked for `abc|` and the map held `abc|0`. Measured on
    // CapturePack_2026-07-29_171046: the tracked window had 112 controls in
    // plugins/windows-uia/elements.json and every one of the pack's 7
    // annotations came out at WINDOW level — "하위 컨트롤이 선택되지 않아",
    // caused by this line rather than by anything upstream of it.
    //
    // A surface can legitimately appear once PER DISPLAY (#103), so the entries
    // are kept as a list and the display is a preference, not a key: match the
    // candidate's display when it states one, otherwise take the window's own
    // first entry and find the same display on the other side.
    type Placed = { display: number | undefined; x: number; y: number }
    const originOf = new Map<string, Placed[]>()
    for (const w of source.windows) {
      const id = surfaceIdOf(this.ids, source, w)
      const list = originOf.get(id)
      // Frame bounds are clipped independently on every display. Their x/y
      // therefore stop at zero while a straddling window is still hundreds of
      // pixels off that monitor, which under-counts the later movement by the
      // clipped amount. Client bounds are deliberately retained un-clipped by
      // ringObservations and provide the stable physical origin.
      const origin = w.client_bounds ?? w.bounds
      const entry: Placed = { display: w.display, x: origin.x, y: origin.y }
      if (list === undefined) originOf.set(id, [entry])
      else list.push(entry)
    }
    const nowOf = new Map<string, Placed[]>()
    for (const s of surfaces) {
      const list = nowOf.get(s.surfaceId)
      const origin = s.clientBounds ?? s.bounds
      const entry: Placed = { display: s.display, x: origin.x, y: origin.y }
      if (list === undefined) nowOf.set(s.surfaceId, [entry])
      else list.push(entry)
    }
    const on = (list: Placed[] | undefined, display: number | undefined): Placed | undefined => {
      if (list === undefined || list.length === 0) return undefined
      if (display === undefined) return list[0]
      return list.find((p) => p.display === display) ?? list[0]
    }
    const out: ContextCandidate[] = []
    for (const candidate of candidates) {
      const origin = on(originOf.get(candidate.surfaceId), candidate.display)
      // The SAME screen on both sides: a control shifted by another display's
      // movement would be a rectangle nobody measured, in the wrong space.
      const now = on(nowOf.get(candidate.surfaceId), candidate.display ?? origin?.display)
      if (origin === undefined || now === undefined) {
        // Window unplaceable at this time: not offered here.
        continue
      }
      const dx = now.x - origin.x
      const dy = now.y - origin.y
      if (dx === 0 && dy === 0 && now.display === candidate.display) {
        out.push(candidate)
        continue
      }
      out.push({
        ...candidate,
        bounds: { ...candidate.bounds, x: candidate.bounds.x + dx, y: candidate.bounds.y + dy },
        // A window can cross displays. Its candidate must cross with it;
        // retaining the dump display sends the shifted rectangle to the wrong
        // per-display index even when its coordinates are otherwise correct.
        ...(now.display === undefined ? {} : { display: now.display }),
        accuracy: { ...candidate.accuracy, interpolated: true },
      })
    }
    return out
  }

  /**
   * The authoritative per-point query (#66 step 4). The editor's interactive
   * hover does NOT go through here — a round trip per pointer move is exactly
   * the cost the frame() correction exists to avoid — but a click, a candidate
   * stack asked for out of band, and the regression harness do, and both paths
   * must agree. They are cross-checked in the harness for that reason.
   *
   * Note it must NOT use AutomationElement.FromPoint: that costs 1.5 ms, and it
   * answers about the LIVE desktop, which is not the desktop the user is
   * looking at.
   */
  hitTest(c: HitTestContext): Promise<readonly ContextCandidate[]> {
    const { observation, accuracy } = this.buffer.restore(c.timeMs)
    // The same anchoring as frame() (#111): both paths must agree, and the
    // harness cross-checks that they do.
    const materialized = this.materialization(observation, [c.surface], accuracy)
    const hits = materialized.candidates.filter(
      (candidate) =>
        candidate.surfaceId === c.surface.surfaceId &&
        (c.display === undefined ||
          candidate.display === undefined ||
          candidate.display === c.display) &&
        rectContains(candidate.bounds, c.point),
    )
    return Promise.resolve(hits)
  }

  private candidatesFor(
    observation: ContextObservation,
    accuracy: TemporalAccuracy,
  ): readonly ContextCandidate[] {
    const cached = this.restored.get(observation.tMs)
    if (cached !== undefined) {
      // The geometry is the same; only the temporal verdict moved with the
      // request, so it is re-stamped rather than the whole set rebuilt.
      return cached.map((candidate) => ({ ...candidate, accuracy }))
    }
    const built = candidatesOf(observation, this.ids, accuracy)
    this.restored.set(observation.tMs, built)
    return built
  }
}

/**
 * Exact checkpoint candidates are appended before fallback supplements.
 *
 * This is intentionally a BASE identity, consumed as an ordered multiset by
 * materialization(). AutomationId is not unique, and neither are class/type;
 * the occurrence number in UIA's stable pre-order is what distinguishes 40
 * same-id row buttons while still letting an exact prefix suppress the same
 * first N fallback entries.
 */
function fallbackMergeKey(candidate: ContextCandidate): string {
  const automationId = candidate.identity?.['automation_id']?.trim() ?? ''
  const className = candidate.identity?.['class_name']?.trim() ?? ''
  return `${candidate.surfaceId}\u0000${candidate.objectType}\u0000${className}\u0000${automationId}`
}

/**
 * A global candidate cap must not let one enormous accessibility tree consume
 * every slot before later applications receive even one. Preserve each
 * surface's own order while taking one candidate per surface per round.
 */
function fairPrefix(
  candidates: readonly ContextCandidate[],
  limit: number,
): ContextCandidate[] {
  if (limit <= 0) return []
  if (candidates.length <= limit) return [...candidates]
  const buckets = new Map<string, ContextCandidate[]>()
  for (const candidate of candidates) {
    const bucket = buckets.get(candidate.surfaceId)
    if (bucket === undefined) buckets.set(candidate.surfaceId, [candidate])
    else bucket.push(candidate)
  }
  const offsets = new Map<string, number>()
  const out: ContextCandidate[] = []
  while (out.length < limit) {
    let added = false
    for (const [surfaceId, bucket] of buckets) {
      const index = offsets.get(surfaceId) ?? 0
      const candidate = bucket[index]
      if (candidate === undefined) continue
      out.push(candidate)
      offsets.set(surfaceId, index + 1)
      added = true
      if (out.length >= limit) break
    }
    if (!added) break
  }
  return out
}

function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
  )
}
