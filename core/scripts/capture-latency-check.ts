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
  const count = (pattern: RegExp): number => (session.match(pattern) ?? []).length

  const gates = count(/flowActive = true/g)
  const begins = count(/beginFlowLatency\('/g)
  check(
    'every flow that takes the exclusive gate begins a measurement',
    gates === begins && begins === 3,
    `${String(gates)} gates, ${String(begins)} begins`,
  )

  const ends = count(/endFlowLatency\(\)(?!:)/g)
  check(
    'and every one of them ends it, so no flow reports nothing',
    ends === begins,
    `${String(begins)} begins, ${String(ends)} ends`,
  )

  const shows = count(/await initializeAndShowEditor\(editor, init\)/g)
  const visibleMarks = count(/markFlowLatency\('editor-visible'\)/g)
  check(
    'every editor that is revealed marks the boundary that ends the measurement',
    shows === visibleMarks && shows === 3,
    `${String(shows)} reveals, ${String(visibleMarks)} marks`,
  )

  check(
    'the user-held span of the image selector is excluded explicitly',
    /noteFlowUserWait\(/.test(session),
    'noteFlowUserWait is not called',
  )

  check(
    'the measurement runs on a monotonic clock, not the wall clock',
    /process\.hrtime\.bigint\(\)/.test(session) &&
      !/beginCaptureLatency\([^)]*Date\.now\(\)/.test(session),
    'a wall-clock reading reaches the latency measurement',
  )
}

console.log(`\n${String(passed)} passed, ${String(failed)} failed`)
if (failed > 0) process.exit(1)
