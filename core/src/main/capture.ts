// Main-process side of capture: owns the hidden recorder window SET (one per
// connected display in "all"/"cursor" mode, exactly one in fixed mode), routes
// each window's getDisplayMedia call to its assigned display, takes per-display
// screenshots, handles display hotplug, and bridges replay request/response.
//
// CPU note (GOAL "Multi-Monitor Support"): every capture window runs a recorder
// PAIR — two rotating MediaRecorder sessions (see renderer/capture/capture.ts).
// "all" and "cursor" run the SAME recorder set — one pair PER connected display
// so the last 30 seconds exist wherever the trigger lands. Capturing all
// displays therefore costs nothing extra at record time; what "all" adds is
// EXPORT work (one more snapshot + replay fetch + file write per display at the
// trigger). Fixed mode runs a single pair on the chosen display (lowest CPU).
import path from 'node:path'
import { BrowserWindow, desktopCapturer, ipcMain, screen, session, webContents } from 'electron'
import type { Display, IpcMainEvent } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  CaptureFramesPayload,
  CaptureReadyPayload,
  CaptureReplayResultPayload,
  CaptureStartPayload,
  RecorderFailureReason,
} from '../shared/ipc'
import type { Settings } from '../shared/types'
import { logError, logInfo, logWarn } from './log'

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
const RECORDER_RETRY_PROBE_DELAY_MS = 5_000
const RECORDER_PROBE_TIMEOUT_MS = 3_000
// Same bar the renderer applies to its own output (renderer/capture/capture.ts
// EVIDENCE_MIN_BYTES): a container header carries no frames, so bytes alone
// were never proof that anything was recorded.
const RECORDER_EVIDENCE_MIN_BYTES = 4096

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
const RECONCILE_INTERVAL_MS = 15_000
// A display that is not recording gets this long to sort itself out (renderer
// evidence, the backstop probe, the renderer's own one restart) before the
// watchdog interferes.
const RECOVERY_FIRST_DELAY_MS = 30_000
const RECOVERY_MAX_DELAY_MS = 10 * 60_000
// After this many probe-only recoveries, recreate the recorder WINDOW instead:
// the renderer spends one restart per failure episode and then stops trying, so
// a fresh renderer is the only thing left that can change the answer.
const RECOVERY_PROBES_BEFORE_REBUILD = 2

export type { RecorderFailureReason }

export type RecorderState =
  | { status: 'starting' }
  | { status: 'recording' }
  | { status: 'stopped'; reason: RecorderFailureReason; detail: string }

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
let reconcileTimer: ReturnType<typeof setInterval> | undefined
let wantedDisplayIds = new Set<number>()
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
  return a.reason === b.reason && a.detail === b.detail
}

function aggregateRecorderState(): RecorderState {
  for (const id of wantedDisplayIds) {
    const state = displayRecorderStates.get(id)
    if (state?.status === 'stopped') return { ...state }
  }
  if (
    wantedDisplayIds.size > 0 &&
    [...wantedDisplayIds].every((id) => displayRecorderStates.get(id)?.status === 'recording')
  ) {
    return { status: 'recording' }
  }
  return { status: 'starting' }
}

function publishRecorderState(): void {
  const next = aggregateRecorderState()
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
 * `--simulate-no-frames` (dev/test only, alongside --show-settings and friends):
 * every recorder starts for real but drops its output and reports zero
 * delivered frames — what this machine looks like when Windows Desktop
 * Duplication is failing (issue #39). The evidence path, the `no-frames` state,
 * the announcement and the one recovery attempt are all exercised for real.
 */
function simulateNoFrames(): boolean {
  return process.argv.includes('--simulate-no-frames')
}

function clearRecorderProbe(displayId: number): void {
  const timer = recorderProbeTimers.get(displayId)
  if (timer !== undefined) clearTimeout(timer)
  recorderProbeTimers.delete(displayId)
}

function scheduleRecorderProbe(displayId: number, win: BrowserWindow, delayMs: number): void {
  clearRecorderProbe(displayId)
  const timer = setTimeout(() => {
    recorderProbeTimers.delete(displayId)
    void probeRecorder(displayId, win)
  }, delayMs)
  recorderProbeTimers.set(displayId, timer)
}

async function probeRecorder(displayId: number, win: BrowserWindow): Promise<void> {
  if (captureWindows.get(displayId) !== win || win.isDestroyed() || !wantedDisplayIds.has(displayId)) {
    return
  }
  const { replay: result } = await requestReplay(
    win,
    `recorder-state-${displayId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    RECORDER_PROBE_TIMEOUT_MS,
  )
  if (captureWindows.get(displayId) !== win || !wantedDisplayIds.has(displayId)) return
  if (result !== null && result.buffer.byteLength >= RECORDER_EVIDENCE_MIN_BYTES) {
    setDisplayRecorderState(displayId, { status: 'recording' })
    return
  }
  // Preserve a more specific renderer-reported failure if it raced the probe.
  if (displayRecorderStates.get(displayId)?.status === 'stopped') return
  // Bytes without frames: a container header is all an encoder produces when
  // the desktop capturer delivers nothing, and treating "byteLength > 0" as
  // proof is exactly how the tray used to claim a buffer it did not have.
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
function onFramesProven(displayId: number, payload: CaptureFramesPayload): void {
  if (!wantedDisplayIds.has(displayId)) return
  const previous = displayRecorderStates.get(displayId)
  if (previous?.status !== 'recording') {
    logInfo(
      `[capture] display ${displayId}: frames confirmed (${payload.bytes} recorder bytes, ` +
        `${payload.frames} delivered frames)`,
    )
  }
  // Proof makes the backstop pointless: leaving it armed would stop and restart
  // a healthy recorder and throw away buffered footage for nothing.
  clearRecorderProbe(displayId)
  // A recovered display owes nothing to the watchdog any more; the next failure
  // is entitled to the full short delay rather than this episode's backoff.
  recoveryAttempts.delete(displayId)
  setDisplayRecorderState(displayId, { status: 'recording' })
}

/**
 * Keeps the DISPLAYED state converging on reality for as long as the app runs
 * (issue #43) — the thing a fixed number of early attempts could never do.
 *
 * Every tick, each display that is not provably recording either gets its
 * backstop probe re-armed or, once probing alone has failed twice, has its
 * recorder window recreated (the renderer's own retry is spent by then). The
 * delay doubles per attempt up to RECOVERY_MAX_DELAY_MS, so a machine whose
 * screen capture is genuinely dead costs one probe every ten minutes rather
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
    if (alive && displayRecorderStates.get(displayId)?.status === 'recording') {
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
    // A probe is already armed for this display (the startup backstop, or the
    // one a renderer failure schedules): that IS an attempt, and starting a
    // second one would stop the recorder twice. Checked before the counter
    // moves, so waiting for it costs nothing.
    if (recorderProbeTimers.has(displayId)) continue
    pending.attempts += 1
    pending.nextAt =
      now + Math.min(RECOVERY_MAX_DELAY_MS, RECOVERY_FIRST_DELAY_MS * 2 ** pending.attempts)
    if (alive && win !== undefined && pending.attempts <= RECOVERY_PROBES_BEFORE_REBUILD) {
      logWarn(
        `[capture] display ${displayId}: not recording — recovery attempt ${pending.attempts}, re-probing`,
      )
      scheduleRecorderProbe(displayId, win, 0)
      continue
    }
    logWarn(
      `[capture] display ${displayId}: not recording — recovery attempt ${pending.attempts}, ` +
        'recreating the recorder window',
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
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const requester = request.frame === null ? undefined : webContents.fromFrame(request.frame)
    const wantedId = requester === undefined ? undefined : assignedDisplays.get(requester.id)
    desktopCapturer
      .getSources({ types: ['screen'] })
      .then((sources) => {
        const primaryId = String(screen.getPrimaryDisplay().id)
        const source =
          sources.find((s) => s.display_id === wantedId) ??
          sources.find((s) => s.display_id === primaryId) ??
          sources[0]
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
  } | null
  // Set exactly when `replay` is null.
  miss: ReplayMiss | null
}

// Asks a capture window for its current replay blob, reporting WHY when there
// is none: a timeout, an empty answer, or a window destroyed mid-request.
export function requestReplay(
  win: BrowserWindow,
  requestId: string,
  timeoutMs: number,
): Promise<ReplayFetch> {
  registerReplayListener()
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined

    const onResult = (payload: CaptureReplayResultPayload): void => {
      cleanup()
      if (payload.buffer.byteLength === 0) resolve({ replay: null, miss: 'empty' })
      else {
        resolve({
          replay: {
            buffer: Buffer.from(payload.buffer),
            durationMs: payload.durationMs,
            mimeType: payload.mimeType,
            replayFile: payload.replayFile,
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
    win.webContents.send(IPC.captureRequestReplay, requestId)
  })
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
function recorderSignature(display: Display, settings: Settings): string {
  return [
    display.size.width,
    display.size.height,
    display.scaleFactor,
    settings.fps,
    settings.replaySeconds,
    settings.replayMaxWidth,
  ].join(':')
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
  // top of this file); only fixed mode narrows the recorder set.
  const displays =
    settings === null
      ? []
      : settings.captureDisplay === 'all' || settings.captureDisplay === 'cursor'
        ? screen.getAllDisplays()
        : [resolveFixedDisplay(settings.captureDisplay)]
  const wanted = new Map<number, Display>(displays.map((d) => [d.id, d]))
  wantedDisplayIds = new Set(wanted.keys())
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
      captureWindowSigs.get(id) !== recorderSignature(display, settings)
    if (!stale) continue
    // destroy() emits 'closed', whose handler releases the window's IPC
    // listener and assignedDisplays entry — no leaks.
    captureWindows.delete(id)
    captureWindowSigs.delete(id)
    displayRecorderStates.delete(id)
    clearRecorderProbe(id)
    if (!win.isDestroyed()) win.destroy()
  }
  if (settings === null) {
    publishRecorderState()
    return
  }

  for (const display of displays) {
    if (captureWindows.has(display.id)) continue
    setDisplayRecorderState(display.id, { status: 'starting' })
    try {
      const win = await createCaptureWindow(display, settings)
      captureWindows.set(display.id, win)
      captureWindowSigs.set(display.id, recorderSignature(display, settings))
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

async function createCaptureWindow(display: Display, settings: Settings): Promise<BrowserWindow> {
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
      if (event.sender === win.webContents) {
        const detail = String(message)
        logError(
          `[capture] recorder for display ${display.id} failed, continuing screenshot-only: ${detail}`,
        )
        setDisplayRecorderState(display.id, {
          status: 'stopped',
          reason: failureReason(detail),
          detail,
        })
        // RECOVER ONCE: the renderer restarts this display's capture three
        // seconds from now (including after `no-frames`), and this probe is the
        // backstop that re-checks it. Proven frames — or replay bytes here —
        // are the only things that move the state back to recording.
        scheduleRecorderProbe(display.id, win, RECORDER_RETRY_PROBE_DELAY_MS)
      }
    }
    const onReady = (event: IpcMainEvent, ready: CaptureReadyPayload): void => {
      if (event.sender !== win.webContents) return
      logInfo(
        `[capture] display ${display.id}: ${ready.mimeType} -> ${ready.replayFile}, ` +
          `${ready.width}x${ready.height}`,
      )
      // The recorder is running as of NOW, so the backstop is re-anchored here
      // — behind the renderer's own frame-evidence deadline, and re-armed for
      // each restart the renderer performs (see RECORDER_PROBE_DELAY_MS).
      if (displayRecorderStates.get(display.id)?.status !== 'recording') {
        scheduleRecorderProbe(display.id, win, RECORDER_PROBE_DELAY_MS)
      }
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
    // A recorder renderer that VANISHES is a recorder failure, never silence
    // (issue #60): the state moves here — which logs it — and the watchdog
    // above then recreates the window on its own schedule (issue #43).
    win.webContents.on('render-process-gone', (_event, details) => {
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
      assignedDisplays.delete(wcId)
      clearRecorderProbe(display.id)
      if (captureWindows.get(display.id) === win) {
        setDisplayRecorderState(display.id, {
          status: 'stopped',
          reason: 'process-stopped',
          detail: `recorder window for display ${display.id} closed`,
        })
      }
    })

    await win.loadFile(path.join(__dirname, '../renderer/capture/capture.html'))

    const replay = replaySize(display, settings.replayMaxWidth)
    const payload: CaptureStartPayload = {
      displayId: String(display.id),
      fps: settings.fps,
      // The recorder rotates segments at this interval; replay covers 1x..2x of it.
      segmentSeconds: settings.replaySeconds,
      replayMaxWidth: settings.replayMaxWidth,
      replayWidth: replay.width,
      replayHeight: replay.height,
      // Test path for issue #39: a real recorder over a desktop capturer that
      // delivers nothing. Nobody can break Desktop Duplication on demand, so
      // this is how the no-frames path stays provable.
      ...(simulateNoFrames() ? { simulateNoFrames: true } : {}),
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
