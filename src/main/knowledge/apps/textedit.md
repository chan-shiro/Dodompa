---
name: textedit
description: Rules for creating and saving text files with macOS TextEdit
app: TextEdit
bundleIds: [com.apple.TextEdit]
aliases: [TextEdit, textedit, テキストエディット]
category: apple-native
appleScript: full
---

## ★ For TextEdit, skip the UI — `fs.writeFileSync` + `open -a` is the most robust approach
Reasons:
- TextEdit sometimes shows an "Open" dialog on launch, making the UI flow unstable
- Save-dialog behavior differs depending on whether the document format is RTF or TXT
- Japanese IME corruption risk

## ★ Basic pattern (just write via fs and open with `open -a`)
```typescript
import { writeFileSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { homedir } from 'os';
import { join } from 'path';
const exec = promisify(execFile);

const content  = ctx.input.content ?? '';
const filePath = join(homedir(), 'Desktop', ctx.input.filename ?? 'note.txt');
writeFileSync(filePath, content, 'utf8');
await exec('open', ['-a', 'TextEdit', filePath]);
ctx.shared.savedPath = filePath;
```

## ★ When you must save through the UI (e.g. a document that's already being edited)
`Cmd+Shift+G` with an absolute path is the most robust approach (`Cmd+D` for "Desktop" is locale-dependent):

```typescript
await desktop.hotkey('command', 's');
await new Promise(r => setTimeout(r, 1500));
await desktop.hotkey('command', 'shift', 'g');
await new Promise(r => setTimeout(r, 500));
await pasteText(desktop, '/Users/' + process.env.USER + '/Desktop');
await desktop.pressKey('Return');
await new Promise(r => setTimeout(r, 500));
await desktop.hotkey('command', 'a');
await pasteText(desktop, 'note.txt');  // ★ .txt 拡張子を明示しないと RTF になる
await desktop.pressKey('Return');
```

## ★ Notes
- Always include `.txt` explicitly in the filename. Without it, TextEdit defaults to `.rtf`
- If a format-selection dialog appears, confirm with Return
