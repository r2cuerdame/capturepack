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

  // Dev runs must never touch the updater; same for the settings opt-out.
  if (!app.isPackaged || !opts.autoCheck) {
    report({ state: 'idle' })
    return
  }
  if (initialized) return
  initialized = true

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

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
    // Failures surface through the 'error' event above; just stop rejection.
    autoUpdater.checkForUpdates().catch(() => undefined)
  }

  check()
  // Electron timers lack unref(); clear on will-quit instead.
  const interval = setInterval(check, CHECK_INTERVAL_MS)
  app.on('will-quit', () => clearInterval(interval))
}

export function restartAndUpdate(): void {
  // isSilent=false, isForceRunAfter=true — the only permitted quitAndInstall.
  autoUpdater.quitAndInstall(false, true)
}
