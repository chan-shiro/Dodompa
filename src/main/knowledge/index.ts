// ─── Knowledge Loader ───
// Per-app knowledge files live as Markdown with frontmatter under ./apps/.
// Each file is imported via Vite's `?raw` suffix so the content is bundled
// into the main process output and available at runtime without any fs I/O.
//
// Adding support for a new app:
//   1. Drop a new `apps/<name>.md` with the same frontmatter shape
//   2. Add one `import ... from './apps/<name>.md?raw'` line below
//   3. Push it into RAW_FILES
//
// resolveKnowledge() returns only the files whose aliases / bundleIds match
// the current execution context, plus any file flagged `always: true`.

import commonMd from './_common.md?raw'
import slackMd from './apps/slack.md?raw'
import remindersMd from './apps/reminders.md?raw'
import mailMd from './apps/mail.md?raw'
import notesMd from './apps/notes.md?raw'
import finderMd from './apps/finder.md?raw'
import texteditMd from './apps/textedit.md?raw'
import safariMd from './apps/safari.md?raw'
import messagesMd from './apps/messages.md?raw'
import excelMd from './apps/excel.md?raw'

const RAW_FILES: string[] = [
  commonMd,
  slackMd,
  remindersMd,
  mailMd,
  notesMd,
  finderMd,
  texteditMd,
  safariMd,
  messagesMd,
  excelMd,
]

import type { KnowledgePlatform, KnowledgeEntry } from '../../shared/types'

export interface KnowledgeFrontmatter {
  name: string
  description?: string
  app?: string
  bundleIds?: string[]
  aliases?: string[]
  category?: string
  appleScript?: 'full' | 'limited' | 'none'
  always?: boolean
  platform?: KnowledgePlatform
}

export interface KnowledgeFile {
  frontmatter: KnowledgeFrontmatter
  body: string
  isBuiltin: boolean
}

let cache: KnowledgeFile[] | null = null

export function loadAllKnowledge(): KnowledgeFile[] {
  if (cache) return cache
  const files: KnowledgeFile[] = []
  for (const raw of RAW_FILES) {
    const parsed = parseFrontmatter(raw)
    if (parsed) {
      parsed.isBuiltin = true
      files.push(parsed)
    }
  }
  cache = files
  return files
}

/**
 * Minimal YAML-ish frontmatter parser. Supports strings, booleans, and
 * inline arrays (`[a, b, c]`). No nested objects — keep frontmatter flat.
 */
function parseFrontmatter(raw: string): KnowledgeFile | null {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return null
  const [, fmText, body] = m
  const fm: Record<string, unknown> = {}
  for (const line of fmText.split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
    if (!kv) continue
    const [, key, rawVal] = kv
    const val = rawVal.trim()
    if (val === 'true') fm[key] = true
    else if (val === 'false') fm[key] = false
    else if (val.startsWith('[') && val.endsWith(']')) {
      fm[key] = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    } else {
      fm[key] = val.replace(/^["']|["']$/g, '')
    }
  }
  if (typeof fm.name !== 'string') return null
  return { frontmatter: fm as KnowledgeFrontmatter, body: body.trimStart(), isBuiltin: false }
}

export interface ResolveContext {
  detectedApp?: string
  detectedBundleId?: string
  stepDescription?: string
  taskDescription?: string
  platform?: KnowledgePlatform
}

// ──────────────────────────────────────────────────────────────
// Custom knowledge merge (runtime + builtin)
// ──────────────────────────────────────────────────────────────

let customKnowledgeLoader: (() => KnowledgeFile[]) | null = null
let mergedCache: KnowledgeFile[] | null = null

/** Register the custom knowledge loader (called from knowledgeManager). */
export function setCustomKnowledgeLoader(loader: () => KnowledgeFile[]): void {
  customKnowledgeLoader = loader
}

/** Invalidate the merged cache (called after save/delete). */
export function invalidateKnowledgeCache(): void {
  mergedCache = null
}

/** Load all knowledge: builtin + custom, custom overrides by name. */
export function loadAllMergedKnowledge(): KnowledgeFile[] {
  if (mergedCache) return mergedCache
  const builtIn = loadAllKnowledge()
  const custom = customKnowledgeLoader?.() ?? []
  const map = new Map<string, KnowledgeFile>()
  for (const f of builtIn) map.set(f.frontmatter.name, f)
  for (const f of custom) map.set(f.frontmatter.name, f)
  mergedCache = Array.from(map.values())
  return mergedCache
}

/** Get all knowledge entries in renderer-facing format. */
export function getAllKnowledgeEntries(): KnowledgeEntry[] {
  return loadAllMergedKnowledge().map(f => ({
    name: f.frontmatter.name,
    description: f.frontmatter.description,
    app: f.frontmatter.app,
    platform: f.frontmatter.platform ?? 'mac',
    bundleIds: f.frontmatter.bundleIds,
    aliases: f.frontmatter.aliases,
    category: f.frontmatter.category,
    appleScript: f.frontmatter.appleScript,
    always: f.frontmatter.always,
    body: f.body,
    isBuiltin: f.isBuiltin,
  }))
}

/**
 * A file matches when any of:
 *   - `always: true`
 *   - `bundleIds` includes `ctx.detectedBundleId`
 *   - `aliases` contains or is contained by `ctx.detectedApp` (case-insensitive)
 *   - any alias appears in `stepDescription` or `taskDescription`
 */
export function resolveKnowledge(ctx: ResolveContext): KnowledgeFile[] {
  const all = loadAllMergedKnowledge()
  const detectedApp = (ctx.detectedApp ?? '').toLowerCase()
  const haystack = `${ctx.stepDescription ?? ''}\n${ctx.taskDescription ?? ''}`.toLowerCase()

  const matched = new Set<KnowledgeFile>()
  for (const f of all) {
    const fm = f.frontmatter
    if (fm.always) { matched.add(f); continue }
    // Platform filter: skip entries that don't match the requested platform
    if (ctx.platform && fm.platform && fm.platform !== ctx.platform) continue
    if (fm.bundleIds && ctx.detectedBundleId && fm.bundleIds.includes(ctx.detectedBundleId)) {
      matched.add(f); continue
    }
    if (fm.aliases && fm.aliases.length > 0) {
      const aliasHit = fm.aliases.some(a => {
        const al = a.toLowerCase()
        if (!al) return false
        if (detectedApp && (detectedApp === al || detectedApp.includes(al) || al.includes(detectedApp))) return true
        // For ASCII-only aliases, require a word boundary to avoid "mail" matching "email"
        // or "notes" matching "denoted". For aliases containing non-ASCII (Japanese), plain
        // substring matching is fine since there are no word boundaries.
        const isAscii = /^[\x00-\x7F]+$/.test(al)
        if (isAscii) {
          const re = new RegExp(`(?:^|[^a-z0-9])${al.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z0-9])`, 'i')
          if (re.test(haystack)) return true
        } else if (haystack.includes(al)) {
          return true
        }
        return false
      })
      if (aliasHit) { matched.add(f); continue }
    }
  }

  // Stable order: always-files first, then by name
  return Array.from(matched).sort((a, b) => {
    const aw = a.frontmatter.always ? 0 : 1
    const bw = b.frontmatter.always ? 0 : 1
    if (aw !== bw) return aw - bw
    return a.frontmatter.name.localeCompare(b.frontmatter.name)
  })
}

/**
 * Render matched knowledge as a single markdown block ready to inject into
 * a system prompt. Returns an empty string when nothing matched.
 */
export function renderKnowledgeBlock(ctx: ResolveContext): string {
  const files = resolveKnowledge(ctx)
  if (files.length === 0) return ''
  const sections = files.map(f => {
    const title = f.frontmatter.app ?? f.frontmatter.name
    return `### 📚 ${title}\n${f.body.trim()}`
  })
  return `\n\n## 🧠 アプリ固有の知識 (動的注入)\n${sections.join('\n\n')}\n`
}
