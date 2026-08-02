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

/**
 * Brings the stable copy up to this build's extension — AND ONLY WHEN IT MUST.
 *
 * The point of the stable location is that Chrome's loaded files stop changing
 * under it, so rewriting them on every launch would reintroduce the same
 * problem in a slower form: Chrome watches an unpacked extension and reloads
 * its service worker when the files change, which drops the native port. An
 * unchanged version therefore touches NOTHING — not a copy, not an mtime.
 */
export function syncExtensionIfChanged(): void {
  const source = bundledExtensionDir()
  const target = extensionDir()
  if (source === '' || !fs.existsSync(source)) return
  const bundled = versionIn(source)
  const installed = versionIn(target)
  if (bundled !== null && bundled === installed) return
  try {
    // Copied into place rather than swapped: a rename would delete the
    // directory Chrome has open, which is the failure being fixed.
    fs.mkdirSync(target, { recursive: true })
    copyTree(source, target)
    logInfo(
      installed === null
        ? `[chrome] extension ${bundled ?? '?'} installed to ${target}`
        : `[chrome] extension ${installed} -> ${bundled ?? '?'} in ${target}`,
    )
  } catch (err) {
    // Rule 1: the browser integration may never be why the app fails to start.
    // A copy that did not happen leaves the previous copy working.
    logError('[chrome] could not update the extension folder:', err)
  }
}

/** Recursive copy that overwrites files in place and leaves extras alone. */
function copyTree(from: string, to: string): void {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true })
      copyTree(src, dst)
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dst)
    }
  }
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
function hostCommand(): { path: string; args: readonly string[] } {
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
  const script = resolveNativeHostScript()
  return { path: process.execPath, args: script === null ? [] : [script] }
}

/**
 * dist/scripts/native-host.js — emitted by scripts/build.mjs, outside the asar
 * (asarUnpack) because plain Node cannot read Electron's archive format.
 */
function resolveNativeHostScript(): string | null {
  const packed = path.join(app.getAppPath(), 'dist', 'scripts', 'native-host.js')
  const unpacked = packed.replace(
    `${path.sep}app.asar${path.sep}`,
    `${path.sep}app.asar.unpacked${path.sep}`,
  )
  return [unpacked, packed].find((candidate) => fs.existsSync(candidate)) ?? null
}

/**
 * Chromium's manifest has no place for extra arguments — it starts `path` and
 * nothing else. When an argument IS needed, a one-line launcher supplies it.
 *
 * The test was `args.length === 1` and it had the packaged case exactly
 * backwards: one argument meant `['--native-host']`, the flag that made the
 * process a host at all, and the launcher was skipped precisely when it was
 * needed. Chrome then started the app normally, the single-instance lock ended
 * it, and the extension's port closed on a host that had never spoken. Now: no
 * arguments, no launcher.
 */
function writeLauncherIfNeeded(): string {
  const cmd = hostCommand()
  if (cmd.args.length === 0) return cmd.path
  const launcher = path.join(app.getPath('userData'), 'capturepack-host.cmd')
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
export function writeHostManifest(allowedExtensionIds: readonly string[]): string {
  const target = manifestPath()
  const manifest = {
    name: NATIVE_HOST_NAME,
    description: 'CapturePack native messaging host',
    path: writeLauncherIfNeeded(),
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
export function refreshHostManifestIfInstalled(): void {
  const target = manifestPath()
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
    writeHostManifest(allowed)
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
