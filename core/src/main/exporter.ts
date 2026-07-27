// Writes the CapturePack FOLDER (format_version 0.1.0, SPEC §3 "folder first").
// The folder is the save unit; the .capturepack ZIP is created only on demand
// by the save toast's [Create ZIP] button (createPackZip).

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { release } from 'node:os'
import { dirname, join } from 'node:path'
import { app, screen } from 'electron'
import AdmZip from 'adm-zip'
import type { Language } from '../shared/i18n'
import type {
  Annotation,
  AnnotationsFile,
  Manifest,
  TimelineFile,
} from '../shared/types'
import { FORMAT_NAME, FORMAT_VERSION } from '../shared/types'
import { buildReport } from './report'
import { buildReadme, buildSkills, SKILLS_FILES } from './packdocs'

export interface ExportInput {
  // The exported snapshot frame. Blur is NEVER burned in (SPEC §9) — this is
  // original pixels of the chosen frame (native snapshot or scrubbed replay frame).
  snapshotPng: Buffer
  width: number
  height: number
  // Capture trigger instant — manifest.created_at is the capture, not the save
  capturedAt: Date
  replayWebm: Buffer | null
  replayDurationMs: number
  annotations: Annotation[]
  title: string
  note: string
  // Replay position (ms) of the exported snapshot frame; null = the capture instant
  snapshotTMs: number | null
  // Manifest media.trim_offset_ms (GOAL "Replay Trim"): the in-point (ms) in
  // the original recording that replayWebm was trimmed from — provenance only.
  // Absent/null = the replay was never trimmed. On re-edit this carries the
  // LOADED manifest's value through (re-edit can never trim further).
  trimOffsetMs?: number | null
  timeline: TimelineFile
  // Plugin declarations carried through from a loaded manifest on re-edit
  // (external packs — the current exporter never writes its own). Absent = [].
  plugins?: Manifest['plugins']
  copyToClipboard: boolean
  // Pack document language (GOAL i18n, packLanguage setting): the language the
  // regenerated README/report/skills templates are written in. Absent = en.
  docLanguage?: Language
}

export interface ManifestInput {
  id: string
  createdAt: Date
  generatorVersion: string
  title: string
  note: string
  osVersion: string
  screens: Array<{ width: number; height: number; scale: number }>
  hasReplay: boolean
  replayDurationMs: number
  snapshotTMs: number | null
  // media.trim_offset_ms (provenance only, GOAL "Replay Trim"); absent/null =
  // never trimmed. Only written alongside a replay.
  trimOffsetMs?: number | null
  // Carried through from a loaded manifest on re-edit; absent = [] (fresh packs).
  plugins?: Manifest['plugins']
}

export function buildManifest(input: ManifestInput): Manifest {
  const manifest: Manifest = {
    format: FORMAT_NAME,
    format_version: FORMAT_VERSION,
    id: input.id,
    created_at: isoWithOffset(input.createdAt),
    generator: { name: 'capturepack', version: input.generatorVersion },
    environment: {
      os: 'windows',
      os_version: input.osVersion,
      screens: input.screens,
    },
    media: {
      snapshot: 'snapshot.png',
      replay: input.hasReplay ? 'replay.webm' : null,
      // media.replay_annotated is added by setManifestReplayAnnotated() once
      // the background render finishes — absent while not yet rendered and
      // always absent when replay is null (SPEC §5).
    },
    plugins: input.plugins ?? [],
  }
  const title = input.title.trim()
  if (title !== '') manifest.title = title
  const note = input.note.trim()
  if (note !== '') manifest.note = note
  if (input.hasReplay) {
    manifest.media.replay_duration_ms = input.replayDurationMs
    // snapshot_t_ms is only written alongside a replay (SPEC §5.3), clamped to
    // replay_duration_ms: the editor's scrub position lives on the parsed
    // video clock, which can run slightly past the recorder's wall clock.
    if (input.snapshotTMs !== null) {
      manifest.media.snapshot_t_ms = Math.min(
        Math.max(0, Math.round(input.snapshotTMs)),
        input.replayDurationMs,
      )
    }
    // trim_offset_ms is provenance only (GOAL "Replay Trim"): where in the
    // original recording the trimmed replay begins. Every other time in the
    // pack is already on the trimmed clock. Never written without a replay.
    const trimOffsetMs = input.trimOffsetMs
    if (typeof trimOffsetMs === 'number' && trimOffsetMs >= 0) {
      manifest.media.trim_offset_ms = Math.round(trimOffsetMs)
    }
  }
  return manifest
}

/** Local time as ISO 8601 with the machine's UTC offset, e.g. 2026-07-27T14:03:09+09:00. */
export function isoWithOffset(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const offsetMin = -date.getTimezoneOffset()
  const sign = offsetMin < 0 ? '-' : '+'
  const absMin = Math.abs(offsetMin)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(absMin / 60))}:${pad(absMin % 60)}`
  )
}

/** Identity of a pack folder saved at capture time; finalizing updates it in place. */
export interface PackHandle {
  id: string
  dirPath: string
}

export interface InitialSaveInput {
  snapshotPng: Buffer
  width: number
  height: number
  capturedAt: Date
  replayWebm: Buffer | null
  replayDurationMs: number
  timeline: TimelineFile
  outputDir: string
  // Pack document language for the save-first docs (same as ExportInput's).
  docLanguage?: Language
}

/**
 * Save-first: writes the raw capture the moment the hotkey fires, before the
 * editor opens (GOAL "Save-first capture"). A crash or cancel never loses a
 * capture. Silent: no toast, no clipboard — that happens on finalize.
 * README/skills are generated from the (still annotation-less) data so the
 * folder is a complete, honest pack even if the editor never finishes.
 */
export async function savePack(input: InitialSaveInput): Promise<PackHandle> {
  const id = randomUUID()
  const manifest = buildManifest({
    id,
    createdAt: input.capturedAt,
    generatorVersion: app.getVersion(),
    title: '',
    note: '',
    osVersion: release(),
    screens: physicalScreens(),
    hasReplay: input.replayWebm !== null,
    replayDurationMs: input.replayDurationMs,
    snapshotTMs: null,
  })
  const annotationsFile: AnnotationsFile = {
    reference_width: input.width,
    reference_height: input.height,
    annotations: [],
  }

  // Layout (GOAL "Output layout — Folder First"): the pack folder is the save
  // unit — {outputDir}/CapturePack_YYYY-MM-DD_HHMMSS/ with collision suffix -2.
  // NO automatic zip: .capturepack is on-demand distribution (createPackZip).
  await mkdir(input.outputDir, { recursive: true })
  const dirPath = uniquePackDir(input.outputDir, input.capturedAt)
  try {
    await mkdir(dirPath)
    await writePackFiles(dirPath, manifest, annotationsFile, input.timeline, input.docLanguage)
    await writeFile(join(dirPath, 'snapshot.png'), input.snapshotPng)
    if (input.replayWebm !== null) {
      await writeFile(join(dirPath, 'replay.webm'), input.replayWebm)
    }
    return { id, dirPath }
  } catch (err) {
    // Never leave a half-written pack behind.
    await rm(dirPath, { recursive: true, force: true })
    throw err
  }
}

export interface UpdatePackOptions {
  // Re-edit mode (GOAL "History — Save after re-edit"): replay.webm is NEVER
  // rewritten, re-encoded, or deleted — the file already on disk stays the
  // original evidence. input.replayWebm is ignored (pass null); the manifest's
  // replay declaration reflects the file actually present in the folder.
  keepReplay?: boolean
}

/**
 * Finalize after annotation: updates the save-first folder in place (same id,
 * same path). Shows no UI itself — the caller shows the save toast and starts
 * the background annotated-replay render.
 */
export async function updatePack(
  handle: PackHandle,
  input: ExportInput,
  options: UpdatePackOptions = {},
): Promise<string> {
  const keepReplay = options.keepReplay === true
  const hasReplay = keepReplay
    ? existsSync(join(handle.dirPath, 'replay.webm'))
    : input.replayWebm !== null
  const manifest = buildManifest({
    id: handle.id,
    createdAt: input.capturedAt,
    generatorVersion: app.getVersion(),
    title: input.title,
    note: input.note,
    osVersion: release(),
    screens: physicalScreens(),
    hasReplay,
    replayDurationMs: input.replayDurationMs,
    snapshotTMs: input.snapshotTMs,
    trimOffsetMs: input.trimOffsetMs,
    plugins: input.plugins,
  })
  const annotationsFile: AnnotationsFile = {
    reference_width: input.width,
    reference_height: input.height,
    annotations: input.annotations,
  }
  // Save time (not capturedAt) — this event records when the pack was written.
  const timeline = withExportEvent(input.timeline, new Date())

  await writePackFiles(handle.dirPath, manifest, annotationsFile, timeline, input.docLanguage)
  await writeFile(join(handle.dirPath, 'snapshot.png'), input.snapshotPng)
  // A stale annotated replay must never outlive the annotations that produced
  // it: the background render rewrites it (and re-declares it in the manifest)
  // after this save.
  await rm(join(handle.dirPath, 'replay_annotated.webm'), { force: true })
  if (!keepReplay) {
    if (input.replayWebm === null) {
      // The user excluded the replay at save time (e.g. privacy).
      await rm(join(handle.dirPath, 'replay.webm'), { force: true })
    } else {
      await writeFile(join(handle.dirPath, 'replay.webm'), input.replayWebm)
    }
  }

  if (input.copyToClipboard) copyFolderToClipboard(handle.dirPath)
  return handle.dirPath
}

/**
 * Save As New CapturePack (GOAL "History — Save after re-edit"): writes the
 * edited state into a NEW folder (CapturePack_<now>, collision-suffixed) with
 * a NEW manifest id, copying replay.webm from the source pack byte-for-byte.
 * The original folder is never touched. Docs are regenerated from the edited
 * data; replay_annotated is NOT copied (it is stale relative to the edited
 * annotations — the caller starts a background render for the new folder).
 */
export async function saveAsNewPack(sourceDir: string, input: ExportInput): Promise<PackHandle> {
  const id = randomUUID()
  const srcReplay = join(sourceDir, 'replay.webm')
  const hasReplay = existsSync(srcReplay)
  const manifest = buildManifest({
    id,
    createdAt: input.capturedAt,
    generatorVersion: app.getVersion(),
    title: input.title,
    note: input.note,
    osVersion: release(),
    screens: physicalScreens(),
    hasReplay,
    replayDurationMs: input.replayDurationMs,
    snapshotTMs: input.snapshotTMs,
    trimOffsetMs: input.trimOffsetMs,
    plugins: input.plugins,
  })
  const annotationsFile: AnnotationsFile = {
    reference_width: input.width,
    reference_height: input.height,
    annotations: input.annotations,
  }
  const timeline = withExportEvent(input.timeline, new Date())

  // The new pack lands next to its source (same parent folder), named by the
  // save instant so it can never collide with the original.
  const dirPath = uniquePackDir(dirname(sourceDir), new Date())
  try {
    await mkdir(dirPath)
    await writePackFiles(dirPath, manifest, annotationsFile, timeline, input.docLanguage)
    await writeFile(join(dirPath, 'snapshot.png'), input.snapshotPng)
    if (hasReplay) await copyFile(srcReplay, join(dirPath, 'replay.webm'))
    // Plugin payloads (external packs): the files travel with their manifest
    // declaration — Save As New must not silently strip plugins/.
    const srcPlugins = join(sourceDir, 'plugins')
    if (existsSync(srcPlugins)) {
      await cp(srcPlugins, join(dirPath, 'plugins'), { recursive: true })
    }
  } catch (err) {
    // Never leave a half-written pack behind.
    await rm(dirPath, { recursive: true, force: true })
    throw err
  }

  if (input.copyToClipboard) copyFolderToClipboard(dirPath)
  return { id, dirPath }
}

/** The metadata + generated documents common to save-first and finalize. */
async function writePackFiles(
  dirPath: string,
  manifest: Manifest,
  annotationsFile: AnnotationsFile,
  timeline: TimelineFile,
  docLanguage: Language = 'en',
): Promise<void> {
  const skills = buildSkills(manifest, annotationsFile, timeline, docLanguage)
  await mkdir(join(dirPath, 'skills'), { recursive: true })
  await mkdir(join(dirPath, 'plugins'), { recursive: true })
  await writeFile(join(dirPath, 'manifest.json'), toJson(manifest))
  await writeFile(join(dirPath, 'annotations.json'), toJson(annotationsFile))
  await writeFile(join(dirPath, 'timeline.json'), toJson(timeline))
  await writeFile(join(dirPath, 'report.md'), buildReport(manifest, annotationsFile, docLanguage), 'utf8')
  await writeFile(join(dirPath, 'README.md'), buildReadme(manifest, annotationsFile, docLanguage), 'utf8')
  for (const name of SKILLS_FILES) {
    await writeFile(join(dirPath, 'skills', `${name}.md`), skills[name], 'utf8')
  }
}

/**
 * Declares the freshly rendered annotated replay in manifest.json
 * (media.replay_annotated, SPEC §5). Reads the file on disk rather than
 * rebuilding, so it composes with whatever the last save wrote.
 */
export async function setManifestReplayAnnotated(handle: PackHandle): Promise<void> {
  const manifestPath = join(handle.dirPath, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest
  if (manifest.media.replay === null) return // never declared without a replay
  manifest.media.replay_annotated = 'replay_annotated.webm'
  await writeFile(manifestPath, toJson(manifest))
}

/**
 * On-demand distribution ZIP (toast [Create ZIP]): sibling {folder}.capturepack
 * with the folder CONTENTS at the archive root (SPEC §3.2). Returns the zip path.
 */
export async function createPackZip(dirPath: string): Promise<string> {
  const zipPath = `${dirPath}.capturepack`
  const zip = new AdmZip()
  zip.addLocalFolder(dirPath)
  await zip.writeZipPromise(zipPath, { overwrite: true })
  return zipPath
}

function physicalScreens(): Array<{ width: number; height: number; scale: number }> {
  // display.size is in DIPs; the pack records physical pixels.
  return screen.getAllDisplays().map((d) => ({
    width: Math.round(d.size.width * d.scaleFactor),
    height: Math.round(d.size.height * d.scaleFactor),
    scale: d.scaleFactor,
  }))
}

function withExportEvent(timeline: TimelineFile, now: Date): TimelineFile {
  const t0 = Date.parse(timeline.t0)
  const t_ms = Number.isFinite(t0) ? Math.max(0, now.getTime() - t0) : 0
  return {
    t0: timeline.t0,
    events: [...timeline.events, { t_ms, type: 'core.export.created', source: 'core' }],
  }
}

/** CapturePack_2026-07-27_143052, collision suffix -2 (then -3, ...). */
function uniquePackDir(outputDir: string, date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stem =
    `CapturePack_${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? stem : `${stem}-${n}`
    const dirPath = join(outputDir, name)
    if (!existsSync(dirPath)) return dirPath
  }
}

// Set-Clipboard -LiteralPath puts the folder itself (not its path as text) on
// the clipboard, so it pastes into Explorer or chat apps that accept folders.
// Best-effort only: clipboard failure must never fail the save.
function copyFolderToClipboard(dirPath: string): void {
  const escaped = dirPath.replace(/'/g, "''")
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-Command', `Set-Clipboard -LiteralPath '${escaped}'`],
    { windowsHide: true, stdio: 'ignore' },
  )
  child.on('error', (err) => console.error('capturepack: clipboard copy failed:', err))
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`capturepack: clipboard copy exited with code ${code}`)
    }
  })
  child.unref()
}

function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n'
}
