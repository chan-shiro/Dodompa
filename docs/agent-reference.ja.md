# Dodompa Agent Reference

> 🇬🇧 English: [agent-reference.md](agent-reference.md)
>
> 各エージェントのインプット・アウトプット・ツール実行の一覧。
> 開発時の参照用。

## パイプライン全体図

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
│  ├── suggestUntriedStrategies() → 次の戦略              │
│  └── Phase B〜F を再実行                                │
├─────────────────────────────────────────────────────────┤
│ Phase H: Replan (retries exhausted)                     │
│  └── replanStep() → split / replace / skip / retry_prev │
└─────────────────────────────────────────────────────────┘
```

---

## 1. planningAgent — planSteps()

| 項目 | 内容 |
|------|------|
| **ファイル** | `src/main/ipc/agents/planningAgent.ts` |
| **目的** | ユーザー指示をステップに分解 |
| **AI呼び出し** | `chatStream()` × 1 |

### Input
| パラメータ | 型 | 説明 |
|-----------|-----|------|
| config | AiProviderConfig | AI プロバイダ設定 |
| win | BrowserWindow \| null | UI 進捗送信先 |
| taskId | string | タスクID |
| instruction | string | ユーザーの指示文 |
| priorStableSteps | StablePriorStep[] | 既存の安定ステップ |
| goal | string? | タスクの最終成果物・目的 |

### Output
```typescript
{
  plan: StepPlan[]               // {name, description, type, needsLogin?}
  detectedVariables: VariableDefinition[]  // {key, label, type, required, default}
  planResult: { text: string; usage?: { totalTokens?: number } }
}
```

### ツール実行
なし（テキスト→テキストの純粋AI呼び出し）

---

## 2. exploratoryPlanAgent — exploratoryPlan()

| 項目 | 内容 |
|------|------|
| **ファイル** | `src/main/ipc/agents/exploratoryPlanAgent.ts` |
| **目的** | サイトを実際に探索してからプラン生成 |
| **AI呼び出し** | `chatNonStream()` × 最大11回（10アクション + 強制done） |

### Input
| パラメータ | 型 | 説明 |
|-----------|-----|------|
| config | AiProviderConfig | AI プロバイダ設定 |
| win | BrowserWindow \| null | UI 進捗送信先 |
| taskId | string | タスクID |
| instruction | string | ユーザーの指示文 |
| goal | string | タスクの最終成果物・目的 |
| page | Page | Playwright ページ（探索用） |
| priorStableSteps | StablePriorStep[] | 既存の安定ステップ |

### Output
planSteps() と同じ形式。

### ツール実行
| アクション | Playwright API | 説明 |
|-----------|---------------|------|
| navigate | `page.goto()` + `scanBrowserPage()` | URL遷移 + DOM スキャン |
| scanCurrentPage | `scanBrowserPage()` | 現在ページの再スキャン |
| followLink | `page.getByRole('link').click()` | リンククリック |
| checkContentType | `page.context().request.head()` | Content-Type 確認 |
| extractSampleText | `page.evaluate()` / `page.locator().innerText()` | テキスト抽出 |
| screenshot | `page.screenshot()` | スクリーンショット |
| goBack | `page.goBack()` | ブラウザバック |

### ゲート関数: shouldUseExploratoryPlanning()
```typescript
// true: goal + URL + 情報収集キーワード が揃った場合
// false: 上記以外 → 従来の planSteps() にフォールバック
```

---

## 3. analyzingAgent — analyzeBrowserPage() / analyzeDesktop()

| 項目 | 内容 |
|------|------|
| **ファイル** | `src/main/ipc/agents/analyzingAgent.ts` |
| **目的** | 現在の画面状態を収集 |
| **AI呼び出し** | analyzeDesktop のみ `chatNonStream()` × 1（ウィンドウマッチング） |

### analyzeBrowserPage
| Input | Output |
|-------|--------|
| page: Page | pageHtml: string |
| win, taskId, stepIndex, stepName | screenshot: string (base64) |
| | selectorMap: string (操作可能要素一覧) |

**ツール**: `page.content()`, `page.screenshot()`, `page.evaluate(extractPageSelectors)`

### analyzeDesktop
| Input | Output |
|-------|--------|
| config, desktopCtx, win, taskId | pageHtml: string (AXツリーJSON) |
| stepIndex, stepPlan, lastUsedAppName | screenshot: string (base64) |
| | selectorMap: string (AXツリー整形) |
| | updatedAppName, launchName, targetPid |

**ツール**: `desktop.screenshot()`, `desktop.getWindows()`, `desktop.getAccessibilityTree()`, `matchTargetWindow()`, `exec('sdef', ...)` (AppleScript辞書検出)

---

## 4. reconAgent — reconBrowserPage()

| 項目 | 内容 |
|------|------|
| **ファイル** | `src/main/ipc/agents/reconAgent.ts` |
| **目的** | サイト構造の偵察（表面 + 深層） |
| **AI呼び出し** | `chatStream()` × 1 (enrichment) + 深層偵察時 `chatNonStream()` × 2 (triage + report) |

### Input
| パラメータ | 型 | 説明 |
|-----------|-----|------|
| config | AiProviderConfig | |
| page | Page | 現在のブラウザページ |
| win, taskId, stepIndex | | ログ用 |
| stepPlan | StepPlan | ステップ情報（goalContext用） |
| opts.deepRecon | boolean? | 深層偵察を有効化 |

### Output: SiteMap
```typescript
interface SiteMap extends SiteMapRawFacts {
  summary?: string           // AI要約 (2-4文)
  urlPatterns?: string[]     // URL テンプレート
  candidatesForGoal?: Array<{kind, label, via, note}>  // 目的に対する候補要素
  subPages?: SubPageFinding[]     // [深層偵察] サブページ訪問結果
  deepScanReport?: string         // [深層偵察] AI総合レポート
}
```

### ツール実行
| 関数 | ツール | 説明 |
|------|--------|------|
| scanBrowserPage | `page.evaluate()` | DOM要素の決定的スキャン |
| deriveUrlPatterns | 純粋関数 | リンクからURLパターン抽出 |
| triageDeepRecon | `chatNonStream()` | 探索必要性判断 |
| exploreSubPages | `page.goto()`, `page.evaluate()`, `page.context().request.head()` | サブページ訪問 |
| synthesizeDeepReport | `chatNonStream()` | 発見のレポート生成 |

### キャッシュ
- URL ベース、24h TTL
- deepRecon 結果がないキャッシュは deep recon 要求時にスキップ

---

## 5. actionPlanAgent — generateActionPlan()

| 項目 | 内容 |
|------|------|
| **ファイル** | `src/main/ipc/agents/actionPlanAgent.ts` |
| **目的** | 具体的アクション列を生成 |
| **AI呼び出し** | `chatStream()` × 1 |

### Input
分析結果 + 偵察結果 + エラー履歴 + ステップ結果 + 戦略台帳 + タスク目的

### Output
```typescript
interface ActionPlanResult {
  actions: ActionPlan[]     // {action, description, selectorHint, url, value, ...}
  question?: { question: string; infoKey?: string }  // 情報不足時の質問
  alreadyDone?: boolean     // 既に目的達成済み
}
```

### アクション型 (browser)
`goto`, `click`, `fill`, `press`, `select`, `wait`, `scroll`, `hover`

### アクション型 (desktop)
`open_app`, `activate_app`, `click_element`, `click_position`, `type_text`, `hotkey`, `press_key`, `shell`

---

## 6. selectorAgent — resolveActionSelectors() / resolveDesktopActions()

| 項目 | 内容 |
|------|------|
| **ファイル** | `src/main/ipc/agents/selectorAgent.ts` |
| **目的** | アクションプランのセレクタ/要素を実機で検証 |
| **AI呼び出し** | なし（決定的な検索のみ） |

### resolveActionSelectors (browser)
**ツール**: `page.getByRole()`, `page.getByText()`, `page.getByPlaceholder()`, `page.getByLabel()`, `page.locator()`, `page.evaluate()` (CSS検証)

### resolveDesktopActions (desktop)
**ツール**: `desktop.getAccessibilityTree()`, `desktop.findElement()`, `desktop.findElements()`

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

| 項目 | 内容 |
|------|------|
| **ファイル** | `src/main/ipc/agents/codegenAgent.ts` |
| **目的** | 検証済みアクション → TypeScript コード生成 |
| **AI呼び出し** | `chatStream()` × 1 |

### Input
解決済みアクション + ページ状態 + 既存コード + エラー履歴 + SiteMap + task目的

### Output
```typescript
// 生成される TypeScript コード
export async function run(page: Page, context: BrowserContext, ctx: StepContext): Promise<void>
export const meta = { description: string, retryable: boolean, timeout: number }
```

### 生成コードが使える API
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

| 項目 | 内容 |
|------|------|
| **ファイル** | `src/main/ipc/agents/verifyAgent.ts` |
| **目的** | ステップ実行後の成否判定 |
| **AI呼び出し** | `chatNonStream()` × 0-1 (プログラム検証で済めばAI不要) |

### Input
stepDescription + before/after screenshots + executionResult + executionShared + taskGoal

### Output
```typescript
{ success: boolean; reason?: string }
```

### 検証ストラテジー (優先順)
1. **プログラム検証** — ファイル存在 / ctx.shared 値チェック / データ品質チェック
2. **ヒューリスティック** — エラーなし＝成功（desktop, 非ビジュアル操作）
3. **AI ビジュアル検証** — before/after スクリーンショット比較

---

## 9. failureDiagnosis — diagnoseFailure()

| 項目 | 内容 |
|------|------|
| **ファイル** | `src/main/ipc/agents/failureDiagnosis.ts` |
| **目的** | 失敗をカテゴリ分類し、次の戦略を提案 |
| **AI呼び出し** | なし（ルールベース） |

### 診断カテゴリ
| カテゴリ | 例 |
|---------|-----|
| selector_resolution_failed | CSS セレクタが見つからない |
| element_not_found_runtime | findElement が null |
| action_execution_error | AppleScript -1728, click 失敗 |
| step_timeout | タイムアウト |
| verification_failed | 検証で不合格 |
| code_compile_error | esbuild エラー |
| precondition_not_met | アプリ未起動、前ステップ失敗 |
| data_extraction_failed | 抽出データが空 |
| unknown | 上記に該当しない |

---

## 10. replanAgent — replanStep()

| 項目 | 内容 |
|------|------|
| **ファイル** | `src/main/ipc/agents/replanAgent.ts` |
| **目的** | 3回失敗後のステップ再構成 |
| **AI呼び出し** | `chatNonStream()` × 1 |

### Output
```typescript
interface ReplanDecision {
  action: 'split' | 'replace' | 'skip' | 'retry_previous'
  steps?: StepPlan[]      // split時
  step?: StepPlan         // replace時
  reason?: string
  goBackSteps?: number    // retry_previous時
}
```

---

## ステップ間の状態フロー

```
executionInput:  Record<string, string>    — タスク変数（全ステップ共通）
executionShared: Record<string, unknown>   — ctx.shared（ステップ間データ受け渡し）
stepResults:     Array<StepResult>         — 各ステップの成否（後続ステップに伝播）
siteMap:         SiteMap | null            — 偵察結果（ステップごとに更新）
errorHistory:    Array<ErrorRecord>        — リトライ内のエラー履歴
strategyLedger:  {tried[], untried[]}      — 試行済み・未試行の戦略
```
