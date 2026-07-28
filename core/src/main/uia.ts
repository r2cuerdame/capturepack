// Windows UI Automation dump (GOAL "Static object picking (v0 — before full
// tracking)", SPEC §11.3): at the capture trigger a short-lived PowerShell
// helper reads the top-level window list and the control trees of the top few
// windows in z-order, and the result becomes plugins/windows-uia/ plus the
// editor's pickable objects.
//
// TWO LEVELS. The WINDOW LIST is the guaranteed floor (GOAL: "windows are
// always selectable") — it covers every visible top-level window and costs one
// cheap enumeration, so the editor can always snap a box to the window under
// the cursor. CONTROL TREES only refine that floor where one exists, which is
// why they are budgeted per window and why every window records whether its
// tree was collected, truncated, unavailable, or never reached: the editor can
// then say "no object data for this window" instead of doing nothing.
//
// THREE HARD RULES, in this order of importance:
//  1. A capture must NEVER fail because of this. Every failure path — no
//     PowerShell, no script, a crash, malformed output, an empty tree — returns
//     null after ONE log line.
//  2. A capture must NEVER be slowed down by this. The helper is spawned first
//     and runs concurrently with the snapshot, the replay fetch, and save-first;
//     it is killed at UIA_BUDGET_MS no matter what it is doing.
//  3. It is READ-ONLY. The helper reads UI state; it never synthesizes input,
//     never touches a window, and never writes a file (see scripts/uia-dump.ps1).
//
// COORDINATES. The helper reports whatever coordinate space its own process
// sees — which Windows may have DPI-virtualized, and NOT uniformly: a
// system-DPI-aware client sees a monitor whose DPI differs from the system's
// scaled by (system DPI / monitor DPI). So the helper also reports every
// MONITOR's rectangle in that same space, and mapping onto the focused
// display's snapshot pixels (the annotation coordinate space, SPEC §8.2) is a
// per-monitor affine transform — `snapshot = (uia - monitor.origin) x
// (snapshot size / monitor size)` — which no virtualization can fool.
// `root_bounds` (the UIA desktop root = the primary display) is the cruder
// fallback for a helper that could not enumerate monitors.
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { gzipSync } from 'node:zlib'
import { app, screen } from 'electron'
import type { Rectangle } from 'electron'
import type {
  UiaBounds,
  UiaElementRecord,
  UiaPluginPayload,
  UiaTreeStatus,
  UiaWindowRecord,
} from '../shared/types'
import type { EditorUiaElement, EditorUiaWindow } from '../shared/ipc'

/** Hard budget: the helper is killed at this age, finished or not. */
export const UIA_BUDGET_MS = 1_200
/** Control-tree depth cap (each walked window itself is depth 0). */
const UIA_MAX_DEPTH = 12
/**
 * Soft element cap across ALL walked windows — an upper bound on payload size
 * and on editor index build cost. The helper raises it while budget is left
 * over, so a desktop of cheap trees is not cut off at a number chosen for the
 * expensive case.
 */
const UIA_MAX_ELEMENTS = 3_000
/**
 * How many windows may be walked at all, top of the z-order first. The window
 * LIST is not capped by this (it is the floor and costs one enumeration) — only
 * the control trees are, and every window past it is reported as "skipped"
 * rather than looking like a window without controls.
 *
 * Deliberately ABOVE what the budget can afford, so the TIME budget is the only
 * thing that ever cuts: a 12-window desk measured 12 trees / ~800 elements /
 * ~580 ms of the 1 200 ms budget — i.e. the old cap of 12 was co-binding with
 * the deadline, and one more open window silently cost a whole tree even when
 * there was time for it. A window the budget cannot afford is already reported
 * as "skipped" and the editor now says so (SPEC §11.3), so the cap only needs
 * to stop a pathological desktop from being enumerated forever.
 */
const UIA_MAX_WINDOWS = 24
/** Grace after the kill signal before the promise resolves without the child. */
const UIA_KILL_GRACE_MS = 300

/** One display as the helper process saw it — the mapping yardstick. */
export interface UiaMonitor {
  // Windows device name, e.g. "\\\\.\\DISPLAY1" (diagnostics; matching is geometric).
  device: string
  primary: boolean
  bounds: UiaBounds
}

/** The helper's own output, still in ITS coordinate space. */
export interface UiaRawDump {
  capturedAt: Date
  truncated: boolean
  // The UIA desktop root rectangle (= the primary display) as the helper saw
  // it; null when it could not be read (the mapping then assumes scale 1).
  rootBounds: UiaBounds | null
  // Every display in the helper's space; empty when it could not enumerate them.
  monitors: UiaMonitor[]
  windows: UiaWindowRecord[]
  elements: UiaElementRecord[]
}

/** The display an element dump is mapped onto: the FOCUSED display's snapshot. */
export interface UiaSnapshotTarget {
  // Electron display.bounds (device-independent pixels) of the focused display.
  bounds: Rectangle
  // The focused display's snapshot size in pixels — literally what snapshot.png
  // is, so the mapped coordinates are the annotation coordinate space.
  width: number
  height: number
}

/**
 * Spawns the helper and resolves its raw dump — or null when there is nothing
 * usable. NEVER rejects and never throws: the caller starts this and forgets
 * about it until the payload is needed.
 */
export function startUiaDump(): Promise<UiaRawDump | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  const command = encodedHelperCommand()
  if (command === null) {
    logOnce('uia: helper script not found; continuing without object data')
    return Promise.resolve(null)
  }
  const startedAt = new Date()
  // ONE origin for both budgets: the helper's own soft budget is computed from
  // this absolute instant, so powershell.exe's startup is charged to the
  // helper's remaining time instead of being invisible to it (a cold start can
  // exceed the whole budget, and a stopwatch started inside the script would
  // happily keep walking past the kill below).
  const deadlineAtMs = Date.now() + UIA_BUDGET_MS
  return new Promise<UiaRawDump | null>((resolve) => {
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    const done = (dump: UiaRawDump | null, reason?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      clearTimeout(graceTimer)
      if (reason !== undefined) logOnce(`uia: ${reason}; continuing without object data`)
      resolve(dump)
    }

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          // UI Automation clients are happiest on an STA thread.
          '-STA',
          // NOT -File: PowerShell's execution policy governs script FILES, and
          // it resolves by scope precedence — MachinePolicy and UserPolicy beat
          // the -ExecutionPolicy switch (which only sets the Process scope). On
          // a domain-joined machine with an AllSigned/Restricted policy the
          // unsigned helper would simply be refused, silently turning object
          // picking off forever. A command is not a script file, so this runs
          // regardless of policy — and it reads the helper through Electron's
          // own fs, so the archive it ships in stops mattering too.
          '-EncodedCommand',
          command,
        ],
        {
          windowsHide: true,
          // The helper's parameters (a command string cannot carry a param()
          // block), including the shared hard deadline.
          env: {
            ...process.env,
            CAPTUREPACK_UIA_DEADLINE: String(deadlineAtMs),
            CAPTUREPACK_UIA_BUDGET_MS: String(UIA_BUDGET_MS),
            CAPTUREPACK_UIA_MAX_DEPTH: String(UIA_MAX_DEPTH),
            CAPTUREPACK_UIA_MAX_ELEMENTS: String(UIA_MAX_ELEMENTS),
            CAPTUREPACK_UIA_MAX_WINDOWS: String(UIA_MAX_WINDOWS),
          },
        },
      )
    } catch (err) {
      done(null, `helper could not be started (${errorMessage(err)})`)
      return
    }
    // Rule 1, the last hole in it: an 'error' event on a stdio stream with no
    // listener is an unhandled EventEmitter error, i.e. an uncaughtException
    // that would take the whole tray app down — hotkey and MCP server included.
    // A powershell.exe that dies during launch (AppLocker/WDAC denial, AV
    // termination, a machine mid-shutdown) breaks the stdin pipe end() is
    // closing right now. Object picking must never be able to do that.
    child.stdin.on('error', () => {})
    child.stdout.on('error', () => {})
    child.stderr.on('error', () => {})
    // The helper never reads stdin (-NonInteractive); closing it keeps a
    // dangling pipe from holding the child open.
    child.stdin.end()

    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (err) => done(null, `helper failed (${errorMessage(err)})`))

    // Rule 2: the child dies at the budget whatever it is doing. Because it
    // prints the window list BEFORE walking any control tree, and then one line
    // per finished window, a kill mid-walk still leaves everything collected so
    // far on stdout — only the window in flight is lost.
    let killed = false
    killTimer = setTimeout(() => {
      killed = true
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      // Resolve from whatever was printed even if 'close' never arrives — the
      // window list and every finished window are already on stdout, so a kill
      // mid-walk still pays.
      graceTimer = setTimeout(() => {
        const partial = parseDump(stdout, startedAt, true)
        done(partial, partial === null ? `helper exceeded its ${UIA_BUDGET_MS} ms budget` : undefined)
      }, UIA_KILL_GRACE_MS)
    }, UIA_BUDGET_MS)

    child.on('close', (code) => {
      const dump = parseDump(stdout, startedAt, killed)
      if (dump !== null) {
        done(dump)
        return
      }
      const detail = killed
        ? `helper exceeded its ${UIA_BUDGET_MS} ms budget`
        : `helper produced no usable output (exit ${String(code)}${stderr.trim() === '' ? '' : `: ${firstLine(stderr)}`})`
      done(null, detail)
    })
  })
}

/**
 * Maps a raw dump into the pack payload: every rectangle in the FOCUSED
 * display's snapshot pixels (SPEC §8.2, §11.3). Elements from other displays
 * keep their (out-of-frame) positions rather than being dropped — they are
 * still context, and the editor simply never picks them.
 */
export function mapUiaToSnapshot(
  raw: UiaRawDump,
  target: UiaSnapshotTarget,
  budgetMs: number = UIA_BUDGET_MS,
): UiaPluginPayload {
  const map = buildMapper(raw, target)
  return {
    captured_at: isoWithOffset(raw.capturedAt),
    budget_ms: budgetMs,
    truncated: raw.truncated,
    windows: raw.windows.map((w) => ({ ...w, bounds: map(w.bounds) })),
    elements: raw.elements.map((e) => ({ ...e, bounds: map(e.bounds) })),
  }
}

/** The pickable CONTROLS the editor receives (SPEC §8.7 target fields). */
export function editorUiaElements(payload: UiaPluginPayload | null): EditorUiaElement[] {
  if (payload === null) return []
  return payload.elements.map((e) => ({
    name: e.name,
    control_type: e.control_type,
    automation_id: e.automation_id,
    class_name: e.class_name,
    bounds: { ...e.bounds },
    window: e.window,
  }))
}

/**
 * The pickable WINDOWS the editor receives — the floor of object picking (GOAL:
 * "windows are always selectable").
 *
 * `hasControls` is derived from the elements that actually came back rather
 * than from the recorded tree status, so it stays true for a pack written
 * before per-window statuses existed: in such a pack every element belongs to
 * the foreground window, which is exactly the legacy branch below.
 *
 * `tree` travels UNCHANGED alongside it. The two answer different questions and
 * SPEC §11.3 requires both: hasControls says whether anything was recorded HERE,
 * `tree` says whether the window's tree was READ at all — and a reader must
 * report a window that was never walked as *no data recorded*, never as *no
 * objects*.
 */
export function editorUiaWindows(payload: UiaPluginPayload | null): EditorUiaWindow[] {
  if (payload === null) return []
  const legacy = payload.elements.length > 0 && payload.elements.every((e) => e.window < 0)
  const counts = new Map<number, number>()
  for (const e of payload.elements) {
    if (e.window < 0) continue
    counts.set(e.window, (counts.get(e.window) ?? 0) + 1)
  }
  return payload.windows.map((w, index) => {
    const z = Number.isInteger(w.z) && w.z >= 0 ? w.z : index
    const controls = (counts.get(z) ?? 0) + (legacy && w.focused ? payload.elements.length : 0)
    return {
      title: w.title,
      process: w.process,
      class_name: w.class_name,
      bounds: { ...w.bounds },
      focused: w.focused,
      z,
      hasControls: controls > 0,
      tree: w.tree,
    }
  })
}

/**
 * Entry-level validation of a plugins/windows-uia/elements.json read back from
 * a pack. Fields added after 0.1.0 (class_name/z/tree/element_count on a
 * window, window on an element) are filled with the honest defaults for a pack
 * that predates them, so re-editing an old pack keeps working exactly as it
 * did — with picking now also offering its window list.
 */
export function parseUiaPayload(text: string | null): UiaPluginPayload | null {
  if (text === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const raw = parsed as Partial<UiaPluginPayload>
  // Read as unknown: the file is whatever was on disk, not a UiaPluginPayload
  // until every entry has been checked and defaulted.
  const rawWindows: unknown[] = Array.isArray(raw.windows) ? raw.windows : []
  const rawElements: unknown[] = Array.isArray(raw.elements) ? raw.elements : []
  const windows = rawWindows.filter(isWindowShape).map(toWindowRecord)
  const elements = rawElements.filter(isElementShape).map((e) => toElementRecord(e, -1))
  if (windows.length === 0 && elements.length === 0) return null
  return {
    captured_at: typeof raw.captured_at === 'string' ? raw.captured_at : '',
    budget_ms: typeof raw.budget_ms === 'number' ? raw.budget_ms : UIA_BUDGET_MS,
    truncated: raw.truncated === true,
    windows,
    elements,
  }
}

// ---------------------------------------------------------------------------
// Coordinate mapping
// ---------------------------------------------------------------------------

/**
 * uia space -> focused-display snapshot pixels.
 *
 * PREFERRED: the helper's rectangle for the focused MONITOR, which turns the
 * mapping into `(uia - monitor.origin) x (snapshot size / monitor size)`. Exact
 * whatever DPI awareness the helper ended up with, and correct on mixed-DPI
 * desktops where a single global scale is not.
 *
 * FALLBACK (no monitor list): treat the whole desktop as uniformly virtualized
 * about the primary display's origin — root_bounds IS the primary display in
 * the helper's space, so its width against the primary's real physical width is
 * that factor (1 for a fully DPI-aware helper).
 */
function buildMapper(raw: UiaRawDump, target: UiaSnapshotTarget): (b: UiaBounds) => UiaBounds {
  const monitor = matchMonitor(raw.monitors, target.bounds)
  if (monitor !== null && target.width > 0 && target.height > 0) {
    const sx = target.width / monitor.bounds.width
    const sy = target.height / monitor.bounds.height
    return (b) => ({
      x: Math.round((b.x - monitor.bounds.x) * sx),
      y: Math.round((b.y - monitor.bounds.y) * sy),
      width: Math.max(0, Math.round(b.width * sx)),
      height: Math.max(0, Math.round(b.height * sy)),
    })
  }
  const focusedPhysical = toPhysicalRect(target.bounds)
  let scale = 1
  if (raw.rootBounds !== null && raw.rootBounds.width > 0) {
    const primaryPhysical = toPhysicalRect(screen.getPrimaryDisplay().bounds)
    const candidate = primaryPhysical.width / raw.rootBounds.width
    // A sane virtualization factor only; anything else means the assumption
    // broke and 1:1 is the safer answer than a wildly wrong one.
    if (Number.isFinite(candidate) && candidate >= 0.25 && candidate <= 4) scale = candidate
  }
  return (b) => ({
    x: Math.round(b.x * scale - focusedPhysical.x),
    y: Math.round(b.y * scale - focusedPhysical.y),
    width: Math.max(0, Math.round(b.width * scale)),
    height: Math.max(0, Math.round(b.height * scale)),
  })
}

/**
 * The helper monitor that IS the focused display.
 *
 * The two lists describe the same non-overlapping tiling of the same desktop,
 * so sorting each by (x, y) pairs them positionally — per-monitor scaling moves
 * the edges but never reorders them. The primary flag and the aspect ratio are
 * then checked as a guard: a mismatch means the assumption broke and the caller
 * gets the cruder fallback rather than confidently wrong coordinates.
 */
function matchMonitor(monitors: readonly UiaMonitor[], focusedBounds: Rectangle): UiaMonitor | null {
  const usable = monitors.filter((m) => m.bounds.width > 0 && m.bounds.height > 0)
  if (usable.length === 0) return null
  const displays = screen.getAllDisplays()
  const primaryId = screen.getPrimaryDisplay().id
  const focused = displays.find(
    (d) => d.bounds.x === focusedBounds.x && d.bounds.y === focusedBounds.y,
  )
  const focusedIsPrimary = focused !== undefined && focused.id === primaryId
  // Single monitor, or the focused display is the primary: no ambiguity at all.
  if (usable.length === 1) return displays.length === 1 ? (usable[0] ?? null) : null
  if (focusedIsPrimary) {
    const primaryMonitor = usable.find((m) => m.primary)
    if (primaryMonitor !== undefined && aspectMatches(primaryMonitor, focusedBounds)) {
      return primaryMonitor
    }
    return null
  }
  if (focused === undefined || usable.length !== displays.length) return null
  const byPosition = <T>(items: readonly T[], at: (item: T) => { x: number; y: number }): T[] =>
    [...items].sort((a, b) => at(a).x - at(b).x || at(a).y - at(b).y)
  const sortedMonitors = byPosition(usable, (m) => m.bounds)
  const sortedDisplays = byPosition(displays, (d) => d.bounds)
  const index = sortedDisplays.findIndex((d) => d.id === focused.id)
  const candidate = index < 0 ? undefined : sortedMonitors[index]
  if (candidate === undefined) return null
  if (candidate.primary !== (focused.id === primaryId)) return null
  return aspectMatches(candidate, focusedBounds) ? candidate : null
}

/** Guard on a positional match: the same monitor cannot change shape. */
function aspectMatches(monitor: UiaMonitor, bounds: Rectangle): boolean {
  if (bounds.width <= 0 || bounds.height <= 0) return false
  const a = monitor.bounds.width / monitor.bounds.height
  const b = bounds.width / bounds.height
  return Math.abs(a - b) <= 0.02 * Math.max(a, b)
}

/** A display's device-independent rectangle in physical screen pixels. */
function toPhysicalRect(bounds: Rectangle): Rectangle {
  try {
    return screen.dipToScreenRect(null, bounds)
  } catch {
    // Non-Windows (where this module never runs) or an Electron without the
    // Windows-only conversion: the DIP rect is the best available answer.
    return bounds
  }
}

// ---------------------------------------------------------------------------
// Helper process plumbing
// ---------------------------------------------------------------------------

let cachedScriptPath: string | null | undefined
let cachedCommand: string | null | undefined

/**
 * dist/scripts/uia-dump.ps1 — copied there by scripts/build.mjs. Read through
 * Node's (asar-aware) fs, so both the packed and the unpacked copy work.
 */
function resolveHelperScript(): string | null {
  if (cachedScriptPath !== undefined) return cachedScriptPath
  const packed = path.join(app.getAppPath(), 'dist', 'scripts', 'uia-dump.ps1')
  const unpacked = packed.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
  cachedScriptPath = [unpacked, packed].find((candidate) => existsSync(candidate)) ?? null
  return cachedScriptPath
}

/**
 * The helper as a -EncodedCommand argument: a tiny bootstrap that inflates the
 * gzipped script and runs it as a scriptblock.
 *
 * Why not the script text itself: a Windows command line caps at ~32 767
 * characters and UTF-16LE base64 nearly triples the source, which the helper
 * comfortably exceeds. Gzipping first keeps the whole thing around 20 KB.
 *
 * Built ONCE (a capture must never pay for a file read + compress at the
 * trigger); a failure caches null and object picking stays silently off.
 */
function encodedHelperCommand(): string | null {
  if (cachedCommand !== undefined) return cachedCommand
  const script = resolveHelperScript()
  if (script === null) {
    cachedCommand = null
    return null
  }
  try {
    const payload = gzipSync(readFileSync(script), { level: 9 }).toString('base64')
    const bootstrap =
      `$ErrorActionPreference='Stop';` +
      `$b=[Convert]::FromBase64String('${payload}');` +
      `$ms=New-Object System.IO.MemoryStream(,$b);` +
      `$gz=New-Object System.IO.Compression.GzipStream($ms,[System.IO.Compression.CompressionMode]::Decompress);` +
      `$sr=New-Object System.IO.StreamReader($gz,[System.Text.Encoding]::UTF8);` +
      `$code=$sr.ReadToEnd();$sr.Close();` +
      `& ([scriptblock]::Create($code))`
    cachedCommand = Buffer.from(bootstrap, 'utf16le').toString('base64')
  } catch (err) {
    logOnce(`uia: helper script could not be read (${errorMessage(err)})`)
    cachedCommand = null
  }
  return cachedCommand
}

/**
 * The helper prints NDJSON, flushing each line the moment it is complete:
 *
 *   1. `{root_bounds, monitors, windows}` — always, before anything expensive
 *   2. one `{window, tree, elements}` line per window whose tree was attempted
 *   3. `{done:true, truncated, …}`
 *
 * So a kill only ever costs the window in flight. A missing `done` line means
 * the walk did not finish: every window that got no line of its own is
 * "skipped" — no object data was collected for it, which is NOT the claim that
 * it has no objects — and the dump as a whole is marked truncated.
 */
function parseDump(stdout: string, capturedAt: Date, killed: boolean): UiaRawDump | null {
  let rootBounds: UiaBounds | null = null
  let monitors: UiaMonitor[] = []
  let windows: UiaWindowRecord[] = []
  const elements: UiaElementRecord[] = []
  const trees = new Map<number, { status: UiaTreeStatus; count: number }>()
  let sawWindows = false
  let sawDone = false
  let truncated = false
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue // a partial line from a killed helper
    }
    if (parsed === null || typeof parsed !== 'object') continue
    const record = parsed as Record<string, unknown>
    if (Array.isArray(record['windows'])) {
      sawWindows = true
      windows = record['windows'].filter(isWindowShape).map(toWindowRecord)
      rootBounds = isBounds(record['root_bounds']) ? record['root_bounds'] : null
      monitors = Array.isArray(record['monitors']) ? record['monitors'].filter(isMonitor) : []
      continue
    }
    if (record['done'] === true) {
      sawDone = true
      if (record['truncated'] === true) truncated = true
      continue
    }
    if (Array.isArray(record['elements'])) {
      // A helper old enough not to name its window (impossible in a shipped
      // build — the script is copied in beside the app — but a chunk without an
      // index is still real data) walked the foreground window only.
      const index = typeof record['window'] === 'number' ? record['window'] : -1
      const chunk = record['elements']
        .filter(isElementShape)
        .map((e) => toElementRecord(e, index))
      for (const element of chunk) elements.push(element)
      if (index >= 0) {
        trees.set(index, { status: treeStatus(record['tree']), count: chunk.length })
      }
    }
  }
  if (!sawWindows && elements.length === 0) return null
  if (!sawDone) truncated = true
  if (killed) truncated = true
  // Every window the walk never reached keeps its "skipped" default: the dump
  // says so per window, so nothing downstream has to guess.
  windows = windows.map((w) => {
    const tree = trees.get(w.z)
    return tree === undefined ? w : { ...w, tree: tree.status, element_count: tree.count }
  })
  return { capturedAt, truncated, rootBounds, monitors, windows, elements }
}

const TREE_STATUSES: readonly UiaTreeStatus[] = ['collected', 'truncated', 'unavailable', 'skipped']

function treeStatus(value: unknown): UiaTreeStatus {
  return typeof value === 'string' && (TREE_STATUSES as readonly string[]).includes(value)
    ? (value as UiaTreeStatus)
    : 'skipped'
}

function isMonitor(value: unknown): value is UiaMonitor {
  if (value === null || typeof value !== 'object') return false
  const m = value as Record<string, unknown>
  return typeof m['device'] === 'string' && typeof m['primary'] === 'boolean' && isBounds(m['bounds'])
}

function isBounds(value: unknown): value is UiaBounds {
  if (value === null || typeof value !== 'object') return false
  const b = value as Record<string, unknown>
  return (
    typeof b['x'] === 'number' &&
    typeof b['y'] === 'number' &&
    typeof b['width'] === 'number' &&
    typeof b['height'] === 'number'
  )
}

/**
 * The fields a window record has ALWAYS had. Everything added since (class
 * name, z-order, tree status) is optional here and defaulted by
 * toWindowRecord(), so one code path reads both a fresh dump and a pack written
 * before those fields existed.
 */
function isWindowShape(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const w = value as Record<string, unknown>
  return typeof w['title'] === 'string' && typeof w['process'] === 'string' && isBounds(w['bounds'])
}

function toWindowRecord(raw: Record<string, unknown>, index: number): UiaWindowRecord {
  const z = raw['z']
  return {
    title: raw['title'] as string,
    process: raw['process'] as string,
    class_name: typeof raw['class_name'] === 'string' ? raw['class_name'] : '',
    bounds: raw['bounds'] as UiaBounds,
    focused: raw['focused'] === true,
    // The array order IS the z-order; the field only makes it explicit for
    // readers that reorder or filter the list.
    z: typeof z === 'number' && Number.isInteger(z) && z >= 0 ? z : index,
    tree: treeStatus(raw['tree']),
    element_count: countOf(raw['element_count']),
  }
}

function isElementShape(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const e = value as Record<string, unknown>
  return (
    typeof e['name'] === 'string' &&
    typeof e['control_type'] === 'string' &&
    typeof e['automation_id'] === 'string' &&
    typeof e['class_name'] === 'string' &&
    typeof e['depth'] === 'number' &&
    isBounds(e['bounds'])
  )
}

/** `fallbackWindow` is used when the record does not name its window (-1 = unknown). */
function toElementRecord(raw: Record<string, unknown>, fallbackWindow: number): UiaElementRecord {
  const window = raw['window']
  return {
    name: raw['name'] as string,
    control_type: raw['control_type'] as string,
    automation_id: raw['automation_id'] as string,
    class_name: raw['class_name'] as string,
    bounds: raw['bounds'] as UiaBounds,
    depth: raw['depth'] as number,
    window: typeof window === 'number' && Number.isInteger(window) && window >= 0 ? window : fallbackWindow,
  }
}

function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}

/** Local time as ISO 8601 with the machine's UTC offset (same shape as manifest.created_at). */
function isoWithOffset(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const offsetMin = -date.getTimezoneOffset()
  const sign = offsetMin < 0 ? '-' : '+'
  const absMin = Math.abs(offsetMin)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(absMin / 60))}:${pad(absMin % 60)}`
  )
}

// One line per distinct reason: object picking is a best-effort extra, and a
// machine where it never works must not fill the log on every capture.
const loggedReasons = new Set<string>()
function logOnce(message: string): void {
  if (loggedReasons.has(message)) return
  loggedReasons.add(message)
  console.warn(`capturepack: ${message}`)
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? ''
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
