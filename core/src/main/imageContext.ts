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
import type { ContextObservation } from './context/buffer'

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

const IMAGE_WINDOW_MATCH_SLACK = 160
// Ephemeral provenance for windows clipped by a real captured-display edge.
// A WeakSet keeps this reconciliation hint out of the persisted UIA schema.
const monitorClippedWindows = new WeakSet<object>()

function intersectImageRect(
  bounds: { x: number; y: number; width: number; height: number },
  crop: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } | null {
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

function rectGap(a: UiaBounds, b: UiaBounds): number {
  return (
    Math.abs(a.x - b.x) +
    Math.abs(a.y - b.y) +
    Math.abs(a.width - b.width) +
    Math.abs(a.height - b.height)
  )
}

function unionImageRect(a: UiaBounds, b: UiaBounds): UiaBounds {
  const left = Math.min(a.x, b.x)
  const top = Math.min(a.y, b.y)
  const right = Math.max(a.x + a.width, b.x + b.width)
  const bottom = Math.max(a.y + a.height, b.y + b.height)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function clipImageRect(bounds: UiaBounds, container: UiaBounds): UiaBounds | null {
  const local = intersectImageRect(bounds, container)
  if (local === null) return null
  return {
    x: local.x + container.x,
    y: local.y + container.y,
    width: local.width,
    height: local.height,
  }
}

function containsImageRect(outer: UiaBounds, inner: UiaBounds): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  )
}

/**
 * Core's low-cost window floor at the exact still-image trigger instant.
 *
 * The resident Win32 ring is frozen before any selector exists, projected
 * through the same native-pixel desktop layout as snapshot.png, and clipped to
 * the user's explicit pixels. Straddling per-display slices are reunited in
 * the composed still.
 */
export function imageWindowObservation(
  source: ContextObservation | undefined,
  placements: readonly ImageDesktopPlacement[],
  crop?: { x: number; y: number; width: number; height: number },
): ContextObservation | null {
  if (source === undefined || placements.length === 0) return null
  const placementByDisplay = new Map(
    placements.map((placement) => [placement.index, placement]),
  )
  type WindowRecord = ContextObservation['windows'][number]
  const bySurface = new Map<string, WindowRecord>()
  for (const window of source.windows) {
    const placement = placementByDisplay.get(window.display)
    if (placement === undefined) continue
    const local = intersectImageRect(window.bounds, {
      x: 0,
      y: 0,
      width: placement.width,
      height: placement.height,
    })
    if (local === null) continue
    const desktopBounds = {
      x: local.x + placement.x,
      y: local.y + placement.y,
      width: local.width,
      height: local.height,
    }
    const bounds =
      crop === undefined ? desktopBounds : intersectImageRect(desktopBounds, crop)
    if (bounds === null) continue
    // THE CLIENT RECTANGLE, MAPPED THE SAME WAY (#131).
    //
    // A DOM element is measured in viewport CSS pixels, and the ONLY thing that
    // turns those into snapshot pixels is the browser's client rectangle: the
    // scale is `client.width / viewport.width` and the chrome height is
    // `client.height - viewport.height * scale`. Both are derived, neither is
    // assumed — and without a client rectangle neither can be derived at all.
    //
    // A still used to drop this unconditionally, so a captured page reached the
    // pack complete and could not be placed on the picture: 477 elements, a
    // viewport, a matching window, and nothing offered. It is carried through
    // the same placement transform as `bounds`, and given up ONLY where it is
    // genuinely unsafe — see the union below.
    const clientLocal =
      window.client_bounds === undefined
        ? null
        : intersectImageRect(window.client_bounds, {
            x: 0,
            y: 0,
            width: placement.width,
            height: placement.height,
          })
    const clientDesktop =
      clientLocal === null
        ? null
        : {
            x: clientLocal.x + placement.x,
            y: clientLocal.y + placement.y,
            width: clientLocal.width,
            height: clientLocal.height,
          }
    const clientBounds =
      clientDesktop === null
        ? null
        : crop === undefined
          ? clientDesktop
          : intersectImageRect(clientDesktop, crop)
    const key =
      window.surface_id ??
      window.hwnd ??
      `${window.process}\u0000${window.class_name}\u0000${window.title}\u0000${window.z}`
    const previous = bySurface.get(key)
    if (previous !== undefined) {
      const left = Math.min(previous.bounds.x, bounds.x)
      const top = Math.min(previous.bounds.y, bounds.y)
      const right = Math.max(
        previous.bounds.x + previous.bounds.width,
        bounds.x + bounds.width,
      )
      const bottom = Math.max(
        previous.bounds.y + previous.bounds.height,
        bounds.y + bounds.height,
      )
      bySurface.set(key, {
        ...previous,
        bounds: { x: left, y: top, width: right - left, height: bottom - top },
        focused: previous.focused || window.focused,
        z: Math.min(previous.z, window.z),
        // THIS is the case the old blanket refusal was written for, and the only
        // one it was right about. A window straddling monitors of different DPI
        // arrives as clipped slices, and a rectangle unioned from them describes
        // no viewport that ever existed. Placing a page against it would be an
        // invented number; refusing costs the page and keeps the window.
        client_bounds: undefined,
      })
      continue
    }
    bySurface.set(key, {
      ...window,
      bounds,
      display: 1,
      hasControls: false,
      tree: 'skipped',
      // One slice: nothing was unioned, so this rectangle is a measurement.
      ...(clientBounds === null ? { client_bounds: undefined } : { client_bounds: clientBounds }),
    })
  }
  const windows = [...bySurface.values()].sort((a, b) => a.z - b.z)
  if (windows.length === 0) return null
  return { tMs: 0, windows, elements: [] }
}

/**
 * Makes the trigger-time Win32 list the authoritative set of windows in a
 * still image and layers the slower UIA controls onto matching HWNDs.
 *
 * A selector created after the pixels froze can appear in the asynchronous UIA
 * result; with no trigger-time floor entry it is deliberately rejected.
 */
export function mergeImageWindowFloor(
  payload: UiaPluginPayload | null,
  floor: ContextObservation | null,
  capturedAt: string,
  excludedHwnds: readonly string[] = [],
): UiaPluginPayload | null {
  const excluded = new Set(excludedHwnds)
  let safePayload = payload
  if (payload !== null && excluded.size > 0) {
    const windows: UiaPluginPayload['windows'] = []
    const elements: UiaPluginPayload['elements'] = []
    const oldToNew = new Map<number, number>()
    for (const window of payload.windows) {
      if (window.hwnd !== undefined && excluded.has(window.hwnd)) continue
      const z = windows.length
      oldToNew.set(window.z, z)
      windows.push({ ...window, bounds: { ...window.bounds }, z, element_count: 0 })
    }
    for (const element of payload.elements) {
      const window = oldToNew.get(element.window)
      if (window === undefined) continue
      elements.push({ ...element, bounds: { ...element.bounds }, window })
    }
    for (let z = 0; z < windows.length; z += 1) {
      const window = windows[z]
      if (window !== undefined) {
        window.element_count = elements.filter((element) => element.window === z).length
      }
    }
    safePayload =
      windows.length === 0 && elements.length === 0
        ? null
        : { ...payload, windows, elements }
  }
  if (floor === null) return safePayload
  const normalizeProcess = (value: string): string =>
    value.trim().toLowerCase().replace(/\.exe$/, '')
  const byHandle = new Map(
    (safePayload?.windows ?? []).flatMap((window) =>
      window.hwnd === undefined ? [] : [[window.hwnd, window] as const],
    ),
  )
  const used = new Set<UiaPluginPayload['windows'][number]>()
  const windows: UiaPluginPayload['windows'] = []
  const elements: UiaPluginPayload['elements'] = []
  for (const candidate of floor.windows) {
    let source =
      candidate.hwnd === undefined ? undefined : byHandle.get(candidate.hwnd)
    if (source === undefined && safePayload !== null) {
      // Old packs can lack HWND. Descriptions are not unique (two Explorer or
      // Chrome windows routinely share all three fields), so bind the closest
      // rectangle just as ContextSession.rebuild() does. Picking the first title
      // match can attach one window's entire control tree to its neighbour.
      let bestGap = Number.POSITIVE_INFINITY
      for (const window of safePayload.windows) {
        if (used.has(window)) continue
        if (normalizeProcess(window.process) !== normalizeProcess(candidate.process)) continue
        if (window.class_name !== candidate.class_name || window.title !== candidate.title) continue
        const gap = rectGap(window.bounds, candidate.bounds)
        if (gap < bestGap) {
          source = window
          bestGap = gap
        }
      }
    }
    // Pixels were frozen before the asynchronous UIA helper could finish. A
    // same-HWND window can move or resize in that gap; accepting its later tree
    // would put boxes (and possibly later labels) on an earlier image. Invisible
    // frame differences fit inside the same measured tolerance used by the
    // temporal session; a materially different rectangle is rejected.
    if (
      source !== undefined &&
      !(monitorClippedWindows.has(source) && containsImageRect(candidate.bounds, source.bounds)) &&
      rectGap(source.bounds, candidate.bounds) > IMAGE_WINDOW_MATCH_SLACK
    ) {
      source = undefined
    }
    if (source !== undefined) used.add(source)
    const z = windows.length
    const sourceElements =
      source === undefined || safePayload === null
        ? []
        : safePayload.elements.filter((element) => element.window === source.z)
    windows.push({
      ...(candidate.hwnd === undefined ? {} : { hwnd: candidate.hwnd }),
      title: candidate.title,
      process: candidate.process,
      class_name: candidate.class_name,
      bounds: { ...candidate.bounds },
      focused: candidate.focused,
      z,
      tree: source?.tree ?? 'skipped',
      element_count: sourceElements.length,
    })
    for (const element of sourceElements) {
      const bounds = clipImageRect(element.bounds, candidate.bounds)
      if (bounds === null) continue
      const placed = { ...element, bounds, window: z }
      delete placed.display
      elements.push(placed)
    }
    const written = windows[windows.length - 1]
    if (written !== undefined) {
      written.element_count = elements.filter((element) => element.window === z).length
    }
  }
  if (windows.length === 0) return safePayload
  return {
    captured_at: safePayload?.captured_at ?? capturedAt,
    budget_ms: safePayload?.budget_ms ?? 0,
    truncated: safePayload?.truncated ?? false,
    // Carried like the other two rebuilds. Note this stage DROPS elements that
    // clip away to nothing against the window floor, which is how a refused
    // rectangle's parent can vanish and leave it looking innocent — the reason
    // writeUiaPlugin tests once more against the array it serializes.
    ...(safePayload?.geometry_refused === undefined
      ? {}
      : { geometry_refused: safePayload.geometry_refused }),
    windows,
    elements,
  }
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
    const window: UiaWindowRecord = {
      ...(source.hwnd === undefined ? {} : { hwnd: source.hwnd }),
      title: source.title,
      process: source.process,
      class_name: source.class_name,
      bounds,
      focused: source.focused,
      z: newIndex,
      tree: source.tree,
      element_count: 0,
    }
    windows.push(window)
    if (monitorClippedWindows.has(source)) monitorClippedWindows.add(window)
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
    // Carried, not rebuilt away: the count of refused rectangles is part of the
    // claim the payload makes, and cropping or composing does not un-refuse one.
    ...(payload.geometry_refused === undefined
      ? {}
      : { geometry_refused: payload.geometry_refused }),
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

function clippedByPlacement(
  bounds: UiaBounds,
  placement: ImageDesktopPlacement,
): boolean {
  return (
    bounds.x < 0 ||
    bounds.y < 0 ||
    bounds.x + bounds.width > placement.width ||
    bounds.y + bounds.height > placement.height
  )
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
    const window: UiaWindowRecord = {
      ...(source.hwnd === undefined ? {} : { hwnd: source.hwnd }),
      title: source.title,
      process: source.process,
      class_name: source.class_name,
      bounds,
      focused: source.focused,
      z: newIndex,
      tree: source.tree,
      element_count: 0,
    }
    windows.push(window)
    if (clippedByPlacement(source.bounds, placement)) monitorClippedWindows.add(window)
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
    // A source window is mapped through its dominant display, while a child of
    // a straddling window can correctly map through the other display. The
    // composed image has one coordinate space, so reunite the owner enough to
    // cover every surviving child. The trigger-time Win32 floor later supplies
    // the exact full rectangle; this union is the safe floor when that lane is
    // unavailable.
    const owner = windows[newWindow]
    const sourceWindow = payload.windows[source.window]
    if (
      owner !== undefined &&
      sourceWindow !== undefined &&
      sourceDisplay(source.display, focusedDisplay) !==
        sourceDisplay(sourceWindow.display, focusedDisplay)
    ) {
      owner.bounds = unionImageRect(owner.bounds, bounds)
    }
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
    // Carried, not rebuilt away: the count of refused rectangles is part of the
    // claim the payload makes, and cropping or composing does not un-refuse one.
    ...(payload.geometry_refused === undefined
      ? {}
      : { geometry_refused: payload.geometry_refused }),
    windows,
    elements,
  }
}
