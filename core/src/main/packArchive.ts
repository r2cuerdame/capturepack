// Which files are pack ARCHIVES, and where a folder's archive twin lives.
//
// ONE COPY, BECAUSE THREE PLACES ACT ON THE ANSWER. The MCP index decides what
// to index by it, History renames and deletes by it, and the storage accountant
// measures and trashes by it. The rules had already been written twice, with
// the same two extensions in the same order, under a constant named `PACK_EXT`
// that meant `.zip` in one file and `.capturepack` in the other; a third copy
// was about to be born for storage. A pack whose archive is only recognised by
// two of the three gets counted but not deleted, or renamed but left behind.
import * as fs from 'node:fs'
import * as path from 'node:path'

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

/** Which archive extension `name` ends with, or null when it is not one. */
export function packArchiveExt(name: string): string | null {
  const lower = name.toLowerCase()
  return PACK_ARCHIVE_EXTS.find((ext) => lower.endsWith(ext)) ?? null
}

/** An archive's display name: its own basename, minus whichever suffix it has. */
export function archiveStem(p: string): string {
  const ext = packArchiveExt(p)
  return ext === null ? path.basename(p) : path.basename(p, ext)
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
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}
