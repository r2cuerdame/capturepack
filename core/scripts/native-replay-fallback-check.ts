import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  NativeReplayFallbackManager,
  NativeReplayFrameParser,
  nativeFallbackArguments,
  nativeFallbackFps,
  nativeFallbackRequestedFps,
  nativeReplayHelperPath,
  NATIVE_REPLAY_MAX_LONG_EDGE,
  type NativeReplayFrame,
} from '../src/main/nativeReplayFallback'
import { buildManifest } from '../src/main/exporter'
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
    nativeFallbackRequestedFps(31) === 30 &&
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
      const started = await manager.start(
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
    } finally {
      manager.stopAll()
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
