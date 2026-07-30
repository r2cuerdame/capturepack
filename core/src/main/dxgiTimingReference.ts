import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type {
  CaptureDxgiTimingMetadataPayload,
  CaptureDxgiTimingReferencePayload,
} from '../shared/ipc'

const MAGIC = Buffer.from('CPDXGI01', 'ascii')
export const DXGI_TIMING_HEADER_BYTES = 176
export const DXGI_TIMING_WIDTH = 128
export const DXGI_TIMING_HEIGHT = 72
export const DXGI_TIMING_CHANNELS = 3
export const DXGI_TIMING_RGB_BYTES =
  DXGI_TIMING_WIDTH * DXGI_TIMING_HEIGHT * DXGI_TIMING_CHANNELS
const MAX_PACKET_BYTES = DXGI_TIMING_HEADER_BYTES + DXGI_TIMING_RGB_BYTES
const PROTOCOL_VERSION = 1
const DEFAULT_ACQUIRE_TIMEOUT_MS = 80
const MAX_ACQUIRE_TIMEOUT_MS = 250
const COPY_TIMEOUT_MS = 80
const DEFAULT_PROCESS_TIMEOUT_MS = 500
const MAX_PROCESS_TIMEOUT_MS = 1_000
const MAX_STDERR_BYTES = 8_192

const nativeReasons = [
  'none',
  'output-not-found',
  'factory-failed',
  'device-failed',
  'duplicate-failed',
  'timeout',
  'no-desktop-update',
  'access-lost',
  'resource-unavailable',
  'texture-unavailable',
  'unsupported-format',
  'copy-timeout',
  'map-failed',
  'unsupported-rotation',
  'internal-failure',
] as const

export type DxgiTimingNativeUnavailableReason =
  (typeof nativeReasons)[number]
export type DxgiTimingUnavailableReason =
  | DxgiTimingNativeUnavailableReason
  | 'unsupported-platform'
  | 'helper-missing'
  | 'invalid-request'
  | 'helper-timeout'
  | 'helper-failed'
  | 'malformed-output'

export interface DxgiTimingBounds {
  x: number
  y: number
  width: number
  height: number
}

interface DxgiTimingMetadata {
  readonly deviceName: string
  readonly adapterIndex: number
  readonly outputIndex: number
  readonly bounds: DxgiTimingBounds
  readonly qpcFrequency: bigint
  readonly anchor: {
    /** Midpoint of the QPC bracket around GetSystemTimePreciseAsFileTime. */
    readonly qpc: bigint
    readonly unixNs: bigint
    /** Full before↔after QPC bracket, retained instead of claiming zero error. */
    readonly spanQpc: bigint
  }
}

export interface DxgiTimingAvailable extends DxgiTimingMetadata {
  readonly status: 'available'
  readonly width: typeof DXGI_TIMING_WIDTH
  readonly height: typeof DXGI_TIMING_HEIGHT
  readonly channels: typeof DXGI_TIMING_CHANNELS
  readonly lastPresentQpc: bigint
  readonly accumulatedFrames: number
  /** Row-major RGB bytes from the acquired resource named by lastPresentQpc. */
  readonly rgb: Buffer
}

export interface DxgiTimingUnavailable {
  readonly status: 'unavailable'
  readonly reason: DxgiTimingUnavailableReason
  readonly detail?: string
  readonly deviceName?: string
  readonly adapterIndex?: number
  readonly outputIndex?: number
  readonly bounds?: DxgiTimingBounds
  readonly qpcFrequency?: bigint
  readonly anchor?: DxgiTimingMetadata['anchor']
}

export type DxgiTimingReference =
  | DxgiTimingAvailable
  | DxgiTimingUnavailable

export interface CaptureDxgiTimingReferenceRequest {
  /** Exact DXGI DeviceName (for example "\\\\.\\DISPLAY1"), if known. */
  readonly deviceName?: string
  /** Exact physical-pixel output bounds from screen.dipToScreenRect. */
  readonly bounds?: DxgiTimingBounds
  /** AcquireNextFrame budget. Clamped to the helper's hard 250 ms maximum. */
  readonly timeoutMs?: number
  /** Whole child-process budget. Clamped to 1 second. */
  readonly processTimeoutMs?: number
  /** Primarily for tests; normal callers use dxgiTimingReferenceHelperPath(). */
  readonly helperPath?: string
}

function metadataToIpc(
  reference: DxgiTimingMetadata,
): CaptureDxgiTimingMetadataPayload {
  return {
    deviceName: reference.deviceName,
    adapterIndex: reference.adapterIndex,
    outputIndex: reference.outputIndex,
    bounds: reference.bounds,
    qpcFrequency: reference.qpcFrequency.toString(10),
    anchor: {
      qpc: reference.anchor.qpc.toString(10),
      unixNs: reference.anchor.unixNs.toString(10),
      spanQpc: reference.anchor.spanQpc.toString(10),
    },
  }
}

/**
 * Electron structured clone has no Buffer contract and BigInt support differs
 * across runtime boundaries. Keep the wire format explicit and lossless.
 */
export function dxgiTimingReferenceToIpc(
  reference: DxgiTimingReference,
): CaptureDxgiTimingReferencePayload {
  if (reference.status === 'available') {
    return {
      status: 'available',
      referenceTiming: 'pixel-exposure',
      resourceProvenance: 'same-acquired-dxgi-resource',
      clockProvenance: 'windows-qpc',
      ...metadataToIpc(reference),
      width: reference.width,
      height: reference.height,
      channels: reference.channels,
      lastPresentQpc: reference.lastPresentQpc.toString(10),
      accumulatedFrames: reference.accumulatedFrames,
      rgb: Uint8Array.from(reference.rgb).buffer,
    }
  }
  const metadata =
    reference.deviceName !== undefined
    && reference.adapterIndex !== undefined
    && reference.outputIndex !== undefined
    && reference.bounds !== undefined
    && reference.qpcFrequency !== undefined
    && reference.anchor !== undefined
      ? metadataToIpc({
          deviceName: reference.deviceName,
          adapterIndex: reference.adapterIndex,
          outputIndex: reference.outputIndex,
          bounds: reference.bounds,
          qpcFrequency: reference.qpcFrequency,
          anchor: reference.anchor,
        })
      : undefined
  return {
    status: 'unavailable',
    reason: reference.reason,
    ...(reference.detail === undefined ? {} : { detail: reference.detail }),
    ...(metadata ?? {}),
  }
}

function unavailable(
  reason: DxgiTimingUnavailableReason,
  detail?: string,
): DxgiTimingUnavailable {
  return {
    status: 'unavailable',
    reason,
    ...(detail === undefined || detail === '' ? {} : { detail }),
  }
}

function validBounds(bounds: DxgiTimingBounds | undefined): bounds is DxgiTimingBounds {
  if (bounds === undefined) return false
  return (
    Number.isSafeInteger(bounds.x)
    && Number.isSafeInteger(bounds.y)
    && Number.isSafeInteger(bounds.width)
    && Number.isSafeInteger(bounds.height)
    && bounds.width > 0
    && bounds.height > 0
    && bounds.x >= -2_147_483_648
    && bounds.y >= -2_147_483_648
    && bounds.x + bounds.width <= 2_147_483_647
    && bounds.y + bounds.height <= 2_147_483_647
  )
}

function metadataFromHeader(packet: Buffer): DxgiTimingMetadata {
  const left = packet.readInt32LE(44)
  const top = packet.readInt32LE(48)
  const right = packet.readInt32LE(52)
  const bottom = packet.readInt32LE(56)
  const deviceNameBytes = packet.readUInt32LE(104)
  if (
    right <= left
    || bottom <= top
    || deviceNameBytes > 64
  ) {
    throw new Error('invalid DXGI timing output identity')
  }
  const qpcFrequency = packet.readBigInt64LE(68)
  const anchorQpc = packet.readBigInt64LE(76)
  const anchorUnixNs = packet.readBigInt64LE(84)
  const anchorSpanQpc = packet.readBigUInt64LE(92)
  if (qpcFrequency <= 0n || anchorQpc <= 0n || anchorUnixNs <= 0n) {
    throw new Error('invalid DXGI timing clock anchor')
  }
  return {
    deviceName: packet
      .subarray(108, 108 + deviceNameBytes)
      .toString('utf8'),
    adapterIndex: packet.readUInt32LE(36),
    outputIndex: packet.readUInt32LE(40),
    bounds: {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    },
    qpcFrequency,
    anchor: {
      qpc: anchorQpc,
      unixNs: anchorUnixNs,
      spanQpc: anchorSpanQpc,
    },
  }
}

/**
 * Parse exactly one bounded helper packet.
 *
 * There is deliberately no resynchronization or trailing-byte tolerance: this
 * is a one-shot child, so accepting a prefix could pair metadata with corrupt
 * or attacker-controlled pixels.
 */
export function parseDxgiTimingReference(packet: Buffer): DxgiTimingReference {
  if (packet.length < DXGI_TIMING_HEADER_BYTES) {
    throw new Error('truncated DXGI timing header')
  }
  if (packet.length > MAX_PACKET_BYTES) {
    throw new Error('DXGI timing packet exceeded its fixed bound')
  }
  if (!packet.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('invalid DXGI timing magic')
  }
  if (
    packet.readUInt16LE(8) !== PROTOCOL_VERSION
    || packet.readUInt16LE(10) !== DXGI_TIMING_HEADER_BYTES
  ) {
    throw new Error('unsupported DXGI timing protocol')
  }
  const status = packet.readUInt32LE(12)
  const reasonCode = packet.readUInt32LE(16)
  const pixelBytes = packet.readUInt32LE(32)
  if (status === 1) {
    if (pixelBytes !== 0 || packet.length !== DXGI_TIMING_HEADER_BYTES) {
      throw new Error('unavailable DXGI timing packet carried pixels')
    }
    const reason = nativeReasons[reasonCode]
    if (reason === undefined || reason === 'none') {
      throw new Error('invalid DXGI timing unavailable reason')
    }
    // Output discovery can fail before bounds and a clock-bearing device are
    // known. Every later native failure retains that useful identity.
    try {
      return {
        status: 'unavailable',
        reason,
        ...metadataFromHeader(packet),
      }
    } catch {
      return { status: 'unavailable', reason }
    }
  }
  if (status !== 0 || reasonCode !== 0) {
    throw new Error('invalid DXGI timing status')
  }
  const width = packet.readUInt32LE(20)
  const height = packet.readUInt32LE(24)
  const channels = packet.readUInt32LE(28)
  if (
    width !== DXGI_TIMING_WIDTH
    || height !== DXGI_TIMING_HEIGHT
    || channels !== DXGI_TIMING_CHANNELS
    || pixelBytes !== DXGI_TIMING_RGB_BYTES
    || packet.length !== DXGI_TIMING_HEADER_BYTES + pixelBytes
  ) {
    throw new Error('invalid DXGI timing RGB dimensions')
  }
  const lastPresentQpc = packet.readBigInt64LE(60)
  const accumulatedFrames = packet.readUInt32LE(100)
  if (lastPresentQpc <= 0n || accumulatedFrames === 0) {
    throw new Error('available DXGI timing packet lacked a desktop presentation')
  }
  return {
    status: 'available',
    ...metadataFromHeader(packet),
    width,
    height,
    channels,
    lastPresentQpc,
    accumulatedFrames,
    rgb: Buffer.from(packet.subarray(DXGI_TIMING_HEADER_BYTES)),
  }
}

export class DxgiTimingReferenceParser {
  private chunks: Buffer[] = []
  private bytes = 0

  push(chunk: Buffer): void {
    if (chunk.length === 0) return
    if (this.bytes + chunk.length > MAX_PACKET_BYTES) {
      this.chunks = []
      this.bytes = 0
      throw new Error('DXGI timing stdout exceeded its fixed bound')
    }
    this.chunks.push(Buffer.from(chunk))
    this.bytes += chunk.length
  }

  finish(): DxgiTimingReference {
    const packet = Buffer.concat(this.chunks, this.bytes)
    this.chunks = []
    this.bytes = 0
    try {
      return parseDxgiTimingReference(packet)
    } catch (error) {
      const prefix = packet.subarray(
        0,
        Math.min(packet.length, DXGI_TIMING_HEADER_BYTES),
      )
      const fields = packet.length < DXGI_TIMING_HEADER_BYTES
        ? { packetBytes: packet.length }
        : {
            packetBytes: packet.length,
            version: packet.readUInt16LE(8),
            headerBytes: packet.readUInt16LE(10),
            status: packet.readUInt32LE(12),
            reason: packet.readUInt32LE(16),
            width: packet.readUInt32LE(20),
            height: packet.readUInt32LE(24),
            channels: packet.readUInt32LE(28),
            pixelBytes: packet.readUInt32LE(32),
            lastPresentQpc: packet.readBigInt64LE(60).toString(),
            qpcFrequency: packet.readBigInt64LE(68).toString(),
            accumulatedFrames: packet.readUInt32LE(100),
            deviceNameBytes: packet.readUInt32LE(104),
          }
      throw new Error(
        `${String(error)}; fields=${JSON.stringify(fields)}; ` +
          `headerHex=${prefix.toString('hex')}`,
      )
    }
  }
}

export function dxgiTimingReferenceHelperPath(
  mainDirectory = __dirname,
): string | null {
  const bundled = path.join(
    mainDirectory,
    '..',
    'scripts',
    'dxgi-timing-reference.exe',
  )
  const unpacked = bundled.replace(
    `${path.sep}app.asar${path.sep}`,
    `${path.sep}app.asar.unpacked${path.sep}`,
  )
  for (const candidate of [unpacked, bundled]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function dxgiTimingReferenceArguments(
  request: CaptureDxgiTimingReferenceRequest,
): string[] | null {
  const deviceName = request.deviceName?.trim()
  if (request.bounds !== undefined && !validBounds(request.bounds)) return null
  const bounds = validBounds(request.bounds) ? request.bounds : undefined
  if ((deviceName === undefined || deviceName === '') && bounds === undefined) {
    return null
  }
  const timeoutMs = Math.min(
    MAX_ACQUIRE_TIMEOUT_MS,
    Math.max(
      1,
      Math.round(
        Number.isFinite(request.timeoutMs)
          ? request.timeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS
          : DEFAULT_ACQUIRE_TIMEOUT_MS,
      ),
    ),
  )
  return [
    ...(deviceName === undefined || deviceName === ''
      ? []
      : ['--device', deviceName]),
    ...(bounds === undefined
      ? []
      : [
          '--left',
          String(bounds.x),
          '--top',
          String(bounds.y),
          '--native-width',
          String(bounds.width),
          '--native-height',
          String(bounds.height),
        ]),
    '--timeout-ms',
    String(timeoutMs),
    '--copy-timeout-ms',
    String(COPY_TIMEOUT_MS),
  ]
}

/**
 * Project any QPC sample onto the anchor's Unix nanosecond axis without a
 * floating-point round trip. This is a clock conversion, not a latency
 * estimate; the anchor span remains available to audit wall-clock uncertainty.
 */
export function dxgiQpcToUnixNs(
  reference: Pick<DxgiTimingMetadata, 'qpcFrequency' | 'anchor'>,
  qpc: bigint,
): bigint {
  if (reference.qpcFrequency <= 0n) {
    throw new Error('invalid QPC frequency')
  }
  return (
    reference.anchor.unixNs
    + ((qpc - reference.anchor.qpc) * 1_000_000_000n)
      / reference.qpcFrequency
  )
}

/**
 * One non-blocking calibration reference attempt.
 *
 * The helper has bounded AcquireNextFrame and GPU-copy waits. This parent
 * watchdog is independent and resolves unavailable even if a display driver
 * wedges outside those calls; capture never waits longer than one second.
 */
export async function captureDxgiTimingReference(
  request: CaptureDxgiTimingReferenceRequest,
): Promise<DxgiTimingReference> {
  if (process.platform !== 'win32') return unavailable('unsupported-platform')
  const args = dxgiTimingReferenceArguments(request)
  if (args === null) return unavailable('invalid-request')
  const helper = request.helperPath ?? dxgiTimingReferenceHelperPath()
  if (helper === null || !existsSync(helper)) return unavailable('helper-missing')
  const processTimeoutMs = Math.min(
    MAX_PROCESS_TIMEOUT_MS,
    Math.max(
      1,
      Math.round(
        Number.isFinite(request.processTimeoutMs)
          ? request.processTimeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS
          : DEFAULT_PROCESS_TIMEOUT_MS,
      ),
    ),
  )

  return await new Promise((resolve) => {
    const parser = new DxgiTimingReferenceParser()
    let stderr = ''
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const settle = (result: DxgiTimingReference): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(result)
    }
    let child
    try {
      child = spawn(helper, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      settle(unavailable('helper-failed', String(error)))
      return
    }
    timer = setTimeout(() => {
      child.kill()
      settle(
        unavailable(
          'helper-timeout',
          `DXGI timing helper exceeded ${String(processTimeoutMs)}ms`,
        ),
      )
    }, processTimeoutMs)
    timer.unref()
    child.once('error', (error) => {
      settle(unavailable('helper-failed', error.message))
    })
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return
      try {
        parser.push(chunk)
      } catch (error) {
        child.kill()
        settle(unavailable('malformed-output', String(error)))
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR_BYTES)
    })
    child.once('close', (code, signal) => {
      if (settled) return
      if (code !== 0) {
        settle(
          unavailable(
            'helper-failed',
            `DXGI timing helper exited ${String(code ?? signal ?? 'unknown')}` +
              (stderr.trim() === '' ? '' : `: ${stderr.trim()}`),
          ),
        )
        return
      }
      try {
        settle(parser.finish())
      } catch (error) {
        settle(unavailable('malformed-output', String(error)))
      }
    })
  })
}
