// ─── Selector Agent ───
// Resolves and verifies selectors for browser elements and desktop AX elements.

import type { Page } from 'playwright-core'
import type { BrowserWindow } from 'electron'
import type { AXNode, DesktopContext } from '../../../shared/types'
import { sendAndLog } from './progressHelper'

// ─── Types ───

export interface ResolvedSelector {
  selector: string
  method: 'css' | 'playwright'
  verified: boolean
}

export interface ActionPlan {
  action: 'goto' | 'click' | 'fill' | 'select' | 'check' | 'press' | 'wait' | 'scroll' | 'hover'
    | 'open_app' | 'activate_app' | 'click_element' | 'click_position'
    | 'type_text' | 'hotkey' | 'press_key' | 'shell'
  description: string
  selectorHint?: string
  url?: string
  value?: string
  key?: string
  elementType?: string
  axRole?: string
  axTitle?: string
  // Match against the AX `value` attribute. Use this for display-only elements
  // whose visible text lives on `value` rather than `title`/`description`
  // (e.g. Calculator's result area: title=null, description=null, value="40,626").
  axValue?: string
  app?: string
  text?: string
  keys?: string[]
  x?: number
  y?: number
  seconds?: number
  query?: string
  command?: string
}

export interface ResolvedDesktopElement {
  axRole: string
  axTitle: string
  axValue?: string
  path?: string
  position?: { x: number; y: number }
  pid?: number
  found: boolean
  /**
   * On a miss (found === false), this lists nearby candidates of the same role
   * so the next replan or code-generation pass can pick a real title instead of
   * guessing again. Sorted by whatever order they appear in the AX tree.
   */
  candidates?: Array<{
    axRole: string
    axTitle: string
    description?: string
    position?: { x: number; y: number }
    path?: string
  }>
}

export interface ResolvedAction {
  action: ActionPlan
  resolvedSelector?: ResolvedSelector
  resolvedDesktop?: ResolvedDesktopElement
  unresolved?: boolean
}

// ─── Browser: Find best selector ───

async function findBestSelector(
  page: Page,
  hint: string,
  elementType?: string
): Promise<ResolvedSelector | null> {
  const escapeForSelector = (s: string) => s.replace(/'/g, "\\'")

  const strategies: Array<() => Promise<ResolvedSelector | null>> = [
    // Exact role match
    async () => {
      const roleMap: Record<string, string> = {
        input: 'textbox', link: 'link', button: 'button',
        checkbox: 'checkbox', radio: 'radio', select: 'combobox', textarea: 'textbox',
      }
      const role = roleMap[elementType ?? ''] ?? (elementType === 'link' ? 'link' : 'button')
      const loc = page.getByRole(role as any, { name: hint })
      if (await loc.count() === 1) {
        return { selector: `page.getByRole('${role}', { name: '${escapeForSelector(hint)}' })`, method: 'playwright' as const, verified: true }
      }
      const locPartial = page.getByRole(role as any, { name: hint, exact: false })
      if (await locPartial.count() === 1) {
        return { selector: `page.getByRole('${role}', { name: '${escapeForSelector(hint)}', exact: false })`, method: 'playwright' as const, verified: true }
      }
      return null
    },
    // Exact text match
    async () => {
      const loc = page.getByText(hint, { exact: true })
      if (await loc.count() === 1) {
        return { selector: `page.getByText('${escapeForSelector(hint)}', { exact: true })`, method: 'playwright' as const, verified: true }
      }
      return null
    },
    // Partial text match
    async () => {
      const loc = page.getByText(hint)
      if (await loc.count() === 1) {
        return { selector: `page.getByText('${escapeForSelector(hint)}')`, method: 'playwright' as const, verified: true }
      }
      return null
    },
    // Placeholder match
    async () => {
      const loc = page.getByPlaceholder(hint)
      if (await loc.count() === 1) {
        return { selector: `page.getByPlaceholder('${escapeForSelector(hint)}')`, method: 'playwright' as const, verified: true }
      }
      return null
    },
    // Label match
    async () => {
      const loc = page.getByLabel(hint)
      if (await loc.count() === 1) {
        return { selector: `page.getByLabel('${escapeForSelector(hint)}')`, method: 'playwright' as const, verified: true }
      }
      return null
    },
    // CSS: evaluate in-page
    async () => {
      const result = await page.evaluate((h: string) => {
        const all = document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="radio"]')
        for (const el of all) {
          const rect = el.getBoundingClientRect()
          if (rect.height === 0 || rect.width === 0) continue
          const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
          const aria = el.getAttribute('aria-label') ?? ''
          const placeholder = el.getAttribute('placeholder') ?? ''
          const name = el.getAttribute('name') ?? ''
          const title = el.getAttribute('title') ?? ''
          if ([text, aria, placeholder, name, title].some(t => t.includes(h))) {
            const tag = el.tagName.toLowerCase()
            const id = el.id
            const testId = el.getAttribute('data-testid') ?? el.getAttribute('data-test-id')
            if (testId) return `[data-testid="${testId}"]`
            if (id && !/^\d|^[a-f0-9-]{20,}|^:r|^react-|^rc-/.test(id)) return `#${id}`
            if (name) return `${tag}[name="${name}"]`
            const type = el.getAttribute('type')
            if (type && document.querySelectorAll(`${tag}[type="${type}"]`).length === 1) return `${tag}[type="${type}"]`
            if (aria && document.querySelectorAll(`[aria-label="${aria}"]`).length === 1) return `[aria-label="${aria}"]`
            if (placeholder && document.querySelectorAll(`[placeholder="${placeholder}"]`).length === 1) return `[placeholder="${placeholder}"]`
            return null
          }
        }
        return null
      }, hint)

      if (result) {
        const count = await page.locator(result).count()
        if (count === 1) return { selector: result, method: 'css' as const, verified: true }
      }
      return null
    },
    // XPath fallback
    async () => {
      const xpathExpressions = [
        `//*[contains(text(), '${hint.replace(/'/g, "\\'")}')]`,
        `//*[@aria-label='${hint.replace(/'/g, "\\'")}']`,
        `//*[@placeholder='${hint.replace(/'/g, "\\'")}']`,
      ]
      for (const xpath of xpathExpressions) {
        try {
          const loc = page.locator(`xpath=${xpath}`)
          if (await loc.count() === 1) {
            return { selector: `xpath=${xpath}`, method: 'css' as const, verified: true }
          }
        } catch { /* try next */ }
      }
      return null
    },
  ]

  for (const strategy of strategies) {
    try {
      const result = await strategy()
      if (result) return result
    } catch { /* try next strategy */ }
  }
  return null
}

// ─── Visual debugging helpers ───

async function highlightElement(page: Page, selector: string, isPlaywright: boolean): Promise<void> {
  try {
    if (isPlaywright) return
    await page.evaluate((sel: string) => {
      const el = document.querySelector(sel)
      if (el) {
        (el as HTMLElement).style.outline = '3px solid red'
        ;(el as HTMLElement).style.outlineOffset = '2px'
      }
    }, selector)
  } catch { /* ignore */ }
}

async function clearHighlights(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      const highlighted = document.querySelectorAll('[style*="outline: 3px solid red"]')
      for (const el of highlighted) {
        (el as HTMLElement).style.outline = ''
        ;(el as HTMLElement).style.outlineOffset = ''
      }
    })
  } catch { /* ignore */ }
}

// ─── Browser: Resolve selectors for all actions ───

export async function resolveActionSelectors(
  page: Page,
  actions: ActionPlan[],
  win: BrowserWindow | null,
  stepIndex: number,
  stepName: string,
  taskId: string,
): Promise<ResolvedAction[]> {
  const resolved: ResolvedAction[] = []

  sendAndLog(win, taskId, {
    phase: 'selector',
    stepIndex,
    stepName,
    message: `🔍 Resolving selectors (${actions.length} actions)...`,
    messageCode: 'selector.resolvingBrowser',
    messageParams: { count: actions.length },
  })

  for (const action of actions) {
    if (!action.selectorHint || action.action === 'goto' || action.action === 'wait' || action.action === 'scroll') {
      resolved.push({ action })
      continue
    }

    sendAndLog(win, taskId, {
      phase: 'selector',
      stepIndex,
      stepName,
      message: `🔍 Resolving selector: ${action.description} (hint: "${action.selectorHint}")`,
      messageCode: 'selector.resolving',
      messageParams: { description: action.description, hint: action.selectorHint },
    })

    const found = await findBestSelector(page, action.selectorHint, action.elementType)

    if (found) {
      if (found.method === 'css') {
        await highlightElement(page, found.selector, false)
      }
      sendAndLog(win, taskId, {
        phase: 'selector',
        stepIndex,
        stepName,
        message: `✅ Selector resolved: ${action.description} → ${found.selector}`,
        messageCode: 'selector.resolved',
        messageParams: { description: action.description, selector: found.selector },
      })
      resolved.push({ action, resolvedSelector: found })
    } else {
      sendAndLog(win, taskId, {
        phase: 'selector',
        stepIndex,
        stepName,
        message: `⚠️ Selector unresolved: ${action.description} (hint: "${action.selectorHint}")`,
        messageCode: 'selector.unresolved',
        messageParams: { description: action.description, hint: action.selectorHint },
      })
      resolved.push({ action, unresolved: true })
    }
  }

  await clearHighlights(page)

  const resolvedCount = resolved.filter(r => !r.unresolved).length
  const unresolvedCount = resolved.filter(r => r.unresolved).length
  sendAndLog(win, taskId, {
    phase: 'selector',
    stepIndex,
    stepName,
    message: `✅ Selector resolution complete: ${resolvedCount} resolved / ${unresolvedCount} unresolved`,
    messageCode: 'selector.completeBrowser',
    messageParams: { resolvedCount, unresolvedCount },
  }, JSON.stringify(resolved.map(ra => ({
    action: ra.action.action,
    description: ra.action.description,
    selector: ra.resolvedSelector?.selector,
    unresolved: ra.unresolved,
  })), null, 2))

  return resolved
}

// ─── Desktop: Resolve AX elements for all actions ───

export async function resolveDesktopActions(
  desktopCtx: DesktopContext,
  actions: ActionPlan[],
  win: BrowserWindow | null,
  stepIndex: number,
  stepName: string,
  taskId: string,
  targetPid?: number,
): Promise<ResolvedAction[]> {
  const resolved: ResolvedAction[] = []

  sendAndLog(win, taskId, {
    phase: 'selector',
    stepIndex,
    stepName,
    message: `🔍 Resolving desktop elements (${actions.length} actions)...`,
    messageCode: 'selector.resolvingDesktop',
    messageParams: { count: actions.length },
  })

  for (const action of actions) {
    // Skip element resolution if neither axRole nor axValue is provided, or if
    // the action type doesn't target a UI element.
    if ((!action.axRole && !action.axValue) || action.action === 'open_app' || action.action === 'shell'
        || action.action === 'type_text' || action.action === 'hotkey'
        || action.action === 'press_key' || action.action === 'click_position'
        || action.action === 'wait' || action.action === 'activate_app') {
      resolved.push({ action })
      continue
    }

    sendAndLog(win, taskId, {
      phase: 'selector',
      stepIndex,
      stepName,
      message: `🔍 Resolving desktop element: ${action.description} (${action.axRole ?? ''}: title="${action.axTitle ?? ''}" value="${action.axValue ?? ''}")`,
      messageCode: 'selector.resolvingDesktopElement',
      messageParams: { description: action.description, axRole: action.axRole ?? '', axTitle: action.axTitle ?? '' },
    })

    try {
      const windows = await desktopCtx.getWindows()
      const query: { role?: string; title?: string; value?: string } = {}
      if (action.axRole) query.role = action.axRole
      if (action.axTitle) query.title = action.axTitle
      if (action.axValue) query.value = action.axValue

      const pidsToSearch: number[] = []
      // Priority 1: Target PID from analyzing phase (most reliable)
      if (targetPid) pidsToSearch.push(targetPid)
      // Priority 2: App name from action plan
      if (action.app) {
        const appLower = action.app.toLowerCase()
        const appWindow = windows.find(
          w => !pidsToSearch.includes(w.pid) && (
            w.bundleId?.toLowerCase().includes(appLower)
            || w.title?.toLowerCase().includes(appLower)
            || w.app?.toLowerCase().includes(appLower)
          )
        )
        if (appWindow) pidsToSearch.push(appWindow.pid)
      }
      // Priority 3: Focused window, then all others
      const focused = windows.find(w => w.focused)
      if (focused && !pidsToSearch.includes(focused.pid)) pidsToSearch.push(focused.pid)
      for (const w of windows) {
        if (!pidsToSearch.includes(w.pid)) pidsToSearch.push(w.pid)
      }

      if (pidsToSearch.length === 0) {
        resolved.push({ action, unresolved: true })
        continue
      }

      let element: AXNode | null = null
      let usedPid: number | undefined
      let fallbackTreeForCandidates: AXNode | null = null
      let fallbackPidForCandidates: number | undefined
      for (const pid of pidsToSearch) {
        try {
          const tree = await desktopCtx.getAccessibilityTree(pid)
          element = desktopCtx.findElement(tree, query)
          if (element) { usedPid = pid; break }
          // Keep the first tree that at least has *some* element of this role,
          // so we can list siblings as candidates if the title didn't match.
          if (!fallbackTreeForCandidates && action.axRole) {
            const anyOfRole = desktopCtx.findElements
              ? desktopCtx.findElements(tree, { role: action.axRole }).length
              : (desktopCtx.findElement(tree, { role: action.axRole }) ? 1 : 0)
            if (anyOfRole > 0) {
              fallbackTreeForCandidates = tree
              fallbackPidForCandidates = pid
            }
          }
        } catch { /* skip */ }
      }

      if (element) {
        const resolvedTitle = element.title || element.description || action.axTitle || ''
        let centerPos: { x: number; y: number } | undefined
        if (element.position) {
          const halfW = (element.size?.width ?? 0) / 2
          const halfH = (element.size?.height ?? 0) / 2
          centerPos = { x: element.position.x + halfW, y: element.position.y + halfH }
        }
        const desktopEl: ResolvedDesktopElement = {
          axRole: element.role ?? action.axRole ?? '',
          axTitle: resolvedTitle,
          axValue: element.value ?? action.axValue ?? undefined,
          path: element.path,
          position: centerPos,
          pid: usedPid,
          found: true,
        }
        const appInfo = usedPid ? ` (pid=${usedPid})` : ''
        sendAndLog(win, taskId, {
          phase: 'selector',
          stepIndex,
          stepName,
          message: `✅ Desktop element resolved: ${action.description} → ${desktopEl.axRole} "${resolvedTitle}"${desktopEl.position ? ` @ (${desktopEl.position.x}, ${desktopEl.position.y})` : ''}${appInfo}`,
          messageCode: 'selector.resolvedDesktop',
          messageParams: { description: action.description, axRole: desktopEl.axRole, axTitle: resolvedTitle, position: desktopEl.position, pid: usedPid },
        })
        resolved.push({ action, resolvedDesktop: desktopEl })
      } else {
        // Miss: collect same-role candidates from the fallback tree so the
        // next replan or codegen pass sees what's actually in the UI.
        const candidates: NonNullable<ResolvedDesktopElement['candidates']> = []
        if (fallbackTreeForCandidates && action.axRole && desktopCtx.findElements) {
          const siblings = desktopCtx.findElements(fallbackTreeForCandidates, { role: action.axRole })
          for (const el of siblings.slice(0, 12)) {
            const pos = (el.position && el.size)
              ? { x: el.position.x + el.size.width / 2, y: el.position.y + el.size.height / 2 }
              : undefined
            candidates.push({
              axRole: el.role ?? action.axRole ?? '',
              axTitle: el.title ?? '',
              description: el.description ?? undefined,
              position: pos,
              path: el.path,
            })
          }
        }

        const candText = candidates.length > 0
          ? `\n  Existing candidates (same role): ${candidates.slice(0, 6).map(c => `"${c.axTitle || c.description || '(no title)'}"`).join(', ')}${candidates.length > 6 ? ` ...and ${candidates.length - 6} more` : ''}`
          : ''
        sendAndLog(win, taskId, {
          phase: 'selector',
          stepIndex,
          stepName,
          message: `⚠️ Desktop element unresolved: ${action.description} (${action.axRole ?? ''}: title="${action.axTitle ?? ''}" value="${action.axValue ?? ''}")${candText}`,
          messageCode: candidates.length > 0 ? 'selector.unresolvedDesktopCandidates' : 'selector.unresolvedDesktop',
          messageParams: { description: action.description, axRole: action.axRole ?? '', axTitle: action.axTitle ?? '', candidates: candidates.slice(0, 6).map(c => c.axTitle || c.description || '(no title)'), remainingCount: candidates.length > 6 ? candidates.length - 6 : 0 },
        }, JSON.stringify({ candidates, searchedPid: fallbackPidForCandidates }, null, 2))
        resolved.push({
          action,
          resolvedDesktop: {
            axRole: action.axRole ?? '',
            axTitle: action.axTitle ?? '',
            found: false,
            candidates: candidates.length > 0 ? candidates : undefined,
          },
          unresolved: true,
        })
      }
    } catch {
      resolved.push({ action, unresolved: true })
    }
  }

  const resolvedCount = resolved.filter(r => !r.unresolved).length
  const unresolvedCount = resolved.filter(r => r.unresolved).length
  sendAndLog(win, taskId, {
    phase: 'selector',
    stepIndex,
    stepName,
    message: `✅ Desktop element resolution complete: ${resolvedCount} resolved / ${unresolvedCount} unresolved`,
    messageCode: 'selector.completeDesktop',
    messageParams: { resolvedCount, unresolvedCount },
  }, JSON.stringify(resolved.map(ra => ({
    action: ra.action.action,
    description: ra.action.description,
    desktopElement: ra.resolvedDesktop ? { axRole: ra.resolvedDesktop.axRole, axTitle: ra.resolvedDesktop.axTitle, found: ra.resolvedDesktop.found } : undefined,
    unresolved: ra.unresolved,
  })), null, 2))

  return resolved
}
