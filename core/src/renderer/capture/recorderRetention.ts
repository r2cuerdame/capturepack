/**
 * The references a stopped MediaRecorder must not keep.
 *
 * Chromium keeps Blob backing storage in the browser process. Leaving a stopped
 * recorder's handlers attached can therefore keep every Blob captured by those
 * closures alive even after the slot has moved on to a new recorder.
 */
export interface RecorderReferences {
  ondataavailable: unknown
  onerror: unknown
  onstop: unknown
}

export interface StoppableRecorder extends RecorderReferences {
  stop(): void
}

export interface StopDeadlineTimers {
  set(callback: () => void, delayMs: number): unknown
  clear(handle: unknown): void
}

/**
 * Timestamp a recorder Blob on the media event's own clock.
 *
 * Calling stop() makes `recorder.state` inactive synchronously, but an ordinary
 * timeslice event may already be queued ahead of the final stop flush. Looking
 * only at recorder.state therefore collapsed both events onto `flushAtMs`.
 * Chromium's Event.timeStamp distinguishes them: the queued event was created
 * before stop, while the final flush was created at/after it.
 */
export function recorderChunkEndAtMs(
  eventTimeStampMs: number,
  deliveredAtMs: number,
  flushAtMs: number | null,
  recorderInactive: boolean,
): number {
  const hasComparableEventTime =
    Number.isFinite(eventTimeStampMs) &&
    eventTimeStampMs > 0 &&
    // Reject an epoch-based or otherwise foreign event clock. A small future
    // tolerance avoids turning harmless timer rounding into a false fallback.
    eventTimeStampMs <= deliveredAtMs + 1_000
  if (
    recorderInactive &&
    flushAtMs !== null &&
    (!hasComparableEventTime || eventTimeStampMs >= flushAtMs)
  ) {
    return flushAtMs
  }
  return hasComparableEventTime ? eventTimeStampMs : deliveredAtMs
}

/** Detaches the handler closures without touching chunks still being assembled. */
export function detachRecorderHandlers(recorder: RecorderReferences): void {
  recorder.ondataavailable = null
  recorder.onerror = null
  recorder.onstop = null
}

/** Releases both sides of the stopped-recorder retention chain. */
export function releaseRecorderReferences(
  recorder: RecorderReferences,
  chunks: unknown[],
): void {
  detachRecorderHandlers(recorder)
  chunks.length = 0
}

/**
 * A scheduled rotation must accept the recorder's final `dataavailable` first:
 * MP4 commonly flushes its only useful bytes during stop(). The stop event runs
 * after that final data event, so it is the safe point to discard the segment.
 */
export function releaseRecorderReferencesOnStop(
  recorder: RecorderReferences,
  chunks: unknown[],
): void {
  recorder.onstop = () => releaseRecorderReferences(recorder, chunks)
}

/**
 * Stops a recorder without allowing a missing `stop` event to hold a lifecycle
 * queue forever. Once the deadline expires the final data event is no longer
 * usable by that failed flush, so keeping its handlers for a hypothetical late
 * stop only leaks the recorder/Blob closure chain when the event never comes.
 */
export function stopRecorderWithDeadline(
  recorder: StoppableRecorder,
  timeoutMs: number,
  timers: StopDeadlineTimers,
  onLateStop: () => void,
  onStopRequested: () => void = () => undefined,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let timedOut = false
    const abandon = (): void => {
      if (timedOut) return
      timedOut = true
      detachRecorderHandlers(recorder)
      onLateStop()
      resolve(false)
    }
    const timeout = timers.set(abandon, timeoutMs)
    recorder.onstop = () => {
      timers.clear(timeout)
      if (timedOut) return
      recorder.onstop = null
      resolve(true)
    }
    try {
      recorder.stop()
      onStopRequested()
    } catch {
      timers.clear(timeout)
      abandon()
    }
  })
}
