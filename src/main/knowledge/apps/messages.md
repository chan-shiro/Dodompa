---
name: messages
description: Rules for sending iMessage/SMS via the macOS Messages app
app: Messages
bundleIds: [com.apple.MobileSMS, com.apple.iChat]
aliases: [Messages, messages, メッセージ]
category: apple-native
appleScript: limited
---

## ★ The Messages shortcut is Cmd+N (new conversation)
Unlike Slack/Discord, there is no Quick Switcher. Open a new conversation with `Cmd+N` and the recipient field receives focus.

## ★ Send-message pattern
```typescript
// 1) Messages を起動
await exec('open', ['-a', 'Messages']);
await new Promise(r => setTimeout(r, 1500));

// 2) 新規会話を開く
await desktop.hotkey('command', 'n');
await new Promise(r => setTimeout(r, 800));

// 3) 宛先を入力 (ASCII の電話番号/メールアドレスは type でよい)
await desktop.type(ctx.input.recipient ?? '');
await new Promise(r => setTimeout(r, 500));
await desktop.pressKey('Return');  // オートコンプリート確定
await new Promise(r => setTimeout(r, 800));

// 4) メッセージ本文 (日本語は clipboard paste で)
await pasteText(desktop, ctx.input.message ?? '');
await new Promise(r => setTimeout(r, 300));
await desktop.pressKey('Return');  // 送信
```

## ★ Notes
- AppleScript's `tell application "Messages" to send "..." to buddy "..."` has been tightly restricted since macOS 10.15 and often returns error `-1728` or `-1743`. The AX + shortcut path is more robust.
- The recipient must be a phone number (`+81…`) or an iMessage address. Fuzzy name lookup depends on Contacts.
