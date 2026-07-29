// Context carried by an EXPLICIT region screenshot.
//
// Cropping only snapshot.png is not enough: an unfiltered UIA payload would
// still disclose titles and controls from outside the pixels the user chose.
// This module applies the same spatial boundary to semantic metadata and
// rewrites every surviving rectangle into the cropped image's own pixel space.

import type {
  UiaBounds,
  UiaElementRecord,
  UiaPluginPayload,
  UiaWindowRecord,
} from '../shared/types'
import type { ImageDesktopPlacement } from './imageDesktop'

export interface ImagePixelCrop {
  /** Display index in the source capture. */
  display: number
  x: number
  y: number
  width: number
  height: number
}

interface WindowWithHandle extends UiaWindowRecord {
  hwnd?: string
}

/** The part of `bounds` visible inside the selected region, crop-local. */
function croppedBounds(bounds: UiaBounds, crop: ImagePixelCrop): UiaBounds | null {
  const left = Math.max(bounds.x, crop.x)
  const top = Math.max(bounds.y, crop.y)
  const right = Math.min(bounds.x + bounds.width, crop.x + crop.width)
  const bottom = Math.min(bounds.y + bounds.height, crop.y + crop.height)
  if (right <= left || bottom <= top) return null
  return {
    x: left - crop.x,
    y: top - crop.y,
    width: right - left,
    height: bottom - top,
  }
}

function sourceDisplay(display: number | undefined, focusedDisplay: number): number {
  return display ?? focusedDisplay
}

/**
 * Returns the UI context the cropped image is allowed to carry.
 *
 * The returned payload describes a single-image pack, so display indices are
 * removed: absent means that one focused image. Windows are compacted and
 * element.window is remapped to the new array. A partially visible object is
 * clipped, never allowed to retain geometry outside the user's selection.
 */
export function cropUiaForImage(
  payload: UiaPluginPayload | null,
  crop: ImagePixelCrop,
  focusedDisplay: number,
): UiaPluginPayload | null {
  if (
    payload === null ||
    !Number.isInteger(crop.display) ||
    crop.display < 1 ||
    !Number.isFinite(crop.x) ||
    !Number.isFinite(crop.y) ||
    !Number.isFinite(crop.width) ||
    !Number.isFinite(crop.height) ||
    crop.width <= 0 ||
    crop.height <= 0
  ) {
    return null
  }

  const windows: UiaWindowRecord[] = []
  const oldToNew = new Map<number, number>()
  for (let oldIndex = 0; oldIndex < payload.windows.length; oldIndex += 1) {
    const source = payload.windows[oldIndex] as WindowWithHandle | undefined
    if (source === undefined || sourceDisplay(source.display, focusedDisplay) !== crop.display) {
      continue
    }
    const bounds = croppedBounds(source.bounds, crop)
    if (bounds === null) continue
    const newIndex = windows.length
    oldToNew.set(oldIndex, newIndex)
    windows.push({
      ...(source.hwnd === undefined ? {} : { hwnd: source.hwnd }),
      title: source.title,
      process: source.process,
      class_name: source.class_name,
      bounds,
      focused: source.focused,
      z: newIndex,
      tree: source.tree,
      element_count: 0,
    } as UiaWindowRecord)
  }

  const elements: UiaElementRecord[] = []
  const counts = new Map<number, number>()
  for (const source of payload.elements) {
    if (sourceDisplay(source.display, focusedDisplay) !== crop.display) continue
    const newWindow = oldToNew.get(source.window)
    if (newWindow === undefined) continue
    const bounds = croppedBounds(source.bounds, crop)
    if (bounds === null) continue
    elements.push({
      name: source.name,
      control_type: source.control_type,
      automation_id: source.automation_id,
      class_name: source.class_name,
      bounds,
      depth: source.depth,
      window: newWindow,
    })
    counts.set(newWindow, (counts.get(newWindow) ?? 0) + 1)
  }

  for (let i = 0; i < windows.length; i += 1) {
    const window = windows[i]
    if (window !== undefined) window.element_count = counts.get(i) ?? 0
  }

  // No semantic object inside the explicit pixels means no semantic plugin.
  if (windows.length === 0 && elements.length === 0) return null
  return {
    captured_at: payload.captured_at,
    budget_ms: payload.budget_ms,
    truncated: payload.truncated,
    windows,
    elements,
  }
}

function desktopBounds(
  bounds: UiaBounds,
  placement: ImageDesktopPlacement,
): UiaBounds | null {
  const local = croppedBounds(bounds, {
    display: placement.index,
    x: 0,
    y: 0,
    width: placement.width,
    height: placement.height,
  })
  if (local === null) return null
  return {
    x: local.x + placement.x,
    y: local.y + placement.y,
    width: local.width,
    height: local.height,
  }
}

/**
 * Flattens every captured display's UIA records into the composed desktop PNG.
 *
 * The resulting pack has one snapshot coordinate space, so source display
 * fields are deliberately removed. Each object is clipped to its native source
 * raster before the placement offset is applied; context from a screen that
 * failed to freeze can therefore never leak into the full-desktop image.
 */
export function composeUiaForImageDesktop(
  payload: UiaPluginPayload | null,
  placements: readonly ImageDesktopPlacement[],
  focusedDisplay: number,
): UiaPluginPayload | null {
  if (payload === null || placements.length === 0) return null
  const placementByDisplay = new Map(
    placements.map((placement) => [placement.index, placement]),
  )

  const windows: UiaWindowRecord[] = []
  const oldToNew = new Map<number, number>()
  for (let oldIndex = 0; oldIndex < payload.windows.length; oldIndex += 1) {
    const source = payload.windows[oldIndex] as WindowWithHandle | undefined
    if (source === undefined) continue
    const placement = placementByDisplay.get(
      sourceDisplay(source.display, focusedDisplay),
    )
    if (placement === undefined) continue
    const bounds = desktopBounds(source.bounds, placement)
    if (bounds === null) continue
    const newIndex = windows.length
    oldToNew.set(oldIndex, newIndex)
    windows.push({
      ...(source.hwnd === undefined ? {} : { hwnd: source.hwnd }),
      title: source.title,
      process: source.process,
      class_name: source.class_name,
      bounds,
      focused: source.focused,
      z: newIndex,
      tree: source.tree,
      element_count: 0,
    } as UiaWindowRecord)
  }

  const elements: UiaElementRecord[] = []
  const counts = new Map<number, number>()
  for (const source of payload.elements) {
    const newWindow = oldToNew.get(source.window)
    if (newWindow === undefined) continue
    const placement = placementByDisplay.get(
      sourceDisplay(source.display, focusedDisplay),
    )
    if (placement === undefined) continue
    const bounds = desktopBounds(source.bounds, placement)
    if (bounds === null) continue
    elements.push({
      name: source.name,
      control_type: source.control_type,
      automation_id: source.automation_id,
      class_name: source.class_name,
      bounds,
      depth: source.depth,
      window: newWindow,
    })
    counts.set(newWindow, (counts.get(newWindow) ?? 0) + 1)
  }

  for (let i = 0; i < windows.length; i += 1) {
    const window = windows[i]
    if (window !== undefined) window.element_count = counts.get(i) ?? 0
  }
  if (windows.length === 0 && elements.length === 0) return null
  return {
    captured_at: payload.captured_at,
    budget_ms: payload.budget_ms,
    truncated: payload.truncated,
    windows,
    elements,
  }
}
