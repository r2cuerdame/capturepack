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
check(
  'the shared mapper exists',
  /function domEventForPack\(/.test(session),
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
  /domEventForPack\(e,\s*0,\s*domNowMs - e\.tMs\)/.test(image),
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

console.log(failed === 0 ? '\nstill-dom: OK' : `\nstill-dom: ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
