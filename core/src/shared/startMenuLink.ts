// The Start Menu shortcut that answers the hotkey when CapturePack is not
// running (issue #61, "make the keystroke stop being a black hole").
//
// A user pressed Ctrl+Alt+C, got nothing, and concluded the app was not
// installed. Nothing was registered because nothing was alive — and no code
// inside a dead process can fix that. Explorer, however, never dies: it
// registers the shortcut key stored on a .lnk in the user's Start Menu and
// launches the target when it is pressed. So the LAST line of defence lives
// outside the app entirely.
//
// This module is deliberately electron-free: the main process arms/disarms the
// shortcut, and so does the plain-node watchdog (src/watchdog/watchdog.ts),
// which is the only component still alive at the moment the app dies.
//
// MEASURED BEHAVIOUR (probes run against Windows 11 26200 while building this;
// no key was ever pressed — ownership was read by attempting RegisterHotKey and
// looking for ERROR_HOTKEY_ALREADY_REGISTERED, 1409):
//
//   1. A .lnk saved into Start Menu\Programs with a Hotkey is registered by
//      Explorer within ~4s: RegisterHotKey then fails with 1409.
//   2. Clearing that Hotkey through WScript.Shell and saving RELEASES it.
//   3. DELETING the .lnk also releases it.
//   4. Patching the HotKey WORD in the .lnk binary in place does NOT release
//      it — Explorer never notices the write.
//   5. Copying a ready-made .lnk into Start Menu\Programs does NOT arm it —
//      Explorer never notices the new file either.
//
// (4) and (5) are why arming goes through the shell (WScript.Shell.Save fires
// the shell change notification Explorer listens to) while disarming is a plain
// file delete: those are exactly the two operations Windows was observed to
// honor.

/** Everything needed to (re)write the fallback shortcut. */
export interface StartMenuLinkSpec {
  /** Full path of the .lnk inside the user's Start Menu\Programs folder. */
  linkPath: string
  /** Executable Explorer launches — CapturePack.exe (electron.exe in dev). */
  target: string
  /** Command line the target receives; always carries CAPTURE_ARG. */
  arguments: string
  /** WScript.Shell hotkey syntax, e.g. "CTRL+ALT+C". */
  hotkey: string
  /** Shown in the Start Menu tooltip. */
  description: string
  /** Working directory for the launched process. */
  workingDirectory: string
}

/**
 * The argument the fallback shortcut passes. A launch carrying it is a HOTKEY
 * PRESS, not a user double-clicking CapturePack in the Start Menu — the running
 * instance may therefore capture on it, while a bare second launch must not.
 */
export const CAPTURE_ARG = '--capture'

// Windows' own rule for shortcut keys: Ctrl or Alt has to be in the
// combination (Shift alone is not accepted, and the Windows key cannot be
// expressed in a .lnk at all). An accelerator we cannot express is not
// mirrored — silently registering a DIFFERENT key would be worse than having
// no fallback, because the user would never learn which one to press.
const CTRL_TOKENS = new Set(['ctrl', 'control', 'commandorcontrol', 'cmdorctrl', 'command', 'cmd'])
const ALT_TOKENS = new Set(['alt', 'option'])
const SHIFT_TOKENS = new Set(['shift'])

/**
 * Translates an Electron accelerator ("Ctrl+Alt+C") into the WScript.Shell
 * hotkey syntax ("CTRL+ALT+C"), or null when Windows cannot hold it on a .lnk.
 *
 * `Command`/`Cmd` map to CTRL here rather than being rejected: CapturePack is
 * Windows-only today, and Electron treats them as Control on Windows — so a
 * profile carrying the macOS spelling still gets its fallback.
 */
export function lnkHotkeyFromAccelerator(accelerator: string): string | null {
  const parts = accelerator.split('+').map((part) => part.trim())
  if (parts.length < 2) return null
  let ctrl = false
  let alt = false
  let shift = false
  let key: string | null = null
  for (const part of parts) {
    const token = part.toLowerCase()
    if (CTRL_TOKENS.has(token)) {
      ctrl = true
    } else if (ALT_TOKENS.has(token)) {
      alt = true
    } else if (SHIFT_TOKENS.has(token)) {
      shift = true
    } else if (token === 'super' || token === 'meta' || token === 'altgr') {
      // The Windows key and AltGr have no representation in a shortcut key.
      return null
    } else if (key !== null) {
      return null // Two non-modifier keys: not an accelerator we can mirror.
    } else {
      key = lnkKeyName(part)
      if (key === null) return null
    }
  }
  if (key === null) return null
  if (!ctrl && !alt) return null
  const mods: string[] = []
  if (ctrl) mods.push('CTRL')
  if (alt) mods.push('ALT')
  if (shift) mods.push('SHIFT')
  return [...mods, key].join('+')
}

/**
 * The key half of a shortcut key. A .lnk stores a VIRTUAL KEY CODE, so only
 * what a virtual key can name is expressible: letters, digits and F1..F24.
 * Everything else (media keys, punctuation whose VK varies by layout, named
 * keys like PrintScreen) returns null and the fallback is skipped rather than
 * guessed at.
 */
function lnkKeyName(part: string): string | null {
  const upper = part.toUpperCase()
  if (/^[A-Z0-9]$/.test(upper)) return upper
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(upper)) return upper
  return null
}

/**
 * The PowerShell arguments that WRITE the shortcut, hotkey included.
 *
 * Arming has to go through the shell (WScript.Shell.Save fires the change
 * notification Explorer acts on — a plain file copy does not, measured above),
 * and -EncodedCommand is how this codebase already talks to powershell.exe
 * (see uia.ts): it survives every quoting rule and is not governed by
 * execution policy, which applies to script FILES only.
 */
export function armShortcutArgs(spec: StartMenuLinkSpec): string[] {
  const script =
    `$ErrorActionPreference='Stop';` +
    `$d=Split-Path -Parent ${psLiteral(spec.linkPath)};` +
    `if(-not (Test-Path -LiteralPath $d)){New-Item -ItemType Directory -Path $d -Force|Out-Null};` +
    `$s=(New-Object -ComObject WScript.Shell).CreateShortcut(${psLiteral(spec.linkPath)});` +
    `$s.TargetPath=${psLiteral(spec.target)};` +
    `$s.Arguments=${psLiteral(spec.arguments)};` +
    `$s.WorkingDirectory=${psLiteral(spec.workingDirectory)};` +
    `$s.Description=${psLiteral(spec.description)};` +
    `$s.WindowStyle=7;` + // minimized: the fallback must never flash a window
    `$s.Hotkey=${psLiteral(spec.hotkey)};` +
    `$s.Save()`
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
}

// PowerShell's literal string. A path may legitimately contain a single quote
// and doubling it is the escape.
function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
