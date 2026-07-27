// Always-on MCP server: Streamable HTTP on 127.0.0.1:<mcpPort>/mcp, stateless
// (a fresh McpServer + transport per request, per SDK guidance), read-only.
// Runs inside the Electron main process and must never crash the app.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { app } from 'electron'
import * as http from 'node:http'
import type { Settings } from '../../shared/types'
import { createPackStore } from './store'
import { registerTools } from './tools'

const MCP_PATH = '/mcp'
const BIND_HOST = '127.0.0.1'

export interface McpServerHandle {
  stop(): Promise<void>
}

/** Starts the MCP server per settings; returns null when disabled. Never throws. */
export function startMcpServer(settings: Settings): McpServerHandle | null {
  if (!settings.mcpEnabled || !settings.mcpAutoStart) return null
  if (!settings.mcpReadOnly) {
    // The read-only guarantee is unconditional in this version; the key exists
    // so a future opt-in write mode has a stable name.
    console.log('capturepack: mcpReadOnly=false is ignored — this version of the MCP server is always read-only.')
  }

  // Shared across requests: the pack index and the in-memory "current pack" pin.
  const store = createPackStore({
    outputDir: settings.outputDir,
    watch: settings.mcpWatchExportFolder,
  })

  const httpServer = http.createServer((req, res) => {
    // handleRequest catches everything itself; the extra catch is a last-resort
    // guard so no code path can raise an unhandled rejection in the main process.
    handleRequest(req, res).catch(() => {})
  })

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      let pathname: string
      try {
        pathname = new URL(req.url ?? '/', `http://${BIND_HOST}`).pathname
      } catch {
        pathname = ''
      }
      if (pathname !== MCP_PATH) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: `Not found. The MCP endpoint is ${MCP_PATH}.` }))
        return
      }
      // DNS-rebinding guard: a browser page on an attacker-controlled hostname
      // that resolves to 127.0.0.1 reaches this socket with the attacker's Host/
      // Origin. Binding to loopback does not prevent that — only header
      // validation does. Reject anything that is not local.
      if (!hostAllowed(req.headers.host, settings.mcpPort)) {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'Forbidden: the MCP endpoint only accepts local requests (bad Host header).' }))
        return
      }
      const origin = req.headers.origin
      if (typeof origin === 'string' && !originAllowed(origin)) {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'Forbidden: the MCP endpoint only accepts local requests (bad Origin header).' }))
        return
      }
      // Stateless mode: one short-lived McpServer + transport per request, so
      // concurrent clients never share protocol state. The store persists.
      const server = new McpServer({ name: 'capturepack', version: app.getVersion() })
      registerTools(server, store, { logRequests: settings.mcpLogRequests })
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
      res.on('close', () => {
        transport.close().catch(() => {})
        server.close().catch(() => {})
      })
      await server.connect(transport)
      await transport.handleRequest(req, res)
    } catch (err) {
      console.error('capturepack: mcp request failed:', err)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          }),
        )
      } else {
        res.end()
      }
    }
  }

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `capturepack: MCP port ${settings.mcpPort} is already in use — MCP server disabled for this run (the app keeps running).`,
      )
    } else {
      console.error('capturepack: MCP server error:', err.message)
    }
  })

  httpServer.listen(settings.mcpPort, BIND_HOST, () => {
    console.log(`capturepack: MCP server listening on http://${BIND_HOST}:${settings.mcpPort}${MCP_PATH}`)
  })

  return {
    stop(): Promise<void> {
      store.dispose()
      return new Promise((resolve) => {
        httpServer.close(() => resolve())
        // Idle keep-alive sockets would otherwise delay close on quit.
        httpServer.closeAllConnections()
      })
    },
  }
}

// Host must be loopback and, when a port is present, the MCP port. A missing
// port is accepted (loopback either way); a non-loopback hostname never is.
function hostAllowed(host: string | undefined, port: number): boolean {
  if (host === undefined) return false
  let url: URL
  try {
    url = new URL(`http://${host}`)
  } catch {
    return false
  }
  const name = url.hostname.toLowerCase()
  if (name !== '127.0.0.1' && name !== 'localhost') return false
  return url.port === '' || Number(url.port) === port
}

// A present Origin must be a local page (any port: local web tools may call the
// server cross-origin from e.g. http://localhost:3000, which is still the user's
// machine). Non-HTTP schemes and non-loopback hosts are rejected.
function originAllowed(origin: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const name = url.hostname.toLowerCase()
  return name === '127.0.0.1' || name === 'localhost'
}
