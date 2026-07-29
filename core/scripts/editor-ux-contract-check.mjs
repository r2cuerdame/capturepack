import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const read = (relative) => readFileSync(resolve(root, relative), 'utf8')

const session = read('src/main/session.ts')
const renderer = read('src/renderer/editor/editor.ts')
const html = read('src/renderer/editor/editor.html')
const css = read('src/renderer/editor/editor.css')
const historyHtml = read('src/renderer/history/history.html')
const historyRenderer = read('src/renderer/history/history.ts')

const functionBody = (name, nextName) => {
  const start = renderer.indexOf(`function ${name}`)
  const end = renderer.indexOf(`function ${nextName}`, start + 1)
  return start < 0 || end < 0 ? '' : renderer.slice(start, end)
}

const openDuration = functionBody('openDurationEditor', 'closeDurationEditor')
const openNumber = functionBody('openNumberPicker', 'closeNumberPicker')

const checks = [
  [
    'editor title is the product name only',
    html.includes('<title>CapturePack</title>') &&
      html.includes('<span id="titleBarLabel">CapturePack</span>') &&
      !html.includes('CapturePack — 주석'),
  ],
  [
    'Windows owns close/maximize/minimize caption buttons',
    session.includes("title: 'CapturePack'") &&
      session.includes("titleBarStyle: 'hidden'") &&
      session.includes('titleBarOverlay: {') &&
      session.includes('resizable: true') &&
      !session.includes('frame: false'),
  ],
  [
    'opening lifetime closes number picker first',
    openDuration.indexOf('closeNumberPicker(false)') >= 0 &&
      openDuration.indexOf('closeNumberPicker(false)') <
        openDuration.indexOf('durationEditor.hidden = false'),
  ],
  [
    'opening number picker closes lifetime first',
    openNumber.indexOf('closeDurationEditor(false)') >= 0 &&
      openNumber.indexOf('closeDurationEditor(false)') <
        openNumber.indexOf('numberPicker.hidden = false'),
  ],
  [
    'both header popovers render above their box header',
    /#boxHeader\s*\{[\s\S]*?z-index:\s*6;/u.test(css) &&
      /#numberPicker\s*\{[\s\S]*?z-index:\s*7;/u.test(css) &&
      /#durationEditor\s*\{[\s\S]*?z-index:\s*7;/u.test(css),
  ],
  [
    'both popovers clamp inside the stage',
    renderer.includes('stage.clientWidth - numberPicker.offsetWidth - 8') &&
      renderer.includes('stage.clientHeight - numberPicker.offsetHeight - 8') &&
      renderer.includes('stage.clientWidth - durationEditor.offsetWidth - 8') &&
      renderer.includes('stage.clientHeight - durationEditor.offsetHeight - 8'),
  ],
  [
    'unsaved changes prompt is centered over the window',
    /#unsavedBar\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?inset:\s*0;[\s\S]*?align-items:\s*center;[\s\S]*?justify-content:\s*center;/u.test(css),
  ],
  [
    'description input follows the same resolved keyframe/tracked box as selection chrome',
    renderer.includes('const painted = resolveForBoard(stored)') &&
      renderer.includes('anchor = painted.bounds') &&
      renderer.includes('display = displayOf(painted) ?? display'),
  ],
  [
    'history exposes only useful date and render-failure filters',
    ['all', 'today', 'week', 'renderfailed'].every((id) =>
      historyHtml.includes(`data-filter="${id}"`),
    ) &&
      !historyHtml.includes('data-filter="blur"') &&
      !historyHtml.includes('data-filter="notpackaged"') &&
      !historyRenderer.includes("case 'blur':") &&
      !historyRenderer.includes("case 'notpackaged':"),
  ],
]

let failed = 0
for (const [name, passed] of checks) {
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`)
  if (!passed) failed += 1
}

if (failed !== 0) {
  console.error(`\n${failed}/${checks.length} editor UX contract checks failed.`)
  process.exitCode = 1
} else {
  console.log(`\n${checks.length}/${checks.length} editor UX contract checks passed.`)
}
