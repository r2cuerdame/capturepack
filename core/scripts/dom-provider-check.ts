// DOES A PICKED DOM ELEMENT LAND ON THE ELEMENT? (GAP 9)
//
// The regression check for the fault reported as "dom element를 선택하면
// 크롬이 선택되는데": an element picked in Chrome produced no candidate at all,
// so the editor's authority ladder fell through to Core's WINDOW rung and boxed
// the whole browser.
//
// WHY IT NEEDS A SYNTHETIC DESK. The fault is a COORDINATE-SPACE fault, and the
// only way to catch a coordinate-space fault is to know the truth: this builds a
// browser window at a known place, puts a viewport of known size inside it at a
// known chrome offset, and asks for an element whose true snapshot rectangle is
// therefore known exactly. A real capture can show that a box appeared; only
// this can show it appeared in the right PLACE, to the pixel.
//
// Run: npm run check:dom
import { ChromeDomProvider } from '../src/main/context/domProvider'
import {
  ContextBuffer,
  mintSurfaceIds,
  surfaceSamplesOf,
  type ContextObservation,
} from '../src/main/context/buffer'
import { WindowsUiaProvider } from '../src/main/context/provider'
import { parseDomPayload, type DomEvent } from '../src/main/chrome/domBridge'
import { documentElementAsPick as documentElementAsPickForTest } from '../src/main/context/domProvider'
import type { Rect, SurfaceInfo } from '../src/shared/context/protocol'
import { claimCovers } from '../src/shared/context/resolver'

// --- the synthetic desk ----------------------------------------------------
// A 2x HiDPI display: 1 CSS px = 2 snapshot px, so a bug that silently assumes
// 1:1 cannot pass. Browser chrome (tab strip + omnibox) is 128 snapshot px.
const SCALE = 2
const CHROME_PX = 128
const WINDOW: Rect = { x: 500, y: 300, width: 2000, height: 1400 }
// The client area: the frame minus a border, which is what the ring records.
const CLIENT: Rect = { x: 508, y: 340, width: 1984, height: 1352 }
const VIEWPORT_CSS = { width: CLIENT.width / SCALE, height: (CLIENT.height - CHROME_PX) / SCALE }

function browserAt(x: number, y: number): SurfaceInfo {
  const dx = x - WINDOW.x
  const dy = y - WINDOW.y
  return {
    surfaceId: 'surf-chrome-1',
    hwnd: '4242',
    bounds: { ...WINDOW, x, y },
    clientBounds: { ...CLIENT, x: CLIENT.x + dx, y: CLIENT.y + dy },
    space: 'display-snapshot',
    display: 1,
    zOrder: 0,
    visible: true,
    minimized: false,
    foreground: true,
    executableName: 'chrome.exe',
    windowTitle: 'CapturePack — the docs - Google Chrome',
    className: 'Chrome_WidgetWin_1',
  }
}

/** An element at (ex, ey) CSS px inside the viewport, w x h CSS px. */
function pick(tMs: number, ex: number, ey: number, w: number, h: number): DomEvent {
  return {
    tMs,
    type: 'dom.element.selected',
    tab: { url: 'https://capturepack.dev/docs', title: 'CapturePack — the docs' },
    element: {
      tag: 'button',
      selector: '#save',
      bounds: { x: ex, y: ey, width: w, height: h },
      id: 'save',
      role: 'button',
      text: 'Save',
    },
    viewport: {
      width: VIEWPORT_CSS.width,
      height: VIEWPORT_CSS.height,
      dpr: SCALE,
      screenX: null,
      screenY: null,
      outerWidth: null,
      outerHeight: null,
    },
  }
}

/** The truth: where that element really is, in snapshot pixels. */
function truth(ex: number, ey: number, w: number, h: number, dx = 0, dy = 0): Rect {
  return {
    x: CLIENT.x + ex * SCALE + dx,
    y: CLIENT.y + CHROME_PX + ey * SCALE + dy,
    width: w * SCALE,
    height: h * SCALE,
  }
}

function near(a: Rect, b: Rect, tol = 1): boolean {
  return (
    Math.abs(a.x - b.x) <= tol &&
    Math.abs(a.y - b.y) <= tol &&
    Math.abs(a.width - b.width) <= tol &&
    Math.abs(a.height - b.height) <= tol
  )
}

const fmt = (r: Rect): string => `(${r.x},${r.y}) ${r.width}x${r.height}`

async function candidateAt(
  provider: ChromeDomProvider,
  timeMs: number,
  surfaces: readonly SurfaceInfo[],
): Promise<Rect | null> {
  const frame = await provider.frame({
    sessionId: 'check',
    timeMs,
    surfaces,
    maxCandidates: 100,
  } as never)
  const first = frame.candidates[0]
  return first === undefined ? null : first.bounds
}

const scaleMap = (entries: ReadonlyArray<readonly [number, number]>) => {
  const values = new Map(entries)
  return (display: number): number | null => values.get(display) ?? null
}

async function main(): Promise<void> {
  let failures = 0
  const report = (name: string, ok: boolean, detail: string): void => {
    if (!ok) failures += 1
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }

  // 1. THE CORE CLAIM: an element lands on the element, on a 2x display, with
  //    real browser chrome above the viewport.
  {
    const ev = pick(1000, 300, 200, 120, 40)
    const still = browserAt(WINDOW.x, WINDOW.y)
    const provider = new ChromeDomProvider([ev], () => [still])
    const got = await candidateAt(provider, 1000, [still])
    const want = truth(300, 200, 120, 40)
    report(
      'element lands on the element',
      got !== null && near(got, want),
      got === null ? 'no candidate at all' : `got ${fmt(got)} want ${fmt(want)}`,
    )
  }

  // 2. THE WHOLE POINT: it must NOT be the window. A candidate that merely
  //    exists but covers the browser is the bug wearing a disguise.
  {
    const ev = pick(1000, 300, 200, 120, 40)
    const still = browserAt(WINDOW.x, WINDOW.y)
    const provider = new ChromeDomProvider([ev], () => [still])
    const got = await candidateAt(provider, 1000, [still])
    const windowArea = WINDOW.width * WINDOW.height
    const gotArea = got === null ? 0 : got.width * got.height
    report(
      'the box is the element, not the browser window',
      got !== null && gotArea < windowArea * 0.1,
      got === null ? 'no candidate' : `${String(Math.round((gotArea / windowArea) * 100))}% of the window`,
    )
  }

  // 3. OBSERVED MEANS OBSERVED: owner-window motion is not an observation of
  //    the child. A page can scroll or reflow independently, so the nearest DOM
  //    rectangle must be returned byte-for-byte instead of translated.
  {
    const ev = pick(1000, 300, 200, 120, 40)
    const atPick = browserAt(WINDOW.x, WINDOW.y)
    const later = browserAt(WINDOW.x + 400, WINDOW.y + 250)
    const provider = new ChromeDomProvider([ev], (t) => [t <= 1000 ? atPick : later])
    const got = await candidateAt(provider, 5000, [later])
    const want = truth(300, 200, 120, 40)
    report(
      'owner motion does not invent a new DOM element rectangle',
      got !== null && near(got, want),
      got === null ? 'no candidate' : `got ${fmt(got)} want ${fmt(want)}`,
    )
  }

  // 4. REFUSES RATHER THAN GUESSES: two browser windows showing the same page
  //    is real ambiguity, and a box on the wrong one is worse than no box.
  {
    const ev = pick(1000, 300, 200, 120, 40)
    const a = browserAt(WINDOW.x, WINDOW.y)
    const b = { ...browserAt(WINDOW.x + 900, WINDOW.y), surfaceId: 'surf-chrome-2', hwnd: '99' }
    const provider = new ChromeDomProvider([ev], () => [a, b])
    const got = await candidateAt(provider, 1000, [a, b])
    report('ambiguous window match offers nothing', got === null, got === null ? '' : `offered ${fmt(got)}`)
  }

  // 5. REFUSES A NON-BROWSER: a pick can only have come from a browser, so a
  //    desk with no browser on it must not attribute one to Notepad.
  {
    const ev = pick(1000, 300, 200, 120, 40)
    const notepad = { ...browserAt(WINDOW.x, WINDOW.y), executableName: 'notepad.exe' }
    const provider = new ChromeDomProvider([ev], () => [notepad])
    const got = await candidateAt(provider, 1000, [notepad])
    report('non-browser window offers nothing', got === null, got === null ? '' : `offered ${fmt(got)}`)
  }

  // 6. REFUSES WITHOUT AN ANCHOR: an event from an extension older than 0.1.4
  //    carries no viewport, and nothing can place it. It must be dropped, not
  //    placed at the window's origin (which is the whole-window bug again).
  {
    const ev = pick(1000, 300, 200, 120, 40)
    const noViewport: DomEvent = { ...ev }
    delete (noViewport as { viewport?: unknown }).viewport
    const still = browserAt(WINDOW.x, WINDOW.y)
    const provider = new ChromeDomProvider([noViewport], () => [still])
    const got = await candidateAt(provider, 1000, [still])
    report('a pick with no anchor offers nothing', got === null, got === null ? '' : `offered ${fmt(got)}`)
  }

  // 7. THE SCALE IS DERIVED, NOT ASSUMED: the same page on a 1x display must
  //    also land, which a hard-coded devicePixelRatio would break.
  {
    const client1x: Rect = { x: 100, y: 80, width: 1200, height: 800 }
    const chrome1x = 90
    const surface1x: SurfaceInfo = {
      ...browserAt(WINDOW.x, WINDOW.y),
      bounds: { x: 90, y: 40, width: 1220, height: 860 },
      clientBounds: client1x,
    }
    const ev: DomEvent = {
      ...pick(1000, 300, 200, 120, 40),
      viewport: {
        width: client1x.width,
        height: client1x.height - chrome1x,
        dpr: 1,
        screenX: null,
        screenY: null,
        outerWidth: null,
        outerHeight: null,
      },
    }
    const provider = new ChromeDomProvider([ev], () => [surface1x])
    const got = await candidateAt(provider, 1000, [surface1x])
    const want: Rect = { x: client1x.x + 300, y: client1x.y + chrome1x + 200, width: 120, height: 40 }
    report(
      'derives the scale (1x display, different chrome height)',
      got !== null && near(got, want),
      got === null ? 'no candidate' : `got ${fmt(got)} want ${fmt(want)}`,
    )
  }

  // 8. PAST FRAMES ARE FIRST-CLASS: the nearest observed DOM rectangle remains
  //    useful before its event, with temporal error attached. Its coordinates
  //    are still the observation, never a spatial estimate.
  {
    const ev = pick(5000, 300, 200, 120, 40)
    const earlier = browserAt(WINDOW.x - 200, WINDOW.y - 100)
    const atPick = browserAt(WINDOW.x, WINDOW.y)
    const provider = new ChromeDomProvider([ev], (t) => [t < ev.tMs ? earlier : atPick])
    const got = await candidateAt(provider, 1000, [earlier])
    const want = truth(300, 200, 120, 40)
    report(
      'a past frame reuses the nearest DOM observation unchanged',
      got !== null && near(got, want),
      got === null ? 'no candidate' : `got ${fmt(got)} want ${fmt(want)}`,
    )
  }

  // 9. REOPEN USES THE DISK VOCABULARY: elements.json stores `t_ms`, while a
  //    live bridge event uses `tMs`. The parser and provider together must
  //    reproduce the same candidate or a reopened pack silently loses DOM.
  {
    const ev = pick(1000, 300, 200, 120, 40)
    const { tMs, ...stored } = ev
    const reopened = parseDomPayload(JSON.stringify({ events: [{ ...stored, t_ms: tMs }] }))
    const still = browserAt(WINDOW.x, WINDOW.y)
    const provider = new ChromeDomProvider(reopened, () => [still])
    const got = await candidateAt(provider, 1000, [still])
    const want = truth(300, 200, 120, 40)
    report(
      'a saved DOM pick survives elements.json parse and reopen',
      reopened.length === 1 && got !== null && near(got, want),
      `events ${String(reopened.length)}, ${got === null ? 'no candidate' : `got ${fmt(got)} want ${fmt(want)}`}`,
    )
  }

  // 10. CROSS-DISPLAY DPI + RESIZE: neither a new display nor a new DPI scale
  //     licenses rewriting an old element observation.
  {
    const past = pick(1000, 300, 200, 120, 40)
    const future = pick(3000, 500, 240, 120, 40)
    const stored = [future, past].map(({ tMs, ...event }) => ({
      ...event,
      t_ms: tMs,
    }))
    const reopened = parseDomPayload(JSON.stringify({ events: stored }))
    const still = browserAt(WINDOW.x, WINDOW.y)
    const provider = new ChromeDomProvider(reopened, () => [still])
    const frame = await provider.frame({
      sessionId: 'dom-temporal-tie',
      timeMs: 2000,
      surfaces: [still],
      maxCandidates: 100,
    })
    report(
      'reopened DOM observations are chronological and an exact distance tie keeps the past',
      reopened.map((event) => event.tMs).join(',') === '1000,3000'
        && frame.accuracy.materializedTimeMs === 1000
        && frame.accuracy.errorMs === 1000,
      `events ${reopened.map((event) => event.tMs).join(',')}, materialized ${String(frame.accuracy.materializedTimeMs)}`,
    )
  }

  // 11. CROSS-DISPLAY DPI + RESIZE: neither a new display nor a new DPI scale
  //     licenses rewriting an old element observation.
  {
    const ev = pick(1000, 300, 200, 120, 40)
    const atPick = browserAt(WINDOW.x, WINDOW.y)
    const later: SurfaceInfo = {
      ...browserAt(100, 50),
      display: 2,
      bounds: { x: 100, y: 50, width: 2000, height: 1400 },
      clientBounds: { x: 104, y: 70, width: 1984, height: 1352 },
    }
    const provider = new ChromeDomProvider(
      [ev],
      (t) => [t <= ev.tMs ? atPick : later],
      scaleMap([[1, 2], [2, 1]]),
    )
    const got = await candidateAt(provider, 5000, [later])
    const want = truth(300, 200, 120, 40)
    report(
      'cross-display owner motion leaves the DOM observation unchanged',
      got !== null && near(got, want),
      got === null ? 'no candidate' : `got ${fmt(got)} want ${fmt(want)}`,
    )
  }

  // 11. SAME SCALE, DIFFERENT DISPLAY: the no-invention rule is independent of
  //     whether the two displays happen to share a scale.
  {
    const ev = pick(1000, 300, 200, 120, 40)
    const atPick = browserAt(WINDOW.x, WINDOW.y)
    const later: SurfaceInfo = {
      ...browserAt(50, 30),
      display: 2,
      bounds: { x: 50, y: 30, width: 1100, height: 950 },
      clientBounds: { x: 60, y: 50, width: 1000, height: 900 },
    }
    const provider = new ChromeDomProvider(
      [ev],
      (t) => [t <= ev.tMs ? atPick : later],
      scaleMap([[1, 2], [2, 2]]),
    )
    const got = await candidateAt(provider, 5000, [later])
    const want = truth(300, 200, 120, 40)
    report(
      'same-scale owner motion leaves the DOM observation unchanged',
      got !== null && near(got, want),
      got === null ? 'no candidate' : `got ${fmt(got)} want ${fmt(want)}`,
    )
  }

  // 12. MISSING SCALE: no transform is needed to quote the observed rectangle.
  {
    const ev = pick(1000, 300, 200, 120, 40)
    const atPick = browserAt(WINDOW.x, WINDOW.y)
    const later: SurfaceInfo = {
      ...browserAt(100, 50),
      display: 2,
      bounds: { x: 100, y: 50, width: 2000, height: 1400 },
      clientBounds: { x: 104, y: 70, width: 1984, height: 1352 },
    }
    const provider = new ChromeDomProvider([ev], (t) => [t <= ev.tMs ? atPick : later])
    const got = await candidateAt(provider, 5000, [later])
    const want = truth(300, 200, 120, 40)
    report(
      'missing target-display DPI still preserves the observed rectangle',
      got !== null && near(got, want),
      got === null ? 'no candidate' : `got ${fmt(got)} want ${fmt(want)}`,
    )
  }

  // 13. IDENTITY + PER-CANDIDATE TIME: two picks can arrive in the same
  //     rounded millisecond. They remain distinct, and an exact frame for the
  //     second pick must not falsely make the older candidate exact too.
  {
    const first = pick(1000, 300, 200, 120, 40)
    const second: DomEvent = {
      ...pick(5000, 400, 260, 100, 30),
      element: {
        ...(pick(5000, 400, 260, 100, 30).element as NonNullable<DomEvent['element']>),
        selector: '#save',
      },
    }
    const sameMs = { ...second, tMs: first.tMs }
    const still = browserAt(WINDOW.x, WINDOW.y)
    const sameMsProvider = new ChromeDomProvider([first, sameMs], () => [still])
    const sameMsFrame = await sameMsProvider.frame({
      sessionId: 'check',
      timeMs: first.tMs,
      surfaces: [still],
      maxCandidates: 100,
    })
    const ids = new Set(sameMsFrame.candidates.map((candidate) => candidate.objectId))
    report(
      'same-ms same-selector DOM picks keep distinct object ids',
      sameMsFrame.candidates.length === 2 && ids.size === 2,
      `${String(sameMsFrame.candidates.length)} candidates / ${String(ids.size)} ids`,
    )

    const timedProvider = new ChromeDomProvider([first, second], () => [still])
    const timedFrame = await timedProvider.frame({
      sessionId: 'check',
      timeMs: second.tMs,
      surfaces: [still],
      maxCandidates: 100,
    })
    const exact = timedFrame.candidates.filter((candidate) => candidate.accuracy.exact)
    const stale = timedFrame.candidates.find((candidate) => candidate.accuracy.errorMs === 4000)
    report(
      'DOM time accuracy is per candidate, not copied from the nearest pick',
      timedFrame.accuracy.exact
        && timedFrame.accuracy.materializedTimeMs === second.tMs
        && exact.length === 1
        && stale?.accuracy.errorMs === 4000
        && stale.accuracy.interpolated !== true,
      `frame error ${String(timedFrame.accuracy.errorMs)}, exact candidates ${String(exact.length)}`,
    )
  }

  // 14. MULTI-SLICE SURFACE: a window spanning two monitors has one surfaceId
  //     but one clipped rectangle per display. Order and window-slice area must
  //     not pull the DOM element onto the display where it is not visible.
  {
    const ev = pick(1000, 300, 200, 120, 40)
    const firstSlice: SurfaceInfo = {
      ...browserAt(WINDOW.x, WINDOW.y),
      display: 1,
      bounds: { x: 0, y: 0, width: 700, height: 700 },
      clientBounds: { ...CLIENT, x: -1400, y: 40 },
    }
    const secondSlice: SurfaceInfo = {
      ...browserAt(WINDOW.x, WINDOW.y),
      display: 2,
      bounds: { x: 0, y: 0, width: 500, height: 700 },
      clientBounds: { ...CLIENT, x: -200, y: 40 },
    }
    const slices = [secondSlice, firstSlice]
    const provider = new ChromeDomProvider(
      [ev],
      () => [firstSlice, secondSlice],
      scaleMap([[1, 2], [2, 2]]),
    )
    const frame = await provider.frame({
      sessionId: 'check',
      timeMs: ev.tMs,
      surfaces: slices,
      maxCandidates: 100,
    })
    const claims = await provider.getSurfaceClaims({
      sessionId: 'check',
      timeMs: ev.tMs,
      surfaces: slices,
    })
    const candidate = frame.candidates[0]
    const displayOneClaims = claims.filter((claim) => claim.display === 1)
    report(
      'spanning-window DOM candidate and claims preserve the visible display slice',
      candidate?.display === 2
        && candidate.bounds.x === 400
        && claims.length === 1
        && claims[0]?.display === 2
        && !claimCovers(
          displayOneClaims,
          candidate.providerId,
          candidate.surfaceId,
          { x: candidate.bounds.x, y: candidate.bounds.y },
          2,
        ),
      candidate === undefined
        ? 'no candidate'
        : `display ${String(candidate.display)}, x ${String(candidate.bounds.x)}, claims ${String(claims.length)}`,
    )
  }

  // 15. HOSTILE GEOMETRY: a local pipe or edited elements.json can carry bad
  //     values. Negative dimensions must be rejected before arithmetic.
  {
    const ev = pick(1000, 300, 200, -120, 40)
    const still = browserAt(WINDOW.x, WINDOW.y)
    const provider = new ChromeDomProvider([ev], () => [still])
    const got = await candidateAt(provider, ev.tMs, [still])
    const { tMs, ...stored } = ev
    const reopened = parseDomPayload(JSON.stringify({ events: [{ ...stored, t_ms: tMs }] }))
    report(
      'negative DOM geometry is rejected on the wire, reopen, and provider seams',
      got === null && reopened.length === 0,
      got === null ? `reopened events ${String(reopened.length)}` : `offered ${fmt(got)}`,
    )
  }

  // 16. UIA USES THE SAME POLICY: a legacy/capture checkpoint can be the
  //     nearest control observation even when the owner window later moved.
  //     The control rectangle itself must not be carried by that window delta.
  {
    const observed: ContextObservation = {
      tMs: 1000,
      windows: [
        {
          surface_id: 'uia-owner',
          hwnd: '7001',
          title: 'Observed UIA owner',
          process: 'observed-app',
          class_name: 'ObservedWindow',
          bounds: { x: 100, y: 80, width: 800, height: 600 },
          client_bounds: { x: 108, y: 112, width: 784, height: 560 },
          display: 1,
          focused: true,
          z: 0,
          hasControls: true,
          tree: 'collected',
        },
      ],
      elements: [
        {
          name: 'Observed button',
          control_type: 'Button',
          automation_id: 'observed-button',
          class_name: 'Button',
          bounds: { x: 220, y: 260, width: 120, height: 40 },
          display: 1,
          window: 0,
        },
      ],
    }
    const ids = mintSurfaceIds([observed])
    const buffer = new ContextBuffer([observed], 'single-instant', {
      startMs: observed.tMs,
      endMs: observed.tMs,
    })
    const provider = new WindowsUiaProvider(buffer, ids)
    const sourceSurface = surfaceSamplesOf([observed], ids)[0]?.surfaces[0]
    if (sourceSurface === undefined) throw new Error('UIA observation fixture has no surface')
    const movedSurface: SurfaceInfo = {
      ...sourceSurface,
      bounds: { ...sourceSurface.bounds, x: sourceSurface.bounds.x + 300 },
      clientBounds:
        sourceSurface.clientBounds === undefined
          ? undefined
          : {
              ...sourceSurface.clientBounds,
              x: sourceSurface.clientBounds.x + 300,
            },
    }
    const frame = await provider.frame({
      sessionId: 'semantic-observation-policy',
      timeMs: 5000,
      surfaces: [movedSurface],
      maxCandidates: 100,
    } as never)
    const candidate = frame.candidates.find(
      (item) => item.identity?.['automation_id'] === 'observed-button',
    )
    const want = observed.elements[0]?.bounds
    report(
      'owner motion does not invent a new UIA control rectangle',
      candidate !== undefined
        && want !== undefined
        && near(candidate.bounds, want)
        && candidate.accuracy.interpolated !== true,
      candidate === undefined
        ? 'no candidate'
        : `got ${fmt(candidate.bounds)} want ${want === undefined ? 'missing' : fmt(want)}`,
    )
  }

  // THE DOCUMENT A PICK CARRIES IS UNTRUSTED INPUT (GOAL "The still carries the
// context").
//
// It comes from a browser extension over a native-messaging pipe, so nothing is
// trusted into a pack: unknown keys are dropped rather than carried, every
// string is clipped, and an element without a usable rectangle is refused
// rather than defaulted. A malformed document costs the pack its document,
// never its pick.
console.log('\nA picked document is parsed, not believed')
{
  const check = (name: string, ok: boolean, detail = ''): void => { report(name, ok, detail) }
  const wire = (document_: unknown): string =>
    JSON.stringify({
      events: [
        {
          t_ms: 1000,
          type: 'dom.element.selected',
          protocol: 1,
          tab: { url: 'https://example.invalid/', title: 'Fixture' },
          element: {
            tag: 'button',
            selector: '#go',
            bounds: { x: 1, y: 2, width: 3, height: 4 },
          },
          viewport: { width: 1000, height: 800, dpr: 1 },
          document: document_,
        },
      ],
    })

  const good = {
    viewport: { width: 1000, height: 800, devicePixelRatio: 1, scrollX: 0, scrollY: 0 },
    url: 'https://example.invalid/',
    title: 'Fixture',
    elements: [
      { i: 0, tag: 'button', role: 'button', bounds: { x: 1, y: 2, width: 30, height: 12 }, text: 'Go' },
      { i: 1, tag: 'input', role: 'textbox', bounds: { x: 1, y: 20, width: 30, height: 12 }, type: 'password', secret: true },
    ],
    truncated: false,
    visitedCount: 9,
    elapsedMs: 3,
    omitted: ['the value of every input, textarea and select'],
  }

  const parsed = parseDomPayload(wire(good))
  const doc = parsed[0]?.document
  check(
    'a well-formed document reaches the event',
    doc !== undefined && doc.elements.length === 2 && doc.url === 'https://example.invalid/',
    JSON.stringify(doc?.elements.length),
  )
  check(
    "the extension's own statement of what it left out is carried, not dropped",
    doc?.omitted[0]?.includes('value of every input') === true,
    JSON.stringify(doc?.omitted),
  )
  check(
    'and a password box arrives as presence only',
    doc?.elements[1]?.secret === true && doc.elements[1]?.name === undefined,
    JSON.stringify(doc?.elements[1]),
  )

  // A key nobody defined must not ride into a pack just because it was sent.
  const smuggled = parseDomPayload(
    wire({
      ...good,
      elements: [
        {
          tag: 'input',
          role: 'textbox',
          bounds: { x: 1, y: 2, width: 3, height: 4 },
          value: 'hunter2',
          'data-token': 'eyJhbGciOiJIUzI1NiJ9',
          onclick: 'steal()',
        },
      ],
    }),
  )
  check(
    'an unknown key is dropped rather than carried through',
    !JSON.stringify(smuggled).includes('hunter2')
      && !JSON.stringify(smuggled).includes('eyJhbGciOiJIUzI1NiJ9')
      && !JSON.stringify(smuggled).includes('steal'),
    JSON.stringify(smuggled[0]?.document?.elements),
  )

  // Every refusal below keeps the pick and loses only the document.
  const broken: Array<[string, unknown]> = [
    ['a viewport of zero size', { ...good, viewport: { ...good.viewport, width: 0 } }],
    ['an impossible device pixel ratio', { ...good, viewport: { ...good.viewport, devicePixelRatio: 99 } }],
    ['no elements array at all', { ...good, elements: undefined }],
    ['not an object', 'a string'],
  ]
  for (const [label, document_] of broken) {
    const out = parseDomPayload(wire(document_))
    check(
      `${label}: the pick survives and the document does not`,
      out.length === 1 && out[0]?.element !== undefined && out[0]?.document === undefined,
      `${String(out.length)} event(s), document ${String(out[0]?.document !== undefined)}`,
    )
  }

  const noRect = parseDomPayload(
    wire({ ...good, elements: [{ tag: 'div', role: '', bounds: { x: 1, y: 2 } }] }),
  )
  check(
    'an element with no usable rectangle is skipped, not placed at zero',
    noRect[0]?.document?.elements.length === 0,
    JSON.stringify(noRect[0]?.document?.elements),
  )

  // More than the host will hold is a prefix, and the pack has to say so rather
  // than look like the whole page.
  const many = Array.from({ length: 5000 }, (_v, i) => ({
    tag: 'span',
    role: '',
    bounds: { x: i, y: 0, width: 1, height: 1 },
  }))
  const capped = parseDomPayload(wire({ ...good, elements: many, truncated: false }))
  check(
    'a document larger than the cap is truncated and says so',
    capped[0]?.document?.elements.length === 4000
      && capped[0]?.document?.truncated === true,
    `${String(capped[0]?.document?.elements.length)} kept, truncated ${String(capped[0]?.document?.truncated)}`,
  )

  const older = parseDomPayload(
    JSON.stringify({
      events: [
        {
          t_ms: 1000,
          type: 'dom.element.selected',
          protocol: 1,
          tab: { url: 'https://example.invalid/', title: 'Fixture' },
          element: {
            tag: 'button',
            selector: '#go',
            bounds: { x: 1, y: 2, width: 3, height: 4 },
          },
        },
      ],
    }),
  )
  check(
    'an extension too old to send one is not a broken pick',
    older.length === 1 && older[0]?.element !== undefined && older[0]?.document === undefined,
  )
}

  // A CAPTURED DOCUMENT IS EVERY ELEMENT, NOT ONE (#130).
  //
  // The provider only ever understood `dom.element.selected`, so the document
  // fetched at the capture instant reached the pack and stopped: 340 rectangles on
  // disk, none of them offered to the editor. From outside that is
  // indistinguishable from never collecting it.
  console.log('\nEvery element of a captured document is offered, not just a pick')
  {
    const viewport = { width: 1000, height: 800, dpr: 1, screenX: 100, screenY: 50, outerWidth: 1000, outerHeight: 900 }
    const doc = {
      viewport: { width: 1000, height: 800, devicePixelRatio: 1, scrollX: 0, scrollY: 0 },
      url: 'https://example.invalid/',
      title: 'Fixture',
      elements: [
        { i: 0, tag: 'button', role: 'button', bounds: { x: 10, y: 20, width: 80, height: 30 }, id: 'go', text: 'Go' },
        { i: 1, tag: 'a', role: 'link', bounds: { x: 10, y: 60, width: 120, height: 20 }, class: 'nav main extra fourth', text: 'Home' },
        { i: 2, tag: 'div', role: '', bounds: { x: 0, y: 0, width: 1000, height: 800 } },
      ],
      truncated: false,
      visitedCount: 3,
      elapsedMs: 1,
      omitted: [],
    }
    const events = parseDomPayload(
      JSON.stringify({
        events: [{
          t_ms: 1000,
          type: 'dom.document.captured',
          protocol: 1,
          tab: { url: 'https://example.invalid/', title: 'Fixture' },
          viewport,
          document: doc,
        }],
      }),
    )
    report(
      'a captured document survives the parser',
      events.length === 1 && events[0]?.document !== undefined,
      `${String(events.length)} event(s)`,
    )
    report(
      'and it keeps the viewport that places it',
      events[0]?.viewport?.screenX === 100,
      JSON.stringify(events[0]?.viewport),
    )
    // The identity a reader gets for an element the walker never selectored.
    const built = documentElementAsPickForTest(doc.elements[0] as never)
    report(
      'an id becomes the selector, because an id is unique by definition',
      built.selector === '#go', built.selector)
    const byClass = documentElementAsPickForTest(doc.elements[1] as never)
    report(
      'otherwise the tag and up to three classes identify it',
      byClass.selector === 'a.nav.main.extra', byClass.selector)
    const bare = documentElementAsPickForTest(doc.elements[2] as never)
    report(
      'and a bare tag is the honest floor, not an invented nth-child chain',
      bare.selector === 'div', bare.selector)
  }

  // A SCREENSHOT CONTAINS EVERY BROWSER WINDOW (#132).
  //
  // Reported as "유튜브는 되는데 왜 깃허브는 안되냐": two Chrome windows on the desk,
  // and the pack carried one page — the extension had asked `lastFocusedWindow`.
  // The fix is in the extension, but it is only SUFFICIENT if this layer can
  // take N documents and send each to its own window, so that is what this
  // proves: two pages, two windows, each element on the monitor coordinates of
  // the window whose tab it actually belongs to.
  console.log('\nWith two browser windows open, each page lands on its own window')
  {
    const at = (id: string, hwnd: string, title: string, x: number, y: number): SurfaceInfo => ({
      surfaceId: id,
      hwnd,
      bounds: { ...WINDOW, x, y },
      clientBounds: {
        x: CLIENT.x + (x - WINDOW.x),
        y: CLIENT.y + (y - WINDOW.y),
        width: CLIENT.width,
        height: CLIENT.height,
      },
      space: 'display-snapshot',
      display: 1,
      zOrder: 0,
      visible: true,
      minimized: false,
      // Neither is foreground: the capture hotkey is a global OS key, so the
      // user is usually not even in Chrome when the shutter fires.
      foreground: false,
      executableName: 'chrome.exe',
      windowTitle: `${title} - Google Chrome`,
      className: 'Chrome_WidgetWin_1',
    })
    const captured = (title: string, ex: number, ey: number): DomEvent => ({
      tMs: 0,
      type: 'dom.document.captured',
      tab: { url: `https://example.invalid/${encodeURIComponent(title)}`, title },
      viewport: {
        width: VIEWPORT_CSS.width,
        height: VIEWPORT_CSS.height,
        dpr: SCALE,
        screenX: null,
        screenY: null,
        outerWidth: null,
        outerHeight: null,
      },
      document: {
        viewport: {
          width: VIEWPORT_CSS.width,
          height: VIEWPORT_CSS.height,
          devicePixelRatio: SCALE,
          scrollX: 0,
          scrollY: 0,
        },
        url: `https://example.invalid/${encodeURIComponent(title)}`,
        title,
        elements: [
          {
            i: 0,
            tag: 'button',
            role: 'button',
            bounds: { x: ex, y: ey, width: 100, height: 40 },
            text: title,
          },
        ],
        truncated: false,
        visitedCount: 1,
        elapsedMs: 1,
        omitted: [],
      },
    })
    const left = at('surf-left', '1001', 'YouTube', 100, 100)
    const right = at('surf-right', '1002', 'r2cuerdame/WSLPad', 2600, 100)
    const desk = [left, right]
    const provider = new ChromeDomProvider(
      [captured('YouTube', 40, 60), captured('r2cuerdame/WSLPad', 40, 60)],
      () => desk,
    )
    const frame = await provider.frame({
      sessionId: 'check',
      timeMs: 0,
      surfaces: desk,
      maxCandidates: 100,
    } as never)
    report(
      'both windows produce a candidate, not just the one that was focused',
      frame.candidates.length === 2,
      `${String(frame.candidates.length)} candidate(s)`,
    )
    // The same element offset in both pages: identical rectangles would mean the
    // second document was placed on the FIRST window, which is the failure this
    // scenario exists to catch.
    const placedOn = (id: string): Rect | undefined =>
      frame.candidates.find((c) => c.surfaceId === id)?.bounds
    const want = (surface: SurfaceInfo): Rect => ({
      x: (surface.clientBounds?.x ?? 0) + 40 * SCALE,
      y: (surface.clientBounds?.y ?? 0) + CHROME_PX + 60 * SCALE,
      width: 100 * SCALE,
      height: 40 * SCALE,
    })
    for (const surface of desk) {
      const got = placedOn(surface.surfaceId)
      report(
        `${surface.windowTitle ?? '?'}: its element sits in ITS window`,
        got !== undefined && near(got, want(surface)),
        got === undefined ? 'no candidate' : `${fmt(got)} want ${fmt(want(surface))}`,
      )
    }
    report(
      'and the two are in different places, on different monitors coordinates',
      placedOn('surf-left')?.x !== placedOn('surf-right')?.x,
      `${String(placedOn('surf-left')?.x)} vs ${String(placedOn('surf-right')?.x)}`,
    )

    // AMBIGUITY IS STILL REFUSED, AND IT GETS MORE LIKELY WITH MORE WINDOWS.
    // "GitHub" is contained in "GitHub Docs - Google Chrome" as well as its own
    // title, and `place()` matches by containment. Two windows, one tab title,
    // no honest answer: a box on the wrong browser is worse than no box.
    const twin = at('surf-twin', '1003', 'YouTube Music', 100, 1600)
    const ambiguous = new ChromeDomProvider([captured('YouTube', 40, 60)], () => [left, twin])
    const confused = await ambiguous.frame({
      sessionId: 'check',
      timeMs: 0,
      surfaces: [left, twin],
      maxCandidates: 100,
    } as never)
    report(
      'a tab title that matches two windows is refused, not guessed at',
      confused.candidates.length === 0,
      `${String(confused.candidates.length)} candidate(s)`,
    )
  }

console.log(failures === 0 ? '\ndom-provider-check ok' : `\ndom-provider-check FAILED (${String(failures)})`)
  if (failures > 0) process.exitCode = 1
}

void main()
