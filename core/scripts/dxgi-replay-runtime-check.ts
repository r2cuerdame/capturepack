import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  DXGI_REPLAY_MAX_EXPORT_BYTES,
  DXGI_REPLAY_CURSOR_COMPOSITED_FLAG,
  DXGI_REPLAY_RUNTIME_SWITCH,
  DXGI_REPLAY_SERVICE_ALL_FLAGS,
  DXGI_REPLAY_SERVICE_PACKET_BYTES,
  DXGI_REPLAY_SERVICE_REQUIRED_HEALTH_FLAGS,
  DxgiReplayRuntime,
  DxgiReplayRuntimeManager,
  DxgiReplayServicePacketParser,
  dxgiReplayRuntimeOptedIn,
  parseDxgiReplayServicePacket,
  selectDxgiReplayRuntime,
  validateDxgiReplayMp4,
  type DxgiReplayRuntimeProcess,
} from '../src/main/dxgiReplayRuntime'
import type { DxgiReplayCapabilityAvailable } from '../src/main/dxgiReplayRing'

let passed = 0
function check(name: string, condition: boolean): void {
  if (!condition) throw new Error(`FAIL: ${name}`)
  passed += 1
  console.log(`PASS: ${name}`)
}
function throws(action: () => unknown): boolean {
  try { action(); return false } catch { return true }
}
function reasonOf(selection: ReturnType<typeof selectDxgiReplayRuntime>): string | undefined {
  return selection.backend === 'shipping' ? selection.reason : undefined
}

function u32(value: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b }
function u64(value: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64BE(value); return b }
function ascii(value: string): Buffer { return Buffer.from(value, 'ascii') }
function concat(...parts: readonly Buffer[]): Buffer { return Buffer.concat(parts) }
function box(type: string, ...parts: readonly Buffer[]): Buffer {
  const body = concat(...parts)
  return concat(u32(8 + body.length), ascii(type), body)
}
function fullBox(version = 0, flags = 0): Buffer {
  return Buffer.from([version, flags >>> 16 & 0xff, flags >>> 8 & 0xff, flags & 0xff])
}
function validMp4(sampleCount = 3, durationTicks = 40): Buffer {
  const avcC = box('avcC', Buffer.from([1, 100, 0, 31, 0xff, 0xe1, 0]))
  const avc1 = box('avc1', Buffer.alloc(78), avcC)
  const stsd = box('stsd', fullBox(), u32(1), avc1)
  const stbl = box('stbl', stsd)
  const minf = box('minf', stbl)
  const mdhd = box('mdhd', fullBox(), u32(0), u32(0), u32(1_000), u32(sampleCount * durationTicks))
  const hdlr = box('hdlr', fullBox(), u32(0), ascii('vide'))
  const tkhd = box('tkhd', fullBox(), u32(0), u32(0), u32(7), u32(0))
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, minf))
  const trex = box('trex', fullBox(), u32(7), u32(1), u32(durationTicks), u32(0), u32(0))
  const moov = box('moov', trak, box('mvex', trex))
  const tfhd = box('tfhd', fullBox(0, 0x000008), u32(7), u32(durationTicks))
  const tfdt = box('tfdt', fullBox(), u32(0))
  const trun = box('trun', fullBox(), u32(sampleCount))
  const moof = box('moof', box('traf', tfhd, tfdt, trun))
  return concat(
    box('ftyp', ascii('isom'), u32(0), ascii('isomiso6mp41')),
    moov,
    moof,
    box('mdat', Buffer.alloc(sampleCount * 4, 0x55)),
  )
}

function servicePacket(input: {
  kind?: number; status?: number; reason?: number; requestId?: bigint
  mp4Bytes?: bigint; ringBytes?: bigint; durationHns?: bigint; sampleCount?: bigint
} = {}): Buffer {
  const result = Buffer.alloc(DXGI_REPLAY_SERVICE_PACKET_BYTES)
  result.write('CPNSRV01', 0, 'ascii')
  result.writeUInt16LE(2, 8)
  result.writeUInt16LE(DXGI_REPLAY_SERVICE_PACKET_BYTES, 10)
  result.writeUInt32LE(input.kind ?? 1, 12)
  result.writeUInt32LE(input.status ?? 0, 16)
  result.writeUInt32LE(input.reason ?? 0, 20)
  result.writeBigUInt64LE(input.requestId ?? 0n, 24)
  result.writeUInt32LE(DXGI_REPLAY_SERVICE_REQUIRED_HEALTH_FLAGS, 32)
  result.writeUInt32LE(1920, 36)
  result.writeUInt32LE(1080, 40)
  result.writeUInt32LE(15, 44)
  result.writeBigInt64LE(10_000_000n, 48)
  result.writeBigInt64LE(9_000_000_000n, 56)
  const lastPtsHns = (input.durationHns ?? 1_200_000n)
    * ((input.sampleCount ?? 3n) - 1n) / (input.sampleCount ?? 3n)
  result.writeBigInt64LE(9_000_000_000n + lastPtsHns, 64)
  result.writeBigInt64LE(input.durationHns ?? 1_200_000n, 72)
  result.writeBigUInt64LE(input.sampleCount ?? 3n, 80)
  result.writeBigUInt64LE(1n, 88)
  result.writeBigUInt64LE(input.mp4Bytes ?? 1024n, 96)
  result.writeBigUInt64LE(input.sampleCount ?? 3n, 104)
  result.writeBigUInt64LE(input.ringBytes ?? 4096n, 112)
  result.writeUInt32LE(1, 120)
  result.writeInt32LE(0, 124)
  const name = Buffer.from('Fixture Hardware H.264 Encoder')
  result.writeUInt32LE(name.length, 128)
  name.copy(result, 132)
  // The last exposure is well before the clock measurement and export reply,
  // as with a static desktop tail or encoder backpressure.
  result.writeBigInt64LE(9_100_000_000n, 256)
  result.writeBigInt64LE(1_700_000_010_000_000_000n, 264)
  result.writeBigUInt64LE(100n, 272)
  result.writeBigInt64LE(lastPtsHns, 280)
  return result
}

const available: DxgiReplayCapabilityAvailable = {
  status: 'available', stages: [
    'output-selected', 'd3d11-device-created', 'desktop-duplication-created',
    'media-foundation-started', 'dxgi-device-manager-created',
    'hardware-encoder-enumerated', 'encoder-activated', 'encoder-d3d11-aware',
    'encoder-accepted-device-manager', 'gpu-bgra-to-nv12-supported',
  ],
  adapterIndex: 0, outputIndex: 0, bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  vendorId: 1, deviceId: 2, deviceName: '\\\\.\\DISPLAY1',
  encoderName: 'Fixture Hardware H.264 Encoder',
}

class FakeProcess extends EventEmitter implements DxgiReplayRuntimeProcess {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly stdin: { write: (data: string) => boolean; end: () => void }
  killed = false
  constructor(onWrite: (value: string, child: FakeProcess) => void = () => {}) {
    super()
    this.stdin = { write: (data) => { onWrite(data, this); return true }, end: () => {} }
  }
  kill(): boolean { this.killed = true; return true }
  output(packet: Buffer, split = 0): void {
    if (split > 0) {
      this.stdout.emit('data', packet.subarray(0, split))
      this.stdout.emit('data', packet.subarray(split))
    } else this.stdout.emit('data', packet)
  }
  close(code: number | null = 0): void { this.emit('close', code, null) }
}

async function main(): Promise<void> {
  check('DXGI runtime is off unless explicitly opted in',
    !dxgiReplayRuntimeOptedIn([])
      && dxgiReplayRuntimeOptedIn([DXGI_REPLAY_RUNTIME_SWITCH])
      && dxgiReplayRuntimeOptedIn([], true)
      && !dxgiReplayRuntimeOptedIn([DXGI_REPLAY_RUNTIME_SWITCH], false))

  const locked = { status: 'unavailable', reason: 'duplicate-access-denied', stages: [] } as const
  check('pure selector fails closed for platform, helper, locked session and missing health',
    reasonOf(selectDxgiReplayRuntime({ optedIn: false, platform: 'win32', helperExists: true })) === 'switch-disabled'
      && reasonOf(selectDxgiReplayRuntime({ optedIn: true, platform: 'linux', helperExists: true })) === 'unsupported-platform'
      && reasonOf(selectDxgiReplayRuntime({ optedIn: true, platform: 'win32', helperExists: false })) === 'helper-missing'
      && reasonOf(selectDxgiReplayRuntime({ optedIn: true, platform: 'win32', helperExists: true, capability: locked })) === 'capability-unavailable'
      && reasonOf(selectDxgiReplayRuntime({ optedIn: true, platform: 'win32', helperExists: true, capability: available })) === 'native-not-ready')

  const ready = parseDxgiReplayServicePacket(servicePacket())
  check('only complete READY health evidence selects native',
    selectDxgiReplayRuntime({ optedIn: true, platform: 'win32', helperExists: true, capability: available, ready }).backend === 'native-dxgi')

  const stream = new DxgiReplayServicePacketParser()
  check('fixed packet parser survives arbitrary chunking',
    stream.push(servicePacket().subarray(0, 99)).length === 0
      && stream.push(servicePacket().subarray(99)).length === 1)
  stream.finish()
  check('service v1 and missing, invalid, or imprecise clock anchors fail closed',
    [
      (value: Buffer) => value.writeUInt16LE(1, 8),
      (value: Buffer) => value.writeBigInt64LE(0n, 256),
      (value: Buffer) => value.writeBigInt64LE(-1n, 264),
      (value: Buffer) => value.writeBigUInt64LE(10_001n, 272),
      (value: Buffer) => value.writeBigInt64LE(1_000_000n, 280),
    ].every((corrupt) => {
      const value = servicePacket()
      corrupt(value)
      return throws(() => parseDxgiReplayServicePacket(value))
    }))
  check('service parser rejects truncation, oversized storage and success contradictions',
    throws(() => parseDxgiReplayServicePacket(servicePacket().subarray(0, 255)))
      && throws(() => parseDxgiReplayServicePacket(servicePacket().subarray(0, 256)))
      && throws(() => parseDxgiReplayServicePacket(servicePacket({ mp4Bytes: BigInt(DXGI_REPLAY_MAX_EXPORT_BYTES) + 1n })))
      && throws(() => parseDxgiReplayServicePacket(servicePacket({ reason: 27 }))))
  check('service parser accepts the retention-sized maximum ring evidence',
    parseDxgiReplayServicePacket(servicePacket({
      ringBytes: BigInt(DXGI_REPLAY_MAX_EXPORT_BYTES),
    })).ringBytes === BigInt(DXGI_REPLAY_MAX_EXPORT_BYTES))
  check('service parser requires exact health flags and request-id semantics',
    throws(() => {
      const value = servicePacket()
      value.writeUInt32LE(DXGI_REPLAY_SERVICE_REQUIRED_HEALTH_FLAGS & ~(1 << 16), 32)
      parseDxgiReplayServicePacket(value)
    })
      && throws(() => {
        const value = servicePacket()
        value.writeUInt32LE(DXGI_REPLAY_SERVICE_ALL_FLAGS + 1, 32)
        parseDxgiReplayServicePacket(value)
      })
      && throws(() => parseDxgiReplayServicePacket(servicePacket({ status: 1, reason: 6, requestId: 1n })))
      && throws(() => parseDxgiReplayServicePacket(servicePacket({ kind: 2, status: 1, reason: 32, requestId: 0n })))
      && throws(() => parseDxgiReplayServicePacket(servicePacket({ kind: 3, status: 1, reason: 27, requestId: 1n }))))
  check('native selection requires explicit GPU cursor-composition health',
    (DXGI_REPLAY_SERVICE_REQUIRED_HEALTH_FLAGS & DXGI_REPLAY_CURSOR_COMPOSITED_FLAG) !== 0
      && throws(() => {
        const value = servicePacket()
        value.writeUInt32LE(
          DXGI_REPLAY_SERVICE_REQUIRED_HEALTH_FLAGS & ~DXGI_REPLAY_CURSOR_COMPOSITED_FLAG,
          32,
        )
        parseDxgiReplayServicePacket(value)
      })
      && parseDxgiReplayServicePacket(servicePacket({
        kind: 3, status: 1, reason: 41,
      })).reason === 'cursor-composition-unavailable')
  const encoderFailure = parseDxgiReplayServicePacket(servicePacket({ kind: 1, status: 1, reason: 27 }))
  check('locked and encoder failures retain explicit fail-closed reasons',
    parseDxgiReplayServicePacket(servicePacket({ kind: 1, status: 1, reason: 6 })).reason === 'duplicate-access-denied'
      && encoderFailure.status === 'unavailable' && encoderFailure.reason === 'encoder-output-failed')

  const mp4 = validMp4()
  const mp4Check = validateDxgiReplayMp4(mp4, 120, mp4.length, 1_000)
  check('valid bounded fMP4 has exact monotone sample duration',
    mp4Check.status === 'valid' && mp4Check.sampleCount === 3 && mp4Check.durationMs === 120)
  const truncated = mp4.subarray(0, mp4.length - 1)
  const withoutConfig = Buffer.from(mp4)
  const avcCAt = withoutConfig.indexOf('avcC', 0, 'ascii')
  if (avcCAt >= 0) withoutConfig.write('junk', avcCAt, 'ascii')
  check('MP4 validation rejects truncation, missing codec config and insane duration',
    validateDxgiReplayMp4(truncated, 120).status === 'invalid'
      && validateDxgiReplayMp4(withoutConfig, 120).status === 'invalid'
      && validateDxgiReplayMp4(mp4, 5_000, mp4.length, 1_000).status === 'invalid')

  const work = path.resolve(process.argv[2] ?? '.')
  mkdirSync(work, { recursive: true })
  let spawned = 0
  const common = {
    enabled: true,
    platform: 'win32' as const,
    helperPath: 'fixture-helper.exe',
    outputDirectory: work,
    fileExists: () => true,
    probe: async () => available,
    startupTimeoutMs: 500,
    snapshotTimeoutMs: 500,
  }
  const missing = new DxgiReplayRuntimeManager({ ...common, fileExists: () => false, spawnProcess: () => { spawned++; return new FakeProcess() } })
  const missingSelection = await missing.start({ deviceName: '\\\\.\\DISPLAY1', retentionMs: 30_000 })
  check('missing helper returns shipping without probing/spawning',
    missingSelection.backend === 'shipping' && missingSelection.reason === 'helper-missing' && spawned === 0)

  const oversizedRetention = new DxgiReplayRuntimeManager({
    ...common,
    spawnProcess: () => { spawned++; return new FakeProcess() },
  })
  const oversizedSelection = await oversizedRetention.start({
    deviceName: '\\\\.\\DISPLAY1',
    retentionMs: 600_000,
  })
  check('retention above the native memory envelope stays on shipping',
    oversizedSelection.backend === 'shipping'
      && oversizedSelection.reason === 'native-not-ready'
      && oversizedSelection.detail === 'retention was outside service bounds'
      && spawned === 0)

  const lockedManager = new DxgiReplayRuntimeManager({ ...common, probe: async () => locked, spawnProcess: () => { spawned++; return new FakeProcess() } })
  check('locked-session capability failure retains shipping backend',
    (await lockedManager.start({ deviceName: '\\\\.\\DISPLAY1', retentionMs: 30_000 })).backend === 'shipping' && spawned === 0)

  const failedChild = new FakeProcess()
  const failedManager = new DxgiReplayRuntimeManager({ ...common, spawnProcess: () => { queueMicrotask(() => failedChild.output(servicePacket({ status: 1, reason: 27 }))); return failedChild } })
  const failedSelection = await failedManager.start({ deviceName: '\\\\.\\DISPLAY1', retentionMs: 30_000 })
  check('encoder failure before READY keeps shipping and stops candidate',
    failedSelection.backend === 'shipping' && failedSelection.detail === 'encoder-output-failed')

  let liveChild: FakeProcess
  liveChild = new FakeProcess((command, child) => {
    if (!command.startsWith('SNAPSHOT\t')) return
    const [, id, output] = command.trimEnd().split('\t')
    if (id === undefined || output === undefined) return
    writeFileSync(output, mp4)
    queueMicrotask(() => child.output(servicePacket({
      kind: 2, requestId: BigInt(id), mp4Bytes: BigInt(mp4.length),
    }), 71))
  })
  const liveManager = new DxgiReplayRuntimeManager({ ...common, spawnProcess: (_executable, args) => {
    check('manager launches exact persistent service arguments',
      args.includes('--serve') && args.includes('--retention-ms') && args.includes('30000'))
    queueMicrotask(() => liveChild.output(servicePacket(), 17))
    return liveChild
  } })
  check('complete capability plus READY promotes native',
    (await liveManager.start({ deviceName: '\\\\.\\DISPLAY1', retentionMs: 30_000 })).backend === 'native-dxgi')
  const snapshot = await liveManager.snapshot(1_000)
  check('snapshot reads and validates bounded MP4 then returns in-memory bytes',
    snapshot.status === 'ok' && snapshot.buffer.equals(mp4)
      && snapshot.sampleCount === 3 && snapshot.durationMs === 120)
  check('static-tail snapshot retains measured exposure origin despite delayed request/export',
    snapshot.status === 'ok' && snapshot.originMs === 1_700_000_000_000
      && snapshot.clockAnchors.length === 2
      && snapshot.clockAnchors[0]?.ptsMs === 0
      && snapshot.clockAnchors[0]?.wallMs === 1_700_000_000_000
      && snapshot.clockAnchors[1]?.ptsMs === 80
      && snapshot.clockAnchors[1]?.wallMs === 1_700_000_000_080)
  liveChild.close(7)
  const afterDeath = liveManager.currentSelection()
  check('runtime death immediately returns selection to shipping',
    afterDeath.backend === 'shipping' && afterDeath.reason === 'native-runtime-failed')

  async function clockSnapshotFixture(sampleCount: number, alter: (packet: Buffer) => void) {
    const bytes = validMp4(sampleCount)
    const child = new FakeProcess((command, process) => {
      if (!command.startsWith('SNAPSHOT\t')) return
      const [, id, output] = command.trimEnd().split('\t')
      if (id === undefined || output === undefined) return
      writeFileSync(output, bytes)
      const packet = servicePacket({
        kind: 2, requestId: BigInt(id), mp4Bytes: BigInt(bytes.length),
        sampleCount: BigInt(sampleCount), durationHns: BigInt(sampleCount * 400_000),
      })
      alter(packet)
      queueMicrotask(() => process.output(packet))
    })
    const manager = new DxgiReplayRuntimeManager({
      ...common, spawnProcess: () => {
        queueMicrotask(() => child.output(servicePacket()))
        return child
      },
    })
    await manager.start({ deviceName: '\\\\.\\DISPLAY1', retentionMs: 30_000 })
    const result = await manager.snapshot(1_000)
    manager.stop()
    child.close()
    return result
  }
  const mismapped = await clockSnapshotFixture(3, (packet) => {
    // Internally consistent QPC/PTS declarations must still agree with media.
    packet.writeBigInt64LE(packet.readBigInt64LE(64) + 100_000n, 64)
    packet.writeBigInt64LE(packet.readBigInt64LE(280) + 100_000n, 280)
  })
  check('native export rejects coherent clock metadata at the wrong actual media PTS',
    mismapped.status === 'fallback' && mismapped.reason === 'native-export-failed'
      && mismapped.detail?.includes('MP4 sample PTS disagreed') === true)
  const laterAnchor = await clockSnapshotFixture(3, (packet) => {
    packet.writeBigInt64LE(packet.readBigInt64LE(256) + 500_000_000n, 256)
    packet.writeBigInt64LE(packet.readBigInt64LE(264) + 50_000_000_000n, 264)
  })
  check('later clock measurement and export preserve the same earlier exposure origin',
    laterAnchor.status === 'ok' && laterAnchor.originMs === 1_700_000_000_000)
  const singleSample = await clockSnapshotFixture(1, () => {})
  check('one-sample native snapshot keeps its measured origin without inventing a second exposure',
    singleSample.status === 'ok' && singleSample.originMs === 1_700_000_000_000
      && singleSample.clockAnchors.length === 1
      && singleSample.clockAnchors[0]?.ptsMs === 0)

  const badChild = new FakeProcess((command, child) => {
    if (!command.startsWith('SNAPSHOT\t')) return
    const [, id, output] = command.trimEnd().split('\t')
    if (id === undefined || output === undefined) return
    writeFileSync(output, truncated)
    queueMicrotask(() => child.output(servicePacket({
      kind: 2, requestId: BigInt(id), mp4Bytes: BigInt(truncated.length),
    })))
  })
  const badFallbacks: string[] = []
  const badManager = new DxgiReplayRuntimeManager({
    ...common,
    onFallback: (selection) => badFallbacks.push(selection.reason),
    spawnProcess: () => {
      queueMicrotask(() => badChild.output(servicePacket()))
      return badChild
    },
  })
  await badManager.start({ deviceName: '\\\\.\\DISPLAY1', retentionMs: 30_000 })
  const badSnapshot = await badManager.snapshot(1_000)
  const afterBadExport = badManager.currentSelection()
  check('malformed export fails closed and demotes native runtime',
    badSnapshot.status === 'fallback' && afterBadExport.backend === 'shipping'
      && afterBadExport.reason === 'native-export-failed'
      && badFallbacks.includes('native-export-failed')
      && badChild.killed)

  let timeoutOutput = ''
  const timeoutCleanups: string[] = []
  const timeoutChild = new FakeProcess((command) => {
    if (!command.startsWith('SNAPSHOT\t')) return
    const output = command.trimEnd().split('\t')[2]
    if (output === undefined) return
    timeoutOutput = output
    writeFileSync(output, truncated)
  })
  const timeoutManager = new DxgiReplayRuntimeManager({
    ...common,
    cleanupOutputFile: async (outputPath) => {
      timeoutCleanups.push(outputPath)
      rmSync(outputPath, { force: true })
    },
    spawnProcess: () => {
      queueMicrotask(() => timeoutChild.output(servicePacket()))
      return timeoutChild
    },
  })
  await timeoutManager.start({ deviceName: '\\\\.\\DISPLAY1', retentionMs: 30_000 })
  // The production Electron process has other live handles; keep this isolated
  // Node fixture alive while exercising the deliberately-unref'ed deadline.
  const timeoutFixtureKeepAlive = setTimeout(() => {}, 1_000)
  const timedOutSnapshot = await timeoutManager.snapshot(10)
  clearTimeout(timeoutFixtureKeepAlive)
  check('snapshot timeout kills native but does not unlink its possibly-open export',
    timedOutSnapshot.status === 'fallback'
      && timedOutSnapshot.detail === 'snapshot timeout'
      && timeoutChild.killed
      && timeoutCleanups.length === 0
      && existsSync(timeoutOutput))
  timeoutChild.close(null)
  check('snapshot timeout removes its export only after process close',
    timeoutCleanups.length === 1
      && timeoutCleanups[0] === timeoutOutput
      && !existsSync(timeoutOutput))

  let stopOutput = ''
  const stopCleanups: string[] = []
  let announceStopSnapshot!: () => void
  const didStartStopSnapshot = new Promise<void>((resolve) => { announceStopSnapshot = resolve })
  const stopChild = new FakeProcess((command) => {
    if (!command.startsWith('SNAPSHOT\t')) return
    const output = command.trimEnd().split('\t')[2]
    if (output === undefined) return
    stopOutput = output
    writeFileSync(output, truncated)
    announceStopSnapshot()
  })
  const stopManager = new DxgiReplayRuntimeManager({
    ...common,
    cleanupOutputFile: async (outputPath) => {
      stopCleanups.push(outputPath)
      rmSync(outputPath, { force: true })
    },
    spawnProcess: () => {
      queueMicrotask(() => stopChild.output(servicePacket()))
      return stopChild
    },
  })
  await stopManager.start({ deviceName: '\\\\.\\DISPLAY1', retentionMs: 30_000 })
  const stoppedSnapshotPromise = stopManager.snapshot(1_000)
  await didStartStopSnapshot
  stopManager.stop()
  const stoppedSnapshot = await stoppedSnapshotPromise
  check('stop resolves export failure but retains its possibly-open temporary file',
    stoppedSnapshot.status === 'fallback'
      && stoppedSnapshot.detail === 'service stopped'
      && stopCleanups.length === 0
      && existsSync(stopOutput))
  stopChild.close(null)
  check('stop removes its temporary export only after process close',
    stopCleanups.length === 1
      && stopCleanups[0] === stopOutput
      && !existsSync(stopOutput))

  let cleanupFailureOutput = ''
  const cleanupFailures: string[] = []
  const cleanupFailureChild = new FakeProcess((command, child) => {
    if (!command.startsWith('SNAPSHOT\t')) return
    const [, id, output] = command.trimEnd().split('\t')
    if (id === undefined || output === undefined) return
    cleanupFailureOutput = output
    writeFileSync(output, mp4)
    queueMicrotask(() => child.output(servicePacket({
      kind: 2, requestId: BigInt(id), mp4Bytes: BigInt(mp4.length),
    })))
  })
  const cleanupFailureManager = new DxgiReplayRuntimeManager({
    ...common,
    cleanupOutputFile: async () => { throw new Error('fixture cleanup denied') },
    onCleanupError: (outputPath, error) => cleanupFailures.push(`${outputPath}:${String(error)}`),
    spawnProcess: () => {
      queueMicrotask(() => cleanupFailureChild.output(servicePacket()))
      return cleanupFailureChild
    },
  })
  await cleanupFailureManager.start({ deviceName: '\\\\.\\DISPLAY1', retentionMs: 30_000 })
  const cleanupFailureSnapshot = await cleanupFailureManager.snapshot(1_000)
  await new Promise<void>((resolve) => setImmediate(resolve))
  check('cleanup errors are reported without replacing a successful export result',
    cleanupFailureSnapshot.status === 'ok'
      && cleanupFailures.length === 1
      && cleanupFailures[0]?.includes('fixture cleanup denied') === true)
  rmSync(cleanupFailureOutput, { force: true })
  cleanupFailureManager.stop()

  let retentionClockMs = 0
  let shortChild: FakeProcess
  shortChild = new FakeProcess((command, child) => {
    if (!command.startsWith('SNAPSHOT\t')) return
    const [, id, output] = command.trimEnd().split('\t')
    if (id === undefined || output === undefined) return
    writeFileSync(output, mp4)
    queueMicrotask(() => child.output(servicePacket({
      kind: 2, requestId: BigInt(id), mp4Bytes: BigInt(mp4.length),
    })))
  })
  const shortManager = new DxgiReplayRuntimeManager({
    ...common,
    nowMs: () => retentionClockMs,
    spawnProcess: () => {
      queueMicrotask(() => shortChild.output(servicePacket()))
      return shortChild
    },
  })
  await shortManager.start({ deviceName: '\\\\.\\DISPLAY1', retentionMs: 30_000 })
  retentionClockMs = 30_000
  const shortSnapshot = await shortManager.snapshot(1_000)
  check('warmed runtime rejects a silently truncated retention window',
    shortSnapshot.status === 'fallback'
      && shortSnapshot.detail?.includes('required at least 28900 ms') === true
      && shortManager.currentSelection().backend === 'shipping')

  let pendingCommand: { id: bigint; output: string } | null = null
  let announceCommand!: () => void
  const didCommand = new Promise<void>((resolve) => { announceCommand = resolve })
  const serialChild = new FakeProcess((command) => {
    if (!command.startsWith('SNAPSHOT\t')) return
    const [, id, output] = command.trimEnd().split('\t')
    if (id !== undefined && output !== undefined) {
      pendingCommand = { id: BigInt(id), output }
      announceCommand()
    }
  })
  const serialManager = new DxgiReplayRuntimeManager({ ...common, spawnProcess: () => {
    queueMicrotask(() => serialChild.output(servicePacket()))
    return serialChild
  } })
  await serialManager.start({ deviceName: '\\\\.\\DISPLAY1', retentionMs: 30_000 })
  const firstSnapshot = serialManager.snapshot(1_000)
  const concurrentSnapshot = await serialManager.snapshot(1_000)
  await didCommand
  const command = pendingCommand as { id: bigint; output: string } | null
  if (command === null) throw new Error('FAIL: first serialized snapshot command missing')
  writeFileSync(command.output, mp4)
  serialChild.output(servicePacket({
    kind: 2, requestId: command.id, mp4Bytes: BigInt(mp4.length),
  }))
  check('one-service snapshot bound refuses concurrent stdin accumulation',
    concurrentSnapshot.status === 'fallback'
      && concurrentSnapshot.detail?.includes('already in flight') === true
      && (await firstSnapshot).status === 'ok')
  serialManager.stop()

  const waitingChild = new FakeProcess()
  let announceSpawn!: () => void
  const didSpawn = new Promise<void>((resolve) => { announceSpawn = resolve })
  const waitingManager = new DxgiReplayRuntimeManager({ ...common, startupTimeoutMs: 10_000, spawnProcess: () => {
    announceSpawn()
    return waitingChild
  } })
  const waitingStart = waitingManager.start({ deviceName: '\\\\.\\DISPLAY1', retentionMs: 30_000 })
  await didSpawn
  waitingManager.stop()
  const stoppedStart = await waitingStart
  check('stop resolves an outstanding READY wait without waiting for its deadline',
    stoppedStart.backend === 'shipping' && stoppedStart.reason === 'native-not-ready')

  const lateChild = new FakeProcess()
  const lateSelections: string[] = []
  const lateManager = new DxgiReplayRuntimeManager({
    ...common,
    startupTimeoutMs: 10,
    onReady: (selection) => lateSelections.push(selection.backend),
    spawnProcess: () => lateChild,
  })
  const lateFixtureKeepAlive = setTimeout(() => {}, 1_000)
  const lateInitial = await lateManager.start({ deviceName: '\\\\.\\DISPLAY1', retentionMs: 30_000 })
  clearTimeout(lateFixtureKeepAlive)
  check('static startup deadline keeps the native service warming behind shipping',
    lateInitial.backend === 'shipping'
      && lateInitial.reason === 'native-not-ready'
      && !lateChild.killed
      && lateManager.currentSelection().backend === 'shipping')
  lateChild.output(servicePacket())
  await new Promise<void>((resolve) => setImmediate(resolve))
  check('a late READY promotes the retained service without restarting it',
    lateManager.currentSelection().backend === 'native-dxgi'
      && lateSelections.length === 1
      && lateSelections[0] === 'native-dxgi'
      && !lateChild.killed)
  lateManager.stop()

  const fleetChild = new FakeProcess((command, child) => {
    if (!command.startsWith('SNAPSHOT\t')) return
    const [, id, output] = command.trimEnd().split('\t')
    if (id === undefined || output === undefined) return
    writeFileSync(output, mp4)
    queueMicrotask(() => child.output(servicePacket({
      kind: 2, requestId: BigInt(id), mp4Bytes: BigInt(mp4.length),
    })))
  })
  const statuses: string[] = []
  const runtime = new DxgiReplayRuntime({
    ...common,
    spawnProcess: () => {
      queueMicrotask(() => fleetChild.output(servicePacket()))
      return fleetChild
    },
    onStatus: (displayId, selection) => statuses.push(`${displayId}:${selection.backend}`),
  })
  const synced = await runtime.sync([{
    id: 7,
    deviceName: '\\\\.\\DISPLAY1',
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  }], { enabled: true, retentionMs: 30_000, fps: 15 })
  const appReplay = await runtime.snapshot(7, 1_000)
  check('app-facing sync/snapshot API returns only a validated MP4 replay',
    synced.get(7)?.backend === 'native-dxgi'
      && appReplay?.mimeType === 'video/mp4'
      && appReplay.replayFile === 'replay.mp4'
      && appReplay.buffer.equals(mp4)
      && appReplay.originMs === 1_700_000_000_000
      && appReplay.clockAnchors[1]?.wallMs === 1_700_000_000_080
      && statuses.includes('7:native-dxgi'))
  runtime.retain(new Set())
  check('app-facing retain stops displays removed by topology',
    runtime.currentSelection(7) === null)

  console.log(`dxgi replay runtime check: ${passed} passed`)
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
