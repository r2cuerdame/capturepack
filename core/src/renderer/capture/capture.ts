// Replay ring buffer: two MediaRecorder sessions over one getDisplayMedia
// stream, started segmentSeconds apart and each rotated every 2x segmentSeconds.
// The older session therefore always holds between 1x and 2x segmentSeconds of
// footage as a single decodable webm blob.
import type { CaptureReplayResultPayload, CaptureStartPayload } from '../../shared/ipc'

interface CaptureBridge {
  onStart(cb: (payload: CaptureStartPayload) => void): void
  onRequestReplay(cb: (requestId: string) => void): void
  sendReplayResult(payload: CaptureReplayResultPayload): void
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
let mimeType = 'video/webm;codecs=vp9'
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
  try {
    // The main process routes this to the display assigned to this window
    // (payload.displayId); no picker appears.
    stream = await navigator.mediaDevices.getDisplayMedia({
      audio: false,
      video: { frameRate: payload.fps },
    })
  } catch (err) {
    failCapture(`getDisplayMedia failed: ${describe(err)}`)
    return
  }
  if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm;codecs=vp8'
  stream.getVideoTracks()[0]?.addEventListener('ended', () => failCapture('capture stream ended'))
  startSlot(slots[0])
  slots[1].startTimer = window.setTimeout(() => startSlot(slots[1]), segmentMs)
}

function startSlot(slot: Slot): void {
  if (!stream || !stream.active) return
  // chunks is captured per recorder session; replacing slot.chunks on the next
  // start orphans the old session's data so memory stays bounded.
  const chunks: Blob[] = []
  let recorder: MediaRecorder
  try {
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: VIDEO_BITS_PER_SECOND })
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
  if (!slot || !recorder || !stream?.active) {
    window.captureBridge.sendReplayResult({ requestId, buffer: new ArrayBuffer(0), durationMs: 0 })
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
  const buffer = await new Blob(chunks, { type: mimeType }).arrayBuffer()
  window.captureBridge.sendReplayResult(
    buffer.byteLength > 0
      ? { requestId, buffer, durationMs }
      : { requestId, buffer: new ArrayBuffer(0), durationMs: 0 },
  )
}

window.captureBridge.onStart((payload) => {
  void startCapture(payload)
})
window.captureBridge.onRequestReplay((requestId) => {
  void handleReplayRequest(requestId)
})
