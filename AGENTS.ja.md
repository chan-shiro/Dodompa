# Dodompa — AI のための RPA (フルコード)

> 🇬🇧 English: [AGENTS.md](AGENTS.md)

## プロジェクトの目的

Dodompa は **「AI のための RPA」**。
LLM に毎回繰り返し作業をやらせるのはトークン的・速度的・確度的に効率が悪い。
だから「**ルールベースで決定的に動く部分は RPA (フルコード) に書き出し**、判断が必要な瞬間にだけ AI に問い合わせる」というハイブリッドを実現するアプリ。

- **初回**: 自然言語の指示 → AI が分解 → 実コード (TypeScript) を生成 → 実行 → 動くまで自己修正
- **2 回目以降**: 生成済みの TypeScript ステップを**そのまま実行** (LLM 呼び出し不要)。決定的・高速・無料
- **判断が必要な場面**: 生成コード内から `ctx.ai("...")` を呼ぶか、ユーザーに ask する。例: 「『田中さん』はどのメールアドレスか」「曖昧な検索結果のどれが正しいか」
- **故障時**: 既存ステップが失敗したら AI が原因分析 → コード修正 → 再実行

### なぜフルコードか

ノーコード/ビジュアル RPA はワークフローエディタで完結するが、複雑なロジック (条件分岐、エラーハンドリング、外部 API 連携、整形、ループ) になるとすぐ天井にぶつかる。
Dodompa は**生成物が普通の TypeScript ファイル**なので、人間が読めて、`Edit` できて、Git で diff できて、ライブラリも使える。「AI が下書きを書いて人間が必要なら手直しできる」が理想形。

### MCP との関係 (重要)

Dodompa の MCP は **対象ユーザー × トランスポートの 2 軸**で整理される。混同しないこと。

**エンドユーザー向け — タスクレベル制御 (`task_list` / `task_run` / `task_create` / `task_generate` / `task_refactor` / `execution_logs` など):**

- **in-process streamable-HTTP (主経路)** — Electron アプリ本体が `http://127.0.0.1:19876/mcp` で直接ホスト。ツール実装は `src/main/mcp/tools.ts` にあり、IPC ハンドラや DB を直接呼ぶので自己プロキシは不要。streamable-HTTP 対応の MCP クライアント (Claude Code など) は 1 行の設定で繋げる。**Dodompa アプリが起動している必要がある。**
- **stdio ブリッジ (`mcp/src/stdio-bridge.ts`)** — stdio しか話せない MCP クライアント (Claude Desktop) 向けの薄いトランスポート層プロキシ。JSON-RPC メッセージを stdio と `/mcp` の間でそのまま転送するだけで、ツール定義は持たない。新しいツールを足すときも `src/main/mcp/tools.ts` だけ編集すればよい。
- **`mcp/src/production.ts`** — in-process サーバーが出来る前の stdio 実装。各ツールを `/ipc/:channel` や `/db/query` の上に個別実装した旧版。まだ動くが deprecated。streamable-HTTP か stdio ブリッジを使うこと。

**開発者向け — 低レベル macOS プリミティブ (`list_windows` / `get_accessibility_tree` / `click` / `hotkey` / `screenshot` …):**

- **`mcp/src/index.ts` — デスクトップ MCP (開発・デバッグ専用)**。Dodompa 本体を開発する人が Claude Code から「この AX ツリーがちゃんと取れているか」「この座標クリックが効くか」をインタラクティブに検証するためのもの。エンドユーザー向けではない。

どのサーバー/トランスポートを使うにせよ、**Dodompa のタスク生成・実行パイプライン自体は MCP を経由しない**。電卓を動かすなら `dodompa-ax` Swift CLI を内部から呼ぶし、ブラウザを動かすなら `playwright-core` を内部から呼ぶ。MCP は *Claude 向けに公開している制御面* であって、Dodompa 内部のデータパスではない。

- アプリの主要ロジックを**新たに書く時に MCP に依存させてはいけない**。Dodompa 内で完結する形で実装し、必要なら同じものを MCP からも呼べるよう薄い CLI/Bridge として切り出す
- **新しいエンドユーザー向けツールを足す時は `src/main/mcp/tools.ts` を編集する**。streamable-HTTP と (ブリッジ経由で) stdio の両方から自動的に使えるようになる

### 設計思想

- **初回生成時は AI をフル活用** — タスク指示からステップ分解、アクションプラン、コード生成まで
- **2 回目以降は AI を極力使わない** — 生成済みコードをそのまま実行。効率的で繰り返し作業に最適
- **障害時のみ AI で分析・修正** — エラー発生時に AI が原因分析とコード修正を行う
- **API 連携を優先、UI 操作をフォールバック** — API (メール送信、Slack API 等) が使えるものは API を使う。ただし現状は認証情報の永続化機能がないため、フォールバック先である UI 操作 (ブラウザ・デスクトップ) で確実に動作するよう実装を進めている
- **曖昧さの解決には AI を活用** — 例: 「宛先: 福田さん」→ `fukuda@autoro.io` とマッチ。確証が低い場合はユーザーに問い合わせる

### コア原則: 決め打ちは禁止、汎用に書く

「特定アプリ・特定 OS・特定言語環境に依存する決め打ち」を**プロンプトにもコードにも入れない**。Dodompa が知らないアプリでも初回生成で動くべき。

- ❌ **禁止**: `windows.find(w => w.app === 'Slack')` のような英語ハードコード (日本語ロケールで `'メッセージ'` 等になる)
- ❌ **禁止**: プロンプト内のアプリ名リスト列挙 (`/calculator|finder|slack|teams|discord/i`) — 知らないアプリが落ちる
- ❌ **禁止**: AppleScript の許可リストを静的に維持する (新しいアプリが対応外になる)
- ❌ **禁止**: アクションプラン段階で「Cmd+K でクイックスイッチャー」と固定する (Teams は Ctrl+G、Notion は Cmd+P)
- ✅ **正解**: bundleId 優先 + `w.app` 部分一致 + 検出された日本語名併記
- ✅ **正解**: 実行時に `sdef <app-path>` を呼んで AppleScript Dictionary の有無を**動的判定**
- ✅ **正解**: アクションプランは「実機の AX ツリー / ウィンドウタイトル」を見てから決める

詳細は後述の「デスクトップ自動化タスクの戦略」「同じミスを繰り返さないための失敗診断パイプライン」を参照。

### 2つの自動化モード

- **ブラウザ自動化** — Playwright でWebサイトを操作（ログイン、フォーム入力、スクレイピング等）
- **デスクトップ自動化** — macOS Accessibility API + キーボード/マウス制御でネイティブアプリを操作

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| アプリシェル | Electron |
| UI | React + TypeScript + Tailwind CSS |
| ブラウザ操作 | Playwright（playwright-core） |
| デスクトップ操作 | Swift CLI（dodompa-ax）+ AppleScript + Python/Quartz |
| AI連携 | Vercel AI SDK（ai + @ai-sdk/anthropic + @ai-sdk/openai + @ai-sdk/google） |
| ローカルDB | SQLite（better-sqlite3） |
| ビルド | electron-vite |

## ディレクトリ構成

```
src/
├── main/                          # Electronメインプロセス
│   ├── index.ts                   # エントリポイント
│   ├── db.ts                      # SQLite接続・スキーマ
│   ├── ipc/
│   │   ├── aiAgent.ts             # AI自律生成オーケストレータ（全エージェントを統合）
│   │   ├── agents/                # 役割別AIエージェント
│   │   │   ├── index.ts           # エージェント一括エクスポート
│   │   │   ├── aiChat.ts          # AI チャットユーティリティ（streaming/non-streaming）
│   │   │   ├── progressHelper.ts  # 進捗イベント送信＆DBログ
│   │   │   ├── planningAgent.ts   # タスク→ステップ分解
│   │   │   ├── analyzingAgent.ts  # ページ/デスクトップ分析（スクリーンショット＋AXツリー）
│   │   │   ├── actionPlanAgent.ts # アクションプラン生成
│   │   │   ├── selectorAgent.ts   # セレクタ/AX要素の解決＆検証
│   │   │   ├── codegenAgent.ts    # TypeScriptコード生成
│   │   │   ├── verifyAgent.ts     # 実行後のAI検証（前後スクリーンショット比較）
│   │   │   └── replanAgent.ts     # 失敗時のステップ再計画
│   │   ├── aiService.ts           # AIプロバイダ抽象化（Vercel AI SDK）
│   │   ├── taskRunner.ts          # タスク実行エンジン
│   │   ├── profileManager.ts      # ブラウザプロファイル管理
│   │   ├── settingsManager.ts     # 設定管理
│   │   └── desktopService.ts      # デスクトップ自動化IPC
│   └── desktop/
│       ├── platform.ts            # プラットフォーム判定
│       ├── mac/
│       │   ├── index.ts           # macOS DesktopContext統合
│       │   ├── axBridge.ts        # Swift CLIラッパー
│       │   ├── keyboard.ts        # AppleScript経由キーボード
│       │   ├── mouse.ts           # Python/Quartz経由マウス
│       │   └── screenshot.ts      # screencapture CLI
│       └── win/
│           └── index.ts           # Windows スタブ
│
├── renderer/                      # Reactフロントエンド
│   ├── pages/
│   │   ├── TaskList.tsx           # タスク一覧
│   │   ├── TaskDetail.tsx         # タスク詳細・ステップ管理
│   │   ├── TaskGeneration.tsx     # AI生成画面（リアルタイムログ）
│   │   ├── LogViewer.tsx          # 統合ログビューア
│   │   └── Settings.tsx           # AI設定・プロファイル管理
│   └── lib/
│       ├── api.ts                 # IPCブリッジラッパー
│       └── types.ts               # フロントエンド型定義
│
├── preload/
│   └── index.ts                   # contextBridge
│
├── shared/
│   └── types.ts                   # 共有型定義（メインとレンダラー共通）
│
native/
└── macos/
    └── dodompa-ax/                 # Swift CLI（Accessibility API）
        ├── Package.swift
        └── Sources/
            ├── main.swift         # CLIエントリポイント
            └── AccessibilityBridge.swift  # AX API ラッパー

mcp/                               # MCP ブリッジ群 + 開発用サーバー
├── src/
│   ├── stdio-bridge.ts            # stdio → http://127.0.0.1:19876/mcp プロキシ（Claude Desktop 向け）
│   ├── production.ts              # 旧 stdio 実装（deprecated）
│   ├── index.ts                   # デスクトップ MCP（開発・デバッグ用・AX / 入力プリミティブ）
│   ├── ax-bridge.ts               # AXブリッジ（index.ts 用）
│   ├── browser.ts                 # ブラウザ操作（index.ts 用）
│   └── input.ts                   # キーボード/マウス入力（index.ts 用）
└── package.json

src/main/mcp/                      # in-process MCP サーバー（:19876/mcp で配信）
├── index.ts                      # HTTP トランスポート + セッション管理
├── tools.ts                      # ツール定義（唯一のソース）
└── bridge.ts                     # invokeIpc / emitIpc / dbQuery — in-process で直接呼び出し

tasks/                             # ユーザーのタスクデータ（実行時生成）
└── {taskId}/
    ├── task.json
    ├── step_01_*.ts
    └── screenshots/
```

## 開発ルール

### Gitコミット
- **コミットはユーザーが明示的に指示した場合のみ行うこと**
- 勝手にコミットしない。作業完了後も「コミットしますか？」と聞かず、ユーザーからの指示を待つ
- pushも同様に明示的な指示がある場合のみ

### タスクのデバッグ・修正
- **生成されたステップコード（step_*.ts）を直接書き換えてはならない**
- タスクがうまく動かない場合は、AIエージェント（planningAgent, codegenAgent, actionPlanAgent, analyzingAgent等）のプロンプトやロジックを改善して、アプリ自体が正しいコードを生成できるようにすること
- 問題の根本原因を特定し、同様のケースで汎用的に正しく動作するように修正すること
- MCPツールで直接操作（デスクトップ操作テスト等）するのはデバッグ・検証目的のみ。修正はアプリのコードに反映すること

## 開発方法

### ビルドと実行

```bash
# 依存関係インストール
pnpm install

# Swift CLI ビルド（macOS、初回のみ）
sh scripts/build-ax.sh

# 開発モード
pnpm dev

# プロダクションビルド
pnpm build
```

### MCP クライアントから Dodompa に接続する（エンドユーザー向け）

タスクレベルのツール (`task_list` / `task_run` / `task_generate` / …) は、Dodompa 起動中は常に `http://127.0.0.1:19876/mcp` から配信される。クライアントに合わせて以下のどちらかを使う。

#### Claude Code (streamable-HTTP — 推奨)

```bash
claude mcp add --transport http dodompa http://127.0.0.1:19876/mcp
```

あるいは Claude Code の設定に直書き:

```json
{
  "mcpServers": {
    "dodompa": {
      "type": "http",
      "url": "http://127.0.0.1:19876/mcp"
    }
  }
}
```

スクリプトパス不要。新しいツールを追加したら Dodompa を再起動するだけで反映される。

#### Claude Desktop (stdio ブリッジ)

Claude Desktop のカスタムコネクタ UI はまだ平文 `http://` を弾くので、stdio ブリッジ経由で繋ぐ。初回だけビルド:

```bash
pnpm -C mcp build
```

`~/Library/Application Support/Claude/claude_desktop_config.json` に追加:

```json
{
  "mcpServers": {
    "dodompa": {
      "command": "node",
      "args": ["/absolute/path/to/Dodompa/mcp/dist/stdio-bridge.js"]
    }
  }
}
```

ブリッジは JSON-RPC を stdio ↔ `:19876/mcp` で中継する 80 行程度のトランスポート層プロキシ。ツール定義自体は Electron 側 (`src/main/mcp/tools.ts`) にしか無い。

#### 動作確認

```bash
curl -s http://127.0.0.1:19876/health   # {"ok": true, "pid": ...}
```

失敗した場合は Dodompa アプリを起動していない。

### デスクトップ MCP サーバーによるデバッグ（推奨）

Dodompa のデスクトップ自動化機能は、**開発・デバッグ用 MCP サーバー (`mcp/src/index.ts`) 経由で Claude Code / Claude Desktop から直接テスト・デバッグ**できる。（プロダクション用の `mcp/src/production.ts` は上記「MCP との関係」で説明したタスクレベルの制御用で、ここで扱う低レベルプリミティブとは別物。）
これが最も効率的な開発方法。

#### セットアップ

`~/Library/Application Support/Claude/claude_desktop_config.json` に追加:

```json
{
  "mcpServers": {
    "dodompa-desktop": {
      "command": "/path/to/npx",
      "args": ["-y", "tsx", "/path/to/Dodompa/mcp/src/index.ts"]
    }
  }
}
```

#### 使えるMCPツール

| ツール | 説明 |
|-------|------|
| `list_windows` | 開いているウィンドウ一覧（PID, app名, タイトル） |
| `get_accessibility_tree` | アプリのAXツリー取得（要素のrole, title, path, position） |
| `find_elements` | AXツリーから要素検索（role + title） |
| `element_at_point` | 座標にある要素を取得 |
| `perform_action` | AXアクション実行（AXPress等） |
| `click` / `double_click` / `right_click` | マウスクリック |
| `type_text` | テキスト入力 |
| `hotkey` | ショートカットキー（例: command+c） |
| `press_key` | 単一キー押下 |
| `screenshot` | スクリーンショット取得 |
| `activate_app` | アプリをフォアグラウンドに |
| `open_app` | アプリ起動（open -a） |
| `run_shell` | シェルコマンド実行 |
| `wait_for_element` | 要素出現待機 |
| `click_element` | 要素検索→クリック |

#### デバッグの流れ（例: Calculatorボタン操作）

```
1. list_windows で Calculator の PID を確認
2. get_accessibility_tree でボタンの role/title/path を確認
3. find_elements で特定のボタンを検索
4. perform_action または click で実際に操作
5. screenshot で結果を確認
6. 問題があればコードを修正
```

MCPで動作確認してからアプリのコード（aiAgent.ts等）に反映する。
これにより、Electronアプリを起動せずに内部機能をインタラクティブにテストできる。

### MCP自己デバッグ（タスク生成・実行の問題解析）

Dodompaアプリが起動中であれば、`electron_db_query` と `electron_ipc` で内部状態を直接検査できる。
全フェーズの結果（アクションプラン、解決済みセレクタ、生成コード、エラー履歴）が `generation_step_logs.detail` に JSON で保存される。

#### よく使うデバッグクエリ

```sql
-- 直近のタスク生成ログ（最新20件、フェーズ・メッセージ・詳細）
SELECT phase, message, detail, created_at
FROM generation_step_logs
ORDER BY created_at DESC LIMIT 20;

-- 特定タスクの生成フロー全体を時系列で確認
SELECT phase, message, substr(detail, 1, 200) as detail_preview, created_at
FROM generation_step_logs
WHERE task_id = 'TASK_ID'
ORDER BY created_at ASC;

-- エラーだけ抽出（fixing フェーズ = リトライが発生した箇所）
SELECT message, detail, created_at
FROM generation_step_logs
WHERE phase = 'fixing'
ORDER BY created_at DESC LIMIT 10;

-- 生成コードを確認（generating フェーズの detail にコードが入る）
SELECT message, detail
FROM generation_step_logs
WHERE phase = 'generating' AND message LIKE '%コード生成完了%'
ORDER BY created_at DESC LIMIT 5;

-- セレクタ解決結果を確認（selector フェーズ）
SELECT message, detail
FROM generation_step_logs
WHERE phase = 'selector' AND detail IS NOT NULL
ORDER BY created_at DESC LIMIT 5;

-- アクションプラン詳細（generating フェーズの detail に JSON）
SELECT message, detail
FROM generation_step_logs
WHERE phase = 'generating' AND message LIKE '%アクションプラン生成完了%'
ORDER BY created_at DESC LIMIT 5;
```

#### デバッグの使い分け

| 調べたいこと | 使うツール | 方法 |
|------------|-----------|------|
| 生成パイプラインの問題 | `electron_db_query` | 上記SQLで `generation_step_logs` を検査 |
| 実行結果・エラー | `electron_db_query` | `execution_logs` + `step_logs` を検査 |
| AIプロンプト/レスポンス | `electron_db_query` | `ai_logs` の prompt/response を検査 |
| デスクトップの現在状態 | `list_windows` + `get_accessibility_tree` | ウィンドウ一覧 → AXツリー |
| 要素の座標・操作テスト | `find_elements` + `perform_action` | 直接操作して動作確認 |
| アプリ内部状態 | `electron_eval` | メインプロセスのJS実行 |
| タスク定義の確認 | `electron_ipc` | `task:get` + `task:readAllStepFiles` |

## アーキテクチャ上の重要ポイント

### AI生成フロー（aiAgent.ts → agents/）

タスク生成は以下のフェーズで進む。各フェーズは専用のエージェントファイルで実装:

| フェーズ | エージェント | UI表示 | 説明 |
|---------|-------------|--------|------|
| 1. プランニング | `planningAgent.ts` | [PLAN] | タスク指示をステップに分解（`type: 'browser' \| 'desktop'`） |
| 2. 分析 | `analyzingAgent.ts` | [ANALYZE] | スクリーンショット + HTML/AXツリーを取得。`sdef` で AppleScript 辞書も動的検出 |
| 3. アクションプラン | `actionPlanAgent.ts` | [GEN] | AIが具体的なアクション列を生成 |
| 4. セレクタ解決 | `selectorAgent.ts` | [SELECT] | CSS/XPathセレクタまたはAX要素を**実機ツリーで検証**。miss 時は同 role 候補リストを返す |
| 4.5. プローブ・リプラン | (`aiAgent.ts` 内) | [SELECT] | unresolved があれば候補リストを actionPlanAgent に戻して 1 回だけ選び直させる (軽量ループ) |
| 5. コード生成 | `codegenAgent.ts` | [GEN] | 検証済みセレクタ/要素からステップコードを生成 + post-codegen patcher で英語アプリ名等を自動修正 |
| 6. 実行 | （aiAgent.ts内） | [EXEC] | 生成コードを実行 |
| 7. 検証 | `verifyAgent.ts` | [VERIFY] | 実行後にスクリーンショットで成功を確認 |
| 8. 診断 | `failureDiagnosis.ts` | [FIX] | 失敗をカテゴリに分類し、具体的な hypothesis と untried 戦略を出す |
| 9. 修正 | （リトライループ） | [FIX] | 診断結果と strategy ledger を渡してリトライ（最大3回） |
| 10. リプランニング | `replanAgent.ts` | [PLAN] | 3回失敗でステップ自体を分割・再構成 |

### 同じミスを繰り返さないための失敗診断パイプライン (重要)

Dodompa の生成エンジンの肝は「**失敗を **AI の自由文ではなく **構造化された診断**に変換し、次の試行に正確に伝える**」こと。
カテゴリと untried 戦略台帳 (`strategy_ledger`) を渡すことで、AI が同じ間違いを繰り返さないように誘導する。

#### `failureDiagnosis.ts` のカテゴリ

- `precondition_not_met` — 対象アプリが起動していない / 想定ウィンドウが無い / `ctx.shared.xxx` が前ステップから渡っていない
- `precondition_not_met` (locale-mismatched app name サブ) — 「Mailアプリが起動していません」等、英語ハードコードのアプリ名比較で失敗 → 日本語名 / bundleId 併記の修正方針を hypothesis に明示
- `selector_resolution_failed` / `element_not_found_runtime` — `findElement` が null。同 role の候補列挙を提案
- `action_execution_error` — クリック/タイプ/シェル/AppleScript 系の実行時失敗。サブカテゴリ:
  - **AppleScript 系** (`-1728`/`-1743`/`-10000`): 辞書にない / サンドボックス拒否 / 型不一致。AX 経路への切替指示
  - **AppleScript date 系** (`-30720`): `date "明日 10:00 AM"` のような自然言語を AppleScript に渡している。JS で Date を作って `set year/month/day/hours of` パターンを指示
  - **モーダルダイアログ系**: `display dialog` / `display alert` / `choose from list` / `prompt(` を検知。「自動化では絶対使うな」+「console.log / ctx.shared に置き換えよ」を指示
  - **シェルサブプロセス系**: python3 / osascript / open がエラー終了
  - **ファイル / パス系**: `enoent` / `ファイルが見つかりません` / `screencapture` 出力先ずれ等
  - **JavaScript ランタイム系** (`is not defined` / `cannot read property` / `is not a function` / `SyntaxError`): 未宣言変数 / null アクセス / typo を識別子付きで具体化
  - **Playwright context-closed 系**: `page.goto: ... has been closed`。step type を browser → desktop (Safari は AppleScript) に切替指示
- `step_timeout` — タイムアウト
- `unknown` — 上記に当てはまらない (フォールバック、追加すべきパターンの兆候)

#### Strategy Ledger (試行履歴の構造化)

`failureDiagnosis.ts` の `StrategyLedger` は、ステップ毎に「過去の試行で何をやって、何が失敗して、何をまだ試していないか」を保持する。
- `attempts[]`: 各リトライの category / where / hypothesis / 試した戦略の要約
- `untried[]`: そのカテゴリでまだ試していない戦略候補 (e.g., 「bundleId で比較する」「クリップボード paste にする」「Cmd+Shift+G で絶対パス指定」)
- 次のリトライ時に **strategy ledger を formatLedgerForPrompt() でテキスト化**し、actionPlanAgent / codegenAgent のプロンプトに混ぜ込む
- これで AI は「前回 A をやって失敗した、今回は B を試せ」という具体的な指示を受けて、同じコードを生成しなくなる

#### Pre-retry 副作用クリーンアップ

- 前回エラーが `display dialog`/`display alert` 系を含む場合、リトライ前に `osascript -e 'tell application "System Events" to repeat 6 times key code 53'` で Escape 連打。スタックしたモーダルダイアログを掃除してから再実行
- これがないと「前回失敗した display dialog が画面に残ったまま、次のリトライがその上にかぶさる」現象が起きる

### Cross-Step Shared State (生成時テスト実行の落とし穴)

**最重要バグの一つだったので明記**: `aiAgent.ts` の `runAutonomousGeneration()` でステップを順次テスト実行する際、`shared` オブジェクトを**全ステップで同じインスタンスを使い回す**こと。
かつてここを `{ shared: {} }` と毎回新規生成していたため、step8 が `ctx.shared.csvData = [...]` を書き込んでも step9 が `undefined` を見て無限リトライ・誤診断ループに入る致命的バグがあった。

```typescript
// ✅ 正しい: ループの外で 1 回だけ生成
const executionShared: Record<string, unknown> = {}
// ステップ実行時に同じ参照を渡す
await stepModule.run(desktopCtx, { profile: {}, input: executionInput, shared: executionShared, ai: createStepAiHelper() })
```

`taskRunner.ts` (本番実行) は元々これが正しく実装されていたが、`aiAgent.ts` (生成時テスト実行) だけ漏れていた。**生成時に動いたものが本番でも動く保証が崩れる**ので、ここは絶対に共有参照を維持すること。

### 動的 AppleScript 辞書検出 (analyzingAgent)

ハードコードの allowlist に頼らず、ランタイムで `sdef` を呼んで AppleScript Dictionary の有無を判定する:

```typescript
// 1. bundleId から .app パスを mdfind で動的解決 (ロケール非依存)
const { stdout: bundlePath } = await exec('mdfind', [`kMDItemCFBundleIdentifier == "${bundleId}"`])
const appPath = bundlePath.split('\n').find(p => p.endsWith('.app'))

// 2. sdef で辞書を取得
const { stdout } = await exec('sdef', [appPath], { timeout: 3000 })
if (stdout.length > 200 && /<dictionary[\s>]/.test(stdout)) {
  // 主要コマンド・クラス名を抽出
  const commands = Array.from(stdout.matchAll(/<command\s+name="([^"]+)"/g)).map(m => m[1])
  // → analyzingAgent の出力に "AppleScript Dictionary: あり / 主なコマンド: ..." を注入
}
```

これで Apple 純正 / Office / 第三者アプリも区別なく「辞書があるなら AppleScript 優先」と判断される。新しいアプリが出てもプロンプトを更新する必要がない。

### デスクトップ自動化の注意点

- macOSのアクセシビリティ権限が必要（System Settings > Privacy & Security > Accessibility）
- アプリ起動は `open -a "AppName"` を使う（Spotlightは不安定）
- AXツリーの要素title はロケールに依存する（日本語環境では日本語になる場合あり）
- `waitForElement` でアプリ名からPIDを解決する — ウィンドウリストに表示されない特殊アプリ（Spotlight等）は使えない

### デスクトップ自動化タスクの戦略（重要）

タスク生成・実行時は以下の優先順位で戦略を選ぶこと。決め打ちの座標クリックやキー入力は**最終手段**。

#### 1. 階層戦略: CLI > URL Scheme > AppleScript > AX API > 座標クリック

操作手段は上から順に検討する。下に行くほど環境依存・脆弱になる。

| 優先度 | 手段 | 例 | 長所 |
|-------|------|----|----|
| 1 | **シェル/CLI** | `open -a`, `osascript`, `pbcopy`/`pbpaste`, `defaults`, `mdfind`, `shortcuts run`, `screencapture`, `caffeinate` | 決定的・高速・ロケール非依存 |
| 2 | **URL Scheme / ディープリンク** | `open "slack://channel?..."`, `open "raycast://..."`, `open "x-apple-reminderkit://..."` | アプリ内の特定画面に直接遷移 |
| 3 | **AppleScript / JXA** | `osascript -e 'tell application "Mail" to ...'` | アプリのスクリプト辞書がある場合に強力 |
| 4 | **AX API（Swift CLI）** | `perform_action AXPress` | UI操作だが座標非依存 |
| 5 | **座標クリック / キー送信** | `click(x,y)`, `type_text` | どうしようもない時のフォールバック |

**原則**: コマンドラインで実現できるもの（ファイル操作、アプリ起動、クリップボード、システム設定、通知、スクリーンショット、日付計算、ネットワーク等）は**必ずシェル経由で行う**。`planningAgent` / `actionPlanAgent` のプロンプトには「UI操作を選ぶ前にCLI/AppleScript/URL Schemeで実現できないか検討する」ルールを明記すること。

#### 2. 操作対象の特定は「事前分析」必須

**決め打ち禁止**。UI要素の title / ラベルはロケール（日本語/英語）、OSバージョン、アプリバージョン、テーマ、A/Bテストで変わる。`actionPlan` → `selector` の段階で必ず以下を行う:

1. **`list_windows`** で対象アプリが起動中か、PIDと実際のウィンドウタイトルを確認
2. **`get_accessibility_tree`** で現在の状態のAXツリーをダンプし、`role` / `title` / `description` / `path` を**実測**する
3. **`find_elements`** で候補を絞り、複数マッチした場合は path・位置・親要素で一意化
4. 実測した結果をもとに `selectorAgent` がAX要素を確定し、**解決済みの path / title をコードに埋め込む**（「日本語だろう」と推測した文字列を埋め込まない）
5. AXツリーが浅い（Electron/WebView 等で 5 要素程度）場合は、AX に頼らず**ウィンドウタイトル変化・スクリーンショット差分**で状態を検証する戦略に切り替える

`analyzingAgent` は必ず AXツリー + スクリーンショットのペアを取得する。片方だけでは不十分。

#### 3. 状態確認 → 操作 → 検証のループ

各アクションの前後で状態をチェックする:

- **前提確認**: 期待するウィンドウがフォアグラウンドか（`list_windows` で frontmost を確認）、無ければ `activate_app`
- **操作実行**: AX 優先、フォールバックで座標
- **後置検証**: AXツリー再取得 or ウィンドウタイトル変化 or スクリーンショット差分で状態遷移を確認してから次に進む
- **タイミング**: 固定 sleep は避け、`wait_for_element` で要素出現を待つ。どうしても sleep が必要な場合は理由をコメントに残す

#### 4. ロケール・環境依存の排除

- 文字列比較は部分一致 or 正規表現 or 複数候補（日本語＋英語）でフォールバック
- キーボードショートカットは**機能ベース**で選ぶ（Copy は `command+c` で万国共通。メニュー項目「コピー」を文字列検索しない）
- 日付・時刻はシステムロケールに依存しない ISO 形式で扱う
- アプリのバージョン差でAXパスが変わるため、絶対パスではなく **role + title + 親コンテキスト** で要素を特定する

#### 5. AppleScript の使いどころ(重要)

AppleScript は **辞書(Scripting Dictionary)を持つアプリ限定**で使う。原則は「データ操作ができる辞書があるアプリでのみ一次手段にする」。

**✅ 許可リスト**(AppleScript を一次手段にしてよい):
- Apple 純正: Mail, Finder, Notes, Reminders, Calendar, Contacts, Messages, Safari, Preview, Keynote, Numbers, Pages, Music, Photos, System Events
- Microsoft Office: Word, Excel, PowerPoint, Outlook (2016 以降)
- サードパーティ: OmniFocus, Things, Fantastical, Hazel, BBEdit, DEVONthink

**❌ 禁止**(AppleScript を一次手段にしない — `activate` 程度は可):
- Electron/Chromium ベース全般: Slack, Discord, Notion, Figma, VS Code, Cursor, Zoom, Obsidian, Linear, Spotify, Claude Desktop
- 辞書を持たないネイティブアプリ、Mac App Store のサンドボックスアプリ
- これらでは AXツリー + hotkey + クリップボード paste を使う

**エラー判定**: 以下が返ったら AppleScript 経路は諦めて AXツリー/キーボード経路にフォールバックする。`failureDiagnosis.ts` が自動で `action_execution_error` に分類して untried 戦略を提案する。
| コード | 意味 | 対処 |
|--------|------|------|
| `-1728` errAENoSuchObject | コマンドが辞書にない | 許可リスト外のアプリで発生 → AXツリー経路へ |
| `-1743` errAEEventNotPermitted | サンドボックスで拒否 | システム設定のオートメーション許可を確認、不可なら AX 経路へ |
| `-10000` | オブジェクト型ミスマッチ | 構文ミス or 辞書の型定義と合致していない |
| `-10006` | 読み取り専用プロパティへ set | 別のコマンドを探す |

**長文入力は paste が堅い**: `osascript -e 'set the clipboard to "..."'` でクリップボードに入れてから `hotkey('command', 'v')` で貼り付ける方が、文字列エスケープの地獄を回避できる。

#### 6. エラー時のリカバリ

- 「見つからない」は即失敗ではなく、**再分析（AXツリー再取得 + スクリーンショット）してリトライ**
- 同じアプローチで3回失敗したら `replanAgent` でステップ分割・別手段（CLI 等）への切替を検討
- `stepResults` に失敗理由を記録し、後続ステップが前提条件を回復できるようにする

### ブラウザ自動化の注意点

- `launchPersistentContext` で独自のユーザーデータディレクトリを使用（システムChromeと競合しない）
- ログインはユーザーに委ねる（AIがログインコードを生成しない）
- `storageState` オプションは persistent context では機能しない — `context.addCookies()` で手動注入
- `waitForLoadState('networkidle')` は使わない（SPAで永久に完了しない）— `domcontentloaded` を使う

### ステップ間のコンテキスト共有

生成パイプラインでは、各ステップの実行結果（成功/失敗/エラー内容）が `stepResults` 配列に蓄積され、
後続ステップの **actionPlanAgent** と **codegenAgent** に自動的に渡される。

これにより：
- ステップ2（DM検索）が失敗した場合、ステップ3（メッセージ送信）はDM画面が開いていないことを認識し、自律的に前提条件の回復を試みる
- 前ステップの失敗パターンを踏まえた、より堅牢なアクションプランとコードが生成される

```
stepResults: Array<{
  stepName: string      // ステップ名
  description: string   // ステップの説明
  success: boolean      // 成功/失敗
  error?: string        // エラーメッセージ（失敗時）
  verifyReason?: string // 検証結果の理由
}>
```

### メッセージングアプリのクイックスイッチャー戦略

Slack等のCmd+Kクイックスイッチャーを使ったDM/チャンネル検索は、以下のロバスト化が必須：

1. **検索画面を脱出してからCmd+K**: Slackの検索結果画面ではCmd+Kが検索バーにフォーカスされてしまう。**Escを3回押して検索画面を閉じてからCmd+Kを実行**すること
2. **複数クエリ候補の生成**: `ctx.ai()` で日本語名→ローマ字、フルネーム→姓のみ等、3つの検索候補を生成
3. **ウィンドウタイトル検証**: AXツリーが浅いElectronアプリ（Slack等は5要素程度）ではAXツリーで候補リストを検出できない。代わりに**ウィンドウタイトルから「検索」「Search」が消えたかで遷移を検証**
4. **フォールバック**: DM遷移できなければEscで閉じて次のクエリで再試行
5. **エラーハンドリング**: 全クエリ失敗時は具体的なエラーメッセージ（試行したクエリ一覧付き）をthrow

### コード生成後のバリデーション（validateAndPatchQuickSwitcher）

`codegenAgent.ts` の `validateAndPatchQuickSwitcher()` 関数が、AIが生成したコードに対して以下を自動チェック・修正する：
- `hotkey('command', 'k')` が検出された場合
- AXツリー検証もウィンドウタイトル検証もない場合
- → コードの該当ブロックを**検索画面脱出Esc + 複数クエリ + ウィンドウタイトル検証パターン**に自動置換

### Slack DM のデスクトップ操作における既知の制約（2026-03時点）

| 制約 | 詳細 |
|------|------|
| AXツリーが5要素のみ | Electron/WebViewアプリのためAXツリーが浅い。Quick Switcher候補やメッセージ入力欄をAXツリーで検出不可 |
| 検索画面でCmd+Kが効かない | 検索結果画面ではCmd+Kが検索バーのフォーカスになる。Escで脱出が必要 |
| ウィンドウタイトルの遅延更新 | 画面遷移後もウィンドウタイトルがすぐに変わらない場合がある |
| 将来の対策 | Slack API（OAuth認証の永続化）が実装されれば、UI操作ではなくAPI経由でDM送信が確実 |

### よくある問題と対策

| 問題 | 原因 | 対策 |
|------|------|------|
| SingletonLock エラー | 前回のChromeプロセスが残存 | 起動前にロックファイルを削除 |
| プロファイル互換性エラー | システムChromeとバンドル版Chromiumのバージョン差 | プロファイルディレクトリを削除して再作成 |
| セレクタが見つからない | 動的ID、ロケール依存のラベル | AXツリーを直接確認してtitleを特定 |
| AIが同じミスを繰り返す | エラー履歴が渡されていない / 診断が generic | failureDiagnosis でカテゴリ分類 + strategy ledger を formatLedgerForPrompt() で次プロンプトに注入 |
| replanでtypeが消える | 再計画時にtype未指定 | replanプロンプトでtype継承を明示 |
| Quick Switcherで候補0件→検索画面に遷移 | Returnを無条件に押している | AXツリーで候補確認後にReturn、0件ならEscで閉じてリトライ |
| 前ステップ失敗でDM画面未開→メッセージ入力失敗 | ステップ間の結果が共有されていない | stepResults で前ステップの結果を後続に伝達 |
| `Mailアプリが起動していません` 等を永久に繰り返す | 生成コードが `w.app === 'Mail'` と英語ハードコード | bundleId 優先 + 日本語名併記 + 部分一致。post-codegen の `validateAndPatchAppNameHardcode` で自動書換 |
| Slack 等のテンプレが他アプリで動かない | Quick Switcher テンプレ内に `'Slack'` リテラル | テンプレを APP_NAME 変数化、ウィンドウ再検索は pid ベース (locale-agnostic) |
| `display dialog` が画面に積み重なる | 自動化コードが対話モーダルを使った | プロンプトで全面禁止 + 診断ブランチ + pre-retry Escape クリーンアップ |
| `保存するCSVデータが見つかりません` 系を window-not-found と誤診断 | 診断 regex の negative-guard 不足 | failureDiagnosis に「ファイル/data/csv 系キーワードがあれば cross-step data handoff として分類」のブランチ |
| 生成時のテスト実行でステップ間データが消える | `aiAgent.ts` で `shared: {}` を毎回新規生成していた | `executionShared` を 1 回だけ作り全 step に同じ参照を渡す |
| 「ファイル一覧取得」等のシェル系タスクで Terminal.app を開いてしまう | プロンプトに shell-first ルールがなかった | actionPlanAgent / codegenAgent に「シェルで済むタスクは execFile で直接実行、Terminal UI 経由は禁止」を明記 |
| `アプリを起動` placeholder ステップが入る | planner が「2 ステップ以上に必ず分割」していた | 「タスクの実体で決める」に変更 + placeholder-launch-step を post-process で削除 + auto-split の generic-app-name 回避 |
| URL/人名/値が AI に「一般化」される | planner が exact value を要約してしまっていた | 「ユーザー指示の具体値は一字一句 variables の default に保存」ルールを planner プロンプトに追加 |
| AppleScript 許可リストが新しいアプリで動かない | アプリ名を静的列挙していた | analyzingAgent で `mdfind`+`sdef` を実行時に呼び、辞書の有無を動的判定 → プロンプトに注入 |
| AppleScript date "明日 10:00" が `-30720` で失敗 | AppleScript は自然言語日付を解釈しない | JS で `new Date()` を作り `set year/month/day/hours of theDate` パターンで AppleScript 側で組み立て。診断ブランチも追加 |
| TextEdit/Notes 等で AX ツリーが取れない | SwiftUI 系で AX 実装が不安定 | アプリが許可リストなら最初から AppleScript 経路を選び AX を回避 (sdef 検出が効く) |
| `desktop.type()` した日本語が IME で化ける | type は ASCII しか安全でない | 日本語/絵文字/非 ASCII は必ずクリップボード paste (`pbcopy` + `Cmd+V`) を使う。`pasteText` ヘルパー関数パターンを codegen プロンプトに記載 |
| 保存ダイアログで `Cmd+D → filename → Return` が不安定 | macOS バージョン差で `Cmd+D` の挙動が変わる | `Cmd+Shift+G` で「フォルダへ移動」ダイアログを開き絶対パスを paste するパターンに統一 |
| 「ファイルを保存」したのに verifier が「成功」を返したが実ファイルがない | verifier はスクリーンショット比較なので画面の見た目で誤判定 | ファイルシステム副作用がある操作は実行末尾に `await exec('test', ['-f', expectedPath])` で必ず存在確認 |
| 「Safari で開いて」が Playwright Chromium で起動される | planner が browser 型に routing | 特定アプリ名 (Safari/Chrome/Firefox/メモ/メール 等) が出たら desktop 型に強制。planner プロンプトに明記 |
