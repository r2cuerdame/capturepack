// The contract between the app and its watchdog (issue #61, "do not let it be
// gone"). Shared because the watchdog is a separate, electron-free process:
// this file is the only thing both sides agree on, and keeping it in one place
// is what stops the two halves from drifting into disagreeing about which exits
// are intentional.
import type { StartMenuLinkSpec } from './startMenuLink'

/** Written by the app before it spawns the watchdog; read once at watchdog start. */
export interface SupervisionPlan {
  /** The run the watchdog supervises. */
  appPid: number
  /**
   * run-state.json's `startedAt` for that run. The watchdog refuses to act on a
   * marker written by a DIFFERENT run — otherwise a stale file could make it
   * relaunch an app that is deliberately not running.
   */
  runStartedAt: string
  /** lifecycle.ts's marker: an open `exit` is what "it died" looks like on disk. */
  runStateFile: string
  /**
   * Installer/uninstaller stand-down flag. NSIS writes it before it closes the
   * running app and removes it once setup is done — a supervisor that
   * resurrected the app in the middle of an update or an uninstall would be a
   * far worse bug than the one it exists to fix.
   */
  standDownFile: string
  /** Where the watchdog records relaunches, so the rate limit survives it. */
  journalFile: string
  /** The watchdog's own log; kept apart from main.log, which it cannot share safely. */
  logFile: string
  /**
   * How to bring the app back — the SAME executable and the SAME arguments the
   * supervised run itself was started with (profile, output folder, dev
   * switches). A watchdog can therefore only ever resurrect the instance that
   * spawned it, never some other CapturePack on the machine.
   */
  relaunch: { exe: string; args: string[] }
  /** The Start Menu fallback to arm once the app is gone; null when unusable. */
  shortcut: StartMenuLinkSpec | null
  /** At most this many automatic relaunches inside `windowMs`. */
  maxRelaunches: number
  windowMs: number
}

/**
 * What automatic recovery has done lately. Read by the app at startup so the
 * relaunch can announce itself, and by the watchdog so a crash LOOP cannot be
 * mistaken for a one-off crash.
 */
export interface SupervisionJournal {
  /** ISO timestamps of automatic relaunches, oldest first, pruned to the window. */
  relaunches: string[]
  /** The rate limit was hit: supervision has stopped and said so. */
  gaveUp: boolean
  /** Last heartbeat of the run that died — the time the announcement names. */
  diedAt: string | null
}

/** Passed to a relaunched app so it announces the recovery instead of starting silently. */
export const RELAUNCHED_ARG = '--relaunched-by-supervisor'

/**
 * Passed to the final launch after the rate limit was hit. That run announces
 * that automatic restart has STOPPED, does not supervise itself, and leaves the
 * hotkey with the Start Menu shortcut — the one holder that cannot crash.
 */
export const GAVE_UP_ARG = '--supervision-gave-up'

/** Argument the app filters out of the relaunch line: one-shot dev aids and our own markers. */
export const NON_RELAUNCHABLE_ARGS: readonly string[] = [
  RELAUNCHED_ARG,
  GAVE_UP_ARG,
  '--capture',
  '--capture-now',
  '--show-settings',
  '--show-history',
  '--show-about',
  '--show-welcome',
  '--smoke',
  '--no-supervision',
]

export function emptyJournal(): SupervisionJournal {
  return { relaunches: [], gaveUp: false, diedAt: null }
}

/**
 * Hand-written validation rather than a cast: both files sit in a directory the
 * user can edit, and a garbled journal must degrade to "nothing has happened
 * lately", never to a crash in the process whose whole job is to survive.
 */
export function asJournal(value: unknown): SupervisionJournal {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return emptyJournal()
  const raw = value as Record<string, unknown>
  const list = Array.isArray(raw['relaunches']) ? raw['relaunches'] : []
  return {
    relaunches: list.filter((entry): entry is string => typeof entry === 'string'),
    gaveUp: raw['gaveUp'] === true,
    diedAt: typeof raw['diedAt'] === 'string' ? raw['diedAt'] : null,
  }
}
