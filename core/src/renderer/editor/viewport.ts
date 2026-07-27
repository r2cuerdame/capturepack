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

  /** Space+drag pan only applies once the view is zoomed. */
  get panEnabled(): boolean {
    return this.zoom !== 1
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

  private apply(): void {
    this.frame.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}
