import type {
  ReplayPixelClockDecision,
  ReplayPixelClockFingerprint,
  ReplayPixelClockPresentedSample,
  ReplayPixelClockDecodedSample,
} from '../src/renderer/capture/replayPixelClock'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) passed += 1
  else failed += 1
  console.log(
    `  ${condition ? 'PASS' : 'FAIL'}  ${name}`
      + (detail === '' ? '' : ` — ${detail}`),
  )
}

function fingerprint(index: number, weak = false): ReplayPixelClockFingerprint {
  const width = 16
  const height = 8
  const rgb = new Uint8Array(width * height * 3)
  rgb.fill(20)
  const column = index % width
  const value = weak ? 10 + index * 4 : 60 + (index * 29) % 180
  for (let y = 1; y < height - 1; y += 1) {
    const offset = (y * width + column) * 3
    rgb[offset] = value
    rgb[offset + 1] = weak ? value : 255 - value
    rgb[offset + 2] = weak ? value : (value * 3) % 255
  }
  return {
    kind: 'source-latency-rgb-v1',
    width,
    height,
    meanLuma: value,
    darkRatio: 0,
    rgb,
    cells: rgb,
  }
}

function scenario(
  originMs: number,
  rawRingDelayMs: number,
  sourceToProcessorLatencyMs: number,
  count = 8,
): {
  presented: ReplayPixelClockPresentedSample[]
  decoded: ReplayPixelClockDecodedSample[]
} {
  const frames = Array.from({ length: count }, (_, index) => fingerprint(index))
  const pts = frames.map(
    (_frame, index) =>
      rawRingDelayMs + sourceToProcessorLatencyMs + index * 37,
  )
  return {
    presented: frames.map((frame, index) => ({
      presentedAtMs: originMs + (pts[index] ?? 0),
      fingerprint: frame,
    })),
    decoded: frames.map((frame, index) => ({
      ptsMs: pts[index] ?? 0,
      fingerprint: frame,
    })),
  }
}

function measuredOrigin(decision: ReplayPixelClockDecision): number | undefined {
  return decision.status === 'measured' ? decision.originMs : undefined
}

function mediaClockScenario(
  originMs: number,
  inconsistent = false,
): {
  presented: ReplayPixelClockPresentedSample[]
  decoded: ReplayPixelClockDecodedSample[]
  directPts: number[]
} {
  const ptsByPresentation = [75, 100, 150, 200, 250, 300, 350, 375]
  const directPositions = new Set([1, 2, 4, 5, 6])
  const frameByPosition = new Map<number, ReplayPixelClockFingerprint>()
  let directIndex = 0
  for (const position of directPositions) {
    frameByPosition.set(position, fingerprint(directIndex))
    directIndex += 1
  }
  const presented = ptsByPresentation.map((ptsMs, position) => {
    const directFrame = frameByPosition.get(position)
    const mediaTimeMs =
      ptsMs - 10 + (inconsistent && position === 4 ? 4 : 0)
    return {
      presentedAtMs: originMs + ptsMs,
      mediaTimeMs,
      fingerprint: directFrame ?? fingerprint(8 + position),
    }
  })
  const decoded = [...directPositions].map((position) => ({
    ptsMs: ptsByPresentation[position]!,
    fingerprint: frameByPosition.get(position)!,
  }))
  return {
    presented,
    decoded,
    directPts: decoded.map((sample) => sample.ptsMs),
  }
}

async function main(): Promise<void> {
  const modulePath = '../src/renderer/capture/replayPixelClock.ts'
  const {
    decideReplayPixelClock,
    REPLAY_PIXEL_CLOCK_MAX_FINGERPRINT_BYTES,
    REPLAY_PIXEL_CLOCK_SAMPLE_LIMIT,
    REPLAY_PIXEL_CLOCK_TOTAL_FINGERPRINT_BYTES,
    retainReplayPixelClockPresentedSample,
    sourceClockAnchorsFromObservedCaptureTime,
    sourceClockAnchorsFromMeasuredMediaTime,
  } = await import(modulePath) as typeof import(
    '../src/renderer/capture/replayPixelClock'
  )
  const originMs = 1_785_000_000_123

  const fast = scenario(originMs, 12, 18)
  const slow = scenario(originMs, 91, 147)
  const fastDecision = decideReplayPixelClock(fast.presented, fast.decoded)
  const slowDecision = decideReplayPixelClock(slow.presented, slow.decoded)
  check(
    'dynamic identical pixels measure the observed presentation-minus-PTS origin',
    measuredOrigin(fastDecision) === originMs,
    JSON.stringify(fastDecision),
  )
  check(
    'independent raw-ring and source-to-processor delay changes do not move the pixel origin',
    measuredOrigin(fastDecision) === originMs
      && measuredOrigin(slowDecision) === originMs,
    `fast=${JSON.stringify(fastDecision)}; slow=${JSON.stringify(slowDecision)}`,
  )

  const staticFingerprint = fingerprint(0)
  const staticDecision = decideReplayPixelClock(
    Array.from({ length: 8 }, (_, index) => ({
      presentedAtMs: originMs + index * 33,
      fingerprint: staticFingerprint,
    })),
    Array.from({ length: 8 }, (_, index) => ({
      ptsMs: index * 33,
      fingerprint: staticFingerprint,
    })),
  )
  check(
    'static pixels remain ambiguous',
    staticDecision.status === 'ambiguous'
      && staticDecision.reason === 'static-content',
    JSON.stringify(staticDecision),
  )

  const repeated = [fingerprint(0), fingerprint(1), fingerprint(2)]
  const multipleDecision = decideReplayPixelClock(
    [...repeated, ...repeated].map((frame, index) => ({
      presentedAtMs: originMs + index * 33,
      fingerprint: frame,
    })),
    [...repeated, ...repeated].map((frame, index) => ({
      ptsMs: index * 33,
      fingerprint: frame,
    })),
  )
  check(
    'repeated identical visits with multiple time candidates remain ambiguous',
    multipleDecision.status === 'ambiguous'
      && multipleDecision.reason === 'multiple-pixel-matches',
    JSON.stringify(multipleDecision),
  )

  const weakFrames = Array.from({ length: 8 }, (_, index) =>
    fingerprint(index, true),
  )
  const weakDecision = decideReplayPixelClock(
    weakFrames.map((frame, index) => ({
      presentedAtMs: originMs + index * 33,
      fingerprint: frame,
    })),
    weakFrames.map((frame, index) => ({
      ptsMs: index * 33,
      fingerprint: frame,
    })),
  )
  check(
    'a weakly distinct pixel match remains ambiguous',
    weakDecision.status === 'ambiguous'
      && weakDecision.reason === 'weak-pixel-match',
    JSON.stringify(weakDecision),
  )

  const outlier = scenario(originMs, 20, 40)
  const outlierPresented = outlier.presented.map((sample, index) =>
    index === 3
      ? { ...sample, presentedAtMs: sample.presentedAtMs + 800 }
      : sample,
  )
  const outlierDecision = decideReplayPixelClock(
    outlierPresented,
    outlier.decoded,
  )
  check(
    'one exact-pixel timestamp outlier cannot move a coherent origin cluster',
    measuredOrigin(outlierDecision) === originMs
      && outlierDecision.matchCount === 7,
    JSON.stringify(outlierDecision),
  )

  const incoherent = scenario(originMs, 20, 40)
  const incoherentDecision = decideReplayPixelClock(
    incoherent.presented.map((sample, index) => ({
      ...sample,
      presentedAtMs: sample.presentedAtMs + index * 12,
    })),
    incoherent.decoded,
  )
  check(
    'smooth exact-match clock drift produces measured monotonic anchors',
    incoherentDecision.status === 'measured'
      && incoherentDecision.originMs === undefined
      && incoherentDecision.originSpreadMs === 84
      && incoherentDecision.clockAnchors?.length === 8
      && incoherentDecision.clockAnchors.every(
        (anchor, index, anchors) =>
          index === 0
          || (
            anchor.ptsMs > anchors[index - 1]!.ptsMs
            && anchor.presentedAtMs > anchors[index - 1]!.presentedAtMs
          ),
      )
      && incoherentDecision.candidateOriginsMs?.length === 8
      && new Set(incoherentDecision.candidateOriginsMs).size === 8,
    JSON.stringify(incoherentDecision),
  )

  const nonMonotonic = scenario(originMs, 20, 40)
  const nonMonotonicShifts = [0, 84, -84, 168, -168, 252, -252, 336]
  const nonMonotonicDecision = decideReplayPixelClock(
    nonMonotonic.presented.map((sample, index) => ({
      ...sample,
      presentedAtMs:
        sample.presentedAtMs + (nonMonotonicShifts[index] ?? 0),
    })),
    nonMonotonic.decoded,
  )
  check(
    'non-monotonic exact matches remain ambiguous and retain bounded evidence',
    nonMonotonicDecision.status === 'ambiguous'
      && nonMonotonicDecision.reason === 'incoherent-origin-cluster'
      && nonMonotonicDecision.candidateOriginsMs?.length === 8,
    JSON.stringify(nonMonotonicDecision),
  )

  const mediaClock = mediaClockScenario(originMs)
  const mediaClockDecision = decideReplayPixelClock(
    mediaClock.presented,
    mediaClock.decoded,
  )
  check(
    'a proven media-time relation extends five direct matches to all eight observed callbacks',
    mediaClockDecision.status === 'measured'
      && mediaClockDecision.matchCount === 5
      && mediaClockDecision.clockAnchors?.length === 8
      && mediaClockDecision.clockAnchors.every(
        (anchor, index) =>
          anchor.ptsMs === [75, 100, 150, 200, 250, 300, 350, 375][index]
          && anchor.presentedAtMs
            === originMs + [75, 100, 150, 200, 250, 300, 350, 375][index]!,
      )
      && mediaClockDecision.clockAnchors[0]?.ptsMs === 75
      && mediaClockDecision.clockAnchors.at(-1)?.ptsMs === 375,
    JSON.stringify(mediaClockDecision),
  )

  const inconsistentMediaClock = mediaClockScenario(originMs, true)
  const inconsistentMediaClockDecision = decideReplayPixelClock(
    inconsistentMediaClock.presented,
    inconsistentMediaClock.decoded,
  )
  check(
    'an inconsistent media-time relation is rejected and preserves direct anchors only',
    inconsistentMediaClockDecision.status === 'measured'
      && inconsistentMediaClockDecision.matchCount === 5
      && inconsistentMediaClockDecision.clockAnchors?.length === 5
      && inconsistentMediaClockDecision.clockAnchors.every(
        (anchor, index) =>
          anchor.ptsMs === inconsistentMediaClock.directPts[index],
      ),
    JSON.stringify(inconsistentMediaClockDecision),
  )

  const sourceMediaOriginMs = 1_785_000_100_000
  const variablePresentationAnchors = [
    {
      ptsMs: 100,
      mediaTimeMs: 90,
      presentedAtMs: sourceMediaOriginMs + 90 + 90,
    },
    {
      ptsMs: 200,
      mediaTimeMs: 190,
      presentedAtMs: sourceMediaOriginMs + 190 + 131,
    },
    {
      ptsMs: 300,
      mediaTimeMs: 290,
      presentedAtMs: sourceMediaOriginMs + 290 + 159,
    },
  ]
  const variableSourceAnchors = sourceClockAnchorsFromMeasuredMediaTime(
    variablePresentationAnchors,
    sourceMediaOriginMs,
  )
  check(
    'variable presentation delay cannot move a DXGI-calibrated media source clock',
    variableSourceAnchors?.map((anchor) => anchor.wallMs).join(',')
      === [
        sourceMediaOriginMs + 90,
        sourceMediaOriginMs + 190,
        sourceMediaOriginMs + 290,
      ].join(','),
    JSON.stringify(variableSourceAnchors),
  )
  check(
    'a reset media sink epoch is rejected instead of reusing the readiness calibration',
    sourceClockAnchorsFromMeasuredMediaTime(
      [
        {
          ptsMs: 100,
          mediaTimeMs: 0,
          presentedAtMs: sourceMediaOriginMs + 1_300,
        },
        {
          ptsMs: 200,
          mediaTimeMs: 100,
          presentedAtMs: sourceMediaOriginMs + 1_400,
        },
        {
          ptsMs: 300,
          mediaTimeMs: 200,
          presentedAtMs: sourceMediaOriginMs + 1_500,
        },
      ],
      sourceMediaOriginMs,
    ) === undefined,
  )

  const observedCaptureAnchors = [
    {
      ptsMs: 100,
      presentedAtMs: sourceMediaOriginMs + 190,
      capturedAtMs: sourceMediaOriginMs + 90,
    },
    {
      ptsMs: 200,
      presentedAtMs: sourceMediaOriginMs + 321,
      capturedAtMs: sourceMediaOriginMs + 190,
    },
    {
      ptsMs: 300,
      presentedAtMs: sourceMediaOriginMs + 449,
      capturedAtMs: sourceMediaOriginMs + 290,
    },
  ]
  check(
    'observed getDisplayMedia captureTime directly owns the replay source clock',
    sourceClockAnchorsFromObservedCaptureTime(
      observedCaptureAnchors,
    )?.map((anchor) => anchor.wallMs).join(',')
      === observedCaptureAnchors
        .map((anchor) => anchor.capturedAtMs)
        .join(','),
  )
  check(
    'an impossible source timestamp after presentation is rejected',
    sourceClockAnchorsFromObservedCaptureTime([
      ...observedCaptureAnchors.slice(0, 2),
      {
        ...observedCaptureAnchors[2]!,
        capturedAtMs: observedCaptureAnchors[2]!.presentedAtMs + 1,
      },
    ]) === undefined,
  )

  const productionMediaOriginMs = 1_785_418_926_910.3362
  const productionLikeAnchors = [
    {
      ptsMs: 9_685.333,
      mediaTimeMs: 12_117.885,
      presentedAtMs: productionMediaOriginMs + 12_117.885 + 78.479,
    },
    {
      ptsMs: 9_718.033,
      mediaTimeMs: 12_150.614,
      presentedAtMs: productionMediaOriginMs + 12_150.614 + 78.482,
    },
    {
      ptsMs: 10_399.3,
      mediaTimeMs: 12_834.213,
      presentedAtMs: productionMediaOriginMs + 12_834.213 + 78.351,
    },
    {
      ptsMs: 11_787.6,
      mediaTimeMs: 14_235.249,
      presentedAtMs: productionMediaOriginMs + 14_235.249 + 78.415,
    },
  ]
  const productionSourceAnchors =
    sourceClockAnchorsFromMeasuredMediaTime(
      productionLikeAnchors,
      productionMediaOriginMs,
    )
  check(
    'exact pixel matches keep their measured source clock despite normal MP4 PTS/mediaTime drift',
    productionSourceAnchors?.every(
      (anchor, index) =>
        anchor.wallMs
          === productionMediaOriginMs
            + productionLikeAnchors[index]!.mediaTimeMs,
    ) === true,
    JSON.stringify(productionSourceAnchors),
  )

  const retained: ReplayPixelClockPresentedSample[] = []
  for (let presentedAtMs = 0; presentedAtMs <= 14_000; presentedAtMs += 1_000 / 30) {
    retainReplayPixelClockPresentedSample(
      retained,
      {
        presentedAtMs,
        mediaTimeMs: presentedAtMs,
        fingerprint: fingerprint(Math.round(presentedAtMs / 100)),
      },
      12_000,
    )
  }
  check(
    'the bounded presentation evidence spans the retained replay instead of only its final seconds',
    retained.length <= REPLAY_PIXEL_CLOCK_SAMPLE_LIMIT
      && retained.length >= 50
      && retained[0] !== undefined
      && retained.at(-1) !== undefined
      && retained.at(-1)!.presentedAtMs - retained[0]!.presentedAtMs >= 11_000
      && retained.at(-1)!.presentedAtMs >= 13_800,
    JSON.stringify({
      count: retained.length,
      first: retained[0]?.presentedAtMs,
      last: retained.at(-1)?.presentedAtMs,
    }),
  )

  const malformed = scenario(originMs, 0, 0)
  const nanDecision = decideReplayPixelClock(
    [{ ...malformed.presented[0]!, presentedAtMs: Number.NaN }],
    malformed.decoded,
  )
  check(
    'NaN timestamps are unavailable rather than guessed',
    nanDecision.status === 'unavailable'
      && nanDecision.reason === 'invalid-sample',
    JSON.stringify(nanDecision),
  )

  const oversized = scenario(originMs, 0, 0, 65)
  const oversizedDecision = decideReplayPixelClock(
    oversized.presented,
    oversized.decoded,
  )
  check(
    'the declared two-sided fingerprint budget remains below four MiB',
    REPLAY_PIXEL_CLOCK_SAMPLE_LIMIT === 64
      && REPLAY_PIXEL_CLOCK_MAX_FINGERPRINT_BYTES === 128 * 72 * 3
      && REPLAY_PIXEL_CLOCK_TOTAL_FINGERPRINT_BYTES
        === 64 * 2 * 128 * 72 * 3
      && REPLAY_PIXEL_CLOCK_TOTAL_FINGERPRINT_BYTES <= 4 * 1024 * 1024,
    String(REPLAY_PIXEL_CLOCK_TOTAL_FINGERPRINT_BYTES),
  )
  check(
    'sample cardinality is rejected above the fixed memory bound',
    oversizedDecision.status === 'unavailable'
      && oversizedDecision.reason === 'sample-limit-exceeded',
    JSON.stringify(oversizedDecision),
  )

  console.log(
    `\nreplay pixel clock checks: ${passed} passed, ${failed} failed`,
  )
  if (failed > 0) process.exitCode = 1
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
