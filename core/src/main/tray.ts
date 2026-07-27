// System tray icon and context menu.
import { app, Menu, Tray } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import * as path from 'node:path'

export interface TrayHandlers {
  onCapture: () => void
  onOpenHistory: () => void
  onOpenOutput: () => void
  onOpenSettings: () => void
  onRestartUpdate: () => void
  onQuit: () => void
}

export interface TrayControls {
  setUpdateReady(version: string | null): void
}

export function createTray(handlers: TrayHandlers): TrayControls {
  const tray = new Tray(path.join(app.getAppPath(), 'dist', 'assets', 'tray.png'))
  tray.setToolTip('CapturePack')

  let updateVersion: string | null = null

  const rebuildMenu = (): void => {
    // Menu order (GOAL "History" navigation):
    // Capture now · History · Open output folder · Open settings
    const items: MenuItemConstructorOptions[] = [
      { label: 'Capture now  Ctrl+Alt+C', click: () => handlers.onCapture() },
      { label: 'History', click: () => handlers.onOpenHistory() },
      { label: 'Open output folder', click: () => handlers.onOpenOutput() },
      { label: 'Settings…', click: () => handlers.onOpenSettings() },
      { type: 'separator' },
    ]
    if (updateVersion !== null) {
      items.push(
        { label: `Restart and update (v${updateVersion})`, click: () => handlers.onRestartUpdate() },
        { type: 'separator' },
      )
    }
    items.push({ label: 'Quit CapturePack', click: () => handlers.onQuit() })
    tray.setContextMenu(Menu.buildFromTemplate(items))
  }

  rebuildMenu()

  return {
    setUpdateReady(version: string | null): void {
      updateVersion = version
      rebuildMenu()
    },
  }
}
