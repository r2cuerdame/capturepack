// History window (GOAL "History"): the entry point for reopening saved
// CapturePack folders. Single-instance (settingsWindow.ts pattern), dark,
// resizable 900x640 min 720x480, Esc closes (renderer window.close()), opened
// from the tray or with --show-history.
//
// The pack listing REUSES the MCP PackStore index (store.entries() +
// openPack()) — no duplicated scanning. This module owns the history:* IPC:
// card metadata, lazy thumbnails (main-side nativeImage resize — the renderer
// never sees file:// paths), lazy folder sizes, lazy search text, and every
// card action except re-edit.
//
// RE-EDIT IS NOT OWNED HERE: history:open-pack calls session.startEditFlow
// when a later stage adds it to session.ts; until then it logs a notice.
import { app, BrowserWindow, clipboard, ipcMain, nativeImage, shell } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import * as fs from 'node:fs'
import { readdir, rename, stat } from 'node:fs/promises'
import * as path from 'node:path'
import { IPC } from '../shared/ipc'
import type {
  HistoryActionResult,
  HistoryAnnotatedState,
  HistoryListResult,
  HistoryPackSummary,
  HistoryRenameResult,
  HistoryRenderStatusPayload,
  ToastCreateZipResult,
} from '../shared/ipc'
import type { Annotation, Settings } from '../shared/types'
import { isRenderInFlight, onRenderStateChange, startAnnotatedRender } from './annotatedRender'
import { createPackZip } from './exporter'
import { createPackStore, openPack } from './mcp/store'
import type { PackHandle, PackStore, RawPackEntry } from './mcp/store'
import { analyzePrompt } from './saveToast'
import { startEditFlow } from './session'

const THUMB_WIDTH = 320
const MAX_PACK_NAME_LENGTH = 180
// Windows-invalid filename characters plus control chars.
const INVALID_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const PACK_EXT = '.capturepack'

let historyWindow: BrowserWindow | null = null
let ipcRegistered = false
let liveSettings: Settings | null = null

// One store for the History window, recreated when outputDir changes (the
// settings GUI mutates the live settings object; History honors it on the
// next access). Independent from the MCP server's store so History works
// with MCP disabled — but it is the same PackStore implementation and index.
let store: PackStore | null = null
let storeDir: string | null = null
let unsubscribeStore: (() => void) | null = null

// Derived-data caches, keyed by pack path and invalidated by packStamp().
const summaryCache = new Map<string, { stamp: number; summary: HistoryPackSummary }>()
const searchTextCache = new Map<string, { stamp: number; text: string }>()
const thumbCache = new Map<string, { stamp: number; dataUrl: string | null }>()
const sizeCache = new Map<string, { stamp: number; bytes: number }>()

/** Call once at startup (after settings load), before the window can open. */
export function registerHistoryIpc(live: Settings): void {
  liveSettings = live
  if (ipcRegistered) return
  ipcRegistered = true

  // EVERY render's lifecycle (fresh-capture saves, re-edit saves, History
  // re-renders) is pushed to the window: after a re-edit save deletes the
  // stale replay_annotated.webm, the card must show "Rendering…" — not an
  // enabled [Retry Render] that would start a second concurrent render.
  onRenderStateChange((dirPath, state) => {
    if (historyWindow !== null && !historyWindow.isDestroyed()) {
      const payload: HistoryRenderStatusPayload = { path: dirPath, state }
      historyWindow.webContents.send(IPC.historyRenderStatus, payload)
    }
  })

  ipcMain.handle(IPC.historyList, (event): HistoryListResult => {
    if (!fromHistory(event)) return { outputDir: '', packs: [] }
    const s = getStore()
    const entries = s.entries()
    pruneCaches(new Set(entries.map((e) => e.path)))
    return { outputDir: s.outputDir, packs: entries.map(safeSummarize) }
  })

  ipcMain.handle(IPC.historyThumb, (event, ref: unknown): string | null => {
    if (!fromHistory(event)) return null
    const entry = entryFor(ref)
    if (entry === null) return null
    const stamp = packStamp(entry)
    const cached = thumbCache.get(entry.path)
    if (cached && cached.stamp === stamp) return cached.dataUrl
    let dataUrl: string | null = null
    try {
      const png = openPack(entry.path, entry.kind, entry.id).readBinary('snapshot.png')
      if (png !== null) {
        let image = nativeImage.createFromBuffer(png)
        if (!image.isEmpty()) {
          if (image.getSize().width > THUMB_WIDTH) image = image.resize({ width: THUMB_WIDTH })
          dataUrl = image.toDataURL()
        }
      }
    } catch {
      dataUrl = null // corrupt snapshot: the card shows the placeholder
    }
    thumbCache.set(entry.path, { stamp, dataUrl })
    return dataUrl
  })

  ipcMain.handle(IPC.historySize, async (event, ref: unknown): Promise<number | null> => {
    if (!fromHistory(event)) return null
    const entry = entryFor(ref)
    if (entry === null) return null
    const stamp = packStamp(entry)
    const cached = sizeCache.get(entry.path)
    if (cached && cached.stamp === stamp) return cached.bytes
    try {
      const bytes = entry.kind === 'zip' ? (await stat(entry.path)).size : await dirSize(entry.path)
      sizeCache.set(entry.path, { stamp, bytes })
      return bytes
    } catch {
      return null
    }
  })

  ipcMain.handle(IPC.historySearchText, (event, ref: unknown): string => {
    if (!fromHistory(event)) return ''
    const entry = entryFor(ref)
    if (entry === null) return ''
    const stamp = packStamp(entry)
    const cached = searchTextCache.get(entry.path)
    if (cached && cached.stamp === stamp) return cached.text
    let text = ''
    try {
      const pack = openPack(entry.path, entry.kind, entry.id)
      const report = pack.report() ?? ''
      const note = pack.manifest()?.note
      const annotationTexts = annotationsOf(pack)
        .map((a) => (typeof a.text === 'string' ? a.text : ''))
        .join('\n')
      text = `${report}\n${typeof note === 'string' ? note : ''}\n${annotationTexts}`.toLowerCase()
    } catch {
      text = ''
    }
    searchTextCache.set(entry.path, { stamp, text })
    return text
  })

  // [Open] — re-edit: loads the pack folder back into the editor
  // (session.startEditFlow). One flow at a time: while a capture or another
  // re-edit is active, startEditFlow returns without opening anything.
  ipcMain.on(IPC.historyOpenPack, (event, ref: unknown) => {
    if (!fromHistory(event)) return
    const entry = entryFor(ref)
    if (entry === null || entry.kind !== 'dir') return
    if (liveSettings !== null) void startEditFlow(entry.path, liveSettings)
  })

  ipcMain.handle(IPC.historyPlay, async (event, ref: unknown): Promise<HistoryActionResult> => {
    if (!fromHistory(event)) return { ok: false, error: 'not the history window' }
    const entry = entryFor(ref)
    if (entry === null) return { ok: false, error: 'pack not found' }
    if (entry.kind !== 'dir') return { ok: false, error: 'extract the zip to play its annotated replay' }
    const file = path.join(entry.path, 'replay_annotated.webm')
    if (!fs.existsSync(file)) return { ok: false, error: 'replay_annotated.webm is not rendered yet' }
    const result = await shell.openPath(file)
    return result === '' ? { ok: true } : { ok: false, error: result }
  })

  ipcMain.handle(IPC.historyCreateZip, async (event, ref: unknown): Promise<ToastCreateZipResult> => {
    if (!fromHistory(event)) return { ok: false, error: 'not the history window' }
    const entry = entryFor(ref)
    if (entry === null) return { ok: false, error: 'pack not found' }
    if (entry.kind !== 'dir') return { ok: false, error: 'this pack is already a zip' }
    try {
      const zipPath = await createPackZip(entry.path)
      return { ok: true, zipPath }
    } catch (err) {
      const error = errorMessage(err)
      console.error('capturepack: history Create ZIP failed:', error)
      return { ok: false, error }
    }
  })

  ipcMain.on(IPC.historyOpenFolder, (event, ref: unknown) => {
    if (!fromHistory(event)) return
    const entry = entryFor(ref)
    if (entry === null) return
    if (entry.kind === 'dir') void shell.openPath(entry.path)
    else shell.showItemInFolder(entry.path)
  })

  ipcMain.on(IPC.historyCopyPath, (event, ref: unknown) => {
    if (!fromHistory(event)) return
    const entry = entryFor(ref)
    if (entry !== null) clipboard.writeText(entry.path)
  })

  ipcMain.on(IPC.historyCopyPrompt, (event, ref: unknown) => {
    if (!fromHistory(event)) return
    const entry = entryFor(ref)
    // Same prompt text as the save toast (FIXED CONTRACT in saveToast.ts).
    if (entry !== null) clipboard.writeText(analyzePrompt(entry.path))
  })

  ipcMain.handle(IPC.historyRerender, (event, ref: unknown): HistoryActionResult => {
    if (!fromHistory(event)) return { ok: false, error: 'not the history window' }
    const entry = entryFor(ref)
    if (entry === null) return { ok: false, error: 'pack not found' }
    if (entry.kind !== 'dir') return { ok: false, error: 'zip packs cannot be re-rendered' }
    return startRerender(entry)
  })

  ipcMain.handle(IPC.historyRename, async (event, ref: unknown, newName: unknown): Promise<HistoryRenameResult> => {
    if (!fromHistory(event)) return { ok: false, error: 'not the history window' }
    const entry = entryFor(ref)
    if (entry === null) return { ok: false, error: 'pack not found' }
    return renamePack(entry, typeof newName === 'string' ? newName : '')
  })

  ipcMain.handle(IPC.historyDelete, async (event, ref: unknown): Promise<HistoryActionResult> => {
    if (!fromHistory(event)) return { ok: false, error: 'not the history window' }
    const entry = entryFor(ref)
    if (entry === null) return { ok: false, error: 'pack not found' }
    try {
      await shell.trashItem(entry.path)
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
    // Zip twin: best-effort — the folder is already gone; a failure here must
    // not report the whole delete as failed.
    if (entry.kind === 'dir') {
      const zip = `${entry.path}${PACK_EXT}`
      if (fs.existsSync(zip)) {
        try {
          await shell.trashItem(zip)
        } catch (err) {
          console.error('capturepack: could not trash zip twin:', errorMessage(err))
        }
      }
    }
    return { ok: true }
  })
}

/** Opens the History window, or focuses the already-open one (single-instance). */
export function openHistoryWindow(): void {
  if (historyWindow !== null && !historyWindow.isDestroyed()) {
    if (historyWindow.isMinimized()) historyWindow.restore()
    historyWindow.focus()
    return
  }
  const win = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 720,
    minHeight: 480,
    autoHideMenuBar: true,
    backgroundColor: '#121216',
    title: 'CapturePack — History',
    show: false,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist', 'preload', 'history.js'),
    },
  })
  win.setMenuBarVisibility(false)
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (historyWindow === win) historyWindow = null
  })
  // Live refresh: the store watcher pushes history:changed; window focus is the
  // backstop for changes a dead watcher missed (the store rescans on access).
  win.on('focus', () => {
    if (!win.isDestroyed()) win.webContents.send(IPC.historyChanged)
  })
  void win.loadFile(path.join(app.getAppPath(), 'dist', 'renderer', 'history', 'history.html'))
  historyWindow = win
}

/** Stops the History pack-store watcher (app quit). */
export function disposeHistory(): void {
  unsubscribeStore?.()
  unsubscribeStore = null
  store?.dispose()
  store = null
  storeDir = null
}

// ---------------------------------------------------------------------------
// Store + listing

function getStore(): PackStore {
  const settings = liveSettings
  if (settings === null) throw new Error('history IPC is not registered')
  if (store !== null && storeDir === settings.outputDir) return store
  unsubscribeStore?.()
  store?.dispose()
  const created = createPackStore({ outputDir: settings.outputDir, watch: true })
  store = created
  storeDir = settings.outputDir
  unsubscribeStore = created.onDidChange(() => {
    if (historyWindow !== null && !historyWindow.isDestroyed()) {
      historyWindow.webContents.send(IPC.historyChanged)
    }
  })
  return created
}

function fromHistory(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return (
    historyWindow !== null &&
    !historyWindow.isDestroyed() &&
    event.sender === historyWindow.webContents
  )
}

// Every action channel takes the pack's absolute path as its ref and only acts
// when that exact path is in the (freshly scanned) index — the renderer can
// never point main at an arbitrary filesystem path.
function entryFor(ref: unknown): RawPackEntry | null {
  if (typeof ref !== 'string' || ref === '') return null
  return getStore().entries().find((e) => e.path === ref) ?? null
}

// Cache stamp for derived data. The directory mtime alone is not enough:
// updatePack rewrites manifest/annotations/report/snapshot IN PLACE, which on
// Windows does not touch the directory entry — so the key files' mtimes are
// folded in (absent files contribute nothing).
function packStamp(entry: RawPackEntry): number {
  if (entry.kind === 'zip') return entry.mtimeMs
  let stamp = entry.mtimeMs
  for (const rel of ['manifest.json', 'annotations.json', 'report.md', 'snapshot.png']) {
    try {
      const m = fs.statSync(path.join(entry.path, rel)).mtimeMs
      if (m > stamp) stamp = m
    } catch {
      // absent file: ignore
    }
  }
  return stamp
}

function annotationsOf(pack: PackHandle): Annotation[] {
  const file = pack.annotations()
  if (!Array.isArray(file?.annotations)) return []
  // Entry-level validation: a hand-edited annotations.json can hold null or
  // non-object elements (valid JSON, so the parse-level array check passes).
  // One such entry must never throw in summarize()/search/render paths.
  return file.annotations.filter((a) => a !== null && typeof a === 'object')
}

// One malformed pack must never blank the whole listing: a summarize() throw
// degrades to a warning card instead of rejecting the history:list invoke.
function safeSummarize(entry: RawPackEntry): HistoryPackSummary {
  try {
    return summarize(entry)
  } catch (err) {
    return {
      id: entry.id,
      path: entry.path,
      kind: entry.kind,
      name: path.basename(entry.path, entry.kind === 'zip' ? PACK_EXT : undefined),
      title: null,
      capturedAt: null,
      app: null,
      hasReplay: false,
      replayDurationMs: null,
      annotationCount: 0,
      numberedCount: 0,
      hasBlur: false,
      annotated: 'none',
      zipTwin: zipTwinPresent(entry),
      warning: `unreadable pack: ${errorMessage(err)}`,
    }
  }
}

function summarize(entry: RawPackEntry): HistoryPackSummary {
  const stamp = packStamp(entry)
  const cached = summaryCache.get(entry.path)
  if (cached && cached.stamp === stamp) {
    // zipTwin lives NEXT TO the pack: its create/delete changes the parent
    // folder, not the pack, so it is re-checked on every listing.
    return { ...cached.summary, zipTwin: zipTwinPresent(entry) }
  }

  const pack = openPack(entry.path, entry.kind, entry.id)
  const manifest = pack.manifest()
  const annotations = annotationsOf(pack)
  // ?. throughout: a malformed-but-parsed manifest may lack any of these.
  const hasReplay = typeof manifest?.media?.replay === 'string'
  const annotated: HistoryAnnotatedState = !hasReplay
    ? 'none'
    : pack.fileSize('replay_annotated.webm') !== null
      ? 'ready'
      : 'missing'
  const replayDurationMs =
    hasReplay && typeof manifest?.media?.replay_duration_ms === 'number'
      ? manifest.media.replay_duration_ms
      : null
  const manifestTitle = typeof manifest?.title === 'string' ? manifest.title.trim() : ''
  const summary: HistoryPackSummary = {
    id: typeof manifest?.id === 'string' ? manifest.id : entry.id,
    path: entry.path,
    kind: entry.kind,
    name: path.basename(entry.path, entry.kind === 'zip' ? PACK_EXT : undefined),
    title: manifestTitle !== '' ? manifestTitle : reportFirstSentence(pack.report()),
    capturedAt: typeof manifest?.created_at === 'string' ? manifest.created_at : null,
    app: typeof manifest?.environment?.app === 'string' ? manifest.environment.app : null,
    hasReplay,
    replayDurationMs,
    annotationCount: annotations.length,
    numberedCount: annotations.filter((a) => a.numbered === true).length,
    hasBlur: annotations.some((a) => a.blur === true),
    annotated,
    zipTwin: zipTwinPresent(entry),
    warning: manifest === null ? (pack.warnings()[0] ?? 'manifest.json missing or malformed') : null,
  }
  summaryCache.set(entry.path, { stamp, summary })
  return summary
}

function zipTwinPresent(entry: RawPackEntry): boolean {
  if (entry.kind === 'zip') return true
  return fs.existsSync(`${entry.path}${PACK_EXT}`)
}

/** Card title fallback (GOAL "History"): report.md's first sentence. */
function reportFirstSentence(report: string | null): string | null {
  if (report === null) return null
  for (const raw of report.split('\n')) {
    const line = raw.replace(/^#+\s*/, '').trim()
    if (line === '' || line.startsWith('-') || line.startsWith('|')) continue
    const sentence = /^(.*?[.!?])\s/.exec(`${line} `)?.[1] ?? line
    return sentence === '' ? null : sentence
  }
  return null
}

function pruneCaches(live: Set<string>): void {
  for (const cache of [summaryCache, searchTextCache, thumbCache, sizeCache]) {
    for (const key of [...cache.keys()]) {
      if (!live.has(key)) cache.delete(key)
    }
  }
}

async function dirSize(dir: string): Promise<number> {
  let total = 0
  let dirents: fs.Dirent[]
  try {
    dirents = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const d of dirents) {
    const full = path.join(dir, d.name)
    try {
      if (d.isDirectory()) total += await dirSize(full)
      else if (d.isFile()) total += (await stat(full)).size
    } catch {
      // vanished mid-walk: skip
    }
  }
  return total
}

// ---------------------------------------------------------------------------
// Actions

// Re-runs the existing background annotated-replay pipeline for one pack:
// replay + annotations read from the folder, result written by
// annotatedRender (file + manifest declaration). Fire-and-forget like the
// save-time render; the terminal state is pushed to the window.
function startRerender(entry: RawPackEntry): HistoryActionResult {
  const settings = liveSettings
  if (settings === null) return { ok: false, error: 'settings unavailable' }
  // A render for this pack is already in flight (e.g. started by a save):
  // join it instead of stacking a second hidden render window — its lifecycle
  // pushes (onRenderStateChange above) drive the card state.
  if (isRenderInFlight(entry.path)) return { ok: true }
  const pack = openPack(entry.path, entry.kind, entry.id)
  const manifest = pack.manifest()
  if (manifest === null) return { ok: false, error: 'manifest.json missing or malformed' }
  const replayRel = manifest.media?.replay
  if (typeof replayRel !== 'string') {
    return { ok: false, error: 'this pack has no replay to render' }
  }
  const replayWebm = pack.readBinary(replayRel)
  if (replayWebm === null) return { ok: false, error: `${replayRel} is missing on disk` }
  const annotationsFile = pack.annotations()
  if (
    annotationsFile === null ||
    typeof annotationsFile.reference_width !== 'number' ||
    typeof annotationsFile.reference_height !== 'number'
  ) {
    return { ok: false, error: 'annotations.json missing or malformed' }
  }
  const replayDurationMs =
    typeof manifest.media.replay_duration_ms === 'number' ? manifest.media.replay_duration_ms : 0
  startAnnotatedRender(
    { id: manifest.id, dirPath: entry.path },
    {
      replayWebm,
      annotations: annotationsOf(pack),
      width: annotationsFile.reference_width,
      height: annotationsFile.reference_height,
      fps: settings.fps,
      replayDurationMs,
    },
    // Terminal state reaches the window via onRenderStateChange (registered in
    // registerHistoryIpc) — 'failed' leaves the disk unchanged (no watcher
    // event), so that push is what drops "Rendering…" back to [Retry].
    () => {},
  )
  return { ok: true }
}

async function renamePack(entry: RawPackEntry, rawName: string): Promise<HistoryRenameResult> {
  const newName = rawName.trim()
  const invalid = validatePackName(newName)
  if (invalid !== null) return { ok: false, error: invalid }

  const parent = path.dirname(entry.path)
  const currentName = path.basename(entry.path, entry.kind === 'zip' ? PACK_EXT : undefined)
  if (newName === currentName) return { ok: true, path: entry.path }

  const target =
    entry.kind === 'zip' ? path.join(parent, `${newName}${PACK_EXT}`) : path.join(parent, newName)
  // Case-only renames are legal on Windows; anything else must not overwrite.
  const caseOnly = target.toLowerCase() === entry.path.toLowerCase()
  if (!caseOnly && (fs.existsSync(target) || (entry.kind === 'dir' && fs.existsSync(`${target}${PACK_EXT}`)))) {
    return { ok: false, error: 'A file or folder with that name already exists' }
  }
  try {
    await rename(entry.path, target)
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  }
  // The zip twin follows the folder (contract). Best-effort: the folder rename
  // already succeeded and must not be reported as failed.
  if (entry.kind === 'dir') {
    const oldZip = `${entry.path}${PACK_EXT}`
    if (fs.existsSync(oldZip)) {
      try {
        await rename(oldZip, `${target}${PACK_EXT}`)
      } catch (err) {
        console.error('capturepack: could not rename zip twin:', errorMessage(err))
      }
    }
  }
  return { ok: true, path: target }
}

function validatePackName(name: string): string | null {
  if (name === '') return 'Name cannot be empty'
  if (name.length > MAX_PACK_NAME_LENGTH) return `Name is too long (max ${MAX_PACK_NAME_LENGTH} characters)`
  if (INVALID_NAME_CHARS.test(name)) return 'Name contains invalid characters: < > : " / \\ | ? *'
  if (RESERVED_NAMES.test(name)) return 'That name is reserved on Windows'
  if (name.endsWith('.') || name !== name.trimEnd()) return 'Name cannot end with a dot or space'
  if (name === '.' || name === '..') return 'Name is not allowed'
  return null
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
