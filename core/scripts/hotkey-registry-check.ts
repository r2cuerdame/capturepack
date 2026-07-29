import { HotkeyRegistry } from '../src/main/hotkeyRegistry'
import type { ShortcutBackend } from '../src/main/hotkeyRegistry'

class FakeBackend implements ShortcutBackend {
  readonly handlers = new Map<string, () => void>()
  readonly refused = new Set<string>()
  readonly throws = new Set<string>()

  register(accelerator: string, handler: () => void): boolean {
    if (this.throws.has(accelerator)) throw new Error('invalid accelerator')
    if (this.refused.has(accelerator) || this.handlers.has(accelerator)) return false
    this.handlers.set(accelerator, handler)
    return true
  }

  unregister(accelerator: string): void {
    this.handlers.delete(accelerator)
  }
}

let passed = 0
let failed = 0
function check(name: string, condition: boolean): void {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`)
  if (condition) passed += 1
  else failed += 1
}

const backend = new FakeBackend()
const registry = new HotkeyRegistry(backend)
const noop = (): void => undefined

check('video shortcut registers', registry.register('video', 'Ctrl+Alt+C', noop))
check('image shortcut registers independently', registry.register('image', 'Ctrl+Alt+S', noop))
check(
  'both shortcuts are live together',
  backend.handlers.has('Ctrl+Alt+C') &&
    backend.handlers.has('Ctrl+Alt+S') &&
    registry.current('video') === 'Ctrl+Alt+C' &&
    registry.current('image') === 'Ctrl+Alt+S',
)

check('changing video succeeds', registry.register('video', 'Ctrl+Shift+C', noop))
check(
  'changing video releases only the old video shortcut',
  !backend.handlers.has('Ctrl+Alt+C') &&
    backend.handlers.has('Ctrl+Shift+C') &&
    backend.handlers.has('Ctrl+Alt+S'),
)

check(
  'image cannot steal the video accelerator case-insensitively',
  !registry.register('image', 'ctrl+shift+c', noop),
)
check(
  'a rejected image change cannot disable video',
  backend.handlers.has('Ctrl+Shift+C') &&
    registry.current('video') === 'Ctrl+Shift+C' &&
    registry.current('image') === null,
)
check('settings can restore only the prior image shortcut', registry.register('image', 'Ctrl+Alt+S', noop))

backend.refused.add('Ctrl+Alt+V')
check('an OS-refused video change is reported', !registry.register('video', 'Ctrl+Alt+V', noop))
check(
  'an OS-refused video change leaves image live',
  backend.handlers.has('Ctrl+Alt+S') && registry.current('image') === 'Ctrl+Alt+S',
)
check('settings can restore only the prior video shortcut', registry.register('video', 'Ctrl+Shift+C', noop))

backend.throws.add('not an accelerator')
check(
  'invalid Electron accelerator syntax is contained',
  !registry.register('image', 'not an accelerator', noop),
)
check(
  'invalid image syntax still leaves video live',
  backend.handlers.has('Ctrl+Shift+C') && registry.current('video') === 'Ctrl+Shift+C',
)

console.log(`\n${passed}/${passed + failed} hotkey registry checks passed.`)
if (failed > 0) process.exitCode = 1
