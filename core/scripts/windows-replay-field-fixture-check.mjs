import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const {
  movementDisplayOrder,
  requestedFixtureStartDisplayId,
} = require('./fixtures/windows-replay-field-order.cjs')
const {
  durationVerdict,
  parseRecorderAvailability,
} = require('./fixtures/windows-replay-field-duration.cjs')
const {
  actualObjectPickVerdict,
} = require('./fixtures/windows-replay-field-pick.cjs')

let passed = 0
let failed = 0

function check(name, condition, detail = '') {
  if (condition) passed += 1
  else failed += 1
  console.log(
    `  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`,
  )
}

const displays = [
  {
    id: 111,
    index: 1,
    rotation: 90,
    scaleFactor: 1,
    bounds: { x: -1200, y: 0, width: 1200, height: 1920 },
  },
  {
    id: 222,
    index: 2,
    rotation: 0,
    scaleFactor: 1.5,
    bounds: { x: 0, y: 0, width: 2560, height: 1440 },
  },
  {
    id: 333,
    index: 3,
    rotation: 0,
    scaleFactor: 1.25,
    bounds: { x: 2560, y: -360, width: 1920, height: 1080 },
  },
]

console.log('PURE DISPLAY ORDER CONTRACT')
{
  const primaryFirst = movementDisplayOrder(displays, '222', 'primary')
  check(
    'primary start rotates only movement order',
    primaryFirst.displays.map((display) => String(display.id)).join(',') === '222,333,111',
    primaryFirst.displays.map((display) => String(display.id)).join(','),
  )
  check(
    'layout array/index, negative origin, portrait and mixed DPI remain untouched',
    displays.map((display) => ({
      id: String(display.id),
      index: display.index,
      x: display.bounds.x,
      width: display.bounds.width,
      height: display.bounds.height,
      scale: display.scaleFactor,
      rotation: display.rotation,
    })).map(JSON.stringify).join('|') === [
      { id: '111', index: 1, x: -1200, width: 1200, height: 1920, scale: 1, rotation: 90 },
      { id: '222', index: 2, x: 0, width: 2560, height: 1440, scale: 1.5, rotation: 0 },
      { id: '333', index: 3, x: 2560, width: 1920, height: 1080, scale: 1.25, rotation: 0 },
    ].map(JSON.stringify).join('|'),
  )
  check(
    'explicit display 3 rotates through every display exactly once',
    movementDisplayOrder(displays, '222', '333').displays
      .map((display) => String(display.id))
      .join(',') === '333,111,222',
  )
  check(
    'omitting the option preserves the historical Electron display order',
    movementDisplayOrder(displays, '222', null).displays
      .map((display) => String(display.id))
      .join(',') === '111,222,333',
  )
  let unknownRejected = false
  try {
    movementDisplayOrder(displays, '222', 'missing')
  } catch {
    unknownRejected = true
  }
  check('an unknown start display is rejected instead of silently measuring a static screen', unknownRejected)
}

console.log('\nFIELD TARGET -> FIXTURE START CONTRACT')
check(
  'one explicit target starts on that exact display id',
  requestedFixtureStartDisplayId('333') === '333',
)
check(
  'primary target resolves inside the fixture against Electron primary',
  requestedFixtureStartDisplayId('primary') === 'primary',
)
check(
  'all-display runs start movement on primary for calibration',
  requestedFixtureStartDisplayId('all') === 'primary',
)

const fixtureSource = readFileSync(
  path.join(here, 'fixtures', 'windows-replay-field-surface.cjs'),
  'utf8',
)
const fieldSource = readFileSync(
  path.join(here, 'windows-replay-field-check.mjs'),
  'utf8',
)
const durationSource = readFileSync(
  path.join(here, 'fixtures', 'windows-replay-field-duration.cjs'),
  'utf8',
)
check(
  'fixture keeps layout order separate from rotated movement order',
  fixtureSource.includes('const movementOrder = movementDisplayOrder(')
    && fixtureSource.includes('const display = movementOrder.displays[displaySlot]')
    && fixtureSource.includes('layout.displays.flatMap('),
)
check(
  'field runner passes the requested start display before fixture startup',
  fieldSource.includes('const fixtureStartDisplayId = requestedFixtureStartDisplayId(targetOption)')
    && fieldSource.includes('`--start-display-id=${fixtureStartDisplayId}`'),
)
check(
  'field runner verifies the fixture actually started on the resolved calibration display',
  fieldSource.includes('layout.movement_start_display_id !== expectedFixtureStartDisplayId'),
)
check(
  'field replay hashing preserves the encoded VFR cadence instead of dropping a valid frame',
  fieldSource.includes("'-fps_mode', 'passthrough'")
    && fieldSource.includes("'-f', 'framemd5', '-'"),
)
check(
  'visual object-pick truth decodes the requested pack time, not a stale materialized sample time',
  fieldSource.includes(
    'query.requested_t_ms + Number(display?.replay_clock_offset_ms ?? 0)',
  )
    && fieldSource.includes(
      'five points inside decoded replay target pixels at the requested pack time',
    ),
)
check(
  'field reopen verification passes persisted display mapping through the production helper',
  fieldSource.includes('reopen: {')
    && fieldSource.includes('screens: manifest.environment.screens')
    && fieldSource.includes('displays: manifest.media.displays'),
)
const helperSource = readFileSync(
  path.join(here, 'windows-replay-field-helper.entry.ts'),
  'utf8',
)
check(
  'field helper resolves its second session through reopenedContextDisplayTargets',
  helperSource.includes('reopenedContextDisplayTargets(')
    && helperSource.includes('querySession(second.observations, {')
    && helperSource.includes('displays: reopenedDisplays,'),
)

console.log('\nFILLED VS HONESTLY UNFILLED REPLAY DURATION')
{
  const timing = parseRecorderAvailability([
    '2026-07-30T09:17:40.613Z INFO  [capture] --capture-now: capturing in 15s',
    '2026-07-30T09:17:44.515Z INFO  [capture] display 391525080: primary recorder readiness after 2015 ms (3 presented frames, timeout=false, excluded-before-recorder=2015 ms, presentation-span=1047 ms)',
    '2026-07-30T09:17:45.900Z INFO  [capture] display 987654321: primary recorder readiness after 2010 ms (3 presented frames, timeout=false, excluded-before-recorder=2010 ms, presentation-span=1042 ms)',
    '2026-07-30T09:17:55.615Z INFO  [capture] capture requested',
  ].join('\n'))
  check(
    'actual timestamp distance, not launch delay minus a guessed readiness wait, measures availability',
    timing.capture_requested_at === '2026-07-30T09:17:55.615Z'
      && timing.displays[0]?.ready_at === '2026-07-30T09:17:44.515Z'
      && timing.displays[0]?.available_span_ms === 11_100,
    JSON.stringify(timing),
  )
  check(
    'each display keeps its own recorder-available span',
    timing.displays[1]?.display_id === '987654321'
      && timing.displays[1]?.available_span_ms === 9_715,
    JSON.stringify(timing.displays),
  )
  const restartedTiming = parseRecorderAvailability([
    '2026-07-30T09:17:41.000Z INFO  [capture] display 391525080: primary recorder readiness after 2000 ms (3 presented frames, timeout=false, excluded-before-recorder=2000 ms)',
    '2026-07-30T09:17:49.000Z INFO  [capture] display 391525080: primary recorder readiness after 1800 ms (3 presented frames, timeout=false, excluded-before-recorder=1800 ms)',
    '2026-07-30T09:17:55.000Z INFO  [capture] capture requested',
  ].join('\n'))
  check(
    'a recorder restart uses the latest readiness before capture, not stale startup readiness',
    restartedTiming.displays.length === 1
      && restartedTiming.displays[0]?.ready_at === '2026-07-30T09:17:49.000Z'
      && restartedTiming.displays[0]?.available_span_ms === 6_000,
    JSON.stringify(restartedTiming),
  )

  const unfilled = durationVerdict({
    requestedRetentionMs: 12_000,
    measuredAvailableSpanMs: 11_100,
    actualDurationMs: 11_106,
    nominalFrameIntervalMs: 1000 / 30,
    fillToleranceMs: 240,
  })
  check(
    'an honestly unfilled replay expects min(retention, measured available span)',
    unfilled.buffer_state === 'unfilled'
      && unfilled.expected_duration_ms === 11_100
      && unfilled.fills_requested_window === false
      && unfilled.matches_expected_duration === true
      && unfilled.pass === true,
    JSON.stringify(unfilled),
  )
  const filledFailure = durationVerdict({
    requestedRetentionMs: 12_000,
    measuredAvailableSpanMs: 14_000,
    actualDurationMs: 11_106,
    nominalFrameIntervalMs: 1000 / 30,
    fillToleranceMs: 240,
  })
  check(
    'the same short duration still fails once the recorder had time to fill retention',
    filledFailure.buffer_state === 'filled'
      && filledFailure.expected_duration_ms === 12_000
      && filledFailure.fills_requested_window === false
      && filledFailure.pass === false,
    JSON.stringify(filledFailure),
  )
  const unavailableTiming = durationVerdict({
    requestedRetentionMs: 12_000,
    measuredAvailableSpanMs: null,
    actualDurationMs: 11_106,
    nominalFrameIntervalMs: 1000 / 30,
    fillToleranceMs: 240,
  })
  check(
    'missing readiness timestamps never grant the underfilled exception',
    unavailableTiming.buffer_state === 'unknown'
      && unavailableTiming.expected_duration_ms === 12_000
      && unavailableTiming.pass === false,
    JSON.stringify(unavailableTiming),
  )
  const tooShort = durationVerdict({
    requestedRetentionMs: 12_000,
    measuredAvailableSpanMs: 11_100,
    actualDurationMs: 9_000,
    nominalFrameIntervalMs: 1000 / 30,
    fillToleranceMs: 240,
  })
  check(
    'underfilled does not excuse losing measured recorder-available footage',
    tooShort.buffer_state === 'unfilled'
      && tooShort.matches_expected_duration === false
      && tooShort.pass === false,
    JSON.stringify(tooShort),
  )
}

console.log('\nDECODED PIXELS -> PRODUCTION OBJECT PICK VERDICT')
{
  const noVisualTarget = actualObjectPickVerdict([{
    visual_pick_expected_count: 0,
    picks: [],
  }])
  check(
    'a vacuous frame with no decoded target cannot claim object-pick coverage',
    noVisualTarget.pass === false
      && noVisualTarget.attempted_point_count === 0,
    JSON.stringify(noVisualTarget),
  )
  const everyPointHits = actualObjectPickVerdict([
    {
      visual_pick_expected_count: 0,
      picks: [],
    },
    {
      visual_pick_expected_count: 5,
      picks: Array.from({ length: 5 }, () => ({ picked_target: true })),
    },
  ])
  check(
    'all five decoded-pixel probes selecting the target passes',
    everyPointHits.pass === true
      && everyPointHits.attempted_point_count === 5
      && everyPointHits.successful_point_count === 5,
    JSON.stringify(everyPointHits),
  )
  const missingPoint = actualObjectPickVerdict([{
    visual_pick_expected_count: 5,
    picks: Array.from({ length: 4 }, () => ({ picked_target: true })),
  }])
  check(
    'one untested decoded-pixel point fails instead of shrinking coverage',
    missingPoint.pass === false,
    JSON.stringify(missingPoint),
  )
  const wrongSurface = actualObjectPickVerdict([{
    visual_pick_expected_count: 5,
    picks: [
      ...Array.from({ length: 4 }, () => ({ picked_target: true })),
      { picked_target: false },
    ],
  }])
  check(
    'one underlying-window result fails even when candidate counts match',
    wrongSurface.pass === false
      && wrongSurface.successful_point_count === 4,
    JSON.stringify(wrongSurface),
  )
}

check(
  'field report parses timestamp-bounded recorder availability',
  fieldSource.includes('parseRecorderAvailability(mainLog)')
    && fieldSource.includes('capture_requested_at: recorderAvailability.capture_requested_at'),
)
check(
  'field verdict reports filled/unfilled state and expected duration',
  fieldSource.includes('durationVerdict({')
    && fieldSource.includes('duration_expectation: {')
    && fieldSource.includes('observed_buffer_state:')
    && fieldSource.includes('duration_buffer_state: durationExpectation.buffer_state'),
)
check(
  'field pass uses the bounded duration verdict without weakening the filled threshold',
  fieldSource.includes('&& media.criteria.duration_verdict_pass')
    && fieldSource.includes('duration_fills_requested_window:')
    && durationSource.includes('fills_requested_window: fillsRequested')
    && durationSource.includes(
      "&& (bufferState === 'unfilled' ? matchesExpected : fillsRequested)",
    ),
)

console.log(`\nresult: ${failed === 0 ? 'OK' : 'FAILED'} — ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
