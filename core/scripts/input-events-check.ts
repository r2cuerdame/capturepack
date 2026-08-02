// The behavioural half of `check:input-events` — the ring itself, run against
// the real modules with no Electron and no PowerShell in sight.
//
// What it holds the ring to: it derives the five emitted types from
// OBSERVATIONS and nothing else, it never invents an `input.key.*`, it is
// bounded by the replay's retention rather than the session's length, and a
// trim drops the events the trimmed clock no longer covers instead of piling
// them onto instant zero.
import {
  INPUT_EVENT_TYPES,
  INPUT_RING_MAX_EVENTS,
  InputEventRing,
  inputTimelineEvents,
  timelineEventsForTrim,
  withoutInputEvents,
} from '../src/main/context/inputEvents'
import { inputDisplayPlacement } from '../src/main/context/ringObservations'
import type { SurfaceSampleWindow } from '../src/main/context/timeline'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${name}`)
    return
  }
  failed += 1
  console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

function win(
  hwnd: string,
  bounds: { x: number; y: number; width: number; height: number },
  extra: Partial<SurfaceSampleWindow> = {},
): SurfaceSampleWindow {
  return {
    hwnd,
    ownerHwnd: '0',
    processId: 100,
    zOrder: 0,
    bounds,
    clientBounds: bounds,
    visible: true,
    minimized: false,
    foreground: false,
    cloaked: false,
    windowTitle: `w${hwnd}`,
    className: 'Test',
    executableName: 'explorer.exe',
    ...extra,
  }
}

function rect(x: number, y: number, width: number, height: number) {
  return { x, y, width, height }
}

// ---------------------------------------------------------------------------
// Window events are DERIVED from the samples lane S already takes
// ---------------------------------------------------------------------------
{
  const ring = new InputEventRing(30_000)
  const a = win('1', rect(0, 0, 800, 600), { foreground: true })
  const b = win('2', rect(900, 0, 400, 300) )
  ring.observe(0, [a, b], null)
  // Nothing happened yet: the first sample is the baseline, not a change.
  check('the first sample derives no event', ring.between(0, 10_000).length === 0)

  ring.observe(500, [win('1', rect(0, 0, 800, 600)), win('2', rect(900, 0, 400, 300), { foreground: true })], null)
  ring.observe(1_000, [win('1', rect(0, 0, 800, 600)), win('2', rect(1_000, 40, 400, 300), { foreground: true })], null)
  ring.observe(1_500, [win('1', rect(0, 0, 800, 600)), win('2', rect(1_000, 40, 500, 400), { foreground: true })], null)
  const derived = ring.between(0, 10_000)
  const kinds = derived.map((e) => e.type)
  check(
    'a foreground change derives input.window.focus',
    kinds.includes('input.window.focus'),
    kinds.join(', '),
  )
  check('a moved rectangle derives input.window.move', kinds.includes('input.window.move'), kinds.join(', '))
  check(
    'a resized rectangle derives input.window.resize',
    kinds.includes('input.window.resize'),
    kinds.join(', '),
  )
  check(
    'every derived event carries the time it was observed at',
    derived.every((e) => e.timeMs > 0 && e.timeMs <= 1_500),
  )
  check(
    'a window that did nothing derives nothing',
    !derived.some((e) => e.title === 'w1'),
    derived.map((e) => `${e.type}:${e.title ?? ''}`).join(', '),
  )
}

// A window nobody could see is not a window an input event describes: the whole
// reason these events are allowed is that the replay already shows them.
{
  const ring = new InputEventRing(30_000)
  ring.observe(0, [win('1', rect(0, 0, 800, 600))], null)
  ring.observe(200, [win('1', rect(40, 0, 800, 600), { visible: false })], null)
  ring.observe(400, [win('1', rect(80, 0, 800, 600), { minimized: true })], null)
  ring.observe(600, [win('1', rect(120, 0, 800, 600), { cloaked: true })], null)
  check(
    'an off-screen window derives no input event',
    ring.between(0, 10_000).length === 0,
    ring.between(0, 10_000).map((e) => e.type).join(', '),
  )
}

// ---------------------------------------------------------------------------
// The pointer
// ---------------------------------------------------------------------------
{
  const ring = new InputEventRing(30_000)
  ring.observe(0, [], { x: 10, y: 10, buttons: 0 })
  for (let t = 20; t <= 2_000; t += 20) {
    ring.observe(t, [], { x: 10 + t, y: 10, buttons: 0 })
  }
  const moves = ring.between(0, 10_000).filter((e) => e.type === 'input.mouse.move')
  check('a moving cursor derives input.mouse.move', moves.length > 0)
  check(
    'the move stream is coalesced — it costs the replay, not the sample rate',
    moves.length <= 2 * Math.ceil(2_000 / 1_000) * 5,
    `${moves.length} events from 100 observations over 2 s`,
  )
  check(
    'every move reports a point that was actually read',
    moves.every((e) => e.point !== undefined && e.point.y === 10),
  )
}

{
  const ring = new InputEventRing(30_000)
  ring.observe(0, [], { x: 100, y: 100, buttons: 0 })
  ring.observe(60, [], { x: 100, y: 100, buttons: 1 })
  ring.observe(120, [], { x: 100, y: 100, buttons: 0 })
  const clicks = ring.between(0, 10_000).filter((e) => e.type === 'input.mouse.click')
  check('a button that went down derives input.mouse.click', clicks.length === 1)
  check('the click names the button', clicks[0]?.button === 'left')
  check(
    'the click states how much older than the observation it may be',
    clicks[0]?.observedWithinMs === 60,
    String(clicks[0]?.observedWithinMs),
  )
  const held = new InputEventRing(30_000)
  held.observe(0, [], { x: 1, y: 1, buttons: 1 })
  held.observe(50, [], { x: 1, y: 1, buttons: 1 })
  held.observe(100, [], { x: 1, y: 1, buttons: 1 })
  check(
    'a held button is one click, not one per observation',
    held.between(0, 10_000).filter((e) => e.type === 'input.mouse.click').length <= 1,
  )
}

// ---------------------------------------------------------------------------
// THE PROMISE: no keystroke, ever
// ---------------------------------------------------------------------------
{
  const ring = new InputEventRing(30_000)
  for (let t = 0; t <= 5_000; t += 20) {
    ring.observe(t, [win('1', rect(t, t, 800, 600), { foreground: t % 200 === 0 })], {
      x: t,
      y: t,
      // Every bit set, including ones no mouse has: the ring must still only
      // ever speak about buttons it defines.
      buttons: 0xffff,
    })
  }
  const types = new Set(ring.between(0, 10_000).map((e) => e.type))
  check(
    'no observation of any shape produces an input.key.* event',
    ![...types].some((type) => type.startsWith('input.key')),
    [...types].join(', '),
  )
  check(
    'the ring emits only the five types the format defines',
    [...types].every((type) => (INPUT_EVENT_TYPES as readonly string[]).includes(type)),
    [...types].join(', '),
  )
  check(
    'the format defines no key type to emit',
    !INPUT_EVENT_TYPES.some((type) => type.startsWith('input.key')),
  )
}

// ---------------------------------------------------------------------------
// Retention: the events cost what the replay costs
// ---------------------------------------------------------------------------
{
  const ring = new InputEventRing(30_000)
  // Ten minutes of a desk in constant motion, at the lane's fastest cadence.
  for (let t = 0; t <= 600_000; t += 20) {
    ring.observe(t, [win('1', rect(t % 1_000, 0, 800, 600), { foreground: true })], {
      x: t % 1_920,
      y: (t * 7) % 1_080,
      buttons: 0,
    })
    if (t % 1_000 === 0) ring.prune(t - 30_000)
  }
  const stats = ring.stats()
  check(
    'the ring never holds more than its ceiling',
    stats.events <= INPUT_RING_MAX_EVENTS,
    `${stats.events} events against a ${INPUT_RING_MAX_EVENTS} ceiling`,
  )
  check(
    'ten minutes of motion leaves only what retention covers',
    ring.between(0, 570_000 - 1).length === 0,
    `${ring.between(0, 570_000 - 1).length} events older than the retained window survived`,
  )
  check('what it dropped is counted, not silent', stats.dropped > 0)
}

// ---------------------------------------------------------------------------
// Onto the pack: pack time, and the display's own snapshot pixels
// ---------------------------------------------------------------------------
{
  const monitors = [
    { device: '\\\\.\\DISPLAY1', primary: true, bounds: rect(0, 0, 1_920, 1_080) },
    { device: '\\\\.\\DISPLAY2', primary: false, bounds: rect(1_920, 0, 1_280, 1_024) },
  ]
  const targets = [
    { index: 1, focused: true, width: 1_920, height: 1_080, desktopBounds: rect(0, 0, 1_920, 1_080) },
    { index: 2, focused: false, width: 1_280, height: 1_024, desktopBounds: rect(1_920, 0, 1_280, 1_024) },
  ]
  const place = inputDisplayPlacement(monitors, targets)
  const ring = new InputEventRing(30_000)
  // The first reading is the baseline a movement is measured against, so this
  // is four readings for three events.
  ring.observe(1_000, [], { x: 10, y: 20, buttons: 0 })
  ring.observe(1_200, [], { x: 400, y: 300, buttons: 0 })
  ring.observe(1_400, [], { x: 2_100, y: 40, buttons: 0 })
  ring.observe(1_600, [], { x: 2_400, y: 60, buttons: 0 })
  const events = inputTimelineEvents(ring.between(0, 10_000), place, (sessionMs) => sessionMs - 1_000)
  check('the events are on the pack clock', events.every((e) => e.t_ms >= 0))
  check('every input event is sourced to the component that observed it', events.every((e) => e.source === 'core'))
  check(
    'a point on the focused display leaves `display` absent, as an annotation does',
    events.some((e) => e.type === 'input.mouse.move' && e.data?.['display'] === undefined),
  )
  check(
    'a point on the second display names it, in THAT display snapshot space',
    events.some(
      (e) =>
        e.type === 'input.mouse.move'
        && e.data?.['display'] === 2
        && typeof e.data['x'] === 'number'
        && (e.data['x'] as number) < 1_280,
    ),
    JSON.stringify(events.map((e) => e.data)),
  )
  check('the events are sorted ascending by t_ms', events.every((e, i) => i === 0 || e.t_ms >= (events[i - 1]?.t_ms ?? 0)))
  check('every event integer-stamps its time', events.every((e) => Number.isInteger(e.t_ms)))

  const offDesk = inputTimelineEvents(
    [{ timeMs: 1_000, type: 'input.mouse.move', point: { x: -9_000, y: -9_000 } }],
    place,
    (sessionMs) => sessionMs - 1_000,
  )
  check(
    'a point on no captured display is not placed on one anyway',
    offDesk.length === 0,
    JSON.stringify(offDesk),
  )
}

// ---------------------------------------------------------------------------
// A trim
// ---------------------------------------------------------------------------
{
  const events = [
    { t_ms: 100, type: 'input.mouse.move', source: 'core', data: { x: 1, y: 1 } },
    { t_ms: 2_500, type: 'input.window.focus', source: 'core', data: { title: 'a' } },
    { t_ms: 3_000, type: 'core.capture.triggered', source: 'core', data: {} },
  ]
  const trimmed = timelineEventsForTrim(events, 2_000, 3_000)
  check(
    'a trim DROPS an input event the trimmed clock no longer covers',
    !trimmed.some((e) => e.type === 'input.mouse.move'),
    JSON.stringify(trimmed),
  )
  check(
    'a trim keeps the ones it does cover, rebased',
    trimmed.some((e) => e.type === 'input.window.focus' && e.t_ms === 500),
    JSON.stringify(trimmed),
  )
  check(
    'a core event is still clamped, exactly as it was before input events existed',
    trimmed.some((e) => e.type === 'core.capture.triggered' && e.t_ms === 1_000),
    JSON.stringify(trimmed),
  )
}

// ---------------------------------------------------------------------------
// A pack that loses its replay loses the clock these events lived on
// ---------------------------------------------------------------------------
{
  const events = [
    { t_ms: 100, type: 'input.mouse.move', source: 'core', data: { x: 1, y: 1 } },
    { t_ms: 2_000, type: 'input.window.move', source: 'core', data: { title: 'a' } },
    { t_ms: 3_000, type: 'core.capture.triggered', source: 'core', data: {} },
  ]
  const kept = withoutInputEvents(events)
  check(
    'no replay, no input events — they described positions inside a video that is not there',
    kept.every((e) => !e.type.startsWith('input.')),
    JSON.stringify(kept),
  )
  check('the capture story survives', kept.some((e) => e.type === 'core.capture.triggered'))
}

console.log(`  ring: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
