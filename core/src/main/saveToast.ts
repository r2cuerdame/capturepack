// Save-complete toast (replaces the old Notification): a small frameless
// always-on-top window bottom-right with [Open Folder] [Copy Folder Path]
// [Copy Prompt], the blur warning line when the pack contains a
// blurred box, and the background render status. Auto-closes after 30 s.
import { app, BrowserWindow, clipboard, ipcMain, screen, shell } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { IPC } from '../shared/ipc'
import type {
  ActionRetryResult,
  ReplayUnavailablePayload,
  ToastActionResultsPayload,
  ToastInitPayload,
  ToastRenderState,
} from '../shared/ipc'
import { type ActionResult, mergeActionResults } from '../shared/actions'
import { stripUtf8Bom } from '../shared/json'
import { analyzePackPrompt } from '../shared/prompt'
import { copyTextToClipboard } from './clipboard'
import type { Settings } from '../shared/types'
import { readActionResults, retryAction } from './actions/host'
import { readSettings } from './settings'

const TOAST_WIDTH = 420
const TOAST_HEIGHT = 180
// The replay-unavailable line is two lines of 12px text plus the column gap.
// The window is fixed-size and clips, so the room is made here rather than
// letting the one warning that matters fall off the bottom edge.
const REPLAY_WARNING_HEIGHT = 44
const TOAST_MARGIN = 16
const AUTO_CLOSE_MS = 30_000
// Hard ceiling for a toast held open by work in flight: a render that never
// reports a terminal state must not leave the toast on screen forever.
const MAX_OPEN_MS = 5 * 60_000

interface ActiveToast {
  win: BrowserWindow
  folderPath: string
  // The 30 s auto-close, armed only once nothing is in flight (see below).
  timer: NodeJS.Timeout | null
  ceiling: NodeJS.Timeout
  actionResults: ActionResult[]
  replayUnavailable: ReplayUnavailablePayload | null
  // The LATEST render status, not the one the toast opened with: a render or
  // an action can report before the page has loaded, and a message sent then
  // is lost — did-finish-load replays these instead of the opening values.
  renderState: ToastRenderState
  renderProgress: number | undefined
  loaded: boolean
}

/**
 * The toast's fixed height for what it shows. The window does not resize
 * itself and clips, so every caller sizes it from this one sum — the
 * replay-unavailable line included, which is the one warning that matters.
 */
export function toastHeight(replayUnavailable: boolean, actionCount: number): number {
  const actionExtraHeight = actionCount > 0 ? Math.min(actionCount * 32 + 16, 140) : 0
  return TOAST_HEIGHT + (replayUnavailable ? REPLAY_WARNING_HEIGHT : 0) + actionExtraHeight
}

/** True while the toast is reporting work the user is waiting on. */
function isWorking(state: ToastRenderState): boolean {
  return state === 'trimming' || state === 'rendering' || state === 'image-rendering'
}

/**
 * Arms the auto-close. Deliberately NOT armed while the toast is reporting
 * 'trimming' or 'rendering': both are REAL-TIME passes over the replay, so a
 * 30-60 s capture routinely outlives a fixed 30 s timer — and a toast that
 * closed itself mid-render takes [Open Folder], [Copy Folder Path],
 * [Create ZIP] and [Copy Prompt] with it and can never report the result.
 */
function armAutoClose(toast: ActiveToast, state: ToastRenderState): void {
  if (toast.timer !== null) {
    clearTimeout(toast.timer)
    toast.timer = null
  }
  if (isWorking(state)) return
  toast.timer = setTimeout(() => {
    if (!toast.win.isDestroyed()) toast.win.close()
  }, AUTO_CLOSE_MS)
}

// One toast at a time: a new save replaces the previous toast.
let active: ActiveToast | null = null
let ipcRegistered = false
// The running app's settings object, which the settings GUI mutates in place.
// readSettings() re-reads settings.json and re-arms an --output-dir override
// the user may since have replaced, so the toast only falls back to it when no
// live object was handed over.
let liveSettings: Settings | null = null

/** Call once at startup (after settings load) with the live settings object. */
export function setToastLiveSettings(live: Settings): void {
  liveSettings = live
}

/**
 * The exact Copy Prompt text (FIXED CONTRACT — do not reword). It lives in
 * shared/prompt.ts because Settings > MCP copies the same instructions for a
 * connected server (issue #56) and the two must never drift; this re-export
 * keeps every existing main-process caller pointing at one function.
 */
export const analyzePrompt = analyzePackPrompt

export function showSaveToast(options: {
  folderPath: string
  hasBlur: boolean
  // A display was not recording at the trigger (GOAL "Say that you are
  // recording"): the toast states it instead of leaving the user to find a
  // pack with no replay in it. null = every captured display delivered.
  replayUnavailable: ReplayUnavailablePayload | null
  renderState: ToastRenderState
  // Resolved UI language for the toast strings (shared/i18n Language).
  uiLanguage: string
  // The caller's live settings; remembered for later updates and retries.
  settings?: Settings
}): void {
  registerToastIpc()
  if (options.settings !== undefined) liveSettings = options.settings
  if (active !== null && !active.win.isDestroyed()) active.win.close()
  active = null

  const work = screen.getPrimaryDisplay().workArea
  const actionResults = readActionResults(options.folderPath)
  const height = toastHeight(options.replayUnavailable !== null, actionResults.length)
  const win = new BrowserWindow({
    x: work.x + work.width - TOAST_WIDTH - TOAST_MARGIN,
    y: work.y + work.height - height - TOAST_MARGIN,
    width: TOAST_WIDTH,
    height,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#1b1b20',
    show: false,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist', 'preload', 'toast.js'),
    },
  })

  const ceiling = setTimeout(() => {
    if (!win.isDestroyed()) win.close()
  }, MAX_OPEN_MS)
  const toast: ActiveToast = {
    win,
    folderPath: options.folderPath,
    timer: null,
    ceiling,
    actionResults: [...actionResults],
    replayUnavailable: options.replayUnavailable,
    renderState: options.renderState,
    renderProgress: undefined,
    loaded: false,
  }
  armAutoClose(toast, options.renderState)
  win.on('closed', () => {
    if (toast.timer !== null) clearTimeout(toast.timer)
    clearTimeout(toast.ceiling)
    if (active?.win === win) active = null
  })

  win.webContents.on('did-finish-load', () => {
    // A newer save replaced this toast, or it closed while loading: a late
    // load must not paint (or show) a window nobody is reporting into.
    if (win.isDestroyed() || active !== toast) return
    toast.loaded = true
    const settings = liveSettings ?? readSettings()
    // Whatever reached the toast or the pack while the page loaded wins over
    // what the toast opened with.
    toast.actionResults = mergeActionResults(readActionResults(options.folderPath), toast.actionResults)
    const init: ToastInitPayload = {
      folderName: path.basename(options.folderPath),
      folderPath: options.folderPath,
      hasBlur: options.hasBlur,
      replayUnavailable: options.replayUnavailable,
      renderState: toast.renderState,
      uiLanguage: options.uiLanguage,
      actionResults: toast.actionResults,
      actionConfigs: settings.actionConfigs,
    }
    win.webContents.send(IPC.toastInit, init)
    if (toast.renderProgress !== undefined) {
      win.webContents.send(IPC.toastRenderStatus, { state: toast.renderState, progress: toast.renderProgress })
    }
    fitToastHeight(toast)
    // showInactive: a toast must never steal focus from the user's work.
    win.showInactive()
  })
  void win.loadFile(path.join(app.getAppPath(), 'dist', 'renderer', 'toast', 'toast.html'))

  active = toast
}

/**
 * Flips the toast's "rendering annotated replay…" line once the background
 * render for `folderPath` finishes. No-op when the toast already closed or a
 * newer save replaced it.
 */
export function updateToastRenderStatus(
  folderPath: string,
  state: ToastRenderState,
  progress?: number,
): void {
  if (active === null || active.win.isDestroyed()) return
  if (active.folderPath !== folderPath) return
  active.renderState = state
  active.renderProgress = progress
  // Before the page loads the message would be lost; did-finish-load sends
  // the state kept above instead.
  if (active.loaded) {
    active.win.webContents.send(IPC.toastRenderStatus, {
      state,
      ...(progress === undefined ? {} : { progress }),
    })
  }
  // A terminal state is when the countdown may finally start.
  armAutoClose(active, state)
}

/** Grows the fixed-size toast to fit what it now shows; never shrinks it. */
function fitToastHeight(toast: ActiveToast): void {
  const targetHeight = toastHeight(toast.replayUnavailable !== null, toast.actionResults.length)
  const current = toast.win.getBounds()
  if (current.height >= targetHeight) return
  const work = screen.getPrimaryDisplay().workArea
  toast.win.setBounds({
    x: work.x + work.width - TOAST_WIDTH - TOAST_MARGIN,
    y: work.y + work.height - targetHeight - TOAST_MARGIN,
    width: TOAST_WIDTH,
    height: targetHeight,
  })
}

/**
 * Push updated action execution results to the toast for `folderPath`.
 */
export function updateToastActionResults(
  folderPath: string,
  results: readonly ActionResult[],
): void {
  if (active === null || active.win.isDestroyed()) return
  if (active.folderPath !== folderPath) return
  const stored = readActionResults(folderPath)
  const base = stored.length > 0 ? stored : active.actionResults
  const effective = mergeActionResults(base, results)
  active.actionResults = effective
  // Before the page loads the message would be lost; did-finish-load sends
  // the results kept above instead.
  if (active.loaded) {
    const settings = liveSettings ?? readSettings()
    const payload: ToastActionResultsPayload = {
      results: effective,
      actionConfigs: settings.actionConfigs,
    }
    active.win.webContents.send(IPC.toastActionResults, payload)
  }
  fitToastHeight(active)
}

function fromActiveToast(event: IpcMainEvent | IpcMainInvokeEvent): ActiveToast | null {
  if (active === null || active.win.isDestroyed()) return null
  return event.sender === active.win.webContents ? active : null
}

function registerToastIpc(): void {
  if (ipcRegistered) return
  ipcRegistered = true

  ipcMain.on(IPC.toastOpenFolder, (event) => {
    const toast = fromActiveToast(event)
    if (toast === null) return
    void shell.openPath(toast.folderPath)
  })

  ipcMain.on(IPC.toastCopyPath, (event) => {
    const toast = fromActiveToast(event)
    if (toast === null) return
    clipboard.writeText(toast.folderPath)
  })

  ipcMain.handle(IPC.toastCopyPrompt, async (event): Promise<boolean> => {
    const toast = fromActiveToast(event)
    if (toast === null) return false
    return copyTextToClipboard(analyzePrompt(toast.folderPath))
  })

  ipcMain.handle(IPC.toastActionResults, (event): ActionResult[] => {
    const toast = fromActiveToast(event)
    if (toast === null) return []
    const stored = readActionResults(toast.folderPath)
    return stored.length > 0 ? stored : toast.actionResults
  })

  ipcMain.handle(IPC.toastActionRetry, async (event, configId: unknown): Promise<ActionRetryResult> => {
    const toast = fromActiveToast(event)
    if (toast === null) return { ok: false, error: 'No active toast' }
    if (typeof configId !== 'string' || configId === '') {
      return { ok: false, error: 'Invalid config id' }
    }
    const settings = liveSettings ?? readSettings()
    const config = settings.actionConfigs.find((c) => c.configId === configId)
    if (config === undefined || !config.enabled) {
      return { ok: false, error: 'Action configuration is disabled or not found' }
    }
    const manifestPath = path.join(toast.folderPath, 'manifest.json')
    if (!existsSync(manifestPath)) {
      return { ok: false, error: 'Manifest not found' }
    }
    let packId = ''
    try {
      const raw = readFileSync(manifestPath, 'utf8')
      const parsed: unknown = JSON.parse(stripUtf8Bom(raw))
      if (typeof parsed === 'object' && parsed !== null) {
        const id = (parsed as Record<string, unknown>).id
        packId = typeof id === 'string' ? id : ''
      }
    } catch {
      return { ok: false, error: 'Could not read pack manifest' }
    }
    if (packId === '') {
      return { ok: false, error: 'Empty pack id' }
    }
    try {
      const result = await retryAction(
        {
          packDir: toast.folderPath,
          packId,
          packState: 'complete',
          configs: settings.actionConfigs,
          webhooks: settings.actionWebhooks,
        },
        configId,
      )
      if (result === null) {
        return { ok: false, error: 'Action retry returned no result' }
      }
      toast.actionResults = mergeActionResults(toast.actionResults, [result])
      return { ok: true, result }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.on(IPC.toastClose, (event) => {
    const toast = fromActiveToast(event)
    if (toast === null) return
    toast.win.close()
  })
}
