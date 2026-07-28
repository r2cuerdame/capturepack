// The Provider Host: registry, protocol_version check, permission gate,
// timeouts, failure isolation (#64).
//
// NO PLUGIN FAILURE MAY EVER COST A CAPTURE (GOAL). A provider that throws,
// hangs or returns nonsense produces a STATUS here and nothing else: the editor
// opens, the replay scrubs, manual rectangles work, the pack saves, and the
// save screen says which context is missing rather than pretending it is
// complete.
//
// TIMEOUTS ARE BUDGETS, NOT SUGGESTIONS (GOAL). A slow provider must never hold
// the editor shut, so a frame request resolves when the budget expires with
// whatever answered in time; a late answer arrives as a NEW frame instead of
// delaying the first paint.
import type {
  ContextCandidate,
  FrameContext,
  HitTestContext,
  ProviderFrame,
  ProviderFrameStatus,
  ProviderPermission,
  ProviderSurfaceClaim,
  SurfaceClaimContext,
  TemporalContextProvider,
} from '../../shared/context/protocol'
import { CONTEXT_PROTOCOL_VERSION, PROVIDER_BUDGET_MS } from '../../shared/context/protocol'

/** The fixed permission set (#64). Anything else is refused, not ignored. */
const PERMISSIONS: readonly ProviderPermission[] = [
  'read-pack',
  'write-plugin-files',
  'network',
  'run-process',
  'read-browser-context',
  'read-active-window',
  'native-messaging',
  'create-zip',
  'open-browser',
]

export type RegistrationOutcome =
  | { ok: true }
  | { ok: false; reason: 'protocol-version'; detail: string }
  | { ok: false; reason: 'permission'; detail: string }
  | { ok: false; reason: 'duplicate-id'; detail: string }

export interface ProviderFrameResult {
  frames: readonly ProviderFrame[]
  statuses: readonly ProviderFrameStatus[]
  /** A provider is still working and a replacement frame will follow. */
  pending: boolean
}

export class ProviderHost {
  private readonly providers = new Map<string, TemporalContextProvider>()

  /**
   * STRICT, and refused with a clear message rather than half-working (#64):
   * the protocol is explicitly unstable, so a provider built against another
   * version is not "probably fine", it is a provider whose answers Core cannot
   * interpret.
   */
  register(provider: TemporalContextProvider): RegistrationOutcome {
    if (provider.protocolVersion !== CONTEXT_PROTOCOL_VERSION) {
      return {
        ok: false,
        reason: 'protocol-version',
        detail: `${provider.id} speaks protocol ${provider.protocolVersion}; this build speaks ${CONTEXT_PROTOCOL_VERSION}`,
      }
    }
    for (const permission of provider.permissions) {
      if (!PERMISSIONS.includes(permission)) {
        return {
          ok: false,
          reason: 'permission',
          detail: `${provider.id} declares unknown permission "${permission}"`,
        }
      }
    }
    if (this.providers.has(provider.id)) {
      return { ok: false, reason: 'duplicate-id', detail: `${provider.id} is already registered` }
    }
    this.providers.set(provider.id, provider)
    return { ok: true }
  }

  get(id: string): TemporalContextProvider | null {
    return this.providers.get(id) ?? null
  }

  get ids(): readonly string[] {
    return [...this.providers.keys()]
  }

  /**
   * Ask every provider for its candidates in one rect at one time, in parallel,
   * each with its own budget. One provider's failure never touches another's
   * answer — which is the difference between "the Chrome extension is
   * disconnected" and "picking is broken".
   */
  async frames(c: FrameContext, providerIds?: readonly string[]): Promise<ProviderFrameResult> {
    const frames: ProviderFrame[] = []
    const statuses: ProviderFrameStatus[] = []
    let pending = false
    // ONLY THE PROVIDERS HOLDING A CLAIM (#66 step 3). A provider with nothing
    // to say about any surface at this time is not asked at all — which is what
    // keeps "ask every provider about every point" off the prohibited list.
    const asked = [...this.providers.values()].filter(
      (provider) => providerIds === undefined || providerIds.includes(provider.id),
    )
    await Promise.all(
      asked.map(async (provider) => {
        const startedAt = Date.now()
        const outcome = await budgeted(provider.frame(c), PROVIDER_BUDGET_MS.frame)
        const elapsedMs = Date.now() - startedAt
        if (outcome.kind === 'timeout') {
          pending = true
          statuses.push(status(provider, 'timeout', elapsedMs))
          return
        }
        if (outcome.kind === 'error') {
          statuses.push(status(provider, 'error', elapsedMs))
          return
        }
        const frame = outcome.value
        if (!frame.served) {
          statuses.push(status(provider, 'declined', elapsedMs))
          return
        }
        frames.push(frame)
        statuses.push({
          providerId: provider.id,
          name: provider.name,
          state: 'ok',
          coverage: frame.accuracy.coverage,
          errorMs: frame.accuracy.errorMs,
          candidates: frame.candidates.length,
          truncated: frame.truncated,
          elapsedMs,
        })
      }),
    )
    return { frames, statuses, pending }
  }

  /** The authoritative per-point query, same isolation, its own budget. */
  async hitTest(
    c: HitTestContext,
    providerIds?: readonly string[],
  ): Promise<readonly ContextCandidate[]> {
    const out: ContextCandidate[] = []
    const asked = [...this.providers.values()].filter(
      (provider) => providerIds === undefined || providerIds.includes(provider.id),
    )
    await Promise.all(
      asked.map(async (provider) => {
        const outcome = await budgeted(provider.hitTest(c), PROVIDER_BUDGET_MS.hitTest)
        if (outcome.kind !== 'value') return
        out.push(...outcome.value)
      }),
    )
    return out
  }

  /** Claims, asked before anyone is hit-tested (#66 step 3). */
  async claims(c: SurfaceClaimContext): Promise<readonly ProviderSurfaceClaim[]> {
    const out: ProviderSurfaceClaim[] = []
    await Promise.all(
      [...this.providers.values()].map(async (provider) => {
        const outcome = await budgeted(provider.getSurfaceClaims(c), PROVIDER_BUDGET_MS.claims)
        if (outcome.kind !== 'value') return
        out.push(...outcome.value)
      }),
    )
    return out
  }
}

function status(
  provider: TemporalContextProvider,
  state: ProviderFrameStatus['state'],
  elapsedMs: number,
): ProviderFrameStatus {
  return {
    providerId: provider.id,
    name: provider.name,
    state,
    coverage: 'none',
    errorMs: 0,
    candidates: 0,
    truncated: false,
    elapsedMs,
  }
}

type Budgeted<T> = { kind: 'value'; value: T } | { kind: 'timeout' } | { kind: 'error' }

/**
 * The budget, enforced. A provider that never settles leaves a timer behind and
 * nothing else — Core has already moved on, and its answer, if it ever comes,
 * updates the candidate list as a later frame.
 */
async function budgeted<T>(work: Promise<T>, budgetMs: number): Promise<Budgeted<T>> {
  let timer: NodeJS.Timeout | undefined
  const expiry = new Promise<Budgeted<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), budgetMs)
    // A pending budget timer must never be the reason the app stays alive.
    timer.unref?.()
  })
  try {
    return await Promise.race([
      work.then<Budgeted<T>>((value) => ({ kind: 'value', value })),
      expiry,
    ])
  } catch {
    // Isolation: a provider throwing is a provider status, never an exception
    // that reaches the capture, the editor or the save.
    return { kind: 'error' }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
