// GitHub Releases auto-updater. electron-updater reads the publish config from
// electron-builder.yml and verifies the sha512 in latest.yml before applying.
// Installation happens only on app exit (autoInstallOnAppQuit) or via the
// explicit restartAndUpdate() below — the app is never restarted from under
// the user, because a live replay buffer would be lost.
//
// The module also keeps the LAST KNOWN state (updaterState()) so the tray menu
// item and the About window can render it without holding state of their own,
// and offers checkNow() for the manual tray check (GOAL "Tray Menu").

import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdaterStatusPayload } from '../shared/ipc'
import { logError, logInfo } from './log'

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
// How long "You're up to date" stays on the tray item after a finished check
// before the item falls back to its idle label. Clicking a tray item closes the
// menu on Windows, so the user has to RE-OPEN the menu to read the result: the
// window has to be long enough to survive that round trip, not just long enough
// to be technically visible.
const UP_TO_DATE_MS = 60_000

let initialized = false
// Live value of the autoUpdateCheck setting; setAutoUpdateCheck keeps it in
// sync so the GUI toggle applies this run, not only at the next boot.
let autoCheckEnabled = false
let runCheck: (() => void) | null = null

// Last known state + the single listener (index.ts fans it out to the tray and
// the About window). Every state change goes through setStatus.
let status: UpdaterStatusPayload = { state: 'idle' }
let notify: ((s: UpdaterStatusPayload) => void) | null = null
let upToDateTimer: NodeJS.Timeout | null = null
// STICKY: the version of an update that finished downloading, kept across
// later checks. electron-updater re-validates the cached file on every
// subsequent check, so the transient state cycles
// downloaded -> checking -> available -> downloaded again; the installable file
// never leaves the disk in between. The tray's "Restart and update (vX)" item
// is sticky for exactly this reason, and the About window's Restart button
// follows THIS value rather than the transient state so the two never disagree.
let lastDownloadedVersion: string | null = null

function setStatus(next: UpdaterStatusPayload): void {
  // No-op transitions are dropped: 'download-progress' fires once per second
  // with a byte-identical payload, and every notify() costs a full tray menu
  // rebuild (replacing the native menu model under an OPEN context menu) plus
  // an about:state push.
  if (
    next.state === status.state &&
    next.version === status.version &&
    next.message === status.message
  ) {
    return
  }
  if (upToDateTimer !== null) {
    clearTimeout(upToDateTimer)
    upToDateTimer = null
  }
  status = next
  try {
    notify?.(next)
  } catch {
    // A broken status listener must never take the updater down.
  }
  if (next.state === 'up-to-date') {
    // Transient by design: the menu item says "You're up to date" for
    // UP_TO_DATE_MS — long enough to survive re-opening the tray menu the click
    // just closed — then reads "Check for updates…" again.
    upToDateTimer = setTimeout(() => {
      upToDateTimer = null
      setStatus({ state: 'idle' })
    }, UP_TO_DATE_MS)
  }
}

/** The last known updater state — what the tray item and About window render. */
export function updaterState(): UpdaterStatusPayload {
  return { ...status }
}

/**
 * Version of an update that has finished downloading and is waiting for a
 * restart, or null when none is. Sticky: a later check never clears it (see
 * lastDownloadedVersion above), so "an update is installable right now" is
 * answered the same way for the tray item, the About window's Restart button,
 * and the updater:restart guard.
 */
export function downloadedVersion(): string | null {
  return lastDownloadedVersion
}

export function initUpdater(opts: {
  autoCheck: boolean
  onStatus?: (s: UpdaterStatusPayload) => void
}): void {
  notify = opts.onStatus ?? null

  // Dev runs must never touch the updater.
  if (!app.isPackaged) {
    setStatus({ state: 'dev' })
    return
  }
  if (initialized) return
  initialized = true
  autoCheckEnabled = opts.autoCheck

  autoUpdater.autoDownload = true
  // Kept in sync with the setting (here and in setAutoUpdateCheck) so opting
  // out also stops a previously downloaded update from installing on quit.
  autoUpdater.autoInstallOnAppQuit = opts.autoCheck

  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    setStatus({ state: 'available', version: info.version }),
  )
  autoUpdater.on('update-not-available', () => setStatus({ state: 'up-to-date' }))
  autoUpdater.on('download-progress', () => setStatus({ state: 'downloading' }))
  autoUpdater.on('update-downloaded', (info) => {
    lastDownloadedVersion = info.version
    setStatus({ state: 'downloaded', version: info.version })
  })
  autoUpdater.on('error', (err) => {
    const message = err instanceof Error ? err.message : String(err)
    // AN EMPTY RELEASES PAGE IS NOT A FAILURE.
    //
    // electron-updater raises "No published versions on GitHub" as an error,
    // and the tray dutifully reported "업데이트 확인 실패" — on a project that
    // has simply not cut a release yet. The check reached GitHub, GitHub
    // answered, and the answer was "nothing here". That is the definition of
    // up to date, and calling it a failure trains the user to ignore the one
    // message that should mean something when an update really cannot be
    // fetched.
    if (/no published versions/i.test(message)) {
      logInfo('[updater] no releases published yet — nothing to update to')
      setStatus({ state: 'idle' })
      return
    }
    // Log and report only — a failed check or download leaves the running
    // version untouched and the next scheduled check will retry. It goes to the
    // log file too (issue #60): an updater that quietly fails for weeks is
    // otherwise indistinguishable from one that has nothing to do.
    logError('[updater] check/download failed:', err)
    setStatus({ state: 'error', message })
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
  app.on('will-quit', () => {
    clearInterval(interval)
    if (upToDateTimer !== null) clearTimeout(upToDateTimer)
  })
}

/**
 * Manual check from the tray (GOAL "Tray Menu" > Check for updates…). Unlike
 * the scheduled check this runs even when autoUpdateCheck is OFF — the user
 * asked for it explicitly — so a found update downloads and offers
 * "Restart and update"; with the setting off it still never installs on quit
 * by itself. Progress is reported through the same state listener, so the tray
 * item and the About window follow along.
 */
export async function checkNow(): Promise<void> {
  if (!app.isPackaged) {
    // Dev build: report the state instead of touching electron-updater.
    setStatus({ state: 'dev' })
    return
  }
  if (!initialized) return
  // A check/download already in flight, or an update already waiting for the
  // "Restart and update" item, needs no second request. 'available' counts as
  // in flight: autoDownload has already started fetching, it just has not
  // reported its first progress tick yet, and a second checkForUpdates() there
  // only flips the label back to "Checking for updates…" mid-download.
  if (
    status.state === 'checking' ||
    status.state === 'available' ||
    status.state === 'downloading' ||
    status.state === 'downloaded'
  ) {
    return
  }
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    // The 'error' event normally reports this already; this guard exists so a
    // rejection that skips the event can never leave the menu item stuck on a
    // disabled "Checking for updates…". (Read through updaterState() — the
    // events above have re-assigned `status` while this call was awaited.)
    if (updaterState().state === 'checking') {
      setStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }
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
