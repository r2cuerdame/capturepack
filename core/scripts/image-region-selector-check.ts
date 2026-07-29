// Image-region selector geometry regression check.
//
// The selector window speaks CSS/DIP coordinates while the already-frozen
// screenshot is native pixels. A mixed-DPI desk therefore needs one explicit
// conversion at the trust boundary; the renderer must never guess with the
// primary monitor's scale. This fixture is the owner's reported desk shape:
// a 1x portrait display at negative X next to a 1.5x 4K display.
import {
  imageVirtualDesktopDipBounds,
  resolveImageDesktopRegion,
  resolveImageDesktopRegionFromLocalRect,
  resolveImageRegionIntent,
  type ImageRegionCompositeLayout,
  type ImageRegionSelectorDisplay,
} from '../src/shared/imageRegion'

let failed = 0

function check(ok: boolean, message: string): void {
  if (!ok) failed += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${message}`)
}

function same(actual: unknown, expected: unknown, message: string): void {
  check(JSON.stringify(actual) === JSON.stringify(expected), message)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.log('        expected:', JSON.stringify(expected))
    console.log('        actual:  ', JSON.stringify(actual))
  }
}

const left: ImageRegionSelectorDisplay = {
  id: 'left-negative',
  index: 1,
  bounds: { x: -1200, y: 0, width: 1200, height: 1920 },
  scaleFactor: 1,
  pixelSize: { width: 1200, height: 1920 },
}

const primary: ImageRegionSelectorDisplay = {
  id: 'primary-150',
  index: 2,
  bounds: { x: 0, y: 0, width: 2560, height: 1440 },
  scaleFactor: 1.5,
  pixelSize: { width: 3840, height: 2160 },
}
const mixedDesktop: ImageRegionCompositeLayout = {
  width: 5040,
  height: 2160,
  placements: [
    { id: left.id, index: left.index, x: 0, y: 0, width: 1200, height: 1920 },
    { id: primary.id, index: primary.index, x: 1200, y: 0, width: 3840, height: 2160 },
  ],
}

console.log('SEAMLESS ALL-MONITOR DRAG')
same(
  imageVirtualDesktopDipBounds([primary, left]),
  { x: -1200, y: 0, width: 3760, height: 1920 },
  'the virtual overlay starts at the negative desktop origin and spans every display',
)
const acrossSeam = resolveImageDesktopRegion(
  [left, primary],
  mixedDesktop,
  { x: -300, y: 100, width: 600, height: 400 },
)
same(
  acrossSeam,
  {
    desktopDipRect: { x: -300, y: 100, width: 600, height: 400 },
    compositePixelRect: { x: 900, y: 100, width: 750, height: 650 },
    displayIds: ['left-negative', 'primary-150'],
    displayIndices: [1, 2],
  },
  'one drag crosses the 1x/1.5x seam and crops both native rasters without a monitor boundary',
)
same(
  resolveImageDesktopRegion(
    [primary, left],
    {
      ...mixedDesktop,
      placements: [...mixedDesktop.placements].reverse(),
    },
    { x: 300, y: 500, width: -600, height: -400 },
  ),
  acrossSeam,
  'reverse drag and display enumeration order cannot move the cross-monitor crop',
)
same(
  resolveImageDesktopRegionFromLocalRect(
    [left, primary],
    mixedDesktop,
    { x: 900, y: 100, width: 600, height: 400 },
  ),
  acrossSeam,
  'local coordinates from the virtual overlay resolve through its negative desktop origin',
)

const fractionalSeam = resolveImageDesktopRegion(
  [left, primary],
  mixedDesktop,
  { x: -0.4, y: 0.4, width: 0.8, height: 0.7 },
)
same(
  fractionalSeam,
  {
    desktopDipRect: {
      x: -1,
      y: 0,
      width: 1.6666666666666665,
      height: 2,
    },
    compositePixelRect: { x: 1199, y: 0, width: 2, height: 2 },
    displayIds: ['left-negative', 'primary-150'],
    displayIndices: [1, 2],
  },
  'each side of a fractional mixed-DPI seam expands with that display native pixel grid',
)
check(
  resolveImageDesktopRegion(
    [left, primary],
    mixedDesktop,
    { x: 5000, y: 5000, width: 100, height: 100 },
  ) === null,
  'a drag wholly outside every real display cannot capture compositor gap pixels',
)

console.log('STAGGERED VERTICAL SEAM')
const upper: ImageRegionSelectorDisplay = {
  id: 'upper-100',
  index: 1,
  bounds: { x: 0, y: -900, width: 1600, height: 900 },
  scaleFactor: 1,
  pixelSize: { width: 1600, height: 900 },
}
const lower: ImageRegionSelectorDisplay = {
  id: 'lower-200',
  index: 2,
  bounds: { x: 400, y: 0, width: 1200, height: 800 },
  scaleFactor: 2,
  pixelSize: { width: 2400, height: 1600 },
}
const verticalDesktop: ImageRegionCompositeLayout = {
  width: 3200,
  height: 2500,
  placements: [
    { id: upper.id, index: upper.index, x: 0, y: 0, width: 1600, height: 900 },
    { id: lower.id, index: lower.index, x: 800, y: 900, width: 2400, height: 1600 },
  ],
}
same(
  resolveImageDesktopRegion(
    [upper, lower],
    verticalDesktop,
    { x: 500, y: -100, width: 200, height: 200 },
  ),
  {
    desktopDipRect: { x: 500, y: -100, width: 200, height: 200 },
    compositePixelRect: { x: 500, y: 800, width: 900, height: 300 },
    displayIds: ['upper-100', 'lower-200'],
    displayIndices: [1, 2],
  },
  'a vertical mixed-DPI seam uses native placement X/Y instead of one global scale',
)
check(
  resolveImageDesktopRegion(
    [upper, lower],
    { ...verticalDesktop, width: 3199 },
    { x: 500, y: -100, width: 200, height: 200 },
  ) === null,
  'a crop is rejected when a placement extends beyond the frozen composite',
)

console.log('NEGATIVE ORIGIN + MIXED DPI')
const leftRegion = resolveImageRegionIntent(left, {
  mode: 'region',
  localDipRect: { x: 60, y: 100, width: 720, height: 480 },
})
same(
  leftRegion,
  {
    mode: 'region',
    displayId: 'left-negative',
    displayIndex: 1,
    pixelRect: { x: 60, y: 100, width: 720, height: 480 },
    desktopDipRect: { x: -1140, y: 100, width: 720, height: 480 },
  },
  'negative desktop origin is added only after local-to-native conversion',
)

const primaryRegion = resolveImageRegionIntent(primary, {
  mode: 'region',
  localDipRect: { x: 100, y: 50, width: 600, height: 400 },
})
same(
  primaryRegion,
  {
    mode: 'region',
    displayId: 'primary-150',
    displayIndex: 2,
    pixelRect: { x: 150, y: 75, width: 900, height: 600 },
    desktopDipRect: { x: 100, y: 50, width: 600, height: 400 },
  },
  'the 1.5x display uses its own frozen raster dimensions',
)

console.log('EDGE COVERAGE + CLAMP')
const fractional = resolveImageRegionIntent(primary, {
  mode: 'region',
  localDipRect: { x: 0.4, y: 0.4, width: 0.7, height: 0.7 },
})
same(
  fractional?.pixelRect,
  { x: 0, y: 0, width: 2, height: 2 },
  'fractional DIP edges expand outward so selected native pixels are not lost',
)

const clamped = resolveImageRegionIntent(primary, {
  mode: 'region',
  localDipRect: { x: 2700, y: 1600, width: -2800, height: -1700 },
})
same(
  clamped,
  {
    mode: 'region',
    displayId: 'primary-150',
    displayIndex: 2,
    pixelRect: { x: 0, y: 0, width: 3840, height: 2160 },
    desktopDipRect: { x: 0, y: 0, width: 2560, height: 1440 },
  },
  'a reversed drag beyond every edge clamps to exactly one display',
)

check(
  resolveImageRegionIntent(primary, {
    mode: 'region',
    localDipRect: { x: 50, y: 50, width: 0, height: 100 },
  }) === null,
  'an empty drag cannot become a one-pixel accidental capture',
)

console.log('FULLSCREEN + CANCEL')
same(
  resolveImageRegionIntent(left, { mode: 'fullscreen' }),
  {
    mode: 'fullscreen',
    displayId: 'left-negative',
    displayIndex: 1,
    pixelRect: { x: 0, y: 0, width: 1200, height: 1920 },
    desktopDipRect: { x: -1200, y: 0, width: 1200, height: 1920 },
  },
  'fullscreen commit identifies the trusted overlay; Main expands it to all displays',
)
check(
  resolveImageRegionIntent(primary, { mode: 'cancel' }) === null,
  'cancel returns no geometry and therefore cannot persist hidden pixels',
)

console.log(
  failed === 0
    ? '\nimage-region-selector-check ok'
    : `\nimage-region-selector-check FAILED (${failed})`,
)
process.exitCode = failed === 0 ? 0 : 1
