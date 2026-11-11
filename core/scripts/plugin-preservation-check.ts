// FINAL SAVE MUST NOT ORPHAN A SAVE-FIRST PLUGIN PAYLOAD.
//
// The Chrome bridge writes plugins/chrome-dom and patches manifest.json while
// the editor is open. Fresh-capture ExportInput carries the UIA dump, but not
// that already-declared browser plugin. updatePack then regenerates the whole
// manifest, which used to leave the directory on disk while deleting its
// declaration.
//
// This drives the real exporter in that exact order:
//   1. save-first manifest already declares chrome-dom;
//   2. final save writes/declares windows-uia from ExportInput.uia;
//   3. both declarations and both physical payloads must remain.
//
// A PLUGIN IS PUBLISHED BY ITS meta.json, SO THAT FILE GOES DOWN LAST.
//
// Readers (re-edit, Save As New, the MCP store) take meta.json as "this plugin
// exists". The windows-uia, chrome-dom and windows-context writers therefore
// land their payload first, and a write that fails part-way through leaves
// nothing that advertises it. Each order is pinned by blocking one file's
// rename with a directory of the same name. The never-fail wrappers must also
// remove a directory their failed write left unpublished — while a payload an
// earlier write already published, and the manifest already declares, stays.
//
// SAVE AS NEW MUST CARRY THE GIT PLUGIN INTO THE NEW PACK.
//
// Re-edit hands saveAsNewPack the edited capture, which normally carries no
// plugin declarations. The source manifest is then the authority for what the
// new pack declares. Both copy paths — the byte-for-byte video copy and the
// image metadata-only copy — must keep the git declaration and its meta.json
// and state.json bytes, with and without an explicit input.plugins.
//
// Run: npm run check:plugins
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  addManifestPlugin,
  buildManifest,
  DOM_PLUGIN_NAME,
  domPluginDeclaration,
  saveAsNewPack,
  tryWriteDomPlugin,
  UIA_PLUGIN_NAME,
  uiaPluginDeclaration,
  updatePack,
  WINDOWS_CONTEXT_PLUGIN_NAME,
  writeDomPlugin,
  writeUiaPlugin,
  writeWindowsContextPlugin,
} from '../src/main/exporter'
import type { DomPluginPayload, ExportInput } from '../src/main/exporter'
import { gitPluginDeclaration, writeGitPlugin } from '../src/main/plugins/git'
import type { GitState } from '../src/main/plugins/git'
import {
  WINDOWS_CONTEXT_TIMELINE_SCHEMA,
  WINDOWS_CONTEXT_TIMELINE_VERSION,
  type WindowsContextTimelineV1,
} from '../src/main/context/windowsContextTimeline'
import type { Manifest, UiaPluginPayload } from '../src/shared/types'

const root = mkdtempSync(path.join(tmpdir(), 'capturepack-plugin-preservation-'))
const cases = mkdtempSync(path.join(tmpdir(), 'capturepack-plugin-publish-order-'))
let failed = 0

function check(name: string, ok: boolean): void {
  if (!ok) failed += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
}

function isFile(filePath: string): boolean {
  try {
    return lstatSync(filePath).isFile()
  } catch {
    return false
  }
}

function hasStagedTemporaryFile(dir: string): boolean {
  return existsSync(dir) && readdirSync(dir).some((name) => name.endsWith('.tmp'))
}

async function rejects(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run()
    return false
  } catch {
    return true
  }
}

const capturedAt = new Date('2026-07-29T10:53:06.000Z')

function uiaPayload(budgetMs: number): UiaPluginPayload {
  return {
    captured_at: capturedAt.toISOString(),
    budget_ms: budgetMs,
    truncated: false,
    windows: [],
    elements: [],
  }
}

const domPayload: DomPluginPayload = {
  protocol: 1,
  extension_version: '0.1.6',
  events: [
    {
      t_ms: 10,
      type: 'url.changed',
      tab: { url: 'https://example.com/', title: 'Example' },
    },
  ],
}

const contextTimeline: WindowsContextTimelineV1 = {
  schema: WINDOWS_CONTEXT_TIMELINE_SCHEMA,
  version: WINDOWS_CONTEXT_TIMELINE_VERSION,
  range: { start_ms: 0, end_ms: 1_000 },
  checkpoint: { t_ms: 0, windows: [], elements: [] },
  deltas: [],
}

/** A JSON.stringify failure: no file is touched before the write throws. */
function unserializable<T>(value: T, key: keyof T): T {
  return { ...value, [key]: 1n }
}

function packInput(uia: UiaPluginPayload): ExportInput {
  return {
    snapshotPng: Buffer.from('snapshot'),
    width: 100,
    height: 80,
    capturedAt,
    replayWebm: null,
    replayDurationMs: 0,
    annotations: [],
    title: '',
    note: '',
    snapshotTMs: null,
    timeline: { t0: capturedAt.toISOString(), events: [] },
    uia,
    screens: [{ width: 100, height: 80, scale: 1 }],
    clipboardAfterSave: 'off',
    docLanguage: 'en',
  }
}

function imagePackInput(): ExportInput {
  return {
    snapshotPng: Buffer.from('image snapshot'),
    width: 100,
    height: 80,
    captureKind: 'image',
    imageScope: 'fullscreen',
    capturedAt,
    replayWebm: null,
    replayDurationMs: 0,
    annotations: [],
    title: '',
    note: '',
    snapshotTMs: null,
    timeline: { t0: capturedAt.toISOString(), events: [] },
    screens: [{ width: 100, height: 80, scale: 1 }],
    clipboardAfterSave: 'off',
    docLanguage: 'en',
  }
}

function writePackManifest(
  dir: string,
  plugins: Manifest['plugins'],
  captureKind: 'video' | 'image' = 'video',
): void {
  mkdirSync(dir, { recursive: true })
  const manifest = buildManifest({
    id: path.basename(dir),
    createdAt: capturedAt,
    generatorVersion: '0.0.0-check',
    title: '',
    note: '',
    osVersion: 'check',
    screens: [{ width: 100, height: 80, scale: 1 }],
    ...(captureKind === 'image' ? { captureKind, imageScope: 'fullscreen' as const } : {}),
    hasReplay: false,
    replayDurationMs: 0,
    snapshotTMs: null,
    plugins,
  })
  writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

function declaredPlugins(dir: string): string[] {
  const saved = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Manifest
  return (saved.plugins ?? []).map((plugin) => plugin.name)
}

interface PluginWriter {
  name: string
  payloadFile: string
  write: (dir: string) => Promise<void>
  landed: (text: string) => boolean
}

const writers: PluginWriter[] = [
  {
    name: UIA_PLUGIN_NAME,
    payloadFile: 'elements.json',
    write: (dir) => writeUiaPlugin(dir, uiaPayload(1_234)),
    landed: (text) => (JSON.parse(text) as UiaPluginPayload).budget_ms === 1_234,
  },
  {
    name: DOM_PLUGIN_NAME,
    payloadFile: 'elements.json',
    write: (dir) => writeDomPlugin(dir, domPayload),
    landed: (text) => (JSON.parse(text) as DomPluginPayload).events[0]?.type === 'url.changed',
  },
  {
    name: WINDOWS_CONTEXT_PLUGIN_NAME,
    payloadFile: 'timeline.json',
    write: (dir) => writeWindowsContextPlugin(dir, contextTimeline),
    landed: (text) => (JSON.parse(text) as WindowsContextTimelineV1).range.end_ms === 1_000,
  },
]

async function checkPublishOrder(): Promise<void> {
  console.log('\nPUBLISH ORDER — payload first, meta.json last')
  for (const writer of writers) {
    const okPack = path.join(cases, `${writer.name}-ok`)
    const okDir = path.join(okPack, 'plugins', writer.name)
    await writer.write(okPack)
    check(
      `${writer.name}: a successful write publishes meta.json beside its ${writer.payloadFile}`,
      isFile(path.join(okDir, 'meta.json'))
        && writer.landed(readFileSync(path.join(okDir, writer.payloadFile), 'utf8')),
    )

    const payloadPack = path.join(cases, `${writer.name}-payload-fails`)
    const payloadDir = path.join(payloadPack, 'plugins', writer.name)
    mkdirSync(path.join(payloadDir, writer.payloadFile), { recursive: true })
    check(
      `${writer.name}: a failed ${writer.payloadFile} publish is propagated`,
      await rejects(() => writer.write(payloadPack)),
    )
    check(
      `${writer.name}: a failed ${writer.payloadFile} publish leaves no meta.json advertising it`,
      !existsSync(path.join(payloadDir, 'meta.json')),
    )
    check(
      `${writer.name}: a failed ${writer.payloadFile} publish removes its staged temporary file`,
      !hasStagedTemporaryFile(payloadDir),
    )

    const metaPack = path.join(cases, `${writer.name}-meta-fails`)
    const metaDir = path.join(metaPack, 'plugins', writer.name)
    mkdirSync(path.join(metaDir, 'meta.json'), { recursive: true })
    const metaFailed = await rejects(() => writer.write(metaPack))
    const payloadPath = path.join(metaDir, writer.payloadFile)
    check(
      `${writer.name}: a meta.json failure comes after the complete ${writer.payloadFile} landed`,
      metaFailed && isFile(payloadPath) && writer.landed(readFileSync(payloadPath, 'utf8')),
    )
    check(
      `${writer.name}: a failed meta.json publish removes its staged temporary file`,
      !hasStagedTemporaryFile(metaDir),
    )
  }
}

async function checkDomCleanup(): Promise<void> {
  console.log('\nFAILED WRITE CLEANUP — tryWriteDomPlugin')
  for (const blocked of ['elements.json', 'meta.json']) {
    const pack = path.join(cases, `dom-try-${blocked}`)
    const dir = path.join(pack, 'plugins', DOM_PLUGIN_NAME)
    mkdirSync(path.join(dir, blocked), { recursive: true })
    check(
      `tryWriteDomPlugin reports a failed ${blocked} write instead of throwing`,
      (await tryWriteDomPlugin(pack, domPayload)) === false,
    )
    check(
      `a failed ${blocked} write leaves no incomplete chrome-dom directory`,
      !existsSync(dir),
    )
  }

  const published = path.join(cases, 'dom-try-published')
  const publishedDir = path.join(published, 'plugins', DOM_PLUGIN_NAME)
  check('tryWriteDomPlugin publishes a complete payload', await tryWriteDomPlugin(published, domPayload))
  const before = readFileSync(path.join(publishedDir, 'elements.json'), 'utf8')
  check(
    'a failed rewrite is reported',
    (await tryWriteDomPlugin(published, unserializable(domPayload, 'protocol'))) === false,
  )
  check(
    'a failed rewrite keeps the complete chrome-dom payload an earlier write published',
    isFile(path.join(publishedDir, 'meta.json'))
      && readFileSync(path.join(publishedDir, 'elements.json'), 'utf8') === before,
  )
}

async function checkUiaCleanup(): Promise<void> {
  console.log('\nFAILED WRITE CLEANUP — final save (tryWriteUiaPlugin)')
  for (const blocked of ['elements.json', 'meta.json']) {
    const pack = path.join(cases, `uia-save-${blocked}`)
    const dir = path.join(pack, 'plugins', UIA_PLUGIN_NAME)
    writePackManifest(pack, [])
    mkdirSync(path.join(dir, blocked), { recursive: true })
    const saved = !(await rejects(() =>
      updatePack({ id: path.basename(pack), dirPath: pack }, packInput(uiaPayload(1_234))),
    ))
    check(`a failed windows-uia ${blocked} write never fails the save`, saved)
    check(
      `a failed windows-uia ${blocked} write is not declared`,
      !declaredPlugins(pack).includes(UIA_PLUGIN_NAME),
    )
    check(
      `a failed windows-uia ${blocked} write leaves no incomplete directory`,
      !existsSync(dir),
    )
  }

  // Save-first already published and declared the payload; a final save whose
  // rewrite fails must not take that complete payload away from its declaration.
  const pack = path.join(cases, 'uia-save-published')
  const dir = path.join(pack, 'plugins', UIA_PLUGIN_NAME)
  writePackManifest(pack, [uiaPluginDeclaration()])
  await writeUiaPlugin(pack, uiaPayload(1_234))
  const before = readFileSync(path.join(dir, 'elements.json'), 'utf8')
  const saved = !(await rejects(() =>
    updatePack(
      { id: path.basename(pack), dirPath: pack },
      packInput(unserializable(uiaPayload(5_678), 'budget_ms')),
    ),
  ))
  check('a failed windows-uia rewrite never fails the save', saved)
  check(
    'a failed rewrite keeps the published windows-uia payload and its declaration',
    declaredPlugins(pack).includes(UIA_PLUGIN_NAME)
      && isFile(path.join(dir, 'meta.json'))
      && readFileSync(path.join(dir, 'elements.json'), 'utf8') === before,
  )
}

const gitState: GitState = {
  repository: 'capturepack-fixture',
  branch: 'issue/git-plugin-preservation',
  commit: '0123456789abcdef0123456789abcdef01234567',
  dirty: true,
  changed_files: ['src/editor.ts', 'src/save.ts'],
}

function isCompleteGitDeclaration(
  plugin: NonNullable<Manifest['plugins']>[number] | undefined,
): boolean {
  return plugin?.name === 'git'
    && plugin.version === '0.1.0'
    && plugin.path === 'plugins/git/'
}

async function checkGitPreservation(): Promise<void> {
  console.log('\nFINAL SAVE KEEPS SAVE-FIRST GIT PLUGIN')
  const pack = path.join(cases, 'git-save-published')
  const dir = path.join(pack, 'plugins', 'git')
  writePackManifest(pack, [gitPluginDeclaration()])
  await writeGitPlugin(pack, gitState)
  const metaBefore = readFileSync(path.join(dir, 'meta.json'), 'utf8')
  const stateBefore = readFileSync(path.join(dir, 'state.json'), 'utf8')

  check(
    'a final save completes with an already-published git plugin',
    !(await rejects(() =>
      updatePack({ id: path.basename(pack), dirPath: pack }, packInput(uiaPayload(1_234))),
    )),
  )

  const manifest = JSON.parse(readFileSync(path.join(pack, 'manifest.json'), 'utf8')) as Manifest
  check(
    'the final manifest keeps the complete git plugin declaration',
    isCompleteGitDeclaration((manifest.plugins ?? []).find((plugin) => plugin.name === 'git')),
  )
  check(
    'the final save preserves the git meta.json bytes',
    isFile(path.join(dir, 'meta.json'))
      && readFileSync(path.join(dir, 'meta.json'), 'utf8') === metaBefore,
  )
  check(
    'the final save preserves the complete git state.json bytes',
    isFile(path.join(dir, 'state.json'))
      && readFileSync(path.join(dir, 'state.json'), 'utf8') === stateBefore,
  )
}

async function checkSaveAsNewGitPreservation(): Promise<void> {
  console.log('\nSAVE AS NEW KEEPS THE GIT PLUGIN')
  const kinds = [
    { kind: 'video', input: () => packInput(uiaPayload(1_234)) },
    { kind: 'image', input: imagePackInput },
  ] as const
  const declarations = [
    { label: 'input.plugins omitted', plugins: undefined },
    { label: 'explicit input.plugins', plugins: [gitPluginDeclaration()] },
  ] as const
  for (const { kind, input } of kinds) {
    for (const { label, plugins } of declarations) {
      const name = `${kind} Save As New (${label})`
      const source = path.join(
        cases,
        `git-save-as-new-${kind}-${plugins === undefined ? 'fallback' : 'explicit'}`,
        'source',
      )
      const sourceDir = path.join(source, 'plugins', 'git')
      writePackManifest(source, [gitPluginDeclaration()], kind)
      await writeGitPlugin(source, gitState)
      const sourceManifestBefore = readFileSync(path.join(source, 'manifest.json'), 'utf8')
      const metaBefore = readFileSync(path.join(sourceDir, 'meta.json'))
      const stateBefore = readFileSync(path.join(sourceDir, 'state.json'))

      const exportInput: ExportInput =
        plugins === undefined ? input() : { ...input(), plugins: [...plugins] }
      if (plugins === undefined) {
        check(`${name}: the edited input carries no plugin declarations`, !('plugins' in exportInput))
      }
      let copied: { id: string; dirPath: string } | null = null
      try {
        copied = await saveAsNewPack(source, exportInput)
      } catch (err) {
        console.error(err)
      }
      check(`${name}: completes with a published git plugin`, copied !== null)
      if (copied === null) continue
      const copiedDir = path.join(copied.dirPath, 'plugins', 'git')
      const manifest = JSON.parse(
        readFileSync(path.join(copied.dirPath, 'manifest.json'), 'utf8'),
      ) as Manifest
      check(
        `${name}: writes a new pack beside the source`,
        copied.dirPath !== source
          && path.dirname(copied.dirPath) === path.dirname(source)
          && manifest.id === copied.id
          && manifest.id !== path.basename(source),
      )
      const gitDeclarations = (manifest.plugins ?? []).filter((plugin) => plugin.name === 'git')
      check(
        `${name}: the new manifest declares the complete git plugin exactly once`,
        gitDeclarations.length === 1 && isCompleteGitDeclaration(gitDeclarations[0]),
      )
      check(
        `${name}: copies the git meta.json bytes`,
        isFile(path.join(copiedDir, 'meta.json'))
          && readFileSync(path.join(copiedDir, 'meta.json')).equals(metaBefore),
      )
      check(
        `${name}: copies the complete git state.json bytes`,
        isFile(path.join(copiedDir, 'state.json'))
          && readFileSync(path.join(copiedDir, 'state.json')).equals(stateBefore),
      )
      check(
        `${name}: leaves the source pack's manifest and git payload untouched`,
        readFileSync(path.join(source, 'manifest.json'), 'utf8') === sourceManifestBefore
          && readFileSync(path.join(sourceDir, 'meta.json')).equals(metaBefore)
          && readFileSync(path.join(sourceDir, 'state.json')).equals(stateBefore),
      )
    }
  }
}

async function checkSaveAsNewUnpublishedPluginCleanup(): Promise<void> {
  console.log('\nSAVE AS NEW REMOVES UNPUBLISHED PLUGIN DIRECTORIES')
  for (const kind of ['video', 'image'] as const) {
    for (const metadata of ['missing', 'malformed'] as const) {
      const source = path.join(cases, `save-as-new-${kind}-${metadata}`, 'source')
      const pluginDir = path.join(source, 'plugins', 'git')
      const orphanDir = path.join(source, 'plugins', 'orphan')
      writePackManifest(source, [gitPluginDeclaration()], kind)
      mkdirSync(pluginDir, { recursive: true })
      mkdirSync(orphanDir, { recursive: true })
      writeFileSync(path.join(pluginDir, 'state.json'), '{"branch":"main"}\n')
      writeFileSync(path.join(orphanDir, 'partial.json'), '{"incomplete":true}\n')
      if (metadata === 'malformed') {
        writeFileSync(path.join(pluginDir, 'meta.json'), '{"name":"other","version":"0"}\n')
      }

      let copied: { id: string; dirPath: string } | null = null
      try {
        copied = await saveAsNewPack(
          source,
          kind === 'image' ? imagePackInput() : packInput(uiaPayload(1_234)),
        )
      } catch (err) {
        console.error(err)
      }
      const name = `${kind} Save As New (${metadata} metadata)`
      check(`${name}: still saves the pack`, copied !== null)
      if (copied === null) continue

      const savedManifest = JSON.parse(
        readFileSync(path.join(copied.dirPath, 'manifest.json'), 'utf8'),
      ) as Manifest
      const savedPluginsDir = path.join(copied.dirPath, 'plugins')
      check(
        `${name}: omits the invalid git declaration`,
        !(savedManifest.plugins ?? []).some((plugin) => plugin.name === 'git'),
      )
      check(
        `${name}: leaves no partial or undeclared plugin directory`,
        !existsSync(savedPluginsDir),
      )
      check(
        `${name}: preserves the source files unchanged`,
        existsSync(path.join(pluginDir, 'state.json'))
          && existsSync(path.join(orphanDir, 'partial.json'))
          && (metadata === 'missing' || existsSync(path.join(pluginDir, 'meta.json'))),
      )
    }
  }
}

async function main(): Promise<void> {
  try {
    await mkdir(root, { recursive: true })
    console.log('\nFINAL SAVE KEEPS SAVE-FIRST PLUGINS')
    const initial = buildManifest({
      id: 'plugin-preservation-check',
      createdAt: capturedAt,
      generatorVersion: '0.0.0-check',
      title: '',
      note: '',
      osVersion: 'check',
      screens: [{ width: 100, height: 80, scale: 1 }],
      hasReplay: false,
      replayDurationMs: 0,
      snapshotTMs: null,
      plugins: [],
    })
    writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(initial, null, 2)}\n`)
    await writeDomPlugin(root, {
      protocol: 1,
      extension_version: '0.1.6',
      events: [
        {
          t_ms: 10,
          type: 'url.changed',
          tab: { url: 'https://example.com/', title: 'Example' },
        },
      ],
    })

    const input: ExportInput = {
      snapshotPng: Buffer.from('snapshot'),
      width: 100,
      height: 80,
      capturedAt,
      replayWebm: null,
      replayDurationMs: 0,
      annotations: [],
      title: '',
      note: '',
      snapshotTMs: null,
      timeline: { t0: capturedAt.toISOString(), events: [] },
      uia: {
        captured_at: capturedAt.toISOString(),
        budget_ms: 3_000,
        truncated: false,
        windows: [],
        // Widen the stale-read window enough to make the old unqueued
        // updatePack/read -> addManifestPlugin/write -> updatePack/write order
        // deterministic instead of a scheduler coin flip.
        elements: Array.from({ length: 8_000 }, (_, index) => ({
          name: `control-${index}`,
          control_type: 'Text',
          automation_id: `id-${index}`,
          class_name: 'Check',
          bounds: { x: index % 100, y: index % 80, width: 10, height: 10 },
          depth: 1,
          window: -1,
        })),
      },
      screens: [{ width: 100, height: 80, scale: 1 }],
      clipboardAfterSave: 'off',
      docLanguage: 'en',
    }

    const handle = { id: initial.id, dirPath: root }
    const finalSave = updatePack(handle, input)
    await new Promise<void>((resolve) => setImmediate(resolve))
    const lateDomDeclaration = addManifestPlugin(handle, domPluginDeclaration(), 'en')
    await Promise.all([finalSave, lateDomDeclaration])

    const saved = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')) as Manifest
    const names = (saved.plugins ?? []).map((plugin) => plugin.name).sort()
    check(
      'final manifest keeps chrome-dom and adds windows-uia',
      names.join(',') === 'chrome-dom,windows-uia',
    )
    check(
      'chrome-dom payload remains physical',
      readFileSync(path.join(root, 'plugins', 'chrome-dom', 'elements.json'), 'utf8').includes(
        'url.changed',
      ),
    )
    check(
      'windows-uia payload is written by final save',
      readFileSync(path.join(root, 'plugins', 'windows-uia', 'elements.json'), 'utf8').includes(
        '"budget_ms": 3000',
      ),
    )

    await checkPublishOrder()
    await checkDomCleanup()
    await checkUiaCleanup()
    await checkGitPreservation()
    await checkSaveAsNewGitPreservation()
    await checkSaveAsNewUnpublishedPluginCleanup()
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cases, { recursive: true, force: true })
  }

  console.log(
    failed === 0
      ? '\nplugin-preservation-check ok'
      : `\nplugin-preservation-check FAILED (${failed})`,
  )
  process.exitCode = failed === 0 ? 0 : 1
}

void main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
