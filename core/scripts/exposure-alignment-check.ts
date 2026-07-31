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
  fitOffsetByPixelScore,
  shiftObservationsToPicture,
  rectangleEdgeScore,
  isApplicableExposureLatency,
  MAXIMUM_APPLICABLE_LATENCY_MS,
  type ExposureAlignmentInput,
  type FrameScoreRow,
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
// H. The shape real evidence actually has.
//
// Both of these came from running the measurement against
// C:\CapturePack\CapturePack_2026-07-30_230217 rather than from reasoning, and
// neither could have been found from a fixture that moves for its whole
// duration and keeps every frame.
// ---------------------------------------------------------------------------

// A ring files on its own cadence for the whole capture; the window is dragged
// for a fraction of a second in the middle. Most consecutive observations are
// therefore identical, and a median speed over ALL steps is 0.
const RING_INTERVAL_MS = 28
const REPLAY_INTERVAL_MS = 67
const briefDrag = syntheticMovingLandmark({
  velocityXPxPerMs: DRAG_PX_PER_MS,
  exposureLatencyMs: TRUE_LATENCY_MS,
  contextIntervalMs: RING_INTERVAL_MS,
  frameIntervalMs: REPLAY_INTERVAL_MS,
  durationMs: 3000,
  motionWindowMs: { startMs: 1000, endMs: 1300 },
})
const heldSteps = briefDrag.contextObservations.filter((observation, index, all) => {
  const previous = all[index - 1]
  return previous !== undefined && previous.x === observation.x && previous.y === observation.y
}).length
const briefReport = measureExposureLatency(briefDrag)
console.log(
  `\nH. ring at ${RING_INTERVAL_MS} ms, 300 ms of drag:`
    + ` ${heldSteps}/${briefDrag.contextObservations.length} steps held,`
    + ` latency ${round(briefReport.latencyMs)} ms +/- ${round(briefReport.resolutionMs)}`
    + ` at ${round(briefReport.speedPxPerMs, 2)} px/ms`,
)
check(
  'held ring samples outnumber moving ones, as they do on a real capture',
  heldSteps > briefDrag.contextObservations.length / 2,
  `${heldSteps} of ${briefDrag.contextObservations.length}`,
)
check(
  'a brief drag inside a mostly still capture is still measurable',
  briefReport.status === 'measured'
    && briefReport.latencyMs !== null
    && briefReport.resolutionMs !== null
    && Math.abs(briefReport.latencyMs - TRUE_LATENCY_MS) <= briefReport.resolutionMs,
  `${round(briefReport.latencyMs)} +/- ${round(briefReport.resolutionMs)}`,
)
check(
  'reported speed describes the drag, not the average of a mostly still window',
  briefReport.speedPxPerMs !== null
    && Math.abs(briefReport.speedPxPerMs - DRAG_PX_PER_MS) <= 0.2,
  `${round(briefReport.speedPxPerMs, 2)} px/ms`,
)

// On real evidence noise makes exactly one grid point win by a hair, so the
// argmin plateau collapses to a single step and half a step is all the plateau
// can say. Reporting that as the resolution claims a precision the sampling
// never had — the harness published 127.0 +/- 0.5 while its own two segments
// disagreed by 9 ms. Nearest-observation inversion cannot beat half the
// interval those observations arrive at, and the report must say so.
const resolutionFloors = [4, FRAME_MS, RING_INTERVAL_MS].map((intervalMs) => {
  const report = measureExposureLatency(
    syntheticMovingLandmark({
      velocityXPxPerMs: DRAG_PX_PER_MS,
      exposureLatencyMs: TRUE_LATENCY_MS,
      contextIntervalMs: intervalMs,
      frameIntervalMs: REPLAY_INTERVAL_MS,
      durationMs: 3000,
    }),
  )
  return { intervalMs, resolutionMs: report.resolutionMs }
})
console.log(
  `   resolution never beats half the ring interval: `
    + resolutionFloors.map(
      (r) => `${round(r.intervalMs)} ms ring -> +/- ${round(r.resolutionMs)}`,
    ).join(', '),
)
check(
  'resolution never claims to beat half the interval the observations arrive at',
  resolutionFloors.every(
    (r) => r.resolutionMs !== null && r.resolutionMs >= r.intervalMs / 2 - 1e-9,
  ),
  resolutionFloors.map((r) => `${round(r.resolutionMs)}`).join(' / '),
)
check(
  'a coarser ring is reported as a coarser answer, monotonically',
  (resolutionFloors[0]?.resolutionMs ?? 0) < (resolutionFloors[1]?.resolutionMs ?? 0)
    && (resolutionFloors[1]?.resolutionMs ?? 0) < (resolutionFloors[2]?.resolutionMs ?? 0),
)

// A harness that discards frames it could not identify hands over a subset. If
// the frame interval is derived from that subset it grows, and the one-frame
// acceptance boundary is then measured against a rate the recorder never ran at.
const everyThird = {
  ...fine,
  decodedFrames: fine.decodedFrames.filter((_frame, index) => index % 3 === 0),
}
const derivedFromSubset = measureExposureLatency(everyThird)
const toldTheTruth = measureExposureLatency({ ...everyThird, frameIntervalMs: FRAME_MS })
console.log(
  `   filtered subset: derived interval ${round(derivedFromSubset.frameIntervalMs)} ms`
    + ` vs declared ${round(toldTheTruth.frameIntervalMs)} ms`,
)
check(
  'dropping unidentifiable frames inflates the interval derived from what is left',
  derivedFromSubset.frameIntervalMs !== null
    && derivedFromSubset.frameIntervalMs >= FRAME_MS * 2.5,
  `${round(derivedFromSubset.frameIntervalMs)} ms from a subset of a ${round(FRAME_MS)} ms replay`,
)
check(
  'the declared replay interval overrides the one derived from a subset',
  toldTheTruth.frameIntervalMs === FRAME_MS
    && toldTheTruth.latencyMs === derivedFromSubset.latencyMs,
)

// ---------------------------------------------------------------------------
// I. The rules that make a wrong fix impossible to land quietly.
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
console.log(`\nI. exposure correction is applied at ${applicationSites} place(s) in src/`)
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
// J. What the field harness has to produce, stated as a shape.
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

// L. A SLOW DRAG IS STILL EVIDENCE (#89).
//
// The identification path asks each frame WHICH rectangle it shows, then fits
// an offset to the answers. That needs consecutive observations to be tellable
// apart, and a deliberate, slow drag moves a window a few pixels between them —
// so nothing clears the confidence margin and the whole segment refuses. Three
// field packs in a row refused that way while the owner was dragging slowly on
// purpose, to look at the very thing being measured.
//
// The second estimator never identifies anything: it sweeps the offset and
// totals the pixel score of every frame against the rectangle the context says
// was there. One frame's row is nearly flat on a slow drag; a hundred summed is
// not, because only the true offset lines all of them up at once.
//
// It lives in `shared/` because the app must reach the same answer as the
// offline harness on the same capture — the harness has ffmpeg and the app has
// a canvas, but the fit itself may not be two implementations.
console.log('\nL. the pixel-score fit, which never identifies a frame')

/**
 * Score rows for a landmark moving at a known speed, exposed a known amount
 * late. Score falls off with the DISTANCE between where the candidate says the
 * window was and where the frame actually shows it, which is what an edge
 * scorer measures — so a slow drag makes every row flatter without moving the
 * peak, exactly as it does in the field.
 */
function syntheticRows(options: {
  latencyMs: number
  pxPerMs: number
  frames: number
  frameIntervalMs: number
  contextIntervalMs: number
  candidateWindowMs: number
}): FrameScoreRow[] {
  const rows: FrameScoreRow[] = []
  const falloffPx = 40
  for (let index = 0; index < options.frames; index += 1) {
    const ptsMs = index * options.frameIntervalMs
    // What this frame actually shows: the desktop as it was `latencyMs` ago.
    const shownAtMs = ptsMs - options.latencyMs
    const scores: Array<{ tMs: number; score: number }> = []
    const first = Math.ceil((ptsMs - options.candidateWindowMs) / options.contextIntervalMs)
    const last = Math.floor((ptsMs + options.candidateWindowMs) / options.contextIntervalMs)
    for (let step = first; step <= last; step += 1) {
      const tMs = step * options.contextIntervalMs
      const offBy = Math.abs(tMs - shownAtMs) * options.pxPerMs
      scores.push({ tMs, score: Math.max(0, 1 - offBy / falloffPx) })
    }
    rows.push({ ptsMs, scores })
  }
  return rows
}

const SWEEP = { minMs: -400, maxMs: 400 }

{
  // A brisk drag: 2 px/ms. Each row already has a clear peak.
  const fast = fitOffsetByPixelScore(
    syntheticRows({
      latencyMs: 127,
      pxPerMs: 2,
      frames: 120,
      frameIntervalMs: 67,
      contextIntervalMs: 10,
      candidateWindowMs: 350,
    }),
    SWEEP,
    1,
    0,
    350,
  )
  check(
    'a brisk drag names the injected latency',
    fast !== null && Math.abs(fast.latencyMs - 127) <= fast.resolutionMs,
    fast === null ? 'null' : `${round(fast.latencyMs)} +/- ${round(fast.resolutionMs)}`,
  )
}
{
  // The case the identification path cannot do: 0.05 px/ms means consecutive
  // observations are half a pixel apart, so no single frame can tell them
  // apart. The total over 120 of them still can.
  const slow = fitOffsetByPixelScore(
    syntheticRows({
      latencyMs: 127,
      pxPerMs: 0.05,
      frames: 120,
      frameIntervalMs: 67,
      contextIntervalMs: 10,
      candidateWindowMs: 350,
    }),
    SWEEP,
    1,
    0,
    350,
  )
  check(
    'and so does a drag too slow for any single frame to resolve',
    slow !== null && Math.abs(slow.latencyMs - 127) <= slow.resolutionMs + 10,
    slow === null ? 'null' : `${round(slow.latencyMs)} +/- ${round(slow.resolutionMs)}`,
  )
}
{
  // The offset is subtracted, per SPEC 5.6 (`t_i = t + offset`): a display
  // whose replay clock runs 134 ms ahead of the pack must not report that as
  // 134 ms of extra exposure. Measured for real on
  // CapturePack_2026-08-01_011147, where assuming zero turned 108 ms into 242.
  const rows = syntheticRows({
    latencyMs: 127,
    pxPerMs: 2,
    frames: 120,
    frameIntervalMs: 67,
    contextIntervalMs: 10,
    candidateWindowMs: 350,
  })
  const shifted = rows.map((row) => ({ ...row, ptsMs: row.ptsMs + 134 }))
  const withOffset = fitOffsetByPixelScore(shifted, SWEEP, 1, 134, 350)
  const withoutOffset = fitOffsetByPixelScore(shifted, SWEEP, 1, 0, 350)
  check(
    'a display clock offset is removed, not reported as exposure',
    withOffset !== null && Math.abs(withOffset.latencyMs - 127) <= withOffset.resolutionMs,
    withOffset === null ? 'null' : `${round(withOffset.latencyMs)}`,
  )
  check(
    'and ignoring it puts the whole offset into the answer',
    withoutOffset !== null && Math.abs(withoutOffset.latencyMs - 261) <= 10,
    withoutOffset === null ? 'null' : `${round(withoutOffset.latencyMs)}`,
  )
}
{
  // The lesson that cost a wrong report: the first field run answered -59 ms
  // with a +/-1.5 ms resolution, one step from its own search boundary. A
  // confident answer pinned to the edge of a sweep is not a peak.
  // A SLOW drag, which is what the field case was: its scores fall off gently
  // enough that a too-narrow sweep still sees a gradient, climbs it, and stops
  // at its own edge with a tight resolution. A brisk drag would score zero
  // everywhere in range and correctly return nothing — it is the plausible
  // answer that is dangerous, not the absent one.
  const rows = syntheticRows({
    latencyMs: 127,
    pxPerMs: 0.05,
    frames: 120,
    frameIntervalMs: 67,
    contextIntervalMs: 10,
    candidateWindowMs: 350,
  })
  const narrow = fitOffsetByPixelScore(rows, { minMs: -60, maxMs: 60 }, 1, 0, 350)
  const wide = fitOffsetByPixelScore(rows, SWEEP, 1, 0, 350)
  check(
    'a sweep that cannot reach the answer returns its own boundary',
    narrow !== null && narrow.latencyMs >= 55 && narrow.latencyMs <= 60,
    narrow === null ? 'null' : `${round(narrow.latencyMs)} from a +/-60 ms sweep`,
  )
  check(
    'so the range must be wider than any answer it is allowed to give',
    wide !== null && Math.abs(wide.latencyMs - 127) <= wide.resolutionMs,
    wide === null ? 'null' : `${round(wide.latencyMs)} from a +/-400 ms sweep`,
  )
}
{
  const flat = fitOffsetByPixelScore(
    syntheticRows({
      latencyMs: 127,
      pxPerMs: 0,
      frames: 120,
      frameIntervalMs: 67,
      contextIntervalMs: 10,
      candidateWindowMs: 350,
    }),
    SWEEP,
    1,
    0,
    350,
  )
  check(
    'a window that never moved yields nothing rather than a number',
    flat === null,
    flat === null ? 'null' : `${round(flat.latencyMs)}`,
  )
}
{
  const thin = fitOffsetByPixelScore(
    syntheticRows({
      latencyMs: 127,
      pxPerMs: 2,
      frames: 4,
      frameIntervalMs: 67,
      contextIntervalMs: 10,
      candidateWindowMs: 350,
    }),
    SWEEP,
    1,
    0,
    350,
  )
  check(
    'and too few frames yield nothing, rather than a confident coincidence',
    thin === null,
    thin === null ? 'null' : `${round(thin.latencyMs)}`,
  )
}
{
  const field = readFileSync(
    path.join(process.cwd(), 'scripts', 'exposure-field-check.ts'),
    'utf8',
  )
  check(
    'the harness uses the shared estimator rather than its own copy',
    field.includes("fitOffsetByPixelScore,")
      && field.includes("from '../src/shared/exposureAlignment'")
      && !field.includes('function fitOffsetByPixelScore('),
  )
  check(
    'and measures on the clock the app uses, saying so when it is a fallback',
    field.includes('resolvedReplayClockOffsetMs(')
      && field.includes('which is itself an assumption'),
  )
}

// M. THE CORRECTION ITSELF, AND WHAT IT REFUSES TO DO (#89).
//
// The frame stamped t shows the desktop as it was at t - latency, so the
// rectangle the window really occupied at t is the one a viewer sees at
// t + latency. Moving every observation later by that constant is the whole
// correction. What matters as much is everything it does not do.
console.log('\nM. putting the observations on the picture\'s clock')
{
  const observed = [
    { t_ms: 0, x: 0, y: 10 },
    { t_ms: 100, x: 200, y: 10 },
    { t_ms: 250, x: 500, y: 10 },
  ]
  const moved = shiftObservationsToPicture(observed, 127)
  check(
    'every observation moves later by the measured latency',
    moved.map((s) => s.t_ms).join(',') === '127,227,377',
    moved.map((s) => s.t_ms).join(','),
  )
  check(
    'and nothing else about them changes',
    moved.every((s, i) => s.x === observed[i]?.x && s.y === observed[i]?.y)
      && moved.length === observed.length,
  )
  // SPEC 8.3: a sample is a measurement of a real window. A correction that
  // resampled, dropped or interpolated would be writing positions the window
  // never occupied into the same field as ones it did.
  check(
    'the set of rectangles is exactly the set that was observed',
    JSON.stringify(moved.map((s) => [s.x, s.y]))
      === JSON.stringify(observed.map((s) => [s.x, s.y])),
  )
  check(
    'ascending order survives, because a constant shift cannot reorder',
    moved.every((s, i) => i === 0 || s.t_ms > (moved[i - 1] as { t_ms: number }).t_ms),
  )
  // Clamping belongs to a trim (rebaseAnnotationClock). Doing it here as well
  // would silently drop the tail of a track whose last observations move past
  // the end of the replay, which is a deletion disguised as an alignment.
  check(
    'an observation pushed past the replay end is moved, not dropped',
    shiftObservationsToPicture([{ t_ms: 12_500 }], 127)[0]?.t_ms === 12_627,
  )
  check(
    'a zero latency is a copy, not a rewrite',
    shiftObservationsToPicture(observed, 0).map((s) => s.t_ms).join(',') === '0,100,250',
  )
}
{
  // A number the estimator refused to produce is not a small correction, it is
  // no correction. A negative one would mean the picture leads its own
  // timestamp, which no recorder does — applying it would move boxes the wrong
  // way, twice as far as leaving them alone.
  check(
    'an unmeasured latency is not applied',
    !isApplicableExposureLatency(null),
  )
  check(
    'nor a negative one, which would be a broken measurement rather than a lead',
    !isApplicableExposureLatency(-127) && !isApplicableExposureLatency(0),
  )
  check(
    'nor one beyond any recorder',
    !isApplicableExposureLatency(MAXIMUM_APPLICABLE_LATENCY_MS + 1)
      && !isApplicableExposureLatency(Number.POSITIVE_INFINITY)
      && !isApplicableExposureLatency(Number.NaN),
  )
  check(
    'and the measured value is',
    isApplicableExposureLatency(127) && isApplicableExposureLatency(108),
  )
}

// N. THE APP AND THE HARNESS SCORE THE SAME PIXELS THE SAME WAY (#89).
//
// ffmpeg hands the offline harness a gray plane; a canvas hands the app the red
// channel of getImageData. Both are one byte per pixel in row order, and the
// scorer must not care which — otherwise the app and the harness can disagree
// about the same capture, which is the whole reason the fit was shared.
console.log('\nN. the edge scorer, on either kind of plane')
{
  // A synthetic frame with one rectangle drawn as a luminance step.
  const W = 200
  const H = 160
  const rect = { x: 40, y: 30, width: 100, height: 80 }
  const make = (): Uint8Array => {
    const px = new Uint8Array(W * H).fill(30)
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) px[y * W + x] = 200
    }
    return px
  }
  const plane = { data: make(), width: W, height: H }
  const onIt = rectangleEdgeScore(plane, 1, rect)
  const offBy20 = rectangleEdgeScore(plane, 1, { ...rect, x: rect.x + 20 })
  check(
    'the true rectangle scores above one displaced from it',
    onIt !== null && offBy20 !== null && onIt > offBy20,
    `${round(onIt)} vs ${round(offBy20)}`,
  )
  check(
    'a rectangle mostly outside the frame is refused, not scored on a sliver',
    rectangleEdgeScore(plane, 1, { x: -400, y: -400, width: 10, height: 10 }) === null,
  )
  // The two plane kinds the two callers actually produce.
  const asBuffer = { data: Buffer.from(make()), width: W, height: H }
  const asClamped = { data: new Uint8ClampedArray(make()), width: W, height: H }
  check(
    'the same pixels score the same through a Buffer and a clamped array',
    rectangleEdgeScore(asBuffer, 1, rect) === onIt
      && rectangleEdgeScore(asClamped, 1, rect) === onIt,
  )
  const field = readFileSync(
    path.join(process.cwd(), 'scripts', 'exposure-field-check.ts'),
    'utf8',
  )
  check(
    'the harness delegates to it rather than keeping a second copy',
    field.includes('return rectangleEdgeScore(')
      && !field.includes('const inside = x === x0 ? x + 12 : x - 12'),
  )
  const render = readFileSync(
    path.join(process.cwd(), 'src/renderer/render/render.ts'),
    'utf8',
  )
  check(
    'and so does the app, on frames it seeks to rather than plays through',
    render.includes('rectangleEdgeScore(plane, request.scale, candidate)')
      && render.includes('async function seekAndRead(')
      && render.includes('ctx.imageSmoothingEnabled = false'),
  )
  // Playing costs the replay's whole duration in real time, which is what made
  // every other measurement placement too expensive to run.
  check(
    'the measurement job draws and records nothing',
    render.includes("payload.measure !== undefined")
      && render.includes('a measurement job needs a replay'),
  )
}

// K. THE DECODER MUST HAND BACK THE FRAMES THE FILE HAS, NOT A CADENCE.
//
// Every CapturePack replay is variable-rate by construction: a screen capture
// makes a frame when the screen CHANGES. ffmpeg's DEFAULT output mode converts
// to the container's nominal r_frame_rate and DUPLICATES frames to get there.
// The harness pairs the Nth decoded frame with the Nth probed timestamp, so an
// invented frame shifts every pairing after it — and its own guard then refuses
// the whole measurement. Measured on CapturePack_2026-07-31_202834: 263
// packets, 263 probe timestamps, 266 frames out of the default decoder. That is
// why this harness reported nothing on an MP4 pack, which is every pack written
// since the trim stopped changing the container (#113).
{
  const field = readFileSync(
    path.join(process.cwd(), 'scripts', 'exposure-field-check.ts'),
    'utf8',
  )
  check(
    'the field decoder disables frame-rate conversion',
    field.includes("'-fps_mode', 'passthrough',"),
  )
  check(
    'and still pairs decoded frames against a separately probed timestamp list',
    field.includes('frame=best_effort_timestamp_time')
      && field.includes('if (index !== video.ptsMs.length) {'),
  )
}

console.log(
  `\nresult: ${failed === 0 ? 'OK' : 'FAILED'} — ${passed} passed, ${failed} failed`,
)
if (failed > 0) process.exitCode = 1
