// Save-complete toast (replaces the old Notification): a small frameless
// always-on-top window bottom-right with [Open Folder] [Copy Folder Path]
// [Copy Prompt], the blur warning line when the pack contains a
// blurred box, and the background render status. Auto-closes after 30 s.
import { app, BrowserWindow, clipboard, ipcMain, screen, shell } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import * as path from 'node:path'
import { IPC } from '../shared/ipc'
import type {
  ReplayUnavailablePayload,
  ToastInitPayload,
  ToastRenderState,
} from '../shared/ipc'
import { analyzePackPrompt } from '../shared/prompt'
import { copyTextToClipboard } from './clipboard'

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
}): void {
  registerToastIpc()
  if (active !== null && !active.win.isDestroyed()) active.win.close()
  active = null

  const work = screen.getPrimaryDisplay().workArea
  const height = TOAST_HEIGHT + (options.replayUnavailable === null ? 0 : REPLAY_WARNING_HEIGHT)
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
  const toast: ActiveToast = { win, folderPath: options.folderPath, timer: null, ceiling }
  armAutoClose(toast, options.renderState)
  win.on('closed', () => {
    if (toast.timer !== null) clearTimeout(toast.timer)
    clearTimeout(toast.ceiling)
    if (active?.win === win) active = null
  })

  win.webContents.on('did-finish-load', () => {
    const init: ToastInitPayload = {
      folderName: path.basename(options.folderPath),
      folderPath: options.folderPath,
      hasBlur: options.hasBlur,
      replayUnavailable: options.replayUnavailable,
      renderState: options.renderState,
      uiLanguage: options.uiLanguage,
    }
    win.webContents.send(IPC.toastInit, init)
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
  active.win.webContents.send(IPC.toastRenderStatus, {
    state,
    ...(progress === undefined ? {} : { progress }),
  })
  // A terminal state is when the countdown may finally start.
  armAutoClose(active, state)
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

  ipcMain.on(IPC.toastClose, (event) => {
    const toast = fromActiveToast(event)
    if (toast === null) return
    toast.win.close()
  })

}
