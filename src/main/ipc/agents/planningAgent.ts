// ─── Planning Agent ───
// Decomposes a task instruction into executable steps.
// Each step is tagged with type: 'browser' | 'desktop'.

import type { BrowserWindow } from 'electron'
import type { AiProviderConfig, StablePriorStep, StepPlan, VariableDefinition } from '../../../shared/types'
import { chatStream } from './aiChat'
import { sendAndLog } from './progressHelper'
import { renderKnowledgeBlock } from '../../knowledge'

/**
 * Render the existing-stable-steps context block that gets injected into the
 * planner's system prompt. The planner uses this to avoid replanning work
 * that's already in place — it should emit only the delta.
 *
 * Empty array → returns empty string (no block rendered). The regular
 * prompt kicks in unchanged, i.e. plan from scratch.
 */
function renderPriorStepsBlock(priorSteps: StablePriorStep[]): string {
  if (!priorSteps || priorSteps.length === 0) return ''

  const lines = priorSteps
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((s, idx) => {
      const produces = s.producedSharedKeys.length > 0
        ? ` — produces ctx.shared: ${s.producedSharedKeys.map(k => `ctx.shared.${k}`).join(', ')}`
        : s.producedSharedKeys.length === 0
          ? ' — produces ctx.shared: (none / UI side effects only)'
          : ''
      return `${idx + 1}. [${s.type}] ${s.name}: ${s.description}${produces}`
    })
    .join('\n')

  return `

## ★★★ Existing stable prior steps (NEVER re-plan these) ★★★

This task already has steps marked **stable** and completed. **They are already recorded in task.json and will always run from the top at execution time.** Your job is to plan only the **remaining delta that follows them**.

### Existing stable steps (in execution order)
${lines}

### Planning rules (MUST follow)
1. **Do not regenerate the steps above.** Do not put any side effects that are already performed above (e.g. "launch app", "fetch email list") at the start of your output \`steps\` array.
2. The \`ctx.shared.xxx\` values populated by existing steps are **already present as inputs to the first step you plan** — write your descriptions accordingly. For example, if an earlier step already populates \`ctx.shared.rawMessages\`, your first step may start with "read ctx.shared.rawMessages and ...".
3. If an "app launch" or "fetch" prior step already exists, do not add another type='desktop' app-launch step.
4. Decompose only the user-instruction work that is **not yet covered** by the existing steps.
5. If the user instruction is fully satisfied by the existing steps, return \`steps: []\` (an empty plan is interpreted as "no further work needed").
6. Each element of the output \`steps\` array is **only a newly added step**. Do not worry about order numbers or ids of existing steps (the caller appends your output after the existing steps).`
}

export async function planSteps(
  config: AiProviderConfig,
  win: BrowserWindow | null,
  taskId: string,
  instruction: string,
  priorStableSteps: StablePriorStep[] = [],
  goal?: string,
): Promise<{ plan: StepPlan[]; detectedVariables: VariableDefinition[]; planResult: { text: string; usage?: { totalTokens?: number } } }> {
  sendAndLog(win, taskId, {
    phase: 'planning',
    message: 'Decomposing task into steps...',
  })

  const planMessages = [
    {
      role: 'system',
      content: `You are a task-automation planner. Decompose the user's instruction into executable steps.

## ★★★ Target platform: macOS only ★★★
This system is **macOS only**. You must **never**:
- Reference Windows Start button / Start menu / taskbar / Explorer / Run dialog / cmd.exe / PowerShell / WSL / registry, etc.
- Reference Linux GNOME / KDE / Unity / apt / systemctl, etc.
- Output questions asking about the OS, like "Open the Windows version?" or "Which OS should I run on?"
- Use Windows shortcuts such as Win key, Ctrl+Esc, Alt+Tab (macOS uses Cmd+Tab), Win+R, etc.
- Ask the user which platform to execute on

Every step and every question must assume macOS. Even when the instruction is ambiguous, do not ask about the OS — pick the most natural macOS-native approach.
${goal ? `
## ★★★ Final deliverable / goal of this task ★★★
The ultimate goal of this task:
${goal}

Plan every step so that it contributes to this final deliverable.
If intermediate steps that only fetch "a list of links" or "a list of page URLs" would not satisfy the goal,
also plan steps that fetch the actual content (PDF body, sub-page details, etc.).
` : ''}
## Two step types
- **browser**: Web-browser automation (using Playwright). Browsing websites, filling forms, clicking, etc.
- **desktop**: macOS desktop automation. Launching and operating local apps, keyboard input, mouse operations, etc.

## How to decide the type
- Operating a website or web app (when any browser will do) → browser (Playwright launches Chromium)
- Operating a local app (Calculator, Finder, Terminal, Excel, Mail, etc.) → desktop
- Launching an app → desktop
- File operations → desktop
- When the instruction is ambiguous: if it's local-only, use desktop; if the web is required, use browser

## ★★★ Handling explicitly named apps ★★★
If the user **explicitly names a specific browser or local app**, choose **type: desktop** to drive that specific app.
- "open in Safari", "open in Chrome", "in Firefox" → desktop (a named browser is controlled as a desktop app, not via Playwright)
- "save to Notes", "add to Reminders" → desktop (prefer AppleScript)
- "enter into an Excel cell" → desktop (Excel has an AppleScript dictionary)

★ Use **browser type (Playwright) only when the user did NOT specify a particular browser**.
General phrasing like "look it up on the web", "search on Google", "fill in the form" is browser type.
If specific names like "in Safari" or "in Chrome" appear, drive **that named browser as a desktop-type step**.

★ Concrete AppleScript / shortcut templates for each target app are automatically injected at the bottom of
this prompt under the "🧠 App-specific knowledge (dynamic injection)" section based on what's detected in
the task text. Refer to that section.

## ★★★ Messaging / communication apps (app-agnostic) ★★★
For messaging apps (chat, video conferencing, social media, email, etc.), **prefer the macOS-installed desktop version** and use type: "desktop".
Do not hard-code a specific app name (Slack / Teams / Discord / LINE / etc.) at planning time. detectedAppName is resolved at runtime.

### Desktop messaging app operation strategy (general pattern)
Most messaging apps share this common skeleton:
1. **Launch the app**: start the app with open -a "<app name>" (step 1)
2. **Find the recipient**: use a Quick Switcher / search field to locate the recipient (step 2)
   - Shortcuts are app-dependent. **Do not hard-code one at planning time** — decide during the action-plan phase after inspecting the live AX tree / window title
   - See the "🧠 App-specific knowledge (dynamic injection)" section for app-specific shortcuts and forced-Quick-Switcher patterns
3. **Type and send the message**: focus the text input field → use desktop.type() to enter text → press Cmd+Return or Enter to send (the send key is also app-dependent)

### Auto-detecting messaging variables
- For message-sending tasks, always detect these variables:
  - recipient: the target user or channel name (put the user-specified value in default)
  - message: the message to send (put the user-specified value in default)

## Important: how to launch macOS apps
- **Never use Spotlight** (unstable — depends on language settings and search history)
- Use one of the following to launch an app:
  - Run \`open -a "AppName"\` as a shell command (most reliable)
  - Call the \`desktop.activateApp("AppName")\` API
- Example: to launch Calculator, run \`open -a "Calculator"\` via execSync

## Output format
Return only the following JSON object (no prose):
{
  "steps": [{"name": "step name", "description": "what exactly to do", "type": "desktop", "needsLogin": false}],
  "variables": [{"key": "variable name", "label": "display label", "type": "string", "required": true, "default": "value the user specified"}]
}

- steps: an array of execution steps
- variables: parameters detected from the user input. If the user specified a concrete value, put it in default. Empty array if there are no parameters.

Example (desktop: a calculator task that needs UI operation — 2 steps):
{
  "steps": [
    {"name": "Launch Calculator", "description": "Run open -a Calculator to launch Calculator and wait until its window appears", "type": "desktop"},
    {"name": "Run calculation", "description": "Type the expression in ctx.input.expression via the keyboard and press Enter to evaluate it", "type": "desktop"}
  ],
  "variables": [{"key": "expression", "label": "Expression", "type": "string", "required": true, "default": "12*333"}]
}

Example (desktop: data manipulation in a first-party Apple app — 1 side effect in 1 step):
{
  "steps": [
    {"name": "Add reminder", "description": "Run osascript 'tell application \\"Reminders\\" to make new reminder with properties {name:ctx.input.taskName, due date:...}' to add the task. post-condition: Reminders contains one new reminder named ctx.input.taskName (verify via the ID returned by AppleScript)", "type": "desktop"}
  ],
  "variables": [
    {"key": "taskName", "label": "Task name", "type": "string", "required": true, "default": "Dodompa smoke test"},
    {"key": "dueDate", "label": "Due date/time", "type": "string", "required": true, "default": "2026-04-10 10:00"}
  ]
}

Example (desktop: fetch + write must be split into 2 steps):
{
  "steps": [
    {"name": "Fetch PDF file list", "description": "Run find ~/Desktop/test-source -name '*.pdf' to obtain a list of filenames and store it in ctx.shared.pdfList. post-condition: ctx.shared.pdfList exists and is a string array", "type": "desktop"},
    {"name": "Create note in Notes", "description": "Use osascript to create a note in Notes titled 'PDF file list (YYYY-MM-DD)' whose body contains ctx.shared.pdfList as a bulleted list. post-condition: A new note with that title exists in Notes", "type": "desktop"}
  ],
  "variables": []
}

Example (desktop: pure shell — 1 step):
{
  "steps": [
    {"name": "Take screenshot", "description": "Capture the entire screen with screencapture -x and save it to ~/Desktop/screenshots/YYYY-MM-DD/NN.png", "type": "desktop"}
  ],
  "variables": []
}
Example (browser):
{
  "steps": [
    {"name": "Open Google", "description": "Navigate to https://google.com", "type": "browser"},
    {"name": "Run search", "description": "Enter ctx.input.keyword in the search box and submit", "type": "browser"}
  ],
  "variables": [{"key": "keyword", "label": "Search keyword", "type": "string", "required": true, "default": "Playwright"}]
}

## ★★★ Top-priority rule: preserve every concrete value from the user's instruction verbatim ★★★
If the instruction contains a **URL / email address / file path / proper noun / numeric value / date / specific keyword**,
you must NEVER "generalize", "summarize", or "transform" it. Preserve it via one of the following:

### A. Extract into variables (values that change per run)
Put user-input values (recipient, message body, search term, specific URLs, etc.) into variables,
and **copy the value from the instruction verbatim into default**:
\`\`\`json
{
  "variables": [
    {"key": "target_url", "label": "Target URL", "type": "string", "required": true, "default": "https://ja.wikipedia.org/wiki/macOS"},
    {"key": "recipient", "label": "Recipient", "type": "string", "required": true, "default": "Tanaka-san"}
  ]
}
\`\`\`
Then reference \`ctx.input.target_url\` in the description.

### B. Embed directly in description (task-specific constants)
Values that will never change per run (app name to launch, menu item to open, etc.) should be written directly in the description.

### ★★★ Anti-patterns you must avoid ★★★
- ❌ **Abstracting a URL as "the macOS Wikipedia page"** → the codegen AI will hallucinate a different URL (en.wikipedia, etc.)
- ❌ **Generalizing a person's name as "the assignee" or "the other party"** → later steps lose track of who it refers to
- ❌ **Leaving a date as a relative expression like "tomorrow" or "next week"** → solvable in JS but error-prone
- ❌ **Leaving \`default\` as an empty string** → the test run during generation always fails
- ❌ **Using placeholder values like \`https://example.com\` or \`test@example.com\` in \`default\`** → they will actually be visited / sent to

### ✅ Correct handling examples
Instruction: "Open https://ja.wikipedia.org/wiki/macOS in Safari and ..."
→ Put \`{"key": "target_url", "default": "https://ja.wikipedia.org/wiki/macOS"}\` in variables,
   and write the description as "Open ctx.input.target_url in Safari and fetch the page title."
→ Do NOT summarize the URL string in the step description.

Instruction: "Calculate 12 × 333"
→ Put \`{"key": "expression", "default": "12*333"}\` in variables,
   and write the description as "Evaluate the expression in ctx.input.expression in Calculator."

Instruction: "Email test@example.com" (fake-address warning)
→ test@example.com is fake, so do NOT put it in default. Consider adding a step that asks the user for confirmation.

## Top-priority rule: default-value safety
- For recipient parameters (email address, Slack destination, message destination, etc.), **use the actual address the user specified as the default**
- If the user specified a recipient (e.g. "send to fukuda@autoro.io"), put it in default
- If the user did NOT specify a recipient, do not leave default empty — consider adding a step that asks the user for confirmation
- **Do not use fake addresses like test@example.com** — they will actually be sent to during test runs
- Same for Slack channel names or user names: use the real value the user specified, not a placeholder

## ★★★ How to decide the number of steps: 1 step = 1 side effect + 1 post-condition ★★★

Step granularity is determined by the number of **side effects**. A side effect is an observable change to the outside world:
- Create / update / delete a file or directory
- CRUD operations on app data (create a note, add an event, send an email, etc.)
- Network communication (HTTP request, API call)
- UI transitions (launch a window, switch screens, move focus)
- Save (persistence commands such as \`save in POSIX file\`)
- Data fetching (strictly speaking not a side effect, but the unit that produces a verifiable artifact = ctx.shared.xxx is counted as 1 side effect)

### Basic rule
**Each step must contain only one kind of side effect.** Each step must have a verifiable post-condition of its own (file existence / ctx.shared value / window-title change / AppleScript return value). If you cannot write a post-condition, that's a sign the granularity is too coarse.

The goal: "each generated step can be regenerated as the smallest unit during debugging." When multiple side effects are mixed, one failure forces regeneration of everything, driving debugging cost sharply up.

### Always separate reads and writes
- **Fetch step**: fetch data and store it in \`ctx.shared.xxx\`
- **Write step**: read \`ctx.shared.xxx\` and mutate the outside world
- Even when using the same AppleScript-dictionary app, fetches (\`get\` / \`return source of\` / \`list\`) and writes (\`make new\` / \`set\` / \`save\`) must go in **separate osascript calls = separate steps**
- Rationale: an error on the write side (-1728 / -10006 / permission error, etc.) should not drag the fetch logic into regeneration

### Cases that are fine as a single step (only 1 side effect)
- "Add a reminder to Reminders due tomorrow at 10:00" → 1 step (only make new reminder)
- "Create an event in Calendar" → 1 step (only make new event)
- "Create a new note in Notes and set its body" → 1 step (make new note + set body count as the same side effect)
- "Take a screenshot and save it to ~/Desktop/xxx.png" → 1 step (only screencapture)
- "Resize images in a folder" → 1 step (only sips)
- "GET a specific URL and store the JSON in ctx.shared" → 1 step (only the fetch)

### Cases that MUST be split (2 or more side effects)
- ❌ "Create and save a document in TextEdit" → **2 steps**
  - (1) \`make new document\` + set body → post-condition: a front document exists
  - (2) \`save in POSIX file\` → post-condition: the file exists at ~/Desktop/xxx.txt
  - Rationale: a path / permission error on save must not drag the body-generation logic into regeneration
- ❌ "Fetch a PDF file list and write it to Notes" → **2 steps**
  - (1) Use find/ls to get the list → store in ctx.shared.pdfList
  - (2) Write ctx.shared.pdfList to Notes via make new note
- ❌ "Open a page in Safari, fetch its title, and save it to Notes" → **3 steps**
  - (1) Open the URL in Safari (UI transition)
  - (2) Fetch the title via AppleScript → ctx.shared.pageTitle
  - (3) make new note in Notes
- ❌ "Fetch search results from Mail and save as CSV" → **2 steps** (fetch + file write)
- ❌ "Read Excel cells and write aggregated results to another file" → **2 steps** (read + write)

### Apps that need UI exploration (Electron / non-dictionary native apps)
For Slack / Discord / Teams / Notion, etc., continue splitting by side effect as usual: "launch app → find recipient → type message".

### ★ The description MUST include a post-condition (required) ★
**Every step's description must end with "post-condition: ~".** This is the primary signal verifyAgent uses for pass/fail — omitting it makes it easier for a failing step to be wrongly judged as success.

Format: \`<what to do> post-condition: <verifiable state>\`

A post-condition is one of the following **objectively verifiable states**:
- File/directory existence or content (e.g. "~/Desktop/xxx.txt exists and its content matches ctx.input.content")
- ctx.shared value (e.g. "ctx.shared.pdfList exists and is a non-empty string array")
- Window title / foreground app (e.g. "Safari's front window title is the page title of ctx.input.target_url")
- App-side data (e.g. "Reminders contains exactly one reminder named ctx.input.taskName")
- Page navigation (e.g. "The browser URL is https://example.com")

❌ Examples of vague post-conditions (do NOT write these):
- "The operation completes successfully" (what should we inspect to confirm?)
- "No errors occur" (unverifiable)
- "The screen updates" (unclear what updates)

✅ Good examples:
- "Navigate to https://example.com and load the page. post-condition: The browser URL is https://example.com and the page's h1 element text is 'Example Domain'"
- "Evaluate the expression in ctx.input.expression in Calculator. post-condition: The computed numeric result is shown on the Calculator display"

### ★★★ Post-conditions for data-fetch steps: specify data quality ★★★
For information-gathering or scraping steps, the post-condition must include a **data-quality condition**.
"ctx.shared.xxx exists" is not enough on its own. The condition must state that the extracted data contains the **substantive information required by the final deliverable**.

❌ Bad examples:
- "ctx.shared.items contains an array" (passes even with URLs or link text alone)
- "ctx.shared.details is non-empty" (passes even with titles alone)

✅ Good examples:
- "Each element of ctx.shared.details contains substantive fields such as tender name, deadline, bidding eligibility, etc. (URL or link text alone is insufficient)"
- "Each element of ctx.shared.products has name, price, and description fields, and description is at least 10 characters long"

### ★★★ Plan for fetching the content behind each link ★★★
If web-page information has a hierarchical structure like "list page → detail pages" or "list page → PDFs":
1. A step that fetches the list of links/URLs from the list page
2. A step that fetches the actual data from each linked detail page / PDF
Plan **both**. A plan that ends after fetching just the link text on the list page is incomplete.

### Common rules
- needsLogin: true displays a login prompt to the user (used for browser)
- **★ Set needsLogin only on the one step that first requires authentication within a given browser session.** Subsequent steps run in the same Playwright context (sharing cookies / localStorage), so login state is preserved automatically. Setting true on two or more steps pops a login dialog on every step and breaks the UX.
- **★ Do not set needsLogin on a step that only visits about:blank (i.e. right after the browser starts)**. Put it on the step that performs goto() to an actually-authenticated URL.
- "Tasks that use a site requiring login (github.com / slack.com / notion.so, etc.)" = set needsLogin: true **on only the first page-opening step for that site**
- Do not set needsLogin on desktop steps (it is ignored when type: "desktop")
- A single task may mix browser and desktop steps
- **For tasks that have no target app** (pure file manipulation, shell commands, date calculation, screen capture, etc.), **do not add an "app launch" step**. Tasks that don't open any app don't need a launch step.
- **No placeholder-named steps**: do not create a step like "Launch the app" or \`open -a "App"\` with no concrete app name decided
- **Beware over-splitting**: do not mechanically separate "launch app" and "run command" when there is only 1 side effect. For example, \`make new reminder\` inside a tell block also activates the app, so 1 step is sufficient. The decision criterion is **the number of side effects**, not the number of CLI invocations.${renderKnowledgeBlock({ taskDescription: instruction })}${renderPriorStepsBlock(priorStableSteps)}`,
    },
    {
      role: 'user',
      content: `Instruction: ${instruction}${goal ? `\n\nFinal deliverable / goal: ${goal}` : ''}`,
    },
  ]

  const planResult = await chatStream(config, planMessages, (delta) => {
    sendAndLog(win, taskId, {
      phase: 'planning',
      message: '',
      streamDelta: delta,
    })
  })

  let plan: StepPlan[]
  let detectedVariables: VariableDefinition[] = []
  let planParseMethod = 'json'
  try {
    // Try new format: {"steps": [...], "variables": [...]}
    const objMatch = planResult.text.match(/\{[\s\S]*\}/)
    const parsed = JSON.parse(objMatch?.[0] ?? planResult.text)
    if (parsed.steps && Array.isArray(parsed.steps)) {
      plan = parsed.steps as StepPlan[]
      if (parsed.variables && Array.isArray(parsed.variables)) {
        detectedVariables = parsed.variables.map((v: Record<string, unknown>) => ({
          key: String(v.key || ''),
          label: String(v.label || v.key || ''),
          type: (v.type === 'number' || v.type === 'secret') ? v.type : 'string',
          required: v.required !== false,
          default: v.default != null ? String(v.default) : undefined,
        })).filter((v: VariableDefinition) => v.key)
      }
    } else if (Array.isArray(parsed)) {
      // Legacy format: [steps]
      plan = parsed as StepPlan[]
    } else {
      throw new Error('Unexpected JSON shape')
    }
  } catch {
    planParseMethod = 'fallback'
    if (priorStableSteps.length > 0) {
      // Delta mode: we can't safely fabricate a single-step fallback because we
      // don't know what the existing pipeline already does. Fall back to an
      // empty plan and let the caller surface the parse failure.
      plan = []
      sendAndLog(win, taskId, {
        phase: 'planning',
        message: `⚠️ Failed to parse AI response as JSON (delta mode) — continuing with 0 additional steps`,
      }, JSON.stringify({ rawResponse: planResult.text.slice(0, 1000) }, null, 2))
    } else {
      // Generic classifier: if the instruction references a local app, file,
      // folder, or any macOS desktop concept, route to desktop. Avoid listing
      // specific app names — new apps should work without updating this regex.
      const looksDesktop = /\bアプリ\b|デスクトップ|ローカル|ファイル|フォルダ|open\s+-a|\bapp\b|application|desktop|\bopen\s+[a-z]|\.app\b|bundle|cmd\s*\+|command\s*\+|\bhotkey\b|起動|開い|launch/i.test(instruction)
        // Also accept if the instruction mentions http(s) — NOT desktop
        && !/https?:\/\//.test(instruction)
      plan = [{ name: 'Run task', description: instruction, type: looksDesktop ? 'desktop' : 'browser' }]
      sendAndLog(win, taskId, {
        phase: 'planning',
        message: `⚠️ Failed to parse AI response as JSON — falling back (type: ${looksDesktop ? 'desktop' : 'browser'})`,
      }, JSON.stringify({ rawResponse: planResult.text.slice(0, 1000), fallbackPlan: plan }, null, 2))
    }
  }

  // Remove spurious "launch placeholder app" steps. When the next step is a
  // pure shell/AppleScript operation that doesn't need a launched UI app, the
  // AI still tends to insert a generic "アプリを起動" / "open -a アプリ" first
  // step as a habit from Calculator-style examples. This adds a step that
  // always fails ("Unable to find application named 'App'") and burns retries.
  plan = plan.filter((step, idx) => {
    const isLast = idx === plan.length - 1
    if (isLast) return true
    const desc = (step.description + ' ' + (step.name ?? '')).toLowerCase()

    // Detect placeholder-launch step: contains "open -a" AND the app name is
    // generic (アプリ / app / 対象アプリ) OR matches a quoted string that
    // doesn't look like a real app name.
    const isPlaceholderLaunch = /open\s+-a\s+["'「]?(アプリ|app|application|対象アプリ|the app)["'」]?/i.test(desc)
      || (/起動/.test(desc) && /アプリ|app/i.test(desc) && !/(mail|notes|reminders|calendar|contacts|messages|finder|safari|keynote|numbers|pages|music|photos|terminal|calculator|スラック|slack|discord|teams|メモ|リマインダー|カレンダー|連絡先|メッセージ|メール|ファインダー|写真|計算機|ターミナル)/i.test(desc))

    if (isPlaceholderLaunch) {
      // Check if the next step is a pure shell/script task that doesn't need UI launch
      const next = plan[idx + 1]
      const nextDesc = (next.description + ' ' + (next.name ?? '')).toLowerCase()
      const nextIsShellOnly =
        // English CLI keywords
        (/execfile|shell|sh\s+-c|\bfind\b|\bls\b|\bmv\b|\bcp\b|\brm\b|mkdir|stat|sips|screencapture|pbcopy|pbpaste|curl|wget|tar|zip|jq|awk|sed|grep|\bdate\b/i.test(nextDesc)
         // Japanese keywords that strongly imply filesystem/shell ops (no UI interaction)
         || /ファイル|フォルダ|ディレクトリ|アーカイブ|移動|コピー|削除|リネーム|検索|一覧取得|作成.*(フォルダ|ファイル)|保存|日付計算|リサイズ|圧縮|展開|スクリーンショット|スクリーンキャプチャ|クリップボード|ダウンロード|url|http|api/i.test(nextDesc))
        // Exclude cases where the "shell keyword" is actually about UI app operation
        && !/アプリ\s*(の|を)\s*(操作|画面|ウィンドウ|起動)/.test(nextDesc)
        && !/\b(click|type|hotkey|キーボード入力|クリック|入力欄|送信ボタン|メニュー)\b/i.test(nextDesc)
      if (nextIsShellOnly) {
        return false // drop this placeholder launch step
      }
    }
    return true
  })

  // Auto-split single step into 2 ONLY when the single step clearly needs
  // both a UI launch AND a UI interaction. If the single step is pure shell,
  // AppleScript on an allowlist app, or a browser goto, do NOT split — single
  // step is the correct shape.
  //
  // Skip entirely in delta mode: when regenerating an already-partly-built
  // task, the existing stable steps almost always include the app launch,
  // so adding a fresh "open -a XYZ" in front of the new step would duplicate
  // the launch and shuffle the execution order.
  if (plan.length === 1 && priorStableSteps.length === 0) {
    const single = plan[0]
    const stepType = single.type ?? 'browser'
    const desc = (single.description + ' ' + (single.name ?? '')).toLowerCase()

    // Patterns that are inherently 1-step — do NOT split these
    const isPureShellEn = /\b(execfile|shell|sh\s+-c|find|ls|mv|cp|rm|mkdir|stat|sips|screencapture|pbcopy|pbpaste|curl|wget|tar|zip|jq|awk|sed|grep|date)\b/i.test(desc)
    const isPureShellJa = /ファイル|フォルダ|ディレクトリ|アーカイブ|移動|コピー|削除|リネーム|検索|一覧取得|保存|リサイズ|圧縮|展開|スクリーンショット|スクリーンキャプチャ|クリップボード|ダウンロード|日付計算|url|http|api/i.test(desc)
      && !/\b(click|type|hotkey|キーボード入力|クリック|入力欄|送信ボタン|メニュー)\b/i.test(desc)
      && !/アプリ\s*(の|を)\s*(操作|画面|ウィンドウ|起動)/.test(desc)
    const isPureShell = isPureShellEn || isPureShellJa
    const isAppleScriptOp = /osascript|tell application|make new|applescript/i.test(desc)
    const isSimpleGoto = stepType === 'browser' && /https?:\/\/[^\s]+/.test(desc) && !/フォーム|クリック|入力|検索|fill|click|submit|type/i.test(desc)
    const isAllowlistAppData = stepType === 'desktop'
      && /(mail|notes|reminders|calendar|contacts|messages|finder|safari|keynote|numbers|pages|music|photos|textedit|preview|メモ|リマインダー|カレンダー|連絡先|メッセージ|メール|ファインダー|写真|計算機|calculator|テキストエディット|プレビュー)/i.test(desc)
      && /(作成|追加|登録|取得|読み取り|削除|更新|get|make|set|add|create|read|list|delete|update|fetch|入力|保存|書き込み|record|save|write)/i.test(desc)

    if (isPureShell || isAppleScriptOp || isSimpleGoto || isAllowlistAppData) {
      // Leave as single step — this is the correct shape.
    } else if (stepType === 'desktop') {
      const appMatch = single.description.match(/(?:open\s+-a\s+"?([^"]+)"?|(\w+)(?:アプリ|を起動|を開))/i)
      const appName = appMatch?.[1] || appMatch?.[2]
      // ★ Never split with a generic placeholder name. If we couldn't extract
      // a real app name, that means this task doesn't actually need to launch
      // a specific app — leave it as one step and let the codegen handle it.
      if (!appName || /^(アプリ|app|application|対象アプリ)$/i.test(appName)) {
        // Leave as single step.
      } else {
        plan = [
          { name: `Launch ${appName}`, description: `Run open -a "${appName}" to launch ${appName} and wait until its window appears`, type: 'desktop' },
          { name: single.name || 'Run operation', description: single.description, type: 'desktop' },
        ]
      }
    } else {
      plan = [
        { name: 'Open page', description: `Navigate to the target web page`, type: 'browser' },
        { name: single.name || 'Run operation', description: single.description, type: 'browser' },
      ]
    }
  }

  // Normalize step types
  for (const step of plan) {
    if (step.type !== 'browser' && step.type !== 'desktop') {
      const desc = (step.description + ' ' + step.name).toLowerCase()
      // App-agnostic heuristic — don't list specific apps.
      const isDesktop = /アプリ|desktop|デスクトップ|ローカル|open\s+-a|\.app\b|hotkey|起動|launch|ファイル|フォルダ/i.test(desc)
        && !/https?:\/\//.test(desc)
      step.type = isDesktop ? 'desktop' : 'browser'
    }
  }

  const browserCount = plan.filter(s => s.type === 'browser').length
  const desktopCount = plan.filter(s => s.type === 'desktop').length
  const typeLabel = desktopCount > 0 && browserCount > 0
    ? `(🖥️ desktop: ${desktopCount}, 🌐 browser: ${browserCount})`
    : desktopCount > 0 ? '(🖥️ Desktop)' : '(🌐 Browser)'

  sendAndLog(win, taskId, {
    phase: 'planning',
    message: `Planned ${plan.length} step${plan.length === 1 ? '' : 's'} ${typeLabel}`,
    plan,
  }, JSON.stringify(plan, null, 2))

  return { plan, detectedVariables, planResult }
}
