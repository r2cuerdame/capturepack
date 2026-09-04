// The After Save Action contract (#68).
//
// An action consumes a FINISHED pack. It never participates in capture, it
// never writes into Core's files, and it can never cost a save: the folder on
// disk is the original, and actions are what happens afterwards.
//
// GOAL.md > Plugin System, redesigned > Export, failure, and isolation is the
// specification this file implements. Two sentences from it decide most of the
// shapes below:
//
//   "Actions declare the pack state they need, because the annotated replay
//    renders in the background and not every action can run at the same moment."
//
//   "A failed action never invalidates the save."
//
// This module is deliberately dependency-free — no Electron, no node:fs — so the
// gate can hold the contract and the pipeline algorithm without a stub standing
// in for the runtime. See core/src/main/updateNotice.ts for why that matters.

/**
 * How far a saved pack has got. An action declares the state it needs and waits
 * for it, so a metadata-only action runs immediately while one that needs the
 * annotated replay waits for the background render.
 *
 * ORDERED. `PACK_STATE_ORDER` below is the authority; comparisons must go
 * through `packStateAtLeast` rather than comparing strings.
 */
export type PackState =
  | 'captured'
  | 'metadata-ready'
  | 'source-ready'
  | 'annotated-replay-rendering'
  | 'annotated-replay-ready'
  | 'complete'

export const PACK_STATE_ORDER: readonly PackState[] = [
  'captured',
  'metadata-ready',
  'source-ready',
  'annotated-replay-rendering',
  'annotated-replay-ready',
  'complete',
]

/**
 * Whether `state` has reached `required`.
 *
 * `annotated-replay-rendering` is a state the pack passes THROUGH, not one an
 * action should ever wait for: it means the render started, not that anything
 * is readable. It stays in the ladder because a pack genuinely occupies it and
 * the save screen shows it, and an action declaring it gets what it asked for.
 */
export function packStateAtLeast(state: PackState, required: PackState): boolean {
  const reached = PACK_STATE_ORDER.indexOf(state)
  const wanted = PACK_STATE_ORDER.indexOf(required)
  // An unknown state is not "at least" anything. Returning true here would run
  // an action against a pack whose readiness nobody established.
  if (reached < 0 || wanted < 0) return false
  return reached >= wanted
}

/**
 * The fixed permission set from GOAL.md. A manifest may not invent one: an
 * unknown permission is a rejected manifest, not a permission that is quietly
 * ignored, because the user is shown this list before enabling anything and a
 * list that silently drops entries is worse than no list.
 */
export const ACTION_PERMISSIONS = [
  'read-pack',
  'write-plugin-files',
  'network',
  'run-process',
  'read-browser-context',
  'read-active-window',
  'native-messaging',
  'create-zip',
  'open-browser',
] as const

export type ActionPermission = (typeof ACTION_PERMISSIONS)[number]

/**
 * Permissions that mean pack data can leave this machine.
 *
 * GOAL.md: "any action that sends data off the machine says so in those words".
 * The Settings UI reads THIS list rather than deciding for itself, so a new
 * outbound permission cannot be added without the warning following it.
 */
export const OFF_MACHINE_PERMISSIONS: readonly ActionPermission[] = [
  'network',
  'native-messaging',
  'open-browser',
]

export function sendsDataOffMachine(permissions: readonly ActionPermission[]): boolean {
  return permissions.some((permission) => OFF_MACHINE_PERMISSIONS.includes(permission))
}

/** The protocol version this build of Core speaks to After Save Actions. */
export const ACTION_PROTOCOL_VERSION = 1

export interface ActionManifest {
  /** Stable identifier; half of the idempotency key. */
  id: string
  /** Shown in Settings and on the save screen. */
  name: string
  type: 'after-save-action'
  protocolVersion: number
  /** Module or executable the host runs. Free-form to the contract. */
  entry: string
  permissions: readonly ActionPermission[]
  /** Pack state the action needs before it may run. */
  requiredPackState: PackState
  /**
   * Whether running this action twice for one pack could create a duplicate
   * (a second Jira issue, a second webhook delivery). When true the host
   * refuses a second run for the same idempotency key.
   */
  idempotent: boolean
}

/** Default action timeout. GOAL.md: "an After Save Action 30 s by default". */
export const ACTION_TIMEOUT_DEFAULT_MS = 30_000
/** "...and minutes if configured." */
export const ACTION_TIMEOUT_MAX_MS = 10 * 60_000

export interface ActionConfig {
  actionId: string
  /**
   * Identifies THIS configuration of the action. Changing where a webhook posts
   * makes a different configuration, and the previous delivery must not
   * suppress the new one — so it is part of the idempotency key.
   */
  configId: string
  enabled: boolean
  /** Position in the pipeline. Lower runs first; ties break on actionId. */
  order: number
  /** Whether the pipeline continues after this action fails. */
  continueOnFailure: boolean
  timeoutMs: number
  /** Attempts after the first. 0 means one attempt and no retry. */
  retries: number
}

export type ActionOutcome = 'ok' | 'failed' | 'timed-out' | 'skipped' | 'blocked'

export interface ActionResult {
  actionId: string
  configId: string
  outcome: ActionOutcome
  /** Attempts actually made, including the first. */
  attempts: number
  durationMs: number
  /** Present for 'failed', 'timed-out', 'skipped' and 'blocked'. */
  message?: string
  /** True when the user may press Retry for this result. */
  retryable: boolean
}

/**
 * pack id + action id + config id — GOAL.md's idempotency key, verbatim.
 *
 * The pack id is the manifest's UUID rather than the folder name: a pack that
 * is moved or renamed is the same pack, and an action that created an issue for
 * it must not create a second one because the folder was tidied.
 */
export function idempotencyKey(packId: string, actionId: string, configId: string): string {
  return `${packId} ${actionId} ${configId}`
}

export interface PipelineStep {
  manifest: ActionManifest
  config: ActionConfig
}

/**
 * Pipeline order: `order` ascending, ties broken by actionId so the sequence is
 * deterministic. Two actions sharing an order number is a configuration a user
 * can reach by dragging, and a pipeline whose order depends on object key
 * iteration would run differently on the next launch.
 */
export function pipelineOrder(steps: readonly PipelineStep[]): readonly PipelineStep[] {
  return [...steps].sort((left, right) => {
    if (left.config.order !== right.config.order) return left.config.order - right.config.order
    return left.manifest.id < right.manifest.id ? -1 : left.manifest.id > right.manifest.id ? 1 : 0
  })
}

export type StepDecision =
  | { run: true }
  | { run: false; outcome: Exclude<ActionOutcome, 'ok' | 'failed' | 'timed-out'>; message: string }

/**
 * Whether one step may run right now, and why not when it may not.
 *
 * Pure and separate from execution so the gate can drive every combination of
 * enabled / pack state / already-done without a pack, a network or a clock.
 */
export function decideStep(input: {
  step: PipelineStep
  packState: PackState
  /** Idempotency keys already completed for this pack. */
  completedKeys: ReadonlySet<string>
  packId: string
  /** True once an earlier step failed and did not allow the pipeline to continue. */
  pipelineHalted: boolean
}): StepDecision {
  const { step, packState, completedKeys, packId, pipelineHalted } = input
  if (pipelineHalted) {
    return { run: false, outcome: 'skipped', message: 'an earlier action failed and stopped the pipeline' }
  }
  if (!step.config.enabled) {
    return { run: false, outcome: 'skipped', message: 'disabled' }
  }
  if (!packStateAtLeast(packState, step.manifest.requiredPackState)) {
    return {
      run: false,
      outcome: 'blocked',
      message: `waiting for pack state ${step.manifest.requiredPackState} (currently ${packState})`,
    }
  }
  if (
    step.manifest.idempotent
    && completedKeys.has(idempotencyKey(packId, step.manifest.id, step.config.configId))
  ) {
    return { run: false, outcome: 'skipped', message: 'already completed for this pack' }
  }
  return { run: true }
}

/**
 * Whether the pipeline stops after this result.
 *
 * A BLOCKED step never halts the pipeline: it is waiting for a pack state, not
 * failing, and the actions behind it may need nothing it is waiting for.
 */
export function haltsPipeline(result: ActionResult, config: ActionConfig): boolean {
  if (result.outcome === 'ok' || result.outcome === 'skipped' || result.outcome === 'blocked') {
    return false
  }
  return !config.continueOnFailure
}

/**
 * Clamp a configured timeout into the supported range.
 *
 * A zero or negative timeout would make every action time out instantly, and an
 * unbounded one would let a wedged action hold the save screen's result list
 * open forever. Neither is a setting worth honouring.
 */
export function normalizeActionTimeout(ms: number, current = ACTION_TIMEOUT_DEFAULT_MS): number {
  if (!Number.isFinite(ms) || ms <= 0) return current
  return Math.min(ACTION_TIMEOUT_MAX_MS, Math.max(1_000, Math.round(ms)))
}

/** Attempts to make in total for a config: the first, plus its retries. */
export function totalAttempts(config: ActionConfig): number {
  if (!Number.isFinite(config.retries) || config.retries <= 0) return 1
  return 1 + Math.min(5, Math.floor(config.retries))
}
