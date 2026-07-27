// MCP pack store: indexes settings.outputDir (*.capturepack zips and extracted
// pack directories), kept fresh by fs.watch, and reads pack contents lazily via
// adm-zip (zip) or fs (dir). Read-only: nothing here writes to disk.
import AdmZip from 'adm-zip'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { AnnotationsFile, Manifest, TimelineFile } from '../../shared/types'

const PACK_EXT = '.capturepack'
const RESCAN_DEBOUNCE_MS = 300
const MAX_DIR_FILES = 2000
// Folder-first exporter: packs are flat outputDir/CapturePack_YYYY-MM-DD_HHMMSS/
// folders (each contains manifest.json, so depth-0 scanning finds them). One
// extra level is still scanned for packs from the pre-release date-folder
// layout (outputDir/YYYY-MM-DD/…) and for user-organized subfolders.
const MAX_SCAN_DEPTH = 1
// Even with a live watcher, rescan when the index is older than this: a
// silently dead watcher (network/OneDrive-redirected folders) must not freeze
// the index for a whole session. scan() is dirent/stat only, so this is cheap.
const STALE_RESCAN_MS = 5000
// How many of the newest entries latest() probes for a readable pack before
// falling back to the newest entry regardless of warnings.
const MAX_LATEST_PROBE = 20

export type PackKind = 'zip' | 'dir'

export interface PackIndexEntry {
  id: string
  path: string
  kind: PackKind
  mtimeMs: number
  title: string | null
  capturedAt: string | null
  warning: string | null
}

export interface PluginInfo {
  name: string
  version: string | null
  files: string[]
}

export interface PackHandle {
  id: string
  path: string
  kind: PackKind
  manifest(): Manifest | null
  manifestText(): string | null
  report(): string | null
  annotations(): AnnotationsFile | null
  timeline(): TimelineFile | null
  plugins(): PluginInfo[]
  readText(rel: string): string | null
  readBinary(rel: string): Buffer | null
  fileSize(rel: string): number | null
  listFiles(): string[]
  warnings(): string[]
}

export interface PackStore {
  outputDir: string
  /** Newest-first entries; metadata is filled only for the returned slice. */
  list(limit: number): { total: number; packs: PackIndexEntry[] }
  /** Newest readable pack; re-pins it as the session default. Throws if none exist. */
  latest(): PackHandle
  /** Open by id or absolute path and pin as the session default. */
  open(idOrPath: string): PackHandle
  /** Resolve id/path, or the pinned/newest pack when omitted. Does not re-pin. */
  resolve(idOrPath?: string): PackHandle
  /**
   * Newest-first raw index (no manifest reads) — the History window's listing
   * surface. Reuses the exact scan the MCP tools use; callers attach their own
   * metadata via openPack().
   */
  entries(): RawPackEntry[]
  /**
   * Subscribe to watcher-driven index changes (debounced; fires only when the
   * set of packs or an mtime actually changed). Returns an unsubscribe
   * function. Scans triggered by direct store access never notify, so a
   * listener that re-lists in response cannot loop.
   */
  onDidChange(listener: () => void): () => void
  dispose(): void
}

/** Index entry before manifest metadata is (lazily) attached. */
export interface RawPackEntry {
  id: string
  path: string
  kind: PackKind
  mtimeMs: number
}

type RawEntry = RawPackEntry

export function createPackStore(options: { outputDir: string; watch: boolean }): PackStore {
  const outputDir = options.outputDir
  let index: RawEntry[] = []
  let lastScanMs = 0
  let current: { id: string; path: string; kind: PackKind } | null = null
  let watcher: fs.FSWatcher | null = null
  let debounce: NodeJS.Timeout | null = null
  // manifest metadata per pack path, invalidated by mtime change
  const metaCache = new Map<
    string,
    { mtimeMs: number; title: string | null; capturedAt: string | null; warning: string | null }
  >()
  // History-window change subscribers; notified only from the watcher path.
  const changeListeners = new Set<() => void>()
  let lastNotifiedSig: string | null = null

  function indexSignature(): string {
    return index.map((e) => `${e.kind}:${e.path}|${e.mtimeMs}`).join('\n')
  }

  // Notifies subscribers when the index really changed since the last
  // notification. Only the watcher debounce calls this: access-driven rescans
  // (ensureFresh) must not notify, or a listener that re-lists would loop.
  function notifyIfChanged(): void {
    const sig = indexSignature()
    if (sig === lastNotifiedSig) return
    lastNotifiedSig = sig
    for (const listener of [...changeListeners]) {
      try {
        listener()
      } catch (err) {
        console.error('capturepack: pack store change listener failed:', errorMessage(err))
      }
    }
  }

  // Cheap by design: dirents + stat only, never opens a pack. Manifest metadata
  // is attached lazily by getMeta() for just the entries a tool actually returns.
  function scan(): void {
    const found: RawEntry[] = []
    scanDir(outputDir, '', 0, found)
    found.sort(
      (a, b) =>
        b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id) || a.kind.localeCompare(b.kind),
    )
    index = found
    lastScanMs = Date.now()
    // Prune cache entries for packs that no longer exist.
    const live = new Set(found.map((e) => e.path))
    for (const key of [...metaCache.keys()]) {
      if (!live.has(key)) metaCache.delete(key)
    }
  }

  function scanDir(dir: string, relPrefix: string, depth: number, out: RawEntry[]): void {
    let dirents: fs.Dirent[]
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return // dir missing or unreadable: nothing to add, no crash
    }
    // Folder-first (SPEC §3): the FOLDER is the pack; a same-stem sibling
    // CapturePack_X.capturepack is an on-demand distribution copy created by
    // the toast's [Create ZIP] — possibly stale (e.g. made before the
    // background annotated-replay render finished). Index the dir and suppress
    // its zip twin; a zip with no sibling dir is still a pack of its own.
    const dirStems = new Set<string>()
    for (const d of dirents) {
      try {
        if (d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'manifest.json'))) {
          dirStems.add(d.name.toLowerCase())
        }
      } catch {
        // Directory vanished mid-scan: skip it.
      }
    }
    for (const d of dirents) {
      const full = path.join(dir, d.name)
      const rel = relPrefix === '' ? d.name : `${relPrefix}/${d.name}`
      try {
        if (d.isFile() && d.name.toLowerCase().endsWith(PACK_EXT)) {
          if (!dirStems.has(d.name.slice(0, -PACK_EXT.length).toLowerCase())) {
            out.push({ id: rel.slice(0, -PACK_EXT.length), path: full, kind: 'zip', mtimeMs: fs.statSync(full).mtimeMs })
          }
        } else if (d.isDirectory()) {
          if (fs.existsSync(path.join(full, 'manifest.json'))) {
            out.push({ id: rel, path: full, kind: 'dir', mtimeMs: fs.statSync(full).mtimeMs })
          } else if (depth < MAX_SCAN_DEPTH) {
            scanDir(full, rel, depth + 1, out)
          }
        }
      } catch {
        // File vanished mid-scan: skip it.
      }
    }
  }

  function getMeta(e: RawEntry): PackIndexEntry {
    const cached = metaCache.get(e.path)
    // Successful reads are trusted until the mtime changes. Warned entries are
    // re-validated on every access: a pack that was read mid-write must not
    // stay "broken" for the rest of the session.
    if (cached && cached.mtimeMs === e.mtimeMs && cached.warning === null) {
      return { ...e, title: cached.title, capturedAt: cached.capturedAt, warning: null }
    }
    let title: string | null = null
    let capturedAt: string | null = null
    let warning: string | null = null
    try {
      const pack = openPack(e.path, e.kind, e.id)
      const manifest = pack.manifest()
      if (manifest) {
        title = typeof manifest.title === 'string' ? manifest.title : null
        capturedAt = typeof manifest.created_at === 'string' ? manifest.created_at : null
      } else {
        warning = pack.warnings()[0] ?? 'manifest.json missing or malformed'
      }
    } catch (err) {
      warning = `unreadable pack: ${errorMessage(err)}`
    }
    metaCache.set(e.path, { mtimeMs: e.mtimeMs, title, capturedAt, warning })
    return { ...e, title, capturedAt, warning }
  }

  function tryWatch(): void {
    if (!options.watch || watcher) return
    try {
      // recursive: pack writes land inside date subfolders (outputDir/YYYY-MM-DD/),
      // which a non-recursive watch on outputDir never reports.
      watcher = fs.watch(outputDir, { persistent: false, recursive: true }, () => {
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(() => {
          debounce = null
          scan()
          notifyIfChanged()
        }, RESCAN_DEBOUNCE_MS)
      })
      watcher.on('error', () => {
        if (debounce) clearTimeout(debounce)
        debounce = null
        watcher?.close()
        watcher = null
      })
    } catch {
      watcher = null // outputDir missing: rescan on demand until it appears
    }
  }

  // With an active watcher the index stays fresh on its own; without one
  // (watch disabled, or outputDir missing/renamed) rescan on every access.
  // Also rescan when the watcher was JUST attached (the pre-watcher index may
  // be stale) and when the last scan is old (dead-watcher safety net).
  function ensureFresh(): void {
    const hadWatcher = watcher !== null
    tryWatch()
    if (!watcher || !hadWatcher || Date.now() - lastScanMs > STALE_RESCAN_MS) scan()
  }

  function findEntry(ref: string): RawEntry | undefined {
    const lower = ref.toLowerCase()
    // index is newest-first, so an ambiguous base name resolves to the newest match.
    return index.find(
      (e) =>
        e.id.toLowerCase() === lower ||
        path.basename(e.path).toLowerCase() === lower ||
        path.basename(e.id).toLowerCase() === lower,
    )
  }

  function handleFor(ref: string): PackHandle {
    const entry = findEntry(ref)
    if (entry) return openPack(entry.path, entry.kind, entry.id)
    if (path.isAbsolute(ref) && fs.existsSync(ref)) {
      const stat = fs.statSync(ref)
      if (stat.isDirectory()) return openPack(ref, 'dir', path.basename(ref))
      const base = path.basename(ref)
      const id = base.toLowerCase().endsWith(PACK_EXT) ? base.slice(0, -PACK_EXT.length) : base
      return openPack(ref, 'zip', id)
    }
    throw new Error(
      `No pack matches "${ref}". Call capturepack_list for known ids, or pass an absolute path to a .capturepack file or extracted pack folder.`,
    )
  }

  function newestHandle(): PackHandle {
    if (index.length === 0) {
      throw new Error(
        `No CapturePacks found in ${outputDir}. Export a capture first (Ctrl+Alt+C in CapturePack).`,
      )
    }
    // Prefer the newest READABLE pack: a malformed (or mid-write) newest entry
    // must not shadow the user's real latest capture. Probe a bounded number of
    // entries, then fall back to the newest regardless (its warnings surface in
    // the summary).
    const readable = index.slice(0, MAX_LATEST_PROBE).find((e) => getMeta(e).warning === null)
    const chosen = readable ?? index[0]
    if (!chosen) {
      throw new Error(`No CapturePacks found in ${outputDir}.`)
    }
    return openPack(chosen.path, chosen.kind, chosen.id)
  }

  scan()
  // Baseline for change notification: the first watcher event only notifies
  // when it changed something relative to this initial index.
  lastNotifiedSig = indexSignature()
  tryWatch()

  return {
    outputDir,
    list(limit: number): { total: number; packs: PackIndexEntry[] } {
      ensureFresh()
      return { total: index.length, packs: index.slice(0, limit).map(getMeta) }
    },
    latest(): PackHandle {
      ensureFresh()
      const pack = newestHandle()
      current = { id: pack.id, path: pack.path, kind: pack.kind }
      return pack
    },
    open(idOrPath: string): PackHandle {
      ensureFresh()
      const pack = handleFor(idOrPath)
      current = { id: pack.id, path: pack.path, kind: pack.kind }
      return pack
    },
    resolve(idOrPath?: string): PackHandle {
      ensureFresh()
      if (idOrPath !== undefined && idOrPath.trim() !== '') return handleFor(idOrPath.trim())
      if (current) {
        if (fs.existsSync(current.path)) return openPack(current.path, current.kind, current.id)
        current = null // pinned pack was deleted: fall back to newest
      }
      return newestHandle()
    },
    entries(): RawPackEntry[] {
      ensureFresh()
      return index.map((e) => ({ ...e }))
    },
    onDidChange(listener: () => void): () => void {
      changeListeners.add(listener)
      return () => {
        changeListeners.delete(listener)
      }
    },
    dispose(): void {
      if (debounce) clearTimeout(debounce)
      debounce = null
      watcher?.close()
      watcher = null
      changeListeners.clear()
    },
  }
}

// ---------------------------------------------------------------------------
// Pack reading (zip via adm-zip, dir via fs) — lazy and tolerant.

interface PackReader {
  readBinary(rel: string): Buffer | null
  fileSize(rel: string): number | null
  listFiles(): string[]
}

export function openPack(absPath: string, kind: PackKind, id: string): PackHandle {
  const warnings: string[] = []
  let reader: PackReader | null = null
  let readerFailed = false

  function getReader(): PackReader | null {
    if (reader || readerFailed) return reader
    try {
      reader = kind === 'zip' ? zipReader(absPath) : dirReader(absPath)
    } catch (err) {
      readerFailed = true
      warnings.push(`cannot open pack: ${errorMessage(err)}`)
    }
    return reader
  }

  function readBinary(rel: string): Buffer | null {
    return getReader()?.readBinary(rel) ?? null
  }

  function readText(rel: string): string | null {
    const buf = readBinary(rel)
    return buf ? buf.toString('utf8') : null
  }

  function readJson(rel: string): unknown {
    const text = readText(rel)
    if (text === null) return null
    try {
      return JSON.parse(text) as unknown
    } catch (err) {
      warnings.push(`${rel} is not valid JSON: ${errorMessage(err)}`)
      return null
    }
  }

  // Parsed-file caches: each file is read and parsed at most once per handle.
  let manifestCache: { value: Manifest | null } | null = null
  let annotationsCache: { value: AnnotationsFile | null } | null = null
  let timelineCache: { value: TimelineFile | null } | null = null

  function manifest(): Manifest | null {
    if (!manifestCache) {
      const parsed = readJson('manifest.json')
      const ok = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      if (!ok && getReader() && !warnings.some((w) => w.startsWith('manifest.json'))) {
        warnings.push('manifest.json is missing')
      }
      manifestCache = { value: ok ? (parsed as Manifest) : null }
    }
    return manifestCache.value
  }

  function annotations(): AnnotationsFile | null {
    if (!annotationsCache) {
      const parsed = readJson('annotations.json')
      const ok = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      annotationsCache = { value: ok ? (parsed as AnnotationsFile) : null }
    }
    return annotationsCache.value
  }

  function timeline(): TimelineFile | null {
    if (!timelineCache) {
      const parsed = readJson('timeline.json')
      const ok = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      timelineCache = { value: ok ? (parsed as TimelineFile) : null }
    }
    return timelineCache.value
  }

  function plugins(): PluginInfo[] {
    const byName = new Map<string, string[]>()
    for (const file of getReader()?.listFiles() ?? []) {
      const parts = file.split('/')
      if (parts[0] !== 'plugins' || parts.length < 3) continue
      const name = parts[1]
      if (!name) continue
      const files = byName.get(name) ?? []
      files.push(file)
      byName.set(name, files)
    }
    const declared = manifest()?.plugins
    const declaredList = Array.isArray(declared) ? declared : []
    for (const p of declaredList) {
      if (typeof p?.name === 'string' && !byName.has(p.name)) byName.set(p.name, [])
    }
    return [...byName.entries()].map(([name, files]) => ({
      name,
      version: declaredList.find((p) => p?.name === name)?.version ?? null,
      files: files.sort(),
    }))
  }

  return {
    id,
    path: absPath,
    kind,
    manifest,
    manifestText: () => readText('manifest.json'),
    report: () => readText('report.md'),
    annotations,
    timeline,
    plugins,
    readText,
    readBinary,
    fileSize: (rel) => getReader()?.fileSize(rel) ?? null,
    listFiles: () => getReader()?.listFiles() ?? [],
    warnings: () => [...warnings],
  }
}

function zipReader(zipPath: string): PackReader {
  const zip = new AdmZip(zipPath)
  const entries = zip.getEntries().filter((e) => !e.isDirectory)
  const names = entries.map((e) => e.entryName.replace(/\\/g, '/'))
  // Packs normally keep manifest.json at the zip root, but tolerate archives
  // wrapped in a single top-level folder by detecting the shortest prefix.
  let prefix = ''
  if (!names.includes('manifest.json')) {
    const nested = names.filter((n) => n.endsWith('/manifest.json')).sort((a, b) => a.length - b.length)
    const found = nested[0]
    if (found) prefix = found.slice(0, -'manifest.json'.length)
  }
  const byName = new Map<string, AdmZip.IZipEntry>()
  entries.forEach((entry, i) => {
    const name = names[i]
    if (name !== undefined) byName.set(name, entry)
  })
  return {
    readBinary: (rel) => byName.get(prefix + rel)?.getData() ?? null,
    fileSize: (rel) => byName.get(prefix + rel)?.header.size ?? null,
    listFiles: () =>
      names.filter((n) => n.startsWith(prefix) && n.length > prefix.length).map((n) => n.slice(prefix.length)),
  }
}

function dirReader(dirPath: string): PackReader {
  function walk(dir: string, relBase: string, out: string[]): void {
    if (out.length >= MAX_DIR_FILES) return
    let dirents: fs.Dirent[]
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const d of dirents) {
      if (out.length >= MAX_DIR_FILES) return
      const rel = relBase === '' ? d.name : `${relBase}/${d.name}`
      if (d.isDirectory()) walk(path.join(dir, d.name), rel, out)
      else if (d.isFile()) out.push(rel)
    }
  }
  return {
    readBinary: (rel) => {
      try {
        return fs.readFileSync(safeJoin(dirPath, rel))
      } catch {
        return null
      }
    },
    fileSize: (rel) => {
      try {
        return fs.statSync(safeJoin(dirPath, rel)).size
      } catch {
        return null
      }
    },
    listFiles: () => {
      const out: string[] = []
      walk(dirPath, '', out)
      return out
    },
  }
}

// Keeps relative reads inside the pack directory (rejects ../ escapes,
// absolute paths, and drive/UNC-prefixed names). A plain prefix compare is not
// enough: "pack" is a prefix of the sibling "pack-evil", so the comparison must
// be separator-aware.
function safeJoin(base: string, rel: string): string {
  const resolvedBase = path.resolve(base)
  const resolved = path.resolve(resolvedBase, rel)
  const relative = path.relative(resolvedBase, resolved)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`path escapes pack directory: ${rel}`)
  }
  return resolved
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
