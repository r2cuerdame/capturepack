// CAN A SAVED PACK'S BROWSER PAGE BE READ BACK? (#136)
//
// MEASURED BEFORE THIS EXISTED, on the owner's own evidence folder:
//
//     rectangles on disk:   549   (CapturePack_2026-08-02_005913)
//     recovered by reader:    0
//     across the capture root: 12 packs, 6,091 rectangles unreadable
//
// Live capture was fine the whole time. The extension speaks camelCase on the
// wire, the pack is written in snake_case like every other field CapturePack
// persists, and the reader only knew the wire spelling — so `device_pixel_ratio`
// came back as `undefined`, the viewport guard refused the document (correctly,
// by its own rules: a defaulted device pixel ratio would place elements
// somewhere plausible and wrong), and every page in every pack on disk was
// dropped in silence. It hid because nothing but a REOPEN ever took that path.
//
// The second half was that no pack persisted a CLIENT rectangle. A DOM element
// is measured in viewport CSS pixels; the only thing that turns those into
// snapshot pixels is the browser window's drawable rectangle (see
// `domProvider.rectAtPick`). #131 gave the live still one by layering the
// surface ring onto the observation in memory. Nothing wrote it down, so a
// reopened pack had a page, a viewport, a matching window — and no way to place
// any of it.
//
// WHY THIS CHECK IS SHAPED THE WAY IT IS. Both failures are invisible to any
// test that builds its own payload: a fixture written by hand agrees with
// whatever spelling its author typed, which is exactly the agreement that was
// missing. So this writes a pack through the REAL writers — `domEventForPack`
// and `writeDomPlugin` for the page, `mergeImageWindowFloor` +
// `sealUiaPayload` + `writeUiaPlugin` for the windows — reads it back through
// the REAL reader (`readPackObjectContext`), and counts. Rectangles on disk
// versus rectangles recovered, on a pack shaped like one a capture produces.
//
// Run: npm run check:pack-readback
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  DOM_PLUGIN_VERSION,
  UIA_PLUGIN_VERSION,
  domEventForPack,
  writeDomPlugin,
  writeUiaPlugin,
} from '../src/main/exporter'
import type { DomPluginPayload } from '../src/main/exporter'
import { mergeImageWindowFloor } from '../src/main/imageContext'
import { parseUiaPayload, sealUiaPayload } from '../src/main/uia'
import { parseDomPayload } from '../src/main/chrome/domBridge'
import type { DomEvent } from '../src/main/chrome/domBridge'
import type { ContextObservation } from '../src/main/context/buffer'
import { openPackContextSession, readPackObjectContext } from '../src/main/context/packObjects'
import { greyPng } from './fixtures/greyPng'

let failures = 0
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  PASS  ${name}`)
    return
  }
  failures += 1
  console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

// ---------------------------------------------------------------------------
// The desk this pack was captured from.
//
// Every number is taken from the real capture that opened #136
// (CapturePack_2026-08-02_005913): a 1184x814 CSS viewport at dpr 1 inside a
// 1184x935 client area — so the derived scale is exactly 1 and the browser
// chrome is the 121 px the tab strip and omnibox actually measured. A fixture
// that invented a convenient scale would be testing arithmetic; these are the
// numbers the bug was found in.
// ---------------------------------------------------------------------------

const SCREEN = { width: 1920, height: 1080 }
const WINDOW_BOUNDS = { x: 100, y: 50, width: 1200, height: 951 }
const CLIENT_BOUNDS = { x: 108, y: 58, width: 1184, height: 935 }
const VIEWPORT = { width: 1184, height: 814, dpr: 1 }
/** Where a viewport CSS pixel lands, by the derivation in domProvider.place(). */
const CHROME_HEIGHT = CLIENT_BOUNDS.height - VIEWPORT.height
const TAB = { url: 'https://example.invalid/checkout', title: 'Checkout — Example' }

/** A page's own containers and controls, in viewport CSS pixels. */
function documentElements(count: number): DomEvent['document'] extends undefined
  ? never
  : NonNullable<DomEvent['document']>['elements'] {
  const elements: NonNullable<DomEvent['document']>['elements'] = []
  for (let i = 0; i < count; i += 1) {
    elements.push({
      i,
      tag: 'button',
      role: 'button',
      bounds: { x: 40 + (i % 8) * 140, y: 60 + Math.floor(i / 8) * 90, width: 120, height: 40 },
      id: `field-${String(i)}`,
      text: `Field ${String(i)}`,
    })
  }
  return elements
}

const DOCUMENT_ELEMENTS = 40

function domEvents(): DomEvent[] {
  const elements = documentElements(DOCUMENT_ELEMENTS)
  return [
    {
      tMs: 0,
      type: 'dom.document.captured',
      tab: TAB,
      viewport: {
        width: VIEWPORT.width,
        height: VIEWPORT.height,
        dpr: VIEWPORT.dpr,
        screenX: WINDOW_BOUNDS.x,
        screenY: WINDOW_BOUNDS.y,
        outerWidth: WINDOW_BOUNDS.width,
        outerHeight: WINDOW_BOUNDS.height,
      },
      document: {
        viewport: {
          width: VIEWPORT.width,
          height: VIEWPORT.height,
          devicePixelRatio: VIEWPORT.dpr,
          scrollX: 0,
          scrollY: 4667,
        },
        url: TAB.url,
        title: TAB.title,
        elements,
        truncated: false,
        visitedCount: 512,
        elapsedMs: 37,
        omitted: ['input values', 'password fields'],
      },
    },
  ]
}

/**
 * The surface ring's window floor at the still's instant, as `#131` layers it.
 *
 * `client_bounds` is the whole point: it is what the ring observes and the UI
 * Automation dump cannot, and until #136 it stopped here instead of reaching the
 * file.
 */
function windowFloor(withClientRectangle: boolean): ContextObservation {
  return {
    tMs: 0,
    windows: [
      {
        hwnd: '9001',
        surface_id: 'hwnd:9001#1',
        title: `${TAB.title} - Chrome`,
        process: 'chrome.exe',
        class_name: 'Chrome_WidgetWin_1',
        bounds: { ...WINDOW_BOUNDS },
        ...(withClientRectangle ? { client_bounds: { ...CLIENT_BOUNDS } } : {}),
        display: 1,
        focused: true,
        z: 0,
        hasControls: false,
        tree: 'skipped',
      },
    ],
    elements: [],
  }
}

const CAPTURED_AT = '2026-08-02T00:59:13+09:00'

function manifest(): unknown {
  return {
    format: 'capturepack',
    format_version: '0.7.0',
    capture_kind: 'image',
    id: 'pack-readback-fixture',
    created_at: CAPTURED_AT,
    generator: { name: 'capturepack', version: '0.0.0-check' },
    environment: {
      os: 'windows',
      os_version: '10.0.26200',
      screens: [{ width: SCREEN.width, height: SCREEN.height, scale: 1 }],
    },
    media: { snapshot: 'snapshot.png', replay: null, image_scope: 'fullscreen' },
    plugins: [
      { name: 'windows-uia', version: UIA_PLUGIN_VERSION, path: 'plugins/windows-uia/' },
      { name: 'chrome-dom', version: DOM_PLUGIN_VERSION, path: 'plugins/chrome-dom/' },
    ],
  }
}

/**
 * A pack folder written by the SAME code a capture writes one with.
 *
 * `mergeImageWindowFloor` is the still's last assembly stage and the only place
 * that holds both the UI Automation dump and the ring's client rectangles;
 * `sealUiaPayload` is where the still path seals, and `writeUiaPlugin` /
 * `writeDomPlugin` are the two functions that put bytes on disk. Nothing here
 * hand-writes a plugin payload, because a hand-written one cannot disagree with
 * the reader in the way that made #136.
 */
async function writePack(withClientRectangle: boolean): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'capturepack-pack-readback-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest(), null, 2))
  writeFileSync(path.join(dir, 'snapshot.png'), greyPng(SCREEN.width, SCREEN.height))
  writeFileSync(path.join(dir, 'annotations.json'), JSON.stringify({ annotations: [] }, null, 2))

  const uia = sealUiaPayload(
    mergeImageWindowFloor(null, windowFloor(withClientRectangle), CAPTURED_AT),
  )
  if (uia === null) throw new Error('the still window floor produced no windows-uia payload')
  await writeUiaPlugin(dir, uia)

  const payload: DomPluginPayload = {
    protocol: 1,
    extension_version: '0.3.4',
    events: domEvents().map((event) => domEventForPack(event, 0, 0)),
  }
  await writeDomPlugin(dir, payload)
  return dir
}

/** Element rectangles a parsed event stream actually carries. */
function recoveredRectangles(events: readonly DomEvent[]): number {
  return events.reduce(
    (total, event) =>
      total + (event.document?.elements.length ?? 0) + (event.element === undefined ? 0 : 1),
    0,
  )
}

async function main(): Promise<void> {
  console.log(
    `pack read-back: windows-uia ${UIA_PLUGIN_VERSION}, chrome-dom ${DOM_PLUGIN_VERSION}` +
      ` — ${String(DOCUMENT_ELEMENTS)} element rectangle(s) written by the real writers`,
  )

  console.log('\nA pack written by the exporter is read back by the reader')
  const dir = await writePack(true)
  const context = readPackObjectContext(dir)
  if (context === null) throw new Error('the written pack did not read back as a pack at all')

  // THE MEASUREMENT #136 WAS OPENED WITH. Declared is what the writer put on
  // disk; recovered is what the reader got out of it. They were 549 and 0.
  check(
    'the pack DECLARES every element rectangle the page carried',
    context.domRectanglesDeclared === DOCUMENT_ELEMENTS,
    `declared ${String(context.domRectanglesDeclared)}, wrote ${String(DOCUMENT_ELEMENTS)}`,
  )
  const recovered = recoveredRectangles(context.domEvents)
  check(
    'every rectangle on disk survives read-back (rectangles on disk vs recovered)',
    recovered === DOCUMENT_ELEMENTS,
    `${String(context.domRectanglesDeclared)} on disk, ${String(recovered)} recovered`,
  )

  // The document is refused WHOLE or accepted whole, so the fields that make it
  // placeable are worth naming: a viewport that came back with a defaulted
  // device pixel ratio would place every one of those rectangles somewhere
  // plausible and wrong, which is worse than the silence it replaced.
  const document = context.domEvents[0]?.document
  check(
    "the document's viewport survives with the values the writer wrote",
    document !== undefined
      && document.viewport.devicePixelRatio === VIEWPORT.dpr
      && document.viewport.width === VIEWPORT.width
      && document.viewport.height === VIEWPORT.height
      && document.viewport.scrollY === 4667,
    document === undefined ? 'no document at all' : JSON.stringify(document.viewport),
  )
  check(
    'the page census survives too — visited_count and elapsed_ms are not defaulted away',
    document !== undefined && document.visitedCount === 512 && document.elapsedMs === 37,
    document === undefined
      ? 'no document at all'
      : `visitedCount=${String(document.visitedCount)} elapsedMs=${String(document.elapsedMs)}`,
  )

  console.log('\nThe window carries the client rectangle a page needs to be placed')
  const uiaText = readFileSync(path.join(dir, 'plugins', 'windows-uia', 'elements.json'), 'utf8')
  const onDisk = JSON.parse(uiaText) as {
    windows: { client_bounds?: { x: number; y: number; width: number; height: number } }[]
  }
  check(
    'plugins/windows-uia/elements.json persists client_bounds beside the window rectangle',
    JSON.stringify(onDisk.windows[0]?.client_bounds) === JSON.stringify(CLIENT_BOUNDS),
    `on disk: ${JSON.stringify(onDisk.windows[0]?.client_bounds)}`,
  )
  check(
    'reading the payload back keeps it, so a re-save cannot quietly drop it',
    JSON.stringify(parseUiaPayload(uiaText)?.windows[0]?.client_bounds)
      === JSON.stringify(CLIENT_BOUNDS),
    JSON.stringify(parseUiaPayload(uiaText)?.windows[0]?.client_bounds),
  )

  console.log('\nThe reopened pack offers the page as candidates, where the page was')
  const frame = await openPackContextSession(context).frameAt(context.replayDurationMs)
  const candidates = frame.displays.flatMap((slice) =>
    slice.candidates.filter((candidate) => candidate.authority === 'document-native'),
  )
  check(
    'every recovered rectangle becomes a candidate at the capture instant',
    candidates.length === DOCUMENT_ELEMENTS,
    `${String(candidates.length)} of ${String(DOCUMENT_ELEMENTS)}`,
  )
  // Placement is DERIVED — scale from the client width against the viewport
  // width, chrome height from the two heights — so asserting the derivation on
  // one known element is what stops a "placed" candidate from being placed
  // anywhere at all.
  const first = candidates.find((candidate) => candidate.identity?.['selector'] === '#field-0')
  check(
    'and lands where the derivation puts it, not merely somewhere on the window',
    first !== undefined
      && first.bounds.x === CLIENT_BOUNDS.x + 40
      && first.bounds.y === CLIENT_BOUNDS.y + CHROME_HEIGHT + 60
      && first.bounds.width === 120
      && first.bounds.height === 40,
    first === undefined ? 'no candidate for #field-0' : JSON.stringify(first.bounds),
  )

  console.log('\nA window with no client rectangle still declines to place, as SPEC §11.3 says')
  // The client rectangle is OPTIONAL and absent from every pack written before
  // it. A reader meeting one must decline, exactly as it did before this field
  // existed — never guess a chrome height, never fall back to the frame.
  const legacyDir = await writePack(false)
  const legacy = readPackObjectContext(legacyDir)
  if (legacy === null) throw new Error('the client-less pack did not read back as a pack')
  check(
    'its page still survives read-back — the document is not the missing half',
    recoveredRectangles(legacy.domEvents) === DOCUMENT_ELEMENTS,
    `${String(recoveredRectangles(legacy.domEvents))} recovered`,
  )
  const legacyFrame = await openPackContextSession(legacy).frameAt(legacy.replayDurationMs)
  const legacyCandidates = legacyFrame.displays.flatMap((slice) =>
    slice.candidates.filter((candidate) => candidate.authority === 'document-native'),
  )
  check(
    'and nothing is placed from it — declining beats a plausible wrong rectangle',
    legacyCandidates.length === 0,
    `${String(legacyCandidates.length)} candidate(s) were placed without a client rectangle`,
  )

  console.log('\nThe wire spelling still parses — the extension has not changed')
  // The reader accepts BOTH spellings because both exist in the field: the
  // camelCase one arrives from the browser, the snake_case one is on disk in
  // every pack already written. Losing the wire spelling to fix the pack would
  // simply move the bug to live capture.
  const wire = parseDomPayload(
    JSON.stringify({
      events: [
        {
          t_ms: 0,
          type: 'dom.document.captured',
          tab: TAB,
          document: {
            viewport: {
              width: VIEWPORT.width,
              height: VIEWPORT.height,
              devicePixelRatio: VIEWPORT.dpr,
              scrollX: 0,
              scrollY: 12,
            },
            url: TAB.url,
            title: TAB.title,
            elements: documentElements(3),
            truncated: false,
            visitedCount: 9,
            elapsedMs: 5,
            omitted: [],
          },
        },
      ],
    }),
  )
  check(
    'a camelCase document parses exactly as the snake_case one does',
    recoveredRectangles(wire) === 3
      && wire[0]?.document?.viewport.devicePixelRatio === VIEWPORT.dpr
      && wire[0]?.document?.viewport.scrollY === 12
      && wire[0]?.document?.visitedCount === 9,
    JSON.stringify(wire[0]?.document?.viewport),
  )

  if (failures > 0) {
    console.error(
      `\nFAIL: ${String(failures)} read-back assertion(s) failed — a saved pack's page cannot be`
        + ' read back the way it was written (#136)',
    )
    process.exitCode = 1
    return
  }
  console.log('\nOK: what the exporter writes is what the reader recovers')
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
