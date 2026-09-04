// The After Save Action contract and pipeline (#68).
//
// Everything asserted here is production code imported directly: both modules
// are dependency-free on purpose, so this check needs no Electron stub and
// cannot end up holding a mock to the standard the app is not held to.
//
// The invariant under test throughout: THE PACK IS ALREADY SAVED. An action
// that fails, hangs, or throws something that is not an Error is that action's
// own failure and nothing else's.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  ACTION_PERMISSIONS,
  ACTION_TIMEOUT_DEFAULT_MS,
  ACTION_TIMEOUT_MAX_MS,
  PACK_STATE_ORDER,
  type ActionConfig,
  type ActionManifest,
  type PackState,
  type PipelineStep,
  decideStep,
  haltsPipeline,
  idempotencyKey,
  normalizeActionTimeout,
  packStateAtLeast,
  pipelineOrder,
  sendsDataOffMachine,
  totalAttempts,
} from '../src/shared/actions'
import { runPipeline, canRetry } from '../src/shared/actionPipeline'

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
  check('an action that never returns TIMES OUT and is retryable', run.results[0]?.outcome === 'timed-out' && run.results[0]?.retryable === true)
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
  check('the host stores secrets through safeStorage', host.includes('safeStorage.encryptString'))
  check(
    'it refuses to store a secret at all when the OS cannot encrypt, rather than writing one in clear',
    host.includes('if (!safeStorage.isEncryptionAvailable())') && host.includes('refusing to store a secret'),
  )
  check(
    'no secret is persisted in settings.json',
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
}

if (failed > 0) {
  console.error(`\naction-pipeline-check failed: ${failed}`)
  process.exitCode = 1
} else {
  console.log('\naction-pipeline-check ok')
}
