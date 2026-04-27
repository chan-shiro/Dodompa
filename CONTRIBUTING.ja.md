# Contributing to Dodompa

> 🇺🇸 English: [CONTRIBUTING.md](CONTRIBUTING.md)

ご興味ありがとうございます。Dodompa は MIT ライセンスで、開発はオープンに行っています。Issue・PR・設計議論、どれも歓迎です。

このドキュメントは意図的に薄く保っています。アーキテクチャ・設計思想・エージェント内部の詳細は [AGENTS.ja.md](AGENTS.ja.md) にまとまっているので、非自明な変更の前に目を通してください。

## セットアップ

```bash
# Clone
git clone <your-fork-url> Dodompa
cd Dodompa

# 依存関係インストール
pnpm install

# Swift CLI ビルド（macOS、初回のみ）
sh scripts/build-ax.sh

# 開発モード
pnpm dev

# プロダクションビルド
pnpm build
```

アプリ起動後、**設定**で少なくとも 1 つの AI プロバイダ (Anthropic / OpenAI / Google / OpenAI 互換) を設定する。設定しないとタスク生成でこけます。

あわせて読む:
- [AGENTS.ja.md](AGENTS.ja.md) — アーキテクチャ、エージェントパイプライン、デバッグガイド
- [docs/agent-reference.ja.md](docs/agent-reference.ja.md) — 各 AI エージェントの I/O 仕様

## 特にコントリビュート歓迎の領域

### 1. Windows 対応（大きいがスコープは明確）

**現状:** プレースホルダだけ。`src/main/desktop/win/index.ts` は "not yet implemented" を投げるだけ。

macOS のデスクトップ自動化は以下の構成で実装されている:
- `native/macos/dodompa-ax/` — Accessibility API をサブコマンド (`list-windows` / `tree` / `find` / `element-at` / `perform-action` / `click` / `right-click` / `move` / `drag`) で公開する小さな Swift CLI。出力は JSON
- `src/main/desktop/mac/` — CLI を `execFile` する TypeScript ラッパ群 (`axBridge.ts` / `keyboard.ts` / `mouse.ts` / `screenshot.ts` / `index.ts`)
- `src/main/desktop/platform.ts` — `process.platform` で実装を振り分けるファクトリ

**Windows 移植はこの形をそのままコピーする想定:**
1. **ネイティブ CLI を `native/windows/dodompa-ax/` に**。推奨スタック: **C# + .NET 8**。UIAutomation (`System.Windows.Automation`) が同じサブコマンド群に素直にマップでき、ビルドは `dotnet publish -c Release -r win-x64 --self-contained` 一発、配布もしやすい。C++ + COM UIAutomation も可能だが保守コストが高い。JSON 出力の形は Swift CLI と揃えてほしい — `WindowInfo` / `AXNode` のスキーマは [src/shared/types.ts](src/shared/types.ts) の `DesktopContext` 周辺を参照
2. **TypeScript ラッパを `src/main/desktop/win/` に**。`src/main/desktop/mac/` を鏡写しにする形で、CLI を叩く `axBridge.ts` と、Win32 `SendInput` + GDI / Desktop Duplication API を使う `keyboard.ts` / `mouse.ts` / `screenshot.ts` を作る。入力だけ Node ネイティブで済ませたい場合は `@nut-tree/nut-js` もあり。ただし AX 経路は CLI ベースのままにしてください — クロスプラットフォームでのアーキテクチャ一貫性が重要
3. **プラットフォーム配線**。`src/main/desktop/platform.ts` の `isDesktopSupported()` に `win32` を追加し、`scripts/build-ax.ps1`（もしくは同等のビルドスクリプト）を用意して Windows でも `pnpm install && build-ax` だけで立ち上がるようにする
4. **パッケージング**。`electron-builder` 設定を追加し、Windows バイナリが `resources/bin/` に同梱されるように

**そのまま移植できない部分:**
- AppleScript 同等品は無し。Windows アプリでスクリプタブルインターフェースを持つものはほぼ無いので、フォールバックは「UIAutomation で全部やる」方針で、AppleScript 分岐はスキップ。`src/main/ipc/agents/` 配下で `sdef` / `osascript` 呼び出しがある箇所はプラットフォーム分岐されているはずだが、計画プロンプトで Windows 実行時に AppleScript を提案しないよう更新が必要
- Bundle ID は `ProcessModuleFileName` (実行ファイル絶対パス) に相当。`src/main/knowledge/apps/*.md` の `bundleIds` フィールドはマッチしないので、`executables:` のような同等フィールドを足して [src/main/knowledge/index.ts](src/main/knowledge/index.ts) の `resolveKnowledge()` を拡張することを検討してください

設計の相談は喜んで乗ります。`platform:windows` ラベルで issue を立て、想定スタックと未解決の論点を書いてもらえば、コーディング前に揃えられます。

### 2. Linux 対応

Windows と同じ形で、AT-SPI を `python-atspi` 経由または小さな Rust/Go CLI でラップして同じサブコマンド契約を実装する。Windows より優先度は低いですが、興味があれば issue を。

### 3. アプリ固有ナレッジの追加（最初の PR に最適）

アプリ別のプロンプトナレッジは [src/main/knowledge/apps/](src/main/knowledge/apps/) に Markdown + YAML frontmatter 形式で置かれている。新しいアプリ (LINE / Discord / Spotify / Bear / Obsidian …) のサポートは、多くの場合 20〜100 行のマークダウンを足すだけで済み、planning / codegen エージェントで即座に使われます。

既存の `apps/*.md` を参考にしてください。frontmatter の仕様は [src/main/knowledge/index.ts](src/main/knowledge/index.ts) の `KnowledgeFrontmatter` 型。ユーザーに見える効果を一番安く出せる領域です。

### 4. テストカバレッジ

現状のテストは薄め。既知の HTML fixture やモック AX ツリーに対して、生成済みステップファイルを決定論的に再生できる仕組みがあれば嬉しい。テストハーネス整備を検討する場合はスコープ擦り合わせのため先に issue を立ててください。

### 5. 翻訳

UI 文字列は i18next で管理されている (`src/shared/i18n/` と各 renderer ファイル)。現在は英語・日本語のみ。他言語のリソースファイル追加 PR を歓迎します (detector への紐付けもあわせて)。

## PR の作法

- **1 PR 1 関心事**。Windows AX CLI と planning プロンプトのリファクタが同じ PR に混ざるとレビュー不能
- **コミットメッセージ**: 命令形で短い一行目、変更理由が非自明なら本文に *why* を
- **生成された `step_*.ts` を直接書き換えて修正しない**。生成したエージェント側を直すこと。詳細は [AGENTS.ja.md](AGENTS.ja.md) の「デバッグ / 修正」節
- **無断の一括フォーマット変更は避ける**。プロジェクトのスタイルを変えたい場合は先に issue を
- **push 前に型チェック**: `pnpm build` が通ること (ただし `src/main/ipc/agents/` 以下に既知の型エラーがあるので、そこを触る PR でない限りは気にしなくて OK)

## Issue / 議論

- **バグ** — 再現手順、期待値と実際、OS / モデルプロバイダ
- **機能要望** — まず実現したいワークフローの説明、実装はその後
- **設計相談** — 大きな変更 (新エージェント、スキーマ変更、プラットフォーム移植) はコーディング前に issue で揃えてから進めると効率が良い

## ライセンス

PR を送ることで、そのコントリビュートが [MIT License](LICENSE) で公開されることに同意したものとみなします。CLA はありません。
