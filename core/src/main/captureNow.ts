export interface CaptureReadiness {
  status: string
}

type Timer = ReturnType<typeof setTimeout>

/**
 * Start the unattended capture countdown only while every requested recorder
 * is proven healthy. A stopped recorder cancels the countdown; recovery starts
 * a fresh full interval so a delayed boot cannot produce a partial replay.
 */
export function scheduleCaptureWhenRecording<State extends CaptureReadiness>(
  delayMs: number,
  getState: () => State,
  subscribe: (listener: (state: State) => void) => () => void,
  capture: () => void,
  schedule: (callback: () => void, delay: number) => Timer = setTimeout,
  cancel: (timer: Timer) => void = clearTimeout,
): () => void {
  let timer: Timer | null = null
  let disposed = false
  let countdown = 0
  let unsubscribe = (): void => {}

  const onState = (state: State): void => {
    if (disposed) return
    if (state.status !== 'recording') {
      countdown += 1
      if (timer !== null) cancel(timer)
      timer = null
      return
    }
    if (timer !== null) return

    const currentCountdown = ++countdown
    timer = schedule(() => {
      // A cancelled callback may already be queued. Recovery owns a new full
      // interval; an old callback must neither capture nor clear its timer.
      if (disposed || currentCountdown !== countdown) return
      timer = null
      if (disposed || getState().status !== 'recording') return
      disposed = true
      unsubscribe()
      capture()
    }, delayMs)
  }

  unsubscribe = subscribe(onState)
  onState(getState())

  return () => {
    if (disposed) return
    disposed = true
    if (timer !== null) cancel(timer)
    timer = null
    unsubscribe()
  }
}
