// The browser as a Temporal Context Provider — a picked DOM element becomes a
// pick candidate (GOAL "Chrome Extension"; protocol GAP 9).
//
// WHAT WAS BROKEN. The extension has been sending element picks since 0.1.0 and
// they reached `plugins/chrome-dom/elements.json` and stopped. Nothing turned
// them into candidates, so the authority ladder found nothing at the document
// rung, fell through to Core's WINDOW rung, and selecting a button in Chrome
// drew a box around the whole browser: "dom element를 선택하면 크롬이 선택되는데".
// The fix is not in the extension and not in the editor — it is that this file
// did not exist.
//
// THE HARD PART IS THE COORDINATE SPACE, and it is why this could not have been
// written before extension 0.1.4. A page can only measure itself in VIEWPORT
// CSS PIXELS: `getBoundingClientRect()` is relative to the top-left of the
// scrolled viewport, and knows nothing about where the browser window is, how
// tall its tab strip is, or what the display's scale factor does. Placing that
// rectangle on a snapshot needs two more facts, and each comes from the side
// that can actually observe it:
//
//   from the PAGE (extension 0.1.4's `viewport`): the viewport's size in CSS
//     pixels, so the CSS-pixel-to-snapshot-pixel scale can be derived rather
//     than assumed.
//   from the RING (`SurfaceInfo.clientBounds`): normally, the browser window's
//     DRAWABLE rectangle in this display's snapshot pixels; or, for an affine
//     region still, from the persisted virtual-desktop DIP crop plus the page's
//     own screen/outer rectangle.
//
// Nothing here is guessed from a toolbar constant. See `place()` for both
// measured derivations and the conditions under which each is allowed.
import type {
  ContextCandidate,
  FrameContext,
  HitTestContext,
  ProviderFrame,
  ProviderSurfaceClaim,
  Rect,
  SurfaceClaimContext,
  SurfaceInfo,
  TemporalAccuracy,
  TemporalContextProvider,
} from '../../shared/context/protocol'
import { CONTEXT_PROTOCOL_VERSION } from '../../shared/context/protocol'
import type { ProviderManifest } from '../../shared/context/manifest'
import { rectContains } from '../../shared/context/surfaces'
import type {
  DomDocumentSnapshot,
  DomElement,
  DomEvent,
  DomViewport,
} from '../chrome/domBridge'

export const CHROME_DOM_PROVIDER_ID = 'chrome-dom'
const CHROME_DOM_VERSION = '0.1.0'

/**
 * The provider's manifest, checked by the same registry — and against the same
 * rules — an installed plugin's is. `read-browser-context` is the permission
 * this actually exercises, and it is listed because Settings > Plugins renders
 * this list: a permission the user was never shown is one they never granted.
 *
 * `entry` is empty because there is no module to load; like the UI Automation
 * provider, this one is compiled into Core. That is the only field where being
 * built-in shows.
 */
export const CHROME_DOM_MANIFEST: ProviderManifest = {
  id: CHROME_DOM_PROVIDER_ID,
  name: 'Chrome DOM',
  version: CHROME_DOM_VERSION,
  type: 'temporal-context-provider',
  protocolVersion: CONTEXT_PROTOCOL_VERSION,
  entry: '',
  permissions: ['read-browser-context', 'write-plugin-files'],
}

/**
 * Executables this provider will attribute a pick to.
 *
 * Matched against `SurfaceInfo.executableName`, lower-cased with any extension
 * stripped — the same normalisation protocol GAP 9 specifies for an
 * `executableHint`. Deliberately a LIST OF BROWSERS rather than "whatever was
 * focused": the extension can only run in a Chromium browser, so a pick that
 * appears to belong to anything else is a mismatch to be refused, not a window
 * to be guessed at.
 */
const BROWSER_EXECUTABLES = new Set([
  'chrome',
  'chromium',
  'msedge',
  'brave',
  'vivaldi',
  'opera',
  'thorium',
])

/**
 * How far the derived CSS-to-snapshot scale may stray from 1:1 before the
 * placement is refused.
 *
 * The scale is a RATIO OF TWO MEASUREMENTS (see `place()`), so a wrong one
 * means the two measurements are not describing the same window — a stale ring
 * sample, a window that resized between the pick and the observation, a
 * mismatched match. Real values are the display's scale factor times the
 * browser's zoom: 1.0 unscaled, 1.5 or 2.0 on a HiDPI screen, 0.5 to 3 across
 * browser zoom. Outside this range the numbers are not a scale, they are a
 * disagreement, and a box drawn from them would be confidently wrong.
 */
const MIN_SCALE = 0.2
const MAX_SCALE = 6
/** Refuse side-panel/DevTools layouts where client width is not viewport width. */
const MIN_DPR_AGREEMENT = 0.75
const MAX_DPR_AGREEMENT = 1.25

/**
 * A PICK THAT WAS NOT OFFERED, AND WHY (#104).
 *
 * `place()` refuses rather than guesses, which is right — a box on the wrong
 * window is worse than no box. What was wrong is that the refusal left no
 * trace: a session that placed nothing logged nothing, so "the extension never
 * sent it", "no browser window matched the tab title" and "the ring holds no
 * client rectangle for that window" were one indistinguishable silence.
 */
export interface DomPlacementRefusal {
  /** The pick's own time on the pack clock. */
  tMs: number
  reason: string
  tabTitle: string
  selector: string
}

/** A pick, resolved onto one display's snapshot once, at the time it happened. */
interface PlacedPick {
  event: DomEvent
  /** Stable position in the persisted event stream; disambiguates same-ms re-picks. */
  eventOrdinal: number
  surfaceId: string
  display: number | undefined
  /** The owner slice observed with the element; claims share this geometry. */
  surfaceBounds: Rect
  /** The element's rectangle in snapshot pixels, AT THE EVENT'S TIME. */
  rect: Rect
  /** Whether the placement leaned on the ring or on the page's own screen guess. */
  exact: boolean
}

export class ChromeDomProvider implements TemporalContextProvider {
  readonly id = CHROME_DOM_PROVIDER_ID
  readonly name = CHROME_DOM_MANIFEST.name
  readonly version = CHROME_DOM_VERSION
  readonly protocolVersion = CONTEXT_PROTOCOL_VERSION
  readonly type = 'temporal-context-provider' as const

  private events: readonly DomEvent[]
  /**
   * The surface stack at a time, from CORE. Injected rather than imported so
   * this class stays testable without a runtime — the same seam the surface
   * lane's `SurfaceHost` uses.
   */
  private readonly surfacesAt: (timeMs: number) => readonly SurfaceInfo[]
  private readonly snapshotPixelsPerDipAt: (display: number) => number | null
  private readonly snapshotDipBoundsAt: (display: number) => Rect | undefined
  private placedCache: PlacedPick[] | null = null
  private refusalCache: DomPlacementRefusal[] = []

  constructor(
    events: readonly DomEvent[],
    surfacesAt: (timeMs: number) => readonly SurfaceInfo[],
    snapshotPixelsPerDipAt: (display: number) => number | null = () => null,
    snapshotDipBoundsAt: (display: number) => Rect | undefined = () => undefined,
  ) {
    this.events = events
    this.surfacesAt = surfacesAt
    this.snapshotPixelsPerDipAt = snapshotPixelsPerDipAt
    this.snapshotDipBoundsAt = snapshotDipBoundsAt
  }

  /** Late-arriving events (the bridge keeps receiving during an open editor). */
  replace(events: readonly DomEvent[]): void {
    this.events = events
    this.placedCache = null
  }

  get pickCount(): number {
    return this.placed().length
  }

  /** Every pick this session holds that could not be placed, and why (#104). */
  get placementRefusals(): readonly DomPlacementRefusal[] {
    this.placed()
    return this.refusalCache
  }

  getSurfaceClaims(c: SurfaceClaimContext): Promise<readonly ProviderSurfaceClaim[]> {
    // A claim per browser window this provider actually holds a pick for. It
    // claims the window's own region: the claim says "ask me about this
    // surface", and the candidates that come back are the elements inside it.
    // Claiming a surface with no pick would cost Core a call for nothing.
    const claims: ProviderSurfaceClaim[] = []
    const seen = new Set<string>()
    const present = new Map<string, SurfaceInfo>()
    for (const surface of c.surfaces) {
      present.set(`${surface.surfaceId}\0${String(surface.display ?? '')}`, surface)
    }
    for (const pick of this.placed()) {
      const surface =
        present.get(`${pick.surfaceId}\0${String(pick.display ?? '')}`)
        ?? c.surfaces.find((candidate) => candidate.surfaceId === pick.surfaceId)
      if (surface === undefined) continue
      const key =
        `${pick.surfaceId}\0${String(pick.display ?? '')}`
        + `\0${String(pick.surfaceBounds.x)},${String(pick.surfaceBounds.y)}`
      if (seen.has(key)) continue
      seen.add(key)
      claims.push({
        providerId: this.id,
        surfaceId: pick.surfaceId,
        ...(surface.hwnd === undefined ? {} : { hwnd: surface.hwnd }),
        region: { ...pick.surfaceBounds },
        space: 'display-snapshot',
        ...(pick.display === undefined ? {} : { display: pick.display }),
        authority: 'document-native',
        confidence: 0.9,
      })
    }
    return Promise.resolve(claims)
  }

  frame(c: FrameContext): Promise<ProviderFrame> {
    const accuracy = this.accuracyFor(c.timeMs)
    const candidates = this.candidatesAt(c.timeMs, c.surfaces)
    const region = c.region
    const inRegion =
      region === undefined ? candidates : candidates.filter((x) => overlaps(x.bounds, region))
    const truncated = inRegion.length > c.maxCandidates
    return Promise.resolve({
      providerId: this.id,
      timeMs: c.timeMs,
      accuracy,
      candidates: truncated ? inRegion.slice(0, c.maxCandidates) : inRegion,
      claims: [],
      coverage: [],
      truncated,
    })
  }

  hitTest(c: HitTestContext): Promise<readonly ContextCandidate[]> {
    // The authoritative per-point path, answered from the SAME placement the
    // frame path uses so the two can never disagree (the protocol's harness
    // cross-checks exactly that).
    const hits = this.candidatesAt(c.timeMs, [c.surface]).filter(
      (candidate) =>
        candidate.surfaceId === c.surface.surfaceId &&
        (c.display === undefined ||
          candidate.display === undefined ||
          candidate.display === c.display) &&
        rectContains(candidate.bounds, c.point),
    )
    return Promise.resolve(hits)
  }

  // -------------------------------------------------------------------------

  /**
   * Every pick, placed on a display once.
   *
   * A DOM pick is a POINT OBSERVATION, like a UI Automation dump: it says where
   * an element was at one instant. It is placed against the ring sample nearest
   * that instant and cached; a later frame translates it (see `candidatesAt`)
   * rather than re-deriving it, so the expensive part happens once per pick and
   * never per pointer move.
   */
  private placed(): PlacedPick[] {
    if (this.placedCache !== null) return this.placedCache
    const out: PlacedPick[] = []
    const refusals: DomPlacementRefusal[] = []
    for (const [eventOrdinal, event] of this.events.entries()) {
      // A CAPTURED DOCUMENT IS EVERY ELEMENT, NOT ONE (#130).
      //
      // This loop only ever understood `dom.element.selected` — the single
      // element a user had already clicked in Chrome. So the document fetched at
      // the capture instant reached the pack and stopped there: 340 rectangles
      // written to disk and none of them offered to the editor, which is
      // indistinguishable, from the outside, from not collecting it at all.
      //
      // Each entry is placed through exactly the same transform as a pick, so a
      // document element and a picked element cannot land in different places.
      //
      // AND FOR A SAVED PACK IT STAYED BROKEN ANYWAY UNTIL #136, which is why
      // this paragraph now carries a correction rather than a claim. #130 fixed
      // this loop, and the LIVE still it fixed worked; a REOPENED pack reached
      // this line with an empty event list, because two things further upstream
      // each dropped the page on their own:
      //
      //   the reader knew only the extension's camelCase spelling, so the
      //     `device_pixel_ratio` a pack actually carries parsed as absent and
      //     the whole document was refused (`parseDomDocument`);
      //   and no pack persisted a client rectangle, so `rectAtPick` below had
      //     nothing to place a viewport CSS pixel with.
      //
      // Measured on the owner's capture root before the fix: 6,091 rectangles on
      // disk, 0 recovered. A comment that says a bug is fixed when it is not is
      // worse than no comment, so `check:pack-readback` now counts both numbers
      // on a pack the exporter wrote — the claim is checked, not written down.
      if (event.type === 'dom.document.captured') {
        const snapshot = event.document
        if (snapshot === undefined) continue
        for (const entry of snapshot.elements) {
          const placed = this.place(
            { ...event, element: documentElementAsPick(entry) },
            eventOrdinal,
          )
          if (placed !== null) out.push(placed)
        }
        continue
      }
      if (event.type !== 'dom.element.selected') continue
      if (event.element === undefined) continue
      const placed = this.place(event, eventOrdinal)
      if (placed !== null) {
        out.push(placed)
        continue
      }
      refusals.push({
        tMs: event.tMs,
        reason: this.lastRefusal,
        tabTitle: event.tab.title,
        selector: event.element.selector,
      })
    }
    this.placedCache = out
    this.refusalCache = refusals
    return out
  }

  /** Set by `place()` on the way out; read only by `placed()`, immediately. */
  private lastRefusal = 'unknown'

  private refuse(reason: string): null {
    this.lastRefusal = reason
    return null
  }

  /**
   * ONE PICK ONTO ONE DISPLAY'S SNAPSHOT — the whole point of this file.
   *
   * THE MATCH. The browser window is found among the surfaces at the event's
   * time by two tests that must BOTH hold: the executable is a Chromium browser
   * (`BROWSER_EXECUTABLES`), and the window title contains the tab's title.
   * Chromium titles its window "<tab title> - Google Chrome", so containment is
   * the honest test — equality would fail on the suffix, and prefix matching
   * would fail on the browsers that put the suffix first. When that leaves
   * ZERO or MORE THAN ONE candidate window, this returns null and the pick is
   * simply not offered. A box on the wrong window is worse than no box: the
   * editor still has its window rung, which is at least true.
   *
   * THE SCALE, derived and not assumed. A viewport spans the full WIDTH of the
   * client area — Chromium has no side chrome — so
   *
   *     k = clientBounds.width / viewport.width          [snapshot px per CSS px]
   *
   * which folds the display scale factor, the device pixel ratio and the
   * browser's zoom into one measured number. `dpr` is then a CROSS-CHECK rather
   * than a term: if the ratio lands outside [MIN_SCALE, MAX_SCALE] the two
   * measurements are not describing the same window and the pick is refused.
   *
   * THE VERTICAL OFFSET, also derived. The viewport is anchored to the BOTTOM
   * of the client area — tab strip and omnibox sit above it, downloads bar and
   * find bar can appear below the top — so
   *
   *     chromeHeight = clientBounds.height - viewport.height * k
   *
   * is whatever that browser's chrome actually was at that instant, measured,
   * with no constant anywhere. A negative value means the viewport claims to be
   * taller than the window that contains it, which is another disagreement, and
   * is refused too.
   */
  private place(event: DomEvent, eventOrdinal: number): PlacedPick | null {
    const element = event.element
    const viewport = event.viewport
    if (element === undefined) return this.refuse('no-element')
    if (viewport === undefined) {
      // Extension older than 0.1.4: the pick was recorded but the page never
      // said where its viewport was, so nothing can place it.
      return this.refuse('no-viewport-in-event')
    }
    const surfaces = this.surfacesAt(event.tMs)
    const browsers = surfaces.filter(
      (s) => !s.minimized && s.visible && BROWSER_EXECUTABLES.has(normalizeExe(s.executableName)),
    )
    const matches = browsers.filter((s) => titleMatches(s.windowTitle, event.tab.title))
    // Exactly one, or nothing. See the note above on refusing rather than
    // guessing. The #103 split can legitimately produce the same surfaceId
    // twice (one entry per display), so that is not ambiguity — collapse it and
    // keep the entry whose display holds more of the window.
    const ids = new Set(matches.map((surface) => surface.surfaceId))
    if (ids.size === 0) {
      return this.refuse(
        browsers.length === 0
          ? `no-visible-browser-window-at-${String(Math.round(event.tMs))}ms`
          : `no-browser-window-titled-like-the-tab (${String(browsers.length)} browser window(s) seen)`,
      )
    }
    if (ids.size !== 1) {
      return this.refuse(`ambiguous-browser-windows:${String(ids.size)}`)
    }

    // A surface that straddles displays appears once per display. The element
    // does not necessarily live on the largest window slice, so derive it in
    // every slice's snapshot space and select the slice containing the largest
    // visible part of the element. This is order-independent and keeps a pick
    // on the monitor where the user actually saw it.
    let selected:
      | { surface: SurfaceInfo; client: Rect; rect: Rect; overlap: number }
      | null = null
    let derived = 0
    for (const surface of matches) {
      const display = surface.display
      const anchored =
        display === undefined
          ? undefined
          : rectAtDesktopDipAnchor(
              element.bounds,
              viewport,
              this.snapshotPixelsPerDipAt(display),
              this.snapshotDipBoundsAt(display),
            )
      // A one-monitor region pack records the exact virtual-desktop DIP crop.
      // In that case Chrome's own screen/outer geometry and DPR place viewport
      // CSS pixels directly onto the raster. Prefer that complete transform to
      // a Win32 client rectangle: the latter can be stale or cross-DPI
      // virtualized while still looking numerically plausible (#137).
      //
      // `undefined` means the pack has no affine page anchor (old pack, video,
      // mixed-DPI desktop composition), so the measured client rectangle stays
      // the fallback. `null` means an anchor was present but contradicted itself;
      // do not turn that refusal into a confidently wrong fallback rectangle.
      const candidate = anchored === undefined
        ? rectAtPick(surface, element.bounds, viewport)
        : anchored
      if (candidate === null) continue
      derived += 1
      const overlap = intersectionArea(candidate.rect, surface.bounds)
      if (
        overlap > 0
        && (
          selected === null
          || overlap > selected.overlap
          || (
            overlap === selected.overlap
            && (surface.display ?? Number.MAX_SAFE_INTEGER)
              < (selected.surface.display ?? Number.MAX_SAFE_INTEGER)
          )
        )
      ) {
        selected = { surface, ...candidate, overlap }
      }
    }
    if (selected === null) {
      return this.refuse(
        derived === 0
          // The window is there and the numbers do not describe it: no client
          // rectangle in the ring, a docked DevTools or side panel, or a window
          // that resized between the pick and the observation.
          ? 'viewport-does-not-agree-with-the-window (client bounds, scale or chrome height)'
          : 'element-lies-outside-every-slice-of-the-window',
      )
    }
    const { surface, rect } = selected
    return {
      event,
      eventOrdinal,
      surfaceId: surface.surfaceId,
      display: surface.display,
      surfaceBounds: { ...surface.bounds },
      rect,
      exact: true,
    }
  }

  /**
   * The placed picks as candidates at `timeMs`.
   *
   * Bounds and display are copied from the observation unchanged. Window motion
   * cannot prove element motion because the page may scroll, reflow or hide the
   * element independently. Temporal distance is reported in `accuracy`; it is
   * not permission to manufacture spatial geometry.
   */
  private candidatesAt(
    timeMs: number,
    surfaces: readonly SurfaceInfo[],
  ): ContextCandidate[] {
    const now = new Map<string, SurfaceInfo[]>()
    for (const s of surfaces) {
      const held = now.get(s.surfaceId)
      if (held === undefined) now.set(s.surfaceId, [s])
      else held.push(s)
    }
    const out: ContextCandidate[] = []
    const picks = this.placed()
    picks.forEach((pick, index) => {
      const currentSurfaces = now.get(pick.surfaceId)
      if (currentSurfaces === undefined) return

      const surface =
        currentSurfaces.find((candidate) => candidate.display === pick.display)
        ?? currentSurfaces[0]
      if (surface === undefined) return
      const bounds = { ...pick.rect }
      const element = pick.event.element
      if (element === undefined) return
      const candidateAccuracy = accuracyAtPick(timeMs, pick.event.tMs)
      out.push({
        providerId: this.id,
        surfaceId: pick.surfaceId,
        // Unique within (provider, session, surface) and stable over time: the
        // selector identifies the element inside its document, and the event's
        // own time disambiguates two picks of the same selector (GAP 12).
        objectId:
          `${element.selector} @${String(pick.event.tMs)} #${String(pick.eventOrdinal)}`,
        objectType: element.role !== undefined && element.role !== '' ? element.role : element.tag,
        ...(element.text !== undefined && element.text !== ''
          ? { name: element.text }
          : element.id !== undefined && element.id !== ''
            ? { name: `#${element.id}` }
            : {}),
        bounds,
        space: 'display-snapshot',
        ...(pick.display === undefined ? {} : { display: pick.display }),
        // A picked element is the most specific thing anyone has said about
        // that pixel, so it must out-depth every UI Automation control that
        // encloses it. Those are geometric containment depths within one
        // window and do not approach this.
        depth: 10_000,
        paintOrder: index,
        authority: 'document-native',
        // WHICH OF THE TWO THINGS THIS IS. `dom.element.selected` is one
        // element a human clicked the picker on; `dom.document.captured` is
        // every element of the visible page, expanded into picks above so both
        // land through the same transform. They must not stay
        // indistinguishable downstream: the container filters exempt an
        // explicit pick, and applying that exemption to a page's own `<section>`
        // and `<nav>` wrappers is #58 all over again.
        explicit: pick.event.type === 'dom.element.selected',
        confidence: pick.exact ? 0.95 : 0.6,
        visible: true,
        occluded: false,
        accuracy: candidateAccuracy,
        identity: {
          selector: element.selector,
          tag: element.tag,
          ...(element.id === undefined ? {} : { dom_id: element.id }),
          ...(element.role === undefined ? {} : { role: element.role }),
          url: pick.event.tab.url,
          title: pick.event.tab.title,
        },
      })
    })
    return out
  }

  /**
   * A DOM pick is exact at its own instant and otherwise the nearest observed
   * sample with a non-zero temporal error. Its bounds remain observed; inexact
   * time is not reported as spatial interpolation.
   */
  private accuracyFor(timeMs: number): TemporalAccuracy {
    let nearestTimeMs: number | null = null
    let nearestDistanceMs: number | null = null
    for (const pick of this.placed()) {
      const d = Math.abs(pick.event.tMs - timeMs)
      if (nearestDistanceMs === null || d < nearestDistanceMs) {
        nearestTimeMs = pick.event.tMs
        nearestDistanceMs = d
      }
    }
    if (nearestTimeMs === null || nearestDistanceMs === null) {
      return {
        requestedTimeMs: timeMs,
        materializedTimeMs: timeMs,
        errorMs: 0,
        exact: false,
        coverage: 'none',
      }
    }
    return {
      requestedTimeMs: timeMs,
      materializedTimeMs: nearestTimeMs,
      errorMs: nearestDistanceMs,
      exact: nearestDistanceMs === 0,
      coverage: 'covered',
    }
  }
}

/** `chrome.exe` / `Chrome.EXE` / `chrome` all normalise to `chrome`. */
function normalizeExe(name: string | undefined): string {
  if (name === undefined) return ''
  const base = name.slice(name.lastIndexOf('\\') + 1).toLowerCase()
  return base.endsWith('.exe') ? base.slice(0, -4) : base
}

/**
 * Chromium window titles are "<tab title> - Google Chrome"; an empty tab title
 * (a blank page, a title the extension could not read) matches nothing rather
 * than everything, because "" is contained in every string.
 */
function titleMatches(windowTitle: string | undefined, tabTitle: string): boolean {
  const tab = tabTitle.trim()
  if (tab === '' || windowTitle === undefined) return false
  return windowTitle.includes(tab)
}

const MAX_DOM_COORDINATE = 10_000_000

function validFinite(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= MAX_DOM_COORDINATE
}

function validRect(rect: Rect): boolean {
  return (
    validFinite(rect.x)
    && validFinite(rect.y)
    && validFinite(rect.width)
    && validFinite(rect.height)
    && rect.width > 0
    && rect.height > 0
  )
}

/**
 * Resolves the page's viewport rectangle in one display slice's snapshot
 * space. `k` must agree with devicePixelRatio closely enough to prove that the
 * viewport really spans the client width. A docked DevTools or side panel
 * violates that assumption; declining is safer than placing a plausible box
 * in the wrong horizontal coordinate space.
 */
function rectAtPick(
  surface: SurfaceInfo,
  element: DomElement['bounds'],
  viewport: DomViewport,
): { client: Rect; rect: Rect } | null {
  const client = surface.clientBounds
  if (
    client === undefined
    || !validRect(client)
    || !validFinite(element.x)
    || !validFinite(element.y)
    || !validFinite(element.width)
    || !validFinite(element.height)
    || element.width <= 0
    || element.height <= 0
    || !validFinite(viewport.width)
    || !validFinite(viewport.height)
    || !validFinite(viewport.dpr)
    || viewport.width <= 0
    || viewport.height <= 0
    || viewport.dpr <= 0
  ) {
    return null
  }
  const k = client.width / viewport.width
  const dprAgreement = k / viewport.dpr
  if (
    !Number.isFinite(k)
    || k < MIN_SCALE
    || k > MAX_SCALE
    || dprAgreement < MIN_DPR_AGREEMENT
    || dprAgreement > MAX_DPR_AGREEMENT
  ) {
    return null
  }
  const chromeHeight = client.height - viewport.height * k
  if (!Number.isFinite(chromeHeight) || chromeHeight < 0 || chromeHeight >= client.height) {
    return null
  }
  const rect: Rect = {
    x: Math.round(client.x + element.x * k),
    y: Math.round(client.y + chromeHeight + element.y * k),
    width: Math.max(1, Math.round(element.width * k)),
    height: Math.max(1, Math.round(element.height * k)),
  }
  return validRect(rect) ? { client, rect } : null
}

/**
 * Places viewport CSS pixels through an image region's persisted desktop crop.
 *
 * Chrome reports screenX/screenY and outerWidth/outerHeight in Windows' scaled
 * desktop space. The crop is in that same virtual-desktop DIP space. Page
 * rectangles themselves are CSS pixels, so DPR — not the monitor scale — maps
 * their sizes to native snapshot pixels. The horizontal outer/client
 * difference yields one native frame inset; Chromium's viewport is bottom
 * anchored, so the same inset is removed from the bottom before its top is
 * derived. No browser-toolbar constant is involved.
 *
 * Return values deliberately distinguish unavailable (`undefined`) from an
 * internally contradictory anchor (`null`).
 */
function rectAtDesktopDipAnchor(
  element: DomElement['bounds'],
  viewport: DomViewport,
  snapshotPixelsPerDip: number | null,
  snapshotDipBounds: Rect | undefined,
): { client: Rect; rect: Rect } | null | undefined {
  const { screenX, screenY, outerWidth, outerHeight } = viewport
  if (
    snapshotDipBounds === undefined
  ) {
    return undefined
  }
  if (
    snapshotPixelsPerDip === null
    || screenX === null
    || screenY === null
    || outerWidth === null
    || outerHeight === null
  ) {
    return null
  }
  if (
    !validFinite(snapshotPixelsPerDip)
    || snapshotPixelsPerDip <= 0
    || !validRect(snapshotDipBounds)
    || !validFinite(screenX)
    || !validFinite(screenY)
    || !validFinite(outerWidth)
    || !validFinite(outerHeight)
    || outerWidth <= 0
    || outerHeight <= 0
    || !validFinite(viewport.width)
    || !validFinite(viewport.height)
    || !validFinite(viewport.dpr)
    || viewport.width <= 0
    || viewport.height <= 0
    || viewport.dpr <= 0
    || !validFinite(element.x)
    || !validFinite(element.y)
    || !validFinite(element.width)
    || !validFinite(element.height)
    || element.width <= 0
    || element.height <= 0
  ) {
    return null
  }

  const outerWidthPx = outerWidth * snapshotPixelsPerDip
  const outerHeightPx = outerHeight * snapshotPixelsPerDip
  const viewportWidthPx = viewport.width * viewport.dpr
  const viewportHeightPx = viewport.height * viewport.dpr
  const frameInsetPx = (outerWidthPx - viewportWidthPx) / 2
  const chromeAbovePx = outerHeightPx - frameInsetPx - viewportHeightPx
  if (
    !Number.isFinite(outerWidthPx)
    || !Number.isFinite(outerHeightPx)
    || !Number.isFinite(viewportWidthPx)
    || !Number.isFinite(viewportHeightPx)
    || !Number.isFinite(frameInsetPx)
    || !Number.isFinite(chromeAbovePx)
    || frameInsetPx < 0
    || frameInsetPx >= outerWidthPx / 2
    || chromeAbovePx < 0
    || chromeAbovePx >= outerHeightPx
  ) {
    return null
  }

  const viewportX =
    (screenX - snapshotDipBounds.x) * snapshotPixelsPerDip + frameInsetPx
  const viewportY =
    (screenY - snapshotDipBounds.y) * snapshotPixelsPerDip + chromeAbovePx
  const client: Rect = {
    x: Math.round(viewportX),
    y: Math.round(viewportY),
    width: Math.max(1, Math.round(viewportWidthPx)),
    height: Math.max(1, Math.round(viewportHeightPx)),
  }
  const rect: Rect = {
    x: Math.round(viewportX + element.x * viewport.dpr),
    y: Math.round(viewportY + element.y * viewport.dpr),
    width: Math.max(1, Math.round(element.width * viewport.dpr)),
    height: Math.max(1, Math.round(element.height * viewport.dpr)),
  }
  return validRect(client) && validRect(rect) ? { client, rect } : null
}

function accuracyAtPick(requestedTimeMs: number, pickTimeMs: number): TemporalAccuracy {
  const errorMs = Math.abs(requestedTimeMs - pickTimeMs)
  return {
    requestedTimeMs,
    materializedTimeMs: pickTimeMs,
    errorMs,
    exact: errorMs === 0,
    coverage: 'covered',
  }
}

function intersectionArea(a: Rect, b: Rect): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  return width * height
}

function overlaps(a: Rect, b: Rect): boolean {
  return intersectionArea(a, b) > 0
}

/**
 * ONE ENTRY OF A DOCUMENT SNAPSHOT, AS THE PICK SHAPE.
 *
 * The walker records what it saw; a pick carries a `selector` because that is
 * what identifies an element to a person reading the pack later. The walker has
 * no selector engine and should not grow one, so the identity is rebuilt here
 * from what it did record, cheapest first: an id is unique by definition, a
 * class list is usually enough to recognise, and a bare tag is the honest floor.
 *
 * Deliberately not invented beyond that. A synthesised `nth-child` chain would
 * look like a selector that could be resolved later, and it could not be — the
 * page has moved on.
 */
export function documentElementAsPick(entry: DomDocumentSnapshot['elements'][number]): DomElement {
  const classes = (entry.class ?? '')
    .split(/\s+/u)
    .filter((c: string) => c !== '')
    .slice(0, 3)
    .map((c: string) => `.${c}`)
    .join('')
  const selector =
    entry.id !== undefined && entry.id !== ''
      ? `#${entry.id}`
      : `${entry.tag}${classes}`
  return {
    tag: entry.tag,
    selector,
    bounds: entry.bounds,
    ...(entry.id === undefined || entry.id === '' ? {} : { id: entry.id }),
    ...(entry.role === undefined || entry.role === '' ? {} : { role: entry.role }),
    ...(entry.text === undefined || entry.text === '' ? {} : { text: entry.text }),
  }
}
