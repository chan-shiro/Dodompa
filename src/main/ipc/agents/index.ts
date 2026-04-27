// ─── Agent Index ───
// Re-exports all agents for convenient importing.
//
// Agent roles:
//   aiChat          — AI chat utilities (streaming/non-streaming)
//   progressHelper  — Progress events to UI + DB logging
//   planningAgent   — Task decomposition into steps
//   analyzingAgent  — Page/desktop analysis (screenshots, selectors, AX tree)
//   actionPlanAgent — Structured action plan generation
//   selectorAgent   — Selector/element resolution & verification
//   codegenAgent    — TypeScript code generation from resolved actions
//   verifyAgent     — Post-execution AI verification (before/after screenshots)
//   replanAgent     — Step replanning on repeated failures
//   exploratoryPlanAgent — Multi-turn site exploration before planning

export { chatStream, chatNonStream } from './aiChat'
export { sendProgress, logGenerationStep, sendAndLog } from './progressHelper'
export { planSteps } from './planningAgent'
export { extractProducedSharedKeys } from './sharedKeysScanner'
export {
  extractPageSelectors,
  pruneHtmlForAi,
  formatAxTreeForAi,
  analyzeBrowserPage,
  analyzeDesktop,
  reanalyzeBrowser,
  reanalyzeDesktop,
} from './analyzingAgent'
export { generateActionPlan } from './actionPlanAgent'
export type { ActionPlanResult, StepResult } from './actionPlanAgent'
export {
  resolveActionSelectors,
  resolveDesktopActions,
} from './selectorAgent'
export type {
  ResolvedSelector,
  ActionPlan,
  ResolvedDesktopElement,
  ResolvedAction,
} from './selectorAgent'
export { matchTargetWindow } from './windowMatchAgent'
export type { WindowMatchResult } from './windowMatchAgent'
export { generateCodeFromResolvedActions, generateCodeFallback } from './codegenAgent'
export { verifyStepExecution } from './verifyAgent'
export { replanStep } from './replanAgent'
export type { ReplanDecision } from './replanAgent'
export {
  reconBrowserPage,
  scanBrowserPage,
  deriveUrlPatterns,
  formatSiteMapForPrompt,
  invalidateReconCache,
} from './reconAgent'
export type {
  SiteMap,
  SiteMapRawFacts,
  SiteMapLink,
  SiteMapButton,
  SiteMapInput,
  SiteMapForm,
  SiteMapHeading,
  SubPageFinding,
  ReconOptions,
} from './reconAgent'
export { patchStepCode, patchStepCodeForRunner, applyPatches, parsePatches } from './patchCodeAgent'
export type { CodePatch } from './patchCodeAgent'
export {
  diagnoseFailure,
  suggestUntriedStrategies,
  describeAttemptedStrategy,
  formatLedgerForPrompt,
} from './failureDiagnosis'
export type {
  FailureCategory,
  FailureDiagnosis,
  StrategyAttempt,
  StrategyLedger,
} from './failureDiagnosis'
