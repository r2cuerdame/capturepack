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

// THERE IS NO RETRY BUDGET ANY MORE (#80). registerCaptureHotkeyWithin() kept
// retrying for a few seconds because, while CapturePack was not running, its
// accelerator was held by Explorer on behalf of the Start Menu fallback
// shortcut — and Explorer only lets go a second or two AFTER that .lnk is
// deleted. Calling that window a conflict would have been a lie about the app's
// own fallback. The fallback went with the watchdog, so nobody but another
// application can be holding the key: a refusal is a conflict, first try, and
// is reported as one immediately.

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
