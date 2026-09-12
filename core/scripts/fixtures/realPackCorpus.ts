import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { greyPng } from './greyPng'

export type CorpusCoverageStatus = 'represented' | 'coverage-gap'

export interface CorpusInventoryEntry {
  id: string
  status: CorpusCoverageStatus
  companion_checks?: string[]
}

export interface RealPackCorpusCase {
  id: string
  provenance: 'distilled-real-pack'
  shape_sha256: string
  classifications: string[]
  observed_hands_off_ms: number
  thresholds: {
    max_hands_off_ms: number
    max_replay_to_candidates_ms: number
    max_median_control_fraction: number
    max_p90_control_fraction: number
    min_precise_control_share: number
    expected_controls: 'some' | 'none'
  }
  pack: {
    width: number
    height: number
    image_scope: 'region' | 'fullscreen'
    crop_bounds?: { x: number; y: number; width: number; height: number }
    screens: Array<{
      width: number
      height: number
      scale: number
      bounds?: { x: number; y: number; width: number; height: number }
    }>
    uia: {
      captured_at: string
      budget_ms: number
      truncated: boolean
      geometry_refused?: true
      windows: Array<Record<string, unknown>>
      elements: Array<Record<string, unknown>>
    }
    dom?: Record<string, unknown>
    surface_kinds: string[]
  }
}

export interface RealPackCorpus {
  schema_version: 1
  privacy: string
  visual_policy: string
  hard_case_inventory: CorpusInventoryEntry[]
  cases: RealPackCorpusCase[]
}

export interface WrittenCorpusCase {
  definition: RealPackCorpusCase
  dirPath: string
}

function finitePositive(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`real-pack corpus: ${label} must be a finite positive number`)
  }
  return value
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(value)) {
    throw new Error(`real-pack corpus: ${label} is not a safe id`)
  }
  return value
}

function assertPrivacy(corpus: RealPackCorpus, raw: string): void {
  // These are values the distiller promises can never leave a source pack.
  // Checking the committed bytes catches a hand edit that bypassed it.
  const forbidden = [
    /CapturePack_\d/i,
    /"(?:text|href|selector)"\s*:\s*"(?!")/i,
    /https?:\/\/(?!example\.invalid\/)/i,
    /\\Users\\/i,
  ]
  for (const pattern of forbidden) {
    if (pattern.test(raw)) throw new Error(`real-pack corpus: privacy guard matched ${String(pattern)}`)
  }
  for (const caseDef of corpus.cases) {
    for (const [index, window] of caseDef.pack.uia.windows.entries()) {
      const title = window['title']
      const process = window['process']
      const className = window['class_name']
      if (typeof title !== 'string' || !title.startsWith('Corpus ')) {
        throw new Error(`${caseDef.id}: window ${String(index)} has a non-corpus title`)
      }
      if (!['chrome.exe', 'corpus-electron.exe', 'corpus-native.exe'].includes(String(process))) {
        throw new Error(`${caseDef.id}: window ${String(index)} has a non-corpus process`)
      }
      if (!['Chrome_WidgetWin_1', 'CorpusNativeWindow', 'Progman'].includes(String(className))) {
        throw new Error(`${caseDef.id}: window ${String(index)} has a non-corpus class`)
      }
    }
    for (const [index, element] of caseDef.pack.uia.elements.entries()) {
      const automationId = String(element['automation_id'] ?? '')
      if (automationId !== '' && automationId !== `corpus-control-${String(index)}`) {
        throw new Error(`${caseDef.id}: control ${String(index)} has a non-corpus automation id`)
      }
      const name = String(element['name'] ?? '')
      if (name !== '' && name !== `Corpus control ${String(index)}`) {
        throw new Error(`${caseDef.id}: control ${String(index)} has a non-corpus name`)
      }
    }
  }
}

function shapeOf(caseDef: RealPackCorpusCase): Record<string, unknown> {
  return {
    size: { width: caseDef.pack.width, height: caseDef.pack.height },
    screens: caseDef.pack.screens,
    cropBounds: caseDef.pack.crop_bounds,
    uia: caseDef.pack.uia,
    dom: caseDef.pack.dom ?? null,
  }
}

function validate(corpus: RealPackCorpus, raw: string): void {
  if (corpus.schema_version !== 1) throw new Error('real-pack corpus: unsupported schema version')
  if (!Array.isArray(corpus.cases) || corpus.cases.length < 3) {
    throw new Error('real-pack corpus: at least three independently distilled cases are required')
  }
  const inventory = new Map<string, CorpusCoverageStatus>()
  for (const entry of corpus.hard_case_inventory ?? []) {
    const id = safeId(entry.id, 'inventory id')
    if (inventory.has(id)) throw new Error(`real-pack corpus: duplicate inventory entry ${id}`)
    if (entry.status !== 'represented' && entry.status !== 'coverage-gap') {
      throw new Error(`real-pack corpus: ${id} has an unknown coverage status`)
    }
    inventory.set(id, entry.status)
  }
  for (const required of [
    'mixed-dpi',
    'app-overlays',
    'multiple-display-environment',
    'multiple-display-output',
    'motion',
    'similar-frames',
    'hdr-sdr',
  ]) {
    if (!inventory.has(required)) throw new Error(`real-pack corpus: ${required} is not inventoried`)
  }

  const ids = new Set<string>()
  const representedTags = new Set<string>()
  for (const caseDef of corpus.cases) {
    const id = safeId(caseDef.id, 'case id')
    if (ids.has(id)) throw new Error(`real-pack corpus: duplicate case ${id}`)
    ids.add(id)
    for (const classification of caseDef.classifications) {
      representedTags.add(safeId(classification, `${id} classification`))
    }
    if (caseDef.provenance !== 'distilled-real-pack') {
      throw new Error(`${id}: provenance must be distilled-real-pack`)
    }
    finitePositive(caseDef.pack.width, `${id}.pack.width`)
    finitePositive(caseDef.pack.height, `${id}.pack.height`)
    finitePositive(caseDef.thresholds.max_hands_off_ms, `${id}.max_hands_off_ms`)
    finitePositive(
      caseDef.thresholds.max_replay_to_candidates_ms,
      `${id}.max_replay_to_candidates_ms`,
    )
    if (
      !Number.isFinite(caseDef.observed_hands_off_ms)
      || caseDef.observed_hands_off_ms < 0
      || caseDef.observed_hands_off_ms > caseDef.thresholds.max_hands_off_ms
    ) {
      throw new Error(`${id}: observed hands-off latency exceeds its release threshold`)
    }
    const shapeHash = createHash('sha256').update(JSON.stringify(shapeOf(caseDef))).digest('hex')
    if (shapeHash !== caseDef.shape_sha256) {
      throw new Error(`${id}: distilled shape hash changed; regenerate or review the baseline`)
    }
  }
  for (const [id, status] of inventory) {
    if (status === 'represented' && !representedTags.has(id)) {
      throw new Error(`real-pack corpus: ${id} is marked represented but no case carries that tag`)
    }
  }
  assertPrivacy(corpus, raw)
}

export function loadRealPackCorpus(): RealPackCorpus {
  const corpusPath = path.join(process.cwd(), 'test', 'real-pack-corpus', 'corpus.json')
  const raw = readFileSync(corpusPath, 'utf8')
  const corpus = JSON.parse(raw) as RealPackCorpus
  validate(corpus, raw)
  return corpus
}

export function writeRealPackCorpusCases(corpus: RealPackCorpus): WrittenCorpusCase[] {
  return corpus.cases.map((caseDef) => {
    const dirPath = mkdtempSync(path.join(tmpdir(), `capturepack-corpus-${caseDef.id}-`))
    const plugins = [{ name: 'windows-uia', version: '0.4.0', path: 'plugins/windows-uia/' }]
    if (caseDef.pack.dom !== undefined) {
      plugins.push({ name: 'chrome-dom', version: '0.1.0', path: 'plugins/chrome-dom/' })
    }
    const manifest = {
      format: 'capturepack',
      format_version: '0.7.0',
      capture_kind: 'image',
      id: `real-pack-corpus-${caseDef.id}`,
      created_at: '2026-01-01T00:00:00Z',
      generator: { name: 'capturepack', version: '0.0.0-corpus' },
      environment: { os: 'windows', os_version: 'corpus', screens: caseDef.pack.screens },
      media: {
        snapshot: 'snapshot.png',
        replay: null,
        image_scope: caseDef.pack.image_scope,
        ...(caseDef.pack.crop_bounds === undefined
          ? {}
          : {
              crop_bounds: {
                ...caseDef.pack.crop_bounds,
                coordinate_space: 'virtual-desktop-dip',
              },
            }),
      },
      plugins,
    }
    mkdirSync(path.join(dirPath, 'plugins', 'windows-uia'), { recursive: true })
    writeFileSync(path.join(dirPath, 'manifest.json'), JSON.stringify(manifest, null, 2))
    writeFileSync(path.join(dirPath, 'snapshot.png'), greyPng(caseDef.pack.width, caseDef.pack.height))
    writeFileSync(path.join(dirPath, 'annotations.json'), JSON.stringify({ annotations: [] }, null, 2))
    writeFileSync(
      path.join(dirPath, 'plugins', 'windows-uia', 'meta.json'),
      JSON.stringify({ name: 'windows-uia', version: '0.4.0' }, null, 2),
    )
    writeFileSync(
      path.join(dirPath, 'plugins', 'windows-uia', 'elements.json'),
      JSON.stringify(caseDef.pack.uia, null, 2),
    )
    if (caseDef.pack.dom !== undefined) {
      mkdirSync(path.join(dirPath, 'plugins', 'chrome-dom'), { recursive: true })
      writeFileSync(
        path.join(dirPath, 'plugins', 'chrome-dom', 'meta.json'),
        JSON.stringify({ name: 'chrome-dom', version: '0.1.0' }, null, 2),
      )
      writeFileSync(
        path.join(dirPath, 'plugins', 'chrome-dom', 'elements.json'),
        JSON.stringify(caseDef.pack.dom, null, 2),
      )
    }
    return { definition: caseDef, dirPath }
  })
}
