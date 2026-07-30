// Multi-display image-region selector.
//
// IMPORTANT PRIVACY BOUNDARY: the caller freezes source images BEFORE calling
// this module. This module accepts only display geometry and returns only crop
// geometry; it has no image bytes, paths, desktopCapturer access or persistence
// API. A region capture therefore cannot accidentally retain pixels outside
// the rectangle the user explicitly chose.
import { app, BrowserWindow, ipcMain } from 'electron'
import type { IpcMainEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import { IPC } from '../shared/ipc'
import type {
  ImageRegionSelectorCommitPayload,
  ImageRegionSelectorDragPayload,
  ImageRegionSelectorFocusPayload,
  ImageRegionSelectorInitPayload,
  ImageRegionSelectorPreviewPayload,
} from '../shared/ipc'
import type { Language } from '../shared/i18n'
import {
  imageVirtualDesktopDipBounds,
  preferredImageRegionDisplay,
  resolveImageDesktopRegion,
  validImageRegionDisplay,
} from '../shared/imageRegion'
import type {
  ImageRegionPoint,
  ImageRegionRect,
  ImageRegionSelection,
  ImageRegionSelectorDisplay,
} from '../shared/imageRegion'
import {
  layoutImageDesktop,
  type ImageDesktopLayout,
} from './imageDesktop'

const STARTUP_TIMEOUT_MS = 8_000
const INTERACTION_TIMEOUT_MS = 2 * 60_000

export interface ImageRegionSelectorOptions {
  /**
   * Exact metadata for every source image frozen by the caller. Bounds are
   * Electron virtual-desktop DIP; pixelSize is the corresponding PNG's actual
   * native size. The selector never receives the PNG itself.
   */
  displays: readonly ImageRegionSelectorDisplay[]
  /** Display that held the trigger/cursor when the source images were frozen. */
  focusedDisplayId: string
  /** Language of the settings snapshot that initiated this selector. */
  uiLanguage: Language
  /** Test/diagnostic override; normal callers omit it. */
  startupTimeoutMs?: number
  /** Test/diagnostic override; normal callers omit it. */
  interactionTimeoutMs?: number
}

interface OverlayRecord {
  display: ImageRegionSelectorDisplay
  win: BrowserWindow
  ready: boolean
}

interface ActiveSelector {
  requestId: string
  records: OverlayRecord[]
  displays: ImageRegionSelectorDisplay[]
  layout: ImageDesktopLayout
  desktopBounds: ImageRegionRect
  dragStart: ImageRegionPoint | null
  dragLast: ImageRegionPoint | null
  focusedDisplayId: string
  uiLanguage: Language
  resolve: (selection: ImageRegionSelection | null) => void
  startupTimer: NodeJS.Timeout | null
  interactionTimer: NodeJS.Timeout | null
  interactionTimeoutMs: number
  settled: boolean
}

let active: ActiveSelector | null = null
let ipcRegistered = false

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function finiteRect(value: unknown): ImageRegionRect | null {
  const raw = recordOf(value)
  if (raw === null) return null
  const { x, y, width, height } = raw
  if (
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y) ||
    typeof width !== 'number' ||
    !Number.isFinite(width) ||
    typeof height !== 'number' ||
    !Number.isFinite(height)
  ) {
    return null
  }
  return { x, y, width, height }
}

function finitePoint(value: unknown): ImageRegionPoint | null {
  const raw = recordOf(value)
  if (
    raw === null ||
    typeof raw.x !== 'number' ||
    !Number.isFinite(raw.x) ||
    typeof raw.y !== 'number' ||
    !Number.isFinite(raw.y)
  ) {
    return null
  }
  return { x: raw.x, y: raw.y }
}

function dragOf(value: unknown): ImageRegionSelectorDragPayload | null {
  const raw = recordOf(value)
  if (
    raw === null ||
    typeof raw.requestId !== 'string' ||
    (raw.phase !== 'start' && raw.phase !== 'move' && raw.phase !== 'end')
  ) {
    return null
  }
  const desktopDipPoint = finitePoint(raw.desktopDipPoint)
  return desktopDipPoint === null
    ? null
    : { requestId: raw.requestId, phase: raw.phase, desktopDipPoint }
}

function senderRecord(event: IpcMainEvent): { flow: ActiveSelector; record: OverlayRecord } | null {
  const flow = active
  if (flow === null || flow.settled) return null
  const record = flow.records.find((candidate) => event.sender === candidate.win.webContents)
  return record === undefined ? null : { flow, record }
}

function requestMatches(payload: unknown, requestId: string): payload is { requestId: string } {
  return recordOf(payload)?.requestId === requestId
}

function commitOf(value: unknown): ImageRegionSelectorCommitPayload | null {
  const raw = recordOf(value)
  if (raw === null || typeof raw.requestId !== 'string') return null
  if (raw.mode === 'fullscreen') {
    return { requestId: raw.requestId, mode: 'fullscreen' }
  }
  if (raw.mode !== 'region') return null
  const localDipRect = finiteRect(raw.localDipRect)
  return localDipRect === null
    ? null
    : { requestId: raw.requestId, mode: 'region', localDipRect }
}

function broadcastFocus(flow: ActiveSelector): void {
  for (const record of flow.records) {
    if (record.win.isDestroyed() || record.win.webContents.isDestroyed()) continue
    const payload: ImageRegionSelectorFocusPayload = {
      requestId: flow.requestId,
      focused: record.display.id === flow.focusedDisplayId,
    }
    record.win.webContents.send(IPC.imageRegionFocus, payload)
  }
}

function revalidateFocusedBounds(flow: ActiveSelector): void {
  // `showInactive()` is not a focus activation. Windows may run another
  // DPI/non-client sizing pass when `show(); focus()` follows, so inspect all
  // HWNDs on the next turn and fail the whole selector closed if one moved.
  setImmediate(() => {
    if (active !== flow || flow.settled) return
    for (const record of flow.records) {
      if (record.win.isDestroyed()) {
        settle(flow, null)
        return
      }
      const actual = record.win.getBounds()
      const expected = record.display.bounds
      if (
        actual.x !== expected.x ||
        actual.y !== expected.y ||
        actual.width !== expected.width ||
        actual.height !== expected.height
      ) {
        console.error(
          'capturepack: focused image selector changed display bounds ' +
            `${record.display.index}: expected ` +
            `${expected.x},${expected.y} ${expected.width}x${expected.height}; got ` +
            `${actual.x},${actual.y} ${actual.width}x${actual.height}`,
        )
        settle(flow, null)
        return
      }
    }
  })
}

function focusCurrent(flow: ActiveSelector): void {
  // A rapid second hotkey may arrive while preload scripts are still loading.
  // Do not let that convenience focus punch one visible/click-blocking window
  // into the desktop before the other monitors have installed their listeners.
  if (flow.records.some((record) => !record.ready)) return
  const record =
    flow.records.find((candidate) => candidate.display.id === flow.focusedDisplayId) ??
    flow.records[0]
  if (record === undefined || record.win.isDestroyed()) return
  record.win.show()
  record.win.focus()
  revalidateFocusedBounds(flow)
}

function dragRect(flow: ActiveSelector): ImageRegionRect | null {
  if (flow.dragStart === null || flow.dragLast === null) return null
  return {
    x: Math.min(flow.dragStart.x, flow.dragLast.x),
    y: Math.min(flow.dragStart.y, flow.dragLast.y),
    width: Math.abs(flow.dragLast.x - flow.dragStart.x),
    height: Math.abs(flow.dragLast.y - flow.dragStart.y),
  }
}

function broadcastPreview(flow: ActiveSelector, rect: ImageRegionRect | null): void {
  const payload: ImageRegionSelectorPreviewPayload = {
    requestId: flow.requestId,
    desktopDipRect: rect,
  }
  for (const record of flow.records) {
    if (!record.win.isDestroyed() && !record.win.webContents.isDestroyed()) {
      record.win.webContents.send(IPC.imageRegionPreview, payload)
    }
  }
}

function allReady(flow: ActiveSelector): void {
  if (flow.settled || flow.records.some((record) => !record.ready)) return
  if (flow.startupTimer !== null) {
    clearTimeout(flow.startupTimer)
    flow.startupTimer = null
  }

  // Windows/Electron can clamp a frameless window created non-resizable to the
  // PRIMARY work area. On the reported desk that changed BOTH overlays to
  // 1392 px high, leaving the bottom 528 px of the 1200x1920 portrait display
  // uncovered and impossible to select. Creation stays resizable (manual
  // resizing is vetoed below), and every native window must prove it covers
  // its complete Display bounds — taskbar included — before any of them show.
  for (const record of flow.records) {
    if (record.win.isDestroyed()) {
      settle(flow, null)
      return
    }
    record.win.setBounds(record.display.bounds)
    const actual = record.win.getBounds()
    const expected = record.display.bounds
    if (
      actual.x !== expected.x ||
      actual.y !== expected.y ||
      actual.width !== expected.width ||
      actual.height !== expected.height
    ) {
      console.error(
        'capturepack: image selector did not cover display ' +
          `${record.display.index}: expected ` +
          `${expected.x},${expected.y} ${expected.width}x${expected.height}; got ` +
          `${actual.x},${actual.y} ${actual.width}x${actual.height}`,
      )
      settle(flow, null)
      return
    }
  }

  // Reveal the whole virtual desk as one visual operation. Progressive showing
  // used to leave a real desktop strip clickable while another renderer was
  // still loading; all overlays must prove their listeners are installed first.
  for (const record of flow.records) {
    if (!record.win.isDestroyed()) record.win.showInactive()
  }
  // Activation can run a second Windows sizing pass. Re-read the native
  // bounds after showInactive as well; if DPI/window-manager activation changed
  // even one overlay, close the complete selector instead of leaving a visible
  // but clickable desktop hole.
  for (const record of flow.records) {
    if (record.win.isDestroyed()) {
      settle(flow, null)
      return
    }
    const actual = record.win.getBounds()
    const expected = record.display.bounds
    if (
      actual.x !== expected.x ||
      actual.y !== expected.y ||
      actual.width !== expected.width ||
      actual.height !== expected.height
    ) {
      console.error(
        'capturepack: visible image selector changed display bounds ' +
          `${record.display.index}: expected ` +
          `${expected.x},${expected.y} ${expected.width}x${expected.height}; got ` +
          `${actual.x},${actual.y} ${actual.width}x${actual.height}`,
      )
      settle(flow, null)
      return
    }
  }
  broadcastFocus(flow)
  focusCurrent(flow)
  flow.interactionTimer = setTimeout(() => {
    if (active === flow) {
      console.error('capturepack: image region selector timed out waiting for a choice')
      settle(flow, null)
    }
  }, flow.interactionTimeoutMs)
}

function settle(flow: ActiveSelector, selection: ImageRegionSelection | null): void {
  if (flow.settled) return
  flow.settled = true
  if (active === flow) active = null
  if (flow.startupTimer !== null) clearTimeout(flow.startupTimer)
  if (flow.interactionTimer !== null) clearTimeout(flow.interactionTimer)
  flow.startupTimer = null
  flow.interactionTimer = null

  // Clear the global gate BEFORE destroying windows: each destroy synchronously
  // emits `closed`, and that event must see an already-settled flow rather than
  // recursively trying to cancel it.
  for (const record of flow.records) {
    if (!record.win.isDestroyed()) record.win.destroy()
  }
  flow.resolve(selection)
}

function registerIpc(): void {
  if (ipcRegistered) return
  ipcRegistered = true

  ipcMain.on(IPC.imageRegionReady, (event, payload: unknown) => {
    const found = senderRecord(event)
    if (found === null || !requestMatches(payload, found.flow.requestId)) return
    if (found.record.ready) return
    found.record.ready = true
    allReady(found.flow)
  })

  ipcMain.on(IPC.imageRegionDrag, (event, payload: unknown) => {
    const found = senderRecord(event)
    if (found === null) return
    const drag = dragOf(payload)
    if (drag === null || drag.requestId !== found.flow.requestId) return
    const bounds = found.record.display.bounds
    const point = drag.desktopDipPoint
    if (
      point.x < bounds.x ||
      point.y < bounds.y ||
      point.x > bounds.x + bounds.width ||
      point.y > bounds.y + bounds.height
    ) {
      return
    }
    if (drag.phase === 'start') {
      found.flow.dragStart = point
      found.flow.dragLast = point
      broadcastPreview(found.flow, dragRect(found.flow))
      return
    }
    if (found.flow.dragStart === null) return
    found.flow.dragLast = point
    const rect = dragRect(found.flow)
    broadcastPreview(found.flow, rect)
    if (drag.phase !== 'end' || rect === null) return

    const region = resolveImageDesktopRegion(
      found.flow.displays,
      found.flow.layout,
      rect,
    )
    if (region === null) {
      found.flow.dragStart = null
      found.flow.dragLast = null
      broadcastPreview(found.flow, null)
      return
    }
    const focused =
      found.flow.displays.find((display) => display.id === found.flow.focusedDisplayId) ??
      found.flow.displays[0]
    if (focused === undefined) return
    const preferred =
      preferredImageRegionDisplay(
        found.flow.displays,
        region.desktopDipRect,
        focused.id,
      ) ?? focused
    settle(found.flow, {
      mode: 'region',
      displayId: preferred.id,
      displayIndex: preferred.index,
      pixelRect: region.compositePixelRect,
      desktopDipRect: region.desktopDipRect,
    })
  })

  ipcMain.on(IPC.imageRegionCommit, (event, payload: unknown) => {
    const found = senderRecord(event)
    if (found === null) return
    const commit = commitOf(payload)
    if (commit === null || commit.requestId !== found.flow.requestId) return
    const focused =
      found.flow.displays.find((display) => display.id === found.flow.focusedDisplayId) ??
      found.flow.displays[0]
    if (focused === undefined) return
    const selection: ImageRegionSelection | null =
      commit.mode === 'fullscreen'
        ? {
            mode: 'fullscreen',
            displayId: focused.id,
            displayIndex: focused.index,
            pixelRect: {
              x: 0,
              y: 0,
              width: found.flow.layout.width,
              height: found.flow.layout.height,
            },
            desktopDipRect: { ...found.flow.desktopBounds },
          }
        : (() => {
            const region = resolveImageDesktopRegion(
              found.flow.displays,
              found.flow.layout,
              {
                x: found.record.display.bounds.x + commit.localDipRect.x,
                y: found.record.display.bounds.y + commit.localDipRect.y,
                width: commit.localDipRect.width,
                height: commit.localDipRect.height,
              },
            )
            return region === null
              ? null
              : (() => {
                  const preferred =
                    preferredImageRegionDisplay(
                      found.flow.displays,
                      region.desktopDipRect,
                      focused.id,
                    ) ?? focused
                  return {
                    mode: 'region' as const,
                    displayId: preferred.id,
                    displayIndex: preferred.index,
                    pixelRect: region.compositePixelRect,
                    desktopDipRect: region.desktopDipRect,
                  }
                })()
          })()
    // Ignore an empty rectangle and leave the selector usable. Only explicit
    // Esc or a valid choice may close the seamless virtual-desktop overlay.
    if (selection !== null) settle(found.flow, selection)
  })

  ipcMain.on(IPC.imageRegionCancel, (event, payload: unknown) => {
    const found = senderRecord(event)
    if (found === null || !requestMatches(payload, found.flow.requestId)) return
    settle(found.flow, null)
  })
}

function timeout(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : fallback
}

function validDisplays(displays: readonly ImageRegionSelectorDisplay[]): boolean {
  if (displays.length === 0) return false
  const ids = new Set<string>()
  const indices = new Set<number>()
  for (const display of displays) {
    if (
      !validImageRegionDisplay(display) ||
      !Number.isInteger(display.bounds.x) ||
      !Number.isInteger(display.bounds.y) ||
      !Number.isInteger(display.bounds.width) ||
      !Number.isInteger(display.bounds.height) ||
      ids.has(display.id) ||
      indices.has(display.index)
    ) {
      return false
    }
    ids.add(display.id)
    indices.add(display.index)
  }
  return true
}

function makeOverlay(
  flow: ActiveSelector,
  display: ImageRegionSelectorDisplay,
): OverlayRecord {
  const win = new BrowserWindow({
    ...display.bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    movable: false,
    // IMPORTANT: keep this true at the native-window layer. Electron's Windows
    // implementation can shrink a frameless `resizable: false` window to the
    // primary work area while applying its min/max constraints (electron#13043).
    // `will-resize` below vetoes user resizing without corrupting the initial
    // per-monitor bounds.
    resizable: true,
    // Preserve that construction path without WS_THICKFRAME stealing pointer
    // hits at an outer monitor edge or the seam between selector HWNDs.
    thickFrame: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    show: false,
    // The frameless selector does not expose a caption, but Windows may surface
    // this title to accessibility/switcher APIs. Keep it language-neutral; the
    // visible toolbar is localized from the settings snapshot below.
    title: 'CapturePack',
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist', 'preload', 'image-region.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.setMenuBarVisibility(false)
  win.on('will-resize', (event) => event.preventDefault())
  // `screen-saver` is the documented cross-fullscreen level. A normal
  // always-on-top window can fall behind a fullscreen app on only one monitor,
  // leaving a misleading hole in the selection surface.
  win.setAlwaysOnTop(true, 'screen-saver')
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // Esc is also owned main-side. The renderer sends the normal cancel message,
  // but this path still closes every monitor when its event loop is busy enough
  // that the DOM key handler has not run yet.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'Escape') return
    event.preventDefault()
    if (active === flow && !flow.settled) settle(flow, null)
  })

  const record: OverlayRecord = { display, win, ready: false }
  win.webContents.once('did-finish-load', () => {
    if (active !== flow || flow.settled || win.isDestroyed()) return
    const payload: ImageRegionSelectorInitPayload = {
      requestId: flow.requestId,
      display: {
        ...display,
        bounds: { ...display.bounds },
        pixelSize: { ...display.pixelSize },
      },
      desktopBounds: { ...flow.desktopBounds },
      displays: flow.displays.map((display) => ({
        ...display,
        bounds: { ...display.bounds },
        pixelSize: { ...display.pixelSize },
      })),
      layout: {
        width: flow.layout.width,
        height: flow.layout.height,
        placements: flow.layout.placements.map((placement) => ({
          id: placement.id,
          index: placement.index,
          x: placement.x,
          y: placement.y,
          width: placement.width,
          height: placement.height,
        })),
      },
      focused: display.id === flow.focusedDisplayId,
      uiLanguage: flow.uiLanguage,
    }
    win.webContents.send(IPC.imageRegionInit, payload)
  })
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.once('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame === false || active !== flow || flow.settled) return
    console.error(`capturepack: image selector failed to load (${code}): ${description}`)
    settle(flow, null)
  })
  win.webContents.once('render-process-gone', (_event, details) => {
    if (active !== flow || flow.settled) return
    console.error(`capturepack: image selector renderer exited: ${details.reason}`)
    settle(flow, null)
  })
  win.once('unresponsive', () => {
    if (active !== flow || flow.settled) return
    console.error('capturepack: image selector renderer became unresponsive')
    settle(flow, null)
  })
  win.on('focus', () => {
    if (active !== flow || flow.settled) return
    // Keep the toolbar where capture started. Pointer focus changes naturally
    // while a drag crosses overlays and must not make the toolbar jump.
    broadcastFocus(flow)
  })
  win.once('closed', () => {
    if (active === flow && !flow.settled) settle(flow, null)
  })
  void win
    .loadFile(path.join(app.getAppPath(), 'dist', 'renderer', 'image-region', 'image-region.html'))
    .catch((err: unknown) => {
      if (active !== flow || flow.settled) return
      console.error(
        'capturepack: image selector load failed:',
        err instanceof Error ? err.message : err,
      )
      settle(flow, null)
    })
  return record
}

/**
 * Opens one native overlay per frozen display and coordinates one shared drag.
 *
 * A second call while one selector is visible is rejected with `null` instead
 * of sharing the first promise: its selection belongs to the first caller's
 * frozen pixels and must never be applied to a newer screenshot.
 */
export function selectImageRegion(
  options: ImageRegionSelectorOptions,
): Promise<ImageRegionSelection | null> {
  if (active !== null && !active.settled) {
    focusCurrent(active)
    return Promise.resolve(null)
  }
  if (!validDisplays(options.displays)) {
    console.error('capturepack: image selector received invalid or duplicate display geometry')
    return Promise.resolve(null)
  }

  registerIpc()
  const requestId = randomUUID()
  let resolveResult: (selection: ImageRegionSelection | null) => void = () => undefined
  const promise = new Promise<ImageRegionSelection | null>((resolve) => {
    resolveResult = resolve
  })
  const focusedDisplayId = options.displays.some((d) => d.id === options.focusedDisplayId)
    ? options.focusedDisplayId
    : (options.displays[0]?.id ?? '')
  const displays = options.displays.map((source) => ({
    id: source.id,
    index: source.index,
    bounds: { ...source.bounds },
    scaleFactor: source.scaleFactor,
    pixelSize: { ...source.pixelSize },
  }))
  let layout: ImageDesktopLayout
  let desktopBounds: ImageRegionRect | null
  try {
    layout = layoutImageDesktop(displays)
    desktopBounds = imageVirtualDesktopDipBounds(displays)
  } catch (err) {
    console.error(
      'capturepack: image selector could not resolve the virtual desktop:',
      err instanceof Error ? err.message : err,
    )
    return Promise.resolve(null)
  }
  if (desktopBounds === null) return Promise.resolve(null)
  const flow: ActiveSelector = {
    requestId,
    records: [],
    displays,
    layout,
    desktopBounds,
    dragStart: null,
    dragLast: null,
    focusedDisplayId,
    uiLanguage: options.uiLanguage,
    resolve: resolveResult,
    startupTimer: null,
    interactionTimer: null,
    interactionTimeoutMs: timeout(options.interactionTimeoutMs, INTERACTION_TIMEOUT_MS),
    settled: false,
  }
  active = flow

  try {
    // Native per-monitor windows preserve each monitor's real DPI and
    // resolution. Main coordinates their pointer events into one drag, so the
    // interaction crosses seams without asking Windows to scale one giant
    // mixed-DPI BrowserWindow onto the primary monitor.
    for (const display of displays) {
      flow.records.push(makeOverlay(flow, display))
    }
    flow.startupTimer = setTimeout(() => {
      if (active === flow) {
        console.error('capturepack: image region selector timed out during startup')
        settle(flow, null)
      }
    }, timeout(options.startupTimeoutMs, STARTUP_TIMEOUT_MS))
  } catch (err) {
    console.error(
      'capturepack: image selector could not open:',
      err instanceof Error ? err.message : err,
    )
    settle(flow, null)
  }
  return promise
}

/** Cancels every overlay, for app shutdown or a parent flow abort. */
export function cancelImageRegionSelector(): void {
  if (active !== null && !active.settled) settle(active, null)
}

export function imageRegionSelectorActive(): boolean {
  return active !== null && !active.settled
}

/**
 * Native HWNDs of the temporary selector overlays currently covering the desk.
 *
 * The screenshot pixels are frozen before these windows exist, but an
 * asynchronous UIA dump can finish afterward. Main captures this exact list
 * immediately after opening the selector and removes only these HWNDs from the
 * semantic payload, including when the trigger-time window floor is unavailable.
 */
export function imageRegionSelectorWindowHandles(): string[] {
  const flow = active
  if (flow === null || flow.settled) return []
  const handles: string[] = []
  for (const record of flow.records) {
    if (record.win.isDestroyed()) continue
    try {
      const raw = record.win.getNativeWindowHandle()
      const value =
        raw.length >= 8
          ? raw.readBigUInt64LE(0)
          : raw.length >= 4
            ? BigInt(raw.readUInt32LE(0))
            : 0n
      if (value > 0n) handles.push(String(value))
    } catch {
      // No native handle means there is nothing reliable to exclude.
    }
  }
  return handles
}

// Re-export the result type from the integration module so callers need one
// import for the function and its return value.
export type { ImageRegionSelection }
