import type {
  TaskDefinition,
  ExecutionLog,
  StepLog,
  AiLog,
  AiProviderConfig,
  BrowserProfile,
  GeneralSettings,
  StepProgressEvent,
  GenerationProgressEvent,
  KnowledgeEntry,
  GenerateStepParams,
  AnalyzeFixParams,
  AiFixResult,
  WindowInfo,
  AXNode,
} from './types'

// Re-export for preload type reference
export const electronAPI = window.electronAPI

// ─── Task ───

export async function listTasks(): Promise<TaskDefinition[]> {
  return electronAPI.task.list()
}

export async function getTask(id: string): Promise<TaskDefinition> {
  return electronAPI.task.get(id)
}

export async function createTask(name: string): Promise<TaskDefinition> {
  return electronAPI.task.create(name)
}

export async function updateTask(
  id: string,
  data: Partial<TaskDefinition>
): Promise<TaskDefinition> {
  return electronAPI.task.update(id, data) as Promise<TaskDefinition>
}

export async function deleteTask(id: string): Promise<void> {
  return electronAPI.task.delete(id)
}

export async function exportTask(taskId: string): Promise<{ success: boolean; path?: string }> {
  return electronAPI.task.export(taskId) as Promise<{ success: boolean; path?: string }>
}

export async function importTask(): Promise<{ success: boolean; taskId?: string; taskName?: string; error?: string }> {
  return electronAPI.task.import() as Promise<{ success: boolean; taskId?: string; taskName?: string; error?: string }>
}

export async function deleteStep(taskId: string, stepId: string): Promise<TaskDefinition> {
  return electronAPI.task.deleteStep(taskId, stepId) as Promise<TaskDefinition>
}

export async function deleteAllSteps(taskId: string): Promise<TaskDefinition> {
  return electronAPI.task.deleteAllSteps(taskId) as Promise<TaskDefinition>
}

export async function readAllStepFiles(taskId: string): Promise<Array<{
  stepId: string
  file: string
  description: string
  type: string
  code: string | null
}>> {
  return electronAPI.task.readAllStepFiles(taskId) as Promise<Array<{
    stepId: string; file: string; description: string; type: string; code: string | null
  }>>
}

export async function readStepFile(taskId: string, stepFile: string): Promise<string | null> {
  return electronAPI.task.readStepFile(taskId, stepFile) as Promise<string | null>
}

export async function writeStepFile(taskId: string, stepFile: string, code: string): Promise<void> {
  return electronAPI.task.writeStepFile(taskId, stepFile, code)
}

export async function addStep(taskId: string, stepType?: 'browser' | 'desktop'): Promise<TaskDefinition> {
  return electronAPI.task.addStep(taskId, stepType) as Promise<TaskDefinition>
}

// ─── Runner ───

export async function executeTask(
  taskId: string,
  variables: Record<string, string>,
  fromStep?: string
): Promise<void> {
  return electronAPI.runner.execute(taskId, variables, fromStep)
}

export async function debugStep(
  taskId: string,
  variables: Record<string, string>,
  toStep: string
): Promise<void> {
  return electronAPI.runner.execute(taskId, variables, undefined, toStep, true)
}

export async function rerunDebugStep(taskId: string, stepId: string): Promise<void> {
  return electronAPI.runner.rerunDebugStep(taskId, stepId)
}

export async function endDebugSession(taskId: string): Promise<void> {
  return electronAPI.runner.endDebugSession(taskId)
}

export async function confirmRunnerLogin(executionId: string): Promise<void> {
  return electronAPI.runner.confirmLogin(executionId)
}

export function onStepProgress(cb: (event: StepProgressEvent) => void): () => void {
  return electronAPI.runner.onProgress(cb as (e: unknown) => void)
}

// ─── Logs ───

export async function listExecutions(taskId?: string): Promise<ExecutionLog[]> {
  return electronAPI.log.listExecutions(taskId)
}

export async function getStepLogs(executionId: string): Promise<StepLog[]> {
  return electronAPI.log.getStepLogs(executionId)
}

export async function listAiLogs(taskId?: string): Promise<AiLog[]> {
  return electronAPI.log.listAiLogs(taskId)
}

// ─── Storage ───

export interface StorageInfo {
  screenshotCount: number
  screenshotBytes: number
  executionCount: number
  stepLogCount: number
  generationLogCount: number
  aiLogCount: number
}

export async function getStorageInfo(taskId: string): Promise<StorageInfo> {
  return electronAPI.log.getStorageInfo(taskId)
}

export async function cleanupOldData(taskId: string, keepRecent: number = 5): Promise<{ ok: boolean }> {
  return electronAPI.log.cleanupOldData(taskId, keepRecent)
}

export interface TaskStats {
  taskId: string
  total: number
  success: number
  failed: number
  running: number
  lastRunAt: string | null
}

export async function getTaskStats(): Promise<TaskStats[]> {
  return electronAPI.log.getTaskStats() as Promise<TaskStats[]>
}

// ─── AI ───

export async function generateStep(params: GenerateStepParams): Promise<string> {
  return electronAPI.ai.generateStep(params)
}

export async function analyzeAndFix(params: AnalyzeFixParams): Promise<AiFixResult> {
  return electronAPI.ai.analyzeAndFix(params)
}

export async function applyFix(aiLogId: string, approved: boolean): Promise<void> {
  return electronAPI.ai.applyFix(aiLogId, approved)
}

export async function suggestVariables(params: {
  taskId: string
  instruction?: string
}): Promise<Array<{ key: string; label: string; type: string; required: boolean; default?: string }>> {
  return electronAPI.ai.suggestVariables(params) as Promise<Array<{ key: string; label: string; type: string; required: boolean; default?: string }>>
}

export async function editStep(params: {
  taskId: string
  stepId: string
  instruction: string
}): Promise<{ editedCode: string; summary: string; aiLogId: string; originalCode: string }> {
  return electronAPI.ai.editStep(params) as Promise<{ editedCode: string; summary: string; aiLogId: string; originalCode: string }>
}

export interface RefactorModifyOp {
  op: 'modify'
  stepId: string
  file: string
  description: string
  stepType: 'browser' | 'desktop'
  summary: string
  originalCode: string
  newCode: string
}
export interface RefactorDeleteOp {
  op: 'delete'
  stepId: string
  file: string
  description: string
  stepType: 'browser' | 'desktop'
  summary: string
  originalCode: string
}
export interface RefactorAddOp {
  op: 'add'
  tempId: string
  afterStepId: string | null
  description: string
  stepType: 'browser' | 'desktop'
  summary: string
  newCode: string
}
export type RefactorOperation = RefactorModifyOp | RefactorDeleteOp | RefactorAddOp

export interface RefactorPlan {
  aiLogId: string
  rationale: string
  operations: RefactorOperation[]
}

export async function refactorTask(params: {
  taskId: string
  instruction: string
  referenceTaskIds?: string[]
}): Promise<RefactorPlan> {
  return electronAPI.ai.refactorTask(params) as Promise<RefactorPlan>
}

export function onRefactorProgress(cb: (event: { taskId: string; message: string }) => void): () => void {
  return electronAPI.ai.onRefactorProgress(cb as (e: unknown) => void)
}

/**
 * Subscribe to streaming code previews while the AI is generating a refactor.
 * Each event contains the latest partial code being produced for an operation.
 */
export function onRefactorStream(
  cb: (event: { taskId: string; opIndex: number; stepIdHint?: string; code: string; kind?: 'newCode' | 'replace' | 'search' }) => void,
): () => void {
  const fn = (electronAPI.ai as unknown as { onRefactorStream?: (cb: (e: unknown) => void) => () => void }).onRefactorStream
  if (!fn) return () => {}
  return fn(cb as (e: unknown) => void)
}

export async function generateDescription(taskId: string): Promise<string> {
  return electronAPI.ai.generateDescription({ taskId }) as Promise<string>
}

export async function startAutonomousGeneration(params: {
  taskId: string
  instruction: string
}): Promise<void> {
  return electronAPI.ai.startAutonomousGeneration(params)
}

export async function cancelGeneration(taskId: string): Promise<void> {
  return electronAPI.ai.cancelGeneration(taskId)
}

export async function confirmLogin(taskId: string): Promise<void> {
  return electronAPI.ai.confirmLogin(taskId)
}

export async function answerQuestion(questionId: string, answer: string): Promise<void> {
  return electronAPI.ai.answerQuestion(questionId, answer)
}

export function onGenerationProgress(cb: (event: GenerationProgressEvent) => void): () => void {
  return electronAPI.ai.onGenerationProgress(cb as (e: unknown) => void)
}

export async function getGenerationLogs(taskId: string): Promise<Array<{
  id: string
  task_id: string
  execution_id: string | null
  step_id: string | null
  phase: string
  message: string
  detail: string | null
  screenshot_path: string | null
  created_at: string
}>> {
  return electronAPI.ai.getGenerationLogs(taskId)
}

// ─── Profile ───

export async function listProfiles(): Promise<BrowserProfile[]> {
  return electronAPI.profile.list()
}

export async function createProfile(name: string): Promise<BrowserProfile> {
  return electronAPI.profile.create(name)
}

export async function deleteProfile(profileId: string): Promise<void> {
  return electronAPI.profile.delete(profileId)
}

export async function openProfileBrowser(profileId: string): Promise<void> {
  return electronAPI.profile.openBrowser(profileId)
}

// ─── Settings ───

export async function getProviders(): Promise<AiProviderConfig[]> {
  return electronAPI.settings.getProviders()
}

export async function saveProvider(config: AiProviderConfig): Promise<void> {
  return electronAPI.settings.saveProvider(config)
}

export async function deleteProvider(id: string): Promise<void> {
  return electronAPI.settings.deleteProvider(id)
}

export async function testProvider(config: AiProviderConfig): Promise<boolean> {
  return electronAPI.settings.testProvider(config) as Promise<boolean>
}

export async function fetchModels(params: {
  type: string
  apiKey: string
  baseUrl?: string
  /** Pass the provider id so the main process can resolve the masked API key from storage. */
  providerId?: string
}): Promise<string[]> {
  return electronAPI.settings.fetchModels(params) as Promise<string[]>
}

/**
 * Sentinel value used by `settings:getProviders` in place of the real API key.
 * Kept in sync with `API_KEY_MASK` in `src/main/ipc/settingsManager.ts`.
 */
export const API_KEY_MASK = '__STORED_API_KEY__'

export async function getGeneralSettings(): Promise<GeneralSettings> {
  return electronAPI.settings.getGeneral()
}

export async function saveGeneralSettings(settings: GeneralSettings): Promise<void> {
  return electronAPI.settings.saveGeneral(settings)
}

export async function getSystemLocale(): Promise<string> {
  return electronAPI.settings.getSystemLocale() as Promise<string>
}

export async function getUiLanguage(): Promise<'en' | 'ja'> {
  return electronAPI.settings.getUiLanguage() as Promise<'en' | 'ja'>
}

// ─── Screenshot ───

export async function readScreenshot(filePath: string): Promise<string> {
  return electronAPI.screenshot.read(filePath)
}

// ─── Desktop ───

export async function checkDesktopPermission(): Promise<{ supported: boolean; trusted: boolean }> {
  return electronAPI.desktop.checkPermission()
}

export async function isDesktopSupported(): Promise<boolean> {
  return electronAPI.desktop.isSupported()
}

export async function listDesktopWindows(): Promise<WindowInfo[]> {
  return electronAPI.desktop.listWindows()
}

export async function getAccessibilityTree(
  pidOrApp: number | string,
  depth?: number
): Promise<AXNode> {
  return electronAPI.desktop.getTree(pidOrApp, depth)
}

export async function desktopScreenshot(target?: { pid?: number }): Promise<string> {
  return electronAPI.desktop.screenshot(target)
}

// ─── Knowledge ───

export async function listKnowledge(): Promise<KnowledgeEntry[]> {
  return electronAPI.knowledge.list()
}

export async function getKnowledge(name: string): Promise<KnowledgeEntry | null> {
  return electronAPI.knowledge.get(name)
}

export async function saveKnowledge(entry: KnowledgeEntry): Promise<void> {
  return electronAPI.knowledge.save(entry)
}

export async function deleteKnowledge(name: string): Promise<void> {
  return electronAPI.knowledge.delete(name)
}

// ─── Element Picker ───

export interface ElementPickerResult {
  element: {
    role: string | null
    title: string | null
    value: string | null
    description: string | null
    position: { x: number; y: number } | null
    size: { width: number; height: number } | null
    path: string
    actions: string[]
  } | null
  point: { x: number; y: number }
  app?: string | null
  bundleId?: string | null
  pid?: number | null
  error?: string
  picking?: boolean  // true = waiting for user click
}

export function onElementPickerResult(cb: (result: ElementPickerResult) => void): () => void {
  return electronAPI.elementPicker.onResult(cb as (e: unknown) => void)
}
