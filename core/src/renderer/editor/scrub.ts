// Replay scrub controller: a hidden <video> over the replay bytes, coalesced
// seeks, and a playback loop. Owns time state only — the host paints frames.
//
// Position model: tMs in [0, durationMs]. "Now" (tMs = durationMs with
// showingNative set) displays the native desktop snapshot, not a video frame,
// and exports with snapshotTMs = null.
//
// THE TRIM RANGE IS THE BOUNDARY (GOAL "Editor Input System"): once in/out
// points are set, the position model lives in [rangeStart, rangeEnd] instead of
// [0, durationMs] — wheel scrubbing, playback and timeline drags all clamp at
// the handles rather than wandering into footage that will not be saved, and
// playback stops at the out point. With no trim set the range IS the whole
// buffer, so every path below behaves exactly as it did before.
//
// The ONE thing the range does not move is "now": the native capture-instant
// frame is the desktop grab, not a video position, so a trim never pushes the
// editor off it (see clampIntoRange). Scrubbing away is the user's choice; a
// trim alone must never change which pixels snapshot.png is made of.

// ---------------------------------------------------------------------------
// THE FRAME ON SCREEN IS THE TRUTH, NOT THE PLAYHEAD (#81).
//
// A seek to T does not produce a frame at T. It produces the last frame at or
// before T, because that is the only picture that exists. Meanwhile the surface
// ring answers T exactly. Ask one for a rectangle and paint it over the other
// and the box sits beside the window instead of on it — which is what the user
// reported: "창위치랑 선택하는 위치랑 안맞잖아".
//
// MEASURED on CapturePack_2026-07-29_001952 (0.2.0-rc.4, 15 fps requested):
// the replay holds 264 frames over 22.2 s — 11.9 fps actual — and the gap
// between consecutive frames reaches 1009 ms. Across the seven picked boxes in
// that pack, each box matched the true picture to a median of 9 ms, but the
// frame the editor was DISPLAYING at the box's own time was up to 498 ms old,
// and that alone put one box 1304 px away from its window.
//
// So the box was right and the picture was late. The correction cannot be a
// constant: the frame rate a machine actually achieves depends on the machine,
// the encoder and what else is running, and the user said so — "프레임 레이트랑
// 컴퓨터에 따라 다를 수 있으니까 자동 보정이 들어가야 해". `mediaTime` is the
// presentation timestamp of the frame the compositor put on screen, reported by
// the browser itself, so it needs no frame-rate assumption at all and is right
// on every machine by construction.
// ---------------------------------------------------------------------------

/**
 * Keeps `sink` fed with the media time of the frame currently on screen.
 *
 * Re-arms itself after every frame, so it tracks playback and seeks alike. The
 * `typeof` guard is not defensive noise: the callback is typed as present but a
 * renderer that lacks it must fall back to the playhead rather than throw, and
 * that fallback is exactly the behaviour that shipped before #81.
 */
/**
 * ONE EVENT CARRIES BOTH THE PIXELS AND THEIR TIME (#95).
 *
 * The base image used to be drawn from the playback rAF and the seek handler,
 * while the presented time was updated separately by this callback. That is
 * two clocks sampling one video: between the rAF that draws frame N and the
 * callback that files frame N+1, a box resolved from the time lands on pixels
 * from the other frame. Standing still that is invisible; on a window being
 * dragged at 5000 px/s one frame is 340 px, which is the report — "the box
 * moves and the picture arrives afterwards".
 *
 * The annotated render never had this: it draws the frame and its boxes from
 * one `metadata`. So does this now. `drawFrame` is called HERE, with the time
 * that describes exactly the pixels the video is holding, and whoever reads
 * `presentedMs` afterwards reads the same frame that was drawn.
 *
 * Returns whether the callback exists at all — a renderer without it keeps the
 * old rAF-driven draw, because a stale picture beats no picture.
 */
function trackPresentedFrames(video: HTMLVideoElement, sink: (mediaTimeMs: number) => void): boolean {
  if (typeof video.requestVideoFrameCallback !== 'function') return false
  const pump: VideoFrameRequestCallback = (_now, metadata) => {
    sink(metadata.mediaTime * 1000)
    video.requestVideoFrameCallback(pump)
  }
  video.requestVideoFrameCallback(pump)
  return true
}

export interface ScrubHost {
  /** Paint the base image: the current video frame or the native snapshot. */
  drawFrame(source: HTMLVideoElement | 'native'): void
  /** Time/duration/play/ready state changed; refresh dependent UI. */
  onState(): void
  /**
   * A new video frame reached the screen (#81).
   *
   * Optional, and only worth implementing for things that must agree with the
   * PICTURE rather than the playhead. It exists because a seek can outlast the
   * editor's settle timer: without it, whoever reads `presentedMs` on that timer
   * reads the frame the seek was leaving, not the one it arrived at.
   */
  onFrame?(): void
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
  // Replay Trim (GOAL "Replay Trim" / "Editor Input System") mirrored from the
  // editor: the KEPT range on this replay's clock. 0 / null = untrimmed, i.e.
  // the whole buffer is in range.
  private rangeInMs = 0
  private rangeOutMs: number | null = null
  // Exact-length replay (GOAL "The replay is exactly the configured length"):
  // the raw recorder buffer overshoots, so the editor is handed the LOGICAL
  // last-N-second window — sourceStartMs is where it begins in the raw file and
  // durationCapMs is its length. The trim range above lives on top of this
  // window, never on the raw buffer.
  private readonly sourceStartMs: number
  private readonly durationCapMs: number
  // Raw-file time of the frame the compositor last presented (#81). Null until
  // the first frame is painted, or forever on a renderer without the callback.
  private presentedRawMs: number | null = null
  /** Whether the frame callback drives the base draw (see trackPresentedFrames). */
  private frameDriven = false
  private frameGuard = 0

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
      if (!this.playing) return
      // With an out point set, the end of the FILE is outside the kept range;
      // the tick normally stops there first, and this is the backstop.
      if (this.nowInRange) this.snapToNow()
      else this.scrubTo(this.rangeEndMs)
    })
    video.addEventListener('error', () => {
      this.failed = true
      this.notifySettled() // in-flight seeks will never complete; release waiters
      this.host.onState()
    })
    this.frameDriven = trackPresentedFrames(video, (mediaTimeMs) => {
      this.presentedRawMs = mediaTimeMs
      // The picture and its time, together, before anything can read either.
      if (!this.showingNative) this.host.drawFrame(video)
      this.host.onFrame?.()
    })
    this.video = video
  }

  /** True when the native snapshot (the capture instant) is displayed. */
  get atNow(): boolean {
    return this.showingNative
  }

  /**
   * The position of the frame the user is LOOKING AT, for anything that has to
   * agree with the picture (#81) — object picking above all.
   *
   * `tMs` is where the playhead was asked to go; this is where the replay could
   * actually go. They differ by up to one frame gap, which this recorder lets
   * reach a full second, and every millisecond of that difference becomes pixels
   * of error under a moving window. The playhead keeps `tMs`: the timeline must
   * not jump backwards under the user's hand just because the footage is sparse.
   *
   * Falls back to `tMs` while showing the native snapshot (which is not a video
   * frame at all) and on any renderer that cannot report a presentation time.
   */
  get presentedMs(): number {
    if (this.showingNative || this.presentedRawMs === null) return this.tMs
    return this.clampToRange(this.logicalMs(this.presentedRawMs))
  }

  /** First position inside the kept range (0 while untrimmed). */
  get rangeStartMs(): number {
    return Math.max(0, Math.min(this.rangeInMs, this.durationMs))
  }

  /** Last position inside the kept range (the buffer end while untrimmed). */
  get rangeEndMs(): number {
    const end = this.rangeOutMs === null ? this.durationMs : Math.min(this.rangeOutMs, this.durationMs)
    return Math.max(this.rangeStartMs, end)
  }

  /**
   * Whether the capture instant ("now", the native snapshot) is still inside
   * the kept range. With an out point set it is NOT: the out point becomes the
   * effective end of the clock, so the editor never sits on a frozen desktop
   * frame that the saved replay stops before.
   */
  private get nowInRange(): boolean {
    return this.rangeOutMs === null || this.rangeOutMs >= this.durationMs
  }

  /**
   * Mirrors the editor's trim state (in ms on this clock; outMs null = the
   * untrimmed end) and re-clamps the current position into the new range —
   * moving a handle past the playhead pulls the playhead with it. The one
   * exception is "now": see clampIntoRange.
   */
  setRange(inMs: number, outMs: number | null): void {
    this.rangeInMs = Math.max(0, inMs)
    this.rangeOutMs = outMs
    this.clampIntoRange()
  }

  /**
   * Pulls the position back inside [rangeStart, rangeEnd]; a no-op inside it.
   *
   * "NOW" IS NOT FOOTAGE. The native capture-instant frame is the desktop grab
   * snapshot.png is composed from at full resolution — it is not a position in
   * the video that a trim could exclude. So setting an out point never forces
   * the position off it: dragging the out handle one pixel would otherwise flip
   * the exported still from the crisp native grab to a re-encoded VP9 frame the
   * user never scrubbed to, and stamp it with a snapshot_t_ms to match — the
   * pack's primary evidence, silently downgraded by "capture, trim the tail,
   * Save". The trim still bounds every MOVEMENT (scrubTo clamps, playback stops
   * at the out point), so once the user does scrub, the range owns the position.
   */
  private clampIntoRange(): void {
    if (!this.ready) return
    if (this.showingNative) return
    if (this.tMs < this.rangeStartMs) this.scrubTo(this.rangeStartMs)
    else if (this.tMs > this.rangeEndMs) this.scrubTo(this.rangeEndMs)
  }

  private clampToRange(ms: number): number {
    return Math.max(this.rangeStartMs, Math.min(this.rangeEndMs, ms))
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
    // The trim handles are the walls: a position past one lands ON it.
    const end = this.rangeEndMs
    const t = this.clampToRange(ms)
    // Only the UNTRIMMED end is "now" — with an out point set, the capture
    // instant lies outside the kept range and the out frame is the end.
    if (t >= end && this.nowInRange) {
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
    const start = this.rangeStartMs
    // Nothing lies ahead of the range end: play restarts from the in point.
    //
    // The extra conditions are scoped to a TRIMMED replay on purpose, so the
    // untrimmed path is bit-for-bit what it always was — resume from wherever
    // the video is, and let 'ended' snap to "now". Untrimmed, `rangeEndMs` is
    // `durationMs`, so an unscoped test would also restart from 0 for any
    // position within 1 ms of the end (reachable by scrubbing, or by pausing
    // playback that playbackTick clamped there).
    const trimmed = this.rangeInMs > 0 || !this.nowInRange
    if (this.showingNative || (trimmed && (this.tMs >= this.rangeEndMs - 1 || this.tMs < start))) {
      // Seeks are on the RAW file clock; the position model is on the logical
      // last-N-second window, which begins at sourceStartMs.
      this.video.currentTime = (this.sourceStartMs + start) / 1000
      this.tMs = start
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
    this.tMs = this.clampToRange(this.logicalMs(this.video.currentTime * 1000))
  }

  /** Raw file position (ms) -> the logical window's clock, clamped to it. */
  private logicalMs(rawMs: number): number {
    return Math.min(Math.max(0, rawMs - this.sourceStartMs), this.durationMs)
  }

  private playbackTick(): void {
    if (!this.playing) return
    const logical = this.logicalMs(this.video.currentTime * 1000)
    // Playback STOPS at the out point (GOAL "Editor Input System"). Only when a
    // trim is actually set: untrimmed, the tail is left to the end of the
    // logical window below, exactly as before.
    if (!this.nowInRange && logical >= this.rangeEndMs) {
      this.stopPlayback()
      this.scrubTo(this.rangeEndMs)
      return
    }
    this.tMs = this.clampToRange(logical)
    // The logical window ends before the raw file does (the surplus the exact
    // -length cut will drop), so the tick — not 'ended' — is what reaches it.
    if (this.nowInRange && this.tMs >= this.durationMs) {
      this.snapToNow()
      return
    }
    // Frame-driven: the callback above draws, on the frame's own event. The
    // tick still advances the playhead and refreshes the timebar.
    if (!this.frameDriven) this.host.drawFrame(this.video)
    this.host.onState()
    this.rafId = requestAnimationFrame(() => this.playbackTick())
  }

  /**
   * Back to the capture instant, publicly: the trim-handle drag borrows the
   * preview to show the frame under the handle, and a drag that STARTED at
   * "now" returns there on release so the export still ships the native grab
   * (the guarantee clampIntoRange protects).
   */
  toNow(): void {
    if (!this.ready) return
    this.snapToNow()
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

  /** Draws from the seek if the frame callback has not, within a beat. */
  private guardFrameDraw(): void {
    const before = this.presentedRawMs
    window.clearTimeout(this.frameGuard)
    this.frameGuard = window.setTimeout(() => {
      if (this.presentedRawMs !== before || this.showingNative) return
      this.host.drawFrame(this.video)
    }, 250)
  }

  private markReady(): void {
    if (this.ready) return
    this.ready = true
    this.adoptDuration()
    // A trim set before the video was ready (or before its real duration was
    // parsed) still owns the position from the first usable frame on.
    this.clampIntoRange()
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
    // The trim range is expressed on this clock, so a new duration moves its
    // end (an untrimmed out point IS the duration).
    this.clampIntoRange()
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
      // A seek's frame arrives at the callback too, with its own time; drawing
      // it here as well would put the OLD time beside the NEW pixels for one
      // paint, which is the seam this whole change removes.
      //
      // A frozen picture is a worse failure than a box one frame out, so the
      // callback is given a moment and then overruled. It has never been
      // observed to miss a seeked frame; this exists so that if it ever does,
      // the editor is stale rather than blank.
      if (this.frameDriven) this.guardFrameDraw()
      else this.host.drawFrame(this.video)
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
  /** Whether the frame callback drives this screen's draw (see the master). */
  private frameDriven = false
  private frameGuard = 0
  private readonly draw: (source: HTMLVideoElement | 'native') => void
  private showingNative = true
  private pendingSeekMs: number | null = null
  private seekInFlight = false
  private lastTargetMs: number | null = null
  /** Raw media time of the frame this screen is actually showing (#88). */
  private presentedRawMs: number | null = null
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
    // Same binding as the master (#95): this screen's pixels and this screen's
    // frame time leave one event together, so a box resolved on this clock is
    // resolved for the picture this screen is actually showing.
    this.frameDriven = trackPresentedFrames(video, (mediaTimeMs) => {
      this.presentedRawMs = mediaTimeMs
      if (!this.showingNative) this.draw(video)
    })
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
  /**
   * The pack time of the frame THIS SCREEN is showing, or null when it has not
   * presented one (#88).
   *
   * EVERY SCREEN HAS ITS OWN FRAMES. The recorders are independent, so seeking
   * two replays to the same pack time lands them on two different moments — up
   * to a frame apart, and this recorder's gaps have been measured at up to a
   * second. A box drawn on this screen has to be resolved on THIS clock, or it
   * is placed for a picture the neighbour is showing.
   */
  get presentedMs(): number | null {
    return this.presentedRawMs === null ? null : this.presentedRawMs - this.offsetMs
  }

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
      if (this.frameDriven) {
        const before = this.presentedRawMs
        window.clearTimeout(this.frameGuard)
        this.frameGuard = window.setTimeout(() => {
          if (this.presentedRawMs !== before || this.showingNative) return
          this.draw(this.video)
        }, 250)
      } else {
        this.draw(this.video)
      }
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
  /** The focused display put a new frame on screen; see `ScrubHost.onFrame` (#81). */
  onFrame?(): void
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
  /** displayIndex -> that screen's replay, for its own frame clock (#88). */
  private readonly byDisplay = new Map<number, SlaveReplay>()
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
        onFrame: () => host.onFrame?.(),
      },
    )
    for (const r of replays) {
      if (r.focused) continue
      const slave = new SlaveReplay(
        r.webm,
        r.mimeType,
        r.durationMs,
        r.offsetMs,
        (source) => {
          host.drawFrame(r.displayIndex, source)
          // A secondary seek can settle after the focused frame. Its pixels and
          // presented time changed together, so context must be re-queried from
          // this callback too; otherwise the board keeps the object index from
          // the secondary's previous frame until the user scrubs again.
          host.onFrame?.()
        },
      )
      this.byDisplay.set(r.displayIndex, slave)
      this.slaves.push(
        slave,
      )
    }
  }

  get tMs(): number {
    return this.master.tMs
  }

  /**
   * The board's position as the PICTURE has it (#81).
   *
   * The focused display's replay is the pack clock (see "ONE CLOCK" above), so
   * its presented frame is the board's. The slaves are seeked from this same
   * clock and land on their own nearest frames; making each display answer on
   * its own presented time is #38's business, not this one's.
   */
  get presentedMs(): number {
    return this.master.presentedMs
  }

  /**
   * The pack time THIS SCREEN is showing (#88).
   *
   * EVERY SCREEN HAS ITS OWN FRAMES. The recorders run independently, so
   * seeking two replays to the same pack position lands them on two different
   * moments — and this recorder's gaps have been measured at up to a second. A
   * box drawn on a screen must be resolved on THAT screen's clock, or it is
   * placed for a picture the neighbour is showing.
   *
   * Falls back to the board's own position for a display with no replay of its
   * own (it shows a frozen snapshot, which has no clock to differ on) and for a
   * renderer that cannot report a presentation time.
   */
  presentedMsFor(displayIndex: number): number {
    if (displayIndex === this.focusedIndex) return this.master.presentedMs
    return this.byDisplay.get(displayIndex)?.presentedMs ?? this.master.presentedMs
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

  /** Back to the capture instant on every display (see ScrubController.toNow). */
  toNow(): void {
    this.master.toNow()
  }

  scrubTo(ms: number): void {
    this.master.scrubTo(ms)
  }

  /**
   * The kept range (GOAL "Editor Input System": "the trim range is the
   * boundary"). Only the MASTER needs it: it owns the one position on the
   * board, and every follower is seeked from that position, so a clock that
   * cannot leave [in, out] keeps every display inside it too.
   */
  setRange(inMs: number, outMs: number | null): void {
    this.master.setRange(inMs, outMs)
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
    // The master is NOT playing, so no follower may be either — playback that
    // ends on its own (the trim out point, the end of the buffer) never goes
    // through togglePlay/pause, and a still-rolling follower would drift off
    // the one board moment within a frame.
    for (const s of this.slaves) {
      s.pause()
      s.seekTo(this.master.tMs)
    }
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
