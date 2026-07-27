// Settings persistence: JSON file in userData, tolerant of missing/corrupt content.
import { app } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { isSupportedLanguage } from '../shared/i18n'
import { DEFAULT_CAPTURE_HOTKEY } from '../shared/types'
import type { Settings } from '../shared/types'

export function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

function defaultSettings(): Settings {
  return {
    language: 'system',
    packLanguage: 'ui',
    autoUpdateCheck: true,
    outputDir: path.join(app.getPath('desktop'), 'CapturePack'),
    copyToClipboard: true,
    captureHotkey: DEFAULT_CAPTURE_HOTKEY,
    replaySeconds: 30,
    fps: 15,
    captureDisplay: 'cursor',
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
  activeOutputDirOverride = override
  return override !== null ? { ...settings, outputDir: override } : settings
}

// Set by loadSettings when a --output-dir=<path> override is active this run.
let activeOutputDirOverride: string | null = null

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

// An EXPLICIT outputDir choice from the settings GUI supersedes an active
// --output-dir override for the rest of the run — even when the chosen folder
// happens to equal the override path. persistSettings alone cannot tell that
// intent apart from an untouched override (the values are identical), so the
// settings:set pipeline calls this whenever the patch explicitly carried an
// applied outputDir, ensuring the user's pick persists across restarts.
export function clearOutputDirOverride(): void {
  activeOutputDirOverride = null
}

// Persistence entry point for the settings GUI. A --output-dir override applies
// to this run only (loadSettings contract), so while it is active and the user
// has not explicitly chosen a new folder, the outputDir written to disk is the
// one already stored there — never the override.
export function persistSettings(settings: Settings): void {
  if (activeOutputDirOverride !== null && settings.outputDir === activeOutputDirOverride) {
    saveSettings({ ...settings, outputDir: onDiskOutputDir() })
    return
  }
  // The user picked a different folder: the override is superseded from now on.
  if (settings.outputDir !== activeOutputDirOverride) activeOutputDirOverride = null
  saveSettings(settings)
}

function onDiskOutputDir(): string {
  try {
    let text = fs.readFileSync(settingsFilePath(), 'utf8')
    // Editors commonly save UTF-8 with a BOM, which JSON.parse rejects.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const value = (parsed as Record<string, unknown>).outputDir
      if (typeof value === 'string' && value.length > 0) return value
    }
  } catch {
    // Missing/corrupt file: fall through to the default.
  }
  return defaultSettings().outputDir
}

// Exhaustive by construction: Record<keyof Settings, true> fails to compile
// when Settings gains or loses a key, keeping GUI patch filtering in sync.
const SETTINGS_KEY_SET: Record<keyof Settings, true> = {
  language: true,
  packLanguage: true,
  autoUpdateCheck: true,
  outputDir: true,
  copyToClipboard: true,
  captureHotkey: true,
  replaySeconds: true,
  fps: true,
  captureDisplay: true,
  scrubInvert: true,
  scrubSensitivityMs: true,
  defaultManualDurationMs: true,
  showDurationLabel: true,
  mcpEnabled: true,
  mcpPort: true,
  mcpAutoStart: true,
  mcpReadOnly: true,
  mcpWatchExportFolder: true,
  mcpLogRequests: true,
}
const SETTINGS_KEYS = Object.keys(SETTINGS_KEY_SET) as Array<keyof Settings>

// Applies a partial update (settings GUI) onto `current`: recognized keys are
// validated with the same per-key rules as loadSettings — an invalid value is
// rejected and the current value stays — and unknown keys in the patch are
// dropped, so nothing invalid ever reaches settings.json.
export function applyPartial(current: Settings, patch: Record<string, unknown>): Settings {
  const raw: Record<string, unknown> = { ...current }
  for (const key of SETTINGS_KEYS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) raw[key] = patch[key]
  }
  return mergeSettings(current, raw)
}

// Electron accelerator modifiers (globalShortcut syntax). CommandOrControl and
// its aliases are accepted from a hand-edited settings.json even though the
// settings GUI emits plain Ctrl on Windows.
const ACCELERATOR_MODIFIERS = new Set([
  'command',
  'cmd',
  'control',
  'ctrl',
  'commandorcontrol',
  'cmdorctrl',
  'alt',
  'option',
  'altgr',
  'shift',
  'super',
  'meta',
])

// Accelerator-ish check (globalShortcut.register would throw on garbage): at
// least one modifier plus EXACTLY one non-modifier key, e.g. "Ctrl+Alt+C".
// The key name itself is not enumerated here — an unknown one simply fails to
// register, which the settings GUI reports inline and the startup path reports
// in its dialog.
function isCaptureHotkey(value: string): boolean {
  const parts = value.split('+')
  if (parts.length < 2) return false
  let keys = 0
  for (const part of parts) {
    const token = part.trim()
    if (token === '') return false
    if (ACCELERATOR_MODIFIERS.has(token.toLowerCase())) continue
    keys += 1
  }
  // parts.length >= 2 with exactly one key means at least one modifier.
  return keys === 1
}

// "cursor" (follow the mouse) or an Electron display id as digits. A stale but
// well-formed id is accepted here — capture falls back to primary at runtime
// when the display is no longer connected.
function isCaptureDisplay(value: string): boolean {
  return value === 'cursor' || /^\d+$/.test(value)
}

// "system" (resolve from app.getLocale() at use time) or a supported language.
function isUiLanguage(value: string): boolean {
  return value === 'system' || isSupportedLanguage(value)
}

// "ui" (follow the resolved UI language) or a supported language.
function isPackLanguage(value: string): boolean {
  return value === 'ui' || isSupportedLanguage(value)
}

// Known keys are validated against defaults; unknown keys ride along so a newer
// version's settings survive a downgrade.
function mergeSettings(base: Settings, raw: Record<string, unknown>): Settings {
  const known: Settings = {
    language:
      typeof raw.language === 'string' && isUiLanguage(raw.language) ? raw.language : base.language,
    packLanguage:
      typeof raw.packLanguage === 'string' && isPackLanguage(raw.packLanguage)
        ? raw.packLanguage
        : base.packLanguage,
    autoUpdateCheck: typeof raw.autoUpdateCheck === 'boolean' ? raw.autoUpdateCheck : base.autoUpdateCheck,
    outputDir: typeof raw.outputDir === 'string' && raw.outputDir.length > 0 ? raw.outputDir : base.outputDir,
    copyToClipboard: typeof raw.copyToClipboard === 'boolean' ? raw.copyToClipboard : base.copyToClipboard,
    captureHotkey:
      typeof raw.captureHotkey === 'string' && isCaptureHotkey(raw.captureHotkey)
        ? raw.captureHotkey
        : base.captureHotkey,
    replaySeconds:
      typeof raw.replaySeconds === 'number' && raw.replaySeconds > 0 ? raw.replaySeconds : base.replaySeconds,
    fps: typeof raw.fps === 'number' && raw.fps > 0 ? raw.fps : base.fps,
    captureDisplay:
      typeof raw.captureDisplay === 'string' && isCaptureDisplay(raw.captureDisplay)
        ? raw.captureDisplay
        : base.captureDisplay,
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
