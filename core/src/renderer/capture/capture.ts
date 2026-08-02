// Replay ring buffer over one getDisplayMedia stream. Chromium's fragmented
// MP4 path uses one encoder and a bounded moof/mdat ring. A runtime without
// legal MP4/AVC falls back to two staggered, complete VP8/VP9 WebM sessions:
// WebM clusters cannot be safely spliced/rebased like fragmented MP4.
import type {
  CaptureDxgiTimingReferencePayload,
  CaptureFramesPayload,
  CaptureNativeFallbackErrorPayload,
  CaptureNativeFallbackFramePayload,
  CaptureNativeFallbackRequest,
  CaptureNativeFallbackStartPayload,
  CaptureReadyPayload,
  CaptureReplayRequestPayload,
  CaptureReplayResumePayload,
  CaptureReplayResultPayload,
  CaptureStartPayload,
  CaptureTickPayload,
} from '../../shared/ipc'
import { MIN_CAPTURE_FPS } from '../../shared/types'
import {
  beginCaptureCadence,
  captureCadenceReport,
  observeCaptureCadence,
  type CaptureCadenceState,
} from '../../shared/captureCadence'
import {
  RECORDER_STOP_TIMEOUT_MS,
  REPLAY_HOLD_WATCHDOG_MS,
} from '../../shared/captureTimeouts'
import { wallComparableTimeMs } from '../../shared/highResolutionTime'
import {
  BoundedBlobIngestQueue,
  commitRecorderBatchBeforeReplacement,
  type BoundedBlobBatch,
} from './boundedBlobIngestQueue'
import {
  enumerateFmp4VideoSamples,
  type Fmp4VideoSample,
} from './fmp4SampleTimeline'
import { FragmentedMp4Ring } from './fragmentedMp4Ring'
import { NativeFallbackStartupErrors } from './nativeFallbackStartup'
import {
  NativeFrameClock,
  NativePresentationQueue,
} from './nativePresentation'
import {
  mp4FragmentIntervalMs,
  pickRecorderFormat,
  type RecorderFormat,
} from './recorderFormats'
import {
  recorderChunkEndAtMs,
  recorderMaintenanceDecision,
  releaseRecorderReferences,
  stopRecorderWithDeadline,
} from './recorderRetention'
import {
  buildSourceLatencyFingerprint,
  buildSourceLatencyFingerprintFromRgb,
  decideProcessorPresentationLatency,
  decideSourceLatencyCalibration,
  decideSourcePresentationLatency,
  mapDxgiTimingReferenceEpoch,
  SOURCE_LATENCY_FINGERPRINT_HEIGHT,
  SOURCE_LATENCY_FINGERPRINT_WIDTH,
  SOURCE_LATENCY_RETAINED_SAMPLE_LIMIT,
  sourceLatencyFingerprintDelta,
  type SourceLatencyCalibrationSample,
  type SourceLatencyFingerprint,
  type SourceLatencySampleSource,
  type SourceLatencyReferenceTiming,
} from './sourceLatencyCalibration'
import {
  decideReplayPixelClock,
  REPLAY_PIXEL_CLOCK_SAMPLE_LIMIT,
  retainReplayPixelClockPresentedSample,
  sourceClockAnchorsFromObservedCaptureTime,
  sourceClockAnchorsFromMeasuredMediaTime,
  type ReplayPixelClockAnchor,
  type ReplayPixelClockDecision,
  type ReplayPixelClockDecodedSample,
  type ReplayPixelClockPresentedSample,
} from './replayPixelClock'
import {
  decideProcessorQpcDeliveryLatency,
  mapProcessorFrameEpochMs,
  type ProcessorQpcDeliveryDecision,
} from './processorQpcDelivery'
import {
  createReplayHealthState,
  fingerprintRgba,
  markReplayHealthProbe,
  nativeProbeConfirmsFailure,
  observePrimaryFingerprint,
  PRIMARY_READY_TIMEOUT_MS,
  PRIMARY_STARTUP_OBSERVATION_MS,
  PrimaryReadiness,
  REPLAY_HEALTH_SAMPLE_MS,
  retainMeaningfulFingerprint,
  type FrameFingerprint,
  type ReplayHealthState,
} from './replayHealth'
import { ReplayResumeTokenLedger } from './replayResumeTokenLedger'
import { WebmDualSlotRing } from './webmDualSlotRing'

interface CaptureBridge {
  onStart(cb: (payload: CaptureStartPayload) => void): void
  onRequestReplay(cb: (payload: CaptureReplayRequestPayload) => void): void
  onResumeReplay(cb: (payload: CaptureReplayResumePayload) => void): void
  sendReplayResult(payload: CaptureReplayResultPayload): void
  sendReady(payload: CaptureReadyPayload): void
  sendFrames(payload: CaptureFramesPayload): void
  sendTick(payload: CaptureTickPayload): void
  sendError(message: string): void
  captureDxgiTimingReference(): Promise<CaptureDxgiTimingReferencePayload>
  startNativeFallback(
    request: CaptureNativeFallbackRequest,
  ): Promise<CaptureNativeFallbackStartPayload>
  onNativeFallbackFrame(
    cb: (payload: CaptureNativeFallbackFramePayload) => void,
  ): void
  onNativeFallbackError(
    cb: (payload: CaptureNativeFallbackErrorPayload) => void,
  ): void
  stopNativeFallback(sessionId: string): void
  ackNativeFallbackFrame(sessionId: string, sequence: number): void
  presentedNativeFallbackFrame(sessionId: string, sequence: number): void
}

declare global {
  interface Window {
    captureBridge: CaptureBridge
  }
}

const RETRY_DELAY_MS = 3000
const WEBM_CHUNK_TIMESLICE_MS = 1000
const VIDEO_BITS_PER_SECOND = 6_000_000
const REPLAY_PIXEL_CLOCK_DECODE_SAMPLE_LIMIT = 64
const REPLAY_PIXEL_CLOCK_BASE_SAMPLE_LIMIT = 8
const REPLAY_PIXEL_CLOCK_DECODE_DEADLINE_MS = 1_500
const REPLAY_PIXEL_CLOCK_SEEK_DEADLINE_MS = 200
let replayPixelClockDecodeDiagnostics: Record<string, unknown> | undefined
let recorderSourceFps = 15

function currentMp4FragmentIntervalMs(): number {
  return mp4FragmentIntervalMs(recorderSourceFps)
}

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
// timer per capture that fires a handful of times a minute and
// polls nothing.

// A single H.264/VP8 keyframe of any real screen is tens of KB; an MP4 or WebM
// header with no frames in it is well under 2 KB.
//
// Bytes are POSITIVE PROOF ONLY, never the absence of it: the MP4 muxer
// Chromium picks first emits complete fragments only at keyframe boundaries, so
// a perfectly healthy recorder may report 0 bytes for many nominal timeslices.
// stop() flushes the current fragment (a replay request or main's probe).
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

interface ActiveRecorder {
  recorder: MediaRecorder
  generation: number
  ingestQueue: BoundedBlobIngestQueue<RecorderIngestPayload>
  startedAtMs: number
  clockSamples: NonNullable<
    NonNullable<CaptureReplayResultPayload['ringDiagnostics']>['clockSamples']
  >
  hadOutput: boolean
  lastFragmentAtMs: number | null
  flushAtMs: number | null
  flushBatch: BoundedBlobBatch<RecorderIngestPayload> | null
  flushBatchOverflowed: boolean
  flushTimer: number | undefined
}

interface RecorderIngestPayload {
  readonly endAtMs: number
  readonly generation: number
  readonly ring: FragmentedMp4Ring
  readonly session: ActiveRecorder
}

interface ReplayHold {
  readonly requestId: string
  readonly generation: number
  watchdog: number | undefined
}

let stream: MediaStream | null = null
let recorderFormat: RecorderFormat | null = null
let segmentMs = 0
let startPayload: CaptureStartPayload | null = null
let retried = false
let retryTimer: number | undefined
let activeRecorder: ActiveRecorder | null = null
let sourceLatencyCalibration: CaptureReadyPayload['sourceLatencyCalibration']
let sourceLatencyCalibrationGeneration: number | null = null
let sourceLatencyCalibrationCancel: (() => void) | null = null
let replayPixelClockPresentedSamples: ReplayPixelClockPresentedSample[] = []
let replayPixelClockCanvas: HTMLCanvasElement | null = null
let replayPixelClockContext: CanvasRenderingContext2D | null = null
let latestPresentedFrame:
  | {
      presentationTimeMs: number
      captureTimeMs?: number
      mediaTimeMs: number
    }
  | null = null
let replayRing: FragmentedMp4Ring | null = null
let webmRing: WebmDualSlotRing | null = null
let captureGeneration = 0
let ingestQueue: BoundedBlobIngestQueue<RecorderIngestPayload> | null = null
let recorderQueue: Promise<void> = Promise.resolve()
let replayHold: ReplayHold | null = null
const replayResumeTokens = new ReplayResumeTokenLedger({
  maxEntries: 4,
  ttlMs: REPLAY_HOLD_WATCHDOG_MS,
  now: () => performance.now(),
})
let captureBackend: 'chromium-desktop-capture' | 'windows-gdi-bitblt' =
  'chromium-desktop-capture'
let captureQuality: 'full' | 'degraded' = 'full'
let captureRecorderCount = 1
let nativeFallbackSessionId: string | null = null
let nativeFallbackCanvas: HTMLCanvasElement | null = null
let nativeFallbackContext: CanvasRenderingContext2D | null = null
let nativeFallbackTrack: CanvasCaptureMediaStreamTrack | null = null
let nativeFallbackPresentedFrames = 0
let nativeFallbackRequestedFrames = 0
let nativeFallbackLastPresentedFrames: number | null = null
let nativeFallbackPresentationReported = false
let nativeFallbackInvalidClockLogged = false
let nativeFallbackDecodeActive = false
let nativeFallbackPendingFrame: CaptureNativeFallbackFramePayload | null = null
const nativeFallbackStartupErrors = new NativeFallbackStartupErrors()
interface NativePresentationMetadata {
  readonly sessionId: string
  readonly sequence: number
  readonly capturedComparableMs: number | null
}
const nativeFallbackPresentationQueue =
  new NativePresentationQueue<NativePresentationMetadata>(32)
const nativeFallbackFrameClock = new NativeFrameClock()

function nativeCapturedComparableTime(
  frame: CaptureNativeFallbackFramePayload,
): number | null {
  // Date.now() follows Windows wall-clock steps; DOMHighRes time does not.
  // Read their current offset at the QPC anchor, then advance only by helper
  // QPC deltas for the rest of the session.
  const highResolutionNowMs = wallComparableTimeMs(
    performance.timeOrigin,
    performance.now(),
  )
  return nativeFallbackFrameClock.map(
    frame,
    highResolutionNowMs - Date.now(),
  )
}
// Session-lifetime circuit breaker. Once Chromium failed and this window moved
// to GDI, no error path is allowed to flap it back to the same failed source.
let nativeFallbackCircuitOpen = false
let primaryReadinessCancel: (() => void) | null = null
// Renderer lifetime, not capture generation: the expensive first Chromium/GPU
// startup window is discarded once. Recovery/settings restarts still prove two
// frames, but never pay another blind two-second exclusion.
let primaryStartupObservationAttempted = false
let replayHealthTimer: number | undefined
let replayHealthState: ReplayHealthState | null = null
let replayHealthProbeActive = false
let replayHealthProbeToken = 0

// Frame evidence for the CURRENT capture (reset by every startCapture).
let evidenceTimer: number | undefined
// Recorder bytes seen since the last evidence check.
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

function simulatePrimaryNoFrames(): boolean {
  return (
    captureBackend === 'chromium-desktop-capture' &&
    startPayload?.simulateNoFrames === true
  )
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
  // A decoded JPEG is not evidence. The native counter advances only after its
  // pixels were drawn onto the canvas owned by the automatic capture track.
  // Presentation is measured separately because a hidden rVFC sink is itself
  // compositor-throttled and must never pace the recorder.
  if (captureBackend === 'windows-gdi-bitblt') {
    return nativeFallbackRequestedFrames
  }
  if (simulatePrimaryNoFrames()) return 0
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

let cadence: CaptureCadenceState | null = null
let cadenceTimer: number | undefined

function startCadenceMonitor(): void {
  window.clearInterval(cadenceTimer)
  const frames = deliveredFrames()
  if (frames === null) {
    cadence = null
    return
  }
  const now = performance.now()
  cadence = beginCaptureCadence(
    now,
    frames,
    videoStats()?.discardedFrames ?? null,
  )
  cadenceTimer = window.setInterval(pollCadence, CADENCE_POLL_MS)
}

function pollCadence(): void {
  const c = cadence
  if (c === null) return
  const frames = deliveredFrames()
  if (frames === null) return
  observeCaptureCadence(
    c,
    performance.now(),
    frames,
    videoStats()?.discardedFrames ?? null,
    CADENCE_WARMUP_MS,
  )
}

/** What this recorder has achieved, or null while nothing can honestly be said. */
function cadenceReport(): { achievedFps: number; worstStallMs: number; discardedFrames: number | null; sampledMs: number; gainedFrames: number } | null {
  const c = cadence
  const frames = deliveredFrames()
  if (c === null || frames === null) return null
  return captureCadenceReport(
    c,
    performance.now(),
    frames,
    videoStats()?.discardedFrames ?? null,
    CADENCE_WARMUP_MS,
  )
}

/**
 * cadenceReport() plus the provenance of the source that produced it — the ONE
 * shape both the health heartbeat and the replay result send (#135).
 *
 * The provenance rides inside the measurement rather than beside it because
 * that is what the manifest declares: SPEC §5.3 makes `achieved_fps` and
 * `worst_stall_ms` required members of `media.cadence`, so a `backend` with no
 * measured rate to sit next to has nowhere legal to go. Both senders build it
 * here so the two can never describe the same recorder differently.
 */
function cadenceSummary(): CaptureFramesPayload['cadence'] | null {
  const measured = cadenceReport()
  if (measured === null) return null
  return {
    ...measured,
    backend: captureBackend,
    quality: captureQuality,
    ...(startPayload?.fps === undefined ? {} : { requestedFps: startPayload.fps }),
    recorderCount: captureRecorderCount,
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

function releaseVideoSink(video: HTMLVideoElement): void {
  try {
    video.pause()
  } catch {
    // Already detached; nothing to stop.
  }
  video.srcObject = null
  video.remove()
}

function startFrameTicks(preparedVideo?: HTMLVideoElement): void {
  stopFrameTicks()
  if (
    startPayload?.focused !== true &&
    captureBackend !== 'windows-gdi-bitblt'
  ) {
    if (preparedVideo !== undefined) releaseVideoSink(preparedVideo)
    return
  }
  const active = stream
  if (active === null) {
    if (preparedVideo !== undefined) releaseVideoSink(preparedVideo)
    return
  }
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
  const video =
    preparedVideo?.srcObject === active
      ? preparedVideo
      : document.createElement('video')
  if (video !== preparedVideo) {
    if (preparedVideo !== undefined) releaseVideoSink(preparedVideo)
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
  }
  tickVideo = video
  if (typeof video.requestVideoFrameCallback !== 'function') return
  const pump: VideoFrameRequestCallback = (now, metadata) => {
    // A chain from a previous start stops here rather than running forever.
    if (generation !== tickGeneration) return
    // THE FRAME'S POSITION IN THE FILE BEING SAVED (#109).
    //
    // Which number to send took reading the spec rather than guessing, and the
    // first guess was wrong twice over:
    //
    //   `mediaTime`   is the track's OWN timeline and the spec says it "may be
    //                 zero for live streams". It starts when the STREAM did,
    //                 not where the bounded replay ring begins.
    //   `captureTime` is defined for WebRTC and getUserMedia sources. A screen
    //                 capture is neither, so it is simply absent.
    //
    //   `presentationTime` IS specified for every source — "the time at which
    //                 the user agent submitted the frame for composition", on
    //                 the same timebase as `performance.now()`.
    //
    const submitted = metadata.presentationTime
    if (typeof submitted !== 'number' || !Number.isFinite(submitted)) {
      video.requestVideoFrameCallback(pump)
      return
    }
    latestPresentedFrame = {
      presentationTimeMs: submitted,
      ...(typeof metadata.captureTime === 'number' && Number.isFinite(metadata.captureTime)
        ? { captureTimeMs: metadata.captureTime }
        : {}),
      mediaTimeMs: metadata.mediaTime * 1000,
    }
    retainReplayPixelClockFrame(
      video,
      submitted,
      metadata.mediaTime * 1_000,
      metadata.captureTime,
    )
    if (captureBackend === 'windows-gdi-bitblt') {
      const totalPresented = metadata.presentedFrames
      if (
        typeof totalPresented !== 'number' ||
        !Number.isInteger(totalPresented) ||
        totalPresented <= 0
      ) {
        video.requestVideoFrameCallback(pump)
        return
      }
      const presentedDelta =
        nativeFallbackLastPresentedFrames === null
          ? totalPresented
          : totalPresented - nativeFallbackLastPresentedFrames
      nativeFallbackLastPresentedFrames = totalPresented
      const nativeFrame = nativeFallbackPresentationQueue.take(
        submitted,
        presentedDelta,
      )
      if (nativeFrame === null) {
        video.requestVideoFrameCallback(pump)
        return
      }
      nativeFallbackPresentedFrames += 1
      if (!nativeFallbackPresentationReported) {
        nativeFallbackPresentationReported = true
        window.captureBridge.presentedNativeFallbackFrame(
          nativeFrame.sessionId,
          nativeFrame.sequence,
        )
      }
      const presentedWallMs = wallComparableTimeMs(
        performance.timeOrigin,
        submitted,
      )
      const measuredSourceAgeMs =
        nativeFrame.capturedComparableMs === null
          ? undefined
          : presentedWallMs - nativeFrame.capturedComparableMs
      const sourceAgeMs =
        measuredSourceAgeMs !== undefined &&
        Number.isFinite(measuredSourceAgeMs) &&
        measuredSourceAgeMs >= 0 &&
        measuredSourceAgeMs <= NATIVE_FRAME_AGE_MAX_MS
          ? measuredSourceAgeMs
          : undefined
      if (
        measuredSourceAgeMs !== undefined &&
        sourceAgeMs === undefined &&
        !nativeFallbackInvalidClockLogged
      ) {
        nativeFallbackInvalidClockLogged = true
        nativeFallbackFrameClock.reset()
        console.warn(
          `[capture] display ${startPayload?.displayId ?? '?'}: native QPC/wall anchor produced an impossible frame age; frame age remains unknown and the next frame will re-anchor`,
        )
      }
      const callbackDelayMs = Math.max(0, now - submitted)
      if (startPayload?.focused === true) {
        window.captureBridge.sendTick?.({
          displayId: startPayload.displayId,
          mediaTimeMs: presentedWallMs,
          frameAgeMs: sourceAgeMs,
          tickDelayMs: callbackDelayMs,
        })
      }
      video.requestVideoFrameCallback(pump)
      return
    }
    const base = activeRecorder
    if (base === null) {
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
    // `presentationTime` is `performance.now()`-based and never goes backwards
    // inside THIS renderer. CapturePack owns one renderer per display, though,
    // and each has its own `performance.now()` origin. Put the tick on the
    // epoch-based DOMHighRes axis before it crosses IPC so every display and the
    // renderer that supplies the saved replay are comparable. Turning it into a
    // position in the saved file still waits until that replay is handed over.
    // HOW OLD THE PICTURE ALREADY IS (#108), measured at last.
    //
    // The log has printed "frame already 0 ms old" for every capture of this
    // project's life, and that zero was never a measurement — nothing was ever
    // sent, so the field defaulted. It is the last unmeasured leg between the
    // screen and the rectangle filed against it, and it is the one leg that can
    // plausibly be large: the surface host round trip measures +1 ms, so if the
    // box is displaced while a window is dragged, the time is being lost
    // somewhere in here.
    //
    // `captureTime` is "the time the frame was captured from its source"; the
    // comment above once claimed a screen capture does not provide it, and that
    // was wrong — getDisplayMedia does. The distance from there to
    // `presentationTime` is exactly the age of the pixels at the moment this
    // callback runs, and that is what the sample's time needs shifted by.
    //
    // Sent as a number, never assumed: absent (or nonsensical) means the ring
    // keeps its old behaviour rather than shifting by a guess.
    const captured = metadata.captureTime
    const ageMs =
      typeof captured === 'number' && Number.isFinite(captured) && captured <= submitted
        ? submitted - captured
        : undefined
    // HOW LATE THIS CALLBACK IS (#110) — the leg that was never measured.
    //
    // Everything sent below says "frame `submitted` exists"; nothing said WHEN
    // this code got to run. Under encoder load the compositor delivers these
    // callbacks in BURSTS: frame N's callback fires tens of ms late and frame
    // N+1's fires a few ms after it. Both ticks then read the desk at nearly
    // the same instant — and the host, having a fresh answer for each ask,
    // returns the same rectangle twice. Filed under two frame times 67 ms
    // apart, that is a box frozen for a frame while the window travels — the
    // exact defect measured in every shaken pack, 25–40% of moving samples,
    // after the OS, the host, the lane and the ring were each proven innocent.
    //
    // `now` (this callback's own timestamp) and `presentationTime` share the
    // renderer's clock, so their difference IS the delay, measured per frame.
    // Clamped at zero: a presentation submitted after the callback timestamp
    // would be a clock artifact, not a negative delay.
    const delayMs = Math.max(0, now - submitted)
    if (startPayload?.focused === true) {
      window.captureBridge.sendTick?.({
        displayId: startPayload.displayId,
        mediaTimeMs: wallComparableTimeMs(performance.timeOrigin, submitted),
        tickDelayMs: delayMs,
        ...(ageMs === undefined ? {} : { frameAgeMs: ageMs }),
      })
    }
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
  releaseVideoSink(video)
}

const HEALTH_SAMPLE_WIDTH = 64
const HEALTH_SAMPLE_HEIGHT = 36
const HEALTH_SAMPLE_TIMEOUT_MS = 3_000
const SOURCE_LATENCY_NATIVE_START_TIMEOUT_MS = 2_000
const SOURCE_LATENCY_DXGI_IPC_TIMEOUT_MS = 1_250
const SOURCE_LATENCY_DECODE_TIMEOUT_MS = 1_000
// The lowest supported recorder cadence is 5 fps (200 ms/frame). A processor
// read gets more than two nominal intervals before it is cancelled; the whole
// calibration still has its independent, shorter-lived observation window.
const SOURCE_LATENCY_PROCESSOR_READ_TIMEOUT_MS = 500
const SOURCE_LATENCY_PROCESSOR_CLEANUP_TIMEOUT_MS = 500
const NATIVE_FRAME_AGE_MAX_MS = 10_000

interface MediaStreamTrackProcessorLike {
  readonly readable: ReadableStream<VideoFrame>
}

interface MediaStreamTrackProcessorConstructor {
  new (init: {
    track: MediaStreamTrack
    maxBufferSize?: number
  }): MediaStreamTrackProcessorLike
}

interface ProcessorFingerprintSample {
  readonly observedAtMs: number
  /** WebCodecs presentation timestamp in microseconds; origin is unspecified. */
  readonly frameTimestampUs?: number
  readonly fingerprint: SourceLatencyFingerprint
}

interface PrimaryProcessorSampler {
  readonly samples: ProcessorFingerprintSample[]
  readonly detail: () => string | undefined
  stop(): Promise<void>
}

type PrimaryProcessorSamplerStart =
  | { readonly status: 'active'; readonly sampler: PrimaryProcessorSampler }
  | { readonly status: 'unavailable'; readonly detail: string }

function fingerprintDrawable(source: CanvasImageSource): FrameFingerprint {
  const canvas = document.createElement('canvas')
  canvas.width = HEALTH_SAMPLE_WIDTH
  canvas.height = HEALTH_SAMPLE_HEIGHT
  const context = canvas.getContext('2d', {
    alpha: false,
    willReadFrequently: true,
  })
  if (context === null) throw new Error('replay health canvas is unavailable')
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  return fingerprintRgba(pixels.data, pixels.width, pixels.height)
}

function sourceLatencyFingerprintDrawable(
  source: CanvasImageSource,
): SourceLatencyFingerprint {
  const canvas = document.createElement('canvas')
  canvas.width = SOURCE_LATENCY_FINGERPRINT_WIDTH
  canvas.height = SOURCE_LATENCY_FINGERPRINT_HEIGHT
  const context = canvas.getContext('2d', {
    alpha: false,
    willReadFrequently: true,
  })
  if (context === null) {
    throw new Error('source latency calibration canvas is unavailable')
  }
  // DXGI's same-resource reference uses one physical source pixel beneath each
  // destination-pixel centre. Disable Canvas2D interpolation so the decoded
  // processor frame uses that identical spatial sample instead of a blurred
  // resize whose fingerprint cannot form a trustworthy temporal trough.
  context.imageSmoothingEnabled = false
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  const image = context.getImageData(0, 0, canvas.width, canvas.height)
  return buildSourceLatencyFingerprint(image.data, image.width, image.height)
}

function replayPixelClockFingerprint(
  source: CanvasImageSource,
): SourceLatencyFingerprint {
  let canvas = replayPixelClockCanvas
  let context = replayPixelClockContext
  if (canvas === null || context === null) {
    canvas = document.createElement('canvas')
    canvas.width = SOURCE_LATENCY_FINGERPRINT_WIDTH
    canvas.height = SOURCE_LATENCY_FINGERPRINT_HEIGHT
    context = canvas.getContext('2d', {
      alpha: false,
      willReadFrequently: true,
    })
    if (context === null) {
      throw new Error('replay pixel-clock canvas is unavailable')
    }
    context.imageSmoothingEnabled = false
    replayPixelClockCanvas = canvas
    replayPixelClockContext = context
  }
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  const image = context.getImageData(0, 0, canvas.width, canvas.height)
  return buildSourceLatencyFingerprint(image.data, image.width, image.height)
}

function retainReplayPixelClockFrame(
  video: HTMLVideoElement,
  presentationTimeMs: number,
  mediaTimeMs?: number,
  captureTimeMs?: number,
): ReplayPixelClockPresentedSample | null {
  try {
    const sample = {
      presentedAtMs: wallComparableTimeMs(
        performance.timeOrigin,
        presentationTimeMs,
      ),
      ...(typeof captureTimeMs === 'number' && Number.isFinite(captureTimeMs)
        ? {
            capturedAtMs: wallComparableTimeMs(
              performance.timeOrigin,
              captureTimeMs,
            ),
          }
        : {}),
      fingerprint: replayPixelClockFingerprint(video),
      ...(typeof mediaTimeMs === 'number' && Number.isFinite(mediaTimeMs)
        ? { mediaTimeMs }
        : {}),
    }
    retainReplayPixelClockPresentedSample(
      replayPixelClockPresentedSamples,
      sample,
      segmentMs,
    )
    return sample
  } catch {
    // The pixel clock is optional evidence. A failed read never interrupts the
    // recorder and never turns an approximate clock into a measured one.
    return null
  }
}

interface PrimaryReadyResult {
  fingerprint: FrameFingerprint | null
  observedFrames: number
  observedSpanMs: number
  waitedMs: number
  timedOut: boolean
  /** The exact rVFC sink that supplied the calibrated mediaTime axis. */
  clockVideo: HTMLVideoElement
}

/**
 * Wait for the capture source itself, not an arbitrary sleep.
 *
 * Two increasing presentation timestamps start immediately. A genuinely static
 * source that presents only once may start at the bounded timeout; zero
 * presented frames is a real source failure and opens the native fallback.
 * MediaRecorder does not exist until this promise resolves, so startup pixels
 * can never leak into the replay ring.
 */
function waitForPrimaryReadiness(
  acquiredStream: MediaStream,
  generation: number,
  minimumObservationMs: number,
  onPresentedSample?: (sample: ReplayPixelClockPresentedSample) => void,
): Promise<PrimaryReadyResult> {
  return new Promise<PrimaryReadyResult>((resolve, reject) => {
    const readiness = new PrimaryReadiness()
    const startedAt = performance.now()
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
    video.srcObject = acquiredStream
    document.body.appendChild(video)

    let settled = false
    let lastFingerprint: FrameFingerprint | null = null
    let meaningfulFingerprint: FrameFingerprint | null = null
    let callbackId: number | undefined
    let timeout: number | undefined

    const stopObserving = (): void => {
      window.clearTimeout(timeout)
      if (
        callbackId !== undefined &&
        typeof video.cancelVideoFrameCallback === 'function'
      ) {
        video.cancelVideoFrameCallback(callbackId)
      }
      if (primaryReadinessCancel === cancel) primaryReadinessCancel = null
    }
    const cleanup = (): void => {
      stopObserving()
      try {
        video.pause()
      } catch {
        // Detached before play settled.
      }
      video.srcObject = null
      video.remove()
    }
    const finish = (timedOut: boolean): void => {
      if (settled) return
      settled = true
      // Keep this exact media element alive: replacing it would reset the
      // mediaTime epoch that the DXGI same-pixel calibration just observed.
      stopObserving()
      resolve({
        // Preserve ANY meaningful startup evidence. The exact transient failure
        // seen in the field is meaningful frame 1 followed by black frame 2;
        // seeding the watchdog with only the latest frame loses that history.
        fingerprint: meaningfulFingerprint ?? lastFingerprint,
        observedFrames: readiness.observedFrames(),
        observedSpanMs: readiness.observedSpanMs(),
        waitedMs: Math.max(0, performance.now() - startedAt),
        timedOut,
        clockVideo: video,
      })
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const cancel = (): void => {
      fail(new Error('primary recorder readiness cancelled'))
    }
    primaryReadinessCancel?.()
    primaryReadinessCancel = cancel

    timeout = window.setTimeout(() => {
      if (generation !== captureGeneration) {
        cancel()
        return
      }
      if (readiness.canStartAtDeadline()) {
        // Two monotonic frames are the early path. At the bounded deadline one
        // real presentation is sufficient for a legitimately static desktop;
        // its post-start watchdog is the only place a freeze can be judged,
        // and then only against an independent native sample.
        finish(readiness.observedFrames() < 2)
      } else {
        fail(
          new Error(
            `primary capture produced no presented frame within ${PRIMARY_READY_TIMEOUT_MS} ms`,
          ),
        )
      }
    }, PRIMARY_READY_TIMEOUT_MS)

    if (typeof video.requestVideoFrameCallback === 'function') {
      const pump: VideoFrameRequestCallback = (_now, metadata) => {
        if (settled || generation !== captureGeneration) return
        const presented = metadata.presentationTime
        readiness.observe(presented)
        if (typeof presented === 'number' && Number.isFinite(presented)) {
          // The readiness sink overlaps the independent DXGI/processor probe.
          // Retaining these few startup pixels lets that probe establish the
          // source-exposure -> presentation leg before retained recording
          // begins; samples outside the eventual ring are ignored by replay
          // decoding but remain valid calibration witnesses.
          const sample = retainReplayPixelClockFrame(
            video,
            presented,
            metadata.mediaTime * 1_000,
            metadata.captureTime,
          )
          if (sample !== null) onPresentedSample?.(sample)
        }
        if (
          readiness.canStart(
            performance.now(),
            startedAt,
            minimumObservationMs,
          )
        ) {
          try {
            lastFingerprint = fingerprintDrawable(video)
            meaningfulFingerprint = retainMeaningfulFingerprint(
              meaningfulFingerprint,
              lastFingerprint,
            )
          } catch {
            // Readiness uses the presentation timestamp; pixel health is extra.
          }
          finish(false)
          return
        }
        try {
          lastFingerprint = fingerprintDrawable(video)
          meaningfulFingerprint = retainMeaningfulFingerprint(
            meaningfulFingerprint,
            lastFingerprint,
          )
        } catch {
          // The first callback may beat the composited pixels by one task.
        }
        callbackId = video.requestVideoFrameCallback(pump)
      }
      callbackId = video.requestVideoFrameCallback(pump)
    }
    void video.play().catch((error: unknown) => {
      fail(new Error(`primary capture video could not play: ${describe(error)}`))
    })
  })
}

function trackProcessorConstructor(): MediaStreamTrackProcessorConstructor | null {
  const candidate = (
    globalThis as typeof globalThis & {
      MediaStreamTrackProcessor?: unknown
    }
  ).MediaStreamTrackProcessor
  return typeof candidate === 'function'
    ? (candidate as MediaStreamTrackProcessorConstructor)
    : null
}

/**
 * Read raw frames without putting another presentation/compositor sink in the
 * recorder's timing path.
 *
 * The processor owns a CLONE. Cancelling its reader and stopping that clone
 * therefore cannot stop the MediaRecorder track. Every frame is reduced to a
 * compact 128x72 RGB fingerprint synchronously and closed in the same turn; no
 * VideoFrame survives in the bounded sample list.
 */
function startPrimaryTrackProcessorSampler(
  acquiredStream: MediaStream,
  generation: number,
): PrimaryProcessorSamplerStart {
  const Constructor = trackProcessorConstructor()
  if (Constructor === null) {
    return {
      status: 'unavailable',
      detail: 'MediaStreamTrackProcessor is not exposed in this renderer',
    }
  }
  const sourceTrack = acquiredStream.getVideoTracks()[0]
  if (sourceTrack === undefined) {
    return {
      status: 'unavailable',
      detail: 'primary capture has no video track',
    }
  }

  let sampleTrack: MediaStreamTrack | null = null
  try {
    sampleTrack = sourceTrack.clone()
    // One unread raw frame maximum: diagnostics always prefer the latest
    // source truth and must never build a second hidden video ring.
    const processor = new Constructor({ track: sampleTrack, maxBufferSize: 1 })
    const reader = processor.readable.getReader()
    const samples: ProcessorFingerprintSample[] = []
    let stopping = false
    let failureDetail: string | undefined
    let pendingRead: Promise<ReadableStreamReadResult<VideoFrame>> | null = null
    let cancellationStarted = false
    let releaseScheduled = false

    const cancelReader = (): void => {
      if (cancellationStarted) return
      cancellationStarted = true
      void reader.cancel().catch((error: unknown) => {
        failureDetail ??= `processor cancellation failed: ${describe(error)}`
      })
    }
    const closeReadResult = (
      result: ReadableStreamReadResult<VideoFrame>,
    ): void => {
      if (!result.done) result.value.close()
    }
    const releaseReader = (): void => {
      try {
        reader.releaseLock()
      } catch (error) {
        failureDetail ??= `processor reader release failed: ${describe(error)}`
      }
    }
    const scheduleReaderRelease = (): void => {
      if (releaseScheduled) return
      releaseScheduled = true
      const lateRead = pendingRead
      if (lateRead === null) {
        releaseReader()
        return
      }
      // A timeout never abandons ownership of a future VideoFrame. Cancellation
      // normally resolves this as done=true; if Chromium delivers one last
      // frame instead, close it before releasing the reader lock.
      void lateRead.then(closeReadResult, () => {}).then(releaseReader)
    }

    const done = (async (): Promise<void> => {
      try {
        while (
          !stopping &&
          generation === captureGeneration &&
          stream === acquiredStream &&
          captureBackend === 'chromium-desktop-capture'
        ) {
          const timeout = Symbol('track-processor-read-timeout')
          let timeoutHandle: number | undefined
          pendingRead = reader.read()
          let result:
            | ReadableStreamReadResult<VideoFrame>
            | typeof timeout
          try {
            result = await Promise.race([
              pendingRead,
              new Promise<typeof timeout>((resolve) => {
                timeoutHandle = window.setTimeout(
                  () => resolve(timeout),
                  SOURCE_LATENCY_PROCESSOR_READ_TIMEOUT_MS,
                )
              }),
            ])
          } finally {
            window.clearTimeout(timeoutHandle)
          }
          if (result === timeout) {
            failureDetail =
              `processor frame read exceeded ` +
              `${SOURCE_LATENCY_PROCESSOR_READ_TIMEOUT_MS} ms`
            break
          }
          pendingRead = null
          if (result.done) break
          const frame = result.value
          try {
            if (
              stopping ||
              generation !== captureGeneration ||
              stream !== acquiredStream ||
              captureBackend !== 'chromium-desktop-capture'
            ) {
              break
            }
            samples.push({
              observedAtMs: performance.timeOrigin + performance.now(),
              ...(Number.isFinite(frame.timestamp)
                ? { frameTimestampUs: frame.timestamp }
                : {}),
              fingerprint: sourceLatencyFingerprintDrawable(frame),
            })
            if (samples.length > SOURCE_LATENCY_RETAINED_SAMPLE_LIMIT) {
              samples.splice(
                0,
                samples.length - SOURCE_LATENCY_RETAINED_SAMPLE_LIMIT,
              )
            }
          } finally {
            frame.close()
          }
        }
      } catch (error) {
        failureDetail ??= `processor sampling failed: ${describe(error)}`
      } finally {
        stopping = true
        sampleTrack?.stop()
        cancelReader()
        scheduleReaderRelease()
      }
    })()

    return {
      status: 'active',
      sampler: {
        samples,
        detail: () => failureDetail,
        async stop(): Promise<void> {
          stopping = true
          sampleTrack?.stop()
          cancelReader()
          let timeoutHandle: number | undefined
          try {
            await Promise.race([
              done,
              new Promise<void>((resolve) => {
                timeoutHandle = window.setTimeout(
                  resolve,
                  SOURCE_LATENCY_PROCESSOR_CLEANUP_TIMEOUT_MS,
                )
              }),
            ])
          } finally {
            window.clearTimeout(timeoutHandle)
          }
        },
      },
    }
  } catch (error) {
    sampleTrack?.stop()
    return {
      status: 'unavailable',
      detail: `MediaStreamTrackProcessor construction failed: ${describe(error)}`,
    }
  }
}

async function samplePrimaryFingerprint(): Promise<FrameFingerprint | null> {
  // The recorder already owns this presentation sink. Prefer it over
  // ImageCapture: on Windows 11 / Chromium 150 grabFrame() can remain pending
  // forever for a desktop track even though the constructor is exposed.
  // Reading the current presented frame is synchronous and adds no unbounded
  // operation or second retained decoder.
  if (
    tickVideo !== null &&
    tickVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
  ) {
    return fingerprintDrawable(tickVideo)
  }
  return null
}

async function samplePrimaryCalibrationFingerprint(): Promise<SourceLatencyFingerprint | null> {
  if (
    tickVideo !== null &&
    tickVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
  ) {
    return sourceLatencyFingerprintDrawable(tickVideo)
  }
  return null
}

async function fingerprintNativeJpeg(
  jpeg: ArrayBuffer,
): Promise<FrameFingerprint> {
  const bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }))
  try {
    return fingerprintDrawable(bitmap)
  } finally {
    bitmap.close()
  }
}

async function fingerprintNativeJpegForSourceLatency(
  jpeg: ArrayBuffer,
): Promise<SourceLatencyFingerprint> {
  const bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }))
  try {
    return sourceLatencyFingerprintDrawable(bitmap)
  } finally {
    bitmap.close()
  }
}

async function fingerprintNativeJpegForCalibration(
  jpeg: ArrayBuffer,
): Promise<SourceLatencyFingerprint> {
  let timeoutHandle: number | undefined
  try {
    return await Promise.race([
      fingerprintNativeJpegForSourceLatency(jpeg),
      new Promise<never>((_resolve, reject) => {
        timeoutHandle = window.setTimeout(
          () =>
            reject(
              new Error(
                `native calibration JPEG decode exceeded ${SOURCE_LATENCY_DECODE_TIMEOUT_MS} ms`,
              ),
            ),
          SOURCE_LATENCY_DECODE_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    window.clearTimeout(timeoutHandle)
  }
}

async function startDxgiLatencyReference(): Promise<CaptureDxgiTimingReferencePayload> {
  const operation = window.captureBridge.captureDxgiTimingReference()
  const timeout = Symbol('source-latency-dxgi-ipc-timeout')
  let timeoutHandle: number | undefined
  try {
    const result = await Promise.race([
      operation,
      new Promise<typeof timeout>((resolve) => {
        timeoutHandle = window.setTimeout(
          () => resolve(timeout),
          SOURCE_LATENCY_DXGI_IPC_TIMEOUT_MS,
        )
      }),
    ])
    if (result !== timeout) return result
    // The native helper has its own one-second process watchdog. Consume a
    // pathologically late IPC result without holding calibration open.
    void operation.catch((error: unknown) => {
      console.warn(
        `[capture] late DXGI timing reference failed: ${describe(error)}`,
      )
    })
    return {
      status: 'unavailable',
      reason: 'renderer-ipc-timeout',
      detail:
        `DXGI timing IPC exceeded ${SOURCE_LATENCY_DXGI_IPC_TIMEOUT_MS} ms`,
    }
  } catch (error) {
    return {
      status: 'unavailable',
      reason: 'ipc-failed',
      detail: describe(error),
    }
  } finally {
    window.clearTimeout(timeoutHandle)
  }
}

async function startNativeLatencyReference(): Promise<CaptureNativeFallbackStartPayload> {
  const operation = window.captureBridge.startNativeFallback({
    requestedFps: MIN_CAPTURE_FPS,
    width: SOURCE_LATENCY_FINGERPRINT_WIDTH,
    height: SOURCE_LATENCY_FINGERPRINT_HEIGHT,
    purpose: 'health-probe',
  })
  const timeout = Symbol('source-latency-native-start-timeout')
  let timeoutHandle: number | undefined
  try {
    const result = await Promise.race([
      operation,
      new Promise<typeof timeout>((resolve) => {
        timeoutHandle = window.setTimeout(
          () => resolve(timeout),
          SOURCE_LATENCY_NATIVE_START_TIMEOUT_MS,
        )
      }),
    ])
    if (result !== timeout) return result

    // IPC invoke itself cannot be aborted. Keep exactly this one late promise
    // owned: a late success is stopped immediately, and a late rejection is
    // consumed, so neither a helper session nor an unhandled rejection leaks.
    void operation.then(
      (late) => window.captureBridge.stopNativeFallback(late.sessionId),
      (error: unknown) => {
        console.warn(
          `[capture] late native calibration source failed: ${describe(error)}`,
        )
      },
    )
    throw new Error(
      `native calibration source exceeded ${SOURCE_LATENCY_NATIVE_START_TIMEOUT_MS} ms`,
    )
  } finally {
    window.clearTimeout(timeoutHandle)
  }
}

interface SourceLatencyCalibrationControl {
  cancelled: boolean
  stopSampler: (() => void) | null
  readonly presentedSamples: ReplayPixelClockPresentedSample[]
}

interface SourceLatencyCalibrationHandle {
  cancel(): void
  observePresented(sample: ReplayPixelClockPresentedSample): void
}

function processorTimestampDiagnostic(
  samples: readonly ProcessorFingerprintSample[],
  qpcDecision?: ProcessorQpcDeliveryDecision,
): string {
  const timed = samples.filter(
    (
      sample,
    ): sample is ProcessorFingerprintSample & {
      readonly frameTimestampUs: number
    } =>
      typeof sample.frameTimestampUs === 'number' &&
      Number.isFinite(sample.frameTimestampUs),
  )
  const first = timed[0]
  const last = timed[timed.length - 1]
  if (first === undefined || last === undefined) {
    return 'processor-timestamp={"status":"unavailable","origin":"unknown"}'
  }
  let monotonic = true
  for (let index = 1; index < timed.length; index += 1) {
    const previous = timed[index - 1]
    const current = timed[index]
    if (
      previous === undefined ||
      current === undefined ||
      current.frameTimestampUs < previous.frameTimestampUs
    ) {
      monotonic = false
      break
    }
  }
  const timestampSpanMs =
    (last.frameTimestampUs - first.frameTimestampUs) / 1_000
  const observedSpanMs = last.observedAtMs - first.observedAtMs
  return `processor-timestamp=${JSON.stringify({
    status:
      qpcDecision?.status === 'measured'
        ? 'processor-clock-measured'
        : 'diagnostic-only',
    method: 'processor-qpc-clock',
    origin:
      qpcDecision?.status === 'measured' ? 'windows-qpc' : 'unknown',
    meaning: 'processor-delivery-not-desktop-source',
    unit: 'microseconds',
    sampleCount: timed.length,
    firstTimestampUs: first.frameTimestampUs,
    lastTimestampUs: last.frameTimestampUs,
    monotonic,
    timestampSpanMs,
    observedSpanMs,
    spanDeltaMs: observedSpanMs - timestampSpanMs,
  })}`
}

function sourceLatencyDiagnostic(
  samples: readonly SourceLatencyCalibrationSample[],
  sampleSource: SourceLatencySampleSource,
  candidateRangeMs: { readonly min: number; readonly max: number },
  referenceTiming: SourceLatencyReferenceTiming,
  reference: NonNullable<
    NonNullable<CaptureReadyPayload['sourceLatencyCalibration']>['reference']
  >,
  detail: string,
  qpcDecision?: ProcessorQpcDeliveryDecision,
): NonNullable<CaptureReadyPayload['sourceLatencyCalibration']> {
  const decision = decideSourceLatencyCalibration(samples, {
    candidateRangeMs,
    sampleSource,
    referenceTiming,
  })
  return {
    status: decision.status,
    reason: decision.reason,
    ...(decision.status === 'measured' ? { method: 'pixel-match' as const } : {}),
    sampleSource: decision.sampleSource,
    sampleCount: decision.sampleCount,
    ...(decision.latencyMs === undefined
      ? {}
      : { latencyMs: decision.latencyMs }),
    ...(decision.confidence === undefined
      ? {}
      : { confidence: decision.confidence }),
    ...(decision.bestDelta === undefined
      ? {}
      : { bestDelta: decision.bestDelta }),
    ...(decision.observedChange === undefined
      ? {}
      : { observedChange: decision.observedChange }),
    ...(decision.motionTransitions === undefined
      ? {}
      : { motionTransitions: decision.motionTransitions }),
    ...(decision.candidates === undefined
      ? {}
      : {
          candidates: decision.candidates.map((candidate) => ({
            latencyMs: candidate.latencyMs,
            delta: candidate.delta,
          })),
        }),
    ...(qpcDecision === undefined
      ? {}
      : {
          qpc: {
            method: 'processor-qpc-clock' as const,
            status: qpcDecision.status,
            reason: qpcDecision.reason,
            sampleCount: qpcDecision.sampleCount,
            ...(qpcDecision.timestampMonotonic === undefined
              ? {}
              : { timestampMonotonic: qpcDecision.timestampMonotonic }),
            ...(qpcDecision.nativeQpcBracketed === undefined
              ? {}
              : { nativeQpcBracketed: qpcDecision.nativeQpcBracketed }),
            ...(qpcDecision.timestampSpanMs === undefined
              ? {}
              : { timestampSpanMs: qpcDecision.timestampSpanMs }),
            ...(qpcDecision.observedSpanMs === undefined
              ? {}
              : { observedSpanMs: qpcDecision.observedSpanMs }),
            ...(qpcDecision.spanErrorRatio === undefined
              ? {}
              : { spanErrorRatio: qpcDecision.spanErrorRatio }),
            ...(qpcDecision.deliveryLatencyMs === undefined
              ? {}
              : { deliveryLatencyMs: qpcDecision.deliveryLatencyMs }),
            ...(qpcDecision.deliveryLatencyP05Ms === undefined
              ? {}
              : { deliveryLatencyP05Ms: qpcDecision.deliveryLatencyP05Ms }),
            ...(qpcDecision.deliveryLatencyP50Ms === undefined
              ? {}
              : { deliveryLatencyP50Ms: qpcDecision.deliveryLatencyP50Ms }),
            ...(qpcDecision.deliveryLatencyP95Ms === undefined
              ? {}
              : { deliveryLatencyP95Ms: qpcDecision.deliveryLatencyP95Ms }),
            ...(qpcDecision.deliveryLatencyMadMs === undefined
              ? {}
              : { deliveryLatencyMadMs: qpcDecision.deliveryLatencyMadMs }),
            ...(qpcDecision.deliveryLatencyBoundMs === undefined
              ? {}
              : {
                  deliveryLatencyBoundMs:
                    qpcDecision.deliveryLatencyBoundMs,
                }),
          },
          pixel: {
            status: decision.status,
            reason: decision.reason,
            ...(decision.latencyMs === undefined
              ? {}
              : { latencyMs: decision.latencyMs }),
          },
        }),
    reference,
    detail,
  }
}

async function measureChromiumSourceLatency(
  payload: CaptureStartPayload,
  generation: number,
  acquiredStream: MediaStream,
  control: SourceLatencyCalibrationControl,
): Promise<CaptureReadyPayload['sourceLatencyCalibration']> {
  let nativeSessionId: string | null = null
  const processorStart = startPrimaryTrackProcessorSampler(
    acquiredStream,
    generation,
  )
  const processorSampler =
    processorStart.status === 'active' ? processorStart.sampler : null
  const processorUnavailableDetail =
    processorStart.status === 'unavailable'
      ? processorStart.detail
      : 'MediaStreamTrackProcessor became unavailable'
  const attemptedSampleSource: SourceLatencySampleSource =
    processorSampler === null
      ? 'video-presentation-callback'
      : 'media-stream-track-processor'
  control.stopSampler = () => {
    void processorSampler?.stop()
  }
  try {
    const dxgi = await startDxgiLatencyReference()
    if (
      control.cancelled
      || generation !== captureGeneration
      || stream !== acquiredStream
      || captureBackend !== 'chromium-desktop-capture'
    ) {
      return {
        status: 'unavailable',
        reason: 'cancelled',
        sampleSource: attemptedSampleSource,
        sampleCount: 0,
        detail: 'calibration cancelled at recorder boundary',
      }
    }
    let reference: SourceLatencyFingerprint
    let referenceAtMs: number
    let referenceTiming: SourceLatencyReferenceTiming
    let qpcAnchor: {
      readonly capturedQpc: number
      readonly qpcFrequency: number
      readonly capturedAtMs: number
      readonly clockEvidence: 'windows-qpc'
    }
    let referenceDiagnostic: NonNullable<
      NonNullable<CaptureReadyPayload['sourceLatencyCalibration']>['reference']
    >
    let referenceDetail: string
    if (dxgi.status === 'available') {
      const mapped = mapDxgiTimingReferenceEpoch(dxgi)
      reference = buildSourceLatencyFingerprintFromRgb(
        new Uint8Array(dxgi.rgb),
        dxgi.width,
        dxgi.height,
      )
      referenceAtMs = mapped.presentedAtMs
      referenceTiming = dxgi.referenceTiming
      const capturedQpc = Number(dxgi.lastPresentQpc)
      const qpcFrequency = Number(dxgi.qpcFrequency)
      if (
        !Number.isSafeInteger(capturedQpc)
        || !Number.isSafeInteger(qpcFrequency)
        || qpcFrequency <= 0
      ) {
        throw new Error('DXGI QPC values exceeded renderer safe integer range')
      }
      qpcAnchor = {
        capturedQpc,
        qpcFrequency,
        capturedAtMs: mapped.presentedAtMs,
        clockEvidence: dxgi.clockProvenance,
      }
      referenceDiagnostic = {
        source: 'dxgi-desktop-duplication',
        timing: dxgi.referenceTiming,
        anchorSpanQpc: mapped.anchorSpanQpc,
        anchorSpanMs: mapped.anchorSpanMs,
        anchorUncertaintyMs: mapped.anchorUncertaintyMs,
        presentedAtUnixNs: mapped.presentedAtUnixNs,
      }
      referenceDetail =
        `reference=dxgi-same-acquired-resource; timing=${dxgi.referenceTiming}; `
        + `device=${dxgi.deviceName}; accumulatedFrames=${dxgi.accumulatedFrames}; `
        + `anchorSpanQpc=${mapped.anchorSpanQpc}; `
        + `anchorSpanMs=${mapped.anchorSpanMs}; `
        + `anchorUncertaintyMs=${mapped.anchorUncertaintyMs}`
    } else {
      const native = await startNativeLatencyReference()
      nativeSessionId = native.sessionId
      if (
        control.cancelled
        || generation !== captureGeneration
        || stream !== acquiredStream
        || captureBackend !== 'chromium-desktop-capture'
      ) {
        return {
          status: 'unavailable',
          reason: 'cancelled',
          sampleSource: attemptedSampleSource,
          sampleCount: 0,
          detail: 'calibration cancelled at recorder boundary',
        }
      }
      reference = await fingerprintNativeJpegForCalibration(
        native.firstFrame.jpeg,
      )
      referenceAtMs = native.firstFrame.capturedAtMs
      referenceTiming = 'post-bitblt-completion'
      qpcAnchor = {
        capturedQpc: native.firstFrame.capturedQpc,
        qpcFrequency: native.firstFrame.qpcFrequency,
        capturedAtMs: native.firstFrame.capturedAtMs,
        clockEvidence: native.firstFrame.clockProvenance,
      }
      referenceDiagnostic = {
        source: 'windows-gdi-bitblt',
        timing: 'post-bitblt-completion',
      }
      referenceDetail =
        `reference=gdi-diagnostic-only; timing=post-bitblt-completion; `
        + `dxgi-unavailable=${dxgi.reason}`
        + (dxgi.detail === undefined ? '' : ` (${dxgi.detail})`)
    }
    const observationMs = Math.max(1_200, 6_000 / payload.fps)

    if (processorSampler !== null) {
      // The collector started BEFORE native acquisition, so a fast 30 fps
      // source cannot pass the reference while its JPEG/IPC is being decoded.
      // Wait only for the remainder of the bounded post-reference window.
      const nowComparableMs = performance.timeOrigin + performance.now()
      const remainingMs = Math.max(
        0,
        Math.min(
          observationMs,
          referenceAtMs + observationMs - nowComparableMs,
        ),
      )
      const deadline = performance.now() + remainingMs
      while (
        performance.now() < deadline &&
        !control.cancelled &&
        generation === captureGeneration &&
        stream === acquiredStream &&
        captureBackend === 'chromium-desktop-capture'
      ) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 16))
      }
      await processorSampler.stop()
      const processorSamples = processorSampler.samples
      // The helper is the only producer allowed to stamp `windows-qpc`.
      // The pure decision still has to prove bracket, scale, monotonicity and
      // dispersion before a VideoFrame timestamp can refine the sample axis.
      // Field evidence proves this clock is processor delivery/presentation,
      // NOT desktop pixel exposure, so it can never become source latency by
      // itself.
      const qpcDecision = decideProcessorQpcDeliveryLatency(
        processorSamples.flatMap((sample) =>
          sample.frameTimestampUs === undefined
            ? []
            : [
                {
                  observedAtMs: sample.observedAtMs,
                  frameTimestampUs: sample.frameTimestampUs,
                },
              ],
        ),
        qpcAnchor,
        { clockEvidence: qpcAnchor.clockEvidence },
      )
      const processorEpochSamples = processorSamples
        .flatMap((sample) => {
          const qpcEpochMs =
            sample.frameTimestampUs === undefined
              ? undefined
              : mapProcessorFrameEpochMs(
                  sample.frameTimestampUs,
                  qpcAnchor,
                  qpcDecision,
                )
          // A measured QPC clock gives the pixel matcher a lower-jitter
          // presentation axis. If the clock was not proved, retain the older
          // wall-observed axis instead of guessing. A measured QPC decision
          // never mixes timestamp-less samples back onto that refined axis.
          if (
            qpcDecision.status === 'measured' &&
            qpcEpochMs === undefined
          ) {
            return []
          }
          return [{
            processorAtMs: qpcEpochMs ?? sample.observedAtMs,
            fingerprint: sample.fingerprint,
          }]
        })
      const samples = processorEpochSamples
        .map((sample): SourceLatencyCalibrationSample => ({
          latencyMs: sample.processorAtMs - referenceAtMs,
          delta: sourceLatencyFingerprintDelta(
            reference,
            sample.fingerprint,
          ),
          fingerprint: sample.fingerprint,
        }))
        .filter(
          (sample) =>
            Number.isFinite(sample.latencyMs) &&
            // Keep the bounded frames from immediately BEFORE the independent
            // native exposure too. They prove which side of the reference the
            // decoded sequence approached from and prevent the 30 fps match
            // from being left-censored while native IPC/JPEG work completes.
            sample.latencyMs >= -SOURCE_LATENCY_NATIVE_START_TIMEOUT_MS &&
            sample.latencyMs <= observationMs,
        )
      const diagnostic = sourceLatencyDiagnostic(
        samples,
        'media-stream-track-processor',
        {
          min: -SOURCE_LATENCY_NATIVE_START_TIMEOUT_MS,
          max: observationMs,
        },
        referenceTiming,
        referenceDiagnostic,
        [
          referenceDetail,
          'sample-source=media-stream-track-processor',
          `sample-time-axis=${
            qpcDecision.status === 'measured'
              ? 'processor-qpc-clock'
              : 'renderer-observed'
          }`,
          processorTimestampDiagnostic(processorSamples, qpcDecision),
          processorSampler.detail(),
        ]
          .filter((part): part is string => part !== undefined)
          .join('; '),
        qpcDecision,
      )
      const direct = decideSourcePresentationLatency(
        referenceAtMs,
        reference,
        control.presentedSamples,
      )
      const bridge = decideProcessorPresentationLatency(
        qpcDecision.status === 'measured'
          ? processorEpochSamples
          : [],
        control.presentedSamples,
      )
      const measuredBaseLatencyMs =
        diagnostic.status === 'measured'
        && diagnostic.pixel?.status === 'measured'
        && typeof diagnostic.latencyMs === 'number'
        && Number.isFinite(diagnostic.latencyMs)
          ? diagnostic.latencyMs
          : undefined
      const measuredBridge =
        bridge.status === 'measured' ? bridge : undefined
      const sourceMediaTimeOriginMs =
        direct.status === 'measured'
        && typeof direct.sourceMediaTimeOriginMs === 'number'
        && Number.isFinite(direct.sourceMediaTimeOriginMs)
          ? direct.sourceMediaTimeOriginMs
          : undefined
      const measuredTotalLatencyMs =
        measuredBaseLatencyMs === undefined
        || qpcDecision.status !== 'measured'
        || measuredBridge === undefined
          ? undefined
          : measuredBaseLatencyMs + measuredBridge.latencyMs
      const presentation: NonNullable<
        NonNullable<
          CaptureReadyPayload['sourceLatencyCalibration']
        >['presentation']
      > =
        measuredTotalLatencyMs !== undefined
        && Number.isFinite(measuredTotalLatencyMs)
        && measuredTotalLatencyMs >= 0
        && measuredTotalLatencyMs <= 1_000
          ? {
              status: 'measured',
              reason: 'measured',
              method: 'dxgi-processor-rvfc-pixel-join',
              sampleCount: control.presentedSamples.length,
              latencyMs: measuredTotalLatencyMs,
              matchedPairCount: measuredBridge?.matchedPairCount,
              processorToPresentationMs: measuredBridge?.latencyMs,
              dispersionMs: measuredBridge?.dispersionMs,
              observedProcessorSpacingMs:
                measuredBridge?.observedProcessorSpacingMs,
              ...(sourceMediaTimeOriginMs === undefined
                ? {}
                : { sourceMediaTimeOriginMs }),
              direct,
            }
          : {
              status:
                diagnostic.status === 'unavailable'
                || bridge.status === 'unavailable'
                  ? 'unavailable'
                  : 'ambiguous',
              reason:
                measuredBaseLatencyMs === undefined
                  ? `source-base-${diagnostic.reason ?? diagnostic.status}`
                  : qpcDecision.status !== 'measured'
                    ? `processor-clock-${qpcDecision.reason}`
                    : bridge.status !== 'measured'
                      ? `processor-presentation-${bridge.reason}`
                      : 'invalid-composed-latency',
              sampleCount: control.presentedSamples.length,
              matchedPairCount: bridge.matchedPairCount,
              ...(bridge.dispersionMs === undefined
                ? {}
                : { dispersionMs: bridge.dispersionMs }),
              ...(bridge.observedProcessorSpacingMs === undefined
                ? {}
                : {
                    observedProcessorSpacingMs:
                      bridge.observedProcessorSpacingMs,
                  }),
              ...(sourceMediaTimeOriginMs === undefined
                ? {}
                : { sourceMediaTimeOriginMs }),
              direct,
            }
      return {
        ...diagnostic,
        presentation,
      }
    }

    // Older runtimes expose no raw processor. Keep the existing presentation
    // sink only as an explicitly ambiguous diagnostic: compositor scheduling
    // measured 80+ ms too late at 30 fps and must never be accepted as source
    // latency.
    const fallbackSamples: SourceLatencyCalibrationSample[] = []
    const deadline = performance.now() + observationMs
    while (
      performance.now() < deadline &&
      !control.cancelled &&
      generation === captureGeneration &&
      stream === acquiredStream &&
      captureBackend === 'chromium-desktop-capture'
    ) {
      const fingerprint = await samplePrimaryCalibrationFingerprint()
      if (fingerprint !== null) {
        const latencyMs =
          performance.timeOrigin +
          performance.now() -
          referenceAtMs
        fallbackSamples.push({
          latencyMs,
          delta: sourceLatencyFingerprintDelta(reference, fingerprint),
          fingerprint,
        })
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 16))
    }
    return sourceLatencyDiagnostic(
      fallbackSamples,
      'video-presentation-callback',
      { min: 0, max: observationMs },
      referenceTiming,
      referenceDiagnostic,
      `${referenceDetail}; sample-source=video-presentation-callback; ${processorUnavailableDetail}`,
    )
  } catch (error) {
    return {
      status: 'unavailable',
      reason: 'probe-failed',
      sampleSource: attemptedSampleSource,
      sampleCount: 0,
      detail: describe(error),
    }
  } finally {
    control.stopSampler = null
    await processorSampler?.stop()
    if (nativeSessionId !== null) {
      window.captureBridge.stopNativeFallback(nativeSessionId)
    }
  }
}

function startChromiumSourceLatencyCalibration(
  payload: CaptureStartPayload,
  generation: number,
  acquiredStream: MediaStream,
): SourceLatencyCalibrationHandle {
  if (sourceLatencyCalibrationGeneration === generation) {
    return {
      cancel: () => {},
      observePresented: () => {},
    }
  }
  sourceLatencyCalibrationGeneration = generation
  const control: SourceLatencyCalibrationControl = {
    cancelled: false,
    stopSampler: null,
    presentedSamples: [],
  }
  let settled = false
  void measureChromiumSourceLatency(
    payload,
    generation,
    acquiredStream,
    control,
  ).then((calibration) => {
    settled = true
    if (control.cancelled) return
    console.info(
      `[capture] display ${payload.displayId}: source latency calibration ${JSON.stringify(calibration)}`,
    )
    if (
      generation !== captureGeneration ||
      stream !== acquiredStream ||
      captureBackend !== 'chromium-desktop-capture'
    ) {
      return
    }
    sourceLatencyCalibration = calibration
  })
  return {
    cancel: () => {
      if (control.cancelled || settled) return
      control.cancelled = true
      control.stopSampler?.()
    },
    observePresented: (sample) => {
      if (control.cancelled || settled) return
      control.presentedSamples.push(sample)
      if (
        control.presentedSamples.length
        > REPLAY_PIXEL_CLOCK_SAMPLE_LIMIT
      ) {
        control.presentedSamples.splice(
          0,
          control.presentedSamples.length
            - REPLAY_PIXEL_CLOCK_SAMPLE_LIMIT,
        )
      }
    },
  }
}

function stopReplayHealthWatchdog(): void {
  window.clearInterval(replayHealthTimer)
  replayHealthTimer = undefined
  replayHealthState = null
  replayHealthProbeToken += 1
  replayHealthProbeActive = false
}

function releaseReplayHealthProbe(token: number): void {
  if (token === replayHealthProbeToken) {
    replayHealthProbeActive = false
  }
}

async function inspectReplayPixels(generation: number): Promise<void> {
  if (
    generation !== captureGeneration ||
    captureBackend !== 'chromium-desktop-capture' ||
    replayHealthProbeActive
  ) {
    return
  }
  const state = replayHealthState
  if (state === null) return
  const probeToken = ++replayHealthProbeToken
  replayHealthProbeActive = true
  let releaseOnReturn = true
  try {
    const timeout = Symbol('replay-health-sample-timeout')
    let primary: FrameFingerprint | null | typeof timeout
    try {
      // ImageCapture.grabFrame() has no AbortSignal. Bound the caller's wait,
      // but if Chromium never settles the operation keep this generation's
      // lease occupied. That quarantines one retained promise instead of
      // allocating another one every four seconds.
      let timeoutHandle: number | undefined
      const primaryOperation = samplePrimaryFingerprint()
      try {
        primary = await Promise.race([
          primaryOperation,
          new Promise<typeof timeout>((resolve) => {
            timeoutHandle = window.setTimeout(
              () => resolve(timeout),
              HEALTH_SAMPLE_TIMEOUT_MS,
            )
          }),
        ])
      } finally {
        window.clearTimeout(timeoutHandle)
      }
      if (primary === timeout) {
        releaseOnReturn = false
        void primaryOperation.then(
          () => releaseReplayHealthProbe(probeToken),
          (error: unknown) => {
            console.warn(
              `[capture] display ${startPayload?.displayId ?? '?'}: late replay pixel health sample failed: ${describe(error)}`,
            )
            releaseReplayHealthProbe(probeToken)
          },
        )
        console.warn(
          `[capture] display ${startPayload?.displayId ?? '?'}: replay pixel health sample exceeded ${HEALTH_SAMPLE_TIMEOUT_MS} ms; suppressing overlapping probes until it settles`,
        )
        return
      }
    } catch (error) {
      console.warn(
        `[capture] display ${startPayload?.displayId ?? '?'}: replay pixel health sample unavailable: ${describe(error)}`,
      )
      return
    }
    if (
      primary === null ||
      generation !== captureGeneration ||
      captureBackend !== 'chromium-desktop-capture'
    ) {
      return
    }
    const nowMs = performance.now()
    const suspicion = observePrimaryFingerprint(state, primary, nowMs)
    if (suspicion === null) return
    if (suspicion === 'unchanged-too-long') {
      // One native comparison cannot prove a frozen source without making a
      // static desktop, cursor or colour conversion an RC-breaking false
      // positive. Keep this policy observable but non-actionable until a bounded
      // two-native-sample motion proof is implemented.
      return
    }

    // A black/frozen primary is never sufficient evidence: the desktop may
    // deliberately be black or unchanged. One 64x36 GDI frame is the independent
    // witness, requested only after the cheap primary policy becomes suspicious.
    markReplayHealthProbe(state, nowMs)
    let probeSessionId: string | null = null
    try {
      const native = await window.captureBridge.startNativeFallback({
        requestedFps: MIN_CAPTURE_FPS,
        width: HEALTH_SAMPLE_WIDTH,
        height: HEALTH_SAMPLE_HEIGHT,
        purpose: 'health-probe',
      })
      probeSessionId = native.sessionId
      const nativeFingerprint = await fingerprintNativeJpeg(
        native.firstFrame.jpeg,
      )
      if (
        generation === captureGeneration &&
        captureBackend === 'chromium-desktop-capture' &&
        nativeProbeConfirmsFailure(suspicion, primary, nativeFingerprint)
      ) {
        console.error(
          `[capture] display ${startPayload?.displayId ?? '?'}: Chromium replay pixels are ${suspicion}; independent GDI pixels differ, reopening this display on the degraded native backend`,
        )
        failCapture(
          `Chromium replay pixel watchdog confirmed ${suspicion} against independent GDI capture`,
          generation,
        )
      } else {
        console.info(
          `[capture] display ${startPayload?.displayId ?? '?'}: ${suspicion} was not confirmed by GDI; preserving the primary stream`,
        )
      }
    } catch (error) {
      // Probe failure says nothing about the primary pixels. Keep recording and
      // retry only after the long inconclusive cooldown.
      console.warn(
        `[capture] display ${startPayload?.displayId ?? '?'}: native replay health probe unavailable: ${describe(error)}`,
      )
    } finally {
      if (probeSessionId !== null) {
        window.captureBridge.stopNativeFallback(probeSessionId)
      }
    }
  } finally {
    if (releaseOnReturn) releaseReplayHealthProbe(probeToken)
  }
}

function startReplayHealthWatchdog(
  generation: number,
  initial: FrameFingerprint | null,
): void {
  stopReplayHealthWatchdog()
  if (captureBackend !== 'chromium-desktop-capture') return
  replayHealthState = createReplayHealthState(initial)
  replayHealthTimer = window.setInterval(() => {
    void inspectReplayPixels(generation)
  }, REPLAY_HEALTH_SAMPLE_MS)
}

function armEvidenceCheck(delayMs: number): void {
  window.clearTimeout(evidenceTimer)
  const generation = captureGeneration
  evidenceTimer = window.setTimeout(() => {
    if (generation !== captureGeneration) return
    checkFrameEvidence()
  }, delayMs)
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
function sendCurrentFrameProof(bytes: number, frames: number): void {
  if (startPayload?.simulateSlowReplayMs !== undefined) return
  const measured = cadenceSummary()
  window.captureBridge.sendFrames({
    displayId: startPayload?.displayId ?? '',
    bytes,
    frames,
    ...(captureBackend === 'windows-gdi-bitblt'
      ? {
          nativePresentation: {
            requestedFrames: nativeFallbackRequestedFrames,
            exactCallbacks: nativeFallbackPresentedFrames,
            unreportedPresented:
              nativeFallbackPresentationQueue.stats().unreportedPresented,
            ambiguousDropped:
              nativeFallbackPresentationQueue.stats().ambiguousDropped,
            capacityDropped:
              nativeFallbackPresentationQueue.stats().capacityDropped,
            pending: nativeFallbackPresentationQueue.stats().retained,
          },
        }
      : {}),
    // Omitted, never zeroed, while nothing can honestly be said (#82): a rate
    // nobody measured must not be reported as a rate.
    ...(measured === null ? {} : { cadence: measured }),
  })
}

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
    // recorder — the encoder and bounded ring buffer — stays real, which
    // is exactly the state #43 describes and exactly what recovery must not
    // destroy.
    if (startPayload?.simulateSlowReplayMs === undefined) {
      sendCurrentFrameProof(bytes, frames ?? 0)
    }
    armEvidenceCheck(EVIDENCE_STALL_MS)
    return
  }
  // NO COUNTER, NO VERDICT. Failing here would announce "not recording" on
  // every launch of a healthy MP4 recorder, restart it for nothing, and — once
  // the one retry is spent — leave the display screenshot-only for the rest of
  // the process. Keep watching instead: the next flush (a capture or main's
  // probe) still lands in noteRecorderBytes and proves it.
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
      `"${activeRecorder?.recorder.state ?? webmRing?.recorderStates() ?? 'none'}". ` +
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
function terminalCaptureFailure(
  message: string,
  generation = captureGeneration,
): void {
  if (generation !== captureGeneration) return
  window.captureBridge.sendError(message)
  teardown()
}

function failCapture(message: string, generation = captureGeneration): void {
  // A delayed failure belongs to the capture which created it. Without this
  // guard, an old track-ended/error/deadline can tear down the replacement
  // stream and start a second stale fallback.
  if (generation !== captureGeneration) return
  const payload = startPayload
  if (
    payload === null ||
    captureBackend === 'windows-gdi-bitblt' ||
    nativeFallbackCircuitOpen
  ) {
    terminalCaptureFailure(message, generation)
    return
  }
  // Circuit breaker: the rest of THIS recorder-window session stays on the
  // alternate backend. Retrying the same Chromium stream after it proved dead
  // is not recovery, and flapping would throw away the fallback ring.
  nativeFallbackCircuitOpen = true
  retried = true
  console.warn(
    `[capture] display ${payload.displayId}: primary replay source failed (${message}); ` +
      'switching this display to windows-gdi-bitblt for the rest of the session',
  )
  void startNativeFallbackCapture(payload, generation).catch((error: unknown) => {
    if (
      !nativeFallbackCircuitOpen ||
      startPayload !== payload ||
      captureBackend !== 'windows-gdi-bitblt'
    ) {
      return
    }
    terminalCaptureFailure(
      `native replay fallback failed after ${message}: ${describe(error)}`,
    )
  })
}

function teardown(): void {
  captureGeneration += 1
  sourceLatencyCalibrationCancel?.()
  sourceLatencyCalibrationCancel = null
  sourceLatencyCalibration = undefined
  sourceLatencyCalibrationGeneration = null
  replayPixelClockPresentedSamples = []
  replayPixelClockCanvas = null
  replayPixelClockContext = null
  primaryReadinessCancel?.()
  primaryReadinessCancel = null
  stopReplayHealthWatchdog()
  nativeFallbackStartupErrors.cancel()
  const fallbackSession = nativeFallbackSessionId
  nativeFallbackSessionId = null
  if (fallbackSession !== null) {
    window.captureBridge.stopNativeFallback(fallbackSession)
  }
  nativeFallbackTrack = null
  nativeFallbackContext = null
  nativeFallbackCanvas?.remove()
  nativeFallbackCanvas = null
  nativeFallbackDecodeActive = false
  nativeFallbackPendingFrame = null
  const presentationStats = nativeFallbackPresentationQueue.stats()
  if (
    nativeFallbackRequestedFrames > 0 &&
    (nativeFallbackPresentedFrames !== nativeFallbackRequestedFrames ||
      presentationStats.capacityDropped > 0 ||
      presentationStats.ambiguousDropped > 0 ||
      presentationStats.unreportedPresented > 0)
  ) {
    console.info(
      `[capture] display ${startPayload?.displayId ?? '?'}: native presentation association ` +
        `requested=${nativeFallbackRequestedFrames}, presented=${nativeFallbackPresentedFrames}, ` +
        `ambiguous-dropped=${presentationStats.ambiguousDropped}, ` +
        `unreported-presented=${presentationStats.unreportedPresented}, ` +
        `capacity-dropped=${presentationStats.capacityDropped}, ` +
        `pending=${presentationStats.retained}`,
    )
  }
  nativeFallbackPresentedFrames = 0
  nativeFallbackRequestedFrames = 0
  nativeFallbackLastPresentedFrames = null
  nativeFallbackPresentationReported = false
  nativeFallbackInvalidClockLogged = false
  nativeFallbackPresentationQueue.clear()
  nativeFallbackFrameClock.reset()
  // A queue is an owner too. Cancellation drops every not-yet-converted Blob,
  // open stop batch and ring consumer synchronously. The browser may still
  // finish one already-started arrayBuffer(), but it cannot delay or reach the
  // replacement generation.
  ingestQueue?.cancel()
  ingestQueue = null
  recorderQueue = Promise.resolve()
  window.clearTimeout(replayHold?.watchdog)
  replayHold = null
  replayResumeTokens.clear()
  window.clearTimeout(retryTimer)
  retryTimer = undefined
  window.clearTimeout(evidenceTimer)
  evidenceTimer = undefined
  window.clearInterval(cadenceTimer)
  cadenceTimer = undefined
  cadence = null
  // Release the extra one-pixel frame sink immediately. Waiting for the retry
  // to call startFrameTicks() kept a stopped desktop stream and its callback
  // chain alive for the whole backoff window.
  stopFrameTicks()
  const session = activeRecorder
  activeRecorder = null
  if (session !== null) {
    window.clearTimeout(session.flushTimer)
    session.flushTimer = undefined
    const recorder = session.recorder
    // A replay extraction owns a non-null onstop until its stop event lands;
    // its continuation releases these references after assembling the ring.
    // Every other teardown is discarding the recorder and can release now.
    if (recorder.onstop === null) {
      session.flushBatch?.cancel()
      session.flushBatch = null
      releaseRecorderReferences(recorder, [])
    }
    if (recorder.state !== 'inactive') {
      try {
        recorder.stop()
      } catch {
        // The recorder may already have a stop task queued.
      }
    }
  }
  replayRing?.clear()
  replayRing = null
  // The fallback owns two recorder sessions and their stagger/rotation timers.
  // Disposing the owner first makes any synchronous final data event harmless.
  const fallback = webmRing
  webmRing = null
  fallback?.clear()
  if (stream) {
    for (const track of stream.getTracks()) track.stop()
    stream = null
  }
}

async function startCapture(payload: CaptureStartPayload): Promise<void> {
  // Explicit starts and guarded retries both supersede an in-flight
  // getDisplayMedia call. Teardown retires its generation; the local stream
  // below is installed only if this attempt still owns the renderer.
  teardown()
  const generation = ++captureGeneration
  startPayload = payload
  recorderSourceFps = payload.fps
  captureBackend = 'chromium-desktop-capture'
  captureQuality = 'full'
  segmentMs = payload.segmentSeconds * 1000
  recorderFormat = pickRecorderFormat((mimeType) =>
    MediaRecorder.isTypeSupported(mimeType),
  )
  if (recorderFormat === null) {
    failCapture('MediaRecorder has no supported CapturePack replay format')
    return
  }
  let acquiredStream: MediaStream
  try {
    // The main process routes this to the display assigned to this window
    // (payload.displayId); no picker appears.
    acquiredStream = await navigator.mediaDevices.getDisplayMedia({
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
    failCapture(`getDisplayMedia failed: ${describe(err)}`, generation)
    return
  }
  if (generation !== captureGeneration) {
    for (const track of acquiredStream.getTracks()) track.stop()
    return
  }
  installRecordingStream(
    payload,
    generation,
    acquiredStream,
    'chromium-desktop-capture',
    'full',
  )
}

async function drawNativeFallbackFrame(
  payload: CaptureNativeFallbackFramePayload,
): Promise<void> {
  if (
    nativeFallbackSessionId !== payload.sessionId ||
    nativeFallbackCanvas === null ||
    nativeFallbackContext === null
  ) {
    return
  }
  const bitmap = await createImageBitmap(
    new Blob([payload.jpeg], { type: 'image/jpeg' }),
  )
  try {
    if (
      nativeFallbackSessionId !== payload.sessionId ||
      nativeFallbackCanvas === null ||
      nativeFallbackContext === null
    ) {
      return
    }
    const track = nativeFallbackTrack
    nativeFallbackContext.drawImage(
      bitmap,
      0,
      0,
      nativeFallbackCanvas.width,
      nativeFallbackCanvas.height,
    )
    if (track === null) return
    const paintedAtMs = performance.now()
    // Producer ACK is intentionally independent from presentation. Preserve a
    // bounded metadata-only association for a later automatic rVFC. If paints
    // and presentations are not one-to-one, NativePresentationQueue refuses an
    // exact sequence mapping rather than guessing.
    nativeFallbackPresentationQueue.push(paintedAtMs, {
      sessionId: payload.sessionId,
      sequence: payload.sequence,
      capturedComparableMs: nativeCapturedComparableTime(payload),
    })
    nativeFallbackRequestedFrames += 1
    // Release the producer after pixels have been drawn and handed to the
    // CanvasCaptureMediaStreamTrack. Waiting for a hidden video's rVFC measured
    // as a 1fps throttle on Chromium 150; the presentation signal is separate.
    window.captureBridge.ackNativeFallbackFrame(
      payload.sessionId,
      payload.sequence,
    )
  } finally {
    bitmap.close()
  }
}

function queueNativeFallbackFrame(
  payload: CaptureNativeFallbackFramePayload,
): Promise<void> {
  if (nativeFallbackDecodeActive) {
    // Defensive latest-only bound. Main's ACK protocol normally makes this
    // unreachable, but a stale/malformed sender still cannot grow a Promise
    // chain of retained JPEG ArrayBuffers.
    nativeFallbackPendingFrame = payload
    return Promise.resolve()
  }
  nativeFallbackDecodeActive = true
  return (async () => {
    let current: CaptureNativeFallbackFramePayload | null = payload
    while (current !== null) {
      try {
        await drawNativeFallbackFrame(current)
      } catch (error) {
        console.warn(
          `[capture] display ${startPayload?.displayId ?? '?'}: dropped invalid native replay JPEG: ${describe(error)}`,
        )
        if (nativeFallbackSessionId === current.sessionId) {
          window.captureBridge.ackNativeFallbackFrame(
            current.sessionId,
            current.sequence,
          )
        }
      }
      current = nativeFallbackPendingFrame
      nativeFallbackPendingFrame = null
    }
  })().finally(() => {
    nativeFallbackDecodeActive = false
  })
}

async function startNativeFallbackCapture(
  payload: CaptureStartPayload,
  failedGeneration: number,
): Promise<void> {
  if (
    failedGeneration !== captureGeneration ||
    !nativeFallbackCircuitOpen
  ) {
    return
  }
  teardown()
  const generation = ++captureGeneration
  startPayload = payload
  captureBackend = 'windows-gdi-bitblt'
  captureQuality = 'degraded'
  const startupToken = nativeFallbackStartupErrors.begin()
  let native: CaptureNativeFallbackStartPayload
  try {
    native = await window.captureBridge.startNativeFallback({
      requestedFps: payload.fps,
      // 0 asks main for the assigned display's native physical size.
      width: payload.replayWidth,
      height: payload.replayHeight,
      purpose: 'fallback',
    })
  } catch (error) {
    nativeFallbackStartupErrors.cancel(startupToken)
    throw error
  }
  if (generation !== captureGeneration || startPayload !== payload) {
    nativeFallbackStartupErrors.cancel(startupToken)
    window.captureBridge.stopNativeFallback(native.sessionId)
    return
  }
  const startupFailure = nativeFallbackStartupErrors.consume(
    startupToken,
    native.sessionId,
  )
  if (startupFailure !== null) {
    window.captureBridge.stopNativeFallback(native.sessionId)
    throw new Error(
      `native replay source stopped during startup: ${startupFailure}`,
    )
  }
  recorderSourceFps = native.fps
  nativeFallbackSessionId = native.sessionId
  nativeFallbackCanvas = document.createElement('canvas')
  nativeFallbackCanvas.width = native.width
  nativeFallbackCanvas.height = native.height
  nativeFallbackContext = nativeFallbackCanvas.getContext('2d', {
    alpha: false,
    desynchronized: true,
  })
  if (nativeFallbackContext === null) {
    throw new Error('native replay fallback could not create a 2D canvas')
  }
  // Paint the first real desktop pixels before a capture track exists. Creating
  // the track over an empty canvas allowed MediaRecorder to encode a black
  // startup frame. The source-rate canvas clock below is the only frame clock;
  // adding a manual request after each paint doubled 5fps helper input into an
  // approximately 10fps encoded stream on Chromium 150.
  await drawNativeFallbackFrame(native.firstFrame)
  if (
    generation !== captureGeneration ||
    nativeFallbackCanvas === null ||
    nativeFallbackSessionId !== native.sessionId
  ) {
    return
  }
  const canvasStream = nativeFallbackCanvas.captureStream(native.fps)
  nativeFallbackTrack = canvasStream.getVideoTracks()[0] as
    | CanvasCaptureMediaStreamTrack
    | null
  installRecordingStream(
    payload,
    generation,
    canvasStream,
    native.backend,
    native.quality,
    native.width,
    native.height,
  )
  if (generation !== captureGeneration) return
  // The first canvas pixels predate the track. Associate them with the next
  // automatic source-rate presentation after the rVFC sink exists; there is no
  // second manual clock that can encode the initial source frame twice.
  const requestedAtMs = performance.now()
  nativeFallbackPresentationQueue.push(requestedAtMs, {
    sessionId: native.firstFrame.sessionId,
    sequence: native.firstFrame.sequence,
    capturedComparableMs: nativeCapturedComparableTime(native.firstFrame),
  })
  nativeFallbackRequestedFrames += 1
  window.captureBridge.ackNativeFallbackFrame(
    native.firstFrame.sessionId,
    native.firstFrame.sequence,
  )
}

function installRecordingStream(
  payload: CaptureStartPayload,
  generation: number,
  acquiredStream: MediaStream,
  backend: 'chromium-desktop-capture' | 'windows-gdi-bitblt',
  quality: 'full' | 'degraded',
  explicitWidth?: number,
  explicitHeight?: number,
): void {
  if (generation !== captureGeneration) {
    for (const track of acquiredStream.getTracks()) track.stop()
    return
  }
  const format = recorderFormat
  if (format === null) {
    terminalCaptureFailure(
      'MediaRecorder has no supported CapturePack replay format',
      generation,
    )
    return
  }
  stream = acquiredStream
  captureBackend = backend
  captureQuality = quality
  const track = acquiredStream.getVideoTracks()[0]
  track?.addEventListener('ended', () =>
    failCapture('capture stream ended', generation),
  )
  if (backend === 'chromium-desktop-capture') {
    const minimumObservationMs = primaryStartupObservationAttempted
      ? 0
      : PRIMARY_STARTUP_OBSERVATION_MS
    primaryStartupObservationAttempted = true
    // Clone/processor setup briefly disturbed the first encoded PTS on the
    // physical 30 fps run (134.5 ms startup gap vs 36.9 ms steady state).
    // Spend that work inside the already-declared first-start observation
    // interval, never inside retained replay. Later reacquisitions have no such
    // interval and skip this diagnostic rather than taxing their recorder.
    const calibration =
      minimumObservationMs > 0
        ? startChromiumSourceLatencyCalibration(
            payload,
            generation,
            acquiredStream,
          )
        : null
    const readiness = waitForPrimaryReadiness(
      acquiredStream,
      generation,
      minimumObservationMs,
      (sample) => calibration?.observePresented(sample),
    )
    const cancelCalibration =
      calibration === null ? null : () => calibration.cancel()
    sourceLatencyCalibrationCancel = cancelCalibration
    const closeCalibrationWindow = (): void => {
      if (sourceLatencyCalibrationCancel === cancelCalibration) {
        sourceLatencyCalibrationCancel = null
      }
      cancelCalibration?.()
    }
    void readiness
      .then(async (ready) => {
        closeCalibrationWindow()
        if (
          generation !== captureGeneration ||
          stream !== acquiredStream ||
          captureBackend !== backend
        ) {
          releaseVideoSink(ready.clockVideo)
          return
        }
        // Do not await calibration: a slow native IPC is bounded independently
        // and its late session is stopped when it arrives.
        console.info(
          `[capture] display ${payload.displayId}: primary recorder readiness after ` +
            `${Math.round(ready.waitedMs)} ms (${ready.observedFrames} presented frames, ` +
            `timeout=${String(ready.timedOut)}, excluded-before-recorder=${Math.round(ready.waitedMs)} ms, ` +
            `presentation-span=${Math.round(ready.observedSpanMs)} ms, ` +
            `startup-observation=${String(minimumObservationMs > 0)})`,
        )
        beginInstalledRecording(
          payload,
          generation,
          acquiredStream,
          backend,
          quality,
          explicitWidth,
          explicitHeight,
          ready,
        )
      })
      .catch((error: unknown) => {
        closeCalibrationWindow()
        if (generation !== captureGeneration) return
        failCapture(`primary recorder readiness failed: ${describe(error)}`, generation)
      })
    return
  }
  beginInstalledRecording(
    payload,
    generation,
    acquiredStream,
    backend,
    quality,
    explicitWidth,
    explicitHeight,
    null,
  )
}

function beginInstalledRecording(
  payload: CaptureStartPayload,
  generation: number,
  acquiredStream: MediaStream,
  backend: 'chromium-desktop-capture' | 'windows-gdi-bitblt',
  quality: 'full' | 'degraded',
  explicitWidth: number | undefined,
  explicitHeight: number | undefined,
  startupReadiness: PrimaryReadyResult | null,
): void {
  if (
    generation !== captureGeneration ||
    stream !== acquiredStream ||
    captureBackend !== backend
  ) {
    if (startupReadiness !== null) {
      releaseVideoSink(startupReadiness.clockVideo)
    }
    return
  }
  const format = recorderFormat
  if (format === null) {
    if (startupReadiness !== null) {
      releaseVideoSink(startupReadiness.clockVideo)
    }
    terminalCaptureFailure(
      'MediaRecorder has no supported CapturePack replay format',
      generation,
    )
    return
  }
  const track = acquiredStream.getVideoTracks()[0]
  const settings = track?.getSettings()
  const sourceLatency = (settings as (MediaTrackSettings & { latency?: unknown }) | undefined)
    ?.latency
  captureRecorderCount = format.strategy === 'fragmented-mp4' ? 1 : 2
  window.captureBridge.sendReady({
    displayId: payload.displayId,
    mimeType: format.mimeType,
    replayFile: format.replayFile,
    width: Math.max(0, Math.round(explicitWidth ?? settings?.width ?? 0)),
    height: Math.max(0, Math.round(explicitHeight ?? settings?.height ?? 0)),
    backend,
    quality,
    requestedFps: payload.fps,
    recorderCount: captureRecorderCount,
    ...(typeof sourceLatency === 'number' && Number.isFinite(sourceLatency)
      ? { sourceLatencyMs: sourceLatency * 1000 }
      : {}),
    ...(sourceLatencyCalibration === undefined
      ? {}
      : { sourceLatencyCalibration }),
    ...(startupReadiness === null
      ? {}
      : {
          startupReadiness: {
            observedWaitMs: startupReadiness.waitedMs,
            presentedFrames: startupReadiness.observedFrames,
            timedOut: startupReadiness.timedOut,
            excludedBeforeRecorderMs: startupReadiness.waitedMs,
            observedSpanMs: startupReadiness.observedSpanMs,
          },
        }),
  })
  // Nothing is proven yet — main keeps this display "starting" until the
  // evidence check below says otherwise.
  framesProven = false
  evidenceBytes = 0
  evidenceStrikes = 0
  unknownFramesLogged = false
  evidenceFrames = deliveredFrames() ?? 0
  startCadenceMonitor()
  if (!installFreshReplayStorage(generation)) {
    if (startupReadiness !== null) {
      releaseVideoSink(startupReadiness.clockVideo)
    }
    return
  }
  startFrameTicks(startupReadiness?.clockVideo)
  startReplayHealthWatchdog(
    generation,
    startupReadiness?.fingerprint ?? null,
  )
  armEvidenceCheck(EVIDENCE_DEADLINE_MS)
}

/**
 * Creates one brand-new replay ownership epoch over the existing live stream.
 *
 * Callers must first discard the prior ring/queue or WebM slots. This helper is
 * shared by initial startup and HOLD -> RESUME so resuming cannot accidentally
 * append snapshot-time bytes to either side of the captured boundary.
 */
function installFreshReplayStorage(generation: number): boolean {
  const format = recorderFormat
  if (
    generation !== captureGeneration ||
    !stream?.active ||
    format === null ||
    activeRecorder !== null ||
    replayRing !== null ||
    ingestQueue !== null ||
    webmRing !== null
  ) {
    return false
  }
  replayPixelClockPresentedSamples = []
  if (format.strategy === 'fragmented-mp4') {
    // The normal Windows path constructs exactly one encoder at a time.
    const ring = new FragmentedMp4Ring(segmentMs, VIDEO_BITS_PER_SECOND)
    replayRing = ring
    ingestQueue = new BoundedBlobIngestQueue<RecorderIngestPayload>(
      ring.stats().retainedBudgetBytes,
      (bytes, payload) => {
        if (
          payload.generation !== captureGeneration ||
          replayRing !== payload.ring
        ) {
          return
        }
        const completedFragments = payload.ring.pushBytes(
          bytes,
          payload.endAtMs,
        )
        if (completedFragments > 0) {
          payload.session.lastFragmentAtMs = payload.endAtMs
        }
      },
      (error) => {
        failCapture(
          `fragmented MP4 ingest failed: ${describe(error)}`,
          generation,
        )
      },
    )
    startRecorder(generation)
    return activeRecorder !== null
  } else {
    // Only fallback runtimes pay for two encoders. Each slot is a complete
    // bounded WebM session; Matroska/AVC can never reach this branch because
    // pickRecorderFormat deliberately skips that illegal container/name pair.
    const fallback = new WebmDualSlotRing({
      generation,
      segmentMs,
      mimeType: format.mimeType,
      timesliceMs: WEBM_CHUNK_TIMESLICE_MS,
      stopTimeoutMs: RECORDER_STOP_TIMEOUT_MS,
      timers: {
        now: () => performance.now(),
        set: (callback, delayMs) => window.setTimeout(callback, delayMs),
        clear: (handle) => window.clearTimeout(handle as number),
      },
      createRecorder: () => createRecorder(format),
      discardRecorderOutput: simulatePrimaryNoFrames,
      onBytes: noteRecorderBytes,
      onFailure: failCapture,
    })
    webmRing = fallback
    fallback.start()
    return webmRing === fallback
  }
}

/**
 * Releases every byte owner from the epoch that ended at the replay request.
 * The live MediaStream, cadence sampler and context clock deliberately survive.
 */
function discardHeldReplayStorage(): void {
  ingestQueue?.cancel()
  ingestQueue = null
  replayRing?.clear()
  replayRing = null
  const fallback = webmRing
  webmRing = null
  fallback?.clear()
}

function enterReplayHold(requestId: string, requestGeneration: number): boolean {
  if (
    requestGeneration !== captureGeneration ||
    !stream?.active ||
    replayHold !== null
  ) {
    return false
  }
  if (replayResumeTokens.consume(requestId, requestGeneration)) {
    // Main sends RESUME only after the snapshot attempt has left its `finally`.
    // If that message overtook this HOLD, snapshot-time bytes are already safe
    // to discard and a new empty epoch can start without waiting 20 seconds.
    discardHeldReplayStorage()
    if (!installFreshReplayStorage(requestGeneration)) {
      failCapture(
        'pre-resumed replay could not start a fresh recorder boundary',
        requestGeneration,
      )
    }
    return true
  }
  const hold: ReplayHold = {
    requestId,
    generation: requestGeneration,
    watchdog: undefined,
  }
  replayHold = hold
  hold.watchdog = window.setTimeout(() => {
    recorderQueue = recorderQueue
      .catch(() => {
        // A failed capture request must not strand a later watchdog resume.
      })
      .then(() => {
        if (resumeHeldReplay(requestId, requestGeneration, 'watchdog')) {
          console.warn(
            `[capture] display ${startPayload?.displayId ?? '?'}: replay HOLD ${requestId} ` +
              `was not resumed within ${REPLAY_HOLD_WATCHDOG_MS} ms; started an empty boundary`,
          )
        }
      })
  }, REPLAY_HOLD_WATCHDOG_MS)
  return true
}

function resumeHeldReplay(
  requestId: string,
  requestGeneration: number,
  owner: 'main' | 'watchdog',
): boolean {
  const hold = replayHold
  if (
    hold === null ||
    hold.requestId !== requestId ||
    hold.generation !== requestGeneration
  ) {
    return false
  }
  window.clearTimeout(hold.watchdog)
  replayHold = null
  discardHeldReplayStorage()
  if (requestGeneration !== captureGeneration || !stream?.active) return true
  if (!installFreshReplayStorage(requestGeneration)) {
    failCapture(
      `replay ${owner} resume could not start a fresh recorder boundary`,
      requestGeneration,
    )
  }
  return true
}

function createRecorder(format: RecorderFormat): MediaRecorder {
  const options: MediaRecorderOptions & {
    videoKeyFrameIntervalDuration?: number
  } = {
    mimeType: format.mimeType,
    videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
    ...(format.strategy === 'fragmented-mp4'
      ? {
          // Chromium's MP4 muxer flushes a moof only at an IDR. A timeslice
          // without a matching keyframe request therefore produced one
          // retention-sized fragment under sparse delivery; the honest whole-fragment
          // privacy cutoff then had to discard that entire overlapping epoch.
          videoKeyFrameIntervalDuration: currentMp4FragmentIntervalMs(),
        }
      : {}),
  }
  return new MediaRecorder(stream!, options)
}

function startRecorder(generation: number): void {
  const format = recorderFormat
  const ring = replayRing
  const queue = ingestQueue
  if (
    generation !== captureGeneration ||
    !stream ||
    !stream.active ||
    format === null ||
    format.strategy !== 'fragmented-mp4' ||
    ring === null ||
    queue === null
  ) {
    return
  }
  let recorder: MediaRecorder
  try {
    recorder = createRecorder(format)
  } catch (err) {
    failCapture(`MediaRecorder unavailable: ${describe(err)}`, generation)
    return
  }
  const session: ActiveRecorder = {
    recorder,
    generation,
    ingestQueue: queue,
    startedAtMs: performance.now(),
    clockSamples: [],
    hadOutput: false,
    lastFragmentAtMs: null,
    flushAtMs: null,
    flushBatch: null,
    flushBatchOverflowed: false,
    flushTimer: undefined,
  }
  recorder.ondataavailable = (event) => {
    // Test path (--simulate-no-frames): behave exactly like a recorder whose
    // desktop capturer delivers nothing — the encoder output is dropped on the
    // floor, so the buffer stays empty and no evidence ever accumulates.
    if (simulatePrimaryNoFrames()) return
    noteRecorderBytes(event.data.size)
    if (event.data.size === 0) return
    session.hadOutput = true
    // stop() changes the recorder to inactive before it emits the final data
    // event. Only that final flush is anchored to the request instant; an
    // already-queued ordinary timeslice keeps its own delivery time.
    const deliveredAtMs = performance.now()
    if (session.clockSamples.length < 8) {
      session.clockSamples.push({
        recorderStartedAtMs: session.startedAtMs,
        eventTimeStampMs: event.timeStamp,
        blobTimecodeMs: event.timecode,
        deliveredAtMs,
        ...(latestPresentedFrame === null
          ? {}
          : {
              latestPresentationTimeMs: latestPresentedFrame.presentationTimeMs,
              ...(latestPresentedFrame.captureTimeMs === undefined
                ? {}
                : { latestCaptureTimeMs: latestPresentedFrame.captureTimeMs }),
              latestMediaTimeMs: latestPresentedFrame.mediaTimeMs,
            }),
      })
    }
    const endAtMs = recorderChunkEndAtMs(
      event.timeStamp,
      deliveredAtMs,
      session.flushAtMs,
      recorder.state === 'inactive',
    )
    const blob = event.data
    if (session.flushAtMs !== null && recorder.state === 'inactive') {
      // stop() can overtake a timeslice task already queued by MediaRecorder.
      // Stage every data event from that point through the final flush; once
      // onstop proves the batch is complete, one parser call backfills each
      // fragment by its encoded duration from the exact capture instant.
      const batch = session.flushBatch
      if (batch === null || !batch.append(blob)) {
        session.flushBatchOverflowed = true
        batch?.cancel()
      }
      return
    }
    queueRecorderBlob(blob, endAtMs, session, ring, queue)
  }
  recorder.onerror = () => {
    if (activeRecorder !== session) return
    failCapture('MediaRecorder error', session.generation)
  }
  activeRecorder = session
  try {
    recorder.start(currentMp4FragmentIntervalMs())
  } catch (err) {
    failCapture(`MediaRecorder start failed: ${describe(err)}`, generation)
    return
  }
  scheduleMaintenanceFlush(session)
}

function queueRecorderBlob(
  blob: Blob,
  endAtMs: number,
  session: ActiveRecorder,
  ring: FragmentedMp4Ring,
  queue: BoundedBlobIngestQueue<RecorderIngestPayload>,
): void {
  const queued = queue.enqueue(blob, {
    endAtMs,
    generation: session.generation,
    ring,
    session,
  })
  if (!queued) {
    failCapture(
      'fragmented MP4 ingest budget exceeded; refusing to skip bytes in the recorder stream',
      session.generation,
    )
  }
}

function scheduleMaintenanceFlush(
  session: ActiveRecorder,
  delayMs = Math.max(currentMp4FragmentIntervalMs(), segmentMs),
): void {
  window.clearTimeout(session.flushTimer)
  session.flushTimer = window.setTimeout(() => {
    session.flushTimer = undefined
    recorderQueue = recorderQueue
      .catch(() => {
        // A failed request must not disable bounded maintenance flushes.
      })
      .then(async () => {
        const nowMs = performance.now()
        const maintenance = recorderMaintenanceDecision({
          nowMs,
          startedAtMs: session.startedAtMs,
          lastFragmentAtMs: session.lastFragmentAtMs,
          intervalMs: Math.max(currentMp4FragmentIntervalMs(), segmentMs),
          minimumDelayMs: currentMp4FragmentIntervalMs(),
          sessionActive: activeRecorder === session,
        })
        if (maintenance.action === 'retired') return
        if (maintenance.action === 'reschedule') {
          scheduleMaintenanceFlush(session, maintenance.delayMs)
          return
        }
        await flushRecorderSession(session, nowMs)
      })
      .catch((err: unknown) => {
        console.error(
          `[capture] display ${startPayload?.displayId ?? '?'}: maintenance flush failed: ${describe(err)}`,
        )
        failCapture(
          `MediaRecorder maintenance flush failed: ${describe(err)}`,
          session.generation,
        )
      })
  }, Math.max(currentMp4FragmentIntervalMs(), delayMs))
}

/**
 * Flush one exact recorder session into the ring.
 *
 * Both the maintenance timer and replay requests enter through recorderQueue.
 * Identity is checked as well: a timer queued for an old session becomes a
 * no-op after a replay request has already replaced or held that session.
 * A full-native snapshot requests `restartAfterFlush=false`; its replacement
 * starts only after RESUME has discarded this complete ring epoch.
 */
async function flushRecorderSession(
  session: ActiveRecorder,
  endAtMs: number,
  restartAfterFlush = true,
): Promise<boolean> {
  const ring = replayRing
  const queue = session.ingestQueue
  if (
    activeRecorder !== session ||
    ring === null ||
    ingestQueue !== queue
  ) {
    return false
  }
  const recorder = session.recorder
  window.clearTimeout(session.flushTimer)
  session.flushTimer = undefined
  session.flushAtMs = endAtMs
  session.flushBatch = queue.createBatch()
  session.flushBatchOverflowed = false
  activeRecorder = null
  let replacementStarted = !restartAfterFlush
  const startReplacement = (): void => {
    if (!restartAfterFlush) return
    if (session.generation !== captureGeneration || !stream?.active) return
    if (restartAfterFlush) startRecorder(session.generation)
    replacementStarted = activeRecorder?.generation === session.generation
  }
  if (recorder.state !== 'inactive') {
    // stop() flushes the final dataavailable before firing onstop.
    const stopped = await stopRecorderWithDeadline(
      recorder,
      RECORDER_STOP_TIMEOUT_MS,
      {
        set: (callback, delayMs) => window.setTimeout(callback, delayMs),
        clear: (handle) => window.clearTimeout(handle as number),
      },
      // A timeout/throw abandons this failed flush and severs the recorder ->
      // Blob closure chain immediately; a stop event that never arrives must
      // not retain the old session forever.
      () => {
        session.flushBatch?.cancel()
        session.flushBatch = null
        releaseRecorderReferences(recorder, [])
      },
    )
    if (!stopped) {
      // If stop() threw before accepting the request, there is no replacement
      // for teardown to find; put the old recorder back so recovery can stop it.
      if (
        restartAfterFlush &&
        !replacementStarted &&
        session.generation === captureGeneration
      ) {
        activeRecorder = session
      }
      failCapture(
        `MediaRecorder stop timed out after ${RECORDER_STOP_TIMEOUT_MS} ms`,
        session.generation,
      )
      return false
    }
  }
  const flushBatch = session.flushBatch
  session.flushBatch = null
  if (session.flushBatchOverflowed || flushBatch === null) {
    flushBatch?.cancel()
    releaseRecorderReferences(recorder, [])
    failCapture(
      'recorder stop batch exceeded the bounded ingest budget; refusing a discontinuous MP4 stream',
      session.generation,
    )
    return false
  }
  const committed = await commitRecorderBatchBeforeReplacement(
    queue,
    flushBatch,
    {
      endAtMs,
      generation: session.generation,
      ring,
      session,
    },
    startReplacement,
    session.hadOutput,
  )
  releaseRecorderReferences(recorder, [])
  if (
    !committed ||
    session.generation !== captureGeneration ||
    replayRing !== ring ||
    ingestQueue !== queue
  ) {
    if (!committed && session.generation === captureGeneration) {
      failCapture(
        'recorder stop batch could not be committed as one contiguous MP4 session',
        session.generation,
      )
    }
    return false
  }
  if (restartAfterFlush && !replacementStarted) {
    failCapture(
      'replacement MediaRecorder did not start after the prior session committed',
      session.generation,
    )
    return false
  }
  return true
}

function replayPixelClockTargets(
  samples: readonly ReplayPixelClockPresentedSample[],
  approximateOriginMs: number,
  durationMs: number,
  encodedSamples: readonly Fmp4VideoSample[],
): Fmp4VideoSample[] {
  const candidates = samples
    .map((sample) => sample.presentedAtMs - approximateOriginMs)
    .filter(
      (ptsMs) =>
        Number.isFinite(ptsMs)
        && ptsMs >= 0
        && ptsMs < durationMs,
    )
    .sort((left, right) => left - right)
  const unique = candidates.filter(
    (ptsMs, index) =>
      index === 0
      || Math.abs(ptsMs - (candidates[index - 1] ?? ptsMs)) >= 1,
  )
  const selected: number[] = []
  const baseCount = Math.min(
    unique.length,
    REPLAY_PIXEL_CLOCK_BASE_SAMPLE_LIMIT,
  )
  for (
    let index = 0;
    index < baseCount;
    index += 1
  ) {
    const sourceIndex = Math.round(
      (index * (unique.length - 1))
      / Math.max(1, baseCount - 1),
    )
    const value = unique[sourceIndex]
    if (value !== undefined) selected.push(value)
  }
  const orderedEncoded = encodedSamples
    .filter(
      (sample) =>
        Number.isFinite(sample.presentationTimeMs)
        && Number.isFinite(sample.durationMs)
        && sample.presentationTimeMs >= 0
        && sample.presentationTimeMs < durationMs
        && sample.durationMs > 0,
    )
    .sort(
      (left, right) =>
        left.presentationTimeMs - right.presentationTimeMs,
    )
  const baseIndexes = selected
    .map((approximatePtsMs) => {
      let winner = -1
      let distance = Number.POSITIVE_INFINITY
      for (let index = 0; index < orderedEncoded.length; index += 1) {
        const sample = orderedEncoded[index]
        if (sample === undefined) continue
        const candidateDistance = Math.abs(
          sample.presentationTimeMs - approximatePtsMs,
        )
        if (candidateDistance < distance) {
          winner = index
          distance = candidateDistance
        }
      }
      return winner
    })
    .filter(
      (index, position, all) =>
        index >= 0 && all.indexOf(index) === position,
    )
  const targets: Fmp4VideoSample[] = []
  const retained = new Set<Fmp4VideoSample>()
  // Try the wall-hint candidate for every observed frame first, then expand
  // one declared sample at a time. The parser — not requested FPS — supplies
  // every target PTS, so variable cadence and composition offsets remain exact.
  for (const sampleOffset of [0, -1, 1, -2, 2, -3, 3]) {
    for (const baseIndex of baseIndexes) {
      const target = orderedEncoded[baseIndex + sampleOffset]
      if (target === undefined || retained.has(target)) continue
      retained.add(target)
      targets.push(target)
      if (targets.length >= REPLAY_PIXEL_CLOCK_DECODE_SAMPLE_LIMIT) {
        return targets
      }
    }
  }
  return targets
}

function waitForReplayMetadata(
  video: HTMLVideoElement,
  timeoutMs: number,
): Promise<boolean> {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    let settled = false
    let timer: number | undefined
    const finish = (loaded: boolean): void => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      video.removeEventListener('loadedmetadata', onLoaded)
      video.removeEventListener('error', onError)
      resolve(loaded)
    }
    const onLoaded = (): void => finish(true)
    const onError = (): void => finish(false)
    video.addEventListener('loadedmetadata', onLoaded, { once: true })
    video.addEventListener('error', onError, { once: true })
    timer = window.setTimeout(() => finish(false), timeoutMs)
  })
}

function seekReplayPresentation(
  video: HTMLVideoElement,
  targetSeconds: number,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let timer: number | undefined
    const finish = (sought: boolean): void => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('error', onError)
      resolve(sought)
    }
    const onSeeked = (): void => finish(true)
    const onError = (): void => finish(false)
    video.addEventListener('seeked', onSeeked, { once: true })
    video.addEventListener('error', onError, { once: true })
    try {
      video.currentTime = targetSeconds
    } catch {
      finish(false)
      return
    }
    timer = window.setTimeout(() => finish(false), timeoutMs)
  })
}

async function decodeReplayPixelClockSamples(
  buffer: ArrayBuffer,
  mimeType: string,
  approximateOriginMs: number,
  durationMs: number,
  presented: readonly ReplayPixelClockPresentedSample[],
): Promise<ReplayPixelClockDecodedSample[]> {
  const parsed = mimeType.toLowerCase().startsWith('video/mp4')
    ? enumerateFmp4VideoSamples(buffer)
    : {
        status: 'invalid' as const,
        reason: 'unsupported-container',
        detail: 'exact sample PTS parsing is available only for fragmented MP4',
      }
  const encodedSamples =
    parsed.status === 'ok' && parsed.tracks.length === 1
      ? parsed.tracks[0]?.samples ?? []
      : []
  const targets = replayPixelClockTargets(
    presented,
    approximateOriginMs,
    durationMs,
    encodedSamples,
  )
  const relative = presented.map(
    (sample) => sample.presentedAtMs - approximateOriginMs,
  )
  replayPixelClockDecodeDiagnostics = {
    stage: 'targets',
    mimeType,
    bytes: buffer.byteLength,
    approximateOriginMs,
    durationMs,
    presentedSamples: presented.length,
    parsedSampleCount: encodedSamples.length,
    parsedTrackCount: parsed.status === 'ok' ? parsed.tracks.length : 0,
    parserStatus: parsed.status,
    ...(parsed.status === 'invalid'
      ? {
          parserReason: parsed.reason,
          parserDetail: parsed.detail,
        }
      : {}),
    targetCount: targets.length,
    relativeMinMs:
      relative.length === 0 ? undefined : Math.min(...relative),
    relativeMaxMs:
      relative.length === 0 ? undefined : Math.max(...relative),
  }
  if (targets.length === 0) {
    replayPixelClockDecodeDiagnostics = {
      ...replayPixelClockDecodeDiagnostics,
      stage: 'no-in-range-targets',
    }
    console.info(
      `[capture] display ${startPayload?.displayId ?? '?'}: ` +
        `replay pixel decoder has no in-range targets ` +
        `${JSON.stringify({
          approximateOriginMs,
          durationMs,
          presentedSamples: presented.length,
          relativeMinMs:
            relative.length === 0 ? undefined : Math.min(...relative),
          relativeMaxMs:
            relative.length === 0 ? undefined : Math.max(...relative),
        })}`,
    )
    return []
  }
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.style.position = 'fixed'
  video.style.width = '1px'
  video.style.height = '1px'
  video.style.opacity = '0'
  video.style.pointerEvents = 'none'
  const url = URL.createObjectURL(new Blob([buffer], { type: mimeType }))
  const decoded: ReplayPixelClockDecodedSample[] = []
  const startedAt = performance.now()
  let seekAttempts = 0
  let seekCallbacks = 0
  try {
    document.body.appendChild(video)
    video.src = url
    if (
      !await waitForReplayMetadata(
        video,
        REPLAY_PIXEL_CLOCK_DECODE_DEADLINE_MS,
      )
    ) {
      replayPixelClockDecodeDiagnostics = {
        ...replayPixelClockDecodeDiagnostics,
        stage: 'metadata-unavailable',
        readyState: video.readyState,
        networkState: video.networkState,
        mediaErrorCode: video.error?.code,
        mediaErrorMessage: video.error?.message,
      }
      console.info(
        `[capture] display ${startPayload?.displayId ?? '?'}: ` +
          `replay pixel decoder metadata unavailable ` +
          `${JSON.stringify({
            mimeType,
            bytes: buffer.byteLength,
            targets: targets.length,
            readyState: video.readyState,
            networkState: video.networkState,
            mediaErrorCode: video.error?.code,
            mediaErrorMessage: video.error?.message,
          })}`,
      )
      return []
    }
    for (const target of targets) {
      const remainingMs =
        REPLAY_PIXEL_CLOCK_DECODE_DEADLINE_MS
        - (performance.now() - startedAt)
      if (remainingMs <= 0) break
      seekAttempts += 1
      // Seek just inside the exact declared sample interval. This affects only
      // which decoded frame is selected; the clock still uses the sample's
      // integer-timescale PTS below.
      const sampleInsetMs = Math.min(0.5, target.durationMs / 4)
      const sought = await seekReplayPresentation(
        video,
        Math.max(
          0.000_001,
          Math.min(
            (target.presentationTimeMs + sampleInsetMs) / 1_000,
            video.duration - 0.000_001,
          ),
        ),
        Math.min(REPLAY_PIXEL_CLOCK_SEEK_DEADLINE_MS, remainingMs),
      )
      if (!sought) continue
      seekCallbacks += 1
      const ptsMs = target.presentationTimeMs
      if (
        decoded.some((sample) => Math.abs(sample.ptsMs - ptsMs) < 0.5)
      ) {
        continue
      }
      try {
        decoded.push({
          ptsMs,
          fingerprint: replayPixelClockFingerprint(video),
        })
      } catch {
        // A single unreadable decoded frame is a missing observation.
      }
    }
    if (decoded.length === 0) {
      console.info(
        `[capture] display ${startPayload?.displayId ?? '?'}: ` +
          `replay pixel decoder produced no frames ` +
          `${JSON.stringify({
            mimeType,
            bytes: buffer.byteLength,
            targets: targets.length,
            duration: video.duration,
            readyState: video.readyState,
            networkState: video.networkState,
            seekAttempts,
            seekCallbacks,
            elapsedMs: Math.round(performance.now() - startedAt),
            mediaErrorCode: video.error?.code,
            mediaErrorMessage: video.error?.message,
          })}`,
      )
    }
    replayPixelClockDecodeDiagnostics = {
      ...replayPixelClockDecodeDiagnostics,
      stage: decoded.length === 0 ? 'no-decoded-frames' : 'decoded',
      mediaDurationSeconds: video.duration,
      readyState: video.readyState,
      networkState: video.networkState,
      seekAttempts,
      seekCallbacks,
      decodedSamples: decoded.length,
      elapsedMs: Math.round(performance.now() - startedAt),
      mediaErrorCode: video.error?.code,
      mediaErrorMessage: video.error?.message,
    }
    return decoded
  } finally {
    video.pause()
    video.removeAttribute('src')
    video.load()
    video.remove()
    URL.revokeObjectURL(url)
  }
}

async function measureReplayPixelClock(
  buffer: ArrayBuffer,
  mimeType: string,
  approximateOriginMs: number,
  durationMs: number,
): Promise<ReplayPixelClockDecision> {
  const presented = replayPixelClockPresentedSamples.slice()
  const decoded = await decodeReplayPixelClockSamples(
    buffer,
    mimeType,
    approximateOriginMs,
    durationMs,
    presented,
  )
  const decision = decideReplayPixelClock(presented, decoded)
  const diagnosedDecision = {
    ...decision,
    ...(replayPixelClockDecodeDiagnostics === undefined
      ? {}
      : { decoder: replayPixelClockDecodeDiagnostics }),
  }
  console.info(
    `[capture] display ${startPayload?.displayId ?? '?'}: ` +
      `replay pixel clock ${JSON.stringify(diagnosedDecision)}`,
  )
  return diagnosedDecision
}

function replayClockAnchorsWithinDuration(
  clock: ReplayPixelClockDecision,
  durationMs: number,
): readonly ReplayPixelClockAnchor[] | undefined {
  if (
    clock.status !== 'measured'
    || clock.clockAnchors === undefined
    || !Number.isFinite(durationMs)
    || durationMs < 0
  ) {
    return undefined
  }
  const bounded = clock.clockAnchors.filter(
    (anchor) =>
      Number.isFinite(anchor.ptsMs)
      && anchor.ptsMs >= 0
      && anchor.ptsMs <= durationMs,
  )
  return bounded.length >= 2 ? bounded : undefined
}

function measuredReplaySourceClockAnchors(
  clock: ReplayPixelClockDecision,
  durationMs: number,
): CaptureReplayResultPayload['sourceClockAnchors'] {
  const sourceMediaTimeOriginMs =
    sourceLatencyCalibration?.presentation?.sourceMediaTimeOriginMs
  const anchors = replayClockAnchorsWithinDuration(clock, durationMs)
  const observedCaptureAnchors =
    anchors === undefined
      ? undefined
      : sourceClockAnchorsFromObservedCaptureTime(anchors)
  if (observedCaptureAnchors !== undefined) {
    return observedCaptureAnchors
  }
  if (
    anchors === undefined
    || typeof sourceMediaTimeOriginMs !== 'number'
    || !Number.isFinite(sourceMediaTimeOriginMs)
  ) {
    return undefined
  }
  return sourceClockAnchorsFromMeasuredMediaTime(
    anchors,
    sourceMediaTimeOriginMs,
  )
}

async function handleReplayRequest(
  request: CaptureReplayRequestPayload,
  requestGeneration: number,
): Promise<void> {
  const { requestId, holdAfterCapture = false } = request
  const format = recorderFormat
  if (
    requestGeneration !== captureGeneration ||
    !stream?.active ||
    format === null
  ) {
    sendEmptyReplay(requestId, format)
    return
  }
  const requestedAt = performance.now()
  // The first proof heartbeat can land just as cadence leaves its warm-up
  // window. Refresh it at the capture boundary before the replay result crosses
  // IPC, so the persisted manifest describes the bytes being returned rather
  // than an earlier, unavailable measurement.
  if (framesProven) {
    sendCurrentFrameProof(evidenceBytes, deliveredFrames() ?? 0)
  }
  let buffer = new ArrayBuffer(0)
  let durationMs = 0
  let originMs: number | undefined
  let clockAnchors: CaptureReplayResultPayload['clockAnchors']
  let sourceClockAnchors: CaptureReplayResultPayload['sourceClockAnchors']
  let ringDiagnostics: CaptureReplayResultPayload['ringDiagnostics']
  let boundaryReady = false
  if (format.strategy === 'dual-slot-webm') {
    const fallback = webmRing
    if (fallback !== null) {
      const replay = await fallback.capture(requestedAt)
      // WebM cannot be legally spliced. Its replacement slots may run during
      // the snapshot, but RESUME disposes the whole owner before starting a
      // brand-new dual-slot epoch, so those bytes enter neither pack.
      boundaryReady = true
      if (replay !== null) {
        buffer = replay.buffer
        durationMs = replay.durationMs
        const clock = await measureReplayPixelClock(
          buffer,
          format.mimeType,
          wallComparableTimeMs(performance.timeOrigin, replay.startAtMs),
          durationMs,
        )
        originMs = clock.status === 'measured' ? clock.originMs : undefined
        const measuredClockAnchors =
          replayClockAnchorsWithinDuration(clock, durationMs)
        clockAnchors =
          measuredClockAnchors === undefined
            ? undefined
            : measuredClockAnchors.map((anchor) => ({
                ptsMs: anchor.ptsMs,
                wallMs: anchor.presentedAtMs,
              }))
        sourceClockAnchors = measuredReplaySourceClockAnchors(
          clock,
          durationMs,
        )
      }
    }
  } else {
    const session = activeRecorder
    const ring = replayRing
    if (session !== null && ring !== null) {
      const flushed = await flushRecorderSession(
        session,
        requestedAt,
        !holdAfterCapture,
      )
      if (flushed) {
        boundaryReady = true
        const replay = ring.assemble(requestedAt)
        const stats = ring.stats()
        ringDiagnostics = {
          retainedFragmentCount: stats.fragmentCount,
          retainedBytes: stats.retainedBytes,
          retainedDurationMs: stats.retainedDurationMs,
          selectedFragmentCount: replay?.fragmentCount ?? 0,
          // Sent, not logged here: a renderer console line does not reach the
          // main log, which is where a capture is actually diagnosed from.
          ringTiming: stats.timing,
          ...(sourceLatencyCalibration === undefined
            ? {}
            : { sourceLatencyCalibration }),
          ...(session.clockSamples.length === 0
            ? {}
            : { clockSamples: session.clockSamples }),
        }
        buffer = replay?.buffer ?? new ArrayBuffer(0)
        durationMs = replay?.durationMs ?? 0
        if (replay !== null) {
          // The ring's wall-derived start is only a bounded search hint. It is
          // never published as a measured clock: the only accepted origin is
          // the same decoded frame observed once on each time axis.
          const clock = await measureReplayPixelClock(
            buffer,
            format.mimeType,
            wallComparableTimeMs(performance.timeOrigin, replay.startAtMs),
            durationMs,
          )
          // Spreading a possibly-undefined base would have widened every
          // required field to optional and silently dropped the ring's own
          // numbers on any path where the flush had not produced them. It is
          // reachable only after an assembled replay, which is where
          // ringDiagnostics is set — so say that, rather than relying on it.
          if (ringDiagnostics !== undefined) {
            ringDiagnostics = { ...ringDiagnostics, replayPixelClock: clock }
          }
          originMs =
            clock.status === 'measured' ? clock.originMs : undefined
          const measuredClockAnchors =
            replayClockAnchorsWithinDuration(clock, durationMs)
          clockAnchors =
            measuredClockAnchors === undefined
              ? undefined
              : measuredClockAnchors.map((anchor) => ({
                  ptsMs: anchor.ptsMs,
                  wallMs: anchor.presentedAtMs,
                }))
          sourceClockAnchors = measuredReplaySourceClockAnchors(
            clock,
            durationMs,
          )
        }
      }
      // A rejected/timed-out stop is not a capture instant. Leaving buffer
      // empty prevents older bytes being presented as though they ended now.
    }
  }
  if (requestGeneration !== captureGeneration) {
    sendEmptyReplay(requestId, format)
    return
  }
  // Test path (--simulate-slow-replay): the recorder really was stopped and
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
  if (requestGeneration !== captureGeneration) {
    sendEmptyReplay(requestId, format)
    return
  }
  if (
    holdAfterCapture &&
    boundaryReady &&
    !enterReplayHold(requestId, requestGeneration)
  ) {
    // Do not claim a frozen boundary when another request owns it.
    sendEmptyReplay(requestId, format)
    return
  }
  // WHAT PRODUCED THESE BYTES TRAVELS WITH THEM (#135). The heartbeat above is
  // a liveness proof and is gated on one; this is provenance for the replay
  // being handed over, and it is owed whether or not liveness was ever proven.
  // Attached only to the branch that returns a replay: a pack with no replay
  // must declare no cadence at all (SPEC §5.3).
  const replayCadence = cadenceSummary()
  // A container header with no frames in it is NOT a replay: handing those few
  // hundred bytes back would put an undecodable replay.mp4 in the pack and let
  // every reader believe a recording exists. Below the evidence bar the honest
  // answer is the same one a dead recorder gives — no footage.
  window.captureBridge.sendReplayResult(
    requestGeneration === captureGeneration &&
      buffer.byteLength >= EVIDENCE_MIN_BYTES
      ? {
          requestId,
          buffer,
          durationMs,
          ...(originMs === undefined ? {} : { originMs }),
          ...(clockAnchors === undefined ? {} : { clockAnchors }),
          ...(sourceClockAnchors === undefined
            ? {}
            : { sourceClockAnchors }),
          mimeType: format.mimeType,
          replayFile: format.replayFile,
          ...(ringDiagnostics === undefined ? {} : { ringDiagnostics }),
          ...(replayCadence === null ? {} : { cadence: replayCadence }),
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

function sendEmptyReplay(
  requestId: string,
  format: RecorderFormat | null,
): void {
  window.captureBridge.sendReplayResult({
    requestId,
    buffer: new ArrayBuffer(0),
    durationMs: 0,
    mimeType: format?.mimeType ?? 'video/webm',
    replayFile: format?.replayFile ?? 'replay.webm',
  })
}

window.captureBridge.onStart((payload) => {
  // A fresh command is a new recovery episode and cancels any retry owned by
  // the prior command through startCapture()->teardown().
  retried = false
  nativeFallbackCircuitOpen = false
  void startCapture(payload)
})
window.captureBridge.onNativeFallbackFrame((payload) => {
  if (payload.sessionId !== nativeFallbackSessionId) return
  void queueNativeFallbackFrame(payload)
})
window.captureBridge.onNativeFallbackError((payload) => {
  if (payload.sessionId === nativeFallbackSessionId) {
    terminalCaptureFailure(
      `native replay fallback stopped: ${payload.message}`,
    )
    return
  }
  // The helper can emit its first JPEG and exit before the invoke reply assigns
  // nativeFallbackSessionId. Retain that one startup race by session id; truly
  // stale errors outside an outstanding start are ignored.
  nativeFallbackStartupErrors.observe(payload)
})
window.captureBridge.onRequestReplay((request) => {
  // Capture ownership is fixed when IPC arrives, not when an earlier queued
  // stop/assembly eventually lets this callback run.
  const requestGeneration = captureGeneration
  const requestFormat = recorderFormat
  recorderQueue = recorderQueue
    .catch(() => {
      // One failed request must not block every later capture.
    })
    .then(() => {
      if (requestGeneration !== captureGeneration) {
        sendEmptyReplay(request.requestId, requestFormat)
        return
      }
      return handleReplayRequest(request, requestGeneration)
    })
})
window.captureBridge.onResumeReplay(({ requestId }) => {
  const requestGeneration = captureGeneration
  // Record before touching the async queue. Normal FIFO consumes this after the
  // held recorder resumes; if IPC delivery is reversed, enterReplayHold consumes
  // it instead and starts the already-snapshotted fresh boundary immediately.
  replayResumeTokens.note(requestId, requestGeneration)
  recorderQueue = recorderQueue
    .catch(() => {
      // A rejected request must not strand the held recorder boundary.
    })
    .then(() => {
      if (resumeHeldReplay(requestId, requestGeneration, 'main')) {
        replayResumeTokens.consume(requestId, requestGeneration)
      }
    })
})
