// System tray icon and context menu. Labels come from the shared i18n layer;
// refresh() rebuilds the menu the moment the language, the capture hotkey, or
// the updater state changes (all three are baked into labels).
import { app, Menu, Notification, Tray } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import * as path from 'node:path'
import { makeT, recorderFailureText } from '../shared/i18n'
import type { Language, TranslateFn } from '../shared/i18n'
import type { UpdaterStatusPayload } from '../shared/ipc'
import type { RecorderState } from './capture'
import { logWarn } from './log'

export interface TrayHandlers {
  onCapture: () => void
  onImageCapture: () => void
  /**
   * The recording switch, ON THE TRAY (settings.recordingEnabled).
   *
   * It already exists in Settings > Capture, and that was the wrong home for
   * it on its own: a privacy switch is used in the moment — before a call,
   * before a screen share — and a switch that needs a window opened and a
   * section scrolled is a switch that does not get used. "on / off 버튼도
   * 넣어달랬잖아." The tray is the one surface that is always there.
   */
  onToggleRecording: (enabled: boolean) => void
  onOpenHistory: () => void
  onOpenOutput: () => void
  onOpenSettings: () => void
  onCheckUpdates: () => void
  onAbout: () => void
  onRestartUpdate: () => void
  onQuit: () => void
}

export interface TrayControls {
  setUpdateReady(version: string | null): void
  showRecordingStarted(): void
  showRecordingFailure(): void
  /**
   * Says that the PREVIOUS run died rather than exited, naming when — and that
   * the buffer was not recording from then until now. Shown once, at startup,
   * because the run it is about had no way to say it itself.
   *
   * The last of the four startup announcements to survive #80: the other three
   * reported what a watchdog had done, and there is no watchdog. This one
   * reports what HAPPENED, which is why it stays.
   */
  showPreviousRunUnclean(when: string): void
  /**
   * Rebuilds the menu with the current language, capture hotkey (settings GUI
   * instant apply), and updater state.
   */
  refresh(): void
}

// Every getter reads LIVE state at call time, so refresh() always renders what
// was just saved / just reported.
export function createTray(
  handlers: TrayHandlers,
  getLanguage: () => Language,
  getHotkey: () => string,
  getImageHotkey: () => string,
  getReplaySeconds: () => number,
  getRecorderState: () => RecorderState,
  getUpdaterState: () => UpdaterStatusPayload,
  isRecordingEnabled: () => boolean,
): TrayControls {
  const recordingIcon = path.join(app.getAppPath(), 'dist', 'assets', 'tray.png')
  const stoppedIcon = path.join(app.getAppPath(), 'dist', 'assets', 'tray-stopped.png')
  const tray = new Tray(stoppedIcon)
  // A left click has to do something: open History, the one window a user
  // reaches for repeatedly. The menu stays on right-click.
  tray.on('click', () => handlers.onOpenHistory())

  let updateVersion: string | null = null

  const refreshRecorderVisuals = (): void => {
    const t = makeT(getLanguage())
    const recorder = getRecorderState()
    switch (recorder.status) {
      case 'recording':
        tray.setImage(recordingIcon)
        tray.setToolTip(
          t('tray.tooltipRecording', {
            seconds: getReplaySeconds(),
            hotkey: getHotkey(),
          }),
        )
        break
      case 'starting':
        tray.setImage(stoppedIcon)
        tray.setToolTip(t('tray.tooltipStarting'))
        break
      case 'stopped':
        tray.setImage(stoppedIcon)
        tray.setToolTip(
          t('tray.tooltipStopped', {
            reason: recorderFailureText(t, recorder.reason),
          }),
        )
        break
    }
  }

  const rebuildMenu = (): void => {
    const t = makeT(getLanguage())
    const updater = getUpdaterState()
    // Menu order (GOAL "Tray Menu"):
    // Capture now · History · Open output folder · Settings…
    // ── Check for updates… · About CapturePack
    // ── (Restart and update, when ready) · Quit
    const recording = isRecordingEnabled()
    const items: MenuItemConstructorOptions[] = [
      // A CHECKBOX, not two items: the state IS the answer to "am I being
      // recorded", and a menu that has to be read to work that out is a menu
      // that gets misread.
      {
        label: t('tray.recordingEnabled'),
        type: 'checkbox',
        checked: recording,
        click: () => handlers.onToggleRecording(!recording),
      },
      {
        label: t('tray.captureImage', { hotkey: getImageHotkey() }),
        click: () => handlers.onImageCapture(),
      },
      {
        label: t('tray.captureVideo', { hotkey: getHotkey() }),
        // A capture with nothing recorded is not a capture. Greyed rather than
        // hidden, so the hotkey's own answer and this agree.
        enabled: recording,
        click: () => handlers.onCapture(),
      },
      { label: t('tray.history'), click: () => handlers.onOpenHistory() },
      { label: t('tray.openOutput'), click: () => handlers.onOpenOutput() },
      { label: t('tray.settings'), click: () => handlers.onOpenSettings() },
      { type: 'separator' },
      {
        // The item IS the feedback surface (GOAL: "manual check with inline
        // feedback in the menu item"): its label follows the updater state.
        label: checkUpdatesLabel(t, updater),
        enabled: canCheckUpdates(updater),
        click: () => handlers.onCheckUpdates(),
      },
      { label: t('tray.about'), click: () => handlers.onAbout() },
      { type: 'separator' },
    ]
    if (updateVersion !== null) {
      items.push({
        label: t('tray.restartUpdate', { version: updateVersion }),
        click: () => handlers.onRestartUpdate(),
      })
    }
    items.push({ label: t('tray.quit'), click: () => handlers.onQuit() })
    tray.setContextMenu(Menu.buildFromTemplate(items))
    refreshRecorderVisuals()
  }

  const showBalloon = (content: string, iconType: 'info' | 'error'): void => {
    if (process.platform === 'win32') {
      tray.displayBalloon({ title: 'CapturePack', content, iconType })
      return
    }
    new Notification({ title: 'CapturePack', body: content }).show()
  }

  rebuildMenu()

  return {
    setUpdateReady(version: string | null): void {
      updateVersion = version
      rebuildMenu()
    },
    showRecordingStarted(): void {
      const t = makeT(getLanguage())
      showBalloon(
        t('tray.recordingStarted', {
          seconds: getReplaySeconds(),
          hotkey: getHotkey(),
        }),
        'info',
      )
    },
    showRecordingFailure(): void {
      const state = getRecorderState()
      if (state.status !== 'stopped') return
      const t = makeT(getLanguage())
      // In the user's terms, not ours (issue #46): the balloon names the last N
      // seconds it promised — the same phrasing the "recording started" balloon
      // and the tooltip use — instead of a "replay buffer" the user never
      // configured and cannot see.
      const message = t('tray.recordingFailed', {
        seconds: getReplaySeconds(),
        reason: recorderFailureText(t, state.reason),
      })
      // GOAL "A failure is always announced": logged as well as shown, so the
      // guarantee is checkable after the balloon has faded.
      logWarn(`[tray] announcing recorder failure (${state.reason}): ${message}`)
      showBalloon(message, 'error')
    },
    showPreviousRunUnclean(when: string): void {
      const t = makeT(getLanguage())
      const message = t('tray.previousRunUnclean', { when })
      // On the record as well as on screen (issue #60): a balloon the user
      // dismissed is not evidence, and this one names a window of time in which
      // the product did not exist.
      logWarn(`[tray] announcing unclean previous shutdown: ${message}`)
      showBalloon(message, 'error')
    },
    refresh(): void {
      rebuildMenu()
    },
  }
}

// Every state gets its OWN label: an item that reads "Check for updates…" but
// whose click is a no-op (checkNow() returns early while a check/download is in
// flight, once an update is downloaded, and in dev runs) is a dead item. The
// installing action itself stays on the separate "Restart and update (vX)"
// item, so 'downloaded' here only reports that the update is ready.
function checkUpdatesLabel(t: TranslateFn, updater: UpdaterStatusPayload): string {
  switch (updater.state) {
    case 'checking':
      return t('tray.checkingUpdates')
    case 'up-to-date':
      return t('tray.upToDate')
    case 'available':
    case 'downloading':
      return t('tray.downloadingUpdate')
    case 'downloaded':
      return t('tray.updateDownloaded')
    case 'error':
      // A failed check must not be indistinguishable from never having checked.
      return t('tray.updateCheckFailed')
    case 'dev':
      return t('tray.updatesDevBuild')
    default:
      return t('tray.checkUpdates')
  }
}

// Enabled exactly when clicking would actually start a check — the mirror image
// of checkNow()'s early returns. Positive list on purpose: a new state defaults
// to disabled (an inert item) rather than to a dead click.
function canCheckUpdates(updater: UpdaterStatusPayload): boolean {
  switch (updater.state) {
    case 'idle':
    case 'up-to-date':
    case 'error':
      return true
    default:
      return false
  }
}
