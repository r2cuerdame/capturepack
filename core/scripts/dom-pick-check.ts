// IS A PICKED DOM ELEMENT ACTUALLY OFFERED TO THE USER? (#104)
//
// WHY THIS EXISTS, NEXT TO `check:dom`. That check proves the Chrome DOM
// provider puts an element's rectangle in the right PLACE. It stops there — it
// never builds the editor's index, so it cannot see what the editor does with
// what the provider produced. Nothing in `core/scripts` joined the two, and in
// the gap between them sat the second half of #104: a `<main>` covering more
// than 35% of a browser window matched `isWindowFrame`, matched nothing in
// `LARGE_SEMANTIC_CONTROL_TYPES` (a UI Automation vocabulary — `document`,
// `list`, `tree`, a named `pane` — that no ARIA role or HTML tag can satisfy),
// and was dropped outright. The window then reported `refinement: 'none'`:
// "everything in it is a frame the window level covers better", about the one
// element the user had explicitly pointed at.
//
// So this drives the REAL provider into the REAL `ObjectIndex` and asks the
// only question that matters to a person: at the centre of what I picked, is
// the thing I picked what comes back?
//
// It asks through `frame()`, never `hitTest()` — `hitTest` has no production
// caller, so a check written against it would be testing a dead path.
//
// Run: npm run check:dom-pick
import { ChromeDomProvider } from '../src/main/context/domProvider'
import { windowCandidatesFromSurfaces } from '../src/main/context/buffer'
import type { DomEvent } from '../src/main/chrome/domBridge'
import type {
  ContextCandidate,
  ProviderSurfaceClaim,
  Rect,
  SurfaceInfo,
  TemporalAccuracy,
} from '../src/shared/context/protocol'
import { ObjectIndex, type PickableObject } from '../src/renderer/editor/objects'

// --- the synthetic desk ----------------------------------------------------
// One 2560x1440 display holding a maximised browser. 1 CSS px = 1 snapshot px
// so the arithmetic below stays readable; `check:dom` already owns the HiDPI
// coordinate proof and this check is about what happens AFTER placement.
const DISPLAY = { width: 2560, height: 1440 }
const WINDOW: Rect = { x: 0, y: 0, width: 2560, height: 1400 }
const CLIENT: Rect = { x: 0, y: 0, width: 2560, height: 1400 }
const CHROME_PX = 120
const VIEWPORT = { width: CLIENT.width, height: CLIENT.height - CHROME_PX }

const ACCURACY: TemporalAccuracy = {
  requestedTimeMs: 1000,
  materializedTimeMs: 1000,
  errorMs: 0,
  exact: true,
  coverage: 'covered',
}

const browser: SurfaceInfo = {
  surfaceId: 'surf-chrome-1',
  hwnd: '4242',
  bounds: { ...WINDOW },
  clientBounds: { ...CLIENT },
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

/** An element at (x, y) CSS px inside the viewport, w x h CSS px. */
function pick(
  tMs: number,
  tag: string,
  role: string,
  x: number,
  y: number,
  w: number,
  h: number,
): DomEvent {
  return {
    tMs,
    type: 'dom.element.selected',
    tab: { url: 'https://capturepack.dev/docs', title: 'CapturePack — the docs' },
    element: {
      tag,
      selector: `#${tag}`,
      bounds: { x, y, width: w, height: h },
      id: tag,
      role,
      text: tag,
    },
    viewport: {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      dpr: 1,
      screenX: null,
      screenY: null,
      outerWidth: null,
      outerHeight: null,
    },
  }
}

/**
 * A CAPTURED DOCUMENT — every element of the visible page, not one.
 *
 * This is what a still records since #130, and it is a different KIND of
 * evidence from `pick()` above even though both end up at `document-native`
 * authority: nobody pointed at any of these. A page's own layout wrappers are
 * in here, and they are the same shape UI Automation's client-area pane is.
 */
function documentSnapshot(
  tMs: number,
  elements: ReadonlyArray<{
    tag: string
    role?: string
    x: number
    y: number
    w: number
    h: number
  }>,
): DomEvent {
  return {
    tMs,
    type: 'dom.document.captured',
    tab: { url: 'https://capturepack.dev/docs', title: 'CapturePack — the docs' },
    viewport: {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      dpr: 1,
      screenX: null,
      screenY: null,
      outerWidth: null,
      outerHeight: null,
    },
    document: {
      viewport: {
        width: VIEWPORT.width,
        height: VIEWPORT.height,
        devicePixelRatio: 1,
        scrollX: 0,
        scrollY: 0,
      },
      url: 'https://capturepack.dev/docs',
      title: 'CapturePack — the docs',
      elements: elements.map((e, i) => ({
        i,
        tag: e.tag,
        role: e.role ?? '',
        bounds: { x: e.x, y: e.y, width: e.w, height: e.h },
        id: `${e.tag}-${String(i)}`,
      })),
      truncated: false,
    },
  } as DomEvent
}

/** Where that element really is on the snapshot. */
function truth(x: number, y: number, w: number, h: number): Rect {
  return { x: CLIENT.x + x, y: CLIENT.y + CHROME_PX + y, width: w, height: h }
}

let failures = 0
function report(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

/**
 * Everything the editor would have at one instant: Core's window rung plus the
 * Chrome DOM provider's candidates, through the provider's own `frame()`.
 */
async function indexFor(events: readonly DomEvent[]): Promise<{
  index: ObjectIndex
  candidates: readonly ContextCandidate[]
  claims: readonly ProviderSurfaceClaim[]
}> {
  const provider = new ChromeDomProvider(events, () => [browser])
  const frame = await provider.frame({
    sessionId: 'check',
    timeMs: 1000,
    surfaces: [browser],
    maxCandidates: 100,
  } as never)
  const claims = await provider.getSurfaceClaims({
    sessionId: 'check',
    timeMs: 1000,
    surfaces: [browser],
  } as never)
  const candidates: ContextCandidate[] = [
    ...windowCandidatesFromSurfaces([browser], ACCURACY),
    ...frame.candidates,
  ]
  const index = ObjectIndex.build(
    candidates,
    [browser],
    [],
    claims,
    DISPLAY.width,
    DISPLAY.height,
    1,
  )
  return { index, candidates, claims }
}

function centre(r: Rect): { x: number; y: number } {
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
}

function describe(o: PickableObject | null | undefined): string {
  if (o === null || o === undefined) return 'nothing'
  return `${o.level}/${o.authority}/${o.candidate.objectType} (${o.x},${o.y}) ${o.width}x${o.height}`
}

async function main(): Promise<void> {
  console.log('\nA small button — the case that has always been meant to work')
  {
    const element = { x: 300, y: 200, width: 120, height: 40 }
    const { index } = await indexFor([
      pick(1000, 'button', 'button', element.x, element.y, element.width, element.height),
    ])
    const want = truth(element.x, element.y, element.width, element.height)
    const at = centre(want)
    const top = index.stackAt(at.x, at.y).offered[0]
    report('the picked button is what the click takes',
      top?.authority === 'document-native', describe(top))
    report('it is offered at the rectangle the browser measured',
      top !== undefined && top.x === want.x && top.y === want.y
      && top.width === want.width && top.height === want.height,
      describe(top))
  }

  console.log('\nA full-width navigation bar — spans an axis, and is a real target')
  {
    // 100% of the window's width at 80 px tall: `isWindowFrame`'s side test
    // catches this for an enumerated control, and it is the most ordinary thing
    // on a web page.
    const element = { x: 0, y: 0, width: VIEWPORT.width, height: 80 }
    const { index } = await indexFor([
      pick(1000, 'nav', 'navigation', element.x, element.y, element.width, element.height),
    ])
    const want = truth(element.x, element.y, element.width, element.height)
    const at = centre(want)
    const top = index.stackAt(at.x, at.y).offered[0]
    report('the picked nav is offered, not collapsed into the window',
      top?.authority === 'document-native', describe(top))
  }

  console.log('\nA content column at 60% of the window — the case #104 deleted')
  {
    // 1560 x 1180 = 1.84 Mpx against the window's 3.58 Mpx: 51% of it, well past
    // WINDOW_FRAME_FRACTION (0.35) and matching nothing in the UI Automation
    // vocabulary `isLargeSemanticControl` reads. Before #104 this candidate was
    // dropped outright, with no deferred rung at all.
    const element = { x: 500, y: 50, width: 1560, height: 1180 }
    const { index } = await indexFor([
      pick(1000, 'main', 'main', element.x, element.y, element.width, element.height),
    ])
    const want = truth(element.x, element.y, element.width, element.height)
    const at = centre(want)
    const offered = index.stackAt(at.x, at.y).offered
    const top = offered[0]
    report('the picked <main> is offered at all',
      offered.some((o) => o.authority === 'document-native'),
      offered.map(describe).join(' | '))
    report('and it is what the click takes, ahead of the window rung',
      top?.authority === 'document-native', describe(top))
  }

  console.log('\nA picked <body> IS the viewport, and the window rung names it better')
  {
    const element = { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height }
    const { index } = await indexFor([
      pick(1000, 'body', '', element.x, element.y, element.width, element.height),
    ])
    const want = truth(element.x, element.y, element.width, element.height)
    const at = centre(want)
    const first = index.stackAt(at.x, at.y).offered[0]
    report('the first offer is the window, not a box around the whole page',
      first?.level === 'window', describe(first))
    // Deferred, never deleted: the refinement rung still has it, which is the
    // difference between "one rung back" and "gone".
    const refined = index.stackAt(at.x, at.y, false, 0, true).offered
    report('but it survives on the refinement rung',
      refined.some((o) => o.authority === 'document-native'),
      refined.map(describe).join(' | '))
  }

  // A CAPTURED DOCUMENT IS NOT A PICK, AND ITS CONTAINERS ARE NOT TARGETS.
  //
  // Measured on CapturePack_2026-08-09_213801: chrome-dom answered 94.5% of
  // 10,414 probes and the MEDIAN rectangle offered was 32.22% of the frame —
  // `section.office3-dash` at 40.93%, `div.office3-chat-thread` at 32.22%,
  // `nav.office3-project-list` at 16.33%. That is the #58 container shape
  // exactly, arriving through the door #104 opened for a different kind of
  // evidence: the container filter is skipped for `document-native` because a
  // pick is "one element a human pointed at", and since #130 that authority
  // also covers every element of a whole captured page, wrappers included.
  console.log('\nA container from a CAPTURED DOCUMENT is not a thing anyone pointed at')
  {
    // 1400x900 CSS px = 35.2% of the 2560x1400 window: over WINDOW_FRAME_
    // FRACTION and under every side rule, which is the shape the 0.35 test
    // exists for and the one a 0.9 viewport test lets through.
    const section = { x: 100, y: 100, w: 1400, h: 900 }
    const para = { x: 200, y: 200, w: 300, h: 60 }
    const { index } = await indexFor([
      documentSnapshot(1000, [
        { tag: 'section', ...section },
        { tag: 'p', ...para },
      ]),
    ])

    const inside = centre(truth(para.x, para.y, para.w, para.h))
    const top = index.stackAt(inside.x, inside.y).offered[0]
    report('a real element inside it is still offered precisely',
      top?.authority === 'document-native' && top.width === para.w, describe(top))

    // A point inside the section and outside every child: the container's own
    // background. This is where a wrapper wins by being the smallest rectangle
    // containing the point, and it is 3,400 probes of the real pack.
    const gap = { x: CLIENT.x + 1200, y: CLIENT.y + CHROME_PX + 800 }
    const onGap = index.stackAt(gap.x, gap.y).offered[0]
    report('but its background offers the window, not the container',
      onGap?.level === 'window', describe(onGap))

    const refined = index.stackAt(gap.x, gap.y, false, 0, true).offered
    report('the container is deferred, never deleted',
      refined.some((o) => o.authority === 'document-native'),
      refined.map(describe).join(' | '))
  }

  // ...and the distinction is the whole fix: the SAME rectangle, explicitly
  // picked, must still be offered. #104 is not being undone.
  console.log('\nThe same container, explicitly PICKED, is still offered (#104 holds)')
  {
    const section = { x: 100, y: 100, w: 1400, h: 900 }
    const { index } = await indexFor([
      pick(1000, 'section', '', section.x, section.y, section.w, section.h),
    ])
    const at = centre(truth(section.x, section.y, section.w, section.h))
    const top = index.stackAt(at.x, at.y).offered[0]
    report('a human pointing at it is different evidence, and it wins',
      top?.authority === 'document-native', describe(top))
  }

  console.log('\nThe provider claims the surface it holds a pick for')
  {
    const { claims } = await indexFor([pick(1000, 'button', 'button', 300, 200, 120, 40)])
    report('one claim, on the browser window, at document-native authority',
      claims.length === 1
      && claims[0]?.surfaceId === browser.surfaceId
      && claims[0]?.authority === 'document-native',
      JSON.stringify(claims))
  }

  console.log('\nNo pick means no claim, and the window rung answers alone')
  {
    const { index, claims } = await indexFor([])
    report('nothing is claimed', claims.length === 0, JSON.stringify(claims))
    const top = index.stackAt(1280, 700).offered[0]
    report('the window is still the floor', top?.level === 'window', describe(top))
  }

  console.log(`\nresult: ${failures === 0 ? 'OK' : 'BROKEN'} — ${String(failures)} failed\n`)
  if (failures > 0) process.exitCode = 1
}

void main()
