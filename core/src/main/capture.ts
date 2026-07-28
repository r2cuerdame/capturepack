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
  CaptureReadyPayload,
  CaptureReplayResultPayload,
  CaptureStartPayload,
} from '../shared/ipc'
import type { Settings } from '../shared/types'

const HOTPLUG_DEBOUNCE_MS = 1_000
// A recorder window loading only proves that its renderer started. The first
// non-empty replay response proves the MediaRecorder itself is producing video.
const RECORDER_PROBE_DELAY_MS = 2_000
const RECORDER_RETRY_PROBE_DELAY_MS = 5_000
const RECORDER_PROBE_TIMEOUT_MS = 3_000

export type RecorderFailureReason =
  | 'screen-unavailable'
  | 'recorder-unavailable'
  | 'stream-ended'
  | 'process-stopped'
  | 'did-not-start'

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
// Actual per-display recorder health. "recording" is set only after the
// renderer returns non-empty replay bytes; window creation alone stays
// "starting". Failures come from the renderer's existing capture:error signal.
const displayRecorderStates = new Map<number, DisplayRecorderState>()
const recorderProbeTimers = new Map<number, ReturnType<typeof setTimeout>>()
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
  for (const listener of recorderStateListeners) listener(getRecorderState())
}

function setDisplayRecorderState(displayId: number, state: DisplayRecorderState): void {
  if (!wantedDisplayIds.has(displayId)) return
  displayRecorderStates.set(displayId, state)
  publishRecorderState()
}

function failureReason(message: string): RecorderFailureReason {
  if (message.includes('getDisplayMedia')) return 'screen-unavailable'
  if (message.includes('capture stream ended')) return 'stream-ended'
  if (message.includes('MediaRecorder')) return 'recorder-unavailable'
  return 'process-stopped'
}

function clearRecorderProbe(displayId: number): void {
  const timer = recorderProbeTimers.get(displayId)
  if (timer !== undefined) clearTimeout(timer)
  recorderProbeTimers.delete(displayId)
}

function scheduleRecorderProbe(
  displayId: number,
  win: BrowserWindow,
  delayMs = RECORDER_PROBE_DELAY_MS,
): void {
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
  const result = await requestReplay(
    win,
    `recorder-state-${displayId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    RECORDER_PROBE_TIMEOUT_MS,
  )
  if (captureWindows.get(displayId) !== win || !wantedDisplayIds.has(displayId)) return
  if (result !== null && result.buffer.byteLength > 0) {
    setDisplayRecorderState(displayId, { status: 'recording' })
    return
  }
  // Preserve a more specific renderer-reported failure if it raced the probe.
  if (displayRecorderStates.get(displayId)?.status === 'stopped') return
  setDisplayRecorderState(displayId, {
    status: 'stopped',
    reason: 'did-not-start',
    detail: `recorder for display ${displayId} did not produce replay bytes`,
  })
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
      console.error(`[capture] no screen source available for display ${d.id}`)
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
        console.error('[capture] per-display snapshot group failed:', String(err))
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

// Asks a capture window for its current replay blob. Resolves null on timeout,
// when the renderer reports no footage (empty buffer), or when the window is
// destroyed mid-request (hotplug rebuild).
export function requestReplay(
  win: BrowserWindow,
  requestId: string,
  timeoutMs: number,
): Promise<{
  buffer: Buffer
  durationMs: number
  mimeType: string
  replayFile: 'replay.webm' | 'replay.mp4'
} | null> {
  registerReplayListener()
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined

    const onResult = (payload: CaptureReplayResultPayload): void => {
      cleanup()
      if (payload.buffer.byteLength === 0) resolve(null)
      else {
        resolve({
          buffer: Buffer.from(payload.buffer),
          durationMs: payload.durationMs,
          mimeType: payload.mimeType,
          replayFile: payload.replayFile,
        })
      }
    }
    const onClosed = (): void => {
      cleanup()
      resolve(null)
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      replayWaiters.delete(requestId)
      win.removeListener('closed', onClosed)
    }

    if (win.isDestroyed()) {
      resolve(null)
      return
    }
    replayWaiters.set(requestId, onResult)
    win.once('closed', onClosed)
    timer = setTimeout(() => {
      cleanup()
      resolve(null)
    }, timeoutMs)
    win.webContents.send(IPC.captureRequestReplay, requestId)
  })
}

function resolveFixedDisplay(configuredId: string): Display {
  const found = screen.getAllDisplays().find((d) => String(d.id) === configuredId)
  if (found !== undefined) return found
  console.warn(`[capture] configured display ${configuredId} is not connected; using primary`)
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
      console.error('[capture] recorder rebuild failed:', detail)
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

  for (const [id, win] of captureWindows) {
    const display = wanted.get(id)
    const stale =
      settings === null ||
      display === undefined ||
      win.isDestroyed() ||
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
        scheduleRecorderProbe(display.id, win)
      }
    } catch (err) {
      const detail = String(err)
      console.error(`[capture] recorder for display ${display.id} failed to start: ${detail}`)
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
        console.error(
          `[capture] recorder for display ${display.id} failed, continuing screenshot-only: ${detail}`,
        )
        setDisplayRecorderState(display.id, {
          status: 'stopped',
          reason: failureReason(detail),
          detail,
        })
        // The renderer retries once after three seconds. A later non-empty
        // replay is the only thing that moves the state back to recording.
        scheduleRecorderProbe(display.id, win, RECORDER_RETRY_PROBE_DELAY_MS)
      }
    }
    const onReady = (event: IpcMainEvent, ready: CaptureReadyPayload): void => {
      if (event.sender !== win.webContents) return
      console.info(
        `[capture] display ${display.id}: ${ready.mimeType} -> ${ready.replayFile}, ` +
          `${ready.width}x${ready.height}`,
      )
    }
    ipcMain.on(IPC.captureError, onError)
    ipcMain.on(IPC.captureReady, onReady)
    win.webContents.on('render-process-gone', (_event, details) => {
      setDisplayRecorderState(display.id, {
        status: 'stopped',
        reason: 'process-stopped',
        detail: `recorder renderer stopped: ${details.reason}`,
      })
    })
    win.on('closed', () => {
      ipcMain.removeListener(IPC.captureError, onError)
      ipcMain.removeListener(IPC.captureReady, onReady)
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
