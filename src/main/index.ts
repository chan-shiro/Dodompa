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
      // Wait for the user's next click using a Python/Quartz one-shot listener
      const { execFile: execFileCb } = await import('child_process')
      const { promisify } = await import('util')
      const execFileAsync = promisify(execFileCb)

      const pyScript = `
import Quartz
import json
import sys

def wait_for_click():
    """Wait for the next mouse-down event and return its coordinates."""
    tap = Quartz.CGEventTapCreate(
        Quartz.kCGSessionEventTap,
        Quartz.kCGHeadInsertEventTap,
        Quartz.kCGEventTapOptionListenOnly,
        Quartz.CGEventMaskBit(Quartz.kCGEventLeftMouseDown),
        lambda proxy, type, event, refcon: None,
        None
    )
    if not tap:
        print(json.dumps({"error": "Failed to create event tap"}))
        sys.exit(1)

    source = Quartz.CFMachPortCreateRunLoopSource(None, tap, 0)
    loop = Quartz.CFRunLoopGetCurrent()
    Quartz.CFRunLoopAddSource(loop, source, Quartz.kCFRunLoopDefaultMode)
    Quartz.CGEventTapEnable(tap, True)

    # Run loop until we get one event
    class State:
        got_event = False
        x = 0
        y = 0

    def callback(proxy, type, event, refcon):
        loc = Quartz.CGEventGetLocation(event)
        State.x = loc.x
        State.y = loc.y
        State.got_event = True
        Quartz.CFRunLoopStop(loop)
        return None

    # Re-create tap with actual callback
    Quartz.CGEventTapEnable(tap, False)
    Quartz.CFRunLoopRemoveSource(loop, source, Quartz.kCFRunLoopDefaultMode)

    tap2 = Quartz.CGEventTapCreate(
        Quartz.kCGSessionEventTap,
        Quartz.kCGHeadInsertEventTap,
        Quartz.kCGEventTapOptionListenOnly,
        Quartz.CGEventMaskBit(Quartz.kCGEventLeftMouseDown),
        callback,
        None
    )
    source2 = Quartz.CFMachPortCreateRunLoopSource(None, tap2, 0)
    Quartz.CFRunLoopAddSource(loop, source2, Quartz.kCFRunLoopDefaultMode)
    Quartz.CGEventTapEnable(tap2, True)

    Quartz.CFRunLoopRunInMode(Quartz.kCFRunLoopDefaultMode, 30.0, False)

    if State.got_event:
        print(json.dumps({"x": State.x, "y": State.y}))
    else:
        print(json.dumps({"error": "timeout"}))

wait_for_click()
`
      const { stdout } = await execFileAsync('python3', ['-c', pyScript], { timeout: 35000 })
      const clickResult = JSON.parse(stdout.trim())

      if (clickResult.error) {
        win.webContents.send('element-picker:result', {
          element: null, point: { x: 0, y: 0 },
          error: clickResult.error,
        })
        return
      }

      const point = { x: Math.round(clickResult.x), y: Math.round(clickResult.y) }
      const { createDesktopContext } = await import('./desktop/platform')
      const ctx = await createDesktopContext()
      const element = await ctx.elementAtPoint(point.x, point.y)

      // Find the window at click position
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
