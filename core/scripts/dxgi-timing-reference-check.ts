import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  DXGI_TIMING_CHANNELS,
  DXGI_TIMING_HEADER_BYTES,
  DXGI_TIMING_HEIGHT,
  DXGI_TIMING_RGB_BYTES,
  DXGI_TIMING_WIDTH,
  DxgiTimingReferenceParser,
  dxgiQpcToUnixNs,
  dxgiTimingReferenceToIpc,
  dxgiTimingReferenceArguments,
  parseDxgiTimingReference,
} from '../src/main/dxgiTimingReference'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) passed += 1
  else failed += 1
  console.log(
    `  ${condition ? 'PASS' : 'FAIL'}  ${name}` +
      (detail === '' ? '' : ` — ${detail}`),
  )
}

function rejects(name: string, operation: () => unknown): void {
  let rejected = false
  try {
    operation()
  } catch {
    rejected = true
  }
  check(name, rejected)
}

function packetHeader(
  status: 0 | 1,
  reason: number,
  pixelBytes: number,
): Buffer {
  const header = Buffer.alloc(DXGI_TIMING_HEADER_BYTES)
  header.write('CPDXGI01', 0, 'ascii')
  header.writeUInt16LE(1, 8)
  header.writeUInt16LE(DXGI_TIMING_HEADER_BYTES, 10)
  header.writeUInt32LE(status, 12)
  header.writeUInt32LE(reason, 16)
  header.writeUInt32LE(status === 0 ? DXGI_TIMING_WIDTH : 0, 20)
  header.writeUInt32LE(status === 0 ? DXGI_TIMING_HEIGHT : 0, 24)
  header.writeUInt32LE(status === 0 ? DXGI_TIMING_CHANNELS : 0, 28)
  header.writeUInt32LE(pixelBytes, 32)
  header.writeUInt32LE(2, 36)
  header.writeUInt32LE(1, 40)
  header.writeInt32LE(-1920, 44)
  header.writeInt32LE(0, 48)
  header.writeInt32LE(0, 52)
  header.writeInt32LE(1080, 56)
  header.writeBigInt64LE(91_000_000n, 60)
  header.writeBigInt64LE(10_000_000n, 68)
  header.writeBigInt64LE(92_000_000n, 76)
  header.writeBigInt64LE(1_785_000_000_000_000_000n, 84)
  header.writeBigUInt64LE(20n, 92)
  header.writeUInt32LE(status === 0 ? 1 : 0, 100)
  const device = Buffer.from('\\\\.\\DISPLAY2', 'utf8')
  header.writeUInt32LE(device.length, 104)
  device.copy(header, 108)
  return header
}

console.log('\nSame-resource DXGI timing packet')
{
  const rgb = Buffer.alloc(DXGI_TIMING_RGB_BYTES)
  for (let index = 0; index < rgb.length; index += 1) {
    rgb[index] = index % 251
  }
  const packet = Buffer.concat([
    packetHeader(0, 0, rgb.length),
    rgb,
  ])
  const parser = new DxgiTimingReferenceParser()
  parser.push(packet.subarray(0, 11))
  parser.push(packet.subarray(11, 177))
  parser.push(packet.subarray(177))
  const result = parser.finish()
  check(
    'split stdout preserves the exact 128x72 row-major RGB payload',
    result.status === 'available'
      && result.width === 128
      && result.height === 72
      && result.channels === 3
      && result.rgb.equals(rgb),
  )
  check(
    'LastPresentTime and physical output identity survive the same packet',
    result.status === 'available'
      && result.lastPresentQpc === 91_000_000n
      && result.deviceName === '\\\\.\\DISPLAY2'
      && result.bounds.x === -1920
      && result.bounds.width === 1920
      && result.adapterIndex === 2
      && result.outputIndex === 1,
  )
  check(
    'QPC to Unix projection uses the contemporaneous anchor without float loss',
    result.status === 'available'
      && dxgiQpcToUnixNs(result, result.lastPresentQpc)
        === 1_784_999_999_900_000_000n
      && result.anchor.spanQpc === 20n,
  )
  const ipc = dxgiTimingReferenceToIpc(result)
  check(
    'IPC marks the reference as same-resource pixel exposure with a Windows QPC clock',
    ipc.status === 'available'
      && ipc.referenceTiming === 'pixel-exposure'
      && ipc.resourceProvenance === 'same-acquired-dxgi-resource'
      && ipc.clockProvenance === 'windows-qpc',
    JSON.stringify(ipc, (_key, value) =>
      value instanceof ArrayBuffer ? `[ArrayBuffer ${value.byteLength}]` : value,
    ),
  )
  check(
    'IPC carries every bigint as an exact decimal string and RGB as an exact ArrayBuffer',
    ipc.status === 'available'
      && ipc.lastPresentQpc === '91000000'
      && ipc.qpcFrequency === '10000000'
      && ipc.anchor.qpc === '92000000'
      && ipc.anchor.unixNs === '1785000000000000000'
      && ipc.anchor.spanQpc === '20'
      && ipc.rgb instanceof ArrayBuffer
      && Buffer.from(ipc.rgb).equals(rgb),
  )
}

console.log('\nHonest unavailable and parser bounds')
{
  const timeout = parseDxgiTimingReference(packetHeader(1, 5, 0))
  const accessLost = parseDxgiTimingReference(packetHeader(1, 7, 0))
  const noUpdate = parseDxgiTimingReference(packetHeader(1, 6, 0))
  check(
    'timeout is unavailable and carries no stale pixels',
    timeout.status === 'unavailable'
      && timeout.reason === 'timeout'
      && !('rgb' in timeout),
  )
  check(
    'access lost and pointer-only/no-update remain distinct unavailable results',
    accessLost.status === 'unavailable'
      && accessLost.reason === 'access-lost'
      && noUpdate.status === 'unavailable'
      && noUpdate.reason === 'no-desktop-update',
  )
  rejects(
    'an unavailable status cannot smuggle a previous RGB payload',
    () => parseDxgiTimingReference(
      Buffer.concat([packetHeader(1, 5, 1), Buffer.from([0])]),
    ),
  )
  rejects(
    'a truncated packet is rejected instead of partially decoded',
    () => parseDxgiTimingReference(Buffer.alloc(DXGI_TIMING_HEADER_BYTES - 1)),
  )
  const bounded = new DxgiTimingReferenceParser()
  rejects(
    'stream accumulation is capped at one fixed-size packet',
    () => bounded.push(Buffer.alloc(
      DXGI_TIMING_HEADER_BYTES + DXGI_TIMING_RGB_BYTES + 1,
    )),
  )
}

console.log('\nPhysical display request contract')
{
  const args = dxgiTimingReferenceArguments({
    deviceName: '\\\\.\\DISPLAY2',
    bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
    timeoutMs: 999_999,
  })
  check(
    'device and exact physical bounds are both enforced by the helper',
    args?.includes('\\\\.\\DISPLAY2') === true
      && args.includes('-1920')
      && args.includes('1080'),
    args?.join(' '),
  )
  check(
    'native AcquireNextFrame budget clamps to 250ms',
    args?.[args.indexOf('--timeout-ms') + 1] === '250',
  )
  check(
    'partial or invalid geometry never falls back to a different output',
    dxgiTimingReferenceArguments({
      deviceName: '\\\\.\\DISPLAY2',
      bounds: { x: 0, y: 0, width: 0, height: 1080 },
    }) === null
      && dxgiTimingReferenceArguments({}) === null,
  )
}

console.log('\nInspectable native invariant')
{
  const source = readFileSync(
    path.join(process.cwd(), 'scripts', 'dxgi-timing-reference.cpp'),
    'utf8',
  )
  const acquire = source.indexOf('duplication->AcquireNextFrame(')
  const timestamp = source.indexOf('frameInfo.LastPresentTime.QuadPart')
  const resource = source.indexOf('resource.As(&source)')
  const release = source.indexOf('duplication_->ReleaseFrame()')
  check(
    'one frame lease encloses LastPresentTime and its acquired resource',
    release >= 0
      && acquire >= 0
      && timestamp > acquire
      && resource > timestamp,
  )
  check(
    'the native wait budgets are fixed and no retry loop can hide no-update',
    source.includes('kMaximumAcquireTimeoutMs = 250')
      && source.includes('kMaximumCopyTimeoutMs = 250')
      && !source.includes('for (int attempt'),
  )
  check(
    'DXGI and Chromium fingerprints use the same destination-pixel-centre nearest sampling contract',
    source.includes(
      '(static_cast<std::uint64_t>(2 * y + 1) * orientedHeight)',
    )
      && source.includes('(2 * kOutputHeight)')
      && source.includes(
        '(static_cast<std::uint64_t>(2 * x + 1) * orientedWidth)',
      )
      && source.includes('(2 * kOutputWidth)'),
  )
}

console.log('\nBounded per-display IPC integration')
{
  const mainSource = readFileSync(
    path.join(process.cwd(), 'src', 'main', 'capture.ts'),
    'utf8',
  )
  const preloadSource = readFileSync(
    path.join(process.cwd(), 'src', 'preload', 'capture.ts'),
    'utf8',
  )
  const rendererSource = readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'capture', 'capture.ts'),
    'utf8',
  )
  const calibrationSource = rendererSource.slice(
    rendererSource.indexOf('async function measureChromiumSourceLatency('),
  )
  const dxgiAttempt = calibrationSource.indexOf(
    'startDxgiLatencyReference()',
  )
  const gdiFallback = calibrationSource.indexOf('startNativeLatencyReference()')
  check(
    'main routes one bounded DXGI invoke through the sender assigned display',
    mainSource.includes('IPC.captureDxgiTimingReference')
      && mainSource.includes('assignedDisplays.get(event.sender.id)')
      && mainSource.includes('screen.dipToScreenRect(null, display.bounds)')
      && mainSource.includes('timeoutMs: 250')
      && mainSource.includes('processTimeoutMs: 1_000'),
  )
  check(
    'preload exposes one explicit typed DXGI timing invoke',
    preloadSource.includes('captureDxgiTimingReference(): Promise<CaptureDxgiTimingReferencePayload>')
      && preloadSource.includes('ipcRenderer.invoke(IPC.captureDxgiTimingReference)'),
  )
  check(
    'calibration attempts DXGI before opening the GDI diagnostic fallback',
    dxgiAttempt >= 0
      && gdiFallback > dxgiAttempt
      && calibrationSource.includes(
        "referenceTiming = 'post-bitblt-completion'",
      ),
  )
  const fingerprintSource = rendererSource.slice(
    rendererSource.indexOf('function sourceLatencyFingerprintDrawable('),
    rendererSource.indexOf('interface PrimaryReadyResult'),
  )
  check(
    'Chromium calibration disables interpolation before matching the native nearest sample',
    fingerprintSource.indexOf('context.imageSmoothingEnabled = false')
      >= 0
      && fingerprintSource.indexOf('context.imageSmoothingEnabled = false')
        < fingerprintSource.indexOf('context.drawImage('),
  )
}

console.log(`\nresult: ${failed === 0 ? 'OK' : 'FAIL'} — ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
