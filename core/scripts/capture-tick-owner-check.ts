// Exactly one recorder owns surface ticks for each non-empty rebuild.
//
// This exercises the production helpers. In particular, it models the cursor
// moving while recorder windows await loadFile(): ownership is decided before
// those awaits and must not be recomputed per window.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  captureRecorderSignature,
  isCurrentRecorderResource,
  recorderTickOwnership,
  selectRecorderTickOwner,
} from '../src/main/captureTickOwnership'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

function roles(displayIds: readonly number[], owner: number | null): string[] {
  return displayIds.map((id) => recorderTickOwnership(id, owner))
}

function signature(displayId: number, owner: number | null): string {
  return captureRecorderSignature({
    width: 2560,
    height: 1440,
    scaleFactor: 1.5,
    fps: 15,
    replaySeconds: 30,
    replayMaxWidth: 1920,
    tickOwnership: recorderTickOwnership(displayId, owner),
  })
}

console.log('\nRecorder tick ownership')
{
  const displays = [11, 22, 33]
  const owner = selectRecorderTickOwner(displays, 22)
  const assigned = roles(displays, owner)
  check('cursor display owns multi-display ticks', owner === 22, String(owner))
  check(
    'multi-display rebuild appoints exactly one owner',
    assigned.filter((role) => role === 'owner').length === 1,
    JSON.stringify(assigned),
  )
}

{
  const displays = [77]
  const owner = selectRecorderTickOwner(displays, 22)
  const assigned = roles(displays, owner)
  check('fixed display owns ticks even when the cursor is elsewhere', owner === 77, String(owner))
  check(
    'fixed-display rebuild appoints exactly one owner',
    assigned.filter((role) => role === 'owner').length === 1,
    JSON.stringify(assigned),
  )
}

{
  const displays = [11, 22]
  const owner = selectRecorderTickOwner(displays, 999)
  check('missing cursor display falls back deterministically', owner === 11, String(owner))
  check('an empty recorder set has no owner', selectRecorderTickOwner([], 11) === null)
}

console.log('\nAsync window creation')
{
  const displays = [11, 22, 33]
  // Cursor is on 22 when rebuild starts, then crosses twice while the three
  // windows load. The captured owner, not those later positions, drives every
  // payload.
  const capturedOwner = selectRecorderTickOwner(displays, 22)
  const cursorWhileEachWindowLoads = [11, 33, 11]
  const assigned = displays.map((id, index) => ({
    id,
    cursorNow: cursorWhileEachWindowLoads[index],
    role: recorderTickOwnership(id, capturedOwner),
  }))
  check(
    'cursor movement during async creation cannot duplicate the owner',
    assigned.filter((entry) => entry.role === 'owner').length === 1,
    JSON.stringify(assigned),
  )
  check(
    'the rebuild-start owner remains the owner',
    assigned.find((entry) => entry.role === 'owner')?.id === 22,
    JSON.stringify(assigned),
  )
}

console.log('\nRecorder signatures')
{
  const owner = signature(11, 11)
  const passive = signature(11, 22)
  check('ownership participates in the recorder signature', owner !== passive)
}

{
  const displays = [11, 22, 33]
  const beforeOwner = selectRecorderTickOwner(displays, 22)
  const afterOwner = selectRecorderTickOwner(displays, 33, beforeOwner)
  const changed = displays.filter(
    (id) => signature(id, beforeOwner) !== signature(id, afterOwner),
  )
  check(
    'cursor movement does not hand ownership off during a rebuild',
    changed.length === 0 && afterOwner === beforeOwner,
    JSON.stringify(changed),
  )
}

console.log('\nStale recorder callbacks')
{
  const oldTimer = { name: 'old' }
  const replacementTimer = { name: 'replacement' }
  let currentTimer: typeof oldTimer | undefined = replacementTimer
  const settle = (timer: typeof oldTimer): void => {
    if (!isCurrentRecorderResource(currentTimer, timer)) return
    currentTimer = undefined
  }
  settle(oldTimer)
  check(
    'an old timer callback cannot delete its replacement',
    currentTimer === replacementTimer,
  )
  settle(replacementTimer)
  check('the current timer callback can settle its own slot', currentTimer === undefined)
}

{
  const oldWindow = { name: 'old' }
  const replacementWindow = { name: 'replacement' }
  let currentWindow: typeof oldWindow | undefined = replacementWindow
  let currentProbe: typeof oldWindow | undefined = replacementWindow
  const close = (win: typeof oldWindow): void => {
    if (!isCurrentRecorderResource(currentWindow, win)) return
    currentProbe = undefined
  }
  close(oldWindow)
  check(
    'a late old-window close cannot clear the replacement probe',
    currentProbe === replacementWindow,
  )
}

{
  const captureSource = readFileSync(
    path.join(process.cwd(), 'src', 'main', 'capture.ts'),
    'utf8',
  )
  const scheduleStart = captureSource.indexOf('function scheduleRecorderProbe')
  const timerGuard = captureSource.indexOf(
    'if (!isCurrentRecorderResource(recorderProbeTimers.get(displayId), timer)) return',
    scheduleStart,
  )
  const timerDelete = captureSource.indexOf(
    'recorderProbeTimers.delete(displayId)',
    scheduleStart,
  )
  check(
    'production checks timer ownership before deleting the probe slot',
    scheduleStart >= 0 && timerGuard > scheduleStart && timerDelete > timerGuard,
  )

  const closeStart = captureSource.indexOf("win.on('closed'")
  const windowGuard = captureSource.indexOf(
    'if (isCurrentRecorderResource(captureWindows.get(display.id), win))',
    closeStart,
  )
  const probeClear = captureSource.indexOf('clearRecorderProbe(display.id)', closeStart)
  check(
    'production checks window ownership before a close clears the probe',
    closeStart >= 0 && windowGuard > closeStart && probeClear > windowGuard,
  )
}

{
  const beforeOwner = 22
  const displaysAfterUnplug = [11, 33]
  const afterOwner = selectRecorderTickOwner(displaysAfterUnplug, 33, beforeOwner)
  const changed = [11, 22, 33].filter(
    (id) => signature(id, beforeOwner) !== signature(id, afterOwner),
  )
  check('a removed owner hands off to the preferred surviving display', afterOwner === 33)
  check(
    'a real owner removal changes only the old and new roles',
    JSON.stringify(changed) === JSON.stringify([22, 33]),
    JSON.stringify(changed),
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
