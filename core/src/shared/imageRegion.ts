/**
 * Pure geometry contract for the image-region selector.
 *
 * The overlay is a BrowserWindow and therefore reports CSS device-independent
 * pixels. The source image was frozen BEFORE any overlay opened and lives in
 * native pixels. Keeping the frozen raster size in this contract is important:
 * `scaleFactor` describes Windows' nominal relationship, but the actual
 * snapshot dimensions are the evidence that will be cropped.
 */

export interface ImageRegionPoint {
  x: number
  y: number
}

export interface ImageRegionRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ImageRegionSize {
  width: number
  height: number
}

export interface ImageRegionSelectorDisplay {
  /** Electron display id serialized as a string; it is runtime-only. */
  id: string
  /** 1-based CapturePack display index. */
  index: number
  /** This one display's placement in virtual-desktop DIP coordinates. */
  bounds: ImageRegionRect
  scaleFactor: number
  /** Exact dimensions of the already-frozen source image. */
  pixelSize: ImageRegionSize
}

export type ImageRegionIntent =
  | { mode: 'region'; localDipRect: ImageRegionRect }
  | { mode: 'fullscreen' }
  | { mode: 'cancel' }

export interface ImageRegionSelection {
  mode: 'region' | 'fullscreen'
  /**
   * Display that owns the editor placement for this selection. A region may
   * cross several displays; in that case this is the display with the largest
   * DIP overlap (the trigger/focused display wins an exact tie).
   */
  displayId: string
  displayIndex: number
  /** Crop inside the already-frozen all-display composite. */
  pixelRect: ImageRegionRect
  /**
   * The same exact pixel edges projected back onto the virtual desktop.
   * Region-pack writers can persist this as crop_bounds without redoing DPI
   * math or silently rounding the selection a second time.
   */
  desktopDipRect: ImageRegionRect
}

/**
 * The part of a frozen all-monitor bitmap occupied by one display.
 *
 * This deliberately mirrors (without importing) ImageDesktopPlacement from
 * Main. The selector geometry is shared with a sandboxed renderer, while the
 * bitmap compositor is Main-only; structural typing lets Main pass its layout
 * here without pulling Electron/Buffer code across that boundary.
 */
export interface ImageRegionCompositePlacement {
  id: string
  index: number
  x: number
  y: number
  width: number
  height: number
}

export interface ImageRegionCompositeLayout {
  width: number
  height: number
  placements: readonly ImageRegionCompositePlacement[]
}

export interface ImageDesktopRegionSelection {
  /**
   * Outward-aligned bounds in the Windows virtual-desktop DIP coordinate
   * space. With mixed DPI there is no one global DIP-to-pixel scale, so every
   * touched display is aligned independently before these bounds are united.
   */
  desktopDipRect: ImageRegionRect
  /** Crop inside the already-composed, native-pixel all-monitor bitmap. */
  compositePixelRect: ImageRegionRect
  /** Every display contributing real pixels to the rectangular crop. */
  displayIds: string[]
  displayIndices: number[]
}

function finite(value: number): boolean {
  return Number.isFinite(value)
}

export function validImageRegionDisplay(display: ImageRegionSelectorDisplay): boolean {
  return (
    display.id.length > 0 &&
    Number.isInteger(display.index) &&
    display.index > 0 &&
    finite(display.bounds.x) &&
    finite(display.bounds.y) &&
    finite(display.bounds.width) &&
    display.bounds.width > 0 &&
    finite(display.bounds.height) &&
    display.bounds.height > 0 &&
    finite(display.scaleFactor) &&
    display.scaleFactor > 0 &&
    Number.isInteger(display.pixelSize.width) &&
    display.pixelSize.width > 0 &&
    Number.isInteger(display.pixelSize.height) &&
    display.pixelSize.height > 0
  )
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

function cleanZero(value: number): number {
  return Object.is(value, -0) ? 0 : value
}

function normalizedRect(rect: ImageRegionRect): ImageRegionRect | null {
  if (
    !finite(rect.x) ||
    !finite(rect.y) ||
    !finite(rect.width) ||
    !finite(rect.height) ||
    rect.width === 0 ||
    rect.height === 0
  ) {
    return null
  }
  const right = rect.x + rect.width
  const bottom = rect.y + rect.height
  if (!finite(right) || !finite(bottom)) return null
  return {
    x: cleanZero(Math.min(rect.x, right)),
    y: cleanZero(Math.min(rect.y, bottom)),
    width: Math.abs(rect.width),
    height: Math.abs(rect.height),
  }
}

function intersectRect(a: ImageRegionRect, b: ImageRegionRect): ImageRegionRect | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  if (right <= x || bottom <= y) return null
  return { x: cleanZero(x), y: cleanZero(y), width: right - x, height: bottom - y }
}

function unionRects(rects: readonly ImageRegionRect[]): ImageRegionRect | null {
  if (rects.length === 0) return null
  const x = Math.min(...rects.map((rect) => rect.x))
  const y = Math.min(...rects.map((rect) => rect.y))
  const right = Math.max(...rects.map((rect) => rect.x + rect.width))
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height))
  return {
    x: cleanZero(x),
    y: cleanZero(y),
    width: right - x,
    height: bottom - y,
  }
}

function leadingPixelEdge(dip: number, dipLength: number, pixelLength: number): number {
  // Multiply first. `(500 / 1440) * 2160` is 750.0000000000001 in V8 and a
  // later ceil invents pixel 751; `(500 * 2160) / 1440` preserves the exact
  // integer edge for this measured monitor ratio.
  return clamp(Math.floor((dip * pixelLength) / dipLength), 0, pixelLength)
}

function trailingPixelEdge(dip: number, dipLength: number, pixelLength: number): number {
  return clamp(Math.ceil((dip * pixelLength) / dipLength), 0, pixelLength)
}

function validCompositeLayout(layout: ImageRegionCompositeLayout): boolean {
  if (
    !Number.isInteger(layout.width) ||
    layout.width <= 0 ||
    !Number.isInteger(layout.height) ||
    layout.height <= 0 ||
    layout.placements.length === 0
  ) {
    return false
  }
  const ids = new Set<string>()
  const indices = new Set<number>()
  for (const placement of layout.placements) {
    if (
      placement.id.length === 0 ||
      ids.has(placement.id) ||
      !Number.isInteger(placement.index) ||
      placement.index <= 0 ||
      indices.has(placement.index) ||
      !Number.isInteger(placement.x) ||
      placement.x < 0 ||
      !Number.isInteger(placement.y) ||
      placement.y < 0 ||
      !Number.isInteger(placement.width) ||
      placement.width <= 0 ||
      !Number.isInteger(placement.height) ||
      placement.height <= 0 ||
      placement.x + placement.width > layout.width ||
      placement.y + placement.height > layout.height
    ) {
      return false
    }
    ids.add(placement.id)
    indices.add(placement.index)
  }
  return true
}

/**
 * Bounds of the real Windows desktop in DIP coordinates, including any empty
 * rectangular gaps produced by staggered monitor placement.
 */
export function imageVirtualDesktopDipBounds(
  displays: readonly ImageRegionSelectorDisplay[],
): ImageRegionRect | null {
  if (displays.length === 0 || displays.some((display) => !validImageRegionDisplay(display))) {
    return null
  }
  return unionRects(displays.map((display) => display.bounds))
}

/**
 * Resolves one seamless drag against a frozen all-monitor composite.
 *
 * A per-display overlay necessarily clamps at its own BrowserWindow edge. A
 * virtual-desktop overlay instead reports one desktop-DIP rectangle, which may
 * cross any number of monitor seams. Each display intersection is converted
 * with THAT display's frozen raster dimensions, then translated through the
 * compositor's native-pixel placement. Only after those conversions are the
 * pieces united. This is why a 1x-to-1.5x drag cannot be implemented by
 * multiplying the whole rectangle by either monitor's scale factor.
 *
 * The returned crop is rectangular. It may therefore contain the compositor's
 * opaque gap pixels when monitors are staggered; silently squeezing those gaps
 * out would move pixels and break the desktop-coordinate context saved beside
 * the image.
 */
export function resolveImageDesktopRegion(
  displays: readonly ImageRegionSelectorDisplay[],
  layout: ImageRegionCompositeLayout,
  desktopDipRect: ImageRegionRect,
): ImageDesktopRegionSelection | null {
  const requested = normalizedRect(desktopDipRect)
  if (
    requested === null ||
    displays.length === 0 ||
    displays.some((display) => !validImageRegionDisplay(display)) ||
    !validCompositeLayout(layout)
  ) {
    return null
  }

  const displayIds = new Set<string>()
  const displayIndices = new Set<number>()
  for (const display of displays) {
    if (
      displayIds.has(display.id) ||
      displayIndices.has(display.index)
    ) {
      return null
    }
    displayIds.add(display.id)
    displayIndices.add(display.index)
  }
  if (
    layout.placements.length !== displays.length ||
    layout.placements.some((placement) => {
      const display = displays.find(
        (candidate) =>
          candidate.id === placement.id &&
          candidate.index === placement.index,
      )
      return (
        display === undefined ||
        placement.width !== display.pixelSize.width ||
        placement.height !== display.pixelSize.height
      )
    })
  ) {
    return null
  }

  const byId = new Map(layout.placements.map((placement) => [placement.id, placement]))
  const pixelPieces: ImageRegionRect[] = []
  const alignedDipPieces: ImageRegionRect[] = []
  const touched = new Map<number, string>()

  for (const display of displays) {
    const intersection = intersectRect(requested, display.bounds)
    const placement = byId.get(display.id)
    if (intersection === null || placement === undefined) continue

    const leftDip = intersection.x - display.bounds.x
    const topDip = intersection.y - display.bounds.y
    const rightDip = leftDip + intersection.width
    const bottomDip = topDip + intersection.height
    const leftPx = leadingPixelEdge(
      leftDip,
      display.bounds.width,
      display.pixelSize.width,
    )
    const topPx = leadingPixelEdge(
      topDip,
      display.bounds.height,
      display.pixelSize.height,
    )
    const rightPx = trailingPixelEdge(
      rightDip,
      display.bounds.width,
      display.pixelSize.width,
    )
    const bottomPx = trailingPixelEdge(
      bottomDip,
      display.bounds.height,
      display.pixelSize.height,
    )
    if (rightPx <= leftPx || bottomPx <= topPx) continue

    pixelPieces.push({
      x: placement.x + leftPx,
      y: placement.y + topPx,
      width: rightPx - leftPx,
      height: bottomPx - topPx,
    })
    const alignedLeftDip =
      display.bounds.x + (leftPx * display.bounds.width) / display.pixelSize.width
    const alignedTopDip =
      display.bounds.y + (topPx * display.bounds.height) / display.pixelSize.height
    const alignedRightDip =
      display.bounds.x + (rightPx * display.bounds.width) / display.pixelSize.width
    const alignedBottomDip =
      display.bounds.y + (bottomPx * display.bounds.height) / display.pixelSize.height
    alignedDipPieces.push({
      x: cleanZero(alignedLeftDip),
      y: cleanZero(alignedTopDip),
      width: alignedRightDip - alignedLeftDip,
      height: alignedBottomDip - alignedTopDip,
    })
    touched.set(display.index, display.id)
  }

  const compositePixelRect = unionRects(pixelPieces)
  const alignedDesktopDipRect = unionRects(alignedDipPieces)
  if (compositePixelRect === null || alignedDesktopDipRect === null) return null
  const orderedDisplays = [...touched.entries()].sort(
    ([indexA, idA], [indexB, idB]) => indexA - indexB || idA.localeCompare(idB),
  )
  return {
    desktopDipRect: alignedDesktopDipRect,
    compositePixelRect,
    displayIds: orderedDisplays.map(([, id]) => id),
    displayIndices: orderedDisplays.map(([index]) => index),
  }
}

/**
 * Chooses where a region editor should open.
 *
 * The shortcut can be pressed on one monitor and the drag completed on
 * another. Placing the editor on the shortcut monitor made a landscape crop
 * appear on an unrelated portrait display. The display containing the most of
 * the chosen rectangle is the one the user was actually working on; the
 * focused display is only a deterministic tie-breaker for a seam-spanning
 * selection.
 */
export function preferredImageRegionDisplay(
  displays: readonly ImageRegionSelectorDisplay[],
  desktopDipRect: ImageRegionRect,
  focusedDisplayId: string,
): ImageRegionSelectorDisplay | null {
  const requested = normalizedRect(desktopDipRect)
  if (requested === null) return null

  let best: ImageRegionSelectorDisplay | null = null
  let bestArea = 0
  for (const display of displays) {
    if (!validImageRegionDisplay(display)) return null
    const intersection = intersectRect(requested, display.bounds)
    if (intersection === null) continue
    const area = intersection.width * intersection.height
    const winsArea = area > bestArea
    const winsFocusedTie =
      area === bestArea &&
      display.id === focusedDisplayId &&
      best?.id !== focusedDisplayId
    const winsStableTie =
      area === bestArea &&
      !winsFocusedTie &&
      best !== null &&
      display.id !== focusedDisplayId &&
      best.id !== focusedDisplayId &&
      (display.index < best.index ||
        (display.index === best.index && display.id.localeCompare(best.id) < 0))
    if (best === null || winsArea || winsFocusedTie || winsStableTie) {
      best = display
      bestArea = area
    }
  }
  return best
}

/**
 * Convenience boundary for one BrowserWindow spanning the virtual desktop.
 * Renderer coordinates start at (0, 0); Windows desktop coordinates may not.
 */
export function resolveImageDesktopRegionFromLocalRect(
  displays: readonly ImageRegionSelectorDisplay[],
  layout: ImageRegionCompositeLayout,
  localVirtualDipRect: ImageRegionRect,
): ImageDesktopRegionSelection | null {
  const bounds = imageVirtualDesktopDipBounds(displays)
  if (bounds === null) return null
  return resolveImageDesktopRegion(displays, layout, {
    x: bounds.x + localVirtualDipRect.x,
    y: bounds.y + localVirtualDipRect.y,
    width: localVirtualDipRect.width,
    height: localVirtualDipRect.height,
  })
}

/**
 * Resolves one renderer intent at the main-process trust boundary.
 *
 * Pixel edges expand outward (`floor` the leading edge, `ceil` the trailing
 * edge), so a fractional CSS coordinate cannot discard a native pixel the
 * user visibly enclosed. The result is then projected back from THOSE pixel
 * edges; `desktopDipRect` and `pixelRect` are consequently two exact views of
 * the same rectangle instead of two independently rounded guesses.
 */
export function resolveImageRegionIntent(
  display: ImageRegionSelectorDisplay,
  intent: ImageRegionIntent,
): ImageRegionSelection | null {
  if (intent.mode === 'cancel' || !validImageRegionDisplay(display)) return null

  const dipWidth = display.bounds.width
  const dipHeight = display.bounds.height
  const pixelWidth = display.pixelSize.width
  const pixelHeight = display.pixelSize.height

  if (intent.mode === 'fullscreen') {
    return {
      mode: 'fullscreen',
      displayId: display.id,
      displayIndex: display.index,
      pixelRect: { x: 0, y: 0, width: pixelWidth, height: pixelHeight },
      desktopDipRect: { ...display.bounds },
    }
  }

  const raw = intent.localDipRect
  if (
    !finite(raw.x) ||
    !finite(raw.y) ||
    !finite(raw.width) ||
    !finite(raw.height) ||
    raw.width === 0 ||
    raw.height === 0
  ) {
    return null
  }

  const rawRight = raw.x + raw.width
  const rawBottom = raw.y + raw.height
  const leftDip = clamp(Math.min(raw.x, rawRight), 0, dipWidth)
  const topDip = clamp(Math.min(raw.y, rawBottom), 0, dipHeight)
  const rightDip = clamp(Math.max(raw.x, rawRight), 0, dipWidth)
  const bottomDip = clamp(Math.max(raw.y, rawBottom), 0, dipHeight)
  if (rightDip <= leftDip || bottomDip <= topDip) return null

  const leftPx = leadingPixelEdge(leftDip, dipWidth, pixelWidth)
  const topPx = leadingPixelEdge(topDip, dipHeight, pixelHeight)
  const rightPx = trailingPixelEdge(rightDip, dipWidth, pixelWidth)
  const bottomPx = trailingPixelEdge(bottomDip, dipHeight, pixelHeight)
  if (rightPx <= leftPx || bottomPx <= topPx) return null

  const alignedLeftDip = (leftPx * dipWidth) / pixelWidth
  const alignedTopDip = (topPx * dipHeight) / pixelHeight
  const alignedRightDip = (rightPx * dipWidth) / pixelWidth
  const alignedBottomDip = (bottomPx * dipHeight) / pixelHeight
  return {
    mode: 'region',
    displayId: display.id,
    displayIndex: display.index,
    pixelRect: {
      x: leftPx,
      y: topPx,
      width: rightPx - leftPx,
      height: bottomPx - topPx,
    },
    desktopDipRect: {
      x: cleanZero(display.bounds.x + alignedLeftDip),
      y: cleanZero(display.bounds.y + alignedTopDip),
      width: alignedRightDip - alignedLeftDip,
      height: alignedBottomDip - alignedTopDip,
    },
  }
}
