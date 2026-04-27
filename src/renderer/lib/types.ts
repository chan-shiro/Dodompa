// ─── Task Definition ───

export interface TaskDefinition {
  id: string
  name: string
  description: string
  instruction?: string // Most recent AI generation instruction
  initialInstruction?: string // Original instruction the task was first created from (read-only)
  initialInstructionAt?: string // ISO timestamp
  profileId: string
  steps: StepMeta[]
  variables: VariableDefinition[]
  schedule?: string // cron expression
  createdAt: string
  updatedAt: string
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
  timeoutMs?: number
  /**
   * True when the step's code calls `ctx.ai(...)` at runtime. Computed on
   * read by the main process, never persisted.
   */
  usesAi?: boolean
}

export interface VariableDefinition {
  key: string
  label: string
  type: 'string' | 'number' | 'secret'
  required: boolean
}

// ─── Step Execution ───

export interface StepContext {
  profile: Record<string, string>
  input: Record<string, string>
  shared: Record<string, unknown>
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
  sharedState: string | null  // JSON
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

export type GenerationAgentKey =
  | 'planning'
  | 'analyzing'
  | 'actionPlan'
  | 'selector'
  | 'codegen'
  | 'executing'
  | 'verifying'
  | 'fixing'
  | 'replan'

export interface GenerationProgressEvent {
  phase: 'planning' | 'analyzing' | 'generating' | 'selector' | 'executing' | 'verifying' | 'fixing' | 'waitingForLogin' | 'askingUser' | 'done' | 'error'
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
    infoKey?: string
  }
}

export interface StepPlan {
  name: string
  description: string
  type?: 'browser' | 'desktop'
  needsLogin?: boolean
}

// ─── IPC Events ───

export interface StepProgressEvent {
  executionId: string
  stepId: string
  status: 'running' | 'success' | 'failed' | 'waitingForLogin'
  error?: string
  screenshotPath?: string
  message?: string
  streamDelta?: string
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

export type UiLanguage = 'auto' | 'en' | 'ja'

export interface GeneralSettings {
  playwrightExecutablePath: string
  defaultHeadless: boolean
  language?: UiLanguage
}

// ─── Knowledge ───

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
