// DISPLAY NUMBERS: CREATION ORDER, AND THE NUMBER THE USER ASKED FOR (SPEC §8.5).
//
// Two reports drove this. "버튼 숫자도 버그가 있네 마지막에 누른게 뒤로 가야지" —
// numbering sorted by `start_ms`, so a box drawn LAST but scrubbed back to an
// earlier frame took number 1 and renumbered everything made before it. And
// "숫자는 1~9 까지 지정가능하게 해" — a number the user chooses.
//
// computeDisplayNumbers is the ONE implementation every consumer derives from
// (the editor canvas, the annotated replay, report.md, README.md, skills/, MCP),
// so a regression here makes the video and the documents disagree. That is what
// this check exists to stop.
//
// Run: npm run check:numbering
import { computeDisplayNumbers } from '../src/shared/types'
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

let seq = 0
/** A numbered box. `at` is its creation instant; `start` where it sits on the replay. */
function box(
  id: string,
  at: string,
  opts: { start?: number; pin?: number; numbered?: boolean } = {},
): Annotation {
  seq += 1
  return {
    annotation_id: id,
    type: 'box',
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    text: '',
    ...(opts.start === undefined ? {} : { start_ms: opts.start, end_ms: opts.start + 1000 }),
    numbered: opts.numbered ?? true,
    ...(opts.pin === undefined ? {} : { number_pin: opts.pin }),
    blur: false,
    tracking: { enabled: false },
    created_at: at,
    z: seq,
  } as Annotation
}

const numbersOf = (as: Annotation[]): Record<string, number> =>
  Object.fromEntries([...computeDisplayNumbers(as)].sort((a, b) => a[1] - b[1]))

console.log('ORDER — creation, not timeline')
{
  // Drawn first at 10 s, then scrubbed BACK and drawn at 1 s. The second box is
  // earlier on the replay and later in the making; it must be ②.
  const first = box('ann_000001', '2026-07-29T18:00:00+09:00', { start: 10_000 })
  const second = box('ann_000002', '2026-07-29T18:00:05+09:00', { start: 1_000 })
  check('a box drawn later but scrubbed earlier is still second', numbersOf([first, second]), {
    ann_000001: 1,
    ann_000002: 2,
  })
  check('array order does not decide it', numbersOf([second, first]), {
    ann_000001: 1,
    ann_000002: 2,
  })
}
{
  // Same instant, different UTC offsets. Lexicographic text order would put
  // "…T10:22+01:00" before "…T18:22+09:00"; as instants they are equal, so the
  // tiebreak chain decides and the result must be stable either way round.
  const a = box('ann_00000a', '2026-07-29T18:22:00+09:00')
  const b = box('ann_00000b', '2026-07-29T10:22:00+01:00')
  check('equal instants across offsets fall to the tiebreak', numbersOf([a, b]), {
    ann_00000a: 1,
    ann_00000b: 2,
  })
}
{
  // An externally written pack: no created_at anywhere. It must number exactly
  // as it always did — z, then id.
  const bare = (id: string, z: number): Annotation =>
    ({
      annotation_id: id,
      type: 'box',
      bounds: { x: 0, y: 0, width: 10, height: 10 },
      text: '',
      numbered: true,
      blur: false,
      tracking: { enabled: false },
      created_at: '',
      z,
    }) as Annotation
  check('undated boxes keep the old z order', numbersOf([bare('ann_00000z', 5), bare('ann_00000y', 2)]), {
    ann_00000y: 1,
    ann_00000z: 2,
  })
  // Mixed: a dated box outranks an undated one, whatever its z.
  check(
    'a dated box comes before an undated one',
    numbersOf([bare('ann_0000nn', 1), box('ann_0000dd', '2026-07-29T18:00:00+09:00')]),
    { ann_0000dd: 1, ann_0000nn: 2 },
  )
}

console.log('PINS')
{
  const a = box('ann_00000p', '2026-07-29T18:00:00+09:00')
  const b = box('ann_00000q', '2026-07-29T18:00:01+09:00', { pin: 1 })
  const c = box('ann_00000r', '2026-07-29T18:00:02+09:00')
  // b claimed 1; a and c fill the smallest free numbers in creation order.
  check('a pin claims its number and the rest fill around it', numbersOf([a, b, c]), {
    ann_00000q: 1,
    ann_00000p: 2,
    ann_00000r: 3,
  })
}
{
  const a = box('ann_0000s1', '2026-07-29T18:00:00+09:00', { pin: 3 })
  const b = box('ann_0000s2', '2026-07-29T18:00:01+09:00', { pin: 3 })
  const c = box('ann_0000s3', '2026-07-29T18:00:02+09:00')
  // PIN MOVED WITH #51. It used to be "the first created keeps 3, the loser
  // falls back to automatic and lands on 1". Contiguity is now absolute, so the
  // loser cannot fall back to a number outside the sequence: it takes the
  // nearest free slot instead, and the automatic box gets what is left. The
  // editor never writes two boxes claiming one slot — typing 3 pushes the box
  // that held it along (see number-assignment-check) — so what this pins is a
  // FOREIGN pack's answer: contiguous, and the same every time it is read.
  check('two boxes claiming 3: first created keeps it, the other lands beside it', numbersOf([a, b, c]), {
    ann_0000s3: 1,
    ann_0000s2: 2,
    ann_0000s1: 3,
  })
}
{
  const only = box('ann_0000g1', '2026-07-29T18:00:00+09:00', { pin: 5 })
  // PIN MOVED WITH #51: this used to assert a ⑤ with no ①-④, and that gap is
  // exactly what the issue outlawed. 5 is not a number a one-box pack has, so
  // the claim lands on the last slot there is.
  check('a lone box pinned to 5 is ①, because 5 is not a number this pack has', numbersOf([only]), {
    ann_0000g1: 1,
  })
}
{
  const boxes = Array.from({ length: 12 }, (_, i) =>
    box(`ann_00c${String(i).padStart(3, '0')}`, `2026-07-29T18:00:${String(i).padStart(2, '0')}+09:00`),
  )
  const got = numbersOf(boxes)
  check('twelve boxes all get a number', Object.values(got), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
}
{
  // ...and the twelfth can be ASKED for, which is why the 1-9 cap on a pin went
  // away with #51: a number the user can be given is a number they can choose.
  const boxes = Array.from({ length: 12 }, (_, i) =>
    box(`ann_00d${String(i).padStart(3, '0')}`, `2026-07-29T18:00:${String(i).padStart(2, '0')}+09:00`, {
      ...(i === 0 ? { pin: 12 } : {}),
    }),
  )
  check('a box can be pinned to 12 in a twelve-box pack', numbersOf(boxes).ann_00d000, 12)
}
{
  const a = box('ann_0000i1', '2026-07-29T18:00:00+09:00', { pin: 2, numbered: false })
  const b = box('ann_0000i2', '2026-07-29T18:00:01+09:00')
  // A pin on an unnumbered box is inert, not an error: a box that shows no
  // number holds no slot, so a foreign writer's leftover pin cannot punch a hole
  // in the sequence. (This editor does not leave one behind — turning numbering
  // off releases the number, #51.)
  check('a pin on an unnumbered box is inert', numbersOf([a, b]), { ann_0000i2: 1 })
}
{
  const a = box('ann_0000v1', '2026-07-29T18:00:00+09:00', { pin: 0 })
  const b = box('ann_0000v2', '2026-07-29T18:00:01+09:00', { pin: 10 })
  const c = box('ann_0000v3', '2026-07-29T18:00:02+09:00', { pin: 2.5 })
  // PIN MOVED WITH #51. Below 1 and non-integers are still ignored — they name
  // no slot at all. 10 is no longer "out of range": it is a claim on the last
  // slot of a three-box pack, so b is ③ and the two ignored pins fill in around
  // it in creation order.
  check('pins below 1 and non-integers are ignored; a high pin claims the last slot', numbersOf([a, b, c]), {
    ann_0000v1: 1,
    ann_0000v3: 2,
    ann_0000v2: 3,
  })
}

console.log('NO PINS — unchanged apart from the ordering')
{
  // The whole point of the pin model: a pack that uses none of it numbers
  // contiguously from 1 in creation order, exactly as before.
  const boxes = Array.from({ length: 5 }, (_, i) =>
    box(`ann_00n${String(i).padStart(3, '0')}`, `2026-07-29T18:00:0${i}+09:00`, { start: (5 - i) * 1000 }),
  )
  check('five unpinned boxes number 1..5 in creation order', Object.values(numbersOf(boxes)), [
    1, 2, 3, 4, 5,
  ])
}

console.log('ROUND TRIP')
{
  const original = [
    box('ann_00r001', '2026-07-29T18:00:00+09:00', { pin: 4 }),
    box('ann_00r002', '2026-07-29T18:00:01+09:00'),
  ]
  // A pack is JSON on disk; a pin has to survive being written and read back.
  const reloaded = JSON.parse(JSON.stringify({ annotations: original })).annotations as Annotation[]
  check('pins survive save and re-open', numbersOf(reloaded), numbersOf(original))
  check('the pin field itself round-trips', reloaded[0]?.number_pin, 4)
}

console.log(failed === 0 ? '\nnumbering-check ok' : `\nnumbering-check FAILED (${failed})`)
process.exitCode = failed === 0 ? 0 : 1
