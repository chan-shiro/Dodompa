/**
 * Playwright browser automation for MCP.
 * Manages a persistent browser context for step-by-step debugging.
 */
import { chromium, type BrowserContext, type Page } from 'playwright-core'
import { existsSync, mkdirSync, rmSync } from 'fs'
import path from 'path'
import os from 'os'

let context: BrowserContext | null = null
let activePage: Page | null = null
const profileDir = path.join(os.homedir(), '.dodompa', 'mcp-profile')

function findChromium(): string | undefined {
  // Use Playwright's bundled Chromium if available
  try {
    return (chromium as any).executablePath?.() ?? undefined
  } catch { /* */ }

  // macOS system Chrome
  const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  if (existsSync(macChrome)) return macChrome

  return undefined
}

function cleanSingletonLock(dir: string) {
  const lockPath = path.join(dir, 'SingletonLock')
  try { rmSync(lockPath, { force: true }) } catch { /* */ }
}

export async function launchBrowser(opts?: { headless?: boolean; url?: string }): Promise<{ pageUrl: string; pageCount: number }> {
  if (context) {
    const pages = context.pages()
    activePage = pages[pages.length - 1] ?? await context.newPage()
    return { pageUrl: activePage.url(), pageCount: pages.length }
  }

  mkdirSync(profileDir, { recursive: true })
  cleanSingletonLock(profileDir)

  const executablePath = findChromium()
  context = await chromium.launchPersistentContext(profileDir, {
    headless: opts?.headless ?? false,
    ...(executablePath ? { executablePath } : {}),
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  })

  const pages = context.pages()
  activePage = pages.length > 0 ? pages[0] : await context.newPage()

  if (opts?.url) {
    await activePage.goto(opts.url, { timeout: 30000, waitUntil: 'domcontentloaded' })
  }

  // Track new tabs
  context.on('page', (page) => {
    activePage = page
  })

  return { pageUrl: activePage.url(), pageCount: context.pages().length }
}

export async function closeBrowser(): Promise<void> {
  if (context) {
    await context.close().catch(() => {})
    context = null
    activePage = null
  }
}

export function getPage(): Page {
  if (!activePage) throw new Error('No browser open. Call browser_launch first.')
  return activePage
}

export function getContext(): BrowserContext {
  if (!context) throw new Error('No browser open. Call browser_launch first.')
  return context
}

export async function switchToTab(index: number): Promise<string> {
  if (!context) throw new Error('No browser open')
  const pages = context.pages()
  if (index < 0 || index >= pages.length) throw new Error(`Tab index ${index} out of range (0-${pages.length - 1})`)
  activePage = pages[index]
  return activePage.url()
}

export async function listTabs(): Promise<Array<{ index: number; url: string; title: string }>> {
  if (!context) throw new Error('No browser open')
  const pages = context.pages()
  const tabs = []
  for (let i = 0; i < pages.length; i++) {
    tabs.push({ index: i, url: pages[i].url(), title: await pages[i].title().catch(() => '') })
  }
  return tabs
}

export async function takeScreenshot(opts?: { quality?: number; maxWidth?: number }): Promise<Buffer> {
  const page = getPage()
  const quality = opts?.quality ?? 60
  const maxWidth = opts?.maxWidth ?? 1024

  // Use JPEG for smaller size
  let buf = await page.screenshot({ fullPage: false, type: 'jpeg', quality })

  // Resize if wider than maxWidth using canvas in the page
  if (maxWidth) {
    const viewport = page.viewportSize()
    if (viewport && viewport.width > maxWidth) {
      const scale = maxWidth / viewport.width
      buf = await page.screenshot({
        fullPage: false,
        type: 'jpeg',
        quality,
        clip: { x: 0, y: 0, width: viewport.width, height: viewport.height },
        scale: 'css',
      })
    }
  }

  return buf
}

export async function getPageContent(): Promise<{ url: string; html: string; title: string }> {
  const page = getPage()
  const [html, title] = await Promise.all([
    page.content(),
    page.title().catch(() => ''),
  ])
  return { url: page.url(), html, title }
}

export async function extractSelectors(_description: string): Promise<string> {
  const page = getPage()
  // Use string-based evaluate to avoid esbuild __name injection in browser context
  const selectors = await page.evaluate(`(() => {
    var results = [];
    var elements = document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"]');
    var esc = function(s) { return CSS.escape(s); };
    var arr = Array.from(elements);
    for (var i = 0; i < Math.min(arr.length, 100); i++) {
      var el = arr[i];
      var tag = el.tagName.toLowerCase();
      var id = el.id || undefined;
      var name = el.getAttribute('name') || undefined;
      var type = el.getAttribute('type') || undefined;
      var text = (el.textContent || '').trim().slice(0, 50) || undefined;
      var ariaLabel = el.getAttribute('aria-label') || undefined;
      var placeholder = el.getAttribute('placeholder') || undefined;
      var selector = tag;
      if (id) {
        selector = '#' + esc(id);
      } else if (name) {
        selector = tag + '[name="' + name + '"]';
      } else if (ariaLabel) {
        selector = '[aria-label="' + ariaLabel + '"]';
      } else if (placeholder) {
        selector = tag + '[placeholder="' + placeholder + '"]';
      } else if (tag === 'a' && el.getAttribute('href')) {
        var href = el.getAttribute('href');
        if (href.startsWith('/') || href.startsWith('http')) {
          selector = 'a[href="' + href + '"]';
        }
      } else {
        var dataAttrs = Array.from(el.attributes).filter(function(a) { return a.name.startsWith('data-'); });
        if (dataAttrs.length > 0) {
          var attr = dataAttrs[0];
          selector = tag + '[' + attr.name + '="' + attr.value + '"]';
        } else {
          var cls = el.className && typeof el.className === 'string'
            ? el.className.trim().split(/\\s+/).filter(function(c) { return c && !c.startsWith('_') && c.length < 30; }).slice(0, 2).join('.')
            : '';
          if (cls) {
            var base = tag + '.' + cls;
            var matches = document.querySelectorAll(base);
            if (matches.length === 1) {
              selector = base;
            } else {
              var idx = Array.from(matches).indexOf(el);
              selector = base + ':nth-of-type(' + (idx + 1) + ')';
            }
          }
        }
      }
      results.push({ tag: tag, id: id, name: name, type: type, text: text, ariaLabel: ariaLabel, placeholder: placeholder, selector: selector });
    }
    return results;
  })()`);

  return JSON.stringify(selectors, null, 2)
}
