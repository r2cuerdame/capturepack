// Turn explicitly selected local CapturePacks into the geometry-only corpus
// consumed by check:pick-quality. This is a maintenance tool, not a gate: the
// generated JSON is reviewed and committed, while the source pack stays local.
//
// Privacy is enforced by construction. We copy numbers plus closed-vocabulary
// UIA/DOM roles; titles, text, URLs, selectors, ids, classes, HWNDs and process
// names never enter the output object.
//
// Example:
//   node scripts/distill-real-pack-corpus.mjs `
//     --output test/real-pack-corpus/corpus.json `
//     --case 'dense-overlay=C:\_CapturePack\CapturePack_...' `
//     --tags 'dense-overlay=mixed-dpi,region,browser-overlay' `
//     --hands-off 'dense-overlay=1871' `
//     --controls 'dense-overlay=some'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)

function options(name) {
  const values = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name) values.push(argv[i + 1] ?? '')
  }
  return values
}

function one(name) {
  const values = options(name)
  if (values.length !== 1 || values[0] === '') {
    throw new Error(`${name} must be supplied exactly once`)
  }
  return values[0]
}

function assignments(name) {
  const out = new Map()
  for (const raw of options(name)) {
    const at = raw.indexOf('=')
    if (at <= 0 || at === raw.length - 1) throw new Error(`${name} requires id=value`)
    const id = raw.slice(0, at)
    if (out.has(id)) throw new Error(`${name} repeats ${id}`)
    out.set(id, raw.slice(at + 1))
  }
  return out
}

function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} is not finite`)
  return value
}

function rect(value, label) {
  if (value === null || typeof value !== 'object') throw new Error(`${label} is not a rectangle`)
  return {
    x: finite(value.x, `${label}.x`),
    y: finite(value.y, `${label}.y`),
    width: finite(value.width, `${label}.width`),
    height: finite(value.height, `${label}.height`),
  }
}

function optionalRect(value, label) {
  return value === undefined || value === null ? undefined : rect(value, label)
}

function token(value, fallback) {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().toLowerCase()
  return /^[a-z][a-z0-9_-]{0,39}$/.test(normalized) ? normalized : fallback
}

const uiaControlTypes = new Set([
  'button', 'calendar', 'checkbox', 'combobox', 'custom', 'datagrid', 'dataitem',
  'document', 'edit', 'group', 'header', 'headeritem', 'hyperlink', 'image',
  'list', 'listitem', 'menu', 'menubar', 'menuitem', 'pane', 'progressbar',
  'radiobutton', 'scrollbar', 'separator', 'slider', 'spinner', 'splitbutton',
  'statusbar', 'tab', 'tabitem', 'table', 'text', 'thumb', 'titlebar', 'toolbar',
  'tooltip', 'tree', 'treeitem', 'window',
])
const domTags = new Set([
  'a', 'article', 'aside', 'audio', 'body', 'button', 'canvas', 'code', 'details',
  'dialog', 'div', 'dl', 'fieldset', 'figure', 'footer', 'form', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'header', 'html', 'iframe', 'img', 'input', 'label',
  'li', 'main', 'menu', 'nav', 'ol', 'option', 'p', 'pre', 'section', 'select',
  'span', 'strong', 'summary', 'table', 'tbody', 'td', 'textarea', 'tfoot', 'th',
  'thead', 'tr', 'ul', 'video',
])
const domRoles = new Set([
  '', 'alert', 'article', 'banner', 'button', 'cell', 'checkbox', 'columnheader',
  'combobox', 'complementary', 'contentinfo', 'dialog', 'document', 'form', 'grid',
  'gridcell', 'heading', 'img', 'link', 'list', 'listbox', 'listitem', 'main',
  'menu', 'menubar', 'menuitem', 'navigation', 'option', 'progressbar', 'radio',
  'radiogroup', 'region', 'row', 'rowgroup', 'rowheader', 'search', 'separator',
  'slider', 'status', 'switch', 'tab', 'table', 'tablist', 'tabpanel', 'textbox',
  'toolbar', 'tooltip', 'tree', 'treeitem',
])

function vocabulary(value, allowed, fallback) {
  const candidate = token(value, fallback)
  return allowed.has(candidate) ? candidate : fallback
}

const browserProcesses = new Set(['chrome', 'chromium', 'msedge', 'brave', 'vivaldi', 'opera', 'thorium'])

function surfaceKind(window) {
  const process = String(window.process ?? '').trim().toLowerCase().replace(/\.exe$/, '')
  const className = String(window.class_name ?? '').trim().toLowerCase()
  if (className === 'progman' || className === 'workerw') return 'desktop'
  if (browserProcesses.has(process)) return 'browser'
  if (className === 'chrome_widgetwin_1' || className === 'chrome_widgetwin_0') return 'electron'
  return 'native'
}

function safeWindow(kind, index, source) {
  const title = kind === 'browser' ? `Corpus page ${index} - Chrome` : `Corpus ${kind} ${index}`
  return {
    hwnd: String(index + 1),
    title,
    process:
      kind === 'browser' ? 'chrome.exe' : kind === 'electron' ? 'corpus-electron.exe' : 'corpus-native.exe',
    class_name:
      kind === 'browser' || kind === 'electron'
        ? 'Chrome_WidgetWin_1'
        : kind === 'desktop'
          ? 'Progman'
          : 'CorpusNativeWindow',
    bounds: rect(source.bounds, `windows[${index}].bounds`),
    ...(source.client_bounds === undefined
      ? {}
      : { client_bounds: rect(source.client_bounds, `windows[${index}].client_bounds`) }),
    focused: source.focused === true,
    z: finite(source.z ?? index, `windows[${index}].z`),
    tree: source.tree === 'collected' ? 'collected' : 'skipped',
    element_count: 0,
  }
}

function safeUia(source) {
  const sourceWindows = Array.isArray(source.windows) ? source.windows : []
  const kinds = sourceWindows.map(surfaceKind)
  const windows = sourceWindows.map((window, index) => safeWindow(kinds[index], index, window))
  const elements = (Array.isArray(source.elements) ? source.elements : []).map((element, index) => {
    const window = finite(element.window, `elements[${index}].window`)
    if (!Number.isInteger(window) || window < 0 || window >= windows.length) {
      throw new Error(`elements[${index}].window is outside the window table`)
    }
    windows[window].element_count += 1
    return {
      name: typeof element.name === 'string' && element.name.trim() !== '' ? `Corpus control ${index}` : '',
      control_type: vocabulary(element.control_type, uiaControlTypes, 'custom'),
      automation_id:
        typeof element.automation_id === 'string' && element.automation_id.trim() !== ''
          ? `corpus-control-${index}`
          : '',
      class_name: 'CorpusControl',
      bounds: rect(element.bounds, `elements[${index}].bounds`),
      depth: finite(element.depth, `elements[${index}].depth`),
      window,
    }
  })
  return {
    payload: {
      captured_at: '2026-01-01T00:00:00Z',
      budget_ms: finite(source.budget_ms ?? 3000, 'budget_ms'),
      truncated: source.truncated === true,
      ...(source.geometry_refused === true ? { geometry_refused: true } : {}),
      windows,
      elements,
    },
    kinds,
  }
}

function numericViewport(source, label) {
  if (source === null || typeof source !== 'object') throw new Error(`${label} is missing`)
  const keys = [
    'width', 'height', 'dpr', 'screenX', 'screenY', 'outerWidth', 'outerHeight',
  ]
  return Object.fromEntries(keys.map((key) => [key, finite(source[key], `${label}.${key}`)]))
}

function safeDomElement(source, index, label) {
  return {
    i: index,
    tag: vocabulary(source.tag, domTags, 'div'),
    role: vocabulary(source.role, domRoles, ''),
    bounds: rect(source.bounds, `${label}.bounds`),
  }
}

function safeDom(source, sourceWindows, safeWindows, caseId) {
  const sourceEvents = Array.isArray(source?.events) ? source.events : []
  const events = []
  for (const [eventIndex, event] of sourceEvents.entries()) {
    if (event?.type !== 'dom.document.captured' || event.document === undefined) continue
    const tabTitle = String(event.tab?.title ?? '')
    const ownerIndex = sourceWindows.findIndex((window) => (
      surfaceKind(window) === 'browser' && String(window.title ?? '').includes(tabTitle)
    ))
    if (ownerIndex < 0) continue
    const document = event.document
    const documentViewport = document.viewport
    const elements = (Array.isArray(document.elements) ? document.elements : []).map(
      (element, index) => safeDomElement(element, index, `events[${eventIndex}].document.elements[${index}]`),
    )
    events.push({
      t_ms: finite(event.t_ms ?? 0, `events[${eventIndex}].t_ms`),
      age_ms: finite(event.age_ms ?? 0, `events[${eventIndex}].age_ms`),
      type: 'dom.document.captured',
      tab: {
        url: `https://example.invalid/corpus/${caseId}/${eventIndex}`,
        title: safeWindows[ownerIndex].title.replace(/ - Chrome$/, ''),
      },
      viewport: numericViewport(event.viewport, `events[${eventIndex}].viewport`),
      document: {
        viewport: {
          width: finite(documentViewport.width, `events[${eventIndex}].document.viewport.width`),
          height: finite(documentViewport.height, `events[${eventIndex}].document.viewport.height`),
          device_pixel_ratio: finite(
            documentViewport.device_pixel_ratio ?? documentViewport.devicePixelRatio,
            `events[${eventIndex}].document.viewport.device_pixel_ratio`,
          ),
          scroll_x: finite(documentViewport.scroll_x ?? documentViewport.scrollX ?? 0, 'scroll_x'),
          scroll_y: finite(documentViewport.scroll_y ?? documentViewport.scrollY ?? 0, 'scroll_y'),
        },
        url: `https://example.invalid/corpus/${caseId}/${eventIndex}`,
        title: safeWindows[ownerIndex].title.replace(/ - Chrome$/, ''),
        elements,
        truncated: document.truncated === true,
        visited_count: elements.length,
        elapsed_ms: 0,
        omitted: [],
      },
    })
  }
  return events.length === 0
    ? null
    : { protocol: 1, extension_version: '0.0.0-corpus', events }
}

function pngSize(file) {
  const head = readFileSync(file).subarray(0, 24)
  if (head.length !== 24 || head.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error(`${file} has no PNG IHDR`)
  }
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
}

function safeScreen(source, index) {
  return {
    width: finite(source.width, `screens[${index}].width`),
    height: finite(source.height, `screens[${index}].height`),
    scale: finite(source.scale ?? 1, `screens[${index}].scale`),
    ...(source.bounds === undefined ? {} : { bounds: rect(source.bounds, `screens[${index}].bounds`) }),
  }
}

function distill(id, dirPath, tags, handsOffMs, controls) {
  const manifest = JSON.parse(readFileSync(path.join(dirPath, 'manifest.json'), 'utf8'))
  const uiaPath = path.join(dirPath, 'plugins', 'windows-uia', 'elements.json')
  const sourceUia = JSON.parse(readFileSync(uiaPath, 'utf8'))
  const { payload: uia, kinds } = safeUia(sourceUia)
  const domPath = path.join(dirPath, 'plugins', 'chrome-dom', 'elements.json')
  let sourceDom = null
  try { sourceDom = JSON.parse(readFileSync(domPath, 'utf8')) } catch { }
  const dom = safeDom(sourceDom, sourceUia.windows ?? [], uia.windows, id)
  const size = pngSize(path.join(dirPath, manifest.media.snapshot))
  const screens = (Array.isArray(manifest.environment?.screens) ? manifest.environment.screens : [])
    .map(safeScreen)
  const cropBounds = optionalRect(manifest.media?.crop_bounds, 'media.crop_bounds')
  const shape = { size, screens, cropBounds, uia, dom }
  const shapeSha256 = createHash('sha256').update(JSON.stringify(shape)).digest('hex')
  return {
    id,
    provenance: 'distilled-real-pack',
    shape_sha256: shapeSha256,
    classifications: [...new Set(tags.split(',').map((tag) => token(tag, '')).filter(Boolean))].sort(),
    observed_hands_off_ms: handsOffMs,
    thresholds: {
      max_hands_off_ms: 5000,
      max_replay_to_candidates_ms: 1000,
      max_median_control_fraction: 0.15,
      max_p90_control_fraction: 0.55,
      min_precise_control_share: controls === 'some' ? 0.001 : 0,
      expected_controls: controls,
    },
    pack: {
      width: size.width,
      height: size.height,
      image_scope: manifest.media?.image_scope === 'region' ? 'region' : 'fullscreen',
      ...(cropBounds === undefined ? {} : { crop_bounds: cropBounds }),
      screens,
      uia,
      ...(dom === null ? {} : { dom }),
      surface_kinds: [...new Set(kinds)].sort(),
    },
  }
}

const cases = assignments('--case')
const tags = assignments('--tags')
const handsOff = assignments('--hands-off')
const controls = assignments('--controls')
if (cases.size === 0) throw new Error('at least one --case id=path is required')

const corpus = {
  schema_version: 1,
  privacy: 'geometry-only; original pixels, text, URLs, ids, classes, HWNDs and process names excluded',
  visual_policy: 'snapshot pixels are regenerated neutral grey; visual diffs never replace behavioral gates',
  hard_case_inventory: [
    { id: 'mixed-dpi', status: 'represented' },
    { id: 'app-overlays', status: 'represented' },
    { id: 'multiple-display-environment', status: 'represented' },
    { id: 'multiple-display-output', status: 'coverage-gap', companion_checks: ['check:n-display-format', 'check:semantic-multidisplay-roundtrip'] },
    { id: 'motion', status: 'coverage-gap', companion_checks: ['check:motion', 'check:temporal'] },
    { id: 'similar-frames', status: 'coverage-gap', companion_checks: ['check:temporal-alignment'] },
    { id: 'hdr-sdr', status: 'coverage-gap' },
  ],
  cases: [...cases].map(([id, source]) => {
    const tagValue = tags.get(id)
    const latency = Number(handsOff.get(id))
    const controlExpectation = controls.get(id)
    if (!tagValue) throw new Error(`missing --tags for ${id}`)
    if (!Number.isFinite(latency) || latency < 0) throw new Error(`missing/invalid --hands-off for ${id}`)
    if (controlExpectation !== 'some' && controlExpectation !== 'none') {
      throw new Error(`--controls for ${id} must be some or none`)
    }
    return distill(id, path.resolve(source), tagValue, latency, controlExpectation)
  }),
}

const output = path.resolve(one('--output'))
mkdirSync(path.dirname(output), { recursive: true })
writeFileSync(output, `${JSON.stringify(corpus, null, 2)}\n`, 'utf8')
console.log(`wrote ${corpus.cases.length} privacy-safe case(s) to ${output}`)
