import * as path from 'node:path'

export type RenderBatchState = 'rendering' | 'done' | 'failed'
export type RenderBatchFinish = (state: 'done' | 'failed') => void
export type RenderBatchRelease = () => void

interface RenderBatch {
  count: number
  failed: boolean
  releaseOperation: RenderBatchRelease
}

/**
 * Aggregates every derived-media render for one pack into one lifecycle and
 * one operation-lock lease. Jobs join at their synchronous start boundary;
 * the lease is released before the single terminal event is emitted.
 */
export class PackRenderBatchTracker {
  private readonly batches = new Map<string, RenderBatch>()

  constructor(
    private readonly acquireOperation: (dirPath: string) => RenderBatchRelease | null,
    private readonly emit: (dirPath: string, state: RenderBatchState, ratio?: number) => void,
  ) {}

  isInFlight(dirPath: string): boolean {
    return (this.batches.get(this.key(dirPath))?.count ?? 0) > 0
  }

  begin(dirPath: string): RenderBatchFinish | null {
    const key = this.key(dirPath)
    const existing = this.batches.get(key)
    if (existing !== undefined) {
      existing.count += 1
    } else {
      const releaseOperation = this.acquireOperation(dirPath)
      if (releaseOperation === null) {
        // No batch can send a later terminal event. Fail now so unattended
        // callers do not wait until their deadline.
        this.emit(dirPath, 'failed')
        return null
      }
      this.batches.set(key, { count: 1, failed: false, releaseOperation })
      this.emit(dirPath, 'rendering')
    }

    let finished = false
    return (state): void => {
      if (finished) return
      finished = true
      const batch = this.batches.get(key)
      if (batch === undefined) return
      if (state === 'failed') batch.failed = true
      batch.count -= 1
      if (batch.count > 0) {
        // The completed job's 100% is not the whole pack. Clear its ratio while
        // queued display/still jobs remain.
        this.emit(dirPath, 'rendering')
        return
      }
      this.batches.delete(key)
      batch.releaseOperation()
      this.emit(dirPath, batch.failed ? 'failed' : 'done')
    }
  }

  progress(dirPath: string, ratio: number): void {
    if (this.isInFlight(dirPath)) this.emit(dirPath, 'rendering', ratio)
  }

  private key(dirPath: string): string {
    return path.resolve(dirPath).toLowerCase()
  }
}
