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
  appVersionEl.textContent = t('settings.version', { version: appVersion })
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

async function apply(patch: SettingsPatch): Promise<void> {
  const result = await bridge.set(patch)
  current = result.settings
  syncControls()
  updateHints()
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
    const clamped = field.round(Math.min(field.max, Math.max(field.min, typed)))
    if (clamped !== typed) flash(input)
    input.value = String(clamped)
    void apply(field.patch(clamped))
  })
}

// ---------------------------------------------------------------------------
// Capture display picker

function buildDisplayOptions(): void {
  captureDisplaySelect.replaceChildren()
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
  const configured = current?.captureDisplay ?? 'cursor'
  if (configured !== 'cursor' && !displays.some((d) => d.id === configured)) {
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
