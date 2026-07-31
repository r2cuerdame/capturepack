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
const indexFreshness = functionBody(
  'objectIndexMatchesPresentedFrame',
  'requestContextFrameNow',
)
const immediateContextRequest = functionBody(
  'requestContextFrameNow',
  'requestContextFrames',
)
const boundedObservedRequest = functionBody(
  'requestBoundedObservedControlPick',
  'scheduleContextFrame',
)
const beginPending = functionBody('beginPendingBox', 'selectBox')
const answerProbe = functionBody('answerProbe', 'offerHover')
const pointerDownStart = renderer.indexOf("overlay.addEventListener('pointerdown'")
const pointerDownEnd = renderer.indexOf("overlay.addEventListener('pointermove'", pointerDownStart)
const pointerDown =
  pointerDownStart >= 0 && pointerDownEnd > pointerDownStart
    ? renderer.slice(pointerDownStart, pointerDownEnd)
    : ''
const staleClickStart = pointerDown.indexOf(
  'if (!objectIndexMatchesPresentedFrame(hit.d.index))',
)
const staleClickEnd =
  staleClickStart < 0 ? -1 : pointerDown.indexOf('\n  }', staleClickStart)
const staleClickBranch =
  staleClickStart >= 0 && staleClickEnd > staleClickStart
    ? pointerDown.slice(staleClickStart, staleClickEnd)
    : ''

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
  [
    'object index freshness is keyed to each display actual presented time',
    indexFreshness.includes('displayedContextFrameRequests()') &&
      indexFreshness.includes('frameTimesByDisplay.get(displayIndex) === wanted'),
  ],
  [
    'hover cannot advertise an object index from a previous displayed frame',
    answerProbe.indexOf('objectIndexMatchesPresentedFrame(d.index)') >= 0 &&
      answerProbe.indexOf('objectIndexMatchesPresentedFrame(d.index)') <
        answerProbe.indexOf('objectIndexOf(d.index)'),
  ],
  [
    'a click before the 120 ms settle deadline cannot commit the cached object',
    staleClickStart >= 0 &&
      staleClickBranch.includes('requestContextFrameNow(hit.d.index)') &&
      staleClickBranch.includes('return') &&
      staleClickStart < pointerDown.indexOf('const picked = hoverStack'),
  ],
  [
    'the click-triggered context query bypasses and cancels the settle timer',
    immediateContextRequest.includes('window.clearTimeout(frameSettleTimer)') &&
      immediateContextRequest.includes('requestContextFrames(requests)') &&
      !immediateContextRequest.includes('window.setTimeout'),
  ],
  [
    'adjacent observed picking is bounded by two configured video-frame intervals',
    boundedObservedRequest.includes('const frameIntervalMs = 1000 / fps') &&
      boundedObservedRequest.includes('requestedTimeMs - frameIntervalMs * 2') &&
      boundedObservedRequest.includes('requestedTimeMs + frameIntervalMs * 2') &&
      !boundedObservedRequest.includes('30'),
  ],
  [
    'adjacent picking inspects frames without replacing hover or the current index',
    boundedObservedRequest.includes('objectIndexForFrame(on.index, frame)') &&
      boundedObservedRequest.includes('boundedObservedPickFallback({') &&
      boundedObservedRequest.includes(
        'exactControls: exactIndex.controlObjects(',
      ) &&
      !boundedObservedRequest.includes('exactWindow.surfaceId') &&
      !boundedObservedRequest.includes('buildObjectIndex(') &&
      !boundedObservedRequest.includes('setHoverObject('),
  ],
  [
    'exact semantic hits, Shift/window picks, repeat clicks and manual boxes bypass fallback',
    pointerDown.includes("candidate.level === 'control'") &&
      pointerDown.includes("(picked === null || picked.level === 'window')") &&
      pointerDown.includes('!windowLevelKey') &&
      pointerDown.includes('!semanticPointHit') &&
      pointerDown.includes('!repeat') &&
      pointerDown.includes('safeDelayedBox'),
  ],
  [
    'a moved-away target may recover when the exact point is background or empty',
    pointerDown.includes("(picked === null || picked.level === 'window')") &&
      pointerDown.includes('exactIndex.controlObjects(') &&
      !pointerDown.includes('picked.surfaceId'),
  ],
  [
    'a stale adjacent-pick answer cannot move selection after click, seek, or session change',
    pointerDown.includes('observedPickSeq !== observedPickRequestSeq') &&
      pointerDown.includes('contextSessionId !== sessionId') &&
      pointerDown.includes('objectIndexOf(hit.d.index) !== exactIndex') &&
      pointerDown.includes('!objectIndexMatchesPresentedFrame(hit.d.index)') &&
      pointerDown.includes('state.selectedId !== selectedId'),
  ],
  [
    // 0.4.0: the pick instant still comes from the OBSERVED sample rather than
    // the playhead (#81/#85/#111), and it is now spent entirely on the frame
    // whose geometry the box takes. There is no longer a stored pick time,
    // because there is no longer anything that could re-anchor the box away
    // from it — see GOAL "The still is the context".
    'the pick reads its instant from the observed sample, not the playhead',
    renderer.includes('fallback?.observedAtMs') &&
      beginPending.includes(
        'const pickedAt = observedPickedAtMs ?? presentedOn(on.index)',
      ) &&
      !beginPending.includes('pickedAtMs.set('),
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
