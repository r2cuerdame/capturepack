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

/**
 * A window's size is meaningful to about one DIP, not one pixel.
 *
 * `expectedSize` is the anchor's pixels divided by one display's scale and
 * multiplied by another's, and the operating system rounds its own conversion
 * independently. A 1439 px window on a 1.5x screen is 959.33 DIP, and Windows
 * reports it as 958 px on the 1x screen — 1.33 px from what this arithmetic
 * expects, which a one-pixel tolerance calls a resize. So the slack is one DIP
 * of the target display plus a rounding pixel at each end.
 */
function sizeTolerance(scale: number): number {
  return scale + 1
}

function compatibleVisibleAxis(
  position: number,
  visibleSize: number,
  expectedSize: number,
  displaySize: number | undefined,
  scale: number,
): boolean {
  const tolerance = sizeTolerance(scale)
  if (Math.abs(visibleSize - expectedSize) <= tolerance) return true
  if (visibleSize > expectedSize + tolerance || displaySize === undefined) return false
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
    // A WINDOW BEING DRAGGED ACROSS A DPI BOUNDARY HAS NOT BEEN RESCALED YET (#107).
    //
    // Expressing the owner's DIP size at the TARGET display's scale assumes
    // Windows has already applied that display's DPI to the window. It applies
    // it when the drag ENDS, so for the whole time the window straddles the
    // seam — and until it is dropped — it is observed on the new screen at the
    // size it still physically is. That is not a re-layout, and reading it as
    // one ended the projection permanently and took every later sample with it:
    // measured on a 1439x951 window crossing from a 1.5x screen to a 1x one,
    // 4525 ms of a 10 s box was discarded while the window went on being
    // observed the whole time.
    //
    // So both readings of "the same window" are allowed, and whichever the
    // observation actually matches is the one the child is projected through —
    // the child of an unrescaled owner is unrescaled too. A size that matches
    // NEITHER is a real change, and still ends the projection below.
    const ownerScale = compatibleOwnerScale(
      sample,
      { widthDip: surfaceWidthDip, heightDip: surfaceHeightDip },
      targetDisplay,
      candidateScales(
        targetScale,
        sourceScale,
        anchor.displays,
        touchesEdge(sample, targetDisplay),
      ),
    )
    if (ownerScale === null) break
    const expectedSurfaceWidth = surfaceWidthDip * ownerScale
    const expectedSurfaceHeight = surfaceHeightDip * ownerScale
    const surfaceX = inferredSurfaceOrigin(sample.x, sample.width, expectedSurfaceWidth)
    const surfaceY = inferredSurfaceOrigin(sample.y, sample.height, expectedSurfaceHeight)
    const rect = clipped(
      {
        x: surfaceX + offsetDipX * ownerScale,
        y: surfaceY + offsetDipY * ownerScale,
        width: widthDip * ownerScale,
        height: heightDip * ownerScale,
      },
      targetDisplay,
    )
    if (rect !== null) {
      projected.push({ tMs: sample.tMs, display: sample.display, ...rect })
    }
  }
  return projected
}

/**
 * The DPIs this window could be carrying, most likely first.
 *
 * A straddling window is rescaled as a whole, so BOTH halves report the DPI of
 * whichever display Windows has decided it now belongs to — the half still on
 * the 1.5x screen is 633 px tall while the window is being treated as a 1x
 * window. Restricting the candidates to the sample's own display and the pick's
 * display therefore still ends the track at the seam, one sample later than
 * before. Any DPI on this desktop is a legitimate reading; a size that matches
 * none of them is the resize the projection must stop at.
 */
function candidateScales(
  targetScale: number,
  sourceScale: number,
  displays: readonly TrackDisplayGeometry[],
  crossing: boolean,
): number[] {
  // A window sitting wholly inside one screen is not being rescaled, so its own
  // display's DPI is the only honest reading and a size that disagrees is the
  // resize this projection must stop at. Widening the candidates there would
  // let a real resize pass whenever the new size happened to match some other
  // screen's DPI.
  if (!crossing) return [targetScale]
  const ordered = [targetScale, sourceScale]
  for (const display of displays) ordered.push(positiveScale(display.pixelsPerDip))
  return [...new Set(ordered)]
}

/** Whether this observation is clipped by a screen edge — the window is crossing. */
function touchesEdge(
  sample: ObjectTrackSample,
  display: TrackDisplayGeometry | undefined,
): boolean {
  if (display === undefined) return false
  return (
    sample.x <= 1
    || sample.y <= 1
    || sample.x + sample.width >= display.width - 1
    || sample.y + sample.height >= display.height - 1
  )
}

/**
 * The scale at which this observation is still the same, unresized window.
 *
 * Candidates are tried in order and the first that explains BOTH axes wins, so
 * a window that has settled at the new display's DPI is read that way and one
 * still carrying its old physical size is read that way. `null` means the
 * observation is not this window's size under any of them.
 */
function compatibleOwnerScale(
  sample: ObjectTrackSample,
  surface: { widthDip: number; heightDip: number },
  display: TrackDisplayGeometry | undefined,
  candidates: readonly number[],
): number | null {
  for (const scale of candidates) {
    if (
      compatibleVisibleAxis(
        sample.x,
        sample.width,
        surface.widthDip * scale,
        display?.width,
        scale,
      )
      && compatibleVisibleAxis(
        sample.y,
        sample.height,
        surface.heightDip * scale,
        display?.height,
        scale,
      )
    ) {
      return scale
    }
  }
  return null
}
