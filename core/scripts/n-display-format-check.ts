/**
 * n-display-format-check — N DISPLAYS IS THE SHAPE, ONE IS A SPECIAL CASE OF IT
 * (#75/#76, SPEC §5.6, §8.2, §13.1, format 0.7.0).
 *
 * Through 0.6.0 the format's first-class citizen was ONE monitor:
 * `media.snapshot`/`media.replay` were "the capture" and `media.displays` was an
 * optional extra a multi-monitor pack carried. A reader following the obvious
 * field got half the desk with no signal the rest existed — and `annotations.json`
 * declared ONE `reference_width`/`reference_height` while a box carrying
 * `display: 2` was pixels in a DIFFERENT image.
 *
 * This check pins the fix from both ends: the WRITER (buildManifest) declares
 * every display it froze, and the VALIDATOR fails the packs that used to slip
 * through. Every pack below is synthesized here — no machine has to have three
 * monitors for it to run.
 *
 * THE THREE-DISPLAY CASE HERE IS SYNTHETIC. It is not the real acceptance test
 * of #76 ("three screens, one portrait, one scaled, focus on the third" on real
 * hardware); it is the same geometry, written to disk by hand, so the format and
 * the validator can be held to it on a two-monitor machine.
 */
import { buildManifest, savePack } from '../src/main/exporter'
import type { InitialSaveInput } from '../src/main/exporter'
import type { Manifest } from '../src/shared/types'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

let failed = 0
let passed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) passed += 1
  else failed += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

const repositoryRoot = path.resolve(process.cwd(), '..')
const validator = path.join(repositoryRoot, 'tools', 'validate-capturepack.mjs')
const work = mkdtempSync(path.join(tmpdir(), 'capturepack-n-display-'))

/**
 * A PNG that is nothing but a truthful IHDR. The validator reads dimensions
 * from that header, which is the whole point of the packs below — none of them
 * needs a single pixel of image data to state a frame.
 */
function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33)
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes, 0)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

interface PackResult {
  valid: boolean
  output: string
}

/** examples/minimal (a real 640x400 snapshot.png), mutated into the pack under test. */
function buildPack(
  name: string,
  mutate: (manifest: any, annotations: any, dir: string) => void,
): PackResult {
  const dir = path.join(work, name)
  cpSync(path.join(repositoryRoot, 'examples', 'minimal'), dir, { recursive: true })
  const manifestFile = path.join(dir, 'manifest.json')
  const annotationsFile = path.join(dir, 'annotations.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as any
  const annotations = JSON.parse(readFileSync(annotationsFile, 'utf8')) as any
  mutate(manifest, annotations, dir)
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  writeFileSync(annotationsFile, `${JSON.stringify(annotations, null, 2)}\n`, 'utf8')
  const run = spawnSync(process.execPath, [validator, dir], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
  return { valid: run.status === 0, output: `${run.stdout ?? ''}${run.stderr ?? ''}` }
}

/** The focused entry of examples/minimal's own 640x400 snapshot.png. */
function focusedEntry(index: number): Record<string, unknown> {
  return {
    index,
    snapshot: 'snapshot.png',
    snapshot_width: 640,
    snapshot_height: 400,
    replay: null,
    bounds: { x: 0, y: 0, width: 640, height: 400 },
    scale: 1,
    focused: true,
  }
}

try {
  console.log('CapturePack N-display format (SPEC §5.6, §8.2, §13.1 — format 0.7.0)')

  // -------------------------------------------------------------------------
  // The WRITER: buildManifest declares every display the capture froze.
  // -------------------------------------------------------------------------

  const onScreen = buildManifest({
    id: 'one-display',
    createdAt: new Date('2026-07-30T00:00:00.000Z'),
    generatorVersion: 'check',
    title: '',
    note: '',
    osVersion: 'check',
    screens: [{ width: 2_400, height: 1_350, scale: 1.25 }],
    captureKind: 'video',
    hasReplay: true,
    replayFile: 'replay.webm',
    replayDurationMs: 8_000,
    snapshotTMs: null,
    displays: [
      {
        index: 1,
        focused: true,
        bounds: { x: 0, y: 0, width: 1_920, height: 1_080 },
        scale: 1.25,
        snapshotWidth: 2_400,
        snapshotHeight: 1_350,
        hasReplay: true,
        replayDurationMs: 8_000,
        snapshotFile: 'snapshot.png',
        replayFile: 'replay.webm',
      },
    ],
  })
  const only = onScreen.media.displays?.[0]
  check(
    'a capture that froze ONE display declares media.displays with exactly one entry',
    onScreen.media.displays?.length === 1,
    `got ${String(onScreen.media.displays?.length)}`,
  )
  check('that one entry is the focused display', only?.focused === true)
  check(
    'media.snapshot and media.replay name the focused entry’s files (they are aliases, SPEC §5.6)',
    only?.snapshot === onScreen.media.snapshot && only?.replay === onScreen.media.replay,
  )
  check(
    'the entry declares its own snapshot frame, from the raster and not from bounds × scale',
    only?.snapshot_width === 2_400 && only?.snapshot_height === 1_350,
  )
  check(
    'a pack carrying a required media.displays declares format 0.7.0 (SPEC §13.1)',
    onScreen.format_version === '0.7.0',
    onScreen.format_version,
  )

  // THREE SCREENS, ONE PORTRAIT, ONE SCALED, FOCUS ON THE THIRD (#76) —
  // synthetically. Vertical offsets differ, scale factors differ, and the
  // focused display is neither first in the array nor at the desktop origin.
  const threeUp = buildManifest({
    id: 'three-displays',
    createdAt: new Date('2026-07-30T00:00:00.000Z'),
    generatorVersion: 'check',
    title: '',
    note: '',
    osVersion: 'check',
    screens: [
      { width: 1_200, height: 1_920, scale: 1 },
      { width: 3_840, height: 2_160, scale: 1.5 },
      { width: 2_400, height: 1_350, scale: 1.25 },
    ],
    captureKind: 'video',
    hasReplay: true,
    replayFile: 'replay.webm',
    replayDurationMs: 9_000,
    snapshotTMs: null,
    displays: [
      {
        index: 1, // portrait, left of and above the origin
        focused: false,
        bounds: { x: -1_200, y: -480, width: 1_200, height: 1_920 },
        scale: 1,
        snapshotWidth: 1_200,
        snapshotHeight: 1_920,
        hasReplay: true,
        replayDurationMs: 8_900,
        replayClockOffsetMs: -40,
        snapshotFile: 'snapshot-d1.png',
        replayFile: 'replay-d1.webm',
      },
      {
        index: 2, // scaled 1.5x
        focused: false,
        bounds: { x: 0, y: 0, width: 2_560, height: 1_440 },
        scale: 1.5,
        snapshotWidth: 3_840,
        snapshotHeight: 2_160,
        hasReplay: false,
        replayDurationMs: 0,
        snapshotFile: 'snapshot-d2.png',
        replayFile: null,
      },
      {
        index: 3, // FOCUSED, scaled 1.25x, above the origin
        focused: true,
        bounds: { x: 2_560, y: -360, width: 1_920, height: 1_080 },
        scale: 1.25,
        snapshotWidth: 2_400,
        snapshotHeight: 1_350,
        hasReplay: true,
        replayDurationMs: 9_000,
        snapshotFile: 'snapshot.png',
        replayFile: 'replay.webm',
      },
    ],
  })
  const declared = threeUp.media.displays ?? []
  check(
    'three mixed-scale displays with focus on the third are all declared',
    declared.length === 3 && declared.filter((d) => d.focused).length === 1,
  )
  check(
    'the focused entry is display 3 and IS the top-level media',
    declared.find((d) => d.focused)?.index === 3 &&
      declared.find((d) => d.focused)?.snapshot === threeUp.media.snapshot &&
      declared.find((d) => d.focused)?.replay === threeUp.media.replay,
  )
  check(
    'every entry states its own frame, and no two of them are the same image',
    declared.every((d) => (d.snapshot_width ?? 0) > 0 && (d.snapshot_height ?? 0) > 0) &&
      new Set(declared.map((d) => `${String(d.snapshot_width)}x${String(d.snapshot_height)}`)).size === 3,
  )
  check(
    'a display that recorded nothing is still a declared display with a frame',
    declared[1]?.replay === null && declared[1]?.snapshot_width === 3_840,
  )

  // -------------------------------------------------------------------------
  // The VALIDATOR, on packs written to disk.
  // -------------------------------------------------------------------------

  const singleDisplay = buildPack('single-display', (manifest) => {
    manifest.format_version = '0.7.0'
    manifest.capture_kind = 'video'
    manifest.media.displays = [focusedEntry(1)]
  })
  check(
    'a 0.7.0 pack whose media.displays holds ONE focused entry is valid',
    singleDisplay.valid,
    singleDisplay.output.split('\n').filter((l) => l.includes('FAIL')).join(' | '),
  )

  const noDisplays = buildPack('no-displays-070', (manifest) => {
    manifest.format_version = '0.7.0'
    manifest.capture_kind = 'video'
  })
  check(
    'a 0.7.0 pack with NO media.displays is INVALID — the array is required, one screen included',
    !noDisplays.valid && noDisplays.output.includes('REQUIRED from format 0.7.0'),
  )

  // SPEC §13.1's reader rule, enforced on the validator itself: a pack that
  // predates the field is still a valid pack and is read as one display.
  const legacy = buildPack('legacy-no-displays', (manifest) => {
    manifest.format_version = '0.1.0'
    delete manifest.capture_kind
    delete manifest.media.displays
  })
  check(
    'a pre-0.7.0 pack with no media.displays is still valid, read as ONE display (SPEC §13.1)',
    legacy.valid && legacy.output.includes('read as a single-display pack'),
  )

  const noFrame = buildPack('no-frame', (manifest) => {
    manifest.format_version = '0.7.0'
    manifest.capture_kind = 'video'
    const entry = focusedEntry(1)
    delete entry['snapshot_width']
    delete entry['snapshot_height']
    manifest.media.displays = [entry]
  })
  check(
    'a 0.7.0 entry that states no snapshot_width/height is INVALID',
    !noFrame.valid && noFrame.output.includes('snapshot_width'),
  )

  const lyingFrame = buildPack('lying-frame', (manifest) => {
    manifest.format_version = '0.7.0'
    manifest.capture_kind = 'video'
    manifest.media.displays = [{ ...focusedEntry(1), snapshot_width: 800 }]
  })
  check(
    'an entry whose declared frame is not its PNG’s real size is INVALID',
    !lyingFrame.valid && lyingFrame.output.includes('is 640x400'),
  )

  // TWO FIELDS THAT CAN DISAGREE. reference_* IS the focused display's frame
  // (SPEC §8.1/§8.2) and the focused entry now says so too; nothing forced the
  // two to be written from the same number.
  const referenceMismatch = buildPack('reference-mismatch', (manifest, annotations) => {
    manifest.format_version = '0.7.0'
    manifest.capture_kind = 'video'
    manifest.media.displays = [focusedEntry(1)]
    annotations.reference_width = 639
    annotations.annotations = []
  })
  check(
    'annotations.json reference_* disagreeing with the FOCUSED entry’s frame is INVALID',
    !referenceMismatch.valid &&
      referenceMismatch.output.includes("does not equal the FOCUSED display's frame"),
  )

  // -------------------------------------------------------------------------
  // A BOX IS MEASURED AGAINST THE SCREEN IT NAMES — the sharp edge of #75.
  //
  // Display 2 here is DELIBERATELY SMALLER than the focused display, so a box
  // that leaves display 2 is still comfortably inside `reference_width` x
  // `reference_height`. A validator that measured every box against the
  // reference space would pass it; the pack would be silently wrong, which is
  // exactly the failure the per-display rule exists to prevent.
  // -------------------------------------------------------------------------

  const twoDisplays = (manifest: any, dir: string): void => {
    manifest.format_version = '0.7.0'
    manifest.capture_kind = 'video'
    manifest.media.displays = [
      focusedEntry(1),
      {
        index: 2,
        snapshot: 'snapshot-d2.png',
        snapshot_width: 320,
        snapshot_height: 200,
        replay: null,
        bounds: { x: 640, y: 0, width: 320, height: 200 },
        scale: 1,
        focused: false,
      },
    ]
    writeFileSync(path.join(dir, 'snapshot-d2.png'), pngHeader(320, 200))
  }
  const boxOnTwo = (bounds: Record<string, number>): Record<string, unknown> => ({
    annotation_id: 'ann_0d2001',
    type: 'box',
    display: 2,
    bounds,
    text: 'on the small screen',
    created_at: '2026-07-30T09:00:00+09:00',
    z: 1,
  })

  const insideTwo = buildPack('box-inside-display-2', (manifest, annotations, dir) => {
    twoDisplays(manifest, dir)
    annotations.annotations = [boxOnTwo({ x: 10, y: 10, width: 100, height: 50 })]
  })
  check(
    'a box on display 2 that fits display 2’s frame is valid',
    insideTwo.valid,
    insideTwo.output.split('\n').filter((l) => l.includes('FAIL')).join(' | '),
  )

  const outsideTwo = buildPack('box-outside-display-2', (manifest, annotations, dir) => {
    twoDisplays(manifest, dir)
    // (400,100)-(500,150): inside the focused 640x400 reference space, and
    // 180 px off the right edge of display 2's 320x200 snapshot.
    annotations.annotations = [boxOnTwo({ x: 400, y: 100, width: 100, height: 50 })]
  })
  check(
    'a box on display 2 that leaves display 2’s frame FAILS, even though it fits reference_*',
    !outsideTwo.valid && outsideTwo.output.includes('snapshot-d2.png'),
    outsideTwo.valid ? 'validated a box that is not in any image the pack contains' : '',
  )

  // #74's REMAINING GAP. The frame used to be obtained ONLY by probing the
  // display's PNG, so an unreadable snapshot produced no frame and the bounds
  // check was skipped in SILENCE — the pack came back valid. The declared frame
  // answers first now, so the same box still fails.
  const corruptSnapshot = buildPack('box-outside-corrupt-png', (manifest, annotations, dir) => {
    twoDisplays(manifest, dir)
    annotations.annotations = [boxOnTwo({ x: 400, y: 100, width: 100, height: 50 })]
    writeFileSync(path.join(dir, 'snapshot-d2.png'), Buffer.from('not a png at all'))
  })
  check(
    'an out-of-frame box is caught from the DECLARED frame even when its snapshot is unreadable (#74)',
    !corruptSnapshot.valid,
  )

  // The pack the user actually gets — see writtenPackChecks below.
} finally {
  /* the sync half is done; the written-pack half cleans up after itself */
}

/**
 * THE PACK THE USER ACTUALLY GETS. Everything above tests buildManifest's
 * return value or a manifest written by hand. This runs the real save path for a
 * real single-display capture and hands the FOLDER to the validator — because
 * the thing that has to be valid is the pack on disk, not the object in memory.
 */
async function writtenPackChecks(): Promise<void> {
    const outputDir = path.join(work, 'written')
    const snapshotPng = readFileSync(path.join(repositoryRoot, 'examples', 'minimal', 'snapshot.png'))
    const initial: InitialSaveInput = {
      captureKind: 'video',
      snapshotPng,
      width: 640,
      height: 400,
      capturedAt: new Date('2026-07-30T03:00:00.000Z'),
      replayWebm: Buffer.from('REPLAY BYTES'),
      replayFile: 'replay.webm',
      replayDurationMs: 4_000,
      timeline: {
        t0: '2026-07-30T12:00:00+09:00',
        events: [{ t_ms: 0, type: 'core.capture.triggered', source: 'core' }],
      },
      outputDir,
      screens: [{ width: 640, height: 400, scale: 1 }],
      displays: [
        {
          index: 1,
          focused: true,
          bounds: { x: 0, y: 0, width: 640, height: 400 },
          scale: 1,
          snapshotWidth: 640,
          snapshotHeight: 400,
          hasReplay: true,
          replayDurationMs: 4_000,
          snapshotFile: 'snapshot.png',
          replayFile: 'replay.webm',
          snapshotPng: null,
          replayWebm: null,
        },
      ],
      windowsContext: null,
      docLanguage: 'en',
    }
    const handle = await savePack(initial)
    const written = JSON.parse(
      readFileSync(path.join(handle.dirPath, 'manifest.json'), 'utf8'),
    ) as Manifest
    const entry = written.media.displays?.[0]
    check(
      'the pack a real single-display capture WRITES declares one focused display at 0.7.0',
      written.format_version === '0.7.0' &&
        written.media.displays?.length === 1 &&
        entry?.focused === true &&
        entry.snapshot === 'snapshot.png' &&
        entry.replay === 'replay.webm' &&
        entry.snapshot_width === 640 &&
        entry.snapshot_height === 400,
      `${written.format_version}, ${String(written.media.displays?.length)} display(s)`,
    )
    const run = spawnSync(process.execPath, [validator, handle.dirPath], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    })
    check(
      'and that written folder passes the validator end to end',
      run.status === 0,
      `${run.stdout ?? ''}`.split('\n').filter((l) => l.includes('FAIL')).join(' | '),
    )
}

void writtenPackChecks()
  .catch((err: unknown) => {
    check('the written-pack end-to-end check ran', false, String(err))
  })
  .finally(() => {
    rmSync(work, { recursive: true, force: true })
    console.log(
      `result: ${failed === 0 ? 'OK' : 'FAILED'} — ${String(passed)} passed, ${String(failed)} failed`,
    )
    if (failed > 0) process.exit(1)
  })
