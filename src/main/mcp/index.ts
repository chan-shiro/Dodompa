/**
 * In-process MCP streamable-HTTP server.
 *
 * Runs alongside the debug HTTP server on port 19876. Exposes the Dodompa
 * task-management tool set so Claude Code (and any other MCP client that
 * supports streamable-HTTP) can drive the app with a one-line config:
 *
 *   { "type": "http", "url": "http://127.0.0.1:19876/mcp" }
 *
 * Session model: stateful (per-connection transport). A Map keyed by the
 * `Mcp-Session-Id` header holds transports; each session gets its own
 * `McpServer` instance.
 *
 * For stdio-only clients (Claude Desktop), use the thin proxy shipped in
 * `mcp/src/stdio-bridge.ts` which forwards stdio JSON-RPC to this endpoint.
 */

import type { IncomingMessage, ServerResponse } from 'http'
import { randomUUID } from 'crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { registerDodompaTools, DODOMPA_MCP_INSTRUCTIONS } from './tools'

const transports: Record<string, StreamableHTTPServerTransport> = {}

function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'dodompa', version: '1.0.0' },
    { instructions: DODOMPA_MCP_INSTRUCTIONS },
  )
  registerDodompaTools(server)
  return server
}

/**
 * Handle an HTTP request for the `/mcp` endpoint.
 * Returns `true` if the request was handled, `false` if routing should fall
 * through to the next handler.
 */
export async function handleMcpHttp(
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody: unknown,
): Promise<void> {
  const sessionId = (req.headers['mcp-session-id'] as string | undefined) ?? undefined
  let transport = sessionId ? transports[sessionId] : undefined

  if (!transport) {
    if (req.method !== 'POST' || !isInitializeRequest(parsedBody)) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'No valid session ID provided or request is not initialize' },
        id: null,
      }))
      return
    }

    const newTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports[id] = newTransport
      },
    })
    newTransport.onclose = () => {
      if (newTransport.sessionId) delete transports[newTransport.sessionId]
    }

    const server = buildServer()
    await server.connect(newTransport)
    transport = newTransport
  }

  await transport.handleRequest(req, res, parsedBody)
}
