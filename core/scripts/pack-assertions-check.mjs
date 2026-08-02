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

function withReplay(manifest) {
  manifest.media.replay = 'replay.webm'
  manifest.media.replay_duration_ms = 3000
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

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
} finally {
  rmSync(work, { recursive: true, force: true })
}
