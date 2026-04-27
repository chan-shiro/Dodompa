import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import fs from 'fs'
import { app } from 'electron'
import type { WindowInfo, AXNode } from '../../../shared/types'

const execFileAsync = promisify(execFile)

function getAxBinaryPath(): string {
  // Development: resources/bin/dodompa-ax relative to project root
  const devPath = path.join(app.getAppPath(), 'resources', 'bin', 'dodompa-ax')
  if (fs.existsSync(devPath)) return devPath

  // Packaged: process.resourcesPath/bin/dodompa-ax
  const prodPath = path.join(process.resourcesPath, 'bin', 'dodompa-ax')
  if (fs.existsSync(prodPath)) return prodPath

  throw new Error('dodompa-ax binary not found. Run: sh scripts/build-ax.sh')
}

async function runAx(args: string[], timeout = 10000): Promise<string> {
  const binPath = getAxBinaryPath()
  const { stdout } = await execFileAsync(binPath, args, { timeout, maxBuffer: 10 * 1024 * 1024 })
  return stdout
}

export async function listWindows(): Promise<WindowInfo[]> {
  const json = await runAx(['list-windows'])
  return JSON.parse(json)
}

export async function getAccessibilityTree(pid: number, depth = 10): Promise<AXNode> {
  const json = await runAx(['tree', '--pid', String(pid), '--depth', String(depth)], 15000)
  return JSON.parse(json)
}

export async function findElements(pid: number, role: string, title?: string): Promise<AXNode[]> {
  const args = ['find', '--pid', String(pid), '--role', role]
  if (title) args.push('--title', title)
  const json = await runAx(args)
  return JSON.parse(json)
}

export async function elementAtPoint(x: number, y: number): Promise<AXNode | null> {
  try {
    const json = await runAx(['element-at', '--x', String(x), '--y', String(y)])
    return JSON.parse(json)
  } catch {
    return null
  }
}

export async function performAction(pid: number, elementPath: string, action: string): Promise<void> {
  await runAx(['perform-action', '--pid', String(pid), '--path', elementPath, '--action', action])
}

// Resolve app name to PID.
//
// Chrome / Electron / VSCode etc. spawn multiple helper processes (GPU,
// Renderer, Utility, Plugin Host) that share the same bundleId and sometimes
// even the same `.app` label. Picking the first match by substring often
// lands on a helper with zero windows, and the downstream `getAccessibilityTree`
// comes back empty — breaking any step that tried to target the app.
//
// Fix: rank every candidate and pick the "main" instance.
//   +100  : has a visible window (shows up in listWindows)
//   +50   : bundleId exact match
//   +25   : app name exact match (case-insensitive)
//   +10   : focused (frontmost) at query time
//   +1×N  : number of windows this PID owns (tiebreaker)
// The best score wins. pgrep is still a last-resort for background daemons.
export async function resolveAppToPid(appOrPid: string | number): Promise<number> {
  if (typeof appOrPid === 'number') return appOrPid

  // Special macOS system processes that don't appear in normal window list
  const specialApps: Record<string, string> = {
    spotlight: 'com.apple.Spotlight',
    finder: 'com.apple.finder',
    dock: 'com.apple.dock',
    'system preferences': 'com.apple.systempreferences',
    'system settings': 'com.apple.systempreferences',
  }

  const windows = await listWindows()
  const lower = appOrPid.toLowerCase()

  // Count how many windows each PID owns (tiebreaker favoring main processes)
  const pidWindowCount = new Map<number, number>()
  for (const w of windows) {
    pidWindowCount.set(w.pid, (pidWindowCount.get(w.pid) ?? 0) + 1)
  }

  // Collect candidates — same PID may appear multiple times via different
  // windows, so we aggregate per PID.
  type Candidate = { pid: number; score: number; reason: string[] }
  const byPid = new Map<number, Candidate>()
  const bump = (pid: number, delta: number, reason: string): void => {
    const existing = byPid.get(pid)
    if (existing) {
      existing.score += delta
      existing.reason.push(reason)
    } else {
      byPid.set(pid, { pid, score: delta, reason: [reason] })
    }
  }

  for (const w of windows) {
    const bundleId = w.bundleId?.toLowerCase() ?? ''
    const appName = w.app?.toLowerCase() ?? ''
    const titleStr = w.title?.toLowerCase() ?? ''

    let matched = false
    if (bundleId === lower) {
      bump(w.pid, 150, 'bundleId exact')
      matched = true
    }
    if (appName === lower) {
      bump(w.pid, 125, 'app exact')
      matched = true
    }
    if (specialApps[lower] && bundleId === specialApps[lower].toLowerCase()) {
      bump(w.pid, 130, 'special-app bundleId')
      matched = true
    }
    if (!matched) {
      if (bundleId.includes(lower)) {
        bump(w.pid, 60, 'bundleId includes')
        matched = true
      } else if (appName.includes(lower)) {
        bump(w.pid, 55, 'app includes')
        matched = true
      } else if (titleStr.includes(lower)) {
        bump(w.pid, 30, 'title includes')
        matched = true
      }
    }
    if (matched) {
      bump(w.pid, 100, 'has window')
      if (w.focused) bump(w.pid, 10, 'focused')
    }
  }

  // Add window-count tiebreaker
  for (const [pid, c] of byPid) {
    const n = pidWindowCount.get(pid) ?? 0
    c.score += n // +1 per owned window
  }

  if (byPid.size > 0) {
    const ranked = Array.from(byPid.values()).sort((a, b) => b.score - a.score)
    return ranked[0].pid
  }

  // Try using pgrep as fallback for processes without windows
  try {
    const { stdout } = await execFileAsync('pgrep', ['-fi', appOrPid], { timeout: 3000 })
    const pid = parseInt(stdout.trim().split('\n')[0])
    if (!isNaN(pid)) return pid
  } catch { /* pgrep might not find it */ }

  throw new Error(`App not found: ${appOrPid}. Available: ${windows.map(w => w.title || w.bundleId).filter(Boolean).join(', ')}`)
}
