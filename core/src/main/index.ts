// Main-process entry: single-instance tray app; wires hotkey, tray, capture, updater.
import { app, dialog, globalShortcut, Notification, shell } from 'electron'
import * as fs from 'node:fs'
import type { UpdaterStatusPayload } from '../shared/ipc'
import { openAboutWindow, pushAboutState, registerAboutIpc } from './aboutWindow'
import { setupDisplayMediaHandler, startCapture } from './capture'
import { disposeHistory, notifyHistoryChanged, openHistoryWindow, registerHistoryIpc } from './historyWindow'
import { registerCaptureHotkey } from './hotkey'
import { uiLanguage, uiT } from './locale'
import { startMcpServer } from './mcp/server'
import type { McpServerHandle } from './mcp/server'
import { startCaptureFlow } from './session'
import { loadSettings } from './settings'
import { openSettingsWindow, registerSettingsIpc } from './settingsWindow'
import { createTray } from './tray'
import type { TrayControls } from './tray'
import { checkNow, initUpdater, restartAndUpdate, updaterState } from './updater'
import { openWelcomeWindow, registerWelcomeIpc } from './welcomeWindow'

if (process.argv.includes('--smoke')) {
  // CI smoke test: settings load only — no windows, tray, hotkey, or MCP.
  // Runs BEFORE (and without) the single-instance lock: an installed
  // CapturePack holding the lock would otherwise make the dev instance exit 0
  // without exercising anything — a vacuous pass.
  void app.whenReady().then(() => {
    loadSettings()
    app.quit()
  })
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  main()
}

function main(): void {
  let mcp: McpServerHandle | null = null

  app.on('second-instance', () => {
    // Tray app with no main window: nothing to focus, the second instance quits itself.
  })

  app.on('window-all-closed', () => {
    // Tray app: keep running with zero windows (default behavior would quit).
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    disposeHistory()
    void mcp?.stop().catch(() => {})
  })

  void app.whenReady().then(async () => {
    // `firstRun` is TRUE only when no settings file existed a moment ago — the
    // one honest fresh-install signal (GOAL "Welcome": never shown on update).
    const { settings, firstRun } = loadSettings()

    mcp = startMcpServer(settings)

    setupDisplayMediaHandler()
    // The capture module owns the recorder-window set (per-display in cursor
    // mode) from here on: hotplug rebuilds happen inside it, and the settings
    // GUI applies changes via restartCapture(settings).
    await startCapture(settings)

    // Assigned right below; the settings-GUI hooks fire only from that window,
    // which cannot open before the tray exists.
    let tray: TrayControls | null = null

    const capture = (): void => {
      void startCaptureFlow(settings)
    }

    // The settings GUI mutates this exact `settings` object in place, so every
    // closure below (capture flow, tray, MCP request logging) applies changes
    // the moment they are saved.
    registerSettingsIpc(settings, {
      // Instant apply (GOAL i18n): tray menu rebuilds immediately; an open
      // History window re-renders via its normal re-list push.
      onLanguageChanged: () => {
        tray?.refresh()
        notifyHistoryChanged()
        pushAboutState()
      },
      // What a re-registered capture hotkey has to trigger.
      onCapture: capture,
      // The tray's "Capture now" label and the History empty state both carry
      // the accelerator: same refresh path as a language change.
      onHotkeyChanged: () => {
        tray?.refresh()
        notifyHistoryChanged()
      },
    })
    // Same live settings object: History honors outputDir changes on next access.
    registerHistoryIpc(settings)
    // Same again: the About window resolves the UI language at call time.
    registerAboutIpc(settings)
    // Welcome window (GOAL "Welcome (first launch after install)"): [Try it
    // now] fires `capture` — the very closure the global hotkey and the tray
    // run — so the guided first capture is the real capture flow, not a copy.
    // The MCP line's endpoint comes from the RUNNING server (a getter, since it
    // binds asynchronously and may never bind at all): mcpAutoStart off or a
    // port already in use must leave the row hidden, not print a dead URL.
    registerWelcomeIpc(
      settings,
      {
        onCapture: capture,
        onOpenSettings: () => openSettingsWindow(),
      },
      () => mcp?.endpoint() ?? '',
    )

    tray = createTray(
      {
        onCapture: capture,
        onOpenHistory: () => openHistoryWindow(),
        onOpenOutput: () => {
          fs.mkdirSync(settings.outputDir, { recursive: true })
          void shell.openPath(settings.outputDir)
        },
        onOpenSettings: () => openSettingsWindow(),
        // Manual check (GOAL "Tray Menu"): runs even with auto-check off; the
        // menu item's label follows the state through the getter below.
        onCheckUpdates: () => void checkNow(),
        onAbout: () => openAboutWindow(),
        onRestartUpdate: () => restartAndUpdate(),
        onQuit: () => app.quit(),
      },
      () => uiLanguage(settings),
      () => settings.captureHotkey,
      () => updaterState(),
    )
    const trayControls = tray

    // Dev aid: open the settings window on launch.
    if (process.argv.includes('--show-settings')) openSettingsWindow()
    // Dev aid / headed testing: open the History window on launch.
    if (process.argv.includes('--show-history')) openHistoryWindow()
    // Dev aid / headed testing: open the About window on launch.
    if (process.argv.includes('--show-about')) openAboutWindow()
    // Dev aid / headed testing: open the Welcome window on launch.
    if (process.argv.includes('--show-welcome')) {
      openWelcomeWindow()
    } else if (firstRun && !settings.welcomeShown) {
      // FIRST LAUNCH ONLY (GOAL "Welcome"): a genuinely fresh install — no
      // settings file existed when settings loaded. An update always finds one,
      // so it never lands here; the stored flag alone would not be enough,
      // since a settings.json written before the flag existed defaults it to
      // false. openWelcomeWindow() persists welcomeShown, so this is once.
      openWelcomeWindow()
    }

    if (!registerCaptureHotkey(settings.captureHotkey, capture)) {
      // Async on purpose: showErrorBox blocks the main-process event loop until
      // dismissed, which would freeze the always-on MCP server with it.
      void dialog.showMessageBox({
        type: 'error',
        title: 'CapturePack', // product name — never translated
        message: uiT(settings)('app.hotkeyFailed', { hotkey: settings.captureHotkey }),
      })
    }

    // The version the "update ready" notification has already announced. A
    // scheduled re-check re-emits 'update-downloaded' for the cached file, and
    // the same toast every 4 hours would be nagging, not news.
    let notifiedVersion: string | null = null
    initUpdater({
      autoCheck: settings.autoUpdateCheck,
      onStatus: (status: UpdaterStatusPayload) => {
        // Every state change re-renders the surfaces that show it: the tray's
        // "Check for updates…" item and an open About window. setUpdateReady()
        // rebuilds the menu itself, so it REPLACES refresh() — never both.
        const readyVersion =
          status.state === 'downloaded' && status.version !== undefined && status.version !== ''
            ? status.version
            : null
        if (readyVersion !== null) {
          trayControls.setUpdateReady(readyVersion)
        } else {
          trayControls.refresh()
        }
        pushAboutState()
        if (readyVersion === null || readyVersion === notifiedVersion) return
        notifiedVersion = readyVersion
        const note = new Notification({
          title: 'CapturePack', // product name — never translated
          body: uiT(settings)('app.updateReady', { version: readyVersion }),
        })
        note.on('click', () => restartAndUpdate())
        note.show()
      },
    })
  }).catch((err: unknown) => {
    // A throw mid-init (e.g. an unloadable tray asset) would otherwise be a
    // bare unhandled rejection leaving a half-initialized zombie — possibly
    // with no tray icon to quit from. Fail loudly instead: log, show a
    // NON-blocking dialog (showErrorBox would freeze the event loop, see the
    // hotkey dialog above), and quit once acknowledged. English on purpose —
    // loadSettings() itself may be what threw, so no locale is trustworthy.
    const message = err instanceof Error ? err.message : String(err)
    console.error('capturepack: startup failed:', message)
    void dialog
      .showMessageBox({
        type: 'error',
        title: 'CapturePack', // product name — never translated
        message: `CapturePack failed to start: ${message}`,
      })
      .then(() => app.quit())
  })
}
