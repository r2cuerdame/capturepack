import {
  DXGI_REPLAY_PROBE_PACKET_BYTES,
  DxgiReplayCapabilityParser,
  dxgiReplayCapabilityArguments,
  parseDxgiReplayCapability,
  probeDxgiReplayCapability,
} from '../src/main/dxgiReplayRing'

let passed = 0
function check(name: string, condition: boolean): void {
  if (!condition) throw new Error(`FAIL: ${name}`)
  passed += 1
  console.log(`PASS: ${name}`)
}

function throws(action: () => unknown): boolean {
  try {
    action()
    return false
  } catch {
    return true
  }
}

function writeString(
  packet: Buffer,
  offset: number,
  lengthOffset: number,
  value: string,
): void {
  const bytes = Buffer.from(value, 'utf8')
  packet.writeUInt32LE(bytes.length, lengthOffset)
  bytes.copy(packet, offset)
}

function packet({
  status = 0,
  reason = 0,
  flags = 0x3ff,
}: {
  status?: number
  reason?: number
  flags?: number
} = {}): Buffer {
  const result = Buffer.alloc(DXGI_REPLAY_PROBE_PACKET_BYTES)
  result.write('CPNRCP01', 0, 'ascii')
  result.writeUInt16LE(1, 8)
  result.writeUInt16LE(DXGI_REPLAY_PROBE_PACKET_BYTES, 10)
  result.writeUInt32LE(status, 12)
  result.writeUInt32LE(reason, 16)
  result.writeUInt32LE(flags, 20)
  if ((flags & 1) !== 0) {
    result.writeUInt32LE(2, 24)
    result.writeUInt32LE(1, 28)
    result.writeInt32LE(-1920, 32)
    result.writeInt32LE(0, 36)
    result.writeInt32LE(0, 40)
    result.writeInt32LE(1080, 44)
    result.writeUInt32LE(0x10de, 48)
    result.writeUInt32LE(0x2684, 52)
    writeString(result, 64, 56, '\\\\.\\DISPLAY2')
  }
  if ((flags & (1 << 5)) !== 0) {
    writeString(result, 128, 60, 'Fixture Hardware H.264 Encoder')
  }
  return result
}

const availablePacket = packet()
const available = parseDxgiReplayCapability(availablePacket)
check(
  'available packet retains exact output and encoder identity',
  available.status === 'available'
    && available.deviceName === '\\\\.\\DISPLAY2'
    && available.encoderName === 'Fixture Hardware H.264 Encoder'
    && available.bounds.x === -1920
    && available.bounds.width === 1920
    && available.stages.length === 10,
)

for (let split = 1; split < availablePacket.length; split += 1) {
  const parser = new DxgiReplayCapabilityParser()
  parser.push(availablePacket.subarray(0, split))
  parser.push(availablePacket.subarray(split))
  const parsed = parser.finish()
  if (parsed.status !== 'available' || parsed.encoderName !== available.encoderName) {
    throw new Error(`FAIL: parser split ${split}`)
  }
}
passed += 1
console.log('PASS: every two-chunk split produces the same capability')

const byteParser = new DxgiReplayCapabilityParser()
for (const byte of availablePacket) byteParser.push(Buffer.from([byte]))
check('byte-at-a-time stream remains exact', byteParser.finish().status === 'available')

for (let reason = 1; reason <= 19; reason += 1) {
  const parsed = parseDxgiReplayCapability(
    packet({ status: 1, reason, flags: 0 }),
  )
  if (parsed.status !== 'unavailable') {
    throw new Error(`FAIL: unavailable reason ${reason}`)
  }
}
passed += 1
console.log('PASS: every native unavailable reason is recognized')

check(
  'truncated, oversized and concatenated packets are rejected',
  throws(() => parseDxgiReplayCapability(availablePacket.subarray(0, 255)))
    && throws(() => parseDxgiReplayCapability(Buffer.concat([availablePacket, Buffer.of(0)])))
    && throws(() => parseDxgiReplayCapability(Buffer.concat([availablePacket, availablePacket]))),
)
check(
  'magic, version, status and reason corruption are rejected',
  throws(() => {
    const value = Buffer.from(availablePacket)
    value[0] = 0
    parseDxgiReplayCapability(value)
  })
    && throws(() => {
      const value = Buffer.from(availablePacket)
      value.writeUInt16LE(2, 8)
      parseDxgiReplayCapability(value)
    })
    && throws(() => parseDxgiReplayCapability(packet({ status: 2 })))
    && throws(() => parseDxgiReplayCapability(packet({ status: 1, reason: 99, flags: 0 }))),
)
check(
  'unknown stages and missing available stages are rejected',
  throws(() => parseDxgiReplayCapability(packet({ flags: 0x400 })))
    && throws(() => parseDxgiReplayCapability(packet({ flags: 0x3fd }))),
)
check(
  'available and unavailable status/reason contradictions are rejected',
  throws(() => parseDxgiReplayCapability(packet({ reason: 2 })))
    && throws(() => parseDxgiReplayCapability(packet({ status: 1, reason: 0, flags: 0 }))),
)
check(
  'selected output requires positive bounds and a device name',
  throws(() => {
    const value = packet()
    value.writeInt32LE(-1920, 40)
    parseDxgiReplayCapability(value)
  })
    && throws(() => {
      const value = packet()
      value.fill(0, 64, 128)
      value.writeUInt32LE(0, 56)
      parseDxgiReplayCapability(value)
    }),
)
check(
  'unselected output cannot smuggle identity',
  throws(() => {
    const value = packet({ status: 1, reason: 2, flags: 0 })
    value.writeUInt32LE(7, 24)
    parseDxgiReplayCapability(value)
  }),
)
check(
  'string bounds, padding and UTF-8 are strict',
  throws(() => {
    const value = packet()
    value.writeUInt32LE(65, 56)
    parseDxgiReplayCapability(value)
  })
    && throws(() => {
      const value = packet()
      value[127] = 1
      parseDxgiReplayCapability(value)
    })
    && throws(() => {
      const value = packet()
      value.writeUInt32LE(1, 60)
      value[128] = 0xff
      value.fill(0, 129, 256)
      parseDxgiReplayCapability(value)
    }),
)

const overflowParser = new DxgiReplayCapabilityParser()
check(
  'stream parser refuses output beyond one fixed packet',
  throws(() => overflowParser.push(Buffer.alloc(DXGI_REPLAY_PROBE_PACKET_BYTES + 1))),
)

check(
  'arguments require one exact display identity and preserve negative origins',
  dxgiReplayCapabilityArguments({}) === null
    && dxgiReplayCapabilityArguments({ bounds: { x: 0, y: 0, width: 0, height: 1 } }) === null
    && dxgiReplayCapabilityArguments({
      bounds: { x: -2_147_483_648, y: 0, width: 4_294_967_295, height: 1 },
    }) === null
    && dxgiReplayCapabilityArguments({
      bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
    })?.join(' ') === '--left -1920 --top 0 --native-width 1920 --native-height 1080',
)

async function checkWrapperOutcomes(): Promise<void> {
  const unsupported = await probeDxgiReplayCapability({
    deviceName: '\\\\.\\DISPLAY1',
    platform: 'linux',
  })
  const invalid = await probeDxgiReplayCapability({ platform: 'win32' })
  const missing = await probeDxgiReplayCapability({
    deviceName: '\\\\.\\DISPLAY1',
    platform: 'win32',
    helperPath: 'Z:\\capturepack-missing\\dxgi-replay-ring.exe',
  })
  check(
    'wrapper names unsupported, invalid and missing-helper outcomes',
    unsupported.status === 'unavailable'
      && unsupported.reason === 'unsupported-platform'
      && invalid.status === 'unavailable'
      && invalid.reason === 'invalid-request'
      && missing.status === 'unavailable'
      && missing.reason === 'helper-missing',
  )
}

void checkWrapperOutcomes().then(
  () => console.log(`dxgi replay ring check: ${passed} passed`),
  (error: unknown) => {
    console.error(error)
    process.exitCode = 1
  },
)
