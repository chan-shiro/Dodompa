---
name: safari
description: Rules for URL navigation and data extraction in macOS Safari via AppleScript
app: Safari
bundleIds: [com.apple.Safari]
aliases: [Safari, safari]
category: apple-native
appleScript: full
---

## ★ Safari has an AppleScript Dictionary
Opening URLs, reading the tab title, and fetching HTML source can all be done via osascript. The whole flow fits in the `desktop` type without needing Playwright.

## ★ Open a URL and retrieve the tab title
```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';
const exec = promisify(execFile);

const url = ctx.input.target_url ?? '';
if (!url) throw new Error('target_url が ctx.input に指定されていません');

const { stdout } = await exec('osascript', [
  '-e', `tell application "Safari" to open location "${url}"`,
  '-e', 'delay 2',
  '-e', 'tell application "Safari" to return name of current tab of front window',
]);
ctx.shared.pageTitle = stdout.trim();
```

## ★ Fetch the page's HTML source
```typescript
const { stdout: src } = await exec('osascript', [
  '-e', 'tell application "Safari" to return source of front document',
]);
ctx.shared.pageHtml = src;
```

## ★ Other common commands
- Current tab URL: `URL of current tab of front window`
- Navigate the specified tab: `set URL of current tab of front window to "..."`
- Run JS: `do JavaScript "..." in current tab of front window` (requires: "Allow JavaScript from Apple Events" enabled in Safari settings)

## ★ Notes
- Always take the URL from `ctx.input`. Do not hallucinate one from abstract phrasing in the description
- `delay 2` is the minimum needed to wait for SPA loads. For heavier pages, bump it to 3-5 seconds
