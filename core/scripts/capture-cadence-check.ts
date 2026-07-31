import {
  beginCaptureCadence,
  captureCadenceReport,
  CaptureCadenceRegistry,
  observeCaptureCadence,
} from '../src/shared/captureCadence'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const WARMUP_MS = 3_000
let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) passed += 1
  else failed += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

console.log('Cadence measurement')
{
  const state = beginCaptureCadence(0, 0, 0)
  observeCaptureCadence(state, 0, 0, 0, 0)
  for (let timeMs = 100; timeMs <= 900; timeMs += 100) {
    observeCaptureCadence(state, timeMs, timeMs / 10, 0, 0)
  }
  const report = captureCadenceReport(state, 1_000, 100, 0, 0)
  check(
    'an advancing count at every poll proves no complete stalled interval',
    report?.worstStallMs === 0,
    `got ${String(report?.worstStallMs)}`,
  )
}

{
  const state = beginCaptureCadence(0, 0, 0)
  observeCaptureCadence(state, 0, 0, 0, 0)
  observeCaptureCadence(state, 100, 3, 0, 0)
  observeCaptureCadence(state, 200, 3, 0, 0)
  observeCaptureCadence(state, 300, 6, 0, 0)
  const report = captureCadenceReport(state, 1_000, 30, 0, 0)
  check(
    'one unchanged poll contributes exactly one fully observed interval',
    report?.worstStallMs === 100,
    `got ${String(report?.worstStallMs)}`,
  )
}

{
  const state = beginCaptureCadence(0, 0, 0)
  observeCaptureCadence(state, 0, 0, 0, 0)
  observeCaptureCadence(state, 100, 3, 0, 0)
  observeCaptureCadence(state, 200, 3, 0, 0)
  observeCaptureCadence(state, 300, 3, 0, 0)
  observeCaptureCadence(state, 400, 6, 0, 0)
  const report = captureCadenceReport(state, 1_000, 30, 0, 0)
  check(
    'consecutive unchanged polls accumulate only their proven no-progress span',
    report?.worstStallMs === 200,
    `got ${String(report?.worstStallMs)}`,
  )
}

{
  const state = beginCaptureCadence(0, 0, 0)
  observeCaptureCadence(state, 0, 0, 0, 0)
  observeCaptureCadence(state, 100, 3, 0, 0)
  observeCaptureCadence(state, 200, 3, 0, 0)
  const report = captureCadenceReport(state, 1_000, 30, 0, 0)
  check(
    'an advance first observed at capture does not extend the prior proven stall',
    report?.worstStallMs === 100,
    `got ${String(report?.worstStallMs)}`,
  )
}

{
  const state = beginCaptureCadence(0, 0, 2)
  observeCaptureCadence(state, 1_000, 7, 3, WARMUP_MS)
  observeCaptureCadence(state, 3_000, 30, 5, WARMUP_MS)
  check(
    'warm-up frames and discards become the report baseline',
    state.baseFrames === 30 && state.baseDiscarded === 5,
  )
  observeCaptureCadence(state, 3_500, 38, 6, WARMUP_MS)
  const report = captureCadenceReport(state, 4_500, 38, 7, WARMUP_MS)
  check('the measured rate excludes warm-up', report?.achievedFps === 5.3)
  check('discarded frames are a delta over the measured window', report?.discardedFrames === 2)
  check(
    'a stall still in progress at capture time is included',
    report?.worstStallMs === 1_000,
    `got ${String(report?.worstStallMs)}`,
  )
}

{
  const state = beginCaptureCadence(0, 10, null)
  observeCaptureCadence(state, 3_000, 30, null, WARMUP_MS)
  const report = captureCadenceReport(state, 4_000, 30, null, WARMUP_MS)
  check('an unavailable discard counter remains unknown', report?.discardedFrames === null)
  check('a still source reports zero delivered fps without inventing drops', report?.achievedFps === 0)
}

{
  const state = beginCaptureCadence(0, 100, 10)
  observeCaptureCadence(state, 3_000, 130, 12, WARMUP_MS)
  observeCaptureCadence(state, 3_500, 4, 0, WARMUP_MS)
  check(
    'a regressed browser counter starts a fresh unmeasured generation',
    state.firstCountedAtMs === null &&
      state.baseFrames === 4 &&
      state.baseDiscarded === 0 &&
      state.worstStallMs === 0,
  )
}

console.log('\nRecorder generation ownership')
{
  const registry = new CaptureCadenceRegistry()
  const report = {
    achievedFps: 15,
    worstStallMs: 80,
    discardedFrames: 0,
    sampledMs: 10_000,
    gainedFrames: 150,
  }
  registry.set(11, report)
  registry.set(22, { ...report, achievedFps: 10 })
  check('a recorder report is available in its generation', registry.get(11)?.achievedFps === 15)
  registry.reset(11)
  check('window recreation cannot inherit the old cadence', registry.get(11) === null)
  registry.retain(new Set([22]))
  check('retaining connected displays preserves their report', registry.get(22)?.achievedFps === 10)
  registry.retain(new Set())
  check('disconnect removes otherwise-stable display ids', registry.size === 0)
}

console.log('\nSupported capture-rate floor')
{
  const captureSource = readFileSync(
    path.resolve('src/renderer/capture/capture.ts'),
    'utf8',
  )
  check(
    'fragmented MP4 requests an IDR at the same source-rate cadence as its timeslice without changing WebM',
    captureSource.includes(
      'return mp4FragmentIntervalMs(recorderSourceFps)',
    ) &&
      captureSource.includes(
        'videoKeyFrameIntervalDuration: currentMp4FragmentIntervalMs()',
      ) &&
      captureSource.includes(
        'recorder.start(currentMp4FragmentIntervalMs())',
      ) &&
      captureSource.includes('timesliceMs: WEBM_CHUNK_TIMESLICE_MS'),
  )
  const mainCaptureSource = readFileSync(
    path.resolve('src/main/capture.ts'),
    'utf8',
  )
  check(
    'primary readiness measurements cross IPC into the persisted main log',
    captureSource.includes('startupReadiness:') &&
      mainCaptureSource.includes('ready.startupReadiness') &&
      mainCaptureSource.includes('primary recorder readiness after'),
  )
  check(
    'the replay health probe requests the shared supported minimum instead of reviving 1fps',
    captureSource.includes("import { MIN_CAPTURE_FPS } from '../../shared/types'") &&
      captureSource.includes('requestedFps: MIN_CAPTURE_FPS'),
  )
  check(
    'unsupported 1fps wall-clock pacing is absent from the production recorder',
    !captureSource.includes('interface WallClockPacer') &&
      !captureSource.includes('wallClockPacer') &&
      !captureSource.includes('prepareWallClockPacedStream') &&
      !captureSource.includes('1fps wall-clock pacer'),
  )
  check(
    'the frame tick and MediaRecorder observe the assigned capture stream directly',
    captureSource.includes('const active = stream') &&
      captureSource.includes('new MediaRecorder(stream!, options)') &&
      !captureSource.includes('recorderStream'),
  )
  check(
    'native fallback IPC normalizes every request onto the current 5..30 writer range',
    mainCaptureSource.includes('normalizeCaptureFps') &&
      /const requestedFps =\s*normalizeCaptureFps\(\s*request\?\.requestedFps,\s*currentSettings\?\.fps \?\? MIN_CAPTURE_FPS,\s*\)/u.test(
        mainCaptureSource,
      ),
  )
  check(
    'a diagnostic health probe never claims that the replay backend switched',
    mainCaptureSource.includes(
      "request?.purpose === 'health-probe'",
    ) &&
      mainCaptureSource.includes('native replay health probe acquired') &&
      /if \(isTransition\) \{\s*logWarn\(\s*`\[capture\] display \$\{wantedId\}: switched to/u.test(
        mainCaptureSource,
      ),
  )
}


// THE PACK MUST DESCRIBE THE REPLAY IT CONTAINS, NOT THE SESSION THAT FOLLOWED (#112).
//
// The renderer's sampler is a lifetime accumulator started once at recorder
// start and deliberately kept alive across captures, so worstStallMs is a
// running max and achievedFps covers everything since warm-up. Reading it at
// finalize time described the editing session instead: a capture whose log
// said 14.5 fps and a 16 ms stall reached the pack as 14.2 fps and 1417 ms,
// measured 47 seconds later with the editor open over the desktop it was
// still recording. Measured on CapturePack_2026-07-31_185602.
//
// SPEC 5.3: "These fields MUST describe the source and encoder(s) that
// produced the declared replay."
console.log('\nCadence is frozen beside the replay it describes')
{
  const session = readFileSync(path.join(process.cwd(), 'src/main/session.ts'), 'utf8')
  check(
    'a frozen display carries the cadence measured when its replay was taken',
    session.includes('cadence?: ManifestCadence')
      && (session.match(/const cadence = manifestCadence\(display\.id\)/gu) ?? []).length === 2,
  )
  check(
    'the display captures read that frozen value rather than the live registry',
    session.includes('...(d.cadence === undefined ? {} : { cadence: d.cadence })')
      && !session.includes('const cadence = manifestCadence(d.id)'),
  )
  // manifestCadence itself still exists for the one caller that legitimately
  // reads at capture time - the top-level focused value.
  check(
    'the live read survives only where it is taken at the capture instant',
    session.includes('const focusedCadence = manifestCadence(display.id)'),
  )
  const renderer = readFileSync(
    path.join(process.cwd(), 'src/renderer/capture/capture.ts'),
    'utf8',
  )
  check(
    'the sampler really is a lifetime accumulator, which is why freezing matters',
    // Two matches: the declaration and its single call site at recorder start.
    (renderer.match(/startCadenceMonitor\(\)/gu) ?? []).length === 2
      && renderer.includes('cadence sampler and context clock deliberately survive'),
  )
}
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
