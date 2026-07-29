/**
 * One native-close request waits briefly for the editor renderer to respond.
 *
 * The response may be either a final Save/Discard decision (which disposes the
 * whole editor flow) or an acknowledgement that the unsaved-changes modal is
 * now visible. The latter clears this watchdog without settling anything: the
 * user may take as long as needed, press Esc to keep editing, then press Close
 * again and arm a fresh deadline.
 */
export interface WatchdogTimer {
  unref?(): void
}

export interface WatchdogScheduler {
  set(callback: () => void, delayMs: number): WatchdogTimer
  clear(timer: WatchdogTimer): void
}

export interface EditorCloseWatchdog {
  arm(): void
  acknowledge(): void
  dispose(): void
  isArmed(): boolean
}

const systemScheduler: WatchdogScheduler = {
  set(callback, delayMs) {
    return setTimeout(callback, delayMs)
  },
  clear(timer) {
    clearTimeout(timer as ReturnType<typeof setTimeout>)
  },
}

export function createEditorCloseWatchdog(
  delayMs: number,
  onTimeout: () => void,
  scheduler: WatchdogScheduler = systemScheduler,
): EditorCloseWatchdog {
  let timer: WatchdogTimer | null = null
  let disposed = false

  const clear = (): void => {
    if (timer === null) return
    scheduler.clear(timer)
    timer = null
  }

  return {
    arm(): void {
      if (disposed || timer !== null) return
      timer = scheduler.set(() => {
        timer = null
        if (!disposed) onTimeout()
      }, delayMs)
      timer.unref?.()
    },
    acknowledge(): void {
      clear()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      clear()
    },
    isArmed(): boolean {
      return timer !== null
    },
  }
}
