// THE PICK IS A STATEMENT ABOUT ONE FRAME (GOAL "The still is the context").
//
// 0.4.0 stopped following objects through a replay. Every hard defect of the
// preceding two weeks lived in the join between moving geometry and a video
// frame — #89's 118-127 ms exposure latency, a second display's unobservable
// clock origin, and a display that recorded 17.6 s of wall time into 5.29 s of
// media with its 903 ms stall silently collapsed. None of those can be repaired
// by a single offset, and none of them exist for a single instant.
//
// This check has two halves, and the second is the one that keeps the promise
// SPEC §13.1 makes: the app stopped WRITING tracks, and did not stop READING
// them. A pack written in 2026-07 must still open in 2027.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { annotationAt } from '../src/shared/track'
import { rebaseAnnotationClock } from '../src/shared/motion'
import type { Annotation } from '../src/shared/types'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
    return
  }
  failed += 1
  console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const src = (rel: string): string =>
  readFileSync(path.join(process.cwd(), rel), 'utf8')

console.log('Nothing writes a track any more')
{
  const editor = src('src/renderer/editor/editor.ts')
  check(
    'the editor has no track request, projection or re-anchor',
    !editor.includes('attachTrack')
      && !editor.includes('refreshTrack')
      && !editor.includes('requestObjectTrack')
      && !editor.includes('projectControlTrack')
      && !editor.includes('reanchorBounds'),
  )
  // The defect class this closes, named so it cannot be reintroduced by
  // accident: #107 and #111 were both a lifetime edit dragging the box's anchor
  // with it. With no path to re-anchor against, the box cannot move.
  check(
    'a lifetime edit has no path to move the box along',
    !editor.includes('lifeKey(pending) !== before) refreshTrack')
      && !editor.includes('lifeKey(a) !== life) refreshTrack'),
  )
  check(
    'main offers no object-track service, and the channel is gone',
    !src('src/main/context/session.ts').includes('trackOf(')
      && !src('src/main/context/service.ts').includes('contextRequestTrack')
      && !src('src/shared/ipc.ts').includes('contextRequestTrack')
      && !src('src/shared/ipc.ts').includes('ObjectTrackSample'),
  )
  // The pick itself must survive: `target` is the durable half of what tracking
  // was trying to say, and it is now the whole of it.
  check(
    'picking still records what the object IS',
    src('src/shared/types.ts').includes('AnnotationTarget')
      && src('src/renderer/editor/editor.ts').includes('invalidateTargetIfMoved'),
  )
}

console.log('\nA pack written before 0.4.0 still reads exactly as it did')
{
  // The shape a 0.3.x writer produced, including a sample on another display.
  const legacy = {
    annotation_id: 'ann_legacy',
    type: 'box',
    display: 1,
    bounds: { x: 100, y: 800, width: 200, height: 100 },
    text: 'Save',
    start_ms: 100,
    end_ms: 900,
    numbered: true,
    blur: false,
    tracking: {
      enabled: true,
      picked_at_ms: 100,
      samples: [
        { t_ms: 100, x: 100, y: 800, width: 200, height: 100 },
        { t_ms: 400, display: 2, x: 1_275, y: 240, width: 300, height: 150 },
        { t_ms: 700, display: 3, x: 300, y: 450, width: 250, height: 125 },
      ],
    },
    created_at: '2026-07-30T00:00:00.000Z',
    z: 1,
  } as unknown as Annotation

  const early = annotationAt(legacy, 100)
  const late = annotationAt(legacy, 700)
  check(
    'the box still moves with its recorded samples',
    early.bounds.x === 100 && late.bounds.x === 300,
    `${String(early.bounds.x)} -> ${String(late.bounds.x)}`,
  )
  check(
    'and each sample keeps the display its numbers are pixels of',
    late.display === 3,
    String(late.display),
  )
  // A trim still has to carry the whole annotation, not just its lifetime
  // (#114). Legacy packs are exactly the ones that can be re-edited and
  // re-trimmed, so this path must keep working after the writer stopped.
  const trimmed = rebaseAnnotationClock(legacy, -100, 800)
  check(
    'a trim still rebases a legacy track with the lifetime it moves',
    trimmed.start_ms === 0
      && (trimmed.tracking.samples ?? []).map((s) => s.t_ms).join(',') === '0,300,600',
    (trimmed.tracking.samples ?? []).map((s) => s.t_ms).join(','),
  )
  check(
    'the reader is kept deliberately, not by accident',
    src('src/shared/track.ts').includes('samples')
      && src('src/shared/motion.ts').includes('samples'),
  )
}

console.log('\nThe specification says which half is which')
{
  const spec = src('../SPEC.md')
  check(
    'SPEC marks tracking as legacy rather than deleting it',
    spec.includes('Written by 0.2.0-0.3.x writers')
      || spec.includes('written by 0.2.0–0.3.x writers'),
  )
  check(
    'and still requires a reader to honour one',
    spec.includes('Readers MUST continue to honour `tracking`'),
  )
}

console.log(`\nstill-context checks: ${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
