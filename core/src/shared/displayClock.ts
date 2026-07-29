/**
 * The observed conversion from the pack clock to one display recorder's clock.
 *
 * Both origins are measurements on the same wall-comparable monotonic axis.
 * The result is rounded only because the manifest clock is integer
 * milliseconds; no duration or stop-time assumption is involved.
 */
export function observedReplayClockOffsetMs(
  packOriginMs: number | undefined,
  displayOriginMs: number | undefined,
): number | undefined {
  if (
    packOriginMs === undefined ||
    displayOriginMs === undefined ||
    !Number.isFinite(packOriginMs) ||
    !Number.isFinite(displayOriginMs)
  ) {
    return undefined
  }
  const offsetMs = Math.round(packOriginMs - displayOriginMs)
  return Number.isSafeInteger(offsetMs) ? offsetMs : undefined
}

/**
 * Resolve a display clock from a saved declaration.
 *
 * Packs written before replay_clock_offset_ms used end-alignment. Keep that
 * duration-difference rule as a compatibility fallback, never as a substitute
 * when an observed offset is present.
 */
export function resolvedReplayClockOffsetMs(
  declaredOffsetMs: unknown,
  displayDurationMs: number,
  focusedDurationMs: number,
): number {
  return typeof declaredOffsetMs === 'number' && Number.isSafeInteger(declaredOffsetMs)
    ? declaredOffsetMs
    : Math.round(displayDurationMs - focusedDurationMs)
}

/** Map a kept pack-clock interval onto one display's source replay. */
export function displayReplayRangeMs(
  packStartMs: number,
  packEndMs: number,
  observedOffsetMs: number | undefined,
  displayDurationMs: number,
  focusedDurationMs: number,
): { startMs: number; endMs: number } {
  const offsetMs = resolvedReplayClockOffsetMs(
    observedOffsetMs,
    displayDurationMs,
    focusedDurationMs,
  )
  return {
    startMs: packStartMs + offsetMs,
    endMs: packEndMs + offsetMs,
  }
}

/**
 * Decide which independently recorded displays can be kept in one pack clock.
 *
 * The focused replay is the clock master used by the editor, trim pipeline,
 * manifest and reopened scrubber. A secondary replay without that master is
 * not merely inconvenient: it has no defined pack-time mapping and can retain
 * an untrimmed ring segment. In that case every display must degrade together
 * to the frozen capture frame. We deliberately do not promote a secondary
 * recorder here; doing so would change which display owns the user's timeline.
 */
export function retainedDisplayReplayMask(
  displays: readonly { focused: boolean; hasReplay: boolean }[],
): boolean[] {
  const focused = displays.find((display) => display.focused)
  const hasClockMaster = focused?.hasReplay === true
  return displays.map((display) => hasClockMaster && display.hasReplay)
}

export interface FocusedReplayTimelineClock {
  /** Start of the raw recorder bytes written by save-first. */
  rawT0Ms: number
  /** Start of the logical last-N window exposed by the editor/final pack. */
  packT0Ms: number
  /** End of that logical window on the same wall-comparable axis. */
  packEndMs: number
  /** True only when rawT0Ms came from the recorder's measured slot origin. */
  measured: boolean
}

/**
 * Resolve both clocks carried by a fresh focused replay.
 *
 * Replay assembly completion is deliberately not an input. A slow mux flush,
 * IPC reply, or secondary display can delay when main receives the bytes, but
 * cannot move pixels already recorded. When the renderer could not report its
 * slot origin, the focused request wall time is the closest end anchor; a
 * screenshot-only capture has no replay clock and stays at the trigger instant.
 */
export function resolveFocusedReplayTimelineClock(input: {
  replayOriginMs: number | undefined
  replayRequestWallMs: number | undefined
  captureWallMs: number
  rawDurationMs: number
  logicalDurationMs: number
}): FocusedReplayTimelineClock {
  const captureWallMs = Number.isFinite(input.captureWallMs)
    ? Math.round(input.captureWallMs)
    : 0
  const rawDurationMs = Math.max(0, Math.round(input.rawDurationMs))
  const logicalDurationMs = Math.min(
    rawDurationMs,
    Math.max(0, Math.round(input.logicalDurationMs)),
  )
  if (rawDurationMs === 0) {
    return {
      rawT0Ms: captureWallMs,
      packT0Ms: captureWallMs,
      packEndMs: captureWallMs,
      measured: false,
    }
  }

  const measured = Number.isFinite(input.replayOriginMs)
  const fallbackEndMs = Number.isFinite(input.replayRequestWallMs)
    ? Math.round(input.replayRequestWallMs as number)
    : captureWallMs
  const rawT0Ms = measured
    ? Math.round(input.replayOriginMs as number)
    : fallbackEndMs - rawDurationMs
  const packT0Ms = rawT0Ms + (rawDurationMs - logicalDurationMs)
  return {
    rawT0Ms,
    packT0Ms,
    packEndMs: packT0Ms + logicalDurationMs,
    measured,
  }
}

export interface DisplayedContextClock {
  display: number
  hasReplay: boolean
  /** Pack-clock time of the frame this display actually presented. */
  presentedMs: number
}

/**
 * Context is queried on each display's presented-frame clock, not once at the
 * focused display's time. A replay-less secondary is still showing its native
 * capture snapshot while the focused video scrubs, so it stays at pack end.
 */
export function contextFrameRequestsForDisplays(
  atNow: boolean,
  replayDurationMs: number,
  displays: readonly DisplayedContextClock[],
): Array<{ display: number; timeMs: number }> {
  const endMs = Math.max(0, Math.round(replayDurationMs))
  return displays.map((display) => ({
    display: display.display,
    timeMs:
      atNow || !display.hasReplay
        ? endMs
        : Math.max(0, Math.min(endMs, Math.round(display.presentedMs))),
  }))
}
