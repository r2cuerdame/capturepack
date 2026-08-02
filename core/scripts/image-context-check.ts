import {
  composeUiaForImageDesktop,
  cropUiaForImage,
  imageWindowObservation,
  mergeImageWindowFloor,
} from '../src/main/imageContext'
import { mapUiaToSnapshot } from '../src/main/uia'
import {
  candidatesOf,
  claimsOf,
  mintSurfaceIds,
  surfaceSamplesOf,
} from '../src/main/context/buffer'
import type { ContextObservation } from '../src/main/context/buffer'
import { ObjectIndex } from '../src/renderer/editor/objects'
import type { UiaPluginPayload } from '../src/shared/types'
import type { UiaRawDump, UiaScreenAccess } from '../src/main/uia'

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

console.log('\nA CONTROL FOLLOWS ITS OWN MONITOR ACROSS A MIXED-DPI SEAM')
const fixedScreens: UiaScreenAccess = {
  getAllDisplays: () => [
    { id: 10, bounds: { x: -1200, y: 0, width: 1200, height: 1920 } },
    { id: 20, bounds: { x: 0, y: 0, width: 2560, height: 1440 } },
  ],
  getPrimaryDisplay: () => ({
    id: 20,
    bounds: { x: 0, y: 0, width: 2560, height: 1440 },
  }),
  dipToScreenRect: (_window, bounds) => ({ ...bounds }),
}
const seamRaw: UiaRawDump = {
  capturedAt: new Date('2026-07-30T02:00:00.000Z'),
  truncated: false,
  geometryRefused: 0,
  rootBounds: { x: 0, y: 0, width: 2560, height: 1440 },
  monitors: [
    {
      device: '\\\\.\\DISPLAY2',
      primary: false,
      bounds: { x: -1200, y: 0, width: 1200, height: 1920 },
    },
    {
      device: '\\\\.\\DISPLAY1',
      primary: true,
      bounds: { x: 0, y: 0, width: 2560, height: 1440 },
    },
  ],
  windows: [{
    hwnd: 'seam-window',
    title: 'Seam app',
    process: 'seam.exe',
    class_name: 'SeamWindow',
    // Most of the window is on the primary/right display.
    bounds: { x: -100, y: 100, width: 500, height: 500 },
    focused: true,
    z: 0,
    tree: 'collected',
    element_count: 1,
  }],
  elements: [{
    name: 'Left-side action',
    control_type: 'Button',
    automation_id: 'left-action',
    class_name: 'Button',
    // The child is wholly on the smaller/left side of its owner.
    bounds: { x: -80, y: 160, width: 60, height: 30 },
    depth: 1,
    window: 0,
  }],
}
const seamMapped = mapUiaToSnapshot(
  seamRaw,
  [
    {
      index: 1,
      focused: false,
      bounds: { x: -1200, y: 0, width: 1200, height: 1920 },
      width: 1200,
      height: 1920,
    },
    {
      index: 2,
      focused: true,
      bounds: { x: 0, y: 0, width: 2560, height: 1440 },
      width: 3840,
      height: 2160,
    },
  ],
  3000,
  fixedScreens,
)
check(
  'the seam child is mapped by its own rectangle, not its owner dominant display',
  {
    windowDisplay: seamMapped.windows[0]?.display,
    elementDisplay: seamMapped.elements[0]?.display,
    elementBounds: seamMapped.elements[0]?.bounds,
  },
  {
    windowDisplay: undefined,
    elementDisplay: 1,
    elementBounds: { x: 1120, y: 160, width: 60, height: 30 },
  },
)
const seamDesktop = composeUiaForImageDesktop(
  seamMapped,
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
  'full-desktop composition retains the child on the smaller side',
  seamDesktop?.elements.map((element) => ({
    name: element.name,
    bounds: element.bounds,
    window: element.window,
  })),
  [{
    name: 'Left-side action',
    bounds: { x: 1120, y: 160, width: 60, height: 30 },
    window: 0,
  }],
)
if (seamDesktop !== null) {
  const seamObservation: ContextObservation = {
    tMs: 0,
    windows: seamDesktop.windows.map((window) => ({
      ...window,
      display: 1,
      hasControls: window.element_count > 0,
    })),
    elements: seamDesktop.elements.map((element) => ({ ...element, display: 1 })),
  }
  const seamIds = mintSurfaceIds([seamObservation])
  const seamSample = surfaceSamplesOf([seamObservation], seamIds)[0]
  const seamAccuracy = {
    requestedTimeMs: 0,
    materializedTimeMs: 0,
    errorMs: 0,
    exact: true,
    coverage: 'covered' as const,
  }
  const seamCandidates = candidatesOf(seamObservation, seamIds, seamAccuracy)
  const seamClaims = claimsOf(seamObservation, seamIds)
  const seamSurfaceId = seamSample?.surfaces[0]?.surfaceId
  const seamIndex = ObjectIndex.build(
    seamCandidates,
    seamSample?.surfaces ?? [],
    seamSurfaceId === undefined ? [] : [{ surfaceId: seamSurfaceId, state: 'recorded' }],
    seamClaims,
    5040,
    2160,
    1,
  )
  const seamPick = seamIndex.pick(1150, 175)
  check(
    'the real editor index can pick the seam child inside its reunited owner claim',
    seamPick === null ? null : [seamPick.level, seamPick.candidate.name],
    ['control', 'Left-side action'],
  )
}

console.log('\nSTILL IMAGES KEEP A TRIGGER-TIME WIN32 WINDOW FLOOR')
const ringSource: ContextObservation = {
  tMs: 0,
  windows: [
    {
      surface_id: 'app-window',
      hwnd: '100',
      title: 'Visible app',
      process: 'visible.exe',
      class_name: 'VisibleWindow',
      bounds: { x: 1000, y: 100, width: 200, height: 500 },
      display: 1,
      focused: true,
      z: 0,
      hasControls: false,
      tree: 'skipped',
    },
    {
      surface_id: 'app-window',
      hwnd: '100',
      title: 'Visible app',
      process: 'visible.exe',
      class_name: 'VisibleWindow',
      bounds: { x: 0, y: 100, width: 300, height: 500 },
      display: 2,
      focused: true,
      z: 0,
      hasControls: false,
      tree: 'skipped',
    },
  ],
  elements: [],
}
const placements = [
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
    id: 'right',
    index: 2,
    bounds: { x: 0, y: 0, width: 1200, height: 1920 },
    scaleFactor: 1,
    pixelSize: { width: 1200, height: 1920 },
    x: 1200,
    y: 0,
    width: 1200,
    height: 1920,
  },
]
const floor = imageWindowObservation(
  ringSource,
  placements,
  { x: 1100, y: 0, width: 300, height: 900 },
)
check(
  'a straddling program is reunited and clipped in crop-local coordinates',
  floor?.windows.map((window) => ({
    hwnd: window.hwnd,
    bounds: window.bounds,
    display: window.display,
    tree: window.tree,
  })),
  [{
    hwnd: '100',
    bounds: { x: 0, y: 100, width: 300, height: 500 },
    display: 1,
    tree: 'skipped',
  }],
)
const noUia = mergeImageWindowFloor(null, floor, '2026-07-30T11:00:00+09:00')
check(
  'UIA off/failure still persists the visible program as a selectable window',
  {
    windows: noUia?.windows.map((window) => [window.hwnd, window.title, window.tree]),
    elements: noUia?.elements.length,
  },
  { windows: [['100', 'Visible app', 'skipped']], elements: 0 },
)

// A CLIENT RECTANGLE IS A MEASURING STICK, SO IT IS TRANSLATED AND NEVER
// CLIPPED (#136) — the rule ringObservations.ts already applies on the temporal
// path, now applied here because this rectangle is WRITTEN to the pack.
//
// The window below is 400 px wide with a 20 px frame each side; the crop keeps
// only its left 200 px. Clip the client rectangle to that crop and the derived
// scale is 180/400 of the truth, so every element of the page inside it lands at
// 45% size and shifted — inside the reader's own agreement band, so never
// refused, just wrong. Translated, the stick keeps its length and points off the
// left edge at a negative x, which is exactly what it means.
const cropSource: ContextObservation = {
  tMs: 0,
  windows: [
    {
      surface_id: 'browser',
      hwnd: '200',
      title: 'Page - Chrome',
      process: 'chrome.exe',
      class_name: 'Chrome_WidgetWin_1',
      bounds: { x: 100, y: 100, width: 400, height: 300 },
      client_bounds: { x: 120, y: 160, width: 360, height: 220 },
      display: 1,
      focused: true,
      z: 0,
      hasControls: false,
      tree: 'skipped',
    },
  ],
  elements: [],
}
const cropPlacement = [{
  id: 'only',
  index: 1,
  bounds: { x: 0, y: 0, width: 1200, height: 1920 },
  scaleFactor: 1,
  pixelSize: { width: 1200, height: 1920 },
  x: 0,
  y: 0,
  width: 1200,
  height: 1920,
}]
const cropFloor = imageWindowObservation(
  cropSource,
  cropPlacement,
  { x: 300, y: 150, width: 200, height: 400 },
)
check(
  'a cropped still keeps the client rectangle at full size, in crop-local coordinates',
  cropFloor?.windows.map((w) => ({ bounds: w.bounds, client_bounds: w.client_bounds })),
  [{
    // The visible part of the window: clipped, because a WINDOW is a region.
    bounds: { x: 0, y: 0, width: 200, height: 250 },
    // The drawable rectangle: whole, translated by the crop origin only.
    client_bounds: { x: -180, y: 10, width: 360, height: 220 },
  }],
)
const croppedPayload = mergeImageWindowFloor(null, cropFloor, '2026-07-30T11:00:00+09:00')
check(
  'and writes that same rectangle into the payload a reader will reopen',
  croppedPayload?.windows.map((w) => w.client_bounds),
  [{ x: -180, y: 10, width: 360, height: 220 }],
)
const seamSlicePayload = composeUiaForImageDesktop(
  {
    captured_at: '2026-07-30T11:00:00+09:00',
    budget_ms: 3000,
    truncated: false,
    windows: [{
      hwnd: '100',
      title: 'Visible app',
      process: 'visible',
      class_name: 'VisibleWindow',
      // The source really crosses this captured display's left edge. The
      // composer records that provenance while clipping it to x=0..100.
      bounds: { x: -200, y: 100, width: 300, height: 500 },
      focused: true,
      z: 0,
      tree: 'collected',
      element_count: 1,
    }],
    elements: [{
      name: 'Seam-side action',
      control_type: 'Button',
      automation_id: 'seam-action',
      class_name: 'Button',
      bounds: { x: 20, y: 140, width: 60, height: 30 },
      depth: 1,
      window: 0,
    }],
  },
  [{
    id: 'fixture',
    index: 1,
    bounds: { x: 0, y: 0, width: 300, height: 900 },
    scaleFactor: 1,
    pixelSize: { width: 300, height: 900 },
    x: 0,
    y: 0,
    width: 300,
    height: 900,
  }],
  1,
)
const seamSliceMerged = mergeImageWindowFloor(
  seamSlicePayload,
  floor,
  '2026-07-30T11:00:00+09:00',
)
check(
  'a materially clipped monitor-seam slice still refines the reunited trigger window',
  seamSliceMerged?.elements.map((element) => element.name),
  ['Seam-side action'],
)

const delayedUia: UiaPluginPayload = {
  captured_at: '2026-07-30T11:00:01+09:00',
  budget_ms: 3000,
  truncated: false,
  windows: [
    {
      hwnd: '999',
      title: 'CapturePack selector',
      process: 'CapturePack',
      class_name: 'Chrome_WidgetWin_1',
      bounds: { x: 0, y: 0, width: 300, height: 900 },
      focused: true,
      z: 0,
      tree: 'collected',
      element_count: 1,
    },
    {
      hwnd: '100',
      title: 'Visible app',
      process: 'visible',
      class_name: 'VisibleWindow',
      bounds: { x: 0, y: 100, width: 300, height: 500 },
      focused: false,
      z: 1,
      tree: 'collected',
      element_count: 1,
    },
  ],
  elements: [
    {
      name: 'Full-screen overlay',
      control_type: 'Pane',
      automation_id: 'selector',
      class_name: '',
      bounds: { x: 0, y: 0, width: 300, height: 900 },
      depth: 0,
      window: 0,
    },
    {
      name: 'Save',
      control_type: 'Button',
      automation_id: 'save',
      class_name: 'Button',
      bounds: { x: 40, y: 140, width: 80, height: 32 },
      depth: 1,
      window: 1,
    },
  ],
}
const merged = mergeImageWindowFloor(
  delayedUia,
  floor,
  '2026-07-30T11:00:00+09:00',
)
check(
  'a selector observed after the raster freeze is rejected, not allowed to shadow the image',
  {
    windows: merged?.windows.map((window) => window.title),
    elements: merged?.elements.map((element) => element.name),
  },
  { windows: ['Visible app'], elements: ['Save'] },
)
const noFloorFiltered = mergeImageWindowFloor(
  delayedUia,
  null,
  '2026-07-30T11:00:00+09:00',
  ['999'],
)
check(
  'known selector HWND is removed even when the trigger-time floor is unavailable',
  {
    windows: noFloorFiltered?.windows.map((window) => [window.hwnd, window.z]),
    elements: noFloorFiltered?.elements.map((element) => [element.name, element.window]),
  },
  {
    windows: [['100', 0]],
    elements: [['Save', 0]],
  },
)
const movedLateUia: UiaPluginPayload = {
  captured_at: '2026-07-30T11:00:01+09:00',
  budget_ms: 3000,
  truncated: false,
  windows: [{
    hwnd: '100',
    title: 'Visible app',
    process: 'visible',
    class_name: 'VisibleWindow',
    bounds: { x: 220, y: 100, width: 300, height: 500 },
    focused: true,
    z: 0,
    tree: 'collected',
    element_count: 1,
  }],
  elements: [{
    name: 'Appeared after trigger',
    control_type: 'Button',
    automation_id: 'late',
    class_name: 'Button',
    bounds: { x: 240, y: 140, width: 100, height: 40 },
    depth: 1,
    window: 0,
  }],
}
const movedLateMerged = mergeImageWindowFloor(
  movedLateUia,
  floor,
  '2026-07-30T11:00:00+09:00',
)
check(
  'same-HWND context from a materially moved post-trigger window is rejected',
  movedLateMerged?.elements.map((element) => element.name),
  [],
)
const resizedInsideUia: UiaPluginPayload = {
  captured_at: '2026-07-30T11:00:01+09:00',
  budget_ms: 3000,
  truncated: false,
  windows: [{
    hwnd: '100',
    title: 'Visible app',
    process: 'visible',
    class_name: 'VisibleWindow',
    // A post-trigger horizontal resize preserves the full vertical span and
    // is indistinguishable from a seam by geometry alone. It carries no
    // composer provenance and must therefore be rejected.
    bounds: { x: 0, y: 100, width: 100, height: 500 },
    focused: true,
    z: 0,
    tree: 'collected',
    element_count: 1,
  }],
  elements: [{
    name: 'Inside only after resize',
    control_type: 'Button',
    automation_id: 'late-resize',
    class_name: 'Button',
    bounds: { x: 20, y: 140, width: 60, height: 30 },
    depth: 1,
    window: 0,
  }],
}
const resizedInsideMerged = mergeImageWindowFloor(
  resizedInsideUia,
  floor,
  '2026-07-30T11:00:00+09:00',
)
check(
  'same-HWND one-axis resize is not mistaken for a provenance-backed seam slice',
  resizedInsideMerged?.elements.map((element) => element.name),
  [],
)

const duplicateFloor: ContextObservation = {
  tMs: 0,
  windows: [
    {
      title: 'Same title',
      process: 'chrome.exe',
      class_name: 'Chrome_WidgetWin_1',
      bounds: { x: 0, y: 0, width: 500, height: 500 },
      display: 1,
      focused: true,
      z: 0,
      hasControls: false,
      tree: 'skipped',
    },
    {
      title: 'Same title',
      process: 'chrome.exe',
      class_name: 'Chrome_WidgetWin_1',
      bounds: { x: 700, y: 0, width: 500, height: 500 },
      display: 1,
      focused: false,
      z: 1,
      hasControls: false,
      tree: 'skipped',
    },
  ],
  elements: [],
}
const duplicatePayload: UiaPluginPayload = {
  captured_at: '2026-07-30T11:00:00+09:00',
  budget_ms: 3000,
  truncated: false,
  // Deliberately reversed: first-match matching attaches both trees wrongly.
  windows: [
    {
      title: 'Same title',
      process: 'chrome',
      class_name: 'Chrome_WidgetWin_1',
      bounds: { x: 700, y: 0, width: 500, height: 500 },
      focused: false,
      z: 0,
      tree: 'collected',
      element_count: 1,
    },
    {
      title: 'Same title',
      process: 'chrome',
      class_name: 'Chrome_WidgetWin_1',
      bounds: { x: 0, y: 0, width: 500, height: 500 },
      focused: true,
      z: 1,
      tree: 'collected',
      element_count: 1,
    },
  ],
  elements: [
    {
      name: 'Right action',
      control_type: 'Button',
      automation_id: 'right',
      class_name: 'Button',
      bounds: { x: 760, y: 80, width: 100, height: 40 },
      depth: 1,
      window: 0,
    },
    {
      name: 'Left action',
      control_type: 'Button',
      automation_id: 'left',
      class_name: 'Button',
      bounds: { x: 60, y: 80, width: 100, height: 40 },
      depth: 1,
      window: 1,
    },
  ],
}
const duplicateMerged = mergeImageWindowFloor(
  duplicatePayload,
  duplicateFloor,
  '2026-07-30T11:00:00+09:00',
)
check(
  'legacy duplicate-title windows bind controls to the nearest rectangle',
  duplicateMerged?.elements.map((element) => [element.name, element.window]),
  [['Left action', 0], ['Right action', 1]],
)

console.log(failures === 0 ? '\nimage-context-check ok' : `\nimage-context-check FAILED (${failures})`)
process.exitCode = failures === 0 ? 0 : 1
