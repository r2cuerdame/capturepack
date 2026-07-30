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
import { frozenRingObservations } from '../src/main/context/ringObservations'
import { SessionClock } from '../src/main/context/clock'
import type { HostMonitor } from '../src/main/context/surfaceLane'
import type { HostReply } from '../src/main/context/host'
import { wallComparableTimeMs } from '../src/shared/highResolutionTime'

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
  /**
   * Ring samples that share their millisecond with another ring sample.
   *
   * Two observations at one instant is not a rounding detail: the nearest
   * sample lookup returns ONE rectangle for a time, so the other observation is
   * discarded and the box holds its predecessor across a whole frame. Measured
   * at 25% of samples in CapturePack_2026-07-29_144311 before the stable-lag
   * fix, every collision holding two DIFFERENT rectangles. This must be zero.
   */
  collided: number
  /**
   * Consecutive-sample pairs whose apparent speed is under 0.3 while the truth
   * is 1.0 — the box FREEZING for a frame while the window moves.
   *
   * This is what callback bursts produce (#110): frame N's callback fires tens
   * of ms late, frame N+1's fires right after, both ticks read the desk at
   * nearly the same instant, and the two nearly-identical rectangles are filed
   * a full frame apart. Measured at 25–40% of moving samples in every shaken
   * pack while the OS, the host, the lane and the ring each measured clean.
   * Must be zero.
   */
  stalls: number
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
        // AND THE HOST DOES NOT LOOK AT A FIXED DELAY EITHER.
        //
        // This used a constant HOST_READ_DELAY_MS, which made the per-tick lag a
        // constant — so the old code's `frameMs + thisTick'sLag` was monotone by
        // accident and the harness could not produce the collision that the real
        // packs are full of. The swing is not invented: collisions only happen
        // when the lag varies by more than the frame interval, and 25% of the
        // samples in CapturePack_2026-07-29_144311 collided, so in production it
        // does. Modelled here as a spread wider than one 67 ms frame.
        // Hashed, not `ft * prime % n`: the obvious form is a fixed stride mod a
        // modulus, so its step is one of two constants and — checked the hard
        // way, by watching the red test pass — it never fell far enough to
        // reorder anything. A jitter that cannot invert proves nothing.
        // Spread just under one frame: wide enough that late reads cross the
        // next frame's early ones (the inversion the drop guard exists for),
        // narrow enough not to torture the ring into dropping a fifth of its
        // samples — the real host's read delay is ~2 ms with rare spikes.
        const readDelay = HOST_READ_DELAY_MS + ((Math.imul(ft, 2_654_435_761) >>> 0) % 60)
        inflight.push({ ft, takenCoreMs: coreNow + readDelay, deliverAt: coreNow + jitter })
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

  // CALLBACK BURSTS (#110). The recorder's frame callbacks do not fire on the
  // frame grid — under encoder load the compositor delivers them late and in
  // bunches. Modelled here as every other frame's callback running 55 ms late
  // through the middle of the run: frame k's tick then fires ~12 ms before
  // frame k+1's, the two reads see the desk ~12 ms apart, and without the
  // delay in the filing arithmetic the ring records a stall every other frame.
  const scheduled: { fireAt: number; frameMs: number; delayMs: number }[] = []
  for (let ms = 0; ms <= DURATION_MS; ms += 1) {
    coreNow = ms
    if (ms % D2_FRAME_MS === 0) {
      const k = ms / D2_FRAME_MS
      const delayMs = k % 2 === 1 && k >= 10 && k < 40 ? 55 : 0
      // FRACTIONAL, LIKE THE REAL CLOCK (#110). Production frame times are
      // `presentationTime` — x.933, x.867, never whole — and the ring's sample
      // times inherit the fraction. An all-integer bench rounds every query
      // onto its own sample exactly and CANNOT produce the floor-miss that
      // shipped: `Math.round` of a fractional sample time lands just before
      // the sample half the time, and `restoreAt` answers at-or-before. The
      // varying fraction below is what lets the red test catch it.
      scheduled.push({ fireAt: ms + delayMs, frameMs: ms + ((k * 0.617) % 1), delayMs })
    }
    for (let i = scheduled.length - 1; i >= 0; i -= 1) {
      const tick = scheduled[i]!
      if (tick.fireAt !== ms) continue
      scheduled.splice(i, 1)
      lane.tickAt('display-2', tick.frameMs, undefined, tick.delayMs)
    }
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
  // READ BACK THROUGH THE PRODUCTION PATH, NOT AROUND IT (#110).
  //
  // This used to call `timeline.surfacesAt(t)` with the ring's exact float
  // sample times — and that read is one the shipped code never performs. The
  // save path goes through `frozenRingObservations`, which labels pack times in
  // integer ms; its original `Math.round(t)` on the QUERY landed half the
  // queries a fraction of a millisecond BEFORE the sample they named, and
  // `restoreAt` answers at-or-before, so the answer was the PREVIOUS frame's
  // rectangle. 25-31% of moving samples repeated in every shaken pack while
  // this check read the ring directly and reported it clean. A bench that
  // bypasses a production layer certifies nothing about it.
  const MONITORS: HostMonitor[] = [
    { device: 'BENCH', primary: true, bounds: { x: 0, y: 0, width: 3840, height: 2160 } },
  ]
  const observations = frozenRingObservations(
    (packTMs) => timeline.surfacesAt(packTMs, DURATION_MS),
    MONITORS,
    [{ index: 0, focused: true, width: 3840, height: 2160 }],
    DURATION_MS,
    times,
  )
  const speeds: number[] = []
  let worstSpeed = 0
  let stalls = 0
  let previous: { tMs: number; x: number } | null = null
  for (const observation of observations) {
    const window = observation.windows.find((w) => w.hwnd === '1')
    if (window === undefined) continue
    if (previous !== null && observation.tMs > previous.tMs) {
      const speed = Math.abs(window.bounds.x - previous.x) / (observation.tMs - previous.tMs)
      speeds.push(speed)
      worstSpeed = Math.max(worstSpeed, speed)
      // Only pairs a frame apart can stall honestly-never: two reads filed a
      // few ms apart SHOULD show tiny displacement, and that is correct. A
      // stall is a near-frozen rectangle across a real frame interval.
      if (observation.tMs - previous.tMs > 30 && speed < 0.3) stalls += 1
    }
    previous = { tMs: observation.tMs, x: window.bounds.x }
  }
  speeds.sort((a, b) => a - b)
  // Collisions counted on the PUBLISHED times — the integer labels the pack
  // will carry — not on the ring's internal floats.
  const perTime = new Map<number, number>()
  for (const observation of observations) {
    perTime.set(observation.tMs, (perTime.get(observation.tMs) ?? 0) + 1)
  }
  let collided = 0
  for (const n of perTime.values()) if (n > 1) collided += n
  return {
    coverage: observations.length / (Math.floor(DURATION_MS / D2_FRAME_MS) + 1),
    collided,
    stalls,
    worstSpeed,
    medianSpeed: speeds[speeds.length >> 1] ?? null,
    reportedLagMs: lane.status().tickLagMs,
    samples: observations.length,
  }
}

function report(title: string, r: Result): boolean {
  // A window really moving at 1 px/ms may be observed a few ms off its frame,
  // so a little over 1 is fine. Three times the truth is not.
  const ok =
    r.coverage >= 0.8 &&
    r.coverage <= 1.2 &&
    r.medianSpeed !== null &&
    r.worstSpeed <= 3 &&
    r.collided === 0 &&
    r.stalls === 0
  console.log(title)
  console.log(`  ring samples ${r.samples} (${(r.coverage * 100).toFixed(0)}% of the ticks sent)`)
  console.log(
    `  samples sharing an instant with another: ${r.collided}` +
      (r.collided === 0 ? '' : ' — one of each pair is unreachable'),
  )
  console.log(
    `  frame-length stalls while the window moves: ${r.stalls}` +
      (r.stalls === 0 ? '' : ' — the box freezes while the window travels'),
  )
  console.log(`  reported tick lag ${r.reportedLagMs} ms (the host answered ${HOST_READ_DELAY_MS} ms after being asked)`)
  console.log(
    `  apparent speed px/ms, truth ${TRUE_SPEED_PX_PER_MS.toFixed(1)}: ` +
      `median ${r.medianSpeed?.toFixed(2) ?? 'n/a'}, worst ${r.worstSpeed.toFixed(2)} ` +
      `(${Math.round(r.worstSpeed * 1000)} px/s)`,
  )
  console.log(ok ? '  PASS — the ring follows the window\n' : '  FAIL — the ring does not follow the window\n')
  return ok
}

function crossRendererClockReport(): boolean {
  // Same real 30-second interval, observed by two renderer processes whose
  // performance.now() origins are 95 seconds apart. This is exactly the field
  // failure: lane S was ticked by one display renderer while the focused replay
  // (and therefore its slot origin) came from another.
  const realStartWallMs = Date.now() - 30_000
  const realEndWallMs = realStartWallMs + 30_000
  const tickRendererOrigin = realStartWallMs - 100_000
  const replayRendererOrigin = realStartWallMs - 5_000
  const rawTickAtEnd = 130_000
  const rawReplayStart = 5_000
  const rawGapMs = Math.abs(rawTickAtEnd - (rawReplayStart + 30_000))

  const tickEndWallMs = wallComparableTimeMs(tickRendererOrigin, rawTickAtEnd)
  const replayStartWallMs = wallComparableTimeMs(replayRendererOrigin, rawReplayStart)
  const clock = new SessionClock(35_000)
  const tickEndSessionMs = clock.fromWallClockMs(tickEndWallMs)
  const replayEndSessionMs = clock.fromWallClockMs(replayStartWallMs) + 30_000
  const normalizedGapMs = Math.abs(tickEndSessionMs - replayEndSessionMs)
  const wallErrorMs = Math.max(
    Math.abs(tickEndWallMs - realEndWallMs),
    Math.abs(replayStartWallMs - realStartWallMs),
  )
  const ok = rawGapMs === 95_000 && normalizedGapMs < 0.001 && wallErrorMs < 0.001

  console.log('C: focused replay and lane-S ticks come from different renderer clocks')
  console.log(`  raw renderer-clock gap: ${rawGapMs} ms`)
  console.log(`  shared session-clock gap: ${normalizedGapMs.toFixed(3)} ms`)
  console.log(ok ? '  PASS — past surfaces remain inside the replay range\n' : '  FAIL — replay and surfaces do not overlap\n')
  return ok
}

async function ownerHandoffReport(): Promise<boolean> {
  let wallNow = 1_000
  let coreNow = 0
  let acceptedTicks = 0
  let onReady: (hello: HostReply) => void = () => {}
  const originalDateNow = Date.now
  Date.now = () => wallNow
  const host: SurfaceHost = {
    start() {},
    stop() {},
    request(method) {
      if (method === 'ping') return Promise.resolve({ id: 1, ok: true, hostMs: coreNow })
      if (method === 'surface.start') {
        return Promise.resolve({ id: 1, ok: true, intervalMs: D2_FRAME_MS })
      }
      if (method === 'surface.tick') acceptedTicks += 1
      return Promise.resolve({ id: 1, ok: true })
    },
  }
  const clock = {
    nowMs: () => coreNow,
    bufferStartMs: () => 0,
    observe: () => {},
  } as never
  const lane = new SurfaceLane(clock, new SurfaceTimeline(), D2_FRAME_MS, (options) => {
    onReady = options.onReady
    return host
  })
  try {
    lane.start()
    onReady({ id: 0, ok: true, hostMs: 0, monitors: [] })
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))

    lane.tickAt('display-a', 100)
    wallNow = 1_500
    coreNow = 500
    lane.tickAt('display-b', 500)
    const rejectedConcurrentSource = acceptedTicks === 1

    wallNow = 3_100
    coreNow = 2_100
    lane.tickAt('display-b', 2_100)
    const acceptedReplacement = acceptedTicks === 2
    const ok = rejectedConcurrentSource && acceptedReplacement
    console.log('D: recorder owner disappears and a surviving display takes over')
    console.log(`  accepted surface ticks: ${acceptedTicks} (want 2)`)
    console.log(ok ? '  PASS — concurrent clocks are rejected, silent owners can hand off\n' : '  FAIL — owner handoff is stuck or duplicates clocks\n')
    return ok
  } finally {
    lane.stop()
    Date.now = originalDateNow
  }
}

/**
 * DO A TICKED AND A FREE-RUNNING OBSERVATION OF THE SAME INSTANT AGREE? (#89)
 *
 * An observation is of the LIVE desktop, while the frame it is filed against
 * shows pixels exposed `age` ms earlier — so it belongs at a LATER point on the
 * video's timeline. `onTick` has added that term since it was measured; the
 * converted path, which carried 160 of 170 samples in the field, never did.
 *
 * At the 1 ms this machine measures, the difference is invisible. This check
 * drives a deliberately LARGE age so the asymmetry is a fact rather than a
 * rounding artifact: without the fix the two paths file the same world instant
 * a full `age` apart, which is the shape #89 would take on the majority of
 * samples the moment a real desktop-exposure latency reached that term.
 */
async function agePathAgreementReport(): Promise<boolean> {
  const AGE_MS = 60
  const FRAME_MS = 1_000
  const DELAY_MS = 0
  let coreNow = 0
  let onReady: (hello: HostReply) => void = () => {}
  let onEvent: (event: Record<string, unknown> & { event: string }) => void = () => {}
  const host: SurfaceHost = {
    start() {},
    stop() {},
    request(method) {
      if (method === 'ping') return Promise.resolve({ id: 1, ok: true, hostMs: coreNow })
      if (method === 'surface.start') {
        return Promise.resolve({ id: 1, ok: true, intervalMs: D2_FRAME_MS })
      }
      return Promise.resolve({ id: 1, ok: true })
    },
  }
  const clock = {
    nowMs: () => coreNow,
    bufferStartMs: () => 0,
    observe: () => {},
  } as never
  const timeline = new SurfaceTimeline()
  const lane = new SurfaceLane(clock, timeline, D2_FRAME_MS, (options) => {
    onReady = options.onReady
    onEvent = options.onEvent as typeof onEvent
    return host
  })
  try {
    lane.start()
    onReady({ id: 0, ok: true, hostMs: 0, monitors: [] })
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))

    // A tick establishes both the frame-clock mapping and the age. Core's clock
    // and the frame clock are deliberately identical here so the ONLY term
    // separating the two paths is the one under test.
    coreNow = FRAME_MS
    lane.tickAt('display-a', FRAME_MS, AGE_MS, DELAY_MS)
    onEvent({ event: 'surface', ft: FRAME_MS, t: FRAME_MS, w: deskAt(FRAME_MS) })
    await new Promise((resolve) => setImmediate(resolve))
    const afterTick = timeline.sampleTimesBetween(0, 10_000)
    const ticked = afterTick[afterTick.length - 1] ?? Number.NaN

    // The same world instant, arriving free-running instead of under a tick.
    const freeInstant = FRAME_MS + 200
    coreNow = freeInstant
    onEvent({ event: 'surface', t: freeInstant, w: deskAt(freeInstant) })
    await new Promise((resolve) => setImmediate(resolve))
    const afterFree = timeline.sampleTimesBetween(0, 10_000)
    const converted = afterFree[afterFree.length - 1] ?? Number.NaN

    // Ticked: frameMs + delay + lag + age. Free-running: t - offset + age, and
    // offset is zero here. Both therefore sit `age` past their own instant, so
    // the gap between them is exactly the gap between the instants.
    const tickedShift = ticked - FRAME_MS
    const convertedShift = converted - freeInstant
    const agreement = Math.abs(tickedShift - convertedShift)
    const ok = agreement <= 1 && Math.abs(convertedShift - AGE_MS) <= 1

    console.log('F: a ticked and a free-running observation of the same instant')
    console.log(`  ticked filed ${tickedShift.toFixed(1)} ms past its instant`)
    console.log(`  free-running filed ${convertedShift.toFixed(1)} ms past its instant (age ${AGE_MS} ms)`)
    console.log(`  disagreement: ${agreement.toFixed(1)} ms`)
    console.log(
      ok
        ? '  PASS — both paths carry the age of the picture\n'
        : `  FAIL — the two paths file the same instant ${agreement.toFixed(1)} ms apart\n`,
    )
    return ok
  } finally {
    lane.stop()
  }
}

async function stillRefreshReport(): Promise<boolean> {
  let onReady: (hello: HostReply) => void = () => {}
  let onEvent: (event: Record<string, unknown> & { event: string }) => void = () => {}
  let emitSnapshot = true
  let refresh:
    | { method: string; params?: Record<string, unknown>; timeoutMs?: number }
    | undefined
  const host: SurfaceHost = {
    start() {},
    stop() {},
    request(method, params, timeoutMs) {
      if (method === 'ping') return Promise.resolve({ id: 1, ok: true, hostMs: 0 })
      if (method === 'surface.tick' && params?.full === true) {
        refresh = { method, params, timeoutMs }
        if (emitSnapshot) {
          // Production writes this complete event before the request reply.
          onEvent({ event: 'surface', sf: 1, t: 0, w: deskAt(0) })
        }
      }
      return Promise.resolve({ id: 1, ok: true })
    },
  }
  const clock = { nowMs: () => 0, bufferStartMs: () => 0, observe: () => {} } as never
  const lane = new SurfaceLane(clock, new SurfaceTimeline(), D2_FRAME_MS, (options) => {
    onReady = options.onReady
    onEvent = options.onEvent as typeof onEvent
    return host
  })
  lane.start()
  onReady({ id: 0, ok: true, hostMs: 0, monitors: [] })
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  const refreshed = await lane.sampleNow()
  emitSnapshot = false
  const replyWithoutSnapshot = await lane.sampleNow()
  lane.stop()
  const ok =
    refreshed?.[0]?.hwnd === '1' &&
    replyWithoutSnapshot === null &&
    refresh?.method === 'surface.tick' &&
    refresh.params?.full === true &&
    refresh.timeoutMs === 250
  console.log('E: a still trigger refreshes full window membership before freezing')
  console.log(
    ok
      ? '  PASS — the pre-reply window set is returned with a 250 ms fail-open bound\n'
      : '  FAIL — still capture can reuse a stale cadence sample\n',
  )
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
  const c = crossRendererClockReport()
  const d = await ownerHandoffReport()
  const e = await stillRefreshReport()
  const f = await agePathAgreementReport()
  if (!a || !b || !c || !d || !e || !f) {
    console.error('surface-sync-check FAILED')
    process.exitCode = 1
    return
  }
  console.log('surface-sync-check ok')
}

void main()
