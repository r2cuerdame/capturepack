import {
  createReconnectBackoff,
  ExtensionConnectionLedger,
  NativeHostReplayBuffer,
  type ReconnectTimer,
} from '../src/main/chrome/lifecycle'
import { domPipePath } from '../src/main/chrome/nativeHost'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\nChrome integration lifecycle')

{
  const production = domPipePath({ USERNAME: 'capturepack-qa' })
  const isolated = domPipePath({
    USERNAME: 'capturepack-qa',
    CAPTUREPACK_DOM_PIPE_SUFFIX: 'headed-42',
  })
  const hostile = domPipePath({
    USERNAME: 'capturepack-qa',
    CAPTUREPACK_DOM_PIPE_SUFFIX: '..\\foreign pipe',
  })
  check(
    'headed QA gets a distinct bounded pipe without changing production',
    isolated !== production &&
      isolated.includes('headed-42') &&
      hostile === production,
  )
}

{
  const replay = new NativeHostReplayBuffer()
  const hello = JSON.stringify({ type: 'host.hello', protocol: 1, version: '0.1.8' })
  replay.remember(hello)
  check(
    'an app-pipe reconnect replays the browser hello',
    replay.drainForConnection()[0] === hello,
  )
  replay.enqueue(hello)
  replay.enqueue(JSON.stringify({ type: 'tab.updated' }))
  const drained = replay.drainForConnection()
  check(
    'queued hello is deduplicated and precedes later events',
    drained.length === 2 && drained[0] === hello && drained[1]?.includes('tab.updated') === true,
  )
}

{
  const first = {}
  const second = {}
  const ledger = new ExtensionConnectionLedger<object>()
  ledger.upsert(first, { version: '0.1.6', protocol: 1 })
  ledger.upsert(second, { version: '0.1.8', protocol: 1 })
  check('the newest live handshake drives status', ledger.latest()?.version === '0.1.8')
  ledger.remove(second)
  check('closing it reveals another live browser connection', ledger.latest()?.version === '0.1.6')
  ledger.remove(first)
  check('closing the last socket clears connected status', ledger.latest() === null)
}

{
  interface Pending {
    id: number
    callback: () => void
    delayMs: number
  }
  let nextId = 1
  const pending: Pending[] = []
  const cleared = new Set<number>()
  const timer: ReconnectTimer = {
    set(callback, delayMs) {
      const item = { id: nextId++, callback, delayMs }
      pending.push(item)
      return item.id
    },
    clear(handle) {
      cleared.add(handle as number)
    },
  }
  let redials = 0
  const reconnect = createReconnectBackoff(() => {
    redials += 1
  }, { minDelayMs: 500, maxDelayMs: 2_000, timer })

  reconnect.schedule()
  reconnect.schedule()
  check('a burst of close/error events schedules one redial', pending.length === 1)
  check('the first retry is fast', pending[0]?.delayMs === 500)
  pending.shift()?.callback()
  check('the timer redials without another browser message', redials === 1)

  reconnect.schedule()
  check('failed retries back off', pending[0]?.delayMs === 1_000)
  const pendingBeforeConnect = pending.shift()
  reconnect.connected()
  check(
    'a real connection cancels a pending retry',
    pendingBeforeConnect !== undefined && cleared.has(pendingBeforeConnect.id),
  )
  reconnect.schedule()
  check('a real connection resets to the fast delay', pending.at(-1)?.delayMs === 500)

  reconnect.stop()
  const before = pending.length
  reconnect.schedule()
  check('shutdown cannot be revived by a late close event', pending.length === before)
}

console.log(`\nresult: ${failed === 0 ? 'OK' : 'BROKEN'} — ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
