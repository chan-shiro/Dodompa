---
name: reminders
description: Rules for driving the macOS Reminders app via AppleScript
app: Reminders
bundleIds: [com.apple.reminders]
aliases: [Reminders, reminders, リマインダー]
category: apple-native
appleScript: full
---

## ★ Reminders has an AppleScript Dictionary — always drive it via osascript
UI clicking (`Cmd+N` → type) is forbidden. Reasons: Japanese IME corruption, focus-dependent loops, unstable AX implementation.

## ★ Build the Date on the JS side and assemble it on the AppleScript side
AppleScript's `date "..."` **does not parse natural language**. Passing a string like `"tomorrow 10:00"` directly will fail with **error -30720**. Always build a `Date` in JS, then on the AppleScript side `set` year/month/day/hour/minute onto `current date` (locale-independent — this is the most robust approach):

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';
const exec = promisify(execFile);

const name = (ctx.input.taskName ?? '').replace(/"/g, '\\"');
const dueDate = new Date();
dueDate.setDate(dueDate.getDate() + 1); // 明日
dueDate.setHours(10, 0, 0, 0);           // 10:00

const remScript = `
set theDate to (current date)
set year of theDate to ${dueDate.getFullYear()}
set month of theDate to ${dueDate.getMonth() + 1}
set day of theDate to ${dueDate.getDate()}
set hours of theDate to ${dueDate.getHours()}
set minutes of theDate to ${dueDate.getMinutes()}
set seconds of theDate to 0
tell application "Reminders"
  id of (make new reminder with properties {name:"${name}", due date:theDate})
end tell`;
const { stdout } = await exec('osascript', ['-e', remScript]);
const reminderId = stdout.trim();
if (!reminderId) throw new Error('リマインダー ID が取得できませんでした');
ctx.shared.createdReminderId = reminderId;
```

## ★ Do not write your own existence-check that full-scans everything
An O(N) full loop like `repeat with lst in lists` + `repeat with rem in reminders of lst` takes more than 30 seconds and times out for users with many reminders. Take the return value of `make new reminder`, stash its ID into `ctx.shared`, and **stop there**. Verifying the post-condition (the reminder exists in Reminders) is verifyAgent's job.
