import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const MAGIC = Buffer.from('CPNRCP01', 'ascii')
export const DXGI_REPLAY_PROBE_PACKET_BYTES = 256
const PROTOCOL_VERSION = 1
const DEFAULT_PROCESS_TIMEOUT_MS = 2_000
const MAX_PROCESS_TIMEOUT_MS = 5_000
const MAX_STDERR_BYTES = 8_192

const nativeReasons = [
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
] as const

const stageBits = [
  ['output-selected', 1 << 0],
  ['d3d11-device-created', 1 << 1],
  ['desktop-duplication-created', 1 << 2],
  ['media-foundation-started', 1 << 3],
  ['dxgi-device-manager-created', 1 << 4],
  ['hardware-encoder-enumerated', 1 << 5],
  ['encoder-activated', 1 << 6],
  ['encoder-d3d11-aware', 1 << 7],
  ['encoder-accepted-device-manager', 1 << 8],
  ['gpu-bgra-to-nv12-supported', 1 << 9],
] as const

const ALL_STAGE_BITS = stageBits.reduce((bits, [, bit]) => bits | bit, 0)
const REQUIRED_AVAILABLE_BITS = ALL_STAGE_BITS

export type DxgiReplayNativeUnavailableReason =
  (typeof nativeReasons)[number]
export type DxgiReplayUnavailableReason =
  | Exclude<DxgiReplayNativeUnavailableReason, 'none'>
  | 'unsupported-platform'
  | 'helper-missing'
  | 'invalid-request'
  | 'helper-timeout'
  | 'helper-failed'
  | 'malformed-output'
export type DxgiReplayProbeStage = (typeof stageBits)[number][0]

export interface DxgiReplayBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

interface DxgiReplayProbeEvidence {
  readonly stages: readonly DxgiReplayProbeStage[]
  readonly adapterIndex?: number
  readonly outputIndex?: number
  readonly bounds?: DxgiReplayBounds
  readonly vendorId?: number
  readonly deviceId?: number
  readonly deviceName?: string
  readonly encoderName?: string
}

export interface DxgiReplayCapabilityAvailable
  extends DxgiReplayProbeEvidence {
  readonly status: 'available'
  readonly adapterIndex: number
  readonly outputIndex: number
  readonly bounds: DxgiReplayBounds
  readonly vendorId: number
  readonly deviceId: number
  readonly deviceName: string
  readonly encoderName: string
}

export interface DxgiReplayCapabilityUnavailable
  extends DxgiReplayProbeEvidence {
  readonly status: 'unavailable'
  readonly reason: DxgiReplayUnavailableReason
  readonly detail?: string
}

export type DxgiReplayCapability =
  | DxgiReplayCapabilityAvailable
  | DxgiReplayCapabilityUnavailable

export interface ProbeDxgiReplayCapabilityRequest {
  readonly deviceName?: string
  readonly bounds?: DxgiReplayBounds
  readonly processTimeoutMs?: number
  readonly helperPath?: string
  /** Test-only platform override; normal callers leave this absent. */
  readonly platform?: NodeJS.Platform
}

function decodeBoundedUtf8(
  packet: Buffer,
  offset: number,
  capacity: number,
  length: number,
): string {
  if (length > capacity) throw new Error('probe string exceeded its fixed field')
  const field = packet.subarray(offset, offset + capacity)
  if (field.subarray(length).some((byte) => byte !== 0)) {
    throw new Error('probe string padding was not zero')
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(
    field.subarray(0, length),
  )
}

function stagesFromFlags(flags: number): readonly DxgiReplayProbeStage[] {
  if ((flags & ~ALL_STAGE_BITS) !== 0) {
    throw new Error('probe packet carried unknown stage flags')
  }
  return stageBits
    .filter(([, bit]) => (flags & bit) !== 0)
    .map(([name]) => name)
}

function validBounds(bounds: DxgiReplayBounds | undefined): bounds is DxgiReplayBounds {
  if (bounds === undefined) return false
  return (
    Number.isSafeInteger(bounds.x)
    && Number.isSafeInteger(bounds.y)
    && Number.isSafeInteger(bounds.width)
    && Number.isSafeInteger(bounds.height)
    && bounds.width > 0
    && bounds.height > 0
    && bounds.width <= 2_147_483_647
    && bounds.height <= 2_147_483_647
    && bounds.x >= -2_147_483_648
    && bounds.y >= -2_147_483_648
    && bounds.x + bounds.width <= 2_147_483_647
    && bounds.y + bounds.height <= 2_147_483_647
  )
}

export function parseDxgiReplayCapability(
  packet: Buffer,
): DxgiReplayCapability {
  if (packet.length !== DXGI_REPLAY_PROBE_PACKET_BYTES) {
    throw new Error('DXGI replay probe packet size was not exact')
  }
  if (!packet.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('invalid DXGI replay probe magic')
  }
  if (
    packet.readUInt16LE(8) !== PROTOCOL_VERSION
    || packet.readUInt16LE(10) !== DXGI_REPLAY_PROBE_PACKET_BYTES
  ) {
    throw new Error('unsupported DXGI replay probe protocol')
  }
  const status = packet.readUInt32LE(12)
  const reason = nativeReasons[packet.readUInt32LE(16)]
  if (reason === undefined) throw new Error('unknown DXGI replay probe reason')
  const flags = packet.readUInt32LE(20)
  const stages = stagesFromFlags(flags)
  const adapterIndex = packet.readUInt32LE(24)
  const outputIndex = packet.readUInt32LE(28)
  const left = packet.readInt32LE(32)
  const top = packet.readInt32LE(36)
  const right = packet.readInt32LE(40)
  const bottom = packet.readInt32LE(44)
  const vendorId = packet.readUInt32LE(48)
  const deviceId = packet.readUInt32LE(52)
  const deviceName = decodeBoundedUtf8(
    packet, 64, 64, packet.readUInt32LE(56),
  )
  const encoderName = decodeBoundedUtf8(
    packet, 128, 128, packet.readUInt32LE(60),
  )
  const outputSelected = (flags & stageBits[0][1]) !== 0
  const bounds = outputSelected
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : undefined
  if (outputSelected && (!validBounds(bounds) || deviceName === '')) {
    throw new Error('selected DXGI replay output lacked valid identity')
  }
  if (
    !outputSelected
    && (
      adapterIndex !== 0 || outputIndex !== 0 || left !== 0 || top !== 0
      || right !== 0 || bottom !== 0 || vendorId !== 0 || deviceId !== 0
      || deviceName !== '' || encoderName !== ''
    )
  ) {
    throw new Error('unselected DXGI replay output carried identity')
  }
  const evidence: DxgiReplayProbeEvidence = {
    stages,
    ...(outputSelected
      ? {
          adapterIndex,
          outputIndex,
          bounds,
          vendorId,
          deviceId,
          deviceName,
        }
      : {}),
    ...(encoderName === '' ? {} : { encoderName }),
  }
  if (status === 0) {
    if (
      reason !== 'none'
      || flags !== REQUIRED_AVAILABLE_BITS
      || bounds === undefined
      || encoderName === ''
    ) {
      throw new Error('available DXGI replay probe lacked required evidence')
    }
    return {
      status: 'available',
      stages,
      adapterIndex,
      outputIndex,
      bounds,
      vendorId,
      deviceId,
      deviceName,
      encoderName,
    }
  }
  if (status !== 1 || reason === 'none') {
    throw new Error('invalid DXGI replay probe status')
  }
  return { status: 'unavailable', reason, ...evidence }
}

export class DxgiReplayCapabilityParser {
  private chunks: Buffer[] = []
  private bytes = 0

  push(chunk: Buffer): void {
    if (chunk.length === 0) return
    if (this.bytes + chunk.length > DXGI_REPLAY_PROBE_PACKET_BYTES) {
      this.chunks = []
      this.bytes = 0
      throw new Error('DXGI replay probe stdout exceeded its fixed bound')
    }
    this.chunks.push(Buffer.from(chunk))
    this.bytes += chunk.length
  }

  finish(): DxgiReplayCapability {
    const packet = Buffer.concat(this.chunks, this.bytes)
    this.chunks = []
    this.bytes = 0
    return parseDxgiReplayCapability(packet)
  }
}

export function dxgiReplayRingHelperPath(
  mainDirectory = __dirname,
): string | null {
  const bundled = path.join(mainDirectory, '..', 'scripts', 'dxgi-replay-ring.exe')
  const unpacked = bundled.replace(
    `${path.sep}app.asar${path.sep}`,
    `${path.sep}app.asar.unpacked${path.sep}`,
  )
  return [unpacked, bundled].find((candidate) => existsSync(candidate)) ?? null
}

export function dxgiReplayCapabilityArguments(
  request: ProbeDxgiReplayCapabilityRequest,
): string[] | null {
  const deviceName = request.deviceName?.trim()
  if (request.bounds !== undefined && !validBounds(request.bounds)) return null
  const bounds = validBounds(request.bounds) ? request.bounds : undefined
  if ((deviceName === undefined || deviceName === '') && bounds === undefined) {
    return null
  }
  return [
    ...(deviceName === undefined || deviceName === ''
      ? []
      : ['--device', deviceName]),
    ...(bounds === undefined
      ? []
      : [
          '--left', String(bounds.x),
          '--top', String(bounds.y),
          '--native-width', String(bounds.width),
          '--native-height', String(bounds.height),
        ]),
  ]
}

function unavailable(
  reason: DxgiReplayUnavailableReason,
  detail?: string,
): DxgiReplayCapabilityUnavailable {
  return {
    status: 'unavailable',
    reason,
    ...(detail === undefined || detail === '' ? {} : { detail }),
    stages: [],
  }
}

/**
 * One bounded capability handshake. It proves allocation/interop support, not
 * successful frame encoding; runtime promotion remains gated on field evidence.
 */
export async function probeDxgiReplayCapability(
  request: ProbeDxgiReplayCapabilityRequest,
): Promise<DxgiReplayCapability> {
  if ((request.platform ?? process.platform) !== 'win32') {
    return unavailable('unsupported-platform')
  }
  const args = dxgiReplayCapabilityArguments(request)
  if (args === null) return unavailable('invalid-request')
  const helper = request.helperPath ?? dxgiReplayRingHelperPath()
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
    const parser = new DxgiReplayCapabilityParser()
    let stderr = ''
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const settle = (result: DxgiReplayCapability): void => {
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
          `DXGI replay probe exceeded ${String(processTimeoutMs)}ms`,
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
            `DXGI replay probe exited ${String(code ?? signal ?? 'unknown')}`
              + (stderr.trim() === '' ? '' : `: ${stderr.trim()}`),
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
