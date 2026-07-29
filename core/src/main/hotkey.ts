// The global capture accelerators (video context and explicit image capture).
// Each registration site goes through this module, so changing one shortcut
// releases only its own old accelerator and can never silently disable the
// other.
import { globalShortcut } from 'electron'
import { HotkeyRegistry } from './hotkeyRegistry'

const hotkeys = new HotkeyRegistry(globalShortcut)

/**
 * Registers `accelerator` as the capture hotkey, releasing the previously
 * registered one first. Returns false when the OS refuses it (another app owns
 * the combination) or Electron rejects the syntax — the caller then reports the
 * conflict and, in the settings flow, re-registers the accelerator that worked.
 */
export function registerCaptureHotkey(accelerator: string, handler: () => void): boolean {
  return hotkeys.register('video', accelerator, handler)
}

/** Registers the explicit image/region capture shortcut independently. */
export function registerImageCaptureHotkey(
  accelerator: string,
  handler: () => void,
): boolean {
  return hotkeys.register('image', accelerator, handler)
}

/**
 * Registers `accelerator`, retrying for up to `budgetMs` before reporting
 * failure.
 *
 * The budget exists for exactly one reason (issue #61): while CapturePack is
 * not running, its accelerator is held by Explorer on behalf of the Start Menu
 * fallback shortcut, and Explorer only lets go a second or two AFTER that
 * shortcut is deleted. A registration attempted inside that window fails for a
 * reason that is not a conflict, and reporting "another application holds it"
 * there would be a lie about the app's own fallback. With no fallback in play
 * the caller passes 0 and this is exactly registerCaptureHotkey().
 */
export async function registerCaptureHotkeyWithin(
  accelerator: string,
  handler: () => void,
  budgetMs: number,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if (registerCaptureHotkey(accelerator, handler)) return true
    if (Date.now() >= deadline) return false
    await delay(RETRY_INTERVAL_MS)
  }
}

// Long enough not to spin, short enough that a successful handover is invisible.
const RETRY_INTERVAL_MS = 400

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The accelerator currently HELD by the app, or null when none is (a refused
 * registration leaves the app hotkey-less while settings.json still names the
 * configured combination). The settings flow compares against this instead of
 * against the previous VALUE, so re-recording the same accelerator after the
 * conflicting app is gone can take it back.
 */
export function currentCaptureHotkey(): string | null {
  return hotkeys.current('video')
}

/** The image capture accelerator currently held by the app. */
export function currentImageCaptureHotkey(): string | null {
  return hotkeys.current('image')
}
