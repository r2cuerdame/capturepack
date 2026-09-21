import * as fs from 'node:fs'
import * as path from 'node:path'
import { IPC } from '../src/shared/ipc'
import { loadSettings } from '../src/main/settings'
import {
  openHistoryWindow,
  registerHistoryIpc,
  resolveHistoryPlayFile,
  safePackPath,
  summarize,
} from '../src/main/historyWindow'
import type { RawPackEntry } from '../src/main/mcp/store'
import type { Manifest } from '../src/shared/types'

// Access electron stub globals injected by runner
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const electronStub = (globalThis as any).__electronStub

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`condition not met within ${timeoutMs} ms`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function run(): Promise<void> {
  const tmpBase = fs.mkdtempSync(path.join(fs.realpathSync(path.resolve('.')), 'tmp-history-play-check-'))

  try {
  console.log('\n--- 1. safePackPath traversal guard ---')
  check(
    'allows valid relative media filename in pack directory',
    safePackPath(tmpBase, 'replay_annotated.mp4') === path.resolve(tmpBase, 'replay_annotated.mp4'),
  )
  check(
    'allows relative subfolder media path',
    safePackPath(tmpBase, 'media/replay.mp4') === path.resolve(tmpBase, 'media/replay.mp4'),
  )
  check(
    'rejects relative parent directory traversal ../..',
    safePackPath(tmpBase, '../../secret.mp4') === null,
  )
  check(
    'rejects backslash directory traversal ..\\..',
    safePackPath(tmpBase, '..\\..\\secret.mp4') === null,
  )
  check(
    'rejects Windows drive absolute path',
    safePackPath(tmpBase, 'C:\\windows\\system32\\cmd.exe') === null,
  )
  check(
    'rejects POSIX absolute path',
    safePackPath(tmpBase, '/etc/passwd') === null,
  )
  check(
    'rejects empty string',
    safePackPath(tmpBase, '') === null,
  )
  check(
    'rejects non-string values',
    safePackPath(tmpBase, null) === null && safePackPath(tmpBase, undefined) === null,
  )

  console.log('\n--- 2. resolveHistoryPlayFile media target resolution ---')
  const packDirA = path.join(tmpBase, 'Pack_A_MP4')
  fs.mkdirSync(packDirA, { recursive: true })
  fs.writeFileSync(path.join(packDirA, 'replay_annotated.mp4'), 'fake-mp4-data')
  fs.writeFileSync(path.join(packDirA, 'replay.mp4'), 'fake-replay-mp4')

  const manifestA: Manifest = {
    format: 'capturepack',
    format_version: '0.8.0',
    id: 'pack-a-id',
    created_at: new Date().toISOString(),
    generator: { name: 'test', version: '1.0.0' },
    environment: { os: 'windows', screens: [] },
    plugins: [],
    media: {
      snapshot: 'snapshot.png',
      replay: 'replay.mp4',
      replay_annotated: 'replay_annotated.mp4',
    },
  }
  const resolvedA = resolveHistoryPlayFile(packDirA, manifestA)
  check(
    'resolves declared replay_annotated.mp4 when present on disk',
    resolvedA === path.resolve(packDirA, 'replay_annotated.mp4'),
    resolvedA ?? 'null',
  )

  const packDirB = path.join(tmpBase, 'Pack_B_WebM')
  fs.mkdirSync(packDirB, { recursive: true })
  fs.writeFileSync(path.join(packDirB, 'replay_annotated.webm'), 'fake-webm-data')
  const manifestB: Manifest = {
    ...manifestA,
    id: 'pack-b-id',
    media: {
      snapshot: 'snapshot.png',
      replay: 'replay.webm',
      replay_annotated: 'replay_annotated.webm',
    },
  }
  const resolvedB = resolveHistoryPlayFile(packDirB, manifestB)
  check(
    'resolves declared replay_annotated.webm when present on disk',
    resolvedB === path.resolve(packDirB, 'replay_annotated.webm'),
    resolvedB ?? 'null',
  )

  const packDirC = path.join(tmpBase, 'Pack_C_LegacyWebM')
  fs.mkdirSync(packDirC, { recursive: true })
  fs.writeFileSync(path.join(packDirC, 'replay_annotated.webm'), 'fake-webm-data')
  const manifestC: Manifest = {
    ...manifestA,
    id: 'pack-c-id',
    media: {
      snapshot: 'snapshot.png',
      replay: 'replay.webm',
    },
  }
  const resolvedC = resolveHistoryPlayFile(packDirC, manifestC)
  check(
    'falls back to replay_annotated.webm when replay_annotated is undeclared but file exists',
    resolvedC === path.resolve(packDirC, 'replay_annotated.webm'),
    resolvedC ?? 'null',
  )

  const packDirD = path.join(tmpBase, 'Pack_D_FallbackOriginalReplay')
  fs.mkdirSync(packDirD, { recursive: true })
  fs.writeFileSync(path.join(packDirD, 'replay.mp4'), 'fake-replay-mp4')
  const manifestD: Manifest = {
    ...manifestA,
    id: 'pack-d-id',
    media: {
      snapshot: 'snapshot.png',
      replay: 'replay.mp4',
    },
  }
  fs.writeFileSync(path.join(packDirD, 'manifest.json'), JSON.stringify(manifestD))
  const resolvedD = resolveHistoryPlayFile(packDirD, manifestD)
  check(
    'falls back to replay.mp4 (manifest.media.replay) when no annotated replay exists',
    resolvedD === path.resolve(packDirD, 'replay.mp4'),
    resolvedD ?? 'null',
  )

  const packDirNoMedia = path.join(tmpBase, 'Pack_No_Media')
  fs.mkdirSync(packDirNoMedia, { recursive: true })
  const manifestNoMedia: Manifest = {
    ...manifestA,
    id: 'pack-no-media',
    media: {
      snapshot: 'snapshot.png',
      replay: 'replay.mp4',
      replay_annotated: 'replay_annotated.mp4',
    },
  }
  fs.writeFileSync(path.join(packDirNoMedia, 'manifest.json'), JSON.stringify(manifestNoMedia))

  const manifestTraversal: Manifest = {
    ...manifestA,
    media: {
      snapshot: 'snapshot.png',
      replay: 'replay.mp4',
      replay_annotated: '../../outside.mp4',
    },
  }
  const resolvedTraversal = resolveHistoryPlayFile(packDirA, manifestTraversal)
  check(
    'rejects directory traversal in declared replay_annotated and falls back to safe replay.mp4',
    resolvedTraversal === path.resolve(packDirA, 'replay.mp4'),
    resolvedTraversal ?? 'null',
  )

  const packDirE = path.join(tmpBase, 'Pack_E_Missing')
  fs.mkdirSync(packDirE, { recursive: true })
  const resolvedE = resolveHistoryPlayFile(packDirE, manifestA)
  check(
    'returns null when declared files do not exist on disk',
    resolvedE === null,
  )

  console.log('\n--- 3. summarize() HistoryPackSummary annotated state ---')
  const fsStampA = fs.statSync(packDirA).mtimeMs
  fs.writeFileSync(path.join(packDirA, 'manifest.json'), JSON.stringify(manifestA))
  const entryA: RawPackEntry = { id: 'pack-a-id', path: packDirA, kind: 'dir', mtimeMs: fsStampA }
  const summaryA = summarize(entryA)
  check(
    'summarize marks pack with replay_annotated.mp4 on disk as ready',
    summaryA.annotated === 'ready',
    `annotated=${summaryA.annotated}`,
  )

  const packDirMissingAnnotated = path.join(tmpBase, 'Pack_Missing_Annotated')
  fs.mkdirSync(packDirMissingAnnotated, { recursive: true })
  fs.writeFileSync(path.join(packDirMissingAnnotated, 'replay.mp4'), 'fake-replay')
  const manifestMissingAnnotated: Manifest = {
    ...manifestA,
    id: 'pack-missing-annotated',
    media: {
      snapshot: 'snapshot.png',
      replay: 'replay.mp4',
      replay_annotated: 'replay_annotated.mp4',
    },
  }
  fs.writeFileSync(path.join(packDirMissingAnnotated, 'manifest.json'), JSON.stringify(manifestMissingAnnotated))
  const entryMissing: RawPackEntry = {
    id: 'pack-missing-annotated',
    path: packDirMissingAnnotated,
    kind: 'dir',
    mtimeMs: fs.statSync(packDirMissingAnnotated).mtimeMs,
  }
  const summaryMissing = summarize(entryMissing)
  check(
    'summarize marks pack with declared replay_annotated.mp4 absent on disk as missing',
    summaryMissing.annotated === 'missing',
    `annotated=${summaryMissing.annotated}`,
  )

  const packDirScreenshotOnly = path.join(tmpBase, 'Pack_Screenshot_Only')
  fs.mkdirSync(packDirScreenshotOnly, { recursive: true })
  const manifestScreenshotOnly: Manifest = {
    ...manifestA,
    id: 'pack-screenshot-only',
    media: {
      snapshot: 'snapshot.png',
      replay: null,
    },
  }
  fs.writeFileSync(path.join(packDirScreenshotOnly, 'manifest.json'), JSON.stringify(manifestScreenshotOnly))
  const entryScreenshotOnly: RawPackEntry = {
    id: 'pack-screenshot-only',
    path: packDirScreenshotOnly,
    kind: 'dir',
    mtimeMs: fs.statSync(packDirScreenshotOnly).mtimeMs,
  }
  const summaryScreenshotOnly = summarize(entryScreenshotOnly)
  check(
    'summarize marks screenshot-only pack as none',
    summaryScreenshotOnly.annotated === 'none',
    `annotated=${summaryScreenshotOnly.annotated}`,
  )

  const packDirAnnotatedImage = path.join(tmpBase, 'Pack_Annotated_Image')
  fs.mkdirSync(packDirAnnotatedImage, { recursive: true })
  fs.mkdirSync(path.join(packDirAnnotatedImage, 'skills'))
  fs.writeFileSync(path.join(packDirAnnotatedImage, 'snapshot.png'), 'fake-snapshot')
  fs.writeFileSync(path.join(packDirAnnotatedImage, 'annotations.json'), JSON.stringify({
    reference_width: 320,
    reference_height: 200,
    annotations: [{
      annotation_id: 'still-box',
      type: 'box',
      bounds: { x: 10, y: 10, width: 40, height: 30 },
      text: 'still annotation',
      numbered: true,
      blur: false,
      tracking: { enabled: false },
      created_at: new Date().toISOString(),
      z: 1,
    }],
  }))
  const manifestAnnotatedImage: Manifest = {
    ...manifestA,
    capture_kind: 'image',
    id: 'pack-annotated-image',
    media: {
      snapshot: 'snapshot.png',
      replay: null,
      image_scope: 'region',
    },
  }
  fs.writeFileSync(
    path.join(packDirAnnotatedImage, 'manifest.json'),
    JSON.stringify(manifestAnnotatedImage),
  )
  const entryAnnotatedImage: RawPackEntry = {
    id: manifestAnnotatedImage.id,
    path: packDirAnnotatedImage,
    kind: 'dir',
    mtimeMs: fs.statSync(packDirAnnotatedImage).mtimeMs,
  }
  const summaryAnnotatedImage = summarize(entryAnnotatedImage)
  check(
    'summarize marks an annotated image with no keyframe render as missing',
    summaryAnnotatedImage.annotated === 'missing',
    `annotated=${summaryAnnotatedImage.annotated}`,
  )

  console.log('\n--- 4. History IPC invocation ---')
  if (electronStub) {
    const settings = loadSettings().settings
    settings.outputDir = tmpBase
    registerHistoryIpc(settings)
    openHistoryWindow()

    const playHandler = electronStub.__handlers.get(IPC.historyPlay)
    check('IPC.historyPlay handler registered in ipcMain', typeof playHandler === 'function')

    const rerenderHandler = electronStub.__handlers.get(IPC.historyRerender)
    check('IPC.historyRerender handler registered in ipcMain', typeof rerenderHandler === 'function')

    if (typeof rerenderHandler === 'function') {
      const mockEvent = { sender: electronStub.__historyWebContents }
      electronStub.__renderStarts.length = 0
      electronStub.__sentMessages.length = 0
      const rerenderResult = await rerenderHandler(mockEvent, packDirAnnotatedImage)
      check(
        'IPC.historyRerender accepts an image pack without errNoReplayRender',
        rerenderResult?.ok === true,
        JSON.stringify(rerenderResult),
      )
      await waitFor(() => {
        const current = JSON.parse(
          fs.readFileSync(path.join(packDirAnnotatedImage, 'manifest.json'), 'utf8'),
        ) as Manifest
        const keyframe = current.media.keyframes?.[0]?.file
        return typeof keyframe === 'string'
          && fs.existsSync(path.join(packDirAnnotatedImage, keyframe))
          && summarize(entryAnnotatedImage).renderInFlight === false
      })
      check(
        'image retry dispatched a still render payload',
        electronStub.__renderStarts.length === 1
          && electronStub.__renderStarts[0]?.replayWebm === null
          && electronStub.__renderStarts[0]?.snapshotPng !== null,
      )
      const renderedManifest = JSON.parse(
        fs.readFileSync(path.join(packDirAnnotatedImage, 'manifest.json'), 'utf8'),
      ) as Manifest
      const renderedKeyframe = renderedManifest.media.keyframes?.[0]?.file
      check(
        'image retry writes frames/ and declares the keyframe in manifest.json',
        typeof renderedKeyframe === 'string'
          && renderedKeyframe.startsWith('frames/')
          && fs.existsSync(path.join(packDirAnnotatedImage, renderedKeyframe)),
        renderedKeyframe ?? 'undeclared',
      )
      const readySummary = summarize(entryAnnotatedImage)
      check(
        'completed image retry moves the History summary to ready',
        readySummary.annotated === 'ready' && readySummary.renderInFlight === false,
        `annotated=${readySummary.annotated}, inFlight=${readySummary.renderInFlight}`,
      )
      check(
        'image retry notifies History of rendering and done states',
        electronStub.__sentMessages.some(
          (message: { channel: string; payload?: { state?: string } }) =>
            message.channel === IPC.historyRenderStatus && message.payload?.state === 'rendering',
        )
          && electronStub.__sentMessages.some(
            (message: { channel: string; payload?: { state?: string } }) =>
              message.channel === IPC.historyRenderStatus && message.payload?.state === 'done',
          ),
      )
      if (typeof renderedKeyframe === 'string') {
        fs.rmSync(path.join(packDirAnnotatedImage, renderedKeyframe))
        const missingAgain = summarize(entryAnnotatedImage)
        check(
          'cached image summary detects a removed declared keyframe as missing',
          missingAgain.annotated === 'missing',
          `annotated=${missingAgain.annotated}`,
        )
      }
    }

    if (typeof playHandler === 'function') {
      const mockEvent = { sender: electronStub.__historyWebContents }

      electronStub.__openedPaths.length = 0
      const resultA = await playHandler(mockEvent, packDirA)
      check('IPC.historyPlay on MP4 pack returns ok: true', resultA?.ok === true, JSON.stringify(resultA))
      check(
        'IPC.historyPlay opens declared replay_annotated.mp4 via shell.openPath',
        electronStub.__openedPaths.includes(path.resolve(packDirA, 'replay_annotated.mp4')),
        JSON.stringify(electronStub.__openedPaths),
      )
      check(
        'IPC.historyPlay did NOT open replay_annotated.webm on MP4 pack',
        !electronStub.__openedPaths.some((p: string) => p.endsWith('replay_annotated.webm')),
      )

      electronStub.__openedPaths.length = 0
      const resultFallback = await playHandler(mockEvent, packDirD)
      check('IPC.historyPlay falls back to replay.mp4 when annotated is absent', resultFallback?.ok === true)
      check(
        'IPC.historyPlay opened replay.mp4 via shell.openPath',
        electronStub.__openedPaths.includes(path.resolve(packDirD, 'replay.mp4')),
        JSON.stringify(electronStub.__openedPaths),
      )

      electronStub.__openedPaths.length = 0
      const resultMissingAnnotated = await playHandler(mockEvent, packDirMissingAnnotated)
      check(
        'IPC.historyPlay falls back to replay.mp4 when replay_annotated.mp4 is missing',
        resultMissingAnnotated?.ok === true,
      )
      check(
        'IPC.historyPlay opened fallback replay.mp4 for pack with missing replay_annotated',
        electronStub.__openedPaths.includes(path.resolve(packDirMissingAnnotated, 'replay.mp4')),
      )

      electronStub.__openedPaths.length = 0
      const resultNoMedia = await playHandler(mockEvent, packDirNoMedia)
      check(
        'IPC.historyPlay fails with errNotRendered when neither annotated nor source replay exists',
        resultNoMedia?.ok === false && typeof resultNoMedia?.error === 'string',
        JSON.stringify(resultNoMedia),
      )
      check('shell.openPath was NOT called when media is completely missing', electronStub.__openedPaths.length === 0)
    }
  }

  console.log('\n--- 5. Static contract & source checks ---')
  const historySource = fs.readFileSync(path.resolve('src/main/historyWindow.ts'), 'utf8')
  const historyRendererSource = fs.readFileSync(
    path.resolve('src/renderer/history/history.ts'),
    'utf8',
  )
  check(
    'historyWindow.ts does not hardcode path.join(entry.path, "replay_annotated.webm") in historyPlay',
    !historySource.includes("path.join(entry.path, 'replay_annotated.webm')"),
  )
  check(
    'historyWindow.ts does not hardcode pack.fileSize("replay_annotated.webm") in summarize',
    !historySource.includes("pack.fileSize('replay_annotated.webm')"),
  )
  check(
    'historyWindow.ts uses resolveHistoryPlayFile',
    historySource.includes('resolveHistoryPlayFile(entry.path, manifest)'),
  )
  check(
    'History Play stays disabled for replay-less image packs even when keyframes are ready',
    historyRendererSource.includes(
      "playBtn.disabled = !p.hasReplay || p.annotated !== 'ready' || p.kind !== 'dir'",
    ),
  )
  check(
    'History Play explains that replay-less image packs have no replay',
    historyRendererSource.includes(
      "playBtn.title =\n    !p.hasReplay\n      ? t('history.playNoReplay')",
    ),
  )
  } finally {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }

  console.log(`\nresult: ${failed === 0 ? 'OK' : 'BROKEN'} — ${passed} passed, ${failed} failed\n`)
  process.exit(failed === 0 ? 0 : 1)
}

void run().catch((err) => {
  console.error(err)
  process.exit(1)
})
