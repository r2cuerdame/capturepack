interface PersistedScreenGeometry {
  width: number
  height: number
  scale: number
  bounds?: { x: number; y: number; width: number; height: number }
}

interface PersistedDisplayGeometry {
  index: number
  focused: boolean
  bounds: { x: number; y: number; width: number; height: number }
  scale: number
}

interface PersistedImageCropGeometry {
  x: number
  y: number
  width: number
  height: number
  coordinate_space: 'virtual-desktop-dip'
}

export interface ReopenedLoadedDisplayGeometry {
  index: number
  focused: boolean
  width: number
  height: number
  scale: number
}

export interface ReopenedContextDisplayTarget {
  index: number
  focused: boolean
  width: number
  height: number
  snapshotPixelsPerDip?: number
  /** Crop provenance; affine only when snapshotPixelsPerDip is present too. */
  snapshotDipBounds?: { x: number; y: number; width: number; height: number }
}

function positive(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

function rasterMatches(
  width: number,
  height: number,
  snapshotWidth: number,
  snapshotHeight: number,
): boolean {
  return (
    Math.round(width) === Math.round(snapshotWidth)
    && Math.round(height) === Math.round(snapshotHeight)
  )
}

/**
 * A one-monitor image region is the rare reopened raster that still has a
 * desktop placement: media.crop_bounds is in virtual-desktop DIP and the PNG
 * is its native-pixel projection. Keep that affine mapping only when both axes
 * agree and the density is one the captured desk actually declared. A region
 * spanning mixed-DPI displays has no single scale and must stay unmapped.
 */
function reopenedImageCropSpace(
  snapshotWidth: number,
  snapshotHeight: number,
  screens: readonly PersistedScreenGeometry[],
  cropBounds: PersistedImageCropGeometry | undefined,
): {
  snapshotPixelsPerDip: number
  snapshotDipBounds: { x: number; y: number; width: number; height: number }
} | null {
  if (
    cropBounds === undefined
    || cropBounds.coordinate_space !== 'virtual-desktop-dip'
    || !Number.isFinite(cropBounds.x)
    || !Number.isFinite(cropBounds.y)
    || !positive(cropBounds.width)
    || !positive(cropBounds.height)
    || !positive(snapshotWidth)
    || !positive(snapshotHeight)
  ) {
    return null
  }
  const scaleX = snapshotWidth / cropBounds.width
  const scaleY = snapshotHeight / cropBounds.height
  const tolerance = Math.max(1, scaleX, scaleY) * 1e-9
  if (!positive(scaleX) || !positive(scaleY) || Math.abs(scaleX - scaleY) > tolerance) {
    return null
  }
  const scale = (scaleX + scaleY) / 2
  const declared = screens.some((screen) => {
    const bounds = screen.bounds
    if (
      bounds === undefined
      || !Number.isFinite(bounds.x)
      || !Number.isFinite(bounds.y)
      || !positive(bounds.width)
      || !positive(bounds.height)
      || !positive(screen.scale)
      || Math.abs(screen.scale - scale) > tolerance
    ) {
      return false
    }
    const edgeTolerance = 1e-7
    return (
      cropBounds.x >= bounds.x - edgeTolerance
      && cropBounds.y >= bounds.y - edgeTolerance
      && cropBounds.x + cropBounds.width <= bounds.x + bounds.width + edgeTolerance
      && cropBounds.y + cropBounds.height <= bounds.y + bounds.height + edgeTolerance
    )
  })
  if (!declared) return null
  return {
    snapshotPixelsPerDip: scale,
    snapshotDipBounds: {
      x: cropBounds.x,
      y: cropBounds.y,
      width: cropBounds.width,
      height: cropBounds.height,
    },
  }
}

/**
 * Resolves the saved snapshot's pixels-per-DIP without consulting the current
 * desktop or assuming that pack display 1 means environment screen 1.
 *
 * A single-display CapturePack intentionally reindexes its captured display to
 * pack display 1. On a multi-monitor desk the physical source can therefore be
 * `environment.screens[1]` (or later). A focused media declaration identifies
 * it by persisted bounds × scale; when that declaration is absent, the native
 * snapshot raster can identify one environment screen. Ambiguous equal-size
 * screens with different scales remain unknown instead of being guessed.
 */
export function reopenedSnapshotPixelsPerDip({
  snapshotWidth,
  snapshotHeight,
  screens,
  displays,
}: {
  snapshotWidth: number
  snapshotHeight: number
  screens: readonly PersistedScreenGeometry[]
  displays: readonly PersistedDisplayGeometry[] | undefined
}): number | undefined {
  if (!positive(snapshotWidth) || !positive(snapshotHeight)) return undefined

  const focused = (displays ?? []).filter(
    (display) =>
      display.focused
      && positive(display.bounds.width)
      && positive(display.bounds.height)
      && positive(display.scale),
  )
  if (focused.length === 1) {
    const display = focused[0]
    if (
      display !== undefined
      && rasterMatches(
        display.bounds.width * display.scale,
        display.bounds.height * display.scale,
        snapshotWidth,
        snapshotHeight,
      )
    ) {
      return display.scale
    }
  }

  const matchingScales = screens
    .filter(
      (screen) =>
        positive(screen.width)
        && positive(screen.height)
        && positive(screen.scale)
        && rasterMatches(
          screen.width,
          screen.height,
          snapshotWidth,
          snapshotHeight,
        ),
    )
    .map((screen) => screen.scale)
  if (matchingScales.length === 0) return undefined
  const uniqueScales = new Set(matchingScales)
  return uniqueScales.size === 1 ? matchingScales[0] : undefined
}

/**
 * Builds the display identities used by a reopened ContextSession.
 *
 * A degraded multi-display pack may have lost every non-focused snapshot while
 * its top-level focused `snapshot.png` remains usable. That is still display 2
 * (or 3, etc.) in the saved pack; reindexing the one surviving board slice to 1
 * disconnects persisted surfaces/candidates from the editor's ObjectIndex.
 *
 * Keep every successfully loaded declaration, including a one-entry remainder.
 * Only a pack with no usable display declaration falls back to one top-level
 * snapshot, and even then a unique persisted focused declaration supplies its
 * original index.
 */
export function reopenedContextDisplayTargets({
  snapshotWidth,
  snapshotHeight,
  screens,
  displays,
  loadedDisplays,
  cropBounds,
}: {
  snapshotWidth: number
  snapshotHeight: number
  screens: readonly PersistedScreenGeometry[]
  displays: readonly PersistedDisplayGeometry[] | undefined
  loadedDisplays: readonly ReopenedLoadedDisplayGeometry[]
  cropBounds?: PersistedImageCropGeometry
}): ReopenedContextDisplayTarget[] {
  if (loadedDisplays.length > 0) {
    return loadedDisplays.map((display) => ({
      index: display.index,
      focused: display.focused,
      width: display.width,
      height: display.height,
      snapshotPixelsPerDip: display.scale,
    }))
  }

  const focused = (displays ?? []).filter((display) => display.focused)
  const persistedIndex =
    focused.length === 1 && safeDisplayIndex(focused[0]?.index)
      ? focused[0]?.index
      : 1
  const snapshotPixelsPerDip = reopenedSnapshotPixelsPerDip({
    snapshotWidth,
    snapshotHeight,
    screens,
    displays,
  })
  const imageCropSpace = reopenedImageCropSpace(
    snapshotWidth,
    snapshotHeight,
    screens,
    cropBounds,
  )
  const persistedCrop =
    cropBounds !== undefined
    && cropBounds.coordinate_space === 'virtual-desktop-dip'
    && Number.isFinite(cropBounds.x)
    && Number.isFinite(cropBounds.y)
    && positive(cropBounds.width)
    && positive(cropBounds.height)
      ? {
          snapshotDipBounds: {
            x: cropBounds.x,
            y: cropBounds.y,
            width: cropBounds.width,
            height: cropBounds.height,
          },
        }
      : null
  return [{
    index: persistedIndex ?? 1,
    focused: true,
    width: snapshotWidth,
    height: snapshotHeight,
    ...(imageCropSpace ?? persistedCrop ??
      (snapshotPixelsPerDip === undefined ? {} : { snapshotPixelsPerDip })),
  }]
}

function safeDisplayIndex(value: number | undefined): value is number {
  return Number.isSafeInteger(value) && (value ?? 0) >= 1
}
