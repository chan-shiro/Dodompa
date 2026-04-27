/**
 * Internal bridge for in-process MCP tools to talk to the Electron app.
 *
 * `mcp/src/production.ts` used to do this over HTTP (fetch → /ipc/:channel).
 * Now the MCP server lives inside the Electron main process, so it calls
 * IPC handlers and the DB directly. Same behavior, no network round-trip.
 */

import { ipcMain, BrowserWindow } from 'electron'
import type { IpcMainEvent } from 'electron'
import { getDb } from '../db'

/** Invoke an IPC handler registered via `ipcMain.handle()`. */
export async function invokeIpc(channel: string, ...args: unknown[]): Promise<unknown> {
  const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, (e: unknown, ...a: unknown[]) => unknown> })._invokeHandlers
  if (!handlers) throw new Error(`Cannot access IPC handlers (channel: ${channel})`)
  const handler = handlers.get(channel)
  if (!handler) {
    const available = Array.from(handlers.keys())
    throw new Error(`No handler for channel "${channel}". Available: ${available.join(', ')}`)
  }
  const mainWin = BrowserWindow.getAllWindows()[0]
  const sender = mainWin?.webContents ?? { send: () => {} }
  const fakeEvent = { sender, senderFrame: null }
  return await handler(fakeEvent, ...args)
}

/** Fire a renderer-targeted IPC event (for `ipcMain.on` handlers). */
export function emitIpc(channel: string, params: unknown): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) throw new Error('No BrowserWindow found — is the Dodompa UI open?')
  const fakeEvent = {
    sender: win.webContents,
    returnValue: undefined,
    reply: () => {},
    senderFrame: win.webContents.mainFrame,
  } as unknown as IpcMainEvent
  ipcMain.emit(channel, fakeEvent, params)
}

/** Run a read-only SQL query against the app's sqlite DB. */
export function dbQuery(sql: string): unknown[] {
  return getDb().prepare(sql).all()
}
