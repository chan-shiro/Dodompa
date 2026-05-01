// ─── Action Plan Agent ───
// Generates a structured action plan (list of actions) from a step description.
// Analyzes the current page/desktop state and produces actions like click, fill, type, etc.

import type { BrowserWindow } from 'electron'
import type { AiProviderConfig, StepPlan } from '../../../shared/types'
import type { ActionPlan } from './selectorAgent'
import { chatStream } from './aiChat'
import { sendProgress, sendAndLog } from './progressHelper'
import type { SiteMap } from './reconAgent'
import { formatSiteMapForPrompt } from './reconAgent'
import { buildRuntimeContext } from './buildRuntimeContext'

// ── Helpers for ctx.shared visibility and variable-task warnings ──

function formatSharedState(shared?: Record<string, unknown>): string {
  if (!shared || Object.keys(shared).length === 0) return ''
  const entries = Object.entries(shared).map(([k, v]) => {
    if (v === undefined || v === null) return `  - ctx.shared.${k}: (null)`
    if (typeof v === 'string') return `  - ctx.shared.${k}: "${v.slice(0, 80)}${v.length > 80 ? '...' : ''}"`
    if (Array.isArray(v)) return `  - ctx.shared.${k}: [array of ${v.length} items]`
    if (typeof v === 'object') return `  - ctx.shared.${k}: {${Object.keys(v as Record<string, unknown>).join(', ')}}`
    return `  - ctx.shared.${k}: ${String(v)}`
  })
  return `\n\n## Current ctx.shared values (data saved by earlier steps)\n${entries.join('\n')}\n\n★ If the above data is already present, do NOT re-fetch the same information — just read it from ctx.shared.`
}

function formatVariableWarning(vars?: Array<{ key: string; label?: string; default?: string }>): string {
  if (!vars || vars.length === 0) return ''
  const varList = vars.map(v => `  - ctx.input.${v.key} (${v.label ?? v.key})${v.default ? ` current test value: "${v.default}"` : ''}`).join('\n')
  return `\n\n## ★★★ Variable-driven task: do NOT hard-code URLs ★★★
This task has the following variables whose values change per run:
${varList}

**Important rules:**
- Specific URLs discovered via recon or the site map (e.g. https://www.yoshimoto.co.jp/corporate/) are **only sample results for the current test value**
- Never hard-code a specific company's domain in a goto URL. Resolve URLs dynamically (e.g. via Google search) so the plan still works when ctx.input.xxx changes
- Use info discovered via recon as a **strategy pattern** (e.g. "for this kind of site, officer info lives at /corporate/") — do NOT hard-code the specific URL
- If an earlier step stored a URL etc. in ctx.shared, use that value (see "Current ctx.shared values" above)`
}

export interface ActionPlanResult {
  actions: ActionPlan[]
  question?: { question: string; infoKey?: string }
  alreadyDone?: boolean
}

export interface StepResult {
  stepName: string
  description: string
  success: boolean
  error?: string
  verifyReason?: string
  codeSnippet?: string
}

export async function generateActionPlan(
  config: AiProviderConfig,
  win: BrowserWindow | null,
  taskId: string,
  stepPlan: StepPlan,
  stepIndex: number,
  pageUrl: string,
  screenshot: string,
  selectorMap: string,
  pageHtml: string,
  existingCodes: string[],
  errorHistory: Array<{ attempt: number; error: string; selectors: string[]; logs?: string[] }>,
  detectedAppName?: string,
  launchName?: string,
  previousStepResults?: StepResult[],
  strategyLedgerText?: string,
  siteMap?: SiteMap,
  taskGoal?: string,
  executionShared?: Record<string, unknown>,
  taskVariables?: Array<{ key: string; label?: string; default?: string }>,
): Promise<ActionPlanResult> {
  const errorHistoryText = errorHistory.length > 0
    ? `\n\n## Past failures (these approaches already failed — do not reuse them)\n${errorHistory.map(h => {
        const logsBlock = h.logs && h.logs.length > 0
          ? `\nConsole output that failing run produced — read carefully, it shows what the previous code actually observed:\n\`\`\`\n${h.logs.slice(0, 30).map(l => l.length > 200 ? l.slice(0, 200) + '…' : l).join('\n')}\n\`\`\``
          : ''
        return `Attempt ${h.attempt}: ${h.error}\nSelectors tried: ${h.selectors.join(', ')}${logsBlock}`
      }).join('\n\n')}`
    : ''

  const ledgerText = strategyLedgerText && strategyLedgerText.trim().length > 0
    ? `\n\n${strategyLedgerText}`
    : ''

  // Build cross-step context from previous step results
  const prevStepContext = previousStepResults && previousStepResults.length > 0
    ? `\n\n## Previous step results (important context that affects the current screen state)\n${previousStepResults.map((r, idx) =>
        `Step ${idx + 1} "${r.stepName}": ${r.success ? '✅ Success' : `❌ Failed — ${r.error ?? 'unknown'}`}${r.verifyReason ? `\n  Verification: ${r.verifyReason}` : ''}`
      ).join('\n')}\n\n★ If an earlier step failed, the preconditions for this step may not be satisfied.\nExample: if the DM-search step failed, the DM screen is not open, and the message input field likely cannot be focused.\nIn that case, include actions within this step that recover the precondition (open the DM screen, etc.).`
    : ''

  const stepType = stepPlan.type ?? 'browser'

  // Recon-derived siteMap (browser only). Injected as a high-priority context
  // block so the AI sees actual URL patterns / candidate elements before it
  // starts guessing from the screenshot.
  const siteMapText = stepType === 'browser' && siteMap
    ? `\n\n${formatSiteMapForPrompt(siteMap)}`
    : ''

  const planMessages = [
    {
      role: 'system',
      content: stepType === 'desktop'
        ? getDesktopActionPlanSystemPrompt()
        : getBrowserActionPlanSystemPrompt(),
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: `## Step instruction\n${stepPlan.description}${taskGoal ? `\n\n## Final task goal\n${taskGoal}\nTo achieve the goal above, gather all the information this step needs. If the actual data lives behind links (PDFs, sub-pages, etc.), include actions that follow those links.` : ''}${formatSharedState(executionShared)}${formatVariableWarning(taskVariables)}` },
        ...(screenshot
          ? [{ type: 'image', image: screenshot, mimeType: 'image/png' }]
          : []),
        ...(detectedAppName && stepType === 'desktop' ? [{
          type: 'text' as const,
          text: `## Current target app\nDisplay name: "${detectedAppName}" (use this name for activate_app / waitForElement)\nCommand-line name: "${launchName || detectedAppName}" (use this name for open_app / shell \`open -a\`)`,
        }] : []),
        ...(selectorMap ? [{
          type: 'text' as const,
          text: stepType === 'desktop'
            ? `## Available elements (detected from the real accessibility tree — copy these exact values for axTitle)\n${selectorMap}`
            : `## Available selectors (detected and verified on the actual page)\n${selectorMap}`,
        }] : []),
        {
          type: 'text',
          text: (() => {
            // On retries (when we have error history), reduce HTML to make room for error context
            const htmlLimit = errorHistory.length > 0 ? 3000 : 6000
            return stepType === 'desktop'
              ? `## Current desktop state\n${pageHtml.slice(0, htmlLimit)}${prevStepContext}${errorHistoryText}${ledgerText}`
              : `## Current page URL\n${pageUrl}\n\n## Page HTML (excerpt)\n${pageHtml.slice(0, htmlLimit)}${siteMapText}${prevStepContext}${errorHistoryText}${ledgerText}`
          })(),
        },
        ...(existingCodes.length > 0
          ? [{
              type: 'text',
              text: `## Code from previous steps (for reference)\n${existingCodes.slice(-2).join('\n---\n')}`,
            }]
          : []),
      ],
    },
  ]

  const result = await chatStream(config, planMessages, (delta) => {
    sendProgress(win, {
      phase: 'generating', agent: 'actionPlan',
      stepIndex,
      stepName: stepPlan.name,
      message: '',
      streamDelta: delta,
    })
  })

  const responseText = result.text

  // Check if AI is asking a question
  const questionMatch = responseText.match(/```json\s*\n?\s*\{[\s\S]*?"question"\s*:/)
    || responseText.match(/\{"question"\s*:/)
  if (questionMatch) {
    try {
      const jsonStr = responseText.match(/\{[\s\S]*?"question"[\s\S]*?\}/)?.[0]
      const q = JSON.parse(jsonStr!)
      if (q.question) {
        return { actions: [], question: { question: q.question, infoKey: q.infoKey } }
      }
    } catch { /* Not a valid question, continue parsing as action plan */ }
  }

  // Parse action plan
  try {
    const jsonMatch = responseText.match(/```json\s*\n?([\s\S]*?)```/)
      || responseText.match(/(\{[\s\S]*"actions"[\s\S]*\})/)
    if (jsonMatch) {
      const jsonStr = jsonMatch[1] || jsonMatch[0]
      const parsed = JSON.parse(jsonStr)
      if (parsed.alreadyDone) {
        return { actions: [], alreadyDone: true }
      }
      if (parsed.actions && Array.isArray(parsed.actions)) {
        return { actions: parsed.actions }
      }
    }
  } catch { /* parsing failed */ }

  return { actions: [] }
}

function getDesktopActionPlanSystemPrompt(): string {
  return `You are an action planner for macOS desktop automation.
${buildRuntimeContext()}

## ★★★ Role boundary: you handle "strategy", codegen handles "implementation" ★★★
This system runs as a two-stage pipeline (actionPlan → codegen). The roles are strictly separated:

### Your responsibilities (actionPlanAgent)
- **Decide WHAT**: which app, which element, and with what intent to operate
- Choose the action types to use (open_app / activate_app / click_element / type_text / hotkey / shell / wait / ai_resolve)
- Fill in the minimum parameters each action needs (axRole, axTitle, keys, text, command)
- Write the **intent in the description** (e.g. "click the Send button")

### codegenAgent's responsibilities (= off-limits for you)
- The TypeScript code body (async/await, try/catch, for loops, variable definitions, types)
- Retry and fallback logic by re-fetching the AX tree
- throw Error on failure and error-message formatting
- Assignment logic for ctx.shared.XXX (shaping data, JSON.stringify, etc.)
- Pulling shell command output into JavaScript and processing it

### Do NOT include these in the output
- ❌ TypeScript/JavaScript code snippets ("await page.locator(...)", "const x = ...", etc.)
- ❌ Pseudo-code for loops or branches ("for each item: click", "if logged in then ...")
- ❌ Implementation details in the description (do NOT write things like "wrap in try/catch and retry 3 times" — codegen handles that automatically)
- ❌ Assignments to ctx.shared.XXX inside actions (assignments belong to codegen)

### Exception: "atomic shell commands" may be written directly in the plan
- It's OK to write a single find / ls / osascript / pbcopy, etc. in the command field of a \`shell\` action
- A one-line AppleScript is also OK (osascript -e '...')
- **Rationale**: these map 1:1 as "one action = one shell execution" — codegen just hands them to execFile verbatim
- **NOT OK**: multi-line shell scripts, pipelines whose output must be parsed by JS afterwards — those belong to codegen

## ★★★ Tasks that finish with shell should be ONE \`shell\` action ★★★
For tasks like the following, **never use the UI**. Finish them with one or more \`shell\` actions:
- List / copy / move / delete / rename files (find, ls, mv, cp, rm)
- Change permissions or attributes (chmod, xattr)
- Directory ops (mkdir, rmdir)
- Read/write files (cat, echo, tee, cut, awk, sed, jq, grep)
- Compression (zip, unzip, tar)
- CSV / JSON / text formatting (awk, sed, jq, csvkit)
- System info (date, uname, sw_vers, df, du, stat, file)
- Network (curl, wget, ping)
- Date math / sleep / environment variables
- Screen capture (screencapture CLI)
- Clipboard (pbcopy, pbpaste)
- Notifications (\`osascript -e 'display notification ...'\`)

★ **Never plan Terminal.app → activate → click → type_text → Return**. That's a long way around invoking a shell via UI, and it causes timeouts, typing failures, and input-escaping nightmares.
★ Node's child_process.execFile can call shell commands directly. That's exactly why the shell action exists.

### Correct example (list files)
\`\`\`json
{"actions": [
  {"action": "shell", "command": "find ~/Desktop/test-source -maxdepth 1 -type f -exec stat -f '%N|%z|%Sm' {} +", "description": "List files"}
]}
\`\`\`

### Wrong example (do NOT write it this way)
\`\`\`json
{"actions": [
  {"action": "activate_app", "app": "Terminal"},        ❌ unnecessary
  {"action": "click_element", "axRole": "AXTextArea"},  ❌ unnecessary
  {"action": "type_text", "text": "ls -la"},            ❌ unnecessary
  {"action": "press_key", "key": "Return"}              ❌ unnecessary
]}
\`\`\`

## ★★★ Never use modal dialogs ★★★
Actions that involve **human-facing modals** like \`display dialog\`, \`display alert\`, \`choose from list\`, or \`choose file\` must **never** be planned.
They block until the OK button is clicked, which always hangs in automation. Dialogs also stack up across retries, making the situation unrecoverable.
For fetch steps, think "fetch now, consume it in the next step" — do NOT include user-facing modal prompts in the plan.

## ★★★ Target platform: macOS only ★★★
This system is **macOS only**. Never make any Windows / Linux / WSL suggestion or question:
- Do not mention Windows Start button / Start menu / taskbar / Explorer / cmd.exe / PowerShell / WSL / Run dialog, etc.
- Do not emit Windows shortcuts like Win / Ctrl+Esc / Win+R / Alt+Tab (Windows version)
- Do **NOT** return questions like "From the Windows Start menu..." or "Which OS should I run on?"
- Use only the macOS way (open -a / no Spotlight / AX tree / AppleScript / Cmd+ shortcuts)

When the instruction is ambiguous, do not ask the user which OS — pick the most natural macOS-native approach.

Read the step instruction and identify the actions to execute on the desktop.

## Output format
Return **only** the following JSON (no prose):
\`\`\`json
{
  "actions": [
    {"action": "open_app", "app": "AppName", "description": "Launch the app with open -a AppName"},
    {"action": "activate_app", "app": "AppName", "description": "Bring the app to the foreground"},
    {"action": "click_element", "description": "Click the 7 button", "axRole": "AXButton", "axTitle": "7"},
    {"action": "click_element", "description": "Click the + button", "axRole": "AXButton", "axTitle": "+"},
    {"action": "click_element", "description": "Focus the calc result display", "axRole": "AXStaticText", "axValue": "40,626"},
    {"action": "type_text", "text": "Hello World", "description": "Type text"},
    {"action": "hotkey", "keys": ["command", "s"], "description": "Save"},
    {"action": "press_key", "key": "Return", "description": "Press Enter"},
    {"action": "click_position", "x": 100, "y": 200, "description": "Click coordinates"},
    {"action": "shell", "command": "open -a 'AppName'", "description": "Launch the app via shell"},
    {"action": "wait", "seconds": 1, "description": "Wait"}
  ]
}
\`\`\`

## ★★ Resolve ambiguous references/recipients with the ai_resolve action ★★
When the step instruction contains a vague expression that must be resolved at runtime (e.g. "send to Tanaka-san", "post to the sales channel"),
**insert an ai_resolve action first** to convert the vague value into a concrete one.

\`\`\`json
{"action": "ai_resolve", "variable": "resolvedRecipient", "input": "ctx.input.recipient",
 "hint": "Convert this into a string that can be searched as a Slack user or channel name. Consider @username format and English spellings. Return only the search string."}
\`\`\`

### When to use ai_resolve
- **Recipient is a person's name / nickname**: "Tanaka-san", "John" → convert to a Slack search query or formal username
- **Ambiguous channel name**: "sales channel", "chitchat" → convert to the formal channel name
- **Japanese name needs English/romaji conversion**: Slack search may hit on romaji instead
- **Recipient is a full name for email**: "Manager Tanaka" → produce a search string when the email address is unknown

### Use the ai_resolve output as a variable in subsequent actions
The resolved value can be referenced as \`ctx.shared.resolvedRecipient\` (the variable name).
For the subsequent actions (search input, etc.), make the description explicit that this variable value is being used.

## Top-priority rule: how to launch apps
- **Never use Spotlight** (unstable — depends on language settings and search history)
- Use the "open_app" action (it runs \`open -a "AppName"\` internally)
- Or use the "shell" action to run \`open -a "AppName"\` directly
- After launching, use "activate_app" to bring it to the foreground and "wait" a moment

## Top-priority rule: use the app name exactly as written in the "Current target app" section
- On macOS in Japanese locale, app names may be in Japanese (e.g. "計算機", "テキストエディット")
- **Do not translate to English** — use the actual name detected during analysis
- When a name is shown in "Current target app", use that exact name for the app field of open_app / activate_app / waitForElement

## Top-priority rule: always reference the available elements list
- Use "click_element" to click UI elements, specifying axRole (AXButton, AXTextField, etc.) and axTitle
- **Use the exact axRole and axTitle values shown in "Available elements"**
- Button labels in macOS apps may be in Japanese (e.g. "乗算", "計算実行", "加算"). Do not guess in English — copy the values exactly
- Elements not in the list are not available. Check the list before writing anything
- Use "type_text" for text input, "hotkey" for keyboard shortcuts, "press_key" for a single key
- One action per operation only

## When to use axValue instead of axTitle
Some elements have their visible text on the AX **value** attribute, not on title/description.
The "Available elements" list shows this as \`axValue="..."\` next to \`axRole="..."\`.
Examples: Calculator's result display, AXTextField current contents, AXSlider current numeric value.
- If the element line shows \`axValue="..."\`, use **axValue** (not axTitle) to target it: \`{"action": "click_element", "axRole": "AXStaticText", "axValue": "40,626"}\`
- Substring match: a partial axValue is fine (e.g. axValue: "40,626" matches a value like "‎40,626" with hidden bidi marks)
- You may combine axRole + axTitle + axValue when needed; the resolver uses all of them as filters

## Important: value genericity
- Do not hard-code user-specific values in the text field
- Values that come from the user should use the "ctx.input.<variable>" format
- When entering values from ctx.input, use the "type_text" action (do NOT click buttons individually)
  - ✅ Correct: {"action": "type_text", "text": "ctx.input.expression", "description": "Type expression on keyboard"}
  - ❌ Wrong: splitting the expression into single characters and clicking buttons one by one (doesn't work for dynamic values)

## Important: recipient / destination rules
- For email and Slack destinations, do not use dummy test addresses like test@example.com
- Always use the "ctx.input.<variable>" format

## ★★ Use AppleScript only for apps that have a dictionary ★★
AppleScript can only directly manipulate data in apps with a Scripting Dictionary.
If you run \`make new ...\` on a dictionary-less app, it fails with error -1728.

### ✅ Apps where AppleScript is the primary approach (allowlist)
- Apple first-party: Mail, Finder, Notes, Reminders, Calendar, Contacts, Messages, Safari, Preview, Keynote, Numbers, Pages, Music, Photos
- Microsoft Office: Word, Excel, PowerPoint, Outlook (2016+)
- Third-party: OmniFocus, Things, Fantastical, Hazel, BBEdit, DEVONthink, etc.

### ❌ Apps where AppleScript is NOT the primary approach
- Electron / Chromium-based apps: Slack, Discord, Notion, Figma, VS Code, Cursor, Zoom, Obsidian, Linear, Spotify, Claude Desktop, etc.
- Native apps without a dictionary, Mac App Store sandboxed apps
- For these, use the AX tree + hotkey + clipboard paste (only \`tell app to activate\` is OK)

For **creating / reading / updating data** in an app on the allowlist,
**always invoke osascript from a single \`shell\` action**. Do NOT plan any of these:
- ❌ UI chains like activate_app → click_element → type_text → press_key
- ❌ Patterns like Cmd+N or Cmd+T to create a new item, then focus the title field and type

### Correct example (create a new note in Notes)
\`\`\`json
{"actions": [
  {"action": "shell", "command": "osascript -e 'tell application \\"Notes\\" to make new note with properties {name:\\"ctx.input.title\\", body:\\"ctx.input.body\\"}'", "description": "Create new note in Notes"}
]}
\`\`\`

### Correct example (add reminder to Reminders)
\`\`\`json
{"actions": [
  {"action": "shell", "command": "osascript -e 'tell application \\"Reminders\\" to make new reminder with properties {name:\\"ctx.input.task\\"}'", "description": "Add reminder"}
]}
\`\`\`

### Wrong example (do NOT write it this way for allowlisted apps)
\`\`\`json
{"actions": [
  {"action": "activate_app", "app": "Notes"},                     ❌
  {"action": "hotkey", "keys": ["command", "n"]},                 ❌
  {"action": "click_element", "axRole": "AXTextField"},          ❌
  {"action": "type_text", "text": "Title"},                       ❌
]}
\`\`\`

## ★★★ Enter Japanese / non-ASCII text via clipboard paste ★★★
The type_text action is only safe for ASCII. Text containing Japanese (hiragana/katakana/kanji/emoji) is
broken by the IME because it turns type events into composition candidates. **Plan to enter such text via clipboard paste**:

Correct example:
\`\`\`json
{"actions": [
  {"action": "shell", "command": "printf '%s' 'ctx.input.content' | pbcopy", "description": "Copy body to clipboard"},
  {"action": "hotkey", "keys": ["command", "v"], "description": "Paste"}
]}
\`\`\`

Wrong example (type_text cannot handle Japanese):
\`\`\`json
{"actions": [
  {"action": "type_text", "text": "ctx.input.content"}  ❌ Japanese gets mangled by the IME
]}
\`\`\`

## ★★★ File Save dialogs: use Cmd+Shift+G with an absolute path ★★★
Using Cmd+D to jump to "Desktop" is unreliable. Plan to **open the "Go to folder" dialog with Cmd+Shift+G and paste an absolute path**:

\`\`\`json
{"actions": [
  {"action": "hotkey", "keys": ["command", "s"], "description": "Open Save dialog"},
  {"action": "wait", "seconds": 1.5},
  {"action": "hotkey", "keys": ["command", "shift", "g"], "description": "Open Go-to-folder dialog"},
  {"action": "wait", "seconds": 0.5},
  {"action": "shell", "command": "printf '%s' '/Users/USERNAME/Desktop' | pbcopy"},
  {"action": "hotkey", "keys": ["command", "v"]},
  {"action": "press_key", "key": "Return"},
  {"action": "wait", "seconds": 0.5},
  {"action": "hotkey", "keys": ["command", "a"], "description": "Select all in the existing filename"},
  {"action": "shell", "command": "printf '%s' 'output.txt' | pbcopy"},
  {"action": "hotkey", "keys": ["command", "v"]},
  {"action": "press_key", "key": "Return", "description": "Confirm save"}
]}
\`\`\`

### Correct action-plan example for composing email:
\`\`\`json
{
  "actions": [
    {"action": "shell", "command": "osascript -e 'tell application \\"Mail\\" to activate'", "description": "Activate Mail app"},
    {"action": "shell", "command": "osascript -e 'tell application \\"Mail\\" to make new outgoing message with properties {subject:\\"ctx.input.subject\\", content:\\"ctx.input.body\\", visible:true}' -e 'tell application \\"Mail\\" to tell first outgoing message to make new to recipient with properties {address:\\"ctx.input.to_address\\"}'", "description": "Compose email via AppleScript (set recipient, subject, body)"},
    {"action": "hotkey", "keys": ["command", "shift", "d"], "description": "Send the email"}
  ]
}
\`\`\`
**Never operate individual fields like this (unreliable):**
- ❌ Click the To field → type_text → Tab → Click the Subject field → type_text → ...
- ✅ Set everything at once via AppleScript

## ◆◆◆ Required rule: Cmd+K Quick Switcher action plan ◆◆◆
When opening Quick Switcher with Cmd+K to search, **always wait until candidates appear before pressing Return**.
Pressing Return when the candidate list is empty **falls through to the search screen and does not open the DM / channel**.
**codegen will automatically add verification logic (multiple candidate queries + AX-tree verification + retry).**

### DM-search action plan (follow this shape):
1. ai_resolve: convert the recipient name into **multiple candidate queries** (full name, surname only, romaji, original input)
2. hotkey: Cmd+K → open Quick Switcher
3. type_text: type the resolved search query
4. wait: 1.5s (**wait for candidates to appear**)
5. press_key: Return → select the top candidate (**codegen will add AX-tree verification**)
6. wait: 1.5s (**wait for the screen transition**)

★ Important: codegen will automatically add the following verification logic:
- Check the search-results list (AXList, AXGroup, AXCell, etc.) in the AX tree
- If 0 candidates, retry with a different search query
- If all queries fail, throw Error (including the list of attempted queries)

## ★★ When the AX tree is shallow (Electron / WebView apps) ★★
Even when the element list has an "AX tree is shallow" warning, **still use click_element (which tries to resolve coordinates from the AX tree)**.
At codegen time, the actual position is obtained from the AX tree, so specify the element via axRole/axTitle.

1. **Use click_element with axRole** (tries to resolve position even if the AX tree is shallow)
   - Input field: {"action": "click_element", "axRole": "AXTextField", "description": "Click the input field"}
   - Text area: {"action": "click_element", "axRole": "AXTextArea", "description": "Click the text area"}
   - If not found, codegen automatically falls back to window bounds

2. **Lean on keyboard shortcuts**
   - Search / jump: {"action": "hotkey", "keys": ["command", "k"]}
   - Send: {"action": "hotkey", "keys": ["command", "Return"]} ← plain Return sometimes inserts a newline instead
   - Select all: {"action": "hotkey", "keys": ["command", "a"]}

3. **Type text → send with Cmd+Return** (plain Return often just inserts a newline in messaging apps)
   - {"action": "type_text", "text": "ctx.input.message", "description": "Type message"}
   - {"action": "hotkey", "keys": ["command", "Return"], "description": "Send message"}

4. **click_position is a last-resort fallback** (when the AX tree cannot resolve the element)
   - Use the estimated coordinates from the "window bounds info" as a reference
   - {"action": "click_position", "x": <estimatedX>, "y": <estimatedY>, "description": "Click the input area (bounds fallback)"}
   - Always click twice as one set

## When information is missing
\`\`\`json
{"question": "question text", "infoKey": "storage key"}
\`\`\`

**However**: resolving an ambiguous recipient / name is handled with **ai_resolve**, NOT a question.
Only ask the user for things AI cannot infer (which app to use, which URL, etc.).

**Forbidden**: do **NOT** emit any of the following questions:
- Any question that mentions Windows/Linux procedures, e.g. "Do I open it from the Windows Start menu?"
- Any question asking which platform to run on, e.g. "Which OS should I run on?" (always assume macOS)
- Any question that asks about OS branching, e.g. "macOS version or Windows version?"`
}

function getBrowserActionPlanSystemPrompt(): string {
  return `You are an action planner for web automation.
Read the step instruction and identify the actions to execute on the page.
${buildRuntimeContext()}

## ★★★ Role boundary: you handle "strategy", codegen handles "implementation" ★★★
This system runs as a two-stage pipeline (actionPlan → codegen). The roles are strictly separated:

### Your responsibilities (actionPlanAgent)
- **Decide WHAT**: which element and with what intent to operate
- Pick the actions (goto / click / fill / press / select / wait / hover / scroll)
- Write the minimum info needed to identify the element: selectorHint / elementType / value
- Put the intent in the description (e.g. "click the search button")

### codegenAgent's responsibilities (= off-limits for you)
- The TypeScript Playwright code body (page.locator, waitFor, try/catch, retry logic)
- Fallbacks when an element is not found (getByRole → getByText → CSS selector)
- Assignments to ctx.shared.XXX (processing like JSON.parse on innerText() output)
- Loops when extracting data (\`page.locator('.item').allTextContents()\`, etc.)

### Do NOT include these in the output
- ❌ TypeScript/JavaScript code snippets ("await page.locator(...)", "const items = ...", etc.)
- ❌ Pseudo-code for loops or branches ("for each item: extract text")
- ❌ Implementation details in the description (do NOT write things like "waitForSelector for 10 seconds")
- ❌ Expanding iteration over multiple elements inside actions (do NOT list "click the 1st product", "click the 2nd product", ...). Emit a single action and let codegen's loop handle it.

### Write the actions array as if it were a step-by-step instruction for a human pressing buttons one at a time
Specific selector strings (CSS or XPath) are not needed — selectorHint can be a human-readable label or a role name.
codegen reads the page HTML and AX info to determine the actual selector.


## Output format
Return **only** the following JSON (no prose):
\`\`\`json
{
  "actions": [
    {"action": "goto", "url": "https://example.com", "description": "Navigate to the page"},
    {"action": "click", "description": "Click the login button", "selectorHint": "Login", "elementType": "button"},
    {"action": "fill", "description": "Enter the email address", "selectorHint": "email", "elementType": "input", "value": "user@example.com"},
    {"action": "press", "description": "Press Enter", "key": "Enter"},
    {"action": "select", "description": "Select an option", "selectorHint": "country", "elementType": "select", "value": "JP"},
    {"action": "wait", "description": "Wait for the page to load"},
    {"action": "scroll", "description": "Scroll the page"},
    {"action": "hover", "description": "Hover over the menu", "selectorHint": "Menu", "elementType": "button"}
  ]
}
\`\`\`

## Rules
- selectorHint: a hint that identifies the element — visible UI text, aria-label, placeholder, name attribute, etc.
- elementType: the kind of element: "button", "input", "link", "select", "textarea", "checkbox", "radio"
- For fill actions, value is the literal value to enter
- When you need to reference ctx.input.XXX or ctx.profile.XXX, write value as "ctx.input.XXX"
- For goto, url must be a full URL
- Carefully read the "Available selectors" list; selectorHint must match a text or label value shown there
- One action per operation only

## Important: value genericity
- Do not hard-code concrete values in the value field
- Values that require user input should use the "ctx.input.<variable>" format
- Examples: email address → "ctx.input.email", name → "ctx.input.name", URL → "ctx.input.target_url"
- Task-specific constants (the site URL, etc.) may be written directly
- Write abstractly so the plan works with different values on subsequent runs

## Important: when the step's purpose is already achieved
If the current page state already satisfies the step's purpose (e.g. the step is "navigate to the article page" and the browser is already on the article page), return an empty actions array:
\`\`\`json
{"actions": [], "alreadyDone": true, "reason": "The current page already satisfies the step's purpose"}
\`\`\`
This avoids unnecessary operations.

### ★★★ However, NEVER mark the following steps as alreadyDone ★★★
**Data-extraction / save steps** — assignments to \`ctx.shared.XXX\`, text extraction, file creation, and other "side-effect operations" — **must run at least once regardless of how the page looks**. Text being visible on screen does not mean anything is in \`ctx.shared\`.

Descriptions that MUST NOT be marked alreadyDone:
- "Extract the fortune body and store it in \`ctx.shared.fortuneContent\`"
- "Fetch the product list and save it to \`ctx.shared.items\`"
- "Read the page title and set it on \`ctx.shared.title\`"
- "Summarize the body and compose the email body", "... transform ...", "... convert ..."
- Any description containing "fetch", "extract", "store", "save", "create", "ctx.shared", or "ctx.ai" (or their Japanese equivalents)

If any of the above applies, "visible on the page" is not enough. Return at least one real data-extraction action like \`page.locator(...).innerText()\` or \`ctx.ai(...)\`.

## When information is missing
If the URL or search keyword is unknown, return the following JSON instead of actions:
\`\`\`json
{"question": "question text", "infoKey": "storage key"}
\`\`\``
}
