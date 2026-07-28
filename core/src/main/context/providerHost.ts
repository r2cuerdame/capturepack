// The Provider Host (issue #64): registry, manifest and protocol_version check,
// permission gate, lifecycle dispatch, timeouts, failure isolation, the memory
// governor, and the execution log.
//
// THE PROMISE THIS FILE KEEPS (GOAL.md): "No plugin failure may ever cost a
// capture. A disconnected Chrome extension, a timed-out UIA Provider, an
// incompatible Unreal build — replay, snapshot, manual rectangles, annotation,
// folder save and annotated replay all still work, and the save screen says
// which context is missing rather than pretending it is complete."
//
// So every single call into a provider goes through `invoke()` below, and
// `invoke()` cannot throw, cannot hang and cannot return a wrong-shaped answer.
// A provider that misbehaves is disabled BY NAME with a reason a human can read
// in Settings > Plugins — never silently ignored, because "silence is not
// absence" is the failure this project has already shipped two releases about.
//
// AND THE ONE THIS FILE EXISTS TO MAKE ENFORCEABLE (#64, GOAL.md): Windows UI
// Automation is the REFERENCE IMPLEMENTATION of this protocol and registers
// through this same registry, with a real manifest, the same timeouts and the
// same isolation. It differs from an installed provider in exactly two ways,
// both about MAINTENANCE and neither about CAPABILITY: it is enabled by default
// and it cannot be uninstalled — because with no plugin installed at all,
// hovering any window must still offer something, and that guarantee cannot
// depend on a third party.
//
// TIMEOUTS DO NOT CANCEL. JavaScript cannot abort a promise, so a call that
// overruns its budget is ABANDONED: the caller is told "timeout" on time, and
// whatever the provider eventually returns is discarded rather than applied to a
// UI that has moved on. That is the honest reading of "a slow Provider must
// never hold the editor shut".

import type {
  BufferFreezeContext,
  BufferReleaseContext,
  ContextCandidate,
  FrameContext,
  HitTestContext,
  MaterializeContext,
  ProviderExportContext,
  ProviderExportResult,
  ProviderFrame,
  ProviderRunState,
  ProviderState,
  ProviderSurfaceClaim,
  SurfaceClaimContext,
  SurfaceInfo,
  TemporalAccuracy,
  TemporalContextProvider,
  TickAck,
  TrackContext,
  ObjectTrack,
} from '../../shared/context/protocol'
import {
  isSupportedProtocolVersion,
  CONTEXT_PROTOCOL_VERSION,
  PROVIDER_MEMORY_BUDGET_BYTES,
  PROVIDER_TIMEOUTS,
} from '../../shared/context/protocol'
import type { ProviderManifest, ProviderPermission } from '../../shared/context/manifest'
import { logInfo, logWarn } from '../log'
import { ClockOffsetEstimator, type SessionClock } from './clock'

/**
 * Consecutive failed calls before a provider is disabled. One timeout is a busy
 * machine; five in a row is a provider that does not work, and continuing to ask
 * it costs the editor its budget on every hover.
 */
const MAX_CONSECUTIVE_FAILURES = 5
/** Consecutive ticks over the memory budget before a provider is disabled (GAP 4). */
const MAX_BUDGET_STRIKES = 3
/** Core ticks at 1 Hz — see `tick()`. */
export const TICK_INTERVAL_MS = 1_000
/** How many execution-log entries are kept. Enough to explain a session, small enough to hold. */
const EXECUTION_LOG_SIZE = 200

export type CallOutcome = 'ok' | 'timeout' | 'error' | 'refused'

export interface ExecutionLogEntry {
  timeMs: number
  providerId: string
  method: string
  durationMs: number
  outcome: CallOutcome
  detail?: string
}

/** What Settings > Plugins renders, per provider, FROM REALITY (issue #57's rule). */
export interface ProviderStatus {
  id: string
  name: string
  version: string
  builtIn: boolean
  enabled: boolean
  state: ProviderRunState
  permissions: ProviderPermission[]
  bufferedFromMs: number | null
  bufferedToMs: number | null
  resolutionMs: number | null
  bytes: number | null
  budgetBytes: number
  /** `providerClock - coreClock`, measured (GAP 3). null when never measured. */
  clockOffsetMs: number | null
  /** Half the measured round trip to this provider; Infinity when never measured. */
  clockErrorMs: number
  lastError: string | null
  disabledReason: string | null
}

export type RegisterResult =
  | { ok: true }
  | { ok: false; reason: string }

interface Entry {
  manifest: ProviderManifest
  provider: TemporalContextProvider
  builtIn: boolean
  enabled: boolean
  state: ProviderRunState
  memoryBudgetBytes: number
  offset: ClockOffsetEstimator
  lastAck: TickAck | null
  failures: number
  budgetStrikes: number
  lastError: string | null
  disabledReason: string | null
  started: boolean
}

export class ProviderHost {
  private readonly clock: SessionClock
  private readonly entries = new Map<string, Entry>()
  private readonly executionLog: ExecutionLogEntry[] = []

  constructor(clock: SessionClock) {
    this.clock = clock
  }

  /**
   * Registers a provider against its manifest. STRICT (#64): a mismatch between
   * what the manifest declares and what the object actually is, or a protocol
   * version this build does not speak, is a REFUSAL with a message — never a
   * best-effort registration that half-works.
   */
  register(
    manifest: ProviderManifest,
    provider: TemporalContextProvider,
    options: { builtIn?: boolean; enabled?: boolean; memoryBudgetBytes?: number } = {},
  ): RegisterResult {
    if (this.entries.has(manifest.id)) {
      return { ok: false, reason: `a provider with id "${manifest.id}" is already registered` }
    }
    if (provider.id !== manifest.id) {
      return {
        ok: false,
        reason: `provider id "${provider.id}" does not match its manifest id "${manifest.id}"`,
      }
    }
    if (provider.type !== 'temporal-context-provider') {
      return { ok: false, reason: `provider "${manifest.id}" is not a temporal-context-provider` }
    }
    // Checked on BOTH sides: a manifest is a text file that can be edited to say
    // anything, and the code is what actually speaks the protocol.
    if (!isSupportedProtocolVersion(provider.protocolVersion)) {
      return {
        ok: false,
        reason:
          `provider "${manifest.id}" speaks protocol ${provider.protocolVersion}, this build speaks ` +
          `${CONTEXT_PROTOCOL_VERSION} — the temporal provider protocol is explicitly unstable`,
      }
    }
    if (provider.protocolVersion !== manifest.protocolVersion) {
      return {
        ok: false,
        reason:
          `provider "${manifest.id}" speaks protocol ${provider.protocolVersion} but its manifest ` +
          `declares ${manifest.protocolVersion}`,
      }
    }
    const entry: Entry = {
      manifest,
      provider,
      builtIn: options.builtIn === true,
      enabled: options.enabled !== false,
      state: 'starting',
      memoryBudgetBytes: options.memoryBudgetBytes ?? PROVIDER_MEMORY_BUDGET_BYTES,
      offset: new ClockOffsetEstimator(),
      lastAck: null,
      failures: 0,
      budgetStrikes: 0,
      lastError: null,
      disabledReason: null,
      started: false,
    }
    this.entries.set(manifest.id, entry)
    logInfo(
      `[context] provider registered: ${manifest.id} ${manifest.version} ` +
        `(${entry.builtIn ? 'built-in' : 'installed'}, permissions: ` +
        `${manifest.permissions.length === 0 ? 'none' : manifest.permissions.join(', ')})`,
    )
    return { ok: true }
  }

  unregister(id: string): void {
    this.entries.delete(id)
  }

  /**
   * The permission gate. A permission the user was never shown is a permission
   * they never granted, so this is the ONLY way any capability is reached — and
   * a denial is logged rather than silently returning nothing (GOAL.md
   * "Permissions are declared and shown").
   */
  hasPermission(id: string, permission: ProviderPermission): boolean {
    const entry = this.entries.get(id)
    if (entry === undefined) return false
    const granted = entry.manifest.permissions.includes(permission)
    if (!granted) {
      logWarn(`[context] provider ${id} asked for "${permission}" which it did not declare — denied`)
    }
    return granted
  }

  setEnabled(id: string, enabled: boolean): void {
    const entry = this.entries.get(id)
    if (entry === undefined) return
    entry.enabled = enabled
    if (enabled) {
      entry.disabledReason = null
      entry.failures = 0
      entry.budgetStrikes = 0
      entry.state = 'starting'
      entry.started = false
    }
  }

  statuses(): ProviderStatus[] {
    return [...this.entries.values()].map((entry) => ({
      id: entry.manifest.id,
      name: entry.manifest.name,
      version: entry.manifest.version,
      builtIn: entry.builtIn,
      enabled: entry.enabled,
      state: entry.state,
      permissions: [...entry.manifest.permissions],
      bufferedFromMs: entry.lastAck?.bufferedFromMs ?? null,
      bufferedToMs: entry.lastAck?.bufferedToMs ?? null,
      resolutionMs: entry.lastAck?.resolutionMs ?? null,
      bytes: entry.lastAck?.bytes ?? null,
      budgetBytes: entry.memoryBudgetBytes,
      clockOffsetMs: entry.offset.offsetMs(),
      clockErrorMs: entry.offset.hasMeasurement()
        ? entry.offset.errorBoundMs()
        : Number.POSITIVE_INFINITY,
      lastError: entry.lastError,
      disabledReason: entry.disabledReason,
    }))
  }

  executionLogEntries(): ExecutionLogEntry[] {
    return [...this.executionLog]
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** `onBufferStart` for every provider that has not had one yet. */
  async bufferStart(): Promise<void> {
    const clock = this.clock.snapshot()
    await Promise.all(
      this.active().map(async (entry) => {
        if (entry.started) return
        entry.started = true
        const start = entry.provider.onBufferStart
        if (start === undefined) return
        await this.invoke(entry, 'onBufferStart', PROVIDER_TIMEOUTS.lifecycle, () =>
          start.call(entry.provider, {
            sessionId: clock.sessionId,
            startedAtMs: clock.nowMs,
            retentionMs: this.clock.getRetentionMs(),
            memoryBudgetBytes: entry.memoryBudgetBytes,
          }),
        )
      }),
    )
  }

  /**
   * ONE TICK, AT 1 Hz — deliberately not the sampling rate.
   *
   * A naive implementation ticks at 10 Hz and thereby forces ten IPC round trips
   * per second per provider, forever, for nothing: the tick is NOT an order to
   * sample (GOAL.md). Its job is to hand out the clock, carry the current
   * retention window so a Settings change mid-session is observable without a
   * session restart (GAP 2), and collect the `TickAck` that is the provider's
   * only channel back to Core (GAP 1) and the only measurement of its clock
   * (GAP 3). Each provider samples at its own rate, on its own timer.
   */
  async tick(): Promise<void> {
    const clock = this.clock.snapshot()
    await Promise.all(
      this.active().map(async (entry) => {
        const onTick = entry.provider.onTick
        if (onTick === undefined) return
        const sentAtMs = this.clock.nowMs()
        const result = await this.invoke(entry, 'onTick', PROVIDER_TIMEOUTS.lifecycle, () =>
          onTick.call(entry.provider, {
            sessionId: clock.sessionId,
            timeMs: clock.nowMs,
            bufferStartMs: clock.bufferStartMs,
            bufferEndMs: clock.bufferEndMs,
            sentAtMs,
          }),
        )
        if (result === null) {
          // No ack: the provider's clock is UNMEASURED, not "in sync". Its
          // candidates are marked approximate wherever accuracy is folded.
          entry.state = entry.enabled ? 'disconnected' : entry.state
          return
        }
        const replyAtMs = this.clock.nowMs()
        entry.offset.observe(sentAtMs, result.receivedAtLocalMs, result.providerLocalMs, replyAtMs)
        entry.lastAck = result
        entry.state = result.state
        if (typeof result.detail === 'string' && result.detail !== '') entry.lastError = result.detail
        this.enforceMemoryBudget(entry, result)
      }),
    )
  }

  async prune(beforeTimeMs: number): Promise<void> {
    const sessionId = this.clock.sessionId
    await Promise.all(
      this.active().map(async (entry) => {
        const onPrune = entry.provider.onPrune
        if (onPrune === undefined) return
        await this.invoke(entry, 'onPrune', PROVIDER_TIMEOUTS.lifecycle, () =>
          onPrune.call(entry.provider, { sessionId, beforeTimeMs }),
        )
      }),
    )
  }

  /** Pins a range in every provider (#64 `onFreeze`). Ref-counted by `freezeId` (GAP 5). */
  async freeze(freezeId: string, startMs: number, endMs: number): Promise<void> {
    const context: BufferFreezeContext = {
      sessionId: this.clock.sessionId,
      freezeId,
      range: { startMs, endMs },
    }
    await Promise.all(
      this.active().map(async (entry) => {
        const onFreeze = entry.provider.onFreeze
        if (onFreeze === undefined) return
        await this.invoke(entry, 'onFreeze', PROVIDER_TIMEOUTS.lifecycle, () =>
          onFreeze.call(entry.provider, context),
        )
      }),
    )
  }

  async release(freezeId: string): Promise<void> {
    const context: BufferReleaseContext = { sessionId: this.clock.sessionId, freezeId }
    await Promise.all(
      this.active().map(async (entry) => {
        const onRelease = entry.provider.onRelease
        if (onRelease === undefined) return
        await this.invoke(entry, 'onRelease', PROVIDER_TIMEOUTS.lifecycle, () =>
          onRelease.call(entry.provider, context),
        )
      }),
    )
  }

  // -------------------------------------------------------------------------
  // Queries — every one of them isolated, budgeted and in parallel
  // -------------------------------------------------------------------------

  /** Which providers claim something on this stack at this time. */
  async claims(timeMs: number, surfaces: SurfaceInfo[]): Promise<ProviderSurfaceClaim[]> {
    const context: SurfaceClaimContext = { sessionId: this.clock.sessionId, timeMs, surfaces }
    const results = await Promise.all(
      this.active().map((entry) =>
        this.invoke(entry, 'getSurfaceClaims', PROVIDER_TIMEOUTS.claims, () =>
          entry.provider.getSurfaceClaims(context),
        ),
      ),
    )
    return results.flatMap((claims) => claims ?? [])
  }

  /**
   * Ask the named providers about one point. In PARALLEL, each with its own
   * budget: one slow provider must not add its latency to a fast one's.
   */
  async hitTest(providerIds: readonly string[], context: HitTestContext): Promise<ContextCandidate[]> {
    const entries = providerIds
      .map((id) => this.entries.get(id))
      .filter((entry): entry is Entry => entry !== undefined && this.isActive(entry))
    const results = await Promise.all(
      entries.map((entry) =>
        this.invoke(entry, 'hitTest', PROVIDER_TIMEOUTS.hitTest, () => entry.provider.hitTest(context)),
      ),
    )
    return results.flatMap((candidates) => candidates ?? [])
  }

  async materialize(providerId: string, context: MaterializeContext): Promise<ProviderState | null> {
    const entry = this.entries.get(providerId)
    if (entry === undefined || !this.isActive(entry)) return null
    const state = await this.invoke(entry, 'materialize', PROVIDER_TIMEOUTS.materialize, () =>
      entry.provider.materialize(context),
    )
    if (state === null) return null
    return { ...state, accuracy: this.foldClockError(entry, state.accuracy) }
  }

  /**
   * The interactive-hover path (GAP 7). A provider that does not implement
   * `frame` is not broken — Core degrades to hit-test-on-hover-settle — so a
   * missing method returns a DECLINED frame rather than an error.
   */
  async frame(providerId: string, context: FrameContext): Promise<ProviderFrame | null> {
    const entry = this.entries.get(providerId)
    if (entry === undefined || !this.isActive(entry)) return null
    const method = entry.provider.frame
    if (method === undefined) {
      return {
        providerId,
        timeMs: context.timeMs,
        accuracy: {
          requestedTimeMs: context.timeMs,
          materializedTimeMs: context.timeMs,
          errorMs: 0,
          exact: false,
          coverage: 'none',
        },
        candidates: [],
        truncated: false,
        declined: true,
      }
    }
    const frame = await this.invoke(entry, 'frame', PROVIDER_TIMEOUTS.frame, () =>
      method.call(entry.provider, context),
    )
    if (frame === null) return null
    return { ...frame, accuracy: this.foldClockError(entry, frame.accuracy) }
  }

  async track(providerId: string, context: TrackContext): Promise<ObjectTrack | null> {
    const entry = this.entries.get(providerId)
    if (entry === undefined || !this.isActive(entry)) return null
    const track = await this.invoke(entry, 'track', PROVIDER_TIMEOUTS.track, () =>
      entry.provider.track(context),
    )
    if (track === null) return null
    return { ...track, accuracy: this.foldClockError(entry, track.accuracy) }
  }

  async export(providerId: string, context: ProviderExportContext): Promise<ProviderExportResult | null> {
    const entry = this.entries.get(providerId)
    if (entry === undefined || !this.isActive(entry)) return null
    return this.invoke(entry, 'export', PROVIDER_TIMEOUTS.export, () => entry.provider.export(context))
  }

  /** Every provider that could answer right now. */
  activeIds(): string[] {
    return this.active().map((entry) => entry.manifest.id)
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private active(): Entry[] {
    return [...this.entries.values()].filter((entry) => this.isActive(entry))
  }

  private isActive(entry: Entry): boolean {
    return entry.enabled && entry.disabledReason === null
  }

  /**
   * THE isolation boundary. Everything a provider is asked goes through here.
   * Returns null for every kind of failure — the caller never has to distinguish
   * a timeout from a throw from a provider that was disabled a moment ago,
   * because in all three cases the honest answer is "this provider has nothing
   * for you" and the fallback ladder continues below it.
   */
  private async invoke<T>(
    entry: Entry,
    method: string,
    budgetMs: number,
    call: () => Promise<T>,
  ): Promise<T | null> {
    if (!this.isActive(entry)) return null
    const startedAt = this.clock.nowMs()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race<T | typeof TIMED_OUT>([
        // A provider that throws SYNCHRONOUSLY (a bad `this`, a missing field)
        // would escape a bare call; Promise.resolve().then defers it into the
        // same rejection path as an async failure.
        Promise.resolve().then(call),
        new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), budgetMs)
        }),
      ])
      if (result === TIMED_OUT) {
        this.record(entry, method, this.clock.nowMs() - startedAt, 'timeout', `over ${budgetMs} ms`)
        this.noteFailure(entry, `${method} exceeded its ${budgetMs} ms budget`)
        return null
      }
      this.record(entry, method, this.clock.nowMs() - startedAt, 'ok')
      entry.failures = 0
      if (entry.state === 'error' || entry.state === 'disconnected') entry.state = 'running'
      return result
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      this.record(entry, method, this.clock.nowMs() - startedAt, 'error', detail)
      this.noteFailure(entry, `${method} failed: ${detail}`)
      return null
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private noteFailure(entry: Entry, detail: string): void {
    entry.failures += 1
    entry.lastError = detail
    entry.state = 'error'
    if (entry.failures < MAX_CONSECUTIVE_FAILURES) return
    entry.disabledReason = `disabled after ${entry.failures} consecutive failures — ${detail}`
    logWarn(`[context] provider ${entry.manifest.id} ${entry.disabledReason}`)
  }

  /**
   * GAP 4, enforced. A provider is expected to police its own budget by dropping
   * resolution; Core measures whether it actually did, and disables one that
   * ignores it. Three consecutive over-budget ticks, not one: a momentary
   * overshoot while a provider is trimming is not misbehaviour.
   */
  private enforceMemoryBudget(entry: Entry, ack: TickAck): void {
    if (ack.bytes <= entry.memoryBudgetBytes) {
      entry.budgetStrikes = 0
      return
    }
    entry.budgetStrikes += 1
    if (entry.budgetStrikes < MAX_BUDGET_STRIKES) {
      logWarn(
        `[context] provider ${entry.manifest.id} is holding ${Math.round(ack.bytes / 1024)} KB, over its ` +
          `${Math.round(entry.memoryBudgetBytes / 1024)} KB budget`,
      )
      return
    }
    entry.disabledReason =
      `disabled for holding ${Math.round(ack.bytes / 1024)} KB, over its ` +
      `${Math.round(entry.memoryBudgetBytes / 1024)} KB buffer budget`
    logWarn(`[context] provider ${entry.manifest.id} ${entry.disabledReason}`)
  }

  /**
   * Folds the MEASURED cross-process clock error into an accuracy a provider
   * reported on its own clock (GAP 3). A provider that has never acked has an
   * unbounded error, and the result says so — `exact` becomes false and
   * `errorMs` becomes Infinity, which is what "marked approximate" means in a
   * type that has no separate flag for it.
   */
  private foldClockError(entry: Entry, accuracy: TemporalAccuracy): TemporalAccuracy {
    const bound = entry.offset.hasMeasurement()
      ? entry.offset.errorBoundMs()
      : Number.POSITIVE_INFINITY
    if (bound === 0) return accuracy
    return {
      ...accuracy,
      errorMs: accuracy.errorMs + bound,
      exact: accuracy.exact && bound < 1,
    }
  }

  private record(
    entry: Entry,
    method: string,
    durationMs: number,
    outcome: CallOutcome,
    detail?: string,
  ): void {
    const logEntry: ExecutionLogEntry = {
      timeMs: this.clock.nowMs(),
      providerId: entry.manifest.id,
      method,
      durationMs,
      outcome,
    }
    if (detail !== undefined) logEntry.detail = detail
    this.executionLog.push(logEntry)
    if (this.executionLog.length > EXECUTION_LOG_SIZE) this.executionLog.shift()
  }
}

/** Sentinel for a race the timer won. A unique object cannot collide with a result. */
const TIMED_OUT: unique symbol = Symbol('provider-call-timeout')
