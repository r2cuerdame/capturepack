import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  RECORDER_STOP_TIMEOUT_MS,
  REPLAY_ASSEMBLY_IPC_SLACK_MS,
  REPLAY_TIMEOUT_MS,
} from '../src/shared/captureTimeouts'
import { FragmentedMp4Ring } from '../src/renderer/capture/fragmentedMp4Ring'
import {
  mp4FragmentIntervalMs,
  pickRecorderFormat,
} from '../src/renderer/capture/recorderFormats'
import { ReplayResumeTokenLedger } from '../src/renderer/capture/replayResumeTokenLedger'
import {
  WebmDualSlotRing,
  type WebmDualSlotTimers,
} from '../src/renderer/capture/webmDualSlotRing'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

function checkReplayResumeTokenLedger(): void {
  console.log('\nReplay HOLD/RESUME reverse-order ownership')
  let now = 1_000
  const ledger = new ReplayResumeTokenLedger({
    maxEntries: 4,
    ttlMs: 1_000,
    now: () => now,
  })

  ledger.note('resume-before-hold', 7)
  check(
    'RESUME-before-HOLD is consumed exactly once by the matching generation',
    ledger.consume('resume-before-hold', 7) &&
      !ledger.consume('resume-before-hold', 7),
  )

  ledger.note('stale-generation', 8)
  check(
    'a late token from another generation cannot resume the current recorder',
    !ledger.consume('stale-generation', 9) && ledger.size === 0,
  )

  ledger.note('expired', 10)
  now += 1_001
  check(
    'a pre-resume token expires instead of retaining renderer ownership',
    !ledger.consume('expired', 10) && ledger.size === 0,
  )

  for (let index = 1; index <= 5; index += 1) {
    ledger.note(`bounded-${index}`, 11)
  }
  check(
    'the pre-resume ledger retains at most four newest request tokens',
    ledger.size === 4 &&
      !ledger.consume('bounded-1', 11) &&
      ledger.consume('bounded-2', 11),
    `${ledger.size}`,
  )
  ledger.clear()

  check(
    'normal FIFO has no pre-resume token and therefore leaves HOLD/watchdog ownership intact',
    !ledger.consume('normal-fifo', 12) && ledger.size === 0,
  )
  ledger.note('lost-resume', 12)
  ledger.clear()
  check(
    'teardown clears pre-resume tokens so a later generation keeps its watchdog',
    !ledger.consume('lost-resume', 12) && ledger.size === 0,
  )
}

checkReplayResumeTokenLedger()

function checkMp4FragmentIntervalPolicy(): void {
  check(
    '5 fps keeps three frames per MP4 fragment instead of an every-frame IDR',
    mp4FragmentIntervalMs(5) === 600,
  )
  check(
    '15 and 30 fps retain three frames per MP4 fragment',
    mp4FragmentIntervalMs(15) === 200 &&
      mp4FragmentIntervalMs(30) === 100,
  )
  check(
    'every supported FPS keeps a whole-fragment cutoff within three nominal frames',
    Array.from({ length: 26 }, (_, index) => index + 5).every((fps) =>
      mp4FragmentIntervalMs(fps) <= (3_000 / fps),
    ),
  )
}

checkMp4FragmentIntervalPolicy()

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value)
  return bytes
}

function u64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, value)
  return bytes
}

function text(value: string): Uint8Array {
  return Uint8Array.from([...value].map((character) => character.charCodeAt(0)))
}

function join(parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.byteLength
  }
  return bytes
}

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = join(payload)
  return join([u32(8 + body.byteLength), text(type), body])
}

function fullBoxVersion(version: 0 | 1): Uint8Array {
  return Uint8Array.from([version, 0, 0, 0])
}

function durationBytes(version: 0 | 1, value: bigint): Uint8Array {
  return version === 1 ? u64(value) : u32(Number(value))
}

function initialization(
  timescale = 15_000,
  movieTimescale = 1_000,
  version: 0 | 1 = 0,
  seedDuration = 1n,
  withFree = false,
  trexDefaultDuration: number | null = null,
  codecConfiguration: Uint8Array | null = null,
): Uint8Array {
  const mvhd = box(
    'mvhd',
    fullBoxVersion(version),
    version === 1 ? u64(0n) : u32(0),
    version === 1 ? u64(0n) : u32(0),
    u32(movieTimescale),
    durationBytes(version, seedDuration),
  )
  const tkhd = box(
    'tkhd',
    fullBoxVersion(version),
    version === 1 ? u64(0n) : u32(0),
    version === 1 ? u64(0n) : u32(0),
    u32(1),
    u32(0),
    durationBytes(version, seedDuration),
  )
  const mdhd = box(
    'mdhd',
    fullBoxVersion(version),
    version === 1 ? u64(0n) : u32(0),
    version === 1 ? u64(0n) : u32(0),
    u32(timescale),
    durationBytes(version, seedDuration),
  )
  const hdlr = box('hdlr', u32(0), u32(0), text('vide'))
  const mdia = box('mdia', mdhd, hdlr)
  const mehd = box('mehd', fullBoxVersion(version), durationBytes(version, seedDuration))
  const trex =
    trexDefaultDuration === null
      ? []
      : [
          box(
            'trex',
            fullBoxVersion(0),
            u32(1),
            u32(1),
            u32(trexDefaultDuration),
            u32(0),
            u32(0),
          ),
        ]
  const parts = [
    box('ftyp', text('isom')),
    ...(withFree ? [box('free', new Uint8Array(4))] : []),
    box(
      'moov',
      mvhd,
      box(
        'trak',
        tkhd,
        mdia,
        ...(codecConfiguration === null
          ? []
          : [box('avcC', codecConfiguration)]),
      ),
      box('mvex', mehd, ...trex),
    ),
  ]
  return join(parts)
}

function fragment(
  decodeTime: bigint,
  durationTicks = 150_000,
  payloadBytes = 16,
): Uint8Array {
  const tfhd = box('tfhd', Uint8Array.from([0, 0, 0, 8]), u32(1), u32(durationTicks))
  const tfdt = box('tfdt', Uint8Array.from([1, 0, 0, 0]), u64(decodeTime))
  const trun = box('trun', Uint8Array.from([0, 0, 1, 0]), u32(1), u32(durationTicks))
  return join([
    box('moof', box('mfhd', u32(0), u32(1)), box('traf', tfhd, tfdt, trun)),
    box('mdat', new Uint8Array(payloadBytes)),
  ])
}

/** A fragment whose `traf` carries no `tfdt` at all. */
function trexDurationFragmentWithoutTfdt(
  durationTicks = 15_000,
  payloadBytes = 16,
): Uint8Array {
  const tfhd = box('tfhd', Uint8Array.from([0, 0, 0, 8]), u32(1), u32(durationTicks))
  const trun = box('trun', Uint8Array.from([0, 0, 1, 0]), u32(1), u32(durationTicks))
  return join([
    box('moof', box('mfhd', u32(0), u32(1)), box('traf', tfhd, trun)),
    box('mdat', new Uint8Array(payloadBytes)),
  ])
}

function trexDurationFragment(
  decodeTime: bigint,
  sampleCount = 1,
  payloadBytes = 16,
): Uint8Array {
  const tfhd = box('tfhd', fullBoxVersion(0), u32(1))
  const tfdt = box('tfdt', fullBoxVersion(1), u64(decodeTime))
  const trun = box('trun', fullBoxVersion(0), u32(sampleCount))
  return join([
    box('moof', box('mfhd', u32(0), u32(1)), box('traf', tfhd, tfdt, trun)),
    box('mdat', new Uint8Array(payloadBytes)),
  ])
}

function topLevelTfdtValues(bytes: Uint8Array): bigint[] {
  const values: bigint[] = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const scan = (start: number, end: number): void => {
    let offset = start
    while (offset + 8 <= end) {
      const size = view.getUint32(offset)
      if (size < 8 || offset + size > end) return
      const type = String.fromCharCode(
        bytes[offset + 4] ?? 0,
        bytes[offset + 5] ?? 0,
        bytes[offset + 6] ?? 0,
        bytes[offset + 7] ?? 0,
      )
      if (type === 'tfdt') {
        const version = bytes[offset + 8] ?? 0
        values.push(
          version === 1 ? view.getBigUint64(offset + 12) : BigInt(view.getUint32(offset + 12)),
        )
      } else if (type === 'moof' || type === 'traf') {
        scan(offset + 8, offset + size)
      }
      offset += size
    }
  }
  scan(0, bytes.byteLength)
  return values
}

function topLevelMfhdValues(bytes: Uint8Array): number[] {
  const values: number[] = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 0
  while (offset + 8 <= bytes.byteLength) {
    const size = view.getUint32(offset)
    if (size < 8 || offset + size > bytes.byteLength) break
    const type = String.fromCharCode(
      bytes[offset + 4] ?? 0,
      bytes[offset + 5] ?? 0,
      bytes[offset + 6] ?? 0,
      bytes[offset + 7] ?? 0,
    )
    if (type === 'moof') {
      let child = offset + 8
      while (child + 8 <= offset + size) {
        const childSize = view.getUint32(child)
        if (childSize < 8 || child + childSize > offset + size) break
        const childType = String.fromCharCode(
          bytes[child + 4] ?? 0,
          bytes[child + 5] ?? 0,
          bytes[child + 6] ?? 0,
          bytes[child + 7] ?? 0,
        )
        if (childType === 'mfhd') values.push(view.getUint32(child + 12))
        child += childSize
      }
    }
    offset += size
  }
  return values
}

function topLevelTypes(bytes: Uint8Array): string[] {
  const types: string[] = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 0
  while (offset + 8 <= bytes.byteLength) {
    const size = view.getUint32(offset)
    if (size < 8 || offset + size > bytes.byteLength) break
    types.push(
      String.fromCharCode(
        bytes[offset + 4] ?? 0,
        bytes[offset + 5] ?? 0,
        bytes[offset + 6] ?? 0,
        bytes[offset + 7] ?? 0,
      ),
    )
    offset += size
  }
  return types
}

interface HeaderTimeline {
  mvhd?: { timescale: number; duration: bigint }
  tkhd?: { duration: bigint }
  mdhd?: { timescale: number; duration: bigint }
  mehd?: { duration: bigint }
}

function headerTimeline(bytes: Uint8Array): HeaderTimeline {
  const result: HeaderTimeline = {}
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const containers = new Set(['moov', 'trak', 'mdia', 'mvex'])
  const scan = (start: number, end: number): void => {
    let offset = start
    while (offset + 8 <= end) {
      const size = view.getUint32(offset)
      if (size < 8 || offset + size > end) return
      const type = String.fromCharCode(
        bytes[offset + 4] ?? 0,
        bytes[offset + 5] ?? 0,
        bytes[offset + 6] ?? 0,
        bytes[offset + 7] ?? 0,
      )
      const version = bytes[offset + 8] ?? 0
      const duration = (relative: number): bigint =>
        version === 1
          ? view.getBigUint64(offset + 8 + relative)
          : BigInt(view.getUint32(offset + 8 + relative))
      if (type === 'mvhd' || type === 'mdhd') {
        const timescale = view.getUint32(offset + 8 + (version === 1 ? 20 : 12))
        const value = duration(version === 1 ? 24 : 16)
        if (type === 'mvhd') result.mvhd = { timescale, duration: value }
        else result.mdhd = { timescale, duration: value }
      } else if (type === 'tkhd') {
        result.tkhd = { duration: duration(version === 1 ? 28 : 20) }
      } else if (type === 'mehd') {
        result.mehd = { duration: duration(4) }
      }
      if (containers.has(type)) scan(offset + 8, offset + size)
      offset += size
    }
  }
  scan(0, bytes.byteLength)
  return result
}

console.log('\nSingle-recorder fragmented MP4 ring')
{
  const ring = new FragmentedMp4Ring(30_000)
  for (let second = 10; second <= 100; second += 10) {
    const init = second === 10 ? initialization() : new Uint8Array(0)
    ring.pushBytes(
      join([init, fragment(BigInt((second - 10) * 15_000))]),
      second * 1_000,
    )
  }
  const stats = ring.stats()
  const replay = ring.assemble(100_000)
  const timeline =
    replay === null ? {} : headerTimeline(new Uint8Array(replay.buffer))
  check(
    '30-second coverage retains three 10-second fragments',
    replay?.durationMs === 30_000 && replay.fragmentCount === 3,
    replay === null ? 'no replay' : `${replay.durationMs} ms / ${replay.fragmentCount} fragments`,
  )
  check('old fragment references are pruned', stats.fragmentCount === 3, `${stats.fragmentCount}`)
  check(
    'retained byte references stay bounded after a long session',
    stats.retainedBytes < 1_000,
    `${stats.retainedBytes} bytes in the synthetic fixture`,
  )
  check(
    'version-0 movie and track headers describe the assembled 30 seconds',
    timeline.mvhd?.duration === 30_000n &&
      timeline.tkhd?.duration === 30_000n &&
      timeline.mehd?.duration === 30_000n,
    JSON.stringify({
      mvhd: timeline.mvhd?.duration.toString(),
      tkhd: timeline.tkhd?.duration.toString(),
      mehd: timeline.mehd?.duration.toString(),
    }),
  )
  check(
    'version-0 media header uses its own 15 kHz timescale',
    timeline.mdhd?.timescale === 15_000 && timeline.mdhd.duration === 450_000n,
    JSON.stringify({
      timescale: timeline.mdhd?.timescale,
      duration: timeline.mdhd?.duration.toString(),
    }),
  )
}

{
  const ring = new FragmentedMp4Ring(30_000)
  // A replay request one second after a 30 s maintenance boundary used to
  // include the whole boundary-crossing fragment plus the current fragment.
  // That made a "last 30 seconds" raw MP4 physically contain 59 seconds. The
  // ring must not guess at sample/keyframe boundaries inside an opaque mdat:
  // retain only independently muxed fragments wholly inside the cutoff.
  ring.pushBytes(
    join([initialization(), fragment(0n, 450_000)]),
    30_000,
  )
  ring.pushBytes(
    join([initialization(), fragment(0n, 435_000)]),
    59_000,
  )
  const replay = ring.assemble(59_000)
  check(
    'an off-boundary replay never exposes raw media older than the configured window',
    replay !== null &&
      replay.durationMs <= 30_000 &&
      replay.startAtMs >= 29_000 &&
      replay.fragmentCount === 1,
    replay === null
      ? 'no replay'
      : `${replay.durationMs} ms / start ${replay.startAtMs} / ${replay.fragmentCount} fragments`,
  )
}

{
  const ring = new FragmentedMp4Ring(30_000)
  // Delivery clocks can overlap when a delayed timeslice and a later stop
  // flush are timestamped independently. Individual wall-clock intervals may
  // both fit the cutoff even though their encoded durations add past N.
  ring.pushBytes(
    join([initialization(), fragment(0n, 300_000)]),
    30_000,
  )
  ring.pushBytes(fragment(300_000n, 300_000), 40_000)
  const replay = ring.assemble(40_000)
  check(
    'overlapping fragment clocks cannot make assembled media exceed the byte-time window',
    replay !== null &&
      replay.durationMs <= 30_000 &&
      replay.fragmentCount === 1,
    replay === null
      ? 'no replay'
      : `${replay.durationMs} ms / ${replay.fragmentCount} fragments`,
  )
}

class SimulatedTimers implements WebmDualSlotTimers {
  private nextHandle = 1
  private readonly scheduled = new Map<
    number,
    { callback: () => void; dueAtMs: number }
  >()
  currentMs = 0

  now(): number {
    return this.currentMs
  }

  set(callback: () => void, delayMs: number): unknown {
    const handle = this.nextHandle++
    this.scheduled.set(handle, {
      callback,
      dueAtMs: this.currentMs + delayMs,
    })
    return handle
  }

  clear(handle: unknown): void {
    if (typeof handle === 'number') this.scheduled.delete(handle)
  }

  advanceBy(deltaMs: number): void {
    this.currentMs += deltaMs
    while (true) {
      const due = [...this.scheduled.entries()]
        .filter(([, timer]) => timer.dueAtMs <= this.currentMs)
        .sort(
          ([leftHandle, left], [rightHandle, right]) =>
            left.dueAtMs - right.dueAtMs || leftHandle - rightHandle,
        )[0]
      if (due === undefined) return
      this.scheduled.delete(due[0])
      due[1].callback()
    }
  }

  get pendingCount(): number {
    return this.scheduled.size
  }
}

class SimulatedMediaRecorder {
  state: RecordingState = 'inactive'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onerror: (() => void) | null = null
  onstop: (() => void) | null = null

  start(): void {
    if (this.state !== 'inactive') throw new Error('already recording')
    this.state = 'recording'
    // A deterministic, non-header-sized WebM payload. The lifecycle test is
    // about the recorder contract rather than a codec implementation.
    this.ondataavailable?.({
      data: new Blob([new Uint8Array(5_000).fill(0x2a)], {
        type: 'video/webm;codecs=vp8',
      }),
    })
  }

  stop(): void {
    if (this.state === 'inactive') throw new Error('already stopped')
    this.state = 'inactive'
    // MediaRecorder guarantees final dataavailable before stop.
    this.ondataavailable?.({
      data: new Blob([new Uint8Array(128).fill(0x7f)], {
        type: 'video/webm;codecs=vp8',
      }),
    })
    this.onstop?.()
  }
}

class MissingStopMediaRecorder extends SimulatedMediaRecorder {
  override stop(): void {
    if (this.state === 'inactive') throw new Error('already stopped')
    // Chromium changes state synchronously when stop() is accepted. This fake
    // withholds both final data and stop forever so the deadline owns cleanup.
    this.state = 'inactive'
  }
}

async function checkWebmFallbackLifecycle(): Promise<void> {
  console.log('\nWebM capability and dual-slot lifecycle')
  const mp4Preferred = pickRecorderFormat(
    (mimeType) =>
      mimeType === 'video/mp4;codecs=avc1' ||
      mimeType === 'video/webm;codecs=vp8',
  )
  check(
    'MP4-capable runtimes keep the fragmented single-encoder strategy',
    mp4Preferred?.strategy === 'fragmented-mp4' &&
      mp4Preferred.replayFile === 'replay.mp4',
  )

  const webmFallback = pickRecorderFormat(
    (mimeType) =>
      mimeType === 'video/x-matroska;codecs=avc1' ||
      mimeType === 'video/webm;codecs=vp8',
  )
  check(
    'mp4=false/webm=true selects legal VP8 WebM, never Matroska AVC',
    webmFallback?.strategy === 'dual-slot-webm' &&
      webmFallback.mimeType === 'video/webm;codecs=vp8' &&
      webmFallback.replayFile === 'replay.webm',
    webmFallback?.mimeType,
  )
  const matroskaOnly = pickRecorderFormat(
    (mimeType) => mimeType === 'video/x-matroska;codecs=avc1',
  )
  check(
    'Matroska AVC alone is rejected rather than mislabeled replay.webm',
    matroskaOnly === null,
  )

  let generation = 1
  let releaseOldTail: (() => void) | undefined
  const heldOldTail = new Promise<void>((resolve) => {
    releaseOldTail = resolve
  })
  let simulatedQueue = heldOldTail
  let oldTouchedNewRecorder = false
  let staleRequestAnsweredEmpty = false
  const oldRequestGeneration = generation
  const oldRequest = simulatedQueue.then(() => {
    if (oldRequestGeneration !== generation) {
      staleRequestAnsweredEmpty = true
      return
    }
    oldTouchedNewRecorder = true
  })
  generation += 1
  // teardown() gives the new generation an independent queue; the old promise
  // is allowed to settle later under its captured generation check.
  simulatedQueue = Promise.resolve()
  let newRequestRan = false
  const newRequest = simulatedQueue.then(() => {
    newRequestRan = true
  })
  await newRequest
  releaseOldTail?.()
  await oldRequest
  check(
    'a held old queue cannot delay or stop the new generation recorder',
    newRequestRan && staleRequestAnsweredEmpty && !oldTouchedNewRecorder,
  )

  const timers = new SimulatedTimers()
  const recorders: SimulatedMediaRecorder[] = []
  const failures: string[] = []
  let evidenceBytes = 0
  const fallback = new WebmDualSlotRing({
    generation: 41,
    segmentMs: 1_000,
    mimeType: webmFallback?.mimeType ?? 'video/webm;codecs=vp8',
    timesliceMs: 100,
    stopTimeoutMs: RECORDER_STOP_TIMEOUT_MS,
    timers,
    createRecorder: () => {
      const recorder = new SimulatedMediaRecorder()
      recorders.push(recorder)
      return recorder as unknown as MediaRecorder
    },
    discardRecorderOutput: () => false,
    onBytes: (bytes) => {
      evidenceBytes += bytes
    },
    onFailure: (message) => failures.push(message),
  })

  fallback.start()
  check(
    'WebM fallback starts one slot immediately, not two MP4 encoders',
    recorders.length === 1 && recorders[0]?.state === 'recording',
  )
  timers.advanceBy(1_000)
  check(
    'only the WebM fallback starts its staggered second recorder',
    recorders.length === 2 &&
      recorders.every((recorder) => recorder.state === 'recording'),
  )
  timers.advanceBy(500)
  const replay = await fallback.capture(timers.now())
  check(
    'mp4=false/webm=true returns non-empty replay bytes',
    replay !== null && replay.buffer.byteLength >= 5_128,
    replay === null ? 'null' : `${replay.buffer.byteLength} bytes`,
  )
  check(
    'the replay uses the measured older-slot interval',
    replay?.durationMs === 1_500 && replay.startAtMs === 0,
    replay === null ? 'null' : `${replay.startAtMs}..${replay.durationMs}`,
  )
  check(
    'capture restarts the extracted slot before assembly completes',
    recorders.length === 3 &&
      recorders.filter((recorder) => recorder.state === 'recording').length === 2,
  )
  check(
    'fallback output counts as positive frame evidence and raises no error',
    evidenceBytes >= 10_128 && failures.length === 0,
    `${evidenceBytes} bytes / ${failures.join(',')}`,
  )
  check(
    'dual-slot timers stay bounded after extraction and restagger',
    timers.pendingCount === 2,
    `${timers.pendingCount}`,
  )

  const staleCallback = recorders[1]?.ondataavailable
  const bytesBeforeDispose = evidenceBytes
  const constructorsBeforeDispose = recorders.length
  fallback.clear()
  staleCallback?.({
    data: new Blob([new Uint8Array(9_000)], {
      type: 'video/webm;codecs=vp8',
    }),
  })
  timers.advanceBy(20_000)
  check(
    'teardown stops both fallback recorders and clears every scheduled owner',
    timers.pendingCount === 0 &&
      recorders.every((recorder) => recorder.state === 'inactive'),
  )
  check(
    'saved stale callbacks cannot cross the disposed generation',
    evidenceBytes === bytesBeforeDispose &&
      recorders.length === constructorsBeforeDispose,
  )
  check(
    'teardown severs every recorder-to-Blob handler chain',
    recorders.every(
      (recorder) =>
        recorder.ondataavailable === null &&
        recorder.onerror === null &&
        recorder.onstop === null,
    ),
  )

  const constructorsBeforeFreshBoundary = recorders.length
  const freshBoundary = new WebmDualSlotRing({
    generation: 42,
    segmentMs: 1_000,
    mimeType: webmFallback?.mimeType ?? 'video/webm;codecs=vp8',
    timesliceMs: 100,
    stopTimeoutMs: RECORDER_STOP_TIMEOUT_MS,
    timers,
    createRecorder: () => {
      const recorder = new SimulatedMediaRecorder()
      recorders.push(recorder)
      return recorder as unknown as MediaRecorder
    },
    discardRecorderOutput: () => false,
    onBytes: () => undefined,
    onFailure: (message) => failures.push(message),
  })
  freshBoundary.start()
  check(
    'WebM resume starts one empty epoch only after both held slots were disposed',
    recorders.length === constructorsBeforeFreshBoundary + 1 &&
      recorders
        .slice(0, constructorsBeforeFreshBoundary)
        .every((recorder) => recorder.state === 'inactive') &&
      timers.pendingCount === 2,
  )
  freshBoundary.clear()
  check(
    'repeated WebM hold/resume leaves no recorder callback or timer growth',
    timers.pendingCount === 0 &&
      recorders.every(
        (recorder) =>
          recorder.state === 'inactive' &&
          recorder.ondataavailable === null &&
          recorder.onerror === null &&
          recorder.onstop === null,
      ),
  )

  const deadlineTimers = new SimulatedTimers()
  const deadlineRecorders: MissingStopMediaRecorder[] = []
  const deadlineFailures: string[] = []
  let deadlineFallback: WebmDualSlotRing
  deadlineFallback = new WebmDualSlotRing({
    generation: 99,
    segmentMs: 1_000,
    mimeType: 'video/webm;codecs=vp8',
    timesliceMs: 100,
    stopTimeoutMs: RECORDER_STOP_TIMEOUT_MS,
    timers: deadlineTimers,
    createRecorder: () => {
      const recorder = new MissingStopMediaRecorder()
      deadlineRecorders.push(recorder)
      return recorder as unknown as MediaRecorder
    },
    discardRecorderOutput: () => false,
    onBytes: () => undefined,
    onFailure: (message) => {
      deadlineFailures.push(message)
      deadlineFallback.clear()
    },
  })
  deadlineFallback.start()
  deadlineTimers.advanceBy(100)
  const missingStopReplay = deadlineFallback.capture(deadlineTimers.now())
  // Let captureNow install the deadline before advancing the deterministic
  // clock to it.
  await Promise.resolve()
  await Promise.resolve()
  deadlineTimers.advanceBy(RECORDER_STOP_TIMEOUT_MS)
  check(
    'a missing WebM stop event resolves as an empty replay at the shared deadline',
    (await missingStopReplay) === null &&
      deadlineFailures.some((message) => message.includes('stop timed out')),
  )
  check(
    'a timed-out fallback releases every handler and timer instead of locking the queue',
    deadlineTimers.pendingCount === 0 &&
      deadlineRecorders.every(
        (recorder) =>
          recorder.ondataavailable === null &&
          recorder.onerror === null &&
          recorder.onstop === null,
      ),
  )

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

{
  const compatible = new FragmentedMp4Ring(30_000)
  for (let index = 0; index < 2; index += 1) {
    compatible.pushBytes(
      join([
        initialization(
          15_000,
          1_000,
          0,
          1n,
          false,
          null,
          Uint8Array.from([1, 100, 0, 31]),
        ),
        fragment(0n),
      ]),
      (index + 1) * 10_000,
    )
  }
  check(
    'compatible recorder initialization keeps earlier session fragments',
    compatible.assemble(20_000)?.fragmentCount === 2,
  )

  const renegotiated = new FragmentedMp4Ring(30_000)
  renegotiated.pushBytes(
    join([
      initialization(
        15_000,
        1_000,
        0,
        1n,
        false,
        null,
        Uint8Array.from([1, 100, 0, 31]),
      ),
      fragment(0n),
    ]),
    10_000,
  )
  renegotiated.pushBytes(
    join([
      initialization(
        15_000,
        1_000,
        0,
        1n,
        false,
        null,
        Uint8Array.from([1, 100, 0, 42]),
      ),
      fragment(0n),
    ]),
    20_000,
  )
  const replay = renegotiated.assemble(20_000)
  check(
    'codec renegotiation starts a fresh compatible fragment epoch',
    replay?.fragmentCount === 1 && replay.durationMs === 10_000,
    replay === null
      ? 'no replay'
      : `${replay.fragmentCount} fragment(s), ${replay.durationMs} ms`,
  )
}

{
  const ring = new FragmentedMp4Ring(30_000)
  // Models a timeslice task which was queued before stop but delivered beside
  // the final flush. Production stages both Blobs and sends this one batch to
  // the ring at the requested capture instant.
  ring.pushBytes(
    join([
      initialization(),
      fragment(0n, 75_000),
      fragment(75_000n, 75_000),
    ]),
    10_000,
  )
  const replay = ring.assemble(10_000)
  check(
    'a delayed timeslice and final flush form one contiguous interval',
    replay?.fragmentCount === 2 &&
      replay.durationMs === 10_000 &&
      replay.startAtMs === 0 &&
      replay.endAtMs === 10_000,
    replay === null
      ? 'no replay'
      : `${replay.startAtMs}..${replay.endAtMs}, ${replay.durationMs} ms`,
  )
}

{
  const ring = new FragmentedMp4Ring(30_000)
  ring.pushBytes(
    join([
      initialization(15_000, 1_000, 0, 1n, false, 1_500),
      trexDurationFragment(0n, 100),
    ]),
    10_000,
  )
  ring.pushBytes(
    join([
      initialization(90_000, 1_000, 0, 1n, false, 9_000),
      trexDurationFragment(0n, 100),
    ]),
    20_000,
  )
  const replay = ring.assemble(20_000)
  const replayBytes =
    replay === null ? new Uint8Array(0) : new Uint8Array(replay.buffer)
  const timeline = replay === null ? {} : headerTimeline(replayBytes)
  const decodeTimes = topLevelTfdtValues(replayBytes)
  check(
    'trex-only sample durations preserve cross-session replay length',
    replay?.durationMs === 20_000 &&
      timeline.mdhd?.timescale === 90_000 &&
      timeline.mdhd.duration === 1_800_000n,
    JSON.stringify({
      replayMs: replay?.durationMs,
      mdhd: timeline.mdhd?.duration.toString(),
    }),
  )
  check(
    'trex-only fragments rebase onto the target session clock',
    decodeTimes.length === 2 &&
      decodeTimes[0] === 0n &&
      decodeTimes[1] === 900_000n,
    decodeTimes.join(','),
  )
}

// ISO-BMFF does not promise one `moof` per second. A hardware/runtime update
// may fragment at frame or sub-second cadence even though MediaRecorder's Blob
// timeslice is ten seconds. The retention contract is time-based, so an
// internal reference cap must not silently turn "last 30 seconds" into the last
// 3.2 seconds merely because 100 ms fragments arrived.
{
  const ring = new FragmentedMp4Ring(30_000)
  for (let index = 1; index <= 400; index += 1) {
    ring.pushBytes(
      join([
        ...(index === 1 ? [initialization()] : []),
        fragment(BigInt((index - 1) * 1_500), 1_500),
      ]),
      index * 100,
    )
  }
  const replay = ring.assemble(40_000)
  const stats = ring.stats()
  check(
    'sub-second fragments retain the configured 30-second window',
    replay?.durationMs === 30_000 && replay.fragmentCount === 300,
    replay === null ? 'no replay' : `${replay.durationMs} ms / ${replay.fragmentCount} fragments`,
  )
  check(
    'sub-second fragment references are bounded by retained time, not session age',
    stats.fragmentCount === 300 && stats.retainedDurationMs === 30_000,
    `${stats.fragmentCount} refs / ${stats.retainedDurationMs} ms`,
  )
}

{
  const ring = new FragmentedMp4Ring(30_000)
  const hugeIncompleteBox = join([u32(0xffff_ffff), text('free')])
  let rejected = false
  try {
    ring.pushBytes(hugeIncompleteBox, 1_000)
  } catch {
    rejected = true
  }
  check('a finite box larger than the parser memory budget is rejected immediately', rejected)
  let recovered = true
  try {
    ring.pushBytes(join([initialization(), fragment(0n)]), 11_000)
  } catch {
    recovered = false
  }
  check(
    'an oversized incomplete prefix cannot hide every later recorder session',
    recovered && ring.assemble(11_000)?.fragmentCount === 1,
  )
}

{
  // The supported maximum is 600 seconds at the production 6 Mbps rate:
  // nominal media alone is about 450 MB. Exercise only the header so this QA
  // proves the derived budget without allocating hundreds of megabytes.
  const ring = new FragmentedMp4Ring(600_000, 6_000_000)
  let accepted = true
  try {
    ring.pushBytes(join([u32(450_000_008), text('mdat')]), 600_000)
  } catch {
    accepted = false
  }
  const stats = ring.stats()
  check(
    'the parser budget permits a nominal 600-second 6 Mbps mdat',
    accepted,
  )
  check(
    'the 600-second retained budget covers nominal encoded media',
    stats.retainedBudgetBytes >= 450_000_008,
    `${stats.retainedBudgetBytes} bytes`,
  )
  check(
    'the integrated working-set budget covers split ingest under a hard ceiling',
    stats.retainedBudgetBytes * 3 <= stats.workingSetBudgetBytes &&
      stats.workingSetBudgetBytes <= 1536 * 1024 * 1024,
    `${stats.retainedBudgetBytes} retained / ${stats.workingSetBudgetBytes} working`,
  )
}

{
  // Exercise the integrated cap at its 16 MiB minimum with real retained
  // allocations. Four 5 MiB fragments overlap in time; only three fit while
  // preserving room for the one replay output allocation.
  const ring = new FragmentedMp4Ring(1_000, 1)
  const payloadBytes = 5 * 1024 * 1024
  for (let index = 0; index < 4; index += 1) {
    ring.pushBytes(
      join([
        ...(index === 0 ? [initialization()] : []),
        fragment(BigInt(index * 1_500), 1_500, payloadBytes),
      ]),
      1_000 + index * 100,
    )
  }
  const stats = ring.stats()
  const replay = ring.assemble(1_400)
  check(
    'retained fragments stay inside the integrated media budget',
    stats.fragmentCount === 3 &&
      stats.retainedBytes <= stats.retainedBudgetBytes,
    `${stats.fragmentCount} fragments / ${stats.retainedBytes} of ${stats.retainedBudgetBytes}`,
  )
  check(
    'retained plus assembled replay stays inside the renderer working-set budget',
    replay !== null &&
      stats.retainedBytes + replay.buffer.byteLength <=
        stats.workingSetBudgetBytes,
    replay === null
      ? 'no replay'
      : `${stats.retainedBytes + replay.buffer.byteLength} of ${stats.workingSetBudgetBytes}`,
  )
}

{
  const ring = new FragmentedMp4Ring(30_000)
  const init = initialization()
  const media = fragment(0n)
  const incomplete = media.slice(0, media.byteLength - 1)
  ring.pushBytes(join([init, incomplete]), 10_000)
  const retained = ring.stats().retainedBytes
  check(
    'retained-byte stats include incomplete parser and fragment parts',
    retained === init.byteLength + incomplete.byteLength,
    `${retained} reported / ${init.byteLength + incomplete.byteLength} held`,
  )
  ring.pushBytes(media.slice(media.byteLength - 1), 10_000)
  check('a split mdat still completes after the memory accounting probe', ring.assemble(10_000) !== null)
}

{
  const ring = new FragmentedMp4Ring(30_000)
  ring.pushBytes(join([initialization(15_000), fragment(0n, 150_000)]), 10_000)
  try {
    ring.pushBytes(
      join([
        initialization(90_000),
        u32(1),
        text('free'),
        u64(BigInt(Number.MAX_SAFE_INTEGER) + 1n),
      ]),
      20_000,
    )
  } catch {
    // Expected: the assertion below checks that parsing was transactional.
  }
  const replay = ring.assemble(10_000)
  const timeline =
    replay === null ? {} : headerTimeline(new Uint8Array(replay.buffer))
  check(
    'a rejected new initialization cannot retime already committed fragments',
    replay?.durationMs === 10_000 &&
      timeline.mdhd?.timescale === 15_000 &&
      timeline.mdhd.duration === 150_000n,
    JSON.stringify({
      durationMs: replay?.durationMs,
      timescale: timeline.mdhd?.timescale,
      duration: timeline.mdhd?.duration.toString(),
    }),
  )
}

{
  const ring = new FragmentedMp4Ring(30_000)
  const impossibleBox = join([
    u32(1),
    text('free'),
    u64(BigInt(Number.MAX_SAFE_INTEGER) + 1n),
  ])
  let rejected = false
  try {
    ring.pushBytes(impossibleBox, 1_000)
  } catch {
    rejected = true
  }
  check('an impossible MP4 box is rejected', rejected)

  let recovered = true
  try {
    ring.pushBytes(join([initialization(), fragment(0n)]), 11_000)
  } catch {
    recovered = false
  }
  const replay = recovered ? ring.assemble(11_000) : null
  check(
    'one malformed chunk cannot poison every later recorder session',
    replay?.fragmentCount === 1 && replay.durationMs === 10_000,
    recovered ? (replay === null ? 'no replay' : `${replay.fragmentCount} / ${replay.durationMs}`) : 'threw again',
  )
}

{
  const ring = new FragmentedMp4Ring(30_000)
  // Every item is a complete maintenance-flush session. Its native decode
  // clock starts at zero, just as a newly restarted MediaRecorder does.
  for (let session = 1; session <= 6; session += 1) {
    ring.pushBytes(
      join([
        initialization(90_000, 1_000, 1, 1n, true),
        fragment(0n, 900_000),
        // Stop-tail indexes belong to this one recorder session. The replay
        // ring does not preserve them in front of fragments from other ones.
        box('sidx', fullBoxVersion(0), u32(session)),
        box('mfra', box('mfro', fullBoxVersion(0), u32(16))),
      ]),
      session * 10_000,
    )
  }
  const replay = ring.assemble(60_000)
  const replayBytes = replay === null ? new Uint8Array(0) : new Uint8Array(replay.buffer)
  const decodeTimes =
    replay === null ? [] : topLevelTfdtValues(replayBytes)
  const sequenceNumbers =
    replay === null ? [] : topLevelMfhdValues(replayBytes)
  const types = topLevelTypes(replayBytes)
  const timeline = headerTimeline(replayBytes)
  check(
    'periodic stop/restart still preserves the preceding 30 seconds',
    replay?.durationMs === 30_000 && replay.fragmentCount === 3,
  )
  check(
    'maintenance sessions are rebased onto one decode timeline',
    decodeTimes.join(',') === '0,900000,1800000',
    decodeTimes.join(','),
  )
  check(
    'maintenance sessions receive one monotonic fragment sequence',
    sequenceNumbers.join(',') === '1,2,3',
    sequenceNumbers.join(','),
  )
  check(
    'only ftyp/free/moov initialization survives; stop-tail sidx/mfra is discarded',
    types.slice(0, 3).join(',') === 'ftyp,free,moov' &&
      !types.includes('sidx') &&
      !types.includes('mfra'),
    types.join(','),
  )
  check(
    'version-1 movie headers use the movie timescale across sessions',
    timeline.mvhd?.timescale === 1_000 &&
      timeline.mvhd.duration === 30_000n &&
      timeline.tkhd?.duration === 30_000n &&
      timeline.mehd?.duration === 30_000n,
    JSON.stringify({
      mvhd: timeline.mvhd?.duration.toString(),
      tkhd: timeline.tkhd?.duration.toString(),
      mehd: timeline.mehd?.duration.toString(),
    }),
  )
  check(
    'version-1 mdhd uses the media header 90 kHz timescale',
    timeline.mdhd?.timescale === 90_000 && timeline.mdhd.duration === 2_700_000n,
    JSON.stringify({
      timescale: timeline.mdhd?.timescale,
      duration: timeline.mdhd?.duration.toString(),
    }),
  )
}

{
  const ring = new FragmentedMp4Ring(30_000)
  // The old recorder stopped at wall t=10 s. Its replacement did not produce
  // pixels until t=12 s, then recorded ten seconds. A contiguous tfdt rewrite
  // would hide that real two-second hole and make every context observation
  // after the rotation appear two seconds early.
  ring.pushBytes(
    join([
      initialization(90_000, 1_000, 1, 1n, true),
      fragment(0n, 900_000),
    ]),
    10_000,
  )
  ring.pushBytes(
    join([
      initialization(90_000, 1_000, 1, 1n, true),
      fragment(0n, 900_000),
    ]),
    22_000,
  )
  const replay = ring.assemble(22_000)
  const replayBytes =
    replay === null ? new Uint8Array(0) : new Uint8Array(replay.buffer)
  const decodeTimes =
    replay === null ? [] : topLevelTfdtValues(replayBytes)
  const timeline = headerTimeline(replayBytes)
  check(
    'maintenance rotation preserves an observed two-second wall-clock frame gap',
    replay?.durationMs === 22_000 &&
      replay.startAtMs === 0 &&
      replay.endAtMs === 22_000 &&
      decodeTimes.join(',') === '0,1080000' &&
      timeline.mvhd?.duration === 22_000n &&
      timeline.mdhd?.duration === 1_980_000n,
    replay === null
      ? 'no replay'
      : `${replay.startAtMs}..${replay.endAtMs} / ${replay.durationMs} ms / tfdt ${decodeTimes.join(',')}`,
  )
}

{
  const ring = new FragmentedMp4Ring(30_000)
  ring.pushBytes(
    join([
      initialization(),
      fragment(0n, 75_000),
    ]),
    5_000,
  )
  // A later BlobEvent from the SAME MediaRecorder was delivered two seconds
  // late. Its encoded clock is continuous; JS task backlog is not a pixel gap.
  ring.pushBytes(fragment(75_000n, 75_000), 12_000)
  const replay = ring.assemble(12_000)
  const replayBytes =
    replay === null ? new Uint8Array(0) : new Uint8Array(replay.buffer)
  const decodeTimes =
    replay === null ? [] : topLevelTfdtValues(replayBytes)
  check(
    'timeslice delivery jitter inside one recorder does not invent a frame gap',
    replay?.durationMs === 10_000 &&
      decodeTimes.join(',') === '0,75000',
    replay === null
      ? 'no replay'
      : `${replay.durationMs} ms / tfdt ${decodeTimes.join(',')}`,
  )
}

{
  const ring = new FragmentedMp4Ring(30_000)
  ring.pushBytes(join([initialization(1_000), fragment(0n, 1_000)]), 1_000)
  ring.pushBytes(join([initialization(90_000), fragment(0n, 90_000)]), 2_000)
  const replay = ring.assemble(2_000)
  const replayBytes = replay === null ? new Uint8Array(0) : new Uint8Array(replay.buffer)
  const decodeTimes = topLevelTfdtValues(replayBytes)
  const timeline = headerTimeline(replayBytes)
  check(
    'recorder sessions with different timescales keep a continuous decode timeline',
    replay?.durationMs === 2_000 && decodeTimes.join(',') === '0,90000',
    JSON.stringify({ durationMs: replay?.durationMs, decodeTimes: decodeTimes.map(String) }),
  )
  check(
    'mixed-timescale session headers still describe the full media duration',
    timeline.mvhd?.timescale === 1_000 &&
      timeline.mvhd.duration === 2_000n &&
      timeline.mdhd?.timescale === 90_000 &&
      timeline.mdhd.duration === 180_000n,
    JSON.stringify({
      mvhd: timeline.mvhd?.duration.toString(),
      mdhdTimescale: timeline.mdhd?.timescale,
      mdhd: timeline.mdhd?.duration.toString(),
    }),
  )
}

{
  // Read-only field fixture produced by rc.36. Keep the check portable: CI
  // without the owner's CapturePack folder skips it, while the release desk
  // exercises Chromium's real mvhd/tkhd/mdhd layout and two real fragments.
  const fixturePath =
    'C:\\_CapturePack\\CapturePack_2026-07-29_210107\\replay.mp4'
  if (existsSync(fixturePath)) {
    const ring = new FragmentedMp4Ring(30_000)
    ring.pushBytes(new Uint8Array(readFileSync(fixturePath)), 100_000)
    const replay = ring.assemble(100_000)
    const replayBytes = replay === null ? new Uint8Array(0) : new Uint8Array(replay.buffer)
    const timeline = headerTimeline(replayBytes)
    const movieDurationMs =
      timeline.mvhd === undefined
        ? 0
        : (Number(timeline.mvhd.duration) * 1_000) / timeline.mvhd.timescale
    const mediaDurationMs =
      timeline.mdhd === undefined
        ? 0
        : (Number(timeline.mdhd.duration) * 1_000) / timeline.mdhd.timescale
    check(
      'rc.36 field replay is parsed and reassembled',
      replay?.fragmentCount === 2 && replay.durationMs > 10_000,
      replay === null ? 'no replay' : `${replay.fragmentCount} / ${replay.durationMs} ms`,
    )
    check(
      'rc.36 mvhd/tkhd/mdhd agree with its assembled fragment timeline',
      replay !== null &&
        Math.abs(movieDurationMs - replay.durationMs) <= 1 &&
        Math.abs(mediaDurationMs - replay.durationMs) <= 1 &&
        timeline.tkhd?.duration === timeline.mvhd?.duration,
      JSON.stringify({
        replayMs: replay?.durationMs,
        movieDurationMs,
        mediaDurationMs,
        tkhd: timeline.tkhd?.duration.toString(),
      }),
    )
    check(
      'rc.36 reassembly contains no misplaced tail index before media',
      !topLevelTypes(replayBytes).some((type) => type === 'mfra' || type === 'sidx'),
      topLevelTypes(replayBytes).join(','),
    )
  } else {
    // THE NUMBERS THAT SEPARATE THE LAYERS (#116).
//
// A field capture reported a 903 ms stall and produced a replay whose longest
// held frame was 197 ms - 17.6 s of desk as 5.3 s of media. The obvious
// suspect was this ring folding gaps out when it joins fragments. It was not:
// the file holds ONE fragment, so there was nothing to join, and two probes
// against a real MediaRecorder could not make the shipped ring lose a gap.
//
// A fix was written and reverted on that evidence. What is left is the
// measurement that should have come first, and these cases pin it, because a
// diagnostic that lies is worse than none: the next person reads it to decide
// whether the encoder or the sample durations flattened a capture.
// A SOURCE THAT STOPPED PRODUCING IS NOT A RECORDING THAT RAN FAST (#116).
//
// Measured, in one capture, on two displays at once -
// CapturePack_2026-07-31_233324:
//
//   display 2, healthy  encoder span 11972 ms   media 11917 ms   agree
//   display 1, starved  encoder span 11908 ms   media  3501 ms   8.4 s lost
//
// Its longest held frame was 72.2 ms, so the sample durations do not carry the
// stall either; only `tfdt` ever knew, and 24 of 24 fragments carried one. The
// ring joined them end to end because it could not tell a starved source from
// a late delivery. `tfdt` tells them apart, and always could: a late BlobEvent
// leaves the encoder's clock continuous, a source that stopped drawing leaves a
// hole in it. The delivery-jitter regression above passes unchanged, and now
// passes for that reason rather than by a blanket assumption.
console.log('\nA stalled source keeps its hole')
{
  const ring = new FragmentedMp4Ring(30_000)
  ring.pushBytes(join([initialization(), fragment(0n, 15_000)]), 1_000)
  // One second of encoded media, then the desk went still: the next fragment
  // arrives 900 ms later and says so on the encoder's own clock.
  ring.pushBytes(fragment(28_500n, 15_000), 2_900)
  const replay = ring.assemble(2_900)
  const decodeTimes =
    replay === null ? [] : topLevelTfdtValues(new Uint8Array(replay.buffer))
  check(
    'a stalled source keeps its hole instead of being compressed away',
    decodeTimes.join(',') === '0,28500',
    replay === null ? 'no replay' : `tfdt ${decodeTimes.join(',')}`,
  )
}
{
  const ring = new FragmentedMp4Ring(60_000)
  ring.pushBytes(join([initialization(), fragment(0n, 15_000)]), 1_000)
  // The flush path: several fragments handed over at ONE delivery instant.
  ring.pushBytes(
    join([
      fragment(60_000n, 15_000),
      fragment(120_000n, 15_000),
      fragment(180_000n, 15_000),
      fragment(240_000n, 15_000),
    ]),
    20_000,
  )
  const replay = ring.assemble(20_000)
  const decodeTimes =
    replay === null ? [] : topLevelTfdtValues(new Uint8Array(replay.buffer))
  check(
    'fragments sharing one delivery keep the holes their encoder reported',
    decodeTimes.join(',') === '0,60000,120000,180000,240000',
    replay === null ? 'no replay' : `tfdt ${decodeTimes.join(',')}`,
  )
}
// FAIL CLOSED. A wrong placement is worse than a compression: a compression is
// visible in the duration and a bad placement is not.
{
  const ring = new FragmentedMp4Ring(30_000)
  ring.pushBytes(join([initialization(), fragment(0n, 15_000)]), 1_000)
  // 60 s of encoder time claimed inside 1.9 s of wall. Impossible.
  ring.pushBytes(fragment(900_000n, 15_000), 2_900)
  const replay = ring.assemble(2_900)
  const decodeTimes =
    replay === null ? [] : topLevelTfdtValues(new Uint8Array(replay.buffer))
  check(
    'an impossible encoder timeline is refused, not written',
    decodeTimes.join(',') === '0,15000',
    replay === null ? 'no replay' : `tfdt ${decodeTimes.join(',')}`,
  )
}
{
  const ring = new FragmentedMp4Ring(60_000)
  ring.pushBytes(join([initialization(), fragment(0n, 15_000)]), 1_000)
  ring.pushBytes(fragment(28_500n, 15_000), 2_900)
  // One fragment with no tfdt refuses the WHOLE session - the two that DO
  // carry a hole lose it too, proving the refusal is session-wide and not
  // per-fragment. Half-placed is the failure nobody can see.
  ring.pushBytes(trexDurationFragmentWithoutTfdt(15_000), 3_900)
  const replay = ring.assemble(3_900)
  const decodeTimes =
    replay === null ? [] : topLevelTfdtValues(new Uint8Array(replay.buffer))
  check(
    'one tfdt-less fragment refuses the whole session, hole and all',
    decodeTimes.join(',') === '0,15000',
    replay === null ? 'no replay' : `tfdt ${decodeTimes.join(',')}`,
  )
}
{
  const ring = new FragmentedMp4Ring(60_000)
  // A session delivered at ONE instant has no independent wall evidence at all.
  ring.pushBytes(
    join([initialization(), fragment(0n, 15_000), fragment(60_000n, 15_000)]),
    5_000,
  )
  const replay = ring.assemble(5_000)
  const decodeTimes =
    replay === null ? [] : topLevelTfdtValues(new Uint8Array(replay.buffer))
  check(
    'one delivery instant is not evidence of a four-second hole',
    decodeTimes.join(',') === '0,15000',
    replay === null ? 'no replay' : `tfdt ${decodeTimes.join(',')}`,
  )
}

// A REFUSAL AND A PRIVACY TRIM PRODUCE THE SAME SHORT REPLAY (#116).
//
// Both look exactly like success from outside, and one release was already lost
// to a diagnostic that could not be read. So the verdict travels with the
// answer: which sessions were believed, what they claimed, what wall time there
// was to check it against, and how many fragments the retention window took.
console.log('\nThe timeline says why it is the length it is')
{
  const ring = new FragmentedMp4Ring(60_000)
  ring.pushBytes(join([initialization(), fragment(0n, 15_000)]), 1_000)
  ring.pushBytes(fragment(28_500n, 15_000), 2_900)
  ring.assemble(2_900)
  const a = ring.stats().timing.assembly
  check(
    'a believed session records what it claimed and what checked it',
    a !== null && a.verdicts.length === 1 && a.verdicts[0]?.trusted === true
      && Math.round(a.verdicts[0].claimedMs ?? 0) === 1_900,
    a === null ? 'no assembly' : JSON.stringify(a.verdicts),
  )
  check(
    'and the retention window is reported even when it took nothing',
    a !== null && a.selectedBeforeRetention === a.selectedAfterRetention
      && a.retentionMs === 60_000,
    a === null ? 'no assembly' : `${String(a.selectedBeforeRetention)} -> ${String(a.selectedAfterRetention)}`,
  )
}
{
  const ring = new FragmentedMp4Ring(60_000)
  ring.pushBytes(join([initialization(), fragment(0n, 15_000)]), 1_000)
  // 60 s claimed inside 1.9 s of wall.
  ring.pushBytes(fragment(900_000n, 15_000), 2_900)
  ring.assemble(2_900)
  const a = ring.stats().timing.assembly
  const v = a?.verdicts[0]
  check(
    'a refusal names its reason and both numbers',
    v !== undefined && v.trusted === false && v.reason === 'outruns-wall'
      && Math.round(v.claimedMs ?? 0) === 60_000,
    JSON.stringify(v),
  )
}
{
  const ring = new FragmentedMp4Ring(60_000)
  ring.pushBytes(join([initialization(), fragment(0n, 15_000)]), 1_000)
  ring.pushBytes(trexDurationFragmentWithoutTfdt(15_000), 2_900)
  ring.assemble(2_900)
  const v = ring.stats().timing.assembly?.verdicts[0]
  check(
    'a session missing a tfdt says so, rather than looking like a short capture',
    v !== undefined && v.trusted === false && v.reason === 'missing-tfdt',
    JSON.stringify(v),
  )
}
// A QUIET SCREEN DELIVERS ITS FIRST FRAGMENT LATE, AND THAT IS NOT EVIDENCE
// AGAINST IT (#116).
//
// The claim starts at the first fragment's FIRST SAMPLE - that is what tfdt is.
// Its delivery happens when the fragment CLOSES, and Chromium closes a moof
// only at a key frame, so on a still screen one fragment stays open for seconds
// while declaring a couple of hundred milliseconds of media. Anchoring the wall
// reference at that delivery subtracted the wait from the reference but not
// from the claim, and the claim then appeared to outrun the wall by exactly the
// amount the screen had been still.
//
// Measured on CapturePack_2026-08-01_002541, one capture, two displays:
//   display 2, 14.8 fps  first fragment 272 ms late   excess  126 ms  believed
//   display 1,  5.3 fps  first fragment 2019 ms late  excess 1456 ms  REFUSED
// and 12011 ms of desk was written as 25 butt-joined fragments totalling
// 3696 ms. The error was largest exactly where the evidence mattered most.
console.log('\nA late first fragment is not evidence against its own clock')
{
  const ring = new FragmentedMp4Ring(60_000)
  // The session begins at t=1000 - the init blob carries no fragment, which is
  // what a starved recorder does while it waits for its first key frame.
  ring.pushBytes(join([initialization()]), 1_000)
  // Three seconds later the first fragment finally closes and arrives. Its tfdt
  // says its samples began back at 0 — which is true, and is exactly what the
  // old anchor read as the clock outrunning the wall.
  ring.pushBytes(fragment(0n, 15_000), 4_000)
  ring.pushBytes(fragment(165_000n, 15_000), 13_000)
  const replay = ring.assemble(13_000)
  const decodeTimes =
    replay === null ? [] : topLevelTfdtValues(new Uint8Array(replay.buffer))
  check(
    'the session start anchors the wall, so an 11 s claim survives a late arrival',
    decodeTimes.join(',') === '0,165000',
    replay === null ? 'no replay' : `tfdt ${decodeTimes.join(',')}`,
  )
  const v = ring.stats().timing.assembly?.verdicts[0]
  check(
    'and the verdict shows the wall it was judged against, not the arrival gap',
    v !== undefined && v.trusted === true && Math.round(v.wallSpanMs) === 12_000,
    JSON.stringify(v),
  )
}
// The guard still refuses a claim that outruns the session itself. Anchoring
// earlier widened the window by a known, bounded amount - it did not remove it.
{
  const ring = new FragmentedMp4Ring(60_000)
  ring.pushBytes(join([initialization()]), 1_000)
  ring.pushBytes(fragment(0n, 15_000), 4_000)
  // 60 s of encoder time claimed inside a session that is 12 s old.
  ring.pushBytes(fragment(900_000n, 15_000), 13_000)
  const replay = ring.assemble(13_000)
  const decodeTimes =
    replay === null ? [] : topLevelTfdtValues(new Uint8Array(replay.buffer))
  const v = ring.stats().timing.assembly?.verdicts[0]
  check(
    'a claim longer than its own session is still refused',
    decodeTimes.join(',') === '0,15000'
      && v?.trusted === false && v.reason === 'outruns-wall',
    `tfdt ${decodeTimes.join(',')} / ${JSON.stringify(v)}`,
  )
}

// THE PRIVACY WINDOW CANNOT SWALLOW AN HONEST TIMELINE (#116).
//
// The retention gate is the other way a duration can die, and the fix changed
// what it measures: it used to peel against the compressed sum and now peels
// against the real span. The obvious worry is that a starved display - short
// media, long wall - would now be trimmed by a rule written for a different
// quantity.
//
// It cannot be, and the two rules that prevent it are worth pinning together
// because neither says so alone:
//
//   the candidate cutoff keeps only fragments delivered within retentionMs
//   the trust guard believes tfdt only while claimed <= wallSpan + 1000 ms
//
// So an accepted timeline is at most retentionMs + 1000 ms, and the tick gate
// can only ever peel inside that one-second band. A capture is never trimmed
// to a fraction of itself by this path - which is also why the gate is not the
// explanation when a display comes out compressed anyway.
{
  const ring = new FragmentedMp4Ring(2_500)
  ring.pushBytes(join([initialization(), fragment(0n, 15_000)]), 1_000)
  ring.pushBytes(fragment(28_500n, 15_000), 2_900)
  ring.assemble(2_900)
  const a = ring.stats().timing.assembly
  check(
    'the retention window and the timeline it judged are both on the record',
    a !== null && a.retentionMs === 2_500 && a.timelineBeforeRetentionMs > 0,
    a === null
      ? 'no assembly'
      : `${String(a.timelineBeforeRetentionMs)} ms judged against ${String(a.retentionMs)} ms`,
  )
  check(
    'and what survives never exceeds the window by more than the tolerance',
    a !== null
      && a.selectedAfterRetention <= a.selectedBeforeRetention
      && a.timelineBeforeRetentionMs <= a.retentionMs + 1_000,
    a === null
      ? 'no assembly'
      : `${String(a.selectedBeforeRetention)} -> ${String(a.selectedAfterRetention)}`,
  )
}

// AND IT HAS TO REACH THE LOG (#116).
//
// The first version of this measured correctly and printed from the RENDERER,
// whose console does not reach the main log. rc.9 therefore shipped a
// diagnostic that produced nothing at all, and the very capture it was built
// for came and went unmeasured. A diagnostic nobody can read is the same as no
// diagnostic, so the ROUTE is pinned here, not just the calculation.
{
  const renderer = readFileSync(
    path.join(process.cwd(), 'src/renderer/capture/capture.ts'),
    'utf8',
  )
  const main = readFileSync(path.join(process.cwd(), 'src/main/capture.ts'), 'utf8')
  check(
    'the renderer SENDS the timing rather than logging where nothing reads',
    renderer.includes('ringTiming: stats.timing,')
      && !renderer.includes('[capture] ring timing'),
    'renderer',
  )
  check(
    'and main writes it to the log beside the ring line it belongs with',
    main.includes('ring timing') && main.includes('ring.ringTiming !== undefined'),
    'main',
  )
}

console.log('\nRing timing diagnostics')
{
  const ring = new FragmentedMp4Ring(60_000)
  // One fragment holding one very long sample: the field file's shape.
  ring.pushBytes(join([initialization(), fragment(0n, 150_000)]), 10_000)
  const t = ring.stats().timing
  check(
    'a long-held frame is reported as one, at its real length',
    t.sampleCount === 1 && t.maxSampleDurationMs === 10_000,
    `${String(t.sampleCount)} sample(s), longest ${String(t.maxSampleDurationMs)} ms`,
  )
  check(
    'and one delivery is reported as one delivery',
    t.deliveryCount === 1,
    String(t.deliveryCount),
  )
}
{
  const ring = new FragmentedMp4Ring(60_000)
  ring.pushBytes(join([initialization(), fragment(0n, 15_000)]), 1_000)
  // Two more in ONE blob - the flush path every capture takes.
  ring.pushBytes(join([fragment(15_000n, 15_000), fragment(30_000n, 15_000)]), 5_000)
  const t = ring.stats().timing
  check(
    'the encoder span is what the encoder said, not the media sum',
    t.sourceSpanMs === 2_000,
    `${String(t.sourceSpanMs)} ms`,
  )
  check(
    'fragments sharing one blob are one delivery instant, not three',
    t.deliveryCount === 2 && t.fragmentsWithSourceTime === 3,
    `${String(t.deliveryCount)} delivery instant(s), ` +
      `${String(t.fragmentsWithSourceTime)} with a source time`,
  )
}
{
  const ring = new FragmentedMp4Ring(60_000)
  ring.pushBytes(join([initialization(), trexDurationFragmentWithoutTfdt(15_000)]), 1_000)
  const t = ring.stats().timing
  check(
    'a fragment carrying no source time is counted as carrying none',
    t.fragmentsWithSourceTime === 0 && t.sourceSpanMs === 0,
    `${String(t.fragmentsWithSourceTime)} with a source time, span ${String(t.sourceSpanMs)} ms`,
  )
}

console.log('  SKIP  rc.36 field replay fixture is not present on this machine')
  }
}

{
  const captureSource = readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'capture', 'capture.ts'),
    'utf8',
  )
  const webmSource = readFileSync(
    path.join(
      process.cwd(),
      'src',
      'renderer',
      'capture',
      'webmDualSlotRing.ts',
    ),
    'utf8',
  )
  const mainSessionSource = readFileSync(
    path.join(process.cwd(), 'src', 'main', 'session.ts'),
    'utf8',
  )
  const mainCaptureSource = readFileSync(
    path.join(process.cwd(), 'src', 'main', 'capture.ts'),
    'utf8',
  )
  const capturePreloadSource = readFileSync(
    path.join(process.cwd(), 'src', 'preload', 'capture.ts'),
    'utf8',
  )
  const ipcSource = readFileSync(
    path.join(process.cwd(), 'src', 'shared', 'ipc.ts'),
    'utf8',
  )
  const constructors = captureSource.match(/new MediaRecorder\s*\(/g)?.length ?? 0
  check(
    'production capture keeps one MediaRecorder construction site',
    constructors === 1,
    `${constructors}`,
  )
  check(
    'dual slots are isolated behind the WebM fallback strategy',
    captureSource.includes("format.strategy === 'fragmented-mp4'") &&
      captureSource.includes('new WebmDualSlotRing({') &&
      !/\bconst\s+slots\b|\bfunction\s+rotateSlot\b|\bfunction\s+startSlot\b/.test(
        captureSource,
      ),
  )
  const holdAwareFlush =
    captureSource.match(
      /flushRecorderSession\(\s*session,\s*requestedAt,\s*!holdAfterCapture,\s*\)/,
    )?.index ?? -1
  const assemble = captureSource.indexOf('ring.assemble(requestedAt)')
  check(
    'a held MP4 replay flushes and assembles without starting its replacement encoder',
    holdAwareFlush >= 0 &&
      assemble > holdAwareFlush &&
      captureSource.includes('if (restartAfterFlush) startRecorder(session.generation)'),
  )
  check(
    'maintenance flush and replay requests share one serialized queue',
      captureSource.includes('recorderQueue = recorderQueue') &&
      captureSource.includes('recorderMaintenanceDecision({') &&
      captureSource.includes('await flushRecorderSession(session, nowMs)') &&
      /flushRecorderSession\(\s*session,\s*requestedAt,\s*!holdAfterCapture,\s*\)/.test(
        captureSource,
      ),
  )
  check(
    'only completed MP4 fragments refresh maintenance freshness; recurring partial boxes cannot defer flush forever',
    /const completedFragments = payload\.ring\.pushBytes\(\s*bytes,\s*payload\.endAtMs,\s*\)/.test(
      captureSource,
    ) &&
      captureSource.includes('if (completedFragments > 0)') &&
      captureSource.includes(
        'payload.session.lastFragmentAtMs = payload.endAtMs',
      ) &&
      !captureSource.includes('session.lastOutputAtMs = endAtMs') &&
      captureSource.includes("if (maintenance.action === 'reschedule')") &&
      captureSource.includes('scheduleMaintenanceFlush(session, maintenance.delayMs)') &&
      captureSource.includes("if (maintenance.action === 'retired') return") &&
      captureSource.includes('window.clearTimeout(session.flushTimer)'),
  )
  check(
    'replay assembly is skipped when the capture-instant flush fails',
    /const flushed = await flushRecorderSession\(\s*session,\s*requestedAt,\s*!holdAfterCapture,\s*\)/.test(
      captureSource,
    ) &&
      captureSource.indexOf('if (flushed) {') <
        captureSource.indexOf('const replay = ring.assemble(requestedAt)'),
  )
  check(
    'each recorder session schedules a bounded maintenance flush',
    captureSource.includes('scheduleMaintenanceFlush(session)') &&
      captureSource.includes(
        'Math.max(currentMp4FragmentIntervalMs(), segmentMs)',
      ),
  )
  check(
    'fragmented MP4 timeslices are backed by matching keyframe requests',
    captureSource.includes(
      'videoKeyFrameIntervalDuration: currentMp4FragmentIntervalMs()',
    ) &&
      captureSource.includes('recorder.start(currentMp4FragmentIntervalMs())') &&
      captureSource.includes('timesliceMs: WEBM_CHUNK_TIMESLICE_MS'),
  )
  check(
    'parser memory budget follows the configured encoder bitrate',
    captureSource.includes(
      'new FragmentedMp4Ring(segmentMs, VIDEO_BITS_PER_SECOND)',
    ),
  )
  check(
    'capture-time field diagnostics report bounded retained and selected fragment ownership',
    captureSource.includes('ringDiagnostics = {') &&
      captureSource.includes('retainedFragmentCount: stats.fragmentCount') &&
      mainCaptureSource.includes('payload.ringDiagnostics') &&
      mainCaptureSource.includes('ring retained'),
  )
  check(
    'Blob conversion backlog shares the ring retained-byte budget',
    captureSource.includes(
      'new BoundedBlobIngestQueue<RecorderIngestPayload>(',
    ) &&
      captureSource.includes('ring.stats().retainedBudgetBytes'),
  )
  check(
    'MP4 ingest capacity rejection fails the recorder session instead of continuing after a byte hole',
    captureSource.includes(
      'fragmented MP4 ingest budget exceeded; refusing to skip bytes in the recorder stream',
    ) &&
      captureSource.includes(
        'recorder stop batch exceeded the bounded ingest budget; refusing a discontinuous MP4 stream',
      ),
  )
  check(
    'recorder chunks use event time to distinguish backlog from the final flush',
    captureSource.includes(
      'const endAtMs = recorderChunkEndAtMs(',
    ) &&
      captureSource.includes('event.timeStamp'),
  )
  check(
    'stop-time backlog is staged and ingested as one capture-anchored batch',
    captureSource.includes('session.flushBatch = queue.createBatch()') &&
      captureSource.includes('batch.append(blob)') &&
      captureSource.includes('commitRecorderBatchBeforeReplacement('),
  )
  const flushRecorderStart = captureSource.indexOf(
    'async function flushRecorderSession(',
  )
  const replayRequestStart = captureSource.indexOf(
    'async function handleReplayRequest(',
    flushRecorderStart,
  )
  const flushRecorderSource = captureSource.slice(
    flushRecorderStart,
    replayRequestStart,
  )
  const oldBatchCommit = flushRecorderSource.indexOf(
    'commitRecorderBatchBeforeReplacement(',
  )
  const earlyReplacementArgument = flushRecorderSource.indexOf(
    'stopRecorderWithDeadline(',
  ) >= 0 && /stopRecorderWithDeadline\([\s\S]*?startReplacement[\s\S]*?\)/.test(
    flushRecorderSource.slice(
      flushRecorderSource.indexOf('stopRecorderWithDeadline('),
      flushRecorderSource.indexOf('if (!stopped)'),
    ),
  )
  check(
    'a delayed old stop commits its complete batch before replacement timeslices can enter the ingest queue',
    oldBatchCommit >= 0 && !earlyReplacementArgument,
  )
  const startCaptureAt = captureSource.indexOf(
    'async function startCapture(payload: CaptureStartPayload)',
  )
  const teardownAt = captureSource.indexOf('teardown()', startCaptureAt)
  const generationAt = captureSource.indexOf(
    'const generation = ++captureGeneration',
    startCaptureAt,
  )
  check(
    'every capture start retires the prior stream before acquiring another',
    startCaptureAt >= 0 && teardownAt > startCaptureAt && generationAt > teardownAt,
  )
  check(
    'a stale getDisplayMedia result cannot replace the current stream',
    captureSource.includes('let acquiredStream: MediaStream') &&
      captureSource.includes('if (generation !== captureGeneration) {') &&
      captureSource.includes(
        'for (const track of acquiredStream.getTracks()) track.stop()',
      ),
  )
  check(
    'the one alternate-backend recovery is generation-owned and circuit-broken',
    captureSource.includes('let nativeFallbackCircuitOpen = false') &&
      captureSource.includes('generation !== captureGeneration') &&
      captureSource.includes('nativeFallbackCircuitOpen = true') &&
      captureSource.includes('void startNativeFallbackCapture(payload, generation)') &&
      captureSource.includes("captureBackend === 'windows-gdi-bitblt'"),
  )
  check(
    'a missing recorder stop event cannot lock the queue forever',
    captureSource.includes('RECORDER_STOP_TIMEOUT_MS') &&
      captureSource.includes('MediaRecorder stop timed out') &&
      webmSource.includes('stopRecorderWithDeadline('),
  )
  check(
    'legal WebM runtimes start a real fallback instead of becoming screenshot-only',
    captureSource.includes("strategy === 'dual-slot-webm'") &&
      captureSource.includes('fallback.start()') &&
      !captureSource.includes('bounded replay unavailable'),
  )
  check(
    'stale MP4 ingest work is generation and ring-identity guarded',
    captureSource.includes(
      'payload.generation !== captureGeneration',
    ) &&
      captureSource.includes('replayRing !== payload.ring'),
  )
  check(
    'a new capture severs both stale ownership queues',
    captureSource.includes('ingestQueue?.cancel()') &&
      captureSource.includes('ingestQueue = null') &&
      captureSource.includes('recorderQueue = Promise.resolve()') &&
      captureSource.includes('const requestGeneration = captureGeneration') &&
      captureSource.includes('requestGeneration !== captureGeneration'),
  )
  check(
    'stale WebM callbacks are disposed and every stopped session releases handlers',
    webmSource.includes(
      'if (this.disposed || session.generation !== this.options.generation) return',
    ) &&
      webmSource.includes(
        'releaseRecorderReferences(recorder, session.chunks)',
      ),
  )
  const freezeStart = mainSessionSource.indexOf('async function freezeDisplays(')
  const freezeEnd = mainSessionSource.indexOf(
    'function physicalContextBounds(',
    freezeStart,
  )
  const freezeSource = mainSessionSource.slice(freezeStart, freezeEnd)
  const freezeReplayAt = freezeSource.indexOf('holdAfterCapture: true')
  const freezeSnapshotAt = freezeSource.indexOf('await takeDisplaySnapshots(')
  const freezeFinallyAt = freezeSource.indexOf('finally {')
  const freezeResumeAt = freezeSource.indexOf('resumeReplay(')
  check(
    'every display replay is held before the grouped full-native snapshot starts',
    freezeReplayAt >= 0 &&
      freezeSnapshotAt > freezeReplayAt &&
      freezeSource.includes('await Promise.all('),
  )
  check(
    'snapshot failure and cancellation resume every requested display in finally',
    freezeFinallyAt > freezeSnapshotAt && freezeResumeAt > freezeFinallyAt,
  )
  check(
    'the replay hold/resume token crosses the declared IPC and preload boundary',
    ipcSource.includes("captureResumeReplay: 'capture:resume-replay'") &&
      ipcSource.includes('export interface CaptureReplayRequestPayload') &&
      ipcSource.includes('export interface CaptureReplayResumePayload') &&
      capturePreloadSource.includes('onResumeReplay(') &&
      captureSource.includes('window.captureBridge.onResumeReplay('),
  )
  check(
    'a lost main-process resume is bounded by a renderer watchdog',
    captureSource.includes('REPLAY_HOLD_WATCHDOG_MS') &&
      captureSource.includes('resumeHeldReplay(requestId, requestGeneration') &&
      captureSource.includes('window.setTimeout('),
  )
  const resumeHandlerStart = captureSource.indexOf(
    'window.captureBridge.onResumeReplay(',
  )
  const resumeHandlerSource = captureSource.slice(resumeHandlerStart)
  const preResumeNoteAt = resumeHandlerSource.indexOf(
    'replayResumeTokens.note(requestId, requestGeneration)',
  )
  const resumeQueueAt = resumeHandlerSource.indexOf(
    'recorderQueue = recorderQueue',
  )
  check(
    'RESUME records its bounded tombstone synchronously before async recorderQueue work',
    captureSource.includes('new ReplayResumeTokenLedger({') &&
      captureSource.includes('maxEntries: 4') &&
      captureSource.includes('ttlMs: REPLAY_HOLD_WATCHDOG_MS') &&
      preResumeNoteAt >= 0 &&
      resumeQueueAt > preResumeNoteAt,
  )
  const enterHoldStart = captureSource.indexOf('function enterReplayHold(')
  const resumeHoldStart = captureSource.indexOf(
    'function resumeHeldReplay(',
    enterHoldStart,
  )
  const enterHoldSource = captureSource.slice(enterHoldStart, resumeHoldStart)
  const preResumeConsumeAt = enterHoldSource.indexOf(
    'replayResumeTokens.consume(requestId, requestGeneration)',
  )
  const watchdogArmAt = enterHoldSource.indexOf('hold.watchdog = window.setTimeout(')
  check(
    'a matching pre-resume is consumed before HOLD/watchdog and starts one fresh boundary',
    preResumeConsumeAt >= 0 &&
      watchdogArmAt > preResumeConsumeAt &&
      enterHoldSource.includes('discardHeldReplayStorage()') &&
      enterHoldSource.includes('installFreshReplayStorage(requestGeneration)'),
  )
  check(
    'capture teardown retires every pre-resume token with its generation',
    captureSource.includes('replayResumeTokens.clear()'),
  )
  check(
    'resume discards the held MP4/WebM owners before starting one empty fresh boundary',
    captureSource.includes('discardHeldReplayStorage()') &&
      captureSource.includes('installFreshReplayStorage(requestGeneration)') &&
      captureSource.indexOf('discardHeldReplayStorage()') <
        captureSource.indexOf('installFreshReplayStorage(requestGeneration)'),
  )
  check(
    'main imports the shared replay deadline instead of racing a local constant',
    mainSessionSource.includes(
      "import { REPLAY_TIMEOUT_MS } from '../shared/captureTimeouts'",
    ) &&
      !mainSessionSource.includes('const REPLAY_TIMEOUT_MS = 5_000') &&
      mainCaptureSource.includes(
        'const RECORDER_PROBE_TIMEOUT_MS = REPLAY_TIMEOUT_MS',
      ),
  )
  check(
    'main replay timeout strictly covers renderer stop plus assembly and IPC',
    REPLAY_TIMEOUT_MS ===
      RECORDER_STOP_TIMEOUT_MS + REPLAY_ASSEMBLY_IPC_SLACK_MS &&
      REPLAY_ASSEMBLY_IPC_SLACK_MS > 0 &&
      REPLAY_TIMEOUT_MS > RECORDER_STOP_TIMEOUT_MS,
    `${REPLAY_TIMEOUT_MS} <= ${RECORDER_STOP_TIMEOUT_MS} + slack`,
  )
}

void checkWebmFallbackLifecycle().catch((err: unknown) => {
  failed += 1
  console.error(err)
  process.exitCode = 1
})
