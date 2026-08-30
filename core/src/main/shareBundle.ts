// Privacy-aware Share Copy.
//
// This is intentionally NOT a reduced CapturePack. A CapturePack's
// snapshot.png and replay are original evidence by contract; removing them
// while leaving manifest.json behind would make a broken pack, and replacing
// them with redacted bytes would make the manifest lie. A Share Copy instead
// has its own tiny `capturepack-share` inventory and contains only explicitly
// declared derived media under names generated here.
//
// Nothing from the source tree is copied recursively. In particular, no
// manifest, annotation JSON, timeline, plugin payload, generated document,
// source path, title, note, or undeclared file crosses this boundary.
import AdmZip from 'adm-zip'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, readdir, realpath, rm } from 'node:fs/promises'
import * as path from 'node:path'
import { deflateSync, inflateSync } from 'node:zlib'
import { captureMediaViolations } from '../shared/captureMedia'
import type {
  Annotation,
  Manifest,
  ManifestDisplayMedia,
  ManifestKeyframe,
} from '../shared/types'
import { moveNoReplace, MoveNoReplaceError } from './moveNoReplace'
import { isShareBundleArchive, shareBundlePath } from './packArchive'

export const SHARE_FORMAT = 'capturepack-share'
export const SHARE_FORMAT_VERSION = '0.1.0'

export type ShareMediaKind = 'annotated-still'

const MAX_SHARE_STILLS = 96
const MAX_SHARE_STILL_BYTES = 64 * 1024 * 1024
const MAX_SHARE_TOTAL_BYTES = 256 * 1024 * 1024

export interface ShareMediaPlanEntry {
  archivePath: string
  kind: ShareMediaKind
  /** null is the single composed image of an explicit image capture. */
  display: number | null
  /** Private to the local planning/creation path; never written into the ZIP. */
  sourcePath: string
  /** Pack-relative and used only for revision checks and error reporting. */
  sourceRel: string
  size: number
  mtimeMs: number
  /** Raw source hash: binds the pixels reviewed in History to creation. */
  contentSha256: string
  /** Canonical outbound hash: binds every preview to the exact ZIP bytes. */
  canonicalSha256: string
  /** Canonical container bytes and decoded RGBA footprint are capped separately. */
  canonicalSize: number
  decodedRasterBytes: number
  pixelWidth: number
  pixelHeight: number
}

export interface CanonicalShareStill {
  bytes: Buffer
  width: number
  height: number
}

export type ShareBundleBlocker = 'blur-label'

export interface ShareBundlePlan {
  revision: string
  outputPath: string
  outputName: string
  hasBlur: boolean
  entries: ShareMediaPlanEntry[]
  visibleLabels: string[]
  blockers: ShareBundleBlocker[]
}

export type ShareBundleErrorCode =
  | 'invalid-pack'
  | 'invalid-annotations'
  | 'unsafe-media-path'
  | 'derived-media-missing'
  | 'derived-media-not-ready'
  | 'pack-changed'
  | 'blocked'
  | 'output-conflict'

export class ShareBundleError extends Error {
  constructor(
    readonly code: ShareBundleErrorCode,
    readonly detail?: string,
  ) {
    super(detail === undefined ? code : `${code}: ${detail}`)
    this.name = 'ShareBundleError'
  }
}

interface ParsedPack {
  manifest: Manifest
  manifestBytes: Buffer
  annotations: Annotation[]
  annotationBytes: Buffer | null
  annotationMtimeMs: number | null
  annotationFrame: { width: number; height: number } | null
}

interface MediaCandidate {
  sourceRel: string
  archivePath: string
  kind: ShareMediaKind
  display: number | null
  declaredWidth?: number
  declaredHeight?: number
  sourceFrame?: ShareSourceFrame
}

interface ShareSourceFrame {
  width: number
  height: number
  /** Only legacy bounds × scale estimates may differ from the raster by one pixel. */
  widthTolerance: 0 | 1
  heightTolerance: 0 | 1
}

interface ShareDisplayLayout {
  focused: number | null
  displays: ManifestDisplayMedia[]
  declared: ReadonlySet<number>
  frameByDisplay: ReadonlyMap<number | null, ShareSourceFrame>
}

/**
 * Reads the small source declarations, validates/canonicalizes every declared
 * still, and hashes its raw bytes for review binding. No archive is written.
 */
export async function planShareBundle(dirPath: string): Promise<ShareBundlePlan> {
  const requestedRoot = path.resolve(dirPath)
  await assertUnaliasedDirectory(requestedRoot)
  const root = await realpath(requestedRoot).catch(() => {
    throw new ShareBundleError('invalid-pack')
  })
  const pack = await readPack(root)
  const layout = shareDisplayLayout(pack.manifest, pack.annotationFrame)
  const annotationLanes = pack.annotations.map((annotation) => annotationDisplays(annotation, layout))
  const candidates = mediaCandidates(pack.manifest, layout)
  const annotatedLaneKeys = new Set(
    annotationLanes.flatMap((displays) => [...displays].map(laneKey)),
  )
  if (
    candidates.some(
      (candidate) =>
        candidate.display !== null &&
        candidate.display !== layout.focused &&
        !annotatedLaneKeys.has(laneKey(candidate.display)),
    )
  ) {
    // Current writers render secondary stills only for displays that actually
    // carry an annotation. A declaration without such a lane is stale or
    // foreign ambiguity, not extra media that Share Copy may silently trust.
    throw new ShareBundleError('invalid-pack')
  }
  if (candidates.length === 0) {
    throw new ShareBundleError('derived-media-not-ready')
  }
  if (candidates.length > MAX_SHARE_STILLS) {
    throw new ShareBundleError('derived-media-not-ready')
  }

  const entries: ShareMediaPlanEntry[] = []
  const destinations = new Set<string>()
  let totalBytes = 0
  let totalCanonicalBytes = 0
  let totalDecodedRasterBytes = 0
  for (const candidate of candidates) {
    if (destinations.has(candidate.archivePath)) {
      throw new ShareBundleError('invalid-pack', candidate.archivePath)
    }
    destinations.add(candidate.archivePath)
    const sourcePath = await containedRegularFile(root, candidate.sourceRel)
    const fileStat = await lstat(sourcePath).catch(() => {
      throw new ShareBundleError('derived-media-missing', candidate.sourceRel)
    })
    if (fileStat.size <= 0) {
      throw new ShareBundleError('derived-media-missing', candidate.sourceRel)
    }
    if (fileStat.size > MAX_SHARE_STILL_BYTES) {
      throw new ShareBundleError('derived-media-not-ready', candidate.sourceRel)
    }
    totalBytes += fileStat.size
    if (totalBytes > MAX_SHARE_TOTAL_BYTES) {
      throw new ShareBundleError('derived-media-not-ready')
    }
    if (
      pack.annotationMtimeMs !== null &&
      fileStat.mtimeMs < pack.annotationMtimeMs
    ) {
      // A derived file older than the annotations may still contain a label or
      // blur state the user has since changed. Never package that stale view.
      throw new ShareBundleError('derived-media-not-ready', candidate.sourceRel)
    }
    const sourceBytes = await readFile(sourcePath).catch(() => {
      throw new ShareBundleError('derived-media-missing', candidate.sourceRel)
    })
    const canonicalBytes = canonicalStill(sourceBytes, candidate.sourceRel)
    const { width: pixelWidth, height: pixelHeight } = canonicalPngDimensions(canonicalBytes)
    const decodedRasterBytes = pixelWidth * pixelHeight * 4
    if (
      canonicalBytes.length > MAX_SHARE_STILL_BYTES ||
      !Number.isSafeInteger(decodedRasterBytes) ||
      decodedRasterBytes > MAX_SHARE_STILL_BYTES
    ) {
      throw new ShareBundleError('derived-media-not-ready', candidate.sourceRel)
    }
    totalCanonicalBytes += canonicalBytes.length
    totalDecodedRasterBytes += decodedRasterBytes
    if (
      totalCanonicalBytes > MAX_SHARE_TOTAL_BYTES ||
      totalDecodedRasterBytes > MAX_SHARE_TOTAL_BYTES
    ) {
      throw new ShareBundleError('derived-media-not-ready')
    }
    if (
      (candidate.declaredWidth !== undefined && candidate.declaredWidth !== pixelWidth) ||
      (candidate.declaredHeight !== undefined && candidate.declaredHeight !== pixelHeight)
    ) {
      throw new ShareBundleError('invalid-pack', candidate.sourceRel)
    }
    if (
      candidate.sourceFrame !== undefined &&
      (Math.abs(candidate.sourceFrame.width - pixelWidth) >
        candidate.sourceFrame.widthTolerance ||
        candidate.sourceFrame.height - pixelHeight > candidate.sourceFrame.heightTolerance)
    ) {
      throw new ShareBundleError('derived-media-not-ready', candidate.sourceRel)
    }
    const stableStat = await lstat(sourcePath).catch(() => {
      throw new ShareBundleError('derived-media-missing', candidate.sourceRel)
    })
    if (stableStat.size !== fileStat.size || stableStat.mtimeMs !== fileStat.mtimeMs) {
      throw new ShareBundleError('derived-media-not-ready', candidate.sourceRel)
    }
    entries.push({
      ...candidate,
      sourcePath,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      contentSha256: sha256(sourceBytes),
      canonicalSha256: sha256(canonicalBytes),
      canonicalSize: canonicalBytes.length,
      decodedRasterBytes,
      pixelWidth,
      pixelHeight,
    })
  }

  const blurAnnotations = pack.annotations.filter((annotation) => annotation.blur === true)
  const lanesWithStill = new Set(
    entries.filter((entry) => entry.kind === 'annotated-still').map((entry) => laneKey(entry.display)),
  )
  for (const displays of annotationLanes) {
    for (const display of displays) {
      if (!lanesWithStill.has(laneKey(display))) {
        throw new ShareBundleError('derived-media-not-ready')
      }
    }
  }

  const visibleLabels = pack.annotations
    .map((annotation) => annotation.text.trim())
    .filter((text) => text !== '')
  // The current renderer draws a box's label AFTER its blur pass. A semantic
  // pick commonly fills that label with the same UIA/DOM name the user meant
  // to hide, so copying those pixels would undo the redaction at the box edge.
  // Fail closed until the user clears the blur box's label and re-renders.
  const blockers: ShareBundleBlocker[] = blurAnnotations.some(
    (annotation) => annotation.text.trim() !== '',
  )
    ? ['blur-label']
    : []

  const revision = createHash('sha256')
    .update(pack.manifestBytes)
    .update(pack.annotationBytes ?? Buffer.alloc(0))
    .update(
      JSON.stringify(
        entries.map(({
          sourceRel,
          size,
          mtimeMs,
          contentSha256,
          canonicalSha256,
          canonicalSize,
          decodedRasterBytes,
          pixelWidth,
          pixelHeight,
        }) => ({
          sourceRel,
          size,
          mtimeMs,
          contentSha256,
          canonicalSha256,
          canonicalSize,
          decodedRasterBytes,
          pixelWidth,
          pixelHeight,
        })),
      ),
    )
    .digest('hex')

  // Preserve the caller's ordinary path spelling for the sibling. `root` may
  // expand a Windows 8.3 component even though no link/junction was crossed.
  const outputPath = shareBundlePath(requestedRoot)
  return {
    revision,
    outputPath,
    outputName: path.basename(outputPath),
    hasBlur: blurAnnotations.length > 0,
    entries,
    visibleLabels,
    blockers,
  }
}

/**
 * Re-reads one planned still and returns the exact canonical bytes that
 * creation will publish. History uses the same function for its thumbnails and
 * lazy full-resolution inspector, so review and ZIP creation cannot drift onto
 * different decoder/container paths.
 */
export async function readCanonicalShareStill(
  entry: ShareMediaPlanEntry,
): Promise<CanonicalShareStill> {
  const before = await lstat(entry.sourcePath).catch(() => {
    throw new ShareBundleError('pack-changed')
  })
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size !== entry.size ||
    before.mtimeMs !== entry.mtimeMs
  ) {
    throw new ShareBundleError('pack-changed')
  }
  const sourceBytes = await readFile(entry.sourcePath).catch(() => {
    throw new ShareBundleError('pack-changed')
  })
  const after = await lstat(entry.sourcePath).catch(() => {
    throw new ShareBundleError('pack-changed')
  })
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    sha256(sourceBytes) !== entry.contentSha256
  ) {
    throw new ShareBundleError('pack-changed')
  }
  let bytes: Buffer
  try {
    bytes = canonicalPng(sourceBytes)
  } catch {
    throw new ShareBundleError('pack-changed')
  }
  const dimensions = canonicalPngDimensions(bytes)
  const decodedRasterBytes = dimensions.width * dimensions.height * 4
  if (
    sha256(bytes) !== entry.canonicalSha256 ||
    bytes.length !== entry.canonicalSize ||
    !Number.isSafeInteger(decodedRasterBytes) ||
    decodedRasterBytes !== entry.decodedRasterBytes ||
    dimensions.width !== entry.pixelWidth ||
    dimensions.height !== entry.pixelHeight
  ) {
    throw new ShareBundleError('pack-changed')
  }
  return { bytes, ...dimensions }
}

/**
 * Reject actual symlink/junction aliases without comparing path spellings.
 * Windows can represent the same ordinary directory with both an 8.3 short
 * path and a long path; realpath may switch between them even though neither
 * spelling crosses a reparse point.
 */
async function assertUnaliasedDirectory(resolvedPath: string): Promise<void> {
  const parsed = path.parse(resolvedPath)
  let current = parsed.root
  let finalInfo = await lstat(current).catch(() => {
    throw new ShareBundleError('invalid-pack')
  })
  const parts = resolvedPath
    .slice(parsed.root.length)
    .split(path.sep)
    .filter((part) => part !== '')
  for (const part of parts) {
    current = path.join(current, part)
    finalInfo = await lstat(current).catch(() => {
      throw new ShareBundleError('invalid-pack')
    })
    // Node reports Windows directory junctions as symbolic links from lstat.
    if (finalInfo.isSymbolicLink()) throw new ShareBundleError('invalid-pack')
  }
  if (!finalInfo.isDirectory()) throw new ShareBundleError('invalid-pack')
}

/**
 * Creates (or replaces) the fixed sibling Share Copy after a reviewed plan.
 * A changed pack is not silently exported under the user's old confirmation.
 */
export async function createShareBundle(
  dirPath: string,
  expectedRevision: string,
): Promise<{ zipPath: string; plan: ShareBundlePlan }> {
  const plan = await planShareBundle(dirPath).catch(() => {
    // Creation is reachable only through a successful local review. If that
    // reviewed source can no longer even be planned, the useful truth is that
    // it changed underneath the confirmation, not whichever new defect the
    // unreviewed revision happens to contain.
    throw new ShareBundleError('pack-changed')
  })
  if (plan.revision !== expectedRevision) {
    throw new ShareBundleError('pack-changed')
  }
  if (plan.blockers.length > 0) {
    throw new ShareBundleError('blocked', plan.blockers.join(','))
  }
  await recoverArchiveArtifacts(plan.outputPath)
  await assertOwnedDestinationOrAbsent(plan.outputPath)

  const mediaBytes = new Map<string, Buffer>()
  for (const entry of plan.entries) {
    const canonical = await readCanonicalShareStill(entry)
    mediaBytes.set(entry.archivePath, canonical.bytes)
  }
  // Catch a re-edit or late render that landed while the (potentially large)
  // annotated stills were being read. The user reviews that new revision on a
  // second click instead of receiving a mixture of two pack states.
  const afterRead = await planShareBundle(dirPath).catch(() => {
    throw new ShareBundleError('pack-changed')
  })
  if (afterRead.revision !== plan.revision) {
    throw new ShareBundleError('pack-changed')
  }

  const publicEntries = plan.entries.map(({ archivePath, kind, display }) => ({
    file: archivePath,
    kind,
    display,
  }))
  const zip = new AdmZip()
  const archiveEntries = new Map<string, Buffer>()
  archiveEntries.set('README.md', Buffer.from(shareReadme(publicEntries), 'utf8'))
  archiveEntries.set(
    'share.json',
    Buffer.from(
      `${JSON.stringify(
        {
          format: SHARE_FORMAT,
          format_version: SHARE_FORMAT_VERSION,
          profile: 'reviewed-stills-only',
          media: publicEntries,
          excluded: [
            'original-media',
            'capturepack-manifest',
            'annotations',
            'timeline',
            'plugins',
            'generated-source-documents',
            'user-note-and-report',
            'annotated-replays',
          ],
          warnings: ['review-every-still', 'visual-redaction-is-not-a-security-proof'],
        },
        null,
        2,
      )}\n`,
      'utf8',
    ),
  )
  archiveEntries.set('viewer.html', Buffer.from(shareViewer(publicEntries), 'utf8'))
  for (const entry of plan.entries) {
    const bytes = mediaBytes.get(entry.archivePath)
    if (bytes === undefined) throw new ShareBundleError('pack-changed')
    archiveEntries.set(entry.archivePath, bytes)
  }
  for (const [name, bytes] of archiveEntries) {
    zip.addFile(name, bytes)
  }

  const temporary = `${plan.outputPath}.tmp-${String(process.pid)}-${randomUUID()}.zip`
  try {
    await zip.writeZipPromise(temporary, { overwrite: true })
    verifyArchive(temporary, archiveEntries)
    await replaceCompletedArchive(temporary, plan.outputPath)
  } finally {
    // A failed cleanup is not hidden: this file contains the very data whose
    // lifecycle Share Copy is meant to make explicit.
    await rm(temporary, { force: true })
  }
  return { zipPath: plan.outputPath, plan }
}

function verifyArchive(file: string, expected: ReadonlyMap<string, Buffer>): void {
  try {
    const entries = new AdmZip(file).getEntries()
    if (entries.length !== expected.size) throw new Error('entry count changed')
    const seen = new Set<string>()
    for (const entry of entries) {
      if (entry.isDirectory || seen.has(entry.entryName)) throw new Error('unexpected entry')
      const bytes = expected.get(entry.entryName)
      if (bytes === undefined || !entry.getData().equals(bytes)) {
        throw new Error('entry bytes changed')
      }
      seen.add(entry.entryName)
    }
    if (seen.size !== expected.size) throw new Error('entry set changed')
  } catch {
    throw new ShareBundleError('pack-changed')
  }
}

async function replaceCompletedArchive(temporary: string, destination: string): Promise<void> {
  const exists = await destinationExists(destination)
  if (!exists) {
    await moveShareNoReplace(temporary, destination)
    return
  }
  await assertOwnedDestinationOrAbsent(destination)
  const backup = `${destination}.previous`
  if (await destinationExists(backup)) throw new ShareBundleError('output-conflict')
  await moveShareNoReplace(destination, backup)
  // Re-check after moving: another process could have replaced the destination
  // between the earlier identity check and this no-replace move.
  if (!isShareBundleArchive(backup)) {
    try {
      await moveShareNoReplace(backup, destination)
    } catch {
      throw new ShareBundleError('output-conflict')
    }
    throw new ShareBundleError('output-conflict')
  }
  try {
    await moveShareNoReplace(temporary, destination)
  } catch (error) {
    try {
      await moveShareNoReplace(backup, destination)
    } catch {
      throw new ShareBundleError('output-conflict')
    }
    throw error
  }
  await rm(backup, { force: true })
}

async function moveShareNoReplace(source: string, destination: string): Promise<void> {
  try {
    await moveNoReplace(source, destination)
  } catch (error) {
    if (error instanceof MoveNoReplaceError && error.code === 'EEXIST') {
      throw new ShareBundleError('output-conflict')
    }
    throw error
  }
}

async function destinationExists(file: string): Promise<boolean> {
  try {
    await lstat(file)
    return true
  } catch (error) {
    if (isMissingFileError(error)) return false
    throw error
  }
}

async function assertOwnedDestinationOrAbsent(file: string): Promise<void> {
  let info
  try {
    info = await lstat(file)
  } catch (error) {
    if (isMissingFileError(error)) return
    throw new ShareBundleError('output-conflict')
  }
  if (!info.isFile() || info.isSymbolicLink() || !isShareBundleArchive(file)) {
    throw new ShareBundleError('output-conflict')
  }
}

/** Recover or remove only artifacts whose exact random/fixed names we own. */
async function recoverArchiveArtifacts(destination: string): Promise<void> {
  const backup = `${destination}.previous`
  if (await destinationExists(backup)) {
    const backupInfo = await lstat(backup)
    if (!backupInfo.isFile() || backupInfo.isSymbolicLink() || !isShareBundleArchive(backup)) {
      throw new ShareBundleError('output-conflict')
    }
    if (await destinationExists(destination)) {
      await assertOwnedDestinationOrAbsent(destination)
      await rm(backup, { force: true })
    } else {
      await moveShareNoReplace(backup, destination)
    }
  }

  const parent = path.dirname(destination)
  const basename = path.basename(destination).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const temporaryName = new RegExp(
    `^${basename}\\.tmp-[0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.zip$`,
    'i',
  )
  for (const name of await readdir(parent)) {
    if (!temporaryName.test(name)) continue
    const file = path.join(parent, name)
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink()) throw new ShareBundleError('output-conflict')
    await rm(file, { force: true })
  }
}

async function readPack(root: string): Promise<ParsedPack> {
  const manifestFile = await readControlFile(root, 'manifest.json', true)
  if (manifestFile === null) throw new ShareBundleError('invalid-pack')
  const manifestBytes = manifestFile.bytes
  let manifest: Manifest
  try {
    const parsed = JSON.parse(manifestBytes.toString('utf8')) as unknown
    if (!isRecord(parsed) || parsed['format'] !== 'capturepack' || !isRecord(parsed['media'])) {
      throw new Error('not a CapturePack manifest')
    }
    if (captureMediaViolations(parsed).length > 0) {
      throw new Error('capture media invariants')
    }
    manifest = parsed as unknown as Manifest
  } catch {
    throw new ShareBundleError('invalid-pack')
  }

  const annotationFile = await readControlFile(root, 'annotations.json', false)
  const annotationBytes = annotationFile?.bytes ?? null
  let annotations: Annotation[] = []
  let annotationFrame: { width: number; height: number } | null = null
  if (annotationBytes !== null) {
    try {
      const parsed = JSON.parse(annotationBytes.toString('utf8')) as unknown
      if (
        !isRecord(parsed) ||
        !positiveInteger(parsed['reference_width']) ||
        !positiveInteger(parsed['reference_height']) ||
        !Array.isArray(parsed['annotations'])
      ) {
        throw new Error('bad annotations')
      }
      annotationFrame = {
        width: parsed['reference_width'],
        height: parsed['reference_height'],
      }
      const annotationIds = new Set<string>()
      annotations = parsed['annotations'].map((value, index) =>
        normalizeAnnotation(value, index, annotationIds))
    } catch {
      throw new ShareBundleError('invalid-annotations')
    }
  }
  return {
    manifest,
    manifestBytes,
    annotations,
    annotationBytes,
    annotationMtimeMs: annotationFile?.mtimeMs ?? null,
    annotationFrame,
  }
}

async function readControlFile(
  root: string,
  name: 'manifest.json' | 'annotations.json',
  required: boolean,
): Promise<{ bytes: Buffer; mtimeMs: number } | null> {
  const candidate = path.join(root, name)
  let info
  try {
    info = await lstat(candidate)
  } catch (error) {
    if (!required && isMissingFileError(error)) return null
    throw new ShareBundleError(name === 'manifest.json' ? 'invalid-pack' : 'invalid-annotations')
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new ShareBundleError(name === 'manifest.json' ? 'invalid-pack' : 'invalid-annotations')
  }
  const resolved = await realpath(candidate).catch(() => {
    throw new ShareBundleError(name === 'manifest.json' ? 'invalid-pack' : 'invalid-annotations')
  })
  const relative = path.relative(root, resolved)
  if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ShareBundleError(name === 'manifest.json' ? 'invalid-pack' : 'invalid-annotations')
  }
  return { bytes: await readFile(resolved), mtimeMs: info.mtimeMs }
}

function mediaCandidates(manifest: Manifest, layout: ShareDisplayLayout): MediaCandidate[] {
  const candidates: MediaCandidate[] = []
  const topDisplay = layout.focused
  addLaneCandidates(
    candidates,
    topDisplay,
    manifest.media.keyframes,
    true,
    layout.frameByDisplay.get(topDisplay),
    manifest.media.replay,
    manifest.media.replay_duration_ms,
  )
  for (const display of layout.displays) {
    if (display.focused === true || display.index === topDisplay) continue
    addLaneCandidates(
      candidates,
      display.index,
      display.keyframes,
      false,
      layout.frameByDisplay.get(display.index),
      display.replay,
      display.replay_duration_ms,
    )
  }
  return candidates
}

function addLaneCandidates(
  into: MediaCandidate[],
  display: number | null,
  keyframes: ManifestKeyframe[] | undefined,
  topLevel: boolean,
  sourceFrame: ShareSourceFrame | undefined,
  replay: string | null,
  replayDurationMs: number | undefined,
): void {
  const lane = display === null ? 'media/capture' : `media/display-${String(display)}`
  if (keyframes === undefined) return
  if (!Array.isArray(keyframes) || keyframes.length === 0) {
    throw new ShareBundleError('invalid-pack')
  }
  if (replay === null && keyframes.length !== 1) {
    throw new ShareBundleError('invalid-pack')
  }
  let previousTime = -1
  for (const [index, frame] of keyframes.entries()) {
    if (
      !isRecord(frame) ||
      typeof frame.file !== 'string' ||
      !nonNegativeInteger(frame.t_ms) ||
      (frame.width !== undefined && !positiveInteger(frame.width)) ||
      (frame.height !== undefined && !positiveInteger(frame.height)) ||
      frame.t_ms < previousTime ||
      (replay === null && frame.t_ms !== 0) ||
      (replayDurationMs !== undefined && frame.t_ms > replayDurationMs)
    ) {
      throw new ShareBundleError('invalid-pack')
    }
    previousTime = frame.t_ms
    const expected = topLevel
      ? /^frames\/frame-([0-9]{2,})_[0-9]{2,}-[0-9]{2}\.[0-9]{3}\.png$/
      : new RegExp(
          `^frames-d${String(display)}/frame-([0-9]{2,})_[0-9]{2,}-[0-9]{2}\\.[0-9]{3}\\.png$`,
        )
    const match = expected.exec(frame.file)
    if (match === null) {
      throw new ShareBundleError('unsafe-media-path', frame.file)
    }
    if (Number(match[1]) !== index + 1) throw new ShareBundleError('invalid-pack')
    into.push({
      sourceRel: frame.file,
      archivePath: `${lane}/annotated-still-${String(index + 1).padStart(2, '0')}.png`,
      kind: 'annotated-still',
      display,
      ...(frame.width === undefined ? {} : { declaredWidth: frame.width }),
      ...(frame.height === undefined ? {} : { declaredHeight: frame.height }),
      ...(sourceFrame === undefined ? {} : { sourceFrame }),
    })
  }
}

async function containedRegularFile(root: string, rel: string): Promise<string> {
  // Manifest paths are pack-relative POSIX paths. Backslashes are rejected
  // even on Windows so an alternate separator cannot bypass the shape checks.
  if (rel.includes('\\') || path.posix.isAbsolute(rel) || rel.split('/').includes('..')) {
    throw new ShareBundleError('unsafe-media-path', rel)
  }
  const candidate = path.join(root, ...rel.split('/'))
  const info = await lstat(candidate).catch(() => {
    throw new ShareBundleError('derived-media-missing', rel)
  })
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new ShareBundleError('unsafe-media-path', rel)
  }
  const resolved = await realpath(candidate).catch(() => {
    throw new ShareBundleError('derived-media-missing', rel)
  })
  const relative = path.relative(root, resolved)
  if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ShareBundleError('unsafe-media-path', rel)
  }
  return resolved
}

function shareDisplayLayout(
  manifest: Manifest,
  annotationFrame: { width: number; height: number } | null,
): ShareDisplayLayout {
  const captureKind = manifest.capture_kind
  if (captureKind !== undefined && captureKind !== 'image' && captureKind !== 'video') {
    throw new ShareBundleError('invalid-pack')
  }
  const version = formatVersion(manifest.format_version)
  const requiresDeclaredFrames = version.major > 0 || version.minor >= 7
  const media = manifest.media as unknown as Record<string, unknown>
  const replay = media['replay']
  const replayDuration = media['replay_duration_ms']
  if (
    !(replay === null || (typeof replay === 'string' && /^replay\.(?:webm|mp4)$/u.test(replay))) ||
    (typeof replay === 'string' && !nonNegativeInteger(replayDuration)) ||
    (replay === null && replayDuration !== undefined && replayDuration !== null)
  ) {
    throw new ShareBundleError('invalid-pack')
  }
  const rawDisplays = media['displays']
  const frameByDisplay = new Map<number | null, ShareSourceFrame>()
  if (captureKind === 'image') {
    if (rawDisplays !== undefined) throw new ShareBundleError('invalid-pack')
    if (annotationFrame !== null) {
      frameByDisplay.set(null, {
        ...annotationFrame,
        widthTolerance: 0,
        heightTolerance: 0,
      })
    }
    return {
      focused: null,
      displays: [],
      declared: new Set<number>(),
      frameByDisplay,
    }
  }
  if (rawDisplays === undefined) {
    if (requiresDeclaredFrames) {
      throw new ShareBundleError('invalid-pack')
    }
    if (annotationFrame !== null) {
      frameByDisplay.set(1, {
        ...annotationFrame,
        widthTolerance: 0,
        heightTolerance: 0,
      })
    }
    return {
      focused: 1,
      displays: [],
      declared: new Set([1]),
      frameByDisplay,
    }
  }
  if (!Array.isArray(rawDisplays) || rawDisplays.length === 0) {
    throw new ShareBundleError('invalid-pack')
  }
  const environment = manifest.environment as unknown
  if (!isRecord(environment) || !Array.isArray(environment['screens'])) {
    throw new ShareBundleError('invalid-pack')
  }
  const screens = environment['screens']
  const displays: ManifestDisplayMedia[] = []
  const declared = new Set<number>()
  let focused: number | null = null
  for (const value of rawDisplays) {
    if (
      !isRecord(value) ||
      !positiveInteger(value['index']) ||
      typeof value['focused'] !== 'boolean' ||
      (requiresDeclaredFrames &&
        (!positiveInteger(value['snapshot_width']) ||
          !positiveInteger(value['snapshot_height']))) ||
      (value['snapshot_width'] !== undefined && !positiveInteger(value['snapshot_width'])) ||
      (value['snapshot_height'] !== undefined && !positiveInteger(value['snapshot_height'])) ||
      !finiteRectangle(value['bounds']) ||
      !positiveFinite(value['scale'])
    ) {
      throw new ShareBundleError('invalid-pack')
    }
    const screen = screens[value['index'] - 1]
    if (
      !isRecord(screen) ||
      !positiveInteger(screen['width']) ||
      !positiveInteger(screen['height']) ||
      !positiveFinite(screen['scale']) ||
      Math.abs(screen['scale'] - value['scale']) > 1e-6 ||
      Math.abs(Math.round(value['bounds'].width * value['scale']) - screen['width']) > 1 ||
      Math.abs(Math.round(value['bounds'].height * value['scale']) - screen['height']) > 1 ||
      (positiveInteger(value['snapshot_width']) &&
        Math.abs(value['snapshot_width'] - screen['width']) > 1) ||
      (positiveInteger(value['snapshot_height']) &&
        Math.abs(value['snapshot_height'] - screen['height']) > 1)
    ) {
      throw new ShareBundleError('invalid-pack')
    }
    const display = value as unknown as ManifestDisplayMedia
    const displayFrame = {
      width: positiveInteger(value['snapshot_width'])
        ? value['snapshot_width']
        : display.focused && annotationFrame !== null
          ? annotationFrame.width
          : Math.max(1, Math.round(value['bounds'].width * value['scale'])),
      height: positiveInteger(value['snapshot_height'])
        ? value['snapshot_height']
        : display.focused && annotationFrame !== null
          ? annotationFrame.height
          : Math.max(1, Math.round(value['bounds'].height * value['scale'])),
      widthTolerance: positiveInteger(value['snapshot_width']) ||
        (display.focused && annotationFrame !== null) ? 0 as const : 1 as const,
      heightTolerance: positiveInteger(value['snapshot_height']) ||
        (display.focused && annotationFrame !== null) ? 0 as const : 1 as const,
    }
    if (declared.has(display.index)) throw new ShareBundleError('invalid-pack')
    declared.add(display.index)
    const expectedSnapshot = display.focused
      ? manifest.media.snapshot
      : `snapshot-d${String(display.index)}.png`
    const displayReplay = value['replay']
    const expectedReplay = display.focused
      ? replay
      : displayReplay === null
        ? null
        : `replay-d${String(display.index)}.${
            typeof displayReplay === 'string' && displayReplay.endsWith('.mp4') ? 'mp4' : 'webm'
          }`
    if (
      value['snapshot'] !== expectedSnapshot ||
      !(displayReplay === null || typeof displayReplay === 'string') ||
      displayReplay !== expectedReplay ||
      (typeof displayReplay === 'string' && !nonNegativeInteger(value['replay_duration_ms'])) ||
      (displayReplay === null &&
        value['replay_duration_ms'] !== undefined &&
        value['replay_duration_ms'] !== null)
    ) {
      throw new ShareBundleError('invalid-pack')
    }
    if (display.focused) {
      if (
        focused !== null ||
        display.keyframes !== undefined ||
        display.replay_annotated !== undefined ||
        value['replay_duration_ms'] !== replayDuration ||
        (annotationFrame !== null &&
          (displayFrame.width !== annotationFrame.width ||
            displayFrame.height !== annotationFrame.height))
      ) {
        throw new ShareBundleError('invalid-pack')
      }
      focused = display.index
    } else {
      const annotatedReplay = value['replay_annotated']
      if (
        annotatedReplay !== undefined &&
        (displayReplay === null ||
          annotatedReplay !== `replay_annotated-d${String(display.index)}.${
            displayReplay.endsWith('.mp4') ? 'mp4' : 'webm'
          }`)
      ) {
        throw new ShareBundleError('invalid-pack')
      }
    }
    frameByDisplay.set(display.index, displayFrame)
    displays.push(display)
  }
  if (focused === null) throw new ShareBundleError('invalid-pack')
  return { focused, displays, declared, frameByDisplay }
}

function formatVersion(value: unknown): { major: number; minor: number; patch: number } {
  if (typeof value !== 'string') throw new ShareBundleError('invalid-pack')
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/u.exec(value)
  if (match === null) throw new ShareBundleError('invalid-pack')
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    throw new ShareBundleError('invalid-pack')
  }
  return { major, minor, patch }
}

function annotationDisplays(
  annotation: Annotation,
  layout: ShareDisplayLayout,
): ReadonlySet<number | null> {
  const imageCapture = layout.focused === null
  const displays = new Set<number | null>()
  let baseDisplay: number | null
  if (imageCapture) {
    if (annotation.display !== undefined) throw new ShareBundleError('invalid-annotations')
    baseDisplay = null
  } else {
    baseDisplay = annotationDisplay(annotation.display, layout)
  }
  displays.add(baseDisplay)
  assertAnnotationRectangle(annotation.bounds, baseDisplay, layout)

  const tracking = annotation.tracking as unknown
  if (!isRecord(tracking) || typeof tracking['enabled'] !== 'boolean') {
    throw new ShareBundleError('invalid-annotations')
  }
  if (
    tracking['picked_at_ms'] !== undefined &&
    !nonNegativeFinite(tracking['picked_at_ms'])
  ) {
    throw new ShareBundleError('invalid-annotations')
  }
  const samples = tracking['samples']
  if (
    (samples !== undefined && !Array.isArray(samples)) ||
    (tracking['enabled'] === true && (!Array.isArray(samples) || samples.length === 0))
  ) {
    throw new ShareBundleError('invalid-annotations')
  }
  if (Array.isArray(samples)) {
    let previousTime = -Infinity
    for (const sample of samples) {
      if (
        !isRecord(sample) ||
        !nonNegativeFinite(sample['t_ms']) ||
        !finiteRectangle(sample) ||
        sample['t_ms'] < previousTime
      ) {
        throw new ShareBundleError('invalid-annotations')
      }
      previousTime = sample['t_ms']
      let sampleDisplay = baseDisplay
      if (sample['display'] !== undefined) {
        if (imageCapture) throw new ShareBundleError('invalid-annotations')
        sampleDisplay = annotationDisplay(sample['display'], layout)
      }
      assertAnnotationRectangle(sample, sampleDisplay, layout)
      if (tracking['enabled'] === true) displays.add(sampleDisplay)
    }
  }

  const keyframes = annotation.keyframes as unknown
  if (
    (keyframes !== undefined && !Array.isArray(keyframes)) ||
    (Array.isArray(keyframes) && keyframes.length < 2)
  ) {
    throw new ShareBundleError('invalid-annotations')
  }
  if (Array.isArray(keyframes)) {
    let previousTime = -Infinity
    for (const frame of keyframes) {
      if (
        !isRecord(frame) ||
        !nonNegativeFinite(frame['t_ms']) ||
        !finiteRectangle(frame) ||
        frame['t_ms'] < previousTime
      ) {
        throw new ShareBundleError('invalid-annotations')
      }
      previousTime = frame['t_ms']
      let frameDisplay = baseDisplay
      if (frame['display'] !== undefined) {
        if (imageCapture) throw new ShareBundleError('invalid-annotations')
        frameDisplay = annotationDisplay(frame['display'], layout)
      }
      assertAnnotationRectangle(frame, frameDisplay, layout)
      displays.add(frameDisplay)
    }
  }
  return displays
}

function annotationDisplay(value: unknown, layout: ShareDisplayLayout): number {
  const display = value === undefined ? layout.focused : value
  if (
    typeof display !== 'number' ||
    !Number.isInteger(display) ||
    display < 1 ||
    !layout.declared.has(display)
  ) {
    throw new ShareBundleError('invalid-annotations')
  }
  return display
}

function laneKey(display: number | null): string {
  return display === null ? 'capture' : `display-${String(display)}`
}

function normalizeAnnotation(
  value: unknown,
  index: number,
  ids: Set<string>,
): Annotation {
  if (
    !isRecord(value) ||
    value['type'] !== 'box' ||
    typeof value['annotation_id'] !== 'string' ||
    !/^ann_[0-9a-f]{6}$/u.test(value['annotation_id']) ||
    ids.has(value['annotation_id']) ||
    !finiteRectangle(value['bounds']) ||
    (value['text'] !== undefined && typeof value['text'] !== 'string') ||
    (value['numbered'] !== undefined && typeof value['numbered'] !== 'boolean') ||
    (value['blur'] !== undefined && typeof value['blur'] !== 'boolean') ||
    (value['created_at'] !== undefined && typeof value['created_at'] !== 'string') ||
    (value['z'] !== undefined && !Number.isInteger(value['z'])) ||
    (value['display'] !== undefined && !positiveInteger(value['display'])) ||
    (value['tracking'] !== undefined &&
      (!isRecord(value['tracking']) || typeof value['tracking']['enabled'] !== 'boolean')) ||
    (value['keyframes'] !== undefined && !Array.isArray(value['keyframes']))
  ) {
    throw new ShareBundleError('invalid-annotations')
  }
  const hasStart = value['start_ms'] !== undefined
  const hasEnd = value['end_ms'] !== undefined
  if (
    hasStart !== hasEnd ||
    (hasStart &&
      (!nonNegativeFinite(value['start_ms']) ||
        !nonNegativeFinite(value['end_ms']) ||
        value['start_ms'] > value['end_ms']))
  ) {
    throw new ShareBundleError('invalid-annotations')
  }
  ids.add(value['annotation_id'])
  return {
    ...value,
    text: value['text'] ?? '',
    numbered: value['numbered'] ?? false,
    blur: value['blur'] ?? false,
    tracking: value['tracking'] ?? { enabled: false },
    created_at: value['created_at'] ?? '',
    z: value['z'] ?? index,
  } as unknown as Annotation
}

function assertAnnotationRectangle(
  rectangle: { x: number; y: number; width: number; height: number },
  display: number | null,
  layout: ShareDisplayLayout,
): void {
  const frame = layout.frameByDisplay.get(display)
  if (
    frame === undefined ||
    rectangle.x < 0 ||
    rectangle.y < 0 ||
    rectangle.x + rectangle.width > frame.width + 1 ||
    rectangle.y + rectangle.height > frame.height + 1
  ) {
    throw new ShareBundleError('invalid-annotations')
  }
}

function finiteRectangle(
  value: unknown,
): value is Record<string, unknown> & {
  x: number
  y: number
  width: number
  height: number
} {
  return (
    isRecord(value) &&
    finiteNumber(value['x']) &&
    finiteNumber(value['y']) &&
    positiveFinite(value['width']) &&
    positiveFinite(value['height'])
  )
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function positiveFinite(value: unknown): value is number {
  return finiteNumber(value) && value > 0
}

function nonNegativeFinite(value: unknown): value is number {
  return finiteNumber(value) && value >= 0
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error['code'] === 'ENOENT'
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function canonicalPngDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 24 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('canonical PNG has no IHDR')
  }
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (width < 1 || height < 1) throw new Error('canonical PNG dimensions')
  return { width, height }
}

/**
 * Decode and deterministically re-encode an ordinary 8-bit grayscale/RGB PNG,
 * with or without an alpha channel.
 * Keeping only pixels strips tEXt/XMP chunks, APNG frames, zlib trailers,
 * alternate filter encodings, and bytes after IEND instead of trusting a
 * visible thumbnail to reveal hidden container payloads.
 */
function canonicalStill(bytes: Buffer, sourceRel: string): Buffer {
  try {
    return canonicalPng(bytes)
  } catch {
    throw new ShareBundleError('derived-media-missing', sourceRel)
  }
}

function canonicalPng(bytes: Buffer): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature)) throw new Error('png signature')
  let offset = 8
  let ihdr: Buffer | null = null
  let transparency: Buffer | null = null
  const compressed: Buffer[] = []
  let ended = false
  while (offset + 12 <= bytes.length && !ended) {
    const length = bytes.readUInt32BE(offset)
    const end = offset + 12 + length
    if (length > MAX_SHARE_STILL_BYTES || end > bytes.length) throw new Error('png chunk')
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length)
    if (pngCrc(Buffer.concat([Buffer.from(type, 'ascii'), data])) !== expectedCrc) {
      throw new Error('png crc')
    }
    if (ihdr === null && type !== 'IHDR') throw new Error('png ihdr order')
    if (type === 'IHDR') {
      if (ihdr !== null || length !== 13) throw new Error('png ihdr')
      ihdr = Buffer.from(data)
    } else if (type === 'tRNS') {
      // For grayscale/RGB PNGs this chunk changes the meaning of the decoded
      // samples. Dropping it would turn pixels that History showed as
      // transparent into newly visible pixels in the Share Copy.
      if (transparency !== null || compressed.length > 0) throw new Error('png transparency order')
      transparency = Buffer.from(data)
    } else if (type === 'IDAT') {
      compressed.push(Buffer.from(data))
    } else if (type === 'IEND') {
      if (length !== 0) throw new Error('png iend')
      ended = true
    } else if (/^[A-Z]/u.test(type)) {
      // Unknown critical chunks affect pixel interpretation; ancillary chunks
      // are intentionally discarded.
      throw new Error('png critical chunk')
    }
    offset = end
  }
  if (ihdr === null || compressed.length === 0 || !ended) throw new Error('png incomplete')
  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  const bitDepth = ihdr[8]
  const colorType = ihdr[9]
  if (
    width < 1 ||
    height < 1 ||
    bitDepth !== 8 ||
    ![0, 2, 4, 6].includes(colorType ?? -1) ||
    ihdr[10] !== 0 ||
    ihdr[11] !== 0 ||
    ihdr[12] !== 0
  ) {
    throw new Error('png format')
  }
  // Bound the representation History and the Share Copy actually expose,
  // before inflating even a compact grayscale source. A source-channel limit
  // alone lets a 1-byte-per-pixel PNG allocate several large buffers before
  // the later RGBA plan check rejects it.
  const decodedRasterBytes = width * height * 4
  if (
    !Number.isSafeInteger(decodedRasterBytes) ||
    decodedRasterBytes > MAX_SHARE_STILL_BYTES
  ) {
    throw new Error('png decoded dimensions')
  }
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4
  if (transparency !== null) {
    if (colorType === 0) {
      if (transparency.length !== 2) {
        throw new Error('png grayscale transparency')
      }
    } else if (colorType === 2) {
      if (transparency.length !== 6) {
        throw new Error('png rgb transparency')
      }
    } else {
      // Alpha-bearing formats already encode transparency per pixel; tRNS is
      // invalid there and must not be interpreted or silently discarded.
      throw new Error('png unexpected transparency')
    }
  }
  const rowBytes = width * channels
  const rawLength = (rowBytes + 1) * height
  if (!Number.isSafeInteger(rawLength) || rawLength > MAX_SHARE_STILL_BYTES) {
    throw new Error('png dimensions')
  }
  const filtered = inflateSync(Buffer.concat(compressed), { maxOutputLength: rawLength + 1 })
  if (filtered.length !== rawLength) throw new Error('png raster length')
  const pixels = Buffer.allocUnsafe(rowBytes * height)
  for (let y = 0; y < height; y += 1) {
    const filter = filtered[y * (rowBytes + 1)]
    if (filter === undefined || filter > 4) throw new Error('png filter')
    for (let x = 0; x < rowBytes; x += 1) {
      const encoded = filtered[y * (rowBytes + 1) + 1 + x]!
      const left = x >= channels ? pixels[y * rowBytes + x - channels]! : 0
      const up = y > 0 ? pixels[(y - 1) * rowBytes + x]! : 0
      const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * rowBytes + x - channels]! : 0
      let prediction = 0
      if (filter === 1) prediction = left
      else if (filter === 2) prediction = up
      else if (filter === 3) prediction = Math.floor((left + up) / 2)
      else if (filter === 4) prediction = paeth(left, up, upLeft)
      pixels[y * rowBytes + x] = (encoded + prediction) & 0xff
    }
  }

  let canonicalIhdr = ihdr
  let canonicalPixels = pixels
  let canonicalChannels = channels
  if (transparency !== null) {
    const rgbaRowBytes = width * 4
    const rgbaRawLength = (rgbaRowBytes + 1) * height
    if (!Number.isSafeInteger(rgbaRawLength) || rgbaRawLength > MAX_SHARE_STILL_BYTES) {
      throw new Error('png transparent dimensions')
    }
    const rgba = Buffer.allocUnsafe(rgbaRowBytes * height)
    const pixelCount = width * height
    if (colorType === 0) {
      const transparentGrey = transparency.readUInt16BE(0) & 0xff
      for (let pixel = 0; pixel < pixelCount; pixel += 1) {
        const grey = pixels[pixel]!
        const output = pixel * 4
        rgba[output] = grey
        rgba[output + 1] = grey
        rgba[output + 2] = grey
        rgba[output + 3] = grey === transparentGrey ? 0 : 0xff
      }
    } else {
      const transparentRed = transparency.readUInt16BE(0) & 0xff
      const transparentGreen = transparency.readUInt16BE(2) & 0xff
      const transparentBlue = transparency.readUInt16BE(4) & 0xff
      for (let pixel = 0; pixel < pixelCount; pixel += 1) {
        const source = pixel * 3
        const output = pixel * 4
        const red = pixels[source]!
        const green = pixels[source + 1]!
        const blue = pixels[source + 2]!
        rgba[output] = red
        rgba[output + 1] = green
        rgba[output + 2] = blue
        rgba[output + 3] =
          red === transparentRed && green === transparentGreen && blue === transparentBlue
            ? 0
            : 0xff
      }
    }
    canonicalIhdr = Buffer.from(ihdr)
    canonicalIhdr[9] = 6
    canonicalPixels = rgba
    canonicalChannels = 4
  }

  const canonicalRowBytes = width * canonicalChannels
  const canonicalRawLength = (canonicalRowBytes + 1) * height
  const canonicalRaster = Buffer.allocUnsafe(canonicalRawLength)
  for (let y = 0; y < height; y += 1) {
    const at = y * (canonicalRowBytes + 1)
    canonicalRaster[at] = 0
    canonicalPixels.copy(
      canonicalRaster,
      at + 1,
      y * canonicalRowBytes,
      (y + 1) * canonicalRowBytes,
    )
  }
  return Buffer.concat([
    signature,
    pngChunk('IHDR', canonicalIhdr),
    pngChunk('IDAT', deflateSync(canonicalRaster, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft
  const leftDistance = Math.abs(estimate - left)
  const upDistance = Math.abs(estimate - up)
  const diagonalDistance = Math.abs(estimate - upLeft)
  if (leftDistance <= upDistance && leftDistance <= diagonalDistance) return left
  return upDistance <= diagonalDistance ? up : upLeft
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii')
  const chunk = Buffer.allocUnsafe(data.length + 12)
  chunk.writeUInt32BE(data.length, 0)
  typeBytes.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(pngCrc(Buffer.concat([typeBytes, data])), data.length + 8)
  return chunk
}

function pngCrc(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

interface PublicShareEntry {
  file: string
  kind: ShareMediaKind
  display: number | null
}

function shareReadme(entries: readonly PublicShareEntry[]): string {
  const links = entries.map((entry) => {
    const lane = entry.display === null ? 'capture' : `display ${String(entry.display)}`
    return `- [Canonical annotated still — ${lane}](${entry.file})`
  })
  return [
    '# CapturePack Share Copy',
    '',
    'Open `viewer.html` for the local, offline view.',
    '',
    'This is a derived sharing artifact, not the original CapturePack. Original screenshots and replays, annotated video containers, source metadata, annotations, timeline, plugins, notes, reports, and generated source documents are not included.',
    '',
    'Review every included image before sending it. The PNGs were decoded and re-encoded from pixels to remove hidden container metadata, but visual redaction is not a security proof and text drawn into the image remains visible.',
    '',
    '## Included derived media',
    '',
    ...links,
    '',
  ].join('\n')
}

function shareViewer(entries: readonly PublicShareEntry[]): string {
  const media = entries
    .map((entry, index) => {
      const label = entry.display === null ? 'Capture' : `Display ${String(entry.display)}`
      return `<article><h2>${label} · annotated still ${String(index + 1)}</h2><img src="${entry.file}" alt="${label} annotated still"></article>`
    })
    .join('\n')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; media-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'; connect-src 'none'">
<title>CapturePack Share Copy</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#121216;color:#e8e8ea;font:14px/1.5 system-ui,sans-serif}main{max-width:1120px;margin:auto;padding:24px}header,article{background:#1c1c22;border:1px solid #303038;border-radius:12px;padding:16px;margin-bottom:16px}h1,h2{margin:0 0 8px}h2{font-size:15px;color:#cfe0ff}p{margin:6px 0;color:#b0b0b8}strong{color:#ffd27a}img{display:block;width:100%;max-height:75vh;object-fit:contain;background:#09090c;border-radius:8px}
</style>
</head>
<body><main>
<header><h1>CapturePack Share Copy</h1><p>This archive contains canonical, declared annotated stills only. Originals, video containers and structured capture context are excluded.</p><p><strong>Review every image before sharing.</strong> Visual redaction is not a security proof, and text drawn into the image remains visible.</p></header>
${media}
</main></body>
</html>
`
}
