// ─── AI Agent Orchestrator ───
// Main flow that coordinates all sub-agents to autonomously generate task steps.
//
// Agent pipeline per step:
//   1. planningAgent   — Decompose task into steps
//   2. analyzingAgent  — Analyze current page/desktop state
//   3. actionPlanAgent — Generate structured action plan
//   4. selectorAgent   — Resolve & verify selectors/AX elements
//   5. codegenAgent    — Generate TypeScript code
//   6. (execute)       — Run the generated code
//   7. verifyAgent     — AI-verify execution result
//   8. replanAgent     — Replan on repeated failures

import { ipcMain, BrowserWindow, screen } from 'electron'
import { v4 as uuid } from 'uuid'
import type { Page, BrowserContext } from 'playwright-core'
import fs from 'fs'
import path from 'path'
import { getDb } from '../db'
import { readTask, getTaskDir, writeTask } from './taskManager'
import { getActiveProvider } from './settingsManager'
import { launchProfileBrowser } from './profileManager'
import { createStepAiHelper, setAmbientAbortSignal, getAmbientAbortSignal } from './aiService'
import type {
  AiProviderConfig,
  StablePriorStep,
  StepMeta,
  StepPlan,
  DesktopContext,
  AXNode,
} from '../../shared/types'

// Import all agents
import {
  sendAndLog,
  planSteps,
  extractProducedSharedKeys,
  analyzeBrowserPage,
  analyzeDesktop,
  reanalyzeBrowser,
  reanalyzeDesktop,
  generateActionPlan,
  resolveActionSelectors,
  resolveDesktopActions,
  generateCodeFromResolvedActions,
  generateCodeFallback,
  verifyStepExecution,
  replanStep,
  diagnoseFailure,
  suggestUntriedStrategies,
  describeAttemptedStrategy,
  formatLedgerForPrompt,
  reconBrowserPage,
  formatSiteMapForPrompt,
  patchStepCode,
} from './agents'
import type { ResolvedAction, FailureDiagnosis, StrategyAttempt, SiteMap } from './agents'
import { shouldUseExploratoryPlanning, exploratoryPlan } from './agents/exploratoryPlanAgent'
import { createDesktopContext } from '../desktop/platform'
import { chatNonStream } from './agents/aiChat'

const MAX_FIX_RETRIES = 3

// ─── Element picker: wait for user to Cmd+Shift+E on target element ───

const pendingPickerResolvers = new Map<string, (el: AXNode | null) => void>()

/** Wait for the user to use the element picker (Cmd+Shift+E). */
async function askUserForElement(
  win: BrowserWindow | null,
  taskId: string,
  context: string,
): Promise<AXNode | null> {
  const questionId = uuid()
  const questionText = `🎯 Could not identify the target element.\n${context}\n\nHover over the element you want to operate on and press Cmd+Shift+E, or type "skip" to continue with auto-inference.`

  sendAndLog(win, taskId, {
    phase: 'askingUser',
    message: `❓ ${questionText}`,
    question: { id: questionId, text: questionText },
  })

  // Race: either the text answer or the element picker result
  return new Promise<AXNode | null>((resolve) => {
    let settled = false

    // Listen for text answer (skip)
    pendingAnswerResolvers.set(questionId, {
      taskId,
      text: questionText,
      askedAt: new Date().toISOString(),
      resolver: (_answer) => {
        if (settled) return
        settled = true
        pendingPickerResolvers.delete(questionId)
        sendAndLog(win, taskId, { phase: 'executing', message: '✅ Answer received' })
        resolve(null) // User chose to skip
      },
    })

    // Listen for element picker result
    const pickerHandler = (_event: unknown, result: { element: AXNode | null }) => {
      if (settled) return
      settled = true
      pendingAnswerResolvers.delete(questionId)
      // Dismiss the question UI
      sendAndLog(win, taskId, { phase: 'executing', message: `✅ Element received: ${result.element?.role ?? '?'} "${result.element?.title ?? ''}"` })
      resolve(result.element)
    }
    if (win && !win.isDestroyed()) {
      win.webContents.ipc.once('element-picker:user-picked', pickerHandler)
      pendingPickerResolvers.set(questionId, (el) => {
        if (settled) return
        settled = true
        resolve(el)
      })
    }

    // Timeout after 3 minutes
    setTimeout(() => {
      if (!settled) {
        settled = true
        pendingAnswerResolvers.delete(questionId)
        pendingPickerResolvers.delete(questionId)
        resolve(null)
      }
    }, 3 * 60 * 1000)
  })
}

// ─── Deep recon heuristic ───

/** Lightweight keyword check to decide if deep recon is worth trying. */
function isInformationGatheringGoal(goal: string): boolean {
  const kw = /取得|収集|ダウンロード|一覧|抽出|情報|gather|collect|download|extract|scrape|fetch|PDF|pdf|レポート|データ|data|調べ|確認|内容|本文|CSV|csv|調達|公募|案件/i
  return kw.test(goal)
}

// ─── Step compiler ───

async function compileStep(filePath: string): Promise<string> {
  const esbuild = await import(/* @vite-ignore */ 'esbuild')
  const outfile = filePath.replace(/\.ts$/, '.compiled.mjs')
  await esbuild.build({
    entryPoints: [filePath],
    bundle: false,
    format: 'esm',
    platform: 'node',
    outfile,
    target: 'node18',
  })
  return outfile
}

// ─── User Q&A mechanism ───

/**
 * Pending questions waiting for a user answer. Keyed by questionId.
 * Keeps metadata so external callers (MCP server, UI) can list what's open.
 */
interface PendingQuestion {
  taskId: string
  text: string
  infoKey?: string
  askedAt: string
  resolver: (answer: string) => void
}
const pendingAnswerResolvers = new Map<string, PendingQuestion>()

function getUserInfo(key: string): string | null {
  const db = getDb()
  const row = db.prepare('SELECT value FROM user_info WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

function saveUserInfo(key: string, value: string, label?: string): void {
  const db = getDb()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO user_info (id, key, value, label, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = ?, label = ?, updated_at = ?`
  ).run(uuid(), key, value, label ?? key, now, now, value, label ?? key, now)
}

async function askUser(
  win: BrowserWindow | null,
  taskId: string,
  questionText: string,
  infoKey?: string,
): Promise<string> {
  if (infoKey) {
    const saved = getUserInfo(infoKey)
    if (saved) return saved
  }

  const questionId = uuid()

  sendAndLog(win, taskId, {
    phase: 'askingUser',
    message: `❓ ${questionText}`,
    question: { id: questionId, text: questionText, infoKey },
  }, JSON.stringify({ questionId, questionText, infoKey }))

  const answer = await new Promise<string>((resolve) => {
    pendingAnswerResolvers.set(questionId, {
      taskId,
      text: questionText,
      infoKey,
      askedAt: new Date().toISOString(),
      resolver: resolve,
    })
    // Timeout after 5 minutes to prevent infinite hang
    setTimeout(() => {
      if (pendingAnswerResolvers.has(questionId)) {
        pendingAnswerResolvers.delete(questionId)
        resolve('')
      }
    }, 5 * 60 * 1000)
  })

  if (infoKey && answer) {
    saveUserInfo(infoKey, answer, questionText)
  }

  sendAndLog(win, taskId, {
    phase: 'executing',
    message: `✅ Answer received`,
  })

  return answer
}

// ─── Login wait mechanism ───

const pendingLoginResolvers = new Map<string, () => void>()

async function waitForUserLogin(
  win: BrowserWindow | null,
  taskId: string,
  context: BrowserContext,
  url: string
): Promise<Page> {
  sendAndLog(win, taskId, {
    phase: 'waitingForLogin',
    message: `🔐 Login required: ${url}\nLog in via the browser, then click "Login complete".`,
  })

  await new Promise<void>((resolve) => {
    pendingLoginResolvers.set(taskId, resolve)
  })

  const allPages = context.pages()
  let activePage = allPages[allPages.length - 1]

  for (const p of allPages) {
    const pUrl = p.url()
    if (pUrl === 'about:blank') continue
    if (/accounts\.google\.com|login|oauth|authorize|signin/i.test(pUrl)) continue
    activePage = p
  }

  try {
    await activePage.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {})
  } catch { /* may already be idle */ }

  sendAndLog(win, taskId, {
    phase: 'executing',
    message: `✅ Login confirmed (${activePage.url()})`,
  })

  return activePage
}

// ─── Helper: extract selectors from generated code for error tracking ───

function extractSelectorsFromCode(code: string): string[] {
  const selectors: string[] = []

  const cssPatterns = code.matchAll(
    /(?:page\.(?:locator|click|fill|waitForSelector|\$|querySelector))\s*\(\s*['"]([^'"]+)['"]/g
  )
  for (const match of cssPatterns) selectors.push(match[1])

  const roleNamePatterns = code.matchAll(
    /page\.getByRole\s*\(\s*['"]([^'"]+)['"](?:\s*,\s*\{\s*name:\s*['"]([^'"]+)['"])?\s*\)/g
  )
  for (const match of roleNamePatterns) {
    const [, role, name] = match
    selectors.push(`getByRole('${role}'${name ? `, { name: '${name}' }` : ''})`)
  }

  const textPatterns = code.matchAll(/page\.getByText\s*\(\s*['"]([^'"]+)['"]/g)
  for (const match of textPatterns) selectors.push(`getByText('${match[1]}')`)

  const placeholderPatterns = code.matchAll(/page\.getByPlaceholder\s*\(\s*['"]([^'"]+)['"]/g)
  for (const match of placeholderPatterns) selectors.push(`getByPlaceholder('${match[1]}')`)

  const labelPatterns = code.matchAll(/page\.getByLabel\s*\(\s*['"]([^'"]+)['"]/g)
  for (const match of labelPatterns) selectors.push(`getByLabel('${match[1]}')`)

  return selectors
}

// ─── Main agent flow ───

// Original bounds are captured before docking so we can restore the window
// to its full size once generation finishes.
let savedWindowBounds: { id: number; x: number; y: number; width: number; height: number } | null = null

// Move the app window to the right edge of its current display AND shrink
// it to a compact side-panel size so the user can see generation logs
// while the agent drives other desktop apps across the rest of the screen.
function dockWindowRight(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return
  try {
    const bounds = win.getBounds()
    const display = screen.getDisplayMatching(bounds)
    const { x: dx, y: dy, width: dw, height: dh } = display.workArea

    // Save current bounds for later restore.
    savedWindowBounds = { id: win.id, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }

    // Compact panel: ~33% of display width, capped to [420, 640]px; full height.
    const targetWidth = Math.min(640, Math.max(420, Math.floor(dw * 0.33)))
    const newWidth = Math.min(targetWidth, dw)
    const newHeight = dh
    win.setBounds({
      x: dx + dw - newWidth,
      y: dy,
      width: newWidth,
      height: newHeight,
    })
  } catch (err) {
    console.warn('[aiAgent] dockWindowRight failed:', err)
  }
}

// Restore the app window to the bounds captured by the last dockWindowRight().
function restoreWindowBounds(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return
  if (!savedWindowBounds || savedWindowBounds.id !== win.id) return
  try {
    win.setBounds({
      x: savedWindowBounds.x,
      y: savedWindowBounds.y,
      width: savedWindowBounds.width,
      height: savedWindowBounds.height,
    })
  } catch (err) {
    console.warn('[aiAgent] restoreWindowBounds failed:', err)
  } finally {
    savedWindowBounds = null
  }
}

async function runAutonomousGeneration(
  win: BrowserWindow | null,
  taskId: string,
  instruction: string
): Promise<void> {
  // Install an AbortController for this generation. Its signal is:
  //   1. set as the ambient signal on aiService so every chat() call aborts
  //   2. raced against stepModule.run() to interrupt step code execution
  //   3. tripped by cancel() below to stop everything in one shot
  const abortController = new AbortController()
  activeAbortControllers.set(taskId, abortController)
  setAmbientAbortSignal(abortController.signal)

  activeGenerations.set(taskId, {
    cancel: () => {
      try { abortController.abort() } catch { /* ignore */ }
    },
  })

  // Dock the window to the right so debug logs stay visible while the
  // agent drives other desktop apps.
  dockWindowRight(win)

  const provider = getActiveProvider()
  if (!provider) {
    activeGenerations.delete(taskId)
    throw new Error('No active AI provider configured')
  }

  const task = readTask(taskId)
  const taskDir = getTaskDir(taskId)

  // Save instruction to task definition for future reference.
  // initialInstruction is a write-once field — preserved across regenerations so
  // the user can always see what the task was originally created from.
  // IMPORTANT: mutate the in-memory `task` object too, because subsequent
  // writeTask() calls below (for detectedVariables, step registration, etc.)
  // persist `task` and would otherwise drop these fields.
  const now = new Date().toISOString()
  task.instruction = instruction
  task.initialInstruction = task.initialInstruction ?? instruction
  task.initialInstructionAt = task.initialInstructionAt ?? now
  task.updatedAt = now
  writeTask(task)

  // ── Build "prior stable steps" summary for incremental replanning ──
  // When a task already has stable steps (e.g. from a previous generation
  // that got partway through before being cancelled or hitting a broken
  // step), the planner MUST be told about them so it plans only the delta.
  // Otherwise it recreates the full pipeline from scratch and we end up
  // with duplicate Mail-launch / fetch / parse steps that burn retries.
  //
  // For each stable step we:
  //   1. reuse persisted producedSharedKeys if present
  //   2. otherwise scan the step's code file and backfill the field
  //      (best-effort — if the file is missing, treat as unknown = [])
  const priorStableSteps: StablePriorStep[] = []
  let anyBackfill = false
  for (const s of task.steps) {
    if (s.status !== 'stable') continue
    let producedSharedKeys = s.producedSharedKeys
    if (producedSharedKeys === undefined) {
      try {
        const fp = path.join(taskDir, s.file)
        if (fs.existsSync(fp)) {
          producedSharedKeys = extractProducedSharedKeys(fs.readFileSync(fp, 'utf-8'))
        } else {
          producedSharedKeys = []
        }
      } catch {
        producedSharedKeys = []
      }
      s.producedSharedKeys = producedSharedKeys
      anyBackfill = true
    }
    priorStableSteps.push({
      order: s.order,
      name: s.file.replace(/^step_\d+_/, '').replace(/\.ts$/, '').replace(/_/g, ' '),
      description: s.description,
      type: s.type,
      producedSharedKeys,
    })
  }
  if (anyBackfill) {
    // Persist the backfilled producedSharedKeys so subsequent regens don't
    // have to re-scan.
    writeTask(task)
  }

  if (priorStableSteps.length > 0) {
    sendAndLog(win, taskId, {
      phase: 'planning',
      message: `🧩 Recognized ${priorStableSteps.length} existing stable step${priorStableSteps.length === 1 ? '' : 's'} as prior context — planning only the remaining delta`,
    }, JSON.stringify(priorStableSteps, null, 2))
  }

  // Context variables — declared early so exploratoryPlan can use ensureBrowser()
  const profileId = task.profileId || `_auto_${taskId}`
  let context: BrowserContext | null = null
  let page: Page | null = null
  let desktopCtx: DesktopContext | null = null

  async function ensureBrowser() {
    if (context) return
    context = await launchProfileBrowser(profileId)
    const pages = context.pages()
    page = pages.length > 0 ? pages[0] : await context.newPage()
    context.on('page', (newPage) => {
      page = newPage
      newPage.once('close', () => {
        const remaining = context!.pages()
        if (remaining.length > 0) page = remaining[remaining.length - 1]
      })
    })
  }

  async function ensureDesktop() {
    if (desktopCtx) return
    desktopCtx = await createDesktopContext()
  }

  // Upgrade the registered cancel() now that a browser context exists:
  // abort in-flight chat() / step code AND close the browser.
  activeGenerations.set(taskId, {
    cancel: () => {
      try { abortController.abort() } catch { /* ignore */ }
      context?.close().catch(() => {})
    },
  })

  // Phase 1: Planning — exploratory (with browser) or standard (text-only)
  let plan: StepPlan[]
  let detectedVariables: VariableDefinition[]
  let planResult: { text: string; usage?: { totalTokens?: number } }

  if (shouldUseExploratoryPlanning(task)) {
    // Exploratory planning: open browser, explore the site, then plan
    await ensureBrowser()
    sendAndLog(win, taskId, {
      phase: 'planning',
      message: '🔭 Exploratory planning: investigating site structure before planning...',
    })
    try {
      ;({ plan, detectedVariables, planResult } = await exploratoryPlan(
        provider, win, taskId, instruction, task.goal!, page!, priorStableSteps,
      ))
    } catch (exploratoryErr) {
      const errMsg = (exploratoryErr as Error).message
      if (errMsg === 'GENERATION_CANCELLED') throw exploratoryErr
      sendAndLog(win, taskId, {
        phase: 'planning',
        message: `⚠️ Exploratory planning failed — falling back to normal planning: ${errMsg}`,
      })
      ;({ plan, detectedVariables, planResult } = await planSteps(provider, win, taskId, instruction, priorStableSteps, task.goal))
    }
  } else {
    ;({ plan, detectedVariables, planResult } = await planSteps(provider, win, taskId, instruction, priorStableSteps, task.goal))
  }

  // Merge AI-detected variables into task definition
  if (detectedVariables.length > 0) {
    const existingKeys = new Set(task.variables.map(v => v.key))
    for (const dv of detectedVariables) {
      if (!existingKeys.has(dv.key)) {
        task.variables.push(dv)
      } else {
        // Update default if AI detected a specific value from user input
        const existing = task.variables.find(v => v.key === dv.key)
        if (existing && dv.default) {
          existing.default = dv.default
        }
      }
    }
    // Persist updated variables
    const { writeTask } = await import('./taskManager')
    writeTask(task)
  }

  // Log planning
  const db = getDb()
  db.prepare(
    `INSERT INTO ai_logs (id, task_id, step_id, type, prompt, response, provider, model, tokens_used, status, created_at)
     VALUES (?, ?, NULL, 'generation', ?, ?, ?, ?, ?, 'approved', ?)`
  ).run(
    uuid(), taskId,
    JSON.stringify({ instruction }),
    planResult.text,
    provider.name, provider.model,
    planResult.usage?.totalTokens ?? null,
    new Date().toISOString()
  )

  // Send plan to frontend so the step list renders immediately
  sendAndLog(win, taskId, {
    phase: 'planning',
    message: `📋 Decomposed into ${plan.length} step${plan.length === 1 ? '' : 's'}`,
    plan: plan.map(s => ({ name: s.name, description: s.description })),
  })

  // Build execution variables from task variable defaults (used during generation test-runs).
  // IMPORTANT: treat empty-string defaults the same as missing. The planner prompt already
  // forbids empty defaults ("❌ default を空文字にする → 生成中のテスト実行で必ず失敗する")
  // but the AI doesn't always comply, so we need a safety net here. Otherwise generated
  // code that maps ctx.input.xxx to a URL slug/action produces malformed URLs
  // (e.g. the zodiac→slug mapper outputs an error message that becomes the URL path)
  // and triggers infinite retry loops on 404 pages.
  const executionInput: Record<string, string> = {}
  for (const v of task.variables) {
    const raw = v.default ?? ''
    executionInput[v.key] = raw.trim() !== '' ? raw : `__placeholder_${v.key}__`
  }

  // ── Eagerly resolve placeholder variables before any step runs ──
  // When required variables have no default, we need real test values BEFORE
  // entering the step loop. This avoids mid-step surprises and lets every step
  // use consistent test values from the start.
  {
    const placeholders = task.variables.filter(v =>
      executionInput[v.key]?.startsWith('__placeholder_')
    )
    if (placeholders.length > 0) {
      sendAndLog(win, taskId, {
        phase: 'planning',
        message: `🎯 ${placeholders.length} variable${placeholders.length === 1 ? '' : 's'} have no default value — generating test values`,
      })

      for (const v of placeholders) {
        // Try AI-generated test value
        let testValue = ''
        try {
          const aiResult = await chatNonStream(provider, [
            {
              role: 'system',
              content: `You are an assistant that generates test values for task automation.
For a test run of the user's task, propose **one realistic, concrete test value** for the variable.

Rules:
- Return only the value (no explanation, no quotation marks, no surrounding whitespace)
- Use a realistic, real-world-looking value (no placeholder / fake test data)
- For Japanese-language tasks, return a Japanese value
- For URLs, use a real URL
- For person names, use a common name (Japanese for Japanese tasks, English for English tasks)
- For zodiac signs, use the language matching the task (e.g. おひつじ座 for Japanese)
- For dates, use YYYY-MM-DD format`,
            },
            {
              role: 'user',
              content: `Task: ${instruction}
Variable name: ${v.key}
Variable label: ${v.label}

Return exactly one test value for this variable.`,
            },
          ])
          testValue = aiResult.text.trim().replace(/^["'`]|["'`]$/g, '')
        } catch {
          // AI failed — fall through to user prompt
        }

        // If AI produced something, show it and ask for confirmation or override
        if (testValue && !testValue.startsWith('__placeholder_')) {
          const confirmed = await askUser(
            win,
            taskId,
            `Will use "${testValue}" as the test value for "${v.label}". To change it, enter a new value (leave blank to keep).`,
          )
          if (confirmed.trim()) {
            testValue = confirmed.trim()
          }
        } else {
          // AI couldn't generate — ask user directly
          testValue = await askUser(
            win,
            taskId,
            `Please enter a value for "${v.label}" to run the test`,
          )
        }

        // Apply
        if (testValue && testValue.trim()) {
          executionInput[v.key] = testValue.trim()
          v.default = testValue.trim()
          writeTask(task)

          sendAndLog(win, taskId, {
            phase: 'planning',
            message: `✅ Variable "${v.label}" = ${testValue.trim()}`,
          })
        }
      }
    }
  }

  let lastUsedAppName = ''
  let lastUsedLaunchName = ''
  let lastTargetPid: number | undefined

  // Login confirmation is per-session (Playwright context). Once the user has
  // confirmed login during this generation run, subsequent needsLogin steps
  // are skipped — they would just re-prompt the user for something that's
  // already done. planningAgent sometimes marks every browser step as
  // needsLogin=true so we need this deduplication to keep UX sane.
  let loginAlreadyConfirmedThisRun = false

  // ── Cross-step shared state (must be the SAME object across step runs) ──
  // Generated steps write intermediate data to ctx.shared.xxx and the next step
  // reads them. If we pass a fresh {} to each run() call, any data handoff
  // breaks and the next step fails with "データが見つかりません" style errors,
  // which then gets misdiagnosed as a window lookup failure. See also
  // taskRunner.ts which already handles this correctly for production runs.
  const executionShared: Record<string, unknown> = {}

  // ── Guard: prevent infinite retry_previous loops ──
  // Each step index can only be retried via retry_previous once per generation run.
  const retryPreviousUsed = new Set<string>()

  // ── Cross-step execution results (shared between steps) ──
  // Accumulates results from each completed step so subsequent steps can adapt.
  const stepResults: Array<{
    stepName: string
    description: string
    success: boolean
    error?: string
    verifyReason?: string
    codeSnippet?: string
  }> = []

  try {
    stepLoop: for (let i = 0; i < plan.length; i++) {
      if (!activeGenerations.has(taskId) || abortController.signal.aborted) {
        sendAndLog(win, taskId, { phase: 'error', message: '⛔ Generation was cancelled' })
        return
      }

      const stepPlan = plan[i]
      const stepNum = String(task.steps.length + i + 1).padStart(2, '0')
      const stepId = `step_${stepNum}`
      const fileName = `step_${stepNum}_${stepPlan.name.replace(/[^a-zA-Z0-9\u3040-\u9faf]/g, '_').slice(0, 30)}.ts`

      sendAndLog(win, taskId, {
        phase: 'generating',
        stepIndex: i,
        stepName: stepPlan.name,
        message: `Step ${i + 1}/${plan.length}: generating ${stepPlan.name}...`,
      })

      // ── Pre-check: Try existing step file first (skip regeneration if still works) ──
      const existingFilePath = path.join(taskDir, fileName)
      if (fs.existsSync(existingFilePath)) {
        // Scan existing code for ctx.input.XXX and add to executionInput.
        // Only populate keys that are declared as task variables with defaults.
        // Undeclared keys are left undefined so `ctx.input.xxx ?? 'default'` fallbacks work.
        const existingCode0 = fs.readFileSync(existingFilePath, 'utf8')
        for (const match of existingCode0.matchAll(/ctx\.input\.(\w+)/g)) {
          const key = match[1]
          if (executionInput[key] !== undefined) continue
          const varDef = task.variables.find(v => v.key === key)
          if (varDef?.default !== undefined && varDef.default.trim() !== '') {
            executionInput[key] = varDef.default
          }
        }

        sendAndLog(win, taskId, {
          phase: 'executing',
          stepIndex: i,
          stepName: stepPlan.name,
          message: `🔄 Trying the existing step code...`,
        })
        try {
          const stepType0 = stepPlan.type ?? 'browser'
          if (stepType0 === 'desktop') await ensureDesktop()
          else await ensureBrowser()

          const compiledPath0 = await compileStep(existingFilePath)
          const fileUrl0 = new URL(`file://${compiledPath0}`).href
          // Clear module cache for re-import
          const stepModule0 = await import(/* @vite-ignore */ fileUrl0 + `?t=${Date.now()}`)
          const timeout0 = stepModule0.meta?.timeout ?? 30000
          await raceWithAbort(taskId, Promise.race([
            stepType0 === 'desktop'
              ? stepModule0.run(desktopCtx, { profile: {}, input: executionInput, shared: executionShared, ai: createStepAiHelper() })
              : stepModule0.run(page!, context, { profile: {}, input: executionInput, shared: executionShared, ai: createStepAiHelper() }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`Timed out after ${timeout0}ms`)), timeout0)
            ),
          ]))
          try { fs.unlinkSync(compiledPath0) } catch { /* ignore */ }

          sendAndLog(win, taskId, {
            phase: 'executing',
            stepIndex: i,
            stepName: stepPlan.name,
            message: `✅ Step ${i + 1}: existing code succeeded — skipping regeneration`,
          })

          // Register existing step and continue
          const existingCode = fs.readFileSync(existingFilePath, 'utf-8')
          const existingStep = task.steps.find(s => s.file === fileName)
          if (!existingStep) {
            const newStep: StepMeta = {
              id: stepId, order: task.steps.length + i + 1, file: fileName,
              description: stepPlan.description, type: stepPlan.type === 'desktop' ? 'desktop' : 'browser',
              status: 'stable', lastSuccess: new Date().toISOString(), failCount: 0, aiRevisionCount: 0,
              producedSharedKeys: extractProducedSharedKeys(existingCode),
            }
            task.steps.push(newStep)
            writeTask(task)
          }
          continue stepLoop
        } catch (tryErr) {
          sendAndLog(win, taskId, {
            phase: 'fixing',
            stepIndex: i,
            stepName: stepPlan.name,
            message: `⚠️ Existing code failed — regenerating: ${(tryErr as Error).message}`,
          })
          // Fall through to full generation pipeline
        }
      }

      // ── Phase A: Page/Desktop Analysis (via analyzingAgent) ──
      const stepType = stepPlan.type ?? 'browser'
      let pageHtml = ''
      let screenshot = ''
      let selectorMap = ''
      let siteMap: SiteMap | null = null

      if (stepType === 'desktop') {
        await ensureDesktop()
        const result = await analyzeDesktop(provider, desktopCtx!, win, taskId, i, stepPlan, lastUsedAppName)
        pageHtml = result.pageHtml
        screenshot = result.screenshot
        selectorMap = result.selectorMap
        lastUsedAppName = result.updatedAppName
        lastUsedLaunchName = result.launchName
        lastTargetPid = result.targetPid
      } else {
        await ensureBrowser()
        const result = await analyzeBrowserPage(page!, win, taskId, i, stepPlan.name)
        pageHtml = result.pageHtml
        screenshot = result.screenshot
        selectorMap = result.selectorMap

        // ── Phase A.5: Recon scan (browser only) ──
        // Collect structured siteMap (links/buttons/forms/url patterns + goal-aware
        // candidates) before the AI has to make a plan. See reconAgent.ts for the
        // full rationale. Failures here are swallowed — recon is a nice-to-have.
        //
        // Deep recon: when a task goal suggests information gathering, also follow
        // representative sub-pages to understand the site structure (PDF links,
        // detail pages, etc.) before generating an action plan.
        const deepReconEnabled = Boolean(task.goal) && isInformationGatheringGoal(task.goal)
        try {
          siteMap = await reconBrowserPage(provider, page!, win, taskId, i, stepPlan, {
            deepRecon: deepReconEnabled,
          })
        } catch (reconErr) {
          sendAndLog(win, taskId, {
            phase: 'analyzing',
            stepIndex: i,
            stepName: stepPlan.name,
            message: `⚠️ Recon phase threw — continuing with normal analysis only: ${(reconErr as Error).message}`,
          })
          siteMap = null
        }
      }

      // Handle login steps.
      // Skip conditions (to avoid spurious login prompts):
      //   1. Already confirmed this run — same Playwright context, login is persistent
      //   2. Current URL is about:blank — no meaningful page to assess. Open the
      //      target URL first and let a subsequent step trigger login if needed.
      if (stepPlan.needsLogin && stepType !== 'desktop') {
        const currentUrl = page!.url()
        if (loginAlreadyConfirmedThisRun) {
          sendAndLog(win, taskId, {
            phase: 'executing',
            stepIndex: i,
            stepName: stepPlan.name,
            message: `⏭️ Step ${i + 1}: already logged in — skipping needsLogin`,
          })
          // Fall through to normal step generation (don't create a no-op step)
        } else if (currentUrl === 'about:blank' || currentUrl === '') {
          sendAndLog(win, taskId, {
            phase: 'planning',
            stepIndex: i,
            stepName: stepPlan.name,
            message: `⏭️ Current URL is about:blank — deferring login check to subsequent steps`,
          })
          // Fall through — step will try to navigate; if it hits a login wall,
          // the retry / replan pipeline will handle it.
        } else {
          page = await waitForUserLogin(win, taskId, context!, currentUrl)
          if (!activeGenerations.has(taskId)) {
            sendAndLog(win, taskId, { phase: 'error', message: '⛔ Generation was cancelled' })
            return
          }

          // Mark this run as logged-in so subsequent needsLogin steps skip the prompt
          loginAlreadyConfirmedThisRun = true

          sendAndLog(win, taskId, {
            phase: 'executing',
            stepIndex: i,
            stepName: stepPlan.name,
            message: `✅ Step ${i + 1}: user is logged in — skipping`,
          })

          const newStep: StepMeta = {
            id: stepId, order: task.steps.length + i + 1, file: fileName,
            description: `${stepPlan.description} (user logged in manually)`,
            type: 'browser', status: 'stable',
            lastSuccess: new Date().toISOString(), failCount: 0, aiRevisionCount: 0,
            producedSharedKeys: [], // manual-login no-op does not write ctx.shared
          }
          const noopCode = `import type { Page, BrowserContext } from 'playwright-core';
export interface StepContext { profile: Record<string, string>; input: Record<string, string>; shared: Record<string, unknown>; ai: (prompt: string) => Promise<string>; }
export async function run(page: Page, _context: BrowserContext, _ctx: StepContext): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
}
export const meta = { description: '${stepPlan.description.replace(/'/g, "\\'")} (user manual login)', retryable: false, timeout: 10000 };
`
          fs.writeFileSync(path.join(taskDir, fileName), noopCode)
          task.steps.push(newStep)
          writeTask(task)
          continue stepLoop
        }
      }

      // Collect existing step codes (only last 2, truncated to limit token usage)
      const existingCodes: string[] = []
      const recentSteps = task.steps.slice(-2)
      for (const s of recentSteps) {
        const fp = path.join(taskDir, s.file)
        if (fs.existsSync(fp)) {
          let content = fs.readFileSync(fp, 'utf-8')
          // Truncate large step files to prevent token overflow
          if (content.length > 3000) {
            content = content.slice(0, 1500) + '\n// ... (snip: total ' + content.length + ' chars) ...\n' + content.slice(-1500)
          }
          existingCodes.push(content)
        }
      }

      const errorHistory: Array<{ attempt: number; error: string; selectors: string[]; codeSnippet: string }> = []
      // ── Structured failure diagnosis + strategy ledger (carried across retries) ──
      const diagnosisHistory: FailureDiagnosis[] = []
      const triedStrategies: StrategyAttempt[] = []
      let untriedStrategies: string[] = []
      let success = false
      let lastError = ''
      let retries = 0
      let code = ''
      let prevResolvedActions: ResolvedAction[] = []  // Cache resolved actions for retry reuse

      while (!success && retries <= MAX_FIX_RETRIES) {
        if (!activeGenerations.has(taskId)) {
          sendAndLog(win, taskId, { phase: 'error', message: '⛔ Generation was cancelled' })
          return
        }

        // Re-analyze on retry (via analyzingAgent)
        if (retries > 0) {
          if (stepType === 'desktop') {
            // ── Pre-retry cleanup: if the previous error looks like a blocking
            // modal (display dialog / display alert / stuck prompt), dismiss any
            // stacked modal dialogs before retrying. Otherwise the retry runs
            // against a UI obscured by the previous run's leftover dialogs and
            // fails again for a new reason.
            const prevErrText = errorHistory.at(-1)?.error ?? lastError
            if (/display\s+(dialog|alert)|choose\s+(from\s+list|file|folder)|prompt\s*\(/i.test(prevErrText)) {
              sendAndLog(win, taskId, {
                phase: 'fixing',
                stepIndex: i,
                stepName: stepPlan.name,
                message: `🧹 Closing leftover modal dialogs from the previous retry with Escape...`,
              })
              try {
                // Send several Escape presses via System Events. This dismisses
                // stacked AppleScript display dialogs without side effects on
                // the target app's main UI.
                const { execFile } = await import('child_process')
                const { promisify } = await import('util')
                const exec = promisify(execFile)
                // key code 53 = Escape, key code 36 = Return. Press Escape 6 times
                // (handles up to 6 stacked dialogs) then give the UI a moment to settle.
                await exec('osascript', ['-e', 'tell application "System Events" to repeat 6 times\nkey code 53\ndelay 0.1\nend repeat'])
                await new Promise(r => setTimeout(r, 400))
              } catch { /* ignore — modal dismiss is best-effort */ }
            }

            // Desktop retry: only update screenshot (AX tree and elements are cached)
            sendAndLog(win, taskId, {
              phase: 'fixing',
              stepIndex: i,
              stepName: stepPlan.name,
              message: `🔄 Refreshing screenshot (retry ${retries}/${MAX_FIX_RETRIES})...`,
            })
            try {
              const buf = await desktopCtx!.screenshot()
              screenshot = buf.toString('base64')
            } catch { /* */ }
          } else {
            sendAndLog(win, taskId, {
              phase: 'fixing',
              stepIndex: i,
              stepName: stepPlan.name,
              message: `🔄 Re-analyzing page (retry ${retries}/${MAX_FIX_RETRIES})...`,
            })
            try {
              const result = await reanalyzeBrowser(page!, win, taskId, i, stepPlan.name, retries)
              pageHtml = result.pageHtml; screenshot = result.screenshot; selectorMap = result.selectorMap
            } catch { /* page might be in a weird state */ }
          }
        }

        // ── Phase B-0: On retry, try patch-based fix first (much cheaper than full regen) ──
        if (retries > 0 && code) {
          const patchedCode = await patchStepCode(
            provider, win, taskId, stepPlan, i,
            code, lastError, stepType,
            selectorMap || undefined,
            formatLedgerForPrompt(
              { tried: triedStrategies, untried: untriedStrategies },
              diagnosisHistory,
            ),
            task.variables,
          )
          if (patchedCode) {
            // Patch succeeded — skip full pipeline, go straight to execution
            code = patchedCode
            const patchedFilePath = path.join(taskDir, fileName)
            fs.writeFileSync(patchedFilePath, code)

            sendAndLog(win, taskId, {
              phase: 'generating',
              stepIndex: i,
              stepName: stepPlan.name,
              message: `🩹 Patch fix complete — trying execution`,
            })

            // Jump to execution (Phase E) — reuse the existing code variable
            // The execution block below will pick up the updated `code`
            // We need to skip Phases B-D, so we use a goto-like pattern:
            // set a flag and let the code fall through to Phase E
            // (The simplest approach: just skip to execution directly)
            goto_execute: {
              sendAndLog(win, taskId, {
                phase: 'executing',
                stepIndex: i,
                stepName: stepPlan.name,
                message: `Step ${i + 1}: executing... (after patch fix)`,
              })

              // Auto-detect ctx.input.XXX keys
              for (const match of code.matchAll(/ctx\.input\.(\w+)/g)) {
                const key = match[1]
                if (!executionInput[key]) {
                  const varDef = task.variables.find(v => v.key === key)
                  executionInput[key] = varDef?.default ?? `__placeholder_${key}__`
                }
              }

              let beforeScreenshot = ''
              try {
                if (stepType === 'desktop') {
                  const buf = await desktopCtx!.screenshot()
                  beforeScreenshot = buf.toString('base64')
                } else {
                  const buf = await page!.screenshot({ fullPage: false })
                  beforeScreenshot = buf.toString('base64')
                }
              } catch { /* */ }

              try {
                const compiledPath = await compileStep(patchedFilePath)
                const fileUrl = new URL(`file://${compiledPath}`).href
                const stepModule = await import(/* @vite-ignore */ fileUrl + `?t=${Date.now()}`)
                const timeout = stepModule.meta?.timeout ?? 30000
                await Promise.race([
                  stepType === 'desktop'
                    ? stepModule.run(desktopCtx, { profile: {}, input: executionInput, shared: executionShared, ai: createStepAiHelper() })
                    : stepModule.run(page!, context, { profile: {}, input: executionInput, shared: executionShared, ai: createStepAiHelper() }),
                  new Promise((_, reject) =>
                    setTimeout(() => reject(new Error(`Timed out after ${timeout}ms`)), timeout)
                  ),
                ])
                try { fs.unlinkSync(compiledPath) } catch { /* */ }

                let afterScreenshot = ''
                try {
                  if (stepType === 'desktop') {
                    const buf = await desktopCtx!.screenshot()
                    afterScreenshot = buf.toString('base64')
                  } else {
                    const buf = await page!.screenshot({ fullPage: false })
                    afterScreenshot = buf.toString('base64')
                  }
                } catch { /* */ }

                const verification = await verifyStepExecution(
                  provider, stepPlan.description,
                  beforeScreenshot, afterScreenshot, stepType,
                  win, i, stepPlan.name, taskId,
                  { error: undefined },
                )

                if (verification.success) {
                  success = true
                  stepResults.push({ stepName: stepPlan.name, description: stepPlan.description, success: true })
                  sendAndLog(win, taskId, {
                    phase: 'executing', stepIndex: i, stepName: stepPlan.name,
                    message: `✅ Step ${i + 1}: succeeded after patch fix`,
                  })
                  break goto_execute
                }
                // Verification failed — will continue to full regen below
                lastError = `AI verification failed: ${verification.reason ?? 'result mismatch'}`
              } catch (err) {
                lastError = (err as Error).message
              }
              // Patch execution failed — fall through to full pipeline
              sendAndLog(win, taskId, {
                phase: 'fixing', stepIndex: i, stepName: stepPlan.name,
                message: `⚠️ Still failed after patch fix — falling back to full regeneration: ${lastError}`,
              })
            }
            if (success) continue  // Step succeeded via patch, move to next step
          }
        }

        // ── Phase B: Generate action plan (via actionPlanAgent) ──
        sendAndLog(win, taskId, {
          phase: 'generating',
          stepIndex: i,
          stepName: stepPlan.name,
          message: retries === 0
            ? `📋 Generating action plan...`
            : `📋 Regenerating action plan (retry ${retries}/${MAX_FIX_RETRIES})...`,
        })

        const ledgerText = formatLedgerForPrompt(
          { tried: triedStrategies, untried: untriedStrategies },
          diagnosisHistory,
        )

        const planResult2 = await generateActionPlan(
          provider, win, taskId, stepPlan, i,
          stepType === 'desktop' ? '' : page!.url(),
          screenshot, selectorMap, pageHtml, existingCodes,
          errorHistory.map(h => ({ attempt: h.attempt, error: h.error, selectors: h.selectors })),
          stepType === 'desktop' ? lastUsedAppName : undefined,
          stepType === 'desktop' ? lastUsedLaunchName : undefined,
          stepResults,
          ledgerText,
          siteMap ?? undefined,
          task.goal,
          executionShared,
          task.variables,
        )

        // Persist action plan to DB for MCP debugging
        sendAndLog(win, taskId, {
          phase: 'generating',
          stepIndex: i,
          stepName: stepPlan.name,
          message: `✅ Action plan generation complete (${planResult2.actions.length} action${planResult2.actions.length === 1 ? '' : 's'})`,
        }, JSON.stringify({
          actions: planResult2.actions,
          question: planResult2.question,
          retry: retries,
          errorHistory: errorHistory.map(h => ({ attempt: h.attempt, error: h.error })),
          appName: lastUsedAppName,
          launchName: lastUsedLaunchName,
        }, null, 2))

        // Handle question from AI
        if (planResult2.question) {
          const answer = await askUser(win, taskId, planResult2.question.question, planResult2.question.infoKey)
          if (!activeGenerations.has(taskId)) {
            sendAndLog(win, taskId, { phase: 'error', message: '⛔ Generation was cancelled' })
            return
          }
          stepPlan.description += `\n\nUser answer: ${planResult2.question.question} → ${answer}`
          continue
        }

        // Handle alreadyDone — step goal already achieved by current page state
        // During generation, the previous step may have navigated past this step's target.
        // We still need to generate proper code for the step (for standalone re-execution),
        // but we can skip execution/verification and mark it as done.
        if (planResult2.alreadyDone) {
          sendAndLog(win, taskId, {
            phase: 'executing',
            stepIndex: i,
            stepName: stepPlan.name,
            message: `⏭️ Step ${i + 1}: skipped (objective already achieved)`,
          })

          // Generate actual working code for the step (not a no-op) so it works in standalone runs
          const skipFilePath = path.join(taskDir, fileName)
          if (!fs.existsSync(skipFilePath)) {
            // Fall through to normal code generation but with a simplified action plan
            // For goto-like steps, generate a simple navigation step
            const fallbackCode = stepType === 'desktop'
              ? `import type { DesktopContext } from '../../src/main/desktop/types';
export interface StepContext { profile: Record<string, string>; input: Record<string, string>; shared: Record<string, unknown>; ai: (prompt: string) => Promise<string>; }
export async function run(ctx: DesktopContext, stepCtx: StepContext): Promise<void> {
  // Auto-generated: ${stepPlan.description}
}
export const meta = { description: '${stepPlan.description.replace(/'/g, "\\'")}', retryable: true, timeout: 5000 };`
              : `import type { Page, BrowserContext } from 'playwright-core';
export interface StepContext { profile: Record<string, string>; input: Record<string, string>; shared: Record<string, unknown>; ai: (prompt: string) => Promise<string>; }
export async function run(page: Page, context: BrowserContext, ctx: StepContext): Promise<void> {
  // Auto-generated: ${stepPlan.description}
  await page.waitForLoadState('domcontentloaded');
}
export const meta = { description: '${stepPlan.description.replace(/'/g, "\\'")}', retryable: true, timeout: 10000 };`
            fs.writeFileSync(skipFilePath, fallbackCode)
          }

          // Register step but avoid duplicates
          if (!task.steps.some(s => s.file === fileName)) {
            const fallbackCodeForScan = fs.existsSync(skipFilePath)
              ? fs.readFileSync(skipFilePath, 'utf-8')
              : ''
            const newStep: StepMeta = {
              id: stepId, order: task.steps.length + i + 1, file: fileName,
              description: stepPlan.description, type: stepType,
              status: 'stable', lastSuccess: new Date().toISOString(), failCount: 0, aiRevisionCount: 0,
              producedSharedKeys: extractProducedSharedKeys(fallbackCodeForScan),
            }
            task.steps.push(newStep)
            writeTask(task)
          }
          success = true
          break
        }

        // ── Phase C: Resolve selectors/elements (via selectorAgent) ──
        // On retry, reuse previously resolved actions if the action plan references the same elements.
        // EXCEPTION: if the last 2+ attempts failed with the same diagnosis category, that's a sign
        // we're stuck in a loop on the same approach. Throw away the cache and force full re-resolution
        // so the fresh action plan can pick entirely different AX elements.
        const lastTwoDiag = diagnosisHistory.slice(-2)
        const stuckInSameCategory =
          lastTwoDiag.length === 2
          && lastTwoDiag[0].category === lastTwoDiag[1].category
          && lastTwoDiag[0].category !== 'code_compile_error'
        if (stuckInSameCategory && retries > 0 && prevResolvedActions.length > 0) {
          sendAndLog(win, taskId, {
            phase: 'fixing',
            stepIndex: i,
            stepName: stepPlan.name,
            message: `🔁 Same failure category persists (${lastTwoDiag[0].category}) — discarding selector cache and fully re-resolving via a different path`,
          })
          prevResolvedActions = []
        }

        let resolvedActions: ResolvedAction[] = []
        if (planResult2.actions.length > 0) {
          if (retries > 0 && prevResolvedActions.length > 0 && stepType === 'desktop') {
            // Build a cache map from previous resolution: key = "axRole:axTitle" → resolved element
            const prevCache = new Map<string, ResolvedAction>()
            for (const ra of prevResolvedActions) {
              if (ra.resolvedDesktop?.found) {
                const key = `${ra.action.axRole ?? ''}:${ra.action.axTitle ?? ''}`
                prevCache.set(key, ra)
              }
            }

            // Try to reuse for each action in the new plan
            const reusable: ResolvedAction[] = []
            const needResolve: typeof planResult2.actions = []
            for (const action of planResult2.actions) {
              if (action.axRole) {
                const key = `${action.axRole}:${action.axTitle ?? ''}`
                const cached = prevCache.get(key)
                if (cached) {
                  reusable.push({ action, resolvedDesktop: cached.resolvedDesktop })
                  continue
                }
              }
              // No axRole or not cached — need to resolve
              if (action.action === 'open_app' || action.action === 'shell'
                  || action.action === 'type_text' || action.action === 'hotkey'
                  || action.action === 'press_key' || action.action === 'click_position'
                  || action.action === 'wait' || action.action === 'activate_app') {
                reusable.push({ action })
              } else {
                needResolve.push(action)
              }
            }

            if (needResolve.length === 0) {
              resolvedActions = reusable
              sendAndLog(win, taskId, {
                phase: 'selector',
                stepIndex: i,
                stepName: stepPlan.name,
                message: `♻️ Reusing previously resolved elements (${reusable.length})`,
              })
            } else {
              // Resolve only the new/uncached elements
              const newlyResolved = await resolveDesktopActions(desktopCtx!, needResolve, win, i, stepPlan.name, taskId, lastTargetPid)
              // Merge: maintain original order
              const newCache = new Map<string, ResolvedAction>()
              for (const ra of newlyResolved) {
                const key = `${ra.action.axRole ?? ''}:${ra.action.axTitle ?? ''}`
                newCache.set(key, ra)
              }
              resolvedActions = planResult2.actions.map(action => {
                const key = `${action.axRole ?? ''}:${action.axTitle ?? ''}`
                const cached = prevCache.get(key)
                if (cached) return { action, resolvedDesktop: cached.resolvedDesktop }
                const fresh = newCache.get(key)
                if (fresh) return fresh
                return { action }
              })
            }
          } else if (stepType === 'desktop') {
            resolvedActions = await resolveDesktopActions(desktopCtx!, planResult2.actions, win, i, stepPlan.name, taskId, lastTargetPid)
          } else {
            resolvedActions = await resolveActionSelectors(page!, planResult2.actions, win, i, stepPlan.name, taskId)
          }

          let unresolvedCount = resolvedActions.filter(ra => ra.unresolved).length

          // ── Pre-codegen probe-replan: if any action is unresolved AND we have
          // real candidate lists from the AX tree, re-invoke actionPlanAgent ONCE
          // with those candidates so it can pick a real axTitle instead of going
          // through a full codegen+execute+diagnose cycle with a guessed value.
          if (stepType === 'desktop' && unresolvedCount > 0) {
            const hintLines: string[] = []
            for (const ra of resolvedActions) {
              if (!ra.unresolved || !ra.resolvedDesktop?.candidates?.length) continue
              const cands = ra.resolvedDesktop.candidates
                .slice(0, 10)
                .map(c => `    - ${c.axRole} "${c.axTitle || c.description || '(no title)'}"${c.position ? ` @ (${Math.round(c.position.x)},${Math.round(c.position.y)})` : ''}`)
                .join('\n')
              hintLines.push(
                `- The ${ra.action.axRole} "${ra.action.axTitle ?? ''}" specified in action "${ra.action.description}" does not exist.\n`
                + `  Candidates that do exist (same role):\n${cands}`,
              )
            }

            if (hintLines.length > 0) {
              sendAndLog(win, taskId, {
                phase: 'selector',
                stepIndex: i,
                stepName: stepPlan.name,
                message: `🔁 Will retry actionPlanAgent with candidate suggestions for ${unresolvedCount} unresolved element${unresolvedCount === 1 ? '' : 's'}`,
              }, hintLines.join('\n\n'))

              const probeHint = `\n\n## Verification result against the real AX tree (important)\n${hintLines.join('\n\n')}\n\n★ これらの候補から本当に必要な要素の axTitle を選び直してアクションプランを再生成すること。推測の文字列ではなく、上の「実在する候補」のリストに**正確に存在する**axTitle をそのまま使うこと。`

              const replanStepPlan = {
                ...stepPlan,
                description: stepPlan.description + probeHint,
              }

              try {
                const probeResult = await generateActionPlan(
                  provider, win, taskId, replanStepPlan, i,
                  '',
                  screenshot, selectorMap, pageHtml, existingCodes,
                  errorHistory.map(h => ({ attempt: h.attempt, error: h.error, selectors: h.selectors })),
                  lastUsedAppName,
                  lastUsedLaunchName,
                  stepResults,
                  ledgerText,
                  undefined,
                  task.goal,
                  executionShared,
                  task.variables,
                )
                if (probeResult.actions.length > 0) {
                  const reresolved = await resolveDesktopActions(
                    desktopCtx!, probeResult.actions, win, i, stepPlan.name, taskId, lastTargetPid,
                  )
                  const newUnresolved = reresolved.filter(ra => ra.unresolved).length
                  if (newUnresolved < unresolvedCount) {
                    sendAndLog(win, taskId, {
                      phase: 'selector',
                      stepIndex: i,
                      stepName: stepPlan.name,
                      message: `✅ Probe replan reduced unresolved count from ${unresolvedCount} → ${newUnresolved}`,
                    })
                    resolvedActions = reresolved
                    unresolvedCount = newUnresolved
                    // Replace the plan we'll feed into codegen
                    planResult2.actions = probeResult.actions
                    prevResolvedActions = reresolved
                  } else {
                    sendAndLog(win, taskId, {
                      phase: 'selector',
                      stepIndex: i,
                      stepName: stepPlan.name,
                      message: `⚠️ Probe replan did not reduce unresolved count (${unresolvedCount}) — proceeding to codegen anyway`,
                    })
                  }
                }
              } catch (probeErr) {
                sendAndLog(win, taskId, {
                  phase: 'selector',
                  stepIndex: i,
                  stepName: stepPlan.name,
                  message: `⚠️ Probe replan failed: ${(probeErr as Error).message}`,
                })
              }
            }
          }

          if (unresolvedCount > 0) {
            sendAndLog(win, taskId, {
              phase: 'selector',
              stepIndex: i,
              stepName: stepPlan.name,
              message: `⚠️ ${unresolvedCount} selector${unresolvedCount === 1 ? '' : 's'} unresolved — AI will generate fallback code`,
            })
          }

          // Update cache for next retry
          prevResolvedActions = resolvedActions

          // Persist resolved selectors to DB for MCP debugging
          const selectorSummary = resolvedActions.map(ra => ({
            desc: ra.action.description,
            action: ra.action.action,
            axRole: ra.action.axRole,
            axTitle: ra.action.axTitle,
            selector: ra.action.selector,
            resolved: ra.resolvedDesktop ? {
              found: ra.resolvedDesktop.found,
              title: ra.resolvedDesktop.title,
              pid: ra.resolvedDesktop.pid,
              x: ra.resolvedDesktop.x,
              y: ra.resolvedDesktop.y,
            } : ra.resolvedSelector ? {
              found: ra.resolvedSelector.found,
              selector: ra.resolvedSelector.selector,
            } : undefined,
            unresolved: ra.unresolved,
          }))
          sendAndLog(win, taskId, {
            phase: 'selector',
            stepIndex: i,
            stepName: stepPlan.name,
            message: `✅ Selector resolution complete: ${resolvedActions.length} (unresolved: ${resolvedActions.filter(ra => ra.unresolved).length})`,
          }, JSON.stringify(selectorSummary, null, 2))
        }

        // ── Phase D: Generate code (via codegenAgent) ──
        if (resolvedActions.length > 0) {
          code = await generateCodeFromResolvedActions(
            provider, win, stepPlan, i, resolvedActions,
            stepType === 'desktop' ? '' : page!.url(),
            existingCodes, stepType, taskId, task.variables,
            stepType === 'desktop' ? lastUsedAppName : undefined,
            stepType === 'desktop' ? lastUsedLaunchName : undefined,
            stepResults,
            ledgerText,
            siteMap ?? undefined,
          )
        } else {
          code = await generateCodeFallback(
            provider, win, stepPlan, i,
            stepType === 'desktop' ? '' : page!.url(),
            screenshot, selectorMap, pageHtml, existingCodes,
            errorHistory.map(h => ({ attempt: h.attempt, error: h.error })),
            stepType, taskId, task.variables,
            stepType === 'desktop' ? lastUsedAppName : undefined,
            stepType === 'desktop' ? lastUsedLaunchName : undefined,
            stepResults,
            ledgerText,
            siteMap ?? undefined,
          )
        }

        // Persist generated code to DB for MCP debugging
        sendAndLog(win, taskId, {
          phase: 'generating',
          stepIndex: i,
          stepName: stepPlan.name,
          message: `💻 Code generation complete (${code.length} chars, retry: ${retries})`,
        }, code)

        // Validate code
        if (!code || !code.includes('function') || !code.includes('run')) {
          lastError = `Code generation failed: AI did not return valid TypeScript code (empty or missing run function)`
          retries++
          continue
        }

        // Auto-detect ctx.input.XXX keys in generated code and populate executionInput
        // from declared task variable defaults. Undeclared keys are left undefined so
        // that `ctx.input.xxx ?? 'default'` fallbacks in generated code work correctly.
        // (Previously we filled undeclared keys with `__placeholder_${key}__`, which
        // is truthy and silently defeats the `??` fallback pattern.)
        for (const match of code.matchAll(/ctx\.input\.(\w+)/g)) {
          const key = match[1]
          if (executionInput[key] !== undefined) continue
          const varDef = task.variables.find(v => v.key === key)
          if (varDef?.default !== undefined && varDef.default.trim() !== '') {
            executionInput[key] = varDef.default
          }
        }

        // Save step file
        const stepFilePath = path.join(taskDir, fileName)
        fs.writeFileSync(stepFilePath, code)

        // Log generation
        db.prepare(
          `INSERT INTO ai_logs (id, task_id, step_id, type, prompt, response, provider, model, tokens_used, status, created_at)
           VALUES (?, ?, ?, 'generation', ?, ?, ?, ?, ?, 'approved', ?)`
        ).run(
          uuid(), taskId, stepId,
          JSON.stringify({ phase: retries === 0 ? 'initial' : `retry_${retries}`, stepDescription: stepPlan.description }),
          code, provider.name, provider.model, null, new Date().toISOString()
        )

        // ── Pre-execution: catch any remaining placeholder variables ──
        // Most placeholders are resolved eagerly before the step loop. This is
        // a safety net for variables the codegen introduced that weren't in the
        // original task.variables list (rare but possible).
        const usedInputKeys = [...code.matchAll(/ctx\.input\.(\w+)/g)].map(m => m[1])
        const remainingPlaceholders = usedInputKeys.filter(k =>
          executionInput[k]?.startsWith('__placeholder_')
        )
        if (remainingPlaceholders.length > 0) {
          for (const key of remainingPlaceholders) {
            const varLabel = task.variables.find(v => v.key === key)?.label ?? key
            const answer = await askUser(
              win,
              taskId,
              `Please enter a value for "${varLabel}" to run the test`,
            )
            if (answer.trim()) {
              executionInput[key] = answer.trim()
            }
          }
        }

        // ── Phase E: Execute step ──
        sendAndLog(win, taskId, {
          phase: 'executing',
          stepIndex: i,
          stepName: stepPlan.name,
          message: `Step ${i + 1}: executing...`,
        })

        // Take before screenshot
        let beforeScreenshot = ''
        try {
          if (stepType === 'desktop') {
            const buf = await desktopCtx!.screenshot()
            beforeScreenshot = buf.toString('base64')
          } else {
            const buf = await page!.screenshot({ fullPage: false })
            beforeScreenshot = buf.toString('base64')
          }
        } catch { /* */ }

        try {
          const compiledPath = await compileStep(stepFilePath)
          const fileUrl = new URL(`file://${compiledPath}`).href
          const stepModule = await import(/* @vite-ignore */ fileUrl)

          const timeout = stepModule.meta?.timeout ?? 30000
          await raceWithAbort(taskId, Promise.race([
            stepType === 'desktop'
              ? stepModule.run(desktopCtx, { profile: {}, input: executionInput, shared: executionShared, ai: createStepAiHelper() })
              : stepModule.run(page!, context, { profile: {}, input: executionInput, shared: executionShared, ai: createStepAiHelper() }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`Timed out after ${timeout}ms`)), timeout)
            ),
          ]))

          try { fs.unlinkSync(compiledPath) } catch { /* */ }

          // Take after screenshot — wait for the screen to settle first.
          // The step's run() function returns as soon as the last AppleScript/
          // Playwright call resolves, but UI updates (window focus, dialog
          // appearance, animation) can lag several hundred ms behind. Capturing
          // immediately produces a stale "after" shot that makes verifyAgent
          // see no change and report false failures.
          //
          // Strategy: take an initial shot, wait, take another, and compare.
          // Repeat until two consecutive shots are similar enough (delta < 1%)
          // or we hit the max settling timeout.
          let afterScreenshot = ''
          try {
            const captureShot = async (): Promise<Buffer> => {
              if (stepType === 'desktop') {
                return await desktopCtx!.screenshot()
              } else {
                return await page!.screenshot({ fullPage: false })
              }
            }

            // Quick initial delay lets the OS compositor flush the post-call
            // frame before our first capture.
            const initialDelay = stepType === 'desktop' ? 400 : 200
            await new Promise(r => setTimeout(r, initialDelay))

            let prevBuf = await captureShot()
            const maxSettleMs = 2000
            const pollIntervalMs = 300
            const settleStart = Date.now()
            while (Date.now() - settleStart < maxSettleMs) {
              await new Promise(r => setTimeout(r, pollIntervalMs))
              const nextBuf = await captureShot()
              // Cheap similarity check: compare byte length + first/last bytes
              // as a proxy for "did anything change". PNG output from the same
              // screen is byte-identical when the pixels are identical, so
              // length equality is a strong signal of a settled frame.
              const settled = nextBuf.length === prevBuf.length
                && nextBuf[0] === prevBuf[0]
                && nextBuf[nextBuf.length - 1] === prevBuf[prevBuf.length - 1]
                && nextBuf.equals(prevBuf)
              prevBuf = nextBuf
              if (settled) break
            }
            afterScreenshot = prevBuf.toString('base64')
          } catch { /* */ }

          // ── Phase F: AI-based verification (via verifyAgent) ──
          const verification = await verifyStepExecution(
            provider, stepPlan.description,
            beforeScreenshot, afterScreenshot, stepType,
            win, i, stepPlan.name, taskId,
            { error: undefined },
            executionShared,
            task.goal,
          )

          if (verification.success) {
            success = true
            const afterScreenshotForLog = afterScreenshot.length < 500 * 1024 ? afterScreenshot : undefined

            // Record successful step result for cross-step context
            stepResults.push({
              stepName: stepPlan.name,
              description: stepPlan.description,
              success: true,
            })

            sendAndLog(win, taskId, {
              phase: 'executing',
              stepIndex: i,
              stepName: stepPlan.name,
              message: `✅ Step ${i + 1}: success (verified)`,
              screenshot: afterScreenshotForLog,
            })
          } else {
            lastError = `AI verification failed: ${verification.reason ?? 'execution result does not match step expectations'}`
            retries++

            const attemptedSelectors = extractSelectorsFromCode(code)
            errorHistory.push({ attempt: retries, error: lastError, selectors: attemptedSelectors, codeSnippet: code })

            // ── Structured diagnosis: verification failed ──
            const diag = diagnoseFailure({
              attempt: retries,
              rawError: lastError,
              stage: 'verify',
              verifyReason: verification.reason,
              code,
              resolvedActions,
              stepType,
            })
            diagnosisHistory.push(diag)
            triedStrategies.push({
              attempt: retries,
              strategy: describeAttemptedStrategy(code, resolvedActions, stepType),
              category: diag.category,
              hypothesis: diag.hypothesis,
            })
            const newSuggestions = suggestUntriedStrategies(diag, stepType, triedStrategies.map(t => t.strategy))
            for (const s of newSuggestions) {
              if (!untriedStrategies.includes(s)) untriedStrategies.push(s)
            }
            // Drop suggestions that match strategies already tried this loop
            untriedStrategies = untriedStrategies.filter(
              s => !triedStrategies.some(t => t.strategy.toLowerCase().includes(s.toLowerCase().slice(0, 20)))
            )

            sendAndLog(win, taskId, {
              phase: 'fixing',
              stepIndex: i,
              stepName: stepPlan.name,
              message: `🔬 Diagnosis: [${diag.category}] ${diag.hypothesis}`,
            }, JSON.stringify({
              diagnosis: diag,
              triedStrategies,
              untriedStrategies,
            }, null, 2))

            if (retries <= MAX_FIX_RETRIES) {
              const afterScreenshotSmall = afterScreenshot.length < 500 * 1024 ? afterScreenshot : undefined
              sendAndLog(win, taskId, {
                phase: 'fixing',
                stepIndex: i,
                stepName: stepPlan.name,
                message: `⚠️ Verification failed (retry ${retries}/${MAX_FIX_RETRIES}): ${lastError}`,
                screenshot: afterScreenshotSmall,
              }, JSON.stringify({
                verificationReason: verification.reason,
                errorHistory: errorHistory.map(h => ({ attempt: h.attempt, error: h.error })),
                failedCode: code.slice(0, 3000),
              }, null, 2))
            }
          }
        } catch (err) {
          lastError = (err as Error).message
          retries++

          const attemptedSelectors = extractSelectorsFromCode(code)
          errorHistory.push({ attempt: retries, error: lastError, selectors: attemptedSelectors, codeSnippet: code })

          // ── Structured diagnosis: runtime/compile error ──
          const stage: 'compile' | 'execute' =
            /cannot find module|esbuild|syntaxerror|module not found/i.test(lastError)
              ? 'compile' : 'execute'
          const diag = diagnoseFailure({
            attempt: retries,
            rawError: lastError,
            stage,
            code,
            resolvedActions,
            stepType,
          })
          diagnosisHistory.push(diag)
          triedStrategies.push({
            attempt: retries,
            strategy: describeAttemptedStrategy(code, resolvedActions, stepType),
            category: diag.category,
            hypothesis: diag.hypothesis,
          })
          const newSuggestions = suggestUntriedStrategies(diag, stepType, triedStrategies.map(t => t.strategy))
          for (const s of newSuggestions) {
            if (!untriedStrategies.includes(s)) untriedStrategies.push(s)
          }
          untriedStrategies = untriedStrategies.filter(
            s => !triedStrategies.some(t => t.strategy.toLowerCase().includes(s.toLowerCase().slice(0, 20)))
          )

          sendAndLog(win, taskId, {
            phase: 'fixing',
            stepIndex: i,
            stepName: stepPlan.name,
            message: `🔬 Diagnosis: [${diag.category}] @ ${diag.where} — ${diag.hypothesis}`,
          }, JSON.stringify({
            diagnosis: diag,
            triedStrategies,
            untriedStrategies,
          }, null, 2))

          // ── Early bailout for cross-step data handoff failures ──
          // When the issue is that the previous step didn't provide data via ctx.shared,
          // retrying the current step won't help. After 1 self-recovery attempt (which
          // tries to re-extract data within this step), escalate to replan immediately
          // so retry_previous can kick in.
          if (diag.category === 'precondition_not_met'
              && diag.where?.includes('ctx.shared')
              && retries >= 2 && i > 0) {
            sendAndLog(win, taskId, {
              phase: 'fixing',
              stepIndex: i,
              stepName: stepPlan.name,
              message: `🔙 Cause is missing data from a previous step — further retries are pointless, moving to replanning`,
            })
            // Force exit retry loop to trigger replan
            retries = MAX_FIX_RETRIES + 1
            break
          }

          // ── Ask user to pick element when AX resolution keeps failing ──
          // After 2+ failures on selector/element issues, ask the user to visually
          // identify the target element using the element picker (Cmd+Shift+E).
          const isAxFailure = ['selector_resolution_failed', 'element_not_found_runtime', 'action_execution_error'].includes(diag.category)
            && stepType === 'desktop'
          if (isAxFailure && retries >= 2) {
            const failedElement = diag.where || lastError.slice(0, 80)
            sendAndLog(win, taskId, {
              phase: 'fixing', stepIndex: i, stepName: stepPlan.name,
              message: `🎯 Failed to identify AX element ${retries} times. Asking the user to specify the element...`,
            })
            const pickedElement = await askUserForElement(win, taskId,
              `Cannot find the element you want to operate on in step "${stepPlan.name}".\nFailure reason: ${failedElement}`)

            if (pickedElement) {
              // Inject the user-picked element info into the strategy ledger
              // so the next retry uses it directly
              const hint = `[user-specified element] role=${pickedElement.role} title="${pickedElement.title ?? ''}" path=${pickedElement.path} position=(${pickedElement.position?.x},${pickedElement.position?.y})`
              untriedStrategies.unshift(hint)
              sendAndLog(win, taskId, {
                phase: 'fixing', stepIndex: i, stepName: stepPlan.name,
                message: `✅ User specified the element: ${pickedElement.role} "${pickedElement.title ?? ''}" @ (${pickedElement.position?.x}, ${pickedElement.position?.y})`,
              })
            }
          }

          let errorScreenshotForUI = ''
          let errorHtmlForUI = ''
          try {
            if (stepType === 'desktop') {
              const buf = await desktopCtx!.screenshot()
              errorScreenshotForUI = buf.toString('base64')
            } else {
              const buf = await page!.screenshot({ fullPage: false })
              errorScreenshotForUI = buf.toString('base64')
              errorHtmlForUI = await page!.content()
            }
          } catch { /* */ }

          if (retries <= MAX_FIX_RETRIES) {
            const errScreenshotSmall = errorScreenshotForUI.length < 500 * 1024 ? errorScreenshotForUI : undefined
            sendAndLog(win, taskId, {
              phase: 'fixing',
              stepIndex: i,
              stepName: stepPlan.name,
              message: `⚠️ Error occurred (retry ${retries}/${MAX_FIX_RETRIES}): ${lastError}`,
              screenshot: errScreenshotSmall,
              html: errorHtmlForUI.slice(0, 8000),
            }, JSON.stringify({
              errorHistory: errorHistory.map(h => ({ attempt: h.attempt, error: h.error, selectors: h.selectors })),
              failedCode: code.slice(0, 3000),
              appName: lastUsedAppName,
              launchName: lastUsedLaunchName,
            }, null, 2))
          }

          db.prepare(
            `INSERT INTO ai_logs (id, task_id, step_id, type, prompt, response, provider, model, tokens_used, status, created_at)
             VALUES (?, ?, ?, 'fix', ?, ?, ?, ?, ?, 'approved', ?)`
          ).run(
            uuid(), taskId, stepId,
            JSON.stringify({ attempt: retries, error: lastError, selectors: attemptedSelectors }),
            code, provider.name, provider.model, null, new Date().toISOString()
          )
        }
      }

      // Replanning on repeated failures (via replanAgent)
      if (!success && retries > MAX_FIX_RETRIES) {
        let errorScreenshotForReplan = ''
        let errorHtmlForReplan = ''
        try {
          if (stepType === 'desktop') {
            const buf = await desktopCtx!.screenshot()
            errorScreenshotForReplan = buf.toString('base64')
          } else {
            const buf = await page!.screenshot({ fullPage: false })
            errorScreenshotForReplan = buf.toString('base64')
            errorHtmlForReplan = await page!.content()
          }
        } catch { /* */ }

        const decision = await replanStep(
          provider, win, stepPlan, i, stepType,
          lastError, errorHistory.map(h => ({ attempt: h.attempt, error: h.error, selectors: h.selectors })),
          MAX_FIX_RETRIES, errorScreenshotForReplan, errorHtmlForReplan,
        )

        if (decision) {
          if (decision.action === 'split' && Array.isArray(decision.steps)) {
            const splitSteps = decision.steps.map((s: StepPlan) => ({
              ...s,
              type: s.type === 'browser' || s.type === 'desktop' ? s.type : stepType,
            }))
            sendAndLog(win, taskId, {
              phase: 'planning',
              message: `📋 Splitting step "${stepPlan.name}" into ${splitSteps.length} (${stepType})`,
            })
            plan.splice(i, 1, ...splitSteps)
            i--
            continue stepLoop
          }

          if (decision.action === 'replace' && decision.step) {
            const replacedStep = {
              ...decision.step,
              type: decision.step.type === 'browser' || decision.step.type === 'desktop' ? decision.step.type : stepType,
            }
            sendAndLog(win, taskId, {
              phase: 'planning',
              message: `📋 Replacing step "${stepPlan.name}" → "${replacedStep.name}" (${stepType})`,
            })
            plan[i] = replacedStep
            i--
            continue stepLoop
          }

          if (decision.action === 'skip') {
            // Record skipped step for cross-step context
            stepResults.push({
              stepName: stepPlan.name,
              description: stepPlan.description,
              success: false,
              error: lastError,
              verifyReason: decision.reason,
            })
            sendAndLog(win, taskId, {
              phase: 'executing',
              stepIndex: i,
              stepName: stepPlan.name,
              message: `⏭️ Skipping step "${stepPlan.name}": ${decision.reason}`,
            })
            continue stepLoop
          }

          if (decision.action === 'retry_previous' && i > 0) {
            const goBack = Math.min(decision.goBackSteps ?? 1, i)
            const targetIdx = i - goBack

            // Guard against infinite retry_previous loops: each step can only be retried once this way
            const targetKey = `retry_prev_${targetIdx}`
            if (retryPreviousUsed.has(targetKey)) {
              sendAndLog(win, taskId, {
                phase: 'fixing',
                stepIndex: i,
                stepName: stepPlan.name,
                message: `⚠️ Step ${targetIdx + 1} was already re-run via retry_previous — no further rewind`,
              })
            } else {
              retryPreviousUsed.add(targetKey)

              // Remove the steps that will be re-generated (from targetIdx to i inclusive)
              // Delete their step files and remove from task.steps so they get regenerated.
              // Look up by plan step name pattern to find the correct file regardless of numbering.
              for (let j = i; j >= targetIdx; j--) {
                const planStep = plan[j]
                const nameSlug = planStep.name.replace(/[^a-zA-Z0-9\u3040-\u9faf]/g, '_').slice(0, 30)
                // Find the registered step whose file contains this name slug
                const stepIdx = task.steps.findIndex(s => s.file.includes(nameSlug))
                if (stepIdx >= 0) {
                  const fName = task.steps[stepIdx].file
                  const filePath = path.join(taskDir, fName)
                  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath) } catch { /* ignore */ }
                  task.steps.splice(stepIdx, 1)
                }
              }
              writeTask(task)

              // Remove stepResults for the steps we're re-doing
              while (stepResults.length > targetIdx) stepResults.pop()

              sendAndLog(win, taskId, {
                phase: 'planning',
                stepIndex: targetIdx,
                stepName: plan[targetIdx].name,
                message: `🔙 Going back to step ${targetIdx + 1} "${plan[targetIdx].name}" and regenerating: ${decision.reason}`,
              })

              // Jump back in the loop
              i = targetIdx - 1  // will be incremented by for-loop
              continue stepLoop
            }
          }
        }

        // Record failed step for cross-step context
        stepResults.push({
          stepName: stepPlan.name,
          description: stepPlan.description,
          success: false,
          error: lastError,
          codeSnippet: code.slice(0, 500),
        })

        sendAndLog(win, taskId, {
          phase: 'error',
          stepIndex: i,
          stepName: stepPlan.name,
          message: `❌ Step ${i + 1}: failed even after fixes / replanning — ${lastError}`,
        })
      }

      // Update task.json with the new step
      const newStep: StepMeta = {
        id: stepId,
        order: task.steps.length + i + 1,
        file: fileName,
        description: stepPlan.description,
        type: stepType,
        status: success ? 'stable' : 'broken',
        lastSuccess: success ? new Date().toISOString() : null,
        failCount: success ? 0 : MAX_FIX_RETRIES + 1,
        aiRevisionCount: retries + 1,
        // Record which ctx.shared.xxx keys this step writes. Only meaningful
        // when the step is stable; for broken steps we still scan (cheap) so
        // that a subsequent regeneration can see what the step *would* have
        // produced if it had worked.
        producedSharedKeys: extractProducedSharedKeys(code),
      }
      task.steps.push(newStep)
      writeTask(task)
    }
  } finally {
    if (context) await context.close().catch(() => {})
    activeGenerations.delete(taskId)
    activeAbortControllers.delete(taskId)
    // Only clear the ambient signal if it's still ours — another generation
    // may have started in a different process (unlikely but defensive).
    if (getAmbientAbortSignal() === abortController.signal) {
      setAmbientAbortSignal(null)
    }
    // Restore the main window to its pre-generation bounds.
    restoreWindowBounds(win)
  }

  sendAndLog(win, taskId, {
    phase: 'done',
    message: `Done: generated ${plan.length} step${plan.length === 1 ? '' : 's'}`,
    plan,
  })
}

// ─── Active generation tracking (for cancellation) ───
const activeGenerations = new Map<string, { cancel: () => void }>()

/**
 * Per-generation AbortController. Its signal is installed as the ambient
 * signal on aiService so every chat() call aborts on cancel, and is also
 * raced against stepModule.run() so in-flight step code is interrupted.
 */
const activeAbortControllers = new Map<string, AbortController>()

/**
 * Race a long-running promise against the generation's abort signal so that
 * cancellation actually interrupts step execution rather than silently
 * running to completion in the background.
 */
function raceWithAbort<T>(taskId: string, p: Promise<T>): Promise<T> {
  const ac = activeAbortControllers.get(taskId)
  if (!ac) return p
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('GENERATION_CANCELLED'))
    if (ac.signal.aborted) {
      reject(new Error('GENERATION_CANCELLED'))
      return
    }
    ac.signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => { ac.signal.removeEventListener('abort', onAbort); resolve(v) },
      (e) => { ac.signal.removeEventListener('abort', onAbort); reject(e) }
    )
  })
}

export function registerAiAgentHandlers(): void {
  ipcMain.on(
    'ai:startAutonomousGeneration',
    (event, params: { taskId: string; instruction: string }) => {
      if (activeGenerations.has(params.taskId)) {
        console.warn(`Generation already running for task ${params.taskId}, ignoring duplicate`)
        return
      }

      const win = BrowserWindow.fromWebContents(event.sender)

      runAutonomousGeneration(win, params.taskId, params.instruction).catch(
        (err) => {
          activeGenerations.delete(params.taskId)
          // Cancellation is not an error — the cancel handler already sent
          // the ⛔ message, so we just silently clean up here.
          const msg = (err as Error).message ?? ''
          if (msg === 'GENERATION_CANCELLED') return

          sendAndLog(win, params.taskId, {
            phase: 'error',
            message: `Error: ${msg}`,
          })
        }
      )
    }
  )

  ipcMain.handle('ai:cancelGeneration', async (event, taskId: string) => {
    const loginResolver = pendingLoginResolvers.get(taskId)
    if (loginResolver) {
      pendingLoginResolvers.delete(taskId)
      loginResolver()
    }
    for (const [qId, pending] of pendingAnswerResolvers.entries()) {
      if (pending.taskId === taskId) {
        pendingAnswerResolvers.delete(qId)
        pending.resolver('')
      }
    }

    const gen = activeGenerations.get(taskId)
    if (gen) {
      activeGenerations.delete(taskId)
      gen.cancel()

      const win = BrowserWindow.fromWebContents(event.sender)
      sendAndLog(win, taskId, {
        phase: 'error',
        message: '⛔ Generation was cancelled',
      })
    }
  })

  ipcMain.handle('ai:confirmLogin', async (_event, taskId: string) => {
    const resolver = pendingLoginResolvers.get(taskId)
    if (resolver) {
      pendingLoginResolvers.delete(taskId)
      resolver()
    }
  })

  ipcMain.handle(
    'ai:answerQuestion',
    async (_event, questionId: string, answer: string) => {
      const pending = pendingAnswerResolvers.get(questionId)
      if (!pending) {
        return { ok: false, error: `questionId=${questionId} not found (already answered or timed out)` }
      }
      pendingAnswerResolvers.delete(questionId)
      pending.resolver(answer)
      return { ok: true, taskId: pending.taskId }
    }
  )

  /**
   * List currently pending questions. Used by the MCP server so Claude can
   * surface user prompts coming out of task generation / execution.
   * Returns questions across all tasks unless taskId is given.
   */
  ipcMain.handle(
    'ai:listPendingQuestions',
    async (_event, taskId?: string) => {
      const out: Array<{ id: string; taskId: string; text: string; infoKey?: string; askedAt: string }> = []
      for (const [id, pending] of pendingAnswerResolvers.entries()) {
        if (taskId && pending.taskId !== taskId) continue
        out.push({
          id,
          taskId: pending.taskId,
          text: pending.text,
          infoKey: pending.infoKey,
          askedAt: pending.askedAt,
        })
      }
      return out
    }
  )

  ipcMain.handle('ai:getGenerationLogs', async (_event, taskId: string) => {
    const db = getDb()
    return db.prepare(
      'SELECT * FROM generation_step_logs WHERE task_id = ? ORDER BY created_at ASC'
    ).all(taskId)
  })
}
