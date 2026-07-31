/**
 * A BOX STARTS WHEN THE THING IT NAMES HAPPENS (#109).
 *
 * `lifetime.ts` states that rule three times and had no test, so it survived in
 * one function and not in the other. `lifetimeFrom` keeps the anchor and lets
 * the duration shorten at the end of the replay; `lifetimeExtending` — the one
 * the comment above `lifetimeFrom` claims "was just corrected" — still pulled
 * the start backwards to protect the nominal duration.
 *
 * Measured on CapturePack_2026-07-31_180722: a window box asked for ten seconds
 * on a 14656 ms replay came back as 4656..14656. The start moved 7.3 s earlier,
 * into frames where the window had not been picked yet.
 */

import {
  formatDurationLabel,
  lifetimeExtending,
  lifetimeFrom,
  lifetimeMidpoint,
  parseDurationMs,
  visibleAt,
} from '../src/renderer/editor/lifetime'
import type { Annotation } from '../src/shared/types'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) passed += 1
  else failed += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

function life(value: { start_ms: number; end_ms: number }): string {
  return `${value.start_ms}..${value.end_ms} (${value.end_ms - value.start_ms} ms)`
}

// ---------------------------------------------------------------------------
// The rule, on both paths.
// ---------------------------------------------------------------------------

console.log('\nThe start is never moved backwards to protect a duration')

const REPLAY_MS = 14_656

// The reported capture: a ten-second lifetime asked for on a box that starts
// late. There is not ten seconds left, and that is the honest answer.
const extendedLate = lifetimeExtending(12_000, 10_000, REPLAY_MS)
check(
  'extending a box near the end shortens the box, not its start',
  extendedLate.start_ms === 12_000 && extendedLate.end_ms === REPLAY_MS,
  life(extendedLate),
)
const createdLate = lifetimeFrom(12_000, 10_000, REPLAY_MS)
check(
  'creating a box near the end already did that',
  createdLate.start_ms === 12_000 && createdLate.end_ms === REPLAY_MS,
  life(createdLate),
)
check(
  'the two paths agree, because they are the same rule',
  extendedLate.start_ms === createdLate.start_ms
    && extendedLate.end_ms === createdLate.end_ms,
)

// The exact numbers the pack recorded, as the regression they were.
const reported = lifetimeExtending(12_000, 10_000, REPLAY_MS)
check(
  'the reported 4656..14656 can no longer be produced from a start of 12000',
  reported.start_ms !== 4_656,
  life(reported),
)

console.log('\nWhat extending is still allowed to do')

const roomToGrow = lifetimeExtending(2_000, 5_000, REPLAY_MS)
check(
  'with room, the end moves and the start does not',
  roomToGrow.start_ms === 2_000 && roomToGrow.end_ms === 7_000,
  life(roomToGrow),
)
const shrunk = lifetimeExtending(2_000, 500, REPLAY_MS)
check(
  'shortening also keeps the start',
  shrunk.start_ms === 2_000 && shrunk.end_ms === 2_500,
  life(shrunk),
)
const atTheVeryEnd = lifetimeExtending(REPLAY_MS, 10_000, REPLAY_MS)
check(
  'a box that starts at the last frame is a zero-length box, not a backwards one',
  atTheVeryEnd.start_ms === REPLAY_MS && atTheVeryEnd.end_ms === REPLAY_MS,
  life(atTheVeryEnd),
)
const beforeTheStart = lifetimeExtending(-500, 1_000, REPLAY_MS)
check(
  'a start before the replay is clamped forward, never left negative',
  beforeTheStart.start_ms === 0 && beforeTheStart.end_ms === 1_000,
  life(beforeTheStart),
)
const pastTheEnd = lifetimeExtending(REPLAY_MS + 5_000, 1_000, REPLAY_MS)
check(
  'a start past the replay is clamped back to it',
  pastTheEnd.start_ms === REPLAY_MS && pastTheEnd.end_ms === REPLAY_MS,
  life(pastTheEnd),
)
check(
  'fractional input is rounded, not carried',
  lifetimeExtending(1_000.4, 999.6, REPLAY_MS).end_ms === 2_000,
  life(lifetimeExtending(1_000.4, 999.6, REPLAY_MS)),
)

// ---------------------------------------------------------------------------
// The rest of the module, which had no test either.
// ---------------------------------------------------------------------------

console.log('\nReading a lifetime back')

const box = (start: number, end: number): Annotation => ({
  annotation_id: 'ann_life',
  type: 'box',
  bounds: { x: 0, y: 0, width: 10, height: 10 },
  text: '',
  numbered: false,
  blur: false,
  tracking: { enabled: false },
  created_at: '2026-07-31T00:00:00.000Z',
  z: 1,
  start_ms: start,
  end_ms: end,
}) as Annotation

check(
  'the representative instant is the midpoint',
  lifetimeMidpoint(box(1_000, 3_000), REPLAY_MS) === 2_000,
)
check(
  'an absent lifetime is represented by the capture instant',
  lifetimeMidpoint(
    { ...box(0, 0), start_ms: undefined, end_ms: undefined } as Annotation,
    REPLAY_MS,
  ) === REPLAY_MS,
)
check(
  'a box applies inside its lifetime and not outside it',
  visibleAt(box(1_000, 2_000), 1_500, false, REPLAY_MS)
    && !visibleAt(box(1_000, 2_000), 2_001, false, REPLAY_MS)
    && !visibleAt(box(1_000, 2_000), 999, false, REPLAY_MS),
)
check(
  'at "now" only a lifetime covering the end of the replay applies',
  visibleAt(box(1_000, REPLAY_MS), 0, true, REPLAY_MS)
    && !visibleAt(box(1_000, 2_000), 0, true, REPLAY_MS),
)

console.log('\nThe duration editor')

check(
  'plain numbers and ms are milliseconds, s is seconds',
  parseDurationMs('1500') === 1_500
    && parseDurationMs('1500ms') === 1_500
    && parseDurationMs('1.5s') === 1_500
    && parseDurationMs(' 2 S ') === 2_000,
)
check(
  'anything that is not a positive duration is refused',
  parseDurationMs('0') === null
    && parseDurationMs('-1') === null
    && parseDurationMs('') === null
    && parseDurationMs('soon') === null
    && parseDurationMs('1.5m') === null,
)
check(
  'the label is one decimal of a second',
  formatDurationLabel(1_500) === '1.5s'
    && formatDurationLabel(500) === '0.5s'
    && formatDurationLabel(0) === '0.0s',
  `${formatDurationLabel(1_500)} / ${formatDurationLabel(500)} / ${formatDurationLabel(0)}`,
)

console.log(`\nresult: ${failed === 0 ? 'OK' : 'FAILED'} — ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
