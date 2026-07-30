// Semantic multi-display persistence contract.
//
// This deliberately goes through the production folder writer and directory
// reader before asking the same render helper used by the editor and annotated
// renderer where the object belongs. A JSON stringify/parse-only check cannot
// catch a writer, manifest, or reader dropping display/time/identity fields.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  savePack,
  updatePack,
  type DisplayCapture,
  type ExportInput,
  type InitialSaveInput,
} from '../src/main/exporter'
import { openPack } from '../src/main/mcp/store'
import {
  renderedAnnotationAt,
  type AuthoredMotionSpace,
} from '../src/shared/track'
import { projectControlTrack } from '../src/renderer/editor/objectTrack'
import type { Annotation, AnnotationTarget } from '../src/shared/types'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) passed += 1
  else failed += 1
  console.log(
    `  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`,
  )
}

function same(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected)
}

const screens = [
  { width: 1_200, height: 1_920, scale: 1 },
  { width: 3_840, height: 2_160, scale: 1.5 },
  { width: 2_400, height: 1_350, scale: 1.25 },
] as const

const displays: DisplayCapture[] = [
  {
    index: 1,
    focused: false,
    bounds: { x: -1_200, y: -480, width: 1_200, height: 1_920 },
    scale: 1,
    hasReplay: true,
    replayDurationMs: 963,
    replayClockOffsetMs: -37,
    snapshotFile: 'snapshot-d1.png',
    replayFile: 'replay-d1.webm',
    snapshotPng: Buffer.from('DISPLAY 1 SNAPSHOT'),
    replayWebm: Buffer.from('DISPLAY 1 REPLAY'),
  },
  {
    index: 2,
    focused: false,
    bounds: { x: 0, y: 0, width: 2_560, height: 1_440 },
    scale: 1.5,
    hasReplay: false,
    replayDurationMs: 0,
    snapshotFile: 'snapshot-d2.png',
    replayFile: null,
    snapshotPng: Buffer.from('DISPLAY 2 FROZEN SNAPSHOT'),
    replayWebm: null,
  },
  {
    index: 3,
    focused: true,
    bounds: { x: 2_560, y: -360, width: 1_920, height: 1_080 },
    scale: 1.25,
    hasReplay: true,
    replayDurationMs: 1_000,
    replayClockOffsetMs: 0,
    snapshotFile: 'snapshot.png',
    replayFile: 'replay.webm',
    snapshotPng: null,
    replayWebm: null,
  },
]

const target: AnnotationTarget = {
  source: 'uia',
  level: 'control',
  name: 'Save',
  control_type: 'Button',
  automation_id: 'capturepack-semantic-save',
  class_name: 'Button',
  process: 'fixture-app',
}

const generatedControlSamples = projectControlTrack(
  [
    { tMs: 100, display: 1, x: 0, y: 0, width: 1_000, height: 1_000 },
    { tMs: 400, display: 2, x: 1_125, y: -960, width: 1_500, height: 1_500 },
    { tMs: 700, display: 3, x: 175, y: -550, width: 1_250, height: 1_250 },
  ],
  {
    display: 1,
    bounds: { x: 100, y: 800, width: 200, height: 100 },
    surfaceBounds: { x: 0, y: 0, width: 1_000, height: 1_000 },
    displays: screens.map((screen, index) => ({
      index: index + 1,
      width: screen.width,
      height: screen.height,
      pixelsPerDip: screen.scale,
    })),
  },
)

const semantic: Annotation = {
  annotation_id: 'ann_a3d15f',
  type: 'box',
  display: 1,
  bounds: { x: 100, y: 800, width: 200, height: 100 },
  text: 'Save',
  start_ms: 100,
  end_ms: 900,
  numbered: true,
  blur: false,
  tracking: {
    enabled: true,
    picked_at_ms: 100,
    samples: generatedControlSamples.map((sample) => ({
      t_ms: sample.tMs,
      ...(sample.display === 1 ? {} : { display: sample.display }),
      x: sample.x,
      y: sample.y,
      width: sample.width,
      height: sample.height,
    })),
  },
  target,
  created_at: '2026-07-30T00:00:00.000Z',
  z: 1,
}

async function main(): Promise<void> {
  const outputDir = await mkdtemp(path.join(tmpdir(), 'capturepack-semantic-roundtrip-'))
  try {
    const capturedAt = new Date('2026-07-30T00:00:01.000Z')
    const timeline = {
      t0: '2026-07-30T00:00:00.000Z',
      events: [],
    }
    const initial: InitialSaveInput = {
      captureKind: 'video',
      snapshotPng: Buffer.from('DISPLAY 3 FOCUSED SNAPSHOT'),
      width: 2_400,
      height: 1_350,
      capturedAt,
      replayWebm: Buffer.from('DISPLAY 3 FOCUSED REPLAY'),
      replayFile: 'replay.webm',
      replayDurationMs: 1_000,
      timeline,
      outputDir,
      displays,
      screens: [...screens],
      windowsContext: null,
      docLanguage: 'en',
    }

    console.log('PRODUCTION WRITER -> DISK -> PRODUCTION DIRECTORY READER')
    const saved = await savePack(initial)
    const finalInput: ExportInput = {
      captureKind: 'video',
      snapshotPng: initial.snapshotPng,
      width: initial.width,
      height: initial.height,
      capturedAt,
      replayWebm: null,
      replayFile: 'replay.webm',
      replayDurationMs: initial.replayDurationMs,
      annotations: [semantic],
      title: 'Semantic three-display roundtrip',
      note: '',
      snapshotTMs: 700,
      timeline,
      displays,
      screens: [...screens],
      windowsContext: null,
      clipboardAfterSave: 'off',
      docLanguage: 'en',
    }
    await updatePack(saved, finalInput, { keepReplay: true })

    // A new handle is the close/reopen boundary. It lazily reads the committed
    // files from disk; it shares no annotations or manifest object with the
    // writer above.
    const reopened = openPack(saved.dirPath, 'dir', path.basename(saved.dirPath))
    const manifest = reopened.manifest()
    const annotations = reopened.annotations()
    const loaded = annotations?.annotations?.[0]
    const declared = manifest?.media.displays ?? []

    check(
      'disk manifest preserves three displays, portrait negative origin, mixed DPI and focus 3',
      declared.length === 3
        && declared[0]?.bounds?.x === -1_200
        && declared[0]?.bounds?.width === 1_200
        && declared[0]?.bounds?.height === 1_920
        && declared[1]?.scale === 1.5
        && declared[2]?.scale === 1.25
        && declared[2]?.focused === true,
      JSON.stringify(declared),
    )
    check(
      'disk manifest preserves independent healthy clocks and the failed recorder remains clockless',
      declared[0]?.replay_clock_offset_ms === -37
        && declared[1]?.replay === null
        && declared[1]?.replay_clock_offset_ms === undefined
        && declared[2]?.replay_clock_offset_ms === 0,
      JSON.stringify(declared),
    )
    check(
      'disk annotations preserve semantic identity, picked time and every observed sample',
      loaded !== undefined
        && same(loaded.target, target)
        && loaded.tracking.picked_at_ms === 100
        && same(loaded.tracking.samples, semantic.tracking.samples),
      JSON.stringify(loaded),
    )

    if (loaded === undefined || manifest === null) return
    const motionSpace: AuthoredMotionSpace = {
      focusedIndex: declared.find((display) => display.focused)?.index ?? 1,
      displays: declared.flatMap((display) => {
        const screen = manifest.environment.screens[display.index - 1]
        return screen === undefined || display.bounds === undefined
          ? []
          : [{
              index: display.index,
              width: screen.width,
              height: screen.height,
              bounds: display.bounds,
            }]
      }),
    }

    // 550 ms is exactly halfway between the display-2 and display-3
    // observations. The earlier measured sample must win. One millisecond
    // later, the display-3 measurement becomes nearer. An interpolator would
    // produce an unobserved midpoint rectangle instead of either answer.
    const exactTie = renderedAnnotationAt(loaded, 550, 1, 1, motionSpace)
    const oneMillisecondLater = renderedAnnotationAt(loaded, 551, 1, 1, motionSpace)
    check(
      'actual render helper keeps the earlier observed sample on an exact tie',
      exactTie.display === 2
        && same(exactTie.bounds, { x: 1_275, y: 240, width: 300, height: 150 })
        && same(exactTie.target, target),
      JSON.stringify(exactTie),
    )
    check(
      'actual render helper jumps to the next observation instead of interpolating',
      oneMillisecondLater.display === 3
        && same(oneMillisecondLater.bounds, { x: 300, y: 450, width: 250, height: 125 })
        && same(oneMillisecondLater.target, target)
        && oneMillisecondLater.bounds.x !== 787,
      JSON.stringify(oneMillisecondLater),
    )
    check(
      'rendering is a view and leaves reopened time, display and identity source unchanged',
      loaded.display === 1
        && loaded.start_ms === 100
        && loaded.end_ms === 900
        && loaded.tracking.samples?.[1]?.display === 2
        && loaded.tracking.samples?.[2]?.display === 3
        && same(loaded.target, target),
      JSON.stringify(loaded),
    )
  } finally {
    await rm(outputDir, { recursive: true, force: true })
  }

  console.log(`\nresult: ${failed === 0 ? 'OK' : 'FAILED'} — ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
