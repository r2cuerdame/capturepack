// Main-process entry: single-instance tray app; wires hotkey, tray, capture, updater.
import { app, dialog, globalShortcut, Notification, shell } from 'electron'
import * as fs from 'node:fs'
import type { UpdaterStatusPayload } from '../shared/ipc'
import { openAboutWindow, pushAboutState, registerAboutIpc } from './aboutWindow'
import {
  disposeCapture,
  getRecorderState,
  onRecorderStateChanged,
  setupDisplayMediaHandler,
  startCapture,
} from './capture'
import type { RecorderState } from './capture'
import { disposeHistory, notifyHistoryChanged, openHistoryWindow, registerHistoryIpc } from './historyWindow'
import { registerCaptureHotkey } from './hotkey'
import { beginRun, endRun, noteExitIntent, noteUnhandledError, previousRunVanished } from './lifecycle'
import { uiLanguage, uiT } from './locale'
import { initForensics, logError, logInfo, logsDir, logWarn } from './log'
import { mcpEndpoint, startMcpAtBoot, stopMcpServer } from './mcp/service'
import { startCaptureFlow } from './session'
import { loadSettings, persistSettings } from './settings'
import { openSettingsWindow, registerSettingsIpc } from './settingsWindow'
import { createTray } from './tray'
import type { TrayControls } from './tray'
import { checkNow, initUpdater, restartAndUpdate, updaterState } from './updater'
import { openWelcomeWindow, registerWelcomeIpc } from './welcomeWindow'

const LOGIN_HIDDEN_ARG = '--openAsHidden'
const LOGIN_ITEM_NAME = 'CapturePack'

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
  // ONE line before going, on purpose (issue #60). This exit produced no record
  // at all, so a launch that "did nothing" was indistinguishable from a launch
  // that never happened — and the same silence made "MCP was never started"
  // impossible to tell apart from "MCP was never mentioned". Deliberately not
  // full initForensics(): a duplicate launch is not a run, and does not deserve
  // a crash reporter or a startup banner.
  logInfo('[app] another instance already holds the single-instance lock — this one exits')
  app.quit()
} else {
  main()
}

function main(): void {
  // BEFORE app.whenReady() (issue #60): Crashpad has to be installed before the
  // processes it is meant to catch exist, and a startup that throws must
  // already have a log file to say so in.
  //
  // The app SURVIVES an uncaught exception (log.ts explains why that is the
  // right trade for a resident buffer), so the run marker has to carry the fact
  // — otherwise will-quit records an ordinary exit and the next start certifies
  // a broken run as healthy. lifecycle counts faults from before beginRun()
  // too, which is why the hook can be wired here, first.
  initForensics({ onUnhandledError: noteUnhandledError })
  // Opens this run's marker (issue #61) and reports what happened to the last
  // one. Its answer is announced below, once the tray exists to announce it.
  const previous = beginRun()

  let stopRecorderStateListener: () => void = () => {}

  app.on('second-instance', () => {
    // Tray app with no main window: nothing to focus, the second instance quits itself.
  })

  app.on('window-all-closed', () => {
    // Tray app: keep running with zero windows (default behavior would quit).
  })

  // No 'session-end' hook: Electron 36 exposes that on BrowserWindow, and this
  // app can be windowless. A Windows logoff or shutdown still tears the app
  // down through the normal quit sequence, so it reaches will-quit and is
  // recorded as a clean exit whose cause we did not observe ('unknown') —
  // honest, and crucially NOT reported to the user as a crash (issue #61).
  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    stopRecorderStateListener()
    disposeCapture()
    disposeHistory()
    // stopMcpServer() logs what it actually did, synchronously, before its first
    // await (issue #60 — the record has to survive the exit, and the process
    // usually goes before this promise settles). It used to be announced from
    // here unconditionally, which claimed a server was being stopped on every
    // run that never started one.
    void stopMcpServer()
    // LAST: an exit that reaches here is by definition not a disappearance, and
    // this is what tells the next run so (issue #61).
    endRun()
  })

  void app.whenReady().then(async () => {
    // `firstRun` is TRUE only when no settings file existed a moment ago — the
    // one honest fresh-install signal (GOAL "Welcome": never shown on update).
    const { settings, firstRun } = loadSettings()
    // Read the launch signal BEFORE reconciling. Our Windows login entry carries
    // --openAsHidden; wasOpenedAtLogin covers platforms where Electron can
    // report it directly. Reconciliation happens once here (and on a settings
    // toggle), never continuously, so disabling the item in Task Manager cannot
    // be silently undone during that same run.
    const loginState = readLoginItemSettings()
    const openedAtLogin =
      process.argv.includes(LOGIN_HIDDEN_ARG) || loginState?.wasOpenedAtLogin === true
    reconcileLoginItem(settings.launchAtLogin, loginState)
    if (openedAtLogin && firstRun && !settings.welcomeShown) {
      // Loading a fresh profile writes settings.json, so the next manual launch
      // is no longer `firstRun`. Persist a separate marker while leaving
      // welcomeShown FALSE; the first manual launch consumes it below.
      settings.welcomeDeferredFromLogin = true
      try {
        persistSettings({ ...settings })
      } catch (err) {
        logError('capturepack: could not defer welcome window:', err)
      }
    }
    logInfo(
      `[app] launch: ${openedAtLogin ? 'at login' : 'manual'}, language ${uiLanguage(settings)}, ` +
        `displays ${settings.captureDisplay}, replay ${settings.replaySeconds}s @ ${settings.fps}fps`,
    )

    startMcpAtBoot(settings)

    setupDisplayMediaHandler()
    // The capture module owns the recorder-window set (per-display in cursor
    // mode) from here on: hotplug rebuilds happen inside it, and the settings
    // GUI applies changes via restartCapture(settings).
    // Assigned right below; the settings-GUI hooks fire only from that window,
    // which cannot open before the tray exists.
    let tray: TrayControls | null = null
    let recordingStartHandled = false
    // Whether the CURRENT failure episode has already been announced. An
    // episode ends only when the recorder proves it is recording again.
    let failureAnnounced = false

    const handleRecorderState = (state: RecorderState): void => {
      if (tray === null) return
      tray.refresh()
      if (state.status === 'recording') {
        // The failure is OVER — the only thing that ends an episode, and
        // therefore the only thing that re-arms the announcement. A later
        // failure is genuinely new information and is announced again.
        failureAnnounced = false
        if (recordingStartHandled) return
        recordingStartHandled = true
        if (settings.notifyOnRecordingStart) tray.showRecordingStarted()
        return
      }
      if (state.status === 'starting') {
        // NOT a recovery, and deliberately NOT a reset. Recovery is continuous
        // now (issue #43): every retry cycle recreates the recorder window, and
        // a fresh window is 'starting' before it fails again. Clearing here
        // turned one unresolved failure into a balloon every few minutes,
        // forever, on a machine whose screen capture is genuinely broken —
        // worse than the single balloon this replaced, and impossible to
        // dismiss for good. Only proof that frames are flowing re-arms it.
        return
      }
      // ONE balloon per failure EPISODE (GOAL "A failure is always announced"),
      // not per state change within it. A retry that fails again — with the
      // same reason or a refined one, with different byte counts in its detail
      // — is the same unresolved outage the user has already been told about,
      // and repeating it is nagging rather than news. Every transition and
      // reason is still on the record: capture.ts logs each one, and the tray
      // tooltip carries the current reason for as long as it lasts.
      if (failureAnnounced) return
      failureAnnounced = true
      // Failure is never suppressible (GOAL "Say that you are recording.").
      tray.showRecordingFailure()
    }
    stopRecorderStateListener = onRecorderStateChanged(handleRecorderState)

    await startCapture(settings)

    const capture = (): void => {
      void startCaptureFlow(settings)
    }

    // The settings GUI mutates this exact `settings` object in place, so every
    // closure below (capture flow, tray, MCP request logging) applies changes
    // the moment they are saved.
    registerSettingsIpc(settings, {
      // Instant apply (GOAL i18n): tray menu rebuilds immediately; an open
      // History window re-renders via its normal re-list push.
      onLanguageChanged: () => {
        tray?.refresh()
        notifyHistoryChanged()
        pushAboutState()
      },
      // What a re-registered capture hotkey has to trigger.
      onCapture: capture,
      // The tray's "Capture now" label and the History empty state both carry
      // the accelerator: same refresh path as a language change.
      onHotkeyChanged: () => {
        tray?.refresh()
        notifyHistoryChanged()
      },
      onLaunchAtLoginChanged: (enabled) => reconcileLoginItem(enabled),
    })
    // Same live settings object: History honors outputDir changes on next access.
    registerHistoryIpc(settings)
    // Same again: the About window resolves the UI language at call time.
    registerAboutIpc(settings)
    // Welcome window (GOAL "Welcome (first launch after install)"): [Try it
    // now] fires `capture` — the very closure the global hotkey and the tray
    // run — so the guided first capture is the real capture flow, not a copy.
    // The MCP line's endpoint comes from the RUNNING server (a getter, since it
    // binds asynchronously and may never bind at all): mcpAutoStart off or a
    // port already in use must leave the row hidden, not print a dead URL.
    registerWelcomeIpc(
      settings,
      {
        onCapture: capture,
        onOpenSettings: () => openSettingsWindow(),
      },
      () => mcpEndpoint(),
    )

    tray = createTray(
      {
        onCapture: capture,
        onOpenHistory: () => openHistoryWindow(),
        onOpenOutput: () => {
          fs.mkdirSync(settings.outputDir, { recursive: true })
          void shell.openPath(settings.outputDir)
        },
        onOpenSettings: () => openSettingsWindow(),
        // The log is only a record if a user can reach it without a terminal
        // (issue #60): this is the one place that is always present.
        onOpenLogs: () => {
          fs.mkdirSync(logsDir(), { recursive: true })
          void shell.openPath(logsDir())
        },
        // Manual check (GOAL "Tray Menu"): runs even with auto-check off; the
        // menu item's label follows the state through the getter below.
        onCheckUpdates: () => void checkNow(),
        onAbout: () => openAboutWindow(),
        onRestartUpdate: () => {
          // Not a disappearance: the app is coming straight back (issue #61).
          noteExitIntent('update-restart')
          restartAndUpdate()
        },
        onQuit: () => {
          // THE deliberate exit (issue #61): the only one that is allowed to
          // leave the machine without a replay buffer, and the only one the
          // next start must not complain about.
          noteExitIntent('user-quit')
          app.quit()
        },
      },
      () => uiLanguage(settings),
      () => settings.captureHotkey,
      () => settings.replaySeconds,
      () => getRecorderState(),
      () => updaterState(),
    )
    const trayControls = tray
    // startCapture intentionally resolves while the truthful state is still
    // "starting"; if a very fast probe completed before the tray existed, this
    // catches up the visuals and the once-per-launch notification.
    handleRecorderState(getRecorderState())

    // Dev aid / headed testing (issue #60): raise one real uncaught exception
    // and one real unhandled rejection, from a timer, the way a genuine bug
    // would. Nobody can produce a programming error on demand, and this is the
    // only way the promise that follows from surviving one — that the run
    // marker carries the fault and the next start refuses to call the run
    // clean — can be exercised for real instead of asserted. The app is
    // expected to KEEP RUNNING afterwards; that is the point.
    if (process.argv.includes('--simulate-uncaught-error')) {
      setTimeout(() => {
        throw new Error('simulated uncaught exception (--simulate-uncaught-error)')
      }, 1_000)
      setTimeout(() => {
        void Promise.reject(new Error('simulated unhandled rejection (--simulate-uncaught-error)'))
      }, 1_500)
    }

    // The sentence the user actually needed (issue #61). CapturePack cannot
    // announce its own death — there is nothing left to announce it with — so
    // the next start says it instead, plainly, including the part that matters:
    // the buffer was not running in between. Shown at a login launch too: it
    // does not steal focus, and it is the answer to "I pressed the hotkey and
    // nothing happened".
    if (previous !== null && previousRunVanished()) {
      trayControls.showPreviousRunUnclean(
        new Date(previous.record.lastAliveAt).toLocaleString(uiLanguage(settings)),
      )
    }

    if (!openedAtLogin) {
      // Dev aid: open the settings window on launch.
      if (process.argv.includes('--show-settings')) openSettingsWindow()
      // Dev aid / headed testing: open the History window on launch.
      if (process.argv.includes('--show-history')) openHistoryWindow()
      // Dev aid / headed testing: open the About window on launch.
      if (process.argv.includes('--show-about')) openAboutWindow()
      // Dev aid / headed testing: fire ONE capture on launch, through the very
      // entry point the global hotkey uses. Headed tests must never synthesize
      // a keystroke (the installed CapturePack owns the real accelerator), so
      // without this the capture flow — including what a capture SAYS when a
      // display was not recording — cannot be exercised at all.
      if (process.argv.includes('--capture-now')) capture()
      // Dev aid / headed testing: open the Welcome window on launch.
      if (process.argv.includes('--show-welcome')) {
        settings.welcomeDeferredFromLogin = false
        openWelcomeWindow()
      } else if (
        (firstRun || settings.welcomeDeferredFromLogin) &&
        !settings.welcomeShown
      ) {
        // FIRST LAUNCH ONLY (GOAL "Welcome"): a genuinely fresh install — no
        // settings file existed when settings loaded. An update always finds one,
        // so it never lands here; the stored flag alone would not be enough,
        // since a settings.json written before the flag existed defaults it to
        // false. openWelcomeWindow() persists welcomeShown, so this is once.
        // A login-triggered first launch skips this path WITHOUT setting
        // welcomeShown, so the first manual launch still receives the welcome.
        // Clearing the in-memory deferred marker before opening is persisted by
        // openWelcomeWindow() together with welcomeShown=true.
        settings.welcomeDeferredFromLogin = false
        openWelcomeWindow()
      }
    }

    const wantsHotkey = !process.argv.includes('--no-global-shortcut')
    const hotkeyRegistered = wantsHotkey && registerCaptureHotkey(settings.captureHotkey, capture)
    // Whether the accelerator was taken is the first thing to check when a user
    // says the hotkey did nothing (issues #60, #61), so it goes on the record.
    if (!wantsHotkey) logInfo('[hotkey] not registered (--no-global-shortcut)')
    else if (hotkeyRegistered) logInfo(`[hotkey] registered ${settings.captureHotkey}`)
    else logWarn(`[hotkey] REFUSED ${settings.captureHotkey} — another application holds it`)
    if (wantsHotkey && !hotkeyRegistered) {
      // Async on purpose: showErrorBox blocks the main-process event loop until
      // dismissed, which would freeze the always-on MCP server with it.
      const message = uiT(settings)('app.hotkeyFailed', { hotkey: settings.captureHotkey })
      if (openedAtLogin) {
        // Login launches must never steal focus. A notification still tells the
        // user why the configured capture shortcut is unavailable.
        new Notification({ title: 'CapturePack', body: message }).show()
      } else {
        void dialog.showMessageBox({
          type: 'error',
          title: 'CapturePack', // product name — never translated
          message,
        })
      }
    }

    // The version the "update ready" notification has already announced. A
    // scheduled re-check re-emits 'update-downloaded' for the cached file, and
    // the same toast every 4 hours would be nagging, not news.
    let notifiedVersion: string | null = null
    initUpdater({
      autoCheck: settings.autoUpdateCheck,
      onStatus: (status: UpdaterStatusPayload) => {
        // Every state change re-renders the surfaces that show it: the tray's
        // "Check for updates…" item and an open About window. setUpdateReady()
        // rebuilds the menu itself, so it REPLACES refresh() — never both.
        const readyVersion =
          status.state === 'downloaded' && status.version !== undefined && status.version !== ''
            ? status.version
            : null
        if (readyVersion !== null) {
          trayControls.setUpdateReady(readyVersion)
        } else {
          trayControls.refresh()
        }
        pushAboutState()
        // Updater activity on the record (issue #60): "it restarted itself and
        // then it was gone" is a question the log has to be able to answer.
        logInfo(
          `[updater] ${status.state}` +
            (status.version === undefined ? '' : ` v${status.version}`) +
            (status.message === undefined ? '' : ` — ${status.message}`),
        )
        if (readyVersion === null || readyVersion === notifiedVersion) return
        notifiedVersion = readyVersion
        const note = new Notification({
          title: 'CapturePack', // product name — never translated
          body: uiT(settings)('app.updateReady', { version: readyVersion }),
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
    logError('capturepack: startup failed:', err)
    void dialog
      .showMessageBox({
        type: 'error',
        title: 'CapturePack', // product name — never translated
        message: `CapturePack failed to start: ${message}`,
      })
      .then(() => {
        // A reported failure is not a disappearance (issue #61): the next start
        // must not tell the user the app crashed when it explained itself.
        noteExitIntent('startup-failure')
        app.quit()
      })
  })
}

function loginItemQuery(): { path: string; args: string[] } {
  return { path: process.execPath, args: [LOGIN_HIDDEN_ARG] }
}

function canManageLoginItem(): boolean {
  return (
    process.platform === 'win32' &&
    app.isPackaged &&
    !process.argv.includes('--no-login-item')
  )
}

function readLoginItemSettings(): Electron.LoginItemSettings | null {
  if (!canManageLoginItem()) return null
  try {
    return app.getLoginItemSettings(loginItemQuery())
  } catch (err) {
    logError('capturepack: could not read login item:', err)
    return null
  }
}

function sameArgs(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function reconcileLoginItem(
  enabled: boolean,
  current: Electron.LoginItemSettings | null = readLoginItemSettings(),
): void {
  if (!canManageLoginItem()) return
  const query = loginItemQuery()
  const item = current?.launchItems.find(
    (candidate) =>
      candidate.scope === 'user' &&
      candidate.name === LOGIN_ITEM_NAME &&
      candidate.path.toLocaleLowerCase() === query.path.toLocaleLowerCase(),
  )
  const entryExists = item !== undefined || current?.openAtLogin === true
  const entryMatches = item !== undefined ? sameArgs(item.args, query.args) : current?.openAtLogin === true
  const entryEnabled =
    item !== undefined ? item.enabled : current?.executableWillLaunchAtLogin === true
  const matches = current !== null && (enabled ? entryExists && entryMatches && entryEnabled : !entryExists)
  if (matches) return
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      enabled,
      name: LOGIN_ITEM_NAME,
      ...query,
    })
  } catch (err) {
    // Keep the user's setting as the source of truth; the next manual startup
    // reconciles again if Windows refused this attempt.
    logError('capturepack: could not update login item:', err)
  }
}
