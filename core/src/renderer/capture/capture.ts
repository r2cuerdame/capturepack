// Replay ring buffer: two MediaRecorder sessions over one getDisplayMedia
// stream, started segmentSeconds apart and each rotated every 2x segmentSeconds.
// The older session therefore always holds between 1x and 2x segmentSeconds of
// footage as a single decodable recorder blob.
import type {
  CaptureFramesPayload,
  CaptureReadyPayload,
  CaptureReplayResultPayload,
  CaptureStartPayload,
} from '../../shared/ipc'

interface CaptureBridge {
  onStart(cb: (payload: CaptureStartPayload) => void): void
  onRequestReplay(cb: (requestId: string) => void): void
  sendReplayResult(payload: CaptureReplayResultPayload): void
  sendReady(payload: CaptureReadyPayload): void
  sendFrames(payload: CaptureFramesPayload): void
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
  const track = stream?.getVideoTracks()[0]
  const stats = (track as (MediaStreamTrack & { stats?: { deliveredFrames?: number } }) | undefined)
    ?.stats
  const delivered = stats?.deliveredFrames
  return typeof delivered === 'number' && Number.isFinite(delivered) ? delivered : null
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
      window.captureBridge.sendFrames({
        displayId: startPayload?.displayId ?? '',
        bytes,
        frames: frames ?? 0,
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
