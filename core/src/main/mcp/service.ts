// MCP server LIFECYCLE (GOAL "Always-On MCP Server", issue #54): one handle for
// the whole process, plus the restart-in-place the settings window drives.
//
// WHY this is a module of its own. server.ts knows how to bind a socket; it
// deliberately does not know whether it SHOULD. Whether the server runs is a
// policy question with two different answers — at app start it obeys
// mcpEnabled AND mcpAutoStart, while every LATER decision (the "Enable MCP
// server" switch, [Restart]) obeys mcpEnabled alone, because flipping that
// switch or pressing that button IS the manual start mcpAutoStart says the app
// must not perform on its own.
//
// "Enable MCP server" IS the on/off switch, not a note for next launch (v0.1.6):
// unchecking it stops the running server now and checking it starts one now. A
// checkbox that reads "Enable MCP server" while a server keeps answering
// requests is the same lie as a tray icon that claims to be recording, and it is
// what this release exists to remove.
//
// RESTARTING TOUCHES NOTHING ELSE. A restart closes one HTTP server and one
// pack-index watcher and creates new ones. The replay buffer, the global hotkey
// and any open editor never learn that it happened — which is the whole point:
// changing a port used to cost a full app restart, i.e. the recording of the
// last 30 seconds.
import type { McpStatus, McpStoppedReason } from '../../shared/ipc'
import type { Settings } from '../../shared/types'
import { startMcpServer } from './server'
import type { McpServerHandle } from './server'

let handle: McpServerHandle | null = null
// The status while no handle exists — i.e. WHY there is nothing to ask.
let idleStatus: McpStatus = stoppedStatus('disabled', 0)
// A copy of the settings the running (or last attempted) server was started
// with. The settings window's "press Restart to apply" hints compare the live
// settings against THIS, so a hint appears the moment a relevant key diverges
// and disappears the moment a restart has actually applied it.
let applied: Settings | null = null

function stoppedStatus(reason: McpStoppedReason, configuredPort: number): McpStatus {
  return { state: 'stopped', endpoint: '', port: 0, configuredPort, reason, detail: '' }
}

// Lifecycle changes run ONE AT A TIME. [Restart] disables itself while it works,
// but the "Enable MCP server" switch cannot: a fast off/on is two clicks, and
// without this queue the second one would try to bind a port the first one's
// socket has not released yet and the row would report "port {n} is already in
// use" — the app lying about itself, which is precisely what issue #54's live
// status row exists to prevent.
let lifecycle: Promise<void> = Promise.resolve()

function serialize<T>(op: () => Promise<T>): Promise<T> {
  const run = lifecycle.then(op, op)
  // The tail never rejects, or one failed transition would poison every later
  // one. Each caller still sees its own result (or its own throw) via `run`.
  lifecycle = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * Starts the server at app startup, honoring both mcpEnabled and mcpAutoStart.
 * `settings` is the LIVE object main shares, so request-time reads follow the
 * user's changes; only the hint snapshot is copied.
 */
export function startMcpAtBoot(settings: Settings): void {
  if (!settings.mcpEnabled) {
    applied = { ...settings }
    idleStatus = stoppedStatus('disabled', settings.mcpPort)
    return
  }
  if (!settings.mcpAutoStart) {
    applied = { ...settings }
    idleStatus = stoppedStatus('autostart-off', settings.mcpPort)
    return
  }
  launch(settings)
}

/**
 * Brings the server in line with the CURRENT settings — stopping whatever runs
 * and starting a new one when mcpEnabled says so — and resolves with what
 * actually happened (bound on which port / stopped and why / failed and why).
 * mcpAutoStart is deliberately not consulted; see the file header.
 *
 * This is BOTH [Restart] and the "Enable MCP server" switch: the two mean the
 * same thing to the server ("make reality match these settings"), and having one
 * implementation is what keeps the status row and the running socket from ever
 * disagreeing about which of them won.
 */
export function restartMcpServer(settings: Settings): Promise<McpStatus> {
  return serialize(async () => {
    await stopInPlace()
    if (!settings.mcpEnabled) {
      applied = { ...settings }
      idleStatus = stoppedStatus('disabled', settings.mcpPort)
      return mcpStatus()
    }
    const started = launch(settings)
    // Waiting for the bind to settle is what turns the switch and [Restart] into
    // an answer rather than a hope: listen() and its error are both asynchronous.
    return started.ready()
  })
}

/** Stops the server (app shutdown). */
export function stopMcpServer(): Promise<void> {
  return serialize(stopInPlace)
}

/** The stop itself, already inside the lifecycle queue. */
async function stopInPlace(): Promise<void> {
  const current = handle
  handle = null
  if (current === null) return
  idleStatus = stoppedStatus('stopped', applied?.mcpPort ?? 0)
  try {
    await current.stop()
  } catch (err) {
    // A close() that refuses is not worth failing a restart (or a quit) over:
    // the next bind will report the real problem.
    console.error(
      'capturepack: stopping the MCP server failed:',
      err instanceof Error ? err.message : String(err),
    )
  }
}

/** The LIVE state, read from the running server — never rebuilt from settings. */
export function mcpStatus(): McpStatus {
  return handle === null ? { ...idleStatus } : handle.status()
}

/**
 * The endpoint the running server bound, '' when nothing is listening. Every
 * surface that advertises the URL (welcome window, settings window, the setup
 * snippets) reads it from here so all of them agree.
 */
export function mcpEndpoint(): string {
  return handle === null ? '' : handle.endpoint()
}

/** The settings the running server honors, for the GUI's restart hints. */
export function mcpAppliedSettings(): Settings | null {
  return applied === null ? null : { ...applied }
}

function launch(settings: Settings): McpServerHandle {
  applied = { ...settings }
  const started = startMcpServer(settings)
  handle = started
  return started
}
