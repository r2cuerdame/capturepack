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
//   from the RING (`SurfaceInfo.clientBounds`): the browser window's DRAWABLE
//     rectangle, already in this display's snapshot pixels, observed by the
//     surface host at the same instants everything else in a pack is.
//
// Neither half can do it alone, and nothing here is guessed from a constant —
// no hard-coded tab-strip height, no assumed devicePixelRatio, no scale factor
// baked in. See `place()` for the derivation.
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
import type { DomEvent } from '../chrome/domBridge'

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

/** A pick, resolved onto one display's snapshot once, at the time it happened. */
interface PlacedPick {
  event: DomEvent
  surfaceId: string
  display: number | undefined
  /** The element's rectangle in snapshot pixels, AT THE EVENT'S TIME. */
  rect: Rect
  /** Where the browser window was then, so a later frame can translate it. */
  origin: { x: number; y: number }
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
  private placedCache: PlacedPick[] | null = null

  constructor(
    events: readonly DomEvent[],
    surfacesAt: (timeMs: number) => readonly SurfaceInfo[],
  ) {
    this.events = events
    this.surfacesAt = surfacesAt
  }

  /** Late-arriving events (the bridge keeps receiving during an open editor). */
  replace(events: readonly DomEvent[]): void {
    this.events = events
    this.placedCache = null
  }

  get pickCount(): number {
    return this.placed().length
  }

  getSurfaceClaims(c: SurfaceClaimContext): Promise<readonly ProviderSurfaceClaim[]> {
    // A claim per browser window this provider actually holds a pick for. It
    // claims the window's own region: the claim says "ask me about this
    // surface", and the candidates that come back are the elements inside it.
    // Claiming a surface with no pick would cost Core a call for nothing.
    const claims: ProviderSurfaceClaim[] = []
    const seen = new Set<string>()
    for (const pick of this.placed()) {
      if (seen.has(pick.surfaceId)) continue
      const surface = this.surfacesAt(c.timeMs).find((s) => s.surfaceId === pick.surfaceId)
      if (surface === undefined) continue
      seen.add(pick.surfaceId)
      claims.push({
        providerId: this.id,
        surfaceId: surface.surfaceId,
        ...(surface.hwnd === undefined ? {} : { hwnd: surface.hwnd }),
        region: { ...surface.bounds },
        space: 'display-snapshot',
        ...(surface.display === undefined ? {} : { display: surface.display }),
        authority: 'document-native',
        confidence: 0.9,
      })
    }
    return Promise.resolve(claims)
  }

  frame(c: FrameContext): Promise<ProviderFrame> {
    const accuracy = this.accuracyFor(c.timeMs)
    const candidates = this.candidatesAt(c.timeMs, c.surfaces, accuracy)
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
    const accuracy = this.accuracyFor(c.timeMs)
    const hits = this.candidatesAt(c.timeMs, [c.surface], accuracy).filter(
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
    for (const event of this.events) {
      if (event.type !== 'dom.element.selected') continue
      if (event.element === undefined) continue
      const placed = this.place(event)
      if (placed !== null) out.push(placed)
    }
    this.placedCache = out
    return out
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
  private place(event: DomEvent): PlacedPick | null {
    const element = event.element
    const viewport = event.viewport
    if (element === undefined || viewport === undefined) return null
    const surfaces = this.surfacesAt(event.tMs)
    const matches = surfaces.filter(
      (s) =>
        !s.minimized &&
        s.visible &&
        BROWSER_EXECUTABLES.has(normalizeExe(s.executableName)) &&
        titleMatches(s.windowTitle, event.tab.title),
    )
    // Exactly one, or nothing. See the note above on refusing rather than
    // guessing. The #103 split can legitimately produce the same surfaceId
    // twice (one entry per display), so that is not ambiguity — collapse it and
    // keep the entry whose display holds more of the window.
    const surface = soleSurface(matches)
    if (surface === null) return null
    const client = surface.clientBounds
    if (client === undefined || client.width <= 0 || client.height <= 0) return null
    const k = client.width / viewport.width
    if (!Number.isFinite(k) || k < MIN_SCALE || k > MAX_SCALE) return null
    const chromeHeight = client.height - viewport.height * k
    if (!Number.isFinite(chromeHeight) || chromeHeight < 0 || chromeHeight >= client.height) {
      return null
    }
    const rect: Rect = {
      x: Math.round(client.x + element.bounds.x * k),
      y: Math.round(client.y + chromeHeight + element.bounds.y * k),
      width: Math.max(1, Math.round(element.bounds.width * k)),
      height: Math.max(1, Math.round(element.bounds.height * k)),
    }
    return {
      event,
      surfaceId: surface.surfaceId,
      display: surface.display,
      rect,
      origin: { x: surface.bounds.x, y: surface.bounds.y },
      exact: true,
    }
  }

  /**
   * The placed picks as candidates at `timeMs`, translated by how far their own
   * browser window moved since the pick.
   *
   * The same reasoning as the UI Automation provider's `anchored()`: an element
   * is drawn INSIDE its window, so its offset within that window survives the
   * window being dragged, and the window's position at every frame is in the
   * ring. A pick whose window is not on this desk at this time is DROPPED, not
   * floated.
   *
   * NEVER KEYED ON DISPLAY. That mistake cost a release: a provider's elements
   * carry no display (SPEC §8.3 — absent means "the annotation's own display")
   * while ring surfaces always carry a number, so a map keyed on the pair
   * matches nothing and silently drops every candidate.
   */
  private candidatesAt(
    timeMs: number,
    surfaces: readonly SurfaceInfo[],
    accuracy: TemporalAccuracy,
  ): ContextCandidate[] {
    const now = new Map<string, SurfaceInfo>()
    for (const s of surfaces) {
      const held = now.get(s.surfaceId)
      if (held === undefined || area(s.bounds) > area(held.bounds)) now.set(s.surfaceId, s)
    }
    const out: ContextCandidate[] = []
    const picks = this.placed()
    picks.forEach((pick, index) => {
      const surface = now.get(pick.surfaceId)
      if (surface === undefined) return
      const dx = surface.bounds.x - pick.origin.x
      const dy = surface.bounds.y - pick.origin.y
      const moved = dx !== 0 || dy !== 0
      const element = pick.event.element
      if (element === undefined) return
      out.push({
        providerId: this.id,
        surfaceId: pick.surfaceId,
        // Unique within (provider, session, surface) and stable over time: the
        // selector identifies the element inside its document, and the event's
        // own time disambiguates two picks of the same selector (GAP 12).
        objectId: `${element.selector} @${String(pick.event.tMs)}`,
        objectType: element.role !== undefined && element.role !== '' ? element.role : element.tag,
        ...(element.text !== undefined && element.text !== ''
          ? { name: element.text }
          : element.id !== undefined && element.id !== ''
            ? { name: `#${element.id}` }
            : {}),
        bounds: moved
          ? { ...pick.rect, x: pick.rect.x + dx, y: pick.rect.y + dy }
          : { ...pick.rect },
        space: 'display-snapshot',
        ...(surface.display === undefined ? {} : { display: surface.display }),
        // A picked element is the most specific thing anyone has said about
        // that pixel, so it must out-depth every UI Automation control that
        // encloses it. Those are geometric containment depths within one
        // window and do not approach this.
        depth: 10_000,
        paintOrder: index,
        authority: 'document-native',
        confidence: pick.exact ? 0.95 : 0.6,
        visible: true,
        occluded: false,
        accuracy: moved ? { ...accuracy, interpolated: true } : accuracy,
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
   * A DOM pick is EXACT at the instant it happened and an anchored estimate
   * elsewhere — the same shape of statement the UI Automation provider makes
   * about its dump. `covered` throughout because the pick's window is tracked
   * continuously by the ring; the staleness that matters is the element's
   * CONTENT (a page that scrolled or re-laid out), which no observation of the
   * window can rule out and which `interpolated` above is the honest flag for.
   */
  private accuracyFor(timeMs: number): TemporalAccuracy {
    let nearest: number | null = null
    for (const pick of this.placed()) {
      const d = Math.abs(pick.event.tMs - timeMs)
      if (nearest === null || d < nearest) nearest = d
    }
    const materialized = nearest === null ? timeMs : timeMs
    return {
      requestedTimeMs: timeMs,
      materializedTimeMs: materialized,
      errorMs: 0,
      exact: nearest === 0,
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

/**
 * One surface, or null when the match was ambiguous.
 *
 * Entries sharing a surfaceId are the SAME window seen on two displays (#103),
 * not two candidates: the larger slice wins, because that is the display the
 * viewport is mostly on. Two DIFFERENT surfaceIds is real ambiguity — two
 * browser windows showing the same page — and refuses.
 */
function soleSurface(matches: readonly SurfaceInfo[]): SurfaceInfo | null {
  if (matches.length === 0) return null
  const ids = new Set(matches.map((s) => s.surfaceId))
  if (ids.size > 1) return null
  let best = matches[0] as SurfaceInfo
  for (const s of matches) if (area(s.bounds) > area(best.bounds)) best = s
  return best
}

function area(r: Rect): number {
  return Math.max(0, r.width) * Math.max(0, r.height)
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}
