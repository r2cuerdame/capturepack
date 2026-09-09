'use strict'

const DEFAULT_THRESHOLDS = Object.freeze({
  minimum_trials: 3,
  minimum_post_ready_process_samples: 3,
  cpu_mean_ratio: 0.90,
  gpu_total_mean_ratio: 1.10,
  gpu_video_encode_mean_ratio: 1.10,
  working_set_mean_ratio: 1.10,
  capture_to_saved_ratio: 1.10,
  replay_export_ratio: 1.10,
  latency_jitter_ms: 250,
})

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function percentile(values, fraction) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const position = Math.max(0, Math.min(sorted.length - 1, (sorted.length - 1) * fraction))
  const lower = sorted[Math.floor(position)]
  const upper = sorted[Math.ceil(position)]
  return lower + (upper - lower) * (position - Math.floor(position))
}

function distribution(values) {
  const usable = values.flatMap((value) => finite(value) === null ? [] : [value])
  return usable.length === 0
    ? { count: 0, raw: [], min: null, p50: null, p95: null, max: null, mean: null }
    : {
        count: usable.length,
        raw: usable,
        min: Math.min(...usable),
        p50: percentile(usable, 0.5),
        p95: percentile(usable, 0.95),
        max: Math.max(...usable),
        mean: usable.reduce((sum, value) => sum + value, 0) / usable.length,
      }
}

function normalizedLayout(report) {
  const layout = report?.environment?.layout
  return {
    primary_display_id: layout?.primary_display_id ?? null,
    movement_start_display_id: layout?.movement_start_display_id ?? null,
    movement_display_order_ids: layout?.movement_display_order_ids ?? null,
    displays: Array.isArray(layout?.displays)
      ? layout.displays.map((display) => ({
          index: display.index,
          id: display.id,
          label: display.label,
          bounds_dip: display.bounds_dip,
          physical_bounds: display.physical_bounds,
          scale_factor: display.scale_factor,
          rotation: display.rotation,
          internal: display.internal,
        }))
      : null,
  }
}

function workloadIdentity(report) {
  return {
    source_commit: report?.environment?.build?.source_commit ?? null,
    app_main_sha256: report?.environment?.build?.app_main_sha256 ?? null,
    dxgi_helper_sha256: report?.environment?.build?.dxgi_helper_sha256 ?? null,
    fps: report?.case?.fps ?? null,
    duration_seconds: report?.case?.duration_seconds ?? null,
    warmup_ms: report?.case?.measurement_window?.launch_allowance_ms ?? null,
    target_requested: report?.case?.target_requested ?? null,
    target_resolved: report?.case?.target_resolved ?? null,
    replay_max_width: report?.case?.replay_max_width ?? null,
    workload: report?.case?.workload ?? null,
    layout: normalizedLayout(report),
    replay_outputs: Array.isArray(report?.media)
      ? report.media.map((media) => ({
          display: media.display ?? null,
          fixture_display_id: media.fixture_display_id ?? null,
          size: media.size ?? null,
          requested_fps: media.requested_fps ?? null,
        }))
      : null,
  }
}

function exact(value) {
  return JSON.stringify(value)
}

function rawMetric(reports, name) {
  if (name === 'cpu_total_capacity_percent') {
    return reports.flatMap((report) =>
      report?.process_metrics?.raw?.cpu_intervals?.flatMap((sample) =>
        finite(sample?.total_capacity_percent) === null ? [] : [sample.total_capacity_percent]) ?? [])
  }
  if (name === 'working_set_bytes') {
    return reports.flatMap((report) => report?.process_metrics?.raw?.working_set_bytes ?? [])
  }
  if (name === 'gpu_total_engine_percent') {
    return reports.flatMap((report) =>
      report?.process_metrics?.raw?.gpu_samples?.flatMap((sample) =>
        finite(sample?.total_engine_percent) === null ? [] : [sample.total_engine_percent]) ?? [])
  }
  if (name === 'gpu_video_encode_percent') {
    return reports.flatMap((report) =>
      report?.process_metrics?.raw?.gpu_samples?.flatMap((sample) =>
        finite(sample?.video_encode_percent) === null ? [] : [sample.video_encode_percent]) ?? [])
  }
  if (name === 'capture_to_saved_ms') {
    return reports.flatMap((report) =>
      finite(report?.performance?.capture_to_saved_ms) === null
        ? []
        : [report.performance.capture_to_saved_ms])
  }
  if (name === 'replay_export_ms') {
    return reports.flatMap((report) =>
      finite(report?.performance?.replay_export_ms) === null
        ? []
        : [report.performance.replay_export_ms])
  }
  return []
}

function compareMetric(name, shippingReports, nativeReports, ratioLimit, absoluteJitter = 0) {
  const shipping = distribution(rawMetric(shippingReports, name))
  const native = distribution(rawMetric(nativeReports, name))
  const limit = shipping.mean === null ? null : shipping.mean * ratioLimit + absoluteJitter
  return {
    name,
    shipping,
    native,
    delta_mean: shipping.mean === null || native.mean === null ? null : native.mean - shipping.mean,
    delta_p95: shipping.p95 === null || native.p95 === null ? null : native.p95 - shipping.p95,
    ratio_mean:
      shipping.mean === null || native.mean === null || shipping.mean === 0
        ? null
        : native.mean / shipping.mean,
    ratio_p95:
      shipping.p95 === null || native.p95 === null || shipping.p95 === 0
        ? null
        : native.p95 / shipping.p95,
    ratio_limit: ratioLimit,
    absolute_jitter: absoluteJitter,
    allowed_native_mean: limit,
    pass: limit !== null && native.mean !== null && native.mean <= limit,
  }
}

function reportEvidenceFailures(report, expectedBackend, index, thresholds) {
  const label = `${expectedBackend} trial ${index + 1}`
  const failures = []
  if (report?.result !== 'OK') failures.push(`${label} field report was not OK`)
  if (report?.case?.replay_backend_requested !== expectedBackend) {
    failures.push(`${label} requested backend was not ${expectedBackend}`)
  }
  if (report?.performance?.observed_backend !== expectedBackend) {
    failures.push(`${label} observed backend was not ${expectedBackend}`)
  }
  if (report?.performance?.evidence_complete !== true) {
    failures.push(`${label} performance evidence was incomplete`)
  }
  if ((report?.process_metrics?.sample_count ?? 0) < thresholds.minimum_post_ready_process_samples) {
    failures.push(`${label} had too few post-ready process samples`)
  }
  if (report?.environment?.build?.source_dirty !== false) {
    failures.push(`${label} source tree was dirty or unknown`)
  }
  if (typeof report?.performance?.measurement_window?.raw_samples !== 'string') {
    failures.push(`${label} did not retain its raw sample artifact path`)
  }
  const media = Array.isArray(report?.media) ? report.media : []
  if (media.length === 0 || media.some((item) => item?.full_decode_ok !== true)) {
    failures.push(`${label} replay did not fully decode`)
  }
  if (expectedBackend === 'native-dxgi') {
    const backend = report?.performance?.backend_evidence
    if (
      backend?.native_ready_display_count !== backend?.expected_display_count
      || backend?.native_snapshot_display_count !== backend?.expected_display_count
    ) {
      failures.push(`${label} did not prove READY and SNAPSHOT for every display`)
    }
    if (media.some((item) => item?.production_fmp4_validation?.status !== 'valid')) {
      failures.push(`${label} replay did not pass the production fMP4 validator`)
    }
  }
  return failures
}

function compareDxgiReplayAb(input) {
  const shipping = Array.isArray(input?.shipping) ? input.shipping : []
  const native = Array.isArray(input?.native) ? input.native : []
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(input?.thresholds ?? {}) }
  const failures = []
  if (shipping.length < thresholds.minimum_trials || native.length < thresholds.minimum_trials) {
    failures.push(`requires at least ${thresholds.minimum_trials} trials per backend`)
  }
  if (shipping.length !== native.length) failures.push('shipping/native trial counts differ')
  shipping.forEach((report, index) => {
    failures.push(...reportEvidenceFailures(report, 'shipping', index, thresholds))
  })
  native.forEach((report, index) => {
    failures.push(...reportEvidenceFailures(report, 'native-dxgi', index, thresholds))
  })

  const all = [...shipping, ...native]
  const reference = all[0] === undefined ? null : exact(workloadIdentity(all[0]))
  if (reference === null || all.some((report) => exact(workloadIdentity(report)) !== reference)) {
    failures.push('source/build/display/resolution/FPS/retention/activity workload differed')
  }
  if (all.some((report) => report?.environment?.build?.dxgi_helper_sha256 == null)) {
    failures.push('DXGI helper build identity was missing')
  }

  const metrics = {
    cpu_total_capacity_percent: compareMetric(
      'cpu_total_capacity_percent', shipping, native, thresholds.cpu_mean_ratio,
    ),
    gpu_total_engine_percent: compareMetric(
      'gpu_total_engine_percent', shipping, native, thresholds.gpu_total_mean_ratio,
    ),
    gpu_video_encode_percent: compareMetric(
      'gpu_video_encode_percent', shipping, native, thresholds.gpu_video_encode_mean_ratio,
    ),
    working_set_bytes: compareMetric(
      'working_set_bytes', shipping, native, thresholds.working_set_mean_ratio,
    ),
    capture_to_saved_ms: compareMetric(
      'capture_to_saved_ms', shipping, native, thresholds.capture_to_saved_ratio,
      thresholds.latency_jitter_ms,
    ),
    replay_export_ms: compareMetric(
      'replay_export_ms', shipping, native, thresholds.replay_export_ratio,
      thresholds.latency_jitter_ms,
    ),
  }
  for (const metric of Object.values(metrics)) {
    if (!metric.pass) failures.push(`${metric.name} exceeded its release threshold or was missing`)
  }
  return {
    schema: 'capturepack.dxgi-replay-ab-report',
    version: 1,
    result: failures.length === 0 ? 'PASS' : 'FAIL',
    thresholds,
    trial_count: { shipping: shipping.length, native: native.length },
    workload_identity: all[0] === undefined ? null : workloadIdentity(all[0]),
    evidence: {
      shipping_reports: shipping.map((report) => report?.artifacts?.report ?? null),
      native_reports: native.map((report) => report?.artifacts?.report ?? null),
      raw_process_samples: all.map(
        (report) => report?.performance?.measurement_window?.raw_samples ?? null,
      ),
    },
    metrics,
    failures,
  }
}

module.exports = {
  DEFAULT_DXGI_REPLAY_AB_THRESHOLDS: DEFAULT_THRESHOLDS,
  compareDxgiReplayAb,
}
