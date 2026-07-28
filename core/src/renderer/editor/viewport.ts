// Zoom/pan viewport: a CSS transform on the frame element (transform-origin
// 0 0). The overlay canvas lives inside the frame, so annotations stay glued
// to image pixels under any zoom or pan.

export const ZOOM_MIN = 0.5
export const ZOOM_MAX = 4
const ZOOM_STEP = 1.2

export class Viewport {
  zoom = 1
  private panX = 0
  private panY = 0

  constructor(private readonly frame: HTMLElement) {}

  /** Space+drag pan applies once the view is zoomed OR has been panned off centre. */
  get panEnabled(): boolean {
    return this.zoom !== 1 || this.panX !== 0 || this.panY !== 0
  }

  /** Zooms by one step, keeping the point under the cursor fixed. */
  zoomAt(clientX: number, clientY: number, zoomIn: boolean): void {
    const next = clamp(this.zoom * (zoomIn ? ZOOM_STEP : 1 / ZOOM_STEP), ZOOM_MIN, ZOOM_MAX)
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
   * This is how the board's legend chips work (GOAL "Multi-Monitor Support"):
   * the whole board opens fitted, and one click gives a single display the
   * largest usable scale without ever leaving the board — the other screens are
   * a pan away, not a mode away.
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
   * opens and what Esc returns to after focusRect() framed one display.
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
