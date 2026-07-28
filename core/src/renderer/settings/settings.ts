// Settings window renderer: loads current settings through the preload bridge,
// saves every change immediately on input (no Save button), clamps out-of-range
// numbers on commit with a brief highlight, and shows inline "restart to apply"
// hints for the keys the main process cannot honor live.
import type { SettingsDisplayOption, SettingsGetResult, SettingsPatch, SettingsSetResult } from '../../shared/ipc'
import {
  applyDomI18n,
  LANGUAGE_NATIVE_NAMES,
  makeT,
  resolveLanguage,
  SUPPORTED_LANGUAGES,
} from '../../shared/i18n'
import type { TranslateFn } from '../../shared/i18n'
import { DEFAULT_CAPTURE_HOTKEY } from '../../shared/types'
import type { Settings } from '../../shared/types'

interface SettingsBridge {
  get(): Promise<SettingsGetResult>
  set(patch: SettingsPatch): Promise<SettingsSetResult>
  pickOutputDir(): Promise<string | null>
  openOutput(): Promise<void>
}

declare global {
  interface Window {
    settingsBridge: SettingsBridge
  }
}

const bridge = window.settingsBridge

const FLASH_MS = 700

// ---------------------------------------------------------------------------
// DOM

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (found === null) throw new Error(`missing element #${id}`)
  return found as T
}

const outputPath = el<HTMLDivElement>('outputPath')
const changeOutputBtn = el<HTMLButtonElement>('changeOutputBtn')
const openOutputBtn = el<HTMLButtonElement>('openOutputBtn')
const captureDisplaySelect = el<HTMLSelectElement>('captureDisplay')
const captureHotkeyBtn = el<HTMLButtonElement>('captureHotkeyBtn')
const captureHotkeyHint = el<HTMLElement>('captureHotkeyHint')
const captureHotkeyRecordHint = el<HTMLElement>('captureHotkeyRecordHint')
const captureHotkeyError = el<HTMLElement>('captureHotkeyError')
const mcpUrlEl = el<HTMLElement>('mcpUrl')
const copyUrlBtn = el<HTMLButtonElement>('copyUrlBtn')
const appVersionEl = el<HTMLSpanElement>('appVersion')
const languageSelect = el<HTMLSelectElement>('language')
const packLanguageSelect = el<HTMLSelectElement>('packLanguage')

// ---------------------------------------------------------------------------
// State

let current: Settings | null = null
// Boot-time snapshot from main (NOT window-open): the values the running MCP
// server/watcher actually honor. Restart hints show while a hinted key differs
// from it, so a pending change keeps its hint across window close/reopen.
let boot: Settings | null = null
// The URL the RUNNING server listens on (boot-time port), shown and copied
// as-is: a changed port needs a restart, which the mcpPort hint says.
let runningMcpUrl = ''
// What "system" resolves to on this machine (from main); lets the window
// re-resolve the language locally the moment the dropdown changes.
let systemLanguage = 'en'
let appVersion = ''
let displays: SettingsDisplayOption[] = []
// Active-language t(); re-created by refreshLanguage() on every change.
let t: TranslateFn = makeT('en')

function activeLanguage(): string {
  return current === null ? 'en' : resolveLanguage(current.language, systemLanguage)
}

// Instant apply (GOAL i18n): re-applies the static data-i18n texts and
// rebuilds every dynamically built label in the new language.
function refreshLanguage(): void {
  t = makeT(activeLanguage())
  applyDomI18n(t)
  buildLanguageOptions()
  buildDisplayOptions()
  // Interpolated strings applyDomI18n cannot fill in on its own.
  appVersionEl.textContent = t('settings.version', { version: appVersion })
  captureHotkeyRecordHint.textContent = t('settings.hotkeyResetHint', {
    hotkey: DEFAULT_CAPTURE_HOTKEY,
  })
  syncHotkeyField()
}

// Keys whose change the main process cannot honor without a restart; each has
// an inline hint element `${key}Hint` (outputDir's hint is MCP-index specific).
const HINTED_KEYS = ['outputDir', 'mcpEnabled', 'mcpAutoStart', 'mcpPort', 'mcpWatchExportFolder'] as const

function updateHints(): void {
  if (current === null || boot === null) return
  for (const key of HINTED_KEYS) {
    el(`${key}Hint`).hidden = current[key] === boot[key]
  }
}

async function apply(patch: SettingsPatch): Promise<SettingsSetResult> {
  const result = await bridge.set(patch)
  current = result.settings
  syncControls()
  updateHints()
  return result
}

// ---------------------------------------------------------------------------
// Toggles

type BooleanSettingsKey = {
  [K in keyof Settings]: Settings[K] extends boolean ? K : never
}[keyof Settings]

const TOGGLES: ReadonlyArray<BooleanSettingsKey> = [
  'copyToClipboard',
  'autoUpdateCheck',
  'showDurationLabel',
  'scrubInvert',
  'mcpEnabled',
  'mcpAutoStart',
  'mcpWatchExportFolder',
  'mcpLogRequests',
]

for (const key of TOGGLES) {
  el<HTMLInputElement>(key).addEventListener('change', (event) => {
    const input = event.currentTarget as HTMLInputElement
    void apply({ [key]: input.checked } as SettingsPatch)
  })
}

// ---------------------------------------------------------------------------
// Number fields (clamp on commit, brief highlight when the value was adjusted)

interface NumberField {
  id: string
  min: number
  max: number
  round(value: number): number
  normalize?(value: number): number
  fromSettings(s: Settings): number
  patch(value: number): SettingsPatch
}

const NUMBER_FIELDS: ReadonlyArray<NumberField> = [
  {
    id: 'replaySeconds',
    min: 10,
    max: 60,
    round: Math.round,
    fromSettings: (s) => s.replaySeconds,
    patch: (v) => ({ replaySeconds: v }),
  },
  {
    id: 'fps',
    min: 5,
    max: 30,
    round: Math.round,
    fromSettings: (s) => s.fps,
    patch: (v) => ({ fps: v }),
  },
  {
    id: 'replayMaxWidth',
    min: 0,
    max: 3840,
    round: Math.round,
    // 0 is the explicit native-resolution sentinel; every non-zero setting is
    // in the allowed 720..3840 range.
    normalize: (v) => (v === 0 ? 0 : Math.max(720, v)),
    fromSettings: (s) => s.replayMaxWidth,
    patch: (v) => ({ replayMaxWidth: v }),
  },
  {
    // Shown in seconds, stored in milliseconds.
    id: 'defaultManualDuration',
    min: 0.5,
    max: 10,
    round: (v) => Math.round(v * 10) / 10,
    fromSettings: (s) => s.defaultManualDurationMs / 1000,
    patch: (v) => ({ defaultManualDurationMs: Math.round(v * 1000) }),
  },
  {
    id: 'scrubSensitivityMs',
    min: 50,
    max: 1000,
    round: Math.round,
    fromSettings: (s) => s.scrubSensitivityMs,
    patch: (v) => ({ scrubSensitivityMs: v }),
  },
  {
    id: 'mcpPort',
    min: 1024,
    max: 65535,
    round: Math.round,
    fromSettings: (s) => s.mcpPort,
    patch: (v) => ({ mcpPort: v }),
  },
]

function flash(input: HTMLInputElement): void {
  input.classList.add('flash')
  window.setTimeout(() => input.classList.remove('flash'), FLASH_MS)
}

for (const field of NUMBER_FIELDS) {
  const input = el<HTMLInputElement>(field.id)
  input.addEventListener('change', () => {
    if (current === null) return
    const typed = Number.parseFloat(input.value)
    if (!Number.isFinite(typed)) {
      // Not a number: snap back to the current value.
      input.value = String(field.fromSettings(current))
      flash(input)
      return
    }
    const rounded = field.round(Math.min(field.max, Math.max(field.min, typed)))
    const clamped = field.normalize?.(rounded) ?? rounded
    if (clamped !== typed) flash(input)
    input.value = String(clamped)
    void apply(field.patch(clamped))
  })
}

// ---------------------------------------------------------------------------
// Capture hotkey (GOAL "Settings GUI" > Capture): a recordable field. Clicking
// it — or activating it from the keyboard with Enter/Space — arms it, the next
// real key combination is captured, formatted as an Electron accelerator, and
// saved instantly; Esc cancels and Backspace/Delete resets to the default. A
// combination another app already owns cannot be registered — main reverts it
// and the inline conflict error appears.
//
// Arming deliberately does NOT happen on focus: the armed field swallows every
// keystroke, so a field that armed itself the moment Tab moved into it would
// trap keyboard navigation (GOAL "Settings GUI": keyboard accessible).

// Keys that only modify: pressing one alone keeps the field waiting.
const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'])

// event.key -> Electron accelerator key name, for keys whose name differs.
// Tab is absent on purpose: it must always move focus, never be recorded.
const ACCELERATOR_KEY_NAMES: Record<string, string> = {
  ' ': 'Space',
  Enter: 'Return',
  // '+' is the accelerator separator, so Electron names it instead.
  '+': 'Plus',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Home: 'Home',
  End: 'End',
  Insert: 'Insert',
}

let recordingHotkey = false
// Which inline error the hotkey row shows, or null for none. Kept as a KEY (not
// rendered text) so an instant language switch re-renders a visible error.
type HotkeyErrorKey = 'settings.hotkeyConflict' | 'settings.hotkeyInvalid'
let hotkeyErrorKey: HotkeyErrorKey | null = null

/** The accelerator key name for a keydown, or null when it has none we can use. */
function acceleratorKey(event: KeyboardEvent): string | null {
  const named = ACCELERATOR_KEY_NAMES[event.key]
  if (named !== undefined) return named
  if (/^F\d{1,2}$/.test(event.key)) return event.key
  // Letters and digits come from the PHYSICAL key so a non-Latin layout still
  // produces the accelerator the OS will match.
  const code = event.code
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (/^Numpad\d$/.test(code)) return `num${code.slice(6)}`
  // Punctuation: the single character the active layout produces, but only
  // when it is printable ASCII — that is the whole set Electron can name.
  // Anything else (ä, ß, …) has no accelerator, so the field keeps waiting
  // instead of emitting a combination that could never register.
  if (/^[\x21-\x7e]$/.test(event.key)) return event.key.toUpperCase()
  return null
}

/**
 * Electron accelerator for a keydown, or null when it is not a usable
 * combination (no modifier, or a key with no accelerator name). Windows is the
 * shipped platform, so the modifier is the literal Ctrl — CommandOrControl
 * would only matter on macOS.
 */
function toAccelerator(event: KeyboardEvent): string | null {
  const parts: string[] = []
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Super')
  if (parts.length === 0) return null
  const key = acceleratorKey(event)
  if (key === null) return null
  parts.push(key)
  return parts.join('+')
}

function syncHotkeyField(): void {
  captureHotkeyBtn.textContent = recordingHotkey
    ? t('settings.hotkeyRecording')
    : (current?.captureHotkey ?? DEFAULT_CAPTURE_HOTKEY)
  captureHotkeyBtn.classList.toggle('recording', recordingHotkey)
  captureHotkeyHint.hidden = recordingHotkey
  captureHotkeyRecordHint.hidden = !recordingHotkey
  if (hotkeyErrorKey === null) {
    captureHotkeyError.hidden = true
  } else {
    captureHotkeyError.textContent = t(hotkeyErrorKey)
    captureHotkeyError.hidden = false
  }
}

function startRecording(): void {
  if (recordingHotkey) return
  recordingHotkey = true
  hotkeyErrorKey = null
  syncHotkeyField()
}

function stopRecording(): void {
  if (!recordingHotkey) return
  recordingHotkey = false
  syncHotkeyField()
}

// Always round-trips to main, even when the recorded accelerator equals the
// stored one: after a refused registration the app holds NOTHING while the
// setting still names that accelerator, and re-recording it is the only way to
// take it back (main re-registers on that mismatch).
async function applyHotkey(accelerator: string): Promise<void> {
  const result = await apply({ captureHotkey: accelerator })
  // Two distinct failures, told apart by what came back:
  //  - hotkeyFailed: main reverted the setting because the OS refused the
  //    accelerator (another app owns it); syncControls() already restored the
  //    old value in the field.
  //  - settings unchanged without hotkeyFailed: main's validator rejected the
  //    string outright, so it was never a usable combination in the first place.
  hotkeyErrorKey =
    result.hotkeyFailed === true
      ? 'settings.hotkeyConflict'
      : result.settings.captureHotkey === accelerator
        ? null
        : 'settings.hotkeyInvalid'
  syncHotkeyField()
}

captureHotkeyBtn.addEventListener('click', startRecording)
captureHotkeyBtn.addEventListener('blur', stopRecording)

captureHotkeyBtn.addEventListener('keydown', (event) => {
  // Tab is never armed, never swallowed, and never recorded: focus must always
  // be able to leave the field (GOAL "Settings GUI": keyboard accessible).
  // Recording Shift+Tab would additionally hand reverse tab-navigation to
  // globalShortcut system-wide.
  if (event.key === 'Tab') {
    stopRecording()
    return
  }
  if (!recordingHotkey) {
    // Keyboard equivalent of the click that arms the field. preventDefault
    // keeps the button's native activation (and Space scrolling) out of it.
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      startRecording()
    }
    return
  }
  // Swallow the keystroke entirely: no button activation, no scrolling, and
  // above all no Esc reaching the window handler that closes the window.
  event.preventDefault()
  event.stopPropagation()
  if (event.key === 'Escape') {
    stopRecording()
    return
  }
  if (event.key === 'Backspace' || event.key === 'Delete') {
    stopRecording()
    void applyHotkey(DEFAULT_CAPTURE_HOTKEY)
    return
  }
  // A lone modifier (or an unusable key) is the user still reaching for the
  // combination: keep waiting instead of rejecting it.
  if (MODIFIER_KEYS.has(event.key)) return
  const accelerator = toAccelerator(event)
  if (accelerator === null) return
  stopRecording()
  void applyHotkey(accelerator)
})

// ---------------------------------------------------------------------------
// Capture display picker

function buildDisplayOptions(): void {
  captureDisplaySelect.replaceChildren()
  // GOAL "Multi-Monitor Support": all displays first, and the default.
  const allOption = document.createElement('option')
  allOption.value = 'all'
  allOption.textContent = t('settings.allDisplays')
  captureDisplaySelect.append(allOption)
  const cursorOption = document.createElement('option')
  cursorOption.value = 'cursor'
  cursorOption.textContent = t('settings.cursorDisplay')
  captureDisplaySelect.append(cursorOption)
  for (const display of displays) {
    const option = document.createElement('option')
    option.value = display.id
    option.textContent = display.label
    captureDisplaySelect.append(option)
  }
  // A configured fixed display that is currently disconnected still needs an
  // entry, or the select would silently show the wrong value. Capture itself
  // falls back to primary while it is gone.
  const configured = current?.captureDisplay ?? 'all'
  if (configured !== 'all' && configured !== 'cursor' && !displays.some((d) => d.id === configured)) {
    const option = document.createElement('option')
    option.value = configured
    option.textContent = t('settings.displayDisconnected', { id: configured })
    captureDisplaySelect.append(option)
  }
  if (current !== null) captureDisplaySelect.value = current.captureDisplay
}

// Language pickers (GOAL i18n, Settings > General): "System default" / "Match
// app language" first, then the nine languages under their NATIVE names.
function buildLanguageOptions(): void {
  const build = (select: HTMLSelectElement, first: string, firstLabel: string): void => {
    select.replaceChildren()
    const head = document.createElement('option')
    head.value = first
    head.textContent = firstLabel
    select.append(head)
    for (const lang of SUPPORTED_LANGUAGES) {
      const option = document.createElement('option')
      option.value = lang
      option.textContent = LANGUAGE_NATIVE_NAMES[lang]
      select.append(option)
    }
  }
  build(languageSelect, 'system', t('settings.languageSystem'))
  build(packLanguageSelect, 'ui', t('settings.packLanguageMatch'))
  if (current !== null) {
    languageSelect.value = current.language
    packLanguageSelect.value = current.packLanguage
  }
}

languageSelect.addEventListener('change', () => {
  void (async () => {
    await apply({ language: languageSelect.value })
    // Full reload: main rebuilds the display labels (the "primary" word) in
    // the new language, and refreshLanguage() re-renders this whole window.
    await hydrate()
  })()
})

packLanguageSelect.addEventListener('change', () => {
  void apply({ packLanguage: packLanguageSelect.value })
})

captureDisplaySelect.addEventListener('change', () => {
  void apply({ captureDisplay: captureDisplaySelect.value })
})

// ---------------------------------------------------------------------------
// Output folder

changeOutputBtn.addEventListener('click', () => {
  void (async () => {
    const picked = await bridge.pickOutputDir()
    if (picked !== null) await apply({ outputDir: picked })
  })()
})

openOutputBtn.addEventListener('click', () => {
  void bridge.openOutput()
})

// ---------------------------------------------------------------------------
// MCP connection URL

copyUrlBtn.addEventListener('click', () => {
  const url = runningMcpUrl
  if (url === '') return
  navigator.clipboard
    .writeText(url)
    .then(() => {
      copyUrlBtn.textContent = t('settings.copied')
      window.setTimeout(() => {
        copyUrlBtn.textContent = t('settings.copy')
      }, 900)
    })
    .catch(() => {
      // Clipboard unavailable: leave the selectable URL text for manual copy.
    })
})

// ---------------------------------------------------------------------------
// Sync + init

function syncControls(): void {
  if (current === null) return
  const s = current
  outputPath.textContent = s.outputDir
  outputPath.title = s.outputDir
  for (const key of TOGGLES) {
    el<HTMLInputElement>(key).checked = s[key]
  }
  for (const field of NUMBER_FIELDS) {
    el<HTMLInputElement>(field.id).value = String(field.fromSettings(s))
  }
  captureDisplaySelect.value = s.captureDisplay
  syncHotkeyField()
  languageSelect.value = s.language
  packLanguageSelect.value = s.packLanguage
  mcpUrlEl.textContent = runningMcpUrl
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    window.close()
  }
})

async function hydrate(): Promise<void> {
  const data = await bridge.get()
  current = data.settings
  boot = data.bootSettings
  displays = data.displays
  runningMcpUrl = data.mcpUrl
  systemLanguage = data.systemLanguage
  appVersion = data.appVersion
  refreshLanguage()
  syncControls()
  updateHints()
}

void hydrate()
