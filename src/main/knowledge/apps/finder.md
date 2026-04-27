---
name: finder
description: Rules for using macOS Finder for file and folder operations
app: Finder
bundleIds: [com.apple.finder]
aliases: [Finder, finder]
category: apple-native
appleScript: full
---

## ★ For file/folder operations, use the shell or AppleScript — not the Finder UI
For simple file operations, `execFile('mkdir' / 'mv' / 'cp' / 'rm')` or Node's `fs` is fastest.
Use `tell application "Finder"` in AppleScript only when you need to change **Finder's visible state** (selection, opening a folder in a window, etc.).

## ★ Create a folder (AppleScript version)
```typescript
await exec('osascript', ['-e',
  `tell application "Finder" to make new folder at desktop with properties {name:"${folderName.replace(/"/g, '\\"')}"}`
]);
```

## ★ Create a folder (shell version, faster)
```typescript
import { mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
mkdirSync(join(homedir(), 'Desktop', folderName), { recursive: true });
```

## ★ Notes
- Do not hardcode absolute paths. Build them with `homedir()` + `join()`
- For existence checks, don't use `fs.existsSync`. Leave it to verifyAgent as a post-condition (the programmatic verification path handles it)
