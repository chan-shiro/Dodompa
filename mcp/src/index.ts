#!/usr/bin/env node
/**
 * Dodompa Desktop MCP Server
 *
 * Exposes macOS desktop automation via the Model Context Protocol.
 * Uses the dodompa-ax Swift CLI for accessibility and Python+Quartz for input.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import * as ax from './ax-bridge.js'
import * as input from './input.js'

const server = new McpServer({
  name: 'dodompa-desktop',
  version: '1.0.0',
})

// ─── Window Management ───

server.tool('list_windows', 'List all visible application windows with PID, app name, title, and bounds', {}, async () => {
  const windows = await ax.listWindows()
  return { content: [{ type: 'text', text: JSON.stringify(windows, null, 2) }] }
})

server.tool(
  'get_accessibility_tree',
  'Get the accessibility tree of an application. Returns UI elements with role, title, description, position, path, and available actions.',
  { app: z.string().describe('App name (e.g. "Calculator") or PID number'), depth: z.number().optional().default(5).describe('Max tree depth (default 5)') },
  async ({ app, depth }) => {
    const pid = await ax.resolveAppToPid(isNaN(Number(app)) ? app : Number(app))
    const tree = await ax.getAccessibilityTree(pid, depth)
    return { content: [{ type: 'text', text: JSON.stringify(tree, null, 2) }] }
  }
)

server.tool(
  'find_elements',
  'Find UI elements in an app by AX role and optional title/description text. Searches both title and description fields.',
  {
    app: z.string().describe('App name or PID'),
    role: z.string().describe('Accessibility role (e.g. "AXButton", "AXTextField", "AXStaticText", "AXWindow")'),
    title: z.string().optional().describe('Text to search in title or description'),
  },
  async ({ app, role, title }) => {
    const pid = await ax.resolveAppToPid(isNaN(Number(app)) ? app : Number(app))
    const elements = await ax.findElements(pid, role, title)
    return { content: [{ type: 'text', text: JSON.stringify(elements, null, 2) }] }
  }
)

server.tool(
  'element_at_point',
  'Get the UI element at a specific screen coordinate',
  { x: z.number().describe('X coordinate'), y: z.number().describe('Y coordinate') },
  async ({ x, y }) => {
    const el = await ax.elementAtPoint(x, y)
    return { content: [{ type: 'text', text: el ? JSON.stringify(el, null, 2) : 'No element found at this point' }] }
  }
)

// ─── Actions ───

server.tool(
  'perform_action',
  'Perform an accessibility action on a UI element (e.g. AXPress to click a button)',
  {
    pid: z.number().describe('Process ID of the app'),
    element_path: z.string().describe('Element path from the accessibility tree (e.g. "0.0.0.0.0.0.10")'),
    action: z.string().default('AXPress').describe('AX action name (e.g. "AXPress", "AXCancel", "AXPick")'),
  },
  async ({ pid, element_path, action }) => {
    await ax.performAction(pid, element_path, action)
    return { content: [{ type: 'text', text: `Action "${action}" performed on element at path ${element_path}` }] }
  }
)

server.tool(
  'activate_app',
  'Bring an application to the foreground',
  { app: z.string().describe('App name (e.g. "Calculator", "Safari")') },
  async ({ app }) => {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    await promisify(execFile)('osascript', ['-e', `tell application "${app}" to activate`], { timeout: 5000 })
    return { content: [{ type: 'text', text: `Activated: ${app}` }] }
  }
)

server.tool(
  'open_app',
  'Launch a macOS application using `open -a`',
  { app: z.string().describe('App name (e.g. "Calculator", "Safari", "Terminal")') },
  async ({ app }) => {
    const { execSync } = await import('child_process')
    execSync(`open -a "${app.replace(/"/g, '\\"')}"`, { timeout: 5000 })
    return { content: [{ type: 'text', text: `Launched: ${app}` }] }
  }
)

server.tool(
  'run_shell',
  'Execute a shell command and return the output',
  { command: z.string().describe('Shell command to execute'), timeout: z.number().optional().default(10000).describe('Timeout in ms') },
  async ({ command, timeout }) => {
    const { execSync } = await import('child_process')
    try {
      const output = execSync(command, { timeout, encoding: 'utf-8' })
      return { content: [{ type: 'text', text: output || '(no output)' }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true }
    }
  }
)

// ─── Mouse ───

server.tool(
  'click',
  'Click at screen coordinates',
  { x: z.number().describe('X coordinate'), y: z.number().describe('Y coordinate') },
  async ({ x, y }) => {
    await input.click(x, y)
    return { content: [{ type: 'text', text: `Clicked at (${x}, ${y})` }] }
  }
)

server.tool(
  'double_click',
  'Double-click at screen coordinates',
  { x: z.number().describe('X coordinate'), y: z.number().describe('Y coordinate') },
  async ({ x, y }) => {
    await input.doubleClick(x, y)
    return { content: [{ type: 'text', text: `Double-clicked at (${x}, ${y})` }] }
  }
)

server.tool(
  'right_click',
  'Right-click at screen coordinates',
  { x: z.number().describe('X coordinate'), y: z.number().describe('Y coordinate') },
  async ({ x, y }) => {
    await input.rightClick(x, y)
    return { content: [{ type: 'text', text: `Right-clicked at (${x}, ${y})` }] }
  }
)

server.tool(
  'drag',
  'Drag from one point to another',
  {
    from_x: z.number(), from_y: z.number(),
    to_x: z.number(), to_y: z.number(),
  },
  async ({ from_x, from_y, to_x, to_y }) => {
    await input.drag(from_x, from_y, to_x, to_y)
    return { content: [{ type: 'text', text: `Dragged from (${from_x}, ${from_y}) to (${to_x}, ${to_y})` }] }
  }
)

server.tool(
  'move_mouse',
  'Move the mouse cursor to a position without clicking',
  { x: z.number(), y: z.number() },
  async ({ x, y }) => {
    await input.moveTo(x, y)
    return { content: [{ type: 'text', text: `Moved cursor to (${x}, ${y})` }] }
  }
)

// ─── Keyboard ───

server.tool(
  'type_text',
  'Type text using the keyboard',
  { text: z.string().describe('Text to type') },
  async ({ text }) => {
    await input.typeText(text)
    return { content: [{ type: 'text', text: `Typed: "${text}"` }] }
  }
)

server.tool(
  'hotkey',
  'Press a keyboard shortcut (e.g. command+c, command+shift+s)',
  { keys: z.array(z.string()).describe('Keys to press (e.g. ["command", "c"])') },
  async ({ keys }) => {
    await input.hotkey(...keys)
    return { content: [{ type: 'text', text: `Pressed: ${keys.join('+')}` }] }
  }
)

server.tool(
  'press_key',
  'Press a single key (e.g. Return, Tab, Escape, space, up, down)',
  { key: z.string().describe('Key name') },
  async ({ key }) => {
    await input.pressKey(key)
    return { content: [{ type: 'text', text: `Pressed: ${key}` }] }
  }
)

// ─── Screenshot ───

server.tool(
  'screenshot',
  'Take a screenshot of the entire screen or a specific region. Returns the image as base64 PNG.',
  {
    region: z.object({
      x: z.number(), y: z.number(), width: z.number(), height: z.number()
    }).optional().describe('Optional region to capture. If omitted, captures full screen.'),
  },
  async ({ region }) => {
    const buf = region
      ? await input.captureRegion(region.x, region.y, region.width, region.height)
      : await input.captureScreen()

    return {
      content: [{
        type: 'image',
        data: buf.toString('base64'),
        mimeType: 'image/png',
      }]
    }
  }
)

// ─── Composite Helpers ───

server.tool(
  'click_element',
  'Find a UI element by role and title/description, then click it. Combines find + click in one call.',
  {
    app: z.string().describe('App name or PID'),
    role: z.string().default('AXButton').describe('AX role (default: AXButton)'),
    title: z.string().describe('Text to search in title or description'),
  },
  async ({ app, role, title }) => {
    const pid = await ax.resolveAppToPid(isNaN(Number(app)) ? app : Number(app))
    const elements = await ax.findElements(pid, role, title)
    if (elements.length === 0) {
      return { content: [{ type: 'text', text: `Element not found: role=${role} title="${title}"` }], isError: true }
    }
    const el = elements[0]
    if (el.position) {
      // Click at element center
      const cx = el.position.x + (el.size?.width ?? 0) / 2
      const cy = el.position.y + (el.size?.height ?? 0) / 2
      await input.click(cx, cy)
      return { content: [{ type: 'text', text: `Clicked "${title}" at (${cx}, ${cy})` }] }
    }
    if (el.path && el.actions?.includes('AXPress')) {
      await ax.performAction(pid, el.path, 'AXPress')
      return { content: [{ type: 'text', text: `Pressed "${title}" via AXPress (path: ${el.path})` }] }
    }
    return { content: [{ type: 'text', text: `Found element but no position or AXPress action available` }], isError: true }
  }
)

server.tool(
  'wait_for_element',
  'Wait for a UI element to appear in an app (polls every 500ms)',
  {
    app: z.string().describe('App name or PID'),
    role: z.string().optional().describe('AX role to match'),
    title: z.string().optional().describe('Title/description to match'),
    timeout: z.number().optional().default(10000).describe('Timeout in ms (default 10000)'),
  },
  async ({ app, role, title, timeout }) => {
    const pid = await ax.resolveAppToPid(isNaN(Number(app)) ? app : Number(app))
    const start = Date.now()
    while (Date.now() - start < timeout) {
      const tree = await ax.getAccessibilityTree(pid, 5)
      const query: { role?: string; title?: string } = {}
      if (role) query.role = role
      if (title) query.title = title
      const el = ax.findElementInTree(tree, query)
      if (el) {
        return { content: [{ type: 'text', text: JSON.stringify(el, null, 2) }] }
      }
      await new Promise(r => setTimeout(r, 500))
    }
    return { content: [{ type: 'text', text: `Timeout: element not found after ${timeout}ms` }], isError: true }
  }
)

// ─── Browser Automation ───

import * as browser from './browser.js'

server.tool(
  'browser_launch',
  'Launch a Chromium browser with a persistent profile. Reuses existing session if already open. Profile persists login state across sessions.',
  { url: z.string().optional().describe('URL to navigate to'), headless: z.boolean().optional().default(false) },
  async ({ url, headless }) => {
    const result = await browser.launchBrowser({ headless, url })
    return { content: [{ type: 'text', text: `Browser open. Page: ${result.pageUrl} (${result.pageCount} tabs)` }] }
  }
)

server.tool('browser_close', 'Close the browser session', {}, async () => {
  await browser.closeBrowser()
  return { content: [{ type: 'text', text: 'Browser closed' }] }
})

server.tool(
  'browser_navigate',
  'Navigate the current tab to a URL',
  { url: z.string().describe('URL to navigate to') },
  async ({ url }) => {
    const page = browser.getPage()
    try {
      await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' })
      return { content: [{ type: 'text', text: `Navigated to: ${page.url()}` }] }
    } catch (e) {
      const msg = (e as Error).message
      // Navigation may have partially succeeded (e.g. timeout after page loaded)
      if (msg.includes('Timeout') && page.url() !== 'about:blank') {
        return { content: [{ type: 'text', text: `Navigated (with timeout warning) to: ${page.url()}` }] }
      }
      return { content: [{ type: 'text', text: `Navigation failed: ${msg}` }], isError: true }
    }
  }
)

server.tool(
  'browser_screenshot',
  'Take a screenshot of the current page. Returns compressed JPEG.',
  {
    quality: z.number().optional().default(60).describe('JPEG quality (1-100, default 60)'),
    max_width: z.number().optional().default(1024).describe('Max width in pixels (default 1024)'),
  },
  async ({ quality, max_width }) => {
    const buf = await browser.takeScreenshot({ quality, maxWidth: max_width })
    return { content: [{ type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' }] }
  }
)

server.tool(
  'browser_content',
  'Get the current page URL, title, and HTML content (truncated to max_length)',
  { max_length: z.number().optional().default(8000).describe('Max HTML length to return') },
  async ({ max_length }) => {
    const { url, html, title } = await browser.getPageContent()
    return { content: [{ type: 'text', text: `URL: ${url}\nTitle: ${title}\n\nHTML (first ${max_length} chars):\n${html.slice(0, max_length)}` }] }
  }
)

server.tool(
  'browser_click',
  'Click an element by CSS selector or text',
  { selector: z.string().describe('CSS selector or text to click') },
  async ({ selector }) => {
    const page = browser.getPage()
    try {
      await page.click(selector, { timeout: 10000 })
      return { content: [{ type: 'text', text: `Clicked: ${selector}` }] }
    } catch {
      // Fallback: try by text
      try {
        await page.getByText(selector, { exact: false }).first().click({ timeout: 5000 })
        return { content: [{ type: 'text', text: `Clicked by text: ${selector}` }] }
      } catch (e) {
        return { content: [{ type: 'text', text: `Click failed: ${(e as Error).message}` }], isError: true }
      }
    }
  }
)

server.tool(
  'browser_fill',
  'Fill an input field with text',
  { selector: z.string().describe('CSS selector of input'), value: z.string().describe('Value to fill') },
  async ({ selector, value }) => {
    const page = browser.getPage()
    try {
      await page.fill(selector, value, { timeout: 10000 })
      return { content: [{ type: 'text', text: `Filled "${selector}" with "${value}"` }] }
    } catch {
      // Fallback: try by placeholder or label text
      try {
        await page.getByPlaceholder(selector).first().fill(value, { timeout: 5000 })
        return { content: [{ type: 'text', text: `Filled by placeholder "${selector}" with "${value}"` }] }
      } catch {
        try {
          await page.getByLabel(selector).first().fill(value, { timeout: 5000 })
          return { content: [{ type: 'text', text: `Filled by label "${selector}" with "${value}"` }] }
        } catch (e) {
          return { content: [{ type: 'text', text: `Fill failed: ${(e as Error).message}` }], isError: true }
        }
      }
    }
  }
)

server.tool(
  'browser_type',
  'Type text with keyboard (character by character, works with any focused element)',
  { text: z.string().describe('Text to type'), delay: z.number().optional().default(50).describe('Delay between keystrokes in ms') },
  async ({ text, delay }) => {
    const page = browser.getPage()
    await page.keyboard.type(text, { delay })
    return { content: [{ type: 'text', text: `Typed: "${text}"` }] }
  }
)

server.tool(
  'browser_press',
  'Press a keyboard key or shortcut (e.g. "Enter", "Meta+a", "Tab")',
  { key: z.string().describe('Key or shortcut to press') },
  async ({ key }) => {
    const page = browser.getPage()
    await page.keyboard.press(key)
    return { content: [{ type: 'text', text: `Pressed: ${key}` }] }
  }
)

server.tool(
  'browser_select',
  'Select an option from a <select> element',
  { selector: z.string(), value: z.string().describe('Option value or label') },
  async ({ selector, value }) => {
    const page = browser.getPage()
    await page.selectOption(selector, value, { timeout: 10000 })
    return { content: [{ type: 'text', text: `Selected "${value}" in ${selector}` }] }
  }
)

server.tool(
  'browser_wait',
  'Wait for a selector to appear or a fixed time',
  {
    selector: z.string().optional().describe('CSS selector to wait for'),
    timeout: z.number().optional().default(10000).describe('Timeout in ms'),
  },
  async ({ selector, timeout }) => {
    const page = browser.getPage()
    if (selector) {
      await page.waitForSelector(selector, { state: 'visible', timeout })
      return { content: [{ type: 'text', text: `Element appeared: ${selector}` }] }
    }
    await page.waitForTimeout(timeout)
    return { content: [{ type: 'text', text: `Waited ${timeout}ms` }] }
  }
)

server.tool(
  'browser_tabs',
  'List all open browser tabs',
  {},
  async () => {
    const tabs = await browser.listTabs()
    return { content: [{ type: 'text', text: JSON.stringify(tabs, null, 2) }] }
  }
)

server.tool(
  'browser_switch_tab',
  'Switch to a different browser tab by index',
  { index: z.number().describe('Tab index (0-based)') },
  async ({ index }) => {
    const url = await browser.switchToTab(index)
    return { content: [{ type: 'text', text: `Switched to tab ${index}: ${url}` }] }
  }
)

server.tool(
  'browser_evaluate',
  'Execute JavaScript in the browser page context',
  { expression: z.string().describe('JavaScript expression to evaluate') },
  async ({ expression }) => {
    const page = browser.getPage()
    try {
      const result = await page.evaluate(expression)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) ?? '(undefined)' }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true }
    }
  }
)

server.tool(
  'browser_selectors',
  'Extract interactive elements from the current page (buttons, links, inputs, etc.)',
  {},
  async () => {
    const selectors = await browser.extractSelectors('')
    return { content: [{ type: 'text', text: selectors }] }
  }
)

// ─── Electron Debug Proxy ───
// These tools proxy to the Electron app's debug HTTP server (port 19876)
// Start the Electron app with `pnpm dev` first.

const ELECTRON_DEBUG_URL = 'http://127.0.0.1:19876'

async function electronFetch(path: string, options?: { method?: string; body?: string }): Promise<unknown> {
  const resp = await fetch(`${ELECTRON_DEBUG_URL}${path}`, {
    method: options?.method ?? 'GET',
    headers: options?.body ? { 'Content-Type': 'application/json' } : {},
    body: options?.body,
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Electron debug server error ${resp.status}: ${text}`)
  }
  return resp.json()
}

server.tool(
  'electron_health',
  'Check if the Electron app debug server is running (port 19876). Start with `pnpm dev` first.',
  {},
  async () => {
    try {
      const result = await electronFetch('/health')
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Electron not running: ${(e as Error).message}\nStart with: cd /Users/shiro/development/Dodompa && pnpm dev` }], isError: true }
    }
  }
)

server.tool(
  'electron_ipc',
  'Invoke any Electron IPC handler registered via ipcMain.handle(). Examples: "task:list", "task:get", "runner:execute", "ai:startAutonomousGeneration", "ai:cancelGeneration", "settings:getProviders", "log:listExecutions"',
  {
    channel: z.string().describe('IPC channel name (e.g. "task:list", "task:get", "runner:execute")'),
    args: z.array(z.any()).optional().default([]).describe('Arguments to pass to the handler (JSON array)'),
  },
  async ({ channel, args }) => {
    const result = await electronFetch(`/ipc/${channel}`, {
      method: 'POST',
      body: JSON.stringify(args),
    })
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'electron_db_query',
  'Run a read-only SQL query against the Electron app\'s SQLite database. Tables: execution_logs, step_logs, ai_logs, generation_step_logs, user_info',
  {
    sql: z.string().describe('SQL query to execute (read-only)'),
  },
  async ({ sql }) => {
    const result = await electronFetch(`/db/query?sql=${encodeURIComponent(sql)}`)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

server.tool(
  'electron_eval',
  'Execute JavaScript code in the Electron main process. Use for debugging internals. The code runs inside an async IIFE, use `return` to return values.',
  {
    code: z.string().describe('JavaScript code to evaluate in Electron main process'),
  },
  async ({ code }) => {
    const result = await electronFetch('/eval', {
      method: 'POST',
      body: JSON.stringify({ code }),
    })
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

// ─── Start ───

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(console.error)
