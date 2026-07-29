// Replay ring buffer: two MediaRecorder sessions over one getDisplayMedia
// stream, started segmentSeconds apart and each rotated every 2x segmentSeconds.
// The older session therefore always holds between 1x and 2x segmentSeconds of
// footage as a single decodable recorder blob.
import type {
  CaptureFramesPayload,
  CaptureReadyPayload,
  CaptureReplayResultPayload,
  CaptureStartPayload,
  CaptureTickPayload,
} from '../../shared/ipc'

interface CaptureBridge {
  onStart(cb: (payload: CaptureStartPayload) => void): void
  onRequestReplay(cb: (requestId: string) => void): void
  sendReplayResult(payload: CaptureReplayResultPayload): void
  sendReady(payload: CaptureReadyPayload): void
  sendFrames(payload: CaptureFramesPayload): void
  sendTick(payload: CaptureTickPayload): void
  sendError(message: string): void
}

declare global {
  interface Window {
    captureBridge: CaptureBridge
  }
}

const RETRY_DELAY_MS = 3000
const CHUNK_TIMESLICE_MS = 1000
const VIDEO_BITS_PER_SECOND = 6_000_000

// --- Recording has to be EARNED (GOAL "Say that you are recording", issue #39)
//
// MediaRecorder.start() resolving proves only that an encoder was created. On a
// machine whose Windows Desktop Duplication is failing, getDisplayMedia hands
// back a live track, the recorder reports state "recording" — and not one frame
// ever arrives. The tray used to say "recording · last 30s ready" over an empty
// buffer, and the user only found out by pressing the hotkey and getting a
// screenshot-only pack.
//
// So a display counts as recording only once frames are PROVEN:
//  - a non-trivial amount of recorder output (a container header alone is not
//    evidence — it is produced with zero frames), or
//  - a growing delivered-frame count on the video track.
//
// Both are PROOF and only proof. Their absence is not the opposite: a healthy
// MP4 recorder emits 0 bytes between flushes, so only the frame counter can
// ever say "still nothing", and only where the runtime exposes it.
//
// Evidence is gathered on the timeslice/dataavailable path that already runs
// and from a counter the track keeps anyway; the only added machinery is ONE
// timer per capture — not per slot — that fires a handful of times a minute and
// polls nothing.

// A single H.264/VP8 keyframe of any real screen is tens of KB; an MP4 or WebM
// header with no frames in it is well under 2 KB.
//
// Bytes are POSITIVE PROOF ONLY, never the absence of it: the MP4 muxer
// Chromium picks first batches the whole slot and hands it over on stop(), so a
// perfectly healthy MP4 recorder reports 0 bytes on every timeslice until
// something flushes it (a rotation, a replay request, main's backstop probe).
// Measured on this desktop (Electron 36, 1 s timeslice): video/mp4;codecs=avc1
// fired ZERO dataavailable events in 12 s and then handed over all 361,764
// bytes on stop(), while the track had delivered 18 frames; VP8 on the same
// screen had 154,932 bytes by t=4 s. So a 4 s window of "0 bytes" says nothing
// whatsoever about the health of the format this app selects first.
const EVIDENCE_MIN_BYTES = 4096
// First proof must land within this. Deliberately longer than a slow first
// keyframe and shorter than a user noticing they are not recording.
const EVIDENCE_DEADLINE_MS = 4000
// Once proven, the same check keeps watch: a capture stream that dies at hour
// three (the duplication taken by a screen-share tool, a driver reset) is the
// SAME lie as one that never started, so it gets the same answer. Generous, and
// two windows must come up empty before a live recorder is restarted: an idle
// desktop still delivers frames, but slowly.
const EVIDENCE_STALL_MS = 12000
// How many empty windows condemn a capture — at the START as well as after
// proof. The start used to act on ONE, because the frame counter can say "still
// nothing" with certainty. But delivery is SLOW on a still desktop (measured
// here: 4 delivered frames in the first 4 s, and this is a healthy machine),
// slower still on the failing Desktop Duplication this whole path exists for,
// and the app starts at login alongside everything else fighting for the GPU.
// The cost of being wrong is an error balloon the user cannot turn off plus a
// restart that throws the buffer away; the cost of a second window is four more
// seconds before a genuinely dead capture is named. Take the four seconds.
const EVIDENCE_STRIKES = 2

interface RecorderFormat {
  mimeType: string
  replayFile: 'replay.webm' | 'replay.mp4'
}

// Probe hardware-friendly platform AVC first. Matroska/AVC is probed in the
// required position, but is not selected when MP4/AVC is unavailable: H.264 is
// not WebM-compatible and the CapturePack format intentionally has no .mkv
// replay name, so relabelling Matroska bytes as .webm would make a corrupt pack.
const RECORDER_FORMATS: readonly RecorderFormat[] = [
  { mimeType: 'video/mp4;codecs=avc1', replayFile: 'replay.mp4' },
  { mimeType: 'video/x-matroska;codecs=avc1', replayFile: 'replay.webm' },
  { mimeType: 'video/webm;codecs=vp8', replayFile: 'replay.webm' },
  { mimeType: 'video/webm;codecs=vp9', replayFile: 'replay.webm' },
]

interface Slot {
  index: 0 | 1
  recorder: MediaRecorder | null
  chunks: Blob[]
  startedAt: number
  rotateTimer: number | undefined
  startTimer: number | undefined
}

function newSlot(index: 0 | 1): Slot {
  return { index, recorder: null, chunks: [], startedAt: 0, rotateTimer: undefined, startTimer: undefined }
}

const slots: [Slot, Slot] = [newSlot(0), newSlot(1)]

let stream: MediaStream | null = null
let recorderFormat: RecorderFormat | null = null
let segmentMs = 0
let startPayload: CaptureStartPayload | null = null
let retried = false

// Frame evidence for the CURRENT capture (reset by every startCapture).
let evidenceTimer: number | undefined
// Recorder bytes seen since the last evidence check, across both slots.
let evidenceBytes = 0
// Delivered-frame count at the last evidence check — growth is proof by itself.
// This is NOT belt-and-braces: measured on a 4K desktop here, a perfectly
// healthy recorder had emitted 0 and 36 bytes after four seconds (a static
// screen, MP4 muxer still buffering) while the track had already delivered 3
// frames. Bytes alone would have called a working capture dead.
let evidenceFrames = 0
let framesProven = false
// Consecutive checks that found nothing. Restarting a live recorder costs the
// buffer and a false alarm costs a balloon the user cannot suppress, so a
// verdict always takes EVIDENCE_STRIKES empty windows in a row.
let evidenceStrikes = 0
// Said once per capture: this runtime exposes no delivered-frame counter, so
// this renderer will never condemn its own recorder (see checkFrameEvidence).
let unknownFramesLogged = false

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

/**
 * Frames the video track has actually delivered (MediaStreamTrack Statistics).
 *
 * null when the runtime does not expose the counter at all. There is then NO
 * independent signal to condemn a recorder with: recorder bytes cannot do it,
 * because the MP4 muxer this app selects first reports 0 on every timeslice
 * while recording perfectly (see EVIDENCE_MIN_BYTES). So a null here means this
 * renderer only ever PROVES — main's backstop probe, which stops the recorder
 * and therefore sees the flush, is what decides the negative case.
 */
function deliveredFrames(): number | null {
  if (startPayload?.simulateNoFrames === true) return 0
  const delivered = videoStats()?.deliveredFrames
  return typeof delivered === 'number' && Number.isFinite(delivered) ? delivered : null
}

/**
 * WHY A LOW FRAME RATE IS NOT YET A FAULT (#82).
 *
 * The cadence figure is `deliveredFrames`, which counts what the SOURCE handed
 * over — and a screen capture only produces a frame when the screen changes.
 * On this desk display 1 reads about 2 fps of 15 in every capture, which reads
 * as a broken recorder and may simply be a monitor nobody touched.
 *
 * `discardedFrames` separates the two, and only it can: frames made and thrown
 * away are a starved pipeline; frames never made are a still screen, and a
 * still screen is missing nothing. Reported rather than concluded from — which
 * of the two this desk has is a measurement the next capture makes.
 */
function videoStats(): { deliveredFrames?: number; discardedFrames?: number; totalFrames?: number } | null {
  const track = stream?.getVideoTracks()[0] as
    | (MediaStreamTrack & { stats?: { deliveredFrames?: number; discardedFrames?: number; totalFrames?: number } })
    | undefined
  return track?.stats ?? null
}

// ---------------------------------------------------------------------------
// THE RECORDER'S OWN ACCOUNT OF ITS CADENCE (#82).
//
// A replay is the evidence every pack is built on, and nothing in the app knew
// how good it was. A capture that stalled for nearly a second, twice, looked
// exactly like a healthy one from every log line this process writes; it took
// ffprobe on the saved file to see it. So the recorder measures itself.
//
// The delivered-frame counter is polled on a short timer. It cannot see WHEN
// each frame arrived — only that the count moved — so `worstStallMs` is
// quantised to the poll interval and is a LOWER BOUND on the true stall. That
// is the honest thing it can say, and it is enough to tell a stall from a
// steady 15 fps.
//
// The first seconds are excluded. A recorder that has just started is warming
// up — measured at 6.8 fps for the first three seconds of a fresh install
// against 13.1 fps after — and reporting that as the achieved rate would blame
// the recorder for the clock starting.
const CADENCE_POLL_MS = 100
const CADENCE_WARMUP_MS = 3_000

interface Cadence {
  startedAt: number
  firstCountedAt: number
  baseFrames: number
  lastFrames: number
  lastAdvanceAt: number
  worstStallMs: number
  /** `discardedFrames` when counting began, so the report is a delta (#82). */
  baseDiscarded: number
}

let cadence: Cadence | null = null
let cadenceTimer: number | undefined

function startCadenceMonitor(): void {
  window.clearInterval(cadenceTimer)
  const frames = deliveredFrames()
  if (frames === null) {
    cadence = null
    return
  }
  const now = performance.now()
  cadence = {
    startedAt: now,
    firstCountedAt: 0,
    baseFrames: 0,
    lastFrames: frames,
    lastAdvanceAt: now,
    worstStallMs: 0,
    baseDiscarded: videoStats()?.discardedFrames ?? 0,
  }
  cadenceTimer = window.setInterval(pollCadence, CADENCE_POLL_MS)
}

function pollCadence(): void {
  const c = cadence
  if (c === null) return
  const frames = deliveredFrames()
  if (frames === null) return
  const now = performance.now()
  if (frames > c.lastFrames) {
    // Only count a stall once the warm-up is over; before that a gap is the
    // pipeline starting, not the pipeline stopping.
    if (c.firstCountedAt !== 0) c.worstStallMs = Math.max(c.worstStallMs, now - c.lastAdvanceAt)
    c.lastFrames = frames
    c.lastAdvanceAt = now
  }
  if (c.firstCountedAt === 0 && now - c.startedAt >= CADENCE_WARMUP_MS) {
    c.firstCountedAt = now
    c.baseFrames = frames
    c.lastAdvanceAt = now
  }
}

/** What this recorder has achieved, or null while nothing can honestly be said. */
function cadenceReport(): { achievedFps: number; worstStallMs: number; discardedFrames: number | null } | null {
  const c = cadence
  if (c === null || c.firstCountedAt === 0) return null
  const elapsedMs = performance.now() - c.firstCountedAt
  if (elapsedMs < 1_000) return null
  const gained = c.lastFrames - c.baseFrames
  const discarded = videoStats()?.discardedFrames
  return {
    achievedFps: Math.round((gained / elapsedMs) * 1000 * 10) / 10,
    worstStallMs: Math.round(c.worstStallMs),
    // Made and thrown away — the half of a low frame rate that IS a fault
    // (#82). Null when the browser does not keep the counter.
    discardedFrames: typeof discarded === 'number' && Number.isFinite(discarded)
      ? Math.max(0, discarded - c.baseDiscarded)
      : null,
  }
}

// ---------------------------------------------------------------------------
// THE FRAME TICK DRIVES THE OBSERVER (#105).
//
// Core's surface ring used to sample on a timer of its own and be related to
// the recording by clock arithmetic. That error is invisible while a window is
// still and proportional to its speed while it moves, which is exactly how it
// was reported — "처음과 끝 가만히 있을대만 맞아" — and it measured 232 px, about
// 119 ms, mid-drag.
//
// A frame is the only instant a pack can show. So every captured frame asks
// Core to look at the desk NOW and hands over its own presentation time; the
// resulting sample is filed under that number. The picture and the rectangles
// become one instant by construction, and there is no clock left to be wrong
// about.
//
// Only the FOCUSED display ticks: it owns the pack clock (SPEC §10.1), and a
// second display ticking would file samples under a different recording's
// numbers.
let tickVideo: HTMLVideoElement | null = null
/**
 * Which tick chain is current (#91).
 *
 * `startFrameTicks` runs on every recorder start, and a recorder restarts:
 * recovery, a rebuilt window, a settings change. Each call used to add ANOTHER
 * self-re-arming callback chain and ANOTHER <video> sink on the same 4K stream,
 * and nothing ever removed the old ones. Measured after a few restarts: 3515
 * ticks over 35 seconds — a hundred a second where fifteen were intended —
 * which buried the ring's budget until the governor coarsened it to 279 samples
 * and left the replay PARTIAL, while the extra decoders starved the recorder
 * they were supposed to be timing.
 *
 * A generation counter retires the old chain on the first callback it gets.
 */
let tickGeneration = 0

function startFrameTicks(): void {
  stopFrameTicks()
  if (startPayload?.focused !== true) return
  const active = stream
  if (active === null) return
  const generation = ++tickGeneration
  // THE TICK MUST NOT COST THE RECORDING (#110).
  //
  // This is a SECOND sink on a stream the recorder is already consuming, and
  // the measurement is unambiguous: whichever display ticks is the one that
  // stalls. Display 2 ticked and managed 10.1 fps with an 897 ms worst stall
  // while display 1 sat at 14.8; the cursor moved, the roles swapped, and so
  // did the numbers.
  //
  // A hidden element still composites what it is given, and what it is given
  // here is 4K fifteen times a second. One pixel is enough: the frame CALLBACK
  // does not care about the element's size, and it is the callback — its
  // presentation time — that this exists for. The stream is not re-encoded and
  // the recorder's own path is untouched.
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.disableRemotePlayback = true
  video.width = 1
  video.height = 1
  video.style.position = 'fixed'
  video.style.width = '1px'
  video.style.height = '1px'
  video.style.opacity = '0'
  video.style.pointerEvents = 'none'
  video.srcObject = active
  document.body.appendChild(video)
  tickVideo = video
  if (typeof video.requestVideoFrameCallback !== 'function') return
  const pump: VideoFrameRequestCallback = (_now, metadata) => {
    // A chain from a previous start stops here rather than running forever.
    if (generation !== tickGeneration) return
    // THE FRAME'S POSITION IN THE FILE BEING SAVED (#109).
    //
    // Which number to send took reading the spec rather than guessing, and the
    // first guess was wrong twice over:
    //
    //   `mediaTime`   is the track's OWN timeline and the spec says it "may be
    //                 zero for live streams". It starts when the STREAM did,
    //                 not when this recorder slot did — and the saved replay is
    //                 one slot's output, whose t=0 is that slot's start. They
    //                 agree only until the first rotation, which is why this
    //                 looked almost right.
    //   `captureTime` is defined for WebRTC and getUserMedia sources. A screen
    //                 capture is neither, so it is simply absent.
    //
    //   `presentationTime` IS specified for every source — "the time at which
    //                 the user agent submitted the frame for composition", on
    //                 the same timebase as `performance.now()`. So is
    //                 `slot.startedAt`. The difference between them is the
    //                 frame's exact position in the file this slot is writing.
    //
    // The slot that will BE the replay is the older recording one, which is
    // what `olderRecordingSlot` already answers for the export path.
    const base = olderRecordingSlot()
    const submitted = metadata.presentationTime
    if (base === null || typeof submitted !== 'number' || !Number.isFinite(submitted)) {
      video.requestVideoFrameCallback(pump)
      return
    }
    // ONE MONOTONIC NUMBER FOR THE WHOLE SESSION (#112).
    //
    // This used to send the frame's position within the CURRENT recorder slot.
    // The recorder rotates slots every `segmentSeconds`, and at each rotation
    // that number falls back to zero — so the ring received time going
    // BACKWARDS by up to thirty seconds. The log said it plainly once a
    // recording lived long enough to rotate: "736 samples over -9s".
    //
    // `presentationTime` is `performance.now()`-based and never goes backwards,
    // so it is sent as-is. Turning it into a position in the saved file needs
    // to know WHICH slot was saved and where that slot began, and the only
    // moment both are known is when the replay is handed over — so that is
    // where the subtraction happens, not here.
    window.captureBridge.sendTick?.({
      displayId: startPayload?.displayId ?? '',
      mediaTimeMs: submitted,
    })
    video.requestVideoFrameCallback(pump)
  }
  video.requestVideoFrameCallback(pump)
  // A <video> that is never played presents no frames; it is never shown, and
  // it decodes the stream the recorder is already consuming.
  void video.play().catch(() => {
    /* No ticks from this display: the free-running loop still samples. */
  })
}

/** Retires the current chain and releases its sink (#91). */
function stopFrameTicks(): void {
  tickGeneration += 1
  const video = tickVideo
  tickVideo = null
  if (video === null) return
  try {
    video.pause()
  } catch {
    // Already detached; nothing to stop.
  }
  video.srcObject = null
  video.remove()
}

function armEvidenceCheck(delayMs: number): void {
  window.clearTimeout(evidenceTimer)
  evidenceTimer = window.setTimeout(checkFrameEvidence, delayMs)
}

/** Counts recorder output toward the next evidence check. */
function noteRecorderBytes(size: number): void {
  evidenceBytes += size
}

/**
 * The deadline arrived: decide whether video is actually flowing.
 *
 * Proven -> tell main once (that is what turns the tray green) and keep
 * watching. Not proven -> the recorder is lying about its own state: report it
 * with the distinct `no-frames` symptom and let failCapture restart this
 * display's capture ONE time.
 *
 * A verdict needs EVIDENCE that nothing arrived, not merely the absence of
 * proof: with no frame counter (see deliveredFrames) there is none, because 0
 * recorder bytes is what a healthy MP4 recorder reports between flushes. That
 * case therefore keeps watching for as long as the capture lives and never
 * fails; main's probe stops the recorder, sees the flush, and decides.
 */
function checkFrameEvidence(): void {
  evidenceTimer = undefined
  const bytes = evidenceBytes
  const frames = deliveredFrames()
  evidenceBytes = 0
  if (bytes >= EVIDENCE_MIN_BYTES || (frames !== null && frames > evidenceFrames)) {
    if (frames !== null) evidenceFrames = frames
    evidenceStrikes = 0
    framesProven = true
    // ONE recovery per FAILURE EPISODE, not per process: frames are flowing
    // again, so a stall an hour from now is entitled to the same single
    // restart this one just had (failCapture).
    retried = false
    // EVERY proof is sent, not just the first (issue #43). Main's displayed
    // state used to depend on a fixed number of early probes, so anything that
    // latched it on "stopped" — a probe that timed out, a duplication failure
    // that has since cleared — stayed wrong until the app was restarted (and
    // then repeated itself). A repeated proof is a HEARTBEAT: whatever main
    // believes, a recorder that is genuinely running says so again within
    // EVIDENCE_STALL_MS, and main can flip back without stopping it to check.
    // The cost is one small IPC message per display every twelve seconds.
    //
    // Test path (--simulate-slow-replay): withheld, so main never learns from
    // the cheap channel what this recorder can prove. Everything else about the
    // recorder — the slots, the rotations, the ring buffer — stays real, which
    // is exactly the state #43 describes and exactly what recovery must not
    // destroy.
    if (startPayload?.simulateSlowReplayMs === undefined) {
      const measured = cadenceReport()
      window.captureBridge.sendFrames({
        displayId: startPayload?.displayId ?? '',
        bytes,
        frames: frames ?? 0,
        // Omitted, never zeroed, while nothing can honestly be said (#82): a
        // rate nobody measured must not be reported as a rate.
        ...(measured === null ? {} : { cadence: measured }),
      })
    }
    armEvidenceCheck(EVIDENCE_STALL_MS)
    return
  }
  // NO COUNTER, NO VERDICT. Failing here would announce "not recording" on
  // every launch of a healthy MP4 recorder, restart it for nothing, and — once
  // the one retry is spent — leave the display screenshot-only for the rest of
  // the process. Keep watching instead: the next flush (a slot rotation, a
  // capture, main's probe) still lands in noteRecorderBytes and proves it.
  if (frames === null) {
    if (!unknownFramesLogged) {
      unknownFramesLogged = true
      console.warn(
        `[capture] display ${startPayload?.displayId ?? '?'}: no delivered-frame counter on this ` +
          'runtime; recorder health is left to the main-process probe',
      )
    }
    armEvidenceCheck(framesProven ? EVIDENCE_STALL_MS : EVIDENCE_DEADLINE_MS)
    return
  }
  evidenceStrikes += 1
  if (evidenceStrikes < EVIDENCE_STRIKES) {
    armEvidenceCheck(framesProven ? EVIDENCE_STALL_MS : EVIDENCE_DEADLINE_MS)
    return
  }
  // Logged as well as reported: this is the line a user's report has to carry.
  console.error(
    `[capture] display ${startPayload?.displayId ?? '?'}: no video frames — ` +
      `${bytes} recorder bytes and ${frames} delivered frames over ` +
      `${evidenceStrikes} check(s) while MediaRecorder reported ` +
      `"${slots.map((s) => s.recorder?.state ?? 'none').join('/')}". ` +
      'On Windows this is typically a failing Desktop Duplication ' +
      '(DxgiDuplicatorController): another app holds the duplication, or the ' +
      'graphics driver needs a reset.',
  )
  failCapture(
    `no video frames from the desktop capturer (${bytes} recorder bytes, ` +
      `${frames} delivered frames)`,
  )
}

/**
 * Report the failure and RECOVER ONCE per failure episode.
 *
 * `retried` is cleared again the moment frames are proven (checkFrameEvidence),
 * so "once" means once per episode rather than once per process. It has to:
 * since the stall watchdog exists, failCapture is reachable from a TRANSIENT
 * condition — a locked workstation, a sleeping monitor, a screen-share tool
 * holding the duplication for half a minute. A process-lifetime latch turned
 * every one of those into a permanently screenshot-only display, because
 * nothing else recreates a torn-down capture.
 */
function failCapture(message: string): void {
  window.captureBridge.sendError(message)
  teardown()
  if (retried || startPayload === null) return
  retried = true
  const payload = startPayload
  window.setTimeout(() => void startCapture(payload), RETRY_DELAY_MS)
}

function teardown(): void {
  window.clearTimeout(evidenceTimer)
  evidenceTimer = undefined
  for (const slot of slots) {
    window.clearTimeout(slot.rotateTimer)
    window.clearTimeout(slot.startTimer)
    slot.rotateTimer = undefined
    slot.startTimer = undefined
    const recorder = slot.recorder
    slot.recorder = null
    slot.chunks = []
    if (recorder && recorder.state !== 'inactive') recorder.stop()
  }
  if (stream) {
    for (const track of stream.getTracks()) track.stop()
    stream = null
  }
}

async function startCapture(payload: CaptureStartPayload): Promise<void> {
  startPayload = payload
  segmentMs = payload.segmentSeconds * 1000
  recorderFormat = pickRecorderFormat()
  if (recorderFormat === null) {
    failCapture('MediaRecorder has no supported CapturePack replay format')
    return
  }
  try {
    // The main process routes this to the display assigned to this window
    // (payload.displayId); no picker appears.
    stream = await navigator.mediaDevices.getDisplayMedia({
      audio: false,
      video: {
        frameRate: payload.fps,
        ...(payload.replayMaxWidth === 0
          ? {}
          : {
              // Main computed these together from the assigned display's native
              // size. Independent long-edge maxima can make Chromium negotiate
              // a square track; an aspect-preserving pair cannot.
              width: { ideal: payload.replayWidth, max: payload.replayWidth },
              height: { ideal: payload.replayHeight, max: payload.replayHeight },
            }),
      },
    })
  } catch (err) {
    failCapture(`getDisplayMedia failed: ${describe(err)}`)
    return
  }
  const track = stream.getVideoTracks()[0]
  track?.addEventListener('ended', () => failCapture('capture stream ended'))
  const settings = track?.getSettings()
  window.captureBridge.sendReady({
    displayId: payload.displayId,
    mimeType: recorderFormat.mimeType,
    replayFile: recorderFormat.replayFile,
    width: Math.max(0, Math.round(settings?.width ?? 0)),
    height: Math.max(0, Math.round(settings?.height ?? 0)),
  })
  // Nothing is proven yet — main keeps this display "starting" until the
  // evidence check below says otherwise.
  framesProven = false
  evidenceBytes = 0
  evidenceStrikes = 0
  unknownFramesLogged = false
  evidenceFrames = deliveredFrames() ?? 0
  startCadenceMonitor()
  startFrameTicks()
  startSlot(slots[0])
  armEvidenceCheck(EVIDENCE_DEADLINE_MS)
  slots[1].startTimer = window.setTimeout(() => startSlot(slots[1]), segmentMs)
}

function startSlot(slot: Slot): void {
  const format = recorderFormat
  if (!stream || !stream.active || format === null) return
  // chunks is captured per recorder session; replacing slot.chunks on the next
  // start orphans the old session's data so memory stays bounded.
  const chunks: Blob[] = []
  let recorder: MediaRecorder
  try {
    recorder = new MediaRecorder(stream, {
      mimeType: format.mimeType,
      videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
    })
  } catch (err) {
    failCapture(`MediaRecorder unavailable: ${describe(err)}`)
    return
  }
  recorder.ondataavailable = (event) => {
    // Test path (--simulate-no-frames): behave exactly like a recorder whose
    // desktop capturer delivers nothing — the encoder output is dropped on the
    // floor, so the buffer stays empty and no evidence ever accumulates.
    if (startPayload?.simulateNoFrames === true) return
    if (event.data.size > 0) chunks.push(event.data)
    noteRecorderBytes(event.data.size)
  }
  recorder.onerror = () => failCapture(`MediaRecorder error (slot ${slot.index})`)
  slot.recorder = recorder
  slot.chunks = chunks
  slot.startedAt = performance.now()
  recorder.start(CHUNK_TIMESLICE_MS)
  slot.rotateTimer = window.setTimeout(() => rotateSlot(slot), 2 * segmentMs)
}

function rotateSlot(slot: Slot): void {
  const recorder = slot.recorder
  if (recorder && recorder.state !== 'inactive') recorder.stop()
  startSlot(slot)
}

function olderRecordingSlot(): Slot | null {
  const recording = slots.filter((s) => s.recorder !== null && s.recorder.state === 'recording')
  recording.sort((a, b) => a.startedAt - b.startedAt)
  return recording[0] ?? null
}

// Restarting only the extracted slot would leave the two rotation schedules an
// arbitrary offset apart, converging toward lockstep with repeated captures and
// shrinking later replays toward zero. Forcing the surviving slot onto a
// rotation (or first start) segmentMs from now restores the 1x segmentSeconds
// stagger, so the 1x..2x footage guarantee holds for every later capture.
function restaggerSurvivor(other: Slot): void {
  window.clearTimeout(other.rotateTimer)
  window.clearTimeout(other.startTimer)
  other.rotateTimer = undefined
  other.startTimer = undefined
  if (other.recorder !== null && other.recorder.state === 'recording') {
    other.rotateTimer = window.setTimeout(() => rotateSlot(other), segmentMs)
  } else {
    other.startTimer = window.setTimeout(() => startSlot(other), segmentMs)
  }
}

async function handleReplayRequest(requestId: string): Promise<void> {
  const slot = olderRecordingSlot()
  const recorder = slot?.recorder
  const format = recorderFormat
  if (!slot || !recorder || !stream?.active || format === null) {
    window.captureBridge.sendReplayResult({
      requestId,
      buffer: new ArrayBuffer(0),
      durationMs: 0,
      mimeType: 'video/webm',
      replayFile: 'replay.webm',
    })
    return
  }
  const chunks = slot.chunks
  const startedAt = slot.startedAt
  window.clearTimeout(slot.rotateTimer)
  // stop() flushes the final dataavailable before firing onstop, so chunks is
  // complete once this resolves.
  await new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
    recorder.stop()
  })
  const durationMs = Math.round(performance.now() - startedAt)
  // Where this file's t=0 sits on the tick clock (#112). Ticks are monotonic
  // `presentationTime`; these bytes begin when this slot did.
  const originMs = startedAt
  startSlot(slot) // restart before assembling so buffering never pauses
  restaggerSurvivor(slots[slot.index === 0 ? 1 : 0])
  const buffer = await new Blob(chunks, { type: format.mimeType }).arrayBuffer()
  // Test path (--simulate-slow-replay): the slot really was stopped and really
  // was restarted — the cost of the request has been paid in full — and only
  // the ANSWER is late, the way it is on a machine muxing thirty seconds of MP4
  // under load. Held after the assembly so the simulation cannot accidentally
  // make the buffer look healthier than it is.
  const slowReplayMs = startPayload?.simulateSlowReplayMs
  if (slowReplayMs !== undefined) {
    console.warn(
      `[capture] display ${startPayload?.displayId ?? '?'}: --simulate-slow-replay — holding a ` +
        `${buffer.byteLength}-byte / ${durationMs} ms replay for ${slowReplayMs} ms`,
    )
    await new Promise<void>((resolve) => window.setTimeout(resolve, slowReplayMs))
  }
  // A container header with no frames in it is NOT a replay: handing those few
  // hundred bytes back would put an undecodable replay.mp4 in the pack and let
  // every reader believe a recording exists. Below the evidence bar the honest
  // answer is the same one a dead recorder gives — no footage.
  window.captureBridge.sendReplayResult(
    buffer.byteLength >= EVIDENCE_MIN_BYTES
      ? {
          requestId,
          buffer,
          durationMs,
          originMs,
          mimeType: format.mimeType,
          replayFile: format.replayFile,
        }
      : {
          requestId,
          buffer: new ArrayBuffer(0),
          durationMs: 0,
          mimeType: format.mimeType,
          replayFile: format.replayFile,
        },
  )
}

function pickRecorderFormat(): RecorderFormat | null {
  for (const candidate of RECORDER_FORMATS) {
    if (!MediaRecorder.isTypeSupported(candidate.mimeType)) continue
    if (candidate.mimeType.startsWith('video/x-matroska')) {
      // We did probe it in order. Do not lie about the container: AVC inside
      // Matroska is not a WebM-compatible stream, and replay.mkv is not a legal
      // CapturePack media name. Continue to the legal VP8/VP9 fallbacks.
      console.warn('[capture] Matroska/AVC is supported but cannot be stored as a CapturePack replay')
      continue
    }
    return candidate
  }
  return null
}

window.captureBridge.onStart((payload) => {
  void startCapture(payload)
})
window.captureBridge.onRequestReplay((requestId) => {
  void handleReplayRequest(requestId)
})
