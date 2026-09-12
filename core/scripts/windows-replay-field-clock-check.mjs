// Execute the field runner's real acceptance block with controlled decoded pixels
// and persisted context. This catches geometry-derived clock corrections.
import { readFileSync } from 'node:fs'
import { strict as assert } from 'node:assert'

const source = readFileSync(new URL('./windows-replay-field-check.mjs', import.meta.url), 'utf8')
const start = source.indexOf('    const alignmentKey =')
const end = source.indexOf('    report.past_sampling =', start)
assert(start >= 0 && end > start, 'field acceptance block must be exercised')
const evaluate = new (Object.getPrototypeOf(async function () {}).constructor)(
  'env', 'with (env) {' + source.slice(start, end) + '; return { pass, queries, visualPickPoints }; }',
)
const boundsAt = (time) => ({ x: time / 5, y: 0, width: 80, height: 80 })
const rectError = (a, b) => Math.max(...['x', 'y', 'width', 'height'].map((key) => Math.abs(a[key] - b[key])))
async function run(offsetMs, declaredOffsetMs = 0) {
  const times = [1000, 3000, 5000]
  const makeQuery = (time, points = []) => ({
    requested_t_ms: time, materialized_t_ms: time, coverage: 'covered',
    nearest_sample_unchanged: true, interpolated: false, display_queries: [],
    observed_windows: [{ display: 1, t_ms: time, bounds: boundsAt(time) }],
    candidates: [{ display: 1 }],
    picks: points.filter((p) => p.requestedTimeMs === time).map((p) => ({
      ...p, picked_target: p.x >= boundsAt(time).x && p.x <= boundsAt(time).x + 80,
    })),
  })
  const analysis = {
    status: 'loaded', reopen_identical: true, range: { start_ms: 0, end_ms: 7000 },
    queries: times.map((t) => makeQuery(t)),
    target_samples: times.flatMap((t) => [t, t + offsetMs].map((v) => ({
      display: 1, t_ms: v, bounds: boundsAt(v),
    }))),
  }
  const visualGroundTruth = new Map(analysis.queries.map((q) => [q, [{
    display: 1, nearest_frame_pts_ms: q.requested_t_ms + declaredOffsetMs,
    bounds: boundsAt(q.requested_t_ms + offsetMs), decode_error: null, mask_pixels: 6400,
  }]]))
  const env = {
    analysis, visualGroundTruth, fps: 15, timelineOriginMs: 0, movements: [],
    TEMPORAL_LAG_MIN_SEARCH_RADIUS_MS: 1000, TEMPORAL_LAG_FRAME_SEARCH_MULTIPLIER: 8,
    COORDINATE_EDGE_ERROR_LIMIT_PX: Number(source.match(/const COORDINATE_EDGE_ERROR_LIMIT_PX = (\d+)/)[1]), rectError,
    sourceLatencySign: () => 'positive', median: (v) => v.sort((a,b) => a-b)[Math.floor(v.length/2)],
    pastSamplingInput: { queryTimesMs: times },
    helper: { analyzePastSampling: async ({ queryTimesMs, pickPoints }) => ({
      reopen_identical: true, queries: queryTimesMs.map((t) => makeQuery(t, pickPoints)),
    }) },
    contextDisplays: [{ index: 1 }], displays: [{ index: 1, replay_clock_offset_ms: declaredOffsetMs }],
    probes: [], layout: {}, resolvedTargetId: 'primary',
    nearestMovement: () => null, fixtureDisplayIndexForPackDisplay: () => null,
    inferSourceLatencySample: () => ({ status: 'unavailable' }),
  }
  return evaluate(env)
}
const wrong = await run(700)
assert.equal(wrong.pass, false, 'geometry matching 700ms away MUST FAIL strict field acceptance')
assert(wrong.visualPickPoints.every((p) => [1000, 3000, 5000].includes(p.requestedTimeMs)),
  'production object picks must stay on the requested context clock')
assert.equal((await run(0)).pass, true, 'matching requested context and decoded pixels must pass')
assert.equal((await run(0, 200)).pass, true, 'declared media offset does not move the context query')
console.log('field strict clock: 4 passed (wrong-time geometry rejected; declared mapping retained)')
