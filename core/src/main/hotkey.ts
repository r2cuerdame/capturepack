// The one global capture accelerator (GOAL "Settings GUI" > Capture). Both
// registration sites go through here — startup in index.ts and the instant
// re-register the settings GUI performs — so exactly one accelerator is ever
// held: registering always releases the previous one first.
import { globalShortcut } from 'electron'

let registered: string | null = null

/**
 * Registers `accelerator` as the capture hotkey, releasing the previously
 * registered one first. Returns false when the OS refuses it (another app owns
 * the combination) or Electron rejects the syntax — the caller then reports the
 * conflict and, in the settings flow, re-registers the accelerator that worked.
 */
export function registerCaptureHotkey(accelerator: string, handler: () => void): boolean {
  if (registered !== null) {
    globalShortcut.unregister(registered)
    registered = null
  }
  let ok = false
  try {
    ok = globalShortcut.register(accelerator, handler)
  } catch {
    // A malformed accelerator throws instead of returning false; to every
    // caller that is the same outcome as a refused registration.
    ok = false
  }
  if (ok) registered = accelerator
  return ok
}

/**
 * The accelerator currently HELD by the app, or null when none is (a refused
 * registration leaves the app hotkey-less while settings.json still names the
 * configured combination). The settings flow compares against this instead of
 * against the previous VALUE, so re-recording the same accelerator after the
 * conflicting app is gone can take it back.
 */
export function currentCaptureHotkey(): string | null {
  return registered
}
