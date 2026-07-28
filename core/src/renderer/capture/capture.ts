// Replay ring buffer: two MediaRecorder sessions over one getDisplayMedia
// stream, started segmentSeconds apart and each rotated every 2x segmentSeconds.
// The older session therefore always holds between 1x and 2x segmentSeconds of
// footage as a single decodable recorder blob.
import type {
  CaptureReadyPayload,
  CaptureReplayResultPayload,
  CaptureStartPayload,
} from '../../shared/ipc'

interface CaptureBridge {
  onStart(cb: (payload: CaptureStartPayload) => void): void
  onRequestReplay(cb: (requestId: string) => void): void
  sendReplayResult(payload: CaptureReplayResultPayload): void
  sendReady(payload: CaptureReadyPayload): void
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

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

function failCapture(message: string): void {
  window.captureBridge.sendError(message)
  teardown()
  if (retried || startPayload === null) return
  retried = true
  const payload = startPayload
  window.setTimeout(() => void startCapture(payload), RETRY_DELAY_MS)
}

function teardown(): void {
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
  startSlot(slots[0])
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
    if (event.data.size > 0) chunks.push(event.data)
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
  window.captureBridge.sendReplayResult(
    buffer.byteLength > 0
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
