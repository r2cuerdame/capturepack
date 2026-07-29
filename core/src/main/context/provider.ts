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
import { candidatesOf, claimsOf, surfaceCoverageOf, surfaceIdOf, WINDOWS_UIA_PROVIDER_ID } from './buffer'

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

  constructor(buffer: ContextBuffer, ids: ReadonlyMap<string, string>) {
    this.buffer = buffer
    this.ids = ids
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
    this.elementObs = undefined
  }

  get observations(): number {
    return this.buffer.size
  }

  getSurfaceClaims(c: SurfaceClaimContext): Promise<readonly ProviderSurfaceClaim[]> {
    const { observation } = this.buffer.restore(c.timeMs)
    // Claims must come from the observation that HOLDS the dump (#111):
    // anchored candidates exist at every time, so a claim answered from a
    // ring observation with no elements would tell Core not to ask — and the
    // whole anchored answer would silently never be offered.
    const source = observation !== null && observation.elements.length > 0
      ? observation
      : this.elementObservation()
    if (source === null) return Promise.resolve([])
    return Promise.resolve(claimsOf(source, this.ids))
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
    const source = observation !== null && observation.elements.length > 0
      ? observation
      : this.elementObservation()
    if (source === null) {
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
    const all = this.anchored(this.candidatesFor(source, accuracy), source, c.surfaces)
    const region = c.region
    const inRegion =
      region === undefined ? all : all.filter((candidate) => overlaps(candidate.bounds, region))
    const truncated = inRegion.length > c.maxCandidates
    return Promise.resolve({
      providerId: this.id,
      timeMs: source.tMs,
      accuracy,
      candidates: truncated ? inRegion.slice(0, c.maxCandidates) : inRegion,
      claims: claimsOf(source, this.ids),
      coverage: surfaceCoverageOf(source, this.ids),
      truncated,
    })
  }

  /** The one observation that carries the control dump, or null. Cached. */
  private elementObs: ContextObservation | null | undefined
  private elementObservation(): ContextObservation | null {
    if (this.elementObs !== undefined) return this.elementObs
    this.elementObs = this.buffer.all.find((o) => o.elements.length > 0) ?? null
    return this.elementObs
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
    const originOf = new Map<string, { x: number; y: number }>()
    for (const w of source.windows) {
      const id = surfaceIdOf(this.ids, source, w)
      originOf.set(`${id}|${w.display ?? ''}`, { x: w.bounds.x, y: w.bounds.y })
    }
    const nowOf = new Map<string, { x: number; y: number }>()
    for (const s of surfaces) {
      nowOf.set(`${s.surfaceId}|${s.display ?? ''}`, { x: s.bounds.x, y: s.bounds.y })
    }
    const out: ContextCandidate[] = []
    for (const candidate of candidates) {
      const key = `${candidate.surfaceId}|${candidate.display ?? ''}`
      const origin = originOf.get(key)
      const now = nowOf.get(key)
      if (origin === undefined || now === undefined) {
        // Window unplaceable at this time on this display: not offered here.
        continue
      }
      const dx = now.x - origin.x
      const dy = now.y - origin.y
      if (dx === 0 && dy === 0) {
        out.push(candidate)
        continue
      }
      out.push({
        ...candidate,
        bounds: { ...candidate.bounds, x: candidate.bounds.x + dx, y: candidate.bounds.y + dy },
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
    const source = observation !== null && observation.elements.length > 0
      ? observation
      : this.elementObservation()
    if (source === null) return Promise.resolve([])
    const hits = this.anchored(this.candidatesFor(source, accuracy), source, [c.surface]).filter(
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

function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
  )
}
