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
  readTimelineSafe,
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
import { buildReport, describeAnnotation } from '../src/main/report'
import { buildReadme, buildSkills } from '../src/main/packdocs'
import { drawDisplayLabels } from '../src/renderer/editor/render'
import { drawBox, renderedLabelBottomGutter } from '../src/renderer/render/render'
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
  check('unannotated pack omits annotations.json from file inventory', !sourceHtml.includes('<code>annotations.json</code>'))
  const unannotatedHtml = buildViewerHtml(base, undefined, timeline(), 'en')
  check('pack without annotations file omits annotations.json from file inventory', !unannotatedHtml.includes('<code>annotations.json</code>'))

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
  check('annotated pack includes annotations.json in file inventory', annotatedHtml.includes('<code>annotations.json</code>'))

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
          snapshot_width: 1600,
          snapshot_height: 2560,
          replay: null,
          bounds: { x: -1280, y: -600, width: 1280, height: 2048 },
          scale: 1.25,
        },
        {
          index: 2,
          focused: false,
          snapshot: 'snapshot-d2.png',
          snapshot_width: 1920,
          snapshot_height: 1080,
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
          // 1707 DIP x 1.5 rounds to 2561, and the real raster is 2560. This
          // entry is the fractional-scale case the declared frame exists for.
          snapshot_width: 2560,
          snapshot_height: 1440,
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
  // The viewer prints the frame the entry DECLARES, not bounds x scale. This
  // display's bounds multiply out to 2561x1440 and its raster is 2560x1440 —
  // the fractional-scale disagreement media.displays[].snapshot_width settles.
  check(
    'per-display summary uses the declared snapshot frame, not bounds x scale',
    multiHtml.includes('2560×1440 @1.5x') && !multiHtml.includes('2561×1440'),
  )
  check('partial per-display replay is honest', multiHtml.includes('snapshot-d1.png') && multiHtml.includes('replay-d2.webm'))
  check('annotation display and semantic target are preserved', multiHtml.includes('<dd>2</dd>') && multiHtml.includes('saveButton') && multiHtml.includes('<b>role:</b> button'))
  check(
    'core navigation follows pack language',
    multiHtml.includes('>주석</h2>') &&
      multiHtml.includes('>파일</h2>') &&
      multiHtml.includes('>디스플레이</h2>') &&
      multiHtml.includes('>플러그인</h2>') &&
      sourceHtml.includes('>Plugins</h2>'),
  )

  const flagsHtml = buildViewerHtml(
    videoManifest(),
    annotations([
      box('ann_numbered', 'Numbered only', { numbered: true, blur: false }),
      box('ann_plain', 'Plain box', { numbered: false, blur: false }),
      box('ann_both', 'Blur and numbered', { numbered: true, blur: true }),
    ]),
    timeline(),
    'en',
  )
  check(
    'numbered annotation without blur renders numbered without em-dash',
    flagsHtml.includes('<dd>numbered</dd>') && !flagsHtml.includes('—numbered'),
  )
  check('unflagged annotation renders em-dash', flagsHtml.includes('<dd>—</dd>'))
  check(
    'annotation with blur and numbered renders both flags',
    flagsHtml.includes('<dd>blur, numbered</dd>'),
  )
  check(
    'unnumbered annotation in mixed sequence renders no fabricated badge',
    flagsHtml.includes('<header><strong>Plain box</strong></header>') &&
      !flagsHtml.includes('<span class="annotation-number">2</span><strong>Plain box</strong>') &&
      !flagsHtml.includes('<span class="annotation-number">1</span><strong>Plain box</strong>'),
  )
  check(
    'mixed sequence produces no badge collisions and exact display numbers',
    flagsHtml.includes('<header><span class="annotation-number">2</span><strong>Numbered only</strong></header>') &&
      flagsHtml.includes('<header><span class="annotation-number">1</span><strong>Blur and numbered</strong></header>') &&
      (flagsHtml.match(/<span class="annotation-number">2<\/span>/gu) ?? []).length === 1 &&
      (flagsHtml.match(/class="annotation-number"/gu) ?? []).length === 2,
  )

  const specExampleHtml = buildViewerHtml(
    videoManifest(),
    annotations([
      box('ann_a', 'Box A', {
        numbered: false,
        created_at: '2026-07-30T12:00:01+09:00',
      }),
      box('ann_b', 'Box B', {
        numbered: true,
        created_at: '2026-07-30T12:00:02+09:00',
      }),
      box('ann_c', 'Box C', {
        numbered: true,
        created_at: '2026-07-30T12:00:03+09:00',
      }),
    ]),
    timeline(),
    'en',
  )
  check(
    'SPEC 8.5 example: A (unnumbered) has no number, B is #1, C is #2 without collision',
    specExampleHtml.includes('<header><strong>Box A</strong></header>') &&
      specExampleHtml.includes('<header><span class="annotation-number">1</span><strong>Box B</strong></header>') &&
      specExampleHtml.includes('<header><span class="annotation-number">2</span><strong>Box C</strong></header>') &&
      (specExampleHtml.match(/<span class="annotation-number">1<\/span>/gu) ?? []).length === 1 &&
      (specExampleHtml.match(/<span class="annotation-number">2<\/span>/gu) ?? []).length === 1 &&
      (specExampleHtml.match(/class="annotation-number"/gu) ?? []).length === 2,
  )

  const leadingUnnumberedHtml = buildViewerHtml(
    videoManifest(),
    annotations([
      box('ann_lead_unnum', 'Unnumbered leading', { numbered: false }),
      box('ann_seq_num', 'Numbered second', { numbered: true }),
    ]),
    timeline(),
    'en',
  )
  check(
    'leading unnumbered box does not fabricate number badge or collide with numbered box',
    leadingUnnumberedHtml.includes('<header><strong>Unnumbered leading</strong></header>') &&
      leadingUnnumberedHtml.includes('<header><span class="annotation-number">1</span><strong>Numbered second</strong></header>') &&
      (leadingUnnumberedHtml.match(/<span class="annotation-number">1<\/span>/gu) ?? []).length === 1 &&
      (leadingUnnumberedHtml.match(/class="annotation-number"/gu) ?? []).length === 1,
  )

  const omittedNumberedBox = box('ann_omitted', 'Omitted numbered flag')
  delete (omittedNumberedBox as Partial<Annotation>).numbered
  const allUnnumberedHtml = buildViewerHtml(
    videoManifest(),
    annotations([
      box('ann_u1', 'Unnumbered A', { numbered: false }),
      box('ann_u2', 'Unnumbered B', { numbered: false }),
      omittedNumberedBox,
    ]),
    timeline(),
    'en',
  )
  check(
    'pack with only unnumbered annotations renders zero number badges',
    !allUnnumberedHtml.includes('class="annotation-number"') &&
      allUnnumberedHtml.includes('<header><strong>Unnumbered A</strong></header>') &&
      allUnnumberedHtml.includes('<header><strong>Unnumbered B</strong></header>') &&
      allUnnumberedHtml.includes('<header><strong>Omitted numbered flag</strong></header>'),
  )

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

  const noScreensManifest = videoManifest()
  delete (noScreensManifest.environment as { screens?: unknown }).screens
  const noScreensHtml = buildViewerHtml(noScreensManifest, annotations(), timeline(), 'en')
  const noScreensReport = buildReport(noScreensManifest, annotations(), 'en', false, true)
  const noScreensReadme = buildReadme(noScreensManifest, annotations(), 'en', false, true)
  const noScreensSkills = buildSkills(noScreensManifest, annotations(), timeline(), 'en', false)
  check(
    'pack omitting screens generates viewer and docs safely without undefined',
    noScreensHtml.includes('<dt>Screens</dt><dd>unknown</dd>') &&
      !noScreensHtml.includes('undefined') &&
      noScreensReport.includes('- **Screens:** unknown') &&
      !noScreensReport.includes('undefined') &&
      !noScreensReadme.includes('undefined') &&
      !noScreensSkills.overview.includes('undefined'),
  )

  const noOsVersionManifest = videoManifest()
  delete (noOsVersionManifest.environment as { os_version?: unknown }).os_version
  const noOsVersionHtml = buildViewerHtml(noOsVersionManifest, annotations(), timeline(), 'en')
  const noOsVersionReport = buildReport(noOsVersionManifest, annotations(), 'en', false, true)
  const noOsVersionSkills = buildSkills(noOsVersionManifest, annotations(), timeline(), 'en', false)
  check(
    'pack omitting os_version generates viewer and docs without undefined',
    noOsVersionHtml.includes('<dt>OS</dt><dd>windows</dd>') &&
      !noOsVersionHtml.includes('undefined') &&
      noOsVersionReport.includes('- **OS:** windows\n') &&
      !noOsVersionReport.includes('undefined') &&
      noOsVersionSkills.overview.includes('on windows') &&
      !noOsVersionSkills.overview.includes('undefined'),
  )

  const minimalEnvManifest = videoManifest()
  minimalEnvManifest.environment = { os: 'windows' }
  const minimalEnvHtml = buildViewerHtml(minimalEnvManifest, annotations(), timeline(), 'en')
  const minimalEnvReport = buildReport(minimalEnvManifest, annotations(), 'en', false, true)
  const minimalEnvSkills = buildSkills(minimalEnvManifest, annotations(), timeline(), 'en', false)
  check(
    'pack omitting both screens and os_version generates viewer and docs without undefined',
    minimalEnvHtml.includes('<dt>OS</dt><dd>windows</dd>') &&
      minimalEnvHtml.includes('<dt>Screens</dt><dd>unknown</dd>') &&
      !minimalEnvHtml.includes('undefined') &&
      minimalEnvReport.includes('- **OS:** windows\n') &&
      minimalEnvReport.includes('- **Screens:** unknown') &&
      !minimalEnvReport.includes('undefined') &&
      minimalEnvSkills.overview.includes('on windows.') &&
      !minimalEnvSkills.overview.includes('undefined'),
  )

  const noPluginsManifest = videoManifest()
  delete noPluginsManifest.plugins
  const noPluginsSkills = buildSkills(noPluginsManifest, annotations(), timeline(), 'en', false)
  check(
    'pack omitting plugins generates all skills documents without throwing or undefined',
    typeof noPluginsSkills.overview === 'string' &&
      typeof noPluginsSkills.dom === 'string' &&
      typeof noPluginsSkills.annotation === 'string' &&
      typeof noPluginsSkills.project === 'string' &&
      typeof noPluginsSkills.timeline === 'string' &&
      noPluginsSkills.overview.includes('0 plugins.') &&
      noPluginsSkills.dom.includes('No DOM metadata in this pack.') &&
      !noPluginsSkills.overview.includes('undefined') &&
      !noPluginsSkills.dom.includes('undefined'),
  )

  const noTrackingBox = box('ann_no_track', 'A box without tracking')
  delete (noTrackingBox as Partial<Annotation>).tracking
  const noTrackingAnnotations = annotations([noTrackingBox])
  const noTrackingSkills = buildSkills(videoManifest(), noTrackingAnnotations, timeline(), 'en', false)
  check(
    'pack omitting annotation.tracking generates all skills documents without throwing or undefined',
    typeof noTrackingSkills.annotation === 'string' &&
      noTrackingSkills.annotation.includes('A box without tracking') &&
      !noTrackingSkills.annotation.includes('undefined'),
  )

  const noTextBox = box('ann_no_text', '')
  delete (noTextBox as Partial<Annotation>).text
  const noTextAnnotations = annotations([noTextBox])
  const noTextManifest = videoManifest()
  const noTextHtml = buildViewerHtml(noTextManifest, noTextAnnotations, timeline(), 'en')
  const noTextReport = buildReport(noTextManifest, noTextAnnotations, 'en', false, true)
  const noTextReadme = buildReadme(noTextManifest, noTextAnnotations, 'en', false, true)
  const noTextSkills = buildSkills(noTextManifest, noTextAnnotations, timeline(), 'en', false)
  const noTextGutter = renderedLabelBottomGutter([noTextBox], 1)
  const noTextDesc = describeAnnotation(noTextBox)

  const fakeRegion = { cx: 0, cy: 0, cw: 1920, ch: 1080, cscale: 1, width: 1920, height: 1080 }
  const fakeCtx = {
    save: () => {},
    restore: () => {},
    setTransform: () => {},
    measureText: () => ({ width: 0 }),
    fillText: () => {},
    strokeRect: () => {},
    fillRect: () => {},
    beginPath: () => {},
    arc: () => {},
    roundRect: () => {},
    fill: () => {},
    stroke: () => {},
  } as unknown as CanvasRenderingContext2D
  let labelsThrew = false
  try {
    drawDisplayLabels(fakeCtx, fakeRegion, [noTextBox], 1)
    drawBox(fakeCtx, noTextBox, 1, 1)
  } catch {
    labelsThrew = true
  }

  check(
    'pack omitting annotation.text generates viewer, report, readme, skills, gutter, and canvas labels cleanly',
    typeof noTextHtml === 'string' &&
      !noTextHtml.includes('undefined') &&
      typeof noTextReport === 'string' &&
      !noTextReport.includes('undefined') &&
      typeof noTextReadme === 'string' &&
      !noTextReadme.includes('undefined') &&
      typeof noTextSkills.overview === 'string' &&
      !noTextSkills.overview.includes('undefined') &&
      typeof noTextSkills.annotation === 'string' &&
      !noTextSkills.annotation.includes('undefined') &&
      noTextGutter === 0 &&
      !noTextDesc.includes('undefined') &&
      !labelsThrew,
  )

  const minimalCandidates = [
    path.resolve(process.cwd(), '../examples/minimal'),
    path.resolve(process.cwd(), 'examples/minimal'),
  ]
  const minimalPackPath = minimalCandidates.find((dir) => existsSync(path.join(dir, 'manifest.json')))
  if (minimalPackPath !== undefined) {
    const minimalManifest = JSON.parse(
      readFileSync(path.join(minimalPackPath, 'manifest.json'), 'utf8'),
    ) as Manifest
    const minimalAnnotations = JSON.parse(
      readFileSync(path.join(minimalPackPath, 'annotations.json'), 'utf8'),
    ) as AnnotationsFile
    const minimalTimeline = JSON.parse(
      readFileSync(path.join(minimalPackPath, 'timeline.json'), 'utf8'),
    ) as TimelineFile
    const minimalSkills = buildSkills(minimalManifest, minimalAnnotations, minimalTimeline, 'en', false)
    check(
      'examples/minimal pack generates all skills documents successfully',
      minimalManifest.plugins === undefined &&
        typeof minimalSkills.overview === 'string' &&
        typeof minimalSkills.dom === 'string' &&
        typeof minimalSkills.annotation === 'string' &&
        typeof minimalSkills.project === 'string' &&
        typeof minimalSkills.timeline === 'string' &&
        minimalSkills.overview.includes('0 plugins.') &&
        minimalSkills.dom.includes('No DOM metadata in this pack.') &&
        !minimalSkills.overview.includes('undefined') &&
        !minimalSkills.dom.includes('undefined'),
    )
  }
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
    check('unannotated savePack viewer omits annotations.json from file inventory', !firstViewer.includes('<code>annotations.json</code>'))
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

    const omittedEnvManifest = JSON.parse(
      readFileSync(path.join(handle.dirPath, 'manifest.json'), 'utf8'),
    ) as Manifest
    delete (omittedEnvManifest.environment as { screens?: unknown }).screens
    delete (omittedEnvManifest.environment as { os_version?: unknown }).os_version
    writeFileSync(
      path.join(handle.dirPath, 'manifest.json'),
      JSON.stringify(omittedEnvManifest, null, 2),
      'utf8',
    )
    await refreshPackDocs(handle.dirPath, 'en')
    const omittedViewer = readFileSync(path.join(handle.dirPath, 'viewer.html'), 'utf8')
    const omittedReport = readFileSync(path.join(handle.dirPath, 'report.md'), 'utf8')
    const omittedReadme = readFileSync(path.join(handle.dirPath, 'README.md'), 'utf8')
    const omittedSkills = readFileSync(path.join(handle.dirPath, 'skills', 'overview.md'), 'utf8')
    check(
      'refreshPackDocs regenerates viewer and docs for pack omitting screens and os_version without throwing or undefined',
      omittedViewer.includes('<dt>Screens</dt><dd>unknown</dd>') &&
        omittedViewer.includes('<dt>OS</dt><dd>windows</dd>') &&
        !omittedViewer.includes('undefined') &&
        omittedReport.includes('- **OS:** windows\n') &&
        omittedReport.includes('- **Screens:** unknown') &&
        !omittedReport.includes('undefined') &&
        omittedSkills.includes('on windows.') &&
        !omittedSkills.includes('undefined') &&
        !omittedReadme.includes('undefined'),
    )

    const omittedPluginsManifest = JSON.parse(
      readFileSync(path.join(handle.dirPath, 'manifest.json'), 'utf8'),
    ) as Manifest
    delete omittedPluginsManifest.plugins
    writeFileSync(
      path.join(handle.dirPath, 'manifest.json'),
      JSON.stringify(omittedPluginsManifest, null, 2),
      'utf8',
    )
    await refreshPackDocs(handle.dirPath, 'en')
    const omittedPluginsOverview = readFileSync(path.join(handle.dirPath, 'skills', 'overview.md'), 'utf8')
    const omittedPluginsDom = readFileSync(path.join(handle.dirPath, 'skills', 'dom.md'), 'utf8')
    const omittedPluginsAnnotation = readFileSync(path.join(handle.dirPath, 'skills', 'annotation.md'), 'utf8')
    const omittedPluginsProject = readFileSync(path.join(handle.dirPath, 'skills', 'project.md'), 'utf8')
    const omittedPluginsTimeline = readFileSync(path.join(handle.dirPath, 'skills', 'timeline.md'), 'utf8')
    const omittedPluginsManifestAfter = JSON.parse(
      readFileSync(path.join(handle.dirPath, 'manifest.json'), 'utf8'),
    ) as Manifest
    check(
      'refreshPackDocs regenerates all skills documents for pack omitting plugins without throwing or undefined',
      omittedPluginsOverview.includes('0 plugins.') &&
        omittedPluginsDom.includes('No DOM metadata in this pack.') &&
        omittedPluginsAnnotation.length > 0 &&
        omittedPluginsProject.length > 0 &&
        omittedPluginsTimeline.length > 0 &&
        !omittedPluginsOverview.includes('undefined') &&
        !omittedPluginsDom.includes('undefined') &&
        existsSync(path.join(handle.dirPath, 'manifest.json')) &&
        omittedPluginsManifestAfter.format_version !== undefined,
    )

    const omittedTrackingAnnotations = JSON.parse(
      readFileSync(path.join(handle.dirPath, 'annotations.json'), 'utf8'),
    ) as AnnotationsFile
    for (const ann of omittedTrackingAnnotations.annotations) {
      delete (ann as Partial<Annotation>).tracking
    }
    writeFileSync(
      path.join(handle.dirPath, 'annotations.json'),
      JSON.stringify(omittedTrackingAnnotations, null, 2),
      'utf8',
    )
    await refreshPackDocs(handle.dirPath, 'en')
    const omittedTrackingAnnotationSkill = readFileSync(
      path.join(handle.dirPath, 'skills', 'annotation.md'),
      'utf8',
    )
    check(
      'refreshPackDocs regenerates skills documents for pack omitting annotation.tracking without throwing',
      omittedTrackingAnnotationSkill.length > 0 &&
        !omittedTrackingAnnotationSkill.includes('undefined'),
    )

    const omittedTextAnnotations = JSON.parse(
      readFileSync(path.join(handle.dirPath, 'annotations.json'), 'utf8'),
    ) as AnnotationsFile
    for (const ann of omittedTextAnnotations.annotations) {
      delete (ann as Partial<Annotation>).text
    }
    writeFileSync(
      path.join(handle.dirPath, 'annotations.json'),
      JSON.stringify(omittedTextAnnotations, null, 2),
      'utf8',
    )
    await refreshPackDocs(handle.dirPath, 'en')
    const omittedTextAnnotationSkill = readFileSync(
      path.join(handle.dirPath, 'skills', 'annotation.md'),
      'utf8',
    )
    const omittedTextOverviewSkill = readFileSync(
      path.join(handle.dirPath, 'skills', 'overview.md'),
      'utf8',
    )
    const omittedTextReport = readFileSync(
      path.join(handle.dirPath, 'report.md'),
      'utf8',
    )
    const omittedTextViewer = readFileSync(
      path.join(handle.dirPath, 'viewer.html'),
      'utf8',
    )
    check(
      'refreshPackDocs regenerates viewer and docs for pack omitting annotation.text without throwing',
      existsSync(path.join(handle.dirPath, 'viewer.html')) &&
        omittedTextViewer.length > 0 &&
        !omittedTextViewer.includes('undefined') &&
        omittedTextReport.length > 0 &&
        !omittedTextReport.includes('undefined') &&
        omittedTextAnnotationSkill.length > 0 &&
        !omittedTextAnnotationSkill.includes('undefined') &&
        omittedTextOverviewSkill.length > 0 &&
        !omittedTextOverviewSkill.includes('undefined'),
    )

    // Issue #200: pack omitting timeline.json (OPTIONAL for video packs per SPEC §4, §10, §14)
    rmSync(path.join(handle.dirPath, 'timeline.json'), { force: true })
    const capturedNoTimelineErrors: string[] = []
    const origConsoleError = console.error
    console.error = (...args: unknown[]): void => {
      capturedNoTimelineErrors.push(args.map(String).join(' '))
      origConsoleError(...args)
    }
    try {
      await refreshPackDocs(handle.dirPath, 'en')
    } finally {
      console.error = origConsoleError
    }
    const noTimelineViewer = readFileSync(path.join(handle.dirPath, 'viewer.html'), 'utf8')
    const noTimelineReport = readFileSync(path.join(handle.dirPath, 'report.md'), 'utf8')
    const noTimelineReadme = readFileSync(path.join(handle.dirPath, 'README.md'), 'utf8')
    const noTimelineTimelineSkill = readFileSync(
      path.join(handle.dirPath, 'skills', 'timeline.md'),
      'utf8',
    )
    check(
      'refreshPackDocs regenerates viewer and docs for pack omitting timeline.json without throwing or logging ENOENT',
      !existsSync(path.join(handle.dirPath, 'timeline.json')) &&
        capturedNoTimelineErrors.length === 0 &&
        noTimelineViewer.length > 0 &&
        !noTimelineViewer.includes('undefined') &&
        noTimelineReport.length > 0 &&
        !noTimelineReport.includes('undefined') &&
        noTimelineReadme.length > 0 &&
        !noTimelineReadme.includes('undefined') &&
        noTimelineTimelineSkill.includes('No events were recorded.') &&
        !noTimelineTimelineSkill.includes('undefined'),
    )

    const lateNoTimelinePluginDir = path.join(handle.dirPath, 'plugins', 'late-no-timeline')
    mkdirSync(lateNoTimelinePluginDir, { recursive: true })
    writeFileSync(
      path.join(lateNoTimelinePluginDir, 'meta.json'),
      '{"name":"late-no-timeline","version":"1"}',
    )
    await addManifestPlugin(
      handle,
      { name: 'late-no-timeline', version: '1.0.0', path: 'plugins/late-no-timeline/' },
      'en',
    )
    const manifestAfterLateNoTimeline = JSON.parse(
      readFileSync(path.join(handle.dirPath, 'manifest.json'), 'utf8'),
    ) as Manifest
    const viewerAfterLateNoTimeline = readFileSync(path.join(handle.dirPath, 'viewer.html'), 'utf8')
    check(
      'addManifestPlugin attaches plugin and updates docs on pack omitting timeline.json without throwing',
      (manifestAfterLateNoTimeline.plugins ?? []).some((p) => p.name === 'late-no-timeline') &&
        viewerAfterLateNoTimeline.includes('late-no-timeline') &&
        !viewerAfterLateNoTimeline.includes('undefined'),
    )

    // Issue #200: malformed timeline.json (SyntaxError and non-array events)
    writeFileSync(path.join(handle.dirPath, 'timeline.json'), '{"events": [corrupted json', 'utf8')
    await refreshPackDocs(handle.dirPath, 'en')
    const malformedJsonSkill = readFileSync(
      path.join(handle.dirPath, 'skills', 'timeline.md'),
      'utf8',
    )
    check(
      'refreshPackDocs falls back to empty timeline on malformed JSON without throwing or aborting',
      malformedJsonSkill.includes('No events were recorded.') &&
        !malformedJsonSkill.includes('undefined'),
    )

    const lateMalformedPluginDir = path.join(handle.dirPath, 'plugins', 'late-malformed')
    mkdirSync(lateMalformedPluginDir, { recursive: true })
    writeFileSync(
      path.join(lateMalformedPluginDir, 'meta.json'),
      '{"name":"late-malformed","version":"1"}',
    )
    await addManifestPlugin(
      handle,
      { name: 'late-malformed', version: '1.0.0', path: 'plugins/late-malformed/' },
      'en',
    )
    const manifestAfterLateMalformed = JSON.parse(
      readFileSync(path.join(handle.dirPath, 'manifest.json'), 'utf8'),
    ) as Manifest
    check(
      'addManifestPlugin succeeds and updates manifest on pack with malformed timeline.json',
      (manifestAfterLateMalformed.plugins ?? []).some((p) => p.name === 'late-malformed'),
    )

    // Invalid shape: events is not an array
    writeFileSync(
      path.join(handle.dirPath, 'timeline.json'),
      JSON.stringify({ t0: '2026-09-22T00:00:00Z', events: 'not-an-array' }),
      'utf8',
    )
    await refreshPackDocs(handle.dirPath, 'en')
    const nonArrayEventsSkill = readFileSync(
      path.join(handle.dirPath, 'skills', 'timeline.md'),
      'utf8',
    )
    check(
      'refreshPackDocs falls back to empty timeline when events is not an array',
      nonArrayEventsSkill.includes('No events were recorded.') &&
        !nonArrayEventsSkill.includes('undefined'),
    )

    // Direct unit checks for readTimelineSafe contract
    const safeMissing = await readTimelineSafe(path.join(outputDir, 'nonexistent'), '2026-01-01T00:00:00Z', 'video')
    check('readTimelineSafe returns fallback for missing directory or file', safeMissing.t0 === '2026-01-01T00:00:00Z' && safeMissing.events.length === 0)
    const safeImage = await readTimelineSafe(handle.dirPath, '2026-01-01T00:00:00Z', 'image')
    check('readTimelineSafe returns empty timeline for image capture without reading disk', safeImage.events.length === 0)
    writeFileSync(
      path.join(handle.dirPath, 'timeline.json'),
      JSON.stringify({
        t0: '2026-09-22T00:00:00Z',
        events: [{ t_ms: 500, type: 'core.capture.triggered' }],
      }),
      'utf8',
    )
    const safeValid = await readTimelineSafe(handle.dirPath, '2026-01-01T00:00:00Z', 'video')
    check('readTimelineSafe preserves valid timeline events', safeValid.events.length === 1 && safeValid.events[0]?.type === 'core.capture.triggered')

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
