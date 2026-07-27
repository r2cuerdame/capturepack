// First-launch welcome window (GOAL "Welcome (first launch after install)"):
// a tray app that opens nothing after install leaves the user with no idea what
// happened. Once — on a genuinely fresh install — a small dark window says the
// app is running in the tray, prints the LIVE capture hotkey, the three steps
// (capture / annotate / save, with the real output folder), the tray-opens-
// History line and the MCP line, and offers [Try it now] [Settings] [Done].
//
// Single-instance and NOT alwaysOnTop (it is an introduction, not a prompt);
// Esc closes it from the renderer; it opens on the display holding the cursor.
// Nothing here is hardcoded: every value comes from the live settings object.
import { app, BrowserWindow, ipcMain, screen } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import * as path from 'node:path'
import { IPC } from '../shared/ipc'
import type { WelcomeInfoResult } from '../shared/ipc'
import type { Settings } from '../shared/types'
import { uiLanguage, uiT } from './locale'
import { persistSettings } from './settings'

// CONTENT size (useContentSize below), not window size: on Windows a plain
// `height` includes the title bar and borders, which took ~39px off a layout
// that never scrolls — enough to clip the footer hint, and the action row with
// it, in the longer languages (es/pt/fr/de) or with a long output path.
const WIDTH = 560
const HEIGHT = 570
// [Try it now] closes the window before capturing. The desktop is FROZEN by the
// capture, so the window has to be gone from the composited frame first — a
// close() is not on screen until the compositor has drawn the next frame.
const TRY_NOW_DELAY_MS = 220

export interface WelcomeHooks {
  // The capture action the global hotkey triggers — the SAME closure index.ts
  // binds to the tray and the accelerator, so [Try it now] cannot drift into a
  // second, subtly different capture entry point.
  onCapture: () => void
  onOpenSettings: () => void
}

let welcomeWindow: BrowserWindow | null = null
// The live settings object (the one index.ts shares), so the hotkey and output
// folder the window prints are whatever they are at call time.
let liveSettings: Settings | null = null
let hooks: WelcomeHooks | null = null
// Reads the endpoint the RUNNING MCP server bound. NOT rebuilt from settings:
// mcpEnabled alone does not mean a server exists (mcpAutoStart is a GUI toggle
// that leaves it unstarted), a taken port disables it for the run, and a later
// mcpPort change only takes effect after a restart — the window must never
// print a URL nothing is listening on. '' ⇒ the endpoint row stays hidden.
let mcpEndpoint: () => string = () => ''

/**
 * Registers the welcome:* IPC around the live settings object. Call once at
 * startup, before the window can open (first run, --show-welcome, or About's
 * "Show welcome again").
 *
 * `liveMcpEndpoint` is read at call time (not captured here) because the MCP
 * server binds asynchronously: at registration the listen callback may not have
 * run yet.
 */
export function registerWelcomeIpc(
  live: Settings,
  welcomeHooks: WelcomeHooks,
  liveMcpEndpoint: () => string,
): void {
  liveSettings = live
  hooks = welcomeHooks
  mcpEndpoint = liveMcpEndpoint

  // Same sender rule as every other window's channels: only the welcome window
  // itself talks on welcome:*.
  ipcMain.handle(IPC.welcomeGet, (event): WelcomeInfoResult => {
    if (!fromWelcomeWindow(event)) throw new Error('welcome:get: unexpected sender')
    return welcomeInfo(live)
  })

  ipcMain.on(IPC.welcomeTryNow, (event) => {
    if (!fromWelcomeWindow(event)) return
    tryNow()
  })

  ipcMain.on(IPC.welcomeOpenSettings, (event) => {
    if (!fromWelcomeWindow(event)) return
    hooks?.onOpenSettings()
  })
}

/** Opens the welcome window, or focuses the already-open one (single-instance). */
export function openWelcomeWindow(): void {
  if (welcomeWindow !== null && !welcomeWindow.isDestroyed()) {
    // No restore() branch: the window is created with minimizable: false.
    welcomeWindow.focus()
    return
  }
  const work = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const win = new BrowserWindow({
    // Centered on the display holding the cursor (GOAL) — that is where the
    // user is looking, which on a multi-monitor desk is rarely the primary.
    x: Math.round(Math.max(work.x, work.x + (work.width - WIDTH) / 2)),
    y: Math.round(Math.max(work.y, work.y + (work.height - HEIGHT) / 2)),
    width: WIDTH,
    height: HEIGHT,
    // WIDTH/HEIGHT are the web viewport, so the CSS layout gets exactly what it
    // was designed for on every platform's frame.
    useContentSize: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    backgroundColor: '#121216',
    // Pre-load title only: the renderer document title (localized via data-i18n)
    // replaces it as soon as the page loads. Localized here too, like About and
    // Settings, so a non-English user never sees an English taskbar entry.
    title: liveSettings !== null ? uiT(liveSettings)('welcome.windowTitle') : 'CapturePack',
    show: false,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist', 'preload', 'welcome.js'),
    },
  })
  win.setMenuBarVisibility(false)
  // The x/y above were computed from the CONTENT size; the frame makes the real
  // window a little bigger, so re-center on the actual bounds. Done before the
  // window is ever shown, so there is nothing to see move.
  const outer = win.getBounds()
  win.setPosition(
    Math.round(Math.max(work.x, work.x + (work.width - outer.width) / 2)),
    Math.round(Math.max(work.y, work.y + (work.height - outer.height) / 2)),
  )
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (welcomeWindow === win) welcomeWindow = null
  })
  void win.loadFile(path.join(app.getAppPath(), 'dist', 'renderer', 'welcome', 'welcome.html'))
  welcomeWindow = win
  markShown()
}

/**
 * [Try it now]: close the window, THEN capture (GOAL). The capture freezes the
 * desktop, so the introduction must not end up inside the user's very first
 * pack — hence close first, and give the compositor a beat to drop it from the
 * screen before the frame is grabbed.
 */
function tryNow(): void {
  const capture = hooks?.onCapture
  if (capture === undefined) return
  const win = welcomeWindow
  if (win === null || win.isDestroyed()) {
    capture()
    return
  }
  win.once('closed', () => setTimeout(capture, TRY_NOW_DELAY_MS))
  win.close()
}

/**
 * Remembers that the window has been shown (GOAL "Shown once"), written
 * immediately rather than at exit: a crash before the next clean shutdown must
 * not bring the welcome window back on the following launch.
 */
function markShown(): void {
  const live = liveSettings
  if (live === null || live.welcomeShown) return
  // Mutated in place: index.ts and the settings GUI hold this exact object.
  live.welcomeShown = true
  try {
    persistSettings({ ...live })
  } catch (err) {
    // Unwritable disk: the window simply shows again next launch. Nothing here
    // is worth failing a startup over.
    console.error(
      'capturepack: could not persist welcomeShown:',
      err instanceof Error ? err.message : err,
    )
  }
}

function welcomeInfo(live: Settings): WelcomeInfoResult {
  return {
    uiLanguage: uiLanguage(live),
    hotkey: live.captureHotkey,
    outputDir: live.outputDir,
    replaySeconds: live.replaySeconds,
    mcpUrl: mcpEndpoint(),
  }
}

// A message must come from the welcome window itself; anything else is ignored.
function fromWelcomeWindow(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  if (welcomeWindow === null || welcomeWindow.isDestroyed()) return false
  return event.sender === welcomeWindow.webContents
}
