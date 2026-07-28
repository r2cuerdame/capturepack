// Settings GUI window (GOAL "Settings GUI"): one compact dark 760x600 window
// opened from the tray, single-instance, instant apply — no Save button. This
// module owns the settings:* IPC: every patch is validated in settings.ts
// (applyPartial, same per-key rules as settings.json loading), written to disk,
// applied to the live settings object index.ts shares with every flow, and the
// recorder-window set is rebuilt when a change affects it.
import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { IPC } from '../shared/ipc'
import type { SettingsDisplayOption, SettingsGetResult, SettingsSetResult } from '../shared/ipc'
import { resolveLanguage } from '../shared/i18n'
import type { Settings } from '../shared/types'
import { restartCapture } from './capture'
import { currentCaptureHotkey, registerCaptureHotkey } from './hotkey'
import { uiLanguage, uiT } from './locale'
import { applyPartial, clearOutputDirOverride, persistSettings } from './settings'
import { setAutoUpdateCheck } from './updater'

let settingsWindow: BrowserWindow | null = null
// The live settings object, for pre-load window chrome (title) localization.
let liveSettings: Settings | null = null

export interface SettingsIpcHooks {
  // Fired after a settings:set patch changed the UI language (instant apply:
  // index.ts rebuilds the tray and nudges the History window).
  onLanguageChanged?: () => void
  // The capture action a re-registered hotkey must trigger — the same closure
  // index.ts bound at startup, so the accelerator swap changes nothing else.
  onCapture?: () => void
  // Fired after the capture hotkey was successfully re-registered (the tray's
  // "Capture now" label shows the accelerator).
  onHotkeyChanged?: () => void
}

// Registers the settings IPC handlers around the live settings object — the
// same object index.ts hands to the capture flow, tray, and MCP server, so
// mutations here apply instantly wherever main reads settings at use time.
// Call once at startup, before the window can open.
export function registerSettingsIpc(live: Settings, hooks: SettingsIpcHooks = {}): void {
  liveSettings = live
  // Boot-time snapshot, taken before any GUI mutation is possible: the values
  // the running MCP server/watcher actually honor. The renderer's "restart to
  // apply" hints compare against this so they survive window close/reopen.
  const boot: Settings = { ...live }

  ipcMain.handle(IPC.settingsGet, (): SettingsGetResult => {
    return {
      settings: { ...live },
      bootSettings: { ...boot },
      displays: listDisplays(live),
      appVersion: app.getVersion(),
      // The RUNNING server bound the boot-time port; a changed live.mcpPort
      // takes effect only after restart (the GUI shows the hint).
      mcpUrl: mcpUrl(boot.mcpPort),
      uiLanguage: uiLanguage(live),
      systemLanguage: resolveLanguage('system', app.getLocale()),
    }
  })

  ipcMain.handle(IPC.settingsSet, (_event, patch: unknown): SettingsSetResult => {
    const safePatch =
      patch !== null && typeof patch === 'object' && !Array.isArray(patch)
        ? (patch as Record<string, unknown>)
        : {}
    const before = { ...live }
    const applied = applyPartial(live, safePatch)
    // Mutate in place: index.ts closures (hotkey flow, tray, MCP logging) hold
    // this exact object reference.
    Object.assign(live, applied)
    // An explicit, applied outputDir in the patch supersedes a --output-dir
    // override even when the picked folder equals the override path —
    // persistSettings cannot tell that intent apart from the values alone.
    if (typeof safePatch.outputDir === 'string' && applied.outputDir === safePatch.outputDir) {
      clearOutputDirOverride()
    }
    // Capture hotkey (GOAL "Settings GUI" > Capture): applies instantly, and a
    // conflict with another app's global shortcut is only detectable BY
    // registering. On failure the setting reverts before anything is written,
    // so the old accelerator keeps working and settings.json never records a
    // hotkey the app does not actually hold; the renderer shows it inline.
    // A hotkey patch re-registers whenever the accelerator the app actually
    // HOLDS differs from the configured one — not merely when the value
    // changed. A conflict at startup leaves settings.json naming a combination
    // nothing is registered for; re-recording that same combination once the
    // other app is gone must be able to take it back (value equality would
    // make that patch, and Backspace-to-default, silent no-ops).
    let hotkeyFailed = false
    const hotkeyPatched = typeof safePatch.captureHotkey === 'string'
    if (
      live.captureHotkey !== before.captureHotkey ||
      (hotkeyPatched && currentCaptureHotkey() !== live.captureHotkey)
    ) {
      hotkeyFailed = !applyCaptureHotkey(live, before.captureHotkey, hooks)
    }
    try {
      persistSettings({ ...live })
    } catch (err) {
      console.error('capturepack: settings write failed:', errorMessage(err))
    }
    // The recorder-window set is built from these three; rebuild applies them live.
    if (
      live.captureDisplay !== before.captureDisplay ||
      live.fps !== before.fps ||
      live.replaySeconds !== before.replaySeconds ||
      live.replayMaxWidth !== before.replayMaxWidth
    ) {
      void restartCapture(live)
    }
    // The updater honors the toggle live (GOAL: instant apply where possible).
    if (live.autoUpdateCheck !== before.autoUpdateCheck) {
      setAutoUpdateCheck(live.autoUpdateCheck)
    }
    // Instant apply (GOAL i18n): the tray rebuilds and open windows re-render.
    if (live.language !== before.language) {
      hooks.onLanguageChanged?.()
    }
    return { settings: { ...live }, hotkeyFailed }
  })

  ipcMain.handle(IPC.settingsPickOutputDir, async (): Promise<string | null> => {
    const options: Electron.OpenDialogOptions = {
      title: uiT(live)('settings.chooseOutputFolder'),
      defaultPath: live.outputDir,
      properties: ['openDirectory', 'createDirectory'],
    }
    const result =
      settingsWindow !== null && !settingsWindow.isDestroyed()
        ? await dialog.showOpenDialog(settingsWindow, options)
        : await dialog.showOpenDialog(options)
    if (result.canceled) return null
    return result.filePaths[0] ?? null
  })

  ipcMain.handle(IPC.settingsOpenOutput, async (): Promise<void> => {
    fs.mkdirSync(live.outputDir, { recursive: true })
    await shell.openPath(live.outputDir)
  })
}

// Opens the settings window, or focuses the already-open one (single-instance).
// Not alwaysOnTop; Esc closes it (handled in the renderer via window.close()).
export function openSettingsWindow(): void {
  if (settingsWindow !== null && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore()
    settingsWindow.focus()
    return
  }
  const win = new BrowserWindow({
    width: 760,
    height: 600,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    backgroundColor: '#121216',
    // Pre-load placeholder only: the renderer document title (localized via
    // data-i18n) replaces it as soon as the page loads.
    title: liveSettings !== null ? uiT(liveSettings)('settings.windowTitle') : 'CapturePack',
    show: false,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist', 'preload', 'settings.js'),
    },
  })
  win.setMenuBarVisibility(false)
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (settingsWindow === win) settingsWindow = null
  })
  void win.loadFile(path.join(app.getAppPath(), 'dist', 'renderer', 'settings', 'settings.html'))
  settingsWindow = win
}

// Re-registers the capture hotkey after `live.captureHotkey` changed. Returns
// true when the new accelerator is now live; on refusal `live.captureHotkey` is
// rolled back to `previous`, that accelerator is put back in place, and the
// caller reports the conflict to the settings window.
function applyCaptureHotkey(live: Settings, previous: string, hooks: SettingsIpcHooks): boolean {
  const handler = hooks.onCapture
  if (handler === undefined) return true // No capture wired (tests/dev harness).
  if (registerCaptureHotkey(live.captureHotkey, handler)) {
    hooks.onHotkeyChanged?.()
    return true
  }
  live.captureHotkey = previous
  // Best effort: the previous accelerator was just released, so take it back.
  // A failure here would mean another app grabbed it in between — nothing left
  // to do but leave the app hotkey-less until the next successful change.
  registerCaptureHotkey(previous, handler)
  return false
}

// Labels use physical pixels (size x scaleFactor) so they match the snapshot
// resolution the user will actually get, plus DIP position and a primary mark.
function listDisplays(live: Settings): SettingsDisplayOption[] {
  const t = uiT(live)
  const primaryId = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((d) => {
    const w = Math.round(d.size.width * d.scaleFactor)
    const h = Math.round(d.size.height * d.scaleFactor)
    const primary = d.id === primaryId ? ` — ${t('settings.primary')}` : ''
    return { id: String(d.id), label: `${w}×${h} at ${d.bounds.x},${d.bounds.y}${primary}` }
  })
}

function mcpUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
