// Running an After Save Action pipeline (#68).
//
// The walk lives here, apart from the contract in actions.ts and apart from
// everything that touches Electron, the filesystem or the network. What an
// action DOES is injected; what the pipeline does with success, failure,
// timeouts, retries, ordering and idempotency is this file, and is therefore
// something the gate can drive exhaustively with no pack and no clock.
//
// The invariant every branch below serves: THE SAVE IS ALREADY DONE. Nothing
// here may throw into the caller, and no outcome — including an action that
// hangs, throws a non-Error, or resolves to nonsense — may be reported as
// anything other than that action's own failure.

import {
  type ActionConfig,
  type ActionResult,
  type PackState,
  type PipelineStep,
  decideStep,
  haltsPipeline,
  idempotencyKey,
  pipelineOrder,
  totalAttempts,
} from './actions'

/**
 * What one attempt of one action does. Resolves on success; rejects or throws
 * on failure. The pipeline never inspects the resolved value.
 */
export type ActionExecutor = (step: PipelineStep, attempt: number) => Promise<void>

export interface PipelineClock {
  /** Monotonic-ish milliseconds. Injected so durations are testable. */
  now: () => number
  /** Resolves after ms. Injected so retry backoff costs a test nothing. */
  delay: (ms: number) => Promise<void>
}

export interface RunPipelineInput {
  packId: string
  packState: PackState
  steps: readonly PipelineStep[]
  /** Idempotency keys already completed for this pack, from the ledger. */
  completedKeys: ReadonlySet<string>
  execute: ActionExecutor
  clock: PipelineClock
  /** Backoff before retry N (1-based). Defaults to a flat 1 s. */
  retryDelayMs?: (attempt: number) => number
}

export interface PipelineRun {
  results: readonly ActionResult[]
  /** Keys to add to the ledger — successful runs of idempotent actions only. */
  newCompletedKeys: readonly string[]
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  if (typeof error === 'string' && error !== '') return error
  // A thrown object with no usable message is still a failure the user has to
  // be able to read. Naming the type beats printing "[object Object]".
  return `the action failed without a message (${typeof error})`
}

/** A rejection that means the attempt ran out of time rather than failed. */
class TimeoutError extends Error {}

async function attemptOnce(
  step: PipelineStep,
  attempt: number,
  execute: ActionExecutor,
  clock: PipelineClock,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(`timed out after ${step.config.timeoutMs} ms`))
    }, step.config.timeoutMs)
  })
  try {
    // Promise.race, not an abort: an action that ignores cancellation must not
    // be able to hold the pipeline open, and the host cannot make a third-party
    // action stop. The attempt is abandoned, its result discarded, and the
    // pipeline moves on — which is exactly what "timeouts are budgets, not
    // suggestions" means when the other side may not cooperate.
    await Promise.race([execute(step, attempt), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  void clock
}

/**
 * Run one pipeline to completion.
 *
 * Never rejects. Every step produces exactly one result, in pipeline order, so
 * the save screen can render a row per configured action whatever happened.
 */
export async function runPipeline(input: RunPipelineInput): Promise<PipelineRun> {
  const { packId, packState, completedKeys, execute, clock } = input
  const retryDelayMs = input.retryDelayMs ?? (() => 1_000)
  const ordered = pipelineOrder(input.steps)

  const results: ActionResult[] = []
  const newCompletedKeys: string[] = []
  let halted = false

  for (const step of ordered) {
    const decision = decideStep({
      step,
      packState,
      completedKeys,
      packId,
      pipelineHalted: halted,
    })

    if (!decision.run) {
      const result: ActionResult = {
        actionId: step.manifest.id,
        configId: step.config.configId,
        outcome: decision.outcome,
        attempts: 0,
        durationMs: 0,
        message: decision.message,
        // A BLOCKED step is the one non-run worth offering a retry for: the
        // pack state it wants may arrive a second later. Disabled and
        // already-completed are answers, not failures.
        retryable: decision.outcome === 'blocked',
      }
      results.push(result)
      if (haltsPipeline(result, step.config)) halted = true
      continue
    }

    const startedAt = clock.now()
    const attempts = totalAttempts(step.config)
    let lastError: unknown = null
    let attemptsMade = 0
    let succeeded = false

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      attemptsMade = attempt
      try {
        await attemptOnce(step, attempt, execute, clock)
        succeeded = true
        break
      } catch (error) {
        lastError = error
        if (attempt < attempts) await clock.delay(retryDelayMs(attempt))
      }
    }

    const durationMs = Math.max(0, clock.now() - startedAt)

    if (succeeded) {
      results.push({
        actionId: step.manifest.id,
        configId: step.config.configId,
        outcome: 'ok',
        attempts: attemptsMade,
        durationMs,
        retryable: false,
      })
      if (step.manifest.idempotent) {
        newCompletedKeys.push(idempotencyKey(packId, step.manifest.id, step.config.configId))
      }
      continue
    }

    const result: ActionResult = {
      actionId: step.manifest.id,
      configId: step.config.configId,
      outcome: lastError instanceof TimeoutError ? 'timed-out' : 'failed',
      attempts: attemptsMade,
      durationMs,
      message: messageOf(lastError),
      // Every genuine failure is retryable on its own. The pack is saved; the
      // user pressing Retry is the whole point of showing the row.
      retryable: true,
    }
    results.push(result)
    if (haltsPipeline(result, step.config)) halted = true
  }

  return { results, newCompletedKeys }
}

/**
 * Whether a configuration is worth showing a Retry button for right now.
 *
 * Separate from the result so the save screen and History ask the same
 * question, and so a config the user has since disabled stops offering one.
 */
export function canRetry(result: ActionResult, config: ActionConfig | undefined): boolean {
  if (config === undefined || !config.enabled) return false
  return result.retryable
}
