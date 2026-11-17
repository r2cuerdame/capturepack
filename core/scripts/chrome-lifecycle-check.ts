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
  type HostRegistrationStore,
  refreshHostManifestIfInstalled,
  resolveNativeHostScript,
  syncExtensionIfChanged,
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

const REGISTRY_BROWSERS: Readonly<Record<string, string>> = {
  Chrome: 'Software\\Google\\Chrome\\',
  Edge: 'Software\\Microsoft\\Edge\\',
  Brave: 'Software\\BraveSoftware\\Brave-Browser\\',
  Chromium: 'Software\\Chromium\\',
}

function browserOfKey(key: string): string {
  return Object.keys(REGISTRY_BROWSERS).find((name) => key.includes(REGISTRY_BROWSERS[name] ?? '\0')) ?? key
}

function fakeRegistrations(
  initial: Readonly<Record<string, string>> = {},
  faults: { failRead?: readonly string[]; failWrite?: readonly string[]; failExists?: readonly string[] } = {},
): {
  store: HostRegistrationStore
  value: (browser: string) => string | undefined
  reads: string[]
  writes: { browser: string; value: string }[]
} {
  const values = new Map<string, string>(Object.entries(initial))
  const reads: string[] = []
  const writes: { browser: string; value: string }[] = []
  const store: HostRegistrationStore = {
    async read(key) {
      const browser = browserOfKey(key)
      reads.push(browser)
      if (faults.failRead?.includes(browser) === true) throw new Error(`simulated read failure: ${browser}`)
      return values.get(browser) ?? null
    },
    async write(key, value) {
      const browser = browserOfKey(key)
      if (faults.failWrite?.includes(browser) === true) throw new Error(`simulated write failure: ${browser}`)
      values.set(browser, value)
      writes.push({ browser, value })
    },
    fileExists(file) {
      const browser = [...values.entries()].find(([, v]) => v === file)?.[0]
      if (browser !== undefined && faults.failExists?.includes(browser) === true) {
        throw new Error(`simulated access failure: ${browser}`)
      }
      return fs.existsSync(file)
    },
  }
  return { store, value: (browser) => values.get(browser), reads, writes }
}

async function capturingLogs(action: () => Promise<void>): Promise<string[]> {
  const lines: string[] = []
  const original = { info: console.info, error: console.error, warn: console.warn }
  const record = (...args: unknown[]): void => {
    lines.push(args.map(String).join(' '))
  }
  console.info = record
  console.error = record
  console.warn = record
  try {
    await action()
  } finally {
    console.info = original.info
    console.error = original.error
    console.warn = original.warn
  }
  return lines
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

  void refreshHostManifestIfInstalled(
    manifestFile,
    () => {
      throw new Error('simulated unresolved host script')
    },
    fakeRegistrations().store,
  )
  const afterFailedRefresh = fs.readFileSync(manifestFile, 'utf8')
  check(
    'refreshHostManifestIfInstalled preserves existing manifest when script is unresolved',
    afterFailedRefresh === initialManifestContent && !afterFailedRefresh.includes(process.execPath),
  )

  fs.rmSync(tempDir, { recursive: true, force: true })
}

async function registrationRepairCases(): Promise<void> {
  console.log('\nDangling browser registration repair (#587)')
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capturepack-registration-repair-'))
  const manifestFile = path.join(tempDir, 'com.capturepack.host.json')
  const otherManifest = path.join(tempDir, 'other', 'com.capturepack.host.json')
  const deletedManifest = path.join(tempDir, 'deleted-qa', 'data', 'com.capturepack.host.json')
  fs.mkdirSync(path.dirname(otherManifest), { recursive: true })
  fs.writeFileSync(otherManifest, '{}\n', 'utf8')
  const writeManifest = (origins: readonly string[]): void => {
    fs.writeFileSync(
      manifestFile,
      `${JSON.stringify({ name: 'com.capturepack.host', allowed_origins: origins }, null, 2)}\n`,
      'utf8',
    )
  }
  const keepManifest = (): string => manifestFile
  const allowed = ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/']

  try {
    writeManifest(allowed)
    const repair = fakeRegistrations({
      Chrome: deletedManifest,
      Edge: manifestFile.toUpperCase(),
      Brave: otherManifest,
    })
    const logs = await capturingLogs(() => refreshHostManifestIfInstalled(manifestFile, keepManifest, repair.store))
    check(
      'a registration pointing at a deleted manifest is pointed back at this manifest',
      repair.value('Chrome') === manifestFile && repair.writes.length === 1 && repair.writes[0]?.browser === 'Chrome',
      JSON.stringify(repair.writes),
    )
    check(
      'registrations already ours, pointing at another existing manifest, or absent are left alone',
      repair.value('Edge') === manifestFile.toUpperCase() &&
        repair.value('Brave') === otherManifest &&
        repair.value('Chromium') === undefined &&
        repair.reads.length === 4,
      JSON.stringify(repair.writes),
    )
    check(
      'the repaired browser is named in the log',
      logs.some((line) => line.includes('repaired') && line.includes('Chrome') && !line.includes('Edge')),
      logs.join(' | '),
    )

    const settled = fakeRegistrations({ Chrome: manifestFile })
    await refreshHostManifestIfInstalled(manifestFile, keepManifest, settled.store)
    check('an already healthy machine writes nothing', settled.writes.length === 0)

    fs.rmSync(manifestFile, { force: true })
    const uninstalled = fakeRegistrations({ Chrome: deletedManifest, Edge: deletedManifest })
    await refreshHostManifestIfInstalled(manifestFile, keepManifest, uninstalled.store)
    check(
      'no manifest of ours means no registration is read, created or changed',
      uninstalled.writes.length === 0 && uninstalled.reads.length === 0 && !fs.existsSync(manifestFile),
    )

    writeManifest([])
    const noIds = fakeRegistrations({ Chrome: deletedManifest })
    await refreshHostManifestIfInstalled(manifestFile, keepManifest, noIds.store)
    check(
      'a manifest with no allowed extension changes no registration',
      noIds.writes.length === 0 && noIds.value('Chrome') === deletedManifest,
    )

    writeManifest(allowed)
    const unreachableManifest = path.join(tempDir, 'unreachable', 'com.capturepack.host.json')
    const flaky = fakeRegistrations(
      { Edge: deletedManifest, Brave: deletedManifest, Chromium: unreachableManifest },
      { failRead: ['Chrome'], failWrite: ['Edge'], failExists: ['Chromium'] },
    )
    let threw = false
    let flakyLogs: string[] = []
    try {
      flakyLogs = await capturingLogs(() => refreshHostManifestIfInstalled(manifestFile, keepManifest, flaky.store))
    } catch {
      threw = true
    }
    check(
      'registry read, write and existence failures never throw and the other browsers are still repaired',
      !threw &&
        flaky.value('Brave') === manifestFile &&
        flaky.value('Edge') === deletedManifest &&
        flaky.value('Chromium') === unreachableManifest,
      JSON.stringify(flaky.writes),
    )
    check(
      'each registry failure is logged with its browser',
      flakyLogs.some((line) => line.includes('Chrome') && line.includes('could not read')) &&
        flakyLogs.some((line) => line.includes('Edge') && line.includes('could not repair')) &&
        flakyLogs.some((line) => line.includes('Chromium') && line.includes('could not check')),
      flakyLogs.join(' | '),
    )
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
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

console.log('\nStable extension folder sync (#534)')

{
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capturepack-extension-sync-'))
  const source = path.join(tempDir, 'bundled')
  const target = path.join(tempDir, 'stable')
  const put = (dir: string, relative: string, content: string | Buffer): void => {
    const file = path.join(dir, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  const manifest = (version: string): string =>
    `${JSON.stringify({ manifest_version: 3, version, background: { service_worker: 'background.js' } })}\n`
  const read = (dir: string, relative: string): string | null => {
    try {
      return fs.readFileSync(path.join(dir, relative), 'utf8')
    } catch {
      return null
    }
  }
  const sameTree = (): boolean => {
    const walk = (dir: string, prefix = ''): string[] =>
      fs.readdirSync(path.join(dir, prefix), { withFileTypes: true }).flatMap((e) => {
        const relative = path.join(prefix, e.name)
        return e.isDirectory() ? walk(dir, relative) : [relative]
      })
    return walk(source).every((relative) =>
      fs.readFileSync(path.join(source, relative)).equals(
        fs.existsSync(path.join(target, relative)) ? fs.readFileSync(path.join(target, relative)) : Buffer.alloc(0),
      ),
    )
  }
  const recorder = (written: string[], failOn?: string) => (file: string, bytes: Buffer): void => {
    const relative = path.relative(target, file)
    if (relative === failOn) throw new Error(`simulated locked file: ${relative}`)
    written.push(relative)
    fs.writeFileSync(file, bytes)
  }
  const icon = path.join('icons', 'icon-16.png')

  try {
    put(source, 'manifest.json', manifest('1.0.0'))
    put(source, 'background.js', "importScripts('route-change.js')\n// v1\n")
    put(source, 'content-script.js', '// content v1\n')
    put(source, 'route-change.js', '// route v1\n')
    put(source, icon, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]))

    const initial: string[] = []
    syncExtensionIfChanged(source, target, recorder(initial))
    check(
      'a first sync installs every shipped file with the manifest written last',
      sameTree() && initial.length === 5 && initial.at(-1) === 'manifest.json' && initial.at(-2) === 'background.js',
      initial.join(', '),
    )

    // Criterion 1: an identical folder is not rewritten, not even its mtimes.
    const old = new Date('2026-01-01T00:00:00Z')
    const stamped = ['manifest.json', 'background.js', 'content-script.js', 'route-change.js', icon]
    for (const relative of stamped) fs.utimesSync(path.join(target, relative), old, old)
    const before = stamped.map((relative) => fs.statSync(path.join(target, relative)).mtimeMs)
    const idle: string[] = []
    syncExtensionIfChanged(source, target, recorder(idle))
    const after = stamped.map((relative) => fs.statSync(path.join(target, relative)).mtimeMs)
    check(
      'an up-to-date folder is left untouched: no write and every mtime unchanged',
      idle.length === 0 && before.every((mtime, i) => mtime === after[i]),
      idle.join(', '),
    )

    // Criterion 4: new helper first, changed helper next, worker, manifest last.
    put(source, 'manifest.json', manifest('1.0.1'))
    put(source, 'background.js', "importScripts('route-change.js', 'zz-new-helper.js')\n// v2\n")
    put(source, 'content-script.js', '// content v2\n')
    put(source, 'zz-new-helper.js', '// helper v2\n')
    const upgrade: string[] = []
    syncExtensionIfChanged(source, target, recorder(upgrade))
    check(
      'an update writes a new helper, then changed helpers, then the worker, then the manifest',
      upgrade.join('|') === ['zz-new-helper.js', 'content-script.js', 'background.js', 'manifest.json'].join('|') &&
        sameTree(),
      upgrade.join(', '),
    )

    // Criterion 2: a write that fails part-way leaves the previous manifest and
    // worker in place, does not throw into app start, and the next sync repairs.
    const manifestBefore = read(target, 'manifest.json')
    const workerBefore = read(target, 'background.js')
    put(source, 'manifest.json', manifest('1.0.2'))
    put(source, 'background.js', "importScripts('route-change.js', 'zz-new-helper.js')\n// v3\n")
    put(source, 'route-change.js', '// route v3\n')
    put(source, 'route-content.js', '// route content v3\n')
    const partial: string[] = []
    let threw = false
    try {
      syncExtensionIfChanged(source, target, recorder(partial, 'route-change.js'))
    } catch {
      threw = true
    }
    check(
      'a failed helper write keeps the previous manifest and worker and never throws',
      !threw &&
        read(target, 'manifest.json') === manifestBefore &&
        read(target, 'background.js') === workerBefore &&
        !partial.includes('manifest.json') &&
        !partial.includes('background.js'),
      partial.join(', '),
    )
    const retry: string[] = []
    syncExtensionIfChanged(source, target, recorder(retry))
    check(
      'the next sync finishes the interrupted update with the manifest last',
      sameTree() && retry.at(-1) === 'manifest.json' && !retry.includes('route-content.js'),
      retry.join(', '),
    )

    // Criterion 3: same version, but a file deleted and another altered.
    fs.unlinkSync(path.join(target, 'route-change.js'))
    put(target, icon, Buffer.from([0, 0, 0]))
    fs.utimesSync(path.join(target, 'manifest.json'), old, old)
    const manifestMtime = fs.statSync(path.join(target, 'manifest.json')).mtimeMs
    const repair: string[] = []
    syncExtensionIfChanged(source, target, recorder(repair))
    check(
      'a matching version with a missing and an altered file rewrites exactly those two',
      sameTree() &&
        repair.length === 2 &&
        repair[0] === 'route-change.js' &&
        repair[1] === icon &&
        fs.statSync(path.join(target, 'manifest.json')).mtimeMs === manifestMtime,
      repair.join(', '),
    )

    put(target, 'user-extra.txt', 'kept')
    syncExtensionIfChanged(source, target, recorder([]))
    check('files the build does not ship are left alone', read(target, 'user-extra.txt') === 'kept')

    let threwMissing = false
    try {
      syncExtensionIfChanged(path.join(tempDir, 'absent'), target)
      syncExtensionIfChanged('', target)
    } catch {
      threwMissing = true
    }
    check('a missing bundled folder is a no-op, not a crash', !threwMissing && sameTree())
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

registrationRepairCases()
  .catch((err: unknown) => {
    check('registration repair cases run to completion', false, String(err))
  })
  .finally(() => {
    console.log(`\nresult: ${failed === 0 ? 'OK' : 'BROKEN'} — ${passed} passed, ${failed} failed\n`)
    process.exit(failed === 0 ? 0 : 1)
  })
