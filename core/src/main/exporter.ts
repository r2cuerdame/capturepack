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
  ManifestDisplayMedia,
  ManifestKeyframe,
  TimelineFile,
  UiaPluginPayload,
} from '../shared/types'
import { FORMAT_NAME, FORMAT_VERSION } from '../shared/types'
import { buildReport } from './report'
import { buildReadme, buildSkills, SKILLS_FILES } from './packdocs'

// ---------------------------------------------------------------------------
// All-displays capture (GOAL "Multi-Monitor Support", SPEC §5.3)
// ---------------------------------------------------------------------------

/** What one captured display DECLARES in manifest.media.displays. */
export interface DisplayDeclaration {
  // 1-based position in manifest.environment.screens.
  index: number
  // Exactly one entry is focused: the display the editor annotates. Its files
  // ARE the top-level snapshot.png/replay.webm — never duplicated bytes.
  focused: boolean
  // Virtual-desktop rectangle in device-independent pixels; x scale = physical.
  bounds: { x: number; y: number; width: number; height: number }
  scale: number
  hasReplay: boolean
  replayDurationMs: number
}

/** A captured display plus the bytes to write for it. */
export interface DisplayCapture extends DisplayDeclaration {
  // NON-focused displays only. null = write nothing (the focused display's
  // frame is written as snapshot.png; a re-edit save keeps the files already
  // on disk and only carries the declaration through).
  snapshotPng: Buffer | null
  replayWebm: Buffer | null
}

/** Per-display filenames — one source for both the files and the manifest. */
export function displaySnapshotName(index: number): string {
  return `snapshot-d${index}.png`
}
export function displayReplayName(index: number): string {
  return `replay-d${index}.webm`
}

/**
 * media.displays[] for the captured displays. The focused entry is filled from
 * the FINAL top-level media object, so "focused entry === top-level media"
 * holds by construction — including after a trim replaced the replay bytes.
 */
function buildDisplayMedia(
  displays: readonly DisplayDeclaration[],
  media: Manifest['media'],
): ManifestDisplayMedia[] {
  return displays.map((d) => {
    const replay = d.focused
      ? media.replay
      : d.hasReplay
        ? displayReplayName(d.index)
        : null
    const durationMs = d.focused
      ? media.replay_duration_ms
      : Math.max(0, Math.round(d.replayDurationMs))
    return {
      index: d.index,
      snapshot: d.focused ? media.snapshot : displaySnapshotName(d.index),
      replay,
      // Written only alongside a replay, and next to it (SPEC §5.6).
      ...(replay !== null && durationMs !== undefined ? { replay_duration_ms: durationMs } : {}),
      bounds: { ...d.bounds },
      scale: d.scale,
      focused: d.focused,
    }
  })
}

/** Writes the per-display media files (the focused display's are the top-level ones). */
async function writeDisplayFiles(
  dirPath: string,
  displays: readonly DisplayCapture[] | undefined,
): Promise<void> {
  if (displays === undefined) return
  for (const d of displays) {
    if (d.focused) continue // its bytes are snapshot.png / replay.webm
    if (d.snapshotPng !== null) {
      await writeFile(join(dirPath, displaySnapshotName(d.index)), d.snapshotPng)
    }
    if (d.hasReplay && d.replayWebm !== null) {
      await writeFile(join(dirPath, displayReplayName(d.index)), d.replayWebm)
    }
  }
}

// ---------------------------------------------------------------------------
// plugins/windows-uia (GOAL "Static object picking", SPEC §11.3)
// ---------------------------------------------------------------------------

/** Directory name, manifest name, and meta.json name — one constant for all three. */
export const UIA_PLUGIN_NAME = 'windows-uia'
/** Payload schema version, not the app version (SPEC §11.1 requires both to match). */
export const UIA_PLUGIN_VERSION = '0.1.0'

/** The manifest.plugins entry for the payload writeUiaPlugin() lays down. */
export function uiaPluginDeclaration(): Manifest['plugins'][number] {
  return { name: UIA_PLUGIN_NAME, version: UIA_PLUGIN_VERSION, path: `plugins/${UIA_PLUGIN_NAME}/` }
}

/**
 * Writes plugins/windows-uia/{meta.json,elements.json}. Plugins only APPEND
 * metadata (SPEC §11.1): nothing here touches a core file. The declaration is
 * the caller's job — see uiaPluginDeclaration()/addManifestPlugin() — so a
 * declaration is only ever written for a payload that exists.
 */
export async function writeUiaPlugin(dirPath: string, payload: UiaPluginPayload): Promise<void> {
  const dir = join(dirPath, 'plugins', UIA_PLUGIN_NAME)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'meta.json'),
    toJson({ name: UIA_PLUGIN_NAME, version: UIA_PLUGIN_VERSION }),
  )
  await writeFile(join(dir, 'elements.json'), toJson(payload))
}

/**
 * Adds one plugin declaration to an ALREADY written manifest.json, the way
 * setManifestRenderOutputs() adds the render outputs: the save-first folder is
 * complete before the (asynchronous, budgeted) dump lands, so its payload is
 * declared in place rather than by rewriting the pack. A no-op when the plugin
 * is already declared.
 */
export async function addManifestPlugin(
  handle: PackHandle,
  declaration: Manifest['plugins'][number],
): Promise<void> {
  const manifestPath = join(handle.dirPath, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest
  const plugins = Array.isArray(manifest.plugins) ? manifest.plugins : []
  if (plugins.some((p) => p !== null && typeof p === 'object' && p.name === declaration.name)) return
  manifest.plugins = [...plugins, declaration]
  await writeFile(manifestPath, toJson(manifest))
}

/**
 * writeUiaPlugin() that can never fail a save: returns whether the payload
 * actually landed, which is exactly when it may be declared.
 */
async function tryWriteUiaPlugin(
  dirPath: string,
  payload: UiaPluginPayload | undefined,
): Promise<boolean> {
  if (payload === undefined) return false
  try {
    await writeUiaPlugin(dirPath, payload)
    return true
  } catch (err) {
    console.error(
      'capturepack: writing plugins/windows-uia failed:',
      err instanceof Error ? err.message : String(err),
    )
    return false
  }
}

/** Declares the UIA payload alongside whatever plugins the caller carries. */
function withUiaPlugin(
  plugins: Manifest['plugins'] | undefined,
  hasUia: boolean,
): Manifest['plugins'] | undefined {
  if (!hasUia) return plugins
  const existing = plugins ?? []
  if (existing.some((p) => p !== null && typeof p === 'object' && p.name === UIA_PLUGIN_NAME)) {
    return existing
  }
  return [...existing, uiaPluginDeclaration()]
}

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
  // (external packs, and this exporter's own windows-uia payload). Absent = [].
  plugins?: Manifest['plugins']
  // Capture-instant UI Automation dump (GOAL "Static object picking"), honored
  // by updatePack: present = write plugins/windows-uia/ and declare it; absent
  // = leave whatever is on disk alone. A re-edit save leaves it absent — the
  // payload files stay untouched and only their declaration travels, through
  // `plugins` (and, for Save As New, the byte-for-byte plugins/ copy).
  uia?: UiaPluginPayload
  // All-displays capture: every display the trigger froze, focused included.
  // Absent = a single-display pack (no media.displays). On re-edit the entries
  // carry null buffers: the declaration survives, the files stay untouched.
  displays?: DisplayCapture[]
  // The displays present at capture time, in the order media.displays indices
  // refer to. Absent = enumerate the CURRENT displays (single-display packs).
  screens?: Array<{ width: number; height: number; scale: number }>
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
  // media.displays[] source (all-displays capture); absent = single display.
  displays?: readonly DisplayDeclaration[]
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
      // media.replay_annotated and media.keyframes are added by
      // setManifestRenderOutputs() once the background render finishes — both
      // absent while not yet rendered, and replay_annotated always absent when
      // replay is null (SPEC §5.3, §5.7).
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
  // Declared LAST so the focused entry copies the finished top-level media
  // (replay filename + duration, trimmed or not).
  if (input.displays !== undefined && input.displays.length > 0) {
    manifest.media.displays = buildDisplayMedia(input.displays, manifest.media)
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
  // All-displays capture: save-first writes EVERY display too (that is the
  // point of the feature — a crash must not lose the other screens).
  displays?: DisplayCapture[]
  screens?: Array<{ width: number; height: number; scale: number }>
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
    screens: input.screens ?? physicalScreens(),
    hasReplay: input.replayWebm !== null,
    replayDurationMs: input.replayDurationMs,
    snapshotTMs: null,
    displays: input.displays,
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
    await writeDisplayFiles(dirPath, input.displays)
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
  // The plugin payload goes down BEFORE the manifest that declares it, and its
  // failure is swallowed: object data is a best-effort extra and must never
  // cost the user a save (GOAL "Static object picking"). A payload that did not
  // land is simply not declared.
  const uiaWritten = await tryWriteUiaPlugin(handle.dirPath, input.uia)
  const manifest = buildManifest({
    id: handle.id,
    createdAt: input.capturedAt,
    generatorVersion: app.getVersion(),
    title: input.title,
    note: input.note,
    osVersion: release(),
    screens: input.screens ?? physicalScreens(),
    hasReplay,
    replayDurationMs: input.replayDurationMs,
    snapshotTMs: input.snapshotTMs,
    trimOffsetMs: input.trimOffsetMs,
    plugins: withUiaPlugin(input.plugins, uiaWritten),
    displays: input.displays,
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
  // Non-focused displays: rewritten from the same bytes save-first used (a
  // failed save-first retries the whole write here). Re-edit passes null
  // buffers, so the files already on disk are left alone.
  await writeDisplayFiles(handle.dirPath, input.displays)
  // A stale annotated replay must never outlive the annotations that produced
  // it: the background render rewrites it (and re-declares it in the manifest)
  // after this save. The annotated keyframe stills follow the same rule — the
  // manifest written above declares neither, so both are removed here and the
  // render puts back exactly the current set (SPEC §5.7).
  await rm(join(handle.dirPath, 'replay_annotated.webm'), { force: true })
  await rm(join(handle.dirPath, 'frames'), { recursive: true, force: true })
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
  // All-displays pack: only the per-display files actually present in the
  // source can travel, so the new pack declares exactly what it will contain.
  const displays = input.displays?.filter(
    (d) => d.focused || existsSync(join(sourceDir, displaySnapshotName(d.index))),
  )
  const displayFiles: DisplayCapture[] | undefined = displays?.map((d) =>
    d.focused
      ? d
      : {
          ...d,
          hasReplay: d.hasReplay && existsSync(join(sourceDir, displayReplayName(d.index))),
        },
  )
  const manifest = buildManifest({
    id,
    createdAt: input.capturedAt,
    generatorVersion: app.getVersion(),
    title: input.title,
    note: input.note,
    osVersion: release(),
    screens: input.screens ?? physicalScreens(),
    hasReplay,
    replayDurationMs: input.replayDurationMs,
    snapshotTMs: input.snapshotTMs,
    trimOffsetMs: input.trimOffsetMs,
    plugins: input.plugins,
    displays: displayFiles,
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
    // Per-display media travels byte-for-byte with its declaration; entries
    // that still carry bytes (a fresh capture saved as new) write them instead.
    for (const d of displayFiles ?? []) {
      if (d.focused) continue
      const snapName = displaySnapshotName(d.index)
      if (d.snapshotPng !== null) await writeFile(join(dirPath, snapName), d.snapshotPng)
      else await copyFile(join(sourceDir, snapName), join(dirPath, snapName))
      if (!d.hasReplay) continue
      const replayName = displayReplayName(d.index)
      if (d.replayWebm !== null) await writeFile(join(dirPath, replayName), d.replayWebm)
      else await copyFile(join(sourceDir, replayName), join(dirPath, replayName))
    }
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
 * Declares what the background render just produced in manifest.json: the
 * annotated replay (media.replay_annotated, SPEC §5.3) and the annotated
 * keyframe stills (media.keyframes, SPEC §5.7) — both written by the same
 * render pass, so both are declared in one update. Reads the file on disk
 * rather than rebuilding, so it composes with whatever the last save wrote.
 *
 * The declaration always follows the files: the caller has already written
 * replay_annotated.webm and frames/, so a declared file is a file that exists.
 */
export async function setManifestRenderOutputs(
  handle: PackHandle,
  outputs: { replayAnnotated: boolean; keyframes: readonly ManifestKeyframe[] },
): Promise<void> {
  const manifestPath = join(handle.dirPath, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest
  // Never declared without a replay (SPEC §5.3) — keyframes have no such rule:
  // a screenshot-only pack has exactly one still, rendered from snapshot.png.
  if (outputs.replayAnnotated && manifest.media.replay !== null) {
    manifest.media.replay_annotated = 'replay_annotated.webm'
  }
  if (outputs.keyframes.length > 0) {
    manifest.media.keyframes = outputs.keyframes.map((k) => ({ file: k.file, t_ms: k.t_ms }))
  } else {
    delete manifest.media.keyframes
  }
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
