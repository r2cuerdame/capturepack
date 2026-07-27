// Writes the .capturepack file (format_version 0.1.0, per shared/types and SPEC.md).

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, screen, shell } from 'electron'
import AdmZip from 'adm-zip'
import type {
  Annotation,
  AnnotationsFile,
  Manifest,
  TimelineFile,
} from '../shared/types'
import { FORMAT_NAME, FORMAT_VERSION } from '../shared/types'
import { buildReport } from './report'

export interface ExportInput {
  snapshotPng: Buffer
  width: number
  height: number
  // Capture trigger instant — manifest.created_at is the capture, not the export
  capturedAt: Date
  replayWebm: Buffer | null
  replayDurationMs: number
  annotations: Annotation[]
  title: string
  note: string
  timeline: TimelineFile
  outputDir: string
  copyToClipboard: boolean
}

export interface ManifestInput {
  id: string
  createdAt: Date
  generatorVersion: string
  title: string
  note: string
  osVersion: string
  screens: Array<{ width: number; height: number; scale: number }>
  hasReplay: boolean
  replayDurationMs: number
}

export function buildManifest(input: ManifestInput): Manifest {
  const manifest: Manifest = {
    format: FORMAT_NAME,
    format_version: FORMAT_VERSION,
    id: input.id,
    created_at: isoWithOffset(input.createdAt),
    generator: { name: 'capturepack', version: input.generatorVersion },
    environment: {
      os: 'windows',
      os_version: input.osVersion,
      screens: input.screens,
    },
    media: {
      snapshot: 'snapshot.png',
      replay: input.hasReplay ? 'replay.webm' : null,
    },
    plugins: [],
  }
  const title = input.title.trim()
  if (title !== '') manifest.title = title
  const note = input.note.trim()
  if (note !== '') manifest.note = note
  if (input.hasReplay) manifest.media.replay_duration_ms = input.replayDurationMs
  return manifest
}

/** Local time as ISO 8601 with the machine's UTC offset, e.g. 2026-07-27T14:03:09+09:00. */
export function isoWithOffset(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const offsetMin = -date.getTimezoneOffset()
  const sign = offsetMin < 0 ? '-' : '+'
  const absMin = Math.abs(offsetMin)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(absMin / 60))}:${pad(absMin % 60)}`
  )
}

export async function exportPack(input: ExportInput): Promise<string> {
  const manifest = buildManifest({
    id: randomUUID(),
    createdAt: input.capturedAt,
    generatorVersion: app.getVersion(),
    title: input.title,
    note: input.note,
    osVersion: release(),
    screens: physicalScreens(),
    hasReplay: input.replayWebm !== null,
    replayDurationMs: input.replayDurationMs,
  })
  const annotationsFile: AnnotationsFile = {
    reference_width: input.width,
    reference_height: input.height,
    annotations: input.annotations,
  }
  // Export time (not capturedAt) — this event records when the pack was written.
  const timeline = withExportEvent(input.timeline, new Date())
  const report = buildReport(manifest, annotationsFile)

  const stageDir = await mkdtemp(join(tmpdir(), 'capturepack-'))
  try {
    await writeFile(join(stageDir, 'manifest.json'), toJson(manifest))
    await writeFile(join(stageDir, 'snapshot.png'), input.snapshotPng)
    await writeFile(join(stageDir, 'annotations.json'), toJson(annotationsFile))
    await writeFile(join(stageDir, 'timeline.json'), toJson(timeline))
    await writeFile(join(stageDir, 'report.md'), report, 'utf8')
    if (input.replayWebm !== null) {
      await writeFile(join(stageDir, 'replay.webm'), input.replayWebm)
    }

    await mkdir(input.outputDir, { recursive: true })
    const packPath = uniquePackPath(input.outputDir, input.capturedAt)
    const zip = new AdmZip()
    zip.addLocalFolder(stageDir)
    await zip.writeZipPromise(packPath)

    shell.showItemInFolder(packPath)
    if (input.copyToClipboard) copyFileToClipboard(packPath)
    return packPath
  } finally {
    await rm(stageDir, { recursive: true, force: true })
  }
}

function physicalScreens(): Array<{ width: number; height: number; scale: number }> {
  // display.size is in DIPs; the pack records physical pixels.
  return screen.getAllDisplays().map((d) => ({
    width: Math.round(d.size.width * d.scaleFactor),
    height: Math.round(d.size.height * d.scaleFactor),
    scale: d.scaleFactor,
  }))
}

function withExportEvent(timeline: TimelineFile, now: Date): TimelineFile {
  const t0 = Date.parse(timeline.t0)
  const t_ms = Number.isFinite(t0) ? Math.max(0, now.getTime() - t0) : 0
  return {
    t0: timeline.t0,
    events: [...timeline.events, { t_ms, type: 'core.export.created', source: 'core' }],
  }
}

function uniquePackPath(outputDir: string, date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stem =
    `capture-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  let candidate = join(outputDir, `${stem}.capturepack`)
  for (let n = 2; existsSync(candidate); n += 1) {
    candidate = join(outputDir, `${stem}-${n}.capturepack`)
  }
  return candidate
}

// Set-Clipboard -LiteralPath puts the file itself (not its path as text) on the
// clipboard, so it pastes as an attachment into ChatGPT/Slack. Best-effort only:
// clipboard failure must never fail the export.
function copyFileToClipboard(filePath: string): void {
  const escaped = filePath.replace(/'/g, "''")
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-Command', `Set-Clipboard -LiteralPath '${escaped}'`],
    { windowsHide: true, stdio: 'ignore' },
  )
  child.on('error', (err) => console.error('capturepack: clipboard copy failed:', err))
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`capturepack: clipboard copy exited with code ${code}`)
    }
  })
  child.unref()
}

function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n'
}
