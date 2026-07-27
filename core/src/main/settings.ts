// Settings persistence: JSON file in userData, tolerant of missing/corrupt content.
import { app } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Settings } from '../shared/types'

export function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

function defaultSettings(): Settings {
  return {
    autoUpdateCheck: true,
    outputDir: path.join(app.getPath('desktop'), 'CapturePack'),
    copyToClipboard: true,
    replaySeconds: 30,
    fps: 15,
    scrubInvert: false,
    scrubSensitivityMs: 100,
    defaultManualDurationMs: 1000,
    showDurationLabel: true,
    mcpEnabled: true,
    mcpPort: 39393,
    mcpAutoStart: true,
    mcpReadOnly: true,
    mcpWatchExportFolder: true,
    mcpLogRequests: false,
  }
}

export function loadSettings(): Settings {
  const base = defaultSettings()
  let raw: Record<string, unknown> | null = null
  // A malformed but non-empty file is preserved on disk (defaults apply in
  // memory only) so a user's hand-edit mistake is never silently destroyed.
  let preserveFile = false
  let text: string | null = null
  try {
    text = fs.readFileSync(settingsFilePath(), 'utf8')
  } catch {
    text = null // Missing/unreadable file: fall through and write defaults.
  }
  if (text !== null) {
    try {
      // Editors commonly save UTF-8 with a BOM, which JSON.parse rejects.
      const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ''))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>
      } else if (text.trim() !== '') {
        preserveFile = true
      }
    } catch {
      if (text.trim() !== '') preserveFile = true
    }
  }
  const settings = raw ? mergeSettings(base, raw) : base
  if (!preserveFile) {
    try {
      saveSettings(settings)
    } catch {
      // Unwritable disk: keep running with in-memory settings.
    }
  }
  // --output-dir=<path> overrides outputDir for this run only. Applied after
  // saveSettings so the override is never persisted.
  const override = outputDirOverride(process.argv)
  return override !== null ? { ...settings, outputDir: override } : settings
}

function outputDirOverride(argv: string[]): string | null {
  for (const arg of argv) {
    if (arg.startsWith('--output-dir=')) {
      const value = arg.slice('--output-dir='.length).trim()
      if (value !== '') return path.resolve(value)
    }
  }
  return null
}

export function saveSettings(settings: Settings): void {
  const file = settingsFilePath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n')
}

// Known keys are validated against defaults; unknown keys ride along so a newer
// version's settings survive a downgrade.
function mergeSettings(base: Settings, raw: Record<string, unknown>): Settings {
  const known: Settings = {
    autoUpdateCheck: typeof raw.autoUpdateCheck === 'boolean' ? raw.autoUpdateCheck : base.autoUpdateCheck,
    outputDir: typeof raw.outputDir === 'string' && raw.outputDir.length > 0 ? raw.outputDir : base.outputDir,
    copyToClipboard: typeof raw.copyToClipboard === 'boolean' ? raw.copyToClipboard : base.copyToClipboard,
    replaySeconds:
      typeof raw.replaySeconds === 'number' && raw.replaySeconds > 0 ? raw.replaySeconds : base.replaySeconds,
    fps: typeof raw.fps === 'number' && raw.fps > 0 ? raw.fps : base.fps,
    scrubInvert: typeof raw.scrubInvert === 'boolean' ? raw.scrubInvert : base.scrubInvert,
    scrubSensitivityMs:
      typeof raw.scrubSensitivityMs === 'number' && raw.scrubSensitivityMs > 0
        ? raw.scrubSensitivityMs
        : base.scrubSensitivityMs,
    defaultManualDurationMs:
      typeof raw.defaultManualDurationMs === 'number' && raw.defaultManualDurationMs > 0
        ? raw.defaultManualDurationMs
        : base.defaultManualDurationMs,
    showDurationLabel:
      typeof raw.showDurationLabel === 'boolean' ? raw.showDurationLabel : base.showDurationLabel,
    mcpEnabled: typeof raw.mcpEnabled === 'boolean' ? raw.mcpEnabled : base.mcpEnabled,
    mcpPort:
      typeof raw.mcpPort === 'number' && Number.isInteger(raw.mcpPort) && raw.mcpPort >= 1 && raw.mcpPort <= 65535
        ? raw.mcpPort
        : base.mcpPort,
    mcpAutoStart: typeof raw.mcpAutoStart === 'boolean' ? raw.mcpAutoStart : base.mcpAutoStart,
    mcpReadOnly: typeof raw.mcpReadOnly === 'boolean' ? raw.mcpReadOnly : base.mcpReadOnly,
    mcpWatchExportFolder:
      typeof raw.mcpWatchExportFolder === 'boolean' ? raw.mcpWatchExportFolder : base.mcpWatchExportFolder,
    mcpLogRequests: typeof raw.mcpLogRequests === 'boolean' ? raw.mcpLogRequests : base.mcpLogRequests,
  }
  return Object.assign({}, raw, known)
}
