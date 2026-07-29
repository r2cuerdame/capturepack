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
const packageJson = JSON.parse(read('core/package.json'))
const packageLock = JSON.parse(read('core/package-lock.json'))
const supported = ['en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru']
const localizedReadmes = supported
  .filter((lang) => lang !== 'en')
  .map((lang) => ({ lang, text: read(`README.${lang}.md`) }))

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
  check(
    `${lang}: ${textKeys.length + altKeys.length} rendered strings`,
    missingText.length === 0 && missingAlt.length === 0 && document.documentElement.lang === lang,
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
check('landing declares the stable 0.3.0 release', html.includes('"softwareVersion": "0.3.0"') && html.includes('>v0.3.0</span>'))
check(
  'package and lock declare stable 0.3.0',
  packageJson.version === '0.3.0'
    && packageLock.version === '0.3.0'
    && packageLock.packages?.['']?.version === '0.3.0',
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
    && guideHtml.includes('Blur is non-destructive'),
)
for (const { lang, text: localized } of localizedReadmes) {
  check(
    `${lang}: README 0.3.0 product/privacy contract`,
    localized.includes('demo.svg?v=4')
      && localized.includes('0.3.0')
      && localized.includes('Ctrl+Alt+S')
      && localized.includes('capture_kind: image')
      && localized.includes('MCP')
      && localized.includes('SHA256SUMS.txt'),
  )
}

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

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
