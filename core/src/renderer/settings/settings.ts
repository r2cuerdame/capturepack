// Settings window renderer: loads current settings through the preload bridge,
// saves every change immediately on input (no Save button), clamps out-of-range
// numbers on commit with a brief highlight, and shows inline "restart to apply"
// hints for the keys the main process cannot honor live.
import type { SettingsGetResult, SettingsPatch, SettingsSetResult } from '../../shared/ipc'
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

function buildDisplayOptions(data: SettingsGetResult): void {
  captureDisplaySelect.replaceChildren()
  const cursorOption = document.createElement('option')
  cursorOption.value = 'cursor'
  cursorOption.textContent = 'Cursor display (recommended)'
  captureDisplaySelect.append(cursorOption)
  for (const display of data.displays) {
    const option = document.createElement('option')
    option.value = display.id
    option.textContent = display.label
    captureDisplaySelect.append(option)
  }
  // A configured fixed display that is currently disconnected still needs an
  // entry, or the select would silently show the wrong value. Capture itself
  // falls back to primary while it is gone.
  const configured = data.settings.captureDisplay
  if (configured !== 'cursor' && !data.displays.some((d) => d.id === configured)) {
    const option = document.createElement('option')
    option.value = configured
    option.textContent = `Display ${configured} (disconnected)`
    captureDisplaySelect.append(option)
  }
}

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
      copyUrlBtn.textContent = 'Copied'
      window.setTimeout(() => {
        copyUrlBtn.textContent = 'Copy'
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
  mcpUrlEl.textContent = runningMcpUrl
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    window.close()
  }
})

void (async () => {
  const data = await bridge.get()
  current = data.settings
  boot = data.bootSettings
  runningMcpUrl = data.mcpUrl
  buildDisplayOptions(data)
  syncControls()
  appVersionEl.textContent = `CapturePack v${data.appVersion}`
  updateHints()
})()
