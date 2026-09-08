// Electron-main source contract for the guarded DXGI replay integration.
// The runtime protocol and native helper have executable checks of their own;
// this guards the application seams without starting capture windows.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const core = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const capture = readFileSync(path.join(core, 'src/main/capture.ts'), 'utf8')
  .replace(/\r\n?/g, '\n')
const renderer = readFileSync(path.join(core, 'src/renderer/capture/capture.ts'), 'utf8')
  .replace(/\r\n?/g, '\n')
const preload = readFileSync(path.join(core, 'src/preload/capture.ts'), 'utf8')
  .replace(/\r\n?/g, '\n')
const ipc = readFileSync(path.join(core, 'src/shared/ipc.ts'), 'utf8')
  .replace(/\r\n?/g, '\n')
let failed = 0
let passed = 0

function section(start, end) {
  const from = capture.indexOf(start)
  const to = capture.indexOf(end, from + start.length)
  return from >= 0 && to > from ? capture.slice(from, to) : ''
}

function check(name, condition) {
  if (condition) passed += 1
  else failed += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}`)
}

const reconcile = section(
  'function reconcileDxgiReplayServices(',
  '/**\n * Stops the recorder watchdog',
)
const nativeRequest = section(
  'async function requestNativeReplay(',
  '// Asks a capture window for its current replay blob',
)
const request = section(
  'export async function requestReplay(',
  'function requestShippingReplay(',
)
const shippingRequest = section(
  'function requestShippingReplay(',
  '/**\n * Releases a renderer boundary',
)
const resume = section(
  'export function resumeReplay(',
  'function resolveFixedDisplay(',
)
const probe = section('async function probeRecorder(', '/**\n * The renderer PROVED')
const rebuild = section('async function rebuild(', 'async function createCaptureWindow(')
const snapshots = section(
  'export async function takeDisplaySnapshots(',
  '// ONE permanent listener for every replay reply',
)

console.log('DXGI APPLICATION INTEGRATION')
check(
  'native candidates require the exact explicit opt-in and warm in background',
  reconcile.includes('dxgiReplayRuntimeOptedIn(process.argv)')
    && reconcile.includes('void manager.start({')
    && !reconcile.includes('await manager.start({'),
)
check(
  'one service is retained per display identity and stopped with lifecycle',
  capture.includes('const dxgiReplayServices = new Map<number, DxgiReplayServiceSlot>()')
    && reconcile.includes('slot.signature === dxgiReplayServiceSignature(display, retentionMs)')
    && capture.includes('stopDxgiReplayServices(')
    && capture.includes('slot.manager.stop()'),
)
check(
  'shipping recorder windows cover native warm-up before READY selects one owner',
  rebuild.indexOf('await createCaptureWindow(') >= 0
    && rebuild.lastIndexOf('reconcileDxgiReplayServices(wanted, settings)')
      > rebuild.indexOf('await createCaptureWindow('),
)
const suspendStart = renderer.indexOf('function suspendReplayEncoding(): void')
const suspendEnd = renderer.indexOf('async function startCapture(', suspendStart)
const suspendedEncoding =
  suspendStart >= 0 && suspendEnd > suspendStart
    ? renderer.slice(suspendStart, suspendEnd)
    : ''
check(
  'native READY suspends shipping workload and any fallback resumes it',
  capture.includes("if (selection.backend === 'native-dxgi')")
    && capture.includes('setShippingReplayWorkload(display.id, false)')
    && capture.includes('onFallback: (selection) =>')
    && capture.includes('setShippingReplayWorkload(display.id, true)')
    && capture.includes('discarding native candidate to avoid duplicate capture workload'),
)
check(
  'suspension crosses a declared IPC bridge, releases encoders and preserves frame ticks',
  ipc.includes("captureReplayWorkload: 'capture:replay-workload'")
    && preload.includes('IPC.captureReplayWorkload')
    && renderer.includes('onReplayWorkload(({ active }) =>')
    && renderer.includes('if (payload?.focused === true) suspendReplayEncoding()')
    && renderer.includes('else teardown()')
    && suspendedEncoding.includes('activeRecorder = null')
    && suspendedEncoding.includes('replayRing?.clear()')
    && !suspendedEncoding.includes('stopFrameTicks()')
    && !suspendedEncoding.includes('stream.getTracks()')
    && renderer.includes('void startCapture(payload)'),
)
check(
  'only held real captures attempt native and every miss falls through to shipping',
  request.includes('options.holdAfterCapture === true')
    && request.includes('await requestNativeReplay(win, requestId)')
    && request.includes('return requestShippingReplay(win, requestId, timeoutMs, options)')
    && !probe.includes('holdAfterCapture'),
)
check(
  'native selection requires READY health and a bounded validated snapshot',
  nativeRequest.includes("selection.backend !== 'native-dxgi'")
    && nativeRequest.includes("selection.ready.kind !== 'ready'")
    && nativeRequest.includes("selection.ready.status !== 'ok'")
    && nativeRequest.includes('if (!shippingReplaySuspended.has(displayId)) return null')
    && nativeRequest.includes('snapshot(REPLAY_TIMEOUT_MS)')
    && nativeRequest.includes("if (snapshot.status !== 'ok')")
    && nativeRequest.includes("mimeType: 'video/mp4'")
    && nativeRequest.includes("replayFile: 'replay.mp4'"),
)
check(
  'native ownership clears shipping cadence and owns a no-op resume token',
  nativeRequest.includes('displayCadence.reset(displayId)')
    && nativeRequest.includes('rememberNativeReplayRequest(requestId, displayId)')
    && capture.includes('nativeReplayRequests.size >= NATIVE_REPLAY_REQUEST_LIMIT')
    && capture.includes('shippingReplaySuspended.has(displayId)')
    && capture.includes('[...nativeReplayRequests.values()].includes(displayId)')
    && resume.indexOf('nativeReplayRequests.has(requestId)') >= 0
    && resume.indexOf('nativeReplayRequests.delete(requestId)')
      < resume.indexOf('win.webContents.send(IPC.captureResumeReplay, payload)'),
)
check(
  'shipping request and hold payload remain intact for fallback and probes',
  shippingRequest.includes('win.webContents.send(IPC.captureRequestReplay, request)')
    && shippingRequest.includes('options.holdAfterCapture === true')
    && shippingRequest.includes('{ holdAfterCapture: true }'),
)
check(
  'normal still snapshot implementation has no native replay dependency',
  snapshots.includes('snapshotGroup(withFocused, focused.id, result)')
    && !snapshots.includes('dxgiReplay')
    && !snapshots.includes('requestReplay'),
)

if (failed > 0) {
  console.error(`dxgi replay integration check: ${failed} failed`)
  process.exitCode = 1
} else {
  console.log(`dxgi replay integration check: ${passed} passed`)
}
