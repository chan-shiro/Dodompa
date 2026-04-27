import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import os from 'os'

const execFileAsync = promisify(execFile)

export async function captureScreen(): Promise<Buffer> {
  const tmpFile = path.join(os.tmpdir(), `dodompa-screenshot-${Date.now()}.jpg`)
  try {
    // Use JPEG (-t jpg) to keep file size under API limits (5MB max for Anthropic)
    await execFileAsync('screencapture', ['-x', '-C', '-t', 'jpg', tmpFile], { timeout: 5000 })
    let buf = fs.readFileSync(tmpFile)
    fs.unlinkSync(tmpFile)

    // Check if screenshot is essentially empty (Screen Recording permission denied)
    if (buf.length < 1000) {
      console.warn('[screenshot] Screen capture returned very small file — likely permission denied')
      return Buffer.alloc(0)
    }

    // If still too large, resize with sips
    if (buf.length > 4 * 1024 * 1024) {
      const resizedFile = path.join(os.tmpdir(), `dodompa-screenshot-resized-${Date.now()}.jpg`)
      fs.writeFileSync(resizedFile, buf)
      await execFileAsync('sips', ['--resampleWidth', '1280', '--setProperty', 'formatOptions', '70', resizedFile], { timeout: 5000 })
      buf = fs.readFileSync(resizedFile)
      fs.unlinkSync(resizedFile)
    }
    return buf
  } catch (err) {
    // Graceful fallback: return empty buffer instead of crashing
    console.warn('[screenshot] captureScreen failed:', (err as Error).message)
    try { fs.unlinkSync(tmpFile) } catch { /* file may not exist */ }
    return Buffer.alloc(0)
  }
}

export async function captureWindow(pid: number): Promise<Buffer> {
  const tmpFile = path.join(os.tmpdir(), `dodompa-screenshot-${Date.now()}.jpg`)
  try {
    // Get window ID from pid using AppleScript
    const { stdout } = await execFileAsync(
      'osascript',
      [
        '-e',
        `tell application "System Events" to get id of first window of (first process whose unix id is ${pid})`,
      ],
      { timeout: 5000 }
    )
    const windowId = stdout.trim()

    try {
      await execFileAsync('screencapture', ['-x', '-l', windowId, '-t', 'jpg', tmpFile], { timeout: 5000 })
    } catch {
      await execFileAsync('screencapture', ['-x', '-C', '-t', 'jpg', tmpFile], { timeout: 5000 })
    }
    let buf = fs.readFileSync(tmpFile)
    fs.unlinkSync(tmpFile)

    // Check if screenshot is essentially empty (Screen Recording permission denied)
    if (buf.length < 1000) {
      console.warn(`[screenshot] Window capture for PID ${pid} returned very small file — likely permission denied`)
      return Buffer.alloc(0)
    }
    return buf
  } catch (err) {
    // Graceful fallback: return empty buffer instead of crashing
    console.warn(`[screenshot] captureWindow(${pid}) failed:`, (err as Error).message)
    try { fs.unlinkSync(tmpFile) } catch { /* file may not exist */ }
    return Buffer.alloc(0)
  }
}

export async function captureRegion(
  x: number,
  y: number,
  w: number,
  h: number
): Promise<Buffer> {
  const tmpFile = path.join(os.tmpdir(), `dodompa-screenshot-${Date.now()}.jpg`)
  await execFileAsync('screencapture', ['-x', '-R', `${x},${y},${w},${h}`, '-t', 'jpg', tmpFile], {
    timeout: 5000,
  })
  const buf = fs.readFileSync(tmpFile)
  fs.unlinkSync(tmpFile)
  return buf
}
