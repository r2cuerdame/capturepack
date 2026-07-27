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
import type { Settings } from '../shared/types'
import { restartCapture } from './capture'
import { applyPartial, clearOutputDirOverride, persistSettings } from './settings'
import { setAutoUpdateCheck } from './updater'

let settingsWindow: BrowserWindow | null = null

// Registers the settings IPC handlers around the live settings object — the
// same object index.ts hands to the capture flow, tray, and MCP server, so
// mutations here apply instantly wherever main reads settings at use time.
// Call once at startup, before the window can open.
export function registerSettingsIpc(live: Settings): void {
  // Boot-time snapshot, taken before any GUI mutation is possible: the values
  // the running MCP server/watcher actually honor. The renderer's "restart to
  // apply" hints compare against this so they survive window close/reopen.
  const boot: Settings = { ...live }

  ipcMain.handle(IPC.settingsGet, (): SettingsGetResult => {
    return {
      settings: { ...live },
      bootSettings: { ...boot },
      displays: listDisplays(),
      appVersion: app.getVersion(),
      // The RUNNING server bound the boot-time port; a changed live.mcpPort
      // takes effect only after restart (the GUI shows the hint).
      mcpUrl: mcpUrl(boot.mcpPort),
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
    try {
      persistSettings(applied)
    } catch (err) {
      console.error('capturepack: settings write failed:', errorMessage(err))
    }
    // The recorder-window set is built from these three; rebuild applies them live.
    if (
      live.captureDisplay !== before.captureDisplay ||
      live.fps !== before.fps ||
      live.replaySeconds !== before.replaySeconds
    ) {
      void restartCapture(live)
    }
    // The updater honors the toggle live (GOAL: instant apply where possible).
    if (live.autoUpdateCheck !== before.autoUpdateCheck) {
      setAutoUpdateCheck(live.autoUpdateCheck)
    }
    return { settings: { ...live } }
  })

  ipcMain.handle(IPC.settingsPickOutputDir, async (): Promise<string | null> => {
    const options: Electron.OpenDialogOptions = {
      title: 'Choose output folder',
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
    title: 'CapturePack — Settings',
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

// Labels use physical pixels (size x scaleFactor) so they match the snapshot
// resolution the user will actually get, plus DIP position and a primary mark.
function listDisplays(): SettingsDisplayOption[] {
  const primaryId = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((d) => {
    const w = Math.round(d.size.width * d.scaleFactor)
    const h = Math.round(d.size.height * d.scaleFactor)
    const primary = d.id === primaryId ? ' — primary' : ''
    return { id: String(d.id), label: `${w}×${h} at ${d.bounds.x},${d.bounds.y}${primary}` }
  })
}

function mcpUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
