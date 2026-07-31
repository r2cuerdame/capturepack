// PICKING IS A STILL-IMAGE FEATURE. A VIDEO GETS BOXES YOU DRAW.
//
// Decided 2026-08-01 by the owner: "영상은 셀렉션 안되고 이미지는 셀렉션 되야지". Not
// because picking in a video was hard, but because it was only ever HALF true.
// Window-level picking answers at any frame — lane S samples geometry ~100 times
// a second. Control-level picking cannot: lane A paces itself to a 3% duty and
// skips Chromium windows, because one walk of them costs 326 ms against 13.9 ms
// for the whole rest of the desktop. So inside a browser — inside most of what
// anyone captures — a scrubbed frame offered the window and never the thing in
// it, while the same click at the capture instant offered both. A feature that
// works on the frame you captured and not the frame beside it teaches nobody
// anything except not to trust it.
//
// This is a source contract because the rule lives in the editor's renderer
// module, which cannot be imported without a DOM. It pins the one gate and every
// consumer that must route through it, so the decision cannot be undone by
// accident — only on purpose, by editing this file too.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const core = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let failed = 0

function source(relative) {
  return readFileSync(path.join(core, relative), 'utf8').replace(/\r\n?/g, '\n')
}

function check(name, condition, detail) {
  if (!condition) failed += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}`)
  if (!condition && detail !== undefined) console.log(`        ${detail}`)
}

function body(text, signature) {
  const from = text.indexOf(signature)
  if (from < 0) return ''
  const to = text.indexOf('\n}', from)
  return to > from ? text.slice(from, to) : ''
}

const editor = source('src/renderer/editor/editor.ts')

console.log('THE GATE')
check(
  'objectPickingApplies() exists and is the whole rule',
  /function objectPickingApplies\(\): boolean \{\s*return captureKind === 'image'\s*\}/.test(editor),
  'the gate must be one expression: a still picks, a video does not',
)

console.log('\nEVERY WAY IN ROUTES THROUGH IT')
check(
  'no index is built for a video',
  body(editor, 'function buildObjectIndex(').includes('if (!objectPickingApplies()) return'),
  'buildObjectIndex must refuse before it builds',
)
check(
  'and no index can be handed out for one either',
  body(editor, 'function objectIndexOf(').includes('if (!objectPickingApplies()) return null'),
  'objectIndexOf is what hover and the commit path both call',
)
check(
  'picking says nothing at all on a video',
  body(editor, 'function objectPickingCanSpeak(').includes('if (!objectPickingApplies()) return false'),
  'silence, because it is a decision and not a gap this frame happens to have',
)
check(
  'the help sheet does not promise a pick a video cannot make',
  body(editor, 'function helpContent(').includes('if (objectPickingApplies()) {'),
  "the first row used to read 'left click: pick an object' unconditionally",
)

console.log('\nWHAT A VIDEO KEEPS')
// The decision removes selection, NOT the video's own annotations, and NOT the
// recorded evidence: lane A still files control geometry into the pack's
// windows-context timeline, because the owner asked for that record explicitly.
check(
  'manual boxes are untouched — right-drag still draws one',
  editor.includes("t('editor.keyRightDrag'), t('editor.helpNewBox')"),
)
check(
  'lane A still records into the pack timeline',
  source('src/main/context/runtime.ts').includes('current.controls.controlsAt(sessionMs)'),
  'removing selection is not permission to stop recording what was there',
)

console.log('\nAND WHAT A STILL KEEPS')
check(
  'a still still builds its index',
  body(editor, 'function buildObjectIndexes(').includes('buildObjectIndex(d.index, frame)'),
)
check(
  'the still-only escape hatch stays video-gated and therefore unreachable',
  body(editor, 'async function requestBoundedObservedControlPick(').includes("captureKind !== 'video'"),
  'it needs a non-null ObjectIndex, which a video can no longer produce',
)

console.log(failed === 0 ? '\nvideo-no-picking: OK' : `\nvideo-no-picking: ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
