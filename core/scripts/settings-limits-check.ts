// Settings regressions that must stay runnable without Electron.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  clearOutputDirOverride,
  loadSettings,
  persistSettings,
  readSettings,
  settingsFilePath,
} from '../src/main/settings'
import {
  CAPTURE_FPS_PRESETS,
  DEFAULT_CAPTURE_FPS,
  MAX_CAPTURE_FPS,
  MIN_CAPTURE_FPS,
  normalizeCaptureFps,
} from '../src/shared/types'
import { connectAndAnalyzeLatestPrompt } from '../src/shared/prompt'

let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (!condition) failed += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

console.log('CAPTURE FPS')
check('minimum is 5', MIN_CAPTURE_FPS === 5)
check('maximum is 60', MAX_CAPTURE_FPS === 60)
check('default is 20', DEFAULT_CAPTURE_FPS === 20)
check('presets are 10/15/20/30/60', CAPTURE_FPS_PRESETS.join('/') === '10/15/20/30/60')
check('every preset survives normalization', CAPTURE_FPS_PRESETS.every((fps) => normalizeCaptureFps(fps) === fps))
check('a 120 fps profile normalizes to 60', normalizeCaptureFps(120) === 60)
check('60 stays 60', normalizeCaptureFps(60) === 60)
check('30 stays 30', normalizeCaptureFps(30) === 30)
check('missing input falls back to the 20 fps default', normalizeCaptureFps(undefined) === 20)
check('an older 1 fps profile migrates to 5', normalizeCaptureFps(1) === 5)
check('an older 4 fps profile migrates to 5', normalizeCaptureFps(4) === 5)
check('a positive fraction rounds and clamps onto the integer grid', normalizeCaptureFps(0.2) === 5)
check('zero preserves the current valid value', normalizeCaptureFps(0, 12) === 12)
check('non-finite input preserves the current valid value', normalizeCaptureFps(Infinity, 12) === 12)

const captureSettingsHtml = readFileSync(
  path.join(process.cwd(), 'src/renderer/settings/settings.html'),
  'utf8',
)
const captureSettingsStore = readFileSync(
  path.join(process.cwd(), 'src/main/settings.ts'),
  'utf8',
)
check(
  'the Settings numeric input advertises the same 5..60 contract',
  /id="fps"\s+min="5"\s+max="60"/u.test(captureSettingsHtml),
)
check(
  'the Settings fps input offers the 10/15/20/30/60 presets',
  CAPTURE_FPS_PRESETS.every((fps) => new RegExp(`id="fpsPresets"[^]*?<option value="${fps}">`, 'u').test(captureSettingsHtml)),
)
check(
  'IPC settings patches and loaded profiles share the normalizer',
  captureSettingsStore.includes('return mergeSettings(current, raw)') &&
    captureSettingsStore.includes('fps: normalizeCaptureFps(raw.fps, base.fps)'),
)

// settings.json is the primary configuration store. Writing it in place
// truncates the last valid profile before the replacement is complete, so a
// crash in that gap can turn the next launch into a silent factory reset.
console.log('\nTHE SETTINGS FILE IS REPLACED ATOMICALLY')
{
  const normalized = captureSettingsStore.split('\r\n').join('\n')
  const withoutComments = normalized
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart()
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return ''
      const marker = line.indexOf('//')
      return marker < 0 ? line : line.slice(0, marker)
    })
    .join('\n')
  const start = withoutComments.indexOf('export function saveSettings(')
  const end = withoutComments.indexOf('\n}\n', start)
  const saveSettingsBody = withoutComments.slice(start, end < 0 ? undefined : end)

  check('saveSettings remains available as the settings serialization boundary', start >= 0 && end > start)
  check(
    'saveSettings writes a sibling temporary file and renames it over settings.json',
    saveSettingsBody.includes('const file = settingsFilePath()')
      && saveSettingsBody.includes('const temporary = `${file}.tmp`')
      && saveSettingsBody.includes('fs.writeFileSync(temporary, JSON.stringify(settings')
      && saveSettingsBody.includes('fs.renameSync(temporary, file)'),
  )
  check(
    'the atomic rename happens after the temporary file is fully written',
    saveSettingsBody.indexOf('fs.writeFileSync(temporary')
      < saveSettingsBody.indexOf('fs.renameSync(temporary, file)'),
  )
  check(
    'saveSettings never writes directly to settings.json',
    !saveSettingsBody.includes('fs.writeFileSync(file,')
      && !saveSettingsBody.includes('fs.writeFileSync(settingsFilePath()'),
  )
  check(
    'the only settings write targets the temporary file',
    (saveSettingsBody.match(/fs\.writeFileSync\(/gu) ?? []).length === 1
      && saveSettingsBody.includes('fs.writeFileSync(temporary,'),
    String((saveSettingsBody.match(/fs\.writeFileSync\(/gu) ?? []).length),
  )
}

console.log('\nINDEPENDENT CAPTURE SHORTCUTS')
const settingsHtmlForHotkeys = readFileSync(
  path.join(process.cwd(), 'src/renderer/settings/settings.html'),
  'utf8',
)
const settingsRendererForHotkeys = readFileSync(
  path.join(process.cwd(), 'src/renderer/settings/settings.ts'),
  'utf8',
)
const settingsMainForHotkeys = readFileSync(
  path.join(process.cwd(), 'src/main/settingsWindow.ts'),
  'utf8',
)
check(
  'video and image shortcuts have separate recordable fields',
  settingsHtmlForHotkeys.includes('id="captureHotkeyBtn"') &&
    settingsHtmlForHotkeys.includes('id="imageCaptureHotkeyBtn"'),
)
check(
  'image shortcut defaults to Ctrl+Alt+S and is persisted independently',
  settingsRendererForHotkeys.includes('DEFAULT_IMAGE_CAPTURE_HOTKEY') &&
    settingsRendererForHotkeys.includes('apply({ imageCaptureHotkey: accelerator })'),
)
check(
  'a failed image registration is reported beside only the image field',
  settingsMainForHotkeys.includes('imageHotkeyFailed') &&
    settingsMainForHotkeys.includes('currentImageCaptureHotkey()') &&
    settingsMainForHotkeys.includes('registerImageCaptureHotkey('),
)

console.log('\nMCP COPY PROMPT')
const endpoint = 'http://127.0.0.1:39393/mcp'
const setup = `claude mcp add --transport http capturepack ${endpoint}`
const prompt = connectAndAnalyzeLatestPrompt('Claude Code', endpoint, setup)
check('includes the selected client', prompt.includes('Client: Claude Code'))
check('includes the live endpoint', prompt.includes(`Endpoint: ${endpoint}`))
check('includes the exact setup command', prompt.includes(setup))
check('still asks for capturepack_latest', prompt.includes('capturepack_latest'))

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

function sectionContaining(html: string, headingId: string): string {
  const headingAt = html.indexOf(`id="${headingId}"`)
  if (headingAt < 0) return ''
  const start = html.lastIndexOf('<section', headingAt)
  const end = html.indexOf('</section>', headingAt)
  return start < 0 || end < 0 ? '' : html.slice(start, end + '</section>'.length)
}

function startTagById(html: string, id: string): string {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return html.match(new RegExp(`<[^>]+\\bid="${escapedId}"[^>]*>`))?.[0] ?? ''
}

function attribute(tag: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return tag.match(new RegExp(`\\b${escapedName}="([^"]*)"`))?.[1] ?? ''
}

console.log('\nPLUGIN MANAGER UI')
const settingsHtml = source('src/renderer/settings/settings.html')
const settingsRenderer = source('src/renderer/settings/settings.ts')
const settingsStore = source('src/main/settings.ts')
const settingsWindow = source('src/main/settingsWindow.ts')
const sharedTypes = source('src/shared/types.ts')
const i18nSource = source('src/shared/i18n.ts')
const pluginsSection = sectionContaining(settingsHtml, 'hPlugins')

check('Plugins section exists', pluginsSection !== '')
check(
  'Windows UI Automation and Chrome DOM are peer plugin entries',
  (pluginsSection.match(/<article\b[^>]*\bclass="pluginEntry"[^>]*>/g) ?? []).length === 2 &&
    pluginsSection.includes('id="uiaName"') &&
    pluginsSection.includes('id="chromeName"'),
)
check(
  'UIA copy discloses resident background tracking and the OFF cleanup',
  pluginsSection.includes('local background helper') &&
    pluginsSection.includes('Turning it off stops the helper') &&
    (i18nSource.match(/'settings\.uiaSummary':/g) ?? []).length === 9 &&
    (i18nSource.match(/'settings\.uiaDetail':/g) ?? []).length === 9 &&
    !i18nSource.includes('costs a sub-second helper run per capture') &&
    !i18nSource.includes('캡처마다 1초 미만의 헬퍼 실행') &&
    !i18nSource.includes('キャプチャごとに 1 秒未満のヘルパー'),
)
check(
  'Chrome DOM is not left in a separate Integrations section',
  !settingsHtml.includes('id="hIntegrations"'),
)

for (const plugin of ['uia', 'chrome'] as const) {
  const helpButton = startTagById(settingsHtml, `${plugin}HelpBtn`)
  const foldButton = startTagById(settingsHtml, `${plugin}FoldBtn`)
  const helpTarget = attribute(helpButton, 'aria-controls')
  const foldTarget = attribute(foldButton, 'aria-controls')
  check(
    `${plugin} has separate help and fold buttons`,
    helpButton.includes('pluginHelp') &&
      foldButton.includes('pluginFold') &&
      helpTarget !== '' &&
      foldTarget !== '' &&
      helpTarget !== foldTarget,
  )
  check(
    `${plugin} help and fold buttons own real, separate panels`,
    pluginsSection.includes(`id="${helpTarget}"`) &&
      pluginsSection.includes(`id="${foldTarget}"`) &&
      settingsRenderer.includes(`bindDisclosure(${plugin}HelpBtn, ${plugin}HelpEl)`) &&
      settingsRenderer.includes(`bindDisclosure(${plugin}FoldBtn, ${plugin}DetailPanel)`),
  )
}

const chromeFoldButton = startTagById(settingsHtml, 'chromeFoldBtn')
const chromeDetailPanel = startTagById(settingsHtml, 'chromeDetailPanel')
check(
  'Chrome operational details start collapsed',
  attribute(chromeFoldButton, 'aria-expanded') === 'false' &&
    /\shidden(?:\s|>)/.test(chromeDetailPanel),
)

const togglesBlock =
  settingsRenderer.match(
    /const TOGGLES:[\s\S]*?=\s*\[([\s\S]*?)\n\]/,
  )?.[1] ?? ''
check(
  'Chrome checkbox is wired through the renderer settings toggle path',
  settingsHtml.includes('id="chromeDomEnabled"') &&
    togglesBlock.includes("'chromeDomEnabled'") &&
    settingsRenderer.includes('void apply({ [key]: input.checked } as SettingsPatch)'),
)
check(
  'Chrome enable state is typed, defaulted, and restored from disk',
  /chromeDomEnabled:\s*boolean/.test(sharedTypes) &&
    /chromeDomEnabled:\s*true/.test(settingsStore) &&
    /typeof raw\.chromeDomEnabled === 'boolean'/.test(settingsStore),
)
check(
  'Chrome enable changes start or stop the live DOM bridge',
  settingsWindow.includes('live.chromeDomEnabled !== before.chromeDomEnabled') &&
    settingsWindow.includes('startDomBridge()') &&
    settingsWindow.includes('stopDomBridge()'),
)

interface FsHooks {
  readFileSync: ((proceed: () => string | Buffer, file: unknown) => string | Buffer) | null
  existsSync: ((proceed: () => boolean, file: unknown) => boolean) | null
  lstatSync: ((proceed: () => unknown, file: unknown) => unknown) | null
}

function fsHooks(): FsHooks {
  const hooks = (globalThis as { __capturepackFsHooks?: FsHooks }).__capturepackFsHooks
  if (hooks === undefined) {
    throw new Error('settings-limits-check.mjs must provide __capturepackFsHooks')
  }
  return hooks
}

function resetFsHooks(): void {
  const hooks = fsHooks()
  hooks.readFileSync = null
  hooks.existsSync = null
  hooks.lstatSync = null
}

function errnoError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code })
}

function withProfileEnv<T>(argvExtra: readonly string[], fn: (dirs: { root: string; userData: string; desktop: string }) => T): T {
  const root = mkdtempSync(path.join(tmpdir(), 'capturepack-settings-behavior-'))
  const userData = path.join(root, 'user-data')
  const desktop = path.join(root, 'desktop')
  const prevUserData = process.env.CAPTUREPACK_TEST_USER_DATA
  const prevDesktop = process.env.CAPTUREPACK_TEST_DESKTOP
  const prevArgv = [...process.argv]
  process.env.CAPTUREPACK_TEST_USER_DATA = userData
  process.env.CAPTUREPACK_TEST_DESKTOP = desktop
  process.argv = [...prevArgv.filter((arg) => !arg.startsWith('--output-dir=')), ...argvExtra]
  try {
    return fn({ root, userData, desktop })
  } finally {
    resetFsHooks()
    process.argv = prevArgv
    if (prevUserData === undefined) delete process.env.CAPTUREPACK_TEST_USER_DATA
    else process.env.CAPTUREPACK_TEST_USER_DATA = prevUserData
    if (prevDesktop === undefined) delete process.env.CAPTUREPACK_TEST_DESKTOP
    else process.env.CAPTUREPACK_TEST_DESKTOP = prevDesktop
    rmSync(root, { recursive: true, force: true })
  }
}

function withTargetReadFailure(
  targetFile: string,
  code: string,
  options: { hideFromExistsSync: boolean; failLstat: boolean },
  fn: () => void,
): void {
  const resolvedTarget = path.resolve(targetFile)
  const hooks = fsHooks()
  hooks.readFileSync = (proceed, file) => {
    if (path.resolve(String(file)) === resolvedTarget) {
      throw errnoError(code, `${code}: simulated read failure for ${resolvedTarget}`)
    }
    return proceed()
  }
  hooks.existsSync = (proceed, file) => {
    if (options.hideFromExistsSync && path.resolve(String(file)) === resolvedTarget) {
      return false
    }
    return proceed()
  }
  hooks.lstatSync = (proceed, file) => {
    if (options.failLstat && path.resolve(String(file)) === resolvedTarget) {
      throw errnoError(code, `${code}: simulated lstat failure for ${resolvedTarget}`)
    }
    return proceed()
  }
  try {
    fn()
  } finally {
    resetFsHooks()
  }
}

console.log('\nSETTINGS PRESERVATION ON UNREADABLE OR CORRUPT FILES')
withProfileEnv([], ({ desktop }) => {
  const loaded = loadSettings()
  const onDisk = JSON.parse(readFileSync(settingsFilePath(), 'utf8')) as Record<string, unknown>
  check(
    'a missing settings.json reports firstRun=true and writes default settings',
    loaded.firstRun === true &&
      existsSync(settingsFilePath()) &&
      onDisk.fps === DEFAULT_CAPTURE_FPS &&
      onDisk.welcomeShown === false &&
      onDisk.outputDir === path.join(desktop, 'CapturePack'),
  )
})

for (const failure of [
  { label: 'EBUSY lock', code: 'EBUSY' },
  { label: 'EACCES permission error', code: 'EACCES' },
]) {
  withProfileEnv([], ({ userData }) => {
    mkdirSync(userData, { recursive: true })
    const original = '{"fps":29,"outputDir":"C:\\\\Users\\\\Test\\\\CustomCaptures","welcomeShown":true}\n'
    const file = settingsFilePath()
    writeFileSync(file, original, 'utf8')

    let loaded!: ReturnType<typeof loadSettings>
    withTargetReadFailure(
      file,
      failure.code,
      { hideFromExistsSync: true, failLstat: true },
      () => {
        loaded = loadSettings()
      },
    )

    check(
      `${failure.label} does not mistake existing settings.json for firstRun`,
      loaded.firstRun === false && loaded.settings.fps === DEFAULT_CAPTURE_FPS,
    )
    check(
      `${failure.label} leaves original settings.json untouched on startup`,
      readFileSync(file, 'utf8') === original,
    )

    persistSettings({
      ...loaded.settings,
      recordingEnabled: false,
      showEditorTutorial: false,
      showShortcutOverlay: false,
      welcomeShown: true,
      editorWindowBounds: { x: 10, y: 20, width: 800, height: 600 },
      fps: 24,
    })
    check(
      `${failure.label} preserves original settings.json across runtime persistSettings even after lock clears`,
      readFileSync(file, 'utf8') === original,
    )

    // Mid-run readSettings() (used by saveToast) reads the unlocked file
    // without cancelling startup preservation for the initial defaults object.
    const midRun = readSettings()
    persistSettings({ ...loaded.settings, recordingEnabled: false })
    check(
      `${failure.label} mid-run readSettings reads current disk values without clearing startup preservation`,
      midRun.fps === 29 && readFileSync(file, 'utf8') === original,
    )
  })
}

withProfileEnv([], ({ userData }) => {
  mkdirSync(userData, { recursive: true })
  const dirAsSettings = settingsFilePath()
  mkdirSync(dirAsSettings)
  const loaded = loadSettings()
  check(
    'a real unreadable entry (directory at settings.json) reports firstRun=false without crashing',
    loaded.firstRun === false && loaded.settings.fps === DEFAULT_CAPTURE_FPS,
  )
  let persistThrew = false
  try {
    persistSettings({ ...loaded.settings, fps: 24 })
  } catch {
    persistThrew = true
  }
  check(
    'persistSettings skips overwriting a real unreadable entry instead of failing or staging .tmp',
    !persistThrew && existsSync(dirAsSettings) && !existsSync(`${dirAsSettings}.tmp`),
  )
})

for (const malformed of [
  { label: 'malformed JSON', body: '{"fps": 24, "outputDir": "D:\\\\Saved", broken' },
  { label: 'non-object JSON array', body: '[1, 2, 3]' },
]) {
  withProfileEnv([], () => {
    mkdirSync(path.dirname(settingsFilePath()), { recursive: true })
    const file = settingsFilePath()
    writeFileSync(file, malformed.body, 'utf8')
    const loaded = loadSettings()
    check(
      `${malformed.label} reports firstRun=false and preserves disk bytes on startup`,
      loaded.firstRun === false &&
        loaded.settings.fps === DEFAULT_CAPTURE_FPS &&
        readFileSync(file, 'utf8') === malformed.body,
    )

    persistSettings({
      ...loaded.settings,
      recordingEnabled: false,
      showEditorTutorial: false,
      showShortcutOverlay: false,
      welcomeShown: true,
      editorWindowBounds: { x: 10, y: 20, width: 800, height: 600 },
      fps: 24,
    })
    check(
      `${malformed.label} stays preserved across editor/tray/welcome/settings persistSettings calls`,
      readFileSync(file, 'utf8') === malformed.body,
    )

    unlinkSync(file)
    persistSettings({
      ...loaded.settings,
      fps: 24,
      showShortcutOverlay: false,
    })
    const saved = existsSync(file)
      ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)
      : null
    check(
      `${malformed.label} resumes normal saving after the user deletes the preserved file`,
      saved !== null && saved.fps === 24 && saved.showShortcutOverlay === false,
    )

    persistSettings({
      ...loaded.settings,
      fps: 28,
      showShortcutOverlay: false,
    })
    const updated = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    check(
      `${malformed.label} continues saving subsequent changes normally`,
      updated.fps === 28,
    )
  })
}

withProfileEnv(['--output-dir=/tmp/capturepack-cli-override'], ({ root, desktop }) => {
  const overridePath = path.resolve('/tmp/capturepack-cli-override')
  const persistedOut = path.join(root, 'persisted-packs')
  const explicitOut = path.join(root, 'explicit-packs')
  mkdirSync(path.dirname(settingsFilePath()), { recursive: true })
  const file = settingsFilePath()
  writeFileSync(
    file,
    `\uFEFF${JSON.stringify({ settingsVersion: 3, fps: 24, outputDir: persistedOut, futurePluginFlag: 'keep-me' })}`,
    'utf8',
  )
  const loaded = loadSettings()
  const afterLoad = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  check(
    'normal BOM profile loads unknown fields, sets firstRun=false, and keeps --output-dir out of disk',
    loaded.firstRun === false &&
      loaded.settings.fps === 24 &&
      loaded.settings.outputDir === overridePath &&
      Reflect.get(loaded.settings, 'futurePluginFlag') === 'keep-me' &&
      afterLoad.outputDir === persistedOut,
  )

  persistSettings({ ...loaded.settings, replaySeconds: 45 })
  const afterPersist = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  check(
    'persistSettings keeps on-disk outputDir while --output-dir override is active',
    afterPersist.replaySeconds === 45 &&
      afterPersist.outputDir === persistedOut &&
      afterPersist.futurePluginFlag === 'keep-me',
  )

  clearOutputDirOverride()
  persistSettings({ ...loaded.settings, outputDir: explicitOut })
  const afterExplicit = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  check(
    'explicit outputDir change after clearOutputDirOverride persists to disk',
    afterExplicit.outputDir === explicitOut,
  )

  // With --output-dir still active via argv on a new load, deleting a preserved
  // corrupt file falls back to the default outputDir instead of persisting the override.
  process.argv = [...process.argv.filter((arg) => !arg.startsWith('--output-dir=')), '--output-dir=/tmp/capturepack-cli-override']
  writeFileSync(file, '{corrupt', 'utf8')
  const corruptLoaded = loadSettings()
  persistSettings({ ...corruptLoaded.settings, fps: 22 })
  check(
    '--output-dir run preserves corrupt file on persistSettings while it exists',
    readFileSync(file, 'utf8') === '{corrupt',
  )
  unlinkSync(file)
  persistSettings({ ...corruptLoaded.settings, fps: 22 })
  const afterDelete = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  check(
    'deleting a preserved corrupt file under --output-dir writes default outputDir instead of override',
    afterDelete.fps === 22 && afterDelete.outputDir === path.join(desktop, 'CapturePack'),
  )
})

withProfileEnv([], () => {
  mkdirSync(path.dirname(settingsFilePath()), { recursive: true })
  const file = settingsFilePath()
  writeFileSync(file, '   \n', 'utf8')
  const loaded = loadSettings()
  const repaired = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  check(
    'an empty/whitespace settings.json is not firstRun and initializes default JSON',
    loaded.firstRun === false && repaired.fps === 20,
  )
})

for (const fpsCase of [
  { label: 'a v2 profile on the old 15 fps default moves to 20', stored: { settingsVersion: 2, fps: 15 }, fps: 20 },
  { label: 'an unversioned profile on 15 fps moves to 20', stored: { fps: 15 }, fps: 20 },
  { label: 'a v2 profile with a chosen 24 fps keeps it', stored: { settingsVersion: 2, fps: 24 }, fps: 24 },
  { label: 'a v3 profile with 15 fps is a choice and stays', stored: { settingsVersion: 3, fps: 15 }, fps: 15 },
]) {
  withProfileEnv([], () => {
    mkdirSync(path.dirname(settingsFilePath()), { recursive: true })
    const file = settingsFilePath()
    writeFileSync(file, JSON.stringify(fpsCase.stored), 'utf8')
    const loaded = loadSettings()
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    check(
      fpsCase.label,
      loaded.settings.fps === fpsCase.fps && onDisk.settingsVersion === 3,
      `fps=${loaded.settings.fps} disk=${String(onDisk.settingsVersion)}`,
    )
  })
}

if (failed > 0) {
  console.error(`\nsettings-limits-check failed: ${failed}`)
  process.exitCode = 1
} else {
  console.log('\nsettings-limits-check ok')
}
