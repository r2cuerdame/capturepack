// `input.*` timeline events (issue #12, SPEC §10.2) — the mouse and the
// windows, DERIVED from observations Core already takes.
//
// WHY THE NAMESPACE IS HALF-IMPLEMENTED, since the next person will ask.
//
// SPEC §10.2 reserved `input.*` in 0.1.0 with "writers MUST NOT emit them yet".
// 0.8.0 lifts that for the mouse and the window and LEAVES IT STANDING for the
// keyboard, and the rule that decides each one is the same rule GOAL.md already
// wrote for the DOM walker:
//
//   "snapshot.png already contains every pixel the user could see, so recording
//    the visible text adds no exposure the pack did not already have. A
//    typed-but-unsubmitted password ... [is] something the picture does NOT
//    contain."
//
// Read as a test, it answers all three:
//
//   * The cursor and the effect of its clicks are IN the replay — the recorder
//     draws the pointer, and the click's consequence is the next frame. RECORD.
//   * Window focus, position and size are in the replay AND already in Core's
//     surface ring, sampled 20-45 times a second for the whole retention.
//     RECORD.
//   * A keystroke is not. A password field renders dots; the key is not in the
//     picture, and it is the exact case the DOM walker already refuses
//     `type="password"` for. REFUSE.
//
// And the practical half agrees with the privacy half. The mouse and the
// windows come from a loop this app already runs; a key would need a global
// low-level keyboard hook (WH_KEYBOARD_LL), which in a screen-capture tool is
// the shape of a keylogger — flagged by antivirus, taken on trust by everyone
// who reads the source — for the least valuable of the three. `input.key.*`
// therefore stays reserved and unemitted, and `check:input-events` is what
// stops that from quietly becoming untrue.
//
// WHAT IS OBSERVED, AND WHAT IS NEVER INFERRED. Every event here is a
// difference between two readings that really happened. Nothing is
// interpolated, nothing is smoothed, and a value nobody measured is never
// reported as a value (#89, and the standing rule of this codebase): a click
// carries how much older than its observation it may be, because the poll that
// saw the button down cannot say when it went down.
import type { Rect } from '../../shared/context/protocol'
import type { TimelineEvent } from '../../shared/types'
import type { SurfaceSampleWindow } from './timeline'

/** Every `input.*` type this writer may emit. There is deliberately no key. */
export const INPUT_EVENT_TYPES = [
  'input.mouse.move',
  'input.mouse.click',
  'input.window.focus',
  'input.window.move',
  'input.window.resize',
] as const

export type InputEventType = (typeof INPUT_EVENT_TYPES)[number]

export type MouseButton = 'left' | 'right' | 'middle'

/**
 * The buttons the host reports, as a bitmask. Mouse buttons ONLY: the host asks
 * the OS for the state of VK_LBUTTON/VK_RBUTTON/VK_MBUTTON and for nothing
 * else, so there is no keyboard state anywhere in this pipeline to leak.
 */
const BUTTON_BITS: readonly { bit: number; button: MouseButton }[] = [
  { bit: 1, button: 'left' },
  { bit: 2, button: 'right' },
  { bit: 4, button: 'middle' },
]

/** One reading of the pointer, in virtual-desktop physical pixels. */
export interface PointerReading {
  x: number
  y: number
  /** `BUTTON_BITS` mask of the buttons held down AT THIS READING. */
  buttons: number
}

/**
 * One derived event, still in the space it was observed in: virtual-desktop
 * physical pixels on the session clock. `inputTimelineEvents` is what turns it
 * into the pack's own space and clock — the same two-step the surface ring
 * takes (`ringObservations.ts`), and for the same reason: a ring must not have
 * to know what a pack looks like.
 */
export interface ObservedInputEvent {
  timeMs: number
  type: InputEventType
  point?: { x: number; y: number }
  bounds?: Rect
  button?: MouseButton
  /**
   * The gap back to the previous pointer reading, i.e. how much older than
   * `timeMs` the press may be. Stated because it cannot be measured away: the
   * loop sees the button DOWN, never the instant it went down.
   */
  observedWithinMs?: number
  title?: string
  process?: string
}

/**
 * THE COALESCING FLOOR — one event per 200 ms per moving thing.
 *
 * The lane observes 20-45 times a second, which is right for a ring the editor
 * scrubs and absurd for a JSON file a human and an LLM read: a 30 s drag would
 * be 1,350 rows saying the same sentence. 5 Hz keeps the SHAPE of a movement
 * (a drag is still a path, a click is never coalesced at all) at a twentieth of
 * the rows, and each row is still one moment Core really looked at — a
 * coalesced stream drops observations, it never averages them into one that
 * never happened.
 */
const COALESCE_MS = 200

/**
 * How far the cursor must have travelled since the last EMITTED move. A cursor
 * jittering under a hand is not a movement worth a row; 8 px is under a mouse
 * pointer's own hotspot area, so nothing a reader could see is lost.
 */
const MOVE_MIN_DISTANCE_PX = 8

/**
 * THE CEILING, and the answer to "what does this cost".
 *
 * The rule is the DOM bridge's (`chrome/domBridge.ts`): the buffer should cost
 * what the REPLAY costs, not what the session does. Retention does that job —
 * `prune()` drops everything older than the replay window on the same 1 Hz tick
 * the surface ring is pruned on — and this is the second bound, for the case
 * retention cannot reach: a pathological desk producing events faster than the
 * coalescing floor should allow.
 *
 * 4,096 events is 34 minutes of one thing moving continuously at the 5 Hz floor
 * — far past the ten-minute maximum retention — at roughly 90 bytes of JS
 * object per event, i.e. under 400 KB held, against the surface ring's own
 * 512 KB-per-30 s budget. Over it the OLDEST event goes, which is the same
 * choice `prune` makes and the only one that keeps the capture instant.
 */
export const INPUT_RING_MAX_EVENTS = 4096

/** What one window looked like at the previous observation. */
interface WindowState {
  bounds: Rect
  title: string
  process: string
  lastMoveMs: number
  lastResizeMs: number
}

/**
 * The ring. Append-only in time, pruned from the front, bounded twice.
 *
 * It holds NO history of its own beyond the events: the previous surface sample
 * and the previous pointer reading are the entire derivation state, so the cost
 * of observing is one comparison per visible window per sample.
 */
export class InputEventRing {
  private events: ObservedInputEvent[] = []
  private readonly windows = new Map<string, WindowState>()
  private foregroundHwnd: string | null = null
  private sawWindows = false
  private pointer: { tMs: number; x: number; y: number; buttons: number } | null = null
  private lastMove: { tMs: number; x: number; y: number } | null = null
  private retentionMs: number
  private droppedEvents = 0
  private pointerReadings = 0

  constructor(retentionMs = 30_000) {
    this.retentionMs = Math.max(1_000, retentionMs)
  }

  setRetentionMs(ms: number): void {
    if (!Number.isFinite(ms)) return
    this.retentionMs = Math.max(1_000, ms)
  }

  retention(): number {
    return this.retentionMs
  }

  /**
   * One observation of the desk, from the lane's own append funnel — the same
   * instant, the same clock and the same windows that go into the surface ring.
   * `pointer` is null when the host did not report one (an older host, a
   * platform without one), and that is simply a capture with no mouse events.
   */
  observe(
    timeMs: number,
    windows: readonly SurfaceSampleWindow[],
    pointer: PointerReading | null,
  ): void {
    this.observeWindows(timeMs, windows)
    if (pointer !== null) this.observePointer(timeMs, pointer)
  }

  /** Drops everything older than `beforeTimeMs`. The replay's own bound. */
  prune(beforeTimeMs: number): void {
    if (this.events.length === 0) return
    const first = this.events[0]
    if (first !== undefined && first.timeMs >= beforeTimeMs) return
    const kept = this.events.filter((event) => event.timeMs >= beforeTimeMs)
    this.droppedEvents += this.events.length - kept.length
    this.events = kept
  }

  /** Everything observed inside `[startMs, endMs]`, ascending. */
  between(startMs: number, endMs: number): readonly ObservedInputEvent[] {
    return this.events.filter((event) => event.timeMs >= startMs && event.timeMs <= endMs)
  }

  /**
   * `pointerReadings` is here because SILENCE IS NOT ABSENCE (GOAL.md). A pack
   * with no mouse events has two completely different causes — the cursor never
   * moved, or the host never reported one at all — and only this number tells
   * them apart in the log.
   */
  stats(): { events: number; dropped: number; pointerReadings: number } {
    return {
      events: this.events.length,
      dropped: this.droppedEvents,
      pointerReadings: this.pointerReadings,
    }
  }

  private push(event: ObservedInputEvent): void {
    this.events.push(event)
    const excess = this.events.length - INPUT_RING_MAX_EVENTS
    if (excess > 0) {
      this.events.splice(0, excess)
      // Counted exactly, not "one per overflow": a number that under-reports
      // what was thrown away is worse than no number at all.
      this.droppedEvents += excess
    }
  }

  /**
   * Focus, move and resize, from the difference between two surface samples.
   *
   * ONLY WINDOWS THAT WERE ON SCREEN. A cloaked, minimized or hidden window is
   * still in the surface ring — the record is the record — but it is not in the
   * picture, and "already in the pack" is the entire licence these events have
   * to exist. Its title is not written either, for the same reason.
   */
  private observeWindows(timeMs: number, windows: readonly SurfaceSampleWindow[]): void {
    const seen = new Set<string>()
    let foreground: SurfaceSampleWindow | null = null
    for (const window of windows) {
      if (!onScreen(window)) continue
      seen.add(window.hwnd)
      if (window.foreground) foreground = window
      const previous = this.windows.get(window.hwnd)
      const process = processNameOf(window.executableName)
      if (previous === undefined) {
        // A window Core has never seen at a rectangle it can compare against
        // has not moved; it appeared. The baseline is not an event.
        this.windows.set(window.hwnd, {
          bounds: { ...window.bounds },
          title: window.windowTitle,
          process,
          lastMoveMs: Number.NEGATIVE_INFINITY,
          lastResizeMs: Number.NEGATIVE_INFINITY,
        })
        continue
      }
      const resized =
        previous.bounds.width !== window.bounds.width ||
        previous.bounds.height !== window.bounds.height
      const moved = previous.bounds.x !== window.bounds.x || previous.bounds.y !== window.bounds.y
      // A resize carries the whole rectangle, so a window that did both in one
      // step is one event and not two saying different halves of it.
      if (resized && timeMs - previous.lastResizeMs >= COALESCE_MS) {
        previous.lastResizeMs = timeMs
        previous.lastMoveMs = timeMs
        this.push({
          timeMs,
          type: 'input.window.resize',
          bounds: { ...window.bounds },
          title: window.windowTitle,
          process,
        })
      } else if (!resized && moved && timeMs - previous.lastMoveMs >= COALESCE_MS) {
        previous.lastMoveMs = timeMs
        this.push({
          timeMs,
          type: 'input.window.move',
          bounds: { ...window.bounds },
          title: window.windowTitle,
          process,
        })
      }
      previous.bounds = { ...window.bounds }
      previous.title = window.windowTitle
      previous.process = process
    }
    for (const hwnd of [...this.windows.keys()]) {
      if (!seen.has(hwnd)) this.windows.delete(hwnd)
    }

    const hwnd = foreground?.hwnd ?? null
    const changed = hwnd !== null && hwnd !== this.foregroundHwnd
    // The first sample establishes which window HAD focus; it did not take it.
    if (changed && this.sawWindows && foreground !== null) {
      this.push({
        timeMs,
        type: 'input.window.focus',
        bounds: { ...foreground.bounds },
        title: foreground.windowTitle,
        process: processNameOf(foreground.executableName),
      })
    }
    if (hwnd !== null) this.foregroundHwnd = hwnd
    if (windows.length > 0) this.sawWindows = true
  }

  private observePointer(timeMs: number, reading: PointerReading): void {
    this.pointerReadings += 1
    const previous = this.pointer
    // A PRESS IS A TRANSITION BETWEEN TWO READINGS, never a single one.
    //
    // Both endpoints are measured — up here, down there — so the event says
    // something that was observed. What cannot be observed is WHEN in between,
    // and `observed_within_ms` is that gap rather than a silence over it. A
    // press and release that both fall between two readings is not recorded at
    // all: the timeline says what it saw, and never what it supposes.
    if (previous !== null) {
      for (const { bit, button } of BUTTON_BITS) {
        const wasDown = (previous.buttons & bit) !== 0
        const isDown = (reading.buttons & bit) !== 0
        if (isDown && !wasDown) {
          this.push({
            timeMs,
            type: 'input.mouse.click',
            point: { x: reading.x, y: reading.y },
            button,
            observedWithinMs: Math.max(0, Math.round(timeMs - previous.tMs)),
          })
        }
      }
    }
    this.pointer = { tMs: timeMs, x: reading.x, y: reading.y, buttons: reading.buttons }

    const last = this.lastMove
    if (last === null) {
      // The first reading is the baseline the next one is a movement against.
      this.lastMove = { tMs: timeMs, x: reading.x, y: reading.y }
      return
    }
    if (timeMs - last.tMs < COALESCE_MS) return
    const dx = reading.x - last.x
    const dy = reading.y - last.y
    if (dx * dx + dy * dy < MOVE_MIN_DISTANCE_PX * MOVE_MIN_DISTANCE_PX) return
    this.lastMove = { tMs: timeMs, x: reading.x, y: reading.y }
    this.push({ timeMs, type: 'input.mouse.move', point: { x: reading.x, y: reading.y } })
  }
}

/**
 * WHERE AN OBSERVATION IS, in the pack's coordinates.
 *
 * The ring records virtual-desktop physical pixels; a pack's coordinates are
 * ONE display's snapshot pixels (SPEC §8.2), and `display` absent means the
 * focused one — the same rule an annotation (§8.8) and a `windows-uia` entry
 * (§11.3) follow. `ringObservations.inputDisplayPlacement` builds this; it is
 * an interface here so this file never learns what a monitor is.
 */
export interface InputDisplayPlacement {
  point(x: number, y: number): { display: number; focused: boolean; x: number; y: number } | null
  rect(bounds: Rect): { display: number; focused: boolean; bounds: Rect } | null
}

/**
 * The observed events as SPEC §10 events: pack clock, pack coordinates.
 *
 * An observation that cannot be placed on a captured display is DROPPED rather
 * than forced onto one — a second monitor the capture did not freeze is a real
 * place the cursor goes, and putting its coordinates into the focused display's
 * space would be a point in a picture that never contained it.
 */
export function inputTimelineEvents(
  observed: readonly ObservedInputEvent[],
  place: InputDisplayPlacement,
  toPackTMs: (sessionMs: number) => number | null,
): TimelineEvent[] {
  const events: TimelineEvent[] = []
  for (const event of observed) {
    const packTMs = toPackTMs(event.timeMs)
    if (packTMs === null || !Number.isFinite(packTMs)) continue
    const data = eventData(event, place)
    if (data === null) continue
    events.push({
      t_ms: Math.round(packTMs),
      type: event.type,
      // The component that observed it. Core runs the lane these come from; a
      // plugin that ever observes input would name itself here instead
      // (SPEC §10.1).
      source: 'core',
      data,
    })
  }
  // Ascending by t_ms, stable for equal values (SPEC §10.1). The ring is
  // already in observation order; sorting is what keeps that true when two
  // sources of observation are merged.
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.t_ms - b.event.t_ms || a.index - b.index)
    .map(({ event }) => event)
}

function eventData(
  event: ObservedInputEvent,
  place: InputDisplayPlacement,
): Record<string, unknown> | null {
  if (event.type === 'input.mouse.move' || event.type === 'input.mouse.click') {
    const point = event.point
    if (point === undefined) return null
    const placed = place.point(point.x, point.y)
    if (placed === null) return null
    return {
      x: placed.x,
      y: placed.y,
      ...(placed.focused ? {} : { display: placed.display }),
      ...(event.type === 'input.mouse.click'
        ? {
            button: event.button,
            ...(event.observedWithinMs === undefined
              ? {}
              : { observed_within_ms: event.observedWithinMs }),
          }
        : {}),
    }
  }
  const bounds = event.bounds
  if (bounds === undefined) return null
  const placed = place.rect(bounds)
  if (placed === null) return null
  return {
    title: event.title ?? '',
    process: event.process ?? '',
    ...(placed.focused ? {} : { display: placed.display }),
    // Focus says WHICH window took it; where that window was is the surface
    // timeline's answer and does not change because focus did.
    ...(event.type === 'input.window.focus' ? {} : { bounds: placed.bounds }),
  }
}

/**
 * The timeline of a TRIMMED pack.
 *
 * A `core.*` event is clamped, exactly as it was before input events existed:
 * there are three of them, they mark the capture's own story, and a reader has
 * always read `core.capture.triggered` at zero on a pack trimmed past it.
 *
 * An `input.*` event outside the kept range is DROPPED. Clamping one would move
 * an observation to a time it was not observed at — and with hundreds of them,
 * it would stack a whole minute of cursor positions onto instant zero and claim
 * the pointer was in two hundred places at once. The trimmed clock does not
 * cover them, so the trimmed pack does not carry them.
 */
export function timelineEventsForTrim(
  events: readonly TimelineEvent[],
  startMs: number,
  endMs: number,
): TimelineEvent[] {
  const out: TimelineEvent[] = []
  for (const event of events) {
    if (event.type.startsWith('input.')) {
      if (event.t_ms < startMs || event.t_ms > endMs) continue
      out.push({ ...event, t_ms: event.t_ms - startMs })
      continue
    }
    out.push({ ...event, t_ms: Math.max(0, event.t_ms - startMs) })
  }
  return out
}

/**
 * The timeline of a pack that ends up with NO REPLAY — an exact cut that
 * failed, a recorder that produced nothing, a re-edit whose declared replay is
 * not on disk.
 *
 * Every such path collapses the clock: it shifts each event back by the whole
 * replay length, or pins it to zero outright, because the capture instant is
 * all the pack has left. That is right for the three `core.*` events, which are
 * moments in the capture's own story, and it is wrong for an observation. The
 * caller has already dropped annotation lifetimes and `snapshot_t_ms` for the
 * same reason (SPEC §5.3, §8.4); this drops the input events, which are the
 * same kind of statement about a video that is not there.
 */
export function withoutInputEvents(events: readonly TimelineEvent[]): TimelineEvent[] {
  return events.filter((event) => !event.type.startsWith('input.'))
}

/**
 * On screen at all — the same test the surface ring uses to decide whether a
 * window can be under a cursor (`timeline.ts` `isOnScreen`). Here it decides
 * something stricter: whether the replay could have shown it, which is the only
 * reason an input event about it may exist.
 */
function onScreen(window: SurfaceSampleWindow): boolean {
  return (
    window.visible &&
    !window.minimized &&
    !window.cloaked &&
    window.bounds.width > 0 &&
    window.bounds.height > 0
  )
}

/** `explorer.exe` -> `explorer`, the form `plugins/windows-uia` writes (SPEC §11.3). */
function processNameOf(executableName: string): string {
  return executableName.replace(/\.exe$/iu, '')
}
