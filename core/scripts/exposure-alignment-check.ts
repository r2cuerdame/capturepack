/**
 * The moving fixture for #89.
 *
 * Everything the product measures today compares two *timestamps*, and on this
 * fixture those timestamps agree to within half a context interval while the
 * overlay is a fifth of a second ahead of the picture. That is the whole bug in
 * one place: the disagreement does not live on the time axis, it lives in
 * position, and until something correlates position nothing can see it.
 *
 * So this check builds a landmark that moves at a known speed, exposes its
 * pixels a known amount late, and requires the measurement to name that number
 * — and to refuse when the evidence cannot support one.
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { measureEncodedPtsContextAlignment } from '../src/shared/temporalAlignment'
import {
  exposureCorrectedContextTimeMs,
  measureExposureLatency,
  residualAfterExposureCorrection,
  syntheticMovingLandmark,
  type ExposureAlignmentInput,
} from '../src/shared/exposureAlignment'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) passed += 1
  else failed += 1
  console.log(
    `  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`,
  )
}

function round(value: number | null, digits = 1): string {
  return value === null ? 'null' : value.toFixed(digits)
}

const FRAME_MS = 1000 / 60
/** A quick window drag: 2 px/ms is 2000 px/s. */
const DRAG_PX_PER_MS = 2
/** Ground truth. This repo's own decoded-pixel match measured 53-76 ms. */
const TRUE_LATENCY_MS = 60

// ---------------------------------------------------------------------------
// A. A ring sampled faster than the recorder recovers the latency exactly.
// ---------------------------------------------------------------------------

const fine = syntheticMovingLandmark({
  velocityXPxPerMs: DRAG_PX_PER_MS,
  exposureLatencyMs: TRUE_LATENCY_MS,
  contextIntervalMs: 4,
  frameIntervalMs: FRAME_MS,
  durationMs: 2000,
})
const fineReport = measureExposureLatency(fine)
console.log(
  `\nA. unlocked ring (4 ms) vs 60 fps replay, ${TRUE_LATENCY_MS} ms exposure injected`,
)
console.log(
  `   latency ${round(fineReport.latencyMs)} ms +/- ${round(fineReport.resolutionMs)}`
    + ` | residual ${round(fineReport.residualPx)} px = ${round(fineReport.residualMs)} ms`
    + ` | speed ${round(fineReport.speedPxPerMs, 2)} px/ms`
    + ` | ${fineReport.comparedFrameCount} frames`,
)
check(
  'a landmark moving at an observed speed names the injected exposure latency',
  fineReport.status === 'measured'
    && fineReport.latencyMs !== null
    && Math.abs(fineReport.latencyMs - TRUE_LATENCY_MS) <= (fineReport.resolutionMs ?? 0),
  `${round(fineReport.latencyMs)} +/- ${round(fineReport.resolutionMs)}`,
)
check(
  'the residual left at the estimate is sampling quantization, not drift',
  fineReport.residualMs !== null && fineReport.residualMs <= 2,
  `${round(fineReport.residualMs)} ms`,
)
check(
  'a 60 ms lead is more than one frame of correlation error and is reported as failing',
  !fineReport.withinOneFrame,
  `frame interval ${round(fineReport.frameIntervalMs)} ms`,
)

// ---------------------------------------------------------------------------
// B. The measurement the product already has cannot see any of it.
// ---------------------------------------------------------------------------

const timeOnly = measureEncodedPtsContextAlignment({
  encodedPtsMs: fine.decodedFrames.map((frame) => frame.ptsMs),
  replayClockOffsetMs: fine.replayClockOffsetMs,
  contextSampleTimesMs: fine.contextObservations.map((observation) => observation.tMs),
})
console.log(
  `\nB. same fixture through the existing clock comparison:`
    + ` max ${round(timeOnly.distribution?.maxMs ?? null)} ms,`
    + ` bias ${round(timeOnly.distribution?.signedBiasMs ?? null)} ms`,
)
check(
  'the existing clock comparison calls this fixture aligned to within half a sample',
  timeOnly.status === 'measured'
    && timeOnly.distribution !== null
    && timeOnly.distribution.maxMs <= 2,
  JSON.stringify(timeOnly.distribution),
)
check(
  'comparing timestamps is blind to the entire reported lead',
  timeOnly.distribution !== null
    && fineReport.latencyMs !== null
    && fineReport.latencyMs - timeOnly.distribution.maxMs >= 55,
  `pixels say ${round(fineReport.latencyMs)} ms, clocks say ${round(timeOnly.distribution?.maxMs ?? null)} ms`,
)

// ---------------------------------------------------------------------------
// C. A ring locked to the frame rate still names it, and says how coarsely.
// ---------------------------------------------------------------------------

const locked = syntheticMovingLandmark({
  velocityXPxPerMs: DRAG_PX_PER_MS,
  exposureLatencyMs: TRUE_LATENCY_MS,
  contextIntervalMs: FRAME_MS,
  frameIntervalMs: FRAME_MS,
  durationMs: 2000,
})
const lockedReport = measureExposureLatency(locked)
console.log(
  `\nC. ring locked to the frame rate: latency ${round(lockedReport.latencyMs)} ms`
    + ` +/- ${round(lockedReport.resolutionMs)}`,
)
check(
  'a ring locked to the frame rate still brackets the true latency',
  lockedReport.status === 'measured'
    && lockedReport.latencyMs !== null
    && lockedReport.resolutionMs !== null
    && Math.abs(lockedReport.latencyMs - TRUE_LATENCY_MS) <= lockedReport.resolutionMs,
  `${round(lockedReport.latencyMs)} +/- ${round(lockedReport.resolutionMs)}`,
)
check(
  'locked sampling admits it resolves far more coarsely than an unlocked ring',
  lockedReport.resolutionMs !== null
    && fineReport.resolutionMs !== null
    && lockedReport.resolutionMs >= fineReport.resolutionMs * 4,
  `locked +/- ${round(lockedReport.resolutionMs)} ms vs unlocked +/- ${round(fineReport.resolutionMs)} ms`,
)

// ---------------------------------------------------------------------------
// D. Two displays, two latencies. No global constant satisfies both.
// ---------------------------------------------------------------------------

const focused = syntheticMovingLandmark({
  velocityXPxPerMs: DRAG_PX_PER_MS,
  exposureLatencyMs: 60,
  contextIntervalMs: 4,
  frameIntervalMs: FRAME_MS,
  durationMs: 2000,
  replayClockOffsetMs: 0,
})
const secondary = syntheticMovingLandmark({
  velocityXPxPerMs: DRAG_PX_PER_MS,
  exposureLatencyMs: 95,
  contextIntervalMs: 4,
  frameIntervalMs: FRAME_MS,
  durationMs: 2000,
  replayClockOffsetMs: -37,
})
const focusedReport = measureExposureLatency(focused)
const secondaryReport = measureExposureLatency(secondary)
const globalConstantMs = 77.5
const focusedUnderConstant = residualAfterExposureCorrection(focused, globalConstantMs)
const secondaryUnderConstant = residualAfterExposureCorrection(secondary, globalConstantMs)
console.log(
  `\nD. display 1 ${round(focusedReport.latencyMs)} ms, display 2 ${round(secondaryReport.latencyMs)} ms;`
    + ` one constant ${globalConstantMs} ms leaves ${round(focusedUnderConstant.residualMs)}`
    + ` / ${round(secondaryUnderConstant.residualMs)} ms`,
)
check(
  'each display keeps its own measured exposure latency',
  focusedReport.latencyMs !== null
    && secondaryReport.latencyMs !== null
    && Math.abs(focusedReport.latencyMs - 60) <= (focusedReport.resolutionMs ?? 0)
    && Math.abs(secondaryReport.latencyMs - 95) <= (secondaryReport.resolutionMs ?? 0),
  `${round(focusedReport.latencyMs)} / ${round(secondaryReport.latencyMs)}`,
)
check(
  'one hard-coded global offset fails on both displays at once',
  focusedUnderConstant.residualMs !== null
    && secondaryUnderConstant.residualMs !== null
    && focusedUnderConstant.residualMs > FRAME_MS
    && secondaryUnderConstant.residualMs > FRAME_MS,
  `${round(focusedUnderConstant.residualMs)} / ${round(secondaryUnderConstant.residualMs)} ms`,
)
check(
  'exposure is measured independently of replay_clock_offset_ms',
  focusedReport.latencyMs !== null
    && measureExposureLatency({
      ...focused,
      decodedFrames: focused.decodedFrames.map((frame) => ({
        ...frame,
        ptsMs: frame.ptsMs - 37,
      })),
      replayClockOffsetMs: -37,
    }).latencyMs === focusedReport.latencyMs,
)

// ---------------------------------------------------------------------------
// E. Applied once it disappears; applied twice or backwards it is worse.
// ---------------------------------------------------------------------------

const once = residualAfterExposureCorrection(fine, TRUE_LATENCY_MS)
const twice = residualAfterExposureCorrection(fine, TRUE_LATENCY_MS * 2)
const backwards = residualAfterExposureCorrection(fine, -TRUE_LATENCY_MS)
const uncorrected = residualAfterExposureCorrection(fine, 0)
console.log(
  `\nE. correction applied 0x ${round(uncorrected.residualMs)} ms,`
    + ` 1x ${round(once.residualMs)} ms,`
    + ` 2x ${round(twice.residualMs)} ms,`
    + ` reversed ${round(backwards.residualMs)} ms`,
)
check(
  'applying the measured latency once collapses the disagreement to sampling noise',
  once.residualMs !== null && once.residualMs <= 2,
  `${round(once.residualMs)} ms`,
)
check(
  'applying it in two places is as wrong as not applying it at all',
  twice.residualMs !== null
    && uncorrected.residualMs !== null
    && Math.abs(twice.residualMs - uncorrected.residualMs) <= 2,
  `${round(twice.residualMs)} vs ${round(uncorrected.residualMs)} ms`,
)
check(
  'applying it with the wrong sign doubles the error instead of hiding it',
  backwards.residualMs !== null
    && uncorrected.residualMs !== null
    && backwards.residualMs >= uncorrected.residualMs * 1.9,
  `${round(backwards.residualMs)} ms`,
)

// ---------------------------------------------------------------------------
// F. Stationary and near-stationary evidence refuses to produce a number.
// ---------------------------------------------------------------------------

const stationary = syntheticMovingLandmark({
  velocityXPxPerMs: 0,
  exposureLatencyMs: TRUE_LATENCY_MS,
  contextIntervalMs: 4,
  frameIntervalMs: FRAME_MS,
  durationMs: 2000,
})
const creeping = syntheticMovingLandmark({
  velocityXPxPerMs: 0.005,
  exposureLatencyMs: TRUE_LATENCY_MS,
  contextIntervalMs: 4,
  frameIntervalMs: FRAME_MS,
  durationMs: 2000,
})
// A landmark that moves cleanly but barely travels: every step is a real pixel
// of motion, so the speed guard is satisfied and only the travel threshold can
// refuse. Without this case that threshold is unreachable and untested.
const nudged = syntheticMovingLandmark({
  velocityXPxPerMs: 0.2,
  exposureLatencyMs: TRUE_LATENCY_MS,
  contextIntervalMs: 4,
  frameIntervalMs: 8,
  durationMs: 100,
})
const stationaryReport = measureExposureLatency(stationary)
const creepingReport = measureExposureLatency(creeping)
const nudgedReport = measureExposureLatency(nudged)
console.log(
  `\nF. stationary -> ${stationaryReport.reason}, creeping -> ${creepingReport.reason},`
    + ` nudged -> ${nudgedReport.reason}`,
)
check(
  'a stationary capture cannot claim sync and says why',
  stationaryReport.status === 'unavailable'
    && stationaryReport.reason === 'insufficient-motion'
    && stationaryReport.latencyMs === null,
)
check(
  'a landmark whose travel is below the pixel evidence threshold also refuses',
  creepingReport.status === 'unavailable'
    && creepingReport.reason === 'insufficient-motion',
  `travelled about ${(0.005 * 2000).toFixed(0)} px`,
)
check(
  'clean but short travel refuses on distance while the speed guard is satisfied',
  nudgedReport.status === 'unavailable'
    && nudgedReport.reason === 'insufficient-motion'
    && nudgedReport.speedPxPerMs !== null
    && nudgedReport.speedPxPerMs > 0,
  `speed ${round(nudgedReport.speedPxPerMs, 2)} px/ms over about 20 px`,
)
check(
  'too few samples is a refusal, not an extrapolation',
  measureExposureLatency({
    contextObservations: fine.contextObservations.slice(0, 4),
    decodedFrames: fine.decodedFrames.slice(0, 4),
    replayClockOffsetMs: 0,
  }).reason === 'insufficient-samples',
)
check(
  'a replay whose declared PTS regresses is not measurable',
  measureExposureLatency({
    ...fine,
    decodedFrames: [...fine.decodedFrames].reverse(),
  }).reason === 'non-monotonic-presentation-clock',
)

// ---------------------------------------------------------------------------
// G. Real sampling jitter does not move the answer out of resolution.
// ---------------------------------------------------------------------------

const jittered = syntheticMovingLandmark({
  velocityXPxPerMs: DRAG_PX_PER_MS,
  exposureLatencyMs: TRUE_LATENCY_MS,
  contextIntervalMs: 4,
  frameIntervalMs: FRAME_MS,
  durationMs: 2000,
  contextJitterMs: 6,
  seed: 20260731,
})
const jitteredReport = measureExposureLatency(jittered)
console.log(
  `\nG. +/-6 ms context jitter: latency ${round(jitteredReport.latencyMs)} ms`
    + ` +/- ${round(jitteredReport.resolutionMs)} | residual ${round(jitteredReport.residualMs)} ms`,
)
check(
  'jittered context sampling still lands within one frame of the truth',
  jitteredReport.status === 'measured'
    && jitteredReport.latencyMs !== null
    && Math.abs(jitteredReport.latencyMs - TRUE_LATENCY_MS) <= FRAME_MS,
  `${round(jitteredReport.latencyMs)} ms`,
)
check(
  'the fixture is deterministic: the same seed measures the same latency',
  measureExposureLatency(
    syntheticMovingLandmark({
      velocityXPxPerMs: DRAG_PX_PER_MS,
      exposureLatencyMs: TRUE_LATENCY_MS,
      contextIntervalMs: 4,
      frameIntervalMs: FRAME_MS,
      durationMs: 2000,
      contextJitterMs: 6,
      seed: 20260731,
    }),
  ).latencyMs === jitteredReport.latencyMs,
)

// ---------------------------------------------------------------------------
// H. The rules that make a wrong fix impossible to land quietly.
// ---------------------------------------------------------------------------

const moduleSource = readFileSync('src/shared/exposureAlignment.ts', 'utf8')
check(
  'the exposure measurement has no fixed, configured or FPS-derived correction',
  !/FIXED_|latencyAllowanceMs|correctionMs|1000\s*\/\s*fps/i.test(moduleSource)
    && moduleSource.includes('nearestObservedSample'),
)
// Naming the SPEC quantity in a doc comment is how the two are kept apart;
// reading or writing it in code is how they get conflated.
const moduleCode = moduleSource
  .replace(/\/\*[\s\S]*?\*\//gu, '')
  .replace(/^\s*\/\/.*$/gmu, '')
check(
  'exposure never rides on replay_clock_offset_ms',
  !/replay_clock_offset_ms/.test(moduleCode)
    && moduleCode.includes('replayClockOffsetMs'),
  'the SPEC field is documented, never consumed as the exposure term',
)
const alignmentSource = readFileSync('src/shared/temporalAlignment.ts', 'utf8')
check(
  'the clock comparison stays a clock comparison and grows no exposure term',
  !/exposure/i.test(alignmentSource),
)

// There must be exactly one subtraction site, forever. Two is a double
// correction that looks like a smaller bug instead of a bigger one.
const applicationSites = applicationSiteCount()
console.log(`\nH. exposure correction is applied at ${applicationSites} place(s) in src/`)
check(
  'the exposure correction has at most one application site in the product',
  applicationSites <= 1,
  `${applicationSites} site(s)`,
)
check(
  'the conversion is exported as one function rather than an inline subtraction',
  typeof exposureCorrectedContextTimeMs === 'function'
    && exposureCorrectedContextTimeMs(1000, 60) === 940,
)

function applicationSiteCount(): number {
  const roots = [
    'src/main',
    'src/renderer',
    'src/shared',
  ]
  let count = 0
  for (const root of roots) {
    for (const file of walk(root)) {
      if (file.endsWith('exposureAlignment.ts')) continue
      const text = readFileSync(file, 'utf8')
      count += text.split('exposureCorrectedContextTimeMs(').length - 1
    }
  }
  return count
}

function walk(directory: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

// ---------------------------------------------------------------------------
// I. What the field harness has to produce, stated as a shape.
// ---------------------------------------------------------------------------

const fieldShape: ExposureAlignmentInput = {
  contextObservations: [],
  decodedFrames: [],
  replayClockOffsetMs: 0,
}
check(
  'the field harness feeds the same input shape as the fixture',
  Object.keys(fieldShape).every((key) => key in fine),
)

console.log(
  `\nresult: ${failed === 0 ? 'OK' : 'FAILED'} — ${passed} passed, ${failed} failed`,
)
if (failed > 0) process.exitCode = 1
