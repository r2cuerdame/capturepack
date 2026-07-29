/**
 * Browser integration lifecycle primitives.
 *
 * Kept free of Electron, sockets and browser globals so the two failure-prone
 * pieces — active-handshake truth and reconnect backoff — can be regression
 * tested deterministically.
 */

export interface ExtensionHandshake {
  version: string
  protocol: number
}

/**
 * The browser sends hello once per native messaging port, while the app-side
 * named pipe may reconnect many times during that port's lifetime. Preserve
 * the last hello and replay it first on every new pipe.
 */
export class NativeHostReplayBuffer {
  private hello: string | null = null
  private queued: string[] = []

  remember(line: string): void {
    try {
      const parsed = JSON.parse(line) as unknown
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as Record<string, unknown>)['type'] === 'host.hello'
      ) {
        this.hello = line
      }
    } catch {
      // Validation belongs to the app. The host only identifies hello so it
      // can restore connection identity after its transport reconnects.
    }
  }

  enqueue(line: string): void {
    this.remember(line)
    this.queued.push(line)
    if (this.queued.length > 200) this.queued.shift()
  }

  drainForConnection(): readonly string[] {
    const queued = this.queued
    this.queued = []
    if (this.hello === null) return queued
    return [this.hello, ...queued.filter((line) => line !== this.hello)]
  }
}

/**
 * One native host exists per browser connection/profile. The newest live
 * handshake is the status shown in Settings; if it closes, an older live
 * connection (if any) becomes current instead of the whole integration being
 * declared disconnected.
 */
export class ExtensionConnectionLedger<Key extends object> {
  private readonly connections = new Map<Key, ExtensionHandshake>()

  upsert(key: Key, handshake: ExtensionHandshake): void {
    // Reinsert so Map iteration order represents handshake recency.
    this.connections.delete(key)
    this.connections.set(key, handshake)
  }

  remove(key: Key): void {
    this.connections.delete(key)
  }

  latest(): ExtensionHandshake | null {
    let latest: ExtensionHandshake | null = null
    for (const value of this.connections.values()) latest = value
    return latest
  }

  keys(): readonly Key[] {
    return [...this.connections.keys()]
  }

  clear(): void {
    this.connections.clear()
  }
}

export interface ReconnectBackoff {
  schedule(): void
  connected(): void
  stop(): void
}

export interface ReconnectTimer {
  set(callback: () => void, delayMs: number): unknown
  clear(handle: unknown): void
}

const DEFAULT_TIMER: ReconnectTimer = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * Schedules at most one reconnect and resets to the fast delay only after a
 * real connection. A stopped loop cannot be revived by a late socket event.
 */
export function createReconnectBackoff(
  redial: () => void,
  options: {
    minDelayMs?: number
    maxDelayMs?: number
    timer?: ReconnectTimer
  } = {},
): ReconnectBackoff {
  const minDelayMs = Math.max(1, Math.round(options.minDelayMs ?? 500))
  const maxDelayMs = Math.max(minDelayMs, Math.round(options.maxDelayMs ?? 15_000))
  const timer = options.timer ?? DEFAULT_TIMER
  let nextDelayMs = minDelayMs
  let pending: unknown = null
  let stopped = false

  return {
    schedule(): void {
      if (stopped || pending !== null) return
      const delayMs = nextDelayMs
      pending = timer.set(() => {
        pending = null
        nextDelayMs = Math.min(maxDelayMs, delayMs * 2)
        redial()
      }, delayMs)
    },
    connected(): void {
      if (pending !== null) timer.clear(pending)
      pending = null
      nextDelayMs = minDelayMs
    },
    stop(): void {
      stopped = true
      if (pending !== null) timer.clear(pending)
      pending = null
    },
  }
}
