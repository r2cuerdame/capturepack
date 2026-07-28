// The one monotonic session clock (issue #64, GOAL.md "One clock"), and the
// cross-process offset estimator that keeps a provider's clock comparable to it.
//
// WHY MONOTONIC AND NOT Date.now(). Every provider event, every surface sample,
// every replay frame and every annotation is compared on this one `timeMs`. A
// wall clock steps — NTP correction, a manual clock change, DST on a machine
// with a badly behaved RTC — and a step of even a second would reorder a
// recorded sample against the video it describes. `process.hrtime.bigint()` is
// the only clock in Node that cannot do that.
//
// WHERE PACK TIME COMES FROM (docs/temporal-protocol.md §3.1, normative — the
// mapping is Core's, and PROVIDERS NEVER SEE PACK TIME):
//
//   packTMs    ∈ [0, replayDurationMs]      capture instant = replayDurationMs
//   sessionMs  = freeze.range.startMs + packTMs
//   editor tMs = packTMs                    (identical clock, by construction)
//
// A trim moves the saved range but not the clock: the frozen range is what the
// pack contains, and packTMs is measured from the saved range's start. Written
// down here because a provider that guessed it differently would be wrong in a
// way nobody notices for months.

import { randomUUID } from 'node:crypto'
import type { CaptureClock } from '../../shared/context/protocol'

/**
 * The session clock. One per app run: the ring is continuous for as long as
 * CapturePack is recording, and a "session" ends only when the app does.
 */
export class SessionClock {
  readonly sessionId: string
  /** hrtime at session start — the origin every `nowMs` is measured from. */
  private readonly originNs: bigint
  /**
   * `Date.now()` at the same instant. ONLY used to translate an instant the rest
   * of the app already has as a wall-clock time (the capture trigger) into
   * session time. It is NOT the clock: see `fromWallClockMs`.
   */
  private readonly originWallMs: number
  private retentionMs: number
  /** Highest time ever observed, so `bufferEndMs` is never behind a stored sample. */
  private observedEndMs = 0

  constructor(retentionMs: number) {
    this.sessionId = randomUUID()
    this.originNs = process.hrtime.bigint()
    this.originWallMs = Date.now()
    this.retentionMs = Math.max(0, retentionMs)
  }

  /** Milliseconds since session start, monotonic, sub-millisecond resolution. */
  nowMs(): number {
    return Number(process.hrtime.bigint() - this.originNs) / 1e6
  }

  /**
   * The retention window, in ms. Settings can change the replay length
   * MID-SESSION, and `bufferStartMs`/`bufferEndMs` on every tick are the
   * retention contract a provider must honour without a session restart
   * (docs/temporal-protocol.md GAP 2).
   */
  setRetentionMs(retentionMs: number): void {
    this.retentionMs = Math.max(0, retentionMs)
  }

  getRetentionMs(): number {
    return this.retentionMs
  }

  /** Records that data exists up to this time (a sample just landed). */
  observe(timeMs: number): void {
    if (timeMs > this.observedEndMs) this.observedEndMs = timeMs
  }

  /** Oldest time the ring is still required to hold. */
  bufferStartMs(): number {
    return Math.max(0, this.nowMs() - this.retentionMs)
  }

  /** The clock as a provider sees it. */
  snapshot(): CaptureClock {
    const nowMs = this.nowMs()
    return {
      sessionId: this.sessionId,
      nowMs,
      bufferStartMs: Math.max(0, nowMs - this.retentionMs),
      bufferEndMs: Math.max(nowMs, this.observedEndMs),
    }
  }

  /**
   * A wall-clock instant (`Date.now()`) expressed in session time.
   *
   * The ONE bridge between this clock and the rest of the app, which timestamps
   * captures with `Date.now()` (session.ts `triggerAt`). It is exact for an
   * instant that is happening NOW and drifts by whatever the wall clock has been
   * stepped by since session start — which is precisely why nothing else in this
   * subsystem uses it, and why the capture flow calls it with an instant that is
   * milliseconds old rather than storing wall-clock times in the ring.
   */
  fromWallClockMs(wallMs: number): number {
    return wallMs - this.originWallMs
  }

  /** Diagnostics: when this session started, as a wall-clock instant. */
  startedAtWallMs(): number {
    return this.originWallMs
  }
}

/**
 * NTP-style clock offset between Core and a provider that lives in another
 * process (docs/temporal-protocol.md GAP 3).
 *
 * `onTick` originally returned `Promise<void>`, so a provider could receive
 * Core's time but had no way to report its own. Across stdio or Chrome native
 * messaging that is a SILENT DRIFT OF UNKNOWN SIZE, and GOAL.md is explicit that
 * drift here makes "every answer subtly wrong". Four timestamps fix it, exactly
 * as NTP does:
 *
 *   t1 Core sent the tick        t2 provider received it
 *   t3 provider replied          t4 Core received the reply
 *
 *   offset = ((t2 - t1) + (t3 - t4)) / 2      providerClock ≈ coreClock + offset
 *   delay  = (t4 - t1) - (t3 - t2)            error bound = delay / 2
 *
 * The offset is a ROLLING MEDIAN because one scheduling hiccup on either side
 * skews a mean permanently, and the residual is folded into every
 * `TemporalAccuracy.errorMs` Core publishes for that provider. A provider that
 * never acks has an UNBOUNDED error and its candidates are marked approximate —
 * `errorBoundMs()` returns Infinity, which callers must handle rather than
 * treating a missing measurement as zero.
 */
export class ClockOffsetEstimator {
  private readonly offsets: number[] = []
  private readonly delays: number[] = []
  private readonly window: number

  constructor(window = 9) {
    this.window = Math.max(1, window)
  }

  observe(sentAtMs: number, receivedAtLocalMs: number, providerLocalMs: number, replyAtMs: number): void {
    const offset = (receivedAtLocalMs - sentAtMs + (providerLocalMs - replyAtMs)) / 2
    const delay = replyAtMs - sentAtMs - (providerLocalMs - receivedAtLocalMs)
    if (!Number.isFinite(offset) || !Number.isFinite(delay)) return
    this.offsets.push(offset)
    // A negative delay is impossible physically and means the provider's two
    // timestamps are not from a monotonic source; clamp rather than discard, so
    // the sample still bounds the error instead of vanishing.
    this.delays.push(Math.max(0, delay))
    if (this.offsets.length > this.window) this.offsets.shift()
    if (this.delays.length > this.window) this.delays.shift()
  }

  /** `providerClock - coreClock`, or null when nothing has been measured. */
  offsetMs(): number | null {
    return median(this.offsets)
  }

  /**
   * How wrong a converted timestamp may be. Infinity until the first ack — a
   * provider that never answers is not "in sync", it is unmeasured.
   */
  errorBoundMs(): number {
    const delay = median(this.delays)
    return delay === null ? Number.POSITIVE_INFINITY : delay / 2
  }

  /** Core time for a timestamp taken on the provider's clock. */
  toCoreMs(providerMs: number): number | null {
    const offset = this.offsetMs()
    return offset === null ? null : providerMs - offset
  }

  hasMeasurement(): boolean {
    return this.offsets.length > 0
  }
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] ?? null
  const low = sorted[middle - 1]
  const high = sorted[middle]
  if (low === undefined || high === undefined) return null
  return (low + high) / 2
}
