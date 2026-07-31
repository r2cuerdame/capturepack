// A WINDOW THAT MOVED BETWEEN DISPLAYS OF DIFFERENT SCALES.
//
// Chromium paints web content in a renderer process carrying its own device
// scale factor. Drag the window from a 150% display to a 100% one and the
// browser frame re-lays out at once while the renderer can still answer with the
// OLD display's scale — so UI Automation reports one window in two coordinate
// spaces: the toolbar exact to the pixel, the page inside it off by the ratio
// between the two displays.
//
// Every number below is measured, from CapturePack_2026-08-01_075525: two Chrome
// windows dragged onto a 1200x1920 @1x display reported web content covering
// 0.67 and 0.50 of the pane they were drawn in — 1/1.5 and 1/2, the two scales
// involved — while Discord, never moved off its own display, reported 1.00. The
// owner's picks in that pack landed on neighbouring video tiles, and the pack
// said in writing that they had picked those.
//
// The rule under test: a web-content root must still COVER the surface it was
// drawn into, or it and everything beneath it is refused. Coverage and not
// containment, because scrolled content legitimately overflows its viewport. A
// refusal and not a correction, because the ratio proves the numbers are wrong
// without revealing what the right ones were.

import { UIA_DOCUMENT_COVERAGE_MIN, parseUiaPayload, refuseDisplacedRenderers } from '../src/main/uia'
import type { UiaElementRecord } from '../src/shared/types'

let failures = 0

function check(name: string, ok: boolean, detail?: string): void {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok && detail !== undefined) console.log(`        ${detail}`)
}

function el(
  depth: number,
  control_type: string,
  x: number,
  y: number,
  width: number,
  height: number,
  name = '',
): UiaElementRecord {
  return {
    name,
    control_type,
    automation_id: '',
    class_name: '',
    bounds: { x, y, width, height },
    depth,
    window: 0,
  }
}

// The YouTube window exactly as the pack recorded it: browser frame at 1x,
// web content at the 1.5x display's layout. Depths are the pack's own.
const displacedChrome: UiaElementRecord[] = [
  el(0, 'Window', 8, 0, 1184, 935, '(338) YouTube - Chrome'),
  el(5, 'Pane', 8, 40, 1184, 80),
  el(6, 'ToolBar', 8, 40, 1184, 46),
  el(7, 'Button', 14, 46, 34, 34, '뒤로'),
  el(7, 'Button', 60, 86, 91, 28, 'Purpleship'),
  el(7, 'Pane', 8, 121, 1184, 814), // the render widget host — correct
  el(8, 'Document', 8, 182, 588, 753, '(338) YouTube'), // 0.50 x 0.93 of its host
  el(9, 'Group', 8, 0, 573, 935),
  el(11, 'Group', 8, 182, 573, 56),
  el(12, 'Group', 8, 0, 194, 249),
  el(12, 'Group', 217, 280, 340, 318), // one of the boxes that landed wrong
  el(12, 'Group', 217, 629, 340, 293),
  el(8, 'TabItem', 36, 0, 256, 41, '(338) YouTube'), // a sibling of the document
]

console.log('A renderer measured for a display its window has left')
{
  const { kept, refused } = refuseDisplacedRenderers(displacedChrome)
  check('the displaced document is refused', refused === 1, `refused ${String(refused)}`)
  check(
    'and its whole subtree goes with it — nothing under it was measured any better',
    !kept.some((e) => e.depth > 8),
    JSON.stringify(kept.filter((e) => e.depth > 8).map((e) => e.bounds)),
  )
  check(
    'the picked tiles specifically are gone',
    !kept.some((e) => e.bounds.x === 217 && e.bounds.width === 340),
    JSON.stringify(kept.map((e) => e.bounds)),
  )
  check(
    'the browser frame is untouched: it was never wrong',
    kept.some((e) => e.name === 'Purpleship' && e.bounds.x === 60 && e.bounds.y === 86) &&
      kept.some((e) => e.control_type === 'ToolBar' && e.bounds.width === 1184),
    JSON.stringify(kept.map((e) => e.name)),
  )
  check(
    'the window itself survives, so the pick still has somewhere honest to land',
    kept[0]?.control_type === 'Window' && kept[0]?.bounds.width === 1184,
    JSON.stringify(kept[0]),
  )
  check(
    'and a sibling AFTER the refused subtree comes back — the cut ends at its depth',
    kept.some((e) => e.control_type === 'TabItem'),
    JSON.stringify(kept.map((e) => e.control_type)),
  )
}

console.log('\nA window that never left its display')
{
  // Discord, from the same pack: document exactly its host, 1.00 coverage.
  const healthy: UiaElementRecord[] = [
    el(0, 'Window', 3121, 0, 1919, 2089, '친구 - Discord'),
    el(6, 'Pane', 3122, 0, 1918, 2089),
    el(7, 'Document', 3122, 0, 1918, 2089, '친구'),
    el(8, 'Group', 3122, 0, 1918, 2089),
    el(10, 'Button', 3135, 6, 40, 36, '뒤로 가기'),
    el(10, 'Text', 4081, 9, 43, 29, '친구'),
  ]
  const { kept, refused } = refuseDisplacedRenderers(healthy)
  check('nothing is refused', refused === 0, `refused ${String(refused)}`)
  check('and every control is still pickable', kept.length === healthy.length, `${String(kept.length)}`)
}

console.log('\nScrolled content is not displaced content')
{
  // Measured live on this desk: YouTube's document body runs from -3869 to 3321
  // inside a viewport of 182..1403. It overflows its host by thousands of pixels
  // and is perfectly correct — which is why the test asks for coverage and never
  // for containment.
  const scrolled: UiaElementRecord[] = [
    el(0, 'Window', -1800, 0, 1800, 1415),
    el(7, 'Pane', -1788, 182, 1776, 1221),
    el(8, 'Document', -1788, 182, 1776, 1221),
    el(9, 'Group', -1788, -3869, 1754, 7190),
    el(12, 'Hyperlink', -1782, 272, 96, 114, '홈'),
  ]
  const { kept, refused } = refuseDisplacedRenderers(scrolled)
  check('a document that overflows its viewport is kept', refused === 0, `refused ${String(refused)}`)
  check(
    'including the link inside it',
    kept.some((e) => e.name === '홈'),
    JSON.stringify(kept.map((e) => e.name)),
  )
}

console.log('\nThe threshold is a threshold, not a coincidence')
{
  const host = { x: 0, y: 0, width: 1000, height: 1000 }
  const at = (f: number): number =>
    refuseDisplacedRenderers([
      el(0, 'Window', host.x, host.y, host.width, host.height),
      el(1, 'Pane', host.x, host.y, host.width, host.height),
      el(2, 'Document', 0, 0, Math.round(1000 * f), Math.round(1000 * f)),
    ]).refused
  check('1/1.5 = 0.67 is refused (the measured case)', at(1 / 1.5) === 1)
  check('1/2 = 0.50 is refused (the measured case)', at(0.5) === 1)
  check('1.00 is kept', at(1) === 0)
  check('just under the line is refused', at(UIA_DOCUMENT_COVERAGE_MIN - 0.01) === 1)
  check('just over it is kept', at(UIA_DOCUMENT_COVERAGE_MIN + 0.01) === 0)
  check(
    'a document LARGER than its host is kept — that is overflow, not displacement',
    at(3) === 0,
  )
}

console.log('\nA host that cannot be measured accuses nobody')
{
  const { refused } = refuseDisplacedRenderers([
    el(0, 'Window', 0, 0, 0, 0),
    el(1, 'Document', 0, 0, 10, 10),
  ])
  check('a zero-sized host proves nothing either way', refused === 0, `refused ${String(refused)}`)
}

console.log('\nA pack written before the test is read through it')
{
  // Re-opening the owner's pack must stop offering the boxes that were wrong
  // when it was written — the file on disk is not re-walked, only re-read.
  const payload = parseUiaPayload(
    JSON.stringify({
      captured_at: '2026-08-01T07:55:25+09:00',
      budget_ms: 3000,
      truncated: false,
      windows: [
        { hwnd: '1', title: 'YouTube', process: 'chrome.exe', class_name: 'Chrome_WidgetWin_1', bounds: { x: 8, y: 0, width: 1184, height: 935 }, z: 0 },
      ],
      elements: displacedChrome.map((e) => ({ ...e, window: 0 })),
    }),
  )
  check('the payload still parses', payload !== null)
  check(
    'but the displaced tiles are not in it',
    payload !== null && !payload.elements.some((e) => e.bounds.x === 217 && e.bounds.width === 340),
    JSON.stringify(payload?.elements.map((e) => e.bounds)),
  )
  check(
    'and the window is, so an old pack stays editable',
    payload !== null && payload.windows.length === 1,
  )
}

console.log('\nEach window is judged on its own')
{
  // Two windows in one file: the depth reset at a window boundary must not let
  // one window's refusal swallow the next window's controls.
  const mixed: UiaElementRecord[] = [
    ...displacedChrome.map((e) => ({ ...e, window: 0 })),
    { ...el(0, 'Window', 3121, 0, 1919, 2089, 'Discord'), window: 1 },
    { ...el(7, 'Document', 3122, 0, 1918, 2089), window: 1 },
    { ...el(10, 'Button', 3135, 6, 40, 36, '뒤로 가기'), window: 1 },
  ]
  const payload = parseUiaPayload(
    JSON.stringify({ captured_at: '', budget_ms: 3000, truncated: false, windows: [], elements: mixed }),
  )
  check(
    "the second window's controls survive the first window's refusal",
    payload !== null && payload.elements.some((e) => e.name === '뒤로 가기'),
    JSON.stringify(payload?.elements.map((e) => e.name)),
  )
}

console.log(failures === 0 ? '\nrenderer-geometry: OK' : `\nrenderer-geometry: ${String(failures)} FAILED`)
process.exit(failures === 0 ? 0 : 1)
