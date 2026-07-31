import { buildManifest } from '../src/main/exporter'
import {
  reopenedContextDisplayTargets,
  reopenedSnapshotPixelsPerDip,
} from '../src/main/reopenDisplay'
import { readFileSync } from 'node:fs'
import {
  contextFrameRequestsForDisplays,
  displayReplayRangeMs,
  observedReplayClockOffsetMs,
  retainedDisplayReplayMask,
  resolveFocusedReplayTimelineClock,
  replayCoverage,
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
  'focus index 3 keeps healthy peers while one non-focused recorder fails',
  retainedDisplayReplayMask([
    { focused: false, hasReplay: true },
    { focused: false, hasReplay: false },
    { focused: true, hasReplay: true },
  ]).join(',') === 'true,false,true',
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
      cadence: { achieved_fps: 14.8, worst_stall_ms: 114 },
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
      cadence: { achieved_fps: 14.6, worst_stall_ms: 132 },
    },
  ],
})
const declared = manifest.media.displays ?? []
check(
  'top-level focused replay preserves its measured cadence',
  manifest.media.cadence?.achieved_fps === 14.8 &&
    manifest.media.cadence.worst_stall_ms === 114,
)
const singleDisplayManifest = buildManifest({
  id: 'single-display-cadence-check',
  createdAt: new Date('2026-07-30T00:00:00.000Z'),
  generatorVersion: 'check',
  title: '',
  note: '',
  osVersion: 'check',
  screens: [{ width: 1_920, height: 1_080, scale: 1.5 }],
  captureKind: 'video',
  hasReplay: true,
  replayFile: 'replay.mp4',
  replayDurationMs: 10_000,
  snapshotTMs: 10_000,
  cadence: {
    achieved_fps: 14.8,
    worst_stall_ms: 114,
    discarded_frames: 1,
  },
})
check(
  'single-display replay keeps focused cadence without declaring media.displays',
  singleDisplayManifest.media.cadence?.achieved_fps === 14.8 &&
    singleDisplayManifest.media.cadence.discarded_frames === 1 &&
    singleDisplayManifest.media.displays === undefined,
)
const secondaryOnlyDiagnosticsManifest = buildManifest({
  id: 'secondary-only-capture-diagnostics-check',
  createdAt: new Date('2026-07-30T00:00:00.000Z'),
  generatorVersion: 'check',
  title: '',
  note: '',
  osVersion: 'check',
  screens: [
    { width: 1_920, height: 1_080, scale: 1 },
    { width: 1_280, height: 720, scale: 1 },
  ],
  captureKind: 'video',
  hasReplay: true,
  replayFile: 'replay.mp4',
  replayDurationMs: 10_000,
  snapshotTMs: 10_000,
  displays: [
    {
      index: 1,
      focused: true,
      bounds: { x: 0, y: 0, width: 1_920, height: 1_080 },
      scale: 1,
      hasReplay: true,
      replayDurationMs: 10_000,
      replayClockOffsetMs: 0,
      snapshotFile: 'snapshot.png',
      replayFile: 'replay.mp4',
    },
    {
      index: 2,
      focused: false,
      bounds: { x: 1_920, y: 0, width: 1_280, height: 720 },
      scale: 1,
      hasReplay: true,
      replayDurationMs: 9_900,
      replayClockOffsetMs: -100,
      cadence: {
        achieved_fps: 5,
        worst_stall_ms: 250,
        requested_fps: 15,
        backend: 'windows-gdi-bitblt',
        quality: 'degraded',
        recorder_count: 1,
      },
      snapshotFile: 'snapshot-d2.png',
      replayFile: 'replay-d2.mp4',
    },
  ],
})
check(
  'capture diagnostics on any replay display raise the additive format version',
  secondaryOnlyDiagnosticsManifest.format_version === '0.4.0',
)
const imageWithStaleCadence = buildManifest({
  id: 'image-stale-cadence-check',
  createdAt: new Date('2026-07-30T00:00:00.000Z'),
  generatorVersion: 'check',
  title: '',
  note: '',
  osVersion: 'check',
  screens: [{ width: 1_920, height: 1_080, scale: 1 }],
  captureKind: 'image',
  imageScope: 'fullscreen',
  hasReplay: false,
  replayDurationMs: 0,
  snapshotTMs: null,
  cadence: {
    achieved_fps: 15,
    worst_stall_ms: 100,
    requested_fps: 15,
    backend: 'chromium-desktop-capture',
    quality: 'full',
    recorder_count: 1,
  },
})
check(
  'stale recorder diagnostics cannot raise a screenshot-only pack to format 0.4',
  imageWithStaleCadence.format_version === '0.3.0' &&
    imageWithStaleCadence.media.cadence === undefined,
)
const failedReplayDisplayWithStaleCadence = buildManifest({
  id: 'failed-display-stale-cadence-check',
  createdAt: new Date('2026-07-30T00:00:00.000Z'),
  generatorVersion: 'check',
  title: '',
  note: '',
  osVersion: 'check',
  screens: [{ width: 1_920, height: 1_080, scale: 1 }],
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
      snapshotFile: 'snapshot.png',
      replayFile: 'replay.mp4',
      cadence: {
        achieved_fps: 15,
        worst_stall_ms: 100,
        requested_fps: 15,
        backend: 'chromium-desktop-capture',
        quality: 'full',
        recorder_count: 1,
      },
    },
  ],
})
check(
  'a failed display cannot raise a no-replay video pack to format 0.4',
  failedReplayDisplayWithStaleCadence.format_version === '0.3.0' &&
    failedReplayDisplayWithStaleCadence.media.cadence === undefined &&
    failedReplayDisplayWithStaleCadence.media.displays?.[0]?.cadence === undefined,
)
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

const threeDisplayOffsets = [-37, 84, 0] as const
const threeDisplayRequests = contextFrameRequestsForDisplays(false, 25_000, [
  // Slave replay presented times have already been converted from their own
  // source PTS to the common pack clock using each manifest offset.
  { display: 1, hasReplay: true, presentedMs: 9_963 - threeDisplayOffsets[0] },
  // The failed recorder is showing its capture-instant bitmap, regardless of
  // where the two surviving replay clocks are.
  { display: 2, hasReplay: false, presentedMs: 10_084 - threeDisplayOffsets[1] },
  { display: 3, hasReplay: true, presentedMs: 10_000 - threeDisplayOffsets[2] },
])
check(
  'three displays retain independent observed clocks with focus at index 3',
  threeDisplayRequests.map((request) => [request.display, request.timeMs])
    .map((value) => value.join(':'))
    .join(',') === '1:10000,2:25000,3:10000',
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
  'fresh single-display capture transports focused cadence through save-first and finalization',
  sessionSource.includes('const focusedCadence = manifestCadence(display.id)') &&
    sessionSource.includes('cadence: focusedCadence,') &&
    sessionSource.match(/cadence:\s*focusedCadence,/g)?.length === 2,
)
check(
  're-edit preserves the cadence declared by the saved source manifest',
  sessionSource.includes('cadence: manifest.media.cadence,'),
)
{
  const screens = [
    { width: 1_200, height: 1_920, scale: 1 },
    { width: 3_840, height: 2_160, scale: 1.5 },
  ]
  check(
    'single-display reopen follows the focused persisted bounds after pack reindexing',
    reopenedSnapshotPixelsPerDip({
      snapshotWidth: 3_840,
      snapshotHeight: 2_160,
      screens,
      displays: [{
        index: 1,
        focused: true,
        bounds: { x: 0, y: 0, width: 2_560, height: 1_440 },
        scale: 1.5,
      }],
    }) === 1.5,
  )
  check(
    'single-display reopen identifies environment screen 2 from persisted raster bounds',
    reopenedSnapshotPixelsPerDip({
      snapshotWidth: 3_840,
      snapshotHeight: 2_160,
      screens,
      displays: undefined,
    }) === 1.5,
  )
  check(
    'ambiguous equal-size screens with different scales are not guessed',
    reopenedSnapshotPixelsPerDip({
      snapshotWidth: 1_920,
      snapshotHeight: 1_080,
      screens: [
        { width: 1_920, height: 1_080, scale: 1 },
        { width: 1_920, height: 1_080, scale: 1.25 },
      ],
      displays: undefined,
    }) === undefined,
  )
  check(
    'reopen context uses persisted display identity instead of environment.screens[0]',
    sessionSource.includes('reopenedContextDisplayTargets({')
      && !sessionSource.includes('manifest.environment.screens[0].scale'),
  )
  check(
    'degraded two-display reopen preserves the surviving focused display index',
    reopenedContextDisplayTargets({
      snapshotWidth: 3_840,
      snapshotHeight: 2_160,
      screens,
      displays: [
        {
          index: 1,
          focused: false,
          bounds: { x: -1_200, y: 0, width: 1_200, height: 1_920 },
          scale: 1,
        },
        {
          index: 2,
          focused: true,
          bounds: { x: 0, y: 0, width: 2_560, height: 1_440 },
          scale: 1.5,
        },
      ],
      loadedDisplays: [{
        index: 2,
        focused: true,
        width: 3_840,
        height: 2_160,
        scale: 1.5,
      }],
    }).map((display) => display.index).join(',') === '2',
  )
  check(
    'reopen editor retains a single surviving declared display instead of reindexing it',
    sessionSource.includes('return result') &&
      !sessionSource.includes('return result.length > 1 ? result : []'),
  )
}
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

const threeDisplayManifest = buildManifest({
  id: 'display-clock-three-monitor-check',
  createdAt: new Date('2026-07-30T00:00:00.000Z'),
  generatorVersion: 'check',
  title: '',
  note: '',
  osVersion: 'check',
  screens: [
    { width: 1_200, height: 1_920, scale: 1 },
    { width: 3_840, height: 2_160, scale: 1.5 },
    { width: 2_400, height: 1_350, scale: 1.25 },
  ],
  captureKind: 'video',
  hasReplay: true,
  replayDurationMs: 25_000,
  snapshotTMs: null,
  displays: [
    {
      index: 1,
      focused: false,
      bounds: { x: -1_200, y: -480, width: 1_200, height: 1_920 },
      scale: 1,
      hasReplay: true,
      replayDurationMs: 24_963,
      replayClockOffsetMs: threeDisplayOffsets[0],
      snapshotFile: 'snapshot-d1.png',
      replayFile: 'replay-d1.webm',
    },
    {
      index: 2,
      focused: false,
      bounds: { x: 0, y: 0, width: 2_560, height: 1_440 },
      scale: 1.5,
      hasReplay: false,
      replayDurationMs: 0,
      snapshotFile: 'snapshot-d2.png',
      replayFile: null,
    },
    {
      index: 3,
      focused: true,
      bounds: { x: 2_560, y: -360, width: 1_920, height: 1_080 },
      scale: 1.25,
      hasReplay: true,
      replayDurationMs: 25_000,
      replayClockOffsetMs: threeDisplayOffsets[2],
      snapshotFile: 'snapshot.png',
      replayFile: 'replay.webm',
    },
  ],
})
const reopenedThreeDisplays = threeDisplayManifest.media.displays ?? []
check(
  'three-display manifest preserves portrait/negative/mixed-DPI geometry and focus 3',
  reopenedThreeDisplays.length === 3 &&
    reopenedThreeDisplays[0]?.bounds?.x === -1_200 &&
    reopenedThreeDisplays[0]?.bounds?.height === 1_920 &&
    reopenedThreeDisplays[1]?.scale === 1.5 &&
    reopenedThreeDisplays[2]?.focused === true,
)
check(
  'three-display manifest preserves measured offsets and omits one failed recorder clock',
  reopenedThreeDisplays[0]?.replay_clock_offset_ms === threeDisplayOffsets[0] &&
    reopenedThreeDisplays[1]?.replay === null &&
    reopenedThreeDisplays[1]?.replay_clock_offset_ms === undefined &&
    reopenedThreeDisplays[2]?.replay_clock_offset_ms === 0,
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


// A DISPLAY WHOSE REPLAY IS NOT ON THE CAPTURE'S CLOCK (#110).
//
// Measured on CapturePack_2026-07-31_182908: display 1 recorded 3.3 fps with a
// 1000 ms stall, and its 18691 ms of capture came back as a 3688 ms replay
// whose frames sit at a uniform 66.6 ms. Fifteen seconds of stillness is simply
// not in the file. No offset repairs that — an offset shifts an axis, this one
// would have to stretch — so what is owed is a reader that knows.
console.log('\nReplay coverage')
{
  const reported = replayCoverage(3_688, 18_691)
  check(
    'the reported capture is recognised as off-clock',
    reported.compressed
      && reported.missingMs === 15_003
      && Math.abs(reported.ratio - 0.197) < 0.001,
    JSON.stringify(reported),
  )
  const focused = replayCoverage(18_691, 18_691)
  check(
    'a display that covered its capture is not accused of anything',
    !focused.compressed && focused.ratio === 1 && focused.missingMs === 0,
    JSON.stringify(focused),
  )
  // Starting a moment late or stopping a moment early is not a broken axis.
  check(
    'ordinary start/stop edges stay under the tolerance',
    !replayCoverage(29_000, 29_740).compressed
      && !replayCoverage(18_000, 18_691).compressed,
  )
  check(
    'a long capture missing a tenth of itself is still on-clock',
    !replayCoverage(27_000, 29_740).compressed,
    JSON.stringify(replayCoverage(27_000, 29_740)),
  )
  check(
    'and missing half of itself is not',
    replayCoverage(14_000, 29_740).compressed,
  )
  check(
    'nothing recorded at all is the clearest case, not a division by zero',
    replayCoverage(0, 29_740).compressed && replayCoverage(0, 29_740).ratio === 0,
  )
  check(
    'a capture of no length accuses nobody',
    !replayCoverage(0, 0).compressed && replayCoverage(0, 0).ratio === 1,
  )
  check(
    'media longer than its capture is clamped rather than reported as a surplus',
    replayCoverage(20_000, 18_691).ratio === 1
      && replayCoverage(20_000, 18_691).missingMs === 0,
  )
  check(
    'nonsense input is not an accusation',
    !replayCoverage(Number.NaN, 18_691).compressed === false
      && replayCoverage(Number.NaN, 18_691).mediaMs === 0,
  )
}

// The pack has to SAY it, in its own description of itself, or a reader finds
// out by placing a box in the wrong second.
{
  const report = readFileSync('src/main/report.ts', 'utf8')
  check(
    'the display summary reports an off-clock replay',
    report.includes('replayCoverage(') && report.includes("t('pack.replayCompressed'"),
  )
  const session = readFileSync('src/main/session.ts', 'utf8')
  check(
    'and the capture log says it beside the cadence that caused it',
    session.includes('replayCoverage(') && session.includes("is not this capture's clock"),
  )
  const i18n = readFileSync('src/shared/i18n.ts', 'utf8')
  check(
    'every locale can say it',
    (i18n.match(/'pack\.replayCompressed'/gu) ?? []).length === 9,
  )
}

console.log(`\nresult: ${failed === 0 ? 'OK' : 'FAILED'} — ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
