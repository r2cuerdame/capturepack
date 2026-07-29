import { buildManifest } from '../src/main/exporter'
import { readFileSync } from 'node:fs'
import {
  contextFrameRequestsForDisplays,
  displayReplayRangeMs,
  observedReplayClockOffsetMs,
  retainedDisplayReplayMask,
  resolveFocusedReplayTimelineClock,
  resolvedReplayClockOffsetMs,
} from '../src/shared/displayClock'

let failed = 0
let passed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) passed += 1
  else failed += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

const focusedRawOriginMs = 12_000
const focusedSourceStartMs = 5_000
const packOriginMs = focusedRawOriginMs + focusedSourceStartMs
const secondaryOriginMs = 16_000
const measuredOffsetMs = observedReplayClockOffsetMs(packOriginMs, secondaryOriginMs)

const focusedTimeline = resolveFocusedReplayTimelineClock({
  replayOriginMs: 100_000,
  replayRequestWallMs: 130_000,
  captureWallMs: 129_500,
  rawDurationMs: 30_000,
  logicalDurationMs: 25_000,
})
check(
  'raw save-first and logical pack t0 share the focused measured origin',
  focusedTimeline.measured &&
    focusedTimeline.rawT0Ms === 100_000 &&
    focusedTimeline.packT0Ms === 105_000 &&
    focusedTimeline.packEndMs === 130_000,
)
const slowSecondaryReadyAt = 180_000
check(
  'a slow secondary reply cannot shift the focused pack t0',
  focusedTimeline.packT0Ms === 105_000 &&
    focusedTimeline.packT0Ms !== slowSecondaryReadyAt - 25_000,
)
const delayedFlushTimeline = resolveFocusedReplayTimelineClock({
  replayOriginMs: 100_000,
  // Even a wildly late wall fallback cannot override measured pixels.
  replayRequestWallMs: 175_000,
  captureWallMs: 129_500,
  rawDurationMs: 30_000,
  logicalDurationMs: 25_000,
})
check(
  'slow stop/flush latency cannot override a measured replay origin',
  delayedFlushTimeline.packT0Ms === focusedTimeline.packT0Ms,
)
const legacyTimeline = resolveFocusedReplayTimelineClock({
  replayOriginMs: undefined,
  replayRequestWallMs: 130_000,
  captureWallMs: 129_500,
  rawDurationMs: 30_000,
  logicalDurationMs: 25_000,
})
check(
  'an origin-less legacy renderer uses the focused pre-request wall fallback',
  !legacyTimeline.measured &&
    legacyTimeline.rawT0Ms === 100_000 &&
    legacyTimeline.packT0Ms === 105_000,
)
const screenshotTimeline = resolveFocusedReplayTimelineClock({
  replayOriginMs: undefined,
  replayRequestWallMs: 180_000,
  captureWallMs: 129_500,
  rawDurationMs: 0,
  logicalDurationMs: 0,
})
check(
  'a screenshot-only failed recording stays at the capture instant',
  screenshotTimeline.packT0Ms === 129_500 && screenshotTimeline.packEndMs === 129_500,
)

check('fresh capture uses the focused source in-point in its pack origin', measuredOffsetMs === 1_000)
check(
  'an unavailable recorder origin stays explicitly unknown',
  observedReplayClockOffsetMs(packOriginMs, undefined) === undefined,
)
check(
  'a persisted observed offset wins over contradictory replay durations on reopen',
  resolvedReplayClockOffsetMs(measuredOffsetMs, 24_000, 25_000) === 1_000,
)
check(
  'a legacy pack falls back to its duration difference',
  resolvedReplayClockOffsetMs(undefined, 24_000, 25_000) === -1_000,
)

check(
  'a failed focused recorder discards every orphaned secondary replay',
  retainedDisplayReplayMask([
    { focused: true, hasReplay: false },
    { focused: false, hasReplay: true },
    { focused: false, hasReplay: true },
  ]).join(',') === 'false,false,false',
)
check(
  'a live focused recorder keeps only displays that actually returned replay bytes',
  retainedDisplayReplayMask([
    { focused: true, hasReplay: true },
    { focused: false, hasReplay: true },
    { focused: false, hasReplay: false },
  ]).join(',') === 'true,true,false',
)
check(
  'a capture with no declared focused clock never retains a display replay',
  retainedDisplayReplayMask([
    { focused: false, hasReplay: true },
    { focused: false, hasReplay: true },
  ]).every((keep) => !keep),
)

const exactRange = displayReplayRangeMs(5_000, 10_000, measuredOffsetMs, 24_000, 25_000)
check(
  'exact cut maps the kept pack interval through the observed clock',
  exactRange.startMs === 6_000 && exactRange.endMs === 11_000,
)
const legacyRange = displayReplayRangeMs(5_000, 10_000, undefined, 24_000, 25_000)
check(
  'legacy exact cut retains duration-difference behavior',
  legacyRange.startMs === 4_000 && legacyRange.endMs === 9_000,
)

// Cutting shifts each replay's origin by the source interval actually removed.
// Both sources below therefore start on the same measured instant afterwards.
const cutFocusedOriginMs = focusedRawOriginMs + focusedSourceStartMs + 5_000
const cutSecondaryOriginMs = secondaryOriginMs + exactRange.startMs
check(
  'rebased exact-cut origins resolve to a zero offset when both cuts start together',
  observedReplayClockOffsetMs(cutFocusedOriginMs, cutSecondaryOriginMs) === 0,
)

const manifest = buildManifest({
  id: 'display-clock-check',
  createdAt: new Date('2026-07-30T00:00:00.000Z'),
  generatorVersion: 'check',
  title: '',
  note: '',
  osVersion: 'check',
  screens: [
    { width: 1_920, height: 1_080, scale: 1 },
    { width: 2_560, height: 1_440, scale: 1 },
  ],
  captureKind: 'video',
  hasReplay: true,
  replayDurationMs: 25_000,
  snapshotTMs: null,
  displays: [
    {
      index: 1,
      focused: true,
      bounds: { x: 0, y: 0, width: 1_920, height: 1_080 },
      scale: 1,
      hasReplay: true,
      replayDurationMs: 25_000,
      snapshotFile: 'snapshot.png',
      replayFile: 'replay.webm',
    },
    {
      index: 2,
      focused: false,
      bounds: { x: 1_920, y: 0, width: 2_560, height: 1_440 },
      scale: 1,
      hasReplay: true,
      replayDurationMs: 24_000,
      replayClockOffsetMs: measuredOffsetMs,
      snapshotFile: 'snapshot-d2.png',
      replayFile: 'replay-d2.webm',
    },
  ],
})
const declared = manifest.media.displays ?? []
check(
  'writer persists focused zero and the measured secondary offset',
  declared[0]?.replay_clock_offset_ms === 0 &&
    declared[1]?.replay_clock_offset_ms === measuredOffsetMs,
)
const reopenedOffsetMs = resolvedReplayClockOffsetMs(
  declared[1]?.replay_clock_offset_ms,
  declared[1]?.replay_duration_ms ?? 0,
  manifest.media.replay_duration_ms ?? 0,
)
const reopenedContextRequests = contextFrameRequestsForDisplays(false, 25_000, [
  { display: 1, hasReplay: true, presentedMs: 12_000 },
  {
    display: 2,
    hasReplay: true,
    // SlaveReplay converts its raw presented frame back onto the pack clock by
    // subtracting this persisted offset before context is queried.
    presentedMs: 13_250 - reopenedOffsetMs,
  },
])
check(
  'reopened displays query context at their own divergent presented frames',
  reopenedContextRequests[0]?.timeMs === 12_000 &&
    reopenedContextRequests[1]?.timeMs === 12_250,
)
const frozenSecondaryRequests = contextFrameRequestsForDisplays(false, 25_000, [
  { display: 1, hasReplay: true, presentedMs: 12_000 },
  { display: 2, hasReplay: false, presentedMs: 12_000 },
])
check(
  'a replay-less secondary queries the capture instant shown by its frozen bitmap',
  frozenSecondaryRequests[0]?.timeMs === 12_000 &&
    frozenSecondaryRequests[1]?.timeMs === 25_000,
)
check(
  'native now queries one capture instant across the whole board',
  contextFrameRequestsForDisplays(true, 25_000, [
    { display: 1, hasReplay: true, presentedMs: 12_000 },
    { display: 2, hasReplay: true, presentedMs: 12_250 },
  ]).every((request) => request.timeMs === 25_000),
)
const editorSource = readFileSync('src/renderer/editor/editor.ts', 'utf8')
const scrubSource = readFileSync('src/renderer/editor/scrub.ts', 'utf8')
const sessionSource = readFileSync('src/main/session.ts', 'utf8')
const focusedReplayPolicyIndex = sessionSource.indexOf(
  'const retainedReplays = retainedDisplayReplayMask(',
)
const videoInitialSaveIndex = sessionSource.indexOf(
  'const initialSave: InitialSaveInput = {',
  focusedReplayPolicyIndex,
)
check(
  'fresh capture applies the focused-clock replay policy before save-first and editor init',
  focusedReplayPolicyIndex >= 0 &&
    videoInitialSaveIndex > focusedReplayPolicyIndex &&
    sessionSource.includes('withoutFrozenReplay(candidate)'),
)
check(
  'editor wires every display request to that display’s presented frame',
  editorSource.includes('presentedMs: scrub?.presentedMsFor(display.index)') &&
    editorSource.includes('contextFramesByDisplay.set(displayIndex, frame)'),
)
check(
  'a secondary frame settling late schedules a fresh context query',
  scrubSource.includes('host.drawFrame(r.displayIndex, source)') &&
    scrubSource.includes('host.onFrame?.()'),
)

const noReplayManifest = buildManifest({
  id: 'display-clock-no-replay-check',
  createdAt: new Date('2026-07-30T00:00:00.000Z'),
  generatorVersion: 'check',
  title: '',
  note: '',
  osVersion: 'check',
  screens: [
    { width: 1_920, height: 1_080, scale: 1 },
    { width: 2_560, height: 1_440, scale: 1 },
  ],
  captureKind: 'video',
  hasReplay: false,
  replayDurationMs: 0,
  snapshotTMs: null,
  displays: [
    {
      index: 1,
      focused: true,
      bounds: { x: 0, y: 0, width: 1_920, height: 1_080 },
      scale: 1,
      hasReplay: false,
      replayDurationMs: 0,
      replayClockOffsetMs: 0,
      snapshotFile: 'snapshot.png',
      replayFile: null,
    },
    {
      index: 2,
      focused: false,
      bounds: { x: 1_920, y: 0, width: 2_560, height: 1_440 },
      scale: 1,
      hasReplay: false,
      replayDurationMs: 0,
      replayClockOffsetMs: 99,
      snapshotFile: 'snapshot-d2.png',
      replayFile: null,
    },
  ],
})
check(
  'writer never declares an offset beside replay null',
  (noReplayManifest.media.displays ?? []).every(
    (display) => display.replay_clock_offset_ms === undefined,
  ),
)

console.log(`\nresult: ${failed === 0 ? 'OK' : 'FAILED'} — ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
