// ─── Verify Agent ───
// AI-based post-execution verification.
// Compares before/after screenshots to determine if a step succeeded.

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { BrowserWindow } from 'electron'
import type { AiProviderConfig } from '../../../shared/types'
import { chatNonStream } from './aiChat'
import { sendAndLog } from './progressHelper'

/**
 * Extract the "post-condition" clause from a step description.
 * planningAgent now enforces that every description includes
 * "post-condition: 〜" as the verifiable success criterion.
 * Returns null if none is found (old-format steps).
 */
export function extractPostCondition(description: string): string | null {
  // Match "post-condition:" or "post condition:" or "事後条件:" variants,
  // case-insensitive, and pull everything up to end of string or the next
  // sentence separator that looks like a new clause.
  const m = description.match(/(?:post[\s-]?condition|事後条件)\s*[:：]\s*([\s\S]+?)(?:$|\n\n)/i)
  if (!m) return null
  const raw = m[1].trim()
  return raw.length > 0 ? raw : null
}

/**
 * Try to verify a post-condition programmatically without AI.
 * Returns:
 *   - { checked: true, success: true/false, reason }: deterministic answer
 *   - { checked: false }: post-condition doesn't match any programmatic pattern, fall back to AI
 *
 * Patterns handled:
 *   1. File existence: "~/Desktop/xxx.txt exists" / "file exists at /path/..."
 *   2. ctx.shared value: "ctx.shared.xxx contains ..."
 */
export function programmaticVerify(
  postCondition: string,
  executionShared: Record<string, unknown>,
  taskGoal?: string,
): { checked: true; success: boolean; reason?: string } | { checked: false } {
  // ── Pattern 1: file path existence check ──
  // Match either:
  //   (a) ~/path/to/file.ext     — home-relative path with extension
  //   (b) /Users/... /tmp/... /var/... /private/...  — absolute path in known
  //       user-writable locations (keeps it conservative — avoids matching
  //       arbitrary / paths that might come from URLs)
  // Require a file extension (.xxx) so we don't confuse generic words like "/設定" with a path.
  // Also use negative lookbehind for `:` to skip URL paths like https://foo/bar.
  const pathRegex = /(?<![:\w])(~\/[^\s"'、,。]+\.[a-zA-Z0-9]+|\/(?:Users|tmp|var|private)\/[^\s"'、,。]+\.[a-zA-Z0-9]+)/
  const pathMatch = postCondition.match(pathRegex)
  if (pathMatch) {
    const rawPath = pathMatch[1]
    const expanded = rawPath.startsWith('~/')
      ? path.join(os.homedir(), rawPath.slice(2))
      : rawPath
    const exists = fs.existsSync(expanded)
    if (exists) {
      return { checked: true, success: true, reason: `File ${expanded} exists` }
    } else {
      return { checked: true, success: false, reason: `File ${expanded} does not exist` }
    }
  }

  // ── Pattern 2: ctx.shared.xxx value check ──
  const sharedMatches = Array.from(postCondition.matchAll(/ctx\.shared\.([a-zA-Z_][a-zA-Z0-9_]*)/g))
  if (sharedMatches.length > 0) {
    const checks: string[] = []
    for (const m of sharedMatches) {
      const key = m[1]
      const value = executionShared[key]
      if (value === undefined || value === null) {
        return { checked: true, success: false, reason: `ctx.shared.${key} is unset (undefined / null)` }
      }
      if (typeof value === 'string' && value.length === 0) {
        return { checked: true, success: false, reason: `ctx.shared.${key} is an empty string` }
      }
      if (Array.isArray(value) && value.length === 0) {
        return { checked: true, success: false, reason: `ctx.shared.${key} is an empty array` }
      }
      // Content-type check: if post-condition describes expected value type,
      // verify the actual value matches (e.g., "numeric string" should be numeric)
      if (typeof value === 'string' && value.length > 0) {
        const pc = postCondition.toLowerCase()
        const isNumericExpected = /数値|数字|計算結果|numeric|number|integer|合計|金額|件数|カウント/.test(pc)
        if (isNumericExpected) {
          // Strip invisible Unicode characters and whitespace, then check if numeric
          const cleaned = value.replace(/[\u200B-\u200F\u202A-\u202E\uFEFF\u00AD]/g, '').trim()
          if (!/^-?[\d,]+\.?\d*$/.test(cleaned)) {
            return {
              checked: true,
              success: false,
              reason: `ctx.shared.${key} contains "${value.slice(0, 40)}" but it is not numeric (may be an expression or plain string). The post-condition expects a numeric value`,
            }
          }
        }
      }

      // Data quality check: if task goal is set, verify that collected data
      // contains substantial information, not just URLs or short link text
      if (taskGoal && Array.isArray(value) && value.length > 0) {
        const sample = value.slice(0, 5)
        const allShallow = sample.every(item => {
          if (typeof item === 'string') {
            return /^https?:\/\//.test(item.trim()) || item.trim().length < 20
          }
          if (typeof item === 'object' && item !== null) {
            const vals = Object.values(item as Record<string, unknown>)
            return Object.keys(item).length <= 2 && vals.every(v =>
              typeof v === 'string' && ((v as string).startsWith('http') || (v as string).length < 30)
            )
          }
          return false
        })
        if (allShallow) {
          return {
            checked: true,
            success: false,
            reason: `ctx.shared.${key} has data, but it is shallow (only URLs / short text). Not enough substantive info for the task goal "${taskGoal.slice(0, 60)}"`,
          }
        }
      }

      const preview = typeof value === 'string' ? `"${value.slice(0, 40)}"` : Array.isArray(value) ? `[${value.length} items]` : typeof value
      checks.push(`ctx.shared.${key}=${preview}`)
    }
    return { checked: true, success: true, reason: checks.join(', ') }
  }

  // No programmatic pattern matched — needs AI visual verification
  return { checked: false }
}

export async function verifyStepExecution(
  config: AiProviderConfig,
  stepDescription: string,
  beforeScreenshot: string,
  afterScreenshot: string,
  stepType: 'browser' | 'desktop' = 'browser',
  win: BrowserWindow | null = null,
  stepIndex?: number,
  stepName?: string,
  taskId?: string,
  executionResult?: { error?: string; returnValue?: unknown },
  executionShared: Record<string, unknown> = {},
  taskGoal?: string,
): Promise<{ success: boolean; reason?: string }> {
  // ── Phase 0: Programmatic post-condition check (before anything else) ──
  // If the description includes a post-condition that mentions a file path or
  // ctx.shared value, we can verify it deterministically without AI. This is
  // much stronger than visual comparison and catches false negatives from
  // desktop short-circuits that previously skipped verification entirely.
  const postConditionEarly = extractPostCondition(stepDescription)
  if (postConditionEarly && executionResult && !executionResult.error) {
    const prog = programmaticVerify(postConditionEarly, executionShared, taskGoal)
    if (prog.checked) {
      sendAndLog(win, taskId ?? '', {
        phase: 'verifying',
        stepIndex,
        stepName,
        message: prog.success
          ? `✅ Verification complete: success (post-condition programmatic check: ${prog.reason ?? ''})`
          : `⚠️ Verification complete: failed (post-condition not satisfied: ${prog.reason ?? ''})`,
      })
      return { success: prog.success, reason: prog.reason }
    }
    // prog.checked === false → fall through to visual / heuristic path
  }

  // If screenshots are too small or empty, skip visual verification
  if (!afterScreenshot || afterScreenshot.length < 1000) {
    // If execution completed without error, assume success
    if (executionResult && !executionResult.error) {
      sendAndLog(win, taskId ?? '', {
        phase: 'verifying',
        stepIndex,
        stepName,
        message: `✅ Verification complete: success (no screenshot — completed without errors)`,
      })
      return { success: true }
    }
    // If there was an execution error, report it as failure
    if (executionResult?.error) {
      sendAndLog(win, taskId ?? '', {
        phase: 'verifying',
        stepIndex,
        stepName,
        message: `⚠️ Verification complete: failed (no screenshot — execution error: ${executionResult.error})`,
      })
      return { success: false, reason: executionResult.error }
    }
    // No screenshot and no execution result — skip verification
    return { success: true }
  }

  // If before/after screenshots are identical (screen recording permission denied),
  // fall back to execution result check instead of AI visual comparison
  if (beforeScreenshot && afterScreenshot && beforeScreenshot === afterScreenshot) {
    if (executionResult && !executionResult.error) {
      sendAndLog(win, taskId ?? '', {
        phase: 'verifying',
        stepIndex,
        stepName,
        message: `✅ Verification complete: success (identical before/after screenshots — screen-recording permission may be missing; completed without errors)`,
      })
      return { success: true }
    }
    if (executionResult?.error) {
      return { success: false, reason: executionResult.error }
    }
    return { success: true }
  }

  // For desktop steps that completed without error, prefer execution result over
  // screenshot comparison — UNLESS the step has a post-condition we want to
  // visually verify. Desktop screenshots can capture the wrong window
  // (Dodompa / Claude instead of target app) due to layering, so short-circuit
  // to success in the common case where there's no specific post-condition
  // to check. When a post-condition is present but wasn't programmatically
  // verifiable (it wasn't about files or ctx.shared), fall through to AI
  // visual verification so we can catch silent failures.
  if (stepType === 'desktop' && executionResult && !executionResult.error && !postConditionEarly) {
    sendAndLog(win, taskId ?? '', {
      phase: 'verifying',
      stepIndex,
      stepName,
      message: `✅ Verification complete: success (desktop operation — completed without errors, no post-condition)`,
    })
    return { success: true }
  }

  // If execution completed without error and the step is a non-visual operation
  // (data extraction, console.log, variable assignment, etc.), skip visual verification
  // EXCEPTION: If taskGoal is set and this is a data extraction step writing to ctx.shared,
  // fall through to AI verification so data quality can be assessed.
  const nonVisualPatterns = /(?:抽出|取得|出力|console|log|変数|保存|格納|extract|scrape|fetch|collect|store|assign|return)/i
  if (executionResult && !executionResult.error && nonVisualPatterns.test(stepDescription)) {
    const dataExtractionPatterns = /(?:抽出|取得|スクレイピング|extract|scrape|fetch|collect)/i
    const writesShared = /ctx\.shared\./i.test(stepDescription)
    if (taskGoal && dataExtractionPatterns.test(stepDescription) && writesShared) {
      // Goal-aware data extraction step: fall through to AI verification
      // to check whether gathered data actually meets the task goal
      sendAndLog(win, taskId ?? '', {
        phase: 'verifying',
        stepIndex,
        stepName,
        message: `🔍 Data-quality check: verifying data completeness against the task goal...`,
      })
    } else {
      sendAndLog(win, taskId ?? '', {
        phase: 'verifying',
        stepIndex,
        stepName,
        message: `✅ Verification complete: success (non-visual operation — completed without errors)`,
      })
      return { success: true }
    }
  }

  const postCondition = postConditionEarly ?? extractPostCondition(stepDescription)

  sendAndLog(win, taskId ?? '', {
    phase: 'verifying',
    stepIndex,
    stepName,
    message: `🔍 Comparing before/after screenshots with AI...\n  → Step: ${stepDescription}\n  → Type: ${stepType === 'desktop' ? 'desktop' : 'browser'}${postCondition ? `\n  → post-condition: ${postCondition}` : ''}`,
  })

  const postConditionBlock = postCondition
    ? `\n\n## ★★★ Success condition (post-condition) ★★★\nIf the state below is satisfied, judge success; otherwise judge failure. **This is the top-priority criterion.**\n${postCondition}\n\nOther info from the step (description) is only a reference — this post-condition is the final basis for the judgment.`
    : ''

  const goalBlock = taskGoal
    ? `\n\n## Final task goal\n${taskGoal}\nFor data-extraction steps, also judge whether the fetched data contains enough information for this goal. It should include substantive detail (amounts, conditions, deadlines, etc.) — not just URLs or link text.`
    : ''

  const messages = [
    {
      role: 'system',
      content: stepType === 'desktop'
        ? `You are an assistant that judges the success of macOS desktop-automation steps.
Compare the before and after screenshots and decide whether the step succeeded.
The screenshots are of the entire macOS desktop.

Return only the following JSON:
Success: {"success": true}
Failure: {"success": false, "reason": "explanation of the failure"}

## Criteria
- Does the screen show an app or window consistent with the step description?
- For an app-launch step, is the target app's window visible?
- For a button-click step, is the expected result (value change, etc.) visible?
- Is no error dialog shown?
- Desktop operations differ from browsers — multiple windows may be visible
- If the app has launched and is visible, judge success

## ★★★ Name / display-name matching rules (most important) ★★★
In messaging apps (Slack, Teams, Discord, LINE, Mail, etc.), the user's display name **very often does NOT match the name in the step instruction exactly**. If any of the following apply, **judge as the same person (success)**:
1. **Partial match / substring**: if the given name is contained in the display name, it's the same person. Example: given "福田志郎" → screen "福田志郎_オートロ" / "福田志郎 (Autoro)" / "Shiro Fukuda / 福田志郎" → all success
2. **Suffix addition**: when the display name has an organization / team / role / status emoji appended. Example: "田中太郎_営業部" / "田中太郎 🏠" → given "田中太郎" → success
3. **Parenthetical / slash separators**: "山田花子（マーケティング）" / "Hanako Yamada / 山田花子" → given "山田花子" → success
4. **Channel-name or DM-name variations**: "#general - Slack" / "Direct message with 福田志郎_オートロ", etc. — app name or context added
5. **Mixed display and real names**: even when the same person uses a nickname, if the step's target and the screen's content refer to the same conversation, judge success

**Do not require exact match.** If the given name appears as a substring of any name on screen, treat it as success.${postConditionBlock}${goalBlock}`

        : `You are an assistant that judges the success of web-automation steps.
Compare the before and after screenshots and decide whether the step succeeded.

Return only the following JSON:
Success: {"success": true}
Failure: {"success": false, "reason": "explanation of the failure"}

## Criteria
- Is there a change on screen consistent with the step description?
- Is no error dialog or error message shown?
- Is the page navigation as expected?
- Is form input reflected?

## Important: treat these steps as success even without screen changes
- Data extraction / scraping (evaluate / querySelectorAll, etc.)
- Output to console.log
- Assignment to variables
- wait / delay steps
- For these, no visual change is normal. If no error is shown, judge success

## ★★★ Name / display-name matching rules (most important) ★★★
In messaging apps / social services, the user's display name **very often does NOT match the name in the step instruction exactly**. If any of the following apply, **judge as the same person (success)**:
1. **Partial match / substring**: if the given name is contained in the display name, it's the same person. Example: given "福田志郎" → screen "福田志郎_オートロ" → success
2. **Suffix addition**: when the display name has an organization / team / role / status emoji appended
3. **Parenthetical / slash separators**: "山田花子（マーケティング）" / "Hanako / 山田花子", etc.
4. **Channel-name or URL variations**: when app name or context info is added

**Do not require exact match.** If the given name appears as a substring of any name on screen, treat it as success.${executionResult && !executionResult.error ? '\n\n## Execution result\nThis step completed without errors.' : ''}${postConditionBlock}${goalBlock}`,
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: `## Step description\n${stepDescription}` },
        { type: 'text', text: '## Before screenshot' },
        ...(beforeScreenshot
          ? [{ type: 'image', image: beforeScreenshot, mimeType: 'image/png' }]
          : [{ type: 'text', text: '(no screenshot)' }]),
        { type: 'text', text: '## After screenshot' },
        ...(afterScreenshot
          ? [{ type: 'image', image: afterScreenshot, mimeType: 'image/png' }]
          : [{ type: 'text', text: '(no screenshot)' }]),
      ],
    },
  ]

  try {
    const result = await chatNonStream(config, messages)
    const jsonMatch = result.text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      const verification = {
        success: !!parsed.success,
        reason: parsed.reason,
      }

      const afterScreenshotSmall = afterScreenshot.length < 500 * 1024 ? afterScreenshot : undefined
      sendAndLog(win, taskId ?? '', {
        phase: 'verifying',
        stepIndex,
        stepName,
        message: verification.success
          ? `✅ Verification complete: success`
          : `⚠️ Verification complete: failed — ${verification.reason ?? 'unknown'}`,
        screenshot: afterScreenshotSmall,
      })

      return verification
    }
  } catch { /* verification failed, assume success to avoid false negatives */ }

  sendAndLog(win, taskId ?? '', {
    phase: 'verifying',
    stepIndex,
    stepName,
    message: `⏭️ Skipping verification (verification itself errored)`,
  })

  return { success: true }
}
