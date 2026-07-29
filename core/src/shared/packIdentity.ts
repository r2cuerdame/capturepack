// IS THIS A CAPTUREPACK? Asked of the file, not of its name.
//
// SHARED BECAUSE A WRONG ANSWER DELETES THINGS. Settings > Capture's storage
// row counts packs and then trashes them; the MCP store indexes them and the
// History window renames and deletes through that index. Both used to accept a
// directory because it contained a file called `manifest.json`, and a file
// because its name ended in `.zip`. The output folder is the user's to choose,
// and the Settings GUI lets them choose Downloads, Documents, or the Desktop —
// where "delete older than 30 days" would have taken every unrelated archive,
// and every npm, Electron or Rust project folder, since those carry a
// manifest.json of their own.
//
// A pack is something that SAYS it is a pack: a manifest that parses and names
// this format (SPEC §13.1). The cost is one small read per candidate, paid on
// paths that are about to delete or publish something.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { FORMAT_NAME } from './types'

/**
 * A manifest larger than this is not one. Bounded because this runs over
 * whatever the user pointed the output folder at, and reading an arbitrary
 * multi-gigabyte file called `manifest.json` into memory is its own bug.
 */
const MAX_MANIFEST_BYTES = 4 * 1_048_576

/** True when `raw` parses as a manifest that names this format. */
export function manifestNamesCapturePack(raw: string): boolean {
  try {
    // A BOM survives plenty of editors and would otherwise fail the parse for
    // a pack that is perfectly valid.
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ''))
    if (typeof parsed !== 'object' || parsed === null) return false
    return (parsed as { format?: unknown }).format === FORMAT_NAME
  } catch {
    return false
  }
}

/** A pack FOLDER: `manifest.json` is a real file, small, and says so. */
export function directoryHoldsCapturePack(dir: string): boolean {
  try {
    const manifest = path.join(dir, 'manifest.json')
    const stat = fs.statSync(manifest)
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return false
    return manifestNamesCapturePack(fs.readFileSync(manifest, 'utf8'))
  } catch {
    return false
  }
}
