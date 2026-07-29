// Native-pixel layout for an explicit "full screen" still capture.
//
// Electron exposes display positions in DIP while desktopCapturer returns one
// native-pixel raster per display. A single global DIP scale would therefore
// resample at least one screen on a mixed-DPI desk. This layout keeps every
// source raster byte-for-byte at native size and joins screens at the edges
// Windows says are adjacent. Disconnected or mirrored layouts fall back to a
// deterministic strip so no captured screen can be hidden behind another.

export interface ImageDesktopRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ImageDesktopSource {
  id: string
  index: number
  bounds: ImageDesktopRect
  scaleFactor: number
  pixelSize: { width: number; height: number }
}

export interface ImageDesktopPlacement extends ImageDesktopSource {
  x: number
  y: number
  width: number
  height: number
}

export interface ImageDesktopLayout {
  width: number
  height: number
  placements: ImageDesktopPlacement[]
}

export interface ImageDesktopBitmap {
  id: string
  width: number
  height: number
  /** Tightly packed native BGRA bytes, four per pixel. */
  bgra: Buffer
}

type Axis = 'x' | 'y'

interface AxisEdge {
  to: number
  delta: number
}

const EDGE_EPSILON = 0.01

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= EDGE_EPSILON
}

function validSource(source: ImageDesktopSource): boolean {
  const { bounds, pixelSize } = source
  return (
    source.id.length > 0 &&
    Number.isInteger(source.index) &&
    source.index >= 1 &&
    Number.isFinite(source.scaleFactor) &&
    source.scaleFactor > 0 &&
    Number.isFinite(bounds.x) &&
    Number.isFinite(bounds.y) &&
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    bounds.width > 0 &&
    bounds.height > 0 &&
    Number.isInteger(pixelSize.width) &&
    Number.isInteger(pixelSize.height) &&
    pixelSize.width > 0 &&
    pixelSize.height > 0
  )
}

function startOf(source: ImageDesktopSource, axis: Axis): number {
  return axis === 'x' ? source.bounds.x : source.bounds.y
}

function dipLengthOf(source: ImageDesktopSource, axis: Axis): number {
  return axis === 'x' ? source.bounds.width : source.bounds.height
}

function pixelLengthOf(source: ImageDesktopSource, axis: Axis): number {
  return axis === 'x' ? source.pixelSize.width : source.pixelSize.height
}

function orthogonalOverlap(
  a: ImageDesktopSource,
  b: ImageDesktopSource,
  axis: Axis,
): boolean {
  const aStart = axis === 'x' ? a.bounds.y : a.bounds.x
  const bStart = axis === 'x' ? b.bounds.y : b.bounds.x
  const aLength = axis === 'x' ? a.bounds.height : a.bounds.width
  const bLength = axis === 'x' ? b.bounds.height : b.bounds.width
  return Math.min(aStart + aLength, bStart + bLength) - Math.max(aStart, bStart) > 0
}

function addEdge(graph: AxisEdge[][], from: number, to: number, delta: number): void {
  graph[from]?.push({ to, delta })
  graph[to]?.push({ to: from, delta: -delta })
}

/**
 * Native origins on one axis.
 *
 * Equal logical starts stay aligned. Touching logical edges stay touching in
 * native pixels. Those two facts cover ordinary horizontal, vertical and
 * mixed-DPI monitor arrangements without scaling either raster.
 */
function axisOrigins(sources: readonly ImageDesktopSource[], axis: Axis): number[] {
  const graph: AxisEdge[][] = sources.map(() => [])
  for (let i = 0; i < sources.length; i += 1) {
    const a = sources[i]
    if (a === undefined) continue
    for (let j = i + 1; j < sources.length; j += 1) {
      const b = sources[j]
      if (b === undefined) continue
      const aStart = startOf(a, axis)
      const bStart = startOf(b, axis)
      const aEnd = aStart + dipLengthOf(a, axis)
      const bEnd = bStart + dipLengthOf(b, axis)
      if (near(aStart, bStart)) {
        addEdge(graph, i, j, 0)
      } else if (orthogonalOverlap(a, b, axis) && near(aEnd, bStart)) {
        addEdge(graph, i, j, pixelLengthOf(a, axis))
      } else if (orthogonalOverlap(a, b, axis) && near(bEnd, aStart)) {
        addEdge(graph, i, j, -pixelLengthOf(b, axis))
      }
    }
  }

  const result = new Array<number>(sources.length).fill(Number.NaN)
  for (let root = 0; root < sources.length; root += 1) {
    if (Number.isFinite(result[root])) continue
    const source = sources[root]
    if (source === undefined) continue
    const dipLength = dipLengthOf(source, axis)
    const density = pixelLengthOf(source, axis) / dipLength
    // Components that have no shared edge still retain their approximate
    // Windows offset. Within a connected component, the graph takes over.
    result[root] = Math.round(startOf(source, axis) * density)
    const queue = [root]
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const from = queue[cursor]
      if (from === undefined) continue
      for (const edge of graph[from] ?? []) {
        if (Number.isFinite(result[edge.to])) continue
        result[edge.to] = (result[from] ?? 0) + edge.delta
        queue.push(edge.to)
      }
    }
  }
  return result
}

function overlaps(a: ImageDesktopPlacement, b: ImageDesktopPlacement): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  )
}

function stripLayout(sources: readonly ImageDesktopSource[]): ImageDesktopLayout {
  const ordered = [...sources].sort(
    (a, b) =>
      a.bounds.x - b.bounds.x ||
      a.bounds.y - b.bounds.y ||
      a.index - b.index,
  )
  let x = 0
  let height = 1
  const placements = ordered.map((source) => {
    const placement: ImageDesktopPlacement = {
      ...source,
      x,
      y: 0,
      width: source.pixelSize.width,
      height: source.pixelSize.height,
    }
    x += placement.width
    height = Math.max(height, placement.height)
    return placement
  })
  return { width: Math.max(1, x), height, placements }
}

export function layoutImageDesktop(
  input: readonly ImageDesktopSource[],
): ImageDesktopLayout {
  if (input.length === 0 || input.some((source) => !validSource(source))) {
    throw new Error('a full-desktop image needs one or more valid displays')
  }
  const sources = [...input]
  const xs = axisOrigins(sources, 'x')
  const ys = axisOrigins(sources, 'y')
  const raw = sources.map((source, index): ImageDesktopPlacement => ({
    ...source,
    x: Math.round(xs[index] ?? 0),
    y: Math.round(ys[index] ?? 0),
    width: source.pixelSize.width,
    height: source.pixelSize.height,
  }))
  const minX = Math.min(...raw.map((placement) => placement.x))
  const minY = Math.min(...raw.map((placement) => placement.y))
  const placements = raw.map((placement) => ({
    ...placement,
    x: placement.x - minX,
    y: placement.y - minY,
  }))

  // Mirrored displays share the same logical rectangle. Keeping both is more
  // important than reproducing that overlap: otherwise the last copy silently
  // erases the first one in the composed PNG.
  for (let i = 0; i < placements.length; i += 1) {
    const a = placements[i]
    if (a === undefined) continue
    for (let j = i + 1; j < placements.length; j += 1) {
      const b = placements[j]
      if (b !== undefined && overlaps(a, b)) return stripLayout(sources)
    }
  }

  const width = Math.max(...placements.map((placement) => placement.x + placement.width))
  const height = Math.max(...placements.map((placement) => placement.y + placement.height))
  return {
    width: Math.max(1, width),
    height: Math.max(1, height),
    placements,
  }
}

/**
 * Copies native display bitmaps into the resolved desktop canvas.
 *
 * This intentionally has no scaling path. A source whose declared native size
 * disagrees with its bytes is rejected rather than silently distorted.
 */
export function composeImageDesktopBitmap(
  layout: ImageDesktopLayout,
  sources: readonly ImageDesktopBitmap[],
): Buffer {
  const bitmap = createImageDesktopBitmap(layout)
  const byId = new Map(sources.map((source) => [source.id, source]))
  for (const placement of layout.placements) {
    const source = byId.get(placement.id)
    if (source === undefined) {
      throw new Error(`captured display ${placement.id} disappeared before composition`)
    }
    placeImageDesktopBitmap(layout, placement, source, bitmap)
  }
  return bitmap
}

export function createImageDesktopBitmap(layout: ImageDesktopLayout): Buffer {
  const byteLength = layout.width * layout.height * 4
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength <= 0 ||
    byteLength > 1_073_741_824
  ) {
    throw new Error(
      `full-desktop image is too large to compose safely: ${layout.width}x${layout.height}`,
    )
  }
  const bitmap = Buffer.allocUnsafe(byteLength)
  bitmap.fill(Buffer.from([0, 0, 0, 255]))
  return bitmap
}

export function placeImageDesktopBitmap(
  layout: ImageDesktopLayout,
  placement: ImageDesktopPlacement,
  source: ImageDesktopBitmap,
  target: Buffer,
): void {
  const rowBytes = placement.width * 4
  if (
    source.id !== placement.id ||
    source.width !== placement.width ||
    source.height !== placement.height ||
    source.bgra.length !== rowBytes * placement.height ||
    target.length !== layout.width * layout.height * 4
  ) {
    throw new Error(`captured display ${placement.index} bitmap size mismatch`)
  }
  for (let row = 0; row < placement.height; row += 1) {
    const sourceStart = row * rowBytes
    const targetStart =
      ((placement.y + row) * layout.width + placement.x) * 4
    source.bgra.copy(
      target,
      targetStart,
      sourceStart,
      sourceStart + rowBytes,
    )
  }
}
