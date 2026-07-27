// Main-process entry: single-instance tray app; wires hotkey, tray, capture, updater.
import { app, dialog, globalShortcut, Notification, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import * as fs from 'node:fs'
import type { UpdaterStatusPayload } from '../shared/ipc'
import { createCaptureWindow, setupDisplayMediaHandler } from './capture'
import { startMcpServer } from './mcp/server'
import type { McpServerHandle } from './mcp/server'
import { startCaptureFlow } from './session'
import { loadSettings, settingsFilePath } from './settings'
import { createTray } from './tray'
import { initUpdater, restartAndUpdate } from './updater'

if (!app.requestSingleInstanceLock()) {
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

    if (process.argv.includes('--smoke')) {
      // CI smoke test: settings load only — no windows, tray, hotkey, or MCP.
      app.quit()
      return
    }

    mcp = startMcpServer(settings)

    setupDisplayMediaHandler()
    const captureWindow: BrowserWindow = await createCaptureWindow({
      fps: settings.fps,
      // The recorder rotates segments at this interval; replay covers 1x..2x of it.
      segmentSeconds: settings.replaySeconds,
    })

    const capture = (): void => {
      void startCaptureFlow(captureWindow, settings)
    }

    const tray = createTray({
      onCapture: capture,
      onOpenOutput: () => {
        fs.mkdirSync(settings.outputDir, { recursive: true })
        void shell.openPath(settings.outputDir)
      },
      onOpenSettings: () => {
        void shell.openPath(settingsFilePath())
      },
      onRestartUpdate: () => restartAndUpdate(),
      onQuit: () => app.quit(),
    })

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
