export type HotkeyKind = 'video' | 'image'

export interface ShortcutBackend {
  register(accelerator: string, handler: () => void): boolean
  unregister(accelerator: string): void
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

  constructor(private readonly backend: ShortcutBackend) {}

  register(kind: HotkeyKind, accelerator: string, handler: () => void): boolean {
    const previous = this.registered.get(kind)
    if (previous !== undefined) {
      this.backend.unregister(previous)
      this.registered.delete(kind)
    }
    // Two CapturePack actions cannot own the same accelerator. Electron may
    // report it as registered globally, so reject it explicitly before asking
    // the OS and leave only the changed action unbound.
    for (const [otherKind, other] of this.registered) {
      if (otherKind !== kind && other.toLowerCase() === accelerator.toLowerCase()) return false
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
