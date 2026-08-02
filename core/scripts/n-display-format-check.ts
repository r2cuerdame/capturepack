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
 *
 * ---------------------------------------------------------------------------
 * THE DESK (added for #76's four fixture-reachable risks — see deskChecks()).
 *
 * Everything below the format section is one three-monitor desk, deliberately
 * built to be the shape a two-monitor machine can never be: a PORTRAIT screen
 * BETWEEN two landscape ones, three different scale factors, three different
 * vertical offsets, the FOCUS on the third, and the middle screen's recorder
 * DEAD. Four separate risks meet on it, and they meet on ONE desk on purpose —
 * a board that lays out correctly but numbers wrongly is not a pass.
 *
 * WHAT THIS DOES NOT DO, and cannot: #76 also lists COST — "three hardware
 * encoders and three UIA temporal buffers on one machine". That is a
 * measurement, not a property. Nothing here simulates it and nothing here
 * asserts anything about it; a synthetic desk has no encoders. It stays open
 * until somebody with three monitors runs a real capture.
 * ---------------------------------------------------------------------------
 */
import { buildManifest, savePack, settleDisplayWrites } from '../src/main/exporter'
import { displayReplayName, displaySnapshotName } from '../src/main/exporter'
import type { DisplayCapture, InitialSaveInput } from '../src/main/exporter'
import { aggregateRecorderState } from '../src/main/capture'
import { replayUnavailableForToast } from '../src/main/session'
import { displaySummaryLines, extraDisplayFiles, groupByDisplay } from '../src/main/report'
import { buildBoard, displayAtBoardPoint, toBoardPoint, toNativePoint } from '../src/renderer/editor/board'
import type { BoardInput, BoardLayout } from '../src/renderer/editor/board'
import type { RecorderFailureReason } from '../src/shared/ipc'
import { focusedDisplayIndex } from '../src/shared/types'
import type { Manifest } from '../src/shared/types'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

// ===========================================================================
// THE DESK — #76's four fixture-reachable risks, on one three-monitor desk.
// ===========================================================================

/**
 * One monitor of the synthetic desk.
 *
 * `bounds` is DEVICE-INDEPENDENT pixels (what Electron's Display.bounds gives
 * and what the manifest declares); `native` is the SNAPSHOT raster. Both are
 * written out longhand rather than derived from each other because that
 * derivation is precisely the bug class: bounds x scale disagrees with the real
 * raster by a pixel at 1.25x and 1.5x, which is why SPEC §5.6 makes every entry
 * state its own frame.
 */
interface DeskDisplay {
  index: number
  focused: boolean
  scale: number
  native: { width: number; height: number }
  bounds: { x: number; y: number; width: number; height: number }
  /** false = this display's recorder was not running when the trigger fired. */
  recorded: boolean
  failure: RecorderFailureReason | null
}

/**
 * THREE SCREENS, ONE PORTRAIT, ONE SCALED, FOCUS ON THE THIRD — and the
 * portrait one in the MIDDLE, because #76 says the fallback "stops resembling
 * the desk" for "a portrait monitor beside two landscape".
 *
 * Chosen so that nothing here is a coincidence of a two-monitor desk:
 *
 *   - three DIFFERENT scale factors (1.0 / 1.25 / 1.5), so any single shared
 *     board-to-native scale factor is wrong for at least two screens;
 *   - three DIFFERENT vertical offsets, so a top-aligned strip is visibly not
 *     this desk and GUTTERS exist that no aligned two-monitor desk has;
 *   - the focused display is index 3 — neither first in the array nor at the
 *     desktop origin, and not a number a two-screen pack can produce;
 *   - the display that FAILED to record is the middle one, so "the one that
 *     failed" is neither the focused display nor the first entry;
 *   - the 4K screen has 2x display 1's native pixels but only 1.33x its board
 *     width, so board units and native pixels cannot be confused for one
 *     another by accident.
 *
 * bounds are exact: 1200/1.25 = 960, 1920/1.25 = 1536, 3840/1.5 = 2560,
 * 2160/1.5 = 1440. The three rectangles tile left to right without overlapping.
 */
const DESK: readonly DeskDisplay[] = [
  {
    index: 1,
    focused: false,
    scale: 1,
    native: { width: 1_920, height: 1_080 },
    bounds: { x: 0, y: 300, width: 1_920, height: 1_080 },
    recorded: true,
    failure: null,
  },
  {
    index: 2, // PORTRAIT, in the middle, and the recorder that died
    focused: false,
    scale: 1.25,
    native: { width: 1_200, height: 1_920 },
    bounds: { x: 1_920, y: 0, width: 960, height: 1_536 },
    recorded: false,
    failure: 'no-frames',
  },
  {
    index: 3, // FOCUSED
    focused: true,
    scale: 1.5,
    native: { width: 3_840, height: 2_160 },
    bounds: { x: 2_880, y: 420, width: 2_560, height: 1_440 },
    recorded: true,
    failure: null,
  },
]

const FOCUSED_INDEX = 3
const FAILED_INDEX = 2

/**
 * environment.screens for this desk.
 *
 * SPEC §5.6 defines media.displays[].index as "the 1-based position in
 * environment.screens", so this list IS the fourth numbering the other three
 * have to agree with, and it is built here in index order on purpose.
 *
 * screens[] carries bounds x scale, NOT the measured raster — that is what
 * session.ts computes from Display.size x scaleFactor. On this desk the two
 * happen to coincide; the check below still refuses to assert they are equal,
 * because at 1.25x/1.5x they need not be and a check that demanded it would be
 * wrong rather than strict.
 */
const DESK_SCREENS = DESK.map((d) => ({
  width: Math.round(d.bounds.width * d.scale),
  height: Math.round(d.bounds.height * d.scale),
  scale: d.scale,
}))

const isPortrait = (d: { width: number; height: number }): boolean => d.height > d.width

/** The manifest this desk produces, through the real writer. */
function deskManifest(order: readonly DeskDisplay[] = DESK): Manifest {
  return buildManifest({
    id: 'desk-three-displays',
    createdAt: new Date('2026-08-02T00:00:00.000Z'),
    generatorVersion: 'check',
    title: '',
    note: '',
    osVersion: 'check',
    screens: DESK_SCREENS,
    captureKind: 'video',
    hasReplay: true,
    replayFile: 'replay.webm',
    replayDurationMs: 12_000,
    snapshotTMs: null,
    displays: order.map((d) => ({
      index: d.index,
      focused: d.focused,
      bounds: { ...d.bounds },
      scale: d.scale,
      snapshotWidth: d.native.width,
      snapshotHeight: d.native.height,
      hasReplay: d.recorded,
      replayDurationMs: d.recorded ? 12_000 : 0,
      ...(d.focused || !d.recorded ? {} : { replayClockOffsetMs: -40 * d.index }),
      snapshotFile: displaySnapshotName(d.index),
      replayFile: d.recorded ? displayReplayName(d.index) : null,
    })),
  })
}

/** The editor's board inputs for this desk — exactly what editor.ts builds. */
function deskBoardInputs(order: readonly DeskDisplay[] = DESK): BoardInput[] {
  return order.map((d) => ({
    index: d.index,
    focused: d.focused,
    width: d.native.width,
    height: d.native.height,
    hasReplay: d.recorded,
    bounds: { ...d.bounds },
  }))
}

const byIndex = (board: BoardLayout, index: number): BoardLayout['displays'][number] | undefined =>
  board.displays.find((d) => d.index === index)

// ---------------------------------------------------------------------------
// RISK 1 — BOARD LAYOUT AND FRAMING.
//
// #76: board.ts "falls back to a left-to-right strip when the arrangement
// cannot be derived. Three displays at mixed scales and vertical offsets (a
// portrait monitor beside two landscape) is where that fallback stops
// resembling the desk."
//
// So the property is not "buildBoard returns something": it is that on THIS
// desk it returns the DESK and not the fallback, and that the difference is
// observable. Every assertion below is paired with the same measurement taken
// on a desk that DOES fall back, so none of them can pass vacuously.
// ---------------------------------------------------------------------------
function boardChecks(): void {
  const board = buildBoard(deskBoardInputs())
  const minX = Math.min(...DESK.map((d) => d.bounds.x))
  const minY = Math.min(...DESK.map((d) => d.bounds.y))

  check(
    'the mixed-scale, vertically-offset desk lays out as the DESK: every board rect is its own ' +
      'DIP bounds, origin-normalized',
    DESK.every((d) => {
      const b = byIndex(board, d.index)
      return (
        b !== undefined &&
        b.bx === d.bounds.x - minX &&
        b.by === d.bounds.y - minY &&
        b.bw === d.bounds.width &&
        b.bh === d.bounds.height
      )
    }),
    board.displays.map((d) => `${String(d.index)}@${String(d.bx)},${String(d.by)}`).join(' '),
  )

  // A left-to-right strip top-aligns everything. Three different vertical
  // offsets is the cheapest thing that tells the two layouts apart, and a
  // two-monitor desk in a line does not have it.
  check(
    'the three displays sit at three DIFFERENT vertical offsets — a top-aligned strip would not',
    new Set(board.displays.map((d) => d.by)).size === 3,
    board.displays.map((d) => String(d.by)).join(','),
  )

  // NEGATIVE CONTROL for the two above: overlapping bounds are the cloned /
  // hand-edited case board.ts explicitly refuses to draw, and it falls back.
  // If the fallback did NOT fire here, the two checks above would be measuring
  // nothing.
  const clonedDesk = DESK.map((d) => ({ ...d, bounds: { ...d.bounds, x: 0, y: 0 } }))
  const stripped = buildBoard(deskBoardInputs(clonedDesk))
  check(
    'NEGATIVE CONTROL: a mirrored desk (all three bounds at the origin) DOES fall back to the ' +
      'strip — top-aligned, laid left to right in index order',
    stripped.displays.every((d) => d.by === 0) &&
      stripped.displays.map((d) => d.index).join(',') === '1,2,3' &&
      stripped.displays[1]?.bx === stripped.displays[0]?.bw,
    stripped.displays.map((d) => `${String(d.index)}@${String(d.bx)},${String(d.by)}`).join(' '),
  )

  // BOARD UNITS ARE NOT NATIVE PIXELS. The 4K screen has 2x display 1's native
  // pixels; on the desk it is 1.33x as wide, because it is a 1.5x display. A
  // board laid out in raster pixels would put the two in the wrong proportion
  // and every physical relationship on the board would be a lie.
  const d1 = byIndex(board, 1)
  const d3 = byIndex(board, 3)
  check(
    'the 1.5x 4K screen keeps its PHYSICAL proportion to the 1x 1080p one (1.33x wide on the ' +
      'board) instead of its raster proportion (2x)',
    d1 !== undefined &&
      d3 !== undefined &&
      d3.bw / d1.bw === 2_560 / 1_920 &&
      d3.width / d1.width === 2,
    d1 === undefined || d3 === undefined ? '' : `board ${String(d3.bw / d1.bw)}, native ${String(d3.width / d1.width)}`,
  )

  // The portrait screen is the SHORTEST in native pixels across and the TALLEST
  // on the desk. Anything that sorted or sized displays by raster would get
  // this backwards.
  const d2 = byIndex(board, 2)
  check(
    'the portrait screen is taller than both landscape ones on the board, though it has the ' +
      'fewest pixels of the three',
    d1 !== undefined &&
      d2 !== undefined &&
      d3 !== undefined &&
      isPortrait({ width: d2.width, height: d2.height }) &&
      d2.bh > d1.bh &&
      d2.bh > d3.bh &&
      d2.width * d2.height < d3.width * d3.height,
  )

  // THE SEAMS. Adjacent displays share an edge; half-open bounds mean the seam
  // column belongs to the display on the RIGHT. Two seams exist here (1|2 and
  // 2|3) where a two-monitor desk has one, and the y used for each is inside
  // BOTH neighbours — which, with three different vertical offsets, is a
  // narrower window than it sounds.
  const seamA = (d1?.bx ?? 0) + (d1?.bw ?? 0)
  const seamB = (d2?.bx ?? 0) + (d2?.bw ?? 0)
  check(
    'both seams belong to the display on their RIGHT (half-open bounds), so neither middle-screen ' +
      'edge column is unreachable',
    displayAtBoardPoint(board, seamA, 700)?.index === 2 &&
      displayAtBoardPoint(board, seamB, 700)?.index === 3 &&
      displayAtBoardPoint(board, seamA - 1, 700)?.index === 1 &&
      displayAtBoardPoint(board, seamB - 1, 700)?.index === 2,
    `${String(seamA)} -> ${String(displayAtBoardPoint(board, seamA, 700)?.index)}, ` +
      `${String(seamB)} -> ${String(displayAtBoardPoint(board, seamB, 700)?.index)}`,
  )

  // THE GUTTER. Vertical offsets put board area above display 1 that is on NO
  // screen. An aligned two-monitor desk has no such point, so nothing has ever
  // exercised displayAtBoardPoint's "return null" — and the second, INCLUSIVE
  // pass in that function (which exists for the board's outer edge) is exactly
  // the kind of thing that quietly claims a gutter for the nearest display.
  const gutter = { x: 10, y: 10 } // above display 1's top edge (by = 300), left of display 2
  check(
    'a point in the gutter above the lowest-hung screen is on NO display — not silently claimed ' +
      'by the nearest one',
    displayAtBoardPoint(board, gutter.x, gutter.y) === null,
    `resolved to ${String(displayAtBoardPoint(board, gutter.x, gutter.y)?.index ?? 'no display')}`,
  )
  check(
    'NEGATIVE CONTROL: the same point IS on display 1 in the top-aligned strip — the gutter is a ' +
      'property of the real arrangement, not of the point',
    displayAtBoardPoint(stripped, gutter.x, gutter.y)?.index === 1,
  )
  // WHERE THE GUTTER STARTS, exactly. displayAtBoardPoint runs a second,
  // INCLUSIVE pass so the board's outer right/bottom edge stays reachable. On a
  // desk with vertical offsets that pass also covers one interior row: a point
  // exactly on display 1's bottom edge, which is now a gutter row, resolves to
  // display 1. That was measured, not assumed, and it is the behaviour worth
  // keeping — the edge of a screen belongs to that screen — but it is one row
  // wide and nothing beyond it is claimed. Pinned so it stays deliberate.
  const bottomOfOne = (d1?.by ?? 0) + (d1?.bh ?? 0)
  check(
    'the gutter below a high-hung screen starts ONE ROW below its bottom edge: the edge row is ' +
      'still that screen, everything under it is no display at all',
    displayAtBoardPoint(board, 500, bottomOfOne)?.index === 1 &&
      displayAtBoardPoint(board, 500, bottomOfOne + 1) === null &&
      displayAtBoardPoint(board, 500, bottomOfOne + 200) === null,
    `edge row ${String(bottomOfOne)} -> ${String(displayAtBoardPoint(board, 500, bottomOfOne)?.index ?? 'null')}, ` +
      `next row -> ${String(displayAtBoardPoint(board, 500, bottomOfOne + 1)?.index ?? 'null')}`,
  )

  // COORDINATE INTEGRITY AT THREE DIFFERENT SCALES. A board point resolves to
  // pixels in the snapshot of the display it fell on, and in no other. The
  // centre of each display's board rect must be the centre of ITS raster.
  check(
    'the centre of each display’s board rect is the centre of THAT display’s snapshot, at all ' +
      'three scale factors',
    DESK.every((desk) => {
      const b = byIndex(board, desk.index)
      if (b === undefined) return false
      const n = toNativePoint(b, b.bx + b.bw / 2, b.by + b.bh / 2)
      return (
        Math.abs(n.x - desk.native.width / 2) <= 1 && Math.abs(n.y - desk.native.height / 2) <= 1
      )
    }),
  )
  check(
    'and native -> board -> native round-trips on every display',
    DESK.every((desk) => {
      const b = byIndex(board, desk.index)
      if (b === undefined) return false
      const probe = { x: Math.round(desk.native.width * 0.3), y: Math.round(desk.native.height * 0.7) }
      const back = toBoardPoint(b, probe.x, probe.y)
      const n = toNativePoint(b, back.x, back.y)
      return n.x === probe.x && n.y === probe.y
    }),
  )
  // NEGATIVE CONTROL: the mapping is PER DISPLAY. Display 3's centre read
  // through display 2's transform is not display 3's centre — if the same
  // number came back, every display would be sharing one scale factor.
  check(
    'NEGATIVE CONTROL: display 3’s board centre read through display 2’s transform is NOT display ' +
      '3’s centre — the transform belongs to the display, not to the board',
    (() => {
      const b2 = byIndex(board, 2)
      const b3 = byIndex(board, 3)
      if (b2 === undefined || b3 === undefined) return false
      const wrong = toNativePoint(b2, b3.bx + b3.bw / 2, b3.by + b3.bh / 2)
      return wrong.x !== Math.round(b3.width / 2) || wrong.y !== Math.round(b3.height / 2)
    })(),
  )

  // FRAMING (1..9 zooms one display): the rect zoomToDisplay hands the viewport
  // is the display's own board rect, and three of them do not overlap — so
  // framing the 4K screen cannot put a strip of the portrait one on screen.
  check(
    'framing any one display targets exactly its own board rect, and no two of the three rects ' +
      'overlap',
    board.displays.every((a) =>
      board.displays.every(
        (b) =>
          a.index === b.index ||
          a.bx >= b.bx + b.bw ||
          b.bx >= a.bx + a.bw ||
          a.by >= b.by + b.bh ||
          b.by >= a.by + a.bh,
      ),
    ),
  )

  // THE CANVAS BUDGET AT THREE SCREENS. board.ts promises the budget "stays
  // flat as displays are added — a third screen shrinks `ratio`, not the
  // budget". Asserted as a RELATION rather than against a copy of the constant,
  // so this cannot drift out of agreement with board.ts.
  let nativeRatio = 0
  for (const d of board.displays) nativeRatio = Math.max(nativeRatio, d.width / d.bw)
  check(
    'at three screens the pixel budget is what caps the board, not the native resolution — the ' +
      'ratio is pulled below native',
    board.ratio < nativeRatio && board.ratio > 0.25,
    `ratio ${board.ratio.toFixed(4)} < native ${String(nativeRatio)}`,
  )
  const fourUp = buildBoard([
    ...deskBoardInputs(),
    {
      index: 4,
      focused: false,
      width: 1_920,
      height: 1_080,
      hasReplay: true,
      bounds: { x: 5_440, y: 300, width: 1_920, height: 1_080 },
    },
  ])
  const threeCost = board.canvasWidth * board.canvasHeight
  const fourCost = fourUp.canvasWidth * fourUp.canvasHeight
  check(
    'and a FOURTH screen does not buy more backing store — it shrinks the ratio instead (the ' +
      'budget is flat in display count)',
    fourCost <= threeCost + fourUp.canvasWidth + fourUp.canvasHeight && fourUp.ratio < board.ratio,
    `3 displays ${String(threeCost)} px, 4 displays ${String(fourCost)} px`,
  )
}

// ---------------------------------------------------------------------------
// RISK 2 — DISPLAY NUMBERING VS INDEX.
//
// #76: "media.displays[].index, the 1..9 framing keys, and the display numbers
// printed in report.md are three numberings that agree today because there are
// two screens. They must be shown to agree at three."
//
// The three sources, located:
//
//   (N1) manifest.media.displays[].index — written by buildManifest, and by
//        SPEC §5.6 the 1-BASED POSITION IN environment.screens, which makes
//        that list a fourth numbering the other three have to agree with.
//   (N2) the 1..9 framing keys — editor.ts reads e.key, passes the DIGIT to
//        zoomToDisplay(index) -> displayByIndex(index), which is
//        `board.displays.find((d) => d.index === index)`. So the key is an
//        INDEX LOOKUP, never an array position.
//   (N3) report.md — report.ts prints `d.index` in displaySummaryLines(),
//        `Display ${d.index}` in extraDisplayFiles(), and `### Display N` from
//        groupByDisplay(), which re-sorts (focused first) and therefore has its
//        own opportunity to print a position instead.
//
// They agree on a sorted 1,2 array by arithmetic accident. The desks below take
// that accident away.
// ---------------------------------------------------------------------------
function numberingChecks(): void {
  const manifest = deskManifest()
  const declared = manifest.media.displays ?? []
  const board = buildBoard(deskBoardInputs())

  // (N1) x (N2): the digit key and the manifest entry are the same screen.
  check(
    'N1 = N2: for every key 1..3, the display the framing key frames is the display the manifest ' +
      'declares under that index — same frame, same bounds',
    DESK.every((desk) => {
      const entry = declared.find((e) => e.index === desk.index)
      const framed = byIndex(board, desk.index) // exactly editor.ts displayByIndex()
      return (
        entry !== undefined &&
        framed !== undefined &&
        entry.snapshot_width === framed.width &&
        entry.snapshot_height === framed.height &&
        entry.bounds.x === desk.bounds.x &&
        framed.bw === desk.bounds.width
      )
    }),
  )
  check(
    'the focused display is index 3 in the manifest, in the board, and to the framing key — a ' +
      'number no two-screen pack can produce',
    focusedDisplayIndex(declared) === FOCUSED_INDEX &&
      board.focusedIndex === FOCUSED_INDEX &&
      byIndex(board, FOCUSED_INDEX)?.focused === true,
    `manifest ${String(focusedDisplayIndex(declared))}, board ${String(board.focusedIndex)}`,
  )

  // (N1) x (N3): report.md's numbers. Parsed back out of the real lines rather
  // than compared to a string built here, so the check reads what a user reads.
  const summary = displaySummaryLines(manifest, undefined, [])
  const numbered = summary
    .slice(1)
    .map((line) => /^ {2}- (\d+): (\d+)×(\d+) /.exec(line))
    .map((m) => (m === null ? null : { index: Number(m[1]), width: Number(m[2]), height: Number(m[3]) }))
  check(
    'N1 = N3: every report.md display line is numbered with the manifest INDEX and states that ' +
      'display’s own frame',
    numbered.length === 3 &&
      numbered.every((row) => {
        if (row === null) return false
        const desk = DESK.find((d) => d.index === row.index)
        return desk !== undefined && row.width === desk.native.width && row.height === desk.native.height
      }),
    summary.slice(1).join(' || '),
  )
  check(
    'report.md’s per-display file list names display N’s file as snapshot-dN.png, for the two ' +
      'non-focused screens only',
    (() => {
      const files = extraDisplayFiles(manifest)
      const snaps = files.filter((f) => f.name.startsWith('snapshot-d'))
      return (
        snaps.length === 2 &&
        snaps.every((f) => {
          const m = /^snapshot-d(\d+)\.png$/.exec(f.name)
          return m !== null && f.what.startsWith(`Display ${m[1]},`)
        })
      )
    })(),
  )

  // THE PERMUTED DESK. Nothing in SPEC §5.6 or the validator requires
  // media.displays to be sorted — session.ts happens to sort a fresh capture,
  // but a re-edit of an externally written pack does not re-sort, and the
  // validator only requires the indices to be UNIQUE. On a two-screen pack a
  // positional reading is wrong for at most a swap; here it is wrong for two of
  // three, which is what makes this the desk worth writing down.
  const permuted = [DESK[2], DESK[0], DESK[1]].filter((d): d is DeskDisplay => d !== undefined)
  const permutedBoard = buildBoard(deskBoardInputs(permuted))
  const permutedManifest = deskManifest(permuted)
  check(
    'a manifest whose displays array is NOT in index order still frames the right screen for ' +
      'every key, and still reports index 3 as focused',
    DESK.every((desk) => {
      const framed = byIndex(permutedBoard, desk.index)
      return framed !== undefined && framed.width === desk.native.width && framed.bw === desk.bounds.width
    }) &&
      permutedBoard.focusedIndex === FOCUSED_INDEX &&
      focusedDisplayIndex(permutedManifest.media.displays) === FOCUSED_INDEX,
  )
  // [3, 1, 2] is a DERANGEMENT: not one of the three displays sits at the
  // position its index names. That is the strongest form this control can take
  // and it is why this permutation was chosen — with two screens the only
  // permutation available is a swap, which a positional reading gets wrong
  // exactly as often as it gets it right.
  check(
    'NEGATIVE CONTROL: reading that same board by ARRAY POSITION is wrong for ALL THREE displays ' +
      '— so the check above is not passing by accident',
    permutedBoard.displays.filter((d, i) => d.index !== i + 1).length === 3,
    permutedBoard.displays.map((d) => String(d.index)).join(','),
  )
  const permutedSummary = displaySummaryLines(permutedManifest, undefined, [])
    .slice(1)
    .map((line) => /^ {2}- (\d+): (\d+)×/.exec(line))
  check(
    'and report.md still numbers that pack by index, not by array position',
    permutedSummary.every((m) => {
      if (m === null) return false
      const desk = DESK.find((d) => d.index === Number(m[1]))
      return desk !== undefined && Number(m[2]) === desk.native.width
    }) && permutedSummary.length === 3,
  )
  // groupByDisplay re-sorts FOCUSED FIRST for report.md's annotation sections,
  // so its output order is deliberately not index order — the numbers it emits
  // still have to be indices.
  const groups = groupByDisplay(permutedManifest, [])
  check(
    'report.md’s annotation sections lead with the FOCUSED display and still carry index numbers ' +
      '(3, 1, 2), not positions (1, 2, 3)',
    groups.map((g) => g.index).join(',') === '3,1,2' && groups[0]?.focused === true,
    groups.map((g) => String(g.index)).join(','),
  )

  // THE FOURTH NUMBERING. SPEC §5.6: index is the 1-based position in
  // environment.screens. Scale and ORIENTATION are asserted; SIZE deliberately
  // is not — screens[] is bounds x scale and snapshot_* is the measured raster,
  // and they are allowed to differ by a pixel at 1.25x/1.5x. Demanding equality
  // would be a wrong check, not a strict one.
  const screens = manifest.environment.screens
  check(
    'N1 = environment.screens: screens[index - 1] has that display’s scale and orientation — the ' +
      'portrait screen is the SECOND entry, where index 2 says it is',
    screens.length === 3 &&
      DESK.every((desk) => {
        const s = screens[desk.index - 1]
        return (
          s !== undefined &&
          s.scale === desk.scale &&
          isPortrait(s) === isPortrait(desk.native)
        )
      }) &&
      isPortrait(screens[1] ?? { width: 1, height: 1 }),
  )

  // SPARSE INDICES. A display unplugged between capture and save, or an
  // external writer numbering from a stale screen list, leaves a legal pack
  // whose indices are 1, 2, 4 — unique and >= 1 is all the validator requires.
  // The framing keys must then resolve 1, 2 and 4 and resolve NOTHING for 3;
  // anything positional would silently frame the wrong screen for both 3 and 4.
  const sparse = [
    DESK[0],
    DESK[1],
    { ...(DESK[2] as DeskDisplay), index: 4 },
  ].filter((d): d is DeskDisplay => d !== undefined)
  const sparseBoard = buildBoard(deskBoardInputs(sparse))
  check(
    'a pack with SPARSE indices (1, 2, 4) frames 1, 2 and 4 and frames NOTHING for key 3 — the ' +
      'editor’s displayByIndex returns null and zoomToDisplay is a no-op',
    byIndex(sparseBoard, 1) !== undefined &&
      byIndex(sparseBoard, 2) !== undefined &&
      byIndex(sparseBoard, 4)?.width === 3_840 &&
      byIndex(sparseBoard, 3) === undefined &&
      sparseBoard.focusedIndex === 4,
  )
  check(
    'NEGATIVE CONTROL: position 3 of that same board IS a display — so "key 3 frames nothing" is ' +
      'a statement about the index, not about the array being short',
    sparseBoard.displays.length === 3 && sparseBoard.displays[2] !== undefined,
  )
}

// ---------------------------------------------------------------------------
// RISK 3 — SNAPSHOT AND REPLAY NAMING, and
// RISK 4 — PARTIAL PER-DISPLAY RECORDER FAILURE, in the pack.
//
// #76 on naming: "a pack where the FOCUSED display is not index 1 or 2 — the
// focused entry repeats the top-level file, so a third-screen focus is a case
// no capture has exercised."
//
// The point is subtle and worth stating: session.ts fills snapshotFile for
// EVERY display, focused included, so the string "snapshot-d3.png" genuinely
// exists in the writer's data for this desk. Two separate rules then have to
// suppress it — buildDisplayMedia declares media.snapshot for the focused entry
// instead, and writeDisplayFiles returns early for it. On a two-monitor desk
// the suppressed name is always d1 or d2. Here it is d3, and the pack must
// contain no trace of it.
//
// #76 on failure: "with three recorders the interesting case is a PARTIAL
// failure — two screens recording, one not — and whether the pack, the toast
// and the tray each name the right one." This runs the real save path, so what
// is checked is the FOLDER, not an object.
// ---------------------------------------------------------------------------
async function writtenDeskChecks(): Promise<void> {
  const outputDir = path.join(work, 'desk')
  const focused = DESK.find((d) => d.focused)
  if (focused === undefined) throw new Error('the desk has no focused display')

  const displays: DisplayCapture[] = DESK.map((d) => ({
    index: d.index,
    focused: d.focused,
    bounds: { ...d.bounds },
    scale: d.scale,
    hasReplay: d.recorded,
    replayDurationMs: d.recorded ? 12_000 : 0,
    ...(d.focused || !d.recorded ? {} : { replayClockOffsetMs: -40 * d.index }),
    snapshotWidth: d.native.width,
    snapshotHeight: d.native.height,
    // EXACTLY what session.ts toDisplayCaptures() does: the canonical name is
    // computed for every display, focused included. If the suppression below
    // ever stopped happening, snapshot-d3.png would appear in the folder.
    snapshotFile: displaySnapshotName(d.index),
    replayFile: d.recorded ? displayReplayName(d.index) : null,
    snapshotPng: d.focused ? null : pngHeader(d.native.width, d.native.height),
    replayWebm: d.focused || !d.recorded ? null : Buffer.from(`REPLAY d${String(d.index)}`),
  }))

  const initial: InitialSaveInput = {
    captureKind: 'video',
    snapshotPng: pngHeader(focused.native.width, focused.native.height),
    width: focused.native.width,
    height: focused.native.height,
    capturedAt: new Date('2026-08-02T03:00:00.000Z'),
    replayWebm: Buffer.from('REPLAY FOCUSED'),
    replayFile: 'replay.webm',
    replayDurationMs: 12_000,
    timeline: {
      t0: '2026-08-02T12:00:00+09:00',
      events: [{ t_ms: 0, type: 'core.capture.triggered', source: 'core' }],
    },
    outputDir,
    screens: DESK_SCREENS,
    displays,
    windowsContext: null,
    docLanguage: 'en',
  }
  const handle = await savePack(initial)
  await settleDisplayWrites(handle.dirPath)
  const dir = handle.dirPath
  const written = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Manifest
  const entries = written.media.displays ?? []
  const focusedEntryWritten = entries.find((e) => e.focused)

  check(
    'a three-display capture FOCUSED ON DISPLAY 3 writes a 0.7.0 pack whose focused entry is ' +
      'index 3 and whose files ARE the top-level media',
    written.format_version === '0.7.0' &&
      entries.length === 3 &&
      focusedEntryWritten?.index === FOCUSED_INDEX &&
      focusedEntryWritten.snapshot === 'snapshot.png' &&
      focusedEntryWritten.snapshot === written.media.snapshot &&
      focusedEntryWritten.replay === 'replay.webm' &&
      focusedEntryWritten.replay === written.media.replay,
    `focused entry ${String(focusedEntryWritten?.index)} -> ${String(focusedEntryWritten?.snapshot)}/${String(focusedEntryWritten?.replay)}`,
  )
  // The name that must NOT appear. displaySnapshotName(3) really does produce
  // it, and the writer really does compute it — this asserts the suppression,
  // not the absence of the idea.
  const files = new Set(readdirSync(dir))
  check(
    'the focused display’s per-display names are computed and then SUPPRESSED: the folder holds ' +
      'no snapshot-d3.png / replay-d3.webm, and no entry declares one',
    displaySnapshotName(FOCUSED_INDEX) === 'snapshot-d3.png' &&
      displayReplayName(FOCUSED_INDEX) === 'replay-d3.webm' &&
      !files.has('snapshot-d3.png') &&
      !files.has('replay-d3.webm') &&
      !entries.some((e) => e.snapshot === 'snapshot-d3.png' || e.replay === 'replay-d3.webm'),
    [...files].filter((f) => f.includes('-d3.')).join(',') || 'no d3 files',
  )
  check(
    'the two NON-focused displays keep their own indexed names, and display 1’s replay is ' +
      'replay-d1.webm — not replay-d2 or the top-level file',
    files.has('snapshot-d1.png') &&
      files.has('snapshot-d2.png') &&
      files.has('replay-d1.webm') &&
      entries.find((e) => e.index === 1)?.snapshot === 'snapshot-d1.png' &&
      entries.find((e) => e.index === 1)?.replay === 'replay-d1.webm' &&
      entries.find((e) => e.index === 2)?.snapshot === 'snapshot-d2.png',
  )

  // RISK 4 in the pack: the failed recorder is display 2 and ONLY display 2.
  check(
    'the PARTIAL failure is in the pack and names the right screen: display 2 declares no replay ' +
      'and no replay file was written, while displays 1 and 3 keep theirs',
    entries.find((e) => e.index === FAILED_INDEX)?.replay === null &&
      entries.find((e) => e.index === FAILED_INDEX)?.replay_duration_ms === undefined &&
      entries.find((e) => e.index === FAILED_INDEX)?.replay_clock_offset_ms === undefined &&
      !files.has('replay-d2.webm') &&
      entries.find((e) => e.index === 1)?.replay === 'replay-d1.webm' &&
      written.media.replay === 'replay.webm',
    `d2 replay ${JSON.stringify(entries.find((e) => e.index === FAILED_INDEX)?.replay)}`,
  )
  check(
    'NEGATIVE CONTROL: display 2 IS still a declared display with its own frame — a dead recorder ' +
      'costs the screen its replay, not its place in the pack',
    entries.find((e) => e.index === FAILED_INDEX)?.snapshot === 'snapshot-d2.png' &&
      entries.find((e) => e.index === FAILED_INDEX)?.snapshot_width === 1_200 &&
      entries.find((e) => e.index === FAILED_INDEX)?.snapshot_height === 1_920,
  )

  // What the user READS about it.
  const summary = displaySummaryLines(written, undefined, [])
  const failedLine = summary.find((l) => l.startsWith(`  - ${String(FAILED_INDEX)}:`)) ?? ''
  const okLine = summary.find((l) => l.startsWith('  - 1:')) ?? ''
  check(
    'report.md says "no replay" on display 2 and names display 1’s file on display 1 — the right ' +
      'screen, by number',
    failedLine.includes('no replay') &&
      !failedLine.includes('replay-d2') &&
      okLine.includes('replay-d1.webm') &&
      !okLine.includes('no replay'),
    failedLine.trim(),
  )
  check(
    'and report.md’s file list offers display 2’s snapshot but no replay for it, while display 1 ' +
      'gets both',
    (() => {
      const listed = extraDisplayFiles(written).map((f) => f.name)
      return (
        listed.includes('snapshot-d2.png') &&
        !listed.some((n) => n.startsWith('replay-d2.')) &&
        listed.includes('snapshot-d1.png') &&
        listed.includes('replay-d1.webm')
      )
    })(),
    extraDisplayFiles(written).map((f) => f.name).join(','),
  )

  const run = spawnSync(process.execPath, [validator, dir], { cwd: repositoryRoot, encoding: 'utf8' })
  check(
    'and the whole three-display, focus-on-3, one-recorder-dead FOLDER passes the validator end ' +
      'to end',
    run.status === 0,
    `${run.stdout ?? ''}${run.stderr ?? ''}`.split('\n').filter((l) => l.includes('FAIL')).join(' | '),
  )

  // NEGATIVE CONTROLS for the naming rule, on disk. Both mutations are the
  // plausible mistakes — a writer that used the per-display name for the
  // focused display, and one that used its ARRAY POSITION for the file name —
  // and the validator has to refuse both.
  const focusedNamedD3 = path.join(work, 'focused-named-d3')
  cpSync(dir, focusedNamedD3, { recursive: true })
  {
    const file = path.join(focusedNamedD3, 'manifest.json')
    const m = JSON.parse(readFileSync(file, 'utf8')) as Manifest
    const e = (m.media.displays ?? []).find((x) => x.focused)
    if (e !== undefined) e.snapshot = 'snapshot-d3.png'
    writeFileSync(focusedNamedD3 + path.sep + 'snapshot-d3.png', pngHeader(3_840, 2_160))
    writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`, 'utf8')
  }
  const badFocused = spawnSync(process.execPath, [validator, focusedNamedD3], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
  check(
    'NEGATIVE CONTROL: a focused entry that names snapshot-d3.png instead of snapshot.png is ' +
      'INVALID — the focused display’s media IS the pack’s media',
    badFocused.status !== 0 &&
      `${badFocused.stdout ?? ''}`.includes('MUST equal the top-level media.snapshot'),
    `${badFocused.stdout ?? ''}`.split('\n').filter((l) => l.includes('FAIL')).slice(0, 1).join(''),
  )

  const positionalName = path.join(work, 'positional-name')
  cpSync(dir, positionalName, { recursive: true })
  {
    // Display 1 is at array position 0 here, so a writer numbering files from
    // the array would emit the same name either way; display 2 is where a
    // position-based name and an index-based one part company on THIS desk once
    // the focused entry is skipped. Renaming d2's file to d3's name is the
    // shape that mistake takes.
    const file = path.join(positionalName, 'manifest.json')
    const m = JSON.parse(readFileSync(file, 'utf8')) as Manifest
    const e = (m.media.displays ?? []).find((x) => x.index === 2)
    if (e !== undefined) e.snapshot = 'snapshot-d3.png'
    writeFileSync(positionalName + path.sep + 'snapshot-d3.png', pngHeader(1_200, 1_920))
    writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`, 'utf8')
  }
  const badPositional = spawnSync(process.execPath, [validator, positionalName], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
  check(
    'NEGATIVE CONTROL: display 2 declaring snapshot-d3.png is INVALID — a per-display filename ' +
      'must match ITS OWN index',
    badPositional.status !== 0 &&
      `${badPositional.stdout ?? ''}`.includes('MUST be "snapshot-d2.png" to match its index'),
    `${badPositional.stdout ?? ''}`.split('\n').filter((l) => l.includes('FAIL')).slice(0, 1).join(''),
  )
}

// ---------------------------------------------------------------------------
// RISK 4 (continued) — WHAT THE TOAST AND THE TRAY SAY ABOUT A PARTIAL FAILURE.
//
// Both rules below run only at the end of a real capture on a desk where a
// recorder actually died. On this machine that is a hardware accident with two
// screens and IMPOSSIBLE with three, which is why both were reachable only
// through their own module until now. They take their inputs as arguments so a
// three-recorder desk can exist here; see the comments at each definition.
// ---------------------------------------------------------------------------
function toastAndTrayChecks(): void {
  const frozen = (over: Partial<DeskDisplay> & { index: number }) => {
    const base = DESK.find((d) => d.index === over.index)
    const merged = { ...(base as DeskDisplay), ...over }
    return {
      focused: merged.focused,
      replayWebm: merged.recorded ? Buffer.from('bytes') : null,
      replayUnavailableReason: merged.recorded ? null : merged.failure,
    }
  }
  const partial = DESK.map((d) => frozen({ index: d.index }))

  const toast = replayUnavailableForToast(partial)
  check(
    'the toast for a PARTIAL failure counts the screens instead of claiming the pack has no ' +
      'replay: 1 of 3, focused: false, and the reason is the DEAD display’s',
    toast !== null &&
      toast.screens === 1 &&
      toast.total === 3 &&
      toast.focused === false &&
      toast.reason === 'no-frames',
    JSON.stringify(toast),
  )
  check(
    'NEGATIVE CONTROL: with every recorder alive the toast says nothing at all',
    replayUnavailableForToast(DESK.map((d) => frozen({ index: d.index, recorded: true }))) === null,
  )
  // The wording BRANCHES on `focused`. A three-screen desk is the first place
  // the two branches can disagree about which screen failed.
  const focusedDead = replayUnavailableForToast([
    frozen({ index: 1 }),
    frozen({ index: 2, recorded: true, failure: null }),
    frozen({ index: 3, recorded: false, failure: 'screen-unavailable' }),
  ])
  check(
    'NEGATIVE CONTROL: when the FOCUSED display is the one that died the toast flips to the ' +
      'pack-level wording (focused: true) — a different sentence, not a different number',
    focusedDead !== null && focusedDead.focused === true && focusedDead.screens === 1,
    JSON.stringify(focusedDead),
  )
  // Two dead recorders, one of them focused: the focused display's reason has
  // to lead, because that is the failure the user is looking at.
  const twoDead = replayUnavailableForToast([
    frozen({ index: 1 }),
    frozen({ index: 2, recorded: false, failure: 'no-frames' }),
    frozen({ index: 3, recorded: false, failure: 'screen-unavailable' }),
  ])
  check(
    'with TWO dead recorders including the focused one, the reason shown is the FOCUSED ' +
      'display’s — not the lowest-numbered screen’s',
    twoDead !== null &&
      twoDead.reason === 'screen-unavailable' &&
      twoDead.screens === 2 &&
      twoDead.total === 3 &&
      twoDead.focused === true,
    JSON.stringify(twoDead),
  )

  // THE TRAY. Its state is ONE state for the whole desk, so the only honest
  // property is that it is pessimistic: a single stopped recorder must stop the
  // tray claiming to record, and the reason it shows must be the stopped
  // display's. Display ids are not indices — capture.ts keys by Electron
  // Display.id — so they are deliberately not 1/2/3 here.
  const ids = { d1: 2_779_098_405, d2: 2_528_732_444, d3: 65_537 }
  const wanted = new Set([ids.d1, ids.d2, ids.d3])
  const partialTray = aggregateRecorderState(
    wanted,
    new Map([
      [ids.d1, { status: 'recording' as const }],
      [ids.d2, { status: 'stopped' as const, reason: 'no-frames' as const, detail: 'display 2 died' }],
      [ids.d3, { status: 'recording' as const }],
    ]),
  )
  check(
    'the tray does NOT say "recording" while one of three recorders is dead, and the reason it ' +
      'carries is the DEAD display’s',
    partialTray.status === 'stopped' &&
      partialTray.reason === 'no-frames' &&
      partialTray.detail === 'display 2 died',
    JSON.stringify(partialTray),
  )
  check(
    'NEGATIVE CONTROL: all three recording IS "recording" — so the check above is about the dead ' +
      'display, not about three displays being unrepresentable',
    aggregateRecorderState(
      wanted,
      new Map([
        [ids.d1, { status: 'recording' as const }],
        [ids.d2, { status: 'recording' as const }],
        [ids.d3, { status: 'recording' as const }],
      ]),
    ).status === 'recording',
  )
  check(
    'NEGATIVE CONTROL: two recording and one still STARTING is "starting", never "recording" — ' +
      '"recording" is earned by every wanted display',
    aggregateRecorderState(
      wanted,
      new Map([
        [ids.d1, { status: 'recording' as const }],
        [ids.d2, { status: 'starting' as const }],
        [ids.d3, { status: 'recording' as const }],
      ]),
    ).status === 'starting',
  )
  // A display that is not part of the capture cannot make the tray lie either
  // way: this is the hot-unplug window, where a stale state for a display that
  // is no longer wanted is still sitting in the map.
  check(
    'a STOPPED display that is no longer part of the capture does not stop the tray — the wanted ' +
      'set decides, not the leftover state',
    aggregateRecorderState(
      new Set([ids.d1, ids.d3]),
      new Map([
        [ids.d1, { status: 'recording' as const }],
        [ids.d2, { status: 'stopped' as const, reason: 'no-frames' as const, detail: 'unplugged' }],
        [ids.d3, { status: 'recording' as const }],
      ]),
    ).status === 'recording',
  )
}

void writtenPackChecks()
  .then(() => {
    console.log('')
    console.log('THE DESK — three screens, portrait in the middle, focus on 3, recorder 2 dead (#76)')
    boardChecks()
    numberingChecks()
    toastAndTrayChecks()
    return writtenDeskChecks()
  })
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
