// Firing the After Save Action pipeline at the moments a pack changes state
// (#68), and telling the user by name when one fails.
//
// Two call sites, both in session.ts, both chosen because they are where the
// pack genuinely reaches a state rather than where it is convenient to call:
//
//   source-ready            immediately after notePackSaved() — the line the
//                           save flow itself documents as "everything above
//                           this is what saved means"
//   annotated-replay-ready  when the derived render reports 'done'
//
// Actions blocked at the first moment are simply run again at the second. That
// is cheaper and more honest than a queue: decideStep already refuses to repeat
// an idempotent action that succeeded, so re-running the pipeline is how a
// blocked step gets its second chance.

import { Notification } from 'electron'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ActionResult, PackState } from '../../shared/actions'
import type { Settings } from '../../shared/types'
import { uiT, uiLanguage } from '../locale'
import { logError, logInfo } from '../log'
import { findAction, runActionsForPack } from './host'

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

/**
 * Run the configured pipeline for a pack that has just reached `packState`.
 *
 * Never rejects and never throws: the save is finished, and an action is not
 * allowed to turn a pack that is safely on disk into an error the user sees.
 */
export async function runActionsAtState(
  packDir: string,
  packState: PackState,
  settings: Settings,
): Promise<readonly ActionResult[]> {
  const configs = settings.actionConfigs.filter((config) => config.enabled)
  if (configs.length === 0) return []
  try {
    const packId = await packIdOf(packDir)
    if (packId === null) return []
    logInfo(`[actions] ${path.basename(packDir)} reached ${packState}; ${String(configs.length)} configured`)
    const results = await runActionsForPack({
      packDir,
      packId,
      packState,
      configs,
      webhooks: settings.actionWebhooks,
    })
    announceFailures(results, settings)
    return results
  } catch (error) {
    logError('[actions] the after-save pipeline failed:', error)
    return []
  }
}
