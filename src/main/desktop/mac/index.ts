import type { DesktopContext, AXNode, WindowInfo } from '../../../shared/types'
import * as ax from './axBridge'
import * as keyboard from './keyboard'
import * as mouse from './mouse'
import * as screenshot from './screenshot'

// Match title against node's title OR description
// macOS apps like Calculator have button labels in 'description' rather than 'title'
// Common synonyms for Calculator and other macOS apps (en→ja)
const SYNONYMS: Record<string, string[]> = {
  '=': ['計算実行', 'equals', 'equal'],
  'equals': ['計算実行', '='],
  'equal': ['計算実行', '='],
  '等号': ['計算実行', '=', 'equals'],
  'ac': ['すべて消去', 'all clear', 'clear'],
  'all clear': ['すべて消去', 'ac'],
  'c': ['削除', 'clear', 'delete'],
  'clear': ['削除', 'すべて消去'],
  '+': ['加算', 'add', 'plus'],
  'add': ['加算', '+'],
  'plus': ['加算', '+'],
  '-': ['減算', 'subtract', 'minus'],
  'subtract': ['減算', '-'],
  'minus': ['減算', '-'],
  '*': ['乗算', 'multiply', 'times'],
  '×': ['乗算', 'multiply', 'times'],
  'multiply': ['乗算', '×', '*'],
  'times': ['乗算', '×', '*'],
  '/': ['除算', 'divide'],
  '÷': ['除算', 'divide'],
  'divide': ['除算', '÷', '/'],
  '%': ['パーセント', 'percent'],
  'percent': ['パーセント', '%'],
  '.': ['小数点', 'decimal', 'point'],
  'decimal': ['小数点', '.'],
  '+/-': ['記号を変更', 'negate', 'sign'],
  'negate': ['記号を変更', '+/-'],
}

// Synonyms are only applied when the search token is a short symbol/acronym
// that would never make sense to cross-match between unrelated apps. This
// avoids spurious matches like "+" → "加算" in a Mail compose window.
function isCalculatorSymbolToken(search: string): boolean {
  // Single-char math operators or very short calc-specific tokens.
  if (/^[+\-*/=%÷×]$/.test(search)) return true
  if (search.length <= 3 && /^(ac|c|mc|m\+|m-|mr|=|\+\/-)$/i.test(search)) return true
  return false
}

function titleMatches(node: AXNode, searchTitle: string): boolean {
  const search = searchTitle.toLowerCase()
  const title = (node.title || '').toLowerCase()
  const desc = (node.description || '').toLowerCase()

  // Direct match (case insensitive, includes)
  if (title && title.includes(search)) return true
  if (desc && desc.includes(search)) return true
  // Reverse: search contains the node's label
  if (title && search.includes(title)) return true
  if (desc && search.includes(desc)) return true

  // Synonym matching — scoped to calculator-style short symbol tokens so
  // other apps don't get spurious matches (e.g. "+" in Mail compose should
  // not match "加算" from the calculator dictionary).
  if (isCalculatorSymbolToken(search)) {
    const synonyms = SYNONYMS[search]
    if (synonyms) {
      for (const syn of synonyms) {
        const synLower = syn.toLowerCase()
        if (title === synLower || desc === synLower) return true
        if (title.includes(synLower) || desc.includes(synLower)) return true
      }
    }
  }

  return false
}

// Walk the app root and return the subtree rooted at the AXWindow that best
// matches the options. Uses fuzzy title matching (normalized + includes) and
// falls back to the window with the most interactive descendants if nothing
// matches — this is far more forgiving than strict equality and survives
// dynamic title changes (unread counts, open-document names, etc.).
function findWindowSubtreeInApp(
  appRoot: AXNode,
  opts: { title?: string; index?: number } = {},
): AXNode | null {
  const windowRoles = ['AXWindow', 'AXSheet', 'AXDialog', 'AXDrawer']
  const candidates: AXNode[] = []
  for (const child of appRoot.children ?? []) {
    if (windowRoles.includes(child.role ?? '')) candidates.push(child)
  }
  if (candidates.length === 0) return null

  if (opts.index !== undefined) {
    return candidates[opts.index] ?? null
  }
  if (opts.title === undefined) {
    return candidates[0]
  }
  if (candidates.length === 1) return candidates[0]

  // Score each candidate
  const normalize = (s: string | undefined | null): string => {
    if (!s) return ''
    return s
      .replace(/^\s*(?:\(\s*\d+\s*\)|\[\s*\d+\s*\]|•|●|◉|\*)\s+/u, '')
      .replace(/\s*[-—–|·]\s*[^-—–|·]{1,40}$/u, '')
      .replace(/\s+/gu, ' ')
      .trim()
      .toLowerCase()
  }
  const target = opts.title
  const tn = normalize(target)
  let best: AXNode | null = null
  let bestScore = 0
  for (const c of candidates) {
    const cTitle = c.title ?? ''
    let score = 0
    if (cTitle === target) score = 1000
    else {
      const cn = normalize(cTitle)
      if (cn && cn === tn) score = 800
      else if (cn && tn && cn.startsWith(tn)) score = 600
      else if (cn && tn && tn.startsWith(cn)) score = 550
      else if (cn && tn && (cn.includes(tn) || tn.includes(cn))) score = 400
    }
    if (score > bestScore) {
      bestScore = score
      best = c
    }
  }
  if (best && bestScore > 0) return best

  // No title match — pick the window with the most interactive descendants.
  const countInteractive = (n: AXNode): number => {
    let c = 0
    if ((n.actions && n.actions.length > 0) || n.value) c++
    for (const ch of n.children ?? []) c += countInteractive(ch)
    return c
  }
  let fallback = candidates[0]
  let fallbackCount = countInteractive(fallback)
  for (const c of candidates.slice(1)) {
    const n = countInteractive(c)
    if (n > fallbackCount) {
      fallbackCount = n
      fallback = c
    }
  }
  return fallback
}

// Find the first window in an app subtree whose `focused` is true (or, as a
// fallback, any window whose `focused` child descendant is true).
function findFocusedWindowInApp(appRoot: AXNode): AXNode | null {
  const windowRoles = ['AXWindow', 'AXSheet', 'AXDialog', 'AXDrawer']
  // First pass: AXWindow nodes with focused=true
  for (const child of appRoot.children ?? []) {
    if (!windowRoles.includes(child.role ?? '')) continue
    if (child.focused) return child
  }
  // Second pass: AXWindow nodes whose subtree contains a focused element
  function hasFocusedDescendant(n: AXNode): boolean {
    if (n.focused) return true
    for (const c of n.children ?? []) if (hasFocusedDescendant(c)) return true
    return false
  }
  for (const child of appRoot.children ?? []) {
    if (!windowRoles.includes(child.role ?? '')) continue
    if (hasFocusedDescendant(child)) return child
  }
  // Fallback: first AXWindow
  for (const child of appRoot.children ?? []) {
    if (windowRoles.includes(child.role ?? '')) return child
  }
  return null
}

function findElementInTree(
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

function findAllElementsInTree(
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

export function createMacDesktopContext(): DesktopContext {
  return {
    async getWindows(): Promise<WindowInfo[]> {
      return ax.listWindows()
    },

    async getAccessibilityTree(appOrPid: string | number): Promise<AXNode> {
      const pid = await ax.resolveAppToPid(appOrPid)
      return ax.getAccessibilityTree(pid)
    },

    async getWindowTree(
      appOrPid: string | number,
      opts: { title?: string; index?: number } = {},
    ): Promise<AXNode | null> {
      const pid = await ax.resolveAppToPid(appOrPid)
      const appTree = await ax.getAccessibilityTree(pid)
      return findWindowSubtreeInApp(appTree, opts)
    },

    async getFocusedWindowTree(appOrPid: string | number): Promise<AXNode | null> {
      const pid = await ax.resolveAppToPid(appOrPid)
      const appTree = await ax.getAccessibilityTree(pid)
      // Prefer the AX "focused" flag; if that doesn't pan out, cross-reference
      // with listWindows() (which tracks frontmost+focused at OS level).
      const focused = findFocusedWindowInApp(appTree)
      if (focused) return focused
      const windows = await ax.listWindows()
      const osFocused = windows.find((w) => w.pid === pid && w.focused)
      if (osFocused?.title) {
        return findWindowSubtreeInApp(appTree, { title: osFocused.title })
      }
      return null
    },

    async getSubtree(
      appOrPid: string | number,
      opts: { path?: string; query?: { role?: string; title?: string; value?: string } },
    ): Promise<AXNode | null> {
      const pid = await ax.resolveAppToPid(appOrPid)
      // Deeper fetch for drill-down (vs the default 10): progressive calls
      // target a narrow subtree, so the extra depth doesn't bloat the caller.
      const appTree = await ax.getAccessibilityTree(pid, 15)

      if (opts.path) {
        // Walk the tree by comparing `node.path`. Every AXNode carries its
        // full pid-relative path (e.g. "0.0.2.1") that matches what the
        // formatter emits; we match on equality first, then prefix-walk to
        // tolerate minor dump/query drift.
        const target = opts.path
        const findByPath = (n: AXNode): AXNode | null => {
          if (n.path === target) return n
          for (const c of n.children ?? []) {
            const f = findByPath(c)
            if (f) return f
          }
          return null
        }
        return findByPath(appTree)
      }
      if (opts.query) {
        return findElementInTree(appTree, opts.query)
      }
      return appTree
    },

    findElement(
      tree: AXNode,
      query: { role?: string; title?: string; value?: string }
    ): AXNode | null {
      return findElementInTree(tree, query)
    },

    findElements(
      tree: AXNode,
      query: { role?: string; title?: string; value?: string }
    ): AXNode[] {
      return findAllElementsInTree(tree, query)
    },

    async screenshot(target?: {
      pid?: number
      region?: { x: number; y: number; width: number; height: number }
    }): Promise<Buffer> {
      if (target?.region) {
        return screenshot.captureRegion(
          target.region.x,
          target.region.y,
          target.region.width,
          target.region.height
        )
      }
      if (target?.pid) {
        return screenshot.captureWindow(target.pid)
      }
      return screenshot.captureScreen()
    },

    async click(x: number, y: number): Promise<void> {
      // Sanity check: refuse obviously-invalid coordinates so we don't click
      // at (0, 0) or random offscreen spots when the caller passed bogus data
      // from a stale/wrong AX node. Legitimate screen coords are small positive
      // numbers up to the union of all connected displays — we accept anything
      // 0 <= x <= 10000 and 0 <= y <= 10000 as "plausible" and reject others.
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error(`desktop.click: invalid coordinates (${x}, ${y}) — NaN or Infinity`)
      }
      if (x < 0 || y < 0 || x > 10000 || y > 10000) {
        throw new Error(`desktop.click: out-of-range coordinates (${x}, ${y}) — refusing to click. This usually means findElement returned an element from a hidden/offscreen window. Use getWindowTree() or getFocusedWindowTree() instead of getAccessibilityTree() to narrow to the target window.`)
      }
      if (x < 5 && y < 5) {
        throw new Error(`desktop.click: suspicious near-origin coordinates (${x}, ${y}) — refusing to click. This usually indicates stale/zero position data from a hidden AX element.`)
      }
      await mouse.click(x, y)
    },

    async doubleClick(x: number, y: number): Promise<void> {
      await mouse.doubleClick(x, y)
    },

    async rightClick(x: number, y: number): Promise<void> {
      await mouse.rightClick(x, y)
    },

    async type(text: string): Promise<void> {
      await keyboard.typeText(text)
    },

    async hotkey(...keys: string[]): Promise<void> {
      await keyboard.hotkey(...keys)
    },

    async pressKey(key: string): Promise<void> {
      await keyboard.pressKey(key)
    },

    async drag(
      from: { x: number; y: number },
      to: { x: number; y: number }
    ): Promise<void> {
      await mouse.drag(from.x, from.y, to.x, to.y)
    },

    async activateApp(appOrPid: string | number): Promise<void> {
      const { execFile: ef } = require('child_process')
      const { promisify: p } = require('util')
      // Always resolve to PID and use System Events — this avoids issues with
      // localized app names (e.g. "計算機") that AppleScript can't resolve
      // via `tell application "名前"`.
      let pid: number
      if (typeof appOrPid === 'number') {
        pid = appOrPid
      } else {
        pid = await ax.resolveAppToPid(appOrPid)
      }
      await p(ef)(
        'osascript',
        [
          '-e',
          `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`,
        ],
        { timeout: 5000 }
      )
    },

    async waitForElement(
      appOrPid: string | number,
      query: { role?: string; title?: string },
      timeout = 10000
    ): Promise<AXNode> {
      const start = Date.now()
      while (Date.now() - start < timeout) {
        try {
          // Resolve PID each iteration — the app may not be running yet
          const pid = await ax.resolveAppToPid(appOrPid)
          const tree = await ax.getAccessibilityTree(pid, 10)
          const el = findElementInTree(tree, query)
          if (el) return el

          // Fallback: if looking for AXWindow but not found, accept AXApplication
          // (some macOS apps like Calculator don't have AXWindow elements)
          if (query.role === 'AXWindow') {
            const appEl = findElementInTree(tree, { role: 'AXApplication' })
            if (appEl) return appEl
          }
        } catch {
          // App not found yet or AX tree unavailable — keep waiting
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      throw new Error(`Element not found within ${timeout}ms: ${JSON.stringify(query)}`)
    },

    async performAction(pid: number, elementPath: string, action: string): Promise<void> {
      await ax.performAction(pid, elementPath, action)
    },

    async elementAtPoint(x: number, y: number) {
      return ax.elementAtPoint(x, y)
    },

    async moveTo(x: number, y: number): Promise<void> {
      await mouse.moveTo(x, y)
    },
  }
}
