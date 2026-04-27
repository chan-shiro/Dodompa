/**
 * HTTP server on port 19876 that serves two concerns:
 *  1. **Dev/debug endpoints** (`/ipc/:channel`, `/db/query`, `/emit/:channel`,
 *     `/eval`, `/health`) used while developing Dodompa itself.
 *  2. **Production MCP streamable-HTTP endpoint** (`/mcp`) — end users
 *     point Claude Code at `http://127.0.0.1:19876/mcp`; Claude Desktop
 *     users run the stdio bridge in `mcp/src/stdio-bridge.ts` which
 *     forwards here.
 *
 * The server is always started (including in packaged builds) so that the
 * MCP endpoint is available whenever the Dodompa app is running.
 */

import http from 'http'
import { ipcMain, BrowserWindow } from 'electron'
import { getDb } from './db'
import { handleMcpHttp } from './mcp'

const PORT = 19876

export function startDebugServer(): void {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(200)
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
    const pathname = url.pathname

    try {
      // MCP streamable-HTTP endpoint. Consumes its own body, so handle
      // before any other `readBody()` call would swallow it.
      if (pathname === '/mcp') {
        const raw = req.method === 'POST' ? await readBody(req) : ''
        const parsed = raw ? JSON.parse(raw) : undefined
        await handleMcpHttp(req, res, parsed)
        return
      }

      // Health check
      if (pathname === '/health') {
        res.writeHead(200)
        res.end(JSON.stringify({ ok: true, pid: process.pid }))
        return
      }

      // SQL query (read-only)
      if (pathname === '/db/query' && req.method === 'GET') {
        const sql = url.searchParams.get('sql')
        if (!sql) {
          res.writeHead(400)
          res.end(JSON.stringify({ error: 'Missing sql parameter' }))
          return
        }
        const db = getDb()
        const rows = db.prepare(sql).all()
        res.writeHead(200)
        res.end(JSON.stringify({ rows, count: rows.length }))
        return
      }

      // Invoke IPC handler
      if (pathname.startsWith('/ipc/') && req.method === 'POST') {
        const channel = pathname.slice(5) // remove '/ipc/'
        const body = await readBody(req)
        const args = JSON.parse(body || '[]')

        // Use ipcMain's internal handler map
        const result = await invokeIpcHandler(channel, args)
        res.writeHead(200)
        res.end(JSON.stringify({ channel, result }))
        return
      }

      // Send event to renderer → triggers ipcMain.on handlers
      // Used for fire-and-forget channels like ai:startAutonomousGeneration
      if (pathname.startsWith('/emit/') && req.method === 'POST') {
        const channel = pathname.slice(6) // remove '/emit/'
        const body = await readBody(req)
        const params = JSON.parse(body || '{}')
        const win = BrowserWindow.getAllWindows()[0]
        if (!win) {
          res.writeHead(500)
          res.end(JSON.stringify({ error: 'No BrowserWindow found' }))
          return
        }
        // Simulate the event as if it came from the renderer
        // We need to emit on ipcMain directly with a fake event
        const fakeEvent = { sender: win.webContents, returnValue: undefined, reply: () => {}, senderFrame: win.webContents.mainFrame } as unknown as Electron.IpcMainEvent
        ipcMain.emit(channel, fakeEvent, params)
        res.writeHead(200)
        res.end(JSON.stringify({ ok: true, channel, message: 'Event emitted' }))
        return
      }

      // Eval JS in main process (dangerous — dev only!)
      if (pathname === '/eval' && req.method === 'POST') {
        const body = await readBody(req)
        const { code } = JSON.parse(body)
        // eslint-disable-next-line no-eval
        const result = await eval(`(async () => { ${code} })()`)
        res.writeHead(200)
        res.end(JSON.stringify({ result }))
        return
      }

      res.writeHead(404)
      res.end(JSON.stringify({ error: 'Not found' }))
    } catch (err) {
      res.writeHead(500)
      res.end(JSON.stringify({ error: (err as Error).message, stack: (err as Error).stack }))
    }
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[DEBUG] Port ${PORT} already in use, skipping debug server`)
    } else {
      console.error(`[DEBUG] Debug server error:`, err)
    }
  })

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[DEBUG] Debug server running at http://127.0.0.1:${PORT}`)
  })
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
  })
}

/**
 * Invoke an IPC handler registered via ipcMain.handle().
 * This reaches into Electron internals to call the handler directly.
 */
async function invokeIpcHandler(channel: string, args: unknown[]): Promise<unknown> {
  // Access internal handler map
  const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, Function> })._invokeHandlers
  if (!handlers) {
    // Fallback: try accessing via private Electron API
    throw new Error(`Cannot access IPC handlers. Channel: ${channel}`)
  }
  const handler = handlers.get(channel)
  if (!handler) {
    const available = Array.from(handlers.keys())
    throw new Error(`No handler for channel "${channel}". Available: ${available.join(', ')}`)
  }
  // Call with a fake event object that includes the main window's webContents
  // so BrowserWindow.fromWebContents() works for handlers that need it
  const mainWin = BrowserWindow.getAllWindows()[0]
  const sender = mainWin?.webContents ?? { send: () => {} }
  const fakeEvent = { sender, senderFrame: null }
  return await handler(fakeEvent, ...args)
}
