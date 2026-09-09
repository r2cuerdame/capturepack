import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import path from 'node:path'
import {
  dxgiReplayCapabilityArguments,
  dxgiReplayRingHelperPath,
  probeDxgiReplayCapability,
  type DxgiReplayBounds,
  type DxgiReplayCapability,
} from './dxgiReplayRing'
import { enumerateFmp4VideoSamples } from '../renderer/capture/fmp4SampleTimeline'

export const DXGI_REPLAY_RUNTIME_SWITCH = '--dxgi-native-replay'
export const DXGI_REPLAY_SERVICE_PACKET_BYTES = 256
export const DXGI_REPLAY_SERVICE_MAX_COMMAND_BYTES = 32_768
export const DXGI_REPLAY_MIN_RETENTION_MS = 1_000
// Native is intentionally limited to the settings UI's 60 s ceiling. Legacy
// or hand-edited profiles up to 600 s stay on the shipping recorder rather
// than allocating a native ring hundreds of MiB large for every display.
export const DXGI_REPLAY_MAX_RETENTION_MS = 60_000
export const DXGI_REPLAY_MAX_GOP_MS = 1_000
const DXGI_REPLAY_DURATION_TOLERANCE_MS = 100
// 60 s at the native helper's fixed 6 Mbps, 25% encoder headroom, and two
// independent 8 MiB allowances for ring/container overhead.
export const DXGI_REPLAY_MAX_EXPORT_BYTES = 73_027_216
export const DXGI_REPLAY_CURSOR_COMPOSITED_FLAG = 1 << 17
const DXGI_REPLAY_SERVICE_MAGIC = Buffer.from('CPNSRV01', 'ascii')
const DXGI_REPLAY_SERVICE_VERSION = 1
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000
const DEFAULT_SNAPSHOT_TIMEOUT_MS = 15_000
const STOP_TIMEOUT_MS = 1_000
const MAX_STDERR_BYTES = 8_192
const MAX_SERVICE_REQUEST_ID = (1n << 64n) - 1n
export const DXGI_REPLAY_SERVICE_ALL_FLAGS = (1 << 18) - 1
// Pipeline bits 0..11, export/decode bits 13..16, and the GPU cursor
// composition proof in bit 17 are mandatory. Bit 12 records an optional
// successful reinitialization and is not required. Desktop Duplication may
// expose the hardware cursor as a separate plane, so a service that merely
// encoded its acquired texture must never displace the shipping recorder.
export const DXGI_REPLAY_SERVICE_REQUIRED_HEALTH_FLAGS =
  0x0fff | 0x1e000 | DXGI_REPLAY_CURSOR_COMPOSITED_FLAG

const serviceReasons = [
  'none',
  'invalid-request',
  'output-not-found',
  'factory-failed',
  'com-initialization-failed',
  'device-failed',
  'duplicate-access-denied',
  'duplicate-unsupported',
  'duplicate-limit-reached',
  'session-disconnected',
  'duplicate-failed',
  'video-processor-unavailable',
  'media-foundation-failed',
  'device-manager-failed',
  'adapter-scoped-enumeration-unavailable',
  'hardware-encoder-not-found',
  'encoder-activation-failed',
  'encoder-not-d3d11-aware',
  'encoder-rejected-device-manager',
  'internal-failure',
  'acquire-failed',
  'access-lost-exhausted',
  'unsupported-frame',
  'rotation-unsupported',
  'gpu-conversion-failed',
  'encoder-type-rejected',
  'encoder-stream-failed',
  'encoder-output-failed',
  'device-lost-exhausted',
  'reinitialize-failed',
  'capture-deadline-failed',
  'ring-rejected',
  'no-safe-snapshot',
  'codec-config-invalid',
  'codec-config-changed',
  'export-create',
  'export-write',
  'export-finalize',
  'export-structure',
  'export-decode',
  'service-protocol',
  'cursor-composition-unavailable',
] as const

export type DxgiReplayServiceReason = (typeof serviceReasons)[number]
export type DxgiReplayServicePacketKind = 'ready' | 'snapshot' | 'fatal'

export interface DxgiReplayServiceEvidence {
  readonly flags: number
  readonly width: number
  readonly height: number
  readonly targetFps: number
  readonly qpcFrequency: bigint
  readonly firstQpc: bigint
  readonly lastQpc: bigint
  readonly durationHns: bigint
  readonly sampleCount: bigint
  readonly keyframes: bigint
  readonly mp4Bytes: bigint
  readonly ringUnits: bigint
  readonly ringBytes: bigint
  readonly generation: number
  readonly lastHresult: number
  readonly encoderName?: string
}

export type DxgiReplayServicePacket = DxgiReplayServiceEvidence & {
  readonly kind: DxgiReplayServicePacketKind
  readonly status: 'ok' | 'unavailable'
  readonly reason: DxgiReplayServiceReason
  readonly requestId: bigint
}

function boundedUtf8(
  packet: Buffer,
  offset: number,
  capacity: number,
  length: number,
): string {
  if (length > capacity) throw new Error('DXGI replay service string exceeded its field')
  const field = packet.subarray(offset, offset + capacity)
  if (field.subarray(length).some((byte) => byte !== 0)) {
    throw new Error('DXGI replay service string padding was not zero')
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(field.subarray(0, length))
}

/** Strict decoder for one fixed native-service packet. */
export function parseDxgiReplayServicePacket(packet: Buffer): DxgiReplayServicePacket {
  if (packet.length !== DXGI_REPLAY_SERVICE_PACKET_BYTES) {
    throw new Error('DXGI replay service packet size was not exact')
  }
  if (!packet.subarray(0, 8).equals(DXGI_REPLAY_SERVICE_MAGIC)) {
    throw new Error('invalid DXGI replay service magic')
  }
  if (
    packet.readUInt16LE(8) !== DXGI_REPLAY_SERVICE_VERSION
    || packet.readUInt16LE(10) !== DXGI_REPLAY_SERVICE_PACKET_BYTES
  ) {
    throw new Error('unsupported DXGI replay service protocol')
  }
  const kind = (['', 'ready', 'snapshot', 'fatal'] as const)[packet.readUInt32LE(12)]
  if (kind === undefined || kind === '') throw new Error('unknown DXGI replay service packet kind')
  const rawStatus = packet.readUInt32LE(16)
  if (rawStatus !== 0 && rawStatus !== 1) throw new Error('unknown DXGI replay service status')
  const status = rawStatus === 0 ? 'ok' : 'unavailable'
  const reason = serviceReasons[packet.readUInt32LE(20)]
  if (reason === undefined) throw new Error('unknown DXGI replay service reason')
  const requestId = packet.readBigUInt64LE(24)
  const encoderName = boundedUtf8(packet, 132, 124, packet.readUInt32LE(128))
  const evidence: DxgiReplayServiceEvidence = {
    flags: packet.readUInt32LE(32),
    width: packet.readUInt32LE(36),
    height: packet.readUInt32LE(40),
    targetFps: packet.readUInt32LE(44),
    qpcFrequency: packet.readBigInt64LE(48),
    firstQpc: packet.readBigInt64LE(56),
    lastQpc: packet.readBigInt64LE(64),
    durationHns: packet.readBigInt64LE(72),
    sampleCount: packet.readBigUInt64LE(80),
    keyframes: packet.readBigUInt64LE(88),
    mp4Bytes: packet.readBigUInt64LE(96),
    ringUnits: packet.readBigUInt64LE(104),
    ringBytes: packet.readBigUInt64LE(112),
    generation: packet.readUInt32LE(120),
    lastHresult: packet.readInt32LE(124),
    ...(encoderName === '' ? {} : { encoderName }),
  }
  if (
    (evidence.flags & ~DXGI_REPLAY_SERVICE_ALL_FLAGS) !== 0
    || evidence.width > 16_384
    || evidence.height > 16_384
    || evidence.targetFps > 240
    || evidence.keyframes > evidence.sampleCount
    || evidence.ringUnits < evidence.sampleCount
    || evidence.ringBytes > BigInt(DXGI_REPLAY_MAX_EXPORT_BYTES)
    || evidence.mp4Bytes > BigInt(DXGI_REPLAY_MAX_EXPORT_BYTES)
  ) {
    throw new Error('DXGI replay service counters exceeded their bounds')
  }
  if (
    (kind === 'ready' && requestId !== 0n)
    || (kind === 'snapshot' && requestId === 0n)
    || (kind === 'fatal' && requestId !== 0n)
  ) {
    throw new Error('DXGI replay service request id contradicted packet kind')
  }
  if (status === 'ok') {
    if (
      reason !== 'none'
      || kind === 'fatal'
      || (evidence.flags & DXGI_REPLAY_SERVICE_REQUIRED_HEALTH_FLAGS)
        !== DXGI_REPLAY_SERVICE_REQUIRED_HEALTH_FLAGS
      || evidence.width === 0
      || evidence.height === 0
      || evidence.targetFps === 0
      || evidence.qpcFrequency <= 0n
      || evidence.firstQpc <= 0n
      || evidence.lastQpc < evidence.firstQpc
      || evidence.durationHns <= 0n
      || evidence.sampleCount === 0n
      || evidence.keyframes === 0n
      || evidence.mp4Bytes === 0n
      || evidence.ringUnits === 0n
      || evidence.ringBytes === 0n
      || evidence.generation === 0
      || evidence.lastHresult !== 0
      || encoderName === ''
    ) {
      throw new Error('successful DXGI replay service packet lacked health evidence')
    }
  } else if (reason === 'none') {
    throw new Error('unavailable DXGI replay service packet lacked a reason')
  }
  return { kind, status, reason, requestId, ...evidence }
}

export class DxgiReplayServicePacketParser {
  private buffered = Buffer.alloc(0)

  push(chunk: Buffer): DxgiReplayServicePacket[] {
    if (chunk.length === 0) return []
    if (this.buffered.length + chunk.length > DXGI_REPLAY_SERVICE_PACKET_BYTES * 256) {
      this.buffered = Buffer.alloc(0)
      throw new Error('DXGI replay service output exceeded its fixed buffer bound')
    }
    this.buffered = this.buffered.length === 0
      ? Buffer.from(chunk)
      : Buffer.concat([this.buffered, chunk])
    const packets: DxgiReplayServicePacket[] = []
    while (this.buffered.length >= DXGI_REPLAY_SERVICE_PACKET_BYTES) {
      packets.push(parseDxgiReplayServicePacket(
        this.buffered.subarray(0, DXGI_REPLAY_SERVICE_PACKET_BYTES),
      ))
      this.buffered = Buffer.from(this.buffered.subarray(DXGI_REPLAY_SERVICE_PACKET_BYTES))
    }
    return packets
  }

  finish(): void {
    if (this.buffered.length !== 0) {
      this.buffered = Buffer.alloc(0)
      throw new Error('DXGI replay service ended with a truncated packet')
    }
  }
}

export interface DxgiReplayMp4Validation {
  readonly status: 'valid'
  readonly durationMs: number
  readonly sampleCount: number
  readonly firstPresentationTimeMs: number
  readonly lastPresentationEndMs: number
}

export type DxgiReplayMp4ValidationResult = DxgiReplayMp4Validation | {
  readonly status: 'invalid'
  readonly reason: 'size' | 'structure' | 'codec' | 'timeline' | 'duration'
  readonly detail: string
}

interface Mp4Box { type: string; start: number; payloadStart: number; end: number }

function mp4Boxes(bytes: Buffer, start = 0, end = bytes.length): Mp4Box[] {
  const boxes: Mp4Box[] = []
  let cursor = start
  while (cursor < end) {
    if (end - cursor < 8) throw new Error(`truncated MP4 box at ${String(cursor)}`)
    const size32 = bytes.readUInt32BE(cursor)
    const type = bytes.toString('ascii', cursor + 4, cursor + 8)
    let header = 8
    let size = size32
    if (size32 === 1) {
      if (end - cursor < 16) throw new Error(`truncated extended ${type} box`)
      const extended = bytes.readBigUInt64BE(cursor + 8)
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${type} box is too large`)
      size = Number(extended)
      header = 16
    }
    if (size === 0 || size < header || size > end - cursor) {
      throw new Error(`invalid ${type} box size`)
    }
    boxes.push({ type, start: cursor, payloadStart: cursor + header, end: cursor + size })
    cursor += size
  }
  return boxes
}

function childBoxes(bytes: Buffer, parent: Mp4Box, skip = 0): Mp4Box[] {
  return mp4Boxes(bytes, parent.payloadStart + skip, parent.end)
}

function firstChild(bytes: Buffer, parent: Mp4Box, type: string, skip = 0): Mp4Box | undefined {
  return childBoxes(bytes, parent, skip).find((box) => box.type === type)
}

function videoTrackHasAvcConfig(bytes: Buffer, moov: Mp4Box): boolean {
  for (const trak of childBoxes(bytes, moov).filter((box) => box.type === 'trak')) {
    const mdia = firstChild(bytes, trak, 'mdia')
    if (mdia === undefined) continue
    const hdlr = firstChild(bytes, mdia, 'hdlr')
    if (hdlr === undefined || hdlr.payloadStart + 12 > hdlr.end) continue
    if (bytes.toString('ascii', hdlr.payloadStart + 8, hdlr.payloadStart + 12) !== 'vide') continue
    const minf = firstChild(bytes, mdia, 'minf')
    const stbl = minf === undefined ? undefined : firstChild(bytes, minf, 'stbl')
    const stsd = stbl === undefined ? undefined : firstChild(bytes, stbl, 'stsd')
    if (stsd === undefined || stsd.payloadStart + 8 > stsd.end) return false
    const entries = mp4Boxes(bytes, stsd.payloadStart + 8, stsd.end)
    for (const entry of entries) {
      if (entry.type !== 'avc1' && entry.type !== 'avc3') continue
      // ISO visual sample entry fields occupy 78 bytes before child boxes.
      if (entry.payloadStart + 78 > entry.end) return false
      const avcC = mp4Boxes(bytes, entry.payloadStart + 78, entry.end)
        .find((box) => box.type === 'avcC')
      if (avcC !== undefined && avcC.end - avcC.payloadStart >= 7
          && bytes[avcC.payloadStart] === 1) return true
    }
    return false
  }
  return false
}

/** Bounded structural and exact fMP4 timestamp validation; no external decoder/tool. */
export function validateDxgiReplayMp4(
  bytes: Buffer,
  reportedDurationMs: number,
  maximumBytes = DXGI_REPLAY_MAX_EXPORT_BYTES,
  maximumDurationMs = DXGI_REPLAY_MAX_RETENTION_MS,
): DxgiReplayMp4ValidationResult {
  if (bytes.length < 32 || bytes.length > maximumBytes) {
    return { status: 'invalid', reason: 'size', detail: 'MP4 byte length was outside bounds' }
  }
  let top: Mp4Box[]
  try {
    top = mp4Boxes(bytes)
  } catch (error) {
    return { status: 'invalid', reason: 'structure', detail: String(error) }
  }
  const ftyp = top.find((box) => box.type === 'ftyp')
  const moov = top.find((box) => box.type === 'moov')
  const mdats = top.filter((box) => box.type === 'mdat')
  const moofs = top.filter((box) => box.type === 'moof')
  if (
    ftyp === undefined
    || moov === undefined
    || mdats.length === 0
    || moofs.length === 0
    || mdats.every((box) => box.end === box.payloadStart)
  ) {
    return {
      status: 'invalid',
      reason: 'structure',
      detail: 'MP4 requires ftyp, moov and non-empty fragmented media',
    }
  }
  try {
    if (!videoTrackHasAvcConfig(bytes, moov)) {
      return { status: 'invalid', reason: 'codec', detail: 'video track lacked avc1/avc3 avcC' }
    }
  } catch (error) {
    return { status: 'invalid', reason: 'structure', detail: String(error) }
  }
  const exact = enumerateFmp4VideoSamples(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    {
      maxInputBytes: maximumBytes,
      maxBoxes: 100_000,
      maxSamples: 1_000_000,
    },
  )
  if (exact.status !== 'ok' || exact.tracks.length !== 1) {
    return {
      status: 'invalid',
      reason: 'timeline',
      detail: exact.status === 'invalid' ? exact.detail : 'MP4 did not contain exactly one video track',
    }
  }
  const samples = exact.tracks[0]?.samples ?? []
  if (samples.length === 0 || samples.some((sample) =>
    !Number.isFinite(sample.presentationTimeMs)
      || !Number.isFinite(sample.durationMs)
      || sample.durationMs <= 0)) {
    return { status: 'invalid', reason: 'timeline', detail: 'MP4 had no sane video samples' }
  }
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]
    const current = samples[index]
    if (previous === undefined || current === undefined
        || current.decodeTimeTicks <= previous.decodeTimeTicks) {
      return { status: 'invalid', reason: 'timeline', detail: 'MP4 decode timestamps were not monotone' }
    }
  }
  let firstPresentationTimeMs = Number.POSITIVE_INFINITY
  let lastPresentationEndMs = Number.NEGATIVE_INFINITY
  for (const sample of samples) {
    firstPresentationTimeMs = Math.min(firstPresentationTimeMs, sample.presentationTimeMs)
    lastPresentationEndMs = Math.max(
      lastPresentationEndMs,
      sample.presentationTimeMs + sample.durationMs,
    )
  }
  const durationMs = lastPresentationEndMs - firstPresentationTimeMs
  const toleranceMs = Math.max(100, 2_000 / exact.tracks[0]!.timescale)
  if (
    !Number.isFinite(reportedDurationMs)
    || reportedDurationMs <= 0
    || reportedDurationMs > maximumDurationMs
    || firstPresentationTimeMs < -toleranceMs
    || Math.abs(firstPresentationTimeMs) > toleranceMs
    || durationMs <= 0
    || durationMs > maximumDurationMs + toleranceMs
    || Math.abs(durationMs - reportedDurationMs) > toleranceMs
  ) {
    return { status: 'invalid', reason: 'duration', detail: 'MP4 duration disagreed with bounded service evidence' }
  }
  return {
    status: 'valid',
    durationMs,
    sampleCount: samples.length,
    firstPresentationTimeMs,
    lastPresentationEndMs,
  }
}

export type DxgiReplayRuntimeFallbackReason =
  | 'switch-disabled'
  | 'unsupported-platform'
  | 'helper-missing'
  | 'capability-unavailable'
  | 'native-not-ready'
  | 'native-runtime-failed'
  | 'native-export-failed'

export type DxgiReplayRuntimeSelection =
  | { readonly backend: 'shipping'; readonly reason: DxgiReplayRuntimeFallbackReason; readonly detail?: string }
  | { readonly backend: 'native-dxgi'; readonly ready: DxgiReplayServicePacket }

export function dxgiReplayRuntimeOptedIn(
  argv: readonly string[],
  injected?: boolean,
): boolean {
  return injected ?? argv.includes(DXGI_REPLAY_RUNTIME_SWITCH)
}

export function selectDxgiReplayRuntime(input: {
  optedIn: boolean
  platform: NodeJS.Platform
  helperExists: boolean
  capability?: DxgiReplayCapability
  ready?: DxgiReplayServicePacket
}): DxgiReplayRuntimeSelection {
  if (!input.optedIn) return { backend: 'shipping', reason: 'switch-disabled' }
  if (input.platform !== 'win32') return { backend: 'shipping', reason: 'unsupported-platform' }
  if (!input.helperExists) return { backend: 'shipping', reason: 'helper-missing' }
  if (input.capability?.status !== 'available') {
    return {
      backend: 'shipping',
      reason: 'capability-unavailable',
      ...(input.capability?.status === 'unavailable' ? { detail: input.capability.reason } : {}),
    }
  }
  if (input.ready?.kind !== 'ready' || input.ready.status !== 'ok') {
    return {
      backend: 'shipping',
      reason: 'native-not-ready',
      ...(input.ready === undefined ? {} : { detail: input.ready.reason }),
    }
  }
  return { backend: 'native-dxgi', ready: input.ready }
}

export interface DxgiReplayRuntimeStartRequest {
  readonly deviceName?: string
  readonly bounds?: DxgiReplayBounds
  readonly retentionMs: number
}

export interface DxgiReplayRuntimeSnapshot {
  readonly status: 'ok'
  readonly buffer: Buffer
  readonly durationMs: number
  readonly sampleCount: number
  readonly keyframes: number
  readonly evidence: DxgiReplayServicePacket
}

export type DxgiReplayRuntimeSnapshotResult = DxgiReplayRuntimeSnapshot | {
  readonly status: 'fallback'
  readonly reason: 'native-not-selected' | 'invalid-timeout' | 'native-export-failed'
  readonly detail?: string
}

export interface DxgiReplayRuntimeProcess {
  readonly stdin: { write(data: string): boolean; end(): void }
  readonly stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown }
  readonly stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown }
  once(event: 'error', listener: (error: Error) => void): unknown
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  kill(): boolean
}

interface PendingSnapshot {
  outputPath: string
  minimumDurationMs: number
  resolve: (result: DxgiReplayRuntimeSnapshotResult) => void
  timer: NodeJS.Timeout
}

export interface DxgiReplayRuntimeManagerOptions {
  readonly enabled?: boolean
  readonly argv?: readonly string[]
  readonly platform?: NodeJS.Platform
  readonly helperPath?: string
  readonly outputDirectory: string
  readonly startupTimeoutMs?: number
  readonly snapshotTimeoutMs?: number
  readonly maximumExportBytes?: number
  readonly nowMs?: () => number
  readonly fileExists?: (value: string) => boolean
  readonly probe?: typeof probeDxgiReplayCapability
  readonly spawnProcess?: (executable: string, args: readonly string[]) => DxgiReplayRuntimeProcess
  readonly onFallback?: (selection: Extract<DxgiReplayRuntimeSelection, { backend: 'shipping' }>) => void
  /** Test seam for best-effort deletion after an export has stopped using its file. */
  readonly cleanupOutputFile?: (outputPath: string) => Promise<void>
  /** Cleanup failures are observable but never replace the original export result. */
  readonly onCleanupError?: (outputPath: string, error: unknown) => void
}

export class DxgiReplayRuntimeManager {
  private process: DxgiReplayRuntimeProcess | null = null
  private parser = new DxgiReplayServicePacketParser()
  private selection: DxgiReplayRuntimeSelection = { backend: 'shipping', reason: 'switch-disabled' }
  private pendingReady: ((packet: DxgiReplayServicePacket) => void) | null = null
  private pendingSnapshots = new Map<bigint, PendingSnapshot>()
  private snapshotInFlight = false
  private nextRequestId = 1n
  private retentionMs = 0
  private serviceStartedAtMs: number | null = null
  private stderr = ''
  private stopping = false
  private lifecycleGeneration = 0
  private readonly exitedProcesses = new WeakSet<object>()

  constructor(private readonly options: DxgiReplayRuntimeManagerOptions) {}

  currentSelection(): DxgiReplayRuntimeSelection {
    return this.selection
  }

  async start(request: DxgiReplayRuntimeStartRequest): Promise<DxgiReplayRuntimeSelection> {
    this.stop()
    const startGeneration = this.lifecycleGeneration
    const argv = this.options.argv ?? process.argv
    const platform = this.options.platform ?? process.platform
    const optedIn = dxgiReplayRuntimeOptedIn(argv, this.options.enabled)
    if (!optedIn) return this.setFallback('switch-disabled')
    if (platform !== 'win32') return this.setFallback('unsupported-platform')
    if (!Number.isSafeInteger(request.retentionMs)
        || request.retentionMs < DXGI_REPLAY_MIN_RETENTION_MS
        || request.retentionMs > DXGI_REPLAY_MAX_RETENTION_MS) {
      return this.setFallback('native-not-ready', 'retention was outside service bounds')
    }
    const helper = this.options.helperPath ?? dxgiReplayRingHelperPath()
    const fileExists = this.options.fileExists ?? existsSync
    if (helper === null || !fileExists(helper)) return this.setFallback('helper-missing')
    const identityArgs = dxgiReplayCapabilityArguments(request)
    if (identityArgs === null) return this.setFallback('capability-unavailable', 'invalid-request')
    let capability: DxgiReplayCapability
    try {
      capability = await (this.options.probe ?? probeDxgiReplayCapability)({
        deviceName: request.deviceName,
        bounds: request.bounds,
        platform,
        helperPath: helper,
      })
    } catch (error) {
      return this.setFallback('capability-unavailable', String(error))
    }
    if (this.lifecycleGeneration !== startGeneration) {
      return { backend: 'shipping', reason: 'native-not-ready', detail: 'start was cancelled' }
    }
    if (capability.status !== 'available') {
      return this.setFallback('capability-unavailable', capability.reason)
    }
    this.retentionMs = request.retentionMs
    this.parser = new DxgiReplayServicePacketParser()
    this.stderr = ''
    this.stopping = false
    let child: DxgiReplayRuntimeProcess
    try {
      child = (this.options.spawnProcess ?? ((executable, args) => spawn(
        executable,
        [...args],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      ) as ChildProcessWithoutNullStreams))(
        helper,
        [...identityArgs, '--serve', '--retention-ms', String(request.retentionMs)],
      )
    } catch (error) {
      return this.setFallback('native-not-ready', String(error))
    }
    this.process = child
    this.serviceStartedAtMs = this.options.nowMs?.() ?? performance.now()
    child.stdout.on('data', (chunk: Buffer) => this.onStdout(child, chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-MAX_STDERR_BYTES)
    })
    child.once('error', (error) => this.failProcess(child, 'native-runtime-failed', error.message))
    child.once('close', (code, signal) => {
      this.exitedProcesses.add(child)
      if (this.stopping || this.process !== child) return
      try {
        this.parser.finish()
      } catch (error) {
        this.failProcess(child, 'native-runtime-failed', String(error))
        return
      }
      this.failProcess(
        child,
        'native-runtime-failed',
        `DXGI replay service exited ${String(code ?? signal ?? 'unknown')}`,
      )
    })
    const ready = await new Promise<DxgiReplayServicePacket | null>((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.pendingReady = null
        resolve(null)
      }, this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS)
      timer.unref()
      this.pendingReady = (packet) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.pendingReady = null
        resolve(packet)
      }
    })
    if (this.lifecycleGeneration !== startGeneration || this.process !== child) {
      return { backend: 'shipping', reason: 'native-not-ready', detail: 'start was cancelled' }
    }
    const selected = selectDxgiReplayRuntime({
      optedIn,
      platform,
      helperExists: true,
      capability,
      ...(ready === null ? {} : { ready }),
    })
    if (selected.backend === 'shipping') {
      this.stop()
      return this.setFallback(selected.reason, selected.detail)
    }
    this.selection = selected
    return selected
  }

  async snapshot(timeoutMs = this.options.snapshotTimeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS): Promise<DxgiReplayRuntimeSnapshotResult> {
    const child = this.process
    if (child === null || this.selection.backend !== 'native-dxgi') {
      return { status: 'fallback', reason: 'native-not-selected' }
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
      return { status: 'fallback', reason: 'invalid-timeout' }
    }
    if (this.snapshotInFlight) {
      return {
        status: 'fallback',
        reason: 'native-export-failed',
        detail: 'one DXGI replay snapshot is already in flight',
      }
    }
    this.snapshotInFlight = true
    try {
      await mkdir(this.options.outputDirectory, { recursive: true })
    } catch (error) {
      this.snapshotInFlight = false
      this.failProcess(child, 'native-export-failed', String(error))
      return { status: 'fallback', reason: 'native-export-failed', detail: String(error) }
    }
    const requestId = this.nextRequestId
    this.nextRequestId = requestId === MAX_SERVICE_REQUEST_ID ? 1n : requestId + 1n
    const outputPath = path.resolve(
      this.options.outputDirectory,
      `capturepack-dxgi-${process.pid}-${requestId.toString()}-${randomUUID()}.mp4`,
    )
    const command = `SNAPSHOT\t${requestId.toString()}\t${outputPath}\n`
    if (
      !path.isAbsolute(outputPath)
      || /[\0\r\n\t]/u.test(outputPath)
      || Buffer.byteLength(command, 'utf8') > DXGI_REPLAY_SERVICE_MAX_COMMAND_BYTES
    ) {
      this.snapshotInFlight = false
      return { status: 'fallback', reason: 'native-export-failed', detail: 'unsafe snapshot path' }
    }
    try {
      await rm(outputPath, { force: true })
    } catch (error) {
      this.snapshotInFlight = false
      this.failProcess(child, 'native-export-failed', String(error))
      return { status: 'fallback', reason: 'native-export-failed', detail: String(error) }
    }
    const nowMs = this.options.nowMs?.() ?? performance.now()
    const availableHistoryMs = this.serviceStartedAtMs === null
      ? 0
      : Math.max(0, nowMs - this.serviceStartedAtMs)
    const minimumDurationMs = Math.max(
      0,
      Math.min(this.retentionMs, availableHistoryMs)
        - DXGI_REPLAY_MAX_GOP_MS
        - DXGI_REPLAY_DURATION_TOLERANCE_MS,
    )
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingSnapshots.delete(requestId)
        this.snapshotInFlight = false
        // The service can still have the MP4 open here. Defer deletion until
        // process close so Windows cannot leave a retention-sized orphan.
        this.cleanupOutputAfterExit(child, outputPath)
        this.failProcess(child, 'native-export-failed', 'DXGI replay snapshot timed out')
        resolve({ status: 'fallback', reason: 'native-export-failed', detail: 'snapshot timeout' })
      }, timeoutMs)
      timer.unref()
      this.pendingSnapshots.set(requestId, {
        outputPath,
        minimumDurationMs,
        resolve,
        timer,
      })
      try {
        if (!child.stdin.write(command)) {
          // Pipe backpressure is bounded by allowing only the pending requests
          // already represented in this map; the response remains asynchronous.
        }
      } catch (error) {
        clearTimeout(timer)
        this.pendingSnapshots.delete(requestId)
        this.snapshotInFlight = false
        this.failProcess(child, 'native-export-failed', String(error))
        resolve({ status: 'fallback', reason: 'native-export-failed', detail: String(error) })
      }
    })
  }

  stop(): void {
    this.lifecycleGeneration += 1
    const child = this.process
    this.process = null
    this.serviceStartedAtMs = null
    const cancelReady = this.pendingReady
    this.pendingReady = null
    cancelReady?.(unavailableServicePacket('internal-failure'))
    this.stopping = true
    this.snapshotInFlight = false
    for (const [requestId, pending] of this.pendingSnapshots) {
      clearTimeout(pending.timer)
      pending.resolve({ status: 'fallback', reason: 'native-export-failed', detail: 'service stopped' })
      // STOP may take time to finalize/cancel an export, especially on
      // Windows where an open Media Foundation sink prevents unlinking.
      if (child === null) this.cleanupOutput(pending.outputPath)
      else this.cleanupOutputAfterExit(child, pending.outputPath)
      this.pendingSnapshots.delete(requestId)
    }
    if (child !== null) {
      try { child.stdin.write('STOP\n') } catch { /* already gone */ }
      try { child.stdin.end() } catch { /* already gone */ }
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* already gone */ }
      }, STOP_TIMEOUT_MS)
      timer.unref()
    }
    this.selection = { backend: 'shipping', reason: 'switch-disabled' }
  }

  private setFallback(
    reason: DxgiReplayRuntimeFallbackReason,
    detail?: string,
  ): Extract<DxgiReplayRuntimeSelection, { backend: 'shipping' }> {
    const selection = {
      backend: 'shipping' as const,
      reason,
      ...(detail === undefined || detail === '' ? {} : { detail }),
    }
    this.selection = selection
    this.options.onFallback?.(selection)
    return selection
  }

  private onStdout(child: DxgiReplayRuntimeProcess, chunk: Buffer): void {
    if (this.process !== child) return
    let packets: DxgiReplayServicePacket[]
    try {
      packets = this.parser.push(chunk)
    } catch (error) {
      this.failProcess(child, 'native-runtime-failed', String(error))
      return
    }
    for (const packet of packets) {
      if (packet.kind === 'ready') {
        if (this.pendingReady === null) {
          this.failProcess(child, 'native-runtime-failed', 'unexpected READY packet')
          return
        }
        this.pendingReady(packet)
      } else if (packet.kind === 'snapshot') {
        void this.finishSnapshot(child, packet)
      } else {
        this.pendingReady?.(packet)
        this.failProcess(child, 'native-runtime-failed', packet.reason)
      }
    }
  }

  private async finishSnapshot(
    child: DxgiReplayRuntimeProcess,
    packet: DxgiReplayServicePacket,
  ): Promise<void> {
    const pending = this.pendingSnapshots.get(packet.requestId)
    if (pending === undefined || this.process !== child) {
      this.failProcess(child, 'native-export-failed', 'unexpected snapshot response')
      return
    }
    this.pendingSnapshots.delete(packet.requestId)
    clearTimeout(pending.timer)
    if (packet.status !== 'ok') {
      this.snapshotInFlight = false
      this.failProcess(child, 'native-export-failed', packet.reason)
      pending.resolve({ status: 'fallback', reason: 'native-export-failed', detail: packet.reason })
      this.cleanupOutput(pending.outputPath)
      return
    }
    try {
      const info = await stat(pending.outputPath)
      const maximumBytes = this.options.maximumExportBytes ?? DXGI_REPLAY_MAX_EXPORT_BYTES
      if (!info.isFile() || info.size !== Number(packet.mp4Bytes) || info.size > maximumBytes) {
        throw new Error('snapshot file size disagreed with service evidence')
      }
      const buffer = await readFile(pending.outputPath)
      const durationMs = Number(packet.durationHns) / 10_000
      const validated = validateDxgiReplayMp4(
        buffer,
        durationMs,
        maximumBytes,
        this.retentionMs + 100,
      )
      if (validated.status !== 'valid') throw new Error(`${validated.reason}: ${validated.detail}`)
      if (validated.durationMs < pending.minimumDurationMs) {
        throw new Error(
          `MP4 retained ${String(validated.durationMs)} ms; ` +
          `required at least ${String(pending.minimumDurationMs)} ms`,
        )
      }
      if (validated.sampleCount !== Number(packet.sampleCount)) {
        throw new Error('MP4 sample count disagreed with service evidence')
      }
      pending.resolve({
        status: 'ok',
        buffer,
        durationMs: validated.durationMs,
        sampleCount: validated.sampleCount,
        keyframes: Number(packet.keyframes),
        evidence: packet,
      })
    } catch (error) {
      this.failProcess(child, 'native-export-failed', String(error))
      pending.resolve({ status: 'fallback', reason: 'native-export-failed', detail: String(error) })
    } finally {
      this.cleanupOutput(pending.outputPath)
      this.snapshotInFlight = false
    }
  }

  private cleanupOutputAfterExit(child: DxgiReplayRuntimeProcess, outputPath: string): void {
    if (this.exitedProcesses.has(child)) {
      this.cleanupOutput(outputPath)
      return
    }
    child.once('close', () => {
      this.exitedProcesses.add(child)
      this.cleanupOutput(outputPath)
    })
  }

  private cleanupOutput(outputPath: string): void {
    const cleanup = this.options.cleanupOutputFile
      ?? ((value: string) => rm(value, { force: true }))
    void cleanup(outputPath).catch((error: unknown) => {
      this.options.onCleanupError?.(outputPath, error)
    })
  }

  private failProcess(
    child: DxgiReplayRuntimeProcess,
    reason: 'native-runtime-failed' | 'native-export-failed',
    detail: string,
  ): void {
    if (this.process !== child) return
    this.process = null
    this.snapshotInFlight = false
    this.pendingReady?.(unavailableServicePacket('internal-failure'))
    this.pendingReady = null
    const suffix = this.stderr.trim() === '' ? '' : `: ${this.stderr.trim()}`
    this.setFallback(reason, detail + suffix)
    for (const [requestId, pending] of this.pendingSnapshots) {
      clearTimeout(pending.timer)
      pending.resolve({ status: 'fallback', reason: 'native-export-failed', detail })
      this.cleanupOutputAfterExit(child, pending.outputPath)
      this.pendingSnapshots.delete(requestId)
    }
    try { child.stdin.end() } catch { /* already gone */ }
    try { child.kill() } catch { /* already gone */ }
  }
}

function unavailableServicePacket(reason: DxgiReplayServiceReason): DxgiReplayServicePacket {
  return {
    kind: 'fatal', status: 'unavailable', reason, requestId: 0n,
    flags: 0, width: 0, height: 0, targetFps: 0, qpcFrequency: 0n,
    firstQpc: 0n, lastQpc: 0n, durationHns: 0n, sampleCount: 0n,
    keyframes: 0n, mp4Bytes: 0n, ringUnits: 0n, ringBytes: 0n,
    generation: 0, lastHresult: -1,
  }
}

export interface DxgiReplayRuntimeDisplay {
  readonly id: number
  readonly deviceName?: string
  readonly bounds: DxgiReplayBounds
}

export interface DxgiReplayRuntimeSyncOptions {
  /** Explicit opt-in; false is the default and keeps every shipping recorder. */
  readonly enabled: boolean
  readonly retentionMs: number
  /** Part of resource identity even though the v1 native service fixes its own target rate. */
  readonly fps: number
}

export interface DxgiReplayRuntimeReplay {
  readonly buffer: Buffer
  readonly durationMs: number
  readonly mimeType: 'video/mp4'
  readonly replayFile: 'replay.mp4'
}

export interface DxgiReplayRuntimeOptions
  extends Omit<DxgiReplayRuntimeManagerOptions, 'enabled' | 'onFallback'> {
  readonly onStatus?: (displayId: number, selection: DxgiReplayRuntimeSelection) => void
}

/**
 * App-facing owner for one persistent native candidate per display. Shipping
 * recorders remain outside this class and therefore remain available whenever
 * any method returns a shipping selection or null.
 */
export class DxgiReplayRuntime {
  private readonly displays = new Map<number, {
    manager: DxgiReplayRuntimeManager
    signature: string
  }>()

  constructor(private readonly options: DxgiReplayRuntimeOptions) {}

  async sync(
    displays: readonly DxgiReplayRuntimeDisplay[],
    settings: DxgiReplayRuntimeSyncOptions,
  ): Promise<ReadonlyMap<number, DxgiReplayRuntimeSelection>> {
    const wanted = new Set(displays.map((display) => display.id))
    this.retain(wanted)
    const results = new Map<number, DxgiReplayRuntimeSelection>()
    await Promise.all(displays.map(async (display) => {
      const signature = JSON.stringify({
        deviceName: display.deviceName ?? null,
        bounds: display.bounds,
        retentionMs: settings.retentionMs,
        fps: settings.fps,
        enabled: settings.enabled,
      })
      const current = this.displays.get(display.id)
      if (
        current !== undefined
        && current.signature === signature
        && current.manager.currentSelection().backend === 'native-dxgi'
      ) {
        results.set(display.id, current.manager.currentSelection())
        return
      }
      if (current !== undefined) this.stop(display.id)
      const manager = new DxgiReplayRuntimeManager({
        ...this.options,
        enabled: settings.enabled,
        onFallback: (selection) => this.options.onStatus?.(display.id, selection),
      })
      this.displays.set(display.id, { manager, signature })
      const selection = await manager.start({
        deviceName: display.deviceName,
        bounds: display.bounds,
        retentionMs: settings.retentionMs,
      })
      const active = this.displays.get(display.id)
      if (active?.manager !== manager) {
        manager.stop()
        results.set(
          display.id,
          active?.manager.currentSelection()
            ?? { backend: 'shipping', reason: 'native-not-ready', detail: 'sync was superseded' },
        )
        return
      }
      results.set(display.id, selection)
      if (selection.backend === 'native-dxgi') this.options.onStatus?.(display.id, selection)
    }))
    return results
  }

  async snapshot(displayId: number, timeoutMs: number): Promise<DxgiReplayRuntimeReplay | null> {
    const manager = this.displays.get(displayId)?.manager
    if (manager === undefined) return null
    const result = await manager.snapshot(timeoutMs)
    if (this.displays.get(displayId)?.manager !== manager) return null
    return result.status === 'ok'
      ? {
          buffer: result.buffer,
          durationMs: result.durationMs,
          mimeType: 'video/mp4',
          replayFile: 'replay.mp4',
        }
      : null
  }

  currentSelection(displayId: number): DxgiReplayRuntimeSelection | null {
    return this.displays.get(displayId)?.manager.currentSelection() ?? null
  }

  retain(displayIds: ReadonlySet<number>): void {
    for (const displayId of [...this.displays.keys()]) {
      if (!displayIds.has(displayId)) this.stop(displayId)
    }
  }

  stop(displayId: number): void {
    const current = this.displays.get(displayId)
    if (current === undefined) return
    this.displays.delete(displayId)
    current.manager.stop()
  }

  stopAll(): void {
    for (const displayId of [...this.displays.keys()]) this.stop(displayId)
  }
}
