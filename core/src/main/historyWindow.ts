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
import type { TranslateFn } from '../shared/i18n'
import type {
  HistoryActionResult,
  HistoryAnnotatedState,
  HistoryCreateShareResult,
  HistoryCreateZipResult,
  HistoryListResult,
  HistoryPackSummary,
  HistoryRenameResult,
  HistoryRenderStatusPayload,
  HistorySharePlan,
  HistorySharePlanResult,
  StorageUsage,
} from '../shared/ipc'
import { DEFAULT_CAPTURE_HOTKEY } from '../shared/types'
import type { Annotation, Settings } from '../shared/types'
import { captureKindOf } from '../shared/captureMedia'
import { isRenderInFlight, onRenderStateChange, startAnnotatedRender } from './annotatedRender'
import { createPackZip, replayMimeType } from './exporter'
import { packDocLanguage, uiLanguage, uiT } from './locale'
import { createPackStore, openPack } from './mcp/store'
import type { PackHandle, PackStore, RawPackEntry } from './mcp/store'
import {
  archiveStem,
  packArchiveExt,
  shareBundlePath,
  siblingArchive,
  siblingShareBundle,
} from './packArchive'
import { beginPackOperation } from './packOperations'
import {
  createShareBundle,
  planShareBundle,
  ShareBundleError,
  type ShareBundlePlan,
} from './shareBundle'
import { analyzePrompt } from './saveToast'
import { startEditFlow } from './session'
import { openSettingsWindow } from './settingsWindow'
import { invalidateStorageUsage, storageUsage } from './storage'
import { copyTextToClipboard } from './clipboard'

const THUMB_WIDTH = 320
const MAX_PACK_NAME_LENGTH = 180
const HISTORY_STARTUP_TIMEOUT_MS = 10_000
const SHARE_PREVIEW_WIDTH = 240
const MAX_SHARE_PREVIEWS = 12
// Windows-invalid filename characters plus control chars.
const INVALID_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
// What "Create ZIP" writes now, and so what a renamed pack's twin falls back to
// when its own suffix is unrecognisable. `.capturepack` is still recognised for
// packs zipped by earlier versions — see packArchive.ts, which owns that list
// now, and the note in exporter.createPackZip on why the private extension had
// to go.
const PACK_EXT = '.zip'

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
  onRenderStateChange((dirPath, state, ratio) => {
    if (historyWindow !== null && !historyWindow.isDestroyed()) {
      const payload: HistoryRenderStatusPayload = {
        path: dirPath,
        state,
        ...(ratio === undefined ? {} : { ratio }),
      }
      historyWindow.webContents.send(IPC.historyRenderStatus, payload)
    }
  })

  ipcMain.handle(IPC.historyList, (event): HistoryListResult => {
    if (!fromHistory(event)) {
      return { outputDir: '', packs: [], uiLanguage: 'en', captureHotkey: DEFAULT_CAPTURE_HOTKEY }
    }
    const s = getStore()
    const entries = s.entries()
    pruneCaches(new Set(entries.map((e) => e.path)))
    return {
      outputDir: s.outputDir,
      packs: entries.map(safeSummarize),
      uiLanguage: uiLanguage(live),
      captureHotkey: live.captureHotkey,
    }
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

  // The header's usage bar (issue #48). NOT summed from the per-card sizes
  // above: those arrive one lazy invoke at a time as cards scroll into view, so
  // a total built from them would climb while the user reads it and would be
  // wrong for any pack they never scrolled to. storage.ts answers for the whole
  // folder at once, from the same cached snapshot Settings draws its bar from.
  ipcMain.handle(IPC.historyUsage, (event): StorageUsage | null => {
    if (!fromHistory(event)) return null
    return liveSettings === null ? null : storageUsage(liveSettings)
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

  // [Edit] — re-edit: loads the pack folder back into the editor. This is an
  // invoke, not fire-and-forget: a busy flow used to make the button appear to
  // do nothing, and History stayed in front even after an editor was accepted.
  // The renderer closes History only after this returns ok.
  ipcMain.handle(IPC.historyOpenPack, (event, ref: unknown): HistoryActionResult => {
    if (!fromHistory(event)) return { ok: false, error: 'not the history window' }
    const entry = entryFor(ref)
    const t = uiT(live)
    if (entry === null) return { ok: false, error: t('history.errPackNotFound') }
    if (entry.kind !== 'dir') return { ok: false, error: t('history.editZipTooltip') }
    if (liveSettings === null) return { ok: false, error: t('history.couldNotEdit') }
    return startEditFlow(entry.path, liveSettings)
      ? { ok: true }
      : { ok: false, error: t('history.errFlowBusy') }
  })

  ipcMain.handle(IPC.historyPlay, async (event, ref: unknown): Promise<HistoryActionResult> => {
    if (!fromHistory(event)) return { ok: false, error: 'not the history window' }
    const entry = entryFor(ref)
    const t = uiT(live)
    if (entry === null) return { ok: false, error: t('history.errPackNotFound') }
    if (entry.kind !== 'dir') return { ok: false, error: t('history.errZipPlay') }
    const file = path.join(entry.path, 'replay_annotated.webm')
    if (!fs.existsSync(file)) return { ok: false, error: t('history.errNotRendered') }
    const result = await shell.openPath(file)
    return result === '' ? { ok: true } : { ok: false, error: result }
  })

  ipcMain.handle(IPC.historyCreateZip, async (event, ref: unknown): Promise<HistoryCreateZipResult> => {
    if (!fromHistory(event)) return { ok: false, error: 'not the history window' }
    const entry = entryFor(ref)
    const t = uiT(live)
    if (entry === null) return { ok: false, error: t('history.errPackNotFound') }
    if (entry.kind !== 'dir') return { ok: false, error: t('history.errAlreadyZip') }
    const release = beginPackOperation(entry.path)
    if (release === null) return { ok: false, error: t('history.shareErrBusy') }
    try {
      const zipPath = await createPackZip(entry.path)
      invalidateStorageUsage()
      return { ok: true, zipPath }
    } catch (err) {
      const error = errorMessage(err)
      console.error('capturepack: history Create ZIP failed:', error)
      return { ok: false, error }
    } finally {
      release()
    }
  })

  ipcMain.handle(
    IPC.historyPlanShare,
    async (event, ref: unknown): Promise<HistorySharePlanResult> => {
      if (!fromHistory(event)) return { ok: false, error: 'not the history window' }
      const entry = entryFor(ref)
      const t = uiT(live)
      if (entry === null) return { ok: false, error: t('history.errPackNotFound') }
      if (entry.kind !== 'dir') return { ok: false, error: t('history.shareErrFolderOnly') }
      if (isRenderInFlight(entry.path)) {
        return { ok: false, error: t('history.shareErrNotReady') }
      }
      const release = beginPackOperation(entry.path)
      if (release === null) return { ok: false, error: t('history.shareErrBusy') }
      try {
        if (isRenderInFlight(entry.path)) {
          return { ok: false, error: t('history.shareErrNotReady') }
        }
        return { ok: true, plan: sharePlanForHistory(await planShareBundle(entry.path)) }
      } catch (err) {
        return { ok: false, error: shareErrorMessage(err, t) }
      } finally {
        release()
      }
    },
  )

  ipcMain.handle(
    IPC.historyCreateShare,
    async (event, ref: unknown, revision: unknown): Promise<HistoryCreateShareResult> => {
      if (!fromHistory(event)) return { ok: false, error: 'not the history window' }
      const entry = entryFor(ref)
      const t = uiT(live)
      if (entry === null) return { ok: false, error: t('history.errPackNotFound') }
      if (entry.kind !== 'dir') return { ok: false, error: t('history.shareErrFolderOnly') }
      if (typeof revision !== 'string' || revision === '') {
        return { ok: false, error: t('history.shareErrReviewAgain') }
      }
      if (isRenderInFlight(entry.path)) {
        return { ok: false, error: t('history.shareErrNotReady') }
      }
      const release = beginPackOperation(entry.path)
      if (release === null) return { ok: false, error: t('history.shareErrBusy') }
      try {
        if (isRenderInFlight(entry.path)) {
          return { ok: false, error: t('history.shareErrNotReady') }
        }
        const result = await createShareBundle(entry.path, revision)
        invalidateStorageUsage()
        return { ok: true, bundlePath: result.zipPath }
      } catch (err) {
        return { ok: false, error: shareErrorMessage(err, t) }
      } finally {
        release()
      }
    },
  )

  ipcMain.on(IPC.historyOpenFolder, (event, ref: unknown) => {
    if (!fromHistory(event)) return
    const entry = entryFor(ref)
    if (entry === null) return
    if (entry.kind === 'dir') void shell.openPath(entry.path)
    else shell.showItemInFolder(entry.path)
  })

  // No pack ref: this one is about the app, not about a row.
  ipcMain.on(IPC.historyOpenSettings, (event) => {
    if (!fromHistory(event)) return
    openSettingsWindow()
  })

  ipcMain.on(IPC.historyCopyPath, (event, ref: unknown) => {
    if (!fromHistory(event)) return
    const entry = entryFor(ref)
    if (entry !== null) clipboard.writeText(entry.path)
  })

  ipcMain.handle(IPC.historyCopyPrompt, async (event, ref: unknown): Promise<boolean> => {
    if (!fromHistory(event)) return false
    const entry = entryFor(ref)
    // Same prompt text as the save toast (FIXED CONTRACT in saveToast.ts).
    if (entry === null) return false
    return copyTextToClipboard(analyzePrompt(entry.path))
  })

  ipcMain.handle(IPC.historyRerender, (event, ref: unknown): HistoryActionResult => {
    if (!fromHistory(event)) return { ok: false, error: 'not the history window' }
    const entry = entryFor(ref)
    if (entry === null) return { ok: false, error: uiT(live)('history.errPackNotFound') }
    if (entry.kind !== 'dir') return { ok: false, error: uiT(live)('history.errZipRerender') }
    return startRerender(entry)
  })

  ipcMain.handle(IPC.historyRename, async (event, ref: unknown, newName: unknown): Promise<HistoryRenameResult> => {
    if (!fromHistory(event)) return { ok: false, error: 'not the history window' }
    const entry = entryFor(ref)
    const t = uiT(live)
    if (entry === null) return { ok: false, error: t('history.errPackNotFound') }
    const release = beginPackOperation(entry.path)
    if (release === null) return { ok: false, error: t('history.shareErrBusy') }
    try {
      const result = await renamePack(entry, typeof newName === 'string' ? newName : '')
      if (result.ok) invalidateStorageUsage()
      return result
    } finally {
      release()
    }
  })

  ipcMain.handle(IPC.historyDelete, async (event, ref: unknown): Promise<HistoryActionResult> => {
    if (!fromHistory(event)) return { ok: false, error: 'not the history window' }
    const entry = entryFor(ref)
    const t = uiT(live)
    if (entry === null) return { ok: false, error: t('history.errPackNotFound') }
    const release = beginPackOperation(entry.path)
    if (release === null) return { ok: false, error: t('history.shareErrBusy') }
    let changed = false
    try {
      // Managed copies go first. If one is locked or otherwise cannot be
      // trashed, keep the pack indexed so the remaining Share Copy can never
      // become an invisible orphan after a superficially successful delete.
      if (entry.kind === 'dir') {
        const copies = [shareTwinPath(entry), siblingArchive(entry.path)].filter(
          (candidate): candidate is string => candidate !== null,
        )
        for (const copy of copies) {
          try {
            await shell.trashItem(copy)
            changed = true
          } catch (err) {
            return { ok: false, error: errorMessage(err) }
          }
        }
      }
      try {
        await shell.trashItem(entry.path)
        changed = true
      } catch (err) {
        return { ok: false, error: errorMessage(err) }
      }
      return { ok: true }
    } finally {
      if (changed) invalidateStorageUsage()
      release()
    }
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
    // Pre-load placeholder only: the renderer document title (localized via
    // data-i18n) replaces it as soon as the page loads.
    title: liveSettings !== null ? uiT(liveSettings)('history.windowTitle') : 'CapturePack',
    show: false,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist', 'preload', 'history.js'),
    },
  })
  // Publish ownership before loading. Any load/crash cleanup below can then
  // clear the same singleton reference through the normal `closed` path.
  historyWindow = win
  win.setMenuBarVisibility(false)
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) {
      win.show()
      win.focus()
    }
  })
  win.on('closed', () => {
    if (historyWindow === win) historyWindow = null
  })
  // Live refresh: the store watcher pushes history:changed; window focus is the
  // backstop for changes a dead watcher missed (the store rescans on access).
  win.on('focus', () => {
    if (!win.isDestroyed()) win.webContents.send(IPC.historyChanged)
  })

  // Like the editor, History starts hidden. A failed load or a renderer that
  // never paints must not occupy the singleton forever while every later click
  // merely focuses an invisible window.
  let startupTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    startupTimer = null
    if (win.isDestroyed() || win.isVisible()) return
    console.error(
      `capturepack: History did not become visible within ${HISTORY_STARTUP_TIMEOUT_MS} ms — closing it`,
    )
    win.destroy()
  }, HISTORY_STARTUP_TIMEOUT_MS)
  startupTimer.unref()
  const clearStartupTimer = (): void => {
    if (startupTimer === null) return
    clearTimeout(startupTimer)
    startupTimer = null
  }
  win.once('show', clearStartupTimer)
  win.once('closed', clearStartupTimer)
  win.webContents.once('render-process-gone', (_event, details) => {
    console.error(`capturepack: History renderer exited (${details.reason})`)
    if (!win.isDestroyed()) win.destroy()
  })
  void win
    .loadFile(path.join(app.getAppPath(), 'dist', 'renderer', 'history', 'history.html'))
    .catch((err: unknown) => {
      console.error('capturepack: loading History failed:', errorMessage(err))
      if (!win.isDestroyed()) win.destroy()
    })
}

/** t() for the current UI language (English before IPC registration). */
function liveT(): ReturnType<typeof uiT> {
  return uiT(liveSettings ?? ({ language: 'system', packLanguage: 'ui' } as Settings))
}

/** Nudges an open History window to re-list (e.g. after a language change —
 * the list result carries the new uiLanguage, so the window re-renders). */
export function notifyHistoryChanged(): void {
  if (historyWindow !== null && !historyWindow.isDestroyed()) {
    historyWindow.webContents.send(IPC.historyChanged)
  }
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
      name: entry.kind === 'zip' ? archiveStem(entry.path) : path.basename(entry.path),
      title: null,
      capturedAt: null,
      app: null,
      captureKind: 'unknown',
      hasReplay: false,
      replayDurationMs: null,
      annotationCount: 0,
      numberedCount: 0,
      hasBlur: false,
      annotated: 'none',
      zipTwin: zipTwinPresent(entry),
      shareTwin: shareTwinPresent(entry),
      warning: liveT()('history.errUnreadablePack', { error: errorMessage(err) }),
    }
  }
}

function summarize(entry: RawPackEntry): HistoryPackSummary {
  const stamp = packStamp(entry)
  const cached = summaryCache.get(entry.path)
  if (cached && cached.stamp === stamp) {
    // Managed copies live NEXT TO the pack: their create/delete changes the
    // parent folder, not the pack, so both are re-checked on every listing.
    return {
      ...cached.summary,
      zipTwin: zipTwinPresent(entry),
      shareTwin: shareTwinPresent(entry),
    }
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
    name: entry.kind === 'zip' ? archiveStem(entry.path) : path.basename(entry.path),
    title: manifestTitle !== '' ? manifestTitle : reportFirstSentence(pack.report()),
    capturedAt: typeof manifest?.created_at === 'string' ? manifest.created_at : null,
    app: typeof manifest?.environment?.app === 'string' ? manifest.environment.app : null,
    captureKind: manifest === null ? 'unknown' : captureKindOf(manifest),
    hasReplay,
    replayDurationMs,
    annotationCount: annotations.length,
    numberedCount: annotations.filter((a) => a.numbered === true).length,
    hasBlur: annotations.some((a) => a.blur === true),
    annotated,
    zipTwin: zipTwinPresent(entry),
    shareTwin: shareTwinPresent(entry),
    // NOTE: cached by stamp — after a language change an unchanged malformed
    // pack keeps its old-language warning until it changes on disk (harmless).
    warning: manifest === null ? (pack.warnings()[0] ?? liveT()('history.errManifestBad')) : null,
  }
  summaryCache.set(entry.path, { stamp, summary })
  return summary
}

function zipTwinPresent(entry: RawPackEntry): boolean {
  if (entry.kind === 'zip') return true
  return siblingArchive(entry.path) !== null
}

function shareTwinPath(entry: RawPackEntry): string | null {
  if (entry.kind !== 'dir') return null
  return siblingShareBundle(entry.path)
}

function shareTwinPresent(entry: RawPackEntry): boolean {
  return shareTwinPath(entry) !== null
}

function sharePlanForHistory(plan: ShareBundlePlan): HistorySharePlan {
  const stills = plan.entries.filter((entry) => entry.kind === 'annotated-still')
  const previews = selectSharePreviews(stills)
    .map((entry) => {
      let image = nativeImage.createFromPath(entry.sourcePath)
      if (image.isEmpty()) return null
      if (image.getSize().width > SHARE_PREVIEW_WIDTH) {
        image = image.resize({ width: SHARE_PREVIEW_WIDTH })
      }
      return image.toDataURL()
    })
    .filter((value): value is string => value !== null)
  const lanes = new Set(plan.entries.map((entry) => String(entry.display ?? 'capture')))
  return {
    revision: plan.revision,
    outputName: plan.outputName,
    previewDataUrls: previews,
    previewCount: previews.length,
    stillCount: stills.length,
    displayCount: lanes.size,
    hasBlur: plan.hasBlur,
    visibleLabels: plan.visibleLabels,
    blockers: plan.blockers,
  }
}

function selectSharePreviews(
  stills: ShareBundlePlan['entries'],
): ShareBundlePlan['entries'] {
  if (stills.length <= MAX_SHARE_PREVIEWS) return stills
  const selected = new Map<string, ShareBundlePlan['entries'][number]>()
  // First show one still from every lane, then spread the remaining slots over
  // the whole ordered set. A secondary display must not disappear merely
  // because the focused display produced many annotation states.
  for (const still of stills) {
    const lane = String(still.display ?? 'capture')
    if (![...selected.values()].some((entry) => String(entry.display ?? 'capture') === lane)) {
      selected.set(still.archivePath, still)
      if (selected.size >= MAX_SHARE_PREVIEWS) return [...selected.values()]
    }
  }
  for (let slot = 0; slot < MAX_SHARE_PREVIEWS && selected.size < MAX_SHARE_PREVIEWS; slot += 1) {
    const index = Math.round((slot * (stills.length - 1)) / Math.max(1, MAX_SHARE_PREVIEWS - 1))
    const still = stills[index]
    if (still !== undefined) selected.set(still.archivePath, still)
  }
  return [...selected.values()].slice(0, MAX_SHARE_PREVIEWS)
}

function shareErrorMessage(err: unknown, t: TranslateFn): string {
  if (!(err instanceof ShareBundleError)) return errorMessage(err)
  switch (err.code) {
    case 'invalid-pack':
      return t('history.shareErrInvalidPack')
    case 'invalid-annotations':
      return t('history.shareErrInvalidAnnotations')
    case 'unsafe-media-path':
      return t('history.shareErrUnsafeMedia')
    case 'derived-media-missing':
    case 'derived-media-not-ready':
      return t('history.shareErrNotReady')
    case 'pack-changed':
      return t('history.shareErrChanged')
    case 'blocked':
      return t('history.shareErrBlurLabel')
    case 'output-conflict':
      return t('history.shareErrOutputConflict')
  }
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
  const t = uiT(settings)
  if (manifest === null) return { ok: false, error: t('history.errManifestBad') }
  const replayRel = manifest.media?.replay
  if (typeof replayRel !== 'string') {
    return { ok: false, error: t('history.errNoReplayRender') }
  }
  const replayWebm = pack.readBinary(replayRel)
  if (replayWebm === null) return { ok: false, error: t('history.errFileMissing', { file: replayRel }) }
  const annotationsFile = pack.annotations()
  if (
    annotationsFile === null ||
    typeof annotationsFile.reference_width !== 'number' ||
    typeof annotationsFile.reference_height !== 'number'
  ) {
    return { ok: false, error: t('history.errAnnotationsBad') }
  }
  const replayDurationMs =
    typeof manifest.media.replay_duration_ms === 'number' ? manifest.media.replay_duration_ms : 0
  startAnnotatedRender(
    { id: manifest.id, dirPath: entry.path },
    {
      replayWebm,
      replayMimeType: replayMimeType(replayRel),
      annotations: annotationsOf(pack),
      width: annotationsFile.reference_width,
      height: annotationsFile.reference_height,
      fps: settings.fps,
      replayDurationMs,
      // The render regenerates the pack documents from what it declared.
      docLanguage: packDocLanguage(settings),
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
  const currentName = entry.kind === 'zip' ? archiveStem(entry.path) : path.basename(entry.path)
  if (newName === currentName) return { ok: true, path: entry.path }

  const target =
    entry.kind === 'zip'
      ? path.join(parent, `${newName}${packArchiveExt(entry.path) ?? PACK_EXT}`)
      : path.join(parent, newName)
  // Case-only renames are legal on Windows; anything else must not overwrite.
  const caseOnly = target.toLowerCase() === entry.path.toLowerCase()
  if (
    !caseOnly &&
    (fs.existsSync(target) ||
      (entry.kind === 'dir' &&
        (siblingArchive(target) !== null || fs.existsSync(shareBundlePath(target)))))
  ) {
    return { ok: false, error: liveT()('history.errNameExists') }
  }
  // Resolve companion paths before the folder moves. They are siblings rather
  // than children, but their names are defined by the old folder path.
  const oldZip = entry.kind === 'dir' ? siblingArchive(entry.path) : null
  const oldShare = entry.kind === 'dir' ? shareTwinPath(entry) : null
  const companionMoves: Array<{ from: string; to: string }> = []
  if (oldZip !== null) {
    // Keeps the suffix it already had: renaming a pack must not also silently
    // convert an older `.capturepack` archive into a `.zip`.
    companionMoves.push({
      from: oldZip,
      to: `${target}${packArchiveExt(oldZip) ?? PACK_EXT}`,
    })
  }
  if (oldShare !== null) {
    companionMoves.push({ from: oldShare, to: shareBundlePath(target) })
  }

  // Companions move first. If any step fails, every completed move is rolled
  // back while the pack is still indexed at its original path. The pack itself
  // moves last, so success can never strand an unindexed Share Copy.
  const moved: Array<{ from: string; to: string }> = []
  try {
    for (const move of companionMoves) {
      await rename(move.from, move.to)
      moved.push(move)
    }
    await rename(entry.path, target)
    return { ok: true, path: target }
  } catch (err) {
    const rollbackErrors: string[] = []
    for (const move of [...moved].reverse()) {
      try {
        await rename(move.to, move.from)
      } catch (rollbackErr) {
        rollbackErrors.push(errorMessage(rollbackErr))
      }
    }
    const failure = errorMessage(err)
    return {
      ok: false,
      error:
        rollbackErrors.length === 0
          ? failure
          : `${failure} (rollback failed: ${rollbackErrors.join('; ')})`,
    }
  }
}

function validatePackName(name: string): string | null {
  const t = liveT()
  if (name === '') return t('history.errNameEmpty')
  if (name.length > MAX_PACK_NAME_LENGTH) return t('history.errNameTooLong', { max: MAX_PACK_NAME_LENGTH })
  if (INVALID_NAME_CHARS.test(name)) return t('history.errNameInvalid')
  if (RESERVED_NAMES.test(name)) return t('history.errNameReserved')
  if (name.endsWith('.') || name !== name.trimEnd()) return t('history.errNameDotSpace')
  if (name === '.' || name === '..') return t('history.errNameNotAllowed')
  return null
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
