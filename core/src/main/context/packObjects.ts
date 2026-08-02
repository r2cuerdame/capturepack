// A SAVED PACK'S OBJECT CONTEXT, REBUILT FROM DISK (#134).
//
// Everything needed to answer "what would picking offer here?" is in the pack —
// plugins/windows-uia/elements.json, plugins/chrome-dom/elements.json,
// plugins/windows-context/timeline.json and the snapshot rasters — but until
// now the only code that assembled them was ~120 lines in the middle of the
// re-edit flow in session.ts, between a BrowserWindow and an IPC push. So the
// answer existed only while an editor was open and a human was hovering, which
// is why "hover select feels wrong" could be true for three releases with every
// check green: a pack with picking data and a pack with USEFUL picking data are
// indistinguishable to anything that only reads the file.
//
// This is that assembly with the window taken off it. It reads a pack folder
// and hands back exactly the ContextSessionOptions the re-edit builds, so what
// a measurement (scripts/pick-quality-check.ts) or an external reader sees is
// the SAME ladder the editor sees — Core's window floor, the UIA control rung,
// the browser's document rung — not a reimplementation that can drift from it.
//
// DELIBERATELY FREE OF ELECTRON, like context/session.ts below it: the pack is
// the input, the filesystem is the only dependency, and nothing here asks the
// running desktop anything. A reader that had to boot Electron to open a folder
// would not be a reader.
//
// WHAT IT DOES NOT DO: decide anything. Which displays exist, which index an
// entry with no `display` field belongs to, whether a payload is trustworthy —
// each of those has one owner already (reopenDisplay.ts, focusedDisplayIndex,
// parseUiaPayload), and this module calls them rather than re-deciding.
import { existsSync, readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { parseDomPayload } from '../chrome/domBridge'
import type { DomEvent } from '../chrome/domBridge'
import { parseUiaPayload } from '../uia'
import { focusedDisplayIndex } from '../../shared/types'
import type { Manifest, UiaPluginPayload } from '../../shared/types'
import { reopenedContextDisplayTargets } from '../reopenDisplay'
import { editorUiaElements, editorUiaWindows } from './legacyPack'
import { loadWindowsContextHistory } from './windowsContextTimeline'
import { ContextSession } from './session'
import type { ContextDisplayTarget, ContextSessionOptions } from './session'
import type { ContextObservation } from './buffer'

/** One pack folder, read as the re-edit reads it. */
export interface PackObjectContext {
  dirPath: string
  captureKind: 'image' | 'video'
  /** The pack clock's end — where the capture-instant dump sits (SPEC §10.1). */
  replayDurationMs: number
  /** Every captured display, in the pack's own 1-based indexing (SPEC §5.6). */
  displays: readonly ContextDisplayTarget[]
  /** The capture-instant UI Automation observation, or null when there is none. */
  observation: ContextObservation | null
  /** Whether a payload IS there and unreadable — never "there never was one". */
  dropped: boolean
  /** The temporal window history, when the pack carries one (video packs do). */
  history: readonly ContextObservation[]
  domEvents: readonly DomEvent[]
  /**
   * Element rectangles the chrome-dom payload DECLARES, counted off the raw
   * JSON — beside `domEvents`, which is what survived validation.
   *
   * The two are reported separately because their difference is the whole
   * subject of #130: "340 rectangles written to disk and none of them offered
   * to the editor... is indistinguishable, from the outside, from not
   * collecting it at all". A reader that only published the parsed count could
   * not tell a pack that carries no page from a pack whose page it just threw
   * away, and neither could anything measuring it.
   */
  domRectanglesDeclared: number
  /** Why a pack has no object context at all, for a caller that must say so. */
  note: string | null
}

/**
 * A pack folder as the two loaders above it expect one.
 *
 * `loadWindowsContextHistory` takes a reader rather than a path precisely so it
 * can be handed a zip, a fixture or a folder; this is the folder.
 */
function packReader(dirPath: string): {
  fileSize(rel: string): number | null
  readText(rel: string): string | null
} {
  const resolve = (rel: string): string => path.join(dirPath, rel)
  return {
    fileSize(rel: string): number | null {
      try {
        return statSync(resolve(rel)).size
      } catch {
        return null
      }
    },
    readText(rel: string): string | null {
      try {
        return readFileSync(resolve(rel), 'utf8')
      } catch {
        return null
      }
    },
  }
}

/**
 * A PNG's declared pixel size, straight out of its IHDR — 8-byte signature,
 * then the first chunk, which a PNG REQUIRES to be IHDR.
 *
 * MEASURED FROM THE FILE, never copied from `snapshot_width`/`snapshot_height`:
 * the declaration exists from format 0.7.0 only, and a declaration that
 * disagrees with its own raster is a bug this reader must expose rather than
 * inherit (SPEC §5.6). Reading 24 bytes also means opening a folder of 4K packs
 * costs no decode at all.
 */
function pngPixelSize(file: string): { width: number; height: number } | null {
  let head: Buffer
  try {
    head = readFileSync(file)
  } catch {
    return null
  }
  if (head.length < 24 || head.toString('ascii', 12, 16) !== 'IHDR') return null
  const width = head.readUInt32BE(16)
  const height = head.readUInt32BE(20)
  return width > 0 && height > 0 ? { width, height } : null
}

function readManifest(dirPath: string): Manifest | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(dirPath, 'manifest.json'), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    return parsed as Manifest
  } catch {
    return null
  }
}

/**
 * The displays a reader may probe, in the pack's own indexing.
 *
 * A multi-display pack declares them; a still declares nothing and IS its one
 * snapshot — which for a region capture is the crop, in the crop's own pixel
 * space (imageContext.ts rewrote every rectangle into it at save time). Either
 * way the rectangle an annotation lives in is the raster on disk, so that is
 * what gets measured, and the index for a display whose file has since gone
 * missing is simply not offered rather than guessed at.
 */
function packDisplays(dirPath: string, manifest: Manifest): ContextDisplayTarget[] {
  const declared = manifest.media?.displays
  const loaded = Array.isArray(declared)
    ? declared.flatMap((display) => {
        if (display === null || typeof display !== 'object') return []
        const file = display.focused === true ? 'snapshot.png' : display.snapshot
        if (typeof file !== 'string' || file === '') return []
        const size = pngPixelSize(path.join(dirPath, file))
        if (size === null) return []
        return [{
          index: display.index,
          focused: display.focused === true,
          width: size.width,
          height: size.height,
          scale: typeof display.scale === 'number' && display.scale > 0 ? display.scale : 1,
        }]
      })
    : []
  const snapshot = pngPixelSize(path.join(dirPath, 'snapshot.png'))
  return reopenedContextDisplayTargets({
    snapshotWidth: snapshot?.width ?? 0,
    snapshotHeight: snapshot?.height ?? 0,
    screens: Array.isArray(manifest.environment?.screens) ? manifest.environment.screens : [],
    displays: manifest.media?.displays,
    loadedDisplays: loaded,
  })
}

/**
 * How many element rectangles a chrome-dom payload claims, straight off the
 * JSON: one per `dom.element.selected` pick plus every entry of a captured
 * document. Counted WITHOUT validating anything, on purpose — see
 * `domRectanglesDeclared`.
 */
function declaredDomRectangles(text: string | null): number {
  if (text === null) return 0
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return 0
  }
  if (parsed === null || typeof parsed !== 'object') return 0
  const events = (parsed as { events?: unknown }).events
  if (!Array.isArray(events)) return 0
  let total = 0
  for (const entry of events) {
    if (entry === null || typeof entry !== 'object') continue
    const event = entry as { element?: unknown; document?: { elements?: unknown } }
    if (event.element !== null && typeof event.element === 'object') total += 1
    const elements = event.document?.elements
    if (Array.isArray(elements)) total += elements.length
  }
  return total
}

/** True when the payload is there and says nothing — see `dropped` (SPEC §11.3). */
function uiaEmpty(payload: UiaPluginPayload | null): boolean {
  return payload === null || (payload.windows.length === 0 && payload.elements.length === 0)
}

/**
 * Reads one pack folder into the inputs a ContextSession is built from.
 *
 * Returns `note` rather than throwing for a pack that has nothing to offer: a
 * folder that is not a pack, or one with no snapshot, is an ordinary thing to
 * meet when sweeping a directory, and a reader that dies on it can only be used
 * on hand-picked input.
 */
export function readPackObjectContext(dirPath: string): PackObjectContext | null {
  const manifest = readManifest(dirPath)
  if (manifest === null) return null
  const captureKind: 'image' | 'video' = manifest.capture_kind === 'video' ? 'video' : 'image'
  const declaredDurationMs =
    typeof manifest.media?.replay_duration_ms === 'number'
      ? Math.max(0, Math.round(manifest.media.replay_duration_ms))
      : 0
  // A still is one instant, and its pack clock is 0 — the same rule
  // session.ts's image flow applies when it opens the editor at t=0.
  const replayDurationMs = captureKind === 'video' ? declaredDurationMs : 0
  const displays = packDisplays(dirPath, manifest)
  if (displays.length === 0) return null

  const pack = packReader(dirPath)
  const uiaText = pack.readText('plugins/windows-uia/elements.json')
  const uia = parseUiaPayload(uiaText)
  const focused = focusedDisplayIndex(manifest.media?.displays)
  const observation: ContextObservation | null = uiaEmpty(uia)
    ? null
    : {
        tMs: replayDurationMs,
        windows: editorUiaWindows(uia, focused),
        elements: editorUiaElements(uia, focused),
      }
  const history = loadWindowsContextHistory(pack, declaredDurationMs)
  const domText = pack.readText('plugins/chrome-dom/elements.json')
  return {
    dirPath,
    captureKind,
    replayDurationMs,
    displays,
    observation,
    // A pack that never had object data is not a pack whose object data was
    // DROPPED — the flag is only for a payload that is there and unreadable.
    dropped: uiaText !== null && uiaEmpty(uia),
    history: history.status === 'loaded' ? history.observations : [],
    domEvents: parseDomPayload(domText),
    domRectanglesDeclared: declaredDomRectangles(domText),
    note:
      observation === null && history.status !== 'loaded'
        ? 'no object payload'
        : null,
  }
}

/**
 * The pack's context session — the same class the editor's window opens, with
 * the same providers registered through the same gate.
 *
 * The temporal history is adopted exactly as the re-edit adopts it, including
 * the guard against an all-empty ring replacing a valid capture-instant dump: a
 * reader that skipped that would answer differently from the editor for every
 * video pack whose checkpoints were filtered away, which is the one thing this
 * module exists not to do.
 */
export function openPackContextSession(
  context: PackObjectContext,
  options: Pick<ContextSessionOptions, 'onWarn' | 'onInfo'> = {},
): ContextSession {
  const session = new ContextSession(`pack:${path.basename(context.dirPath)}`, {
    displays: context.displays,
    replayDurationMs: context.replayDurationMs,
    observation: context.observation,
    dropped: context.dropped,
    domEvents: context.domEvents,
    ...options,
  })
  if (
    context.history.length > 0 &&
    context.history.some((observation) => observation.windows.length > 0)
  ) {
    session.adoptAll(context.history)
  }
  return session
}

/** Whether this folder even looks like a pack, before anything is parsed. */
export function isPackFolder(dirPath: string): boolean {
  return existsSync(path.join(dirPath, 'manifest.json'))
}
