#!/usr/bin/env node
/**
 * assert-capturepack.mjs — what a produced pack has to be, not merely how it is
 * shaped (#63).
 *
 * `tools/validate-capturepack.mjs` answers "is this a legal CapturePack?" and
 * it is run first, from here, because everything below assumes a legal one. It
 * cannot answer the questions this file exists for, and none of them are
 * hypothetical:
 *
 *   - A replay that is a container header and nothing else is a perfectly legal
 *     pack. It is also the exact shape a recording that never received a frame
 *     leaves behind, and it has shipped before.
 *   - A snapshot that does not match the display the manifest declares means
 *     every annotation coordinate in the pack points somewhere else.
 *   - `media.displays[]` and `environment.screens` are written by two different
 *     places on the way out. When they disagree, a reader that resolves a
 *     display index gets the wrong monitor and never finds out.
 *
 * WHEN THE DERIVED MEDIA IS ASSERTED, AND WHEN IT IS NOT. `--save-now` exits
 * when SOURCE-first save has published the pack; the annotated replay, the
 * keyframe stills and the exact ring cut start on the next turn of the event
 * loop and are abandoned by that exit (see src/main/saveNow.ts). So by default
 * a pack that declares no `media.keyframes` is a pack that was asserted at its
 * source boundary, and that is a PASS. It also means the replay ON DISK may be
 * the raw ring segment, which is LONGER than the duration the manifest
 * declares — hence the span check is "carries at least what it declares", never
 * "matches exactly".
 *
 * What is NOT optional is a keyframe that IS declared. `--expect-keyframes`
 * says the run waited for the render (`--await-render`) and the stills must be
 * there; either way every declared still is opened and held to the size it
 * declares. A keyframe is legitimately TALLER than the snapshot — it grows
 * downward to hold the labels of bottom-edge boxes (SPEC §5.7, #133) — so the
 * check is against the DECLARED size, never against the snapshot's.
 *
 * Usage:
 *   node scripts/assert-capturepack.mjs <pack-dir> [options]
 *
 *   --expect-replay          (default) the pack must carry a real replay
 *   --expect-no-replay       the pack must STATE that the replay is unavailable
 *                            (the --simulate-no-frames path)
 *   --expect-keyframes       the derived render was waited for, so the stills
 *                            must be declared as well as correct
 *   --log <file>             main.log to hold to the announcement rule
 *   --expect-announcements <n>
 *                            demand an exact announcement count, for a run that
 *                            knows how its recorder ended
 *   --min-replay-ms <n>      floor for the declared replay (default 1000)
 *   --min-payload-bytes <n>  floor for media payload in the container (default 4096)
 *
 * Exit: 0 = every assertion held, 1 = at least one did not, 2 = usage/IO error.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VALIDATOR = path.resolve(HERE, '..', '..', 'tools', 'validate-capturepack.mjs')

// A recording that produced frames carries at least this much block payload and
// at least this many separately timestamped fragments. Both floors are far
// below any genuine capture and far above an empty container: a webm holding
// nothing but EBML/Segment/Info is under 2 KB and has zero clusters.
const DEFAULT_MIN_PAYLOAD_BYTES = 4096
const DEFAULT_MIN_FRAGMENTS = 2
const DEFAULT_MIN_REPLAY_MS = 1000
// One recorder timeslice plus slack. The measured span runs from the first
// fragment's timestamp to the last one's, so it is short by whatever the final
// fragment itself contains — never by more than one timeslice.
const SPAN_TOLERANCE_MS = 1500

// The line tray.ts writes whenever it announces a recorder failure. It is
// logged precisely so the "announced exactly once" guarantee stays checkable
// after the balloon has faded; this is the other end of that promise.
const FAILURE_ANNOUNCEMENT = '[tray] announcing recorder failure'
// What capture.ts says when a capture has no replay to give. GOAL "Silence is
// not absence": a pack that is quietly screenshot-only is indistinguishable
// from a bug, so the run has to name the reason even when it recovered.
const REPLAY_UNAVAILABLE = 'no replay for this capture ('

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

/** PNG IHDR is fixed-position: the first chunk of every legal PNG. */
export function pngSize(bytes) {
  if (bytes.length < 24) return null
  if (bytes.readUInt32BE(0) !== 0x89504e47 || bytes.readUInt32BE(4) !== 0x0d0a1a0a) return null
  if (bytes.toString('latin1', 12, 16) !== 'IHDR') return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function readVint(bytes, at, stripMarker) {
  if (at >= bytes.length) return null
  const first = bytes[at]
  if (first === 0) return null
  let length = 1
  for (let mask = 0x80; (first & mask) === 0; mask >>= 1) length += 1
  if (length > 8 || at + length > bytes.length) return null
  let value = stripMarker ? BigInt(first & ((1 << (8 - length)) - 1)) : BigInt(first)
  let allOnes = stripMarker && (first & ((1 << (8 - length)) - 1)) === (1 << (8 - length)) - 1
  for (let i = 1; i < length; i += 1) {
    value = (value << 8n) | BigInt(bytes[at + i])
    if (bytes[at + i] !== 0xff) allOnes = false
  }
  return { value, length, unknown: allOnes }
}

// EBML ids, marker byte included — the form they appear in on the wire.
const EBML_HEADER = 0x1a45dfa3
const SEGMENT = 0x18538067
const INFO = 0x1549a966
const TIMECODE_SCALE = 0x2ad7b1
const DURATION = 0x4489
const CLUSTER = 0x1f43b675
const CLUSTER_TIMECODE = 0xe7
const SIMPLE_BLOCK = 0xa3
const BLOCK_GROUP = 0xa0
const BLOCK = 0xa1

/**
 * Walks a WebM far enough to answer "does this carry media, and over how long".
 *
 * MediaRecorder writes LIVE webm: the Segment (and often each Cluster) declares
 * an unknown size, and Info.Duration is usually absent because the writer never
 * seeks back. Cluster timecodes are what survives that, so they are what the
 * span is measured from. An unknown-size master is walked to the end of its
 * parent, which puts later clusters syntactically inside the first one — every
 * element this cares about is collected globally, so the answer is the same.
 */
function walkWebm(bytes, start, end, found, depth) {
  let at = start
  while (at < end && depth < 256) {
    const id = readVint(bytes, at, false)
    if (id === null) return
    const size = readVint(bytes, at + id.length, true)
    if (size === null) return
    const dataAt = at + id.length + size.length
    const dataEnd = size.unknown ? end : dataAt + Number(size.value)
    if (dataEnd > end || dataEnd < dataAt) return
    const element = Number(id.value)
    if (element === SEGMENT || element === INFO || element === CLUSTER || element === BLOCK_GROUP) {
      if (element === CLUSTER) found.fragments += 1
      walkWebm(bytes, dataAt, dataEnd, found, depth + 1)
    } else if (element === TIMECODE_SCALE) {
      let scale = 0
      for (let i = dataAt; i < dataEnd; i += 1) scale = scale * 256 + bytes[i]
      if (scale > 0) found.timecodeScaleNs = scale
    } else if (element === DURATION) {
      if (dataEnd - dataAt === 4) found.declaredDuration = bytes.readFloatBE(dataAt)
      else if (dataEnd - dataAt === 8) found.declaredDuration = bytes.readDoubleBE(dataAt)
    } else if (element === CLUSTER_TIMECODE) {
      let timecode = 0
      for (let i = dataAt; i < dataEnd; i += 1) timecode = timecode * 256 + bytes[i]
      found.firstTimecode = found.firstTimecode === null ? timecode : Math.min(found.firstTimecode, timecode)
      found.lastTimecode = found.lastTimecode === null ? timecode : Math.max(found.lastTimecode, timecode)
    } else if (element === SIMPLE_BLOCK || element === BLOCK) {
      found.payloadBytes += dataEnd - dataAt
    }
    if (size.unknown && element !== SEGMENT && element !== CLUSTER && element !== BLOCK_GROUP) return
    if (size.unknown) return // the recursion above already consumed the rest
    at = dataEnd
  }
}

function probeWebm(bytes) {
  const found = {
    fragments: 0,
    payloadBytes: 0,
    timecodeScaleNs: 1_000_000,
    declaredDuration: null,
    firstTimecode: null,
    lastTimecode: null,
  }
  walkWebm(bytes, 0, bytes.length, found, 0)
  const msPerTick = found.timecodeScaleNs / 1_000_000
  const clusterSpan =
    found.firstTimecode === null || found.lastTimecode === null
      ? 0
      : (found.lastTimecode - found.firstTimecode) * msPerTick
  const declared = found.declaredDuration === null ? 0 : found.declaredDuration * msPerTick
  return {
    container: 'webm',
    fragments: found.fragments,
    payloadBytes: found.payloadBytes,
    spanMs: Math.max(clusterSpan, declared),
  }
}

function walkMp4(bytes, start, end, found, depth) {
  let at = start
  while (at + 8 <= end && depth < 64) {
    let size = bytes.readUInt32BE(at)
    const type = bytes.toString('latin1', at + 4, at + 8)
    let header = 8
    if (size === 1) {
      if (at + 16 > end) return
      size = Number(bytes.readBigUInt64BE(at + 8))
      header = 16
    } else if (size === 0) {
      size = end - at
    }
    if (size < header || at + size > end) return
    const dataAt = at + header
    const boxEnd = at + size
    if (type === 'moov' || type === 'trak' || type === 'mdia' || type === 'moof' || type === 'traf') {
      if (type === 'moof') found.fragments += 1
      walkMp4(bytes, dataAt, boxEnd, found, depth + 1)
    } else if (type === 'mdhd') {
      const version = bytes[dataAt]
      const offset = dataAt + (version === 1 ? 20 : 12)
      if (offset + 4 <= boxEnd) {
        const timescale = bytes.readUInt32BE(offset)
        if (timescale > 0 && found.timescale === null) found.timescale = timescale
      }
    } else if (type === 'tfdt') {
      const version = bytes[dataAt]
      const offset = dataAt + 4
      const decodeTime =
        version === 1
          ? offset + 8 <= boxEnd
            ? Number(bytes.readBigUInt64BE(offset))
            : null
          : offset + 4 <= boxEnd
            ? bytes.readUInt32BE(offset)
            : null
      if (decodeTime !== null) {
        found.firstDecodeTime = found.firstDecodeTime === null ? decodeTime : Math.min(found.firstDecodeTime, decodeTime)
        found.lastDecodeTime = found.lastDecodeTime === null ? decodeTime : Math.max(found.lastDecodeTime, decodeTime)
      }
    } else if (type === 'mdat') {
      found.payloadBytes += boxEnd - dataAt
    }
    at = boxEnd
  }
}

/**
 * The MP4 the recorder writes is FRAGMENTED (#113): mvhd carries duration 0 and
 * the timeline lives in the fragments, so the span is measured from the first
 * and last `tfdt` rather than from the movie header.
 */
function probeMp4(bytes) {
  const found = {
    fragments: 0,
    payloadBytes: 0,
    timescale: null,
    firstDecodeTime: null,
    lastDecodeTime: null,
  }
  walkMp4(bytes, 0, bytes.length, found, 0)
  const timescale = found.timescale ?? 1000
  const spanMs =
    found.firstDecodeTime === null || found.lastDecodeTime === null
      ? 0
      : ((found.lastDecodeTime - found.firstDecodeTime) / timescale) * 1000
  return { container: 'mp4', fragments: found.fragments, payloadBytes: found.payloadBytes, spanMs }
}

/** What a replay file actually holds: container, media payload, fragments, span. */
export function probeContainer(bytes) {
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === EBML_HEADER) return probeWebm(bytes)
  if (bytes.length >= 8 && bytes.toString('latin1', 4, 8) === 'ftyp') return probeMp4(bytes)
  return { container: 'unknown', fragments: 0, payloadBytes: 0, spanMs: 0 }
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/**
 * How many times this log announced a recorder failure.
 *
 * GOAL "A failure is always announced" is two promises, and the second is the
 * one that is easy to break: ONE balloon per failure episode, not one per retry
 * cycle. A recorder that cannot see the screen retries every few seconds
 * forever, so an ungated announcement is a notification every few seconds
 * forever — which users read as the app being broken rather than the screen.
 */
export function announcementCount(logText) {
  return logText.split('\n').filter((line) => line.includes(FAILURE_ANNOUNCEMENT)).length
}

/**
 * The displays a pack declares against the screens it says were there.
 *
 * `environment.screens[]` is physical pixels; `media.displays[].bounds` is
 * device-independent pixels with the scale that converts them. They are written
 * from two different snapshots of the display list, so "index N means the same
 * monitor in both" is a real thing to check rather than a tautology.
 */
export function displayScreenFindings(manifest) {
  const findings = []
  const screens = manifest?.environment?.screens
  const displays = manifest?.media?.displays
  if (!Array.isArray(screens) || screens.length === 0) {
    findings.push({ ok: false, text: 'environment.screens is missing or empty — nothing places a display index' })
    return findings
  }
  if (displays === undefined) {
    // Legal only below format 0.7.0, where media.displays became REQUIRED for a
    // video capture (SPEC §5.6, §13.1) — and always legal for an image pack,
    // which ships no per-display raster. Read as ONE display, the focused one.
    findings.push({
      ok: true,
      text:
        `no media.displays (pre-0.7.0 or image pack): read as ONE display, the focused one; ` +
        `${screens.length} screen(s) declared`,
    })
    return findings
  }
  if (!Array.isArray(displays) || displays.length === 0) {
    findings.push({ ok: false, text: 'media.displays is declared but is not a non-empty array' })
    return findings
  }
  const focused = displays.filter((display) => display.focused === true)
  findings.push({
    ok: focused.length === 1,
    text: `media.displays declares exactly one focused display (found ${focused.length})`,
  })
  for (const display of displays) {
    const index = display.index
    const screen = Number.isInteger(index) && index >= 1 ? screens[index - 1] : undefined
    if (screen === undefined) {
      findings.push({
        ok: false,
        text: `media.displays[].index ${JSON.stringify(index)} names no environment.screens entry (${screens.length} declared)`,
      })
      continue
    }
    const expectedWidth = Math.round(display.bounds?.width * display.scale)
    const expectedHeight = Math.round(display.bounds?.height * display.scale)
    const agrees =
      screen.scale === display.scale &&
      Math.abs(expectedWidth - screen.width) <= 1 &&
      Math.abs(expectedHeight - screen.height) <= 1
    findings.push({
      ok: agrees,
      text:
        `media.displays[index ${index}] ${display.bounds?.width}x${display.bounds?.height}@${display.scale} ` +
        `resolves to environment.screens[${index - 1}] ${screen.width}x${screen.height}@${screen.scale}`,
    })
  }
  return findings
}

/**
 * The size the manifest declares for the pack's own snapshot.png.
 *
 * The FOCUSED entry's own snapshot_width/snapshot_height answer first from
 * format 0.7.0 (SPEC §5.6): they describe that exact file, while
 * environment.screens describes the hardware and is derived through the same
 * bounds x scale rounding the declaration replaced. The screens fallback is for
 * packs written before the field existed.
 */
export function declaredSnapshotSize(manifest) {
  const screens = manifest?.environment?.screens
  const displays = manifest?.media?.displays
  if (Array.isArray(displays)) {
    const focused = displays.find((display) => display.focused === true)
    if (
      Number.isInteger(focused?.snapshot_width) && focused.snapshot_width >= 1 &&
      Number.isInteger(focused?.snapshot_height) && focused.snapshot_height >= 1
    ) {
      return { width: focused.snapshot_width, height: focused.snapshot_height }
    }
    if (!Array.isArray(screens) || screens.length === 0) return null
    const screen = focused === undefined ? undefined : screens[focused.index - 1]
    if (screen !== undefined) return { width: screen.width, height: screen.height }
    return null
  }
  if (!Array.isArray(screens) || screens.length === 0) return null
  return { width: screens[0].width, height: screens[0].height }
}

function replayFindings(dirPath, manifest, options) {
  const findings = []
  const declaredFile = manifest?.media?.replay ?? null
  const declaredMs = manifest?.media?.replay_duration_ms ?? null

  if (!options.expectReplay) {
    // "The pack STATES the replay is unavailable" — asserted on the manifest and
    // on the folder rather than on the prose, because the pack documents are
    // written in the user's language and an English phrase would make this
    // assertion a locale test.
    findings.push({ ok: declaredFile === null, text: `media.replay is null (got ${JSON.stringify(declaredFile)})` })
    findings.push({
      ok: declaredMs === null || declaredMs === undefined,
      text: `media.replay_duration_ms is null/absent (got ${JSON.stringify(declaredMs)})`,
    })
    const strays = readdirSync(dirPath).filter((name) => /^replay(_annotated)?(-d\d+)?\.(webm|mp4)$/.test(name))
    findings.push({
      ok: strays.length === 0,
      text: `no replay file is left in a pack that declares none (found ${strays.length ? strays.join(', ') : 'none'})`,
    })
    return findings
  }

  if (typeof declaredFile !== 'string') {
    findings.push({ ok: false, text: `media.replay MUST name a replay file (got ${JSON.stringify(declaredFile)})` })
    return findings
  }
  findings.push({
    ok: Number.isFinite(declaredMs) && declaredMs >= options.minReplayMs,
    text: `media.replay_duration_ms ${JSON.stringify(declaredMs)} is at least ${options.minReplayMs} ms`,
  })
  const replayPath = path.join(dirPath, declaredFile)
  if (!existsSync(replayPath)) {
    findings.push({ ok: false, text: `${declaredFile} is declared but missing from the pack` })
    return findings
  }
  const probe = probeContainer(readFileSync(replayPath))
  findings.push({ ok: probe.container !== 'unknown', text: `${declaredFile} is a readable ${probe.container} container` })
  findings.push({
    ok: probe.payloadBytes >= options.minPayloadBytes,
    text: `${declaredFile} carries ${probe.payloadBytes} bytes of media payload (>= ${options.minPayloadBytes}: more than a container header)`,
  })
  findings.push({
    ok: probe.fragments >= DEFAULT_MIN_FRAGMENTS,
    text: `${declaredFile} carries ${probe.fragments} timestamped fragment(s) (>= ${DEFAULT_MIN_FRAGMENTS})`,
  })
  const declaredForSpan = Number.isFinite(declaredMs) ? declaredMs : 0
  findings.push({
    ok: probe.spanMs > 0 && probe.spanMs + SPAN_TOLERANCE_MS >= declaredForSpan,
    text:
      `${declaredFile} spans ${Math.round(probe.spanMs)} ms of media, covering the ${declaredForSpan} ms the manifest ` +
      `declares (tolerance ${SPAN_TOLERANCE_MS} ms; a longer file is the un-cut ring segment, which is expected)`,
  })
  return findings
}

const KNOWN_BACKENDS = new Set(['chromium-desktop-capture', 'windows-gdi-bitblt'])

/**
 * A pack that carries a replay MUST say which capture path produced it.
 *
 * Issue #63 expected a CI runner to have no usable desktop. It does have one —
 * check:native-replay-fallback already drives a real DISPLAY1 there. What is
 * genuinely unknown is WHICH capture path answers: Desktop Duplication through
 * Chromium, or the GDI fallback taking over. Either is a working capture, so
 * what is asserted is that the pack names one of the two, and the value is
 * printed because that is the finding.
 *
 * THE TIGHTENING THIS WANTED, AND THE ONE IT CAN ACTUALLY HAVE.
 *
 * The obvious rule — "a pack that carries a replay names its backend" — is
 * false, and CI proved it: a 1144 ms replay produced no backend and the job went
 * red on a correct pack. The writer does know which path it chose. It has
 * nowhere legal to put it. `backend` rides INSIDE `media.cadence`, `cadenceSummary()`
 * returns null when nothing could be measured, and SPEC §5.3 makes `achieved_fps`
 * and `worst_stall_ms` REQUIRED members — so a backend with no measured rate to
 * sit beside cannot be written without inventing the rate, which §5.3 forbids in
 * the same breath ("a rate nobody measured MUST NOT be reported as a rate").
 *
 * What IS an invariant, and is asserted: cadence present implies backend present.
 * `cadenceSummary()` sets it unconditionally on every cadence it builds, so a
 * cadence without one is a real defect. That still gives #62's fallback story a
 * machine-checkable end wherever a rate exists — which is every capture long
 * enough to measure one, and the short ones were never the interesting case.
 *
 * A pack with NO replay is the other way round: SPEC §5.3 says cadence MUST be
 * absent there, because there are no bytes for it to describe.
 */
function cadenceFindings(manifest, expectReplay) {
  const backends = []
  const collect = (cadence) => {
    if (cadence !== undefined && cadence !== null && cadence.backend !== undefined) backends.push(cadence.backend)
  }
  collect(manifest?.media?.cadence)
  for (const display of manifest?.media?.displays ?? []) collect(display.cadence)
  if (!expectReplay) {
    return [
      {
        ok: backends.length === 0,
        text: `a pack with no replay declares no cadence backend — there are no bytes to describe (found ${backends.length})`,
      },
    ]
  }
  const cadence = manifest?.media?.cadence
  const declared = cadence?.backend
  const findings =
    cadence === undefined || cadence === null
      ? [
          {
            ok: true,
            text:
              'no media.cadence, so no backend to name — the recorder measured no rate, and §5.3 forbids ' +
              'reporting one it did not measure',
          },
        ]
      : [
          {
            ok: KNOWN_BACKENDS.has(declared),
            text:
              `media.cadence.backend is ${JSON.stringify(declared ?? null)} — a cadence names the capture path ` +
              'that produced it (chromium-desktop-capture or windows-gdi-bitblt)',
          },
        ]
  for (const backend of backends) {
    if (backend === declared) continue
    findings.push({
      ok: KNOWN_BACKENDS.has(backend),
      text: `a per-display cadence.backend is "${backend}" (one of the two capture paths)`,
    })
  }
  return findings
}

/**
 * Every declared keyframe, opened, and held to the size it declares (#133).
 *
 * `media.keyframes[].width`/`height` describe THAT FILE — not the snapshot, and
 * not the display. The gutter rule is why: a box on the bottom edge of the
 * screen has to put its label somewhere, so the writer MAY grow the still
 * downward, and two stills in one pack may legitimately differ (SPEC §5.7). A
 * reader that assumed the reference frame's height would mis-place every
 * overlay it drew, which is exactly what the declaration exists to prevent — so
 * the file is opened and its real IHDR is compared with the declaration.
 *
 * The frame itself stays at (0, 0) at its original scale, which is what makes
 * the annotation coordinates apply unchanged. That gives two more checks the
 * declaration alone cannot: the width must equal the source raster's, and the
 * height may only ever GROW.
 */
export function keyframeFindings(dirPath, manifest, options = {}) {
  const sets = []
  const focusedSize = declaredSnapshotSize(manifest)
  if (manifest?.media?.keyframes !== undefined) {
    sets.push({ label: 'media.keyframes', entries: manifest.media.keyframes, frame: focusedSize })
  }
  for (const display of manifest?.media?.displays ?? []) {
    if (display?.keyframes === undefined) continue
    const frame =
      Number.isInteger(display.snapshot_width) && Number.isInteger(display.snapshot_height)
        ? { width: display.snapshot_width, height: display.snapshot_height }
        : null
    sets.push({ label: `media.displays[index ${display.index}].keyframes`, entries: display.keyframes, frame })
  }

  if (sets.length === 0) {
    // Not a defect by itself. Source-first save publishes a complete pack and
    // the render is a later refinement, so an unattended run that did not wait
    // for it legitimately declares nothing here (SPEC §5.7).
    return [
      {
        ok: options.expectKeyframes !== true,
        text:
          options.expectKeyframes === true
            ? 'no keyframes are declared, but this run waited for the derived render — the stills should be here'
            : 'no keyframes declared: the derived render is a later refinement of a pack that is already complete',
      },
    ]
  }

  const findings = []
  for (const set of sets) {
    if (!Array.isArray(set.entries) || set.entries.length === 0) {
      findings.push({ ok: false, text: `${set.label} is declared but is not a non-empty array` })
      continue
    }
    for (const [index, entry] of set.entries.entries()) {
      const label = `${set.label}[${index}] ${JSON.stringify(entry?.file ?? null)}`
      if (typeof entry?.file !== 'string') {
        findings.push({ ok: false, text: `${label} declares no file` })
        continue
      }
      const filePath = path.join(dirPath, entry.file)
      if (!existsSync(filePath)) {
        findings.push({ ok: false, text: `${label} is declared but missing from the pack` })
        continue
      }
      const actual = pngSize(readFileSync(filePath))
      if (actual === null) {
        findings.push({ ok: false, text: `${label} is not a readable PNG` })
        continue
      }
      const declares =
        Number.isInteger(entry.width) && entry.width >= 1 &&
        Number.isInteger(entry.height) && entry.height >= 1
      // SPEC §5.7 makes width/height OPTIONAL because packs written before the
      // field existed do not have it. What THIS app writes is not optional:
      // writeKeyframes() reads the size back out of the bytes it just wrote, so
      // a still it rendered and did not declare means that read-back stopped
      // happening — which is the regression #133 exists to catch.
      findings.push({
        ok: declares,
        text:
          `${label} declares its own size (got ${JSON.stringify(entry.width ?? null)}x${JSON.stringify(entry.height ?? null)}) ` +
          'rather than leaving a reader to assume the reference frame — REQUIRED of a pack this app rendered, ' +
          'absent only in one written before the field existed',
      })
      if (!declares) continue
      findings.push({
        ok: actual.width === entry.width && actual.height === entry.height,
        text: `${label} is ${actual.width}x${actual.height} on disk and declares ${entry.width}x${entry.height}`,
      })
      if (set.frame === null || set.frame === undefined) continue
      findings.push({
        ok: actual.width === set.frame.width && actual.height >= set.frame.height,
        text:
          `${label} keeps the ${set.frame.width}x${set.frame.height} source frame at (0,0) unscaled: same width, ` +
          `height >= the source's (got ${actual.width}x${actual.height}; taller is the label gutter, never shorter)`,
      })
    }
  }
  return findings
}

/** Every assertion, in order, against one pack directory. */
export function assertPack(dirPath, options = {}) {
  const settings = {
    expectReplay: options.expectReplay !== false,
    minReplayMs: options.minReplayMs ?? DEFAULT_MIN_REPLAY_MS,
    minPayloadBytes: options.minPayloadBytes ?? DEFAULT_MIN_PAYLOAD_BYTES,
    logPath: options.logPath ?? null,
    expectAnnouncements: options.expectAnnouncements ?? null,
    runValidator: options.runValidator !== false,
    expectKeyframes: options.expectKeyframes === true,
  }
  const findings = []

  if (settings.runValidator) {
    try {
      execFileSync(process.execPath, [VALIDATOR, dirPath], { stdio: ['ignore', 'pipe', 'pipe'] })
      findings.push({ ok: true, text: 'tools/validate-capturepack.mjs: VALID' })
    } catch (error) {
      const output = `${error.stdout ?? ''}${error.stderr ?? ''}`
      const failed = output
        .split('\n')
        .filter((line) => line.includes('FAIL'))
        .slice(0, 5)
        .join('\n      ')
      findings.push({
        ok: false,
        text: `tools/validate-capturepack.mjs rejected the pack${failed === '' ? '' : `\n      ${failed}`}`,
      })
    }
  }

  const manifestPath = path.join(dirPath, 'manifest.json')
  if (!existsSync(manifestPath)) {
    findings.push({ ok: false, text: 'manifest.json is missing — there is no pack here' })
    return findings
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    findings.push({ ok: false, text: `manifest.json is not readable JSON: ${String(error)}` })
    return findings
  }

  findings.push(...displayScreenFindings(manifest))

  const snapshotPath = path.join(dirPath, manifest?.media?.snapshot ?? 'snapshot.png')
  const declared = declaredSnapshotSize(manifest)
  if (!existsSync(snapshotPath)) {
    findings.push({ ok: false, text: `${path.basename(snapshotPath)} is missing` })
  } else if (declared === null) {
    findings.push({ ok: false, text: 'the manifest declares no display size for the snapshot to match' })
  } else {
    const actual = pngSize(readFileSync(snapshotPath))
    findings.push({
      ok: actual !== null && actual.width === declared.width && actual.height === declared.height,
      text:
        `${path.basename(snapshotPath)} is ${actual === null ? 'not a readable PNG' : `${actual.width}x${actual.height}`} ` +
        `and the manifest declares that display as ${declared.width}x${declared.height}`,
    })
  }

  findings.push(...replayFindings(dirPath, manifest, settings))
  findings.push(...cadenceFindings(manifest, settings.expectReplay))
  findings.push(...keyframeFindings(dirPath, manifest, settings))

  if (settings.logPath !== null) {
    if (!existsSync(settings.logPath)) {
      findings.push({ ok: false, text: `${settings.logPath} does not exist — the run left no log to check` })
    } else {
      const logText = readFileSync(settings.logPath, 'utf8')
      const count = announcementCount(logText)
      if (settings.expectAnnouncements !== null) {
        findings.push({
          ok: count === settings.expectAnnouncements,
          text: `the recorder failure was announced ${count} time(s); exactly ${settings.expectAnnouncements} expected`,
        })
      } else if (settings.expectReplay) {
        findings.push({
          ok: count === 0,
          text: `a run that produced a replay announced no recorder failure (announced ${count} time(s))`,
        })
      } else {
        // NOT "exactly once", and the reason is a finding rather than a
        // compromise. Issue #63 expected `--simulate-no-frames` to leave a
        // recorder that stays down and is announced once. Measured on a real
        // desk: Chromium's capturer delivers nothing, the failure is confirmed,
        // and within ~700 ms the independent windows-gdi-bitblt source takes
        // over and the recorder is RECORDING again. There is then no outage to
        // announce, and announcing one would be a lie — but the capture that
        // was triggered in the meantime still has no replay, so the pack is
        // honestly screenshot-only. Nothing outside the process can tell those
        // two endings apart, so what is asserted is the guarantee that actually
        // holds in both: an outage is announced AT MOST once, never once per
        // retry cycle. Pass --expect-announcements 1 from a run that knows its
        // recorder stayed down.
        findings.push({
          ok: count <= 1,
          text: `the recorder failure was announced ${count} time(s) — at most once per outage, never once per retry`,
        })
        findings.push({
          ok: logText.includes(REPLAY_UNAVAILABLE),
          text: 'the run said WHY the capture has no replay rather than producing a silently screenshot-only pack',
        })
      }
    }
  }

  return findings
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseCli(argv) {
  const options = { dirPath: null, expectReplay: true, logPath: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--expect-replay') options.expectReplay = true
    else if (arg === '--expect-no-replay') options.expectReplay = false
    else if (arg === '--expect-keyframes') options.expectKeyframes = true
    else if (arg === '--log') options.logPath = path.resolve(argv[++index] ?? '')
    else if (arg === '--expect-announcements') options.expectAnnouncements = Number(argv[++index])
    else if (arg === '--min-replay-ms') options.minReplayMs = Number(argv[++index])
    else if (arg === '--min-payload-bytes') options.minPayloadBytes = Number(argv[++index])
    else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`)
    else if (options.dirPath === null) options.dirPath = path.resolve(arg)
    else throw new Error(`Unexpected argument: ${arg}`)
  }
  if (options.dirPath === null) throw new Error('Usage: node scripts/assert-capturepack.mjs <pack-dir> [options]')
  return options
}

function main(argv) {
  let options
  try {
    options = parseCli(argv)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  }
  console.log(`CapturePack pack assertions: ${options.dirPath}`)
  console.log(`Replay: ${options.expectReplay ? 'REQUIRED' : 'must be declared unavailable'}`)
  console.log(
    `Keyframes: ${options.expectKeyframes === true ? 'REQUIRED (the run waited for the render)' : 'optional; every declared one is checked'}`,
  )
  const findings = assertPack(options.dirPath, options)
  for (const finding of findings) console.log(`  ${finding.ok ? 'PASS' : 'FAIL'}  ${finding.text}`)
  const failed = findings.filter((finding) => !finding.ok).length
  console.log(`\nresult: ${failed === 0 ? 'ASSERTED' : 'FAILED'} — ${findings.length - failed} passed, ${failed} failed`)
  return failed === 0 ? 0 : 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2))
}
