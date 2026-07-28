// MCP server LIFECYCLE (GOAL "Always-On MCP Server", issue #54): one handle for
// the whole process, plus the restart-in-place the settings window drives.
//
// WHY this is a module of its own. server.ts knows how to bind a socket; it
// deliberately does not know whether it SHOULD. Whether the server runs is a
// policy question with two different answers — at app start it obeys
// mcpEnabled AND mcpAutoStart, while [Restart] in Settings obeys mcpEnabled
// alone, because pressing that button IS the manual start that mcpAutoStart
// says the app must not perform on its own.
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
 * Stops and restarts the server with the CURRENT settings, and resolves with
 * what actually happened (bound on which port / failed and why). mcpAutoStart
 * is deliberately not consulted — see the file header.
 */
export async function restartMcpServer(settings: Settings): Promise<McpStatus> {
  await stopMcpServer()
  if (!settings.mcpEnabled) {
    applied = { ...settings }
    idleStatus = stoppedStatus('disabled', settings.mcpPort)
    return mcpStatus()
  }
  const started = launch(settings)
  // Waiting for the bind to settle is what turns [Restart] into an answer
  // rather than a hope: listen() and its error are both asynchronous.
  return started.ready()
}

/** Stops the server (app shutdown, or the first half of a restart). */
export async function stopMcpServer(): Promise<void> {
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
