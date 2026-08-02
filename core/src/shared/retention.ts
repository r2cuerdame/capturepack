// Storage retention and the size budget (issues #47 and #48): the rule that
// decides what the app is allowed to delete WITHOUT being asked, and the
// fraction that turns "3 GB" into something a person can feel.
//
// PURE, AND KEPT AWAY FROM THE DISK ON PURPOSE. Everything here is arithmetic
// over a list of {path, bytes, mtimeMs} plus three numbers out of Settings. The
// only code path in this application that trashes a user's evidence with
// nobody's finger on a button is therefore something a check can run to
// exhaustion in milliseconds — no Electron, no clock, no folder to be wrong
// about — and the same functions are what the Settings panel asks in order to
// say, before anything happens, what the next run would take.
import type { Settings } from './types'

/**
 * Retention's three settings keys, declared here rather than in the shared
 * Settings block, because they are only ever readable together.
 *
 * `storageMaxBytes` is TWO different things depending on the third key: always
 * the denominator the usage bar is drawn against, and only sometimes a delete
 * trigger. A reader who finds the budget without finding the flag that arms it
 * would reasonably assume the number alone deletes things. Keeping the shape
 * next to `planRetention` — the one function that resolves that ambiguity —
 * means the whole contract is on one screen.
 */
declare module './types' {
  interface Settings {
    /**
     * Automatic cleanup age in days: 0 (keep everything — the default), 1, 7
     * or 30. A fresh profile keeps everything; automatic deletion of captures
     * is something the user has to go and ask for.
     */
    storageRetentionDays: number
    /**
     * The soft budget the History and Settings usage bars are a fraction of.
     * ALWAYS a display number; a delete trigger only when the flag below is on.
     */
    storageMaxBytes: number
    /**
     * The budget is also a rule: when the output folder is over it, the oldest
     * packs go until it is not. Off by default, for the same reason
     * storageRetentionDays is.
     */
    storageEnforceMaxBytes: boolean
  }
}

/**
 * "Keep everything" — the off position of the automatic cleanup mode.
 *
 * ZERO MEANS THE OPPOSITE HERE FROM WHAT IT MEANS TO THE PURGE BUTTONS, AND
 * THE DIFFERENCE IS EVERY CAPTURE ON THE MACHINE.
 *
 * Settings > Storage has a [Delete everything] button whose age argument is 0,
 * and that is exactly right for it: "older than 0 days" is every pack ever
 * written, one cutoff serves all four buttons, and the button that takes
 * everything cannot drift away from the three that are dated. The automatic
 * MODE needs an off position too, and 0 days is the only honest word for it.
 *
 * So the two must never meet. Nothing on the automatic path takes a day count
 * and hands it to the manual purge: `planRetention` answers with the packs
 * themselves, and at 0 it answers with none of them. A scheduler wired
 * straight into purgeOlderThan(days) would read "keep everything" as "delete
 * everything" on its first run, silently, on the machine of the one user who
 * never touched this setting.
 */
export const RETENTION_KEEP_EVERYTHING = 0

/** The ages automatic cleanup offers, in days, off position first. */
export const RETENTION_DAY_CHOICES: readonly number[] = [RETENTION_KEEP_EVERYTHING, 1, 7, 30]

const GIB = 1_073_741_824

/**
 * The budget a fresh profile starts with.
 *
 * NEVER A FRACTION OF THE DISK. 3 GB of a 2 TB drive draws as an empty bar
 * while still being 3 GB of screen recordings, and a bar that always reads
 * empty is decoration. 10 GB is a number someone can hold in their head: a few
 * dozen captures, a week or two of ordinary use, and small enough that
 * crossing it means something.
 */
export const DEFAULT_STORAGE_MAX_BYTES = 10 * GIB

/** The budgets the panel offers, in bytes. */
export const STORAGE_MAX_BYTES_CHOICES: readonly number[] = [1, 2, 5, 10, 25, 50, 100, 250].map(
  (gb) => gb * GIB,
)

/**
 * The smallest budget a hand-edited settings.json may ask for.
 *
 * A single capture of a 4K desktop is tens of megabytes. A budget below this
 * would put the folder permanently over its limit, so an armed budget would
 * trim on every run forever and still never be satisfied.
 */
export const MIN_STORAGE_MAX_BYTES = 512 * 1_048_576

/** The fraction at which the bar stops being reassuring. */
export const BUDGET_NEAR_FRACTION = 0.75

export function isRetentionDays(value: unknown): value is number {
  return typeof value === 'number' && RETENTION_DAY_CHOICES.includes(value)
}

export function isStorageMaxBytes(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= MIN_STORAGE_MAX_BYTES
  )
}

/** A pack as retention sees it: a path, what it weighs, and how old it is. */
export interface RetentionCandidate {
  path: string
  bytes: number
  mtimeMs: number
}

/** The three settings above, lifted out so the planner never sees the rest. */
export interface RetentionPolicy {
  retentionDays: number
  maxBytes: number
  enforceMaxBytes: boolean
}

export interface RetentionPlan<T extends RetentionCandidate> {
  /** Past the age rule, oldest first. */
  expired: T[]
  /** Taken by the budget rule on top of `expired`, oldest first. */
  overBudget: T[]
  /** Everything the next run would trash, oldest first. */
  doomed: T[]
  /** What `doomed` would free. */
  bytes: number
  /** What the folder holds right now. */
  totalBytes: number
  /** What would be left afterwards. */
  remainingBytes: number
}

export function retentionPolicyOf(settings: Settings): RetentionPolicy {
  return {
    retentionDays: settings.storageRetentionDays,
    maxBytes: settings.storageMaxBytes,
    enforceMaxBytes: settings.storageEnforceMaxBytes,
  }
}

/**
 * What the next automatic run would take, and nothing else.
 *
 * A PLAN, NOT AN ACTION, because the panel has to be able to say the sentence
 * before the user commits to it: changing the mode states what the next run
 * would remove and removes nothing on the spot. The scheduler calls exactly the
 * same function and then trashes what it returns, so the sentence the user read
 * and the deletion they get are computed by one piece of code.
 */
export function planRetention<T extends RetentionCandidate>(
  candidates: readonly T[],
  policy: RetentionPolicy,
  nowMs: number,
): RetentionPlan<T> {
  const oldestFirst = [...candidates].sort(byAge)
  const totalBytes = sumBytes(oldestFirst)

  // At the off position there is no cutoff at all — not a cutoff of `nowMs`,
  // which would be every pack on disk. See RETENTION_KEEP_EVERYTHING.
  const cutoffMs =
    policy.retentionDays > 0 ? nowMs - policy.retentionDays * 86_400_000 : null
  const expired: T[] = []
  const kept: T[] = []
  for (const candidate of oldestFirst) {
    if (cutoffMs !== null && candidate.mtimeMs < cutoffMs) expired.push(candidate)
    else kept.push(candidate)
  }

  const overBudget: T[] = []
  if (policy.enforceMaxBytes && policy.maxBytes > 0) {
    let bytes = sumBytes(kept)
    // NEVER THE LAST ONE. The age rule may empty the folder, because that is
    // precisely what "delete everything older than a day" says out loud. The
    // budget says something softer, and a budget smaller than a single
    // recording would otherwise trash the capture taken thirty seconds ago,
    // every day, forever — the user would watch their newest evidence vanish
    // and have no way to read that as anything but a bug.
    while (bytes > policy.maxBytes && kept.length > 1) {
      const oldest = kept.shift()
      if (oldest === undefined) break
      overBudget.push(oldest)
      bytes -= oldest.bytes
    }
  }

  const doomed = [...expired, ...overBudget].sort(byAge)
  const bytes = sumBytes(doomed)
  return { expired, overBudget, doomed, bytes, totalBytes, remainingBytes: totalBytes - bytes }
}

function byAge(a: RetentionCandidate, b: RetentionCandidate): number {
  return a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path)
}

function sumBytes(packs: readonly RetentionCandidate[]): number {
  return packs.reduce((total, pack) => total + pack.bytes, 0)
}

// ---------------------------------------------------------------------------
// The glance: how full, and how alarmed to look about it.

export type BudgetLevel = 'ok' | 'near' | 'over'

/** 0..1, clamped — a bar cannot draw past its own end. */
export function budgetFraction(totalBytes: number, maxBytes: number): number {
  if (!(maxBytes > 0)) return 0
  return Math.max(0, Math.min(1, totalBytes / maxBytes))
}

export function budgetLevel(totalBytes: number, maxBytes: number): BudgetLevel {
  if (!(maxBytes > 0)) return 'ok'
  if (totalBytes >= maxBytes) return 'over'
  return totalBytes / maxBytes >= BUDGET_NEAR_FRACTION ? 'near' : 'ok'
}

/** Whole percent, for the tooltip that carries the exact number. */
export function budgetPercent(totalBytes: number, maxBytes: number): number {
  if (!(maxBytes > 0)) return 0
  return Math.round((totalBytes / maxBytes) * 100)
}

/**
 * Bytes as a person reads them.
 *
 * SHARED BECAUSE THE BAR IS IN TWO WINDOWS. History and Settings both print the
 * same total beside the same bar, and two formatters that round differently
 * would have the two windows disagree about the size of one folder.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes
  let unit = 'B'
  for (const next of units) {
    if (value < 1024) break
    value /= 1024
    unit = next
  }
  return `${value >= 100 ? String(Math.round(value)) : value.toFixed(1)} ${unit}`
}

/** Budget labels only: the choices are whole gigabytes, so "10 GB" beats "10.0 GB". */
export function formatBudget(bytes: number): string {
  return `${String(Math.round(bytes / GIB))} GB`
}
