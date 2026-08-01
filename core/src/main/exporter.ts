// Writes the CapturePack FOLDER (format_version 0.1.0, SPEC §3 "folder first").
// The folder is the save unit; the .capturepack ZIP is created only on demand
// by the save toast's [Create ZIP] button (createPackZip).

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { release } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { app, screen } from 'electron'
import AdmZip from 'adm-zip'
import { sealUiaPayload } from './uia'
import type { Language } from '../shared/i18n'
import type {
  Annotation,
  AnnotationsFile,
  Manifest,
  ManifestCadence,
  ManifestDisplayMedia,
  ManifestKeyframe,
  TimelineFile,
  UiaPluginPayload,
} from '../shared/types'
import { analyzePackPrompt } from '../shared/prompt'
import type { ClipboardAfterSave } from '../shared/types'
import type {
  CaptureKind,
  ImageCaptureScope,
  ImageCropBounds,
} from '../shared/captureMedia'
import {
  FORMAT_NAME,
  FORMAT_VERSION_CAPTURE_DIAGNOSTICS,
  FORMAT_VERSION_KEYFRAMES,
  FORMAT_VERSION_SOURCE_LATENCY,
} from '../shared/types'
import { displayAnnotatedName, displayFramesDir } from '../shared/keyframes'
import { buildReport } from './report'
import { buildReadme, buildSkills, SKILLS_FILES } from './packdocs'
import { buildViewerHtml, manifestWithViewerFormat } from './viewer'
import { copyTextToClipboard } from './clipboard'
import {
  WINDOWS_CONTEXT_TIMELINE_SCHEMA,
  type WindowsContextTimelineV1,
} from './context/windowsContextTimeline'

// ---------------------------------------------------------------------------
// All-displays capture (GOAL "Multi-Monitor Support", SPEC §5.3)
// ---------------------------------------------------------------------------

/** What one captured display DECLARES in manifest.media.displays. */
export interface DisplayDeclaration {
  // 1-based position in manifest.environment.screens.
  index: number
  // Exactly one entry is focused: the display the editor annotates. Its files
  // ARE the top-level snapshot.png/declared replay — never duplicated bytes.
  focused: boolean
  // Virtual-desktop rectangle in device-independent pixels; x scale = physical.
  bounds: { x: number; y: number; width: number; height: number }
  scale: number
  hasReplay: boolean
  replayDurationMs: number
  // Observed conversion from the pack clock to this replay's clock. Optional
  // for legacy packs whose only available alignment fact is replay duration.
  replayClockOffsetMs?: number
  /**
   * What this display's recorder achieved, when it could measure itself (#82).
   *
   * Written into the pack so a reader can see the replay's quality without
   * running ffprobe over it — a recording with a one-second hole in it looks
   * exactly like a clean one otherwise, and the moment being annotated may
   * simply not be in the file.
   */
  cadence?: ManifestCadence
  // The filenames this display's media is DECLARED under, carried rather than
  // re-derived from `index`: SPEC §5.6 allows `replay-d<N>.mp4` just as much as
  // `.webm`, so a re-edit save of an external pack must keep the names the
  // folder actually holds. Ignored on the focused entry (its media IS the
  // top-level media). Both are validated against the SPEC §5.6 name patterns
  // before they are ever joined onto a path — see displayMediaName().
  snapshotFile: string
  replayFile: string | null
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
export function displayReplayName(index: number, replayFile = 'replay.webm'): string {
  return `replay-d${index}.${replayFile.endsWith('.mp4') ? 'mp4' : 'webm'}`
}

// The names SPEC §5.3/§5.6 permits. A declared name is read back out of a
// manifest.json this process did not write (re-edit of an external or
// hand-edited pack), and it is joined onto a path — so it is checked against
// these before it can reach existsSync/copyFile/writeFile/rm.
export const REPLAY_NAME_RE = /^replay\.(webm|mp4)$/
const DISPLAY_SNAPSHOT_NAME_RE = /^snapshot-d[1-9][0-9]*\.png$/
const DISPLAY_REPLAY_NAME_RE = /^replay-d[1-9][0-9]*\.(webm|mp4)$/

/** A declared top-level replay filename, or the default when it is not legal. */
export function replayFileName(declared: string | null | undefined): string {
  return typeof declared === 'string' && REPLAY_NAME_RE.test(declared) ? declared : 'replay.webm'
}

/** MIME type implied by a validated replay filename. */
export function replayMimeType(declared: string | null | undefined): string {
  return replayFileName(declared).endsWith('.mp4') ? 'video/mp4' : 'video/webm'
}

/** A declared per-display filename, or the index-derived default. */
export function displayMediaName(
  declared: string | null | undefined,
  fallback: string,
  kind: 'snapshot' | 'replay',
): string {
  const re = kind === 'snapshot' ? DISPLAY_SNAPSHOT_NAME_RE : DISPLAY_REPLAY_NAME_RE
  return typeof declared === 'string' && re.test(declared) ? declared : fallback
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
    const replay = d.focused ? media.replay : d.hasReplay ? d.replayFile : null
    const durationMs = d.focused
      ? media.replay_duration_ms
      : Math.max(0, Math.round(d.replayDurationMs))
    const replayClockOffsetMs =
      replay === null
        ? undefined
        : d.focused
          ? 0
          : Number.isSafeInteger(d.replayClockOffsetMs)
            ? d.replayClockOffsetMs
            : undefined
    return {
      index: d.index,
      snapshot: d.focused ? media.snapshot : d.snapshotFile,
      replay,
      // Written only alongside a replay, and next to it (SPEC §5.6).
      ...(replay !== null && durationMs !== undefined ? { replay_duration_ms: durationMs } : {}),
      ...(replayClockOffsetMs !== undefined
        ? { replay_clock_offset_ms: replayClockOffsetMs }
        : {}),
      // Only where there IS a replay and it measured itself: a rate reported
      // next to no recording, or one nobody measured, says nothing true.
      ...(replay !== null && d.cadence !== undefined ? { cadence: d.cadence } : {}),
      bounds: { ...d.bounds },
      scale: d.scale,
      focused: d.focused,
    }
  })
}

/**
 * Writes the per-display media files (the focused display's are the top-level
 * ones). Concurrent on purpose: each of these is 20-45 MB of webm, and a
 * sequential loop over three or four screens is seconds of wall clock between
 * the hotkey and the editor (see savePack's background write).
 */
async function writeDisplayFiles(
  dirPath: string,
  displays: readonly DisplayCapture[] | undefined,
): Promise<void> {
  if (displays === undefined) return
  await Promise.all(
    displays.map(async (d) => {
      if (d.focused) return // its bytes are snapshot.png / the top-level replay
      if (d.snapshotPng !== null) {
        await writeFile(join(dirPath, d.snapshotFile), d.snapshotPng)
      }
      if (d.hasReplay && d.replayFile !== null && d.replayWebm !== null) {
        await writeFile(join(dirPath, d.replayFile), d.replayWebm)
      }
    }),
  )
}

/**
 * Removes every non-focused display's annotated replay and stills. The
 * derived-view rule of the top-level media (SPEC §7.2) applies per display: a
 * rendering is only ever as current as the annotations it was made from, so a
 * save wipes them all and the renders that follow declare exactly what still
 * has boxes.
 */
async function clearDisplayRenderOutputs(
  dirPath: string,
  displays: readonly DisplayDeclaration[] | undefined,
): Promise<void> {
  if (displays === undefined) return
  for (const d of displays) {
    if (d.focused) continue
    await rm(join(dirPath, displayAnnotatedName(d.index)), { force: true })
    await rm(join(dirPath, displayFramesDir(d.index)), { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Save-first per-display writes, off the editor-opening critical path
// ---------------------------------------------------------------------------

// dirPath -> the save-first per-display write still in flight for it. savePack
// returns as soon as the CRASH-CRITICAL bytes (manifest, snapshot.png,
// declared replay, annotations/timeline/docs) are down, so the editor opens without
// waiting for 100+ MB of other screens; every later writer for that folder
// (updatePack, saveAsNewPack) settles this first.
const pendingDisplayWrites = new Map<string, Promise<void>>()

// Every read-modify-write of one pack's manifest shares this queue. UIA/DOM
// providers finish on independent budgets while final save and background
// renders rewrite the same file; without serialization, the last stale writer
// silently removes declarations written by the others.
const manifestMutationTails = new Map<string, Promise<void>>()

/**
 * Publishes one source document as a complete file.
 *
 * CapturePack's MCP watcher can read a pack while a save is in progress. A
 * direct write briefly exposes a truncated JSON/Markdown file; writing beside
 * it and renaming keeps readers on either the previous complete revision or
 * the next complete revision. Derived media is intentionally not routed
 * through this helper — only the small, authoritative source documents are.
 */
async function writeSourceFile(filePath: string, contents: string): Promise<void> {
  const temporaryPath = `${filePath}.${String(process.pid)}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, contents, 'utf8')
    await rename(temporaryPath, filePath)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {})
  }
}

/**
 * viewer.html is useful but derived. A broken browser view must never cost the
 * source pack; an older viewer describing a previous revision is removed.
 *
 * Returns true only when this revision's viewer was atomically published.
 * On success the in-memory manifest is raised to the viewer's minimum format
 * version so the caller can publish that manifest as its commit point.
 */
async function writeViewerNonFatal(
  dirPath: string,
  manifest: Manifest,
  annotationsFile: AnnotationsFile,
  timeline: TimelineFile,
  docLanguage: Language,
): Promise<boolean> {
  const viewerPath = join(dirPath, 'viewer.html')
  try {
    const viewerManifest = manifestWithViewerFormat(manifest)
    const html = buildViewerHtml(viewerManifest, annotationsFile, timeline, docLanguage)
    await writeSourceFile(viewerPath, html)
    manifest.format_version = viewerManifest.format_version
    return true
  } catch (err) {
    console.error(
      'capturepack: writing viewer.html failed; source pack remains valid:',
      err instanceof Error ? err.message : String(err),
    )
    try {
      await rm(viewerPath, { force: true })
    } catch (cleanupError) {
      console.error(
        'capturepack: removing stale viewer.html failed:',
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      )
    }
    return false
  }
}

async function withManifestMutation<T>(
  dirPath: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const previous = manifestMutationTails.get(dirPath) ?? Promise.resolve()
  const run = previous.then(mutation, mutation)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  manifestMutationTails.set(dirPath, tail)
  try {
    return await run
  } finally {
    if (manifestMutationTails.get(dirPath) === tail) manifestMutationTails.delete(dirPath)
  }
}

/** Waits for a save-first per-display write to finish. Never rejects. */
export async function settleDisplayWrites(dirPath: string): Promise<void> {
  const pending = pendingDisplayWrites.get(dirPath)
  if (pending === undefined) return
  try {
    await pending
  } catch {
    /* already logged by the writer */
  }
}

/**
 * A per-display file the background write could not lay down must not stay
 * DECLARED: re-reads the manifest and drops every media.displays entry whose
 * files are missing (and the whole array when fewer than two survive, SPEC
 * §5.6). Keeps a save-first folder valid even when the editor is cancelled.
 */
async function dropUndeclarableDisplays(dirPath: string): Promise<void> {
  return withManifestMutation(dirPath, async () => {
    const manifestPath = join(dirPath, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest
    const displays = manifest.media.displays
    if (!Array.isArray(displays)) return
    let changed = false
    const kept: ManifestDisplayMedia[] = []
    for (const d of displays) {
      if (d.focused) {
        kept.push(d)
        continue
      }
      if (!existsSync(join(dirPath, d.snapshot))) {
        changed = true
        continue // no frame for this display: it is not in the pack at all
      }
      if (d.replay !== null && !existsSync(join(dirPath, d.replay))) {
        // The frame landed, the recording did not — a screenshot-only display is
        // a legal entry (SPEC §5.6); a declared missing file is not.
        const {
          replay_duration_ms: _droppedDuration,
          replay_clock_offset_ms: _droppedClock,
          ...rest
        } = d
        kept.push({ ...rest, replay: null })
        changed = true
        continue
      }
      kept.push(d)
    }
    if (!changed) return
    if (kept.length > 1) manifest.media.displays = kept
    else delete manifest.media.displays
    await writeSourceFile(manifestPath, toJson(manifest))
  })
}

// ---------------------------------------------------------------------------
// plugins/windows-uia (GOAL "Static object picking", SPEC §11.3)
// ---------------------------------------------------------------------------

/** Directory name, manifest name, and meta.json name — one constant for all three. */
export const UIA_PLUGIN_NAME = 'windows-uia'
/**
 * Payload schema version, not the app version (SPEC §11.1 requires the
 * manifest declaration and meta.json to agree). Every version so far has been
 * additive, so a reader of any of them still reads every field it knows:
 *  - 0.2.0 added the per-window class_name/z/tree/element_count and the
 *    per-element window index (SPEC §11.3).
 *  - 0.3.0 added `display` on both, so a multi-display capture reports each
 *    window and control in the snapshot space of the display it is ON instead
 *    of forcing the whole desktop through the focused display's transform.
 *    Absent = the focused display, which is what a single-display pack writes,
 *    so its payload is unchanged.
 *  - 0.4.0 added `geometry_refused`: how many web-content roots the walk threw
 *    away for still measuring themselves against a display their window had
 *    left. Absent = a walk that could not tell, which is what every earlier
 *    version wrote; 0 = it looked and found none. The difference matters,
 *    because a refused window is not a window without controls.
 */
export const UIA_PLUGIN_VERSION = '0.4.0'

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
  await writeSourceFile(
    join(dir, 'meta.json'),
    toJson({ name: UIA_PLUGIN_NAME, version: UIA_PLUGIN_VERSION }),
  )
  await writeSourceFile(join(dir, 'elements.json'), toJson(sealUiaPayload(payload) ?? payload))
}


// ---------------------------------------------------------------------------
// plugins/chrome-dom (GOAL "Chrome Extension", Phase 1)
// ---------------------------------------------------------------------------

export const DOM_PLUGIN_NAME = 'chrome-dom'
/**
 * Payload schema version.
 *
 * 0.1.0 was protocol v1's Phase 1 surface: the URL and title of the tab, and
 * for a picked element its tag, selector, bounds and whatever of id/role/text
 * the page actually had.
 *
 * 0.2.0 adds `document` on a pick — the whole interface that was visible when
 * the user picked, which the freed per-frame budget is what pays for (GOAL "The
 * still carries the context"). Absent on a pick from an older extension, and on
 * one made inside an iframe; a reader treats its absence as "nobody looked",
 * never as "the page was empty".
 */
export const DOM_PLUGIN_VERSION = '0.2.0'

/**
 * WHAT WAS ON SCREEN, AND WHAT WAS DELIBERATELY LEFT OFF IT.
 *
 * `omitted` is part of the record rather than a comment: a reader of the pack
 * learns what is missing without reading our source. The extension refuses the
 * value of every field, everything but the presence of a password box, the text
 * of anything the user could not see, and any attribute outside its allowlist —
 * because the licence for writing down visible text is that `snapshot.png`
 * already contains those pixels, and that argument covers nothing else.
 */
export interface DomPluginDocument {
  viewport: {
    width: number
    height: number
    device_pixel_ratio: number
    scroll_x: number
    scroll_y: number
  }
  url: string
  title: string
  elements: readonly {
    i: number
    tag: string
    role: string
    bounds: { x: number; y: number; width: number; height: number }
    id?: string
    class?: string
    name?: string
    type?: string
    placeholder?: string
    alt?: string
    title?: string
    href?: string
    text?: string
    /** A field held something. Never what it held. */
    filled?: boolean
    /** A password box was here. Nothing else about it is recorded. */
    secret?: boolean
  }[]
  /** The walk hit its cap: this is a prefix of the page, not the page. */
  truncated: boolean
  visited_count: number
  elapsed_ms: number
  omitted: readonly string[]
}

export interface DomPluginPayload {
  protocol: number
  /** Extension version, when it introduced itself; null when it never did. */
  extension_version: string | null
  events: readonly {
    t_ms: number
    type: string
    tab: { url: string; title: string }
    element?: {
      tag: string
      selector: string
      bounds: { x: number; y: number; width: number; height: number }
      id?: string
      role?: string
      text?: string
    }
    /** Added in payload 0.2.0. Absent means nobody looked, not an empty page. */
    document?: DomPluginDocument
  }[]
}

export function domPluginDeclaration(): Manifest['plugins'][number] {
  return { name: DOM_PLUGIN_NAME, version: DOM_PLUGIN_VERSION, path: `plugins/${DOM_PLUGIN_NAME}/` }
}

/**
 * Writes plugins/chrome-dom/{meta.json,elements.json}.
 *
 * Same contract as the UIA payload beside it: a plugin only APPENDS (SPEC
 * §11.1), and the manifest declaration is the caller's job so that a
 * declaration is only ever written for a payload that exists. A pack made
 * while no browser was talking simply has no chrome-dom directory — which
 * SPEC §11.3 already says is the difference between "nothing happened" and
 * "nobody was watching".
 */
export async function writeDomPlugin(dirPath: string, payload: DomPluginPayload): Promise<void> {
  const dir = join(dirPath, 'plugins', DOM_PLUGIN_NAME)
  await mkdir(dir, { recursive: true })
  await writeSourceFile(
    join(dir, 'meta.json'),
    toJson({ name: DOM_PLUGIN_NAME, version: DOM_PLUGIN_VERSION }),
  )
  await writeSourceFile(join(dir, 'elements.json'), toJson(payload))
}

/** writeDomPlugin() that can never fail a save. */
export async function tryWriteDomPlugin(
  dirPath: string,
  payload: DomPluginPayload | undefined,
): Promise<boolean> {
  if (payload === undefined || payload.events.length === 0) return false
  try {
    await writeDomPlugin(dirPath, payload)
    return true
  } catch (err) {
    console.error(
      'capturepack: writing plugins/chrome-dom failed:',
      err instanceof Error ? err.message : String(err),
    )
    return false
  }
}

/**
 * Adds one plugin declaration to an ALREADY written manifest.json, the way
 * setManifestRenderOutputs() adds the render outputs: the save-first folder is
 * complete before the (asynchronous, budgeted) dump lands, so its payload is
 * declared in place rather than by rewriting the pack.
 *
 * The generated documents are part of that same revision. Updating only the
 * manifest left cancelled save-first packs saying "no plugin contributed
 * semantic data" beside a declared plugins/windows-uia payload. Read the
 * current source files under the manifest-mutation lock, write documents for
 * the next manifest, then publish the manifest as the commit point.
 */
export async function addManifestPlugin(
  handle: PackHandle,
  declaration: Manifest['plugins'][number],
  docLanguage: Language,
): Promise<void> {
  return withManifestMutation(handle.dirPath, async () => {
    const manifestPath = join(handle.dirPath, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest
    const plugins = Array.isArray(manifest.plugins) ? manifest.plugins : []
    const declared = plugins.some(
      (p) => p !== null && typeof p === 'object' && p.name === declaration.name,
    )
    const nextManifest: Manifest = declared
      ? manifest
      : { ...manifest, plugins: [...plugins, declaration] }
    const annotationsFile = JSON.parse(
      await readFile(join(handle.dirPath, 'annotations.json'), 'utf8'),
    ) as AnnotationsFile
    const timeline: TimelineFile =
      nextManifest.capture_kind === 'image'
        ? { t0: nextManifest.created_at, events: [] }
        : JSON.parse(
            await readFile(join(handle.dirPath, 'timeline.json'), 'utf8'),
          ) as TimelineFile

    // A late plugin belongs to the durable source revision, not to derived
    // rendering. Under-promising while a final render starts is safe; once the
    // renderer declares its outputs it regenerates these documents again.
    const previousFormatVersion = nextManifest.format_version
    const viewerWritten = await writeViewerNonFatal(
      handle.dirPath,
      nextManifest,
      annotationsFile,
      timeline,
      docLanguage,
    )
    await writeDocs(
      handle.dirPath,
      nextManifest,
      annotationsFile,
      timeline,
      docLanguage,
      false,
      viewerWritten,
    )
    if (!declared || nextManifest.format_version !== previousFormatVersion) {
      await writeSourceFile(manifestPath, toJson(nextManifest))
    }
  })
}

// ---------------------------------------------------------------------------
// plugins/windows-context — Lane S + Lane A over the replay clock
// ---------------------------------------------------------------------------

export const WINDOWS_CONTEXT_PLUGIN_NAME = 'windows-context'
export const WINDOWS_CONTEXT_PLUGIN_VERSION = '0.1.0'

export function windowsContextPluginDeclaration(): Manifest['plugins'][number] {
  return {
    name: WINDOWS_CONTEXT_PLUGIN_NAME,
    version: WINDOWS_CONTEXT_PLUGIN_VERSION,
    path: `plugins/${WINDOWS_CONTEXT_PLUGIN_NAME}/`,
  }
}

/** Writes the already-validated compact checkpoint/delta timeline. */
export async function writeWindowsContextPlugin(
  dirPath: string,
  timeline: WindowsContextTimelineV1,
): Promise<void> {
  const dir = join(dirPath, 'plugins', WINDOWS_CONTEXT_PLUGIN_NAME)
  await mkdir(dir, { recursive: true })
  await writeSourceFile(
    join(dir, 'meta.json'),
    toJson({
      name: WINDOWS_CONTEXT_PLUGIN_NAME,
      version: WINDOWS_CONTEXT_PLUGIN_VERSION,
      schema: WINDOWS_CONTEXT_TIMELINE_SCHEMA,
      clock: 'pack_ms',
      timeline: 'timeline.json',
    }),
  )
  await writeSourceFile(join(dir, 'timeline.json'), toJson(timeline))
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

type WindowsContextDisposition = 'preserve' | 'written' | 'drop'

/**
 * `undefined` is the re-edit contract: leave a pack-backed plugin untouched.
 * `null` is an explicit removal after a clock-changing degradation. A concrete
 * timeline replaces it. Every filesystem failure becomes `drop`, never a save
 * failure or a declaration that points at incomplete object data.
 */
async function reconcileWindowsContextPlugin(
  dirPath: string,
  timeline: WindowsContextTimelineV1 | null | undefined,
): Promise<WindowsContextDisposition> {
  if (timeline === undefined) return 'preserve'
  const dir = join(dirPath, 'plugins', WINDOWS_CONTEXT_PLUGIN_NAME)
  if (timeline === null) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    return 'drop'
  }
  try {
    await writeWindowsContextPlugin(dirPath, timeline)
    return 'written'
  } catch (err) {
    console.error(
      `capturepack: writing plugins/${WINDOWS_CONTEXT_PLUGIN_NAME} failed:`,
      err instanceof Error ? err.message : String(err),
    )
    // A previous raw-clock payload is worse than no payload after a trim.
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    return 'drop'
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

function withWindowsContextPlugin(
  plugins: Manifest['plugins'] | undefined,
  disposition: WindowsContextDisposition,
): Manifest['plugins'] | undefined {
  if (disposition === 'preserve') return plugins
  const withoutContext = (plugins ?? []).filter(
    (plugin) =>
      plugin === null
      || typeof plugin !== 'object'
      || plugin.name !== WINDOWS_CONTEXT_PLUGIN_NAME,
  )
  return disposition === 'written'
    ? [...withoutContext, windowsContextPluginDeclaration()]
    : withoutContext.length === 0 ? undefined : withoutContext
}

/**
 * A final in-place save must keep declarations that landed after save-first.
 *
 * Fresh-capture ExportInput does not carry plugin metadata, while the browser
 * bridge appends chrome-dom to the already-written manifest asynchronously.
 * Rebuilding from input alone therefore orphaned a physical chrome-dom payload
 * at final save. Incoming declarations win by name (re-edit may deliberately
 * carry newer metadata); everything else already declared stays declared.
 */
function withPreservedPlugins(
  previous: Manifest['plugins'] | undefined,
  incoming: Manifest['plugins'] | undefined,
): Manifest['plugins'] {
  const merged = [...(previous ?? [])]
  for (const declaration of incoming ?? []) {
    const index = merged.findIndex(
      (plugin) =>
        plugin !== null &&
        typeof plugin === 'object' &&
        plugin.name === declaration.name,
    )
    if (index < 0) merged.push(declaration)
    else merged[index] = declaration
  }
  return merged
}

export interface ExportInput {
  // The exported snapshot frame. Blur is NEVER burned in (SPEC §9) — this is
  // original pixels of the chosen frame (native snapshot or scrubbed replay frame).
  snapshotPng: Buffer
  width: number
  height: number
  captureKind?: CaptureKind
  imageScope?: ImageCaptureScope
  cropBounds?: ImageCropBounds
  // Capture trigger instant — manifest.created_at is the capture, not the save
  capturedAt: Date
  replayWebm: Buffer | null
  replayDurationMs: number
  // The filename the replay is DECLARED under (SPEC §5.3 allows replay.webm and
  // replay.mp4). Absent = replay.webm; fresh capture passes the selected
  // recorder container, and re-edit passes the loaded manifest's name so the
  // file on disk stays declared instead of being silently orphaned.
  replayFile?: string
  cadence?: ManifestCadence
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
  // Temporal Lane S + Lane A context. undefined preserves a pack-backed plugin
  // on re-edit; null explicitly removes a stale raw-clock payload after a
  // replay is dropped; a value atomically replaces it before manifest rewrite.
  windowsContext?: WindowsContextTimelineV1 | null
  // All-displays capture: every display the trigger froze, focused included.
  // Absent = a single-display pack (no media.displays). On re-edit the entries
  // carry null buffers: the declaration survives, the files stay untouched.
  displays?: DisplayCapture[]
  // The displays present at capture time, in the order media.displays indices
  // refer to. Absent = enumerate the CURRENT displays (single-display packs).
  screens?: Array<{ width: number; height: number; scale: number }>
  clipboardAfterSave: ClipboardAfterSave
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
  captureKind?: CaptureKind
  imageScope?: ImageCaptureScope
  cropBounds?: ImageCropBounds
  hasReplay: boolean
  // Declared name of the replay file; absent = replay.webm (SPEC §5.3).
  replayFile?: string
  replayDurationMs: number
  snapshotTMs: number | null
  // media.trim_offset_ms (provenance only, GOAL "Replay Trim"); absent/null =
  // never trimmed. Only written alongside a replay.
  trimOffsetMs?: number | null
  // Carried through from a loaded manifest on re-edit; absent = [] (fresh packs).
  plugins?: Manifest['plugins']
  // media.displays[] source (all-displays capture); absent = single display.
  displays?: readonly DisplayDeclaration[]
  // Focused/single-display replay diagnostics. Capture provenance members
  // require format 0.4.0; basic achieved cadence remains valid in 0.2.0+.
  cadence?: ManifestCadence
  /**
   * Whether any box carries AUTHORED motion (SPEC §8.9), which is the only
   * thing that lifts this pack's declared format version. Absent = no.
   *
   * Passed in rather than derived here because the save-first path builds a
   * manifest before any annotation exists, and a manifest that claimed 0.3.0
   * for an empty pack would cost it older readers for a field it does not use.
   */
  usesKeyframes?: boolean
}

function validImageCropBounds(value: ImageCropBounds | undefined): value is ImageCropBounds {
  return (
    value !== undefined &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.width) &&
    value.width > 0 &&
    Number.isFinite(value.height) &&
    value.height > 0 &&
    value.coordinate_space === 'virtual-desktop-dip'
  )
}

export function buildManifest(input: ManifestInput): Manifest {
  const captureKind = input.captureKind ?? 'video'
  if (captureKind === 'image') {
    if (input.imageScope !== 'region' && input.imageScope !== 'fullscreen') {
      throw new Error('image capture requires an explicit region or fullscreen scope')
    }
    if (input.imageScope === 'region' && !validImageCropBounds(input.cropBounds)) {
      throw new Error('region image capture requires valid virtual-desktop crop bounds')
    }
    if (input.imageScope === 'fullscreen' && input.cropBounds !== undefined) {
      throw new Error('fullscreen image capture must not declare crop bounds')
    }
  }
  // Version from what this manifest will actually DECLARE, not from stale
  // recorder state a screenshot/no-replay caller happened to carry. A
  // single-display declaration is omitted entirely; a failed display emits no
  // replay beside which cadence could truthfully live.
  const emittedCadences: Array<ManifestCadence | undefined> = []
  if (captureKind === 'video' && input.hasReplay) {
    emittedCadences.push(input.cadence)
    emittedCadences.push(
      input.displays?.find((display) => display.focused)?.cadence,
    )
  }
  if (
    captureKind === 'video' &&
    input.displays !== undefined &&
    input.displays.length > 1
  ) {
    for (const display of input.displays) {
      const emitsReplay = display.focused ? input.hasReplay : display.hasReplay
      if (emitsReplay) emittedCadences.push(display.cadence)
    }
  }
  const hasCaptureDiagnostics = emittedCadences.some(
    (cadence) =>
      cadence?.backend !== undefined ||
      cadence?.quality !== undefined ||
      cadence?.requested_fps !== undefined ||
      cadence?.recorder_count !== undefined,
  )
  // A measured source latency is 0.6.0, and only a pack that emits one says so
  // (SPEC §13.1). Checked on the SAME emitted list as the 0.4.0 provenance:
  // a cadence the manifest will not declare cannot raise its version.
  const hasSourceLatency = emittedCadences.some(
    (cadence) => cadence?.source_latency !== undefined,
  )
  const manifest: Manifest = {
    format: FORMAT_NAME,
    // Every pack written here declares capture_kind, a 0.3.0 field (SPEC §5.1,
    // §13.1). Legacy 0.2.1 packs remain readable because they omit the field;
    // a new video cannot claim that older contract merely because it has no
    // authored keyframes.
    format_version: hasSourceLatency
      ? FORMAT_VERSION_SOURCE_LATENCY
      : hasCaptureDiagnostics
        ? FORMAT_VERSION_CAPTURE_DIAGNOSTICS
        : FORMAT_VERSION_KEYFRAMES,
    capture_kind: captureKind,
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
      // The name the file on disk actually has — never assumed (SPEC §5.3).
      replay: input.hasReplay ? replayFileName(input.replayFile) : null,
      // media.replay_annotated and media.keyframes are added by
      // setManifestRenderOutputs() once the background render finishes — both
      // absent while not yet rendered, and replay_annotated always absent when
      // replay is null (SPEC §5.3, §5.7).
    },
    plugins: input.plugins ?? [],
  }
  if (captureKind === 'image') {
    manifest.media.replay = null
    manifest.media.image_scope = input.imageScope
    if (input.imageScope === 'region' && input.cropBounds !== undefined) {
      manifest.media.crop_bounds = input.cropBounds
    }
  }
  const title = input.title.trim()
  if (title !== '') manifest.title = title
  const note = input.note.trim()
  if (note !== '') manifest.note = note
  if (captureKind === 'video' && input.hasReplay) {
    manifest.media.replay_duration_ms = input.replayDurationMs
    if (input.cadence !== undefined) manifest.media.cadence = { ...input.cadence }
    // The focused display IS the top-level media object (SPEC §5.3/§5.6).
    // Its measured recorder cadence therefore belongs here even when this was
    // a single-display capture and media.displays is correctly absent.
    const focusedCadence = input.displays?.find(
      (display) => display.focused,
    )?.cadence
    if (focusedCadence !== undefined) {
      manifest.media.cadence = { ...focusedCadence }
    }
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
  // (replay filename + duration, trimmed or not). Present ONLY for a capture
  // that covered more than one display — a single-display capture omits it and
  // the top-level media already describes the whole pack (SPEC §5.6).
  if (
    captureKind === 'video' &&
    input.displays !== undefined &&
    input.displays.length > 1
  ) {
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
  captureKind?: CaptureKind
  imageScope?: ImageCaptureScope
  cropBounds?: ImageCropBounds
  capturedAt: Date
  replayWebm: Buffer | null
  // Actual recorder container name. Absent retains the legacy replay.webm.
  replayFile?: string
  replayDurationMs: number
  // Focused/single-display measured replay diagnostics. Capture provenance
  // members require format 0.4.0; omitted for image captures.
  cadence?: ManifestCadence
  // Provenance for an exact background cut applied to a cancelled save-first
  // pack. Absent on the initial raw write.
  trimOffsetMs?: number
  timeline: TimelineFile
  outputDir: string
  // All-displays capture: save-first writes EVERY display too (that is the
  // point of the feature — a crash must not lose the other screens).
  displays?: DisplayCapture[]
  screens?: Array<{ width: number; height: number; scale: number }>
  // Save-first is aligned to the raw recorder clock. Cancel/finalize replaces
  // this with the exact cut/rebased clock through updateInitialPack().
  windowsContext?: WindowsContextTimelineV1 | null
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
  const imageCapture = input.captureKind === 'image'
  const id = randomUUID()
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
    // Optional context lands before the manifest that declares it. Its writer
    // swallows every failure, so save-first remains a media-first guarantee.
    const contextDisposition = await reconcileWindowsContextPlugin(
      dirPath,
      imageCapture ? null : input.windowsContext,
    )
    const manifest = buildManifest({
      id,
      createdAt: input.capturedAt,
      generatorVersion: app.getVersion(),
      title: '',
      note: '',
      osVersion: release(),
      screens: input.screens ?? physicalScreens(),
      captureKind: input.captureKind,
      imageScope: input.imageScope,
      cropBounds: input.cropBounds,
      hasReplay: !imageCapture && input.replayWebm !== null,
      replayFile: input.replayFile,
      replayDurationMs: input.replayDurationMs,
      snapshotTMs: null,
      plugins: withWindowsContextPlugin(undefined, contextDisposition),
      displays: imageCapture ? undefined : input.displays,
      cadence: imageCapture ? undefined : input.cadence,
    })
    // No render follows a save-first folder — the editor may never finish — so
    // the documents must not promise stills nothing will ever write.
    await writePackFiles(dirPath, manifest, annotationsFile, input.timeline, input.docLanguage, false)
    await writeFile(join(dirPath, 'snapshot.png'), input.snapshotPng)
    if (!imageCapture && input.replayWebm !== null) {
      await writeFile(join(dirPath, replayFileName(input.replayFile)), input.replayWebm)
    }
  } catch (err) {
    // Never leave a half-written pack behind.
    await rm(dirPath, { recursive: true, force: true })
    throw err
  }
  // The OTHER displays' media (up to ~45 MB of webm each) is written in the
  // background: the focused pack above is already complete and valid, and the editor
  // must not wait on 100+ MB of screens the user is not annotating. Every later
  // writer for this folder settles it first (settleDisplayWrites).
  if (!imageCapture && input.displays !== undefined) {
    const write = writeDisplayFiles(dirPath, input.displays)
      .catch(async (err: unknown) => {
        console.error(
          'capturepack: writing the per-display media failed:',
          err instanceof Error ? err.message : String(err),
        )
        // A file that did not land must not stay declared (SPEC §5.6).
        await dropUndeclarableDisplays(dirPath).catch(() => {})
      })
      .finally(() => {
        if (pendingDisplayWrites.get(dirPath) === write) pendingDisplayWrites.delete(dirPath)
      })
    pendingDisplayWrites.set(dirPath, write)
  }
  return { id, dirPath }
}

/**
 * Replaces a save-first pack's raw ring segment with its exact last-N-second
 * background cut when the editor was cancelled. This deliberately does not add
 * core.export.created or promise generated render outputs: cancelling still
 * leaves a raw, unannotated pack, just with an honest replay clock.
 */
export async function updateInitialPack(
  handle: PackHandle,
  input: InitialSaveInput,
): Promise<void> {
  const imageCapture = input.captureKind === 'image'
  await settleDisplayWrites(handle.dirPath)
  return withManifestMutation(handle.dirPath, async () => {
  const previous = await readManifestIfPresent(handle.dirPath)
  const contextDisposition = await reconcileWindowsContextPlugin(
    handle.dirPath,
    imageCapture ? null : input.windowsContext,
  )
  const manifest = buildManifest({
    id: handle.id,
    createdAt: input.capturedAt,
    generatorVersion: app.getVersion(),
    title: '',
    note: '',
    osVersion: release(),
    screens: input.screens ?? physicalScreens(),
    captureKind: input.captureKind,
    imageScope: input.imageScope,
    cropBounds: input.cropBounds,
    hasReplay: !imageCapture && input.replayWebm !== null,
    replayFile: input.replayFile,
    replayDurationMs: input.replayDurationMs,
    snapshotTMs: null,
    trimOffsetMs: input.trimOffsetMs,
    plugins: withWindowsContextPlugin(previous?.plugins, contextDisposition),
    displays: imageCapture ? undefined : input.displays,
    cadence: imageCapture ? undefined : input.cadence ?? previous?.media.cadence,
  })
  const annotationsFile: AnnotationsFile = {
    reference_width: input.width,
    reference_height: input.height,
    annotations: [],
  }
  await writePackFiles(
    handle.dirPath,
    manifest,
    annotationsFile,
    input.timeline,
    input.docLanguage,
    false,
  )
  await writeDisplayFiles(handle.dirPath, imageCapture ? undefined : input.displays)
  const replayFile = replayFileName(input.replayFile)
  if (imageCapture || input.replayWebm === null) {
    await rm(join(handle.dirPath, replayFile), { force: true })
  }
  else await writeFile(join(handle.dirPath, replayFile), input.replayWebm)
  await removeReplacedReplayFiles(handle.dirPath, previous, manifest)
  })
}

export interface UpdatePackOptions {
  // Re-edit mode (GOAL "History — Save after re-edit"): the declared replay is
  // NEVER rewritten, re-encoded, or deleted — the file already on disk stays the
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
  // A save-first per-display write may still be in flight for this folder; the
  // rewrite below must not race it.
  await settleDisplayWrites(handle.dirPath)
  return withManifestMutation(handle.dirPath, async () => {
  const previousManifest = await readManifestIfPresent(handle.dirPath)
  const imageCapture = input.captureKind === 'image'
  const keepReplay = !imageCapture && options.keepReplay === true
  // The replay is whatever the pack DECLARES it is (SPEC §5.3 allows .mp4):
  // testing for replay.webm here would silently orphan a legal replay.mp4 and
  // drop replay_duration_ms / snapshot_t_ms / every annotation lifetime with it.
  const replayFile = replayFileName(input.replayFile)
  const hasReplay = !imageCapture && (keepReplay
    ? existsSync(join(handle.dirPath, replayFile))
    : input.replayWebm !== null)
  // The plugin payload goes down BEFORE the manifest that declares it, and its
  // failure is swallowed: object data is a best-effort extra and must never
  // cost the user a save (GOAL "Static object picking"). A payload that did not
  // land is simply not declared.
  const uiaWritten = await tryWriteUiaPlugin(handle.dirPath, input.uia)
  const contextDisposition = await reconcileWindowsContextPlugin(
    handle.dirPath,
    imageCapture ? null : input.windowsContext,
  )
  const manifest = buildManifest({
    id: handle.id,
    createdAt: input.capturedAt,
    generatorVersion: app.getVersion(),
    title: input.title,
    note: input.note,
    osVersion: release(),
    screens: input.screens ?? physicalScreens(),
    captureKind: input.captureKind,
    imageScope: input.imageScope,
    cropBounds: input.cropBounds,
    hasReplay,
    replayFile,
    replayDurationMs: input.replayDurationMs,
    snapshotTMs: input.snapshotTMs,
    trimOffsetMs: input.trimOffsetMs,
    plugins: withWindowsContextPlugin(
      withUiaPlugin(
        withPreservedPlugins(previousManifest?.plugins, input.plugins),
        uiaWritten,
      ),
      contextDisposition,
    ),
    displays: imageCapture ? undefined : input.displays,
    cadence:
      imageCapture
        ? undefined
        : input.cadence ?? previousManifest?.media.cadence,
    usesKeyframes: input.annotations.some((a) => (a.keyframes?.length ?? 0) > 0),
  })
  const annotationsFile: AnnotationsFile = {
    reference_width: input.width,
    reference_height: input.height,
    annotations: input.annotations,
  }
  // Save time (not capturedAt) — this event records when the pack was written.
  const timeline = withExportEvent(input.timeline, new Date())

  // A background render always follows this save (annotated replay + stills, or
  // the single still of a screenshot-only pack), so the documents may reference
  // the keyframe files it is about to write.
  await writePackFiles(handle.dirPath, manifest, annotationsFile, timeline, input.docLanguage, true)
  await writeFile(join(handle.dirPath, 'snapshot.png'), input.snapshotPng)
  // Non-focused displays: rewritten from the same bytes save-first used (a
  // failed save-first retries the whole write here). Re-edit passes null
  // buffers, so the files already on disk are left alone.
  await writeDisplayFiles(handle.dirPath, imageCapture ? undefined : input.displays)
  // A stale annotated replay must never outlive the annotations that produced
  // it: the background render rewrites it (and re-declares it in the manifest)
  // after this save. The annotated keyframe stills follow the same rule — the
  // manifest written above declares neither, so both are removed here and the
  // render puts back exactly the current set (SPEC §5.7).
  await rm(join(handle.dirPath, 'replay_annotated.webm'), { force: true })
  await rm(join(handle.dirPath, 'frames'), { recursive: true, force: true })
  // Same rule per display (GOAL "Multi-Monitor Support"): a screen the user
  // just un-annotated must not keep an annotated replay showing boxes that no
  // longer exist. Removed for EVERY declared display; the renders that follow
  // put back only the ones that still have annotations.
  await clearDisplayRenderOutputs(handle.dirPath, imageCapture ? undefined : input.displays)
  if (!keepReplay) {
    if (imageCapture || input.replayWebm === null) {
      // The user excluded the replay at save time (e.g. privacy).
      await rm(join(handle.dirPath, replayFile), { force: true })
    } else {
      await writeFile(join(handle.dirPath, replayFile), input.replayWebm)
    }
  }
  await removeReplacedReplayFiles(handle.dirPath, previousManifest, manifest)

  // The clipboard is NOT written here. This function also runs as the tail of a
  // background finalize that re-encodes 30 s of 4K, which took over a minute on
  // the machine this was reported from — so a copy at this point lands long
  // after the user has already pressed Ctrl+V and got nothing, and then
  // overwrites whatever they copied in the meantime. The caller copies at the
  // instant the folder exists instead (session.ts, beside the toast).
  return handle.dirPath
  })
}

async function readManifestIfPresent(dirPath: string): Promise<Manifest | null> {
  try {
    return JSON.parse(await readFile(join(dirPath, 'manifest.json'), 'utf8')) as Manifest
  } catch {
    return null
  }
}

/**
 * A background exact-length cut can change MP4 recorder evidence into the WebM
 * produced by the plain render path. Remove the old, now-undeclared filename so
 * a pack never retains a stale oversized replay beside the exact one.
 */
async function removeReplacedReplayFiles(
  dirPath: string,
  previous: Manifest | null,
  current: Manifest,
): Promise<void> {
  const oldTop =
    typeof previous?.media?.replay === 'string' && REPLAY_NAME_RE.test(previous.media.replay)
      ? previous.media.replay
      : null
  if (oldTop !== null && oldTop !== current.media.replay) {
    await rm(join(dirPath, oldTop), { force: true })
  }

  const currentDisplays = new Map(
    (current.media.displays ?? []).map((d) => [d.index, d.replay] as const),
  )
  for (const old of previous?.media?.displays ?? []) {
    if (old.focused || typeof old.replay !== 'string') continue
    if (!DISPLAY_REPLAY_NAME_RE.test(old.replay)) continue
    if (currentDisplays.get(old.index) === old.replay) continue
    await rm(join(dirPath, old.replay), { force: true })
  }
}

const PLUGIN_DIRECTORY_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
const IMAGE_PACK_BLOCKED_PLUGIN_EXTENSIONS = new Set([
  '.avi',
  '.avif',
  '.bmp',
  '.dib',
  '.gif',
  '.heic',
  '.heif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.jpe',
  '.m4v',
  '.mkv',
  '.mov',
  '.mp4',
  '.mpeg',
  '.mpg',
  '.png',
  '.tif',
  '.tiff',
  '.webm',
  '.webp',
  '.wmv',
])

function startsWithBytes(value: Buffer, bytes: readonly number[], offset = 0): boolean {
  if (value.length < offset + bytes.length) return false
  return bytes.every((byte, index) => value[offset + index] === byte)
}

/**
 * Extension checks are only a convenience; a renamed `context.json` can still
 * be a complete PNG or MP4. Image Save As New therefore sniffs the small,
 * format-identifying prefix and fails closed for every common raster/video
 * container the pack validator recognises.
 */
function hasRasterOrVideoMagic(value: Buffer): boolean {
  return (
    startsWithBytes(value, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    startsWithBytes(value, [0xff, 0xd8, 0xff]) ||
    value.subarray(0, 6).toString('ascii') === 'GIF87a' ||
    value.subarray(0, 6).toString('ascii') === 'GIF89a' ||
    value.subarray(0, 2).toString('ascii') === 'BM' ||
    startsWithBytes(value, [0x49, 0x49, 0x2a, 0x00]) ||
    startsWithBytes(value, [0x4d, 0x4d, 0x00, 0x2a]) ||
    (
      value.subarray(0, 4).toString('ascii') === 'RIFF' &&
      ['WEBP', 'AVI '].includes(value.subarray(8, 12).toString('ascii'))
    ) ||
    value.subarray(4, 8).toString('ascii') === 'ftyp' ||
    startsWithBytes(value, [0x1a, 0x45, 0xdf, 0xa3]) ||
    startsWithBytes(value, [0x00, 0x00, 0x01, 0xba]) ||
    startsWithBytes(value, [0x00, 0x00, 0x01, 0xb3]) ||
    startsWithBytes(value, [0x00, 0x00, 0x00, 0x01])
  )
}

async function imagePluginEntryIsMetadata(sourcePath: string): Promise<boolean> {
  try {
    const info = await lstat(sourcePath)
    // A symlink can point outside the pack, and cp() otherwise preserves it.
    // Metadata preservation never needs links or special filesystem nodes.
    if (info.isSymbolicLink()) return false
    if (info.isDirectory()) return true
    if (!info.isFile()) return false
    if (IMAGE_PACK_BLOCKED_PLUGIN_EXTENSIONS.has(extname(sourcePath).toLowerCase())) {
      return false
    }
    const handle = await open(sourcePath, 'r')
    try {
      const header = Buffer.alloc(16)
      const { bytesRead } = await handle.read(header, 0, header.length, 0)
      return !hasRasterOrVideoMagic(header.subarray(0, bytesRead))
    } finally {
      await handle.close()
    }
  } catch {
    // Plugin data is optional. An entry that cannot be inspected must not cross
    // the image privacy boundary merely because the filesystem raced us.
    return false
  }
}

async function copyImagePluginMetadata(
  sourceDir: string,
  targetDir: string,
  plugins: Manifest['plugins'] | undefined,
): Promise<Manifest['plugins']> {
  const copied: Manifest['plugins'] = []
  const seen = new Set<string>()
  for (const declaration of plugins ?? []) {
    if (
      declaration === null ||
      typeof declaration !== 'object' ||
      typeof declaration.name !== 'string' ||
      !PLUGIN_DIRECTORY_NAME_RE.test(declaration.name) ||
      seen.has(declaration.name)
    ) {
      continue
    }
    seen.add(declaration.name)
    const source = join(sourceDir, 'plugins', declaration.name)
    const target = join(targetDir, 'plugins', declaration.name)
    if (!existsSync(source)) continue
    await cp(source, target, {
      recursive: true,
      filter: imagePluginEntryIsMetadata,
    })
    try {
      const meta = await lstat(join(target, 'meta.json'))
      if (meta.isFile()) copied.push(declaration)
    } catch {
      // A declaration without ordinary meta.json is not a copied plugin.
    }
  }
  return copied
}

/**
 * Save As New CapturePack (GOAL "History — Save after re-edit"): writes the
 * edited state into a NEW folder (CapturePack_<now>, collision-suffixed) with
 * a NEW manifest id, copying the declared replay from the source pack byte-for-byte.
 * The original folder is never touched. Docs are regenerated from the edited
 * data; replay_annotated is NOT copied (it is stale relative to the edited
 * annotations — the caller starts a background render for the new folder).
 */
/**
 * Annotations restricted to the display set a pack actually declares (SPEC
 * §8.8): a `display` that names no declared entry is DROPPED from the box, so
 * the box resolves to the focused display instead of carrying an index that
 * fails validation, renders into nothing, and disappears from the documents.
 * `undefined` declarations = a single-display pack, where no box may carry one.
 */
function withDeclaredDisplays(
  annotations: readonly Annotation[],
  displays: readonly DisplayDeclaration[] | undefined,
): Annotation[] {
  const declared = new Set((displays ?? []).map((d) => d.index))
  return annotations.map((a) => {
    if (a.display === undefined || declared.has(a.display)) return a
    const { display: _dropped, ...rest } = a
    return rest
  })
}

export async function saveAsNewPack(sourceDir: string, input: ExportInput): Promise<PackHandle> {
  // The source folder may still be finishing its save-first per-display write.
  await settleDisplayWrites(sourceDir)
  const sourceManifest = await readManifestIfPresent(sourceDir)
  const id = randomUUID()
  const imageCapture = input.captureKind === 'image'
  const replayFile = replayFileName(input.replayFile)
  const srcReplay = join(sourceDir, replayFile)
  const hasReplay = !imageCapture && existsSync(srcReplay)
  // All-displays pack: only the per-display files actually present in the
  // source can travel, so the new pack declares exactly what it will contain.
  const displays = (imageCapture ? undefined : input.displays)?.filter(
    (d) => d.focused || existsSync(join(sourceDir, d.snapshotFile)),
  )
  const surviving: DisplayCapture[] | undefined = displays?.map((d) =>
    d.focused
      ? d
      : {
          ...d,
          hasReplay:
            d.hasReplay && d.replayFile !== null && existsSync(join(sourceDir, d.replayFile)),
        },
  )
  // Fewer than two surviving displays is a SINGLE-display pack: media.displays
  // exists only for a capture that covered more than one (SPEC §5.6).
  const displayFiles = surviving !== undefined && surviving.length > 1 ? surviving : undefined
  // A box may only name a display this pack DECLARES (SPEC §8.8). Anything the
  // filter above dropped resolves back to the focused display — the field is
  // removed, which is what "absent = focused" means — rather than being written
  // as an index nothing in the new pack can resolve.
  const annotations = withDeclaredDisplays(input.annotations, displayFiles)
  const annotationsFile: AnnotationsFile = {
    reference_width: input.width,
    reference_height: input.height,
    annotations,
  }
  const timeline = withExportEvent(input.timeline, new Date())

  // The new pack lands next to its source (same parent folder), named by the
  // save instant so it can never collide with the original.
  const dirPath = uniquePackDir(dirname(sourceDir), new Date())
  try {
    await mkdir(dirPath)
    // Copy pack-backed plugins first, then apply the caller's temporal-context
    // disposition. For video, plugin payloads remain byte-for-byte. An image
    // pack has a stricter boundary: only DECLARED plugin metadata may cross,
    // and neither a media extension nor renamed raster/video magic is copied.
    // Otherwise Save As New could turn plugins/hidden.png from a malformed
    // source into an undeclared full-screen image in a newly trusted pack.
    const srcPlugins = join(sourceDir, 'plugins')
    let copiedPlugins = input.plugins
    if (existsSync(srcPlugins)) {
      if (imageCapture) {
        copiedPlugins = await copyImagePluginMetadata(sourceDir, dirPath, input.plugins)
      } else {
        await cp(srcPlugins, join(dirPath, 'plugins'), { recursive: true })
      }
    } else if (imageCapture) {
      copiedPlugins = []
    }
    const contextDisposition = await reconcileWindowsContextPlugin(
      dirPath,
      imageCapture ? null : input.windowsContext,
    )
    const manifest = buildManifest({
      id,
      createdAt: input.capturedAt,
      generatorVersion: app.getVersion(),
      title: input.title,
      note: input.note,
      osVersion: release(),
      screens: input.screens ?? physicalScreens(),
      captureKind: input.captureKind,
      imageScope: input.imageScope,
      cropBounds: input.cropBounds,
      hasReplay,
      replayFile,
      replayDurationMs: input.replayDurationMs,
      snapshotTMs: input.snapshotTMs,
      trimOffsetMs: input.trimOffsetMs,
      plugins: withWindowsContextPlugin(copiedPlugins, contextDisposition),
      displays: displayFiles,
      cadence: imageCapture ? undefined : input.cadence ?? sourceManifest?.media.cadence,
      usesKeyframes: annotations.some((a) => (a.keyframes?.length ?? 0) > 0),
    })
    // A background render for the NEW folder always follows this save.
    await writePackFiles(dirPath, manifest, annotationsFile, timeline, input.docLanguage, true)
    await writeFile(join(dirPath, 'snapshot.png'), input.snapshotPng)
    if (hasReplay) await copyFile(srcReplay, join(dirPath, replayFile))
    // Per-display media travels byte-for-byte with its declaration — under the
    // names the source pack declared, never names re-derived from the index.
    for (const d of displayFiles ?? []) {
      if (d.focused) continue
      const snapName = d.snapshotFile
      if (d.snapshotPng !== null) await writeFile(join(dirPath, snapName), d.snapshotPng)
      else await copyFile(join(sourceDir, snapName), join(dirPath, snapName))
      if (!d.hasReplay || d.replayFile === null) continue
      const replayName = d.replayFile
      if (d.replayWebm !== null) await writeFile(join(dirPath, replayName), d.replayWebm)
      else await copyFile(join(sourceDir, replayName), join(dirPath, replayName))
    }
  } catch (err) {
    // Never leave a half-written pack behind.
    await rm(dirPath, { recursive: true, force: true })
    throw err
  }

  await copyAfterSave(input.clipboardAfterSave, dirPath)
  return { id, dirPath }
}

/**
 * The metadata + generated documents common to save-first and finalize.
 *
 * `renderPending` is what lets the documents reference the annotated keyframe
 * stills BEFORE the background render has written them (the shared rule in
 * shared/keyframes.ts makes the filenames deterministic). It is false for a
 * save-first folder, which no render ever follows — the documents of a
 * cancelled capture must not link images that will never exist (SPEC §12.2).
 */
async function writePackFiles(
  dirPath: string,
  manifest: Manifest,
  annotationsFile: AnnotationsFile,
  timeline: TimelineFile,
  docLanguage: Language = 'en',
  renderPending = false,
): Promise<void> {
  await mkdir(join(dirPath, 'skills'), { recursive: true })
  await mkdir(join(dirPath, 'plugins'), { recursive: true })
  // The manifest is the pack's discovery/identity commit point. Publish every
  // source it describes first, then publish the manifest last. On an initial
  // save this prevents History/MCP from indexing a half-written folder; on an
  // update it prevents a new manifest from pointing at the old annotations.
  await writeSourceFile(join(dirPath, 'annotations.json'), toJson(annotationsFile))
  if (manifest.capture_kind === 'image') {
    // A still image has no capture/replay clock. Keeping the editor's internal
    // event buffer here made image packs look like truncated video packs and
    // sent readers toward a timeline that has no meaning for the artifact.
    // Remove a stale copy as well (for packs rewritten by a newer build).
    await rm(join(dirPath, 'timeline.json'), { force: true })
  } else {
    await writeSourceFile(join(dirPath, 'timeline.json'), toJson(timeline))
  }
  const viewerWritten = await writeViewerNonFatal(
    dirPath,
    manifest,
    annotationsFile,
    timeline,
    docLanguage,
  )
  await writeDocs(
    dirPath,
    manifest,
    annotationsFile,
    timeline,
    docLanguage,
    renderPending,
    viewerWritten,
  )
  await writeSourceFile(join(dirPath, 'manifest.json'), toJson(manifest))
}

/** report.md + README.md + skills/ — Markdown generated documents, one writer. */
async function writeDocs(
  dirPath: string,
  manifest: Manifest,
  annotationsFile: AnnotationsFile,
  timeline: TimelineFile,
  docLanguage: Language,
  renderPending: boolean,
  includeViewer: boolean,
): Promise<void> {
  const skills = buildSkills(manifest, annotationsFile, timeline, docLanguage, renderPending)
  await writeSourceFile(
    join(dirPath, 'report.md'),
    buildReport(manifest, annotationsFile, docLanguage, renderPending, includeViewer),
  )
  await writeSourceFile(
    join(dirPath, 'README.md'),
    buildReadme(manifest, annotationsFile, docLanguage, renderPending, includeViewer),
  )
  const skillFiles =
    manifest.capture_kind === 'image'
      ? SKILLS_FILES.filter((name) => name !== 'timeline')
      : SKILLS_FILES
  if (manifest.capture_kind === 'image') {
    await rm(join(dirPath, 'skills', 'timeline.md'), { force: true })
  }
  for (const name of skillFiles) {
    await writeSourceFile(join(dirPath, 'skills', `${name}.md`), skills[name])
  }
}

/**
 * Regenerates the three documents from what is ON DISK now — called once the
 * background render has declared its outputs.
 *
 * The documents are written BEFORE the render, from the deterministic keyframe
 * rule, so they can name stills that do not exist yet. If the render then
 * produced a different set (a still that failed to encode is dropped and the
 * survivors renumber, SPEC §5.7 requires NN == array position), every later
 * image link in report.md/README.md/skills/overview.md would point at a file
 * that was never written. Rewriting them from the finished declaration is what
 * makes "the documents describe the pack" true again.
 *
 * Never fatal: a pack whose documents could not be refreshed is still valid.
 */
export async function refreshPackDocs(dirPath: string, docLanguage: Language = 'en'): Promise<void> {
  return withManifestMutation(dirPath, async () => {
    const manifest = JSON.parse(await readFile(join(dirPath, 'manifest.json'), 'utf8')) as Manifest
    const annotationsFile = JSON.parse(
      await readFile(join(dirPath, 'annotations.json'), 'utf8'),
    ) as AnnotationsFile
    if (!Array.isArray(annotationsFile.annotations)) return
    let timeline: TimelineFile = { t0: manifest.created_at, events: [] }
    if (manifest.capture_kind !== 'image') {
      timeline = JSON.parse(await readFile(join(dirPath, 'timeline.json'), 'utf8')) as TimelineFile
      if (!Array.isArray(timeline.events)) return
    }
    // The render has already run: nothing further will write stills, so an
    // undeclared keyframe set is an ABSENT one, not a pending one.
    const previousFormatVersion = manifest.format_version
    const viewerWritten = await writeViewerNonFatal(
      dirPath,
      manifest,
      annotationsFile,
      timeline,
      docLanguage,
    )
    if (manifest.format_version !== previousFormatVersion) {
      await writeSourceFile(join(dirPath, 'manifest.json'), toJson(manifest))
    }
    await writeDocs(
      dirPath,
      manifest,
      annotationsFile,
      timeline,
      docLanguage,
      false,
      viewerWritten,
    )
  })
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
  outputs: {
    replayAnnotated: boolean
    keyframes: readonly ManifestKeyframe[]
    // WHICH display these outputs belong to (GOAL "Multi-Monitor Support").
    // Absent = the focused display, whose outputs ARE the top-level media
    // (media.replay_annotated / media.keyframes). A 1-based index declares
    // that display's own outputs inside its media.displays entry (SPEC §5.6) —
    // its own boxes, burned into its own replay and its own stills.
    display?: number
  },
): Promise<void> {
  return withManifestMutation(handle.dirPath, async () => {
  const manifestPath = join(handle.dirPath, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest
  // Belt and braces against a second render for the same folder having wiped
  // the stills between this render's writes and this declaration: a declared
  // file MUST exist (SPEC §5.7). Renders are serialized (annotatedRender.ts),
  // so this normally truncates nothing. A PREFIX rather than a filter: NN is
  // the entry's 1-based position, so skipping a middle entry would be invalid.
  const present: ManifestKeyframe[] = []
  for (const k of outputs.keyframes) {
    if (!existsSync(join(handle.dirPath, k.file))) break
    present.push(k)
  }
  const declared = present.map((k) => ({ file: k.file, t_ms: k.t_ms }))

  if (outputs.display !== undefined) {
    const displays = manifest.media.displays
    const entry = Array.isArray(displays)
      ? displays.find((d) => d !== null && typeof d === 'object' && d.index === outputs.display)
      : undefined
    // The pack no longer declares this display (a re-edit dropped it): its
    // files are undeclared and readers ignore them — never invent an entry.
    if (entry === undefined) return
    if (outputs.replayAnnotated && entry.replay !== null) {
      entry.replay_annotated = displayAnnotatedName(entry.index)
    }
    if (declared.length > 0) entry.keyframes = declared
    else delete entry.keyframes
    await writeSourceFile(manifestPath, toJson(manifest))
    return
  }

  // Never declared without a replay (SPEC §5.3) — keyframes have no such rule:
  // a screenshot-only pack has exactly one still, rendered from snapshot.png.
  if (outputs.replayAnnotated && manifest.media.replay !== null) {
    manifest.media.replay_annotated = 'replay_annotated.webm'
  }
  if (declared.length > 0) manifest.media.keyframes = declared
  else delete manifest.media.keyframes
  await writeSourceFile(manifestPath, toJson(manifest))
  })
}

/**
 * On-demand distribution ZIP (toast [Create ZIP]): sibling {folder}.capturepack
 * with the folder CONTENTS at the archive root (SPEC §3.2). Returns the zip path.
 */
/**
 * Zips a pack folder for sending, as a `.zip`.
 *
 * IT USED TO WRITE `.capturepack`, AND THAT WAS A MISTAKE. The bytes were
 * always an ordinary zip archive, so the private extension bought nothing and
 * cost a great deal: Windows shows it as an unknown file with no icon and no
 * "Extract All", every chat client and mail server treats it as an unrecognised
 * binary rather than an archive it can preview, and the person on the other end
 * has to be told to rename it before they can open it. A format that a stranger
 * can read is the entire point of this project (GOAL "Philosophy"), and the
 * extension was the one place the pack refused to say what it was.
 *
 * The FORMAT is still CapturePack — manifest.json says so, and the folder
 * inside is unchanged. Only the wrapper now admits to being a zip.
 */
export async function createPackZip(dirPath: string): Promise<string> {
  const zipPath = `${dirPath}.zip`
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
/**
 * Puts the saved pack on the clipboard, in whichever form the user asked for.
 *
 * AUTOMATIC, AND NOT ALWAYS THE FOLDER. This runs the instant the pack lands,
 * so nothing has to be copied by hand afterwards — and the default is the
 * PROMPT, because the next thing a pack is used for is almost always being
 * handed to an LLM, and that is a sentence with the path already in it. The
 * folder and the bare path stay available for the cases where a file manager
 * or a terminal is the destination instead.
 */
export async function copyAfterSave(
  mode: ClipboardAfterSave,
  dirPath: string,
): Promise<boolean> {
  if (mode === 'off') return true
  if (mode === 'folder') {
    copyFolderToClipboard(dirPath)
    return true
  }
  return await copyTextToClipboard(mode === 'path' ? dirPath : analyzePackPrompt(dirPath))
}

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
