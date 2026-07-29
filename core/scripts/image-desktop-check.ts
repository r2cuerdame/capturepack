import {
  composeImageDesktopBitmap,
  layoutImageDesktop,
  type ImageDesktopLayout,
  type ImageDesktopSource,
} from '../src/main/imageDesktop'

let failed = 0

function check(ok: boolean, message: string): void {
  if (!ok) failed += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${message}`)
}

function same(actual: unknown, expected: unknown, message: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  check(ok, message)
  if (!ok) {
    console.log('        expected:', JSON.stringify(expected))
    console.log('        actual:  ', JSON.stringify(actual))
  }
}

const left: ImageDesktopSource = {
  id: '101',
  index: 1,
  bounds: { x: -1200, y: 0, width: 1200, height: 1920 },
  scaleFactor: 1,
  pixelSize: { width: 1200, height: 1920 },
}
const primary: ImageDesktopSource = {
  id: '202',
  index: 2,
  bounds: { x: 0, y: 0, width: 2560, height: 1440 },
  scaleFactor: 1.5,
  pixelSize: { width: 3840, height: 2160 },
}

console.log('MIXED-DPI VIRTUAL DESKTOP')
const mixed = layoutImageDesktop([left, primary])
same(
  { width: mixed.width, height: mixed.height },
  { width: 5040, height: 2160 },
  'native rasters form one full desktop without DPI resampling',
)
same(
  mixed.placements.map(({ id, x, y, width, height }) => ({
    id,
    x,
    y,
    width,
    height,
  })),
  [
    { id: '101', x: 0, y: 0, width: 1200, height: 1920 },
    { id: '202', x: 1200, y: 0, width: 3840, height: 2160 },
  ],
  'negative-X 1x screen touches the 1.5x primary at the native-pixel seam',
)
const mixedReversed = layoutImageDesktop([primary, left])
same(
  mixedReversed.placements.map(({ id, x, y }) => ({ id, x, y })),
  [
    { id: '202', x: 1200, y: 0 },
    { id: '101', x: 0, y: 0 },
  ],
  'source enumeration order cannot move the mixed-DPI seam',
)

console.log('VERTICAL TOPOLOGY')
const upper: ImageDesktopSource = {
  id: 'upper',
  index: 1,
  bounds: { x: 0, y: -1080, width: 1920, height: 1080 },
  scaleFactor: 1,
  pixelSize: { width: 1920, height: 1080 },
}
const lower: ImageDesktopSource = {
  id: 'lower',
  index: 2,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  scaleFactor: 1,
  pixelSize: { width: 1920, height: 1080 },
}
const vertical = layoutImageDesktop([lower, upper])
same(
  vertical.placements.map(({ id, x, y }) => ({ id, x, y })),
  [
    { id: 'lower', x: 0, y: 1080 },
    { id: 'upper', x: 0, y: 0 },
  ],
  'display enumeration order cannot invert an above/below arrangement',
)
same(
  { width: vertical.width, height: vertical.height },
  { width: 1920, height: 2160 },
  'vertical desktop dimensions include both native screens',
)

console.log('MIRROR SAFETY')
const clone: ImageDesktopSource = {
  ...primary,
  id: 'clone',
  index: 3,
}
const mirrored = layoutImageDesktop([primary, clone])
check(
  mirrored.width === 7680 &&
    mirrored.height === 2160 &&
    mirrored.placements[0]?.x === 0 &&
    mirrored.placements[1]?.x === 3840,
  'mirrored displays fall back to a strip instead of erasing one another',
)

console.log('LOSSLESS PIXEL COMPOSITION')
const pixelLayout: ImageDesktopLayout = {
  width: 3,
  height: 2,
  placements: [
    {
      id: 'a',
      index: 1,
      bounds: { x: 0, y: 0, width: 2, height: 1 },
      scaleFactor: 1,
      pixelSize: { width: 2, height: 1 },
      x: 0,
      y: 0,
      width: 2,
      height: 1,
    },
    {
      id: 'b',
      index: 2,
      bounds: { x: 2, y: 1, width: 1, height: 1 },
      scaleFactor: 1,
      pixelSize: { width: 1, height: 1 },
      x: 2,
      y: 1,
      width: 1,
      height: 1,
    },
  ],
}
const pixels = composeImageDesktopBitmap(pixelLayout, [
  {
    id: 'a',
    width: 2,
    height: 1,
    // BGRA red, then BGRA blue.
    bgra: Buffer.from([0, 0, 255, 255, 255, 0, 0, 255]),
  },
  {
    id: 'b',
    width: 1,
    height: 1,
    // BGRA green.
    bgra: Buffer.from([0, 255, 0, 255]),
  },
])
same(
  [...pixels],
  [
    0, 0, 255, 255,
    255, 0, 0, 255,
    0, 0, 0, 255,
    0, 0, 0, 255,
    0, 0, 0, 255,
    0, 255, 0, 255,
  ],
  'native BGRA pixels are copied exactly and virtual gaps are opaque black',
)

console.log(
  failed === 0
    ? '\nimage-desktop-check ok'
    : `\nimage-desktop-check FAILED (${failed})`,
)
process.exitCode = failed === 0 ? 0 : 1
