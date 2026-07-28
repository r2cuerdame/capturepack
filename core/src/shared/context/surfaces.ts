// The Platform Surface Timeline (#65): which top-level window was where, in
// what order, at time T — for the PAST desktop, not the live one.
//
// CORE PLATFORM INFRASTRUCTURE, NOT A PROVIDER (GOAL, #65). It reads window
// geometry and nothing else; it never interprets a UI Automation, DOM or Unreal
// object tree. Core owns it because it is the thing that makes arbitration
// possible at all, and a plugin cannot be trusted with the answer that decides
// which plugin gets asked.
//
// It is also the FLOOR of object picking (GOAL: "windows are always
// selectable"). Wherever this timeline has a sample, hovering has an answer,
// whatever every provider above it is doing.
import type { Rect, ScreenPoint, SurfaceInfo, SurfaceSample, TemporalAccuracy } from './protocol'
import { STALENESS_CEILING_MS } from './protocol'

/**
 * WHAT KIND OF RECORD THIS IS, which is what makes an honest coverage verdict
 * possible at all:
 *
 *   ring           — real sampling over a range. A time inside it is covered up
 *                    to the staleness ceiling; a gap is a gap.
 *   single-instant — exactly one moment was ever recorded (every v0.1.x pack:
 *                    the dump describes the instant the hotkey was pressed).
 *                    Every other time is NOT covered, and saying so is the
 *                    whole difference between this and the v0.1.7 stopgap,
 *                    which refused by CLOCK POSITION rather than by coverage.
 */
export type TimelineKind = 'ring' | 'single-instant'

export interface TimelineRange {
  startMs: number
  endMs: number
}

/**
 * The coverage verdict for one requested time against one record.
 *
 * Deliberately shared by the timeline and by every provider: an editor that
 * shows one message for "this pack holds one instant" and another for "the
 * buffer was pruned here" needs both to be computed the same way, or the two
 * halves of the answer disagree.
 */
export function accuracyAt(
  requestedTimeMs: number,
  materializedTimeMs: number | null,
  kind: TimelineKind,
  range: TimelineRange,
  stalenessCeilingMs: number = STALENESS_CEILING_MS,
): TemporalAccuracy {
  if (materializedTimeMs === null) {
    return {
      requestedTimeMs,
      materializedTimeMs: requestedTimeMs,
      errorMs: 0,
      exact: false,
      coverage: 'none',
    }
  }
  const errorMs = Math.abs(requestedTimeMs - materializedTimeMs)
  const exact = errorMs === 0
  const coverage = exact
    ? 'covered'
    : kind === 'single-instant'
      ? 'single-instant'
      : requestedTimeMs < range.startMs
        ? 'before-start'
        : errorMs > stalenessCeilingMs
          ? 'degraded'
          : 'covered'
  return { requestedTimeMs, materializedTimeMs, errorMs, exact, coverage }
}

export interface RestoredSurfaces {
  sample: SurfaceSample | null
  accuracy: TemporalAccuracy
}

export class SurfaceTimeline {
  private readonly samples: readonly SurfaceSample[]
  readonly kind: TimelineKind
  readonly range: TimelineRange

  constructor(samples: readonly SurfaceSample[], kind: TimelineKind, range: TimelineRange) {
    // Ascending by time: every lookup below is a bisect, and a caller handing
    // us samples in arrival order must not be able to break that.
    this.samples = [...samples].sort((a, b) => a.tMs - b.tMs)
    this.kind = kind
    this.range = range
  }

  get sampleCount(): number {
    return this.samples.length
  }

  /** The sample times, ascending — what a coverage report is drawn from. */
  get times(): readonly number[] {
    return this.samples.map((s) => s.tMs)
  }

  /**
   * The surface stack as it was at `timeMs`, with the verdict on how well that
   * is actually known.
   *
   * NEAREST sample, not nearest-before: a window's rectangle 40 ms after the
   * requested instant is a better answer than the same window's rectangle 960 ms
   * before it, and the accuracy says exactly how far off it is either way.
   */
  restore(timeMs: number, stalenessCeilingMs: number = STALENESS_CEILING_MS): RestoredSurfaces {
    const sample = this.nearest(timeMs)
    if (sample === null) {
      return { sample: null, accuracy: accuracyAt(timeMs, null, this.kind, this.range) }
    }
    return {
      sample,
      accuracy: accuracyAt(timeMs, sample.tMs, this.kind, this.range, stalenessCeilingMs),
    }
  }

  private nearest(timeMs: number): SurfaceSample | null {
    if (this.samples.length === 0) return null
    let best: SurfaceSample | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const sample of this.samples) {
      const distance = Math.abs(sample.tMs - timeMs)
      if (distance < bestDistance) {
        best = sample
        bestDistance = distance
      }
    }
    return best
  }
}

/** Whether a point is inside a rectangle (inclusive on both edges, as picking is). */
export function rectContains(r: Rect, p: ScreenPoint): boolean {
  return p.x >= r.x && p.y >= r.y && p.x <= r.x + r.width && p.y <= r.y + r.height
}

/**
 * The surfaces covering a point, TOP-MOST FIRST — the stack #65 returns rather
 * than only the winner, because the losing surfaces are what Alt+Click cycles
 * back through (#66: "never discard the losing candidates").
 *
 * Invisible and minimized surfaces are dropped here: they are not on screen at
 * that time, so nothing in them can be what the user was looking at.
 */
export function surfaceStackAt(
  surfaces: readonly SurfaceInfo[],
  point: ScreenPoint,
  display?: number,
): readonly SurfaceInfo[] {
  const hits = surfaces.filter(
    (s) =>
      s.visible &&
      !s.minimized &&
      (display === undefined || s.display === undefined || s.display === display) &&
      rectContains(s.bounds, point),
  )
  return [...hits].sort((a, b) => a.zOrder - b.zOrder)
}

/**
 * The part of `surfaces[index]` that no surface above it covers.
 *
 * Subtractive rectangle arithmetic over the z-ordered rectangles of one sample.
 * This is what lets a provider claim a REGION rather than a window (#66) and
 * what makes "drop candidates that are occluded" mean something ACROSS
 * surfaces, rather than only inside one.
 *
 * Lazy by design — computed at query time for the one surface a question is
 * about, never for all 21 windows of every 100 ms sample.
 */
export function visibleRegionOf(surfaces: readonly SurfaceInfo[], index: number): readonly Rect[] {
  const target = surfaces[index]
  if (target === undefined) return []
  let pieces: Rect[] = [target.bounds]
  for (const other of surfaces) {
    if (other === target) continue
    if (!other.visible || other.minimized) continue
    if (other.zOrder >= target.zOrder) continue
    if (target.display !== undefined && other.display !== undefined && other.display !== target.display) {
      continue
    }
    const next: Rect[] = []
    for (const piece of pieces) next.push(...subtractRect(piece, other.bounds))
    pieces = next
    if (pieces.length === 0) break
  }
  return pieces
}

/** `a` minus `b`, as up to four rectangles. Empty when `b` swallows `a`. */
export function subtractRect(a: Rect, b: Rect): Rect[] {
  const ax1 = a.x + a.width
  const ay1 = a.y + a.height
  const bx0 = Math.max(a.x, b.x)
  const by0 = Math.max(a.y, b.y)
  const bx1 = Math.min(ax1, b.x + b.width)
  const by1 = Math.min(ay1, b.y + b.height)
  // No overlap: `a` survives whole.
  if (bx1 <= bx0 || by1 <= by0) return [a]
  const out: Rect[] = []
  if (by0 > a.y) out.push({ x: a.x, y: a.y, width: a.width, height: by0 - a.y })
  if (by1 < ay1) out.push({ x: a.x, y: by1, width: a.width, height: ay1 - by1 })
  if (bx0 > a.x) out.push({ x: a.x, y: by0, width: bx0 - a.x, height: by1 - by0 })
  if (bx1 < ax1) out.push({ x: bx1, y: by0, width: ax1 - bx1, height: by1 - by0 })
  return out
}

/**
 * Whether a point of `surfaces[index]` is covered by a surface above it.
 *
 * The per-point form of visibleRegionOf, and far cheaper: a hit test never
 * needs the whole visible region, only whether THIS pixel survived.
 */
export function occludedAt(
  surfaces: readonly SurfaceInfo[],
  surfaceId: string,
  point: ScreenPoint,
): boolean {
  const target = surfaces.find((s) => s.surfaceId === surfaceId)
  if (target === undefined) return false
  for (const other of surfaces) {
    if (other.surfaceId === surfaceId) continue
    if (!other.visible || other.minimized) continue
    if (other.zOrder >= target.zOrder) continue
    if (target.display !== undefined && other.display !== undefined && other.display !== target.display) {
      continue
    }
    if (rectContains(other.bounds, point)) return true
  }
  return false
}
