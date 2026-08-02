// A NUMBER IS ASSIGNED, NOT DEDUCED (SPEC §8.5, issue #51).
//
// Two defects drove this. Turning a box's number OFF and back ON put it back in
// the MIDDLE of the sequence, because `created_at` is as fixed as the `start_ms`
// it replaced and nothing in the pack recorded that the user had just
// re-assigned it. And there was no way to say which number a box should have —
// numbering is the one place a user composes a reading order for someone else,
// and the app was composing it for them.
//
// So this check pins the two halves that numbering-check does not:
//   * ASSIGNMENT — nextDisplayNumber and planNumberPins, the pair the editor
//     calls, exercised exactly as the editor calls them;
//   * CONTIGUITY — 1..N with no gaps and no duplicates, for every arrangement
//     of pins a pack can arrive carrying, because the documents and the video
//     both cite these numbers and neither can be allowed to invent one.
// It also pins the ONE-IMPLEMENTATION rule, since a second copy of the numbering
// rule is how the video and the documents come to disagree.
//
// Run: npm run check:number-assignment
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  computeDisplayNumbers,
  nextDisplayNumber,
  planNumberPins,
} from '../src/shared/types'
import type { Annotation } from '../src/shared/types'

let failed = 0

function check(label: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  const ok = g === w
  if (!ok) failed += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) console.log(`        got  ${g}\n        want ${w}`)
}

function ok(label: string, condition: boolean, detail = ''): void {
  if (!condition) failed += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

// The check reads the sources it makes claims about; the runner hands it the
// core directory because the bundle it executes lives in a temp folder.
const CORE = process.env['CAPTUREPACK_CHECK_ROOT'] ?? process.cwd()
const source = (...parts: string[]): string =>
  readFileSync(path.join(CORE, ...parts), 'utf8')

let seq = 0
/** A box, `at` its creation instant. Numbering starts OFF, as the editor's does. */
function box(id: string, at: string, opts: { numbered?: boolean; pin?: number } = {}): Annotation {
  seq += 1
  return {
    annotation_id: id,
    type: 'box',
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    text: '',
    numbered: opts.numbered ?? false,
    ...(opts.pin === undefined ? {} : { number_pin: opts.pin }),
    blur: false,
    tracking: { enabled: false },
    created_at: at,
    z: seq,
  } as Annotation
}

const at = (second: number): string =>
  `2026-07-29T18:00:${String(second).padStart(2, '0')}+09:00`

/** annotation_id -> display number, in display order. */
const numbersOf = (as: readonly Annotation[]): Record<string, number> =>
  Object.fromEntries([...computeDisplayNumbers(as)].sort((a, b) => a[1] - b[1]))

function applyPins(all: readonly Annotation[], pins: ReadonlyMap<string, number>): Annotation[] {
  return all.map((a) => {
    const pin = pins.get(a.annotation_id)
    return pin === undefined ? a : { ...a, number_pin: pin }
  })
}

// ---------------------------------------------------------------------------
// The three things the editor does, in the order it does them. Kept here rather
// than imported so this check states the contract instead of restating the code.
// ---------------------------------------------------------------------------

/** The [#] toggle, ON: numbering starts, and it takes the NEXT number. */
function numberOn(all: readonly Annotation[], id: string): Annotation[] {
  // Planned against the sequence as it is NOW — before the box joins it.
  const pins = planNumberPins(all, id, nextDisplayNumber(all, id))
  const flagged = all.map((a) => (a.annotation_id === id ? { ...a, numbered: true } : a))
  return applyPins(flagged, pins)
}

/** The [#] toggle, OFF: the number is RELEASED, and the rest close up. */
function numberOff(all: readonly Annotation[], id: string): Annotation[] {
  return all.map((a) => {
    if (a.annotation_id !== id) return a
    const next = { ...a, numbered: false }
    delete next.number_pin
    return next
  })
}

/** The number picker: the user says which number this box should have. */
function assign(all: readonly Annotation[], id: string, wanted: number): Annotation[] {
  return applyPins(all, planNumberPins(all, id, wanted))
}

const pinsOf = (all: readonly Annotation[]): Record<string, number> =>
  Object.fromEntries(
    all.flatMap((a) => (a.number_pin === undefined ? [] : [[a.annotation_id, a.number_pin]])),
  )

console.log('ASSIGNMENT ORDER')
{
  // Three boxes, numbered in the order they were drawn — the ordinary flow.
  let all = [box('ann_0000a1', at(0)), box('ann_0000a2', at(1)), box('ann_0000a3', at(2))]
  all = numberOn(all, 'ann_0000a1')
  all = numberOn(all, 'ann_0000a2')
  all = numberOn(all, 'ann_0000a3')
  check('numbering three boxes in order gives 1, 2, 3', numbersOf(all), {
    ann_0000a1: 1,
    ann_0000a2: 2,
    ann_0000a3: 3,
  })
  // Nothing is stored for it: creation order already says this, and a pin on
  // every box would be the app writing down its own defaults.
  check('the ordinary flow stores no pins at all', pinsOf(all), {})

  all = numberOff(all, 'ann_0000a2')
  check('turning ② off closes the sequence up', numbersOf(all), {
    ann_0000a1: 1,
    ann_0000a3: 2,
  })

  // THE DEFECT #51 REPORTS. This used to come back as ②, in the middle, because
  // created_at cannot be re-assigned and nothing else recorded the decision.
  all = numberOn(all, 'ann_0000a2')
  check('turning it back on takes the NEXT number, not its old one', numbersOf(all), {
    ann_0000a1: 1,
    ann_0000a3: 2,
    ann_0000a2: 3,
  })
}
{
  // Numbering the boxes in a different order from the one they were drawn in:
  // the numbers follow the person, not the clock.
  let all = [box('ann_0000b1', at(0)), box('ann_0000b2', at(1)), box('ann_0000b3', at(2))]
  all = numberOn(all, 'ann_0000b3')
  all = numberOn(all, 'ann_0000b1')
  all = numberOn(all, 'ann_0000b2')
  check('numbers follow the order the user assigned them', numbersOf(all), {
    ann_0000b3: 1,
    ann_0000b1: 2,
    ann_0000b2: 3,
  })
}
{
  const all = [box('ann_0000c1', at(0), { numbered: true }), box('ann_0000c2', at(1))]
  check('a box being numbered is told the next free number', nextDisplayNumber(all, 'ann_0000c2'), 2)
  // Asked about a box that already has one, the answer is the same number it
  // would get if it were re-assigned now — the editor asks before it flips the
  // flag, so this must not count the box twice.
  check('the box asking is never counted twice', nextDisplayNumber(all, 'ann_0000c1'), 1)
}

console.log('\nTYPING A NUMBER')
{
  const ids = ['ann_0000d1', 'ann_0000d2', 'ann_0000d3', 'ann_0000d4']
  let all = ids.map((id, i) => box(id, at(i), { numbered: true }))
  // The last box takes ③. The box that held ③ is PUSHED to ④; the two before it
  // never moved, because nothing displaced them.
  all = assign(all, 'ann_0000d4', 3)
  check('typing 3 pushes the box that held 3 along', numbersOf(all), {
    ann_0000d1: 1,
    ann_0000d2: 2,
    ann_0000d4: 3,
    ann_0000d3: 4,
  })
  // ...and again, on a box that is currently ①. Everything between its old and
  // new place shifts by one; ④ is untouched.
  all = assign(all, 'ann_0000d1', 3)
  check('taking 3 from the box that just got it moves that one, not the rest', numbersOf(all), {
    ann_0000d2: 1,
    ann_0000d4: 2,
    ann_0000d1: 3,
    ann_0000d3: 4,
  })
  // Typing the number a box already shows is not a change, and must not write
  // one: a no-op edit that dirties the pack is a save the user did not make.
  check(
    'typing the number a box already has plans nothing',
    [...planNumberPins(all, 'ann_0000d1', 3)],
    [],
  )
}
{
  const ids = ['ann_0000e1', 'ann_0000e2', 'ann_0000e3', 'ann_0000e4']
  let all = ids.map((id, i) => box(id, at(i), { numbered: true }))
  all = assign(all, 'ann_0000e1', 99)
  // There is no ㊾ to ask for. The claim lands on the last slot the pack has.
  check('asking for a number past the end lands on the last one', numbersOf(all), {
    ann_0000e2: 1,
    ann_0000e3: 2,
    ann_0000e4: 3,
    ann_0000e1: 4,
  })
  all = numberOff(all, 'ann_0000e3')
  // Releasing a number in the middle closes the sequence up, INCLUDING the box
  // whose stored pin now points past the end.
  check('releasing a number closes the sequence up around the pins', numbersOf(all), {
    ann_0000e2: 1,
    ann_0000e4: 2,
    ann_0000e1: 3,
  })
}
{
  const ids = ['ann_0000f1', 'ann_0000f2', 'ann_0000f3']
  let all = ids.map((id, i) => box(id, at(i), { numbered: true }))
  all = assign(all, 'ann_0000f3', 1)
  // A pin is stored for the box that was moved. The boxes that merely slid along
  // are not pinned: they are still numbering automatically, around the one
  // decision the user actually made.
  check('a typed number stores one pin, not three', pinsOf(all), { ann_0000f3: 1 })
  const reloaded = JSON.parse(JSON.stringify(all)) as Annotation[]
  check('the assignment survives save and re-open', numbersOf(reloaded), numbersOf(all))
}

console.log('\nCONTIGUOUS FROM 1 — ALWAYS')
{
  // Every arrangement a pack can arrive carrying: pins that collide, pins past
  // the end, pins on unnumbered boxes, no pins at all. The numbers must always
  // be exactly 1..N. This is the guarantee the documents and the video share.
  let state = 20260731
  const random = (n: number): number => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state % n
  }
  let worst = ''
  let broken = 0
  for (let trial = 0; trial < 400; trial += 1) {
    const count = 1 + random(14)
    const all = Array.from({ length: count }, (_, i) => {
      const pin = random(4) === 0 ? undefined : 1 + random(14)
      return box(`ann_${String(trial).padStart(4, '0')}${String(i).padStart(2, '0')}`, at(i % 60), {
        numbered: random(5) !== 0,
        ...(pin === undefined ? {} : { pin }),
      })
    })
    const numbered = all.filter((a) => a.numbered).length
    const got = [...computeDisplayNumbers(all).values()].sort((a, b) => a - b)
    const want = Array.from({ length: numbered }, (_, i) => i + 1)
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      broken += 1
      if (worst === '') worst = `trial ${trial}: ${JSON.stringify(got)} for ${numbered} boxes`
    }
  }
  ok('400 random pin arrangements all number 1..N exactly once', broken === 0, worst)
}
{
  // The same guarantee after the editor has been used: assign, release, assign.
  const ids = ['ann_0000g1', 'ann_0000g2', 'ann_0000g3', 'ann_0000g4', 'ann_0000g5']
  let all = ids.map((id, i) => box(id, at(i)))
  for (const id of ids) all = numberOn(all, id)
  all = assign(all, 'ann_0000g5', 1)
  all = assign(all, 'ann_0000g2', 5)
  all = numberOff(all, 'ann_0000g1')
  all = numberOn(all, 'ann_0000g1')
  const got = [...computeDisplayNumbers(all).values()].sort((a, b) => a - b)
  check('a session of assignments still numbers 1..5', got, [1, 2, 3, 4, 5])
  check('and the last box re-numbered is last', computeDisplayNumbers(all).get('ann_0000g1'), 5)
}

console.log('\nONE IMPLEMENTATION')
{
  const numbering = source('src', 'shared', 'numbering.ts')
  const exports = numbering.match(/^export\b/gmu) ?? []
  ok(
    'shared/numbering.ts re-exports exactly one function',
    exports.length === 1 && numbering.includes('export { computeDisplayNumbers }'),
    `${exports.length} export statements`,
  )
  // Every surface that draws or prints a number, and where it gets the rule.
  for (const file of [
    ['src', 'renderer', 'editor', 'editor.ts'],
    ['src', 'renderer', 'render', 'render.ts'],
    ['src', 'main', 'report.ts'],
    ['src', 'main', 'packdocs.ts'],
    ['src', 'main', 'viewer.ts'],
    ['src', 'main', 'session.ts'],
    ['src', 'main', 'mcp', 'tools.ts'],
  ]) {
    const text = source(...file)
    ok(
      `${file.join('/')} imports the shared rule`,
      /import \{ computeDisplayNumbers \} from '[^']*shared\/numbering'/u.test(text) &&
        !/function computeDisplayNumbers/u.test(text),
    )
  }
  const types = source('src', 'shared', 'types.ts')
  ok(
    'the rule is written down exactly once',
    (types.match(/export function computeDisplayNumbers/gu) ?? []).length === 1,
  )
}

console.log('\nTHE EDITOR ASKS FOR THE ASSIGNMENT')
{
  const editor = source('src', 'renderer', 'editor', 'editor.ts')
  const toggleStart = editor.indexOf('function toggleSelectedNumbering()')
  const toggle = toggleStart < 0 ? '' : editor.slice(toggleStart, editor.indexOf('\n}', toggleStart))
  ok(
    'the [#] toggle assigns the next number',
    toggle.includes('nextDisplayNumber(') && toggle.includes('planNumberPins('),
  )
  ok(
    'turning numbering off releases the number',
    /numbered = false/u.test(toggle) && /delete \w+\.number_pin/u.test(toggle),
  )
  const html = source('src', 'renderer', 'editor', 'editor.html')
  ok(
    'the picker is built from the numbers the pack has, not a fixed 1-9 list',
    !html.includes('data-pin="9"') && editor.includes('numberPinChoices'),
  )
}

console.log(
  failed === 0 ? '\nnumber-assignment-check ok' : `\nnumber-assignment-check FAILED (${failed})`,
)
process.exitCode = failed === 0 ? 0 : 1
