// Isolated #240 workload: real lane bookkeeping, synthetic tracker protocol.
// No Electron app, UIA provider, desktop capture, encoder, or forced GC.
import { ControlLane } from '../src/main/context/controlLane'
import { setTimeout as delay } from 'node:timers/promises'

type HeldLog = { trees: { elements: unknown[]; tMs: number }[]; moves: unknown[]; deaths: unknown[] }
interface Inspectable {
  onMessage(message: Record<string, unknown>): void
  prune(): void
  logs: Map<string, HeldLog>
}

async function main(): Promise<void> {
  const quick = process.argv.includes('--quick')
  let now = 0
  const lane = new ControlLane(() => now, 30_000)
  const internal = lane as unknown as Inspectable
  const emit = (value: unknown): void => { console.log(JSON.stringify(value)) }
  const tree = (hwnd: string): void => internal.onMessage({
    event: 'tree', h: hwnd, v: 1,
    e: Array.from({ length: 64 }, (_, i) => ({
      b: [i, i, 100, 40], n: `Control ${i}`, c: 'Button', a: `id-${i}`, k: 'Button',
    })),
  })
  let transient = '2'
  lane.setVisible(['1', transient], transient)
  tree('1') // This unchanged, still-visible tree must survive the entire run.
  tree(transient)
  let pruneVisits = 0
  let copiedElements = 0
  let createdWindows = 2
  let pruneUs = 0
  function snapshot(phase: string): void {
    const logs = [...internal.logs.values()]
    if (phase !== 'retired') {
      const restored = lane.controlsAt(now)
      for (const hwnd of ['1', transient]) {
        const held = restored.find(row => row.hwnd === hwnd)
        if (held?.controls.length !== 64 || held.controls[63]?.name !== 'Control 63') {
          throw new Error(`visible window ${hwnd} lost its unchanged control tree`)
        }
      }
    }
    emit({
      type: 'checkpoint', phase, simulatedMs: now, pid: process.pid,
      createdWindows, retainedWindows: logs.length,
      retainedTrees: logs.reduce((n, log) => n + log.trees.length, 0),
      retainedElements: logs.reduce((n, log) => n + log.trees.reduce((m, t) => m + t.elements.length, 0), 0),
      retainedMoves: logs.reduce((n, log) => n + log.moves.length, 0),
      retainedDeaths: logs.reduce((n, log) => n + log.deaths.length, 0),
      // Deterministic work counts at the production prune boundary. Expired
      // windows removed by the fix are included in visits, but not copied.
      pruneVisits, copiedElements, pruneUs,
      memory: process.memoryUsage(), cpu: process.cpuUsage(),
      resources: {
        captureSurfaces: 0, capturedFrames: 0, encodedRingBytes: 0,
        encoderSessions: 0, rendererWorkers: 0,
        note: 'Synthetic control history only; capture/GPU/encoder paths are not exercised.',
      },
    })
  }
  emit({ type: 'ready', pid: process.pid })
  if (!quick) await delay(1500) // Let the independent OS sampler attach.
  snapshot('cold')
  const end = quick ? 120_000 : 7_200_000
  for (now = 2_000; now <= end; now += 2_000) {
    if (now % 10_000 === 0) {
      transient = String(++createdWindows)
      lane.setVisible(['1', transient], transient)
      tree(transient)
    }
    pruneVisits += internal.logs.size
    const before = new Map([...internal.logs].map(([h, log]) => [h, log.trees[0]?.elements]))
    const started = process.hrtime.bigint()
    internal.prune()
    pruneUs += Number(process.hrtime.bigint() - started) / 1000
    if (!process.argv.includes('--observe-only') && internal.logs.size > 6) {
      throw new Error(`window retention overflow at ${now}ms: ${internal.logs.size}`)
    }
    for (const [hwnd, log] of internal.logs) {
      const first = log.trees[0]
      if (first !== undefined && first.elements !== before.get(hwnd)) copiedElements += first.elements.length
    }
    if (now % (quick ? 30_000 : 900_000) === 0) {
      snapshot('churn')
      if (!quick) await delay(1000)
    }
  }
  now = end + 32_000
  lane.setVisible([], null)
  now += 32_000
  internal.prune()
  snapshot('retired')
  // Exposes GREEN to CI without treating noisy CPU/memory as exact counts.
  if (!process.argv.includes('--observe-only') && internal.logs.size !== 0) {
    throw new Error(`expired windows remain: ${internal.logs.size}`)
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
