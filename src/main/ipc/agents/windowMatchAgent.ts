// ─── Window Match Agent ───
// Uses AI to semantically match a task step to the correct macOS window.
// Replaces heuristic regex/string matching that failed with localized app names.

import type { AiProviderConfig, WindowInfo } from '../../../shared/types'
import { chatNonStream } from './aiChat'

export interface WindowMatchResult {
  pid: number | null
  appName: string
  launchName: string
  bundleId: string
  needsLaunch: boolean
}

export async function matchTargetWindow(
  config: AiProviderConfig,
  stepPlan: { name: string; description: string },
  windows: WindowInfo[],
  lastUsedAppName: string,
): Promise<WindowMatchResult> {
  const windowLines = windows.map(w =>
    `${w.pid} | ${w.app ?? ''} | ${w.title ?? ''} | ${w.bundleId ?? ''} | ${w.focused ? 'YES' : ''}`
  ).join('\n')

  const messages = [
    {
      role: 'system',
      content: `You identify which macOS window to operate on for desktop automation.
Given the task step and the list of open windows, pick the target window.

Return **only** the following JSON (no prose):
{"pid": <number or null>, "appName": "<display name>", "launchName": "<English name for open -a>", "bundleId": "<BundleID>", "needsLaunch": <true/false>}

Rules:
- If the step operates on an already-open app → return that window's PID, display name, and BundleID
- If the step requires launching a new app (not in the list) → pid=null, needsLaunch=true
- For appName, use the value from the "App" column as-is (keep Japanese text in Japanese)
- For launchName, return the English application name usable with \`open -a\`
  - You can infer it from BundleID (e.g. com.apple.calculator → Calculator, com.apple.TextEdit → TextEdit)
  - If no BundleID is available, infer a common English name
- For bundleId, use the value from the BundleID column as-is (empty string if unknown)
- Match semantically. Example: "計算機" and "Calculator" are the same app
- If a prior app was specified and the step continues operating on the same app, prefer that app
- If you cannot decide, pick the focused window (Focused=YES)`,
    },
    {
      role: 'user',
      content: `Step name: ${stepPlan.name}
Step description: ${stepPlan.description}
Previous app: ${lastUsedAppName || 'none'}

Window list:
PID | App | Title | BundleID | Focused
${windowLines}`,
    },
  ]

  try {
    const result = await chatNonStream(config, messages)
    const text = result.text.trim()

    // Extract JSON from response (handle markdown fences)
    const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/) || [null, text]
    const jsonStr = (jsonMatch[1] ?? text).trim()
    const parsed = JSON.parse(jsonStr)

    // Validate
    if (typeof parsed.appName !== 'string' || typeof parsed.needsLaunch !== 'boolean') {
      throw new Error('Invalid response format')
    }
    if (parsed.pid !== null && !windows.some(w => w.pid === parsed.pid)) {
      console.warn(`[windowMatchAgent] AI returned PID ${parsed.pid} not in window list, falling back`)
      throw new Error('PID not found in window list')
    }

    // Derive launchName from bundleId if AI didn't provide it
    let launchName = parsed.launchName ?? ''
    const bundleId = parsed.bundleId ?? ''
    if (!launchName && bundleId) {
      // Extract last segment of bundle ID as fallback: com.apple.calculator → calculator → Calculator
      const lastSegment = bundleId.split('.').pop() ?? ''
      launchName = lastSegment.charAt(0).toUpperCase() + lastSegment.slice(1)
    }
    if (!launchName) {
      launchName = parsed.appName // last resort
    }

    return {
      pid: parsed.pid ?? null,
      appName: parsed.appName,
      launchName,
      bundleId,
      needsLaunch: parsed.needsLaunch,
    }
  } catch (err) {
    console.warn(`[windowMatchAgent] AI matching failed, falling back to focused window:`, (err as Error).message)
    // Fallback: focused window or first window
    const focused = windows.find(w => w.focused) ?? windows[0]
    if (focused) {
      // Derive launchName from bundleId
      const bid = focused.bundleId ?? ''
      const lastSegment = bid.split('.').pop() ?? ''
      const launchName = lastSegment
        ? lastSegment.charAt(0).toUpperCase() + lastSegment.slice(1)
        : (focused.app ?? '')
      return { pid: focused.pid, appName: focused.app ?? '', launchName, bundleId: bid, needsLaunch: false }
    }
    return { pid: null, appName: lastUsedAppName || '', launchName: lastUsedAppName || '', bundleId: '', needsLaunch: true }
  }
}
