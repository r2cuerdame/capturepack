// The production writer, not only the schema validator, must enforce the image
// privacy boundary. Even a bad internal caller cannot smuggle replay bytes or
// another monitor's raster into an explicit image pack.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  buildManifest,
  savePack,
  saveAsNewPack,
  updatePack,
  type DisplayCapture,
  type ExportInput,
  type InitialSaveInput,
} from '../src/main/exporter'
import type { Manifest } from '../src/shared/types'

let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (!condition) failed += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

function manifestAt(dir: string): Manifest {
  return JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Manifest
}

async function rejects(name: string, fn: () => unknown): Promise<void> {
  let rejected = false
  try {
    await fn()
  } catch {
    rejected = true
  }
  check(name, rejected)
}

async function main(): Promise<void> {
  const createdAt = new Date('2026-07-29T12:34:56.000Z')
  const cropBounds = {
    x: -1140,
    y: 100,
    width: 720,
    height: 480,
    coordinate_space: 'virtual-desktop-dip' as const,
  }

  console.log('MANIFEST INTENT')
  const failedVideo = buildManifest({
  id: 'video-without-replay',
  createdAt,
  generatorVersion: 'check',
  title: '',
  note: '',
  osVersion: 'check',
  screens: [{ width: 1200, height: 1920, scale: 1 }],
  captureKind: 'video',
  hasReplay: false,
  replayDurationMs: 0,
  snapshotTMs: null,
})
  check(
  'a requested video remains video when its recorder produced no replay',
  failedVideo.capture_kind === 'video' && failedVideo.media.replay === null,
)
  check(
  'an explicit video declaration uses the 0.3.0 reader contract',
  failedVideo.format_version === '0.3.0',
)

  const region = buildManifest({
  id: 'region-image',
  createdAt,
  generatorVersion: 'check',
  title: '',
  note: '',
  osVersion: 'check',
  screens: [{ width: 1200, height: 1920, scale: 1 }],
  captureKind: 'image',
  imageScope: 'region',
  cropBounds,
  // Deliberately hostile internal input: image intent must win.
  hasReplay: true,
  replayDurationMs: 30_000,
  snapshotTMs: 10_000,
  displays: [
    {
      index: 1,
      focused: true,
      bounds: { x: -1200, y: 0, width: 1200, height: 1920 },
      scale: 1,
      hasReplay: true,
      replayDurationMs: 30_000,
      snapshotFile: 'snapshot.png',
      replayFile: 'replay.mp4',
    },
    {
      index: 2,
      focused: false,
      bounds: { x: 0, y: 0, width: 2560, height: 1440 },
      scale: 1.5,
      hasReplay: true,
      replayDurationMs: 30_000,
      snapshotFile: 'snapshot-d2.png',
      replayFile: 'replay-d2.mp4',
    },
  ],
})
  check(
  'image manifest strips replay and per-display media',
  region.capture_kind === 'image' &&
    region.media.replay === null &&
    region.media.replay_duration_ms === undefined &&
    region.media.snapshot_t_ms === undefined &&
    region.media.displays === undefined,
)
  check(
  'region provenance is exact and explicit',
  region.media.image_scope === 'region' &&
    JSON.stringify(region.media.crop_bounds) === JSON.stringify(cropBounds),
)
  check(
  'explicit image semantics require the 0.3.0 reader contract',
  region.format_version === '0.3.0',
)

  await rejects('image scope can never default implicitly to fullscreen', () =>
  buildManifest({
    id: 'implicit-image',
    createdAt,
    generatorVersion: 'check',
    title: '',
    note: '',
    osVersion: 'check',
    screens: [],
    captureKind: 'image',
    hasReplay: false,
    replayDurationMs: 0,
    snapshotTMs: null,
  }),
)
  await rejects('a region image without crop bounds is rejected', () =>
  buildManifest({
    id: 'missing-crop',
    createdAt,
    generatorVersion: 'check',
    title: '',
    note: '',
    osVersion: 'check',
    screens: [],
    captureKind: 'image',
    imageScope: 'region',
    hasReplay: false,
    replayDurationMs: 0,
    snapshotTMs: null,
  }),
)
  await rejects('fullscreen image cannot carry hidden crop provenance', () =>
  buildManifest({
    id: 'fullscreen-with-crop',
    createdAt,
    generatorVersion: 'check',
    title: '',
    note: '',
    osVersion: 'check',
    screens: [],
    captureKind: 'image',
    imageScope: 'fullscreen',
    cropBounds,
    hasReplay: false,
    replayDurationMs: 0,
    snapshotTMs: null,
  }),
)

  console.log('\nFILESYSTEM WRITER BOUNDARY')
  const root = mkdtempSync(path.join(tmpdir(), 'capturepack-image-writer-'))
  try {
    const displays: DisplayCapture[] = [
    {
      index: 1,
      focused: true,
      bounds: { x: -1200, y: 0, width: 1200, height: 1920 },
      scale: 1,
      hasReplay: true,
      replayDurationMs: 30_000,
      snapshotFile: 'snapshot.png',
      replayFile: 'replay.mp4',
      snapshotPng: null,
      replayWebm: null,
    },
    {
      index: 2,
      focused: false,
      bounds: { x: 0, y: 0, width: 2560, height: 1440 },
      scale: 1.5,
      hasReplay: true,
      replayDurationMs: 30_000,
      snapshotFile: 'snapshot-d2.png',
      replayFile: 'replay-d2.mp4',
      snapshotPng: Buffer.from('SECRET OTHER DISPLAY'),
      replayWebm: Buffer.from('SECRET OTHER VIDEO'),
    },
  ]
    const initial: InitialSaveInput = {
    captureKind: 'image',
    imageScope: 'region',
    cropBounds,
    snapshotPng: Buffer.from('SELECTED PIXELS'),
    width: 720,
    height: 480,
    capturedAt: createdAt,
    // Deliberately supplied: the writer must still refuse to persist it.
    replayWebm: Buffer.from('SECRET VIDEO'),
    replayFile: 'replay.mp4',
    replayDurationMs: 30_000,
    timeline: { t0: createdAt.toISOString(), events: [] },
    outputDir: root,
    displays,
    screens: [{ width: 1200, height: 1920, scale: 1 }],
    windowsContext: null,
    docLanguage: 'en',
  }
    const handle = await savePack(initial)
    const saved = manifestAt(handle.dirPath)
    check(
    'savePack persists the selected image intent',
    saved.capture_kind === 'image' &&
      saved.media.image_scope === 'region' &&
      saved.media.replay === null,
  )
    check('savePack writes no video asset', !existsSync(path.join(handle.dirPath, 'replay.mp4')))
    check(
      'savePack writes no top-level event timeline or timeline skill for a still image',
      !existsSync(path.join(handle.dirPath, 'timeline.json')) &&
        !existsSync(path.join(handle.dirPath, 'skills', 'timeline.md')),
    )
    check(
    'savePack writes no other-display raster or replay',
    !existsSync(path.join(handle.dirPath, 'snapshot-d2.png')) &&
      !existsSync(path.join(handle.dirPath, 'replay-d2.mp4')),
  )

  // A stale file can exist after a crash or hand edit. Finalizing an image
  // must remove the canonical replay name rather than leave undeclared bytes.
    writeFileSync(path.join(handle.dirPath, 'replay.webm'), 'STALE VIDEO')
    writeFileSync(path.join(handle.dirPath, 'timeline.json'), '{"events":[{"type":"stale"}]}')
    writeFileSync(path.join(handle.dirPath, 'skills', 'timeline.md'), '# stale video timeline')
    const plugin = {
      name: 'windows-uia',
      version: '0.3.0',
      path: 'plugins/windows-uia/',
    }
    const pluginDir = path.join(handle.dirPath, 'plugins', plugin.name)
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(path.join(pluginDir, 'meta.json'), JSON.stringify({
      name: plugin.name,
      version: plugin.version,
    }))
    writeFileSync(path.join(pluginDir, 'elements.json'), '{"windows":[],"elements":[]}')
    const final: ExportInput = {
    captureKind: 'image',
    imageScope: 'region',
    cropBounds,
    snapshotPng: Buffer.from('SELECTED PIXELS'),
    width: 720,
    height: 480,
    capturedAt: createdAt,
    replayWebm: Buffer.from('NEW SECRET VIDEO'),
    replayFile: 'replay.webm',
    replayDurationMs: 30_000,
    annotations: [],
    title: '',
    note: '',
    snapshotTMs: null,
    timeline: { t0: createdAt.toISOString(), events: [] },
    displays,
    screens: [{ width: 1200, height: 1920, scale: 1 }],
    windowsContext: null,
    plugins: [plugin],
    clipboardAfterSave: 'off',
    docLanguage: 'en',
  }
    await updatePack(handle, final)
  check(
    'updatePack cannot retain or reintroduce replay bytes for an image',
    !existsSync(path.join(handle.dirPath, 'replay.webm')) &&
      manifestAt(handle.dirPath).media.replay === null,
  )
  check(
    'updatePack removes stale top-level timeline artifacts from an image pack',
    !existsSync(path.join(handle.dirPath, 'timeline.json')) &&
      !existsSync(path.join(handle.dirPath, 'skills', 'timeline.md')),
  )
  const imageDocs = [
    'README.md',
    'report.md',
    'skills/overview.md',
    'skills/annotation.md',
    'skills/dom.md',
    'skills/project.md',
  ].map((file) => readFileSync(path.join(handle.dirPath, file), 'utf8')).join('\n')
  check(
    'generated image-pack documents discuss only the still image, annotations and context',
    !/\b(replay|timeline|video)\b/i.test(imageDocs),
  )

    console.log('\nSAVE AS NEW PLUGIN PRIVACY')
    const hiddenMedia = new Map<string, Buffer>([
      ['hidden.png', Buffer.from('extension alone is enough')],
      ['renamed-png.json', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      ['renamed-jpeg.json', Buffer.from([0xff, 0xd8, 0xff, 0xe0])],
      ['renamed-webp.json', Buffer.from('RIFF0000WEBP', 'ascii')],
      ['renamed-gif.json', Buffer.from('GIF89a', 'ascii')],
      ['renamed-bmp.json', Buffer.from('BM', 'ascii')],
      ['renamed-mp4.json', Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])],
      ['renamed-webm.json', Buffer.from([0x1a, 0x45, 0xdf, 0xa3])],
      ['renamed-matroska.bin', Buffer.from([0x1a, 0x45, 0xdf, 0xa3])],
    ])
    for (const [name, bytes] of hiddenMedia) {
      writeFileSync(path.join(pluginDir, name), bytes)
    }
    const undeclaredPluginDir = path.join(handle.dirPath, 'plugins', 'undeclared')
    mkdirSync(undeclaredPluginDir, { recursive: true })
    writeFileSync(path.join(undeclaredPluginDir, 'meta.json'), '{"name":"undeclared"}')
    writeFileSync(path.join(undeclaredPluginDir, 'payload.json'), '{"secret":"not declared"}')
    const copied = await saveAsNewPack(handle.dirPath, final)
    check(
      'Save As New preserves declared JSON plugin metadata',
      existsSync(path.join(copied.dirPath, 'plugins', plugin.name, 'meta.json')) &&
        existsSync(path.join(copied.dirPath, 'plugins', plugin.name, 'elements.json')) &&
        manifestAt(copied.dirPath).plugins.some((entry) => entry.name === plugin.name),
    )
    check(
      'Save As New rejects media extensions and disguised raster/video magic',
      [...hiddenMedia.keys()].every(
        (name) => !existsSync(path.join(copied.dirPath, 'plugins', plugin.name, name)),
      ),
    )
    check(
      'Save As New does not copy undeclared plugin directories',
      !existsSync(path.join(copied.dirPath, 'plugins', 'undeclared')),
    )
    check(
      'Save As New image still has no replay or per-display source media',
      manifestAt(copied.dirPath).media.replay === null &&
        manifestAt(copied.dirPath).media.displays === undefined,
    )
    check(
      'Save As New image has no top-level timeline artifacts',
      !existsSync(path.join(copied.dirPath, 'timeline.json')) &&
        !existsSync(path.join(copied.dirPath, 'skills', 'timeline.md')),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  console.log(`\n${failed === 0 ? 'image-pack-writer-check ok' : `${failed} failure(s)`}`)
  if (failed > 0) process.exitCode = 1
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
