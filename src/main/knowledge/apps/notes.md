---
name: notes
description: Rules for driving the macOS Notes app via AppleScript
app: Notes
bundleIds: [com.apple.Notes]
aliases: [Notes, notes, メモ]
category: apple-native
appleScript: full
---

## ★ Notes has an AppleScript Dictionary, so drive it with osascript
Do not go through the UI (Cmd+N + type). Notes is built on SwiftUI with an unstable AX implementation — clicks and focus transitions barely work.

## ★ Create a new note
```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';
const exec = promisify(execFile);

const title = (ctx.input.title ?? '今日のタスク').replace(/"/g, '\\"');
const body  = (ctx.input.body  ?? '').replace(/"/g, '\\"').replace(/\n/g, '\\n');

const script = `tell application "Notes"
  activate
  make new note with properties {name:"${title}", body:"${body}"}
end tell`;
await exec('osascript', ['-e', script]);
```

## ★ Notes
- `body` accepts HTML. Insert `\\n` for line breaks and Notes will render them as paragraphs
- To update an existing note, use `set body of note "<title>" to ...`
- Avoid a full scan (`repeat with n in notes`) — it's slow. Stashing the ID of the note you just created into `ctx.shared` is enough
