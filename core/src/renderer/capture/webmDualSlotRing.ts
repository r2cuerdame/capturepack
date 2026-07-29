import {
  releaseRecorderReferences,
  stopRecorderWithDeadline,
  type StopDeadlineTimers,
} from './recorderRetention'

export interface WebmDualSlotTimers extends StopDeadlineTimers {
  now(): number
}

export interface WebmDualSlotReplay {
  buffer: ArrayBuffer
  durationMs: number
  startAtMs: number
}

export interface WebmDualSlotOptions {
  generation: number
  segmentMs: number
  mimeType: string
  timesliceMs: number
  stopTimeoutMs: number
  timers: WebmDualSlotTimers
  createRecorder(): MediaRecorder
  discardRecorderOutput(): boolean
  onBytes(bytes: number): void
  onFailure(message: string, generation: number): void
}

interface WebmRecorderSession {
  recorder: MediaRecorder
  generation: number
  chunks: Blob[]
  startedAtMs: number
  rotateTimer: unknown
}

interface WebmRecorderSlot {
  index: 0 | 1
  session: WebmRecorderSession | null
  startTimer: unknown
}

function newSlot(index: 0 | 1): WebmRecorderSlot {
  return {
    index,
    session: null,
    startTimer: undefined,
  }
}

/**
 * Legal WebM fallback for runtimes without Chromium's fragmented MP4 encoder.
 *
 * A WebM timeslice is not independently seekable and cannot be rebased like
 * the MP4 fragments. The proven fallback therefore keeps two complete recorder
 * sessions staggered by one configured segment. The older live session is
 * always between 1x and 2x the requested duration once warm, and stopping it
 * yields one self-contained WebM file.
 *
 * This object is constructed only for the VP8/VP9 fallback. Every session is
 * time-bounded, every scheduled action is slot-identity checked, and every
 * stopped recorder drops both its handlers and Blob array after assembly (or
 * at the stop deadline).
 */
export class WebmDualSlotRing {
  private readonly slots: [WebmRecorderSlot, WebmRecorderSlot] = [
    newSlot(0),
    newSlot(1),
  ]
  private disposed = false
  private lifecycleQueue: Promise<void> = Promise.resolve()

  constructor(private readonly options: WebmDualSlotOptions) {}

  start(): void {
    if (this.disposed) return
    this.startSlot(this.slots[0])
    this.scheduleSlotStart(this.slots[1], this.options.segmentMs)
  }

  recorderStates(): string {
    return this.slots
      .map((slot) => slot.session?.recorder.state ?? 'none')
      .join('/')
  }

  async capture(requestedAtMs: number): Promise<WebmDualSlotReplay | null> {
    const operation = this.lifecycleQueue
      .catch(() => {
        // One failed maintenance rotation must not poison a later request.
      })
      .then(() => this.captureNow(requestedAtMs))
    this.lifecycleQueue = operation.then(
      () => undefined,
      () => undefined,
    )
    try {
      return await operation
    } catch (err) {
      this.fail(`WebM replay assembly failed: ${describe(err)}`)
      return null
    }
  }

  clear(): void {
    if (this.disposed) return
    this.disposed = true
    for (const slot of this.slots) {
      this.options.timers.clear(slot.startTimer)
      slot.startTimer = undefined
      const session = slot.session
      slot.session = null
      if (session === null) continue
      this.options.timers.clear(session.rotateTimer)
      session.rotateTimer = undefined
      const recorder = session.recorder
      // An in-flight capture owns onstop until its final dataavailable arrives.
      // It is itself bounded by stopTimeoutMs; ordinary teardown can sever the
      // closure immediately.
      if (recorder.onstop === null) {
        releaseRecorderReferences(recorder, session.chunks)
      }
      if (recorder.state !== 'inactive') {
        try {
          recorder.stop()
        } catch {
          // A stop task may already be queued by captureNow/rotateSlot.
        }
      }
    }
  }

  private scheduleSlotStart(slot: WebmRecorderSlot, delayMs: number): void {
    this.options.timers.clear(slot.startTimer)
    slot.startTimer = this.options.timers.set(() => {
      slot.startTimer = undefined
      if (this.disposed || slot.session !== null) return
      this.startSlot(slot)
    }, Math.max(this.options.timesliceMs, delayMs))
  }

  private startSlot(slot: WebmRecorderSlot): boolean {
    if (this.disposed || slot.session !== null) return false
    let recorder: MediaRecorder
    try {
      recorder = this.options.createRecorder()
    } catch (err) {
      this.fail(`MediaRecorder unavailable (WebM slot ${slot.index}): ${describe(err)}`)
      return false
    }
    const session: WebmRecorderSession = {
      recorder,
      generation: this.options.generation,
      chunks: [],
      startedAtMs: this.options.timers.now(),
      rotateTimer: undefined,
    }
    recorder.ondataavailable = (event) => {
      if (this.disposed || session.generation !== this.options.generation) return
      if (this.options.discardRecorderOutput()) return
      this.options.onBytes(event.data.size)
      if (event.data.size > 0) session.chunks.push(event.data)
    }
    recorder.onerror = () => {
      if (this.disposed || slot.session !== session) return
      this.fail(`MediaRecorder error (WebM slot ${slot.index})`)
    }
    slot.session = session
    try {
      recorder.start(this.options.timesliceMs)
    } catch (err) {
      slot.session = null
      releaseRecorderReferences(recorder, session.chunks)
      this.fail(`MediaRecorder start failed (WebM slot ${slot.index}): ${describe(err)}`)
      return false
    }
    session.rotateTimer = this.options.timers.set(() => {
      session.rotateTimer = undefined
      this.enqueueRotation(slot, session)
    }, Math.max(this.options.timesliceMs, 2 * this.options.segmentMs))
    return true
  }

  private enqueueRotation(
    slot: WebmRecorderSlot,
    session: WebmRecorderSession,
  ): void {
    this.lifecycleQueue = this.lifecycleQueue
      .catch(() => {
        // A prior request failure must not disable bounded rotations.
      })
      .then(() => this.rotateSlot(slot, session))
      .catch((err: unknown) => {
        this.fail(`WebM recorder rotation failed: ${describe(err)}`)
      })
  }

  private async rotateSlot(
    slot: WebmRecorderSlot,
    session: WebmRecorderSession,
  ): Promise<void> {
    if (this.disposed || slot.session !== session) return
    slot.session = null
    this.options.timers.clear(session.rotateTimer)
    session.rotateTimer = undefined
    let replacementStarted = false
    const startReplacement = (): void => {
      if (this.disposed || replacementStarted) return
      replacementStarted = this.startSlot(slot)
    }
    const recorder = session.recorder
    let stopped = true
    if (recorder.state !== 'inactive') {
      stopped = await stopRecorderWithDeadline(
        recorder,
        this.options.stopTimeoutMs,
        this.options.timers,
        () => releaseRecorderReferences(recorder, session.chunks),
        startReplacement,
      )
    } else {
      startReplacement()
    }
    if (!stopped) {
      this.fail(
        `MediaRecorder stop timed out after ${this.options.stopTimeoutMs} ms ` +
          `(WebM slot ${slot.index})`,
      )
      return
    }
    releaseRecorderReferences(recorder, session.chunks)
    if (!replacementStarted) startReplacement()
  }

  private olderRecording():
    | { slot: WebmRecorderSlot; session: WebmRecorderSession }
    | null {
    const recording = this.slots
      .map((slot) => ({ slot, session: slot.session }))
      .filter(
        (
          entry,
        ): entry is { slot: WebmRecorderSlot; session: WebmRecorderSession } =>
          entry.session !== null && entry.session.recorder.state === 'recording',
      )
      .sort((a, b) => a.session.startedAtMs - b.session.startedAtMs)
    return recording[0] ?? null
  }

  private restaggerSurvivor(selectedIndex: 0 | 1): void {
    const other = this.slots[selectedIndex === 0 ? 1 : 0]
    this.options.timers.clear(other.startTimer)
    other.startTimer = undefined
    const session = other.session
    if (session !== null && session.recorder.state === 'recording') {
      this.options.timers.clear(session.rotateTimer)
      session.rotateTimer = this.options.timers.set(() => {
        session.rotateTimer = undefined
        this.enqueueRotation(other, session)
      }, Math.max(this.options.timesliceMs, this.options.segmentMs))
      return
    }
    if (session !== null) {
      other.session = null
      releaseRecorderReferences(session.recorder, session.chunks)
    }
    this.scheduleSlotStart(other, this.options.segmentMs)
  }

  private async captureNow(
    requestedAtMs: number,
  ): Promise<WebmDualSlotReplay | null> {
    if (this.disposed) return null
    const selected = this.olderRecording()
    if (selected === null) return null
    const { slot, session } = selected
    slot.session = null
    this.options.timers.clear(session.rotateTimer)
    session.rotateTimer = undefined
    let replacementStarted = false
    const startReplacement = (): void => {
      if (this.disposed || replacementStarted) return
      replacementStarted = this.startSlot(slot)
      if (this.disposed) return
      this.restaggerSurvivor(slot.index)
    }
    const recorder = session.recorder
    let stopped = true
    if (recorder.state !== 'inactive') {
      stopped = await stopRecorderWithDeadline(
        recorder,
        this.options.stopTimeoutMs,
        this.options.timers,
        () => releaseRecorderReferences(recorder, session.chunks),
        startReplacement,
      )
    } else {
      startReplacement()
    }
    if (!stopped) {
      this.fail(
        `MediaRecorder stop timed out after ${this.options.stopTimeoutMs} ms ` +
          `(WebM slot ${slot.index})`,
      )
      return null
    }
    if (!replacementStarted) startReplacement()
    if (this.disposed) {
      releaseRecorderReferences(recorder, session.chunks)
      return null
    }
    const source = new Blob(session.chunks, { type: this.options.mimeType })
    const buffer = await source.arrayBuffer()
    const durationMs = Math.max(
      0,
      Math.round(requestedAtMs - session.startedAtMs),
    )
    const startAtMs = session.startedAtMs
    releaseRecorderReferences(recorder, session.chunks)
    if (this.disposed) return null
    return { buffer, durationMs, startAtMs }
  }

  private fail(message: string): void {
    if (this.disposed) return
    this.options.onFailure(message, this.options.generation)
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}
