// ─── Knowledge Manager ───
// Disk I/O for user-created custom knowledge entries.
// Custom knowledge is stored as JSON files under {userData}/knowledge/
// and merged with built-in knowledge at resolve time.

import { ipcMain, app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import type { KnowledgeEntry } from '../../shared/types'
import {
  getAllKnowledgeEntries,
  setCustomKnowledgeLoader,
  invalidateKnowledgeCache,
} from '../knowledge'
import type { KnowledgeFile } from '../knowledge'

function getKnowledgeDir(): string {
  const dir = path.join(app.getPath('userData'), 'knowledge')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64)
}

/** Read all custom knowledge files from disk. */
export function readCustomKnowledge(): KnowledgeFile[] {
  const dir = getKnowledgeDir()
  const files: KnowledgeFile[] = []
  try {
    for (const fname of fs.readdirSync(dir)) {
      if (!fname.endsWith('.json')) continue
      try {
        const raw = fs.readFileSync(path.join(dir, fname), 'utf-8')
        const entry = JSON.parse(raw) as KnowledgeEntry
        if (!entry.name) continue
        files.push({
          frontmatter: {
            name: entry.name,
            description: entry.description,
            app: entry.app,
            platform: entry.platform,
            bundleIds: entry.bundleIds,
            aliases: entry.aliases,
            category: entry.category,
            appleScript: entry.appleScript,
            always: entry.always,
          },
          body: entry.body ?? '',
          isBuiltin: false,
        })
      } catch { /* skip invalid files */ }
    }
  } catch { /* directory doesn't exist yet */ }
  return files
}

function saveCustomKnowledgeToDisk(entry: KnowledgeEntry): void {
  const dir = getKnowledgeDir()
  const filename = `${sanitizeName(entry.name)}.json`
  const data: KnowledgeEntry = {
    name: entry.name,
    description: entry.description,
    app: entry.app,
    platform: entry.platform ?? 'mac',
    bundleIds: entry.bundleIds,
    aliases: entry.aliases,
    category: entry.category,
    appleScript: entry.appleScript,
    always: entry.always,
    body: entry.body ?? '',
    isBuiltin: false,
  }
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2), 'utf-8')
}

function deleteCustomKnowledgeFromDisk(name: string): void {
  const dir = getKnowledgeDir()
  const filename = `${sanitizeName(name)}.json`
  const filePath = path.join(dir, filename)
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
}

export function registerKnowledgeHandlers(): void {
  // Register custom knowledge loader with the knowledge index
  setCustomKnowledgeLoader(readCustomKnowledge)

  ipcMain.handle('knowledge:list', async () => {
    return getAllKnowledgeEntries()
  })

  ipcMain.handle('knowledge:get', async (_event, name: string) => {
    const all = getAllKnowledgeEntries()
    return all.find(e => e.name === name) ?? null
  })

  ipcMain.handle('knowledge:save', async (_event, entry: KnowledgeEntry) => {
    saveCustomKnowledgeToDisk(entry)
    invalidateKnowledgeCache()
    return { success: true }
  })

  ipcMain.handle('knowledge:delete', async (_event, name: string) => {
    // Don't allow deleting built-in entries
    const all = getAllKnowledgeEntries()
    const target = all.find(e => e.name === name)
    if (target?.isBuiltin) {
      return { success: false, error: 'Cannot delete built-in knowledge' }
    }
    deleteCustomKnowledgeFromDisk(name)
    invalidateKnowledgeCache()
    return { success: true }
  })
}
