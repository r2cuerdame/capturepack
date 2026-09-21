// The After Save Action contract and pipeline (#68).
//
// Everything asserted here is production code imported directly. The runner
// supplies an Electron stub only for the host's app path and safeStorage: that
// lets this check exercise the real executor and prove a decryption failure
// cannot reach the network.
//
// The invariant under test throughout: THE PACK IS ALREADY SAVED. An action
// that fails, hangs, or throws something that is not an Error is that action's
// own failure and nothing else's.
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { runActionsForPack } from '../src/main/actions/host'
import { deliverWebhook } from '../src/main/actions/webhook'
import {
  ACTION_PERMISSIONS,
  ACTION_TIMEOUT_DEFAULT_MS,
  ACTION_TIMEOUT_MAX_MS,
  BUILTIN_WEBHOOK_ACTION_ID,
  PACK_STATE_ORDER,
  type ActionConfig,
  type ActionManifest,
  type ActionResult,
  type PackState,
  type PipelineStep,
  decideStep,
  haltsPipeline,
  idempotencyKey,
  isAcceptableWebhookUrl,
  mergeActionResults,
  normalizeActionTimeout,
  packStateAtLeast,
  pipelineOrder,
  sendsDataOffMachine,
  totalAttempts,
} from '../src/shared/actions'
import { runPipeline, canRetry, SaveActionLifecycle, failureResults } from '../src/shared/actionPipeline'

let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (!condition) failed += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

const PACK = 'e3f1c0de-0000-4000-8000-000000000001'

function manifest(over: Partial<ActionManifest> = {}): ActionManifest {
  return {
    id: 'webhook',
    name: 'HTTP webhook',
    type: 'after-save-action',
    protocolVersion: 1,
    entry: 'builtin:webhook',
    permissions: ['read-pack', 'network'],
    requiredPackState: 'source-ready',
    idempotent: true,
    ...over,
  }
}

function config(over: Partial<ActionConfig> = {}): ActionConfig {
  return {
    actionId: 'webhook',
    configId: 'cfg-1',
    enabled: true,
    order: 10,
    continueOnFailure: false,
    timeoutMs: 1_000,
    retries: 0,
    ...over,
  }
}

const step = (m: Partial<ActionManifest> = {}, c: Partial<ActionConfig> = {}): PipelineStep => ({
  manifest: manifest(m),
  config: config({ actionId: m.id ?? 'webhook', ...c }),
})

const fastClock = () => {
  let t = 0
  return {
    now: () => (t += 5),
    delay: async () => {
      t += 1
      await Promise.resolve()
    },
  }
}

console.log('THE PACK STATE LADDER')
check('the ladder is the six states in order', PACK_STATE_ORDER.join(' -> ') === 'captured -> metadata-ready -> source-ready -> annotated-replay-rendering -> annotated-replay-ready -> complete')
check('a later state satisfies an earlier requirement', packStateAtLeast('complete', 'source-ready'))
check('the same state satisfies itself', packStateAtLeast('source-ready', 'source-ready'))
check('an earlier state does not satisfy a later requirement', !packStateAtLeast('metadata-ready', 'annotated-replay-ready'))
check(
  'an UNKNOWN state satisfies nothing — a pack whose readiness nobody established never runs an action',
  !packStateAtLeast('nonsense' as PackState, 'captured'),
)

console.log('\nPERMISSIONS ARE A FIXED SET')
check('nine permissions, exactly the ones GOAL.md names', ACTION_PERMISSIONS.length === 9)
check('network means data can leave the machine', sendsDataOffMachine(['read-pack', 'network']))
check('native messaging does too', sendsDataOffMachine(['native-messaging']))
check('opening a browser does too', sendsDataOffMachine(['open-browser']))
check('reading the pack alone does not', !sendsDataOffMachine(['read-pack', 'create-zip']))
check('NEGATIVE CONTROL: no permissions at all is not "sends data off the machine"', !sendsDataOffMachine([]))

console.log('\nTHE IDEMPOTENCY KEY IS pack + action + config')
check('all three parts appear', idempotencyKey(PACK, 'webhook', 'cfg-1') === `${PACK} webhook cfg-1`)
check(
  'a different CONFIG of the same action is a different key — repointing a webhook must not be suppressed by the old delivery',
  idempotencyKey(PACK, 'webhook', 'cfg-1') !== idempotencyKey(PACK, 'webhook', 'cfg-2'),
)
check(
  'a different PACK is a different key',
  idempotencyKey(PACK, 'webhook', 'cfg-1') !== idempotencyKey('other', 'webhook', 'cfg-1'),
)

console.log('\nPIPELINE ORDER IS DETERMINISTIC')
{
  const ordered = pipelineOrder([
    step({ id: 'c' }, { order: 5 }),
    step({ id: 'a' }, { order: 20 }),
    step({ id: 'b' }, { order: 5 }),
  ])
  check('order ascending, ties broken by action id', ordered.map((s) => s.manifest.id).join(',') === 'b,c,a')
  const again = pipelineOrder([
    step({ id: 'b' }, { order: 5 }),
    step({ id: 'c' }, { order: 5 }),
    step({ id: 'a' }, { order: 20 }),
  ])
  check(
    'the same set in a different input order produces the same pipeline — two actions may share an order number by dragging',
    again.map((s) => s.manifest.id).join(',') === 'b,c,a',
  )
}

console.log('\nWHETHER A STEP MAY RUN')
{
  const base = { packState: 'complete' as PackState, completedKeys: new Set<string>(), packId: PACK, pipelineHalted: false }
  check('an enabled, ready, unrun step runs', decideStep({ ...base, step: step() }).run)
  const disabled = decideStep({ ...base, step: step({}, { enabled: false }) })
  check('a disabled step is SKIPPED', !disabled.run && disabled.outcome === 'skipped')
  const early = decideStep({ ...base, packState: 'captured', step: step({ requiredPackState: 'annotated-replay-ready' }) })
  check(
    'a step whose pack state has not arrived is BLOCKED, and says which state it wants',
    !early.run && early.outcome === 'blocked' && (early.message ?? '').includes('annotated-replay-ready'),
  )
  const done = decideStep({ ...base, completedKeys: new Set([idempotencyKey(PACK, 'webhook', 'cfg-1')]), step: step() })
  check('an idempotent step already completed for this pack is SKIPPED', !done.run && done.outcome === 'skipped')
  const notIdempotent = decideStep({
    ...base,
    completedKeys: new Set([idempotencyKey(PACK, 'webhook', 'cfg-1')]),
    step: step({ idempotent: false }),
  })
  check(
    'NEGATIVE CONTROL: a NON-idempotent action runs again with the same key present — the ledger only suppresses what declared it must not duplicate',
    notIdempotent.run,
  )
  const halted = decideStep({ ...base, pipelineHalted: true, step: step() })
  check('a step behind a halted pipeline is SKIPPED', !halted.run && halted.outcome === 'skipped')
}

console.log('\nWHAT STOPS A PIPELINE')
check(
  'a failure stops it when continue-on-failure is off',
  haltsPipeline({ actionId: 'a', configId: 'c', outcome: 'failed', attempts: 1, durationMs: 1, retryable: true }, config({ continueOnFailure: false })),
)
check(
  'a failure does not stop it when continue-on-failure is on',
  !haltsPipeline({ actionId: 'a', configId: 'c', outcome: 'failed', attempts: 1, durationMs: 1, retryable: true }, config({ continueOnFailure: true })),
)
check(
  'a BLOCKED step never stops the pipeline — it is waiting for a pack state, not failing, and later actions may want nothing it waits for',
  !haltsPipeline({ actionId: 'a', configId: 'c', outcome: 'blocked', attempts: 0, durationMs: 0, retryable: true }, config({ continueOnFailure: false })),
)
check(
  'a SKIPPED step never stops the pipeline',
  !haltsPipeline({ actionId: 'a', configId: 'c', outcome: 'skipped', attempts: 0, durationMs: 0, retryable: false }, config({ continueOnFailure: false })),
)

console.log('\nTIMEOUT AND ATTEMPT LIMITS')
check('the default is 30 s', ACTION_TIMEOUT_DEFAULT_MS === 30_000)
check('zero is refused and the current value kept', normalizeActionTimeout(0, 5_000) === 5_000)
check('a negative is refused', normalizeActionTimeout(-1, 5_000) === 5_000)
check('a non-finite is refused', normalizeActionTimeout(Number.NaN, 5_000) === 5_000)
check('an enormous timeout is clamped to the maximum', normalizeActionTimeout(99 * 60_000) === ACTION_TIMEOUT_MAX_MS)
check('a sub-second timeout is raised to one second', normalizeActionTimeout(5) === 1_000)
check('no retries means one attempt', totalAttempts(config({ retries: 0 })) === 1)
check('two retries means three attempts', totalAttempts(config({ retries: 2 })) === 3)
check('retries are capped', totalAttempts(config({ retries: 99 })) === 6)

// WHICH URLS THE WEBHOOK WILL POST TO (#173).
//
// The rule lives in the contract so Settings can refuse a URL before a save.
// A URL that carries userinfo is refused there too: Node's fetch throws on it,
// and the TypeError it throws quotes the whole URL, credentials included.
console.log('\nWHICH URLS THE WEBHOOK WILL POST TO')
check('https anywhere is accepted', isAcceptableWebhookUrl('https://api.example.com/webhook'))
check('http on loopback is accepted', isAcceptableWebhookUrl('http://localhost:8080/hook') && isAcceptableWebhookUrl('http://127.0.0.1/hook'))
check('http off this machine is refused', !isAcceptableWebhookUrl('http://api.example.com/webhook'))
check('a non-URL is refused', !isAcceptableWebhookUrl('not a url'))
check('a user:password in the URL is refused (#173)', !isAcceptableWebhookUrl('https://user:pass@api.example.com/webhook'))
check('a bare user (token) in the URL is refused (#173)', !isAcceptableWebhookUrl('https://token@api.example.com/webhook'))
check('an empty user with a password is refused (#173)', !isAcceptableWebhookUrl('https://:pass@api.example.com/webhook'))
check('loopback does not excuse credentials (#173)', !isAcceptableWebhookUrl('http://user:pass@localhost:8080/hook'))
check(
  'NEGATIVE CONTROL: an @ in the path or query is not userinfo and is still accepted',
  isAcceptableWebhookUrl('https://api.example.com/hooks/team@example.com?reply=a@b'),
)

console.log('\nRUNNING A PIPELINE')
{
  const run = await runPipeline({
    packId: PACK,
    packState: 'complete',
    steps: [step({ id: 'a' }, { order: 1 }), step({ id: 'b' }, { order: 2 })],
    completedKeys: new Set(),
    execute: async () => {},
    clock: fastClock(),
  })
  check('both steps ran and both are ok', run.results.map((r) => `${r.actionId}:${r.outcome}`).join(',') === 'a:ok,b:ok')
  check('both idempotent successes were recorded for the ledger', run.newCompletedKeys.length === 2)
}
{
  let calls = 0
  const run = await runPipeline({
    packId: PACK,
    packState: 'complete',
    steps: [step({ id: 'a' }, { retries: 2 })],
    completedKeys: new Set(),
    execute: async () => {
      calls += 1
      if (calls < 3) throw new Error('flaky')
    },
    clock: fastClock(),
    retryDelayMs: () => 0,
  })
  check('a flaky action that succeeds on its third attempt is ok, and says it took three', run.results[0]?.outcome === 'ok' && run.results[0]?.attempts === 3)
}
{
  const run = await runPipeline({
    packId: PACK,
    packState: 'complete',
    steps: [step({ id: 'a' }, { retries: 1 })],
    completedKeys: new Set(),
    execute: async () => {
      throw new Error('endpoint refused the delivery')
    },
    clock: fastClock(),
    retryDelayMs: () => 0,
  })
  const only = run.results[0]
  check('an action that never succeeds is FAILED, retryable, and carries its own message', only?.outcome === 'failed' && only.retryable && (only.message ?? '').includes('endpoint refused'))
  check('a failed idempotent action adds NOTHING to the ledger — the next run must be allowed to try again', run.newCompletedKeys.length === 0)
}
{
  const timeoutStartedAt = Date.now()
  const run = await runPipeline({
    packId: PACK,
    packState: 'complete',
    steps: [step({ id: 'a' }, { timeoutMs: 1_000 })],
    completedKeys: new Set(),
    // Never settles. The pipeline must abandon it rather than wait for an
    // action that cannot be made to stop.
    execute: () => new Promise<void>(() => {}),
    clock: fastClock(),
  })
  const timeoutWallClockMs = Date.now() - timeoutStartedAt
  check('an action that never returns TIMES OUT and is retryable', run.results[0]?.outcome === 'timed-out' && run.results[0]?.retryable === true)
  check(
    'timeout budgeting uses the injected fast clock, not a wall-clock timer',
    timeoutWallClockMs < 250,
    `${String(timeoutWallClockMs)} ms`,
  )
}
{
  const run = await runPipeline({
    packId: PACK,
    packState: 'complete',
    steps: [step({ id: 'a' }, { timeoutMs: 1_000 })],
    completedKeys: new Set(),
    execute: async () => {
      throw { weird: true }
    },
    clock: fastClock(),
  })
  check(
    'an action that throws something which is not an Error still produces a readable failure, never a crash',
    run.results[0]?.outcome === 'failed' && (run.results[0]?.message ?? '').includes('without a message'),
  )
}
{
  let timeoutCancelled = false
  const run = await runPipeline({
    packId: PACK,
    packState: 'complete',
    steps: [step({ id: 'a' }, { timeoutMs: 30_000 })],
    completedKeys: new Set(),
    execute: async () => {},
    clock: {
      now: () => 0,
      delay: (_ms, signal) =>
        new Promise<void>((resolve) => {
          const cancel = (): void => {
            timeoutCancelled = true
            resolve()
          }
          if (signal?.aborted) cancel()
          else signal?.addEventListener('abort', cancel, { once: true })
        }),
    },
  })
  check('an action that completes before its timeout succeeds', run.results[0]?.outcome === 'ok')
  check('a completed action cancels its pending clock delay', timeoutCancelled)
}
{
  const run = await runPipeline({
    packId: PACK,
    packState: 'complete',
    steps: [step({ id: 'a' }, { order: 1, continueOnFailure: false }), step({ id: 'b' }, { order: 2 })],
    completedKeys: new Set(),
    execute: async (s) => {
      if (s.manifest.id === 'a') throw new Error('no')
    },
    clock: fastClock(),
  })
  check('a halting failure skips what follows, and the follower still gets a row', run.results.map((r) => `${r.actionId}:${r.outcome}`).join(',') === 'a:failed,b:skipped')
}
{
  const run = await runPipeline({
    packId: PACK,
    packState: 'complete',
    steps: [step({ id: 'a' }, { order: 1, continueOnFailure: true }), step({ id: 'b' }, { order: 2 })],
    completedKeys: new Set(),
    execute: async (s) => {
      if (s.manifest.id === 'a') throw new Error('no')
    },
    clock: fastClock(),
  })
  check('continue-on-failure lets the rest of the pipeline run', run.results.map((r) => `${r.actionId}:${r.outcome}`).join(',') === 'a:failed,b:ok')
}
{
  const run = await runPipeline({
    packId: PACK,
    packState: 'metadata-ready',
    steps: [
      step({ id: 'a', requiredPackState: 'annotated-replay-ready' }, { order: 1, continueOnFailure: false }),
      step({ id: 'b', requiredPackState: 'metadata-ready' }, { order: 2 }),
    ],
    completedKeys: new Set(),
    execute: async () => {},
    clock: fastClock(),
  })
  check(
    'a blocked action does not hold back one that needs nothing it is waiting for',
    run.results.map((r) => `${r.actionId}:${r.outcome}`).join(',') === 'a:blocked,b:ok',
  )
}

console.log('\nRETRY IS OFFERED ONLY WHERE IT MEANS SOMETHING')
{
  const failure = { actionId: 'a', configId: 'cfg-1', outcome: 'failed' as const, attempts: 1, durationMs: 2, retryable: true }
  check('a failed action with an enabled config offers Retry', canRetry(failure, config()))
  check('a config the user has since disabled offers none', !canRetry(failure, config({ enabled: false })))
  check('a config that no longer exists offers none', !canRetry(failure, undefined))
  check(
    'a successful action offers none',
    !canRetry({ actionId: 'a', configId: 'cfg-1', outcome: 'ok', attempts: 1, durationMs: 2, retryable: false }, config()),
  )
  check(
    'a timed-out action with an enabled config offers Retry',
    canRetry({ actionId: 'a', configId: 'cfg-1', outcome: 'timed-out', attempts: 1, durationMs: 2, retryable: true }, config()),
  )
}

console.log('\nSUBSEQUENT PACK STATE TRANSITIONS DO NOT RE-EXECUTE FAILED ACTIONS (#169)')
{
  const session = new SaveActionLifecycle()
  const completedKeys = new Set<string>()
  const clock = fastClock()

  const cfg1 = config({ actionId: 'a', configId: 'cfg-1', order: 1, continueOnFailure: true })
  const cfg2 = config({ actionId: 'b', configId: 'cfg-2', order: 2 })
  const cfg3 = config({ actionId: 'c', configId: 'cfg-3', order: 3 })
  const allConfigs = [cfg1, cfg2, cfg3]

  const stepA = step({ id: 'a', requiredPackState: 'source-ready' }, cfg1)
  const stepB = step({ id: 'b', requiredPackState: 'annotated-replay-ready' }, cfg2)
  const stepC = step({ id: 'c', requiredPackState: 'complete' }, cfg3)
  const allSteps = [stepA, stepB, stepC]

  let aAttempts = 0
  let bAttempts = 0
  let cAttempts = 0
  const failureAnnouncements: string[][] = []

  const execute = async (s: PipelineStep) => {
    if (s.manifest.id === 'a') {
      aAttempts += 1
      throw new Error('remote service down')
    }
    if (s.manifest.id === 'b') {
      bAttempts += 1
    }
    if (s.manifest.id === 'c') {
      cAttempts += 1
    }
  }

  // Simulates onSave's runActionsAtState execution for a transition:
  const runState = async (packState: PackState) => {
    const targetConfigs = session.filterConfigs(allConfigs)
    if (targetConfigs.length === 0) return []
    const targetConfigIds = new Set(targetConfigs.map((c) => c.configId))
    const stepsToRun = allSteps.filter((s) => targetConfigIds.has(s.config.configId))
    const run = await runPipeline({
      packId: PACK,
      packState,
      steps: stepsToRun,
      completedKeys,
      execute,
      clock,
    })
    for (const key of run.newCompletedKeys) completedKeys.add(key)
    session.recordResults(run.results)
    const failures = failureResults(run.results)
    if (failures.length > 0) {
      failureAnnouncements.push(failures.map((f) => f.actionId))
    }
    return run.results
  }

  // 1. Initial transition: source-ready
  const r1 = await runState('source-ready')
  check(
    'at source-ready: failed action a exhausts attempts and is recorded as failed',
    r1.find((r) => r.actionId === 'a')?.outcome === 'failed' && aAttempts === 1,
  )
  check(
    'at source-ready: actions b and c are blocked waiting for later pack states',
    r1.find((r) => r.actionId === 'b')?.outcome === 'blocked'
      && r1.find((r) => r.actionId === 'c')?.outcome === 'blocked'
      && bAttempts === 0
      && cAttempts === 0,
  )
  check(
    'at source-ready: exactly one failure announcement is made for action a',
    failureAnnouncements.length === 1 && failureAnnouncements[0]?.join(',') === 'a',
  )
  check(
    'lifecycle tracks only actions b and c as blocked',
    session.blockedConfigIds.has('cfg-2')
      && session.blockedConfigIds.has('cfg-3')
      && !session.blockedConfigIds.has('cfg-1'),
  )

  // 2. Second transition: annotated-replay-ready
  const r2 = await runState('annotated-replay-ready')
  check(
    'at annotated-replay-ready: failed action a is NOT re-executed (#169)',
    aAttempts === 1,
    `action a attempts: ${String(aAttempts)}`,
  )
  check(
    'at annotated-replay-ready: previously blocked action b runs and succeeds',
    r2.find((r) => r.actionId === 'b')?.outcome === 'ok' && bAttempts === 1,
  )
  check(
    'at annotated-replay-ready: action c remains blocked',
    r2.find((r) => r.actionId === 'c')?.outcome === 'blocked' && cAttempts === 0,
  )
  check(
    'at annotated-replay-ready: no duplicate failure announcement is emitted for action a (#169)',
    failureAnnouncements.length === 1,
    `announcements count: ${String(failureAnnouncements.length)}`,
  )
  check(
    'lifecycle now tracks only action c as blocked',
    session.blockedConfigIds.has('cfg-3')
      && !session.blockedConfigIds.has('cfg-2')
      && !session.blockedConfigIds.has('cfg-1'),
  )

  // 3. Third transition: complete
  const r3 = await runState('complete')
  check(
    'at complete: failed action a is still NOT re-executed (#169)',
    aAttempts === 1,
    `action a attempts: ${String(aAttempts)}`,
  )
  check(
    'at complete: successful action b is NOT re-executed',
    bAttempts === 1,
    `action b attempts: ${String(bAttempts)}`,
  )
  check(
    'at complete: previously blocked action c runs and succeeds',
    r3.find((r) => r.actionId === 'c')?.outcome === 'ok' && cAttempts === 1,
  )
  check(
    'at complete: total failure announcements across the entire save session is still exactly 1',
    failureAnnouncements.length === 1,
  )
  check(
    'lifecycle blocked set is now completely clear',
    session.blockedConfigIds.size === 0,
  )

  // 4. Any further transition does nothing
  const r4 = await runState('complete')
  check('subsequent transitions after all blocked actions settle execute zero actions', r4.length === 0)
  check('failed action a attempts remains exactly 1', aAttempts === 1)

  // 5. Explicit user retry of the failed action executes it
  check('failed action offers canRetry', canRetry(r1[0]!, cfg1))
  const retryRun = await runPipeline({
    packId: PACK,
    packState: 'complete',
    steps: [stepA],
    completedKeys,
    execute,
    clock,
  })
  check(
    'explicit retry (retryAction path) re-executes the failed action on user request (#169)',
    aAttempts === 2 && retryRun.results[0]?.actionId === 'a',
  )
}
{
  const session = new SaveActionLifecycle()
  const clock = fastClock()
  const cfg1 = config({ actionId: 'a', configId: 'cfg-1', order: 1 })
  const stepA = step({ id: 'a', requiredPackState: 'annotated-replay-ready' }, cfg1)
  let aAttempts = 0

  // 1. source-ready: stepA is blocked
  session.filterConfigs([cfg1])
  const r1 = await runPipeline({
    packId: PACK,
    packState: 'source-ready',
    steps: [stepA],
    completedKeys: new Set(),
    execute: async () => { aAttempts += 1 },
    clock,
  })
  session.recordResults(r1.results)
  check('stepA blocked at source-ready', r1.results[0]?.outcome === 'blocked' && aAttempts === 0)

  // 2. annotated-replay-ready: stepA runs and fails
  session.filterConfigs([cfg1])
  const r2 = await runPipeline({
    packId: PACK,
    packState: 'annotated-replay-ready',
    steps: [stepA],
    completedKeys: new Set(),
    execute: async () => {
      aAttempts += 1
      throw new Error('fail at annotated-replay-ready')
    },
    clock,
  })
  session.recordResults(r2.results)
  check('stepA fails at annotated-replay-ready', r2.results[0]?.outcome === 'failed' && aAttempts === 1)

  // 3. complete: stepA must NOT re-execute
  const c3 = session.filterConfigs([cfg1])
  check('stepA is excluded from configs at complete after failing at annotated-replay-ready (#169)', c3.length === 0)
  check('stepA was not re-executed at complete', aAttempts === 1)
}
{
  const session = new SaveActionLifecycle()
  const clock = fastClock()
  const cfg1 = config({ actionId: 'a', configId: 'cfg-1', order: 1, continueOnFailure: false })
  const cfg2 = config({ actionId: 'b', configId: 'cfg-2', order: 2 })
  const stepA = step({ id: 'a', requiredPackState: 'source-ready' }, cfg1)
  const stepB = step({ id: 'b', requiredPackState: 'annotated-replay-ready' }, cfg2)
  let bAttempts = 0

  // Action a fails at source-ready and halts the pipeline; action b is skipped
  session.filterConfigs([cfg1, cfg2])
  const r1 = await runPipeline({
    packId: PACK,
    packState: 'source-ready',
    steps: [stepA, stepB],
    completedKeys: new Set(),
    execute: async (s) => {
      if (s.manifest.id === 'a') throw new Error('fail')
      bAttempts += 1
    },
    clock,
  })
  session.recordResults(r1.results)
  check(
    'a halting failure leaves downstream action skipped (not blocked)',
    r1.results.find((r) => r.actionId === 'b')?.outcome === 'skipped',
  )
  const c2 = session.filterConfigs([cfg1, cfg2])
  check(
    'downstream action behind a halted pipeline is not resurrected at subsequent transitions',
    c2.length === 0 && bAttempts === 0,
  )
}

console.log('\nTHE MODULES STAY REACHABLE WITHOUT A STUB')
{
  const here = process.cwd()
  const contract = readFileSync(path.join(here, 'src/shared/actions.ts'), 'utf8')
  const pipeline = readFileSync(path.join(here, 'src/shared/actionPipeline.ts'), 'utf8')
  // MODULE SPECIFIERS, NOT LINES. A line-based test read the first line of a
  // multi-line import as an import of nothing and reported a dependency that
  // was not there — the check failing for a reason that had nothing to do with
  // the rule it was defending.
  const specifiers = (text: string): string[] =>
    [...text.matchAll(/from\s+'([^']+)'/gu)].map((match) => match[1] ?? '')
  check('the contract imports nothing at all', specifiers(contract).length === 0, specifiers(contract).join(' | '))
  check(
    'the pipeline imports nothing but the contract — no Electron, no node:fs, no network',
    specifiers(pipeline).join(',') === './actions',
    specifiers(pipeline).join(' | '),
  )

  // The NUL bytes that landed in this file's own template literal were caught by
  // the idempotency assertion above, not by reading the source. Assert the text
  // is text, so the next single-byte corruption fails here and says so.
  const sources: ReadonlyArray<readonly [string, string]> = [
    ['src/shared/actions.ts', contract],
    ['src/shared/actionPipeline.ts', pipeline],
  ]
  for (const [name, text] of sources) {
    check(`${name} contains no control characters`, !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text))
  }
}

// A CHECK CAN EXIST, BE CORRECT, AND BE WIRED TO NOTHING.
//
// Everything above holds the rules. These hold the fact that the app obeys
// them — the half this repository has already paid for leaving out once.
console.log('\nTHE APP ACTUALLY RUNS THE PIPELINE')
{
  // Line endings normalized: these files are CRLF on disk, and an assertion
  // written with a bare newline would fail for the wrong reason.
  const read = (relative: string): string =>
    readFileSync(path.join(process.cwd(), relative), 'utf8').split('\r\n').join('\n')
  const session = read('src/main/session.ts')
  const settings = read('src/main/settings.ts')
  const onSave = read('src/main/actions/onSave.ts')
  const host = read('src/main/actions/host.ts')
  const i18n = read('src/shared/i18n.ts')
  const ipc = read('src/shared/ipc.ts')
  const settingsWindow = read('src/main/settingsWindow.ts')
  const preload = read('src/preload/settings.ts')

  check('session.ts imports the after-save entry point', session.includes("import { runActionsAtState } from './actions/onSave'"))
  check(
    'it fires at source-ready immediately after the save flow calls publication finished',
    session.includes("notePackSaved(savedHandle.dirPath)")
      && session.includes("void runActionsAtState(savedHandle.dirPath, 'source-ready', settings)"),
  )
  check(
    'it fires again at annotated-replay-ready when the derived render reports done, so a blocked action gets its second chance',
    session.includes("if (state === 'done')")
      && session.includes("void runActionsAtState(dirPath, 'annotated-replay-ready', settings)"),
  )
  check(
    'neither call is awaited — a pack that is already durable never waits for an action',
    session.includes("void runActionsAtState(savedHandle.dirPath")
      && session.includes("void runActionsAtState(dirPath"),
  )

  check('settings persist the configured pipeline', settings.includes('readActionConfigs(raw.actionConfigs'))
  check('settings persist the webhook targets', settings.includes('readActionWebhooks(raw.actionWebhooks'))
  check(
    'a malformed configuration row costs only that row — the pipeline is not emptied by one bad entry',
    settings.includes('for (const entry of value)') && settings.includes('continue'),
  )

  // GOAL.md: "Secrets never enter the pack — Windows Credential Manager or
  // Electron safeStorage." The negative half matters more than the positive:
  // a token in settings.json is a token in every backup of settings.json.
  check(
    'secret IPC channels exist in the IPC contract',
    ipc.includes("settingsActionSetSecret: 'settings:action-set-secret'")
      && ipc.includes("settingsActionHasSecret: 'settings:action-has-secret'")
      && ipc.includes("settingsActionForgetSecret: 'settings:action-forget-secret'"),
  )
  check(
    'main wires IPC handlers that invoke storeActionSecret, hasActionSecret, and forgetActionSecret',
    settingsWindow.includes('IPC.settingsActionSetSecret')
      && settingsWindow.includes('IPC.settingsActionHasSecret')
      && settingsWindow.includes('IPC.settingsActionForgetSecret')
      && settingsWindow.includes('storeActionSecret(')
      && settingsWindow.includes('hasActionSecret(')
      && settingsWindow.includes('forgetActionSecret('),
  )
  check(
    'preload exposes typed secret methods on settingsBridge',
    preload.includes('actionSetSecret(')
      && preload.includes('actionHasSecret(')
      && preload.includes('actionForgetSecret('),
  )
  check('the host stores secrets through safeStorage', host.includes('safeStorage.encryptString'))
  check('the host decrypts secrets through safeStorage', host.includes('safeStorage.decryptString'))
  check(
    'secrets round-trip via safeStorage in the host implementation',
    host.includes('storeActionSecret')
      && host.includes('readActionSecret')
      && host.includes('hasActionSecret')
      && host.includes('forgetActionSecret'),
  )
  check(
    'it refuses to store a secret at all when the OS cannot encrypt, rather than writing one in clear',
    host.includes('if (!safeStorage.isEncryptionAvailable())') && host.includes('refusing to store a secret'),
  )
  check(
    'plaintext secrets are never written to settings.json',
    !settings.includes('actionSecret') && !settings.includes('webhookSecret'),
  )

  check('a failing action is announced BY NAME, not as "an action failed"', onSave.includes("uiT(settings)('actions.failed', { names })"))
  check(
    'the failure string exists in all nine locales',
    (i18n.match(/'actions\.failed':/gu) ?? []).length === 9,
    String((i18n.match(/'actions\.failed':/gu) ?? []).length),
  )
  check(
    'a pack whose id cannot be read runs NOTHING — an action keyed on a guessed id could duplicate against the real one later',
    onSave.includes('if (packId === null) return []'),
  )
  check(
    'onSave.ts filters configs through SaveActionLifecycle so failed actions do not re-execute (#169)',
    onSave.includes('session.filterConfigs(allConfigs)')
      && onSave.includes('session.recordResults(results)'),
  )
  check(
    'onSave.ts serializes state transitions per pack so concurrent transitions do not race (#169)',
    onSave.includes('inFlightByPack.get(packId)')
      && onSave.includes('await inFlight.catch('),
  )
  check(
    'onSave.ts bounds remembered save sessions to 1,000 packs just like the ledger',
    onSave.includes('MAX_REMEMBERED_PACKS = 1_000')
      && onSave.includes('sessionsByPack.size > MAX_REMEMBERED_PACKS'),
  )
}

// SETTINGS SHOWS BOTH PLUGIN KINDS, AND SHOWS THE ACTION HONESTLY (#69).
console.log('\nSETTINGS > PLUGINS')
{
  // Line endings normalized: these files are CRLF on disk, and an assertion
  // written with a bare newline would fail for the wrong reason.
  const read = (relative: string): string =>
    readFileSync(path.join(process.cwd(), relative), 'utf8').split('\r\n').join('\n')
  const html = read('src/renderer/settings/settings.html')
  const ui = read('src/renderer/settings/settings.ts')
  const i18n = read('src/shared/i18n.ts')

  check(
    'the section has two named lists, not one undifferentiated pile',
    html.includes('data-i18n="settings.providersGroup"') && html.includes('data-i18n="settings.actionsGroup"'),
  )
  check('there is somewhere to draw the configured actions', html.includes('id="actionList"'))
  check('and a way to add one', html.includes('id="actionAddBtn"'))
  check('an empty pipeline says so rather than showing nothing', html.includes('id="actionsEmpty"'))

  check('the renderer draws the list from the saved settings', ui.includes('function renderActionList()'))
  check(
    'and redraws it whenever the settings change, so a row can never show a value main rejected',
    ui.includes('renderActionList()\n}'),
  )
  check(
    'a row is built with createElement — a webhook URL is user input and this is where it is displayed',
    ui.includes("document.createElement('input')") && !ui.includes('actionList.innerHTML'),
  )
  check(
    'PERMISSIONS ARE SHOWN, from the manifest rather than from a hand-written list',
    ui.includes("t('settings.actionPermissions', {") && ui.includes('manifest.permissions.join'),
  )
  check(
    'an action that sends pack data off the machine says so, decided by the contract',
    ui.includes('sendsDataOffMachine(manifest.permissions)') && ui.includes("t('settings.actionOffMachine')"),
  )
  check(
    'status is read from reality — disabled, no URL, an unusable URL, or ready',
    ui.includes("t('settings.actionStateDisabled')")
      && ui.includes("t('settings.actionStateNoUrl')")
      && ui.includes("t('settings.actionStateBadUrl')")
      && ui.includes("t('settings.actionStateReady')"),
  )
  check(
    'the renderer judges a URL with the SAME rule main enforces',
    ui.includes('isAcceptableWebhookUrl(webhook.url)')
      && ui.includes("from '../../shared/actions'"),
  )
  check(
    'ORDER IS REORDERABLE, and the order written back is dense rather than inherited from array position',
    ui.includes("t('settings.actionMoveUp')")
      && ui.includes("t('settings.actionMoveDown')")
      && ui.includes('configs.map((config, index) => ({ ...config, order: index }))'),
  )
  check(
    'a NEW action starts disabled — one that enabled itself would fire on the next save against an empty URL',
    ui.includes('enabled: false,') && ui.includes('order: settings.actionConfigs.length,'),
  )
  check(
    'webhook settings for a removed configuration are dropped, not left to accumulate under a dead id',
    ui.includes('const live: Record<string, ActionWebhookSettings> = {}'),
  )
  check(
    'a masked input is rendered for the webhook bearer secret with save and clear buttons',
    ui.includes("type = 'password'")
      && ui.includes("t('settings.actionSecretPlaceholder')")
      && ui.includes("t('settings.actionSecretSave')")
      && ui.includes("t('settings.actionSecretClear')"),
  )
  check(
    'secret presence is rendered without exposing the plaintext secret in the UI',
    ui.includes('bridge.actionHasSecret(config.configId)')
      && ui.includes("t('settings.actionSecretConfigured')")
      && ui.includes("t('settings.actionSecretNone')"),
  )
  check(
    'removing an action configuration purges its secret from action-secrets.json',
    ui.includes('bridge.actionForgetSecret(config.configId)'),
  )

  const keys = [
    'settings.providersGroup',
    'settings.actionsGroup',
    'settings.actionsNote',
    'settings.actionsEmpty',
    'settings.actionAdd',
    'settings.actionStateDisabled',
    'settings.actionStateNoUrl',
    'settings.actionStateBadUrl',
    'settings.actionStateReady',
    'settings.actionPermissions',
    'settings.actionOffMachine',
    'settings.actionUrl',
    'settings.actionContinue',
    'settings.actionTimeout',
    'settings.actionRetries',
    'settings.actionMoveUp',
    'settings.actionMoveDown',
    'settings.actionRemove',
    'settings.actionSecret',
    'settings.actionSecretPlaceholder',
    'settings.actionSecretSave',
    'settings.actionSecretClear',
    'settings.actionSecretConfigured',
    'settings.actionSecretNone',
  ]
  const missing = keys.filter((key) => {
    const matches = i18n.split(`'${key}':`).length - 1
    return matches !== 9
  })
  check(
    `all ${String(keys.length)} new Settings strings exist in all nine locales`,
    missing.length === 0,
    missing.join(', '),
  )
}

// A FIELD NAME THAT LOOKS OBVIOUS AND DOES NOT EXIST.
//
// The webhook summary read `manifest.app_version` and posted null to a real
// receiver in the end-to-end test. There is no top-level app version: SPEC puts
// the writing tool under `generator`. Nothing caught it, because a reader that
// asks for a missing key is not an error in any language involved — it is a
// null that travels all the way to somebody's endpoint and gets trusted.
//
// So the fields the summary reads are held against the published schema.
console.log('\nTHE WEBHOOK SUMMARY READS FIELDS THAT EXIST')
{
  const readNorm = (relative: string): string =>
    readFileSync(path.join(process.cwd(), relative), 'utf8').split('\r\n').join('\n')
  // CODE, NOT PROSE. Both assertions below first failed against the comment
  // that EXPLAINS the bug they defend — the same mistake, twice, in the same
  // check. A source test that reads its own documentation is not a source test.
  const stripComments = (source: string): string =>
    source
      .split('\n')
      .map((line) => {
        const trimmed = line.trimStart()
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return ''
        const marker = line.indexOf('//')
        return marker < 0 ? line : line.slice(0, marker)
      })
      .join('\n')
  const webhook = stripComments(readNorm('src/main/actions/webhook.ts'))
  const schemaText = readNorm('../docs/schemas/manifest.schema.json')
  const schema: unknown = JSON.parse(schemaText)
  const properties =
    typeof schema === 'object' && schema !== null
      ? ((schema as Record<string, unknown>).properties as Record<string, unknown> | undefined)
      : undefined

  const declared = (name: string): boolean => properties !== undefined && name in properties
  for (const field of ['id', 'created_at', 'capture_kind', 'format_version', 'generator', 'media']) {
    check(`the schema declares ${field}, which the summary reads`, declared(field))
  }
  check(
    'the summary takes the application version from generator, where the format actually puts it',
    webhook.includes('asString(generator.version)'),
  )
  check(
    'and no longer reads a top-level app_version, which never existed',
    !webhook.includes('record.app_version'),
  )
  check(
    'the summary carries the FORMAT version too — it moves independently of the application version',
    webhook.includes("asString(record.format_version)"),
  )
  check(
    'manifest.json is the ONLY file the action opens — no media, annotations, timeline or context',
    (webhook.match(/readFile\(/gu) ?? []).length === 1 && webhook.includes("path.join(packDir, 'manifest.json')"),
  )
  check(
    'and no pack file name other than the manifest appears in its code at all',
    !webhook.includes('annotations.json')
      && !webhook.includes('timeline.json')
      && !webhook.includes('snapshot.png')
      && !webhook.includes('replay.webm'),
  )
  check(
    'outbound webhook deliveries attach Authorization: Bearer <secret> when configured',
    webhook.includes("headers.authorization = `Bearer ${delivery.secret}`"),
  )
  check(
    'outbound webhook deliveries configure fetch with redirect: error (#172)',
    webhook.includes("redirect: 'error'"),
  )
  check(
    'webhook delivery errors reject unsupported redirects with an informative message (#172)',
    webhook.includes("'the webhook responded with an unsupported redirect'"),
  )
  check(
    'webhook delivery errors are passed through a userinfo redaction before they are rethrown (#173)',
    webhook.includes('redactUrlCredentials(') && webhook.includes("could not reach the webhook: ${redactUrlCredentials(message)}"),
  )
}

// A SECRET STORE THAT ONE INTERRUPTED WRITE CAN EMPTY FOR GOOD.
//
// The idempotency ledger is written beside its target and renamed. The secret
// store was not: `writeFileSync(secretsPath(), ...)` truncates the file first,
// and a shutdown in the gap leaves invalid JSON that `readSecretStore` reads
// as `{}`. The next store or forget then persists that empty object over every
// secret the user had. Same module, same pattern already written — held here
// so the two cannot drift apart again. (#171)
console.log('\nTHE SECRET STORE IS REPLACED ATOMICALLY')
{
  const readNorm = (relative: string): string =>
    readFileSync(path.join(process.cwd(), relative), 'utf8').split('\r\n').join('\n')
  const stripComments = (source: string): string =>
    source
      .split('\n')
      .map((line) => {
        const trimmed = line.trimStart()
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return ''
        const marker = line.indexOf('//')
        return marker < 0 ? line : line.slice(0, marker)
      })
      .join('\n')
  const host = readNorm('src/main/actions/host.ts')
  // SCOPED TO THE SECRETS SECTION. `renameSync` already appears in this file
  // for the ledger; an assertion against the whole module would pass today
  // with the secret store still written in place. Slice on the section
  // banners (which are comments, so slice BEFORE stripping them).
  const start = host.indexOf('// ── Secrets')
  const end = host.indexOf('// ── Registry')
  check('the host has a Secrets section followed by the Registry section', start >= 0 && end > start)
  const secrets = stripComments(host.slice(Math.max(start, 0), end > start ? end : undefined))
  const body = (name: string): string => {
    const at = secrets.indexOf(`function ${name}(`)
    if (at < 0) return ''
    const close = secrets.indexOf('\n}\n', at)
    return secrets.slice(at, close < 0 ? undefined : close)
  }

  check(
    'secret store serialization goes through one helper, writeSecretStore',
    secrets.includes('function writeSecretStore(store: Record<string, string>): void'),
  )
  check(
    'writeSecretStore writes a sibling temporary file and renames it over action-secrets.json',
    body('writeSecretStore').includes('const target = secretsPath()')
      && body('writeSecretStore').includes('const temporary = `${target}.tmp`')
      && body('writeSecretStore').includes('writeFileSync(temporary, JSON.stringify(store)')
      && body('writeSecretStore').includes('renameSync(temporary, target)'),
  )
  check(
    'the rename happens AFTER the temporary is fully written',
    body('writeSecretStore').indexOf('writeFileSync(temporary') < body('writeSecretStore').indexOf('renameSync(temporary, target)'),
  )
  check(
    'storeActionSecret persists through writeSecretStore',
    body('storeActionSecret').includes('writeSecretStore(store)'),
  )
  check(
    'forgetActionSecret persists through writeSecretStore',
    body('forgetActionSecret').includes('writeSecretStore(store)'),
  )
  check(
    'nothing in the Secrets section writes directly to secretsPath()',
    !secrets.includes('writeFileSync(secretsPath()'),
  )
  check(
    'the ONLY writeFileSync in the Secrets section is the one that targets the temporary file',
    (secrets.match(/writeFileSync\(/gu) ?? []).length === 1 && secrets.includes('writeFileSync(temporary,'),
    String((secrets.match(/writeFileSync\(/gu) ?? []).length),
  )
}

console.log('\nACTION SECRETS ROUND-TRIP')
{
  const fakeSafeStorage = {
    encryptString: (plaintext: string) => Buffer.from(`ENC:${plaintext}`, 'utf8'),
    decryptString: (ciphertext: Buffer) => {
      const s = ciphertext.toString('utf8')
      if (!s.startsWith('ENC:')) throw new Error('decryption failed')
      return s.slice(4)
    },
  }
  const secret = 'bearer-token-12345-xyz'
  const encrypted = fakeSafeStorage.encryptString(secret).toString('base64')
  const decrypted = fakeSafeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  check('secrets round-trip via safeStorage encryption and decryption logic', decrypted === secret)
}

console.log('\nA CONFIGURED WEBHOOK SECRET FAILS CLOSED WHEN DECRYPTION FAILS (#170)')
{
  const configId = 'cfg-decryption-failure'
  const packDir = mkdtempSync(path.join(tmpdir(), 'capturepack-webhook-secret-failure-'))
  const userDataDir = app.getPath('userData')
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(
    path.join(userDataDir, 'action-secrets.json'),
    JSON.stringify({ [configId]: Buffer.from('ciphertext-that-cannot-be-decrypted').toString('base64') }),
    'utf8',
  )
  writeFileSync(
    path.join(packDir, 'manifest.json'),
    JSON.stringify({
      id: PACK,
      created_at: '2026-09-21T00:00:00.000Z',
      capture_kind: 'still',
      format_version: '1.0',
      generator: { version: '0.5.1' },
      media: { displays: [] },
    }),
    'utf8',
  )

  let receivedCount = 0
  const receiver = createServer((_req, res) => {
    receivedCount += 1
    res.writeHead(200)
    res.end()
  })
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', () => resolve()))
  const receiverPort = (receiver.address() as { port: number }).port

  try {
    const results = await runActionsForPack({
      packDir,
      packId: PACK,
      packState: 'complete',
      configs: [config({ actionId: BUILTIN_WEBHOOK_ACTION_ID, configId })],
      webhooks: {
        [configId]: { url: `http://127.0.0.1:${String(receiverPort)}/hook` },
      },
    })
    const result = results[0]
    check(
      'the action fails with the local decryption error',
      result?.outcome === 'failed'
        && result.message === 'configured webhook secret could not be decrypted',
      result?.message ?? 'no action result',
    )
    check(
      'the receiver is never contacted when the configured secret cannot be decrypted',
      receivedCount === 0,
      `requests: ${String(receivedCount)}`,
    )
  } finally {
    await new Promise<void>((resolve) => receiver.close(() => resolve()))
    rmSync(packDir, { recursive: true, force: true })
  }
}

console.log('\nWEBHOOK DELIVERY REFUSES HTTP REDIRECTS')
{
  let targetReceivedCount = 0
  let targetReceivedAuth: string | undefined
  const targetServer = createServer((req, res) => {
    targetReceivedCount += 1
    targetReceivedAuth = req.headers.authorization
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  await new Promise<void>((resolve) => targetServer.listen(0, '127.0.0.1', () => resolve()))
  const targetPort = (targetServer.address() as { port: number }).port

  let okServerReceivedAuth: string | undefined
  let okServerReceivedBody = ''
  const redirectServer = createServer((req, res) => {
    if (req.url === '/redirect-302') {
      res.writeHead(302, { Location: `http://127.0.0.1:${String(targetPort)}/target` })
      res.end()
      return
    }
    if (req.url === '/redirect-301') {
      res.writeHead(301, { Location: `http://127.0.0.1:${String(targetPort)}/target` })
      res.end()
      return
    }
    if (req.url === '/redirect-307') {
      res.writeHead(307, { Location: `http://127.0.0.1:${String(targetPort)}/target` })
      res.end()
      return
    }
    if (req.url === '/redirect-308') {
      res.writeHead(308, { Location: `http://127.0.0.1:${String(targetPort)}/target` })
      res.end()
      return
    }
    if (req.url === '/ok') {
      okServerReceivedAuth = req.headers.authorization
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        okServerReceivedBody = Buffer.concat(chunks).toString('utf8')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok' }))
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => redirectServer.listen(0, '127.0.0.1', () => resolve()))
  const redirectPort = (redirectServer.address() as { port: number }).port

  const tempPackDir = mkdtempSync(path.join(tmpdir(), 'capturepack-webhook-redirect-'))
  const manifestContent = JSON.stringify({
    id: 'e3f1c0de-0000-4000-8000-000000000001',
    created_at: '2026-09-11T00:00:00.000Z',
    capture_kind: 'still',
    format_version: '1.0.0',
    generator: { name: 'CapturePack', version: '0.5.0' },
    media: { displays: [] },
  })
  writeFileSync(path.join(tempPackDir, 'manifest.json'), manifestContent, 'utf8')

  try {
    // 302 redirect
    let caught302: Error | null = null
    try {
      await deliverWebhook(tempPackDir, {
        url: `http://127.0.0.1:${String(redirectPort)}/redirect-302`,
        secret: 'bearer-secret-302',
        timeoutMs: 5_000,
      })
    } catch (err) {
      caught302 = err instanceof Error ? err : new Error(String(err))
    }
    check(
      'deliverWebhook refuses HTTP 302 redirect with an informative message (#172)',
      caught302 !== null && caught302.message === 'the webhook responded with an unsupported redirect',
      caught302?.message ?? 'no error thrown',
    )
    check('redirect target server was never contacted', targetReceivedCount === 0, `requests: ${String(targetReceivedCount)}`)
    check('bearer secret was never sent to redirect target', targetReceivedAuth === undefined)

    // 301, 307, 308 redirects
    for (const status of [301, 307, 308]) {
      let caught: Error | null = null
      try {
        await deliverWebhook(tempPackDir, {
          url: `http://127.0.0.1:${String(redirectPort)}/redirect-${String(status)}`,
          secret: `bearer-secret-${String(status)}`,
          timeoutMs: 5_000,
        })
      } catch (err) {
        caught = err instanceof Error ? err : new Error(String(err))
      }
      check(
        `deliverWebhook refuses HTTP ${String(status)} redirect (#172)`,
        caught !== null && caught.message === 'the webhook responded with an unsupported redirect',
        caught?.message ?? 'no error thrown',
      )
    }
    check('target server remained completely uncalled across all redirect tests', targetReceivedCount === 0)

    // Normal 200 delivery succeeds
    let normalError: Error | null = null
    try {
      await deliverWebhook(tempPackDir, {
        url: `http://127.0.0.1:${String(redirectPort)}/ok`,
        secret: 'bearer-secret-ok',
        timeoutMs: 5_000,
      })
    } catch (err) {
      normalError = err instanceof Error ? err : new Error(String(err))
    }
    check('deliverWebhook succeeds when receiver answers 200 OK', normalError === null, normalError?.message ?? '')
    check('200 OK receiver received the configured bearer secret', okServerReceivedAuth === 'Bearer bearer-secret-ok')
    check(
      '200 OK receiver received the pack summary payload',
      okServerReceivedBody.includes('capturepack.pack.saved') && okServerReceivedBody.includes('e3f1c0de-0000-4000-8000-000000000001'),
    )

    // A URL that slipped past the contract with credentials in it. fetch refuses
    // it before any socket is opened, and quotes the URL in the TypeError; the
    // message that reaches the log and the notification must not carry them.
    const receivedBefore = targetReceivedCount
    let credentialError: Error | null = null
    try {
      await deliverWebhook(tempPackDir, {
        url: `http://leaked-user:leaked-s3cret@127.0.0.1:${String(targetPort)}/target`,
        secret: null,
        timeoutMs: 5_000,
      })
    } catch (err) {
      credentialError = err instanceof Error ? err : new Error(String(err))
    }
    check('deliverWebhook fails on a URL with embedded credentials (#173)', credentialError !== null)
    check(
      'and the failure message carries neither the user nor the password (#173)',
      credentialError !== null && !credentialError.message.includes('leaked-user') && !credentialError.message.includes('leaked-s3cret'),
      credentialError?.message ?? '',
    )
    check('and the receiver was never contacted', targetReceivedCount === receivedBefore)
  } finally {
    await new Promise<void>((resolve) => targetServer.close(() => resolve()))
    await new Promise<void>((resolve) => redirectServer.close(() => resolve()))
    rmSync(tempPackDir, { recursive: true, force: true })
  }
}

console.log('\nAFTER SAVE ACTION EXECUTION RESULTS & RETRY (#165)')
{
  const readNorm = (relative: string): string =>
    readFileSync(path.join(process.cwd(), relative), 'utf8').split('\r\n').join('\n')
  const ipc = readNorm('src/shared/ipc.ts')
  const host = readNorm('src/main/actions/host.ts')
  const onSave = readNorm('src/main/actions/onSave.ts')
  const saveToast = readNorm('src/main/saveToast.ts')
  const historyWindow = readNorm('src/main/historyWindow.ts')
  const preloadToast = readNorm('src/preload/toast.ts')
  const preloadHistory = readNorm('src/preload/history.ts')
  const toastHtml = readNorm('src/renderer/toast/toast.html')
  const toastTs = readNorm('src/renderer/toast/toast.ts')
  const historyTs = readNorm('src/renderer/history/history.ts')
  const i18n = readNorm('src/shared/i18n.ts')

  // IPC channel definitions
  check('IPC declares toastActionResults channel', ipc.includes("toastActionResults: 'toast:action-results'"))
  check('IPC declares toastActionRetry channel', ipc.includes("toastActionRetry: 'toast:action-retry'"))
  check('IPC declares historyActionResults channel', ipc.includes("historyActionResults: 'history:action-results'"))
  check('IPC declares historyActionRetry channel', ipc.includes("historyActionRetry: 'history:action-retry'"))
  check('ToastInitPayload carries actionResults and actionConfigs', ipc.includes('actionResults?: ActionResult[]') && ipc.includes('actionConfigs?: ActionConfig[]'))
  check('HistoryPackSummary carries actionResults', ipc.includes('actionResults?: ActionResult[]'))
  check('HistoryListResult carries actionConfigs', ipc.includes('actionConfigs?: ActionConfig[]'))

  // Host persistence
  check('host exports persistActionResults', host.includes('export function persistActionResults('))
  check('host exports readActionResults', host.includes('export function readActionResults('))
  check('action results path targets plugins/action-results.json', host.includes("path.join(packDir, 'plugins', 'action-results.json')"))
  check('persistActionResults writes atomically via sibling temporary file', host.includes('const temporary = `${target}.tmp`') && host.includes('renameSync(temporary, target)'))
  check('runActionsForPack persists results to pack plugins folder', host.includes('persistActionResults(request.packDir, run.results)'))
  check('retryAction refuses disabled configuration', host.includes('if (!config.enabled) return null'))
  check('retryAction forgets idempotency key from ledger before re-running', host.includes('const key = idempotencyKey(request.packId, manifest.id, configId)') && host.includes('ledger.packs[request.packId] = remaining'))
  check('retryAction delegates to runActionsForPack which persists updated result', host.includes('const results = await runActionsForPack({ ...request, configs: [config] })'))

  // onSave coordination
  check('onSave runs actions and pushes results to active save toast', onSave.includes('updateToastActionResults(packDir, results)'))
  check('onSave exports readActionResults', onSave.includes("export { readActionResults } from './host'"))

  // Save toast wiring
  check('saveToast reads actionResults and passes actionConfigs', saveToast.includes('readActionResults(options.folderPath)') && saveToast.includes('actionConfigs: settings.actionConfigs'))
  check('saveToast handles IPC toastActionRetry', saveToast.includes('IPC.toastActionRetry') && saveToast.includes('retryAction('))
  check('saveToast exposes updateToastActionResults helper', saveToast.includes('export function updateToastActionResults('))

  // History window wiring
  check('historyWindow includes actionResults in safeSummarize', historyWindow.includes("entry.kind === 'dir' ? readActionResults(entry.path) : readZipActionResults(pack)"))
  check('historyWindow includes actionConfigs in historyList', historyWindow.includes('actionConfigs: live.actionConfigs'))
  check('historyWindow handles IPC historyActionRetry', historyWindow.includes('IPC.historyActionRetry') && historyWindow.includes('retryAction('))
  check('historyWindow handles IPC historyActionResults', historyWindow.includes('IPC.historyActionResults') && historyWindow.includes('readActionResults('))

  // Preload bridges
  check('preload toast exposes onActionResults and actionRetry', preloadToast.includes('onActionResults(') && preloadToast.includes('actionRetry('))
  check('preload history exposes actionRetry and actionResults', preloadHistory.includes('actionRetry(') && preloadHistory.includes('actionResults('))

  // Renderer UI
  check('toast.html includes actionStatus container', toastHtml.includes('id="actionStatus"'))
  check('toast.ts renders action results and wires retry', toastTs.includes('renderActionResults()') && toastTs.includes('toastBridge.actionRetry('))
  check('history.ts builds action status rows and wires retry', historyTs.includes('buildActionStatus(') && historyTs.includes('actionRetry('))

  // i18n keys across all 9 locales
  const actionI18nKeys = [
    'actions.retry',
    'actions.retrying',
    'actions.statusOk',
    'actions.statusFailed',
    'actions.statusTimedOut',
    'actions.statusBlocked',
    'actions.statusSkipped',
    'actions.heading',
  ]
  for (const key of actionI18nKeys) {
    const count = (i18n.match(new RegExp(`'${key}':`, 'gu')) ?? []).length
    check(`i18n key '${key}' exists in all 9 locales`, count === 9, `found ${String(count)}`)
  }

  // Functional filesystem test of action results round-trip
  const testPackDir = mkdtempSync(path.join(tmpdir(), 'capturepack-action-results-test-'))
  try {
    const pluginsDir = path.join(testPackDir, 'plugins')
    mkdirSync(pluginsDir, { recursive: true })
    const resultsFile = path.join(pluginsDir, 'action-results.json')
    const sampleResults = [
      {
        actionId: 'builtin:webhook',
        configId: 'cfg-test-1',
        outcome: 'failed',
        attempts: 2,
        durationMs: 45,
        message: 'connection refused',
        retryable: true,
      },
      {
        actionId: 'builtin:webhook',
        configId: 'cfg-test-2',
        outcome: 'ok',
        attempts: 1,
        durationMs: 12,
        retryable: false,
      },
    ]
    const tempFile = `${resultsFile}.tmp`
    writeFileSync(tempFile, JSON.stringify(sampleResults, null, 2), 'utf8')
    renameSync(tempFile, resultsFile)

    const raw = readFileSync(resultsFile, 'utf8')
    const parsed = JSON.parse(raw) as typeof sampleResults
    check('durable action results file parses successfully', Array.isArray(parsed) && parsed.length === 2)
    check(
      'failed action in results file retains message and retryable flag',
      parsed[0]?.outcome === 'failed' && parsed[0]?.retryable === true && parsed[0]?.message === 'connection refused',
    )
    check('ok action in results file retains ok outcome', parsed[1]?.outcome === 'ok' && parsed[1]?.retryable === false)
  } finally {
    rmSync(testPackDir, { recursive: true, force: true })
  }

  // Host persistence merge behavior
  check('host exports mergeActionResults', host.includes('export { mergeActionResults } from'))
  check('persistActionResults preserves terminal outcomes against non-run skipped results', host.includes('mergeActionResults(existing, newResults)'))

  // mergeActionResults contract
  const priorOk: ActionResult = { actionId: 'a', configId: 'c1', outcome: 'ok', attempts: 1, durationMs: 25, retryable: false }
  const priorFailed: ActionResult = { actionId: 'a', configId: 'c2', outcome: 'failed', attempts: 1, durationMs: 10, message: 'err', retryable: true }
  const priorTimedOut: ActionResult = { actionId: 'a', configId: 'c3', outcome: 'timed-out', attempts: 1, durationMs: 1000, message: 'timeout', retryable: true }
  const skippedRun: ActionResult = { actionId: 'a', configId: 'c1', outcome: 'skipped', attempts: 0, durationMs: 0, message: 'already completed for this pack', retryable: false }
  const skippedDisabled: ActionResult = { actionId: 'a', configId: 'c2', outcome: 'skipped', attempts: 0, durationMs: 0, message: 'disabled', retryable: false }
  const skippedHalted: ActionResult = { actionId: 'a', configId: 'c3', outcome: 'skipped', attempts: 0, durationMs: 0, message: 'halted', retryable: false }
  const mergedOk = mergeActionResults([priorOk], [skippedRun])
  check('mergeActionResults does not let non-run skipped overwrite terminal ok', mergedOk[0]?.outcome === 'ok' && mergedOk[0]?.attempts === 1)
  const mergedFailed = mergeActionResults([priorFailed], [skippedDisabled])
  check('mergeActionResults does not let non-run skipped overwrite terminal failed', mergedFailed[0]?.outcome === 'failed' && mergedFailed[0]?.attempts === 1)
  const mergedTimedOut = mergeActionResults([priorTimedOut], [skippedHalted])
  check('mergeActionResults does not let non-run skipped overwrite terminal timed-out', mergedTimedOut[0]?.outcome === 'timed-out' && mergedTimedOut[0]?.attempts === 1)
  const retriedOk: ActionResult = { actionId: 'a', configId: 'c2', outcome: 'ok', attempts: 1, durationMs: 15, retryable: false }
  const mergedRetry = mergeActionResults([priorFailed], [retriedOk])
  check('mergeActionResults allows retry to update terminal failed to ok', mergedRetry[0]?.outcome === 'ok' && mergedRetry[0]?.attempts === 1)

  // Functional rerun test: source-ready then annotated-replay-ready leaves persisted outcome ok
  const testRerunPackDir = mkdtempSync(path.join(tmpdir(), 'capturepack-action-rerun-test-'))
  try {
    const configId = 'cfg-rerun-test'
    const stepConfig = config({ configId, order: 1 })
    const stepManifest = manifest({ id: 'webhook', requiredPackState: 'source-ready', idempotent: true })
    const pipelineStep = { manifest: stepManifest, config: stepConfig }

    // First pass at source-ready: runs and succeeds ('ok')
    let completedKeys = new Set<string>()
    const run1 = await runPipeline({
      packId: PACK,
      packState: 'source-ready',
      steps: [pipelineStep],
      completedKeys,
      execute: async () => {},
      clock: fastClock(),
    })
    check('first pipeline pass at source-ready succeeds', run1.results[0]?.outcome === 'ok')
    completedKeys = new Set([...completedKeys, ...run1.newCompletedKeys])

    const resultsFile = path.join(testRerunPackDir, 'plugins', 'action-results.json')
    mkdirSync(path.dirname(resultsFile), { recursive: true })

    const persist = (results: readonly ActionResult[]): void => {
      let existing: ActionResult[] = []
      if (existsSync(resultsFile)) {
        try {
          existing = JSON.parse(readFileSync(resultsFile, 'utf8')) as ActionResult[]
        } catch {}
      }
      const merged = mergeActionResults(existing, results)
      const tmp = `${resultsFile}.tmp`
      writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8')
      renameSync(tmp, resultsFile)
    }

    persist(run1.results)
    const disk1 = JSON.parse(readFileSync(resultsFile, 'utf8')) as ActionResult[]
    check('first pass persisted outcome is ok', disk1[0]?.outcome === 'ok' && disk1[0]?.attempts === 1)

    // Second pass at annotated-replay-ready: decideStep returns skipped ('already completed for this pack')
    const run2 = await runPipeline({
      packId: PACK,
      packState: 'annotated-replay-ready',
      steps: [pipelineStep],
      completedKeys,
      execute: async () => {},
      clock: fastClock(),
    })
    check('second pipeline pass at annotated-replay-ready returns skipped', run2.results[0]?.outcome === 'skipped')

    // Persisting the second run must not overwrite the earlier 'ok' result
    persist(run2.results)
    const disk2 = JSON.parse(readFileSync(resultsFile, 'utf8')) as ActionResult[]
    check(
      'running the pipeline at source-ready (ok) and then at annotated-replay-ready leaves the persisted outcome ok for the completed config',
      disk2[0]?.outcome === 'ok' && disk2[0]?.attempts === 1 && disk2[0]?.configId === configId,
    )
  } finally {
    rmSync(testRerunPackDir, { recursive: true, force: true })
  }
}

if (failed > 0) {
  console.error(`\naction-pipeline-check failed: ${failed}`)
  process.exitCode = 1
} else {
  console.log('\naction-pipeline-check ok')
}
