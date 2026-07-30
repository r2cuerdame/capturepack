// Zoom/pan viewport: a CSS transform on the frame element (transform-origin
// 0 0). The overlay canvas lives inside the frame, so annotations stay glued
// to image pixels under any zoom or pan.

export const ZOOM_MIN = 0.5
export const ZOOM_MAX = 4
/** One notch of Ctrl+wheel — and one press of the top bar's [-] / [+]. */
export const ZOOM_STEP = 1.2

/**
 * The normal zoom range is a hard wall. Still-image native 1:1 may explicitly
 * supply a higher ceiling when a very large raster needs more than 4x from its
 * fitted opening; video and every ordinary caller retain the 4x limit.
 */
export function clampZoom(zoom: number, maxZoom = ZOOM_MAX): number {
  return clamp(zoom, ZOOM_MIN, Math.max(ZOOM_MIN, maxZoom))
}

/** Zoom ceiling that can always represent native 1:1 for a fitted image. */
export function nativeImageZoomCeiling(fitScale: number): number {
  return Math.max(ZOOM_MAX, fitScale > 0 ? 1 / fitScale : ZOOM_MAX)
}

/**
 * The first view for a still image.
 *
 * `fitScale` is the contain scale already computed by the editor layout and is
 * capped at 1. A raster that fits the content viewport therefore opens at
 * native 1:1, while an oversized raster opens contained so every captured
 * pixel is visible. This decision is kept pure so the opening contract can be
 * regression-tested without launching Electron.
 */
export function initialImageViewMode(fitScale: number): 'fit' | 'native' {
  return fitScale < 1 ? 'fit' : 'native'
}

export class Viewport {
  zoom = 1
  private panX = 0
  private panY = 0

  constructor(private readonly frame: HTMLElement) {}

  /**
   * Whether there is anything to pan: true once the view is zoomed OR has been
   * panned off centre. Both pan gestures (Space+drag and middle-button drag,
   * issue #55) are gated on it — a fully fitted board has nothing to move, so
   * the press is left alone rather than swallowed.
   */
  get panEnabled(): boolean {
    return this.zoom !== 1 || this.panX !== 0 || this.panY !== 0
  }

  /** Zooms by one step, keeping the point under the cursor fixed. */
  zoomAt(
    clientX: number,
    clientY: number,
    zoomIn: boolean,
    maxZoom = ZOOM_MAX,
  ): void {
    this.zoomTo(
      this.zoom * (zoomIn ? ZOOM_STEP : 1 / ZOOM_STEP),
      clientX,
      clientY,
      maxZoom,
    )
  }

  /**
   * Zooms to an ABSOLUTE factor, keeping (clientX, clientY) fixed on screen.
   *
   * This is what the top bar's zoom control drives (GOAL "Editor Chrome": the
   * board's zoom is a first-class control, not a hidden gesture) — anchored on
   * the stage centre there, on the cursor for Ctrl+wheel. Same range, same
   * transform, one implementation, so the two can never disagree.
   */
  zoomTo(
    zoom: number,
    clientX: number,
    clientY: number,
    maxZoom = ZOOM_MAX,
  ): void {
    const next = clampZoom(zoom, maxZoom)
    if (next === this.zoom) return
    // rect.left = untransformedLeft + panX, so the cursor-fixed pan update
    // only needs the current on-screen rect.
    const rect = this.frame.getBoundingClientRect()
    this.panX += (clientX - rect.left) * (1 - next / this.zoom)
    this.panY += (clientY - rect.top) * (1 - next / this.zoom)
    this.zoom = next
    this.apply()
  }

  panBy(dx: number, dy: number): void {
    this.panX += dx
    this.panY += dy
    this.apply()
  }

  /**
   * Frames one rectangle of the (untransformed) frame in a stage of the given
   * size: zooms to the largest scale at which it still fits, and pans so its
   * centre lands on the stage centre.
   *
   * This is how framing one display works (GOAL "Multi-Monitor Support" —
   * `1`..`9`, with the key left of 1 (`` ` ``) fitting the board again; Esc has
   * no say in the framing at all, issue #53): the whole board opens
   * fitted, and one keystroke gives a single display the largest usable scale
   * without ever leaving the board — the other screens are a pan away, not a
   * mode away.
   *
   * `frameW`/`frameH` are the frame's CSS size, which flex centring places at
   * ((stageW - frameW) / 2, (stageH - frameH) / 2); the transform then applies
   * on top of that, origin 0 0.
   */
  focusRect(
    rect: { x: number; y: number; width: number; height: number },
    frameW: number,
    frameH: number,
    stageW: number,
    stageH: number,
  ): void {
    if (rect.width <= 0 || rect.height <= 0 || stageW <= 0 || stageH <= 0) return
    const zoom = clamp(Math.min(stageW / rect.width, stageH / rect.height), ZOOM_MIN, ZOOM_MAX)
    const originX = (stageW - frameW) / 2
    const originY = (stageH - frameH) / 2
    const cx = rect.x + rect.width / 2
    const cy = rect.y + rect.height / 2
    this.zoom = zoom
    this.panX = stageW / 2 - originX - cx * zoom
    this.panY = stageH / 2 - originY - cy * zoom
    this.apply()
  }

  /**
   * Back to 1:1, unpanned — the whole board, fitted, which is how the editor
   * opens and what the key left of 1 returns to after focusRect() framed one
   * display.
   */
  reset(): void {
    if (this.zoom === 1 && this.panX === 0 && this.panY === 0) return
    this.zoom = 1
    this.panX = 0
    this.panY = 0
    this.apply()
  }

  private apply(): void {
    this.frame.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}
