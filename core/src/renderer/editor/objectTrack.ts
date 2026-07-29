import type { ObjectTrackSample } from '../../shared/ipc'

export interface TrackRect {
  x: number
  y: number
  width: number
  height: number
}

export interface TrackDisplayGeometry {
  index: number
  width: number
  height: number
  /** Native snapshot pixels per virtual-desktop DIP. */
  pixelsPerDip: number
}

/**
 * Geometry captured with a control pick.
 *
 * The tracking IPC returns the owning WINDOW's path. A control must retain its
 * offset and size within that window; copying the surface samples verbatim
 * turns a correctly identified Button/Text target into a window-sized box.
 */
export interface ControlTrackAnchor {
  display: number
  bounds: TrackRect
  surfaceBounds: TrackRect
  displays: readonly TrackDisplayGeometry[]
}

function positiveScale(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1
}

function inferredSurfaceOrigin(
  position: number,
  visibleSize: number,
  expectedSize: number,
): number {
  // A surface piece touching a display's leading edge may be the RIGHT/BOTTOM
  // part of a window whose origin is outside that display. Reconstruct that
  // origin before applying the control's in-window offset. At the trailing
  // edge the visible piece starts at the real origin already.
  if (position <= 1 && visibleSize + 1 < expectedSize) {
    return position - (expectedSize - visibleSize)
  }
  return position
}

function clipped(
  rect: TrackRect,
  display: TrackDisplayGeometry | undefined,
): TrackRect | null {
  if (display === undefined) return rect
  const x0 = Math.max(0, rect.x)
  const y0 = Math.max(0, rect.y)
  const x1 = Math.min(display.width, rect.x + rect.width)
  const y1 = Math.min(display.height, rect.y + rect.height)
  if (x1 <= x0 || y1 <= y0) return null
  return {
    x: Math.round(x0),
    y: Math.round(y0),
    width: Math.round(x1 - x0),
    height: Math.round(y1 - y0),
  }
}

/**
 * Projects an owning-window path onto the control that was actually picked.
 *
 * UIA's capture-instant control rectangle is static; the temporal lane records
 * the owner HWND. Translation is therefore the honest operation (resizing or
 * scrolling would require another UIA observation). When the owner crosses
 * monitors, offsets and sizes are converted through each display's native-pixel
 * scale, then clipped into that display's snapshot space.
 */
export function projectControlTrack(
  samples: readonly ObjectTrackSample[],
  anchor: ControlTrackAnchor,
): ObjectTrackSample[] {
  const sourceDisplay = anchor.displays.find((d) => d.index === anchor.display)
  const sourceScale = positiveScale(sourceDisplay?.pixelsPerDip)
  const offsetDipX = (anchor.bounds.x - anchor.surfaceBounds.x) / sourceScale
  const offsetDipY = (anchor.bounds.y - anchor.surfaceBounds.y) / sourceScale
  const widthDip = anchor.bounds.width / sourceScale
  const heightDip = anchor.bounds.height / sourceScale
  const surfaceWidthDip = anchor.surfaceBounds.width / sourceScale
  const surfaceHeightDip = anchor.surfaceBounds.height / sourceScale
  const projected: ObjectTrackSample[] = []

  for (const sample of samples) {
    const targetDisplay = anchor.displays.find((d) => d.index === sample.display)
    const targetScale = positiveScale(targetDisplay?.pixelsPerDip)
    const expectedSurfaceWidth = surfaceWidthDip * targetScale
    const expectedSurfaceHeight = surfaceHeightDip * targetScale
    const surfaceX = inferredSurfaceOrigin(sample.x, sample.width, expectedSurfaceWidth)
    const surfaceY = inferredSurfaceOrigin(sample.y, sample.height, expectedSurfaceHeight)
    const rect = clipped(
      {
        x: surfaceX + offsetDipX * targetScale,
        y: surfaceY + offsetDipY * targetScale,
        width: widthDip * targetScale,
        height: heightDip * targetScale,
      },
      targetDisplay,
    )
    if (rect === null) continue
    projected.push({ tMs: sample.tMs, display: sample.display, ...rect })
  }

  return projected
}
