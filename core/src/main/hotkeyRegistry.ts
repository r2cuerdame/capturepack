export type HotkeyKind = 'video' | 'image'

export interface ShortcutBackend {
  register(accelerator: string, handler: () => void): boolean
  unregister(accelerator: string): void
}

// Electron accelerator modifier aliases, folded onto the one modifier each
// names (Electron's accelerator parser). CommandOrControl is Ctrl everywhere
// but macOS; Command/Cmd is the Super/Meta key off macOS.
function modifierOf(token: string, platform: string): string | null {
  switch (token) {
    case 'ctrl':
    case 'control':
      return 'ctrl'
    case 'commandorcontrol':
    case 'cmdorctrl':
      return platform === 'darwin' ? 'super' : 'ctrl'
    case 'command':
    case 'cmd':
    case 'super':
    case 'meta':
      return 'super'
    case 'alt':
    case 'option':
      return 'alt'
    case 'altgr':
      return 'altgr'
    case 'shift':
      return 'shift'
    default:
      return null
  }
}

// Key names Electron spells two ways.
const KEY_ALIASES: Record<string, string> = { return: 'enter', esc: 'escape' }

/**
 * The key combination an accelerator names, independent of how it is written:
 * modifier aliases folded, modifier order ignored, surrounding whitespace and
 * case dropped. "Alt+Ctrl+C", "Control+Alt+C" and "CommandOrControl+Alt+c" all
 * normalize to the same string. Pure, so the overlap policy stays testable.
 */
export function acceleratorIdentity(
  accelerator: string,
  platform: string = process.platform,
): string {
  const modifiers = new Set<string>()
  const keys: string[] = []
  for (const part of accelerator.split('+')) {
    const token = part.trim().toLowerCase()
    const modifier = modifierOf(token, platform)
    if (modifier !== null) modifiers.add(modifier)
    else keys.push(KEY_ALIASES[token] ?? token)
  }
  return [...[...modifiers].sort(), ...keys].join('+')
}

/**
 * Owns CapturePack's two global shortcuts independently.
 *
 * Keeping this policy outside Electron makes the failure path testable: a
 * rejected video shortcut must never unregister the image shortcut, and vice
 * versa. Settings may then roll only the failed action back to its previous
 * accelerator.
 */
export class HotkeyRegistry {
  private readonly registered = new Map<HotkeyKind, string>()

  constructor(
    private readonly backend: ShortcutBackend,
    private readonly platform: string = process.platform,
  ) {}

  register(kind: HotkeyKind, accelerator: string, handler: () => void): boolean {
    const previous = this.registered.get(kind)
    if (previous !== undefined) {
      this.backend.unregister(previous)
      this.registered.delete(kind)
    }
    // Two CapturePack actions cannot own the same accelerator. Electron may
    // report it as registered globally, so reject it explicitly before asking
    // the OS and leave only the changed action unbound. Compare the key
    // combination, not the spelling: settings.json may name the same keys with
    // other aliases or in another order than the settings recorder writes.
    const identity = acceleratorIdentity(accelerator, this.platform)
    for (const [otherKind, other] of this.registered) {
      if (otherKind !== kind && acceleratorIdentity(other, this.platform) === identity) return false
    }
    let ok = false
    try {
      ok = this.backend.register(accelerator, handler)
    } catch {
      ok = false
    }
    if (ok) this.registered.set(kind, accelerator)
    return ok
  }

  current(kind: HotkeyKind): string | null {
    return this.registered.get(kind) ?? null
  }
}
