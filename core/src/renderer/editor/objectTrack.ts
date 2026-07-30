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
 * A control rectangle supplied by a temporal UIA provider.
 *
 * `estimated` is accepted at this boundary so callers can keep diagnostic
 * geometry, but it is deliberately never returned as an ObjectTrackSample:
 * the persisted track schema represents observations, not predictions.
 */
export interface ControlTrackSample extends ObjectTrackSample {
  provenance: 'observed' | 'estimated'
}

/**
 * Geometry captured with a control pick.
 *
 * `bounds` is the one control observation underneath the pointer. It remains
 * the annotation's static fallback. It does NOT license projecting that shape
 * through the owning window's temporal path: scrolling, layout, visibility,
 * resize and DPI changes can all move a child independently.
 */
export interface ControlTrackAnchor {
  display: number
  bounds: TrackRect
  surfaceBounds: TrackRect
  displays: readonly TrackDisplayGeometry[]
  /**
   * Optional temporal UIA samples. Current owner-window tracking does not
   * provide these; an empty value therefore means "static observed bounds",
   * not "derive a path from the owner".
   */
  controlSamples?: readonly ControlTrackSample[]
}

function positiveScale(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1
}

function inferredSurfaceOrigin(
  position: number,
  visibleSize: number,
  expectedSize: number,
): number {
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

function compatibleVisibleAxis(
  position: number,
  visibleSize: number,
  expectedSize: number,
  displaySize: number | undefined,
): boolean {
  if (Math.abs(visibleSize - expectedSize) <= 1) return true
  if (visibleSize > expectedSize + 1 || displaySize === undefined) return false
  return position <= 1 || position + visibleSize >= displaySize - 1
}

/**
 * Returns directly observed UIA samples when Lane A supplied them. Otherwise
 * the picked observation may follow only rigid, same-size owner translation.
 *
 * A size change is positive evidence that child layout may have changed, so it
 * ends this projection permanently. Returning to the old size cannot revive
 * the stale child; only a later direct control geometry revision can do that.
 */
export function projectControlTrack(
  samples: readonly ObjectTrackSample[],
  anchor: ControlTrackAnchor,
): ObjectTrackSample[] {
  if (anchor.controlSamples !== undefined) {
    return anchor.controlSamples.flatMap((sample) =>
      sample.provenance === 'observed'
        ? [{
            tMs: sample.tMs,
            display: sample.display,
            x: sample.x,
            y: sample.y,
            width: sample.width,
            height: sample.height,
          }]
        : [])
  }

  const sourceDisplay = anchor.displays.find((display) => display.index === anchor.display)
  const sourceScale = positiveScale(sourceDisplay?.pixelsPerDip)
  const offsetDipX = (anchor.bounds.x - anchor.surfaceBounds.x) / sourceScale
  const offsetDipY = (anchor.bounds.y - anchor.surfaceBounds.y) / sourceScale
  const widthDip = anchor.bounds.width / sourceScale
  const heightDip = anchor.bounds.height / sourceScale
  const surfaceWidthDip = anchor.surfaceBounds.width / sourceScale
  const surfaceHeightDip = anchor.surfaceBounds.height / sourceScale
  const projected: ObjectTrackSample[] = []

  for (const sample of samples) {
    const targetDisplay = anchor.displays.find((display) => display.index === sample.display)
    const targetScale = positiveScale(targetDisplay?.pixelsPerDip)
    const expectedSurfaceWidth = surfaceWidthDip * targetScale
    const expectedSurfaceHeight = surfaceHeightDip * targetScale
    if (
      !compatibleVisibleAxis(
        sample.x,
        sample.width,
        expectedSurfaceWidth,
        targetDisplay?.width,
      )
      || !compatibleVisibleAxis(
        sample.y,
        sample.height,
        expectedSurfaceHeight,
        targetDisplay?.height,
      )
    ) {
      break
    }
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
    if (rect !== null) {
      projected.push({ tMs: sample.tMs, display: sample.display, ...rect })
    }
  }
  return projected
}
