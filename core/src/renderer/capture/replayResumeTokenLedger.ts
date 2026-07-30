export interface ReplayResumeTokenLedgerOptions {
  readonly maxEntries: number
  readonly ttlMs: number
  readonly now: () => number
}

interface ReplayResumeToken {
  readonly generation: number
  readonly expiresAtMs: number
}

/**
 * Bounded tombstones for RESUME messages that overtake their matching HOLD.
 *
 * Electron normally delivers main -> renderer messages in order, but the
 * recorder boundary must remain correct even if a stalled renderer observes
 * RESUME first. Tokens own no media; lazy expiry plus a hard entry cap prevents
 * malformed/stale IPC from becoming another lifetime owner.
 */
export class ReplayResumeTokenLedger {
  private readonly tokens = new Map<string, ReplayResumeToken>()
  private readonly maxEntries: number
  private readonly ttlMs: number

  constructor(private readonly options: ReplayResumeTokenLedgerOptions) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries))
    this.ttlMs = Math.max(1, options.ttlMs)
  }

  get size(): number {
    this.prune(this.options.now())
    return this.tokens.size
  }

  note(requestId: string, generation: number): void {
    if (requestId.length === 0 || !Number.isFinite(generation)) return
    const now = this.options.now()
    this.prune(now)
    // Refreshing a duplicate makes it the newest cap-owned token.
    this.tokens.delete(requestId)
    while (this.tokens.size >= this.maxEntries) {
      const oldest = this.tokens.keys().next().value
      if (oldest === undefined) break
      this.tokens.delete(oldest)
    }
    this.tokens.set(requestId, {
      generation,
      expiresAtMs: now + this.ttlMs,
    })
  }

  consume(requestId: string, generation: number): boolean {
    const now = this.options.now()
    this.prune(now)
    const token = this.tokens.get(requestId)
    if (token === undefined) return false
    // A request id is single-use even when a stale generation presents it.
    this.tokens.delete(requestId)
    return token.generation === generation && token.expiresAtMs > now
  }

  clear(): void {
    this.tokens.clear()
  }

  private prune(now: number): void {
    for (const [requestId, token] of this.tokens) {
      if (token.expiresAtMs <= now) this.tokens.delete(requestId)
    }
  }
}
