// EVERY BOX HAS A STILL IT IS ALIVE IN (#112).
//
// `frames/` claims to be a reconstruction of the capture: one annotated still
// per annotation state change, readable without decoding any video. That claim
// is only true if every box appears in at least one of them — and two rules in
// computeKeyframes could quietly break it.
//
//   MERGING keeps the EARLIER of two times within KEYFRAME_MERGE_MS. A box
//   whose start AND end both fall inside a neighbour's merge window loses both,
//   and the kept frame is one it is not alive at. Short boxes lose first, and
//   the shortest boxes are the manual ones a user drew to mark one moment.
//
//   THE CAP keeps the earliest MAX_KEYFRAMES - 1 changes plus the final
//   instant. A box living entirely in the middle of a busy capture is dropped
//   outright.
//
// Run: npm run check:keyframes
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { persistAnnotatedReplayRender, persistKeyframeStillRender } from '../src/main/annotatedRender'
import {
  type AnnotatedOutputFsOps,
  writeAnnotatedReplayOutput,
  writeKeyframesOutput,
} from '../src/main/annotatedReplayOutput'
import { savePack } from '../src/main/exporter'
import { computeKeyframes, createKeyframeCapture, keyframeFileName, KEYFRAME_MERGE_MS, MAX_KEYFRAMES } from '../src/shared/keyframes'
import type { Annotation, Manifest } from '../src/shared/types'

let failures = 0

// Hosted CI's replay ended just before the wall-clock target (2908 ms).
// Flush the remaining target with the final canvas time, never Infinity.
{
  const captured: number[] = []
  const captureDue = createKeyframeCapture([0, 1000, 2908], (t) => captured.push(t))
  captureDue(0)
  captureDue(1100)
  captureDue(2841)
  const beforeFlush = captured.length
  captureDue(2841, true)
  captureDue(2841, true)
  const serialized = JSON.parse(JSON.stringify(captured)) as number[]
  const ok = beforeFlush === 2 && serialized.join(',') === '0,1100,2841' &&
    keyframeFileName(3, captured[2]!) === 'frames/frame-03_00-02.841.png'
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  final still uses the finite canvas clock, drains once, and names valid media`)
  let rejected = false
  try { captureDue(Infinity, true) } catch { rejected = true }
  if (!rejected) failures += 1
  console.log(`  ${rejected ? 'PASS' : 'FAIL'}  non-finite pixel clocks are rejected`)
}

function box(id: string, start: number | undefined, end: number | undefined): Annotation {
  return {
    annotation_id: id,
    display: 1,
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    ...(start === undefined ? {} : { start_ms: start }),
    ...(end === undefined ? {} : { end_ms: end }),
  } as Annotation
}

/** The interval a box is alive over, on the same clamped clock as the times. */
function alive(a: Annotation, durationMs: number): { from: number; to: number } {
  const clamp = (v: number): number => Math.min(Math.max(0, Math.round(v)), durationMs)
  if (typeof a.start_ms !== 'number' || typeof a.end_ms !== 'number') {
    return { from: durationMs, to: durationMs }
  }
  const lo = clamp(a.start_ms)
  const hi = clamp(a.end_ms)
  return { from: Math.min(lo, hi), to: Math.max(lo, hi) }
}

function check(name: string, annotations: Annotation[], durationMs: number): void {
  const { times, dropped } = computeKeyframes(annotations, durationMs)
  const orphans = annotations.filter((a) => {
    const life = alive(a, durationMs)
    return !times.some((t) => t >= life.from && t <= life.to)
  })
  const sorted = times.every((t, i) => i === 0 || t > (times[i - 1] as number))
  const capped = times.length <= MAX_KEYFRAMES
  // MORE BOXES THAN SLOTS IS ARITHMETIC, NOT A BUG. With N boxes and a cap of
  // MAX_KEYFRAMES, at most MAX_KEYFRAMES of them can appear in a still — so the
  // bar is that every box is represented UNLESS the cap makes it impossible,
  // and that the number left out is the minimum the cap forces.
  const forced = Math.max(0, annotations.length - MAX_KEYFRAMES)
  const ok = orphans.length <= forced && sorted && capped
  if (!ok) failures += 1
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}\n` +
      `        ${annotations.length} boxes -> ${times.length} stills` +
      (dropped > 0 ? ` (${dropped} changes dropped by the cap)` : '') +
      `, ${orphans.length} box(es) with no still they are alive in` +
      (forced > 0 ? ` (${forced} unavoidable at a cap of ${MAX_KEYFRAMES})` : '') +
      (sorted ? '' : ', NOT ASCENDING') +
      (capped ? '' : `, OVER THE CAP OF ${MAX_KEYFRAMES}`),
  )
  if (orphans.length > 0) {
    for (const a of orphans.slice(0, 4)) {
      const life = alive(a, durationMs)
      console.log(`          orphan ${a.annotation_id}: alive ${life.from}..${life.to}`)
    }
  }
}

console.log(`keyframe coverage (merge window ${KEYFRAME_MERGE_MS} ms, cap ${MAX_KEYFRAMES})\n`)

// 1. THE MERGE HOLE, taken from a real pack. CapturePack_2026-07-29_173246 has
//    six window boxes on a one-second cadence and a MANUAL box at 11561..12561
//    whose start sits 14 ms after a window box's end at 11547 — inside the
//    merge window. Shorten that manual box so BOTH its ends fall inside their
//    neighbours' windows and it has nothing of its own left.
check(
  'a short manual box wedged between two merged neighbours',
  [
    box('w1', 6284, 7284),
    box('w2', 7367, 8367),
    box('w3', 8382, 9382),
    box('w4', 9462, 10462),
    box('w5', 10547, 11547),
    box('manual', 11561, 11600), // 14 ms and 53 ms from the kept 11547
  ],
  13000,
)

// 2. THE CAP HOLE: a busy first half fills the budget, and a box that lives
//    only in the second half would be dropped outright.
{
  const busy: Annotation[] = []
  for (let i = 0; i < MAX_KEYFRAMES + 6; i += 1) {
    busy.push(box(`b${String(i)}`, i * 1000, i * 1000 + 400))
  }
  busy.push(box('late-manual', 60_000, 60_200))
  check('a late manual box behind more changes than the cap allows', busy, 90_000)
}

// 3. Boxes with NO lifetime anchor at the capture instant (SPEC §5.7).
check(
  'a box with no lifetime is represented at the capture instant',
  [box('whole-capture', undefined, undefined), box('w1', 1000, 2000)],
  12_000,
)

// 4. The ordinary case must not have grown extra stills.
check(
  'well-spaced boxes still get exactly their own changes',
  [box('a', 1000, 2000), box('b', 4000, 5000), box('c', 8000, 9000)],
  12_000,
)

// 5. A screenshot-only pack: one still at 0, and no box is orphaned by it.
check('screenshot-only pack', [box('a', undefined, undefined)], 0)

// 6. Zero-length box (start === end) — a click with no duration.
check('a zero-length box', [box('w', 5000, 6000), box('point', 6010, 6010)], 12_000)

// 7. Authored motion changes the visible state even while the box remains
//    alive. The midpoint placement must therefore have its own still; otherwise
//    frames/ can show the start and end positions while omitting the position
//    the user explicitly authored between them.
{
  const moving = box('moving-manual', 1000, 9000)
  moving.keyframes = [
    { t_ms: 1000, x: 0, y: 0, width: 10, height: 10 },
    { t_ms: 5000, x: 50, y: 60, width: 10, height: 10 },
    { t_ms: 9000, x: 100, y: 120, width: 10, height: 10 },
  ]
  const { times } = computeKeyframes([moving], 10_000)
  const ok = times.includes(5000)
  if (!ok) failures += 1
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  an authored motion keyframe gets an annotated still` +
      (ok ? '' : ` — got ${times.join(', ')}`),
  )
}

function recordCheck(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

function pngArrayBuffer(width: number, height: number, marker: number): ArrayBuffer {
  const buf = Buffer.alloc(33)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buf, 0)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'latin1')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  buf[24] = 8
  buf[25] = 6
  buf[32] = marker & 0xff
  const out = new ArrayBuffer(buf.byteLength)
  new Uint8Array(out).set(buf)
  return out
}

function hasTempOrBackupEntries(dirPath: string): boolean {
  return existsSync(dirPath)
    && readdirSync(dirPath).some((entry) => entry.endsWith('.tmp') || entry.endsWith('.bak'))
}

async function rejects(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run()
    return false
  } catch {
    return true
  }
}

async function runPersistenceRegressionChecks(): Promise<void> {
  console.log('\nannotated render output atomicity and preservation')
  const workRoot = mkdtempSync(path.join(tmpdir(), 'capturepack-render-output-'))
  try {
    // 1. writeAnnotatedReplayOutput stages to temp, renames atomically, then removes alternate.
    {
      const dir = path.join(workRoot, 'replay-order')
      mkdirSync(dir, { recursive: true })
      const oldWebm = Buffer.from('OLD-WEBM-BYTES')
      const oldMp4 = Buffer.from('OLD-MP4-BYTES')
      const newMp4 = Buffer.from('NEW-MP4-BYTES')
      writeFileSync(path.join(dir, 'replay_annotated.webm'), oldWebm)
      writeFileSync(path.join(dir, 'replay_annotated.mp4'), oldMp4)

      const trace: string[] = []
      let alternateExistedBeforeRename = false
      let targetUnchangedDuringWrite = false
      const ops: AnnotatedOutputFsOps = {
        async writeFile(filePath, data) {
          targetUnchangedDuringWrite =
            readFileSync(path.join(dir, 'replay_annotated.mp4')).equals(oldMp4) &&
            readFileSync(path.join(dir, 'replay_annotated.webm')).equals(oldWebm)
          trace.push(`writeFile:${path.basename(filePath)}`)
          await writeFile(filePath, data)
        },
        async rename(oldPath, newPath) {
          alternateExistedBeforeRename = existsSync(path.join(dir, 'replay_annotated.webm'))
          trace.push(`rename:${path.basename(oldPath)}->${path.basename(newPath)}`)
          await rename(oldPath, newPath)
        },
        async rm(targetPath, options) {
          trace.push(`rm:${path.basename(targetPath)}`)
          await rm(targetPath, options)
        },
      }
      const written = await writeAnnotatedReplayOutput(dir, newMp4, 'video/mp4', undefined, ops)
      recordCheck(
        'annotated replay writes temp, renames onto target, then deletes alternate format',
        written === 'replay_annotated.mp4' &&
          trace.length === 4 &&
          trace[0]!.startsWith('writeFile:.replay_annotated.mp4.') &&
          trace[0]!.endsWith('.tmp') &&
          trace[1] === `${trace[0]!.replace('writeFile:', 'rename:')}->replay_annotated.mp4` &&
          trace[2] === 'rm:replay_annotated.webm' &&
          trace[3] === trace[0]!.replace('writeFile:', 'rm:') &&
          targetUnchangedDuringWrite &&
          alternateExistedBeforeRename &&
          readFileSync(path.join(dir, 'replay_annotated.mp4')).equals(newMp4) &&
          !existsSync(path.join(dir, 'replay_annotated.webm')) &&
          !hasTempOrBackupEntries(dir),
        trace.join(', '),
      )
    }

    // 2. Write failure leaves no temp file and preserves both original annotated replay files.
    {
      const dir = path.join(workRoot, 'replay-write-fail')
      mkdirSync(dir, { recursive: true })
      const oldWebm = Buffer.from('ORIG-WEBM')
      const oldMp4 = Buffer.from('ORIG-MP4')
      writeFileSync(path.join(dir, 'replay_annotated.webm'), oldWebm)
      writeFileSync(path.join(dir, 'replay_annotated.mp4'), oldMp4)

      let renameCalled = false
      let rmAlternateCalled = false
      const failed = await rejects(() =>
        writeAnnotatedReplayOutput(dir, Buffer.from('NEW-MP4'), 'video/mp4', undefined, {
          async writeFile(filePath, data) {
            await writeFile(filePath, Buffer.from(data).subarray(0, 3))
            throw new Error('ENOSPC: disk full')
          },
          async rename(oldPath, newPath) {
            renameCalled = true
            await rename(oldPath, newPath)
          },
          async rm(targetPath, options) {
            if (!path.basename(targetPath).endsWith('.tmp')) rmAlternateCalled = true
            await rm(targetPath, options)
          },
        }),
      )
      recordCheck(
        'replay write failure removes temp file and keeps existing replay files intact',
        failed &&
          !renameCalled &&
          !rmAlternateCalled &&
          readFileSync(path.join(dir, 'replay_annotated.webm')).equals(oldWebm) &&
          readFileSync(path.join(dir, 'replay_annotated.mp4')).equals(oldMp4) &&
          !hasTempOrBackupEntries(dir),
      )
    }

    // 3. Rename failure leaves no temp file and preserves both original annotated replay files.
    {
      const dir = path.join(workRoot, 'replay-rename-fail')
      mkdirSync(dir, { recursive: true })
      const oldWebm = Buffer.from('ORIG-D2-WEBM')
      const oldMp4 = Buffer.from('ORIG-D2-MP4')
      writeFileSync(path.join(dir, 'replay_annotated-d2.webm'), oldWebm)
      writeFileSync(path.join(dir, 'replay_annotated-d2.mp4'), oldMp4)

      let rmAlternateCalled = false
      const failed = await rejects(() =>
        writeAnnotatedReplayOutput(dir, Buffer.from('NEW-D2-WEBM'), 'video/webm', 2, {
          async rename() {
            throw new Error('EBUSY: target locked')
          },
          async rm(targetPath, options) {
            if (!path.basename(targetPath).endsWith('.tmp')) rmAlternateCalled = true
            await rm(targetPath, options)
          },
        }),
      )
      recordCheck(
        'replay rename failure cleans up temp file and preserves secondary display originals',
        failed &&
          !rmAlternateCalled &&
          readFileSync(path.join(dir, 'replay_annotated-d2.webm')).equals(oldWebm) &&
          readFileSync(path.join(dir, 'replay_annotated-d2.mp4')).equals(oldMp4) &&
          !hasTempOrBackupEntries(dir),
      )
    }

    // 4. Keyframes write into staging dir first and atomically replace existing frames/.
    {
      const dir = path.join(workRoot, 'frames-swap')
      const framesDir = path.join(dir, 'frames')
      mkdirSync(framesDir, { recursive: true })
      const staleFile = path.join(framesDir, 'frame-01_00-00.500.png')
      writeFileSync(staleFile, Buffer.from('STALE-STILL'))

      let stagedAllBeforeSwap = false
      const frame1 = pngArrayBuffer(120, 80, 11)
      const frame2 = pngArrayBuffer(120, 96, 22)
      const declared = await writeKeyframesOutput(
        dir,
        [
          { t_ms: 2_000, png: frame1 },
          { t_ms: 4_000, png: frame2 },
        ],
        'frames',
        {
          fs: {
            async writeFile(filePath, data) {
              stagedAllBeforeSwap =
                path.basename(path.dirname(filePath)).startsWith('.frames.') &&
                path.basename(path.dirname(filePath)).endsWith('.tmp') &&
                readFileSync(staleFile).equals(Buffer.from('STALE-STILL'))
              await writeFile(filePath, data)
            },
          },
        },
      )
      const entries = readdirSync(framesDir).sort()
      recordCheck(
        'keyframes stage into temporary directory before swapping out existing frames/',
        stagedAllBeforeSwap &&
          declared.length === 2 &&
          declared[0]?.file === 'frames/frame-01_00-02.000.png' &&
          declared[0]?.width === 120 &&
          declared[0]?.height === 80 &&
          declared[1]?.file === 'frames/frame-02_00-04.000.png' &&
          declared[1]?.width === 120 &&
          declared[1]?.height === 96 &&
          JSON.stringify(entries) === JSON.stringify(['frame-01_00-02.000.png', 'frame-02_00-04.000.png']) &&
          !existsSync(staleFile) &&
          !hasTempOrBackupEntries(dir),
      )
    }

    // 5. Empty still render (allowEmpty: false) fails without touching existing frames/.
    {
      const dir = path.join(workRoot, 'frames-empty-still')
      const framesDir = path.join(dir, 'frames')
      mkdirSync(framesDir, { recursive: true })
      const keepPath = path.join(framesDir, 'frame-01_00-00.000.png')
      const keepBytes = Buffer.from(pngArrayBuffer(100, 60, 33))
      writeFileSync(keepPath, keepBytes)

      const failed = await rejects(() =>
        writeKeyframesOutput(dir, [], 'frames', { allowEmpty: false }),
      )
      recordCheck(
        'empty still render rejects without touching existing frames/',
        failed &&
          readFileSync(keepPath).equals(keepBytes) &&
          !hasTempOrBackupEntries(dir),
      )
    }

    // 6. Mid-write failure during keyframe staging deletes staging dir and keeps frames/ intact.
    {
      const dir = path.join(workRoot, 'frames-write-fail')
      const framesDir = path.join(dir, 'frames')
      mkdirSync(framesDir, { recursive: true })
      const keepPath = path.join(framesDir, 'frame-01_00-00.000.png')
      const keepBytes = Buffer.from(pngArrayBuffer(100, 60, 44))
      writeFileSync(keepPath, keepBytes)

      let writes = 0
      const failed = await rejects(() =>
        writeKeyframesOutput(
          dir,
          [
            { t_ms: 1_000, png: pngArrayBuffer(100, 60, 51) },
            { t_ms: 2_000, png: pngArrayBuffer(100, 60, 52) },
          ],
          'frames',
          {
            fs: {
              async writeFile(filePath, data) {
                writes += 1
                await writeFile(filePath, data)
                if (writes === 2) throw new Error('ENOSPC: still write failed')
              },
            },
          },
        ),
      )
      recordCheck(
        'mid-write keyframe error removes staging dir and preserves existing frames/',
        failed &&
          writes === 2 &&
          JSON.stringify(readdirSync(framesDir)) === JSON.stringify(['frame-01_00-00.000.png']) &&
          readFileSync(keepPath).equals(keepBytes) &&
          !hasTempOrBackupEntries(dir),
      )
    }

    // 7. Directory swap failure restores backup frames/ and deletes staging dir.
    {
      const dir = path.join(workRoot, 'frames-swap-fail')
      const framesDir = path.join(dir, 'frames')
      mkdirSync(framesDir, { recursive: true })
      const keepPath = path.join(framesDir, 'frame-01_00-00.000.png')
      const keepBytes = Buffer.from(pngArrayBuffer(100, 60, 55))
      writeFileSync(keepPath, keepBytes)

      let renameCount = 0
      const failed = await rejects(() =>
        writeKeyframesOutput(
          dir,
          [{ t_ms: 1_000, png: pngArrayBuffer(100, 60, 56) }],
          'frames',
          {
            fs: {
              async rename(oldPath, newPath) {
                renameCount += 1
                if (renameCount === 2) throw new Error('EACCES: swap denied')
                await rename(oldPath, newPath)
              },
            },
          },
        ),
      )
      recordCheck(
        'keyframe swap failure restores backup directory and removes staging temp',
        failed &&
          renameCount === 3 &&
          JSON.stringify(readdirSync(framesDir)) === JSON.stringify(['frame-01_00-00.000.png']) &&
          readFileSync(keepPath).equals(keepBytes) &&
          !hasTempOrBackupEntries(dir),
      )
    }

    // 7b. Moving existing frames/ to backup fails (e.g. locked): frames/ stays untouched & temp cleaned.
    {
      const dir = path.join(workRoot, 'frames-backup-move-fail')
      const framesDir = path.join(dir, 'frames')
      mkdirSync(framesDir, { recursive: true })
      const keepPath = path.join(framesDir, 'frame-01_00-00.000.png')
      const keepBytes = Buffer.from(pngArrayBuffer(100, 60, 57))
      writeFileSync(keepPath, keepBytes)

      const failed = await rejects(() =>
        writeKeyframesOutput(
          dir,
          [{ t_ms: 1_000, png: pngArrayBuffer(100, 60, 58) }],
          'frames',
          {
            fs: {
              async rename() {
                throw Object.assign(new Error('EBUSY: frames dir locked'), { code: 'EBUSY' })
              },
            },
          },
        ),
      )
      recordCheck(
        'backup move lock error leaves existing frames/ intact and removes staging dir',
        failed &&
          JSON.stringify(readdirSync(framesDir)) === JSON.stringify(['frame-01_00-00.000.png']) &&
          readFileSync(keepPath).equals(keepBytes) &&
          !hasTempOrBackupEntries(dir),
      )
    }

    // 7c. First write when frames/ does not exist yet, and allowEmpty clearing existing frames/.
    {
      const dir = path.join(workRoot, 'frames-first-and-clear')
      mkdirSync(dir, { recursive: true })
      const first = await writeKeyframesOutput(
        dir,
        [{ t_ms: 500, png: pngArrayBuffer(160, 90, 59) }],
        'frames',
      )
      const createdOk =
        first.length === 1 &&
        first[0]?.file === 'frames/frame-01_00-00.500.png' &&
        existsSync(path.join(dir, 'frames', 'frame-01_00-00.500.png')) &&
        !hasTempOrBackupEntries(dir)
      const cleared = await writeKeyframesOutput(dir, [], 'frames')
      recordCheck(
        'keyframes create missing frames/ cleanly and clear existing frames/ when allowEmpty is true',
        createdOk &&
          cleared.length === 0 &&
          !existsSync(path.join(dir, 'frames')) &&
          !hasTempOrBackupEntries(dir),
      )
    }

    // 8. Still pack integration: failed/empty re-render preserves existing frames/ and manifest.json.
    {
      const packsOut = path.join(workRoot, 'still-pack-out')
      mkdirSync(packsOut, { recursive: true })
      const handle = await savePack({
        captureKind: 'image',
        imageScope: 'fullscreen',
        snapshotPng: Buffer.from(pngArrayBuffer(640, 360, 1)),
        width: 640,
        height: 360,
        capturedAt: new Date('2026-11-15T01:00:00.000Z'),
        replayWebm: null,
        replayDurationMs: 0,
        timeline: { t0: '2026-11-15T01:00:00.000Z', events: [] },
        outputDir: packsOut,
        screens: [{ width: 640, height: 360, scale: 1 }],
        windowsContext: null,
        docLanguage: 'en',
      })
      const initialStill = pngArrayBuffer(640, 380, 77)
      await persistKeyframeStillRender(handle, {
        frames: [{ t_ms: 0, png: initialStill }],
        docLanguage: 'en',
      })
      const stillPath = path.join(handle.dirPath, 'frames', 'frame-01_00-00.000.png')
      const emptyFailed = await rejects(() =>
        persistKeyframeStillRender(handle, { frames: [], docLanguage: 'en' }),
      )
      const writeFailed = await rejects(() =>
        persistKeyframeStillRender(handle, {
          frames: [{ t_ms: 0, png: pngArrayBuffer(640, 380, 88) }],
          docLanguage: 'en',
          fsOps: {
            async writeFile() {
              throw new Error('EIO: still write error')
            },
          },
        }),
      )
      const manifestAfter = JSON.parse(
        readFileSync(path.join(handle.dirPath, 'manifest.json'), 'utf8'),
      ) as Manifest
      recordCheck(
        'still re-render preserves manifest.keyframes and disk still on empty or failing write',
        emptyFailed &&
          writeFailed &&
          manifestAfter.media.keyframes?.length === 1 &&
          manifestAfter.media.keyframes[0]?.file === 'frames/frame-01_00-00.000.png' &&
          readFileSync(stillPath).equals(Buffer.from(initialStill)) &&
          !hasTempOrBackupEntries(handle.dirPath),
      )
    }

    // 9. Video re-render integration: new replay succeeds while keyframe write fails ->
    //    manifest clears keyframes and no half-written or stale frames/ directory remains.
    {
      const packsOut = path.join(workRoot, 'video-pack-out')
      mkdirSync(packsOut, { recursive: true })
      const handle = await savePack({
        captureKind: 'video',
        snapshotPng: Buffer.from(pngArrayBuffer(1920, 1080, 2)),
        width: 1920,
        height: 1080,
        capturedAt: new Date('2026-11-15T01:05:00.000Z'),
        replayWebm: Buffer.from('SOURCE-WEBM-1'),
        replayFile: 'replay.webm',
        replayDurationMs: 5_000,
        timeline: { t0: '2026-11-15T01:05:00.000Z', events: [] },
        outputDir: packsOut,
        screens: [
          { width: 1920, height: 1080, scale: 1 },
          { width: 1280, height: 720, scale: 1 },
        ],
        displays: [
          {
            index: 1,
            focused: true,
            bounds: { x: 0, y: 0, width: 1920, height: 1080 },
            scale: 1,
            snapshotWidth: 1920,
            snapshotHeight: 1080,
            hasReplay: true,
            replayDurationMs: 5_000,
            snapshotFile: 'snapshot.png',
            replayFile: 'replay.webm',
            snapshotPng: null,
            replayWebm: null,
          },
          {
            index: 2,
            focused: false,
            bounds: { x: 1920, y: 0, width: 1280, height: 720 },
            scale: 1,
            snapshotWidth: 1280,
            snapshotHeight: 720,
            hasReplay: true,
            replayDurationMs: 5_000,
            snapshotFile: 'snapshot-d2.png',
            replayFile: 'replay-d2.webm',
            snapshotPng: Buffer.from(pngArrayBuffer(1280, 720, 3)),
            replayWebm: Buffer.from('SOURCE-WEBM-2'),
          },
        ],
        windowsContext: null,
        docLanguage: 'en',
      })

      await persistAnnotatedReplayRender(handle, {
        replay: Buffer.from('OLD-ANNOTATED-1'),
        replayMimeType: 'video/webm',
        frames: [
          { t_ms: 1_000, png: pngArrayBuffer(1920, 1100, 91) },
          { t_ms: 3_000, png: pngArrayBuffer(1920, 1100, 92) },
        ],
        docLanguage: 'en',
      })
      await persistAnnotatedReplayRender(handle, {
        replay: Buffer.from('OLD-ANNOTATED-2'),
        replayMimeType: 'video/webm',
        display: 2,
        frames: [{ t_ms: 1_500, png: pngArrayBuffer(1280, 740, 93) }],
        docLanguage: 'en',
      })

      let focusedFrameWrites = 0
      await persistAnnotatedReplayRender(handle, {
        replay: Buffer.from('NEW-ANNOTATED-1'),
        replayMimeType: 'video/webm',
        frames: [
          { t_ms: 1_000, png: pngArrayBuffer(1920, 1100, 94) },
          { t_ms: 4_000, png: pngArrayBuffer(1920, 1100, 95) },
        ],
        docLanguage: 'en',
        fsOps: {
          async writeFile(filePath, data) {
            if (path.basename(path.dirname(filePath)).startsWith('.frames.')) {
              focusedFrameWrites += 1
              await writeFile(filePath, data)
              if (focusedFrameWrites === 2) throw new Error('ENOSPC: focused keyframe 2')
              return
            }
            await writeFile(filePath, data)
          },
        },
      })

      await persistAnnotatedReplayRender(handle, {
        replay: Buffer.from('NEW-ANNOTATED-2'),
        replayMimeType: 'video/webm',
        display: 2,
        frames: [{ t_ms: 2_000, png: pngArrayBuffer(1280, 740, 96) }],
        docLanguage: 'en',
        fsOps: {
          async writeFile(filePath, data) {
            if (path.basename(path.dirname(filePath)).startsWith('.frames-d2.')) {
              throw new Error('ENOSPC: secondary keyframe')
            }
            await writeFile(filePath, data)
          },
        },
      })

      const manifestAfter = JSON.parse(
        readFileSync(path.join(handle.dirPath, 'manifest.json'), 'utf8'),
      ) as Manifest
      recordCheck(
        'video re-render keeps new replay and leaves zero partial or stale keyframes when keyframe write fails',
        readFileSync(path.join(handle.dirPath, 'replay_annotated.webm')).equals(Buffer.from('NEW-ANNOTATED-1')) &&
          readFileSync(path.join(handle.dirPath, 'replay_annotated-d2.webm')).equals(Buffer.from('NEW-ANNOTATED-2')) &&
          manifestAfter.media.replay_annotated === 'replay_annotated.webm' &&
          manifestAfter.media.keyframes === undefined &&
          !existsSync(path.join(handle.dirPath, 'frames')) &&
          manifestAfter.media.displays?.[1]?.replay_annotated === 'replay_annotated-d2.webm' &&
          manifestAfter.media.displays?.[1]?.keyframes === undefined &&
          !existsSync(path.join(handle.dirPath, 'frames-d2')) &&
          !hasTempOrBackupEntries(handle.dirPath),
      )
    }
  } finally {
    rmSync(workRoot, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  await runPersistenceRegressionChecks()
  console.log(failures === 0 ? '\nkeyframe-check ok' : `\nkeyframe-check FAILED (${failures})`)
  process.exitCode = failures === 0 ? 0 : 1
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
