import { app, BrowserWindow, shell, globalShortcut, screen, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initDb } from './db'
import { registerTaskHandlers } from './ipc/taskManager'
import { registerRunnerHandlers } from './ipc/taskRunner'
import { registerProfileHandlers } from './ipc/profileManager'
import { registerSettingsHandlers } from './ipc/settingsManager'
import { registerLogHandlers } from './ipc/logManager'
import { registerAiHandlers } from './ipc/aiService'
import { registerAiAgentHandlers } from './ipc/aiAgent'
import { registerDesktopHandlers } from './ipc/desktopService'
import { registerKnowledgeHandlers } from './ipc/knowledgeManager'
import { initScheduler } from './scheduler'
import { startDebugServer } from './debugServer'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.dodompa.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Initialize database
  initDb()

  // Register all IPC handlers
  registerTaskHandlers()
  registerRunnerHandlers()
  registerProfileHandlers()
  registerSettingsHandlers()
  registerLogHandlers()
  registerAiHandlers()
  registerAiAgentHandlers()
  registerDesktopHandlers()
  registerKnowledgeHandlers()

  // Initialize scheduler
  initScheduler()

  // HTTP server for MCP integration (port 19876)
  // Always enabled — Production MCP server proxies through this.
  startDebugServer()

  createWindow()

  // ─── Element Picker: global shortcut ───
  // Cmd+Shift+E: enter picker mode, then wait for next click
  let pickerActive = false
  globalShortcut.register('CmdOrCtrl+Shift+E', async () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win || win.isDestroyed()) return

    if (pickerActive) return // already waiting for click
    pickerActive = true

    // Notify UI that picker mode is active
    win.webContents.send('element-picker:result', {
      element: null,
      point: { x: 0, y: 0 },
      picking: true, // special flag: "waiting for click"
    })

    try {
      const { pickElement } = await import('./desktop/mac/axBridge')
      const { createDesktopContext } = await import('./desktop/platform')

      // Wait for the next click; the dodompa-ax binary swallows it so the
      // underlying app doesn't fire (avoids accidentally hitting Send/Delete).
      const result = await pickElement(30)
      const point = { x: Math.round(result.x), y: Math.round(result.y) }
      const element = result.element

      // Find the window at click position
      const ctx = await createDesktopContext()
      const windows = await ctx.getWindows()
      const containsCursor = (w: typeof windows[0]) => {
        if (!w.bounds) return false
        const b = w.bounds
        return point.x >= b.x && point.x <= b.x + b.width && point.y >= b.y && point.y <= b.y + b.height
      }
      const focusedMatch = windows.find(w => w.focused && containsCursor(w))
      const targetWindow = focusedMatch ?? windows
        .filter(containsCursor)
        .filter(w => w.app !== 'Finder' || (w.title && w.title !== ''))
        .sort((a, b) => {
          const areaA = (a.bounds?.width ?? 9999) * (a.bounds?.height ?? 9999)
          const areaB = (b.bounds?.width ?? 9999) * (b.bounds?.height ?? 9999)
          return areaA - areaB
        })[0] ?? windows.find(containsCursor)

      win.webContents.send('element-picker:user-picked', { element })
      win.webContents.send('element-picker:result', {
        element,
        point,
        app: targetWindow?.app ?? null,
        bundleId: targetWindow?.bundleId ?? null,
        pid: targetWindow?.pid ?? null,
      })
    } catch (err) {
      if (win && !win.isDestroyed()) {
        win.webContents.send('element-picker:result', {
          element: null, point: { x: 0, y: 0 },
          error: (err as Error).message,
        })
      }
    } finally {
      pickerActive = false
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
