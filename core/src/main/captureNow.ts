export type CaptureNowRecorderState =
  | { status: 'starting' }
  | { status: 'recording' }
  | { status: 'stopped' }

/**
 * Start an unattended capture countdown only after the recorder has produced
 * frame evidence. Startup work can take most of a fixed --capture-now delay,
 * leaving a pack with only a fraction of the requested replay duration.
 * A bounded fallback still lets no-frame and permanently-starting runs reach
 * their normal pack assertions instead of hanging the test job.
 */
export function scheduleCaptureNow(
  delayMs: number,
  readinessTimeoutMs: number,
  getRecorderState: () => CaptureNowRecorderState,
  onRecorderStateChanged: (listener: (state: CaptureNowRecorderState) => void) => () => void,
  capture: () => void,
): () => void {
  let settled = false
  let countdown: ReturnType<typeof setTimeout> | undefined
  let readinessTimeout: ReturnType<typeof setTimeout> | undefined
  let unsubscribe = (): void => {}

  const finishWaiting = (): void => {
    if (settled) return
    settled = true
    unsubscribe()
    if (readinessTimeout !== undefined) clearTimeout(readinessTimeout)
    countdown = setTimeout(capture, delayMs)
  }

  const observe = (state: CaptureNowRecorderState): void => {
    if (state.status !== 'starting') finishWaiting()
  }

  unsubscribe = onRecorderStateChanged(observe)
  readinessTimeout = setTimeout(finishWaiting, readinessTimeoutMs)
  observe(getRecorderState())

  return () => {
    settled = true
    unsubscribe()
    if (readinessTimeout !== undefined) clearTimeout(readinessTimeout)
    if (countdown !== undefined) clearTimeout(countdown)
  }
}
