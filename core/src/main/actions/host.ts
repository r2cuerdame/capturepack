// The After Save Action host (#68).
//
// Everything in this file is the part that touches the machine: which actions
// exist, what has already been done for a pack, where a secret lives, and how
// one attempt is actually made. The decisions — order, gating, retry,
// idempotency, what halts a pipeline — live in shared/actionPipeline.ts, which
// the gate drives directly.
//
// THE SAVE IS ALREADY DONE BY THE TIME ANYTHING HERE RUNS. Every export below
// is written so that a failure inside it is that action's failure and never the
// caller's: nothing throws out of runActionsForPack, and a ledger that cannot be
// read is an empty ledger rather than a refusal to run.

import { app, safeStorage } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  type ActionConfig,
  type ActionManifest,
  type ActionResult,
  type PackState,
  type PipelineStep,
  idempotencyKey,
} from '../../shared/actions'
import { runPipeline } from '../../shared/actionPipeline'
import { logError, logInfo } from '../log'
import {
  WEBHOOK_ACTION_ID,
  WEBHOOK_MANIFEST,
  deliverWebhook,
  isAcceptableWebhookUrl,
} from './webhook'

/**
 * Packs remembered in the idempotency ledger.
 *
 * The ledger exists to stop a duplicate, and a duplicate is something that
 * happens minutes or days after the first run — not months. Bounding it keeps a
 * file that is written on every save from growing without end, and the cost of
 * forgetting the oldest entry is one extra webhook on a pack nobody has touched
 * in a thousand saves.
 */
const LEDGER_MAX_PACKS = 1_000

interface Ledger {
  version: 1
  /** packId -> completed idempotency keys. Insertion order is age order. */
  packs: Record<string, string[]>
}

function ledgerPath(): string {
  return path.join(app.getPath('userData'), 'action-ledger.json')
}

function emptyLedger(): Ledger {
  return { version: 1, packs: {} }
}

/**
 * Read the ledger, treating every failure as "nothing has been done yet".
 *
 * A ledger that cannot be parsed must not stop actions from running: the cost
 * of a lost ledger is a repeated notification, and the cost of refusing to run
 * is a save that silently does nothing it was configured to do.
 */
function readLedger(): Ledger {
  try {
    const parsed: unknown = JSON.parse(readFileSync(ledgerPath(), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return emptyLedger()
    const record = parsed as Record<string, unknown>
    if (record.version !== 1 || typeof record.packs !== 'object' || record.packs === null) {
      return emptyLedger()
    }
    const packs: Record<string, string[]> = {}
    for (const [packId, keys] of Object.entries(record.packs as Record<string, unknown>)) {
      if (!Array.isArray(keys)) continue
      packs[packId] = keys.filter((key): key is string => typeof key === 'string')
    }
    return { version: 1, packs }
  } catch {
    return emptyLedger()
  }
}

function writeLedger(ledger: Ledger): void {
  try {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    // Written beside the target and renamed, so a crash mid-write cannot leave
    // a truncated ledger that reads as "nothing has been done".
    const target = ledgerPath()
    const temporary = `${target}.tmp`
    writeFileSync(temporary, JSON.stringify(ledger), 'utf8')
    renameSync(temporary, target)
  } catch (error) {
    // A ledger that cannot be written costs a duplicate later. It must not cost
    // the save, and it must not be silent.
    logError('[actions] could not write the idempotency ledger:', error)
  }
}

function completedKeysFor(packId: string): ReadonlySet<string> {
  return new Set(readLedger().packs[packId] ?? [])
}

function recordCompleted(packId: string, keys: readonly string[]): void {
  if (keys.length === 0) return
  const ledger = readLedger()
  const existing = ledger.packs[packId] ?? []
  ledger.packs[packId] = [...new Set([...existing, ...keys])]
  const packIds = Object.keys(ledger.packs)
  if (packIds.length > LEDGER_MAX_PACKS) {
    for (const stale of packIds.slice(0, packIds.length - LEDGER_MAX_PACKS)) {
      delete ledger.packs[stale]
    }
  }
  writeLedger(ledger)
}

/**
 * Forget everything recorded for one pack, so its actions may run again.
 *
 * This is what "re-runnable later against any saved pack" needs: the ledger
 * exists to stop an ACCIDENTAL duplicate, not to overrule a user who asked for
 * the action to happen again.
 */
export function clearPackLedger(packId: string): void {
  const ledger = readLedger()
  if (ledger.packs[packId] === undefined) return
  delete ledger.packs[packId]
  writeLedger(ledger)
}

// ── Secrets ────────────────────────────────────────────────────────────────
//
// GOAL.md: "Tokens and passwords never enter the pack — Windows Credential
// Manager or Electron safeStorage."

function secretsPath(): string {
  return path.join(app.getPath('userData'), 'action-secrets.json')
}

/**
 * Store one action configuration's secret, encrypted by the OS.
 *
 * When the platform cannot encrypt, the secret is NOT written in the clear and
 * the caller is told. A plaintext token on disk is worse than an action the
 * user has to configure again.
 */
export function storeActionSecret(configId: string, secret: string): boolean {
  if (!safeStorage.isEncryptionAvailable()) {
    logError('[actions] refusing to store a secret: OS encryption is unavailable')
    return false
  }
  try {
    const store = readSecretStore()
    store[configId] = safeStorage.encryptString(secret).toString('base64')
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(secretsPath(), JSON.stringify(store), 'utf8')
    return true
  } catch (error) {
    logError('[actions] could not store the action secret:', error)
    return false
  }
}

function readSecretStore(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(secretsPath(), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

function readActionSecret(configId: string): string | null {
  const encoded = readSecretStore()[configId]
  if (encoded === undefined) return null
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
  } catch (error) {
    logError('[actions] could not decrypt an action secret:', error)
    return null
  }
}

/** Whether a configuration has a stored secret, without revealing it. */
export function hasActionSecret(configId: string): boolean {
  return readSecretStore()[configId] !== undefined
}

export function forgetActionSecret(configId: string): void {
  try {
    const store = readSecretStore()
    if (store[configId] === undefined) return
    delete store[configId]
    writeFileSync(secretsPath(), JSON.stringify(store), 'utf8')
  } catch (error) {
    logError('[actions] could not forget an action secret:', error)
  }
}

// ── Registry ───────────────────────────────────────────────────────────────

/**
 * The actions this build offers.
 *
 * One, deliberately. GOAL.md is explicit that Jira, Redmine, Slack, email,
 * Unreal and Unity are not Core's job; the webhook is the reference the public
 * contract is proven against.
 */
export function installedActions(): readonly ActionManifest[] {
  return [WEBHOOK_MANIFEST]
}

export function findAction(actionId: string): ActionManifest | undefined {
  return installedActions().find((manifest) => manifest.id === actionId)
}

/** Per-configuration settings the built-in webhook needs beyond ActionConfig. */
export interface WebhookSettings {
  url: string
}

export interface ActionRunRequest {
  packDir: string
  packId: string
  packState: PackState
  configs: readonly ActionConfig[]
  /** configId -> webhook settings, for configurations of the built-in webhook. */
  webhooks: Readonly<Record<string, WebhookSettings>>
}

function stepsFor(request: ActionRunRequest): PipelineStep[] {
  const steps: PipelineStep[] = []
  for (const config of request.configs) {
    const manifest = findAction(config.actionId)
    // A configuration naming an action this build does not have is not an
    // error to surface at save time — it is a configuration written by a newer
    // build, or by hand. It is dropped, and said so once in the log.
    if (manifest === undefined) {
      logInfo(`[actions] no installed action named ${config.actionId}; its configuration is ignored`)
      continue
    }
    steps.push({ manifest, config })
  }
  return steps
}

function executorFor(request: ActionRunRequest) {
  return async (step: PipelineStep): Promise<void> => {
    if (step.manifest.id !== WEBHOOK_ACTION_ID) {
      throw new Error(`no runner for action ${step.manifest.id}`)
    }
    const settings = request.webhooks[step.config.configId]
    if (settings === undefined || settings.url === '') {
      throw new Error('no webhook URL is configured')
    }
    if (!isAcceptableWebhookUrl(settings.url)) {
      throw new Error('the webhook URL must be https, or http on this machine')
    }
    await deliverWebhook(request.packDir, {
      url: settings.url,
      secret: readActionSecret(step.config.configId),
      timeoutMs: step.config.timeoutMs,
    })
  }
}

const realClock = {
  now: () => Date.now(),
  delay: (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms)
    }),
}

/**
 * Run the configured pipeline for one saved pack.
 *
 * Never rejects. The caller is a save that has already finished, and an
 * exception escaping here would turn a pack that is safely on disk into a
 * failure the user sees.
 */
export async function runActionsForPack(request: ActionRunRequest): Promise<readonly ActionResult[]> {
  const steps = stepsFor(request)
  if (steps.length === 0) return []
  try {
    const run = await runPipeline({
      packId: request.packId,
      packState: request.packState,
      steps,
      completedKeys: completedKeysFor(request.packId),
      execute: executorFor(request),
      clock: realClock,
    })
    recordCompleted(request.packId, run.newCompletedKeys)
    for (const result of run.results) {
      logInfo(
        `[actions] ${result.actionId} ${result.outcome}`
          + ` (${String(result.attempts)} attempt(s), ${String(result.durationMs)} ms)`
          + (result.message === undefined ? '' : ` — ${result.message}`),
      )
    }
    return run.results
  } catch (error) {
    // runPipeline is written not to reject; this is the belt for the braces.
    logError('[actions] the pipeline itself failed:', error)
    return []
  }
}

/**
 * Run one configuration again, on the user's explicit request.
 *
 * The ledger entry for exactly this key is dropped first: the user pressing
 * Retry is the answer to "should this happen again", and the whole point of
 * offering the button is that it does something.
 */
export async function retryAction(
  request: ActionRunRequest,
  configId: string,
): Promise<ActionResult | null> {
  const config = request.configs.find((candidate) => candidate.configId === configId)
  if (config === undefined) return null
  const manifest = findAction(config.actionId)
  if (manifest === undefined) return null

  const ledger = readLedger()
  const keys = ledger.packs[request.packId]
  if (keys !== undefined) {
    const key = idempotencyKey(request.packId, manifest.id, configId)
    const remaining = keys.filter((candidate) => candidate !== key)
    if (remaining.length !== keys.length) {
      ledger.packs[request.packId] = remaining
      writeLedger(ledger)
    }
  }

  const results = await runActionsForPack({ ...request, configs: [config] })
  return results[0] ?? null
}
