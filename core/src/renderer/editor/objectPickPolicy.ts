import type { TemporalCoverage } from '../../shared/context/protocol'
import type { Annotation, AnnotationTarget } from '../../shared/types'
import {
  pickIdentityOf,
  samePickIdentity,
  type PickIdentity,
  type PickLevel,
  type PickableObject,
} from './objects'

const PICK_REFINE_RATIO = 2

export interface AdjacentObservedPick {
  /** Frame-level coverage of the adjacent context query. */
  readonly coverage: TemporalCoverage
  /** Semantic objects whose observed rectangles contain the clicked point. */
  readonly pointPicks: readonly PickableObject[]
}

export interface BoundedObservedPickInput {
  /** The displayed replay-frame time, on the pack clock. */
  readonly requestedTimeMs: number
  /** Measured/configured video cadence; the policy stores no correction. */
  readonly frameIntervalMs: number
  /** The exact displayed-frame point result, if it already found a control. */
  readonly exactPointPick: PickableObject | null
  /**
   * Controls present in the exact ContextFrame.
   *
   * Their identities prove lifetime at the displayed instant. Adjacent
   * geometry alone cannot: it might belong to an object just created or already
   * destroyed at the frame the user is looking at.
   */
  readonly exactControls: readonly PickableObject[]
  readonly observations: readonly AdjacentObservedPick[]
}

export interface BoundedObservedPickResult {
  readonly picked: PickableObject
  /** Actual materialized observation time retained as picked_at_ms provenance. */
  readonly observedAtMs: number
}

function identityKey(picked: PickableObject): string {
  const identity = pickIdentityOf(picked)
  return [
    identity.providerId,
    identity.surfaceId,
    identity.objectId,
    identity.level,
  ].join('\u0000')
}

function directlyObservedControl(
  picked: PickableObject,
): picked is PickableObject {
  return (
    picked.level === 'control' &&
    picked.candidate.accuracy.coverage === 'covered' &&
    picked.candidate.accuracy.interpolated !== true
  )
}

/**
 * Safe bridge for an ambiguous video↔context start clock.
 *
 * The exact displayed-frame ObjectIndex remains authoritative. Only when it
 * has no semantic point hit may an adjacent *observed* sample supply geometry,
 * and only for an identity the exact frame proves is still alive. The search
 * window is derived from the video's frame interval and capped at two frames;
 * no fixed latency correction is inferred or persisted.
 */
export function boundedObservedPickFallback(
  input: BoundedObservedPickInput,
): BoundedObservedPickResult | null {
  if (input.exactPointPick?.level === 'control') return null
  if (
    !Number.isFinite(input.requestedTimeMs) ||
    !Number.isFinite(input.frameIntervalMs) ||
    input.frameIntervalMs <= 0 ||
    input.observations.length === 0
  ) {
    return null
  }
  // A missing adjacent answer is represented by non-covered frame accuracy.
  // Borrowing through that hole would turn absence of evidence into geometry.
  if (input.observations.some((sample) => sample.coverage !== 'covered')) {
    return null
  }

  const limitMs = input.frameIntervalMs * 2
  const alive = new Set<string>()
  for (const control of input.exactControls) {
    if (!directlyObservedControl(control)) continue
    const observedAt = control.candidate.accuracy.materializedTimeMs
    if (
      !Number.isFinite(observedAt) ||
      Math.abs(observedAt - input.requestedTimeMs) > limitMs
    ) {
      continue
    }
    alive.add(identityKey(control))
  }
  if (alive.size === 0) return null

  const hits: Array<{
    picked: PickableObject
    observedAtMs: number
    identity: string
  }> = []
  for (const sample of input.observations) {
    for (const picked of sample.pointPicks) {
      // A point answer that is estimated or not covered makes this adjacent
      // frame unusable. The policy never quietly promotes it to observation.
      if (!directlyObservedControl(picked)) return null
      const observedAtMs = picked.candidate.accuracy.materializedTimeMs
      if (
        !Number.isFinite(observedAtMs) ||
        Math.abs(observedAtMs - input.requestedTimeMs) > limitMs
      ) {
        continue
      }
      hits.push({
        picked,
        observedAtMs,
        identity: identityKey(picked),
      })
    }
  }
  if (hits.length === 0) return null

  // Even a perfect candidate is unsafe when another observed semantic object
  // also owns that pixel in the bounded neighborhood.
  const identities = new Set(hits.map((hit) => hit.identity))
  if (identities.size !== 1) return null
  const identity = hits[0]?.identity
  if (identity === undefined || !alive.has(identity)) return null

  hits.sort(
    (a, b) =>
      Math.abs(a.observedAtMs - input.requestedTimeMs) -
        Math.abs(b.observedAtMs - input.requestedTimeMs) ||
      a.observedAtMs - b.observedAtMs,
  )
  const winner = hits[0]
  return winner === undefined
    ? null
    : { picked: winner.picked, observedAtMs: winner.observedAtMs }
}

/**
 * Pure inputs for the box-vs-object click arbitration in editor.ts.
 *
 * DOM hit testing and edge detection stay in the editor; this object contains
 * only the facts that decide which already-hit thing owns the click.
 */
export interface PickBoxPolicyInput {
  readonly selectedManualBox: boolean
  readonly repeat: boolean
  readonly onEdge: boolean
  readonly alreadyAnnotatesPick: boolean
  readonly boxTargetLevel?: PickLevel
  readonly pickedLevel: PickLevel
  readonly pickedArea: number
  readonly boxArea: number
}

export function pickBeatsBoxPolicy(input: PickBoxPolicyInput): boolean {
  if (input.selectedManualBox) return false
  if (input.repeat) return false
  if (input.onEdge) return false
  if (input.alreadyAnnotatesPick) return false
  // A semantic window is the guaranteed coarse floor of object picking. Any
  // control inside it is a refinement by LEVEL, even when a Document/List/
  // Contents surface fills nearly the whole client area. Applying the generic
  // 50%-area gate here made the selected app box swallow exactly those useful
  // large children.
  if (input.boxTargetLevel === 'window' && input.pickedLevel === 'control') {
    return true
  }
  return input.pickedArea * PICK_REFINE_RATIO <= Math.max(1, input.boxArea)
}

function targetString(
  target: AnnotationTarget,
  key: string,
): string | undefined {
  const value = target[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function identityString(picked: PickableObject, key: string): string | undefined {
  const value = picked.candidate.identity?.[key]
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined
}

function targetFieldMatches(
  target: AnnotationTarget,
  picked: PickableObject,
  key: string,
): boolean {
  const stored = targetString(target, key)
  return stored === undefined || identityString(picked, key) === stored.trim()
}

/**
 * A stored target can recover an identity after save/reopen only when the
 * target itself contains a strong key. Descriptive labels are never enough.
 */
export function storedTargetDefinitelyMatchesPick(
  target: AnnotationTarget | undefined,
  picked: PickableObject,
): boolean {
  if (target === undefined) return false
  const source = targetString(target, 'source')
  if (source === undefined) return false

  const rawLevel = targetString(target, 'level')
  // SPEC §8.7: UIA targets written before `level` existed were controls.
  const storedLevel =
    source === 'uia' && rawLevel === undefined ? 'control' : rawLevel
  if (storedLevel !== picked.level) return false

  if (source !== 'uia') {
    const objectId = targetString(target, 'object_id')
    return (
      source === picked.providerId &&
      objectId !== undefined &&
      objectId === picked.candidate.objectId
    )
  }

  if (picked.providerId !== 'windows-uia' && picked.providerId !== 'core') {
    return false
  }

  if (picked.level === 'window') {
    // A title alone is descriptive and can repeat. The complete SPEC window
    // tuple is the strongest durable identity currently stored.
    const title = targetString(target, 'title')
    const process = targetString(target, 'process')
    const className = targetString(target, 'class_name')
    return (
      title !== undefined &&
      process !== undefined &&
      className !== undefined &&
      identityString(picked, 'title') === title.trim() &&
      identityString(picked, 'process') === process.trim() &&
      identityString(picked, 'class_name') === className.trim()
    )
  }

  // AutomationId is the only strong control key in SPEC §8.7. Every
  // additional field that was persisted must still agree; this prevents a
  // reused id in another class/process/name from becoming a false duplicate.
  const automationId = targetString(target, 'automation_id')
  return (
    automationId !== undefined &&
    identityString(picked, 'automation_id') === automationId.trim() &&
    ['name', 'control_type', 'class_name', 'process'].every((key) =>
      targetFieldMatches(target, picked, key),
    )
  )
}

function rememberedOrStoredIdentityMatches(
  annotation: Annotation,
  identities: ReadonlyMap<string, PickIdentity>,
  picked: PickableObject,
): boolean {
  const remembered = identities.get(annotation.annotation_id)
  return remembered === undefined
    ? storedTargetDefinitelyMatchesPick(annotation.target, picked)
    : samePickIdentity(remembered, pickIdentityOf(picked))
}

export interface PickRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

function sameRect(rect: PickRect, picked: PickableObject): boolean {
  return (
    Math.abs(rect.x - picked.x) <= 1 &&
    Math.abs(rect.y - picked.y) <= 1 &&
    Math.abs(rect.w - picked.width) <= 1 &&
    Math.abs(rect.h - picked.height) <= 1
  )
}

/**
 * Whether this box already annotates this exact object.
 *
 * Semantic boxes compare identity before geometry. A window and its Document
 * child can share a rectangle without being the same object. Geometry remains
 * the fallback only for manual boxes, which intentionally have no identity.
 */
export function annotationAlreadyAnnotatesPick(
  annotation: Annotation,
  identities: ReadonlyMap<string, PickIdentity>,
  picked: PickableObject,
  snapped?: PickRect,
): boolean {
  if (
    annotation.target !== undefined ||
    identities.has(annotation.annotation_id)
  ) {
    return rememberedOrStoredIdentityMatches(annotation, identities, picked)
  }
  const bounds = annotation.bounds
  if (
    sameRect(
      { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height },
      picked,
    )
  ) {
    return true
  }
  return snapped !== undefined && sameRect(snapped, picked)
}

/**
 * Finds the visible annotation that already names this object.
 *
 * Kept pure so reopen behavior is exercised without booting the Electron DOM.
 */
export function existingAnnotationForPick(
  annotations: readonly Annotation[],
  identities: ReadonlyMap<string, PickIdentity>,
  picked: PickableObject,
  visible: (annotation: Annotation) => boolean,
): Annotation | null {
  for (const annotation of annotations) {
    // A live provider identity is more precise than the persisted SPEC target:
    // if it exists and differs, do not let a reused AutomationId collapse two
    // siblings. Only an actually empty map (the save/reopen case) falls back to
    // durable target fields.
    if (!rememberedOrStoredIdentityMatches(annotation, identities, picked)) continue
    if (!visible(annotation)) continue
    return annotation
  }
  return null
}
