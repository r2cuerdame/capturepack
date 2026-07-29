export const BACKGROUND_MEDIA_CONCURRENCY = 1
export const RESPONSIVE_COPY_CHUNK_BYTES = 2 * 1024 * 1024

type QueuedJob<T> = {
  run: (signal: AbortSignal) => Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('background media work was cancelled')
}

/**
 * A small explicit queue for the expensive decode/encode lane.
 *
 * Pending jobs hold source buffers but allocate no duplicate ArrayBuffers and
 * create no renderer processes. Shutdown rejects queued jobs immediately and
 * aborts the one active job, so app quit cannot leave hidden render windows or
 * minutes of work draining after the user has asked to exit.
 */
export class BoundedBackgroundMediaQueue {
  private readonly pending: Array<QueuedJob<unknown>> = []
  private readonly controller = new AbortController()
  private active = 0
  private accepting = true

  constructor(private readonly concurrency = BACKGROUND_MEDIA_CONCURRENCY) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error('background media concurrency must be a positive integer')
    }
  }

  get activeCount(): number {
    return this.active
  }

  get pendingCount(): number {
    return this.pending.length
  }

  get isAccepting(): boolean {
    return this.accepting
  }

  enqueue<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(abortReason(this.controller.signal))
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ run, resolve, reject } as QueuedJob<unknown>)
      this.pump()
    })
  }

  shutdown(reason: Error = new Error('CapturePack is quitting')): void {
    if (!this.accepting) return
    this.accepting = false
    this.controller.abort(reason)
    for (const job of this.pending.splice(0)) job.reject(reason)
  }

  private pump(): void {
    while (
      this.accepting &&
      this.active < this.concurrency &&
      this.pending.length > 0
    ) {
      const job = this.pending.shift()
      if (job === undefined) return
      this.active += 1
      void Promise.resolve()
        .then(() => {
          if (this.controller.signal.aborted) throw abortReason(this.controller.signal)
          return job.run(this.controller.signal)
        })
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active -= 1
          this.pump()
        })
    }
  }
}

export type YieldToEventLoop = () => Promise<void>

const yieldToImmediate: YieldToEventLoop = () =>
  new Promise<void>((resolve) => setImmediate(resolve))

/**
 * Copies IPC media without monopolising Electron's main thread.
 *
 * A 4K replay can exceed 100 MB. One Uint8Array#set for that whole buffer, and
 * one more for every queued monitor, froze all app windows even though the
 * actual encoders were serialized. Small chunks plus an event-loop yield keep
 * window/IPC input serviceable; only the active queue job owns a duplicate.
 */
export async function copyBufferResponsively(
  source: Buffer,
  signal: AbortSignal,
  options: {
    chunkBytes?: number
    yieldToEventLoop?: YieldToEventLoop
  } = {},
): Promise<ArrayBuffer> {
  if (signal.aborted) throw abortReason(signal)
  const chunkBytes = options.chunkBytes ?? RESPONSIVE_COPY_CHUNK_BYTES
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1) {
    throw new Error('responsive copy chunk size must be a positive integer')
  }
  const yieldControl = options.yieldToEventLoop ?? yieldToImmediate
  const target = new ArrayBuffer(source.byteLength)
  const targetBytes = new Uint8Array(target)
  for (let offset = 0; offset < source.byteLength; offset += chunkBytes) {
    if (signal.aborted) throw abortReason(signal)
    const end = Math.min(source.byteLength, offset + chunkBytes)
    targetBytes.set(source.subarray(offset, end), offset)
    if (end < source.byteLength) await yieldControl()
  }
  if (signal.aborted) throw abortReason(signal)
  return target
}
