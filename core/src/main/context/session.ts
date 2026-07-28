// One editor window's context session: Core's Surface Timeline, the Provider
// Host, and the frame the editor indexes.
//
// THE ORDER IS THE POINT (#66). Core restores the surface stack for the
// requested time FIRST, from its own timeline; asks who holds a CLAIM on that
// region; asks only those providers; and then enforces the staleness ceiling on
// what comes back. A provider never sees a point before Core has decided which
// surface owns it, and no provider — including the built-in one — can shortcut
// that path.
//
// DELIBERATELY FREE OF ELECTRON. Everything here is decidable from data, so the
// #58 regression harness runs the REAL frame assembly against real packs in
// plain Node rather than a reimplementation of it — which is the only way the
// measured picking quality stays a checkable assertion. `service.ts` is the
// thin Electron shell around this: windows, IPC and the log.
import type {
  ContextCandidate,
  ContextDisplayFrame,
  ContextFrame,
  ProviderSurfaceClaim,
  SurfaceCoverage,
  SurfaceInfo,
} from '../../shared/context/protocol'
import { CONTEXT_PROTOCOL_VERSION } from '../../shared/context/protocol'
import { SurfaceTimeline, surfaceStackAt } from '../../shared/context/surfaces'
import type { TimelineKind } from '../../shared/context/surfaces'
import { ContextBuffer, mintSurfaceIds, surfaceSamplesOf, windowCandidatesOf } from './buffer'
import type { ContextObservation } from './buffer'
import { ProviderHost } from './host'
import { WindowsUiaProvider } from './provider'

/** One captured display, in the pack's own indexing (SPEC §5.6). */
export interface ContextDisplayTarget {
  index: number
  focused: boolean
  width: number
  height: number
}

export interface ContextSessionOptions {
  displays: readonly ContextDisplayTarget[]
  /** The pack clock's end — the capture instant (SPEC §10.1). */
  replayDurationMs: number
  /** The capture-instant observation, or null when there is none (yet). */
  observation: ContextObservation | null
  /** The observation was attempted and produced nothing; none is coming. */
  dropped: boolean
  /** Where a provider refusal goes. Injected so this module stays Electron-free. */
  onWarn?: (message: string) => void
}

/** Candidates per frame. Generous — the reference capture's whole desk is 451. */
const MAX_CANDIDATES = 4_000

export class ContextSession {
  readonly sessionId: string
  private readonly displays: readonly ContextDisplayTarget[]
  private readonly replayDurationMs: number
  private readonly host = new ProviderHost()
  private readonly onWarn: (message: string) => void
  private provider: WindowsUiaProvider | null = null
  private timeline: SurfaceTimeline
  private ids: ReadonlyMap<string, string> = new Map()
  private observations: readonly ContextObservation[] = []
  private dropped: boolean

  constructor(sessionId: string, options: ContextSessionOptions) {
    this.sessionId = sessionId
    this.displays = options.displays
    this.replayDurationMs = options.replayDurationMs
    this.dropped = options.dropped
    this.onWarn = options.onWarn ?? ((): void => undefined)
    this.timeline = new SurfaceTimeline([], 'single-instant', {
      startMs: 0,
      endMs: options.replayDurationMs,
    })
    this.adopt(options.observation)
  }

  /**
   * Takes an observation (the first one, or a dump that settled late) and
   * rebuilds the timeline and the provider's buffer from it.
   *
   * THE KIND IS DERIVED FROM THE DATA, never assumed: one observation is a
   * single-instant record and says so for every other time; several make a
   * ring. That is what lets the same code serve a v0.1.x pack and a live
   * temporal buffer with no legacy branch anywhere above this line (design
   * §10.1).
   */
  adopt(observation: ContextObservation | null): void {
    this.adoptAll(observation === null ? [] : [observation])
  }

  /** Several observations on one clock — the shape a live buffer produces. */
  adoptAll(observations: readonly ContextObservation[]): void {
    this.observations = [...observations].sort((a, b) => a.tMs - b.tMs)
    this.ids = mintSurfaceIds(this.observations)
    const kind: TimelineKind = this.observations.length > 1 ? 'ring' : 'single-instant'
    const range = { startMs: 0, endMs: this.replayDurationMs }
    this.timeline = new SurfaceTimeline(surfaceSamplesOf(this.observations, this.ids), kind, range)
    const buffer = new ContextBuffer(this.observations, kind, range)
    if (this.provider !== null) {
      this.provider.replace(buffer, this.ids)
      return
    }
    // The built-in provider is registered through the SAME registry an external
    // one would use, with the same protocol version check and the same
    // permission gate. A refusal here is a real refusal: picking then falls to
    // Core's window level and the log says why.
    const provider = new WindowsUiaProvider(buffer, this.ids)
    const outcome = this.host.register(provider)
    if (!outcome.ok) {
      this.onWarn(`context: provider refused (${outcome.reason}): ${outcome.detail}`)
      return
    }
    this.provider = provider
  }

  markDropped(dropped: boolean): void {
    this.dropped = dropped
  }

  get providerIds(): readonly string[] {
    return this.host.ids
  }

  /**
   * THE FRAME AT ONE TIME. Steps 1-6 of #66's algorithm; the editor's index
   * does 7 and 8 over it, at the point the pointer is actually on.
   */
  async frameAt(timeMs: number): Promise<ContextFrame> {
    // 1. restore the surface stack at T, from CORE's timeline — before any
    //    provider is asked anything at all.
    const restored = this.timeline.restore(timeMs)
    const surfaces = restored.sample?.surfaces ?? []
    // 3. who holds a claim at this time? Claims are time-varying: a window did
    //    not exist at T-20 s, and a provider that has nothing to say about a
    //    surface must not be asked about it (#66, design GAP 8).
    const claims = await this.host.claims({ sessionId: this.sessionId, timeMs, surfaces })
    const claimants = new Set(claims.map((claim) => claim.providerId))
    // 4. ask only the claimants, in parallel, each with its own budget.
    const result = await this.host.frames(
      { sessionId: this.sessionId, timeMs, surfaces, maxCandidates: MAX_CANDIDATES },
      [...claimants],
    )
    const providerCandidates: ContextCandidate[] = []
    const coverage: SurfaceCoverage[] = []
    const frameClaims: ProviderSurfaceClaim[] = [...claims]
    for (const frame of result.frames) {
      providerCandidates.push(...frame.candidates)
      coverage.push(...frame.coverage)
    }
    // Core's own WINDOW rung, minted from the surface sample rather than from
    // any provider: the floor of the ladder, and the reason "no candidate at
    // all" only ever happens on bare desktop (#66 step 8).
    const sample = restored.sample
    const windowCandidates =
      sample === null
        ? []
        : windowCandidatesOf(this.observationAt(sample.tMs), this.ids, restored.accuracy)
    // 5b. THE STALENESS CEILING (design GAP 16). Deleting the v0.1.7 gate
    //     without this would only move the lie from "picking is off" to "here is
    //     a rectangle from nine seconds ago": a candidate whose covering
    //     observation does not actually cover the requested time is NOT offered,
    //     and the frame carries the verdict so the editor can say which of the
    //     several possible reasons applies.
    const offerable = [...providerCandidates, ...windowCandidates].filter(
      (candidate) => candidate.accuracy.coverage === 'covered',
    )
    return {
      sessionId: this.sessionId,
      protocolVersion: CONTEXT_PROTOCOL_VERSION,
      requestedTimeMs: timeMs,
      accuracy: restored.accuracy,
      displays: this.split(offerable, surfaces, coverage),
      providers: result.statuses,
      claims: frameClaims,
      pending: result.pending,
      dropped: this.dropped,
    }
  }

  /**
   * THE AUTHORITATIVE PER-POINT QUERY (#66 step 4), over the same restored
   * surface stack a frame is built from.
   *
   * The editor's interactive hover deliberately does NOT come through here — a
   * round trip per pointer move is exactly the cost `frame()` exists to avoid —
   * so this is the low-rate path: a consumer that has a point but no frame, and
   * the regression harness, which cross-checks that the two agree. Two answers
   * that could drift apart unnoticed would make the protocol's own contract
   * unfalsifiable.
   */
  async hitTest(
    timeMs: number,
    point: { x: number; y: number },
    display?: number,
  ): Promise<readonly ContextCandidate[]> {
    const restored = this.timeline.restore(timeMs)
    const surfaces = restored.sample?.surfaces ?? []
    const stack = surfaceStackAt(surfaces, point, display)
    const surface = stack[0]
    if (surface === undefined) return []
    const claims = await this.host.claims({ sessionId: this.sessionId, timeMs, surfaces })
    const claimants = new Set(claims.map((claim) => claim.providerId))
    const hits = await this.host.hitTest(
      {
        sessionId: this.sessionId,
        timeMs,
        point,
        space: 'display-snapshot',
        display,
        surface,
      },
      [...claimants],
    )
    return hits.filter((candidate) => candidate.accuracy.coverage === 'covered')
  }

  private observationAt(tMs: number): ContextObservation {
    const found = this.observations.find((o) => o.tMs === tMs)
    return found ?? { tMs, windows: [], elements: [] }
  }

  /**
   * One slice per captured display, each in THAT display's snapshot pixel space
   * (SPEC §8.2 / §11.3). Every screen of the board is annotatable, so a single
   * space could only ever answer for one of them.
   */
  private split(
    candidates: readonly ContextCandidate[],
    surfaces: readonly SurfaceInfo[],
    coverage: readonly SurfaceCoverage[],
  ): ContextDisplayFrame[] {
    const focused = this.displays.find((d) => d.focused)?.index ?? 1
    const displayOf = (value: number | undefined): number =>
      typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : focused
    return this.displays.map((display) => ({
      display: display.index,
      width: display.width,
      height: display.height,
      surfaces: surfaces
        .filter((s) => displayOf(s.display) === display.index)
        .sort((a, b) => a.zOrder - b.zOrder),
      candidates: candidates.filter((c) => displayOf(c.display) === display.index),
      coverage,
    }))
  }
}
