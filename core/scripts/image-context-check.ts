import {
  composeUiaForImageDesktop,
  cropUiaForImage,
} from '../src/main/imageContext'
import type { UiaPluginPayload } from '../src/shared/types'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) console.log(`        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`)
}

const payload: UiaPluginPayload = {
  captured_at: '2026-07-29T22:00:00+09:00',
  budget_ms: 900,
  truncated: false,
  windows: [
    {
      title: 'outside left display',
      process: 'outside',
      class_name: 'Outside',
      display: 1,
      bounds: { x: 0, y: 0, width: 1200, height: 1920 },
      focused: false,
      z: 0,
      tree: 'collected',
      element_count: 1,
    },
    {
      title: 'partly selected',
      process: 'inside',
      class_name: 'Inside',
      // mapUiaToSnapshot omits display for its focused target. The image flow
      // deliberately maps the selected physical monitor as focused and then
      // normalizes it to image-local display 1.
      bounds: { x: 80, y: 40, width: 500, height: 400 },
      focused: true,
      z: 1,
      tree: 'collected',
      element_count: 2,
    },
    {
      title: 'outside crop',
      process: 'secret',
      class_name: 'Secret',
      bounds: { x: 2000, y: 1000, width: 500, height: 400 },
      focused: false,
      z: 2,
      tree: 'collected',
      element_count: 1,
    },
  ],
  elements: [
    {
      name: 'left secret',
      control_type: 'Text',
      automation_id: 'left',
      class_name: '',
      display: 1,
      bounds: { x: 20, y: 20, width: 100, height: 20 },
      depth: 1,
      window: 0,
    },
    {
      name: 'visible button',
      control_type: 'Button',
      automation_id: 'visible',
      class_name: '',
      bounds: { x: 120, y: 90, width: 100, height: 40 },
      depth: 1,
      window: 1,
    },
    {
      name: 'same-window but outside selection',
      control_type: 'Text',
      automation_id: 'outside',
      class_name: '',
      bounds: { x: 500, y: 500, width: 100, height: 40 },
      depth: 1,
      window: 1,
    },
    {
      name: 'right secret',
      control_type: 'Text',
      automation_id: 'right',
      class_name: '',
      bounds: { x: 2050, y: 1050, width: 100, height: 40 },
      depth: 1,
      window: 2,
    },
  ],
}

console.log('IMAGE REGION CONTEXT IS BOUNDED BY THE EXPLICIT PIXELS')
const cropped = cropUiaForImage(
  payload,
  { display: 2, x: 100, y: 60, width: 300, height: 200 },
  2,
)
check('only a window intersecting the crop survives', cropped?.windows.map((w) => w.title), [
  'partly selected',
])
check(
  'focused-source records with no display id normalize into the selected image',
  cropped?.windows.length === 1 && cropped?.elements.length === 1,
  true,
)
check('the surviving window is clipped and translated', cropped?.windows[0]?.bounds, {
  x: 0,
  y: 0,
  width: 300,
  height: 200,
})
check('only the visible child survives', cropped?.elements.map((e) => e.name), ['visible button'])
check('the child is crop-local and its owner is remapped', cropped?.elements[0], {
  name: 'visible button',
  control_type: 'Button',
  automation_id: 'visible',
  class_name: '',
  bounds: { x: 20, y: 30, width: 100, height: 40 },
  depth: 1,
  window: 0,
})
check('the output is a single-image coordinate space', {
  windowDisplay: cropped?.windows[0]?.display,
  elementDisplay: cropped?.elements[0]?.display,
}, {})
check('invalid or empty selections carry no hidden metadata', cropUiaForImage(
  payload,
  { display: 2, x: 3000, y: 1800, width: 100, height: 100 },
  2,
), null)

console.log('\nFULL-DESKTOP CONTEXT USES THE COMPOSED IMAGE COORDINATES')
const desktop = composeUiaForImageDesktop(
  payload,
  [
    {
      id: 'left',
      index: 1,
      bounds: { x: -1200, y: 0, width: 1200, height: 1920 },
      scaleFactor: 1,
      pixelSize: { width: 1200, height: 1920 },
      x: 0,
      y: 0,
      width: 1200,
      height: 1920,
    },
    {
      id: 'primary',
      index: 2,
      bounds: { x: 0, y: 0, width: 2560, height: 1440 },
      scaleFactor: 1.5,
      pixelSize: { width: 3840, height: 2160 },
      x: 1200,
      y: 0,
      width: 3840,
      height: 2160,
    },
  ],
  2,
)
check(
  'every captured display contributes semantic windows',
  desktop?.windows.map((window) => window.title),
  ['outside left display', 'partly selected', 'outside crop'],
)
check(
  'left native coordinates stay unchanged and primary coordinates gain its seam offset',
  desktop?.windows.map((window) => window.bounds),
  [
    { x: 0, y: 0, width: 1200, height: 1920 },
    { x: 1280, y: 40, width: 500, height: 400 },
    { x: 3200, y: 1000, width: 500, height: 400 },
  ],
)
check(
  'flattened desktop objects no longer claim per-display coordinates',
  {
    windowDisplays: desktop?.windows.map((window) => window.display),
    elementDisplays: desktop?.elements.map((element) => element.display),
  },
  {
    windowDisplays: [undefined, undefined, undefined],
    elementDisplays: [undefined, undefined, undefined, undefined],
  },
)

console.log(failures === 0 ? '\nimage-context-check ok' : `\nimage-context-check FAILED (${failures})`)
process.exitCode = failures === 0 ? 0 : 1
