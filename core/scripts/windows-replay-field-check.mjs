// Bounded Windows field measurement for the real CapturePack recorder.
//
// This is deliberately not part of qa-gate: a case owns the physical desktop
// for its whole duration. Run one process per case and let the caller schedule
// the six requested combinations (5/15/30 fps x one/all displays).
//
// Example:
//   node scripts/windows-replay-field-check.mjs ^
//     --fps=15 --duration-seconds=30 --target=primary ^
//     --artifacts-dir=C:\_CapturePack-QA\field-15fps-primary
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { cpus } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { terminateProcessTree } from './process-tree.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const coreDir = path.resolve(here, '..')
const require = createRequire(import.meta.url)
const electron = require('electron')
const {
  requestedFixtureStartDisplayId,
} = require('./fixtures/windows-replay-field-order.cjs')
const {
  durationVerdict,
  parseRecorderAvailability,
} = require('./fixtures/windows-replay-field-duration.cjs')
const {
  actualObjectPickVerdict,
} = require('./fixtures/windows-replay-field-pick.cjs')
const fixtureScript = path.join(here, 'fixtures', 'windows-replay-field-surface.cjs')
const helperEntry = path.join(here, 'windows-replay-field-helper.entry.ts')

function option(name, fallback = null) {
  const prefix = `--${name}=`
  const found = process.argv.slice(2).find((value) => value.startsWith(prefix))
  return found === undefined ? fallback : found.slice(prefix.length)
}

function finiteNumber(name, fallback, { min, max, integer = false }) {
  const raw = option(name, String(fallback))
  const parsed = Number(raw)
  if (
    !Number.isFinite(parsed)
    || parsed < min
    || parsed > max
    || (integer && !Number.isInteger(parsed))
  ) {
    throw new Error(`--${name} must be ${integer ? 'an integer' : 'a number'} in ${min}..${max}`)
  }
  return parsed
}

function usage() {
  console.log(`Windows replay field check

Required:
  --artifacts-dir=PATH       Empty/new directory that keeps report + pack

Case:
  --fps=5|15|30              Any supported 5..30 value (default 15)
  --duration-seconds=N       Post-warmup retained measurement window, 8..600 (default 30)
  --target=all|primary|ID    Every display or one explicit Electron display id

Optional:
  --warmup-seconds=N         Launch-to-steady allowance before the N-second window (default 3)
  --replay-max-width=N       0 or 720..3840 (default 1920)
  --sample-interval-ms=N     Process-tree sample cadence (default 5000)
  --settle-seconds=N         Wait for late context persistence (default 20)
  --tool-timeout-seconds=N   Per ffprobe/ffmpeg bound (default max(180, 2*duration))
  --self-test-lag            Run deterministic lag/static/ambiguity contracts only

The report is written to PATH\\report.json. status.json is safe to poll.`)
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  usage()
  process.exit(0)
}

const fps = finiteNumber('fps', 15, { min: 5, max: 30, integer: true })
const durationSeconds = finiteNumber(
  'duration-seconds',
  30,
  { min: 8, max: 600, integer: true },
)
const warmupSeconds = finiteNumber(
  'warmup-seconds',
  3,
  { min: 0, max: 30, integer: true },
)
const captureDelaySeconds = durationSeconds + warmupSeconds
const replayMaxWidth = finiteNumber(
  'replay-max-width',
  1920,
  { min: 0, max: 3840, integer: true },
)
if (replayMaxWidth !== 0 && replayMaxWidth < 720) {
  throw new Error('--replay-max-width must be 0 or 720..3840')
}
const sampleIntervalMs = finiteNumber(
  'sample-interval-ms',
  5000,
  { min: 1000, max: 60_000, integer: true },
)
const settleSeconds = finiteNumber(
  'settle-seconds',
  20,
  { min: 0, max: 120, integer: true },
)
const toolTimeoutSeconds = finiteNumber(
  'tool-timeout-seconds',
  Math.max(180, durationSeconds * 2),
  { min: 30, max: 1800, integer: true },
)
const targetOption = option('target', 'all')
const fixtureStartDisplayId = requestedFixtureStartDisplayId(targetOption)
const COORDINATE_EDGE_ERROR_LIMIT_PX = 16
const TEMPORAL_LAG_MIN_SEARCH_RADIUS_MS = 1000
const TEMPORAL_LAG_FRAME_SEARCH_MULTIPLIER = 8
const lagSelfTest = process.argv.includes('--self-test-lag')
if (lagSelfTest) {
  runTemporalLagSelfTest()
  console.log('windows replay temporal lag self-test: OK')
  process.exit(0)
}
const artifactsArgument = option('artifacts-dir')
if (artifactsArgument === null || artifactsArgument.trim() === '') {
  usage()
  throw new Error('--artifacts-dir is required')
}
const artifactsDir = path.resolve(artifactsArgument)
if (existsSync(artifactsDir) && readdirSync(artifactsDir).length > 0) {
  throw new Error(`refusing to mix a field run into a non-empty directory: ${artifactsDir}`)
}
mkdirSync(artifactsDir, { recursive: true })

const profileDir = path.join(artifactsDir, 'app-data')
const outputDir = path.join(artifactsDir, 'packs')
const fixtureDir = path.join(artifactsDir, 'fixture')
mkdirSync(profileDir, { recursive: true })
mkdirSync(outputDir, { recursive: true })
mkdirSync(fixtureDir, { recursive: true })

const statusPath = path.join(artifactsDir, 'status.json')
const reportPath = path.join(artifactsDir, 'report.json')
const processSamplesPath = path.join(artifactsDir, 'process-samples.jsonl')
const framePtsPath = path.join(artifactsDir, 'frame-pts.json')
const layoutPath = path.join(fixtureDir, 'layout.json')
const movementPath = path.join(fixtureDir, 'movement.jsonl')
const fixtureStopPath = path.join(fixtureDir, 'stop')
const runId =
  `${new Date().toISOString().replace(/[-:.TZ]/gu, '')}-` +
  `${String(process.pid)}-${fps}fps`

const beganAt = Date.now()
let stage = 'initializing'
let statusDetail = ''
function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
}
function setStage(next, detail = '') {
  stage = next
  statusDetail = detail
  writeJsonAtomic(statusPath, {
    schema: 'capturepack.windows-replay-field-status',
    version: 1,
    run_id: runId,
    stage,
    detail,
    elapsed_seconds: Number(((Date.now() - beganAt) / 1000).toFixed(1)),
    updated_at: new Date().toISOString(),
  })
  console.log(`[field] ${stage}${detail === '' ? '' : ` — ${detail}`}`)
}

const tracked = new Set()
function track(child) {
  tracked.add(child)
  child.once('close', () => tracked.delete(child))
  return child
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
async function waitFor(predicate, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    try {
      if (await predicate()) return true
    } catch {
      // A file being atomically replaced is expected; retry until the bound.
    }
    await delay(intervalMs)
  }
  return false
}
async function stopTracked(child) {
  if (child === null || child === undefined) return
  if (child.exitCode !== null || child.signalCode !== null) {
    tracked.delete(child)
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
  const stopped = await waitFor(
    () => child.exitCode !== null || child.signalCode !== null,
    5000,
  )
  // Keep an unconfirmed child in the set. The final report must not turn a
  // bounded kill attempt into "terminated" merely because its timeout elapsed.
  if (stopped) tracked.delete(child)
}
async function stopAllTracked() {
  for (const child of [...tracked].reverse()) await stopTracked(child)
}

let interrupted = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    interrupted = true
    setStage('stopping', `received ${signal}`)
    // Do not leave a 5-minute desktop-owning case alive until its current
    // ffprobe/ffmpeg/process-sampling deadline. Closing the tracked process
    // trees makes Ctrl+C bounded; finally still verifies that all are gone.
    void stopAllTracked()
  })
}

function executableAvailable(command) {
  const result = spawnSync(
    command,
    ['-version'],
    { windowsHide: true, stdio: 'ignore', timeout: 10_000 },
  )
  return result.status === 0
}

function encodedPowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64')
}

async function runBounded(
  command,
  args,
  {
    cwd = coreDir,
    timeoutMs = toolTimeoutSeconds * 1000,
    maxStdoutBytes = 64 * 1024 * 1024,
    maxStderrBytes = 4 * 1024 * 1024,
    binaryStdout = false,
  } = {},
) {
  return await new Promise((resolve) => {
    const child = track(spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }))
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let overflow = false
    let timedOut = false
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes <= maxStdoutBytes) stdout.push(chunk)
      else {
        overflow = true
        void stopTracked(child)
      }
    })
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length
      if (stderrBytes <= maxStderrBytes) stderr.push(chunk)
    })
    const timer = setTimeout(() => {
      timedOut = true
      void stopTracked(child)
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({
        code: null,
        timed_out: timedOut,
        overflow,
        stdout: binaryStdout
          ? Buffer.concat(stdout)
          : Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        error: String(error),
      })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({
        code,
        timed_out: timedOut,
        overflow,
        stdout: binaryStdout
          ? Buffer.concat(stdout)
          : Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        error: null,
      })
    })
  })
}

async function processTreeSnapshot(rootPid) {
  const script = `
$ErrorActionPreference='Stop'
$rootPid=[int]${String(rootPid)}
$nodes=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine)
$ids=New-Object 'System.Collections.Generic.HashSet[int]'
[void]$ids.Add($rootPid)
do {
  $added=$false
  foreach($node in $nodes) {
    if($ids.Contains([int]$node.ParentProcessId) -and -not $ids.Contains([int]$node.ProcessId)) {
      [void]$ids.Add([int]$node.ProcessId)
      $added=$true
    }
  }
} while($added)
$rows=@()
foreach($node in $nodes) {
  if(-not $ids.Contains([int]$node.ProcessId)) { continue }
  $process=Get-Process -Id ([int]$node.ProcessId) -ErrorAction SilentlyContinue
  if($null -eq $process) { continue }
  $rows += [pscustomobject]@{
    pid=[int]$node.ProcessId
    parent_pid=[int]$node.ParentProcessId
    name=[string]$node.Name
    command_line=[string]$node.CommandLine
    cpu_seconds=[double]$process.CPU
    private_bytes=[long]$process.PrivateMemorySize64
    working_set_bytes=[long]$process.WorkingSet64
  }
}
ConvertTo-Json -InputObject @($rows) -Depth 3 -Compress
`
  const result = await runBounded(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(script)],
    { timeoutMs: Math.max(15_000, sampleIntervalMs * 2), maxStdoutBytes: 4 * 1024 * 1024 },
  )
  if (result.code !== 0) throw new Error(result.stderr || result.error || 'PowerShell sampling failed')
  const parsed = JSON.parse(result.stdout || '[]')
  return Array.isArray(parsed) ? parsed : [parsed]
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''))
}

function packDirectory() {
  const candidates = existsSync(outputDir)
    ? readdirSync(outputDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(outputDir, entry.name))
      .filter((directory) => existsSync(path.join(directory, 'manifest.json')))
    : []
  return candidates.sort(
    (left, right) =>
      statSync(path.join(right, 'manifest.json')).mtimeMs
      - statSync(path.join(left, 'manifest.json')).mtimeMs,
  )[0] ?? null
}

function pngSize(file) {
  try {
    const bytes = readFileSync(file)
    if (
      bytes.length < 24
      || bytes.subarray(1, 4).toString('ascii') !== 'PNG'
      || bytes.subarray(12, 16).toString('ascii') !== 'IHDR'
    ) return null
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  } catch {
    return null
  }
}

function safePackFile(packDir, relative) {
  if (typeof relative !== 'string' || relative === '') return null
  if (path.isAbsolute(relative) || relative.includes('\0')) return null
  const resolved = path.resolve(packDir, relative)
  return resolved.startsWith(`${path.resolve(packDir)}${path.sep}`) ? resolved : null
}

function sameBounds(left, right) {
  return (
    left !== null
    && right !== null
    && left !== undefined
    && right !== undefined
    && left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height
  )
}

function manifestDisplays(manifest, layout, resolvedTargetId) {
  const declared = manifest?.media?.displays
  if (Array.isArray(declared) && declared.length > 0) return declared
  const item =
    layout.displays.find((display) => display.id === resolvedTargetId)
    ?? layout.displays.find((display) => display.id === layout.cursor_display_id)
    ?? layout.displays[0]
  return [{
    index: 1,
    snapshot: manifest?.media?.snapshot ?? null,
    replay: manifest?.media?.replay ?? null,
    replay_duration_ms: manifest?.media?.replay_duration_ms ?? 0,
    replay_clock_offset_ms: 0,
    ...(manifest?.media?.cadence === undefined
      ? {}
      : { cadence: manifest.media.cadence }),
    bounds: item?.bounds_dip ?? null,
    scale: item?.scale_factor ?? 1,
    focused: true,
  }]
}

function fixtureDisplayIndexForPackDisplay({
  display,
  displays,
  layout,
  resolvedTargetId,
}) {
  const fixtureDisplay =
    displays.length === 1 && resolvedTargetId !== 'all'
      ? layout.displays.find((item) => item.id === resolvedTargetId)
      : layout.displays.find((item) => sameBounds(item.bounds_dip, display?.bounds))
  return fixtureDisplay?.index ?? null
}

function parseRate(value) {
  if (typeof value !== 'string') return null
  const [numerator, denominator] = value.split('/').map(Number)
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null
  }
  return numerator / denominator
}

async function detectFixtureTargetBounds(probe, framePtsMs, snapshotSize) {
  if (
    probe.absolute_path === null
    || probe.width === null
    || probe.height === null
    || probe.width <= 0
    || probe.height <= 0
  ) {
    return { bounds: null, mask_pixels: 0, error: 'replay geometry unavailable' }
  }
  const decoded = await runBounded(
    'ffmpeg',
    [
      '-nostdin', '-v', 'error', '-xerror',
      '-i', probe.absolute_path,
      '-ss', (Math.max(0, framePtsMs) / 1000).toFixed(6),
      '-frames:v', '1',
      '-pix_fmt', 'rgb24',
      '-f', 'rawvideo', '-',
    ],
    {
      binaryStdout: true,
      maxStdoutBytes: probe.width * probe.height * 3 + 1024,
    },
  )
  const pixels = Buffer.isBuffer(decoded.stdout) ? decoded.stdout : Buffer.alloc(0)
  const required = probe.width * probe.height * 3
  if (decoded.code !== 0 || pixels.length < required) {
    return {
      bounds: null,
      mask_pixels: 0,
      error: String(decoded.stderr || decoded.error || 'frame decode returned no pixels').slice(0, 500),
    }
  }
  const pixelCount = probe.width * probe.height
  const mask = new Uint8Array(pixelCount)
  let matchedPixels = 0
  for (let y = 0; y < probe.height; y += 1) {
    for (let x = 0; x < probe.width; x += 1) {
      const offset = (y * probe.width + x) * 3
      const red = pixels[offset]
      const green = pixels[offset + 1]
      const blue = pixels[offset + 2]
      // The fixture window owns #ff2d73 edge-to-edge. The animated desktop is
      // deliberately dark, so this tolerance survives H.264 chroma subsampling
      // without accepting its background gradient.
      if (
        red >= 180
        && green <= 105
        && blue >= 65
        && blue <= 190
        && red - green >= 100
      ) {
        mask[y * probe.width + x] = 1
        matchedPixels += 1
      }
    }
  }
  // The user's desktop can contain isolated magenta pixels or small icons. A
  // global bounding box would span those unrelated pixels and look like a
  // full-screen target. The fixture is one large connected magenta surface,
  // so select the largest 4-connected component and derive its actual encoded
  // pixel bounds without consulting the asynchronous setBounds request log.
  const queue = new Int32Array(Math.max(1, matchedPixels))
  let componentCount = 0
  let largest = null
  for (let start = 0; start < pixelCount; start += 1) {
    if (mask[start] !== 1) continue
    componentCount += 1
    let head = 0
    let tail = 1
    queue[0] = start
    mask[start] = 0
    let componentPixels = 0
    let minX = probe.width
    let minY = probe.height
    let maxX = -1
    let maxY = -1
    while (head < tail) {
      const index = queue[head]
      head += 1
      const x = index % probe.width
      const y = Math.floor(index / probe.width)
      componentPixels += 1
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
      const left = index - 1
      const right = index + 1
      const above = index - probe.width
      const below = index + probe.width
      if (x > 0 && mask[left] === 1) {
        mask[left] = 0
        queue[tail] = left
        tail += 1
      }
      if (x + 1 < probe.width && mask[right] === 1) {
        mask[right] = 0
        queue[tail] = right
        tail += 1
      }
      if (y > 0 && mask[above] === 1) {
        mask[above] = 0
        queue[tail] = above
        tail += 1
      }
      if (y + 1 < probe.height && mask[below] === 1) {
        mask[below] = 0
        queue[tail] = below
        tail += 1
      }
    }
    if (largest === null || componentPixels > largest.pixels) {
      largest = {
        pixels: componentPixels,
        min_x: minX,
        min_y: minY,
        max_x: maxX,
        max_y: maxY,
      }
    }
  }
  if (largest === null || largest.pixels < 100) {
    return {
      bounds: null,
      mask_pixels: largest?.pixels ?? 0,
      matched_pixels: matchedPixels,
      component_count: componentCount,
      error: null,
    }
  }
  const scaleX = snapshotSize.width / probe.width
  const scaleY = snapshotSize.height / probe.height
  return {
    bounds: {
      x: Math.max(0, Math.round(largest.min_x * scaleX)),
      y: Math.max(0, Math.round(largest.min_y * scaleY)),
      width: Math.max(1, Math.round((largest.max_x + 1 - largest.min_x) * scaleX)),
      height: Math.max(1, Math.round((largest.max_y + 1 - largest.min_y) * scaleY)),
    },
    mask_pixels: largest.pixels,
    matched_pixels: matchedPixels,
    component_count: componentCount,
    error: null,
  }
}

async function probeReplay(packDir, display) {
  const replayPath = safePackFile(packDir, display.replay)
  if (replayPath === null || !existsSync(replayPath)) {
    return {
      display: display.index,
      file: display.replay ?? null,
      present: false,
      probe_ok: false,
      decode_ok: false,
      frames_ms: [],
      error: 'declared replay is missing or unsafe',
    }
  }
  setStage('probing', `${path.basename(replayPath)} frame PTS`)
  const probe = await runBounded(
    'ffprobe',
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries',
      'stream=codec_name,width,height,avg_frame_rate,r_frame_rate,nb_frames,duration:' +
        'format=duration:' +
        'frame=best_effort_timestamp_time,pkt_duration_time',
      '-of', 'json',
      replayPath,
    ],
  )
  const rawProbePath = path.join(artifactsDir, `ffprobe-d${String(display.index)}.json`)
  writeFileSync(rawProbePath, probe.stdout, 'utf8')
  let parsed = null
  try {
    parsed = JSON.parse(probe.stdout)
  } catch {
    parsed = null
  }
  const framesMs = Array.isArray(parsed?.frames)
    ? parsed.frames
      .map((frame) => Number(frame.best_effort_timestamp_time) * 1000)
      .filter(Number.isFinite)
      .sort((left, right) => left - right)
    : []
  let maxGapMs = null
  let maxGapStartMs = null
  let maxGapEndMs = null
  const gaps = []
  for (let index = 1; index < framesMs.length; index += 1) {
    const gap = framesMs[index] - framesMs[index - 1]
    gaps.push({
      start_ms: framesMs[index - 1],
      end_ms: framesMs[index],
      gap_ms: gap,
    })
    if (maxGapMs === null || gap > maxGapMs) {
      maxGapMs = gap
      maxGapStartMs = framesMs[index - 1]
      maxGapEndMs = framesMs[index]
    }
  }
  const afterFirstSecond = gaps.filter((gap) => gap.start_ms >= 1000)
  const steadyMax =
    afterFirstSecond.length === 0
      ? null
      : afterFirstSecond.reduce(
          (largest, gap) => gap.gap_ms > largest.gap_ms ? gap : largest,
          afterFirstSecond[0],
        )
  const elapsedMs =
    framesMs.length >= 2 ? framesMs[framesMs.length - 1] - framesMs[0] : null
  const achievedFps =
    elapsedMs !== null && elapsedMs > 0
      ? ((framesMs.length - 1) * 1000) / elapsedMs
      : null
  const stream = Array.isArray(parsed?.streams) ? parsed.streams[0] : null
  const formatDurationMs = Number(parsed?.format?.duration) * 1000
  const streamDurationMs = Number(stream?.duration) * 1000
  const durationMs = Number.isFinite(formatDurationMs)
    ? formatDurationMs
    : Number.isFinite(streamDurationMs)
      ? streamDurationMs
      : elapsedMs

  setStage('decoding', `${path.basename(replayPath)} with ffmpeg -xerror + frame hashes`)
  const decode = await runBounded(
    'ffmpeg',
    [
      '-nostdin', '-v', 'error', '-xerror',
      '-i', replayPath,
      '-map', '0:v:0',
      '-vf', 'scale=64:36:flags=fast_bilinear,format=gray',
      // Preserve the stream's own VFR cadence. ffmpeg's default output
      // synchronizer may drop a valid frame before framemd5, which made a
      // fully moving 350/350 replay look like a 349-frame decode failure.
      '-fps_mode', 'passthrough',
      '-f', 'framemd5', '-',
    ],
  )
  const frameHashes = decode.stdout
    .split(/\r?\n/u)
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line.split(',').at(-1)?.trim() ?? '')
    .filter((hash) => /^[0-9a-f]{32}$/iu.test(hash))
  let changedFramePairs = 0
  for (let index = 1; index < frameHashes.length; index += 1) {
    if (frameHashes[index] !== frameHashes[index - 1]) changedFramePairs += 1
  }
  const frameChangeRatio =
    frameHashes.length < 2
      ? null
      : changedFramePairs / (frameHashes.length - 1)
  writeFileSync(
    path.join(artifactsDir, `framemd5-d${String(display.index)}.txt`),
    decode.stdout,
    'utf8',
  )
  writeFileSync(
    path.join(artifactsDir, `ffmpeg-d${String(display.index)}.log`),
    decode.stderr,
    'utf8',
  )
  return {
    display: display.index,
    file: display.replay,
    absolute_path: replayPath,
    present: true,
    bytes: statSync(replayPath).size,
    probe_ok: probe.code === 0 && parsed !== null && framesMs.length > 0,
    decode_ok: decode.code === 0 && !decode.timed_out,
    decode_timed_out: decode.timed_out,
    codec: typeof stream?.codec_name === 'string' ? stream.codec_name : null,
    width: Number.isFinite(Number(stream?.width)) ? Number(stream.width) : null,
    height: Number.isFinite(Number(stream?.height)) ? Number(stream.height) : null,
    declared_avg_frame_rate: parseRate(stream?.avg_frame_rate),
    declared_r_frame_rate: parseRate(stream?.r_frame_rate),
    frame_count: framesMs.length,
    decoded_frame_hash_count: frameHashes.length,
    unique_decoded_frame_hashes: new Set(frameHashes).size,
    changed_decoded_frame_pairs: changedFramePairs,
    decoded_frame_change_ratio: frameChangeRatio,
    first_pts_ms: framesMs[0] ?? null,
    last_pts_ms: framesMs[framesMs.length - 1] ?? null,
    duration_ms: Number.isFinite(durationMs) ? durationMs : null,
    achieved_fps: achievedFps,
    max_pts_gap_ms: maxGapMs,
    max_pts_gap_start_ms: maxGapStartMs,
    max_pts_gap_end_ms: maxGapEndMs,
    max_pts_gap_is_startup: maxGapStartMs !== null && maxGapStartMs < 1000,
    max_pts_gap_after_first_1s_ms: steadyMax?.gap_ms ?? null,
    max_pts_gap_after_first_1s_start_ms: steadyMax?.start_ms ?? null,
    max_pts_gap_after_first_1s_end_ms: steadyMax?.end_ms ?? null,
    pts_gap_ms: distribution(gaps.map((gap) => gap.gap_ms)),
    frames_ms: framesMs,
    error:
      probe.code === 0 && decode.code === 0
        ? null
        : String(probe.stderr || decode.stderr || probe.error || decode.error).slice(0, 1000),
  }
}

function percentile(values, fraction) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const position = Math.max(0, Math.min(sorted.length - 1, (sorted.length - 1) * fraction))
  const lowerIndex = Math.floor(position)
  const upperIndex = Math.ceil(position)
  const lower = sorted[lowerIndex]
  const upper = sorted[upperIndex]
  if (lower === undefined || upper === undefined) return null
  if (lowerIndex === upperIndex) return lower
  return lower + (upper - lower) * (position - lowerIndex)
}

function distribution(values) {
  if (values.length === 0) {
    return { count: 0, min: null, p50: null, p95: null, max: null, mean: null }
  }
  return {
    count: values.length,
    min: Math.min(...values),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
  }
}

function nearestNumber(sorted, requested) {
  if (sorted.length === 0) return null
  let low = 0
  let high = sorted.length - 1
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (sorted[middle] < requested) low = middle + 1
    else high = middle
  }
  const after = sorted[low]
  const before = low > 0 ? sorted[low - 1] : null
  return before !== null && Math.abs(before - requested) <= Math.abs(after - requested)
    ? before
    : after
}

async function loadPastHelper() {
  const bundled = await build({
    entryPoints: [helperEntry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    plugins: [{
      name: 'field-log-stub',
      setup(builder) {
        builder.onResolve(
          { filter: /(^|[/\\])log$/ },
          () => ({ path: 'log-stub', namespace: 'field-stub' }),
        )
        builder.onLoad({ filter: /.*/, namespace: 'field-stub' }, () => ({
          contents:
            'export const logInfo=()=>{};' +
            'export const logWarn=()=>{};' +
            'export const logError=()=>{};',
          loader: 'js',
        }))
      },
    }],
  })
  const source = bundled.outputFiles[0]?.text
  if (source === undefined) throw new Error('esbuild did not emit the field helper')
  return await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

function movementRows() {
  if (!existsSync(movementPath)) return []
  return readFileSync(movementPath, 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
    .sort((left, right) => left.wall_time_ms - right.wall_time_ms)
}

function nearestMovement(rows, wallTimeMs) {
  if (rows.length === 0) return null
  let best = rows[0]
  let bestDistance = Math.abs(best.wall_time_ms - wallTimeMs)
  for (const row of rows) {
    const distance = Math.abs(row.wall_time_ms - wallTimeMs)
    if (distance < bestDistance) {
      best = row
      bestDistance = distance
    }
  }
  return { row: best, delta_ms: bestDistance }
}

function rectError(left, right) {
  return (
    Math.abs(left.x - right.x)
    + Math.abs(left.y - right.y)
    + Math.abs(left.width - right.width)
    + Math.abs(left.height - right.height)
  )
}

function median(values) {
  return percentile(values, 0.5)
}

function medianAbsoluteDeviation(values) {
  const centre = median(values)
  if (centre === null) return null
  return median(values.map((value) => Math.abs(value - centre)))
}

function movementCadenceMs(rows) {
  const gaps = []
  for (let index = 1; index < rows.length; index += 1) {
    const gap = rows[index].wall_time_ms - rows[index - 1].wall_time_ms
    if (Number.isFinite(gap) && gap > 0 && gap <= 250) gaps.push(gap)
  }
  return median(gaps) ?? 16
}

function expectedMovementBounds(row, displayIndex) {
  const expected = Array.isArray(row?.expected) ? row.expected : []
  return expected.find((item) => item?.display_index === displayIndex)?.bounds_snapshot ?? null
}

function temporalMatchClusters(matches, maximumGapMs) {
  const clusters = []
  for (const match of matches) {
    const previous = clusters.at(-1)
    if (
      previous === undefined
      || match.wall_time_ms - previous.at(-1).wall_time_ms > maximumGapMs
    ) {
      clusters.push([match])
    } else {
      previous.push(match)
    }
  }
  return clusters
}

/**
 * Infer when one decoded/observed rectangle existed on the physical desktop.
 *
 * This is deliberately conservative. A coordinate only becomes a time when
 * the fixture moved far enough to make time observable and one contiguous
 * minimum-error cluster wins. Repeated coordinates and static intervals are
 * reported as ambiguous/static instead of being resolved by nearest-time
 * guesswork.
 */
function inferMovementTime({
  rows,
  displayIndex,
  bounds,
  nominalWallTimeMs,
  searchRadiusMs,
}) {
  if (
    bounds === null
    || !Number.isFinite(nominalWallTimeMs)
    || !Number.isFinite(searchRadiusMs)
    || searchRadiusMs <= 0
  ) {
    return {
      status: 'unavailable',
      inferred_wall_time_ms: null,
      uncertainty_ms: null,
      confidence: 'none',
      confidence_score: 0,
      reason: 'rectangle or nominal wall-clock anchor is unavailable',
    }
  }
  const candidates = rows.flatMap((row) => {
    if (
      !Number.isFinite(row?.wall_time_ms)
      || Math.abs(row.wall_time_ms - nominalWallTimeMs) > searchRadiusMs
    ) return []
    const expected = expectedMovementBounds(row, displayIndex)
    return expected === null
      ? []
      : [{
          wall_time_ms: row.wall_time_ms,
          bounds: expected,
          edge_error_px: rectError(bounds, expected),
        }]
  })
  if (candidates.length === 0) {
    return {
      status: 'unavailable',
      inferred_wall_time_ms: null,
      uncertainty_ms: null,
      confidence: 'none',
      confidence_score: 0,
      reason: 'no fixture movement samples cover this display and search window',
      candidate_count: 0,
    }
  }

  const cadenceMs = movementCadenceMs(
    candidates.map((candidate) => ({ wall_time_ms: candidate.wall_time_ms })),
  )
  const xValues = candidates.map((candidate) => candidate.bounds.x)
  const yValues = candidates.map((candidate) => candidate.bounds.y)
  const widthValues = candidates.map((candidate) => candidate.bounds.width)
  const heightValues = candidates.map((candidate) => candidate.bounds.height)
  const motionExtentPx =
    Math.max(...xValues) - Math.min(...xValues)
    + Math.max(...yValues) - Math.min(...yValues)
    + Math.max(...widthValues) - Math.min(...widthValues)
    + Math.max(...heightValues) - Math.min(...heightValues)
  if (motionExtentPx <= COORDINATE_EDGE_ERROR_LIMIT_PX) {
    return {
      status: 'static',
      inferred_wall_time_ms: null,
      uncertainty_ms: null,
      confidence: 'none',
      confidence_score: 0,
      reason: 'fixture coordinates did not change enough to identify a time',
      candidate_count: candidates.length,
      movement_cadence_ms: cadenceMs,
      motion_extent_px: motionExtentPx,
    }
  }

  const bestError = Math.min(...candidates.map((candidate) => candidate.edge_error_px))
  if (bestError > COORDINATE_EDGE_ERROR_LIMIT_PX) {
    return {
      status: 'no-match',
      inferred_wall_time_ms: null,
      uncertainty_ms: null,
      confidence: 'none',
      confidence_score: 0,
      reason: 'no movement sample is within the coordinate error contract',
      candidate_count: candidates.length,
      movement_cadence_ms: cadenceMs,
      motion_extent_px: motionExtentPx,
      best_edge_error_px: bestError,
    }
  }

  const nearBestLimit = Math.min(
    COORDINATE_EDGE_ERROR_LIMIT_PX,
    bestError + Math.max(2, COORDINATE_EDGE_ERROR_LIMIT_PX / 4),
  )
  const nearBest = candidates
    .filter((candidate) => candidate.edge_error_px <= nearBestLimit)
    .sort((left, right) => left.wall_time_ms - right.wall_time_ms)
  const clusters = temporalMatchClusters(nearBest, Math.max(40, cadenceMs * 3))
    .map((cluster) => ({
      rows: cluster,
      minimum_error_px: Math.min(...cluster.map((item) => item.edge_error_px)),
      centre_ms: median(cluster.map((item) => item.wall_time_ms)),
      start_ms: cluster[0].wall_time_ms,
      end_ms: cluster.at(-1).wall_time_ms,
    }))
    .sort((left, right) => (
      left.minimum_error_px - right.minimum_error_px
      || Math.abs(left.centre_ms - nominalWallTimeMs)
        - Math.abs(right.centre_ms - nominalWallTimeMs)
    ))
  const bestCluster = clusters[0]
  const competingClusters = clusters.filter((cluster, index) => (
    index > 0
    && cluster.minimum_error_px <= bestCluster.minimum_error_px + 2
  ))
  if (competingClusters.length > 0) {
    return {
      status: 'ambiguous',
      inferred_wall_time_ms: null,
      uncertainty_ms: null,
      confidence: 'none',
      confidence_score: 0,
      reason: 'multiple separated movement intervals match the rectangle equally well',
      candidate_count: candidates.length,
      movement_cadence_ms: cadenceMs,
      motion_extent_px: motionExtentPx,
      best_edge_error_px: bestError,
      near_best_cluster_count: clusters.length,
      competing_cluster_count: competingClusters.length,
    }
  }

  const inferredWallTimeMs = bestCluster.centre_ms
  const uncertaintyMs =
    (bestCluster.end_ms - bestCluster.start_ms) / 2 + cadenceMs / 2
  const nextError = clusters[1]?.minimum_error_px ?? COORDINATE_EDGE_ERROR_LIMIT_PX
  const errorScore = Math.max(
    0,
    1 - bestError / Math.max(1, COORDINATE_EDGE_ERROR_LIMIT_PX),
  )
  const uniquenessScore = Math.max(
    0,
    Math.min(
      1,
      (nextError - bestCluster.minimum_error_px)
        / Math.max(1, COORDINATE_EDGE_ERROR_LIMIT_PX / 2),
    ),
  )
  const precisionScore = Math.max(
    0,
    Math.min(1, 1 - uncertaintyMs / Math.max(1, searchRadiusMs / 4)),
  )
  const confidenceScore = Math.min(errorScore, uniquenessScore, precisionScore)
  const confidence =
    confidenceScore >= 0.75 ? 'high' : confidenceScore >= 0.45 ? 'medium' : 'low'
  return {
    status: 'measured',
    inferred_wall_time_ms: inferredWallTimeMs,
    uncertainty_ms: uncertaintyMs,
    confidence,
    confidence_score: confidenceScore,
    reason: null,
    candidate_count: candidates.length,
    movement_cadence_ms: cadenceMs,
    motion_extent_px: motionExtentPx,
    best_edge_error_px: bestError,
    near_best_cluster_count: clusters.length,
    competing_cluster_count: 0,
    matched_interval: {
      start_ms: bestCluster.start_ms,
      end_ms: bestCluster.end_ms,
    },
  }
}

function lagSign(lagMs, uncertaintyMs) {
  if (!Number.isFinite(lagMs)) return 'unknown'
  const deadband = Number.isFinite(uncertaintyMs) ? uncertaintyMs : 0
  if (lagMs < -deadband) return 'replay_pixels_older_than_context'
  if (lagMs > deadband) return 'replay_pixels_newer_than_context'
  return 'aligned_within_measurement_precision'
}

function inferTemporalLagSample({
  rows,
  displayIndex,
  pixelBounds,
  observedBounds,
  observedContextTimeMs,
  timelineOriginMs,
  nominalFrameIntervalMs,
}) {
  const nominalWallTimeMs =
    Number.isFinite(timelineOriginMs) && Number.isFinite(observedContextTimeMs)
      ? timelineOriginMs + observedContextTimeMs
      : null
  const searchRadiusMs = Math.max(
    TEMPORAL_LAG_MIN_SEARCH_RADIUS_MS,
    nominalFrameIntervalMs * TEMPORAL_LAG_FRAME_SEARCH_MULTIPLIER,
  )
  const pixelMatch = inferMovementTime({
    rows,
    displayIndex,
    bounds: pixelBounds,
    nominalWallTimeMs,
    searchRadiusMs,
  })
  const contextMatch = inferMovementTime({
    rows,
    displayIndex,
    bounds: observedBounds,
    nominalWallTimeMs,
    searchRadiusMs,
  })
  if (pixelMatch.status !== 'measured' || contextMatch.status !== 'measured') {
    const status =
      pixelMatch.status === 'static' || contextMatch.status === 'static'
        ? 'static'
        : pixelMatch.status === 'ambiguous' || contextMatch.status === 'ambiguous'
          ? 'ambiguous'
          : 'unavailable'
    return {
      status,
      signed_lag_ms: null,
      absolute_lag_ms: null,
      sign: 'unknown',
      uncertainty_ms: null,
      confidence: 'none',
      confidence_score: 0,
      observed_context_t_ms: observedContextTimeMs,
      nominal_wall_time_ms: nominalWallTimeMs,
      search_radius_ms: searchRadiusMs,
      pixel_match: pixelMatch,
      context_match: contextMatch,
    }
  }
  const signedLagMs =
    pixelMatch.inferred_wall_time_ms - contextMatch.inferred_wall_time_ms
  const uncertaintyMs = pixelMatch.uncertainty_ms + contextMatch.uncertainty_ms
  const confidenceScore = Math.min(
    pixelMatch.confidence_score,
    contextMatch.confidence_score,
  )
  return {
    status: 'measured',
    signed_lag_ms: signedLagMs,
    absolute_lag_ms: Math.abs(signedLagMs),
    sign: lagSign(signedLagMs, uncertaintyMs),
    uncertainty_ms: uncertaintyMs,
    confidence:
      confidenceScore >= 0.75 ? 'high' : confidenceScore >= 0.45 ? 'medium' : 'low',
    confidence_score: confidenceScore,
    observed_context_t_ms: observedContextTimeMs,
    nominal_wall_time_ms: nominalWallTimeMs,
    search_radius_ms: searchRadiusMs,
    pixel_match: pixelMatch,
    context_match: contextMatch,
  }
}

function summarizeTemporalLag(displayIndex, samples, nominalFrameIntervalMs) {
  const displaySamples = samples.filter((sample) => sample.display === displayIndex)
  const measured = displaySamples.filter((sample) => sample.status === 'measured')
  const signed = measured.map((sample) => sample.signed_lag_ms)
  const absolute = measured.map((sample) => sample.absolute_lag_ms)
  const uncertainties = measured.map((sample) => sample.uncertainty_ms)
  const confidenceScores = measured.map((sample) => sample.confidence_score)
  const statusCounts = Object.fromEntries(
    [...new Set(displaySamples.map((sample) => sample.status))]
      .map((status) => [
        status,
        displaySamples.filter((sample) => sample.status === status).length,
      ]),
  )
  const signedDistribution = distribution(signed)
  const absoluteDistribution = distribution(absolute)
  const madMs = medianAbsoluteDeviation(signed)
  const medianUncertaintyMs = median(uncertainties)
  const inferredLagMs = signedDistribution.p50
  const inferredSign = lagSign(inferredLagMs, medianUncertaintyMs)
  const dominantCount = inferredSign === 'unknown'
    ? 0
    : measured.filter((sample) => sample.sign === inferredSign).length
  const signConsistency = measured.length === 0 ? 0 : dominantCount / measured.length
  const meanConfidence = confidenceScores.length === 0
    ? 0
    : confidenceScores.reduce((sum, value) => sum + value, 0) / confidenceScores.length
  const consistencyLimitMs = Math.max(50, nominalFrameIntervalMs * 1.5)
  const enoughEvidence =
    measured.length >= 2
    && signConsistency >= 2 / 3
    && madMs !== null
    && madMs <= consistencyLimitMs
  const highConfidence =
    enoughEvidence
    && measured.length >= 4
    && signConsistency >= 0.8
    && meanConfidence >= 0.75
    && madMs <= Math.max(32, nominalFrameIntervalMs * 0.75)
  return {
    display: displayIndex,
    status:
      enoughEvidence
        ? 'measured'
        : measured.length === 0
          ? 'unavailable'
          : 'ambiguous',
    inferred_signed_lag_ms: enoughEvidence ? inferredLagMs : null,
    inferred_sign: enoughEvidence ? inferredSign : 'unknown',
    confidence: highConfidence ? 'high' : enoughEvidence ? 'medium' : 'none',
    measured_sample_count: measured.length,
    total_sample_count: displaySamples.length,
    sample_status_counts: statusCounts,
    signed_lag_ms: signedDistribution,
    absolute_lag_ms: absoluteDistribution,
    median_absolute_deviation_ms: madMs,
    median_uncertainty_ms: medianUncertaintyMs,
    sign_consistency: signConsistency,
    mean_sample_confidence_score: meanConfidence,
    consistency_limit_ms: consistencyLimitMs,
  }
}

function sourceLatencySign(latencyMs, uncertaintyMs) {
  if (!Number.isFinite(latencyMs)) return 'unknown'
  const deadband = Number.isFinite(uncertaintyMs) ? uncertaintyMs : 0
  if (latencyMs > deadband) return 'source_pixels_older_than_encoded_pts'
  if (latencyMs < -deadband) return 'source_pixels_newer_than_encoded_pts'
  return 'aligned_within_measurement_precision'
}

function inferSourceLatencySample({
  timelineOriginMs,
  encodedFramePtsMs,
  pixelMatch,
}) {
  const encodedFrameNominalWallTimeMs =
    Number.isFinite(timelineOriginMs) && Number.isFinite(encodedFramePtsMs)
      ? timelineOriginMs + encodedFramePtsMs
      : null
  if (encodedFrameNominalWallTimeMs === null) {
    return {
      status: 'unavailable',
      source_latency_ms: null,
      absolute_latency_ms: null,
      sign: 'unknown',
      uncertainty_ms: null,
      confidence: 'none',
      confidence_score: 0,
      encoded_frame_nominal_wall_time_ms: null,
      inferred_pixel_wall_time_ms: null,
      reason: 'timeline origin or encoded frame PTS is unavailable',
    }
  }
  if (pixelMatch?.status !== 'measured') {
    const status =
      pixelMatch?.status === 'static'
        ? 'static'
        : pixelMatch?.status === 'ambiguous'
          ? 'ambiguous'
          : 'unavailable'
    return {
      status,
      source_latency_ms: null,
      absolute_latency_ms: null,
      sign: 'unknown',
      uncertainty_ms: null,
      confidence: 'none',
      confidence_score: 0,
      encoded_frame_nominal_wall_time_ms: encodedFrameNominalWallTimeMs,
      inferred_pixel_wall_time_ms: null,
      reason:
        pixelMatch?.reason
        ?? 'decoded replay pixels could not be uniquely placed on the fixture clock',
    }
  }
  const sourceLatencyMs =
    encodedFrameNominalWallTimeMs - pixelMatch.inferred_wall_time_ms
  const uncertaintyMs = pixelMatch.uncertainty_ms
  return {
    status: 'measured',
    source_latency_ms: sourceLatencyMs,
    absolute_latency_ms: Math.abs(sourceLatencyMs),
    sign: sourceLatencySign(sourceLatencyMs, uncertaintyMs),
    uncertainty_ms: uncertaintyMs,
    confidence: pixelMatch.confidence,
    confidence_score: pixelMatch.confidence_score,
    encoded_frame_nominal_wall_time_ms: encodedFrameNominalWallTimeMs,
    inferred_pixel_wall_time_ms: pixelMatch.inferred_wall_time_ms,
    reason: null,
  }
}

function summarizeSourceLatency(displayIndex, samples, nominalFrameIntervalMs) {
  const displaySamples = samples.filter((sample) => sample.display === displayIndex)
  const measured = displaySamples.filter((sample) => sample.status === 'measured')
  const latencies = measured.map((sample) => sample.source_latency_ms)
  const absolute = measured.map((sample) => sample.absolute_latency_ms)
  const uncertainties = measured.map((sample) => sample.uncertainty_ms)
  const confidenceScores = measured.map((sample) => sample.confidence_score)
  const statusCounts = Object.fromEntries(
    [...new Set(displaySamples.map((sample) => sample.status))]
      .map((status) => [
        status,
        displaySamples.filter((sample) => sample.status === status).length,
      ]),
  )
  const latencyDistribution = distribution(latencies)
  const absoluteDistribution = distribution(absolute)
  const madMs = medianAbsoluteDeviation(latencies)
  const medianUncertaintyMs = median(uncertainties)
  const inferredLatencyMs = latencyDistribution.p50
  const inferredSign = sourceLatencySign(inferredLatencyMs, medianUncertaintyMs)
  const dominantCount = inferredSign === 'unknown'
    ? 0
    : measured.filter((sample) => sample.sign === inferredSign).length
  const signConsistency = measured.length === 0 ? 0 : dominantCount / measured.length
  const meanConfidence = confidenceScores.length === 0
    ? 0
    : confidenceScores.reduce((sum, value) => sum + value, 0) / confidenceScores.length
  const consistencyLimitMs = Math.max(50, nominalFrameIntervalMs * 1.5)
  const enoughEvidence =
    measured.length >= 2
    && signConsistency >= 2 / 3
    && madMs !== null
    && madMs <= consistencyLimitMs
  const highConfidence =
    enoughEvidence
    && measured.length >= 4
    && signConsistency >= 0.8
    && meanConfidence >= 0.75
    && madMs <= Math.max(32, nominalFrameIntervalMs * 0.75)
  return {
    display: displayIndex,
    status:
      enoughEvidence
        ? 'measured'
        : measured.length === 0
          ? 'unavailable'
          : 'ambiguous',
    inferred_source_latency_ms: enoughEvidence ? inferredLatencyMs : null,
    inferred_sign: enoughEvidence ? inferredSign : 'unknown',
    confidence: highConfidence ? 'high' : enoughEvidence ? 'medium' : 'none',
    measured_sample_count: measured.length,
    total_sample_count: displaySamples.length,
    sample_status_counts: statusCounts,
    source_latency_ms: latencyDistribution,
    absolute_latency_ms: absoluteDistribution,
    median_absolute_deviation_ms: madMs,
    median_uncertainty_ms: medianUncertaintyMs,
    sign_consistency: signConsistency,
    mean_sample_confidence_score: meanConfidence,
    consistency_limit_ms: consistencyLimitMs,
  }
}

function runTemporalLagSelfTest() {
  const quantiles = distribution([-183, -166, -108, -91])
  if (quantiles.p50 !== -137 || Math.abs(quantiles.p95 - -93.55) > 0.001) {
    throw new Error(
      `lag self-test expected interpolated p50/p95, got ${JSON.stringify(quantiles)}`,
    )
  }
  const makeRows = (boundsAt) =>
    Array.from({ length: 101 }, (_, index) => {
      const wallTimeMs = index * 20
      return {
        wall_time_ms: wallTimeMs,
        expected: [{
          display_index: 1,
          bounds_snapshot: boundsAt(wallTimeMs),
        }],
      }
    })
  const dynamicRows = makeRows((wallTimeMs) => ({
    x: wallTimeMs / 10,
    y: 20,
    width: 200,
    height: 120,
  }))
  const measured = inferTemporalLagSample({
    rows: dynamicRows,
    displayIndex: 1,
    pixelBounds: { x: 60, y: 20, width: 200, height: 120 },
    observedBounds: { x: 100, y: 20, width: 200, height: 120 },
    observedContextTimeMs: 1000,
    timelineOriginMs: 0,
    nominalFrameIntervalMs: 200,
  })
  if (measured.status !== 'measured' || measured.signed_lag_ms !== -400) {
    throw new Error(`lag self-test expected -400ms, got ${JSON.stringify(measured)}`)
  }
  const sourceLatency = inferSourceLatencySample({
    timelineOriginMs: 0,
    encodedFramePtsMs: 1000,
    pixelMatch: measured.pixel_match,
  })
  if (
    sourceLatency.status !== 'measured'
    || sourceLatency.source_latency_ms !== 400
    || sourceLatency.sign !== 'source_pixels_older_than_encoded_pts'
  ) {
    throw new Error(
      `lag self-test expected 400ms source latency, got ${JSON.stringify(sourceLatency)}`,
    )
  }
  const staticMatch = inferMovementTime({
    rows: makeRows(() => ({ x: 5, y: 5, width: 200, height: 120 })),
    displayIndex: 1,
    bounds: { x: 5, y: 5, width: 200, height: 120 },
    nominalWallTimeMs: 1000,
    searchRadiusMs: 1000,
  })
  if (staticMatch.status !== 'static') {
    throw new Error(`lag self-test expected static, got ${JSON.stringify(staticMatch)}`)
  }
  const staticSourceLatency = inferSourceLatencySample({
    timelineOriginMs: 0,
    encodedFramePtsMs: 1000,
    pixelMatch: staticMatch,
  })
  if (
    staticSourceLatency.status !== 'static'
    || staticSourceLatency.source_latency_ms !== null
  ) {
    throw new Error(
      `lag self-test expected unmeasured static source latency, got ` +
      `${JSON.stringify(staticSourceLatency)}`,
    )
  }
  const ambiguousMatch = inferMovementTime({
    rows: makeRows((wallTimeMs) => ({
      x: Math.abs(wallTimeMs - 1000) / 10,
      y: 20,
      width: 200,
      height: 120,
    })),
    displayIndex: 1,
    bounds: { x: 40, y: 20, width: 200, height: 120 },
    nominalWallTimeMs: 1000,
    searchRadiusMs: 1000,
  })
  if (ambiguousMatch.status !== 'ambiguous') {
    throw new Error(`lag self-test expected ambiguous, got ${JSON.stringify(ambiguousMatch)}`)
  }
  const summary = summarizeTemporalLag(1, [
    { display: 1, ...measured },
    { display: 1, ...measured, signed_lag_ms: -380, absolute_lag_ms: 380 },
    { display: 1, ...measured, signed_lag_ms: -420, absolute_lag_ms: 420 },
    { display: 1, ...measured, signed_lag_ms: -400, absolute_lag_ms: 400 },
  ], 200)
  if (
    summary.status !== 'measured'
    || summary.inferred_signed_lag_ms !== -400
    || summary.inferred_sign !== 'replay_pixels_older_than_context'
  ) {
    throw new Error(`lag self-test summary failed: ${JSON.stringify(summary)}`)
  }
  const sourceSummary = summarizeSourceLatency(1, [
    { display: 1, ...sourceLatency },
    {
      display: 1,
      ...sourceLatency,
      source_latency_ms: 380,
      absolute_latency_ms: 380,
    },
    {
      display: 1,
      ...sourceLatency,
      source_latency_ms: 420,
      absolute_latency_ms: 420,
    },
    { display: 1, ...sourceLatency },
  ], 200)
  if (
    sourceSummary.status !== 'measured'
    || sourceSummary.inferred_source_latency_ms !== 400
    || sourceSummary.inferred_sign !== 'source_pixels_older_than_encoded_pts'
  ) {
    throw new Error(
      `lag self-test source summary failed: ${JSON.stringify(sourceSummary)}`,
    )
  }
}

function summarizeProcesses(samples) {
  const logicalProcessors = Math.max(1, cpus().length)
  const cpuTotalCapacity = []
  const cpuOneCore = []
  const workingSets = []
  const privateBytes = []
  const processCounts = []
  for (const sample of samples) {
    workingSets.push(sample.processes.reduce((sum, process) => sum + process.working_set_bytes, 0))
    privateBytes.push(sample.processes.reduce((sum, process) => sum + process.private_bytes, 0))
    processCounts.push(sample.processes.length)
  }
  for (let index = 1; index < samples.length; index += 1) {
    const before = samples[index - 1]
    const after = samples[index]
    const elapsedSeconds = (after.wall_time_ms - before.wall_time_ms) / 1000
    if (elapsedSeconds <= 0) continue
    const previous = new Map(before.processes.map((process) => [process.pid, process.cpu_seconds]))
    let gainedCpuSeconds = 0
    for (const process of after.processes) {
      const old = previous.get(process.pid)
      if (old !== undefined) gainedCpuSeconds += Math.max(0, process.cpu_seconds - old)
    }
    const oneCore = (gainedCpuSeconds / elapsedSeconds) * 100
    cpuOneCore.push(oneCore)
    cpuTotalCapacity.push(oneCore / logicalProcessors)
  }
  const mean = (values) =>
    values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
  return {
    sample_count: samples.length,
    sample_interval_ms: sampleIntervalMs,
    logical_processors: logicalProcessors,
    cpu_total_capacity_percent: {
      mean: mean(cpuTotalCapacity),
      p95: percentile(cpuTotalCapacity, 0.95),
      peak: cpuTotalCapacity.length === 0 ? null : Math.max(...cpuTotalCapacity),
    },
    cpu_one_core_percent: {
      mean: mean(cpuOneCore),
      p95: percentile(cpuOneCore, 0.95),
      peak: cpuOneCore.length === 0 ? null : Math.max(...cpuOneCore),
    },
    private_bytes: {
      mean: mean(privateBytes),
      peak: privateBytes.length === 0 ? null : Math.max(...privateBytes),
    },
    working_set_bytes: {
      mean: mean(workingSets),
      peak: workingSets.length === 0 ? null : Math.max(...workingSets),
    },
    process_count: {
      min: processCounts.length === 0 ? null : Math.min(...processCounts),
      peak: processCounts.length === 0 ? null : Math.max(...processCounts),
    },
    js_heap: {
      status: 'unavailable',
      reason: 'the production app exposes no read-only runtime heap diagnostics endpoint',
    },
    retained_chunks_and_bytes: {
      status: 'unavailable',
      reason: 'the production app exposes no field diagnostics endpoint for recorder ring internals',
    },
  }
}

const report = {
  schema: 'capturepack.windows-replay-field-report',
  version: 1,
  run_id: runId,
  started_at: new Date(beganAt).toISOString(),
  finished_at: null,
  case: {
    fps,
    duration_seconds: durationSeconds,
    capture_delay_seconds: captureDelaySeconds,
    recorder_start_readiness: {
      policy: 'first-presented-frame-and-advancing-pts',
      maximum_wait_ms: 2000,
      observed_wait_ms: null,
      timed_out: null,
      measurement: 'pending production log',
    },
    measurement_window: {
      kind: warmupSeconds === 0 ? 'underfilled-from-launch' : 'post-warmup-retained',
      requested_ms: durationSeconds * 1000,
      launch_allowance_ms: warmupSeconds * 1000,
    },
    target_requested: targetOption,
    target_resolved: null,
    replay_max_width: replayMaxWidth,
    sample_interval_ms: sampleIntervalMs,
  },
  environment: {
    platform: process.platform,
    node: process.version,
    electron,
    ffprobe_available: false,
    ffmpeg_available: false,
    layout: null,
  },
  artifacts: {
    root: artifactsDir,
    pack: null,
    report: reportPath,
    process_samples: processSamplesPath,
    frame_pts: framePtsPath,
    fixture_layout: layoutPath,
    fixture_movement: movementPath,
    app_log: path.join(profileDir, 'logs', 'main.log'),
  },
  process_metrics: null,
  recorder_runtime: null,
  media: [],
  past_sampling: null,
  checks: {},
  result: 'BROKEN',
  failures: [],
}

let fixture = null
let appProcess = null
const processSamples = []
let fixtureStdout = null
let fixtureStderr = null
let appStdout = null
let appStderr = null

try {
  if (process.platform !== 'win32') throw new Error('this field check must run in Windows Node')
  if (!existsSync(path.join(coreDir, 'dist', 'main', 'index.js'))) {
    throw new Error('core/dist/main/index.js is missing; run npm run build first')
  }
  report.environment.ffprobe_available = executableAvailable('ffprobe')
  report.environment.ffmpeg_available = executableAvailable('ffmpeg')
  if (!report.environment.ffprobe_available || !report.environment.ffmpeg_available) {
    throw new Error('ffprobe and ffmpeg must both be available on PATH')
  }

  setStage('starting-fixture', 'discovering physical displays')
  fixtureStdout = createWriteStream(path.join(fixtureDir, 'stdout.log'))
  fixtureStderr = createWriteStream(path.join(fixtureDir, 'stderr.log'))
  fixture = track(spawn(
    electron,
    [
      fixtureScript,
      `--layout=${layoutPath}`,
      `--movement=${movementPath}`,
      `--stop-file=${fixtureStopPath}`,
      `--run-id=${runId}`,
      `--start-display-id=${fixtureStartDisplayId}`,
      '--cycle-ms=9000',
    ],
    {
      cwd: coreDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
    },
  ))
  fixture.stdout.pipe(fixtureStdout)
  fixture.stderr.pipe(fixtureStderr)
  const fixtureReady = await waitFor(
    () => existsSync(layoutPath) && movementRows().length >= 3,
    30_000,
  )
  if (!fixtureReady) throw new Error('moving fixture did not publish its display layout')
  const layout = readJson(layoutPath)
  report.environment.layout = layout
  const resolvedTargetId =
    targetOption === 'all'
      ? 'all'
      : targetOption === 'primary'
        ? layout.primary_display_id
        : targetOption
  if (
    resolvedTargetId !== 'all'
    && !layout.displays.some((display) => display.id === resolvedTargetId)
  ) {
    throw new Error(
      `target display ${resolvedTargetId} is not connected; ` +
      `available: ${layout.displays.map((display) => display.id).join(', ')}`,
    )
  }
  report.case.target_resolved = resolvedTargetId
  const expectedFixtureStartDisplayId =
    resolvedTargetId === 'all' ? layout.primary_display_id : resolvedTargetId
  if (layout.movement_start_display_id !== expectedFixtureStartDisplayId) {
    throw new Error(
      `moving fixture started on display ${String(layout.movement_start_display_id)}; `
      + `expected calibration display ${expectedFixtureStartDisplayId}`,
    )
  }
  report.case.fixture_start_display_id = layout.movement_start_display_id

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
    replaySeconds: durationSeconds,
    fps,
    replayMaxWidth,
    captureDisplay: resolvedTargetId,
    uiaEnabled: true,
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

  setStage(
    'recording',
    `${fps} fps, ${durationSeconds}s retained after ${warmupSeconds}s launch allowance, ` +
      `${resolvedTargetId === 'all' ? 'all displays' : `display ${resolvedTargetId}`}`,
  )
  appStdout = createWriteStream(path.join(artifactsDir, 'capturepack-stdout.log'))
  appStderr = createWriteStream(path.join(artifactsDir, 'capturepack-stderr.log'))
  appProcess = track(spawn(
    electron,
    [
      '.',
      `--user-data-dir=${profileDir}`,
      `--output-dir=${outputDir}`,
      '--no-global-shortcut',
      '--no-login-item',
      '--no-supervision',
      `--capture-now=${String(captureDelaySeconds)}`,
    ],
    {
      cwd: coreDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CAPTUREPACK_FIELD_QA: '1',
      },
    },
  ))
  appProcess.stdout.pipe(appStdout)
  appProcess.stderr.pipe(appStderr)

  const captureDeadline =
    Date.now() + captureDelaySeconds * 1000 + 180_000
  let nextSampleAt = 0
  let foundPack = null
  let lastProgressAt = 0
  while (!interrupted && Date.now() <= captureDeadline) {
    if (Date.now() >= nextSampleAt) {
      try {
        const processes = await processTreeSnapshot(appProcess.pid)
        const sample = { wall_time_ms: Date.now(), processes }
        processSamples.push(sample)
        appendFileSync(processSamplesPath, `${JSON.stringify(sample)}\n`, 'utf8')
      } catch (error) {
        appendFileSync(
          processSamplesPath,
          `${JSON.stringify({ wall_time_ms: Date.now(), error: String(error) })}\n`,
          'utf8',
        )
      }
      nextSampleAt = Date.now() + sampleIntervalMs
    }
    foundPack = packDirectory()
    if (foundPack !== null) break
    if (Date.now() - lastProgressAt >= 15_000) {
      setStage(
        'recording',
        `waiting for capture, ${Math.round((Date.now() - beganAt) / 1000)}s elapsed`,
      )
      lastProgressAt = Date.now()
    }
    if (appProcess.exitCode !== null) {
      throw new Error(`CapturePack exited before saving (code ${String(appProcess.exitCode)})`)
    }
    await delay(250)
  }
  if (interrupted) throw new Error('field check was interrupted')
  if (foundPack === null) throw new Error('bounded wait expired before a CapturePack was saved')
  report.artifacts.pack = foundPack

  setStage('settling-pack', 'waiting for independently persisted context')
  const contextPath = path.join(foundPack, 'plugins', 'windows-context', 'timeline.json')
  const settleDeadline = Date.now() + settleSeconds * 1000
  let lastContextSize = -1
  let stableContextReads = 0
  while (!interrupted && Date.now() <= settleDeadline) {
    if (existsSync(contextPath)) {
      const size = statSync(contextPath).size
      if (size === lastContextSize && size > 0) stableContextReads += 1
      else stableContextReads = 0
      lastContextSize = size
      if (stableContextReads >= 3) break
    }
    await delay(500)
  }

  // Stop the app before probing. This both releases every media handle and
  // proves the persisted folder, not a renderer's in-memory copy, is enough.
  setStage('stopping-app', 'releasing recorder and media handles')
  await stopTracked(appProcess)
  appProcess = null
  writeFileSync(fixtureStopPath, 'stop\n', 'utf8')
  await waitFor(
    () => fixture.exitCode !== null || fixture.signalCode !== null,
    5000,
  )
  await stopTracked(fixture)
  fixture = null
  fixtureStdout?.end()
  fixtureStderr?.end()
  appStdout?.end()
  appStderr?.end()

  report.process_metrics = summarizeProcesses(processSamples)
  const mainLogPath = path.join(profileDir, 'logs', 'main.log')
  const mainLog = existsSync(mainLogPath) ? readFileSync(mainLogPath, 'utf8') : ''
  const recorderAvailability = parseRecorderAvailability(mainLog)
  const readinessRows = recorderAvailability.displays
  report.case.recorder_start_readiness = {
    ...report.case.recorder_start_readiness,
    measurement:
      readinessRows.length === 0
        ? 'unavailable: production readiness log not found'
        : 'production log',
    capture_requested_at: recorderAvailability.capture_requested_at,
    observations: readinessRows,
    observed_wait_ms: distribution(readinessRows.map((row) => row.observed_wait_ms)),
    measured_available_span_ms: distribution(
      readinessRows
        .map((row) => row.available_span_ms)
        .filter((value) => value !== null),
    ),
    excluded_before_recorder_ms: distribution(
      readinessRows.map((row) => row.excluded_before_recorder_ms),
    ),
    timed_out:
      readinessRows.length === 0
        ? null
        : readinessRows.some((row) => row.timed_out),
  }
  const observedBufferStates = readinessRows.map((row) => (
    row.available_span_ms === null
      ? 'unknown'
      : row.available_span_ms < durationSeconds * 1000
        ? 'unfilled'
        : 'filled'
  ))
  report.case.measurement_window = {
    ...report.case.measurement_window,
    observed_buffer_state:
      observedBufferStates.length === 0
        ? 'unknown'
        : new Set(observedBufferStates).size === 1
          ? observedBufferStates[0]
          : 'mixed',
    observed_displays: readinessRows.map((row, index) => ({
      display_id: row.display_id,
      buffer_state: observedBufferStates[index],
      measured_available_span_ms: row.available_span_ms,
      expected_duration_ms:
        row.available_span_ms === null
          ? durationSeconds * 1000
          : Math.min(durationSeconds * 1000, row.available_span_ms),
    })),
  }
  const readyRows = [...mainLog.matchAll(
    /\[capture\] display ([^:]+): ([^ ]+) -> (replay\.(?:mp4|webm)), (\d+)x(\d+)/gu,
  )].map((match) => ({
    display_id: match[1],
    mime_type: match[2],
    replay_file: match[3],
    width: Number(match[4]),
    height: Number(match[5]),
  }))
  const cadenceRows = [...mainLog.matchAll(
    /\[capture\] display ([^:]+): recorded ([0-9.]+) fps of ([0-9.]+) requested, worst stall ([0-9.]+) ms(?:, ([0-9]+) frame\(s\) discarded)?/gu,
  )].map((match) => ({
    display_id: match[1],
    achieved_fps: Number(match[2]),
    requested_fps: Number(match[3]),
    worst_stall_ms: Number(match[4]),
    discarded_frames: match[5] === undefined ? null : Number(match[5]),
  }))
  const ringRows = [...mainLog.matchAll(
    /\[capture\] display ([^:]+): ring retained ([0-9]+) fragment\(s\), ([0-9]+) bytes \/ ([0-9.]+) ms; selected ([0-9]+) fragment\(s\)/gu,
  )].map((match) => ({
    display_id: match[1],
    retained_fragments: Number(match[2]),
    retained_bytes: Number(match[3]),
    retained_duration_ms: Number(match[4]),
    selected_fragments: Number(match[5]),
  }))
  report.recorder_runtime = {
    ready_displays: readyRows,
    ready_display_count: new Set(readyRows.map((row) => row.display_id)).size,
    cadence_log: cadenceRows,
    ring_diagnostics: {
      measured: ringRows.length > 0,
      displays: ringRows,
    },
    failures: mainLog
      .split(/\r?\n/u)
      .filter((line) => (
        line.includes('[capture]')
        && /failed|no video frames|not recording|missing time/iu.test(line)
      )),
    recorder_count: {
      measured: false,
      inferred_per_display:
        readyRows.length === 0
          ? null
          : readyRows.every((row) => row.replay_file.endsWith('.mp4'))
            ? 1
            : 2,
      basis:
        readyRows.length === 0
          ? 'unavailable'
          : 'production recorder format contract: fragmented MP4=1, WebM dual-slot=2',
    },
    capture_backend: {
      measured: false,
      value: null,
      reason: 'Electron getDisplayMedia does not expose DDA/WGC/GDI backend identity',
    },
  }
  report.process_metrics.retained_chunks_and_bytes =
    ringRows.length > 0
      ? { status: 'measured', displays: ringRows }
      : {
          status: 'unavailable',
          reason: 'the production recorder did not publish ring diagnostics',
        }

  const manifest = readJson(path.join(foundPack, 'manifest.json'))
  const displays = manifestDisplays(
    manifest,
    layout,
    resolvedTargetId === 'all' ? layout.cursor_display_id : resolvedTargetId,
  )
  const declaredBackends = [
    ...new Set(displays.flatMap((display) => {
      const value =
        display?.cadence?.backend
        ?? display?.capture_backend
        ?? manifest?.media?.capture_backend
      return typeof value === 'string' && value !== '' ? [value] : []
    })),
  ]
  if (declaredBackends.length > 0) {
    report.recorder_runtime.capture_backend = {
      measured: true,
      value: declaredBackends,
      basis: 'persisted manifest cadence/backend declaration',
    }
  }
  const declaredRecorderCounts = displays.flatMap((display) => {
    const value = display?.cadence?.recorder_count
    return Number.isInteger(value) && value > 0 ? [value] : []
  })
  if (declaredRecorderCounts.length > 0) {
    report.recorder_runtime.recorder_count = {
      measured: true,
      per_display: displays.map((display) => ({
        display: display.index,
        recorder_count: display?.cadence?.recorder_count ?? null,
      })),
      basis: 'persisted recorder self-report',
    }
  }
  const probes = []
  for (const display of displays) {
    probes.push(await probeReplay(foundPack, display))
  }
  writeJsonAtomic(framePtsPath, {
    displays: probes.map((probe) => ({
      display: probe.display,
      file: probe.file,
      pts_ms: probe.frames_ms,
    })),
  })
  const nominalMs = 1000 / fps
  const durationFillToleranceMs = Math.max(
    nominalMs * 3,
    Math.min(3_000, durationSeconds * 1000 * 0.02),
  )
  report.media = probes.map((probe) => {
    const display = displays.find((item) => item.index === probe.display)
    const cadence = display?.cadence
    const runtimeDisplayIndex = fixtureDisplayIndexForPackDisplay({
      display,
      displays,
      layout,
      resolvedTargetId,
    })
    const runtimeFixtureDisplay = layout.displays.find(
      (item) => item.index === runtimeDisplayIndex,
    )
    const runtimeCadence = cadenceRows.find(
      (row) => row.display_id === String(runtimeDisplayIndex),
    )
    const runtimeReadiness = readinessRows.find(
      (row) => row.display_id === String(runtimeFixtureDisplay?.id),
    )
    const manifestDifference =
      typeof cadence?.achieved_fps === 'number' && probe.achieved_fps !== null
        ? probe.achieved_fps - cadence.achieved_fps
        : null
    const runtimeDifference =
      runtimeCadence !== undefined && probe.achieved_fps !== null
        ? probe.achieved_fps - runtimeCadence.achieved_fps
        : null
    const durationExpectation = durationVerdict({
      requestedRetentionMs: durationSeconds * 1000,
      measuredAvailableSpanMs: runtimeReadiness?.available_span_ms ?? null,
      actualDurationMs: probe.duration_ms,
      nominalFrameIntervalMs: nominalMs,
      fillToleranceMs: durationFillToleranceMs,
    })
    return {
      display: probe.display,
      fixture_display_index: runtimeDisplayIndex,
      fixture_display_id: runtimeFixtureDisplay?.id ?? null,
      file: probe.file,
      absolute_path: probe.absolute_path,
      present: probe.present,
      bytes: probe.bytes,
      codec: probe.codec,
      size: { width: probe.width, height: probe.height },
      requested_fps: fps,
      frame_count: probe.frame_count,
      decoded_frame_hash_count: probe.decoded_frame_hash_count,
      unique_decoded_frame_hashes: probe.unique_decoded_frame_hashes,
      changed_decoded_frame_pairs: probe.changed_decoded_frame_pairs,
      decoded_frame_change_ratio: probe.decoded_frame_change_ratio,
      achieved_fps: probe.achieved_fps,
      max_pts_gap_ms: probe.max_pts_gap_ms,
      max_pts_gap_start_ms: probe.max_pts_gap_start_ms,
      max_pts_gap_end_ms: probe.max_pts_gap_end_ms,
      max_pts_gap_is_startup: probe.max_pts_gap_is_startup,
      max_pts_gap_after_first_1s_ms: probe.max_pts_gap_after_first_1s_ms,
      max_pts_gap_after_first_1s_start_ms: probe.max_pts_gap_after_first_1s_start_ms,
      max_pts_gap_after_first_1s_end_ms: probe.max_pts_gap_after_first_1s_end_ms,
      pts_gap_ms: probe.pts_gap_ms,
      nominal_frame_interval_ms: nominalMs,
      duration_ms: probe.duration_ms,
      probe_ok: probe.probe_ok,
      full_decode_ok: probe.decode_ok,
      full_decode_timed_out: probe.decode_timed_out,
      manifest_cadence:
        cadence === undefined
          ? { status: 'missing' }
          : {
              status: 'declared',
              achieved_fps: cadence.achieved_fps ?? null,
              worst_stall_ms: cadence.worst_stall_ms ?? null,
              discarded_frames: cadence.discarded_frames ?? null,
              requested_fps: cadence.requested_fps ?? null,
              backend: cadence.backend ?? null,
              quality: cadence.quality ?? null,
              recorder_count: cadence.recorder_count ?? null,
              achieved_difference_fps: manifestDifference,
              achieved_difference_percent:
                manifestDifference === null || cadence.achieved_fps === 0
                  ? null
                  : (manifestDifference / cadence.achieved_fps) * 100,
            },
      runtime_cadence:
        runtimeCadence === undefined
          ? { status: 'missing' }
          : {
              status: 'logged',
              ...runtimeCadence,
              achieved_difference_fps: runtimeDifference,
              achieved_difference_percent:
                runtimeDifference === null || runtimeCadence.achieved_fps === 0
                  ? null
                  : (runtimeDifference / runtimeCadence.achieved_fps) * 100,
            },
      duration_expectation: {
        ...durationExpectation,
        recorder_ready_at: runtimeReadiness?.ready_at ?? null,
        capture_requested_at: recorderAvailability.capture_requested_at,
      },
      criteria: {
        fps_within_20_percent:
          probe.achieved_fps !== null
          && probe.achieved_fps >= fps * 0.8
          && probe.achieved_fps <= fps * 1.2,
        max_gap_within_three_intervals:
          probe.max_pts_gap_ms !== null && probe.max_pts_gap_ms <= nominalMs * 3,
        steady_state_max_gap_within_three_intervals:
          probe.max_pts_gap_after_first_1s_ms !== null
          && probe.max_pts_gap_after_first_1s_ms <= nominalMs * 3,
        moving_fixture_pixels_change:
          probe.decoded_frame_hash_count === probe.frame_count
          && probe.decoded_frame_change_ratio !== null
          && probe.decoded_frame_change_ratio >= 0.8,
        duration_within_requested_window:
          durationExpectation.duration_within_requested_window,
        duration_fills_requested_window:
          durationExpectation.fills_requested_window,
        duration_matches_expected_window:
          durationExpectation.matches_expected_duration,
        duration_buffer_state: durationExpectation.buffer_state,
        duration_verdict_pass: durationExpectation.pass,
        duration_fill_tolerance_ms: durationFillToleranceMs,
        manifest_cadence_present: cadence !== undefined,
        manifest_not_contradictory:
          manifestDifference === null
          || Math.abs(manifestDifference) <= Math.max(0.5, fps * 0.2),
        runtime_cadence_not_contradictory:
          runtimeDifference === null
          || Math.abs(runtimeDifference) <= Math.max(0.5, fps * 0.2),
      },
      error: probe.error,
    }
  })

  setStage('past-sampling', 'decoding persisted timeline through production codec/session')
  if (!existsSync(contextPath)) {
    report.past_sampling = {
      status: 'missing',
      pass: false,
      reason: 'plugins/windows-context/timeline.json was not persisted inside the bound',
    }
  } else {
    const contextValue = readJson(contextPath)
    const contextRange = contextValue?.range
    const queryTimes =
      typeof contextRange?.start_ms === 'number' && typeof contextRange?.end_ms === 'number'
        ? [...new Set([
            Math.round(contextRange.start_ms),
            Math.round(contextRange.start_ms + (contextRange.end_ms - contextRange.start_ms) * 0.25),
            Math.round(contextRange.start_ms + (contextRange.end_ms - contextRange.start_ms) * 0.5),
            Math.round(contextRange.start_ms + (contextRange.end_ms - contextRange.start_ms) * 0.75),
            Math.round(contextRange.end_ms),
          ])]
        : [0, Math.round(durationSeconds * 500), durationSeconds * 1000]
    const contextDisplays = displays.map((display) => {
      const snapshotPath = safePackFile(foundPack, display.snapshot)
      const size = snapshotPath === null ? null : pngSize(snapshotPath)
      return {
        index: display.index,
        focused: display.focused === true,
        width: size?.width ?? Math.max(1, Math.round((display.bounds?.width ?? 1) * (display.scale ?? 1))),
        height: size?.height ?? Math.max(1, Math.round((display.bounds?.height ?? 1) * (display.scale ?? 1))),
        snapshotPixelsPerDip:
          typeof display.scale === 'number' && display.scale > 0
            ? display.scale
            : undefined,
      }
    })
    const focusedContextDisplay =
      contextDisplays.find((display) => display.focused) ?? contextDisplays[0]
    const helper = await loadPastHelper()
    const pastSamplingInput = {
      value: contextValue,
      displays: contextDisplays,
      displayOffsets: displays.map((display) => ({
        display: display.index,
        replayClockOffsetMs: Number(display.replay_clock_offset_ms ?? 0),
      })),
      replayDurationMs:
        typeof manifest.media?.replay_duration_ms === 'number'
          ? manifest.media.replay_duration_ms
          : durationSeconds * 1000,
      targetTitle: layout.target_title,
      queryTimesMs: queryTimes,
      reopen: {
        snapshotWidth: focusedContextDisplay?.width ?? 1,
        snapshotHeight: focusedContextDisplay?.height ?? 1,
        screens: manifest.environment.screens,
        displays: manifest.media.displays,
        loadedDisplays: contextDisplays.map((display) => ({
          index: display.index,
          focused: display.focused,
          width: display.width,
          height: display.height,
          scale: display.snapshotPixelsPerDip ?? 1,
        })),
      },
    }
    const analysis = await helper.analyzePastSampling(pastSamplingInput)
    const movements = movementRows()
    const timelineFile = existsSync(path.join(foundPack, 'timeline.json'))
      ? readJson(path.join(foundPack, 'timeline.json'))
      : null
    const timelineOriginMs = Date.parse(timelineFile?.t0 ?? '')
    const visualGroundTruth = new Map()
    for (const query of analysis.queries) {
      const samples = []
      for (const contextDisplay of contextDisplays) {
        const display = displays.find((item) => item.index === contextDisplay.index)
        const probe = probes.find((item) => item.display === contextDisplay.index)
        const mediaTime =
          query.requested_t_ms + Number(display?.replay_clock_offset_ms ?? 0)
        const nearestFramePts =
          probe === undefined ? null : nearestNumber(probe.frames_ms, mediaTime)
        if (probe === undefined || nearestFramePts === null) {
          samples.push({
            display: contextDisplay.index,
            context_t_ms: query.requested_t_ms,
            media_t_ms: mediaTime,
            nearest_frame_pts_ms: nearestFramePts,
            signed_frame_distance_ms: null,
            absolute_frame_distance_ms: null,
            bounds: null,
            mask_pixels: 0,
            decode_error: 'encoded frame PTS unavailable',
          })
          continue
        }
        setStage(
          'past-sampling',
          `decoding display ${String(contextDisplay.index)} at ${nearestFramePts.toFixed(3)}ms`,
        )
        const detected = await detectFixtureTargetBounds(
          probe,
          nearestFramePts,
          contextDisplay,
        )
        samples.push({
          display: contextDisplay.index,
          context_t_ms: query.requested_t_ms,
          media_t_ms: mediaTime,
          nearest_frame_pts_ms: nearestFramePts,
          signed_frame_distance_ms: nearestFramePts - mediaTime,
          absolute_frame_distance_ms: Math.abs(nearestFramePts - mediaTime),
          bounds: detected.bounds,
          mask_pixels: detected.mask_pixels,
          matched_pixels: detected.matched_pixels ?? detected.mask_pixels,
          component_count: detected.component_count ?? null,
          decode_error: detected.error,
        })
      }
      visualGroundTruth.set(query, samples)
    }
    const visualPickPoints = analysis.queries.flatMap((query) =>
      (visualGroundTruth.get(query) ?? []).flatMap((sample) => {
        if (sample.decode_error !== null || sample.bounds === null) return []
        const bounds = sample.bounds
        const inset = Math.max(
          2,
          Math.min(12, Math.floor(Math.min(bounds.width, bounds.height) / 4)),
        )
        return [
          {
            requestedTimeMs: query.requested_t_ms,
            display: sample.display,
            x: bounds.x + bounds.width / 2,
            y: bounds.y + bounds.height / 2,
            label: 'decoded-center',
          },
          {
            requestedTimeMs: query.requested_t_ms,
            display: sample.display,
            x: bounds.x + inset,
            y: bounds.y + inset,
            label: 'decoded-top-left-inset',
          },
          {
            requestedTimeMs: query.requested_t_ms,
            display: sample.display,
            x: bounds.x + bounds.width - inset,
            y: bounds.y + inset,
            label: 'decoded-top-right-inset',
          },
          {
            requestedTimeMs: query.requested_t_ms,
            display: sample.display,
            x: bounds.x + inset,
            y: bounds.y + bounds.height - inset,
            label: 'decoded-bottom-left-inset',
          },
          {
            requestedTimeMs: query.requested_t_ms,
            display: sample.display,
            x: bounds.x + bounds.width - inset,
            y: bounds.y + bounds.height - inset,
            label: 'decoded-bottom-right-inset',
          },
        ]
      }))
    const visualPickAnalysis = await helper.analyzePastSampling({
      ...pastSamplingInput,
      pickPoints: visualPickPoints,
    })
    const visualPickQueries = new Map(
      visualPickAnalysis.queries.map((query) => [query.requested_t_ms, query]),
    )

    const coordinateErrors = []
    const temporalLagSamples = []
    const sourceLatencySamples = []
    const queries = analysis.queries.map((query) => {
      const wallTimeMs =
        Number.isFinite(timelineOriginMs)
          ? timelineOriginMs + query.requested_t_ms
          : null
      const expectedAt =
        wallTimeMs === null ? null : nearestMovement(movements, wallTimeMs)
      const visualSamples = visualGroundTruth.get(query) ?? []
      const expected = visualSamples.flatMap((sample) =>
        sample.decode_error === null && sample.bounds !== null
          ? [{
              display_index: sample.display,
              bounds_snapshot: sample.bounds,
              frame_pts_ms: sample.nearest_frame_pts_ms,
              mask_pixels: sample.mask_pixels,
            }]
          : [])
      const visualDecodeOk =
        visualSamples.length === contextDisplays.length
        && visualSamples.every((sample) => sample.decode_error === null)
      const comparisons = query.observed_windows.map((observed) => {
        const matching = expected.find((item) => item.display_index === observed.display)
        const packDisplay = displays.find((item) => item.index === observed.display)
        const fixtureDisplayIndex = fixtureDisplayIndexForPackDisplay({
          display: packDisplay,
          displays,
          layout,
          resolvedTargetId,
        })
        const error = matching === undefined
          ? null
          : rectError(observed.bounds, matching.bounds_snapshot)
        if (error !== null) coordinateErrors.push(error)
        const temporalLag = matching === undefined || fixtureDisplayIndex === null
          ? {
              status: 'unavailable',
              signed_lag_ms: null,
              absolute_lag_ms: null,
              sign: 'unknown',
              uncertainty_ms: null,
              confidence: 'none',
              confidence_score: 0,
              reason:
                matching === undefined
                  ? 'decoded replay target pixels are unavailable for this display'
                  : 'pack display could not be mapped to the physical fixture display',
            }
          : inferTemporalLagSample({
              rows: movements,
              displayIndex: fixtureDisplayIndex,
              pixelBounds: matching.bounds_snapshot,
              observedBounds: observed.bounds,
              observedContextTimeMs: observed.t_ms,
              timelineOriginMs,
              nominalFrameIntervalMs: 1000 / fps,
            })
        temporalLagSamples.push({
          display: observed.display,
          fixture_display_index: fixtureDisplayIndex,
          context_query_t_ms: query.requested_t_ms,
          materialized_context_t_ms: query.materialized_t_ms,
          encoded_frame_pts_ms: matching?.frame_pts_ms ?? null,
          ...temporalLag,
        })
        const sourceLatency = inferSourceLatencySample({
          timelineOriginMs,
          encodedFramePtsMs: matching?.frame_pts_ms ?? null,
          pixelMatch: temporalLag.pixel_match,
        })
        sourceLatencySamples.push({
          display: observed.display,
          fixture_display_index: fixtureDisplayIndex,
          context_query_t_ms: query.requested_t_ms,
          materialized_context_t_ms: query.materialized_t_ms,
          encoded_frame_pts_ms: matching?.frame_pts_ms ?? null,
          ...sourceLatency,
        })
        return {
          display: observed.display,
          observed_bounds: observed.bounds,
          observed_context_t_ms: observed.t_ms,
          expected_bounds: matching?.bounds_snapshot ?? null,
          expected_frame_pts_ms: matching?.frame_pts_ms ?? null,
          expected_mask_pixels: matching?.mask_pixels ?? 0,
          edge_error_px: error,
          temporal_lag: temporalLag,
          source_latency: sourceLatency,
        }
      })
      const frameDistances = query.observed_windows.flatMap((observed) => {
        const display = displays.find((item) => item.index === observed.display)
        const probe = probes.find((item) => item.display === observed.display)
        if (probe === undefined || probe.frames_ms.length === 0) return []
        const mediaTime =
          query.materialized_t_ms + Number(display?.replay_clock_offset_ms ?? 0)
        const nearest = nearestNumber(probe.frames_ms, mediaTime)
        return nearest === null
          ? []
          : [{
              display: observed.display,
              context_t_ms: query.materialized_t_ms,
              media_t_ms: mediaTime,
              nearest_frame_pts_ms: nearest,
              signed_distance_ms: nearest - mediaTime,
              absolute_distance_ms: Math.abs(nearest - mediaTime),
            }]
      })
      const displayClockQueries = query.display_queries.map((clock) => {
        const probe = probes.find((item) => item.display === clock.display)
        const nearest =
          probe === undefined
            ? null
            : nearestNumber(probe.frames_ms, clock.presented_media_t_ms)
        return {
          ...clock,
          nearest_encoded_frame_pts_ms: nearest,
          signed_frame_distance_ms:
            nearest === null ? null : nearest - clock.presented_media_t_ms,
          absolute_frame_distance_ms:
            nearest === null ? null : Math.abs(nearest - clock.presented_media_t_ms),
        }
      })
      const visualPickQuery = visualPickQueries.get(query.requested_t_ms)
      return {
        ...query,
        picks: visualPickQuery?.picks ?? [],
        visual_pick_expected_count: visualSamples.filter(
          (sample) => sample.decode_error === null && sample.bounds !== null,
        ).length * 5,
        visual_pick_source:
          'five points inside decoded replay target pixels at the requested pack time',
        display_queries: displayClockQueries,
        expected_presence_matches:
          visualDecodeOk
          && expected.length === query.observed_windows.length
          && query.candidates.length === query.observed_windows.length,
        expected_movement_sample_delta_ms: expectedAt?.delta_ms ?? null,
        visual_ground_truth: visualSamples,
        coordinate_comparisons: comparisons,
        encoded_frame_distance: frameDistances,
      }
    })

    const clockSigned = []
    const clockAbsolute = []
    for (const sample of analysis.target_samples) {
      const display = displays.find((item) => item.index === sample.display)
      const probe = probes.find((item) => item.display === sample.display)
      if (probe === undefined || probe.frames_ms.length === 0) continue
      const mediaTime = sample.t_ms + Number(display?.replay_clock_offset_ms ?? 0)
      const nearest = nearestNumber(probe.frames_ms, mediaTime)
      if (nearest === null) continue
      const signed = nearest - mediaTime
      clockSigned.push(signed)
      clockAbsolute.push(Math.abs(signed))
    }
    const resolvedQueries = queries.filter((query) => (
      query.coverage === 'covered'
      && query.nearest_sample_unchanged
      && !query.interpolated
      && query.expected_presence_matches
      && query.picks.length === query.visual_pick_expected_count
      && query.picks.every((pick) => pick.picked_target)
    ))
    const pass =
      analysis.status === 'loaded'
      && analysis.reopen_identical
      && queries.length >= 3
      && resolvedQueries.length === queries.length
      && coordinateErrors.length > 0
      && Math.max(...coordinateErrors) <= COORDINATE_EDGE_ERROR_LIMIT_PX
    report.past_sampling = {
      status: analysis.status,
      pass,
      timeline_file: contextPath,
      timeline_origin: Number.isFinite(timelineOriginMs)
        ? new Date(timelineOriginMs).toISOString()
        : null,
      range: analysis.range,
      observation_count: analysis.observation_count,
      target_sample_count: analysis.target_samples.length,
      query_count: queries.length,
      covered_query_count: resolvedQueries.length,
      no_interpolation: queries.every((query) => (
        !query.interpolated && query.nearest_sample_unchanged
      )),
      actual_object_pick: {
        ...actualObjectPickVerdict(queries),
        basis:
          'production ObjectIndex.pick at the center and four inset corners of decoded replay target pixels',
      },
      reopen_identical: analysis.reopen_identical,
      queries,
      visual_ground_truth_decode_ok: queries.every((query) =>
        query.visual_ground_truth.every((sample) => sample.decode_error === null)),
      coordinate_reference:
        'decoded replay frame magenta fixture pixels at the requested pack time',
      expected_coordinate_edge_error_px: distribution(coordinateErrors),
      coordinate_edge_error_limit_px: COORDINATE_EDGE_ERROR_LIMIT_PX,
      coordinate_error_within_limit:
        coordinateErrors.length > 0
        && Math.max(...coordinateErrors) <= COORDINATE_EDGE_ERROR_LIMIT_PX,
      temporal_lag: {
        status:
          temporalLagSamples.some((sample) => sample.status === 'measured')
            ? 'measured'
            : 'unavailable',
        basis:
          'decoded replay magenta bounds and the exact persisted context sample bounds are independently reverse-matched to the fixture movement clock',
        sign_convention:
          'signed_lag_ms = inferred replay pixel wall time - inferred observed context wall time; negative means replay pixels are older',
        ambiguity_policy:
          'static motion, no coordinate match, or multiple equally good time clusters produce no inferred lag',
        search_radius:
          `max(${TEMPORAL_LAG_MIN_SEARCH_RADIUS_MS}ms, ` +
          `${TEMPORAL_LAG_FRAME_SEARCH_MULTIPLIER} nominal frame intervals)`,
        samples: temporalLagSamples,
        displays: contextDisplays.map((display) =>
          summarizeTemporalLag(display.index, temporalLagSamples, 1000 / fps)),
      },
      source_latency: {
        status:
          sourceLatencySamples.some((sample) => sample.status === 'measured')
            ? 'measured'
            : sourceLatencySamples.some((sample) => sample.status === 'ambiguous')
              ? 'ambiguous'
              : sourceLatencySamples.some((sample) => sample.status === 'static')
                ? 'static'
                : 'unavailable',
        basis:
          'encoded frame nominal wall time (timeline origin + encoded PTS) minus the independently reverse-matched replay pixel wall time; context query time and nearest-frame distance are not inputs',
        sign_convention:
          'source_latency_ms = timeline origin + encoded frame PTS - inferred replay pixel wall time; positive means source pixels are older than the encoded PTS clock',
        ambiguity_policy:
          'static motion, no coordinate match, or multiple equally good pixel-time clusters remain unmeasured',
        samples: sourceLatencySamples,
        displays: contextDisplays.map((display) =>
          summarizeSourceLatency(display.index, sourceLatencySamples, 1000 / fps)),
      },
      context_to_encoded_frame_ms: {
        signed: distribution(clockSigned),
        absolute: distribution(clockAbsolute),
      },
    }
  }

  const mediaPass =
    report.media.length === displays.length
    && displays.length === (resolvedTargetId === 'all' ? layout.displays.length : 1)
    && report.media.length > 0
    && report.media.every((media) => (
      media.present
      && media.probe_ok
      && media.full_decode_ok
      && media.criteria.fps_within_20_percent
      && media.criteria.max_gap_within_three_intervals
      && media.criteria.moving_fixture_pixels_change
      && media.criteria.duration_within_requested_window
      && media.criteria.duration_verdict_pass
      && media.criteria.manifest_cadence_present
      && media.criteria.manifest_not_contradictory
      && media.criteria.runtime_cadence_not_contradictory
    ))
  report.checks = {
    pack_saved: report.artifacts.pack !== null,
    requested_display_count:
      resolvedTargetId === 'all' ? layout.displays.length : 1,
    saved_display_count: displays.length,
    saved_display_count_matches_request:
      displays.length === (resolvedTargetId === 'all' ? layout.displays.length : 1),
    replay_file_count: report.media.length,
    every_replay_probes_decodes_and_meets_cadence: mediaPass,
    past_sampling: report.past_sampling?.pass === true,
    every_spawned_process_terminated: false,
  }
  if (!mediaPass) report.failures.push('one or more replay media criteria failed')
  if (report.past_sampling?.pass !== true) {
    report.failures.push('persisted past sampling/reopen verification failed')
  }
  report.result = report.failures.length === 0 ? 'OK' : 'BROKEN'
} catch (error) {
  report.failures.push(error instanceof Error ? error.stack ?? error.message : String(error))
  report.result = 'BROKEN'
} finally {
  setStage('cleanup', 'terminating every spawned process')
  try {
    if (fixture !== null && !existsSync(fixtureStopPath)) {
      writeFileSync(fixtureStopPath, 'stop\n', 'utf8')
      await waitFor(
        () => fixture.exitCode !== null || fixture.signalCode !== null,
        3000,
      )
    }
  } catch {
    // The process-tree kill below is the final authority.
  }
  await stopAllTracked()
  fixtureStdout?.end()
  fixtureStderr?.end()
  appStdout?.end()
  appStderr?.end()
  report.checks.every_spawned_process_terminated = tracked.size === 0
  if (!report.checks.every_spawned_process_terminated) {
    report.failures.push('one or more spawned processes survived cleanup')
    report.result = 'BROKEN'
  }
  report.finished_at = new Date().toISOString()
  writeJsonAtomic(reportPath, report)
  setStage('done', `${report.result}; report=${reportPath}`)
}

console.log(
  `\nresult: ${report.result} — ${report.failures.length} failure(s)\n` +
  `report: ${reportPath}\n` +
  `pack: ${String(report.artifacts.pack)}\n`,
)
if (report.result !== 'OK') process.exitCode = 1
