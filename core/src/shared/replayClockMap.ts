/**
 * A same-frame observation joining encoded replay PTS to the monotonic
 * wall-comparable session clock used by capture context.
 *
 * This module maps time axes only. It must not be used to synthesize or
 * interpolate object geometry, DOM state, UIA state, or annotations.
 */
export interface ReplayClockAnchor {
  ptsMs: number
  sessionMs: number
}

export interface ObservedReplayClockMap {
  readonly anchors: readonly Readonly<ReplayClockAnchor>[]
  /**
   * Maximum distance outside the measured range in the queried input axis.
   *
   * For ptsToSessionMs this is PTS distance. For sessionToPtsMs this is
   * session-clock distance. Values farther away remain unknown.
   */
  readonly maxExtrapolationMs: number
}

export type ReplayClockMapRejection =
  | 'insufficient-anchors'
  | 'invalid-extrapolation-bound'
  | 'non-finite-anchor'
  | 'pts-not-strictly-increasing'
  | 'session-not-strictly-increasing'

export type ReplayClockMapDecision =
  | { status: 'ready'; map: ObservedReplayClockMap }
  | {
      status: 'rejected'
      reason: ReplayClockMapRejection
      /** Anchor at which validation failed, when the failure belongs to one. */
      index?: number
    }

/**
 * Permit at most one actually observed edge segment of clock projection.
 *
 * The shorter edge segment is deliberately used for both directions. This is
 * a data-derived bound for the two time axes, not permission to interpolate
 * object state or to fill an arbitrarily long unobserved tail.
 */
export function measuredEdgeExtrapolationMs(
  anchors: readonly ReplayClockAnchor[],
): number {
  if (anchors.length < 2) return 0
  const first = anchors[0]
  const second = anchors[1]
  const beforeLast = anchors[anchors.length - 2]
  const last = anchors[anchors.length - 1]
  if (
    first === undefined
    || second === undefined
    || beforeLast === undefined
    || last === undefined
  ) {
    return 0
  }
  const firstSpan = second.ptsMs - first.ptsMs
  const lastSpan = last.ptsMs - beforeLast.ptsMs
  return (
    Number.isFinite(firstSpan)
    && Number.isFinite(lastSpan)
    && firstSpan > 0
    && lastSpan > 0
  )
    ? Math.min(firstSpan, lastSpan)
    : 0
}

/**
 * Validate and snapshot measured same-frame anchors.
 *
 * Two anchors are the minimum because interpolation and bounded edge
 * extrapolation both require an actually measured segment. The input order is
 * preserved and must already be chronological on both axes; sorting here
 * could hide a crossed or otherwise incoherent clock observation.
 */
export function createObservedReplayClockMap(
  anchors: readonly ReplayClockAnchor[],
  maxExtrapolationMs: number,
): ReplayClockMapDecision {
  if (!Number.isFinite(maxExtrapolationMs) || maxExtrapolationMs < 0) {
    return { status: 'rejected', reason: 'invalid-extrapolation-bound' }
  }
  if (anchors.length < 2) {
    return { status: 'rejected', reason: 'insufficient-anchors' }
  }

  const copied: Readonly<ReplayClockAnchor>[] = []
  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index]
    if (
      anchor === undefined ||
      !Number.isFinite(anchor.ptsMs) ||
      !Number.isFinite(anchor.sessionMs)
    ) {
      return { status: 'rejected', reason: 'non-finite-anchor', index }
    }
    const previous = copied[index - 1]
    if (previous !== undefined && anchor.ptsMs <= previous.ptsMs) {
      return {
        status: 'rejected',
        reason: 'pts-not-strictly-increasing',
        index,
      }
    }
    if (previous !== undefined && anchor.sessionMs <= previous.sessionMs) {
      return {
        status: 'rejected',
        reason: 'session-not-strictly-increasing',
        index,
      }
    }
    copied.push(Object.freeze({
      ptsMs: anchor.ptsMs,
      sessionMs: anchor.sessionMs,
    }))
  }

  return {
    status: 'ready',
    map: Object.freeze({
      anchors: Object.freeze(copied),
      maxExtrapolationMs,
    }),
  }
}

function mapMonotonicCoordinate(
  anchors: readonly Readonly<ReplayClockAnchor>[],
  query: number,
  maxExtrapolationMs: number,
  source: (anchor: Readonly<ReplayClockAnchor>) => number,
  target: (anchor: Readonly<ReplayClockAnchor>) => number,
): number | undefined {
  if (!Number.isFinite(query)) return undefined

  let low = 0
  let high = anchors.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    const anchor = anchors[middle]
    if (anchor !== undefined && source(anchor) < query) low = middle + 1
    else high = middle
  }

  const exact = anchors[low]
  if (exact !== undefined && source(exact) === query) {
    // Preserve the exact observed counterpart instead of re-calculating it.
    return target(exact)
  }

  let leftIndex: number
  let rightIndex: number
  if (low === 0) {
    const first = anchors[0]
    if (
      first === undefined ||
      source(first) - query > maxExtrapolationMs
    ) {
      return undefined
    }
    leftIndex = 0
    rightIndex = 1
  } else if (low === anchors.length) {
    const lastIndex = anchors.length - 1
    const last = anchors[lastIndex]
    if (
      last === undefined ||
      query - source(last) > maxExtrapolationMs
    ) {
      return undefined
    }
    leftIndex = lastIndex - 1
    rightIndex = lastIndex
  } else {
    leftIndex = low - 1
    rightIndex = low
  }

  const left = anchors[leftIndex]
  const right = anchors[rightIndex]
  if (left === undefined || right === undefined) return undefined
  const sourceSpan = source(right) - source(left)
  const mapped =
    target(left) +
    ((query - source(left)) / sourceSpan) *
      (target(right) - target(left))
  return Number.isFinite(mapped) ? mapped : undefined
}

/** Map encoded replay PTS to the observed wall-comparable session clock. */
export function ptsToSessionMs(
  map: ObservedReplayClockMap,
  ptsMs: number,
): number | undefined {
  return mapMonotonicCoordinate(
    map.anchors,
    ptsMs,
    map.maxExtrapolationMs,
    (anchor) => anchor.ptsMs,
    (anchor) => anchor.sessionMs,
  )
}

/** Invert the observed clock map from session time back to encoded replay PTS. */
export function sessionToPtsMs(
  map: ObservedReplayClockMap,
  sessionMs: number,
): number | undefined {
  return mapMonotonicCoordinate(
    map.anchors,
    sessionMs,
    map.maxExtrapolationMs,
    (anchor) => anchor.sessionMs,
    (anchor) => anchor.ptsMs,
  )
}
