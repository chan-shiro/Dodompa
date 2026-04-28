// ─── Analyzing Agent ───
// Responsible for page analysis (browser) and desktop analysis (screenshot + AX tree).
// Extracts interactive elements, selectors, and accessibility tree information.

import type { Page } from 'playwright-core'
import type { BrowserWindow } from 'electron'
import type { AiProviderConfig, AXNode, DesktopContext, StepPlan, WindowInfo } from '../../../shared/types'
import { sendAndLog } from './progressHelper'
import { matchTargetWindow } from './windowMatchAgent'

// ─── Browser: Extract interactive elements with verified selectors ───

export async function extractPageSelectors(page: Page): Promise<string> {
  try {
    const selectors = await page.evaluate(() => {
      const results: string[] = []
      const interactiveSelectors = [
        'a[href]', 'button', 'input', 'select', 'textarea',
        '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="tab"]',
        '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
        '[onclick]', '[type="submit"]', 'label',
        'h1', 'h2', 'h3',
      ].join(', ')
      const elements = document.querySelectorAll(interactiveSelectors)

      for (const el of Array.from(elements).slice(0, 120)) {
        try {
          const rect = el.getBoundingClientRect()
          if (rect.height === 0 || rect.width === 0) continue

          const tag = el.tagName.toLowerCase()
          const type = el.getAttribute('type') ?? ''
          const role = el.getAttribute('role') ?? ''
          const ariaLabel = el.getAttribute('aria-label') ?? ''
          const testId = el.getAttribute('data-testid') ?? el.getAttribute('data-test-id') ?? ''
          const id = el.id ?? ''
          const name = el.getAttribute('name') ?? ''
          const rawText = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
          const placeholder = el.getAttribute('placeholder') ?? ''

          let href = ''
          if (tag === 'a') {
            href = el.getAttribute('href') ?? ''
          }

          const verified: Array<{ sel: string; style: string }> = []

          if (testId) {
            const sel = `[data-testid="${testId}"]`
            if (document.querySelector(sel) === el) verified.push({ sel, style: 'css' })
          }
          if (id && !/^\d|^[a-f0-9-]{20,}|^:r|^react-|^rc-/.test(id)) {
            const sel = `#${CSS.escape(id)}`
            if (document.querySelector(sel) === el) verified.push({ sel, style: 'css' })
          }
          if (name) {
            const sel = `${tag}[name="${name}"]`
            if (document.querySelector(sel) === el) verified.push({ sel, style: 'css' })
          }
          if (type === 'submit' || type === 'email' || type === 'password' || type === 'search') {
            const sel = `${tag}[type="${type}"]`
            if (document.querySelectorAll(sel).length === 1) verified.push({ sel, style: 'css' })
          }

          const pwSels: string[] = []
          if (ariaLabel) pwSels.push(`page.getByRole('${role || tag}', { name: '${ariaLabel.replace(/'/g, "\\'")}' })`)
          if (placeholder) pwSels.push(`page.getByPlaceholder('${placeholder.replace(/'/g, "\\'")}')`)
          if (rawText && rawText.length <= 40 && ['button', 'a', 'label', 'h1', 'h2', 'h3'].includes(tag)) {
            pwSels.push(`page.getByText('${rawText.replace(/'/g, "\\'")}')`)
          }

          if (verified.length === 0 && pwSels.length === 0) continue

          const desc = [
            `<${tag}`,
            type ? ` type="${type}"` : '',
            role ? ` role="${role}"` : '',
            `>`,
            rawText ? ` "${rawText}"` : '',
            href ? ` href="${href}"` : '',
          ].join('')

          const allSels = [
            ...verified.map(v => v.sel),
            ...pwSels,
          ]

          results.push(`${desc}\n  → ${allSels.join('\n  → ')}`)
        } catch {
          // Skip this element on any error
        }
      }

      return results.join('\n\n')
    })

    return selectors
  } catch (e) {
    console.error('[analyzingAgent] extractPageSelectors failed:', e)
    return ''
  }
}

// ─── Browser: Prune HTML for AI consumption ───

/**
 * Extract a simplified, structure-preserving HTML representation from the page.
 * Runs inside the browser via page.evaluate() for efficiency.
 *
 * Removes: scripts, styles, SVGs, hidden elements, comments, data attributes,
 *          tracking pixels, noscript, iframes (content), template elements.
 * Preserves: semantic structure, interactive elements, text content, forms,
 *            ARIA attributes, links, images (alt text only).
 * Truncates: long text nodes, deeply nested decorative wrappers.
 */
export async function pruneHtmlForAi(page: Page, maxLength: number = 6000): Promise<string> {
  try {
    const pruned = await page.evaluate((limit: number) => {
      // Tags to completely remove (content and all)
      const REMOVE_TAGS = new Set([
        'script', 'style', 'noscript', 'template', 'iframe',
        'svg', 'canvas', 'video', 'audio', 'source', 'track',
        'link', 'meta', 'base',
        // common tracking/ad elements
        'ins', 'object', 'embed', 'applet',
      ])

      // Tags that are structural noise — unwrap (keep children, remove tag)
      const UNWRAP_TAGS = new Set([
        'span', 'font', 'b', 'i', 'u', 's', 'em', 'strong',
        'small', 'big', 'sub', 'sup', 'mark', 'abbr', 'cite',
      ])

      // Attributes worth keeping
      const KEEP_ATTRS = new Set([
        'id', 'class', 'href', 'src', 'alt', 'title', 'name',
        'type', 'value', 'placeholder', 'action', 'method',
        'for', 'role', 'aria-label', 'aria-labelledby',
        'aria-describedby', 'aria-expanded', 'aria-selected',
        'aria-checked', 'aria-hidden', 'data-testid',
        'disabled', 'readonly', 'required', 'checked', 'selected',
        'tabindex', 'target', 'rel',
      ])

      function isHidden(el: Element): boolean {
        if (!(el instanceof HTMLElement)) return false
        const style = window.getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden') return true
        if (el.getAttribute('aria-hidden') === 'true') return true
        // Zero-size elements (but not inputs which may be styled)
        if (el.tagName !== 'INPUT' && el.offsetWidth === 0 && el.offsetHeight === 0) return true
        return false
      }

      function processNode(node: Node, depth: number): string {
        if (depth > 15) return '' // prevent infinite recursion

        if (node.nodeType === Node.TEXT_NODE) {
          const text = (node.textContent ?? '').trim()
          if (!text) return ''
          // Truncate long text
          return text.length > 100 ? text.slice(0, 100) + '…' : text
        }

        if (node.nodeType !== Node.ELEMENT_NODE) return ''
        const el = node as Element
        const tag = el.tagName.toLowerCase()

        // Remove entire subtree for these tags
        if (REMOVE_TAGS.has(tag)) return ''

        // Skip hidden elements
        if (isHidden(el)) return ''

        // Process children first
        let childContent = ''
        for (const child of Array.from(el.childNodes)) {
          childContent += processNode(child, depth + 1)
        }

        // If no content and not interactive, skip
        const isInteractive = ['a', 'button', 'input', 'select', 'textarea', 'form', 'label', 'details', 'summary'].includes(tag)
        const hasRole = el.hasAttribute('role')
        if (!childContent.trim() && !isInteractive && !hasRole) return ''

        // Unwrap decorative inline tags
        if (UNWRAP_TAGS.has(tag)) return childContent

        // Build simplified tag
        let attrs = ''
        for (const attr of Array.from(el.attributes)) {
          if (!KEEP_ATTRS.has(attr.name)) continue
          let val = attr.value.trim()
          if (!val) continue
          // Truncate long class names
          if (attr.name === 'class') {
            const classes = val.split(/\s+/)
            // Keep only semantic-looking classes (skip utility/generated ones)
            const skipClassPattern = new RegExp('^[a-z]{1,3}-\\d|^_|^css-|^sc-|^tw-|^chakra-|^MuiS|^emotion|^svelte-|^\\[')
            const meaningful = classes.filter(c =>
              c.length > 2 && c.length < 40 && !skipClassPattern.test(c)
            )
            if (meaningful.length === 0) continue
            val = meaningful.slice(0, 3).join(' ')
          }
          // Truncate long href values
          if (attr.name === 'href' && val.length > 80) {
            val = val.slice(0, 80) + '…'
          }
          attrs += ` ${attr.name}="${val}"`
        }

        // Self-closing tags
        if (['br', 'hr', 'img', 'input'].includes(tag)) {
          return `<${tag}${attrs}/>`
        }

        return `<${tag}${attrs}>${childContent}</${tag}>`
      }

      // Start from body
      const body = document.body
      if (!body) return '<body></body>'

      let result = processNode(body, 0)

      // Final truncation with structure awareness
      if (result.length > limit) {
        // Try to cut at a tag boundary
        const cutPoint = result.lastIndexOf('>', limit - 100)
        if (cutPoint > limit * 0.5) {
          result = result.slice(0, cutPoint + 1) + '\n<!-- …truncated -->'
        } else {
          result = result.slice(0, limit) + '\n<!-- …truncated -->'
        }
      }

      return result
    }, maxLength)

    return pruned
  } catch {
    // Fallback: raw content with basic string-level cleanup
    try {
      let html = await page.content()
      // Remove script and style tags via regex as fallback
      html = html.replace(/<script[\s\S]*?<\/script>/gi, '')
      html = html.replace(/<style[\s\S]*?<\/style>/gi, '')
      html = html.replace(/<svg[\s\S]*?<\/svg>/gi, '')
      html = html.replace(/<!--[\s\S]*?-->/g, '')
      html = html.replace(/\s+/g, ' ')
      return html.slice(0, maxLength)
    } catch {
      return ''
    }
  }
}

// ─── Desktop: Find the subtree for a specific window by title ───

const WINDOW_ROLES = ['AXWindow', 'AXSheet', 'AXDialog', 'AXDrawer'] as const

/**
 * Normalize a window title for fuzzy comparison. Strips:
 *   - unread-count prefixes like "(3) " or "• "
 *   - trailing app suffixes like " - Slack", " — Figma", " | VS Code"
 *   - bullet / middle dot separators
 *   - repeated whitespace
 *   - ASCII case differences
 */
export function normalizeWindowTitle(s: string | undefined | null): string {
  if (!s) return ''
  let out = s
    // strip unread counts at the beginning: "(3) foo" / "[3] foo" / "• foo"
    .replace(/^\s*(?:\(\s*\d+\s*\)|\[\s*\d+\s*\]|•|●|◉|\*)\s+/u, '')
    // strip trailing app name suffix separated by -, —, –, | (most apps do "Doc - App")
    .replace(/\s*[-—–|·]\s*[^-—–|·]{1,40}$/u, '')
    // collapse whitespace
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase()
  return out
}

/**
 * Count interactive descendants (action-enabled or labeled controls) under a node.
 * Used as a tiebreaker when title matching is ambiguous or missing.
 */
function countInteractiveDescendants(node: AXNode): number {
  let count = 0
  if ((node.actions && node.actions.length > 0) || node.value) count++
  for (const child of node.children ?? []) count += countInteractiveDescendants(child)
  return count
}

/**
 * Collect every AXWindow-like subtree under a node (direct children only — AX
 * always roots windows at app root level, and nested windows are children of
 * those; we still walk down one extra level to catch AXSheet/Dialog attached
 * to a main window).
 */
function collectWindowSubtrees(root: AXNode): AXNode[] {
  const out: AXNode[] = []
  for (const child of root.children ?? []) {
    if (WINDOW_ROLES.includes((child.role ?? '') as typeof WINDOW_ROLES[number])) {
      out.push(child)
      // Also collect any AXSheet/AXDialog attached as a child of the window
      for (const grand of child.children ?? []) {
        if (WINDOW_ROLES.includes((grand.role ?? '') as typeof WINDOW_ROLES[number])
            && grand !== child) {
          out.push(grand)
        }
      }
    }
  }
  // If the root itself is not the app root but an already-narrowed node,
  // nothing found above → recurse one extra level as a safety net.
  if (out.length === 0) {
    for (const child of root.children ?? []) {
      for (const grand of child.children ?? []) {
        if (WINDOW_ROLES.includes((grand.role ?? '') as typeof WINDOW_ROLES[number])) {
          out.push(grand)
        }
      }
    }
  }
  return out
}

/**
 * Score a window candidate against a target title. Higher is better.
 * 1000 = exact match. 800 = normalized exact. 600 = normalized startsWith.
 * 400 = normalized includes either direction. 0 = no title overlap.
 */
function scoreWindowMatch(candidate: AXNode, targetTitle: string): number {
  const cTitle = candidate.title ?? ''
  if (cTitle === targetTitle) return 1000
  const cn = normalizeWindowTitle(cTitle)
  const tn = normalizeWindowTitle(targetTitle)
  if (!cn && !tn) return 0
  if (cn === tn && cn !== '') return 800
  if (cn && tn && cn.startsWith(tn)) return 600
  if (cn && tn && tn.startsWith(cn)) return 550
  if (cn && tn && (cn.includes(tn) || tn.includes(cn))) return 400
  return 0
}

/**
 * Find the subtree for a specific window by title.
 *
 * Strategy (top-down, fuzzy):
 *   1. Collect every AXWindow/AXSheet/AXDialog subtree under the app root.
 *   2. Score each against the target title (exact → normalized → includes).
 *   3. Return the highest-scoring match.
 *   4. If nothing matches, fall back to the window with the most interactive
 *      descendants — that is usually the "main" window the user cares about,
 *      and is far better than the old behavior of silently returning the full
 *      app tree (which mixed multiple workspaces into the AI prompt).
 */
export function findWindowSubtree(node: AXNode, title: string): AXNode | null {
  const candidates = collectWindowSubtrees(node)
  if (candidates.length === 0) return null

  // If exactly one window exists, always use it — no ambiguity.
  if (candidates.length === 1) return candidates[0]

  // Score against the target title
  let best: AXNode | null = null
  let bestScore = 0
  for (const c of candidates) {
    const score = scoreWindowMatch(c, title)
    if (score > bestScore) {
      bestScore = score
      best = c
    }
  }
  if (best && bestScore > 0) return best

  // Fallback: pick the window with the most interactive descendants
  let fallback: AXNode | null = null
  let fallbackCount = -1
  for (const c of candidates) {
    const n = countInteractiveDescendants(c)
    if (n > fallbackCount) {
      fallbackCount = n
      fallback = c
    }
  }
  return fallback
}

// ─── Desktop: Format AX tree for AI consumption ───

/**
 * Roles that are decorative/non-interactive by themselves. If a node has one
 * of these roles AND no label/value/actions, it is skipped — but if it has
 * interactive descendants, we still traverse into it.
 */
const DECORATIVE_ROLES = new Set([
  'AXImage', 'AXStaticText', 'AXSeparator', 'AXSplitter',
  'AXScrollBar', 'AXGrowArea', 'AXUnknown',
])

/**
 * Roles that are structural containers. They rarely carry their own label
 * but we want to print them anyway when they wrap interactive children, so
 * the AI can see the hierarchy ("this AXButton lives inside an AXSheet
 * inside the main AXWindow").
 */
const STRUCTURAL_CONTAINER_ROLES = new Set([
  'AXWindow', 'AXSheet', 'AXDialog', 'AXDrawer',
  'AXToolbar', 'AXTabGroup', 'AXGroup', 'AXScrollArea', 'AXSplitGroup',
  'AXList', 'AXOutline', 'AXTable', 'AXLayoutArea', 'AXLayoutItem',
])

/**
 * True if the node is itself "interesting" — meaning it should produce a
 * printed line in the AI prompt even when no descendants depend on it.
 */
function isNodeInteresting(node: AXNode): boolean {
  const role = node.role ?? ''
  const hasLabel = Boolean(node.title || node.description)
  const hasValue = Boolean(node.value)
  const hasActions = (node.actions?.length ?? 0) > 0
  if (DECORATIVE_ROLES.has(role) && !hasActions && !hasValue) return false
  return hasLabel || hasValue || hasActions
}

/**
 * Count how many interesting (interactive or labeled) descendants are under
 * this node. Used so we can keep structural containers that wrap useful
 * elements while pruning empty branches entirely.
 */
function countInterestingDescendants(node: AXNode): number {
  let c = 0
  for (const child of node.children ?? []) {
    if (isNodeInteresting(child)) c++
    c += countInterestingDescendants(child)
  }
  return c
}

/**
 * Format a single AX node to a one-line representation for the AI prompt.
 */
function formatAxNodeLine(node: AXNode, indent: string): string {
  const role = node.role ?? 'unknown'
  const label = node.title || node.description || ''
  const labelStr = label ? ` "${label}"` : ''
  const value = node.value ? ` value="${String(node.value).slice(0, 120)}"` : ''
  const desc = (node.description && node.title) ? ` desc="${node.description}"` : ''
  const pos = node.position ? ` @ (${node.position.x}, ${node.position.y})` : ''
  const size = node.size ? ` ${node.size.width}x${node.size.height}` : ''
  const actions = (node.actions?.length ?? 0) > 0 ? ` [${node.actions.join(',')}]` : ''
  return `${indent}[${role}${labelStr}${desc}${value}]${pos}${size}${actions}`
}

/**
 * Format an AX tree for AI consumption.
 *
 * Improvements over the previous depth-capped version:
 *  1. **Interactive-descendant aware**: a structural container (AXGroup,
 *     AXScrollArea, AXSplitGroup, …) is kept iff it wraps at least one
 *     interesting descendant. Branches with zero interesting descendants are
 *     collapsed entirely, regardless of how deep they go.
 *  2. **Deeper max depth**: default 8 (was 5). Interesting leaves at depth
 *     7–9 are common in Slack/Figma/Xcode and were previously truncated.
 *  3. **Preserves parent context**: when a button lives inside
 *     Window → Toolbar → Group → Group → Button, the AI now sees all four
 *     ancestors, so it can describe "toolbar button at upper-right".
 *  4. **Never swallows the target**: even at maxDepth the last interesting
 *     descendant is still emitted with a "(…)" ellipsis marker so the AI
 *     knows something exists below.
 */
export function formatAxTreeForAi(
  node: AXNode,
  indent: string,
  depth: number,
  maxDepth: number = 8,
): string {
  const parts: string[] = []
  const interesting = isNodeInteresting(node)
  const role = node.role ?? ''
  const isStructural = STRUCTURAL_CONTAINER_ROLES.has(role)
  const descendantCount = countInterestingDescendants(node)

  // Decide whether to print this node's line
  const shouldPrint = interesting
    || (isStructural && descendantCount > 0)
    || depth === 0  // always print the root so the AI sees the anchor

  if (shouldPrint) {
    parts.push(formatAxNodeLine(node, indent))
    if (node.path && ((node.actions?.length ?? 0) > 0 || node.title || node.description || node.value)) {
      const label = node.title || node.description || ''
      // Strip bidi marks (U+200E LRM / U+200F RLM) from value — they're invisible
      // and would just confuse the model if echoed verbatim. Substring matching
      // on the runtime side still works because value.includes(query) is used.
      const valueClean = node.value ? String(node.value).replace(/[‎‏]/g, '').slice(0, 80) : ''
      const valueAttr = valueClean ? ` axValue="${valueClean}"` : ''
      parts.push(`${indent}  → axRole="${role}" axTitle="${label}"${valueAttr}`)
    }
  }

  // At or beyond maxDepth, stop recursing but leave a hint if pruned branches
  // contained interesting descendants — the AI can then request a getSubtree().
  if (depth >= maxDepth) {
    if (descendantCount > 0) {
      parts.push(`${indent}  … (${descendantCount} more interactive descendants pruned, call desktop.getSubtree() to drill deeper)`)
    }
    return parts.join('\n')
  }

  if (node.children) {
    const nextIndent = shouldPrint ? indent + '  ' : indent
    for (const child of node.children) {
      // Prune children that are entirely empty branches
      if (!isNodeInteresting(child) && countInterestingDescendants(child) === 0) continue
      const childText = formatAxTreeForAi(child, nextIndent, depth + 1, maxDepth)
      if (childText) parts.push(childText)
    }
  }

  return parts.join('\n')
}

// ─── Browser page analysis ───

export interface AnalysisResult {
  pageHtml: string
  screenshot: string
  selectorMap: string
}

export async function analyzeBrowserPage(
  page: Page,
  win: BrowserWindow | null,
  taskId: string,
  stepIndex: number,
  stepName: string,
): Promise<AnalysisResult> {
  let pageHtml = ''
  let screenshot = ''
  let selectorMap = ''

  try {
    sendAndLog(win, taskId, {
      phase: 'analyzing',
      stepIndex,
      stepName,
      message: 'Analyzing page...',
      messageCode: 'browser.analyzing',
    })

    // Extract pruned HTML (removes scripts, styles, hidden elements, etc.)
    pageHtml = await pruneHtmlForAi(page)
    const buf = await page.screenshot({ fullPage: false })
    screenshot = buf.toString('base64')

    sendAndLog(win, taskId, {
      phase: 'analyzing',
      stepIndex,
      stepName,
      message: 'Screenshot captured',
      messageCode: 'browser.screenshotDone',
      screenshot: screenshot.length < 500 * 1024 ? screenshot : undefined,
    })

    sendAndLog(win, taskId, {
      phase: 'analyzing',
      stepIndex,
      stepName,
      message: 'Detecting interactive elements on page...',
      messageCode: 'browser.detectingElements',
    })

    selectorMap = await extractPageSelectors(page)

    // Count detected elements
    const selectorLines = selectorMap.split('\n\n').filter(l => l.trim().length > 0)
    const elementCount = selectorLines.length

    // Send summary with element count
    sendAndLog(win, taskId, {
      phase: 'analyzing',
      stepIndex,
      stepName,
      message: `Page analysis complete: ${page.url()} (${elementCount} interactive elements detected)`,
      messageCode: 'browser.analysisComplete',
      messageParams: { url: page.url(), count: elementCount },
    })

    // Send detected elements as detailed output (truncated)
    if (selectorMap) {
      const preview = selectorMap.length > 2000
        ? selectorMap.slice(0, 2000) + '\n...(truncated)'
        : selectorMap
      sendAndLog(win, taskId, {
        phase: 'analyzing',
        stepIndex,
        stepName,
        message: `Detected elements:\n${preview}`,
        messageCode: 'browser.detectedElements',
      })
    }
  } catch {
    // Page might not be loaded yet
  }

  return { pageHtml, screenshot, selectorMap }
}

// ─── Desktop analysis ───

export async function analyzeDesktop(
  config: AiProviderConfig,
  desktopCtx: DesktopContext,
  win: BrowserWindow | null,
  taskId: string,
  stepIndex: number,
  stepPlan: StepPlan,
  lastUsedAppName: string,
): Promise<AnalysisResult & { updatedAppName: string; launchName: string; targetPid?: number }> {
  let pageHtml = ''
  let screenshot = ''
  let selectorMap = ''
  let updatedAppName = lastUsedAppName
  let launchName = lastUsedAppName

  sendAndLog(win, taskId, {
    phase: 'analyzing',
    stepIndex,
    stepName: stepPlan.name,
    message: 'Analyzing desktop...',
    messageCode: 'desktop.analyzing',
  })

  // Check accessibility permission
  try {
    const { systemPreferences } = await import('electron')
    const trusted = systemPreferences.isTrustedAccessibilityClient({ prompt: false })
    if (!trusted) {
      sendAndLog(win, taskId, {
        phase: 'analyzing',
        stepIndex,
        stepName: stepPlan.name,
        message: '⚠️ Accessibility permission required. Please allow this app in System Settings > Privacy & Security > Accessibility.',
        messageCode: 'desktop.accessibilityRequired',
      })
    }
  } catch { /* */ }

  // ── Screenshot (independent try-catch) ──
  try {
    const buf = await desktopCtx.screenshot()
    screenshot = buf.toString('base64')

    if (screenshot.length < 1000) {
      sendAndLog(win, taskId, {
        phase: 'analyzing',
        stepIndex,
        stepName: stepPlan.name,
        message: '⚠️ Screenshot is empty. Please allow this app in System Settings > Privacy & Security > Screen Recording.',
        messageCode: 'desktop.screenshotEmpty',
      })
    } else {
      sendAndLog(win, taskId, {
        phase: 'analyzing',
        stepIndex,
        stepName: stepPlan.name,
        message: 'Screenshot captured',
        messageCode: 'desktop.screenshotDone',
        screenshot: screenshot.length < 500 * 1024 ? screenshot : undefined,
      })
    }
  } catch (ssErr) {
    sendAndLog(win, taskId, {
      phase: 'analyzing',
      stepIndex,
      stepName: stepPlan.name,
      message: `⚠️ Screenshot error: ${(ssErr as Error).message}`,
      messageCode: 'desktop.screenshotError',
      messageParams: { error: (ssErr as Error).message },
    })
  }

  // ── Window list (independent try-catch) ──
  let windows: WindowInfo[] = []
  try {
    sendAndLog(win, taskId, {
      phase: 'analyzing',
      stepIndex,
      stepName: stepPlan.name,
      message: 'Fetching window list...',
      messageCode: 'desktop.windowListFetching',
    })

    windows = await desktopCtx.getWindows()

    if (windows.length === 0) {
      sendAndLog(win, taskId, {
        phase: 'analyzing',
        stepIndex,
        stepName: stepPlan.name,
        message: '⚠️ No windows detected. Please check accessibility permissions.',
        messageCode: 'desktop.noWindowsDetected',
      })
    } else {
      const windowList = windows.map(w =>
        `  [${w.focused ? '★' : ' '}] ${w.app ?? 'unknown'} (PID ${w.pid})${w.title ? ` — "${w.title}"` : ''}`
      ).join('\n')
      sendAndLog(win, taskId, {
        phase: 'analyzing',
        stepIndex,
        stepName: stepPlan.name,
        message: `🖥️ ${windows.length} windows detected:\n${windowList}`,
        messageCode: 'desktop.windowsDetected',
        messageParams: { count: windows.length },
      })
    }
  } catch (winErr) {
    sendAndLog(win, taskId, {
      phase: 'analyzing',
      stepIndex,
      stepName: stepPlan.name,
      message: `⚠️ Window list error: ${(winErr as Error).message}`,
      messageCode: 'desktop.windowListError',
      messageParams: { error: (winErr as Error).message },
    })
  }

  // ── AI-based window matching ──
  let targetWindow: typeof windows[number] | undefined
  let isLaunchStep = false

  if (windows.length > 0) {
    sendAndLog(win, taskId, {
      phase: 'analyzing',
      stepIndex,
      stepName: stepPlan.name,
      message: 'Identifying target window via AI...',
      messageCode: 'desktop.windowMatching',
    })

    const matchResult = await matchTargetWindow(config, stepPlan, windows, lastUsedAppName)
    isLaunchStep = matchResult.needsLaunch
    updatedAppName = matchResult.appName
    launchName = matchResult.launchName

    if (isLaunchStep) {
      sendAndLog(win, taskId, {
        phase: 'analyzing',
        stepIndex,
        stepName: stepPlan.name,
        message: `🚀 App launch step (${updatedAppName}) — skipping AX tree analysis`,
        messageCode: 'desktop.appLaunchStep',
        messageParams: { appName: updatedAppName },
      })
    } else if (matchResult.pid !== null) {
      targetWindow = windows.find(w => w.pid === matchResult.pid)

      if (!targetWindow) {
        // AI returned a PID but it's not in the current list — wait and retry (app may still be launching)
        sendAndLog(win, taskId, {
          phase: 'analyzing',
          stepIndex,
          stepName: stepPlan.name,
          message: `⏳ PID ${matchResult.pid} not found in window list. Waiting for launch...`,
          messageCode: 'desktop.pidNotFound',
          messageParams: { pid: matchResult.pid },
        })
        for (let attempt = 1; attempt <= 4; attempt++) {
          await new Promise(r => setTimeout(r, 1200))
          try {
            const retryWindows = await desktopCtx.getWindows()
            const retryMatch = await matchTargetWindow(config, stepPlan, retryWindows, lastUsedAppName)
            if (retryMatch.pid !== null) {
              const found = retryWindows.find(w => w.pid === retryMatch.pid)
              if (found) {
                targetWindow = found
                updatedAppName = retryMatch.appName
                sendAndLog(win, taskId, {
                  phase: 'analyzing',
                  stepIndex,
                  stepName: stepPlan.name,
                  message: `🔄 Retry ${attempt}: detected ${found.app ?? 'unknown'} (PID ${found.pid})`,
                  messageCode: 'desktop.retryDetected',
                  messageParams: { attempt, app: found.app ?? 'unknown', pid: found.pid },
                })
                break
              }
            }
          } catch { /* retry failed */ }
        }

        // Still not found — fall back to focused window
        if (!targetWindow) {
          targetWindow = windows.find(w => w.focused) ?? windows[0]
        }
      }

      sendAndLog(win, taskId, {
        phase: 'analyzing',
        stepIndex,
        stepName: stepPlan.name,
        message: `🎯 Target window: ${targetWindow?.app ?? 'unknown'} (PID ${targetWindow?.pid})`,
        messageCode: 'desktop.targetWindow',
        messageParams: { app: targetWindow?.app ?? 'unknown', pid: targetWindow?.pid },
      })
    }
  }

  if (targetWindow?.app) updatedAppName = targetWindow.app

  // ── Dynamic AppleScript dictionary detection ──
  // Instead of maintaining a hardcoded allowlist, probe the app's sdef at runtime.
  // If the app has a non-trivial Scripting Dictionary, we tell the AI to prefer
  // AppleScript over UI operations for data CRUD tasks.
  let appleScriptCapability: {
    hasDict: boolean
    commands?: string[]
    classes?: string[]
    note: string
  } | null = null
  if (targetWindow?.bundleId || targetWindow?.app) {
    try {
      const { execFile } = await import('child_process')
      const { promisify } = await import('util')
      const exec = promisify(execFile)
      // Resolve the .app path dynamically. sdef doesn't accept bundleId directly —
      // it needs a filesystem path. Use mdfind to locate the app by bundleId (most
      // reliable, locale-independent) or fall back to name search.
      let appPath: string | null = null
      if (targetWindow.bundleId) {
        const { stdout: bundlePath } = await exec('mdfind', [
          `kMDItemCFBundleIdentifier == "${targetWindow.bundleId}"`
        ], { timeout: 2000 }).catch(() => ({ stdout: '' } as { stdout: string }))
        const firstPath = bundlePath.split('\n').find(p => p.endsWith('.app'))
        if (firstPath) appPath = firstPath
      }
      if (!appPath && targetWindow.app) {
        const { stdout: namePath } = await exec('mdfind', [
          `kMDItemContentType == "com.apple.application-bundle" && kMDItemDisplayName == "${targetWindow.app}"`
        ], { timeout: 2000 }).catch(() => ({ stdout: '' } as { stdout: string }))
        const firstPath = namePath.split('\n').find(p => p.endsWith('.app'))
        if (firstPath) appPath = firstPath
      }

      let stdout = ''
      if (appPath) {
        const res = await exec('sdef', [appPath], { timeout: 3000, maxBuffer: 5_000_000 }).catch(() => ({ stdout: '' } as { stdout: string }))
        stdout = res.stdout ?? ''
      }
      if (stdout && stdout.length > 200 && /<dictionary[\s>]/.test(stdout)) {
        // Extract top-level commands and classes from the dictionary
        const commandMatches = Array.from(stdout.matchAll(/<command\s+name="([^"]+)"/g)).map(m => m[1])
        const classMatches = Array.from(stdout.matchAll(/<class\s+name="([^"]+)"/g)).map(m => m[1])
        // Filter to meaningful commands (exclude common ones from Standard Suite that every app has)
        const appSpecificCommands = commandMatches.filter(c =>
          !['open','close','quit','save','print','count','delete','exists','get','make','move','set'].includes(c)
        )
        const hasDataOps = commandMatches.some(c => ['make','set','get','add','create'].includes(c))
          || classMatches.some(c => !['application','window','document'].includes(c.toLowerCase()))
        appleScriptCapability = {
          hasDict: true,
          commands: [...new Set([...commandMatches.slice(0, 8), ...appSpecificCommands.slice(0, 8)])].slice(0, 12),
          classes: [...new Set(classMatches)].slice(0, 10),
          note: hasDataOps
            ? '★ This app has an AppleScript Dictionary. Data CRUD MUST use osascript + tell application (UI clicks prohibited)'
            : 'This app has an AppleScript Dictionary but data operation commands are limited. Consider combining with UI operations.',
        }
      } else {
        appleScriptCapability = {
          hasDict: false,
          note: 'This app does not have an AppleScript Dictionary (or it is non-trivial). Use AX tree + keyboard shortcuts + clipboard paste to operate.',
        }
      }
    } catch { /* sdef failed, leave capability null */ }
  }

  if (targetWindow) {
    sendAndLog(win, taskId, {
      phase: 'analyzing',
      stepIndex,
      stepName: stepPlan.name,
      message: `🌳 Fetching AX tree: ${targetWindow.app ?? 'unknown'} (PID ${targetWindow.pid})...`,
      messageCode: 'desktop.axTreeFetching',
      messageParams: { app: targetWindow.app ?? 'unknown', pid: targetWindow.pid },
    })

    try {
      const fullTree = await desktopCtx.getAccessibilityTree(targetWindow.pid)

      // Focus on target window's subtree to reduce prompt size
      let tree = fullTree
      if (targetWindow.title) {
        const windowSubtree = findWindowSubtree(fullTree, targetWindow.title)
        if (windowSubtree) {
          tree = windowSubtree
          sendAndLog(win, taskId, {
            phase: 'analyzing',
            stepIndex,
            stepName: stepPlan.name,
            message: `🎯 Narrowed to subtree for window "${targetWindow.title}"`,
            messageCode: 'desktop.windowSubtreeNarrowed',
            messageParams: { title: targetWindow.title },
          })
        }
      }

      selectorMap = formatAxTreeForAi(tree, '', 0, 8)
      pageHtml = JSON.stringify(tree, null, 2).slice(0, 8000)

      // Prepend AppleScript capability info so codegen/actionPlan agents see it first
      if (appleScriptCapability) {
        const cap = appleScriptCapability
        const header = cap.hasDict
          ? `## 🧠 AppleScript Dictionary: Available\n${cap.note}\nKey commands: ${(cap.commands ?? []).join(', ')}\nKey classes: ${(cap.classes ?? []).join(', ')}\nRecommended: call directly via osascript -e 'tell application "${targetWindow.app}" to ...'\n\n`
          : `## 🧠 AppleScript Dictionary: None\n${cap.note}\n\n`
        selectorMap = header + selectorMap
      }

      const axLines = selectorMap.split('\n').filter(l => l.includes('axRole='))
      const axElementCount = axLines.length

      // Detect shallow AX tree (Electron/WebView apps like Slack, Teams, Discord)
      // These apps expose very few AX elements despite having large windows
      const windowArea = targetWindow.bounds
        ? targetWindow.bounds.width * targetWindow.bounds.height
        : 0
      const isShallowTree = axElementCount <= 10 && windowArea > 200000

      if (isShallowTree && targetWindow.bounds) {
        // Append window bounds info to selectorMap so codegen/actionPlan agents can use it
        const b = targetWindow.bounds
        selectorMap += `\n\n## ⚠️ Shallow AX tree (possible Electron/WebView app)\nThis app has few AX tree elements. Use these strategies instead of element clicking:\n- **Keyboard shortcuts** (Cmd+K to search, Cmd+Return to send, etc.)\n- **Window bounds-relative coordinates** for clicking (no hardcoded coords — compute dynamically from bounds)\n- **Double-click** to ensure focus (1st click activates window, 2nd click focuses input field)\n\n### Window bounds info\n- x: ${b.x}, y: ${b.y}, width: ${b.width}, height: ${b.height}\n- Estimated message input area: center X = ${b.x + Math.round(b.width / 2)}, bottom Y = ${b.y + b.height - 80}\n- Estimated send button: bottom-right (prefer Cmd+Return)`

        sendAndLog(win, taskId, {
          phase: 'analyzing',
          stepIndex,
          stepName: stepPlan.name,
          message: `⚠️ Shallow AX tree (${axElementCount} elements): possible Electron/WebView app. Recommend keyboard operations and bounds-relative coordinates`,
          messageCode: 'desktop.shallowAxTree',
          messageParams: { count: axElementCount },
        })
      }

      sendAndLog(win, taskId, {
        phase: 'analyzing',
        stepIndex,
        stepName: stepPlan.name,
        message: `🌳 AX tree fetched: ${axElementCount} interactive elements detected`,
        messageCode: 'desktop.axTreeDone',
        messageParams: { count: axElementCount },
      })

      if (selectorMap) {
        const preview = selectorMap.length > 2000
          ? selectorMap.slice(0, 2000) + '\n...(truncated)'
          : selectorMap
        sendAndLog(win, taskId, {
          phase: 'analyzing',
          stepIndex,
          stepName: stepPlan.name,
          message: `🗂️ AX tree elements:\n${preview}`,
          messageCode: 'desktop.axTreeElements',
        })
      }
    } catch (axErr) {
      console.warn(`[analyzingAgent] AX tree error for PID ${targetWindow.pid}:`, (axErr as Error).message)
      sendAndLog(win, taskId, {
        phase: 'analyzing',
        stepIndex,
        stepName: stepPlan.name,
        message: `⚠️ AX tree error (PID ${targetWindow.pid}): ${(axErr as Error).message}`,
        messageCode: 'desktop.axTreeError',
        messageParams: { pid: targetWindow.pid, error: (axErr as Error).message },
      })
    }
  }

  sendAndLog(win, taskId, {
    phase: 'analyzing',
    stepIndex,
    stepName: stepPlan.name,
    message: `✅ Desktop analysis complete: ${targetWindow?.app ?? (isLaunchStep ? 'app launch step' : 'unknown')}`,
    messageCode: 'desktop.analysisComplete',
    messageParams: { app: targetWindow?.app ?? (isLaunchStep ? 'app launch step' : 'unknown') },
  }, JSON.stringify({
    targetWindow: targetWindow ? {
      app: targetWindow.app,
      pid: targetWindow.pid,
      title: targetWindow.title,
      bundleId: targetWindow.bundleId,
    } : null,
    updatedAppName,
    launchName,
    isLaunchStep,
    axElementCount: selectorMap ? selectorMap.split('\n').filter(l => l.includes('axRole=')).length : 0,
    windowCount: windows.length,
  }, null, 2))

  return { pageHtml, screenshot, selectorMap, updatedAppName, launchName, targetPid: targetWindow?.pid }
}

// ─── Re-analysis on retry ───

export async function reanalyzeBrowser(
  page: Page,
  win: BrowserWindow | null,
  taskId: string,
  stepIndex: number,
  stepName: string,
  retries: number,
): Promise<AnalysisResult> {
  let pageHtml = ''
  let screenshot = ''
  let selectorMap = ''

  try {
    sendAndLog(win, taskId, {
      phase: 'analyzing',
      stepIndex,
      stepName,
      message: `🔄 Re-analyzing page (retry ${retries})...`,
      messageCode: 'reanalysis.browserStarted',
      messageParams: { retries },
    })

    // Use pruned HTML on retry (smaller context, retries already have error info)
    pageHtml = await pruneHtmlForAi(page, 4000)
    const buf = await page.screenshot({ fullPage: false })
    screenshot = buf.toString('base64')
    selectorMap = await extractPageSelectors(page)

    const retryScreenshot = screenshot.length < 500 * 1024 ? screenshot : undefined
    sendAndLog(win, taskId, {
      phase: 'analyzing',
      stepIndex,
      stepName,
      message: `📸 Page re-analysis complete (retry ${retries}): ${page.url()}`,
      messageCode: 'reanalysis.browserComplete',
      messageParams: { retries, url: page.url() },
      screenshot: retryScreenshot,
      html: pageHtml.slice(0, 6000),
    })
  } catch { /* page might be in a weird state */ }

  return { pageHtml, screenshot, selectorMap }
}

export async function reanalyzeDesktop(
  config: AiProviderConfig,
  desktopCtx: DesktopContext,
  win: BrowserWindow | null,
  taskId: string,
  stepIndex: number,
  stepName: string,
  stepDescription: string,
  lastUsedAppName: string,
  retries: number,
): Promise<AnalysisResult> {
  let pageHtml = ''
  let screenshot = ''
  let selectorMap = ''

  try {
    sendAndLog(win, taskId, {
      phase: 'analyzing',
      stepIndex,
      stepName,
      message: `🔄 Re-analyzing desktop (retry ${retries})...`,
      messageCode: 'reanalysis.desktopStarted',
      messageParams: { retries },
    })

    const buf = await desktopCtx.screenshot()
    screenshot = buf.toString('base64')
    const windows = await desktopCtx.getWindows()

    // AI-based window matching for retry
    const matchResult = await matchTargetWindow(
      config,
      { name: stepName, description: stepDescription },
      windows,
      lastUsedAppName,
    )
    let retryTarget = matchResult.pid !== null
      ? (windows.find(w => w.pid === matchResult.pid) ?? windows.find(w => w.focused) ?? windows[0])
      : (windows.find(w => w.focused) ?? windows[0])

    sendAndLog(win, taskId, {
      phase: 'analyzing',
      stepIndex,
      stepName,
      message: `🎯 Re-analysis target: ${retryTarget?.app ?? 'unknown'} (PID ${retryTarget?.pid}) — AI match: "${matchResult.appName}"`,
      messageCode: 'reanalysis.desktopTarget',
      messageParams: { app: retryTarget?.app ?? 'unknown', pid: retryTarget?.pid, aiMatch: matchResult.appName },
    })
    if (retryTarget) {
      try {
        const fullTree = await desktopCtx.getAccessibilityTree(retryTarget.pid)
        let tree = fullTree
        if (retryTarget.title) {
          const sub = findWindowSubtree(fullTree, retryTarget.title)
          if (sub) tree = sub
        }
        selectorMap = formatAxTreeForAi(tree, '', 0, 8)
        pageHtml = JSON.stringify(tree, null, 2).slice(0, 8000)
      } catch (axErr) {
        console.warn(`[analyzingAgent] Retry AX tree error for PID ${retryTarget.pid}:`, (axErr as Error).message)
      }
    }
    const retryScreenshot = screenshot.length < 500 * 1024 ? screenshot : undefined
    sendAndLog(win, taskId, {
      phase: 'analyzing',
      stepIndex,
      stepName,
      message: `📸 Desktop re-analysis complete (retry ${retries})`,
      messageCode: 'reanalysis.desktopComplete',
      messageParams: { retries },
      screenshot: retryScreenshot,
      html: pageHtml.slice(0, 8000),
    })
  } catch { /* desktop might be in a weird state */ }

  return { pageHtml, screenshot, selectorMap }
}
