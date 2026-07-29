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
import { parseDomPayload, type DomEvent } from '../src/main/chrome/domBridge'
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

  // 3. ANCHORED IN TIME: the window is dragged 400 x 250 after the pick; the
  //    element must travel with it, because it is drawn inside it.
  {
    const ev = pick(1000, 300, 200, 120, 40)
    const atPick = browserAt(WINDOW.x, WINDOW.y)
    const later = browserAt(WINDOW.x + 400, WINDOW.y + 250)
    const provider = new ChromeDomProvider([ev], (t) => [t <= 1000 ? atPick : later])
    const got = await candidateAt(provider, 5000, [later])
    const want = truth(300, 200, 120, 40, 400, 250)
    report(
      'the element follows its window',
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

  // 8. PAST FRAMES ARE FIRST-CLASS: the pick is exact at its event time, but
  //    its offset inside a browser tracked by the ring is still a useful,
  //    explicitly interpolated answer before that instant too. This is the
  //    editor path used after scrubbing away from the capture frame.
  {
    const ev = pick(5000, 300, 200, 120, 40)
    const earlier = browserAt(WINDOW.x - 200, WINDOW.y - 100)
    const atPick = browserAt(WINDOW.x, WINDOW.y)
    const provider = new ChromeDomProvider([ev], (t) => [t < ev.tMs ? earlier : atPick])
    const got = await candidateAt(provider, 1000, [earlier])
    const want = truth(300, 200, 120, 40, -200, -100)
    report(
      'a DOM element remains pickable in a past frame',
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

  // 10. CROSS-DISPLAY DPI + RESIZE: a browser moved from a 2x display to a 1x
  //     display keeps the same DIP element geometry, so the rectangle halves
  //     even if the user independently resizes the target window. Deriving the
  //     ratio from client width would mistake that resize for another DPI
  //     transform and cannot pass this case.
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
    const want: Rect = { x: 404, y: 334, width: 120, height: 40 }
    report(
      'cross-display DPI is independent of target window resize',
      got !== null && near(got, want),
      got === null ? 'no candidate' : `got ${fmt(got)} want ${fmt(want)}`,
    )
  }

  // 11. SAME SCALE, DIFFERENT DISPLAY: crossing monitor ids is not itself a
  //     resize. A simultaneous client resize must not change the old observed
  //     element's size when both snapshots have the same px-per-DIP scale.
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
    const want: Rect = { x: 660, y: 578, width: 240, height: 80 }
    report(
      'same-scale monitor move does not turn window resize into element scaling',
      got !== null && near(got, want),
      got === null ? 'no candidate' : `got ${fmt(got)} want ${fmt(want)}`,
    )
  }

  // 12. MISSING SCALE: a legacy caller that cannot identify either captured
  //     display's pixel scale must not guess from window dimensions.
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
    report('cross-display placement refuses missing DPI metadata', got === null, got === null ? '' : `offered ${fmt(got)}`)
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
        && stale?.accuracy.interpolated === true,
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
        && claims.length === 2
        && new Set(claims.map((claim) => claim.display)).size === 2
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

  console.log(failures === 0 ? '\ndom-provider-check ok' : `\ndom-provider-check FAILED (${String(failures)})`)
  if (failures > 0) process.exitCode = 1
}

void main()
