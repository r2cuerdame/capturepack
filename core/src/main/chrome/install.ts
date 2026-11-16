// Making the browser able to find us (GOAL "Chrome Extension" — "No manual
// setup, ever").
//
// Chrome will only launch a native messaging host it has been told about, and
// it is told in two places that must agree: a manifest file naming the
// executable and the extension IDs allowed to talk to it, and a registry value
// naming that file. Get either wrong and the extension reports a generic
// "Specified native messaging host not found", which is why this writes both
// and then reads them back.
//
// EVERY CHROMIUM BROWSER, NOT JUST CHROME. The GOAL asks for a structure that
// is "extensible from day one, not Chrome-hardcoded", and the cost of that
// here is one more registry path per browser — they all read the same manifest
// format from the same shape of key. Firefox is a different format and is not
// claimed.
import { app } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { logError, logInfo } from '../log'

export const NATIVE_HOST_NAME = 'com.capturepack.host'

/**
 * Browsers that read Chromium-format native messaging manifests, and where
 * each keeps its per-user registration.
 */
const BROWSERS: readonly { id: string; label: string; key: string }[] = [
  { id: 'chrome', label: 'Chrome', key: 'Software\\Google\\Chrome\\NativeMessagingHosts' },
  { id: 'edge', label: 'Edge', key: 'Software\\Microsoft\\Edge\\NativeMessagingHosts' },
  { id: 'brave', label: 'Brave', key: 'Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts' },
  { id: 'chromium', label: 'Chromium', key: 'Software\\Chromium\\NativeMessagingHosts' },
]

export interface BrowserRegistration {
  id: string
  label: string
  registered: boolean
}

export interface NativeHostInstallState {
  manifestPath: string
  manifestWritten: boolean
  /** The extension IDs the manifest currently allows. */
  allowedExtensionIds: readonly string[]
  browsers: readonly BrowserRegistration[]
  /** Where an unpacked extension can be loaded from, for developer mode. */
  extensionDir: string
  extensionDirExists: boolean
  /**
   * The OLD in-install-directory path — the home an update replaces. A
   * registration still pointing here works now and breaks at the next update;
   * `findOurExtensionIds()` flags those entries `legacy`.
   */
  legacyExtensionDir: string
}

/** The manifest lives in userData: per-user, writable without elevation. */
export function manifestPath(): string {
  return path.join(app.getPath('userData'), `${NATIVE_HOST_NAME}.json`)
}

/**
 * The unpacked extension AS THIS BUILD SHIPS IT — the read-only source.
 *
 * Packaged, `extensions/` is copied next to the asar; in development it is two
 * levels up from `core/`. Both are checked rather than guessed at. This is NOT
 * the folder the user loads into Chrome — see `extensionDir()` for why.
 */
export function bundledExtensionDir(): string {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'extensions', 'chrome')]
    : [
        path.join(app.getAppPath(), '..', 'extensions', 'chrome'),
        path.join(app.getAppPath(), '..', '..', 'extensions', 'chrome'),
      ]
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir
  }
  return candidates[0] ?? ''
}

/**
 * The folder Chrome is told to load, and it is NOT inside the app.
 *
 * THE INSTALLER USED TO PULL THE RUG OUT. An unpacked extension is loaded by
 * PATH: Chrome keeps that absolute path, derives the extension's ID from it,
 * and re-reads the files from it forever. The path handed out was
 * `resources/extensions/chrome` INSIDE the install directory — and an NSIS
 * install replaces that directory wholesale. Every reinstall therefore swapped
 * out the very folder the browser had loaded, and the extension stopped
 * dialling until the user went to chrome://extensions and pressed Reload.
 * Reported after every single update: "재설치할때마다 캡쳐팩 다시 리로드 안하면
 * 연결이 안돼".
 *
 * Measured while diagnosing it, and worth keeping because it ruled out the
 * obvious suspect: the native host was healthy the whole time. Driven exactly
 * as Chrome drives it, the launcher answered a length-prefixed hello with one
 * valid 54-byte frame and stayed alive. The host never stopped working — the
 * folder was moved out from under the browser.
 *
 * So the loaded copy lives in userData, beside the native host manifest and the
 * launcher that are already there for the same reason: per-user, writable
 * without elevation, and nothing in the installer knows it exists.
 * `syncExtensionIfChanged()` keeps it current.
 */
export function extensionDir(): string {
  return path.join(app.getPath('userData'), 'extension')
}

/**
 * The version sitting in a folder, or null when there is none.
 *
 * Reads the manifest rather than remembering what was written: an unpacked
 * extension folder is a real directory a user can edit, delete or restore from
 * a backup, and a remembered version would disagree with it silently.
 */
function versionIn(dir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')
    const version = (JSON.parse(raw) as { version?: unknown }).version
    return typeof version === 'string' && version !== '' ? version.slice(0, 32) : null
  } catch {
    return null
  }
}

/** Writes one extension file. Replaceable so a check can fail a write part-way. */
export type ExtensionFileWriter = (file: string, bytes: Buffer) => void

const writeExtensionFile: ExtensionFileWriter = (file, bytes) => fs.writeFileSync(file, bytes)

/**
 * Brings the stable copy up to this build's extension — AND ONLY WHEN IT MUST.
 *
 * The point of the stable location is that Chrome's loaded files stop changing
 * under it, so rewriting them on every launch would reintroduce the same
 * problem in a slower form: Chrome watches an unpacked extension and reloads
 * its service worker when the files change, which drops the native port. A
 * folder whose every shipped file already holds the shipped bytes therefore
 * touches NOTHING — not a copy, not an mtime.
 *
 * COMPARED BY CONTENT, NOT BY THE VERSION STRING (#534). This used to compare
 * only `manifest.json`'s version and then copy the tree in directory order —
 * which writes `manifest.json` before `route-change.js`, a file the worker
 * imports on its first line. A copy that failed after the manifest (a virus
 * scanner holding a file, a full disk) left the new version stamped on a folder
 * missing its scripts, and every later start saw the matching version and
 * repaired nothing, forever. A file the user deleted or a backup restored
 * half-way went unnoticed the same way.
 *
 * So every shipped file is read and compared, and only the ones that differ are
 * written, in an order where a failure at any step leaves the browser no worse
 * than before: new files first (nothing loads them yet), then changed helpers,
 * then the worker entry that imports them, and the manifest strictly last. A
 * write that fails stops the sync with the old manifest still in place, and the
 * next start finishes the job. Files the source does not ship are left alone.
 */
export function syncExtensionIfChanged(
  source: string = bundledExtensionDir(),
  target: string = extensionDir(),
  write: ExtensionFileWriter = writeExtensionFile,
): void {
  if (source === '' || !fs.existsSync(source)) return
  try {
    const pending = filesToSync(source, target)
    if (pending.length === 0) return
    const installed = versionIn(target)
    const bundled = versionIn(source)
    // Written into place rather than swapped: a rename would delete the
    // directory Chrome has open, which is the failure the stable folder fixes.
    for (const file of pending) {
      const dst = path.join(target, file.relative)
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      write(dst, file.bytes)
    }
    const what = `${pending.length} file(s)`
    logInfo(
      installed === null
        ? `[chrome] extension ${bundled ?? '?'} installed to ${target} (${what})`
        : installed === bundled
          ? `[chrome] extension ${installed} repaired in ${target} (${what})`
          : `[chrome] extension ${installed} -> ${bundled ?? '?'} in ${target} (${what})`,
    )
  } catch (err) {
    // Rule 1: the browser integration may never be why the app fails to start.
    // The manifest is written last, so a sync that stopped here left the
    // previous version's stamp in place and the next start retries it.
    logError('[chrome] could not update the extension folder:', err)
  }
}

interface PendingExtensionFile {
  relative: string
  bytes: Buffer
}

/**
 * The shipped files whose bytes the target does not already hold, in the order
 * they may safely be written: missing payload, changed payload, the service
 * worker entry, then `manifest.json`.
 */
function filesToSync(source: string, target: string): PendingExtensionFile[] {
  const worker = workerEntryIn(source)
  const missing: PendingExtensionFile[] = []
  const changed: PendingExtensionFile[] = []
  let entry: PendingExtensionFile | null = null
  let manifest: PendingExtensionFile | null = null
  for (const relative of listFiles(source)) {
    const bytes = fs.readFileSync(path.join(source, relative))
    let current: Buffer | null = null
    try {
      current = fs.readFileSync(path.join(target, relative))
    } catch {
      current = null
    }
    if (current !== null && current.equals(bytes)) continue
    const file = { relative, bytes }
    if (relative === 'manifest.json') manifest = file
    else if (relative === worker) entry = file
    else if (current === null) missing.push(file)
    else changed.push(file)
  }
  return [...missing, ...changed, ...(entry === null ? [] : [entry]), ...(manifest === null ? [] : [manifest])]
}

/** The worker script the manifest names, as a path relative to the folder. */
function workerEntryIn(dir: string): string {
  try {
    const raw = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')
    const worker = (JSON.parse(raw) as { background?: { service_worker?: unknown } }).background
      ?.service_worker
    if (typeof worker === 'string' && worker !== '') return path.normalize(worker)
  } catch {
    // An unreadable manifest is still copied; the default name is the only guess.
  }
  return 'background.js'
}

/** Every regular file under `dir`, as sorted relative paths. */
function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = []
  const entries = fs
    .readdirSync(path.join(dir, prefix), { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : path.join(prefix, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(dir, relative))
    else if (entry.isFile()) out.push(relative)
  }
  return out
}

/**
 * The version in the extension folder this build ships, or null if unreadable.
 *
 * An unpacked extension is a COPY the browser made when the user pressed "Load
 * unpacked", and an app update replaces the folder without touching that copy.
 * So the two versions drift apart silently, and the symptom of a stale
 * extension — a handshake that connects and then behaves like an older
 * protocol — is indistinguishable from a broken app unless someone compares
 * them. This is the half the app can read; the extension reports the other in
 * its hello.
 */
export function bundledExtensionVersion(): string | null {
  try {
    const raw = fs.readFileSync(path.join(bundledExtensionDir(), 'manifest.json'), 'utf8')
    const version = (JSON.parse(raw) as { version?: unknown }).version
    return typeof version === 'string' && version !== '' ? version.slice(0, 32) : null
  } catch {
    // Missing or malformed: the "extension files are present" check already
    // reports that, and guessing a version here would only make it disagree.
    return null
  }
}

/**
 * The executable Chrome should start, with the flag that puts it in host mode.
 *
 * In development that is Electron itself plus the app directory, because
 * `process.execPath` is the electron binary and it would otherwise start with
 * no app at all.
 */
export function hostCommand(scriptResolver: () => string | null = resolveNativeHostScript): {
  path: string
  args: readonly string[]
} {
  // AS PLAIN NODE, NEVER AS ELECTRON. The previous revision registered the
  // packaged exe directly, argument-free, and was proud of it ("no cmd.exe
  // sitting between Chrome and the process whose stdin and stdout are the
  // protocol"). Measured on that build: electron.exe writes `\r\n` to stdout
  // ~30 ms after launch, BEFORE the main script runs, with no app loaded at
  // all. Chrome parses a host's stdout as length-prefixed frames from byte
  // zero, so those two bytes corrupt the length word of the first real frame
  // and Chrome kills the port — every session, ~0.3 s after connect. The
  // extension's 2 s retry then redials forever: seventeen hellos at 2.3 s
  // intervals in the log that finally condemned it ("연결이 안돼").
  //
  // `ELECTRON_RUN_AS_NODE=1` boots the same binary with no Chromium and a
  // measured zero bytes of unsolicited stdout, running the standalone host
  // bundle. The environment variable is what makes the launcher .cmd unavoidable now:
  // Chromium's manifest has no place for env or args.
  const script = scriptResolver()
  if (script === null || script.trim() === '') {
    logError('[chrome] cannot resolve native host script: refusing uninsulated Electron execution')
    throw new Error('native host script unresolved; refusing uninsulated Electron fallback')
  }
  return { path: process.execPath, args: [script] }
}

/**
 * dist/scripts/native-host.js — emitted by scripts/build.mjs, outside the asar
 * (asarUnpack) because plain Node cannot read Electron's archive format.
 */
export function resolveNativeHostScript(appPath: string = app.getAppPath()): string | null {
  const packed = path.join(appPath, 'dist', 'scripts', 'native-host.js')
  const unpacked = packed.replace(
    `${path.sep}app.asar${path.sep}`,
    `${path.sep}app.asar.unpacked${path.sep}`,
  )
  const resolved = [unpacked, packed].find((candidate) => fs.existsSync(candidate)) ?? null
  if (resolved === null) {
    logError(`[chrome] native host script unresolved: neither ${unpacked} nor ${packed} exists`)
  }
  return resolved
}

/**
 * Chromium's manifest has no place for extra arguments — it starts `path` and
 * nothing else. When an argument IS needed, a one-line launcher supplies it.
 *
 * The launcher sets ELECTRON_RUN_AS_NODE=1 so the binary runs as plain Node
 * and stdout carries protocol frames and nothing else (preventing \r\n
 * stdout poisoning).
 *
 * If the native host script cannot be resolved, this MUST NOT fall back to
 * returning `cmd.path` directly (which would launch uninsulated Electron).
 */
export function writeLauncherIfNeeded(
  commandResolver: () => { path: string; args: readonly string[] } = hostCommand,
  userDataDir: string = app.getPath('userData'),
): string {
  const cmd = commandResolver()
  if (cmd.args.length === 0 || !cmd.args[0] || cmd.args[0].trim() === '') {
    logError('[chrome] host command has no arguments; refusing to register bare executable')
    throw new Error('host command has no arguments; refusing uninsulated Electron fallback')
  }
  const launcher = path.join(userDataDir, 'capturepack-host.cmd')
  const quoted = cmd.args.map((a) => `"${a}"`).join(' ')
  // `set` before the exec is the entire fix for the \r\n poisoning above: with
  // ELECTRON_RUN_AS_NODE the binary is plain Node and stdout carries protocol
  // frames and nothing else. `@echo off` keeps cmd.exe itself silent; measured:
  // a .cmd launcher with echo off contributes zero bytes to stdout.
  fs.writeFileSync(
    launcher,
    `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${cmd.path}" ${quoted} %*\r\n`,
    'utf8',
  )
  return launcher
}

/**
 * Writes the manifest naming this executable and the extensions allowed to
 * reach it.
 *
 * `allowedExtensionIds` is a list because an unpacked extension gets a
 * different ID than the same code from the Web Store, and a user in developer
 * mode should not have to choose between them.
 */
export function writeHostManifest(
  allowedExtensionIds: readonly string[],
  launcherWriter: () => string = writeLauncherIfNeeded,
  targetManifestPath: string = manifestPath(),
): string {
  const launcherPath = launcherWriter()
  if (launcherPath === process.execPath || !launcherPath.toLowerCase().endsWith('.cmd')) {
    logError('[chrome] refusing to register uninsulated executable in native host manifest')
    throw new Error('invalid launcher path; refusing to register uninsulated executable')
  }
  const target = targetManifestPath
  const manifest = {
    name: NATIVE_HOST_NAME,
    description: 'CapturePack native messaging host',
    path: launcherPath,
    type: 'stdio',
    allowed_origins: allowedExtensionIds.map((id) => `chrome-extension://${id}/`),
  }
  fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return target
}

/**
 * Registers the manifest with every Chromium browser on this machine.
 *
 * HKCU, never HKLM: this is a per-user integration and asking for elevation to
 * connect a browser extension would be the wrong trade entirely.
 */
export async function registerBrowsers(): Promise<readonly BrowserRegistration[]> {
  const target = manifestPath()
  const results: BrowserRegistration[] = []
  for (const browser of BROWSERS) {
    let ok = false
    try {
      await regWrite(`HKCU\\${browser.key}\\${NATIVE_HOST_NAME}`, target)
      ok = true
    } catch (err) {
      logError(`[chrome] could not register the host for ${browser.label}:`, err)
    }
    results.push({ id: browser.id, label: browser.label, registered: ok })
  }
  return results
}

/**
 * Re-writes an EXISTING manifest and launcher with this build's paths, keeping
 * the extension IDs the user already allowed. Called once at app start.
 *
 * Without this, a fix to how the host is launched reaches nobody: the manifest
 * is only written from the Settings panel, so every already-registered machine
 * keeps starting the host the old way until the user happens to press the
 * install button again. That is exactly how the CRLF-poisoned exe registration
 * would have outlived the code that fixed it — and it is one more face of
 * "재설치할때마다 연결이 안돼": a reinstall updates the app and leaves the
 * registration describing the previous one. A machine with no manifest is left
 * alone; installing is still the user's decision.
 */
export function refreshHostManifestIfInstalled(
  target: string = manifestPath(),
  manifestWriter: (allowed: readonly string[]) => string = (allowed) =>
    writeHostManifest(allowed, writeLauncherIfNeeded, target),
): void {
  let allowed: string[] = []
  try {
    const raw = JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, unknown>
    const origins = raw['allowed_origins']
    if (!Array.isArray(origins)) return
    allowed = origins
      .filter((o): o is string => typeof o === 'string')
      .map((o) => o.replace(/^chrome-extension:\/\//, '').replace(/\/$/, ''))
      .filter((o) => o !== '')
  } catch {
    return // Never installed (or unreadable): not ours to decide.
  }
  if (allowed.length === 0) return
  try {
    manifestWriter(allowed)
    logInfo('[chrome] native host manifest refreshed for this build')
  } catch (err) {
    logError('[chrome] could not refresh the native host manifest:', err)
  }
}

export async function unregisterBrowsers(): Promise<void> {
  for (const browser of BROWSERS) {
    try {
      await regDelete(`HKCU\\${browser.key}\\${NATIVE_HOST_NAME}`)
    } catch {
      // A key that was never there is the state we wanted.
    }
  }
  try {
    fs.unlinkSync(manifestPath())
  } catch {
    // Same.
  }
  logInfo('[chrome] native host unregistered')
}

/** What is actually on disk and in the registry right now — read, not assumed. */
export async function nativeHostState(): Promise<NativeHostInstallState> {
  const target = manifestPath()
  let manifestWritten = false
  let allowed: string[] = []
  try {
    const raw = JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, unknown>
    manifestWritten = true
    const origins = raw['allowed_origins']
    if (Array.isArray(origins)) {
      allowed = origins
        .filter((o): o is string => typeof o === 'string')
        .map((o) => o.replace(/^chrome-extension:\/\//, '').replace(/\/$/, ''))
    }
  } catch {
    manifestWritten = false
  }
  const browsers: BrowserRegistration[] = []
  for (const browser of BROWSERS) {
    let registered = false
    try {
      const value = await regRead(`HKCU\\${browser.key}\\${NATIVE_HOST_NAME}`)
      registered = value !== null && value.toLowerCase() === target.toLowerCase()
    } catch {
      registered = false
    }
    browsers.push({ id: browser.id, label: browser.label, registered })
  }
  const dir = extensionDir()
  return {
    manifestPath: target,
    manifestWritten,
    allowedExtensionIds: allowed,
    browsers,
    extensionDir: dir,
    extensionDirExists: fs.existsSync(dir),
    // The PATH only. Whether a browser is actually still loading from it is
    // read off `findOurExtensionIds()`, which the caller already runs — that
    // scan opens every browser profile's Secure Preferences, and doing it twice
    // per status poll would cost megabytes of JSON for one boolean.
    legacyExtensionDir: bundledExtensionDir(),
  }
}

/**
 * Finds the ID the browser gave OUR extension folder (GOAL "Extension Install
 * & Management UX": "Users must never hunt through browser settings").
 *
 * An unpacked extension's ID is derived from its path, so it is assigned by the
 * browser at load time and there is nowhere for the user to read it except the
 * extensions page — which is exactly the hunting this is meant to remove.
 *
 * But the browser writes it down. Each profile's `Secure Preferences` lists
 * every installed extension under its ID, and for an unpacked one the entry
 * carries the absolute path it was loaded from. Measured on this machine:
 * Preferences held none and Secure Preferences held seventeen with real paths,
 * so both are read and the paths are compared, not the names.
 *
 * READ ONLY, and never while claiming to be the browser: this opens a JSON file
 * the user already owns and looks for one path in it.
 */
export function findOurExtensionIds(): readonly {
  id: string
  browser: string
  profile: string
  /** True when this registration points at the OLD in-install-directory copy. */
  legacy?: boolean
}[] {
  // BOTH HOMES ARE OURS. The extension used to be loaded from inside the
  // install directory, and a browser that loaded it there is still pointing
  // there — matching only the new path would report "not loaded" on exactly
  // the machines that have been using this the longest. So both are matched
  // and the stale one is flagged, which is what lets Settings say "load the
  // new folder once" instead of "we cannot find it".
  const target = path.normalize(extensionDir()).toLowerCase()
  const legacyTarget = path.normalize(bundledExtensionDir()).toLowerCase()
  if (target === '') return []
  const local = process.env['LOCALAPPDATA']
  if (local === undefined) return []
  const roots: readonly { label: string; dir: string }[] = [
    { label: 'Chrome', dir: path.join(local, 'Google', 'Chrome', 'User Data') },
    { label: 'Edge', dir: path.join(local, 'Microsoft', 'Edge', 'User Data') },
    { label: 'Brave', dir: path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data') },
    { label: 'Chromium', dir: path.join(local, 'Chromium', 'User Data') },
  ]
  const found: { id: string; browser: string; profile: string }[] = []
  for (const root of roots) {
    let profiles: string[]
    try {
      profiles = fs
        .readdirSync(root.dir)
        .filter((d) => d === 'Default' || /^Profile \d+$/.test(d))
    } catch {
      continue
    }
    for (const profile of profiles) {
      for (const file of ['Secure Preferences', 'Preferences']) {
        let parsed: unknown
        try {
          parsed = JSON.parse(fs.readFileSync(path.join(root.dir, profile, file), 'utf8'))
        } catch {
          continue
        }
        const settings = (parsed as { extensions?: { settings?: Record<string, unknown> } })
          ?.extensions?.settings
        if (settings === undefined) continue
        for (const [id, raw] of Object.entries(settings)) {
          const where = (raw as { path?: unknown }).path
          if (typeof where !== 'string') continue
          const at = path.normalize(where).toLowerCase()
          const isLegacy = legacyTarget !== '' && at === legacyTarget
          if (at !== target && !isLegacy) continue
          if (!/^[a-p]{32}$/.test(id)) continue
          if (!found.some((f) => f.id === id)) {
            found.push({ id, browser: root.label, profile, ...(isLegacy ? { legacy: true } : {}) })
          }
        }
      }
    }
  }
  return found
}

// ---------------------------------------------------------------------------
// The registry, through reg.exe.
//
// Shipping a native module to write four string values would add a compile
// step, a rebuild-per-Electron-version, and a binary to sign, to do what a
// program already on every Windows machine does. reg.exe it is — with the
// arguments passed as an array, never a command line, so a path with a space
// or a quote in it is data rather than syntax.
// ---------------------------------------------------------------------------

async function regWrite(key: string, value: string): Promise<void> {
  await run('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', value, '/f'])
}

async function regDelete(key: string): Promise<void> {
  await run('reg', ['delete', key, '/f'])
}

async function regRead(key: string): Promise<string | null> {
  const out = await run('reg', ['query', key, '/ve'])
  const match = /REG_SZ\s+(.+)/.exec(out)
  return match?.[1]?.trim() ?? null
}

function run(cmd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error('the native messaging host registry lives on Windows'))
      return
    }
    // Imported here so a non-Windows build never pulls it in at module load.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execFile } = require('node:child_process') as typeof import('node:child_process')
    execFile(cmd, [...args], { windowsHide: true }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}
