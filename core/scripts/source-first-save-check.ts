// Final-save regression: authoritative source files must be MCP-readable before
// a slow derived render starts, and a derived failure must not roll them back.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import {
  addManifestPlugin,
  createPackZip,
  domPluginDeclaration,
  savePack,
  saveAsNewPack,
  tryWriteDomPlugin,
  updatePack,
  type DisplayCapture,
  type ExportInput,
  type InitialSaveInput,
} from '../src/main/exporter'
import { createPackStore } from '../src/main/mcp/store'
import { startSourceFirstFinalSave } from '../src/main/sourceFirstFinalSave'
import type { Annotation, Manifest } from '../src/shared/types'

let failures = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (!condition) failures += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

function box(id: string, text: string, startMs: number): Annotation {
  return {
    annotation_id: id,
    type: 'box',
    bounds: { x: 20, y: 30, width: 180, height: 90 },
    text,
    start_ms: startMs,
    end_ms: startMs + 1_000,
    numbered: true,
    blur: false,
    tracking: { enabled: false },
    created_at: '2026-07-30T02:04:42+09:00',
    z: startMs,
  }
}

function allFiles(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else found.push(path.relative(root, full).replaceAll('\\', '/'))
    }
  }
  walk(root)
  return found
}

async function nextImmediate(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

async function observeManifestPublication<T>(
  phase: string,
  run: () => Promise<T>,
): Promise<T> {
  const fsPromises = require('node:fs/promises') as typeof import('node:fs/promises')
  const originalRename = fsPromises.rename
  let commits = 0
  try {
    fsPromises.rename = (async (...args: Parameters<typeof originalRename>) => {
      const [temporaryPath, destinationPath] = args
      const destination = String(destinationPath)
      if (path.basename(destination) === 'manifest.json') {
        commits += 1
        const manifest = JSON.parse(readFileSync(String(temporaryPath), 'utf8')) as Manifest
        const declaredMedia = new Set<string>([manifest.media.snapshot])
        if (typeof manifest.media.replay === 'string') declaredMedia.add(manifest.media.replay)
        for (const display of manifest.media.displays ?? []) {
          declaredMedia.add(display.snapshot)
          if (typeof display.replay === 'string') declaredMedia.add(display.replay)
        }
        for (const mediaName of declaredMedia) {
          const mediaPath = path.join(path.dirname(destination), mediaName)
          check(
            `${phase}: ${mediaName} is non-empty at the manifest commit point`,
            existsSync(mediaPath) && statSync(mediaPath).size > 0,
          )
        }
      }
      return originalRename(...args)
    }) as typeof fsPromises.rename
    const result = await run()
    check(`${phase}: manifest commit was observed`, commits > 0)
    return result
  } finally {
    fsPromises.rename = originalRename
  }
}

async function main(): Promise<void> {
  console.log('PRODUCTION FLOW ORDER')
  const sessionSource = readFileSync(
    path.join(process.cwd(), 'src', 'main', 'session.ts'),
    'utf8',
  )
  const freshFlow = sessionSource.slice(
    sessionSource.indexOf('async function runFlow('),
    sessionSource.indexOf('async function cutCapturedDisplays('),
  )
  const sourceWriteAt = freshFlow.indexOf(
    'await updatePack(savedHandle, sourceInput, { keepReplay: true })',
  )
  const sourceLogAt = freshFlow.indexOf('[capture] source saved')
  const derivedAt = freshFlow.indexOf('renderDerived: async')
  const cutAt = freshFlow.indexOf('await cutCapturedDisplays(')
  check(
    'fresh save publishes source before starting derived work',
    sourceWriteAt >= 0 && sourceWriteAt < derivedAt && derivedAt < cutAt,
  )
  check(
    'the saved log is emitted only after source persistence',
    sourceLogAt > sourceWriteAt &&
      !freshFlow.includes('`[capture] saved ${path.basename(savedHandle.dirPath)}'),
  )
  check(
    'UIA and Chrome source writes settle before final source publication',
    freshFlow.indexOf('await Promise.all([uiaWrite, domWrite])') >= 0 &&
      freshFlow.indexOf('await Promise.all([uiaWrite, domWrite])') < sourceWriteAt,
  )

  console.log('\nSLOW/FAILED DERIVED WORK')
  const outputDir = mkdtempSync(path.join(tmpdir(), 'capturepack-source-first-'))
  try {
    const capturedAt = new Date('2026-07-29T17:04:42.000Z')
    const timeline = {
      t0: '2026-07-29T17:04:32.000Z',
      events: [
        {
          t_ms: 10_000,
          type: 'core.capture.triggered',
          source: 'core',
          data: { hotkey: 'Ctrl+Alt+C' },
        },
      ],
    }
    const displays: DisplayCapture[] = [
      {
        index: 1,
        focused: true,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        scale: 1,
        snapshotWidth: 1920,
        snapshotHeight: 1080,
        hasReplay: true,
        replayDurationMs: 10_000,
        snapshotFile: 'snapshot.png',
        replayFile: 'replay.mp4',
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
        replayDurationMs: 10_000,
        snapshotFile: 'snapshot-d2.png',
        replayFile: 'replay-d2.mp4',
        snapshotPng: Buffer.from('SECONDARY SNAPSHOT'),
        replayWebm: Buffer.from('SECONDARY REPLAY'),
      },
    ]
    const initial: InitialSaveInput = {
      captureKind: 'video',
      snapshotPng: Buffer.from('RAW SNAPSHOT'),
      width: 1920,
      height: 1080,
      capturedAt,
      replayWebm: Buffer.from('RAW REPLAY THAT MUST SURVIVE A SLOW RENDER'),
      replayFile: 'replay.mp4',
      replayDurationMs: 10_000,
      timeline,
      outputDir,
      screens: [
        { width: 1920, height: 1080, scale: 1 },
        { width: 1280, height: 720, scale: 1 },
      ],
      displays,
      windowsContext: null,
      docLanguage: 'en',
    }
    const handle = await observeManifestPublication('savePack', () => savePack(initial))
    const saveFirstReadme = readFileSync(path.join(handle.dirPath, 'README.md'), 'utf8')
    const saveFirstReport = readFileSync(path.join(handle.dirPath, 'report.md'), 'utf8')
    check(
      'save-first documents do not promise an undeclared annotated replay',
      !saveFirstReadme.includes('replay_annotated.webm') &&
        !saveFirstReport.includes('replay_annotated.webm'),
    )
    const annotations = [
      box('ann_000001', 'first durable annotation', 1_000),
      box('ann_000002', 'second durable annotation', 4_000),
    ]
    const reeditDisplays: DisplayCapture[] = displays.map((display) => ({
      ...display,
      snapshotPng: null,
      replayWebm: null,
    }))
    const finalInput: ExportInput = {
      captureKind: 'video',
      snapshotPng: Buffer.from('FINAL SOURCE SNAPSHOT'),
      width: 1920,
      height: 1080,
      capturedAt,
      replayWebm: Buffer.from('A DERIVED RENDER MUST NOT WRITE THIS YET'),
      replayFile: 'replay.mp4',
      replayDurationMs: 8_000,
      annotations,
      title: 'source revision is the save',
      note: 'rendering is derived',
      snapshotTMs: 7_500,
      trimOffsetMs: 2_000,
      timeline,
      screens: [
        { width: 1920, height: 1080, scale: 1 },
        { width: 1280, height: 720, scale: 1 },
      ],
      displays: reeditDisplays,
      windowsContext: null,
      clipboardAfterSave: 'off',
      docLanguage: 'en',
    }

    // Plugin source is part of the same durable revision. This mirrors the
    // capture flow's awaited Chrome write before updatePack publishes manifest.
    const domWritten = await tryWriteDomPlugin(handle.dirPath, {
      protocol: 1,
      extension_version: 'check',
      events: [
        {
          t_ms: 2_000,
          type: 'click',
          tab: { url: 'https://example.test/', title: 'Example' },
          element: {
            tag: 'button',
            selector: '#save',
            text: 'Save',
            bounds: { x: 100, y: 120, width: 80, height: 32 },
          },
        },
      ],
    })
    check('DOM source payload was written', domWritten)
    await addManifestPlugin(handle, domPluginDeclaration(), 'en')
    const lateDomSkill = readFileSync(path.join(handle.dirPath, 'skills', 'dom.md'), 'utf8')
    const lateOverview = readFileSync(path.join(handle.dirPath, 'skills', 'overview.md'), 'utf8')
    check(
      'a late plugin declaration refreshes its generated semantic document',
      lateDomSkill.includes('**chrome-dom**') &&
        !lateDomSkill.includes('No plugin contributed semantic object data'),
    )
    check(
      'a late plugin declaration refreshes the generated plugin count',
      lateOverview.includes('1 plugins.'),
    )

    let releaseRender: () => void = () => {
      throw new Error('render gate was not initialized')
    }
    const renderGate = new Promise<void>((resolve) => {
      releaseRender = resolve
    })
    let renderStarted = false
    let renderFailed = false

    const sourcePath = await observeManifestPublication('updatePack', () =>
      startSourceFirstFinalSave({
        persistSource: async () => {
          await updatePack(handle, finalInput, { keepReplay: true })
          return handle.dirPath
        },
        renderDerived: async () => {
          renderStarted = true
          await renderGate
          throw new Error('simulated derived renderer failure')
        },
        onDerivedFailure: () => {
          renderFailed = true
        },
      }),
    )

    check('source completion returns the pack path', sourcePath === handle.dirPath)
    check(
      'raw replay is preserved while derived work is pending',
      readFileSync(path.join(handle.dirPath, 'replay.mp4'), 'utf8') ===
        'RAW REPLAY THAT MUST SURVIVE A SLOW RENDER',
    )

    // This is the exact store used by the MCP server. It must identify and read
    // the final source revision immediately, without waiting on renderGate.
    const store = createPackStore({ outputDir, watch: false })
    try {
      const latest = store.latest()
      const manifest = latest.manifest()
      const savedAnnotations = latest.annotations()
      const savedTimeline = latest.timeline()
      check(
        'MCP store resolves the final pack identity immediately',
        latest.path === handle.dirPath && latest.manifest()?.id === handle.id,
      )
      check(
        'MCP manifest already carries final title and trim clock',
        manifest?.title === finalInput.title &&
          manifest.media.replay_duration_ms === finalInput.replayDurationMs &&
          manifest.media.trim_offset_ms === finalInput.trimOffsetMs,
      )
      check(
        'MCP annotations are complete before render',
        savedAnnotations?.annotations.length === 2 &&
          savedAnnotations.annotations[0]?.text === annotations[0]?.text &&
          savedAnnotations.annotations[1]?.text === annotations[1]?.text,
      )
      check(
        'timeline is final before render',
        savedTimeline?.events.some((event) => event.type === 'core.export.created') === true,
      )
      check(
        'report is generated from final annotations before render',
        (latest.report() ?? '').includes('first durable annotation') &&
          (latest.report() ?? '').includes('second durable annotation'),
      )
      check(
        'README and every skill are available before render',
        latest.readText('README.md')?.includes('source revision is the save') === true &&
          ['overview', 'timeline', 'annotation', 'dom', 'project'].every((name) =>
            existsSync(path.join(handle.dirPath, 'skills', `${name}.md`)),
          ),
      )
      check(
        'plugin source and declaration are readable before render',
        manifest?.plugins?.some((plugin) => plugin.name === 'chrome-dom') === true &&
          latest.readText('plugins/chrome-dom/elements.json')?.includes('"click"') === true,
      )
    } finally {
      store.dispose()
    }

    const sourceBeforeFailure = readFileSync(
      path.join(handle.dirPath, 'annotations.json'),
      'utf8',
    )
    await nextImmediate()
    check('derived work starts only after source completion', renderStarted)
    check('slow derived work remains independent of source readability', !renderFailed)
    releaseRender()
    await nextImmediate()
    await nextImmediate()
    check('derived failure is reported separately', renderFailed)
    check(
      'derived failure cannot roll back authoritative annotations',
      readFileSync(path.join(handle.dirPath, 'annotations.json'), 'utf8') ===
        sourceBeforeFailure,
    )
    check(
      'atomic source publication leaves no temporary files behind',
      allFiles(handle.dirPath).every((file) => !file.endsWith('.tmp')),
    )

    console.log('\nMEDIA-FIRST MANIFEST COMMIT (#216)')
    const manifestBeforeFailedUpdate = readFileSync(
      path.join(handle.dirPath, 'manifest.json'),
      'utf8',
    )
    const mediaFsPromises = require('node:fs/promises') as typeof import('node:fs/promises')
    const originalWriteFile = mediaFsPromises.writeFile
    let mediaFailureObserved = false
    try {
      mediaFsPromises.writeFile = (async (...args: Parameters<typeof originalWriteFile>) => {
        if (String(args[0]) === path.join(handle.dirPath, 'snapshot.png')) {
          throw new Error('simulated snapshot write failure')
        }
        return originalWriteFile(...args)
      }) as typeof mediaFsPromises.writeFile
      try {
        await updatePack(
          handle,
          { ...finalInput, title: 'must not be published after media failure' },
          { keepReplay: true },
        )
      } catch (error) {
        mediaFailureObserved = (error as Error).message === 'simulated snapshot write failure'
      }
    } finally {
      mediaFsPromises.writeFile = originalWriteFile
    }
    check('finalize propagates a source-media write failure', mediaFailureObserved)
    check(
      'failed source-media write leaves the previously published manifest unchanged',
      readFileSync(path.join(handle.dirPath, 'manifest.json'), 'utf8') ===
        manifestBeforeFailedUpdate,
    )

    const copied = await observeManifestPublication('saveAsNewPack', () =>
      saveAsNewPack(handle.dirPath, finalInput),
    )
    check(
      'Save As New publishes a complete independent media set',
      ['snapshot.png', 'replay.mp4', 'snapshot-d2.png', 'replay-d2.mp4'].every((name) => {
        const file = path.join(copied.dirPath, name)
        return existsSync(file) && statSync(file).size > 0
      }),
    )

    console.log('\nFULL ZIP ATOMIC ARCHIVE CREATION & RESILIENCE (#177)')
    // 1. Successful creation: archive contains complete media and manifest
    const zipPath = await createPackZip(handle.dirPath)
    check('createPackZip returns the expected zip destination path', zipPath === `${handle.dirPath}.zip`)
    check('createPackZip created the zip archive', existsSync(zipPath))
    const initialZip = new AdmZip(zipPath)
    const initialEntries = initialZip.getEntries().map((e) => e.entryName)
    check('Full ZIP archive contains manifest.json', initialEntries.includes('manifest.json'))
    check('Full ZIP archive contains snapshot.png', initialEntries.includes('snapshot.png'))
    check('Full ZIP archive contains annotations.json', initialEntries.includes('annotations.json'))
    check(
      'Full ZIP archive creation leaves no temporary files in pack or parent directory',
      allFiles(handle.dirPath).every((f) => !f.includes('.tmp')) &&
        readdirSync(outputDir).every((f) => !f.includes('.tmp-')),
    )

    // 2. Atomic replacement: updating pack files and creating zip again replaces the existing archive
    const initialZipBytes = readFileSync(zipPath)
    writeFileSync(path.join(handle.dirPath, 'test-render-finish.txt'), 'render completed successfully')
    await createPackZip(handle.dirPath)
    const updatedZip = new AdmZip(zipPath)
    const updatedEntries = updatedZip.getEntries().map((e) => e.entryName)
    check(
      'createPackZip atomically replaces preexisting archive with updated files',
      updatedEntries.includes('test-render-finish.txt') &&
        updatedZip.getEntry('test-render-finish.txt')?.getData().toString('utf8') ===
          'render completed successfully',
    )
    const updatedZipBytes = readFileSync(zipPath)
    check('preexisting archive bytes were replaced', !updatedZipBytes.equals(initialZipBytes))

    // 3. Error / interruption resilience: failed or interrupted zip operations clean up temporary files and leave preexisting archive unharmed
    const fsPromises = require('node:fs/promises') as typeof import('node:fs/promises')
    const originalRename = fsPromises.rename
    try {
      fsPromises.rename = (async () => {
        throw new Error('Simulated atomic rename failure')
      }) as unknown as typeof fsPromises.rename
      let renameThrew = false
      try {
        await createPackZip(handle.dirPath)
      } catch (err) {
        renameThrew = (err as Error).message === 'Simulated atomic rename failure'
      }
      check('createPackZip propagates atomic rename failure cleanly', renameThrew)
      check(
        'failed zip operation leaves preexisting archive completely unharmed',
        readFileSync(zipPath).equals(updatedZipBytes),
      )
      check(
        'failed zip operation cleans up all temporary sibling files',
        readdirSync(outputDir).every((f) => !f.includes('.tmp-')),
      )
    } finally {
      fsPromises.rename = originalRename
    }

    // 4. Source invariant checks for #177
    const historySource = readFileSync(
      path.join(process.cwd(), 'src', 'main', 'historyWindow.ts'),
      'utf8',
    ).split('\r\n').join('\n')
    const exporterSource = readFileSync(
      path.join(process.cwd(), 'src', 'main', 'exporter.ts'),
      'utf8',
    ).split('\r\n').join('\n')

    const historyCreateZipSection = historySource.slice(
      historySource.indexOf('IPC.historyCreateZip'),
      historySource.indexOf('IPC.historyPlanShare'),
    )
    check(
      'historyCreateZip guards against in-flight renders before starting zip operation',
      historyCreateZipSection.includes('isRenderInFlight(entry.path)') &&
        historyCreateZipSection.includes("return { ok: false, error: t('history.shareErrNotReady') }"),
    )
    check(
      'createPackZip writes to a unique temporary sibling file and renames it',
      exporterSource.includes('const temporaryPath = `${zipPath}.tmp-${process.pid}-${randomUUID()}.zip`') &&
        exporterSource.includes('await zip.writeZipPromise(temporaryPath, { overwrite: true })') &&
        exporterSource.includes('await rename(temporaryPath, zipPath)'),
    )
    check(
      'createPackZip cleans up temporary files in finally block',
      exporterSource.includes('await rm(temporaryPath, { force: true })'),
    )
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }

  console.log(
    `\n${failures === 0 ? 'source-first-save-check ok' : `${failures} failure(s)`}`,
  )
  if (failures > 0) process.exitCode = 1
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
