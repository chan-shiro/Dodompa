#!/usr/bin/env node
/**
 * Dodompa MCP stdio bridge
 *
 * Thin stdio-to-HTTP proxy that lets MCP clients without HTTP transport
 * support (notably Claude Desktop) talk to the Dodompa app's in-process
 * MCP server at http://127.0.0.1:19876/mcp.
 *
 * All tool definitions live in the Electron app (`src/main/mcp/tools.ts`);
 * this bridge forwards JSON-RPC messages at the transport layer, so tool
 * changes don't require bumping the bridge.
 *
 * Usage in claude_desktop_config.json:
 * {
 *   "mcpServers": {
 *     "dodompa": {
 *       "command": "npx",
 *       "args": ["-y", "tsx", "/path/to/Dodompa/mcp/src/stdio-bridge.ts"]
 *     }
 *   }
 * }
 *
 * Or, after `pnpm -C mcp build`:
 *     "args": ["/path/to/Dodompa/mcp/dist/stdio-bridge.js"]
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const DODOMPA_URL = process.env.DODOMPA_URL ?? 'http://127.0.0.1:19876'
const MCP_URL = new URL('/mcp', DODOMPA_URL)
const HEALTH_URL = new URL('/health', DODOMPA_URL)

function logStderr(msg: string): void {
  // stdout is the MCP JSON-RPC channel. All diagnostics must go to stderr.
  process.stderr.write(`[dodompa-mcp-bridge] ${msg}\n`)
}

async function checkDodompaRunning(): Promise<void> {
  try {
    const resp = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  } catch (e) {
    const message =
      `Dodompa アプリが起動していません (${HEALTH_URL} に接続できません)。\n` +
      `Dodompa.app を起動してから再度お試しください。\n` +
      `内部エラー: ${(e as Error).message}`
    logStderr(message)
    throw new Error(message)
  }
}

async function main(): Promise<void> {
  await checkDodompaRunning()

  const stdio = new StdioServerTransport()
  const http = new StreamableHTTPClientTransport(MCP_URL)

  // Serialize upstream sends: the HTTP client captures the session ID from
  // the initialize response header, so any message dispatched before that
  // response lands would POST without a session and be rejected. A promise
  // chain keeps sends in arrival order — simple and correct for stdio.
  let upstreamChain: Promise<unknown> = Promise.resolve()
  stdio.onmessage = (msg) => {
    upstreamChain = upstreamChain
      .then(() => http.send(msg))
      .catch((err) => {
        logStderr(`http.send failed: ${(err as Error).message}`)
      })
  }
  http.onmessage = (msg) => {
    stdio.send(msg).catch((err) => {
      logStderr(`stdio.send failed: ${(err as Error).message}`)
    })
  }

  stdio.onerror = (err) => logStderr(`stdio error: ${err.message}`)
  http.onerror = (err) => logStderr(`http error: ${err.message}`)

  stdio.onclose = () => {
    http.close().catch(() => {})
    process.exit(0)
  }
  http.onclose = () => {
    stdio.close().catch(() => {})
    process.exit(0)
  }

  await http.start()
  await stdio.start()
}

main().catch((err) => {
  logStderr(`fatal: ${(err as Error).stack ?? err}`)
  process.exit(1)
})
