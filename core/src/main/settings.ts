// Settings persistence: JSON file in userData, tolerant of missing/corrupt content.
import { app } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { isSupportedLanguage } from '../shared/i18n'
import { DEFAULT_CAPTURE_HOTKEY, SETTINGS_VERSION } from '../shared/types'
import type { ClipboardAfterSave, EditorWindowBounds, Settings } from '../shared/types'

/** The four things a saved pack can put on the clipboard. */
const CLIPBOARD_MODES: readonly ClipboardAfterSave[] = ['off', 'folder', 'path', 'prompt']

/**
 * Longest replay buffer that may be configured (10 minutes). The recorder holds
 * 1x-2x of this in memory per display, every render replays it in REAL TIME,
 * and the annotated-keyframe filename format spells the replay clock as
 * MM-SS.mmm (SPEC §5.7) — the bound is what keeps all three honest.
 */
export const MAX_REPLAY_SECONDS = 600

export function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

function defaultSettings(): Settings {
  return {
    // A fresh install is born at the current version and therefore never
    // migrates: every default below is already the current meaning.
    settingsVersion: SETTINGS_VERSION,
    language: 'system',
    packLanguage: 'ui',
    autoUpdateCheck: true,
    launchAtLogin: true,
    // ON by default (GOAL "And do not stay gone."): the failure issue #61
    // reported — a hotkey pressed into silence because the app had died hours
    // ago — is invisible until it is supervised, so a user must not have to
    // know the feature exists to be protected by it.
    superviseProcess: true,
    notifyOnRecordingStart: true,
    recordingEnabled: true,
    outputDir: path.join(app.getPath('desktop'), 'CapturePack'),
    // The prompt, not the folder: what a saved pack is for, nine times out of
    // ten, is the next sentence typed into an LLM.
    clipboardAfterSave: 'prompt',
    // The welcome window has never been shown on this machine (GOAL "Welcome
    // (first launch after install)"). Flipped — and written — the moment the
    // window opens.
    welcomeShown: false,
    welcomeDeferredFromLogin: false,
    captureHotkey: DEFAULT_CAPTURE_HOTKEY,
    replaySeconds: 30,
    fps: 15,
    replayMaxWidth: 1920,
    // All displays by default (GOAL "Multi-Monitor Support"). Migration is
    // silent by construction: mergeSettings keeps any VALID stored value, so an
    // existing settings.json that says "cursor" (or a fixed display id) stays
    // exactly as the user chose it — only a fresh install starts at "all".
    captureDisplay: 'all',
    // Object picking is what left click has run on since 0.1.4 (GOAL "Static
    // object picking"), so it is on out of the box; issue #57 gives it the
    // Settings switch its per-capture cost earns it.
    uiaEnabled: true,
    scrubInvert: false,
    scrubSensitivityMs: 100,
    defaultManualDurationMs: 1000,
    showDurationLabel: true,
    // The editor's shortcut sheet is ON for a new user (GOAL "Editor Chrome":
    // "so a new user sees the whole vocabulary without asking"). The `?` / F1
    // toggle writes this back, so turning it off is permanent.
    showShortcutOverlay: true,
    // The tutorial is for someone who has never seen the editor, so it is ON
    // until it has done its job once.
    showEditorTutorial: true,
    // The fullscreen overlay stays the default editor (GOAL "Editor Window
    // Mode"); windowed mode is opt-in and then remembered with its rectangle.
    editorWindowMode: 'windowed',
    editorWindowBounds: null,
    mcpEnabled: true,
    mcpPort: 39393,
    mcpAutoStart: true,
    mcpReadOnly: true,
    mcpWatchExportFolder: true,
    mcpLogRequests: false,
  }
}

/** What loadSettings reports: the settings themselves plus how they were found. */
export interface LoadedSettings {
  settings: Settings
  /**
   * NO settings file existed when this ran — i.e. a genuinely fresh install.
   *
   * The first-launch welcome window (GOAL "Welcome (first launch after
   * install)") initially keys off THIS, never off welcomeShown alone: an update
   * always finds a settings file, so it cannot show the window merely because
   * an old profile lacks that flag. A hidden login launch persists
   * welcomeDeferredFromLogin so the next manual launch can still show it.
   */
  firstRun: boolean
}

export function loadSettings(): LoadedSettings {
  const base = defaultSettings()
  let raw: Record<string, unknown> | null = null
  // A malformed but non-empty file is preserved on disk (defaults apply in
  // memory only) so a user's hand-edit mistake is never silently destroyed.
  let preserveFile = false
  let text: string | null = null
  // Was settings.json there BEFORE this load? An existing but UNREADABLE file
  // still counts as existing: a permission error on an upgraded install must
  // never be mistaken for a fresh one.
  let fileExisted = true
  try {
    text = fs.readFileSync(settingsFilePath(), 'utf8')
  } catch {
    text = null // Missing/unreadable file: fall through and write defaults.
    fileExisted = fs.existsSync(settingsFilePath())
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
  const settings = raw ? mergeSettings(base, migrateSettings(raw)) : base
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
  return {
    settings: override !== null ? { ...settings, outputDir: override } : settings,
    firstRun: !fileExisted,
  }
}

/**
 * One-time migrations, applied to the RAW settings.json before validation.
 *
 * A profile carrying no `settingsVersion` predates versioning — that absence is
 * the only signal available, and it can only ever be observed once, because
 * every load stamps the current version back on.
 *
 * v1 -> v2 (GOAL "Multi-Monitor Support"): `captureDisplay: "cursor"` was the
 * DEFAULT before 0.1.3, so a profile still on it was almost certainly never
 * asked the question — it becomes "all" (capture every display), which is the
 * default a fresh install gets today. A user who picks "cursor" deliberately
 * afterwards is left alone forever: their profile is already stamped, so this
 * never looks at it again. Any other value ("all", a fixed display id) was a
 * real choice and is untouched here too.
 */
function migrateSettings(raw: Record<string, unknown>): Record<string, unknown> {
  if (typeof raw.settingsVersion === 'number') return raw
  const migrated = { ...raw }
  if (migrated.captureDisplay === 'cursor') migrated.captureDisplay = 'all'
  migrated.settingsVersion = SETTINGS_VERSION
  return migrated
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
  settingsVersion: true,
  language: true,
  packLanguage: true,
  autoUpdateCheck: true,
  launchAtLogin: true,
  superviseProcess: true,
  notifyOnRecordingStart: true,
  outputDir: true,
  clipboardAfterSave: true,
  welcomeShown: true,
  welcomeDeferredFromLogin: true,
  captureHotkey: true,
  replaySeconds: true,
  fps: true,
  replayMaxWidth: true,
  captureDisplay: true,
  recordingEnabled: true,
  uiaEnabled: true,
  scrubInvert: true,
  scrubSensitivityMs: true,
  defaultManualDurationMs: true,
  showDurationLabel: true,
  showShortcutOverlay: true,
  showEditorTutorial: true,
  editorWindowMode: true,
  editorWindowBounds: true,
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

// "all" (freeze every display), "cursor" (follow the mouse, keep that display
// only), or an Electron display id as digits. A stale but well-formed id is
// accepted here — capture falls back to primary at runtime when the display is
// no longer connected.
function isCaptureDisplay(value: string): boolean {
  return value === 'all' || value === 'cursor' || /^\d+$/.test(value)
}

// The editor's two window modes (GOAL "Editor Window Mode").
function isEditorWindowMode(value: unknown): value is Settings['editorWindowMode'] {
  return value === 'fullscreen' || value === 'windowed'
}

// A remembered windowed-editor rectangle. Position may be negative (a display
// left of the primary); the size must be a positive finite number. A rectangle
// that no longer fits any connected display is NOT rejected here — the editor
// clamps it to the target display's work area when it opens.
function isEditorWindowBounds(value: unknown): value is EditorWindowBounds {
  if (value === null || typeof value !== 'object') return false
  const b = value as Record<string, unknown>
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  return (
    finite(b['x']) &&
    finite(b['y']) &&
    finite(b['width']) &&
    finite(b['height']) &&
    b['width'] > 0 &&
    b['height'] > 0
  )
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
    // Carried through, never invented here: migrateSettings() is the only place
    // that stamps a version, and it runs on the RAW file before this — so
    // "there was no settingsVersion on disk" stays visible exactly once.
    settingsVersion:
      typeof raw.settingsVersion === 'number' && Number.isInteger(raw.settingsVersion)
        ? raw.settingsVersion
        : base.settingsVersion,
    language:
      typeof raw.language === 'string' && isUiLanguage(raw.language) ? raw.language : base.language,
    packLanguage:
      typeof raw.packLanguage === 'string' && isPackLanguage(raw.packLanguage)
        ? raw.packLanguage
        : base.packLanguage,
    autoUpdateCheck: typeof raw.autoUpdateCheck === 'boolean' ? raw.autoUpdateCheck : base.autoUpdateCheck,
    launchAtLogin: typeof raw.launchAtLogin === 'boolean' ? raw.launchAtLogin : base.launchAtLogin,
    superviseProcess:
      typeof raw.superviseProcess === 'boolean' ? raw.superviseProcess : base.superviseProcess,
    notifyOnRecordingStart:
      typeof raw.notifyOnRecordingStart === 'boolean'
        ? raw.notifyOnRecordingStart
        : base.notifyOnRecordingStart,
    outputDir: typeof raw.outputDir === 'string' && raw.outputDir.length > 0 ? raw.outputDir : base.outputDir,
    // v2 -> v3: the boolean became a mode.
    //
    // `true` LITERALLY meant "copy the folder", and the first cut of this
    // migration preserved that. It was the wrong reading: a folder on the
    // clipboard pastes as nothing at all into a chat box, which is where a
    // saved pack actually goes — reported as "저장후 클립보드 동작하지 않아"
    // by someone whose clipboard was in fact being written to. What the switch
    // MEANT was "put the pack somewhere I can hand it over", and the prompt is
    // that intent with the path already in the sentence. `false` still means
    // off, which was never ambiguous.
    clipboardAfterSave: CLIPBOARD_MODES.includes(raw.clipboardAfterSave as ClipboardAfterSave)
      ? (raw.clipboardAfterSave as ClipboardAfterSave)
      : typeof raw.copyToClipboard === 'boolean'
        ? raw.copyToClipboard
          ? 'prompt'
          : 'off'
        : base.clipboardAfterSave,
    welcomeShown: typeof raw.welcomeShown === 'boolean' ? raw.welcomeShown : base.welcomeShown,
    welcomeDeferredFromLogin:
      typeof raw.welcomeDeferredFromLogin === 'boolean'
        ? raw.welcomeDeferredFromLogin
        : base.welcomeDeferredFromLogin,
    captureHotkey:
      typeof raw.captureHotkey === 'string' && isCaptureHotkey(raw.captureHotkey)
        ? raw.captureHotkey
        : base.captureHotkey,
    // Upper bound as well as lower: the replay is held in memory by the
    // recorder pair and re-encoded in real time by every render, and the
    // keyframe filename clock (frames/frame-NN_MM-SS.mmm.png, SPEC §5.7) spells
    // minutes. A hand-edited settings.json must not be able to ask for hours.
    replaySeconds:
      typeof raw.replaySeconds === 'number' &&
      raw.replaySeconds > 0 &&
      raw.replaySeconds <= MAX_REPLAY_SECONDS
        ? raw.replaySeconds
        : base.replaySeconds,
    fps: typeof raw.fps === 'number' && raw.fps > 0 ? raw.fps : base.fps,
    replayMaxWidth:
      typeof raw.replayMaxWidth === 'number' &&
      Number.isInteger(raw.replayMaxWidth) &&
      (raw.replayMaxWidth === 0 ||
        (raw.replayMaxWidth >= 720 && raw.replayMaxWidth <= 3840))
        ? raw.replayMaxWidth
        : base.replayMaxWidth,
    captureDisplay:
      typeof raw.captureDisplay === 'string' && isCaptureDisplay(raw.captureDisplay)
        ? raw.captureDisplay
        : base.captureDisplay,
    recordingEnabled:
      typeof raw.recordingEnabled === 'boolean' ? raw.recordingEnabled : base.recordingEnabled,
    uiaEnabled: typeof raw.uiaEnabled === 'boolean' ? raw.uiaEnabled : base.uiaEnabled,
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
    showShortcutOverlay:
      typeof raw.showShortcutOverlay === 'boolean'
        ? raw.showShortcutOverlay
        : base.showShortcutOverlay,
    showEditorTutorial:
      typeof raw.showEditorTutorial === 'boolean'
        ? raw.showEditorTutorial
        : base.showEditorTutorial,
    // The fullscreen overlay was removed; a settings file written before that
    // still says 'fullscreen' and must not open an editor in a mode that no
    // longer exists. Read as 'windowed', which is now the only one.
    editorWindowMode: 'windowed',
    // Copied field by field: whatever else a hand-edited (or newer) settings.json
    // hung on the object must never ride into the window bounds the editor
    // applies.
    editorWindowBounds: isEditorWindowBounds(raw.editorWindowBounds)
      ? {
          x: raw.editorWindowBounds.x,
          y: raw.editorWindowBounds.y,
          width: raw.editorWindowBounds.width,
          height: raw.editorWindowBounds.height,
        }
      : base.editorWindowBounds,
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
