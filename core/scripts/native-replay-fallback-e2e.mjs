// Bounded, real-Windows proof for the per-display native replay fallback.
//
// This owns the physical desktop for about 20 seconds and is intentionally not
// in qa-gate. It drives the production Electron app with one exact display's
// Chromium output discarded, keeps continuously moving pixels on every monitor,
// then proves the stored media with ffprobe/ffmpeg and independent frame hashes.
//
// Usage:
//   node scripts/native-replay-fallback-e2e.mjs --artifacts-dir=C:\_CapturePack-QA\native-fallback

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { terminateProcessTree } from './process-tree.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const coreDir = path.resolve(here, '..')
const require = createRequire(import.meta.url)
const electron = require('electron')
const fixtureScript = path.join(
  here,
  'fixtures',
  'windows-replay-field-surface.cjs',
)

function option(name, fallback = null) {
  const prefix = `--${name}=`
  const found = process.argv.slice(2).find((value) => value.startsWith(prefix))
  return found === undefined ? fallback : found.slice(prefix.length)
}

const artifactsArgument = option('artifacts-dir')
if (artifactsArgument === null || artifactsArgument.trim() === '') {
  throw new Error('--artifacts-dir=PATH is required')
}
const artifactsDir = path.resolve(artifactsArgument)
if (existsSync(artifactsDir) && readdirSync(artifactsDir).length > 0) {
  throw new Error(`refusing non-empty artifacts directory: ${artifactsDir}`)
}
mkdirSync(artifactsDir, { recursive: true })

const profileDir = path.join(artifactsDir, 'app-data')
const outputDir = path.join(artifactsDir, 'packs')
const fixtureDir = path.join(artifactsDir, 'fixture')
const layoutPath = path.join(fixtureDir, 'layout.json')
const movementPath = path.join(fixtureDir, 'movement.jsonl')
const fixtureStopPath = path.join(fixtureDir, 'stop')
for (const directory of [profileDir, outputDir, fixtureDir]) {
  mkdirSync(directory, { recursive: true })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    try {
      const value = await predicate()
      if (value) return value
    } catch {
      // Atomic manifest replacement and background display writes are expected.
    }
    await delay(intervalMs)
  }
  return null
}

async function stopProcess(child) {
  if (
    child === null ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return
  }
  const killer = terminateProcessTree(child)
  if (killer !== null) {
    await Promise.race([
      new Promise((resolve) => {
        killer.once('close', resolve)
        killer.once('error', resolve)
      }),
      delay(10_000),
    ])
  }
}

function tool(command, args, timeoutMs = 120_000) {
  return spawnSync(command, args, {
    cwd: coreDir,
    windowsHide: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  })
}

function packDirectory() {
  if (!existsSync(outputDir)) return null
  const candidates = readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('CapturePack_'))
    .map((entry) => path.join(outputDir, entry.name))
    .sort()
  return candidates.at(-1) ?? null
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function sameBounds(left, right) {
  return (
    left?.x === right?.x &&
    left?.y === right?.y &&
    left?.width === right?.width &&
    left?.height === right?.height
  )
}

function transitionLatency(mainLog, displayId) {
  const lines = mainLog.split(/\r?\n/u)
  const event = (phrase) => {
    const line = lines.find(
      (candidate) =>
        candidate.includes(`display ${displayId}:`) &&
        candidate.includes(phrase),
    )
    if (line === undefined) return { at: null, epoch_ms: null, line: null }
    const stamp = line.split(/\s/u)[0]
    const epoch = Date.parse(stamp)
    return {
      at: Number.isFinite(epoch) ? new Date(epoch).toISOString() : null,
      epoch_ms: Number.isFinite(epoch) ? epoch : null,
      line,
    }
  }
  const failure = event('primary replay failure confirmed')
  const source = event('native source first frame acquired')
  const presented = event('native first frame presented')
  const confirmed = event('frames confirmed')
  const recording = event('starting -> recording')
  const delta = (target) =>
    failure.epoch_ms === null || target.epoch_ms === null
      ? null
      : target.epoch_ms - failure.epoch_ms
  return {
    failure_confirmed_at: failure.at,
    native_source_first_frame_at: source.at,
    native_first_presented_at: presented.at,
    frames_confirmed_at: confirmed.at,
    recording_at: recording.at,
    failure_to_source_first_frame_ms: delta(source),
    failure_to_first_presented_ms: delta(presented),
    failure_to_frames_confirmed_ms: delta(confirmed),
    failure_to_recording_ms: delta(recording),
    // The primary ring is torn down before spawn. This measured interval is
    // therefore the honest minimum media hole at the backend transition.
    measured_transition_ring_gap_ms: delta(presented),
    basis: 'main monotonic event ordering recorded with ISO wall timestamps',
  }
}

function nativePresentationAccounting(mainLog, displayId) {
  const escaped = String(displayId).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const pattern = new RegExp(
    `display ${escaped}: native presentation accounting ` +
      'requested=(\\d+), exact=(\\d+), ' +
      'unreported-presented=(\\d+), ambiguous-dropped=(\\d+), ' +
      'capacity-dropped=(\\d+), pending=(\\d+)',
    'gu',
  )
  const values = [...mainLog.matchAll(pattern)].at(-1)
  if (values === undefined) return null
  const [
    requestedFrames,
    exactCallbacks,
    unreportedPresented,
    ambiguousDropped,
    capacityDropped,
    pending,
  ] = values.slice(1).map(Number)
  return {
    requested_frames: requestedFrames,
    exact_callbacks: exactCallbacks,
    unreported_presented: unreportedPresented,
    ambiguous_dropped: ambiguousDropped,
    capacity_dropped: capacityDropped,
    pending,
    accounted:
      exactCallbacks +
      unreportedPresented +
      ambiguousDropped +
      capacityDropped +
      pending,
  }
}

function declaredDisplays(manifest, layout) {
  if (
    Array.isArray(manifest?.media?.displays) &&
    manifest.media.displays.length > 0
  ) {
    return manifest.media.displays
  }
  return [
    {
      index: 1,
      focused: true,
      snapshot: manifest.media.snapshot,
      replay: manifest.media.replay,
      replay_duration_ms: manifest.media.replay_duration_ms,
      cadence: manifest.media.cadence,
      bounds: layout.displays[0]?.bounds_dip ?? null,
    },
  ]
}

function replayProof(packDir, display) {
  const replay =
    typeof display.replay === 'string' ? path.join(packDir, display.replay) : null
  if (
    replay === null ||
    !path.resolve(replay).startsWith(`${path.resolve(packDir)}${path.sep}`) ||
    !existsSync(replay)
  ) {
    return {
      display: display.index,
      replay: display.replay ?? null,
      decode_ok: false,
      changing_frames: false,
      error: 'declared replay missing or unsafe',
    }
  }

  const probe = tool('ffprobe', [
    '-v',
    'error',
    '-count_frames',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=codec_name,width,height,nb_frames,nb_read_frames,duration:' +
      'format=duration:frame=best_effort_timestamp_time',
    '-of',
    'json',
    replay,
  ])
  const decode = tool('ffmpeg', [
    '-nostdin',
    '-v',
    'error',
    '-xerror',
    '-i',
    replay,
    '-map',
    '0:v:0',
    '-f',
    'framemd5',
    '-',
  ])
  const hashes = tool('ffmpeg', [
    '-nostdin',
    '-v',
    'error',
    '-i',
    replay,
    '-vf',
    'fps=1',
    '-f',
    'framemd5',
    '-',
  ])
  let metadata = null
  try {
    metadata = JSON.parse(probe.stdout)
  } catch {
    metadata = null
  }
  const frameHashes = hashes.stdout
    .split(/\r?\n/u)
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line.split(',').at(-1)?.trim())
    .filter((value) => typeof value === 'string' && value !== '')
  const frameTimesMs = Array.isArray(metadata?.frames)
    ? metadata.frames
        .map((frame) => Number(frame.best_effort_timestamp_time) * 1000)
        .filter(Number.isFinite)
        .sort((left, right) => left - right)
    : []
  const frameGapsMs = frameTimesMs
    .slice(1)
    .map((time, index) => time - frameTimesMs[index])
  const elapsedMs =
    frameTimesMs.length >= 2
      ? frameTimesMs.at(-1) - frameTimesMs[0]
      : null
  const actualFps =
    elapsedMs !== null && elapsedMs > 0
      ? ((frameTimesMs.length - 1) * 1000) / elapsedMs
      : null
  return {
    display: display.index,
    replay: display.replay,
    absolute_path: replay,
    bytes: statSync(replay).size,
    cadence: display.cadence ?? null,
    probe_ok: probe.status === 0 && metadata !== null,
    decode_ok: decode.status === 0,
    decode_error: String(decode.stderr ?? '').slice(0, 2_000),
    sampled_frame_count: frameHashes.length,
    unique_frame_hashes: new Set(frameHashes).size,
    changing_frames:
      hashes.status === 0 &&
      frameHashes.length >= 2 &&
      new Set(frameHashes).size >= 2,
    actual_frame_count: frameTimesMs.length,
    actual_achieved_fps:
      actualFps === null ? null : Number(actualFps.toFixed(3)),
    max_frame_gap_ms:
      frameGapsMs.length === 0
        ? null
        : Number(Math.max(...frameGapsMs).toFixed(3)),
    stream: metadata?.streams?.[0] ?? null,
    format: metadata?.format ?? null,
  }
}

if (process.platform !== 'win32') {
  throw new Error('native fallback E2E must run under Windows Node/Electron')
}
if (!existsSync(path.join(coreDir, 'dist', 'main', 'index.js'))) {
  throw new Error('dist/main/index.js missing; run npm run build first')
}
for (const command of ['ffprobe', 'ffmpeg']) {
  if (tool(command, ['-version'], 10_000).status !== 0) {
    throw new Error(`${command} is required on PATH`)
  }
}

const report = {
  schema: 'capturepack.native-replay-fallback-e2e',
  version: 1,
  started_at: new Date().toISOString(),
  artifacts_dir: artifactsDir,
  simulated_display_id: null,
  pack: null,
  manifest_format_version: null,
  transition_latency: null,
  native_presentation_accounting: null,
  displays: [],
  checks: {},
  result: 'BROKEN',
  error: null,
}

let fixture = null
let appProcess = null
try {
  const fixtureOut = createWriteStream(path.join(fixtureDir, 'stdout.log'))
  const fixtureErr = createWriteStream(path.join(fixtureDir, 'stderr.log'))
  fixture = spawn(
    electron,
    [
      fixtureScript,
      `--layout=${layoutPath}`,
      `--movement=${movementPath}`,
      `--stop-file=${fixtureStopPath}`,
      '--run-id=native-fallback-e2e',
      '--cycle-ms=7000',
    ],
    {
      cwd: coreDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
    },
  )
  fixture.stdout.pipe(fixtureOut)
  fixture.stderr.pipe(fixtureErr)
  const layoutReady = await waitFor(
    () => existsSync(layoutPath) && readFileSync(movementPath, 'utf8').includes('\n'),
    30_000,
  )
  if (!layoutReady) throw new Error('moving display fixture did not start')
  const layout = readJson(layoutPath)
  const simulatedDisplayId = layout.primary_display_id
  report.simulated_display_id = simulatedDisplayId

  const settings = {
    settingsVersion: 2,
    language: 'en',
    packLanguage: 'en',
    autoUpdateCheck: false,
    launchAtLogin: false,
    superviseProcess: false,
    notifyOnRecordingStart: false,
    recordingEnabled: true,
    outputDir,
    clipboardAfterSave: 'off',
    welcomeShown: true,
    welcomeDeferredFromLogin: false,
    replaySeconds: 15,
    fps: 15,
    replayMaxWidth: 1920,
    captureDisplay: 'all',
    uiaEnabled: false,
    chromeDomEnabled: false,
    showShortcutOverlay: false,
    showEditorTutorial: false,
    editorWindowMode: 'windowed',
    mcpEnabled: false,
    mcpAutoStart: false,
    mcpWatchExportFolder: false,
  }
  writeFileSync(
    path.join(profileDir, 'settings.json'),
    `${JSON.stringify(settings, null, 2)}\n`,
    'utf8',
  )

  const stdout = createWriteStream(path.join(artifactsDir, 'capturepack-stdout.log'))
  const stderr = createWriteStream(path.join(artifactsDir, 'capturepack-stderr.log'))
  appProcess = spawn(
    electron,
    [
      '.',
      `--user-data-dir=${profileDir}`,
      `--output-dir=${outputDir}`,
      '--no-global-shortcut',
      '--no-login-item',
      '--no-supervision',
      '--capture-now=18',
      `--simulate-no-frames=${simulatedDisplayId}`,
    ],
    {
      cwd: coreDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CAPTUREPACK_FIELD_QA: '1' },
    },
  )
  appProcess.stdout.pipe(stdout)
  appProcess.stderr.pipe(stderr)

  const packDir = await waitFor(() => {
    const candidate = packDirectory()
    if (candidate === null) return null
    const manifestPath = path.join(candidate, 'manifest.json')
    if (!existsSync(manifestPath)) return null
    const manifest = readJson(manifestPath)
    const displays = declaredDisplays(manifest, layout)
    if (
      displays.length !== layout.displays.length ||
      displays.some(
        (display) =>
          typeof display.replay !== 'string' ||
          !existsSync(path.join(candidate, display.replay)) ||
          statSync(path.join(candidate, display.replay)).size === 0 ||
          display.cadence === undefined,
      )
    ) {
      return null
    }
    return candidate
  }, 150_000)
  if (packDir === null) {
    throw new Error('app did not persist every declared replay and cadence')
  }
  report.pack = packDir

  // Let atomic/background writers settle before killing the application.
  await delay(2_000)
  await stopProcess(appProcess)
  appProcess = null
  writeFileSync(fixtureStopPath, 'stop\n', 'utf8')
  await stopProcess(fixture)
  fixture = null
  stdout.end()
  stderr.end()
  fixtureOut.end()
  fixtureErr.end()

  const manifest = readJson(path.join(packDir, 'manifest.json'))
  report.manifest_format_version = manifest.format_version
  const displays = declaredDisplays(manifest, layout)
  const simulatedLayout = layout.displays.find(
    (display) => display.id === simulatedDisplayId,
  )
  const simulated = displays.find((display) =>
    sameBounds(display.bounds, simulatedLayout?.bounds_dip),
  )
  const healthy = displays.filter((display) => display !== simulated)
  report.displays = displays.map((display) => replayProof(packDir, display))
  const simulatedProof = report.displays.find(
    (display) => display.display === simulated?.index,
  )
  const healthyProofs = report.displays.filter(
    (display) => display.display !== simulated?.index,
  )
  const mainLogPath = path.join(profileDir, 'logs', 'main.log')
  const mainLog = existsSync(mainLogPath)
    ? readFileSync(mainLogPath, 'utf8')
    : ''
  report.transition_latency = transitionLatency(mainLog, simulatedDisplayId)
  report.native_presentation_accounting = nativePresentationAccounting(
    mainLog,
    simulatedDisplayId,
  )

  report.checks = {
    every_physical_display_declared:
      displays.length === layout.displays.length,
    simulated_display_resolved: simulated !== undefined,
    simulated_display_uses_honest_native_backend:
      simulated?.cadence?.backend === 'windows-gdi-bitblt' &&
      simulated?.cadence?.quality === 'degraded' &&
      simulated?.cadence?.requested_fps === 15 &&
      simulated?.cadence?.recorder_count === 1,
    healthy_displays_preserved:
      healthy.length === Math.max(0, displays.length - 1) &&
      healthy.every(
        (display) =>
          display.cadence?.backend === 'chromium-desktop-capture' &&
          display.cadence?.quality === 'full',
      ),
    every_replay_fully_decodes:
      report.displays.every((display) => display.decode_ok),
    every_replay_contains_changing_pixels:
      report.displays.every((display) => display.changing_frames),
    fallback_effective_fps_within_20_percent:
      typeof simulatedProof?.actual_achieved_fps === 'number' &&
      simulatedProof.actual_achieved_fps >= 4 &&
      simulatedProof.actual_achieved_fps <= 6,
    fallback_max_gap_within_three_intervals:
      typeof simulatedProof?.max_frame_gap_ms === 'number' &&
      simulatedProof.max_frame_gap_ms <= 600,
    healthy_actual_fps_within_20_percent:
      healthyProofs.every(
        (display) =>
          typeof display.actual_achieved_fps === 'number' &&
          display.actual_achieved_fps >= 12 &&
          display.actual_achieved_fps <= 18,
      ),
    manifest_cadence_matches_saved_pts:
      report.displays.every(
        (display) =>
          typeof display.actual_achieved_fps === 'number' &&
          typeof display.cadence?.achieved_fps === 'number' &&
          Math.abs(
            display.actual_achieved_fps - display.cadence.achieved_fps,
          ) <= Math.max(0.5, display.actual_achieved_fps * 0.2),
      ),
    diagnostics_and_viewer_require_format_0_5:
      manifest.format_version === '0.5.0',
    native_presentation_accounting_is_bounded_and_conservative:
      report.native_presentation_accounting !== null &&
      report.native_presentation_accounting.requested_frames > 0 &&
      report.native_presentation_accounting.exact_callbacks > 0 &&
      report.native_presentation_accounting.capacity_dropped === 0 &&
      report.native_presentation_accounting.accounted ===
        report.native_presentation_accounting.requested_frames,
  }
  report.result = Object.values(report.checks).every(Boolean) ? 'PASS' : 'BROKEN'
} catch (error) {
  report.error = error instanceof Error ? error.stack ?? error.message : String(error)
} finally {
  await stopProcess(appProcess)
  if (fixture !== null) {
    writeFileSync(fixtureStopPath, 'stop\n', 'utf8')
  }
  await stopProcess(fixture)
  report.finished_at = new Date().toISOString()
  writeFileSync(
    path.join(artifactsDir, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  )
}

console.log(JSON.stringify(report, null, 2))
if (report.result !== 'PASS') process.exitCode = 1
