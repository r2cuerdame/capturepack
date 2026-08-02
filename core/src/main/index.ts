// Main-process entry: single-instance tray app; wires hotkey, tray, capture, updater.
import { app, dialog, globalShortcut, Notification, powerMonitor, shell } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { UpdaterStatusPayload } from '../shared/ipc'
import { openAboutWindow, pushAboutState, registerAboutIpc } from './aboutWindow'
import {
  disposeCapture,
  getRecorderState,
  onRecorderStateChanged,
  setupDisplayMediaHandler,
  restartCapture,
  startCapture,
} from './capture'
import type { RecorderState } from './capture'
import {
  contextNowMs,
  startContextRuntime,
  stopContextRuntime,
  updateContextRetention,
} from './context/runtime'
import { setDomClock, setDomRetention, startDomBridge, stopDomBridge } from './chrome/domBridge'
import { refreshHostManifestIfInstalled, syncExtensionIfChanged } from './chrome/install'
import { disposeHistory, notifyHistoryChanged, openHistoryWindow, registerHistoryIpc } from './historyWindow'
import {
  registerCaptureHotkey,
  registerImageCaptureHotkey,
} from './hotkey'
import {
  beginRun,
  endRun,
  noteExitIntent,
  noteUnhandledError,
  previousRunVanished,
} from './lifecycle'
import { uiLanguage, uiT } from './locale'
import { initForensics, logError, logInfo, logWarn } from './log'
import { mcpEndpoint, startMcpAtBoot, stopMcpServer } from './mcp/service'
import { armSaveNow, saveNowRequest } from './saveNow'
import { startCaptureFlow, startImageCaptureFlow } from './session'
import { loadSettings, persistSettings } from './settings'
import { openSettingsWindow, registerSettingsIpc } from './settingsWindow'
import { createTray } from './tray'
import type { TrayControls } from './tray'
import { checkNow, initUpdater, restartAndUpdate, updaterState } from './updater'
import { openWelcomeWindow, registerWelcomeIpc } from './welcomeWindow'

const LOGIN_HIDDEN_ARG = '--openAsHidden'
const LOGIN_ITEM_NAME = 'CapturePack'

/**
 * True when THIS process was started by a browser as a native messaging host.
 *
 * TWO WAYS TO KNOW, AND THE SECOND IS THE ONE THAT MATTERS. `--native-host` is
 * how the app and the bridge test start a host on purpose. Chrome cannot pass
 * it: a native messaging manifest names an executable and nothing else, and
 * Chrome supplies its OWN arguments — the calling extension's origin, and on
 * Windows a --parent-window handle. So a host registered as CapturePack.exe was
 * launched with no flag at all, fell through to the single-instance branch
 * below, saw the running app's lock and exited within milliseconds. Every check
 * in Settings passed except the two that need a live host, which is exactly
 * what "설치했는데 연결됨이 안됨" looks like from the outside.
 *
 * The origin argument is the tell, and it is one only a browser sends.
 */
function startedAsNativeHost(): boolean {
  if (process.argv.includes('--native-host')) return true
  return process.argv.some((arg) => arg.startsWith('chrome-extension://'))
}

if (startedAsNativeHost()) {
  // Chrome started this process as a native messaging host (GOAL "Chrome
  // Extension"). It relays frames to the running app and exits when the
  // browser hangs up.
  //
  // FIRST, and outside the single-instance lock: the app holds that lock, and
  // a host that waited for it would hang the browser's extension port forever.
  // No window, no tray, no settings, no log file — stdout belongs to Chrome
  // here, and anything else written to it would be read as a protocol frame.
  void import('./chrome/nativeHost').then(async ({ runNativeHostMode }) => {
    await runNativeHostMode()
    app.exit(0)
  })
} else if (process.argv.includes('--smoke')) {
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
  // A HIDDEN RECORDER IS STILL A RECORDER (#95).
  //
  // The capture windows already set `backgroundThrottling: false`, which stops
  // their TIMERS being throttled. It does not stop Chromium BACKGROUNDING the
  // renderer process itself: a window that is hidden — which every capture
  // window is, by design — has its process priority lowered, and on Windows a
  // lowered renderer loses the CPU to whatever is in the foreground.
  //
  // Measured, with the recorder finally reporting its own cadence (#82): BOTH
  // displays stall together, 806 ms and 892 ms in one 16 s recording, at 12.8
  // and 10.3 fps against 15 requested. Two independent recorders in two
  // separate renderers stalling by the same amount at the same time is a shared
  // cause, and the thing they share is the scheduler's opinion of how important
  // a hidden window is. The same stalls are in packs from before the surface
  // ring sampled per frame, so it is not that either.
  //
  // These must be set before whenReady: Chromium reads them once, at startup.
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  // A hidden window is occluded by definition, and an occluded window's
  // compositor can be told to stop producing frames — which is the capture.
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

  // WHOSE NOTIFICATION IS THIS. Windows does not take the sender's name from the
  // toast — it takes it from the process's App User Model ID, and an Electron
  // app that never sets one is attributed to "Electron", complete with Electron's
  // icon. So the recording-started and recorder-failed toasts, whose entire job
  // is to say that CAPTUREPACK is or is not recording, arrived signed by a
  // program the user never installed. This is the same id electron-builder
  // stamps on the Start Menu shortcut (electron-builder.yml appId), so the toast
  // and the shortcut are one identity as far as Windows is concerned.
  if (process.platform === 'win32') {
    app.setAppUserModelId('io.github.r2cuerdame.capturepack')
  }

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
  let launchUiReady = false
  let queuedLaunchArgv: readonly string[] | null = null

  const openSecondLaunchUi = (argv: readonly string[]): void => {
    if (argv.includes('--show-settings')) {
      openSettingsWindow()
      return
    }
    if (argv.includes('--show-history')) {
      openHistoryWindow()
      return
    }
    if (argv.includes('--show-welcome')) {
      openWelcomeWindow()
      return
    }
    logInfo('[app] manual second launch: opening About')
    openAboutWindow()
  }

  app.on('second-instance', (_event, argv) => {
    // NO SECOND LAUNCH FIRES A CAPTURE ANY MORE (#80). Until 0.3.4 a launch
    // carrying `--capture` was a hotkey press forwarded by the Start Menu
    // fallback shortcut, and this handler ran the capture flow for it. The
    // fallback is gone with the watchdog, so nothing produces that argument and
    // every second launch is a person double-clicking CapturePack — which must
    // open a window, never record.
    //
    // A login/recovery launch is intentionally silent. Every manual second
    // launch, however, must produce a visible result: packaged shortcuts and
    // headed checks both land here while the tray instance is already alive.
    // Previously --show-about (and an ordinary shortcut double-click) vanished
    // at this boundary, which made the installed app appear broken.
    if (argv.includes(LOGIN_HIDDEN_ARG)) return
    if (!launchUiReady) {
      // app.whenReady() can have fired while recorder startup is still awaiting
      // its first frames. Window IPC is registered later in that same startup
      // path, so opening here would render an empty Information window that
      // never retries. Coalesce repeated shortcut clicks and dispatch the last
      // request as soon as every window bridge is ready.
      queuedLaunchArgv = argv
      logInfo('[app] manual second launch queued until window IPC is ready')
      return
    }
    openSecondLaunchUi(argv)
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
    // The Context Host is a child process of ours and exits on stdin EOF anyway,
    // but stopping it here is what makes the surface timeline's final cost line
    // land in the log before the process goes (issues #64/#65).
    stopContextRuntime()
    stopDomBridge()
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
    // FIRST, before anything a browser could talk to: a running main process is
    // proof that setup is over.
    clearInstallerStandDown()
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
    // SHUTTING THE RECORDERS DOWN IS NOT A RECORDING FAILURE (#63).
    //
    // Closing the recorder windows is one of the first things quitting does,
    // and the recorders report exactly what happened: 'process-stopped'. Read
    // as an outage, that produced a balloon saying the last N seconds were not
    // being recorded — on every deliberate exit, as the tray icon it came from
    // was disappearing. Nothing is lost from the record: capture.ts still logs
    // every state transition. What goes is the claim that a shutdown broke
    // something, which is also what makes "announced exactly once" a fact CI
    // can assert on rather than a count polluted by the exit itself.
    let quitting = false
    app.on('before-quit', () => {
      quitting = true
    })

    const handleRecorderState = (state: RecorderState): void => {
      if (tray === null || quitting) return
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

    // With recording disabled this builds an EMPTY recorder set — the same
    // reconcile path, zero recorders — so flipping the setting later is an
    // ordinary rebuild rather than a special boot.
    await startCapture(settings)

    // The Platform Surface Timeline (issue #65) starts WITH the recorder and
    // for the same reason: it is the semantic half of the ring buffer, and a
    // surface stack that only exists from the moment someone asks for it could
    // never answer a question about thirty seconds ago. It is started AFTER the
    // recorder so that a machine where recording itself is failing does not also
    // pay for a context host it will never be asked about.
    startContextRuntime({
      replayMs: settings.replaySeconds * 1000,
      fps: settings.fps,
      uiaEnabled: settings.uiaEnabled,
    })
    // The browser half of the same idea (GOAL "Chrome Extension"): DOM events
    // on the replay clock, so an element and the window it sits in can be
    // named at one instant. Started after the runtime because it borrows that
    // clock, and it costs nothing while no browser is talking.
    setDomClock(() => contextNowMs() ?? Date.now())
    setDomRetention(settings.replaySeconds * 1000)
    if (settings.chromeDomEnabled) {
      // Update the stable unpacked folder BEFORE answering the extension's
      // hello. Version 0.1.7+ compares the reply with its loaded version and
      // asks Chromium to reload itself when the folder is newer.
      syncExtensionIfChanged()
      // A registration written by a previous build keeps describing it. This
      // refreshes an existing install but deliberately does not create one.
      refreshHostManifestIfInstalled()
      startDomBridge()
    }

    const capture = (): void => {
      // Recording OFF is a privacy switch, not a broken hotkey (settings.
      // recordingEnabled): there is no buffer, so there is nothing a capture
      // could truthfully show — and silence here would read as the app being
      // dead, which is the failure #61 exists to prevent. Say why, instead.
      if (!settings.recordingEnabled) {
        new Notification({
          title: 'CapturePack', // product name — never translated
          body: uiT(settings)('app.recordingOff'),
        }).show()
        return
      }
      void startCaptureFlow(settings)
    }
    const imageCapture = (): void => {
      // Explicit still capture is independent from the replay privacy switch:
      // it freezes pixels only after this user action and never queries or
      // restarts the always-on recorder.
      void startImageCaptureFlow(settings)
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
      onImageCapture: imageCapture,
      // The tray's "Capture now" label and the History empty state both carry
      // the accelerator: same refresh path as a language change.
      onHotkeyChanged: () => {
        tray?.refresh()
        notifyHistoryChanged()
      },
      onImageHotkeyChanged: () => {
        tray?.refresh()
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
    launchUiReady = true
    if (queuedLaunchArgv !== null) {
      const argv = queuedLaunchArgv
      queuedLaunchArgv = null
      openSecondLaunchUi(argv)
    }

    tray = createTray(
      {
        onCapture: capture,
        onImageCapture: imageCapture,
        // The privacy switch where it is actually reachable (settings.
        // recordingEnabled). Persisted and applied through the SAME paths the
        // Settings toggle uses, so the two can never disagree: an empty
        // recorder set is an ordinary rebuild, and the tray re-renders from
        // live state on its next open.
        onToggleRecording: (enabled) => {
          settings.recordingEnabled = enabled
          try {
            persistSettings({ ...settings })
          } catch (err) {
            logWarn(`[tray] could not save the recording switch: ${String(err)}`)
          }
          void restartCapture(settings)
          logInfo(`[capture] recording ${enabled ? 'ON' : 'OFF'} (tray)`)
          tray?.refresh()
        },
        onOpenHistory: () => openHistoryWindow(),
        onOpenOutput: () => {
          fs.mkdirSync(settings.outputDir, { recursive: true })
          void shell.openPath(settings.outputDir)
        },
        onOpenSettings: () => openSettingsWindow(),
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
      () => settings.imageCaptureHotkey,
      () => settings.replaySeconds,
      () => getRecorderState(),
      () => updaterState(),
      () => settings.recordingEnabled,
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

    // THE ONE THING THE PREVIOUS RUN COULD NOT SAY ITSELF (#80).
    //
    // 0.3.4 had four announcements here, three of which existed only because a
    // watchdog had done something: it relaunched the app, it gave up
    // relaunching, or the Start Menu fallback started the app on a hotkey
    // press. #80 removed the supervisor, so this is the survivor — and it is
    // the one that carries the information. CapturePack cannot announce its own
    // death (there is nothing left to announce it with), so the next start says
    // it instead, plainly, including the part that matters: the buffer was not
    // running in between. Shown at a login launch too: it does not steal focus.
    // It is now the sole `if`, not the tail of an else-chain — the three
    // branches that used to precede it would each have suppressed it.
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
      // `--capture-now[=SECONDS]`. The delay is not a convenience: anything
      // that depends on the replay buffer or the surface ring being FULL cannot
      // be tested by capturing the instant the app starts, when both hold a
      // fraction of a second. Verifying that picking follows the scrub needs a
      // ring with real motion in it, and there is no other way to get one
      // without synthesizing the hotkey — which no automated test may do,
      // because the installed CapturePack owns the real accelerator.
      const captureNow = process.argv.find((arg) => arg.startsWith('--capture-now'))
      if (captureNow !== undefined) {
        const seconds = Number(captureNow.split('=')[1] ?? '0')
        const delayMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 0
        if (delayMs === 0) capture()
        else {
          logInfo(`[capture] --capture-now: capturing in ${String(seconds)}s`)
          setTimeout(() => {
            void capture()
          }, delayMs)
        }
      }
      // `--save-now[=SECONDS]` (#63): the half of an unattended capture nobody
      // can press. `--capture-now` above opens the editor exactly the way the
      // hotkey does — and then the flow waits for a person, which on a CI
      // runner never arrives. Armed here rather than inside the capture flow so
      // that a capture which never even starts still ends in an exit code
      // instead of a job that hangs until its timeout.
      const saveNow = saveNowRequest(process.argv)
      if (saveNow !== null) {
        logInfo(
          `[capture] --save-now: the editor will save without a person; ` +
            `deadline ${String(Math.round(saveNow.deadlineMs / 1_000))}s`,
        )
        void armSaveNow(saveNow).then((verdict) => {
          logInfo(
            `[capture] --save-now: ${verdict.result} (exit ${String(verdict.exitCode)})` +
              (verdict.dirPath === null ? '' : ` — ${verdict.dirPath}`),
          )
          // A deliberate exit, and recorded as one: without this the next start
          // in the same user-data directory would report the run as a
          // disappearance (issue #61) and CI would inherit a false alarm.
          noteExitIntent('unattended-save')
          // app.quit() first so will-quit runs — that is what closes the run
          // marker, stops the recorders and flushes the log. app.exit() alone
          // skips all of it, and app.quit() alone cannot carry an exit code, so
          // the code is applied from a listener registered after the one
          // installed at startup and therefore running after it.
          app.once('will-quit', () => app.exit(verdict.exitCode))
          app.quit()
        })
      }
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

    // ONE HOLDER OF THE ACCELERATOR, ALWAYS THIS PROCESS (#80). Registration
    // used to be preceded by supervision taking the key back from Explorer,
    // which held it on behalf of the Start Menu fallback shortcut, and by a
    // retry budget for the second or two Explorer needs to let go. With no
    // fallback there is no handover: a refusal here is a real conflict with
    // another application, immediately, and is reported as one.
    const wantsHotkey = !process.argv.includes('--no-global-shortcut')
    const hotkeyRegistered = wantsHotkey && registerCaptureHotkey(settings.captureHotkey, capture)
    const wantsImageHotkey = !process.argv.includes('--no-global-shortcut')
    const imageHotkeyRegistered =
      wantsImageHotkey &&
      registerImageCaptureHotkey(settings.imageCaptureHotkey, imageCapture)
    // Whether the accelerator was taken is the first thing to check when a user
    // says the hotkey did nothing (issue #60), so it goes on the record.
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
    if (!wantsImageHotkey) {
      logInfo('[hotkey] image capture not registered (--no-global-shortcut)')
    } else if (imageHotkeyRegistered) {
      logInfo(`[hotkey] registered image capture ${settings.imageCaptureHotkey}`)
    } else {
      logWarn(
        `[hotkey] REFUSED image capture ${settings.imageCaptureHotkey} — ` +
          'another application or the video action holds it',
      )
      const message = uiT(settings)('app.hotkeyFailed', {
        hotkey: settings.imageCaptureHotkey,
      })
      if (openedAtLogin) {
        new Notification({ title: 'CapturePack', body: message }).show()
      } else {
        void dialog.showMessageBox({
          type: 'error',
          title: 'CapturePack',
          message,
        })
      }
    }

    // The version the "update ready" notification has already announced. A
    // scheduled re-check re-emits 'update-downloaded' for the cached file, and
    // the same toast every 4 hours would be nagging, not news.
    let notifiedVersion: string | null = null
    // A ROUTINE TOAST ON A LOCKED SCREEN READS AS A FAILURE (#103).
    //
    // Windows hides notification content on the lock screen when the user asked
    // it to, and what is left is the app name, a generic red badge and the word
    // "비공개". Observed 2026-07-30: the pending v0.3.2 update-ready toast
    // appeared exactly like a recording error, and the only way to find out
    // otherwise was to read the Windows notification database.
    //
    // The cure is not to shout differently — it is not to shout at a screen
    // nobody is reading. An available update is not urgent, the tray already
    // carries it, and the toast is held until the session comes back. A REAL
    // capture failure is a different message and is deliberately untouched
    // here: "a capture failure must not be presented as success" outranks this.
    let sessionLocked = false
    let deferredUpdateToast: string | null = null
    const showUpdateToast = (version: string): void => {
      const note = new Notification({
        title: 'CapturePack', // product name — never translated
        body: uiT(settings)('app.updateReady', { version }),
      })
      note.on('click', () => restartAndUpdate())
      note.show()
    }
    powerMonitor.on('lock-screen', () => {
      sessionLocked = true
    })
    powerMonitor.on('unlock-screen', () => {
      sessionLocked = false
      const held = deferredUpdateToast
      if (held === null) return
      deferredUpdateToast = null
      logInfo(`[updater] showing the update-ready notice held over the lock screen (v${held})`)
      showUpdateToast(held)
    })
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
        // A CHECK THE USER ASKED FOR IS OWED AN ANSWER (#111).
        //
        // "Check for updates…" with nothing to report changed a tray label for
        // a few seconds and otherwise did nothing, so pressing it looked
        // identical to pressing it while it was broken. The toast is only for a
        // check the user actually requested — `userRequested` does not travel
        // with the four-hourly automatic one, which is precisely the routine
        // update noise #103 removed.
        if (status.state === 'up-to-date' && status.userRequested === true) {
          new Notification({
            title: 'CapturePack', // product name — never translated
            body: uiT(settings)('app.upToDate', { version: app.getVersion() }),
          }).show()
          return
        }
        if (readyVersion === null || readyVersion === notifiedVersion) return
        notifiedVersion = readyVersion
        if (sessionLocked) {
          // Held, not dropped: the user still learns about the update, at the
          // moment they can act on it. The tray carries it in the meantime.
          deferredUpdateToast = readyVersion
          logInfo(`[updater] update-ready notice held while the screen is locked (v${readyVersion})`)
          return
        }
        showUpdateToast(readyVersion)
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

/**
 * Clears the installer's stand-down flag, %APPDATA%\CapturePack\supervision-standdown.
 *
 * THIS IS NOT SUPERVISION, DESPITE THE FILE NAME (#80). build/installer.nsh
 * writes the flag before it closes the running app, and chrome/nativeHostEntry.ts
 * exits immediately for as long as it exists — that handshake is how a Chrome
 * native messaging host stops holding CapturePack.exe open while setup replaces
 * it. It survives the watchdog's removal untouched, name included, so an
 * upgrade from 0.3.4 can still stand that build's watchdog down.
 *
 * Clearing it used to live in supervisor.ts because supervision happened to be
 * the first thing that ran. It has to live SOMEWHERE: an installer that dies
 * between writing the flag and deleting it would otherwise leave it forever,
 * and every future native host launch would exit silently on a perfectly
 * healthy app. A live main process is the honest proof that setup is finished,
 * so the app clears it here, on every start, best effort.
 */
function clearInstallerStandDown(): void {
  if (process.platform !== 'win32') return
  try {
    fs.rmSync(path.join(app.getPath('userData'), 'supervision-standdown'), { force: true })
  } catch (err) {
    logWarn(`[app] could not clear the installer stand-down flag: ${String(err)}`)
  }
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
