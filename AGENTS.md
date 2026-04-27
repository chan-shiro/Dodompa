# Dodompa — Full-code RPA for AI

> 🇯🇵 日本語版: [AGENTS.ja.md](AGENTS.ja.md)

## Project purpose

Dodompa is **RPA designed for an AI-native workflow**. Having the LLM redo the same task every time is inefficient — in tokens, latency, and reliability. So Dodompa takes a hybrid approach: **whatever can run deterministically is written out as real RPA (full code), and the LLM is only called when a genuine decision is needed.**

- **First run**: natural-language instruction → AI decomposes it → generates real TypeScript → executes → self-heals until it works.
- **Subsequent runs**: the generated TypeScript steps execute directly (no LLM calls). Deterministic, fast, free.
- **In-code decisions**: call `ctx.ai("...")` from the generated code, or ask the user. Example: "which email address is 'John'?", "which of these ambiguous search results is right?"
- **Self-healing**: when a stable step fails, AI diagnoses the cause → edits the code → retries.

### Why full code?

No-code / visual RPA tools are self-contained in their workflow editor, but as soon as you need real logic (branching, error handling, third-party APIs, data shaping, loops) you hit a ceiling. Because Dodompa's output is a plain TypeScript file, a human can read it, `Edit` it, diff it in Git, and import libraries. The ideal: AI writes the draft, a human tweaks it when needed.

### MCP relationship (important)

Dodompa exposes MCP via **two audiences × two transports**. Don't mix them up.

**End-user facing — task-level control (`task_list`, `task_run`, `task_create`, `task_generate`, `task_refactor`, `execution_logs`, …):**

- **In-process streamable-HTTP (primary)** — hosted by the Electron app itself at `http://127.0.0.1:19876/mcp`. Tool code lives in `src/main/mcp/tools.ts` and calls IPC handlers / the DB directly, so there is no self-proxy round-trip. Claude Code and other MCP clients with streamable-HTTP support can use this with a one-line config. **The Dodompa app must be running.**
- **Stdio bridge (`mcp/src/stdio-bridge.ts`)** — thin transport-level proxy for MCP clients that only speak stdio (notably Claude Desktop). It forwards JSON-RPC messages between stdio and `/mcp`. No tool definitions live here; adding a new tool means editing `src/main/mcp/tools.ts` only.
- **`mcp/src/production.ts`** — legacy stdio implementation that predated the in-process server. Still functional (each tool manually re-implemented on top of `/ipc/:channel` + `/db/query`), but deprecated; prefer streamable-HTTP or the stdio bridge.

**Developer facing — low-level macOS primitives (`list_windows`, `get_accessibility_tree`, `click`, `hotkey`, `screenshot`, …):**

- **`mcp/src/index.ts` — desktop MCP (dev/debug only).** For people developing Dodompa itself to verify "is this AX tree captured correctly?" / "does this coordinate click register?" interactively from Claude Code. Not intended for end users.

Regardless of which server / transport is used, **Dodompa's internal task generation and execution pipeline does not route through MCP.** To drive Calculator it calls the `dodompa-ax` Swift CLI directly; to drive a browser it calls `playwright-core` directly. MCP is a *control surface exposed to Claude*, not a data path inside Dodompa.

- **Do not depend on MCP when writing new core logic.** Implement it inside Dodompa, and if helpful expose the same thing via a thin CLI / bridge layer that MCP can also call.
- **When adding a new end-user MCP tool**, edit `src/main/mcp/tools.ts`. It is automatically served over both streamable-HTTP and (via the bridge) stdio.

### Design philosophy

- **Use AI fully on first generation** — from task decomposition through action planning to code gen.
- **Minimize AI usage on reruns** — run the generated code as-is. Efficient for repeat work.
- **Only use AI for analysis and repair when things break**.
- **Prefer API integration, fall back to UI operation** — use APIs (mail, Slack API, etc.) when possible. Since credential persistence isn't implemented yet, the fallback UI paths (browser / desktop) are currently the primary surface.
- **Use AI to resolve ambiguity** — e.g. "recipient: John" → match `john@autoro.io`. If confidence is low, ask the user.

### Core principle: no hardcoding, stay generic

**Do not embed app-specific, OS-specific, or locale-specific hardcoding in prompts or code.** Dodompa should work on first generation even with apps it has never seen.

- ❌ **Banned**: `windows.find(w => w.app === 'Slack')` — Japanese locale shows `'メッセージ'`, not `'Slack'`.
- ❌ **Banned**: enumerating specific app names in prompts (`/calculator|finder|slack|teams|discord/i`) — unknown apps fall through.
- ❌ **Banned**: maintaining a static AppleScript allowlist — new apps stop working.
- ❌ **Banned**: locking in "Cmd+K = Quick Switcher" at action-plan time (Teams uses Ctrl+G, Notion uses Cmd+P).
- ✅ **Right**: bundleId first, then `w.app` partial match, then include the detected Japanese name.
- ✅ **Right**: run `sdef <app-path>` at runtime to **dynamically** detect AppleScript Dictionary support.
- ✅ **Right**: decide action plans based on the live AX tree / window title.

See also "Desktop automation strategy" and "Failure-diagnosis pipeline" below.

### Two automation modes

- **Browser automation** — drive websites with Playwright (login, form fill, scraping, etc.).
- **Desktop automation** — drive native apps via macOS Accessibility API + keyboard/mouse control.

## Tech stack

| Layer | Tech |
|-------|------|
| App shell | Electron |
| UI | React + TypeScript + Tailwind CSS + i18next |
| Browser automation | Playwright (`playwright-core`) |
| Desktop automation | Swift CLI (`dodompa-ax`) + AppleScript + Python/Quartz |
| AI integration | Vercel AI SDK (`ai` + `@ai-sdk/anthropic` + `@ai-sdk/openai` + `@ai-sdk/google`) |
| Local DB | SQLite (`better-sqlite3`) |
| Build | electron-vite |

## Directory layout

```
src/
├── main/                          # Electron main process
│   ├── index.ts                   # Entry point
│   ├── db.ts                      # SQLite connection + schema
│   ├── ipc/
│   │   ├── aiAgent.ts             # AI autonomous-generation orchestrator (wires all agents)
│   │   ├── agents/                # Role-specific AI agents
│   │   │   ├── index.ts           # Barrel export
│   │   │   ├── aiChat.ts          # AI chat utility (streaming / non-streaming)
│   │   │   ├── progressHelper.ts  # Progress events + DB logging
│   │   │   ├── planningAgent.ts   # Task → step decomposition
│   │   │   ├── analyzingAgent.ts  # Page / desktop analysis (screenshot + AX tree)
│   │   │   ├── actionPlanAgent.ts # Action-plan generation
│   │   │   ├── selectorAgent.ts   # Selector / AX element resolution + validation
│   │   │   ├── codegenAgent.ts    # TypeScript code generation
│   │   │   ├── verifyAgent.ts     # Post-execution AI verification (before/after screenshot)
│   │   │   ├── replanAgent.ts     # Step replan on persistent failure
│   │   │   └── buildLanguageDirective.ts  # Respond-in-user-language suffix
│   │   ├── aiService.ts           # AI provider abstraction (Vercel AI SDK)
│   │   ├── taskRunner.ts          # Task execution engine
│   │   ├── profileManager.ts      # Browser profile management
│   │   ├── settingsManager.ts     # Settings storage (electron-store-ish)
│   │   └── desktopService.ts      # Desktop automation IPC
│   ├── knowledge/                 # App-specific prompt knowledge (markdown, injected at runtime)
│   └── desktop/
│       ├── platform.ts            # Platform detection
│       ├── mac/                   # macOS DesktopContext
│       └── win/                   # Windows stub
│
├── renderer/                      # React frontend
│   ├── pages/
│   │   ├── TaskList.tsx
│   │   ├── TaskDetail.tsx
│   │   ├── TaskGeneration.tsx     # AI generation screen (live log stream)
│   │   ├── LogViewer.tsx
│   │   └── Settings.tsx
│   ├── i18n/                      # react-i18next setup + en/ja JSON namespaces
│   └── lib/
│       ├── api.ts                 # IPC-bridge wrappers
│       └── types.ts
│
├── preload/index.ts               # contextBridge
└── shared/types.ts                # Shared types (main + renderer)

native/macos/dodompa-ax/            # Swift CLI (Accessibility API)

mcp/                               # MCP bridges & dev server
    ├── src/stdio-bridge.ts        # stdio → http://127.0.0.1:19876/mcp proxy (Claude Desktop)
    ├── src/production.ts          # legacy stdio task-level MCP (deprecated)
    └── src/index.ts               # desktop MCP (AX primitives, dev/debug only)

src/main/mcp/                      # In-process MCP server (served at /mcp on :19876)
    ├── index.ts                   # HTTP transport + session management
    ├── tools.ts                   # Tool registrations (the canonical source of truth)
    └── bridge.ts                  # invokeIpc / emitIpc / dbQuery — direct in-process calls

tasks/{taskId}/                    # User task data (created at runtime)
    ├── task.json
    ├── step_01_*.ts
    └── screenshots/
```

## Development rules

### Git commits

- **Only commit when the user explicitly asks for it.** Don't commit proactively, and don't ask "shall I commit?" — wait for instructions.
- Same for push — only with explicit instruction.

### Debugging / fixing tasks

- **Do not edit generated step code (`step_*.ts`) directly.**
- If a task misbehaves, improve the AI agents' prompts or logic (planningAgent, codegenAgent, actionPlanAgent, analyzingAgent, etc.) so the app itself generates the right code next time.
- Find the root cause and fix it in a way that generalizes to similar cases.
- Using MCP tools to directly drive the desktop is for **debugging / verification only** — actual fixes must land in the app's code.

## Build and run

```bash
# Install dependencies
pnpm install

# Build the Swift CLI (macOS only, first run only)
sh scripts/build-ax.sh

# Dev mode
pnpm dev

# Production build
pnpm build
```

## Connecting MCP clients to Dodompa (end-user)

Task-level tools (`task_list` / `task_run` / `task_generate` / …) are served by the Electron app itself at `http://127.0.0.1:19876/mcp` whenever Dodompa is running. Pick the recipe that matches your client:

### Claude Code (streamable-HTTP — recommended)

```bash
claude mcp add --transport http dodompa http://127.0.0.1:19876/mcp
```

Or add to the Claude Code config manually:

```json
{
  "mcpServers": {
    "dodompa": {
      "type": "http",
      "url": "http://127.0.0.1:19876/mcp"
    }
  }
}
```

No script path. Tools stay in sync with the running app — restart Dodompa to pick up new tools.

### Claude Desktop (stdio bridge)

Claude Desktop's custom connector UI currently rejects plain `http://` URLs, so use the stdio bridge. Build it once:

```bash
pnpm -C mcp build
```

Then add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dodompa": {
      "command": "node",
      "args": ["/absolute/path/to/Dodompa/mcp/dist/stdio-bridge.js"]
    }
  }
}
```

The bridge is a transport-level proxy (~80 lines) that forwards JSON-RPC between stdio and `:19876/mcp`. Tool definitions live in the Electron app only (`src/main/mcp/tools.ts`).

### Verifying the endpoint

```bash
curl -s http://127.0.0.1:19876/health   # {"ok": true, "pid": ...}
```

If this fails, Dodompa isn't running.

## Debugging with the desktop MCP server (recommended)

Dodompa's desktop-automation surface can be **tested and debugged directly from Claude Code / Claude Desktop via the dev/debug MCP server (`mcp/src/index.ts`)**. This is the most efficient dev loop. (The separate production MCP at `mcp/src/production.ts` is described in the MCP relationship section above — it is for task-level control, not the low-level primitives below.)

### Setup

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dodompa-desktop": {
      "command": "/path/to/npx",
      "args": ["-y", "tsx", "/path/to/Dodompa/mcp/src/index.ts"]
    }
  }
}
```

### Available MCP tools

| Tool | Description |
|------|-------------|
| `list_windows` | List open windows (PID, app name, title) |
| `get_accessibility_tree` | Dump the app's AX tree (role, title, path, position) |
| `find_elements` | Search the AX tree (role + title) |
| `element_at_point` | Get the element at a coordinate |
| `perform_action` | Execute an AX action (AXPress, etc.) |
| `click` / `double_click` / `right_click` | Mouse click |
| `type_text` | Type text |
| `hotkey` | Shortcut (e.g. `command+c`) |
| `press_key` | Single key |
| `screenshot` | Screen capture |
| `activate_app` | Bring an app to the foreground |
| `open_app` | Launch an app (`open -a`) |
| `run_shell` | Run a shell command |
| `wait_for_element` | Wait for an element to appear |
| `click_element` | Find element → click |

### Typical debug flow (Calculator button)

```
1. list_windows — find Calculator's PID
2. get_accessibility_tree — find a button's role/title/path
3. find_elements — narrow to the specific button
4. perform_action or click — drive it
5. screenshot — verify
6. fix the code if something's off
```

Verify the behavior via MCP first, then fold the fix back into the app code (`aiAgent.ts`, etc.). This lets you test internals interactively without launching the Electron UI.

### Self-debugging via MCP (generation / execution introspection)

While Dodompa is running, `electron_db_query` and `electron_ipc` let you inspect internal state directly. Every phase's output (action plan, resolved selectors, generated code, error history) is saved as JSON in `generation_step_logs.detail`.

#### Handy debug queries

```sql
-- Most recent task-generation logs (20 rows)
SELECT phase, message, detail, created_at
FROM generation_step_logs
ORDER BY created_at DESC LIMIT 20;

-- Full flow for a specific task
SELECT phase, message, substr(detail, 1, 200) as detail_preview, created_at
FROM generation_step_logs
WHERE task_id = 'TASK_ID'
ORDER BY created_at ASC;

-- Errors only (fixing phase = retry occurred)
SELECT message, detail, created_at
FROM generation_step_logs
WHERE phase = 'fixing'
ORDER BY created_at DESC LIMIT 10;

-- Generated code (generating phase, detail contains the code)
SELECT message, detail
FROM generation_step_logs
WHERE phase = 'generating' AND message LIKE '%code generation complete%'
ORDER BY created_at DESC LIMIT 5;

-- Resolved selectors
SELECT message, detail
FROM generation_step_logs
WHERE phase = 'selector' AND detail IS NOT NULL
ORDER BY created_at DESC LIMIT 5;

-- Action plan details
SELECT message, detail
FROM generation_step_logs
WHERE phase = 'generating' AND message LIKE '%action plan%'
ORDER BY created_at DESC LIMIT 5;
```

#### Which tool for which question?

| What you want to know | Tool | Method |
|---|---|---|
| Generation-pipeline issue | `electron_db_query` | SQL above against `generation_step_logs` |
| Execution result / errors | `electron_db_query` | Inspect `execution_logs` + `step_logs` |
| AI prompt / response | `electron_db_query` | Inspect `ai_logs.prompt` / `.response` |
| Current desktop state | `list_windows` + `get_accessibility_tree` | Window list → AX tree |
| Element coordinates / action test | `find_elements` + `perform_action` | Drive directly |
| App internals | `electron_eval` | Run JS in the main process |
| Task definition | `electron_ipc` | `task:get` + `task:readAllStepFiles` |

## Architecture notes

### AI generation flow (aiAgent.ts → agents/)

Task generation proceeds through these phases; each has a dedicated agent file:

| Phase | Agent | UI | Purpose |
|-------|-------|----|---------|
| 1. Planning | `planningAgent.ts` | [PLAN] | Decompose instruction into steps (`type: 'browser' \| 'desktop'`) |
| 2. Analysis | `analyzingAgent.ts` | [ANALYZE] | Capture screenshot + HTML / AX tree. Dynamically detect AppleScript Dictionary via `sdef`. |
| 3. Action plan | `actionPlanAgent.ts` | [GEN] | AI produces the concrete action sequence |
| 4. Selector resolution | `selectorAgent.ts` | [SELECT] | Validate CSS/XPath selectors or AX elements **against the live tree**; when missed, return same-role candidate list |
| 4.5. Probe + re-plan | (inside `aiAgent.ts`) | [SELECT] | If unresolved, send candidates back to actionPlanAgent for one lightweight reselection |
| 5. Code generation | `codegenAgent.ts` | [GEN] | Generate step code from validated selectors/elements, then post-codegen patcher auto-fixes English-hardcoded app names, etc. |
| 6. Execution | (inside aiAgent.ts) | [EXEC] | Run the generated code |
| 7. Verification | `verifyAgent.ts` | [VERIFY] | Screenshot-based verify of success |
| 8. Diagnosis | `failureDiagnosis.ts` | [FIX] | Classify failure + emit concrete hypothesis + untried strategies |
| 9. Fix | (retry loop) | [FIX] | Pass diagnosis + strategy ledger back into the retry (max 3) |
| 10. Replan | `replanAgent.ts` | [PLAN] | After 3 fails, split / restructure the step itself |

### Failure-diagnosis pipeline (critical)

The heart of Dodompa's generator is: **convert failures into structured diagnoses, not free-form AI text**, and hand them to the next attempt precisely. Passing a category + untried-strategy ledger (`strategy_ledger`) keeps the AI from repeating the same mistake.

#### `failureDiagnosis.ts` categories

- `precondition_not_met` — target app not running / missing window / `ctx.shared.xxx` not populated upstream.
- `precondition_not_met` (locale-mismatched app-name subtype) — "Mail app is not running" etc. caused by hardcoded English app-name comparison. Hypothesis explicitly recommends Japanese-name / bundleId siblings.
- `selector_resolution_failed` / `element_not_found_runtime` — `findElement` returned null. Suggests enumerating same-role candidates.
- `action_execution_error` — click/type/shell/AppleScript runtime failure. Sub-categories:
  - **AppleScript** (`-1728` / `-1743` / `-10000`): not in dictionary / sandbox denied / type mismatch. Tells the retry to switch to the AX route.
  - **AppleScript date** (`-30720`): passing natural-language dates like `date "tomorrow 10:00 AM"` to AppleScript. Tells retry to build the Date in JS and use the `set year/month/day/hours of` pattern.
  - **Modal dialogs**: detects `display dialog` / `display alert` / `choose from list` / `prompt(`. Forbids them and tells retry to use `console.log` / `ctx.shared` instead.
  - **Shell subprocess**: python3 / osascript / open exiting with error.
  - **File / path**: `enoent` / "file not found" / `screencapture` target off.
  - **JavaScript runtime** (`is not defined` / `cannot read property` / `is not a function` / `SyntaxError`): undeclared variables / null access / typos, with identifiers.
  - **Playwright context-closed**: `page.goto: ... has been closed`. Tells retry to flip browser → desktop (Safari via AppleScript).
- `step_timeout` — timed out.
- `unknown` — fallback; signals a pattern worth adding.

#### Strategy Ledger (structured attempt history)

`failureDiagnosis.ts`'s `StrategyLedger` keeps, per step, "what has been tried, what failed, what hasn't been tried."
- `attempts[]`: each retry's category / where / hypothesis / summary of what was tried.
- `untried[]`: remaining strategy candidates for that category (e.g. "compare by bundleId", "use clipboard paste", "use Cmd+Shift+G for absolute path").
- On the next retry, the ledger is rendered via `formatLedgerForPrompt()` and injected into actionPlanAgent / codegenAgent prompts.
- This lets the AI receive concrete "last time you did A and it failed; this time try B" instructions so it stops emitting the same code.

#### Pre-retry side-effect cleanup

- If the previous error involved `display dialog` / `display alert`, dispatch `osascript -e 'tell application "System Events" to repeat 6 times key code 53'` before retrying — this spams Escape and clears stuck modals.
- Without this, the old failed dialog stays on screen and the next retry stacks on top of it.

### Cross-step shared state (the generation-time trap)

**Worth calling out because it was one of the nastiest bugs**: when `aiAgent.ts`'s `runAutonomousGeneration()` runs steps serially during generation, the `shared` object **must be the same instance across all steps**. We once had `{ shared: {} }` recreating it every call, so step 8 would write `ctx.shared.csvData = [...]` and step 9 would see `undefined`, retry infinitely, and misdiagnose itself.

```typescript
// ✅ Correct: create once outside the loop
const executionShared: Record<string, unknown> = {}
// Pass the same reference into each step
await stepModule.run(desktopCtx, { profile: {}, input: executionInput, shared: executionShared, ai: createStepAiHelper() })
```

`taskRunner.ts` (production execution) had this right from the start; only `aiAgent.ts` (generation-time test execution) was missing it. **If generation-time and production diverge, the "it worked when generated" guarantee breaks.** Always keep the shared reference.

### Dynamic AppleScript-Dictionary detection (analyzingAgent)

Rather than maintaining a hardcoded allowlist, detect AppleScript Dictionary availability at runtime via `sdef`:

```typescript
// 1. Resolve .app path from bundleId via mdfind (locale-independent)
const { stdout: bundlePath } = await exec('mdfind', [`kMDItemCFBundleIdentifier == "${bundleId}"`])
const appPath = bundlePath.split('\n').find(p => p.endsWith('.app'))

// 2. Pull the dictionary with sdef
const { stdout } = await exec('sdef', [appPath], { timeout: 3000 })
if (stdout.length > 200 && /<dictionary[\s>]/.test(stdout)) {
  // Extract main commands / class names
  const commands = Array.from(stdout.matchAll(/<command\s+name="([^"]+)"/g)).map(m => m[1])
  // → inject into analyzingAgent output: "AppleScript Dictionary: present / main commands: ..."
}
```

This treats first-party Apple apps, Microsoft Office, and any third-party app uniformly: "dictionary present → prefer AppleScript." New apps work without prompt edits.

### Desktop-automation caveats

- macOS Accessibility permission is required (System Settings → Privacy & Security → Accessibility).
- Launch apps with `open -a "AppName"` (Spotlight is flaky).
- AX-tree element `title` depends on locale (Japanese names on Japanese macOS).
- `waitForElement` resolves PID from app name — apps that don't appear in the window list (e.g. Spotlight) aren't usable via this.

### Desktop-automation strategy (important)

When generating / executing, pick a strategy in this priority order. Hard-coded coordinate clicks and key injection are a **last resort**.

#### 1. Hierarchy: CLI > URL Scheme > AppleScript > AX API > coordinate click

Work top-down. Each lower tier is more environment-dependent and brittle.

| Priority | Means | Examples | Upside |
|----------|-------|----------|--------|
| 1 | **Shell / CLI** | `open -a`, `osascript`, `pbcopy`/`pbpaste`, `defaults`, `mdfind`, `shortcuts run`, `screencapture`, `caffeinate` | Deterministic, fast, locale-independent |
| 2 | **URL Scheme / deep link** | `open "slack://channel?..."`, `open "raycast://..."`, `open "x-apple-reminderkit://..."` | Jumps straight into a specific in-app screen |
| 3 | **AppleScript / JXA** | `osascript -e 'tell application "Mail" to ...'` | Powerful when the app has a scripting dictionary |
| 4 | **AX API (Swift CLI)** | `perform_action AXPress` | UI-driven but coordinate-independent |
| 5 | **Coordinate click / key send** | `click(x,y)`, `type_text` | Last-ditch fallback |

**Rule**: anything that can be done on the command line (file ops, app launch, clipboard, system prefs, notifications, screenshots, date math, network) **must go through the shell**. Make sure `planningAgent` / `actionPlanAgent` prompts spell out "before picking a UI action, check whether CLI / AppleScript / URL Scheme can do it."

#### 2. Target identification always requires pre-analysis

**No guessing.** UI element `title`/labels vary with locale, OS version, app version, theme, and A/B tests. At the `actionPlan` → `selector` stage, always:

1. **`list_windows`** — confirm target app is running; capture PID and real window title.
2. **`get_accessibility_tree`** — dump the current AX tree and **measure** `role` / `title` / `description` / `path`.
3. **`find_elements`** — narrow candidates; if multiple match, disambiguate by path / position / parent.
4. `selectorAgent` commits the measured AX element and **bakes the resolved path / title into the code** (never embed a "probably Japanese" guess).
5. If the AX tree is shallow (Electron/WebView ~5 nodes), don't rely on AX — switch to window-title change + screenshot diff for state verification.

`analyzingAgent` always captures both AX tree and screenshot. Either alone is insufficient.

#### 3. State-check → act → verify loop

Before/after every action, check state:

- **Precondition**: expected window frontmost? (`list_windows` + `frontmost` check). If not, `activate_app`.
- **Action**: prefer AX; fall back to coordinates.
- **Post-check**: refetch AX tree OR window title OR screenshot diff to confirm the state transition before moving on.
- **Timing**: avoid fixed sleeps; use `wait_for_element`. If you must sleep, leave a comment explaining why.

#### 4. Eliminate locale / environment dependence

- String comparisons: partial match, regex, or multi-candidate (Japanese + English).
- Keyboard shortcuts: choose **function-based** (Copy = `command+c` universally; don't search for the "Copy" menu item string).
- Dates / times: ISO format, system-locale-independent.
- AX paths shift between app versions — identify elements by **role + title + parent context**, not absolute path.

#### 5. When to use AppleScript (important)

Use AppleScript **only for apps with a Scripting Dictionary**. Rule: "only first-class for apps whose dictionary supports data operations."

**✅ Allowed** (AppleScript can be the primary means):
- Apple first-party: Mail, Finder, Notes, Reminders, Calendar, Contacts, Messages, Safari, Preview, Keynote, Numbers, Pages, Music, Photos, System Events.
- Microsoft Office: Word, Excel, PowerPoint, Outlook (2016+).
- Third-party: OmniFocus, Things, Fantastical, Hazel, BBEdit, DEVONthink.

**❌ Forbidden** (don't make AppleScript primary — `activate` is fine):
- Electron / Chromium-based: Slack, Discord, Notion, Figma, VS Code, Cursor, Zoom, Obsidian, Linear, Spotify, Claude Desktop.
- Native apps without a dictionary, Mac App Store sandboxed apps.
- For those: AX tree + hotkeys + clipboard paste.

**Error handling**: when the following return codes hit, abandon AppleScript and fall back to AX / keyboard. `failureDiagnosis.ts` auto-classifies these as `action_execution_error` and proposes untried strategies.

| Code | Meaning | Action |
|------|---------|--------|
| `-1728` errAENoSuchObject | Command not in dictionary | Allowlist miss → switch to AX |
| `-1743` errAEEventNotPermitted | Sandbox denied | Check System Settings → Automation; otherwise AX |
| `-10000` | Object type mismatch | Syntax error or dictionary type mismatch |
| `-10006` | `set` on read-only property | Find a different command |

**Long text is safer pasted**: `osascript -e 'set the clipboard to "..."'` + `hotkey('command', 'v')` avoids escape hell.

#### 6. Error recovery

- "Not found" isn't an instant fail — **refetch AX tree + screenshot and retry**.
- Three failures of the same approach → kick `replanAgent` to split or swap strategy (e.g. CLI).
- Record failure reasons in `stepResults` so downstream steps can try to restore preconditions.

### Browser-automation caveats

- `launchPersistentContext` uses a dedicated user data directory (doesn't conflict with system Chrome).
- Login is delegated to the user (AI does not generate login code).
- `storageState` option doesn't work with persistent context — inject manually via `context.addCookies()`.
- Never use `waitForLoadState('networkidle')` (SPAs never idle) — use `domcontentloaded`.

### Cross-step context sharing

During the generation pipeline, each step's execution result (success/failure/error) is accumulated in a `stepResults` array and automatically passed to downstream **actionPlanAgent** and **codegenAgent**.

Benefits:
- If step 2 (DM search) fails, step 3 (message send) sees that the DM screen isn't open and autonomously tries to restore the precondition.
- Action plans and code gen are more robust because they factor in prior failure patterns.

```
stepResults: Array<{
  stepName: string      // step name
  description: string   // step description
  success: boolean      // success / fail
  error?: string        // error message (on fail)
  verifyReason?: string // reason from verifier
}>
```

### Messaging-app Quick Switcher strategy

DM/channel search via Slack-style Cmd+K requires these hardenings:

1. **Escape the search screen before Cmd+K**: on Slack's search result screen, Cmd+K focuses the search bar instead. **Press Esc three times to close the search screen, then Cmd+K.**
2. **Generate multiple query candidates**: use `ctx.ai()` to build 3 candidates — e.g. Japanese name → romaji, full name → last name only.
3. **Verify via window title**: Electron apps have shallow AX trees (~5 nodes in Slack), so you can't detect the candidate list via AX. Instead, **check whether "検索" / "Search" disappears from the window title** to confirm the transition.
4. **Fallback**: if the DM didn't open, Esc out and retry with the next query.
5. **Error handling**: when all queries fail, throw a concrete error that lists the queries tried.

### Post-codegen validation (`validateAndPatchQuickSwitcher`)

`codegenAgent.ts`'s `validateAndPatchQuickSwitcher()` auto-checks and patches generated code when:
- `hotkey('command', 'k')` is present, AND
- neither AX-tree validation nor window-title validation is present
- → replaces the block with the **Escape-search + multi-query + window-title verify** pattern.

### Known Slack-DM desktop constraints (as of 2026-03)

| Constraint | Detail |
|------------|--------|
| AX tree only ~5 elements | Electron / WebView → shallow AX tree. Quick Switcher candidates and message input can't be located via AX |
| Cmd+K broken on search screen | On search results, Cmd+K focuses the search bar. Escape out first |
| Window-title update lag | Window title doesn't always refresh immediately after transition |
| Future plan | When Slack API (OAuth persistence) lands, DM send via API becomes reliable |

### Common issues & remedies

| Issue | Root cause | Fix |
|-------|------------|-----|
| SingletonLock error | Prior Chrome process still around | Delete the lock file before launch |
| Profile incompatibility | System Chrome ≠ bundled Chromium version | Delete and recreate the profile dir |
| Selector not found | Dynamic ID, locale-dependent label | Inspect AX tree directly and pin the title |
| AI keeps making the same mistake | No error history passed / generic diagnosis | `failureDiagnosis` category + strategy ledger injected via `formatLedgerForPrompt()` |
| `type` missing after replan | Replan didn't specify type | Replan prompt explicitly inherits `type` |
| Quick Switcher hits 0 results → search screen | Pressed Return unconditionally | Verify candidate via AX before Return; on 0, Esc and retry |
| Prior-step DM-open failure → message input fails | Step-to-step result not shared | Propagate via `stepResults` |
| `Mail app is not running` keeps looping | Generated code has `w.app === 'Mail'` hardcode | bundleId first + Japanese-name sibling + partial match; post-codegen `validateAndPatchAppNameHardcode` auto-rewrites |
| Slack-pattern template fails on other apps | `'Slack'` literal inside the template | Parameterize to `APP_NAME`; window lookup pid-based (locale-agnostic) |
| `display dialog` stacks on screen | Automation code used interactive modals | Forbidden in prompt + diagnosis branch + pre-retry Escape cleanup |
| "CSV data to save not found" misdiagnosed as window-not-found | Negative-guard missing in diagnosis regex | Added branch in `failureDiagnosis`: file/data/csv keywords → classify as cross-step data handoff |
| Generation-time test loses inter-step data | `shared: {}` recreated each step | Create `executionShared` once, pass same reference to every step |
| Shell-only tasks open Terminal.app | Prompts lacked shell-first rule | `actionPlanAgent` / `codegenAgent` now include "shell tasks go through `execFile`, never Terminal UI" |
| Placeholder "launch app" step gets inserted | Planner forced ≥2 steps | Switched to "shape matches the task"; post-process drops placeholder launches; auto-split avoids generic app names |
| URL / name / value "generalized" by AI | Planner summarized exact values | Added rule: "user's concrete values copied verbatim into variable defaults" |
| AppleScript allowlist breaks for new apps | Static app-name enumeration | analyzingAgent dynamically runs `mdfind`+`sdef` at runtime and injects the result |
| AppleScript `date "tomorrow 10:00"` fails with `-30720` | AppleScript doesn't parse natural-language dates | Build `new Date()` in JS, then `set year/month/day/hours of theDate` in AppleScript. Also a diagnosis branch |
| TextEdit / Notes AX tree unreliable | SwiftUI AX support is flaky | Allowlisted apps pick AppleScript first, bypassing AX (sdef detection handles this) |
| `desktop.type()` garbles Japanese | `type` isn't safe for non-ASCII | Japanese / emoji / non-ASCII always via clipboard paste (`pbcopy` + `Cmd+V`). The `pasteText` helper pattern is documented in codegen prompts |
| "Save" dialog `Cmd+D → filename → Return` flaky | `Cmd+D` behavior differs across macOS versions | Unified to `Cmd+Shift+G` "Go to folder" + absolute-path paste |
| Verifier returns success but file isn't on disk | Verifier is screenshot-based → fooled visually | Operations with filesystem side-effects end with `await exec('test', ['-f', expectedPath])` |
| "Open it in Safari" routed to Playwright Chromium | Planner picked browser type | Specific app names (Safari/Chrome/Firefox/Notes/Mail etc.) force desktop type. Called out in the planner prompt |
