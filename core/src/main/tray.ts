// System tray icon and context menu. Labels come from the shared i18n layer;
// refresh() rebuilds the menu the moment the language OR the capture hotkey
// setting changes (both are baked into the "Capture now" label).
import { app, Menu, Tray } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import * as path from 'node:path'
import { makeT } from '../shared/i18n'
import type { Language } from '../shared/i18n'

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
  /**
   * Rebuilds the menu with the current language and capture hotkey (settings
   * GUI instant apply).
   */
  refresh(): void
}

// Both getters read the LIVE settings object at call time, so refresh() always
// renders what was just saved.
export function createTray(
  handlers: TrayHandlers,
  getLanguage: () => Language,
  getHotkey: () => string,
): TrayControls {
  const tray = new Tray(path.join(app.getAppPath(), 'dist', 'assets', 'tray.png'))
  tray.setToolTip('CapturePack') // product name — never translated

  let updateVersion: string | null = null

  const rebuildMenu = (): void => {
    const t = makeT(getLanguage())
    // Menu order (GOAL "History" navigation):
    // Capture now · History · Open output folder · Open settings
    const items: MenuItemConstructorOptions[] = [
      { label: t('tray.captureNow', { hotkey: getHotkey() }), click: () => handlers.onCapture() },
      { label: t('tray.history'), click: () => handlers.onOpenHistory() },
      { label: t('tray.openOutput'), click: () => handlers.onOpenOutput() },
      { label: t('tray.settings'), click: () => handlers.onOpenSettings() },
      { type: 'separator' },
    ]
    if (updateVersion !== null) {
      items.push(
        {
          label: t('tray.restartUpdate', { version: updateVersion }),
          click: () => handlers.onRestartUpdate(),
        },
        { type: 'separator' },
      )
    }
    items.push({ label: t('tray.quit'), click: () => handlers.onQuit() })
    tray.setContextMenu(Menu.buildFromTemplate(items))
  }

  rebuildMenu()

  return {
    setUpdateReady(version: string | null): void {
      updateVersion = version
      rebuildMenu()
    },
    refresh(): void {
      rebuildMenu()
    },
  }
}
