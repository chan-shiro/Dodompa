import { ipcMain, systemPreferences } from 'electron'
import { createDesktopContext, isDesktopSupported } from '../desktop/platform'

export function registerDesktopHandlers(): void {
  ipcMain.handle('desktop:checkPermission', async () => {
    if (process.platform !== 'darwin') return { supported: false, trusted: false }
    const trusted = systemPreferences.isTrustedAccessibilityClient({ prompt: true })
    return { supported: true, trusted }
  })

  ipcMain.handle('desktop:isSupported', async () => {
    return isDesktopSupported()
  })

  ipcMain.handle('desktop:listWindows', async () => {
    const ctx = await createDesktopContext()
    return ctx.getWindows()
  })

  ipcMain.handle(
    'desktop:getTree',
    async (_event, pidOrApp: number | string, _depth?: number) => {
      const ctx = await createDesktopContext()
      const tree = await ctx.getAccessibilityTree(pidOrApp)
      return tree
    }
  )

  ipcMain.handle('desktop:screenshot', async (_event, target?: { pid?: number }) => {
    const ctx = await createDesktopContext()
    const buf = await ctx.screenshot(target)
    return buf.toString('base64')
  })

  ipcMain.handle('desktop:elementAtPoint', async (_event, x: number, y: number) => {
    const ctx = await createDesktopContext()
    return ctx.elementAtPoint(x, y)
  })
}
