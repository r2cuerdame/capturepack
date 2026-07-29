// Lane A — Core's side of the resident UI Automation tracker (#65, #111).
//
// WHAT IT IS FOR. Lane S records where WINDOWS are, ~100 times a second. Until
// this file existed, the controls INSIDE those windows were read exactly once,
// at the capture instant, and every earlier frame was served that one reading
// translated by how far the window had since moved (provider.ts `anchored`).
// That is exactly right for a window being DRAGGED and wrong for everything
// else — a list that scrolled, a pane that resized, a dialog that opened, a
// control that was never there at the instant the dump was taken.
//
// THE SHAPE OF THE DATA, and why it is a log rather than snapshots. The tracker
// sends a full `tree` when it walks a window (rare — a walk is ~980 ms for 400
// elements, measured on this desk) and a `rects` DELTA when a held reference's
// rectangle changed (~32 ms for the same 400, 81 us per element, 30.2x cheaper
// than re-walking). Keeping a full copy of every window's controls per delta
// would cost more memory than the ring it annotates, so what is kept is the
// tree plus an append-only change log, and `controlsAt` replays the log up to
// the asked time. Restores happen once per settled scrub, not per pointer move.
//
// WHAT THIS LANE MAY NEVER DO. It must not be able to slow a capture down or
// stop one (Rule 1), and it must cost less than what it observes (Rule 4). Both
// are structural here: the tracker is a SEPARATE process that paces itself to a
// 3% duty by sleeping in proportion to its own last pass (measured marginal
// rate 3.02% against a 3.0% target over a 45 s run), and everything on this
// side is event-driven bookkeeping. If the tracker dies, hangs, or is never
// started, every reader below simply sees no lane-A observations and the
// capture-instant dump answers exactly as it did before.
//
// 3% and not 5% because the design's 5% is the budget for the WHOLE context
// subsystem, and lane S already spends 1.11% of it.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { app } from 'electron'
import { logInfo, logWarn } from '../log'

/** One control, as the tracker walked it. Physical virtual-desktop pixels. */
export interface TrackedControl {
  name: string
  controlType: string
  automationId: string
  className: string
  x: number
  y: number
  width: number
  height: number
}

/** Everything one window's tree has done, as a replayable log. */
interface WindowLog {
  /** Full walks, ascending by time. A re-walk starts a new tree VERSION. */
  trees: { tMs: number; version: number; elements: TrackedControl[] }[]
  /** Rectangle changes, ascending by time, tagged with the tree they belong to. */
  moves: { tMs: number; version: number; index: number; x: number; y: number; width: number; height: number }[]
  /** Elements whose held reference died, so they stop being offered from then on. */
  deaths: { tMs: number; version: number; index: number }[]
}

/** What one window looked like inside, at one instant. */
export interface ControlsAt {
  hwnd: string
  controls: TrackedControl[]
}

export interface ControlLaneStatus {
  running: boolean
  /** The tracker's own duty cycle, from its status events — never a guess. */
  dutyCycle: number | null
  workingSetBytes: number | null
  trackedWindows: number
  blockedWindows: number
  /** Elements currently held by the tracker (its number, not ours). */
  liveElements: number
  /** Full walks and delta lines this lane has received. */
  trees: number
  moves: number
  deaths: number
  lastError: string | null
}

/**
 * How long a tracker line may be older than the retention window before it is
 * pruned. The lane keeps exactly as far back as the replay does, for the same
 * reason lane S does: a control position from before the buffer is a position
 * no frame can show.
 */
const PRUNE_INTERVAL_MS = 2_000

export class ControlLane {
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private nextId = 1
  private readonly logs = new Map<string, WindowLog>()
  private retentionMs: number
  private pruneTimer: ReturnType<typeof setInterval> | null = null
  private dutyCycle: number | null = null
  private workingSet: number | null = null
  private trackedWindows = 0
  private blockedWindows = 0
  private liveElements = 0
  private trees = 0
  private moves = 0
  private deaths = 0
  private lastError: string | null = null
  private lastSent = ''
  private readonly nowMs: () => number

  /**
   * `nowMs` is the SESSION clock — the same one lane S files against and the
   * same one a freeze range is expressed in. The tracker's own `t` is its
   * private stopwatch and is deliberately NOT used for filing: a second clock
   * in the ring is the #106 defect, and this lane has no reason to repeat it.
   * A tracker line is filed at the instant CORE READ IT, which is at most one
   * pipe hop old and needs no offset estimator to be honest about.
   */
  constructor(nowMs: () => number, retentionMs: number) {
    this.nowMs = nowMs
    this.retentionMs = Math.max(1_000, retentionMs)
  }

  start(): void {
    if (this.child !== null) return
    const script = trackerScriptPath()
    if (script === null) {
      logWarn('[context] lane A: tracker script not found — controls stay at the capture instant')
      return
    }
    try {
      this.child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      )
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      logWarn(`[context] lane A: the tracker could not be started: ${this.lastError}`)
      this.child = null
      return
    }
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.onChunk(chunk))
    // Rule 1: the tracker's own noise never reaches a capture. It is recorded
    // once so a broken lane is diagnosable, and then ignored.
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim()
      if (text !== '' && this.lastError === null) {
        this.lastError = text.slice(0, 200)
        logWarn(`[context] lane A: ${this.lastError}`)
      }
    })
    this.child.on('exit', (code) => {
      this.child = null
      if (code !== 0 && code !== null) {
        logWarn(`[context] lane A: the tracker exited with code ${code}`)
      }
    })
    this.child.on('error', (err) => {
      this.lastError = err.message
      this.child = null
    })
    this.send({ id: this.nextId++, method: 'hello' })
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS)
    this.pruneTimer.unref()
    logInfo('[context] lane A started — control geometry is tracked, not frozen at the capture instant')
  }

  stop(): void {
    if (this.pruneTimer !== null) clearInterval(this.pruneTimer)
    this.pruneTimer = null
    const child = this.child
    this.child = null
    if (child === null) return
    try {
      child.stdin.write(`${JSON.stringify({ id: this.nextId++, method: 'shutdown' })}\n`)
    } catch {
      // Already gone; the kill below is the backstop.
    }
    setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Nothing left to kill.
      }
    }, 300).unref()
  }

  setRetentionMs(ms: number): void {
    this.retentionMs = Math.max(1_000, ms)
  }

  /**
   * WHICH WINDOWS ARE WORTH LOOKING INSIDE — decided by lane S, never here.
   *
   * This is the design's "the expensive lane is driven by the cheap lane's
   * dirty signal, never the other way round" (docs/temporal-protocol.md §1),
   * and it is also what keeps lane A off windows the user cannot see: a fully
   * occluded window's controls cannot be hovered, so walking them is pure cost.
   *
   * Sending the same set twice is free and silent — the tracker replaces its
   * set wholesale, so a repeated list would drop and re-walk every tree.
   */
  setVisible(hwnds: readonly string[], focusHwnd: string | null): void {
    if (this.child === null) return
    const key = `${hwnds.join(',')}|${focusHwnd ?? ''}`
    if (key === this.lastSent) return
    this.lastSent = key
    this.send({
      id: this.nextId++,
      method: 'track',
      params: { hwnds: [...hwnds], ...(focusHwnd === null ? {} : { focus: focusHwnd }) },
    })
  }

  status(): ControlLaneStatus {
    return {
      running: this.child !== null,
      dutyCycle: this.dutyCycle,
      workingSetBytes: this.workingSet,
      trackedWindows: this.trackedWindows,
      blockedWindows: this.blockedWindows,
      liveElements: this.liveElements,
      trees: this.trees,
      moves: this.moves,
      deaths: this.deaths,
      lastError: this.lastError,
    }
  }

  /** True when any window has a tree — i.e. this lane has anything to say. */
  get hasObservations(): boolean {
    for (const log of this.logs.values()) if (log.trees.length > 0) return true
    return false
  }

  /**
   * What was inside each tracked window AT `tMs`, on the session clock.
   *
   * The log is replayed rather than interpolated: every rectangle returned was
   * READ from a live reference at or before the asked time. A control whose
   * reference had died by then is not returned at all — the honest answer to
   * "where is it" once it is gone is silence, not its last position.
   */
  controlsAt(tMs: number): ControlsAt[] {
    const out: ControlsAt[] = []
    for (const [hwnd, log] of this.logs) {
      // The newest tree at or before the asked time. A tree walked LATER
      // describes a window that had already changed, and using it would answer
      // this moment with a later moment's structure.
      let tree: WindowLog['trees'][number] | null = null
      for (const candidate of log.trees) {
        if (candidate.tMs > tMs) break
        tree = candidate
      }
      if (tree === null) continue
      const controls = tree.elements.map((e) => ({ ...e }))
      const dead = new Set<number>()
      for (const death of log.deaths) {
        if (death.tMs > tMs) break
        if (death.version === tree.version) dead.add(death.index)
      }
      for (const move of log.moves) {
        if (move.tMs > tMs) break
        if (move.version !== tree.version) continue
        const target = controls[move.index]
        if (target === undefined) continue
        target.x = move.x
        target.y = move.y
        target.width = move.width
        target.height = move.height
      }
      const live = controls.filter((_, i) => !dead.has(i))
      if (live.length > 0) out.push({ hwnd, controls: live })
    }
    return out
  }

  private send(message: Record<string, unknown>): void {
    const child = this.child
    if (child === null) return
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    } catch {
      // A tracker that cannot be written to is a tracker that is going away;
      // its exit handler clears the reference.
    }
  }

  private onChunk(chunk: string): void {
    this.buffer += chunk
    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line === '') continue
      let message: Record<string, unknown>
      try {
        message = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      this.onMessage(message)
    }
    // A tracker that somehow floods without newlines must not grow this
    // unbounded; the ring it feeds is bounded and so is this.
    if (this.buffer.length > 1 << 20) this.buffer = ''
  }

  private onMessage(message: Record<string, unknown>): void {
    const event = message['event']
    if (event === 'tree') return this.onTree(message)
    if (event === 'rects') return this.onRects(message)
    if (event === 'status') return this.onStatus(message)
    if (event === 'blocked') {
      logWarn(
        `[context] lane A: window ${String(message['h'])} dropped — it took ` +
          `${String(message['lastPassMs'])} ms a pass and would define this lane's latency`,
      )
      return
    }
    if (event === 'error') {
      this.lastError = String(message['message'] ?? 'unknown')
      return
    }
  }

  private onTree(message: Record<string, unknown>): void {
    const hwnd = asHandle(message['h'])
    const version = asInt(message['v'])
    const raw = message['e']
    if (hwnd === null || version === null || !Array.isArray(raw)) return
    const elements: TrackedControl[] = []
    for (const item of raw) {
      const control = parseControl(item)
      if (control !== null) elements.push(control)
    }
    const log = this.logFor(hwnd)
    log.trees.push({ tMs: this.nowMs(), version, elements })
    this.trees += 1
  }

  private onRects(message: Record<string, unknown>): void {
    const hwnd = asHandle(message['h'])
    const version = asInt(message['v'])
    if (hwnd === null || version === null) return
    const log = this.logFor(hwnd)
    const tMs = this.nowMs()
    const moved = message['e']
    if (Array.isArray(moved)) {
      for (const entry of moved) {
        if (!Array.isArray(entry) || entry.length < 5) continue
        const [i, x, y, w, h] = entry as number[]
        if (
          typeof i !== 'number' ||
          typeof x !== 'number' ||
          typeof y !== 'number' ||
          typeof w !== 'number' ||
          typeof h !== 'number'
        ) {
          continue
        }
        log.moves.push({ tMs, version, index: i, x, y, width: w, height: h })
        this.moves += 1
      }
    }
    const gone = message['g']
    if (Array.isArray(gone)) {
      for (const i of gone) {
        if (typeof i !== 'number') continue
        log.deaths.push({ tMs, version, index: i })
        this.deaths += 1
      }
    }
  }

  private onStatus(message: Record<string, unknown>): void {
    const duty = message['dutyCycle']
    if (typeof duty === 'number' && Number.isFinite(duty)) this.dutyCycle = duty
    const ws = message['ws']
    if (typeof ws === 'number' && Number.isFinite(ws)) this.workingSet = ws
    const tracked = asInt(message['tracked'])
    if (tracked !== null) this.trackedWindows = tracked
    const blocked = asInt(message['blocked'])
    if (blocked !== null) this.blockedWindows = blocked
    const elements = asInt(message['elements'])
    if (elements !== null) this.liveElements = elements
  }

  private logFor(hwnd: string): WindowLog {
    let log = this.logs.get(hwnd)
    if (log === undefined) {
      log = { trees: [], moves: [], deaths: [] }
      this.logs.set(hwnd, log)
    }
    return log
  }

  /**
   * Drops what retention no longer covers.
   *
   * The LAST tree at or before the cut is kept whatever its age: it is the base
   * every later delta is applied to, and dropping it would leave a window with
   * changes and nothing to change. This is the same rule the surface ring's
   * checkpoints follow, for the same reason.
   */
  private prune(): void {
    const cutoff = this.nowMs() - this.retentionMs
    for (const [hwnd, log] of this.logs) {
      let keepFrom = 0
      for (let i = 0; i < log.trees.length; i += 1) {
        const tree = log.trees[i]
        if (tree !== undefined && tree.tMs <= cutoff) keepFrom = i
        else break
      }
      if (keepFrom > 0) log.trees = log.trees.slice(keepFrom)
      const oldest = log.trees[0]
      if (oldest === undefined) {
        this.logs.delete(hwnd)
        continue
      }
      log.moves = log.moves.filter((m) => m.tMs >= cutoff || m.version >= oldest.version)
      log.deaths = log.deaths.filter((d) => d.tMs >= cutoff || d.version >= oldest.version)
    }
  }
}

function asHandle(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function asInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null
}

function parseControl(raw: unknown): TrackedControl | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as { b?: unknown; n?: unknown; c?: unknown; a?: unknown; k?: unknown }
  if (!Array.isArray(r.b) || r.b.length < 4) return null
  const [x, y, width, height] = r.b as number[]
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number'
  ) {
    return null
  }
  // A record missing its geometry is DROPPED rather than defaulted: a control
  // with an invented rectangle is worse than one that is not offered, because
  // it would be offered for picking.
  if (width < 1 || height < 1) return null
  return {
    x,
    y,
    width,
    height,
    name: typeof r.n === 'string' ? r.n : '',
    controlType: typeof r.c === 'string' ? r.c : '',
    automationId: typeof r.a === 'string' ? r.a : '',
    className: typeof r.k === 'string' ? r.k : '',
  }
}

/**
 * dist/scripts/uia-track.ps1 — copied there by scripts/build.mjs and kept out
 * of the asar (asarUnpack in electron-builder.yml), because powershell.exe
 * cannot open a file inside an archive.
 *
 * Deliberately the SAME resolution the context host uses (context/host.ts
 * `resolveHostScript`) rather than a second scheme of this lane's own: two
 * helpers that disagree about where their scripts live is a difference that
 * only ever shows up in a packaged build, which is the worst place to find it.
 * Returns null rather than guessing — a missing script means this lane never
 * starts, which is a documented, survivable state.
 */
function trackerScriptPath(): string | null {
  if (cachedTrackerPath !== undefined) return cachedTrackerPath
  let appPath: string
  try {
    appPath = app.getAppPath()
  } catch {
    // No Electron (the harnesses): the source tree is the only thing there is.
    appPath = process.cwd()
  }
  const packed = path.join(appPath, 'dist', 'scripts', 'uia-track.ps1')
  const unpacked = packed.replace(
    `${path.sep}app.asar${path.sep}`,
    `${path.sep}app.asar.unpacked${path.sep}`,
  )
  const source = path.join(appPath, 'scripts', 'uia-track.ps1')
  cachedTrackerPath = [unpacked, packed, source].find((c) => existsSync(c)) ?? null
  return cachedTrackerPath
}

let cachedTrackerPath: string | null | undefined
