import { ipcMain, app } from 'electron'
import fs from 'fs'
import path from 'path'
import { getDb } from '../db'

export function registerLogHandlers(): void {
  ipcMain.handle('log:listExecutions', async (_event, taskId?: string) => {
    const db = getDb()
    const sql = `
      SELECT
        id,
        task_id   AS taskId,
        status,
        started_at  AS startedAt,
        finished_at AS finishedAt,
        variables,
        error
      FROM execution_logs
      ${taskId ? 'WHERE task_id = ?' : ''}
      ORDER BY started_at DESC
      LIMIT 100
    `
    return taskId ? db.prepare(sql).all(taskId) : db.prepare(sql).all()
  })

  ipcMain.handle('log:getStepLogs', async (_event, executionId: string) => {
    const db = getDb()
    return db
      .prepare(
        `SELECT
          id,
          execution_id         AS executionId,
          step_id              AS stepId,
          step_description     AS stepDescription,
          status,
          started_at           AS startedAt,
          finished_at          AS finishedAt,
          page_url             AS pageUrl,
          page_title           AS pageTitle,
          screenshot_before_path AS screenshotBeforePath,
          screenshot_path      AS screenshotPath,
          html_snapshot_path   AS htmlSnapshotPath,
          shared_state         AS sharedState,
          error
        FROM step_logs
        WHERE execution_id = ?
        ORDER BY started_at ASC`
      )
      .all(executionId)
  })

  ipcMain.handle('log:listAiLogs', async (_event, taskId?: string) => {
    const db = getDb()
    const sql = `
      SELECT
        id,
        task_id     AS taskId,
        step_id     AS stepId,
        type,
        prompt,
        response,
        provider,
        model,
        tokens_used AS tokensUsed,
        status,
        created_at  AS createdAt
      FROM ai_logs
      ${taskId ? 'WHERE task_id = ?' : ''}
      ORDER BY created_at DESC
      LIMIT 100
    `
    return taskId ? db.prepare(sql).all(taskId) : db.prepare(sql).all()
  })

  // Aggregate execution stats for ALL tasks in one query. Used by the task
  // list page to render run/success/failure counts without N round-trips.
  ipcMain.handle('log:getTaskStats', async () => {
    const db = getDb()
    const rows = db
      .prepare(
        `SELECT
          task_id AS taskId,
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
          SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
          MAX(started_at) AS lastRunAt
        FROM execution_logs
        GROUP BY task_id`
      )
      .all() as Array<{
        taskId: string
        total: number
        success: number
        failed: number
        running: number
        lastRunAt: string | null
      }>
    return rows
  })

  ipcMain.handle('screenshot:read', async (_event, filePath: string) => {
    if (!fs.existsSync(filePath)) return null
    const buf = fs.readFileSync(filePath)
    return `data:image/png;base64,${buf.toString('base64')}`
  })

  // ─── Storage Info ───

  ipcMain.handle('log:getStorageInfo', async (_event, taskId: string) => {
    const db = getDb()
    const taskDir = path.join(app.getPath('userData'), 'tasks', taskId)
    const ssDir = path.join(taskDir, 'screenshots')

    // Screenshot files on disk
    let screenshotCount = 0
    let screenshotBytes = 0
    if (fs.existsSync(ssDir)) {
      for (const f of fs.readdirSync(ssDir)) {
        try {
          const stat = fs.statSync(path.join(ssDir, f))
          if (stat.isFile()) {
            screenshotCount++
            screenshotBytes += stat.size
          }
        } catch { /* skip */ }
      }
    }

    // DB log counts
    const execCount = (db.prepare('SELECT COUNT(*) as c FROM execution_logs WHERE task_id = ?').get(taskId) as { c: number }).c
    const stepCount = (db.prepare('SELECT COUNT(*) as c FROM step_logs WHERE execution_id IN (SELECT id FROM execution_logs WHERE task_id = ?)').get(taskId) as { c: number }).c
    const genLogCount = (db.prepare('SELECT COUNT(*) as c FROM generation_step_logs WHERE task_id = ?').get(taskId) as { c: number }).c
    const aiLogCount = (db.prepare('SELECT COUNT(*) as c FROM ai_logs WHERE task_id = ?').get(taskId) as { c: number }).c

    return {
      screenshotCount,
      screenshotBytes,
      executionCount: execCount,
      stepLogCount: stepCount,
      generationLogCount: genLogCount,
      aiLogCount: aiLogCount,
    }
  })

  // ─── Cleanup Old Data ───

  ipcMain.handle('log:cleanupOldData', async (_event, taskId: string, keepRecent: number = 5) => {
    const db = getDb()
    const taskDir = path.join(app.getPath('userData'), 'tasks', taskId)

    // 1. Find execution IDs to delete (keep the most recent N)
    const allExecs = db.prepare(
      'SELECT id FROM execution_logs WHERE task_id = ? ORDER BY started_at DESC'
    ).all(taskId) as { id: string }[]

    const execsToDelete = allExecs.slice(keepRecent).map(e => e.id)

    if (execsToDelete.length > 0) {
      // 2. Get screenshot paths from step_logs before deleting
      const placeholders = execsToDelete.map(() => '?').join(',')
      const stepScreenshots = db.prepare(
        `SELECT screenshot_before_path, screenshot_path, html_snapshot_path
         FROM step_logs WHERE execution_id IN (${placeholders})`
      ).all(...execsToDelete) as { screenshot_before_path: string | null; screenshot_path: string | null; html_snapshot_path: string | null }[]

      // Delete screenshot files
      for (const row of stepScreenshots) {
        for (const p of [row.screenshot_before_path, row.screenshot_path, row.html_snapshot_path]) {
          if (p) try { fs.unlinkSync(p) } catch { /* already gone */ }
        }
      }

      // 3. Delete step_logs and execution_logs
      db.prepare(`DELETE FROM step_logs WHERE execution_id IN (${placeholders})`).run(...execsToDelete)
      db.prepare(`DELETE FROM execution_logs WHERE id IN (${placeholders})`).run(...execsToDelete)
    }

    // 4. Clean up old generation_step_logs (keep recent N generation sessions)
    // A "session" = contiguous logs between 'planning' phases
    const allGenLogs = db.prepare(
      'SELECT id, screenshot_path FROM generation_step_logs WHERE task_id = ? ORDER BY created_at DESC'
    ).all(taskId) as { id: string; screenshot_path: string | null }[]

    // Keep the most recent keepRecent * 50 generation log entries (generous)
    const genLogsToDelete = allGenLogs.slice(keepRecent * 50)
    if (genLogsToDelete.length > 0) {
      for (const log of genLogsToDelete) {
        if (log.screenshot_path) try { fs.unlinkSync(log.screenshot_path) } catch { /* */ }
      }
      const genIds = genLogsToDelete.map(l => l.id)
      const genPlaceholders = genIds.map(() => '?').join(',')
      db.prepare(`DELETE FROM generation_step_logs WHERE id IN (${genPlaceholders})`).run(...genIds)
    }

    // 5. Clean up old ai_logs (keep recent keepRecent * 20)
    const allAiLogs = db.prepare(
      'SELECT id FROM ai_logs WHERE task_id = ? ORDER BY created_at DESC'
    ).all(taskId) as { id: string }[]

    const aiLogsToDelete = allAiLogs.slice(keepRecent * 20)
    if (aiLogsToDelete.length > 0) {
      const aiIds = aiLogsToDelete.map(l => l.id)
      const aiPlaceholders = aiIds.map(() => '?').join(',')
      db.prepare(`DELETE FROM ai_logs WHERE id IN (${aiPlaceholders})`).run(...aiIds)
    }

    // 6. Clean orphan screenshot files (on disk but not referenced by any remaining log)
    const ssDir = path.join(taskDir, 'screenshots')
    if (fs.existsSync(ssDir)) {
      const referencedPaths = new Set<string>()
      const remaining = db.prepare(
        `SELECT screenshot_before_path, screenshot_path, html_snapshot_path FROM step_logs
         WHERE execution_id IN (SELECT id FROM execution_logs WHERE task_id = ?)`
      ).all(taskId) as { screenshot_before_path: string | null; screenshot_path: string | null; html_snapshot_path: string | null }[]
      for (const r of remaining) {
        if (r.screenshot_before_path) referencedPaths.add(r.screenshot_before_path)
        if (r.screenshot_path) referencedPaths.add(r.screenshot_path)
        if (r.html_snapshot_path) referencedPaths.add(r.html_snapshot_path)
      }
      const remainingGen = db.prepare(
        'SELECT screenshot_path FROM generation_step_logs WHERE task_id = ? AND screenshot_path IS NOT NULL'
      ).all(taskId) as { screenshot_path: string }[]
      for (const r of remainingGen) referencedPaths.add(r.screenshot_path)

      for (const f of fs.readdirSync(ssDir)) {
        const fullPath = path.join(ssDir, f)
        if (!referencedPaths.has(fullPath)) {
          try { fs.unlinkSync(fullPath) } catch { /* */ }
        }
      }
    }

    return { ok: true }
  })
}
