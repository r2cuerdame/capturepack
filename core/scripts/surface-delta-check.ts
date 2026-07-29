// Does the lane rebuild the WHOLE desk from a delta? (#110)
// The host now sends move-driven samples as deltas; if this merge is wrong the
// ring loses windows and picking loses their controls.
import { SurfaceLane, type SurfaceHost } from '../src/main/context/surfaceLane'
import { SurfaceTimeline } from '../src/main/context/timeline'
import type { ContextHostOptions, HostReply } from '../src/main/context/host'

const win = (h: string, x: number, z: number) => ({
  h, o: '0', p: 10 + Number(h), z, v: 1, m: 0, g: z === 0 ? 1 : 0, k: 0,
  b: [x, 100, 400, 300], c: [x, 100, 400, 300],
  t: `W${h}`, cl: `C${h}`, e: 'app.exe',
})

async function main(): Promise<void> {
  let onEvent: (e: Record<string, unknown> & { event: string }) => void = () => {}
  let onReady: (r: HostReply) => void = () => {}
  let coreNow = 0
  const host: SurfaceHost = {
    start() {}, stop() {},
    request: (m) => Promise.resolve(
      m === 'ping' ? ({ id: 1, ok: true, hostMs: coreNow } as HostReply) : ({ id: 1, ok: true } as HostReply),
    ),
  }
  const timeline = new SurfaceTimeline()
  const clock = { nowMs: () => coreNow, bufferStartMs: () => 0, observe: () => {} } as never
  const lane = new SurfaceLane(clock, timeline, 67, (o: ContextHostOptions) => {
    onEvent = o.onEvent as never
    onReady = o.onReady
    return host
  })
  lane.start()
  onReady({ id: 0, ok: true, hostMs: 0, monitors: [] })
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))

  const at = (t: number) => timeline.surfacesAt(t).surfaces.map((s) => `${s.hwnd}@${s.bounds.x}`).sort().join(' ')

  // 1. FULL: three windows.
  coreNow = 100
  lane.tickAt('d', 100)
  onEvent({ event: 'surface', t: 100, ft: 100, w: [win('1', 0, 0), win('2', 500, 1), win('3', 900, 2)] })
  await new Promise((r) => setImmediate(r))
  console.log(`after FULL      : ${at(100)}`)

  // 2. DELTA: only window 2 moved. The other two must survive.
  coreNow = 110
  lane.tickAt('d', 110)
  onEvent({ event: 'surface', t: 110, ft: 110, d: 1, w: [win('2', 560, 1)] })
  await new Promise((r) => setImmediate(r))
  console.log(`after DELTA(+2) : ${at(110)}`)

  // 3. DELTA: window 3 closed.
  coreNow = 120
  lane.tickAt('d', 120)
  onEvent({ event: 'surface', t: 120, ft: 120, d: 1, w: [win('2', 620, 1)], r: ['3'] })
  await new Promise((r) => setImmediate(r))
  console.log(`after DELTA(-3) : ${at(120)}`)

  // 4. FULL again: the picture is restated and replaces everything.
  coreNow = 130
  lane.tickAt('d', 130)
  onEvent({ event: 'surface', t: 130, ft: 130, w: [win('1', 0, 0), win('9', 700, 1)] })
  await new Promise((r) => setImmediate(r))
  console.log(`after FULL      : ${at(130)}`)

  const ok =
    at(100) === '1@0 2@500 3@900' &&
    at(110) === '1@0 2@560 3@900' &&
    at(120) === '1@0 2@620' &&
    at(130) === '1@0 9@700'
  console.log(ok ? '\nPASS — deltas rebuild the whole desk' : '\nFAIL — the merge loses or invents windows')
  process.exitCode = ok ? 0 : 1

}

void main()
