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
import { lstat, readFile, readdir, realpath, rename, rm } from 'node:fs/promises'
import * as path from 'node:path'
import { deflateSync, inflateSync } from 'node:zlib'
import type {
  Annotation,
  AnnotationsFile,
  Manifest,
  ManifestDisplayMedia,
  ManifestKeyframe,
} from '../shared/types'
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
}

interface MediaCandidate {
  sourceRel: string
  archivePath: string
  kind: ShareMediaKind
  display: number | null
}

/**
 * Reads the small source declarations, validates/canonicalizes every declared
 * still, and hashes its raw bytes for review binding. No archive is written.
 */
export async function planShareBundle(dirPath: string): Promise<ShareBundlePlan> {
  const requestedRoot = path.resolve(dirPath)
  const root = await realpath(dirPath).catch(() => {
    throw new ShareBundleError('invalid-pack')
  })
  // A junction/symlink alias would make the managed sibling ambiguous: History
  // would look beside the alias while creation writes beside the real pack.
  if (requestedRoot.toLowerCase() !== root.toLowerCase()) {
    throw new ShareBundleError('invalid-pack')
  }
  const pack = await readPack(root)
  const declaredFocused = focusedDisplayIndex(pack.manifest)
  const focusedDisplay =
    pack.manifest.capture_kind === 'image' ? null : (declaredFocused ?? 1)
  const candidates = mediaCandidates(pack.manifest, focusedDisplay)
  if (candidates.length === 0) {
    throw new ShareBundleError('derived-media-not-ready')
  }
  if (candidates.length > MAX_SHARE_STILLS) {
    throw new ShareBundleError('derived-media-not-ready')
  }

  const entries: ShareMediaPlanEntry[] = []
  const destinations = new Set<string>()
  let totalBytes = 0
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
    canonicalStill(sourceBytes, candidate.sourceRel)
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
    })
  }

  const blurAnnotations = pack.annotations.filter((annotation) => annotation.blur === true)
  const lanesWithStill = new Set(
    entries.filter((entry) => entry.kind === 'annotated-still').map((entry) => laneKey(entry.display)),
  )
  for (const annotation of blurAnnotations) {
    const display = annotationDisplay(annotation, focusedDisplay)
    if (!lanesWithStill.has(laneKey(display))) {
      throw new ShareBundleError('derived-media-not-ready')
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
        entries.map(({ sourceRel, size, mtimeMs, contentSha256 }) => ({
          sourceRel,
          size,
          mtimeMs,
          contentSha256,
        })),
      ),
    )
    .digest('hex')

  const outputPath = shareBundlePath(root)
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
    const bytes = await readFile(entry.sourcePath).catch(() => {
      throw new ShareBundleError('pack-changed')
    })
    if (sha256(bytes) !== entry.contentSha256) {
      throw new ShareBundleError('pack-changed')
    }
    mediaBytes.set(entry.archivePath, canonicalStill(bytes, entry.sourceRel))
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
    await rename(temporary, destination)
    return
  }
  await assertOwnedDestinationOrAbsent(destination)
  const backup = `${destination}.previous`
  if (await destinationExists(backup)) throw new ShareBundleError('output-conflict')
  await rename(destination, backup)
  // Re-check after moving: another process could have replaced the destination
  // between the earlier identity check and this rename.
  if (!isShareBundleArchive(backup)) {
    try {
      await rename(backup, destination)
    } catch {
      throw new ShareBundleError('output-conflict')
    }
    throw new ShareBundleError('output-conflict')
  }
  try {
    await rename(temporary, destination)
  } catch (error) {
    try {
      await rename(backup, destination)
    } catch {
      throw new ShareBundleError('output-conflict')
    }
    throw error
  }
  await rm(backup, { force: true })
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
      await rename(backup, destination)
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
    manifest = parsed as unknown as Manifest
  } catch {
    throw new ShareBundleError('invalid-pack')
  }

  const annotationFile = await readControlFile(root, 'annotations.json', false)
  const annotationBytes = annotationFile?.bytes ?? null
  let annotations: Annotation[] = []
  if (annotationBytes !== null) {
    try {
      const parsed = JSON.parse(annotationBytes.toString('utf8')) as unknown
      if (!isRecord(parsed) || !Array.isArray(parsed['annotations'])) {
        throw new Error('bad annotations')
      }
      annotations = (parsed as unknown as AnnotationsFile).annotations.filter(validAnnotation)
      if (annotations.length !== (parsed as unknown as AnnotationsFile).annotations.length) {
        throw new Error('bad annotation entry')
      }
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

function mediaCandidates(manifest: Manifest, focused: number | null): MediaCandidate[] {
  const candidates: MediaCandidate[] = []
  const imageCapture = manifest.capture_kind === 'image'
  const topDisplay = imageCapture ? null : (focused ?? 1)
  addLaneCandidates(
    candidates,
    topDisplay,
    manifest.media.keyframes,
    true,
  )
  for (const display of validDisplays(manifest.media.displays)) {
    if (display.focused === true || display.index === topDisplay) continue
    addLaneCandidates(
      candidates,
      display.index,
      display.keyframes,
      false,
    )
  }
  return candidates
}

function addLaneCandidates(
  into: MediaCandidate[],
  display: number | null,
  keyframes: ManifestKeyframe[] | undefined,
  topLevel: boolean,
): void {
  const lane = display === null ? 'media/capture' : `media/display-${String(display)}`
  if (keyframes === undefined) return
  if (!Array.isArray(keyframes)) throw new ShareBundleError('invalid-pack')
  for (const [index, frame] of keyframes.entries()) {
    if (!isRecord(frame) || typeof frame.file !== 'string') {
      throw new ShareBundleError('invalid-pack')
    }
    const expected = topLevel
      ? /^frames\/frame-[0-9]{2,}_[0-9]{2,}-[0-9]{2}\.[0-9]{3}\.png$/
      : new RegExp(
          `^frames-d${String(display)}/frame-[0-9]{2,}_[0-9]{2,}-[0-9]{2}\\.[0-9]{3}\\.png$`,
        )
    if (!expected.test(frame.file)) {
      throw new ShareBundleError('unsafe-media-path', frame.file)
    }
    into.push({
      sourceRel: frame.file,
      archivePath: `${lane}/annotated-still-${String(index + 1).padStart(2, '0')}.png`,
      kind: 'annotated-still',
      display,
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

function focusedDisplayIndex(manifest: Manifest): number | null {
  const focused = validDisplays(manifest.media.displays).find((display) => display.focused === true)
  return focused?.index ?? null
}

function validDisplays(value: ManifestDisplayMedia[] | undefined): ManifestDisplayMedia[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (display) =>
      isRecord(display) && Number.isInteger(display.index) && display.index >= 1,
  )
}

function annotationDisplay(annotation: Annotation, focused: number | null): number | null {
  if (annotation.display === undefined) return focused
  if (!Number.isInteger(annotation.display) || annotation.display < 1) {
    throw new ShareBundleError('invalid-annotations')
  }
  return annotation.display
}

function laneKey(display: number | null): string {
  return display === null ? 'capture' : `display-${String(display)}`
}

function validAnnotation(value: unknown): value is Annotation {
  return (
    isRecord(value) &&
    value['type'] === 'box' &&
    typeof value['text'] === 'string' &&
    typeof value['blur'] === 'boolean'
  )
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

/**
 * Decode and deterministically re-encode an ordinary 8-bit RGB/RGBA PNG.
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
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4
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
  const canonicalRaster = Buffer.allocUnsafe(rawLength)
  for (let y = 0; y < height; y += 1) {
    const at = y * (rowBytes + 1)
    canonicalRaster[at] = 0
    pixels.copy(canonicalRaster, at + 1, y * rowBytes, (y + 1) * rowBytes)
  }
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
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
