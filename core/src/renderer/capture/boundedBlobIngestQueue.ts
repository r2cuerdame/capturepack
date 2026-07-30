export interface BoundedBlobIngestQueueStats {
  readonly capacityBytes: number
  readonly activeBlobBytes: number
  readonly queuedBlobBytes: number
  readonly queuedBlobCount: number
  readonly batchedBlobBytes: number
  readonly batchedBlobCount: number
  readonly droppedBlobCount: number
  readonly activePayloadRetained: boolean
  readonly cancelled: boolean
}

interface PendingBlob<T> {
  source: Blob | null
  readonly size: number
  payload: { value: T } | null
  readonly sequence: number
}

interface OpenBlobBatch {
  parts: Blob[]
  size: number
  invalid: boolean
  closed: boolean
}

/**
 * An opaque stop-flush batch.
 *
 * MediaRecorder can deliver an ordinary queued timeslice and its final flush
 * after stop() has already made the recorder inactive. Those pieces must enter
 * the MP4 parser together so their fragment clocks can be backfilled from one
 * capture instant. The queue owns the Blob references; the recorder session
 * only owns this handle, so cancel() can sever every pending backing store.
 */
export class BoundedBlobBatch<T> {
  constructor(
    private readonly appendPart: (source: Blob) => boolean,
    private readonly commitParts: (
      payload: T,
      allowEmptyBarrier: boolean,
    ) => boolean,
    private readonly cancelParts: () => void,
  ) {}

  append(source: Blob): boolean {
    return this.appendPart(source)
  }

  commit(payload: T, allowEmptyBarrier = false): boolean {
    return this.commitParts(payload, allowEmptyBarrier)
  }

  cancel(): void {
    this.cancelParts()
  }
}

/**
 * Serial Blob -> ArrayBuffer ingest with an explicit backing-store budget.
 *
 * Promise chaining one closure per MediaRecorder event looks serial but is not
 * memory-bounded: every closure retains its Blob while a slow arrayBuffer()
 * conversion is in flight. This queue has one active conversion and a bounded
 * list of pending sources. Recorder Blobs are one ordered byte stream, so
 * capacity pressure rejects the new source instead of deleting an arbitrary
 * earlier byte range. The owner must treat false as a failed recorder session.
 * cancel() drops the consumer, pending sources and open stop batches
 * synchronously, allowing a replacement capture generation to proceed without
 * waiting for an abandoned browser-process Blob conversion.
 */
export class BoundedBlobIngestQueue<T> {
  private readonly pending: PendingBlob<T>[] = []
  private readonly batches = new Set<OpenBlobBatch>()
  private consumer: ((bytes: Uint8Array<ArrayBuffer>, payload: T) => void) | null
  private readonly onError: ((error: unknown) => void) | null
  private queuedBlobBytes = 0
  private activeBlobBytes = 0
  private activePayload: { value: T } | null = null
  private draining = false
  private cancelled = false
  private droppedBlobCount = 0
  private nextSequence = 0
  private completedSequence = 0
  private readonly settledOutOfOrder = new Set<number>()
  private flushWaiters: Array<{ target: number; resolve: () => void }> = []

  constructor(
    private readonly capacityBytes: number,
    consumer: (bytes: Uint8Array<ArrayBuffer>, payload: T) => void,
    onError: ((error: unknown) => void) | null = null,
  ) {
    if (!Number.isFinite(capacityBytes) || capacityBytes <= 0) {
      throw new Error('Blob ingest capacity must be a positive finite byte count')
    }
    this.consumer = consumer
    this.onError = onError
  }

  enqueue(source: Blob, payload: T): boolean {
    if (this.cancelled || source.size <= 0) return false
    if (!this.hasRoom(source.size)) {
      this.droppedBlobCount += 1
      return false
    }
    this.pending.push({
      source,
      size: source.size,
      payload: { value: payload },
      sequence: ++this.nextSequence,
    })
    this.queuedBlobBytes += source.size
    this.startDrain()
    return true
  }

  createBatch(): BoundedBlobBatch<T> {
    const batch: OpenBlobBatch = {
      parts: [],
      size: 0,
      invalid: this.cancelled,
      closed: this.cancelled,
    }
    if (!this.cancelled) this.batches.add(batch)
    return new BoundedBlobBatch<T>(
      (source) => this.appendBatchPart(batch, source),
      (payload, allowEmptyBarrier) =>
        this.commitBatch(batch, payload, allowEmptyBarrier),
      () => this.cancelBatch(batch),
    )
  }

  /**
   * Waits for work already committed to the serial queue. An owner cancellation
   * resolves immediately: an in-flight browser Blob promise cannot be aborted,
   * but it has no consumer or queued source reference left to block restart.
   */
  flush(): Promise<void> {
    const target = this.nextSequence
    if (this.cancelled || this.completedSequence >= target) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.flushWaiters.push({ target, resolve })
    })
  }

  cancel(): void {
    if (this.cancelled) return
    this.cancelled = true
    this.consumer = null
    this.activePayload = null
    for (const item of this.pending) item.source = null
    this.pending.length = 0
    this.queuedBlobBytes = 0
    for (const batch of this.batches) {
      batch.parts.length = 0
      batch.size = 0
      batch.invalid = true
      batch.closed = true
    }
    this.batches.clear()
    this.resolveFlushWaiters()
  }

  stats(): BoundedBlobIngestQueueStats {
    let batchedBlobBytes = 0
    let batchedBlobCount = 0
    for (const batch of this.batches) {
      batchedBlobBytes += batch.size
      batchedBlobCount += batch.parts.length
    }
    return {
      capacityBytes: this.capacityBytes,
      activeBlobBytes: this.activeBlobBytes,
      queuedBlobBytes: this.queuedBlobBytes,
      queuedBlobCount: this.pending.length,
      batchedBlobBytes,
      batchedBlobCount,
      droppedBlobCount: this.droppedBlobCount,
      activePayloadRetained: this.activePayload !== null,
      cancelled: this.cancelled,
    }
  }

  private retainedBlobBytes(): number {
    let batchBytes = 0
    for (const batch of this.batches) batchBytes += batch.size
    return this.activeBlobBytes + this.queuedBlobBytes + batchBytes
  }

  private hasRoom(incomingBytes: number): boolean {
    if (incomingBytes > this.capacityBytes) return false
    return this.retainedBlobBytes() + incomingBytes <= this.capacityBytes
  }

  private appendBatchPart(batch: OpenBlobBatch, source: Blob): boolean {
    if (
      this.cancelled ||
      batch.closed ||
      batch.invalid ||
      source.size <= 0
    ) {
      return false
    }
    if (!this.hasRoom(source.size)) {
      this.droppedBlobCount += batch.parts.length + 1
      batch.parts.length = 0
      batch.size = 0
      batch.invalid = true
      batch.closed = true
      this.batches.delete(batch)
      return false
    }
    batch.parts.push(source)
    batch.size += source.size
    return true
  }

  private commitBatch(
    batch: OpenBlobBatch,
    payload: T,
    allowEmptyBarrier: boolean,
  ): boolean {
    if (
      this.cancelled ||
      batch.closed ||
      batch.invalid
    ) {
      this.cancelBatch(batch)
      return false
    }
    if (batch.parts.length === 0) {
      if (!allowEmptyBarrier) {
        this.cancelBatch(batch)
        return false
      }
      // A valid MP4 recorder may have already emitted every byte in an
      // ordinary timeslice and then report a zero-byte final dataavailable.
      // Closing the batch without enqueueing a fake Blob still creates a
      // barrier over all prior work before the replacement starts.
      batch.closed = true
      this.batches.delete(batch)
      return true
    }
    batch.closed = true
    this.batches.delete(batch)
    const size = batch.size
    const source =
      batch.parts.length === 1 ? batch.parts[0]! : new Blob(batch.parts)
    batch.parts.length = 0
    batch.size = 0
    this.pending.push({
      source,
      size,
      payload: { value: payload },
      sequence: ++this.nextSequence,
    })
    this.queuedBlobBytes += size
    this.startDrain()
    return true
  }

  private cancelBatch(batch: OpenBlobBatch): void {
    if (!batch.closed) this.batches.delete(batch)
    batch.parts.length = 0
    batch.size = 0
    batch.invalid = true
    batch.closed = true
  }

  private startDrain(): void {
    if (this.draining || this.cancelled) return
    this.draining = true
    void this.drain()
  }

  private async drain(): Promise<void> {
    try {
      while (!this.cancelled && this.pending.length > 0) {
        const item = this.pending.shift()
        if (item === undefined) break
        this.queuedBlobBytes -= item.size
        this.activeBlobBytes = item.size
        this.activePayload = item.payload
        item.payload = null
        let source = item.source
        item.source = null
        if (source === null) {
          this.activeBlobBytes = 0
          this.activePayload = null
          this.markSettled(item.sequence)
          continue
        }
        let conversion: Promise<ArrayBuffer>
        try {
          conversion = source.arrayBuffer()
        } catch (error) {
          source = null
          this.activeBlobBytes = 0
          this.activePayload = null
          this.onError?.(error)
          this.markSettled(item.sequence)
          continue
        }
        // The promise's browser implementation may retain its backing store;
        // this queue deliberately does not keep a second explicit Blob owner.
        source = null
        try {
          const buffer = await conversion
          const consumer = this.consumer
          const payload = this.activePayload
          if (!this.cancelled && consumer !== null && payload !== null) {
            consumer(new Uint8Array(buffer), payload.value)
          }
        } catch (error) {
          this.onError?.(error)
        } finally {
          this.activeBlobBytes = 0
          this.activePayload = null
          this.markSettled(item.sequence)
        }
      }
    } finally {
      this.draining = false
      if (!this.cancelled && this.pending.length > 0) {
        this.startDrain()
        return
      }
      this.resolveReadyFlushWaiters()
    }
  }

  private markSettled(sequence: number): void {
    if (sequence <= this.completedSequence) return
    this.settledOutOfOrder.add(sequence)
    while (this.settledOutOfOrder.delete(this.completedSequence + 1)) {
      this.completedSequence += 1
    }
    this.resolveReadyFlushWaiters()
  }

  private resolveReadyFlushWaiters(): void {
    if (this.flushWaiters.length === 0) return
    const remaining: typeof this.flushWaiters = []
    for (const waiter of this.flushWaiters) {
      if (waiter.target <= this.completedSequence) waiter.resolve()
      else remaining.push(waiter)
    }
    this.flushWaiters = remaining
  }

  private resolveFlushWaiters(): void {
    const waiters = this.flushWaiters
    this.flushWaiters = []
    for (const waiter of waiters) waiter.resolve()
  }
}

/**
 * Publishes a complete stopped-recorder batch before a replacement recorder
 * is allowed to enqueue its first timeslice.
 *
 * `MediaRecorder.stop()` may resolve asynchronously. Starting the replacement
 * as soon as stop is requested lets its initialization/timeslice bytes overtake
 * the old recorder's final `dataavailable` batch in the shared parser queue.
 * Capture the old-session barrier immediately after commit, then start the
 * replacement; later work is deliberately outside that barrier.
 */
export async function commitRecorderBatchBeforeReplacement<T>(
  queue: BoundedBlobIngestQueue<T>,
  batch: BoundedBlobBatch<T>,
  payload: T,
  startReplacement: () => void,
  allowEmptyBarrier = false,
): Promise<boolean> {
  if (!batch.commit(payload, allowEmptyBarrier)) return false
  const oldSessionBarrier = queue.flush()
  startReplacement()
  await oldSessionBarrier
  return !queue.stats().cancelled
}
