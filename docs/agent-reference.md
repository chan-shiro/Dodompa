# Dodompa Agent Reference

> 🇯🇵 日本語版: [agent-reference.ja.md](agent-reference.ja.md)
>
> Input / output / tool-invocation catalog for every AI agent in the pipeline.
> For dev reference.

## End-to-end pipeline

```
┌─────────────────────────────────────────────────────────┐
│                    Phase 0: Planning                     │
│                                                         │
│  instruction + goal                                     │
│       │                                                 │
│       ├── shouldUseExploratoryPlanning() = true          │
│       │   └── exploratoryPlan()                         │
│       │       ├── navigate / followLink / screenshot ... │
│       │       └── done → StepPlan[] + Variables[]       │
│       │                                                 │
│       └── shouldUseExploratoryPlanning() = false         │
│           └── planSteps() → StepPlan[] + Variables[]    │
└────────────────────────┬────────────────────────────────┘
                         │
              ┌──────────▼──────────┐
              │  for each StepPlan  │
              └──────────┬──────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│ Phase A: Analysis                                       │
│  ├── [browser] analyzeBrowserPage() → HTML, screenshot  │
│  ├── [desktop] analyzeDesktop() → AX tree, screenshot   │
│  └── [browser] reconBrowserPage() → SiteMap             │
│       └── (optional) deep recon: triage → sub-pages     │
├─────────────────────────────────────────────────────────┤
│ Phase B: Action Plan                                    │
│  └── generateActionPlan() → ActionPlan[]                │
├─────────────────────────────────────────────────────────┤
│ Phase C: Selector Resolution                            │
│  ├── [browser] resolveActionSelectors() → ResolvedAction│
│  └── [desktop] resolveDesktopActions() → ResolvedAction │
├─────────────────────────────────────────────────────────┤
│ Phase D: Code Generation                                │
│  └── generateCodeFromResolvedActions() → TypeScript     │
├─────────────────────────────────────────────────────────┤
│ Phase E: Execution                                      │
│  └── stepModule.run(page/desktop, ctx) → ctx.shared     │
├─────────────────────────────────────────────────────────┤
│ Phase F: Verification                                   │
│  └── verifyStepExecution() → {success, reason}          │
├─────────────────────────────────────────────────────────┤
│ Phase G: Retry (max 3)                                  │
│  ├── diagnoseFailure() → category + hypothesis          │
│  ├── suggestUntriedStrategies() → next strategy         │
│  └── Re-run phases B–F                                  │
├─────────────────────────────────────────────────────────┤
│ Phase H: Replan (retries exhausted)                     │
│  └── replanStep() → split / replace / skip / retry_prev │
└─────────────────────────────────────────────────────────┘
```

---

## 1. planningAgent — planSteps()

| Field | Value |
|------|------|
| **File** | `src/main/ipc/agents/planningAgent.ts` |
| **Purpose** | Decompose the user instruction into steps |
| **AI calls** | `chatStream()` × 1 |

### Input
| Param | Type | Description |
|-----------|-----|------|
| config | AiProviderConfig | AI provider config |
| win | BrowserWindow \| null | UI progress target |
| taskId | string | Task ID |
| instruction | string | User's instruction |
| priorStableSteps | StablePriorStep[] | Existing stable steps |
| goal | string? | Task's final deliverable / purpose |

### Output
```typescript
{
  plan: StepPlan[]               // {name, description, type, needsLogin?}
  detectedVariables: VariableDefinition[]  // {key, label, type, required, default}
  planResult: { text: string; usage?: { totalTokens?: number } }
}
```

### Tool calls
None (pure text → text AI invocation).

---

## 2. exploratoryPlanAgent — exploratoryPlan()

| Field | Value |
|------|------|
| **File** | `src/main/ipc/agents/exploratoryPlanAgent.ts` |
| **Purpose** | Actually crawl the site, then plan |
| **AI calls** | `chatNonStream()` × up to 11 (10 actions + forced `done`) |

### Input
| Param | Type | Description |
|-----------|-----|------|
| config | AiProviderConfig | |
| win | BrowserWindow \| null | UI progress target |
| taskId | string | |
| instruction | string | User's instruction |
| goal | string | Task's final deliverable |
| page | Page | Playwright page (for exploration) |
| priorStableSteps | StablePriorStep[] | Existing stable steps |

### Output
Same shape as `planSteps()`.

### Tool calls
| Action | Playwright API | Description |
|-----------|---------------|------|
| navigate | `page.goto()` + `scanBrowserPage()` | URL + DOM scan |
| scanCurrentPage | `scanBrowserPage()` | Re-scan current page |
| followLink | `page.getByRole('link').click()` | Click a link |
| checkContentType | `page.context().request.head()` | Inspect Content-Type |
| extractSampleText | `page.evaluate()` / `page.locator().innerText()` | Extract text |
| screenshot | `page.screenshot()` | Screenshot |
| goBack | `page.goBack()` | Browser back |

### Gate: shouldUseExploratoryPlanning()
```typescript
// true: goal + URL + information-gathering keywords all present
// false: otherwise → fall back to classic planSteps()
```

---

## 3. analyzingAgent — analyzeBrowserPage() / analyzeDesktop()

| Field | Value |
|------|------|
| **File** | `src/main/ipc/agents/analyzingAgent.ts` |
| **Purpose** | Capture current screen state |
| **AI calls** | `analyzeDesktop` only: `chatNonStream()` × 1 (window matching) |

### analyzeBrowserPage
| Input | Output |
|-------|--------|
| page: Page | pageHtml: string |
| win, taskId, stepIndex, stepName | screenshot: string (base64) |
| | selectorMap: string (list of actionable elements) |

**Tools**: `page.content()`, `page.screenshot()`, `page.evaluate(extractPageSelectors)`.

### analyzeDesktop
| Input | Output |
|-------|--------|
| config, desktopCtx, win, taskId | pageHtml: string (AX tree JSON) |
| stepIndex, stepPlan, lastUsedAppName | screenshot: string (base64) |
| | selectorMap: string (AX tree formatted) |
| | updatedAppName, launchName, targetPid |

**Tools**: `desktop.screenshot()`, `desktop.getWindows()`, `desktop.getAccessibilityTree()`, `matchTargetWindow()`, `exec('sdef', ...)` (AppleScript Dictionary detection).

---

## 4. reconAgent — reconBrowserPage()

| Field | Value |
|------|------|
| **File** | `src/main/ipc/agents/reconAgent.ts` |
| **Purpose** | Site structure recon (surface + deep) |
| **AI calls** | `chatStream()` × 1 (enrichment) + on deep recon `chatNonStream()` × 2 (triage + report) |

### Input
| Param | Type | Description |
|-----------|-----|------|
| config | AiProviderConfig | |
| page | Page | Current page |
| win, taskId, stepIndex | | Logging |
| stepPlan | StepPlan | Step info (for goal context) |
| opts.deepRecon | boolean? | Enable deep recon |

### Output: SiteMap
```typescript
interface SiteMap extends SiteMapRawFacts {
  summary?: string           // AI summary (2-4 sentences)
  urlPatterns?: string[]     // URL templates
  candidatesForGoal?: Array<{kind, label, via, note}>  // candidates for the goal
  subPages?: SubPageFinding[]     // [deep recon] sub-page visit findings
  deepScanReport?: string         // [deep recon] AI consolidated report
}
```

### Tool calls
| Function | Tool | Description |
|------|--------|------|
| scanBrowserPage | `page.evaluate()` | Deterministic DOM scan |
| deriveUrlPatterns | Pure function | Derive URL patterns from links |
| triageDeepRecon | `chatNonStream()` | Decide whether deep recon is needed |
| exploreSubPages | `page.goto()`, `page.evaluate()`, `page.context().request.head()` | Visit sub-pages |
| synthesizeDeepReport | `chatNonStream()` | Produce a report of findings |

### Cache
- URL-keyed, 24 h TTL.
- Cache entries missing `deepRecon` data are skipped when deep recon is requested.

---

## 5. actionPlanAgent — generateActionPlan()

| Field | Value |
|------|------|
| **File** | `src/main/ipc/agents/actionPlanAgent.ts` |
| **Purpose** | Emit the concrete action sequence |
| **AI calls** | `chatStream()` × 1 |

### Input
Analysis result + recon result + error history + step results + strategy ledger + task goal.

### Output
```typescript
interface ActionPlanResult {
  actions: ActionPlan[]     // {action, description, selectorHint, url, value, ...}
  question?: { question: string; infoKey?: string }  // ask user on info gap
  alreadyDone?: boolean     // already satisfies the goal
}
```

### Action kinds (browser)
`goto`, `click`, `fill`, `press`, `select`, `wait`, `scroll`, `hover`.

### Action kinds (desktop)
`open_app`, `activate_app`, `click_element`, `click_position`, `type_text`, `hotkey`, `press_key`, `shell`.

---

## 6. selectorAgent — resolveActionSelectors() / resolveDesktopActions()

| Field | Value |
|------|------|
| **File** | `src/main/ipc/agents/selectorAgent.ts` |
| **Purpose** | Validate action-plan selectors / elements against the live app |
| **AI calls** | None (deterministic search only) |

### resolveActionSelectors (browser)
**Tools**: `page.getByRole()`, `page.getByText()`, `page.getByPlaceholder()`, `page.getByLabel()`, `page.locator()`, `page.evaluate()` (CSS validation).

### resolveDesktopActions (desktop)
**Tools**: `desktop.getAccessibilityTree()`, `desktop.findElement()`, `desktop.findElements()`.

### Output
```typescript
interface ResolvedAction {
  action: ActionPlan
  resolvedSelector?: { method: 'playwright' | 'css'; selector: string }
  resolvedDesktop?: { axRole, axTitle, path, position, pid, found, candidates? }
  unresolved?: boolean
}
```

---

## 7. codegenAgent — generateCodeFromResolvedActions()

| Field | Value |
|------|------|
| **File** | `src/main/ipc/agents/codegenAgent.ts` |
| **Purpose** | Turn validated actions into TypeScript |
| **AI calls** | `chatStream()` × 1 |

### Input
Resolved actions + page state + existing code + error history + SiteMap + task goal.

### Output
```typescript
// Generated TypeScript module
export async function run(page: Page, context: BrowserContext, ctx: StepContext): Promise<void>
export const meta = { description: string, retryable: boolean, timeout: number }
```

### APIs available to generated code
| Browser (ctx) | Desktop (ctx) |
|--------------|---------------|
| page.goto(), page.click() | desktop.click(), desktop.type() |
| page.fill(), page.locator() | desktop.hotkey(), desktop.pressKey() |
| page.evaluate() | desktop.getWindows(), desktop.getAccessibilityTree() |
| page.screenshot() | desktop.screenshot() |
| ctx.ai(prompt) | ctx.ai(prompt) |
| ctx.shared.xxx | ctx.shared.xxx |
| ctx.input.xxx | ctx.input.xxx |
| import pdfParse from 'pdf-parse' | exec('osascript', ...) |

---

## 8. verifyAgent — verifyStepExecution()

| Field | Value |
|------|------|
| **File** | `src/main/ipc/agents/verifyAgent.ts` |
| **Purpose** | Decide success/failure after step execution |
| **AI calls** | `chatNonStream()` × 0-1 (no AI if programmatic verify suffices) |

### Input
stepDescription + before/after screenshots + executionResult + executionShared + taskGoal.

### Output
```typescript
{ success: boolean; reason?: string }
```

### Verification strategy (priority order)
1. **Programmatic** — file existence / `ctx.shared` value check / data-quality check.
2. **Heuristic** — no error = success (desktop, non-visual ops).
3. **AI visual verify** — before/after screenshot comparison.

---

## 9. failureDiagnosis — diagnoseFailure()

| Field | Value |
|------|------|
| **File** | `src/main/ipc/agents/failureDiagnosis.ts` |
| **Purpose** | Classify failures and propose next strategies |
| **AI calls** | None (rule-based) |

### Categories
| Category | Example |
|---------|-----|
| selector_resolution_failed | CSS selector not found |
| element_not_found_runtime | findElement returned null |
| action_execution_error | AppleScript -1728, click failed |
| step_timeout | Timed out |
| verification_failed | Verifier rejected |
| code_compile_error | esbuild error |
| precondition_not_met | App not launched, prior step failed |
| data_extraction_failed | Empty extracted data |
| unknown | None of the above |

---

## 10. replanAgent — replanStep()

| Field | Value |
|------|------|
| **File** | `src/main/ipc/agents/replanAgent.ts` |
| **Purpose** | Restructure the step after 3 failures |
| **AI calls** | `chatNonStream()` × 1 |

### Output
```typescript
interface ReplanDecision {
  action: 'split' | 'replace' | 'skip' | 'retry_previous'
  steps?: StepPlan[]      // for split
  step?: StepPlan         // for replace
  reason?: string
  goBackSteps?: number    // for retry_previous
}
```

---

## Inter-step state flow

```
executionInput:  Record<string, string>    — task variables (shared across all steps)
executionShared: Record<string, unknown>   — ctx.shared (inter-step data handoff)
stepResults:     Array<StepResult>         — per-step success/failure (propagated forward)
siteMap:         SiteMap | null            — recon findings (updated per step)
errorHistory:    Array<ErrorRecord>        — retry-loop error history
strategyLedger:  {tried[], untried[]}      — tried / untried strategies
```
