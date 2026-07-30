/**
 * Buffers one main-to-renderer value until the renderer subscribes.
 *
 * Electron's `ready-to-show` means that a page has painted; it does not mean
 * that the page's module has already installed every IPC listener. Preloads run
 * first, so they own this tiny mailbox and make a one-shot bootstrap message
 * lossless across either ordering.
 */
export interface ReplayOnce<T> {
  push(value: T): void
  subscribe(listener: (value: T) => void): void
}

export function replayOnce<T>(): ReplayOnce<T> {
  let pending: T | undefined
  let hasPending = false
  let delivered = false
  let subscriber: ((value: T) => void) | null = null

  return {
    push(value): void {
      if (delivered) return
      if (subscriber !== null) {
        delivered = true
        subscriber(value)
        return
      }
      pending = value
      hasPending = true
    },
    subscribe(listener): void {
      if (delivered) return
      subscriber = listener
      if (!hasPending) return
      const value = pending as T
      pending = undefined
      hasPending = false
      delivered = true
      listener(value)
    },
  }
}
