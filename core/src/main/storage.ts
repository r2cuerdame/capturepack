// The output folder's accountant (issues #47 and #48): what the saved packs
// weigh, what the automatic cleanup would take next, and the once-a-day job
// that takes it.
//
// ONE LIST, MEASURED AND DELETED BY THE SAME CODE. The Settings buttons, the
// two usage bars and the scheduler all read `storedPacks()`, so the number on
// the bar, the number in the confirmation and the set of folders that actually
// move to the Recycle Bin can never be three different answers.
//
// WHAT COUNTS AS A PACK IS NOT DECIDED HERE. This reads the MCP pack index
// (mcp/store.ts) — the same index History lists, renames and deletes through —
// which admits a folder only when its manifest parses and names this format,
// and an archive only when the manifest inside it does. The output folder is
// somewhere the user also keeps their own things (this machine's is the
// Desktop), and a storage tool that measured or deleted by "everything in this
// directory" would be a catastrophe waiting for its first Downloads folder.
import { shell } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { StoragePurgeResult, StorageUsage } from '../shared/ipc'
import {
  planRetention,
  retentionPolicyOf,
  type RetentionCandidate,
} from '../shared/retention'
import type { Settings } from '../shared/types'
import { logError, logInfo } from './log'
import { createPackStore } from './mcp/store'
import type { PackStore, RawPackEntry } from './mcp/store'
import { siblingArchive, siblingShareBundle } from './packArchive'
import { beginPackOperation } from './packOperations'

/**
 * The ages the Settings panel offers, in days — and ZERO, which means
 * everything.
 *
 * Zero is not a special case anywhere below: "older than 0 days" has a cutoff
 * of now, and every pack on disk was written before now. So one walk, one
 * filter and one counted, confirmable delete serve all four buttons, and
 * "delete everything" cannot drift away from the three that are dated.
 *
 * This is the MANUAL scale. The automatic mode's zero means the opposite — see
 * RETENTION_KEEP_EVERYTHING in shared/retention.ts, which is also where the
 * reason the two never share a function is written down.
 */
const PURGE_AGES_DAYS: readonly number[] = [0, 1, 7, 30]

/** A pack on disk: what retention needs, plus the twin that goes with it. */
interface StoredPack extends RetentionCandidate {
  /** The sibling archive of a pack folder, when it has one. */
  twin: { path: string; bytes: number } | null
  /** The reviewed-stills-only sharing copy managed beside the same folder. */
  share: { path: string; bytes: number } | null
}

// ---------------------------------------------------------------------------
// The index, and the two caches that keep a repaint from walking the disk.

// The accountant's own index of the output folder, rebuilt when outputDir
// changes. Deliberately UNWATCHED: History and MCP already keep watched stores
// over the same tree, and a third recursive fs.watch on someone's Desktop is a
// real cost for a number that is allowed to be a few seconds old. Freshness
// comes from the snapshot TTL below instead.
let store: PackStore | null = null
let storeDir: string | null = null

// The expensive half — the recursive byte walk — cached per pack and keyed by
// the mtime the index reports for it. A pack is written once and then only
// grows an annotated replay or a regenerated document, and both of those add
// or replace a directory entry, which is what moves a folder's mtime on
// Windows. An in-place rewrite of manifest.json alone does not, so a re-edit
// can leave this a few kilobytes stale until the pack changes again — the
// wrong tradeoff would be re-walking every pack on every repaint to chase it.
const packBytesCache = new Map<string, { mtimeMs: number; bytes: number }>()

// The whole answer, for the burst of asks a window open produces. Short,
// because a capture saved behind an open History window should show up without
// the user going and doing something.
const SNAPSHOT_TTL_MS = 5_000
let snapshot: { outputDir: string; atMs: number; packs: StoredPack[] } | null = null

/**
 * Drops the cached answer. Called by anything in this process that changes
 * what is in the folder — the purge below, and History's per-card delete — so
 * the bar moves when the user watches it move rather than up to a TTL later.
 */
export function invalidateStorageUsage(): void {
  snapshot = null
}

function packStore(outputDir: string): PackStore {
  if (store !== null && storeDir === outputDir) return store
  store?.dispose()
  const created = createPackStore({ outputDir, watch: false })
  store = created
  storeDir = outputDir
  // A new folder's packs have nothing to do with the old folder's sizes.
  packBytesCache.clear()
  snapshot = null
  return created
}

/** Every pack in the output folder, with its size and its age. */
function storedPacks(outputDir: string): StoredPack[] {
  const cached = snapshot
  if (cached !== null && cached.outputDir === outputDir && Date.now() - cached.atMs < SNAPSHOT_TTL_MS) {
    return cached.packs
  }
  const entries = packStore(outputDir).entries()
  const packs = entries.map(measure)
  const live = new Set(entries.map((entry) => entry.path))
  for (const key of [...packBytesCache.keys()]) {
    if (!live.has(key)) packBytesCache.delete(key)
  }
  snapshot = { outputDir, atMs: Date.now(), packs }
  return packs
}

function measure(entry: RawPackEntry): StoredPack {
  // The twin is stat'd every time rather than cached with the pack: it is
  // created and deleted NEXT TO the folder, which does not touch the folder's
  // own mtime, so a cache keyed on that mtime would never notice [Create ZIP].
  const twinPath = entry.kind === 'dir' ? siblingArchive(entry.path) : null
  let twin: StoredPack['twin'] = null
  if (twinPath !== null) {
    try {
      twin = { path: twinPath, bytes: fs.statSync(twinPath).size }
    } catch {
      twin = null // Vanished between the existence check and the stat.
    }
  }
  const sharePath = entry.kind === 'dir' ? siblingShareBundle(entry.path) : null
  let share: StoredPack['share'] = null
  if (sharePath !== null && fs.existsSync(sharePath)) {
    try {
      share = { path: sharePath, bytes: fs.statSync(sharePath).size }
    } catch {
      share = null
    }
  }
  const cached = packBytesCache.get(entry.path)
  let bytes: number
  if (cached !== undefined && cached.mtimeMs === entry.mtimeMs) {
    bytes = cached.bytes
  } else {
    bytes = entry.kind === 'zip' ? fileBytes(entry.path) : dirBytes(entry.path)
    packBytesCache.set(entry.path, { mtimeMs: entry.mtimeMs, bytes })
  }
  return {
    path: entry.path,
    mtimeMs: entry.mtimeMs,
    bytes: bytes + (twin?.bytes ?? 0) + (share?.bytes ?? 0),
    twin,
    share,
  }
}

function fileBytes(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/** Recursive size, best effort — an unreadable child costs its own bytes only. */
function dirBytes(dir: string): number {
  let total = 0
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    try {
      if (entry.isDirectory()) total += dirBytes(full)
      else total += fs.statSync(full).size
    } catch {
      // Vanished or unreadable mid-walk: not counted.
    }
  }
  return total
}

// ---------------------------------------------------------------------------
// What the panels ask for

/**
 * How much the output folder is holding, what each manual button would remove,
 * and what the next automatic run would.
 *
 * The per-age counts, the total and the plan all come from ONE list, so the
 * number the user is shown is from the same moment as the number the delete
 * will act on.
 */
export function storageUsage(live: Settings): StorageUsage {
  const packs = storedPacks(live.outputDir)
  const now = Date.now()
  const plan = planRetention(packs, retentionPolicyOf(live), now)
  return {
    totalBytes: plan.totalBytes,
    totalPacks: packs.length,
    oldestMs: packs.length === 0 ? null : Math.min(...packs.map((pack) => pack.mtimeMs)),
    maxBytes: live.storageMaxBytes,
    next: { packs: plan.doomed.length, bytes: plan.bytes },
    olderThan: PURGE_AGES_DAYS.map((days) => {
      const cutoff = now - days * 86_400_000
      const old = packs.filter((pack) => pack.mtimeMs < cutoff)
      return {
        days,
        packs: old.length,
        bytes: old.reduce((sum, pack) => sum + pack.bytes, 0),
      }
    }),
  }
}

/**
 * Moves packs older than `days` to the Recycle Bin — the four Settings
 * buttons, where `days === 0` means every pack there is.
 *
 * This is the MANUAL path and it stays one: "Delete everything" is an action,
 * not a mode, and it keeps its counted confirmation. Nothing automatic calls
 * it; see runRetentionSweep.
 */
export async function purgeOlderThan(live: Settings, days: number): Promise<StoragePurgeResult> {
  const cutoff = Date.now() - days * 86_400_000
  const doomed = storedPacks(live.outputDir).filter((pack) => pack.mtimeMs < cutoff)
  return trashPacks(doomed, days === 0 ? 'everything' : `older than ${String(days)}d`)
}

/**
 * Moves packs to the Recycle Bin. THE ONLY DELETE IN THIS MODULE.
 *
 * TRASH, NEVER UNLINK. These are captures the user chose to keep, and a wrong
 * click — or a rule that ran while nobody was looking — would otherwise be
 * unrecoverable. shell.trashItem is what makes this a decision the user can
 * take back, and if the shell refuses, the pack stays where it is rather than
 * being removed some other way.
 */
async function trashPacks(doomed: readonly StoredPack[], reason: string): Promise<StoragePurgeResult> {
  let packsDeleted = 0
  let bytesFreed = 0
  let firstError: string | null = null
  for (const pack of doomed) {
    const release = beginPackOperation(pack.path)
    if (release === null) {
      if (firstError === null) firstError = 'pack is busy'
      continue
    }
    const packOnlyBytes = Math.max(
      0,
      pack.bytes - (pack.twin?.bytes ?? 0) - (pack.share?.bytes ?? 0),
    )
    try {
      // Companions go first. If either one cannot move, the pack remains in the
      // index and continues to own every copy left on disk. This is stricter
      // than best effort because an unindexed Share Copy is a silent privacy
      // failure, not a successful cleanup.
      if (pack.share !== null) {
        try {
          await shell.trashItem(pack.share.path)
          bytesFreed += pack.share.bytes
        } catch (err) {
          if (firstError === null) firstError = errorMessage(err)
          logError('capturepack: could not trash share copy:', err)
          continue
        }
      }
      if (pack.twin !== null) {
        try {
          await shell.trashItem(pack.twin.path)
          bytesFreed += pack.twin.bytes
        } catch (err) {
          if (firstError === null) firstError = errorMessage(err)
          logError('capturepack: could not trash zip twin:', err)
          continue
        }
      }
      try {
        await shell.trashItem(pack.path)
        packsDeleted += 1
        bytesFreed += packOnlyBytes
      } catch (err) {
        if (firstError === null) firstError = errorMessage(err)
      }
    } finally {
      release()
    }
  }
  invalidateStorageUsage()
  logInfo(
    `[storage] purge ${reason}: ${String(packsDeleted)} of ${String(doomed.length)} pack(s) ` +
      `to the Recycle Bin, ${String(Math.round(bytesFreed / 1_048_576))} MB`,
  )
  return {
    ok: firstError === null,
    packsDeleted,
    bytesFreed,
    ...(firstError === null ? {} : { error: firstError }),
  }
}

// ---------------------------------------------------------------------------
// The automatic half: a job that deletes evidence with nobody watching.

/**
 * How often the scheduler LOOKS, which is not how often it acts.
 *
 * A 24-hour setInterval is a promise no laptop keeps: it sleeps, the timer
 * stops with it, and a machine that is closed every evening never reaches the
 * second run. Waking hourly and asking "has it been a day since the last one?"
 * survives sleep, hibernation and an app left open for a month, and costs one
 * comparison an hour.
 */
const SWEEP_TICK_MS = 60 * 60 * 1_000
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1_000

/**
 * How long after launch the startup sweep runs.
 *
 * Not zero: the first seconds of a launch are the replay recorders starting and
 * the tray appearing, and the first thing a user sees must not be the app
 * walking their whole Desktop. Late enough to be out of the way, early enough
 * that a login launch which is closed again in a minute still gets its run.
 */
const STARTUP_SWEEP_DELAY_MS = 30_000

let startupSweepTimer: ReturnType<typeof setTimeout> | null = null
let dailySweepTimer: ReturnType<typeof setInterval> | null = null
let lastSweepMs = 0

/**
 * Starts the automatic cleanup: once at startup, then once a day, AND ONLY
 * THEN.
 *
 * Changing the setting deletes nothing on the spot. The Settings panel says
 * what the next run would remove and leaves it at that, because a dropdown
 * that trashes forty captures the instant it is touched gives the user no
 * moment in which to have chosen otherwise — and because the same dropdown is
 * how they would try to turn the feature back off.
 *
 * `live` is the settings object main mutates in place, not a copy: a retention
 * change made while the app runs is what the NEXT run honours, without a
 * restart and without this module subscribing to anything.
 */
export function startRetentionScheduler(live: Settings): void {
  stopRetentionScheduler()
  const startup = setTimeout(() => {
    void runRetentionSweep(live, 'startup')
  }, STARTUP_SWEEP_DELAY_MS)
  const tick = setInterval(() => {
    if (Date.now() - lastSweepMs < SWEEP_INTERVAL_MS) return
    void runRetentionSweep(live, 'daily')
  }, SWEEP_TICK_MS)
  // Neither timer is a reason for the process to stay alive.
  startup.unref()
  tick.unref()
  startupSweepTimer = startup
  dailySweepTimer = tick
}

export function stopRetentionScheduler(): void {
  if (startupSweepTimer !== null) clearTimeout(startupSweepTimer)
  if (dailySweepTimer !== null) clearInterval(dailySweepTimer)
  startupSweepTimer = null
  dailySweepTimer = null
}

/**
 * One automatic run.
 *
 * It asks `planRetention` for the PACKS and trashes those. It does not compute
 * a day count and hand it to purgeOlderThan — at the "keep everything" setting
 * that day count is 0, and 0 is the manual scale's word for "all of them".
 */
export async function runRetentionSweep(
  live: Settings,
  trigger: 'startup' | 'daily',
): Promise<StoragePurgeResult> {
  lastSweepMs = Date.now()
  const policy = retentionPolicyOf(live)
  const plan = planRetention(storedPacks(live.outputDir), policy, lastSweepMs)
  if (plan.doomed.length === 0) {
    logInfo(
      `[storage] retention sweep (${trigger}): nothing to remove ` +
        `(keep ${policy.retentionDays === 0 ? 'everything' : `${String(policy.retentionDays)}d`}, ` +
        `budget ${policy.enforceMaxBytes ? `${String(Math.round(policy.maxBytes / 1_048_576))} MB` : 'off'})`,
    )
    return { ok: true, packsDeleted: 0, bytesFreed: 0 }
  }
  logInfo(
    `[storage] retention sweep (${trigger}): ${String(plan.expired.length)} past ` +
      `${String(policy.retentionDays)}d, ${String(plan.overBudget.length)} over budget`,
  )
  return trashPacks(plan.doomed, `retention ${trigger}`)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
