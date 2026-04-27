import type { DesktopContext } from '../../shared/types'

export async function createDesktopContext(): Promise<DesktopContext> {
  if (process.platform === 'darwin') {
    const { createMacDesktopContext } = await import('./mac/index')
    return createMacDesktopContext()
  }
  if (process.platform === 'win32') {
    const { createWinDesktopContext } = await import('./win/index')
    return createWinDesktopContext()
  }
  throw new Error(`Desktop automation is not supported on ${process.platform}`)
}

export function isDesktopSupported(): boolean {
  return process.platform === 'darwin' // || process.platform === 'win32' in the future
}
