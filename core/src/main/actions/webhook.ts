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
  /** The writing application's version, from manifest.generator.version. */
  appVersion: string | null
  /** The pack FORMAT version, which moves independently of the app's. */
  formatVersion: string | null
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
  // THE VERSION IS UNDER generator, NOT AT THE TOP LEVEL.
  //
  // This read `record.app_version` and shipped null to a real receiver in the
  // end-to-end test. SPEC §5 puts the writing tool in `generator`, and there is
  // no top-level app version at all — a field name that looked obvious and did
  // not exist, which is the whole reason the summary is read back from a pack
  // that was actually written rather than from the type that describes it.
  const generator = typeof record.generator === 'object' && record.generator !== null
    ? (record.generator as Record<string, unknown>)
    : {}
  const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null)
  return {
    packId: asString(record.id) ?? '',
    packName: path.basename(packDir),
    packPath: packDir,
    createdAt: asString(record.created_at),
    captureKind: asString(record.capture_kind),
    displayCount: displays === null ? null : displays.length,
    appVersion: asString(generator.version),
    formatVersion: asString(record.format_version),
  }
}

/**
 * Strip `user:password@` out of any URL quoted in an error message.
 *
 * The contract refuses a URL with credentials in it, so this should never
 * have anything to do. It exists for the day it does: fetch quotes the whole
 * URL when it rejects one, and a message from here is written to the log and
 * shown in the notification, retried and written again (#173).
 */
export function redactUrlCredentials(message: string): string {
  return message.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu, '$1<redacted>@')
}

/**
 * Whether an error raised during delivery was caused by an HTTP redirect (#172).
 *
 * With `redirect: 'error'`, the Fetch Standard treats encountering a redirect
 * status (301, 302, 303, 307, 308) as a network error. In Node's undici, this
 * throws a TypeError with `cause: Error: unexpected redirect`.
 */
function isRedirectError(error: unknown): boolean {
  if (error instanceof Error) {
    if (/redirect/i.test(error.message)) return true
    const cause = (error as { cause?: unknown }).cause
    if (cause instanceof Error && /redirect/i.test(cause.message)) return true
    if (typeof cause === 'string' && /redirect/i.test(cause)) return true
  } else if (typeof error === 'string') {
    if (/redirect/i.test(error)) return true
  }
  return false
}

/**
 * POST the summary.
 *
 * Throws on anything that is not a 2xx, with the status in the message, because
 * that message is what the save screen shows next to the Retry button. "Failed"
 * with no status is a row the user cannot act on.
 *
 * Redirects are refused (`redirect: 'error'`). Following redirects can downgrade
 * HTTPS to plaintext HTTP, expose Authorization secrets to third parties, or
 * mutate POST to GET, violating the action's URL security policy (#172).
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
      redirect: 'error',
    })
  } catch (error) {
    if (isRedirectError(error)) {
      throw new Error('the webhook responded with an unsupported redirect')
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`could not reach the webhook: ${redactUrlCredentials(message)}`)
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    if (response.status >= 300 && response.status < 400) {
      throw new Error('the webhook responded with an unsupported redirect')
    }
    throw new Error(`the webhook answered ${String(response.status)} ${response.statusText}`)
  }
}
