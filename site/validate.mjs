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
const style = read('site/style.css')
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
const handoffPrompt = read('docs/HANDOFF-PROMPT.md')
const docsReadme = read('docs/README.md')
const dependencyAudit = read('docs/DEPENDENCY-AUDIT-0.3.1.md')
const releaseWorkflow = read('.github/workflows/release.yml')
const annotationsSchema = JSON.parse(read('docs/schemas/annotations.schema.json'))
const manifestSchemaText = read('docs/schemas/manifest.schema.json')
const spec = read('SPEC.md')
const packageJson = JSON.parse(read('core/package.json'))
const packageLock = JSON.parse(read('core/package-lock.json'))
const packageVersion = String(packageJson.version ?? '')
// The application version may be the public release, or a release CANDIDATE for
// a later one. What it may never be is a different build wearing the public
// version's number: a locally built installer named like the published 0.3.3
// cannot be told apart from it once it leaves this folder.
const PUBLIC_VERSION = '0.4.2'
const packageIsCurrentPublic = packageVersion === PUBLIC_VERSION
const candidateBase = /^(\d+\.\d+\.\d+)-rc\.\d+$/.exec(packageVersion)?.[1]
/** Negative, zero or positive, comparing major.minor.patch left to right. */
function compareVersions(left, right) {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0)
  }
  return 0
}
const packageIsCandidateAhead =
  candidateBase !== undefined && compareVersions(candidateBase, PUBLIC_VERSION) > 0
const supported = ['en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru']
const motionStems = ['capturepack-time-machine', 'capturepack-still-context']
const motionFiles = supported.flatMap((lang) =>
  motionStems.flatMap((stem) => [
    `site/assets/motion/${lang}/${stem}.webm`,
    `site/assets/motion/${lang}/${stem}.mp4`,
    `site/assets/motion/${lang}/${stem}-poster.webp`,
  ]),
)
const localizedReadmes = supported
  .filter((lang) => lang !== 'en')
  .map((lang) => ({ lang, text: read(`README.${lang}.md`) }))
/**
 * Each translation must say that `replay_annotated.webm` exists ONLY when the
 * manifest declares it — the one line that stops a reader treating a derived
 * view as part of every pack.
 *
 * PATTERNS, NOT EXACT STRINGS. These were fixed phrases, and a retranslation
 * broke six of eight on nothing but grammatical agreement: `lo declara` became
 * `la declara` once the Spanish sentence chose "vista", `objavlen` became
 * `objavleno`, `declarado` became `declarada`. Every one of those files still
 * stated the contract perfectly; the check was pinning the wording rather than
 * the meaning, and a check that fails on correct work teaches people to edit
 * the check. So each pattern now requires the two words that carry the claim —
 * the manifest, and the declaration being conditional — and lets the sentence
 * around them be written however the language wants.
 */
const derivedReadmeMarkers = {
  ko: /매니페스트에?\s*선언[^\n]{0,16}경우에만/u,
  ja: /マニフェスト[^\n]{0,12}宣言[^\n]{0,12}場合のみ/u,
  zh: /仅在清单声明时/u,
  es: /solo si el manifest l[ao] declara/u,
  fr: /si le manifest l[ae] déclare/u,
  de: /nur bei Manifest-Deklaration/u,
  pt: /só (?:quando|se) declarad[ao] no manifesto/u,
  ru: /только если объявлен[оа]? в manifest/u,
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
      if (selector === 'video[data-motion]') return []
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
      && releaseNote.includes('0.4.2')
      && !releaseNote.includes('0.4.1'),
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
  'landing uses localized, user-controllable motion instead of the legacy SVG',
  html.includes('data-motion="capturepack-time-machine"')
    && html.includes('data-motion="capturepack-still-context"')
    && (html.match(/<video class="motion-video/g) ?? []).length === 2
    && (html.match(/controls muted loop playsinline autoplay/g) ?? []).length === 2
    && !html.includes('<img src="assets/demo.svg"'),
)
check(
  'every locale publishes both WebM/MP4 motions and WebP posters',
  motionFiles.length === 54
    && motionFiles.every((relative) => {
      const absolute = path.join(root, relative)
      return fs.existsSync(absolute) && fs.statSync(absolute).size > 0
    }),
)
check(
  'language changes rewrite poster and both source formats',
  i18n.includes("'assets/motion/' + lang + '/' + motion")
    && i18n.includes("base + '-poster.webp'")
    && i18n.includes("base + '.' + format")
    && i18n.includes("prefers-reduced-motion: reduce"),
)
check(
  'landing names 0.4.2 as the public release',
  html.includes('"softwareVersion": "0.4.2"')
    && html.includes('>v0.4.2</span>')
    && html.includes('Public download: 0.4.2')
    && !html.includes('source/release candidate'),
)
check(
  'landing keeps release-verification jargon out of product copy',
  !/\bsha(?:-?256)?\b|checksum|체크섬|校验和|Prüfsumme/i.test(`${html}\n${i18n}`),
)
check(
  'package and lock agree, on the public release or a candidate ahead of it',
  (packageIsCurrentPublic || packageIsCandidateAhead)
    && packageLock.version === packageVersion
    && packageLock.packages?.['']?.version === packageVersion,
  `${packageVersion} (public ${PUBLIC_VERSION}), lock ${packageLock.version}`,
)
check(
  'README names 0.4.2 as the public release',
  readme.includes('Current public Windows release: **CapturePack 0.4.2**')
    && readme.includes('**0.4.2 is the current public Windows download.**')
    && !readme.includes('candidate baseline')
    && !readme.includes('not a public release until it appears on GitHub Releases'),
)
check('five-step rewind → pick → inspect → follow → export sequence', [1, 2, 3, 4, 5].every((n) => svg.includes(`id="caption${n}"`)))
const rewindPath = svg.match(
  /<path id="rewindArrow" d="M\s*([\d.]+)\s+[\d.]+\s+H\s*([\d.]+)"[^>]*marker-end="url\(#arrowLeft\)"/,
)
check(
  'rewind rail is geometrically right-to-left',
  svg.includes('id="rewindRail" data-direction="right-to-left"')
    && rewindPath
    && Number(rewindPath[1]) > Number(rewindPath[2]),
)
check(
  'animated playhead starts at NOW and settles on a negative past offset',
  /@keyframes rewindPlayhead\s*\{[\s\S]*0%,12%\s*\{\s*transform:\s*translateX\(0\)[\s\S]*29%,98%\s*\{\s*transform:\s*translateX\(-302px\)/.test(svg),
)
check(
  'the persistent timeline names both temporal endpoints',
  svg.includes('id="nowMarker"')
    && svg.includes('NOW · 00:12.4')
    && svg.includes('id="pastMarker"')
    && svg.includes('5s AGO · 00:07.4')
    && svg.includes('RIGHT TO LEFT'),
)
check(
  'the current bug state changes into a selectable historical control',
  svg.includes('id="nowControlState"')
    && svg.includes('Save button missing')
    && /id="historicalControl" data-frame="past"[\s\S]*id="selectedOutline"/.test(svg)
    && svg.indexOf('STEP 1 · BUG NOTICED · NOW') < svg.indexOf('STEP 2 · REWIND ← 5 SECONDS')
    && svg.indexOf('STEP 2 · REWIND ← 5 SECONDS') < svg.indexOf('STEP 3 · PAST FRAME · 5s AGO'),
)
check('historical child control name is visible', svg.includes('Save changes') && svg.includes('PAST-FRAME CONTROL'))
check(
  'historical semantic selection uses the product blue provenance colour',
  /id="selectedOutline"[^>]*fill="#0A84FF"[^>]*stroke="#0A84FF"/.test(svg)
    && /id="objectBadge"[\s\S]*?fill="#0A84FF"/.test(svg),
)
check('captured role/type and state are visible', svg.includes('ROLE / TYPE') && svg.includes('CAPTURED STATE'))
check(
  'selection outline moves inside its owner window',
  /id="movingWindow"[\s\S]*id="selectedOutline"[\s\S]*<\/g>\s*<g id="motionArrow"/.test(svg),
)
check('AI result uses real annotation fields', svg.includes('control_type') && svg.includes('picked_at_ms') && svg.includes('&quot;enabled&quot;: true'))
check(
  'reduced-motion fallback preserves direction and historical selection',
  svg.includes('prefers-reduced-motion')
    && /#caption5, #pastChip, #historicalControl, #selectedOutline, #objectBadge,[\s\S]*#jsonPanel, #rewindGuide \{ opacity: 1 \}/.test(svg)
    && svg.includes('#playhead { transform:translateX(-302px) }'),
)
check(
  'README poster links to the localized motion demo and describes its direction',
  readme.includes('motion/en/capturepack-time-machine-poster.webp')
    && readme.includes('https://capturepack.dev/')
    && readme.includes('starts at NOW on the right')
    && readme.includes('moves the playhead left to 5 seconds ago')
    // Was `historical frame`, which came from the alt text's old ending:
    // "restores and selects the child UI control that existed in that
    // historical frame". A video selects nothing, so that sentence went. What
    // the alt text still has to say is WHY rewinding is worth anything — the
    // thing being marked is no longer on screen.
    && readme.includes('already gone from the screen'),
)
check(
  'landing copy explains the visible temporal direction',
  html.includes('start at NOW on the right and travel left to 5s AGO')
    && i18n.includes('오른쪽 NOW에서 시작해 왼쪽 5초 전으로 이동'),
)
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
    `${lang}: README public-release and product/privacy contract`,
    localized.includes(`motion/${lang}/capturepack-time-machine-poster.webp`)
      && localized.includes('0.4.2')
      && !localized.includes('0.4.1')
      && localized.includes('Ctrl+Alt+S')
      && localized.includes('capture_kind: image')
      && localized.includes('MCP')
      && localized.includes('SHA256SUMS.txt')
      && derivedReadmeMarkers[lang].test(localized),
  )
}
check(
  'settings and local diagnostics are visible',
  readme.includes('Open logs folder')
    && readme.includes('5–30 fps')
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
  /manual fallback|수동 대체 사각형|手動の代替矩形|手动画框作为回退|rectángulo manual de respaldo|rectangle manuelle de secours|manuelles Ausweichrechteck|retângulo manual alternativo|ручной прямоугольник вместо объекта/i
check('old manual-fallback demo copy is gone', !legacyManualCopy.test(`${readme}\n${html}\n${i18n}`))
check(
  'English product copy does not overclaim exact or always-on state',
  !/\bexact bounds\b|\balways-on\b|CapturePack was \*\*already recording\*\*/i.test(
    `${readme}\n${html}\n${guideHtml}`,
  ),
)

check(
  'landing has no roadmap content, links, translations or styles',
  !/\broadmap\b|로드맵|ロードマップ|路线图|hoja de ruta|feuille de route|roteiro|дорожная карта/i.test(
    `${html}\n${i18n}\n${style}`,
  )
    && !html.includes('blob/main/ROADMAP.md'),
)

console.log('\n0.4.2 release and documentation contract')
check(
  'roadmap preserves history and adds the current baseline',
  roadmap.includes('## Current baseline — 0.4.2')
    && roadmap.includes('## V1 — MVP + installable, self-updating release')
    && roadmap.includes('## V2 — Temporal plugin system')
    && roadmap.includes('## Success criteria (from GOAL.md)'),
)
check(
  'current release, known issue and dependency audit are documented',
  changelog.includes('## 0.4.2 — 2026-08-09')
    && changelog.includes('## 0.4.1 — 2026-08-02')
    && changelog.includes('## 0.4.0 — 2026-08-02')
    && changelog.includes('## 0.3.5 — 2026-08-02')
    && changelog.includes('## 0.3.4 — 2026-08-02')
    && changelog.includes('## 0.3.3 — 2026-07-30')
    && changelog.includes('viewer.html')
    && changelog.includes('Known issues')
    && changelog.includes('issues/89')
    && changelog.includes('## 0.3.2 — 2026-07-30')
    && changelog.includes('lower 528 pixels')
    && changelog.includes('editor:init')
    && changelog.includes('manual rectangles are red')
    && changelog.includes('all 50 sequential checks')
    && changelog.includes('## 0.3.1 — 2026-07-30')
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
  'QA pins every current regression',
  qaDocs.includes('2x-to-1x move')
    && qaDocs.includes('Late UIA/DOM/plugin context')
    && qaDocs.includes('never produced')
    && qaDocs.includes('check:dom')
    && qaDocs.includes('check:source-first-save')
    && qaDocs.includes('check:image-region-window')
    && qaDocs.includes('still-image editor opens as an empty dark page')
    && qaDocs.includes('reopened DOM pick becomes draggable')
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
    && releaseWorkflow.includes('--prerelease --latest=false')
    && releaseWorkflow.includes('--prerelease=false --latest')
    && releaseWorkflow.includes('$global:LASTEXITCODE = 0')
    && packageJson.scripts?.dist?.includes('--publish never')
    && releaseWorkflow.indexOf('Package release artifacts') < releaseWorkflow.indexOf('Create or verify the release tag')
    && !releasing.includes('CapturePack-Setup-0.3.1.exe')
    && !releasing.includes('for example `v0.3.1`'),
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
  'handoff records the stable 0.4.1 baton without presenting the sync issue as fixed',
  handoff.includes('# CapturePack handoff — after v0.4.1')
    && handoff.includes('b7e0c695d5f2c018e2c10fcf83936d1d42f7a0d4')
    && handoff.includes('Issue #89')
    && handoff.includes('Do not hard-code 125 ms')
    && !handoff.includes('public 0.3.2 release')
    && !handoff.includes('## Historical rc.35 snapshot'),
)

const localLinkDocuments = [
  ['README.md', readme],
  ['ROADMAP.md', roadmap],
  ['docs/RELEASING.md', releasing],
  ['docs/CODE_SIGNING.md', codeSigning],
  ['docs/MCP.md', mcpDocs],
  ['docs/QA.md', qaDocs],
  ['docs/HANDOFF.md', handoff],
  ['docs/HANDOFF-PROMPT.md', handoffPrompt],
  ['docs/README.md', docsReadme],
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
