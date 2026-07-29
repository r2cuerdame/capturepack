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
}

/** The manifest lives in userData: per-user, writable without elevation. */
export function manifestPath(): string {
  return path.join(app.getPath('userData'), `${NATIVE_HOST_NAME}.json`)
}

/**
 * The unpacked extension that ships with the app.
 *
 * Packaged, `extensions/` is copied next to the asar; in development it is two
 * levels up from `core/`. Both are checked rather than guessed at, because the
 * answer is shown to the user as a path they are about to paste into Chrome.
 */
export function extensionDir(): string {
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
 * The executable Chrome should start, with the flag that puts it in host mode.
 *
 * In development that is Electron itself plus the app directory, because
 * `process.execPath` is the electron binary and it would otherwise start with
 * no app at all.
 */
function hostCommand(): { path: string; args: readonly string[] } {
  return app.isPackaged
    ? { path: process.execPath, args: ['--native-host'] }
    : { path: process.execPath, args: [app.getAppPath(), '--native-host'] }
}

/**
 * Chromium's manifest has no place for extra arguments — it starts `path` and
 * nothing else. In development, where an argument IS needed, a one-line
 * launcher supplies it.
 */
function writeLauncherIfNeeded(): string {
  const cmd = hostCommand()
  if (cmd.args.length === 1) return cmd.path
  const launcher = path.join(app.getPath('userData'), 'capturepack-host.cmd')
  const quoted = cmd.args.map((a) => `"${a}"`).join(' ')
  fs.writeFileSync(launcher, `@echo off\r\n"${cmd.path}" ${quoted} %*\r\n`, 'utf8')
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
export function findOurExtensionIds(): readonly { id: string; browser: string; profile: string }[] {
  const target = path.normalize(extensionDir()).toLowerCase()
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
          if (path.normalize(where).toLowerCase() !== target) continue
          if (!/^[a-p]{32}$/.test(id)) continue
          if (!found.some((f) => f.id === id)) {
            found.push({ id, browser: root.label, profile })
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
