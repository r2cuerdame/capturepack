// Repeatable, dependency-free QA for the product-facing landing surface.
//
// It exercises every locale through the same client-side apply() path the page
// uses, then checks that the hero demo keeps showing the five differentiating
// product facts. Run from the repository root with:
//   node site/validate.mjs
import fs from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const siteDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(siteDir)
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')

const html = read('site/index.html')
const i18n = read('site/i18n.js')
const svg = read('site/assets/demo.svg')
const readme = read('README.md')
const guideHtml = read('site/guide/index.html')
const guideI18n = read('site/guide/guide-i18n.js')
const roadmap = read('ROADMAP.md')
const changelog = read('CHANGELOG.md')
const releasing = read('docs/RELEASING.md')
const codeSigning = read('docs/CODE_SIGNING.md')
const mcpDocs = read('docs/MCP.md')
const qaDocs = read('docs/QA.md')
const handoff = read('docs/HANDOFF.md')
const dependencyAudit = read('docs/DEPENDENCY-AUDIT-0.3.1.md')
const releaseWorkflow = read('.github/workflows/release.yml')
const annotationsSchema = JSON.parse(read('docs/schemas/annotations.schema.json'))
const manifestSchemaText = read('docs/schemas/manifest.schema.json')
const spec = read('SPEC.md')
const packageJson = JSON.parse(read('core/package.json'))
const packageLock = JSON.parse(read('core/package-lock.json'))
const supported = ['en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru']
const localizedReadmes = supported
  .filter((lang) => lang !== 'en')
  .map((lang) => ({ lang, text: read(`README.${lang}.md`) }))
const derivedReadmeMarkers = {
  ko: '매니페스트 선언 시에만',
  ja: 'マニフェスト宣言時のみ',
  zh: '仅在清单声明时存在',
  es: 'solo si el manifest lo declara',
  fr: 'si le manifest le déclare',
  de: 'nur bei Manifest-Deklaration',
  pt: 'só se declarado no manifesto',
  ru: 'только если объявлен в manifest',
}

let passed = 0
let failed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const textKeys = [...new Set([...html.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1]))]
const altKeys = [...new Set([...html.matchAll(/data-i18n-alt="([^"]+)"/g)].map((match) => match[1]))]

console.log('\nLanding translations')
for (const lang of supported) {
  const textNodes = textKeys.map((key) => ({
    innerHTML: '',
    getAttribute(name) {
      return name === 'data-i18n' ? key : null
    },
  }))
  const altNodes = altKeys.map((key) => ({
    alt: '',
    getAttribute(name) {
      return name === 'data-i18n-alt' ? key : null
    },
    setAttribute(name, value) {
      if (name === 'alt') this.alt = value
    },
  }))
  let onChange = null
  const select = {
    value: lang,
    addEventListener(type, callback) {
      if (type === 'change') onChange = callback
    },
  }
  const document = {
    documentElement: { lang: 'en' },
    querySelectorAll(selector) {
      return selector === '[data-i18n-alt]' ? altNodes : textNodes
    },
    getElementById(id) {
      return id === 'langSel' ? select : null
    },
  }
  vm.runInNewContext(i18n, {
    document,
    navigator: { language: lang },
    localStorage: { getItem: () => lang, setItem() {} },
  })
  // English is the markup fallback on first load, but selecting English after
  // another language must still exercise DICT.en.
  if (lang === 'en') onChange?.()
  const missingText = textKeys.filter((_key, index) => textNodes[index]?.innerHTML === '')
  const missingAlt = altKeys.filter((_key, index) => altNodes[index]?.alt === '')
  const releaseNote = textNodes[textKeys.indexOf('release_note')]?.innerHTML ?? ''
  check(
    `${lang}: ${textKeys.length + altKeys.length} rendered strings`,
    missingText.length === 0
      && missingAlt.length === 0
      && document.documentElement.lang === lang
      && releaseNote.includes('0.3.0')
      && releaseNote.includes('0.3.1'),
    [...missingText, ...missingAlt].join(', '),
  )
}

const guideKeys = [...new Set([...guideHtml.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1]))]

console.log('\nGuide translations')
for (const lang of supported.filter((candidate) => candidate !== 'en')) {
  const textNodes = guideKeys.map((key) => ({
    innerHTML: '',
    getAttribute(name) {
      return name === 'data-i18n' ? key : null
    },
  }))
  let onChange = null
  const select = {
    value: lang,
    addEventListener(type, callback) {
      if (type === 'change') onChange = callback
    },
  }
  const document = {
    documentElement: { lang: 'en' },
    querySelectorAll() {
      return textNodes
    },
    getElementById(id) {
      return id === 'langSel' ? select : null
    },
  }
  vm.runInNewContext(guideI18n, {
    document,
    location: { reload() {} },
    navigator: { language: lang },
    localStorage: { getItem: () => lang, setItem() {} },
  })
  const missing = guideKeys.filter((_key, index) => textNodes[index]?.innerHTML === '')
  check(
    `${lang}: ${guideKeys.length} guide strings`,
    missing.length === 0 && document.documentElement.lang === lang && typeof onChange === 'function',
    missing.join(', '),
  )
}

console.log('\nProduct demo contract')
check(
  'landing keeps the public release at 0.3.0 while 0.3.1 is a candidate',
  html.includes('"softwareVersion": "0.3.0"')
    && html.includes('>v0.3.0</span>')
    && html.includes('Public download: 0.3.0')
    && html.includes('0.3.1 source/release candidate'),
)
check(
  'package and lock declare the 0.3.1 candidate',
  packageJson.version === '0.3.1'
    && packageLock.version === '0.3.1'
    && packageLock.packages?.['']?.version === '0.3.1',
)
check(
  'README separates public 0.3.0 from candidate 0.3.1',
  readme.includes('Current public Windows release: **CapturePack 0.3.0**')
    && readme.includes('candidate baseline is **0.3.1**')
    && readme.includes('not a public release until it appears on GitHub Releases'),
)
check('five-step rewind → pick → inspect → follow → export sequence', [1, 2, 3, 4, 5].every((n) => svg.includes(`id="caption${n}"`)))
check('child control name is visible', svg.includes('Save changes') && svg.includes('CHILD CONTROL'))
check('captured role/type and state are visible', svg.includes('ROLE / TYPE') && svg.includes('CAPTURED STATE'))
check(
  'selection outline moves inside its owner window',
  /id="movingWindow"[\s\S]*id="selectedOutline"[\s\S]*<\/g>\s*<g id="motionArrow"/.test(svg),
)
check('AI result uses real annotation fields', svg.includes('control_type') && svg.includes('picked_at_ms') && svg.includes('&quot;enabled&quot;: true'))
check('reduced-motion fallback stays informative', svg.includes('prefers-reduced-motion'))
check('README cache key and alt describe the new demo', readme.includes('demo.svg?v=4') && readme.includes('selects a child UI control'))
check(
  'still capture is subordinate, explicit, and privacy-bounded',
  html.indexOf('data-i18n="still_title"') > html.indexOf('class="features"')
    && html.includes('data-i18n="still_body"')
    && readme.includes('Ctrl+Alt+S')
    && readme.includes('does not keep a hidden'),
)
check(
  'recording, MCP and redaction boundaries are explicit',
  readme.includes('Live recording is on (the default)')
    && readme.includes('Turning Live recording off records nothing')
    && readme.includes('Settings → MCP can stop it')
    && readme.includes('cannot start an image or video capture')
    && readme.includes('Blur is non-destructive')
    && readme.includes('remain unredacted'),
)
check(
  'object sources and observed multi-monitor geometry are explicit',
  readme.includes('Windows UI Automation (built in)')
    && readme.includes('Chrome DOM (optional preview extension)')
    && readme.includes('HWND window fallback')
    && readme.includes('observed bounds')
    && html.includes('data-i18n="source_uia_body"')
    && html.includes('data-i18n="source_dom_body"')
    && html.includes('data-i18n="source_hwnd_body"'),
)
check(
  'landing distinguishes video and image packs',
  html.includes('data-i18n="out_video_title"')
    && html.includes('data-i18n="out_image_title"')
    && html.includes('data-i18n="out_image_tree"')
    && html.includes('no replay or timeline'),
)
check(
  'guide covers conditional replay and image capture',
  guideHtml.includes('When Live recording is on (the default)')
    && guideHtml.includes('data-i18n="g_nav_image"')
    && guideHtml.includes('Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>S')
    && guideHtml.includes('An image pack has no replay or timeline')
    && guideHtml.includes('Blur is non-destructive')
    && guideHtml.includes('data-i18n="g_set_logs"')
    && guideHtml.includes('Open logs folder'),
)
for (const { lang, text: localized } of localizedReadmes) {
  check(
    `${lang}: README public/candidate and product/privacy contract`,
    localized.includes('demo.svg?v=4')
      && localized.includes('0.3.0')
      && localized.includes('0.3.1')
      && localized.includes('Ctrl+Alt+S')
      && localized.includes('capture_kind: image')
      && localized.includes('MCP')
      && localized.includes('SHA256SUMS.txt')
      && localized.includes(derivedReadmeMarkers[lang]),
  )
}
check(
  'settings and local diagnostics are visible',
  readme.includes('Open logs folder')
    && readme.includes('1–30 fps')
    && readme.includes('independently configures the video')
    && readme.includes('(`Ctrl+Alt+C`)')
    && readme.includes('(`Ctrl+Alt+S`)')
    && guideHtml.includes('About / Information'),
)
check(
  'derived replay is explicitly conditional',
  html.includes('replay_annotated.webm   optional; only when manifest-declared')
    && readme.includes('optional derived view; only when manifest-declared')
    && guideHtml.includes('only when the final manifest declares it')
    && !/replay_annotated\.webm\s+(?:annotations rendered in|주석이 렌더링된|注釈を描画した|已渲染标注的|repetición con anotaciones|replay avec annotations|Replay mit gerenderten|replay com anotações|повтор с отрисованными)/i.test(i18n),
)
check(
  'derived declarations follow completed files',
  spec.includes('MUST finish the file before publishing this declaration')
    && manifestSchemaText.includes('MUST finish the file before publishing this declaration')
    && !spec.includes('declares this file before the file exists')
    && !manifestSchemaText.includes('declaring this file before the file exists'),
)

const legacyManualCopy =
  /manual rectangle|manual fallback|수동 사각형|手動矩形|手动画框|rectángulo manual|rectangle manuel|manuelle Rechteck|retângulo manual|ручным прямоугольником/i
check('old manual-fallback demo copy is gone', !legacyManualCopy.test(`${readme}\n${html}\n${i18n}`))
check(
  'English product copy does not overclaim exact or always-on state',
  !/\bexact bounds\b|\balways-on\b|CapturePack was \*\*already recording\*\*/i.test(
    `${readme}\n${html}\n${guideHtml}`,
  ),
)

console.log('\nRoadmap truth')
for (const key of ['now2', 'now3', 'now4', 'now5', 'now6']) {
  check(`${key} is shown as current`, html.includes(`data-i18n="${key}"`))
}
check(
  'Chrome DOM is described as a preview being hardened',
  html.includes('Chrome DOM integration hardening (preview available)'),
)

console.log('\n0.3.1 release and documentation contract')
check(
  'roadmap preserves history and adds the current baseline',
  roadmap.includes('## Current baseline — 0.3.1')
    && roadmap.includes('## V1 — MVP + installable, self-updating release')
    && roadmap.includes('## V2 — Temporal plugin system')
    && roadmap.includes('## Success criteria (from GOAL.md)'),
)
check(
  'hotfix and dependency audit are documented',
  changelog.includes('## 0.3.1 — 2026-07-30')
    && changelog.includes('2x-to-1x')
    && changelog.includes('Late plugin context')
    && changelog.includes('manifest declares')
    && changelog.includes('CVE-2026-39244')
    && changelog.includes('GHSA-frvp-7c67-39w9')
    && changelog.includes('npm audit --omit=dev')
    && changelog.includes('16 high-severity'),
)
check(
  'dependency audit separates runtime and build-tool exposure',
  dependencyAudit.includes('0 vulnerabilities')
    && dependencyAudit.includes('16 high-severity')
    && dependencyAudit.includes('development-only')
    && dependencyAudit.includes('25.1.8')
    && dependencyAudit.includes('downgrade')
    && dependencyAudit.includes('CVE-2026-39244')
    && dependencyAudit.includes('GHSA-frvp-7c67-39w9'),
)
check(
  'QA pins every 0.3.1 regression',
  qaDocs.includes('2x-to-1x move')
    && qaDocs.includes('Late UIA/DOM/plugin context')
    && qaDocs.includes('never produced')
    && qaDocs.includes('check:dom')
    && qaDocs.includes('check:source-first-save')
    && qaDocs.includes('check:site'),
)
check(
  'annotation schema carries temporal and authored fields',
  annotationsSchema.$defs?.box?.properties?.number_pin
    && annotationsSchema.$defs?.box?.properties?.tracking?.properties?.samples
    && annotationsSchema.$defs?.box?.properties?.tracking?.properties?.picked_at_ms
    && annotationsSchema.$defs?.box?.properties?.keyframes,
)
check(
  'release docs match the verified-draft workflow',
  releasing.includes('workflow_dispatch')
    && releasing.includes('npm run dist')
    && releasing.includes('.exe.blockmap')
    && releasing.includes('draft')
    && releasing.includes('byte')
    && !releasing.includes('--publish always')
    && !releasing.includes('published immediately')
    && releasing.indexOf('Runs the local `npm run dist`') < releasing.indexOf('Only after QA, packaging')
    && codeSigning.indexOf('packages locally') < codeSigning.indexOf('Only after QA, packaging')
    && releaseWorkflow.includes('Upload verified assets to draft')
    && releaseWorkflow.includes('Verify draft assets byte-for-byte')
    && releaseWorkflow.includes('Publish verified draft')
    && releaseWorkflow.indexOf('Package release artifacts') < releaseWorkflow.indexOf('Create or verify the release tag'),
)
check(
  'MCP remains optional, loopback-only and read-only',
  mcpDocs.includes('optional')
    && mcpDocs.includes('127.0.0.1')
    && mcpDocs.includes('read-only')
    && mcpDocs.includes('capturepack_history')
    && mcpDocs.includes('capturepack_open')
    && !/\balways[- ](?:on|running)\b/i.test(mcpDocs),
)
check(
  'handoff starts with current 0.3.1 state while retaining rc evidence',
  handoff.includes('## Current state — 2026-07-30')
    && handoff.includes('public 0.3.0 release')
    && handoff.includes('0.3.1')
    && handoff.includes('## Historical rc.35 snapshot'),
)

const localLinkDocuments = [
  ['README.md', readme],
  ['ROADMAP.md', roadmap],
  ['docs/RELEASING.md', releasing],
  ['docs/CODE_SIGNING.md', codeSigning],
  ['docs/MCP.md', mcpDocs],
  ['docs/QA.md', qaDocs],
  ['docs/HANDOFF.md', handoff],
  ['docs/DEPENDENCY-AUDIT-0.3.1.md', dependencyAudit],
]
const missingLocalLinks = []
for (const [documentPath, documentText] of localLinkDocuments) {
  for (const match of documentText.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1].trim()
    if (/^(?:https?:|mailto:|#)/i.test(target)) continue
    const withoutFragment = target.split('#', 1)[0]
    if (withoutFragment === '') continue
    const resolved = path.resolve(root, path.dirname(documentPath), decodeURIComponent(withoutFragment))
    if (!fs.existsSync(resolved)) missingLocalLinks.push(`${documentPath} -> ${target}`)
  }
}
check('current product-document links resolve locally', missingLocalLinks.length === 0, missingLocalLinks.join(', '))

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
