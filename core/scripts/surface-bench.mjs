// Lane S bench and correctness harness (issues #64, #65).
//
// WHY THIS EXISTS. docs/temporal-protocol.md §13 step 2 says: "Measure and record
// CPU% and working set HERE, before anything is built on top." A design that
// cannot state its sampling cost is not finished, and GOAL.md "Capture must stay
// cheap" is the constraint that decides whether the whole temporal subsystem
// ships. So the cost is produced by running the real host, and the correctness
// of the checkpoint+delta ring is proved against the very samples that host
// produced — not against a fixture somebody wrote to pass.
//
// It runs the REAL scripts/context-host.ps1 and the REAL SurfaceTimeline (bundled
// out of TypeScript on the fly, so it can never drift from the shipping code).
// It is read-only, it starts nothing that outlives it, and it needs no Electron.
//
//   node scripts/surface-bench.mjs [seconds] [intervalMs]
//
// WHAT IT ASSERTS
//  1. RESTORE IS LOSSLESS. For every sample time the host reported, the ring's
//     restoreAt(t) reproduces that sample's windows exactly — same handles, same
//     rectangles, same z-order, same flags. This is the claim the whole design
//     rests on: "logically restorable at any buffered time; physically stored
//     however the provider likes" (#64).
//  2. THE STACK IS THE STACK. stackAt(t, point) returns the surfaces containing
//     that point, topmost first, and each one's visibleRegion excludes what is
//     above it (#65).
//  3. A FROZEN RANGE SURVIVES PRUNING (#64 onFreeze / protocol GAP 5).
//  4. TIME TRAVEL IS REAL. A point that was over window A early in the run and
//     over window B later answers differently at the two times — the bug this
//     whole phase exists to remove, reduced to an assertion.

import { spawn } from 'node:child_process'
import { build } from 'esbuild'

const seconds = Number(process.argv[2] ?? 20)
const intervalMs = Number(process.argv[3] ?? 100)

// The shipping SurfaceTimeline, compiled from source at run time. Bundling
// rather than importing a build artefact means this harness measures the code in
// the working tree, which is the only thing worth measuring.
const bundle = await build({
  entryPoints: ['src/main/context/timeline.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
})
const source = bundle.outputFiles[0].text
const { SurfaceTimeline } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
)

const host = spawn(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/context-host.ps1'],
  { windowsHide: true },
)
host.stdin.on('error', () => {})
host.stdout.on('error', () => {})
host.stderr.on('error', () => {})
host.stderr.setEncoding('utf8')
host.stderr.on('data', (chunk) => process.stderr.write(`host stderr: ${chunk}`))

const samples = []
const statuses = []
let hello = null
let buffer = ''
const waiters = new Map()

host.stdout.setEncoding('utf8')
host.stdout.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    index = buffer.indexOf('\n')
    if (line === '') continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof record.id === 'number') {
      const waiter = waiters.get(record.id)
      if (waiter !== undefined) {
        waiters.delete(record.id)
        waiter(record)
      }
      continue
    }
    if (record.event === 'surface') samples.push(record)
    else if (record.event === 'status') statuses.push(record)
    else if (record.event === 'error') console.error('host error:', record.message)
  }
})

let nextId = 1
function request(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id)
      reject(new Error(`host did not answer ${method}`))
    }, 10_000)
    waiters.set(id, (reply) => {
      clearTimeout(timer)
      resolve(reply)
    })
    host.stdin.write(`${JSON.stringify(params === undefined ? { id, method } : { id, method, params })}\n`)
  })
}

const failures = []
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

hello = await request('hello')
console.log(
  `host pid ${hello.pid}, DPI ${hello.dpi}, PowerShell ${hello.psVersion}, ${hello.monitors.length} monitor(s)`,
)

// Clock probe, the same one Core uses (protocol GAP 3): four timestamps, offset
// and round-trip bound. Reported here because "the clock error is unmeasured" is
// exactly the honesty this protocol is built around.
const roundTrips = []
for (let i = 0; i < 7; i += 1) {
  const t1 = performance.now()
  const reply = await request('ping')
  const t4 = performance.now()
  roundTrips.push({ delay: t4 - t1, offset: (reply.hostMs - t1 + (reply.hostMs - t4)) / 2 })
}
const medianDelay = median(roundTrips.map((r) => r.delay))
console.log(
  `clock: offset ${median(roundTrips.map((r) => r.offset)).toFixed(1)} ms, ` +
    `round trip ${medianDelay.toFixed(2)} ms (error bound ±${(medianDelay / 2).toFixed(2)} ms)`,
)

await request('surface.start', { intervalMs })
console.log(`sampling for ${seconds}s at ${intervalMs} ms…`)
await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
await request('status')
await new Promise((resolve) => setTimeout(resolve, 200))
const finalStatus = statuses[statuses.length - 1]
await request('shutdown').catch(() => {})
host.stdin.end()

if (samples.length === 0) {
  console.error('no samples — the host produced nothing')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Feed the real ring
// ---------------------------------------------------------------------------

const timeline = new SurfaceTimeline()
const wireBytes = []
for (const sample of samples) {
  const windows = sample.w.map((w) => ({
    hwnd: w.h,
    ownerHwnd: w.o,
    processId: w.p,
    zOrder: w.z,
    bounds: { x: w.b[0], y: w.b[1], width: w.b[2], height: w.b[3] },
    clientBounds: { x: w.c[0], y: w.c[1], width: w.c[2], height: w.c[3] },
    visible: w.v === 1,
    minimized: w.m === 1,
    foreground: w.g === 1,
    cloaked: w.k === 1,
    windowTitle: w.t,
    className: w.cl,
    executableName: w.e,
  }))
  wireBytes.push(JSON.stringify(sample).length)
  timeline.append({ timeMs: sample.t, windows })
}

const stats = timeline.stats()

// 1. Restore is lossless, at every sample time.
let mismatches = 0
let firstMismatch = ''
for (const sample of samples) {
  const restored = timeline.restoreAt(sample.t)
  const expected = new Map(sample.w.map((w) => [w.h, w]))
  if (restored.surfaces.length !== expected.size) {
    mismatches += 1
    if (firstMismatch === '') {
      firstMismatch = `t=${sample.t}: ${restored.surfaces.length} restored vs ${expected.size} recorded`
    }
    continue
  }
  for (const surface of restored.surfaces) {
    const want = expected.get(surface.hwnd)
    if (
      want === undefined ||
      surface.bounds.x !== want.b[0] ||
      surface.bounds.y !== want.b[1] ||
      surface.bounds.width !== want.b[2] ||
      surface.bounds.height !== want.b[3] ||
      surface.zOrder !== want.z ||
      surface.minimized !== (want.m === 1) ||
      surface.foreground !== (want.g === 1) ||
      surface.windowTitle !== want.t ||
      surface.className !== want.cl ||
      surface.executableName !== want.e
    ) {
      mismatches += 1
      if (firstMismatch === '') firstMismatch = `t=${sample.t}: hwnd ${surface.hwnd} differs`
      break
    }
  }
}
check(
  `restore is lossless at all ${samples.length} sample times`,
  mismatches === 0,
  firstMismatch,
)

// 2. The stack under a point is z-ordered and its visible regions exclude what is above.
const probe = pickProbePoint(samples[samples.length - 1])
const stack = timeline.stackAt(samples[samples.length - 1].t, probe)
check(
  `stackAt(${probe.x},${probe.y}) returns a stack (${stack.surfaces.length} surfaces)`,
  stack.surfaces.length > 0,
)
check(
  'the stack is ordered topmost first',
  stack.surfaces.every((s, i) => i === 0 || stack.surfaces[i - 1].zOrder <= s.zOrder),
)
check(
  'every surface in the stack contains the probe point',
  stack.surfaces.every(
    (s) =>
      probe.x >= s.bounds.x &&
      probe.y >= s.bounds.y &&
      probe.x < s.bounds.x + s.bounds.width &&
      probe.y < s.bounds.y + s.bounds.height,
  ),
)
check(
  'the topmost surface owns the point in its visible region',
  stack.surfaces.length === 0 ||
    stack.surfaces[0].visibleRegion.some(
      (r) => probe.x >= r.x && probe.y >= r.y && probe.x < r.x + r.width && probe.y < r.y + r.height,
    ),
)

// 3. A frozen range survives pruning; an unfrozen one does not.
const first = samples[0].t
const last = samples[samples.length - 1].t
const frozenTimeline = new SurfaceTimeline()
for (const sample of samples) {
  frozenTimeline.append({
    timeMs: sample.t,
    windows: sample.w.map(toWindow),
  })
}
frozenTimeline.freeze('bench', first, first + (last - first) / 2)
frozenTimeline.prune(last)
const afterFreeze = frozenTimeline.restoreAt(first + 50)
check('a frozen range survives a prune past it', afterFreeze.surfaces.length > 0, JSON.stringify(afterFreeze.accuracy))
frozenTimeline.release('bench')
frozenTimeline.prune(last)
const afterRelease = frozenTimeline.restoreAt(first + 50)
check(
  'the same range is pruned once released',
  afterRelease.surfaces.length === 0 || afterRelease.accuracy.coverage !== 'covered',
  JSON.stringify(afterRelease.accuracy),
)

// 4. Time travel: the answer at an early time is allowed to differ from the last one.
//    (It only DOES differ if something moved during the run, so this reports
//    rather than asserts — an idle desk is the measured normal case.)
const early = timeline.restoreAt(first)
const late = timeline.restoreAt(last)
const movedWindows = late.surfaces.filter((l) => {
  const e = early.surfaces.find((s) => s.hwnd === l.hwnd)
  return (
    e !== undefined &&
    (e.bounds.x !== l.bounds.x ||
      e.bounds.y !== l.bounds.y ||
      e.bounds.width !== l.bounds.width ||
      e.bounds.height !== l.bounds.height ||
      e.zOrder !== l.zOrder)
  )
})
console.log(
  `  info ${movedWindows.length} window(s) moved or changed z between t=${first.toFixed(0)} and t=${last.toFixed(0)}` +
    `${movedWindows.length === 0 ? ' (idle desk — the measured normal case)' : ''}`,
)

// 5. Accuracy is honest outside the range.
const beforeStart = timeline.restoreAt(first - 60_000)
check(
  'a time before the ring reports coverage, not a guess',
  beforeStart.surfaces.length === 0 && beforeStart.accuracy.coverage !== 'covered',
  JSON.stringify(beforeStart.accuracy),
)
const nearest = timeline.restoreAt(first + intervalMs / 2)
check(
  'a time between samples answers with the nearest sample AND its error',
  nearest.accuracy.exact === false &&
    nearest.accuracy.errorMs > 0 &&
    nearest.accuracy.errorMs <= intervalMs &&
    nearest.accuracy.coverage === 'covered',
  JSON.stringify(nearest.accuracy),
)
// A gap — a host restart, a sleeping machine — must not read as "covered".
const gapped = new SurfaceTimeline()
gapped.append({ timeMs: 0, windows: samples[0].w.map(toWindow) })
gapped.append({ timeMs: 5_000, windows: samples[0].w.map(toWindow) })
const inGap = gapped.restoreAt(3_000)
check(
  'a time inside a sampling gap says degraded, not covered',
  inGap.accuracy.coverage === 'degraded' && inGap.accuracy.errorMs === 3_000,
  JSON.stringify(inGap.accuracy),
)

// 6. The memory governor drops RESOLUTION, never RANGE — and never a frozen range.
//    Synthetic on purpose: every window moves every sample, which is the worst
//    case the 512 KB ceiling exists for and one an idle desk never produces.
const stressWindows = 24
function hostileRing(sampleCount, freezeAt) {
  const ring = new SurfaceTimeline()
  for (let i = 0; i < sampleCount; i += 1) {
    ring.append({
      timeMs: i * 100,
      windows: Array.from({ length: stressWindows }, (_, w) => ({
        hwnd: String(1000 + w),
        ownerHwnd: '0',
        processId: 100 + w,
        zOrder: w,
        bounds: { x: (i * 3 + w) % 3000, y: (i * 5 + w) % 2000, width: 400, height: 300 },
        clientBounds: { x: (i * 3 + w) % 3000, y: (i * 5 + w) % 2000, width: 390, height: 280 },
        visible: true,
        minimized: false,
        foreground: w === 0,
        cloaked: false,
        windowTitle: `window ${w}`,
        className: `Class${w}`,
        executableName: `app${w}.exe`,
      })),
    })
    if (freezeAt !== null && i === freezeAt) ring.freeze('stress', 0, 10_000)
  }
  return ring
}

// 6a. Nothing pinned: the ceiling is a ceiling.
const loose = hostileRing(20_000, null)
const looseStats = loose.stats()
check(
  `a hostile unpinned ring stays inside its 512 KB ceiling (${(looseStats.bytes / 1024).toFixed(0)} KB ` +
    `after 20 000 samples with ${stressWindows} windows moving every single sample)`,
  looseStats.bytes <= 512 * 1024 * 1.05,
  `${looseStats.bytes} bytes`,
)

// 6b. Pinned: the ceiling bends rather than the pin breaking, and growth stays
//     bounded — doubling the sample count must not double the bytes.
const stress = hostileRing(20_000, 100)
const stressStats = stress.stats()
const doubled = hostileRing(40_000, 100).stats()
check(
  `a pinned hostile ring stays bounded (${(stressStats.bytes / 1024).toFixed(0)} KB at 20 000 samples, ` +
    `${(doubled.bytes / 1024).toFixed(0)} KB at 40 000 — 2x the samples, ` +
    `${(doubled.bytes / stressStats.bytes).toFixed(2)}x the bytes)`,
  doubled.bytes < stressStats.bytes * 1.5 && doubled.bytes < 1024 * 1024,
  `${stressStats.bytes} → ${doubled.bytes} bytes`,
)
const pinned = stress.restoreAt(5_000)
check(
  'the frozen range survives the governor (range is never what gets dropped)',
  pinned.surfaces.length === stressWindows,
  `${pinned.surfaces.length} surfaces, ${JSON.stringify(pinned.accuracy)}`,
)
check(
  'and the ring says it degraded rather than pretending it did not',
  stressStats.stride > 1 || stressStats.degradedSamples > 0 || stressStats.droppedSamples > 0,
  JSON.stringify({
    stride: stressStats.stride,
    degraded: stressStats.degradedSamples,
    dropped: stressStats.droppedSamples,
  }),
)

// 7. ORDINARY TITLE CHURN MUST NOT PERMANENTLY DEGRADE THE RING.
//
//    Everything above this point moves RECTANGLES and keeps titles constant,
//    which is why none of it caught the following: the identity table is
//    append-only, so a window that retitles once a second — a downloading
//    browser ("37% of 1.2 GB"), a media player, a terminal progress line —
//    added a table entry per second forever. That table was charged against the
//    512 KB SAMPLE ceiling, and every lever the governor has moves sample bytes
//    and cannot free one byte of it, so the loop could only ratchet: measured
//    1,551 KB, sampling collapsed 10 Hz -> ~1 Hz, and it never came back after
//    the churn stopped because the recovery gate tested the same inflated
//    number.
//
//    Modelled on what the runtime actually does (runtime.ts): sample at 10 Hz,
//    prune once a second to now - retention. Pruning is what makes the strings
//    collectable, so a harness that never prunes cannot see the fix either.
const CHURN_RETENTION_MS = 35_000
const CHURN_HZ = 10

function churnRing(seconds, { retitle }) {
  const ring = new SurfaceTimeline()
  const samples = seconds * CHURN_HZ
  for (let i = 0; i < samples; i += 1) {
    const timeMs = i * (1000 / CHURN_HZ)
    const second = Math.floor(timeMs / 1000)
    ring.append({
      timeMs,
      windows: Array.from({ length: stressWindows }, (_, w) => ({
        hwnd: String(1000 + w),
        ownerHwnd: '0',
        processId: 100 + w,
        zOrder: w,
        // Geometry is STILL, so the only thing growing is identity. That is the
        // isolation the old bench never had: any degradation seen here is
        // caused by titles and by nothing else.
        bounds: { x: w * 100, y: w * 50, width: 400, height: 300 },
        clientBounds: { x: w * 100, y: w * 50, width: 390, height: 280 },
        visible: true,
        minimized: false,
        foreground: w === 0,
        cloaked: false,
        // ONE window retitles once a second. Not all 24 — the report was a
        // single downloading browser, and the fix has to hold for that.
        windowTitle: retitle && w === 0 ? `Downloading ${second} of 4096 MB` : `window ${w}`,
        className: `Class${w}`,
        executableName: `app${w}.exe`,
      })),
    })
    // The runtime prunes on a 1 Hz maintenance timer; so does this.
    if (i % CHURN_HZ === 0) ring.prune(timeMs - CHURN_RETENTION_MS)
  }
  return ring
}

// 7a. Ten minutes of churn. The ring holds 35 s, so ~565 of the 600 titles are
//     unreachable from any live record and must not still be charged for.
const churned = churnRing(600, { retitle: true }).stats()
const quiet = churnRing(600, { retitle: false }).stats()
check(
  `ten minutes of one window retitling once a second stays inside the ceiling ` +
    `(${(churned.bytes / 1024).toFixed(0)} KB total, of which identity ` +
    `${(churned.identityBytes / 1024).toFixed(0)} KB)`,
  churned.bytes <= 512 * 1024,
  `${churned.bytes} bytes, identity ${churned.identityBytes}`,
)
check(
  `and the identity table is bounded by what is reachable, not by how long the ` +
    `app ran (${(churned.identityBytes / 1024).toFixed(1)} KB churning vs ` +
    `${(quiet.identityBytes / 1024).toFixed(1)} KB idle)`,
  churned.identityBytes <= 64 * 1024,
  `${churned.identityBytes} bytes after 600 retitles`,
)
check(
  'title churn alone never coarsens the sampling rate',
  churned.stride === 1,
  `stride ${churned.stride}, degraded ${churned.degradedSamples}, dropped ${churned.droppedSamples}`,
)

// 7b. THE RECOVERY, which is the half that was permanent. Churn, then stop, and
//     the ring must come back to full resolution rather than staying coarse for
//     the rest of the run.
const recovering = churnRing(300, { retitle: true })
const during = recovering.stats()
for (let i = 0; i < 300 * CHURN_HZ; i += 1) {
  const timeMs = 300_000 + i * (1000 / CHURN_HZ)
  recovering.append({
    timeMs,
    windows: Array.from({ length: stressWindows }, (_, w) => ({
      hwnd: String(1000 + w),
      ownerHwnd: '0',
      processId: 100 + w,
      zOrder: w,
      bounds: { x: w * 100, y: w * 50, width: 400, height: 300 },
      clientBounds: { x: w * 100, y: w * 50, width: 390, height: 280 },
      visible: true,
      minimized: false,
      foreground: w === 0,
      cloaked: false,
      windowTitle: `window ${w}`,
      className: `Class${w}`,
      executableName: `app${w}.exe`,
    })),
  })
  if (i % CHURN_HZ === 0) recovering.prune(timeMs - CHURN_RETENTION_MS)
}
const after = recovering.stats()
check(
  `the ring recovers full resolution once the churn stops ` +
    `(stride ${during.stride} during -> ${after.stride} after, identity ` +
    `${(during.identityBytes / 1024).toFixed(1)} KB -> ${(after.identityBytes / 1024).toFixed(1)} KB)`,
  after.stride === 1,
  `stride ${after.stride} after 5 minutes of quiet`,
)

// ---------------------------------------------------------------------------
// The numbers
// ---------------------------------------------------------------------------

const spanMs = last - first
const wireTotal = wireBytes.reduce((a, b) => a + b, 0)
console.log('')
console.log('lane S cost')
console.log(`  samples            ${samples.length} over ${(spanMs / 1000).toFixed(1)}s at ${intervalMs} ms`)
console.log(`  windows per sample ${finalStatus?.windows ?? 'n/a'}`)
console.log(
  `  sampling CPU       ${finalStatus === undefined ? 'n/a' : (finalStatus.sampleMs / finalStatus.samples).toFixed(3)} ms/sample` +
    `${finalStatus === undefined ? '' : ` = ${(finalStatus.dutyCycle * 100).toFixed(3)}% of one core`}`,
)
console.log(
  `  host process CPU   ${finalStatus === undefined ? 'n/a' : ((finalStatus.cpuMs / finalStatus.t) * 100).toFixed(2)}% of one core` +
    ` since start (includes PowerShell startup and the one-time C# compile)`,
)
// The RESIDENT cost, which is the number GOAL.md's "runs all day" promise is
// actually about: CPU burned between two status events, with startup excluded.
if (statuses.length >= 2) {
  const a = statuses[0]
  const b = statuses[statuses.length - 1]
  const span = b.t - a.t
  console.log(
    `  host steady state  ${(((b.cpuMs - a.cpuMs) / span) * 100).toFixed(2)}% of one core ` +
      `(over ${(span / 1000).toFixed(0)}s after startup)`,
  )
}
console.log(
  `  host working set   ${finalStatus === undefined ? 'n/a' : (finalStatus.ws / (1024 * 1024)).toFixed(1)} MB` +
    (statuses.length >= 2
      ? ` (${(statuses[0].ws / (1024 * 1024)).toFixed(1)} MB at ${(statuses[0].t / 1000).toFixed(0)}s → ` +
        `${(statuses[statuses.length - 1].ws / (1024 * 1024)).toFixed(1)} MB at ` +
        `${(statuses[statuses.length - 1].t / 1000).toFixed(0)}s)`
      : ''),
)
console.log(`  wire bytes         ${Math.round(wireTotal / samples.length)} B/sample (NDJSON on stdout)`)
console.log('')
console.log('ring memory')
console.log(`  total              ${(stats.bytes / 1024).toFixed(1)} KB for ${(spanMs / 1000).toFixed(1)}s`)
console.log(`    records          ${(stats.arenaBytes / 1024).toFixed(1)} KB`)
console.log(`    identity table   ${(stats.identityBytes / 1024).toFixed(1)} KB`)
console.log(`  checkpoints        ${stats.checkpoints} of ${stats.samples} samples`)
console.log(
  `  per second         ${(stats.bytes / (spanMs / 1000) / 1024).toFixed(2)} KB/s → ` +
    `${((stats.bytes / (spanMs / 1000)) * 30 / 1024).toFixed(1)} KB for a 30 s ring`,
)
console.log('')

if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
process.exit(0)

function toWindow(w) {
  return {
    hwnd: w.h,
    ownerHwnd: w.o,
    processId: w.p,
    zOrder: w.z,
    bounds: { x: w.b[0], y: w.b[1], width: w.b[2], height: w.b[3] },
    clientBounds: { x: w.c[0], y: w.c[1], width: w.c[2], height: w.c[3] },
    visible: w.v === 1,
    minimized: w.m === 1,
    foreground: w.g === 1,
    cloaked: w.k === 1,
    windowTitle: w.t,
    className: w.cl,
    executableName: w.e,
  }
}

/** The centre of the topmost non-desktop window in the last sample. */
function pickProbePoint(sample) {
  const desktop = new Set(['Progman', 'WorkerW'])
  const window =
    sample.w.find((w) => !desktop.has(w.cl) && w.m !== 1 && w.b[2] > 32 && w.b[3] > 32) ?? sample.w[0]
  return { x: window.b[0] + Math.floor(window.b[2] / 2), y: window.b[1] + Math.floor(window.b[3] / 2) }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
