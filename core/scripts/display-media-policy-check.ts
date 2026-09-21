// Display-media routing must fail closed for an explicitly assigned recorder.
// A missing secondary source must never be replaced by the primary display and
// then reported as a healthy recording of the secondary display.
import {
  completeDisplayMediaRequest,
  displaySnapshotFailureMessage,
  readDisplaySnapshot,
  selectDisplayMediaSource,
  shouldSimulateNoFrames,
} from '../src/main/displayMediaPolicy'
import { readFileSync } from 'node:fs'
import path from 'node:path'

interface Source {
  id: string
  display_id: string
}

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

async function main(): Promise<void> {

const sources: readonly Source[] = [
  { id: 'screen:primary', display_id: '11' },
  { id: 'screen:secondary', display_id: '22' },
]

console.log('\nDisplay-media source routing')
{
  const selected = selectDisplayMediaSource(sources, '22', '11')
  check(
    'an assigned recorder receives its exact display source',
    selected?.id === 'screen:secondary',
    selected?.id,
  )
}

{
  const selected = selectDisplayMediaSource(sources, '99', '11')
  check(
    'a missing assigned source fails closed instead of duplicating primary',
    selected === undefined,
    selected?.id,
  )
}

{
  const selected = selectDisplayMediaSource(sources, undefined, '11')
  check(
    'an unassigned legacy request still prefers the primary source',
    selected?.id === 'screen:primary',
    selected?.id,
  )
}

{
  const selected = selectDisplayMediaSource(
    [{ id: 'screen:first', display_id: '22' }],
    undefined,
    '11',
  )
  check(
    'an unassigned legacy request still falls back to the first source',
    selected?.id === 'screen:first',
    selected?.id,
  )
}

check(
  'an empty source list stays unavailable',
  selectDisplayMediaSource([], undefined, '11') === undefined,
)

console.log('\nOne-shot display-media completion')
{
  const responses: Array<{ video?: Source }> = []
  const failures: string[] = []
  await completeDisplayMediaRequest(
    async () => sources[1],
    (response) => responses.push(response),
    (stage) => failures.push(stage),
  )
  check(
    'a valid source invokes the callback exactly once',
    responses.length === 1 && responses[0]?.video?.id === 'screen:secondary',
  )
  check('the valid completion reports no failure', failures.length === 0)
}

{
  const lookupError = new Error('source lookup failed')
  const responses: Array<{ video?: Source }> = []
  const failures: Array<{ stage: string; error: unknown }> = []
  await completeDisplayMediaRequest(
    async () => { throw lookupError },
    (response) => responses.push(response),
    (stage, error) => failures.push({ stage, error }),
  )
  check(
    'a rejected source lookup still invokes the callback exactly once with denial',
    responses.length === 1 && responses[0]?.video === undefined,
  )
  check(
    'a rejected source lookup is reported with its original error',
    failures.length === 1 &&
      failures[0]?.stage === 'source-lookup' &&
      failures[0]?.error === lookupError,
  )
}

{
  const callbackError = new Error('callback failed')
  let callbackCalls = 0
  const failures: Array<{ stage: string; error: unknown }> = []
  await completeDisplayMediaRequest(
    async () => sources[0],
    () => {
      callbackCalls += 1
      throw callbackError
    },
    (stage, error) => failures.push({ stage, error }),
  )
  check('a throwing one-shot callback is never retried', callbackCalls === 1)
  check(
    'a callback failure is contained and reported meaningfully',
    failures.length === 1 &&
      failures[0]?.stage === 'callback' &&
      failures[0]?.error === callbackError,
  )
}

{
  const responses: Array<{ video?: Source }> = []
  await completeDisplayMediaRequest(
    async () => undefined,
    (response) => responses.push(response),
    () => undefined,
  )
  check(
    'a source that disappears resolves as one explicit denial',
    responses.length === 1 && responses[0]?.video === undefined,
  )
}

interface FakeThumbnailOptions {
  empty?: boolean
  width?: number
  height?: number
  png?: Buffer
}

function snapshotSource(displayId: string, options: FakeThumbnailOptions = {}) {
  const png = options.png ?? Buffer.from('valid-png-bytes')
  return {
    display_id: displayId,
    thumbnail: {
      isEmpty: () => options.empty ?? false,
      getSize: () => ({ width: options.width ?? 1920, height: options.height ?? 1080 }),
      toPNG: () => png,
    },
  }
}

console.log('\nSnapshot image boundary')
{
  const png = Buffer.from('valid-png-bytes')
  const read = readDisplaySnapshot([snapshotSource('22', { png })], '22')
  check(
    'a valid exact-display thumbnail preserves its bytes and dimensions',
    read.ok &&
      read.snapshot.png === png &&
      read.snapshot.width === 1920 &&
      read.snapshot.height === 1080,
  )
}

{
  const read = readDisplaySnapshot([snapshotSource('22', { empty: true })], '22')
  check('an empty NativeImage is rejected', !read.ok && read.reason === 'thumbnail-empty')
}

for (const [name, options] of [
  ['zero-width', { width: 0 }],
  ['zero-height', { height: 0 }],
] as const) {
  const read = readDisplaySnapshot([snapshotSource('22', options)], '22')
  check(`${name} thumbnail dimensions are rejected`, !read.ok && read.reason === 'invalid-size')
}

{
  const read = readDisplaySnapshot([snapshotSource('22', { png: Buffer.alloc(0) })], '22')
  check('an empty PNG encoding is rejected', !read.ok && read.reason === 'empty-png')
  check(
    'an empty PNG rejection has a meaningful boundary message',
    !read.ok && displaySnapshotFailureMessage(read).includes('empty PNG'),
  )
}

{
  const read = readDisplaySnapshot([snapshotSource('11')], '22')
  check(
    'a disappeared display source is rejected instead of relabeling another display',
    !read.ok && read.reason === 'source-unavailable',
  )
}

console.log('\nNo-frame simulation scope')
check(
  'the legacy global flag still affects every display',
  shouldSimulateNoFrames(['CapturePack.exe', '--simulate-no-frames'], '11') &&
    shouldSimulateNoFrames(['CapturePack.exe', '--simulate-no-frames'], '22'),
)
check(
  'a scoped flag affects only its exact display',
  shouldSimulateNoFrames(['CapturePack.exe', '--simulate-no-frames=22'], '22') &&
    !shouldSimulateNoFrames(['CapturePack.exe', '--simulate-no-frames=22'], '11'),
)
check(
  'an empty scoped flag affects no display',
  !shouldSimulateNoFrames(['CapturePack.exe', '--simulate-no-frames='], '11'),
)
check(
  'similar argument names do not enable the simulation',
  !shouldSimulateNoFrames(['CapturePack.exe', '--simulate-no-frames-extra=11'], '11'),
)

console.log('\nProduction wiring')
{
  const captureSource = readFileSync(
    path.join(process.cwd(), 'src', 'main', 'capture.ts'),
    'utf8',
  )
  check(
    'the display-media handler delegates assigned source selection to the policy',
    captureSource.includes('selectDisplayMediaSource(sources, wantedId, primaryId)'),
  )
  check(
    'the display-media handler completes through the one-shot helper',
    captureSource.includes('void completeDisplayMediaRequest('),
  )
  check(
    'snapshot collection validates the exact source through the image boundary helper',
    captureSource.includes('readDisplaySnapshot(sources, String(d.id))'),
  )
  check(
    'the no-frame payload scopes the simulation by the current display id',
    captureSource.includes(
      'shouldSimulateNoFrames(process.argv, String(display.id))',
    ),
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
