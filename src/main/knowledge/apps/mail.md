---
name: mail
description: Rules for driving the macOS Mail app via AppleScript
app: Mail
bundleIds: [com.apple.mail]
aliases: [Mail, mail, メール]
category: apple-native
appleScript: full
---

## ★ Mail has an AppleScript Dictionary, so drive it with osascript
Do not go through the UI (Cmd+N → type → Tab → click). Reasons: waiting on recipient autocomplete, unstable AX field ordering, and Japanese IME corruption.

## ★ Basic pattern: compose and send
```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';
const exec = promisify(execFile);

const subject = (ctx.input.subject ?? '').replace(/"/g, '\\"');
const body    = (ctx.input.body ?? '').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const to      = (ctx.input.to ?? '').replace(/"/g, '\\"');

const script = `tell application "Mail"
  set newMsg to make new outgoing message with properties {subject:"${subject}", content:"${body}", visible:true}
  tell newMsg
    make new to recipient with properties {address:"${to}"}
  end tell
end tell`;
await exec('osascript', ['-e', script], { timeout: 10000 });
```

## ★ Notes
- Call `to recipient` multiple times to add multiple recipients. CC/BCC are available as `cc recipient` / `bcc recipient`
- To actually send, append `tell newMsg to send` at the end. To stop at the draft stage, keep `visible:true` only
- Always take the recipient from `ctx.input`. Never default to a placeholder like `test@example.com`

## ★★★ Sent flag (avoids false negatives in the verifyAgent screenshot check) ★★★
Any step that actually executes `send` **must also set `ctx.shared.mailSent = true`**. Reason: the osascript `send` shows the compose window only briefly before closing it, so the verifyAgent's screenshot comparison tends to misjudge it as "Mail never launched — failed". If it misjudges, an automatic retry **sends the same email twice**.

Write the planning-side post-condition in the form `ctx.shared.mailSent is true`. That way verifyAgent takes the programmatic check path (inspecting `ctx.shared.XXX`) and never has to look at the screenshot.

```typescript
try {
  await exec('osascript', ['-e', script], { timeout: 15000 });
  ctx.shared.mailSent = true;  // ← 必須
} catch (error) {
  ctx.shared.mailSent = false;
  throw new Error(`Mail送信失敗: ${(error as Error).message}`);
}
```

## ★★★ Do NOT re-verify via the AX tree after sending ★★★
Once you've sent via AppleScript, **do not write any further verification code**. In particular, the following are all forbidden:

- ❌ Using `desktop.getAccessibilityTree(mailPid)` to check that the send window has disappeared
- ❌ Using `desktop.findElement(tree, { role: 'AXWindow', title: '新規メッセージ' })` to check for a lingering compose window
- ❌ Adding a secondary Cmd+Shift+D (or similar) as an extra "insurance" send — this causes double sends
- ❌ Adding `tell outgoing message 1 to send` as a fallback — likewise causes double sends

Reasons:
1. Mail closes the compose window immediately after sending, so the compose window was never in the AX tree in the first place. A failed lookup or thrown error does NOT mean the send failed.
2. If the `send` command completed without throwing, the message has already been sent. No further verification is needed.
3. Running another send-like operation as a fallback is a severe bug: **the same email is sent twice**.

Funnel post-condition verification through the programmatic check `ctx.shared.mailSent = true` (handled by verifyAgent). The step's code should be just three lines: send via osascript → set `ctx.shared.mailSent = true` → done.
