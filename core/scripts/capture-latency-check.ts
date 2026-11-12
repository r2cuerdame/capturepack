// check:capture-latency — the arithmetic and the refusals of the one number
// ROADMAP names as the product's standing constraint: "never sacrifice the
// 5-second workflow."
//
// WHAT THIS CHECK IS NOT. It cannot say the workflow is fast on anyone's
// machine — that needs a real display, a real encoder and a real person, and it
// lands in `main.log` from a real run. What it CAN hold without a display is
// everything that would make such a number a lie: a stage counted twice, a
// clock that went backwards, human thinking time billed to the app, and a total
// reported for a flow whose editor never opened.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  beginCaptureLatency,
  captureLatencyReport,
  formatCaptureLatency,
  markCaptureLatency,
  noteCaptureLatencyUserWait,
} from '../src/shared/captureLatency'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) passed += 1
  else failed += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

console.log('Stage accounting')
{
  const state = beginCaptureLatency('video', 1_000)
  markCaptureLatency(state, 'frozen', 1_240)
  markCaptureLatency(state, 'saved', 1_910)
  markCaptureLatency(state, 'editor-visible', 2_460)
  const report = captureLatencyReport(state)
  check(
    'every stage is reported as its own offset from the trigger',
    JSON.stringify(report.stages) ===
      JSON.stringify([
        { stage: 'frozen', fromTriggerMs: 240 },
        { stage: 'saved', fromTriggerMs: 910 },
        { stage: 'editor-visible', fromTriggerMs: 1_460 },
      ]),
    JSON.stringify(report.stages),
  )
  check(
    'the hands-off total is the editor becoming visible, not the last stage recorded',
    report.handsOffMs === 1_460,
    `got ${String(report.handsOffMs)}`,
  )
  check('a complete flow refuses nothing', report.refused === null, String(report.refused))
}

console.log('Human time is not the app being slow')
{
  // The image flow contains a region selection. Whatever the person spends
  // choosing a rectangle is theirs, and billing it to the product would make
  // the slowest possible measurement look like the product's fault.
  const state = beginCaptureLatency('image', 0)
  markCaptureLatency(state, 'frozen', 180)
  noteCaptureLatencyUserWait(state, 8_000)
  markCaptureLatency(state, 'saved', 8_900)
  markCaptureLatency(state, 'editor-visible', 9_400)
  const report = captureLatencyReport(state)
  check(
    'the hands-off total excludes the time the user held the flow',
    report.handsOffMs === 1_400,
    `got ${String(report.handsOffMs)}`,
  )
  check(
    'the excluded time is stated rather than silently dropped',
    report.waitedForUserMs === 8_000,
    `got ${String(report.waitedForUserMs)}`,
  )
  check(
    'stage offsets stay on the wall clock they were observed on',
    report.stages.at(-1)?.fromTriggerMs === 9_400,
    JSON.stringify(report.stages.at(-1)),
  )
}

{
  const state = beginCaptureLatency('image', 0)
  markCaptureLatency(state, 'frozen', 100)
  noteCaptureLatencyUserWait(state, 400)
  noteCaptureLatencyUserWait(state, 350)
  markCaptureLatency(state, 'editor-visible', 1_000)
  const report = captureLatencyReport(state)
  check(
    'separate waits accumulate rather than replacing each other',
    report.waitedForUserMs === 750 && report.handsOffMs === 250,
    `waited ${String(report.waitedForUserMs)}, hands-off ${String(report.handsOffMs)}`,
  )
}

console.log('Refusals')
{
  const state = beginCaptureLatency('video', 0)
  markCaptureLatency(state, 'frozen', 200)
  markCaptureLatency(state, 'frozen', 260)
  const report = captureLatencyReport(state)
  check(
    'a stage recorded twice refuses instead of keeping either reading',
    report.refused !== null && report.refused.includes('frozen'),
    String(report.refused),
  )
  check('a refused measurement reports no total', report.handsOffMs === null)
}

{
  const state = beginCaptureLatency('video', 0)
  markCaptureLatency(state, 'frozen', 500)
  markCaptureLatency(state, 'saved', 380)
  const report = captureLatencyReport(state)
  check(
    'a clock that went backwards refuses rather than reporting a negative span',
    report.refused !== null,
    String(report.refused),
  )
}

{
  const state = beginCaptureLatency('video', 900)
  markCaptureLatency(state, 'frozen', 700)
  const report = captureLatencyReport(state)
  check(
    'a stage before its own trigger refuses',
    report.refused !== null,
    String(report.refused),
  )
}

{
  const state = beginCaptureLatency('image', 0)
  markCaptureLatency(state, 'frozen', 100)
  noteCaptureLatencyUserWait(state, 5_000)
  markCaptureLatency(state, 'editor-visible', 1_000)
  const report = captureLatencyReport(state)
  check(
    'a wait longer than the flow itself refuses instead of reporting a negative total',
    report.refused !== null && report.handsOffMs === null,
    `${String(report.refused)} / ${String(report.handsOffMs)}`,
  )
}

{
  const state = beginCaptureLatency('image', 0)
  markCaptureLatency(state, 'frozen', 100)
  noteCaptureLatencyUserWait(state, -1)
  const report = captureLatencyReport(state)
  check(
    'a negative wait is refused, never treated as a credit',
    report.refused !== null,
    String(report.refused),
  )
}

{
  // Same timestamps going forward, but the stage names out of their declared
  // order: a call site moved, and "saved" no longer means what it says.
  const state = beginCaptureLatency('video', 0)
  markCaptureLatency(state, 'frozen', 200)
  markCaptureLatency(state, 'editor-visible', 900)
  markCaptureLatency(state, 'saved', 1_100)
  const report = captureLatencyReport(state)
  check(
    'a stage recorded after a later stage refuses, even on a forward clock',
    report.refused !== null && report.refused.includes('saved') && report.handsOffMs === null,
    `${String(report.refused)} / ${String(report.handsOffMs)}`,
  )
}

{
  // A skipped stage is normal (a re-edit has no freeze, a failed save has no
  // "saved"); only reordering is a defect.
  const state = beginCaptureLatency('image', 0)
  markCaptureLatency(state, 'frozen', 150)
  markCaptureLatency(state, 'editor-visible', 1_200)
  const report = captureLatencyReport(state)
  check(
    'a skipped stage is not mistaken for a reordered one',
    report.refused === null && report.handsOffMs === 1_200,
    `${String(report.refused)} / ${String(report.handsOffMs)}`,
  )
}

{
  const state = beginCaptureLatency('image', 0)
  markCaptureLatency(state, 'frozen', 100)
  markCaptureLatency(state, 'editor-visible', 2_000)
  noteCaptureLatencyUserWait(state, 1_500)
  const report = captureLatencyReport(state)
  check(
    'a wait noted after the editor became visible is refused, not subtracted',
    report.refused !== null && report.handsOffMs === null,
    `${String(report.refused)} / ${String(report.handsOffMs)}`,
  )
}

{
  const state = beginCaptureLatency('image', 0)
  markCaptureLatency(state, 'frozen', 100)
  noteCaptureLatencyUserWait(state, 0)
  markCaptureLatency(state, 'editor-visible', 700)
  const report = captureLatencyReport(state)
  check(
    'an instant selection is a zero wait, not a refusal',
    report.refused === null && report.handsOffMs === 700 && report.waitedForUserMs === 0,
    `${String(report.refused)} / ${String(report.handsOffMs)}`,
  )
}

{
  // A capture whose editor never opened is exactly the case a user complains
  // about. It must survive as evidence of how far the flow got.
  const state = beginCaptureLatency('video', 0)
  markCaptureLatency(state, 'frozen', 210)
  markCaptureLatency(state, 'saved', 880)
  const report = captureLatencyReport(state)
  check(
    'an editor that never opened yields no total',
    report.handsOffMs === null,
    `got ${String(report.handsOffMs)}`,
  )
  check(
    'but the stages that DID happen are still reported',
    report.stages.length === 2,
    JSON.stringify(report.stages),
  )
  check(
    'and that is not called a refusal — nothing measured was wrong',
    report.refused === null,
    String(report.refused),
  )
}

console.log('The log line')
{
  const state = beginCaptureLatency('video', 0)
  markCaptureLatency(state, 'frozen', 240)
  markCaptureLatency(state, 'saved', 910)
  markCaptureLatency(state, 'editor-visible', 1_460)
  const line = formatCaptureLatency(captureLatencyReport(state))
  check(
    'the line names the flow, every stage and the hands-off total',
    line.includes('video') &&
      line.includes('frozen 240 ms') &&
      line.includes('saved 910 ms') &&
      line.includes('editor-visible 1460 ms') &&
      line.includes('hands-off 1460 ms'),
    line,
  )
}

{
  const state = beginCaptureLatency('image', 0)
  markCaptureLatency(state, 'frozen', 120)
  noteCaptureLatencyUserWait(state, 3_000)
  markCaptureLatency(state, 'editor-visible', 3_600)
  const line = formatCaptureLatency(captureLatencyReport(state))
  check(
    'a flow that waited on the user says so in the line itself',
    line.includes('hands-off 600 ms') && line.includes('waited on user 3000 ms'),
    line,
  )
}

{
  const state = beginCaptureLatency('video', 0)
  markCaptureLatency(state, 'frozen', 200)
  markCaptureLatency(state, 'frozen', 300)
  const line = formatCaptureLatency(captureLatencyReport(state))
  check(
    'a refused measurement prints the reason and never a number',
    line.includes('refused') && !/\d+ ms/.test(line),
    line,
  )
}

console.log('Rule 1 — the measurement may never break a capture')
{
  const state = beginCaptureLatency('video', 0)
  let threw = false
  try {
    markCaptureLatency(state, 'frozen', Number.NaN)
    markCaptureLatency(state, 'saved', Number.POSITIVE_INFINITY)
    noteCaptureLatencyUserWait(state, Number.NaN)
    captureLatencyReport(state)
    formatCaptureLatency(captureLatencyReport(state))
  } catch {
    threw = true
  }
  check('unusable readings are refused, never thrown at the capture flow', !threw)
  check(
    'and a non-finite reading is one of the refusals',
    captureLatencyReport(state).refused !== null,
    String(captureLatencyReport(state).refused),
  )
}

console.log('Wiring — a flow cannot be added without being measured')
{
  // Counts, not exact text. The point is that the three instrumented boundaries
  // stay in step with the flows: a fourth capture flow, or a fourth place that
  // reveals an editor, must be measured too or this fails. A silent gap here
  // would not break anything — it would just quietly stop answering the one
  // question ROADMAP says outranks every milestone.
  const session = readFileSync(path.join(process.cwd(), 'src/main/session.ts'), 'utf8')
  const liveAssertion = readFileSync(
    path.join(process.cwd(), 'scripts/assert-live-capture-latency.mjs'),
    'utf8',
  )
  const releaseWorkflow = readFileSync(
    path.join(process.cwd(), '../.github/workflows/release.yml'),
    'utf8',
  )
  const count = (pattern: RegExp): number => (session.match(pattern) ?? []).length

  // Four since #157: the video flow, the desktop still, the re-edit, and the
  // browser page the extension's toolbar button hands over — measured as an
  // image flow, because that is the editor it opens.
  const gates = count(/flowActive = true/g)
  const begins = count(/beginFlowLatency\('/g)
  check(
    'every flow that takes the exclusive gate begins a measurement',
    gates === begins && begins === 4,
    `${String(gates)} gates, ${String(begins)} begins`,
  )
  const flowKinds = Array.from(
    session.matchAll(/flowActive = true\s+beginFlowLatency\('([^']+)'\)/g),
    (match) => match[1],
  )
  check(
    'the four gates are paired with video, re-edit, desktop image, and browser image measurements',
    JSON.stringify(flowKinds) === JSON.stringify(['video', 're-edit', 'image', 'image']),
    JSON.stringify(flowKinds),
  )

  const ends = count(/endFlowLatency\(\)(?!:)/g)
  check(
    'and every one of them ends it, so no flow reports nothing',
    ends === begins,
    `${String(begins)} begins, ${String(ends)} ends`,
  )

  // Each entry point must end its measurement in `finally`, so a thrown or
  // cancelled flow still reports how far it got rather than nothing.
  const entryPoints = [
    'startCaptureFlow',
    'startEditFlow',
    'startImageCaptureFlow',
    'startBrowserPageFlow',
  ]
  const unended = entryPoints.filter((name) => {
    const start = session.search(new RegExp(`export (?:async )?function ${name}\\(`))
    if (start < 0) return true
    const next = session.slice(start + 1).search(/\n(?:export )?(?:async )?function \w+\(/)
    const body = session.slice(start, next < 0 ? undefined : start + 1 + next)
    return !/flowActive = true\s+beginFlowLatency\('/.test(body)
      || !/finally[\s\S]*?flowActive = false\s+endFlowLatency\(\)/.test(body)
  })
  check(
    'each of the four entry points begins its measurement and ends it in finally',
    unended.length === 0,
    `not ended in finally: ${unended.join(', ')}`,
  )

  const shows = count(/await initializeAndShowEditor\(editor, init\)/g)
  const visibleMarks = count(/markFlowLatency\('editor-visible'\)/g)
  check(
    'every editor that is revealed marks the boundary that ends the measurement',
    shows === visibleMarks && shows === 3,
    `${String(shows)} reveals, ${String(visibleMarks)} marks`,
  )
  // Order, not just count: the mark must be the very next statement after the
  // paint boundary resolves (comments allowed), and the line reported at once.
  // Marking earlier would bill the paint to nobody; later, to the user.
  const pairedVisible = count(
    /await initializeAndShowEditor\(editor, init\)\s*(?:\/\/[^\n]*\s*)*markFlowLatency\('editor-visible'\)\s*reportFlowLatency\(\)/g,
  )
  check(
    'editor-visible is marked immediately after the painted reveal, then reported',
    pairedVisible === shows,
    `${String(pairedVisible)} of ${String(shows)} reveals are marked immediately`,
  )

  // Stages are refused if reordered, so the call sites must stay in order in
  // each of the two flows that freeze and save: video (runFlow) and the stills
  // (runImageFlowWithContext freezes, runImageEditor saves and reveals).
  const bodyOf = (name: string): string => {
    const start = session.search(new RegExp(`\\n(?:export )?(?:async )?function ${name}\\(`))
    if (start < 0) return ''
    const next = session.slice(start + 1).search(/\n(?:export )?(?:async )?function \w+\(/)
    return session.slice(start, next < 0 ? undefined : start + 1 + next)
  }
  const inOrder = (body: string, stages: string[]): boolean => {
    const at = stages.map((stage) => body.indexOf(`markFlowLatency('${stage}')`))
    return at.every((index, i) => index >= 0 && (i === 0 || index > (at[i - 1] ?? -1)))
  }
  check(
    'the video flow marks frozen, saved and editor-visible in that order',
    inOrder(bodyOf('runFlow'), ['frozen', 'saved', 'editor-visible']),
  )
  check(
    'the still flows freeze before the selector and save before the reveal',
    inOrder(bodyOf('runImageFlowWithContext'), ['frozen'])
      && /markFlowLatency\('frozen'\)[\s\S]*const selectorShownAtMs/.test(bodyOf('runImageFlowWithContext'))
      && inOrder(bodyOf('runImageEditor'), ['saved', 'editor-visible']),
  )
  check(
    'the re-edit flow, which reopens a saved pack, marks only editor-visible',
    inOrder(bodyOf('runEditFlow'), ['editor-visible'])
      && !/markFlowLatency\('(?:frozen|saved)'\)/.test(bodyOf('runEditFlow')),
  )
  check(
    'the selector wait is noted before a cancelled selection returns',
    /noteFlowUserWait\(monotonicNowMs\(\) - selectorShownAtMs\)\s*if \(selection === null\)/.test(session),
  )

  check(
    'the user-held span of the image selector is excluded explicitly',
    /const selectorShownAtMs = monotonicNowMs\(\)[\s\S]{0,160}const selection = await selectionPending[\s\S]{0,160}noteFlowUserWait\(monotonicNowMs\(\) - selectorShownAtMs\)/.test(session),
    'the selector wait is measured from its display until selection resolves',
  )

  check(
    'the measurement runs on a monotonic clock, not the wall clock',
    /process\.hrtime\.bigint\(\)/.test(session) &&
      !/beginCaptureLatency\([^)]*Date\.now\(\)/.test(session),
    'a wall-clock reading reaches the latency measurement',
  )

  check(
    'the live release gate allows at most 5000 ms and invokes the log assertion',
    /assert-live-capture-latency\.mjs[^\r\n]*5000/.test(releaseWorkflow),
    'release workflow is not wired to the 5000 ms assertion',
  )
  check(
    'the live-log assertion requires one video result and caps hands-off at both visible time and the configured limit',
    /lines\.length !== 1/.test(liveAssertion) &&
      /handsOffMs > visibleMs \|\| handsOffMs > limitMs/.test(liveAssertion),
    'live assertion does not enforce a unique result within the limit',
  )
}

console.log(`\n${String(passed)} passed, ${String(failed)} failed`)
if (failed > 0) process.exit(1)
