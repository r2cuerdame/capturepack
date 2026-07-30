import type {
  Fmp4VideoSampleTimelineResult,
  Fmp4VideoTrackTimeline,
} from '../src/renderer/capture/fmp4SampleTimeline'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) passed += 1
  else failed += 1
  console.log(
    `  ${condition ? 'PASS' : 'FAIL'}  ${name}`
      + (detail === '' ? '' : ` — ${detail}`),
  )
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

function u32(value: number): Uint8Array {
  const result = new Uint8Array(4)
  new DataView(result.buffer).setUint32(0, value)
  return result
}

function i32(value: number): Uint8Array {
  const result = new Uint8Array(4)
  new DataView(result.buffer).setInt32(0, value)
  return result
}

function u64(value: bigint): Uint8Array {
  const result = new Uint8Array(8)
  new DataView(result.buffer).setBigUint64(0, value)
  return result
}

function ascii(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0))
}

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(...payload)
  return concat(u32(8 + body.byteLength), ascii(type), body)
}

function fullBox(version: number, flags: number): Uint8Array {
  return Uint8Array.from([
    version,
    (flags >>> 16) & 0xff,
    (flags >>> 8) & 0xff,
    flags & 0xff,
  ])
}

function initialization(
  timescale = 1_000,
  trackId = 7,
  trexDefaultDuration?: number,
): Uint8Array {
  const tkhd = box(
    'tkhd',
    fullBox(0, 0),
    u32(0),
    u32(0),
    u32(trackId),
    u32(0),
  )
  const mdhd = box(
    'mdhd',
    fullBox(0, 0),
    u32(0),
    u32(0),
    u32(timescale),
    u32(0),
  )
  const hdlr = box('hdlr', fullBox(0, 0), u32(0), ascii('vide'))
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr))
  const mvex = trexDefaultDuration === undefined
    ? new Uint8Array(0)
    : box(
      'mvex',
      box(
        'trex',
        fullBox(0, 0),
        u32(trackId),
        u32(1),
        u32(trexDefaultDuration),
        u32(0),
        u32(0),
      ),
    )
  return box('moov', trak, mvex)
}

function tfhdWithDefault(trackId: number, duration: number): Uint8Array {
  return box('tfhd', fullBox(0, 0x000008), u32(trackId), u32(duration))
}

function tfhdWithoutDefault(trackId: number): Uint8Array {
  return box('tfhd', fullBox(0, 0), u32(trackId))
}

function tfdt(decodeTime: bigint): Uint8Array {
  return decodeTime > 0xffff_ffffn
    ? box('tfdt', fullBox(1, 0), u64(decodeTime))
    : box('tfdt', fullBox(0, 0), u32(Number(decodeTime)))
}

function trunDefaultDurations(sampleCount: number): Uint8Array {
  return box('trun', fullBox(0, 0), u32(sampleCount))
}

function trunExplicit(
  version: 0 | 1,
  samples: ReadonlyArray<{ duration: number; compositionOffset?: number }>,
): Uint8Array {
  const hasCompositionOffsets = samples.some(
    (sample) => sample.compositionOffset !== undefined,
  )
  const flags = 0x000100 | (hasCompositionOffsets ? 0x000800 : 0)
  const entries = samples.map((sample) =>
    concat(
      u32(sample.duration),
      ...(hasCompositionOffsets
        ? [
          version === 1
            ? i32(sample.compositionOffset ?? 0)
            : u32(sample.compositionOffset ?? 0),
        ]
        : []),
    ),
  )
  return box('trun', fullBox(version, flags), u32(samples.length), ...entries)
}

function fragment(...trafChildren: Uint8Array[]): Uint8Array {
  return concat(
    box('moof', box('traf', ...trafChildren)),
    box('mdat', Uint8Array.from([1, 2, 3, 4])),
  )
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
}

function onlyTrack(
  result: Fmp4VideoSampleTimelineResult,
): Fmp4VideoTrackTimeline | undefined {
  return result.status === 'ok' && result.tracks.length === 1
    ? result.tracks[0]
    : undefined
}

function resultDetail(result: Fmp4VideoSampleTimelineResult): string {
  return JSON.stringify(
    result,
    (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value,
  )
}

async function main(): Promise<void> {
  const {
    enumerateFmp4VideoSamples,
  } = await import(
    '../src/renderer/capture/fmp4SampleTimeline'
  ) as typeof import(
    '../src/renderer/capture/fmp4SampleTimeline'
  )

  const defaultDurationResult = enumerateFmp4VideoSamples(asArrayBuffer(concat(
    initialization(),
    fragment(
      tfhdWithDefault(7, 40),
      tfdt(100n),
      trunDefaultDurations(3),
    ),
  )))
  const defaultTrack = onlyTrack(defaultDurationResult)
  check(
    'tfhd default duration enumerates every exact decode/presentation timestamp',
    defaultTrack?.timescale === 1_000
      && defaultTrack.samples.map((sample) => sample.presentationTimeTicks).join(',')
        === '100,140,180'
      && defaultTrack.samples.every((sample) => sample.durationTicks === 40n),
    resultDetail(defaultDurationResult),
  )

  const explicitResult = enumerateFmp4VideoSamples(asArrayBuffer(concat(
    initialization(),
    fragment(
      tfhdWithDefault(7, 99),
      tfdt(1_000n),
      trunExplicit(0, [{ duration: 30 }, { duration: 60 }]),
    ),
  )))
  const explicitTrack = onlyTrack(explicitResult)
  check(
    'per-sample trun duration overrides the tfhd default and advances DTS exactly',
    explicitTrack?.samples[0]?.durationTicks === 30n
      && explicitTrack.samples[1]?.decodeTimeTicks === 1_030n
      && explicitTrack.samples[1]?.durationTicks === 60n,
    resultDetail(explicitResult),
  )

  const trexResult = enumerateFmp4VideoSamples(asArrayBuffer(concat(
    initialization(90_000, 7, 3_000),
    fragment(
      tfhdWithoutDefault(7),
      tfdt(0n),
      trunDefaultDurations(2),
    ),
  )))
  const trexTrack = onlyTrack(trexResult)
  check(
    'trex duration is the bounded fallback when tfhd and trun omit duration',
    trexTrack?.samples.length === 2
      && trexTrack.samples[1]?.presentationTimeTicks === 3_000n
      && trexTrack.samples[1]?.durationMs === 100 / 3,
    resultDetail(trexResult),
  )

  const unsignedCompositionResult = enumerateFmp4VideoSamples(asArrayBuffer(concat(
    initialization(),
    fragment(
      tfhdWithoutDefault(7),
      tfdt(500n),
      trunExplicit(0, [{ duration: 40, compositionOffset: 12 }]),
    ),
  )))
  const unsignedTrack = onlyTrack(unsignedCompositionResult)
  check(
    'version-0 trun composition offset is unsigned',
    unsignedTrack?.samples[0]?.decodeTimeTicks === 500n
      && unsignedTrack.samples[0]?.compositionOffsetTicks === 12n
      && unsignedTrack.samples[0]?.presentationTimeTicks === 512n,
    resultDetail(unsignedCompositionResult),
  )

  const signedCompositionResult = enumerateFmp4VideoSamples(asArrayBuffer(concat(
    initialization(),
    fragment(
      tfhdWithoutDefault(7),
      tfdt(0x1_0000_0000n),
      trunExplicit(1, [
        { duration: 50, compositionOffset: 10 },
        { duration: 70, compositionOffset: -15 },
      ]),
    ),
  )))
  const signedTrack = onlyTrack(signedCompositionResult)
  check(
    'version-1 composition offsets are signed and 64-bit tfdt remains exact',
    signedTrack?.samples[0]?.presentationTimeTicks === 0x1_0000_000an
      && signedTrack.samples[1]?.decodeTimeTicks === 0x1_0000_0032n
      && signedTrack.samples[1]?.compositionOffsetTicks === -15n
      && signedTrack.samples[1]?.presentationTimeTicks === 0x1_0000_0023n,
    resultDetail(signedCompositionResult),
  )

  const missingDuration = enumerateFmp4VideoSamples(asArrayBuffer(concat(
    initialization(),
    fragment(
      tfhdWithoutDefault(7),
      tfdt(0n),
      trunDefaultDurations(1),
    ),
  )))
  check(
    'an undeclared sample duration is rejected instead of guessed',
    missingDuration.status === 'invalid'
      && missingDuration.reason === 'missing-sample-duration',
    resultDetail(missingDuration),
  )

  const truncatedBox = concat(
    initialization(),
    Uint8Array.from([0, 0, 0, 32, 0x6d, 0x6f, 0x6f, 0x66, 0, 0]),
  )
  const malformed = enumerateFmp4VideoSamples(asArrayBuffer(truncatedBox))
  check(
    'a truncated box is rejected instead of partially enumerated',
    malformed.status === 'invalid' && malformed.reason === 'malformed-box',
    resultDetail(malformed),
  )

  const boundedInput = enumerateFmp4VideoSamples(
    asArrayBuffer(concat(initialization(), new Uint8Array(128))),
    { maxInputBytes: 64 },
  )
  check(
    'input bytes are rejected before parsing above the caller bound',
    boundedInput.status === 'invalid'
      && boundedInput.reason === 'input-limit-exceeded',
    resultDetail(boundedInput),
  )

  const boundedSamples = enumerateFmp4VideoSamples(asArrayBuffer(concat(
    initialization(),
    fragment(
      tfhdWithDefault(7, 40),
      tfdt(0n),
      trunDefaultDurations(3),
    ),
  )), { maxSamples: 2 })
  check(
    'declared sample cardinality is rejected before allocation above the bound',
    boundedSamples.status === 'invalid'
      && boundedSamples.reason === 'sample-limit-exceeded',
    resultDetail(boundedSamples),
  )

  console.log(`\nfMP4 sample timeline checks: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
