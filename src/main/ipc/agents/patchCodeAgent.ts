// ─── Patch Code Agent ───
// Instead of regenerating entire step code, this agent returns
// minimal search/replace patches. This dramatically reduces token usage
// on retry attempts where only a few lines need to change.

import type { BrowserWindow } from 'electron'
import type { AiProviderConfig, StepPlan, VariableDefinition } from '../../../shared/types'
import { chatStream, chatNonStream } from './aiChat'
import { sendProgress, sendAndLog } from './progressHelper'
import { buildRuntimeContext } from './buildRuntimeContext'

export interface CodePatch {
  search: string
  replace: string
}

/**
 * Scan TypeScript source for **top-level** symbol declarations and return any
 * names that are declared more than once. Top-level only — declarations inside
 * `function`/block/closure are intentionally ignored because they live in
 * their own scope.
 *
 * Used to reject patches that introduce duplicate `const X` / `let X` /
 * `function X` / `class X` / `interface X` / `type X` next to an existing
 * declaration of the same name. Without this guard the AI's patches loop
 * forever in `ERROR: The symbol "X" has already been declared`.
 *
 * Cheap regex parser — not a real TS parser. False negatives (missed
 * duplicates) are fine; false positives must be avoided. We only flag
 * duplicates we're confident about, by limiting the scan to lines whose
 * indentation is 0 or 2 spaces (typical top-level / interface body).
 */
export function findDuplicateTopLevelDeclarations(code: string): string[] {
  const counts = new Map<string, number>()
  const lines = code.split('\n')
  // Match common top-level declarations. Anchor to start-of-line so we don't
  // pick up identifiers that happen to follow a keyword inside an expression.
  const declRe =
    /^\s{0,2}(?:export\s+(?:async\s+)?)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)\b/

  let depth = 0  // brace depth — only count lines at brace depth 0
  for (const rawLine of lines) {
    const line = rawLine.replace(/\/\/.*$/, '')  // strip line comment
    if (depth === 0) {
      const m = line.match(declRe)
      if (m) {
        const name = m[1]
        counts.set(name, (counts.get(name) ?? 0) + 1)
      }
    }
    // Track brace depth so we ignore declarations inside function bodies,
    // class bodies, blocks, etc. Strings/regex with literal braces would
    // confuse this; in practice generated code uses normal formatting and
    // false positives are rare.
    for (const ch of line) {
      if (ch === '{') depth++
      else if (ch === '}') depth = Math.max(0, depth - 1)
    }
  }

  const dupes: string[] = []
  for (const [name, count] of counts) {
    if (count > 1) dupes.push(name)
  }
  return dupes
}

/**
 * Apply an array of search/replace patches to code.
 * Returns the patched code, or null if any patch failed to match.
 */
export function applyPatches(code: string, patches: CodePatch[]): string | null {
  let result = code
  for (const patch of patches) {
    // Normalize whitespace for matching: trim each line but preserve structure
    const searchNormalized = patch.search.trim()
    if (!searchNormalized) continue

    // Try exact match first
    if (result.includes(searchNormalized)) {
      result = result.replace(searchNormalized, patch.replace.trim())
      continue
    }

    // Try matching with flexible whitespace (collapse multiple spaces/tabs)
    const flexSearch = searchNormalized.replace(/\s+/g, '\\s+')
    const flexRegex = new RegExp(flexSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\s\+/g, '\\s+'))
    const flexMatch = result.match(flexRegex)
    if (flexMatch) {
      result = result.replace(flexMatch[0], patch.replace.trim())
      continue
    }

    // If no match found, return null to signal patch failure
    console.warn(`[patchCodeAgent] Patch failed to match: "${searchNormalized.slice(0, 80)}..."`)
    return null
  }
  return result
}

/**
 * Parse AI response to extract patches.
 * Expected format from AI:
 * ```json
 * {"patches": [{"search": "old code", "replace": "new code"}, ...]}
 * ```
 * Or alternatively:
 * <<<SEARCH
 * old code
 * ===
 * new code
 * >>>
 */
export function parsePatches(responseText: string): CodePatch[] | null {
  // Try JSON format first
  try {
    const jsonMatch = responseText.match(/```json\s*\n?([\s\S]*?)```/)
      || responseText.match(/(\{[\s\S]*"patches"[\s\S]*\})/)
    if (jsonMatch) {
      const jsonStr = jsonMatch[1] || jsonMatch[0]
      const parsed = JSON.parse(jsonStr)
      if (parsed.patches && Array.isArray(parsed.patches)) {
        return parsed.patches.filter(
          (p: unknown): p is CodePatch =>
            typeof p === 'object' && p !== null && 'search' in p && 'replace' in p
        )
      }
    }
  } catch { /* JSON parse failed, try alternative format */ }

  // Try SEARCH/REPLACE block format
  const patches: CodePatch[] = []
  const blockRegex = /<<<SEARCH\n([\s\S]*?)\n===\n([\s\S]*?)\n>>>/g
  let match: RegExpExecArray | null
  while ((match = blockRegex.exec(responseText)) !== null) {
    patches.push({ search: match[1], replace: match[2] })
  }
  if (patches.length > 0) return patches

  // If the response is just a full code block, return null to signal "use full replacement"
  return null
}

function getPatchSystemPrompt(): string {
  return `You are an expert at fixing TypeScript code.
Analyze the cause of the error and return **only the minimum changes** as search/replace patches.
${buildRuntimeContext()}

## Output format (required)

Return JSON in the following form. Each element of the patches array is a pair of (search) and (replace): the string to find in the original code and the string to replace it with:

\`\`\`json
{
  "patches": [
    {
      "search": "The exact portion of the original code to modify (a few lines, with enough surrounding context to uniquely identify it)",
      "replace": "The replacement code"
    }
  ]
}
\`\`\`

## Important rules
- **Do not return the full code.** Return only the portions that need to change as patches
- The search string must **exist exactly** in the original code (including whitespace and newlines)
- search must be long enough to uniquely identify the change site (include 2–3 lines of surrounding context)
- If multiple sites need changes, put multiple patches in the patches array
- To add an import, use search="" (empty string) + replace="import ..."
- Do not include extra prose — return just the JSON

## ★★★ Anti-pattern: duplicate symbol declarations (do not cause this) ★★★
A recurring class of bug in patches: introducing a \`const X\` / \`let X\` / \`function X\` / \`class X\` / \`interface X\` / \`type X\` whose name **already exists** in the original code. esbuild then rejects the patched file with \`ERROR: The symbol "X" has already been declared\` and the whole patch attempt is wasted.

**Before adding any new declaration, scan the original code for that identifier.** If it already exists:
- ❌ Don't write a new \`const slots = []\` next to the existing one. esbuild will fail.
- ✅ Either (a) reuse the existing variable as-is, OR (b) make your search include the **prior** declaration of that name and have replace overwrite it.

### Anti-pattern example (causes "symbol slots has already been declared")
Original code already has:
\`\`\`
const slots: Slot[] = [];
\`\`\`
Bad patch — search is somewhere ELSE in the code, replace adds a new declaration:
\`\`\`json
{ "search": "console.log('done');", "replace": "const slots: Slot[] = await page.evaluate(...);\\nconsole.log('done');" }
\`\`\`
After applying, the file has TWO \`const slots\` → build fails.

### Correct alternatives
1. Reuse and reassign — change \`const\` to a function that fills the existing array:
\`\`\`json
{ "search": "const slots: Slot[] = [];", "replace": "const slots: Slot[] = await page.evaluate(...);" }
\`\`\`
2. If the original \`const\` truly needs to go, extend the search to include it and remove it in the replace.

The same applies to \`let\`, \`function\`, \`class\`, \`interface\`, \`type\`, \`enum\`, and top-level imports. **If you find yourself writing a new declaration, your search MUST contain (and overwrite) the previous one.**`
}

/**
 * Fix step code using minimal patches instead of full regeneration.
 * Returns the patched code, or null if patching failed (caller should fall back to full regen).
 */
export async function patchStepCode(
  config: AiProviderConfig,
  win: BrowserWindow | null,
  taskId: string,
  stepPlan: StepPlan,
  stepIndex: number,
  currentCode: string,
  errorMsg: string,
  stepType: 'browser' | 'desktop',
  selectorInfo?: string,
  strategyLedgerText?: string,
  variables?: VariableDefinition[],
  /** Pre-rendered recon site map (formatSiteMapForPrompt). Lets the patch agent
   *  see structural facts that aren't in `selectorInfo` — most notably the
   *  table samples (rows, rowspan/colspan, anchor presence, cell text). Without
   *  this, table-extraction patches end up flying blind to the actual DOM
   *  structure and just shuffle code around without fixing anything. */
  siteMapText?: string,
  /** Captured console output from the failing run. Without this the patch
   *  agent has to *guess* what the code observed; with it, the AI can see
   *  e.g. `freeAnchorCount: 14, [debug] No-match free anchor text: "〇"` and
   *  immediately deduce the regex was matched against the wrong textContent. */
  executionLogs?: string[],
): Promise<string | null> {
  sendProgress(win, {
    phase: 'fixing', agent: 'patchCode',
    stepIndex,
    stepName: stepPlan.name,
    message: `🩹 Fixing with minimal patches...`,
  })

  // Only send the relevant portion of code around the error location if code is large
  let codeToSend = currentCode
  let codePrefix = ''
  if (currentCode.length > 3000) {
    // Try to find the error location in the code
    const errorLineMatch = errorMsg.match(/line (\d+)/i)
      || errorMsg.match(/:(\d+):\d+/)
    if (errorLineMatch) {
      const errorLine = parseInt(errorLineMatch[1], 10)
      const lines = currentCode.split('\n')
      const start = Math.max(0, errorLine - 20)
      const end = Math.min(lines.length, errorLine + 20)
      codeToSend = lines.slice(start, end).join('\n')
      codePrefix = `(Note: lines ${start + 1}–${end} excerpt, near the error)\n`
    } else {
      // Send first 1500 chars + last 1500 chars
      codeToSend = currentCode.slice(0, 1500) + '\n// ... (snip) ...\n' + currentCode.slice(-1500)
      codePrefix = '(Note: code is long — showing head and tail only)\n'
    }
  }

  const variablesInfo = variables && variables.length > 0
    ? `\n\nAvailable variables: ${variables.map(v => `ctx.input.${v.key}`).join(', ')}`
    : ''

  const logsBlock = (() => {
    if (!executionLogs || executionLogs.length === 0) return ''
    let body = executionLogs.join('\n')
    const MAX = 3500
    if (body.length > MAX) {
      body = body.slice(0, MAX / 2) + `\n… [snip ${body.length - MAX} chars] …\n` + body.slice(-MAX / 2)
    }
    return `\n\n## Console output from the failing run (${executionLogs.length} line${executionLogs.length === 1 ? '' : 's'})
This is what the code itself observed and reported. Treat it as primary evidence — it tells you *which branch the code took* and *what data it actually saw*. If logs say "0 items extracted" or "regex no-match: ...", the bug is in extraction, not in the screen state.
\`\`\`
${body}
\`\`\``
  })()

  const messages = [
    { role: 'system', content: getPatchSystemPrompt() },
    {
      role: 'user',
      content: `## Error
${errorMsg}
${logsBlock}
## Current code
${codePrefix}\`\`\`typescript
${codeToSend}
\`\`\`
${selectorInfo ? `\n## Available selectors / elements\n${selectorInfo.slice(0, 2000)}` : ''}${siteMapText ? `\n\n${siteMapText.slice(0, 6000)}` : ''}${variablesInfo}${strategyLedgerText ? `\n\n${strategyLedgerText}` : ''}`,
    },
  ]

  try {
    // Log the input size for visibility
    const inputChars = codeToSend.length + errorMsg.length + (selectorInfo?.length ?? 0)
    sendAndLog(win, taskId, {
      phase: 'fixing', agent: 'patchCode',
      stepIndex,
      stepName: stepPlan.name,
      message: `🩹 Starting patch generation (input: ~${inputChars.toLocaleString()} chars, original code: ${currentCode.length.toLocaleString()} chars)`,
    })

    // Stream the AI response so the user can see tokens as they arrive
    const result = await chatStream(config, messages, (delta) => {
      sendProgress(win, {
        phase: 'fixing', agent: 'patchCode',
        stepIndex,
        stepName: stepPlan.name,
        message: '',
        streamDelta: delta,
      })
    })
    const outputChars = result.text.length

    const patches = parsePatches(result.text)

    if (!patches || patches.length === 0) {
      // AI didn't return patches — fall back to full regen
      sendAndLog(win, taskId, {
        phase: 'fixing', agent: 'patchCode',
        stepIndex,
        stepName: stepPlan.name,
        message: `⚠️ No patch format returned — falling back to full regeneration (AI output: ${outputChars.toLocaleString()} chars)`,
      }, result.text.slice(0, 500))
      return null
    }

    const patched = applyPatches(currentCode, patches)
    if (!patched) {
      sendAndLog(win, taskId, {
        phase: 'fixing', agent: 'patchCode',
        stepIndex,
        stepName: stepPlan.name,
        message: `⚠️ Patch application failed (search string not found) — falling back to full regeneration`,
      }, JSON.stringify(patches, null, 2))
      return null
    }

    // Validate the patched code has the required structure
    if (!patched.includes('export async function run')) {
      sendAndLog(win, taskId, {
        phase: 'fixing', agent: 'patchCode',
        stepIndex,
        stepName: stepPlan.name,
        message: `⚠️ Patched code is missing the run function — falling back to full regeneration`,
      })
      return null
    }

    // Reject patches that introduce duplicate top-level declarations. The AI
    // routinely appends new `const X` / `let X` next to an existing one, which
    // esbuild then rejects with "ERROR: The symbol 'X' has already been declared".
    // Rather than spend the next retry on the same mistake, surface this here
    // so the caller can fall back to full regen with an informative error.
    const dupes = findDuplicateTopLevelDeclarations(patched)
    if (dupes.length > 0) {
      sendAndLog(win, taskId, {
        phase: 'fixing', agent: 'patchCode',
        stepIndex,
        stepName: stepPlan.name,
        message: `⚠️ Patch rejected — would create duplicate top-level declaration(s): ${dupes.join(', ')}. The patch added a new \`const\`/\`let\`/\`function\` next to an existing one of the same name. Falling back to full regeneration.`,
      }, JSON.stringify({ dupes, patches }, null, 2))
      return null
    }

    // Measure efficiency: how much smaller is the patch vs full code replacement
    const patchChars = patches.reduce((sum, p) => sum + p.search.length + p.replace.length, 0)
    const savingsPct = Math.round(100 * (1 - patchChars / currentCode.length))
    sendAndLog(win, taskId, {
      phase: 'fixing', agent: 'patchCode',
      stepIndex,
      stepName: stepPlan.name,
      message: `✅ Patch fix succeeded — ${patches.length} patch${patches.length === 1 ? '' : 'es'} (${patchChars.toLocaleString()} chars) updated ${currentCode.length.toLocaleString()} chars of code (${savingsPct}% smaller output)`,
    }, JSON.stringify({
      patches,
      aiOutputChars: outputChars,
      patchChars,
      originalCodeChars: currentCode.length,
      patchedCodeChars: patched.length,
      savingsPct,
    }, null, 2))

    return patched
  } catch (err) {
    sendAndLog(win, taskId, {
      phase: 'fixing', agent: 'patchCode',
      stepIndex,
      stepName: stepPlan.name,
      message: `⚠️ Patch fix failed: ${(err as Error).message}`,
    })
    return null
  }
}

/**
 * Fix step code for the runtime runner (tryAiFix replacement).
 * Uses patch-based approach for smaller token usage.
 * Returns { patched, stats } where stats describes the efficiency of the patch.
 */
export async function patchStepCodeForRunner(
  config: AiProviderConfig,
  currentCode: string,
  errorMsg: string,
  pageUrl: string,
  selectorInfo: string,
  onDelta?: (delta: string) => void,
): Promise<{ patched: string; stats: { aiOutputChars: number; patchChars: number; originalChars: number; patchCount: number } } | null> {
  // Truncate code for prompt
  let codeToSend = currentCode
  if (currentCode.length > 4000) {
    codeToSend = currentCode.slice(0, 2000) + '\n// ... (snip) ...\n' + currentCode.slice(-2000)
  }

  const messages = [
    { role: 'system', content: getPatchSystemPrompt() },
    {
      role: 'user',
      content: `## Error
${errorMsg}

## Current code
\`\`\`typescript
${codeToSend}
\`\`\`

## Page URL
${pageUrl}

## Available selectors
${selectorInfo.slice(0, 2000)}`,
    },
  ]

  try {
    // Always stream — the callback just no-ops if not provided
    const result = await chatStream(config, messages, onDelta ?? (() => { /* silent */ }))
    const patches = parsePatches(result.text)
    if (!patches || patches.length === 0) return null

    const patched = applyPatches(currentCode, patches)
    if (!patched || !patched.includes('export async function run')) return null

    const patchChars = patches.reduce((sum, p) => sum + p.search.length + p.replace.length, 0)
    return {
      patched,
      stats: {
        aiOutputChars: result.text.length,
        patchChars,
        originalChars: currentCode.length,
        patchCount: patches.length,
      },
    }
  } catch {
    return null
  }
}
