/**
 * A compact RGB fingerprint compatible with the capture calibration raster.
 * The replay clock matcher deliberately depends only on pixels and the two
 * observed time axes; source-pipeline latency is not an input.
 */
export interface ReplayPixelClockFingerprint {
  readonly kind: 'source-latency-rgb-v1'
  readonly width: number
  readonly height: number
  readonly meanLuma: number
  readonly darkRatio: number
  readonly rgb: Uint8Array
  readonly cells: Uint8Array
}

export interface ReplayPixelClockPresentedSample {
  readonly presentedAtMs: number
  /**
   * getDisplayMedia's observed source capture instant, converted to the same
   * epoch-based DOMHighRes axis as `presentedAtMs`.
   */
  readonly capturedAtMs?: number
  /**
   * The media element's observed presentation position for this callback.
   * This is an observed clock value, not a frame-rate-derived timestamp.
   */
  readonly mediaTimeMs?: number
  readonly fingerprint: ReplayPixelClockFingerprint
}

export interface ReplayPixelClockDecodedSample {
  readonly ptsMs: number
  readonly fingerprint: ReplayPixelClockFingerprint
}

export interface ReplayPixelClockAnchor {
  readonly ptsMs: number
  readonly presentedAtMs: number
  /** Observed source capture instant for the same callback, when available. */
  readonly capturedAtMs?: number
  /** Observed on the same rVFC callback as `presentedAtMs`, when available. */
  readonly mediaTimeMs?: number
}

export interface ReplaySourceClockAnchor {
  readonly ptsMs: number
  readonly wallMs: number
}

export type ReplayPixelClockReason =
  | 'measured'
  | 'invalid-sample'
  | 'sample-limit-exceeded'
  | 'insufficient-samples'
  | 'static-content'
  | 'no-pixel-match'
  | 'weak-pixel-match'
  | 'multiple-pixel-matches'
  | 'incoherent-origin-cluster'
  | 'competing-origin-clusters'

export interface ReplayPixelClockDecision {
  readonly status: 'measured' | 'ambiguous' | 'unavailable'
  readonly reason: ReplayPixelClockReason
  readonly presentedSampleCount: number
  readonly decodedSampleCount: number
  readonly matchCount: number
  readonly originMs?: number
  readonly originSpreadMs?: number
  readonly motionTransitions?: number
  readonly bestDelta?: number
  readonly minimumContrast?: number
  readonly candidateOriginsMs?: readonly number[]
  /**
   * Exact same-pixel observations on both clocks, optionally extended to
   * other observed presentation callbacks through a proven media-time ↔ PTS
   * relation. Consumers may interpolate only this clock mapping between
   * anchors; object geometry remains observed and step-sampled independently.
   */
  readonly clockAnchors?: readonly ReplayPixelClockAnchor[]
}

export const REPLAY_PIXEL_CLOCK_SAMPLE_LIMIT = 64
export const REPLAY_PIXEL_CLOCK_MAX_FINGERPRINT_BYTES = 128 * 72 * 3
export const REPLAY_PIXEL_CLOCK_TOTAL_FINGERPRINT_BYTES =
  REPLAY_PIXEL_CLOCK_SAMPLE_LIMIT
  * 2
  * REPLAY_PIXEL_CLOCK_MAX_FINGERPRINT_BYTES

/**
 * Retain bounded evidence across the whole replay window.
 *
 * Keeping the last 64 callbacks covers only about two seconds at 30 fps. That
 * makes a long replay's source clock measurable only at its tail and leaves
 * historical object picking on the presentation clock. Sampling at a spacing
 * derived from the configured retention window keeps both edges observable
 * without increasing the fixed fingerprint budget.
 */
export function retainReplayPixelClockPresentedSample(
  samples: ReplayPixelClockPresentedSample[],
  sample: ReplayPixelClockPresentedSample,
  retentionMs: number,
): void {
  if (!Number.isFinite(sample.presentedAtMs)) return
  const previous = samples.at(-1)
  if (
    previous !== undefined
    && sample.presentedAtMs <= previous.presentedAtMs
  ) {
    return
  }
  const observedWindowMs =
    Number.isFinite(retentionMs) && retentionMs > 0 ? retentionMs : 0
  const minimumSpacingMs =
    observedWindowMs / (REPLAY_PIXEL_CLOCK_SAMPLE_LIMIT - 2)
  if (
    previous !== undefined
    && sample.presentedAtMs - previous.presentedAtMs < minimumSpacingMs
  ) {
    return
  }
  samples.push(sample)
  if (samples.length > REPLAY_PIXEL_CLOCK_SAMPLE_LIMIT) {
    samples.splice(0, samples.length - REPLAY_PIXEL_CLOCK_SAMPLE_LIMIT)
  }
}

const MINIMUM_SAMPLES = 5
const MINIMUM_MOTION_DELTA = 2
const MINIMUM_MOTION_TRANSITIONS = 2
const MAXIMUM_MATCH_DELTA = 6
const MINIMUM_MATCH_CONTRAST = 3
const MULTIPLE_MATCH_EPSILON = 1e-9
const ORIGIN_CLUSTER_TOLERANCE_MS = 4
const MINIMUM_CLUSTER_FRACTION = 0.7
const RETAINED_ORIGIN_LIMIT = 8
const MINIMUM_MEDIA_CLOCK_MATCHES = 3
const MAXIMUM_MEDIA_RELATION_SPREAD_FRACTION = 1 / 8
const MAXIMUM_SOURCE_PRESENTATION_AGE_MS = 1_000

interface PixelMatch {
  readonly presentedIndex: number
  readonly decodedIndex: number
  readonly presentedAtMs: number
  readonly ptsMs: number
  readonly originMs: number
  readonly delta: number
  readonly contrast: number
}

function strictlyIncreasing(values: readonly number[]): boolean {
  return values.every(
    (value, index) => index === 0 || value > values[index - 1]!,
  )
}

function minimumSpacing(values: readonly number[]): number | undefined {
  let minimum = Number.POSITIVE_INFINITY
  for (let index = 1; index < values.length; index += 1) {
    const spacing = values[index]! - values[index - 1]!
    if (!(spacing > 0) || !Number.isFinite(spacing)) return undefined
    minimum = Math.min(minimum, spacing)
  }
  return Number.isFinite(minimum) ? minimum : undefined
}

/**
 * Extends exact-pixel anchors only when direct matches prove that the
 * independently observed media clock has a stable relationship with encoded
 * PTS. The tolerance is derived from the smallest observed clock spacing; no
 * configured FPS, nominal frame duration, or fixed correction enters here.
 */
function clockAnchorsWithMeasuredMediaTime(
  directMatches: readonly PixelMatch[],
  presentedSamples: readonly ReplayPixelClockPresentedSample[],
): readonly ReplayPixelClockAnchor[] | undefined {
  const directInPresentationOrder = [...directMatches].sort(
    (left, right) => left.presentedAtMs - right.presentedAtMs,
  )
  const directPts = directInPresentationOrder.map((match) => match.ptsMs)
  const directPresented = directInPresentationOrder.map(
    (match) => match.presentedAtMs,
  )
  if (
    !strictlyIncreasing(directPts)
    || !strictlyIncreasing(directPresented)
  ) {
    return undefined
  }

  const directAnchors = directInPresentationOrder.map((match) => ({
    ptsMs: match.ptsMs,
    presentedAtMs: match.presentedAtMs,
    ...(presentedSamples[match.presentedIndex]?.capturedAtMs === undefined
      ? {}
      : {
          capturedAtMs:
            presentedSamples[match.presentedIndex]!.capturedAtMs,
        }),
    ...(presentedSamples[match.presentedIndex]?.mediaTimeMs === undefined
      ? {}
      : {
          mediaTimeMs:
            presentedSamples[match.presentedIndex]!.mediaTimeMs,
        }),
  }))
  const proof = directInPresentationOrder.flatMap((match) => {
    const mediaTimeMs = presentedSamples[match.presentedIndex]?.mediaTimeMs
    return mediaTimeMs === undefined
      ? []
      : [{ match, mediaTimeMs }]
  })
  if (proof.length < MINIMUM_MEDIA_CLOCK_MATCHES) return directAnchors

  const proofPts = proof.map(({ match }) => match.ptsMs)
  const proofMediaTimes = proof.map(({ mediaTimeMs }) => mediaTimeMs)
  if (
    !strictlyIncreasing(proofPts)
    || !strictlyIncreasing(proofMediaTimes)
  ) {
    return directAnchors
  }

  const mediaObservations = presentedSamples
    .map((sample, presentedIndex) => ({
      presentedIndex,
      presentedAtMs: sample.presentedAtMs,
      mediaTimeMs: sample.mediaTimeMs,
    }))
    .filter(
      (
        sample,
      ): sample is {
        presentedIndex: number
        presentedAtMs: number
        mediaTimeMs: number
      } => sample.mediaTimeMs !== undefined,
    )
    .sort((left, right) => left.presentedAtMs - right.presentedAtMs)
  const allMediaTimes = mediaObservations.map((sample) => sample.mediaTimeMs)
  if (!strictlyIncreasing(allMediaTimes)) return directAnchors

  const observedSpacings = [
    minimumSpacing(proofPts),
    minimumSpacing(proofMediaTimes),
    minimumSpacing(allMediaTimes),
  ].filter((spacing): spacing is number => spacing !== undefined)
  if (observedSpacings.length === 0) return directAnchors
  const maximumRelationSpread =
    Math.min(...observedSpacings)
    * MAXIMUM_MEDIA_RELATION_SPREAD_FRACTION
  const offsets = proof.map(
    ({ match, mediaTimeMs }) => match.ptsMs - mediaTimeMs,
  )
  const minimumOffset = Math.min(...offsets)
  const maximumOffset = Math.max(...offsets)
  if (
    !Number.isFinite(maximumRelationSpread)
    || !(maximumRelationSpread > 0)
    || maximumOffset - minimumOffset > maximumRelationSpread
  ) {
    return directAnchors
  }
  const observedOffset = observedMedoid(offsets)
  if (observedOffset === undefined || !Number.isFinite(observedOffset)) {
    return directAnchors
  }

  const directByPresentedIndex = new Map(
    directInPresentationOrder.map((match) => [match.presentedIndex, match]),
  )
  const extended = presentedSamples
    .flatMap((sample, presentedIndex) => {
      const direct = directByPresentedIndex.get(presentedIndex)
      if (direct !== undefined) {
        return [{
          ptsMs: direct.ptsMs,
          presentedAtMs: direct.presentedAtMs,
          ...(sample.capturedAtMs === undefined
            ? {}
            : { capturedAtMs: sample.capturedAtMs }),
          ...(sample.mediaTimeMs === undefined
            ? {}
            : { mediaTimeMs: sample.mediaTimeMs }),
        }]
      }
      if (sample.mediaTimeMs === undefined) return []
      return [{
        ptsMs: sample.mediaTimeMs + observedOffset,
        presentedAtMs: sample.presentedAtMs,
        ...(sample.capturedAtMs === undefined
          ? {}
          : { capturedAtMs: sample.capturedAtMs }),
        mediaTimeMs: sample.mediaTimeMs,
      }]
    })
    .sort((left, right) => left.presentedAtMs - right.presentedAtMs)
  if (
    extended.length < directAnchors.length
    || !strictlyIncreasing(extended.map((anchor) => anchor.ptsMs))
    || !strictlyIncreasing(
      extended.map((anchor) => anchor.presentedAtMs),
    )
  ) {
    return directAnchors
  }
  return extended
}

/**
 * Joins encoded PTS to desktop-pixel exposure through one exact DXGI↔rVFC
 * media-clock calibration. Presentation delay is deliberately not subtracted:
 * it may change while the replay is running.
 *
 * A different/restarted media sink normally resets `mediaTime`. Such a stale
 * calibration makes the derived source more than one second older than (or
 * newer than) its own presentation callback and is rejected wholesale.
 */
export function sourceClockAnchorsFromMeasuredMediaTime(
  anchors: readonly ReplayPixelClockAnchor[],
  sourceMediaTimeOriginMs: number,
): readonly ReplaySourceClockAnchor[] | undefined {
  if (!Number.isFinite(sourceMediaTimeOriginMs)) return undefined
  const measured = anchors
    .filter(
      (
        anchor,
      ): anchor is ReplayPixelClockAnchor & { readonly mediaTimeMs: number } =>
        typeof anchor.mediaTimeMs === 'number'
        && Number.isFinite(anchor.mediaTimeMs),
    )
    .sort((left, right) => left.ptsMs - right.ptsMs)
  if (measured.length < MINIMUM_MEDIA_CLOCK_MATCHES) return undefined
  const pts = measured.map((anchor) => anchor.ptsMs)
  const media = measured.map((anchor) => anchor.mediaTimeMs)
  const presented = measured.map((anchor) => anchor.presentedAtMs)
  if (
    !strictlyIncreasing(pts)
    || !strictlyIncreasing(media)
    || !strictlyIncreasing(presented)
  ) {
    return undefined
  }
  // Each remaining anchor is either an exact decoded-pixel match or an
  // extension already admitted by clockAnchorsWithMeasuredMediaTime's strict
  // mediaTime↔PTS proof. Reapplying that proof to every adjacent callback
  // rejects normal MP4 timestamp quantisation (about half a frame over a long
  // window) even though the source wall value itself was directly observed.
  // Epoch resets are still rejected below by monotonicity and bounded source
  // age; no fixed latency or object-state interpolation is introduced here.
  const source = measured.map((anchor) => ({
    ptsMs: anchor.ptsMs,
    wallMs: sourceMediaTimeOriginMs + anchor.mediaTimeMs,
  }))
  if (!strictlyIncreasing(source.map((anchor) => anchor.wallMs))) {
    return undefined
  }
  for (let index = 0; index < measured.length; index += 1) {
    const anchor = measured[index]
    const sourceAnchor = source[index]
    if (anchor === undefined || sourceAnchor === undefined) return undefined
    const ageMs = anchor.presentedAtMs - sourceAnchor.wallMs
    if (
      !Number.isFinite(ageMs)
      || ageMs < 0
      || ageMs > MAXIMUM_SOURCE_PRESENTATION_AGE_MS
    ) {
      return undefined
    }
  }
  return source
}

/**
 * Prefer the source timestamp carried by the captured frame itself.
 *
 * Unlike a startup pixel calibration this remains available for every
 * getDisplayMedia callback and cannot become ambiguous because a calibration
 * raster happened to repeat. It is still accepted only as same-frame observed
 * evidence: monotonic, no later than presentation, and at most one second old.
 */
export function sourceClockAnchorsFromObservedCaptureTime(
  anchors: readonly ReplayPixelClockAnchor[],
): readonly ReplaySourceClockAnchor[] | undefined {
  const measured = anchors
    .filter(
      (
        anchor,
      ): anchor is ReplayPixelClockAnchor & { readonly capturedAtMs: number } =>
        typeof anchor.capturedAtMs === 'number'
        && Number.isFinite(anchor.capturedAtMs),
    )
    .sort((left, right) => left.ptsMs - right.ptsMs)
  if (measured.length < MINIMUM_MEDIA_CLOCK_MATCHES) return undefined
  if (
    !strictlyIncreasing(measured.map((anchor) => anchor.ptsMs))
    || !strictlyIncreasing(measured.map((anchor) => anchor.presentedAtMs))
    || !strictlyIncreasing(measured.map((anchor) => anchor.capturedAtMs))
  ) {
    return undefined
  }
  const source = measured.map((anchor) => ({
    ptsMs: anchor.ptsMs,
    wallMs: anchor.capturedAtMs,
  }))
  for (const anchor of measured) {
    const ageMs = anchor.presentedAtMs - anchor.capturedAtMs
    if (
      !Number.isFinite(ageMs)
      || ageMs < 0
      || ageMs > MAXIMUM_SOURCE_PRESENTATION_AGE_MS
    ) {
      return undefined
    }
  }
  return source
}

function decision(
  status: ReplayPixelClockDecision['status'],
  reason: ReplayPixelClockReason,
  presentedSampleCount: number,
  decodedSampleCount: number,
  matchCount = 0,
  extra: Omit<
    Partial<ReplayPixelClockDecision>,
    | 'status'
    | 'reason'
    | 'presentedSampleCount'
    | 'decodedSampleCount'
    | 'matchCount'
  > = {},
): ReplayPixelClockDecision {
  return {
    status,
    reason,
    presentedSampleCount,
    decodedSampleCount,
    matchCount,
    ...extra,
  }
}

function validFingerprint(
  fingerprint: ReplayPixelClockFingerprint,
): boolean {
  return (
    fingerprint.kind === 'source-latency-rgb-v1'
    && Number.isSafeInteger(fingerprint.width)
    && Number.isSafeInteger(fingerprint.height)
    && fingerprint.width > 0
    && fingerprint.height > 0
    && fingerprint.width <= 128
    && fingerprint.height <= 72
    && Number.isFinite(fingerprint.meanLuma)
    && Number.isFinite(fingerprint.darkRatio)
    && fingerprint.rgb instanceof Uint8Array
    && fingerprint.cells === fingerprint.rgb
    && fingerprint.rgb.byteLength
      === fingerprint.width * fingerprint.height * 3
    && fingerprint.rgb.byteLength <= REPLAY_PIXEL_CLOCK_MAX_FINGERPRINT_BYTES
  )
}

function fingerprintDelta(
  left: ReplayPixelClockFingerprint,
  right: ReplayPixelClockFingerprint,
): number {
  if (
    left.width !== right.width
    || left.height !== right.height
    || left.rgb.length !== right.rgb.length
  ) {
    return Number.POSITIVE_INFINITY
  }
  let squared = 0
  for (let index = 0; index < left.rgb.length; index += 1) {
    const difference = (left.rgb[index] ?? 0) - (right.rgb[index] ?? 0)
    squared += difference * difference
  }
  return Math.sqrt(squared / left.rgb.length)
}

function motionTransitions(
  fingerprints: readonly ReplayPixelClockFingerprint[],
): number {
  let transitions = 0
  for (let index = 1; index < fingerprints.length; index += 1) {
    const previous = fingerprints[index - 1]
    const current = fingerprints[index]
    if (
      previous !== undefined
      && current !== undefined
      && fingerprintDelta(previous, current) >= MINIMUM_MOTION_DELTA
    ) {
      transitions += 1
    }
  }
  return transitions
}

function observedMedoid(values: readonly number[]): number | undefined {
  let winner: number | undefined
  let winnerDistance = Number.POSITIVE_INFINITY
  for (const candidate of values) {
    const distance = values.reduce(
      (sum, value) => sum + Math.abs(value - candidate),
      0,
    )
    if (distance < winnerDistance) {
      winner = candidate
      winnerDistance = distance
    }
  }
  return winner
}

function clusters(
  matches: readonly PixelMatch[],
): PixelMatch[][] {
  const sorted = [...matches].sort((left, right) =>
    left.originMs - right.originMs
  )
  const result: PixelMatch[][] = []
  for (let start = 0; start < sorted.length; start += 1) {
    const first = sorted[start]
    if (first === undefined) continue
    const cluster: PixelMatch[] = []
    for (let end = start; end < sorted.length; end += 1) {
      const candidate = sorted[end]
      if (
        candidate === undefined
        || candidate.originMs - first.originMs
          > ORIGIN_CLUSTER_TOLERANCE_MS
      ) {
        break
      }
      cluster.push(candidate)
    }
    result.push(cluster)
  }
  return result.sort((left, right) => right.length - left.length)
}

/**
 * Measures the replay's wall-comparable origin from decoded output pixels:
 *
 *   origin = observed presentation time of matching pixels - encoded PTS
 *
 * Every measured origin is one observed subtraction. The decision does not
 * infer a frame rate, insert an offset, interpolate timestamps, or accept a
 * separate pipeline-latency estimate.
 */
export function decideReplayPixelClock(
  presentedSamples: readonly ReplayPixelClockPresentedSample[],
  decodedSamples: readonly ReplayPixelClockDecodedSample[],
): ReplayPixelClockDecision {
  const presentedSampleCount = presentedSamples.length
  const decodedSampleCount = decodedSamples.length
  if (
    presentedSampleCount > REPLAY_PIXEL_CLOCK_SAMPLE_LIMIT
    || decodedSampleCount > REPLAY_PIXEL_CLOCK_SAMPLE_LIMIT
  ) {
    return decision(
      'unavailable',
      'sample-limit-exceeded',
      presentedSampleCount,
      decodedSampleCount,
    )
  }
  if (
    presentedSamples.some(
      (sample) =>
        !Number.isFinite(sample.presentedAtMs)
        || (
          sample.mediaTimeMs !== undefined
          && !Number.isFinite(sample.mediaTimeMs)
        )
        || (
          sample.capturedAtMs !== undefined
          && !Number.isFinite(sample.capturedAtMs)
        )
        || !validFingerprint(sample.fingerprint),
    )
    || decodedSamples.some(
      (sample) =>
        !Number.isFinite(sample.ptsMs)
        || !validFingerprint(sample.fingerprint),
    )
  ) {
    return decision(
      'unavailable',
      'invalid-sample',
      presentedSampleCount,
      decodedSampleCount,
    )
  }
  if (
    presentedSampleCount < MINIMUM_SAMPLES
    || decodedSampleCount < MINIMUM_SAMPLES
  ) {
    return decision(
      'ambiguous',
      'insufficient-samples',
      presentedSampleCount,
      decodedSampleCount,
    )
  }

  const orderedPresented = [...presentedSamples].sort(
    (left, right) => left.presentedAtMs - right.presentedAtMs,
  )
  const orderedDecoded = [...decodedSamples].sort(
    (left, right) => left.ptsMs - right.ptsMs,
  )
  if (
    motionTransitions(
      orderedPresented.map((sample) => sample.fingerprint),
    ) < MINIMUM_MOTION_TRANSITIONS
    || motionTransitions(
      orderedDecoded.map((sample) => sample.fingerprint),
    ) < MINIMUM_MOTION_TRANSITIONS
  ) {
    return decision(
      'ambiguous',
      'static-content',
      presentedSampleCount,
      decodedSampleCount,
    )
  }

  const matches: PixelMatch[] = []
  let multipleMatchCount = 0
  let weakMatchCount = 0
  for (let decodedIndex = 0; decodedIndex < decodedSamples.length; decodedIndex += 1) {
    const decoded = decodedSamples[decodedIndex]
    if (decoded === undefined) continue
    const distances = presentedSamples
      .map((presented, presentedIndex) => ({
        presentedIndex,
        delta: fingerprintDelta(
          presented.fingerprint,
          decoded.fingerprint,
        ),
      }))
      .sort((left, right) => left.delta - right.delta)
    const best = distances[0]
    const second = distances[1]
    if (
      best === undefined
      || !Number.isFinite(best.delta)
      || best.delta > MAXIMUM_MATCH_DELTA
    ) {
      continue
    }
    if (
      second !== undefined
      && Math.abs(second.delta - best.delta) <= MULTIPLE_MATCH_EPSILON
    ) {
      multipleMatchCount += 1
      continue
    }
    const contrast =
      second === undefined
        ? Number.POSITIVE_INFINITY
        : second.delta - best.delta
    if (contrast < MINIMUM_MATCH_CONTRAST) {
      weakMatchCount += 1
      continue
    }
    const presented = presentedSamples[best.presentedIndex]
    if (presented === undefined) continue
    matches.push({
      presentedIndex: best.presentedIndex,
      decodedIndex,
      presentedAtMs: presented.presentedAtMs,
      ptsMs: decoded.ptsMs,
      originMs: presented.presentedAtMs - decoded.ptsMs,
      delta: best.delta,
      contrast,
    })
  }

  // Neighbouring encoded frames can be visually similar enough to choose the
  // same sparse live observation. A clock anchor is one-to-one: retain only
  // the strongest decoded match for each observed frame.
  const strongestByPresented = new Map<number, PixelMatch>()
  for (const match of [...matches].sort((left, right) => left.delta - right.delta)) {
    if (!strongestByPresented.has(match.presentedIndex)) {
      strongestByPresented.set(match.presentedIndex, match)
    }
  }
  matches.length = 0
  matches.push(
    ...[...strongestByPresented.values()].sort(
      (left, right) => left.ptsMs - right.ptsMs,
    ),
  )

  if (matches.length < MINIMUM_SAMPLES) {
    const reason: ReplayPixelClockReason =
      multipleMatchCount > 0
        ? 'multiple-pixel-matches'
        : weakMatchCount > 0
          ? 'weak-pixel-match'
          : 'no-pixel-match'
    return decision(
      'ambiguous',
      reason,
      presentedSampleCount,
      decodedSampleCount,
      matches.length,
    )
  }

  const originClusters = clusters(matches)
  const winner = originClusters[0] ?? []
  const runnerUp = originClusters.find((cluster) =>
    cluster.length >= MINIMUM_SAMPLES
    && cluster.every((candidate) => !winner.includes(candidate))
  )
  const mappedAnchors =
    clockAnchorsWithMeasuredMediaTime(matches, presentedSamples) ?? []
  const mappedAnchorsMonotonic = mappedAnchors.every(
    (anchor, index) =>
      index === 0
      || (
        anchor.ptsMs > mappedAnchors[index - 1]!.ptsMs
        && anchor.presentedAtMs > mappedAnchors[index - 1]!.presentedAtMs
      ),
  )
  const mappedTransitions = motionTransitions(
    matches.flatMap((match) => {
      const sample = presentedSamples[match.presentedIndex]
      return sample === undefined ? [] : [sample.fingerprint]
    }),
  )
  const mappedDecision = (): ReplayPixelClockDecision | null => {
    if (
      mappedAnchors.length < MINIMUM_SAMPLES
      || !mappedAnchorsMonotonic
      || mappedTransitions < MINIMUM_MOTION_TRANSITIONS
    ) {
      return null
    }
    const origins = matches.map((match) => match.originMs)
    return decision(
      'measured',
      'measured',
      presentedSampleCount,
      decodedSampleCount,
      matches.length,
      {
        originSpreadMs: Math.max(...origins) - Math.min(...origins),
        motionTransitions: mappedTransitions,
        bestDelta: Math.min(...matches.map((match) => match.delta)),
        minimumContrast: Math.min(
          ...matches.map((match) => match.contrast),
        ),
        candidateOriginsMs: origins.slice(0, RETAINED_ORIGIN_LIMIT),
        clockAnchors: mappedAnchors,
      },
    )
  }
  if (runnerUp !== undefined && runnerUp.length === winner.length) {
    const mapped = mappedDecision()
    if (mapped !== null) return mapped
    return decision(
      'ambiguous',
      'competing-origin-clusters',
      presentedSampleCount,
      decodedSampleCount,
      winner.length,
      {
        bestDelta: Math.min(...matches.map((match) => match.delta)),
        minimumContrast: Math.min(
          ...matches.map((match) => match.contrast),
        ),
        candidateOriginsMs: matches
          .slice(0, RETAINED_ORIGIN_LIMIT)
          .map((match) => match.originMs),
      },
    )
  }
  if (
    winner.length < MINIMUM_SAMPLES
    || winner.length < Math.ceil(matches.length * MINIMUM_CLUSTER_FRACTION)
  ) {
    const mapped = mappedDecision()
    if (mapped !== null) return mapped
    return decision(
      'ambiguous',
      'incoherent-origin-cluster',
      presentedSampleCount,
      decodedSampleCount,
      winner.length,
      {
        bestDelta: Math.min(...matches.map((match) => match.delta)),
        minimumContrast: Math.min(
          ...matches.map((match) => match.contrast),
        ),
        candidateOriginsMs: matches
          .slice(0, RETAINED_ORIGIN_LIMIT)
          .map((match) => match.originMs),
      },
    )
  }

  const winnerInPresentationOrder = [...winner].sort((left, right) => {
    const leftSample = presentedSamples[left.presentedIndex]
    const rightSample = presentedSamples[right.presentedIndex]
    return (
      (leftSample?.presentedAtMs ?? 0)
      - (rightSample?.presentedAtMs ?? 0)
    )
  })
  const winnerTransitions = motionTransitions(
    winnerInPresentationOrder.flatMap((match) => {
      const sample = presentedSamples[match.presentedIndex]
      return sample === undefined ? [] : [sample.fingerprint]
    }),
  )
  if (winnerTransitions < MINIMUM_MOTION_TRANSITIONS) {
    return decision(
      'ambiguous',
      'static-content',
      presentedSampleCount,
      decodedSampleCount,
      winner.length,
      { motionTransitions: winnerTransitions },
    )
  }

  const origins = winner.map((match) => match.originMs)
  const originMs = observedMedoid(origins)
  if (originMs === undefined || !Number.isFinite(originMs)) {
    return decision(
      'unavailable',
      'invalid-sample',
      presentedSampleCount,
      decodedSampleCount,
      winner.length,
    )
  }
  const minimumOrigin = Math.min(...origins)
  const maximumOrigin = Math.max(...origins)
  const winnerClockAnchors = clockAnchorsWithMeasuredMediaTime(
    winner,
    presentedSamples,
  )
  if (winnerClockAnchors === undefined) {
    return decision(
      'ambiguous',
      'incoherent-origin-cluster',
      presentedSampleCount,
      decodedSampleCount,
      winner.length,
      {
        candidateOriginsMs: origins.slice(0, RETAINED_ORIGIN_LIMIT),
      },
    )
  }
  return decision(
    'measured',
    'measured',
    presentedSampleCount,
    decodedSampleCount,
    winner.length,
    {
      originMs,
      originSpreadMs: maximumOrigin - minimumOrigin,
      motionTransitions: winnerTransitions,
      bestDelta: Math.min(...winner.map((match) => match.delta)),
      minimumContrast: Math.min(
        ...winner.map((match) => match.contrast),
      ),
      candidateOriginsMs: origins.slice(0, RETAINED_ORIGIN_LIMIT),
      clockAnchors: winnerClockAnchors,
    },
  )
}
