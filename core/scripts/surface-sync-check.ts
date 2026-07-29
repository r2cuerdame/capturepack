// DOES THE BOX FOLLOW THE WINDOW? (#110)
//
// This is a regression check for the fault that made a picked box wander off the
// window it names — the one the user reported as "한 화면에서도 못따라온다", on a
// single screen with no scaling involved at all.
//
// WHAT WENT WRONG. `surface.tick` is fire and forget: the lane asks the host to
// dump the desk under a frame's time and does not wait for the answer. Several
// requests are therefore outstanding at once and their replies need not come
// back in the order they were sent. The lane held the tick's two readings —
// Core's clock and the frame's age — in two SCALAR FIELDS that every new tick
// overwrote, so by the time a reply arrived those fields belonged to a LATER
// tick. The lag was then computed by subtracting two instants that were never a
// pair, and the sample was filed at `frameMs + (a difference between strangers)`.
// Measured on CapturePack_2026-07-29_135650: one window of constant size
// 1443x953 appeared to move 96-900 px between consecutive 67 ms samples,
// alternating direction, up to 13,000 px/s. The rectangles were right; the times
// they were filed under were not.
//
// On top of that, `IPC.captureTick` has always been documented "Focused display
// only — one clock" and nothing enforced it: `capture.ts` registers the tick
// listener per capture window, so EVERY display's recorder ticked into the one
// lane, each with its own media clock and its own zero point.
//
// WHY IT NEEDS A SYNTHETIC HOST. Neither fault is reachable through a real
// PowerShell host driven on a schedule — they need several ticks in flight with
// replies arriving out of order, which is what this fake produces deliberately.
//
// Run: npm run check:sync
import { SurfaceLane, type SurfaceHost } from '../src/main/context/surfaceLane'
import { SurfaceTimeline } from '../src/main/context/timeline'
import type { HostReply } from '../src/main/context/host'

/** Ground truth: one window sliding at exactly 1 px/ms, plus a static neighbour. */
function deskAt(tMs: number): unknown[] {
  const x = Math.round(tMs)
  return [
    {
      h: '1', o: '0', p: 10, z: 0,
      b: [x, 200, 1443, 953], c: [x, 200, 1443, 953],
      v: 1, m: 0, g: 1, k: 0, t: 'Tracked', cl: 'Cls1', e: 'app.exe',
    },
    {
      h: '2', o: '0', p: 11, z: 1,
      b: [50, 60, 300, 300], c: [50, 60, 300, 300],
      v: 1, m: 0, g: 0, k: 0, t: 'Other', cl: 'Cls2', e: 'other.exe',
    },
  ]
}

const TRUE_SPEED_PX_PER_MS = 1
const HOST_READ_DELAY_MS = 3
const DURATION_MS = 4_000
const D2_FRAME_MS = 67
const D1_FRAME_MS = 86

interface Result {
  coverage: number
  worstSpeed: number
  medianSpeed: number | null
  reportedLagMs: number | null
  samples: number
}

async function run(skewMs: number): Promise<Result> {
  let coreNow = 0
  const timeline = new SurfaceTimeline()
  const inflight: { ft: number; takenCoreMs: number; deliverAt: number }[] = []
  let onEvent: (event: Record<string, unknown> & { event: string }) => void = () => {}
  let onReady: (hello: HostReply) => void = () => {}

  const host: SurfaceHost = {
    start() {},
    stop() {},
    request(method, params) {
      if (method === 'ping') {
        return Promise.resolve({ id: 1, ok: true, hostMs: coreNow } as HostReply)
      }
      if (method === 'surface.tick') {
        const ft = Number((params as { tMs: number }).tMs)
        // The host reads the desk HOST_READ_DELAY_MS after being asked; the
        // reply then takes anywhere from 20 to 200 ms to come back. The spread
        // is what puts several ticks in flight at once.
        const jitter = 20 + ((ft * 7919) % 180)
        inflight.push({ ft, takenCoreMs: coreNow + HOST_READ_DELAY_MS, deliverAt: coreNow + jitter })
        return Promise.resolve({ id: 1, ok: true } as HostReply)
      }
      return Promise.resolve({ id: 1, ok: true } as HostReply)
    },
  }

  const clock = { nowMs: () => coreNow, bufferStartMs: () => 0, observe: () => {} } as never
  const lane = new SurfaceLane(clock, timeline, D2_FRAME_MS, (options) => {
    onEvent = options.onEvent as never
    onReady = options.onReady
    return host
  })

  lane.start()
  onReady({ id: 0, ok: true, hostMs: 0, monitors: [] })
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))

  for (let ms = 0; ms <= DURATION_MS; ms += 1) {
    coreNow = ms
    if (ms % D2_FRAME_MS === 0) lane.tickAt('display-2', ms)
    if (ms % D1_FRAME_MS === 0) lane.tickAt('display-1', ms + skewMs)
    // Deliver whatever is due, NEWEST FIRST — replies are not ordered.
    const due = inflight
      .filter((r) => r.deliverAt <= coreNow)
      .sort((a, b) => b.deliverAt - a.deliverAt)
    for (const reply of due) {
      inflight.splice(inflight.indexOf(reply), 1)
      onEvent({ event: 'surface', t: reply.takenCoreMs, ft: reply.ft, w: deskAt(reply.takenCoreMs) })
    }
    if (ms % 200 === 0) await new Promise((r) => setImmediate(r))
  }
  await new Promise((r) => setImmediate(r))

  const times = timeline.sampleTimesBetween(0, DURATION_MS)
  const speeds: number[] = []
  let worstSpeed = 0
  let previous: { tMs: number; x: number } | null = null
  for (const tMs of times) {
    const window = timeline.surfacesAt(tMs).surfaces.find((s) => s.hwnd === '1')
    if (window === undefined) continue
    if (previous !== null && tMs > previous.tMs) {
      const speed = Math.abs(window.bounds.x - previous.x) / (tMs - previous.tMs)
      speeds.push(speed)
      worstSpeed = Math.max(worstSpeed, speed)
    }
    previous = { tMs, x: window.bounds.x }
  }
  speeds.sort((a, b) => a - b)
  return {
    coverage: times.length / (Math.floor(DURATION_MS / D2_FRAME_MS) + 1),
    worstSpeed,
    medianSpeed: speeds[speeds.length >> 1] ?? null,
    reportedLagMs: lane.status().tickLagMs,
    samples: times.length,
  }
}

function report(title: string, r: Result): boolean {
  // A window really moving at 1 px/ms may be observed a few ms off its frame,
  // so a little over 1 is fine. Three times the truth is not.
  const ok = r.coverage >= 0.8 && r.coverage <= 1.2 && r.medianSpeed !== null && r.worstSpeed <= 3
  console.log(title)
  console.log(`  ring samples ${r.samples} (${(r.coverage * 100).toFixed(0)}% of the ticks sent)`)
  console.log(`  reported tick lag ${r.reportedLagMs} ms (the host answered ${HOST_READ_DELAY_MS} ms after being asked)`)
  console.log(
    `  apparent speed px/ms, truth ${TRUE_SPEED_PX_PER_MS.toFixed(1)}: ` +
      `median ${r.medianSpeed?.toFixed(2) ?? 'n/a'}, worst ${r.worstSpeed.toFixed(2)} ` +
      `(${Math.round(r.worstSpeed * 1000)} px/s)`,
  )
  console.log(ok ? '  PASS — the ring follows the window\n' : '  FAIL — the ring does not follow the window\n')
  return ok
}

async function main(): Promise<void> {
  // Two recorder renderers have independent media clocks with independent zero
  // points, so their frame times are thousands of ms apart. Scenario B removes
  // that so the tick/reply mismatch is measured on its own.
  const a = report(
    'A: two displays with independent media clocks (what production does)',
    await run(4_321),
  )
  const b = report(
    'B: two displays whose media clocks happen to agree (tick/reply mismatch alone)',
    await run(0),
  )
  if (!a || !b) {
    console.error('surface-sync-check FAILED')
    process.exitCode = 1
    return
  }
  console.log('surface-sync-check ok')
}

void main()
