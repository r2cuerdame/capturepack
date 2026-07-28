// Local forensics (issue #60): the app must never be able to die leaving no
// trace of what it was doing.
//
// v0.1.5 wrote NOTHING to disk — no crash dump, no Crashpad directory, no log
// file — so an app that vanished at 15:25 on a user's machine could only be
// investigated by reading source and guessing. Every "it said one thing and did
// another" report (#39, #43, #58) had to end with "please make one more capture
// and send it to me". This module is the record those reports needed:
//
//  - a CRASH REPORTER, so a hard death leaves a minidump under the user data
//    directory (%APPDATA%/CapturePack/Crashpad on Windows), and
//  - a ROLLING, SIZE-CAPPED LOG at %APPDATA%/CapturePack/logs/main.log carrying
//    startup, hotkey registration, recorder state transitions, captures, saves,
//    MCP, updater activity, and every error that would otherwise be silent.
//
// LOCAL ONLY. uploadToServer is false and nothing here ever opens a socket:
// CapturePack is a local-first tool (GOAL "Philosophy"), so the dump and the log
// are things the USER can attach to an issue, never things the app sends.
//
// Writes are SYNCHRONOUS on purpose. The lines that matter most are the last
// ones before a crash, and an async queue is exactly what loses them.
import { app, crashReporter } from 'electron'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// One megabyte of lines is days of ordinary use and still small enough to
// attach to an issue; the previous file is kept so a rotation right after a
// crash cannot hide the crash.
const MAX_LOG_BYTES = 1_048_576
// A log must never take the app down, and must never spin on a disk that is
// refusing writes. A handful of consecutive failures (file locked by an editor,
// disk full) disables file logging for the rest of the run; console output and
// the crash reporter are unaffected.
const MAX_WRITE_FAILURES = 3

type LogLevel = 'INFO' | 'WARN' | 'ERROR'

// Bytes already in main.log, learned once by stat and tracked from there —
// stat-ing on every line would cost a syscall per log entry.
let currentBytes: number | null = null
let writeFailures = 0
let fileLoggingEnabled = true

/** %APPDATA%/CapturePack/logs — what the tray's "Open logs folder" opens. */
export function logsDir(): string {
  return path.join(app.getPath('userData'), 'logs')
}

/** The live log file. main.log rotates to main.1.log at MAX_LOG_BYTES. */
export function logFilePath(): string {
  return path.join(logsDir(), 'main.log')
}

function previousLogFilePath(): string {
  return path.join(logsDir(), 'main.1.log')
}

/**
 * Starts the crash reporter and opens the log file. Call this FIRST, before
 * app.whenReady(): Crashpad has to be installed before the processes it is
 * meant to catch exist, and a startup that throws must already have somewhere
 * to say so.
 */
export function initForensics(): void {
  try {
    // No submitURL: with uploadToServer false nothing is ever transmitted, and
    // the dumps land in app.getPath('crashDumps') — the directory issue #60
    // went looking for and did not find.
    crashReporter.start({ uploadToServer: false, compress: true })
  } catch (err) {
    // A crash reporter that will not start is not a reason to refuse to run.
    console.error('[log] crash reporter did not start:', String(err))
  }
  logInfo(
    `[app] CapturePack ${app.getVersion()} starting — electron ${process.versions.electron}, ` +
      `chrome ${process.versions.chrome}, node ${process.versions.node}, ` +
      `${process.platform} ${process.arch}, pid ${process.pid}`,
  )
  logInfo(`[app] crash dumps: ${redactHome(app.getPath('crashDumps'))}`)
  installProcessHandlers()
}

/**
 * Catches what would otherwise be silence (issue #60, item 3).
 *
 * An uncaught exception does NOT quit the app here: CapturePack is a resident
 * buffer, and a stray error in one flow is a far smaller loss than a tray app
 * that disappears — which is the very failure #61 is about. It is recorded
 * instead, in the one place that survives the process.
 */
function installProcessHandlers(): void {
  process.on('uncaughtException', (err) => {
    logError('[app] uncaught exception', err)
  })
  process.on('unhandledRejection', (reason) => {
    logError('[app] unhandled rejection', reason)
  })
  // A vanished renderer is a recorder failure when it was a recorder (see
  // capture.ts, which owns the state transition); either way it is now on the
  // record instead of being invisible.
  app.on('render-process-gone', (_event, contents, details) => {
    const url = redactHome(contents.getURL())
    logError(
      `[app] renderer gone (${details.reason}, exitCode ${details.exitCode}) — ${url}`,
    )
  })
  app.on('child-process-gone', (_event, details) => {
    logError(
      `[app] child process gone: ${details.type}${details.name === undefined ? '' : ` (${details.name})`} ` +
        `— ${details.reason}, exitCode ${details.exitCode}`,
    )
  })
}

/**
 * Collapses the user's home directory to `~`.
 *
 * A log is only useful if the user is willing to attach it to an issue, and
 * every stack frame of an Electron app spells out their Windows account name.
 * Their OWN output folder is deliberately NOT redacted where it is logged
 * (issue #60: "redact file paths only where they are not the user's own
 * output") — "where did my pack go" is a question the log should answer.
 */
export function redactHome(text: string): string {
  const home = os.homedir()
  if (home === '') return text
  // Windows paths appear with both separators depending on who built the
  // string, and case varies between APIs (C:\Users vs c:\users).
  const variants = [home, home.replace(/\\/g, '/')]
  let result = text
  for (const variant of variants) {
    if (variant === '') continue
    const pattern = new RegExp(variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    result = result.replace(pattern, '~')
  }
  return result
}

export function logInfo(message: string): void {
  console.info(message)
  write('INFO', message)
}

export function logWarn(message: string): void {
  console.warn(message)
  write('WARN', message)
}

/**
 * `err` is optional so the same call reads well for both "this failed, here is
 * the exception" and "this failed, and the message already says how". Its text
 * (and its stack) is redacted — an unhandled error is exactly the line a user
 * pastes into an issue.
 */
export function logError(message: string, err?: unknown): void {
  const detail = err === undefined ? '' : ` ${redactHome(describeError(err))}`
  console.error(message + detail)
  write('ERROR', message + detail)
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`
  return String(err)
}

function write(level: LogLevel, message: string): void {
  if (!fileLoggingEnabled) return
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${message.replace(/\r?\n/g, ' | ')}\n`
  try {
    const file = logFilePath()
    if (currentBytes === null) {
      fs.mkdirSync(logsDir(), { recursive: true })
      currentBytes = fs.existsSync(file) ? fs.statSync(file).size : 0
    }
    const size = Buffer.byteLength(line)
    if (currentBytes + size > MAX_LOG_BYTES && fs.existsSync(file)) {
      // ONE previous generation is kept: a rotation that happened to land right
      // after the interesting lines must not be what erases them.
      fs.rmSync(previousLogFilePath(), { force: true })
      fs.renameSync(file, previousLogFilePath())
      currentBytes = 0
    }
    fs.appendFileSync(file, line)
    currentBytes += size
    writeFailures = 0
  } catch (err) {
    // Re-stat next time: a rename/rotation that half-succeeded leaves the
    // tracked size wrong, and a wrong size would rotate on every line.
    currentBytes = null
    writeFailures += 1
    if (writeFailures >= MAX_WRITE_FAILURES) {
      fileLoggingEnabled = false
      console.error('[log] file logging disabled after repeated failures:', String(err))
    }
  }
}
