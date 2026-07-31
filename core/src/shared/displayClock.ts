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

/**
 * WHETHER A DISPLAY'S REPLAY IS ON THE CAPTURE'S CLOCK AT ALL (#110).
 *
 * A screen nobody touched produces almost no frames, and the fragments it does
 * produce are laid end to end: 18691 ms of capture came back as a 3688 ms
 * replay whose frames sit at a uniform 66.6 ms. Fifteen seconds of stillness is
 * simply not in the file, so a box placed at a pack time has no matching moment
 * in that picture — and `replay_clock_offset_ms` cannot help, because an offset
 * shifts an axis and this one would have to stretch.
 *
 * Recovering those instants needs per-frame times the recorder does not have.
 * `captureCadence` polls a counter and says so ("it cannot see WHEN each frame
 * arrived"), and the one observer that could — a `requestVideoFrameCallback`
 * sink — is deliberately attached to the focused display only, because
 * attaching it costs that display its frame rate. Measured: the display that
 * ticked managed 10.1 fps with an 897 ms stall while its neighbour held 14.8.
 *
 * So this does not repair the axis. It names it. A reader that knows the media
 * covers a fifth of the capture can decline to place anything on that display's
 * timeline, instead of placing it confidently in the wrong second.
 */
export interface ReplayCoverage {
  /** Encoded media length, ms. */
  mediaMs: number
  /** How long the capture itself ran, ms. */
  captureMs: number
  /** mediaMs / captureMs, clamped to 0..1. */
  ratio: number
  /** Capture time with no media behind it at all. */
  missingMs: number
  /** The media is short enough that its timeline is not the capture's. */
  compressed: boolean
}

/** A display may start late or stop early by this much and still be on-clock. */
const REPLAY_COVERAGE_TOLERANCE_MS = 1_000
/** Below this share of the capture, the gaps are the story, not the edges. */
const REPLAY_COVERAGE_MIN_RATIO = 0.9

export function replayCoverage(mediaMs: number, captureMs: number): ReplayCoverage {
  const media = Number.isFinite(mediaMs) ? Math.max(0, mediaMs) : 0
  const capture = Number.isFinite(captureMs) ? Math.max(0, captureMs) : 0
  const missingMs = Math.max(0, capture - media)
  const ratio = capture > 0 ? Math.min(1, media / capture) : 1
  return {
    mediaMs: media,
    captureMs: capture,
    ratio,
    missingMs,
    compressed:
      capture > 0
      && missingMs > REPLAY_COVERAGE_TOLERANCE_MS
      && ratio < REPLAY_COVERAGE_MIN_RATIO,
  }
}
