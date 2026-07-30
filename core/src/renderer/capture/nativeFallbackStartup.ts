import type { CaptureNativeFallbackErrorPayload } from '../../shared/ipc'

/**
 * IPC events can overtake the reply to ipcRenderer.invoke(). Keep only errors
 * observed while a native source start is outstanding, keyed by the session
 * returned in that reply. Once the reply is consumed there is no unmatched
 * event state to retain.
 */
export class NativeFallbackStartupErrors {
  private nextToken = 0
  private collectingToken: number | null = null
  private readonly errors = new Map<string, string>()

  begin(): number {
    const token = ++this.nextToken
    this.collectingToken = token
    this.errors.clear()
    return token
  }

  observe(payload: CaptureNativeFallbackErrorPayload): boolean {
    if (this.collectingToken === null) return false
    if (!this.errors.has(payload.sessionId) && this.errors.size >= 8) {
      const oldest = this.errors.keys().next().value
      if (oldest !== undefined) this.errors.delete(oldest)
    }
    this.errors.set(payload.sessionId, payload.message)
    return true
  }

  consume(token: number, sessionId: string): string | null {
    if (this.collectingToken !== token) return null
    const message = this.errors.get(sessionId) ?? null
    this.cancel(token)
    return message
  }

  cancel(token?: number): void {
    if (
      token !== undefined &&
      this.collectingToken !== token
    ) {
      return
    }
    this.collectingToken = null
    this.errors.clear()
  }
}
