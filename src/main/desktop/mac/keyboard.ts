import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

async function osascript(script: string): Promise<string> {
  const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 5000 })
  return stdout.trim()
}

let quartzAvailable: boolean | null = null

async function switchIME(keyCode: number): Promise<void> {
  // Best-effort: if Quartz (pyobjc) isn't installed on this machine,
  // skip IME switching silently. Most environments are already in
  // English input mode for ASCII, so typing still works.
  if (quartzAvailable === false) return
  const pythonScript = `
import Quartz, time
evt = Quartz.CGEventCreateKeyboardEvent(None, ${keyCode}, True)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, evt)
time.sleep(0.05)
evt = Quartz.CGEventCreateKeyboardEvent(None, ${keyCode}, False)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, evt)
`
  try {
    await execFileAsync('python3', ['-c', pythonScript], { timeout: 3000 })
    quartzAvailable = true
  } catch (err) {
    const msg = (err as Error).message ?? ''
    if (/ModuleNotFoundError|No module named.*Quartz|No module named 'Quartz'/i.test(msg)) {
      quartzAvailable = false
      console.warn('[desktop/keyboard] Quartz/pyobjc not installed — IME switching disabled. ASCII typing will still work.')
      return
    }
    // Other errors: also swallow (IME switch is best-effort)
    console.warn('[desktop/keyboard] IME switch failed (ignored):', msg.split('\n')[0])
  }
}

function isAsciiOnly(text: string): boolean {
  return /^[\x00-\x7F]*$/.test(text)
}

export async function typeText(text: string): Promise<void> {
  // Switch to eisu to avoid IME interference
  await switchIME(102)
  await new Promise(resolve => setTimeout(resolve, 300))

  if (isAsciiOnly(text)) {
    // ASCII text: type character by character via keystroke
    for (const char of text) {
      const escaped = char.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      await osascript(`tell application "System Events" to keystroke "${escaped}"`)
      await new Promise(resolve => setTimeout(resolve, 30))
    }
  } else {
    // Non-ASCII (Japanese etc): use clipboard paste since keystroke can't handle non-ASCII
    await osascript(`set the clipboard to "${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    await osascript(`tell application "System Events" to keystroke "v" using command down`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

export async function hotkey(...keys: string[]): Promise<void> {
  // Convert keys to AppleScript format
  // e.g., hotkey('command', 'c') -> 'keystroke "c" using command down'
  const modifiers: string[] = []
  let mainKey = ''

  for (const key of keys) {
    const lower = key.toLowerCase()
    if (['command', 'cmd', 'meta'].includes(lower)) modifiers.push('command down')
    else if (['shift'].includes(lower)) modifiers.push('shift down')
    else if (['option', 'alt'].includes(lower)) modifiers.push('option down')
    else if (['control', 'ctrl'].includes(lower)) modifiers.push('control down')
    else mainKey = key
  }

  const using = modifiers.length > 0 ? ` using {${modifiers.join(', ')}}` : ''

  // Special keys (includes HTML KeyboardEvent aliases like "ArrowDown" for robustness)
  const specialKeys: Record<string, number> = {
    return: 36,
    enter: 36,
    tab: 48,
    escape: 53,
    esc: 53,
    delete: 51,
    backspace: 51,
    space: 49,
    // Arrow keys — accept both short names ("up") and HTML KeyboardEvent names ("arrowup")
    up: 126,
    arrowup: 126,
    down: 125,
    arrowdown: 125,
    left: 123,
    arrowleft: 123,
    right: 124,
    arrowright: 124,
    f1: 122,
    f2: 120,
    f3: 99,
    f4: 118,
    f5: 96,
    f6: 97,
    f7: 98,
    f8: 100,
    f9: 101,
    f10: 109,
    f11: 103,
    f12: 111,
    eisu: 102,     // 英数キー (IME → English)
    kana: 104,     // かなキー (IME → Japanese)
    capslock: 57,
    home: 115,
    end: 119,
    pageup: 116,
    pagedown: 121,
    forwarddelete: 117,
    del: 117,
  }

  const keyLower = mainKey.toLowerCase()
  const keyCode = specialKeys[keyLower]
  if (keyCode !== undefined) {
    await osascript(`tell application "System Events" to key code ${keyCode}${using}`)
  } else if (mainKey.length === 1) {
    // Single-character keystroke (a, b, 1, !, etc.)
    await osascript(`tell application "System Events" to keystroke "${mainKey}"${using}`)
  } else {
    // Unknown multi-character key name — this is likely a bug where someone passed
    // "ArrowDown" / "PageDown" / etc. but the special-keys map didn't have it.
    // Throw a specific error rather than silently typing the literal text.
    throw new Error(
      `Unknown key name: "${mainKey}". `
      + `Known special keys: return/enter, tab, escape, delete/backspace, space, `
      + `up/down/left/right (or arrowup/arrowdown/arrowleft/arrowright), `
      + `f1-f12, home, end, pageup, pagedown, eisu, kana, capslock, forwarddelete. `
      + `For single characters use 1-char strings like "a" or "1".`
    )
  }
}

// Keys that require CGEvent (AppleScript key code hangs for these)
const cgEventOnlyKeys: Record<string, number> = {
  eisu: 102,
  kana: 104,
}

export async function pressKey(key: string): Promise<void> {
  const cgKeyCode = cgEventOnlyKeys[key.toLowerCase()]
  if (cgKeyCode !== undefined) {
    // Use Python+Quartz CGEvent for keys that AppleScript can't handle
    const pythonScript = `
import Quartz
evt = Quartz.CGEventCreateKeyboardEvent(None, ${cgKeyCode}, True)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, evt)
import time; time.sleep(0.05)
evt = Quartz.CGEventCreateKeyboardEvent(None, ${cgKeyCode}, False)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, evt)
`
    try {
      await execFileAsync('python3', ['-c', pythonScript], { timeout: 3000 })
    } catch (err) {
      const msg = (err as Error).message ?? ''
      if (/ModuleNotFoundError|No module named.*Quartz/i.test(msg)) {
        quartzAvailable = false
        console.warn(`[desktop/keyboard] pressKey('${key}') skipped — Quartz unavailable`)
        return
      }
      throw err
    }
    return
  }
  await hotkey(key)
}
