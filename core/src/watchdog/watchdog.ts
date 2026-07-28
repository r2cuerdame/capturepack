// The watchdog (issue #61, half 1: "do not let it be gone").
//
// v0.1.6 taught CapturePack to REPORT that it had died. That still left the
// headline symptom untouched: the user pressed Ctrl+Alt+C, got nothing, and
// concluded the app was not installed. It was installed — it had died at 15:19
// and nothing brought it back until the next login.
//
// This process is what brings it back. It is a plain Node process (the same
// binary re-entered with ELECTRON_RUN_AS_NODE, so nothing extra ships), started
// detached by the app and outliving it on purpose: the only component that can
// notice a death is one that is not part of what died.
//
// It does exactly four things, and nothing else:
//   1. watches ONE pid — the run that spawned it;
//   2. when that pid is gone, ARMS the Start Menu fallback shortcut, so the
//      hotkey has an answer within seconds no matter what happens next;
//   3. asks lifecycle.ts's marker whether the exit was INTENDED (Quit, updater
//      restart, Windows shutdown all reach will-quit and close the marker) and
//      stands down if it was;
//   4. otherwise relaunches the app once, promptly — unless it has already done
//      that too often, in which case it stops and says so, because a relaunch
//      loop is worse than staying dead.
//
// Then it exits. Supervision continues because the relaunched app spawns a
// fresh watchdog of its own; a one-shot process cannot itself become the thing
// that will not die.
import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { armShortcutArgs } from '../shared/startMenuLink'
import { asJournal, emptyJournal, GAVE_UP_ARG, RELAUNCHED_ARG } from '../shared/supervision'
import type { SupervisionJournal, SupervisionPlan } from '../shared/supervision'

// One second is fast enough that a user who pressed the hotkey into silence is
// still looking at the screen when the app comes back, and cheap enough that a
// process doing nothing else all day costs nothing.
const POLL_MS = 1_000
// The dying app writes its exit reason on the way out. Reading the marker the
// instant the pid disappears would race that write and report a clean Quit as a
// crash — which is exactly the kind of lie this release is about.
const GRACE_MS = 1_500
// A powershell.exe that never returns must not hold the relaunch hostage; ten
// seconds is far beyond the ~0.7s a cold start of it actually costs.
const ARM_TIMEOUT_MS = 10_000
const MAX_LOG_BYTES = 262_144

// Loaded through a function that EXITS rather than returning null, so every
// helper below sees a plain SupervisionPlan: a watchdog is the last place to
// carry a maybe-null that has to be re-checked on every use.
const plan = loadPlanOrExit()

log(`watching pid ${plan.appPid} (run ${plan.runStartedAt})`)

const timer = setInterval(() => {
  if (standDownRequested()) {
    // The installer/uninstaller is running. Nothing here may fight it.
    log('standing down: the installer asked supervision to stop')
    stop(0)
    return
  }
  if (processAlive(plan.appPid)) return
  clearInterval(timer)
  setTimeout(onAppGone, GRACE_MS)
}, POLL_MS)

function onAppGone(): void {
  if (standDownRequested()) {
    log('app gone while the installer is running — standing down')
    disarmShortcut()
    stop(0)
    return
  }
  // FIRST, before any decision: give the keystroke an answer again. Whether the
  // app quit, crashed, or is about to be relaunched, from this moment Explorer
  // owns the accelerator and pressing it starts CapturePack instead of hitting
  // nothing (issue #61, half 2).
  armShortcut()

  const marker = readRunState()
  if (marker === null) {
    log('no run marker: nothing provable to act on, standing down')
    stop(0)
    return
  }
  if (marker.startedAt !== plan.runStartedAt) {
    // Someone else's marker. Relaunching on it could resurrect an app the user
    // deliberately stopped — never act on evidence that is not about our run.
    log(`marker belongs to run ${marker.startedAt}, not ${plan.runStartedAt} — standing down`)
    // A newer run wrote that marker, so CapturePack is BACK — and it disarmed
    // the shortcut on its way up, before this arm put one there again.
    disarmShortcut()
    stop(0)
    return
  }
  if (marker.exit !== null) {
    // will-quit ran: Quit, an updater restart, a startup failure that reported
    // itself, or a Windows shutdown. All intended; none of them is ours to undo.
    log(`exit was intentional (${marker.exit}) — standing down`)
    stop(0)
    return
  }

  const journal = pruneJournal(readJournal())
  if (journal.relaunches.length >= plan.maxRelaunches) {
    // A relaunch loop is worse than staying dead. Stop — but never quietly:
    // one final launch carries GAVE_UP_ARG so the app itself says, in the
    // user's language, that automatic restart has stopped and why.
    journal.gaveUp = true
    journal.diedAt = marker.lastAliveAt
    writeJournal(journal)
    log(
      `RATE LIMIT: ${journal.relaunches.length} relaunches within ${Math.round(plan.windowMs / 60_000)} ` +
        'minutes — stopping, and launching once more only to say so',
    )
    launchApp([GAVE_UP_ARG])
    stop(0)
    return
  }

  journal.relaunches.push(new Date().toISOString())
  journal.diedAt = marker.lastAliveAt
  journal.gaveUp = false
  writeJournal(journal)
  log(
    `app DIED (last alive ${marker.lastAliveAt}) — relaunching ` +
      `(attempt ${journal.relaunches.length} of ${plan.maxRelaunches})`,
  )
  launchApp([RELAUNCHED_ARG])
  stop(0)
}

/**
 * Brings the app back with the exact command line the supervised run used, plus
 * one marker argument. Reusing the stored line is what keeps a watchdog unable
 * to start anything except the instance that created it — a dev run with its
 * own --user-data-dir can only ever resurrect that same dev run.
 */
function launchApp(extra: string[]): void {
  const args = [...plan.relaunch.args, ...extra]
  try {
    const child = spawn(plan.relaunch.exe, args, {
      detached: true,
      stdio: 'ignore',
      // CRITICAL: this process is the app's own binary re-entered as Node. Left
      // in place, the variable would make the RELAUNCHED app run as Node too —
      // a process that starts, does nothing, and exits, which would look
      // exactly like the failure being fixed.
      env: withoutRunAsNode(process.env),
    })
    child.unref()
    log(`relaunched: ${plan.relaunch.exe} ${args.join(' ')} (pid ${child.pid ?? -1})`)
  } catch (err) {
    log(`relaunch FAILED: ${describe(err)}`)
  }
}

function withoutRunAsNode(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env }
  delete copy['ELECTRON_RUN_AS_NODE']
  return copy
}

/**
 * Hands the accelerator to Explorer by writing the shortcut key onto the Start
 * Menu .lnk. It has to go through the shell: measured on Windows 11, Explorer
 * registers a shortcut key when WScript.Shell saves the link and ignores both a
 * plain file copy and an in-place byte patch (see shared/startMenuLink.ts).
 *
 * SYNCHRONOUS, and before the relaunch, for two reasons found by testing:
 *  - a fire-and-forget child does not reliably outlive a watchdog that exits
 *    milliseconds later, so the shortcut was never written at all; and
 *  - the relaunched app DELETES this shortcut as it takes the accelerator back,
 *    so an arm that finished afterwards would leave the file behind and hand
 *    Explorer a key the running app also wants.
 *
 * Blocking costs the relaunch about half a second, which is the right price for
 * "the keystroke has an answer no matter what happens next".
 */
/**
 * Takes the fallback back off the Start Menu.
 *
 * The arm above happens BEFORE the watchdog knows why the app is gone, because
 * the keystroke must have an answer during the gap. Every stand-down path that
 * ends with CapturePack ALIVE has to undo it: the running app holds the
 * accelerator itself, and a .lnk still carrying that hotkey is exactly the
 * "supervision fights the app" state GOAL calls out — measured leaving the
 * shortcut armed 25s into a healthy new run.
 *
 * An exit that was intentional deliberately does NOT come through here: the app
 * is not running, so Explorer keeping the key is the promise being kept.
 */
function disarmShortcut(): void {
  const spec = plan.shortcut
  if (spec === null) return
  try {
    fs.rmSync(spec.linkPath, { force: true })
    log(`removed the Start Menu fallback: ${spec.linkPath}`)
  } catch (err) {
    log(`could not remove the Start Menu fallback: ${describe(err)}`)
  }
}

function armShortcut(): void {
  const spec = plan.shortcut
  if (spec === null) {
    log('no fallback shortcut in the plan (unsupported accelerator, or supervision off)')
    return
  }
  try {
    const result = spawnSync('powershell.exe', armShortcutArgs(spec), {
      stdio: 'ignore',
      windowsHide: true,
      timeout: ARM_TIMEOUT_MS,
      env: withoutRunAsNode(process.env),
    })
    if (result.error !== undefined) {
      log(`could not arm the Start Menu fallback: ${describe(result.error)}`)
      return
    }
    if (result.status !== 0) {
      log(`could not arm the Start Menu fallback: powershell exited ${String(result.status)}`)
      return
    }
    log(`armed the Start Menu fallback: ${spec.linkPath} -> ${spec.hotkey}`)
  } catch (err) {
    log(`could not arm the Start Menu fallback: ${describe(err)}`)
  }
}

// ---------------------------------------------------------------------------
// State on disk

interface RunMarker {
  startedAt: string
  lastAliveAt: string
  exit: string | null
}

/** lifecycle.ts's marker, re-read here rather than re-derived: one classification, two readers. */
function readRunState(): RunMarker | null {
  const parsed = readJson(plan.runStateFile)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const raw = parsed as Record<string, unknown>
  const startedAt = typeof raw['startedAt'] === 'string' ? raw['startedAt'] : ''
  if (startedAt === '') return null
  return {
    startedAt,
    lastAliveAt: typeof raw['lastAliveAt'] === 'string' ? raw['lastAliveAt'] : startedAt,
    exit: typeof raw['exit'] === 'string' ? raw['exit'] : null,
  }
}

function readJournal(): SupervisionJournal {
  return asJournal(readJson(plan.journalFile) ?? emptyJournal())
}

/** Only relaunches inside the rate-limit window count: yesterday's crash is not today's loop. */
function pruneJournal(journal: SupervisionJournal): SupervisionJournal {
  const cutoff = Date.now() - plan.windowMs
  return {
    ...journal,
    relaunches: journal.relaunches.filter((iso) => {
      const at = Date.parse(iso)
      return Number.isFinite(at) && at >= cutoff
    }),
  }
}

function writeJournal(journal: SupervisionJournal): void {
  try {
    fs.mkdirSync(path.dirname(plan.journalFile), { recursive: true })
    fs.writeFileSync(plan.journalFile, JSON.stringify(journal, null, 2) + '\n')
  } catch (err) {
    log(`could not write the journal: ${describe(err)}`)
  }
}

function standDownRequested(): boolean {
  return fs.existsSync(plan.standDownFile)
}

// Editors save UTF-8 with a BOM, which JSON.parse rejects.
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(stripBom(fs.readFileSync(file, 'utf8')))
  } catch {
    // Missing or garbled: the caller decides what "no answer" means. A watchdog
    // that throws is a watchdog that is not watching.
    return null
  }
}

/**
 * The plan file path arrives as argv[2]. Anything wrong with it means this
 * process was not started by the app and has no business relaunching anything:
 * exit 2 and leave the machine exactly as it was found.
 */
function loadPlanOrExit(): SupervisionPlan {
  const file = process.argv[2]
  if (file === undefined) process.exit(2)
  const parsed = readJson(file)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) process.exit(2)
  const raw = parsed as Record<string, unknown>
  // The plan is written by the app moments earlier and is never hand-edited, so
  // this only guards a truncated write — but the process that guards a crash
  // must not itself be crashable by one.
  if (typeof raw['appPid'] !== 'number' || typeof raw['runStartedAt'] !== 'string') process.exit(2)
  return parsed as SupervisionPlan
}

/**
 * Is the supervised run still there? `kill(pid, 0)` sends nothing; it only asks
 * Windows whether the process can be opened. EPERM means it exists and is not
 * ours to touch, which is still "alive".
 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function stop(code: number): void {
  clearInterval(timer)
  process.exit(code)
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The watchdog's own log, deliberately NOT main.log: two processes appending to
 * one file interleave, and the record of a death must be readable exactly when
 * the app that owns main.log is not there to write it.
 */
function log(message: string): void {
  const line = `${new Date().toISOString()} ${message}\n`
  try {
    fs.mkdirSync(path.dirname(plan.logFile), { recursive: true })
    if (fs.existsSync(plan.logFile) && fs.statSync(plan.logFile).size > MAX_LOG_BYTES) {
      fs.rmSync(plan.logFile, { force: true })
    }
    fs.appendFileSync(plan.logFile, line)
  } catch {
    // A log that cannot be written costs the next investigation its evidence
    // and nothing else. Never fatal — this process exists to survive.
  }
}
