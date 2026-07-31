// THE MEASURED SOURCE LATENCY REACHES THE PACK, OR SAYS NOTHING (#115).
//
// Calibration succeeded once in this machine's whole log — 37.69 ms of pixel
// exposure on display 1 at 0.92 confidence, 2026-07-31 19:54 — and the number
// lived in a log line and nowhere else. #115 gave it a memory; this gives it a
// place in the evidence, so it can be put beside qa:exposure-field's 118-127 ms
// and the remaining difference can be attributed to a leg rather than guessed.
//
// Every rule here is a refusal to publish something that reads as measured and
// is not. This exercises the real writer: the shared shape function the main
// process calls, and buildManifest's own version decision.
import {
  manifestSourceLatencyFrom,
  FORMAT_VERSION_SOURCE_LATENCY,
} from '../src/shared/types'
import type { MeasuredSourceLatency } from '../src/shared/types'
import { buildManifest } from '../src/main/exporter'
import { readFileSync } from 'node:fs'
import path from 'node:path'

let passed = 0
let failed = 0

function check(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) {
    passed += 1
    console.log(`  PASS  ${name}`)
    return
  }
  failed += 1
  console.log(`  FAIL  ${name}\n        got  ${g}\n        want ${w}`)
}

/** The real measurement, in the shape the main process remembers it. */
function measured(
  overrides: Partial<MeasuredSourceLatency> = {},
): MeasuredSourceLatency {
  return {
    latencyMs: 37.69,
    confidence: 0.9237,
    measuredAtMs: 1_000_000,
    referenceSource: 'dxgi-desktop-duplication',
    referenceTiming: 'pixel-exposure',
    uncertaintyMs: 0.42,
    fromCurrentRecorder: true,
    ...overrides,
  }
}

console.log('The measurement is published at the resolution it actually has')
{
  const published = manifestSourceLatencyFrom(measured(), 1_000_000)
  check(
    'the real 37.69 ms is written to one decimal, not ten microseconds',
    published?.measured_ms,
    37.7,
  )
  check('and carries what it was matched against', {
    reference: published?.reference,
    timing: published?.timing,
  }, {
    reference: 'dxgi-desktop-duplication',
    timing: 'pixel-exposure',
  })
  check('the matcher confidence is two decimals', published?.confidence, 0.92)
  check('the reference error bar comes with it', published?.uncertainty_ms, 0.4)
  check(
    'this recorder measured it, so there is no age to declare',
    published?.age_ms,
    undefined,
  )
}

console.log('\nA borrowed measurement never reads as a fresh one')
{
  const borrowed = manifestSourceLatencyFrom(
    measured({ fromCurrentRecorder: false }),
    1_812_345,
  )
  check('a carried value states its age', borrowed?.age_ms, 812_345)
  check('as whole milliseconds', Number.isInteger(borrowed?.age_ms), true)
  check('and is still the value it measured', borrowed?.measured_ms, 37.7)
  // A clock that went backwards must not produce a negative age, which would
  // read as a measurement from the future.
  const backwards = manifestSourceLatencyFrom(
    measured({ fromCurrentRecorder: false }),
    999_000,
  )
  check('a backwards clock cannot date a measurement forward', backwards?.age_ms, 0)
}

console.log('\nWhat cannot be said is not said')
{
  check(
    'a latency with no reference is not published',
    manifestSourceLatencyFrom(measured({ referenceSource: undefined }), 0),
    undefined,
  )
  check(
    'nor one whose reference is not a reference this format knows',
    manifestSourceLatencyFrom(measured({ referenceSource: 'guessed' }), 0),
    undefined,
  )
  // SPEC 5.3: the copied surface may already have been stale by an unobserved
  // amount, so a completion timestamp is not an exposure latency at all.
  check(
    'an operation completion is refused rather than relabelled',
    manifestSourceLatencyFrom(
      measured({ referenceTiming: 'post-bitblt-completion' }),
      0,
    ),
    undefined,
  )
  check(
    'and an unknown timing is refused with it',
    manifestSourceLatencyFrom(measured({ referenceTiming: undefined }), 0),
    undefined,
  )
  check(
    'a non-finite latency is not a measurement',
    manifestSourceLatencyFrom(measured({ latencyMs: Number.NaN }), 0),
    undefined,
  )
  check(
    'nor is a negative one',
    manifestSourceLatencyFrom(measured({ latencyMs: -1 }), 0),
    undefined,
  )
  // Optional members drop out on their own rather than dragging the whole
  // measurement down with them: the number is still evidence without them.
  const bare = manifestSourceLatencyFrom(
    measured({ confidence: undefined, uncertaintyMs: undefined }),
    0,
  )
  check('a measurement without a confidence still publishes', bare?.measured_ms, 37.7)
  check('omitting the members it does not have', {
    confidence: bare?.confidence,
    uncertainty_ms: bare?.uncertainty_ms,
  }, { confidence: undefined, uncertainty_ms: undefined })
  const nonsense = manifestSourceLatencyFrom(
    measured({ confidence: Number.NaN, uncertaintyMs: -3 }),
    0,
  )
  check('an impossible confidence is dropped, not written', nonsense?.confidence, undefined)
  check('and a negative error bar with it', nonsense?.uncertainty_ms, undefined)
}

console.log('\nOnly a pack that emits one declares 0.6.0')
{
  const cadence = {
    achieved_fps: 14.8,
    worst_stall_ms: 114,
    requested_fps: 15,
    backend: 'chromium-desktop-capture',
    quality: 'full',
    recorder_count: 1,
  }
  const base = {
    id: 'source-latency-pack-check',
    createdAt: new Date('2026-07-31T19:54:00Z'),
    generatorVersion: '0.3.4-rc.8',
    title: '',
    note: '',
    osVersion: '11',
    screens: [{ width: 640, height: 360, scale: 1 }],
    captureKind: 'video',
    hasReplay: true,
    replayFile: 'replay.mp4',
    replayDurationMs: 2_000,
    snapshotTMs: 2_000,
  }

  const withLatency = buildManifest({
    ...base,
    cadence: {
      ...cadence,
      source_latency: manifestSourceLatencyFrom(measured(), 1_000_000),
    },
  } as never)
  check(
    'a pack carrying a measured latency declares 0.6.0',
    withLatency.format_version,
    FORMAT_VERSION_SOURCE_LATENCY,
  )
  check(
    'and the manifest actually contains it',
    (withLatency.media.cadence as Record<string, unknown> | undefined)
      ?.source_latency,
    {
      measured_ms: 37.7,
      reference: 'dxgi-desktop-duplication',
      timing: 'pixel-exposure',
      confidence: 0.92,
      uncertainty_ms: 0.4,
    },
  )

  // SPEC 13.1: write the oldest version that fully expresses the content.
  // Every unnecessary bump costs the pack an audience of older readers.
  check(
    'the same pack without one keeps 0.4.0',
    buildManifest({ ...base, cadence } as never).format_version,
    '0.4.0',
  )
  check(
    'and one with no provenance at all keeps 0.3.0',
    buildManifest({
      ...base,
      cadence: { achieved_fps: 14.8, worst_stall_ms: 114 },
    } as never).format_version,
    '0.3.0',
  )

  // A cadence the manifest will not declare cannot raise its version. This is
  // the same list buildManifest checks the 0.4.0 provenance on, and a
  // screenshot carrying stale recorder state is exactly the caller it guards.
  check(
    'a screenshot does not declare 0.6.0 for a cadence it never writes',
    buildManifest({
      ...base,
      captureKind: 'image',
      imageScope: 'fullscreen',
      hasReplay: false,
      replayFile: null,
      replayDurationMs: null,
      snapshotTMs: undefined,
      cadence: {
        ...cadence,
        source_latency: manifestSourceLatencyFrom(measured(), 1_000_000),
      },
    } as never).format_version,
    '0.3.0',
  )
}

console.log('\nThe format says what the writer does')
{
  const spec = readFileSync(path.join(process.cwd(), '..', 'SPEC.md'), 'utf8')
  check(
    'SPEC 5.3 defines the member and its required inner fields',
    spec.includes('Format 0.6.0 adds OPTIONAL `source_latency` (object)')
      && spec.includes('are all REQUIRED inside the object'),
    true,
  )
  check(
    'SPEC 5.3 refuses a completion timestamp as a measured source latency',
    spec.includes(
      'A writer MUST NOT report a measured source latency whose `timing` is',
    ),
    true,
  )
  check(
    'SPEC 5.3 states what an absent age means',
    spec.includes(
      '**Absent `age_ms` means the recorder that produced this replay measured it.**',
    ),
    true,
  )
  check(
    'SPEC 5.3 permits carrying a measurement forward, with its age and its backend',
    spec.includes('A writer\nMAY carry a measurement forward from an earlier capture')
      || spec.includes('A writer MAY carry a measurement forward from an earlier capture'),
    true,
  )
  check(
    'SPEC 13.1 gives the member its version, as the 0.4.0 provenance has',
    spec.includes(
      'The optional `source_latency` member of `media.cadence` and `media.displays[].cadence` was',
    ) && spec.includes('MUST declare `format_version` 0.6.0 or later'),
    true,
  )
  const schema = JSON.parse(
    readFileSync(
      path.join(process.cwd(), '..', 'docs', 'schemas', 'manifest.schema.json'),
      'utf8',
    ),
  ) as {
    $defs: Record<string, { required?: string[]; properties?: Record<string, unknown> }>
  }
  check(
    'the schema requires the three fields the prose requires',
    schema.$defs.source_latency?.required,
    ['measured_ms', 'reference', 'timing'],
  )
  check(
    'and the cadence points at it',
    (schema.$defs.cadence?.properties as Record<string, unknown> | undefined)
      ?.source_latency,
    { $ref: '#/$defs/source_latency' },
  )
}

console.log(
  `\nsource latency pack checks: ${passed} passed, ${failed} failed`,
)
process.exitCode = failed === 0 ? 0 : 1
