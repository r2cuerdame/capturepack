/**
 * The #89 field harness: a saved CapturePack in, a measured per-display desktop
 * pixel exposure latency out.
 *
 * `check:exposure-alignment` proves the arithmetic on a fixture. This proves
 * nothing by itself — it reads real evidence and reports what it finds, which
 * is why it is a `qa:` script and not a gate step: it needs ffmpeg on PATH and
 * a pack that actually contains a moving window.
 *
 * It is strictly read-only. It opens a pack, decodes its replay, and writes
 * nothing back.
 *
 * How it measures, and what it refuses to do:
 *
 * - The landmark is the window the context track says travelled furthest. Its
 *   rectangle over time is recovered from the windows-context plugin timeline,
 *   which stores a checkpoint plus per-tick deltas.
 * - For each decoded frame the candidates are exactly the rectangles that were
 *   OBSERVED, and the one whose four edges best explain that frame's gradients
 *   wins. Nothing is detected freehand and nothing is interpolated, so a frame's
 *   measured position is always a position the context track actually recorded.
 * - A frame whose best candidate barely beats its runner-up did not identify
 *   the landmark, and is dropped rather than voted with.
 * - The latency itself comes from `measureExposureLatency`, unchanged, so the
 *   refusals it enforces on the fixture are the refusals that apply here.
 */

import { spawnSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  measureExposureLatency,
  residualAfterExposureCorrection,
  type DecodedLandmarkFrame,
  type ExposureAlignmentInput,
  type LandmarkObservation,
} from '../src/shared/exposureAlignment'
import { resolvedReplayClockOffsetMs } from '../src/shared/displayClock'
import {
  fitOffsetByPixelScore,
  rectangleEdgeScore,
  type FrameScoreRow,
  type PixelScoreFit,
} from '../src/shared/exposureAlignment'

interface Bounds { x: number; y: number; width: number; height: number }
interface ContextWindow {
  hwnd: string
  title?: string
  process?: string
  class_name?: string
  bounds: Bounds
  display: number
}
interface DisplayEntry {
  index: number
  replay?: string
  replay_duration_ms?: number
  replay_clock_offset_ms?: number
  bounds?: Bounds
  scale?: number
  focused?: boolean
}

/**
 * A frame whose best candidate is not this much better did not identify anything.
 * Overridable so the answer's sensitivity to the gate can be inspected rather
 * than assumed: a latency that moves when this moves is a parameter, not a
 * measurement.
 */
const CONFIDENCE_MARGIN = Number(argValue('--margin') ?? 10)
/** Candidate rectangles are drawn from this much of the track around each frame. */
const CANDIDATE_WINDOW_MS = Number(argValue('--window') ?? 350)
/** Below this a segment is a twitch, not a drag. */
const SEGMENT_MIN_TRAVEL_PX = 300
/** A gap longer than this ends a segment. */
const SEGMENT_GAP_MS = 300

let passed = 0
let failed = 0
let measured = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) passed += 1
  else failed += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

function round(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined ? 'null' : value.toFixed(digits)
}

// ---------------------------------------------------------------------------

const packDir = argValue('--pack')
if (packDir === null) {
  console.log('usage: npm run qa:exposure-field -- --pack <CapturePack directory>')
  console.log('\nNeeds ffmpeg and ffprobe on PATH. Reads the pack; never writes to it.')
  process.exit(2)
}
if (!existsSync(path.join(packDir, 'manifest.json'))) {
  console.log(`no manifest.json under ${packDir}`)
  process.exit(2)
}
for (const tool of ['ffmpeg', 'ffprobe']) {
  const probe = spawnSync(tool, ['-version'], { stdio: 'ignore' })
  if (probe.error !== undefined) {
    console.log(`SKIP — ${tool} is not on PATH, so no pixels can be decoded.`)
    console.log('This harness needs a real decoder; that is why it is not a gate step.')
    process.exit(0)
  }
}

const manifest = JSON.parse(
  readFileSync(path.join(packDir, 'manifest.json'), 'utf8'),
) as { media?: { replay?: string; displays?: DisplayEntry[] } }

const contextTimelinePath = path.join(packDir, 'plugins', 'windows-context', 'timeline.json')
if (!existsSync(contextTimelinePath)) {
  console.log('SKIP — this pack has no windows-context timeline, so it has no landmark.')
  process.exit(0)
}

console.log(`exposure field measurement — ${path.basename(packDir)}\n`)

const track = reconstructWindowTrack(contextTimelinePath)
const displays = manifest.media?.displays ?? []
check('the pack declares at least one display replay', displays.length > 0, `${displays.length}`)

void (async function main(): Promise<void> {
  for (const display of displays) {
    await measureDisplay(display)
  }
  console.log(
    `\nresult: ${failed === 0 ? 'OK' : 'FAILED'} — ${passed} passed, ${failed} failed, `
      + `${measured} display(s) measured`,
  )
  if (failed > 0) process.exitCode = 1
})()

// ---------------------------------------------------------------------------

async function measureDisplay(display: DisplayEntry): Promise<void> {
  const label = `display ${display.index}${display.focused === true ? ' (focused)' : ''}`
  const replay = display.replay
  if (replay === undefined) {
    console.log(`\n${label}: no replay, nothing to compare.`)
    return
  }
  const replayPath = path.join(packDir as string, replay)
  if (!existsSync(replayPath)) {
    check(`${label}: the declared replay exists`, false, replay)
    return
  }

  const video = probeVideo(replayPath)
  const declaredWidth = Math.round((display.bounds?.width ?? 0) * (display.scale ?? 1))
  const declaredHeight = Math.round((display.bounds?.height ?? 0) * (display.scale ?? 1))
  // The context plugin reports window rectangles in per-display PHYSICAL pixels,
  // so the only conversion to video pixels is the recorder's own downscale.
  const scaleX = declaredWidth > 0 ? video.width / declaredWidth : 0
  const scaleY = declaredHeight > 0 ? video.height / declaredHeight : 0
  console.log(
    `\n${label}: ${video.width}x${video.height} replay of a `
      + `${declaredWidth}x${declaredHeight} desktop `
      + `(x${round(scaleX, 3)}, x${round(scaleY, 3)}), `
      + `${video.ptsMs.length} frames at ${round(video.frameIntervalMs)} ms`,
  )
  check(
    `${label}: replay pixels and desktop pixels share one scale on both axes`,
    scaleX > 0 && Math.abs(scaleX - scaleY) <= 0.02,
    `${round(scaleX, 3)} vs ${round(scaleY, 3)}`,
  )
  if (!(scaleX > 0)) return

  const landmark = chooseLandmark(display.index)
  if (landmark === null) {
    console.log(`  no window on this display moved far enough to time anything.`)
    return
  }
  console.log(
    `  landmark hwnd ${landmark.hwnd} (${landmark.className}) travelled `
      + `${round(landmark.travelPx, 0)} px across ${landmark.observations.length} observations`,
  )

  const segments = motionSegments(landmark.observations)
  if (segments.length === 0) {
    console.log('  its travel never formed a continuous drag.')
    return
  }

  for (const segment of segments) {
    const candidates = landmark.observations.filter(
      (o) => o.tMs >= segment.startMs - CANDIDATE_WINDOW_MS
        && o.tMs <= segment.endMs + CANDIDATE_WINDOW_MS,
    )
    const frames = await invertFrames(replayPath, video, scaleX, segment, candidates)
    const confident = frames.filter(
      (f) => f.secondScore !== null && f.score - f.secondScore > CONFIDENCE_MARGIN,
    )
    // THE OFFSET THE APP ACTUALLY USES, NOT ZERO (#89).
    //
    // A non-focused display often has no MEASURED clock origin, and the app
    // then falls back to assuming both recordings ended together
    // (`resolvedReplayClockOffsetMs`). Assuming zero here instead put that
    // entire fallback into the answer as if it were exposure.
    //
    // Measured on CapturePack_2026-08-01_011147: display 2 came out at 127 ms
    // and display 1 at 242 ms, and I reported that as proof the latency is
    // per-display. Display 1's replay is 12799 ms against the focused 12665, so
    // its fallback offset is +134 ms — and the gap between the two answers was
    // +115 ms. The displays were not disagreeing about exposure; one of them
    // was being measured on a clock the harness had guessed at.
    const focusedDurationMs = displays.find((d) => d.focused === true)?.replay_duration_ms
    const declared = display.replay_clock_offset_ms
    const usingFallback =
      !(typeof declared === 'number' && Number.isSafeInteger(declared))
    const offsetMs = resolvedReplayClockOffsetMs(
      declared,
      display.replay_duration_ms ?? 0,
      focusedDurationMs ?? display.replay_duration_ms ?? 0,
    )
    if (usingFallback) {
      console.log(
        `  no measured clock origin; using the app's own fallback `
          + `${offsetMs >= 0 ? '+' : ''}${offsetMs} ms, which is itself an assumption`,
      )
    }
    const input: ExposureAlignmentInput = {
      contextObservations: candidates.map(
        (o): LandmarkObservation => ({ tMs: o.tMs, x: o.bounds.x, y: o.bounds.y }),
      ),
      decodedFrames: confident.map(
        (f): DecodedLandmarkFrame => ({ ptsMs: f.ptsMs, x: f.x, y: f.y }),
      ),
      replayClockOffsetMs: offsetMs,
      // Declared, not derived: dropping unidentifiable frames would otherwise
      // inflate the interval and flatter the one-frame boundary.
      frameIntervalMs: video.frameIntervalMs ?? undefined,
      searchMs: { minMs: -60, maxMs: 400 },
      stepMs: 1,
    }
    // The pixel stage is a classifier over the observed rectangles, so the
    // latency it can support is bounded by how far apart those rectangles are.
    // When consecutive candidates sit closer together than the scorer can tell
    // apart, the answer degrades into a ladder whose steps are the ring
    // interval — and `resolutionMs`, computed from the latency scan rather than
    // from the classifier, does not widen to say so. Report the separation so
    // that gap is visible instead of implied.
    const separations: number[] = []
    for (let i = 1; i < candidates.length; i += 1) {
      const a = candidates[i - 1]
      const b = candidates[i]
      if (a === undefined || b === undefined) continue
      const step = Math.hypot(b.bounds.x - a.bounds.x, b.bounds.y - a.bounds.y)
      if (step > 0) separations.push(step)
    }
    separations.sort((a, b) => a - b)
    const separationPx = separations.length === 0
      ? null
      : (separations[separations.length >> 1] as number)

    const report = measureExposureLatency(input)
    // The identification gate is a choice, so the answer's dependence on it is
    // reported rather than assumed. Re-filtering costs nothing: the decode has
    // already happened and the margin only selects from what it produced.
    const sensitivity = [CONFIDENCE_MARGIN / 2, CONFIDENCE_MARGIN * 2]
      .map((margin) => {
        const kept = frames.filter(
          (f) => f.secondScore !== null && f.score - f.secondScore > margin,
        )
        const alternative = measureExposureLatency({
          ...input,
          decodedFrames: kept.map(
            (f): DecodedLandmarkFrame => ({ ptsMs: f.ptsMs, x: f.x, y: f.y }),
          ),
        })
        return { margin, frames: kept.length, latencyMs: alternative.latencyMs }
      })
    // The estimator that does not need a single frame identified. Always run,
    // always printed: where identification also succeeds the two are a check on
    // each other, and where it does not this is the only answer available.
    // Deliberately wider than the identification path's range and symmetric about
    // zero: an answer pinned to a boundary is not a peak, and a sweep that cannot
    // go past its own answer has no way to say so.
    const fit = fitOffsetByPixelScore(
      frames,
      { minMs: -400, maxMs: 400 },
      1,
      offsetMs,
      CANDIDATE_WINDOW_MS,
    )
    const fitLine = fit === null
      ? '    pixel-score fit: no usable signal'
      : `    pixel-score fit: latency ${round(fit.latencyMs)} ms +/- ${round(fit.resolutionMs)}`
        + ` over ${fit.comparedFrames} frame(s), contrast ${round(fit.contrast * 100, 1)}%`
    const header = `  ${segment.startMs}-${segment.endMs} ms: `
      + `${confident.length}/${frames.length} frames identified`
    if (report.status !== 'measured') {
      console.log(`${header} — identification REFUSED: ${report.reason}`)
      console.log(fitLine)
      // A refusal is still correct: the identification path must not guess.
      // What has changed is that its refusal no longer ends the measurement.
      check(
        `${label} ${segment.startMs}-${segment.endMs} ms: thin evidence refuses instead of guessing`,
        report.latencyMs === null,
        report.reason,
      )
      if (fit !== null) {
        measured += 1
        check(
          `${label} ${segment.startMs}-${segment.endMs} ms: the slow drag still yields an offset`,
          fit.contrast > 0 && Math.abs(fit.latencyMs) < 395,
          `${round(fit.latencyMs)} ms +/- ${round(fit.resolutionMs)}`,
        )
      }
      continue
    }
    console.log(fitLine)
    if (fit !== null) {
      // Two estimators, one quantity. They are computed from the same pixels
      // but by different questions, so a disagreement is evidence about the
      // measurement rather than about the recorder.
      check(
        `${label} ${segment.startMs}-${segment.endMs} ms: both estimators agree within their resolutions`,
        Math.abs(fit.latencyMs - (report.latencyMs ?? 0))
          <= fit.resolutionMs + (report.resolutionMs ?? 0) + 34,
        `${round(report.latencyMs)} vs ${round(fit.latencyMs)}`,
      )
    }
    const uncorrected = residualAfterExposureCorrection(input, 0)
    console.log(
      `${header}\n`
        + `    exposure latency ${round(report.latencyMs)} ms +/- ${round(report.resolutionMs)}`
        + ` at ${round(report.speedPxPerMs, 2)} px/ms\n`
        + `    positional error ${round(uncorrected.residualPx, 0)} px uncorrected`
        + ` -> ${round(report.residualPx, 0)} px corrected`
        + ` (${round(uncorrected.residualMs)} ms -> ${round(report.residualMs)} ms)\n`
        + `    consecutive candidates ${round(separationPx, 0)} px apart`
        + ` — what the pixel stage had to tell apart`,
    )
    check(
      `${label} ${segment.startMs}-${segment.endMs} ms: consecutive candidates are far enough apart to be told apart`,
      separationPx !== null && separationPx >= 8,
      `${round(separationPx, 0)} px between observed positions`,
    )
    measured += 1
    const agreeing = sensitivity.filter((s) => s.latencyMs !== null)
    console.log(
      `    at half and double the identification gate: `
        + agreeing.map(
          (s) => `${round(s.latencyMs)} ms (${s.frames} frames)`,
        ).join(', ') || '    the gate could not be varied',
    )
    check(
      `${label} ${segment.startMs}-${segment.endMs} ms: the latency is not an artefact of the identification gate`,
      agreeing.length > 0
        && agreeing.every(
          (s) => Math.abs((s.latencyMs as number) - (report.latencyMs as number))
            <= (report.frameIntervalMs ?? 0),
        ),
      agreeing.map((s) => `${round(s.latencyMs)}`).join(' / ') || 'no comparison possible',
    )
    check(
      `${label} ${segment.startMs}-${segment.endMs} ms: the measured latency explains the pixels`,
      report.residualPx !== null
        && uncorrected.residualPx !== null
        && report.residualPx < uncorrected.residualPx,
      `${round(uncorrected.residualPx, 0)} px -> ${round(report.residualPx, 0)} px`,
    )
    check(
      `${label} ${segment.startMs}-${segment.endMs} ms: exposure is not negative`,
      (report.latencyMs ?? 0) >= 0,
      `${round(report.latencyMs)} ms — pixels cannot show the future`,
    )
  }
}

// ---------------------------------------------------------------------------

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag)
  if (index < 0) return null
  return process.argv[index + 1] ?? null
}

function reconstructWindowTrack(
  file: string,
): Array<{ tMs: number; win: ContextWindow }> {
  const timeline = JSON.parse(readFileSync(file, 'utf8')) as {
    checkpoint: { t_ms: number; windows: ContextWindow[] }
    deltas: Array<Record<string, unknown>>
  }
  let live: Array<ContextWindow | undefined> = timeline.checkpoint.windows.map(
    (w) => structuredClone(w),
  )
  const out: Array<{ tMs: number; win: ContextWindow }> = []
  const record = (tMs: number): void => {
    for (const w of live) {
      if (w !== undefined && w.bounds !== undefined) out.push({ tMs, win: structuredClone(w) })
    }
  }
  record(timeline.checkpoint.t_ms)
  for (const delta of timeline.deltas) {
    const windows = delta['windows'] as {
      length?: number
      set?: Array<[number, ContextWindow]>
      patch?: Array<[number, Partial<ContextWindow>]>
      delete?: number[]
    } | undefined
    if (windows !== undefined) {
      if (typeof windows.length === 'number') live.length = windows.length
      for (const [index, value] of windows.set ?? []) live[index] = structuredClone(value)
      for (const [index, partial] of windows.patch ?? []) {
        const base = live[index] ?? ({} as ContextWindow)
        live[index] = {
          ...base,
          ...partial,
          bounds: partial.bounds ? { ...base.bounds, ...partial.bounds } : base.bounds,
        }
      }
      for (const index of windows.delete ?? []) live[index] = undefined
    }
    record(delta['t_ms'] as number)
  }
  return out
}

interface LandmarkObservationRow { tMs: number; bounds: Bounds }

function chooseLandmark(displayIndex: number): {
  hwnd: string
  className: string
  travelPx: number
  observations: LandmarkObservationRow[]
} | null {
  const byWindow = new Map<string, { className: string; rows: LandmarkObservationRow[] }>()
  for (const { tMs, win } of track) {
    if (win.display !== displayIndex) continue
    let entry = byWindow.get(win.hwnd)
    if (entry === undefined) {
      byWindow.set(win.hwnd, (entry = { className: win.class_name ?? '', rows: [] }))
    }
    const previous = entry.rows[entry.rows.length - 1]
    if (previous !== undefined && previous.tMs === tMs) continue
    entry.rows.push({ tMs, bounds: win.bounds })
  }
  let best: { hwnd: string; className: string; travelPx: number; observations: LandmarkObservationRow[] } | null = null
  for (const [hwnd, entry] of byWindow) {
    let travelPx = 0
    for (let index = 1; index < entry.rows.length; index += 1) {
      const a = entry.rows[index - 1]
      const b = entry.rows[index]
      if (a === undefined || b === undefined) continue
      travelPx += Math.hypot(b.bounds.x - a.bounds.x, b.bounds.y - a.bounds.y)
    }
    if (best === null || travelPx > best.travelPx) {
      best = { hwnd, className: entry.className, travelPx, observations: entry.rows }
    }
  }
  if (best === null || best.travelPx < SEGMENT_MIN_TRAVEL_PX) return null
  return best
}

function motionSegments(
  observations: readonly LandmarkObservationRow[],
): Array<{ startMs: number; endMs: number }> {
  const runs: LandmarkObservationRow[][] = []
  let current: LandmarkObservationRow[] = []
  for (const row of observations) {
    const previous = current[current.length - 1]
    if (previous !== undefined && row.tMs - previous.tMs > SEGMENT_GAP_MS) {
      runs.push(current)
      current = []
    }
    current.push(row)
  }
  if (current.length > 0) runs.push(current)
  const out: Array<{ startMs: number; endMs: number }> = []
  for (const run of runs) {
    let travelPx = 0
    for (let index = 1; index < run.length; index += 1) {
      const a = run[index - 1]
      const b = run[index]
      if (a === undefined || b === undefined) continue
      travelPx += Math.hypot(b.bounds.x - a.bounds.x, b.bounds.y - a.bounds.y)
    }
    const first = run[0]
    const last = run[run.length - 1]
    if (travelPx < SEGMENT_MIN_TRAVEL_PX || first === undefined || last === undefined) continue
    out.push({ startMs: first.tMs, endMs: last.tMs })
  }
  return out
}

interface ProbedVideo {
  width: number
  height: number
  ptsMs: number[]
  frameIntervalMs: number | null
}

function probeVideo(file: string): ProbedVideo {
  const size = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file,
  ], { encoding: 'utf8' })
  const [width, height] = (size.stdout ?? '').trim().split('x').map(Number)
  const pts = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'csv=p=0', file,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const ptsMs = (pts.stdout ?? '').trim().split('\n')
    .map((line) => Number(line) * 1000)
    .filter((value) => Number.isFinite(value))
  const intervals: number[] = []
  for (let index = 1; index < ptsMs.length; index += 1) {
    intervals.push((ptsMs[index] as number) - (ptsMs[index - 1] as number))
  }
  intervals.sort((a, b) => a - b)
  return {
    width: width ?? 0,
    height: height ?? 0,
    ptsMs,
    frameIntervalMs: intervals.length === 0 ? null : (intervals[intervals.length >> 1] as number),
  }
}

interface InvertedFrame {
  ptsMs: number
  x: number
  y: number
  score: number
  secondScore: number | null
  /**
   * Every candidate this frame was scored against, kept rather than discarded.
   *
   * The argmax above answers "which rectangle is this frame showing", which is
   * a question a SLOW drag cannot answer: consecutive observations sit a few
   * pixels apart, no candidate wins by the confidence margin, and the whole
   * measurement refuses. Three consecutive field packs refused that way.
   *
   * The row survives so the offset can be fitted without ever identifying a
   * single frame — see `fitOffsetByPixelScore`.
   */
  scores: Array<{ tMs: number; score: number }>
}

async function invertFrames(
  replayPath: string,
  video: ProbedVideo,
  scale: number,
  segment: { startMs: number; endMs: number },
  candidates: readonly LandmarkObservationRow[],
): Promise<InvertedFrame[]> {
  return await new Promise<InvertedFrame[]>((resolve) => {
    const frameBytes = video.width * video.height
    const out: InvertedFrame[] = []
    let index = 0
    let buffered: Buffer[] = []
    let have = 0

    // -fps_mode passthrough, and it is not optional. Every CapturePack replay
    // is variable-rate by construction — a screen capture makes a frame when
    // the screen CHANGES — so ffmpeg's default CFR conversion DUPLICATES frames
    // to reach the container's nominal r_frame_rate. Measured on
    // CapturePack_2026-07-31_202834: 263 packets, 263 probe timestamps, 266
    // frames out of the decoder. The Nth decoded frame then stops being the Nth
    // timestamp, the guard below fires, and the measurement refuses — which is
    // why this harness has never returned a number on an MP4 pack.
    const ffmpeg = spawn('ffmpeg', [
      '-v', 'error', '-i', replayPath,
      '-fps_mode', 'passthrough',
      '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
    ], { stdio: ['ignore', 'pipe', 'inherit'] })

    const handle = (frame: Buffer): void => {
      const ptsMs = video.ptsMs[index]
      index += 1
      if (ptsMs === undefined || ptsMs < segment.startMs || ptsMs > segment.endMs) return
      let best: InvertedFrame | null = null
      let secondScore: number | null = null
      const scores: Array<{ tMs: number; score: number }> = []
      for (const candidate of candidates) {
        if (Math.abs(candidate.tMs - ptsMs) > CANDIDATE_WINDOW_MS) continue
        const score = edgeScore(frame, video, scale, candidate.bounds)
        if (score !== null) scores.push({ tMs: candidate.tMs, score })
        if (score === null) continue
        if (best === null || score > best.score) {
          secondScore = best?.score ?? secondScore
          best = {
            ptsMs,
            x: candidate.bounds.x,
            y: candidate.bounds.y,
            score,
            secondScore: null,
            scores,
          }
        } else if (secondScore === null || score > secondScore) {
          secondScore = score
        }
      }
      if (best !== null) out.push({ ...best, secondScore, scores })
    }

    ffmpeg.stdout.on('data', (chunk: Buffer) => {
      buffered.push(chunk)
      have += chunk.length
      while (have >= frameBytes) {
        const all = buffered.length === 1 ? (buffered[0] as Buffer) : Buffer.concat(buffered)
        handle(all.subarray(0, frameBytes))
        const rest = all.subarray(frameBytes)
        buffered = rest.length > 0 ? [rest] : []
        have = rest.length
      }
    })
    ffmpeg.on('close', () => {
      // The Nth decoded frame is paired with the Nth timestamp from a SEPARATE
      // ffprobe run. If the two ever disagree on how many frames the file has,
      // every frame after the disagreement carries a confidently-declared wrong
      // PTS — which is precisely the failure this whole measurement exists to
      // detect, so it must never be produced by the measurement itself.
      if (index !== video.ptsMs.length) {
        console.log(
          `    decoder and probe disagree: ${index} frames decoded, `
            + `${video.ptsMs.length} timestamps — every pairing after the first `
            + `disagreement would be wrong, so nothing is reported`,
        )
        resolve([])
        return
      }
      resolve(out)
    })
  })
}

/**
 * How well one observed rectangle's four edges explain this frame.
 *
 * Measured against the window's own interior 12 px in, so a rectangle that
 * merely lands on busy content scores no better than its surroundings and a
 * genuine window boundary stands out.
 */
/** The harness's pixels are an ffmpeg gray plane; the scorer is shared. */
function edgeScore(
  frame: Buffer,
  video: ProbedVideo,
  scale: number,
  bounds: Bounds,
): number | null {
  return rectangleEdgeScore(
    { data: frame, width: video.width, height: video.height },
    scale,
    bounds,
  )
}
