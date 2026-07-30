import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Display } from 'electron'
import {
  MIN_CAPTURE_FPS,
  normalizeCaptureFps,
} from '../shared/types'

const FRAME_MAGIC = Buffer.from('CPRF')
const FRAME_HEADER_BYTES = 56
const FRAME_VERSION = 2
const MAX_JPEG_BYTES = 16 * 1024 * 1024
const MAX_BUFFERED_BYTES = MAX_JPEG_BYTES + FRAME_HEADER_BYTES
const FIRST_FRAME_TIMEOUT_MS = 5_000
const STOP_TIMEOUT_MS = 1_000

export const NATIVE_REPLAY_BACKEND = 'windows-gdi-bitblt' as const
export const NATIVE_REPLAY_QUALITY = 'degraded' as const
export const NATIVE_REPLAY_MAX_FPS = 5
// GDI+ JPEG at full 4K measured about 1 fps on the release machine. Emergency
// replay is useful only if it preserves time, so bound its long edge before
// encoding. The manifest already declares this backend as degraded.
export const NATIVE_REPLAY_MAX_LONG_EDGE = 1280

export interface NativeReplayFrame {
  sequence: number
  /** This frame header was decoded from the Windows QPC helper protocol. */
  clockProvenance: 'windows-qpc'
  capturedQpc: number
  qpcFrequency: number
  capturedAtMs: number
  width: number
  height: number
  jpeg: Buffer
}

export interface NativeReplayStartRequest {
  webContentsId: number
  display: Display
  nativeBounds: { x: number; y: number; width: number; height: number }
  requestedFps: number
  width: number
  height: number
}

export interface NativeReplayStartResult {
  sessionId: string
  backend: typeof NATIVE_REPLAY_BACKEND
  quality: typeof NATIVE_REPLAY_QUALITY
  requestedFps: number
  fps: number
  width: number
  height: number
  firstFrame: NativeReplayFrame
}

interface NativeReplaySession {
  id: string
  process: ChildProcessWithoutNullStreams
  stopping: boolean
}

export function nativeFallbackRequestedFps(requestedFps: number): number {
  return normalizeCaptureFps(requestedFps, MIN_CAPTURE_FPS)
}

export function nativeFallbackFps(requestedFps: number): number {
  return Math.min(
    NATIVE_REPLAY_MAX_FPS,
    nativeFallbackRequestedFps(requestedFps),
  )
}

export function nativeFallbackArguments(
  request: Pick<NativeReplayStartRequest, 'display' | 'nativeBounds' | 'requestedFps' | 'width' | 'height'>,
): string[] {
  const nativeWidth = Math.max(1, Math.round(request.nativeBounds.width))
  const nativeHeight = Math.max(1, Math.round(request.nativeBounds.height))
  const requestedWidth = Math.max(
    1,
    Math.min(nativeWidth, Math.round(request.width || nativeWidth)),
  )
  const requestedHeight = Math.max(
    1,
    Math.min(nativeHeight, Math.round(request.height || nativeHeight)),
  )
  const scale = Math.min(
    1,
    requestedWidth / nativeWidth,
    requestedHeight / nativeHeight,
    NATIVE_REPLAY_MAX_LONG_EDGE / Math.max(nativeWidth, nativeHeight),
  )
  const width = Math.max(1, Math.round(nativeWidth * scale))
  const height = Math.max(1, Math.round(nativeHeight * scale))
  return [
    '--left',
    String(Math.round(request.nativeBounds.x)),
    '--top',
    String(Math.round(request.nativeBounds.y)),
    '--expected-native-width',
    String(nativeWidth),
    '--expected-native-height',
    String(nativeHeight),
    '--width',
    String(width),
    '--height',
    String(height),
    '--fps',
    String(nativeFallbackFps(request.requestedFps)),
  ]
}

export class NativeReplayFrameParser {
  private buffered = Buffer.alloc(0)

  push(chunk: Buffer): NativeReplayFrame[] {
    if (chunk.length === 0) return []
    if (this.buffered.length + chunk.length > MAX_BUFFERED_BYTES) {
      this.buffered = Buffer.alloc(0)
      throw new Error('native replay frame buffer exceeded its fixed bound')
    }
    this.buffered =
      this.buffered.length === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.buffered, chunk], this.buffered.length + chunk.length)
    const frames: NativeReplayFrame[] = []
    while (this.buffered.length >= FRAME_HEADER_BYTES) {
      if (!this.buffered.subarray(0, 4).equals(FRAME_MAGIC)) {
        this.buffered = Buffer.alloc(0)
        throw new Error('native replay frame stream lost synchronization')
      }
      const version = this.buffered.readUInt32LE(4)
      if (version !== FRAME_VERSION) {
        this.buffered = Buffer.alloc(0)
        throw new Error(`unsupported native replay frame version ${version}`)
      }
      const sequenceBig = this.buffered.readBigInt64LE(8)
      const capturedQpcBig = this.buffered.readBigInt64LE(16)
      const qpcFrequencyBig = this.buffered.readBigInt64LE(24)
      const capturedAtBig = this.buffered.readBigInt64LE(32)
      const width = this.buffered.readInt32LE(40)
      const height = this.buffered.readInt32LE(44)
      const jpegLength = this.buffered.readInt32LE(48)
      // Four bytes are reserved at 52 for an additive protocol extension.
      if (
        sequenceBig < 0 ||
        sequenceBig > BigInt(Number.MAX_SAFE_INTEGER) ||
        capturedQpcBig <= 0 ||
        capturedQpcBig > BigInt(Number.MAX_SAFE_INTEGER) ||
        qpcFrequencyBig <= 0 ||
        qpcFrequencyBig > BigInt(Number.MAX_SAFE_INTEGER) ||
        capturedAtBig <= 0 ||
        capturedAtBig > BigInt(Number.MAX_SAFE_INTEGER) ||
        width <= 0 ||
        height <= 0 ||
        jpegLength <= 0 ||
        jpegLength > MAX_JPEG_BYTES
      ) {
        this.buffered = Buffer.alloc(0)
        throw new Error('invalid native replay frame header')
      }
      const frameBytes = FRAME_HEADER_BYTES + jpegLength
      if (this.buffered.length < frameBytes) break
      frames.push({
        sequence: Number(sequenceBig),
        clockProvenance: 'windows-qpc',
        capturedQpc: Number(capturedQpcBig),
        qpcFrequency: Number(qpcFrequencyBig),
        capturedAtMs: Number(capturedAtBig),
        width,
        height,
        jpeg: Buffer.from(this.buffered.subarray(FRAME_HEADER_BYTES, frameBytes)),
      })
      this.buffered = Buffer.from(this.buffered.subarray(frameBytes))
    }
    return frames
  }
}

/** Resolve a spawned executable through electron-builder's asarUnpack layout. */
export function nativeReplayHelperPath(packedPath: string): string | null {
  const unpacked = packedPath.replace(
    `${path.sep}app.asar${path.sep}`,
    `${path.sep}app.asar.unpacked${path.sep}`,
  )
  return [unpacked, packedPath].find((candidate) => existsSync(candidate)) ?? null
}

export class NativeReplayFallbackManager {
  private readonly sessions = new Map<number, NativeReplaySession>()

  constructor(private readonly helperPath: string) {}

  async start(
    request: NativeReplayStartRequest,
    onFrame: (sessionId: string, frame: NativeReplayFrame) => void,
    onFailure: (sessionId: string, message: string) => void,
  ): Promise<NativeReplayStartResult> {
    this.stop(request.webContentsId)
    const requestedFps = nativeFallbackRequestedFps(request.requestedFps)
    const args = nativeFallbackArguments({ ...request, requestedFps })
    const fps = nativeFallbackFps(requestedFps)
    const width = Number(args[args.indexOf('--width') + 1])
    const height = Number(args[args.indexOf('--height') + 1])
    const id = randomUUID()
    const helperPath = nativeReplayHelperPath(this.helperPath)
    if (helperPath === null) {
      throw new Error(`native replay helper is missing: ${this.helperPath}`)
    }
    const child = spawn(helperPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const session: NativeReplaySession = { id, process: child, stopping: false }
    this.sessions.set(request.webContentsId, session)
    const ownsSlot = (): boolean =>
      !session.stopping &&
      this.sessions.get(request.webContentsId) === session
    const parser = new NativeReplayFrameParser()
    let firstFrame: NativeReplayFrame | null = null
    let stderr = ''
    let settled = false

    const first = new Promise<NativeReplayFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error(`native replay source produced no frame within ${FIRST_FRAME_TIMEOUT_MS}ms`))
      }, FIRST_FRAME_TIMEOUT_MS)
      timer.unref()

      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      child.once('error', fail)
      child.stdout.on('data', (chunk: Buffer) => {
        // stop()/replacement removes ownership before the helper has
        // necessarily drained its final pipe write. An old session must never
        // publish that late frame into the new session's one-in-flight slot.
        if (!ownsSlot()) return
        let frames: NativeReplayFrame[]
        try {
          frames = parser.push(chunk)
        } catch (error) {
          fail(error)
          return
        }
        for (const frame of frames) {
          if (!ownsSlot()) return
          if (firstFrame === null) {
            firstFrame = frame
            if (!settled) {
              settled = true
              clearTimeout(timer)
              resolve(frame)
            }
          } else {
            onFrame(id, frame)
          }
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-8_192)
      })
      child.once('close', (code, signal) => {
        const ownedSlot = this.sessions.get(request.webContentsId) === session
        if (ownedSlot) {
          this.sessions.delete(request.webContentsId)
        }
        const detail =
          `native replay source exited (${String(code ?? signal ?? 'unknown')})` +
          (stderr.trim() === '' ? '' : `: ${stderr.trim()}`)
        if (session.stopping || !ownedSlot) {
          if (!settled) fail(new Error('native replay source was replaced before its first frame'))
          return
        }
        if (!settled) fail(new Error(detail))
        else if (firstFrame !== null) onFailure(id, detail)
      })
    })

    try {
      const frame = await first
      return {
        sessionId: id,
        backend: NATIVE_REPLAY_BACKEND,
        quality: NATIVE_REPLAY_QUALITY,
        requestedFps,
        fps,
        width,
        height,
        firstFrame: frame,
      }
    } catch (error) {
      // A newer start may already own this webContents slot. Cleanup is scoped
      // to the session whose promise failed so stale failure cannot kill it.
      this.stop(request.webContentsId, id)
      throw error
    }
  }

  stop(webContentsId: number, sessionId?: string): void {
    const session = this.sessions.get(webContentsId)
    if (session === undefined || (sessionId !== undefined && session.id !== sessionId)) return
    this.sessions.delete(webContentsId)
    session.stopping = true
    try {
      session.process.stdin.end()
    } catch {
      // Already gone.
    }
    const timer = setTimeout(() => {
      if (session.process.exitCode === null && session.process.signalCode === null) {
        session.process.kill()
      }
    }, STOP_TIMEOUT_MS)
    timer.unref()
  }

  stopAll(): void {
    for (const webContentsId of [...this.sessions.keys()]) this.stop(webContentsId)
  }
}
