// Replay scrub controller: a hidden <video> over the replay bytes, coalesced
// seeks, and a playback loop. Owns time state only — the host paints frames.
//
// Position model: tMs in [0, durationMs]. "Now" (tMs = durationMs with
// showingNative set) displays the native desktop snapshot, not a video frame,
// and exports with snapshotTMs = null.

export interface ScrubHost {
  /** Paint the base image: the current video frame or the native snapshot. */
  drawFrame(source: HTMLVideoElement | 'native'): void
  /** Time/duration/play/ready state changed; refresh dependent UI. */
  onState(): void
}

export class ScrubController {
  /** Current replay position in ms. */
  tMs: number
  durationMs: number
  ready = false
  failed = false
  playing = false

  private readonly video: HTMLVideoElement
  private showingNative = true
  private pendingSeekMs: number | null = null
  private seekInFlight = false
  private rafId = 0
  private settleWaiters: Array<() => void> = []
  // The Infinity-duration workaround performs seeks the position model must
  // ignore: they end at the file tail and would otherwise read as user scrubs.
  private workaroundSeek = false
  private durationAdopted = false

  constructor(webm: ArrayBuffer, fallbackDurationMs: number, private readonly host: ScrubHost) {
    this.durationMs = Math.max(1, Math.round(fallbackDurationMs))
    this.tMs = this.durationMs
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'auto'
    video.src = URL.createObjectURL(new Blob([webm], { type: 'video/webm' }))
    video.addEventListener(
      'loadedmetadata',
      () => {
        // MediaRecorder webm reports Infinity until parsed to the end; a far
        // seek forces Chromium to resolve the real duration (durationchange).
        if (video.duration === Infinity) {
          this.workaroundSeek = true
          video.currentTime = 1e7
        }
      },
      { once: true },
    )
    video.addEventListener('durationchange', () => this.adoptDuration())
    video.addEventListener('canplay', () => this.markReady())
    video.addEventListener('seeked', () => this.onSeeked())
    // 'ended' only matters during playback. Chromium also fires it when a seek
    // lands on the file tail (including the duration workaround above); letting
    // that snap to "now" made wheel scrubbing keep jumping back to the latest
    // frame. Paused seeks must never move the position model.
    video.addEventListener('ended', () => {
      if (this.playing) this.snapToNow()
    })
    video.addEventListener('error', () => {
      this.failed = true
      this.notifySettled() // in-flight seeks will never complete; release waiters
      this.host.onState()
    })
    this.video = video
  }

  /** True when the native snapshot (the capture instant) is displayed. */
  get atNow(): boolean {
    return this.showingNative
  }

  /** Export-payload position of the displayed frame; null = the capture instant. */
  exportTMs(): number | null {
    return this.showingNative ? null : Math.round(this.tMs)
  }

  /**
   * Resolves once no seek is pending or in flight — i.e. the painted frame
   * matches tMs. Export waits on this so a wheel burst right before Enter
   * cannot ship a stale frame under a newer snapshot_t_ms.
   */
  whenSettled(): Promise<void> {
    if (this.settled) return Promise.resolve()
    return new Promise((resolve) => this.settleWaiters.push(resolve))
  }

  private get settled(): boolean {
    return this.failed || (this.pendingSeekMs === null && !this.seekInFlight)
  }

  private notifySettled(): void {
    if (!this.settled) return
    const waiters = this.settleWaiters
    this.settleWaiters = []
    for (const resolve of waiters) resolve()
  }

  /** Wheel scrubbing: pauses playback instantly, then moves by deltaMs. */
  scrubBy(deltaMs: number): void {
    if (!this.ready) return
    this.scrubTo(this.tMs + deltaMs)
  }

  scrubTo(ms: number): void {
    if (!this.ready) return
    this.stopPlayback()
    const t = Math.max(0, Math.min(this.durationMs, ms))
    if (t >= this.durationMs) {
      this.snapToNow()
      return
    }
    this.tMs = t
    this.showingNative = false
    this.requestSeek(t)
    this.host.onState()
  }

  togglePlay(): void {
    if (!this.ready || this.failed) return
    if (this.playing) {
      this.pause()
      return
    }
    if (this.showingNative) {
      // Nothing lies ahead of "now": play restarts from the beginning.
      this.video.currentTime = 0
      this.tMs = 0
    }
    this.showingNative = false
    this.playing = true
    void this.video.play().catch(() => {
      this.playing = false
      this.host.onState()
    })
    this.rafId = requestAnimationFrame(() => this.playbackTick())
    this.host.onState()
  }

  /** Stops playback (no-op when not playing), keeping the current frame. */
  pause(): void {
    if (!this.playing) return
    this.stopPlayback()
    this.host.onState()
  }

  private stopPlayback(): void {
    if (!this.playing) return
    this.playing = false
    cancelAnimationFrame(this.rafId)
    this.video.pause()
    this.tMs = Math.min(this.video.currentTime * 1000, this.durationMs)
  }

  private playbackTick(): void {
    if (!this.playing) return
    this.tMs = Math.min(this.video.currentTime * 1000, this.durationMs)
    this.host.drawFrame(this.video)
    this.host.onState()
    this.rafId = requestAnimationFrame(() => this.playbackTick())
  }

  private snapToNow(): void {
    this.stopPlayback()
    this.showingNative = true
    this.tMs = this.durationMs
    this.pendingSeekMs = null
    this.notifySettled()
    this.host.drawFrame('native')
    this.host.onState()
  }

  private markReady(): void {
    if (this.ready) return
    this.ready = true
    this.adoptDuration()
    this.host.onState()
  }

  private adoptDuration(): void {
    const seconds = this.video.duration
    if (!Number.isFinite(seconds) || seconds <= 0) return
    const ms = seconds * 1000
    // Cue-less webm re-parses can re-fire durationchange with small jitter on
    // every seek; adopting each value dragged the position toward the end
    // while the user was scrubbing. Ignore refinements once adopted.
    if (this.durationAdopted && Math.abs(ms - this.durationMs) < 250) return
    this.durationAdopted = true
    this.durationMs = ms
    // "At the end" is the explicit native-snapshot state, never inferred from
    // the numbers — a scrubbed position only gets clamped into range.
    this.tMs = this.showingNative ? ms : Math.min(this.tMs, ms)
    this.host.onState()
  }

  // Coalesce seeks: at most one in flight; the latest requested position wins.
  private requestSeek(ms: number): void {
    this.pendingSeekMs = ms
    if (!this.seekInFlight) this.pumpSeek()
  }

  private pumpSeek(): void {
    if (this.pendingSeekMs === null) return
    const ms = this.pendingSeekMs
    this.pendingSeekMs = null
    this.seekInFlight = true
    this.video.currentTime = ms / 1000
  }

  private onSeeked(): void {
    if (this.workaroundSeek) {
      this.workaroundSeek = false
      // The duration probe's own completion carries no user position — consume
      // it. If a real scrub superseded the probe, fall through and process
      // this event as that seek's completion instead.
      if (!this.seekInFlight && this.pendingSeekMs === null) return
    }
    this.seekInFlight = false
    if (!this.showingNative && !this.playing) {
      this.host.drawFrame(this.video)
      this.pumpSeek() // may put another seek in flight; settled stays false then
    }
    this.notifySettled()
  }
}

/**
 * Signed scrub delta for a wheel event. Wheel up moves toward the past
 * (negative) unless inverted; Shift = 1 s, Alt = 1 frame, plain = sensitivity.
 * Returns 0 for horizontal-only wheel input (tilt click, trackpad side-swipe).
 */
export function wheelScrubDeltaMs(
  e: { deltaY: number; shiftKey: boolean; altKey: boolean },
  fps: number,
  sensitivityMs: number,
  invert: boolean,
): number {
  if (e.deltaY === 0) return 0
  const step = e.shiftKey ? 1000 : e.altKey ? 1000 / Math.max(1, fps) : sensitivityMs
  const towardNow = invert ? e.deltaY < 0 : e.deltaY > 0
  return towardNow ? step : -step
}
