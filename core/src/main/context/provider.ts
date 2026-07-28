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
  ProviderPermission,
  ProviderSurfaceClaim,
  SurfaceClaimContext,
  TemporalAccuracy,
  TemporalContextProvider,
} from '../../shared/context/protocol'
import { CONTEXT_PROTOCOL_VERSION } from '../../shared/context/protocol'
import { rectContains } from '../../shared/context/surfaces'
import type { ContextBuffer, ContextObservation } from './buffer'
import { candidatesOf, claimsOf, surfaceCoverageOf, WINDOWS_UIA_PROVIDER_ID } from './buffer'

export class WindowsUiaProvider implements TemporalContextProvider {
  readonly id = WINDOWS_UIA_PROVIDER_ID
  readonly name = 'Windows UI Automation'
  readonly version = '0.4.0'
  readonly protocolVersion = CONTEXT_PROTOCOL_VERSION
  readonly type = 'temporal-context-provider' as const
  readonly permissions: readonly ProviderPermission[] = ['read-active-window', 'write-plugin-files']

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
  }

  get observations(): number {
    return this.buffer.size
  }

  getSurfaceClaims(c: SurfaceClaimContext): Promise<readonly ProviderSurfaceClaim[]> {
    const { observation } = this.buffer.restore(c.timeMs)
    if (observation === null) return Promise.resolve([])
    return Promise.resolve(claimsOf(observation, this.ids))
  }

  frame(c: FrameContext): Promise<ProviderFrame> {
    const { observation, accuracy } = this.buffer.restore(c.timeMs)
    if (observation === null) {
      return Promise.resolve({
        providerId: this.id,
        served: true,
        timeMs: c.timeMs,
        accuracy,
        candidates: [],
        claims: [],
        coverage: [],
        truncated: false,
      })
    }
    const all = this.candidatesFor(observation, accuracy)
    const region = c.region
    const inRegion =
      region === undefined ? all : all.filter((candidate) => overlaps(candidate.bounds, region))
    const truncated = inRegion.length > c.maxCandidates
    return Promise.resolve({
      providerId: this.id,
      served: true,
      timeMs: observation.tMs,
      accuracy,
      candidates: truncated ? inRegion.slice(0, c.maxCandidates) : inRegion,
      claims: claimsOf(observation, this.ids),
      coverage: surfaceCoverageOf(observation, this.ids),
      truncated,
    })
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
    if (observation === null) return Promise.resolve([])
    const hits = this.candidatesFor(observation, accuracy).filter(
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
