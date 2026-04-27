import { ipcMain, BrowserWindow } from 'electron'
import { v4 as uuid } from 'uuid'
import fs from 'fs'
import path from 'path'
import { getDb } from '../db'
import { getActiveProvider } from './settingsManager'
import { readTask, getTaskDir, writeTask } from './taskManager'
import { buildLanguageDirective } from './agents/buildLanguageDirective'
import type {
  AiProviderConfig,
  GenerateStepParams,
  AnalyzeFixParams,
  AiFixResult,
} from '../../shared/types'

// ─── Refactor plan types (shared with preload/renderer) ───
type RefactorModify = {
  op: 'modify'
  stepId: string
  file: string
  description: string
  stepType: 'browser' | 'desktop'
  summary: string
  originalCode: string
  newCode: string
}
type RefactorDelete = {
  op: 'delete'
  stepId: string
  file: string
  description: string
  stepType: 'browser' | 'desktop'
  summary: string
  originalCode: string
}
type RefactorAdd = {
  op: 'add'
  tempId: string
  afterStepId: string | null
  description: string
  stepType: 'browser' | 'desktop'
  summary: string
  newCode: string
}
type RefactorOperation = RefactorModify | RefactorDelete | RefactorAdd

// Dynamic imports for Vercel AI SDK (ESM modules)
async function loadGenerateText() {
  const { generateText } = await import('ai')
  return generateText
}

async function buildModel(config: AiProviderConfig) {
  switch (config.type) {
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic')
      const provider = createAnthropic({ apiKey: config.apiKey, baseURL: 'https://api.anthropic.com/v1' })
      return provider(config.model)
    }
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai')
      const provider = createOpenAI({ apiKey: config.apiKey })
      return provider.chat(config.model)
    }
    case 'google': {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google')
      const provider = createGoogleGenerativeAI({ apiKey: config.apiKey })
      return provider(config.model)
    }
    case 'openai-compatible': {
      const { createOpenAI } = await import('@ai-sdk/openai')
      const provider = createOpenAI({
        baseURL: config.baseUrl ?? 'https://api.openai.com/v1',
        apiKey: config.apiKey,
      })
      return provider.chat(config.model)
    }
    default:
      throw new Error(`Unknown provider type: ${config.type}`)
  }
}

/**
 * Ambient AbortSignal used by all in-flight `chat()` calls. Set by the
 * autonomous generation runner so that a single cancel button can abort
 * every pending LLM request (including calls made from deep inside agents
 * that don't otherwise receive a signal parameter).
 */
let ambientAbortSignal: AbortSignal | null = null

export function setAmbientAbortSignal(signal: AbortSignal | null): void {
  ambientAbortSignal = signal
}

export function getAmbientAbortSignal(): AbortSignal | null {
  return ambientAbortSignal
}

export async function chat(
  config: AiProviderConfig,
  messages: Array<{ role: string; content: unknown }>,
  opts?: { maxOutputTokens?: number },
): Promise<{ text: string; usage?: { totalTokens?: number } }> {
  const generateText = await loadGenerateText()
  const model = await buildModel(config)
  // Abort immediately if the ambient signal has already been tripped —
  // this prevents a new chat() call from being issued after cancel().
  if (ambientAbortSignal?.aborted) {
    throw new Error('GENERATION_CANCELLED')
  }
  const result = await generateText({
    model,
    messages: messages as never,
    maxOutputTokens: opts?.maxOutputTokens ?? 8192,
    ...(ambientAbortSignal ? { abortSignal: ambientAbortSignal } : {}),
  })
  return {
    text: result.text,
    usage: result.usage
      ? { totalTokens: (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0) }
      : undefined,
  }
}

/**
 * Create an AI helper function for use inside step code.
 * Uses the active provider. Simple text-in, text-out interface.
 */
export function createStepAiHelper(): (prompt: string) => Promise<string> {
  return async (prompt: string): Promise<string> => {
    const provider = getActiveProvider()
    if (!provider) throw new Error('No active AI provider configured')
    const result = await chat(provider, [{ role: 'user', content: prompt }])
    return result.text
  }
}

export async function testProvider(config: AiProviderConfig): Promise<boolean> {
  try {
    await chat(config, [{ role: 'user', content: 'ping' }])
    return true
  } catch {
    return false
  }
}

export function registerAiHandlers(): void {
  ipcMain.handle('ai:generateStep', async (_event, params: GenerateStepParams) => {
    const provider = getActiveProvider()
    if (!provider) throw new Error('No active AI provider configured')

    const messages = [
      {
        role: 'system',
        content: `You are an expert who generates Playwright TypeScript code.
Generate the step following this function signature:

\`\`\`typescript
import type { Page, BrowserContext } from 'playwright-core';
export interface StepContext {
  profile: Record<string, string>;
  input: Record<string, string>;
  shared: Record<string, unknown>;
}
export async function run(page: Page, context: BrowserContext, ctx: StepContext): Promise<void>
export const meta = { description: string, retryable: boolean, timeout: number }
\`\`\`

- Choose robust selectors (priority: aria-label > data-testid > id > class)
- Always include appropriate waitFor handling
- Output only the code (no prose)
- Include the import statements`,
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Instruction: ${params.instruction}` },
          ...(params.screenshot
            ? [{ type: 'image', image: params.screenshot, mimeType: 'image/png' }]
            : []),
          {
            type: 'text',
            text: `Page HTML (excerpt):\n${params.pageHtml.slice(0, 8000)}`,
          },
          ...(params.existingSteps.length > 0
            ? [
              {
                type: 'text',
                text: `Existing steps for reference:\n${params.existingSteps.join('\n---\n')}`,
              },
            ]
            : []),
        ],
      },
    ]

    const result = await chat(provider, messages)

    // Extract code from markdown code blocks if present
    let code = result.text
    const codeBlockMatch = code.match(/```(?:typescript|ts)?\n([\s\S]*?)```/)
    if (codeBlockMatch) {
      code = codeBlockMatch[1].trim()
    }

    // Save AI log
    const db = getDb()
    db.prepare(
      `INSERT INTO ai_logs (id, task_id, step_id, type, prompt, response, provider, model, tokens_used, status, created_at)
       VALUES (?, ?, NULL, 'generation', ?, ?, ?, ?, ?, 'approved', ?)`
    ).run(
      uuid(),
      params.taskId,
      JSON.stringify(messages),
      code,
      provider.name,
      provider.model,
      result.usage?.totalTokens ?? null,
      new Date().toISOString()
    )

    return code
  })

  ipcMain.handle('ai:analyzeAndFix', async (_event, params: AnalyzeFixParams) => {
    const provider = getActiveProvider()
    if (!provider) throw new Error('No active AI provider configured')

    const hint =
      params.stepStatus === 'flaky'
        ? 'This step fails intermittently. Likely causes: timing issues or missing waitFor.'
        : 'This step fails every time. The selectors or page structure may have changed.'

    const messages = [
      {
        role: 'system',
        content: `You debug and fix a Playwright step.
Return only the following JSON (no prose before or after):
{ "analysis": "explanation of the cause", "fixedCode": "full fixed TypeScript code", "confidence": "high|medium|low" }
${buildLanguageDirective()}`,
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `${hint}\n\nError: ${params.errorMessage}`,
          },
          { type: 'text', text: `Current code:\n${params.stepCode}` },
          ...(params.screenshotPath
            ? (() => {
              try {
                const buf = fs.readFileSync(params.screenshotPath)
                return [
                  {
                    type: 'image',
                    image: buf.toString('base64'),
                    mimeType: 'image/png',
                  },
                ]
              } catch {
                return []
              }
            })()
            : []),
          {
            type: 'text',
            text: `Failure-time HTML snippet:\n${params.htmlSnapshot.slice(0, 4000)}`,
          },
        ],
      },
    ]

    const result = await chat(provider, messages)

    let fixResult: AiFixResult
    try {
      // Try to parse JSON from the response
      const jsonMatch = result.text.match(/\{[\s\S]*\}/)
      fixResult = JSON.parse(jsonMatch?.[0] ?? result.text)
    } catch {
      fixResult = {
        analysis: 'Could not parse the AI response',
        fixedCode: params.stepCode,
        confidence: 'low',
      }
    }

    // Save AI log
    const db = getDb()
    const aiLogId = uuid()
    db.prepare(
      `INSERT INTO ai_logs (id, task_id, step_id, type, prompt, response, provider, model, tokens_used, status, created_at)
       VALUES (?, ?, ?, 'fix', ?, ?, ?, ?, ?, 'pending', ?)`
    ).run(
      aiLogId,
      params.taskId,
      params.stepId,
      JSON.stringify(messages),
      JSON.stringify(fixResult),
      provider.name,
      provider.model,
      result.usage?.totalTokens ?? null,
      new Date().toISOString()
    )

    return { ...fixResult, aiLogId }
  })

  ipcMain.handle('ai:editStep', async (_event, params: { taskId: string; stepId: string; instruction: string }) => {
    const provider = getActiveProvider()
    if (!provider) throw new Error('No active AI provider configured')

    const task = readTask(params.taskId)
    const step = task.steps.find((s) => s.id === params.stepId)
    if (!step) throw new Error(`Step not found: ${params.stepId}`)

    const stepFilePath = path.join(getTaskDir(params.taskId), step.file)
    const currentCode = fs.existsSync(stepFilePath)
      ? fs.readFileSync(stepFilePath, 'utf-8')
      : ''

    const messages = [
      {
        role: 'system',
        content: `You are an expert at editing TypeScript desktop / browser automation steps.
Follow the user's instructions and modify the current code.
Return only the following JSON (no prose before or after):
{ "editedCode": "full modified TypeScript code", "summary": "a concise description of what was changed" }
${buildLanguageDirective()}`,
      },
      {
        role: 'user',
        content: `## Change instruction\n${params.instruction}\n\n## Current code (${step.file})\n\`\`\`typescript\n${currentCode}\n\`\`\``,
      },
    ]

    const result = await chat(provider, messages)

    let editResult: { editedCode: string; summary: string }
    try {
      const jsonMatch = result.text.match(/\{[\s\S]*\}/)
      editResult = JSON.parse(jsonMatch?.[0] ?? result.text)
    } catch {
      editResult = {
        editedCode: currentCode,
        summary: 'Could not parse the AI response',
      }
    }

    const db = getDb()
    const aiLogId = uuid()
    db.prepare(
      `INSERT INTO ai_logs (id, task_id, step_id, type, prompt, response, provider, model, tokens_used, status, created_at)
       VALUES (?, ?, ?, 'edit', ?, ?, ?, ?, ?, 'pending', ?)`
    ).run(
      aiLogId,
      params.taskId,
      params.stepId,
      JSON.stringify(messages),
      JSON.stringify(editResult),
      provider.name,
      provider.model,
      result.usage?.totalTokens ?? null,
      new Date().toISOString()
    )

    return { ...editResult, aiLogId, originalCode: currentCode }
  })

  ipcMain.handle(
    'ai:refactorTask',
    async (
      event,
      params: { taskId: string; instruction: string; referenceTaskIds?: string[] }
    ) => {
      // Send progress events to the renderer for real-time feedback
      const win = BrowserWindow.fromWebContents(event.sender)
      const sendRefactorProgress = (message: string) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('ai:refactor-progress', { taskId: params.taskId, message })
        }
      }
      /**
       * Stream a partial code preview while AI is still generating.
       * The JSON envelope looks like:
       *   {"operations":[{"op":"modify","stepId":"...","newCode":"import..."
       * We extract the *latest* newCode value from the accumulated stream so the
       * user can see the code actually being built (not just char count).
       */
      const sendRefactorCodeStream = (payload: { opIndex: number; stepIdHint?: string; code: string; kind: 'newCode' | 'replace' | 'search' }) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('ai:refactor-stream', { taskId: params.taskId, ...payload })
        }
      }

      function extractLatestStreamingCode(text: string): { opIndex: number; stepIdHint?: string; code: string; kind: 'newCode' | 'replace' | 'search' } | null {
        // Find all streaming code field occurrences — newCode, or patches[].replace (or .search).
        // The last match overall is the currently-streaming field.
        const re = /"(newCode|replace|search)"\s*:\s*"/g
        let lastMatch: RegExpExecArray | null = null
        let m: RegExpExecArray | null
        let newCodeIndex = -1 // Count of newCode boundaries we've seen so far
        while ((m = re.exec(text)) !== null) {
          lastMatch = m
          if (m[1] === 'newCode') newCodeIndex++
        }
        if (!lastMatch) return null

        const kind = lastMatch[1] as 'newCode' | 'replace' | 'search'
        const start = lastMatch.index + lastMatch[0].length
        // Scan forward to find the terminating unescaped quote (or end of stream).
        let end = start
        while (end < text.length) {
          const ch = text[end]
          if (ch === '\\') { end += 2; continue }
          if (ch === '"') break
          end++
        }
        const rawBody = text.slice(start, end)
        // Lossy unescape for progressive display (JSON.parse would fail on partial input).
        const code = rawBody
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, '\t')
          .replace(/\\r/g, '')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\')

        // Count op boundaries by counting "op": occurrences before this match
        const before = text.slice(0, lastMatch.index)
        const opMatches = [...before.matchAll(/"op"\s*:\s*"(modify|add|delete)"/g)]
        const opIndex = Math.max(0, opMatches.length - 1)
        // stepId for the current op
        const stepIdMatch = [...before.matchAll(/"stepId"\s*:\s*"([^"]+)"/g)].pop()

        return { opIndex, stepIdHint: stepIdMatch?.[1], code, kind }
      }

      const provider = getActiveProvider()
      if (!provider) throw new Error('No active AI provider configured')

      sendRefactorProgress('📋 Loading task step code...')
      const task = readTask(params.taskId)
      const taskDir = getTaskDir(params.taskId)

      // Read all existing step code so the AI starts from the ACTUAL current
      // implementation, not a blank slate.
      const steps = task.steps.map((s) => {
        let code = ''
        try { code = fs.readFileSync(path.join(taskDir, s.file), 'utf-8') } catch { /* ignore */ }
        return { id: s.id, file: s.file, description: s.description, type: s.type, code }
      })

      const currentCtx = steps.map((s, i) =>
        `### Step ${i + 1} [id: ${s.id}] : ${s.description} (${s.type})\n` +
        `File: ${s.file}\n` +
        (s.code ? `\`\`\`typescript\n${s.code}\n\`\`\`` : '*(no code)*')
      ).join('\n\n')

      // Optional reference task context
      let refCtx = ''
      if (params.referenceTaskIds && params.referenceTaskIds.length > 0) {
        const refParts: string[] = []
        for (const refId of params.referenceTaskIds) {
          try {
            const refTask = readTask(refId)
            const refDir = getTaskDir(refId)
            const stepsText = refTask.steps.map((s, i) => {
              let code = ''
              try { code = fs.readFileSync(path.join(refDir, s.file), 'utf-8') } catch { /* ignore */ }
              return `#### Step ${i + 1}: ${s.description} (${s.type})\n` +
                (code ? `\`\`\`typescript\n${code}\n\`\`\`` : '*(no code)*')
            }).join('\n\n')
            refParts.push(`## Reference task "${refTask.name}"\n${stepsText}`)
          } catch { /* skip missing */ }
        }
        if (refParts.length > 0) {
          refCtx = '\n\n---\n\n' + refParts.join('\n\n---\n\n')
        }
      }

      const stepListForPrompt = task.steps.map((s, i) =>
        `  ${i + 1}. [id: ${s.id}] ${s.description} (${s.type})`
      ).join('\n')

      const messages = [
        {
          role: 'system',
          content: `You are an expert at modifying existing TypeScript automation tasks **with the minimum diff**.
What you receive is **the existing step implementation of a task that already works**. Do NOT rewrite from scratch — follow the user's modification instructions and patch only the steps that need to change.

## Absolute rules
1. **The current code is the baseline.** The step implementation you receive "already works" — full rewrites are forbidden.
2. **Do not touch steps that don't need to change** (do not include them in the output operations array). Leave fine-as-is steps alone.
3. Maintain existing function signatures, imports, variable names, logic structure, and comments unchanged unless modification is required.
4. If an in-place fix to a single step suffices, do not add or split steps.
5. Read the modification instruction carefully and decide whether you really need to add / delete / modify steps before producing operations.
6. If reference tasks are provided, use them only as pattern hints — do not overwrite the current task's code with them.

## Possible operations
- **modify**: rewrite an existing step's code (use the stepId given in the input)
- **add**: add a new step (only when truly needed)
- **delete**: delete an existing step (only when truly unnecessary)

## ★★★ Output format — JSON only (most important) ★★★
Do not output any thinking, analysis, or prose. The first character must be \`{\`.
Do not use Markdown code blocks (\`\`\`). Return only a pure JSON object.

For modify, **prefer patches when the change is small** — it saves dramatically more tokens than regenerating the full code.
Use newCode only for large rewrites that span the whole file.

{
  "rationale": "A concise summary of the overall changes (English, 3–5 lines). Describe which steps were modified / added / deleted and why.",
  "operations": [
    {
      "op": "modify",
      "stepId": "<the id of an existing step from the input>",
      "summary": "What this step changed and how (English, 1–2 sentences)",
      "patches": [
        {
          "search": "The portion of the original code to modify (with 2–3 lines of surrounding context, enough to be unique in the file)",
          "replace": "The replacement code"
        }
      ]
    },
    {
      "op": "modify",
      "stepId": "<another step id>",
      "summary": "Use newCode only when the change is too large to express with patches",
      "newCode": "Full modified TypeScript code (include imports — no omissions)"
    },
    {
      "op": "add",
      "afterStepId": "<the existing stepId after which to insert. null to add at the beginning>",
      "description": "Description of the new step (English, 1 line)",
      "stepType": "browser" or "desktop",
      "summary": "Why this is added (1–2 sentences)",
      "newCode": "The complete TypeScript code for the new step (include imports)"
    },
    {
      "op": "delete",
      "stepId": "<the id of the existing step to delete>",
      "summary": "Why this is deleted (1–2 sentences)"
    }
  ]
}

## How to use patches
- patches is an **array of search/replace** pairs. The search string must exist exactly in the original code (whitespace and newlines included)
- The search must include 2–3 lines of surrounding context so it uniquely identifies the location (too short risks matching multiple places)
- For multiple change sites, include multiple entries in the patches array
- **Adding an import**: include the existing imports at the end of search, and add the new import below them in replace
  Example: search="import { Page } from 'playwright-core';", replace="import { Page } from 'playwright-core';\\nimport { writeFile } from 'fs/promises';"
- **Adding a line**: put the existing surrounding lines in search and "existing lines + new line" in replace
- Use newCode only for changes too large to express with patches (full logic rewrite, function-structure changes, etc.)

## General rules
- The operations array contains only items that change. Empty array if nothing changes.
- Code for newly added steps (add) must be returned as full file content via newCode (patches is not valid)
- The template for newly added step code must completely follow the existing-step style (imports, export function run, export const meta).
${buildLanguageDirective()}`,
        },
        {
          role: 'user',
          content:
            `## Modification instruction\n${params.instruction.trim()}\n\n` +
            `## Current task "${task.name}"\n` +
            `Existing step list (this is the currently running implementation — do NOT touch what is fine as-is):\n${stepListForPrompt}\n\n` +
            `## Current step implementation (the baseline to patch)\n${currentCtx}` +
            refCtx +
            `\n\n★ Output only a JSON object starting with {. Do not write any thinking, analysis, or prose.`,
        },
      ]

      type RawPatch = { search: string; replace: string }
      type RawOp =
        | { op: 'modify'; stepId: string; summary?: string; newCode?: string; patches?: RawPatch[] }
        | { op: 'add'; afterStepId: string | null; description: string; stepType: 'browser' | 'desktop'; summary?: string; newCode: string }
        | { op: 'delete'; stepId: string; summary?: string }
      type RawPlan = { rationale?: string; operations?: RawOp[]; edits?: RawOp[] }

      /**
       * Robust JSON extractor — tries multiple strategies to find valid JSON
       * in AI responses that may contain markdown, thinking, or other preamble.
       */
      function extractJson(text: string): RawPlan | null {
        // Strategy 1: ```json ... ``` code block
        const codeBlock = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/)
        if (codeBlock) {
          try { return JSON.parse(codeBlock[1]) } catch { /* try next */ }
        }
        // Strategy 2: Find { ... } containing "operations" or "edits"
        const opMatch = text.match(/(\{[\s\S]*"(?:operations|edits)"[\s\S]*\})/)
        if (opMatch) {
          try { return JSON.parse(opMatch[1]) } catch { /* try next */ }
        }
        // Strategy 3: Find outermost { ... } by brace balancing
        const firstBrace = text.indexOf('{')
        if (firstBrace >= 0) {
          let depth = 0, end = -1
          for (let i = firstBrace; i < text.length; i++) {
            if (text[i] === '{') depth++
            else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break } }
          }
          if (end > firstBrace) {
            try { return JSON.parse(text.slice(firstBrace, end + 1)) } catch { /* try next */ }
          }
        }
        // Strategy 4: Raw text as-is
        try { return JSON.parse(text) } catch { return null }
      }

      // Stream the AI call so the user sees real-time progress
      const { chatStream } = await import('./agents/aiChat')
      let streamedChars = 0
      let streamedText = ''
      let lastStreamFlushAt = 0
      let lastSentCodeLen = 0
      let lastSentOpIndex = -1
      let lastSentKind: 'newCode' | 'replace' | 'search' | '' = ''

      async function chatRefactor(msgs: Array<{ role: string; content: unknown }>): Promise<{ text: string; usage?: { totalTokens?: number } }> {
        return chatStream(
          provider,
          msgs,
          (delta) => {
            streamedChars += delta.length
            streamedText += delta
            // Periodic text-only progress for the status bar
            if (streamedChars % 500 < delta.length) {
              sendRefactorProgress(`🤖 Receiving AI response... (${streamedChars.toLocaleString()} chars)`)
            }
            // Throttled code preview stream — send at most every 120ms OR when
            // the op index/field kind changes (so UI resets per op).
            const now = Date.now()
            const preview = extractLatestStreamingCode(streamedText)
            if (preview) {
              const opChanged = preview.opIndex !== lastSentOpIndex
              const kindChanged = preview.kind !== lastSentKind
              const codeGrew = preview.code.length - lastSentCodeLen > 40
              const timeElapsed = now - lastStreamFlushAt > 120
              if (opChanged || kindChanged || (codeGrew && timeElapsed)) {
                sendRefactorCodeStream(preview)
                lastStreamFlushAt = now
                lastSentCodeLen = preview.code.length
                lastSentOpIndex = preview.opIndex
                lastSentKind = preview.kind
              }
            }
          },
          { maxOutputTokens: 16384 },
        )
      }

      // First attempt
      sendRefactorProgress(`🤖 AI is analyzing ${steps.length} step${steps.length === 1 ? '' : 's'}... (instruction: ${params.instruction.slice(0, 60)})`)
      streamedChars = 0; streamedText = ''; lastStreamFlushAt = 0; lastSentCodeLen = 0; lastSentOpIndex = -1; lastSentKind = ''
      let result = await chatRefactor(messages)
      // Flush the final preview so the UI sees the last op's complete code
      const finalPreview = extractLatestStreamingCode(streamedText)
      if (finalPreview) sendRefactorCodeStream(finalPreview)
      sendRefactorProgress(`✅ AI response received (${result.usage?.totalTokens ?? '?'} tokens, ${streamedChars.toLocaleString()} chars) — parsing...`)

      let plan: RawPlan | null = extractJson(result.text)

      // Retry once if parse failed — ask AI to fix its output
      if (!plan) {
        console.error('[refactorTask] JSON parse failed on first attempt. Raw text:', result.text.slice(0, 500))
        sendRefactorProgress('⚠️ Failed to parse AI response — requesting JSON-only re-output...')
        const retryMessages = [
          ...messages,
          { role: 'assistant', content: result.text },
          { role: 'user', content: 'Your response could not be parsed as JSON. Return only a JSON object of the form { "rationale": "...", "operations": [...] } with no surrounding prose and no Markdown code blocks (```).' },
        ]
        try {
          streamedChars = 0; streamedText = ''; lastStreamFlushAt = 0; lastSentCodeLen = 0; lastSentOpIndex = -1; lastSentKind = ''
          result = await chatRefactor(retryMessages)
          sendRefactorProgress(`✅ Retry response received (${result.usage?.totalTokens ?? '?'} tokens)`)
          plan = extractJson(result.text)
        } catch (retryErr) {
          console.error('[refactorTask] Retry also failed:', (retryErr as Error).message)
        }
      }

      if (!plan) {
        console.error('[refactorTask] JSON parse failed after retry. Raw text:', result.text.slice(0, 500))
        plan = { rationale: 'Could not parse the AI response. Please try again.', operations: [] }
      }

      const cleanFence = (s: string): string => {
        const m = s.match(/```(?:typescript|ts)?\n([\s\S]*?)```/)
        return m ? m[1].trim() : s
      }

      const validStepIds = new Set(task.steps.map((s) => s.id))
      const rawOps: RawOp[] = plan.operations ?? plan.edits ?? []
      let tempCounter = 0
      // Stats for telemetry: how much token use did patches save?
      const patchStats = { patchOps: 0, fullCodeOps: 0, patchBytes: 0, fullCodeBytes: 0, originalBytes: 0, droppedBadPatch: 0 }

      // Import patch applier (already has proven whitespace-tolerant matching)
      const { applyPatches } = await import('./agents/patchCodeAgent')

      const validOperations = rawOps
        .map((o): RefactorOperation | null => {
          if (!o || typeof o !== 'object') return null
          if (o.op === 'modify' || (!('op' in o) && ('newCode' in o || 'patches' in o) && 'stepId' in o)) {
            if (typeof o.stepId !== 'string' || !validStepIds.has(o.stepId)) return null
            const before = steps.find((s) => s.id === o.stepId)
            if (!before) return null

            // Resolve newCode: prefer patches (smaller tokens), fall back to newCode
            let resolvedNewCode: string | null = null
            if ('patches' in o && Array.isArray(o.patches) && o.patches.length > 0) {
              const validPatches = o.patches.filter(
                (p): p is RawPatch =>
                  typeof p === 'object' && p !== null && typeof p.search === 'string' && typeof p.replace === 'string'
              )
              const patched = applyPatches(before.code, validPatches)
              if (patched !== null) {
                resolvedNewCode = patched
                patchStats.patchOps++
                patchStats.patchBytes += validPatches.reduce((s, p) => s + p.search.length + p.replace.length, 0)
                patchStats.originalBytes += before.code.length
              } else {
                // Patch failed to apply — AI's search strings didn't match. Fall back to newCode if present.
                patchStats.droppedBadPatch++
                sendRefactorProgress(`⚠️ Could not apply patches for stepId=${o.stepId} (search string not found in current code)`)
              }
            }
            if (resolvedNewCode === null && typeof o.newCode === 'string') {
              resolvedNewCode = cleanFence(o.newCode)
              patchStats.fullCodeOps++
              patchStats.fullCodeBytes += resolvedNewCode.length
              patchStats.originalBytes += before.code.length
            }
            if (resolvedNewCode === null) return null

            return {
              op: 'modify',
              stepId: o.stepId,
              file: before.file,
              description: before.description,
              stepType: (before.type as 'browser' | 'desktop') ?? 'browser',
              summary: typeof o.summary === 'string' ? o.summary : '',
              originalCode: before.code,
              newCode: resolvedNewCode,
            }
          }
          if (o.op === 'delete') {
            if (typeof o.stepId !== 'string' || !validStepIds.has(o.stepId)) return null
            const before = steps.find((s) => s.id === o.stepId)
            return {
              op: 'delete',
              stepId: o.stepId,
              file: before?.file ?? '',
              description: before?.description ?? '',
              stepType: (before?.type as 'browser' | 'desktop') ?? 'browser',
              summary: typeof o.summary === 'string' ? o.summary : '',
              originalCode: before?.code ?? '',
            }
          }
          if (o.op === 'add') {
            if (typeof o.newCode !== 'string') return null
            const afterId =
              o.afterStepId === null || o.afterStepId === undefined
                ? null
                : typeof o.afterStepId === 'string' && validStepIds.has(o.afterStepId)
                ? o.afterStepId
                : null
            const stepType: 'browser' | 'desktop' = o.stepType === 'desktop' ? 'desktop' : 'browser'
            return {
              op: 'add',
              tempId: `__new_${++tempCounter}`,
              afterStepId: afterId,
              description: typeof o.description === 'string' && o.description.trim() ? o.description.trim() : 'New step',
              stepType,
              summary: typeof o.summary === 'string' ? o.summary : '',
              newCode: cleanFence(o.newCode),
            }
          }
          return null
        })
        .filter((x): x is RefactorOperation => x !== null)

      // Legacy alias for log column
      const validEdits = validOperations

      const opSummary = validOperations.map(o => `${o.op}: ${o.summary || o.description || o.stepId || ''}`).join(', ')
      sendRefactorProgress(validOperations.length > 0
        ? `📝 Detected ${validOperations.length} modification operation${validOperations.length === 1 ? '' : 's'}: ${opSummary}`
        : `ℹ️ No changes: ${plan.rationale ?? 'The AI judged that the existing implementation already satisfies the instruction'}`,
      )

      // Report patch-vs-fullcode efficiency
      if (patchStats.patchOps > 0 || patchStats.fullCodeOps > 0) {
        const outputBytes = patchStats.patchBytes + patchStats.fullCodeBytes
        const savingsPct = patchStats.originalBytes > 0
          ? Math.round(100 * (1 - outputBytes / patchStats.originalBytes))
          : 0
        sendRefactorProgress(
          `📊 Output size: ${patchStats.patchOps} patch op${patchStats.patchOps === 1 ? '' : 's'} (${patchStats.patchBytes.toLocaleString()} chars) + ${patchStats.fullCodeOps} full op${patchStats.fullCodeOps === 1 ? '' : 's'} (${patchStats.fullCodeBytes.toLocaleString()} chars) ` +
          `/ original code ${patchStats.originalBytes.toLocaleString()} chars → output is ${100 - savingsPct}% of original (saved ${savingsPct}%)` +
          (patchStats.droppedBadPatch > 0 ? ` · ⚠️ ${patchStats.droppedBadPatch} patch apply failure${patchStats.droppedBadPatch === 1 ? '' : 's'}` : '')
        )
      }

      // Persist AI log
      const db = getDb()
      const aiLogId = uuid()
      db.prepare(
        `INSERT INTO ai_logs (id, task_id, step_id, type, prompt, response, provider, model, tokens_used, status, created_at)
         VALUES (?, ?, NULL, 'edit', ?, ?, ?, ?, ?, 'pending', ?)`
      ).run(
        aiLogId,
        params.taskId,
        JSON.stringify(messages),
        JSON.stringify({ rationale: plan.rationale, operations: validOperations }),
        provider.name,
        provider.model,
        result.usage?.totalTokens ?? null,
        new Date().toISOString()
      )

      return {
        aiLogId,
        rationale: plan.rationale ?? '',
        operations: validEdits,
      }
    }
  )

  ipcMain.handle('ai:suggestVariables', async (_event, params: { taskId: string; instruction?: string }) => {
    const provider = getActiveProvider()
    if (!provider) throw new Error('No active AI provider configured')

    const task = readTask(params.taskId)
    const taskDir = getTaskDir(params.taskId)

    // Collect step code snippets
    const stepSummaries = task.steps.map((s, i) => {
      let code = ''
      try { code = fs.readFileSync(path.join(taskDir, s.file), 'utf-8') } catch { /* ignore */ }
      return `### Step ${i + 1}: ${s.description} (${s.type})\n\`\`\`typescript\n${code.slice(0, 800)}\n\`\`\``
    }).join('\n\n')

    const existingKeys = task.variables.map(v => v.key).join(', ') || 'none'

    const userContent = [
      `## Task name\n${task.name}`,
      task.description ? `## Task description\n${task.description}` : '',
      stepSummaries ? `## Step implementations\n${stepSummaries}` : '',
      `## Existing parameters (do not duplicate)\n${existingKeys}`,
      params.instruction ? `## Additional instructions\n${params.instruction}` : '',
    ].filter(Boolean).join('\n\n')

    const messages = [
      {
        role: 'system',
        content: `You are a task-automation parameter-design expert.
Analyze the task and propose parameters that should be supplied at runtime from the outside.

## Suggestion rules
- Parameterize hard-coded values (URLs, search keywords, file paths, user names, etc.)
- Do not duplicate existing parameters
- Keys must be snake_case alphanumerics only (e.g. search_query, target_url)
- Do not parameterize unnecessarily (do not propose if a fixed value is fine)
- Aim for 0–5 parameters

## Output format (JSON array only)
[
  {
    "key": "search_query",
    "label": "Search keyword",
    "type": "string",
    "required": true,
    "default": ""
  }
]
type is one of "string" | "number" | "secret".
Return an empty array [] if no parameters are needed.
${buildLanguageDirective()}`,
      },
      { role: 'user', content: userContent },
    ]

    const result = await chat(provider, messages)

    let suggested: Array<{ key: string; label: string; type: string; required: boolean; default?: string }>
    try {
      const jsonMatch = result.text.match(/\[[\s\S]*\]/)
      suggested = JSON.parse(jsonMatch?.[0] ?? '[]')
    } catch {
      suggested = []
    }

    // Validate and filter
    const validTypes = new Set(['string', 'number', 'secret'])
    const existingKeysSet = new Set(task.variables.map(v => v.key))
    suggested = suggested.filter(v =>
      v.key && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(v.key) &&
      validTypes.has(v.type) &&
      !existingKeysSet.has(v.key)
    )

    return suggested
  })

  ipcMain.handle('ai:applyFix', async (_event, aiLogId: string, approved: boolean) => {
    const db = getDb()
    const status = approved ? 'approved' : 'rejected'

    db.prepare(`UPDATE ai_logs SET status = ? WHERE id = ?`).run(status, aiLogId)

    if (approved) {
      // Get the AI log to find the fix details
      const aiLog = db
        .prepare('SELECT * FROM ai_logs WHERE id = ?')
        .get(aiLogId) as Record<string, string> | undefined

      if (aiLog && aiLog.step_id && aiLog.task_id) {
        const fixResult: AiFixResult = JSON.parse(aiLog.response)
        const task = readTask(aiLog.task_id)
        const step = task.steps.find((s) => s.id === aiLog.step_id)

        if (step) {
          // Overwrite the step file with fixed code
          const stepFilePath = path.join(getTaskDir(aiLog.task_id), step.file)
          fs.writeFileSync(stepFilePath, fixResult.fixedCode)

          // Update step metadata
          step.aiRevisionCount += 1
          step.status = 'untested'
          writeTask(task)
        }
      }
    }
  })

  ipcMain.handle(
    'ai:generateDescription',
    async (_event, params: { taskId: string }) => {
      const provider = getActiveProvider()
      if (!provider) throw new Error('No active AI provider configured')

      const task = readTask(params.taskId)
      const taskDir = getTaskDir(params.taskId)

      // Collect step code snippets for context
      const stepSummaries = task.steps.map((s) => {
        let code = ''
        try {
          code = fs.readFileSync(path.join(taskDir, s.file), 'utf-8')
        } catch { /* ignore */ }
        return `### ${s.id}: ${s.description || '(no description)'}\n${code.slice(0, 500)}`
      })

      const messages = [
        {
          role: 'system',
          content: `You are an assistant for a task-automation tool.
Given the task name and the step contents, generate a concise description of the task's purpose and procedure.
Write 1–3 sentences so anyone reading can understand what the task does.
Output only the description — no preamble or quotation marks.
${buildLanguageDirective()}`,
        },
        {
          role: 'user',
          content: `Task name: ${task.name}\nStep count: ${task.steps.length}\n\n${
            stepSummaries.length > 0
              ? `Step contents:\n${stepSummaries.join('\n\n')}`
              : 'There are no steps yet. Infer from the task name only.'
          }`,
        },
      ]

      const result = await chat(provider, messages)
      return result.text.trim()
    }
  )
}
