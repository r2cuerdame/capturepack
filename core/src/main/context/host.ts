// The Context Host, from Core's side (issues #64, #65): a resident PowerShell
// process speaking NDJSON over stdio, restarted when it dies, never able to take
// the app down.
//
// WHY RESIDENT AND WHY POWERSHELL. Today's Windows helper is a COLD PowerShell
// process per capture: 673–710 ms wall, of which ~230 ms is powershell.exe
// starting. A temporal provider observes CONTINUOUSLY, so paying that per sample
// is absurd — being resident is worth exactly those 318 ms plus a warm cache.
// PowerShell rather than a native addon or a compiled exe because the repo has
// ZERO native dependencies and builds with esbuild alone: a resident host costs
// ~109 MB of working set (measured) against the app's existing 1362 MB, and buys
// us out of node-gyp, prebuilds for two architectures and a second signed
// artefact. The trigger to graduate to a native addon is fixed in
// docs/temporal-protocol.md §2.2 — sustained working set above 120 MB — so it
// does not quietly never happen.
//
// WHY NDJSON OVER STDIO. Keeping `powershell -File scripts/context-host.ps1`
// runnable by hand is what kept uia-dump.ps1 debuggable for three releases. JSON
// cannot contain a raw newline, so a line is a frame, and no length prefix or
// framing library is needed.
//
// FAILURE ISOLATION. Every stdio stream gets an 'error' listener before anything
// is written to it: an 'error' event on a stream with no listener is an
// unhandled EventEmitter error, i.e. an uncaughtException that would take the
// tray app down — hotkey, recorder and MCP server included. Object picking must
// never be able to do that (the rule src/main/uia.ts already enforces).

import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'
import { logError, logInfo, logWarn } from '../log'

/** One line the host sent that was not a reply to a request. */
export interface HostEvent {
  event: string
  [key: string]: unknown
}

export interface HostReply {
  id: number
  ok: boolean
  [key: string]: unknown
}

export interface ContextHostOptions {
  onEvent: (event: HostEvent) => void
  /** Called after every (re)start, once `hello` has answered. */
  onReady: (hello: HostReply) => void
  /** Called when the process is gone and a restart is either scheduled or refused. */
  onLost: (reason: string, willRestart: boolean) => void
}

/** A request that has been written and is waiting for its reply. */
interface Pending {
  resolve: (reply: HostReply) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Restart backoff. A host that cannot start (no PowerShell, a machine policy, an
 * antivirus killing it) must not be retried in a spin — but it must also not be
 * given up on after one failure, because the ordinary case for a dead host is a
 * Windows update restarting something underneath it.
 */
const RESTART_DELAYS_MS = [1_000, 2_000, 5_000, 15_000, 60_000]
/**
 * After this many restarts in one app run, lane S stops trying and SAYS SO
 * (GOAL "Silence is not absence"). The surface ring then simply has no data, and
 * every answer above it degrades to "no coverage" rather than to a wrong answer.
 */
const MAX_RESTARTS = 8
const REQUEST_TIMEOUT_MS = 2_000

export class ContextHost {
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private restarts = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private forcedCommandForm = false
  private stderr = ''
  private readonly options: ContextHostOptions

  constructor(options: ContextHostOptions) {
    this.options = options
  }

  isRunning(): boolean {
    return this.child !== null
  }

  /** Starts the host, or does nothing if it is already running. Never throws. */
  start(): void {
    if (this.child !== null || this.stopped) return
    const invocation = hostInvocation(this.forcedCommandForm)
    if (invocation === null) {
      logWarn('[context] host script not found — the surface timeline will have no data')
      this.options.onLost('no-script', false)
      return
    }
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          // UI Automation clients (lane A, a later step) are only reliable on an
          // STA thread, and the lane must not need a second host to be added.
          '-STA',
          '-ExecutionPolicy',
          'Bypass',
          ...invocation.args,
        ],
        { windowsHide: true },
      )
    } catch (err) {
      logError('[context] host could not be started', err)
      this.scheduleRestart('spawn-failed')
      return
    }
    this.child = child
    this.stderr = ''
    // Before ANYTHING is written: see the failure-isolation note in the header.
    child.stdin.on('error', () => {
      /* the host died mid-write; 'close' handles it */
    })
    child.stdout.on('error', () => {
      /* same */
    })
    child.stderr.on('error', () => {
      /* same */
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.consume(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      // Bounded: a host that writes an error per sample must not be able to grow
      // this string until the app runs out of memory.
      if (this.stderr.length < 4_000) this.stderr += chunk
    })
    child.on('error', (err) => {
      logError('[context] host failed', err)
      this.handleExit('error')
    })
    child.on('close', () => this.handleExit('closed'))

    void this.request('hello', undefined, 10_000)
      .then((hello) => {
        this.restarts = 0
        logInfo(
          `[context] host ready — pid ${String(hello['pid'])}, DPI ${String(hello['dpi'])}, ` +
            `PowerShell ${String(hello['psVersion'])}`,
        )
        this.options.onReady(hello)
      })
      .catch((err: unknown) => {
        // A host that will not even say hello is not a host. Killing it here is
        // what turns a hang into a restart instead of a permanent silence.
        logWarn(`[context] host did not answer hello (${errorMessage(err)})`)
        this.kill()
      })
  }

  /** Stops for good: no restart, and the child is asked to exit before it is killed. */
  stop(): void {
    this.stopped = true
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const child = this.child
    if (child === null) return
    // The host exits on stdin EOF by design, so ending stdin is the clean path
    // and the kill below is only for a host that ignored it.
    try {
      child.stdin.end()
    } catch {
      // Already gone.
    }
    setTimeout(() => this.kill(), 500)
  }

  /**
   * One request/response round trip. Rejects on timeout rather than hanging: a
   * slow host must never hold anything shut (GOAL "A slow Provider must never
   * hold the editor shut"), and the caller decides what to do without an answer.
   */
  request(method: string, params?: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<HostReply> {
    const child = this.child
    if (child === null) return Promise.reject(new Error('context host is not running'))
    const id = this.nextId
    this.nextId += 1
    const line = JSON.stringify(params === undefined ? { id, method } : { id, method, params })
    return new Promise<HostReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`context host did not answer ${method} within ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        child.stdin.write(`${line}\n`)
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line !== '') this.dispatch(line)
      index = this.buffer.indexOf('\n')
    }
    // A line that never terminates would otherwise grow without bound — a host
    // writing garbage must cost nothing but the garbage.
    if (this.buffer.length > 1_000_000) this.buffer = ''
  }

  private dispatch(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // A partial or malformed line is not a reason to restart the host: the
      // next line is very likely fine.
      return
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const record = parsed as Record<string, unknown>
    const id = record['id']
    if (typeof id === 'number') {
      const waiting = this.pending.get(id)
      if (waiting === undefined) return
      this.pending.delete(id)
      clearTimeout(waiting.timer)
      waiting.resolve({ ...record, id, ok: record['ok'] === true })
      return
    }
    const event = record['event']
    if (typeof event !== 'string') return
    try {
      this.options.onEvent({ ...record, event })
    } catch (err) {
      // A throw in a consumer must not kill the reader loop, or one bad sample
      // would end the surface timeline for the whole run.
      logError('[context] surface event handler threw', err)
    }
  }

  private kill(): void {
    const child = this.child
    if (child === null) return
    try {
      child.kill()
    } catch {
      // Already gone.
    }
  }

  private handleExit(how: string): void {
    this.child = null
    for (const [, waiting] of this.pending) {
      clearTimeout(waiting.timer)
      waiting.reject(new Error('context host exited'))
    }
    this.pending.clear()
    this.buffer = ''
    if (this.stopped) return
    // Execution policy refuses script FILES and resolves by scope precedence, so
    // Group Policy beats -ExecutionPolicy: on a managed machine `-File` is
    // simply refused. Running the same file as a COMMAND is not a script file
    // and runs anyway. Same fallback uia.ts uses, and for the same reason.
    if (!this.forcedCommandForm && isPolicyRefusal(this.stderr)) {
      this.forcedCommandForm = true
      logWarn('[context] execution policy refused the host script — retrying as a command')
    }
    this.scheduleRestart(how)
  }

  private scheduleRestart(reason: string): void {
    if (this.stopped) return
    if (this.restarts >= MAX_RESTARTS) {
      logWarn(
        `[context] host has died ${this.restarts} times this run (${reason}) — giving up; ` +
          'the surface timeline will have no data for the rest of this run',
      )
      this.options.onLost(reason, false)
      return
    }
    const delay = RESTART_DELAYS_MS[Math.min(this.restarts, RESTART_DELAYS_MS.length - 1)] ?? 60_000
    this.restarts += 1
    logWarn(`[context] host ${reason}; restarting in ${delay} ms (attempt ${this.restarts})`)
    this.options.onLost(reason, true)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.start()
    }, delay)
  }
}

let cachedScriptPath: string | null | undefined

/**
 * dist/scripts/context-host.ps1 — copied there by scripts/build.mjs and kept out
 * of the asar (asarUnpack in electron-builder.yml), because powershell.exe
 * cannot open a file inside an archive.
 */
function resolveHostScript(): string | null {
  if (cachedScriptPath !== undefined) return cachedScriptPath
  const packed = path.join(app.getAppPath(), 'dist', 'scripts', 'context-host.ps1')
  const unpacked = packed.replace(
    `${path.sep}app.asar${path.sep}`,
    `${path.sep}app.asar.unpacked${path.sep}`,
  )
  cachedScriptPath = [unpacked, packed].find((candidate) => existsSync(candidate)) ?? null
  return cachedScriptPath
}

function hostInvocation(forceCommandForm: boolean): { args: string[] } | null {
  const script = resolveHostScript()
  if (script === null) return null
  if (!forceCommandForm) return { args: ['-File', script] }
  const command =
    `$ErrorActionPreference='Stop';` +
    `& ([scriptblock]::Create([IO.File]::ReadAllText('${script.replace(/'/g, "''")}',[Text.Encoding]::UTF8)))`
  return { args: ['-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')] }
}

/**
 * PowerShell refusing to run a script FILE because of execution policy.
 * Deliberately not the bare word "UnauthorizedAccess" — see the same function in
 * src/main/uia.ts for why that alone would latch the slower form forever.
 */
function isPolicyRefusal(stderr: string): boolean {
  return /PSSecurityException|UnauthorizedAccess,\s*Microsoft\.PowerShell\.Commands|execution of scripts is disabled|running scripts is disabled|not digitally signed/i.test(
    stderr,
  )
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
