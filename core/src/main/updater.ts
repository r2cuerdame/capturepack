// GitHub Releases auto-updater. electron-updater reads the publish config from
// electron-builder.yml and verifies the sha512 in latest.yml before applying.
// Installation happens only on app exit (autoInstallOnAppQuit), via the
// explicit restartAndUpdate() below, at the next start before capture begins
// when the previous run never quit, or at Windows shutdown once this process
// has exited (#149). Every path waits for a capture/save in progress, and the
// app is never restarted from under the user, because a live replay buffer
// would be lost.
//
// The module also keeps the LAST KNOWN state (updaterState()) so the tray menu
// item and the About window can render it without holding state of their own,
// and offers checkNow() for the manual tray check (GOAL "Tray Menu").

import { spawn, spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdaterStatusPayload } from '../shared/ipc'
import { noteExitIntent } from './lifecycle'
import { logError, logInfo, logWarn } from './log'
import {
  clearPendingUpdate,
  createIdleGate,
  hashFileSha512,
  nextPendingUpdate,
  pendingUpdateFile,
  readPendingUpdate,
  GUARDIAN_READY,
  GUARDIAN_READY_TIMEOUT_MS,
  powerShellEncodedArgs,
  runOnceArgs,
  runSessionEndHandoff,
  sessionEndGuardianScript,
  sessionEndInstallArgs,
  sessionEndPlan,
  sessionEndResultFile,
  startupInstallArgs,
  startupUpdateDecision,
  takeSessionEndResult,
  writePendingUpdate,
  type IdleGate,
  type PendingUpdate,
  type SessionEndOutcome,
  type SessionEndReason,
} from './updateInstall'

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

/**
 * A check the user asked for is owed an answer (#111).
 *
 * The four-hourly automatic check is not: "you are up to date" every four hours
 * is the routine toast #103 removed, which a locked screen reduces to an app
 * name and a red badge and which then reads as a failed capture. So the flag
 * rides from the button press to the state that answers it, and is consumed
 * whatever that answer turns out to be.
 */
let manualCheckPending = false

function setStatus(incoming: UpdaterStatusPayload): void {
  // 'checking' and 'downloading' are progress, not answers; anything else ends
  // the question the user asked.
  const answersTheUser =
    manualCheckPending && incoming.state !== 'checking' && incoming.state !== 'downloading'
  if (answersTheUser) manualCheckPending = false
  const next = answersTheUser ? { ...incoming, userRequested: true } : incoming
  // No-op transitions are dropped: 'download-progress' fires once per second
  // with a byte-identical payload, and every notify() costs a full tray menu
  // rebuild (replacing the native menu model under an OPEN context menu) plus
  // an about:state push.
  if (
    next.state === status.state &&
    next.version === status.version &&
    next.message === status.message &&
    next.userRequested === status.userRequested
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

  // Stable installs must never discover a public RC through GitHub's update
  // channel, and an RC install must graduate to the next stable build instead
  // of remaining pinned to prerelease-only updates. electron-updater otherwise
  // derives allowPrerelease from the running app's own prerelease version.
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
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
    void rememberDownloadedUpdate(info.version, info.downloadedFile)
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
  // From here on this is the user's question, and whatever comes back is its
  // answer (#111). Set before the early returns so a dev build still answers.
  manualCheckPending = true
  if (!app.isPackaged) {
    // Dev build: report the state instead of touching electron-updater.
    setStatus({ state: 'dev' })
    manualCheckPending = false
    return
  }
  if (!initialized) {
    manualCheckPending = false
    return
  }
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
    // Nothing new is being asked, so nothing new will answer.
    manualCheckPending = false
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

let installBusy: () => boolean = () => false
let restartGate: IdleGate | null = null
let quitGate: IdleGate | null = null
let sessionEndHandoff: Promise<SessionEndOutcome> | null = null

export function setUpdateInstallBusyProbe(probe: () => boolean): void {
  installBusy = probe
}

export function restartAndUpdate(): void {
  restartGate ??= createIdleGate({
    isBusy: () => installBusy(),
    onDeferred: () => logInfo('[updater] restart and update waits for the capture/save in progress'),
    run: () => {
      noteExitIntent('update-restart')
      autoUpdater.quitAndInstall(false, true)
    },
  })
  restartGate.request()
}

export function quitWhenIdle(quit: () => void): void {
  const installsOnQuit = initialized && autoUpdater.autoInstallOnAppQuit && lastDownloadedVersion !== null
  if (!installsOnQuit) {
    quit()
    return
  }
  quitGate ??= createIdleGate({
    isBusy: () => installBusy(),
    onDeferred: () => logInfo('[updater] quit and update waits for the capture/save in progress'),
    run: quit,
  })
  quitGate.request()
}

async function rememberDownloadedUpdate(version: string, installerPath: string): Promise<void> {
  if (typeof installerPath !== 'string' || installerPath === '') return
  const file = pendingUpdateFile(app.getPath('userData'))
  try {
    const previous = readPendingUpdate(file)
    if (previous !== null && previous.version === version && previous.installerPath === installerPath) {
      return
    }
    const sha512 = await hashFileSha512(installerPath)
    if (sha512 === null) {
      logWarn(`[updater] could not read the downloaded installer for v${version}`)
      return
    }
    writePendingUpdate(file, nextPendingUpdate(previous, { version, installerPath, sha512 }))
  } catch (err) {
    logError('[updater] could not record the downloaded update:', err)
  }
}

export async function installPendingUpdateBeforeCapture(autoInstall: boolean): Promise<boolean> {
  if (!app.isPackaged) return false
  const sessionEnd = takeSessionEndResult(sessionEndResultFile(app.getPath('userData')))
  if (sessionEnd !== null) {
    logInfo(
      `[updater] session-end install of v${sessionEnd.version} finished at ${sessionEnd.finishedAt} ` +
        `(setup exit ${String(sessionEnd.exitCode)}${sessionEnd.relaunched ? ', relaunched in the same session' : ''})`,
    )
  }
  const file = pendingUpdateFile(app.getPath('userData'))
  const pending = readPendingUpdate(file)
  if (pending === null) return false
  const currentVersion = app.getVersion()
  const decision = startupUpdateDecision({
    pending,
    currentVersion,
    autoInstall,
    installerSha512: await hashFileSha512(pending.installerPath),
  })
  if (decision.kind === 'none') return false
  if (decision.kind === 'clear') {
    logInfo(`[updater] pending update v${pending.version} dropped: ${decision.reason}`)
    try {
      clearPendingUpdate(file)
    } catch (err) {
      logWarn(`[updater] could not clear the pending update record: ${String(err)}`)
    }
    return false
  }
  if (decision.kind === 'keep') {
    logInfo(`[updater] pending update v${pending.version} not installed at startup: ${decision.reason}`)
    return false
  }
  try {
    writePendingUpdate(file, { ...decision.update, startupAttemptFrom: currentVersion })
  } catch (err) {
    logError('[updater] could not record the startup install attempt; continuing on the current version:', err)
    return false
  }
  const started = await new Promise<boolean>((resolve) => {
    try {
      const child = spawn(decision.update.installerPath, startupInstallArgs(), {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.once('error', (err) => {
        logError('[updater] the downloaded installer could not be started:', err)
        resolve(false)
      })
      child.once('spawn', () => {
        child.unref()
        resolve(true)
      })
    } catch (err) {
      logError('[updater] the downloaded installer could not be started:', err)
      resolve(false)
    }
  })
  if (!started) return false
  logInfo(`[updater] installing v${decision.update.version} before capture starts (previous run did not quit)`)
  noteExitIntent('update-restart')
  return true
}

function windowsSystemPath(...parts: string[]): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', ...parts)
}

function armNextSignInRun(hiddenArg: string): void {
  const result = spawnSync(windowsSystemPath('reg.exe'), runOnceArgs(process.execPath, hiddenArg), {
    timeout: 3000,
    windowsHide: true,
    stdio: 'ignore',
  })
  if (result.status !== 0) throw new Error(`reg exit ${String(result.status)}`)
  logInfo('[updater] CapturePack runs once at the next sign-in')
}

function startSessionEndGuardian(update: PendingUpdate, message: string, hiddenArg: string): Promise<boolean> {
  const script = sessionEndGuardianScript({
    installerPath: update.installerPath,
    installerArgs: sessionEndInstallArgs(),
    waitPid: process.pid,
    version: update.version,
    message,
    resultFile: sessionEndResultFile(app.getPath('userData')),
    appPath: process.execPath,
    appArgs: [hiddenArg],
  })
  return new Promise<boolean>((resolve) => {
    let settled = false
    let output = ''
    const child = spawn(
      windowsSystemPath('WindowsPowerShell', 'v1.0', 'powershell.exe'),
      powerShellEncodedArgs(script),
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    )
    const settle = (ready: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout?.removeAllListeners('data')
      child.stdout?.destroy()
      if (ready) child.unref()
      else child.kill()
      resolve(ready)
    }
    const timer = setTimeout(() => {
      logWarn('[updater] the session-end install guardian did not get ready in time')
      settle(false)
    }, GUARDIAN_READY_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      if (output.includes(GUARDIAN_READY)) settle(true)
    })
    child.once('error', (err) => {
      logError('[updater] the session-end install guardian could not be started:', err)
      settle(false)
    })
    child.once('exit', (code) => {
      if (!settled) logWarn(`[updater] the session-end install guardian exited early (${String(code)})`)
      settle(false)
    })
  })
}

export function holdSessionEndForUpdate(
  reasons: readonly SessionEndReason[],
  settings: { autoInstall: boolean; launchAtLogin: boolean; message: (version: string) => string },
  hiddenArg: string,
): boolean {
  if (sessionEndHandoff !== null) return true
  if (!app.isPackaged || process.platform !== 'win32') return false
  const file = pendingUpdateFile(app.getPath('userData'))
  const pending = readPendingUpdate(file)
  const plan = sessionEndPlan({
    reasons,
    pending,
    currentVersion: app.getVersion(),
    autoInstall: settings.autoInstall,
    launchAtLogin: settings.launchAtLogin,
  })
  if (!plan.install || pending === null) return false
  logInfo(`[updater] session ending with v${pending.version} waiting: installing it before Windows continues`)
  sessionEndHandoff = runSessionEndHandoff(plan, {
    verify: async () => {
      if ((await hashFileSha512(pending.installerPath)) === pending.sha512) return true
      logWarn(`[updater] pending update v${pending.version} dropped at session end: its installer is gone or changed`)
      clearPendingUpdate(file)
      return false
    },
    startGuardian: () => startSessionEndGuardian(pending, settings.message(pending.version), hiddenArg),
    armRelaunch: () => armNextSignInRun(hiddenArg),
    disarmQuitInstall: () => {
      if (initialized) autoUpdater.autoInstallOnAppQuit = false
    },
    isBusy: () => installBusy(),
    onDeferred: () => logInfo('[updater] the session-end install waits for the capture/save in progress'),
    quit: (outcome) => {
      logInfo(`[updater] session-end handoff: ${outcome}`)
      if (outcome !== 'dropped') noteExitIntent('update-restart')
      app.quit()
    },
  })
  return true
}

export function prepareSessionEnd(
  reasons: readonly SessionEndReason[],
  settings: { autoInstall: boolean; launchAtLogin: boolean },
  hiddenArg: string,
): void {
  if (sessionEndHandoff !== null || !app.isPackaged || process.platform !== 'win32') return
  if (initialized) autoUpdater.autoInstallOnAppQuit = false
  const plan = sessionEndPlan({
    reasons,
    pending: readPendingUpdate(pendingUpdateFile(app.getPath('userData'))),
    currentVersion: app.getVersion(),
    autoInstall: settings.autoInstall,
    launchAtLogin: settings.launchAtLogin,
  })
  if (!plan.relaunch) return
  try {
    armNextSignInRun(hiddenArg)
  } catch (err) {
    logWarn(`[updater] could not arm the next sign-in install: ${String(err)}`)
  }
}
