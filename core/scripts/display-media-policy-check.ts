// Display-media routing must fail closed for an explicitly assigned recorder.
// A missing secondary source must never be replaced by the primary display and
// then reported as a healthy recording of the secondary display.
import {
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
    'the no-frame payload scopes the simulation by the current display id',
    captureSource.includes(
      'shouldSimulateNoFrames(process.argv, String(display.id))',
    ),
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
