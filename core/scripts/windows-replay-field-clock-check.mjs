// Execute the field runner's real acceptance block with controlled decoded pixels
// and persisted context. This catches geometry-derived clock corrections.
import { existsSync, readFileSync } from 'node:fs'
import { strict as assert } from 'node:assert'

const source = readFileSync(new URL('./windows-replay-field-check.mjs', import.meta.url), 'utf8')
const clockFunctionsStart = source.indexOf('function parseReplayPresentationClocks')
const clockFunctionsEnd = source.indexOf('function parsePerformanceEvidence', clockFunctionsStart)
const latencyFunctionsStart = source.indexOf('function sourceLatencySign')
const latencyFunctionsEnd = source.indexOf('function summarizeSourceLatency', latencyFunctionsStart)
assert(clockFunctionsStart >= 0 && clockFunctionsEnd > clockFunctionsStart)
assert(latencyFunctionsStart >= 0 && latencyFunctionsEnd > latencyFunctionsStart)
const clockFunctions = new Function(
  source.slice(clockFunctionsStart, clockFunctionsEnd) +
  source.slice(latencyFunctionsStart, latencyFunctionsEnd) +
  '; return { parseReplayPresentationClocks, inferSourceLatencySample };',
)()
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

const evidenceRoot = new URL('../../docs/evidence/pr156-stabilization/field/', import.meta.url)
const cases = ['shipping-1', 'native-1', 'shipping-2', 'native-2', 'shipping-3', 'native-3']
let correctedSamples = 0
for (const name of cases) {
  const reportUrl = new URL(`${name}/report.json`, evidenceRoot)
  const logUrl = new URL(`${name}/main.log.txt`, evidenceRoot)
  assert(existsSync(reportUrl) && existsSync(logUrl), `${name} preserved field evidence is required`)
  const report = JSON.parse(readFileSync(reportUrl, 'utf8'))
  const clocks = clockFunctions.parseReplayPresentationClocks(readFileSync(logUrl, 'utf8'))
  for (const sample of report.past_sampling?.source_latency?.samples ?? []) {
    if (sample.status !== 'measured') continue
    const media = report.media.find((item) => item.display === sample.display)
    const recomputed = clockFunctions.inferSourceLatencySample({
      timelineOriginMs: Date.parse(report.past_sampling.timeline_origin),
      encodedFramePtsMs: sample.encoded_frame_pts_ms,
      replayClockAnchors: clocks.get(String(media?.fixture_display_id)),
      pixelMatch: {
        status: 'measured',
        inferred_wall_time_ms: sample.inferred_pixel_wall_time_ms,
        uncertainty_ms: sample.uncertainty_ms,
        confidence: sample.confidence,
        confidence_score: sample.confidence_score,
      },
    })
    assert.equal(recomputed.status, 'measured', `${name} source sample remains measurable`)
    assert.equal(
      recomputed.encoded_frame_clock_basis,
      'piecewise-replay-presentation-clock',
      `${name} must use its recorded presentation anchors`,
    )
    if (Math.abs(recomputed.source_latency_ms - sample.source_latency_ms) > 0.001) {
      correctedSamples += 1
    }
    if (
      name === 'shipping-3'
      && Math.abs(sample.encoded_frame_pts_ms - 8_932.667) < 0.001
    ) {
      assert(
        Math.abs(recomputed.source_latency_ms - 99.612548828125) < 0.001,
        `shipping-3 piecewise age was ${String(recomputed.source_latency_ms)}`,
      )
    }
  }
}
assert(correctedSamples > 0, 'six-report replay must exercise the corrected clock axis')
console.log(
  `field strict clock: 5 passed (${cases.length} preserved reports replayed; ` +
  `${correctedSamples} source-age samples corrected)`,
)
