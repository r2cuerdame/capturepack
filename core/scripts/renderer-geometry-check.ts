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

import {
  UIA_DOCUMENT_COVERAGE_MIN,
  mapUiaToSnapshot,
  parseUiaPayload,
  refuseDisplacedRenderers,
} from '../src/main/uia'
import type { UiaRawDump, UiaScreenAccess } from '../src/main/uia'
import {
  makeOverlay,
  onThisDisplay,
  drawOverlay,
  renderedLabelBottomGutter,
  renderedCanvasHeight,
} from '../src/renderer/render/render'
import {
  hitTest,
  drawDisplayLabels,
  sortAnnotationsAscending,
  sortAnnotationsDescending,
} from '../src/renderer/editor/render'
import { EditorState } from '../src/renderer/editor/state'
import type { Annotation, UiaElementRecord } from '../src/shared/types'
import type { RenderStartPayload } from '../src/shared/ipc'

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

console.log('\nA renderer that answers in the coordinates of the OTHER monitor')
{
  // THE CASE THE WALK CANNOT SEE, and the reason this test also runs AFTER the
  // display mapping.
  //
  // `CapturePack_2026-08-01_103452` shipped a document covering 0.497 of its
  // host while the walk itself reported nothing refused. Both are true at once.
  // The mapping is ratio-preserving, so a parent and child mapped through the
  // SAME display cannot come out disagreeing — these were mapped through
  // DIFFERENT ones. `coveringSpace` chooses per element, deliberately (so a
  // window straddling two monitors keeps the children visible on the smaller
  // side), and a rectangle Chromium reported in the coordinates of a display its
  // window has already left falls into the other display's space and is scaled
  // by the other display's factor.
  //
  // The desk below is the one that produced that pack: DISPLAY1 is 1800x2880 of
  // helper space declared as 1200x1920 (2/3); DISPLAY2 is 3840x2160 at 1:1.
  const desk = (
    elements: UiaElementRecord[],
    windowBounds: UiaElementRecord['bounds'],
  ): UiaRawDump => ({
    capturedAt: new Date('2026-08-01T10:34:52+09:00'),
    truncated: false,
    rootBounds: { x: 0, y: 0, width: 3840, height: 2160 },
    monitors: [
      { device: 'DISPLAY1', primary: false, bounds: { x: -1800, y: 0, width: 1800, height: 2880 } },
      { device: 'DISPLAY2', primary: true, bounds: { x: 0, y: 0, width: 3840, height: 2160 } },
    ],
    windows: [
      {
        hwnd: '1',
        title: 'Chrome',
        process: 'chrome.exe',
        class_name: 'Chrome_WidgetWin_1',
        bounds: windowBounds,
        focused: true,
        z: 0,
        tree: 'collected',
        element_count: 0,
      },
    ] as UiaRawDump['windows'],
    elements,
    geometryRefused: 0,
  })

  const targets = [
    { index: 1, focused: false, bounds: { x: -1200, y: 0, width: 1200, height: 1920 }, width: 1200, height: 1920 },
    { index: 2, focused: true, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, width: 3840, height: 2160 },
  ]
  const screenAccess = {
    getAllDisplays: () => [
      { id: 1, bounds: { x: -1200, y: 0, width: 1200, height: 1920 } },
      { id: 2, bounds: { x: 0, y: 0, width: 2560, height: 1440 } },
    ],
    getPrimaryDisplay: () => ({ id: 2, bounds: { x: 0, y: 0, width: 2560, height: 1440 } }),
    dipToScreenRect: (_w: unknown, b: unknown) => ({ ...(b as object) }),
  } as unknown as UiaScreenAccess

  // Window on DISPLAY2; its renderer still answering in DISPLAY1's coordinates.
  const crossed = desk(
    [
      el(0, 'Window', 100, 100, 1500, 1200, 'Chrome'),
      el(7, 'Pane', 100, 100, 1500, 1200),
      el(8, 'Document', -1700, 100, 1500, 1200, 'page'),
      el(12, 'Group', -1600, 300, 400, 300, 'a tile'),
      el(8, 'TabItem', 130, 100, 300, 40, 'a tab'),
    ],
    { x: 100, y: 100, width: 1500, height: 1200 },
  )
  const crossedHost = crossed.elements[1] as UiaElementRecord
  const crossedDoc = crossed.elements[2] as UiaElementRecord
  check(
    'in helper space the displaced child covers its host EXACTLY, so the walk sees nothing wrong',
    refuseDisplacedRenderers(crossed.elements).refused === 0 &&
      crossedDoc.bounds.width / crossedHost.bounds.width === 1,
    `cover ${String(crossedDoc.bounds.width / crossedHost.bounds.width)}`,
  )

  const mapped = mapUiaToSnapshot(crossed, targets, 3000, screenAccess)
  check(
    'but after mapping it is refused — only there are the numbers the pack will carry',
    mapped.geometry_refused === 1 && !mapped.elements.some((e) => e.control_type === 'Document'),
    `refused ${String(mapped.geometry_refused)}, kept ${JSON.stringify(mapped.elements.map((e) => e.control_type))}`,
  )
  check(
    'the tile beneath it goes too',
    !mapped.elements.some((e) => e.name === 'a tile'),
    JSON.stringify(mapped.elements.map((e) => e.name)),
  )
  check(
    'the window and the browser frame stay pickable',
    mapped.elements.some((e) => e.control_type === 'Window') &&
      mapped.elements.some((e) => e.control_type === 'Pane'),
    JSON.stringify(mapped.elements.map((e) => e.control_type)),
  )
  check(
    'and the sibling after the refused subtree comes back',
    mapped.elements.some((e) => e.control_type === 'TabItem'),
    JSON.stringify(mapped.elements.map((e) => e.control_type)),
  )

  // A window wholly on one display maps every child through one transform, so
  // crossing a DPI boundary may never make an honest tree look suspicious.
  const healthyDesk = desk(
    [
      el(0, 'Window', -1788, 182, 1776, 1221, 'Chrome'),
      el(7, 'Pane', -1788, 182, 1776, 1221),
      el(8, 'Document', -1788, 182, 1776, 1221, 'page'),
      el(9, 'Group', -1788, -3869, 1754, 7190),
      el(12, 'Hyperlink', -1782, 272, 96, 114, 'home'),
    ],
    { x: -1788, y: 182, width: 1776, height: 1221 },
  )
  const fine = mapUiaToSnapshot(healthyDesk, targets, 3000, screenAccess)
  check(
    'a window living entirely on the 2/3 display keeps everything, scrolled overflow included',
    fine.geometry_refused === 0 && fine.elements.length === healthyDesk.elements.length,
    `refused ${String(fine.geometry_refused)}, kept ${String(fine.elements.length)}/${String(healthyDesk.elements.length)}`,
  )
  check(
    'and it really was mapped, not passed through: 1776 -> 1184 at 2/3',
    fine.elements[0]?.bounds.width === 1184,
    JSON.stringify(fine.elements[0]?.bounds),
  )
  check(
    'the count is always written, so 0 reads as "looked and found none"',
    Object.hasOwn(fine, 'geometry_refused') && fine.geometry_refused === 0,
  )
}


const createMockContext = () => {
  const badges: string[] = []
  const texts: string[] = []
  const strokeBoxes: Array<{ x: number; y: number; width: number; height: number }> = []
  let blurCount = 0

  const ctx: any = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    imageSmoothingEnabled: true,
    save() {},
    restore() {},
    setTransform() {},
    beginPath() {},
    arc() {},
    roundRect() {},
    fill() {},
    stroke() {},
    strokeRect(x: number, y: number, width: number, height: number) {
      strokeBoxes.push({ x, y, width, height })
    },
    fillRect() {},
    fillText(text: string) {
      if (/^\d+$/.test(text)) {
        badges.push(text)
      } else {
        texts.push(text)
      }
    },
    measureText(text: string) {
      return { width: text.length * 8 }
    },
    drawImage() {
      blurCount += 1
    },
  }

  const canvas: any = {
    width: 1920,
    height: 1080,
    getContext: () => ctx,
  }
  ctx.canvas = canvas

  return { ctx, canvas, badges, texts, strokeBoxes, getBlurCount: () => blurCount }
}

if (typeof (globalThis as any).document === 'undefined') {
  ;(globalThis as any).document = {
    createElement: (tag: string) => {
      if (tag === 'canvas') {
        return {
          width: 100,
          height: 100,
          getContext: () => ({
            drawImage() {},
          }),
        }
      }
      return {}
    },
  }
}

console.log('\nStill keyframe and screenshot overlay geometry across multiple displays (#179)')
{

  const annD1: Annotation = {
    annotation_id: 'ann_d1',
    type: 'box',
    display: 1,
    bounds: { x: 100, y: 100, width: 200, height: 150 },
    text: '', // no label text
    numbered: true,
    blur: false,
    tracking: { enabled: false },
    created_at: '',
    z: 1,
  }

  const annD2Blur: Annotation = {
    annotation_id: 'ann_d2_blur',
    type: 'box',
    display: 2,
    bounds: { x: 50, y: 50, width: 300, height: 200 },
    text: '',
    numbered: true,
    blur: true, // blur on secondary display
    tracking: { enabled: false },
    created_at: '',
    z: 2,
  }

  const annD2Text: Annotation = {
    annotation_id: 'ann_d2_text',
    type: 'box',
    display: 2,
    bounds: { x: 400, y: 300, width: 150, height: 100 },
    text: 'Secondary Screen Button', // text label on secondary display
    numbered: true,
    blur: false,
    tracking: { enabled: false },
    created_at: '',
    z: 3,
  }

  const allAnnotations = [annD1, annD2Blur, annD2Text]
  const displayNumbers: Array<[string, number]> = [
    ['ann_d1', 1],
    ['ann_d2_blur', 2],
    ['ann_d2_text', 3],
  ]

  // Case 1: Still render on Display 1 (focused display 1)
  const jobD1: RenderStartPayload = {
    replayWebm: null,
    width: 1920,
    height: 1080,
    fps: 1,
    durationMs: 0,
    keyframes: true,
    display: 1,
    focusedDisplay: 1,
    annotations: allAnnotations,
    displayNumbers,
  }
  const overlayD1 = makeOverlay(jobD1, 1920, 1080)

  check(
    'onThisDisplay includes Display 1 box on Display 1 still overlay',
    onThisDisplay(annD1, overlayD1) === true,
  )
  check(
    'onThisDisplay excludes Display 2 blur annotation on Display 1 still overlay',
    onThisDisplay(annD2Blur, overlayD1) === false,
  )
  check(
    'onThisDisplay excludes Display 2 text annotation on Display 1 still overlay',
    onThisDisplay(annD2Text, overlayD1) === false,
  )

  const activeD1 = overlayD1.ordered.filter((a) => onThisDisplay(a, overlayD1))
  check(
    'Display 1 still job filters overlay annotations to only Display 1',
    activeD1.length === 1 && activeD1[0]?.annotation_id === 'ann_d1',
    `kept ${JSON.stringify(activeD1.map((a) => a.annotation_id))}`,
  )

  const gutterD1 = renderedLabelBottomGutter(activeD1, overlayD1.ui)
  const unfilteredGutterD1 = renderedLabelBottomGutter(overlayD1.ordered, overlayD1.ui)
  check(
    'Display 1 bottom gutter is 0 when Display 1 annotations have no text',
    gutterD1 === 0,
    `got ${String(gutterD1)}`,
  )
  check(
    'unfiltered gutter would have incorrectly seen Display 2 label text and grown dead space',
    unfilteredGutterD1 > 0,
    `unfiltered ${String(unfilteredGutterD1)}`,
  )
  check(
    'Display 1 still canvas height remains exactly source height without dead band',
    renderedCanvasHeight(1080, gutterD1) === 1080,
    `got ${String(renderedCanvasHeight(1080, gutterD1))}`,
  )

  const mock1 = createMockContext()
  drawOverlay(mock1.ctx, mock1.canvas, overlayD1, null)
  check(
    'drawOverlay(null) on Display 1 does not paint Display 2 blur mask',
    mock1.getBlurCount() === 0,
    `blurCount = ${String(mock1.getBlurCount())}`,
  )
  check(
    'drawOverlay(null) on Display 1 paints only Display 1 box and badge',
    mock1.badges.length === 1 && mock1.badges[0] === '1' && mock1.strokeBoxes.length === 1,
    `badges = ${JSON.stringify(mock1.badges)}, boxes = ${JSON.stringify(mock1.strokeBoxes)}`,
  )
  check(
    'drawOverlay(null) on Display 1 paints no text labels from Display 2',
    mock1.texts.length === 0,
    `texts = ${JSON.stringify(mock1.texts)}`,
  )

  // Case 2: Still render on Display 2
  const jobD2: RenderStartPayload = {
    replayWebm: null,
    width: 2560,
    height: 1440,
    fps: 1,
    durationMs: 0,
    keyframes: true,
    display: 2,
    focusedDisplay: 1,
    annotations: allAnnotations,
    displayNumbers,
  }
  const overlayD2 = makeOverlay(jobD2, 2560, 1440)
  const activeD2 = overlayD2.ordered.filter((a) => onThisDisplay(a, overlayD2))

  check(
    'Display 2 still job filters overlay annotations to only Display 2',
    activeD2.length === 2 && !activeD2.some((a) => a.annotation_id === 'ann_d1'),
    `kept ${JSON.stringify(activeD2.map((a) => a.annotation_id))}`,
  )

  const gutterD2 = renderedLabelBottomGutter(activeD2, overlayD2.ui)
  check(
    'Display 2 bottom gutter is non-zero because Display 2 carries label text',
    gutterD2 > 0,
    `got ${String(gutterD2)}`,
  )
  check(
    'Display 2 still canvas height includes the label gutter',
    renderedCanvasHeight(1440, gutterD2) > 1440,
    `height = ${String(renderedCanvasHeight(1440, gutterD2))}`,
  )

  const mock2 = createMockContext()
  drawOverlay(mock2.ctx, mock2.canvas, overlayD2, null)
  check(
    'drawOverlay(null) on Display 2 applies blur mask for Display 2',
    mock2.getBlurCount() > 0,
    `blurCount = ${String(mock2.getBlurCount())}`,
  )
  check(
    'drawOverlay(null) on Display 2 paints Display 2 badges without Display 1 badge',
    mock2.badges.includes('2') && mock2.badges.includes('3') && !mock2.badges.includes('1'),
    `badges = ${JSON.stringify(mock2.badges)}`,
  )

  // Case 3: Single-display pack (focusedDisplay undefined) draws all boxes
  const jobSingle: RenderStartPayload = {
    replayWebm: null,
    width: 1920,
    height: 1080,
    fps: 1,
    durationMs: 0,
    keyframes: true,
    annotations: [annD1, annD2Text],
  }
  const overlaySingle = makeOverlay(jobSingle, 1920, 1080)
  const activeSingle = overlaySingle.ordered.filter((a) => onThisDisplay(a, overlaySingle))
  check(
    'single-display still job keeps all annotations unconditionally',
    activeSingle.length === 2,
    `kept ${String(activeSingle.length)}`,
  )
}

console.log('\nBoxAnnotation.z omitted and stacking order (SPEC §8.3, Issue #204)')
{
  const noZ1: Annotation = {
    annotation_id: 'ann_noz_1',
    type: 'box',
    bounds: { x: 50, y: 50, width: 200, height: 150 },
    text: 'First Label',
    numbered: true,
    blur: false,
    tracking: { enabled: false },
    created_at: '2026-09-22T00:00:00Z',
  }
  const noZ2: Annotation = {
    annotation_id: 'ann_noz_2',
    type: 'box',
    bounds: { x: 50, y: 50, width: 200, height: 150 },
    text: 'Second Label',
    numbered: true,
    blur: false,
    tracking: { enabled: false },
    created_at: '2026-09-22T00:00:01Z',
  }
  const explicitZHigh: Annotation = {
    annotation_id: 'ann_z_high',
    type: 'box',
    bounds: { x: 50, y: 50, width: 200, height: 150 },
    text: 'Top Label',
    numbered: true,
    blur: false,
    tracking: { enabled: false },
    created_at: '2026-09-22T00:00:02Z',
    z: 10,
  }
  const explicitZLow: Annotation = {
    annotation_id: 'ann_z_low',
    type: 'box',
    bounds: { x: 50, y: 50, width: 200, height: 150 },
    text: 'Bottom Label',
    numbered: true,
    blur: false,
    tracking: { enabled: false },
    created_at: '2026-09-22T00:00:03Z',
    z: -5,
  }

  // 1. makeOverlay ordering
  const jobForward: RenderStartPayload = {
    replayWebm: null,
    width: 1920,
    height: 1080,
    fps: 1,
    durationMs: 0,
    keyframes: true,
    annotations: [noZ1, noZ2],
  }
  const overlayForward = makeOverlay(jobForward, 1920, 1080)
  check(
    'makeOverlay sorts annotations omitting z in array index order',
    overlayForward.ordered.length === 2 &&
      overlayForward.ordered[0]?.annotation_id === 'ann_noz_1' &&
      overlayForward.ordered[1]?.annotation_id === 'ann_noz_2',
    `got ${JSON.stringify(overlayForward.ordered.map((a) => a.annotation_id))}`,
  )

  const jobReverse: RenderStartPayload = {
    replayWebm: null,
    width: 1920,
    height: 1080,
    fps: 1,
    durationMs: 0,
    keyframes: true,
    annotations: [noZ2, noZ1],
  }
  const overlayReverse = makeOverlay(jobReverse, 1920, 1080)
  check(
    'makeOverlay sorts inverted array of annotations omitting z deterministically',
    overlayReverse.ordered.length === 2 &&
      overlayReverse.ordered[0]?.annotation_id === 'ann_noz_2' &&
      overlayReverse.ordered[1]?.annotation_id === 'ann_noz_1',
    `got ${JSON.stringify(overlayReverse.ordered.map((a) => a.annotation_id))}`,
  )

  const jobMixed: RenderStartPayload = {
    replayWebm: null,
    width: 1920,
    height: 1080,
    fps: 1,
    durationMs: 0,
    keyframes: true,
    annotations: [noZ1, explicitZHigh, explicitZLow, noZ2],
  }
  // Indices:
  // noZ1: index 0 (effective z: 0)
  // explicitZHigh: index 1 (z: 10)
  // explicitZLow: index 2 (z: -5)
  // noZ2: index 3 (effective z: 3)
  // Expected ascending sort: explicitZLow (-5), noZ1 (0), noZ2 (3), explicitZHigh (10)
  const overlayMixed = makeOverlay(jobMixed, 1920, 1080)
  const mixedIds = overlayMixed.ordered.map((a) => a.annotation_id)
  check(
    'makeOverlay correctly interleaves explicit z and omitted z fallback',
    mixedIds.join(',') === 'ann_z_low,ann_noz_1,ann_noz_2,ann_z_high',
    `got ${JSON.stringify(mixedIds)}`,
  )

  // 2. sortAnnotationsAscending / sortAnnotationsDescending
  const asc = sortAnnotationsAscending([noZ1, noZ2]).map((a) => a.annotation_id)
  check(
    'sortAnnotationsAscending preserves array order on omitted z',
    asc.join(',') === 'ann_noz_1,ann_noz_2',
    `got ${JSON.stringify(asc)}`,
  )

  const desc = sortAnnotationsDescending([noZ1, noZ2]).map((a) => a.annotation_id)
  check(
    'sortAnnotationsDescending orders later array position first on omitted z (top-most first)',
    desc.join(',') === 'ann_noz_2,ann_noz_1',
    `got ${JSON.stringify(desc)}`,
  )

  // 3. hitTest
  // Overlapping boxes: noZ1 (i=0) and noZ2 (i=1) both cover (100, 100).
  // Later box in array is drawn on top (SPEC §8.3), so hitTest must return noZ2.
  const hitForward = hitTest([noZ1, noZ2], 100, 100, 1)
  check(
    'hitTest returns later array entry on overlapping boxes omitting z',
    hitForward === 'ann_noz_2',
    `got ${String(hitForward)}`,
  )

  const hitReverse = hitTest([noZ2, noZ1], 100, 100, 1)
  check(
    'hitTest with reversed array returns visually topmost (later) box',
    hitReverse === 'ann_noz_1',
    `got ${String(hitReverse)}`,
  )

  const hitMixed = hitTest([explicitZLow, noZ1, explicitZHigh], 100, 100, 1)
  check(
    'hitTest respects explicit higher z over omitted z',
    hitMixed === 'ann_z_high',
    `got ${String(hitMixed)}`,
  )

  // 4. drawDisplayLabels ordering
  const region = { cx: 0, cy: 0, cw: 1920, ch: 1080, cscale: 1, width: 1920, height: 1080 }
  const mockLabels1 = createMockContext()
  drawDisplayLabels(mockLabels1.ctx, region, [noZ1, noZ2], 1)
  check(
    'drawDisplayLabels draws in ascending array index order when z is omitted',
    mockLabels1.texts.length === 2 &&
      mockLabels1.texts[0] === 'First Label' &&
      mockLabels1.texts[1] === 'Second Label',
    `got ${JSON.stringify(mockLabels1.texts)}`,
  )

  const mockLabels2 = createMockContext()
  drawDisplayLabels(mockLabels2.ctx, region, [noZ2, noZ1], 1)
  check(
    'drawDisplayLabels draws in reversed order matching array when z is omitted',
    mockLabels2.texts.length === 2 &&
      mockLabels2.texts[0] === 'Second Label' &&
      mockLabels2.texts[1] === 'First Label',
    `got ${JSON.stringify(mockLabels2.texts)}`,
  )

  // 5. EditorState.nextStamp
  const stateEmpty = new EditorState()
  const stampEmpty = stateEmpty.nextStamp()
  check(
    'EditorState.nextStamp starts at z = 1 for empty annotations',
    stampEmpty.z === 1,
    `got ${String(stampEmpty.z)}`,
  )

  const stateNoZ = new EditorState()
  stateNoZ.restore([noZ1, noZ2]) // 2 annotations with omitted z at indices 0 and 1
  const stampNoZ = stateNoZ.nextStamp()
  check(
    'EditorState.nextStamp computes maxZ from array index when z is omitted',
    stampNoZ.z === 2, // maxZ is 1 (index 1), so nextStamp is maxZ + 1 = 2
    `got ${String(stampNoZ.z)}`,
  )

  const stateExplicit = new EditorState()
  stateExplicit.restore([explicitZHigh]) // z: 10
  const stampExplicit = stateExplicit.nextStamp()
  check(
    'EditorState.nextStamp computes maxZ + 1 from explicit z',
    stampExplicit.z === 11,
    `got ${String(stampExplicit.z)}`,
  )
}

console.log(failures === 0 ? '\nrenderer-geometry: OK' : `\nrenderer-geometry: ${String(failures)} FAILED`)
process.exit(failures === 0 ? 0 : 1)
