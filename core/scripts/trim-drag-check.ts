// A START-TRIM DRAG EDITS THE KEPT RANGE, NOT THE FRAME BEING ANNOTATED.
//
// Field report, 2026-07-29:
//   "시작 트림 움직이면 현재커서 함께 움직이는 버그"
//   "객체 선택 박스는 움직이면 안되는데 움직여지는 버그"
//
// This drives the SAME plan the timebar callback applies, then reads a moving
// annotation through the SAME function the editor uses to draw it. No pointer
// input is synthesized on the owner's desktop.
import { planTrimDrag } from '../src/renderer/editor/trimDrag'
import { annotationAt } from '../src/shared/track'
import type { Annotation } from '../src/shared/types'
import { rebaseAnnotationClock } from '../src/shared/motion'
import { readFileSync } from 'node:fs'
import path from 'node:path'

let failed = 0

function check(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  const ok = g === w
  if (!ok) failed += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) console.log(`        got  ${g}\n        want ${w}`)
}

function movingBox(): Annotation {
  return {
    annotation_id: 'ann_trim_cursor',
    type: 'box',
    bounds: { x: 500, y: 200, width: 300, height: 150 },
    text: '',
    start_ms: 0,
    end_ms: 30_000,
    numbered: false,
    blur: false,
    tracking: {
      enabled: true,
      samples: [
        { t_ms: 8_000, x: 100, y: 200, width: 300, height: 150 },
        { t_ms: 20_000, x: 500, y: 200, width: 300, height: 150 },
      ],
    },
    created_at: '2026-07-29T00:00:00+09:00',
    z: 0,
  }
}

console.log('START HANDLE MOVES, CURRENT FRAME DOES NOT')
{
  const currentMs = 20_000
  const plan = planTrimDrag({
    kind: 'in',
    requestedMs: 8_000,
    durationMs: 30_000,
    currentMs,
    inMs: 0,
    outMs: null,
    minGapMs: 100,
  })
  const displayedMs = plan.previewMs ?? currentMs
  check('start trim lands at the requested frame', plan.inMs, 8_000)
  check('start trim requests no preview seek', plan.previewMs, null)
  check('playhead delta is 0 ms', displayedMs - currentMs, 0)
  check(
    'selected box delta is 0 px',
    annotationAt(movingBox(), displayedMs).bounds.x - annotationAt(movingBox(), currentMs).bounds.x,
    0,
  )
}

console.log('\nSTART HANDLE CANNOT LEAVE THE PLAYHEAD OUTSIDE THE KEPT RANGE')
{
  const currentMs = 20_000
  const plan = planTrimDrag({
    kind: 'in',
    requestedMs: 25_000,
    durationMs: 30_000,
    currentMs,
    inMs: 0,
    outMs: null,
    minGapMs: 100,
  })
  check('handle stops at the current frame', plan.inMs, currentMs)
  check('current frame remains inside the range', plan.inMs <= currentMs, true)
  check('crossing attempt still requests no seek', plan.previewMs, null)
}

console.log('\nEND HANDLE MOVES, CURRENT FRAME DOES NOT')
{
  const currentMs = 10_000
  const plan = planTrimDrag({
    kind: 'out',
    requestedMs: 18_000,
    durationMs: 30_000,
    currentMs,
    inMs: 2_000,
    outMs: null,
    minGapMs: 100,
  })
  check('out trim lands at the requested frame', plan.outMs, 18_000)
  check('end trim requests no preview seek', plan.previewMs, null)
  check('playhead delta is 0 ms', (plan.previewMs ?? currentMs) - currentMs, 0)
  check(
    'selected box delta is 0 px',
    annotationAt(movingBox(), plan.previewMs ?? currentMs).bounds.x -
      annotationAt(movingBox(), currentMs).bounds.x,
    0,
  )
}

console.log('\nEND HANDLE CROSSING USES THE RANGE CLAMP, NOT A PREVIEW SEEK')
{
  const currentMs = 20_000
  const plan = planTrimDrag({
    kind: 'out',
    requestedMs: 12_000,
    durationMs: 30_000,
    currentMs,
    inMs: 2_000,
    outMs: null,
    minGapMs: 100,
  })
  check('end handle can still set the requested out point', plan.outMs, 12_000)
  check('crossing does not add a second preview seek', plan.previewMs, null)
}

console.log('\nNATIVE CAPTURE FRAME STAYS NATIVE WHILE THE END IS TRIMMED')
{
  const plan = planTrimDrag({
    kind: 'out',
    requestedMs: 18_000,
    durationMs: 30_000,
    currentMs: 30_000,
    inMs: 0,
    outMs: null,
    minGapMs: 100,
  })
  check('out point can be set while current is the native capture instant', plan.outMs, 18_000)
  check('native now is not preview-seeked into encoded footage', plan.previewMs, null)
}


// A TRIM MOVES EVERY TIME THE BOX CARRIES (#114).
//
// rebaseAnnotationsForTrim moved start_ms and end_ms by hand and left
// tracking.samples, picked_at_ms and keyframes on the untrimmed clock, while
// rebaseAnnotationClock next door has always moved all of them. Measured on
// CapturePack_2026-07-31_185602, a tail-only cut: two samples at 11057 and
// 11205 ms survived in a pack declaring 10895. Cut from the FRONT and it is
// not stragglers - every observed sample is out by the in-point, so the box
// follows its object at an offset for the whole replay.
console.log('\nA trim rebases the whole annotation, not just its lifetime')
{
  const tracked = {
    annotation_id: 'ann_trim',
    type: 'box',
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    text: '',
    numbered: false,
    blur: false,
    created_at: '2026-07-31T00:00:00.000Z',
    z: 1,
    start_ms: 3_000,
    end_ms: 9_000,
    keyframes: [
      { t_ms: 3_000, x: 0, y: 0, width: 10, height: 10 },
      { t_ms: 8_000, x: 50, y: 0, width: 10, height: 10 },
    ],
    tracking: {
      enabled: true,
      picked_at_ms: 3_000,
      samples: [
        { t_ms: 3_000, x: 0, y: 0, width: 10, height: 10 },
        { t_ms: 6_000, x: 30, y: 0, width: 10, height: 10 },
        { t_ms: 9_500, x: 60, y: 0, width: 10, height: 10 },
      ],
    },
  } as unknown as Annotation

  // A head cut of 2000 ms: this is what rebaseAnnotationsForTrim now calls.
  const head = rebaseAnnotationClock(tracked, -2_000, 8_000)
  check(
    'a head cut moves the lifetime onto the trimmed clock',
    `${head.start_ms},${head.end_ms}`,
    '1000,7000',
  )
  check(
    'and moves every observed sample by the same in-point',
    (head.tracking.samples ?? []).map((x) => x.t_ms).join(','),
    '1000,4000,7500',
  )
  check('and the pick instant', String(head.tracking.picked_at_ms), '1000')
  check(
    'and the authored keyframes',
    (head.keyframes ?? []).map((k) => k.t_ms).join(','),
    '1000,6000',
  )

  // The reported case: tail only. Nothing shifts, and nothing may survive
  // past the declared end.
  const tail = rebaseAnnotationClock(tracked, 0, 9_000)
  check(
    'a tail cut leaves no sample past the declared end',
    String((tail.tracking.samples ?? []).filter((x) => x.t_ms > 9_000).length),
    '0',
  )
  check(
    'and does not move the samples that were already inside it',
    (tail.tracking.samples ?? []).slice(0, 2).map((x) => x.t_ms).join(','),
    '3000,6000',
  )

  // The trim path must actually call it, rather than hand-rolling the two
  // fields that are easy to see.
  const session = readFileSync(
    path.join(process.cwd(), 'src/main/session.ts'),
    'utf8',
  )
  check(
    'the trim rebase delegates to the function that moves everything',
    String(
      session.includes(
        'result.push(rebaseAnnotationClock(a, -trim.startMs, trim.lengthMs))',
      )
        && !session.includes(
          'start_ms: clampToTrim(a.start_ms - trim.startMs, trim.lengthMs),',
        ),
    ),
    'true',
  )
  check(
    'and a box wholly outside the kept range is still dropped',
    String(
      session.includes(
        'if (a.end_ms < trim.startMs || a.start_ms > trim.endMs) continue',
      ),
    ),
    'true',
  )
}
// A TRIM MUST NOT ALSO CHANGE THE CODEC (#113).
//
// The exact cut re-encodes through a canvas — SPEC 5.3 permits that — but it
// asked MediaRecorder for WebM whatever the recorder had produced and then
// declared replay.webm whatever came back. Measured on
// CapturePack_2026-07-31_185602: an H.264/MP4 capture came out of a 310 ms
// tail trim as VP8/WebM, against "Writers SHOULD prefer a platform H.264
// encoder in replay.mp4 when one is available" — it was available, the
// recorder had already chosen it.
console.log('\nA trim keeps the container it was recorded in')
{
  const render = readFileSync(
    path.join(process.cwd(), 'src/renderer/render/render.ts'),
    'utf8',
  )
  check(
    'the encoder is asked for the source container first',
    render.includes('function pickMimeType(prefer?: string): string')
      && render.includes(
        'const producedMimeType = pickMimeType(job.preferMimeType)',
      ),
    true,
  )
  check(
    'an unsupported preference still falls back to the order that shipped',
    render.includes("'video/webm;codecs=vp8',")
      && render.includes("'video/webm;codecs=vp9',")
      && render.includes("...(prefer === undefined || prefer === '' ? [] : [prefer]),"),
    true,
  )
  check(
    'the render reports what it produced rather than what it asked for',
    render.includes('producedMimeType: blob.type'),
    true,
  )
  const session = readFileSync(
    path.join(process.cwd(), 'src/main/session.ts'),
    'utf8',
  )
  check(
    'the cut asks for the container this capture was recorded in',
    session.includes(
      '...(display.replayMimeType === null ? {} : { preferMimeType: display.replayMimeType })',
    ),
    true,
  )
  check(
    'and declares the bytes it got, never a hardcoded name',
    session.includes('replayMimeType: trimmed.mimeType')
      && session.includes(
        "replayFile: trimmed.mimeType.startsWith('video/mp4') ? 'replay.mp4' : 'replay.webm'",
      )
      && !session.includes("replayMimeType: 'video/webm',"),
    true,
  )
  // The rename is only safe because the superseded file is removed on the
  // same write; without it a pack would declare replay.mp4 beside an orphan
  // replay.webm the writer is forbidden to delete.
  const exporter = readFileSync(
    path.join(process.cwd(), 'src/main/exporter.ts'),
    'utf8',
  )
  check(
    'a replay renamed by the cut has its predecessor removed',
    exporter.includes('async function removeReplacedReplayFiles(')
      && exporter.includes('if (oldTop !== null && oldTop !== current.media.replay)')
      && (exporter.match(/await removeReplacedReplayFiles\(/gu) ?? []).length >= 2,
    true,
  )
}
// AN OUT-POINT INSIDE A HELD FRAME STILL STOPS THERE (#116).
//
// The render's out-point test rode requestVideoFrameCallback alone, which fires
// only when a NEW frame is presented, so a cut landing inside a long-held frame
// was only noticed at the far side of it and overshot by up to that frame's
// duration. Measured: replay-d1.mp4 of CapturePack_2026-07-31_202834 holds
// single frames for up to 197 ms, and a recorder stop/restart writes a real
// multi-second hole that observedFragmentTimeline deliberately preserves. The
// playhead keeps moving through a held frame, so a clock test sees what the
// frame callback cannot.
console.log('\nA cut inside a held frame lands where it was asked to')
{
  const render = readFileSync(
    path.join(process.cwd(), 'src/renderer/render/render.ts'),
    'utf8',
  )
  check(
    'the out-point is tested on the clock as well as on presented frames',
    render.includes('const outPointTimer =')
      && render.includes('if (!video.ended && reachedOutPoint()) stopAtOutPoint()'),
    true,
  )
  check(
    'both paths run the same stop, so they cannot disagree',
    render.includes('const stopAtOutPoint = (): void => {')
      && (render.match(/stopAtOutPoint\(\)/gu) ?? []).length === 2,
    true,
  )
  check(
    'and the timer is cleared however the render ends',
    render.includes('} finally {')
      && render.includes('if (outPointTimer !== null) clearInterval(outPointTimer)'),
    true,
  )
  check(
    'a render with no out-point starts no timer at all',
    // Matched without spanning a line break: this file is checked out with
    // CRLF, so an assertion that depends on the line ending fails for a
    // reason that has nothing to do with what it tests.
    render.includes('trimEndMs === undefined')
      && render.includes('? null')
      && render.includes(': setInterval('),
    true,
  )
}
console.log(failed === 0 ? '\ntrim-drag-check ok' : `\ntrim-drag-check FAILED (${failed})`)
process.exitCode = failed === 0 ? 0 : 1
