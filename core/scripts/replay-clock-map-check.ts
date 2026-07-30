import {
  createObservedReplayClockMap,
  measuredEdgeExtrapolationMs,
  ptsToSessionMs,
  sessionToPtsMs,
  type ObservedReplayClockMap,
  type ReplayClockMapDecision,
} from '../src/shared/replayClockMap'

let failed = 0
let passed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) passed += 1
  else failed += 1
  console.log(
    `  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`,
  )
}

function readyMap(
  decision: ReplayClockMapDecision,
): ObservedReplayClockMap {
  if (decision.status !== 'ready') {
    throw new Error(`expected a ready clock map, got ${decision.reason}`)
  }
  return decision.map
}

function rejectedAs(
  decision: ReplayClockMapDecision,
  reason: string,
  index?: number,
): boolean {
  return (
    decision.status === 'rejected' &&
    decision.reason === reason &&
    (index === undefined || decision.index === index)
  )
}

const sourceAnchors = [
  { ptsMs: 0, sessionMs: 1_000 },
  { ptsMs: 100, sessionMs: 1_100 },
  { ptsMs: 200, sessionMs: 1_300 },
]
const map = readyMap(createObservedReplayClockMap(sourceAnchors, 25))

check(
  'exact measured anchors map without recalculation in both directions',
  map.anchors.every(
    (anchor) =>
      ptsToSessionMs(map, anchor.ptsMs) === anchor.sessionMs &&
      sessionToPtsMs(map, anchor.sessionMs) === anchor.ptsMs,
  ),
)
check(
  'every exact anchor round-trips PTS through the session clock',
  map.anchors.every((anchor) => {
    const sessionMs = ptsToSessionMs(map, anchor.ptsMs)
    return sessionMs !== undefined &&
      sessionToPtsMs(map, sessionMs) === anchor.ptsMs
  }),
)
check(
  'piecewise interpolation uses the first measured segment',
  ptsToSessionMs(map, 50) === 1_050 &&
    sessionToPtsMs(map, 1_050) === 50,
)
check(
  'piecewise interpolation uses the local changed-rate segment',
  ptsToSessionMs(map, 150) === 1_200 &&
    sessionToPtsMs(map, 1_200) === 150,
)
check(
  'left edge extrapolation uses only the nearest measured segment',
  ptsToSessionMs(map, -25) === 975 &&
    sessionToPtsMs(map, 975) === -25,
)
check(
  'right edge PTS extrapolation uses the nearest changed-rate segment',
  ptsToSessionMs(map, 225) === 1_350,
)
check(
  'inverse edge extrapolation uses its own bounded session input axis',
  sessionToPtsMs(map, 1_325) === 212.5,
)
check(
  'queries beyond either input-axis extrapolation bound stay unknown',
  ptsToSessionMs(map, -25.001) === undefined &&
    ptsToSessionMs(map, 225.001) === undefined &&
    sessionToPtsMs(map, 974.999) === undefined &&
    sessionToPtsMs(map, 1_325.001) === undefined,
)
check(
  'non-finite queries stay unknown',
  ptsToSessionMs(map, Number.NaN) === undefined &&
    ptsToSessionMs(map, Number.POSITIVE_INFINITY) === undefined &&
    sessionToPtsMs(map, Number.NEGATIVE_INFINITY) === undefined,
)

sourceAnchors[0]!.ptsMs = -999
sourceAnchors.push({ ptsMs: 300, sessionMs: 1_400 })
check(
  'the validated map snapshots and freezes its observations',
  map.anchors.length === 3 &&
    map.anchors[0]?.ptsMs === 0 &&
    Object.isFrozen(map) &&
    Object.isFrozen(map.anchors) &&
    map.anchors.every(Object.isFrozen),
)

check(
  'fewer than two observations cannot define a measured segment',
  rejectedAs(createObservedReplayClockMap([], 10), 'insufficient-anchors') &&
    rejectedAs(
      createObservedReplayClockMap([{ ptsMs: 0, sessionMs: 1_000 }], 10),
      'insufficient-anchors',
    ),
)
check(
  'duplicate PTS is rejected at the offending anchor',
  rejectedAs(
    createObservedReplayClockMap([
      { ptsMs: 0, sessionMs: 1_000 },
      { ptsMs: 0, sessionMs: 1_001 },
    ], 10),
    'pts-not-strictly-increasing',
    1,
  ),
)
check(
  'decreasing PTS is rejected instead of silently sorting anchors',
  rejectedAs(
    createObservedReplayClockMap([
      { ptsMs: 1, sessionMs: 1_000 },
      { ptsMs: 0, sessionMs: 1_001 },
    ], 10),
    'pts-not-strictly-increasing',
    1,
  ),
)
check(
  'duplicate session time is rejected at the offending anchor',
  rejectedAs(
    createObservedReplayClockMap([
      { ptsMs: 0, sessionMs: 1_000 },
      { ptsMs: 1, sessionMs: 1_000 },
    ], 10),
    'session-not-strictly-increasing',
    1,
  ),
)
check(
  'decreasing session time is rejected instead of inventing a clock crossing',
  rejectedAs(
    createObservedReplayClockMap([
      { ptsMs: 0, sessionMs: 1_001 },
      { ptsMs: 1, sessionMs: 1_000 },
    ], 10),
    'session-not-strictly-increasing',
    1,
  ),
)
check(
  'NaN and infinity in either anchor axis are rejected',
  rejectedAs(
    createObservedReplayClockMap([
      { ptsMs: 0, sessionMs: 1_000 },
      { ptsMs: Number.NaN, sessionMs: 1_001 },
    ], 10),
    'non-finite-anchor',
    1,
  ) &&
    rejectedAs(
      createObservedReplayClockMap([
        { ptsMs: 0, sessionMs: 1_000 },
        { ptsMs: 1, sessionMs: Number.POSITIVE_INFINITY },
      ], 10),
      'non-finite-anchor',
      1,
    ),
)
check(
  'negative, NaN, and infinite extrapolation bounds are rejected',
  rejectedAs(
    createObservedReplayClockMap([
      { ptsMs: 0, sessionMs: 1_000 },
      { ptsMs: 1, sessionMs: 1_001 },
    ], -1),
    'invalid-extrapolation-bound',
  ) &&
    rejectedAs(
      createObservedReplayClockMap([
        { ptsMs: 0, sessionMs: 1_000 },
        { ptsMs: 1, sessionMs: 1_001 },
      ], Number.NaN),
      'invalid-extrapolation-bound',
    ) &&
    rejectedAs(
      createObservedReplayClockMap([
        { ptsMs: 0, sessionMs: 1_000 },
        { ptsMs: 1, sessionMs: 1_001 },
      ], Number.POSITIVE_INFINITY),
      'invalid-extrapolation-bound',
    ),
)

const noExtrapolation = readyMap(createObservedReplayClockMap([
  { ptsMs: 10, sessionMs: 20 },
  { ptsMs: 20, sessionMs: 30 },
], 0))
check(
  'a zero bound permits interpolation and exact anchors but no extrapolation',
  ptsToSessionMs(noExtrapolation, 15) === 25 &&
    ptsToSessionMs(noExtrapolation, 10) === 20 &&
    ptsToSessionMs(noExtrapolation, 9.999) === undefined &&
    sessionToPtsMs(noExtrapolation, 30.001) === undefined,
)
check(
  'edge projection is bounded by the shorter actually observed edge segment',
  measuredEdgeExtrapolationMs([
    { ptsMs: 440, sessionMs: 1_000 },
    { ptsMs: 1_440, sessionMs: 2_010 },
    { ptsMs: 9_400, sessionMs: 10_050 },
    { ptsMs: 10_380, sessionMs: 11_040 },
  ]) === 980,
)
check(
  'invalid or insufficient edge observations grant no extrapolation',
  measuredEdgeExtrapolationMs([]) === 0
    && measuredEdgeExtrapolationMs([
      { ptsMs: 10, sessionMs: 20 },
    ]) === 0
    && measuredEdgeExtrapolationMs([
      { ptsMs: 10, sessionMs: 20 },
      { ptsMs: 10, sessionMs: 30 },
    ]) === 0,
)

console.log(
  `\nresult: ${failed === 0 ? 'OK' : 'FAILED'} — ${passed} passed, ${failed} failed`,
)
if (failed > 0) process.exitCode = 1
