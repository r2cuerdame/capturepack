// Plugin manifest and the permission model (issue #64).
//
// GOAL.md, "Permissions are declared and shown": a plugin manifest names its
// `type`, `protocol_version`, `entry` and `permissions` FROM A FIXED SET, and
// the user sees them before enabling it. "Anything that sends pack data off the
// machine says so in those words" — which is only true if the set is closed, so
// an unknown permission is a REFUSAL and never a shrug.
//
// Parsing lives in shared/ (not main/) on purpose: the Settings window renders
// the same permission list it is about to ask the user to grant, and a second
// parser is a second answer to "what did this plugin ask for".
//
// { "id": "chrome-dom", "name": "Chrome DOM", "version": "0.1.0",
//   "type": "temporal-context-provider", "protocol_version": "1",
//   "entry": "dist/index.js",
//   "permissions": ["native-messaging", "read-browser-context", "write-plugin-files"] }

import { CONTEXT_PROTOCOL_VERSION, isSupportedProtocolVersion } from './protocol'

/**
 * The FIXED permission set (GOAL.md). Not extensible by a plugin: a manifest
 * naming anything else is refused, because a permission the user was never shown
 * is a permission they never granted.
 */
export type ProviderPermission =
  /** Read the saved pack folder (After Save Actions mostly; a provider rarely needs it). */
  | 'read-pack'
  /** Produce files for `plugins/<id>/`. Core still writes them (protocol GAP 14). */
  | 'write-plugin-files'
  /** Open sockets. The one that means "pack data may leave this machine". */
  | 'network'
  /** Spawn a child process. */
  | 'run-process'
  /** Read browser context (URL, title, DOM) through the extension. */
  | 'read-browser-context'
  /**
   * Read the live UI of other applications — the UI Automation lane.
   *
   * This is what the built-in Windows provider holds, and holding it grants NO
   * ordering, NO priority and NO extra fields (docs/temporal-protocol.md §2.2).
   * If a second provider asks for it, both get it and neither is preferred.
   */
  | 'read-active-window'
  /** Speak Chrome native messaging. */
  | 'native-messaging'
  /** Create a .zip (After Save Actions). */
  | 'create-zip'
  /** Open a URL in the user's browser. */
  | 'open-browser'

export const PROVIDER_PERMISSIONS: readonly ProviderPermission[] = [
  'read-pack',
  'write-plugin-files',
  'network',
  'run-process',
  'read-browser-context',
  'read-active-window',
  'native-messaging',
  'create-zip',
  'open-browser',
]

export function isProviderPermission(value: string): value is ProviderPermission {
  return (PROVIDER_PERMISSIONS as readonly string[]).includes(value)
}

/** A parsed, validated manifest. Every field is present and of the right type. */
export interface ProviderManifest {
  id: string
  name: string
  version: string
  type: 'temporal-context-provider'
  protocolVersion: string
  /** Module path relative to the plugin directory. Empty for a built-in provider. */
  entry: string
  permissions: ProviderPermission[]
}

/**
 * Why a manifest was refused, in a form the log and Settings > Plugins can both
 * print. A refusal ALWAYS names the plugin and the reason: #64 requires an
 * incompatible plugin to be refused with a clear message "rather than
 * half-working", and half of that promise is that the user can tell which.
 */
export type ManifestRefusal =
  | { kind: 'not-json'; detail: string }
  | { kind: 'missing-field'; field: string }
  | { kind: 'bad-id'; id: string }
  | { kind: 'unknown-type'; type: string }
  | { kind: 'protocol-mismatch'; declared: string; supported: string }
  | { kind: 'unknown-permission'; permission: string }

export type ManifestResult =
  | { ok: true; manifest: ProviderManifest }
  | { ok: false; refusal: ManifestRefusal }

/**
 * A plugin id is also a DIRECTORY NAME under `plugins/` in the pack (SPEC §5.4,
 * §11.1), so the pattern that makes it a legal identifier is the same one that
 * makes it path-safe. Deliberately the same shape SPEC §5.4 already requires of
 * a plugin name — the id and the pack directory must not be able to disagree.
 */
const PROVIDER_ID_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

export function describeManifestRefusal(refusal: ManifestRefusal): string {
  switch (refusal.kind) {
    case 'not-json':
      return `manifest is not valid JSON (${refusal.detail})`
    case 'missing-field':
      return `manifest is missing "${refusal.field}"`
    case 'bad-id':
      return `manifest id "${refusal.id}" is not a lowercase dash-separated identifier`
    case 'unknown-type':
      return `manifest type "${refusal.type}" is not a temporal-context-provider`
    case 'protocol-mismatch':
      return (
        `plugin speaks protocol_version "${refusal.declared}", this build speaks ` +
        `"${refusal.supported}" — the temporal provider protocol is explicitly unstable`
      )
    case 'unknown-permission':
      return `manifest asks for the unknown permission "${refusal.permission}"`
  }
}

/**
 * Parses and STRICTLY validates a manifest.
 *
 * Strict on purpose (#64): "keep protocol_version checks strict so an
 * incompatible plugin is refused with a clear message rather than half-working".
 * There is no coercion, no defaulting of a missing type, and no ignoring of an
 * unknown permission — every one of those would produce a plugin that runs and
 * is subtly wrong, which is the failure mode this protocol is least able to
 * diagnose from a user's bug report.
 */
export function parseProviderManifest(text: string): ManifestResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return {
      ok: false,
      refusal: { kind: 'not-json', detail: err instanceof Error ? err.message : String(err) },
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, refusal: { kind: 'not-json', detail: 'not an object' } }
  }
  const raw = parsed as Record<string, unknown>
  const id = stringField(raw, 'id')
  if (id === null) return { ok: false, refusal: { kind: 'missing-field', field: 'id' } }
  if (!PROVIDER_ID_RE.test(id)) return { ok: false, refusal: { kind: 'bad-id', id } }
  const name = stringField(raw, 'name')
  if (name === null) return { ok: false, refusal: { kind: 'missing-field', field: 'name' } }
  const version = stringField(raw, 'version')
  if (version === null) return { ok: false, refusal: { kind: 'missing-field', field: 'version' } }
  const type = stringField(raw, 'type')
  if (type === null) return { ok: false, refusal: { kind: 'missing-field', field: 'type' } }
  if (type !== 'temporal-context-provider') {
    return { ok: false, refusal: { kind: 'unknown-type', type } }
  }
  const protocolVersion = stringField(raw, 'protocol_version')
  if (protocolVersion === null) {
    return { ok: false, refusal: { kind: 'missing-field', field: 'protocol_version' } }
  }
  if (!isSupportedProtocolVersion(protocolVersion)) {
    return {
      ok: false,
      refusal: {
        kind: 'protocol-mismatch',
        declared: protocolVersion,
        supported: CONTEXT_PROTOCOL_VERSION,
      },
    }
  }
  // `entry` is required for an installed plugin and empty for a built-in one,
  // which has no module to load — the field must still be declared, so a
  // built-in's manifest is the same document an external one writes.
  const entry = stringField(raw, 'entry')
  if (entry === null) return { ok: false, refusal: { kind: 'missing-field', field: 'entry' } }
  const rawPermissions = raw['permissions']
  if (!Array.isArray(rawPermissions)) {
    return { ok: false, refusal: { kind: 'missing-field', field: 'permissions' } }
  }
  const permissions: ProviderPermission[] = []
  for (const entryValue of rawPermissions) {
    if (typeof entryValue !== 'string' || !isProviderPermission(entryValue)) {
      return {
        ok: false,
        refusal: { kind: 'unknown-permission', permission: String(entryValue) },
      }
    }
    if (!permissions.includes(entryValue)) permissions.push(entryValue)
  }
  return {
    ok: true,
    manifest: { id, name, version, type, protocolVersion, entry, permissions },
  }
}

function stringField(raw: Record<string, unknown>, field: string): string | null {
  const value = raw[field]
  if (typeof value !== 'string') return null
  // An empty id/name/version is a missing field wearing a costume; `entry` is
  // legitimately empty for a built-in provider and is checked by its caller.
  if (field !== 'entry' && value.trim() === '') return null
  return value
}
