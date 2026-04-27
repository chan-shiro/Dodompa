import { ipcMain, BrowserWindow } from 'electron'
import { v4 as uuid } from 'uuid'
import type { Page, BrowserContext } from 'playwright-core'
import fs from 'fs'
import path from 'path'
import { getDb } from '../db'
import { readTask, getTaskDir, writeTask } from './taskManager'
import { launchProfileBrowser } from './profileManager'
import { createStepAiHelper, chat as aiChat } from './aiService'
import { getActiveProvider } from './settingsManager'
import { createDesktopContext } from '../desktop/platform'
import type { TaskDefinition, StepMeta, StepContext, AiProviderConfig, DesktopContext } from '../../shared/types'
import { patchStepCodeForRunner, pruneHtmlForAi } from './agents'

const MAX_AI_FIX_RETRIES = 2

// ─── Debug sessions (kept alive after debugMode execution) ───
const activeDebugSessions = new Map<string, {
  context: BrowserContext | null
  page: Page | null
  desktopCtx: DesktopContext | null
  shared: Record<string, unknown>
  executionId: string
  taskId: string
  variables: Record<string, string>
}>()

async function buildStep(entryPoint: string, outfile: string) {
  const esbuild = await import(/* @vite-ignore */ 'esbuild')
  await esbuild.build({
    entryPoints: [entryPoint],
    bundle: false,
    format: 'esm',
    platform: 'node',
    outfile,
    target: 'node18',
  })
}

export class StepError extends Error {
  constructor(
    public stepId: string,
    public originalError: Error,
    public screenshotPath: string,
    public htmlSnapshot: string
  ) {
    super(originalError.message)
    this.name = 'StepError'
  }
}

async function compileStep(filePath: string): Promise<string> {
  const outfile = filePath.replace(/\.ts$/, '.compiled.mjs')
  await buildStep(filePath, outfile)
  return outfile
}

async function saveScreenshot(
  page: Page,
  taskDir: string,
  executionId: string,
  stepId: string,
  suffix: string
): Promise<string> {
  const screenshotDir = path.join(taskDir, 'screenshots')
  fs.mkdirSync(screenshotDir, { recursive: true })
  const filePath = path.join(
    screenshotDir,
    `${executionId}_${stepId}_${suffix}.png`
  )
  try {
    await page.screenshot({ path: filePath, fullPage: false })
  } catch {
    // Page might be in a bad state
  }
  return filePath
}

async function saveHtmlSnapshot(
  html: string,
  taskDir: string,
  executionId: string,
  stepId: string
): Promise<string> {
  const snapshotDir = path.join(taskDir, 'screenshots')
  fs.mkdirSync(snapshotDir, { recursive: true })
  const filePath = path.join(snapshotDir, `${executionId}_${stepId}_snapshot.html`)
  fs.writeFileSync(filePath, html)
  return filePath
}

function sendProgress(
  win: BrowserWindow | null,
  taskId: string,
  executionId: string,
  stepId: string,
  status: 'running' | 'success' | 'failed' | 'waitingForLogin',
  extra?: { error?: string; screenshotPath?: string; message?: string }
) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('runner:progress', {
      taskId,
      executionId,
      stepId,
      status,
      ...extra,
    })
  }
}

// ─── Login prompt for task execution ───
const pendingRunnerLoginResolvers = new Map<string, () => void>()

async function waitForRunnerLogin(
  win: BrowserWindow | null,
  taskId: string,
  executionId: string,
  context: BrowserContext,
  stepId: string,
  errorMessage: string
): Promise<Page> {
  sendProgress(win, taskId, executionId, stepId, 'waitingForLogin', {
    message: `🔐 Login required. Log in via the browser, then click "Login complete".\nError: ${errorMessage}`,
  })

  await new Promise<void>((resolve) => {
    pendingRunnerLoginResolvers.set(executionId, resolve)
  })

  // Find the correct page after login (tabs may have changed)
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
  } catch { /* */ }

  return activePage
}

/**
 * Try to fix a broken step using AI analysis.
 * Returns true if the step file was updated (caller should retry).
 */
async function tryAiFix(
  provider: AiProviderConfig,
  page: Page,
  stepFilePath: string,
  currentCode: string,
  errorMsg: string,
  stepMeta: StepMeta,
  win: BrowserWindow | null,
  executionId: string
): Promise<boolean> {
  try {
    // Capture page state for the AI
    let errorScreenshot = ''
    let errorHtml = ''
    let selectorInfo = ''
    try {
      const buf = await page.screenshot({ fullPage: false })
      errorScreenshot = buf.toString('base64')
      // Use pruned HTML instead of raw page.content() to reduce tokens
      errorHtml = await pruneHtmlForAi(page, 3000)
      // Get available selectors
      selectorInfo = await page.evaluate(() => {
        const results: string[] = []
        const els = document.querySelectorAll('a, button, input, select, textarea, [role="button"]')
        for (const el of Array.from(els).slice(0, 60)) {
          const rect = el.getBoundingClientRect()
          if (rect.height === 0) continue
          const tag = el.tagName.toLowerCase()
          const text = (el.textContent ?? '').trim().slice(0, 40)
          const name = el.getAttribute('name') ?? ''
          const id = el.id
          const placeholder = el.getAttribute('placeholder') ?? ''
          const sels: string[] = []
          if (id && !/^\d|^:r|^react-/.test(id)) sels.push(`#${id}`)
          if (name) sels.push(`${tag}[name="${name}"]`)
          if (placeholder) sels.push(`[placeholder="${placeholder}"]`)
          if (text && text.length < 30) sels.push(`text="${text}"`)
          if (sels.length) results.push(`<${tag}> ${text || name || placeholder} → ${sels.join(' | ')}`)
        }
        return results.join('\n')
      })
    } catch { /* */ }

    sendProgress(win, taskId, executionId, stepMeta.id, 'running', {
      message: `🩹 Trying AI fix with minimal patches (original code: ${currentCode.length.toLocaleString()} chars)...`,
    })

    // ── Try patch-based fix first (smaller tokens, faster) ──
    const patchResult = await patchStepCodeForRunner(
      provider, currentCode, errorMsg, page.url(), selectorInfo,
      (delta) => {
        // Stream the AI output to the runner progress channel
        if (win && !win.isDestroyed()) {
          win.webContents.send('runner:progress', {
            taskId,
            executionId,
            stepId: stepMeta.id,
            status: 'running',
            streamDelta: delta,
          })
        }
      },
    )
    if (patchResult) {
      const { patched: patchFixed, stats } = patchResult
      // Patch succeeded
      fs.writeFileSync(stepFilePath, patchFixed)
      const savingsPct = Math.round(100 * (1 - stats.patchChars / stats.originalChars))
      sendProgress(win, taskId, executionId, stepMeta.id, 'running', {
        message: `✅ Patch fix succeeded: ${stats.patchCount} patch${stats.patchCount === 1 ? '' : 'es'} (${stats.patchChars.toLocaleString()} chars) updated ${stats.originalChars.toLocaleString()} chars of code (AI output=${stats.aiOutputChars.toLocaleString()} chars, ${savingsPct}% smaller than full rewrite)`,
      })
      const db = getDb()
      db.prepare(
        `INSERT INTO ai_logs (id, task_id, step_id, type, prompt, response, provider, model, tokens_used, status, created_at)
         VALUES (?, ?, ?, 'fix', ?, ?, ?, ?, ?, 'approved', ?)`
      ).run(
        uuid(), stepMeta.id, stepMeta.id, 'fix',
        JSON.stringify({ method: 'patch', error: errorMsg, stats }),
        patchFixed.slice(0, 2000),
        provider.name, provider.model, null,
        new Date().toISOString()
      )
      return true
    }

    sendProgress(win, taskId, executionId, stepMeta.id, 'running', {
      message: `⚠️ Patch fix failed — falling back to full regeneration`,
    })

    // ── Fallback: full code regeneration ──
    const messages = [
      {
        role: 'system' as const,
        content: `You fix a Playwright step. Return the full fixed TypeScript code in a code block.
Choose the correct selector from the available-selectors list — do not use selectors that are not in the list.
Use only 'domcontentloaded' for waitForLoadState. 'networkidle' is forbidden.`,
      },
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: `Error: ${errorMsg}\n\nCurrent code:\n\`\`\`typescript\n${currentCode.length > 4000 ? currentCode.slice(0, 2000) + '\n// ...(snip)...\n' + currentCode.slice(-2000) : currentCode}\n\`\`\`\n\nPage URL: ${page.url()}\n\nAvailable selectors:\n${selectorInfo}\n\nHTML:\n${errorHtml}` },
          ...(errorScreenshot ? [{ type: 'image' as const, image: errorScreenshot, mimeType: 'image/png' as const }] : []),
        ],
      },
    ]

    const result = await aiChat(provider, messages)
    let fixedCode = result.text
    const match = fixedCode.match(/```(?:typescript|ts)?\n([\s\S]*?)```/)
    if (match) fixedCode = match[1].trim()

    if (fixedCode && fixedCode !== currentCode && fixedCode.includes('export async function run')) {
      // Log the fix
      const db = getDb()
      db.prepare(
        `INSERT INTO ai_logs (id, task_id, step_id, type, prompt, response, provider, model, tokens_used, status, created_at)
         VALUES (?, ?, ?, 'fix', ?, ?, ?, ?, ?, 'approved', ?)`
      ).run(
        uuid(), stepMeta.id, stepMeta.id, 'fix',
        JSON.stringify(messages), fixedCode,
        provider.name, provider.model, result.usage?.totalTokens ?? null,
        new Date().toISOString()
      )

      fs.writeFileSync(stepFilePath, fixedCode)
      return true
    }
  } catch (e) {
    console.error('[tryAiFix] Failed:', e)
  }
  return false
}

export function registerRunnerHandlers(): void {
  ipcMain.handle(
    'runner:execute',
    async (
      event,
      taskId: string,
      variables: Record<string, string>,
      fromStep?: string,
      toStep?: string,
      debugMode?: boolean
    ) => {
      const db = getDb()
      const task = readTask(taskId)
      const taskDir = getTaskDir(taskId)
      const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getAllWindows()[0] ?? null

      // Apply default values for variables not provided by caller
      const resolvedVariables: Record<string, string> = { ...variables }
      for (const v of task.variables) {
        if (!resolvedVariables[v.key] && v.default !== undefined && v.default !== '') {
          resolvedVariables[v.key] = v.default
        }
      }

      // Determine if task needs browser, desktop, or both
      const needsBrowser = task.steps.some(s => s.type !== 'desktop')
      const needsDesktop = task.steps.some(s => s.type === 'desktop')

      // Lazily initialized contexts
      let context: BrowserContext | null = null
      let page: Page | null = null
      let desktopCtx: DesktopContext | null = null

      // If a debug session is already running for this task, reuse its
      // browser context instead of launching a second one. Launching twice
      // against the same Chrome user-data-dir hits SingletonLock and fails.
      // `reusingDebugContext` causes the finally block to skip close().
      let reusingDebugContext = false
      const existingDebugSession = activeDebugSessions.get(taskId)

      if (needsBrowser) {
        if (existingDebugSession && existingDebugSession.context) {
          context = existingDebugSession.context
          page = existingDebugSession.page
          reusingDebugContext = true
        } else {
          const profileId = task.profileId || `_auto_${taskId}`
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
      }

      if (needsDesktop) {
        if (existingDebugSession?.desktopCtx) {
          desktopCtx = existingDebugSession.desktopCtx
        } else {
          desktopCtx = await createDesktopContext()
        }
      }

      const executionId = uuid()
      const now = new Date().toISOString()

      db.prepare(
        `INSERT INTO execution_logs (id, task_id, status, started_at, variables)
         VALUES (?, ?, 'running', ?, ?)`
      ).run(executionId, taskId, now, JSON.stringify(resolvedVariables))

      const shared: Record<string, unknown> = {}

      // Determine which steps to run
      let steps = task.steps
      if (fromStep) {
        const startIdx = steps.findIndex((s) => s.id === fromStep)
        if (startIdx >= 0) steps = steps.slice(startIdx)
      }
      if (toStep) {
        const endIdx = steps.findIndex((s) => s.id === toStep)
        if (endIdx >= 0) steps = steps.slice(0, endIdx + 1)
      }

      let failed = false
      let lastError: string | null = null

      for (const stepMeta of steps) {
        const stepLogId = uuid()
        const stepStart = new Date().toISOString()

        db.prepare(
          `INSERT INTO step_logs (id, execution_id, step_id, step_description, status, started_at)
           VALUES (?, ?, ?, ?, 'running', ?)`
        ).run(stepLogId, executionId, stepMeta.id, stepMeta.description || null, stepStart)

        sendProgress(win, taskId, executionId, stepMeta.id, 'running')

        let loginRetries = 0
        const MAX_LOGIN_RETRIES = 2
        let aiFixRetries = 0
        let stepSuccess = false

        // Retry loop: login issues → ask user; other errors → try AI fix
        while (!stepSuccess && (loginRetries <= MAX_LOGIN_RETRIES || aiFixRetries <= MAX_AI_FIX_RETRIES)) {
          try {
            const isDesktopStep = stepMeta.type === 'desktop'

            // Take before screenshot
            let screenshotBeforePath: string | null = null
            let pageUrl: string | null = null
            let pageTitle: string | null = null

            if (isDesktopStep && desktopCtx) {
              try {
                const buf = await desktopCtx.screenshot()
                const ssDir = path.join(taskDir, 'screenshots')
                if (!fs.existsSync(ssDir)) fs.mkdirSync(ssDir, { recursive: true })
                screenshotBeforePath = path.join(ssDir, `${executionId}_${stepMeta.id}_before.jpg`)
                fs.writeFileSync(screenshotBeforePath, buf)
              } catch { /* screenshot may fail */ }
            } else if (page) {
              screenshotBeforePath = await saveScreenshot(page, taskDir, executionId, stepMeta.id, 'before')
              try {
                pageUrl = page.url()
                pageTitle = await page.title()
              } catch { /* page might not be ready */ }
            }

            // Compile and run step
            const stepFilePath = path.join(taskDir, stepMeta.file)
            if (!fs.existsSync(stepFilePath)) {
              throw new Error(`Step file not found: ${stepMeta.file}`)
            }

            const compiledPath = await compileStep(stepFilePath)
            const fileUrl = new URL(`file://${compiledPath}`).href
            const stepModule = await import(/* @vite-ignore */ fileUrl + `?t=${Date.now()}`)

            const ctx: StepContext = {
              profile: {},
              input: resolvedVariables,
              shared,
              ai: createStepAiHelper(),
            }

            // Priority: StepMeta.timeoutMs (user override) > module meta.timeout > 30s default
            const timeout = stepMeta.timeoutMs ?? stepModule.meta?.timeout ?? 30000

            // Call run() with appropriate arguments based on step type
            if (isDesktopStep && desktopCtx) {
              await Promise.race([
                stepModule.run(desktopCtx, ctx),
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error(`Step timed out after ${timeout}ms`)), timeout)
                ),
              ])
            } else if (page && context) {
              await Promise.race([
                stepModule.run(page, context, ctx),
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error(`Step timed out after ${timeout}ms`)), timeout)
                ),
              ])
            } else {
              throw new Error(`No execution context available for step type: ${stepMeta.type}`)
            }

            // Clean up compiled file
            try { fs.unlinkSync(compiledPath) } catch { /* ignore */ }

            // After screenshot
            let screenshotAfterPath: string | null = null
            if (isDesktopStep && desktopCtx) {
              try {
                const buf = await desktopCtx.screenshot()
                const ssDir = path.join(taskDir, 'screenshots')
                screenshotAfterPath = path.join(ssDir, `${executionId}_${stepMeta.id}_after.jpg`)
                fs.writeFileSync(screenshotAfterPath, buf)
              } catch { /* screenshot may fail */ }
            } else if (page) {
              screenshotAfterPath = await saveScreenshot(page, taskDir, executionId, stepMeta.id, 'after')
              try {
                pageUrl = page.url()
                pageTitle = await page.title()
              } catch { /* ignore */ }
            }

            const stepEnd = new Date().toISOString()
            db.prepare(
              `UPDATE step_logs SET
                status = 'success',
                finished_at = ?,
                page_url = ?,
                page_title = ?,
                screenshot_before_path = ?,
                screenshot_path = ?,
                shared_state = ?
              WHERE id = ?`
            ).run(stepEnd, pageUrl, pageTitle, screenshotBeforePath, screenshotAfterPath, JSON.stringify(shared), stepLogId)

            updateStepStatus(task, stepMeta.id, 'stable')
            sendProgress(win, taskId, executionId, stepMeta.id, 'success')
            stepSuccess = true
          } catch (err) {
            const error = err as Error
            const errorMsg = error.message
            const isDesktopStep = stepMeta.type === 'desktop'

            // Check if this looks like a login/auth issue (browser only)
            const isLoginIssue = !isDesktopStep && page && loginRetries < MAX_LOGIN_RETRIES && (
              /login|signin|sign.in|auth|unauthorized|403|401|redirect/i.test(errorMsg) ||
              /login|signin|sign.in|accounts\.google/i.test(page.url())
            )

            if (isLoginIssue && context) {
              loginRetries++
              page = await waitForRunnerLogin(win, taskId, executionId, context, stepMeta.id, errorMsg)
              sendProgress(win, taskId, executionId, stepMeta.id, 'running', {
                message: `🔄 Retrying after login... (${loginRetries}/${MAX_LOGIN_RETRIES})`,
              })
              continue
            }

            // Not a login issue — try AI fix if provider is available and retries left
            if (aiFixRetries < MAX_AI_FIX_RETRIES) {
              const provider = getActiveProvider()
              const stepFilePath = path.join(taskDir, stepMeta.file)
              const currentCode = fs.existsSync(stepFilePath) ? fs.readFileSync(stepFilePath, 'utf-8') : ''

              let fixedByAi = false
              if (provider && currentCode && page) {
                fixedByAi = await tryAiFix(
                  provider, page, stepFilePath, currentCode, errorMsg, stepMeta, win, executionId
                )
              }

              if (fixedByAi) {
                aiFixRetries++
                sendProgress(win, taskId, executionId, stepMeta.id, 'running', {
                  message: `🔧 Retrying after AI fix... (${aiFixRetries}/${MAX_AI_FIX_RETRIES})`,
                })
                continue
              }
            }

            // AI fix failed or not available — truly fail
            failed = true
            lastError = errorMsg

            let screenshotPath: string | null = null
            let pageUrl: string | null = null
            let pageTitle: string | null = null
            let htmlSnapshotPath: string | null = null

            if (isDesktopStep && desktopCtx) {
              try {
                const buf = await desktopCtx.screenshot()
                const ssDir = path.join(taskDir, 'screenshots')
                if (!fs.existsSync(ssDir)) fs.mkdirSync(ssDir, { recursive: true })
                screenshotPath = path.join(ssDir, `${executionId}_${stepMeta.id}_error.jpg`)
                fs.writeFileSync(screenshotPath, buf)
              } catch { /* screenshot may fail */ }
            } else if (page) {
              screenshotPath = await saveScreenshot(page, taskDir, executionId, stepMeta.id, 'error')
              try {
                pageUrl = page.url()
                pageTitle = await page.title()
              } catch { /* ignore */ }
              try {
                const html = await page.content()
                htmlSnapshotPath = await saveHtmlSnapshot(html, taskDir, executionId, stepMeta.id)
              } catch { /* page might be closed */ }
            }

            const stepEnd = new Date().toISOString()
            db.prepare(
              `UPDATE step_logs SET
                status = 'failed',
                finished_at = ?,
                page_url = ?,
                page_title = ?,
                screenshot_path = ?,
                html_snapshot_path = ?,
                shared_state = ?,
                error = ?
              WHERE id = ?`
            ).run(stepEnd, pageUrl, pageTitle, screenshotPath, htmlSnapshotPath, JSON.stringify(shared), errorMsg, stepLogId)

            incrementFailCount(task, stepMeta.id)
            sendProgress(win, taskId, executionId, stepMeta.id, 'failed', { error: errorMsg, screenshotPath })
            break
          }
        }

        if (failed) break
      }

      // In debug mode, keep the context alive for re-running steps.
      // If we reused an existing debug session's context, update the session
      // entry with fresh state but keep the browser alive either way.
      if (debugMode && !failed) {
        activeDebugSessions.set(taskId, {
          context,
          page,
          desktopCtx,
          shared,
          executionId,
          taskId,
          variables: resolvedVariables,
        })
        // Don't close the context — it stays alive for rerunDebugStep
      } else if (reusingDebugContext) {
        // Don't close: the debug session owns the lifetime of this context.
        // Sync the latest page reference back to the session so subsequent
        // rerunDebugStep calls see any new page opened during this run.
        const session = activeDebugSessions.get(taskId)
        if (session) {
          session.page = page
          session.desktopCtx = desktopCtx
        }
      } else {
        if (context) await context.close().catch(() => {})
      }

      // Update execution log
      const finishedAt = new Date().toISOString()
      db.prepare(
        `UPDATE execution_logs SET status = ?, finished_at = ?, error = ? WHERE id = ?`
      ).run(failed ? 'failed' : 'success', finishedAt, lastError, executionId)

      if (failed) {
        // Clean up debug session on failure
        if (debugMode) {
          const session = activeDebugSessions.get(taskId)
          if (session) {
            if (session.context) await session.context.close().catch(() => {})
            activeDebugSessions.delete(taskId)
          }
        }
        throw new Error(lastError ?? 'Task execution failed')
      }
    }
  )

  // Login confirmation for task execution
  ipcMain.handle('runner:confirmLogin', async (_event, executionId: string) => {
    const resolver = pendingRunnerLoginResolvers.get(executionId)
    if (resolver) {
      pendingRunnerLoginResolvers.delete(executionId)
      resolver()
    }
  })

  // ─── Debug: re-run a single step using the preserved context ───
  ipcMain.handle(
    'runner:rerunDebugStep',
    async (event, taskId: string, stepId: string) => {
      const session = activeDebugSessions.get(taskId)
      if (!session) {
        throw new Error('No active debug session for this task. Start a debug run first.')
      }

      const task = readTask(taskId)
      const taskDir = getTaskDir(taskId)
      const stepMeta = task.steps.find(s => s.id === stepId)
      if (!stepMeta) {
        throw new Error(`Step not found: ${stepId}`)
      }

      const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getAllWindows()[0] ?? null
      const { context, page, desktopCtx, shared, executionId, variables: resolvedVariables } = session

      const stepLogId = uuid()
      const db = getDb()
      db.prepare(
        `INSERT INTO step_logs (id, execution_id, step_id, step_description, status, started_at)
         VALUES (?, ?, ?, ?, 'running', ?)`
      ).run(stepLogId, executionId, stepMeta.id, stepMeta.description || null, new Date().toISOString())

      sendProgress(win, taskId, executionId, stepMeta.id, 'running')

      try {
        const isDesktopStep = stepMeta.type === 'desktop'
        const stepFilePath = path.join(taskDir, stepMeta.file)
        if (!fs.existsSync(stepFilePath)) {
          throw new Error(`Step file not found: ${stepMeta.file}`)
        }

        const compiledPath = await compileStep(stepFilePath)
        const fileUrl = new URL(`file://${compiledPath}`).href
        const stepModule = await import(/* @vite-ignore */ fileUrl + `?t=${Date.now()}`)

        const ctx: StepContext = {
          profile: {},
          input: resolvedVariables,
          shared,
          ai: createStepAiHelper(),
        }

        const timeout = stepMeta.timeoutMs ?? stepModule.meta?.timeout ?? 30000

        if (isDesktopStep && desktopCtx) {
          await Promise.race([
            stepModule.run(desktopCtx, ctx),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`Step timed out after ${timeout}ms`)), timeout)
            ),
          ])
        } else if (page && context) {
          await Promise.race([
            stepModule.run(page, context, ctx),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`Step timed out after ${timeout}ms`)), timeout)
            ),
          ])
        } else {
          throw new Error(`No execution context available for step type: ${stepMeta.type}`)
        }

        try { fs.unlinkSync(compiledPath) } catch { /* ignore */ }

        const stepEnd = new Date().toISOString()
        db.prepare(
          `UPDATE step_logs SET status = 'success', finished_at = ?, shared_state = ? WHERE id = ?`
        ).run(stepEnd, JSON.stringify(shared), stepLogId)

        updateStepStatus(task, stepMeta.id, 'stable')
        sendProgress(win, taskId, executionId, stepMeta.id, 'success')
      } catch (err) {
        const errorMsg = (err as Error).message
        const stepEnd = new Date().toISOString()
        db.prepare(
          `UPDATE step_logs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?`
        ).run(stepEnd, errorMsg, stepLogId)

        incrementFailCount(task, stepMeta.id)
        sendProgress(win, taskId, executionId, stepMeta.id, 'failed', { error: errorMsg })
        throw new Error(errorMsg)
      }
    }
  )

  // ─── Debug: end session, close browser context ───
  ipcMain.handle('runner:endDebugSession', async (_event, taskId: string) => {
    const session = activeDebugSessions.get(taskId)
    if (session) {
      if (session.context) await session.context.close().catch(() => {})
      activeDebugSessions.delete(taskId)
    }
  })
}

function updateStepStatus(task: TaskDefinition, stepId: string, status: string): void {
  const step = task.steps.find((s) => s.id === stepId)
  if (step) {
    step.status = status as StepMeta['status']
    step.lastSuccess = new Date().toISOString()
    writeTask(task)
  }
}

function incrementFailCount(task: TaskDefinition, stepId: string): void {
  const step = task.steps.find((s) => s.id === stepId)
  if (step) {
    step.failCount += 1
    step.status = step.failCount >= 3 ? 'broken' : 'flaky'
    writeTask(task)
  }
}
