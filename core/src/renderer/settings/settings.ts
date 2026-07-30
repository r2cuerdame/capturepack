// Settings window renderer: loads current settings through the preload bridge,
// saves every change immediately on input (no Save button), clamps out-of-range
// numbers on commit with a brief highlight, and shows inline "press Restart to
// apply" hints for the MCP keys the running server has not picked up yet.
//
// Three things in this window are LIVE rather than configured (issues #54,
// #57): whether the MCP server is listening, what Windows UI Automation did on
// the last capture, and whether a Chrome extension has an active handshake.
// They are re-read while the window is open because all can change elsewhere.
import type {
  ChromeIntegrationStatus,
  StoragePurgeResult,
  StorageUsage,
  McpStatus,
  SettingsDisplayOption,
  SettingsGetResult,
  SettingsPatch,
  SettingsSetResult,
  SettingsStatusResult,
  UiaPluginStatus,
} from '../../shared/ipc'
import {
  applyDomI18n,
  LANGUAGE_NATIVE_NAMES,
  makeT,
  resolveLanguage,
  SUPPORTED_LANGUAGES,
} from '../../shared/i18n'
import type { I18nKey, TranslateFn } from '../../shared/i18n'
import { connectAndAnalyzeLatestPrompt } from '../../shared/prompt'
import {
  DEFAULT_CAPTURE_HOTKEY,
  DEFAULT_IMAGE_CAPTURE_HOTKEY,
  MAX_CAPTURE_FPS,
  MIN_CAPTURE_FPS,
} from '../../shared/types'
import type { Settings } from '../../shared/types'

interface SettingsBridge {
  get(): Promise<SettingsGetResult>
  set(patch: SettingsPatch): Promise<SettingsSetResult>
  pickOutputDir(): Promise<string | null>
  openOutput(): Promise<void>
  // The online manual (GOAL "First-Run Tutorial"); main owns the address.
  openGuide(): void
  chromeStatus(): Promise<ChromeIntegrationStatus>
  chromeInstall(extensionId: string): Promise<ChromeIntegrationStatus>
  chromeUninstall(): Promise<ChromeIntegrationStatus>
  chromeOpenFolder(): void
  storageUsage(): Promise<StorageUsage>
  storagePurge(days: number): Promise<StoragePurgeResult>
  chromeOpenExtensionsPage(): Promise<string | null>
  chromeCopyPath(): void
  chromeDetect(): Promise<ChromeIntegrationStatus>
  status(): Promise<SettingsStatusResult>
  restartMcp(): Promise<SettingsStatusResult>
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
const guideBtn = el<HTMLButtonElement>('guideBtn')
const chromeVerdict = el<HTMLElement>('chromeVerdict')
const chromeChecks = el<HTMLUListElement>('chromeChecks')
const chromeExtensionId = el<HTMLInputElement>('chromeExtensionId')
const chromeInstallBtn = el<HTMLButtonElement>('chromeInstallBtn')
const chromeFolderBtn = el<HTMLButtonElement>('chromeFolderBtn')
const chromeExtPageBtn = el<HTMLButtonElement>('chromeExtPageBtn')
const chromeDetectBtn = el<HTMLButtonElement>('chromeDetectBtn')
const chromeManual = el<HTMLDivElement>('chromeManual')
const chromeManualToggle = el<HTMLButtonElement>('chromeManualToggle')
const chromeSteps = [el<HTMLLIElement>('chromeStep1'), el<HTMLLIElement>('chromeStep2'), el<HTMLLIElement>('chromeStep3')]
const chromeStep3How = el<HTMLElement>('chromeStep3How')
const chromeUninstallBtn = el<HTMLButtonElement>('chromeUninstallBtn')
const chromeRefreshBtn = el<HTMLButtonElement>('chromeRefreshBtn')
const chromeExtDir = el<HTMLElement>('chromeExtDir')
const chromeOpenFailed = el<HTMLElement>('chromeOpenFailed')
const chromeIcon = el<HTMLElement>('chromeIcon')
const chromeEnabledInput = el<HTMLInputElement>('chromeDomEnabled')
const chromeHelpBtn = el<HTMLButtonElement>('chromeHelpBtn')
const chromeHelpEl = el<HTMLElement>('chromeHelp')
const chromeFoldBtn = el<HTMLButtonElement>('chromeFoldBtn')
const chromeDetailPanel = el<HTMLElement>('chromeDetailPanel')
const captureDisplaySelect = el<HTMLSelectElement>('captureDisplay')
const clipboardSelect = el<HTMLSelectElement>('clipboardAfterSave')
const imageClipboardSelect = el<HTMLSelectElement>('imageClipboardAfterSave')
const captureHotkeyBtn = el<HTMLButtonElement>('captureHotkeyBtn')
const captureHotkeyHint = el<HTMLElement>('captureHotkeyHint')
const captureHotkeyRecordHint = el<HTMLElement>('captureHotkeyRecordHint')
const captureHotkeyError = el<HTMLElement>('captureHotkeyError')
const imageCaptureHotkeyBtn = el<HTMLButtonElement>('imageCaptureHotkeyBtn')
const imageCaptureHotkeyHint = el<HTMLElement>('imageCaptureHotkeyHint')
const imageCaptureHotkeyRecordHint = el<HTMLElement>('imageCaptureHotkeyRecordHint')
const imageCaptureHotkeyError = el<HTMLElement>('imageCaptureHotkeyError')
const mcpUrlEl = el<HTMLElement>('mcpUrl')
const copyUrlBtn = el<HTMLButtonElement>('copyUrlBtn')
const mcpDot = el<HTMLElement>('mcpDot')
const mcpStateEl = el<HTMLElement>('mcpState')
const mcpRestartBtn = el<HTMLButtonElement>('mcpRestartBtn')
const mcpClientSelect = el<HTMLSelectElement>('mcpClient')
const copySetupBtn = el<HTMLButtonElement>('copySetupBtn')
const copyPromptBtn = el<HTMLButtonElement>('copyPromptBtn')
const replayMaxWidthSelect = el<HTMLSelectElement>('replayMaxWidth')
const uiaIcon = el<HTMLElement>('uiaIcon')
const uiaStatusEl = el<HTMLElement>('uiaStatus')
const uiaEnabledInput = el<HTMLInputElement>('uiaEnabled')
const uiaHelpBtn = el<HTMLButtonElement>('uiaHelpBtn')
const uiaHelpEl = el<HTMLElement>('uiaHelp')
const uiaFoldBtn = el<HTMLButtonElement>('uiaFoldBtn')
const uiaDetailPanel = el<HTMLElement>('uiaDetailPanel')
const appVersionEl = el<HTMLSpanElement>('appVersion')
const languageSelect = el<HTMLSelectElement>('language')
const packLanguageSelect = el<HTMLSelectElement>('packLanguage')

// ---------------------------------------------------------------------------
// State

let current: Settings | null = null
// The LIVE state of the MCP server and the object-picking plugin, plus the
// settings the running server actually honors. Everything this window says
// about either is rendered from here — never from `current`, which is only
// what was asked for.
let status: SettingsStatusResult | null = null
// What "system" resolves to on this machine (from main); lets the window
// re-resolve the language locally the moment the dropdown changes.
let systemLanguage = 'en'
let appVersion = ''
let displays: SettingsDisplayOption[] = []
// Active-language t(); re-created by refreshLanguage() on every change.
let t: TranslateFn = makeT('en')

/** The endpoint the server actually bound; '' when nothing is listening. */
function liveEndpoint(): string {
  return status?.mcp.endpoint ?? ''
}

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
  buildReplayMaxWidthOptions()
  // Interpolated strings applyDomI18n cannot fill in on its own.
  appVersionEl.textContent = t('settings.version', { version: appVersion })
  captureHotkeyRecordHint.textContent = t('settings.hotkeyResetHint', {
    hotkey: DEFAULT_CAPTURE_HOTKEY,
  })
  imageCaptureHotkeyRecordHint.textContent = t('settings.hotkeyResetHint', {
    hotkey: DEFAULT_IMAGE_CAPTURE_HOTKEY,
  })
  syncHotkeyField()
  syncImageHotkeyField()
  // The client dropdown is NOT rebuilt here: its entries are product names and
  // config paths, identical in every language, and rebuilding it would throw
  // away the client the user just picked.
  renderLive()
}

/**
 * Keys the RUNNING MCP server only picks up on a restart; each has an inline
 * hint element `${key}Hint` pointing at the [Restart] button (issue #54).
 *
 * mcpAutoStart is deliberately absent — it decides what happens at the next APP
 * start and nothing else, so a hint on it would be a lie. mcpEnabled left for
 * the same reason in v0.1.6: it now stops and starts the server the instant it
 * is clicked, so it is never "pending" and a hint on it would be a lie too.
 * outputDir and mcpWatchExportFolder follow live Settings on the next request;
 * replacing the store for those values used to be the stale-folder bug.
 */
const MCP_HINTED_KEYS = ['mcpPort'] as const

function updateHints(): void {
  if (current === null || status === null) return
  const applied = status.mcpSettings
  for (const key of MCP_HINTED_KEYS) {
    el(`${key}Hint`).hidden = current[key] === applied[key]
  }
}

async function apply(patch: SettingsPatch): Promise<SettingsSetResult> {
  const result = await bridge.set(patch)
  current = result.settings
  syncControls()
  updateHints()
  // A patch can change what is LIVE, not just what is configured — turning the
  // object-picking plugin off is the whole point of issue #57's switch — so the
  // status rows are re-read rather than left showing the previous reality.
  await refreshStatus()
  return result
}

/** Re-reads the live MCP/plugin state and repaints the rows that show it. */
async function refreshStatus(): Promise<void> {
  try {
    status = await bridge.status()
  } catch {
    // Main is gone or busy: keep showing the last known state rather than
    // blanking rows that were true a moment ago.
    return
  }
  renderLive()
}

// ---------------------------------------------------------------------------
// Toggles

type BooleanSettingsKey = {
  [K in keyof Settings]: Settings[K] extends boolean ? K : never
}[keyof Settings]

const TOGGLES: ReadonlyArray<BooleanSettingsKey> = [
  'autoUpdateCheck',
  'launchAtLogin',
  // GOAL "And do not stay gone." (issue #61): main stops the watchdog and
  // removes the Start Menu fallback the moment this goes off, so the switch is
  // a real teardown, not a preference read at the next start.
  'superviseProcess',
  'notifyOnRecordingStart',
  'showDurationLabel',
  'scrubInvert',
  'mcpEnabled',
  'mcpAutoStart',
  'mcpWatchExportFolder',
  'mcpLogRequests',
  // The recording privacy switch: applied live main-side through the same
  // recorder rebuild every other capture change uses.
  'recordingEnabled',
  // The Plugins row's real on/off (issue #57): main applies it immediately to
  // the resident control lane, and the capture flow reads the same value for
  // its one-shot dump at the next trigger.
  'uiaEnabled',
  // The browser integration's equivalent switch. Main closes/reopens the pipe
  // immediately, and the native host redials without a page reload.
  'chromeDomEnabled',
  // The editor's first-run tutorial. It belongs in this list rather than in a
  // handler of its own precisely BECAUSE the editor clears it: every refresh of
  // this panel re-reads the flag, so the box falls back down on its own once a
  // capture has shown the tutorial, and never claims an armed state that is no
  // longer true.
  'showEditorTutorial',
]

for (const key of TOGGLES) {
  el<HTMLInputElement>(key).addEventListener('change', (event) => {
    const input = event.currentTarget as HTMLInputElement
    void apply({ [key]: input.checked } as SettingsPatch).then(() => {
      if (key === 'chromeDomEnabled') refreshChromeStatus()
    })
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
    // One second is a legitimate ask: the buffer is what the capture COSTS, and
    // a user who only ever wants the last moment should not have to keep ten.
    min: 1,
    max: 60,
    round: Math.round,
    fromSettings: (s) => s.replaySeconds,
    patch: (v) => ({ replaySeconds: v }),
  },
  {
    id: 'fps',
    // Keep the request intentionally bounded: the achieved rate is still
    // reported separately in the manifest when the machine cannot sustain it.
    min: MIN_CAPTURE_FPS,
    max: MAX_CAPTURE_FPS,
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
// Replay resolution limit (issue #45): presets, not a free number.
//
// The stored value stays an integer WIDTH, so every existing settings.json
// keeps loading exactly as before — this only changes how the choice is
// offered. Each label states the trade (sharpness vs CPU) the choice really is;
// only the replay video is scaled, the snapshot is always native (GOAL
// "Capture must stay cheap").

const REPLAY_MAX_WIDTHS = [0, 3840, 2560, 1920, 1280, 720] as const

const REPLAY_MAX_WIDTH_LABELS: Record<(typeof REPLAY_MAX_WIDTHS)[number], I18nKey> = {
  0: 'settings.replayResNative',
  3840: 'settings.replayRes3840',
  2560: 'settings.replayRes2560',
  1920: 'settings.replayRes1920',
  1280: 'settings.replayRes1280',
  720: 'settings.replayRes720',
}

function buildReplayMaxWidthOptions(): void {
  replayMaxWidthSelect.replaceChildren()
  for (const width of REPLAY_MAX_WIDTHS) {
    const option = document.createElement('option')
    option.value = String(width)
    option.textContent = t(REPLAY_MAX_WIDTH_LABELS[width])
    replayMaxWidthSelect.append(option)
  }
  // A stored width that is not a preset — an older profile that used the free
  // number field, or a hand-edited settings.json — gets an entry of its own.
  // Without it the select would show the FIRST option and the next unrelated
  // save would silently write that value: a settings screen must never change a
  // setting the user did not touch.
  const stored = current?.replayMaxWidth
  if (stored !== undefined && !(REPLAY_MAX_WIDTHS as readonly number[]).includes(stored)) {
    const option = document.createElement('option')
    option.value = String(stored)
    option.textContent = t('settings.replayResCustom', { width: stored })
    replayMaxWidthSelect.append(option)
  }
  if (current !== null) replayMaxWidthSelect.value = String(current.replayMaxWidth)
}

replayMaxWidthSelect.addEventListener('change', () => {
  const width = Number.parseInt(replayMaxWidthSelect.value, 10)
  // Every option carries an integer value, so this only guards against a
  // select that somehow holds none; main validates the value again anyway.
  if (!Number.isInteger(width)) return
  void apply({ replayMaxWidth: width })
})

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
let recordingImageHotkey = false
let imageHotkeyErrorKey: HotkeyErrorKey | null = null

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

function syncImageHotkeyField(): void {
  imageCaptureHotkeyBtn.textContent = recordingImageHotkey
    ? t('settings.hotkeyRecording')
    : (current?.imageCaptureHotkey ?? DEFAULT_IMAGE_CAPTURE_HOTKEY)
  imageCaptureHotkeyBtn.classList.toggle('recording', recordingImageHotkey)
  imageCaptureHotkeyHint.hidden = recordingImageHotkey
  imageCaptureHotkeyRecordHint.hidden = !recordingImageHotkey
  if (imageHotkeyErrorKey === null) {
    imageCaptureHotkeyError.hidden = true
  } else {
    imageCaptureHotkeyError.textContent = t(imageHotkeyErrorKey)
    imageCaptureHotkeyError.hidden = false
  }
}

function startImageHotkeyRecording(): void {
  if (recordingImageHotkey) return
  recordingImageHotkey = true
  imageHotkeyErrorKey = null
  syncImageHotkeyField()
}

function stopImageHotkeyRecording(): void {
  if (!recordingImageHotkey) return
  recordingImageHotkey = false
  syncImageHotkeyField()
}

async function applyImageHotkey(accelerator: string): Promise<void> {
  const result = await apply({ imageCaptureHotkey: accelerator })
  imageHotkeyErrorKey =
    result.imageHotkeyFailed === true
      ? 'settings.hotkeyConflict'
      : result.settings.imageCaptureHotkey === accelerator
        ? null
        : 'settings.hotkeyInvalid'
  syncImageHotkeyField()
}

imageCaptureHotkeyBtn.addEventListener('click', startImageHotkeyRecording)
imageCaptureHotkeyBtn.addEventListener('blur', stopImageHotkeyRecording)
imageCaptureHotkeyBtn.addEventListener('keydown', (event) => {
  if (event.key === 'Tab') {
    stopImageHotkeyRecording()
    return
  }
  if (!recordingImageHotkey) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      startImageHotkeyRecording()
    }
    return
  }
  event.preventDefault()
  event.stopPropagation()
  if (event.key === 'Escape') {
    stopImageHotkeyRecording()
    return
  }
  if (event.key === 'Backspace' || event.key === 'Delete') {
    stopImageHotkeyRecording()
    void applyImageHotkey(DEFAULT_IMAGE_CAPTURE_HOTKEY)
    return
  }
  if (MODIFIER_KEYS.has(event.key)) return
  const accelerator = toAccelerator(event)
  if (accelerator === null) return
  stopImageHotkeyRecording()
  void applyImageHotkey(accelerator)
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

clipboardSelect.addEventListener('change', () => {
  void apply({ clipboardAfterSave: clipboardSelect.value as Settings['clipboardAfterSave'] })
})

imageClipboardSelect.addEventListener('change', () => {
  void apply({
    imageClipboardAfterSave: imageClipboardSelect.value as Settings['imageClipboardAfterSave'],
  })
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
// Integrations: Chrome DOM capture (GOAL "Extension Install & Management UX")
// ---------------------------------------------------------------------------

/**
 * Renders the health check as SIX FACTS, not one badge.
 *
 * "Connected ✔" tells a user nothing when it is false, and a bug report needs
 * to know WHICH of listening / registered / handshaken / compatible failed —
 * those have four different fixes. So each is its own line with its own mark,
 * and the summary above them only says how many are true.
 */
/**
 * Which step the user is on — derived from what is TRUE, never from what they
 * last clicked. Closing the window, restarting the app or loading the extension
 * from another browser all move this forward on their own, and a wizard that
 * remembered its own progress instead would disagree with the machine.
 */
function renderChromeWizard(status: ChromeIntegrationStatus): void {
  const loaded = status.detected.length > 0
  const connected = status.extensionConnected && status.protocolCompatible
  const at = connected ? 2 : loaded ? 2 : 0
  chromeSteps.forEach((li, i) => {
    li.classList.toggle('current', i === at && !connected)
    li.classList.toggle('done', connected ? true : i < at)
  })
  if (connected) {
    chromeStep3How.textContent = t('settings.chromeStep3Done', {
      version: status.extensionVersion ?? '?',
    })
  } else if (loaded) {
    const first = status.detected[0]
    chromeStep3How.textContent = t('settings.chromeStep3Waiting', {
      browser: first === undefined ? '' : first.browser,
    })
  } else {
    chromeStep3How.textContent = t('settings.chromeStep3How')
  }
}

function renderChromeStatus(status: ChromeIntegrationStatus): void {
  renderChromeWizard(status)
  const registered = status.browsers.filter((b) => b.registered)
  const checks: { ok: boolean; text: string }[] = [
    { ok: status.extensionDirExists, text: `${t('settings.chkExtensionFiles')} — ${status.extensionDir}` },
    {
      ok: status.manifestWritten,
      text: status.manifestWritten
        ? `${t('settings.chkHostManifest')} — ${status.allowedExtensionIds.join(', ') || '—'}`
        : t('settings.chkHostManifest'),
    },
    {
      ok: registered.length > 0,
      text:
        registered.length > 0
          ? `${t('settings.chkRegistered')} — ${registered.map((b) => b.label).join(', ')}`
          : t('settings.chkRegistered'),
    },
    { ok: status.listening, text: t('settings.chkListening') },
    { ok: status.hostSeen, text: t('settings.chkHostSeen') },
    {
      ok: status.extensionConnected && status.protocolCompatible,
      text: status.extensionConnected
        ? `${t('settings.chkConnected')} — ${status.extensionVersion ?? '?'}, protocol v${String(status.protocolVersion)}`
        : t('settings.chkConnected'),
    },
    // A HANDSHAKE IS NOT A PICK (#104). Every row above can be green while
    // element picking is completely dead — that is the state the bug was
    // reported in. `armed` and `never used` are both fine, so neither is a
    // failure; only a picker that could not arm is, and it says why.
    status.picker === null
      ? { ok: true, text: t('settings.chkPickerIdle') }
      : status.picker.phase === 'failed'
        ? {
            ok: false,
            text:
              `${t('settings.chkPickerFailed')} — ${status.picker.reason ?? '?'}`
              + `${status.picker.tab === null ? '' : ` (${status.picker.tab.url.slice(0, 60)})`}`,
          }
        : { ok: true, text: t('settings.chkPickerArmed') },
    {
      // Counts, not a verdict: zero picks is the normal state of a fresh run.
      ok: status.rejected === 0,
      text:
        t('settings.chkPicks', {
          picks: String(status.elementPicks),
          rejected: String(status.rejected),
        })
        + (status.lastRejection === null ? '' : ` — ${status.lastRejection}`),
    },
  ]
  // AN ALREADY-LOADED UNPACKED EXTENSION DOES NOT EXECUTE CHANGED FILES YET.
  //
  // CapturePack updates the same stable folder, but Chromium keeps the worker
  // code it already loaded. Version 0.1.7+ can ask Chromium to reload itself
  // after the app hello; getting FROM an older worker to 0.1.7 still takes one
  // manual Reload because that old code cannot implement a new instruction.
  // This visible row is that one-time migration path.
  const stale =
    status.extensionConnected &&
    status.bundledExtensionVersion !== null &&
    status.extensionVersion !== null &&
    status.extensionVersion !== status.bundledExtensionVersion
  if (stale) {
    checks.push({
      ok: false,
      text: t('settings.chkExtensionStale', {
        loaded: status.extensionVersion ?? '?',
        bundled: status.bundledExtensionVersion ?? '?',
      }),
    })
  }
  // LOADED FROM THE FOLDER AN UPDATE REPLACES. This is not a failure — it is
  // working right now — but it is one update away from not working, and from
  // the outside it looks identical to a healthy install. The row is the only
  // place that difference exists. Listed last so it never displaces a check
  // that is actually broken.
  if (status.legacyExtensionLoaded) {
    checks.push({
      ok: false,
      text: `${t('settings.chkExtensionLegacy')} — ${status.extensionDir}`,
    })
  }
  chromeChecks.replaceChildren(
    ...checks.map((c) => {
      const li = document.createElement('li')
      li.className = c.ok ? 'ok' : 'bad'
      const mark = document.createElement('span')
      mark.className = 'mark'
      mark.textContent = c.ok ? '✔' : '✖'
      const label = document.createElement('span')
      label.textContent = c.text
      li.append(mark, label)
      return li
    }),
  )
  const passed = checks.filter((c) => c.ok).length
  chromeVerdict.textContent = `${String(passed)}/${String(checks.length)}`
  // A protocol the app cannot speak is worth saying out loud rather than
  // leaving as one red line among six (GOAL: "Version Mismatch").
  if (status.extensionConnected && !status.protocolCompatible) {
    chromeVerdict.textContent = t('settings.chromeMismatch')
  } else if (status.legacyExtensionLoaded) {
    // Ahead of the stale-version verdict: reloading from the new folder fixes
    // both at once, and telling someone to update an extension they are about
    // to replace anyway is a wasted instruction.
    chromeVerdict.textContent = t('settings.chromeLegacy')
  } else if (stale) {
    // Same reasoning as the protocol verdict: the one line that says what to do
    // should not be one red row among seven.
    chromeVerdict.textContent = t('settings.chromeStale')
  }
  // The folder to load, spelled out rather than only put on the clipboard: a
  // path the user can read is a path they can reach when the button that opens
  // it for them does not work.
  chromeExtDir.textContent = status.extensionDir
  if (status.allowedExtensionIds.length > 0 && chromeExtensionId.value.trim() === '') {
    chromeExtensionId.value = status.allowedExtensionIds[0] ?? ''
  }
  const enabled = current?.chromeDomEnabled ?? true
  chromeIcon.textContent = !enabled
    ? '⚪'
    : status.extensionConnected && status.protocolCompatible
      ? '🟢'
      : '🔴'
  chromeEnabledInput.disabled = false
  if (!enabled) chromeVerdict.textContent = t('settings.chromeOff')
}

function refreshChromeStatus(): void {
  void bridge
    .chromeStatus()
    .then(renderChromeStatus)
    .catch(() => {
      chromeVerdict.textContent = t('settings.chromeUnavailable')
    })
}

chromeInstallBtn.addEventListener('click', () => {
  void (async () => {
    chromeInstallBtn.disabled = true
    try {
      renderChromeStatus(await bridge.chromeInstall(chromeExtensionId.value))
    } catch (err) {
      chromeVerdict.textContent = err instanceof Error ? err.message : String(err)
    } finally {
      chromeInstallBtn.disabled = false
    }
  })()
})

chromeUninstallBtn.addEventListener('click', () => {
  void (async () => {
    chromeUninstallBtn.disabled = true
    try {
      renderChromeStatus(await bridge.chromeUninstall())
    } finally {
      chromeUninstallBtn.disabled = false
    }
  })()
})

chromeFolderBtn.addEventListener('click', () => {
  bridge.chromeOpenFolder()
})

chromeExtPageBtn.addEventListener('click', () => {
  void (async () => {
    // One press, both errands: the page the user needs and the path they are
    // about to be asked for. And a THIRD thing if the first one fails — the
    // address is printed under the button, because a browser that could not be
    // started is not something the user can be left to guess at.
    bridge.chromeCopyPath()
    const was = chromeExtPageBtn.textContent
    chromeExtPageBtn.textContent = t('settings.chromeCopied')
    window.setTimeout(() => {
      chromeExtPageBtn.textContent = was
    }, 1400)
    const opened = await bridge.chromeOpenExtensionsPage().catch(() => null)
    chromeOpenFailed.hidden = opened !== null
  })()
})

chromeDetectBtn.addEventListener('click', () => {
  void (async () => {
    chromeDetectBtn.disabled = true
    try {
      const status = await bridge.chromeDetect()
      renderChromeStatus(status)
      if (status.detected.length === 0) {
        // Nothing found is a real answer, not a failure to report: the folder
        // has not been loaded yet, or it was loaded from somewhere else.
        chromeVerdict.textContent = t('settings.chromeNotFound')
      }
    } finally {
      chromeDetectBtn.disabled = false
    }
  })()
})

// ---------------------------------------------------------------------------
// Storage: how much the output folder holds, and getting some of it back.
// ---------------------------------------------------------------------------

const storageTotal = el<HTMLElement>('storageTotal')
const storageRow = el<HTMLElement>('storageRow')
const storageResult = el<HTMLElement>('storageResult')

function formatBytes(bytes: number): string {
  if (bytes < 1_048_576) return `${String(Math.round(bytes / 1024))} KB`
  if (bytes < 1_073_741_824) return `${String(Math.round(bytes / 1_048_576))} MB`
  return `${(bytes / 1_073_741_824).toFixed(1)} GB`
}

/**
 * Each button states its OWN consequence, and is disabled when it has none.
 *
 * A row of three ages where one of them would delete forty packs and another
 * would delete nothing looks identical until it is pressed. These read the
 * counts back from the same walk the delete will use, so the label is a
 * promise rather than a category.
 */
function renderStorage(usage: StorageUsage): void {
  storageTotal.textContent = t('settings.storageTotal', {
    packs: String(usage.totalPacks),
    size: formatBytes(usage.totalBytes),
  })
  for (const btn of storageRow.querySelectorAll<HTMLButtonElement>('[data-purge]')) {
    const days = Number(btn.dataset['purge'])
    const bucket = usage.olderThan.find((o) => o.days === days)
    const packs = bucket?.packs ?? 0
    btn.disabled = packs === 0
    btn.title = packs === 0
      ? t('settings.purgeNone')
      : t('settings.purgeCount', { packs: String(packs), size: formatBytes(bucket?.bytes ?? 0) })
  }
}

function refreshStorage(): void {
  void bridge
    .storageUsage()
    .then(renderStorage)
    .catch(() => {
      storageTotal.textContent = ''
    })
}

for (const btn of storageRow.querySelectorAll<HTMLButtonElement>('[data-purge]')) {
  btn.addEventListener('click', () => {
    void (async () => {
      const days = Number(btn.dataset['purge'])
      // ASK, WITH NUMBERS, EVERY TIME. Deleting captures is the one thing this
      // window does that the user cannot undo from here, so it never happens
      // on a single click and never happens without saying how many packs and
      // how many bytes are going. The counts are re-read first: the panel may
      // have been open for a while, and a capture taken since must be counted.
      const usage = await bridge.storageUsage().catch(() => null)
      if (usage === null) return
      renderStorage(usage)
      const bucket = usage.olderThan.find((o) => o.days === days)
      if (bucket === undefined || bucket.packs === 0) return
      // "Older than 0 days" is true and would read as a mistake, so the one
      // button that takes everything says everything. The numbers in it come
      // from the same walk as the other three.
      const ok = window.confirm(
        days === 0
          ? t('settings.purgeAllConfirm', {
              packs: String(bucket.packs),
              size: formatBytes(bucket.bytes),
            })
          : t('settings.purgeConfirm', {
              packs: String(bucket.packs),
              size: formatBytes(bucket.bytes),
              days: String(days),
            }),
      )
      if (!ok) return
      btn.disabled = true
      const result = await bridge.storagePurge(days).catch(() => null)
      storageResult.hidden = false
      storageResult.textContent =
        result === null || !result.ok
          ? t('settings.purgeFailed')
          : t('settings.purgeDone', {
              packs: String(result.packsDeleted),
              size: formatBytes(result.bytesFreed),
            })
      refreshStorage()
    })()
  })
}

chromeManualToggle.addEventListener('click', () => {
  chromeManual.hidden = !chromeManual.hidden
})

// One button per address. Selecting a path with the mouse and hitting Ctrl+C is
// a thing that works right up until the selection misses a character, and the
// consequence here is a "Load unpacked" dialog that silently opens the wrong
// folder. The clipboard write is the renderer's own — these are two strings
// this window already has, not something main has to be asked for.
for (const btn of document.querySelectorAll<HTMLButtonElement>('.copyBtn')) {
  btn.addEventListener('click', () => {
    const sourceId = btn.dataset['copy']
    if (sourceId === undefined) return
    const text = document.getElementById(sourceId)?.textContent ?? ''
    if (text === '') return
    void navigator.clipboard.writeText(text).then(() => {
      const was = btn.textContent
      btn.textContent = t('settings.copied')
      window.setTimeout(() => {
        btn.textContent = was
      }, 1200)
    })
  })
}

/**
 * Ask now, and ask HARDER than the poll does.
 *
 * The panel already re-reads its six checks every two seconds, but the poll
 * only reads — and reading is not enough after the one manual step. Loading the
 * folder gives the extension an ID this app has never seen, and until the host
 * manifest names that ID the browser refuses the connection, so the checks sit
 * at "not connected" forever with nothing on screen offering to fix it
 * ("설치했는데 연결됨이 안됨"). This runs the detect-and-register pass, which is
 * the same work step 3 does, and reports what it found.
 */
chromeRefreshBtn.addEventListener('click', () => {
  void (async () => {
    chromeRefreshBtn.disabled = true
    const was = chromeRefreshBtn.textContent
    try {
      const status = await bridge.chromeDetect()
      renderChromeStatus(status)
      if (status.detected.length === 0) chromeVerdict.textContent = t('settings.chromeNotFound')
    } catch {
      chromeVerdict.textContent = t('settings.chromeUnavailable')
    } finally {
      chromeRefreshBtn.textContent = was
      chromeRefreshBtn.disabled = false
    }
  })()
})

// Connection truth is in-memory and cheap; main caches the expensive
// registry/profile scan. Poll quickly enough that a recovered port repaints
// without a manual Refresh while keeping Secure Preferences off the hot path.
window.setInterval(() => {
  if (!document.hidden) refreshChromeStatus()
}, 1000)

refreshChromeStatus()

guideBtn.addEventListener('click', () => {
  bridge.openGuide()
})

/**
 * The first-run tutorial (GOAL "First-Run Tutorial"), as the state it is.
 *
 * It appears on the NEXT editor, never now — there is no editor open to put it
 * in, and the three gestures mean nothing outside a capture. A button could not
 * express that: it fired, the setting changed, and the panel looked exactly as
 * it had a moment earlier, which is why it was reported as doing nothing. A
 * checkbox holds the answer on screen instead, and it goes back down by itself
 * once an editor has shown the tutorial and cleared the flag.
 */
// The change handler and the load are both in the TOGGLES loop above.

// ---------------------------------------------------------------------------
// MCP: live status, restart in place, one-click client setup (issues #54, #56)

const COPIED_MS = 900

/**
 * Copies `text` and confirms it on the button itself for a beat (issue #56:
 * "both should confirm the copy happened"). A refused clipboard changes
 * nothing on screen — the URL beside the buttons stays selectable.
 */
function copyWithFeedback(button: HTMLButtonElement, label: I18nKey, text: string): void {
  if (text === '') return
  navigator.clipboard
    .writeText(text)
    .then(() => {
      button.textContent = t('settings.copied')
      window.setTimeout(() => {
        button.textContent = t(label)
      }, COPIED_MS)
    })
    .catch(() => {
      // Clipboard unavailable: nothing to report, nothing lost.
    })
}

function jsonBlock(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

/**
 * The ready-made setup for one MCP client (issue #56). EVERY form here is one
 * docs/MCP.md already documents — this surfaces what we wrote down rather than
 * inventing a second source of truth for the same configs. Client names and
 * config file paths are proper nouns and stay untranslated in every language.
 */
interface McpClientForm {
  label: string
  snippet: (url: string) => string
}

const MCP_CLIENT_FORMS: readonly McpClientForm[] = [
  {
    label: 'Claude Code',
    snippet: (url) => `claude mcp add --transport http capturepack ${url}`,
  },
  {
    label: 'Cursor — mcp.json',
    snippet: (url) => jsonBlock({ mcpServers: { capturepack: { url } } }),
  },
  {
    label: 'VS Code — .vscode/mcp.json',
    snippet: (url) => jsonBlock({ servers: { capturepack: { type: 'http', url } } }),
  },
  {
    label: 'Windsurf — mcp_config.json',
    snippet: (url) => jsonBlock({ mcpServers: { capturepack: { serverUrl: url } } }),
  },
  {
    label: 'Gemini CLI — settings.json',
    snippet: (url) => jsonBlock({ mcpServers: { capturepack: { httpUrl: url } } }),
  },
  // stdio-only clients reach the HTTP endpoint through the mcp-remote bridge.
  {
    label: 'Claude Desktop — mcp-remote',
    snippet: (url) =>
      jsonBlock({
        mcpServers: { capturepack: { command: 'npx', args: ['-y', 'mcp-remote', url] } },
      }),
  },
  {
    label: 'Codex CLI — config.toml',
    snippet: (url) =>
      `[mcp_servers.capturepack]\ncommand = "npx"\nargs = ["-y", "mcp-remote", "${url}"]`,
  },
  {
    label: 'Any stdio client — mcp-remote',
    snippet: (url) => `npx -y mcp-remote ${url}`,
  },
]

function buildClientOptions(): void {
  mcpClientSelect.replaceChildren()
  MCP_CLIENT_FORMS.forEach((form, index) => {
    const option = document.createElement('option')
    option.value = String(index)
    option.textContent = form.label
    mcpClientSelect.append(option)
  })
}

buildClientOptions()

copyUrlBtn.addEventListener('click', () => {
  copyWithFeedback(copyUrlBtn, 'settings.copy', liveEndpoint())
})

copySetupBtn.addEventListener('click', () => {
  const form = MCP_CLIENT_FORMS[Number.parseInt(mcpClientSelect.value, 10)]
  const url = liveEndpoint()
  if (form === undefined || url === '') return
  copyWithFeedback(copySetupBtn, 'settings.mcpCopySetup', form.snippet(url))
})

copyPromptBtn.addEventListener('click', () => {
  const form = MCP_CLIENT_FORMS[Number.parseInt(mcpClientSelect.value, 10)]
  const url = liveEndpoint()
  if (form === undefined || url === '') return
  // A complete handoff: selected client, the actual live endpoint, its exact
  // setup form, and the shared analyze-latest instructions.
  copyWithFeedback(
    copyPromptBtn,
    'settings.mcpCopyPrompt',
    connectAndAnalyzeLatestPrompt(form.label, url, form.snippet(url)),
  )
})

// True while a restart is in flight. renderLive() also owns the button's
// disabled state now, and a status refresh (window focus, a finished patch) can
// land mid-restart — without this flag it would re-enable the button while the
// server is still rebinding.
let mcpRestarting = false

mcpRestartBtn.addEventListener('click', () => {
  void (async () => {
    mcpRestarting = true
    mcpRestartBtn.disabled = true
    mcpRestartBtn.textContent = t('settings.mcpRestarting')
    try {
      status = await bridge.restartMcp()
    } catch {
      // Main refused the restart: ask what the state is now, so the row can
      // never be left claiming "Restarting…" as if it were an answer.
      await refreshStatus()
    } finally {
      mcpRestarting = false
      // renderLive() below applies the real rule (off => still disabled); this
      // is the guard for the one path that cannot reach it — a renderLive() that
      // returns early because no status has ever arrived must not leave the
      // button dead forever.
      mcpRestartBtn.disabled = false
      mcpRestartBtn.textContent = t('settings.mcpRestart')
    }
    renderLive()
  })()
})

const MCP_DOTS: Record<McpStatus['state'], string> = {
  running: '🟢',
  starting: '🟡',
  stopped: '⚪',
  failed: '🔴',
}

/** What the server is REALLY doing — running where, or not running and why. */
function mcpStatusText(mcp: McpStatus): string {
  if (mcp.state === 'running') return t('settings.mcpRunning', { url: mcp.endpoint })
  if (mcp.state === 'starting') return t('settings.mcpStarting')
  switch (mcp.reason) {
    case 'disabled':
      return t('settings.mcpStoppedDisabled')
    case 'autostart-off':
      return t('settings.mcpStoppedAutoStart')
    case 'port-in-use':
      // The CONFIGURED port: there is no bound one, and naming the number the
      // user typed is the only way this sentence helps them.
      return t('settings.mcpStoppedPortInUse', { port: mcp.configuredPort })
    case 'bind-failed':
      return t('settings.mcpStoppedError', { error: mcp.detail })
    default:
      return t('settings.mcpStopped')
  }
}

/** The object-picking plugin's state, from what it actually did (issue #57). */
function uiaStatusText(uia: UiaPluginStatus): string {
  switch (uia.state) {
    case 'unsupported':
      return t('settings.uiaUnsupported')
    case 'off':
      return t('settings.uiaOff')
    case 'failing':
      return uiaFailureText(uia)
    case 'active': {
      const windows = uia.lastWindows
      const controls = uia.lastControls
      // No capture yet this session: say what the plugin does rather than
      // inventing a count for something that has not run.
      if (windows === null || controls === null) return t('settings.uiaActive')
      return t(uia.lastTruncated ? 'settings.uiaActiveLastPartial' : 'settings.uiaActiveLast', {
        windows,
        controls,
      })
    }
  }
}

function uiaFailureText(uia: UiaPluginStatus): string {
  switch (uia.reason) {
    case 'no-helper':
      return t('settings.uiaFailNoHelper')
    case 'spawn-failed':
      return t('settings.uiaFailSpawn')
    case 'policy':
      return t('settings.uiaFailPolicy')
    case 'budget':
      return t('settings.uiaFailBudget')
    default:
      return t('settings.uiaFailNoOutput')
  }
}

/** Repaints everything driven by LIVE state: status rows and restart hints. */
function renderLive(): void {
  if (status === null) return
  const mcp = status.mcp
  mcpDot.textContent = MCP_DOTS[mcp.state]
  mcpStateEl.textContent = mcpStatusText(mcp)
  mcpStateEl.classList.toggle('running', mcp.state === 'running')
  mcpStateEl.classList.toggle('failed', mcp.state === 'failed')
  // An endpoint nothing is listening on is never offered for copying — a
  // pasted dead URL is worse than no button at all (issue #56).
  mcpUrlEl.textContent = mcp.endpoint === '' ? '—' : mcp.endpoint
  mcpUrlEl.title = mcp.endpoint
  copyUrlBtn.disabled = mcp.endpoint === ''
  copySetupBtn.disabled = mcp.endpoint === ''
  copyPromptBtn.disabled = mcp.endpoint === ''
  // [Restart] has nothing to restart while the server is switched off, and a
  // button that can only ever answer "still off" is the kind of empty
  // affordance this release is removing. The switch above is the Stop/Start;
  // this button applies a changed port / watch folder to a server that may run.
  mcpRestartBtn.disabled = mcpRestarting || (current !== null && !current.mcpEnabled)

  const uia = status.uia
  uiaIcon.textContent = uia.state === 'active' ? '🟢' : uia.state === 'failing' ? '🔴' : '⚪'
  uiaStatusEl.textContent = uiaStatusText(uia)
  // A plugin that cannot exist on this platform cannot be switched on either.
  uiaEnabledInput.disabled = uia.state === 'unsupported'

  updateHints()
  pollWhileStarting()
}

// The socket binds asynchronously, so a settings window opened right at startup
// can genuinely catch the server mid-bind. Ask once more shortly after instead
// of leaving "Starting…" on screen as if it were the final answer.
const STARTING_POLL_MS = 600
let startingPoll: number | null = null

function pollWhileStarting(): void {
  if (status?.mcp.state !== 'starting') return
  if (startingPoll !== null) return
  startingPoll = window.setTimeout(() => {
    startingPoll = null
    void refreshStatus()
  }, STARTING_POLL_MS)
}

// Reality moves while this window sits open — a capture runs the object dump, a
// port frees up. Coming back to the window is exactly when its claims are read
// again, so that is when they are re-checked.
window.addEventListener('focus', () => {
  void refreshStatus()
  refreshChromeStatus()
  // The folder grew while this window was in the background if a capture ran.
  refreshStorage()
})

refreshStorage()

// Help and operational detail are deliberately separate disclosures. Asking
// what a plugin does must never also open/close Chrome's setup workflow, and
// status polling must never overwrite the user's fold state.
function bindDisclosure(button: HTMLButtonElement, panel: HTMLElement): void {
  button.addEventListener('click', () => {
    const open = panel.hidden
    panel.hidden = !open
    button.setAttribute('aria-expanded', String(open))
  })
}

bindDisclosure(uiaHelpBtn, uiaHelpEl)
bindDisclosure(uiaFoldBtn, uiaDetailPanel)
bindDisclosure(chromeHelpBtn, chromeHelpEl)
bindDisclosure(chromeFoldBtn, chromeDetailPanel)

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
  clipboardSelect.value = s.clipboardAfterSave
  imageClipboardSelect.value = s.imageClipboardAfterSave
  replayMaxWidthSelect.value = String(s.replayMaxWidth)
  syncHotkeyField()
  syncImageHotkeyField()
  languageSelect.value = s.language
  packLanguageSelect.value = s.packLanguage
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
  displays = data.displays
  status = data.status
  systemLanguage = data.systemLanguage
  appVersion = data.appVersion
  refreshLanguage()
  syncControls()
  // refreshLanguage() already rendered the live rows and hints from `status`;
  // syncControls() cannot change either, so nothing more is needed here.
}

void hydrate()
