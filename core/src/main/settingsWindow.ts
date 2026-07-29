// Settings GUI window (GOAL "Settings GUI"): one compact dark 760x600 window
// opened from the tray, single-instance, instant apply — no Save button. This
// module owns the settings:* IPC: every patch is validated in settings.ts
// (applyPartial, same per-key rules as settings.json loading), written to disk,
// applied to the live settings object index.ts shares with every flow, and the
// recorder-window set is rebuilt when a change affects it.
import { app, BrowserWindow, clipboard, dialog, ipcMain, screen, shell } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { DOM_PROTOCOL_VERSION, domBridgeStatus } from './chrome/domBridge'
import {
  extensionDir,
  findOurExtensionIds,
  nativeHostState,
  registerBrowsers,
  unregisterBrowsers,
  writeHostManifest,
} from './chrome/install'

import { IPC } from '../shared/ipc'
import type {
  ChromeIntegrationStatus,
  McpStatus,
  SettingsDisplayOption,
  SettingsGetResult,
  SettingsSetResult,
  SettingsStatusResult,
} from '../shared/ipc'
import { resolveLanguage } from '../shared/i18n'
import type { Settings } from '../shared/types'
import { logError, logInfo } from './log'
import { restartCapture } from './capture'
import { updateContextRetention } from './context/runtime'
import { currentCaptureHotkey, registerCaptureHotkey } from './hotkey'
import { uiLanguage, uiT } from './locale'
import { mcpAppliedSettings, mcpStatus, restartMcpServer } from './mcp/service'
import { applyPartial, clearOutputDirOverride, persistSettings } from './settings'
import { uiaPluginStatus } from './uia'
import { setAutoUpdateCheck } from './updater'

/** The online manual (GOAL "First-Run Tutorial"). */
const GUIDE_URL = 'https://capturepack.dev/guide'

/**
 * Opens the browser on its extensions page.
 *
 * Tried in the order a user is likeliest to have: whatever owns http, then the
 * Chromium browsers by name. A failure is silent on purpose — the panel already
 * shows the path to paste, and a dialog about a browser that is not installed
 * helps nobody.
 */
async function openExtensionsPage(): Promise<void> {
  const { execFile } = await import('node:child_process')
  const candidates = ['chrome', 'msedge', 'brave']
  for (const exe of candidates) {
    const ok = await new Promise<boolean>((resolve) => {
      // `start` resolves the app the same way the shell does, so a browser
      // installed anywhere on PATH or in the registry is found without this
      // process knowing where.
      execFile(
        'cmd',
        ['/c', 'start', '', exe, 'chrome://extensions'],
        { windowsHide: true },
        (err) => resolve(err === null),
      )
    })
    if (ok) return
  }
}

/** The six-point health check, assembled from the three places it lives. */
async function chromeStatus(): Promise<ChromeIntegrationStatus> {
  const bridge = domBridgeStatus()
  const host = await nativeHostState()
  return {
    listening: bridge.listening,
    hostSeen: bridge.hostSeen,
    extensionConnected: bridge.extensionConnected,
    extensionVersion: bridge.extensionVersion,
    protocolVersion: bridge.protocolVersion,
    appProtocolVersion: DOM_PROTOCOL_VERSION,
    protocolCompatible: bridge.protocolCompatible,
    manifestWritten: host.manifestWritten,
    manifestPath: host.manifestPath,
    allowedExtensionIds: host.allowedExtensionIds,
    browsers: host.browsers,
    extensionDir: host.extensionDir,
    extensionDirExists: host.extensionDirExists,
    events: bridge.events,
    detected: findOurExtensionIds(),
  }
}

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
  // Applies the per-user Windows login item immediately after the validated
  // setting is persisted. Startup reconciliation uses the same callback.
  onLaunchAtLoginChanged?: (enabled: boolean) => void
  // Supervision (GOAL "And do not stay gone.", issue #61) applies immediately
  // too, and in BOTH directions: off stops the watchdog and deletes the Start
  // Menu fallback, on starts them. A switch whose "off" only takes effect at
  // the next launch would leave a process the user just refused still running.
  onSuperviseProcessChanged?: (enabled: boolean) => void
}

// Registers the settings IPC handlers around the live settings object — the
// same object index.ts hands to the capture flow, tray, and MCP server, so
// mutations here apply instantly wherever main reads settings at use time.
// Call once at startup, before the window can open.
export function registerSettingsIpc(live: Settings, hooks: SettingsIpcHooks = {}): void {
  liveSettings = live

  ipcMain.handle(IPC.settingsGet, (): SettingsGetResult => {
    return {
      settings: { ...live },
      displays: listDisplays(live),
      appVersion: app.getVersion(),
      status: liveStatus(live),
      uiLanguage: uiLanguage(live),
      systemLanguage: resolveLanguage('system', app.getLocale()),
    }
  })

  // The two things settings can only ASK for, read from reality (issues #54,
  // #57). Cheap enough to re-poll after every patch and on window focus, which
  // is what keeps the window truthful while captures happen behind it.
  ipcMain.handle(IPC.settingsStatus, (): SettingsStatusResult => liveStatus(live))

  ipcMain.handle(IPC.settingsMcpRestart, async (): Promise<SettingsStatusResult> => {
    // Restart in place (GOAL "Settings GUI": instant apply where possible):
    // only the HTTP server and its pack index are recreated — the capture
    // buffer, the global hotkey and any open editor never notice.
    const restarted: McpStatus = await restartMcpServer(live)
    // Read AFTER the restart, so the answer carries the settings the server now
    // honors and the GUI's pending-change hints clear in the same message.
    return { ...liveStatus(live), mcp: restarted }
  })

  ipcMain.handle(IPC.settingsSet, async (_event, patch: unknown): Promise<SettingsSetResult> => {
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
    // The Surface Timeline retains as far back as the replay does, and follows a
    // change WITHOUT a session restart (issue #64, protocol GAP 2: the retention
    // window on every tick IS the contract, so shortening the replay must shrink
    // the ring immediately rather than at the next launch).
    if (live.replaySeconds !== before.replaySeconds) {
      updateContextRetention(live.replaySeconds * 1000)
    }
    // The updater honors the toggle live (GOAL: instant apply where possible).
    if (live.autoUpdateCheck !== before.autoUpdateCheck) {
      setAutoUpdateCheck(live.autoUpdateCheck)
    }
    if (live.launchAtLogin !== before.launchAtLogin) {
      hooks.onLaunchAtLoginChanged?.(live.launchAtLogin)
    }
    if (live.superviseProcess !== before.superviseProcess) {
      hooks.onSuperviseProcessChanged?.(live.superviseProcess)
    }
    // Instant apply (GOAL i18n): the tray rebuilds and open windows re-render.
    if (live.language !== before.language) {
      hooks.onLanguageChanged?.()
    }
    // LAST, and the only awaited step: "Enable MCP server" is the switch it says
    // it is (v0.1.6). Unchecking it STOPS the running server and checking it
    // starts one, both before this reply is sent. It used to be advisory — the
    // server kept answering requests and the status row kept saying "Running on
    // …" with the box unchecked, which is the same lie as a tray icon that
    // claims to be recording.
    //
    // AWAITED rather than fired and forgotten, because the renderer re-reads the
    // live status the moment this resolves: the bind (or the close) has to have
    // settled or the row would repaint from the state we just left behind. It
    // goes last so a slow bind cannot delay any of the instant-apply hooks
    // above. mcpAutoStart is deliberately not consulted — flipping this switch
    // by hand IS the manual start mcpAutoStart governs.
    if (live.mcpEnabled !== before.mcpEnabled) {
      await restartMcpServer(live)
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

  // Settings > Integrations (GOAL "Extension Install & Management UX").
  //
  // Everything reported here is READ at the moment it is asked for: the
  // manifest off disk, the registry values out of the registry, the handshake
  // off the wire. A remembered "installed" is worth nothing when a browser
  // update, another profile, or the user's own cleanup can undo any of the
  // three without telling us.
  ipcMain.handle(IPC.settingsChromeStatus, async (): Promise<ChromeIntegrationStatus> => {
    return chromeStatus()
  })

  ipcMain.handle(
    IPC.settingsChromeInstall,
    async (_event, extensionId: unknown): Promise<ChromeIntegrationStatus> => {
      // An unpacked extension's ID is 32 lowercase letters a-p; the Web Store
      // uses the same alphabet. Anything else is not an ID, and writing it
      // would produce a manifest that silently allows nobody.
      const id = typeof extensionId === 'string' ? extensionId.trim().toLowerCase() : ''
      if (!/^[a-p]{32}$/.test(id)) throw new Error('that is not a Chrome extension ID')
      try {
        writeHostManifest([id])
        await registerBrowsers()
      } catch (err) {
        logError('capturepack: installing the native messaging host failed:', err)
      }
      return chromeStatus()
    },
  )

  ipcMain.handle(IPC.settingsChromeUninstall, async (): Promise<ChromeIntegrationStatus> => {
    await unregisterBrowsers()
    return chromeStatus()
  })

  // chrome://extensions cannot be opened by shell.openExternal — the scheme is
  // the browser's own. Starting the browser WITH the page is the same thing
  // from the user's side, and asking the registry where Chrome is beats
  // guessing at Program Files.
  ipcMain.on(IPC.settingsChromeOpenExtensionsPage, () => {
    void openExtensionsPage()
  })

  ipcMain.handle(IPC.settingsChromeDetect, async (): Promise<ChromeIntegrationStatus> => {
    const found = findOurExtensionIds()
    if (found.length > 0) {
      try {
        writeHostManifest(found.map((f) => f.id))
        await registerBrowsers()
        logInfo(`[chrome] found this extension as ${found.map((f) => f.id).join(', ')}`)
      } catch (err) {
        logError('capturepack: registering the detected extension failed:', err)
      }
    }
    return chromeStatus()
  })

  ipcMain.on(IPC.settingsChromeCopyPath, () => {
    const dir = extensionDir()
    if (dir !== '') clipboard.writeText(dir)
  })

  ipcMain.on(IPC.settingsChromeOpenFolder, () => {
    const dir = extensionDir()
    if (dir === '') return
    void shell.openPath(dir)
  })

  // The online manual (GOAL "First-Run Tutorial"). The address is a constant
  // here rather than a parameter: a renderer that could name the destination
  // could name any destination.
  ipcMain.on(IPC.settingsOpenGuide, () => {
    void shell.openExternal(GUIDE_URL).catch((err: unknown) => {
      console.error(
        'capturepack: could not open the guide:',
        err instanceof Error ? err.message : err,
      )
    })
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

/**
 * Everything the settings window shows that is LIVE rather than configured.
 *
 * `mcpSettings` falls back to the live values when no start has ever been
 * attempted: no start means nothing is pending, so showing no "press Restart"
 * hints is the honest answer rather than hinting at every MCP key at once.
 */
function liveStatus(live: Settings): SettingsStatusResult {
  return {
    mcp: mcpStatus(),
    mcpSettings: { ...(mcpAppliedSettings() ?? live) },
    uia: uiaPluginStatus(live.uiaEnabled),
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
