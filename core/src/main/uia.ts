// Windows UI Automation dump (GOAL "Static object picking (v0 — before full
// tracking)", SPEC §11.3): at the capture trigger a short-lived PowerShell
// helper reads the window list and the FOREGROUND window's control tree, and
// the result becomes plugins/windows-uia/ plus the editor's pickable objects.
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
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { app, screen } from 'electron'
import type { Rectangle } from 'electron'
import type {
  UiaBounds,
  UiaElementRecord,
  UiaPluginPayload,
  UiaWindowRecord,
} from '../shared/types'
import type { EditorUiaElement } from '../shared/ipc'

/** Hard budget: the helper is killed at this age, finished or not. */
export const UIA_BUDGET_MS = 1_200
/** Control-tree depth cap (the foreground window itself is depth 0). */
const UIA_MAX_DEPTH = 12
/** Element cap — an upper bound on payload size and on editor index build cost. */
const UIA_MAX_ELEMENTS = 3_000
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
  const script = resolveHelperScript()
  if (script === null) {
    logOnce('uia: helper script not found; continuing without object data')
    return Promise.resolve(null)
  }
  const startedAt = new Date()
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
          // The helper ships with the app; a restrictive machine policy must not
          // silently disable object picking.
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
          '-BudgetMs',
          String(UIA_BUDGET_MS),
          '-MaxDepth',
          String(UIA_MAX_DEPTH),
          '-MaxElements',
          String(UIA_MAX_ELEMENTS),
        ],
        { windowsHide: true },
      )
    } catch (err) {
      done(null, `helper could not be started (${errorMessage(err)})`)
      return
    }
    // The helper never reads stdin (-NonInteractive, -File); closing it keeps a
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
    // prints the window list BEFORE walking the control tree, a kill mid-walk
    // still leaves usable output on stdout.
    let killed = false
    killTimer = setTimeout(() => {
      killed = true
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      // Resolve from whatever was printed even if 'close' never arrives — the
      // window list is printed before the walk, so a kill mid-walk still pays.
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

/** The pickable-object list the editor receives (SPEC §8.7 target fields). */
export function editorUiaElements(payload: UiaPluginPayload | null): EditorUiaElement[] {
  if (payload === null) return []
  return payload.elements.map((e) => ({
    name: e.name,
    control_type: e.control_type,
    automation_id: e.automation_id,
    class_name: e.class_name,
    bounds: { ...e.bounds },
  }))
}

/** Entry-level validation of a plugins/windows-uia/elements.json read back from a pack. */
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
  const windows = Array.isArray(raw.windows) ? raw.windows.filter(isWindowRecord) : []
  const elements = Array.isArray(raw.elements) ? raw.elements.filter(isElementRecord) : []
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

/**
 * dist/scripts/uia-dump.ps1 — copied there by scripts/build.mjs and kept OUT of
 * the asar (electron-builder asarUnpack), because PowerShell cannot read a file
 * inside an archive.
 */
function resolveHelperScript(): string | null {
  if (cachedScriptPath !== undefined) return cachedScriptPath
  const packed = path.join(app.getAppPath(), 'dist', 'scripts', 'uia-dump.ps1')
  const unpacked = packed.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
  cachedScriptPath = [unpacked, packed].find((candidate) => existsSync(candidate)) ?? null
  return cachedScriptPath
}

/**
 * The helper prints NDJSON: line 1 is `{root_bounds, monitors, windows}`
 * (always, before the expensive walk), line 2 is `{elements, truncated}`. A
 * missing or unparsable line 2 means the walk did not finish — the window list
 * still stands, and the dump is marked truncated.
 */
function parseDump(stdout: string, capturedAt: Date, killed: boolean): UiaRawDump | null {
  let rootBounds: UiaBounds | null = null
  let monitors: UiaMonitor[] = []
  let windows: UiaWindowRecord[] = []
  let elements: UiaElementRecord[] = []
  let sawWindows = false
  let sawElements = false
  let truncated = false
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue // a partial final line from a killed helper
    }
    if (parsed === null || typeof parsed !== 'object') continue
    const record = parsed as Record<string, unknown>
    if (Array.isArray(record['windows'])) {
      sawWindows = true
      windows = record['windows'].filter(isWindowRecord)
      rootBounds = isBounds(record['root_bounds']) ? record['root_bounds'] : null
      monitors = Array.isArray(record['monitors']) ? record['monitors'].filter(isMonitor) : []
    }
    if (Array.isArray(record['elements'])) {
      sawElements = true
      elements = record['elements'].filter(isElementRecord)
      if (record['truncated'] === true) truncated = true
    }
  }
  if (!sawWindows && !sawElements) return null
  if (!sawElements) truncated = true
  if (killed) truncated = true
  return { capturedAt, truncated, rootBounds, monitors, windows, elements }
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

function isWindowRecord(value: unknown): value is UiaWindowRecord {
  if (value === null || typeof value !== 'object') return false
  const w = value as Record<string, unknown>
  return typeof w['title'] === 'string' && typeof w['process'] === 'string' && isBounds(w['bounds'])
}

function isElementRecord(value: unknown): value is UiaElementRecord {
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
