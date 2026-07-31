/**
 * A bounded replay ring for Chromium's fragmented MP4 MediaRecorder output.
 *
 * Chromium writes one initialization segment (`ftyp` + `moov`) followed by
 * independently muxed `moof`/`mdat` fragments. Keeping the initialization
 * segment and only the fragments that overlap the requested replay window lets
 * CapturePack use one encoder per display instead of two overlapping encoders.
 *
 * A recorder is stopped to flush the fragment containing the capture instant,
 * then immediately restarted. Fragments survive that restart. `assemble()`
 * rebases every fragment's `tfdt`, so a replay may safely span recorder
 * sessions whose native decode clocks each started at zero.
 */

interface Box {
  type: string
  bytes: Uint8Array<ArrayBufferLike>
  headerSize: number
}

interface LocatedBox {
  type: string
  start: number
  end: number
  headerSize: number
}

interface StoredFragment {
  bytes: Uint8Array<ArrayBufferLike>
  durationTicks: bigint
  timescale: number
  durationMs: number
  startAtMs: number
  endAtMs: number
  recorderSession: number
  /** Diagnostics only (#116); nothing in this file decides on these. */
  sourceDecodeTicks: bigint | null
  sampleCount: number
  maxSampleDurationTicks: number
  deliveredAtMs: number
}

export interface FragmentedMp4Replay {
  buffer: ArrayBuffer
  durationMs: number
  startAtMs: number
  endAtMs: number
  fragmentCount: number
}

export interface FragmentedMp4RingStats {
  fragmentCount: number
  retainedBytes: number
  retainedDurationMs: number
  retainedBudgetBytes: number
  workingSetBudgetBytes: number
  /**
   * WHERE A CAPTURE'S TIME WENT, IF IT WENT ANYWHERE (#116).
   *
   * A field capture reported a 903 ms stall and produced a replay whose longest
   * held frame was 197 ms — 17.6 s of desk as 5.3 s of media. Two probes
   * against a real MediaRecorder could not reproduce it, and dissecting the
   * file settled why they could not: it holds ONE fragment, so nothing this
   * ring does to place fragments could have been involved. The flattening was
   * already in the sample durations when the bytes arrived.
   *
   * These are the numbers that tell those layers apart, and they are recorded
   * rather than inferred. Nothing decides on them.
   */
  timing: FragmentedMp4RingTiming
}

export interface FragmentedMp4RingAssembly {
  retentionMs: number
  selectedBeforeRetention: number
  selectedAfterRetention: number
  /** What the honest timeline measured BEFORE the privacy window trimmed it. */
  timelineBeforeRetentionMs: number
  verdicts: ReadonlyArray<
    | { trusted: true; claimedMs: number; wallSpanMs: number }
    | {
        trusted: false
        reason: string
        claimedMs: number | null
        wallSpanMs: number
      }
  >
}

export interface FragmentedMp4RingTiming {
  /** Samples across every retained fragment. */
  sampleCount: number
  /** The longest single sample, i.e. the longest frame the file holds. */
  maxSampleDurationMs: number
  /** What the ENCODER's own clock spans, per recorder session, summed. */
  sourceSpanMs: number
  /** How many retained fragments arrived carrying a `tfdt` at all. */
  fragmentsWithSourceTime: number
  /** Distinct delivery instants the retained fragments arrived over. */
  deliveryCount: number
  /** The last assemble()'s own decisions, or null before one has run. */
  assembly: FragmentedMp4RingAssembly | null
}

// Top-level boxes which may legally sit between ftyp and moov in an
// initialization segment. Segment indexes and random-access tails (sidx/mfra)
// describe one recorder session's media and must not be carried in front of a
// replay assembled from different sessions.
const INITIALIZATION_AUXILIARY_BOXES = new Set(['free', 'skip'])
const CODEC_CONFIGURATION_BOXES = new Set(['avcC', 'hvcC', 'vpcC', 'av1C'])
const EMPTY_TRACK_DEFAULT_DURATIONS: ReadonlyMap<number, number> = new Map()

const DEFAULT_VIDEO_BITS_PER_SECOND = 6_000_000
const MIN_RETAINED_MEDIA_BYTES = 16 * 1024 * 1024
const MAX_WORKING_SET_BYTES = 1536 * 1024 * 1024
const ENCODER_BITRATE_HEADROOM = 1.25
// A split top-level box may briefly hold the old prefix, its concatenated
// parser buffer, and the completed ring fragment. Ordinary complete Blobs use
// only two copies, but the hard budget must cover the three-copy edge.
const TRANSIENT_COPY_MULTIPLIER = 3
const PARSER_CONTAINER_HEADROOM_BYTES = 4 * 1024 * 1024

function concatBytes(
  parts: readonly Uint8Array<ArrayBufferLike>[],
): Uint8Array<ArrayBuffer> {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const result = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

function ascii(data: Uint8Array<ArrayBufferLike>, offset: number, length: number): string {
  let result = ''
  for (let i = 0; i < length; i += 1) result += String.fromCharCode(data[offset + i] ?? 0)
  return result
}

function boxAt(
  data: Uint8Array<ArrayBufferLike>,
  offset: number,
  maxBoxBytes = Number.MAX_SAFE_INTEGER,
): { box: Box; next: number } | null {
  if (data.byteLength - offset < 8) return null
  const view = new DataView(data.buffer, data.byteOffset + offset, data.byteLength - offset)
  let size = view.getUint32(0)
  let headerSize = 8
  if (size === 1) {
    if (data.byteLength - offset < 16) return null
    const extended = view.getBigUint64(8)
    if (extended > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('MP4 box is too large')
    size = Number(extended)
    headerSize = 16
  } else if (size === 0) {
    size = data.byteLength - offset
  }
  if (size < headerSize) throw new Error('Invalid MP4 box size')
  if (size > maxBoxBytes) throw new Error('MP4 box exceeds parser memory budget')
  if (offset + size > data.byteLength) return null
  return {
    box: {
      type: ascii(data, offset + 4, 4),
      // Parsing only needs a view. Callers which retain a box across this
      // method copy it explicitly, while complete fragments are copied once
      // into their final ring allocation. Copying every `mdat` here doubled
      // ingest peak memory for no benefit.
      bytes: data.subarray(offset, offset + size),
      headerSize,
    },
    next: offset + size,
  }
}

function locatedBoxAt(
  data: Uint8Array<ArrayBufferLike>,
  offset: number,
  limit = data.byteLength,
): LocatedBox | null {
  const parsed = boxAt(data, offset)
  if (parsed === null || parsed.next > limit) return null
  return {
    type: parsed.box.type,
    start: offset,
    end: parsed.next,
    headerSize: parsed.box.headerSize,
  }
}

function locatedChildren(
  data: Uint8Array<ArrayBufferLike>,
  parent: LocatedBox,
): LocatedBox[] {
  const children: LocatedBox[] = []
  let offset = parent.start + parent.headerSize
  while (offset < parent.end) {
    const child = locatedBoxAt(data, offset, parent.end)
    if (child === null) break
    children.push(child)
    offset = child.end
  }
  return children
}

function childBoxes(parent: Box): Box[] {
  const children: Box[] = []
  let offset = parent.headerSize
  while (offset < parent.bytes.byteLength) {
    const parsed = boxAt(parent.bytes, offset)
    if (parsed === null) break
    children.push(parsed.box)
    offset = parsed.next
  }
  return children
}

function fullBoxFlags(box: Box): number {
  const offset = box.headerSize
  if (box.bytes.byteLength < offset + 4) return 0
  return (
    ((box.bytes[offset + 1] ?? 0) << 16) |
    ((box.bytes[offset + 2] ?? 0) << 8) |
    (box.bytes[offset + 3] ?? 0)
  )
}

function findDescendant(parent: Box, path: readonly string[]): Box | null {
  let current = parent
  for (const type of path) {
    const next = childBoxes(current).find((box) => box.type === type)
    if (next === undefined) return null
    current = next
  }
  return current
}

function mediaTimescale(moov: Box): number | null {
  for (const trak of childBoxes(moov).filter((box) => box.type === 'trak')) {
    const hdlr = findDescendant(trak, ['mdia', 'hdlr'])
    if (hdlr === null) continue
    const handlerOffset = hdlr.headerSize + 8
    if (ascii(hdlr.bytes, handlerOffset, 4) !== 'vide') continue
    const mdhd = findDescendant(trak, ['mdia', 'mdhd'])
    if (mdhd === null) continue
    const version = mdhd.bytes[mdhd.headerSize] ?? 0
    const timescaleOffset = mdhd.headerSize + (version === 1 ? 20 : 12)
    if (mdhd.bytes.byteLength < timescaleOffset + 4) return null
    const value = new DataView(
      mdhd.bytes.buffer,
      mdhd.bytes.byteOffset + timescaleOffset,
      4,
    ).getUint32(0)
    return value > 0 ? value : null
  }
  return null
}

/** mvex/trex defaults used when neither tfhd nor trun carries sample duration. */
function trackDefaultSampleDurations(moov: Box): ReadonlyMap<number, number> {
  const defaults = new Map<number, number>()
  const mvex = childBoxes(moov).find((box) => box.type === 'mvex')
  if (mvex === undefined) return defaults
  for (const trex of childBoxes(mvex).filter((box) => box.type === 'trex')) {
    const trackIdOffset = trex.headerSize + 4
    const durationOffset = trex.headerSize + 12
    if (durationOffset + 4 > trex.bytes.byteLength) continue
    const view = new DataView(
      trex.bytes.buffer,
      trex.bytes.byteOffset,
      trex.bytes.byteLength,
    )
    const trackId = view.getUint32(trackIdOffset)
    const duration = view.getUint32(durationOffset)
    if (trackId > 0 && duration > 0) defaults.set(trackId, duration)
  }
  return defaults
}

function embeddedCodecConfiguration(trak: Box): string | null {
  const bytes = trak.bytes
  for (let typeOffset = 4; typeOffset + 4 <= bytes.byteLength; typeOffset += 1) {
    const type = ascii(bytes, typeOffset, 4)
    if (!CODEC_CONFIGURATION_BOXES.has(type)) continue
    const start = typeOffset - 4
    const size = new DataView(
      bytes.buffer,
      bytes.byteOffset + start,
      4,
    ).getUint32(0)
    if (size < 8 || start + size > bytes.byteLength) continue
    const boxBytes = bytes.subarray(start, start + size)
    let hex = ''
    for (const value of boxBytes) hex += value.toString(16).padStart(2, '0')
    return `${type}:${hex}`
  }
  return null
}

/**
 * Fragment track ids and codec private data must match the moov prepended to
 * the assembled replay. A recorder restart normally reproduces both; if the
 * encoder renegotiates, keeping old fragments would create a corrupt MP4.
 */
function initializationCompatibilityKey(moov: Box): string | null {
  for (const trak of childBoxes(moov).filter((box) => box.type === 'trak')) {
    const hdlr = findDescendant(trak, ['mdia', 'hdlr'])
    if (hdlr === null) continue
    if (ascii(hdlr.bytes, hdlr.headerSize + 8, 4) !== 'vide') continue
    const tkhd = childBoxes(trak).find((box) => box.type === 'tkhd')
    let trackId: number | null = null
    if (tkhd !== undefined) {
      const version = tkhd.bytes[tkhd.headerSize] ?? 0
      const trackIdOffset = tkhd.headerSize + (version === 1 ? 20 : 12)
      if (trackIdOffset + 4 <= tkhd.bytes.byteLength) {
        trackId = new DataView(
          tkhd.bytes.buffer,
          tkhd.bytes.byteOffset + trackIdOffset,
          4,
        ).getUint32(0)
      }
    }
    const codec = embeddedCodecConfiguration(trak)
    return trackId === null && codec === null
      ? null
      : `${trackId ?? 'unknown'}|${codec ?? 'unknown'}`
  }
  return null
}

function headerTimescale(
  data: Uint8Array<ArrayBufferLike>,
  box: LocatedBox,
): number | null {
  if (box.type !== 'mvhd' && box.type !== 'mdhd') return null
  const versionOffset = box.start + box.headerSize
  if (versionOffset + 4 > box.end) return null
  const version = data[versionOffset] ?? 0
  if (version !== 0 && version !== 1) return null
  const offset = versionOffset + (version === 1 ? 20 : 12)
  if (offset + 4 > box.end) return null
  const timescale = new DataView(
    data.buffer,
    data.byteOffset + offset,
    4,
  ).getUint32(0)
  return timescale > 0 ? timescale : null
}

function scaledDuration(
  durationTicks: bigint,
  sourceTimescale: number,
  targetTimescale: number,
): bigint {
  const source = BigInt(sourceTimescale)
  const target = BigInt(targetTimescale)
  // Round to the nearest target tick. Replays are seconds long and the source
  // is a video clock, so this remains exact for Chromium's ordinary 15 kHz /
  // 1 kHz pair while avoiding a systematically short movie header elsewhere.
  return (durationTicks * target + source / 2n) / source
}

function millisecondsToTicks(milliseconds: number, timescale: number): bigint {
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds <= 0 ||
    !Number.isFinite(timescale) ||
    timescale <= 0
  ) {
    return 0n
  }
  return BigInt(Math.round((milliseconds * timescale) / 1_000))
}

interface ObservedFragmentTimeline {
  decodeTimes: bigint[]
  durationTicks: bigint
  /** One per recorder session, in order. Diagnostics only. */
  verdicts: TfdtVerdict[]
}

/**
 * A SOURCE THAT STOPPED PRODUCING IS NOT A RECORDING THAT RAN FAST (#116).
 *
 * Whether one recorder session's `tfdt` may be believed. Believing a bad one
 * would place frames at wildly wrong times, which is worse than compressing
 * them because a compression is visible in the duration and a bad placement is
 * not. So the test is strict and the fallback is the arithmetic that shipped:
 *
 *  - every fragment in the session carried a `tfdt` (a mixed session is refused
 *    whole rather than half-placed);
 *  - they never go backwards;
 *  - and the span they claim does not exceed the wall time the ring watched
 *    these blobs ARRIVE over, which is an independent clock.
 */
const TFDT_WALL_TOLERANCE_MS = 1_000

/**
 * Why a session's `tfdt` was or was not believed — the whole verdict, not a
 * boolean.
 *
 * A silent refusal here is indistinguishable from success: the output is a
 * compressed replay either way, and no one downstream can tell whether the
 * evidence was missing, contradictory, or simply never consulted. That already
 * cost one release. The reason travels with the answer.
 */
type TfdtVerdict =
  | { trusted: true; claimedMs: number; wallSpanMs: number }
  | {
      trusted: false
      reason: 'empty' | 'no-timescale' | 'missing-tfdt' | 'went-backwards' | 'outruns-wall'
      claimedMs: number | null
      wallSpanMs: number
    }

function sessionTfdtVerdict(
  session: readonly StoredFragment[],
  wallSpanMs: number,
): TfdtVerdict {
  const first = session[0]
  const last = session[session.length - 1]
  if (first === undefined || last === undefined) {
    return { trusted: false, reason: 'empty', claimedMs: null, wallSpanMs }
  }
  if (first.timescale <= 0) {
    return { trusted: false, reason: 'no-timescale', claimedMs: null, wallSpanMs }
  }
  let previous: bigint | null = null
  for (const fragment of session) {
    const ticks = fragment.sourceDecodeTicks
    if (ticks === null) {
      return { trusted: false, reason: 'missing-tfdt', claimedMs: null, wallSpanMs }
    }
    if (previous !== null && ticks < previous) {
      return { trusted: false, reason: 'went-backwards', claimedMs: null, wallSpanMs }
    }
    previous = ticks
  }
  const firstTicks = first.sourceDecodeTicks
  const lastTicks = last.sourceDecodeTicks
  if (firstTicks === null || lastTicks === null) {
    return { trusted: false, reason: 'missing-tfdt', claimedMs: null, wallSpanMs }
  }
  const claimedMs = (Number(lastTicks - firstTicks) * 1_000) / first.timescale
  if (claimedMs > wallSpanMs + TFDT_WALL_TOLERANCE_MS) {
    return { trusted: false, reason: 'outruns-wall', claimedMs, wallSpanMs }
  }
  return { trusted: true, claimedMs, wallSpanMs }
}

/**
 * The wall time a session's `tfdt` is allowed to have covered.
 *
 * ANCHORED AT THE SESSION'S START, NOT AT THE FIRST RETAINED FRAGMENT (#116).
 *
 * The claim and the wall reference must begin at the same instant, and for a
 * while they did not. `claimedMs` starts at the first fragment's FIRST SAMPLE —
 * that is what its `tfdt` is. The delivery of that fragment happens when it
 * CLOSES, and Chromium closes a `moof` only at a key frame. On a quiet screen
 * one fragment therefore stays open for seconds while declaring a couple of
 * hundred milliseconds of media, so its delivery lands long after the sample it
 * is anchored to. Measuring the wall from that delivery subtracted the wait
 * from the reference but not from the claim, and the claim appeared to outrun
 * the wall by exactly the amount the screen had been still.
 *
 * Measured on CapturePack_2026-08-01_002541, one capture, two displays:
 *
 *   display 2, 14.8 fps   first fragment delivered 272 ms after its own first
 *                         sample; excess 126 ms; believed.
 *   display 1, 5.3 fps    first retained fragment delivered ~2019 ms after the
 *                         recorder started; excess 1456 ms against a 1000 ms
 *                         tolerance; REFUSED, and 12011 ms of desk was written
 *                         as 25 butt-joined fragments totalling 3696 ms.
 *
 * The error was therefore largest exactly where the evidence mattered most, and
 * absent where it did not matter at all. An earlier capture that appeared to
 * confirm the fix had passed with 53 ms of margin — luck, not correctness.
 *
 * The session's own start is the honest front anchor: a session's `tfdt` cannot
 * truthfully cover more time than that session has existed, and the instant it
 * began is a delivery instant like any other, so the guard stays independent of
 * the media clock. Raising the tolerance instead would not work — this capture
 * alone needed 2000 ms, and the amount is bounded only by how long a screen can
 * stay still.
 */
function sessionWallSpanMs(
  session: readonly StoredFragment[],
  sessionStartAtMs: number | undefined,
): number {
  let earliest = Number.POSITIVE_INFINITY
  let latest = Number.NEGATIVE_INFINITY
  for (const fragment of session) {
    if (fragment.deliveredAtMs < earliest) earliest = fragment.deliveredAtMs
    if (fragment.deliveredAtMs > latest) latest = fragment.deliveredAtMs
  }
  if (!Number.isFinite(latest)) return 0
  // No recorded start means the session began before this ring was watching.
  // Fall back to the fragments themselves, which is the stricter reading and
  // therefore the safe one: it refuses, it never over-trusts.
  const from =
    sessionStartAtMs === undefined || sessionStartAtMs > latest
      ? earliest
      : sessionStartAtMs
  if (!Number.isFinite(from)) return 0
  return Math.max(0, latest - from)
}

/**
 * Put recorder fragments on their observed timeline. A positive hole - whether
 * from a stop/restart or from a source that simply stopped producing frames -
 * stays a positive media PTS gap. Overlapping anchors never move decode time
 * backward.
 *
 * Inside one recorder session this butt-joined fragments, on the reasoning that
 * "BlobEvent delivery jitter is not a pixel gap" and encoded sample durations
 * are therefore authoritative. The first half is true. The second holds only
 * while the source keeps producing: when it starves, MediaRecorder emits
 * fragments whose encoded durations do not account for the wall time nobody
 * drew in, and both cases arrive down the same path.
 *
 * `tfdt` tells them apart, and always could. Measured on
 * CapturePack_2026-07-31_233324, one capture, two displays:
 *
 *   display 2, healthy  — encoder span 11972 ms, media 11917 ms.  Agree.
 *   display 1, starved  — encoder span 11908 ms, media  3501 ms.  8.4 s lost,
 *                         with the longest held frame just 72.2 ms, so the
 *                         sample durations do not carry it either. Only `tfdt`
 *                         ever knew, and 24 of 24 fragments carried one.
 */
function observedFragmentTimeline(
  fragments: readonly StoredFragment[],
  targetTimescale: number,
  sessionStarts: ReadonlyMap<number, number> = new Map(),
): ObservedFragmentTimeline {
  const first = fragments[0]
  if (first === undefined) {
    return { decodeTimes: [], durationTicks: 0n, verdicts: [] }
  }

  // Trust is decided per SESSION, over the whole session, before any fragment
  // is placed. A per-fragment decision could believe the first half of one
  // recording and disbelieve the second, putting a seam mid-session.
  const trusted = new Map<number, StoredFragment | null>()
  const verdicts: TfdtVerdict[] = []
  {
    let session: StoredFragment[] = []
    const settle = (): void => {
      const head = session[0]
      if (head === undefined) return
      const verdict = sessionTfdtVerdict(
        session,
        sessionWallSpanMs(session, sessionStarts.get(head.recorderSession)),
      )
      verdicts.push(verdict)
      trusted.set(head.recorderSession, verdict.trusted ? head : null)
    }
    for (const fragment of fragments) {
      const head = session[0]
      if (head !== undefined && head.recorderSession !== fragment.recorderSession) {
        settle()
        session = []
      }
      session.push(fragment)
    }
    settle()
  }

  const decodeTimes: bigint[] = []
  let previousEndTicks = 0n
  let previousSession = first.recorderSession
  // Where the current session's own clock is pinned on the output timeline.
  let sessionOriginTicks = 0n
  for (const fragment of fragments) {
    const sessionStart = trusted.get(fragment.recorderSession) ?? null
    const newSession = fragment.recorderSession !== previousSession
    // A fresh ftyp/moov is the observed boundary where stop/restart latency can
    // create a real hole; delivery time is the only clock that spans it,
    // because `tfdt` restarts at zero in every recorder session. Delivery on
    // BOTH sides - subtracting two back-dated starts would put one session's
    // media compression into the seam between two sessions.
    const boundaryTicks = millisecondsToTicks(
      fragment.deliveredAtMs - first.deliveredAtMs,
      targetTimescale,
    )
    if (newSession || decodeTimes.length === 0) {
      sessionOriginTicks =
        boundaryTicks > previousEndTicks ? boundaryTicks : previousEndTicks
    }
    const anchor = sessionStart?.sourceDecodeTicks ?? null
    let observedStartTicks: bigint
    if (anchor !== null) {
      const ticks = fragment.sourceDecodeTicks ?? anchor
      observedStartTicks =
        sessionOriginTicks +
        scaledDuration(
          ticks - anchor,
          fragment.timescale > 0 ? fragment.timescale : targetTimescale,
          targetTimescale,
        )
    } else if (newSession) {
      observedStartTicks = boundaryTicks
    } else {
      observedStartTicks = previousEndTicks
    }
    const decodeTime =
      observedStartTicks > previousEndTicks
        ? observedStartTicks
        : previousEndTicks
    decodeTimes.push(decodeTime)
    const durationTicks =
      fragment.timescale > 0
        ? scaledDuration(
            fragment.durationTicks,
            fragment.timescale,
            targetTimescale,
          )
        : millisecondsToTicks(fragment.durationMs, targetTimescale)
    previousEndTicks = decodeTime + durationTicks
    previousSession = fragment.recorderSession
  }
  return { decodeTimes, durationTicks: previousEndTicks, verdicts }
}

function patchHeaderDuration(
  data: Uint8Array<ArrayBufferLike>,
  box: LocatedBox,
  durationTicks: bigint,
  sourceTimescale: number,
  targetTimescale: number,
): void {
  const versionOffset = box.start + box.headerSize
  if (versionOffset + 4 > box.end) return
  const version = data[versionOffset] ?? 0
  if (version !== 0 && version !== 1) return
  const relativeOffset =
    box.type === 'mehd'
      ? 4
      : box.type === 'tkhd'
      ? (version === 1 ? 28 : 20)
      : (version === 1 ? 24 : 16)
  const durationOffset = versionOffset + relativeOffset
  const duration = scaledDuration(durationTicks, sourceTimescale, targetTimescale)
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (version === 1) {
    if (durationOffset + 8 <= box.end) view.setBigUint64(durationOffset, duration)
    return
  }
  if (durationOffset + 4 > box.end) return
  // A version-0 header cannot represent more than 2^32-1 ticks. The replay
  // ring is normally only seconds long, but saturating keeps a pathological
  // external timescale valid instead of wrapping it to a much shorter value.
  const finite = duration > 0xffff_ffffn ? 0xffff_ffffn : duration
  view.setUint32(durationOffset, Number(finite))
}

/**
 * MediaRecorder starts each session with a fresh moov whose native durations
 * describe only that session (and Chromium may even write mdhd in movie-clock
 * units). A replay assembled from several sessions needs one coherent header:
 * mvhd/tkhd/mehd use the movie timescale; every mdhd uses its own media
 * timescale.
 */
function patchInitializationTimeline(
  initialization: Uint8Array<ArrayBufferLike>,
  durationTicks: bigint,
  sourceTimescale: number,
): void {
  const result = initialization
  let offset = 0
  let moov: LocatedBox | null = null
  while (offset < result.byteLength) {
    const box = locatedBoxAt(result, offset)
    if (box === null) break
    if (box.type === 'moov') moov = box
    offset = box.end
  }
  if (moov === null) return

  const moovChildren = locatedChildren(result, moov)
  const mvhd = moovChildren.find((box) => box.type === 'mvhd')
  const movieTimescale = mvhd === undefined ? null : headerTimescale(result, mvhd)
  if (mvhd !== undefined && movieTimescale !== null) {
    patchHeaderDuration(result, mvhd, durationTicks, sourceTimescale, movieTimescale)
  }
  const mvex = moovChildren.find((box) => box.type === 'mvex')
  const mehd =
    mvex === undefined
      ? undefined
      : locatedChildren(result, mvex).find((box) => box.type === 'mehd')
  if (mehd !== undefined && movieTimescale !== null) {
    patchHeaderDuration(result, mehd, durationTicks, sourceTimescale, movieTimescale)
  }

  for (const trak of moovChildren.filter((box) => box.type === 'trak')) {
    const trakChildren = locatedChildren(result, trak)
    const tkhd = trakChildren.find((box) => box.type === 'tkhd')
    if (tkhd !== undefined && movieTimescale !== null) {
      patchHeaderDuration(result, tkhd, durationTicks, sourceTimescale, movieTimescale)
    }
    const mdia = trakChildren.find((box) => box.type === 'mdia')
    if (mdia === undefined) continue
    const mdhd = locatedChildren(result, mdia).find((box) => box.type === 'mdhd')
    if (mdhd === undefined) continue
    const mediaHeaderTimescale = headerTimescale(result, mdhd)
    if (mediaHeaderTimescale !== null) {
      patchHeaderDuration(
        result,
        mdhd,
        durationTicks,
        sourceTimescale,
        mediaHeaderTimescale,
      )
    }
  }
}

/**
 * The `tfdt` a `moof` arrived carrying, or null. Read at ingest, BEFORE
 * `patchFragmentTimeline` overwrites it on the way out.
 *
 * Multiple `traf` boxes are a multi-track fragment; the earliest decode time is
 * taken so box order cannot change the answer.
 */
function fragmentDecodeTicks(moof: Box): bigint | null {
  let earliest: bigint | null = null
  for (const traf of childBoxes(moof).filter((box) => box.type === 'traf')) {
    const tfdt = childBoxes(traf).find((box) => box.type === 'tfdt')
    if (tfdt === undefined) continue
    const version = tfdt.bytes[tfdt.headerSize] ?? 0
    const valueOffset = tfdt.headerSize + 4
    const view = new DataView(
      tfdt.bytes.buffer,
      tfdt.bytes.byteOffset,
      tfdt.bytes.byteLength,
    )
    let value: bigint
    if (version === 1) {
      if (valueOffset + 8 > tfdt.bytes.byteLength) continue
      value = view.getBigUint64(valueOffset)
    } else {
      if (valueOffset + 4 > tfdt.bytes.byteLength) continue
      value = BigInt(view.getUint32(valueOffset))
    }
    if (earliest === null || value < earliest) earliest = value
  }
  return earliest
}

/** The longest single sample in a `moof`, and how many samples it declares. */
function fragmentSampleExtent(
  moof: Box,
  trackDefaults: ReadonlyMap<number, number> = EMPTY_TRACK_DEFAULT_DURATIONS,
): { count: number; maxDurationTicks: number } {
  let count = 0
  let maxDurationTicks = 0
  for (const traf of childBoxes(moof).filter((box) => box.type === 'traf')) {
    const tfhd = childBoxes(traf).find((box) => box.type === 'tfhd')
    let defaultDuration = 0
    if (tfhd !== undefined) {
      const flags = fullBoxFlags(tfhd)
      const trackIdOffset = tfhd.headerSize + 4
      if (trackIdOffset + 4 <= tfhd.bytes.byteLength) {
        const trackId = new DataView(
          tfhd.bytes.buffer,
          tfhd.bytes.byteOffset + trackIdOffset,
          4,
        ).getUint32(0)
        defaultDuration = trackDefaults.get(trackId) ?? 0
      }
      let cursor = tfhd.headerSize + 8
      if ((flags & 0x000001) !== 0) cursor += 8
      if ((flags & 0x000002) !== 0) cursor += 4
      if ((flags & 0x000008) !== 0 && tfhd.bytes.byteLength >= cursor + 4) {
        defaultDuration = new DataView(
          tfhd.bytes.buffer,
          tfhd.bytes.byteOffset + cursor,
          4,
        ).getUint32(0)
      }
    }
    for (const trun of childBoxes(traf).filter((box) => box.type === 'trun')) {
      const flags = fullBoxFlags(trun)
      const view = new DataView(
        trun.bytes.buffer,
        trun.bytes.byteOffset,
        trun.bytes.byteLength,
      )
      let cursor = trun.headerSize + 4
      if (cursor + 4 > trun.bytes.byteLength) continue
      const sampleCount = view.getUint32(cursor)
      cursor += 4
      if ((flags & 0x000001) !== 0) cursor += 4
      if ((flags & 0x000004) !== 0) cursor += 4
      for (let index = 0; index < sampleCount; index += 1) {
        let duration = defaultDuration
        if ((flags & 0x000100) !== 0) {
          if (cursor + 4 > trun.bytes.byteLength) break
          duration = view.getUint32(cursor)
          cursor += 4
        }
        if ((flags & 0x000200) !== 0) cursor += 4
        if ((flags & 0x000400) !== 0) cursor += 4
        if ((flags & 0x000800) !== 0) cursor += 4
        count += 1
        if (duration > maxDurationTicks) maxDurationTicks = duration
      }
    }
  }
  return { count, maxDurationTicks }
}

function fragmentDurationTicks(
  moof: Box,
  trackDefaults: ReadonlyMap<number, number> = EMPTY_TRACK_DEFAULT_DURATIONS,
): bigint {
  let total = 0n
  for (const traf of childBoxes(moof).filter((box) => box.type === 'traf')) {
    const tfhd = childBoxes(traf).find((box) => box.type === 'tfhd')
    let defaultDuration = 0
    if (tfhd !== undefined) {
      const flags = fullBoxFlags(tfhd)
      const trackIdOffset = tfhd.headerSize + 4
      if (trackIdOffset + 4 <= tfhd.bytes.byteLength) {
        const trackId = new DataView(
          tfhd.bytes.buffer,
          tfhd.bytes.byteOffset + trackIdOffset,
          4,
        ).getUint32(0)
        defaultDuration = trackDefaults.get(trackId) ?? 0
      }
      let cursor = tfhd.headerSize + 8
      if ((flags & 0x000001) !== 0) cursor += 8
      if ((flags & 0x000002) !== 0) cursor += 4
      if ((flags & 0x000008) !== 0 && tfhd.bytes.byteLength >= cursor + 4) {
        defaultDuration = new DataView(
          tfhd.bytes.buffer,
          tfhd.bytes.byteOffset + cursor,
          4,
        ).getUint32(0)
      }
    }
    for (const trun of childBoxes(traf).filter((box) => box.type === 'trun')) {
      const flags = fullBoxFlags(trun)
      let cursor = trun.headerSize + 4
      if (trun.bytes.byteLength < cursor + 4) continue
      const view = new DataView(trun.bytes.buffer, trun.bytes.byteOffset, trun.bytes.byteLength)
      const sampleCount = view.getUint32(cursor)
      cursor += 4
      if ((flags & 0x000001) !== 0) cursor += 4
      if ((flags & 0x000004) !== 0) cursor += 4
      for (let i = 0; i < sampleCount; i += 1) {
        const duration =
          (flags & 0x000100) !== 0 && trun.bytes.byteLength >= cursor + 4
            ? view.getUint32(cursor)
            : defaultDuration
        total += BigInt(duration)
        if ((flags & 0x000100) !== 0) cursor += 4
        if ((flags & 0x000200) !== 0) cursor += 4
        if ((flags & 0x000400) !== 0) cursor += 4
        if ((flags & 0x000800) !== 0) cursor += 4
        if (cursor > trun.bytes.byteLength) break
      }
    }
  }
  return total
}

function patchFragmentTimeline(
  bytes: Uint8Array<ArrayBufferLike>,
  decodeTime: bigint,
  sequenceNumber: number,
  sourceTimescale: number,
  targetTimescale: number,
): void {
  const result = bytes
  const moof = boxAt(result, 0)
  if (moof === null || moof.box.type !== 'moof') return
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength)
  const rescale = (value: number, positive: boolean): number => {
    if (sourceTimescale <= 0 || targetTimescale <= 0 || sourceTimescale === targetTimescale) {
      return value
    }
    const scaled = Math.round((value * targetTimescale) / sourceTimescale)
    return Math.min(0xffff_ffff, Math.max(positive && value > 0 ? 1 : 0, scaled))
  }
  let trafOffset = moof.box.headerSize
  while (trafOffset < moof.next) {
    const traf = boxAt(result, trafOffset)
    if (traf === null) break
    trafOffset = traf.next
    if (traf.box.type === 'mfhd') {
      const sequenceOffset = traf.next - traf.box.bytes.byteLength + traf.box.headerSize + 4
      if (sequenceOffset + 4 <= result.byteLength) {
        view.setUint32(sequenceOffset, sequenceNumber)
      }
      continue
    }
    if (traf.box.type !== 'traf') continue
    let childOffset = trafOffset - traf.box.bytes.byteLength + traf.box.headerSize
    while (childOffset < traf.next) {
      const child = boxAt(result, childOffset)
      if (child === null) break
      childOffset = child.next
      const childStart = child.next - child.box.bytes.byteLength
      if (child.box.type === 'tfdt') {
        const valueOffset = childStart + child.box.headerSize + 4
        const version = result[childStart + child.box.headerSize] ?? 0
        if (version === 1 && valueOffset + 8 <= result.byteLength) {
          view.setBigUint64(valueOffset, decodeTime)
        } else if (valueOffset + 4 <= result.byteLength) {
          view.setUint32(valueOffset, Number(decodeTime & 0xffff_ffffn))
        }
        continue
      }
      if (sourceTimescale === targetTimescale || sourceTimescale <= 0 || targetTimescale <= 0) {
        continue
      }
      if (child.box.type === 'tfhd') {
        const flags = fullBoxFlags(child.box)
        let cursor = child.box.headerSize + 8
        if ((flags & 0x000001) !== 0) cursor += 8
        if ((flags & 0x000002) !== 0) cursor += 4
        const durationOffset = childStart + cursor
        if ((flags & 0x000008) !== 0 && durationOffset + 4 <= child.next) {
          view.setUint32(durationOffset, rescale(view.getUint32(durationOffset), true))
        }
        continue
      }
      if (child.box.type !== 'trun') continue
      const flags = fullBoxFlags(child.box)
      const version = result[childStart + child.box.headerSize] ?? 0
      let cursor = childStart + child.box.headerSize + 4
      if (cursor + 4 > child.next) continue
      const sampleCount = view.getUint32(cursor)
      cursor += 4
      if ((flags & 0x000001) !== 0) cursor += 4
      if ((flags & 0x000004) !== 0) cursor += 4
      for (let index = 0; index < sampleCount; index += 1) {
        if ((flags & 0x000100) !== 0) {
          if (cursor + 4 > child.next) break
          view.setUint32(cursor, rescale(view.getUint32(cursor), true))
          cursor += 4
        }
        if ((flags & 0x000200) !== 0) cursor += 4
        if ((flags & 0x000400) !== 0) cursor += 4
        if ((flags & 0x000800) !== 0) {
          if (cursor + 4 > child.next) break
          if (version === 0) {
            view.setUint32(cursor, rescale(view.getUint32(cursor), false))
          } else {
            const scaled = Math.round(
              (view.getInt32(cursor) * targetTimescale) / sourceTimescale,
            )
            view.setInt32(cursor, Math.min(0x7fff_ffff, Math.max(-0x8000_0000, scaled)))
          }
          cursor += 4
        }
        if (cursor > child.next) break
      }
    }
  }
}

/**
 * Holds no MediaRecorder and no Blob references; only bounded byte arrays.
 * Blob backing stores can therefore be released as soon as each event is read.
 */
export class FragmentedMp4Ring {
  private pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
  private initializationParts: Uint8Array<ArrayBufferLike>[] = []
  private initialization: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
  private awaitingInitializationMoov = false
  private currentFragmentParts: Uint8Array<ArrayBufferLike>[] = []
  private currentFragmentDurationTicks = 0n
  private readonly sessionStartAtMs = new Map<number, number>()
  private lastAssembly: FragmentedMp4RingAssembly | null = null
  private currentFragmentDecodeTicks: bigint | null = null
  private currentFragmentSamples: { count: number; maxDurationTicks: number } = {
    count: 0,
    maxDurationTicks: 0,
  }
  private fragments: StoredFragment[] = []
  private timescale = 0
  private trackDefaultDurations: ReadonlyMap<number, number> =
    EMPTY_TRACK_DEFAULT_DURATIONS
  private initializationCompatibility: string | null = null
  private recorderSession = 0
  private readonly maxRetainedBytes: number
  private readonly maxWorkingSetBytes: number

  constructor(
    private readonly retentionMs: number,
    videoBitsPerSecond = DEFAULT_VIDEO_BITS_PER_SECOND,
  ) {
    // Chromium may buffer one whole maintenance session until stop(). At the
    // supported 600 s / 6 Mbps maximum that is about 450 MB, so a small fixed
    // parser cap would reject valid footage. Keep encoder-rate headroom, then
    // cover the three-copy split-box edge (old prefix + parser concat + stored
    // fragment). This bounds the whole ring working set, not merely `pending`.
    const nominalBytes =
      (Math.max(0, retentionMs) * Math.max(0, videoBitsPerSecond)) / 8_000
    const desiredRetainedBytes = Math.max(
      MIN_RETAINED_MEDIA_BYTES,
      Math.ceil(nominalBytes * ENCODER_BITRATE_HEADROOM) +
        PARSER_CONTAINER_HEADROOM_BYTES,
    )
    this.maxWorkingSetBytes = Math.min(
      MAX_WORKING_SET_BYTES,
      desiredRetainedBytes * TRANSIENT_COPY_MULTIPLIER,
    )
    this.maxRetainedBytes = Math.min(
      desiredRetainedBytes,
      Math.floor(
        this.maxWorkingSetBytes / TRANSIENT_COPY_MULTIPLIER,
      ),
    )
  }

  clear(): void {
    this.pending = new Uint8Array(0)
    this.initializationParts = []
    this.initialization = new Uint8Array(0)
    this.awaitingInitializationMoov = false
    this.currentFragmentParts = []
    this.currentFragmentDurationTicks = 0n
    this.fragments = []
    this.timescale = 0
    this.trackDefaultDurations = EMPTY_TRACK_DEFAULT_DURATIONS
    this.initializationCompatibility = null
    this.recorderSession = 0
  }

  pushBytes(data: Uint8Array<ArrayBufferLike>, endAtMs: number): number {
    if (data.byteLength === 0) return 0
    const committedInitialization = this.initialization
    const committedTimescale = this.timescale
    const committedTrackDefaultDurations = this.trackDefaultDurations
    const committedInitializationCompatibility = this.initializationCompatibility
    const committedRecorderSession = this.recorderSession
    let resetFragmentsForInitialization = false
    const completed: Array<{
      bytes: Uint8Array<ArrayBufferLike>
      durationTicks: bigint
      timescale: number
      durationMs: number
      recorderSession: number
      sourceDecodeTicks: bigint | null
      sampleCount: number
      maxSampleDurationTicks: number
    }> = []
    let consumed = 0
    try {
      this.prune(endAtMs)
      const combinedBytes = this.pending.byteLength + data.byteLength
      if (combinedBytes > this.maxRetainedBytes) {
        throw new Error('MP4 parser pending bytes exceed memory budget')
      }
      this.makeRoomForIncoming(combinedBytes)
      // Capture passes a fresh Uint8Array backed by Blob.arrayBuffer(). Taking
      // ownership when no prefix is pending avoids copying an entire recorder
      // session before parsing it.
      this.pending =
        this.pending.byteLength === 0 ? data : concatBytes([this.pending, data])

      while (consumed < this.pending.byteLength) {
        const parsed = boxAt(
          this.pending,
          consumed,
          this.maxRetainedBytes,
        )
        if (parsed === null) break
        consumed = parsed.next
        const { box } = parsed
        if (box.type === 'ftyp') {
          this.initializationParts = [box.bytes.slice()]
          this.awaitingInitializationMoov = true
          this.currentFragmentParts = []
          this.currentFragmentDurationTicks = 0n
          continue
        }
        if (box.type === 'moov') {
          if (!this.awaitingInitializationMoov) continue
          this.initialization = concatBytes([...this.initializationParts, box.bytes])
          this.initializationParts = []
          this.timescale = mediaTimescale(box) ?? this.timescale
          this.trackDefaultDurations = trackDefaultSampleDurations(box)
          const compatibility = initializationCompatibilityKey(box)
          resetFragmentsForInitialization =
            resetFragmentsForInitialization ||
            (this.initializationCompatibility !== null &&
              compatibility !== null &&
              this.initializationCompatibility !== compatibility)
          this.initializationCompatibility = compatibility
          this.recorderSession += 1
          // The instant this recorder session began, on the delivery clock.
          // Its own first fragment cannot be delivered before this, which is
          // what makes it a usable front anchor when that fragment is late.
          this.sessionStartAtMs.set(this.recorderSession, endAtMs)
          this.awaitingInitializationMoov = false
          continue
        }
        if (box.type === 'moof') {
          // A split mdat may leave this part alive after `pending` is trimmed.
          // Copy the small moof so its view cannot pin the whole input Blob.
          this.currentFragmentParts = [box.bytes.slice()]
          this.currentFragmentDurationTicks = fragmentDurationTicks(
            box,
            this.trackDefaultDurations,
          )
          this.currentFragmentDecodeTicks = fragmentDecodeTicks(box)
          this.currentFragmentSamples = fragmentSampleExtent(
            box,
            this.trackDefaultDurations,
          )
          continue
        }
        if (this.currentFragmentParts.length > 0) {
          if (box.type === 'mdat') {
            const durationTicks = this.currentFragmentDurationTicks
            const durationMs =
              this.timescale > 0 ? (Number(durationTicks) * 1000) / this.timescale : 0
            completed.push({
              bytes: concatBytes([...this.currentFragmentParts, box.bytes]),
              durationTicks,
              timescale: this.timescale,
              durationMs,
              recorderSession: this.recorderSession,
              sourceDecodeTicks: this.currentFragmentDecodeTicks,
              sampleCount: this.currentFragmentSamples.count,
              maxSampleDurationTicks: this.currentFragmentSamples.maxDurationTicks,
            })
            this.currentFragmentParts = []
            this.currentFragmentDurationTicks = 0n
          } else {
            // Non-mdat boxes between moof and mdat are normally tiny. Copying
            // them prevents a retained view from pinning the full input Blob.
            this.currentFragmentParts.push(box.bytes.slice())
          }
        } else if (
          this.awaitingInitializationMoov &&
          INITIALIZATION_AUXILIARY_BOXES.has(box.type)
        ) {
          this.initializationParts.push(box.bytes.slice())
        }
      }
    } catch (error) {
      // The ingest queue logs the error and keeps accepting later recorder
      // sessions. Retaining the bad prefix made each later Blob reparse the
      // same impossible box while concatenating more bytes behind it forever.
      // Preserve committed history, but discard uncommitted parser state so a
      // later ftyp/moov can heal the stream.
      this.pending = new Uint8Array(0)
      this.initializationParts = []
      this.initialization = committedInitialization
      this.awaitingInitializationMoov = false
      this.currentFragmentParts = []
      this.currentFragmentDurationTicks = 0n
      this.timescale = committedTimescale
      this.trackDefaultDurations = committedTrackDefaultDurations
      this.initializationCompatibility = committedInitializationCompatibility
      this.recorderSession = committedRecorderSession
      throw error
    }
    this.pending =
      consumed === 0
        ? this.pending
        : consumed === this.pending.byteLength
          ? new Uint8Array(0)
          : this.pending.slice(consumed)

    let cursor = endAtMs
    const timed: StoredFragment[] = []
    for (let i = completed.length - 1; i >= 0; i -= 1) {
      const fragment = completed[i]
      if (fragment === undefined) continue
      const durationMs = Math.max(1, fragment.durationMs)
      timed.push({
        ...fragment,
        durationMs,
        startAtMs: cursor - durationMs,
        endAtMs: cursor,
        // The instant this blob was HANDED to the ring. startAtMs is not that:
        // fragments sharing one blob are back-dated from here by their media
        // durations, which mixes delivery time with the media clock.
        deliveredAtMs: endAtMs,
      })
      cursor -= durationMs
    }
    timed.reverse()
    if (resetFragmentsForInitialization) this.fragments = []
    this.fragments.push(...timed)
    this.prune(endAtMs)
    this.pruneToRetainedBudget()
    this.forgetUnusedSessions()
    return completed.length
  }

  assemble(endAtMs: number): FragmentedMp4Replay | null {
    if (this.initialization.byteLength === 0 || this.timescale <= 0) return null
    const cutoff = endAtMs - this.retentionMs
    // A moof/mdat is the smallest independently muxed unit we can preserve
    // without parsing sample tables, finding a keyframe and rewriting both the
    // trun and mdat. Including the first fragment merely because it overlaps
    // `cutoff` made an off-boundary 30 s replay physically expose as much as
    // 59 s of pixels. Keep only whole fragments inside the requested window.
    // This may return slightly less than N when the muxer emits coarse
    // fragments, but it never guesses at media boundaries or relies on a later
    // background exact-cut to remove already-persisted private footage.
    const candidates = this.fragments.filter(
      (fragment) =>
        fragment.startAtMs >= cutoff && fragment.endAtMs <= endAtMs,
    )
    let selectedDurationMs = 0
    let selectedStart = candidates.length
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const fragment = candidates[index]
      if (
        fragment === undefined ||
        selectedDurationMs + fragment.durationMs > this.retentionMs
      ) {
        break
      }
      selectedDurationMs += fragment.durationMs
      selectedStart = index
    }
    let selected = candidates.slice(selectedStart)
    let timeline = observedFragmentTimeline(
      selected,
      this.timescale,
      this.sessionStartAtMs,
    )
    // WHAT THE HONEST TIMELINE COSTS AT THE PRIVACY WINDOW (#116).
    //
    // This loop barely fired while the timeline was the compressed sum. Now it
    // is the real span, so a starved display - whose media is short but whose
    // WALL time is long - can exceed the configured window and be trimmed from
    // the front by a rule written for a different quantity. Recorded so the
    // difference between "refused the evidence" and "trimmed for privacy" is
    // visible, because the output looks identical.
    const timelineBeforeRetentionTicks = timeline.durationTicks
    const selectedBeforeRetention = selected.length
    const retentionTicks = millisecondsToTicks(this.retentionMs, this.timescale)
    // A delayed session can add a real wall gap even when fragment durations
    // alone fit N. Keep the newest complete suffix whose actual encoded
    // timeline, including that gap, remains inside the configured privacy
    // window.
    while (
      selected.length > 0 &&
      timeline.durationTicks > retentionTicks
    ) {
      selected = selected.slice(1)
      timeline = observedFragmentTimeline(
        selected,
        this.timescale,
        this.sessionStartAtMs,
      )
    }
    this.lastAssembly = {
      retentionMs: this.retentionMs,
      selectedBeforeRetention,
      selectedAfterRetention: selected.length,
      timelineBeforeRetentionMs: Math.round(
        (Number(timelineBeforeRetentionTicks) * 1_000) / this.timescale,
      ),
      verdicts: timeline.verdicts,
    }
    if (selected.length === 0) return null
    const totalBytes =
      this.initialization.byteLength +
      selected.reduce((sum, fragment) => sum + fragment.bytes.byteLength, 0)
    // `bytes` is the one replay output allocation. Keep it inside the same
    // integrated budget as ingest instead of allowing retained+output to peak
    // independently at the renderer's memory limit.
    if (this.stats().retainedBytes + totalBytes > this.maxWorkingSetBytes) {
      return null
    }
    const bytes = new Uint8Array(totalBytes)
    let writeOffset = this.initialization.byteLength
    selected.forEach((fragment, index) => {
      const decodeTime = timeline.decodeTimes[index] ?? 0n
      const patched = bytes.subarray(
        writeOffset,
        writeOffset + fragment.bytes.byteLength,
      )
      patched.set(fragment.bytes)
      patchFragmentTimeline(
        patched,
        decodeTime,
        index + 1,
        fragment.timescale,
        this.timescale,
      )
      writeOffset += fragment.bytes.byteLength
    })
    const initialization = bytes.subarray(0, this.initialization.byteLength)
    initialization.set(this.initialization)
    patchInitializationTimeline(
      initialization,
      timeline.durationTicks,
      this.timescale,
    )
    const durationMs =
      (Number(timeline.durationTicks) * 1_000) / this.timescale
    return {
      buffer: bytes.buffer,
      durationMs: Math.max(1, Math.round(durationMs)),
      startAtMs: selected[0]?.startAtMs ?? endAtMs,
      endAtMs: selected[selected.length - 1]?.endAtMs ?? endAtMs,
      fragmentCount: selected.length,
    }
  }

  stats(): FragmentedMp4RingStats {
    return {
      fragmentCount: this.fragments.length,
      retainedBytes: this.pending.byteLength + this.retainedBytesWithoutPending(),
      retainedDurationMs: this.fragments.reduce((sum, fragment) => sum + fragment.durationMs, 0),
      retainedBudgetBytes: this.maxRetainedBytes,
      workingSetBudgetBytes: this.maxWorkingSetBytes,
      timing: this.timing(),
    }
  }

  /**
   * What the retained bytes say about their own timing (#116).
   *
   * `sourceSpanMs` is summed PER SESSION, because `tfdt` restarts at zero in
   * every recorder session and a span across that boundary would be nonsense.
   */
  private timing(): FragmentedMp4RingTiming {
    let sampleCount = 0
    let maxSampleDurationMs = 0
    let sourceSpanMs = 0
    let fragmentsWithSourceTime = 0
    const deliveries = new Set<number>()
    let sessionFirst: StoredFragment | null = null
    let sessionLast: StoredFragment | null = null
    const closeSession = (): void => {
      if (
        sessionFirst === null ||
        sessionLast === null ||
        sessionFirst.sourceDecodeTicks === null ||
        sessionLast.sourceDecodeTicks === null ||
        sessionFirst.timescale <= 0
      ) {
        return
      }
      const ticks = sessionLast.sourceDecodeTicks - sessionFirst.sourceDecodeTicks
      sourceSpanMs += (Number(ticks) * 1_000) / sessionFirst.timescale
    }
    for (const fragment of this.fragments) {
      sampleCount += fragment.sampleCount
      if (fragment.timescale > 0) {
        const ms = (fragment.maxSampleDurationTicks * 1_000) / fragment.timescale
        if (ms > maxSampleDurationMs) maxSampleDurationMs = ms
      }
      if (fragment.sourceDecodeTicks !== null) fragmentsWithSourceTime += 1
      deliveries.add(fragment.deliveredAtMs)
      if (
        sessionFirst === null ||
        sessionFirst.recorderSession !== fragment.recorderSession
      ) {
        closeSession()
        sessionFirst = fragment
      }
      sessionLast = fragment
    }
    closeSession()
    return {
      sampleCount,
      maxSampleDurationMs: Math.round(maxSampleDurationMs * 10) / 10,
      sourceSpanMs: Math.round(sourceSpanMs),
      fragmentsWithSourceTime,
      deliveryCount: deliveries.size,
      assembly: this.lastAssembly,
    }
  }

  /** A session nothing is retained from can be forgotten with its fragments. */
  private forgetUnusedSessions(): void {
    if (this.sessionStartAtMs.size <= 1) return
    const live = new Set(this.fragments.map((fragment) => fragment.recorderSession))
    live.add(this.recorderSession)
    for (const session of [...this.sessionStartAtMs.keys()]) {
      if (!live.has(session)) this.sessionStartAtMs.delete(session)
    }
  }

  private prune(endAtMs: number): void {
    const cutoff = endAtMs - this.retentionMs
    // ISO-BMFF does not impose a one-second minimum `moof` cadence. Pruning by
    // an assumed fragment count shortened a 30-second ring to 3.2 seconds when
    // the muxer emitted 100 ms fragments. Every stored duration is clamped to
    // at least 1 ms above, so time-based pruning still bounds references by the
    // configured retention window without discarding valid footage.
    while (this.fragments.length > 0 && this.fragments[0]!.endAtMs <= cutoff) {
      this.fragments.shift()
    }
  }

  private retainedBytesWithoutPending(): number {
    return (
      this.initializationParts.reduce((sum, part) => sum + part.byteLength, 0) +
      this.initialization.byteLength +
      this.currentFragmentParts.reduce((sum, part) => sum + part.byteLength, 0) +
      this.fragments.reduce((sum, fragment) => sum + fragment.bytes.byteLength, 0)
    )
  }

  /**
   * Ingest holds the incoming Blob bytes while copying a completed fragment.
   * Drop oldest retained fragments before that allocation when necessary, so
   * a valid new segment shortens coverage rather than crashing the renderer.
   */
  private makeRoomForIncoming(incomingBytes: number): void {
    let retainedBytes = this.retainedBytesWithoutPending()
    while (
      this.fragments.length > 0 &&
      (retainedBytes + incomingBytes > this.maxRetainedBytes ||
        retainedBytes + incomingBytes * TRANSIENT_COPY_MULTIPLIER >
          this.maxWorkingSetBytes)
    ) {
      const removed = this.fragments.shift()
      retainedBytes -= removed?.bytes.byteLength ?? 0
    }
    if (
      retainedBytes + incomingBytes > this.maxRetainedBytes ||
      retainedBytes + incomingBytes * TRANSIENT_COPY_MULTIPLIER >
        this.maxWorkingSetBytes
    ) {
      throw new Error('MP4 ingest exceeds renderer working-set budget')
    }
  }

  private pruneToRetainedBudget(): void {
    let retainedBytes = this.pending.byteLength + this.retainedBytesWithoutPending()
    while (this.fragments.length > 0 && retainedBytes > this.maxRetainedBytes) {
      const removed = this.fragments.shift()
      retainedBytes -= removed?.bytes.byteLength ?? 0
    }
  }
}
