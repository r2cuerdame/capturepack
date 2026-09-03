// IS THE RECTANGLE UNDER THE CURSOR WORTH OFFERING? (#134)
//
// `validate-capturepack.mjs` can tell a pack WITH picking data from one
// without. It cannot tell either of them from a pack whose picking data is
// USELESS — and useless is what it was: object picking once answered a hover
// with a rectangle covering 19% of a 3840x2160 screen (1.58 Mpx, 55% of the
// window it belonged to), for months, because a half-window container passed
// every filter and then beat the window rung by being the smallest rectangle
// containing the point (#58). Nobody noticed until a user said hover select
// felt wrong. Every check was green the whole time.
//
// So this measures what the user actually gets: sweep a saved pack on a grid,
// ask the REAL editor index what it would offer at each point, and look at how
// big those rectangles are. It goes through `readPackObjectContext` +
// `ObjectIndex.forDisplay` — the same assembly the re-edit flow and the editor
// renderer use — so a regression anywhere in it (the filters in objects.ts, the
// resolver, a provider, the pack reader) shows up here as a number rather than
// as a feeling.
//
// WHAT IS MEASURED, PRECISELY, and why it is not simply "the offered rectangle".
//
// Two rungs answer a hover, and only one of them is ours to judge. The WINDOW
// rung offers the window, and a maximized window IS 40-100% of the frame — that
// is a fact about the desk, not a defect, and measured over every probe it
// drowns everything else out (median offered rectangle across the 46 real image
// packs: 10-100% of the frame, unchanged by the #58 regression). The CONTROL
// rung is the one the filters in objects.ts govern and the one that broke: when
// picking offers something FINER than the window, how fine is it? That is the
// distribution below, and it is exactly the quantity #58 quoted — its
// post-fix "23,912 px" is 0.29% of a 3840x2160 screen, which is where the
// healthy packs measured here still sit.
//
// Run: npm run check:pick-quality        (gate; add --report for the full table)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { openPackContextSession, readPackObjectContext } from '../src/main/context/packObjects'
import { ObjectIndex } from '../src/renderer/editor/objects'
import type { PickableObject } from '../src/renderer/editor/objects'
import { writeFixturePack } from './fixtures/pickQualityFixture'

/**
 * PROBE SPACING, in snapshot pixels — and the reason for the number.
 *
 * A grid stride is a claim about which targets are allowed to exist between two
 * probes: a rectangle at least STRIDE px wide AND tall must contain one, so the
 * sweep can only be blind to targets smaller than this on an axis.
 *
 * Too coarse and the measurement flatters the code it measures — a 64 px grid
 * (the index's own cell size) steps clean over the 24 px toolbar and tray icons
 * that make up most of a real control tree, so it samples containers and
 * reports what containers do. Too fine and it costs minutes for nothing.
 *
 * 16 px is the smallest power of two that clears the real floor: the smallest
 * thing anyone points at on this desk is a ~18-24 px icon (Windows' own minimum
 * touch target is 24 DIP), and the index refuses anything under 6 px a side as
 * noise.
 *
 * MEASURED over the 80 packs at C:/_CapturePack, median-of-medians / worst pack
 * / wall clock:
 *
 *      8 px   0.50%   11.39%   7.8 s      41 image packs offered a control
 *     16 px   0.37%    9.09%   3.1 s      41
 *     32 px   0.44%   11.39%   1.8 s      42
 *     64 px   0.35%    5.29%   1.5 s      40   <- misses controls entirely
 *
 * The corpus statistic is flat from 8 to 32 px (its p90 is 3.27% at every one
 * of the four), so the sample is saturated well before 16; the per-pack worst
 * wobbles between 5.3% and 11.4% because a pack with three big controls has few
 * probes to take a median over, which is a fact about that pack and the reason
 * the threshold below is derived from the whole range and not from one run. At
 * 64 px a pack drops out of the measurement altogether — its controls fit
 * between the probes — and that is the failure mode this stride exists to
 * avoid. 16 px costs 42,525 probes on a 5040x2160 still and sweeps the entire
 * evidence folder in about three seconds.
 */
const DEFAULT_STRIDE = 16

/**
 * THE GATE: how big the median offered CONTROL may be, as a fraction of its
 * display's frame.
 *
 * MEASURED, not chosen (that is the whole point of #134). Across the 46 real
 * image packs at C:/_CapturePack — 41 of which offer a control at all — at a
 * 16 px grid on the capture instant:
 *
 *     median-of-medians  0.37%      p90 of pack medians  3.27%
 *     worst pack         9.09%      (CapturePack_2026-07-31_170809: a File
 *                                    Explorer filling a region crop, where its
 *                                    file list IS the honest answer)
 *
 * ...and 11.39% for the worst pack at an 8 px grid (CapturePack_2026-07-31_000221,
 * three large controls and few probes to take a median over). So call 11.4% the
 * ceiling of measured-healthy.
 *
 * Against the regression this exists to catch: putting WINDOW_FRAME_FRACTION
 * back to the 0.95 it started life as and re-sweeping the same packs takes
 * CapturePack_2026-07-30_093014 from 3.53% to 37.10%, the corpus
 * median-of-medians from 0.37% to 1.20%, and the built-in fixture from 3.01% to
 * 34.14%. #58 reported the same bug on the desk it was found on as 19% of a
 * 3840x2160 screen.
 *
 * The honest gap is therefore 11.4% (worst healthy pack, finest grid) to 19%
 * (the smallest number the bug has ever been reported at), and 15% is the
 * middle of it. Tighter fails the next honest capture of a file list; 20% lets
 * #58 back in.
 *
 * RE-DERIVED FOR THE DOCUMENT RUNG (#136), AND IT LANDS IN THE SAME PLACE.
 *
 * The note here used to end by saying no browser DOCUMENT rectangle reached the
 * index from a saved pack, so the distribution above was the UI Automation rung
 * alone, and this threshold would be measuring a different population the day
 * that changed. #136 changed it, so here is the measurement.
 *
 * ON THE CORPUS AS IT STANDS the distribution does not move at all. Reading a
 * saved page back went from 1 rectangle of 6,092 to all 6,092, and not one of
 * them became a candidate — every pack on disk predates windows-uia 0.5.0 and
 * carries no client rectangle, so the document rung correctly declines to place
 * (SPEC §11.3). Same 42 packs, before and after, identical to the digit:
 *
 *     all                 packs=42  median 0.42%  p90 3.27%  worst 9.09%
 *     carrying chrome-dom packs=15  median 0.37%  p90 0.75%  worst 1.84%
 *
 * SO THE NEW POPULATION HAD TO BE MEASURED DIRECTLY: the ten page-carrying image
 * packs, copied out of the read-only evidence folder with the one number a 0.5.0
 * writer now records added — the client rectangle, which with a 1184x935 frame
 * and an 1184x814 viewport at dpr 1 the reader's own agreement band pins to the
 * frame's width. 41,355 probes are then answered by the browser, and the per-pack
 * median offered control moves from 0.37% to 0.65% (p90 0.75% -> 0.80%, worst
 * 1.84% -> 1.84%). Per pack the largest move is CapturePack_2026-08-02_014011,
 * whose UI Automation rung offers almost nothing: 0.07% -> 0.46%.
 *
 * FLOOR, by the same argument as above: the worst honest pack is unchanged at
 * 9.09% on a 16 px grid and 11.39% on an 8 px one, because both are packs the
 * document rung places nothing in. CEILING, with WINDOW_FRAME_FRACTION put back
 * to 0.95 and the document rung live: CapturePack_2026-07-30_093014 still reads
 * 37.10%, the fixture still 34.14%, the corpus median-of-medians still 1.20%,
 * and this check still fails 2 packs. Nothing about the gap 11.4% -> 19% moved,
 * so neither does the number.
 *
 * WHAT THE CORPUS CANNOT YET DECIDE, stated because it is the one shape that
 * could move this. Pooled over those 41,355 offers, a document rectangle is 8.24%
 * of the browser window it belongs to at the median — but 59.47% at p90 and
 * 81.04% at worst, and on 014011 the MEDIAN document offer is 48.79% of its
 * window. Every page-carrying pack here is a full-desktop still where a browser
 * is a small part of the frame, so those fractions divide by a large denominator
 * and stay small. On a pack where the browser IS the frame — a single-display
 * capture of a maximised Chrome — the same offers would be ~49% of it, and this
 * check would fail. That is the RIGHT answer, not a false alarm: #58 is defined
 * as "19% of a 3840x2160 screen, 55% of the window it belonged to", and a page
 * container answering the median hover at 49% of its window is that shape
 * exactly, whichever provider produced it. The limit is not raised to admit it.
 */
const MEDIAN_FRACTION_LIMIT = 0.15

/** The owner's real evidence folder; READ ONLY, and overridable. */
const PACK_ROOT = process.env['CAPTUREPACK_PACK_ROOT'] ?? 'C:/_CapturePack'

/**
 * What a pack CONTAINS, from its surfaces — so the report can say whether the
 * distribution above covers the three kinds of window that behave differently
 * (issue #134), instead of hoping it does.
 *
 *   browser  — a Chromium/Edge/Firefox top-level window, the one kind that can
 *              also answer from the chrome-dom document rung.
 *   electron — a Chromium-class window that is NOT a browser: Orca, Discord,
 *              Docker Desktop, VS Code. Its UIA tree is frames all the way
 *              down, so it is the case where "no control here" is the truth.
 *   native   — anything else: Explorer, a WindowsForms app, a terminal, the
 *              shell tray. The dense-control case the filters were written for.
 */
type SurfaceKind = 'browser' | 'electron' | 'native'
const BROWSER_PROCESSES = new Set(['chrome', 'msedge', 'firefox', 'whale', 'brave', 'opera'])
const CHROMIUM_CLASSES = new Set(['chrome_widgetwin_1', 'chrome_widgetwin_0'])

function surfaceKind(surface: { executableName?: string; className?: string }): SurfaceKind {
  const process = (surface.executableName ?? '').trim().toLowerCase().replace(/\.exe$/, '')
  const className = (surface.className ?? '').trim().toLowerCase()
  if (BROWSER_PROCESSES.has(process)) return 'browser'
  if (CHROMIUM_CLASSES.has(className)) return 'electron'
  return 'native'
}

interface Offer {
  /** Offered rectangle as a fraction of this display's frame. */
  fraction: number
  level: PickableObject['level']
  providerId: string
}

interface PackSweep {
  name: string
  captureKind: 'image' | 'video'
  probes: number
  offers: Offer[]
  kinds: Set<SurfaceKind>
  /** Browser picks the pack actually carries — not merely a registered provider. */
  domEvents: number
  /** Element rectangles the chrome-dom payload DECLARES... */
  domRectangles: number
  /** ...how many survived read-back... */
  domParsed: number
  /** ...and how many of them Core turned into candidates for this frame. */
  domCandidates: number
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN
  const at = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))
  return sorted[at] ?? Number.NaN
}

function pct(value: number): string {
  return Number.isNaN(value) ? '    —' : `${(value * 100).toFixed(2)}%`
}

/**
 * One display, swept.
 *
 * The probe is `pick()` — `stackAt(x, y).offered[0]`, which is literally what
 * the editor paints as the hover outline and what a click commits. Not
 * `windowAt`, not the raw candidate list: the question is what the USER is
 * offered, so the measurement goes through arbitration exactly as hovering
 * does. Points sit at cell CENTRES, because the grid origin is the screen edge
 * and nobody clicks there.
 */
function sweepDisplay(
  index: ObjectIndex,
  display: { index: number; width: number; height: number },
  stride: number,
  into: PackSweep,
  screenArea?: number,
): void {
  const frameArea = screenArea ?? (display.width * display.height)
  for (let y = Math.floor(stride / 2); y < display.height; y += stride) {
    for (let x = Math.floor(stride / 2); x < display.width; x += stride) {
      into.probes += 1
      const hit = index.pick(x, y)
      if (hit === null) continue
      into.offers.push({
        fraction: hit.area / frameArea,
        level: hit.level,
        providerId: hit.providerId,
      })
    }
  }
  for (const surface of index.surfaceStack) into.kinds.add(surfaceKind(surface))
}

async function sweepPack(dirPath: string, stride: number): Promise<PackSweep | null> {
  const context = readPackObjectContext(dirPath)
  if (context === null) return null
  const session = openPackContextSession(context)
  // THE CAPTURE INSTANT. It is the moment every still has, the moment the
  // one-shot control walk ran at, and the only moment a pack is guaranteed to
  // hold control data for — measuring anywhere else would measure the surface
  // ring's window floor and call the result picking quality.
  const frame = await session.frameAt(context.replayDurationMs)
  const sweep: PackSweep = {
    name: path.basename(dirPath),
    captureKind: context.captureKind,
    probes: 0,
    offers: [],
    kinds: new Set<SurfaceKind>(),
    domEvents: context.domEvents.length,
    domRectangles: context.domRectanglesDeclared,
    domParsed: context.domEvents.reduce(
      (total, event) =>
        total + (event.document?.elements.length ?? 0) + (event.element === undefined ? 0 : 1),
      0,
    ),
    domCandidates: frame.displays.reduce(
      (total, slice) =>
        total + slice.candidates.filter((c) => c.authority === 'document-native').length,
      0,
    ),
  }

  let hostScreenArea: number | undefined
  try {
    const raw = readFileSync(path.join(dirPath, 'manifest.json'), 'utf8')
    const manifest = JSON.parse(raw) as {
      media?: { crop_bounds?: { x: number; y: number; width: number; height: number }; image_scope?: string }
      environment?: { screens?: Array<{ width: number; height: number; bounds?: { x: number; y: number; width: number; height: number } }> }
    }
    const cropBounds = manifest.media?.crop_bounds
    const screens = manifest.environment?.screens
    if ((cropBounds || manifest.media?.image_scope === 'region') && Array.isArray(screens) && screens.length > 0) {
      const host = (cropBounds
        ? screens.find((s) => {
            const b = s.bounds
            if (!b) return false
            const tol = 1
            return (
              cropBounds.x >= b.x - tol &&
              cropBounds.y >= b.y - tol &&
              cropBounds.x + cropBounds.width <= b.x + b.width + tol &&
              cropBounds.y + cropBounds.height <= b.y + b.height + tol
            )
          })
        : undefined) ?? screens[0]
      if (host && typeof host.width === 'number' && typeof host.height === 'number') {
        hostScreenArea = host.width * host.height
      }
    }
  } catch { }
  for (const display of context.displays) {
    sweepDisplay(
      ObjectIndex.forDisplay(frame, {
        index: display.index,
        width: display.width,
        height: display.height,
      }),
      display,
      stride,
      sweep,
      hostScreenArea,
    )
  }
  return sweep
}

interface PackStats {
  median: number
  p90: number
  worst: number
  controlShare: number
  offerShare: number
  preciseShare: number
  controls: number
}

/** Per pack, over every display pooled: one pack, one distribution. */
function statsOf(pack: PackSweep): PackStats {
  const control = pack.offers
    .filter((offer) => offer.level === 'control')
    .map((offer) => offer.fraction)
    .sort((a, b) => a - b)
  return {
    median: quantile(control, 0.5),
    p90: quantile(control, 0.9),
    worst: quantile(control, 1),
    controls: control.length,
    controlShare: pack.probes === 0 ? 0 : control.length / pack.probes,
    offerShare: pack.probes === 0 ? 0 : pack.offers.length / pack.probes,
    // A TARGET PRECISE ENOUGH TO ANNOTATE, and the companion the median needs:
    // a "fix" that deleted every control would drive the median to nothing
    // while making picking useless, and this is the number that would collapse
    // with it. #58 tracked the same quantity as "under 100 kpx", which on the
    // 3840x2160 screen it was measured on is 1.2% of the frame; 1% here, so the
    // bar is if anything slightly higher.
    preciseShare:
      pack.probes === 0
        ? 0
        : control.filter((fraction) => fraction <= 0.01).length / pack.probes,
  }
}

function line(pack: PackSweep, stats: PackStats, failed: boolean): string {
  const tags = [...pack.kinds].sort().join('+')
  return (
    `${failed ? 'FAIL' : '    '} ${pack.name.padEnd(30)} ${pack.captureKind.padEnd(5)}` +
    ` probes=${String(pack.probes).padStart(6)}` +
    ` offered=${pct(stats.offerShare).padStart(7)} control=${pct(stats.controlShare).padStart(7)}` +
    ` | median=${pct(stats.median).padStart(7)} p90=${pct(stats.p90).padStart(7)}` +
    ` worst=${pct(stats.worst).padStart(7)} precise=${pct(stats.preciseShare).padStart(7)}` +
    ` | ${tags}`
  )
}

function packFolders(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root)
    .map((entry) => path.join(root, entry))
    .filter((entry) => {
      try {
        return statSync(entry).isDirectory() && existsSync(path.join(entry, 'manifest.json'))
      } catch {
        return false
      }
    })
    .sort()
}

function summarize(label: string, medians: readonly number[]): void {
  if (medians.length === 0) {
    console.log(`  ${label.padEnd(34)} — no pack offered a control`)
    return
  }
  const sorted = [...medians].sort((a, b) => a - b)
  console.log(
    `  ${label.padEnd(34)} packs=${String(sorted.length).padStart(3)}` +
      ` median=${pct(quantile(sorted, 0.5)).padStart(7)}` +
      ` p90=${pct(quantile(sorted, 0.9)).padStart(7)}` +
      ` worst=${pct(quantile(sorted, 1)).padStart(7)}`,
  )
}

async function main(): Promise<void> {
  const report = process.argv.includes('--report')
  const strideArg = process.argv.indexOf('--stride')
  const stride =
    strideArg === -1 ? DEFAULT_STRIDE : Math.max(1, Number(process.argv[strideArg + 1] ?? DEFAULT_STRIDE))
  console.log(
    `pick quality: ${String(stride)} px grid, capture instant, ` +
      `median offered control must stay under ${pct(MEDIAN_FRACTION_LIMIT)} of the frame`,
  )

  // THE FIXTURE IS THE PART THAT RUNS EVERYWHERE, and it is not a sample of
  // anything — nothing synthetic could be. It is the #58 SHAPE written out as a
  // real pack and read back through the real reader: one window, its anonymous
  // client-area pane, a 55%-of-the-window content container, a toolbar, a 24 px
  // button. Filtered, the container falls through to the window rung and the
  // median offered control is the toolbar (3.01% of the frame); offered, it
  // becomes the answer at every point inside it and the median is the container
  // (34.14%). An 11x move, so this check fails on a machine with no evidence
  // folder at all.
  const fixture = await sweepPack(writeFixturePack(), stride)
  if (fixture === null) throw new Error('the built-in pick-quality fixture is not a pack')
  const fixtureStats = statsOf(fixture)
  const fixtureFailed = fixtureStats.median > MEDIAN_FRACTION_LIMIT
  console.log('--- fixture: the #58 container shape ---')
  console.log(line(fixture, fixtureStats, fixtureFailed))
  let failures = fixtureFailed ? 1 : 0
  // A fixture that offers nothing is a fixture that cannot fail, and a check
  // that cannot fail is worse than no check. Its three real controls — toolbar,
  // 24 px button, list item — are what make the median above mean something.
  if (fixtureStats.controls === 0) {
    console.error('FAIL: the fixture offered no control at all — the measurement is vacuous')
    failures += 1
  }

  const folders = packFolders(PACK_ROOT)
  if (folders.length === 0) {
    console.log(`no packs under ${PACK_ROOT} — the fixture is the whole measurement here`)
  } else {
    console.log(`--- ${String(folders.length)} pack(s) under ${PACK_ROOT} ---`)
    const medians: number[] = []
    const byKind = new Map<SurfaceKind, number[]>([
      ['browser', []],
      ['electron', []],
      ['native', []],
    ])
    const withDom: number[] = []
    let silent = 0
    let domOffers = 0
    let domRectangles = 0
    let domParsed = 0
    let domCandidates = 0
    let domPacks = 0
    for (const folder of folders) {
      const pack = await sweepPack(folder, stride)
      if (pack === null) continue
      // PICKING IS A STILL-IMAGE FEATURE (editor.ts objectPickingApplies): no
      // index is ever built for a video, so gating one would assert on
      // behaviour the product does not offer. --report still sweeps them,
      // because the same filters run there the day that changes.
      const gated = pack.captureKind === 'image'
      if (!gated && !report) continue
      const stats = statsOf(pack)
      const failed = gated && stats.controls > 0 && stats.median > MEDIAN_FRACTION_LIMIT
      if (failed) failures += 1
      if (report || failed) console.log(line(pack, stats, failed))
      if (!gated) continue
      domOffers += pack.offers.filter((offer) => offer.providerId === 'chrome-dom').length
      if (pack.domRectangles > 0) {
        domPacks += 1
        domRectangles += pack.domRectangles
        domParsed += pack.domParsed
        domCandidates += pack.domCandidates
      }
      if (stats.controls === 0) {
        // Not a failure: an Electron-only desk, or one where every window with
        // a tree is occluded, honestly has nothing finer than the window to
        // offer (SPEC §11.3, "Silence is not absence"). Counted, so a corpus
        // that quietly went all-silent cannot masquerade as a passing one.
        silent += 1
        continue
      }
      medians.push(stats.median)
      for (const kind of pack.kinds) byKind.get(kind)?.push(stats.median)
      if (pack.domEvents > 0) withDom.push(stats.median)
    }
    console.log('--- image packs, distribution of the per-pack median offered control ---')
    summarize('all', medians)
    for (const [kind, values] of byKind) {
      summarize(`containing ${kind === 'electron' ? 'an' : 'a'} ${kind} window`, values)
    }
    summarize('carrying browser picks (chrome-dom)', withDom)
    // THE BROWSER RUNG, COUNTED SEPARATELY — because a rung that is never
    // offered cannot show up in a distribution at all, and "no numbers" is
    // exactly how #130 stayed invisible ("340 rectangles written to disk and
    // none of them offered to the editor, which is indistinguishable, from the
    // outside, from not collecting it at all"). Reported, not gated: what this
    // check owns is the SIZE of what picking offers, and a rung that places
    // nothing is a different bug with a different owner.
    console.log(
      `  chrome-dom: ${String(domPacks)} image pack(s) DECLARE ${String(domRectangles)} element ` +
        `rectangle(s) — ${String(domParsed)} survived read-back, ${String(domCandidates)} became ` +
        `candidates, ${String(domOffers)} probe(s) were answered by one`,
    )
    console.log(
      `  ${String(silent)} image pack(s) offered no control at all ` +
        '(Electron-only or fully occluded trees — the window rung is the honest answer there)',
    )
  }

  if (failures > 0) {
    console.error(
      `\nFAIL: ${String(failures)} pack(s) answer the median hover with a rectangle over ` +
        `${pct(MEDIAN_FRACTION_LIMIT)} of the frame — picking is offering containers again (#58/#134)`,
    )
    process.exitCode = 1
    return
  }
  console.log('\nOK: every measured pack keeps its median offered control inside the limit')
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
