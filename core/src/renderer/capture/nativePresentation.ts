export interface NativeClockSample {
  readonly sessionId: string
  readonly capturedQpc: number
  readonly qpcFrequency: number
  readonly capturedAtMs: number
}

/**
 * Maps helper QPC ticks onto one stable epoch-like axis.
 *
 * capturedAtMs is used once as the session anchor. Later wall-clock values are
 * deliberately ignored, so a Windows clock adjustment cannot move object
 * samples while the monotonic QPC continues normally.
 */
export class NativeFrameClock {
  private sessionId: string | null = null
  private anchorQpc = 0
  private qpcFrequency = 0
  private anchorCapturedAtMs = 0

  map(sample: NativeClockSample, wallClockOffsetMs = 0): number | null {
    if (
      !Number.isFinite(sample.capturedQpc) ||
      sample.capturedQpc <= 0 ||
      !Number.isFinite(sample.qpcFrequency) ||
      sample.qpcFrequency <= 0 ||
      !Number.isFinite(sample.capturedAtMs) ||
      !Number.isFinite(wallClockOffsetMs)
    ) {
      return null
    }
    if (
      this.sessionId !== sample.sessionId ||
      this.qpcFrequency !== sample.qpcFrequency ||
      sample.capturedQpc < this.anchorQpc
    ) {
      this.sessionId = sample.sessionId
      this.anchorQpc = sample.capturedQpc
      this.qpcFrequency = sample.qpcFrequency
      this.anchorCapturedAtMs =
        sample.capturedAtMs + wallClockOffsetMs
    }
    return (
      this.anchorCapturedAtMs +
      ((sample.capturedQpc - this.anchorQpc) * 1_000) /
        this.qpcFrequency
    )
  }

  reset(): void {
    this.sessionId = null
    this.anchorQpc = 0
    this.qpcFrequency = 0
    this.anchorCapturedAtMs = 0
  }
}

export interface NativePresentationRequest<T> {
  readonly requestedAtMs: number
  readonly value: T
}

/**
 * requestFrame() and requestVideoFrameCallback() are not one synchronous pair:
 * Chromium may coalesce several canvas submissions before one presentation.
 * Retain a small metadata-only request queue and choose the newest request that
 * already existed at presentationTime. Future requests can never be attached
 * to an older callback.
 */
export class NativePresentationQueue<T> {
  private readonly requests: NativePresentationRequest<T>[] = []
  private capacityDropped = 0
  private ambiguousDropped = 0
  private unreportedPresented = 0

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error('native presentation queue capacity must be positive')
    }
  }

  push(requestedAtMs: number, value: T): void {
    if (!Number.isFinite(requestedAtMs)) return
    this.requests.push({ requestedAtMs, value })
    while (this.requests.length > this.capacity) {
      this.requests.shift()
      this.capacityDropped += 1
    }
  }

  take(presentationTimeMs: number, presentedDelta: number): T | null {
    if (
      !Number.isFinite(presentationTimeMs) ||
      !Number.isInteger(presentedDelta) ||
      presentedDelta <= 0
    ) {
      return null
    }
    let selected = -1
    for (let index = 0; index < this.requests.length; index += 1) {
      const request = this.requests[index]
      if (
        request !== undefined &&
        request.requestedAtMs <= presentationTimeMs
      ) {
        selected = index
      } else {
        break
      }
    }
    if (selected < 0) return null
    const eligible = selected + 1
    if (eligible !== presentedDelta) {
      // More requests than presentations means coalescing or a request that
      // had not entered the compositor yet; fewer means an untracked startup
      // frame. Neither case has an exact sequence association, so emit no tick.
      this.requests.splice(0, eligible)
      this.ambiguousDropped += eligible
      return null
    }
    const request = this.requests[selected]
    this.unreportedPresented += Math.max(0, presentedDelta - 1)
    this.requests.splice(0, selected + 1)
    return request?.value ?? null
  }

  clear(): void {
    this.requests.length = 0
    this.capacityDropped = 0
    this.ambiguousDropped = 0
    this.unreportedPresented = 0
  }

  stats(): {
    readonly retained: number
    readonly capacityDropped: number
    readonly ambiguousDropped: number
    readonly unreportedPresented: number
  } {
    return {
      retained: this.requests.length,
      capacityDropped: this.capacityDropped,
      ambiguousDropped: this.ambiguousDropped,
      unreportedPresented: this.unreportedPresented,
    }
  }
}
