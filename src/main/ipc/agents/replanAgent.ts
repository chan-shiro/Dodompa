// ─── Replan Agent ───
// When a step fails repeatedly, this agent analyzes the situation
// and decides to split, replace, or skip the step.

import type { BrowserWindow } from 'electron'
import type { AiProviderConfig, StepPlan } from '../../../shared/types'
import { chatNonStream } from './aiChat'
import { sendProgress } from './progressHelper'

export interface ReplanDecision {
  action: 'split' | 'replace' | 'skip' | 'retry_previous'
  steps?: StepPlan[]
  step?: StepPlan
  reason?: string
  /** How many steps to go back (default: 1). Only used when action === 'retry_previous'. */
  goBackSteps?: number
}

export async function replanStep(
  config: AiProviderConfig,
  win: BrowserWindow | null,
  stepPlan: StepPlan,
  stepIndex: number,
  stepType: 'browser' | 'desktop',
  lastError: string,
  errorHistory: Array<{ attempt: number; error: string; selectors: string[] }>,
  maxRetries: number,
  errorScreenshot: string,
  errorHtml: string,
): Promise<ReplanDecision | null> {
  sendProgress(win, {
    phase: 'fixing', agent: 'replan',
    stepIndex,
    stepName: stepPlan.name,
    message: `🔄 Failed ${maxRetries} times — replanning step...`,
  })

  const replanMessages = [
    {
      role: 'system',
      content: `You are a task-automation planner.
A step has failed ${maxRetries} fix attempts and still does not run.
This step's type is "${stepType}".

Return the best course of action as JSON, choosing from:

1. Split the step: {"action": "split", "steps": [{"name": "...", "description": "...", "type": "${stepType}"}, ...]}
2. Replace the step: {"action": "replace", "step": {"name": "...", "description": "...", "type": "${stepType}"}}
3. Skip the step: {"action": "skip", "reason": "..."}
4. Go back and retry an earlier step: {"action": "retry_previous", "reason": "...", "goBackSteps": 1}
   - Choose this when the cause of the error is **a failed earlier step** (e.g. ctx.shared data is empty, a prior step failed to write correctly, etc.)
   - goBackSteps: how many steps to go back (default: 1)

Important: any step returned by split / replace must include "type": "${stepType}".
${stepType === 'desktop' ? 'Desktop operations cannot use Playwright or the browser. Only the DesktopContext API (hotkey, type, click, activateApp, etc.) is available.' : ''}
Analyze the current screen state and error history, and consider why it keeps failing.`,
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Failed step: ${stepPlan.name}\nDescription: ${stepPlan.description}\n\nLast error: ${lastError}\n\nFull error history:\n${errorHistory.map(h => `Attempt ${h.attempt}: ${h.error}\nSelectors tried: ${h.selectors.join(', ')}`).join('\n')}`,
        },
        ...(errorScreenshot
          ? [{ type: 'image', image: errorScreenshot, mimeType: 'image/png' }]
          : []),
        {
          type: 'text',
          text: `Current HTML:\n${errorHtml.slice(0, 3000)}`,
        },
      ],
    },
  ]

  try {
    const replanResult = await chatNonStream(config, replanMessages)
    const jsonMatch = replanResult.text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const decision = JSON.parse(jsonMatch[0]) as ReplanDecision
      return decision
    }
  } catch { /* replan failed */ }

  return null
}
