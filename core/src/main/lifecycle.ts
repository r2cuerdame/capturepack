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
}

/** What the previous run did, for the About window and the startup announcement. */
export interface PreviousRun {
  record: RunRecord
  /** false = the marker was still open: the app vanished (crash, kill, power loss). */
  cleanExit: boolean
  /**
   * The marker was left open, but this run is a DIFFERENT version — an updater
   * that closed the old build to replace it explains that, and shouting "your
   * app crashed" after every successful update would be the same kind of lie
   * this whole feature exists to stop.
   */
  replacedByUpdate: boolean
}

let markerPath: string | null = null
let current: RunRecord | null = null
let heartbeat: ReturnType<typeof setInterval> | undefined
let intendedExit: ExitKind | null = null
let previous: PreviousRun | null = null

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
  current = { version: app.getVersion(), startedAt: now, lastAliveAt: now, exit: null }
  writeMarker()
  heartbeat = setInterval(() => {
    if (current === null) return
    current.lastAliveAt = new Date().toISOString()
    writeMarker()
  }, HEARTBEAT_MS)
  if (previous === null) {
    logInfo('[lifecycle] no previous run recorded on this machine')
  } else if (previous.cleanExit) {
    logInfo(
      `[lifecycle] previous run (v${previous.record.version}) exited cleanly ` +
        `at ${previous.record.lastAliveAt} (${previous.record.exit ?? 'unknown'})`,
    )
  } else if (previous.replacedByUpdate) {
    logWarn(
      `[lifecycle] previous run (v${previous.record.version}) left its marker open, but this ` +
        `run is v${app.getVersion()} — an update replaced it; not reported as a crash`,
    )
  } else {
    // THE line issue #61 is about: between these two timestamps the replay
    // buffer did not exist, and nothing else in the product can say so.
    logError(
      `[lifecycle] previous run (v${previous.record.version}) DID NOT exit cleanly — ` +
        `last alive ${previous.record.lastAliveAt}; the replay buffer was not recording ` +
        'between then and now',
    )
  }
  return previous
}

/** The previous run's outcome, for surfaces that render it (About window). */
export function previousRun(): PreviousRun | null {
  return previous
}

/**
 * The previous run VANISHED — it died rather than exited, and no update
 * explains it. The single rule behind both surfaces that report it (the startup
 * balloon and the About line), so the two can never disagree.
 */
export function previousRunVanished(): boolean {
  return previous !== null && !previous.cleanExit && !previous.replacedByUpdate
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
    return {
      record,
      cleanExit: record.exit !== null,
      // A version that is not this one means the build that wrote the marker is
      // not the build reading it: the installer closed it (issue #61 must not
      // turn a successful update into a crash report).
      replacedByUpdate: record.version !== '' && record.version !== app.getVersion(),
    }
  } catch (err) {
    logError('[lifecycle] could not read the previous run marker', err)
    return null
  }
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
  return { version, startedAt, lastAliveAt, exit }
}

function isExitKind(value: unknown): value is ExitKind {
  return (
    value === 'user-quit' ||
    value === 'update-restart' ||
    value === 'startup-failure' ||
    value === 'unknown'
  )
}
