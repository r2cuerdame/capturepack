import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const {
  compareDxgiReplayAb,
  canContinueDxgiReplayAbTrial,
} = require('./fixtures/dxgi-replay-ab.cjs')

let passed = 0
function check(name, test) {
  assert.equal(test, true, name)
  passed += 1
  console.log(`PASS: ${name}`)
}

function report(backend, factor = 1, trial = 1) {
  const native = backend === 'native-dxgi'
  const raw = {
    cpu_intervals: [8, 10, 12].map((value, index) => ({
      total_capacity_percent: value * factor,
      from_wall_time_ms: index * 1000,
      to_wall_time_ms: (index + 1) * 1000,
    })),
    working_set_bytes: [100, 102, 104].map((value) => value * factor * 1024 * 1024),
    gpu_samples: [4, 5, 6].map((value) => ({
      total_engine_percent: value * factor,
      video_encode_percent: value * factor * 0.5,
    })),
  }
  return {
    result: 'OK',
    case: {
      replay_backend_requested: backend,
      fps: 15,
      duration_seconds: 30,
      measurement_window: { launch_allowance_ms: 3000 },
      target_requested: 'primary',
      target_resolved: '1',
      replay_max_width: 1920,
      workload: {
        fixture: 'windows-replay-field-surface',
        fixture_schema_version: 1,
        movement_cycle_ms: 9000,
      },
    },
    environment: {
      build: {
        source_commit: 'd8cf670fbc0d4d5c700c9ffa35096a8a7c74fedc',
        source_dirty: false,
        app_main_sha256: 'app-sha',
        dxgi_helper_sha256: 'helper-sha',
      },
      layout: {
        primary_display_id: '1',
        movement_start_display_id: '1',
        movement_display_order_ids: ['1'],
        displays: [{
          index: 1,
          id: '1',
          label: 'display',
          bounds_dip: { x: 0, y: 0, width: 1920, height: 1080 },
          physical_bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          scale_factor: 1,
          rotation: 0,
          internal: false,
        }],
      },
    },
    artifacts: { report: `${backend}-${trial}/report.json` },
    process_metrics: { sample_count: 3, raw },
    performance: {
      observed_backend: backend,
      evidence_complete: true,
      capture_to_saved_ms: 1000 * factor,
      replay_export_ms: 500 * factor,
      measurement_window: { raw_samples: `${backend}-${trial}/process-samples.jsonl` },
      backend_evidence: {
        expected_display_count: 1,
        native_ready_display_count: native ? 1 : 0,
        native_snapshot_display_count: native ? 1 : 0,
      },
    },
    media: [{
      display: 1,
      fixture_display_id: '1',
      size: { width: 1920, height: 1080 },
      requested_fps: 15,
      full_decode_ok: true,
      production_fmp4_validation: { status: native ? 'valid' : 'not-required' },
    }],
  }
}

const shipping = [1, 2, 3].map((trial) => report('shipping', 1, trial))
const native = [1, 2, 3].map((trial) => report('native-dxgi', 0.85, trial))
const pass = compareDxgiReplayAb({ shipping, native })
const broken = structuredClone(shipping)
broken[0].result = 'BROKEN'
broken[0].checks = { every_spawned_process_terminated: true }
check('a cleaned failed trial permits remaining evidence but can never pass release',
  canContinueDxgiReplayAbTrial({ status: 1, signal: null }, broken[0])
    && compareDxgiReplayAb({ shipping: broken, native }).result === 'FAIL')
check('missing cleanup and timed-out children stop subsequent trials',
  !canContinueDxgiReplayAbTrial({ status: 1, signal: null }, {})
    && !canContinueDxgiReplayAbTrial({ status: null, signal: 'SIGTERM' }, broken[0]))
check('complete same-workload READY/SNAPSHOT/fMP4/decode evidence passes', pass.result === 'PASS')
check('report preserves every raw sample and aggregate mean/p95/delta',
  pass.metrics.cpu_total_capacity_percent.shipping.raw.length === 9
    && pass.metrics.cpu_total_capacity_percent.shipping.p95 !== null
    && pass.metrics.cpu_total_capacity_percent.delta_mean < 0
    && pass.metrics.capture_to_saved_ms.shipping.raw.length === 3)
check('CPU materially-lower threshold is the primary 90 percent gate',
  pass.metrics.cpu_total_capacity_percent.ratio_limit === 0.9
    && pass.metrics.cpu_total_capacity_percent.ratio_mean === 0.85)
check('GPU and working-set thresholds are 110 percent guardrails',
  pass.metrics.gpu_total_engine_percent.ratio_limit === 1.1
    && pass.metrics.gpu_video_encode_percent.ratio_limit === 1.1
    && pass.metrics.working_set_bytes.ratio_limit === 1.1)
check('latency thresholds include the bounded absolute jitter allowance',
  pass.metrics.capture_to_saved_ms.absolute_jitter === 250
    && pass.metrics.replay_export_ms.absolute_jitter === 250)

const wrongBackend = structuredClone(native)
wrongBackend[0].performance.observed_backend = 'shipping'
check('wrong observed backend fails closed',
  compareDxgiReplayAb({ shipping, native: wrongBackend }).failures
    .some((failure) => failure.includes('observed backend')))

const missingSnapshot = structuredClone(native)
missingSnapshot[0].performance.backend_evidence.native_snapshot_display_count = 0
check('missing native snapshot evidence fails closed',
  compareDxgiReplayAb({ shipping, native: missingSnapshot }).failures
    .some((failure) => failure.includes('READY and SNAPSHOT')))

const invalidFmp4 = structuredClone(native)
invalidFmp4[0].media[0].production_fmp4_validation.status = 'invalid'
check('missing production fMP4 validation fails closed',
  compareDxgiReplayAb({ shipping, native: invalidFmp4 }).failures
    .some((failure) => failure.includes('production fMP4 validator')))

const highCpu = [1, 2, 3].map((trial) => report('native-dxgi', 0.95, trial))
check('CPU mean above 90 percent of shipping fails',
  compareDxgiReplayAb({ shipping, native: highCpu }).metrics
    .cpu_total_capacity_percent.pass === false)

const gpuRegression = structuredClone(native)
for (const run of gpuRegression) {
  for (const sample of run.process_metrics.raw.gpu_samples) {
    sample.total_engine_percent *= 2
  }
}
check('GPU regression above the 110 percent guardrail fails',
  compareDxgiReplayAb({ shipping, native: gpuRegression }).metrics
    .gpu_total_engine_percent.pass === false)

const differentWorkload = structuredClone(native)
differentWorkload[1].case.fps = 30
check('display/resolution/FPS/retention/activity mismatch fails',
  compareDxgiReplayAb({ shipping, native: differentWorkload }).failures
    .some((failure) => failure.includes('workload differed')))

check('fewer than three trials is not release evidence',
  compareDxgiReplayAb({ shipping: shipping.slice(0, 2), native: native.slice(0, 2) }).failures
    .some((failure) => failure.includes('at least 3 trials')))

const fieldSource = readFileSync(new URL('./windows-replay-field-check.mjs', import.meta.url), 'utf8')
check('field runner launches only the explicit native switch and samples Windows GPU engines',
  fieldSource.includes("...(replayBackend === 'native-dxgi' ? ['--dxgi-native-replay'] : [])")
    && fieldSource.includes("Get-Counter -Counter '\\\\GPU Engine(*)\\\\Utilization Percentage'")
    && fieldSource.includes('gpu_engines=@($gpuByPid[[int]$node.ProcessId])'))
check('field runner records production fMP4 validation and post-ready evidence',
  fieldSource.includes('productionHelper.validateNativeReplayMp4(')
    && fieldSource.includes('latest production DXGI native READY through capture request')
    && fieldSource.includes('native_fmp4_production_validator_and_full_decode'))

console.log(`dxgi replay A/B checks: ${passed} passed`)
