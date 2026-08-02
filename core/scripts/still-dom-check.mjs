// A STILL CARRIES THE BROWSER'S HALF TOO (issue #123).
//
// The whole 0.3.4 cycle rests on one claim: the video gives up object picking so
// that the STILL can carry everything — the full UIA tree and the page the pick
// sat in. GOAL says it, SPEC §11.4 says it, the README says it in nine
// languages, and the site says it in nine more.
//
// `runImageFlow` passed `domEvents: []` and wrote no `plugins/chrome-dom` at
// all. The one capture kind the product had just finished promising the most
// context to was the one that collected none of the page. The owner found it the
// only way it could be found — by trying to pick in a browser and getting
// nothing — after the documentation had already shipped.
//
// This is a source contract because the flow needs an Electron main process to
// run. It pins the wiring, not the behaviour: that a still COLLECTS, HANDS TO
// THE EDITOR, and WRITES the browser events, and that it does so through the
// same mapping the replay uses rather than a second copy that can drift.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const core = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let failed = 0

function source(relative) {
  return readFileSync(path.join(core, relative), 'utf8').replace(/\r\n?/g, '\n')
}

// A source contract asserts about CODE. Without this, a comment explaining the
// bug ("this used to pass domEvents: []") reads as the bug, and the check fails
// on its own documentation — which teaches the next person to delete the
// explanation rather than keep the guarantee.
function code(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
}

function check(name, condition, detail) {
  if (!condition) failed += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}`)
  if (!condition && detail !== undefined) console.log(`        ${detail}`)
}

const session = source('src/main/session.ts')

function flow(name, next) {
  const from = session.indexOf(`async function ${name}(`)
  const to = session.indexOf(`async function ${next}(`, from + 1)
  return from >= 0 && to > from ? session.slice(from, to) : ''
}

const image = flow('runImageFlow', 'runFlow')
check('runImageFlow was located', image.length > 0)

console.log('A still collects the browser picks')
check(
  'it asks the DOM bridge for them',
  image.includes('domEventsBetween('),
  'runImageFlow must read the bridge, not assume an empty list',
)
check(
  'over a BOUNDED lookback, not the whole retention',
  image.includes('STILL_DOM_LOOKBACK_MS'),
  'a still is one instant; claiming a 30s-old pick is a guess wearing a fact',
)
check(
  'and it no longer hard-codes an empty list',
  !/domEvents:\s*\[\]/.test(code(image)),
  'domEvents: [] was the bug',
)

console.log('\nThe editor gets exactly what the pack gets (#122)')
check(
  'the same array is handed to the context session',
  /domEvents:\s*capturedDomEvents/.test(image),
  'a second source here is how the offer and the record disagree',
)

console.log('\nA still writes them')
check(
  'plugins/chrome-dom is written',
  image.includes('tryWriteDomPlugin('),
)
check(
  'and declared in the manifest',
  image.includes('domPluginDeclaration()'),
  'an undeclared payload is invisible to a reader (SPEC §11.1)',
)
check(
  'a failure to write it can never fail the capture',
  /catch[\s\S]{0,200}writing plugins\/chrome-dom failed/.test(image),
  'browser context refines a capture; it may never break one',
)

console.log('\nOne mapping, not two')
// IT LIVES WITH THE WRITER NOW (#136). This used to look for the function in
// session.ts, where it was born. It defines the SPELLING of every field in
// plugins/chrome-dom/elements.json, and sitting a thousand lines from anything
// that reads one back is how the pack came to say `device_pixel_ratio` while the
// reader looked for `devicePixelRatio` — for twelve packs and 6,091 rectangles.
// The contract this check pins is "one mapping, not two", which is unchanged;
// only where the one lives has moved, so the assertion follows it rather than
// pinning a file it no longer belongs in.
check(
  'the shared mapper exists, beside the writer whose file format it defines',
  /export function domEventForPack\(/.test(source('src/main/exporter.ts')),
  'domEventForPack() must be defined once, in exporter.ts with writeDomPlugin()',
)
check(
  'and session.ts does not keep a second copy of it',
  !/function domEventForPack\(/.test(code(session)),
  'two copies of the mapping is exactly how the spellings drifted apart',
)
check(
  'the still uses it',
  image.includes('domEventForPack('),
)
check(
  'the replay uses it too',
  flow('runFlow', 'AAAAA-no-such-function').includes('domEventForPack(') ||
    session.split('async function runFlow(')[1]?.includes('domEventForPack('),
  'if the replay kept its own copy the two shapes would drift apart',
)

console.log('\nThe age is recorded, because a still cannot say it in t_ms')
check(
  'the still passes an age',
  /domEventForPack\(e, 0, ages\[i\]/.test(code(image)),
  'every still event shares t_ms: 0, so the distance has to be stated',
)
check(
  'the payload declares the field',
  source('src/main/exporter.ts').includes('age_ms?: number'),
)
check(
  'and the version says the field exists',
  /DOM_PLUGIN_VERSION = '0\.3\.0'/.test(source('src/main/exporter.ts')),
  'a reader keys on the declared version to know what to expect',
)

console.log('\nThe capture asks the browser rather than trusting a cache')
const bridge = source('src/main/chrome/domBridge.ts')
check(
  'the still fetches the page at the capture instant',
  /requestDomForCapture\(/.test(code(image)),
  'the whole point: one global hotkey, no gesture in Chrome',
)
check(
  'the fetch is bounded, so a capture never waits on a browser',
  /STILL_DOM_FETCH_TIMEOUT_MS/.test(code(image)),
)
// rc.25 gated the request on a cached grant flag that only a change event ever
// set — so an app started after the grant asked for nothing, silently.
check(
  'the request is NOT gated on a cached grant flag',
  !/if \(sockets\.length === 0 \|\| !browserGranted\)/.test(code(bridge)),
  'the extension is the authority on its own permissions; refusing costs one message',
)
check(
  'every outcome is logged, including "not allowed yet"',
  /not-granted/.test(bridge) && /no browser connected/.test(bridge),
  'a pack with no page must never be the only evidence that nothing happened',
)

// A SCREENSHOT CONTAINS EVERY BROWSER WINDOW, NOT THE FOCUSED ONE (#132).
//
// Reported as "유튜브는 되는데 왜 깃허브는 안되냐": two Chrome windows on the desk,
// one document in the pack. The extension asked `lastFocusedWindow: true`, which
// is the right question for a PICK — that happens in the window the user clicked
// in — and the wrong one for a CAPTURE, which photographs everything visible.
// The second window was never asked, so nothing said it was missing either.
console.log('\nEvery visible browser window is asked, not just the focused one (#132)')
const extension = source('../extensions/chrome/background.js')
check(
  'the capture-time fetch enumerates browser WINDOWS',
  /chrome\.windows\.getAll\(/.test(code(extension)),
  'querying one tab can only ever return one window',
)
check(
  'and it no longer asks the focused window ALONE',
  !/const tabs = await chrome\.tabs\.query\(\{ active: true, lastFocusedWindow: true \}\)/
    .test(code(extension)),
  'this single line is the whole of #133',
)
check(
  'a minimised window is not asked, because it is not in the pixels',
  /state === 'minimized'/.test(code(extension)),
)
check(
  'each window is snapshotted through the SAME function',
  /async function snapshotOneTab\(/.test(code(extension))
    && /tabs\.map\(\(tab\) => snapshotOneTab\(tab\)/.test(code(extension)),
  'a second copy of the injection is a second idea of what a document is',
)
check(
  'one slow or restricted window costs only itself',
  /snapshotOneTab\(tab\)\.catch\(/.test(code(extension)),
  'a chrome:// window must not take the whole desk down with it',
)
check(
  'the leading window keeps its place at the top level',
  /reply\(\{[\s\S]{0,200}ok: true,[\s\S]{0,120}tab: lead\.tab,[\s\S]{0,120}document: lead\.document/
    .test(code(extension)),
  'an app older than this extension must read the message unchanged',
)
check(
  'and the rest travel in `documents`',
  /documents: rest\.map\(/.test(code(extension)),
)
check(
  'a window that was asked and refused says so',
  /refused/.test(code(extension)) && /refused/.test(code(bridge)),
  'a browser window with no page must never be indistinguishable from one never asked',
)
check(
  'the host parses the extra windows',
  /windows\.push\(\{/.test(code(bridge)) && /m\['documents'\]/.test(code(bridge)),
)
check(
  'the still turns EVERY window into an event',
  /function domRequestEvents\(/.test(code(session))
    && /for \(const window of answer\.windows\) add\(/.test(code(session)),
  'one answer, N documents, N events — or the second window is dropped here instead',
)
check(
  'and all of them lead the buffered picks',
  /const rawEvents = \[\.\.\.requested, \.\.\.buffered\]/.test(code(image)),
)
check(
  'the socket bound admits a desk-sized reply',
  !/buffer\.length > 4 \* 1024 \* 1024/.test(code(bridge)),
  'six documents exceed 4 MB, and the old bound destroyed the socket — every page lost, not the big one',
)

console.log('\nA document without its viewport is geometry with no position')
check(
  'the still attaches a viewport to the captured document',
  /parseDomViewport\(rawViewport\)/.test(code(session)),
  'every rectangle in a document is viewport CSS pixels; this is what places them (#129)',
)
// #133 made this plural. A viewport carried for the leading window and dropped
// for the others would place one page and silently refuse every element of the
// rest — the same invisible failure, one window along.
check(
  'and to EVERY window it captured, not only the leading one',
  /add\(answer\.tab, answer\.document, answer\.viewport\)/.test(code(session))
    && /add\(window\.tab, window\.document, window\.viewport\)/.test(code(session)),
  'each window has its own viewport; they are not interchangeable',
)
check(
  'the extension returns the viewport with the document',
  /viewport: out\.result\.viewport/.test(source('../extensions/chrome/background.js')),
  'the picker always sent it; the capture-time fetch forgot to',
)
check(
  'one viewport parser, shared with the pick',
  /export function parseDomViewport\(/.test(bridge),
  'two copies of an anchoring rule is how a pick and a document come to disagree',
)

console.log('\nThe editor is asked at a moment the pack actually has')
check(
  'events handed to the editor are re-stamped onto the image clock',
  /tMs:\s*0/.test(code(image)) && /onImageClock/.test(code(image)),
  "a still's context exists only at t=0; a session-clock time finds no surface (#131)",
)
check(
  'and the real distance from the shutter survives that re-stamp',
  /ages\[i\]/.test(code(image)),
  'age_ms must be measured before the times are collapsed, or it becomes 0 for everything',
)

console.log('\nThe editor reasons from surfaces that carry a client rectangle')
check(
  'the still layers UIA controls onto lane S rectangles',
  /withClientRectangles\(contextObservation\(uia, 1, 0\), imageWindows\)/.test(code(image)),
  'UIA reports a window rect but never a client one; a DOM element cannot be placed without it (#131)',
)
check(
  'they are matched by HWND, the one identity both sources agree on',
  /byHandle\.get\(w\.hwnd\)/.test(code(session)),
  'a title or a process is a description two sources can legitimately disagree about',
)
check(
  'a still keeps the client rectangle when the window was not split',
  /client_bounds: clientBounds/.test(code(source('src/main/imageContext.ts'))),
  'it used to be dropped unconditionally, which is why a complete page could not be placed',
)
check(
  'and still refuses it where slices were unioned',
  /client_bounds: undefined/.test(code(source('src/main/imageContext.ts'))),
  'a rectangle unioned from mixed-DPI slices describes no viewport that ever existed',
)
// ...AND IT REACHES THE FILE (#136). Everything above this line was true and
// the pack still could not be reopened: the rectangle was layered onto the
// in-memory observation and dropped again by `mergeImageWindowFloor`, which is
// the stage that builds what gets serialized. Measured across the owner's
// capture root: 80 windows-uia payloads, none carrying one. The round trip
// itself is asserted by `check:pack-readback`; this pins the seam that lost it.
check(
  'and the payload the still SERIALIZES carries it too',
  /candidate\.client_bounds === undefined[\s\S]{0,120}client_bounds: \{ \.\.\.candidate\.client_bounds \}/
    .test(code(source('src/main/imageContext.ts'))),
  'mergeImageWindowFloor builds the record that is written; a rectangle it drops is a page nobody can reopen',
)

console.log(failed === 0 ? '\nstill-dom: OK' : `\nstill-dom: ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
