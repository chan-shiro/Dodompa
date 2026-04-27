# Dodompa

> 🇺🇸 English: [README.md](README.md)

**AI のための RPA (RPA for AI)。** 何度も走らせる自動化のために作られた — 同じ作業が毎回フルで LLM コストを払わずに済むように。オープンソース、MIT ライセンス。

**Dodompa** — **D**ynamic **O**rchestration and **D**evelopment **O**f **M**achine **P**rocess **A**utomation.

## なぜ Dodompa か

Computer Use は単発の作業には素晴らしい。やりたいことを自然言語で伝えれば、Claude が端から端まで判断して実行してくれる。ただし同じ作業を**毎朝・毎デプロイ・届いたチケットごとに**走らせるとなると、実行のたびにフルで LLM コストを払い、再計画を待つことになり、時間もお金もかさんでくる。

Dodompa はこの問題を **「高コストな AI の計画作業を毎回ではなく 1 回だけに抑える」** ことで解決する。初回の成功時に、AI が自動化を **素の TypeScript ファイル** として書き出す。以降は Dodompa がそのファイルをそのまま走らせるだけで、再計画もナビゲーション用のトークン消費も発生しない。AI が呼ばれるのは、タスク自身が明示的に判断を必要とする箇所だけ。

- **初回**: 自然言語の指示 → AI がステップ分解 → 実物の TypeScript 生成 → 実行 → 動くまで自己修復
- **2 回目以降**: 生成済み TypeScript をそのまま実行。再計画もナビゲーション用トークン消費もなく、AI が呼ばれるのはコードが明示的に `ctx.ai(...)` した箇所のみ。決定論的で、実行コスト・速度ともに桁違いに改善される
- **壊れた時**: AI が失敗したステップだけを診断・修正。他のステップはコードのまま凍結される
- **判断が必要な時**: コード内から `ctx.ai("...")` で AI に相談、またはユーザーに問い合わせ

要するに、**計画は一度だけ、以降の実行は AI オーバーヘッドを最小化** — 初回に計画コストを払えば、2 回目以降はタスクが本当に必要とする判断呼び出しの分だけを払えばよい。

## Dodompa が向いているとき・向いていないとき

| 状況 | 向いているツール |
|---|---|
| 単発の探索 — 「今回 1 回だけやればいい」 | **Computer Use**。使い捨てに再利用コードを作っても意味がない |
| 同じ作業を 3 回以上 (日次レポート、定期スクレイピング、朝のセットアップ、PR ごとのチェック…) | **Dodompa**。初回だけ計画コストを払い、2 回目以降は計画スキップ + 本当に判断が必要な箇所だけ AI を呼ぶ |
| 同僚に渡したい・fork させたい・監査したい | **Dodompa**。出力は普通の `.ts` ファイルで、読める・diff できる・PR できる |
| 単純な会話タスク | Claude 直接。Dodompa は「走らせられる成果物」を作るためのもの |

判断軸はシンプル: **「このタスクを結晶化する価値があるか？」** 繰り返すならトークンと実時間を節約できる。一度きりなら余計な階層を挟むだけ。

## 何を自動化できるか

- **ブラウザ** — Playwright が本物の Chromium を操作。ログイン、フォーム、スクレイピング、複数タブのフロー、認証が必要な SaaS など
- **macOS デスクトップアプリ** — Accessibility API + キーボード/マウス + AppleScript。Mail、Finder、Notes、Slack、Excel、Calculator、その他 UI を持つアプリ全般

両者を混ぜたタスクも可能 — 1 つのタスクの中でアプリを開きコピーし、続きをブラウザで処理するといった流れが書ける。

## なぜビジュアルエディタではなくコードなのか

ノーコード RPA は、分岐・リトライ・API 呼び出し・データ整形・ループが必要になった瞬間にドラッグ&ドロップ UI の天井にぶつかる。Dodompa の出力は TypeScript そのもの。読める、編集できる、ライブラリをインポートできる、ローカルで動かせる、Git で diff できる。**AI が下書きを書き、人間は必要なら手直しする**という役割分担が一番合う。

## 仕組み

```
自然言語タスク
       │
       ▼
 ┌─────────┐    計画    ┌────────┐   生成     ┌────────┐
 │ 計画    │ ─────────▶ │ 生成   │ ─────────▶ │ 実行  │
 └─────────┘            └────────┘            └───┬────┘
      ▲                                           │
      │         失敗ステップだけを修正            │
      └── 分析 + パッチ agents ◀── 失敗時 ───────┘

      2 回目以降: 上の全部をスキップして「実行」だけ。
```

各エージェントは単一責務 (計画、コード生成、セレクタ解決、失敗分析、パッチ)。詳細と I/O 仕様は [AGENTS.ja.md](AGENTS.ja.md) と [docs/agent-reference.ja.md](docs/agent-reference.ja.md) にある。

## 技術スタック

| レイヤー | 技術 |
|-------|------|
| アプリシェル | Electron |
| UI | React + TypeScript + Tailwind CSS + i18next |
| ブラウザ自動化 | Playwright (`playwright-core`) |
| デスクトップ自動化 | Swift CLI (`dodompa-ax`) + AppleScript + Python/Quartz |
| AI 統合 | Vercel AI SDK (`ai` + `@ai-sdk/anthropic` / `@ai-sdk/openai` / `@ai-sdk/google`) |
| ローカル DB | SQLite (`better-sqlite3`) |
| ビルド | electron-vite |

## クイックスタート

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

アプリ起動後、**設定**で少なくとも 1 つの AI プロバイダ（Anthropic / OpenAI / Google / OpenAI 互換）を設定する。

### Claude から Dodompa を動かす（任意）

Dodompa は起動中、`http://127.0.0.1:19876/mcp` でタスク管理 API を MCP サーバーとして公開する。Claude Code / Claude Desktop から既存タスクの実行や新規タスク作成ができる。

**Claude Code** (streamable HTTP):

```bash
claude mcp add --transport http dodompa http://127.0.0.1:19876/mcp
```

**Claude Desktop** (stdio ブリッジ — Desktop のカスタムコネクタ UI は平文 `http://` を弾くため):

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

詳細とツール一覧: [AGENTS.ja.md](AGENTS.ja.md)。

## 言語設定

UI は英語と日本語に対応。初回起動時、OS のロケールを検出して近い方を選ぶ (`ja-*` → 日本語、それ以外 → 英語)。**設定 → 一般 → 言語** でいつでも変更可能。

LLM のプロンプト自体は常に英語 (その方が性能が安定する) だが、AI が生成するユーザー向けテキスト (タスク説明、エラー分析、提案など) は UI の言語設定に従う。

## 詳細ドキュメント

- **[AGENTS.ja.md](AGENTS.ja.md)** — アーキテクチャ、設計思想、エージェントパイプライン、デバッグガイド
- **[docs/agent-reference.ja.md](docs/agent-reference.ja.md)** — 各 AI エージェントの I/O 仕様
- **[src/main/knowledge/](src/main/knowledge/)** — 実行時にプロンプトへ注入されるアプリ固有ナレッジ。`planningAgent` / `exploratoryPlanAgent` / `codegenAgent` が `renderKnowledgeBlock()` 経由で取り込む

## コントリビュート

Issue・PR 歓迎です。特に **Windows 対応** はスコープが明確で入りやすい大型ネタなので、設計スケッチと募集中の領域は [CONTRIBUTING.ja.md](CONTRIBUTING.ja.md) を参照してください。

## ライセンス

MIT — [LICENSE](LICENSE) 参照。Fork して出荷してください。
