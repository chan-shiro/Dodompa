---
name: excel
description: Rules for driving Microsoft Excel via AppleScript
app: Microsoft Excel
bundleIds: [com.microsoft.Excel]
aliases: [Excel, excel, Microsoft Excel]
category: office
appleScript: full
---

## ★ Excel has an AppleScript Dictionary
Reading/writing cells, switching sheets, and saving files can all be done via osascript. Avoid UI clicking.

## ★ Read and write a cell value
```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';
const exec = promisify(execFile);

// 読み取り
const { stdout } = await exec('osascript', ['-e', `
tell application "Microsoft Excel"
  activate
  set theValue to value of range "A1" of active sheet
end tell
return theValue
`]);
ctx.shared.cellValue = stdout.trim();

// 書き込み
await exec('osascript', ['-e', `
tell application "Microsoft Excel"
  activate
  set value of range "B2" of active sheet to "${(ctx.input.newValue ?? '').replace(/"/g, '\\"')}"
  save active workbook
end tell
`]);
```

## ★ Bulk-read a range (keep read and write steps separate)
```typescript
const { stdout } = await exec('osascript', ['-e', `
tell application "Microsoft Excel"
  set theValues to value of range "A1:C10" of active sheet
end tell
return theValues
`]);
// theValues は AppleScript の list of list 形式で返る。カンマ区切りで parse する
```

## ★ Notes
- **Do not mix reads and writes in the same step** for Excel cell operations (side-effect separation principle)
- Do not use natural-language range specs ("all of column B"). Always convert to A1:C10 form before passing
- Saving a file: `save active workbook` / `save workbook as active workbook filename:"..."`
