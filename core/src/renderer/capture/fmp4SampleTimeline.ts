/**
 * Exact timing metadata read from an assembled fragmented MP4.
 *
 * This parser deliberately does not inspect media payload bytes. It follows
 * the ISO-BMFF timing declarations only: the video track's `mdhd` timescale,
 * each `traf`'s `tfdt`, and the duration/composition fields declared by
 * `tfhd`, `trex`, and `trun`. No wall-clock or frame-rate estimate is used.
 */

export const FMP4_TIMELINE_DEFAULT_MAX_INPUT_BYTES = 512 * 1024 * 1024
export const FMP4_TIMELINE_DEFAULT_MAX_BOXES = 100_000
export const FMP4_TIMELINE_DEFAULT_MAX_SAMPLES = 1_000_000

export interface Fmp4SampleTimelineLimits {
  maxInputBytes?: number
  maxBoxes?: number
  maxSamples?: number
}

export interface Fmp4VideoSample {
  trackId: number
  fragmentIndex: number
  runIndex: number
  sampleIndex: number
  decodeTimeTicks: bigint
  compositionOffsetTicks: bigint
  presentationTimeTicks: bigint
  durationTicks: bigint
  presentationTimeMs: number
  durationMs: number
}

export interface Fmp4VideoTrackTimeline {
  trackId: number
  timescale: number
  samples: Fmp4VideoSample[]
}

export type Fmp4SampleTimelineFailureReason =
  | 'invalid-limit'
  | 'input-limit-exceeded'
  | 'box-limit-exceeded'
  | 'sample-limit-exceeded'
  | 'malformed-box'
  | 'missing-moov'
  | 'missing-video-track'
  | 'missing-tfdt'
  | 'missing-sample-duration'

export type Fmp4VideoSampleTimelineResult =
  | {
    status: 'ok'
    tracks: Fmp4VideoTrackTimeline[]
    boxCount: number
    sampleCount: number
  }
  | {
    status: 'invalid'
    reason: Fmp4SampleTimelineFailureReason
    detail: string
  }

interface Box {
  type: string
  start: number
  payloadStart: number
  end: number
}

interface VideoTrackDefinition {
  trackId: number
  timescale: number
  defaultSampleDuration?: number
}

interface ParseState {
  bytes: Uint8Array
  view: DataView
  maxBoxes: number
  maxSamples: number
  boxCount: number
  sampleCount: number
}

class TimelineParseFailure extends Error {
  readonly reason: Fmp4SampleTimelineFailureReason

  constructor(
    reason: Fmp4SampleTimelineFailureReason,
    detail: string,
  ) {
    super(detail)
    this.reason = reason
  }
}

function fail(
  reason: Fmp4SampleTimelineFailureReason,
  detail: string,
): never {
  throw new TimelineParseFailure(reason, detail)
}

function positiveIntegerLimit(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    fail('invalid-limit', `${name} must be a positive safe integer`)
  }
  return resolved
}

function readUint32(state: ParseState, offset: number, end: number, label: string): number {
  if (offset < 0 || offset + 4 > end) {
    fail('malformed-box', `${label} is truncated`)
  }
  return state.view.getUint32(offset)
}

function readInt32(state: ParseState, offset: number, end: number, label: string): number {
  if (offset < 0 || offset + 4 > end) {
    fail('malformed-box', `${label} is truncated`)
  }
  return state.view.getInt32(offset)
}

function readUint64(state: ParseState, offset: number, end: number, label: string): bigint {
  if (offset < 0 || offset + 8 > end) {
    fail('malformed-box', `${label} is truncated`)
  }
  return state.view.getBigUint64(offset)
}

function fourCc(state: ParseState, offset: number, end: number, label: string): string {
  if (offset < 0 || offset + 4 > end) {
    fail('malformed-box', `${label} is truncated`)
  }
  return String.fromCharCode(
    state.bytes[offset] ?? 0,
    state.bytes[offset + 1] ?? 0,
    state.bytes[offset + 2] ?? 0,
    state.bytes[offset + 3] ?? 0,
  )
}

function boxesIn(state: ParseState, start: number, end: number): Box[] {
  const boxes: Box[] = []
  let cursor = start
  while (cursor < end) {
    if (end - cursor < 8) {
      fail('malformed-box', `box header at byte ${String(cursor)} is truncated`)
    }
    const size32 = readUint32(state, cursor, end, 'box size')
    const type = fourCc(state, cursor + 4, end, 'box type')
    let headerSize = 8
    let size: number
    if (size32 === 1) {
      const extendedSize = readUint64(state, cursor + 8, end, `${type} extended size`)
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) {
        fail('malformed-box', `${type} extended size exceeds safe address space`)
      }
      size = Number(extendedSize)
      headerSize = 16
    } else if (size32 === 0) {
      size = end - cursor
    } else {
      size = size32
    }
    if (size < headerSize || size > end - cursor) {
      fail('malformed-box', `${type} at byte ${String(cursor)} has an invalid size`)
    }
    state.boxCount += 1
    if (state.boxCount > state.maxBoxes) {
      fail('box-limit-exceeded', `box count exceeds ${String(state.maxBoxes)}`)
    }
    boxes.push({
      type,
      start: cursor,
      payloadStart: cursor + headerSize,
      end: cursor + size,
    })
    cursor += size
  }
  return boxes
}

function fullBoxVersionAndFlags(
  state: ParseState,
  box: Box,
): { version: number; flags: number } {
  if (box.payloadStart + 4 > box.end) {
    fail('malformed-box', `${box.type} full-box header is truncated`)
  }
  const version = state.bytes[box.payloadStart] ?? 0
  const flags = readUint32(
    state,
    box.payloadStart,
    box.end,
    `${box.type} flags`,
  ) & 0x00ff_ffff
  return { version, flags }
}

function singleChild(
  children: readonly Box[],
  type: string,
  parentType: string,
): Box | undefined {
  const matches = children.filter((box) => box.type === type)
  if (matches.length > 1) {
    fail('malformed-box', `${parentType} contains multiple ${type} boxes`)
  }
  return matches[0]
}

function trackIdFromTkhd(state: ParseState, tkhd: Box): number {
  const { version } = fullBoxVersionAndFlags(state, tkhd)
  if (version !== 0 && version !== 1) {
    fail('malformed-box', `tkhd version ${String(version)} is unsupported`)
  }
  const offset = tkhd.payloadStart + (version === 1 ? 20 : 12)
  const trackId = readUint32(state, offset, tkhd.end, 'tkhd track id')
  if (trackId === 0) fail('malformed-box', 'tkhd track id is zero')
  return trackId
}

function timescaleFromMdhd(state: ParseState, mdhd: Box): number {
  const { version } = fullBoxVersionAndFlags(state, mdhd)
  if (version !== 0 && version !== 1) {
    fail('malformed-box', `mdhd version ${String(version)} is unsupported`)
  }
  const offset = mdhd.payloadStart + (version === 1 ? 20 : 12)
  const timescale = readUint32(state, offset, mdhd.end, 'mdhd timescale')
  if (timescale === 0) fail('malformed-box', 'mdhd timescale is zero')
  return timescale
}

function trexDefaults(state: ParseState, moovChildren: readonly Box[]): Map<number, number> {
  const defaults = new Map<number, number>()
  const mvex = singleChild(moovChildren, 'mvex', 'moov')
  if (mvex === undefined) return defaults
  for (const trex of boxesIn(state, mvex.payloadStart, mvex.end).filter(
    (box) => box.type === 'trex',
  )) {
    const { version } = fullBoxVersionAndFlags(state, trex)
    if (version !== 0) {
      fail('malformed-box', `trex version ${String(version)} is unsupported`)
    }
    const trackId = readUint32(state, trex.payloadStart + 4, trex.end, 'trex track id')
    const duration = readUint32(
      state,
      trex.payloadStart + 12,
      trex.end,
      'trex default sample duration',
    )
    if (defaults.has(trackId)) {
      fail('malformed-box', `duplicate trex for track ${String(trackId)}`)
    }
    defaults.set(trackId, duration)
  }
  return defaults
}

function videoTracks(state: ParseState, moov: Box): VideoTrackDefinition[] {
  const moovChildren = boxesIn(state, moov.payloadStart, moov.end)
  const defaults = trexDefaults(state, moovChildren)
  const tracks: VideoTrackDefinition[] = []
  const usedTrackIds = new Set<number>()
  for (const trak of moovChildren.filter((box) => box.type === 'trak')) {
    const trakChildren = boxesIn(state, trak.payloadStart, trak.end)
    const tkhd = singleChild(trakChildren, 'tkhd', 'trak')
    const mdia = singleChild(trakChildren, 'mdia', 'trak')
    if (tkhd === undefined || mdia === undefined) continue
    const mdiaChildren = boxesIn(state, mdia.payloadStart, mdia.end)
    const mdhd = singleChild(mdiaChildren, 'mdhd', 'mdia')
    const hdlr = singleChild(mdiaChildren, 'hdlr', 'mdia')
    if (mdhd === undefined || hdlr === undefined) continue
    const handlerType = fourCc(
      state,
      hdlr.payloadStart + 8,
      hdlr.end,
      'hdlr handler type',
    )
    if (handlerType !== 'vide') continue
    const trackId = trackIdFromTkhd(state, tkhd)
    if (usedTrackIds.has(trackId)) {
      fail('malformed-box', `duplicate video track id ${String(trackId)}`)
    }
    usedTrackIds.add(trackId)
    tracks.push({
      trackId,
      timescale: timescaleFromMdhd(state, mdhd),
      ...(defaults.has(trackId)
        ? { defaultSampleDuration: defaults.get(trackId) }
        : {}),
    })
  }
  if (tracks.length === 0) {
    fail('missing-video-track', 'moov has no complete vide track')
  }
  return tracks
}

function tfhdTrackAndDefault(
  state: ParseState,
  tfhd: Box,
): { trackId: number; defaultSampleDuration?: number } {
  const { version, flags } = fullBoxVersionAndFlags(state, tfhd)
  if (version !== 0) {
    fail('malformed-box', `tfhd version ${String(version)} is unsupported`)
  }
  const trackId = readUint32(state, tfhd.payloadStart + 4, tfhd.end, 'tfhd track id')
  let cursor = tfhd.payloadStart + 8
  const skip = (count: number, label: string): void => {
    if (cursor + count > tfhd.end) {
      fail('malformed-box', `${label} is truncated`)
    }
    cursor += count
  }
  if ((flags & 0x000001) !== 0) skip(8, 'tfhd base data offset')
  if ((flags & 0x000002) !== 0) skip(4, 'tfhd sample description index')
  let defaultSampleDuration: number | undefined
  if ((flags & 0x000008) !== 0) {
    defaultSampleDuration = readUint32(
      state,
      cursor,
      tfhd.end,
      'tfhd default sample duration',
    )
    cursor += 4
  }
  if ((flags & 0x000010) !== 0) skip(4, 'tfhd default sample size')
  if ((flags & 0x000020) !== 0) skip(4, 'tfhd default sample flags')
  return {
    trackId,
    ...(defaultSampleDuration === undefined ? {} : { defaultSampleDuration }),
  }
}

function decodeTimeFromTfdt(state: ParseState, tfdt: Box): bigint {
  const { version } = fullBoxVersionAndFlags(state, tfdt)
  if (version === 0) {
    return BigInt(readUint32(
      state,
      tfdt.payloadStart + 4,
      tfdt.end,
      'tfdt base media decode time',
    ))
  }
  if (version === 1) {
    return readUint64(
      state,
      tfdt.payloadStart + 4,
      tfdt.end,
      'tfdt base media decode time',
    )
  }
  fail('malformed-box', `tfdt version ${String(version)} is unsupported`)
}

function ticksToMilliseconds(ticks: bigint, timescale: number): number {
  const scale = BigInt(timescale)
  const wholeSeconds = ticks / scale
  const remainder = ticks % scale
  return Number(wholeSeconds) * 1_000 + (Number(remainder) * 1_000) / timescale
}

function appendRun(
  state: ParseState,
  trun: Box,
  track: VideoTrackDefinition,
  fragmentIndex: number,
  runIndex: number,
  decodeTime: bigint,
  tfhdDefaultDuration: number | undefined,
  samples: Fmp4VideoSample[],
): bigint {
  const { version, flags } = fullBoxVersionAndFlags(state, trun)
  if (version !== 0 && version !== 1) {
    fail('malformed-box', `trun version ${String(version)} is unsupported`)
  }
  const sampleCount = readUint32(
    state,
    trun.payloadStart + 4,
    trun.end,
    'trun sample count',
  )
  if (sampleCount > state.maxSamples - state.sampleCount) {
    fail(
      'sample-limit-exceeded',
      `sample count exceeds ${String(state.maxSamples)}`,
    )
  }
  let cursor = trun.payloadStart + 8
  if ((flags & 0x000001) !== 0) cursor += 4
  if ((flags & 0x000004) !== 0) cursor += 4
  if (cursor > trun.end) {
    fail('malformed-box', 'trun optional header fields are truncated')
  }
  const perSampleBytes =
    ((flags & 0x000100) !== 0 ? 4 : 0)
    + ((flags & 0x000200) !== 0 ? 4 : 0)
    + ((flags & 0x000400) !== 0 ? 4 : 0)
    + ((flags & 0x000800) !== 0 ? 4 : 0)
  if (perSampleBytes > 0 && sampleCount > Math.floor((trun.end - cursor) / perSampleBytes)) {
    fail('malformed-box', 'trun sample table is truncated')
  }
  const fallbackDuration = tfhdDefaultDuration ?? track.defaultSampleDuration
  if ((flags & 0x000100) === 0 && fallbackDuration === undefined && sampleCount > 0) {
    fail(
      'missing-sample-duration',
      `track ${String(track.trackId)} has no trun, tfhd, or trex duration`,
    )
  }
  let nextDecodeTime = decodeTime
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const duration = (flags & 0x000100) !== 0
      ? readUint32(state, cursor, trun.end, 'trun sample duration')
      : fallbackDuration!
    if ((flags & 0x000100) !== 0) cursor += 4
    if ((flags & 0x000200) !== 0) cursor += 4
    if ((flags & 0x000400) !== 0) cursor += 4
    let compositionOffset = 0
    if ((flags & 0x000800) !== 0) {
      compositionOffset = version === 1
        ? readInt32(state, cursor, trun.end, 'trun composition time offset')
        : readUint32(state, cursor, trun.end, 'trun composition time offset')
      cursor += 4
    }
    const durationTicks = BigInt(duration)
    const compositionOffsetTicks = BigInt(compositionOffset)
    const presentationTimeTicks = nextDecodeTime + compositionOffsetTicks
    samples.push({
      trackId: track.trackId,
      fragmentIndex,
      runIndex,
      sampleIndex,
      decodeTimeTicks: nextDecodeTime,
      compositionOffsetTicks,
      presentationTimeTicks,
      durationTicks,
      presentationTimeMs: ticksToMilliseconds(presentationTimeTicks, track.timescale),
      durationMs: ticksToMilliseconds(durationTicks, track.timescale),
    })
    nextDecodeTime += durationTicks
  }
  state.sampleCount += sampleCount
  return nextDecodeTime
}

function appendFragmentSamples(
  state: ParseState,
  moof: Box,
  fragmentIndex: number,
  tracksById: ReadonlyMap<number, VideoTrackDefinition>,
  samplesByTrack: ReadonlyMap<number, Fmp4VideoSample[]>,
): void {
  for (const traf of boxesIn(state, moof.payloadStart, moof.end).filter(
    (box) => box.type === 'traf',
  )) {
    const children = boxesIn(state, traf.payloadStart, traf.end)
    const tfhd = singleChild(children, 'tfhd', 'traf')
    if (tfhd === undefined) continue
    const tfhdDefinition = tfhdTrackAndDefault(state, tfhd)
    const track = tracksById.get(tfhdDefinition.trackId)
    if (track === undefined) continue
    const tfdt = singleChild(children, 'tfdt', 'traf')
    const runs = children.filter((box) => box.type === 'trun')
    if (runs.length === 0) continue
    if (tfdt === undefined) {
      fail(
        'missing-tfdt',
        `video track ${String(track.trackId)} fragment has no tfdt`,
      )
    }
    let decodeTime = decodeTimeFromTfdt(state, tfdt)
    const trackSamples = samplesByTrack.get(track.trackId)
    if (trackSamples === undefined) {
      fail('malformed-box', `video track ${String(track.trackId)} is not initialized`)
    }
    for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
      decodeTime = appendRun(
        state,
        runs[runIndex]!,
        track,
        fragmentIndex,
        runIndex,
        decodeTime,
        tfhdDefinition.defaultSampleDuration,
        trackSamples,
      )
    }
  }
}

export function enumerateFmp4VideoSamples(
  input: ArrayBuffer,
  limits: Fmp4SampleTimelineLimits = {},
): Fmp4VideoSampleTimelineResult {
  try {
    const maxInputBytes = positiveIntegerLimit(
      limits.maxInputBytes,
      FMP4_TIMELINE_DEFAULT_MAX_INPUT_BYTES,
      'maxInputBytes',
    )
    const maxBoxes = positiveIntegerLimit(
      limits.maxBoxes,
      FMP4_TIMELINE_DEFAULT_MAX_BOXES,
      'maxBoxes',
    )
    const maxSamples = positiveIntegerLimit(
      limits.maxSamples,
      FMP4_TIMELINE_DEFAULT_MAX_SAMPLES,
      'maxSamples',
    )
    if (input.byteLength > maxInputBytes) {
      fail(
        'input-limit-exceeded',
        `input has ${String(input.byteLength)} bytes; limit is ${String(maxInputBytes)}`,
      )
    }
    const bytes = new Uint8Array(input)
    const state: ParseState = {
      bytes,
      view: new DataView(input),
      maxBoxes,
      maxSamples,
      boxCount: 0,
      sampleCount: 0,
    }
    const roots = boxesIn(state, 0, bytes.byteLength)
    const moovs = roots.filter((box) => box.type === 'moov')
    if (moovs.length !== 1) {
      fail(
        'missing-moov',
        `expected one moov initialization box, found ${String(moovs.length)}`,
      )
    }
    const definitions = videoTracks(state, moovs[0]!)
    const tracksById = new Map(
      definitions.map((track) => [track.trackId, track] as const),
    )
    const samplesByTrack = new Map(
      definitions.map((track) => [track.trackId, [] as Fmp4VideoSample[]] as const),
    )
    let fragmentIndex = 0
    for (const root of roots) {
      if (root.type !== 'moof') continue
      appendFragmentSamples(
        state,
        root,
        fragmentIndex,
        tracksById,
        samplesByTrack,
      )
      fragmentIndex += 1
    }
    return {
      status: 'ok',
      tracks: definitions.map((track) => ({
        trackId: track.trackId,
        timescale: track.timescale,
        samples: samplesByTrack.get(track.trackId) ?? [],
      })),
      boxCount: state.boxCount,
      sampleCount: state.sampleCount,
    }
  } catch (error) {
    if (error instanceof TimelineParseFailure) {
      return {
        status: 'invalid',
        reason: error.reason,
        detail: error.message,
      }
    }
    return {
      status: 'invalid',
      reason: 'malformed-box',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}
