'use strict'

const READINESS =
  /\[capture\] display ([^:]+): primary recorder readiness after ([0-9.]+) ms \(([0-9]+) presented frames, timeout=(true|false), excluded-before-recorder=([0-9.]+) ms(?:,[^)]*)?\)/u

function timestampOf(line) {
  const raw = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\s/u.exec(line)?.[1]
  if (raw === undefined) return { iso: null, ms: null }
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? { iso: raw, ms } : { iso: null, ms: null }
}

/**
 * Recorder availability from the two production events that actually bound it:
 * readiness completed, then the capture was requested.
 *
 * Launch delay and `observed_wait_ms` are deliberately not subtracted from one
 * another. App/bootstrap and stream-acquisition time live outside that pair,
 * which is why a nominal 3 s launch allowance can still leave a 12 s ring with
 * only 11.1 s of footage.
 */
function parseRecorderAvailability(log) {
  const readiness = []
  let captureRequestedAt = { iso: null, ms: null }
  for (const line of String(log).split(/\r?\n/u)) {
    if (/\[capture\] capture requested\s*$/u.test(line)) {
      captureRequestedAt = timestampOf(line)
      continue
    }
    const match = READINESS.exec(line)
    if (match === null) continue
    const readyAt = timestampOf(line)
    readiness.push({
      display_id: match[1],
      observed_wait_ms: Number(match[2]),
      presented_frames: Number(match[3]),
      timed_out: match[4] === 'true',
      excluded_before_recorder_ms: Number(match[5]),
      ready_at: readyAt.iso,
      ready_at_ms: readyAt.ms,
    })
  }
  const latestByDisplay = new Map()
  for (const row of readiness) {
    if (
      captureRequestedAt.ms !== null
      && row.ready_at_ms !== null
      && row.ready_at_ms > captureRequestedAt.ms
    ) {
      continue
    }
    latestByDisplay.set(row.display_id, row)
  }
  return {
    capture_requested_at: captureRequestedAt.iso,
    capture_requested_at_ms: captureRequestedAt.ms,
    displays: [...latestByDisplay.values()].map((row) => ({
      ...row,
      available_span_ms:
        captureRequestedAt.ms === null || row.ready_at_ms === null
          ? null
          : Math.max(0, captureRequestedAt.ms - row.ready_at_ms),
    })),
  }
}

function nonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null
}

/**
 * Duration contract for one persisted replay.
 *
 * A filled/unknown buffer keeps the pre-existing full-retention threshold
 * unchanged. Only timestamp-proven `unfilled` uses its shorter measured
 * available span, and it still has to preserve that span within the same
 * bounded mux/frame tolerance.
 */
function durationVerdict({
  requestedRetentionMs,
  measuredAvailableSpanMs,
  actualDurationMs,
  nominalFrameIntervalMs,
  fillToleranceMs,
}) {
  const requested = nonNegative(requestedRetentionMs) ?? 0
  const available = nonNegative(measuredAvailableSpanMs)
  const actual = nonNegative(actualDurationMs)
  const nominal = nonNegative(nominalFrameIntervalMs) ?? 0
  const tolerance = nonNegative(fillToleranceMs) ?? 0
  const expected = Math.min(requested, available ?? requested)
  const bufferState =
    available === null
      ? 'unknown'
      : available < requested
        ? 'unfilled'
        : 'filled'
  const withinRequested =
    actual !== null && actual <= requested + nominal
  // This is the old filled-buffer threshold. Do not weaken it.
  const fillsRequested =
    actual !== null && actual >= requested - tolerance
  const matchesExpected =
    actual !== null
    && actual >= expected - tolerance
    && actual <= expected + nominal
  return {
    buffer_state: bufferState,
    requested_retention_ms: requested,
    measured_available_span_ms: available,
    expected_duration_ms: expected,
    actual_duration_ms: actual,
    duration_within_requested_window: withinRequested,
    fills_requested_window: fillsRequested,
    matches_expected_duration: matchesExpected,
    fill_tolerance_ms: tolerance,
    pass:
      withinRequested
      && (bufferState === 'unfilled' ? matchesExpected : fillsRequested),
    basis:
      bufferState === 'unknown'
        ? 'readiness/capture timestamps unavailable; full-retention threshold retained'
        : 'min(requested retention, timestamped recorder-ready to capture-request span)',
  }
}

module.exports = {
  durationVerdict,
  parseRecorderAvailability,
}
