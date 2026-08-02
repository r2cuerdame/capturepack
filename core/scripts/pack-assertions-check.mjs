// The assertions CI makes about a produced pack, held to their own standard.
//
// scripts/assert-capturepack.mjs is the only thing standing between "CI made a
// pack" and "CI proved the pack is worth anything". An assertion that cannot
// fail is worse than no assertion at all — it is a green tick over a broken
// build — so every one of them is exercised here against a pack that should
// pass AND against a mutant that should not.
//
// The fixtures are built from examples/minimal, a real pack that the SPEC
// validator already accepts, so the positive case runs the whole path including
// tools/validate-capturepack.mjs. The replay containers are synthesized: what is
// being checked is whether the prober can tell media from a bare header, and a
// recorded file cannot answer that question because it only comes in one shape.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { announcementCount, assertPack, probeContainer } from './assert-capturepack.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const EXAMPLE = path.resolve(here, '..', '..', 'examples', 'minimal')
// examples/minimal ships a 640x400 snapshot against an illustrative
// 1920x1080 screen: it is a SPEC example, not a capture. The fixtures below
// declare the screen the snapshot actually is, which is what a real pack does.
const SNAPSHOT = { width: 640, height: 400 }

let passed = 0
let failed = 0

function check(name, condition, detail = '') {
  if (condition) passed += 1
  else failed += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

// --- container builders -----------------------------------------------------

function bytes(...values) {
  return Buffer.from(values)
}

function ebmlSize(length) {
  if (length < 0x7f) return bytes(0x80 | length)
  if (length < 0x3fff) return bytes(0x40 | (length >> 8), length & 0xff)
  return bytes(0x20 | (length >> 16), (length >> 8) & 0xff, length & 0xff)
}

function ebml(id, payload) {
  return Buffer.concat([Buffer.from(id), ebmlSize(payload.length), payload])
}

function uintPayload(value) {
  const out = []
  let remaining = value
  do {
    out.unshift(remaining & 0xff)
    remaining = Math.floor(remaining / 256)
  } while (remaining > 0)
  return Buffer.from(out)
}

/** A webm whose clusters carry `blockBytes` each, `count` of them, `stepMs` apart. */
function webm({ count, blockBytes, stepMs }) {
  const header = ebml([0x1a, 0x45, 0xdf, 0xa3], Buffer.alloc(4))
  const info = ebml([0x15, 0x49, 0xa9, 0x66], ebml([0x2a, 0xd7, 0xb1], uintPayload(1_000_000)))
  const clusters = []
  for (let index = 0; index < count; index += 1) {
    clusters.push(
      ebml(
        [0x1f, 0x43, 0xb6, 0x75],
        Buffer.concat([
          ebml([0xe7], uintPayload(index * stepMs)),
          ebml([0xa3], Buffer.alloc(blockBytes, 0x42)),
        ]),
      ),
    )
  }
  return Buffer.concat([header, ebml([0x18, 0x53, 0x80, 0x67], Buffer.concat([info, ...clusters]))])
}

function box(type, ...payload) {
  const body = Buffer.concat(payload)
  const head = Buffer.alloc(8)
  head.writeUInt32BE(8 + body.length, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, body])
}

function u32(value) {
  const out = Buffer.alloc(4)
  out.writeUInt32BE(value >>> 0, 0)
  return out
}

/** A fragmented MP4 — the shape the recorder writes when it picks AVC (#113). */
function fmp4({ count, mdatBytes, stepTicks, timescale = 90_000 }) {
  const moov = box(
    'moov',
    box('trak', box('mdia', box('mdhd', Buffer.from([0, 0, 0, 0]), u32(0), u32(0), u32(timescale), u32(0)))),
  )
  const fragments = []
  for (let index = 0; index < count; index += 1) {
    fragments.push(
      box('moof', box('traf', box('tfdt', Buffer.from([0, 0, 0, 0]), u32(index * stepTicks)))),
      box('mdat', Buffer.alloc(mdatBytes, 0x42)),
    )
  }
  return Buffer.concat([box('ftyp', Buffer.from('iso5mp42', 'latin1')), moov, ...fragments])
}

// A REAL PNG at an arbitrary size. The keyframe assertions read IHDR, but the
// SPEC validator opens these files too, so a fixture that is only a header
// would be testing the assertion against something no writer produces.
const PNG_CRC = new Int32Array(256)
for (let n = 0; n < 256; n += 1) {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  PNG_CRC[n] = c
}

function pngCrc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = PNG_CRC[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(pngCrc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** A decodable 8-bit greyscale PNG of exactly `width` x `height`. */
function png(width, height) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // greyscale
  // One filter byte (0 = None) per row, then the row's samples.
  const raw = Buffer.alloc(height * (width + 1))
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// --- pack fixtures ----------------------------------------------------------

const work = mkdtempSync(path.join(tmpdir(), 'capturepack-pack-assertions-'))

/**
 * A copy of examples/minimal with the manifest patched by `mutate`, so every
 * fixture is a pack the SPEC validator has an opinion about.
 */
function fixture(name, mutate, files = {}) {
  const dirPath = path.join(work, name)
  mkdirSync(dirPath, { recursive: true })
  cpSync(EXAMPLE, dirPath, { recursive: true })
  const manifestPath = path.join(dirPath, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.environment.screens = [{ width: SNAPSHOT.width, height: SNAPSHOT.height, scale: 1 }]
  mutate(manifest)
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  for (const [file, contents] of Object.entries(files)) writeFileSync(path.join(dirPath, file), contents)
  return dirPath
}

/**
 * A pack that carries a replay — and therefore says what produced it.
 *
 * The cadence is not decoration. A pack with a replay is now REQUIRED to name
 * its capture backend (see cadenceFindings), so a fixture that omits it is not
 * a pack this app would write. Capture provenance is a 0.4.0 field, so the
 * declaration comes with the version that expresses it (SPEC §5.3, §13.1).
 */
function withReplay(manifest) {
  manifest.format_version = '0.4.0'
  manifest.media.replay = 'replay.webm'
  manifest.media.replay_duration_ms = 3000
  manifest.media.cadence = {
    achieved_fps: 14.7,
    worst_stall_ms: 99,
    backend: 'chromium-desktop-capture',
    quality: 'full',
  }
}

function verdict(dirPath, options) {
  const findings = assertPack(dirPath, options)
  return {
    ok: findings.every((finding) => finding.ok),
    failures: findings.filter((finding) => !finding.ok).map((finding) => finding.text),
  }
}

try {
  console.log('pack assertions (#63)')

  // --- the container prober --------------------------------------------------

  const goodWebm = probeContainer(webm({ count: 4, blockBytes: 2000, stepMs: 1000 }))
  check(
    'a webm with media reports its payload, fragments and span',
    goodWebm.container === 'webm' && goodWebm.fragments === 4 && goodWebm.payloadBytes >= 8000 && Math.round(goodWebm.spanMs) === 3000,
    `${goodWebm.fragments} fragments, ${goodWebm.payloadBytes} bytes, ${Math.round(goodWebm.spanMs)} ms`,
  )
  const emptyWebm = probeContainer(webm({ count: 0, blockBytes: 0, stepMs: 0 }))
  check(
    'a webm that is only a container header reports no payload, no fragments, no span',
    emptyWebm.container === 'webm' && emptyWebm.fragments === 0 && emptyWebm.payloadBytes === 0 && emptyWebm.spanMs === 0,
    `${emptyWebm.fragments} fragments, ${emptyWebm.payloadBytes} bytes`,
  )
  const goodMp4 = probeContainer(fmp4({ count: 4, mdatBytes: 2000, stepTicks: 90_000 }))
  check(
    'a fragmented mp4 is measured from its tfdt timeline, not from mvhd',
    goodMp4.container === 'mp4' && goodMp4.fragments === 4 && goodMp4.payloadBytes >= 8000 && Math.round(goodMp4.spanMs) === 3000,
    `${goodMp4.fragments} fragments, ${goodMp4.payloadBytes} bytes, ${Math.round(goodMp4.spanMs)} ms`,
  )
  const emptyMp4 = probeContainer(fmp4({ count: 0, mdatBytes: 0, stepTicks: 0 }))
  check(
    'an mp4 with an initialization segment and no fragments carries nothing',
    emptyMp4.container === 'mp4' && emptyMp4.fragments === 0 && emptyMp4.payloadBytes === 0,
  )
  check(
    'a file that is neither is reported as unknown rather than guessed at',
    probeContainer(Buffer.from('not a video at all')).container === 'unknown',
  )

  // --- the announcement rule -------------------------------------------------

  const announcement = '[tray] announcing recorder failure (no-frames): the screen delivered no video frames'
  check('a quiet log announced nothing', announcementCount('[app] started\n[capture] ready\n') === 0)
  check('one announcement is counted once', announcementCount(`[app] started\n${announcement}\n`) === 1)
  check(
    'a log that announced the same outage twice is counted twice — that is the failure this catches',
    announcementCount(`${announcement}\n[capture] retrying\n${announcement}\n`) === 2,
  )

  // --- a pack that should pass -----------------------------------------------

  const good = fixture('good', withReplay, { 'replay.webm': webm({ count: 4, blockBytes: 2000, stepMs: 1000 }) })
  const goodVerdict = verdict(good, { expectReplay: true })
  check('a pack with a real replay passes every assertion', goodVerdict.ok, goodVerdict.failures.join(' | '))

  const goodLog = path.join(work, 'clean.log')
  writeFileSync(goodLog, '[app] started\n[capture] capture requested\n', 'utf8')
  check(
    'a run whose recorder worked is expected to have announced nothing',
    verdict(good, { expectReplay: true, logPath: goodLog }).ok,
  )

  // --- and the mutants that should not ---------------------------------------

  const headerOnly = fixture('header-only', withReplay, {
    'replay.webm': webm({ count: 0, blockBytes: 0, stepMs: 0 }),
  })
  const headerVerdict = verdict(headerOnly, { expectReplay: true })
  check(
    'a replay that is a container header and nothing else is rejected',
    !headerVerdict.ok && headerVerdict.failures.some((text) => text.includes('media payload')),
    headerVerdict.failures.join(' | '),
  )

  const oneFragment = fixture('one-fragment', withReplay, {
    'replay.webm': webm({ count: 1, blockBytes: 9000, stepMs: 0 }),
  })
  check(
    'a replay holding bytes but no time is rejected: one fragment spans nothing',
    !verdict(oneFragment, { expectReplay: true }).ok,
  )

  const overDeclared = fixture(
    'over-declared',
    (manifest) => {
      withReplay(manifest)
      manifest.media.replay_duration_ms = 30_000
    },
    { 'replay.webm': webm({ count: 4, blockBytes: 2000, stepMs: 1000 }) },
  )
  const overVerdict = verdict(overDeclared, { expectReplay: true })
  check(
    'a manifest declaring 30 s over a 3 s file is rejected',
    !overVerdict.ok && overVerdict.failures.some((text) => text.includes('spans')),
    overVerdict.failures.join(' | '),
  )

  const wrongScreen = fixture(
    'wrong-screen',
    (manifest) => {
      withReplay(manifest)
      manifest.environment.screens = [{ width: 1920, height: 1080, scale: 1 }]
    },
    { 'replay.webm': webm({ count: 4, blockBytes: 2000, stepMs: 1000 }) },
  )
  const screenVerdict = verdict(wrongScreen, { expectReplay: true })
  check(
    'a snapshot that is not the size of the display the manifest declares is rejected',
    !screenVerdict.ok && screenVerdict.failures.some((text) => text.includes('snapshot.png')),
    screenVerdict.failures.join(' | '),
  )

  const displayMismatch = fixture(
    'display-mismatch',
    (manifest) => {
      withReplay(manifest)
      manifest.environment.screens = [
        { width: SNAPSHOT.width, height: SNAPSHOT.height, scale: 1 },
        { width: 2560, height: 1440, scale: 1 },
      ]
      manifest.media.displays = [
        {
          index: 1,
          focused: true,
          bounds: { x: 0, y: 0, width: SNAPSHOT.width, height: SNAPSHOT.height },
          scale: 1,
          snapshot: 'snapshot.png',
          replay: 'replay.webm',
          replay_duration_ms: 3000,
        },
        {
          // Declares 1280x720 while environment.screens[1] says 2560x1440: the
          // two writers disagreed and a reader resolving index 2 gets a monitor
          // that was never there.
          index: 2,
          focused: false,
          bounds: { x: 640, y: 0, width: 1280, height: 720 },
          scale: 1,
          snapshot: 'snapshot-d2.png',
          replay: null,
        },
      ]
    },
    {
      'replay.webm': webm({ count: 4, blockBytes: 2000, stepMs: 1000 }),
      'snapshot-d2.png': readFileSync(path.join(EXAMPLE, 'snapshot.png')),
    },
  )
  const displayVerdict = verdict(displayMismatch, { expectReplay: true, runValidator: false })
  check(
    'a media.displays entry that disagrees with environment.screens is rejected',
    !displayVerdict.ok && displayVerdict.failures.some((text) => text.includes('resolves to environment.screens')),
    displayVerdict.failures.join(' | '),
  )

  const strayIndex = fixture(
    'stray-index',
    (manifest) => {
      withReplay(manifest)
      manifest.media.displays = [
        {
          index: 4,
          focused: true,
          bounds: { x: 0, y: 0, width: SNAPSHOT.width, height: SNAPSHOT.height },
          scale: 1,
          snapshot: 'snapshot.png',
          replay: 'replay.webm',
          replay_duration_ms: 3000,
        },
      ]
    },
    { 'replay.webm': webm({ count: 4, blockBytes: 2000, stepMs: 1000 }) },
  )
  check(
    'a display index with no screen behind it is rejected',
    !verdict(strayIndex, { expectReplay: true, runValidator: false }).ok,
  )

  // --- the capture path a pack was produced by (#135, #62) --------------------
  //
  // THE RULE THIS PINS WAS WRONG FOR ONE RELEASE, AND CI IS WHAT SAID SO.
  //
  // It read "a pack that carries a replay names its backend", on the reasoning
  // that a writer always knows which path it chose. It does — and it has nowhere
  // legal to put it. `backend` rides INSIDE `media.cadence`, whose `achieved_fps`
  // and `worst_stall_ms` are REQUIRED by SPEC §5.3, and the writer omits the
  // whole cadence when nothing could be measured because the same section forbids
  // reporting a rate nobody measured. A 1144 ms replay on a CI runner did exactly
  // that and turned the job red over a correct pack.
  //
  // What survives is the invariant the writer really guarantees: every cadence it
  // builds carries a backend. So an absent cadence is accepted and a cadence
  // without a backend is not — which is the case a regression would actually
  // produce.
  const noCadence = fixture(
    'no-cadence',
    (manifest) => {
      withReplay(manifest)
      delete manifest.media.cadence
    },
    { 'replay.webm': webm({ count: 4, blockBytes: 2000, stepMs: 1000 }) },
  )
  const noCadenceVerdict = verdict(noCadence, { expectReplay: true })
  check(
    'a replay whose rate could not be measured declares no cadence, and that is accepted',
    noCadenceVerdict.ok,
    noCadenceVerdict.failures.join(' | '),
  )

  const anonymousCadence = fixture(
    'anonymous-cadence',
    (manifest) => {
      withReplay(manifest)
      delete manifest.media.cadence.backend
    },
    { 'replay.webm': webm({ count: 4, blockBytes: 2000, stepMs: 1000 }) },
  )
  const anonymousVerdict = verdict(anonymousCadence, { expectReplay: true })
  check(
    'but a cadence that measured a rate and will not say which path produced it is rejected',
    !anonymousVerdict.ok && anonymousVerdict.failures.some((text) => text.includes('media.cadence.backend')),
    anonymousVerdict.failures.join(' | '),
  )

  const inventedBackend = fixture(
    'invented-backend',
    (manifest) => {
      withReplay(manifest)
      manifest.media.cadence.backend = 'wishful-thinking'
    },
    { 'replay.webm': webm({ count: 4, blockBytes: 2000, stepMs: 1000 }) },
  )
  check(
    'a backend that is not one of the two real capture paths is rejected',
    !verdict(inventedBackend, { expectReplay: true, runValidator: false }).ok,
  )

  const gdiFallback = fixture(
    'gdi-fallback',
    (manifest) => {
      withReplay(manifest)
      manifest.media.cadence.backend = 'windows-gdi-bitblt'
      // A fallback must not call itself full quality (SPEC §5.3).
      manifest.media.cadence.quality = 'degraded'
    },
    { 'replay.webm': webm({ count: 4, blockBytes: 2000, stepMs: 1000 }) },
  )
  const gdiVerdict = verdict(gdiFallback, { expectReplay: true })
  check(
    'the GDI fallback is a working capture and passes — the assertion names the path, it does not dictate one',
    gdiVerdict.ok,
    gdiVerdict.failures.join(' | '),
  )

  const cadenceWithoutReplay = fixture('cadence-without-replay', (manifest) => {
    manifest.format_version = '0.4.0'
    manifest.media.cadence = {
      achieved_fps: 14.7,
      worst_stall_ms: 99,
      backend: 'chromium-desktop-capture',
    }
  })
  check(
    'a screenshot-only pack that declares a cadence anyway is rejected — there are no bytes for it to describe',
    !verdict(cadenceWithoutReplay, { expectReplay: false, runValidator: false }).ok,
  )

  // --- the annotated stills (#133, #135) -------------------------------------
  //
  // A keyframe declares the size of ITS OWN file, which is legitimately taller
  // than the snapshot: a box on the bottom edge grows the still downward to hold
  // its label (SPEC §5.7). Every assertion below is therefore against the
  // DECLARATION, with the snapshot used only for the two things the gutter rule
  // does fix — the width, and that the height may only ever grow.

  function withKeyframes(entries) {
    return (manifest) => {
      withReplay(manifest)
      manifest.media.keyframes = entries
    }
  }

  const framesFile = 'frames/frame-01_00-03.000.png'

  const noKeyframes = fixture('no-keyframes', withReplay, {
    'replay.webm': webm({ count: 4, blockBytes: 2000, stepMs: 1000 }),
  })
  check(
    'a pack asserted at its source boundary declares no stills, and that is not a defect',
    verdict(noKeyframes, { expectReplay: true }).ok,
  )
  const demandedVerdict = verdict(noKeyframes, { expectReplay: true, expectKeyframes: true })
  check(
    'the same pack fails when the run waited for the render — then the stills were owed',
    !demandedVerdict.ok && demandedVerdict.failures.some((text) => text.includes('waited for the derived render')),
    demandedVerdict.failures.join(' | '),
  )

  function keyframePack(name, entries, files) {
    const dirPath = fixture(name, withKeyframes(entries), {
      'replay.webm': webm({ count: 4, blockBytes: 2000, stepMs: 1000 }),
    })
    mkdirSync(path.join(dirPath, 'frames'), { recursive: true })
    for (const [file, contents] of Object.entries(files)) {
      writeFileSync(path.join(dirPath, file), contents)
    }
    return dirPath
  }

  const exactStill = keyframePack(
    'keyframe-exact',
    [{ file: framesFile, t_ms: 3000, width: SNAPSHOT.width, height: SNAPSHOT.height }],
    { [framesFile]: png(SNAPSHOT.width, SNAPSHOT.height) },
  )
  const exactVerdict = verdict(exactStill, { expectReplay: true, expectKeyframes: true, runValidator: false })
  check(
    'a still that is exactly what it declares passes, and satisfies --expect-keyframes',
    exactVerdict.ok,
    exactVerdict.failures.join(' | '),
  )

  const gutterStill = keyframePack(
    'keyframe-gutter',
    [{ file: framesFile, t_ms: 3000, width: SNAPSHOT.width, height: SNAPSHOT.height + 64 }],
    { [framesFile]: png(SNAPSHOT.width, SNAPSHOT.height + 64) },
  )
  const gutterVerdict = verdict(gutterStill, { expectReplay: true, expectKeyframes: true, runValidator: false })
  check(
    'a still TALLER than the snapshot passes — the label gutter is legal and is why the declaration exists',
    gutterVerdict.ok,
    gutterVerdict.failures.join(' | '),
  )

  const lyingStill = keyframePack(
    'keyframe-lying',
    [{ file: framesFile, t_ms: 3000, width: SNAPSHOT.width, height: SNAPSHOT.height }],
    { [framesFile]: png(SNAPSHOT.width, SNAPSHOT.height + 64) },
  )
  const lyingVerdict = verdict(lyingStill, { expectReplay: true, runValidator: false })
  check(
    'a still whose file is not the size it declares is rejected — this is the whole point of #133',
    !lyingVerdict.ok && lyingVerdict.failures.some((text) => text.includes('on disk and declares')),
    lyingVerdict.failures.join(' | '),
  )

  const undeclaredSize = keyframePack(
    'keyframe-undeclared-size',
    [{ file: framesFile, t_ms: 3000 }],
    { [framesFile]: png(SNAPSHOT.width, SNAPSHOT.height) },
  )
  const undeclaredVerdict = verdict(undeclaredSize, { expectReplay: true, runValidator: false })
  check(
    'a still that declares no size of its own is rejected — a reader would have to assume the reference frame',
    !undeclaredVerdict.ok && undeclaredVerdict.failures.some((text) => text.includes('declares its own size')),
    undeclaredVerdict.failures.join(' | '),
  )

  const shrunkStill = keyframePack(
    'keyframe-shrunk',
    [{ file: framesFile, t_ms: 3000, width: SNAPSHOT.width, height: SNAPSHOT.height - 40 }],
    { [framesFile]: png(SNAPSHOT.width, SNAPSHOT.height - 40) },
  )
  const shrunkVerdict = verdict(shrunkStill, { expectReplay: true, runValidator: false })
  check(
    'a still SHORTER than the source frame is rejected — the gutter only ever grows downward',
    !shrunkVerdict.ok && shrunkVerdict.failures.some((text) => text.includes('at (0,0) unscaled')),
    shrunkVerdict.failures.join(' | '),
  )

  const scaledStill = keyframePack(
    'keyframe-scaled',
    [{ file: framesFile, t_ms: 3000, width: SNAPSHOT.width / 2, height: SNAPSHOT.height / 2 }],
    { [framesFile]: png(SNAPSHOT.width / 2, SNAPSHOT.height / 2) },
  )
  check(
    'a still scaled down from the source frame is rejected — annotation coordinates would no longer apply',
    !verdict(scaledStill, { expectReplay: true, runValidator: false }).ok,
  )

  const missingStill = fixture(
    'keyframe-missing',
    withKeyframes([{ file: framesFile, t_ms: 3000, width: SNAPSHOT.width, height: SNAPSHOT.height }]),
    { 'replay.webm': webm({ count: 4, blockBytes: 2000, stepMs: 1000 }) },
  )
  const missingVerdict = verdict(missingStill, { expectReplay: true, runValidator: false })
  check(
    'a declared still that is not in the pack is rejected',
    !missingVerdict.ok && missingVerdict.failures.some((text) => text.includes('missing from the pack')),
    missingVerdict.failures.join(' | '),
  )

  // --- the honest-failure path (--simulate-no-frames) ------------------------

  const screenshotOnly = fixture('screenshot-only', () => {})
  const noReplayVerdict = verdict(screenshotOnly, { expectReplay: false })
  check(
    'a pack that states the replay is unavailable passes the no-frames assertions',
    noReplayVerdict.ok,
    noReplayVerdict.failures.join(' | '),
  )
  check(
    'the same pack fails when a replay was expected — the two modes cannot both be satisfied',
    !verdict(screenshotOnly, { expectReplay: true }).ok,
  )

  const orphanReplay = fixture('orphan-replay', () => {}, {
    'replay.webm': webm({ count: 4, blockBytes: 2000, stepMs: 1000 }),
  })
  check(
    'a pack declaring no replay while a replay file sits beside it is rejected',
    !verdict(orphanReplay, { expectReplay: false, runValidator: false }).ok,
  )

  const explained = '[capture] display 1: no replay for this capture (no-frames) — the pack keeps its frozen frame only'
  const noFramesLog = path.join(work, 'no-frames.log')
  writeFileSync(noFramesLog, `[app] started\n${announcement}\n${explained}\n`, 'utf8')
  check(
    'a no-frames run that announced the outage once and explained the missing replay passes',
    verdict(screenshotOnly, { expectReplay: false, logPath: noFramesLog }).ok,
  )
  const rescuedLog = path.join(work, 'rescued.log')
  writeFileSync(
    rescuedLog,
    `[capture] display 1: primary replay failure confirmed; starting the independent windows-gdi-bitblt source\n${explained}\n`,
    'utf8',
  )
  check(
    'a run the GDI fallback rescued announces nothing and still passes — there was no outage left to announce',
    verdict(screenshotOnly, { expectReplay: false, logPath: rescuedLog }).ok,
  )
  const naggingLog = path.join(work, 'nagging.log')
  writeFileSync(naggingLog, `${announcement}\n${explained}\n${announcement}\n`, 'utf8')
  const naggingVerdict = verdict(screenshotOnly, { expectReplay: false, logPath: naggingLog })
  check(
    'a run that announced the same outage twice is rejected — that is the nagging this rule exists to stop',
    !naggingVerdict.ok && naggingVerdict.failures.some((text) => text.includes('at most once')),
    naggingVerdict.failures.join(' | '),
  )
  const silentLog = path.join(work, 'silent.log')
  writeFileSync(silentLog, '[app] started\n[capture] capture requested\n', 'utf8')
  const silentVerdict = verdict(screenshotOnly, { expectReplay: false, logPath: silentLog })
  check(
    'a run that produced no replay and never said why is rejected — silence is not absence',
    !silentVerdict.ok && silentVerdict.failures.some((text) => text.includes('said WHY')),
    silentVerdict.failures.join(' | '),
  )
  check(
    'a run that knows its recorder stayed down can still demand exactly one announcement',
    verdict(screenshotOnly, { expectReplay: false, logPath: noFramesLog, expectAnnouncements: 1 }).ok &&
      !verdict(screenshotOnly, { expectReplay: false, logPath: rescuedLog, expectAnnouncements: 1 }).ok,
  )
  const healthyNoisyLog = path.join(work, 'healthy-noisy.log')
  writeFileSync(healthyNoisyLog, `[app] started\n${announcement}\n`, 'utf8')
  check(
    'a run that produced a replay and still announced a failure is rejected',
    !verdict(good, { expectReplay: true, logPath: healthyNoisyLog }).ok,
  )

  // --- and the job that is supposed to run all of this ------------------------
  //
  // An assertion nothing invokes is an assertion that runs never — the same
  // reason every check here is wired into package.json. The workflow is the
  // only caller of assert-capturepack.mjs that matters, and it is edited by
  // people who are not thinking about this file.
  const workflow = readFileSync(path.resolve(here, '..', '..', '.github', 'workflows', 'ci.yml'), 'utf8')
  check('CI captures a pack unattended', workflow.includes('--capture-now=') && workflow.includes('--save-now='))
  check(
    'CI gives that capture its own user-data and output directories',
    workflow.includes('--user-data-dir=') && workflow.includes('--output-dir='),
    'a shared user-data directory would collide with the single-instance lock',
  )
  check(
    'CI does not take the real capture accelerator on a shared runner',
    workflow.includes('--no-global-shortcut'),
  )
  check(
    'CI asserts on the pack it produced, in both endings',
    workflow.includes('assert-capturepack.mjs') &&
      workflow.includes('--expect-replay') &&
      workflow.includes('--expect-no-replay'),
  )
  check('CI exercises the starved recorder too', workflow.includes('--simulate-no-frames'))
  // A pack CI has ever seen used to be a SOURCE pack, so media.keyframes — and
  // with it #133's whole contract — had no end-to-end coverage at all. The only
  // way to get one is to wait for the render, which is what --await-render buys.
  check(
    'CI also captures a pack that waited for its derived render',
    workflow.includes('--await-render'),
  )
  check(
    'and asserts that the rendered pack really carries its stills',
    workflow.includes('--expect-keyframes'),
    'without this the render is waited for and then never looked at',
  )

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
} finally {
  rmSync(work, { recursive: true, force: true })
}
