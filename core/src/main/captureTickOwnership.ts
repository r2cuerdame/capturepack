/**
 * Which recorder owns the one frame-tick chain that clocks the surface ring.
 *
 * `preferredDisplayId` is sampled ONCE by the rebuild caller. Keeping screen
 * reads out of this helper is what prevents a cursor move between asynchronous
 * recorder-window creations from appointing two owners.
 */
export function selectRecorderTickOwner(
  displayIds: readonly number[],
  preferredDisplayId: number,
  currentOwnerDisplayId: number | null = null,
): number | null {
  if (displayIds.length === 0) return null
  // Recorder rebuilds happen for FPS/retention changes and recovery as well as
  // display topology changes. Keep the live owner when it still exists: moving
  // the cursor must not turn an unrelated rebuild into a clock handoff.
  if (currentOwnerDisplayId !== null && displayIds.includes(currentOwnerDisplayId)) {
    return currentOwnerDisplayId
  }
  return displayIds.includes(preferredDisplayId) ? preferredDisplayId : displayIds[0]!
}

export type RecorderTickOwnership = 'owner' | 'passive'

/**
 * A delayed callback belongs to the resource instance that scheduled it, not
 * merely to its display id. Rebuilds reuse display ids, so an old window close
 * or timer callback must not clear/mutate the replacement's state.
 */
export function isCurrentRecorderResource<T>(
  current: T | undefined,
  expected: T,
): boolean {
  return current === expected
}

/** The stable role one display gets from a rebuild's single owner decision. */
export function recorderTickOwnership(
  displayId: number,
  ownerDisplayId: number | null,
): RecorderTickOwnership {
  return ownerDisplayId !== null && displayId === ownerDisplayId ? 'owner' : 'passive'
}

export interface CaptureRecorderSignature {
  width: number
  height: number
  scaleFactor: number
  fps: number
  replaySeconds: number
  replayMaxWidth: number
  tickOwnership: RecorderTickOwnership
}

/**
 * Everything a running recorder window depends on, including whether it owns
 * frame ticks. A role change must recreate that window so its immutable
 * CaptureStartPayload cannot leave both the old and new owner ticking.
 */
export function captureRecorderSignature(parts: CaptureRecorderSignature): string {
  return [
    parts.width,
    parts.height,
    parts.scaleFactor,
    parts.fps,
    parts.replaySeconds,
    parts.replayMaxWidth,
    parts.tickOwnership,
  ].join(':')
}
