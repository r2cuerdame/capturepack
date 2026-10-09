/**
 * Chromium's AVC encoder can stream Matroska without its MP4 muxer's uint32
 * lifetime output-position tracker. This owner consumes that internal stream
 * and emits legal fMP4: unchanged AVC samples, one init segment, keyframe-led
 * fragments, local moof offsets and 64-bit media timestamps.
 *
 * Neither input chunks nor lifetime output are retained. Segment/Cluster
 * envelopes stream incrementally; only a bounded incomplete element and GOP
 * survive a push. Recorder replacement is never used to bound output position.
 */
export interface AvcRemuxChunk {
  bytes: Uint8Array<ArrayBuffer>
  endAtMs: number
}
interface Header {
  id: number
  bytes: number
  size: number | null
}
interface Sample {
  timestamp: bigint
  duration: number
  key: boolean
  bytes: Uint8Array<ArrayBuffer>
}
const SCALE = 1_000_000
const SEGMENT = 0x18538067
const CLUSTER = 0x1f43b675
const INFO = 0x1549a966
const TRACKS = 0x1654ae6b
const MAX_METADATA_BYTES = 64 * 1024
const MAX_SAMPLES = 512
const textDecoder = new TextDecoder()

function concat(parts: readonly Uint8Array<ArrayBufferLike>[]): Uint8Array<ArrayBuffer> {
  const size = parts.reduce((n, p) => n + p.byteLength, 0)
  if (!Number.isSafeInteger(size) || size > 0x7fffffff) throw new Error('AVC local box exceeds addressable size')
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength }
  return bytes
}
function uint(value: number, bytes = 4): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** (bytes * 8)) {
    throw new Error('AVC box integer outside its field')
  }
  const result = new Uint8Array(bytes)
  for (let i = bytes - 1; i >= 0; i--) { result[i] = value % 256; value = Math.floor(value / 256) }
  return result
}
function wide(value: bigint): Uint8Array<ArrayBuffer> {
  if (value < 0n || value > 0xffffffffffffffffn) throw new Error('AVC media time exceeds uint64')
  const result = new Uint8Array(8)
  new DataView(result.buffer).setBigUint64(0, value)
  return result
}
function box(type: string, ...parts: Uint8Array<ArrayBufferLike>[]): Uint8Array<ArrayBuffer> {
  const payload = concat(parts)
  return concat([uint(payload.byteLength + 8), new TextEncoder().encode(type), payload])
}
function full(type: string, flags: number, ...parts: Uint8Array<ArrayBufferLike>[]): Uint8Array<ArrayBuffer> {
  return box(type, uint(flags), ...parts)
}
const zero = (n: number): Uint8Array<ArrayBuffer> => new Uint8Array(n)
const matrix = (): Uint8Array<ArrayBuffer> =>
  concat([uint(0x10000), uint(0), uint(0), uint(0), uint(0x10000), uint(0), uint(0), uint(0), uint(0x40000000)])

function initialization(width: number, height: number, avcC: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const mvhd = full('mvhd', 0, zero(8), uint(SCALE), uint(0), uint(0x10000),
    uint(0x100, 2), zero(10), matrix(), zero(24), uint(2))
  const tkhd = full('tkhd', 7, zero(8), uint(1), zero(8), zero(8),
    zero(8), matrix(), uint(width * 65536), uint(height * 65536))
  const mdhd = full('mdhd', 0, zero(8), uint(SCALE), uint(0), uint(0x55c4, 2), zero(2))
  const hdlr = full('hdlr', 0, zero(4), new TextEncoder().encode('vide'), zero(12),
    new TextEncoder().encode('VideoHandler\0'))
  const avc1 = box('avc1', zero(6), uint(1, 2), zero(16), uint(width, 2), uint(height, 2),
    uint(72 * 65536), uint(72 * 65536), zero(4), uint(1, 2), zero(32),
    uint(24, 2), uint(0xffff, 2), box('avcC', avcC))
  const stbl = box('stbl', full('stsd', 0, uint(1), avc1), full('stts', 0, uint(0)),
    full('stsc', 0, uint(0)), full('stsz', 0, uint(0), uint(0)), full('stco', 0, uint(0)))
  const dinf = box('dinf', full('dref', 0, uint(1), full('url ', 1)))
  const minf = box('minf', full('vmhd', 1, zero(8)), dinf, stbl)
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, minf))
  const mvex = box('mvex', full('trex', 0, uint(1), uint(1), uint(0), uint(0), uint(0x01010000)))
  return concat([box('ftyp', new TextEncoder().encode('iso6'), uint(1),
    new TextEncoder().encode('iso6mp41avc1')), box('moov', mvhd, trak, mvex)])
}
function fragment(samples: readonly Sample[], sequence: number): Uint8Array<ArrayBuffer> {
  const entries = samples.flatMap(s => [uint(s.duration), uint(s.bytes.byteLength),
    uint(s.key ? 0x02000000 : 0x01010000)])
  const make = (offset: number): Uint8Array<ArrayBuffer> => box('moof',
    full('mfhd', 0, uint(sequence)),
    box('traf', full('tfhd', 0x020000, uint(1)),
      full('tfdt', 0x01000000, wide(samples[0]!.timestamp)),
      full('trun', 0x000701, uint(samples.length), uint(offset), ...entries)))
  const header = make(0)
  return concat([make(header.byteLength + 8), box('mdat', ...samples.map(s => s.bytes))])
}
function vint(bytes: Uint8Array<ArrayBufferLike>, offset: number, id: boolean):
  { value: bigint; bytes: number; unknown: boolean } | null {
  if (offset >= bytes.byteLength) return null
  const first = bytes[offset]!
  if (first === 0) throw new Error('invalid EBML variable integer')
  let length = 1, marker = 0x80
  while ((first & marker) === 0) { marker >>= 1; length++ }
  if (length > (id ? 4 : 8)) throw new Error('EBML integer exceeds allowed width')
  if (offset + length > bytes.byteLength) return null
  let value = BigInt(id ? first : first & (marker - 1))
  for (let i = 1; i < length; i++) value = (value << 8n) | BigInt(bytes[offset + i]!)
  return { value, bytes: length, unknown: !id && value === (1n << BigInt(7 * length)) - 1n }
}
function header(bytes: Uint8Array<ArrayBufferLike>, offset: number): Header | null {
  const identifier = vint(bytes, offset, true)
  if (identifier === null) return null
  const size = vint(bytes, offset + identifier.bytes, false)
  if (size === null) return null
  if (!size.unknown && size.value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('unaddressable EBML element')
  return { id: Number(identifier.value), bytes: identifier.bytes + size.bytes,
    size: size.unknown ? null : Number(size.value) }
}
function integer(bytes: Uint8Array<ArrayBufferLike>): bigint {
  if (bytes.byteLength === 0 || bytes.byteLength > 8) throw new Error('invalid Matroska integer')
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  return value
}
function elements(bytes: Uint8Array<ArrayBufferLike>): Array<{ id: number; data: Uint8Array<ArrayBufferLike> }> {
  const result: Array<{ id: number; data: Uint8Array<ArrayBufferLike> }> = []
  let offset = 0
  while (offset < bytes.byteLength) {
    const h = header(bytes, offset)
    if (h === null || h.size === null || offset + h.bytes + h.size > bytes.byteLength) {
      throw new Error('truncated Matroska metadata')
    }
    result.push({ id: h.id, data: bytes.subarray(offset + h.bytes, offset + h.bytes + h.size) })
    offset += h.bytes + h.size
  }
  return result
}
function scalar(items: ReturnType<typeof elements>, id: number, fallback?: bigint): bigint {
  const found = items.filter(x => x.id === id)
  if (found.length === 0 && fallback !== undefined) return fallback
  if (found.length !== 1) throw new Error('missing or duplicate Matroska field ' + id.toString(16))
  return integer(found[0]!.data)
}


function annexBNals(bytes: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike>[] {
  const starts: Array<{ offset: number; payload: number }> = []
  for (let i = 0; i + 3 <= bytes.byteLength; i++) {
    if (bytes[i] !== 0 || bytes[i + 1] !== 0) continue
    const width = bytes[i + 2] === 1 ? 3 :
      i + 4 <= bytes.byteLength && bytes[i + 2] === 0 && bytes[i + 3] === 1 ? 4 : 0
    if (width === 0) continue
    starts.push({ offset: i, payload: i + width })
    i += width - 1
  }
  if (starts.length === 0 || bytes.subarray(0, starts[0]!.offset).some(x => x !== 0)) {
    throw new Error('AVC sample is not Annex B')
  }
  return starts.map((start, i) => {
    const end = starts[i + 1]?.offset ?? bytes.byteLength
    if (end <= start.payload) throw new Error('empty Annex B NAL')
    // Preserve terminal CABAC/zero bytes; never trim them as a prefix guess.
    return bytes.subarray(start.payload, end)
  })
}
function avcConfiguration(sps: Uint8Array<ArrayBufferLike>, pps: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
  if (sps.byteLength < 4 || sps.byteLength > 0xffff || pps.byteLength === 0 || pps.byteLength > 0xffff) {
    throw new Error('invalid AVC parameter sets')
  }
  return concat([new Uint8Array([1, sps[1]!, sps[2]!, sps[3]!, 0xff, 0xe1]),
    uint(sps.byteLength, 2), sps, uint(1, 1), uint(pps.byteLength, 2), pps])
}

export class AvcMatroskaRemuxer {
  private pending: Uint8Array<ArrayBuffer> = new Uint8Array(0)
  private samples: Sample[] = []
  private sampleBytes = 0
  private position = 0n
  private segmentEnd: bigint | null = null
  private clusterEnd: bigint | null = null
  private inSegment = false
  private inCluster = false
  private clusterTimestamp: bigint | null = null
  private timecodeScale = 1_000_000n
  private track: bigint | null = null
  private avcC: Uint8Array<ArrayBuffer> | null = null
  private annexB = false
  private sps: Uint8Array<ArrayBuffer> | null = null
  private pps: Uint8Array<ArrayBuffer> | null = null
  private width = 0
  private height = 0
  private nominalDuration: number
  private lastDuration: number
  private sequence = 0
  private latestTimestamp: bigint | null = null
  private emittedSamples = 0n
  private outputBytes = 0n
  private finished = false

  constructor(private readonly budgetBytes: number, fps = 15) {
    if (!Number.isSafeInteger(budgetBytes) || budgetBytes < MAX_METADATA_BYTES) throw new Error('invalid AVC remux budget')
    this.nominalDuration = Math.round(SCALE / fps)
    if (!Number.isSafeInteger(this.nominalDuration) || this.nominalDuration <= 0) throw new Error('invalid AVC frame rate')
    this.lastDuration = this.nominalDuration
  }

  pushBytes(data: Uint8Array<ArrayBufferLike>, endAtMs: number): AvcRemuxChunk[] {
    if (this.finished) throw new Error('AVC stream already finished')
    if (!Number.isFinite(endAtMs)) throw new Error('invalid AVC delivery clock')
    const output: Array<{ bytes: Uint8Array<ArrayBuffer>; end: bigint | null }> = []
    // The ingest queue already owns the bounded delivery ArrayBuffer. Borrow
    // small views instead of copying a complete, possibly delayed stop batch
    // into this owner's pending buffer. Anchor once after the whole delivery.
    for (let offset = 0; offset < data.byteLength; offset += MAX_METADATA_BYTES) {
      this.consume(data.subarray(offset, offset + MAX_METADATA_BYTES), output)
    }
    return this.anchor(output, endAtMs)
  }

  private consume(data: Uint8Array<ArrayBufferLike>,
    output: Array<{ bytes: Uint8Array<ArrayBuffer>; end: bigint | null }>): void {
    if (data.byteLength + this.pending.byteLength + this.sampleBytes > this.budgetBytes) {
      throw new Error('AVC remux byte budget exceeded')
    }
    this.pending = concat([this.pending, data])
    let consumed = 0
    while (consumed < this.pending.byteLength) {
      const h = header(this.pending, consumed)
      if (h === null) break
      const absolute = this.position + BigInt(consumed)
      if (this.clusterEnd !== null && absolute === this.clusterEnd) {
        this.inCluster = false; this.clusterEnd = null; this.clusterTimestamp = null
      }
      if (this.clusterEnd !== null && absolute > this.clusterEnd) throw new Error('Matroska Cluster overrun')
      if (h.id === SEGMENT) {
        if (this.inSegment) throw new Error('multiple Matroska Segments in one recorder')
        this.inSegment = true
        this.segmentEnd = h.size === null ? null : absolute + BigInt(h.bytes + h.size)
        consumed += h.bytes
        continue
      }
      if (h.id === CLUSTER) {
        if (!this.inSegment || (this.inCluster && this.clusterEnd !== null)) throw new Error('invalid Matroska Cluster boundary')
        this.inCluster = true
        this.clusterTimestamp = null
        this.clusterEnd = h.size === null ? null : absolute + BigInt(h.bytes + h.size)
        consumed += h.bytes
        continue
      }
      if (h.size === null) throw new Error('unexpected unknown-sized Matroska element')
      if (h.size > this.budgetBytes) throw new Error('Matroska element exceeds remux byte budget')
      const next = consumed + h.bytes + h.size
      const end = absolute + BigInt(h.bytes + h.size)
      if (this.segmentEnd !== null && end > this.segmentEnd) throw new Error('Matroska Segment overrun')
      if (this.inCluster && this.clusterEnd !== null && end > this.clusterEnd) throw new Error('Matroska child exceeds Cluster')
      if (next > this.pending.byteLength) break
      const payload = this.pending.subarray(consumed + h.bytes, next)
      if (h.id === INFO) {
        if (this.inCluster || h.size > MAX_METADATA_BYTES) throw new Error('invalid Matroska Info')
        this.timecodeScale = scalar(elements(payload), 0x2ad7b1, 1_000_000n)
        if (this.timecodeScale <= 0n || this.timecodeScale > 1_000_000_000n) throw new Error('invalid Matroska TimestampScale')
      } else if (h.id === TRACKS) {
        if (this.track !== null || this.inCluster || h.size > MAX_METADATA_BYTES) throw new Error('invalid Matroska Tracks')
        this.readTracks(payload)
        if (this.avcC !== null) {
          const init = initialization(this.width, this.height, this.avcC)
          this.outputBytes += BigInt(init.byteLength)
          output.push({ bytes: init, end: null })
        }
      } else if (h.id === 0xe7) {
        if (!this.inCluster || this.clusterTimestamp !== null) throw new Error('invalid Matroska Cluster timestamp')
        this.clusterTimestamp = integer(payload)
      } else if (h.id === 0xa3) {
        this.readBlock(payload, true, output)
      } else if (h.id === 0xa0) {
        const children = elements(payload)
        const blocks = children.filter(x => x.id === 0xa1)
        if (blocks.length !== 1) throw new Error('invalid Matroska BlockGroup')
        this.readBlock(blocks[0]!.data, !children.some(x => x.id === 0xfb), output, false)
      } else if (h.id === 0xa1) {
        throw new Error('Matroska Block outside BlockGroup')
      }
      consumed = next
    }
    this.position += BigInt(consumed)
    // Never let a subarray pin the complete Blob conversion after consumption.
    this.pending = this.pending.slice(consumed)
  }

  finish(endAtMs: number): AvcRemuxChunk[] {
    if (this.finished) throw new Error('AVC stream already finished')
    if (!Number.isFinite(endAtMs)) throw new Error('invalid AVC delivery clock')
    if (this.pending.byteLength !== 0) throw new Error('truncated final Matroska element')
    if ((this.clusterEnd !== null && this.position !== this.clusterEnd) ||
        (this.segmentEnd !== null && this.position !== this.segmentEnd)) {
      throw new Error('truncated final Matroska enclosure')
    }
    this.finished = true
    if (this.samples.length === 0) return []
    this.samples[this.samples.length - 1]!.duration = this.lastDuration
    const last = this.samples[this.samples.length - 1]!
    const end = last.timestamp + BigInt(last.duration)
    return this.anchor([{ bytes: this.emit(), end }], endAtMs)
  }

  clear(): void {
    this.pending = new Uint8Array(0)
    this.samples = []
    this.sampleBytes = 0
    this.avcC = null
    this.sps = null; this.pps = null
    this.finished = true
  }

  stats(): { pendingBytes: number; sampleBytes: number; sampleCount: number; position: bigint; outputBytes: bigint; emittedSamples: bigint } {
    return { pendingBytes: this.pending.byteLength, sampleBytes: this.sampleBytes,
      sampleCount: this.samples.length, position: this.position, outputBytes: this.outputBytes,
      emittedSamples: this.emittedSamples }
  }

  private readTracks(payload: Uint8Array<ArrayBufferLike>): void {
    const tracks = elements(payload).filter(x => x.id === 0xae)
    if (tracks.length !== 1) throw new Error('AVC recorder must have exactly one video track')
    const fields = elements(tracks[0]!.data)
    if (scalar(fields, 0x83) !== 1n) throw new Error('AVC recorder contains a non-video track')
    this.track = scalar(fields, 0xd7)
    if (this.track <= 0n) throw new Error('invalid AVC track number')
    const codec = fields.find(x => x.id === 0x86)
    const privateData = fields.find(x => x.id === 0x63a2)
    const video = fields.find(x => x.id === 0xe0)
    if (!codec || textDecoder.decode(codec.data) !== 'V_MPEG4/ISO/AVC' || !video) {
      throw new Error('Matroska stream is not configured AVC video')
    }
    this.annexB = privateData === undefined
    if (privateData !== undefined) {
      this.avcC = privateData.data.slice()
      if (this.avcC.byteLength < 7 || this.avcC[0] !== 1 || (this.avcC[4]! & 3) !== 3) {
        throw new Error('invalid AVC configuration or unsupported NAL length width')
      }
    }
    const dimensions = elements(video.data)
    this.width = Number(scalar(dimensions, 0xb0)); this.height = Number(scalar(dimensions, 0xba))
    if (this.width <= 0 || this.width > 0xffff || this.height <= 0 || this.height > 0xffff) throw new Error('invalid AVC dimensions')
    const duration = scalar(fields, 0x23e383, BigInt(this.nominalDuration) * 1000n)
    const microseconds = Number((duration + 500n) / 1000n)
    if (!Number.isSafeInteger(microseconds) || microseconds <= 0 || microseconds > 0xffffffff) throw new Error('invalid AVC default frame duration')
    this.nominalDuration = microseconds; this.lastDuration = microseconds
  }

  private readBlock(payload: Uint8Array<ArrayBufferLike>, key: boolean,
    output: Array<{ bytes: Uint8Array<ArrayBuffer>; end: bigint | null }>, simple = true): void {
    if (!this.inCluster || this.clusterTimestamp === null || this.track === null) throw new Error('AVC block precedes its metadata')
    const track = vint(payload, 0, false)
    if (!track || track.unknown || track.value !== this.track || payload.byteLength <= track.bytes + 3) throw new Error('invalid AVC block track/payload')
    const flags = payload[track.bytes + 2]!
    if ((flags & 0x06) !== 0 || (flags & 0x08) !== 0) throw new Error('laced/invisible AVC block is unsupported')
    const relative = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt16(track.bytes)
    const rawTime = this.clusterTimestamp + BigInt(relative)
    if (rawTime < 0n) throw new Error('negative AVC timestamp')
    const timestamp = (rawTime * this.timecodeScale + 500n) / 1000n
    if (this.latestTimestamp !== null && timestamp < this.latestTimestamp) throw new Error('decreasing AVC timestamps: ' + timestamp + ' < ' + this.latestTimestamp)
    const isKey = simple ? (flags & 0x80) !== 0 : key
    let bytes = payload.slice(track.bytes + 3)
    if (this.annexB) {
      const nals = annexBNals(bytes)
      for (const nal of nals) {
        const type = nal[0]! & 0x1f
        if (type !== 7 && type !== 8) continue
        const old = type === 7 ? this.sps : this.pps
        if (old !== null && (old.byteLength !== nal.byteLength || old.some((v, i) => v !== nal[i]))) {
          throw new Error('AVC parameter sets changed inside one recording')
        }
        if (type === 7) this.sps = nal.slice()
        else this.pps = nal.slice()
      }
      if (this.avcC === null) {
        if (!isKey || this.sps === null || this.pps === null) throw new Error('first AVC keyframe lacks parameter sets')
        this.avcC = avcConfiguration(this.sps, this.pps)
        const init = initialization(this.width, this.height, this.avcC)
        this.outputBytes += BigInt(init.byteLength)
        output.push({ bytes: init, end: timestamp })
      }
      const media = nals.filter(n => (n[0]! & 0x1f) !== 7 && (n[0]! & 0x1f) !== 8)
      if (media.length === 0) throw new Error('AVC block has no media NAL')
      bytes = concat(media.flatMap(n => [uint(n.byteLength), n]))
    }
    let offset = 0
    while (offset < bytes.byteLength) {
      if (offset + 4 > bytes.byteLength) throw new Error('truncated AVC NAL length')
      const size = new DataView(bytes.buffer).getUint32(offset)
      if (size === 0 || offset + 4 + size > bytes.byteLength) throw new Error('truncated AVC NAL')
      offset += 4 + size
    }
    const previous = this.samples[this.samples.length - 1]
    if (previous) {
      const duration = Number(timestamp - previous.timestamp)
      if (!Number.isSafeInteger(duration) || duration < 0 || duration > 0xffffffff) throw new Error('AVC duration outside trun field')
      previous.duration = duration
      // Chromium can repeat its zero timestamp while a resumed stream starts.
      // Preserve both samples with a zero trun duration; never invent a gap.
      if (duration > 0) this.lastDuration = duration
      if (isKey) output.push({ bytes: this.emit(), end: timestamp })
    } else if (!isKey) throw new Error('AVC recording must begin at a keyframe')
    if (this.sampleBytes + bytes.byteLength + this.pending.byteLength > this.budgetBytes) throw new Error('AVC GOP exceeds remux byte budget')
    if (this.samples.length >= MAX_SAMPLES) throw new Error('AVC GOP exceeds sample budget')
    this.samples.push({ timestamp, duration: 0, key: isKey, bytes })
    this.sampleBytes += bytes.byteLength
    this.latestTimestamp = timestamp
  }

  private emit(): Uint8Array<ArrayBuffer> {
    // mfhd is a fragment sequence, never a lifetime byte offset. Wrap is legal;
    // media time remains uint64 and every data_offset is relative to its moof.
    this.sequence = this.sequence === 0xffffffff ? 1 : this.sequence + 1
    const bytes = fragment(this.samples, this.sequence)
    this.emittedSamples += BigInt(this.samples.length)
    this.outputBytes += BigInt(bytes.byteLength)
    this.samples = []; this.sampleBytes = 0
    return bytes
  }

  private anchor(output: Array<{ bytes: Uint8Array<ArrayBuffer>; end: bigint | null }>,
    endAtMs: number): AvcRemuxChunk[] {
    const latestEnd = this.latestTimestamp === null ? null :
      this.latestTimestamp + BigInt(this.lastDuration)
    return output.map(item => ({ bytes: item.bytes, endAtMs: item.end === null || latestEnd === null
      ? endAtMs : endAtMs - Number(latestEnd - item.end) / 1000 }))
  }
}
