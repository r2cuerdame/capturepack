// Main-process entry: single-instance tray app; wires hotkey, tray, capture, updater.
import { app, dialog, globalShortcut, Notification, shell } from 'electron'
import * as fs from 'node:fs'
import type { UpdaterStatusPayload } from '../shared/ipc'
import { setupDisplayMediaHandler, startCapture } from './capture'
import { startMcpServer } from './mcp/server'
import type { McpServerHandle } from './mcp/server'
import { startCaptureFlow } from './session'
import { loadSettings } from './settings'
import { openSettingsWindow, registerSettingsIpc } from './settingsWindow'
import { createTray } from './tray'
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

    // The settings GUI mutates this exact `settings` object in place, so every
    // closure below (capture flow, tray, MCP request logging) applies changes
    // the moment they are saved.
    registerSettingsIpc(settings)

    const capture = (): void => {
      void startCaptureFlow(settings)
    }

    const tray = createTray({
      onCapture: capture,
      onOpenOutput: () => {
        fs.mkdirSync(settings.outputDir, { recursive: true })
        void shell.openPath(settings.outputDir)
      },
      onOpenSettings: () => openSettingsWindow(),
      onRestartUpdate: () => restartAndUpdate(),
      onQuit: () => app.quit(),
    })

    // Dev aid: open the settings window on launch.
    if (process.argv.includes('--show-settings')) openSettingsWindow()

    if (!globalShortcut.register('Ctrl+Alt+C', capture)) {
      // Async on purpose: showErrorBox blocks the main-process event loop until
      // dismissed, which would freeze the always-on MCP server with it.
      void dialog.showMessageBox({
        type: 'error',
        title: 'CapturePack',
        message: 'Could not register the Ctrl+Alt+C hotkey. Another application may already be using it.',
      })
    }

    initUpdater({
      autoCheck: settings.autoUpdateCheck,
      onStatus: (status: UpdaterStatusPayload) => {
        if (status.state !== 'downloaded' || !status.version) return
        tray.setUpdateReady(status.version)
        const note = new Notification({
          title: 'CapturePack',
          body: `CapturePack ${status.version} available — restart to update`,
        })
        note.on('click', () => restartAndUpdate())
        note.show()
      },
    })
  })
}
