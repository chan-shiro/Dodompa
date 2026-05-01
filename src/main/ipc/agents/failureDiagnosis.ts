// ─── Failure Diagnosis Agent ───
// Categorizes step failures by root cause so that the retry loop can
// (a) tell the AI *where* the previous attempt broke, and
// (b) maintain a ledger of what has/hasn't been tried across retries.
//
// Problem this solves:
//   Passing raw error strings to the AI on retry makes it guess at what
//   changed, and it often retries the same failed strategy with cosmetic
//   tweaks. By diagnosing the failure category and tracking a strategy
//   ledger, the AI can be instructed explicitly: "strategies X, Y were
//   tried and failed for reason Z — pick something from the untried list".

import type { AiProviderConfig } from '../../../shared/types'
import type { ResolvedAction, ActionPlan } from './selectorAgent'
import { chatNonStream } from './aiChat'
import { buildRuntimeContext } from './buildRuntimeContext'

// ─── Categories of failure ───

export type FailureCategory =
  | 'selector_resolution_failed' // actionPlan produced axRole/axTitle that selectorAgent couldn't find in the AX tree
  | 'element_not_found_runtime'  // generated code's findElement/locator returned null/0 at runtime
  | 'action_execution_error'     // click/type/hotkey/shell threw (permissions, wrong app focus, AXPress on text field, etc.)
  | 'step_timeout'               // step exceeded meta.timeout — state likely didn't change as expected
  | 'verification_failed'        // code ran without throwing, but verifyAgent judged the after-screenshot as wrong state
  | 'code_compile_error'         // esbuild/import failed — generated code is malformed
  | 'code_validation_failed'     // generated code missing `run` function or other shape checks
  | 'precondition_not_met'       // wrong window frontmost, app not launched, previous step failed leaving bad state
  | 'ambiguous_input'            // ctx.input value couldn't be resolved (placeholder leaked through)
  | 'data_extraction_failed'     // step's own code threw because a value read from the app (AX value, pbpaste, scraped text) was empty/missing
  | 'unknown'

export interface FailureDiagnosis {
  attempt: number
  category: FailureCategory
  where: string           // short human-readable pointer: "click_element axTitle='7'", "verifyAgent", "esbuild", etc.
  rawError: string        // original error message
  evidence: string[]      // concrete clues pulled out of the error / code / resolvedActions
  hypothesis: string      // one sentence: why this most likely happened
}

export interface StrategyAttempt {
  attempt: number
  strategy: string        // short descriptor like "click_element via AXButton 'equals'"
  category: FailureCategory
  hypothesis: string
}

export interface StrategyLedger {
  tried: StrategyAttempt[]
  untried: string[]       // strategy suggestions generated from the diagnosis
}

// ─── Diagnose a single failure ───

interface DiagnoseInput {
  attempt: number
  rawError: string
  stage: 'compile' | 'execute' | 'verify'
  verifyReason?: string
  code?: string
  resolvedActions?: ResolvedAction[]
  stepType: 'browser' | 'desktop'
}

export function diagnoseFailure(input: DiagnoseInput): FailureDiagnosis {
  const { rawError, stage, verifyReason, code, resolvedActions, stepType } = input
  const err = (rawError ?? '').toLowerCase()
  const evidence: string[] = []

  // ── Pre-execution failures ──
  if (stage === 'compile') {
    if (/cannot find module|module not found|import|esbuild|syntaxerror/i.test(rawError)) {
      return {
        attempt: input.attempt,
        category: 'code_compile_error',
        where: 'esbuild/import',
        rawError,
        evidence: [rawError.split('\n')[0]],
        hypothesis: 'Import or syntax error in generated code. Type definition or syntax mistake.',
      }
    }
    return {
      attempt: input.attempt,
      category: 'code_validation_failed',
      where: 'code shape check',
      rawError,
      evidence: [],
      hypothesis: 'AI did not return valid TypeScript code with a run function.',
    }
  }

  // ── Verification failures (code ran, but the after-state is wrong) ──
  if (stage === 'verify') {
    return {
      attempt: input.attempt,
      category: 'verification_failed',
      where: 'verifyAgent (after-screenshot compare)',
      rawError,
      evidence: verifyReason ? [`verifier: ${verifyReason}`] : [],
      hypothesis:
        'Code ran to completion without exceptions, but the screen state after execution does not match the step\'s intended goal.'
        + ' Suspect: incorrect click target, wrong branch in conditional logic, or wrong target window.',
    }
  }

  // ── Runtime execution failures ──
  if (/timed out|timeout/i.test(err)) {
    evidence.push('timeout error')
    return {
      attempt: input.attempt,
      category: 'step_timeout',
      where: 'run() execution',
      rawError,
      evidence,
      hypothesis:
        'Processing did not complete within meta.timeout.'
        + ' Possible causes: infinite loop, awaited element never appeared, or target window could not be obtained.',
    }
  }

  if (/\bplaceholder_\w+|__placeholder/.test(rawError) || /\bplaceholder_\w+/.test(code ?? '')) {
    return {
      attempt: input.attempt,
      category: 'ambiguous_input',
      where: 'ctx.input resolution',
      rawError,
      evidence: ['placeholder remains in code / leaked at runtime'],
      hypothesis: 'ctx.input.XXX is used without a default value, or the AI did not hardcode the value.',
    }
  }

  // Missing data from previous step (ctx.shared.xxx is undefined/empty).
  // This MUST be checked BEFORE the generic "window not found" pattern below,
  // because error messages like "保存するCSVデータが見つかりません" otherwise get
  // misclassified as a window lookup failure.
  //
  // IMPORTANT: negative-guard on ウィンドウ/window/アプリ/app/pid/bundleId so we
  // don't capture "Mail ウィンドウが見つかりません" or "Calculator app not found"
  // which are actually window-lookup failures, not cross-step data handoff.
  const isCrossStepDataIssue =
    !(/ウィンドウ|\bwindow\b|\bapp\b|アプリ|\bpid\b|bundleid|process|プロセス/i.test(rawError))
    && (
      /(?:データ|csv|json|結果|一覧|content|値|array|list|result|payload|parsed|extracted)[^\n]{0,40}(?:が|is|was)?[^\n]{0,10}(?:見つかりません|見つからない|not\s*found|undefined|empty|空|null|ありません)/i.test(rawError)
      || /(?:前のステップ|previous\s*step|earlier\s*step|prior\s*step)/i.test(rawError)
      || /ctx\.shared\./i.test(rawError)
    )
  if (isCrossStepDataIssue) {
    evidence.push(
      'Data from previous step is not visible in the current step',
      rawError.match(/ctx\.shared\.\w+/)?.[0] ?? '',
    )
    return {
      attempt: input.attempt,
      category: 'precondition_not_met',
      where: 'ctx.shared (cross-step data handoff)',
      rawError,
      evidence: evidence.filter(Boolean),
      hypothesis:
        'Data written to ctx.shared.xxx by the previous step cannot be read in this step.'
        + ' Possible causes:'
        + ' (1) The previous step\'s test execution actually failed (verifyAgent marked it success but data was not written).'
        + ' (2) The previous step\'s code only used console.log instead of writing to ctx.shared.xxx.'
        + ' (3) shared data is not being passed between steps (known bug in generation-time test execution -- re-verify if fixed).'
        + ' Fix: Check the previous step\'s code to ensure it saves data as ctx.shared.<key> = value.'
        + ' This step should attempt to re-fetch data on its own rather than throwing if (!ctx.shared.xxx) throw new Error(...).',
    }
  }

  if (stepType !== 'browser'
      && /window|not found|見つかりません|見つからない|ウィンドウ|見当たりません|起動していません|is not running|not launched/i.test(rawError)
      && !/locator|element|selector/i.test(err)
      // Negative guard: if the error is specifically about a file/path/directory/URL/data
      // OR a web element (link/button/field/input/anchor), it's NOT a window lookup —
      // let later branches handle it (or fall through to unknown).
      && !/(?:ファイル|file|path|ディレクトリ|directory|folder|フォルダ|url|エンドポイント|endpoint|データ|data|csv|json|xml|image|画像|スクリーンショット|screenshot|output|パス|no such file|enoent)/i.test(rawError)
      && !/(?:リンク|link|anchor|ボタン|button|要素|element|テキストボックス|入力欄|フィールド|\bfield\b|チェックボックス|checkbox|ラジオボタン|radio|セレクト|select|ドロップダウン|dropdown|メニュー|menu\s*item|タブ|tab|見出し|heading|画像|image|img|cell|row|column|列|行|セル)/i.test(rawError)) {
    // Try to extract the app name the code was looking for
    const appMatch = rawError.match(/^([\w\u3040-\u30ff\u3400-\u9fff]+)\s*(?:ウィンドウ|window|アプリ|app)/i)
    const soughtApp = appMatch?.[1]
    // If the sought app is a well-known English name of a macOS app that uses a
    // Japanese display name in Japanese locale, flag this as a locale-mismatch
    // hard-coded app name bug (a repeat-offender pattern).
    const englishToJa: Record<string, string> = {
      'mail': 'メール',
      'calculator': '計算機',
      'calendar': 'カレンダー',
      'messages': 'メッセージ',
      'reminders': 'リマインダー',
      'notes': 'メモ',
      'contacts': '連絡先',
      'terminal': 'ターミナル',
      'system settings': 'システム設定',
      'system preferences': 'システム環境設定',
      'finder': 'Finder',
      'safari': 'Safari',
      'photos': '写真',
      'maps': 'マップ',
      'weather': '天気',
      'clock': '時計',
      'music': 'ミュージック',
      'tv': 'TV',
      'podcasts': 'ポッドキャスト',
      'books': 'ブック',
    }
    const englishKey = (soughtApp ?? '').toLowerCase()
    const jaName = englishToJa[englishKey]
    if (jaName) {
      evidence.push(
        `Hardcoded English app name "${soughtApp}" appears as "${jaName}" in w.app under Japanese locale`,
        `Generated code is likely using strict comparison w.app === "${soughtApp}"`,
      )
      return {
        attempt: input.attempt,
        category: 'precondition_not_met',
        where: 'getWindows() / locale-mismatched app name',
        rawError,
        evidence,
        hypothesis:
          `Generated code uses strict English name comparison like \`windows.find(w => w.app === "${soughtApp}")\`, `
          + `but in Japanese locale w.app returns "${jaName}", so it never matches.`
          + ` Fix: (1) Compare by bundleId (highest priority, locale-independent). Example: w.bundleId === "com.apple.${englishKey.replace(/\s+/g,'')}"`
          + ` (2) OR comparison with multiple names: w.bundleId === "com.apple.mail" || w.app === "メール" || w.app === "Mail"`
          + ` (3) Partial match: w.app?.toLowerCase().includes("${englishKey}") || w.app?.includes("${jaName}")`
          + ` This category of error will keep repeating unless strict English name comparison is abandoned.`,
      }
    }

    evidence.push(`Window/app not detected${soughtApp ? ` (searched name: "${soughtApp}")` : ''}`)
    return {
      attempt: input.attempt,
      category: 'precondition_not_met',
      where: 'getWindows() / app lookup',
      rawError,
      evidence,
      hypothesis:
        'Target app window not found in getWindows() results.'
        + ' Common causes:'
        + ' (1) App name is locale-dependent (e.g. "計算機" instead of "Calculator").'
        + ' (2) Strict match (w.app === "X") only matches one locale variant.'
        + ' (3) Insufficient wait time right after open -a execution.'
        + ' Fix: Use bundleId (e.g. "com.apple.calculator") as well, or search leniently with w.app?.includes() / w.bundleId?.includes().',
    }
  }

  if (stepType === 'desktop' && /-25\d{3}|axerror|accessibility/i.test(err)) {
    evidence.push(rawError.match(/-25\d{3}/)?.[0] ?? 'AX error')
    return {
      attempt: input.attempt,
      category: 'action_execution_error',
      where: 'AX performAction',
      rawError,
      evidence,
      hypothesis:
        'AX action execution was rejected.'
        + ' AXPress is not allowed on AXTextField/AXTextArea (-25206), target element does not support the action, insufficient accessibility permissions, etc.',
    }
  }

  // Browser-side "<web-element> が見つかりません" thrown by generated code after a
  // locator lookup failed. Without this branch, the generic window-lookup regex above
  // used to swallow these into precondition_not_met (even though stepType='browser'),
  // feeding desktop-app fix strategies into a web task.
  if (stepType === 'browser'
      && /(?:リンク|link|anchor|ボタン|button|要素|element|テキストボックス|入力欄|フィールド|\bfield\b|チェックボックス|checkbox|ラジオボタン|radio|セレクト|select|ドロップダウン|dropdown|メニュー|menu\s*item|タブ|tab|見出し|heading|画像|image|img|cell|row|column)[^\n]{0,60}(?:が|is|was)?\s*(?:見つかりません|見つからない|not\s*found|見当たりません|ありません|存在しません|does\s*not\s*exist)/i.test(rawError)) {
    const labelMatch = rawError.match(/[「『"']([^「『"'\n]{1,80})[」』"']/)
    if (labelMatch) evidence.push(`Searched label: "${labelMatch[1]}"`)
    evidence.push('Element lookup failure in browser step')
    return {
      attempt: input.attempt,
      category: 'element_not_found_runtime',
      where: 'browser locator lookup',
      rawError,
      evidence,
      hypothesis:
        'Playwright locator could not find the target web element.'
        + ' Common causes:'
        + ' (1) Label/text guessed by the AI does not match the actual page (gap between generation-time and live site).'
        + ' (2) Label was generated dynamically via ctx.ai() and did not return in the expected format (e.g. asked for a zodiac sign but got an error message).'
        + ' (3) SPA lazy rendering -- domcontentloaded is not sufficient.'
        + ' (4) Element is inside an iframe.'
        + ' Fix: (a) console.log the locator value to verify against the actual page. (b) Always validate ctx.ai() output against an expected-value enum before using it. (c) First enumerate existing candidates with page.locator("a, button").allTextContents() and then select.',
    }
  }

  if (/findelement|axnode|element.*null|querySelector.*null|locator.*0/i.test(err)) {
    evidence.push('Element lookup returned null/0 results')
    return {
      attempt: input.attempt,
      category: 'element_not_found_runtime',
      where: 'findElement / locator at runtime',
      rawError,
      evidence,
      hypothesis:
        'Target element could not be found in the AX tree or DOM at runtime.'
        + ' Suspected causes: role/title mismatch, shallow tree (Electron/WebView), fetched before state transition, or locale discrepancy.',
    }
  }

  // Look at resolved actions for selector-level failures surfaced pre-run
  const unresolved = resolvedActions?.filter(ra => ra.unresolved) ?? []
  if (unresolved.length > 0 && /unresolved|未解決/i.test(rawError)) {
    for (const u of unresolved.slice(0, 3)) {
      evidence.push(`Unresolved: ${u.action.axRole ?? ''} "${u.action.axTitle ?? u.action.selectorHint ?? ''}"`)
    }
    return {
      attempt: input.attempt,
      category: 'selector_resolution_failed',
      where: 'selectorAgent',
      rawError,
      evidence,
      hypothesis:
        'Elements specified by the action plan do not exist in the AX tree/DOM.'
        + ' The AI is likely guessing label names.',
    }
  }

  // File / path not found (enoent, screenshot file missing, etc.)
  if (/enoent|no\s*such\s*file|ファイルが見つかりません|ファイルが存在しません|スクリーンショットファイルが見つかりません|パスが見つかりません|no\s*such\s*directory|ディレクトリが見つかりません/i.test(rawError)) {
    const pathMatch = rawError.match(/['"]([^'"]*\.[a-z0-9]{2,5})['"]/i)
    evidence.push(
      'File/path does not exist',
      ...(pathMatch ? [`Referenced path: ${pathMatch[1]}`] : []),
    )
    return {
      attempt: input.attempt,
      category: 'action_execution_error',
      where: 'filesystem path resolution',
      rawError,
      evidence,
      hypothesis:
        'File does not exist at the expected path.'
        + ' Possible causes:'
        + ' (1) Previous command wrote output to a different location (e.g. screencapture saved to a different location per defaults).'
        + ' (2) Filename differs from expectation (sequence number, datetime, extension mismatch).'
        + ' (3) Relative vs absolute path / tilde expansion inconsistency.'
        + ' (4) Previous command failed, so the file was never created.'
        + ' Fix: console.log the path and verify on the actual machine. Check directory contents with ls / find. For screencapture, specify the output path directly with -x <path>.',
    }
  }

  // Blocking modal dialog hang (display dialog / display alert / choose from list ...)
  // This is a critical repeat-offender pattern: the AI uses display dialog to "show
  // info to the user", the dialog blocks forever, osascript times out, the error text
  // contains the offending AppleScript (which the AI then regenerates almost verbatim
  // on retry), and stacked modal dialogs obscure the real UI.
  if (/display\s+(dialog|alert)|choose\s+(from\s+list|file|folder)|prompt\s*\(/i.test(rawError)) {
    const isDialog = /display\s+dialog/i.test(rawError)
    const isAlert = /display\s+alert/i.test(rawError)
    const isChoose = /choose\s+(from\s+list|file|folder)/i.test(rawError)
    evidence.push(
      isDialog ? 'Uses AppleScript `display dialog`' :
      isAlert ? 'Uses AppleScript `display alert`' :
      isChoose ? 'Uses AppleScript `choose from list/file/folder` interactive picker' :
      'Uses a blocking interactive API',
      'Generated code blocks on a human-facing modal -> timeout -> error',
      'On retry, previous dialogs remain on screen and stack with new ones, obstructing the target app',
    )
    return {
      attempt: input.attempt,
      category: 'action_execution_error',
      where: 'osascript / display dialog (blocking modal)',
      rawError,
      evidence,
      hypothesis: 'Generated code contains **human-facing modals** like `display dialog` / `display alert` / `choose from list`, and it hangs because no one clicks the button. These APIs must never be used in automation.'
        + ' -> Replace information display with console.log / ctx.shared.xxx = ... Do not use modals at all.'
        + ' Additionally, if dialogs have already stacked up on screen, clear them with Escape or Return keys before re-executing.',
    }
  }

  // AppleScript date literal parse failure (-30720 日付と時刻が無効です)
  if (/-30720|日付と時刻が無効|invalid date|can.?t make.*date/i.test(rawError)) {
    const dateLiteralMatch = rawError.match(/date\s+["']?([^"'\n]+?)["']?\s*\(?-30720/i)
      ?? rawError.match(/date\s+["']([^"']+)["']/i)
    evidence.push(
      'Invalid literal was passed to AppleScript date "..."',
      ...(dateLiteralMatch ? [`Failed literal: "${dateLiteralMatch[1]}"`] : []),
    )
    return {
      attempt: input.attempt,
      category: 'action_execution_error',
      where: 'AppleScript date literal',
      rawError,
      evidence,
      hypothesis:
        'AppleScript date "..." **does not interpret natural language**. Passing strings like "tomorrow 10:00 AM", "next Monday", etc. directly causes error -30720.'
        + ' Fix: Create and calculate the date with new Date() on the JavaScript side, then build it using the AppleScript set year/month/day/hours/minutes pattern:'
        + '\n  const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0);'
        + '\n  const script = `set theDate to (current date)\\n'
        + 'set year of theDate to ${d.getFullYear()}\\n'
        + 'set month of theDate to ${d.getMonth() + 1}\\n'
        + 'set day of theDate to ${d.getDate()}\\n'
        + 'set hours of theDate to ${d.getHours()}\\n'
        + 'set minutes of theDate to ${d.getMinutes()}\\n'
        + 'set seconds of theDate to 0\\n...`;'
        + ' This is the most robust pattern that does not depend on JS or AppleScript locale settings.',
    }
  }

  // AppleScript / osascript dictionary or permission failures
  // -1728: errAENoSuchObject — app has no such dictionary entry (wrong app for AppleScript data ops)
  // -1743: errAEEventNotPermitted — sandboxed app blocks AppleScript
  // -10000 / -10006: object type mismatch / can't set
  // "execution error" + "not allowed" + "-1728/-1743" patterns
  if (/(-1728|-1743|-10000|-10006)|errAENoSuchObject|errAEEventNotPermitted|Application isn['']t running/i.test(rawError)
      || (/osascript|applescript|execution error/i.test(rawError)
          && /can't|couldn't|not allowed|doesn't understand|unknown/i.test(err))) {
    const codeMatch = rawError.match(/-(1728|1743|10000|10006)/)
    const appMatch = rawError.match(/application\s+["']([^"']+)["']/i)
    evidence.push(
      codeMatch ? `AppleScript error code: -${codeMatch[1]}` : 'AppleScript execution error',
      ...(appMatch ? [`Target app: ${appMatch[1]}`] : []),
    )
    const hypothesisMap: Record<string, string> = {
      '1728': 'The command/object does not exist in the target app\'s Scripting Dictionary. Likely sending make new / set to an app outside the allowlist (Slack, Notion, etc.).',
      '1743': 'AppleScript was rejected by the sandbox. Either not permitted in System Settings > Privacy & Security > Automation, or the app is sandboxed from the App Store and cannot be scripted.',
      '10000': 'AppleScript object type mismatch. Syntax error or type definition does not match the dictionary.',
      '10006': 'That property is read-only and cannot be set.',
    }
    return {
      attempt: input.attempt,
      category: 'action_execution_error',
      where: 'osascript / AppleScript',
      rawError,
      evidence,
      hypothesis: codeMatch
        ? hypothesisMap[codeMatch[1]]
          + ' -> Abandon the AppleScript approach and switch to AX tree clicks + keyboard shortcuts + clipboard paste.'
        : 'AppleScript execution failed. Command not in dictionary / wrong argument types / app not running. Consider switching to the AX tree approach.',
    }
  }

  // JavaScript/TypeScript runtime errors (ReferenceError / TypeError / SyntaxError)
  // These are code-level bugs in the generated step: undeclared variables,
  // missing imports, wrong property access, typos. The AI will re-generate the
  // same bug unless told specifically what's wrong.
  if (/\bis not defined\b|referenceerror|cannot\s+read\s+propert(?:y|ies)|cannot\s+access|is not a function|is not iterable|undefined\s+is not|typeerror|syntaxerror/i.test(rawError)) {
    const notDefMatch = rawError.match(/(\w+)\s+is not defined/)
    const propMatch = rawError.match(/(?:read|access).+?['"`](\w+)['"`].+?of\s+(undefined|null)/)
    const notFnMatch = rawError.match(/(\w+(?:\.\w+)*)\s+is not a function/)

    const varName = notDefMatch?.[1]
    const propName = propMatch?.[1]
    const fnName = notFnMatch?.[1]

    evidence.push(
      notDefMatch ? `Undefined identifier: "${varName}"` :
      propMatch ? `Property access on undefined/null: "${propName}"` :
      notFnMatch ? `Called non-function: "${fnName}"` :
      'JavaScript-level error in generated code',
    )

    let hypothesis = 'JavaScript runtime error in generated code.'
    if (varName === 'require') {
      hypothesis +=
        ` require() cannot be used in an ESM environment. This code is compiled as ESM (ES Modules),`
        + ` so require('fs') and require('child_process') will not work.`
        + ` Next attempt: Rewrite all require() calls to ESM imports.`
        + ` Example: import fs from 'fs'; import { execSync } from 'child_process'; import path from 'path'; import os from 'os';`
      evidence.push('Using CommonJS require() in ESM environment -> must switch to import')
    } else if (varName) {
      hypothesis +=
        ` Identifier "${varName}" is not declared. Possible causes:`
        + ` (1) Forgot to declare with const/let.`
        + ` (2) Out of scope (referencing a variable from inside a for/if block outside of it).`
        + ` (3) Typo (e.g. filesize vs fileSize).`
        + ` (4) Missing import (e.g. import fs from 'fs'). Note: require() is not available -- always use ESM import.`
        + ` Next attempt: Declare all needed variables with const at the top of the code. Keep declarations and usage in the same scope. List all variables needed before implementing.`
    } else if (propName) {
      hypothesis +=
        ` Accessing ".${propName}" on an undefined or null value. Possible causes:`
        + ` (1) ctx.shared.xxx from the previous step does not exist.`
        + ` (2) API/CLI return value has a different structure than expected.`
        + ` (3) Array/object contents are empty.`
        + ` Fix: Add ?? / ?. / if (x) guards before access. Verify ctx.shared.xxx exists.`
    } else if (fnName) {
      hypothesis +=
        ` "${fnName}" is not a function. Possible typo, missing import, or calling on the wrong object.`
    } else {
      hypothesis += ' Read the code from the top and verify types and declarations.'
    }

    return {
      attempt: input.attempt,
      category: 'action_execution_error',
      where: 'generated code (JavaScript runtime error)',
      rawError,
      evidence,
      hypothesis,
    }
  }

  // Playwright browser context closed / target crashed
  if (/target\s+(page|context|browser).*?(closed|crashed)|page\.goto:.*closed|browser.*has been closed|execution context was destroyed|target closed/i.test(rawError)) {
    evidence.push('Playwright browser/context/page was closed during execution')
    return {
      attempt: input.attempt,
      category: 'action_execution_error',
      where: 'Playwright context lifecycle',
      rawError,
      evidence,
      hypothesis:
        'Attempted to operate on a browser/page that is already closed. Possible causes:'
        + ' (1) Previous step called page.close() / context.close().'
        + ' (2) Browser crash (out of memory, invalid page).'
        + ' (3) User manually closed the Playwright window.'
        + ' (4) Navigation cancellation during transition.'
        + ' (5) Step type is browser but the code expects Apple Safari while Chromium launched.'
        + ' Fix: (a) Change this step to **desktop type + AppleScript (tell application "Safari" to open location)**.'
        + ' (b) If browser is needed, check the flag for retaining the Playwright context.'
        + ' (c) Verify page is alive before execution: if (!page || page.isClosed()) { throw new Error("page closed") }',
    }
  }

  // Shell / subprocess failures (python3, osascript, open, etc.)
  if (/command failed|modulenotfounderror|no module named|osascript.*error|execfileasync/i.test(rawError)) {
    const moduleMatch = rawError.match(/No module named ['"]([^'"]+)['"]/)
    const cmdMatch = rawError.match(/Command failed:\s*(\S+)/)
    evidence.push(
      cmdMatch ? `Failed command: ${cmdMatch[1]}` : 'Shell subprocess failure',
      ...(moduleMatch ? [`Missing module: ${moduleMatch[1]}`] : []),
    )
    return {
      attempt: input.attempt,
      category: 'action_execution_error',
      where: cmdMatch ? `shell: ${cmdMatch[1]}` : 'shell subprocess',
      rawError,
      evidence,
      hypothesis:
        'Shell/python/osascript subprocess inside DesktopContext failed.'
        + (moduleMatch ? ` Python module ${moduleMatch[1]} (pyobjc, etc.) is not installed.` : '')
        + ' Likely called via desktop.type() or desktop.pressKey().'
        + ' Consider switching to an alternative approach, such as calling AppleScript "tell application \\"System Events\\" to keystroke" directly via execFile(\'osascript\', ...).',
    }
  }

  // Data extraction failure: step's own code threw because a value read from the
  // target app came back empty/null. Examples we've seen in the wild:
  //   "計算機のディスプレイ値を取得できませんでした"
  //   "検索結果のテキストが空でした"
  //   "could not read clipboard" / "pbpaste returned empty"
  //   "extracted value was empty"
  // These are user-thrown Error()s inside the generated step code, not
  // framework errors, so they don't match any of the earlier patterns. We
  // classify them here so the retry loop can suggest alternate extraction
  // paths (clipboard, AX subtree walk, AppleScript value-of, OCR, etc.).
  if (
    /取得(?:でき(?:ません|ない))(?:でした)?|取れ(?:ません|ない)(?:でした)?|読み(?:取れ|込め)(?:ません|ない)(?:でした)?/.test(rawError)
    || /(?:値|結果|テキスト|内容|データ|ディスプレイ|表示|出力|output|clipboard|pbpaste|display|content|value|text|result)[^\n]{0,30}(?:が|is|was)?\s*(?:空|empty|null|undefined|ありません|見つかりません|not\s*found|not\s*available)/i.test(rawError)
    || /could\s+not\s+(?:get|retrieve|read|extract|fetch|obtain|parse)/i.test(rawError)
    || /failed\s+to\s+(?:get|retrieve|read|extract|fetch|obtain|parse)/i.test(rawError)
    || /(?:returned|gave|produced|yielded)\s+(?:empty|nothing|null|undefined)/i.test(rawError)
    || /pbpaste[^\n]{0,20}(?:empty|空|nothing)/i.test(rawError)
  ) {
    const keyword = rawError.match(/(ディスプレイ|display|clipboard|pbpaste|結果|テキスト|value|出力|output|value of)/i)?.[1]
    evidence.push(
      `Custom exception: ${rawError.split('\n')[0].slice(0, 120)}`,
      ...(keyword ? [`Extraction target keyword: ${keyword}`] : []),
    )
    return {
      attempt: input.attempt,
      category: 'data_extraction_failed',
      where: 'run() value extraction',
      rawError,
      evidence,
      hypothesis:
        'Value extraction within the step code (AX value / osascript / clipboard / scraped text, etc.) returned empty, reaching a custom throw new Error.'
        + ' The assumed reading path likely does not match the app-specific structure, and minor tweaks to the same approach will not resolve this.'
        + ' A strategy switch to an alternative path (clipboard, full AX tree walk, AppleScript value of, OCR, etc.) should be proposed.',
    }
  }

  return {
    attempt: input.attempt,
    category: 'unknown',
    where: 'run() execution',
    rawError,
    evidence: [rawError.split('\n')[0]],
    hypothesis: 'Error classification unknown. Careful reading of rawError is needed for reclassification.',
  }
}

// ─── AI-driven diagnosis refinement ───

/**
 * Categories whose deterministic hypothesis is already specific enough that
 * sending tokens to the AI for refinement is wasteful (the AI mostly just
 * paraphrases what we already concluded).
 */
const CATEGORIES_NOT_WORTH_AI_REFINEMENT: ReadonlySet<FailureCategory> = new Set([
  'ambiguous_input',          // already pinpoints "ctx.input.X has no default"
  'code_compile_error',       // syntax error — read the rawError; AI rarely adds value
  'code_validation_failed',   // shape problem in the AI's own output
])

export interface DiagnosisRefinementContext {
  stepDescription: string
  /** Code that ran (or failed to compile). Truncated by the caller is fine. */
  code?: string
  /** Console output captured during the failing run — most valuable signal. */
  executionLogs?: string[]
  /** Snapshot of ctx.shared after the failing run — shows what data the code
   *  actually produced (e.g. an empty array vs. a missing key). */
  executionShared?: Record<string, unknown>
  /** Verifier's natural-language reason when stage was 'verify'. */
  verifyReason?: string
  /** Browser URL or desktop app name when relevant. */
  pageUrl?: string
  stepType: 'browser' | 'desktop'
  /** Hypotheses the deterministic stage already produced for *prior* attempts.
   *  Useful so the AI can say "you tried X and Y, both failed for the same
   *  underlying reason Z" instead of repeating the same theory. */
  priorHypotheses?: Array<{ attempt: number; hypothesis: string }>
}

/**
 * Refine a deterministic FailureDiagnosis with an AI call. Replaces the
 * generic templated hypothesis (e.g. "Suspect: incorrect click target,
 * wrong branch in conditional logic, or wrong target window") with a
 * specific theory grounded in the captured runtime evidence.
 *
 * Returns a *new* diagnosis (immutable update); on failure or skip,
 * returns the input unchanged.
 *
 * Costs ~2-5s and one AI call per failed step. Skipped for categories
 * already specific deterministically.
 */
export async function refineDiagnosisWithAi(
  config: AiProviderConfig,
  diag: FailureDiagnosis,
  ctx: DiagnosisRefinementContext,
): Promise<FailureDiagnosis> {
  if (CATEGORIES_NOT_WORTH_AI_REFINEMENT.has(diag.category)) return diag

  // No evidence to refine FROM — bail. Keeps the cost down on cancellations
  // and on first-attempt failures where the runtime didn't get far enough
  // to log anything useful.
  const hasLogs = (ctx.executionLogs?.length ?? 0) > 0
  const hasShared = ctx.executionShared && Object.keys(ctx.executionShared).length > 0
  const hasVerify = !!ctx.verifyReason
  if (!hasLogs && !hasShared && !hasVerify) return diag

  const logsBlock = (() => {
    if (!ctx.executionLogs?.length) return ''
    let body = ctx.executionLogs.join('\n')
    const MAX = 3000
    if (body.length > MAX) {
      body = body.slice(0, MAX / 2) + `\n… [snip ${body.length - MAX} chars] …\n` + body.slice(-MAX / 2)
    }
    return `\n\n## Console output captured during the failing run\n\`\`\`\n${body}\n\`\`\``
  })()

  const sharedBlock = (() => {
    if (!hasShared) return ''
    let serialized: string
    try {
      serialized = JSON.stringify(ctx.executionShared, null, 2)
    } catch {
      return ''
    }
    if (serialized.length > 1500) serialized = serialized.slice(0, 1500) + '\n… [truncated]'
    return `\n\n## ctx.shared after the failing run\n\`\`\`json\n${serialized}\n\`\`\``
  })()

  const codeBlock = (() => {
    if (!ctx.code) return ''
    let snippet = ctx.code
    const MAX = 3500
    if (snippet.length > MAX) {
      snippet = snippet.slice(0, MAX / 2) + '\n// … [snip] …\n' + snippet.slice(-MAX / 2)
    }
    return `\n\n## Code that ran\n\`\`\`typescript\n${snippet}\n\`\`\``
  })()

  const priorBlock = (() => {
    if (!ctx.priorHypotheses?.length) return ''
    return `\n\n## Hypotheses from previous attempts\n${ctx.priorHypotheses.map(h => `- Attempt ${h.attempt}: ${h.hypothesis}`).join('\n')}\nIf the same underlying issue is showing up across attempts, name it directly so the next retry doesn't keep churning on cosmetic variations.`
  })()

  const verifyBlock = ctx.verifyReason
    ? `\n\n## Verifier's reason for marking this a failure\n${ctx.verifyReason}`
    : ''

  const stepBlock = `\n\n## Step description (includes the post-condition the code was supposed to satisfy)\n${ctx.stepDescription}`
  const urlBlock = ctx.pageUrl ? `\n\n## Page URL / context\n${ctx.pageUrl}` : ''

  const messages = [
    {
      role: 'system' as const,
      content: `You are a failure-diagnosis agent for an AI-native RPA pipeline. A generated step has just failed. Your job is to read the **runtime evidence** (console output, ctx.shared snapshot, code, verifier reason) and produce a **specific, evidence-grounded hypothesis** about why it failed — sharp enough that the next retry can fix it on the first try.
${buildRuntimeContext()}

## What "specific" means
- ❌ Bad: "Suspect: incorrect click target, wrong branch in conditional logic, or wrong target window."
- ❌ Bad: "The code did not satisfy the post-condition."
- ✅ Good: "Logs show 'freeAnchorCount: 14' and 'No-match free anchor text: \\"〇\\"'. The regex was matched against \`a.textContent\` (which is just '〇' because the anchor wraps only the marker), not against \`cell.textContent\` which holds the time-range string. Fix: switch the regex source to the surrounding cell's textContent."
- ✅ Good: "ctx.shared.availableSlots is an empty array, but the recon site map shows 12 free cells in the table. Logs say 'Tables found: 4' and 'Day block index: -1'. The day-block detection looked for a \`<th rowspan=>\` containing '06/29' but the date cell label rendered as '06/29(月)' (with weekday suffix) — the substring search failed because of locale formatting."

## Output format (required)
Return ONLY this JSON, no prose around it:

{
  "hypothesis": "1-3 sentence specific theory grounded in the evidence. Name the exact line / log / shared-key / branch involved.",
  "evidence": ["short bullet 1", "short bullet 2", "..."]
}

## Rules
- Cite specific log lines or ctx.shared values when you have them ("Logs say 'X: 0'", "ctx.shared.foo is undefined").
- If the evidence is genuinely insufficient to say more than the deterministic hypothesis already does, say so plainly: hypothesis = "Insufficient evidence: <what's missing>". Don't invent.
- Prefer naming the **wrong assumption** (e.g. "code assumed cell text was empty, but logs show it contains '〇 ...'"), not just the surface symptom.
- Keep evidence to ≤6 short bullets, each citing concrete data.
- Do not propose a fix in this output — diagnosis only. The retry pipeline will plan the fix separately.`,
    },
    {
      role: 'user' as const,
      content: `## Failure category (deterministic classification)
${diag.category} @ ${diag.where}

## Raw error
${(diag.rawError || '').slice(0, 1500)}${verifyBlock}${stepBlock}${urlBlock}${sharedBlock}${logsBlock}${codeBlock}${priorBlock}`,
    },
  ]

  try {
    const result = await chatNonStream(config, messages)
    const text = result.text
    const jsonMatch = text.match(/```json\s*\n?([\s\S]*?)```/)
      ?? text.match(/(\{[\s\S]*"hypothesis"[\s\S]*\})/)
    if (!jsonMatch) return diag
    const jsonStr = jsonMatch[1] || jsonMatch[0]
    const parsed = JSON.parse(jsonStr) as { hypothesis?: unknown; evidence?: unknown }
    const newHypothesis = typeof parsed.hypothesis === 'string' ? parsed.hypothesis.trim() : ''
    if (!newHypothesis) return diag
    const newEvidence = Array.isArray(parsed.evidence)
      ? parsed.evidence.filter((e): e is string => typeof e === 'string').slice(0, 8)
      : []
    return {
      ...diag,
      hypothesis: newHypothesis,
      evidence: [...diag.evidence, ...newEvidence],
    }
  } catch {
    // AI refinement is best-effort — never block retry on it.
    return diag
  }
}

// ─── Suggest untried strategies based on a diagnosis ───

// These are concrete suggestions the AI should consider on the NEXT attempt.
// They are framed as "try X instead of what you did" so the AI can pick one.
export function suggestUntriedStrategies(
  diagnosis: FailureDiagnosis,
  stepType: 'browser' | 'desktop',
  alreadyTried: string[],
): string[] {
  const suggestions: string[] = []

  if (stepType === 'desktop') {
    switch (diagnosis.category) {
      case 'selector_resolution_failed':
      case 'element_not_found_runtime':
        suggestions.push(
          'Use findElements(tree, { role: ... }) to enumerate all candidates with the same role, console.log their title/description, then pick the closest match',
          'Hold multiple axTitle candidates in an array and try findElement for each in a for loop',
          'Omit axTitle and use only axRole for findElement, then enumerate descendants and select',
          'Verify the window title is as expected via getWindows() before searching',
          'Use AppleScript (osascript) to operate directly via the app\'s scripting dictionary',
          'Replace with keyboard input via desktop.type() (avoid clicking fixed buttons one by one)',
          'Coordinate fallback from window bounds (center, bottom-aligned, etc.)',
        )
        break
      case 'action_execution_error':
        suggestions.push(
          'For AXTextField/AXTextArea, use coordinate click then desktop.type() instead of AXPress',
          'Run activateApp before operating (app may not be in foreground)',
          // AppleScript switching candidates
          'For AppleScript errors (-1728/-1743/-10000): Completely abandon the AppleScript approach and switch to AX tree clicks + desktop.type() + hotkey',
          'If AppleScript fails on non-allowlisted apps (Slack/Notion/Electron-based): Limit tell to activate only, use clipboard + Cmd+V for data input',
          'Conversely, if AX/coordinate clicks are failing on allowlisted apps (Mail/Finder/Notes/Reminders/Calendar, etc.): Switch to AppleScript make new / set properties',
          'For long text input, using osascript "set the clipboard to ..." + hotkey("command","v") to paste is more robust',
        )
        break
      case 'step_timeout':
        suggestions.push(
          'Before increasing meta.timeout, verify via AX tree that the awaited element actually appears',
          'Make the waitForElement query more lenient (role only, etc.)',
          'Use a state-change detection loop instead of a fixed sleep',
        )
        break
      case 'precondition_not_met':
        suggestions.push(
          "Switch window search to bundleId-based: windows.find(w => w.bundleId === 'com.apple.calculator')",
          "Use includes() leniently instead of strict app name match: windows.find(w => (w.app ?? '').toLowerCase().includes('calcul') || (w.app ?? '').includes('計算'))",
          'Dump getWindows() results with console.log to check actual app names/bundleIds before deciding search criteria',
          'Add a 1500-3000ms wait after open -a execution to allow launch to complete',
          'Use desktop.waitForElement(bundleIdOrAppName, { role: "AXWindow" }, 10000) to wait for window appearance before calling getWindows()',
          'Close any leftover modals/search screens from previous steps with Esc before starting',
        )
        // ctx.shared cross-step data handoff issue → suggest retry_previous
        if (diagnosis.where?.includes('ctx.shared') || /ctx\.shared/i.test(diagnosis.rawError ?? '')) {
          suggestions.push(
            '[retry_previous recommended] The previous step\'s execution likely failed or did not write data to ctx.shared. Go back to the previous step and re-generate/re-execute',
          )
        }
        break
      case 'verification_failed':
        suggestions.push(
          'Verify the click target is correct: log findElement result role/title/position to confirm',
          'Check that conditional branches (if/switch) are entering the correct branch',
          'Embed success checks via AX tree/window title changes instead of screenshots after the operation',
          'Add verification logic within the code for what constitutes success',
        )
        break
      case 'ambiguous_input':
        suggestions.push(
          'Receive ctx.input.XXX with `?? \'\'` as a default, and effectively noop if empty',
          'Use ctx.ai() to convert person names/nicknames to concrete search queries',
        )
        break
      case 'code_compile_error':
      case 'code_validation_failed':
        suggestions.push(
          'Strictly rewrite import statements and export function run signature',
          'require() is forbidden -- use ESM import only',
        )
        break
      case 'data_extraction_failed':
        suggestions.push(
          '[Strategy switch] Abandon direct AX value / AX title / AX description reading and switch entirely to clipboard: activateApp(pid) -> hotkey(["command","a"]) -> hotkey(["command","c"]) -> wait 200ms -> use shell("pbpaste") stdout as the value',
          '[Strategy switch] Instead of trying AppleScript "value of static text", use "the clipboard": osascript -e \'tell app "System Events" to keystroke "a" using command down\' -> keystroke "c" using command down -> osascript -e \'return the clipboard as text\'',
          '[Strategy switch] Instead of findElement({ role: "AXStaticText" }), serialize the entire AX tree to JSON and recursively enumerate all AXStaticText elements, selecting the one whose value/title/description/help contains the target number/string',
          '[Strategy switch] The app may not be exposing AXValue correctly -- walk all descendants of the window, dump to log, and verify which element\'s which attribute actually contains the value before rebuilding the selector',
          '[Strategy switch] Execute Edit -> Select All -> Copy from the menu bar via AppleScript (tell application "System Events" to click menu item ... of menu ... of menu bar item ...) then pbpaste',
          'When getting an empty value, consider not throwing but writing the empty string to ctx.shared and passing it to the next step, letting the next step use a different extraction path',
          'Never reuse an extraction path that failed in a previous attempt for the same app (AX value, osascript value of, findElement) -- strictly follow triedStrategies',
        )
        break
      case 'unknown':
        // We don't know the category -- fall back to generic "change approach"
        // prompts so the retry isn't just a cosmetic tweak of the previous try.
        suggestions.push(
          '[Strategy switch] Avoid the same approach as the previous attempt. Read triedStrategies and switch entirely to an untried path (clipboard/AppleScript/full AX walk/coordinate click/shell/OCR, etc.)',
          'Dump state right before failure: console.log desktop.screenshot() + getAccessibilityTree() results before throwing (the next attempt can use this info to choose a path)',
          'Reduce the conditions leading to throw new Error() by one line, adding branches so that empty values can proceed to a fallback path',
          'Rewrite error messages more specifically: include which getter returned null / which shell stdout was empty, to improve diagnosis accuracy for the next attempt',
          'Consider the possibility that the app does not expose that information via AX at all, and switch to clipboard copy approach',
        )
        break
    }
  } else {
    switch (diagnosis.category) {
      case 'selector_resolution_failed':
      case 'element_not_found_runtime':
        suggestions.push(
          "Regex match like getByRole('button', { name: /regex/ })",
          'Partial match with getByText exact:false',
          'Attribute match with XPath contains()',
          'May be inside a frame() -- enumerate page.frames()',
        )
        break
      case 'step_timeout':
        suggestions.push(
          'Use only domcontentloaded for waitForLoadState (do not use networkidle)',
          'Extend for SPA with locator.waitFor({ timeout: 30000 })',
        )
        break
      case 'verification_failed':
        suggestions.push(
          'Log the element\'s textContent right before clicking to verify it is as intended',
          'Embed URL-based success check (page.url() change) in the code',
        )
        break
      case 'action_execution_error':
        suggestions.push(
          'require() cannot be used in ESM environment. Switch to import fs from "fs" / import { execSync } from "child_process"',
          'For "Target page has been closed" error: verify the page is alive before page.goto()',
          'If locator.click() fails because another element overlaps: use locator.click({ force: true }) or retry after scrolling',
        )
        break
      case 'data_extraction_failed':
        suggestions.push(
          '[Strategy switch] Use locator.innerText() / locator.allTextContents() instead of locator.textContent()',
          '[Strategy switch] Read DOM directly with page.evaluate(() => document.querySelector(sel).innerText)',
          '[Strategy switch] Capture API response with page.waitForResponse(...) and read JSON directly (abandon DOM scraping)',
          'Possibly insufficient waiting: add locator.waitFor({ state: "visible" }) before reading',
          'May be inside an iframe -- enumerate page.frames() and read from the matching frame',
        )
        break
      case 'unknown':
        suggestions.push(
          '[Strategy switch] Avoid the same selector strategy as last time. Switch to an untried one among getByRole / getByText / XPath / CSS',
          'Add page.waitForLoadState("domcontentloaded") + state check to verify the DOM is actually ready',
          'Log page.screenshot + the beginning of page.content() right before the error to verify actual DOM state',
        )
        break
    }
  }

  // de-dupe, remove already-tried
  const triedSet = new Set(alreadyTried.map(s => s.toLowerCase()))
  return suggestions.filter(s => !triedSet.has(s.toLowerCase()))
}

// ─── Extract a short strategy descriptor from resolvedActions + code ───

export function describeAttemptedStrategy(
  code: string,
  resolvedActions: ResolvedAction[],
  stepType: 'browser' | 'desktop',
): string {
  if (resolvedActions.length === 0) {
    return stepType === 'desktop'
      ? 'Fallback code generation (no action plan)'
      : 'Fallback code generation (no selector resolution)'
  }
  const bits: string[] = []
  for (const ra of resolvedActions.slice(0, 5)) {
    const a = ra.action
    if (a.action === 'click_element') {
      bits.push(`click[${a.axRole ?? '?'}:"${a.axTitle ?? ''}"]`)
    } else if (a.action === 'type_text') {
      bits.push(`type[${a.text?.slice(0, 20) ?? ''}]`)
    } else if (a.action === 'hotkey') {
      bits.push(`hotkey[${(a.keys ?? []).join('+')}]`)
    } else if (a.action === 'shell') {
      bits.push(`shell[${(a.command ?? '').slice(0, 30)}]`)
    } else if (a.action === 'open_app' || a.action === 'activate_app') {
      bits.push(`${a.action}[${a.app ?? ''}]`)
    } else {
      bits.push(a.action)
    }
  }
  // Scan code for notable patterns
  const patternBits: string[] = []
  if (/osascript/.test(code)) patternBits.push('AppleScript')
  if (/findElement/.test(code)) patternBits.push('AX-findElement')
  if (/performAction/.test(code)) patternBits.push('AX-performAction')
  if (/getByRole/.test(code)) patternBits.push('getByRole')
  if (/getByText/.test(code)) patternBits.push('getByText')
  return bits.join(' → ') + (patternBits.length ? ` [${patternBits.join(',')}]` : '')
}

// ─── Format the ledger for inclusion in agent prompts ───

export function formatLedgerForPrompt(ledger: StrategyLedger, diagnosisHistory: FailureDiagnosis[]): string {
  if (ledger.tried.length === 0 && diagnosisHistory.length === 0) return ''

  const lines: string[] = []
  lines.push('## 🔬 Failure Diagnosis & Strategy Ledger (READ THIS to avoid repeating the same failures)')
  lines.push('')

  // Detect consecutive same-category streak (2+). If so, emit a LOUD warning
  // at the top — the AI must pick a structurally different approach, not a
  // cosmetic tweak, or we'll keep looping.
  if (diagnosisHistory.length >= 2) {
    const last = diagnosisHistory[diagnosisHistory.length - 1]
    let streak = 1
    for (let k = diagnosisHistory.length - 2; k >= 0; k--) {
      if (diagnosisHistory[k].category === last.category) streak++
      else break
    }
    if (streak >= 2) {
      lines.push(`### ⚠️ WARNING: Same failure category occurred ${streak} times consecutively (category=${last.category})`)
      lines.push('This is a sign that you are only making minor tweaks to the same approach without a fundamental strategy switch.')
      lines.push('For this attempt, you **MUST strictly follow** these rules:')
      lines.push('- **Do not use any** of the paths used in previous attempts (direct AX tree reading / AppleScript value / coordinate clicks / specific selector strings, etc.)')
      lines.push('- Select **one structurally different path** from the "Untried strategy candidates" list (e.g. AX reading -> clipboard, AppleScript -> shell+osascript direct call)')
      lines.push('- Do not write the same `throw new Error()` message. Before throwing, console.log dump which getter returned empty / which stdout was empty, then throw')
      lines.push('- Proposals with 80%+ code similarity to the previous attempt are forbidden. Write from scratch as if creating a new file')
      lines.push('')
    }
  }

  if (diagnosisHistory.length > 0) {
    lines.push('### Diagnosis of previous failures')
    for (const d of diagnosisHistory) {
      lines.push(`- Attempt ${d.attempt} [${d.category}] @ ${d.where}`)
      lines.push(`  - Error: ${d.rawError.split('\n')[0].slice(0, 200)}`)
      if (d.evidence.length > 0) {
        lines.push(`  - Clues: ${d.evidence.join(' / ')}`)
      }
      lines.push(`  - Hypothesis: ${d.hypothesis}`)
    }
    lines.push('')
  }

  if (ledger.tried.length > 0) {
    lines.push('### Tried strategies (these approaches already failed -- do not repeat the same method)')
    for (const t of ledger.tried) {
      lines.push(`- Attempt ${t.attempt}: ${t.strategy}  ->  [${t.category}] ${t.hypothesis}`)
    }
    lines.push('')
  }

  if (ledger.untried.length > 0) {
    lines.push('### Untried strategy candidates (you MUST select one from this list)')
    for (const u of ledger.untried) {
      lines.push(`- ${u}`)
    }
    lines.push('')
  }

  lines.push('### Rules to follow this time')
  lines.push('1. Avoid methods that are essentially the same as the "Tried strategies" above (changing a single character in a selector string counts as the same method)')
  lines.push('2. Write code that addresses the root cause indicated by the diagnosis "Hypothesis"')
  lines.push('3. If the "Untried strategy candidates" list is not empty, select and implement one from it')
  lines.push('4. After implementation, embed verification logic in the code for what constitutes success (AX tree check, window title check, etc.)')
  lines.push('5. When throwing for value extraction failures, console.log the getter return value / shell stdout / AX element count right before throwing (improves diagnosis accuracy for the next attempt)')

  return lines.join('\n')
}
