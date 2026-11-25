import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  NativeReplayFallbackManager,
  NativeReplayFrameParser,
  nativeFallbackArguments,
  nativeFallbackDisplayRefusal,
  nativeFallbackRefusal,
  NATIVE_REPLAY_TOPOLOGY_SETTLE_MS,
  nativeFallbackFps,
  nativeFallbackRequestedFps,
  nativeReplayHelperPath,
  NATIVE_REPLAY_MAX_LONG_EDGE,
  type NativeReplayFrame,
  type NativeReplayStartResult,
} from '../src/main/nativeReplayFallback'
import { buildManifest } from '../src/main/exporter'
import {
  APP_PRIORITY_CEILING,
  HELPER_PRIORITY,
  capProcessesAtNormal,
  lowerHelperPriority,
  type PriorityPort,
} from '../src/main/processPriority'
import { NativeFallbackStartupErrors } from '../src/renderer/capture/nativeFallbackStartup'
import {
  NativeFrameClock,
  NativePresentationQueue,
} from '../src/renderer/capture/nativePresentation'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) passed += 1
  else failed += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

async function main(): Promise<void> {
const displays = [
  {
    id: 11,
    bounds: { x: -1200, y: -480, width: 1200, height: 1920 },
    size: { width: 1200, height: 1920 },
    scaleFactor: 1,
  },
  {
    id: 22,
    bounds: { x: 0, y: 0, width: 2560, height: 1440 },
    size: { width: 2560, height: 1440 },
    scaleFactor: 1.5,
  },
  {
    id: 33,
    bounds: { x: 2560, y: 180, width: 1920, height: 1080 },
    size: { width: 1920, height: 1080 },
    scaleFactor: 1.25,
  },
] as const

console.log('\nNative display routing')
check('fallback never exceeds its honest degraded 5fps ceiling', nativeFallbackFps(30) === 5)
check('legacy 1fps requests migrate to the supported 5fps floor', nativeFallbackFps(1) === 5)
check('non-finite IPC requests fall back to the supported 5fps floor', nativeFallbackFps(NaN) === 5)
check(
  'returned request provenance uses the supported-rate clamp',
  nativeFallbackRequestedFps(1) === 5 &&
    nativeFallbackRequestedFps(15) === 15 &&
    nativeFallbackRequestedFps(60) === 60 &&
    nativeFallbackRequestedFps(61) === 60 &&
    nativeFallbackRequestedFps(NaN) === 5,
)
const nativeHelperSource = readFileSync(
  path.join(process.cwd(), 'scripts/native-replay-capture.cs'),
  'utf8',
)
check(
  'the direct native helper CLI also rejects rates below 5fps',
  /Math\.Max\(5,\s*Math\.Min\(30,/u.test(nativeHelperSource),
)
const args = nativeFallbackArguments({
  display: displays[1] as never,
  nativeBounds: { x: 0, y: 0, width: 3840, height: 2160 },
  requestedFps: 30,
  width: 1280,
  height: 720,
})
check(
  'helper receives native geometry for mixed-DPI identity validation',
  args.includes('--left') &&
    args.includes('3840') &&
    args.includes('2160') &&
    !args.includes('--monitor-index'),
  args.join(' '),
)
const capped4k = nativeFallbackArguments({
  display: displays[1] as never,
  nativeBounds: { x: 0, y: 0, width: 3840, height: 2160 },
  requestedFps: 15,
  width: 1920,
  height: 1080,
})
check(
  'degraded 4K fallback preserves aspect while bounding JPEG cost',
  Number(capped4k[capped4k.indexOf('--width') + 1]) ===
    NATIVE_REPLAY_MAX_LONG_EDGE &&
    Number(capped4k[capped4k.indexOf('--height') + 1]) === 720,
  capped4k.join(' '),
)
check(
  'packaged helper resolves through app.asar.unpacked before spawn',
  nativeReplayHelperPath(
    path.join('C:', 'Program Files', 'CapturePack', 'resources', 'app.asar', 'dist', 'scripts', 'missing.exe'),
  ) === null &&
    readFileSync(
      path.join(process.cwd(), 'src', 'main', 'nativeReplayFallback.ts'),
      'utf8',
    ).includes('app.asar.unpacked'),
)

console.log('\nNative fallback refusal and monitor identity')
{
  const portrait = { size: { width: 1200, height: 1920 }, scaleFactor: 1, displayFrequency: 60 }
  check(
    'a 4K display (2560x1440 DIP at 150%) never falls back to windows-gdi-bitblt',
    nativeFallbackDisplayRefusal({ size: { width: 2560, height: 1440 }, scaleFactor: 1.5, displayFrequency: 60 }) !== null,
  )
  check(
    'a 240 Hz display never falls back to windows-gdi-bitblt',
    nativeFallbackDisplayRefusal({ size: { width: 1920, height: 1080 }, scaleFactor: 1, displayFrequency: 240 }) !== null,
  )
  check(
    'a 60 Hz 1200x1920 portrait display keeps the degraded fallback',
    nativeFallbackDisplayRefusal(portrait) === null,
  )
  check(
    'a fallback requested while the display topology is still settling is refused',
    nativeFallbackRefusal(portrait, 100_000, 98_700) !== null &&
      nativeFallbackRefusal(portrait, 100_000, 100_000 - NATIVE_REPLAY_TOPOLOGY_SETTLE_MS) === null &&
      nativeFallbackRefusal(portrait, 100_000, null) === null,
  )
  const labelled = nativeFallbackArguments({
    display: { ...displays[0], label: ' DELL U2412M ' } as never,
    nativeBounds: { x: 0, y: 0, width: 1200, height: 1920 },
    requestedFps: 15,
    width: 1200,
    height: 1920,
  })
  const unlabelled = nativeFallbackArguments({
    display: { ...displays[0], label: '' } as never,
    nativeBounds: { x: -1200, y: 0, width: 1200, height: 1920 },
    requestedFps: 15,
    width: 1200,
    height: 1920,
  })
  check(
    'the helper receives the monitor label as a second identity key',
    labelled[labelled.indexOf('--label') + 1] === 'DELL U2412M' && !unlabelled.includes('--label'),
    labelled.join(' '),
  )
  check(
    'the helper falls back to a unique label and native size only after the rect misses',
    /resolvedBy = "label"/u.test(nativeHelperSource) &&
      /string\.Equals\(candidate\.Label, expectedLabel, StringComparison\.Ordinal\)/u.test(nativeHelperSource) &&
      /if \(matches\.Count != 1 && expectedLabel\.Length > 0\)/u.test(nativeHelperSource),
  )
  const mainCapture = readFileSync(path.join(process.cwd(), 'src', 'main', 'capture.ts'), 'utf8')
  const rendererCapture = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'capture', 'capture.ts'), 'utf8')
  check(
    'main refuses a fallback transition before spawning the helper and records topology changes',
    mainCapture.indexOf('nativeFallbackRefusal(display, fallbackStartedAtMs, lastTopologyChangeAtMs)') > 0 &&
      mainCapture.indexOf('nativeFallbackRefusal(display, fallbackStartedAtMs, lastTopologyChangeAtMs)') <
        mainCapture.indexOf('await nativeReplayFallback.start(') &&
      mainCapture.includes('lastTopologyChangeAtMs = Date.now()'),
  )
  check(
    'a recorder whose display refuses the fallback fails terminally instead of tearing down into windows-gdi-bitblt',
    rendererCapture.indexOf('payload.nativeFallbackAllowed === false') > 0 &&
      rendererCapture.indexOf('payload.nativeFallbackAllowed === false') <
        rendererCapture.indexOf('switching this display to windows-gdi-bitblt for the rest of the session'),
  )
}

console.log('\nBounded native frame protocol')
{
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  const bytes = Buffer.alloc(56 + jpeg.length)
  bytes.write('CPRF', 0, 'ascii')
  bytes.writeUInt32LE(2, 4)
  bytes.writeBigInt64LE(7n, 8)
  bytes.writeBigInt64LE(98_765n, 16)
  bytes.writeBigInt64LE(10_000_000n, 24)
  bytes.writeBigInt64LE(1_785_000_000_000n, 32)
  bytes.writeInt32LE(640, 40)
  bytes.writeInt32LE(360, 44)
  bytes.writeInt32LE(jpeg.length, 48)
  bytes.writeInt32LE(0, 52)
  jpeg.copy(bytes, 56)
  const parser = new NativeReplayFrameParser()
  check('a split header is retained without inventing a frame', parser.push(bytes.subarray(0, 13)).length === 0)
  const frames = parser.push(bytes.subarray(13))
  check(
    'one complete frame preserves sequence, timestamp, size and JPEG',
    frames.length === 1 &&
      frames[0]?.sequence === 7 &&
      frames[0]?.clockProvenance === 'windows-qpc' &&
      frames[0]?.capturedQpc === 98_765 &&
      frames[0]?.qpcFrequency === 10_000_000 &&
      frames[0]?.capturedAtMs === 1_785_000_000_000 &&
      frames[0]?.width === 640 &&
      frames[0]?.jpeg.equals(jpeg) === true,
  )
}

console.log('\nNative startup and presentation races')
{
  const startup = new NativeFallbackStartupErrors()
  const firstToken = startup.begin()
  check(
    'an error that overtakes the invoke reply is retained by session',
    startup.observe({ sessionId: 'session-a', message: 'early exit' }) &&
      startup.consume(firstToken, 'session-a') === 'early exit',
  )
  const staleToken = startup.begin()
  const currentToken = startup.begin()
  startup.cancel(staleToken)
  check(
    'a stale start cancellation cannot clear the replacement start',
    startup.observe({ sessionId: 'session-b', message: 'replacement exit' }) &&
      startup.consume(currentToken, 'session-b') === 'replacement exit',
  )
  check(
    'an error outside an outstanding start is not retained',
    !startup.observe({ sessionId: 'stale', message: 'ignore' }),
  )

  const presentations = new NativePresentationQueue<string>(3)
  presentations.push(100, 'frame-1')
  presentations.push(120, 'frame-2')
  presentations.push(140, 'frame-3')
  check(
    'an ambiguous delayed callback never guesses between two requested frames',
    presentations.take(125, 1) === null &&
      presentations.stats().ambiguousDropped === 2,
  )
  check(
    'a delayed callback never steals metadata from a future request',
    presentations.take(135, 1) === null &&
      presentations.take(145, 1) === 'frame-3',
  )
  presentations.push(160, 'frame-4')
  presentations.push(180, 'frame-5')
  check(
    'presentedFrames delta identifies the latest frame after two exact presentations',
    presentations.take(190, 2) === 'frame-5' &&
      presentations.stats().unreportedPresented === 1,
  )
  presentations.push(200, 'frame-6')
  presentations.push(220, 'frame-7')
  presentations.push(240, 'frame-8')
  presentations.push(260, 'frame-9')
  check(
    'presentation association remains bounded and reports capacity loss',
    presentations.stats().retained === 3 &&
      presentations.stats().capacityDropped === 1,
  )

  const clock = new NativeFrameClock()
  const firstCaptured = clock.map({
    sessionId: 'session-qpc',
    capturedQpc: 10_000_000,
    qpcFrequency: 10_000_000,
    capturedAtMs: 1_785_000_060_000,
  }, -60_000)
  const afterWallStep = clock.map({
    sessionId: 'session-qpc',
    capturedQpc: 12_000_000,
    qpcFrequency: 10_000_000,
    capturedAtMs: 1_785_120_000_200,
  })
  check(
    'renderer wall offset anchors QPC across pre- and post-anchor clock steps',
    firstCaptured === 1_785_000_000_000 &&
      afterWallStep === 1_785_000_000_200,
  )
}

console.log('\nProduction circuit breaker')
{
  const renderer = readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'capture', 'capture.ts'),
    'utf8',
  )
  check(
    'no-frame evidence enters the native fallback rather than retrying getDisplayMedia',
    renderer.includes('startNativeFallbackCapture(payload, generation)') &&
      !renderer.includes('void startCapture(payload)\\n  }, RETRY_DELAY_MS'),
  )
  check(
    'once fallback is active a second failure is terminal instead of flapping primary',
    renderer.includes("captureBackend === 'windows-gdi-bitblt'") &&
      renderer.includes('nativeFallbackCircuitOpen'),
  )
  check(
    'the GDI fallback retries the primary source on a bounded backoff instead of latching for the session',
    renderer.includes('schedulePrimaryRetry(payload, generation)') &&
      renderer.includes('PRIMARY_RETRY_FIRST_MS = 60_000') &&
      renderer.includes('PRIMARY_RETRY_MAX_MS = 15 * 60_000') &&
      renderer.includes('primaryRetryDelayMs = Math.min(PRIMARY_RETRY_MAX_MS, delayMs * 2)') &&
      renderer.includes("captureBackend !== 'windows-gdi-bitblt'") &&
      renderer.includes('primaryRetryDelayMs = PRIMARY_RETRY_FIRST_MS'),
  )
  const helperSource = readFileSync(
    path.join(process.cwd(), 'scripts', 'native-replay-capture.cs'),
    'utf8',
  )
  check(
    'the GDI helper scales without HALFTONE and sleeps instead of spinning',
    helperSource.includes('SetStretchBltMode(dest, COLORONCOLOR)') &&
      !helperSource.includes('HALFTONE') &&
      !helperSource.includes('SpinWait'),
  )
  const fakePort = (initial: Record<number, number>): PriorityPort & { values: Record<number, number> } => {
    const values = { ...initial }
    return {
      values,
      get: (pid) => {
        if (!(pid in values)) throw new Error('gone')
        return values[pid]!
      },
      set: (pid, priority) => { values[pid] = priority },
    }
  }
  const apps = fakePort({ 1: -7, 2: 0, 3: 10, 4: -14 })
  const capped = capProcessesAtNormal([1, 2, 3, 4, 5], apps)
  check(
    'above-normal app processes are lowered to normal and lower ones are left alone',
    capped.join(',') === '1,4' &&
      apps.values[1] === APP_PRIORITY_CEILING &&
      apps.values[4] === APP_PRIORITY_CEILING &&
      apps.values[2] === 0 &&
      apps.values[3] === 10,
  )
  const helpers = fakePort({ 7: 0, 8: 19 })
  check(
    'replay helpers start below normal and idle helpers are not raised',
    lowerHelperPriority(7, helpers) &&
      helpers.values[7] === HELPER_PRIORITY &&
      !lowerHelperPriority(8, helpers) &&
      helpers.values[8] === 19 &&
      !lowerHelperPriority(undefined, helpers) &&
      !lowerHelperPriority(9, helpers),
  )
  const fallbackSource = readFileSync(
    path.join(process.cwd(), 'src', 'main', 'nativeReplayFallback.ts'),
    'utf8',
  )
  const runtimeSource = readFileSync(
    path.join(process.cwd(), 'src', 'main', 'dxgiReplayRuntime.ts'),
    'utf8',
  )
  const mainSource = readFileSync(
    path.join(process.cwd(), 'src', 'main', 'index.ts'),
    'utf8',
  )
  check(
    'both replay helpers and every app process are wired to the priority policy',
    fallbackSource.includes('lowerHelperPriority(child.pid)') &&
      runtimeSource.includes('lowerHelperPriority(child.pid)') &&
      mainSource.includes('capProcessesAtNormal(app.getAppMetrics().map((metric) => metric.pid))'),
  )
  check(
    'bounded producer ACK follows a completed canvas paint rather than throttled presentation',
    renderer.includes('nativeFallbackContext.drawImage(') &&
      renderer.includes('ackNativeFallbackFrame(') &&
      renderer.includes('presentedNativeFallbackFrame('),
  )
  check(
    'the fallback canvas has one automatic source-rate clock and no requestFrame clock',
    renderer.includes('nativeFallbackCanvas.captureStream(native.fps)') &&
      !renderer.includes('nativeFallbackCanvas.captureStream(0)') &&
      !renderer.includes('.requestFrame()'),
  )
  const nativeDrawBody = renderer.slice(
    renderer.indexOf('async function drawNativeFallbackFrame('),
    renderer.indexOf('function queueNativeFallbackFrame('),
  )
  check(
    'automatic presentation metadata is queued only after the observed JPEG paint',
    nativeDrawBody.indexOf('nativeFallbackContext.drawImage(') >= 0 &&
      nativeDrawBody.indexOf('nativeFallbackContext.drawImage(') <
        nativeDrawBody.indexOf('nativeFallbackPresentationQueue.push('),
  )
  check(
    'fallback MP4 fragment and keyframe cadence follows the actual 5fps native source',
    renderer.includes('mp4FragmentIntervalMs(recorderSourceFps)') &&
      renderer.includes('recorderSourceFps = payload.fps') &&
      renderer.includes('recorderSourceFps = native.fps'),
  )
  const mainCapture = readFileSync(
    path.join(process.cwd(), 'src', 'main', 'capture.ts'),
    'utf8',
  )
  check(
    'a same-window backend transition invalidates primary cadence and health proof',
    mainCapture.includes('displayCadence.reset(display.id)') &&
      mainCapture.includes(
        "setDisplayRecorderState(display.id, { status: 'starting' })",
      ),
  )
  const nativeManager = readFileSync(
    path.join(process.cwd(), 'src', 'main', 'nativeReplayFallback.ts'),
    'utf8',
  )
  check(
    'a stale native start failure can stop only its own helper session',
    nativeManager.includes('this.stop(request.webContentsId, id)') &&
      !nativeManager.includes(
        "} catch (error) {\n      this.stop(request.webContentsId)\n",
      ),
  )
  check(
    'stopped helper stdout cannot publish into a replacement session',
    nativeManager.includes('if (!ownsSlot()) return') &&
      nativeManager.includes(
        'this.sessions.get(request.webContentsId) === session',
      ),
  )
  check(
    'native frame ACKs are exact and stale or duplicate sequences cannot release pending IPC',
    mainCapture.includes('inFlightSequence: number | null') &&
      mainCapture.includes('delivery.inFlightSequence !== sequence') &&
      mainCapture.includes(
        'delivery.inFlightSequence = sent ? frame.sequence : null',
      ) &&
      mainCapture.includes(
        'sendTrackedNativeReplayFrame(delivery, event.sender, next)',
      ) &&
      !mainCapture.includes(
        '(event, sessionId: string, _sequence: number) =>',
      ),
  )
  check(
    'native presentation diagnostics accept only a frame sequence actually delivered to the renderer',
    mainCapture.includes('presentableSequences: Set<number>') &&
      mainCapture.includes(
        '!delivery.presentableSequences.delete(sequence)',
      ) &&
      mainCapture.includes('delivery.presentableSequences.clear()'),
  )
  check(
    'Windows QPC provenance is stamped by the helper parser and copied across both IPC paths',
    nativeManager.includes("clockProvenance: 'windows-qpc'") &&
      mainCapture.includes(
        'clockProvenance: frame.clockProvenance',
      ) &&
      mainCapture.includes(
        'clockProvenance: result.firstFrame.clockProvenance',
      ) &&
      renderer.includes(
        'clockEvidence: native.firstFrame.clockProvenance',
      ) &&
      renderer.includes('{ clockEvidence: qpcAnchor.clockEvidence }'),
  )
  check(
    'renderer buffers a helper exit that overtakes the invoke reply',
    renderer.includes('nativeFallbackStartupErrors.observe(payload)') &&
      renderer.includes(
        'nativeFallbackStartupErrors.consume(',
      ),
  )
  check(
    'delayed native presentation uses a bounded request-time association',
    renderer.includes('nativeFallbackPresentationQueue.take(') &&
      renderer.includes('presentedDelta') &&
      renderer.includes(
        'nativeFallbackPresentationQueue.push(requestedAtMs',
      ) &&
      !renderer.includes('let nativeFallbackRequestedFrame:'),
  )
  const surfaceLane = readFileSync(
    path.join(process.cwd(), 'src', 'main', 'context', 'surfaceLane.ts'),
    'utf8',
  )
  check(
    'unknown native frame age remains unknown instead of becoming measured zero',
    surfaceLane.includes('ageMs: number | null') &&
      surfaceLane.includes(': null,') &&
      surfaceLane.includes('if (ageMs !== null)'),
  )
}

console.log('\nPack capture diagnostics')
{
  const manifest = buildManifest({
    id: 'native-fallback-check',
    createdAt: new Date('2026-07-30T00:00:00Z'),
    generatorVersion: '0.3.3-rc.1',
    title: '',
    note: '',
    osVersion: '11',
    screens: [{ width: 640, height: 360, scale: 1 }],
    captureKind: 'video',
    hasReplay: true,
    replayFile: 'replay.mp4',
    replayDurationMs: 2_000,
    snapshotTMs: 2_000,
    cadence: {
      achieved_fps: 5,
      worst_stall_ms: 220,
      requested_fps: 15,
      backend: 'windows-gdi-bitblt',
      quality: 'degraded',
      recorder_count: 1,
    },
  } as never)
  const cadence = (manifest.media as Record<string, unknown>).cadence as
    | Record<string, unknown>
    | undefined
  check(
    'single-display manifest persists requested rate, backend, quality and recorder count',
    manifest.format_version === '0.4.0' &&
      cadence?.requested_fps === 15 &&
      cadence.backend === 'windows-gdi-bitblt' &&
      cadence.quality === 'degraded' &&
      cadence.recorder_count === 1,
    JSON.stringify({ version: manifest.format_version, cadence }),
  )
}

console.log('\nActual Windows GDI frame source')
{
  const helper = process.env.CAPTUREPACK_NATIVE_REPLAY_HELPER
  if (process.platform !== 'win32' || helper === undefined) {
    check('compiled helper path is supplied on Windows', false, 'CAPTUREPACK_NATIVE_REPLAY_HELPER missing')
  } else if (process.env.CAPTUREPACK_DESKTOP_INTERACTIVE === '0') {
    console.log(
      '\nSKIPPED live frame capture: Windows desktop session is locked or non-interactive.'
      + '\n        Run on an unlocked interactive Windows desktop to verify live BitBlt frames.',
    )
  } else {
    const manager = new NativeReplayFallbackManager(helper)
    const frames: NativeReplayFrame[] = []
    const display = {
      id: 1,
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      size: { width: Number(process.env.CAPTUREPACK_NATIVE_WIDTH), height: Number(process.env.CAPTUREPACK_NATIVE_HEIGHT) },
      scaleFactor: 1,
    }
    try {
      let started: NativeReplayStartResult | undefined
      try {
        started = await manager.start(
          {
            webContentsId: 1,
            display: display as never,
            nativeBounds: {
              x: Number(process.env.CAPTUREPACK_NATIVE_X),
              y: Number(process.env.CAPTUREPACK_NATIVE_Y),
              width: Number(process.env.CAPTUREPACK_NATIVE_WIDTH),
              height: Number(process.env.CAPTUREPACK_NATIVE_HEIGHT),
            },
            requestedFps: 5,
            width: 640,
            height: 360,
          },
          (_sessionId, frame) => frames.push(frame),
          () => {
            // An unexpected exit is asserted by the frame count below.
          },
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const isLocked =
          /err 5\b/u.test(message) ||
          /access is denied/iu.test(message) ||
          /desktop.*locked|non-interactive|inaccessible/iu.test(message)
        if (isLocked && process.env.CAPTUREPACK_DESKTOP_INTERACTIVE !== '1') {
          console.log(
            '\nSKIPPED live frame capture: Windows desktop session is locked or non-interactive.'
            + '\n        Run on an unlocked interactive Windows desktop to verify live BitBlt frames.',
          )
        } else {
          check(
            'native BitBlt helper supplies at least three real timestamped JPEG frames',
            false,
            `startup failed: ${message}`,
          )
        }
      }
      if (started !== undefined) {
        frames.unshift(started.firstFrame)
        const deadline = Date.now() + 2_000
        while (frames.length < 3 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        check(
          'native BitBlt helper supplies at least three real timestamped JPEG frames',
          frames.length >= 3 &&
            frames.slice(0, 3).every((frame, index) =>
              frame.jpeg[0] === 0xff &&
              frame.jpeg[1] === 0xd8 &&
              frame.clockProvenance === 'windows-qpc' &&
              frame.capturedQpc > 0 &&
              frame.qpcFrequency > 0 &&
              (index === 0 || frame.sequence > frames[index - 1]!.sequence) &&
              frame.capturedAtMs > 0),
          `${frames.length} frame(s)`,
        )
      }
    } finally {
      manager.stopAll()
    }
    const runHelper = (extra: string[], x: number): { status: number | null; stderr: string } => {
      const result = spawnSync(helper, [
        '--left', String(x),
        '--top', String(Number(process.env.CAPTUREPACK_NATIVE_Y)),
        '--expected-native-width', String(Number(process.env.CAPTUREPACK_NATIVE_WIDTH)),
        '--expected-native-height', String(Number(process.env.CAPTUREPACK_NATIVE_HEIGHT)),
        '--width', '32', '--height', '32', '--fps', '5', ...extra,
      ], { input: '', windowsHide: true, timeout: 10_000, encoding: 'buffer' })
      return { status: result.status, stderr: result.stderr.toString('utf8') }
    }
    const exact = runHelper([], Number(process.env.CAPTUREPACK_NATIVE_X))
    const label = /label="([^"]*)"/u.exec(exact.stderr)?.[1] ?? ''
    const device = /device=(\S+)/u.exec(exact.stderr)?.[1] ?? ''
    if (exact.status !== 0 || label === '') {
      console.log(`  SKIP  moved-origin identity: no friendly monitor label (${exact.stderr.trim()})`)
    } else {
      const moved = Number(process.env.CAPTUREPACK_NATIVE_X) + 7
      const unlabelled = runHelper([], moved)
      const labelled = runHelper(['--label', label], moved)
      check(
        'a stale origin alone does not resolve (the 0.6.3 failure)',
        unlabelled.status === 2 && /matches=0/u.test(unlabelled.stderr),
        unlabelled.stderr.trim(),
      )
      check(
        'the same stale origin resolves to the same monitor through its label',
        labelled.status === 0 && labelled.stderr.includes('resolved=label') && labelled.stderr.includes(`device=${device}`),
        labelled.stderr.trim(),
      )
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
