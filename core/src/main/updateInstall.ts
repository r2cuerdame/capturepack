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

export interface SessionEndPlan {
  install: boolean
  relaunch: boolean
}

export function sessionEndPlan(input: {
  reasons: readonly SessionEndReason[]
  pending: PendingUpdate | null
  currentVersion: string
  autoInstall: boolean
  launchAtLogin: boolean
}): SessionEndPlan {
  const { reasons, pending, currentVersion, autoInstall, launchAtLogin } = input
  const none = { install: false, relaunch: false }
  if (!autoInstall || pending === null) return none
  if (!reasons.includes('shutdown') && !reasons.includes('logoff')) return none
  if (pending.startupAttemptFrom === currentVersion) return none
  const order = compareVersions(pending.version, currentVersion)
  if (order === null || order <= 0) return none
  return { install: !reasons.includes('critical'), relaunch: !launchAtLogin }
}

export function sessionEndInstallArgs(): string[] {
  return ['--updated', '/S']
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

export function whenIdle(
  isBusy: () => boolean,
  options: { onDeferred?: () => void; intervalMs?: number; timers?: IdleGateTimers } = {},
): Promise<void> {
  return new Promise((resolve) => {
    createIdleGate({ ...options, isBusy, run: resolve }).request()
  })
}

export type SessionEndOutcome = 'guardian' | 'next-start' | 'dropped'

export interface SessionEndHandoffEffects {
  verify(): Promise<boolean>
  startGuardian(): Promise<boolean>
  armRelaunch(): void
  disarmQuitInstall(): void
  isBusy(): boolean
  quit(outcome: SessionEndOutcome): void
  onDeferred?: () => void
  intervalMs?: number
  timers?: IdleGateTimers
}

export async function runSessionEndHandoff(
  plan: SessionEndPlan,
  effects: SessionEndHandoffEffects,
): Promise<SessionEndOutcome> {
  effects.disarmQuitInstall()
  let outcome: SessionEndOutcome = 'dropped'
  try {
    if (await effects.verify()) outcome = (await effects.startGuardian()) ? 'guardian' : 'next-start'
  } catch {
    outcome = 'next-start'
  }
  if (outcome !== 'dropped' && plan.relaunch) {
    try {
      effects.armRelaunch()
    } catch {
      outcome = outcome === 'guardian' ? outcome : 'next-start'
    }
  }
  await whenIdle(() => effects.isBusy(), {
    onDeferred: effects.onDeferred,
    intervalMs: effects.intervalMs,
    timers: effects.timers,
  })
  effects.quit(outcome)
  return outcome
}

export const GUARDIAN_READY = 'capturepack-update-guardian-ready'
export const GUARDIAN_READY_TIMEOUT_MS = 20_000
export const SESSION_END_RESULT_FILE = 'session-end-install.json'

export interface SessionEndResult {
  version: string
  exitCode: number | null
  relaunched: boolean
  finishedAt: string
}

export function sessionEndResultFile(userDataDir: string): string {
  return path.join(userDataDir, SESSION_END_RESULT_FILE)
}

export function takeSessionEndResult(file: string): SessionEndResult | null {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  } finally {
    fs.rmSync(file, { force: true })
  }
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  if (typeof record.version !== 'string' || typeof record.finishedAt !== 'string') return null
  return {
    version: record.version,
    exitCode: typeof record.exitCode === 'number' ? record.exitCode : null,
    relaunched: record.relaunched === true,
    finishedAt: record.finishedAt,
  }
}

function powerShellLiteral(value: string): string {
  return `'${value.replace(/['‘’‚‛]/gu, (quote) => quote + quote)}'`
}

function powerShellArray(values: readonly string[]): string {
  return `@(${values.map(powerShellLiteral).join(', ')})`
}

export interface SessionEndGuardianInput {
  installerPath: string
  installerArgs: readonly string[]
  waitPid: number
  version: string
  message: string
  resultFile: string
  appPath: string
  appArgs: readonly string[]
  runOncePath?: string
}

export function sessionEndGuardianScript(input: SessionEndGuardianInput): string {
  const runOncePath = input.runOncePath ?? `HKCU:\\${RUN_ONCE_KEY.slice('HKCU\\'.length)}`
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$installer = ${powerShellLiteral(input.installerPath)}`,
    `$installerArgs = ${powerShellArray(input.installerArgs)}`,
    `$version = ${powerShellLiteral(input.version)}`,
    `$message = ${powerShellLiteral(input.message)}`,
    `$resultFile = ${powerShellLiteral(input.resultFile)}`,
    `$appPath = ${powerShellLiteral(input.appPath)}`,
    `$appArgs = ${powerShellArray(input.appArgs)}`,
    `$runOncePath = ${powerShellLiteral(runOncePath)}`,
    `$runOnceValue = ${powerShellLiteral(RUN_ONCE_VALUE)}`,
    `$app = Get-Process -Id ${String(Math.trunc(input.waitPid))} -ErrorAction SilentlyContinue`,
    `Add-Type -AssemblyName System.Windows.Forms`,
    `Add-Type -AssemblyName System.Drawing`,
    `$blockReason = $true`,
    `try {`,
    `  Add-Type -Namespace CapturePack -Name ShutdownBlock -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool ShutdownBlockReasonCreate(IntPtr hWnd, string reason); [DllImport("user32.dll")] public static extern bool ShutdownBlockReasonDestroy(IntPtr hWnd);'`,
    `} catch { $blockReason = $false }`,
    `$state = @{ done = $false; ending = $false; installer = $null; exitCode = $null }`,
    `$form = New-Object System.Windows.Forms.Form`,
    `$form.Text = 'CapturePack'`,
    `$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow`,
    `$form.ControlBox = $false`,
    `$form.TopMost = $true`,
    `$form.ShowInTaskbar = $false`,
    `$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual`,
    `$form.ClientSize = New-Object System.Drawing.Size(360, 64)`,
    `$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea`,
    `$form.Location = New-Object System.Drawing.Point(($area.Right - $form.Width - 16), ($area.Bottom - $form.Height - 16))`,
    `$label = New-Object System.Windows.Forms.Label`,
    `$label.Dock = [System.Windows.Forms.DockStyle]::Fill`,
    `$label.Padding = New-Object System.Windows.Forms.Padding(12)`,
    `$label.Text = $message`,
    `$form.Controls.Add($label)`,
    `$form.add_FormClosing({`,
    `  param($source, $closing)`,
    `  if ($closing.CloseReason -eq [System.Windows.Forms.CloseReason]::WindowsShutDown) { $state.ending = $true }`,
    `  if (-not $state.done) { $closing.Cancel = $true }`,
    `})`,
    `$timer = New-Object System.Windows.Forms.Timer`,
    `$timer.Interval = 250`,
    `function Complete-Install([object]$code) {`,
    `  $timer.Stop()`,
    `  $state.exitCode = $code`,
    `  $relaunched = $false`,
    `  if (-not $state.ending) {`,
    `    try {`,
    `      Remove-ItemProperty -Path $runOncePath -Name $runOnceValue -ErrorAction SilentlyContinue`,
    `      if ($appArgs.Count -gt 0) { Start-Process -FilePath $appPath -ArgumentList $appArgs } else { Start-Process -FilePath $appPath }`,
    `      $relaunched = $true`,
    `    } catch {}`,
    `  }`,
    `  try {`,
    `    $json = @{ version = $version; exitCode = $code; relaunched = $relaunched; finishedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress`,
    `    [System.IO.File]::WriteAllText($resultFile, $json)`,
    `  } catch {}`,
    `  $state.done = $true`,
    `  if ($blockReason) { try { [void][CapturePack.ShutdownBlock]::ShutdownBlockReasonDestroy($form.Handle) } catch {} }`,
    `  $form.Close()`,
    `}`,
    `$timer.add_Tick({`,
    `  try {`,
    `    if ($null -eq $state.installer) {`,
    `      if ($null -ne $app -and -not $app.HasExited) { return }`,
    `      $state.installer = Start-Process -FilePath $installer -ArgumentList $installerArgs -WindowStyle Hidden -PassThru`,
    `      $null = $state.installer.Handle`,
    `      return`,
    `    }`,
    `    if (-not $state.installer.HasExited) { return }`,
    `    Complete-Install $state.installer.ExitCode`,
    `  } catch {`,
    `    Complete-Install $null`,
    `  }`,
    `})`,
    `$form.add_Shown({`,
    `  if ($blockReason) { try { [void][CapturePack.ShutdownBlock]::ShutdownBlockReasonCreate($form.Handle, $message) } catch {} }`,
    `  [Console]::Out.WriteLine('${GUARDIAN_READY}')`,
    `  [Console]::Out.Flush()`,
    `  $timer.Start()`,
    `})`,
    `[System.Windows.Forms.Application]::Run($form)`,
    `if ($null -eq $state.exitCode) { exit 1 }`,
    `exit [int]$state.exitCode`,
    ``,
  ].join('\n')
}

export function powerShellEncodedArgs(script: string): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Sta',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ]
}
