// Which files are pack ARCHIVES, and where a folder's archive twin lives.
//
// ONE COPY, BECAUSE THREE PLACES ACT ON THE ANSWER. The MCP index decides what
// to index by it, History renames and deletes by it, and the storage accountant
// measures and trashes by it. The rules had already been written twice, with
// the same two extensions in the same order, under a constant named `PACK_EXT`
// that meant `.zip` in one file and `.capturepack` in the other; a third copy
// was about to be born for storage. A pack whose archive is only recognised by
// two of the three gets counted but not deleted, or renamed but left behind.
import AdmZip from 'adm-zip'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { stripUtf8Bom } from '../shared/json'
import { manifestNamesCapturePack } from '../shared/packIdentity'

/**
 * Archive extensions this app will open, newest convention first.
 *
 * `.zip` is what [Create ZIP] writes now — an archive should say what it is, so
 * a stranger's Windows, mail client and chat app can all open it without being
 * told to rename anything. `.capturepack` is still read because packs made by
 * earlier versions carry it, and a pack that stops being readable because the
 * app changed its mind about a file suffix would be the exact breakage this
 * project exists to prevent.
 */
export const PACK_ARCHIVE_EXTS: readonly string[] = ['.zip', '.capturepack']

/**
 * A reviewed, still-only sharing artifact is deliberately NOT a
 * CapturePack archive. It has no manifest.json, is never indexed as a pack,
 * and uses this unmistakable sibling suffix so it cannot be confused with the
 * full `{folder}.zip` twin that still contains the originals.
 */
export const SHARE_BUNDLE_SUFFIX = '.share.zip'
const MAX_SHARE_IDENTITY_BYTES = 64 * 1024

/** Which archive extension `name` ends with, or null when it is not one. */
export function packArchiveExt(name: string): string | null {
  const lower = name.toLowerCase()
  return PACK_ARCHIVE_EXTS.find((ext) => lower.endsWith(ext)) ?? null
}

/**
 * Exact-case archive suffix on `p` when at least a one-character stem precedes
 * it, or null when `p` is not a named pack archive.
 */
export function archiveSuffix(p: string): string | null {
  const base = path.basename(p)
  const ext = packArchiveExt(base)
  return ext !== null && base.length > ext.length ? base.slice(-ext.length) : null
}

/** An archive's display name: its own basename, minus whichever suffix it has. */
export function archiveStem(p: string): string {
  const base = path.basename(p)
  const suffix = archiveSuffix(base)
  return suffix === null ? base : base.slice(0, -suffix.length)
}

/**
 * The archive sitting beside a pack FOLDER, whichever extension it was made
 * with, or null when the folder has no twin.
 *
 * The twin follows the folder everywhere: a rename renames both, a delete
 * trashes both, and the storage total counts both — it is a distribution copy
 * of that pack and of nothing else, so leaving it behind would leave the user
 * with an orphan archive they cannot open from History and did not ask to keep.
 */
export function siblingArchive(dirPath: string): string | null {
  for (const ext of PACK_ARCHIVE_EXTS) {
    const candidate = `${dirPath}${ext}`
    if (!fs.existsSync(candidate)) continue
    // `Foo.share.zip` can mean either Foo's Share Copy or the full ZIP of a
    // different pack folder named Foo.share. Content identity, not the suffix,
    // owns that namespace.
    if (
      candidate.toLowerCase().endsWith(SHARE_BUNDLE_SUFFIX) &&
      rememberedShareBundle(candidate)
    ) {
      continue
    }
    return candidate
  }
  return null
}

/**
 * True when another archive (`.zip` or `.capturepack`, regardless of suffix
 * case) already occupies `stemPath`, ignoring `ignorePath` itself and validated
 * `.share.zip` Share Copies.
 */
export function hasOtherSiblingArchive(stemPath: string, ignorePath?: string): boolean {
  const ignored = ignorePath === undefined ? null : path.resolve(ignorePath).toLowerCase()
  const isConflict = (candidate: string): boolean => {
    if (ignored !== null && path.resolve(candidate).toLowerCase() === ignored) return false
    try {
      if (!fs.statSync(candidate).isFile()) return false
    } catch {
      return false
    }
    if (
      candidate.toLowerCase().endsWith(SHARE_BUNDLE_SUFFIX) &&
      rememberedShareBundle(candidate)
    ) {
      return false
    }
    return true
  }

  for (const ext of PACK_ARCHIVE_EXTS) {
    if (isConflict(`${stemPath}${ext}`)) return true
  }

  const parent = path.dirname(stemPath)
  const wantStem = path.basename(stemPath).toLowerCase()
  try {
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (archiveSuffix(entry.name) === null) continue
      if (archiveStem(entry.name).toLowerCase() !== wantStem) continue
      if (isConflict(path.join(parent, entry.name))) return true
    }
  } catch {
    // Unreadable or absent parent directory: rely on the direct probes above.
  }
  return false
}

/** Fixed sibling path of the derived share copy for one pack folder. */
export function shareBundlePath(dirPath: string): string {
  const normalized = path.resolve(dirPath)
  return path.join(path.dirname(normalized), `${path.basename(normalized)}${SHARE_BUNDLE_SUFFIX}`)
}

/** What an archive's contents say it is. Both false: somebody else's zip. */
interface ArchiveIdentity {
  /** A root manifest.json that names this format (SPEC 13.1). */
  holdsPack: boolean
  /** The separate reviewed Share Copy (`share.json`, no manifest). */
  isShare: boolean
}

const NOT_OURS: ArchiveIdentity = { holdsPack: false, isShare: false }

function identityOf(zip: AdmZip): ArchiveIdentity {
  return { holdsPack: zipHoldsAPack(zip), isShare: zipIsShareBundle(zip) }
}

function zipHoldsAPack(zip: AdmZip): boolean {
  try {
    // NAMED `manifest.json` IS NOT ENOUGH. Any npm, Electron or Rust archive
    // carries one; the pack index is what History renames and deletes
    // through, so it asks the manifest whether it names this format.
    const entry = zip.getEntry('manifest.json')
    if (entry === null || entry.isDirectory) return false
    return manifestNamesCapturePack(entry.getData().toString('utf8'))
  } catch {
    return false
  }
}

function zipIsShareBundle(zip: AdmZip): boolean {
  try {
    const files = zip.getEntries().filter((entry) => !entry.isDirectory)
    if (files.some((entry) => entry.entryName === 'manifest.json')) return false
    const inventories = files.filter((entry) => entry.entryName === 'share.json')
    if (inventories.length !== 1) return false
    const inventory = inventories[0]!
    if (inventory.header.size > MAX_SHARE_IDENTITY_BYTES) return false
    const parsed = JSON.parse(stripUtf8Bom(inventory.getData().toString('utf8'))) as unknown
    return (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>)['format'] === 'capturepack-share'
    )
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Remembered identities (#515).
//
// adm-zip reads a path argument with ONE readFileSync of the whole file, not
// just its central directory, and it does so on the main process. The History
// listing, every pack-store rescan (watch debounce, 5 s staleness) and every
// storage snapshot asked the same unchanged Share Copies and stray archives
// again, so the app stalled for as long as it took to read them all. An answer
// is now kept per file and trusted only while the file still stats the same:
// size, mtime, change time and file id. Any of those moving — an edit, a
// rewrite, a different file renamed over the name — asks the contents again.
//
// The Share Copy writer and the exporter's collision guard still call
// isShareBundleArchive(), which never consults this cache: a decision to back
// up, replace or refuse is made against the bytes on disk at that moment.

/** Most archives whose identity is remembered; the oldest-used go first. */
export const ARCHIVE_IDENTITY_CACHE_LIMIT = 512

interface RememberedIdentity {
  size: number
  mtimeMs: number
  ctimeMs: number
  ino: number
  identity: ArchiveIdentity
}

const identityCache = new Map<string, RememberedIdentity>()
let archiveContentReads = 0

function identityKey(file: string): string {
  return path.resolve(file).toLowerCase()
}

function sameFile(a: fs.Stats, b: { size: number; mtimeMs: number; ctimeMs: number; ino: number }): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino
}

function rememberedIdentity(file: string): ArchiveIdentity {
  const key = identityKey(file)
  let before: fs.Stats
  try {
    before = fs.statSync(file)
  } catch {
    identityCache.delete(key)
    return NOT_OURS
  }
  if (!before.isFile()) {
    identityCache.delete(key)
    return NOT_OURS
  }
  const known = identityCache.get(key)
  if (known !== undefined && sameFile(before, known)) {
    // Refresh recency: Map order is the eviction order.
    identityCache.delete(key)
    identityCache.set(key, known)
    return known.identity
  }
  identityCache.delete(key)
  let bytes: Buffer
  try {
    archiveContentReads += 1
    bytes = fs.readFileSync(file)
  } catch {
    // Locked, vanished or unreadable right now. That is not an answer about
    // the contents, so nothing is remembered and the next look asks again.
    return NOT_OURS
  }
  let identity: ArchiveIdentity
  try {
    identity = identityOf(new AdmZip(bytes))
  } catch {
    identity = NOT_OURS // Not a zip at all: a stable answer for these bytes.
  }
  let after: fs.Stats | null = null
  try {
    after = fs.statSync(file)
  } catch {
    after = null
  }
  // Written to while it was read: answer for these bytes, remember nothing.
  if (after === null || !sameFile(after, before)) return identity
  identityCache.set(key, {
    size: before.size,
    mtimeMs: before.mtimeMs,
    ctimeMs: before.ctimeMs,
    ino: before.ino,
    identity,
  })
  while (identityCache.size > ARCHIVE_IDENTITY_CACHE_LIMIT) {
    const oldest = identityCache.keys().next()
    if (oldest.done === true) break
    identityCache.delete(oldest.value)
  }
  return identity
}

/**
 * True when an archive holds a CapturePack at its root. Remembered while the
 * file stats the same — the pack index asks this of every archive on rescan.
 */
export function archiveHoldsAPack(file: string): boolean {
  return rememberedIdentity(file).holdsPack
}

/**
 * Drops remembered answers for archives that used to sit directly in one of
 * `scannedDirs` and were not among `seenFiles` this time — deleted, renamed
 * away, or no longer an archive. Directories that were not listed keep theirs.
 */
export function forgetMissingArchiveIdentities(
  scannedDirs: Iterable<string>,
  seenFiles: Iterable<string>,
): void {
  const dirs = new Set([...scannedDirs].map(identityKey))
  const seen = new Set([...seenFiles].map(identityKey))
  for (const key of [...identityCache.keys()]) {
    if (dirs.has(path.dirname(key)) && !seen.has(key)) identityCache.delete(key)
  }
}

/** QA probe: whole-archive reads made to answer a remembered identity. */
export function archiveIdentityReadCount(): number {
  return archiveContentReads
}

/** QA probe: how many archive identities are remembered right now. */
export function archiveIdentityCacheSize(): number {
  return identityCache.size
}

/**
 * True only for the separate Share Copy identity. A full CapturePack ZIP never
 * becomes a managed Share Copy merely because its filename ends in `.share.zip`.
 *
 * Always reads the file: this is the check the Share Copy writer and the
 * exporter act on before replacing or refusing a file.
 */
export function isShareBundleArchive(file: string): boolean {
  try {
    return zipIsShareBundle(new AdmZip(file))
  } catch {
    return false
  }
}

/** The same question for listings and sizes, remembered while the file is unchanged. */
function rememberedShareBundle(file: string): boolean {
  return rememberedIdentity(file).isShare
}

/** The validated managed Share Copy beside a pack, or null on collision. */
export function siblingShareBundle(dirPath: string): string | null {
  const candidate = shareBundlePath(dirPath)
  return fs.existsSync(candidate) && rememberedShareBundle(candidate) ? candidate : null
}
