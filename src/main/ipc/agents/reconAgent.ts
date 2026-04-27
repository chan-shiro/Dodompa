// ─── Recon Agent ───
// Scouts a web page *before* planning/codegen, extracting a structured "siteMap"
// of the page's actual interactive shape (links, buttons, inputs, forms, headings,
// URL patterns). The siteMap is then injected into actionPlanAgent/codegenAgent
// prompts so the AI writes code against the real site structure instead of
// guessing.
//
// Motivation: without recon, the AI plans from the step description alone,
// which leads to patterns like "ask ctx.ai() for the zodiac name, then
// getByRole('link', {name}) on whatever comes back". When ctx.ai() returns an
// error sentence because the input was empty, that sentence gets fed to a
// locator as-is, causing an unrecoverable mismatch. With recon, the AI can
// see that the 12 zodiac links on shiitakeuranai.jp have deterministic
// `/horoscopes/{aries,taurus,...}` href patterns and generate code that
// maps birthday → zodiac slug → URL directly.
//
// This first version is browser-only. A desktop variant (AX-tree based) can
// follow the same shape once the URL-keyed caching question is settled for
// apps.

import type { Page } from 'playwright-core'
import type { BrowserWindow } from 'electron'
import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import * as crypto from 'crypto'

import type { AiProviderConfig, StepPlan } from '../../../shared/types'
import { chatStream } from './aiChat'
import { sendAndLog } from './progressHelper'

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

export interface SiteMapLink {
  text: string
  href: string
  role?: string
  ariaLabel?: string
}

export interface SiteMapButton {
  text: string
  role?: string
  ariaLabel?: string
  type?: string
}

export interface SiteMapInput {
  tag: string
  type?: string
  name?: string
  id?: string
  placeholder?: string
  ariaLabel?: string
  role?: string
  labelText?: string
  required?: boolean
}

export interface SiteMapForm {
  action?: string
  method?: string
  inputs: SiteMapInput[]
  submitText?: string
}

export interface SiteMapHeading {
  level: number
  text: string
}

/** Deterministic facts collected via page.evaluate — no AI involved. */
export interface SiteMapRawFacts {
  url: string
  origin: string
  pathname: string
  title: string
  fetchedAt: string
  lang?: string
  nav: SiteMapLink[]
  links: SiteMapLink[]
  buttons: SiteMapButton[]
  standaloneInputs: SiteMapInput[]
  forms: SiteMapForm[]
  headings: SiteMapHeading[]
  hasIframes: boolean
  linkCount: number
  buttonCount: number
}

/** Facts + AI-derived enrichment, cached to disk. */
export interface SiteMap extends SiteMapRawFacts {
  /** Plain-text summary of the page structure (2-4 sentences). */
  summary?: string
  /** URL patterns derived from link hrefs, e.g. "/horoscopes/{slug}/". */
  urlPatterns?: string[]
  /** Goal-oriented candidate short-list written by the AI. */
  candidatesForGoal?: Array<{
    kind: 'link' | 'button' | 'input' | 'form'
    label: string
    via: string
    note?: string
  }>
  /** The step goal this recon was captured for (context-stamp). */
  goalContext?: string
  /** Sub-page findings from deep recon exploration. */
  subPages?: SubPageFinding[]
  /** AI-synthesized report of what deep recon discovered. */
  deepScanReport?: string
}

/** Findings from visiting a single sub-page during deep recon. */
export interface SubPageFinding {
  url: string
  /** Link text on the parent page that led here. */
  sourceLabel: string
  contentType: 'html' | 'pdf' | 'error'
  title?: string
  headings?: SiteMapHeading[]
  /** Whether the sub-page has further navigation links. */
  hasSubNav?: boolean
  linkCount?: number
  urlPatterns?: string[]
  /** First ~200 chars of visible text. */
  contentSnippet?: string
  pdfInfo?: { sizeBytes?: number }
  error?: string
}

/** AI triage result deciding whether deep recon is needed. */
interface DeepReconTriage {
  shouldExplore: boolean
  urlsToExplore: Array<{ url: string; label: string; reason: string }>
  reasoning: string
}

// ──────────────────────────────────────────────────────────────
// Disk cache (keyed by origin + pathname, query/hash stripped)
// ──────────────────────────────────────────────────────────────

const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24h

function reconCacheDir(): string {
  const dir = path.join(app.getPath('userData'), 'recon')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function cacheKeyForUrl(url: string): string {
  try {
    const u = new URL(url)
    const normalized = `${u.origin}${u.pathname.replace(/\/+$/, '')}`
    return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 16)
  } catch {
    return crypto.createHash('sha1').update(url).digest('hex').slice(0, 16)
  }
}

function cachePathForUrl(url: string): string {
  return path.join(reconCacheDir(), `${cacheKeyForUrl(url)}.json`)
}

function readCache(url: string, ttlMs: number): SiteMap | null {
  try {
    const p = cachePathForUrl(url)
    if (!fs.existsSync(p)) return null
    const stat = fs.statSync(p)
    if (Date.now() - stat.mtimeMs > ttlMs) return null
    const raw = fs.readFileSync(p, 'utf-8')
    return JSON.parse(raw) as SiteMap
  } catch {
    return null
  }
}

function writeCache(siteMap: SiteMap): void {
  try {
    const p = cachePathForUrl(siteMap.url)
    fs.writeFileSync(p, JSON.stringify(siteMap, null, 2), 'utf-8')
  } catch {
    // best effort — cache failures should never break generation
  }
}

export function invalidateReconCache(url: string): void {
  try {
    const p = cachePathForUrl(url)
    if (fs.existsSync(p)) fs.unlinkSync(p)
  } catch { /* */ }
}

// ──────────────────────────────────────────────────────────────
// Deterministic page scan (no AI)
// ──────────────────────────────────────────────────────────────

export async function scanBrowserPage(page: Page): Promise<SiteMapRawFacts> {
  const raw = await page.evaluate(() => {
    const trim = (s: string | null | undefined, max = 120) =>
      (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

    const isVisible = (el: Element): boolean => {
      const r = (el as HTMLElement).getBoundingClientRect?.()
      if (!r) return true
      if (r.width === 0 || r.height === 0) return false
      const style = getComputedStyle(el as HTMLElement)
      if (style.visibility === 'hidden' || style.display === 'none') return false
      return true
    }

    const labelFor = (el: Element): string => {
      const id = (el as HTMLElement).id
      if (id) {
        const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`)
        if (lab) return trim(lab.textContent, 80)
      }
      // closest <label>
      const parent = el.closest('label')
      if (parent) return trim(parent.textContent, 80)
      return ''
    }

    // ── Nav links (inside <nav> or role=navigation) ──
    const nav: Array<{ text: string; href: string; role?: string; ariaLabel?: string }> = []
    const navContainers = Array.from(document.querySelectorAll('nav, [role="navigation"]'))
    for (const container of navContainers) {
      const anchors = Array.from(container.querySelectorAll('a[href]')).slice(0, 40)
      for (const a of anchors) {
        if (!isVisible(a)) continue
        const text = trim((a as HTMLAnchorElement).innerText || a.textContent, 60)
        if (!text) continue
        nav.push({
          text,
          href: (a as HTMLAnchorElement).href,
          role: a.getAttribute('role') ?? undefined,
          ariaLabel: a.getAttribute('aria-label') ?? undefined,
        })
      }
    }

    // ── All visible links (capped) ──
    const links: Array<{ text: string; href: string; role?: string; ariaLabel?: string }> = []
    const seenHrefs = new Set<string>()
    const allAnchors = Array.from(document.querySelectorAll('a[href]'))
    for (const a of allAnchors) {
      if (links.length >= 120) break
      if (!isVisible(a)) continue
      const href = (a as HTMLAnchorElement).href
      if (!href || href.startsWith('javascript:')) continue
      const text = trim((a as HTMLAnchorElement).innerText || a.textContent, 80)
        || trim(a.getAttribute('aria-label'), 80)
        || trim(a.getAttribute('title'), 80)
      if (!text) continue
      // dedupe by href+text combo to avoid redundant sibling entries
      const key = `${href}::${text}`
      if (seenHrefs.has(key)) continue
      seenHrefs.add(key)
      links.push({
        text,
        href,
        role: a.getAttribute('role') ?? undefined,
        ariaLabel: a.getAttribute('aria-label') ?? undefined,
      })
    }

    // ── Buttons ──
    const buttons: Array<{ text: string; role?: string; ariaLabel?: string; type?: string }> = []
    const buttonEls = Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]'))
    for (const b of buttonEls) {
      if (buttons.length >= 60) break
      if (!isVisible(b)) continue
      const text = trim((b as HTMLButtonElement).innerText || b.textContent, 60)
        || trim(b.getAttribute('aria-label'), 60)
        || trim(b.getAttribute('value'), 60)
        || trim(b.getAttribute('title'), 60)
      if (!text) continue
      buttons.push({
        text,
        role: b.getAttribute('role') ?? undefined,
        ariaLabel: b.getAttribute('aria-label') ?? undefined,
        type: (b as HTMLInputElement).type ?? undefined,
      })
    }

    // ── Forms + standalone inputs ──
    const extractInputs = (root: ParentNode): Array<{
      tag: string; type?: string; name?: string; id?: string; placeholder?: string
      ariaLabel?: string; role?: string; labelText?: string; required?: boolean
    }> => {
      const out: Array<any> = []
      const els = Array.from(root.querySelectorAll('input, textarea, select'))
      for (const el of els) {
        if (!isVisible(el)) continue
        const inputEl = el as HTMLInputElement
        const type = inputEl.type
        if (type === 'hidden') continue
        out.push({
          tag: el.tagName.toLowerCase(),
          type: type || undefined,
          name: el.getAttribute('name') ?? undefined,
          id: (el as HTMLElement).id || undefined,
          placeholder: el.getAttribute('placeholder') ?? undefined,
          ariaLabel: el.getAttribute('aria-label') ?? undefined,
          role: el.getAttribute('role') ?? undefined,
          labelText: labelFor(el) || undefined,
          required: inputEl.required || undefined,
        })
      }
      return out
    }

    const forms: Array<{ action?: string; method?: string; inputs: any[]; submitText?: string }> = []
    const formEls = Array.from(document.querySelectorAll('form'))
    const inputsInForms = new Set<Element>()
    for (const f of formEls.slice(0, 20)) {
      if (!isVisible(f)) continue
      const formInputs = extractInputs(f)
      const submitBtn = f.querySelector('button[type="submit"], input[type="submit"], button:not([type])')
      forms.push({
        action: f.getAttribute('action') ?? undefined,
        method: f.getAttribute('method') ?? undefined,
        inputs: formInputs,
        submitText: submitBtn ? trim(
          (submitBtn as HTMLButtonElement).innerText
          || submitBtn.textContent
          || submitBtn.getAttribute('value'),
          40,
        ) : undefined,
      })
      for (const el of Array.from(f.querySelectorAll('input, textarea, select'))) inputsInForms.add(el)
    }

    // Inputs not inside any form
    const standaloneInputs: any[] = []
    const allInputs = Array.from(document.querySelectorAll('input, textarea, select'))
    for (const el of allInputs) {
      if (inputsInForms.has(el)) continue
      if (!isVisible(el)) continue
      const type = (el as HTMLInputElement).type
      if (type === 'hidden') continue
      standaloneInputs.push({
        tag: el.tagName.toLowerCase(),
        type: type || undefined,
        name: el.getAttribute('name') ?? undefined,
        id: (el as HTMLElement).id || undefined,
        placeholder: el.getAttribute('placeholder') ?? undefined,
        ariaLabel: el.getAttribute('aria-label') ?? undefined,
        role: el.getAttribute('role') ?? undefined,
        labelText: labelFor(el) || undefined,
        required: (el as HTMLInputElement).required || undefined,
      })
      if (standaloneInputs.length >= 40) break
    }

    // ── Headings ──
    const headings: Array<{ level: number; text: string }> = []
    const headingEls = Array.from(document.querySelectorAll('h1, h2, h3'))
    for (const h of headingEls.slice(0, 30)) {
      if (!isVisible(h)) continue
      const text = trim(h.textContent, 120)
      if (!text) continue
      headings.push({ level: parseInt(h.tagName.slice(1), 10), text })
    }

    const url = location.href
    const urlObj = new URL(url)
    return {
      url,
      origin: urlObj.origin,
      pathname: urlObj.pathname,
      title: document.title,
      lang: document.documentElement.getAttribute('lang') ?? undefined,
      fetchedAt: new Date().toISOString(),
      nav,
      links,
      buttons,
      standaloneInputs,
      forms,
      headings,
      hasIframes: document.querySelectorAll('iframe').length > 0,
      linkCount: allAnchors.length,
      buttonCount: buttonEls.length,
    }
  })
  return raw as SiteMapRawFacts
}

// ──────────────────────────────────────────────────────────────
// URL-pattern derivation (deterministic)
// ──────────────────────────────────────────────────────────────

/**
 * Derives URL templates from the link set. For instance, given
 *   /horoscopes/aries/  /horoscopes/taurus/  /horoscopes/gemini/
 * this returns ["/horoscopes/{slug}/  e.g. aries=Aries | taurus=Taurus | ..."].
 *
 * Improvements over the naive version:
 *  1. Date-like fixed segments (2026-04-06, 20260406) are rewritten as {date}
 *     with a note telling the AI to compute the date at runtime, so generated
 *     goto() URLs don't break the next week.
 *  2. Single-segment templates (/{0}/) are dropped — those are just top-level
 *     nav and belong in the `nav` section, not as "patterns".
 *  3. Each variant slug is paired with the link text it came from, so the AI
 *     sees  `aries=Aries | taurus=Taurus`  instead of bare `aries|taurus` and
 *     doesn't have to cross-reference the links list to pick the right slug.
 */
export function deriveUrlPatterns(facts: SiteMapRawFacts, maxPatterns = 8): string[] {
  const isDateLike = (s: string): boolean =>
    /^\d{4}-\d{2}-\d{2}$/.test(s)
    || /^\d{8}$/.test(s)
    || /^\d{4}\/\d{2}\/\d{2}$/.test(s)
    || /^\d{4}-\d{2}$/.test(s)

  // tmpl → (variant slug → first link text that produced it)
  const counts = new Map<string, Map<string, string>>()
  for (const link of facts.links) {
    let pathname: string
    try { pathname = new URL(link.href).pathname } catch { continue }
    const segs = pathname.split('/').filter(Boolean)
    // Skip single-segment URLs — those are top-level nav, not "patterns".
    if (segs.length <= 1) continue
    for (let i = 0; i < segs.length; i++) {
      const tmpl = '/' + segs.map((s, j) => j === i ? `{${i}}` : s).join('/') + (pathname.endsWith('/') ? '/' : '')
      const variantKey = segs[i]
      if (!counts.has(tmpl)) counts.set(tmpl, new Map())
      const inner = counts.get(tmpl)!
      if (!inner.has(variantKey)) inner.set(variantKey, link.text)
    }
  }

  const ranked = Array.from(counts.entries())
    .filter(([, variants]) => variants.size >= 3) // need ≥3 distinct fillers to call it a pattern
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, maxPatterns)
    .map(([tmpl, variants]) => {
      // Rewrite date-like fixed segments → {date}.
      let hadDate = false
      const withDate = tmpl.split('/').map(seg => {
        if (seg && isDateLike(seg)) { hadDate = true; return '{date}' }
        return seg
      }).join('/')

      // Give the positional `{N}` hole a semantic name based on the first variant.
      const firstSlug = variants.keys().next().value ?? ''
      const holeName = /^[a-z][a-z0-9-]*$/.test(firstSlug) ? '{slug}'
        : /^\d+$/.test(firstSlug) ? '{id}'
        : '{param}'
      const renamed = withDate.replace(/\{\d+\}/, holeName)

      // Pair slug with display text when it adds info.
      const pairs = Array.from(variants.entries()).slice(0, 6).map(([slug, text]) => {
        const t = (text || '').trim()
        if (t && t !== slug && t.length <= 24) return `${slug}=${t}`
        return slug
      }).join(' | ')

      const dateNote = hadDate
        ? '  Note: fill in {date} at runtime (e.g. this Monday in YYYY-MM-DD for weekly)'
        : ''
      return `${renamed}  e.g. ${pairs}${dateNote}`
    })
  return ranked
}

// ──────────────────────────────────────────────────────────────
// AI enrichment (goal-aware)
// ──────────────────────────────────────────────────────────────

interface EnrichResult {
  summary: string
  candidatesForGoal: SiteMap['candidatesForGoal']
}

async function enrichWithAi(
  config: AiProviderConfig,
  facts: SiteMapRawFacts,
  urlPatterns: string[],
  goal: string,
): Promise<EnrichResult | null> {
  // Compact fact sheet — keep token cost bounded.
  const compact = {
    url: facts.url,
    title: facts.title,
    lang: facts.lang,
    nav: facts.nav.slice(0, 20).map(l => ({ t: l.text, h: l.href })),
    links: facts.links.slice(0, 60).map(l => ({ t: l.text, h: l.href })),
    buttons: facts.buttons.slice(0, 30).map(b => ({ t: b.text })),
    forms: facts.forms.slice(0, 5).map(f => ({
      a: f.action, m: f.method, s: f.submitText,
      inputs: f.inputs.map(i => ({
        tag: i.tag, type: i.type, name: i.name, placeholder: i.placeholder,
        aria: i.ariaLabel, label: i.labelText,
      })),
    })),
    standaloneInputs: facts.standaloneInputs.slice(0, 15).map(i => ({
      tag: i.tag, type: i.type, name: i.name, placeholder: i.placeholder,
      aria: i.ariaLabel, label: i.labelText,
    })),
    headings: facts.headings.slice(0, 20),
    urlPatterns,
  }

  const messages = [
    {
      role: 'system',
      content: `You are a website recon agent. You receive a "fact sheet" already produced by a deterministic DOM scan, and the goal of the step you are about to achieve.

Your tasks:
1. Summarize the site structure in 2–4 sentences (summary). Mention URL patterns and repeated structures in particular.
2. List up to 8 elements that could be used to achieve the goal as candidatesForGoal (kept short).
   - kind is "link" | "button" | "input" | "form"
   - label: copy the text from the fact sheet verbatim
   - via: advice on "how to reference it"
   - note: optional short supplement

### ★★★ candidatesForGoal ranking rules (required reading) ★★★
**When urlPatterns exist and the goal requires "iterating over multiple items / bulk fetching / jumping to a specific page",**
**the first (index 0) candidate MUST be a \`page.goto(url)\` style.** It always outranks DOM-click candidates.

Format for goto candidates (required):
  \`page.goto('<absolute URL>')\`                        ← single target
  \`iterate urlPatterns as ['<url1>','<url2>',...] with for-of and page.goto\`  ← multi-item iteration
  \`fill pattern '<pattern>' by replacing {slug} with [...] and loop page.goto\`  ← pattern expansion

Examples:
- goal="Fetch horoscopes for all 12 zodiac signs" + pattern="/horoscopes/{slug}/" exists
  → first candidate: kind:"link", label:"All 12 zodiac pages",
     via:"fill pattern '/horoscopes/{slug}/' by replacing {slug} with ['aries','taurus',...] and loop page.goto"
- goal="Fetch the body of article A" + href=/articles/123/ in links
  → first candidate: via:"page.goto('https://example.com/articles/123/')"

DOM locator candidates (\`getByRole\`, \`locator\`, \`filter\`) must come **after** goto candidates.
Use DOM candidates only for elements unreachable via goto (search button, form submission, modal, etc.).

Always return **exactly one JSON object** — no prose before or after, no extra text or thinking. Schema:
{
  "summary": string,
  "candidatesForGoal": [
    { "kind": "link"|"button"|"input"|"form", "label": string, "via": string, "note"?: string }
  ]
}

Prohibited:
- Do not fabricate labels that don't exist in the fact sheet.
- Do not pad the list with candidates unrelated to the goal. An empty array is fine if there are none.
- Do not use hedging language like "might be" or "is recommended".`,
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: `## goal\n${goal}\n\n## Fact sheet (JSON)\n\`\`\`json\n${JSON.stringify(compact, null, 2)}\n\`\`\`` },
      ],
    },
  ]

  try {
    const result = await chatStream(config, messages, () => { /* silent */ })
    const text = result.text
    const jsonMatch = text.match(/```json\s*\n?([\s\S]*?)```/)
      ?? text.match(/(\{[\s\S]*"summary"[\s\S]*\})/)
    if (!jsonMatch) return null
    const jsonStr = jsonMatch[1] || jsonMatch[0]
    const parsed = JSON.parse(jsonStr) as EnrichResult
    if (typeof parsed.summary !== 'string') return null
    const cands = Array.isArray(parsed.candidatesForGoal) ? parsed.candidatesForGoal : []
    // Safety net: reorder so goto-style candidates come first, regardless of
    // what the AI produced. Matches via strings that reference page.goto,
    // absolute URLs, or pattern-expansion loops.
    const gotoScore = (c: { via?: string }): number => {
      const v = (c?.via ?? '').toLowerCase()
      if (!v) return 0
      if (v.includes('page.goto') || v.includes('goto(')) return 3
      if (/\bpattern\b/.test(v) && v.includes('goto')) return 3
      if (/https?:\/\//.test(v)) return 2
      if (v.includes('href=') || v.includes('href=/')) return 1
      return 0
    }
    const ranked = [...cands].sort((a, b) => gotoScore(b) - gotoScore(a))
    return {
      summary: parsed.summary,
      candidatesForGoal: ranked.slice(0, 8),
    }
  } catch {
    return null
  }
}

// ──────────────────────────────────────────────────────────────
// Deep recon: triage → explore sub-pages → synthesize report
// ──────────────────────────────────────────────────────────────

/**
 * Ask AI whether the current page warrants deeper exploration.
 * Returns which URLs to visit and why.
 */
async function triageDeepRecon(
  config: AiProviderConfig,
  facts: SiteMapRawFacts,
  urlPatterns: string[],
  goal: string,
  enrichResult: { summary?: string; candidatesForGoal?: SiteMap['candidatesForGoal'] },
): Promise<DeepReconTriage> {
  const compactLinks = facts.links.slice(0, 40).map(l => ({ t: l.text, h: l.href }))
  const messages = [
    {
      role: 'system',
      content: `You are a web-recon triage agent.
Looking at the page's fact sheet and the step's goal, decide whether information not available on the current page resides in sub-pages or files (PDFs, etc.).

## Criteria — set shouldExplore = true when
1. The goal implies "data fetching", "information gathering", "content verification", or "building a list"
2. The page has links such as "Details", "PDF", "Download", "Specification", "Public notice"
3. URL patterns exist and the structure of the pages behind the patterns is unknown
4. Link text suggests substantive information (body / conditions / amounts, etc.) behind the link

## Set shouldExplore = false when
1. The goal is only a screen operation (click / input / submit)
2. All needed info can be verified on the current page
3. The goal is only navigation (moving pages)

## How to choose urlsToExplore (max 3)
- Pick links most relevant to achieving the goal
- Prefer representative examples of different kinds of pages (one of each pattern rather than 3 of the same pattern)
- If there are PDF links, include one
- If multiple URLs share a pattern, include just one representative

Return **exactly one JSON object**:
{
  "shouldExplore": boolean,
  "urlsToExplore": [{"url": "absolute URL", "label": "link text", "reason": "why visit"}],
  "reasoning": "reason (1–2 sentences)"
}`,
    },
    {
      role: 'user',
      content: `## goal\n${goal}\n\n## Page summary\n${enrichResult.summary ?? '(none)'}\n\n## Top links (first 40 of ${facts.links.length})\n${JSON.stringify(compactLinks, null, 1)}\n\n## URL patterns\n${urlPatterns.length > 0 ? urlPatterns.join('\n') : '(none)'}`,
    },
  ]

  try {
    const result = await chatStream(config, messages, () => { /* silent */ })
    const text = result.text
    const jsonMatch = text.match(/```json\s*\n?([\s\S]*?)```/)
      ?? text.match(/(\{[\s\S]*"shouldExplore"[\s\S]*\})/)
    if (!jsonMatch) return { shouldExplore: false, urlsToExplore: [], reasoning: 'parse failed' }
    const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]) as DeepReconTriage
    return {
      shouldExplore: Boolean(parsed.shouldExplore),
      urlsToExplore: Array.isArray(parsed.urlsToExplore) ? parsed.urlsToExplore.slice(0, 3) : [],
      reasoning: parsed.reasoning ?? '',
    }
  } catch {
    return { shouldExplore: false, urlsToExplore: [], reasoning: 'triage error' }
  }
}

/**
 * Visit sub-pages identified by triage, perform a lightweight scan on each,
 * and always navigate back to the original page.
 */
async function exploreSubPages(
  page: Page,
  targets: DeepReconTriage['urlsToExplore'],
  stepName: string,
  win: BrowserWindow | null,
  taskId: string,
  stepIndex: number,
  opts: ReconOptions,
): Promise<SubPageFinding[]> {
  const originalUrl = page.url()
  const maxPages = opts.deepReconMaxPages ?? 3
  const pageTimeout = opts.deepReconPageTimeout ?? 8000
  const findings: SubPageFinding[] = []

  try {
    for (const target of targets.slice(0, maxPages)) {
      const finding: SubPageFinding = {
        url: target.url,
        sourceLabel: target.label,
        contentType: 'error',
      }

      try {
        sendAndLog(win, taskId, {
          phase: 'analyzing', stepIndex, stepName,
          message: `🔍 Visiting sub-page: ${target.label} (${target.reason})`,
        })

        // Detect PDF from URL extension before navigating
        const isPdfUrl = /\.pdf(\?|#|$)/i.test(target.url)

        if (isPdfUrl) {
          // For PDFs, use request API to check existence/size without full navigation
          try {
            const resp = await page.context().request.head(target.url, { timeout: pageTimeout })
            finding.contentType = 'pdf'
            const cl = resp.headers()['content-length']
            if (cl) finding.pdfInfo = { sizeBytes: parseInt(cl, 10) }
            finding.title = target.label
          } catch (pdfErr) {
            finding.contentType = 'error'
            finding.error = `PDF HEAD failed: ${(pdfErr as Error).message}`
          }
        } else {
          // Navigate to HTML sub-page
          await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: pageTimeout })

          // Check if we landed on a PDF (content-type redirect)
          const contentType = await page.evaluate(() => document.contentType).catch(() => 'text/html')
          if (contentType === 'application/pdf') {
            finding.contentType = 'pdf'
            finding.title = target.label
          } else {
            // Lightweight HTML scan
            const scan = await page.evaluate(() => {
              const title = document.title
              const headings = Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 10)
                .map(h => ({ level: parseInt(h.tagName.slice(1), 10), text: (h.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 100) }))
                .filter(h => h.text.length > 0)
              const linkCount = document.querySelectorAll('a[href]').length
              const hasSubNav = document.querySelectorAll('nav, [role="navigation"]').length > 0
              const body = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
              // Detect PDF links on this sub-page
              const pdfLinks = Array.from(document.querySelectorAll('a[href]'))
                .filter(a => /\.pdf(\?|#|$)/i.test((a as HTMLAnchorElement).href))
                .length
              return { title, headings, linkCount, hasSubNav, body, pdfLinks }
            })
            finding.contentType = 'html'
            finding.title = scan.title
            finding.headings = scan.headings
            finding.linkCount = scan.linkCount
            finding.hasSubNav = scan.hasSubNav
            finding.contentSnippet = scan.body
            // If sub-page itself has PDF links, note it in the snippet
            if (scan.pdfLinks > 0) {
              finding.contentSnippet = `[This page has ${scan.pdfLinks} PDF link${scan.pdfLinks === 1 ? '' : 's'}] ${scan.body}`
            }
          }
        }
      } catch (navErr) {
        finding.contentType = 'error'
        finding.error = (navErr as Error).message
      }

      findings.push(finding)
    }
  } finally {
    // Always navigate back to the original page
    try {
      if (page.url() !== originalUrl) {
        await page.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: 10000 })
      }
    } catch {
      // Last resort: try goBack
      try { await page.goBack({ timeout: 5000 }) } catch { /* swallow */ }
    }
  }

  return findings
}

/**
 * Synthesize a concise, action-oriented report from sub-page findings
 * that helps codegenAgent pick the right strategy.
 */
async function synthesizeDeepReport(
  config: AiProviderConfig,
  subPages: SubPageFinding[],
  goal: string,
): Promise<string | undefined> {
  const messages = [
    {
      role: 'system',
      content: `You summarize deep-recon findings for a website.
Given the results of actually visiting several sub-pages, write a concise report so the code-generation AI can plan the right strategy.

Include in the summary:
1. Sub-page structure pattern (list → detail hierarchy, direct PDF links, etc.)
2. Where the real data lives (HTML body, inside a PDF, inside a table, etc.)
3. Steps needed to fetch the data (page.goto → text extraction, PDF download → pdf-parse, etc.)
4. If PDFs were found: whether the pdf-parse library is needed for download & text extraction
5. Common patterns across pages (same HTML structure repeated, etc.)

Output: 3–6 sentences of plain text, written as concrete advice for the code-generation AI. Do not use JSON.`,
    },
    {
      role: 'user',
      content: `## goal\n${goal}\n\n## Sub-page visit results\n${JSON.stringify(subPages, null, 2)}`,
    },
  ]

  try {
    const result = await chatStream(config, messages, () => { /* silent */ })
    return result.text.trim()
  } catch {
    return undefined
  }
}

// ──────────────────────────────────────────────────────────────
// Main entry point
// ──────────────────────────────────────────────────────────────

export interface ReconOptions {
  /** Cache TTL in ms. Default: 24h. Pass 0 to disable caching. */
  cacheTtlMs?: number
  /** If true, skip the AI enrichment call. Returns raw facts as SiteMap. */
  skipAiEnrich?: boolean
  /** If true, ignore existing cache entry (but still write fresh one). */
  forceRefresh?: boolean
  /** Enable deep recon: follow representative links to understand site structure. */
  deepRecon?: boolean
  /** Max sub-pages to visit during deep recon. Default: 3. */
  deepReconMaxPages?: number
  /** Per-sub-page navigation timeout in ms. Default: 8000. */
  deepReconPageTimeout?: number
}

export async function reconBrowserPage(
  config: AiProviderConfig,
  page: Page,
  win: BrowserWindow | null,
  taskId: string,
  stepIndex: number,
  stepPlan: StepPlan,
  opts: ReconOptions = {},
): Promise<SiteMap> {
  const ttl = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  const goal = stepPlan.description ?? stepPlan.name ?? ''

  // Ensure DOM is reasonably settled
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 })
  } catch { /* ignore — we'll scan whatever is there */ }

  const currentUrl = page.url()

  // ── Cache lookup ──
  // If deepRecon is requested but the cached entry has no deep recon data,
  // treat it as a cache miss so the deep recon pipeline runs.
  if (!opts.forceRefresh && ttl > 0) {
    const cached = readCache(currentUrl, ttl)
    if (cached) {
      const deepReconMissing = opts.deepRecon && !cached.subPages && !cached.deepScanReport
      if (!deepReconMissing) {
        sendAndLog(win, taskId, {
          phase: 'analyzing',
          stepIndex,
          stepName: stepPlan.name,
          message: `🗺️ Recon cache hit: ${cached.origin}${cached.pathname} (${cached.links.length} links, ${cached.buttons.length} buttons, ${cached.forms.length} forms)`,
        })
        // Stamp the goal this step cares about (even if cache is shared)
        return { ...cached, goalContext: goal }
      }
      // deepRecon requested but cache lacks it — fall through to fresh scan
      sendAndLog(win, taskId, {
        phase: 'analyzing',
        stepIndex,
        stepName: stepPlan.name,
        message: `🗺️ Cache has no deep-recon data — rescanning`,
      })
    }
  }

  // ── Fresh scan ──
  sendAndLog(win, taskId, {
    phase: 'analyzing',
    stepIndex,
    stepName: stepPlan.name,
    message: `🗺️ Starting recon scan: ${currentUrl}`,
  })

  let facts: SiteMapRawFacts
  try {
    facts = await scanBrowserPage(page)
  } catch (e) {
    sendAndLog(win, taskId, {
      phase: 'analyzing',
      stepIndex,
      stepName: stepPlan.name,
      message: `⚠️ Recon scan failed — continuing with normal analysis only: ${(e as Error).message}`,
    })
    // Return a minimal stub so callers can still thread siteMap through without
    // null checks exploding.
    return {
      url: currentUrl,
      origin: (() => { try { return new URL(currentUrl).origin } catch { return '' } })(),
      pathname: (() => { try { return new URL(currentUrl).pathname } catch { return '' } })(),
      title: '',
      fetchedAt: new Date().toISOString(),
      nav: [], links: [], buttons: [], standaloneInputs: [], forms: [], headings: [],
      hasIframes: false, linkCount: 0, buttonCount: 0,
      goalContext: goal,
    }
  }

  const urlPatterns = deriveUrlPatterns(facts)

  sendAndLog(win, taskId, {
    phase: 'analyzing',
    stepIndex,
    stepName: stepPlan.name,
    message: `🗺️ Recon scan complete: ${facts.title || facts.origin} — ${facts.links.length} links / ${facts.buttons.length} buttons / ${facts.forms.length} forms${urlPatterns.length > 0 ? ` / ${urlPatterns.length} URL patterns` : ''}`,
  })

  // ── AI enrichment ──
  let summary: string | undefined
  let candidatesForGoal: SiteMap['candidatesForGoal']
  if (!opts.skipAiEnrich && goal) {
    sendAndLog(win, taskId, {
      phase: 'analyzing',
      stepIndex,
      stepName: stepPlan.name,
      message: `🗺️ Summarizing recon results against the goal...`,
    })
    const enrich = await enrichWithAi(config, facts, urlPatterns, goal)
    if (enrich) {
      summary = enrich.summary
      candidatesForGoal = enrich.candidatesForGoal
      sendAndLog(win, taskId, {
        phase: 'analyzing',
        stepIndex,
        stepName: stepPlan.name,
        message: `🗺️ Recon summary: ${summary}${(candidatesForGoal?.length ?? 0) > 0 ? `\n${candidatesForGoal!.length} candidate${candidatesForGoal!.length === 1 ? '' : 's'}:\n${candidatesForGoal!.map(c => `  - [${c.kind}] "${c.label}" via ${c.via}`).join('\n')}` : ''}`,
      })
    }
  }

  // ── Deep recon (optional) ──
  let subPages: SubPageFinding[] | undefined
  let deepScanReport: string | undefined
  if (opts.deepRecon && goal) {
    try {
      sendAndLog(win, taskId, {
        phase: 'analyzing', stepIndex, stepName: stepPlan.name,
        message: `🗺️ Deep-recon triage: deciding whether exploration is needed...`,
      })
      const triage = await triageDeepRecon(config, facts, urlPatterns, goal, { summary, candidatesForGoal })

      if (triage.shouldExplore && triage.urlsToExplore.length > 0) {
        sendAndLog(win, taskId, {
          phase: 'analyzing', stepIndex, stepName: stepPlan.name,
          message: `🗺️ Deep-recon triage: exploration needed — ${triage.reasoning}\nTargets: ${triage.urlsToExplore.map(u => u.label).join(', ')}`,
        })
        subPages = await exploreSubPages(page, triage.urlsToExplore, stepPlan.name, win, taskId, stepIndex, opts)

        if (subPages.length > 0) {
          sendAndLog(win, taskId, {
            phase: 'analyzing', stepIndex, stepName: stepPlan.name,
            message: `🗺️ Deep recon complete: visited ${subPages.length} page${subPages.length === 1 ? '' : 's'} (${subPages.filter(s => s.contentType === 'pdf').length} PDF, ${subPages.filter(s => s.contentType === 'html').length} HTML, ${subPages.filter(s => s.contentType === 'error').length} error)`,
          })
          deepScanReport = await synthesizeDeepReport(config, subPages, goal)
          if (deepScanReport) {
            sendAndLog(win, taskId, {
              phase: 'analyzing', stepIndex, stepName: stepPlan.name,
              message: `🗺️ Deep-recon report: ${deepScanReport}`,
            })
          }
        }
      } else {
        sendAndLog(win, taskId, {
          phase: 'analyzing', stepIndex, stepName: stepPlan.name,
          message: `🗺️ Deep-recon triage: no exploration needed — ${triage.reasoning}`,
        })
      }
    } catch (deepErr) {
      sendAndLog(win, taskId, {
        phase: 'analyzing', stepIndex, stepName: stepPlan.name,
        message: `⚠️ Deep-recon error — continuing with recon results only: ${(deepErr as Error).message}`,
      })
    }
  }

  const siteMap: SiteMap = {
    ...facts,
    summary,
    urlPatterns,
    candidatesForGoal,
    goalContext: goal,
    subPages,
    deepScanReport,
  }

  // ── Cache write ──
  if (ttl > 0) {
    writeCache(siteMap)
  }

  return siteMap
}

// ──────────────────────────────────────────────────────────────
// Prompt formatting helper
// ──────────────────────────────────────────────────────────────

/**
 * Formats a SiteMap as a compact text block for injection into
 * actionPlanAgent / codegenAgent prompts. Designed to be token-cheap but
 * still carry the high-leverage facts (URL patterns, goal candidates).
 */
export function formatSiteMapForPrompt(siteMap: SiteMap | null | undefined): string {
  if (!siteMap) return ''
  if (!siteMap.url && siteMap.links.length === 0 && siteMap.buttons.length === 0) return ''

  const lines: string[] = []
  lines.push(`## 🗺️ Recon-derived site info (reconAgent)`)
  lines.push(`URL: ${siteMap.url}`)
  if (siteMap.title) lines.push(`Title: ${siteMap.title}`)
  if (siteMap.lang) lines.push(`Language: ${siteMap.lang}`)
  if (siteMap.summary) {
    lines.push(``)
    lines.push(`### Summary`)
    lines.push(siteMap.summary)
  }
  if (siteMap.urlPatterns && siteMap.urlPatterns.length > 0) {
    lines.push(``)
    lines.push(`### Detected URL patterns`)
    for (const p of siteMap.urlPatterns) lines.push(`- ${p}`)
    lines.push(``)
    lines.push(`### ★★★ Iron rules when URL patterns exist (required reading) ★★★`)
    lines.push(`When the patterns above are detected, the following rules are **mandatory**:`)
    lines.push(`1. **Preferred**: build the target URL from the pattern via **string concatenation and navigate directly with \`page.goto(url)\`**.`)
    lines.push(`   Example: to fetch horoscopes per sign → loop goto over 12 URLs. Do NOT search for links in the DOM.`)
    lines.push(`2. **Multi-item iteration** (e.g. 12 zodiac signs, product list, article list): put the pattern's variants in an array and loop with forEach / for-of.`)
    lines.push(`   Looping goto(url) is **10× faster and more robust** than getBy~ → click.`)
    lines.push(`3. **Patterns containing {date}**: compute the required date at runtime from \`new Date()\` and fill it in. Do NOT hard-code.`)
    lines.push(`4. **Do not let ctx.ai() guess URLs**: when patterns are already available, AI inference is unnecessary and unreliable.`)
    lines.push(``)
    lines.push(`### ★ DOM-based element selection notes (no pattern, or supplementary)`)
    lines.push(`- **Do not pass \`exact: true\` to \`getByRole('link'|'button', { name })\`**. Links often contain images/spans that add whitespace, so the accessible name won't match exactly. Use partial match (default) or regex.`)
    lines.push(`- For links with unstable text, CSS like \`a[href*="..."]\` or \`page.locator('a').filter({ hasText: ... })\` is sturdier.`)
    lines.push(`- \`getByText\` often hits multiple elements. Always narrow with \`.first()\` or a parent container.`)
  }
  if (siteMap.candidatesForGoal && siteMap.candidatesForGoal.length > 0) {
    lines.push(``)
    lines.push(`### Candidate elements for the goal (priority order)`)
    lines.push(`**Use the first candidate as the preferred choice.** Priority decreases down the list.`)
    siteMap.candidatesForGoal.forEach((c, i) => {
      const prefix = i === 0 ? '**★ Preferred →**' : `${i + 1}.`
      lines.push(`- ${prefix} [${c.kind}] "${c.label}" → ${c.via}${c.note ? ` (${c.note})` : ''}`)
    })
  }

  // Compact raw facts — just the shapes that matter most.
  if (siteMap.nav.length > 0) {
    lines.push(``)
    lines.push(`### Navigation (${siteMap.nav.length})`)
    for (const n of siteMap.nav.slice(0, 15)) {
      lines.push(`- "${n.text}" → ${n.href}`)
    }
  }

  if (siteMap.forms.length > 0) {
    lines.push(``)
    lines.push(`### Forms (${siteMap.forms.length})`)
    for (const f of siteMap.forms.slice(0, 5)) {
      const inputDescs = f.inputs.map(i => {
        const label = i.labelText || i.ariaLabel || i.placeholder || i.name || i.id || i.type || i.tag
        return `${i.tag}${i.type ? `[${i.type}]` : ''} "${label}"${i.required ? '*' : ''}`
      }).join(', ')
      lines.push(`- action=${f.action ?? '(self)'} method=${f.method ?? 'GET'}${f.submitText ? ` submit="${f.submitText}"` : ''}`)
      if (inputDescs) lines.push(`    inputs: ${inputDescs}`)
    }
  }

  if (siteMap.links.length > 0) {
    lines.push(``)
    lines.push(`### Top links (first ${Math.min(30, siteMap.links.length)} of ${siteMap.links.length})`)
    for (const l of siteMap.links.slice(0, 30)) {
      lines.push(`- "${l.text}" → ${l.href}`)
    }
  }

  if (siteMap.buttons.length > 0) {
    lines.push(``)
    lines.push(`### Buttons (${siteMap.buttons.length})`)
    for (const b of siteMap.buttons.slice(0, 20)) {
      lines.push(`- "${b.text}"${b.ariaLabel ? ` (aria="${b.ariaLabel}")` : ''}`)
    }
  }

  if (siteMap.headings.length > 0) {
    lines.push(``)
    lines.push(`### Headings`)
    for (const h of siteMap.headings.slice(0, 15)) {
      lines.push(`- h${h.level}: ${h.text}`)
    }
  }

  // Deep recon findings
  if (siteMap.deepScanReport) {
    lines.push(``)
    lines.push(`### 🔍 Deep-recon report (verified by actually visiting sub-pages)`)
    lines.push(siteMap.deepScanReport)
    if (siteMap.subPages && siteMap.subPages.length > 0) {
      lines.push(``)
      lines.push(`Visited sub-pages:`)
      for (const sp of siteMap.subPages) {
        const tag = sp.contentType === 'pdf' ? ' [PDF]' : ''
        lines.push(`- "${sp.sourceLabel}" → ${sp.url}${tag}${sp.title ? ` — ${sp.title}` : ''}`)
        if (sp.urlPatterns && sp.urlPatterns.length > 0) {
          lines.push(`  URL patterns: ${sp.urlPatterns.slice(0, 3).join(', ')}`)
        }
        if (sp.contentSnippet) {
          lines.push(`  Content: ${sp.contentSnippet.slice(0, 150)}...`)
        }
        if (sp.error) {
          lines.push(`  ⚠️ Error: ${sp.error}`)
        }
      }
    }
  }

  if (siteMap.hasIframes) {
    lines.push(``)
    lines.push(`⚠️ This page contains iframes. If the target element is inside an iframe, use page.frameLocator().`)
  }

  return lines.join('\n')
}
