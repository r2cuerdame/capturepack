interface PersistedScreenGeometry {
  width: number
  height: number
  scale: number
}

interface PersistedDisplayGeometry {
  index: number
  focused: boolean
  bounds: { x: number; y: number; width: number; height: number }
  scale: number
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
}: {
  snapshotWidth: number
  snapshotHeight: number
  screens: readonly PersistedScreenGeometry[]
  displays: readonly PersistedDisplayGeometry[] | undefined
  loadedDisplays: readonly ReopenedLoadedDisplayGeometry[]
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
  return [{
    index: persistedIndex ?? 1,
    focused: true,
    width: snapshotWidth,
    height: snapshotHeight,
    ...(snapshotPixelsPerDip === undefined ? {} : { snapshotPixelsPerDip }),
  }]
}

function safeDisplayIndex(value: number | undefined): value is number {
  return Number.isSafeInteger(value) && (value ?? 0) >= 1
}
