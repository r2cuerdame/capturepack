// Production-code bridge used by windows-replay-field-check.mjs.
//
// The field check intentionally does not reimplement persisted context replay.
// It bundles this tiny entry and therefore runs the same untrusted timeline
// decoder and ContextSession that a reopened CapturePack editor uses.
import { ContextSession } from '../src/main/context/session'
import {
  decodeWindowsContextTimeline,
} from '../src/main/context/windowsContextTimeline'
import type { ContextObservation } from '../src/main/context/buffer'
import type { ContextDisplayTarget } from '../src/main/context/session'
import type { ContextCandidate } from '../src/shared/context/protocol'
import { ObjectIndex } from '../src/renderer/editor/objects'
import {
  reopenedContextDisplayTargets,
  type ReopenedLoadedDisplayGeometry,
} from '../src/main/reopenDisplay'

interface ReopenDisplayInput {
  snapshotWidth: number
  snapshotHeight: number
  screens: Array<{ width: number; height: number; scale: number }>
  displays: Array<{
    index: number
    focused: boolean
    bounds: { x: number; y: number; width: number; height: number }
    scale: number
  }> | undefined
  loadedDisplays: ReopenedLoadedDisplayGeometry[]
}

interface PastSamplingInput {
  value: unknown
  displays: ContextDisplayTarget[]
  displayOffsets: Array<{ display: number; replayClockOffsetMs: number }>
  replayDurationMs: number
  targetTitle: string
  queryTimesMs: number[]
  reopen?: ReopenDisplayInput
  pickPoints?: Array<{
    requestedTimeMs: number
    display: number
    x: number
    y: number
    label: string
  }>
}

interface TargetWindow {
  t_ms: number
  display: number
  bounds: { x: number; y: number; width: number; height: number }
}

function nearestObservation(
  observations: readonly ContextObservation[],
  requestedTimeMs: number,
): ContextObservation | null {
  let nearest: ContextObservation | null = null
  let distance = Number.POSITIVE_INFINITY
  for (const observation of observations) {
    const nextDistance = Math.abs(observation.tMs - requestedTimeMs)
    // The persisted codec and ContextBuffer both keep the earlier sorted
    // observation on an exact tie. Strictly-less reproduces that contract.
    if (nextDistance < distance) {
      nearest = observation
      distance = nextDistance
    }
  }
  return nearest
}

function targetWindows(
  observation: ContextObservation | null,
  title: string,
): TargetWindow[] {
  if (observation === null) return []
  return observation.windows
    .filter((window) => window.title === title)
    .map((window) => ({
      t_ms: observation.tMs,
      display: window.display,
      bounds: { ...window.bounds },
    }))
}

function compactCandidate(candidate: ContextCandidate): {
  provider_id: string
  surface_id: string
  authority: string
  name: string | null
  display: number | null
  bounds: ContextCandidate['bounds']
  coverage: string
  error_ms: number
} {
  return {
    provider_id: candidate.providerId,
    surface_id: candidate.surfaceId,
    authority: candidate.authority,
    name: candidate.name ?? null,
    display: candidate.display ?? null,
    bounds: { ...candidate.bounds },
    coverage: candidate.accuracy.coverage,
    error_ms: candidate.accuracy.errorMs,
  }
}

function compactPick(pick: ReturnType<ObjectIndex['pick']>): {
  provider_id: string
  surface_id: string
  authority: string
  level: string
  name: string | null
  surface_title: string | null
  bounds: { x: number; y: number; width: number; height: number }
} | null {
  if (pick === null) return null
  return {
    provider_id: pick.providerId,
    surface_id: pick.surfaceId,
    authority: pick.authority,
    level: pick.level,
    name: pick.candidate.name ?? null,
    surface_title: pick.surface?.windowTitle ?? null,
    bounds: {
      x: pick.x,
      y: pick.y,
      width: pick.width,
      height: pick.height,
    },
  }
}

function sameRect(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height
  )
}

async function querySession(
  observations: readonly ContextObservation[],
  input: Omit<PastSamplingInput, 'value'>,
): Promise<Array<{
  requested_t_ms: number
  materialized_t_ms: number
  error_ms: number
  coverage: string
  exact: boolean
  interpolated: boolean
  observed_windows: TargetWindow[]
  candidates: ReturnType<typeof compactCandidate>[]
  picks: Array<{
    display: number
    point: { x: number; y: number }
    label: string
    picked: ReturnType<typeof compactPick>
    picked_target: boolean
  }>
  nearest_sample_unchanged: boolean
  display_queries: Array<{
    display: number
    replay_clock_offset_ms: number
    requested_pack_t_ms: number
    presented_media_t_ms: number
    materialized_pack_t_ms: number
    error_ms: number
    coverage: string
    observed_windows: TargetWindow[]
    candidates: ReturnType<typeof compactCandidate>[]
    picks: Array<{
      display: number
      point: { x: number; y: number }
      label: string
      picked: ReturnType<typeof compactPick>
      picked_target: boolean
    }>
    nearest_sample_unchanged: boolean
  }>
}>> {
  const session = new ContextSession('windows-replay-field-check', {
    displays: input.displays,
    replayDurationMs: input.replayDurationMs,
    observation: null,
    dropped: false,
  })
  session.adoptAll(observations)

  const rows = []
  for (const requestedTimeMs of input.queryTimesMs) {
    const nearest = nearestObservation(observations, requestedTimeMs)
    const observed = targetWindows(nearest, input.targetTitle)
    const frame = await session.frameAt(requestedTimeMs)
    const candidates = frame.displays
      .flatMap((display) => display.candidates)
      .filter((candidate) => (
        candidate.providerId === 'core'
        && candidate.name === input.targetTitle
      ))
      .map(compactCandidate)
    const requestedPickPoints = input.pickPoints?.filter(
      (point) => point.requestedTimeMs === requestedTimeMs,
    )
    const pickPoints =
      requestedPickPoints !== undefined && requestedPickPoints.length > 0
        ? requestedPickPoints
        : observed.map((window) => ({
            requestedTimeMs,
            display: window.display,
            x: window.bounds.x + window.bounds.width / 2,
            y: window.bounds.y + window.bounds.height / 2,
            label: 'observed-center',
          }))
    const picks = pickPoints.flatMap((point) => {
      const displayFrame = frame.displays.find(
        (display) => display.display === point.display,
      )
      if (displayFrame === undefined) return []
      const picked = compactPick(ObjectIndex.build(
        displayFrame.candidates,
        displayFrame.surfaces,
        displayFrame.coverage,
        frame.claims,
        displayFrame.width,
        displayFrame.height,
        displayFrame.display,
      ).pick(point.x, point.y))
      return [{
        display: point.display,
        point: { x: point.x, y: point.y },
        label: point.label,
        picked,
        picked_target:
          picked?.surface_title === input.targetTitle
          || picked?.name === input.targetTitle,
      }]
    })
    const unchanged =
      frame.accuracy.interpolated !== true
      && candidates.length === observed.length
      && candidates.every((candidate) => observed.some((window) => (
        candidate.display === window.display
        && sameRect(candidate.bounds, window.bounds)
      )))
    const clocks =
      input.displayOffsets
      ?? input.displays.map((display) => ({ display: display.index, replayClockOffsetMs: 0 }))
    const displayQueries = clocks.map((clock) => {
      // A secondary replay is presented at pack time + its observed recorder
      // offset. Turning that presented time back into the shared pack clock is
      // deliberately explicit here: querying ContextSession with raw media PTS
      // would apply the offset twice and make a cross-monitor move diverge.
      const presentedMediaTimeMs = requestedTimeMs + clock.replayClockOffsetMs
      const requestedPackTimeMs = presentedMediaTimeMs - clock.replayClockOffsetMs
      const displayObserved = observed.filter((window) => window.display === clock.display)
      const displayCandidates = candidates.filter(
        (candidate) => candidate.display === clock.display,
      )
      const displayPicks = picks.filter((pick) => pick.display === clock.display)
      return {
        display: clock.display,
        replay_clock_offset_ms: clock.replayClockOffsetMs,
        requested_pack_t_ms: requestedPackTimeMs,
        presented_media_t_ms: presentedMediaTimeMs,
        materialized_pack_t_ms: frame.accuracy.materializedTimeMs,
        error_ms: frame.accuracy.errorMs,
        coverage: frame.accuracy.coverage,
        observed_windows: displayObserved,
        candidates: displayCandidates,
        picks: displayPicks,
        nearest_sample_unchanged:
          frame.accuracy.interpolated !== true
          && displayCandidates.length === displayObserved.length
          && displayCandidates.every((candidate) => displayObserved.some((window) =>
            sameRect(candidate.bounds, window.bounds))),
      }
    })
    rows.push({
      requested_t_ms: requestedTimeMs,
      materialized_t_ms: frame.accuracy.materializedTimeMs,
      error_ms: frame.accuracy.errorMs,
      coverage: frame.accuracy.coverage,
      exact: frame.accuracy.exact,
      interpolated: frame.accuracy.interpolated === true,
      observed_windows: observed,
      candidates,
      picks,
      nearest_sample_unchanged: unchanged,
      display_queries: displayQueries,
    })
  }
  return rows
}

/**
 * Decode, open, query, then decode and open again. The second result is the
 * save -> close -> reopen check; equality means no alternate in-memory path
 * changed time, display, or rectangle.
 */
export async function analyzePastSampling(input: PastSamplingInput): Promise<{
  status: 'loaded' | 'invalid'
  range: { start_ms: number; end_ms: number } | null
  observation_count: number
  target_samples: TargetWindow[]
  queries: Awaited<ReturnType<typeof querySession>>
  reopen_identical: boolean
}> {
  const first = decodeWindowsContextTimeline(input.value)
  if (first === null) {
    return {
      status: 'invalid',
      range: null,
      observation_count: 0,
      target_samples: [],
      queries: [],
      reopen_identical: false,
    }
  }
  const argumentsWithoutValue = {
    displays: input.displays,
    displayOffsets: input.displayOffsets,
      replayDurationMs: input.replayDurationMs,
      targetTitle: input.targetTitle,
      queryTimesMs: input.queryTimesMs,
      pickPoints: input.pickPoints,
  }
  const queries = await querySession(first.observations, argumentsWithoutValue)

  // Parse the serialized value again instead of reusing the first materialized
  // observations. Resolve displays through the same pure production helper
  // session.ts uses before constructing the second ContextSession, so this
  // crosses both persisted timeline and persisted display-identity boundaries.
  const second = decodeWindowsContextTimeline(input.value)
  const reopenedDisplays =
    input.reopen === undefined
      ? input.displays
      : reopenedContextDisplayTargets(input.reopen)
  const reopened = second === null
    ? []
    : await querySession(second.observations, {
        ...argumentsWithoutValue,
        displays: reopenedDisplays,
      })
  const targetSamples = first.observations.flatMap((observation) =>
    targetWindows(observation, input.targetTitle))
  return {
    status: 'loaded',
    range: { ...first.timeline.range },
    observation_count: first.observations.length,
    target_samples: targetSamples,
    queries,
    reopen_identical: JSON.stringify(queries) === JSON.stringify(reopened),
  }
}
