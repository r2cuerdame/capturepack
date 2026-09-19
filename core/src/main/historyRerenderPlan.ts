import { resolvedReplayClockOffsetMs } from '../shared/displayClock'
import { rebaseAnnotationClock } from '../shared/motion'
import { computeDisplayNumbers } from '../shared/numbering'
import type { AuthoredMotionSpace } from '../shared/track'
import {
  annotationsOnDisplay,
  declaredDisplayIndices,
  focusedDisplayIndex,
} from '../shared/types'
import type { Annotation, Manifest, ManifestDisplayMedia } from '../shared/types'

export interface HistoryDisplayRerenderPlan {
  index: number
  snapshot: string
  replay: string | null
  replayDurationMs: number
  width: number
  height: number
  annotations: Annotation[]
  stillAnnotations: Annotation[]
}

export interface HistoryRerenderPlan {
  focusedDisplay: number | undefined
  focusedAnnotations: Annotation[]
  displayNumbers: Array<[string, number]>
  motionSpace: AuthoredMotionSpace | undefined
  displays: HistoryDisplayRerenderPlan[]
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.round(value)
    : null
}

function displayFrame(display: ManifestDisplayMedia): { width: number; height: number } | null {
  const declaredWidth = positiveInteger(display.snapshot_width)
  const declaredHeight = positiveInteger(display.snapshot_height)
  if (declaredWidth !== null && declaredHeight !== null) {
    return { width: declaredWidth, height: declaredHeight }
  }
  if (
    display.bounds === null || typeof display.bounds !== 'object'
    || typeof display.bounds.width !== 'number' || !Number.isFinite(display.bounds.width)
    || typeof display.bounds.height !== 'number' || !Number.isFinite(display.bounds.height)
    || typeof display.scale !== 'number' || !Number.isFinite(display.scale) || display.scale <= 0
  ) return null
  const width = positiveInteger(display.bounds.width * display.scale)
  const height = positiveInteger(display.bounds.height * display.scale)
  return width === null || height === null ? null : { width, height }
}

function withoutReplayTimes(annotation: Annotation): Annotation {
  if (annotation.start_ms === undefined && annotation.end_ms === undefined) return annotation
  const copy = { ...annotation }
  delete copy.start_ms
  delete copy.end_ms
  return copy
}

/**
 * Plans a History retry from what the saved pack declares, without reading or
 * mutating media. Every renderer receives one display's boxes but the pack's
 * global numbering, and secondary lifetimes are rebased to their own replay.
 */
export function planHistoryRerender(
  manifest: Manifest,
  annotations: readonly Annotation[],
): HistoryRerenderPlan {
  const declared = declaredDisplayIndices(manifest.media?.displays)
  const focused = declared === undefined
    ? undefined
    : focusedDisplayIndex(manifest.media.displays)
  const focusedIndex = focused ?? 1
  const displayNumbers = [...computeDisplayNumbers(annotations)]
  const rawDisplays = Array.isArray(manifest.media?.displays) ? manifest.media.displays : []
  const frames = rawDisplays.flatMap((display) => {
    const frame = displayFrame(display)
    return frame === null ? [] : [{ display, frame }]
  })
  const focusedDurationMs = rawDisplays.find((display) => display.focused)?.replay_duration_ms ?? 0
  const motionSpace: AuthoredMotionSpace | undefined = frames.length < 2
    ? undefined
    : {
        focusedIndex,
        displays: frames.map(({ display, frame }) => ({
          index: display.index,
          width: frame.width,
          height: frame.height,
          bounds: { ...display.bounds },
        })),
      }
  const displays: HistoryDisplayRerenderPlan[] = []
  for (const { display, frame } of frames) {
    if (display.index === focusedIndex || display.focused) continue
    const own = annotationsOnDisplay(annotations, display.index, focusedIndex, declared)
    if (own.length === 0) continue
    const durationMs = typeof display.replay_duration_ms === 'number'
      ? Math.max(0, display.replay_duration_ms)
      : 0
    const offsetMs = resolvedReplayClockOffsetMs(
      display.replay_clock_offset_ms,
      durationMs,
      typeof focusedDurationMs === 'number' ? Math.max(0, focusedDurationMs) : 0,
    )
    displays.push({
      index: display.index,
      snapshot: display.snapshot,
      replay: typeof display.replay === 'string' ? display.replay : null,
      replayDurationMs: durationMs,
      width: frame.width,
      height: frame.height,
      annotations: own.map((annotation) => rebaseAnnotationClock(annotation, offsetMs, durationMs)),
      stillAnnotations: own.map(withoutReplayTimes),
    })
  }
  return {
    focusedDisplay: focused,
    focusedAnnotations: annotationsOnDisplay(annotations, focusedIndex, focusedIndex, declared),
    displayNumbers,
    motionSpace,
    displays,
  }
}
