/**
 * Direct wrapper around the dodompa-ax Swift CLI binary.
 * No Electron dependency — runs as a standalone Node.js process.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import path from 'path'

const execFileAsync = promisify(execFile)

// Resolve the dodompa-ax binary path
function getAxBinaryPath(): string {
  // Look relative to this package (../resources/bin/dodompa-ax)
  const relPath = path.resolve(new URL('.', import.meta.url).pathname, '../../resources/bin/dodompa-ax')
  if (existsSync(relPath)) return relPath

  // Fallback: check PATH
  return 'dodompa-ax'
}

const AX_BIN = getAxBinaryPath()

async function runAx(args: string[], timeout = 15000): Promise<string> {
  const { stdout } = await execFileAsync(AX_BIN, args, { timeout })
  return stdout
}

// ─── Types ───

export interface WindowInfo {
  pid: number
  app: string | null
  bundleId: string | null
  title: string | null
  bounds: { x: number; y: number; width: number; height: number } | null
  focused: boolean
}

export interface AXNode {
  role: string | null
  title: string | null
  value: string | null
  description: string | null
  enabled: boolean
  focused: boolean
  position: { x: number; y: number } | null
  size: { width: number; height: number } | null
  path: string
  actions: string[]
  children?: AXNode[]
}

// ─── Window & AX Tree ───

export async function listWindows(): Promise<WindowInfo[]> {
  const json = await runAx(['list-windows'])
  return JSON.parse(json)
}

export async function getAccessibilityTree(pid: number, depth = 10): Promise<AXNode> {
  const json = await runAx(['tree', '--pid', String(pid), '--depth', String(depth)], 20000)
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

// ─── App Resolution ───

export async function resolveAppToPid(appOrPid: string | number): Promise<number> {
  if (typeof appOrPid === 'number') return appOrPid

  const windows = await listWindows()
  const lower = appOrPid.toLowerCase()

  // Exact bundleId
  const bundleMatch = windows.find(w => w.bundleId?.toLowerCase() === lower)
  if (bundleMatch) return bundleMatch.pid

  // Partial match on app name, title, or bundleId
  const match = windows.find(
    w => w.app?.toLowerCase().includes(lower) || w.title?.toLowerCase().includes(lower) || w.bundleId?.toLowerCase().includes(lower)
  )
  if (match) return match.pid

  // pgrep fallback
  try {
    const { stdout } = await execFileAsync('pgrep', ['-fi', appOrPid], { timeout: 3000 })
    const pid = parseInt(stdout.trim().split('\n')[0])
    if (!isNaN(pid)) return pid
  } catch { /* */ }

  throw new Error(`App not found: ${appOrPid}`)
}

// ─── Tree Search ───

function titleMatches(node: AXNode, search: string): boolean {
  if (node.title && node.title.toLowerCase().includes(search.toLowerCase())) return true
  if (node.description && node.description.toLowerCase().includes(search.toLowerCase())) return true
  return false
}

export function findElementInTree(
  node: AXNode,
  query: { role?: string; title?: string; value?: string }
): AXNode | null {
  if (
    (!query.role || node.role === query.role) &&
    (!query.title || titleMatches(node, query.title)) &&
    (!query.value || node.value?.includes(query.value))
  ) {
    return node
  }
  if (node.children) {
    for (const child of node.children) {
      const found = findElementInTree(child, query)
      if (found) return found
    }
  }
  return null
}

export function findAllElementsInTree(
  node: AXNode,
  query: { role?: string; title?: string; value?: string }
): AXNode[] {
  const results: AXNode[] = []
  if (
    (!query.role || node.role === query.role) &&
    (!query.title || titleMatches(node, query.title)) &&
    (!query.value || node.value?.includes(query.value))
  ) {
    results.push(node)
  }
  if (node.children) {
    for (const child of node.children) {
      results.push(...findAllElementsInTree(child, query))
    }
  }
  return results
}
