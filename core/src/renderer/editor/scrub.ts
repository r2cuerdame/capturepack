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
  private readonly sourceStartMs: number
  private readonly durationCapMs: number

  constructor(
    webm: ArrayBuffer,
    mimeType: string,
    fallbackDurationMs: number,
    sourceStartMs: number,
    private readonly host: ScrubHost,
  ) {
    this.durationMs = Math.max(1, Math.round(fallbackDurationMs))
    this.durationCapMs = this.durationMs
    this.sourceStartMs = Math.max(0, Math.round(sourceStartMs))
    this.tMs = this.durationMs
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'auto'
    video.src = URL.createObjectURL(new Blob([webm], { type: mimeType }))
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

  /**
   * What is on screen right now for this replay: the video element (a scrubbed
   * or playing frame) or 'native' (the capture instant). Export composes
   * snapshot.png from exactly this, at the display's native resolution — the
   * board canvas is a bounded-memory view and must never become the saved file.
   *
   * A FAILED video reports 'native': drawing an element that never decoded is a
   * silent no-op in canvas, which would have shipped a blank snapshot.png.
   */
  get frameSource(): HTMLVideoElement | 'native' {
    return this.showingNative || this.failed ? 'native' : this.video
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
      this.video.currentTime = this.sourceStartMs / 1000
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
    this.tMs = Math.min(
      Math.max(0, this.video.currentTime * 1000 - this.sourceStartMs),
      this.durationMs,
    )
  }

  private playbackTick(): void {
    if (!this.playing) return
    this.tMs = Math.min(
      Math.max(0, this.video.currentTime * 1000 - this.sourceStartMs),
      this.durationMs,
    )
    if (this.tMs >= this.durationMs) {
      this.snapToNow()
      return
    }
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
    const ms = Math.min(this.durationCapMs, Math.max(1, seconds * 1000 - this.sourceStartMs))
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
    this.video.currentTime = (this.sourceStartMs + ms) / 1000
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

// ---------------------------------------------------------------------------
// ONE CLOCK for the whole board (GOAL "Multi-Monitor Support": "the scrub
// timeline drives all of them together so the whole desktop moves through time
// as one moment").
//
// The FOCUSED display's replay is the pack clock — annotation lifetimes,
// snapshot_t_ms and every timeline offset are on it (SPEC §8.4, §10.1) — so it
// stays a full ScrubController and keeps the entire position model. Every other
// display's replay is a SLAVE: a video with coalesced seeks and no opinion
// about where the playhead is. A display without a replay has no slave at all
// and simply keeps showing its frozen snapshot.
// ---------------------------------------------------------------------------

/** Drift past this during playback is corrected with a seek; below it, left alone. */
const SLAVE_DRIFT_MS = 500

/**
 * One non-focused display's replay, seeked from the board clock.
 *
 * `offsetMs` converts a pack-clock position into this replay's own clock. The
 * recorders are all stopped by the same trigger, so untrimmed replays are
 * END-aligned; a trimmed focused replay makes SPEC §5.6's normative rule (add
 * `trim_offset_ms`) the right answer instead. main computes it — this class
 * only applies it.
 */
class SlaveReplay {
  ready = false
  failed = false
  durationMs: number

  private readonly video: HTMLVideoElement
  private readonly offsetMs: number
  private readonly draw: (source: HTMLVideoElement | 'native') => void
  private showingNative = true
  private pendingSeekMs: number | null = null
  private seekInFlight = false
  private lastTargetMs: number | null = null
  private settleWaiters: Array<() => void> = []
  private workaroundSeek = false
  private durationAdopted = false

  constructor(
    webm: ArrayBuffer,
    mimeType: string,
    durationMs: number,
    offsetMs: number,
    draw: (source: HTMLVideoElement | 'native') => void,
  ) {
    this.durationMs = Math.max(1, Math.round(durationMs))
    this.offsetMs = offsetMs
    this.draw = draw
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'auto'
    video.src = URL.createObjectURL(new Blob([webm], { type: mimeType }))
    video.addEventListener(
      'loadedmetadata',
      () => {
        // Same MediaRecorder quirk the master handles: duration is Infinity
        // until the file has been parsed to the end.
        if (video.duration === Infinity) {
          this.workaroundSeek = true
          video.currentTime = 1e7
        }
      },
      { once: true },
    )
    video.addEventListener('durationchange', () => this.adoptDuration())
    video.addEventListener('canplay', () => {
      this.ready = true
    })
    video.addEventListener('seeked', () => this.onSeeked())
    video.addEventListener('error', () => {
      this.failed = true
      this.notifySettled()
    })
    this.video = video
  }

  /** Shows the frozen snapshot again (the board is at "now"). */
  showNative(): void {
    this.pause()
    if (this.showingNative) return
    this.showingNative = true
    this.lastTargetMs = null
    this.pendingSeekMs = null
    this.notifySettled()
    this.draw('native')
  }

  /** Seeks to a PACK-clock position. Repeated identical targets are free. */
  seekTo(packMs: number): void {
    const target = this.clamp(packMs + this.offsetMs)
    if (!this.showingNative && this.lastTargetMs === target) return
    this.showingNative = false
    this.lastTargetMs = target
    this.pendingSeekMs = target
    if (!this.seekInFlight) this.pump()
  }

  /** Starts playing from a pack-clock position, in step with the master. */
  play(packMs: number): void {
    const target = this.clamp(packMs + this.offsetMs)
    this.showingNative = false
    this.lastTargetMs = null
    this.video.currentTime = target / 1000
    void this.video.play().catch(() => {
      /* a slave that will not play simply holds its frame */
    })
  }

  /** Keeps a playing slave within SLAVE_DRIFT_MS of the board clock. */
  follow(packMs: number): void {
    if (this.showingNative || this.video.paused) return
    const target = this.clamp(packMs + this.offsetMs)
    if (Math.abs(this.video.currentTime * 1000 - target) <= SLAVE_DRIFT_MS) return
    this.video.currentTime = target / 1000
  }

  pause(): void {
    if (!this.video.paused) this.video.pause()
  }

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

  private clamp(ms: number): number {
    return Math.max(0, Math.min(this.durationMs, ms))
  }

  private adoptDuration(): void {
    const seconds = this.video.duration
    if (!Number.isFinite(seconds) || seconds <= 0) return
    const ms = seconds * 1000
    if (this.durationAdopted && Math.abs(ms - this.durationMs) < 250) return
    this.durationAdopted = true
    this.durationMs = ms
  }

  private pump(): void {
    if (this.pendingSeekMs === null) return
    const ms = this.pendingSeekMs
    this.pendingSeekMs = null
    this.seekInFlight = true
    this.video.currentTime = ms / 1000
  }

  private onSeeked(): void {
    if (this.workaroundSeek) {
      this.workaroundSeek = false
      if (!this.seekInFlight && this.pendingSeekMs === null) return
    }
    this.seekInFlight = false
    if (!this.showingNative && this.video.paused) {
      this.draw(this.video)
      this.pump()
    }
    this.notifySettled()
  }
}

/** What the board needs painted as the one clock moves. */
export interface BoardScrubHost {
  /** Paint one display's base frame: its replay frame, or its frozen snapshot. */
  drawFrame(displayIndex: number, source: HTMLVideoElement | 'native'): void
  /** Time/duration/play/ready state changed; refresh dependent UI. */
  onState(): void
}

/** One display's replay as the board receives it. */
export interface BoardReplayInput {
  displayIndex: number
  focused: boolean
  webm: ArrayBuffer
  mimeType: string
  durationMs: number
  /** Raw-source position corresponding to logical time 0 (focused input only). */
  sourceStartMs: number
  /** ms to add to the pack clock to reach this replay's own clock. */
  offsetMs: number
}

/**
 * The board's single playhead: the focused display's ScrubController plus a
 * SlaveReplay per other display that recorded one. Everything the editor and
 * the timebar read (tMs, durationMs, ready, playing, atNow) is the MASTER's —
 * there is exactly one position on the board, by construction.
 */
export class BoardScrub {
  private readonly master: ScrubController
  private readonly slaves: SlaveReplay[] = []
  private readonly focusedIndex: number

  constructor(replays: readonly BoardReplayInput[], host: BoardScrubHost) {
    const focused = replays.find((r) => r.focused)
    if (focused === undefined) throw new Error('the board clock needs the focused display’s replay')
    this.focusedIndex = focused.displayIndex
    this.master = new ScrubController(
      focused.webm,
      focused.mimeType,
      focused.durationMs,
      focused.sourceStartMs,
      {
        drawFrame: (source) => host.drawFrame(focused.displayIndex, source),
        onState: () => {
          this.syncSlaves()
          host.onState()
        },
      },
    )
    for (const r of replays) {
      if (r.focused) continue
      this.slaves.push(
        new SlaveReplay(r.webm, r.mimeType, r.durationMs, r.offsetMs, (source) =>
          host.drawFrame(r.displayIndex, source),
        ),
      )
    }
  }

  get tMs(): number {
    return this.master.tMs
  }

  get durationMs(): number {
    return this.master.durationMs
  }

  get ready(): boolean {
    return this.master.ready
  }

  get failed(): boolean {
    return this.master.failed
  }

  get playing(): boolean {
    return this.master.playing
  }

  get atNow(): boolean {
    return this.master.atNow
  }

  /** The focused display's current frame — what snapshot.png is composed from. */
  get focusedSource(): HTMLVideoElement | 'native' {
    return this.master.frameSource
  }

  exportTMs(): number | null {
    return this.master.exportTMs()
  }

  scrubBy(deltaMs: number): void {
    this.master.scrubBy(deltaMs)
  }

  scrubTo(ms: number): void {
    this.master.scrubTo(ms)
  }

  togglePlay(): void {
    this.master.togglePlay()
    // The master's own onState fires syncSlaves; this covers the start of
    // playback, where the slaves must LAUNCH rather than seek.
    if (this.master.playing) {
      for (const s of this.slaves) s.play(this.master.tMs)
    } else {
      for (const s of this.slaves) s.pause()
    }
  }

  pause(): void {
    this.master.pause()
    for (const s of this.slaves) s.pause()
  }

  /**
   * Resolves once EVERY display's painted frame matches the board clock. Export
   * waits on this so a wheel burst right before Enter cannot ship a stale frame
   * — with N videos that is N coalesced seeks, not one.
   */
  async whenSettled(): Promise<void> {
    await Promise.all([this.master.whenSettled(), ...this.slaves.map((s) => s.whenSettled())])
  }

  /** True while the clock belongs to this display (only the focused one does). */
  isMaster(displayIndex: number): boolean {
    return displayIndex === this.focusedIndex
  }

  private syncSlaves(): void {
    if (this.slaves.length === 0) return
    if (this.master.atNow) {
      for (const s of this.slaves) s.showNative()
      return
    }
    if (this.master.playing) {
      for (const s of this.slaves) s.follow(this.master.tMs)
      return
    }
    for (const s of this.slaves) s.seekTo(this.master.tMs)
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
