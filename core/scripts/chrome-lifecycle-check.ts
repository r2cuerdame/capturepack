import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createReconnectBackoff,
  ExtensionConnectionLedger,
  NativeHostReplayBuffer,
  type ReconnectTimer,
} from '../src/main/chrome/lifecycle'
import { domPipePath } from '../src/main/chrome/nativeHost'
import {
  hostCommand,
  refreshHostManifestIfInstalled,
  resolveNativeHostScript,
  writeHostManifest,
  writeLauncherIfNeeded,
} from '../src/main/chrome/install'

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

console.log('\nNative host launcher and manifest isolation (CRLF poisoning guard)')

{
  const missing = resolveNativeHostScript(path.join(os.tmpdir(), 'capturepack-nonexistent-app'))
  check('missing host script returns null', missing === null)
}

{
  let threwNull = false
  try {
    hostCommand(() => null)
  } catch (err) {
    threwNull = err instanceof Error && err.message.includes('native host script unresolved')
  }
  check('hostCommand throws when native host script is unresolved', threwNull)

  let threwEmpty = false
  try {
    hostCommand(() => '   ')
  } catch (err) {
    threwEmpty = err instanceof Error && err.message.includes('native host script unresolved')
  }
  check('hostCommand throws when native host script is empty or whitespace', threwEmpty)
}

{
  let threwUnresolved = false
  try {
    writeLauncherIfNeeded(() => hostCommand(() => null))
  } catch {
    threwUnresolved = true
  }
  check(
    'writeLauncherIfNeeded throws and never returns bare executable when script is unresolved',
    threwUnresolved,
  )

  let threwEmptyArgs = false
  let returnedPath: string | null = null
  try {
    returnedPath = writeLauncherIfNeeded(() => ({ path: process.execPath, args: [] }))
  } catch {
    threwEmptyArgs = true
  }
  check(
    'writeLauncherIfNeeded refuses empty args instead of returning bare executable',
    threwEmptyArgs && returnedPath === null && returnedPath !== process.execPath,
  )
}

{
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capturepack-manifest-check-'))
  const manifestFile = path.join(tempDir, 'com.capturepack.host.json')
  let threwManifest = false
  try {
    writeHostManifest(
      ['abcdefghijklmnopabcdefghijklmnop'],
      () => writeLauncherIfNeeded(() => hostCommand(() => null)),
      manifestFile,
    )
  } catch {
    threwManifest = true
  }
  check('writeHostManifest fails closed on unresolved script', threwManifest)
  check('unresolved script creates no manifest file', !fs.existsSync(manifestFile))

  let threwBareExe = false
  try {
    writeHostManifest(
      ['abcdefghijklmnopabcdefghijklmnop'],
      () => process.execPath,
      manifestFile,
    )
  } catch {
    threwBareExe = true
  }
  check('writeHostManifest explicitly refuses bare process.execPath', threwBareExe)
  check('refused bare executable does not write manifest', !fs.existsSync(manifestFile))

  fs.rmSync(tempDir, { recursive: true, force: true })
}

{
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capturepack-refresh-check-'))
  const manifestFile = path.join(tempDir, 'com.capturepack.host.json')
  const initialLauncher = path.join(tempDir, 'capturepack-host.cmd')
  const initialManifestContent =
    JSON.stringify(
      {
        name: 'com.capturepack.host',
        description: 'CapturePack native messaging host',
        path: initialLauncher,
        type: 'stdio',
        allowed_origins: ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/'],
      },
      null,
      2,
    ) + '\n'
  fs.writeFileSync(manifestFile, initialManifestContent, 'utf8')

  refreshHostManifestIfInstalled(
    manifestFile,
    () => {
      throw new Error('simulated unresolved host script')
    },
  )
  const afterFailedRefresh = fs.readFileSync(manifestFile, 'utf8')
  check(
    'refreshHostManifestIfInstalled preserves existing manifest when script is unresolved',
    afterFailedRefresh === initialManifestContent && !afterFailedRefresh.includes(process.execPath),
  )

  fs.rmSync(tempDir, { recursive: true, force: true })
}

{
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capturepack-valid-launcher-'))
  const fakeScript = path.join(tempDir, 'fake-native-host.js')
  fs.writeFileSync(fakeScript, '// fake host', 'utf8')
  const cmd = hostCommand(() => fakeScript)
  check('hostCommand with valid script returns script in args', cmd.args.length === 1 && cmd.args[0] === fakeScript)

  const launcher = writeLauncherIfNeeded(() => cmd, tempDir)
  check('launcher is a .cmd file', launcher.endsWith('capturepack-host.cmd'))
  const content = fs.readFileSync(launcher, 'utf8')
  check(
    'launcher sets ELECTRON_RUN_AS_NODE=1 and includes script and %*',
    content.includes('set ELECTRON_RUN_AS_NODE=1') &&
      content.includes(`"${fakeScript}"`) &&
      content.includes('%*') &&
      content.startsWith('@echo off\r\n'),
  )

  const manifestFile = path.join(tempDir, 'com.capturepack.host.json')
  writeHostManifest(['abcdefghijklmnopabcdefghijklmnop'], () => launcher, manifestFile)
  const manifestRaw = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as Record<string, unknown>
  check(
    'manifest points to .cmd launcher and not process.execPath',
    manifestRaw['path'] === launcher && manifestRaw['path'] !== process.execPath,
  )

  fs.rmSync(tempDir, { recursive: true, force: true })
}

console.log(`\nresult: ${failed === 0 ? 'OK' : 'BROKEN'} — ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
