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
// Run: npm run check:plugins
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  addManifestPlugin,
  buildManifest,
  domPluginDeclaration,
  updatePack,
  writeDomPlugin,
} from '../src/main/exporter'
import type { ExportInput } from '../src/main/exporter'
import type { Manifest } from '../src/shared/types'

const root = mkdtempSync(path.join(tmpdir(), 'capturepack-plugin-preservation-'))
let failed = 0

function check(name: string, ok: boolean): void {
  if (!ok) failed += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
}

async function main(): Promise<void> {
  try {
    await mkdir(root, { recursive: true })
    const capturedAt = new Date('2026-07-29T10:53:06.000Z')
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
    const lateDomDeclaration = addManifestPlugin(handle, domPluginDeclaration())
    await Promise.all([finalSave, lateDomDeclaration])

    const saved = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')) as Manifest
    const names = saved.plugins.map((plugin) => plugin.name).sort()
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
  } finally {
    rmSync(root, { recursive: true, force: true })
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
