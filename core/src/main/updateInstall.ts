import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

export const PENDING_UPDATE_FILE = 'pending-update.json'
export const RUN_ONCE_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce'
export const RUN_ONCE_VALUE = 'CapturePackUpdate'
export const INSTALL_IDLE_POLL_MS = 1000

export interface PendingUpdate {
  version: string
  installerPath: string
  sha512: string
  startupAttemptFrom: string | null
}

export type StartupUpdateDecision =
  | { kind: 'none' }
  | { kind: 'install'; update: PendingUpdate }
  | { kind: 'clear'; reason: string }
  | { kind: 'keep'; reason: string }

export type SessionEndReason = 'shutdown' | 'close-app' | 'critical' | 'logoff'

function versionParts(version: string): { core: number[]; pre: string[] } | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(version.trim())
  if (match === null) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}

export function compareVersions(a: string, b: string): number | null {
  const left = versionParts(a)
  const right = versionParts(b)
  if (left === null || right === null) return null
  for (let i = 0; i < 3; i += 1) {
    const diff = (left.core[i] ?? 0) - (right.core[i] ?? 0)
    if (diff !== 0) return Math.sign(diff)
  }
  if (left.pre.length === 0 || right.pre.length === 0) {
    return Math.sign(right.pre.length - left.pre.length)
  }
  const length = Math.max(left.pre.length, right.pre.length)
  for (let i = 0; i < length; i += 1) {
    const l = left.pre[i]
    const r = right.pre[i]
    if (l === undefined) return -1
    if (r === undefined) return 1
    const ln = /^\d+$/u.test(l) ? Number(l) : null
    const rn = /^\d+$/u.test(r) ? Number(r) : null
    if (ln !== null && rn !== null) {
      if (ln !== rn) return Math.sign(ln - rn)
      continue
    }
    if (ln !== null) return -1
    if (rn !== null) return 1
    if (l !== r) return l < r ? -1 : 1
  }
  return 0
}

export function pendingUpdateFile(userDataDir: string): string {
  return path.join(userDataDir, PENDING_UPDATE_FILE)
}

export function readPendingUpdate(file: string): PendingUpdate | null {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  if (
    typeof record.version !== 'string' ||
    typeof record.installerPath !== 'string' ||
    typeof record.sha512 !== 'string' ||
    record.version === '' ||
    record.installerPath === '' ||
    record.sha512 === ''
  ) {
    return null
  }
  return {
    version: record.version,
    installerPath: record.installerPath,
    sha512: record.sha512,
    startupAttemptFrom:
      typeof record.startupAttemptFrom === 'string' ? record.startupAttemptFrom : null,
  }
}

export function writePendingUpdate(file: string, update: PendingUpdate): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(update, null, 2), 'utf8')
  fs.renameSync(temporary, file)
}

export function clearPendingUpdate(file: string): void {
  fs.rmSync(file, { force: true })
  fs.rmSync(`${file}.tmp`, { force: true })
}

export function hashFileSha512(file: string): Promise<string | null> {
  return new Promise((resolve) => {
    const hash = createHash('sha512')
    const stream = fs.createReadStream(file)
    stream.on('error', () => resolve(null))
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('base64')))
  })
}

export function nextPendingUpdate(
  previous: PendingUpdate | null,
  downloaded: { version: string; installerPath: string; sha512: string },
): PendingUpdate {
  const sameDownload =
    previous !== null &&
    previous.version === downloaded.version &&
    previous.installerPath === downloaded.installerPath &&
    previous.sha512 === downloaded.sha512
  return {
    ...downloaded,
    startupAttemptFrom: sameDownload ? previous.startupAttemptFrom : null,
  }
}

export function startupUpdateDecision(input: {
  pending: PendingUpdate | null
  currentVersion: string
  autoInstall: boolean
  installerSha512: string | null
}): StartupUpdateDecision {
  const { pending, currentVersion, autoInstall, installerSha512 } = input
  if (pending === null) return { kind: 'none' }
  const order = compareVersions(pending.version, currentVersion)
  if (order === null) return { kind: 'clear', reason: `unreadable version ${pending.version}` }
  if (order <= 0) return { kind: 'clear', reason: `v${pending.version} is already installed` }
  if (installerSha512 === null) return { kind: 'clear', reason: 'the downloaded installer is gone' }
  if (installerSha512 !== pending.sha512) {
    return { kind: 'clear', reason: 'the downloaded installer no longer matches its verified sha512' }
  }
  if (!autoInstall) return { kind: 'keep', reason: 'automatic updates are turned off' }
  if (pending.startupAttemptFrom === currentVersion) {
    return { kind: 'keep', reason: `an install from v${currentVersion} was already attempted` }
  }
  return { kind: 'install', update: pending }
}

export function startupInstallArgs(): string[] {
  return ['--updated', '/S', '--force-run']
}

export function sessionEndRelaunch(input: {
  reasons: readonly SessionEndReason[]
  pending: PendingUpdate | null
  currentVersion: string
  autoInstall: boolean
  launchAtLogin: boolean
}): boolean {
  const { reasons, pending, currentVersion, autoInstall, launchAtLogin } = input
  if (!autoInstall || launchAtLogin || pending === null) return false
  if (!reasons.includes('shutdown') && !reasons.includes('logoff')) return false
  if (pending.startupAttemptFrom === currentVersion) return false
  const order = compareVersions(pending.version, currentVersion)
  return order !== null && order > 0
}

export function runOnceArgs(executable: string, hiddenArg: string): string[] {
  return ['add', RUN_ONCE_KEY, '/v', RUN_ONCE_VALUE, '/t', 'REG_SZ', '/d', `"${executable}" ${hiddenArg}`, '/f']
}

export interface IdleGateTimers {
  set(run: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export interface IdleGate {
  request(): 'now' | 'deferred' | 'already-pending'
  pending(): boolean
  cancel(): void
}

export function createIdleGate(options: {
  isBusy: () => boolean
  run: () => void
  onDeferred?: () => void
  intervalMs?: number
  timers?: IdleGateTimers
}): IdleGate {
  const intervalMs = options.intervalMs ?? INSTALL_IDLE_POLL_MS
  const timers: IdleGateTimers = options.timers ?? {
    set: (run, ms) => setTimeout(run, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
  let handle: unknown = null
  let waiting = false
  const busy = (): boolean => {
    try {
      return options.isBusy()
    } catch {
      return true
    }
  }
  const poll = (): void => {
    handle = null
    if (!waiting) return
    if (busy()) {
      handle = timers.set(poll, intervalMs)
      return
    }
    waiting = false
    options.run()
  }
  return {
    request() {
      if (waiting) return 'already-pending'
      if (!busy()) {
        options.run()
        return 'now'
      }
      waiting = true
      options.onDeferred?.()
      handle = timers.set(poll, intervalMs)
      return 'deferred'
    },
    pending() {
      return waiting
    },
    cancel() {
      waiting = false
      if (handle !== null) timers.clear(handle)
      handle = null
    },
  }
}
