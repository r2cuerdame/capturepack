// Semantic annotation colour contract (#52).
//
// The editor, timebar, annotated replay and keyframe stills must not each
// invent a fallback. This check executes the shared rule and also pins every
// production caller to it so a visually consistent mistake cannot slip by.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const core = resolve(here, '..')

const bundle = await build({
  entryPoints: [resolve(here, 'annotation-style-check.entry.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
})
const {
  annotationHasSemanticGeometry,
  annotationColor,
  MANUAL_BOX_COLOR,
  SEMANTIC_BOX_COLOR,
} = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
)

let passed = 0
let failed = 0
function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\nMeaningful defaults')
check('manual rectangles are red', annotationColor({}) === '#FF3B30')
check(
  'a semantic target is blue even before a motion track exists',
  annotationColor({ target: { source: 'uia' } }) === '#0A84FF',
)
check(
  'a tracked object without explicit style is blue',
  annotationColor({ tracking: { enabled: true, samples: [] } }) === '#0A84FF',
)
check('the exported constants name the same contract',
  MANUAL_BOX_COLOR === '#FF3B30' && SEMANTIC_BOX_COLOR === '#0A84FF')
check(
  'manual geometry remains authorable',
  annotationHasSemanticGeometry({ tracking: { enabled: false } }) === false,
)
check(
  'a persisted target owns its geometry before tracking starts',
  annotationHasSemanticGeometry({
    target: { source: 'uia' },
    tracking: { enabled: false },
  }) === true,
)
check(
  'a persisted Chrome DOM target owns its geometry after save and reopen',
  annotationHasSemanticGeometry({
    target: { source: 'chrome-dom', selector: '#save' },
    tracking: { enabled: false },
  }) === true,
)

console.log('\nExisting packs keep authored/legacy colour')
check(
  'a custom old colour wins for a manual box',
  annotationColor({ style: { color: '#FFD60A' } }) === '#FFD60A',
)
check(
  'the previously shipped green semantic colour is preserved on re-edit',
  annotationColor({
    target: { source: 'uia' },
    tracking: { enabled: true, samples: [] },
    style: { color: '#22C55E' },
  }) === '#22C55E',
)

const editor = readFileSync(resolve(core, 'src/renderer/editor/editor.ts'), 'utf8')
const state = readFileSync(resolve(core, 'src/renderer/editor/state.ts'), 'utf8')
const editorRender = readFileSync(resolve(core, 'src/renderer/editor/render.ts'), 'utf8')
const finalRender = readFileSync(resolve(core, 'src/renderer/render/render.ts'), 'utf8')
const timebar = readFileSync(resolve(core, 'src/renderer/editor/timebar.ts'), 'utf8')
const html = readFileSync(resolve(core, 'src/renderer/editor/editor.html'), 'utf8')
const css = readFileSync(resolve(core, 'src/renderer/editor/editor.css'), 'utf8')
const i18n = readFileSync(resolve(core, 'src/shared/i18n.ts'), 'utf8')
const removeKeyframe = editor.slice(
  editor.indexOf('function removeSelectedKeyframe(): void {'),
  editor.indexOf('\n}', editor.indexOf('function removeSelectedKeyframe(): void {')) + 2,
)

console.log('\nEvery surface uses one production rule')
check(
  'new manual and picked boxes store red and blue explicitly',
  editor.includes('style: { color: MANUAL_BOX_COLOR }')
    && editor.includes(
      'style: { color: picked === undefined ? MANUAL_BOX_COLOR : SEMANTIC_BOX_COLOR }',
    ),
)
check(
  'editor canvas exports the shared colour resolver',
  editorRender.includes('export const boxColor = annotationColor'),
)
check(
  'timebar resolves colour through the editor shared alias',
  timebar.includes('bar.style.background = boxColor(a)'),
)
check(
  'annotated replay and keyframe stills call the shared resolver',
  finalRender.includes("import { annotationColor } from '../../shared/annotationStyle'")
    && finalRender.includes('const color = annotationColor(a)'),
)
check(
  'the obsolete palette and colour-cycling state are gone',
  !state.includes('PALETTE')
    && !state.includes('cycleColor')
    && !editor.includes('TRACKED_BOX_COLOR')
    && !editor.includes('#22C55E'),
)
check(
  'no hidden colour-picker control or dead picker CSS remains',
  !html.includes('id="colorBtn"')
    && !html.includes('id="colorSwatch"')
    && !css.includes('#colorBtn')
    && !css.includes('#colorSwatch')
    && !i18n.includes('editor.colorTooltip'),
)
check(
  'semantic boxes expose no move or resize path that would create manual keyframes',
  editor.includes('function coreOwnsGeometry(a: Annotation): boolean') &&
    editor.includes('annotationHasSemanticGeometry(a)') &&
    editor.includes('pickedObjectIdentities.has(a.annotation_id)') &&
    editor.includes('draft.target = annotationTargetOf(picked)') &&
    editor.includes('source: o.providerId') &&
    editor.includes('object_id: o.candidate.objectId') &&
    !editor.includes('!isTracked(') &&
    (editor.match(/!coreOwnsGeometry\(/g) ?? []).length >= 5 &&
    editor.includes("box !== null && !pickWins && !coreOwnsGeometry(box) ? 'move' : 'default'") &&
    editorRender.includes(
      "import { annotationColor, annotationHasSemanticGeometry } from '../../shared/annotationStyle'",
    ) &&
    editorRender.includes('if (annotationHasSemanticGeometry(a))') &&
    removeKeyframe.includes('coreOwnsGeometry(selected)'),
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
