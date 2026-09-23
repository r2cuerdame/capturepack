// Firing the After Save Action pipeline at the moments a pack changes state
// (#68, #169), and telling the user by name when one fails.
//
// Call sites in session.ts are chosen because they are where the pack
// genuinely reaches a state rather than where it is convenient to call:
//
//   source-ready            immediately after notePackSaved() — the line the
//                           save flow itself documents as "everything above
//                           this is what saved means"
//   annotated-replay-ready  when the derived render reports 'done'
//   complete                when background derived processing settles
//
// Actions blocked at earlier moments receive their second chance when their
// required pack state arrives (#68, #169).
//
// Crucially, only previously BLOCKED actions are re-run on subsequent pack
// state transitions. Actions that already attempted and failed (or timed out)
// are NOT automatically re-executed on subsequent pack state transitions:
// failed actions are retried exclusively on explicit user request (retryAction),
// preventing duplicate executions and repeated failure notifications (#169).

import { Notification } from 'electron'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ActionResult, PackState } from '../../shared/actions'
import { SaveActionLifecycle } from '../../shared/actionPipeline'
import type { Settings } from '../../shared/types'
import { uiT, uiLanguage } from '../locale'
import { logError, logInfo } from '../log'
import { findAction, readActionResults, runActionsForPack } from './host'
import { updateToastActionResults } from '../saveToast'

export { readActionResults } from './host'

/**
 * The pack's own UUID, which is half the idempotency key.
 *
 * Read from the saved manifest rather than derived from the folder name: a pack
 * that is moved or renamed is the same pack. A manifest that cannot be read
 * means no actions run, because an action keyed on a guessed id could duplicate
 * against the real one later.
 */
async function packIdOf(packDir: string): Promise<string | null> {
  try {
    const raw = await readFile(path.join(packDir, 'manifest.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const id = (parsed as Record<string, unknown>).id
    return typeof id === 'string' && id !== '' ? id : null
  } catch (error) {
    logError('[actions] could not read the pack id; no action will run for this pack:', error)
    return null
  }
}

function announceFailures(results: readonly ActionResult[], settings: Settings): void {
  const failures = results.filter(
    (result) => result.outcome === 'failed' || result.outcome === 'timed-out',
  )
  if (failures.length === 0) return
  // NAMED, NEXT TO A PACK THAT IS ALREADY SAFE.
  //
  // GOAL.md's whole argument for opening this side of the plugin system is that
  // an action's failure lands honestly on whoever wrote it: "✕ Jira failed —
  // named, retryable, pack already safe". A notification that said "an action
  // failed" would put it back on CapturePack.
  const names = failures
    .map((failure) => findAction(failure.actionId)?.name ?? failure.actionId)
    .join(', ')
  try {
    new Notification({
      title: 'CapturePack', // product name — never translated
      body: uiT(settings)('actions.failed', { names }),
    }).show()
  } catch (error) {
    logError('[actions] could not show the action failure notice:', error)
  }
  void uiLanguage
}

const MAX_REMEMBERED_PACKS = 1_000

/**
 * packId -> SaveActionLifecycle tracker.
 *
 * Remembers which actions were blocked waiting for a later pack state.
 * Insertion order is age order, bounded to MAX_REMEMBERED_PACKS just like
 * the host idempotency ledger.
 */
const sessionsByPack = new Map<string, SaveActionLifecycle>()

/** In-flight transition execution promise per pack, to serialize runs. */
const inFlightByPack = new Map<string, Promise<readonly ActionResult[]>>()

function sessionFor(packId: string): SaveActionLifecycle {
  let session = sessionsByPack.get(packId)
  if (session === undefined) {
    session = new SaveActionLifecycle()
    sessionsByPack.set(packId, session)
    if (sessionsByPack.size > MAX_REMEMBERED_PACKS) {
      const oldest = sessionsByPack.keys().next().value
      if (oldest !== undefined) {
        sessionsByPack.delete(oldest)
      }
    }
  }
  return session
}

/**
 * Reset the in-memory save action lifecycle sessions.
 *
 * Intended for test isolation and clean slate verification.
 */
export function clearSaveActionSessions(): void {
  sessionsByPack.clear()
  inFlightByPack.clear()
}

/**
 * Run the configured pipeline for a pack that has just reached `packState`.
 *
 * Never rejects and never throws: the save is finished, and an action is not
 * allowed to turn a pack that is safely on disk into an error the user sees.
 *
 * On subsequent pack state transitions (annotated-replay-ready, complete),
 * only actions that were previously blocked waiting for a later pack state
 * receive their second chance. Actions that already attempted and failed are
 * not re-run automatically (#169).
 */
export async function runActionsAtState(
  packDir: string,
  packState: PackState,
  settings: Settings,
): Promise<readonly ActionResult[]> {
  const allConfigs = settings.actionConfigs
  if (allConfigs.length === 0) return []
  try {
    const packId = await packIdOf(packDir)
    if (packId === null) return []

    // If an earlier state transition for this pack is currently executing,
    // wait for it to settle before evaluating which actions were blocked.
    const inFlight = inFlightByPack.get(packId)
    if (inFlight !== undefined) {
      await inFlight.catch(() => {})
    }

    const session = sessionFor(packId)
    const configs = session.filterConfigs(allConfigs)
    if (configs.length === 0) return []

    logInfo(`[actions] ${path.basename(packDir)} reached ${packState}; ${String(configs.length)} configured`)
    const runPromise = runActionsForPack({
      packDir,
      packId,
      packState,
      configs,
      webhooks: settings.actionWebhooks,
    })

    inFlightByPack.set(packId, runPromise)
    let results: readonly ActionResult[] = []
    try {
      results = await runPromise
    } finally {
      if (inFlightByPack.get(packId) === runPromise) {
        inFlightByPack.delete(packId)
      }
    }

    session.recordResults(results)
    announceFailures(results, settings)
    updateToastActionResults(packDir, results)
    return results
  } catch (error) {
    logError('[actions] the after-save pipeline failed:', error)
    return []
  }
}
