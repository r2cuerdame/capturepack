import { acceleratorIdentity, HotkeyRegistry } from '../src/main/hotkeyRegistry'
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

// #528: the same key combination spelled another way (alias, order, case,
// whitespace) is still the same combination. Like Electron, this backend keys
// its registrations by the combination, so a missed overlap would let the
// second action take the keys and later release them for both.
class CombinationBackend implements ShortcutBackend {
  readonly held = new Map<string, string>()

  register(accelerator: string): boolean {
    this.held.set(acceleratorIdentity(accelerator, 'win32'), accelerator)
    return true
  }

  unregister(accelerator: string): void {
    this.held.delete(acceleratorIdentity(accelerator, 'win32'))
  }
}

check(
  'alias, order, case and whitespace spellings name one combination',
  [
    'Ctrl+Alt+C',
    'Alt+Ctrl+C',
    'Control+Alt+C',
    'CommandOrControl+Alt+C',
    'CmdOrCtrl+Option+C',
    'CTRL+alt+c',
    ' Ctrl + Alt + C ',
  ]
    .map((a) => acceleratorIdentity(a, 'win32'))
    .every((id) => id === acceleratorIdentity('Ctrl+Alt+C', 'win32')),
)
check(
  'Super, Meta, Command and Cmd name one modifier off macOS',
  ['Meta+Shift+K', 'Command+Shift+K', 'Cmd+Shift+K'].every(
    (a) => acceleratorIdentity(a, 'win32') === acceleratorIdentity('Super+Shift+K', 'win32'),
  ),
)
check(
  'CommandOrControl is Ctrl, not Super, off macOS',
  acceleratorIdentity('CommandOrControl+Alt+C', 'win32') !==
    acceleratorIdentity('Super+Alt+C', 'win32'),
)
check(
  'Return and Esc name the Enter and Escape keys',
  acceleratorIdentity('Ctrl+Return', 'win32') === acceleratorIdentity('Ctrl+Enter', 'win32') &&
    acceleratorIdentity('Ctrl+Esc', 'win32') === acceleratorIdentity('Ctrl+Escape', 'win32'),
)

const sameCombination = ['Alt+Ctrl+C', 'Control+Alt+C', 'CommandOrControl+Alt+C', 'CTRL+alt+c']
for (const [held, changed] of [
  ['video', 'image'],
  ['image', 'video'],
] as const) {
  for (const spelling of sameCombination) {
    const combo = new CombinationBackend()
    const reg = new HotkeyRegistry(combo, 'win32')
    reg.register(held, 'Ctrl+Alt+C', noop)
    check(
      `${changed} cannot take ${held}'s Ctrl+Alt+C spelled ${spelling}`,
      !reg.register(changed, spelling, noop),
    )
    check(
      `a rejected ${changed} ${spelling} leaves ${held} registered`,
      reg.current(held) === 'Ctrl+Alt+C' &&
        reg.current(changed) === null &&
        combo.held.get(acceleratorIdentity('Ctrl+Alt+C', 'win32')) === 'Ctrl+Alt+C',
    )
  }
}

{
  const combo = new CombinationBackend()
  const reg = new HotkeyRegistry(combo, 'win32')
  reg.register('video', 'Ctrl+Alt+C', noop)
  check(
    'the same action may re-register its combination spelled another way',
    reg.register('video', 'Alt+Control+c', noop) && reg.current('video') === 'Alt+Control+c',
  )
}

{
  // Startup registers settings.json's video shortcut first, then the image one.
  const combo = new CombinationBackend()
  const reg = new HotkeyRegistry(combo, 'win32')
  const videoOk = reg.register('video', 'CommandOrControl+Alt+C', noop)
  const imageOk = reg.register('image', 'Alt+Ctrl+C', noop)
  check(
    'startup with one combination spelled twice keeps video and refuses only image',
    videoOk &&
      !imageOk &&
      reg.current('video') === 'CommandOrControl+Alt+C' &&
      reg.current('image') === null,
  )
}

{
  const combo = new CombinationBackend()
  const reg = new HotkeyRegistry(combo, 'win32')
  check(
    'genuinely different combinations both register',
    reg.register('video', 'Ctrl+Alt+C', noop) &&
      reg.register('image', 'Ctrl+Shift+C', noop) &&
      reg.current('video') === 'Ctrl+Alt+C' &&
      reg.current('image') === 'Ctrl+Shift+C' &&
      combo.held.size === 2,
  )
}

console.log(`\n${passed}/${passed + failed} hotkey registry checks passed.`)
if (failed > 0) process.exitCode = 1
