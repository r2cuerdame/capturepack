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
// MONITOR's rectangle in that same space, and mapping onto one display's
// snapshot pixels (the annotation coordinate space, SPEC §8.2) is a per-monitor
// affine transform — `snapshot = (uia - monitor.origin) x (snapshot size /
// monitor size)` — which no virtualization can fool. `root_bounds` (the UIA
// desktop root = the primary display) is the cruder fallback for a helper that
// could not enumerate monitors.
//
// ONE SPACE PER CAPTURED DISPLAY. The capture freezes every screen and the
// editor draws them all, so each window and control is mapped into the snapshot
// of the display it is ON and says which one that is (`display`, SPEC §11.3 —
// absent means the focused display, exactly like an annotation's, SPEC §8.8).
// Forcing the whole desktop through the focused display's transform, as this
// once did, left every other screen holding rectangles that belonged to no
// image: picking worked on one monitor and was silently dead on the rest.
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { app, screen } from 'electron'
import type { Rectangle } from 'electron'
import { logInfo } from './log'
import { visibleWindowHandlesNow } from './context/runtime'
import type {
  UiaBounds,
  UiaElementRecord,
  UiaPluginPayload,
  UiaTreeStatus,
  UiaWindowRecord,
} from '../shared/types'
import type {
  EditorUiaElement,
  EditorUiaWindow,
  UiaFailureReason,
  UiaPluginStatus,
} from '../shared/ipc'

/**
 * Hard budget: the helper is killed at this age, finished or not.
 *
 * RAISED FROM 1 200 ms, on a measurement from the machine that reported "큰
 * 박스 안에서 작은 엘레멘트들이 선택이 안돼": the Plugins row read "창 14개,
 * 컨트롤 319개 이상 (시간 제한으로 중단됨)". 319 elements over 14 windows is
 * one modern window's worth — the walk was being cut somewhere in the second or
 * third tree, so most windows reached the editor with no controls at all and
 * every click on them could only land on the window. The picker was not
 * choosing badly; there was nothing else to choose.
 *
 * The cost is paid ONCE, between the freeze and the editor appearing, and only
 * by a desktop that needs it — the helper stops as soon as it runs out of
 * windows. The pixels are already captured by then, so what this can delay is
 * the editor opening, never the evidence.
 */
export const UIA_BUDGET_MS = 3_000
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
/**
 * Slack over budget + kill grace before the resolution time is worth a log
 * line. The DESIGNED worst case (helper killed at the budget, resolved from
 * partial output one grace later) lands exactly on that bound and timers fire a
 * few ms late, so warning at the bound itself would print on every truncated
 * dump — noise, not a diagnostic. Past this, something held the resolution up
 * that the design did not account for, and the editor waited for it.
 */
const UIA_OVERSHOOT_SLACK_MS = 100

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
  // Web-content roots dropped for measuring themselves against a display their
  // window no longer sits on (see refuseDisplacedRenderers). Nonzero means this
  // desktop HAS controls the pick cannot offer — a different claim from a page
  // that exposed none, and one the pack says out loud.
  geometryRefused: number
}

/**
 * ONE captured display a dump can be mapped into (SPEC §5.6, §11.3).
 *
 * The capture freezes every display and the editor draws them all, so the dump
 * is mapped into EVERY display's own snapshot space — not forced through the
 * focused display's transform, which left every other screen holding rectangles
 * that belong to no image and made picking dead everywhere but one monitor.
 */
export interface UiaDisplayTarget {
  // 1-based display index as the PACK declares it (manifest.media.displays[].index,
  // SPEC §5.6) — the value `display` carries on a window, an element and an
  // annotation alike. A pack that declares no per-display media has exactly one
  // display and its index is 1.
  index: number
  // The display snapshot.png is (SPEC §8.2): the one whose entries write no
  // `display` field at all. Exactly one target is focused.
  focused: boolean
  // Electron display.bounds (device-independent pixels).
  bounds: Rectangle
  // The same display in Win32 virtual-desktop physical pixels. UIA mapping can
  // derive this from `bounds`; Lane S consumes it directly so two identical
  // monitors cannot be paired by enumeration order.
  desktopBounds?: Rectangle
  // This display's snapshot size in pixels — literally what its snapshot PNG
  // is, so the mapped coordinates are that display's annotation coordinate space.
  width: number
  height: number
}

/**
 * The small part of Electron's `screen` API used by coordinate mapping.
 *
 * Keeping this structural lets the deterministic QA harness supply a fixed
 * mixed-DPI desktop. Production always uses Electron's live `screen` object.
 */
export interface UiaScreenAccess {
  getAllDisplays(): Array<{ id: number; bounds: Rectangle }>
  getPrimaryDisplay(): { id: number; bounds: Rectangle }
  dipToScreenRect(window: null, bounds: Rectangle): Rectangle
}

/**
 * What the LAST dump of this app session produced (issue #57). The Plugins row
 * in Settings reports the plugin's state FROM REALITY — "active, last capture:
 * 14 windows / 812 controls" or "unavailable, PowerShell policy blocked the
 * helper" — and reality is only observable here, where the helper runs. null
 * until the first capture: a row that has nothing to report says what the
 * plugin does instead of inventing a count.
 */
let lastDump: { windows: number; controls: number; truncated: boolean } | null = null
/** Why the last dump produced nothing; null after any dump that did. */
let lastFailure: UiaFailureReason | null = null

/**
 * The plugin's live state for Settings > Plugins (issue #57).
 *
 * `enabled` is settings.uiaEnabled — passed in rather than read here, because
 * this module deliberately knows nothing about settings: it is spawned by the
 * capture flow, which is what actually honors the switch.
 */
export function uiaPluginStatus(enabled: boolean): UiaPluginStatus {
  const last = {
    lastWindows: lastDump?.windows ?? null,
    lastControls: lastDump?.controls ?? null,
    lastTruncated: lastDump?.truncated ?? false,
  }
  // Platform first: on a non-Windows build the switch is irrelevant — a UI
  // Automation client cannot exist there at all.
  if (process.platform !== 'win32') {
    return { state: 'unsupported', ...last, reason: null }
  }
  if (!enabled) return { state: 'off', ...last, reason: null }
  if (lastFailure !== null) return { state: 'failing', ...last, reason: lastFailure }
  return { state: 'active', ...last, reason: null }
}

/** Records what a finished dump attempt actually produced (see lastDump). */
function recordDumpOutcome(dump: UiaRawDump | null, failure: UiaFailureReason | null): void {
  if (dump !== null) {
    lastDump = {
      windows: dump.windows.length,
      controls: dump.elements.length,
      truncated: dump.truncated,
    }
    // ON THE RECORD, not only in a settings row. Every other stage of a capture
    // logs what it achieved, and this one — which decides whether a click can
    // land on a button or only on a window — did not. The budget it was being
    // cut by had to be learned from a screenshot of the Plugins panel, which is
    // the one place a user has to go looking. `truncated` is the number that
    // matters: it says the desktop had more to give than there was time for.
    logInfo(
      `[uia] dump: ${String(lastDump.windows)} window(s), ${String(lastDump.controls)} control(s)` +
        `${lastDump.truncated ? ` — TRUNCATED at the ${String(UIA_BUDGET_MS)} ms budget, so some windows reached the editor with no controls` : ''}`,
    )
    lastFailure = null
    return
  }
  // A capture that produced no dump REPLACES the counts instead of leaving the
  // previous ones standing. "last capture: 14 windows, 812 controls" is a claim
  // about the LAST capture (issue #57: STATUS from reality, not a constant), so
  // once a capture has run and collected nothing there is no count to report —
  // and uiaPluginStatus() would otherwise hand the Plugins row numbers that
  // describe a capture two captures ago.
  lastDump = null
  lastFailure = failure
}

/**
 * Records a capture that deliberately ran no dump at all because the Plugins
 * switch was off (issue #57). Not a failure — nothing was attempted — so it
 * clears the failure reason along with the counts, which is what makes
 * off -> capture -> on report "Active" rather than a stale "last capture: N".
 *
 * The capture flow calls this instead of startUiaDump(); this module still
 * knows nothing about settings, it is only told what happened.
 */
export function recordUiaSkipped(): void {
  recordDumpOutcome(null, null)
}

/**
 * Spawns the helper and resolves its raw dump — or null when there is nothing
 * usable. NEVER rejects and never throws: the caller starts this and forgets
 * about it until the payload is needed.
 */
export function startUiaDump(): Promise<UiaRawDump | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  const invocation = helperInvocation()
  if (invocation === null) {
    logOnce('uia: helper script not found; continuing without object data')
    recordDumpOutcome(null, 'no-helper')
    return Promise.resolve(null)
  }
  const startedAt = new Date()
  const startedAtMs = Date.now()
  // ONE origin for both budgets: the helper's own soft budget is computed from
  // this absolute instant, so powershell.exe's startup is charged to the
  // helper's remaining time instead of being invisible to it (a cold start can
  // exceed the whole budget, and a stopwatch started inside the script would
  // happily keep walking past the kill below).
  const deadlineAtMs = startedAtMs + UIA_BUDGET_MS
  return new Promise<UiaRawDump | null>((resolve) => {
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    // `failure` carries BOTH the human log line and the typed reason the
    // Plugins row reports (issue #57): the log explains it once per process,
    // the type explains it every time the settings window is opened.
    const done = (
      dump: UiaRawDump | null,
      failure?: { reason: UiaFailureReason; detail: string },
    ): void => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      clearTimeout(graceTimer)
      recordDumpOutcome(dump, failure?.reason ?? null)
      if (failure !== undefined) logOnce(`uia: ${failure.detail}; continuing without object data`)
      // How long the dump ACTUALLY took to resolve, printed only when it ran
      // past what it was allowed. This is the number that explains a late or
      // empty index (the editor waits for this promise), and until it was
      // logged the overshoot was invisible: the budget is what we ASK for, this
      // is what we got.
      const elapsedMs = Date.now() - startedAtMs
      if (elapsedMs > UIA_BUDGET_MS + UIA_KILL_GRACE_MS + UIA_OVERSHOOT_SLACK_MS) {
        console.warn(
          `capturepack: uia: the dump resolved in ${elapsedMs} ms, past its ${UIA_BUDGET_MS} ms budget ` +
            `+ ${UIA_KILL_GRACE_MS} ms kill grace` +
            `${dump === null ? ' (with nothing usable)' : ''}`,
        )
      }
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
          // Only the Process scope, which MachinePolicy/UserPolicy still beat —
          // see helperInvocation() for what happens when they do.
          '-ExecutionPolicy',
          'Bypass',
          ...invocation.args,
        ],
        {
          windowsHide: true,
          // The helper's parameters (it takes no param() block, so that one
          // interface serves both invocation forms), including the shared hard
          // deadline.
          env: {
            ...process.env,
            CAPTUREPACK_UIA_DEADLINE: String(deadlineAtMs),
            // WHICH WINDOWS ARE WORTH WALKING, from the one subsystem that
            // already knows. Empty means "no opinion" — the helper then walks
            // what it finds, exactly as it did before this existed.
            CAPTUREPACK_UIA_VISIBLE_HWNDS: visibleWindowHandlesNow().join(','),
            CAPTUREPACK_UIA_BUDGET_MS: String(UIA_BUDGET_MS),
            CAPTUREPACK_UIA_MAX_DEPTH: String(UIA_MAX_DEPTH),
            CAPTUREPACK_UIA_MAX_ELEMENTS: String(UIA_MAX_ELEMENTS),
            CAPTUREPACK_UIA_MAX_WINDOWS: String(UIA_MAX_WINDOWS),
          },
        },
      )
    } catch (err) {
      done(null, {
        reason: 'spawn-failed',
        detail: `helper could not be started (${errorMessage(err)})`,
      })
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
    child.on('error', (err) =>
      done(null, { reason: 'spawn-failed', detail: `helper failed (${errorMessage(err)})` }),
    )

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
        done(
          partial,
          partial === null
            ? { reason: 'budget', detail: `helper exceeded its ${UIA_BUDGET_MS} ms budget` }
            : undefined,
        )
      }, UIA_KILL_GRACE_MS)
    }, UIA_BUDGET_MS)

    child.on('close', (code) => {
      const dump = parseDump(stdout, startedAt, killed)
      if (dump !== null) {
        done(dump)
        return
      }
      // Execution policy refused the script FILE (Group Policy beats
      // -ExecutionPolicy). Nothing can be done for THIS capture — its budget is
      // spent — but the next one runs the same file as a command instead, so a
      // managed machine loses one dump rather than the feature.
      const policyRefused = !killed && isPolicyRefusal(stderr)
      if (policyRefused) forcedCommandForm = true
      // The Plugins row names the policy case separately (issue #57): "the
      // helper collected nothing" would send a user hunting for a bug in
      // CapturePack when the answer is a machine policy.
      const reason: UiaFailureReason = killed ? 'budget' : policyRefused ? 'policy' : 'no-output'
      const detail = killed
        ? `helper exceeded its ${UIA_BUDGET_MS} ms budget`
        : `helper produced no usable output (exit ${String(code)}${stderr.trim() === '' ? '' : `: ${firstLine(stderr)}`})`
      done(null, { reason, detail })
    })
  })
}

/**
 * Maps a raw dump into the pack payload: every rectangle in the snapshot pixels
 * of the display it is ON (SPEC §8.2, §11.3), with that display named in
 * `display` — absent for the focused one, exactly the rule annotations follow
 * (SPEC §8.8), so a single-display capture writes the same bytes it always did.
 *
 * WHICH display an entry belongs to is decided in the HELPER's coordinate space
 * (matchMonitor already pairs a helper monitor rectangle with each Electron
 * display): a window goes to the display it overlaps most. A child normally
 * lands there too, but a straddling window can own a child wholly visible on
 * the other monitor; that child's own rectangle selects its display while the
 * stable `window` index keeps the ownership relationship intact.
 *
 * An entry on a display this capture did not freeze (or on a desktop the helper
 * could not enumerate monitors for) falls back to the focused display's
 * transform and lands out of frame, which is what the payload has always done
 * with the rest of the desktop: still context, never picked.
 *
 * `targets` carries at least the focused display — a capture that froze no
 * display cannot exist. Given none, records keep the helper's own coordinates,
 * because there is no snapshot to express them in.
 */
export function mapUiaToSnapshot(
  raw: UiaRawDump,
  targets: readonly UiaDisplayTarget[],
  budgetMs: number = UIA_BUDGET_MS,
  screenAccess: UiaScreenAccess = screen,
): UiaPluginPayload {
  const spaces = targets.map((target) => buildSpace(raw, target, screenAccess))
  const fallback = spaces.find((s) => s.focused) ?? spaces[0]
  const spaceOf = (b: UiaBounds): DisplaySpace | undefined => coveringSpace(spaces, b) ?? fallback
  // z -> the space its window was placed in, so every control can be mapped
  // with its own window rather than re-derived (and possibly disagreeing).
  const windowSpaces = new Map<number, DisplaySpace>()
  const windows = raw.windows.map((w) => {
    const space = spaceOf(w.bounds)
    if (space !== undefined) windowSpaces.set(w.z, space)
    return place(w, space)
  })
  const elements = raw.elements.map((e) => {
    // A window can straddle two monitors. Its child can be wholly visible on
    // the smaller side, so forcing every child through the window's dominant
    // display maps that child outside the snapshot and the composer drops it.
    // Prefer the child's own physical rectangle; retain the owner/focused
    // fallback only for off-desktop or monitor-less helper output.
    const space = coveringSpace(spaces, e.bounds) ?? windowSpaces.get(e.window) ?? fallback
    return place(e, space)
  })
  return {
    captured_at: isoWithOffset(raw.capturedAt),
    budget_ms: budgetMs,
    truncated: raw.truncated,
    // Always written, 0 included: "we looked and found none" is a claim, and
    // absent already means "this walk could not tell" (payload 0.4.0).
    geometry_refused: raw.geometryRefused,
    windows,
    elements,
  }
}

/** One record moved into `space` (no space: left exactly as the helper saw it). */
function place<T extends { bounds: UiaBounds; display?: number }>(
  record: T,
  space: DisplaySpace | undefined,
): T {
  if (space === undefined) return { ...record }
  const mapped: T = { ...record, bounds: space.map(record.bounds) }
  // SPEC §8.8/§11.3: absent means the focused display, so it is never written
  // for one — and never left over from anywhere either.
  if (space.focused) delete mapped.display
  else mapped.display = space.index
  return mapped
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
  const walked = rawElements.filter(isElementShape).map((e) => toElementRecord(e, -1))
  // Per window, because depth is a pre-order walk of ONE window's control view
  // and the file keeps each window's elements contiguous. Re-opening a pack
  // written before this test is what makes its bad boxes stop being offered.
  const elements: UiaElementRecord[] = []
  for (let i = 0; i < walked.length; ) {
    let j = i
    while (j < walked.length && (walked[j] as UiaElementRecord).window === (walked[i] as UiaElementRecord).window) j++
    elements.push(...refuseDisplacedRenderers(walked.slice(i, j)).kept)
    i = j
  }
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
 * One captured display as a mapping space: its pack index, its rectangle in the
 * HELPER's coordinates (null when the helper listed no monitors, or none of
 * them could be paired with this display), and uia space -> its snapshot pixels.
 */
interface DisplaySpace {
  index: number
  focused: boolean
  monitor: UiaMonitor | null
  map: (b: UiaBounds) => UiaBounds
}

function buildSpace(
  raw: UiaRawDump,
  target: UiaDisplayTarget,
  screenAccess: UiaScreenAccess,
): DisplaySpace {
  const monitor = matchMonitor(raw.monitors, target.bounds, screenAccess)
  return {
    index: target.index,
    focused: target.focused,
    monitor,
    map: buildMapper(raw, target, monitor, screenAccess),
  }
}

/**
 * The display an entry is ON: the one whose helper rectangle it overlaps most.
 *
 * Overlap, not the centre point: a window is routinely dragged half off a
 * screen, and the half that is visible is the one worth picking on. A rectangle
 * that touches no captured display (another monitor, a window fully off-screen)
 * gets no space here and the caller falls back to the focused display.
 */
function coveringSpace(
  spaces: readonly DisplaySpace[],
  bounds: UiaBounds,
): DisplaySpace | undefined {
  let best: DisplaySpace | undefined
  let bestArea = 0
  for (const space of spaces) {
    if (space.monitor === null) continue
    const area = overlapArea(space.monitor.bounds, bounds)
    if (area > bestArea) {
      best = space
      bestArea = area
    }
  }
  if (best !== undefined) return best
  // Degenerate rectangle (zero width or height): it can overlap nothing, so ask
  // which display CONTAINS its origin instead of dropping it on the focused one.
  if (bounds.width > 0 && bounds.height > 0) return undefined
  return spaces.find((s) => s.monitor !== null && contains(s.monitor.bounds, bounds.x, bounds.y))
}

function overlapArea(a: UiaBounds, b: UiaBounds): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

function contains(r: UiaBounds, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height
}

/**
 * uia space -> ONE display's snapshot pixels.
 *
 * PREFERRED: the helper's rectangle for THAT MONITOR, which turns the mapping
 * into `(uia - monitor.origin) x (snapshot size / monitor size)`. Exact
 * whatever DPI awareness the helper ended up with, and correct on mixed-DPI
 * desktops where a single global scale is not.
 *
 * FALLBACK (no monitor list): treat the whole desktop as uniformly virtualized
 * about the primary display's origin — root_bounds IS the primary display in
 * the helper's space, so its width against the primary's real physical width is
 * that factor (1 for a fully DPI-aware helper).
 */
function buildMapper(
  raw: UiaRawDump,
  target: UiaDisplayTarget,
  monitor: UiaMonitor | null,
  screenAccess: UiaScreenAccess,
): (b: UiaBounds) => UiaBounds {
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
  const targetPhysical = toPhysicalRect(target.bounds, screenAccess)
  let scale = 1
  if (raw.rootBounds !== null && raw.rootBounds.width > 0) {
    const primaryPhysical = toPhysicalRect(screenAccess.getPrimaryDisplay().bounds, screenAccess)
    const candidate = primaryPhysical.width / raw.rootBounds.width
    // A sane virtualization factor only; anything else means the assumption
    // broke and 1:1 is the safer answer than a wildly wrong one.
    if (Number.isFinite(candidate) && candidate >= 0.25 && candidate <= 4) scale = candidate
  }
  return (b) => ({
    x: Math.round(b.x * scale - targetPhysical.x),
    y: Math.round(b.y * scale - targetPhysical.y),
    width: Math.max(0, Math.round(b.width * scale)),
    height: Math.max(0, Math.round(b.height * scale)),
  })
}

/**
 * The helper monitor that IS the display with these bounds — for ANY captured
 * display, not only the focused one: every display gets its own mapping space.
 *
 * The two lists describe the same non-overlapping tiling of the same desktop,
 * so sorting each by (x, y) pairs them positionally — per-monitor scaling moves
 * the edges but never reorders them. The primary flag and the aspect ratio are
 * then checked as a guard: a mismatch means the assumption broke and the caller
 * gets the cruder fallback rather than confidently wrong coordinates.
 */
function matchMonitor(
  monitors: readonly UiaMonitor[],
  displayBounds: Rectangle,
  screenAccess: UiaScreenAccess,
): UiaMonitor | null {
  const usable = monitors.filter((m) => m.bounds.width > 0 && m.bounds.height > 0)
  if (usable.length === 0) return null
  const displays = screenAccess.getAllDisplays()
  const primaryId = screenAccess.getPrimaryDisplay().id
  const target = displays.find(
    (d) => d.bounds.x === displayBounds.x && d.bounds.y === displayBounds.y,
  )
  const targetIsPrimary = target !== undefined && target.id === primaryId
  // Single monitor, or this display is the primary: no ambiguity at all.
  if (usable.length === 1) return displays.length === 1 ? (usable[0] ?? null) : null
  if (targetIsPrimary) {
    const primaryMonitor = usable.find((m) => m.primary)
    if (primaryMonitor !== undefined && aspectMatches(primaryMonitor, displayBounds)) {
      return primaryMonitor
    }
    return null
  }
  if (target === undefined || usable.length !== displays.length) return null
  const byPosition = <T>(items: readonly T[], at: (item: T) => { x: number; y: number }): T[] =>
    [...items].sort((a, b) => at(a).x - at(b).x || at(a).y - at(b).y)
  const sortedMonitors = byPosition(usable, (m) => m.bounds)
  const sortedDisplays = byPosition(displays, (d) => d.bounds)
  const index = sortedDisplays.findIndex((d) => d.id === target.id)
  const candidate = index < 0 ? undefined : sortedMonitors[index]
  if (candidate === undefined) return null
  if (candidate.primary !== (target.id === primaryId)) return null
  return aspectMatches(candidate, displayBounds) ? candidate : null
}

/** Guard on a positional match: the same monitor cannot change shape. */
function aspectMatches(monitor: UiaMonitor, bounds: Rectangle): boolean {
  if (bounds.width <= 0 || bounds.height <= 0) return false
  const a = monitor.bounds.width / monitor.bounds.height
  const b = bounds.width / bounds.height
  return Math.abs(a - b) <= 0.02 * Math.max(a, b)
}

/** A display's device-independent rectangle in physical screen pixels. */
function toPhysicalRect(bounds: Rectangle, screenAccess: UiaScreenAccess): Rectangle {
  try {
    return screenAccess.dipToScreenRect(null, bounds)
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
 * A Windows command line is capped at 32 767 characters INCLUDING the
 * executable and every other switch. The command form below is a few hundred
 * characters plus the script path, so this is only ever a tripwire — but it is
 * checked, because the form this replaced carried the whole gzipped helper as
 * base64 and sat at ~89% of this limit: the next few KB of helper source would
 * have turned object picking off for everyone, with no error anywhere.
 */
const MAX_COMMAND_CHARS = 30_000

/**
 * Set when execution policy refused the script FILE (see startUiaDump). Every
 * later spawn uses the command form, which no policy scope governs.
 */
let forcedCommandForm = false

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
 * How to run the helper: the RESOLVED SCRIPT FILE, never its source.
 *
 * PRIMARY — `-File <path>`. resolveHelperScript() has already proved the file
 * exists (it tries the app.asar.unpacked copy first, which is the one a
 * packaged build ships and the one powershell.exe can actually open), so the
 * command line is a path, not a program. Nothing about the helper's size can
 * ever reach a limit again.
 *
 * FALLBACK — the same file, read and run as a scriptblock through a ~700-char
 * -EncodedCommand. Execution policy governs script FILES and resolves by scope
 * precedence, so MachinePolicy/UserPolicy (Group Policy) beat the
 * -ExecutionPolicy switch: on a managed AllSigned/Restricted machine `-File`
 * is simply refused. A command is not a script file, so this form runs anyway.
 * It is used only after a refusal has actually been seen (startUiaDump sets
 * forcedCommandForm), because it starts marginally slower and the whole point
 * of the primary form is that nothing travels on the command line.
 */
function helperInvocation(): { args: string[] } | null {
  const script = resolveHelperScript()
  if (script === null) return null
  if (!forcedCommandForm) return { args: ['-File', script] }
  // Single quotes are PowerShell's literal string; a path may legitimately
  // contain one, and doubling it is the escape.
  const command =
    `$ErrorActionPreference='Stop';` +
    `& ([scriptblock]::Create([IO.File]::ReadAllText('${script.replace(/'/g, "''")}',[Text.Encoding]::UTF8)))`
  const encoded = Buffer.from(command, 'utf16le').toString('base64')
  if (encoded.length > MAX_COMMAND_CHARS) {
    // Only reachable via an absurd install path; the honest answer is to say so
    // rather than hand Windows a line it will truncate.
    logOnce(`uia: the helper command is ${encoded.length} characters, over the ${MAX_COMMAND_CHARS} limit`)
    return null
  }
  return { args: ['-EncodedCommand', encoded] }
}

/**
 * PowerShell refusing to run a script FILE because of execution policy.
 *
 * Deliberately NOT the bare word "UnauthorizedAccess": UI Automation itself
 * raises UnauthorizedAccessException against elevated or protected windows and
 * the helper writes that to stderr, so matching it alone would latch
 * `forcedCommandForm` (which is never reset) for the rest of the process and
 * permanently downgrade every later capture to the slower encoded form the
 * primary form exists to avoid. The signals below are execution policy's own:
 * PSSecurityException and the UnauthorizedAccess FullyQualifiedErrorId
 * PowerShell prints for a refused script file, plus the message text itself in
 * whatever wording the host uses.
 */
function isPolicyRefusal(stderr: string): boolean {
  return /PSSecurityException|UnauthorizedAccess,\s*Microsoft\.PowerShell\.Commands|execution of scripts is disabled|running scripts is disabled|not digitally signed/i.test(
    stderr,
  )
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
  let geometryRefused = 0
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
      const walked = record['elements']
        .filter(isElementShape)
        .map((e) => toElementRecord(e, index))
      // The helper drops these during the walk; repeating the test here is what
      // makes an older helper's dump safe too. Both counts are reported.
      const { kept: chunk, refused } = refuseDisplacedRenderers(walked)
      geometryRefused += countOf(record['geometry_refused']) + refused
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
  return { capturedAt, truncated, rootBounds, monitors, windows, elements, geometryRefused }
}

/**
 * A WEB-CONTENT ROOT MUST STILL COVER THE SURFACE IT WAS DRAWN INTO.
 *
 * Chromium paints pages in a renderer process carrying its own device scale
 * factor. Drag a window between displays of different scales and the browser
 * frame re-lays out at once while the renderer can still answer with the OLD
 * display's scale, so one window arrives in two coordinate spaces: the toolbar
 * exact, the page inside it off by the ratio between the two displays.
 *
 * Measured (CapturePack_2026-08-01_075525): two Chrome windows moved onto a
 * 1200x1920 @1x display reported web content covering 0.67 and 0.50 of the pane
 * they were drawn in — 1/1.5 and 1/2, the two scales involved. Discord, never
 * moved off its own display, reported 1.00. The payload itself says nothing
 * about which of those you are holding, so a box drawn from the bad one lands on
 * a neighbouring tile and the pack asserts the user pointed at something they
 * did not.
 *
 * `uia-dump.ps1` already drops these subtrees during the walk, where skipping
 * one also spares the budget. This is the same test on the parsed side, so a
 * dump from an older helper — or a pack written by one, read back through
 * `parseUiaPayload` — cannot smuggle a displaced rectangle in. It reads a
 * pre-order chunk, so the host of an element is the nearest preceding element of
 * lower depth.
 *
 * Coverage, never containment: scrolled content legitimately overflows its
 * viewport. And a refusal, never a correction — the ratio proves the numbers are
 * wrong, it does not reveal what the right ones were.
 */
export const UIA_DOCUMENT_COVERAGE_MIN = 0.9

export function refuseDisplacedRenderers(chunk: readonly UiaElementRecord[]): {
  kept: UiaElementRecord[]
  refused: number
} {
  const kept: UiaElementRecord[] = []
  const hosts: UiaElementRecord[] = []
  let refused = 0
  // Set while inside a refused subtree: everything deeper than this was measured
  // by the same renderer and is just as displaced.
  let cutDepth: number | null = null
  for (const element of chunk) {
    if (cutDepth !== null && element.depth > cutDepth) continue
    cutDepth = null
    while (hosts.length > 0 && (hosts[hosts.length - 1] as UiaElementRecord).depth >= element.depth) {
      hosts.pop()
    }
    const host = hosts[hosts.length - 1]
    if (
      element.control_type === 'Document' &&
      element.depth > 0 &&
      host !== undefined &&
      !documentCoversHost(element.bounds, host.bounds)
    ) {
      refused++
      cutDepth = element.depth
      continue
    }
    hosts.push(element)
    kept.push(element)
  }
  return { kept, refused }
}

function documentCoversHost(rect: UiaBounds, host: UiaBounds): boolean {
  // An unmeasurable host proves nothing either way, so it accuses nobody.
  if (!(host.width > 0) || !(host.height > 0)) return true
  if (!(rect.width > 0) || !(rect.height > 0)) return true
  return (
    rect.width / host.width >= UIA_DOCUMENT_COVERAGE_MIN &&
    rect.height / host.height >= UIA_DOCUMENT_COVERAGE_MIN
  )
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
  const hwnd = raw['hwnd']
  return {
    // The OS handle (#97) — the one value this dump and the surface ring both
    // observe rather than describe. Absent on a payload written before the dump
    // reported it, and absent stays absent: a handle nobody read is not a zero.
    ...(typeof hwnd === 'string' && hwnd !== '' && hwnd !== '0' ? { hwnd } : {}),
    title: raw['title'] as string,
    process: raw['process'] as string,
    class_name: typeof raw['class_name'] === 'string' ? raw['class_name'] : '',
    // Absent = the focused display (SPEC §11.3), which is what a 0.2.0 payload
    // and every focused-screen entry mean — so it stays absent, never defaulted
    // to a number the pack does not declare.
    ...displayField(raw['display']),
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
    ...displayField(raw['display']),
    bounds: raw['bounds'] as UiaBounds,
    depth: raw['depth'] as number,
    window: typeof window === 'number' && Number.isInteger(window) && window >= 0 ? window : fallbackWindow,
  }
}

/** `{ display }` for a usable 1-based index, `{}` otherwise (= focused display). */
function displayField(value: unknown): { display?: number } {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? { display: value } : {}
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

/**
 * The first line of a child's stderr that says something to a HUMAN.
 *
 * PowerShell does not write plain text to a redirected stderr: it writes its
 * error records as CLIXML — a `#< CLIXML` marker followed by one long
 * `<Objs …><S S="Error">the actual message</S>…</Objs>` document. Taken
 * literally, the "first line" of a failed dump was therefore always the string
 * `#< CLIXML`, which is the one diagnostic this module emits and it named the
 * ENVELOPE instead of the error. Unwrap it: the `<S>` runs hold the message,
 * `_x000D__x000A_` is how CLIXML spells a newline, and the usual XML entities
 * apply.
 */
function firstLine(text: string): string {
  const unwrapped = /#<\s*CLIXML/i.test(text) ? clixmlText(text) : text
  for (const raw of unwrapped.split('\n')) {
    const line = raw.trim()
    // Skip blanks, the marker, and any XML that survived the unwrap: a tag is
    // never the message.
    if (line === '' || line.startsWith('#<') || line.startsWith('<')) continue
    return line
  }
  return ''
}

/** The text content of a PowerShell CLIXML stderr document. */
function clixmlText(text: string): string {
  const runs = text.match(/<S[^>]*>([\s\S]*?)<\/S>/g) ?? []
  return runs
    .map((run) =>
      run
        .replace(/^<S[^>]*>|<\/S>$/g, '')
        // CLIXML escapes any character it cannot spell as _xHHHH_.
        .replace(/_x([0-9A-Fa-f]{4})_/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&'),
    )
    .join('')
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
