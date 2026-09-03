// Main-process side of capture: owns the hidden recorder window SET (one per
// connected display in "all"/"cursor" mode, exactly one in fixed mode), routes
// each window's getDisplayMedia call to its assigned display, takes per-display
// screenshots, handles display hotplug, and bridges replay request/response.
//
// CPU note (GOAL "Multi-Monitor Support"): every capture window normally owns
// one active MP4 MediaRecorder over one display stream. Only runtimes without
// MP4/AVC use the legal WebM fallback's two staggered encoders.
// "all" and "cursor" run the SAME recorder set — one encoder PER connected
// display so the last replay window exists wherever the trigger lands.
// Capturing all displays therefore costs no additional recorder at trigger
// time; what "all" adds is EXPORT work (one more snapshot + replay fetch + file
// write per display). Fixed mode runs one encoder total (lowest CPU).
import path from 'node:path'
import { BrowserWindow, desktopCapturer, ipcMain, screen, session, webContents } from 'electron'
import type { Display, IpcMainEvent, WebContents } from 'electron'
import { REPLAY_TIMEOUT_MS } from '../shared/captureTimeouts'
import { IPC } from '../shared/ipc'
import { tickSurfaces } from './context/runtime'
import type {
  CaptureDxgiTimingReferencePayload,
  CaptureFramesPayload,
  CaptureNativeFallbackFramePayload,
  CaptureNativeFallbackRequest,
  CaptureNativeFallbackStartPayload,
  CaptureReadyPayload,
  CaptureReplayRequestPayload,
  CaptureReplayResumePayload,
  CaptureReplayResultPayload,
  CaptureStartPayload,
  RecorderFailureReason,
  CaptureTickPayload,
} from '../shared/ipc'
import {
  MIN_CAPTURE_FPS,
  normalizeCaptureFps,
  type Settings,
} from '../shared/types'
import { CaptureCadenceRegistry } from '../shared/captureCadence'
import { logError, logInfo, logWarn } from './log'
import {
  captureRecorderSignature,
  isCurrentRecorderResource,
  recorderTickOwnership,
  selectRecorderTickOwner,
} from './captureTickOwnership'
import type { RecorderTickOwnership } from './captureTickOwnership'
import {
  selectDisplayMediaSource,
  shouldSimulateNoFrames,
} from './displayMediaPolicy'
import {
  NativeReplayFallbackManager,
  type NativeReplayFrame,
} from './nativeReplayFallback'
import {
  captureDxgiTimingReference,
  dxgiTimingReferenceToIpc,
} from './dxgiTimingReference'

const HOTPLUG_DEBOUNCE_MS = 1_000
// A recorder window loading only proves that its renderer started, and
// MediaRecorder.start() succeeding proves only that an encoder exists (issue
// #39). The renderer therefore reports frame evidence itself, on
// IPC.captureFrames for proof and IPC.captureError with `no-frames` for its
// absence — both within its own few-second deadline.
//
// This probe is what is left: the BACKSTOP for a renderer that says neither. It
// is deliberately no longer the fast path — asking for a replay stops and
// restarts a recorder, and doing that to a healthy buffer on every launch cost
// footage for nothing.
//
// It is armed from capture:ready, i.e. from the renderer's OWN clock, because
// that is the only anchor that keeps it behind the renderer's verdict: a
// machine where getDisplayMedia takes seconds to resolve (exactly the sick
// machine this is about) would otherwise have the probe overtake it and
// announce a vaguer failure first. Its value follows that verdict: the renderer
// takes two 4 s windows (EVIDENCE_STRIKES), so this has to sit past 8 s.
const RECORDER_PROBE_DELAY_MS = 10_000
// The renderer never even got a stream: nothing will anchor the probe, so this
// one runs from window creation.
const RECORDER_STARTUP_PROBE_DELAY_MS = 12_000
// Generous on purpose (issue #43). By the time main is waiting here, the
// renderer has ALREADY stopped its older slot to answer — the footage is spent.
// Giving up at three seconds bought the cost without the answer, and on the
// loaded machine #43 describes (thirty seconds of MP4 to mux, assemble and hand
// across an IPC boundary) three seconds was routinely too little. Waiting is
// free; abandoning the reply is not.
const RECORDER_PROBE_TIMEOUT_MS = REPLAY_TIMEOUT_MS
// Same bar the renderer applies to its own output (renderer/capture/capture.ts
// EVIDENCE_MIN_BYTES): a container header carries no frames, so bytes alone
// were never proof that anything was recorded.
const RECORDER_EVIDENCE_MIN_BYTES = 4096
// Bare `--simulate-slow-replay` with no value: long enough that main gives up
// waiting, which is the harder half of the test.
const SIMULATED_SLOW_REPLAY_DEFAULT_MS = 15_000

// --- The state has to keep AGREEING with reality (issue #43)
//
// Until now the only route back to 'recording' was the startup probe plus ONE
// retry. Two misses in a row — a Desktop Duplication that was busy for twenty
// seconds (#39), a probe that timed out on a loaded machine — latched 'stopped'
// for the rest of the process, and restarting the app just repeated the same
// two attempts. That is precisely the tray icon that lied THROUGH a restart on
// the user's machine while recording worked fine.
//
// Convergence is now continuous, from two independent directions:
//  - the renderer repeats its frame proof as a HEARTBEAT (renderer/capture/
//    capture.ts), so a recorder that recovers re-earns 'recording' within one
//    evidence window with no work from main at all, and
//  - this watchdog keeps attempting recovery for as long as a display is not
//    recording, with a backoff so a permanently broken display stays cheap.
//
// The other direction is deliberately NOT symmetric: a missing heartbeat never
// demotes a display. On a runtime without a delivered-frame counter a healthy
// MP4 recorder cannot prove itself between flushes (see the renderer's
// EVIDENCE_MIN_BYTES note), so silence is not evidence — acting on it would
// re-create the very false negative this issue is about. Failures still arrive
// the way they always did: capture:error, a dead renderer, a stream that ended,
// or the outcome of a real capture.
//
// --- RECOVERY MUST NOT COST THE RECORDING (issue #43, and the reason it was
// filed in the first place)
//
// Both of the watchdog's tools take something away from a running recorder:
//
//  - a PROBE is a replay request, and the renderer answers one by flushing and
//    replacing its current MediaRecorder (renderer/capture/capture.ts
//    handleReplayRequest). The bounded fragment ring survives that replacement,
//    but an unnecessary flush still costs encoder/muxer work.
//  - a REBUILD destroys the recorder window, and the whole ring buffer with it.
//
// So the rules below are about what is allowed to authorise them:
//
//  1. A probe that TIMES OUT proves nothing. #43's own scenario is a probe that
//     times out on a loaded machine while recording is perfectly fine; letting
//     that condemn a display is how a wrong state used to appear, and — once a
//     watchdog acts on the state — how the buffer would be thrown away on the
//     strength of it. Only an ANSWER counts: real bytes prove recording, and an
//     empty answer is real evidence too, because the renderer flushed its slot
//     to produce it.
//  2. A display that is provably RECORDING is never probed. Its heartbeat is
//     the evidence, and it costs nothing.
//  3. A window is only ever recreated when there is no buffer left to lose:
//     the renderer is gone/crashed, or the display is in an evidence-backed
//     'stopped'. This is exactly rebuild()'s own staleness rule, so the log can
//     never claim a recreation that did not happen.
const RECONCILE_INTERVAL_MS = 15_000
// A display that is not recording gets this long to sort itself out (renderer
// evidence, the backstop probe, the renderer's own one restart) before the
// watchdog interferes.
const RECOVERY_FIRST_DELAY_MS = 30_000
const RECOVERY_MAX_DELAY_MS = 10 * 60_000
// A display that is STOPPED and whose window is still alive gets this many
// ANSWERED probes before the window is recreated (an unanswered one is not
// evidence and is not counted — see RULE 1 at the probe).
//
// Two, not one, and the reason is three hundred lines down at the 'empty'
// outcome: a slot that was entirely muxer-buffered comes back empty on a
// PERFECTLY HEALTHY recorder. One empty answer is therefore not enough to
// justify destroying a ring buffer — it would make the ordinary MP4 case a
// coin flip. Two consecutive empties, from a renderer that flushed its muxer
// both times, is a buffer that really is not filling.
const RECOVERY_PROBES_BEFORE_REBUILD = 2

export type { RecorderFailureReason }

export type RecorderState =
  | { status: 'starting' }
  | { status: 'recording' }
  | {
      status: 'stopped'
      reason: RecorderFailureReason
      detail: string
      failedDisplayIndices?: number[]
      totalDisplays?: number
    }

type DisplayRecorderState =
  | { status: 'starting' }
  | { status: 'recording' }
  | { status: 'stopped'; reason: RecorderFailureReason; detail: string }

// display.id -> that display's hidden recorder window.
const captureWindows = new Map<number, BrowserWindow>()
// display.id -> the recorder parameters its window was built with; rebuild()
// keeps a window (and its replay buffer) when the signature is unchanged, so
// only the affected recorders restart (GOAL "Multi-Monitor Support").
const captureWindowSigs = new Map<number, string>()
// webContents.id -> display id string; the display-media handler routes by this.
const assignedDisplays = new Map<number, string>()
const nativeReplayFallback = new NativeReplayFallbackManager(
  path.join(__dirname, '../scripts/native-replay-capture.exe'),
)
let nativeReplayFallbackIpcInstalled = false
const NATIVE_PRESENTABLE_SEQUENCE_LIMIT = 32
interface NativeReplayFrameDelivery {
  sessionId: string
  inFlight: boolean
  /** Exact frame awaiting its one valid renderer ACK; null before invoke reply. */
  inFlightSequence: number | null
  pending: NativeReplayFrame | null
  /** Bounded proof that a presentation report names a frame we actually sent. */
  presentableSequences: Set<number>
  fallbackStartedAtMs?: number
  firstPresentedLogged: boolean
}
const nativeReplayFrameDelivery = new Map<number, NativeReplayFrameDelivery>()
// Actual per-display recorder health. "recording" is EARNED: it is set only
// once the renderer proves frames are flowing (IPC.captureFrames) or the
// backstop probe returns real replay bytes. Window creation alone — and a
// MediaRecorder that merely says "recording" — stays "starting". Failures come
// from the renderer's existing capture:error signal.
const displayRecorderStates = new Map<number, DisplayRecorderState>()
const recorderProbeTimers = new Map<number, ReturnType<typeof setTimeout>>()
// display.id -> recovery bookkeeping for a display that is NOT recording (issue
// #43): how many attempts have run and when the next one may. Dropped the
// moment the display records again, so a later failure starts from the short
// delay instead of inheriting a stale backoff.
const recoveryAttempts = new Map<number, { attempts: number; nextAt: number }>()
// display.id -> probes that came back without proving this recorder is
// recording, since the last proof (or since its window was created). This — not
// the watchdog's attempt counter — is what decides when a STOPPED display has
// had its chance and the window may be recreated: a renderer that restarted
// itself successfully but cannot prove it (no delivered-frame counter on this
// runtime) gets to answer a probe before its buffer is thrown away.
const probesSinceProof = new Map<number, number>()
// Displays with a probe OUTSTANDING. The timer map above only covers a probe
// that has not fired yet; once it has, main can be waiting up to
// RECORDER_PROBE_TIMEOUT_MS for the answer, and a watchdog tick landing in that
// window would stop the same recorder a second time.
const probesInFlight = new Set<number>()
let reconcileTimer: ReturnType<typeof setInterval> | undefined
let wantedDisplayIds = new Set<number>()
// The surface ring stays on one recorder's frame clock across ordinary
// rebuilds. It changes only when that display is no longer part of the wanted
// set (hot-unplug, fixed-display change, or recording turned off).
let tickOwnerDisplayId: number | null = null
let publishedRecorderState: RecorderState = { status: 'starting' }
const recorderStateListeners = new Set<(state: RecorderState) => void>()

let currentSettings: Settings | null = null
// Bumped on every requested rebuild; queued rebuilds that lost the race bail out.
let generation = 0
// Serializes rebuilds so hotplug bursts and restartCapture never interleave.
let rebuildChain: Promise<void> = Promise.resolve()
let hotplugTimer: ReturnType<typeof setTimeout> | undefined
let watchingDisplays = false

/** The recorder state that drives the tray tooltip/icon at this instant. */
export function getRecorderState(): RecorderState {
  return { ...publishedRecorderState }
}

/** Subscribes to actual recorder state changes; returns an unsubscribe handle. */
export function onRecorderStateChanged(listener: (state: RecorderState) => void): () => void {
  recorderStateListeners.add(listener)
  return () => recorderStateListeners.delete(listener)
}

function sameRecorderState(a: RecorderState, b: RecorderState): boolean {
  if (a.status !== b.status) return false
  if (a.status !== 'stopped' || b.status !== 'stopped') return true
  const sameIndices =
    (a.failedDisplayIndices ?? []).join(',') === (b.failedDisplayIndices ?? []).join(',')
  return (
    a.reason === b.reason &&
    a.detail === b.detail &&
    a.totalDisplays === b.totalDisplays &&
    sameIndices
  )
}

/**
 * The ONE state the tray shows for a desk of N recorders.
 *
 * PESSIMISTIC ON PURPOSE, and that is the whole rule: a single stopped display
 * makes the whole tray read "not recording", because the alternative — a tray
 * that says "recording" while one screen is dead — is issue #39's lie with more
 * monitors. "recording" has to be EARNED by every wanted display; anything in
 * between is "starting".
 *
 * PARAMETERIZED so a fixture can hold it to a PARTIAL failure (#76: "two
 * screens recording, one not"). Reaching this through the real pipeline needs
 * three live recorder windows and a way to kill one of them; taking the two
 * maps as arguments is what lets a three-display desk exist on a two-monitor
 * machine. The private state is passed in by the one caller below, unchanged.
 *
 * `states` is typed as RecorderState rather than DisplayRecorderState because
 * the two unions are the same shape — the per-display map satisfies it as is.
 */
export function aggregateRecorderState(
  wanted: ReadonlySet<number>,
  states: ReadonlyMap<number, RecorderState>,
  displayIndices?: ReadonlyMap<number, number>,
): RecorderState {
  const stoppedList: Array<{ id: number; state: Extract<RecorderState, { status: 'stopped' }> }> = []
  for (const id of wanted) {
    const state = states.get(id)
    if (state?.status === 'stopped') {
      stoppedList.push({ id, state })
    }
  }

  if (stoppedList.length > 0) {
    const first = stoppedList[0]!
    const failedDisplayIndices = displayIndices !== undefined
      ? stoppedList
          .map((s) => displayIndices.get(s.id))
          .filter((idx): idx is number => idx !== undefined)
          .sort((a, b) => a - b)
      : undefined

    return {
      ...first.state,
      ...(failedDisplayIndices !== undefined && failedDisplayIndices.length > 0
        ? { failedDisplayIndices }
        : {}),
      totalDisplays: wanted.size,
    }
  }

  if (wanted.size > 0 && [...wanted].every((id) => states.get(id)?.status === 'recording')) {
    return { status: 'recording' }
  }
  return { status: 'starting' }
}

function getConnectedDisplayIndices(): Map<number, number> {
  const map = new Map<number, number>()
  try {
    const all = screen.getAllDisplays()
    for (let i = 0; i < all.length; i++) {
      const d = all[i]
      if (d !== undefined) map.set(d.id, i + 1)
    }
  } catch {
    // In headless test environments
  }
  return map
}

function publishRecorderState(): void {
  const next = aggregateRecorderState(
    wantedDisplayIds,
    displayRecorderStates,
    getConnectedDisplayIndices(),
  )
  if (sameRecorderState(publishedRecorderState, next)) return
  publishedRecorderState = next
  // One line per REAL change of the state the tray shows, so a report that says
  // "it told me it was not recording" carries the reason and the evidence. It
  // goes to the LOG FILE too (issue #60): the tray's claim is the single most
  // disputed fact in every report so far, and it is now on the record.
  logInfo(
    `[capture] recorder state: ${next.status}` +
      (next.status === 'stopped' ? ` (${next.reason}) — ${next.detail}` : ''),
  )
  for (const listener of recorderStateListeners) listener(getRecorderState())
}

function setDisplayRecorderState(displayId: number, state: DisplayRecorderState): void {
  if (!wantedDisplayIds.has(displayId)) return
  const previous = displayRecorderStates.get(displayId)
  displayRecorderStates.set(displayId, state)
  // PER-DISPLAY transitions with their reason (issue #60): the aggregate above
  // is what the tray shows, but a three-monitor desk with one dead display
  // needs the record to say which one, and when.
  const changed =
    previous === undefined ||
    previous.status !== state.status ||
    (previous.status === 'stopped' && state.status === 'stopped' && previous.detail !== state.detail)
  if (changed) {
    logInfo(
      `[capture] display ${displayId}: ${previous?.status ?? 'none'} -> ${state.status}` +
        (state.status === 'stopped' ? ` (${state.reason}) — ${state.detail}` : ''),
    )
  }
  publishRecorderState()
}

function failureReason(message: string): RecorderFailureReason {
  // FIRST: the recorder was running and lying (issue #39). Its own wording
  // ("no video frames from the desktop capturer") is the contract.
  if (message.includes('no video frames')) return 'no-frames'
  if (message.includes('getDisplayMedia')) return 'screen-unavailable'
  if (message.includes('capture stream ended')) return 'stream-ended'
  if (message.includes('MediaRecorder')) return 'recorder-unavailable'
  return 'process-stopped'
}

/**
 * `--simulate-slow-replay[=ms]` (dev/test only): the other half of the pair
 * above. Every recorder runs for real and its ring buffer really does fill, but
 * the renderer withholds its frame heartbeat and holds every replay answer back
 * by `ms` — a machine under enough load that main cannot get a timely answer
 * out of a recorder that is working perfectly.
 *
 * That is issue #43's own scenario, and the one thing no recovery path is
 * allowed to mishandle: a probe that goes unanswered must not condemn the
 * display, and nothing may destroy the recorder window (and the last 30
 * seconds with it) on the strength of a verdict reached that way. The delay is
 * settable so both sides of RECORDER_PROBE_TIMEOUT_MS can be exercised — a
 * stall short enough to wait out has to end in "recording", one that is not has
 * to end in no verdict rather than a lost buffer.
 *
 * Returns null when the flag is absent (every normal run).
 */
function simulateSlowReplayMs(): number | null {
  const arg = process.argv.find(
    (value) => value === '--simulate-slow-replay' || value.startsWith('--simulate-slow-replay='),
  )
  if (arg === undefined) return null
  const raw = arg.startsWith('--simulate-slow-replay=')
    ? Number(arg.slice('--simulate-slow-replay='.length))
    : Number.NaN
  return Number.isFinite(raw) && raw >= 0 ? raw : SIMULATED_SLOW_REPLAY_DEFAULT_MS
}

function clearRecorderProbe(displayId: number): void {
  const timer = recorderProbeTimers.get(displayId)
  if (timer !== undefined) clearTimeout(timer)
  recorderProbeTimers.delete(displayId)
}

function scheduleRecorderProbe(displayId: number, win: BrowserWindow, delayMs: number): void {
  clearRecorderProbe(displayId)
  const timer = setTimeout(() => {
    // A rebuild or capture:ready may have replaced this timer under the same
    // display id. The stale callback owns neither the map entry nor the probe.
    if (!isCurrentRecorderResource(recorderProbeTimers.get(displayId), timer)) return
    recorderProbeTimers.delete(displayId)
    void probeRecorder(displayId, win)
  }, delayMs)
  recorderProbeTimers.set(displayId, timer)
}

/**
 * The BACKSTOP: flush this display's current recorder into its bounded ring,
 * look at what comes out, and let it prove — or, only on real evidence,
 * condemn — the recorder.
 *
 * It costs footage (see the recovery rules above), so it runs only while a
 * display is not provably recording, and it is cleared the instant the renderer
 * proves frames itself.
 */
async function probeRecorder(displayId: number, win: BrowserWindow): Promise<void> {
  if (
    captureWindows.get(displayId) !== win ||
    win.isDestroyed() ||
    !wantedDisplayIds.has(displayId) ||
    probesInFlight.has(displayId)
  ) {
    return
  }
  probesInFlight.add(displayId)
  let outcome: ReplayFetch
  try {
    outcome = await requestReplay(
      win,
      `recorder-state-${displayId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      RECORDER_PROBE_TIMEOUT_MS,
    )
  } finally {
    probesInFlight.delete(displayId)
  }
  const { replay: result, miss } = outcome
  if (captureWindows.get(displayId) !== win || !wantedDisplayIds.has(displayId)) return
  if (result !== null && result.buffer.byteLength >= RECORDER_EVIDENCE_MIN_BYTES) {
    probesSinceProof.delete(displayId)
    // The SIZE of the proof, on the record (issue #60). "The tray said it was
    // recording" is the most disputed claim in every report so far, and this is
    // the measurement behind it: how much footage this display's ring buffer
    // actually handed over, at a named moment.
    logInfo(
      `[capture] display ${displayId}: recorder probe returned ${result.buffer.byteLength} bytes ` +
        `of ${result.durationMs} ms footage — frames are flowing`,
    )
    setDisplayRecorderState(displayId, { status: 'recording' })
    return
  }
  // RULE 1: no answer is not an answer (issue #43). A timeout means main did
  // not hear back inside RECORDER_PROBE_TIMEOUT_MS — from a renderer that may
  // be busy assembling thirty seconds of MP4 on a loaded machine — and says
  // nothing whatsoever about whether frames are flowing. Condemning on it
  // produced the wrong state #43 was filed for, and a watchdog that acts on the
  // state would then destroy a perfectly good ring buffer on the strength of
  // it. The display keeps whatever status the evidence has actually earned.
  //
  // The price of this rule, stated so nobody mistakes it for an oversight: a
  // display whose renderer answers NOTHING, ever, sits on 'starting…' instead
  // of being named. That is the honest reading of no evidence, it is on the
  // record here every time, and it is far cheaper than the alternative — which
  // is a confident verdict that then throws a working buffer away.
  if (miss === 'timeout' || miss === 'window-gone') {
    logWarn(
      `[capture] display ${displayId}: recorder probe went unanswered (${miss}) — ` +
        'not evidence either way, leaving the state as it is',
    )
    return
  }
  // ...and RULE 1 has to hold for the COUNTER too, not only for the status.
  //
  // This increment used to sit above the guard, so an unanswered probe left the
  // state alone (correct) while still spending a rebuild credit (not). Measured:
  // one 'stopped' from an ordinary blip, then one probe that missed its 10 s
  // window, and the next reconcile destroyed a recorder window holding 549 KB of
  // real footage — the precise thing this release promises can no longer happen.
  // Only an ANSWER may be spent, because only an answer is evidence.
  probesSinceProof.set(displayId, (probesSinceProof.get(displayId) ?? 0) + 1)
  // Preserve a more specific renderer-reported failure if it raced the probe.
  if (displayRecorderStates.get(displayId)?.status === 'stopped') return
  // The renderer DID answer, which means it stopped its slot and flushed the
  // muxer to do so: after this long recording, under the evidence bar really is
  // an empty buffer. Bytes without frames is the same verdict — a container
  // header is all an encoder produces when the desktop capturer delivers
  // nothing, and treating "byteLength > 0" as proof is exactly how the tray
  // used to claim a buffer it did not have.
  const headerOnly = result !== null && result.buffer.byteLength > 0
  const detail = headerOnly
    ? `recorder for display ${displayId} produced ${result.buffer.byteLength} bytes of ` +
      'container header and no video frames'
    : `recorder for display ${displayId} did not produce replay bytes`
  logError(`[capture] ${detail}`)
  setDisplayRecorderState(displayId, {
    status: 'stopped',
    reason: headerOnly ? 'no-frames' : 'did-not-start',
    detail,
  })
}

/**
 * The renderer PROVED that video is flowing for this display (GOAL "Say that
 * you are recording"): frames delivered, or real encoder output. This is the
 * only fast path to "recording" — and it also confirms a recovery, so a display
 * that was stopped comes back the moment it produces frames again.
 *
 * It arrives REPEATEDLY, as a heartbeat (issue #43), which is what makes the
 * displayed state self-healing: whatever put main on 'stopped' — a probe that
 * timed out, a transient duplication failure, a renderer that has since
 * restarted itself — is undone by the next proof, without main having to stop a
 * healthy recorder to find out. Only the transition is logged; the heartbeat
 * itself must not fill the log file with one line every few seconds.
 */
/**
 * The cadence each display's recorder last reported (#82), by display id.
 *
 * Kept so a capture can write it into its own pack: a replay that dropped a
 * fifth of its frames used to be indistinguishable from a healthy one without
 * running ffprobe over the saved file.
 */
const displayCadence = new CaptureCadenceRegistry()

/**
 * THE ONE MEASUREMENT THAT ONLY LUCK PRODUCES, REMEMBERED (#115).
 *
 * Source-latency calibration runs once per capture, inside the startup
 * observation window and never inside retained replay — the call site refuses
 * to "tax their recorder" for it, and this session measured why: a second sink
 * cost its display 14.8 fps against 10.1. So there is no retry to add. What
 * there is, is a measurement that succeeds only when the desk happened to move
 * during those two seconds, and is then thrown away.
 *
 * Every capture in this machine's log before 2026-07-31 19:54 reported
 * `insufficient-motion-transitions` or `no-motion-witness`. That one measured
 * 37.69 ms of pixel exposure on display 1 at 0.92 confidence — and the focused
 * display, the one #89 is about, still measured nothing.
 *
 * An AMBIGUOUS result never overwrites a measured one: "I could not measure it
 * this time" is not "the previous measurement is void". A backend change does
 * void it, because that is a different path to the glass.
 */
interface RememberedSourceLatency {
  latencyMs: number
  confidence: number | undefined
  measuredAtMs: number
  sampleSource: string | undefined
  /**
   * What the pixels were matched AGAINST. Carried because a latency without it
   * cannot be compared with anything: an operation-completion timestamp is not
   * a pixel exposure, and the pack refuses to publish a number that cannot say
   * which one it is.
   */
  referenceSource: string | undefined
  referenceTiming: string | undefined
  /** Half the reference anchor's bracket — the error bar, when it gave one. */
  uncertaintyMs: number | undefined
  backend: string | undefined
  /**
   * Cleared when a new recorder generation starts for this display. The
   * measurement survives — that is the point — but it stops being a statement
   * about the recorder that is running now.
   */
  fromCurrentRecorder: boolean
}
const displaySourceLatency = new Map<number, RememberedSourceLatency>()

/** The last MEASURED source latency for this display, or null if never. */
export function recorderSourceLatency(
  displayId: number,
): RememberedSourceLatency | null {
  return displaySourceLatency.get(displayId) ?? null
}

/**
 * A new recorder generation begins. Its predecessor's measurement is still the
 * best evidence there is for this display, but it is no longer this recorder's.
 */
function endSourceLatencyGeneration(displayId: number): void {
  const remembered = displaySourceLatency.get(displayId)
  if (remembered !== undefined) remembered.fromCurrentRecorder = false
}

/**
 * Records a measured calibration and returns the line to log beside it.
 *
 * Returns null when there is nothing to add: a fresh measurement speaks for
 * itself in the payload that was just logged.
 */
function rememberSourceLatency(
  displayId: number,
  calibration: unknown,
  nowMs: number,
  backend: string | undefined,
): string | null {
  const c = calibration as {
    status?: string
    latencyMs?: number
    confidence?: number
    sampleSource?: string
    reference?: {
      source?: string
      timing?: string
      anchorUncertaintyMs?: number
    }
  } | undefined
  if (c === undefined) return null
  if (c.status === 'measured' && typeof c.latencyMs === 'number') {
    displaySourceLatency.set(displayId, {
      latencyMs: c.latencyMs,
      confidence: c.confidence,
      measuredAtMs: nowMs,
      sampleSource: c.sampleSource,
      referenceSource: c.reference?.source,
      referenceTiming: c.reference?.timing,
      uncertaintyMs: c.reference?.anchorUncertaintyMs,
      backend,
      fromCurrentRecorder: true,
    })
    return null
  }
  const remembered = displaySourceLatency.get(displayId)
  if (remembered === undefined) return null
  if (backend !== undefined && remembered.backend !== undefined && remembered.backend !== backend) {
    // A different path to the glass. The old number is not about this one.
    displaySourceLatency.delete(displayId)
    return null
  }
  const ageMs = Math.max(0, nowMs - remembered.measuredAtMs)
  return (
    `last measured ${remembered.latencyMs.toFixed(1)} ms ` +
    `${Math.round(ageMs / 1000)}s ago` +
    (remembered.confidence === undefined
      ? ''
      : ` at ${remembered.confidence.toFixed(2)} confidence`)
  )
}

/** What this display's recorder has achieved, or null if it never said. */
export function recorderCadence(displayId: number): {
  achievedFps: number
  worstStallMs: number
  discardedFrames?: number | null
  sampledMs?: number
  gainedFrames?: number
  backend?: 'chromium-desktop-capture' | 'windows-gdi-bitblt'
  quality?: 'full' | 'degraded'
  requestedFps?: number
  recorderCount?: number
} | null {
  return displayCadence.get(displayId)
}

function onFramesProven(displayId: number, payload: CaptureFramesPayload): void {
  if (!wantedDisplayIds.has(displayId)) return
  if (payload.cadence !== undefined) displayCadence.set(displayId, payload.cadence)
  const previous = displayRecorderStates.get(displayId)
  if (previous?.status !== 'recording') {
    logInfo(
      `[capture] display ${displayId}: frames confirmed (${payload.bytes} recorder bytes, ` +
        `${payload.frames} delivered frames)`,
    )
    const native = payload.nativePresentation
    if (native !== undefined) {
      logInfo(
        `[capture] display ${displayId}: native presentation accounting ` +
          `requested=${native.requestedFrames}, exact=${native.exactCallbacks}, ` +
          `unreported-presented=${native.unreportedPresented}, ` +
          `ambiguous-dropped=${native.ambiguousDropped}, ` +
          `capacity-dropped=${native.capacityDropped}, pending=${native.pending}`,
      )
    }
  }
  // Proof makes the backstop pointless: leaving it armed would stop and restart
  // a healthy recorder and throw away buffered footage for nothing.
  clearRecorderProbe(displayId)
  // A recovered display owes nothing to the watchdog any more; the next failure
  // is entitled to the full short delay rather than this episode's backoff, and
  // to its own probe before anything recreates its window.
  recoveryAttempts.delete(displayId)
  probesSinceProof.delete(displayId)
  setDisplayRecorderState(displayId, { status: 'recording' })
}

/**
 * Keeps the DISPLAYED state converging on reality for as long as the app runs
 * (issue #43) — the thing a fixed number of early attempts could never do.
 *
 * Each tick, a display that is not provably recording gets ONE recovery action
 * per backoff step, chosen by what there is left to lose (see the recovery
 * rules at the top of this file):
 *
 *  - the renderer is gone or crashed: there is no buffer and nobody to answer a
 *    probe, so the window is recreated straight away;
 *  - the display is in an evidence-backed 'stopped' and has already answered a
 *    probe without proving itself: the buffer is forfeit either way, so the
 *    window is recreated;
 *  - otherwise: probe. A probe can prove the display healthy — that is what
 *    rescues a recorder whose runtime cannot prove itself — and it is the only
 *    action that leaves a window that might still be recording alone.
 *
 * The delay doubles per attempt up to RECOVERY_MAX_DELAY_MS, so a machine whose
 * screen capture is genuinely dead costs one attempt every ten minutes rather
 * than a permanent lie in the tray.
 */
function reconcileRecorders(): void {
  const now = Date.now()
  for (const displayId of wantedDisplayIds) {
    const win = captureWindows.get(displayId)
    // A window whose RENDERER has crashed still exists as an object, and
    // probing it only waits out the timeout: there is nobody left to answer.
    // Recognizing that here is what makes a crashed recorder come back on the
    // first attempt instead of after two dead probes.
    const alive = win !== undefined && !win.isDestroyed() && !win.webContents.isCrashed()
    const status = displayRecorderStates.get(displayId)?.status
    if (alive && status === 'recording') {
      recoveryAttempts.delete(displayId)
      continue
    }
    const pending = recoveryAttempts.get(displayId)
    if (pending === undefined) {
      // First tick that finds this display not recording: the normal startup
      // path is still running (renderer evidence, then the backstop probe), and
      // interrupting it would cost footage for nothing.
      recoveryAttempts.set(displayId, { attempts: 0, nextAt: now + RECOVERY_FIRST_DELAY_MS })
      continue
    }
    if (now < pending.nextAt) continue
    // A probe is already armed or outstanding for this display (the startup
    // backstop, or the one the renderer's own restart re-anchors): that IS an
    // attempt, and starting a second one would stop the recorder twice.
    // Checked before the counter moves, so waiting for it costs nothing.
    if (recorderProbeTimers.has(displayId) || probesInFlight.has(displayId)) continue
    pending.attempts += 1
    pending.nextAt =
      now + Math.min(RECOVERY_MAX_DELAY_MS, RECOVERY_FIRST_DELAY_MS * 2 ** pending.attempts)
    // RULE 3: recreate the window only where rebuild() would actually treat it
    // as stale — a dead renderer, or an evidence-backed 'stopped' that a probe
    // has already had its chance to disprove. A display still in 'starting'
    // may be recording perfectly well and merely unable to say so, and
    // destroying its window would throw away the very footage the user is
    // being promised. rebuild() would keep it anyway; announcing a recreation
    // that will not happen is what made the log unreadable.
    const spentProbes = probesSinceProof.get(displayId) ?? 0
    const rebuildable = !alive || (status === 'stopped' && spentProbes >= RECOVERY_PROBES_BEFORE_REBUILD)
    if (!rebuildable && win !== undefined) {
      logWarn(
        `[capture] display ${displayId}: not recording (${status ?? 'unknown'}) — recovery ` +
          `attempt ${pending.attempts}, probing the recorder for evidence`,
      )
      scheduleRecorderProbe(displayId, win, 0)
      continue
    }
    logWarn(
      `[capture] display ${displayId}: not recording (${status ?? 'unknown'}, ` +
        `${alive ? `${spentProbes} unproven probe(s)` : 'renderer gone'}) — recovery attempt ` +
        `${pending.attempts}, recreating the recorder window`,
    )
    // rebuild() destroys the recorders that are stopped or gone and creates
    // fresh ones; every healthy display keeps its window and its buffer.
    void queueRebuild()
  }
}

function startReconciling(): void {
  if (reconcileTimer !== undefined) return
  reconcileTimer = setInterval(reconcileRecorders, RECONCILE_INTERVAL_MS)
}

/**
 * Stops the recorder watchdog and any armed probe. index.ts calls this on
 * will-quit: a quitting app must not still be scheduling recoveries (or
 * requesting replays) while its windows are being torn down.
 */
export function disposeCapture(): void {
  if (reconcileTimer !== undefined) clearInterval(reconcileTimer)
  reconcileTimer = undefined
  for (const displayId of [...recorderProbeTimers.keys()]) clearRecorderProbe(displayId)
  recoveryAttempts.clear()
  probesSinceProof.clear()
  probesInFlight.clear()
  displayCadence.retain(new Set())
  nativeReplayFallback.stopAll()
  nativeReplayFrameDelivery.clear()
}

function sendNativeReplayFrame(
  sender: WebContents,
  sessionId: string,
  frame: NativeReplayFrame,
): boolean {
  if (sender.isDestroyed()) return false
  try {
    const payload: CaptureNativeFallbackFramePayload = {
      sessionId,
      sequence: frame.sequence,
      clockProvenance: frame.clockProvenance,
      capturedQpc: frame.capturedQpc,
      qpcFrequency: frame.qpcFrequency,
      capturedAtMs: frame.capturedAtMs,
      width: frame.width,
      height: frame.height,
      jpeg: Uint8Array.from(frame.jpeg).buffer,
    }
    sender.send(IPC.captureNativeFallbackFrame, payload)
    return true
  } catch (error) {
    logWarn(
      `[capture] native replay frame delivery failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return false
  }
}

function rememberPresentableSequence(
  delivery: NativeReplayFrameDelivery,
  sequence: number,
): void {
  delivery.presentableSequences.delete(sequence)
  delivery.presentableSequences.add(sequence)
  while (
    delivery.presentableSequences.size > NATIVE_PRESENTABLE_SEQUENCE_LIMIT
  ) {
    const oldest = delivery.presentableSequences.values().next().value
    if (oldest === undefined) break
    delivery.presentableSequences.delete(oldest)
  }
}

function sendTrackedNativeReplayFrame(
  delivery: NativeReplayFrameDelivery,
  sender: WebContents,
  frame: NativeReplayFrame,
): void {
  const sent = sendNativeReplayFrame(sender, delivery.sessionId, frame)
  delivery.inFlight = sent
  delivery.inFlightSequence = sent ? frame.sequence : null
  if (sent) rememberPresentableSequence(delivery, frame.sequence)
}

function setupNativeReplayFallbackIpc(): void {
  if (nativeReplayFallbackIpcInstalled) return
  nativeReplayFallbackIpcInstalled = true
  ipcMain.handle(
    IPC.captureDxgiTimingReference,
    async (event): Promise<CaptureDxgiTimingReferencePayload> => {
      const wantedId = assignedDisplays.get(event.sender.id)
      if (wantedId === undefined) {
        return {
          status: 'unavailable',
          reason: 'unassigned-display',
          detail: 'DXGI timing sender has no assigned display',
        }
      }
      const display = screen
        .getAllDisplays()
        .find((candidate) => String(candidate.id) === wantedId)
      if (display === undefined) {
        return {
          status: 'unavailable',
          reason: 'display-disconnected',
          detail: `assigned display ${wantedId} is no longer connected`,
        }
      }
      // Electron usually exposes a friendly monitor label, not the DXGI
      // "\\.\DISPLAYn" identity. Never turn that label into an extra
      // contradictory selector; exact physical bounds are authoritative.
      const dxgiDeviceName = /^\\\\\.\\DISPLAY\d+$/i.test(display.label.trim())
        ? display.label.trim()
        : undefined
      const result = await captureDxgiTimingReference({
        ...(dxgiDeviceName === undefined
          ? {}
          : { deviceName: dxgiDeviceName }),
        bounds: screen.dipToScreenRect(null, display.bounds),
        timeoutMs: 250,
        processTimeoutMs: 1_000,
      })
      if (assignedDisplays.get(event.sender.id) !== wantedId) {
        return {
          status: 'unavailable',
          reason: 'display-assignment-changed',
          detail: 'capture generation changed during DXGI timing reference',
        }
      }
      return dxgiTimingReferenceToIpc(result)
    },
  )
  ipcMain.handle(
    IPC.captureNativeFallbackStart,
    async (event, request: CaptureNativeFallbackRequest): Promise<CaptureNativeFallbackStartPayload> => {
      const wantedId = assignedDisplays.get(event.sender.id)
      if (wantedId === undefined) throw new Error('native replay fallback sender has no assigned display')
      const display = screen.getAllDisplays().find((candidate) => String(candidate.id) === wantedId)
      if (display === undefined) throw new Error(`assigned display ${wantedId} is no longer connected`)
      const requestedFps = normalizeCaptureFps(
        request?.requestedFps,
        currentSettings?.fps ?? MIN_CAPTURE_FPS,
      )
      const nativeSize = physicalSize(display)
      const width =
        typeof request?.width === 'number' && Number.isFinite(request.width) && request.width > 0
          ? request.width
          : nativeSize.width
      const height =
        typeof request?.height === 'number' && Number.isFinite(request.height) && request.height > 0
          ? request.height
          : nativeSize.height
      const sender = event.sender
      const isHealthProbe = request?.purpose === 'health-probe'
      const isTransition = !isHealthProbe
      const fallbackStartedAtMs = Date.now()
      if (isTransition) {
        logWarn(
          `[capture] display ${wantedId}: primary replay failure confirmed; ` +
            'starting the independent windows-gdi-bitblt source',
        )
      }
      const result = await nativeReplayFallback.start(
        {
          webContentsId: sender.id,
          display,
          nativeBounds: screen.dipToScreenRect(null, display.bounds),
          requestedFps,
          width,
          height,
        },
        (sessionId, frame) => {
          if (
            sender.isDestroyed() ||
            assignedDisplays.get(sender.id) !== wantedId
          ) {
            nativeReplayFallback.stop(sender.id, sessionId)
            return
          }
          const delivery = nativeReplayFrameDelivery.get(sender.id)
          if (delivery === undefined || delivery.sessionId !== sessionId) {
            // The invoke's first frame has not been acknowledged yet. Retain
            // only the newest successor; every older JPEG is unreachable.
            nativeReplayFrameDelivery.set(sender.id, {
              sessionId,
              inFlight: true,
              inFlightSequence: null,
              pending: frame,
              presentableSequences: new Set(),
              ...(isTransition ? { fallbackStartedAtMs } : {}),
              firstPresentedLogged: false,
            })
            return
          }
          if (delivery.inFlight) {
            delivery.pending = frame
            return
          }
          sendTrackedNativeReplayFrame(delivery, sender, frame)
        },
        (sessionId, message) => {
          if (sender.isDestroyed()) return
          try {
            sender.send(IPC.captureNativeFallbackError, {
              sessionId,
              message,
            })
          } catch {
            nativeReplayFallback.stop(sender.id, sessionId)
          }
        },
      )
      const queued = nativeReplayFrameDelivery.get(sender.id)
      if (queued === undefined || queued.sessionId !== result.sessionId) {
        nativeReplayFrameDelivery.set(sender.id, {
          sessionId: result.sessionId,
          inFlight: true,
          inFlightSequence: result.firstFrame.sequence,
          pending: null,
          presentableSequences: new Set([result.firstFrame.sequence]),
          ...(isTransition ? { fallbackStartedAtMs } : {}),
          firstPresentedLogged: false,
        })
      } else {
        // Success returns the first frame over invoke rather than sender.send().
        // Publish its exact ACK/presentation ownership after every successor
        // that may already have been reduced into `pending`.
        queued.inFlight = true
        queued.inFlightSequence = result.firstFrame.sequence
        rememberPresentableSequence(queued, result.firstFrame.sequence)
        if (isTransition) queued.fallbackStartedAtMs = fallbackStartedAtMs
      }
      const firstJpeg = Uint8Array.from(result.firstFrame.jpeg).buffer
      if (isTransition) {
        logWarn(
          `[capture] display ${wantedId}: switched to ${result.backend} ` +
            `(${result.quality}, ${result.width}x${result.height} @ ${result.fps}fps); ` +
            `native source first frame acquired after ${Date.now() - fallbackStartedAtMs} ms`,
        )
      } else {
        logInfo(
          `[capture] display ${wantedId}: native replay health probe acquired ` +
            `${result.width}x${result.height} witness via ${result.backend}`,
        )
      }
      return {
        sessionId: result.sessionId,
        backend: result.backend,
        quality: result.quality,
        requestedFps: result.requestedFps,
        fps: result.fps,
        width: result.width,
        height: result.height,
        firstFrame: {
          sessionId: result.sessionId,
          sequence: result.firstFrame.sequence,
          clockProvenance: result.firstFrame.clockProvenance,
          capturedQpc: result.firstFrame.capturedQpc,
          qpcFrequency: result.firstFrame.qpcFrequency,
          capturedAtMs: result.firstFrame.capturedAtMs,
          width: result.firstFrame.width,
          height: result.firstFrame.height,
          jpeg: firstJpeg,
        },
      }
    },
  )
  ipcMain.on(IPC.captureNativeFallbackStop, (event, sessionId: string) => {
    const delivery = nativeReplayFrameDelivery.get(event.sender.id)
    if (delivery?.sessionId === sessionId) {
      nativeReplayFrameDelivery.delete(event.sender.id)
    }
    nativeReplayFallback.stop(event.sender.id, sessionId)
  })
  ipcMain.on(
    IPC.captureNativeFallbackFrameAck,
    (event, sessionId: string, sequence: number) => {
      const delivery = nativeReplayFrameDelivery.get(event.sender.id)
      if (
        delivery === undefined ||
        delivery.sessionId !== sessionId ||
        !Number.isSafeInteger(sequence) ||
        !delivery.inFlight ||
        delivery.inFlightSequence !== sequence
      ) {
        return
      }
      const next = delivery.pending
      delivery.pending = null
      delivery.inFlight = false
      delivery.inFlightSequence = null
      if (next === null) {
        return
      }
      sendTrackedNativeReplayFrame(delivery, event.sender, next)
    },
  )
  ipcMain.on(
    IPC.captureNativeFallbackFramePresented,
    (event, sessionId: string, sequence: number) => {
      const delivery = nativeReplayFrameDelivery.get(event.sender.id)
      if (
        delivery === undefined ||
        delivery.sessionId !== sessionId ||
        !Number.isSafeInteger(sequence) ||
        delivery.firstPresentedLogged ||
        delivery.fallbackStartedAtMs === undefined ||
        !delivery.presentableSequences.delete(sequence)
      ) {
        return
      }
      delivery.firstPresentedLogged = true
      delivery.presentableSequences.clear()
      const displayId = assignedDisplays.get(event.sender.id) ?? 'unknown'
      logInfo(
        `[capture] display ${displayId}: native first frame presented after ` +
          `${Date.now() - delivery.fallbackStartedAtMs} ms`,
      )
    },
  )
}

/**
 * Why a display has no replay right now — what a capture has to SAY when it
 * finds one missing (GOAL "Say that you are recording"). Never null: a missing
 * replay always has a reason the user is entitled to.
 *
 * A STOPPED recorder's own failure reason wins — that is the honest answer and
 * the one the tray is showing. Otherwise the display is provably still
 * recording, and the answer is the OUTCOME OF THIS REQUEST, not a guess from
 * recorder state: saying "the recorder did not produce video" about a display
 * whose tray entry reads "recording · last 30s ready" is the same lie as the
 * one issue #39 is about, only inverted.
 */
export function replayUnavailableReason(
  displayId: number,
  miss: ReplayMiss = 'no-recorder',
): RecorderFailureReason {
  const state = displayRecorderStates.get(displayId)
  if (state?.status === 'stopped') return state.reason
  switch (miss) {
    case 'timeout':
      return 'replay-timeout'
    case 'empty':
      return 'buffer-too-short'
    case 'window-gone':
    case 'no-recorder':
      return 'did-not-start'
  }
}

// Routes each capture window's getDisplayMedia call to its assigned display
// without a picker: requesting webContents -> assigned display id -> matching
// screen source (desktopCapturer display_id).
export function setupDisplayMediaHandler(): void {
  setupNativeReplayFallbackIpc()
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const requester = request.frame === null ? undefined : webContents.fromFrame(request.frame)
    const wantedId = requester === undefined ? undefined : assignedDisplays.get(requester.id)
    desktopCapturer
      .getSources({ types: ['screen'] })
      .then((sources) => {
        const primaryId = String(screen.getPrimaryDisplay().id)
        const source = selectDisplayMediaSource(sources, wantedId, primaryId)
        if (wantedId !== undefined && source === undefined) {
          logWarn(
            `[capture] assigned display ${wantedId} has no desktopCapturer source; ` +
              'rejecting the request instead of substituting another display',
          )
        }
        callback(source ? { video: source } : {})
      })
      .catch(() => callback({}))
  })
}

// Creates the capture-window set for `settings` and starts watching display
// hotplug. index.ts calls this once at startup and owns the set through this
// module from then on.
export function startCapture(settings: Settings): Promise<void> {
  currentSettings = settings
  watchDisplays()
  // The watchdog runs for the life of the app (issue #43): "recording" must be
  // re-earned continuously, and "not recording" must keep being retried.
  startReconciling()
  return queueRebuild()
}

// Tears down and recreates the capture-window set for new settings — the
// future settings GUI applies captureDisplay (and fps/replaySeconds) changes
// live through this.
export function restartCapture(settings: Settings): Promise<void> {
  currentSettings = settings
  return queueRebuild()
}

// The display the NEXT capture should target — i.e. the FOCUSED display: the
// one the editor opens on and annotations anchor to. "all"/"cursor": the
// display under the mouse right now. Fixed mode: the configured display,
// falling back to primary when it is no longer connected.
export function resolveTargetDisplay(settings: Settings): Display {
  if (settings.captureDisplay === 'all' || settings.captureDisplay === 'cursor') {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  }
  return resolveFixedDisplay(settings.captureDisplay)
}

/** What one capture covers: every display it freezes, and which one is focused. */
export interface CaptureTargets {
  // In screen.getAllDisplays() order — the SAME order manifest.environment.screens
  // uses, so a display's 1-based position here is its manifest display index.
  displays: Display[]
  focused: Display
  // The connected-display list the indices refer to, captured once at trigger
  // time so a hotplug between trigger and save cannot renumber them.
  allDisplays: Display[]
}

/**
 * The displays the NEXT capture freezes (GOAL "Multi-Monitor Support"):
 *  - "all": every connected display, focused = the cursor's display.
 *  - "cursor"/"<id>": that one display only.
 */
export function resolveCaptureTargets(settings: Settings): CaptureTargets {
  const allDisplays = screen.getAllDisplays()
  const focused = resolveTargetDisplay(settings)
  if (settings.captureDisplay !== 'all') {
    return { displays: [focused], focused, allDisplays }
  }
  // The cursor's display must be part of the set even in the pathological case
  // where getDisplayNearestPoint returns something the list does not contain.
  const displays = allDisplays.some((d) => d.id === focused.id) ? allDisplays : [focused, ...allDisplays]
  return { displays, focused, allDisplays }
}

// The live recorder window assigned to a display, or null when none exists
// (e.g. a hotplug rebuild replaced the set mid-flow) — callers then proceed
// screenshot-only.
export function captureWindowForDisplay(displayId: number): BrowserWindow | null {
  const win = captureWindows.get(displayId)
  return win !== undefined && !win.isDestroyed() ? win : null
}

// Snapshots ONE display at its native (physical-pixel) resolution.
//
// `exact` refuses the "any screen" fallback: an all-displays capture must never
// silently store the wrong screen's pixels under a display's index, whereas the
// focused display (the pack's snapshot.png) is better served by a best-effort
// frame than by no capture at all.
export type DisplaySnapshot = { png: Buffer; width: number; height: number }

/** A display's native (physical-pixel) size — what its snapshot is captured at. */
function physicalSize(display: Display): { width: number; height: number } {
  return {
    width: Math.round(display.size.width * display.scaleFactor),
    height: Math.round(display.size.height * display.scaleFactor),
  }
}

function sizeKey(display: Display): string {
  const size = physicalSize(display)
  return `${size.width}x${size.height}`
}

function replaySize(
  display: Display,
  maxLongEdge: number,
): { width: number; height: number } {
  if (maxLongEdge === 0) return { width: 0, height: 0 }
  const native = physicalSize(display)
  const scale = Math.min(1, maxLongEdge / Math.max(native.width, native.height))
  return {
    width: Math.max(1, Math.round(native.width * scale)),
    height: Math.max(1, Math.round(native.height * scale)),
  }
}

/**
 * ONE desktopCapturer round trip for a group of same-sized displays.
 *
 * `fallbackFor` is the one display allowed the "any screen" fallback — the
 * FOCUSED display, whose frame becomes snapshot.png and is better served by a
 * best-effort frame than by no capture at all. Every other display is matched
 * strictly by display_id: an all-displays capture must never store the wrong
 * screen's pixels under a display's index.
 */
async function snapshotGroup(
  group: readonly Display[],
  fallbackFor: number | null,
  into: Map<number, DisplaySnapshot>,
): Promise<void> {
  const first = group[0]
  if (first === undefined) return
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: physicalSize(first),
  })
  for (const d of group) {
    const matched = sources.find((s) => s.display_id === String(d.id))
    const source = matched ?? (d.id === fallbackFor ? sources[0] : undefined)
    if (source === undefined) {
      logError(`[capture] no screen source available for display ${d.id}`)
      continue
    }
    const size = source.thumbnail.getSize()
    into.set(d.id, { png: source.thumbnail.toPNG(), width: size.width, height: size.height })
  }
}

/**
 * Freezes every given display, with as few desktopCapturer calls as possible.
 *
 * thumbnailSize is a GLOBAL option: EVERY getSources() call captures and
 * rescales a full-resolution frame of EVERY connected screen, whatever the
 * caller does with the result. One call per display therefore costs N x N
 * full-resolution captures per trigger (9 frames on a 3-monitor desk, 16 on 4)
 * and holds N uncompressed frames per call in memory at once.
 *
 * So displays that share a native size share a call. Grouping by SIZE rather
 * than taking one call at the largest size keeps every frame exact: one
 * thumbnailSize for differently-shaped screens aspect-fits the smaller ones,
 * and rescaling them back would resample original evidence (SPEC §5.6). On the
 * common desk of identical monitors this is a single call for the whole
 * trigger; it is never more calls than one-per-display.
 *
 * The FOCUSED display's group is issued FIRST and ALONE and awaited before any
 * other call starts, so its frame stays as close to the trigger instant as it
 * was before all-displays capture existed — and its same-sized peers come out
 * of that very call for free.
 *
 * Resolves a map keyed by display id; a display whose source never appeared is
 * simply absent (the caller drops it from the pack — or, for the focused
 * display, fails the capture).
 */
export async function takeDisplaySnapshots(
  displays: readonly Display[],
  focused: Display,
): Promise<Map<number, DisplaySnapshot>> {
  const result = new Map<number, DisplaySnapshot>()
  const focusedKey = sizeKey(focused)
  const withFocused: Display[] = []
  const rest = new Map<string, Display[]>()
  for (const d of displays) {
    if (sizeKey(d) === focusedKey) {
      withFocused.push(d)
      continue
    }
    const bucket = rest.get(sizeKey(d))
    if (bucket === undefined) rest.set(sizeKey(d), [d])
    else bucket.push(d)
  }
  if (!withFocused.some((d) => d.id === focused.id)) withFocused.unshift(focused)
  // The focused group is the only one whose failure is allowed to fail the
  // capture (it carries snapshot.png). A different resolution's group failing
  // costs those displays their place in the pack, nothing more.
  await snapshotGroup(withFocused, focused.id, result)
  await Promise.all(
    [...rest.values()].map((group) =>
      snapshotGroup(group, null, result).catch((err: unknown) => {
        logError('[capture] per-display snapshot group failed:', err)
      }),
    ),
  )
  return result
}

// ONE permanent listener for every replay reply, dispatching by requestId.
//
// An all-displays capture fires one request per display in the same tick; a
// listener per request would put N listeners on a single channel (past
// EventEmitter's default limit of 10 that is a MaxListenersExceededWarning on
// every capture) and wake every one of them for every other display's reply.
const replayWaiters = new Map<string, (payload: CaptureReplayResultPayload) => void>()
let replayListenerRegistered = false

function registerReplayListener(): void {
  if (replayListenerRegistered) return
  replayListenerRegistered = true
  ipcMain.on(IPC.captureReplayResult, (_event: IpcMainEvent, payload: CaptureReplayResultPayload) => {
    const waiter = payload === null ? undefined : replayWaiters.get(payload.requestId)
    if (waiter !== undefined) waiter(payload)
  })
}

/**
 * WHY a replay request came back with no footage. Distinct outcomes, because
 * they are distinct things to tell the user (GOAL "Say that you are
 * recording"): a recorder that never answered is not the same as one that
 * answered with a buffer too short to be a video.
 */
export type ReplayMiss =
  // No recorder window for this display at all (hotplug rebuild in flight).
  | 'no-recorder'
  // The window went away mid-request.
  | 'window-gone'
  // The renderer did not answer inside timeoutMs.
  | 'timeout'
  // It answered with nothing: no recording slot, or a slot whose payload was
  // under the evidence bar (on MP4 a freshly started/rotated slot is entirely
  // muxer-buffered, so this is reachable on a perfectly healthy recorder).
  | 'empty'

export interface ReplayFetch {
  replay: {
    buffer: Buffer
    durationMs: number
    mimeType: string
    replayFile: 'replay.webm' | 'replay.mp4'
    /** The tick clock's value at these bytes' t=0 (#112); absent if unknown. */
    originMs?: number
    /** Measured encoded PTS -> shared presentation-clock observations. */
    clockAnchors?: readonly {
      ptsMs: number
      wallMs: number
    }[]
    /** Encoded PTS -> independently measured desktop-pixel exposure clock. */
    sourceClockAnchors?: readonly {
      ptsMs: number
      wallMs: number
    }[]
  } | null
  // Set exactly when `replay` is null.
  miss: ReplayMiss | null
}

const MAX_REPLAY_CLOCK_ANCHORS = 64
const MIN_REPLAY_CLOCK_RATE = 0.8
const MAX_REPLAY_CLOCK_RATE = 1.2

function validatedReplayClockAnchors(
  anchors: CaptureReplayResultPayload['clockAnchors'],
  durationMs: number,
): readonly { ptsMs: number; wallMs: number }[] | undefined {
  if (
    anchors === undefined
    || anchors.length < 2
    || anchors.length > MAX_REPLAY_CLOCK_ANCHORS
    || !Number.isFinite(durationMs)
    || durationMs <= 0
  ) {
    return undefined
  }
  const validated: Array<{ ptsMs: number; wallMs: number }> = []
  for (const anchor of anchors) {
    if (
      !Number.isFinite(anchor.ptsMs)
      || !Number.isFinite(anchor.wallMs)
      || anchor.ptsMs < 0
      || anchor.ptsMs > durationMs
    ) {
      return undefined
    }
    const previous = validated[validated.length - 1]
    if (
      previous !== undefined
      && (
        anchor.ptsMs <= previous.ptsMs
        || anchor.wallMs <= previous.wallMs
      )
    ) {
      return undefined
    }
    if (previous !== undefined) {
      const rate =
        (anchor.wallMs - previous.wallMs)
        / (anchor.ptsMs - previous.ptsMs)
      if (
        !Number.isFinite(rate)
        || rate < MIN_REPLAY_CLOCK_RATE
        || rate > MAX_REPLAY_CLOCK_RATE
      ) {
        return undefined
      }
    }
    validated.push({
      ptsMs: anchor.ptsMs,
      wallMs: anchor.wallMs,
    })
  }
  return validated
}

// Asks a capture window for its current replay blob, reporting WHY when there
// is none: a timeout, an empty answer, or a window destroyed mid-request.
export function requestReplay(
  win: BrowserWindow,
  requestId: string,
  timeoutMs: number,
  options: { holdAfterCapture?: boolean } = {},
): Promise<ReplayFetch> {
  registerReplayListener()
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined

    const onResult = (payload: CaptureReplayResultPayload): void => {
      cleanup()
      // THE ACCOUNT THAT CAME WITH THE BYTES WINS (#135).
      //
      // displayCadence is otherwise fed only by onFramesProven, and that is
      // main's proof-of-recording channel: the renderer withholds it until
      // frames are proven, four seconds in at the earliest and every twelve
      // seconds after that. A capture triggered between two heartbeats reached
      // buildManifest with nothing at all, so the pack declared no
      // `cadence.backend` and could not say which of the two capture paths
      // produced the replay beside it — the exact question the field is for,
      // unanswered in exactly the situation it is for (SPEC §5.3, #62).
      //
      // This one describes the replay in this very payload and is measured at
      // the ring cut, so it also supersedes any earlier heartbeat: later, and
      // about these bytes rather than about the recorder in general.
      const resultCadence = payload.cadence
      const resultDisplayId = Number(assignedDisplays.get(win.webContents.id))
      if (resultCadence !== undefined && Number.isFinite(resultDisplayId)) {
        displayCadence.set(resultDisplayId, resultCadence)
      }
      const ring = payload.ringDiagnostics
      if (ring !== undefined) {
        const displayId = assignedDisplays.get(win.webContents.id) ?? 'unknown'
        logInfo(
          `[capture] display ${displayId}: ring retained ` +
            `${ring.retainedFragmentCount} fragment(s), ${ring.retainedBytes} bytes / ` +
            `${Math.round(ring.retainedDurationMs)} ms; selected ` +
            `${ring.selectedFragmentCount} fragment(s)`,
        )
        // WHERE THIS CAPTURE'S TIME WENT (#116).
        //
        // A display reported a 902 ms stall and produced 5.9 s of media for a
        // 12.7 s capture. Which layer dropped the time was not answerable from
        // outside: the replay's own `tfdt` is this recorder's arithmetic, so
        // reading the file says nothing about what arrived. These are the
        // incoming numbers.
        if (ring.ringTiming !== undefined) {
          const t = ring.ringTiming
          logInfo(
            `[capture] display ${displayId}: ring timing — ` +
              `${t.sampleCount} sample(s) over ${t.deliveryCount} delivery instant(s); ` +
              `encoder span ${t.sourceSpanMs} ms ` +
              `(${t.fragmentsWithSourceTime} fragment(s) carried one), ` +
              `longest held frame ${t.maxSampleDurationMs} ms`,
          )
          const a = t.assembly
          if (a !== undefined && a !== null) {
            const verdicts = a.verdicts
              .map((v) =>
                v.trusted
                  ? `believed (${Math.round(v.claimedMs ?? 0)} ms claimed within ` +
                    `${Math.round(v.wallSpanMs)} ms of wall)`
                  : `REFUSED ${v.reason ?? 'unknown'} ` +
                    `(${v.claimedMs === null ? 'n/a' : Math.round(v.claimedMs)} ms claimed, ` +
                    `${Math.round(v.wallSpanMs)} ms of wall)`,
              )
              .join('; ')
            logInfo(
              `[capture] display ${displayId}: ring timeline — ` +
                `${a.selectedBeforeRetention} fragment(s) selected spanning ` +
                `${a.timelineBeforeRetentionMs} ms, ` +
                `${a.selectedAfterRetention} kept after the ${a.retentionMs} ms ` +
                `retention window; source clock ` +
                `${verdicts === '' ? 'no sessions' : verdicts}`,
            )
          }
        }
        if (ring.sourceLatencyCalibration !== undefined) {
          logInfo(
            `[capture] display ${displayId}: source latency calibration ` +
              `${JSON.stringify(ring.sourceLatencyCalibration)}`,
          )
          const numericDisplayId = typeof displayId === 'number' ? displayId : null
          const carried =
            numericDisplayId === null
              ? null
              : rememberSourceLatency(
                  numericDisplayId,
                  ring.sourceLatencyCalibration,
                  Date.now(),
                  displayCadence.get(numericDisplayId)?.backend,
                )
          if (carried !== null) {
            logInfo(
              `[capture] display ${displayId}: source latency not measured now; ${carried}`,
            )
          }
        }
        if (ring.replayPixelClock !== undefined) {
          logInfo(
            `[capture] display ${displayId}: replay pixel clock ` +
              `${JSON.stringify(ring.replayPixelClock)}`,
          )
        }
        for (const sample of ring.clockSamples ?? []) {
          logInfo(
            `[capture-clock] display ${displayId}: ` +
              `start=${sample.recorderStartedAtMs.toFixed(3)} ` +
              `event=${sample.eventTimeStampMs.toFixed(3)} ` +
              `timecode=${sample.blobTimecodeMs.toFixed(3)} ` +
              `delivered=${sample.deliveredAtMs.toFixed(3)} ` +
              `presentation=${sample.latestPresentationTimeMs?.toFixed(3) ?? 'unknown'} ` +
              `capture=${sample.latestCaptureTimeMs?.toFixed(3) ?? 'unknown'} ` +
              `media=${sample.latestMediaTimeMs?.toFixed(3) ?? 'unknown'}`,
          )
        }
      }
      if (payload.buffer.byteLength === 0) resolve({ replay: null, miss: 'empty' })
      else {
        const clockAnchors = validatedReplayClockAnchors(
          payload.clockAnchors,
          payload.durationMs,
        )
        const sourceClockAnchors = validatedReplayClockAnchors(
          payload.sourceClockAnchors,
          payload.durationMs,
        )
        resolve({
          replay: {
            buffer: Buffer.from(payload.buffer),
            durationMs: payload.durationMs,
            mimeType: payload.mimeType,
            replayFile: payload.replayFile,
            // Where these bytes begin on the tick clock (#112).
            ...(typeof payload.originMs === 'number' && Number.isFinite(payload.originMs)
              ? { originMs: payload.originMs }
              : {}),
            ...(clockAnchors === undefined ? {} : { clockAnchors }),
            ...(sourceClockAnchors === undefined
              ? {}
              : { sourceClockAnchors }),
          },
          miss: null,
        })
      }
    }
    const onClosed = (): void => {
      cleanup()
      resolve({ replay: null, miss: 'window-gone' })
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      replayWaiters.delete(requestId)
      win.removeListener('closed', onClosed)
    }

    if (win.isDestroyed()) {
      resolve({ replay: null, miss: 'window-gone' })
      return
    }
    replayWaiters.set(requestId, onResult)
    win.once('closed', onClosed)
    timer = setTimeout(() => {
      cleanup()
      resolve({ replay: null, miss: 'timeout' })
    }, timeoutMs)
    const request: CaptureReplayRequestPayload = {
      requestId,
      ...(options.holdAfterCapture === true ? { holdAfterCapture: true } : {}),
    }
    try {
      win.webContents.send(IPC.captureRequestReplay, request)
    } catch {
      cleanup()
      resolve({ replay: null, miss: 'window-gone' })
    }
  })
}

/**
 * Releases a renderer boundary previously acquired with holdAfterCapture.
 *
 * This is intentionally safe after timeout/window loss: the renderer matches
 * the request id, while a destroyed window simply has no recorder left to
 * resume. Session owns calling it from `finally`.
 */
export function resumeReplay(win: BrowserWindow, requestId: string): void {
  if (win.isDestroyed()) return
  const payload: CaptureReplayResumePayload = { requestId }
  try {
    win.webContents.send(IPC.captureResumeReplay, payload)
  } catch {
    // A renderer that vanished owns no live held recorder. Its replacement
    // window is created by the normal per-display reconciliation path.
  }
}

function resolveFixedDisplay(configuredId: string): Display {
  const found = screen.getAllDisplays().find((d) => String(d.id) === configuredId)
  if (found !== undefined) return found
  logWarn(`[capture] configured display ${configuredId} is not connected; using primary`)
  return screen.getPrimaryDisplay()
}

// Hotplug (connect/disconnect/resolution change): debounced rebuild of the
// recorder-window set — rebuild() itself only touches the AFFECTED displays'
// recorders, so unaffected replay buffers survive. Only recorder windows are
// touched — an in-progress capture flow (editor open, save pending) is left to
// finish; at worst its pending replay request resolves null and the capture is
// screenshot-only.
function watchDisplays(): void {
  if (watchingDisplays) return
  watchingDisplays = true
  const onDisplayChange = (): void => {
    clearTimeout(hotplugTimer)
    hotplugTimer = setTimeout(() => void queueRebuild(), HOTPLUG_DEBOUNCE_MS)
  }
  const onMetricsChange = (_event: unknown, _display: Display, changedMetrics: string[]): void => {
    // A workArea-only change (taskbar moved/resized, dock connect) does not
    // affect what the recorders capture; rebuilding would needlessly discard
    // replay buffers. Anything else (bounds, scaleFactor, rotation) rebuilds —
    // rebuild() then keeps the windows whose parameters are unchanged.
    if (changedMetrics.length > 0 && changedMetrics.every((m) => m === 'workArea')) return
    onDisplayChange()
  }
  screen.on('display-added', onDisplayChange)
  screen.on('display-removed', onDisplayChange)
  screen.on('display-metrics-changed', onMetricsChange)
}

function queueRebuild(): Promise<void> {
  const gen = ++generation
  rebuildChain = rebuildChain
    .then(() => (gen === generation ? rebuild() : undefined))
    .catch((err) => {
      const detail = String(err)
      logError('[capture] recorder rebuild failed:', err)
      for (const id of wantedDisplayIds) {
        displayRecorderStates.set(id, { status: 'stopped', reason: 'process-stopped', detail })
      }
      publishRecorderState()
    })
  return rebuildChain
}

// Everything the running recorder depends on: a window whose signature still
// matches can be kept across a rebuild, replay buffer intact.
function recorderSignature(
  display: Display,
  settings: Settings,
  tickOwnership: RecorderTickOwnership,
): string {
  return captureRecorderSignature({
    width: display.size.width,
    height: display.size.height,
    scaleFactor: display.scaleFactor,
    fps: settings.fps,
    replaySeconds: settings.replaySeconds,
    replayMaxWidth: settings.replayMaxWidth,
    tickOwnership,
  })
}

// Diffs the recorder-window set against what the current settings + connected
// displays call for: only stale recorders (display gone, parameters changed,
// window dead) are destroyed and only missing ones are created, so unaffected
// displays keep their replay buffers. Per-display failures are logged and
// skipped so one bad display never takes down the app; the affected capture
// degrades to screenshot-only.
async function rebuild(): Promise<void> {
  const settings = currentSettings
  // "all" and "cursor" record every connected display (see the CPU note at the
  // top of this file); only fixed mode narrows the recorder set. Recording
  // switched OFF wants ZERO recorders — the empty set below closes every
  // capture window through the same reconciliation every other change uses,
  // so "off" is not a special path that can rot, it is the ordinary path with
  // nothing left to keep alive.
  const displays =
    settings === null || !settings.recordingEnabled
      ? []
      : settings.captureDisplay === 'all' || settings.captureDisplay === 'cursor'
        ? screen.getAllDisplays()
        : [resolveFixedDisplay(settings.captureDisplay)]
  const wanted = new Map<number, Display>(displays.map((d) => [d.id, d]))
  // ONE REBUILD, ONE TICK OWNER.
  //
  // Recorder windows are created sequentially and `loadFile()` is asynchronous.
  // Reading the cursor inside createCaptureWindow therefore let it cross a
  // monitor between two windows: both could receive `focused: true` (or fixed
  // mode could receive none because its one display was not under the cursor).
  // Snapshot the preference before the first await, then derive every role and
  // signature from that immutable answer. A fixed-mode singleton necessarily
  // wins even when the cursor is on another display.
  const preferredTickDisplayId =
    wanted.size === 0
      ? null
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id
  tickOwnerDisplayId =
    preferredTickDisplayId === null
      ? null
      : selectRecorderTickOwner([...wanted.keys()], preferredTickDisplayId, tickOwnerDisplayId)
  const wantedSignatures = new Map<number, string>()
  if (settings !== null) {
    for (const display of wanted.values()) {
      wantedSignatures.set(
        display.id,
        recorderSignature(
          display,
          settings,
          recorderTickOwnership(display.id, tickOwnerDisplayId),
        ),
      )
    }
  }
  wantedDisplayIds = new Set(wanted.keys())
  // A disconnected or no-longer-requested display cannot lend its last
  // renderer's cadence to a future recorder that happens to reuse the id.
  displayCadence.retain(wantedDisplayIds)
  for (const id of [...displaySourceLatency.keys()]) {
    if (!wantedDisplayIds.has(id)) displaySourceLatency.delete(id)
  }
  for (const id of displayRecorderStates.keys()) {
    if (!wanted.has(id)) displayRecorderStates.delete(id)
  }
  for (const id of recorderProbeTimers.keys()) {
    if (!wanted.has(id)) clearRecorderProbe(id)
  }
  // A disconnected display has no recorder to recover (issue #43); its backoff
  // must not survive to slow down a display that comes back later.
  for (const id of recoveryAttempts.keys()) {
    if (!wanted.has(id)) recoveryAttempts.delete(id)
  }
  for (const id of probesSinceProof.keys()) {
    if (!wanted.has(id)) probesSinceProof.delete(id)
  }

  for (const [id, win] of captureWindows) {
    const display = wanted.get(id)
    const stale =
      settings === null ||
      display === undefined ||
      win.isDestroyed() ||
      // A STOPPED display has no buffer left to protect, and its renderer has
      // already spent its one recovery (renderer/capture/capture.ts): keeping
      // the window would keep the display screenshot-only until the app is
      // restarted. A rebuild is the one moment recorders are allowed to be
      // recreated, so this is where it gets a fresh renderer.
      displayRecorderStates.get(id)?.status === 'stopped' ||
      captureWindowSigs.get(id) !== wantedSignatures.get(id)
    if (!stale) continue
    // destroy() emits 'closed', whose handler releases the window's IPC
    // listener and assignedDisplays entry — no leaks.
    captureWindows.delete(id)
    captureWindowSigs.delete(id)
    displayRecorderStates.delete(id)
    // Signature/recovery replacement starts a new measurement generation.
    // Keeping the old report would write stale FPS beside the new replay.
    displayCadence.reset(id)
    endSourceLatencyGeneration(id)
    clearRecorderProbe(id)
    // A fresh renderer is owed a fresh hearing: it must get its own probe
    // before anything recreates its window again, or a display that failed once
    // would have every later recorder destroyed unexamined.
    probesSinceProof.delete(id)
    if (!win.isDestroyed()) win.destroy()
  }
  if (settings === null) {
    publishRecorderState()
    return
  }

  for (const display of wanted.values()) {
    if (captureWindows.has(display.id)) continue
    setDisplayRecorderState(display.id, { status: 'starting' })
    try {
      const ownership = recorderTickOwnership(display.id, tickOwnerDisplayId)
      const win = await createCaptureWindow(display, settings, ownership === 'owner')
      captureWindows.set(display.id, win)
      captureWindowSigs.set(display.id, wantedSignatures.get(display.id)!)
      if (displayRecorderStates.get(display.id)?.status !== 'stopped') {
        scheduleRecorderProbe(display.id, win, RECORDER_STARTUP_PROBE_DELAY_MS)
      }
    } catch (err) {
      const detail = String(err)
      logError(`[capture] recorder for display ${display.id} failed to start:`, err)
      setDisplayRecorderState(display.id, { status: 'stopped', reason: 'process-stopped', detail })
    }
  }
  publishRecorderState()
}

async function createCaptureWindow(
  display: Display,
  settings: Settings,
  ownsTicks: boolean,
): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    width: 320,
    height: 240,
    webPreferences: {
      preload: path.join(__dirname, '../preload/capture.js'),
      // Hidden windows get Chromium's intensive timer throttling, which would
      // stall the recorder rotation timers. Keep timers accurate.
      backgroundThrottling: false,
    },
  })
  try {
    const wcId = win.webContents.id
    assignedDisplays.set(wcId, String(display.id))

    const onError = (event: IpcMainEvent, message: unknown): void => {
      if (
        event.sender === win.webContents &&
        isCurrentRecorderResource(captureWindows.get(display.id), win)
      ) {
        const detail = String(message)
        logError(
          `[capture] recorder for display ${display.id} failed, continuing screenshot-only: ${detail}`,
        )
        setDisplayRecorderState(display.id, {
          status: 'stopped',
          reason: failureReason(detail),
          detail,
        })
        // NO probe is armed here. The renderer restarts this display's capture
        // three seconds from now (including after `no-frames`), and a probe
        // five seconds out would land on a two-second-old recorder — stopping
        // the slot it had just begun to refill, ahead of the renderer's own
        // verdict, and truncating the recovery it was meant to check. onReady
        // re-anchors the backstop behind that verdict when the restart gets a
        // stream, and the watchdog above covers the case where it does not.
      }
    }
    const onReady = (event: IpcMainEvent, ready: CaptureReadyPayload): void => {
      if (
        event.sender !== win.webContents ||
        !isCurrentRecorderResource(captureWindows.get(display.id), win)
      ) {
        return
      }
      logInfo(
        `[capture] display ${display.id}: ${ready.mimeType} -> ${ready.replayFile}, ` +
          `${ready.width}x${ready.height}` +
          (ready.sourceLatencyMs === undefined
            ? ', source latency unknown'
            : `, source latency ${Math.round(ready.sourceLatencyMs)} ms`),
      )
      const startupReadiness = ready.startupReadiness
      if (startupReadiness !== undefined) {
        logInfo(
          `[capture] display ${display.id}: primary recorder readiness after ` +
            `${Math.round(startupReadiness.observedWaitMs)} ms ` +
            `(${startupReadiness.presentedFrames} presented frames, ` +
            `timeout=${String(startupReadiness.timedOut)}, ` +
            `excluded-before-recorder=${Math.round(startupReadiness.excludedBeforeRecorderMs)} ms, ` +
            `presentation-span=${Math.round(startupReadiness.observedSpanMs)} ms)`,
        )
      }
      if (ready.sourceLatencyCalibration !== undefined) {
        logInfo(
          `[capture] display ${display.id}: source latency calibration ` +
            `${JSON.stringify(ready.sourceLatencyCalibration)}`,
        )
        const carried = rememberSourceLatency(
          display.id,
          ready.sourceLatencyCalibration,
          Date.now(),
          displayCadence.get(display.id)?.backend,
        )
        if (carried !== null) {
          logInfo(
            `[capture] display ${display.id}: source latency not measured now; ${carried}`,
          )
        }
      }
      // sendReady describes a new source generation, including an in-window
      // Chromium -> GDI transition. Old primary cadence/quality and "recording"
      // proof must not survive into bytes produced by the replacement backend.
      displayCadence.reset(display.id)
      endSourceLatencyGeneration(display.id)
      setDisplayRecorderState(display.id, { status: 'starting' })
      // The recorder is running as of NOW, so the backstop is re-anchored here
      // — behind the renderer's own frame-evidence deadline, and re-armed for
      // each restart the renderer performs (see RECORDER_PROBE_DELAY_MS).
      scheduleRecorderProbe(display.id, win, RECORDER_PROBE_DELAY_MS)
    }
    const onFrames = (event: IpcMainEvent, payload: CaptureFramesPayload): void => {
      // Proof from a window a rebuild has already replaced says nothing about
      // the recorder that serves this display now: claiming "recording" on it
      // is the very mistake this whole path exists to stop.
      if (event.sender !== win.webContents || captureWindows.get(display.id) !== win) return
      onFramesProven(display.id, payload)
    }
    ipcMain.on(IPC.captureError, onError)
    ipcMain.on(IPC.captureReady, onReady)
    ipcMain.on(IPC.captureFrames, onFrames)
    const onTick = (event: IpcMainEvent, payload: CaptureTickPayload): void => {
      if (event.sender !== win.webContents || captureWindows.get(display.id) !== win) return
      // Enforce ownership at the process boundary too. The renderer normally
      // creates no tick chain for a passive window, but a stale or malformed
      // sender still cannot put a second display's clock into lane S.
      if (!ownsTicks) return
      if (typeof payload?.mediaTimeMs !== 'number' || !Number.isFinite(payload.mediaTimeMs)) return
      tickSurfaces(String(display.id), payload.mediaTimeMs, payload.frameAgeMs, payload.tickDelayMs)
    }
    ipcMain.on(IPC.captureTick, onTick)
    // A recorder renderer that VANISHES is a recorder failure, never silence
    // (issue #60): the state moves here — which logs it — and the watchdog
    // above then recreates the window on its own schedule (issue #43).
    win.webContents.on('render-process-gone', (_event, details) => {
      if (!isCurrentRecorderResource(captureWindows.get(display.id), win)) return
      setDisplayRecorderState(display.id, {
        status: 'stopped',
        reason: 'process-stopped',
        detail: `recorder renderer stopped: ${details.reason} (exitCode ${details.exitCode})`,
      })
    })
    win.on('closed', () => {
      ipcMain.removeListener(IPC.captureError, onError)
      ipcMain.removeListener(IPC.captureReady, onReady)
      ipcMain.removeListener(IPC.captureFrames, onFrames)
      ipcMain.removeListener(IPC.captureTick, onTick)
      assignedDisplays.delete(wcId)
      nativeReplayFallback.stop(wcId)
      nativeReplayFrameDelivery.delete(wcId)
      // Electron may deliver this after rebuild() has already installed a new
      // window for the same display. Only the window that still owns the slot
      // may clear that replacement's probe or change its health.
      if (isCurrentRecorderResource(captureWindows.get(display.id), win)) {
        clearRecorderProbe(display.id)
        setDisplayRecorderState(display.id, {
          status: 'stopped',
          reason: 'process-stopped',
          detail: `recorder window for display ${display.id} closed`,
        })
      }
    })

    await win.loadFile(path.join(__dirname, '../renderer/capture/capture.html'))

    const replay = replaySize(display, settings.replayMaxWidth)
    const slowReplayMs = simulateSlowReplayMs()
    const payload: CaptureStartPayload = {
      displayId: String(display.id),
      // The rebuild's one stable clock owner is the only display that ticks the
      // ring (#105). Never re-read the cursor on this asynchronous path.
      focused: ownsTicks,
      fps: settings.fps,
      // Retention window and bounded maintenance-flush interval.
      segmentSeconds: settings.replaySeconds,
      replayMaxWidth: settings.replayMaxWidth,
      replayWidth: replay.width,
      replayHeight: replay.height,
      // Test path for issue #39: a real recorder over a desktop capturer that
      // delivers nothing. Nobody can break Desktop Duplication on demand, so
      // this is how the no-frames path stays provable.
      ...(shouldSimulateNoFrames(process.argv, String(display.id))
        ? { simulateNoFrames: true }
        : {}),
      // Test path for issue #43: a real recorder on a machine too loaded to
      // prove itself to main. Nobody can put a desk under that load on demand
      // either, so this is how "recovery never costs the recording" stays
      // provable.
      ...(slowReplayMs === null ? {} : { simulateSlowReplayMs: slowReplayMs }),
    }
    win.webContents.send(IPC.captureStart, payload)
    return win
  } catch (err) {
    // loadFile (or anything after construction) failed: destroy the window
    // before rethrowing — destroy() fires 'closed', which releases the IPC
    // listener and assignedDisplays entry. Without this, a persistently
    // failing display would accumulate hidden unthrottled windows and
    // permanent ipcMain listeners across hotplug rebuilds.
    if (!win.isDestroyed()) win.destroy()
    throw err
  }
}
