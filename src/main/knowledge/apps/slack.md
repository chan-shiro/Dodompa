---
name: slack
description: Quick Switcher and send rules for Electron-based messaging apps (Slack, Discord, Teams, Notion, etc.)
app: Slack
bundleIds: [com.tinyspeck.slackmacgap, com.hnc.Discord, com.microsoft.teams, com.microsoft.teams2, notion.id]
aliases: [Slack, slack, Discord, discord, Teams, teams, Microsoft Teams, Notion, notion]
category: electron-messaging
appleScript: none
---

## ★ Known constraints of Electron-based messaging apps
- **AX tree is shallow (~5 elements)**, so Quick Switcher candidates cannot be detected via the AX tree
- **Pressing Cmd+K while the search screen is open moves focus to the search bar instead of opening the Quick Switcher**
- → Always **Esc out of the search screen first, then press Cmd+K**
- → Verify DM navigation via **window title changes**, not the AX tree
- Shortcut depends on the app: **Slack / Discord / Notion = Cmd+K, Teams = Ctrl+G, Messages = Cmd+N**

## ★ Send key: always prefer Cmd+Return
Slack (and other Electron messengers like Discord / Teams) lets the user choose which key sends a message. Two configurations coexist in the wild:

| User setting | `Return` | `Cmd+Return` |
|--------------|----------|--------------|
| Default ("Return sends a message") | **send** | send (also works) |
| Alternative ("Start a new line with Return") | newline | **send** |

**Always use `desktop.hotkey('command', 'Return')` to send.** It works in *both* configurations, whereas a bare `Return` silently inserts a newline for users on the alternative setting. Detecting which setting is active at runtime is not reliable, so don't try — just always send with Cmd+Return.

```typescript
// After the message text is in the input field:
await desktop.type(ctx.input.message ?? '');
await new Promise(r => setTimeout(r, 300));
await desktop.hotkey('command', 'Return'); // ★ Works on both "Return sends" and "Cmd+Return sends" settings
```

Same rule applies to Discord and Microsoft Teams (both expose the same preference).

## ★ Forced Quick Switcher pattern (copy-paste ready)
A naive "Cmd+K → type → Return" is **forbidden**. If no candidates match, pressing Return jumps to the search screen instead of opening a DM.
Always use the pattern below, substituting `APP_NAME` with the `detectedAppName` discovered at runtime:

```typescript
const rawRecipient = ctx.input.recipient ?? '';
const APP_NAME = '<detectedAppName>';           // 例: 'Slack' / 'Microsoft Teams' / 'Discord' / 'メッセージ'
const APP_BUNDLE_HINT = '<best-guess-bundleId>'; // 例: 'com.tinyspeck.slackmacgap' — 分からなければ空文字でも可

// 複数の検索クエリ候補を生成
const searchQueries: string[] = [];
if (rawRecipient.startsWith('@') || rawRecipient.includes('#')) {
  searchQueries.push(rawRecipient);
} else {
  const resolved = await ctx.ai(
    `${APP_NAME} で "${rawRecipient}" という人やチャンネルを検索したい。` +
    `${APP_NAME} の検索/クイックスイッチャーに入力する候補を3つ返してください。` +
    `・日本語名はローマ字表記も考慮(例: 福田 → fukuda, Fukuda)` +
    `・フルネーム、姓のみ、ローマ字表記などバリエーションを含める` +
    `・1行に1候補、余計な説明なし、番号なしで返してください`
  );
  searchQueries.push(...resolved.trim().split('\n').map((s: string) => s.trim()).filter(Boolean));
  if (!searchQueries.includes(rawRecipient)) searchQueries.push(rawRecipient);
}

const windows = await desktop.getWindows();
const appWin = windows.find(w =>
  (APP_BUNDLE_HINT && w.bundleId === APP_BUNDLE_HINT) ||
  w.app === APP_NAME ||
  w.app?.includes(APP_NAME) ||
  w.bundleId?.toLowerCase().includes(APP_NAME.toLowerCase())
);
if (!appWin) throw new Error(`${APP_NAME} ウィンドウが見つかりません (実在: ${windows.map(w => `"${w.app}"`).join(', ')})`);
const pid = appWin.pid;

// ★ 検索画面やモーダルを閉じてから Quick Switcher を開く
for (let i = 0; i < 3; i++) {
  await desktop.pressKey('Escape');
  await new Promise(r => setTimeout(r, 300));
}
await new Promise(r => setTimeout(r, 500));

let dmOpened = false;
for (const query of searchQueries) {
  // ショートカットはアプリ依存: Slack/Discord = Cmd+K, Teams = Ctrl+G, Notion = Cmd+P, Messages = Cmd+N
  // まずは Cmd+K を試し、ウィンドウタイトルが変わらなければ他を試すこと
  await desktop.hotkey('command', 'k');
  await new Promise(r => setTimeout(r, 800));
  await desktop.hotkey('command', 'a');
  await new Promise(r => setTimeout(r, 100));
  await desktop.type(query);
  await new Promise(r => setTimeout(r, 1500));

  await desktop.pressKey('Return');
  await new Promise(r => setTimeout(r, 2000));

  // ★ ウィンドウタイトル変化で遷移を検証 (AX ツリーは Electron では浅い)
  const updatedWindows = await desktop.getWindows();
  const updatedWin = updatedWindows.find(w => w.pid === pid);
  const newTitle = updatedWin?.title ?? '';
  if (!newTitle.includes('検索') && !newTitle.includes('Search')) {
    dmOpened = true;
    ctx.shared.resolvedRecipient = query;
    break;
  }
  await desktop.pressKey('Escape');
  await new Promise(r => setTimeout(r, 500));
}
if (!dmOpened) {
  throw new Error(`${APP_NAME} で宛先 "${rawRecipient}" が見つかりません。試行: ${searchQueries.join(', ')}`);
}
```
