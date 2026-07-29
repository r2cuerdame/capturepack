// The Platform Surface Timeline (issue #65) — Core's own record of the desktop's
// surface stack over time, on the same clock as the replay.
//
// IT ANSWERS EXACTLY ONE QUESTION: which top-level window was where, in what
// order, at time T. It is NOT a UI Automation provider and must not grow into
// one (#65). Core does not interpret an Unreal, a Unity or a UIA object tree —
// this file reads window geometry and nothing else.
//
// WHY CORE OWNS IT rather than a plugin: it is what makes provider arbitration
// possible at all (#66), and a plugin cannot be trusted with the answer that
// decides which plugin gets asked.
//
// IT RESTORES THE PAST DESKTOP, NEVER THE LIVE ONE. The resolver only ever reads
// this ring. The editor is itself a fullscreen window on the current desktop and
// would otherwise be the topmost surface at every point — a bug that writes
// itself. Two things enforce it: nothing here ever calls the OS, and a query
// against a frozen range is clamped to that range's end (see `SurfaceFreeze`).
//
// STORAGE — checkpoints plus deltas, in ONE BINARY ARENA (docs/temporal-protocol.md
// §4.2). This is not premature optimisation; it is the difference between
// shipping and not. GOAL.md "Capture must stay cheap" is the constraint that
// decides whether any of this ships, and the naive shape — one JS object per
// window per sample — costs ~200 bytes of object header and hidden class per
// window, i.e. 21 windows x 10 Hz x 30 s = 6300 objects and well over a megabyte
// of heap for a ring the binary encoding holds in ~45 KB. The measured desk also
// says why deltas: on an idle desktop ZERO windows change between two samples
// 100 ms apart, so a delta is a 4-byte marker and the ring costs nothing to hold.
//
// The record is 72 bytes per window per sample:
//
//   0  hwnd u64 | 8 ownerHwnd u64 | 16 pid u32 | 20 z u16 | 22 ordinal u16
//   24 flags u8 | 25 pad[3] | 28 windowRect 4xi32 | 44 clientRect 4xi32
//   60 titleId u32 | 64 classId u32 | 68 exeId u32
//
// (The design document's 60-byte layout predates two fields #65's issue body
// requires: `ownerHwnd` — "surface ownership" — and the identity `ordinal`
// below. 72 B x 21 windows = 1.5 KB per full sample; the arithmetic in §4.5
// moves from 37.8 KB to 45.4 KB of checkpoints for a 30 s ring, which is inside
// the same 512 KB ceiling by an order of magnitude.)

import type { Rect, SurfaceInfo, TemporalAccuracy } from '../../shared/context/protocol'

/** One window as the Context Host's lane S read it. The wire shape, decoded. */
export interface SurfaceSampleWindow {
  /** Decimal string: a Win64 HWND does not fit a JS number safely. */
  hwnd: string
  /** The owner window (a dialog's parent), "0" when there is none. */
  ownerHwnd: string
  processId: number
  zOrder: number
  /** DWM extended frame bounds, virtual-desktop physical pixels. */
  bounds: Rect
  clientBounds: Rect
  visible: boolean
  minimized: boolean
  foreground: boolean
  cloaked: boolean
  windowTitle: string
  className: string
  executableName: string
}

export interface SurfaceSample {
  /** Session-clock time (ms). */
  timeMs: number
  windows: SurfaceSampleWindow[]
}

/** A pinned range that pruning may not touch (#64 `onFreeze`, GAP 5 ref-counting). */
interface SurfaceFreeze {
  freezeId: string
  startMs: number
  endMs: number
}

const RECORD_BYTES = 72
const REMOVAL_BYTES = 8

const FLAG_VISIBLE = 1 << 0
const FLAG_MINIMIZED = 1 << 1
const FLAG_FOREGROUND = 1 << 2
const FLAG_CLOAKED = 1 << 3

/**
 * A full sample at least this often. Between checkpoints only the windows whose
 * 72 bytes changed are stored, so restoring at T is "nearest checkpoint at or
 * before T, then apply deltas forward" and never a walk from the start of the
 * session.
 */
const CHECKPOINT_INTERVAL_MS = 1_000

/**
 * Lane S's ceiling (docs/temporal-protocol.md §4.2). Measured behaviour puts the
 * real cost at 40–60 KB for a 30 s ring; this bounds the pathological desktop
 * (a window being dragged continuously across 300 samples) rather than the
 * ordinary one. Over it, RESOLUTION is dropped and never RANGE — see `degrade`.
 *
 * IT BOUNDS SAMPLES, AND ONLY SAMPLES — see `sampleBytesUsed` for why that
 * distinction had to be made explicit.
 */
const RING_BUDGET_BYTES = 512 * 1024

/** Rough per-sample bookkeeping cost, counted so `bytesUsed()` is not a lie. */
const SAMPLE_INDEX_BYTES = 96

/**
 * When the identity table is worth rebuilding from the records still alive.
 *
 * The table is append-only between rebuilds, so a window that retitles once a
 * second — a downloading browser, a media player, a terminal progress line —
 * adds an entry per second FOREVER, long after the sample that mentioned that
 * title was pruned. Measured on exactly that shape: the table alone reached
 * 1,551 KB, and every byte of it was unreachable from any live record.
 *
 * 64 KB is ~8x the measured ordinary need (393 distinct identity tuples across
 * 451 elements on the evidence packs, ~8 KB), so an ordinary desktop never pays
 * for the rebuild at all, and a churning one pays a walk over the live records
 * — a few thousand of them, microseconds — at most once per prune.
 */
const IDENTITY_COMPACT_BYTES = 64 * 1024

/**
 * Coarsest the governor may go: one stored sample per 25.6 s, checkpoints 256 s
 * apart. Reached only when the whole ring is pinned by an open editor AND the
 * desktop is changing continuously, i.e. when the alternative is unbounded
 * growth. Past this the ring is 24 windows x 72 B per 25.6 s ≈ 4 KB/minute,
 * which an all-day session can afford.
 */
const MAX_STRIDE = 256

interface RingSample {
  timeMs: number
  /** A checkpoint carries every window; a delta carries only what changed. */
  full: boolean
  offset: number
  count: number
  removedOffset: number
  removedCount: number
  /**
   * This interval was thinned by the memory governor. It is carried into
   * `TemporalAccuracy.coverage` so the editor can say "structural detail was
   * reduced here" instead of quietly serving something coarser than it claims.
   */
  degraded: boolean
}

/** What `SurfaceTimeline.stats()` reports — the numbers the governor acts on. */
export interface SurfaceTimelineStats {
  samples: number
  checkpoints: number
  bytes: number
  arenaBytes: number
  identityBytes: number
  wastedBytes: number
  degradedSamples: number
  droppedSamples: number
  /** 1 = every sample stored. Higher = the governor is coarsening (see `degrade`). */
  stride: number
  rangeStartMs: number
  rangeEndMs: number
}

/**
 * The ring. Append-only in time, pruned from the front, compacted when the dead
 * bytes at the front are worth the copy.
 */
export class SurfaceTimeline {
  private arena: Uint8Array
  private view: DataView
  private used = 0
  /** Bytes at the front of the arena no live sample references any more. */
  private dead = 0
  private readonly samples: RingSample[] = []

  /** Interned strings: title / class / executable, one table for the session. */
  private readonly strings: string[] = ['']
  private readonly stringIds = new Map<string, number>([['', 0]])
  private identityBytes = 0

  /**
   * Surface identity (docs/temporal-protocol.md §6): `surfaceId` is Core-minted
   * and stable across the session — hwnd + a creation ordinal — so a RECYCLED
   * HWND does not silently inherit a previous window's identity and a provider's
   * claim keyed on it stays valid across the ring. The ordinal is stored IN the
   * record, so decoding an old sample cannot pick up a newer generation's id.
   */
  private readonly generations = new Map<string, { ordinal: number; pid: number; classId: number }>()
  private nextOrdinal = 1

  /** hwnd -> byte offset of that window's most recent record. Diffing state only. */
  private readonly live = new Map<string, number>()
  private lastCheckpointMs = Number.NEGATIVE_INFINITY

  private readonly freezes: SurfaceFreeze[] = []
  /** True while `append` is mid-sample: the arena may grow but must not move (#85). */
  private writing = false
  private droppedSamples = 0
  /** Governor state: store one sample in `stride`, and mark the next one degraded. */
  private stride = 1
  private strideCounter = 0
  private pendingDegraded = false
  private readonly scratch = new Uint8Array(RECORD_BYTES)
  private readonly scratchView: DataView

  constructor(initialBytes = 64 * 1024) {
    this.arena = new Uint8Array(Math.max(RECORD_BYTES, initialBytes))
    this.view = new DataView(this.arena.buffer)
    this.scratchView = new DataView(this.scratch.buffer)
  }

  /** Oldest / newest time the ring can restore. Both 0 when it is empty. */
  rangeMs(): { startMs: number; endMs: number } {
    const first = this.samples[0]
    const last = this.samples[this.samples.length - 1]
    if (first === undefined || last === undefined) return { startMs: 0, endMs: 0 }
    return { startMs: first.timeMs, endMs: last.timeMs }
  }

  /**
   * Appends one lane S sample. Returns the bytes this sample actually cost,
   * which is what the governor and the report are measured in.
   */
  append(sample: SurfaceSample): number {
    const before = this.used
    // The checkpoint interval is scaled by the governor's stride. It has to be:
    // a checkpoint is a full copy of the state, so leaving it at 1 Hz while the
    // deltas around it are thinned 32:1 means the checkpoints ARE the ring, and
    // the ring keeps growing at 24 windows x 72 B every second no matter how
    // hard the governor coarsens. Measured before this was scaled: 5.0 MB
    // against a 512 KB ceiling.
    const forceCheckpoint =
      this.samples.length === 0 ||
      sample.timeMs - this.lastCheckpointMs >= CHECKPOINT_INTERVAL_MS * this.stride
    // Coarsened by the governor because the budget is full and nothing older can
    // be reclaimed (see `degrade`). Skipping a sample loses NO STATE: the diff
    // base is the last sample actually stored, so the next stored sample carries
    // everything that changed in between — it is time resolution that drops,
    // which is exactly what a provider over budget is required to drop.
    if (!forceCheckpoint && this.stride > 1) {
      this.strideCounter += 1
      if (this.strideCounter % this.stride !== 0) {
        this.pendingDegraded = true
        return 0
      }
    }
    const seen = new Set<string>()
    const changed: number[] = []

    // A SAMPLE'S RECORDS MUST NOT MOVE WHILE IT IS BEING WRITTEN (#85).
    //
    // `changed` collects arena addresses as each record is appended, and the
    // entry below stores only the FIRST of them because the run is contiguous.
    // Both facts stop being true if the arena compacts part way through this
    // loop: `compact` shifts every byte down and fixes up `samples` and `live`,
    // but it cannot fix up a local array it has never heard of. The addresses
    // gathered before the shift then point `dead` bytes too far along, and the
    // read walks off the end of the DataView.
    //
    // Measured: 60 windows all moving, an 8 KB arena, pruning throughout —
    // `RangeError: Offset is outside the bounds of the DataView`, which is
    // exactly what a 55-second capture on a real desktop produced from inside
    // the save path. It needs a desk's worth of windows to reach the end of the
    // arena mid-sample, which is why one to three windows never caught it.
    this.writing = true
    try {
      return this.appendSample(sample, seen, changed, forceCheckpoint, before)
    } finally {
      this.writing = false
    }
  }

  private appendSample(
    sample: SurfaceSample,
    seen: Set<string>,
    changed: number[],
    forceCheckpoint: boolean,
    before: number,
  ): number {
    for (const win of sample.windows) {
      seen.add(win.hwnd)
      this.encode(win)
      const previous = this.live.get(win.hwnd)
      const identical =
        !forceCheckpoint && previous !== undefined && this.sameAsStored(previous)
      if (identical) continue
      const offset = this.appendBytes(this.scratch)
      this.live.set(win.hwnd, offset)
      changed.push(offset)
    }

    // Gone windows. A checkpoint needs no removal list — it IS the whole state —
    // so removals are only ever written into a delta.
    const removed: string[] = []
    if (!forceCheckpoint) {
      for (const hwnd of this.live.keys()) {
        if (!seen.has(hwnd)) removed.push(hwnd)
      }
    }
    for (const hwnd of removed) this.live.delete(hwnd)
    if (forceCheckpoint) {
      for (const hwnd of [...this.live.keys()]) {
        if (!seen.has(hwnd)) this.live.delete(hwnd)
      }
    }

    // Removals are appended consecutively right after this sample's records, so
    // the first one's offset locates the whole run.
    const removals = new Uint8Array(removed.length * REMOVAL_BYTES)
    const removalView = new DataView(removals.buffer)
    removed.forEach((hwnd, i) => removalView.setBigUint64(i * REMOVAL_BYTES, toHandle(hwnd), true))
    const removedOffset = removed.length === 0 ? this.used : this.appendBytes(removals)

    // A checkpoint's records are contiguous by construction (nothing else is
    // written between them); a delta's are too. `offset` is the first one.
    const first = changed[0]
    const entry: RingSample = {
      timeMs: sample.timeMs,
      full: forceCheckpoint,
      offset: first ?? this.used,
      count: changed.length,
      removedOffset,
      removedCount: removed.length,
      // Any sample that closes a gap the governor opened carries the mark, so
      // `coverage: "degraded"` reaches the editor instead of a silently coarser
      // answer that still claims to be covered.
      degraded: this.pendingDegraded,
    }
    this.pendingDegraded = false
    this.samples.push(entry)
    if (forceCheckpoint) this.lastCheckpointMs = sample.timeMs
    this.enforceBudget()
    return this.used - before
  }

  /**
   * Drops everything before `beforeTimeMs`, keeping the last checkpoint still
   * needed to restore what remains (#64 `onPrune` — a provider that drops that
   * checkpoint has dropped RANGE, not resolution).
   *
   * A FROZEN RANGE IS NEVER PRUNED (GAP 5). `onFreeze` pins the captured range
   * "until the editor closes or the pack is saved", and several editors can hold
   * overlapping ranges at once — a capture plus a pack re-opened from History.
   */
  prune(beforeTimeMs: number): void {
    // Pressure is off — full resolution comes back. Without this, one long
    // editor session would leave the ring coarse for the rest of the run, and
    // the degradation would outlive the reason for it.
    //
    // Tested against SAMPLE bytes, not the total: the identity table is not a
    // thing `degrade()` can shrink, so including it here made the gate testable
    // only by a number the governor could not move — which is how title churn
    // used to pin `stride` at MAX_STRIDE permanently. See `sampleBytesUsed`.
    if (this.stride > 1 && this.sampleBytesUsed() < RING_BUDGET_BYTES / 2) {
      this.stride = 1
      this.strideCounter = 0
    }
    const floor = this.freezes.reduce(
      (limit, freeze) => Math.min(limit, freeze.startMs),
      beforeTimeMs,
    )
    let keepFrom = 0
    for (let i = 0; i < this.samples.length; i += 1) {
      const sample = this.samples[i]
      if (sample === undefined) break
      if (sample.timeMs > floor) break
      // The last checkpoint at or before the floor is the one that still has to
      // be there to restore the first surviving delta.
      if (sample.full) keepFrom = i
    }
    if (keepFrom <= 0) return
    const dropped = this.samples.splice(0, keepFrom)
    this.droppedSamples += dropped.length
    const firstKept = this.samples[0]
    if (firstKept !== undefined) this.dead = firstKept.offset
    this.compactIfWorthwhile()
    // Records just died, so strings only they referenced did too. This is the
    // only place they can be reclaimed — see `compactStrings`.
    this.compactStringsIfWorthwhile()
  }

  /** Pins a range (#64 `onFreeze`). Ref-counted by id; `release` is the other half. */
  freeze(freezeId: string, startMs: number, endMs: number): void {
    if (this.freezes.some((f) => f.freezeId === freezeId)) return
    this.freezes.push({ freezeId, startMs, endMs })
  }

  release(freezeId: string): void {
    const index = this.freezes.findIndex((f) => f.freezeId === freezeId)
    if (index >= 0) this.freezes.splice(index, 1)
  }

  /**
   * The whole surface stack as it was at `timeMs`, topmost first.
   *
   * `notAfterMs` is the structural half of "the past desktop, never the live
   * one": a query inside a frozen range is clamped to that range's end, so a
   * sample taken after the capture — one that contains the EDITOR's own
   * fullscreen window — can never be returned no matter what time is asked for.
   */
  restoreAt(timeMs: number, notAfterMs?: number): { surfaces: SurfaceInfo[]; accuracy: TemporalAccuracy } {
    const ceiling = notAfterMs === undefined ? timeMs : Math.min(timeMs, notAfterMs)
    const index = this.indexAtOrBefore(ceiling)
    if (index < 0) {
      return { surfaces: [], accuracy: this.accuracyFor(timeMs, null, false) }
    }
    const sample = this.samples[index]
    if (sample === undefined) {
      return { surfaces: [], accuracy: this.accuracyFor(timeMs, null, false) }
    }
    // Back to the covering checkpoint, then forward through the deltas.
    let start = index
    while (start > 0) {
      const candidate = this.samples[start]
      if (candidate !== undefined && candidate.full) break
      start -= 1
    }
    const state = new Map<string, number>()
    let degraded = false
    for (let i = start; i <= index; i += 1) {
      const step = this.samples[i]
      if (step === undefined) continue
      if (step.degraded) degraded = true
      if (step.full) state.clear()
      for (let r = 0; r < step.count; r += 1) {
        const offset = step.offset + r * RECORD_BYTES
        state.set(this.handleAt(offset), offset)
      }
      for (let r = 0; r < step.removedCount; r += 1) {
        const at = step.removedOffset + r * REMOVAL_BYTES
        state.delete(String(this.view.getBigUint64(at, true)))
      }
    }
    const surfaces = [...state.values()]
      .map((offset) => this.decode(offset))
      .sort((a, b) => a.zOrder - b.zOrder)
    return { surfaces, accuracy: this.accuracyFor(timeMs, sample.timeMs, degraded) }
  }

  /**
   * #65's one question, as a call: the stack under a point at a time, topmost
   * first, each surface carrying the part of itself nothing above it covers.
   *
   * `visibleRegion` is computed HERE and not stored: it is subtractive rectangle
   * arithmetic over at most a couple of dozen windows, so recomputing it per
   * query is cheaper than carrying it in the ring — and it can only be computed
   * once the whole stack at that instant is known anyway.
   */
  stackAt(
    timeMs: number,
    point: { x: number; y: number },
    notAfterMs?: number,
  ): { surfaces: SurfaceInfo[]; accuracy: TemporalAccuracy } {
    const restored = this.restoreAt(timeMs, notAfterMs)
    const onScreen = restored.surfaces.filter(isOnScreen)
    const hit: SurfaceInfo[] = []
    for (let i = 0; i < onScreen.length; i += 1) {
      const surface = onScreen[i]
      if (surface === undefined) continue
      if (!containsPoint(surface.bounds, point.x, point.y)) continue
      const above = onScreen.slice(0, i).map((s) => s.bounds)
      hit.push({ ...surface, visibleRegion: subtractAll(surface.bounds, above) })
    }
    return { surfaces: hit, accuracy: restored.accuracy }
  }

  /** Every surface at a time, with its visible region. Used by claim attribution (#66). */
  surfacesAt(timeMs: number, notAfterMs?: number): { surfaces: SurfaceInfo[]; accuracy: TemporalAccuracy } {
    const restored = this.restoreAt(timeMs, notAfterMs)
    const onScreen = restored.surfaces.filter(isOnScreen)
    const withRegions = onScreen.map((surface, i) => ({
      ...surface,
      visibleRegion: subtractAll(
        surface.bounds,
        onScreen.slice(0, i).map((s) => s.bounds),
      ),
    }))
    return { surfaces: withRegions, accuracy: restored.accuracy }
  }

  /**
   * The times this ring ACTUALLY SAMPLED inside a range, ascending (#87).
   *
   * Read back through these instead of a grid of the reader's own invention and
   * nothing is interpolated on the way out: every observation the editor adopts
   * corresponds to a moment Core really looked. A grid can only ever land
   * between two samples and ask for a rectangle that was never observed.
   */
  sampleTimesBetween(startMs: number, endMs: number): number[] {
    const out: number[] = []
    for (const sample of this.samples) {
      if (sample.timeMs < startMs) continue
      if (sample.timeMs > endMs) break
      out.push(sample.timeMs)
    }
    return out
  }

  stats(): SurfaceTimelineStats {
    const range = this.rangeMs()
    return {
      samples: this.samples.length,
      checkpoints: this.samples.filter((s) => s.full).length,
      bytes: this.bytesUsed(),
      arenaBytes: this.used - this.dead,
      identityBytes: this.identityBytes,
      wastedBytes: this.dead,
      degradedSamples: this.samples.filter((s) => s.degraded).length,
      droppedSamples: this.droppedSamples,
      stride: this.stride,
      rangeStartMs: range.startMs,
      rangeEndMs: range.endMs,
    }
  }

  /**
   * EVERYTHING THIS RING HOLDS — records, index and identity table. This is the
   * honest total, and it is what `stats()` reports and what lane S acks to the
   * Provider Host as `bytes`. It is deliberately NOT what the governor steers
   * on; see below.
   */
  bytesUsed(): number {
    return (
      this.used - this.dead + this.identityBytes + this.samples.length * SAMPLE_INDEX_BYTES
    )
  }

  /**
   * WHAT THE GOVERNOR CAN ACTUALLY SHRINK, and therefore the only thing it is
   * allowed to steer on.
   *
   * THE BUG THIS SEPARATION FIXES. `enforceBudget()` used to compare the TOTAL
   * against the 512 KB ceiling, and `prune()`'s recovery gate compared the same
   * total against half of it. But every lever `degrade()` has — thin a delta,
   * drop the oldest checkpoint interval, double `stride` — moves SAMPLE bytes
   * and cannot free one byte of the identity table. So a control loop whose
   * input included a number it had no authority over could only ratchet.
   *
   * Measured, on one window retitling once per second (a downloading browser, a
   * media player, a terminal progress line): the ring reached 1,551 KB against
   * the 512 KB ceiling, sampling collapsed from 10 Hz to about 1 Hz, and it
   * NEVER RECOVERED once the churn stopped — the recovery gate was testing the
   * same permanently inflated number, so `stride` climbed to MAX_STRIDE = 256
   * and stayed there for the rest of the run.
   *
   * The identity table is not unwatched as a result: it is bounded by
   * `compactStrings()`, which reclaims it, and it stays inside `bytesUsed()`
   * above so nothing upstream is told a smaller number than the truth.
   */
  private sampleBytesUsed(): number {
    return this.used - this.dead + this.samples.length * SAMPLE_INDEX_BYTES
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private accuracyFor(
    requestedTimeMs: number,
    materializedTimeMs: number | null,
    degraded: boolean,
  ): TemporalAccuracy {
    if (materializedTimeMs === null) {
      const range = this.rangeMs()
      // "Before the ring started" and "pruned away" are different answers and
      // the editor treats them differently (GAP 16): one means the app had not
      // been running long enough, the other means retention dropped it.
      const coverage =
        this.samples.length === 0
          ? 'none'
          : requestedTimeMs < range.startMs
            ? 'pruned'
            : 'before-start'
      return {
        requestedTimeMs,
        materializedTimeMs: requestedTimeMs,
        errorMs: Number.POSITIVE_INFINITY,
        exact: false,
        coverage,
      }
    }
    const errorMs = Math.abs(requestedTimeMs - materializedTimeMs)
    return {
      requestedTimeMs,
      materializedTimeMs,
      errorMs,
      // Sub-millisecond is the sample's own resolution; claiming "exact" for
      // anything coarser is the lie TemporalAccuracy exists to prevent.
      exact: errorMs < 1,
      // A nearest sample further away than the CHECKPOINT interval means
      // sampling was interrupted — the host died and was restarted (measured:
      // a 1.35 s gap), the machine slept, or the governor coarsened the ring.
      // Reporting that as plainly "covered" with a large errorMs would be true
      // and still misleading: the consumer's staleness rule keys on coverage,
      // and an interrupted interval is exactly what it exists to catch.
      coverage: degraded || errorMs > CHECKPOINT_INTERVAL_MS ? 'degraded' : 'covered',
    }
  }

  private indexAtOrBefore(timeMs: number): number {
    let low = 0
    let high = this.samples.length - 1
    let found = -1
    while (low <= high) {
      const mid = (low + high) >> 1
      const sample = this.samples[mid]
      if (sample === undefined) break
      if (sample.timeMs <= timeMs) {
        found = mid
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
    return found
  }

  private encode(win: SurfaceSampleWindow): void {
    const view = this.scratchView
    const classId = this.intern(win.className)
    const generation = this.generationOf(win.hwnd, win.processId, classId)
    view.setBigUint64(0, toHandle(win.hwnd), true)
    view.setBigUint64(8, toHandle(win.ownerHwnd), true)
    view.setUint32(16, win.processId >>> 0, true)
    view.setUint16(20, Math.min(0xffff, Math.max(0, win.zOrder)), true)
    view.setUint16(22, generation, true)
    view.setUint8(
      24,
      (win.visible ? FLAG_VISIBLE : 0) |
        (win.minimized ? FLAG_MINIMIZED : 0) |
        (win.foreground ? FLAG_FOREGROUND : 0) |
        (win.cloaked ? FLAG_CLOAKED : 0),
    )
    view.setUint8(25, 0)
    view.setUint16(26, 0, true)
    writeRect(view, 28, win.bounds)
    writeRect(view, 44, win.clientBounds)
    view.setUint32(60, this.intern(win.windowTitle), true)
    view.setUint32(64, classId, true)
    view.setUint32(68, this.intern(win.executableName), true)
  }

  private decode(offset: number): SurfaceInfo {
    const view = this.view
    const hwnd = String(view.getBigUint64(offset, true))
    const owner = view.getBigUint64(offset + 8, true)
    const flags = view.getUint8(offset + 24)
    const ordinal = view.getUint16(offset + 22, true)
    const info: SurfaceInfo = {
      surfaceId: surfaceIdOf(hwnd, ordinal),
      hwnd,
      processId: view.getUint32(offset + 16, true),
      bounds: readRect(view, offset + 28),
      clientBounds: readRect(view, offset + 44),
      zOrder: view.getUint16(offset + 20, true),
      visible: (flags & FLAG_VISIBLE) !== 0,
      minimized: (flags & FLAG_MINIMIZED) !== 0,
      foreground: (flags & FLAG_FOREGROUND) !== 0,
      cloaked: (flags & FLAG_CLOAKED) !== 0,
      windowTitle: this.stringAt(view.getUint32(offset + 60, true)),
      className: this.stringAt(view.getUint32(offset + 64, true)),
      executableName: this.stringAt(view.getUint32(offset + 68, true)),
    }
    if (owner !== 0n) {
      // The owner's own generation is not stored on the owned window (it would
      // have to be re-read at decode time from a table that may have moved on),
      // so ownership resolves to the owner's CURRENT generation. That is right
      // for every query inside one ring: an HWND cannot be recycled while a
      // window it owns is still alive.
      const ownerHwnd = String(owner)
      const generation = this.generations.get(ownerHwnd)
      info.ownerSurfaceId = surfaceIdOf(ownerHwnd, generation?.ordinal ?? 0)
    }
    return info
  }

  private generationOf(hwnd: string, pid: number, classId: number): number {
    const existing = this.generations.get(hwnd)
    if (existing !== undefined && existing.pid === pid && existing.classId === classId) {
      return existing.ordinal
    }
    // A handle that comes back with a DIFFERENT process or window class is a
    // recycled HWND, not the same window — the one case where reusing an id
    // would hand a provider's claim to a stranger. Anything else (a retitled
    // window, a moved one) keeps its identity.
    const ordinal = this.nextOrdinal
    this.nextOrdinal = (this.nextOrdinal + 1) & 0xffff
    if (this.nextOrdinal === 0) this.nextOrdinal = 1
    this.generations.set(hwnd, { ordinal, pid, classId })
    return ordinal
  }

  private handleAt(offset: number): string {
    return String(this.view.getBigUint64(offset, true))
  }

  private sameAsStored(offset: number): boolean {
    for (let i = 0; i < RECORD_BYTES; i += 1) {
      if (this.arena[offset + i] !== this.scratch[i]) return false
    }
    return true
  }

  private appendBytes(bytes: Uint8Array): number {
    this.ensure(bytes.length)
    const offset = this.used
    this.arena.set(bytes, offset)
    this.used += bytes.length
    return offset
  }

  private ensure(extra: number): void {
    if (this.used + extra <= this.arena.length) return
    // Compaction first: a ring that has been pruned is mostly dead bytes at the
    // front, and growing before reclaiming them would double the footprint of a
    // buffer that is not actually getting bigger.
    //
    // NEVER MID-SAMPLE though (#85, see `append`). Growing keeps every existing
    // address valid; compacting does not, and a sample being written is holding
    // addresses this class cannot reach. The dead bytes are not lost — the next
    // prune's `compactIfWorthwhile` reclaims them, one sample later.
    if (this.dead > 0 && !this.writing) this.compact()
    if (this.used + extra <= this.arena.length) return
    let next = this.arena.length * 2
    while (next < this.used + extra) next *= 2
    const grown = new Uint8Array(next)
    grown.set(this.arena.subarray(0, this.used))
    this.arena = grown
    this.view = new DataView(this.arena.buffer)
  }

  private compactIfWorthwhile(): void {
    // A copy is cheap (tens of KB) but not free, and doing it on every prune
    // would memcpy the whole ring ten times a second for nothing.
    if (this.dead > this.arena.length / 4) this.compact()
  }

  private compact(): void {
    if (this.dead === 0) return
    const shift = this.dead
    this.arena.copyWithin(0, shift, this.used)
    this.used -= shift
    this.dead = 0
    for (const sample of this.samples) {
      sample.offset -= shift
      sample.removedOffset -= shift
    }
    for (const [hwnd, offset] of this.live) {
      // A live record that was pruned away is no longer a valid diff base, so
      // the next sample re-writes that window in full. Dropping it here is what
      // makes that automatic.
      if (offset < shift) this.live.delete(hwnd)
      else this.live.set(hwnd, offset - shift)
    }
  }

  /**
   * The memory governor for lane S (GAP 4): over budget, DROP RESOLUTION AND
   * NEVER RANGE, and mark what was thinned so `TemporalAccuracy` stays truthful.
   */
  private enforceBudget(): void {
    if (this.sampleBytesUsed() <= RING_BUDGET_BYTES) return
    this.degrade()
  }

  private degrade(): void {
    // Thin the OLDEST non-checkpoint samples: the newest part of the ring is
    // what a user is most likely to scrub to, and range is preserved either way
    // because the checkpoints stay. Each surviving neighbour is marked degraded,
    // which is what turns into `coverage: "degraded"` at query time.
    let removed = 0
    for (let i = 1; i < this.samples.length - 1 && removed < 32; i += 1) {
      const sample = this.samples[i]
      const next = this.samples[i + 1]
      if (sample === undefined || next === undefined) continue
      if (sample.full) continue
      // Merging a delta into its successor would need a re-encode; dropping it
      // outright would lose the changes it carried. Both are wrong. Instead the
      // delta's records are handed to the NEXT sample, which is exactly what
      // "coarser resolution" means: two 100 ms steps become one 200 ms step.
      if (next.count === 0 && next.removedCount === 0) {
        next.offset = sample.offset
        next.count = sample.count
        next.removedOffset = sample.removedOffset
        next.removedCount = sample.removedCount
      } else if (sample.count > 0 || sample.removedCount > 0) {
        // The successor already carries changes of its own and the two record
        // runs are not contiguous, so they cannot be merged by offset. Keep this
        // sample; thinning it would lose state.
        continue
      }
      next.degraded = true
      this.samples.splice(i, 1)
      removed += 1
      i -= 1
    }
    if (removed > 0) return
    // Nothing could be thinned (every sample carries changes). Next best is to
    // give up the OLDEST checkpoint interval — the ring's start moves forward,
    // which `rangeMs()` reports and `accuracyFor` turns into "pruned".
    //
    // A FROZEN RANGE IS STILL OFF LIMITS (#64 `onFreeze`). A pin means "this
    // range survives until the editor closes"; a governor that ate it would make
    // the promise conditional on how long the user left the editor open, which
    // is exactly the kind of quiet conditional this project keeps removing.
    const floor = this.freezes.reduce(
      (limit, freeze) => Math.min(limit, freeze.startMs),
      Number.POSITIVE_INFINITY,
    )
    const secondCheckpoint = this.samples.findIndex(
      (s, i) => i > 0 && s.full && s.timeMs <= floor,
    )
    if (secondCheckpoint > 0) {
      const dropped = this.samples.splice(0, secondCheckpoint)
      this.droppedSamples += dropped.length
      const firstKept = this.samples[0]
      if (firstKept !== undefined) this.dead = firstKept.offset
      this.compactIfWorthwhile()
      return
    }
    // Everything left is pinned — an editor held open over a busy desktop. The
    // only lever that does not break the range promise is to stop recording
    // every sample: RESOLUTION, NEVER RANGE. Note what this does NOT touch: the
    // pinned range was recorded before the pressure and keeps the resolution it
    // was recorded at, so the answers the open editor is actually asking for do
    // not degrade — only the live tail behind it does.
    if (this.stride < MAX_STRIDE) this.stride *= 2
  }

  /**
   * Every offset in the arena that a live 72-byte record starts at.
   *
   * Two sources, deduplicated, because they can name the same record: a sample's
   * record run, and `live`, which holds the most recent record per hwnd as the
   * diff base for the next sample. Rewriting one record twice would remap its
   * ids twice and corrupt them, which is the whole reason this returns a Set
   * rather than being folded into the two loops that need it.
   */
  private liveRecordOffsets(): Set<number> {
    const offsets = new Set<number>()
    for (const sample of this.samples) {
      for (let i = 0; i < sample.count; i += 1) offsets.add(sample.offset + i * RECORD_BYTES)
    }
    for (const offset of this.live.values()) offsets.add(offset)
    return offsets
  }

  private compactStringsIfWorthwhile(): void {
    if (this.identityBytes <= IDENTITY_COMPACT_BYTES) return
    this.compactStrings()
  }

  /**
   * REBUILDS THE IDENTITY TABLE FROM WHAT IS STILL REACHABLE.
   *
   * `intern()` is append-only, so the table accumulates every title a window has
   * ever had. Pruning a sample drops its records but left its strings behind
   * forever: measured at 1,551 KB for one window retitling once a second, none
   * of it reachable. This is the collector for that.
   *
   * The roots are the three id fields of every live record, plus the `classId`
   * held in `generations` — that map outlives the records it was minted from,
   * and dropping a class name still referenced by it would make a later
   * recycled-HWND comparison read the wrong string and mint a NEW surface id for
   * a window that never changed. A stable `surfaceId` is what a provider's claim
   * is keyed on (§6), so that would hand a claim to a stranger.
   *
   * Ids are renumbered, so every root is rewritten in place. Id 0 is the empty
   * string and stays 0 — `stringAt` falls back to it, and a decoded record with
   * a title that was never set must keep reading as "" and not as whatever
   * landed in slot 0 after a rebuild.
   */
  private compactStrings(): void {
    const view = this.view
    const records = this.liveRecordOffsets()
    const reachable = new Set<number>([0])
    for (const offset of records) {
      reachable.add(view.getUint32(offset + 60, true))
      reachable.add(view.getUint32(offset + 64, true))
      reachable.add(view.getUint32(offset + 68, true))
    }
    for (const generation of this.generations.values()) reachable.add(generation.classId)
    if (reachable.size >= this.strings.length) return

    // Ascending, so the rebuilt table keeps the order it was interned in and the
    // rebuild is deterministic — a table that reshuffled on every collection
    // would make a bug here reproduce only sometimes.
    const remap = new Map<number, number>([[0, 0]])
    const kept: string[] = ['']
    let bytes = 0
    for (const id of [...reachable].sort((a, b) => a - b)) {
      if (id === 0) continue
      const text = this.strings[id]
      if (text === undefined) continue
      remap.set(id, kept.length)
      kept.push(text)
      bytes += text.length * 2 + 48
    }
    const to = (id: number): number => remap.get(id) ?? 0
    for (const offset of records) {
      view.setUint32(offset + 60, to(view.getUint32(offset + 60, true)), true)
      view.setUint32(offset + 64, to(view.getUint32(offset + 64, true)), true)
      view.setUint32(offset + 68, to(view.getUint32(offset + 68, true)), true)
    }
    for (const [hwnd, generation] of this.generations) {
      this.generations.set(hwnd, { ...generation, classId: to(generation.classId) })
    }
    this.strings.length = 0
    this.strings.push(...kept)
    this.stringIds.clear()
    kept.forEach((text, id) => {
      // First id wins, so a duplicate string (impossible via `intern`, but a
      // rebuild must not depend on that) cannot leave a dangling second entry.
      if (!this.stringIds.has(text)) this.stringIds.set(text, id)
    })
    this.identityBytes = bytes
  }

  private intern(text: string): number {
    const existing = this.stringIds.get(text)
    if (existing !== undefined) return existing
    const id = this.strings.length
    this.strings.push(text)
    this.stringIds.set(text, id)
    // UTF-16 payload plus a rough per-entry cost for the two containers. The
    // table is interned ONCE PER SESSION, not per checkpoint, which is what
    // keeps it in the tens of KB (measured: 393 distinct identity tuples across
    // 451 elements on the evidence packs).
    this.identityBytes += text.length * 2 + 48
    return id
  }

  private stringAt(id: number): string {
    return this.strings[id] ?? ''
  }
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * On screen at all: visible, not minimized, not cloaked onto another virtual
 * desktop, and with a real rectangle. A window failing this is still IN the ring
 * (the record is the record) and simply cannot be under a cursor.
 */
function isOnScreen(surface: SurfaceInfo): boolean {
  return (
    surface.visible &&
    !surface.minimized &&
    surface.cloaked !== true &&
    surface.bounds.width > 0 &&
    surface.bounds.height > 0
  )
}

export function containsPoint(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height
}

/**
 * `rect` minus every rectangle in `covers` — the part of a window nothing above
 * it hides. Subtracting one rectangle from another yields at most four pieces
 * (above, below, left, right of the overlap), and the pieces are then subtracted
 * in turn.
 *
 * Cost is O(pieces x covers) and the piece count stays small on a real desk (a
 * window is normally covered by nothing or by one thing). The guard below stops
 * a pathological stack from turning a hover into a geometry solver.
 */
export function subtractAll(rect: Rect, covers: readonly Rect[]): Rect[] {
  let pieces: Rect[] = [rect]
  for (const cover of covers) {
    if (pieces.length === 0) break
    const next: Rect[] = []
    for (const piece of pieces) {
      for (const part of subtract(piece, cover)) next.push(part)
    }
    // 64 pieces is far past any real window arrangement; past it the honest
    // answer is the uncut rectangle rather than an unbounded amount of work.
    if (next.length > 64) return [rect]
    pieces = next
  }
  return pieces
}

function subtract(rect: Rect, cover: Rect): Rect[] {
  const left = Math.max(rect.x, cover.x)
  const top = Math.max(rect.y, cover.y)
  const right = Math.min(rect.x + rect.width, cover.x + cover.width)
  const bottom = Math.min(rect.y + rect.height, cover.y + cover.height)
  if (right <= left || bottom <= top) return [rect]
  const out: Rect[] = []
  if (top > rect.y) out.push({ x: rect.x, y: rect.y, width: rect.width, height: top - rect.y })
  if (bottom < rect.y + rect.height) {
    out.push({ x: rect.x, y: bottom, width: rect.width, height: rect.y + rect.height - bottom })
  }
  if (left > rect.x) out.push({ x: rect.x, y: top, width: left - rect.x, height: bottom - top })
  if (right < rect.x + rect.width) {
    out.push({ x: right, y: top, width: rect.x + rect.width - right, height: bottom - top })
  }
  return out
}

function writeRect(view: DataView, offset: number, rect: Rect): void {
  view.setInt32(offset, Math.round(rect.x) | 0, true)
  view.setInt32(offset + 4, Math.round(rect.y) | 0, true)
  view.setInt32(offset + 8, Math.round(rect.width) | 0, true)
  view.setInt32(offset + 12, Math.round(rect.height) | 0, true)
}

function readRect(view: DataView, offset: number): Rect {
  return {
    x: view.getInt32(offset, true),
    y: view.getInt32(offset + 4, true),
    width: view.getInt32(offset + 8, true),
    height: view.getInt32(offset + 12, true),
  }
}

function toHandle(value: string): bigint {
  try {
    const parsed = BigInt(value)
    return parsed < 0n ? 0n : parsed
  } catch {
    // A handle we cannot parse is not a handle. 0 is the "no window" value the
    // owner field already uses, and a record keyed on it simply never matches.
    return 0n
  }
}

function surfaceIdOf(hwnd: string, ordinal: number): string {
  return `s${hwnd}.${ordinal}`
}
