// ─── Task Definition ───

export interface TaskDefinition {
  id: string
  name: string
  description: string
  instruction?: string // Most recent AI generation instruction (overwritten on re-generation)
  goal?: string // タスクの最終成果物・目的（任意）— 全エージェントに伝播し検証基準に使われる
  initialInstruction?: string // First-ever instruction used to create this task — never overwritten
  initialInstructionAt?: string // ISO timestamp of when initialInstruction was first saved
  profileId: string
  steps: StepMeta[]
  variables: VariableDefinition[]
  schedule?: string // cron expression
  createdAt: string
  updatedAt: string
}

// ─── Knowledge System ───

export type KnowledgePlatform = 'mac' | 'windows' | 'browser'

export interface KnowledgeEntry {
  name: string
  description?: string
  app?: string
  platform: KnowledgePlatform
  bundleIds?: string[]
  aliases?: string[]
  category?: string
  appleScript?: 'full' | 'limited' | 'none'
  always?: boolean
  body: string
  isBuiltin: boolean
}

export interface StepMeta {
  id: string
  order: number
  file: string // e.g. "step_01_login.ts"
  description: string
  type: 'browser' | 'api' | 'desktop'
  status: 'stable' | 'flaky' | 'broken' | 'untested'
  lastSuccess: string | null
  failCount: number
  aiRevisionCount: number
  /**
   * Per-step timeout override in milliseconds. When set, this takes
   * precedence over the step module's `meta.timeout` export. Useful for
   * long-running scraping steps that exceed the default (e.g. 60s).
   */
  timeoutMs?: number
  /**
   * `ctx.shared.xxx` keys this step writes to. Populated at the moment the
   * step transitions to `stable` by static-scanning its generated code.
   *
   * Used by the planning agent during regeneration: when a task already has
   * stable steps, the planner is told which ctx.shared state they produce
   * so it only plans the remaining delta instead of recreating all steps
   * from scratch. Without this, regenerating a half-built task duplicates
   * steps that already work.
   *
   * Empty array means "step was scanned but produced no ctx.shared writes"
   * (e.g. a pure UI launch step). `undefined` means the step predates this
   * field and its contribution is unknown.
   */
  producedSharedKeys?: string[]
  /**
   * True when the step's code calls `ctx.ai(...)` — i.e. it consults the
   * LLM at runtime (for classification, extraction, disambiguation, etc.).
   * Computed on demand when the task is read (not persisted), so it always
   * reflects the current code even after manual edits.
   */
  usesAi?: boolean
}

export interface VariableDefinition {
  key: string
  label: string
  type: 'string' | 'number' | 'secret'
  required: boolean
  default?: string
}

// ─── Step Execution ───

export interface StepContext {
  profile: Record<string, string>
  input: Record<string, string>
  shared: Record<string, unknown>
  /** Call AI from within a step. Useful for classification, extraction, labeling, etc. */
  ai: (prompt: string) => Promise<string>
}

// ─── AI Provider ───

export interface AiProviderConfig {
  id: string
  name: string
  type: 'anthropic' | 'openai' | 'google' | 'openai-compatible'
  baseUrl?: string
  apiKey: string
  model: string
  isActive: boolean
}

// ─── AI Fix Result ───

export interface AiFixResult {
  analysis: string
  fixedCode: string
  confidence: 'high' | 'medium' | 'low'
}

// ─── Profile ───

export interface BrowserProfile {
  id: string
  name: string
  storagePath: string
  createdAt: string
  updatedAt: string
}

// ─── Execution Logs ───

export interface ExecutionLog {
  id: string
  taskId: string
  status: 'running' | 'success' | 'failed'
  startedAt: string
  finishedAt: string | null
  variables: string | null // JSON
  error: string | null
}

export interface StepLog {
  id: string
  executionId: string
  stepId: string
  stepDescription: string | null
  status: 'running' | 'success' | 'failed'
  startedAt: string
  finishedAt: string | null
  pageUrl: string | null
  pageTitle: string | null
  screenshotBeforePath: string | null
  screenshotPath: string | null
  htmlSnapshotPath: string | null
  sharedState: string | null
  error: string | null
}

export interface AiLog {
  id: string
  taskId: string
  stepId: string | null
  type: 'generation' | 'fix'
  prompt: string
  response: string
  provider: string
  model: string
  tokensUsed: number | null
  status: 'pending' | 'approved' | 'rejected'
  createdAt: string
}

// ─── AI Generation Progress ───

/**
 * Discriminator for which sub-agent is currently running. This is a finer
 * slice than `phase` because several agents share the same phase value
 * (e.g. `actionPlan` and `codegen` both emit phase='generating'). The
 * frontend uses this to render the agent-flow strip showing the current
 * stage vs upcoming stages.
 *
 * Must stay in order matching the pipeline in aiAgent.ts so that
 * "everything before current = done, everything after = upcoming" holds.
 */
export type GenerationAgentKey =
  | 'planning'
  | 'analyzing'
  | 'actionPlan'
  | 'selector'
  | 'codegen'
  | 'patchCode'
  | 'executing'
  | 'verifying'
  | 'fixing'
  | 'replan'

export interface GenerationProgressEvent {
  phase: 'planning' | 'analyzing' | 'generating' | 'selector' | 'executing' | 'verifying' | 'fixing' | 'waitingForLogin' | 'askingUser' | 'done' | 'error'
  /**
   * Optional fine-grained agent id. When present, the frontend prefers this
   * over `phase` for lighting up the agent-flow strip. Backward compatible:
   * older events without this field fall back to a phase → agent mapping.
   */
  agent?: GenerationAgentKey
  stepIndex?: number
  stepName?: string
  message: string
  /** i18n key for UI-layer translation (renderer resolves via taskGeneration:progress.*) */
  messageCode?: string
  /** Interpolation params for messageCode */
  messageParams?: Record<string, string | number>
  streamDelta?: string
  screenshot?: string // base64
  html?: string       // HTML snapshot (truncated)
  plan?: Array<{ name: string; description: string }>
  question?: {
    id: string
    text: string
    infoKey?: string  // If set, answer is saved to user_info with this key
  }
}

export interface StepPlan {
  name: string
  description: string
  type?: 'browser' | 'desktop'  // defaults to 'browser' for backward compat
  needsLogin?: boolean
}

/**
 * Summary of a stable step to feed into the planning agent so it can plan
 * only the remaining delta rather than re-emitting the full sequence.
 */
export interface StablePriorStep {
  order: number
  name: string
  description: string
  type: 'browser' | 'desktop' | 'api'
  /** `ctx.shared.xxx` keys this step populated (from static code scan). */
  producedSharedKeys: string[]
}

// ─── IPC Events ───

export interface StepProgressEvent {
  taskId: string
  executionId: string
  stepId: string
  status: 'running' | 'success' | 'failed' | 'waitingForLogin'
  error?: string
  screenshotPath?: string
  message?: string
}

// ─── IPC Params ───

export interface GenerateStepParams {
  taskId: string
  instruction: string
  pageHtml: string
  screenshot: string // base64
  existingSteps: string[]
}

export interface AnalyzeFixParams {
  taskId: string
  stepId: string
  stepCode: string
  errorMessage: string
  screenshotPath: string
  htmlSnapshot: string
  stepStatus: 'flaky' | 'broken'
}

export interface EditStepParams {
  taskId: string
  stepId: string
  instruction: string
}

export interface AiEditResult {
  editedCode: string
  summary: string
  aiLogId: string
}

// ─── General Settings ───

// ─── Desktop Automation ───

export interface WindowInfo {
  pid: number
  app: string | null
  bundleId: string | null
  title: string | null
  bounds: { x: number; y: number; width: number; height: number } | null
  focused: boolean
}

export interface AXNode {
  role: string | null
  title: string | null
  value: string | null
  description: string | null
  enabled: boolean
  focused: boolean
  position: { x: number; y: number } | null
  size: { width: number; height: number } | null
  path: string
  actions: string[]
  children?: AXNode[]
}

export interface DesktopContext {
  getWindows(): Promise<WindowInfo[]>
  getAccessibilityTree(appOrPid: string | number): Promise<AXNode>
  /**
   * Returns the AX subtree for a SINGLE window only, narrowed by title or index.
   * Prefer this over `getAccessibilityTree` when you know which window you want
   * to operate on — it prevents `findElement` from accidentally matching
   * elements in other (minimized, background, modal) windows of the same app.
   */
  getWindowTree(appOrPid: string | number, opts?: { title?: string; index?: number }): Promise<AXNode | null>
  /**
   * Returns the AX subtree for the currently focused/frontmost window of the
   * given app. Use this when your code has just called `activateApp(pid)` and
   * wants to operate on whatever window is now in front.
   */
  getFocusedWindowTree(appOrPid: string | number): Promise<AXNode | null>
  /**
   * Progressive drill-down: return the subtree rooted at the element matching
   * `opts.path` (dot-separated child indices as found on `AXNode.path`) or
   * `opts.query` (first role/title match anywhere under the app root).
   *
   * Use this when `getAccessibilityTree` or `getWindowTree` showed a "… (N more
   * interactive descendants pruned)" marker and you need to see inside a
   * specific container without re-fetching and re-formatting the entire tree.
   *
   * Example:
   *   // AI prompt showed: "[AXToolbar] @ (100, 40) 1200x44 … (18 more pruned)"
   *   // with path "0.0.2.1" somewhere in the dump
   *   const toolbar = await desktop.getSubtree(pid, { path: '0.0.2.1' })
   *   const sendBtn = desktop.findElement(toolbar!, { role: 'AXButton', title: '送信' })
   */
  getSubtree(
    appOrPid: string | number,
    opts: { path?: string; query?: { role?: string; title?: string; value?: string } }
  ): Promise<AXNode | null>
  findElement(tree: AXNode, query: { role?: string; title?: string; value?: string }): AXNode | null
  findElements(tree: AXNode, query: { role?: string; title?: string; value?: string }): AXNode[]
  screenshot(target?: { pid?: number; region?: { x: number; y: number; width: number; height: number } }): Promise<Buffer>
  click(x: number, y: number): Promise<void>
  doubleClick(x: number, y: number): Promise<void>
  rightClick(x: number, y: number): Promise<void>
  type(text: string): Promise<void>
  hotkey(...keys: string[]): Promise<void>
  pressKey(key: string): Promise<void>
  drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void>
  activateApp(appOrPid: string | number): Promise<void>
  waitForElement(appOrPid: string | number, query: { role?: string; title?: string }, timeout?: number): Promise<AXNode>
  performAction(pid: number, elementPath: string, action: string): Promise<void>
  elementAtPoint(x: number, y: number): Promise<AXNode | null>
  moveTo(x: number, y: number): Promise<void>
}

// ─── General Settings ───

/**
 * UI language. `'auto'` resolves to the OS locale at startup via
 * `app.getLocale()`. Explicit values override the system default.
 */
export type UiLanguage = 'auto' | 'en' | 'ja'

export interface GeneralSettings {
  playwrightExecutablePath: string
  defaultHeadless: boolean
  /** UI language preference. Defaults to 'auto' when absent. */
  language?: UiLanguage
}
