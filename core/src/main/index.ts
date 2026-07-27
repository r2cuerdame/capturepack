// Main-process entry: single-instance tray app; wires hotkey, tray, capture, updater.
import { app, dialog, globalShortcut, Notification, shell } from 'electron'
import * as fs from 'node:fs'
import type { UpdaterStatusPayload } from '../shared/ipc'
import { setupDisplayMediaHandler, startCapture } from './capture'
import { disposeHistory, notifyHistoryChanged, openHistoryWindow, registerHistoryIpc } from './historyWindow'
import { uiLanguage, uiT } from './locale'
import { startMcpServer } from './mcp/server'
import type { McpServerHandle } from './mcp/server'
import { startCaptureFlow } from './session'
import { loadSettings } from './settings'
import { openSettingsWindow, registerSettingsIpc } from './settingsWindow'
import { createTray } from './tray'
import type { TrayControls } from './tray'
import { initUpdater, restartAndUpdate } from './updater'

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
    const settings = loadSettings()

    mcp = startMcpServer(settings)

    setupDisplayMediaHandler()
    // The capture module owns the recorder-window set (per-display in cursor
    // mode) from here on: hotplug rebuilds happen inside it, and the settings
    // GUI applies changes via restartCapture(settings).
    await startCapture(settings)

    // Assigned right below; the language-change hook fires only from the
    // settings GUI, which cannot open before the tray exists.
    let tray: TrayControls | null = null

    // The settings GUI mutates this exact `settings` object in place, so every
    // closure below (capture flow, tray, MCP request logging) applies changes
    // the moment they are saved.
    registerSettingsIpc(settings, {
      // Instant apply (GOAL i18n): tray menu rebuilds immediately; an open
      // History window re-renders via its normal re-list push.
      onLanguageChanged: () => {
        tray?.refreshLanguage()
        notifyHistoryChanged()
      },
    })
    // Same live settings object: History honors outputDir changes on next access.
    registerHistoryIpc(settings)

    const capture = (): void => {
      void startCaptureFlow(settings)
    }

    tray = createTray(
      {
        onCapture: capture,
        onOpenHistory: () => openHistoryWindow(),
        onOpenOutput: () => {
          fs.mkdirSync(settings.outputDir, { recursive: true })
          void shell.openPath(settings.outputDir)
        },
        onOpenSettings: () => openSettingsWindow(),
        onRestartUpdate: () => restartAndUpdate(),
        onQuit: () => app.quit(),
      },
      () => uiLanguage(settings),
    )
    const trayControls = tray

    // Dev aid: open the settings window on launch.
    if (process.argv.includes('--show-settings')) openSettingsWindow()
    // Dev aid / headed testing: open the History window on launch.
    if (process.argv.includes('--show-history')) openHistoryWindow()

    if (!globalShortcut.register('Ctrl+Alt+C', capture)) {
      // Async on purpose: showErrorBox blocks the main-process event loop until
      // dismissed, which would freeze the always-on MCP server with it.
      void dialog.showMessageBox({
        type: 'error',
        title: 'CapturePack', // product name — never translated
        message: uiT(settings)('app.hotkeyFailed'),
      })
    }

    initUpdater({
      autoCheck: settings.autoUpdateCheck,
      onStatus: (status: UpdaterStatusPayload) => {
        if (status.state !== 'downloaded' || !status.version) return
        trayControls.setUpdateReady(status.version)
        const note = new Notification({
          title: 'CapturePack', // product name — never translated
          body: uiT(settings)('app.updateReady', { version: status.version }),
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
