// Settings GUI window (GOAL "Settings GUI"): one compact dark 760x600 window
// opened from the tray, single-instance, instant apply — no Save button. This
// module owns the settings:* IPC: every patch is validated in settings.ts
// (applyPartial, same per-key rules as settings.json loading), written to disk,
// applied to the live settings object index.ts shares with every flow, and the
// recorder-window set is rebuilt when a change affects it.
import { app, BrowserWindow, clipboard, dialog, ipcMain, screen, shell } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  DOM_PROTOCOL_VERSION,
  domBridgeStatus,
  setDomRetention,
  startDomBridge,
  stopDomBridge,
} from './chrome/domBridge'
import {
  extensionDir,
  bundledExtensionVersion,
  findOurExtensionIds,
  nativeHostState,
  refreshHostManifestIfInstalled,
  registerBrowsers,
  syncExtensionIfChanged,
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
  StoragePurgeResult,
  StorageUsage,
} from '../shared/ipc'
import { resolveLanguage } from '../shared/i18n'
import { directoryHoldsCapturePack, manifestNamesCapturePack } from '../shared/packIdentity'
import AdmZip from 'adm-zip'
import type { Settings } from '../shared/types'
import { logError, logInfo, logWarn } from './log'
import { restartCapture } from './capture'
import { updateContextRetention, updateContextUiaEnabled } from './context/runtime'
import {
  currentCaptureHotkey,
  currentImageCaptureHotkey,
  registerCaptureHotkey,
  registerImageCaptureHotkey,
} from './hotkey'
import { uiLanguage, uiT } from './locale'
import { mcpAppliedSettings, mcpStatus, restartMcpServer } from './mcp/service'
import { applyPartial, clearOutputDirOverride, persistSettings } from './settings'
import { uiaPluginStatus } from './uia'
import { setAutoUpdateCheck } from './updater'

/** The online manual (GOAL "First-Run Tutorial"). */
const GUIDE_URL = 'https://capturepack.dev/guide'

/**
 * The ages the panel offers, in days — and ZERO, which means everything.
 *
 * Zero is not a special case anywhere below: "older than 0 days" has a cutoff
 * of now, and every pack on disk was written before now. So one walk, one
 * filter and one counted, confirmable delete serve all four buttons, and
 * "delete everything" cannot drift away from the three that are dated.
 */
const PURGE_AGES_DAYS: readonly number[] = [0, 1, 7, 30]

/** A pack folder, or an archive sitting beside one, with its size and age. */
interface StoredPack {
  path: string
  bytes: number
  mtimeMs: number
}

/**
 * Every CapturePack in the output folder — and NOTHING else in it.
 *
 * A folder counts only when it holds a manifest.json, and an archive only when
 * its name matches one of ours. The output folder is a place the user also
 * keeps their own things (this machine's is the Desktop), and a storage tool
 * that measured or deleted by "everything in this directory" would be a
 * catastrophe waiting for its first Downloads folder.
 */
function listStoredPacks(outputDir: string): StoredPack[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(outputDir, { withFileTypes: true })
  } catch {
    return []
  }
  const packs: StoredPack[] = []
  for (const entry of entries) {
    const full = path.join(outputDir, entry.name)
    try {
      // A NAME IS NOT AN IDENTITY, AND THIS LIST FEEDS A DELETE.
      //
      // This counted any directory holding a file called manifest.json, and any
      // file whose name ended in .zip. `purgeOlderThan` then hands every entry
      // to the Recycle Bin. The output folder is the user's to choose, and the
      // Settings GUI lets them choose Downloads, Documents or the Desktop
      // itself — where "delete older than 30 days" would have taken every
      // unrelated archive, and every npm, Electron or Rust project folder,
      // because those all carry a manifest.json too.
      //
      // So a pack is now something that SAYS it is a pack: its manifest must
      // parse and must name this format. The cost is one small read per
      // candidate, on a path that is about to delete things.
      if (entry.isDirectory()) {
        if (!directoryHoldsCapturePack(full)) continue
        packs.push({ path: full, bytes: dirBytes(full), mtimeMs: fs.statSync(full).mtimeMs })
      } else if (entry.isFile() && /\.(zip|capturepack)$/i.test(entry.name)) {
        if (!archiveHoldsCapturePack(full)) continue
        const stat = fs.statSync(full)
        packs.push({ path: full, bytes: stat.size, mtimeMs: stat.mtimeMs })
      }
    } catch {
      // Vanished or unreadable mid-scan: not counted, not deleted.
    }
  }
  return packs
}

/** Recursive size, best effort — an unreadable child costs its own bytes only. */
/**
 * A pack ARCHIVE: the zip's central directory holds a `manifest.json` that
 * parses and names this format. adm-zip reads the entry table without
 * inflating the body, so this is one small read even for a large pack.
 */
function archiveHoldsCapturePack(zipPath: string): boolean {
  try {
    const entry = new AdmZip(zipPath).getEntry('manifest.json')
    if (entry === null || entry.isDirectory) return false
    return manifestNamesCapturePack(entry.getData().toString('utf8'))
  } catch {
    // Not a zip, truncated, or unreadable — not a pack, and not deleted.
    return false
  }
}

function dirBytes(dir: string): number {
  let total = 0
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    try {
      if (entry.isDirectory()) total += dirBytes(full)
      else total += fs.statSync(full).size
    } catch {
      // Skip.
    }
  }
  return total
}

function storageUsage(outputDir: string): StorageUsage {
  const packs = listStoredPacks(outputDir)
  const now = Date.now()
  return {
    totalBytes: packs.reduce((sum, p) => sum + p.bytes, 0),
    totalPacks: packs.length,
    olderThan: PURGE_AGES_DAYS.map((days) => {
      const cutoff = now - days * 86_400_000
      const old = packs.filter((p) => p.mtimeMs < cutoff)
      return { days, packs: old.length, bytes: old.reduce((sum, p) => sum + p.bytes, 0) }
    }),
  }
}

/**
 * Moves packs older than `days` to the Recycle Bin.
 *
 * TRASH, NEVER UNLINK. These are captures the user chose to keep, and a wrong
 * click here would otherwise be unrecoverable. shell.trashItem is what makes
 * this a decision the user can take back — and if the shell refuses, the pack
 * stays where it is rather than being removed some other way.
 */
async function purgeOlderThan(outputDir: string, days: number): Promise<StoragePurgeResult> {
  const cutoff = Date.now() - days * 86_400_000
  const doomed = listStoredPacks(outputDir).filter((p) => p.mtimeMs < cutoff)
  let packsDeleted = 0
  let bytesFreed = 0
  let firstError: string | null = null
  for (const pack of doomed) {
    try {
      await shell.trashItem(pack.path)
      packsDeleted += 1
      bytesFreed += pack.bytes
    } catch (err) {
      if (firstError === null) firstError = err instanceof Error ? err.message : String(err)
    }
  }
  logInfo(
    `[storage] purge ${days === 0 ? 'everything' : `older than ${String(days)}d`}: ` +
      `${String(packsDeleted)} of ${String(doomed.length)} pack(s) ` +
      `to the Recycle Bin, ${String(Math.round(bytesFreed / 1_048_576))} MB`,
  )
  return {
    ok: firstError === null,
    packsDeleted,
    bytesFreed,
    ...(firstError === null ? {} : { error: firstError }),
  }
}

/** The address the user needs, named once so the UI and the launcher agree. */
const EXTENSIONS_URL = 'chrome://extensions'

/**
 * Where Windows says each browser is installed.
 *
 * App Paths is the registry key the shell itself reads to turn "chrome" into an
 * executable, so this asks the same source Explorer's Run box does — HKCU first
 * because a per-user install shadows a machine-wide one.
 */
async function browserExePath(exe: string): Promise<string | null> {
  const { execFile } = await import('node:child_process')
  const key = `Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`
  for (const root of ['HKCU', 'HKLM']) {
    const found = await new Promise<string | null>((resolve) => {
      execFile(
        'reg',
        ['query', `${root}\\${key}`, '/ve'],
        { windowsHide: true },
        (err, stdout) => {
          if (err) {
            resolve(null)
            return
          }
          const match = /REG_SZ\s+(.+)/.exec(stdout)
          const value = match?.[1]?.trim().replace(/^"|"$/g, '') ?? ''
          resolve(value !== '' && fs.existsSync(value) ? value : null)
        },
      )
    })
    if (found !== null) return found
  }
  return null
}

/**
 * Opens the browser on its extensions page, and SAYS WHETHER IT WORKED.
 *
 * The first cut ran `cmd /c start "" chrome chrome://extensions` and reported
 * nothing. `start` returns success for a browser it never found — it hands the
 * failure to a shell dialog, not to the exit code — so a user whose browser is
 * installed somewhere the shell does not resolve saw a button that did nothing
 * and told them nothing ("크롬 확장페이지가 안열리는데"). This resolves the
 * executable first and launches it directly, so "it did not open" is a fact the
 * panel can print alongside the address to paste by hand.
 */
async function openExtensionsPage(): Promise<string | null> {
  const { execFile } = await import('node:child_process')
  const candidates: readonly { exe: string; label: string }[] = [
    { exe: 'chrome.exe', label: 'Chrome' },
    { exe: 'msedge.exe', label: 'Edge' },
    { exe: 'brave.exe', label: 'Brave' },
    { exe: 'chromium.exe', label: 'Chromium' },
  ]
  for (const candidate of candidates) {
    const exePath = await browserExePath(candidate.exe)
    if (exePath === null) continue
    try {
      const child = execFile(exePath, [EXTENSIONS_URL], { windowsHide: false })
      child.unref()
      logInfo(`[chrome] opened ${EXTENSIONS_URL} in ${candidate.label}`)
      return candidate.label
    } catch (err) {
      logError(`[chrome] could not start ${candidate.label}:`, err)
    }
  }
  logWarn('[chrome] no Chromium browser found in App Paths — the page must be opened by hand')
  return null
}

type ChromeHostState = Awaited<ReturnType<typeof nativeHostState>>
type DetectedChromeExtension = ReturnType<typeof findOurExtensionIds>[number]

interface ChromeInstallSnapshot {
  atMs: number
  host: ChromeHostState
  detected: readonly DetectedChromeExtension[]
}

// Secure Preferences can contain megabytes per profile. Connection truth is
// in-memory and repaints every second; the disk/registry half is refreshed at a
// human-scale cadence or immediately after an explicit setup action.
const CHROME_INSTALL_STATUS_TTL_MS = 15_000
let chromeInstallSnapshot: ChromeInstallSnapshot | null = null

async function chromeInstallStatus(force: boolean): Promise<ChromeInstallSnapshot> {
  const now = Date.now()
  if (
    !force &&
    chromeInstallSnapshot !== null &&
    now - chromeInstallSnapshot.atMs < CHROME_INSTALL_STATUS_TTL_MS
  ) {
    return chromeInstallSnapshot
  }
  const hostPromise = nativeHostState()
  const detected = findOurExtensionIds()
  const host = await hostPromise
  const snapshot: ChromeInstallSnapshot = { atMs: now, host, detected }
  chromeInstallSnapshot = snapshot
  return snapshot
}

/** The six-point health check, assembled from the three places it lives. */
async function chromeStatus(forceInstallRefresh = false): Promise<ChromeIntegrationStatus> {
  const bridge = domBridgeStatus()
  const { host, detected } = await chromeInstallStatus(forceInstallRefresh)
  return {
    listening: bridge.listening,
    hostSeen: bridge.hostSeen,
    extensionConnected: bridge.extensionConnected,
    browserGranted: bridge.browserGranted,
    extensionVersion: bridge.extensionVersion,
    protocolVersion: bridge.protocolVersion,
    appProtocolVersion: DOM_PROTOCOL_VERSION,
    protocolCompatible: bridge.protocolCompatible,
    manifestWritten: host.manifestWritten,
    manifestPath: host.manifestPath,
    allowedExtensionIds: host.allowedExtensionIds,
    browsers: host.browsers,
    bundledExtensionVersion: bundledExtensionVersion(),
    extensionDir: host.extensionDir,
    extensionDirExists: host.extensionDirExists,
    legacyExtensionLoaded: detected.some((d) => d.legacy === true),
    legacyExtensionDir: host.legacyExtensionDir,
    events: bridge.events,
    elementPicks: bridge.elementPicks,
    rejected: bridge.rejected,
    lastRejection: bridge.lastRejection,
    picker: bridge.picker,
    detected,
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
  onImageCapture?: () => void
  // Fired after the capture hotkey was successfully re-registered (the tray's
  // "Capture now" label shows the accelerator).
  onHotkeyChanged?: () => void
  onImageHotkeyChanged?: () => void
  // Applies the per-user Windows login item immediately after the validated
  // setting is persisted. Startup reconciliation uses the same callback.
  onLaunchAtLoginChanged?: (enabled: boolean) => void
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
    let imageHotkeyFailed = false
    const imageHotkeyPatched = typeof safePatch.imageCaptureHotkey === 'string'
    if (
      live.imageCaptureHotkey !== before.imageCaptureHotkey ||
      (imageHotkeyPatched && currentImageCaptureHotkey() !== live.imageCaptureHotkey)
    ) {
      imageHotkeyFailed = !applyImageCaptureHotkey(
        live,
        before.imageCaptureHotkey,
        hooks,
      )
    }
    try {
      persistSettings({ ...live })
    } catch (err) {
      console.error('capturepack: settings write failed:', errorMessage(err))
    }
    // The recorder-window set is built from these three; rebuild applies them live.
    if (
      live.recordingEnabled !== before.recordingEnabled ||
      live.captureDisplay !== before.captureDisplay ||
      live.fps !== before.fps ||
      live.replaySeconds !== before.replaySeconds ||
      live.replayMaxWidth !== before.replayMaxWidth
    ) {
      // recordingEnabled rides the same rebuild: OFF resolves to an empty
      // recorder set and every capture window closes; ON rebuilds the set.
      void restartCapture(live)
    }
    // The Surface Timeline retains as far back as the replay does, and follows a
    // change WITHOUT a session restart (issue #64, protocol GAP 2: the retention
    // window on every tick IS the contract, so shortening the replay must shrink
    // the ring immediately rather than at the next launch).
    if (live.replaySeconds !== before.replaySeconds) {
      updateContextRetention(live.replaySeconds * 1000)
      setDomRetention(live.replaySeconds * 1000)
    }
    // The Windows UI Automation checkbox owns BOTH costs: the one-shot dump at
    // the next capture and the resident Lane A tracker right now. Previously
    // only the former stopped, leaving the largest plugin process running after
    // the user explicitly switched the plugin off.
    if (live.uiaEnabled !== before.uiaEnabled) {
      updateContextUiaEnabled(live.uiaEnabled)
    }
    // Chrome DOM is a real plugin switch. OFF closes every live bridge socket
    // and clears buffered DOM events now; ON updates the stable extension
    // folder first and reopens the pipe, so a still-running native host redials
    // without a browser-page reload.
    if (live.chromeDomEnabled !== before.chromeDomEnabled) {
      if (live.chromeDomEnabled) {
        syncExtensionIfChanged()
        refreshHostManifestIfInstalled()
        startDomBridge()
      } else {
        stopDomBridge()
      }
      chromeInstallSnapshot = null
    }
    // The updater honors the toggle live (GOAL: instant apply where possible).
    if (live.autoUpdateCheck !== before.autoUpdateCheck) {
      setAutoUpdateCheck(live.autoUpdateCheck)
    }
    if (live.launchAtLogin !== before.launchAtLogin) {
      hooks.onLaunchAtLoginChanged?.(live.launchAtLogin)
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
    return { settings: { ...live }, hotkeyFailed, imageHotkeyFailed }
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
      return chromeStatus(true)
    },
  )

  ipcMain.handle(IPC.settingsChromeUninstall, async (): Promise<ChromeIntegrationStatus> => {
    await unregisterBrowsers()
    return chromeStatus(true)
  })

  // chrome://extensions cannot be opened by shell.openExternal — the scheme is
  // the browser's own. Starting the browser WITH the page is the same thing
  // from the user's side, and asking the registry where Chrome is beats
  // guessing at Program Files.
  //
  // A HANDLE, not a fire-and-forget send: the panel prints the address to type
  // when this fails, and it can only do that if it is told.
  ipcMain.handle(IPC.settingsChromeOpenExtensionsPage, async (): Promise<string | null> => {
    return openExtensionsPage()
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
    return chromeStatus(true)
  })

  // Storage (GOAL "Settings GUI"): the app that fills the folder is the one
  // that should be able to empty it. Both handlers walk the SAME set of
  // entries — a pack is a folder holding a manifest, or an archive beside one —
  // so nothing else the user keeps in that folder is ever counted or touched.
  ipcMain.handle(IPC.settingsStorageUsage, async (): Promise<StorageUsage> => {
    return storageUsage(live.outputDir)
  })

  ipcMain.handle(
    IPC.settingsStoragePurge,
    async (_event, days: unknown): Promise<StoragePurgeResult> => {
      const olderThanDays = typeof days === 'number' && Number.isFinite(days) ? days : NaN
      // Zero is now a button of its own — "Delete everything" — and it says so
      // before it runs. Negative is still nothing this panel can mean, and a
      // value this function does not recognise deletes nothing.
      if (!(olderThanDays >= 0)) {
        return { ok: false, packsDeleted: 0, bytesFreed: 0, error: 'unsupported age' }
      }
      return purgeOlderThan(live.outputDir, olderThanDays)
    },
  )

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

function applyImageCaptureHotkey(
  live: Settings,
  previous: string,
  hooks: SettingsIpcHooks,
): boolean {
  const handler = hooks.onImageCapture
  if (handler === undefined) return true
  if (registerImageCaptureHotkey(live.imageCaptureHotkey, handler)) {
    hooks.onImageHotkeyChanged?.()
    return true
  }
  live.imageCaptureHotkey = previous
  registerImageCaptureHotkey(previous, handler)
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
