/**
 * Keyboard and mouse input for macOS.
 * Uses osascript (AppleScript) for keyboard and Python+Quartz for mouse.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

async function osascript(script: string): Promise<string> {
  const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 5000 })
  return stdout.trim()
}

// ─── Keyboard ───

async function switchIME(keyCode: number): Promise<void> {
  const pythonScript = `
import Quartz, time
evt = Quartz.CGEventCreateKeyboardEvent(None, ${keyCode}, True)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, evt)
time.sleep(0.05)
evt = Quartz.CGEventCreateKeyboardEvent(None, ${keyCode}, False)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, evt)
`
  await execFileAsync('python3', ['-c', pythonScript], { timeout: 3000 })
}

export async function typeText(text: string): Promise<void> {
  // Switch to eisu to avoid IME interference
  await switchIME(102)
  await new Promise(r => setTimeout(r, 300))

  if (/^[\x00-\x7F]*$/.test(text)) {
    // ASCII: type via keystroke
    const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    await osascript(`tell application "System Events" to keystroke "${escaped}"`)
  } else {
    // Non-ASCII (Japanese etc): clipboard paste
    await osascript(`set the clipboard to "${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    await osascript(`tell application "System Events" to keystroke "v" using command down`)
    await new Promise(r => setTimeout(r, 100))
  }
}

export async function hotkey(...keys: string[]): Promise<void> {
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

  const specialKeys: Record<string, number> = {
    return: 36, enter: 36, tab: 48, escape: 53, esc: 53,
    delete: 51, backspace: 51, space: 49,
    up: 126, down: 125, left: 123, right: 124,
    f1: 122, f2: 120, f3: 99, f4: 118, f5: 96,
    home: 115, end: 119, pageup: 116, pagedown: 121,
  }

  const keyCode = specialKeys[mainKey.toLowerCase()]
  if (keyCode !== undefined) {
    await osascript(`tell application "System Events" to key code ${keyCode}${using}`)
  } else {
    await osascript(`tell application "System Events" to keystroke "${mainKey}"${using}`)
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
    const pythonScript = `
import Quartz
evt = Quartz.CGEventCreateKeyboardEvent(None, ${cgKeyCode}, True)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, evt)
import time; time.sleep(0.05)
evt = Quartz.CGEventCreateKeyboardEvent(None, ${cgKeyCode}, False)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, evt)
`
    await execFileAsync('python3', ['-c', pythonScript], { timeout: 3000 })
    return
  }
  await hotkey(key)
}

// ─── Mouse (via cliclick or AppleScript + Swift helper) ───
// We use the dodompa-ax Swift CLI for mouse operations (no Python dependency).
// Falls back to AppleScript if the binary is unavailable.

import path from 'path'
import fs from 'fs'

function getAxBinaryPath(): string | null {
  // Check common locations
  const candidates = [
    path.join(process.cwd(), 'resources', 'bin', 'dodompa-ax'),
    path.resolve(__dirname, '../../resources/bin/dodompa-ax'),
    path.resolve(__dirname, '../../../resources/bin/dodompa-ax'),
    '/Users/shiro/development/Dodompa/resources/bin/dodompa-ax',
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return null
}

async function mouseViaSwift(args: string[]): Promise<void> {
  const bin = getAxBinaryPath()
  if (bin) {
    await execFileAsync(bin, args, { timeout: 5000 })
    return
  }
  throw new Error('dodompa-ax binary not found for mouse operations')
}

// Fallback: use AppleScript to click via System Events
async function mouseViaAppleScript(x: number, y: number, clickType: 'click' | 'right click' = 'click'): Promise<void> {
  // AppleScript click at absolute coordinates using System Events
  await osascript(`
do shell script "swift -e '
import Cocoa
let src = CGEventSource(stateID: .hidSystemState)
let pos = CGPoint(x: ${Math.round(x)}, y: ${Math.round(y)})
${clickType === 'right click' ? `
let down = CGEvent(mouseEventSource: src, mouseType: .rightMouseDown, mouseCursorPosition: pos, mouseButton: .right)
let up = CGEvent(mouseEventSource: src, mouseType: .rightMouseUp, mouseCursorPosition: pos, mouseButton: .right)
` : `
let down = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: pos, mouseButton: .left)
let up = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: pos, mouseButton: .left)
`}
down?.post(tap: .cghidEventTap)
up?.post(tap: .cghidEventTap)
'"`)
}

export async function click(x: number, y: number): Promise<void> {
  try {
    await mouseViaSwift(['click', '--x', String(Math.round(x)), '--y', String(Math.round(y))])
  } catch {
    await mouseViaAppleScript(x, y)
  }
}

export async function doubleClick(x: number, y: number): Promise<void> {
  await click(x, y)
  await new Promise(r => setTimeout(r, 50))
  await click(x, y)
}

export async function rightClick(x: number, y: number): Promise<void> {
  try {
    await mouseViaSwift(['right-click', '--x', String(Math.round(x)), '--y', String(Math.round(y))])
  } catch {
    await mouseViaAppleScript(x, y, 'right click')
  }
}

export async function moveTo(x: number, y: number): Promise<void> {
  try {
    await mouseViaSwift(['move', '--x', String(Math.round(x)), '--y', String(Math.round(y))])
  } catch {
    // AppleScript move fallback
    await osascript(`
do shell script "swift -e '
import Cocoa
let src = CGEventSource(stateID: .hidSystemState)
let pos = CGPoint(x: ${Math.round(x)}, y: ${Math.round(y)})
let move = CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: pos, mouseButton: .left)
move?.post(tap: .cghidEventTap)
'"`)
  }
}

export async function drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
  try {
    await mouseViaSwift([
      'drag',
      '--from-x', String(Math.round(fromX)), '--from-y', String(Math.round(fromY)),
      '--to-x', String(Math.round(toX)), '--to-y', String(Math.round(toY)),
    ])
  } catch {
    // Fallback: click + drag via swift
    await osascript(`
do shell script "swift -e '
import Cocoa
import Foundation
let src = CGEventSource(stateID: .hidSystemState)
let start = CGPoint(x: ${Math.round(fromX)}, y: ${Math.round(fromY)})
let end = CGPoint(x: ${Math.round(toX)}, y: ${Math.round(toY)})
let down = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left)
down?.post(tap: .cghidEventTap)
Thread.sleep(forTimeInterval: 0.05)
let steps = 10
for i in 1...steps {
    let t = Double(i) / Double(steps)
    let x = Double(${Math.round(fromX)}) + (Double(${Math.round(toX)}) - Double(${Math.round(fromX)})) * t
    let y = Double(${Math.round(fromY)}) + (Double(${Math.round(toY)}) - Double(${Math.round(fromY)})) * t
    let pt = CGPoint(x: x, y: y)
    let drag = CGEvent(mouseEventSource: src, mouseType: .leftMouseDragged, mouseCursorPosition: pt, mouseButton: .left)
    drag?.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.02)
}
let up = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: end, mouseButton: .left)
up?.post(tap: .cghidEventTap)
'"`)
  }
}

// ─── Screenshot ───

export async function captureScreen(): Promise<Buffer> {
  const { tmpdir } = await import('os')
  const tmpFile = `${tmpdir()}/dodompa-mcp-screenshot-${Date.now()}.png`
  await execFileAsync('screencapture', ['-x', '-C', tmpFile], { timeout: 5000 })
  const { readFileSync, unlinkSync } = await import('fs')
  const buf = readFileSync(tmpFile)
  try { unlinkSync(tmpFile) } catch { /* */ }
  return buf
}

export async function captureRegion(x: number, y: number, w: number, h: number): Promise<Buffer> {
  const { tmpdir } = await import('os')
  const tmpFile = `${tmpdir()}/dodompa-mcp-screenshot-${Date.now()}.png`
  await execFileAsync('screencapture', ['-x', '-R', `${x},${y},${w},${h}`, tmpFile], { timeout: 5000 })
  const { readFileSync, unlinkSync } = await import('fs')
  const buf = readFileSync(tmpFile)
  try { unlinkSync(tmpFile) } catch { /* */ }
  return buf
}
