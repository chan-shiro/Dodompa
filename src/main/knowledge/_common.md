---
name: common
description: macOS automation rules shared across all apps (always injected)
always: true
---

## Robust macOS patterns (shared across all apps)
- Launch apps with `open -a "AppName"` — do not use Spotlight
- Take screenshots by calling `screencapture -x -t png <path>` directly (do NOT use `defaults write` + `killall SystemUIServer`)
- In file save dialogs, `Cmd+Shift+G` with an absolute path is the most robust approach (`Cmd+D` is version-dependent)
- For non-ASCII text (including Japanese), paste via the clipboard (using `pbcopy`) instead of `desktop.type()` — keystroke simulation does not work reliably with the IME
