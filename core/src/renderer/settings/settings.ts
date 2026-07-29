// Settings window renderer: loads current settings through the preload bridge,
// saves every change immediately on input (no Save button), clamps out-of-range
// numbers on commit with a brief highlight, and shows inline "press Restart to
// apply" hints for the MCP keys the running server has not picked up yet.
//
// Two things in this window are LIVE rather than configured (issues #54, #57):
// whether the MCP server is actually listening, and what the Windows UI
// Automation plugin actually did on the last capture. Both come from
// bridge.status() and are re-read after every change and on window focus,
// because both move while the window is open.
import type {
  ChromeIntegrationStatus,
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
import { analyzeLatestPrompt } from '../../shared/prompt'
import { DEFAULT_CAPTURE_HOTKEY } from '../../shared/types'
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
const showTutorialBtn = el<HTMLButtonElement>('showTutorialBtn')
const chromeVerdict = el<HTMLElement>('chromeVerdict')
const chromeChecks = el<HTMLUListElement>('chromeChecks')
const chromeExtensionId = el<HTMLInputElement>('chromeExtensionId')
const chromeInstallBtn = el<HTMLButtonElement>('chromeInstallBtn')
const chromeFolderBtn = el<HTMLButtonElement>('chromeFolderBtn')
const chromeUninstallBtn = el<HTMLButtonElement>('chromeUninstallBtn')
const captureDisplaySelect = el<HTMLSelectElement>('captureDisplay')
const captureHotkeyBtn = el<HTMLButtonElement>('captureHotkeyBtn')
const captureHotkeyHint = el<HTMLElement>('captureHotkeyHint')
const captureHotkeyRecordHint = el<HTMLElement>('captureHotkeyRecordHint')
const captureHotkeyError = el<HTMLElement>('captureHotkeyError')
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
const uiaDetailEl = el<HTMLElement>('uiaDetail')
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
  syncHotkeyField()
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
 * outputDir is here because the server indexes that folder, which is what its
 * hint says.
 */
const MCP_HINTED_KEYS = ['outputDir', 'mcpPort', 'mcpWatchExportFolder'] as const

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
  'copyToClipboard',
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
  // The Plugins row's real on/off (issue #57) — applies to the NEXT capture
  // with no restart of anything, because the capture flow reads it at trigger.
  'uiaEnabled',
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
function renderChromeStatus(status: ChromeIntegrationStatus): void {
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
  ]
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
  }
  if (status.allowedExtensionIds.length > 0 && chromeExtensionId.value.trim() === '') {
    chromeExtensionId.value = status.allowedExtensionIds[0] ?? ''
  }
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

refreshChromeStatus()

guideBtn.addEventListener('click', () => {
  bridge.openGuide()
})

/**
 * Arms the first-run tutorial again (GOAL "First-Run Tutorial").
 *
 * It appears on the NEXT editor, not now — there is no editor open to put it
 * in, and a capture is the only place the three gestures mean anything. The
 * button says so by going quiet for a moment rather than pretending nothing
 * happened.
 */
showTutorialBtn.addEventListener('click', () => {
  void (async () => {
    showTutorialBtn.disabled = true
    try {
      await bridge.set({ showEditorTutorial: true })
    } finally {
      window.setTimeout(() => {
        showTutorialBtn.disabled = false
      }, 900)
    }
  })()
})

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
  // The same instructions the save toast's Copy Prompt carries (shared/prompt),
  // so the two can never drift; English on purpose, like that one.
  //
  // Unlike its two neighbours this button is never disabled, and GOAL says so:
  // the sentence names no endpoint, so there is nothing in it that a dead socket
  // could make wrong. The client it is pasted into is what knows where the
  // server is — and a user whose server is down still has a use for it, namely
  // pasting it after switching the server back on.
  copyWithFeedback(copyPromptBtn, 'settings.mcpCopyPrompt', analyzeLatestPrompt())
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
})

// The "?" affordance (issue #57): reveal the long explanation of what the
// plugin does and what it costs, right under its row.
uiaHelpBtn.addEventListener('click', () => {
  const open = uiaDetailEl.hidden
  uiaDetailEl.hidden = !open
  uiaHelpBtn.setAttribute('aria-expanded', String(open))
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
  replayMaxWidthSelect.value = String(s.replayMaxWidth)
  syncHotkeyField()
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
