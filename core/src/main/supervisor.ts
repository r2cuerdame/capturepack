// Supervision: the app-side half of "CapturePack does not just vanish"
// (issue #61). The other half is src/watchdog/watchdog.ts, the detached process
// this module starts.
//
// THE PROMISE (GOAL "Never disappear without a word." > "And do not stay
// gone."): pressing the capture hotkey always produces a visible result — a
// capture, the app starting, or a message. Never silence. Two mechanisms keep
// it, and this module owns both:
//
//  1. A DETACHED WATCHDOG. It watches this run's pid, asks lifecycle.ts's
//     marker whether the exit was intended, and relaunches once — promptly,
//     rate-limited, and never silently — when it was not.
//  2. A START MENU FALLBACK SHORTCUT. While the app is alive it holds the
//     accelerator itself, so a capture stays instant; the moment it is gone the
//     watchdog hands the accelerator to Explorer, which cannot crash.
//
// WHY NOT THE OTHER MECHANISMS, since Windows offers no service and no admin
// rights (weighed as issue #61 asks):
//
//  - A PER-USER SCHEDULED TASK with a repeating trigger would also survive the
//    watchdog itself dying, but its finest repetition is one minute, so a death
//    can go unanswered for a minute; it leaves state in the Task Scheduler that
//    an uninstall must remember to remove; and its "start only if not already
//    running" condition has to re-implement the single-instance question the
//    app already answers. It is the fallback of last resort, not the first
//    choice, and it is not shipped.
//  - ELECTRON'S OWN RECOVERY HOOKS (render-process-gone, child-process-gone)
//    cover a large share of real crashes with no external process at all — and
//    the app already uses them: log.ts records them and capture.ts rebuilds the
//    recorder that vanished. But they run INSIDE the main process, so the one
//    failure issue #61 is actually about — the main process itself being gone —
//    is exactly the one they cannot see. They are necessary and insufficient.
//
// EVERYTHING HERE IS REMOVABLE. Turning the Settings toggle off stops the
// watchdog and deletes the shortcut in the same call; the NSIS uninstaller
// deletes the shortcut and the installer writes a stand-down flag so that
// supervision can never fight setup.
import { app } from 'electron'
import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { CAPTURE_ARG, armShortcutArgs, lnkHotkeyFromAccelerator } from '../shared/startMenuLink'
import type { StartMenuLinkSpec } from '../shared/startMenuLink'
import { asJournal, emptyJournal, GAVE_UP_ARG, NON_RELAUNCHABLE_ARGS, RELAUNCHED_ARG } from '../shared/supervision'
import type { SupervisionJournal, SupervisionPlan } from '../shared/supervision'
import { logError, logInfo, logWarn, logsDir } from './log'

/**
 * At most three automatic relaunches inside ten minutes.
 *
 * Three is enough to ride out a transient death (a driver reset taking the GPU
 * process with it, an OOM under a one-off memory spike) and few enough that a
 * genuine crash loop is stopped inside a minute or two instead of spinning all
 * day. Issue #61 is explicit that a relaunch loop is worse than staying dead.
 */
const MAX_RELAUNCHES = 3
const RELAUNCH_WINDOW_MS = 10 * 60 * 1_000
/** A watchdog that was killed leaves the app unsupervised; this notices within half a minute. */
const WATCHDOG_CHECK_MS = 30_000
/**
 * Explorer releases a shortcut key a moment after the .lnk disappears, not
 * instantly. Six seconds is comfortably more than the delay measured while
 * building this (under four) and short enough that a REAL conflict with another
 * application is still reported while the user is looking at the launch.
 */
const SHORTCUT_RELEASE_BUDGET_MS = 6_000

/** The Start Menu entry the fallback lives on. Named for what pressing the key does. */
const SHORTCUT_FILE_NAME = 'CapturePack Capture.lnk'

let watchdogPid: number | null = null
let watchdogCheck: ReturnType<typeof setInterval> | undefined
let planForRun: SupervisionPlan | null = null

// ---------------------------------------------------------------------------
// Paths

function userFile(name: string): string {
  return path.join(app.getPath('userData'), name)
}

/** The plan handed to the watchdog on argv. */
function planFile(): string {
  return userFile('supervision.json')
}

/** What automatic recovery has done lately (read at startup to announce it). */
function journalFile(): string {
  return userFile('supervision-journal.json')
}

/**
 * Written by the NSIS installer and uninstaller (build/installer.nsh) before
 * they close the running app. Supervision resurrecting CapturePack in the
 * middle of an update or an uninstall would be a far worse bug than the one it
 * exists to fix.
 */
function standDownFile(): string {
  return userFile('supervision-standdown')
}

/** %APPDATA%\Microsoft\Windows\Start Menu\Programs\CapturePack Capture.lnk */
export function fallbackShortcutPath(): string {
  return path.join(
    app.getPath('appData'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    SHORTCUT_FILE_NAME,
  )
}

// ---------------------------------------------------------------------------
// What recovery already did, read once at startup

/** The recovery state this run was started in. */
export interface RecoveryState {
  /** The watchdog brought this run back after the previous one died. */
  relaunched: boolean
  /** The rate limit was hit: this run exists only to say so, and is not supervised. */
  gaveUp: boolean
  /** When the run that died was last alive — the time the announcement names. */
  diedAt: string | null
  /** How many automatic relaunches happened inside the rate-limit window. */
  attempts: number
}

let recovery: RecoveryState | null = null

/**
 * Reads the recovery journal. Call once at startup, before the journal is reset:
 * a run that was NOT brought back by the watchdog clears the history, so
 * yesterday's single crash can never be counted towards today's loop.
 */
export function readRecoveryState(): RecoveryState {
  if (recovery !== null) return recovery
  const journal = asJournal(readJson(journalFile()) ?? emptyJournal())
  const relaunched = process.argv.includes(RELAUNCHED_ARG)
  const gaveUp = process.argv.includes(GAVE_UP_ARG)
  recovery = {
    relaunched,
    gaveUp,
    diedAt: journal.diedAt,
    attempts: journal.relaunches.length,
  }
  if (!relaunched && !gaveUp && (journal.relaunches.length > 0 || journal.gaveUp)) {
    // A start the watchdog did not cause is a clean slate: the user (or the
    // login item) started CapturePack deliberately, and the previous burst of
    // relaunches is history, not an in-progress loop.
    writeJournal(emptyJournal())
  }
  return recovery
}

// ---------------------------------------------------------------------------
// Start / stop

export interface SupervisionOptions {
  /** The Settings toggle (GOAL "And do not stay gone."), on by default. */
  enabled: boolean
  /** The configured capture accelerator, mirrored onto the fallback shortcut. */
  accelerator: string
  /** The run marker lifecycle.ts opened, so the watchdog reads the same verdict. */
  runStateFile: string
  /** This run's `startedAt`, proving a marker the watchdog reads is about this run. */
  runStartedAt: string
  /** Tooltip text for the Start Menu entry, in the user's language. */
  shortcutDescription: string
}

/** What starting supervision means for the accelerator the caller is about to register. */
export interface AcceleratorPlan {
  /**
   * Whether the app should take the global accelerator at all. False only in
   * the gave-up mode, where the key is deliberately left with Explorer.
   */
  registerAccelerator: boolean
  /**
   * How long a refused registration may still be Explorer letting go of the
   * fallback shortcut rather than a real conflict with another application.
   */
  releaseBudgetMs: number
}

/**
 * Takes the accelerator back from Explorer, starts the watchdog, and keeps it
 * alive. Call once, after the tray exists — everything here is best effort and
 * nothing in it may prevent the app from running.
 */
export function startSupervision(options: SupervisionOptions): AcceleratorPlan {
  if (process.platform !== 'win32') return { registerAccelerator: true, releaseBudgetMs: 0 }
  const recoveryState = readRecoveryState()
  if (recoveryState.gaveUp) {
    // The DEGRADED mode issue #61 asks for: automatic restart has stopped, so
    // the accelerator is deliberately left with Explorer — the only holder that
    // cannot crash. Slower than owning it (a process launch, not a keypress),
    // and the promise is still kept. Registering here would ALSO fail, and
    // would report our own fallback to the user as another app's conflict.
    logWarn(
      '[supervisor] automatic restart gave up after ' +
        `${recoveryState.attempts} relaunches — leaving the accelerator with the Start Menu shortcut`,
    )
    return { registerAccelerator: false, releaseBudgetMs: 0 }
  }
  if (!options.enabled) {
    // Off means OFF: nothing of ours may be left running or left in the Start
    // Menu (issue #61 — whatever is added must be removable). A shortcut that
    // WAS there still has to be waited out, or the first registration after
    // turning supervision off would look like a conflict.
    const removed = disableSupervision()
    return {
      registerAccelerator: true,
      releaseBudgetMs: removed ? SHORTCUT_RELEASE_BUDGET_MS : 0,
    }
  }
  // A stand-down flag left behind by an installer that never finished would
  // silently disable supervision forever; the app starting IS the proof that
  // setup is over.
  fs.rmSync(standDownFile(), { force: true })

  // Take the accelerator back before registering it. Deleting the .lnk is what
  // makes Explorer release the shortcut key (measured — see
  // shared/startMenuLink.ts); the release is asynchronous, hence the retry
  // budget returned to the caller.
  const hadShortcut = disarmShortcut()

  planForRun = {
    appPid: process.pid,
    runStartedAt: options.runStartedAt,
    runStateFile: options.runStateFile,
    standDownFile: standDownFile(),
    journalFile: journalFile(),
    logFile: path.join(logsDir(), 'watchdog.log'),
    relaunch: { exe: process.execPath, args: relaunchArgs() },
    shortcut: shortcutSpec(options.accelerator, options.shortcutDescription),
    maxRelaunches: MAX_RELAUNCHES,
    windowMs: RELAUNCH_WINDOW_MS,
  }
  if (planForRun.shortcut === null) {
    logWarn(
      `[supervisor] ${options.accelerator} cannot be expressed as a Windows shortcut key — ` +
        'the app will hold it, but there is no Start Menu fallback for this combination',
    )
  }
  spawnWatchdog()
  // Re-spawned rather than assumed: a watchdog killed by a cleanup tool or an
  // over-eager AV would otherwise leave the app unsupervised for the rest of
  // the session, and nothing would say so.
  watchdogCheck = setInterval(() => {
    if (watchdogPid !== null && processAlive(watchdogPid)) return
    logWarn('[supervisor] the watchdog is gone — starting a new one')
    spawnWatchdog()
  }, WATCHDOG_CHECK_MS)

  return {
    registerAccelerator: true,
    releaseBudgetMs: hadShortcut ? SHORTCUT_RELEASE_BUDGET_MS : 0,
  }
}

/**
 * Stops keeping the watchdog alive, for a shutdown that is happening anyway.
 *
 * The watchdog is deliberately NOT killed: it is what arms the Start Menu
 * fallback once this process is gone, and lifecycle.ts's closed marker is what
 * tells it this exit was intended. Killing it here would trade a two-second
 * handover for a permanent hole in the promise.
 */
export function stopSupervision(): void {
  if (watchdogCheck !== undefined) clearInterval(watchdogCheck)
  watchdogCheck = undefined
}

/**
 * Removes supervision entirely: the toggle went off, so the watchdog is killed
 * and the Start Menu entry deleted. Also what the app runs at startup when the
 * toggle is already off, so a profile that had supervision on yesterday cannot
 * leave anything behind today.
 *
 * Returns whether a Start Menu fallback was actually removed — Explorer needs a
 * moment afterwards, and the caller has to wait it out before calling a refused
 * registration a conflict.
 */
export function disableSupervision(): boolean {
  stopSupervision()
  if (watchdogPid !== null) {
    try {
      process.kill(watchdogPid)
      logInfo(`[supervisor] stopped the watchdog (pid ${watchdogPid})`)
    } catch (err) {
      // Already gone is the outcome we wanted; anything else is not fatal.
      logInfo(`[supervisor] the watchdog was already gone (pid ${watchdogPid}): ${describe(err)}`)
    }
    watchdogPid = null
  }
  planForRun = null
  fs.rmSync(planFile(), { force: true })
  return disarmShortcut()
}

/**
 * Applies a changed accelerator (Settings GUI, instant apply) or a changed
 * toggle to a RUNNING supervision: the watchdog holds the shortcut spec it was
 * given, so a hotkey the user re-recorded has to reach it or the fallback would
 * still launch on the old combination.
 */
export function updateSupervision(options: SupervisionOptions): void {
  if (process.platform !== 'win32') return
  if (!options.enabled) {
    disableSupervision()
    return
  }
  if (planForRun === null) {
    startSupervision(options)
    return
  }
  planForRun = {
    ...planForRun,
    shortcut: shortcutSpec(options.accelerator, options.shortcutDescription),
  }
  writePlan(planForRun)
  // The running watchdog read the OLD plan at startup. Restarting it is how the
  // new accelerator reaches the fallback; it is a one-shot process with no state
  // of its own, so this costs nothing.
  restartWatchdog()
}

// ---------------------------------------------------------------------------
// The watchdog process

function spawnWatchdog(): void {
  if (planForRun === null) return
  const script = resolveWatchdogScript()
  if (script === null) {
    logError('[supervisor] watchdog.js is missing from this build — supervision is NOT running')
    return
  }
  writePlan(planForRun)
  try {
    const child = spawn(process.execPath, [script, planFile()], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      // The app's own binary re-entered as plain Node: no second runtime ships,
      // and the watchdog costs a Node process rather than an Electron one.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    child.unref()
    watchdogPid = child.pid ?? null
    logInfo(
      `[supervisor] watchdog started (pid ${watchdogPid ?? -1}) watching pid ${process.pid}; ` +
        `at most ${MAX_RELAUNCHES} relaunches per ${Math.round(RELAUNCH_WINDOW_MS / 60_000)} minutes`,
    )
  } catch (err) {
    // Supervision is a safety net, never a precondition for running.
    logError('[supervisor] could not start the watchdog', err)
    watchdogPid = null
  }
}

function restartWatchdog(): void {
  if (watchdogPid !== null) {
    try {
      process.kill(watchdogPid)
    } catch {
      // Already gone: spawnWatchdog below is the whole remedy either way.
      watchdogPid = null
    }
  }
  spawnWatchdog()
}

/**
 * dist/scripts/watchdog.js — emitted by scripts/build.mjs and kept OUT of the
 * asar (asarUnpack in electron-builder.yml): it is executed by a fresh Node
 * process, which knows nothing about Electron's archive format.
 */
function resolveWatchdogScript(): string | null {
  const packed = path.join(app.getAppPath(), 'dist', 'scripts', 'watchdog.js')
  const unpacked = packed.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
  return [unpacked, packed].find((candidate) => fs.existsSync(candidate)) ?? null
}

/**
 * The command line a relaunch reuses: this run's own arguments, minus the
 * one-shot ones, plus --openAsHidden so recovery never steals focus.
 *
 * Reusing our OWN argv is a safety property, not a convenience: a dev run
 * carrying --user-data-dir and --output-dir can only ever resurrect that same
 * dev run, never the installed CapturePack.
 */
function relaunchArgs(): string[] {
  const args = process.argv.slice(1).filter((arg) => !NON_RELAUNCHABLE_ARGS.includes(arg))
  if (!args.includes('--openAsHidden')) args.push('--openAsHidden')
  return args
}

// ---------------------------------------------------------------------------
// The Start Menu fallback

function shortcutSpec(accelerator: string, description: string): StartMenuLinkSpec | null {
  const hotkey = lnkHotkeyFromAccelerator(accelerator)
  if (hotkey === null) return null
  const args = relaunchArgs().filter((arg) => arg !== '--openAsHidden')
  return {
    linkPath: fallbackShortcutPath(),
    target: process.execPath,
    // CAPTURE_ARG is what tells the launched process it is a HOTKEY PRESS: a
    // running instance captures on it, and a cold start says the app was not
    // running instead of silently starting.
    arguments: [...args, CAPTURE_ARG].map(quoteArg).join(' '),
    hotkey,
    description,
    workingDirectory: path.dirname(process.execPath),
  }
}

/**
 * A .lnk stores its arguments as ONE command-line string, so an argument
 * carrying a space (a dev run's --user-data-dir under "Program Files", a
 * profile path with the user's full name in it) has to be quoted or Explorer
 * would hand the app two broken arguments instead of one.
 */
function quoteArg(arg: string): string {
  return arg.includes(' ') ? `"${arg}"` : arg
}

/**
 * Takes the accelerator back from Explorer by deleting the .lnk — the one
 * cheap operation Windows was measured to honor (a byte patch is ignored).
 * Returns whether a shortcut was actually there, so the caller knows to wait
 * for Explorer to let go before calling a failed registration a conflict.
 */
function disarmShortcut(): boolean {
  const file = fallbackShortcutPath()
  if (!fs.existsSync(file)) return false
  try {
    fs.rmSync(file, { force: true })
    logInfo('[supervisor] removed the Start Menu fallback shortcut — this run holds the accelerator')
    return true
  } catch (err) {
    logWarn(`[supervisor] could not remove the Start Menu fallback shortcut: ${describe(err)}`)
    return false
  }
}

/**
 * How long the synchronous Start Menu arm may take before it is abandoned. It
 * is one WScript.Shell call; a second is generous, and blocking startup on a
 * wedged PowerShell would be worse than having no fallback.
 */
const ARM_SHORTCUT_TIMEOUT_MS = 5_000

/**
 * Hands the accelerator to Explorer NOW rather than waiting for the watchdog.
 *
 * Used when the app is about to stop supervising itself while continuing to run
 * (the gave-up mode) — the watchdog is the normal path, because it is the one
 * that is still there when the app is not.
 */
export function armShortcutNow(accelerator: string, description: string): void {
  if (process.platform !== 'win32') return
  const spec = shortcutSpec(accelerator, description)
  if (spec === null) return
  try {
    // SYNCHRONOUS, and deliberately not detached. Measured: under
    // `detached: true`, WScript.Shell's Save() silently writes nothing —
    // PowerShell still exits 0 with an empty stderr, so the old code logged
    // success and left no shortcut at all. This is the gave-up path, where the
    // app has just refused the accelerator on purpose; handing it nowhere and
    // announcing that it was handed over recreates issue #61 INSIDE the safety
    // net built for it. Waiting for a short PowerShell call here is cheap, and
    // it is the only way the log can state what actually happened.
    const done = spawnSync('powershell.exe', armShortcutArgs(spec), {
      windowsHide: true,
      timeout: ARM_SHORTCUT_TIMEOUT_MS,
    })
    if (done.status === 0 && fs.existsSync(spec.linkPath)) {
      logInfo(`[supervisor] armed the Start Menu fallback on ${spec.hotkey}`)
      return
    }
    logWarn(
      `[supervisor] could not arm the Start Menu fallback on ${spec.hotkey} — ` +
        `powershell exit ${String(done.status)}, shortcut present: ${String(fs.existsSync(spec.linkPath))}`,
    )
  } catch (err) {
    logWarn(`[supervisor] could not arm the Start Menu fallback: ${describe(err)}`)
  }
}

// ---------------------------------------------------------------------------
// Files

function writePlan(plan: SupervisionPlan): void {
  try {
    fs.mkdirSync(path.dirname(planFile()), { recursive: true })
    fs.writeFileSync(planFile(), JSON.stringify(plan, null, 2) + '\n')
  } catch (err) {
    logError('[supervisor] could not write the supervision plan', err)
  }
}

function writeJournal(journal: SupervisionJournal): void {
  try {
    fs.mkdirSync(path.dirname(journalFile()), { recursive: true })
    fs.writeFileSync(journalFile(), JSON.stringify(journal, null, 2) + '\n')
  } catch (err) {
    logError('[supervisor] could not write the supervision journal', err)
  }
}

function readJson(file: string): unknown {
  try {
    const text = fs.readFileSync(file, 'utf8')
    // Editors save UTF-8 with a BOM, which JSON.parse rejects.
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    // Missing or garbled: "nothing has happened lately" is the honest reading,
    // and it is also the safe one — it never invents a crash.
    return null
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
