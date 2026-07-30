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
  addManifestPlugin,
  refreshPackDocs,
  savePack,
  setManifestRenderOutputs,
  updatePack,
  type ExportInput,
  type InitialSaveInput,
} from '../src/main/exporter'
import {
  buildViewerHtml,
  manifestWithViewerFormat,
  safeViewerPath,
  VIEWER_FORMAT_VERSION,
} from '../src/main/viewer'
import type {
  Annotation,
  AnnotationsFile,
  Manifest,
  TimelineFile,
} from '../src/shared/types'

let failures = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (!condition) failures += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

function box(
  id: string,
  text: string,
  options: Partial<Annotation> = {},
): Annotation {
  return {
    annotation_id: id,
    type: 'box',
    bounds: { x: 20, y: 30, width: 180, height: 90 },
    text,
    start_ms: 1_000,
    end_ms: 2_000,
    numbered: true,
    blur: false,
    tracking: { enabled: false },
    created_at: '2026-07-30T12:00:01+09:00',
    z: 1,
    ...options,
  }
}

function videoManifest(overrides: Partial<Manifest> = {}): Manifest {
  const base: Manifest = {
    format: 'capturepack',
    format_version: VIEWER_FORMAT_VERSION,
    capture_kind: 'video',
    id: 'viewer-contract',
    created_at: '2026-07-30T12:00:00+09:00',
    generator: { name: 'capturepack', version: '0.3.3-rc.1' },
    title: 'Offline viewer',
    note: 'Works from file://',
    environment: {
      os: 'windows',
      os_version: '11',
      screens: [{ width: 1920, height: 1080, scale: 1 }],
      app: 'notepad',
    },
    media: {
      snapshot: 'snapshot.png',
      replay: 'replay.mp4',
      replay_duration_ms: 5_000,
    },
    plugins: [],
  }
  return {
    ...base,
    ...overrides,
    environment: { ...base.environment, ...overrides.environment },
    media: { ...base.media, ...overrides.media },
    plugins: overrides.plugins ?? base.plugins,
  }
}

function annotations(items: Annotation[] = []): AnnotationsFile {
  return {
    reference_width: 1920,
    reference_height: 1080,
    annotations: items,
  }
}

function timeline(createdAt = '2026-07-30T12:00:00+09:00'): TimelineFile {
  return {
    t0: createdAt,
    events: [{ t_ms: 0, type: 'core.capture.triggered', source: 'core' }],
  }
}

function pureContractChecks(): void {
  console.log('PURE VIEWER CONTRACT')
  const base = videoManifest()
  const sourceHtml = buildViewerHtml(base, annotations(), timeline(), 'en')
  check('standalone HTML document', sourceHtml.startsWith('<!doctype html>'))
  check('native video controls use declared source replay', sourceHtml.includes('<video controls') && sourceHtml.includes('src="replay.mp4"'))
  check('source replay is labelled unannotated original', sourceHtml.includes('Unannotated original replay'))
  check('script-free', !/<script\b/iu.test(sourceHtml) && !/\bfetch\s*\(/u.test(sourceHtml))
  check('network disabled by CSP', sourceHtml.includes("connect-src 'none'") && sourceHtml.includes("script-src 'none'"))
  check('390px responsive rule is present', sourceHtml.includes('@media(max-width:390px)'))

  const annotated = videoManifest({
    media: {
      snapshot: 'snapshot.png',
      replay: 'replay.webm',
      replay_duration_ms: 5_000,
      replay_annotated: 'replay_annotated.webm',
      keyframes: [{ file: 'frames/frame-01_00-01.000.png', t_ms: 1_000 }],
    },
  })
  const annotatedHtml = buildViewerHtml(
    annotated,
    annotations([box('ann_annotated', 'Save button')]),
    timeline(),
    'en',
  )
  check('declared annotated replay wins over original', annotatedHtml.includes('src="replay_annotated.webm"') && annotatedHtml.indexOf('src="replay_annotated.webm"') < annotatedHtml.indexOf('replay.webm'))
  check('declared keyframe is rendered', annotatedHtml.includes('src="frames/frame-01_00-01.000.png"'))

  const pendingHtml = buildViewerHtml(
    videoManifest(),
    annotations([box('ann_pending', 'render pending')]),
    timeline(),
    'en',
  )
  check('undeclared conventional render files are never guessed', !pendingHtml.includes('replay_annotated') && !pendingHtml.includes('frames/frame-'))

  const image = videoManifest({
    capture_kind: 'image',
    media: {
      snapshot: 'snapshot.png',
      replay: null,
      image_scope: 'region',
      keyframes: [{ file: 'frames/frame-01_00-00.000.png', t_ms: 0 }],
    },
  })
  const imageHtml = buildViewerHtml(image, annotations([box('ann_image', 'crop')]), undefined, 'en')
  check('image pack shows declared annotated still first', imageHtml.includes('Annotated still') && imageHtml.includes('src="frames/frame-01_00-00.000.png"'))
  check('image pack does not invent timeline or video', !imageHtml.includes('<video') && !imageHtml.includes('<code>timeline.json</code>'))

  const legacy = videoManifest()
  delete legacy.capture_kind
  const legacyHtml = buildViewerHtml(legacy, annotations(), timeline(), 'en')
  check('legacy replay pack degrades to inferred video', legacyHtml.includes('<dd>video</dd>') && legacyHtml.includes('src="replay.mp4"'))

  const multi = videoManifest({
    environment: {
      os: 'windows',
      os_version: '11',
      screens: [
        { width: 1600, height: 2560, scale: 1.25 },
        { width: 1920, height: 1080, scale: 1 },
        { width: 2560, height: 1440, scale: 1.5 },
      ],
      app: 'chrome',
    },
    media: {
      snapshot: 'snapshot.png',
      replay: 'replay.mp4',
      replay_duration_ms: 5_000,
      displays: [
        {
          index: 1,
          focused: false,
          snapshot: 'snapshot-d1.png',
          replay: null,
          bounds: { x: -1280, y: -600, width: 1280, height: 2048 },
          scale: 1.25,
        },
        {
          index: 2,
          focused: false,
          snapshot: 'snapshot-d2.png',
          replay: 'replay-d2.webm',
          replay_duration_ms: 4_900,
          replay_clock_offset_ms: 37,
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          scale: 1,
        },
        {
          index: 3,
          focused: true,
          snapshot: 'snapshot.png',
          replay: 'replay.mp4',
          replay_duration_ms: 5_000,
          replay_clock_offset_ms: 0,
          bounds: { x: 1920, y: -240, width: 1707, height: 960 },
          scale: 1.5,
        },
      ],
    },
  })
  const multiHtml = buildViewerHtml(
    multi,
    annotations([
      box('ann_d2', 'Other display', {
        display: 2,
        target: {
          source: 'uia',
          name: 'Save',
          role: 'button',
          automation_id: 'saveButton',
        },
      }),
    ]),
    timeline(),
    'ko',
  )
  check('focused display may be index 3', multiHtml.includes('<dd>3 (포커스됨)</dd>'))
  check('negative-origin portrait display is represented', multiHtml.includes('Display 1') && multiHtml.includes('1600×2560 @1.25x'))
  check('partial per-display replay is honest', multiHtml.includes('snapshot-d1.png') && multiHtml.includes('replay-d2.webm'))
  check('annotation display and semantic target are preserved', multiHtml.includes('<dd>2</dd>') && multiHtml.includes('saveButton') && multiHtml.includes('<b>role:</b> button'))
  check('core navigation follows pack language', multiHtml.includes('>주석</h2>') && multiHtml.includes('>파일</h2>') && multiHtml.includes('>디스플레이</h2>'))

  const malicious = '</style><script>globalThis.PWNED=true</script>'
  const maliciousManifest = videoManifest({
    title: malicious,
    note: '"><img src=x onerror=alert(1)>',
    plugins: [
      {
        name: '"><img src=x onerror=alert(1)>',
        version: 'javascript:alert(1)',
        path: 'plugins/test/',
      },
    ],
  })
  const maliciousHtml = buildViewerHtml(
    maliciousManifest,
    annotations([
      box('ann_evil', 'javascript:alert(1)', {
        blur: true,
        target: { selector: malicious, url: 'javascript:alert(1)' },
      }),
    ]),
    timeline(),
    'en',
  )
  check('HTML injection is escaped', !maliciousHtml.includes(malicious) && !maliciousHtml.includes('<img src=x') && maliciousHtml.includes('&lt;script&gt;globalThis.PWNED=true&lt;/script&gt;'))
  check('no controlled value becomes an active URL', !/(?:src|href)="(?:https?:|\/\/|javascript:)/iu.test(maliciousHtml))
  check('blur warning names original pixel risk', maliciousHtml.includes('Blur is applied to derived views only') && maliciousHtml.includes('not a sanitized share'))

  check('path guard rejects dot traversal', safeViewerPath('../secret.png') === null)
  check('path guard rejects encoded traversal', safeViewerPath('%2e%2e/secret.png') === null)
  check('path guard rejects encoded separators', safeViewerPath('frames%2fsecret.png') === null && safeViewerPath('frames%5csecret.png') === null)
  check('path guard rejects absolute/URL/drive paths', safeViewerPath('/secret.png') === null && safeViewerPath('C:/secret.png') === null && safeViewerPath('https://example.test/x.png') === null)
  check('path guard accepts an ordinary declared frame', safeViewerPath('frames/frame-01_00-01.000.png') === 'frames/frame-01_00-01.000.png')
  check('viewer raises 0.4 content to format 0.5.0', manifestWithViewerFormat({ ...base, format_version: '0.4.0' }).format_version === '0.5.0')
  check('viewer never lowers a future format', manifestWithViewerFormat({ ...base, format_version: '0.6.0' }).format_version === '0.6.0')
}

async function writerIntegrationChecks(): Promise<void> {
  console.log('\nWRITER / REGENERATION CONTRACT')
  const outputDir = mkdtempSync(path.join(tmpdir(), 'capturepack-viewer-check-'))
  const capturedAt = new Date('2026-07-30T03:00:00.000Z')
  const eventTimeline = timeline(capturedAt.toISOString())
  try {
    const initial: InitialSaveInput = {
      captureKind: 'video',
      snapshotPng: Buffer.from('VIEWER SNAPSHOT'),
      width: 1920,
      height: 1080,
      capturedAt,
      replayWebm: Buffer.from('VIEWER REPLAY'),
      replayFile: 'replay.mp4',
      replayDurationMs: 5_000,
      timeline: eventTimeline,
      outputDir,
      screens: [{ width: 1920, height: 1080, scale: 1 }],
      windowsContext: null,
      docLanguage: 'en',
    }
    const handle = await savePack(initial)
    const firstViewer = readFileSync(path.join(handle.dirPath, 'viewer.html'), 'utf8')
    const firstManifest = JSON.parse(
      readFileSync(path.join(handle.dirPath, 'manifest.json'), 'utf8'),
    ) as Manifest
    check('save writes viewer.html atomically before manifest discovery', firstViewer.includes('src="replay.mp4"') && firstManifest.format_version === '0.5.0')
    check('generated Markdown lists viewer only after success', readFileSync(path.join(handle.dirPath, 'README.md'), 'utf8').includes('viewer.html'))

    const pluginDir = path.join(handle.dirPath, 'plugins', 'late-check')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(path.join(pluginDir, 'meta.json'), '{"name":"late-check","version":"1"}')
    await addManifestPlugin(
      handle,
      { name: 'late-check', version: '1.0.0', path: 'plugins/late-check/' },
      'en',
    )
    check('late plugin regenerates viewer from the same revision', readFileSync(path.join(handle.dirPath, 'viewer.html'), 'utf8').includes('late-check'))

    writeFileSync(path.join(handle.dirPath, 'replay_annotated.webm'), 'ANNOTATED')
    mkdirSync(path.join(handle.dirPath, 'frames'), { recursive: true })
    writeFileSync(path.join(handle.dirPath, 'frames', 'frame-01_00-01.000.png'), 'FRAME')
    await setManifestRenderOutputs(handle, {
      replayAnnotated: true,
      keyframes: [{ file: 'frames/frame-01_00-01.000.png', t_ms: 1_000 }],
    })
    await refreshPackDocs(handle.dirPath, 'en')
    const renderedViewer = readFileSync(path.join(handle.dirPath, 'viewer.html'), 'utf8')
    check('completed render regeneration selects declared annotated media', renderedViewer.includes('src="replay_annotated.webm"') && renderedViewer.includes('src="frames/frame-01_00-01.000.png"'))

    rmSync(path.join(handle.dirPath, 'viewer.html'), { force: true })
    mkdirSync(path.join(handle.dirPath, 'viewer.html'))
    const finalAnnotations = [box('ann_final', 'source survives viewer failure')]
    const finalInput: ExportInput = {
      captureKind: 'video',
      snapshotPng: Buffer.from('FINAL SOURCE SNAPSHOT'),
      width: 1920,
      height: 1080,
      capturedAt,
      replayWebm: Buffer.from('REPLAY IS KEPT'),
      replayFile: 'replay.mp4',
      replayDurationMs: 5_000,
      annotations: finalAnnotations,
      title: 'viewer failure is derived only',
      note: 'source remains authoritative',
      snapshotTMs: 4_500,
      timeline: eventTimeline,
      screens: [{ width: 1920, height: 1080, scale: 1 }],
      windowsContext: null,
      clipboardAfterSave: 'off',
      docLanguage: 'en',
    }
    const expectedErrors: string[] = []
    const previousError = console.error
    console.error = (...args: unknown[]): void => {
      expectedErrors.push(args.map(String).join(' '))
    }
    try {
      await updatePack(handle, finalInput, { keepReplay: true })
    } finally {
      console.error = previousError
    }
    const finalSource = JSON.parse(
      readFileSync(path.join(handle.dirPath, 'annotations.json'), 'utf8'),
    ) as AnnotationsFile
    check('viewer write failure cannot roll back source save', finalSource.annotations[0]?.text === finalAnnotations[0]?.text && existsSync(path.join(handle.dirPath, 'manifest.json')))
    check('viewer failure is logged and Markdown stops claiming it', expectedErrors.some((line) => line.includes('writing viewer.html failed')) && !readFileSync(path.join(handle.dirPath, 'README.md'), 'utf8').includes('| viewer.html |'))
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  pureContractChecks()
  await writerIntegrationChecks()
  if (failures > 0) {
    console.error(`\n${failures} viewer contract check(s) failed`)
    process.exitCode = 1
  } else {
    console.log('\nViewer contract checks passed')
  }
}

void main()
