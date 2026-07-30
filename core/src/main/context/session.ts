// One editor window's context session: Core's Surface Timeline, the Provider
// Host, and the frame the editor indexes.
//
// THE ORDER IS THE POINT (#66). Core restores the surface stack for the
// requested time FIRST, from its own timeline; asks who holds a CLAIM on that
// region; asks only those providers; and then enforces the staleness ceiling on
// what comes back. A provider never sees a point before Core has decided which
// surface owns it, and no provider — including the built-in one — can shortcut
// that path.
//
// DELIBERATELY FREE OF ELECTRON. Everything here is decidable from data, so the
// #58 regression harness runs the REAL frame assembly against real packs in
// plain Node rather than a reimplementation of it — which is the only way the
// measured picking quality stays a checkable assertion. `service.ts` is the
// thin Electron shell around this: windows, IPC and the log.
import type {
  ContextCandidate,
  ContextDisplayFrame,
  ContextFrame,
  ProviderSurfaceClaim,
  SurfaceCoverage,
  SurfaceInfo,
} from '../../shared/context/protocol'
import { CONTEXT_PROTOCOL_VERSION } from '../../shared/context/protocol'
import { SurfaceTimeline, surfaceStackAt } from '../../shared/context/surfaces'
import type { TimelineKind } from '../../shared/context/surfaces'
import {
  ContextBuffer,
  mintSurfaceIds,
  surfaceIdOf,
  surfaceSamplesOf,
  windowCandidatesFromSurfaces,
} from './buffer'
import type { ContextObservation } from './buffer'
import type { EditorUiaElement, EditorUiaWindow } from '../../shared/ipc'
import type { ObjectTrackResult, ObjectTrackSample } from '../../shared/ipc'
import { SessionClock } from './clock'
// THE SAME REGISTRY THE RECORDING SIDE USES (#64). Not a second, smaller one
// for the editor: a provider that is budgeted, isolated, clock-corrected and
// disable-on-repeated-failure while recording, but asked through a bare
// try/catch while picking, is a provider whose guarantees depend on which
// window is open — which is exactly the private path this protocol forbids.
import { ProviderHost } from './providerHost'
import { WINDOWS_UIA_MANIFEST, WindowsUiaProvider } from './provider'
import { CHROME_DOM_MANIFEST, ChromeDomProvider } from './domProvider'
import type { DomEvent } from '../chrome/domBridge'

/** One captured display, in the pack's own indexing (SPEC §5.6). */
export interface ContextDisplayTarget {
  index: number
  focused: boolean
  width: number
  height: number
  /**
   * This display in the Win32 host's virtual-desktop physical pixels.
   *
   * Width/height alone cannot identify two identical monitors: Electron and
   * the helper are allowed to enumerate them in different orders. Fresh
   * captures provide this rectangle so the temporal window ring is paired by
   * desktop identity; reopened packs no longer need it because their
   * observations are already stored in snapshot coordinates.
   */
  desktopBounds?: { x: number; y: number; width: number; height: number }
  /**
   * Snapshot pixels per desktop DIP for this captured display. Optional only
   * for legacy/test callers; cross-display DOM placement refuses to guess when
   * either display's captured scale is absent.
   */
  snapshotPixelsPerDip?: number
}

export interface ContextSessionOptions {
  displays: readonly ContextDisplayTarget[]
  /** The pack clock's end — the capture instant (SPEC §10.1). */
  replayDurationMs: number
  /** The capture-instant observation, or null when there is none (yet). */
  observation: ContextObservation | null
  /** The observation was attempted and produced nothing; none is coming. */
  dropped: boolean
  /**
   * Element picks the browser reported during this replay, ON THE PACK CLOCK
   * (protocol GAP 9). Empty or absent whenever no browser was talking, which is
   * the ordinary case and costs nothing: the provider is registered anyway so
   * Settings can report it, and it simply claims no surface.
   */
  domEvents?: readonly DomEvent[]
  /** Where a provider refusal goes. Injected so this module stays Electron-free. */
  onWarn?: (message: string) => void
  /**
   * Where ordinary provider-host chatter goes (a registration, mostly). Separate
   * from `onWarn` because logging an unremarkable event at warning level is how
   * a log stops being read, and the one thing this project needs from its log is
   * that a real warning still stands out in it.
   */
  onInfo?: (message: string) => void
}

/** Candidates per frame. Generous — the reference capture's whole desk is 451. */
const MAX_CANDIDATES = 4_000

/**
 * How far two rectangles of the SAME window may differ, summed over the four
 * edges, and still be the same window (#97).
 *
 * The UI Automation dump measures a window with the invisible resize border
 * Windows adds; Core's ring measures the DWM extended frame without it.
 * Measured on this desk: 1461x962 against 1443x953, i.e. 18 wide and 9 tall,
 * which is 54 summed over four edges. 160 leaves room for a higher DPI without
 * letting a different window in.
 */
const WINDOW_MATCH_SLACK = 160

/**
 * Whether two sources are naming the same executable (#97).
 *
 * THEY SPELL IT DIFFERENTLY. `scripts/context-host.ps1` reports what
 * `QueryFullProcessImageNameW` returns — the file name, "explorer.exe". The UI
 * Automation dump reports PowerShell's process name, "explorer". An exact
 * comparison therefore matched NOTHING, every element was dropped as
 * unattributable, and no control could be picked on any pack — which is what
 * "하위 컨트롤 못잡음" survived two rounds of fixes as.
 */
function sameProcess(a: string, b: string): boolean {
  const norm = (v: string): string => v.trim().toLowerCase().replace(/\.exe$/, '')
  return norm(a) === norm(b) && norm(a) !== ''
}

/**
 * `bounds` clipped to a display's snapshot, or null when nothing of it is on
 * that screen (#100).
 */
function clipTo(
  bounds: EditorUiaWindow['bounds'],
  screen: ContextDisplayTarget,
): EditorUiaWindow['bounds'] | null {
  const x = Math.max(0, bounds.x)
  const y = Math.max(0, bounds.y)
  const right = Math.min(screen.width, bounds.x + bounds.width)
  const bottom = Math.min(screen.height, bounds.y + bounds.height)
  if (right <= x || bottom <= y) return null
  return { x, y, width: right - x, height: bottom - y }
}

function rectGap(a: EditorUiaWindow['bounds'], b: EditorUiaWindow['bounds']): number {
  return (
    Math.abs(a.x - b.x) +
    Math.abs(a.y - b.y) +
    Math.abs(a.width - b.width) +
    Math.abs(a.height - b.height)
  )
}

/**
 * Controls owned by each window object in one observation.
 *
 * Ownership is resolved before sources are merged. In particular, a legacy
 * `window: -1` control belongs to that source's focused window; treating -1 as
 * a z value would silently discard every old-pack control as soon as a ring
 * arrived.
 */
function controlsByOwner(
  observation: ContextObservation,
): ReadonlyMap<EditorUiaWindow, readonly EditorUiaElement[]> {
  const byZ = new Map<number, EditorUiaWindow>()
  for (const window of observation.windows) byZ.set(window.z, window)
  const fallback = observation.windows.find((window) => window.focused) ?? observation.windows[0]
  const controls = new Map<EditorUiaWindow, EditorUiaElement[]>()
  for (const element of observation.elements) {
    const owner = element.window >= 0 ? byZ.get(element.window) : fallback
    if (owner === undefined) continue
    const existing = controls.get(owner)
    if (existing === undefined) controls.set(owner, [element])
    else existing.push(element)
  }
  return controls
}

/**
 * A stable BASE identity for one owner's UIA pre-order.
 *
 * AutomationId/class/type are not unique: real trees contain dozens of rows
 * sharing all three. The merge below therefore treats this key as an ordered
 * multiset and compares occurrence N, rather than collapsing it into a Set.
 * Name and bounds deliberately stay out of the key because dynamic labels and
 * a moving window can change both between the resident checkpoint and dump.
 */
function controlOccurrenceKey(element: EditorUiaElement): string {
  return (
    `${element.control_type.trim()}\u0000` +
    `${element.class_name.trim()}\u0000` +
    element.automation_id.trim()
  )
}

function mergeControlOccurrences(
  primary: readonly EditorUiaElement[],
  supplement: readonly EditorUiaElement[],
): EditorUiaElement[] {
  const retained = new Map<string, number>()
  for (const element of primary) {
    const key = controlOccurrenceKey(element)
    retained.set(key, (retained.get(key) ?? 0) + 1)
  }
  const seen = new Map<string, number>()
  const merged = [...primary]
  for (const element of supplement) {
    const key = controlOccurrenceKey(element)
    const occurrence = (seen.get(key) ?? 0) + 1
    seen.set(key, occurrence)
    if (occurrence > (retained.get(key) ?? 0)) merged.push(element)
  }
  return merged
}

interface OwnerTree {
  window: EditorUiaWindow
  controls: readonly EditorUiaElement[]
}

/**
 * Whether this source is an authoritative whole tree.
 *
 * `collected + hasControls + zero elements` is an old inconsistent payload
 * shape meaning the elements were omitted, not an honestly empty tree. It must
 * not outrank a source that carries real controls.
 */
function completeOwnerTree(source: OwnerTree): boolean {
  return (
    source.window.tree === 'collected' &&
    (source.controls.length > 0 || !source.window.hasControls)
  )
}

function ownerTreeRank(source: OwnerTree): number {
  if (completeOwnerTree(source)) return 3
  if (source.window.tree === 'truncated' || source.controls.length > 0) return 2
  if (source.window.tree === 'unavailable' || source.window.hasControls) return 1
  return 0
}

/**
 * Merges two readings of ONE matched owner.
 *
 * A whole tree is authoritative. If neither source is whole, keep the richer
 * prefix first and add only missing ordered occurrences from the other. Equal
 * sources prefer the capture-instant dump because it is the exact trigger
 * reading; a more complete resident checkpoint still wins over a truncated
 * dump, so a 32-item timeout can never erase controls 33..N.
 */
function mergeOwnerTrees(existing: OwnerTree, instant: OwnerTree): OwnerTree {
  const existingComplete = completeOwnerTree(existing)
  const instantComplete = completeOwnerTree(instant)
  if (existingComplete || instantComplete) {
    if (instantComplete) return instant
    return existing
  }

  const existingRank = ownerTreeRank(existing)
  const instantRank = ownerTreeRank(instant)
  const preferInstant =
    instantRank > existingRank ||
    (instantRank === existingRank && instant.controls.length >= existing.controls.length)
  const primary = preferInstant ? instant : existing
  const supplement = preferInstant ? existing : instant
  return {
    window: {
      ...primary.window,
      hasControls: primary.window.hasControls || primary.controls.length > 0,
      tree:
        primary.window.tree === 'truncated' ||
        supplement.window.tree === 'truncated' ||
        primary.controls.length > 0 ||
        supplement.controls.length > 0
          ? 'truncated'
          : primary.window.tree,
    },
    controls: mergeControlOccurrences(primary.controls, supplement.controls),
  }
}

export class ContextSession {
  readonly sessionId: string
  private readonly displays: readonly ContextDisplayTarget[]
  private readonly replayDurationMs: number
  private readonly host: ProviderHost
  private readonly onWarn: (message: string) => void
  private readonly onInfo: (message: string) => void
  private provider: WindowsUiaProvider | null = null
  private domProvider: ChromeDomProvider | null = null
  /** Last placed/refused outcome reported, so an unchanged one stays quiet. */
  private domPlacementSignature: string | null = null
  private domEvents: readonly DomEvent[] = []
  private timeline: SurfaceTimeline
  private ids: ReadonlyMap<string, string> = new Map()
  private observations: readonly ContextObservation[] = []
  /** The window ring as adopted, before the dump is folded in (#91). */
  private ring: readonly ContextObservation[] = []
  /**
   * The capture-instant UI Automation dump, kept SEPARATELY from the ring (#91).
   *
   * The two describe different rungs of the same ladder — Core's ring says where
   * every WINDOW was for the whole replay, the dump says what CONTROLS were
   * inside them at one instant — and they arrive independently: the dump is
   * budgeted and can land after the editor opened, the ring is read at save.
   * Storing them in one field meant whichever arrived second destroyed the
   * first, and it was always the ring: 585 controls were collected, adopted,
   * and then thrown away by `adoptAll`. That is why no control could ever be
   * picked. The reverse happened too — a late dump replaced the ring and took
   * window picking in the past with it.
   */
  private instant: ContextObservation | null = null
  private dropped: boolean

  constructor(sessionId: string, options: ContextSessionOptions) {
    this.sessionId = sessionId
    this.displays = options.displays
    this.replayDurationMs = options.replayDurationMs
    this.dropped = options.dropped
    this.domEvents = options.domEvents ?? []
    this.onWarn = options.onWarn ?? ((): void => undefined)
    this.onInfo = options.onInfo ?? ((): void => undefined)
    // The pack's clock, replayed. Retention is the whole replay because nothing
    // here prunes: a saved pack holds every observation it will ever hold, and
    // the ring's retention rules belong to the recording session that produced
    // it. The clock is carried at all because the registry times, logs and
    // clock-corrects every provider call against ONE clock (GOAL "One clock"),
    // and an editor that supplied a different one would report latencies that
    // could not be compared with a recording session's.
    // The host's log goes through the SAME injected sink as everything else
    // here, which is what keeps this module Electron-free (see the header) —
    // src/main/log.ts imports Electron, and the #58 harness runs this file in
    // plain Node. Nothing is dropped: service.ts wires `onWarn` to the log.
    this.host = new ProviderHost(new SessionClock(options.replayDurationMs, sessionId), {
      info: (message) => this.onInfo(message),
      warn: (message) => this.onWarn(message),
    })
    this.timeline = new SurfaceTimeline([], 'single-instant', {
      startMs: 0,
      endMs: options.replayDurationMs,
    })
    this.adopt(options.observation)
  }

  /**
   * Takes an observation (the first one, or a dump that settled late) and
   * rebuilds the timeline and the provider's buffer from it.
   *
   * THE KIND IS DERIVED FROM THE DATA, never assumed: one observation is a
   * single-instant record and says so for every other time; several make a
   * ring. That is what lets the same code serve a v0.1.x pack and a live
   * temporal buffer with no legacy branch anywhere above this line (design
   * §10.1).
   */
  adopt(observation: ContextObservation | null): void {
    this.instant = observation
    this.rebuild()
  }

  /** Several observations on one clock — the shape a live buffer produces. */
  adoptAll(observations: readonly ContextObservation[]): void {
    const ordered = [...observations].sort((a, b) => a.tMs - b.tMs)
    // A decoded singleton with no windows is not evidence of an empty desktop:
    // it is a malformed/filtered history floor. Letting it replace a valid
    // capture-instant UIA observation makes every program/control disappear on
    // reopen. Multi-sample rings may legitimately contain an empty instant, but
    // an all-empty ring has no surface timeline to refine.
    this.ring =
      this.instant !== null && ordered.every((observation) => observation.windows.length === 0)
        ? []
        : ordered
    this.rebuild()
  }

  /**
   * Folds the ring and the capture-instant dump into the one list everything
   * below reads (#91).
   *
   * The dump's CONTROLS are merged into the ring observation nearest its own
   * time, which is what makes them pickable at the capture instant while every
   * other moment still answers from the ring. Its windows are not used: the
   * ring's carry Core's stable surface id (#90) and are already placed on the
   * display they belong to. For each matched owner, the more complete control
   * tree wins; partial trees are merged as ordered occurrences. This keeps an
   * exact Lane-A tree from regressing to the dump's timeout prefix while still
   * using the exact capture-instant tree when it is complete.
   */
  private rebuild(): void {
    const ring = this.ring
    const instant = this.instant
    if (instant === null) {
      this.observations = ring
    } else if (ring.length === 0) {
      this.observations = [instant]
    } else {
      let nearest = 0
      for (let i = 1; i < ring.length; i += 1) {
        if (Math.abs(ring[i]!.tMs - instant.tMs) < Math.abs(ring[nearest]!.tMs - instant.tMs)) nearest = i
      }
      const host = ring[nearest]!
      // A CONTROL POINTS AT ITS WINDOW BY Z, AND THE TWO SOURCES COUNT Z
      // DIFFERENTLY (#94).
      //
      // `EditorUiaElement.window` is the z-order of the window the control was
      // walked from, as the DUMP saw it. The observation this merges into keeps
      // the RING's windows, whose z comes from Core's host — a different
      // enumeration. Handing the elements over untranslated leaves every one of
      // them pointing at a window that is not there, and a control that belongs
      // to no window is a control that can never be offered. 756 of them, in the
      // pack that reported "하위 컨트롤을 선택못해" against a build that had
      // already stopped throwing the dump away.
      //
      // So the dump's windows are matched to the ring's and the z values are
      // rewritten. Identity first (process + class + title); among windows that
      // share it — which is why #90 exists — the nearest rectangle wins, since a
      // dump taken at the same instant sees the same window in the same place
      // give or take the invisible resize border.
      const zOf = new Map<number, number>()
      const used = new Set<EditorUiaWindow>()
      // THE HANDLE FIRST, ALWAYS (#97). Both sources observe it; everything
      // else about a window they merely describe, and they describe it
      // differently — "explorer.exe" against "explorer", and an untitled window
      // whose CLASS the dump writes into its title. Matching on descriptions
      // silently matched nothing at all, which is what left every control
      // unattributable and unpickable.
      const byHandle = new Map<string, EditorUiaWindow>()
      for (const w of host.windows) if (w.hwnd !== undefined) byHandle.set(w.hwnd, w)
      for (const dumped of instant.windows) {
        let best: EditorUiaWindow | null = null
        let bestGap = Number.POSITIVE_INFINITY
        const exact = dumped.hwnd === undefined ? undefined : byHandle.get(dumped.hwnd)
        if (exact !== undefined && !used.has(exact)) {
          used.add(exact)
          zOf.set(dumped.z, exact.z)
          continue
        }
        // Only a pack whose dump predates the handle reaches here. Kept so an
        // older recording still resolves its controls, and deliberately narrow.
        for (const w of host.windows) {
          if (used.has(w)) continue
          if (!sameProcess(w.process, dumped.process)) continue
          if (w.class_name !== dumped.class_name) continue
          if (w.title !== dumped.title) continue
          const gap = rectGap(w.bounds, dumped.bounds)
          if (gap < bestGap) {
            best = w
            bestGap = gap
          }
        }
        // A title can change between the dump and the nearest ring sample — a
        // download counter, a terminal's progress line. The window is still the
        // same window, and at one instant its RECTANGLE is unique, so fall back
        // to process + class + the closest rectangle. `WINDOW_MATCH_SLACK` is the
        // invisible resize border: the dump measures with it, the ring measures
        // the DWM frame without it, and on this desk that is 18 x 9 physical px.
        if (best === null) {
          for (const w of host.windows) {
            if (used.has(w)) continue
            if (!sameProcess(w.process, dumped.process)) continue
            if (w.class_name !== dumped.class_name) continue
            const gap = rectGap(w.bounds, dumped.bounds)
            if (gap < bestGap && gap <= WINDOW_MATCH_SLACK) {
              best = w
              bestGap = gap
            }
          }
        }
        if (best === null) continue
        used.add(best)
        zOf.set(dumped.z, best.z)
      }
      const trees = new Map<EditorUiaWindow, EditorUiaWindow>()
      for (const [dumpZ, ringZ] of zOf) {
        const dumped = instant.windows.find((w) => w.z === dumpZ)
        const w = host.windows.find((x) => x.z === ringZ)
        if (dumped !== undefined && w !== undefined) trees.set(w, dumped)
      }
      const existingByOwner = controlsByOwner(host)
      const instantByOwner = controlsByOwner(instant)
      const elements: EditorUiaElement[] = []
      const windows = host.windows.map((window) => {
        const dumped = trees.get(window)
        const existing: OwnerTree = {
          window,
          controls: existingByOwner.get(window) ?? [],
        }
        // The dump did not mention this owner. Its Lane-A controls are not
        // stale duplicates of another window; they are the only evidence for
        // this one and must survive unchanged.
        if (dumped === undefined) {
          elements.push(
            ...existing.controls.map((element) => ({ ...element, window: window.z })),
          )
          return window
        }

        const merged = mergeOwnerTrees(existing, {
          window: dumped,
          controls: instantByOwner.get(dumped) ?? [],
        })
        const remapped = merged.controls.map((element) => ({
          ...element,
          // A control points at its owner's z in the RING observation retained
          // below, never at the dump's independent enumeration number.
          window: window.z,
        }))
        elements.push(...remapped)
        return {
          ...window,
          hasControls: merged.window.hasControls || remapped.length > 0,
          tree: merged.window.tree,
        }
      })
      this.observations = ring.map((o, i) =>
        i !== nearest
          ? o
          : {
              tMs: o.tMs,
              windows,
              elements,
            },
      )
    }
    this.reindex()
  }

  private reindex(): void {
    this.ids = mintSurfaceIds(this.observations)
    const kind: TimelineKind = this.observations.length > 1 ? 'ring' : 'single-instant'
    const range = { startMs: 0, endMs: this.replayDurationMs }
    this.timeline = new SurfaceTimeline(surfaceSamplesOf(this.observations, this.ids), kind, range)
    const buffer = new ContextBuffer(this.observations, kind, range)
    if (this.provider !== null) {
      this.provider.replace(buffer, this.ids)
      // Chrome DOM placement reads this session's surface timeline. A session
      // commonly opens with only the capture-instant UIA result (or no result
      // after the UIA grace) and adopts the full replay ring a moment later.
      // Replacing only the Windows provider left ChromeDomProvider's placed
      // cache permanently based on that initial empty/single-instant timeline,
      // so every DOM pick stayed missing even though the ring arrived.
      //
      // registerDomProvider() is also the cache-invalidation path for an
      // existing provider: replace() keeps the events but clears every placed
      // result so they are rebuilt against the new timeline.
      this.registerDomProvider()
      return
    }
    // The built-in provider is registered through the SAME registry an external
    // one would use, with the same protocol version check and the same
    // permission gate. A refusal here is a real refusal: picking then falls to
    // Core's window level and the log says why.
    const provider = new WindowsUiaProvider(buffer, this.ids)
    const outcome = this.host.register(WINDOWS_UIA_MANIFEST, provider, { builtIn: true })
    if (!outcome.ok) {
      this.onWarn(`context: provider refused: ${outcome.reason}`)
      return
    }
    this.provider = provider
    this.registerDomProvider()
  }

  /**
   * The browser's rung of the ladder (GAP 9), registered through the same gate.
   *
   * It reads the surface stack through THIS session's timeline, so a DOM
   * element is placed against the very same window observations every other
   * answer here is built from — the one way the two can never disagree about
   * where a browser window was.
   */
  private registerDomProvider(): void {
    if (this.domProvider !== null) {
      this.domProvider.replace(this.domEvents)
      // The first registration commonly runs against a single-instant timeline
      // and refuses everything; the answer that matters is the one after the
      // replay ring is adopted. Reporting on replace is therefore the point,
      // and the signature keeps an unchanged outcome from repeating itself.
      this.reportDomPlacement(this.domProvider)
      return
    }
    const displayScales = new Map(
      this.displays.flatMap((display) =>
        display.snapshotPixelsPerDip === undefined
          ? []
          : [[display.index, display.snapshotPixelsPerDip] as const],
      ),
    )
    const provider = new ChromeDomProvider(
      this.domEvents,
      (timeMs) => this.timeline.restore(timeMs).surfaces,
      (display) => displayScales.get(display) ?? null,
    )
    const outcome = this.host.register(CHROME_DOM_MANIFEST, provider, { builtIn: true })
    if (!outcome.ok) {
      this.onWarn(`context: chrome-dom provider refused: ${outcome.reason}`)
      return
    }
    this.domProvider = provider
    this.reportDomPlacement(provider)
  }

  /**
   * WHAT THE BROWSER RUNG DID WITH WHAT IT WAS GIVEN (#104).
   *
   * This used to speak only when it succeeded, and only then — so a session
   * holding three picks that all refused looked exactly like a session holding
   * none, which is the state the field bug was reported in for two release
   * cycles. Counting the events as well as the placements separates the three
   * different failures a missing box can be.
   */
  private reportDomPlacement(provider: ChromeDomProvider): void {
    const picks = this.domEvents.filter((e) => e.type === 'dom.element.selected').length
    const refusals = provider.placementRefusals
    if (picks === 0 && refusals.length === 0) return
    const signature = [
      String(provider.pickCount),
      String(picks),
      ...refusals.map((r) => `${String(r.tMs)}:${r.reason}`),
    ].join('|')
    if (signature === this.domPlacementSignature) return
    this.domPlacementSignature = signature
    this.onInfo(
      `[context] chrome-dom: ${String(provider.pickCount)}/${String(picks)} element pick(s) placed`,
    )
    for (const refusal of refusals) {
      this.onWarn(
        `[context] chrome-dom: pick "${refusal.selector}" at ${String(refusal.tMs)}ms `
        + `not placed — ${refusal.reason} (tab "${refusal.tabTitle.slice(0, 80)}")`,
      )
    }
  }

  markDropped(dropped: boolean): void {
    this.dropped = dropped
  }

  /**
   * WHERE ONE OBJECT WAS, FOR AS LONG AS IT WAS THERE (#86).
   *
   * A box that follows its object needs two things this session already holds:
   * a stable id per surface (`mintSurfaceIds`, keyed on identity and ordinal, so
   * the same window is the same id in every observation), and the observations
   * themselves. So a track is a filter over what is already here rather than a
   * second path back to the ring — one source, one answer.
   *
   * Sampling STOPS at the first absence rather than skipping it. A window that
   * vanishes and comes back is two appearances; joining them would slide a box
   * across a stretch of replay where the thing it points at was not on screen.
   * That stop is also what clamps a picked box's lifetime to its object (#77):
   * a box outliving its object points at whatever moved in behind it, and no
   * reader can tell that from a box that is still right.
   */
  trackOf(surfaceId: string, startMs: number, endMs: number): ObjectTrackResult | null {
    const from = Math.min(startMs, endMs)
    const to = Math.max(startMs, endMs)
    const samples: ObjectTrackSample[] = []
    let display: number | null = null
    let endedAtMs: number | null = null

    for (const observation of this.observations) {
      if (observation.tMs < from) continue
      if (observation.tMs > to) break
      const window = observation.windows.find(
        (w) => surfaceIdOf(this.ids, observation, w) === surfaceId,
      )
      if (window === undefined) {
        // The observation exists and the surface is not in it. That is an
        // absence, not a gap in the record.
        if (samples.length > 0) endedAtMs = observation.tMs
        break
      }
      // A WINDOW DRAGGED ONTO ANOTHER SCREEN IS STILL THE SAME WINDOW (#86).
      //
      // This used to end the track there, because an annotation belongs to
      // exactly one display (SPEC §8.8) and its numbers are that display's
      // snapshot pixels — so continuing would have silently changed what the
      // coordinates referred to. Correct about the format, wrong about the
      // user: they drag a window to the other monitor and the box stops
      // following the thing it names, which is the whole defect this exists to
      // fix.
      //
      // So each SAMPLE carries the display its numbers are in. The box moves
      // between screens with the window, and every rectangle still says exactly
      // which image it is pixels of. `display` on the annotation stays what it
      // always was: where the box was drawn, and where a reader that ignores
      // tracking puts it.
      if (display === null) display = window.display
      // One sample per screen the window is visible on (#103) — the split is
      // made upstream, in `ringObservations`, where a surface still has its
      // virtual-desktop rectangle and every display's mapping is in hand. Here
      // it is simply "every window in this observation with this id".
      let placed = 0
      for (const w of observation.windows) {
        if (surfaceIdOf(this.ids, observation, w) !== surfaceId) continue
        samples.push({ tMs: observation.tMs, display: w.display, ...w.bounds })
        placed += 1
      }
      if (placed === 0) {
        if (samples.length > 0) endedAtMs = observation.tMs
        break
      }

    }

    if (display === null || samples.length === 0) return null
    return { display, samples, endedAtMs }
  }

  get providerIds(): readonly string[] {
    return this.host.activeIds()
  }

  /**
   * THE FRAME AT ONE TIME. Steps 1-6 of #66's algorithm; the editor's index
   * does 7 and 8 over it, at the point the pointer is actually on.
   */
  async frameAt(timeMs: number): Promise<ContextFrame> {
    // 1. restore the surface stack at T, from CORE's timeline — before any
    //    provider is asked anything at all.
    const restored = this.timeline.restore(timeMs)
    // `restored.surfaces`, NOT `restored.sample.surfaces`: the sample says when
    // Core looked, these say where things were at the time asked for (#83).
    const surfaces = restored.surfaces
    // 3. who holds a claim at this time? Claims are time-varying: a window did
    //    not exist at T-20 s, and a provider that has nothing to say about a
    //    surface must not be asked about it (#66, design GAP 8).
    const claims = await this.host.claims(timeMs, surfaces)
    const claimants = new Set(claims.map((claim) => claim.providerId))
    // 4. ask only the claimants, in parallel, each with its own budget.
    const result = await this.host.frames(
      { sessionId: this.sessionId, timeMs, surfaces, maxCandidates: MAX_CANDIDATES },
      [...claimants],
    )
    const providerCandidates: ContextCandidate[] = []
    const coverage: SurfaceCoverage[] = []
    const frameClaims: ProviderSurfaceClaim[] = [...claims]
    for (const frame of result.frames) {
      providerCandidates.push(...frame.candidates)
      coverage.push(...frame.coverage)
    }
    // Core's own WINDOW rung, minted from the surface sample rather than from
    // any provider: the floor of the ladder, and the reason "no candidate at
    // all" only ever happens on bare desktop (#66 step 8).
    // FROM THE RESTORED SURFACES, not from an observation looked up by its own
    // time (#111). `restored.surfaces` is what every other line here is built
    // on and what the comment at the top of this method insists on; minting the
    // window rung from `observationAt(sample.tMs)` instead let the hover
    // outline and the box that follows a window read two different rectangles
    // for one window at one moment — measured 1443x953 against 1461x962, the
    // DWM extended frame against GetWindowRect's invisible resize border.
    const windowCandidates =
      restored.sample === null ? [] : windowCandidatesFromSurfaces(surfaces, restored.accuracy)
    // 5b. THE STALENESS CEILING (design GAP 16). Deleting the v0.1.7 gate
    //     without this would only move the lie from "picking is off" to "here is
    //     a rectangle from nine seconds ago": a candidate whose covering
    //     observation does not actually cover the requested time is NOT offered,
    //     and the frame carries the verdict so the editor can say which of the
    //     several possible reasons applies.
    const offerable = [...providerCandidates, ...windowCandidates].filter(
      (candidate) => candidate.accuracy.coverage === 'covered',
    )
    return {
      sessionId: this.sessionId,
      protocolVersion: CONTEXT_PROTOCOL_VERSION,
      requestedTimeMs: timeMs,
      accuracy: restored.accuracy,
      displays: this.split(offerable, surfaces, coverage),
      providers: result.statuses,
      claims: frameClaims,
      pending: result.pending,
      dropped: this.dropped,
    }
  }

  /**
   * THE AUTHORITATIVE PER-POINT QUERY (#66 step 4), over the same restored
   * surface stack a frame is built from.
   *
   * The editor's interactive hover deliberately does NOT come through here — a
   * round trip per pointer move is exactly the cost `frame()` exists to avoid —
   * so this is the low-rate path: a consumer that has a point but no frame, and
   * the regression harness, which cross-checks that the two agree. Two answers
   * that could drift apart unnoticed would make the protocol's own contract
   * unfalsifiable.
   */
  async hitTest(
    timeMs: number,
    point: { x: number; y: number },
    display?: number,
  ): Promise<readonly ContextCandidate[]> {
    const restored = this.timeline.restore(timeMs)
    // `restored.surfaces`, NOT `restored.sample.surfaces`: the sample says when
    // Core looked, these say where things were at the time asked for (#83).
    const surfaces = restored.surfaces
    const stack = surfaceStackAt(surfaces, point, display)
    const surface = stack[0]
    if (surface === undefined) return []
    const claims = await this.host.claims(timeMs, surfaces)
    const claimants = new Set(claims.map((claim) => claim.providerId))
    const hits = await this.host.hitTest([...claimants], {
      sessionId: this.sessionId,
      timeMs,
      point,
      // Declared, not assumed: these are a saved pack's snapshot pixels, and the
      // physical rect they came from was never recorded. See `RectSpace`.
      space: 'display-snapshot',
      display,
      surface,
    })
    return hits.filter((candidate) => candidate.accuracy.coverage === 'covered')
  }


  /**
   * One slice per captured display, each in THAT display's snapshot pixel space
   * (SPEC §8.2 / §11.3). Every screen of the board is annotatable, so a single
   * space could only ever answer for one of them.
   */
  private split(
    candidates: readonly ContextCandidate[],
    surfaces: readonly SurfaceInfo[],
    coverage: readonly SurfaceCoverage[],
  ): ContextDisplayFrame[] {
    const focused = this.displays.find((d) => d.focused)?.index ?? 1
    const displayOf = (value: number | undefined): number =>
      typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : focused
    return this.displays.map((display) => ({
      display: display.index,
      width: display.width,
      height: display.height,
      surfaces: surfaces
        .filter((s) => displayOf(s.display) === display.index)
        .sort((a, b) => a.zOrder - b.zOrder),
      candidates: candidates.filter((c) => displayOf(c.display) === display.index),
      coverage,
    }))
  }
}
