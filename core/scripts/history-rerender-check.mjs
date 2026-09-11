import { build } from 'esbuild'
import { readFileSync } from 'node:fs'

const bundle = await build({
  entryPoints: ['scripts/history-rerender-check.entry.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
})
const { planHistoryRerender, renderContractError } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
)

let passed = 0
let failed = 0
function check(name, condition, detail = '') {
  if (condition) passed += 1
  else failed += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

const displays = [
  {
    index: 2, snapshot: 'snapshot.png', snapshot_width: 1920, snapshot_height: 1080,
    replay: 'replay.webm', replay_duration_ms: 1000, replay_clock_offset_ms: 0,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scale: 1, focused: true,
  },
  {
    index: 1, snapshot: 'snapshot-d1.png', snapshot_width: 2560, snapshot_height: 1440,
    replay: 'replay-d1.webm', replay_duration_ms: 900, replay_clock_offset_ms: -25,
    bounds: { x: -2560, y: 0, width: 2560, height: 1440 }, scale: 1, focused: false,
  },
]
const annotations = [
  { annotation_id: 'focused', type: 'box', bounds: { x: 10, y: 10, width: 50, height: 50 }, text: '', numbered: true, blur: false, start_ms: 100, end_ms: 800, tracking: { enabled: false }, created_at: '', z: 1 },
  { annotation_id: 'secondary', type: 'box', display: 1, bounds: { x: 20, y: 20, width: 50, height: 50 }, text: '', numbered: true, blur: false, start_ms: 200, end_ms: 700, tracking: { enabled: false }, created_at: '', z: 2 },
]
const manifest = { media: { displays } }
const plan = planHistoryRerender(manifest, annotations)

console.log('\nHistory retry plan for a two-display saved pack')
check('uses the declared focused display even when entries are unsorted', plan.focusedDisplay === 2)
check('focused render receives no secondary-display box', plan.focusedAnnotations.length === 1 && plan.focusedAnnotations[0].annotation_id === 'focused')
check('global numbers are computed before display filtering', JSON.stringify(plan.displayNumbers) === JSON.stringify([['focused', 1], ['secondary', 2]]), JSON.stringify(plan.displayNumbers))
check('motion space preserves both declared raster frames', plan.motionSpace?.displays.length === 2 && plan.motionSpace.displays[1].width === 2560)
check('one secondary output job is planned', plan.displays.length === 1 && plan.displays[0].index === 1)
check('secondary job receives only its own box', plan.displays[0].annotations.length === 1 && plan.displays[0].annotations[0].annotation_id === 'secondary')
check('secondary lifetime is rebased to its replay clock', plan.displays[0].annotations[0].start_ms === 175 && plan.displays[0].annotations[0].end_ms === 675, JSON.stringify(plan.displays[0].annotations[0]))

console.log('\nRenderer contract')
check('complete multi-display payload is accepted', renderContractError({ motionSpace: plan.motionSpace, focusedDisplay: plan.focusedDisplay, displayNumbers: plan.displayNumbers }) === null)
check('missing global numbers is rejected', renderContractError({ motionSpace: plan.motionSpace, focusedDisplay: plan.focusedDisplay })?.includes('displayNumbers'))
check('missing focused display is rejected', renderContractError({ motionSpace: plan.motionSpace, displayNumbers: plan.displayNumbers })?.includes('focusedDisplay'))

console.log('\nHistory wiring')
const historySource = readFileSync('src/main/historyWindow.ts', 'utf8')
const rendererSource = readFileSync('src/renderer/render/render.ts', 'utf8')
check('retry starts every preflighted secondary render', historySource.includes('startHistoryDisplayRenders(\n    { id: manifest.id, dirPath: entry.path },'))
check('secondary replay jobs use the display renderer', historySource.includes('startDisplayRender(handle, {'))
check('secondary still-only jobs use the keyframe renderer', historySource.includes('startKeyframeStill(handle, {'))
check('renderer rejects an incomplete contract before making the overlay', rendererSource.includes('const contractError = renderContractError(job)'))

console.log(`\nresult: ${failed === 0 ? 'OK' : 'BROKEN'} — ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
