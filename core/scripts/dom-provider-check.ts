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
import type { DomEvent } from '../src/main/chrome/domBridge'
import type { Rect, SurfaceInfo } from '../src/shared/context/protocol'

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
    display: 0,
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

  console.log(failures === 0 ? '\ndom-provider-check ok' : `\ndom-provider-check FAILED (${String(failures)})`)
  if (failures > 0) process.exitCode = 1
}

void main()
