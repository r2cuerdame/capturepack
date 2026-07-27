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
  }
}

export function loadSettings(): Settings {
  const base = defaultSettings()
  let raw: Record<string, unknown> | null = null
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(settingsFilePath(), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>
    }
  } catch {
    // Missing or corrupt file: fall through and rewrite defaults.
  }
  const settings = raw ? mergeSettings(base, raw) : base
  try {
    saveSettings(settings)
  } catch {
    // Unwritable disk: keep running with in-memory settings.
  }
  return settings
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
  }
  return Object.assign({}, raw, known)
}
