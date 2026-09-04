// The one reference After Save Action: an HTTP webhook (#68).
//
// GOAL.md: "Ship ONE reference action, HTTP webhook or custom script. Jira,
// Redmine, Slack, email, Unreal and Unity are explicitly not Core's job."
//
// The webhook is the one of the two that can be shipped without also shipping a
// way to run arbitrary programs on the user's machine, and it is the shape every
// internal tool integration actually wants.
//
// WHAT IT SENDS IS A NOTIFICATION, NOT THE PACK. A summary read out of the
// saved manifest plus the folder path — no media, no annotations, no timeline,
// no structured capture context. An action that wanted to upload the evidence
// itself would be a different action with different permissions, and the user
// would have to be told in those words.

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  BUILTIN_WEBHOOK_ACTION_ID,
  BUILTIN_WEBHOOK_MANIFEST,
  isAcceptableWebhookUrl,
} from '../../shared/actions'

export { isAcceptableWebhookUrl }

// The manifest lives in the contract so the Settings renderer can read it too.
export const WEBHOOK_ACTION_ID = BUILTIN_WEBHOOK_ACTION_ID
export const WEBHOOK_MANIFEST = BUILTIN_WEBHOOK_MANIFEST

export interface WebhookDelivery {
  url: string
  /** Optional bearer-style secret. Never read from or written to the pack. */
  secret: string | null
  timeoutMs: number
}

interface PackSummary {
  packId: string
  packName: string
  packPath: string
  createdAt: string | null
  captureKind: string | null
  displayCount: number | null
  appVersion: string | null
}

/**
 * Read the pack's own manifest for the summary.
 *
 * Anything missing is reported as null rather than guessed. A webhook payload
 * that invents a field is a payload someone downstream will trust.
 */
export async function readPackSummary(packDir: string): Promise<PackSummary> {
  const manifestPath = path.join(packDir, 'manifest.json')
  const raw = await readFile(manifestPath, 'utf8')
  const parsed: unknown = JSON.parse(raw)
  const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  const media = typeof record.media === 'object' && record.media !== null
    ? (record.media as Record<string, unknown>)
    : {}
  const displays = Array.isArray(media.displays) ? media.displays : null
  const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null)
  return {
    packId: asString(record.id) ?? '',
    packName: path.basename(packDir),
    packPath: packDir,
    createdAt: asString(record.created_at),
    captureKind: asString(record.capture_kind),
    displayCount: displays === null ? null : displays.length,
    appVersion: asString(record.app_version),
  }
}

/**
 * POST the summary.
 *
 * Throws on anything that is not a 2xx, with the status in the message, because
 * that message is what the save screen shows next to the Retry button. "Failed"
 * with no status is a row the user cannot act on.
 */
export async function deliverWebhook(packDir: string, delivery: WebhookDelivery): Promise<void> {
  const summary = await readPackSummary(packDir)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'CapturePack',
  }
  if (delivery.secret !== null && delivery.secret !== '') {
    headers.authorization = `Bearer ${delivery.secret}`
  }

  // The pipeline already races this against the configured timeout, but an
  // abandoned fetch would go on holding a socket. The signal makes the abandon
  // real rather than merely unobserved.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), delivery.timeoutMs)
  let response: Response
  try {
    response = await fetch(delivery.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ event: 'capturepack.pack.saved', pack: summary }),
      signal: controller.signal,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`could not reach the webhook: ${message}`)
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    throw new Error(`the webhook answered ${String(response.status)} ${response.statusText}`)
  }
}

