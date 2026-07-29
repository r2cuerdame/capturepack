// Settings regressions that must stay runnable without Electron.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
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
check('minimum is 1', MIN_CAPTURE_FPS === 1)
check('maximum is 30', MAX_CAPTURE_FPS === 30)
check('an older 60 fps profile normalizes to 30', normalizeCaptureFps(60) === 30)
check('30 stays 30', normalizeCaptureFps(30) === 30)
check('a positive fraction rounds and clamps onto the integer grid', normalizeCaptureFps(0.2) === 1)
check('zero preserves the current valid value', normalizeCaptureFps(0, 12) === 12)
check('non-finite input preserves the current valid value', normalizeCaptureFps(Infinity, 12) === 12)

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

if (failed > 0) {
  console.error(`\nsettings-limits-check failed: ${failed}`)
  process.exitCode = 1
} else {
  console.log('\nsettings-limits-check ok')
}
