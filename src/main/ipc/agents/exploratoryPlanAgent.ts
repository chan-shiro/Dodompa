// ─── Exploratory Planning Agent ───
// Multi-turn AI agent that explores the actual target site/app BEFORE planning.
// Instead of blindly creating steps from text instructions, this agent opens
// the browser, navigates to URLs, follows links, checks for PDFs, and builds
// a comprehensive understanding of the site structure — then generates an
// informed step plan based on real observations.
//
// This replaces planSteps() for information-gathering tasks that have a goal
// and URLs to explore. For simple tasks, planSteps() is used directly.

import type { Page } from 'playwright-core'
import type { BrowserWindow } from 'electron'
import type { AiProviderConfig, StablePriorStep, StepPlan, TaskDefinition, VariableDefinition } from '../../../shared/types'
import { chatNonStream } from './aiChat'
import { sendAndLog } from './progressHelper'
import { scanBrowserPage, deriveUrlPatterns } from './reconAgent'
import type { SiteMapRawFacts } from './reconAgent'
import { renderKnowledgeBlock } from '../../knowledge'

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

type ExplorationAction =
  | { action: 'navigate'; url: string }
  | { action: 'scanCurrentPage' }
  | { action: 'followLink'; linkText: string }
  | { action: 'checkContentType'; url: string }
  | { action: 'extractSampleText'; selector?: string }
  | { action: 'screenshot' }
  | { action: 'goBack' }
  | { action: 'done'; plan: StepPlan[]; variables: VariableDefinition[] }

interface VisitedPage {
  url: string
  title: string
  linkCount: number
  urlPatterns: string[]
  pdfLinksFound: number
  headings: Array<{ level: number; text: string }>
  contentSnippet: string
  contentType: 'html' | 'pdf' | 'error'
}

interface ContentTypeCheck {
  url: string
  type: string
  sizeBytes?: number
}

interface ExplorationContext {
  visitedPages: VisitedPage[]
  contentTypeChecks: ContentTypeCheck[]
  errors: string[]
  actionsRemaining: number
}

const MAX_EXPLORATION_BUDGET = 10

// ──────────────────────────────────────────────────────────────
// Gate function
// ──────────────────────────────────────────────────────────────

export function shouldUseExploratoryPlanning(task: TaskDefinition): boolean {
  if (!task.goal) return false
  if (!task.instruction) return false
  // Must contain a URL to explore
  if (!/https?:\/\/\S+/.test(task.instruction) && !/検索|Google|google|search/.test(task.instruction)) return false
  // Goal suggests information gathering
  return /取得|収集|ダウンロード|一覧|抽出|情報|CSV|csv|PDF|pdf|データ|data|調達|公募|調べ|スクレイピング|scrape|レポート|確認|内容|本文/i.test(task.goal)
}

// ──────────────────────────────────────────────────────────────
// Action executors
// ──────────────────────────────────────────────────────���───────

async function executeNavigate(
  page: Page, url: string, ctx: ExplorationContext,
): Promise<string> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
  const facts = await scanBrowserPage(page)
  const patterns = deriveUrlPatterns(facts)
  const pdfLinks = facts.links.filter(l => /\.pdf(\?|#|$)/i.test(l.href)).length

  ctx.visitedPages.push({
    url: facts.url, title: facts.title, linkCount: facts.linkCount,
    urlPatterns: patterns, pdfLinksFound: pdfLinks,
    headings: facts.headings.slice(0, 10),
    contentSnippet: facts.links.slice(0, 5).map(l => l.text).join(' / '),
    contentType: 'html',
  })

  return formatPageSummary(facts, patterns, pdfLinks)
}

async function executeScanCurrentPage(
  page: Page, ctx: ExplorationContext,
): Promise<string> {
  const facts = await scanBrowserPage(page)
  const patterns = deriveUrlPatterns(facts)
  const pdfLinks = facts.links.filter(l => /\.pdf(\?|#|$)/i.test(l.href)).length

  // Update or add
  const existing = ctx.visitedPages.find(p => p.url === facts.url)
  if (existing) {
    Object.assign(existing, { linkCount: facts.linkCount, urlPatterns: patterns, pdfLinksFound: pdfLinks })
  } else {
    ctx.visitedPages.push({
      url: facts.url, title: facts.title, linkCount: facts.linkCount,
      urlPatterns: patterns, pdfLinksFound: pdfLinks,
      headings: facts.headings.slice(0, 10),
      contentSnippet: facts.links.slice(0, 5).map(l => l.text).join(' / '),
      contentType: 'html',
    })
  }

  return formatPageSummary(facts, patterns, pdfLinks)
}

async function executeFollowLink(
  page: Page, linkText: string, ctx: ExplorationContext,
): Promise<string> {
  // Try multiple strategies to find and click the link
  const link = page.getByRole('link', { name: linkText }).first()
  const fallback = page.locator('a').filter({ hasText: linkText }).first()

  const target = await link.count() > 0 ? link : fallback
  if (await target.count() === 0) {
    return `Link "${linkText}" was not found. Try a different link text or navigate to the URL directly.`
  }

  await target.click()
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 })

  const facts = await scanBrowserPage(page)
  const patterns = deriveUrlPatterns(facts)
  const pdfLinks = facts.links.filter(l => /\.pdf(\?|#|$)/i.test(l.href)).length

  ctx.visitedPages.push({
    url: facts.url, title: facts.title, linkCount: facts.linkCount,
    urlPatterns: patterns, pdfLinksFound: pdfLinks,
    headings: facts.headings.slice(0, 10),
    contentSnippet: facts.links.slice(0, 5).map(l => l.text).join(' / '),
    contentType: 'html',
  })

  return `Navigated to: ${facts.url}\nTitle: ${facts.title}\n` + formatPageSummary(facts, patterns, pdfLinks)
}

async function executeCheckContentType(
  page: Page, url: string, ctx: ExplorationContext,
): Promise<string> {
  const resp = await page.context().request.head(url, { timeout: 8000 })
  const ct = resp.headers()['content-type'] ?? 'unknown'
  const cl = resp.headers()['content-length']
  const sizeBytes = cl ? parseInt(cl, 10) : undefined

  ctx.contentTypeChecks.push({ url, type: ct, sizeBytes })

  const sizeStr = sizeBytes ? ` (${(sizeBytes / 1024).toFixed(0)}KB)` : ''
  return `URL: ${url}\nContent-Type: ${ct}${sizeStr}`
}

async function executeExtractSampleText(
  page: Page, selector?: string,
): Promise<string> {
  if (selector) {
    const el = page.locator(selector).first()
    if (await el.count() > 0) {
      const text = await el.innerText()
      return `Text for selector "${selector}" (${text.length} chars):\n${text.slice(0, 1000)}`
    }
    return `Selector "${selector}" was not found.`
  }
  const text = await page.evaluate(() => document.body.innerText.slice(0, 1000))
  return `Page body text (first 1000 chars):\n${text}`
}

async function executeScreenshot(page: Page): Promise<{ text: string; image?: string }> {
  const buf = await page.screenshot({ type: 'png', fullPage: false })
  const base64 = buf.toString('base64')
  return {
    text: `Screenshot captured (${page.url()})`,
    image: base64,
  }
}

async function executeGoBack(page: Page): Promise<string> {
  await page.goBack({ timeout: 10000 })
  return `Back to: ${page.url()}`
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function formatPageSummary(facts: SiteMapRawFacts, patterns: string[], pdfLinks: number): string {
  const lines: string[] = []
  lines.push(`URL: ${facts.url}`)
  lines.push(`Title: ${facts.title}`)
  lines.push(`Link count: ${facts.linkCount} / Button count: ${facts.buttonCount} / Forms: ${facts.forms.length}`)
  if (pdfLinks > 0) lines.push(`⚠️ PDF links: ${pdfLinks}`)
  if (patterns.length > 0) {
    lines.push(`URL patterns: ${patterns.slice(0, 5).join('\n  ')}`)
  }
  if (facts.headings.length > 0) {
    lines.push(`Headings: ${facts.headings.slice(0, 8).map(h => `h${h.level}:${h.text}`).join(' | ')}`)
  }
  // Show representative links (first 15)
  if (facts.links.length > 0) {
    lines.push(`Top links (${Math.min(15, facts.links.length)}/${facts.links.length}):`)
    for (const l of facts.links.slice(0, 15)) {
      lines.push(`  - "${l.text.slice(0, 60)}" → ${l.href}`)
    }
  }
  return lines.join('\n')
}

function formatExplorationContext(ctx: ExplorationContext): string {
  const lines: string[] = []
  lines.push(`## Exploration so far`)
  lines.push(`Actions remaining: ${ctx.actionsRemaining}`)

  if (ctx.visitedPages.length > 0) {
    lines.push(`\n### Pages visited (${ctx.visitedPages.length})`)
    for (const p of ctx.visitedPages) {
      lines.push(`- ${p.title} (${p.url})`)
      lines.push(`  ${p.linkCount} links, ${p.pdfLinksFound} PDF links`)
      if (p.urlPatterns.length > 0) lines.push(`  patterns: ${p.urlPatterns.slice(0, 3).join(', ')}`)
      if (p.headings.length > 0) lines.push(`  headings: ${p.headings.slice(0, 5).map(h => h.text).join(' | ')}`)
    }
  }

  if (ctx.contentTypeChecks.length > 0) {
    lines.push(`\n### Content-Type checks (${ctx.contentTypeChecks.length})`)
    for (const c of ctx.contentTypeChecks) {
      const size = c.sizeBytes ? ` (${(c.sizeBytes / 1024).toFixed(0)}KB)` : ''
      lines.push(`- ${c.url}: ${c.type}${size}`)
    }
  }

  if (ctx.errors.length > 0) {
    lines.push(`\n### Errors`)
    for (const e of ctx.errors) lines.push(`- ${e}`)
  }

  return lines.join('\n')
}

function buildSystemPrompt(
  instruction: string,
  goal: string,
  ctx: ExplorationContext,
  priorStableSteps: StablePriorStep[],
): string {
  const priorBlock = priorStableSteps.length > 0
    ? `\n\n## Existing stable steps (do NOT regenerate)\n${priorStableSteps.map((s, i) => `${i + 1}. [${s.type}] ${s.name}: ${s.description}`).join('\n')}`
    : ''

  return `You are an "exploratory planner".
Given the user's task instruction and final goal, you explore the actual website or app first, then plan accurate execution steps.

## Your role
1. See the real structure of the site with your own eyes
2. Identify where the data lives (inside HTML, inside PDFs, in sub-pages, etc.)
3. Plan reliable execution steps based on confirmed facts

## Available actions
Return **exactly one action per turn** as JSON. JSON only — no explanation.

1. navigate — Go directly to a URL
   {"action": "navigate", "url": "https://..."}

2. scanCurrentPage — Deep-scan the current page
   {"action": "scanCurrentPage"}

3. followLink — Click a link on the page to navigate
   {"action": "followLink", "linkText": "link text (partial match OK)"}

4. checkContentType — Check a URL's Content-Type (PDF vs HTML, etc.)
   {"action": "checkContentType", "url": "https://..."}

5. extractSampleText — Extract text from the page
   {"action": "extractSampleText", "selector": "CSS selector (optional)"}

6. screenshot — Take a screenshot of the current page
   {"action": "screenshot"}

7. goBack — Go back to the previous page
   {"action": "goBack"}

8. done — Exploration finished, emit the final plan
   {"action": "done", "plan": [...], "variables": [...]}

## Exploration strategy
1. First, navigate to a URL from the instruction, or search on Google to reach the target site
2. Check the page structure (number of links, forms, URL patterns)
3. If there are links relevant to the goal, followLink a representative 1–2 of them
4. If there are PDF links, use checkContentType to check size and format
5. Once you have identified where the data lives (in HTML body, inside a PDF, in a table), emit done

## Key decisions
- Is the info on a list page? → followLink one representative link to confirm the detail structure
- Are there PDF links? → Confirm with checkContentType. If data is inside PDFs, include a pdf-parse step in the plan
- Is there pagination? → Use scanCurrentPage to confirm next-page links
- Is login required? → Include a needsLogin: true step in the plan

## Actions remaining: ${ctx.actionsRemaining}
Explore efficiently. 3–5 actions are usually enough.

## done action output format

### plan array
Each step has the form:
{"name": "step name", "description": "what to do. post-condition: verification condition", "type": "browser"}

### Step design rules
- 1 step = 1 side effect + 1 post-condition
- Always split reads and writes
- Include data-quality conditions in the post-condition ("ctx.shared.xxx exists" alone is insufficient)
- If PDF data must be extracted: explicitly mention using the pdf-parse library in the description
- If you need to fetch content behind a link: split into a list-fetch step and a detail-fetch step
- Include selectors and URL patterns discovered during exploration in the description so code generation can be accurate

### variables array
{"key": "variable name", "label": "display label", "type": "string", "required": true, "default": "user-specified value"}

### ★ Verbatim-value rule
User-specified URLs, person names, and numbers must be preserved verbatim in the variables default.

## Task instruction
${instruction}

## Final deliverable / goal
${goal}

${formatExplorationContext(ctx)}${priorBlock}${renderKnowledgeBlock({ taskDescription: instruction })}`
}

// ──────────────────────────────────────────────────────────────
// Main entry point
// ──────────────────────────────────────────────────────────────

export async function exploratoryPlan(
  config: AiProviderConfig,
  win: BrowserWindow | null,
  taskId: string,
  instruction: string,
  goal: string,
  page: Page,
  priorStableSteps: StablePriorStep[],
): Promise<{ plan: StepPlan[]; detectedVariables: VariableDefinition[]; planResult: { text: string; usage?: { totalTokens?: number } } }> {

  const ctx: ExplorationContext = {
    visitedPages: [],
    contentTypeChecks: [],
    errors: [],
    actionsRemaining: MAX_EXPLORATION_BUDGET,
  }

  // Conversation history (rolling window for token efficiency)
  const conversationHistory: Array<{ role: string; content: unknown }> = []
  let totalUsage = 0

  sendAndLog(win, taskId, {
    phase: 'planning',
    message: `🔭 Exploratory planning started (max ${MAX_EXPLORATION_BUDGET} actions)`,
  })

  while (ctx.actionsRemaining > 0) {
    // Build messages: system prompt (always fresh with latest context) + conversation tail
    const systemPrompt = buildSystemPrompt(instruction, goal, ctx, priorStableSteps)
    const messages: Array<{ role: string; content: unknown }> = [
      { role: 'system', content: systemPrompt },
      // Keep last 6 turns of conversation (3 pairs of action+result)
      ...conversationHistory.slice(-6),
    ]

    // If this is the first turn, add an initial user message
    if (conversationHistory.length === 0) {
      messages.push({
        role: 'user',
        content: 'Start the exploration. Read the instruction and goal, then decide the first action.',
      })
    }

    // Call AI
    let aiResult: { text: string; usage?: { totalTokens?: number } }
    try {
      aiResult = await chatNonStream(config, messages)
      if (aiResult.usage?.totalTokens) totalUsage += aiResult.usage.totalTokens
    } catch (err) {
      const msg = (err as Error).message
      if (msg === 'GENERATION_CANCELLED') throw err
      ctx.errors.push(`AI call error: ${msg}`)
      break
    }

    // Parse the AI's action
    const actionText = aiResult.text.trim()
    let action: ExplorationAction

    try {
      const jsonMatch = actionText.match(/```json\s*\n?([\s\S]*?)```/)
        ?? actionText.match(/(\{[\s\S]*"action"[\s\S]*\})/)
      if (!jsonMatch) throw new Error('No JSON found')
      action = JSON.parse(jsonMatch[1] || jsonMatch[0]) as ExplorationAction
      if (!action.action) throw new Error('Missing action field')
    } catch {
      // Retry once with correction
      sendAndLog(win, taskId, {
        phase: 'planning',
        message: `⚠️ AI response was invalid JSON — retrying...`,
      })
      conversationHistory.push(
        { role: 'assistant', content: actionText },
        { role: 'user', content: 'Return only JSON in the form {"action": "..."}.' },
      )
      continue
    }

    // Add AI response to conversation
    conversationHistory.push({ role: 'assistant', content: actionText })

    // ── Handle 'done' ──
    if (action.action === 'done') {
      const doneAction = action as { action: 'done'; plan: StepPlan[]; variables: VariableDefinition[] }
      const plan = Array.isArray(doneAction.plan) ? doneAction.plan : []
      const variables = Array.isArray(doneAction.variables) ? doneAction.variables : []

      if (plan.length === 0) {
        ctx.errors.push('AI returned an empty plan')
        conversationHistory.push({
          role: 'user',
          content: 'The plan is empty. Based on the exploration results, output a plan with at least one step via done.',
        })
        ctx.actionsRemaining--
        continue
      }

      sendAndLog(win, taskId, {
        phase: 'planning',
        message: `🔭 Exploration complete: generated an execution plan with ${plan.length} step${plan.length === 1 ? '' : 's'} (visited ${ctx.visitedPages.length} page${ctx.visitedPages.length === 1 ? '' : 's'}, checked ${ctx.contentTypeChecks.length} Content-Type${ctx.contentTypeChecks.length === 1 ? '' : 's'})`,
      }, JSON.stringify({ plan, variables, explorationContext: ctx }, null, 2))

      // Restore page to neutral state
      try {
        const firstUrl = instruction.match(/https?:\/\/\S+/)?.[0]
        await page.goto(firstUrl ?? 'about:blank', { timeout: 10000 })
      } catch { /* non-critical */ }

      return {
        plan,
        detectedVariables: variables,
        planResult: { text: actionText, usage: { totalTokens: totalUsage } },
      }
    }

    // ── Execute exploration action ──
    ctx.actionsRemaining--
    let resultText = ''
    let resultImage: string | undefined

    try {
      const actionDesc = describeAction(action)
      sendAndLog(win, taskId, {
        phase: 'planning',
        message: `🔭 Exploration [${ctx.actionsRemaining} left]: ${actionDesc}`,
      })

      switch (action.action) {
        case 'navigate':
          resultText = await executeNavigate(page, action.url, ctx)
          break
        case 'scanCurrentPage':
          resultText = await executeScanCurrentPage(page, ctx)
          break
        case 'followLink':
          resultText = await executeFollowLink(page, action.linkText, ctx)
          break
        case 'checkContentType':
          resultText = await executeCheckContentType(page, action.url, ctx)
          break
        case 'extractSampleText':
          resultText = await executeExtractSampleText(page, action.selector)
          break
        case 'screenshot': {
          const ssResult = await executeScreenshot(page)
          resultText = ssResult.text
          resultImage = ssResult.image
          break
        }
        case 'goBack':
          resultText = await executeGoBack(page)
          break
        default:
          resultText = `Unknown action: ${(action as { action: string }).action}`
      }
    } catch (err) {
      resultText = `Action execution error: ${(err as Error).message}`
      ctx.errors.push(resultText)
    }

    sendAndLog(win, taskId, {
      phase: 'planning',
      message: `🔭 Result: ${resultText.split('\n')[0].slice(0, 100)}`,
    })

    // Add result to conversation
    if (resultImage) {
      conversationHistory.push({
        role: 'user',
        content: [
          { type: 'text', text: `Action result:\n${resultText}` },
          { type: 'image', image: resultImage, mimeType: 'image/png' },
        ],
      })
    } else {
      conversationHistory.push({
        role: 'user',
        content: `Action result:\n${resultText}`,
      })
    }
  }

  // Budget exhausted — force done
  sendAndLog(win, taskId, {
    phase: 'planning',
    message: `🔭 Exploration budget exhausted — requesting final plan...`,
  })

  const forceMessages: Array<{ role: string; content: unknown }> = [
    { role: 'system', content: buildSystemPrompt(instruction, goal, ctx, priorStableSteps) },
    ...conversationHistory.slice(-4),
    { role: 'user', content: 'The exploration budget is exhausted. Based on the findings so far, output the plan now via the done action. Return JSON only.' },
  ]

  try {
    const forceResult = await chatNonStream(config, forceMessages)
    const jsonMatch = forceResult.text.match(/(\{[\s\S]*"action"\s*:\s*"done"[\s\S]*\})/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1]) as { action: 'done'; plan: StepPlan[]; variables: VariableDefinition[] }
      if (Array.isArray(parsed.plan) && parsed.plan.length > 0) {
        sendAndLog(win, taskId, {
          phase: 'planning',
          message: `🔭 Exploration complete (budget exhausted): generated ${parsed.plan.length}-step plan`,
        })
        try { await page.goto('about:blank', { timeout: 5000 }) } catch { /* */ }
        return {
          plan: parsed.plan,
          detectedVariables: parsed.variables ?? [],
          planResult: { text: forceResult.text, usage: { totalTokens: totalUsage } },
        }
      }
    }
  } catch { /* fall through */ }

  // Complete failure — throw to trigger fallback in aiAgent.ts
  throw new Error('Exploratory planning failed to produce a plan')
}

function describeAction(action: ExplorationAction): string {
  switch (action.action) {
    case 'navigate': return `Navigating to ${action.url}...`
    case 'scanCurrentPage': return 'Scanning the current page in detail...'
    case 'followLink': return `Investigating link "${action.linkText}"...`
    case 'checkContentType': return `Checking Content-Type of ${action.url}...`
    case 'extractSampleText': return `Extracting text${action.selector ? ` (${action.selector})` : ''}...`
    case 'screenshot': return 'Taking screenshot...'
    case 'goBack': return 'Going back to the previous page...'
    case 'done': return 'Emitting the plan...'
    default: return 'Unknown action'
  }
}
