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
import type { CaptureReplayResultPayload, CaptureStartPayload } from '../shared/ipc'
import type { Settings } from '../shared/types'

const HOTPLUG_DEBOUNCE_MS = 1_000

// display.id -> that display's hidden recorder window.
const captureWindows = new Map<number, BrowserWindow>()
// display.id -> the recorder parameters its window was built with; rebuild()
// keeps a window (and its replay buffer) when the signature is unchanged, so
// only the affected recorders restart (GOAL "Multi-Monitor Support").
const captureWindowSigs = new Map<number, string>()
// webContents.id -> display id string; the display-media handler routes by this.
const assignedDisplays = new Map<number, string>()

let currentSettings: Settings | null = null
// Bumped on every requested rebuild; queued rebuilds that lost the race bail out.
let generation = 0
// Serializes rebuilds so hotplug bursts and restartCapture never interleave.
let rebuildChain: Promise<void> = Promise.resolve()
let hotplugTimer: ReturnType<typeof setTimeout> | undefined
let watchingDisplays = false

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
export async function takeSnapshot(
  display: Display,
  options: { exact?: boolean } = {},
): Promise<{ png: Buffer; width: number; height: number }> {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor),
    },
  })
  const matched = sources.find((s) => s.display_id === String(display.id))
  const source = matched ?? (options.exact === true ? undefined : sources[0])
  if (!source) throw new Error(`no screen source available for display ${display.id}`)
  const size = source.thumbnail.getSize()
  return { png: source.thumbnail.toPNG(), width: size.width, height: size.height }
}

// Asks a capture window for its current replay blob. Resolves null on timeout,
// when the renderer reports no footage (empty buffer), or when the window is
// destroyed mid-request (hotplug rebuild).
export function requestReplay(
  win: BrowserWindow,
  requestId: string,
  timeoutMs: number,
): Promise<{ buffer: Buffer; durationMs: number } | null> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined

    const onResult = (_event: IpcMainEvent, payload: CaptureReplayResultPayload): void => {
      if (payload.requestId !== requestId) return
      cleanup()
      if (payload.buffer.byteLength === 0) resolve(null)
      else resolve({ buffer: Buffer.from(payload.buffer), durationMs: payload.durationMs })
    }
    const onClosed = (): void => {
      cleanup()
      resolve(null)
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      ipcMain.removeListener(IPC.captureReplayResult, onResult)
      win.removeListener('closed', onClosed)
    }

    if (win.isDestroyed()) {
      resolve(null)
      return
    }
    ipcMain.on(IPC.captureReplayResult, onResult)
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
    .catch((err) => console.error('[capture] recorder rebuild failed:', String(err)))
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
    if (!win.isDestroyed()) win.destroy()
    captureWindows.delete(id)
    captureWindowSigs.delete(id)
  }
  if (settings === null) return

  for (const display of displays) {
    if (captureWindows.has(display.id)) continue
    try {
      captureWindows.set(display.id, await createCaptureWindow(display, settings))
      captureWindowSigs.set(display.id, recorderSignature(display, settings))
    } catch (err) {
      console.error(`[capture] recorder for display ${display.id} failed to start: ${String(err)}`)
    }
  }
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
        console.error(
          `[capture] recorder for display ${display.id} failed, continuing screenshot-only: ${String(message)}`,
        )
      }
    }
    ipcMain.on(IPC.captureError, onError)
    win.on('closed', () => {
      ipcMain.removeListener(IPC.captureError, onError)
      assignedDisplays.delete(wcId)
    })

    await win.loadFile(path.join(__dirname, '../renderer/capture/capture.html'))

    const payload: CaptureStartPayload = {
      displayId: String(display.id),
      fps: settings.fps,
      // The recorder rotates segments at this interval; replay covers 1x..2x of it.
      segmentSeconds: settings.replaySeconds,
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
