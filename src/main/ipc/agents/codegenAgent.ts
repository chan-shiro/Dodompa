// ─── Code Generation Agent ───
// Generates TypeScript step code from resolved actions (selectors/AX elements).
// Produces browser (Playwright) or desktop (DesktopContext) code.

import type { BrowserWindow } from 'electron'
import type { AiProviderConfig, StepPlan, VariableDefinition } from '../../../shared/types'
import type { ResolvedAction } from './selectorAgent'
import type { StepResult } from './actionPlanAgent'
import type { SiteMap } from './reconAgent'
import { formatSiteMapForPrompt } from './reconAgent'
import { chatStream } from './aiChat'
import { sendProgress, sendAndLog } from './progressHelper'
import { renderKnowledgeBlock } from '../../knowledge'

// Rule to proactively prevent **common build errors** in generated code.
// Gemini-family models tend to write triple backticks inside template literals,
// which causes "Unterminated string literal" / "Unterminated regular expression".
const TEMPLATE_LITERAL_RULE = `## ★★★ Escaping inside template literals (backticks) ★★★
Inside TypeScript template strings, **always escape backticks and \${ when you want them as literal characters.** Missing escapes cause "Unterminated string literal" or "Unterminated regular expression" build errors (especially common in Gemini-family models).

### Common pitfall: writing Markdown code fences inside a prompt string
It is tempting to write "return JSON — no Markdown code blocks" in a prompt you pass to ctx.ai(). But if you accidentally include triple backticks in that explanation, the template literal terminates early and the build fails.

### ❌ Build error example (the third backtick closes the template)
    const prompt = \`Return JSON. Do NOT include \`\`\`json. Text: \${text}\`;

### ✅ Correct option 1: describe it in prose without backticks (recommended)
    const prompt = \`Return JSON. Do not include any Markdown code blocks or extra prose.
    Text: \${text}\`;

### ✅ Correct option 2: if you really need the backtick character, concatenate via single quotes
    const fence = '\`\`\`';  // inside single quotes, backticks are literal
    const prompt = \`Return JSON. Do not include fences like \${fence}json\`;

### Basic principles
- **Do not write Markdown fence notation ( \`\`\` ) inside prompt strings.** Describing them as "Markdown code block" / "code fence" in prose is enough
- To display \${ literally inside a template string, escape it as \\\${
- Regex literals (/.../) must not contain newlines or unterminated backticks. For complex cases, use new RegExp('...')`

function buildVariablesSection(variables?: VariableDefinition[]): string {
  if (!variables || variables.length === 0) return ''
  const lines = variables.map(v =>
    `- ctx.input.${v.key}: ${v.label || v.key} (${v.type}${v.required ? ', required' : ''}${v.default ? `, default="${v.default}"` : ''})`
  ).join('\n')
  return `\n\n## Task input parameters (reference them as ctx.input.KEY)\n${lines}

### ★★★ Variable-driven task: do NOT hard-code URLs ★★★
The variables above change per run. The current default values are **only test samples**.
- Do not hard-code specific URLs discovered via recon (e.g. https://www.yoshimoto.co.jp/corporate/) in a goto
- Resolve URLs dynamically (e.g. via Google search) so the code still works when ctx.input.xxx changes
- If an earlier step stored a URL in ctx.shared, use that value
- Treat recon findings as patterns (e.g. "this type of site has the info at /corporate/")`
}

export async function generateCodeFromResolvedActions(
  config: AiProviderConfig,
  win: BrowserWindow | null,
  stepPlan: StepPlan,
  stepIndex: number,
  resolvedActions: ResolvedAction[],
  pageUrl: string,
  existingCodes: string[],
  stepType: 'browser' | 'desktop' = 'browser',
  taskId?: string,
  taskVariables?: VariableDefinition[],
  detectedAppName?: string,
  launchName?: string,
  previousStepResults?: StepResult[],
  strategyLedgerText?: string,
  siteMap?: SiteMap,
): Promise<string> {
  const actionLines = resolvedActions.map((ra, idx) => {
    const a = ra.action

    if (stepType === 'desktop') {
      // type_text with ctx.input.* → force keyboard input, don't show resolved button elements
      const isCtxInputAction = a.action === 'type_text' && a.text?.startsWith('ctx.input.')
      const candidateLine = (ra.resolvedDesktop?.candidates && ra.resolvedDesktop.candidates.length > 0)
        ? `\n  Existing candidates of the same role: ${ra.resolvedDesktop.candidates.slice(0, 8).map(c => `"${c.axTitle || c.description || '(no title)'}"`).join(', ')}${ra.resolvedDesktop.candidates.length > 8 ? ` ...and ${ra.resolvedDesktop.candidates.length - 8} more` : ''}`
        : ''
      const desktopInfo = isCtxInputAction
        ? `  ★ Keyboard input required: use desktop.type(${a.text} ?? ''). Do NOT click UI buttons one-by-one.`
        : ra.resolvedDesktop
          ? ra.resolvedDesktop.found
            ? `  Element (verified): ${ra.resolvedDesktop.axRole} "${ra.resolvedDesktop.axTitle}"${ra.resolvedDesktop.axValue ? ` value="${ra.resolvedDesktop.axValue}"` : ''}${ra.resolvedDesktop.path ? ` path=${ra.resolvedDesktop.path}` : ''}${ra.resolvedDesktop.position ? ` @ (${ra.resolvedDesktop.position.x}, ${ra.resolvedDesktop.position.y})` : ''}${ra.resolvedDesktop.pid ? ` pid=${ra.resolvedDesktop.pid}` : ''}`
            : `  Element: unresolved — findElement with axRole="${a.axRole}" axTitle="${a.axTitle ?? ''}"${a.axValue ? ` axValue="${a.axValue}"` : ''} returned nothing. ${candidateLine ? 'Pick a close match from the candidates below at runtime, or write a helper that tries multiple candidates in order.' : 'Try multiple axTitle values inside the code.'}${candidateLine}`
          : ''
      const appInfo = a.app ? `  App: ${a.app}` : ''
      const textInfo = (!isCtxInputAction && a.text) ? `  Text: ${a.text}` : ''
      const keysInfo = a.keys ? `  Keys: ${a.keys.join('+')}` : ''
      const keyInfo = a.key ? `  Key: ${a.key}` : ''
      const posInfo = (a.x !== undefined && a.y !== undefined) ? `  Coordinates: (${a.x}, ${a.y})` : ''
      const queryInfo = a.query ? `  Query: ${a.query}` : ''

      return `${idx + 1}. ${a.action}: ${a.description}\n${desktopInfo}${appInfo}${textInfo}${keysInfo}${keyInfo}${posInfo}${queryInfo}`.trim()
    }

    const selectorInfo = ra.resolvedSelector
      ? `  Selector (verified): ${ra.resolvedSelector.selector} [${ra.resolvedSelector.method}]`
      : ra.unresolved
        ? `  Selector: unresolved — locate it in code using selectorHint="${a.selectorHint}"`
        : ''
    const valueInfo = a.value ? `  Value: ${a.value}` : ''
    const urlInfo = a.url ? `  URL: ${a.url}` : ''
    const keyInfo = a.key ? `  Key: ${a.key}` : ''

    return `${idx + 1}. ${a.action}: ${a.description}\n${selectorInfo}${valueInfo}${urlInfo}${keyInfo}`.trim()
  }).join('\n\n')

  const knowledgeBlock = renderKnowledgeBlock({
    detectedApp: detectedAppName,
    stepDescription: stepPlan.description,
    platform: stepType === 'desktop' ? 'mac' : 'browser',
  })

  const systemPrompt = (stepType === 'desktop'
    ? getDesktopCodegenPrompt()
    : getBrowserCodegenPrompt()) + knowledgeBlock

  // Build cross-step context
  const prevStepCtx = previousStepResults && previousStepResults.length > 0
    ? `\n\n## Previous step results\n${previousStepResults.map((r, idx) =>
        `${idx + 1}. "${r.stepName}": ${r.success ? '✅ Success' : `❌ Failed — ${r.error ?? 'unknown'}`}`
      ).join('\n')}\n★ If an earlier step failed, the preconditions for this step (e.g. the DM screen being open) may not be satisfied. In that case, include code inside this step that restores those preconditions.`
    : ''

  const genMessages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: stepType === 'desktop'
            ? `## Step instruction\n${stepPlan.description}\n\n${detectedAppName ? `## Current target app
Display name (value of w.app): **"${detectedAppName}"**
Command-line name (for open -a): **"${launchName || detectedAppName}"**

## ★★★ Always look up the window this way ★★★
★ Never write strict English-literal comparisons like \`windows.find(w => w.app === 'Mail')\`. On Japanese locales, w.app comes back as "メール" / "計算機" / "メッセージ", etc., so matching on an English name always fails.

★ Always use this pattern:
\`\`\`typescript
const windows = await desktop.getWindows();
// 1. Preferred: match by bundleId (locale-independent)
// 2. Fallback: match the localized name "${detectedAppName}"
// 3. Last resort: partial match
const appWin = windows.find(w =>
  w.bundleId === '<bundle-id-you-know-or-guess>' ||
  w.app === '${detectedAppName}' ||
  w.app?.includes('${detectedAppName}')
);
if (!appWin) throw new Error('${detectedAppName} window not found (available apps: ' + windows.map(w => \`"\${w.app}"\`).join(',') + ')');
const pid = appWin.pid;
\`\`\`

★ Copy '${detectedAppName}' in the example above **verbatim** — do NOT rewrite it to English like 'Mail' or 'Calculator'.
★ The throw Error message must include the list from windows.map(w => w.app) so a subsequent retry can see what actually existed.

Target PID: obtain it dynamically at runtime via desktop.getWindows() (PIDs change when the app restarts — never hard-code them)

` : ''}## Verified action plan (use this element info)\n${actionLines}${buildVariablesSection(taskVariables)}${prevStepCtx}${strategyLedgerText ? `\n\n${strategyLedgerText}` : ''}`
            : `## Step instruction\n${stepPlan.description}\n\n## Verified action plan (use these selectors)\n${actionLines}\n\n## Current page URL\n${pageUrl}${stepType === 'browser' && siteMap ? `\n\n${formatSiteMapForPrompt(siteMap)}` : ''}${buildVariablesSection(taskVariables)}${prevStepCtx}${strategyLedgerText ? `\n\n${strategyLedgerText}` : ''}`,
        },
        ...(existingCodes.length > 0
          ? [{ type: 'text', text: `## Code from previous steps (for reference)\n${existingCodes.slice(-2).join('\n---\n')}` }]
          : []),
      ],
    },
  ]

  sendProgress(win, {
    phase: 'generating', agent: 'codegen',
    stepIndex,
    stepName: stepPlan.name,
    message: stepType === 'desktop'
      ? `💻 Generating code from verified element info...`
      : `💻 Generating code from verified selectors...`,
  })

  const genResult = await chatStream(config, genMessages, (delta) => {
    sendProgress(win, {
      phase: 'generating', agent: 'codegen',
      stepIndex,
      stepName: stepPlan.name,
      message: '',
      streamDelta: delta,
    })
  })

  let code = genResult.text
  const codeBlockMatch = code.match(/```(?:typescript|ts)?\n([\s\S]*?)```/)
  if (codeBlockMatch) code = codeBlockMatch[1].trim()

  // ── Post-generation validation ──
  if (stepType === 'desktop') {
    code = validateAndPatchAppNameHardcode(code, detectedAppName)
    code = validateAndPatchQuickSwitcher(code)
  }

  if (taskId) {
    sendAndLog(win, taskId, {
      phase: 'generating', agent: 'codegen',
      stepIndex,
      stepName: stepPlan.name,
      message: `✅ Code generation complete (${code.length} chars)`,
    }, code)
  }

  return code
}

// ─── Fallback code generation (no action plan) ───

export async function generateCodeFallback(
  config: AiProviderConfig,
  win: BrowserWindow | null,
  stepPlan: StepPlan,
  stepIndex: number,
  pageUrl: string,
  screenshot: string,
  selectorMap: string,
  pageHtml: string,
  existingCodes: string[],
  errorHistory: Array<{ attempt: number; error: string }>,
  stepType: 'browser' | 'desktop' = 'browser',
  taskId?: string,
  taskVariables?: VariableDefinition[],
  detectedAppName?: string,
  launchName?: string,
  previousStepResults?: StepResult[],
  strategyLedgerText?: string,
  siteMap?: SiteMap,
): Promise<string> {
  sendProgress(win, {
    phase: 'generating', agent: 'codegen',
    stepIndex,
    stepName: stepPlan.name,
    message: `💻 Generating code (fallback)...`,
  })

  const systemPrompt = stepType === 'desktop'
    ? getDesktopFallbackPrompt()
    : getBrowserFallbackPrompt()

  // Build cross-step context for fallback
  const prevStepCtxFallback = previousStepResults && previousStepResults.length > 0
    ? [{ type: 'text' as const, text: `## Previous step results\n${previousStepResults.map((r, idx) =>
        `${idx + 1}. "${r.stepName}": ${r.success ? '✅ Success' : `❌ Failed — ${r.error ?? 'unknown'}`}`
      ).join('\n')}\n★ If an earlier step failed, the preconditions may not be satisfied. Include recovery code inside this step.` }]
    : []

  const userContent = stepType === 'desktop'
    ? [
        { type: 'text', text: `## Step instruction\n${stepPlan.description}${detectedAppName ? `\n\n## Current target app\nDisplay name: "${detectedAppName}" (use this name for activateApp / waitForElement)\nCommand-line name: "${launchName || detectedAppName}" (use this name for open -a / exec)` : ''}` },
        ...(screenshot ? [{ type: 'image', image: screenshot, mimeType: 'image/png' }] : []),
        ...(selectorMap ? [{ type: 'text' as const, text: `## Available elements (accessibility tree)\n${selectorMap}` }] : []),
        ...(pageHtml ? [{ type: 'text' as const, text: `## Accessibility tree (JSON excerpt)\n${pageHtml.slice(0, 6000)}` }] : []),
        ...prevStepCtxFallback,
        ...(errorHistory.length > 0 ? [{ type: 'text', text: `## Past failures (avoid the same approach)\n${errorHistory.map(h => `Attempt ${h.attempt}: ${h.error}`).join('\n\n')}` }] : []),
        ...(strategyLedgerText ? [{ type: 'text' as const, text: strategyLedgerText }] : []),
        ...(existingCodes.length > 0 ? [{ type: 'text', text: `## Code from previous steps (for reference)\n${existingCodes.slice(-2).join('\n---\n')}` }] : []),
        ...(taskVariables?.length ? [{ type: 'text' as const, text: `## Task input parameters (reference as ctx.input.KEY)${buildVariablesSection(taskVariables)}` }] : []),
      ]
    : [
        { type: 'text', text: `## Step instruction\n${stepPlan.description}` },
        ...(screenshot ? [{ type: 'image', image: screenshot, mimeType: 'image/png' }] : []),
        ...(selectorMap ? [{ type: 'text' as const, text: `## Available selectors (verified)\n${selectorMap}` }] : []),
        ...(siteMap ? [{ type: 'text' as const, text: formatSiteMapForPrompt(siteMap) }] : []),
        { type: 'text', text: `## Current page URL\n${pageUrl}\n\n## Page HTML (excerpt)\n${pageHtml.slice(0, 6000)}` },
        ...prevStepCtxFallback,
        ...(errorHistory.length > 0 ? [{ type: 'text', text: `## Past failures (avoid the same approach)\n${errorHistory.map(h => `Attempt ${h.attempt}: ${h.error}`).join('\n\n')}` }] : []),
        ...(strategyLedgerText ? [{ type: 'text' as const, text: strategyLedgerText }] : []),
        ...(existingCodes.length > 0 ? [{ type: 'text', text: `## Code from previous steps (for reference)\n${existingCodes.slice(-2).join('\n---\n')}` }] : []),
        ...(taskVariables?.length ? [{ type: 'text' as const, text: `## Task input parameters (reference as ctx.input.KEY)${buildVariablesSection(taskVariables)}` }] : []),
      ]

  const fallbackResult = await chatStream(config, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ], (delta) => {
    sendProgress(win, {
      phase: 'generating', agent: 'codegen',
      stepIndex,
      stepName: stepPlan.name,
      message: '',
      streamDelta: delta,
    })
  })

  let code = fallbackResult.text
  console.log(`[codegenAgent] Fallback AI response length: ${code.length}, first 200 chars: ${code.slice(0, 200)}`)
  sendProgress(win, {
    phase: 'generating', agent: 'codegen',
    stepIndex,
    stepName: stepPlan.name,
    message: `📝 AI response: ${code.length} chars${code.length === 0 ? ' (empty!)' : ''}`,
  })
  const codeBlockMatchFb = code.match(/```(?:typescript|ts)?\n([\s\S]*?)```/)
  if (codeBlockMatchFb) code = codeBlockMatchFb[1].trim()

  // ── Post-generation validation ──
  if (stepType === 'desktop') {
    code = validateAndPatchAppNameHardcode(code, detectedAppName)
    code = validateAndPatchQuickSwitcher(code)
  }

  if (taskId) {
    sendAndLog(win, taskId, {
      phase: 'generating', agent: 'codegen',
      stepIndex,
      stepName: stepPlan.name,
      message: `✅ Code generation complete — fallback (${code.length} chars)`,
    }, code)
  }

  return code
}

// ─── Post-generation code validation & patching ───

/**
 * Validates Quick Switcher (Cmd+K) code includes multi-query + AX verification.
 * If simple pattern detected (no getAccessibilityTree check), replaces the entire
 * hotkey→type→Return block with the robust template.
 */
/**
 * Post-codegen safety net: auto-rewrite `w.app === 'Mail'` style hardcoded
 * English app names to use bundleId + Japanese name fallbacks. The AI tends
 * to regenerate the same English-literal comparison despite prompt warnings,
 * so we patch the code before writing it to disk.
 */
export function validateAndPatchAppNameHardcode(code: string, detectedAppName?: string): string {
  const englishToJa: Record<string, { ja: string; bundleId: string }> = {
    'Mail':              { ja: 'メール',           bundleId: 'com.apple.mail' },
    'Calculator':        { ja: '計算機',           bundleId: 'com.apple.calculator' },
    'Calendar':          { ja: 'カレンダー',       bundleId: 'com.apple.iCal' },
    'Messages':          { ja: 'メッセージ',       bundleId: 'com.apple.MobileSMS' },
    'Reminders':         { ja: 'リマインダー',     bundleId: 'com.apple.reminders' },
    'Notes':             { ja: 'メモ',             bundleId: 'com.apple.Notes' },
    'Contacts':          { ja: '連絡先',           bundleId: 'com.apple.AddressBook' },
    'Terminal':          { ja: 'ターミナル',       bundleId: 'com.apple.Terminal' },
    'System Settings':   { ja: 'システム設定',     bundleId: 'com.apple.systempreferences' },
    'System Preferences': { ja: 'システム環境設定', bundleId: 'com.apple.systempreferences' },
    'Photos':            { ja: '写真',             bundleId: 'com.apple.Photos' },
    'Maps':              { ja: 'マップ',           bundleId: 'com.apple.Maps' },
    'Weather':           { ja: '天気',             bundleId: 'com.apple.weather' },
    'Clock':             { ja: '時計',             bundleId: 'com.apple.clock' },
    'Music':             { ja: 'ミュージック',     bundleId: 'com.apple.Music' },
    'TV':                { ja: 'TV',               bundleId: 'com.apple.TV' },
    'Books':             { ja: 'ブック',           bundleId: 'com.apple.iBooksX' },
  }

  let patched = code
  let anyPatched = false

  for (const [english, info] of Object.entries(englishToJa)) {
    // Match `w.app === 'Mail'` / `w.app === "Mail"` / `w.app == 'Mail'`
    const strictRe = new RegExp(`(w\\.app\\s*===?\\s*)(['"])${english}\\2`, 'g')
    if (strictRe.test(patched)) {
      patched = patched.replace(strictRe, (_m, lhs: string) =>
        `(w.bundleId === '${info.bundleId}' || w.app === '${info.ja}' || ${lhs.trim().replace(/===?$/, '').trim()} === '${english}' || w.app?.includes('${info.ja}'))`
      )
      anyPatched = true
    }

    // Match `windows.find(w => w.app === 'Mail')` (covered by above) and
    // also `w.app?.includes('Mail')` → extend to include the JA name too
    const includesRe = new RegExp(`(w\\.app\\??\\.includes\\()(['"])${english}\\2\\)`, 'g')
    if (includesRe.test(patched)) {
      patched = patched.replace(includesRe, (_m, lhs: string, q: string) =>
        `(${lhs}${q}${english}${q}) || w.app?.includes('${info.ja}') || w.bundleId === '${info.bundleId}')`
      )
      anyPatched = true
    }
  }

  // If we detected a Japanese app name from analysis, and the code contains
  // an English literal that matches the same app, also inject the detected name.
  if (detectedAppName && anyPatched) {
    console.log(`[codegenAgent] 🩹 Patched hardcoded English app name(s); detected="${detectedAppName}"`)
  }

  return patched
}

function validateAndPatchQuickSwitcher(code: string): string {
  // Detect Quick Switcher pattern: hotkey('command', 'k')
  const hasQuickSwitcher = /hotkey\s*\(\s*['"]command['"]\s*,\s*['"]k['"]\s*\)/.test(code)
  if (!hasQuickSwitcher) return code

  // Already has robust pattern?
  const hasAXVerification = /getAccessibilityTree[\s\S]*?findElement/.test(code)
  const hasRetryLoop = /searchQueries|for\s*\(\s*const\s+query\s+of/.test(code)
  if (hasAXVerification || hasRetryLoop) return code

  console.log('[codegenAgent] ⚠️ Quick Switcher without AX verification — replacing with robust template')

  // Strategy: find the run() function body and replace everything from the hotkey call
  // to the last pressKey('Return') with the robust template.
  // We keep the preamble (imports, type defs, window lookup, ai resolve) and the postamble (meta).

  // Line-based approach: find the hotkey line and the last pressKey('Return') line
  const lines = code.split('\n')
  let hotkeyLineIdx = -1
  let lastReturnLineIdx = -1

  for (let i = 0; i < lines.length; i++) {
    if (/hotkey\s*\(\s*['"]command['"]\s*,\s*['"]k['"]/.test(lines[i])) {
      hotkeyLineIdx = i
    }
    if (hotkeyLineIdx >= 0 && /pressKey\s*\(\s*['"]Return['"]/.test(lines[i])) {
      lastReturnLineIdx = i
    }
  }

  if (hotkeyLineIdx === -1 || lastReturnLineIdx === -1) return code

  // Include trailing wait/setTimeout lines after the Return
  let endLineIdx = lastReturnLineIdx
  for (let i = lastReturnLineIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (trimmed === '' || /^await\s+new\s+Promise/.test(trimmed) || /^\/\//.test(trimmed) || /^console\./.test(trimmed)) {
      endLineIdx = i
    } else {
      break
    }
  }

  const beforeBlock = lines.slice(0, hotkeyLineIdx).join('\n') + '\n'
  const afterBlock = '\n' + lines.slice(endLineIdx + 1).join('\n')

  // Detect the PID variable name used in the code (pid, mailPid, calcPid, etc.).
  // Never default to an app-specific literal — if no pid variable exists,
  // emit a throw that asks the code to resolve pid itself.
  const pidVarMatch = beforeBlock.match(/const\s+(\w*[pP]id\w*)\s*=\s*\w+\.pid/)
    ?? beforeBlock.match(/const\s+(pid)\s*=/)
  const pidVar = pidVarMatch ? pidVarMatch[1] : 'pid'

  // Detect if app name is Slack or something else
  // Detect the app name the AI chose (may be 'Slack', 'Discord', any string).
  // Do NOT default to any specific app — an empty string triggers pid-based
  // lookup below, which is locale-agnostic.
  const appNameMatch = beforeBlock.match(/w\.app\s*===\s*['"]([\w\u3040-\u30ff\u3400-\u9fff ]+)['"]/)
  const detectedApp = appNameMatch?.[1] ?? ''

  // Build a pid-based post-switch window lookup that is app-agnostic. We use
  // the `pid` variable (which was already set by the beforeBlock code) to find
  // the window in the updated list — this avoids re-searching by app name and
  // therefore dodges any locale / name mismatch.
  const robustBlock = `// ── Robust Quick Switcher: multi-query + title verification (app-agnostic) ──
  const rawRecipientQS = ctx.input.recipient ?? '';
  // APP_NAME is used only for the ai_resolve prompt wording; it may be empty.
  const APP_NAME_QS = '${detectedApp.replace(/'/g, "\\'")}' || 'the target app';
  const searchQueries: string[] = [];
  if (rawRecipientQS.startsWith('@') || rawRecipientQS.includes('#')) {
    searchQueries.push(rawRecipientQS);
  } else {
    const resolvedQueries = await ctx.ai(
      \`I want to search for a person or channel named "\${rawRecipientQS}" in \${APP_NAME_QS}.\` +
      \`Return 3 candidate strings to type into the search / quick switcher in \${APP_NAME_QS}.\` +
      \`- For Japanese names, also consider romaji (e.g. 福田 → fukuda, Fukuda).\` +
      \`- Include variations like full name, surname only, romaji, etc.\` +
      \`- One candidate per line, no extra prose, no numbering.\`
    );
    searchQueries.push(...resolvedQueries.trim().split('\\n').map((s: string) => s.trim()).filter(Boolean));
    if (!searchQueries.includes(rawRecipientQS)) searchQueries.push(rawRecipientQS);
  }

  // First, close any search screens or modals and return to home (Esc x3)
  for (let i = 0; i < 3; i++) {
    await desktop.pressKey('Escape');
    await new Promise(r => setTimeout(r, 300));
  }
  await new Promise(r => setTimeout(r, 500));

  let dmOpened = false;
  for (const query of searchQueries) {
    await desktop.hotkey('command', 'k');
    await new Promise(r => setTimeout(r, 800));
    await desktop.hotkey('command', 'a');
    await new Promise(r => setTimeout(r, 100));
    await desktop.type(query);
    await new Promise(r => setTimeout(r, 1500));

    await desktop.pressKey('Return');
    await new Promise(r => setTimeout(r, 2000));

    // Verify DM transition via window-title change (pid-based, app-agnostic)
    const updatedWindows = await desktop.getWindows();
    const updatedWin = updatedWindows.find(w => w.pid === pid);
    const newTitle = updatedWin?.title ?? '';
    if (!newTitle.includes('検索') && !newTitle.includes('Search')) {
      dmOpened = true;
      ctx.shared.resolvedRecipient = query;
      break;
    }
    await desktop.pressKey('Escape');
    await new Promise(r => setTimeout(r, 500));
  }
  if (!dmOpened) {
    throw new Error(\`Recipient "\${rawRecipientQS}" not found in \${APP_NAME_QS}. Tried: \${searchQueries.join(', ')}\`);
  }
`

  return beforeBlock + robustBlock + afterBlock
}

// ─── Prompt templates (kept compact — full versions in the original aiAgent.ts) ───

function getDesktopCodegenPrompt(): string {
  return `You are an expert who generates TypeScript code for macOS desktop automation.

## ★★★ Target platform: macOS only ★★★
The code you generate is **macOS only**. Never write code for Windows / Linux / WSL:
- Do not branch on OS via \`process.platform\` (always assume macOS)
- Do not use Windows commands: cmd.exe / PowerShell / wsl / start / explorer.exe / taskkill, etc.
- Do not emit Windows shortcuts: Win key, Win+R, Ctrl+Esc, Alt+Tab (Windows version), etc.
- Use only macOS APIs (desktop.*, osascript, open -a, hotkey Cmd+X)

## ★★★ Verbatim value preservation (URL / ID / person / number) ★★★
Any URL / email / file path / proper noun / number / date the user specifies in the step description or ctx.input must be used **verbatim** in the code. The following are **strictly forbidden**:

- ❌ Writing \`const url = 'https://en.wikipedia.org/wiki/MacOS'\` from a description like 'the macOS page on Wikipedia' (hallucinated URL)
- ❌ Writing \`const url = '...'\` with a different value when ctx.input.target_url exists
- ❌ Overwriting ctx.input.email with a fake value like \`const to = 'user@example.com'\`
- ❌ Hard-coding a date like 'tomorrow at 10:00' as an old date like \`'2024-01-15 10:00'\`

**Rules**:
1. Write code assuming \`ctx.input.XXX\` holds the value. If a fallback is needed, use the exact value in the step description
2. If the description is abstract (e.g. 'the yyy page of xxx') and no exact value can be found, **do NOT hallucinate — throw** ('URL is not specified')
3. **Do not put concrete URL / ID / name values directly in code.** Always receive them via ctx.input or by quoting from the step description

### Correct example
\`\`\`typescript
const url = ctx.input.target_url ?? '';
if (!url) throw new Error('target_url is not specified in ctx.input');
await exec('osascript', ['-e', \`tell application "Safari" to open location "\${url}"\`]);
\`\`\`

### Wrong example
\`\`\`typescript
const url = 'https://en.wikipedia.org/wiki/MacOS'; // ❌ hard-coded (wrong URL inferred)
\`\`\`

## ★★★ post-condition is a declaration for verifyAgent, NOT for step code to verify ★★★
The \`post-condition: ~\` at the end of a step description is a **declarative statement that a separate verifyAgent uses for pass/fail**. You do not need to verify it yourself inside the step code.

### ❌ Anti-patterns you must never write
- **O(N) full-scan AppleScript**: confirming the post-condition with a full loop like \`repeat with lst in lists\` + \`repeat with rem in reminders of lst\`. For users with many reminders / notes / events, this takes 30+ seconds and times out
- **Re-fetch the created ID just to confirm existence**: the return value of \`make new reminder\` gives you the ID — store it in ctx.shared and finish
- **fs.existsSync + throw after creating a file**: verifyAgent has a mechanism to extract the file path from the post-condition and check it
- **Re-checking element existence with querySelectorAll in the browser**: do not pile on read operations after the side effect runs

### ✅ Correct pattern
The step code should only **execute the side effect** and stop. Store return values (ID, URL, extracted text, etc.) in ctx.shared and leave verification to verifyAgent.

\`\`\`typescript
// ❌ Bad: verifying existence manually (cause of timeouts)
const verifyScript = \`tell application "Reminders"
  set cnt to 0
  repeat with lst in lists
    repeat with rem in reminders of lst
      if name of rem is "\${name}" then set cnt to cnt + 1
    end repeat
  end repeat
  return cnt
end tell\`;
const { stdout } = await exec('osascript', ['-e', verifyScript]); // ← heavy full scan

// ✅ Good: use the return value of make new and finish
const script = \`tell application "Reminders" to id of (make new reminder with properties {name:"\${name}"})\`;
const { stdout } = await exec('osascript', ['-e', script]);
const reminderId = stdout.trim();
if (!reminderId) throw new Error('Failed to obtain reminder ID');
ctx.shared.createdReminderId = reminderId;
// ← Done. verifyAgent confirms the post-condition (a reminder exists in Reminders)
\`\`\`

**Decision criterion**: AppleScript full-scan patterns like \`repeat\` + \`reminders of lst\` / \`notes of folder\` / \`events of calendar\` are strictly forbidden. Use a \`whose name is "..."\` filter or the ID returned at creation time.

## ★★★ Absolute rule for text input: Japanese / non-ASCII must use clipboard paste ★★★
\`desktop.type(...)\` works only for **ASCII letters, digits, symbols, and newlines**. Never use \`desktop.type()\` for:
- Strings containing Japanese (hiragana / katakana / kanji)
- Emoji
- Chinese / Korean / other non-ASCII languages
- Any string that requires an IME

**Rationale**: the Japanese IME turns type events into composition candidates, producing the wrong string. Since user-input values often include Japanese, use clipboard paste by default.

### Recommended helper (bulletproof Japanese text input)
\`\`\`typescript
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
const exec = promisify(execFile);

/**
 * Put text on the clipboard and paste via Cmd+V.
 * Piping through a temp file avoids shell-quoting escapes and
 * the spawn-stdin quirks of the Electron environment (most robust).
 */
async function pasteText(desktop: DesktopContext, text: string): Promise<void> {
  const tmpFile = join(tmpdir(), \`dodompa-clip-\${Date.now()}-\${Math.random().toString(36).slice(2,8)}.txt\`);
  writeFileSync(tmpFile, text, 'utf8');
  try {
    await exec('sh', ['-c', \`pbcopy < "\${tmpFile}"\`]);
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
  await new Promise(r => setTimeout(r, 100));
  await desktop.hotkey('command', 'v');
  await new Promise(r => setTimeout(r, 300));
}

// Usage:
await desktop.activateApp(pid);
await pasteText(desktop, 'Includes Japanese: これは日本語を含むテスト\\nMultiline is OK');
\`\`\`

★ **Do not write \`spawn('pbcopy')\` + \`p.stdin.write()\`**. In Electron's main process, spawn's stdin is a known-undefined pattern. Always use the temp-file pattern above.

### When desktop.type() is OK (ASCII only)
- ASCII file paths: \`/Users/shiro/Desktop/file.txt\`
- URL: \`https://example.com\`
- Commands: \`echo hello\`, numbers: \`12345\`
- Shortcuts: \`desktop.hotkey('command', 'a')\`

## ★★★ Robust file Save-dialog pattern: specify absolute path via Cmd+Shift+G ★★★
Using \`Cmd+D\` to jump to 'Desktop' is unstable — behavior depends on macOS version, app, and locale. Use **Cmd+Shift+G (Go to Folder)** with an absolute path — the macOS-standard robust pattern:

\`\`\`typescript
// Open the Save dialog with Cmd+S
await desktop.hotkey('command', 's');
await new Promise(r => setTimeout(r, 1500));

// Open the Go-to-folder sub-dialog with Cmd+Shift+G
await desktop.hotkey('command', 'shift', 'g');
await new Promise(r => setTimeout(r, 500));

// Paste the absolute directory path and press Return
await pasteText(desktop, '/Users/' + process.env.USER + '/Desktop');
await desktop.pressKey('Return');
await new Promise(r => setTimeout(r, 500));

// The filename field has focus — select all and replace-paste
await desktop.hotkey('command', 'a');
await new Promise(r => setTimeout(r, 100));
await pasteText(desktop, 'textedit-test.txt');
await desktop.pressKey('Return');
await new Promise(r => setTimeout(r, 1000));
\`\`\`

Note: TextEdit defaults to saving as .rtf. Make the \`.txt\` extension explicit in the filename. If a format-selection dialog appears, an extra Return to confirm may be required.

## ★★★ Post-action verification is mandatory for tasks with filesystem side effects ★★★
Tasks whose **result appears as a file / directory** ('save file', 'create folder', 'resize images', etc.) must **verify existence at the end**. verifyAgent's visual comparison tends to mis-judge 'the save dialog has closed' as success, so you must confirm on the code side:

\`\`\`typescript
// After the save operation:
await new Promise(r => setTimeout(r, 1000)); // wait for the file write to complete
const expectedPath = \`/Users/\${process.env.USER}/Desktop/textedit-test.txt\`;
try {
  await exec('test', ['-f', expectedPath]);
  console.log('✅ File save confirmed: ' + expectedPath);
  ctx.shared.savedPath = expectedPath;
} catch {
  throw new Error(\`Save failed: \${expectedPath} does not exist\`);
}
\`\`\`

## ★★★ Shell-only tasks: run execFile directly, NOT through the UI ★★★
If the task is about files / directories / text / CSV / JSON / network / system info, use child_process.execFile directly. Opening Terminal.app → click → type → Return is **forbidden**.
Reasons: UI routes are slow, lose keys to focus changes, time out, and escaping is a nightmare.

### Correct example (list files)
\`\`\`typescript
import { execFile } from 'child_process';
import { promisify } from 'util';
const exec = promisify(execFile);

const { stdout } = await exec('sh', ['-c',
  "find ~/Desktop/test-source -maxdepth 1 -type f -exec stat -f '%N|%z|%Sm' {} +"
]);
const rows = stdout.trim().split('\\n').filter(Boolean).map(line => {
  const [name, size, modified] = line.split('|');
  return { name, size: Number(size), modified };
});
ctx.shared.fileList = rows;
\`\`\`

### Correct example (take a screenshot)
\`\`\`typescript
import { execFile } from 'child_process';
import { promisify } from 'util';
import { homedir } from 'os';
const exec = promisify(execFile);

// Use the screencapture CLI directly with an output path. No defaults changes or SystemUIServer restarts required.
// -x: no sound, -t png: PNG format
const outPath = \`\${homedir()}/Desktop/screenshots/2026-04-09/01.png\`;
await exec('mkdir', ['-p', outPath.replace(/\\/[^/]+$/, '')]);
await exec('screencapture', ['-x', '-t', 'png', outPath]);
// Verify (optional, but useful for debugging failures)
await exec('test', ['-f', outPath]); // throws if missing
ctx.shared.lastScreenshotPath = outPath;
\`\`\`
★ **Never** take this path: \`defaults write com.apple.screencapture location\` → \`killall SystemUIServer\` → \`hotkey Cmd+Shift+3\`. Just call the screencapture CLI directly.

### Other frequently used CLIs (always via execFile)
- Clipboard: \`pbcopy\` / \`pbpaste\`
- Open URL: \`open <url>\` / \`open -a "AppName"\`
- File info: \`stat -f '%N|%z|%Sm' file\`
- Create directory: \`mkdir -p <path>\`
- Bulk rename: \`for f in *.png; do mv "$f" "$(date +%Y)_$f"; done\` (via sh -c)
- Date: \`date +"%Y-%m-%d"\` or Node's \`new Date().toISOString()\`
- Image resize: \`sips -Z 800 <file>\`
- Notifications (non-blocking): \`osascript -e 'display notification "..." with title "..."'\`

### Wrong example (never write this)
\`\`\`typescript
await desktop.activateApp('Terminal');     // ❌ unnecessary
await desktop.click(x, y);                  // ❌ unnecessary
await desktop.type('find ~/Desktop...');    // ❌ unnecessary
await desktop.pressKey('Return');           // ❌ unnecessary
\`\`\`

Decision criterion: 'Can I type this command in a terminal and have it work?' → If yes, write it with execFile. Do not touch the UI.
Decision criterion: 'Is this a file / text / JSON / CSV / HTTP operation?' → If yes, use the shell directly or Node's fs/fetch.

## ★★★ Modal-dialog APIs forbidden ★★★
The following are **human-facing interactive modals**, and must **never** be used in automation code.
Calling them blocks indefinitely until a button is pressed, stalling everything until timeout; each retry also piles on more dialogs that interfere with app operation:
- \`display dialog ...\` (AppleScript)
- \`display alert ...\` (AppleScript)
- Interactive pickers: \`choose from list\`, \`choose file\`, \`choose folder\`, etc.
- Anything that waits on stdin/GUI: Tk / wxPython / zenity / Node readline / prompt(), etc.

**What to do with information you obtain**:
- To debug-print → use \`console.log(...)\` (stdout is captured by Dodompa)
- To pass to the next step → store it in \`ctx.shared.xxx = value\`
- To show the user → \`return\` it, or put it in \`ctx.shared.result\`. UI display is the step-execution engine's responsibility
- If nothing needs to be displayed, do not write anything. (Even for a step like 'display the selected email', you do NOT need to pop up a modal — the next step reads ctx.shared)
- \`display notification\` does not block, so it is allowed, but think carefully about whether you need it


## Output format
\`\`\`typescript
import type { DesktopContext } from '../../shared/types';
export interface StepContext { profile: Record<string, string>; input: Record<string, string>; shared: Record<string, unknown>; ai: (prompt: string) => Promise<string>; }
export async function run(desktop: DesktopContext, ctx: StepContext): Promise<void> { /* ... */ }
export const meta = { description: string, retryable: boolean, timeout: number }
\`\`\`

## Available Desktop API
- desktop.getWindows(): Promise<WindowInfo[]>
- desktop.getAccessibilityTree(appOrPid: string | number): Promise<AXNode>
- desktop.getWindowTree(appOrPid, opts?: { title?: string; index?: number }): Promise<AXNode | null>  ← narrow to a specific window
- desktop.getFocusedWindowTree(appOrPid): Promise<AXNode | null>  ← the currently focused window
- desktop.getSubtree(appOrPid, opts: { path?: string; query?: { role?, title? } }): Promise<AXNode | null>  ← ★ progressive drill-down
- desktop.findElement(tree: AXNode, query: { role?: string; title?: string }): AXNode | null
- desktop.findElements(tree: AXNode, query: { role?: string; title?: string }): AXNode[]
- desktop.click(x: number, y: number): Promise<void>
- desktop.type(text: string): Promise<void>
- desktop.hotkey(...keys: string[]): Promise<void>
- desktop.pressKey(key: string): Promise<void>
- desktop.activateApp(appNameOrPid: string | number): Promise<void>
- desktop.waitForElement(appOrPid: string | number, query: { role?: string; title?: string }, timeout?: number): Promise<AXNode>
- desktop.performAction(pid: number, path: string, action: string): Promise<void>
- desktop.screenshot(): Promise<Buffer>

### ★ Progressive drill-down (when the target element does not appear in the AX-tree dump)
If the AX-tree dump contains a line like \`… (N more interactive descendants pruned, call desktop.getSubtree() to drill deeper)\`, or the target element is not visible:
1. **Pick up the parent container's path from the dump**: reference the path (e.g. "0.0.2.1") that appears just before \`→ axRole="AXToolbar" axTitle="..."\`
2. **Call \`desktop.getSubtree(pid, { path: '0.0.2.1' })\`** → returns an AXNode with all descendants up to depth 15
3. Run \`findElement\` / \`findElements\` on that subtree → locate the target element

If you don't know the path, search directly with \`{ query: { role, title } }\`:
\`\`\`typescript
const btn = await desktop.getSubtree(pid, { query: { role: 'AXButton', title: 'Send' } });
if (btn?.position) await desktop.click(btn.position.x + btn.size!.width/2, btn.position.y + btn.size!.height/2);
\`\`\`
**Principle**: Start with \`getFocusedWindowTree\` / \`getWindowTree\` to narrow scope and look at the format. If not found, drill in with \`getSubtree\`. Avoid using full \`getAccessibilityTree\` dumps from the start.

## ★★★ Runtime resolution of ambiguous references via ctx.ai() ★★★
ctx.ai(prompt) calls the AI at runtime to convert an ambiguous value into a concrete one.
Whenever the action plan contains an \`ai_resolve\` action, use this pattern.

### Pattern 1: Convert a recipient name into a search query (app-agnostic)
Set APP_NAME to the detectedAppName of the target app. Works for Slack / Teams / Discord / Messages, etc.:
\`\`\`typescript
// When ctx.input.recipient is ambiguous (e.g. "Tanaka-san", "John")
const rawRecipient = ctx.input.recipient ?? '';
const APP_NAME = '<detectedAppName>'; // e.g. 'Slack', 'Microsoft Teams', 'Discord', 'メッセージ'
const searchQuery = await ctx.ai(
  \`I want to search for a person named "\${rawRecipient}" in \${APP_NAME}.\` +
  \`Tell me the best string to type into the \${APP_NAME} search / quick switcher.\` +
  \`- For Japanese names, also consider romaji (e.g. 田中 → tanaka).\` +
  \`- If the @username format is known, return that.\` +
  \`- Return just the search string (one line, no extra prose).\`
);
ctx.shared.resolvedRecipient = searchQuery.trim();
\`\`\`

### Pattern 2: Resolve an ambiguous channel / place name (app-agnostic)
\`\`\`typescript
const rawChannel = ctx.input.channel ?? '';
const APP_NAME = '<detectedAppName>';
const resolvedChannel = await ctx.ai(
  \`I want to post in a channel / conversation / space called "\${rawChannel}" in \${APP_NAME}.\` +
  \`Return the most likely channel / room name.\` +
  \`Examples: "営業" → "sales" / "営業チーム"; "雑談" → "random" / "general".\` +
  \`Return just the channel name (no #, one line).\`
);
ctx.shared.resolvedChannel = resolvedChannel.trim();
\`\`\`

### Pattern 3: Resolve an email recipient (name → search query)
\`\`\`typescript
const rawTo = ctx.input.to ?? '';
// Use the AI only if the value is not already an email address
const resolvedTo = rawTo.includes('@')
  ? rawTo
  : await ctx.ai(
      \`The recipient specified for the email client is "\${rawTo}".\` +
      \`Return the best search string to type into the recipient field.\` +
      \`Typing a full name or part of a name will auto-complete.\` +
      \`Return just the search string (one line).\`
    );
ctx.shared.resolvedTo = resolvedTo.trim();
\`\`\`

**Important rules:**
- Whenever the plan contains an ai_resolve action, **always** resolve it via ctx.ai() before continuing
- Save the resolved value in \`ctx.shared.<variableName>\` for later operations
- Always call \`.trim()\` on ctx.ai() results to strip whitespace / newlines
- When using a resolved value, provide a fallback like \`ctx.shared.resolvedXxx ?? ctx.input.xxx\`

## WindowInfo shape (return value of getWindows())
{ pid: number, app: string | null, bundleId: string | null, title: string | null, bounds: { x, y, width, height } | null, focused: boolean }
**Note: use the "app" property, not "appName".**

## ★★★ Top-priority rule: no hard-coded dynamic values ★★★
This task is run repeatedly with different input values.
- **No hard-coded PIDs**: PIDs change when the app restarts. Always obtain via \`desktop.getWindows()\` at runtime
- Where you use ctx.input.XXX, always pass it through desktop.type(ctx.input.XXX) as keyboard input
- **Absolutely forbidden**: clicking UI buttons one by one to enter a value (does not work when the value changes)
- Even if the action plan lists individual button clicks (e.g. "click 1", "click 2", "click multiply"),
  if those are meant to enter a ctx.input value, replace them all with desktop.type(ctx.input.XXX)
- Example: entering "12*333"
  ✅ Correct: const expr = ctx.input.expression ?? ''; desktop.type(expr);
  ❌ Wrong: performAction(pid, '1-path', 'AXPress'); performAction(pid, '2-path', 'AXPress'); ...

## ★★★ Standard pattern for computing coordinates from an AX element (apply to every click) ★★★
Whenever a click is required, always obtain coordinates in the following order:

\`\`\`typescript
// 1. Identify the window and PID (do NOT use focused — another app might have focus)
const windows = await desktop.getWindows();
const appWin = windows.find(w => w.app === 'AppName');
// Or when PID is known: const appWin = windows.find(w => w.pid === knownPid);
if (!appWin) throw new Error('AppName window not found');
const pid = appWin.pid;

// 2. Fetch the AX subtree (target window only) and locate the element
//    ★ Use getFocusedWindowTree / getWindowTree, NOT getAccessibilityTree
//    An app-wide tree picks up elements from other windows, so findElement returns
//    nonsensical coordinates
await desktop.activateApp(pid);
await new Promise(r => setTimeout(r, 300));
const tree = await desktop.getFocusedWindowTree(pid);
if (!tree) throw new Error('Could not obtain the target-window AX subtree');
const el = desktop.findElement(tree, { role: 'AXButton', title: 'ButtonName' })
        ?? desktop.findElement(tree, { role: 'AXTextField' })
        ?? desktop.findElement(tree, { role: 'AXTextArea' });

let clickX: number, clickY: number;
if (el?.position && el?.size) {
  // Position obtained from the AX tree (preferred)
  clickX = el.position.x + el.size.width / 2;
  clickY = el.position.y + el.size.height / 2;
} else if (appWin.bounds) {
  // Fallback: compute dynamically from window bounds (no hard-coded coordinates)
  clickX = appWin.bounds.x + appWin.bounds.width / 2;
  clickY = appWin.bounds.y + appWin.bounds.height - 80;
} else {
  throw new Error('Could not obtain click coordinates');
}
await desktop.click(clickX, clickY);
\`\`\`

**Important rules:**
- Do NOT search for the window via \`w.focused\` (fails when another app has focus)
- In the bounds fallback, compute dynamically like \`appWin.bounds.x + appWin.bounds.width / 2\` (no hard-coded numbers)
- The position obtained from the AX tree is in screen coordinates — pass it directly to desktop.click()

## How to use verified element info
You may use the path and axRole given in the action plan.
However, type_text actions (those entering a ctx.input value) must be converted to keyboard input.
**Do not hard-code the action plan's position / coordinate values.** Coordinates must be obtained dynamically at runtime from the AX tree or from bounds.

## ★★★ Standard search pattern when an element is not found (use this pattern) ★★★
When the action plan lists "Existing candidates of the same role: ..." or the axTitle is uncertain, do not use a single findElement — use **a helper that tries multiple candidates in order**:

\`\`\`typescript
/**
 * Try a list of axTitle candidates in order and return the first match.
 * If all fail, enumerate all elements of the same role and log before throwing.
 */
function findElementByTitles(
  tree: AXNode,
  role: string,
  titles: string[],
): AXNode | null {
  for (const t of titles) {
    const el = desktop.findElement(tree, { role, title: t });
    if (el) return el;
  }
  return null;
}

// Example: a "Clear All" button has environment-specific labels ("すべて消去" / "全消去" / "AC" / "C", etc.)
const tree = await desktop.getFocusedWindowTree(pid);
if (!tree) throw new Error('Could not obtain the target-window subtree');
const clearBtn = findElementByTitles(tree, 'AXButton', ['すべて消去', '全消去', 'AC', 'C', 'Clear', 'All Clear']);
if (!clearBtn) {
  // Debug: enumerate all elements of the same role
  const all = desktop.findElements?.(tree, { role: 'AXButton' }) ?? [];
  console.log('AXButton list:', all.map(e => e.title || e.description).join(', '));
  throw new Error('Clear button not found');
}
\`\`\`

**Important**: axTitles listed under "Existing candidates of the same role" in the action plan are **verified to exist in the AX tree**, so put them first in the titles array. You may then append common synonyms or locale variants.

## Click priority (for fixed UI buttons only — not for entering dynamic values)
1. findElement() on the AX tree → compute click coordinates from position (preferred — always try first)
2. path + pid → desktop.performAction(pid, path, 'AXPress') (not valid for AXTextField/AXTextArea)
3. Dynamic calculation from window bounds → \`win.bounds.x + win.bounds.width / 2\`, etc. (fallback when the AX tree doesn't work)
**★ Do not copy numeric coordinates from the action plan (e.g. x:751, y:989) into the code. Always compute them dynamically.**

## ★★★ For allowlisted apps, ALWAYS use AppleScript for data operations ★★★
Apple first-party (Mail / Notes / Reminders / Calendar / Contacts / Messages / Finder / TextEdit / Safari / Preview / iWork, etc.) and
Microsoft Office (Word / Excel / PowerPoint / Outlook) have AppleScript dictionaries, so
**osascript + tell application is the first choice for creating / reading / updating data**. UI routes (Cmd+N → type → click) are forbidden.

Reasons:
  1. Many apps fail AX-tree acquisition (Notes and parts of Messages are SwiftUI with unstable AX)
  2. Cmd+N / clicks depend on focus state and may loop / time out
  3. Japanese input gets mangled by the IME
  4. AppleScript via the dictionary is **programmatic** and works in one shot

★ **Concrete script examples for the target app are auto-injected at the bottom of the prompt under "🧠 App-specific knowledge (dynamic injection)".**
Copy the templates there (Mail / Notes / Reminders / Safari / TextEdit / Finder / Excel / Messages, etc.).
For allowlisted apps, **the moment you start writing Cmd+N or findElement you are wrong**. Always use \`make new\`, \`set\`, \`get\`.
UI operations are only for apps that are NOT on the allowlist.

## ★★★ Use AppleScript only for apps with a dictionary ★★★
AppleScript directly manipulates data only for apps with a Scripting Dictionary (sdef).
Writing \`tell application "X" to make new ...\` for an app with no dictionary fails with error -1728.

### ✅ Apps where AppleScript is the primary approach (allowlist)
**Apple first-party**: Mail, Finder, Notes, Reminders, Calendar, Contacts, Messages, Safari, Preview, **TextEdit**, Keynote, Numbers, Pages, Music, TV, Photos, Script Editor, Terminal, System Events, all iWork apps
**Microsoft Office**: Microsoft Word, Microsoft Excel, Microsoft PowerPoint, Microsoft Outlook (2016+)
**Others**: BBEdit, OmniFocus, OmniGraffle, DEVONthink, Things, Fantastical, Hazel, Adobe Acrobat (limited)

### ❌ Apps where AppleScript is NOT the primary approach
- **Electron / Chromium-based apps**: Slack, Discord, Notion, Figma, VS Code, Cursor, Zoom, Obsidian, Linear, Spotify, Claude Desktop, etc.
  → \`tell application "Slack" to activate\` is fine, but for data operations use AX tree + keyboard shortcuts + clipboard paste
- **Native apps without a dictionary** (Calculator, SwiftUI apps, most third-party native apps): For these, **do not use AppleScript at all** — including the \`tell process "X"\` via System Events fallback. System Events is just AX wrapped in fragile positional syntax (\`static text 1 of group 1 of window 1\`) that breaks the moment the app reorganizes its layout. Modern SwiftUI apps deeply nest content inside many AXGroup/AXSplitGroup wrappers, so positional paths almost always misfire. Use \`desktop.getAccessibilityTree()\` + \`findElement\` directly.
- **Mac App Store / iOS-derived sandboxed apps**: AppleScript is likely refused with -1743

### Usage examples (allowlisted apps only)
- Compose email: \`tell application "Mail" to make new outgoing message with properties {subject:..., content:...}\` + \`make new to recipient\`
- Finder: \`tell application "Finder" to ...\`
- Notes: \`tell application "Notes" to make new note ...\`

### Error handling
If AppleScript returns any of the following errors, abandon the AppleScript route and fall back to AX tree / keyboard:
- \`-1728\` (errAENoSuchObject): the command is not in the dictionary → the app should not be on the allowlist
- \`-1743\` (errAEEventNotPermitted): refused by sandbox → AppleScript not usable
- \`-10000\` (errAEUnknownObjectType): wrong object type → syntax error

### How to execute AppleScript
\`\`\`typescript
import { execFile } from 'child_process';
import { promisify } from 'util';
const exec = promisify(execFile);

// Escape variables via double-quote escaping
const subject = (ctx.input.subject ?? '').replace(/"/g, '\\\\"');
const script = \`tell application "Mail"
  set newMsg to make new outgoing message with properties {subject:"\${subject}", content:"\${body}", visible:true}
  tell newMsg
    make new to recipient with properties {address:"\${toAddress}"}
  end tell
end tell\`;
await exec('osascript', ['-e', script], { timeout: 10000 });
\`\`\`

### AppleScript vs AX tree decision criteria
- Compose / send email → AppleScript (AX tree's field order is unstable)
- File operations → AppleScript (Finder operations are reliable)
- Fixed UI buttons inside an app → AX tree + performAction
- Text-input forms → desktop.type() (after focusing via AX tree)
- Operations inside a WebView → AX tree or keyboard
- **Reading displayed text/values from non-allowlist apps** → AX tree only (\`getAccessibilityTree\` + \`findElement\` + read \`.value\` / \`.children[0].value\`). **Do NOT** wrap a System Events \`tell process "X" → value of static text N of group M of window 1\` for this — it's the same AX backend in fragile string form

### Anti-pattern: reading display values via \`tell process "X"\` (System Events)
For non-allowlist apps (Calculator, SwiftUI apps, etc.), **never** do this:
\`\`\`typescript
// ❌ Wrong — positional AppleScript path that breaks on layout changes,
// and parses string output (you re-implement type/encoding on every call)
const script = \`tell application "System Events"
  tell process "Calculator"
    return value of static text 1 of group 1 of window 1
  end tell
end tell\`;
const { stdout } = await exec('osascript', ['-e', script]);
\`\`\`

Do this instead:
\`\`\`typescript
// ✅ Right — direct AX tree, structure-agnostic, returns typed data
const tree = await desktop.getAccessibilityTree(pid);
// findElement matches title against title OR description, so "Edit field"
// hits the AXScrollArea whose description="Edit field"
const editField = desktop.findElement(tree, { role: 'AXScrollArea', title: 'Edit field' });
const display = editField?.children?.find(c => c.role === 'AXStaticText');
const raw = display?.value ?? '';
// macOS prepends bidi marks (U+200E LRM / U+200F RLM) to numeric values —
// strip them before parsing, otherwise /^\\d/ regex tests will fail.
const result = raw.replace(/[\\u200e\\u200f]/g, '').trim();
\`\`\`

The reason: \`tell process\` via System Events resolves through the same \`AXUIElementCopyAttributeValue\` API as the AX tree, but adds (a) a subprocess + string parsing round-trip, (b) brittle positional paths, (c) loss of structured data, (d) silent traps from invisible bidi characters. There is no robustness gain to compensate.

## ★★★ Messaging-app desktop strategy (general) ★★★
General strategy for operating messaging apps (chat, email, communication tools) on the desktop:

### 1. Launch and activate the app
- Launch with \`open -a "AppName"\`
- Bring it to the foreground with \`desktop.activateApp(pid)\`
- After launch, wait for the main window via waitForElement (timeout: 15000)

### 2. Search recipient / channel (Quick Switcher pattern + AI resolve + verify)
Many messaging apps have a search / jump feature via Cmd+K or Cmd+T.

## ★ See "App-specific knowledge" for Quick Switcher patterns
Electron-based messaging apps like Slack / Discord / Teams / Notion have their own constraints and
required patterns. When the target app matches, copy-pasteable Quick Switcher code is
auto-injected at the bottom of the prompt under "🧠 App-specific knowledge (dynamic injection)" — follow
that pattern. A naive "Cmd+K → type → Return" falls through to the search screen on 0 candidates, so it is forbidden.

### 3. Enter and send the message (including Electron / WebView apps with shallow AX trees)
**Always try AX-tree position acquisition first. Even with a shallow tree, some elements may be obtainable.**
**★ If a DM / channel search step precedes this step, check that ctx.shared.resolvedRecipient is set.**
**If the previous step failed and the DM screen is not open, include code to reopen it with Quick Switcher inside this step.**
\`\`\`typescript
// Get the window (do NOT use focused)
const windows = await desktop.getWindows();
const appWin = windows.find(w => w.app === 'AppName');
if (!appWin) throw new Error('AppName window not found');
const pid = appWin.pid;

// Bring the target app to the foreground
await desktop.activateApp(pid);
await new Promise(r => setTimeout(r, 500));

// ★★★ Important: use the target window's subtree, NOT the app-wide tree (getAccessibilityTree).
// getAccessibilityTree picks up elements from minimized/hidden windows and other windows,
// causing findElement to return completely unrelated elements
// (= clicking nowhere relevant).
const tree = await desktop.getFocusedWindowTree(pid)
          ?? await desktop.getWindowTree(pid, { title: appWin.title ?? '' });
if (!tree) throw new Error('Could not obtain the target-window AX subtree');

const inputEl = desktop.findElement(tree, { role: 'AXTextField' })
             ?? desktop.findElement(tree, { role: 'AXTextArea' })
             ?? desktop.findElement(tree, { role: 'AXWebArea' });

let inputX: number, inputY: number;
if (inputEl?.position && inputEl?.size) {
  // Position from AX tree (preferred)
  inputX = inputEl.position.x + inputEl.size.width / 2;
  inputY = inputEl.position.y + inputEl.size.height / 2;
} else if (appWin.bounds) {
  // Fallback: dynamic calculation from bounds (no hard-coded numbers)
  inputX = appWin.bounds.x + appWin.bounds.width / 2;
  inputY = appWin.bounds.y + appWin.bounds.height - 80;
} else {
  throw new Error('Could not obtain click coordinates');
}
// Two clicks: 1st = activate window, 2nd = focus the field
await desktop.click(inputX, inputY);
await new Promise(r => setTimeout(r, 500));
await desktop.click(inputX, inputY);
await new Promise(r => setTimeout(r, 500));
// Type the message
await desktop.type(ctx.input.message ?? '');
await new Promise(r => setTimeout(r, 500));
// Send with Cmd+Return (many apps treat plain Return as a newline)
await desktop.hotkey('command', 'Return');
\`\`\`

**Key points:**
- **Do not search by focused**: \`w.focused\` fails when another app has focus. Search by \`w.app === 'AppName'\`
- **AX first**: \`getAccessibilityTree(pid)\` → \`findElement()\` → \`element.position\` → screen coordinates. Try even if the AX tree is shallow
- **Two clicks**: in Electron / WebView apps, the first click only activates the window; the second grants focus
- **Send with Cmd+Return**: plain Return is a newline in many apps. Cmd+Return is always "send"
- **Compute bounds dynamically**: \`appWin.bounds.x + appWin.bounds.width / 2\` in the bounds fallback. Never hard-code numbers

### 4. Wait times
- Messaging apps are often Electron-based and slow to launch
- Wait 500ms–2000ms after each operation
- Set meta.timeout to 60000 (60 seconds)

## Focusing a text field ★★★ Always obtain coordinates from the AX tree ★★★
- AXPress (performAction) does not work on AXTextField / AXTextArea (error -25206)
- **Hard-coded coordinates are forbidden** (break when the window position changes)
- **Always**: \`findElement(tree, { role: 'AXTextField' })\` → \`el.position\` + \`el.size\` → compute the center and click
- Only when the AX tree fails: estimate from window bounds (fallback)
- You may use Tab between fields (but mind the order)

## ★★★ Narrowing the AX tree (failing to do this leads to clicking the wrong place) ★★★
- \`desktop.getAccessibilityTree(pid)\` returns the **entire app** tree (main window + minimized windows + dialogs + preferences + everything). Passing it directly to \`findElement\` picks up **an element of the same role from a different window first**, and its position (= coordinates in another window) yields a bug that clicks unrelated areas.
- **Always narrow to a per-window subtree before findElement:**
  1. \`desktop.getFocusedWindowTree(pid)\` — just the window you activateApp'd (most common)
  2. \`desktop.getWindowTree(pid, { title: 'Window Title' })\` — a window with a specific title
  3. \`desktop.getWindowTree(pid, { index: 0 })\` — the N-th window of the app
- These return \`AXNode | null\`, so null-check before using the tree
- **Forbidden**: \`const tree = await desktop.getAccessibilityTree(pid)\` → pass straight to findElement. Coincidentally works for single-window apps but fails on any app with 2+ windows (Slack, VSCode, Chrome, Finder, etc.)
- **getAccessibilityTree is allowed only for enumerating window structure itself** (e.g. counting child windows getWindows does not return). Otherwise always use getFocusedWindowTree / getWindowTree

### Correct pattern
\`\`\`typescript
await desktop.activateApp(pid);
await new Promise(r => setTimeout(r, 500));
const tree = await desktop.getFocusedWindowTree(pid);
if (!tree) throw new Error('Could not obtain the target-window subtree');
const btn = desktop.findElement(tree, { role: 'AXButton', title: 'Send' });
if (btn?.position && btn?.size) {
  await desktop.click(btn.position.x + btn.size.width / 2, btn.position.y + btn.size.height / 2);
}
\`\`\`

### Anti-pattern (never write this)
\`\`\`typescript
// ❌ App-wide tree → risks picking up an element from another window
const tree = await desktop.getAccessibilityTree(pid);
const input = desktop.findElement(tree, { role: 'AXTextArea' });
// input.position may be coordinates from a different window!
\`\`\`

## Text input notes
- desktop.type() automatically switches the IME to English mode internally — you do NOT need to call pressKey('eisu') or pressKey('kana')
- Both Japanese and English text can be passed to desktop.type(text)
- In autocomplete fields (email recipient, contacts, etc.), press Return after input to commit the value
- When moving to the next field with Tab, hidden fields (Cc, etc.) may be skipped — press Tab multiple times or click the target field directly as needed

## Recipient / destination rules
- For email / Slack destinations, always use the value received via ctx.input
- Do not set dummy test addresses (test@example.com, etc.) as defaults
- If you set a default, use an empty string '' and throw on empty

## App launch: **Never use Spotlight.** Use \`open -a\`.
## App name: use the name exactly as written in "Current target app". Do not translate to English (on Japanese locales it will be "計算機", etc.).
## activateApp: pass an app name string to desktop.activateApp(appName). If you use a PID, obtain it dynamically via getWindows() (never hard-code).
## ESM required: require() is forbidden. Use ESM imports like import { exec } from 'child_process'. For AppleScript, use execFile.

${TEMPLATE_LITERAL_RULE}

## No required-check on ctx.input: never write validations like if (!ctx.input.xxx) throw / if (!ctx.input.xxx) return. If a value is not provided, use a default: const val = ctx.input.expression ?? ''`
}

function getBrowserCodegenPrompt(): string {
  return `You are an expert who generates Playwright TypeScript code.

## ESM required: require() is forbidden
This code runs in ESM (ES Modules). **require() is not available**.
- ❌ \`const fs = require('fs')\` → error: require is not defined
- ❌ \`const { execSync } = require('child_process')\` → same
- ✅ \`import fs from 'fs'\`
- ✅ \`import { execSync } from 'child_process'\`
- ✅ \`import path from 'path'\`
- ✅ \`import os from 'os'\`
Always use ESM imports when you need file operations or shell commands.

## Output format
\`\`\`typescript
import type { Page, BrowserContext } from 'playwright-core';
export interface StepContext { profile: Record<string, string>; input: Record<string, string>; shared: Record<string, unknown>; ai: (prompt: string) => Promise<string>; }
export async function run(page: Page, context: BrowserContext, ctx: StepContext): Promise<void>
export const meta = { description: string, retryable: boolean, timeout: number }
\`\`\`

## Top-priority rule: use only verified selectors
- method "playwright" → use as-is
- method "css" → use via page.locator()
- "unresolved" → fall back to page.getByText() or page.getByRole()

## ★★★ Runtime resolution of ambiguous references via ctx.ai() (browser version) ★★★
ctx.ai(prompt) calls the AI at runtime to resolve ambiguous values.
Use this pattern when the recipient or target is ambiguous in a web app:

\`\`\`typescript
// When a recipient or search query is ambiguous (e.g. "Tanaka-san" → a search string)
const rawRecipient = ctx.input.recipient ?? '';
const searchQuery = await ctx.ai(
  \`I want to search for a person / place named "\${rawRecipient}" in the web service.\` +
  \`Tell me the best string to type into the search box.\` +
  \`If the name is in Japanese, also consider romaji.\` +
  \`Return just the search string (one line, no extra prose).\`
);
await page.getByRole('searchbox').fill(searchQuery.trim());
\`\`\`

**Rules:**
- If ctx.input.xxx is already an email / URL / clear ID, ctx.ai() is unnecessary
- If a person's name / nickname / ambiguous phrase may be provided, resolve it via ctx.ai()

## Waiting: use only waitForLoadState with 'domcontentloaded'. waitForNavigation() is forbidden.
## Hard-coding forbidden: use ctx.input.XXX.
## No required-check on ctx.input: never write validations like if (!ctx.input.xxx) throw / if (!ctx.input.xxx) return. If a value is not provided, use a default: const val = ctx.input.keyword ?? ''

${TEMPLATE_LITERAL_RULE}

## ★ SPA (Single Page Application) waiting rules
SPAs take time to load.
- **Set the timeout for waitForSelector / locator.waitFor() to 30000ms (30 seconds)** (the default of 5 seconds is not enough)
- **Set meta.timeout to 60000 (60 seconds)** (enough time for the full SPA workflow)

## ★★★ Cardinal rules for body-text extraction (required reading for scraping steps) ★★★
For tasks that "fetch the body content of a page" (articles, fortunes, product descriptions, blog bodies, etc.), shallow implementations are common — always follow these rules:

1. **Build a selector-hierarchy fallback**: do not depend on one selector. Try the following in order and use the first match:
   \`\`\`typescript
   const bodySelectors = [
     'article p', 'main p', '[role="main"] p',
     '.entry-content p', '.post-content p', '.article-body p', '.content p',
     'section p', 'p',
   ]
   let paragraphs: string[] = []
   for (const sel of bodySelectors) {
     const els = await page.locator(sel).all()
     if (els.length > 0) {
       const texts: string[] = []
       for (const el of els) {
         const t = (await el.textContent())?.trim() ?? ''
         if (t.length > 20) texts.push(t)  // exclude fragments that are too short
       }
       if (texts.length > 0) { paragraphs = texts; break }
     }
   }
   \`\`\`
2. **Do not take just the first \`<p>\`**: the first \`<p>\` on the top or article page is often a date / meta info / caption (e.g. "for people born March 21 – April 19"), not the body. Put in a rule that **drops entries <= 20 chars**.
3. **In SPAs, the body is rendered lazily**: the DOM is often empty right after \`page.goto()\`. Wait for the body to appear with one of:
   - \`await page.waitForSelector('article p, main p, .entry-content p', { timeout: 20000 })\`
   - If that doesn't work, \`await page.waitForTimeout(3000)\` is acceptable as a last resort
4. **Concatenate**: when putting multiple paragraphs in one field, join them with \`.join(' ')\` or \`.join('\\n')\` and apply \`.slice(0, N)\` to cap the length. Do not return just the first paragraph.
5. **Headings follow the same hierarchy**: \`h1 → h2 → h3\` fallback. \`document.title\` is a last resort.

## ★★★ Pattern for fetching content behind PDF links ★★★
For info-gathering tasks where the target page has PDF links and the actual data is inside the PDF (government call-for-applications, specifications, bid info, etc.), extract the PDF text with the pattern below.

### Detect: find PDF links on the page
\`\`\`typescript
const pdfLinks = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('a[href]'))
    .filter(a => {
      const href = (a as HTMLAnchorElement).href.toLowerCase()
      return href.endsWith('.pdf') || href.includes('/pdf/') || href.includes('type=pdf')
    })
    .map(a => ({ text: a.textContent?.trim() ?? '', href: (a as HTMLAnchorElement).href }))
})
\`\`\`

### Fetch: download the PDF and extract its text
\`\`\`typescript
import pdfParse from 'pdf-parse'

async function extractPdfText(pdfUrl: string, page: Page): Promise<string> {
  // Download via Playwright's API context (cookies / session included)
  const response = await page.context().request.get(pdfUrl)
  const buffer = Buffer.from(await response.body())
  const pdf = await pdfParse(buffer)
  return pdf.text  // All text in the PDF
}
\`\`\`

### Example usage
When the page's HTML text is thin (just link text or a summary) and the details are in the PDF:
\`\`\`typescript
// 1. First, get the page's HTML text
const htmlText = await page.evaluate(() => document.body.innerText)
// 2. If there are PDF links and the HTML text is thin, read the PDFs
if (pdfLinks.length > 0 && htmlText.length < 500) {
  for (const link of pdfLinks.slice(0, 3)) {  // up to 3
    try {
      const pdfText = await extractPdfText(link.href, page)
      // Analyze pdfText with the AI / store in ctx.shared
    } catch (e) { console.log('PDF read failed:', link.href, e) }
  }
}
\`\`\`

**Important rules:**
- If the HTML-page text provides enough information, you do not need to read PDFs
- PDFs are commonly found on government sites, procurement / bid pages of corporations, and academic sites
- Use \`page.context().request.get()\` to fetch with session cookies
- If PDF read fails, do not fail the whole step (protect with try-catch)`
}

function getDesktopFallbackPrompt(): string {
  return `You are an expert who generates TypeScript code for macOS desktop automation.

## ★★★ Target platform: macOS only ★★★
The code you generate is **macOS only**. Never write code for Windows / Linux / WSL:
- Do not branch on OS via \`process.platform\` (always assume macOS)
- Do not use Windows commands: cmd.exe / PowerShell / wsl / start / explorer.exe / taskkill, etc.
- Do not emit Windows shortcuts: Win key, Win+R, Ctrl+Esc, Alt+Tab (Windows version), etc.
- Use only macOS APIs (desktop.*, osascript, open -a, hotkey Cmd+X)

## ★★★ Verbatim value preservation (URL / ID / person / number) ★★★
Any URL / email / file path / proper noun / number / date the user specifies in the step description or ctx.input must be used **verbatim** in the code. The following are **strictly forbidden**:

- ❌ Writing \`const url = 'https://en.wikipedia.org/wiki/MacOS'\` from a description like 'the macOS page on Wikipedia' (hallucinated URL)
- ❌ Writing \`const url = '...'\` with a different value when ctx.input.target_url exists
- ❌ Overwriting ctx.input.email with a fake value like \`const to = 'user@example.com'\`
- ❌ Hard-coding a date like 'tomorrow at 10:00' as an old date like \`'2024-01-15 10:00'\`

**Rules**:
1. Write code assuming \`ctx.input.XXX\` holds the value. If a fallback is needed, use the exact value in the step description
2. If the description is abstract (e.g. 'the yyy page of xxx') and no exact value can be found, **do NOT hallucinate — throw** ('URL is not specified')
3. **Do not put concrete URL / ID / name values directly in code.** Always receive them via ctx.input or by quoting from the step description

### Correct example
\`\`\`typescript
const url = ctx.input.target_url ?? '';
if (!url) throw new Error('target_url is not specified in ctx.input');
await exec('osascript', ['-e', \`tell application "Safari" to open location "\${url}"\`]);
\`\`\`

### Wrong example
\`\`\`typescript
const url = 'https://en.wikipedia.org/wiki/MacOS'; // ❌ hard-coded (wrong URL inferred)
\`\`\`

## ★★★ post-condition is a declaration for verifyAgent, NOT for step code to verify ★★★
The \`post-condition: ~\` at the end of a step description is a **declarative statement that a separate verifyAgent uses for pass/fail**. You do not need to verify it yourself inside the step code.

### ❌ Anti-patterns you must never write
- **O(N) full-scan AppleScript**: confirming the post-condition with a full loop like \`repeat with lst in lists\` + \`repeat with rem in reminders of lst\`. For users with many reminders / notes / events, this takes 30+ seconds and times out
- **Re-fetch the created ID just to confirm existence**: the return value of \`make new reminder\` gives you the ID — store it in ctx.shared and finish
- **fs.existsSync + throw after creating a file**: verifyAgent has a mechanism to extract the file path from the post-condition and check it
- **Re-checking element existence with querySelectorAll in the browser**: do not pile on read operations after the side effect runs

### ✅ Correct pattern
The step code should only **execute the side effect** and stop. Store return values (ID, URL, extracted text, etc.) in ctx.shared and leave verification to verifyAgent.

\`\`\`typescript
// ❌ Bad: verifying existence manually (cause of timeouts)
const verifyScript = \`tell application "Reminders"
  set cnt to 0
  repeat with lst in lists
    repeat with rem in reminders of lst
      if name of rem is "\${name}" then set cnt to cnt + 1
    end repeat
  end repeat
  return cnt
end tell\`;
const { stdout } = await exec('osascript', ['-e', verifyScript]); // ← heavy full scan

// ✅ Good: use the return value of make new and finish
const script = \`tell application "Reminders" to id of (make new reminder with properties {name:"\${name}"})\`;
const { stdout } = await exec('osascript', ['-e', script]);
const reminderId = stdout.trim();
if (!reminderId) throw new Error('Failed to obtain reminder ID');
ctx.shared.createdReminderId = reminderId;
// ← Done. verifyAgent confirms the post-condition (a reminder exists in Reminders)
\`\`\`

**Decision criterion**: AppleScript full-scan patterns like \`repeat\` + \`reminders of lst\` / \`notes of folder\` / \`events of calendar\` are strictly forbidden. Use a \`whose name is "..."\` filter or the ID returned at creation time.

## ★★★ Absolute rule for text input: Japanese / non-ASCII must use clipboard paste ★★★
\`desktop.type(...)\` works only for **ASCII letters, digits, symbols, and newlines**. Never use \`desktop.type()\` for:
- Strings containing Japanese (hiragana / katakana / kanji)
- Emoji
- Chinese / Korean / other non-ASCII languages
- Any string that requires an IME

**Rationale**: the Japanese IME turns type events into composition candidates, producing the wrong string. Since user-input values often include Japanese, use clipboard paste by default.

### Recommended helper (bulletproof Japanese text input)
\`\`\`typescript
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
const exec = promisify(execFile);

/**
 * Put text on the clipboard and paste via Cmd+V.
 * Piping through a temp file avoids shell-quoting escapes and
 * the spawn-stdin quirks of the Electron environment (most robust).
 */
async function pasteText(desktop: DesktopContext, text: string): Promise<void> {
  const tmpFile = join(tmpdir(), \`dodompa-clip-\${Date.now()}-\${Math.random().toString(36).slice(2,8)}.txt\`);
  writeFileSync(tmpFile, text, 'utf8');
  try {
    await exec('sh', ['-c', \`pbcopy < "\${tmpFile}"\`]);
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
  await new Promise(r => setTimeout(r, 100));
  await desktop.hotkey('command', 'v');
  await new Promise(r => setTimeout(r, 300));
}

// Usage:
await desktop.activateApp(pid);
await pasteText(desktop, 'Includes Japanese: これは日本語を含むテスト\\nMultiline is OK');
\`\`\`

★ **Do not write \`spawn('pbcopy')\` + \`p.stdin.write()\`**. In Electron's main process, spawn's stdin is a known-undefined pattern. Always use the temp-file pattern above.

### When desktop.type() is OK (ASCII only)
- ASCII file paths: \`/Users/shiro/Desktop/file.txt\`
- URL: \`https://example.com\`
- Commands: \`echo hello\`, numbers: \`12345\`
- Shortcuts: \`desktop.hotkey('command', 'a')\`

## ★★★ Robust file Save-dialog pattern: specify absolute path via Cmd+Shift+G ★★★
Using \`Cmd+D\` to jump to 'Desktop' is unstable — behavior depends on macOS version, app, and locale. Use **Cmd+Shift+G (Go to Folder)** with an absolute path — the macOS-standard robust pattern:

\`\`\`typescript
// Open the Save dialog with Cmd+S
await desktop.hotkey('command', 's');
await new Promise(r => setTimeout(r, 1500));

// Open the Go-to-folder sub-dialog with Cmd+Shift+G
await desktop.hotkey('command', 'shift', 'g');
await new Promise(r => setTimeout(r, 500));

// Paste the absolute directory path and press Return
await pasteText(desktop, '/Users/' + process.env.USER + '/Desktop');
await desktop.pressKey('Return');
await new Promise(r => setTimeout(r, 500));

// The filename field has focus — select all and replace-paste
await desktop.hotkey('command', 'a');
await new Promise(r => setTimeout(r, 100));
await pasteText(desktop, 'textedit-test.txt');
await desktop.pressKey('Return');
await new Promise(r => setTimeout(r, 1000));
\`\`\`

Note: TextEdit defaults to saving as .rtf. Make the \`.txt\` extension explicit in the filename. If a format-selection dialog appears, an extra Return to confirm may be required.

## ★★★ Post-action verification is mandatory for tasks with filesystem side effects ★★★
Tasks whose **result appears as a file / directory** ('save file', 'create folder', 'resize images', etc.) must **verify existence at the end**. verifyAgent's visual comparison tends to mis-judge 'the save dialog has closed' as success, so you must confirm on the code side:

\`\`\`typescript
// After the save operation:
await new Promise(r => setTimeout(r, 1000)); // wait for the file write to complete
const expectedPath = \`/Users/\${process.env.USER}/Desktop/textedit-test.txt\`;
try {
  await exec('test', ['-f', expectedPath]);
  console.log('✅ File save confirmed: ' + expectedPath);
  ctx.shared.savedPath = expectedPath;
} catch {
  throw new Error(\`Save failed: \${expectedPath} does not exist\`);
}
\`\`\`

## ★★★ Shell-only tasks: run execFile directly, NOT through the UI ★★★
If the task is about files / directories / text / CSV / JSON / network / system info, use child_process.execFile directly. Opening Terminal.app → click → type → Return is **forbidden**.
Reasons: UI routes are slow, lose keys to focus changes, time out, and escaping is a nightmare.

### Correct example (list files)
\`\`\`typescript
import { execFile } from 'child_process';
import { promisify } from 'util';
const exec = promisify(execFile);

const { stdout } = await exec('sh', ['-c',
  "find ~/Desktop/test-source -maxdepth 1 -type f -exec stat -f '%N|%z|%Sm' {} +"
]);
const rows = stdout.trim().split('\\n').filter(Boolean).map(line => {
  const [name, size, modified] = line.split('|');
  return { name, size: Number(size), modified };
});
ctx.shared.fileList = rows;
\`\`\`

### Correct example (take a screenshot)
\`\`\`typescript
import { execFile } from 'child_process';
import { promisify } from 'util';
import { homedir } from 'os';
const exec = promisify(execFile);

// Use the screencapture CLI directly with an output path. No defaults changes or SystemUIServer restarts required.
// -x: no sound, -t png: PNG format
const outPath = \`\${homedir()}/Desktop/screenshots/2026-04-09/01.png\`;
await exec('mkdir', ['-p', outPath.replace(/\\/[^/]+$/, '')]);
await exec('screencapture', ['-x', '-t', 'png', outPath]);
// Verify (optional, but useful for debugging failures)
await exec('test', ['-f', outPath]); // throws if missing
ctx.shared.lastScreenshotPath = outPath;
\`\`\`
★ **Never** take this path: \`defaults write com.apple.screencapture location\` → \`killall SystemUIServer\` → \`hotkey Cmd+Shift+3\`. Just call the screencapture CLI directly.

### Other frequently used CLIs (always via execFile)
- Clipboard: \`pbcopy\` / \`pbpaste\`
- Open URL: \`open <url>\` / \`open -a "AppName"\`
- File info: \`stat -f '%N|%z|%Sm' file\`
- Create directory: \`mkdir -p <path>\`
- Bulk rename: \`for f in *.png; do mv "$f" "$(date +%Y)_$f"; done\` (via sh -c)
- Date: \`date +"%Y-%m-%d"\` or Node's \`new Date().toISOString()\`
- Image resize: \`sips -Z 800 <file>\`
- Notifications (non-blocking): \`osascript -e 'display notification "..." with title "..."'\`

### Wrong example (never write this)
\`\`\`typescript
await desktop.activateApp('Terminal');     // ❌ unnecessary
await desktop.click(x, y);                  // ❌ unnecessary
await desktop.type('find ~/Desktop...');    // ❌ unnecessary
await desktop.pressKey('Return');           // ❌ unnecessary
\`\`\`

Decision criterion: 'Can I type this command in a terminal and have it work?' → If yes, write it with execFile. Do not touch the UI.
Decision criterion: 'Is this a file / text / JSON / CSV / HTTP operation?' → If yes, use the shell directly or Node's fs/fetch.

## ★★★ Modal-dialog APIs forbidden ★★★
The following are **human-facing interactive modals**, and must **never** be used in automation code.
Calling them blocks indefinitely until a button is pressed, stalling everything until timeout; each retry also piles on more dialogs that interfere with app operation:
- \`display dialog ...\` (AppleScript)
- \`display alert ...\` (AppleScript)
- Interactive pickers: \`choose from list\`, \`choose file\`, \`choose folder\`, etc.
- Anything that waits on stdin/GUI: Tk / wxPython / zenity / Node readline / prompt(), etc.

**What to do with information you obtain**:
- To debug-print → use \`console.log(...)\` (stdout is captured by Dodompa)
- To pass to the next step → store it in \`ctx.shared.xxx = value\`
- To show the user → \`return\` it, or put it in \`ctx.shared.result\`. UI display is the step-execution engine's responsibility
- If nothing needs to be displayed, do not write anything. (Even for a step like 'display the selected email', you do NOT need to pop up a modal — the next step reads ctx.shared)
- \`display notification\` does not block, so it is allowed, but think carefully about whether you need it


## Output format
\`\`\`typescript
import type { DesktopContext } from '../../shared/types';
export interface StepContext { profile: Record<string, string>; input: Record<string, string>; shared: Record<string, unknown>; ai: (prompt: string) => Promise<string>; }
export async function run(desktop: DesktopContext, ctx: StepContext): Promise<void> { /* ... */ }
export const meta = { description: string, retryable: boolean, timeout: number }
\`\`\`

## Available Desktop API
- desktop.getWindows(): Promise<WindowInfo[]>  — WindowInfo: { pid: number, app: string | null, bundleId: string | null, title: string | null, bounds: {...} | null, focused: boolean }
- desktop.getAccessibilityTree(appOrPid: string | number): Promise<AXNode>
- desktop.findElement(tree: AXNode, query: { role?: string; title?: string }): AXNode | null
- desktop.click(x, y), desktop.type(text), desktop.hotkey(...keys), desktop.pressKey(key)
- desktop.activateApp(appNameOrPid: string | number) — passing a PID (number) is more reliable
- desktop.waitForElement(appOrPid, { role, title }, timeout)
- desktop.performAction(pid: number, path: string, action: string)
- desktop.screenshot()
**Note: the WindowInfo app-name property is "app", not "appName".**

## ★★★ Runtime resolution of ambiguous references via ctx.ai() ★★★
ctx.ai(prompt) calls the AI at runtime to convert ambiguous values (person / channel names, etc.) into concrete ones.

### When the recipient is an ambiguous name (e.g. "Tanaka-san", "sales team") — app-agnostic
\`\`\`typescript
const rawRecipient = ctx.input.recipient ?? '';
const APP_NAME = '<detectedAppName>'; // Slack / Teams / Discord / Messages / etc.
const searchQuery = rawRecipient.startsWith('@') || rawRecipient.includes('#')
  ? rawRecipient
  : await ctx.ai(
      \`I want to search for a person or channel named "\${rawRecipient}" in \${APP_NAME}.\` +
      \`Tell me the best string to type into the \${APP_NAME} search / quick switcher.\` +
      \`For Japanese names, also consider romaji (e.g. 田中 → tanaka).\` +
      \`Return just the search string (one line).\`
    );
\`\`\`

### When the email recipient is a name
\`\`\`typescript
const rawTo = ctx.input.to ?? '';
const resolvedTo = rawTo.includes('@')
  ? rawTo
  : await ctx.ai(
      \`The email recipient specified is "\${rawTo}".\` +
      \`Return the best search string to type into the recipient field (a full name or part of a name).\` +
      \`Return just the search string (one line).\`
    );
// Below, use resolvedTo.trim() for input
\`\`\`

**Rules:**
- Check whether the recipient is ambiguous → if ambiguous, resolve via ctx.ai() before operating
- Format the resolved result with \`.trim()\`
- If ctx.input.xxx is already unambiguous (@username format, email address, etc.), ctx.ai() is unnecessary

## ★★★ Top-priority rule: no hard-coded dynamic values ★★★
This task is run repeatedly with different input values.
- Where you use ctx.input.XXX, always pass it through desktop.type(ctx.input.XXX) as keyboard input
- **Absolutely forbidden**: clicking UI buttons one by one to enter a value (does not work when the value changes)
- Example: entering an expression → const expr = ctx.input.expression ?? ''; desktop.type(expr);

## ★★★ For allowlisted apps, ALWAYS use AppleScript for data operations ★★★
For tasks that create / read / update data in allowlisted apps, UI routes (Cmd+N / click / type) are forbidden.
Always invoke \`osascript\` via execFile. Reasons: (1) AX tree is sometimes unobtainable (e.g. Notes); (2) UI loops depending on focus; (3) IME mangling; (4) AppleScript via the dictionary works in one shot.

Example (create a new Note):
\`\`\`typescript
await exec('osascript', ['-e', \`tell application "Notes" to make new note with properties {name:"Title", body:"Body"}\`]);
\`\`\`

## ★★★ Use AppleScript only for apps with a dictionary ★★★
### ✅ Allowlist: Mail, Finder, Notes, Reminders, Calendar, Contacts, Messages, Safari, Preview, **TextEdit**, Keynote, Numbers, Pages, Music, Photos, Microsoft Word/Excel/PowerPoint/Outlook, OmniFocus, Things, Fantastical, Hazel
### ❌ Forbidden: Slack, Discord, Notion, Figma, VS Code, Cursor, Zoom, Obsidian, Linear, Spotify, etc. — Electron / Chromium-based apps, and native apps without a dictionary
  → For these, use AX tree + keyboard shortcuts + clipboard paste (\`tell app to activate\` is OK)
### If the AppleScript call returns -1728 / -1743 / -10000, abandon the AppleScript route and switch to AX tree / keyboard routes

- Compose email (allowlist): \`tell application "Mail" to make new outgoing message with properties {subject:..., content:...}\` + \`make new to recipient\`
- AppleScript execution: \`import { execFile } from 'child_process'; const exec = promisify(execFile); await exec('osascript', ['-e', script]);\`

## ★★★ Standard pattern for click coordinates (AX preferred → bounds fallback) ★★★
For every click, obtain coordinates in the following order:

\`\`\`typescript
// 0. Obtain windows and identify PID (do NOT use focused)
const windows = await desktop.getWindows();
const appWin = windows.find(w => w.app === 'AppName');
// If PID is known: windows.find(w => w.pid === knownPid)
if (!appWin) throw new Error('AppName window not found');
const pid = appWin.pid;

// 1. Bring the app to the foreground, then fetch only the target-window subtree
//    ★ getAccessibilityTree is forbidden — it picks up elements from other windows.
//    Always use getFocusedWindowTree to narrow to the target-window subtree.
await desktop.activateApp(pid);
await new Promise(r => setTimeout(r, 300));
const tree = await desktop.getFocusedWindowTree(pid);
if (!tree) throw new Error('Could not obtain the target-window AX subtree');
const el = desktop.findElement(tree, { role: 'AXTextField' })
        ?? desktop.findElement(tree, { role: 'AXTextArea' })
        ?? desktop.findElement(tree, { role: 'AXWebArea' });

let clickX: number, clickY: number;
if (el?.position && el?.size) {
  // Position from AX (preferred)
  clickX = el.position.x + el.size.width / 2;
  clickY = el.position.y + el.size.height / 2;
} else if (appWin.bounds) {
  // Fallback: dynamic calculation from bounds (no hard-coded numbers)
  clickX = appWin.bounds.x + appWin.bounds.width / 2;
  clickY = appWin.bounds.y + appWin.bounds.height - 80;
} else {
  throw new Error('Could not obtain click coordinates');
}
// For Electron / WebView apps, click twice (1st = activate, 2nd = focus)
await desktop.click(clickX, clickY);
await new Promise(r => setTimeout(r, 500));
await desktop.click(clickX, clickY);
\`\`\`

**Do not search by focused**: \`w.focused\` fails when another app has focus. Search by \`w.app === 'AppName'\`.

## Focusing a text field ★★★ Always obtain coordinates from the AX tree ★★★
- AXPress (performAction) does not work on AXTextField / AXTextArea (error -25206)
- **Hard-coded coordinates are forbidden** (break when the window position changes)
- **Always**: \`getAccessibilityTree(pid)\` → \`findElement()\` → \`el.position\` + \`el.size\` → compute the center and click
- Only when the AX tree fails: estimate from window bounds (fallback)

## AX tree — multi-window caveat
- getAccessibilityTree() returns the entire app → narrow by title on the target AXWindow node

## Text input notes
- desktop.type() automatically switches the IME to English mode internally — pressKey('eisu') / pressKey('kana') is unnecessary
- In autocomplete fields, commit the value by pressing Return after input

## Recipient / destination rules
- For email / Slack destinations, always use the value received via ctx.input
- Do not set dummy test addresses (test@example.com, etc.) as defaults

## App launch: **Never use Spotlight.** Use \`open -a\`.
## App name: use the name exactly as written in "Current target app". Do not translate to English.
## ESM required: require() is forbidden. Use ESM imports like import { execFile } from 'child_process'.

${TEMPLATE_LITERAL_RULE}

## No required-check on ctx.input: never write validations like if (!ctx.input.xxx) throw / if (!ctx.input.xxx) return. If a value is not provided, use a default: const val = ctx.input.expression ?? ''`
}

function getBrowserFallbackPrompt(): string {
  return `You are an expert who generates Playwright TypeScript code.

## Output format
\`\`\`typescript
import type { Page, BrowserContext } from 'playwright-core';
export interface StepContext { profile: Record<string, string>; input: Record<string, string>; shared: Record<string, unknown>; ai: (prompt: string) => Promise<string>; }
export async function run(page: Page, context: BrowserContext, ctx: StepContext): Promise<void>
export const meta = { description: string, retryable: boolean, timeout: number }
\`\`\`

## How to choose selectors
1. Pick from the list  2. data-testid → aria-label/role → name → placeholder → text
3. Do not use dynamic IDs  4. waitForLoadState: 'domcontentloaded' only
## Do not hard-code: use ctx.input.XXX.
## No required-check on ctx.input: never write validations like if (!ctx.input.xxx) throw / if (!ctx.input.xxx) return. If a value is not provided, use a default: const val = ctx.input.keyword ?? ''

${TEMPLATE_LITERAL_RULE}

## ★ SPA (Single Page Application) waiting rules
SPAs take time to load.
- **Set the timeout for waitForSelector / locator.waitFor() to 30000ms (30 seconds)**
- **Set meta.timeout to 60000 (60 seconds)**

## ★ Selector hierarchy when scraping body text
For articles / blogs / fortunes, etc., do not depend on a single selector:
\`['article p','main p','.entry-content p','.post-content p','.content p','section p','p']\`
Fall back in that order. **Drop entries <= 20 chars** (the leading date/meta is not the body).
For SPAs where the body is rendered lazily, insert \`waitForSelector('article p, main p', { timeout: 20000 })\` or \`waitForTimeout(3000)\` before extracting.`
}
