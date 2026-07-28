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

// ---------------------------------------------------------------------------
// BETWEEN TWO SAMPLES, A WINDOW IS STILL SOMEWHERE (#83).
//
// The ring is written at 10 Hz. Nearest-sample restore therefore answers on a
// 100 ms grid, and under a dragged window every millisecond of that grid is
// pixels: a fast drag across a 4K screen runs about 2500 px/s, so half a grid
// step is ~125 px of error and a full one is ~250 px.
//
// MEASURED in 0.2.0-rc.5, after #81 had aligned the question to the frame on
// screen: the five picked boxes in CapturePack_2026-07-29_004126 still missed
// their window by -151, -293, -26, -236 and -33 px. The two small ones are the
// times that happened to land near a sample; the three large ones are the grid.
//
// So interpolate. A window that is at A at t1 and at B at t2 was, if it was
// being dragged, somewhere on the line between them — and the straight line is
// a far better estimate than either endpoint.
//
// EXCEPT WHEN IT JUMPED. Snap-to-edge, maximise, restore and a move between
// monitors are instantaneous: the window is at A, then at B, and never once at
// the midpoint. There, nearest is RIGHT half the time and interpolation is
// WRONG all of the time. The guards below exist to keep the estimate on motion
// that was actually continuous, and every one of them fails safe to nearest.
// ---------------------------------------------------------------------------

/**
 * How far apart two samples may be and still be joined by a straight line.
 *
 * Two and a half grid steps. Wide enough to bridge a sample the ring dropped
 * under load, narrow enough that a window cannot have been dragged somewhere,
 * stopped, and dragged back inside the gap.
 */
const MAX_INTERPOLATION_GAP_MS = 250

/**
 * The furthest a window may move between two samples and still be treated as
 * having travelled continuously, as a fraction of its own width.
 *
 * A drag moves a window by a fraction of itself per 100 ms; a snap throws it
 * most of a screen. This separates the two without needing to know the screen
 * size, and a window dragged faster than this simply falls back to nearest —
 * which is what the code did before interpolation existed.
 */
const MAX_CONTINUOUS_TRAVEL = 0.5

export interface RestoredSurfaces {
  /** The OBSERVATION this restore is based on — the nearest one actually taken. */
  sample: SurfaceSample | null
  /**
   * Where things were at the REQUESTED time: `sample.surfaces`, with any surface
   * that can be shown to have moved continuously advanced along its path (#83).
   *
   * Separate from `sample` on purpose. `sample.tMs` says when Core actually
   * looked, which is what a coverage verdict and an observation lookup need;
   * these rectangles say where the user would have seen the window. Collapsing
   * the two would make one of those questions unanswerable.
   */
  surfaces: readonly SurfaceInfo[]
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
      return {
        sample: null,
        surfaces: [],
        accuracy: accuracyAt(timeMs, null, this.kind, this.range),
      }
    }
    const estimated = this.estimateAt(timeMs, sample)
    return {
      sample,
      surfaces: estimated.surfaces,
      accuracy: {
        ...accuracyAt(timeMs, sample.tMs, this.kind, this.range, stalenessCeilingMs),
        ...(estimated.interpolated ? { interpolated: true } : {}),
      },
    }
  }

  /**
   * `sample`'s surfaces, advanced to `timeMs` wherever that can be justified.
   *
   * Every surface is carried over unchanged by default. One is moved only when
   * the pair of samples bracketing `timeMs` both hold it, at the same size,
   * close enough together in time, and no further apart in space than a drag
   * could account for — see the constants above for why each of those is there.
   */
  private estimateAt(
    timeMs: number,
    sample: SurfaceSample,
  ): { surfaces: readonly SurfaceInfo[]; interpolated: boolean } {
    const [before, after] = this.bracket(timeMs)
    if (before === null || after === null) return { surfaces: sample.surfaces, interpolated: false }
    const span = after.tMs - before.tMs
    if (span <= 0 || span > MAX_INTERPOLATION_GAP_MS) {
      return { surfaces: sample.surfaces, interpolated: false }
    }
    const ratio = (timeMs - before.tMs) / span
    const byId = new Map(after.surfaces.map((s) => [s.surfaceId, s]))
    let interpolated = false
    const surfaces = sample.surfaces.map((current) => {
      const start = before.surfaces.find((s) => s.surfaceId === current.surfaceId)
      const end = byId.get(current.surfaceId)
      if (start === undefined || end === undefined) return current
      // A resize is not a translation, and a maximise is not a resize. Only a
      // window that kept its shape is known to have merely moved.
      if (start.bounds.width !== end.bounds.width || start.bounds.height !== end.bounds.height) {
        return current
      }
      const dx = end.bounds.x - start.bounds.x
      const dy = end.bounds.y - start.bounds.y
      if (dx === 0 && dy === 0) return current
      const reach = Math.max(1, start.bounds.width) * MAX_CONTINUOUS_TRAVEL
      if (Math.abs(dx) > reach || Math.abs(dy) > reach) return current
      const x = Math.round(start.bounds.x + dx * ratio)
      const y = Math.round(start.bounds.y + dy * ratio)
      // Landing back on the observation is not an estimate. A time exactly on a
      // sample takes this path (ratio 0), and flagging it would tell every
      // reader that a measured rectangle was guessed at.
      if (x === current.bounds.x && y === current.bounds.y) return current
      interpolated = true
      return { ...current, bounds: { ...current.bounds, x, y } }
    })
    return { surfaces, interpolated }
  }

  /** The samples immediately at-or-before and at-or-after `timeMs`. */
  private bracket(timeMs: number): [SurfaceSample | null, SurfaceSample | null] {
    let before: SurfaceSample | null = null
    let after: SurfaceSample | null = null
    for (const sample of this.samples) {
      if (sample.tMs <= timeMs) before = sample
      else {
        after = sample
        break
      }
    }
    return [before, after]
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
