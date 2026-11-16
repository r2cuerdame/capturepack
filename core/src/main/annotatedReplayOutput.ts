import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { displayAnnotatedName, keyframeFileName } from '../shared/keyframes'
import type { ManifestKeyframe } from '../shared/types'
import { pngPixelSizeOf } from './png'

export interface AnnotatedOutputFsOps {
  mkdir?: (dirPath: string, options?: { recursive?: boolean }) => Promise<unknown>
  writeFile?: (filePath: string, data: Uint8Array) => Promise<void>
  rename?: (oldPath: string, newPath: string) => Promise<void>
  rm?: (targetPath: string, options?: { force?: boolean; recursive?: boolean }) => Promise<void>
}

export interface KeyframeFrameInput {
  t_ms: number
  png: ArrayBuffer | Uint8Array
}

export interface WriteKeyframesOptions {
  allowEmpty?: boolean
  fs?: AnnotatedOutputFsOps
}

function isEnoentError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT'
}

function toBuffer(bytes: ArrayBuffer | Uint8Array): Buffer {
  if (Buffer.isBuffer(bytes)) return bytes
  if (ArrayBuffer.isView(bytes)) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return Buffer.from(bytes)
}

/** Filename used by both the renderer's disk write and the manifest declaration. */
export function annotatedReplayOutputName(
  replayMimeType: string,
  display?: number,
): string {
  const replayFile =
    replayMimeType.split(';', 1)[0]?.trim().toLowerCase() === 'video/mp4'
      ? 'replay.mp4'
      : 'replay.webm'
  return display === undefined
    ? `replay_annotated.${replayFile.endsWith('.mp4') ? 'mp4' : 'webm'}`
    : displayAnnotatedName(display, replayFile)
}

/**
 * Persist the encoded annotated replay under its container-matched filename.
 * Stages to a sibling temporary file and atomically renames before removing
 * any stale alternate-format file so failed writes never damage originals.
 */
export async function writeAnnotatedReplayOutput(
  dirPath: string,
  replay: Uint8Array,
  replayMimeType: string,
  display?: number,
  ops: AnnotatedOutputFsOps = {},
): Promise<string> {
  const writeFileFn = ops.writeFile ?? writeFile
  const renameFn = ops.rename ?? rename
  const rmFn = ops.rm ?? rm
  const file = annotatedReplayOutputName(replayMimeType, display)
  const alternate =
    display === undefined
      ? file.endsWith('.mp4')
        ? 'replay_annotated.webm'
        : 'replay_annotated.mp4'
      : displayAnnotatedName(display, file.endsWith('.mp4') ? 'replay.webm' : 'replay.mp4')
  const targetPath = path.join(dirPath, file)
  const alternatePath = path.join(dirPath, alternate)
  const temporaryPath = path.join(dirPath, `.${file}.${String(process.pid)}.${randomUUID()}.tmp`)
  try {
    await writeFileFn(temporaryPath, replay)
    await renameFn(temporaryPath, targetPath)
    await rmFn(alternatePath, { force: true })
    return file
  } finally {
    await rmFn(temporaryPath, { force: true }).catch(() => {})
  }
}

/**
 * Stage all annotated keyframe stills in a sibling temporary directory and
 * atomically swap them into `dir`, restoring any prior directory if the swap
 * fails. When `allowEmpty` is false, an empty frame list rejects immediately
 * without modifying the existing stills directory.
 */
export async function writeKeyframesOutput(
  dirPath: string,
  frames: readonly KeyframeFrameInput[],
  dir = 'frames',
  options: WriteKeyframesOptions = {},
): Promise<ManifestKeyframe[]> {
  const fsOps = options.fs ?? {}
  const mkdirFn = fsOps.mkdir ?? mkdir
  const writeFileFn = fsOps.writeFile ?? writeFile
  const renameFn = fsOps.rename ?? rename
  const rmFn = fsOps.rm ?? rm
  const framesDir = path.join(dirPath, dir)

  if (frames.length === 0) {
    if (options.allowEmpty === false) {
      throw new Error('still render produced no keyframe')
    }
    await rmFn(framesDir, { recursive: true, force: true })
    return []
  }

  const parentDir = path.dirname(framesDir)
  const baseDir = path.basename(framesDir)
  const token = `${String(process.pid)}.${randomUUID()}`
  const stagingDir = path.join(parentDir, `.${baseDir}.${token}.tmp`)
  const backupDir = path.join(parentDir, `.${baseDir}.${token}.bak`)
  let movedExisting = false
  let swapped = false

  try {
    await mkdirFn(stagingDir, { recursive: true })
    const declared: ManifestKeyframe[] = []
    // Order is the render's own ascending order; NN is the 1-based position in
    // the surviving list, so the numbering stays contiguous even if a still
    // failed to encode.
    for (const [i, frame] of frames.entries()) {
      const t_ms = Math.max(0, Math.round(frame.t_ms))
      const file = keyframeFileName(i + 1, t_ms, dir)
      const png = toBuffer(frame.png)
      await writeFileFn(path.join(stagingDir, path.posix.basename(file)), png)
      // Read back from the bytes just written, not from the job's requested size:
      // the render adds a label gutter below the source frame (#133), so the two
      // legitimately differ and only the file knows by how much.
      const size = pngPixelSizeOf(png)
      declared.push({ file, t_ms, ...(size === null ? {} : size) })
    }

    try {
      await renameFn(framesDir, backupDir)
      movedExisting = true
    } catch (err) {
      if (!isEnoentError(err)) throw err
    }

    try {
      await renameFn(stagingDir, framesDir)
      swapped = true
    } catch (err) {
      if (movedExisting) {
        await renameFn(backupDir, framesDir).catch(() => {})
      }
      throw err
    }
    return declared
  } finally {
    await rmFn(stagingDir, { recursive: true, force: true }).catch(() => {})
    if (swapped) {
      await rmFn(backupDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

