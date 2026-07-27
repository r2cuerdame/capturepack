// GitHub Releases auto-updater. electron-updater reads the publish config from
// electron-builder.yml and verifies the sha512 in latest.yml before applying.
// Installation happens only on app exit (autoInstallOnAppQuit) or via the
// explicit restartAndUpdate() below — the app is never restarted from under
// the user, because a live replay buffer would be lost.

import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdaterStatusPayload } from '../shared/ipc'

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

let initialized = false
// Live value of the autoUpdateCheck setting; setAutoUpdateCheck keeps it in
// sync so the GUI toggle applies this run, not only at the next boot.
let autoCheckEnabled = false
let runCheck: (() => void) | null = null

export function initUpdater(opts: {
  autoCheck: boolean
  onStatus?: (s: UpdaterStatusPayload) => void
}): void {
  const report = (s: UpdaterStatusPayload): void => {
    try {
      opts.onStatus?.(s)
    } catch {
      // A broken status listener must never take the updater down.
    }
  }

  // Dev runs must never touch the updater.
  if (!app.isPackaged) {
    report({ state: 'idle' })
    return
  }
  if (initialized) return
  initialized = true
  autoCheckEnabled = opts.autoCheck

  autoUpdater.autoDownload = true
  // Kept in sync with the setting (here and in setAutoUpdateCheck) so opting
  // out also stops a previously downloaded update from installing on quit.
  autoUpdater.autoInstallOnAppQuit = opts.autoCheck

  autoUpdater.on('checking-for-update', () => report({ state: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    report({ state: 'available', version: info.version }),
  )
  autoUpdater.on('update-not-available', () => report({ state: 'idle' }))
  autoUpdater.on('download-progress', () => report({ state: 'downloading' }))
  autoUpdater.on('update-downloaded', (info) =>
    report({ state: 'downloaded', version: info.version }),
  )
  autoUpdater.on('error', (err) => {
    // Log and report only — a failed check or download leaves the running
    // version untouched and the next scheduled check will retry.
    console.error('[updater]', err)
    report({ state: 'error', message: err instanceof Error ? err.message : String(err) })
  })

  const check = (): void => {
    // Gated on the LIVE setting, not the boot value: the settings GUI opt-out
    // stops future checks (and downloads) this run.
    if (!autoCheckEnabled) return
    // Failures surface through the 'error' event above; just stop rejection.
    autoUpdater.checkForUpdates().catch(() => undefined)
  }
  runCheck = check

  check()
  // Electron timers lack unref(); clear on will-quit instead.
  const interval = setInterval(check, CHECK_INTERVAL_MS)
  app.on('will-quit', () => clearInterval(interval))
}

// Applies the settings GUI's autoUpdateCheck toggle instantly: enabling checks
// right away and resumes the 4-hour cadence; disabling stops future checks and
// install-on-quit. A download already in flight is not aborted, but it will
// not install on quit while disabled. No-op in dev runs (updater untouched).
export function setAutoUpdateCheck(enabled: boolean): void {
  autoCheckEnabled = enabled
  if (!initialized) return
  autoUpdater.autoInstallOnAppQuit = enabled
  if (enabled) runCheck?.()
}

export function restartAndUpdate(): void {
  // isSilent=false, isForceRunAfter=true — the only permitted quitAndInstall.
  autoUpdater.quitAndInstall(false, true)
}
