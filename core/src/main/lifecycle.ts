// Did the last run END, or did it just STOP? (issue #61)
//
// A user pressed Ctrl+Alt+C, got nothing, and concluded CapturePack was not
// installed. It was installed — it simply was not running any more, and a tray
// app that is gone announces nothing, because there is nothing left to
// announce. The app cannot fix that from inside its own corpse, but it CAN make
// the silence explain itself on the next start, which is the sentence the user
// actually needed: "CapturePack stopped unexpectedly at 15:19 and was not
// recording until now."
//
// So every run leaves a marker in the user data directory:
//  - written at startup with exit = null,
//  - refreshed by a slow heartbeat so a hard death has a TIME, not just a fact,
//  - closed on will-quit with WHY the app exited.
//
// A marker still open on the next start therefore means exactly one thing: the
// previous run did not exit through our own quit path — it died. That is the
// distinction issue #61 asks for ("distinguish a user-initiated Quit from every
// other exit, and record which happened").
//
// Two things the marker also has to carry, because without them a run that was
// NOT healthy reads exactly like one that was:
//
//  - UNHANDLED ERRORS. The app deliberately survives an uncaught exception
//    (log.ts explains why), so it still reaches will-quit and still writes a
//    real exit kind. A count of the faults rides along, and a run that has one
//    is never reported as having closed normally.
//  - WHO LEFT THE MARKER OPEN. An open marker from a DIFFERENT version is an
//    updater closing the old build, so it must not be called a crash — but it
//    must not be called a clean exit either. Nobody knows how that run ended;
//    'replaced' says exactly that, and every surface renders it that way.
import { app } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { logError, logInfo, logWarn } from './log'

// How often the marker's "still alive" timestamp is refreshed. One tiny JSON
// write a minute is the resolution of the answer to "when did it die?" — a
// minute is precise enough to line up with what the user remembers, and cheap
// enough to run all day.
const HEARTBEAT_MS = 60_000

/**
 * WHY a run ended. Everything except `user-quit` is something the user did not
 * ask for, and `null` (an unclosed marker) is the app dying outright.
 */
export type ExitKind =
  // The user chose Quit in the tray menu — the only exit that is meant to
  // leave the machine without a replay buffer.
  | 'user-quit'
  // "Restart and update": the app comes straight back.
  | 'update-restart'
  // Startup itself failed and the app quit to report it.
  | 'startup-failure'
  // will-quit fired without any of the above — a clean exit whose cause we did
  // not record (a Windows logoff or shutdown lands here, since Electron tears
  // the app down through the normal quit sequence). Honest name: we know it did
  // not vanish, not why it left.
  | 'unknown'

export interface RunRecord {
  version: string
  startedAt: string
  // Last heartbeat — for a run that died, the best estimate of WHEN.
  lastAliveAt: string
  // null while the run is live, and still null in the file when it never got
  // to write its exit: that is what "it died" looks like on disk.
  exit: ExitKind | null
  // Uncaught exceptions + unhandled rejections seen during the run. The app
  // survives them on purpose (log.ts), so this is the ONLY thing that stops the
  // next start from certifying a broken run as healthy.
  faults: number
  // When the first one happened — the moment after which nothing this run did
  // can be assumed to have worked. null when there were none.
  firstFaultAt: string | null
  // One line about the first fault, so the marker is readable on its own; the
  // full stack is in main.log.
  firstFaultSummary: string | null
}

/**
 * How the previous run ended — the single verdict every surface renders, so the
 * startup balloon, the log line and the About window can never disagree.
 */
export type PreviousRunStatus =
  // Exited through our own quit path with nothing unhandled on the way.
  | 'clean'
  // Exited through our own quit path, but hit unhandled errors while running.
  // NOT a crash, and NOT "closed normally" either.
  | 'faulted'
  // The marker was still open and this run is the SAME version: the app
  // vanished (crash, kill, power loss). The only status that is announced.
  | 'vanished'
  // The marker was left open by a DIFFERENT version. An updater closing the old
  // build explains it, so this is never reported as a crash — but nobody knows
  // how that run actually ended, and saying "closed normally" would invent an
  // answer. A genuine crash of the old build minutes before an update lands
  // here too, which is precisely why the honest word is "unknown".
  | 'replaced'

/** What the previous run did, for the About window and the startup announcement. */
export interface PreviousRun {
  record: RunRecord
  status: PreviousRunStatus
}

let markerPath: string | null = null
let current: RunRecord | null = null
let heartbeat: ReturnType<typeof setInterval> | undefined
let intendedExit: ExitKind | null = null
let previous: PreviousRun | null = null
// Faults counted before beginRun() opened the marker (initForensics runs first,
// on purpose — a startup that throws must already have somewhere to say so).
// beginRun folds them into the record it creates, so the earliest errors of all
// are not the ones that go missing.
let pendingFaults = 0
let pendingFirstFault: { at: string; summary: string } | null = null

function runStateFile(): string {
  markerPath ??= path.join(app.getPath('userData'), 'run-state.json')
  return markerPath
}

/**
 * Reads the previous run's marker and opens this run's. Call once at startup,
 * before anything that can fail — the whole point is to have written "I am
 * running" before there is any chance of dying.
 */
export function beginRun(): PreviousRun | null {
  previous = readPreviousRun()
  const now = new Date().toISOString()
  current = {
    version: app.getVersion(),
    startedAt: now,
    lastAliveAt: now,
    exit: null,
    faults: pendingFaults,
    firstFaultAt: pendingFirstFault?.at ?? null,
    firstFaultSummary: pendingFirstFault?.summary ?? null,
  }
  writeMarker()
  heartbeat = setInterval(() => {
    if (current === null) return
    current.lastAliveAt = new Date().toISOString()
    writeMarker()
  }, HEARTBEAT_MS)
  if (previous === null) {
    logInfo('[lifecycle] no previous run recorded on this machine')
  } else {
    switch (previous.status) {
      case 'clean':
        logInfo(
          `[lifecycle] previous run (v${previous.record.version}) exited cleanly ` +
            `at ${previous.record.lastAliveAt} (${previous.record.exit ?? 'unknown'})`,
        )
        break
      case 'faulted':
        // It exited through our own quit path, so it did not vanish — but it
        // ran on after errors nobody handled, and everything it did after the
        // first one is suspect. Calling that "exited cleanly" was the lie.
        logWarn(
          `[lifecycle] previous run (v${previous.record.version}) exited at ` +
            `${previous.record.lastAliveAt} (${previous.record.exit ?? 'unknown'}) after ` +
            `${previous.record.faults} unhandled error(s) — first at ` +
            `${previous.record.firstFaultAt ?? 'unknown'}: ` +
            `${previous.record.firstFaultSummary ?? 'no detail recorded'}`,
        )
        break
      case 'replaced':
        logWarn(
          `[lifecycle] previous run (v${previous.record.version}) left its marker open, but this ` +
            `run is v${app.getVersion()} — an update replaced it; how it ended is unknown, and ` +
            'it is not reported as a crash',
        )
        break
      case 'vanished':
        // THE line issue #61 is about: between these two timestamps the replay
        // buffer did not exist, and nothing else in the product can say so.
        logError(
          `[lifecycle] previous run (v${previous.record.version}) DID NOT exit cleanly — ` +
            `last alive ${previous.record.lastAliveAt}; the replay buffer was not recording ` +
            'between then and now',
        )
        break
    }
  }
  return previous
}

/**
 * Records an error nobody handled (log.ts owns the process hooks and decides
 * that the run continues). Counted even before the marker is open, so the
 * earliest failures — the ones a startup crash is made of — still reach disk.
 *
 * The marker is rewritten only for the FIRST fault: that is the one a hard
 * death immediately afterwards has to carry, and a faulting loop must not turn
 * into a synchronous write per exception. Later faults ride the minute
 * heartbeat and endRun(), both of which serialize the live count.
 */
export function noteUnhandledError(summary: string): void {
  const at = new Date().toISOString()
  if (current === null) {
    pendingFaults += 1
    pendingFirstFault ??= { at, summary }
    return
  }
  current.faults += 1
  if (current.firstFaultAt === null) {
    current.firstFaultAt = at
    current.firstFaultSummary = summary
    writeMarker()
  }
}

/** The previous run's outcome, for surfaces that render it (About window). */
export function previousRun(): PreviousRun | null {
  return previous
}

/**
 * The previous run VANISHED — it died rather than exited, and no update
 * explains it. The ONE status that is announced at startup: a faulted or
 * update-replaced run is reported in About and in the log, but a balloon
 * claiming "CapturePack stopped unexpectedly" would be wrong for both.
 */
export function previousRunVanished(): boolean {
  return previous?.status === 'vanished'
}

/**
 * Records WHY this run is about to end. First caller wins: the user pressing
 * Quit is the reason, even though the shutdown path that follows would happily
 * label itself something vaguer.
 */
export function noteExitIntent(kind: ExitKind): void {
  if (intendedExit !== null) return
  intendedExit = kind
  logInfo(`[lifecycle] exiting: ${kind}`)
}

/**
 * Closes this run's marker. Called from will-quit — i.e. from every exit that
 * goes through Electron's own shutdown. An exit that does NOT reach here leaves
 * the marker open, which is precisely how the next start knows the app died.
 */
export function endRun(): void {
  if (heartbeat !== undefined) clearInterval(heartbeat)
  heartbeat = undefined
  if (current === null) return
  current.lastAliveAt = new Date().toISOString()
  current.exit = intendedExit ?? 'unknown'
  writeMarker()
  if (current.faults > 0) {
    // Said in THIS run's own log as well as in the marker the next one reads:
    // an exit kind on its own would let a damaged run read as a healthy one.
    logWarn(
      `[lifecycle] this run exited as '${current.exit}' after ${current.faults} ` +
        'unhandled error(s); it is not recorded as a clean run',
    )
  }
}

function writeMarker(): void {
  if (current === null) return
  try {
    fs.mkdirSync(path.dirname(runStateFile()), { recursive: true })
    fs.writeFileSync(runStateFile(), JSON.stringify(current, null, 2) + '\n')
  } catch (err) {
    // A marker that cannot be written costs the next start its diagnosis, and
    // nothing else. Never fatal.
    logError('[lifecycle] could not write the run marker', err)
  }
}

function readPreviousRun(): PreviousRun | null {
  let text: string
  try {
    text = fs.readFileSync(runStateFile(), 'utf8')
  } catch {
    // No marker: a fresh install, a wiped profile, or a version that predates
    // this file. Not an unclean exit — claiming a crash we cannot evidence
    // would be the same kind of lie as the tray icon in #43.
    return null
  }
  try {
    const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ''))
    const record = asRunRecord(parsed)
    if (record === null) return null
    return { record, status: statusOf(record) }
  } catch (err) {
    logError('[lifecycle] could not read the previous run marker', err)
    return null
  }
}

/**
 * THE rule, in one place (issue #61). Ordered by how much the user needs to
 * know: a run that vanished outranks everything, and "it exited" is only ever
 * called CLEAN when nothing went unhandled along the way.
 */
function statusOf(record: RunRecord): PreviousRunStatus {
  if (record.exit === null) {
    // A version that is not this one means the build that wrote the marker is
    // not the build reading it: the installer closed it (issue #61 must not
    // turn a successful update into a crash report — but it must not turn it
    // into a clean shutdown either, since nobody observed one).
    return record.version !== '' && record.version !== app.getVersion() ? 'replaced' : 'vanished'
  }
  return record.faults > 0 ? 'faulted' : 'clean'
}

// Hand-written validation rather than a cast: the file is on disk in a folder
// the user can edit, and a garbled marker must degrade to "no previous run",
// never to a crash on the startup path.
function asRunRecord(value: unknown): RunRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const version = typeof raw['version'] === 'string' ? raw['version'] : ''
  const startedAt = typeof raw['startedAt'] === 'string' ? raw['startedAt'] : ''
  const lastAliveAt = typeof raw['lastAliveAt'] === 'string' ? raw['lastAliveAt'] : startedAt
  if (startedAt === '') return null
  const exit = isExitKind(raw['exit']) ? raw['exit'] : null
  // Absent in markers written before faults were recorded: 0 is the honest
  // reading (that build could not have counted any), not a guess.
  const rawFaults = raw['faults']
  const faults =
    typeof rawFaults === 'number' && Number.isFinite(rawFaults) && rawFaults > 0
      ? Math.floor(rawFaults)
      : 0
  const firstFaultAt = typeof raw['firstFaultAt'] === 'string' ? raw['firstFaultAt'] : null
  const firstFaultSummary =
    typeof raw['firstFaultSummary'] === 'string' ? raw['firstFaultSummary'] : null
  return { version, startedAt, lastAliveAt, exit, faults, firstFaultAt, firstFaultSummary }
}

function isExitKind(value: unknown): value is ExitKind {
  return (
    value === 'user-quit' ||
    value === 'update-restart' ||
    value === 'startup-failure' ||
    value === 'unknown'
  )
}
