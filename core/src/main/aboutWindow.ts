// About window (GOAL "Tray Menu" > About CapturePack): a small dark window with
// the app icon, name, version, the live update state, the two slogans, the MIT
// license line, and the Website / GitHub / Report an issue / ♥ Sponsor links.
// Donation lives HERE only — never in the capture flow.
//
// Single-instance and NOT alwaysOnTop (it is a passive window, not a prompt);
// Esc closes it from the renderer. Every link is opened by THIS module from a
// hardcoded allowlist: the renderer sends a key, never a URL.
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { IPC } from '../shared/ipc'
import type { AboutInfoResult, AboutLinkKey } from '../shared/ipc'
import type { Settings } from '../shared/types'
import { previousRun } from './lifecycle'
import type { PreviousRunStatus } from './lifecycle'
import { uiLanguage, uiT } from './locale'
import { downloadedVersion, restartAndUpdate, updaterState } from './updater'
import { openWelcomeWindow } from './welcomeWindow'

const WIDTH = 420
const HEIGHT = 460

// The only URLs this app ever opens. GOAL "Landing Page": capturepack.dev is
// the one and only official domain.
const LINKS: Record<AboutLinkKey, string> = {
  website: 'https://capturepack.dev',
  github: 'https://github.com/r2cuerdame/capturepack',
  issues: 'https://github.com/r2cuerdame/capturepack/issues/new',
  sponsor: 'https://github.com/sponsors/r2cuerdame',
}

let aboutWindow: BrowserWindow | null = null
// The live settings object, for the window title and the resolved UI language.
let liveSettings: Settings | null = null
// dist/assets/icon.png as a data: URL, read once (1 KB file, never changes).
let iconDataUrl: string | null = null

/**
 * Registers the about:* IPC around the live settings object (the same one
 * index.ts shares), so a language change is picked up at call time. Call once
 * at startup, before the window can open.
 */
export function registerAboutIpc(live: Settings): void {
  liveSettings = live

  // Same sender rule as the two channels below: only the About window itself
  // talks on the about:* / updater:* channels.
  ipcMain.handle(IPC.aboutGet, (event): AboutInfoResult => {
    if (!fromAboutWindow(event)) throw new Error('about:get: unexpected sender')
    return aboutInfo(live)
  })

  ipcMain.on(IPC.aboutOpenLink, (event, key: unknown) => {
    if (!fromAboutWindow(event)) return
    const url = allowedUrl(key)
    if (url === null) return
    void shell.openExternal(url).catch((err: unknown) => {
      console.error('capturepack: could not open link:', err instanceof Error ? err.message : err)
    })
  })

  // The one way back to the first-launch introduction (GOAL "Welcome":
  // "Shown once (welcomeShown); re-openable from About").
  ipcMain.on(IPC.aboutShowWelcome, (event) => {
    if (!fromAboutWindow(event)) return
    openWelcomeWindow()
  })

  ipcMain.on(IPC.updaterRestart, (event) => {
    if (!fromAboutWindow(event)) return
    // Only ever from a genuinely downloaded update: quitAndInstall has nothing
    // to install otherwise, and a live replay buffer is not worth risking on a
    // stray message. Gated on the STICKY downloaded version, not the transient
    // state — a later check momentarily reports 'checking'/'available' while
    // the installable file is still sitting on disk.
    if (downloadedVersion() === null) return
    restartAndUpdate()
  })
}

/** Opens the About window, or focuses the already-open one (single-instance). */
export function openAboutWindow(): void {
  if (aboutWindow !== null && !aboutWindow.isDestroyed()) {
    // No restore() branch: the window is created with minimizable: false.
    aboutWindow.focus()
    return
  }
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    backgroundColor: '#121216',
    // Pre-load title only: the renderer document title (localized via
    // data-i18n) replaces it as soon as the page loads. Localized here too, the
    // same way History/Settings do it, so a non-English user never sees an
    // English taskbar entry flash by.
    title: liveSettings !== null ? uiT(liveSettings)('about.windowTitle') : 'CapturePack',
    show: false,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist', 'preload', 'about.js'),
    },
  })
  win.setMenuBarVisibility(false)
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (aboutWindow === win) aboutWindow = null
  })
  void win.loadFile(path.join(app.getAppPath(), 'dist', 'renderer', 'about', 'about.html'))
  aboutWindow = win
}

/**
 * Pushes a fresh snapshot to an open About window — called when the updater
 * state changes and when the UI language changes. No-op when closed.
 */
export function pushAboutState(): void {
  if (aboutWindow === null || aboutWindow.isDestroyed()) return
  if (liveSettings === null) return
  aboutWindow.webContents.send(IPC.aboutState, aboutInfo(liveSettings))
}

function aboutInfo(live: Settings): AboutInfoResult {
  const previous = previousRun()
  return {
    version: app.getVersion(),
    iconDataUrl: appIconDataUrl(),
    uiLanguage: uiLanguage(live),
    updater: updaterState(),
    downloadedVersion: downloadedVersion(),
    // "Was it running?" answered without a terminal (issue #61): the startup
    // balloon fades, this line does not.
    lastRun:
      previous === null
        ? { status: 'none', endedAt: null }
        : { status: lastRunStatus(previous.status), endedAt: previous.record.lastAliveAt },
  }
}

/**
 * The SAME verdict lifecycle computes for the log and the startup balloon, just
 * named for the wire — so no two surfaces can tell the user different stories.
 *
 * It used to be `previousRunVanished() ? 'unclean' : 'clean'`, which folded
 * 'replaced' and 'faulted' into "closed normally". Neither of those runs closed
 * normally: one was cut short by an installer with nobody watching how it ended
 * (and a genuine crash minutes before an update landed in the same bucket), and
 * the other kept going after errors nobody handled. Reporting either as a clean
 * shutdown is the exact failure this release is about.
 */
function lastRunStatus(status: PreviousRunStatus): AboutInfoResult['lastRun']['status'] {
  switch (status) {
    case 'vanished':
      return 'unclean'
    case 'replaced':
      return 'unknown'
    case 'faulted':
      return 'faulted'
    case 'clean':
      return 'clean'
  }
}

// A message must come from the About window itself; anything else is ignored.
function fromAboutWindow(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  if (aboutWindow === null || aboutWindow.isDestroyed()) return false
  return event.sender === aboutWindow.webContents
}

// Maps a renderer-supplied key onto the allowlist above. Unknown values (and
// non-strings) resolve to null, so no URL can be smuggled in from a renderer.
function allowedUrl(key: unknown): string | null {
  if (typeof key !== 'string') return null
  return Object.prototype.hasOwnProperty.call(LINKS, key) ? LINKS[key as AboutLinkKey] : null
}

// The window renders the icon from a data: URL (CSP img-src 'self' data:) so
// the renderer never touches file://. An unreadable icon just means no image.
function appIconDataUrl(): string {
  if (iconDataUrl !== null) return iconDataUrl
  try {
    const file = path.join(app.getAppPath(), 'dist', 'assets', 'icon.png')
    iconDataUrl = `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`
  } catch (err) {
    console.error('capturepack: could not read app icon:', err instanceof Error ? err.message : err)
    iconDataUrl = ''
  }
  return iconDataUrl
}
