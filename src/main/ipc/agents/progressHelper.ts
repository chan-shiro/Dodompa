// ─── Progress & Logging Helpers ───
// Shared utilities for sending progress events to the UI and logging to DB.
//
// sendProgress   → real-time UI update only (ephemeral)
// logGenerationStep → DB persistence only (for post-hoc review)
// sendAndLog     → both: sends to UI AND persists to DB

import { BrowserWindow } from 'electron'
import { v4 as uuid } from 'uuid'
import fs from 'fs'
import path from 'path'
import { getDb } from '../../db'
import { getTaskDir } from '../taskManager'
import type { GenerationAgentKey, GenerationProgressEvent } from '../../../shared/types'

/**
 * Default mapping from coarse `phase` to fine-grained `agent` key. Only used
 * when an emitter did not set `agent` explicitly. Phase 'generating' is
 * intentionally excluded because it's shared by actionPlanAgent and
 * codegenAgent — those two must set `agent` themselves to disambiguate.
 */
const PHASE_TO_AGENT: Partial<Record<GenerationProgressEvent['phase'], GenerationAgentKey>> = {
  planning: 'planning',
  analyzing: 'analyzing',
  selector: 'selector',
  executing: 'executing',
  verifying: 'verifying',
  fixing: 'fixing',
}

/**
 * Send a progress event to the renderer (real-time, ephemeral).
 * Auto-fills `agent` from `phase` using PHASE_TO_AGENT when the emitter did
 * not specify it. This keeps older call sites working while letting the
 * frontend render the fine-grained agent flow strip reliably.
 */
export function sendProgress(win: BrowserWindow | null, event: GenerationProgressEvent) {
  const out: GenerationProgressEvent = event.agent
    ? event
    : { ...event, agent: PHASE_TO_AGENT[event.phase] }
  if (win && !win.isDestroyed()) {
    win.webContents.send('ai:generation-progress', out)
  }
}

/**
 * Persist a generation step log to the DB (for later review).
 */
export function logGenerationStep(
  taskId: string,
  phase: string,
  message: string,
  detail?: string | null,
  screenshotBase64?: string,
  messageCode?: string | null,
  messageParams?: Record<string, string | number> | null,
): string {
  const db = getDb()
  const id = uuid()
  let screenshotPath: string | null = null

  // Save screenshot to disk if provided
  if (screenshotBase64) {
    const screenshotDir = path.join(getTaskDir(taskId), 'screenshots')
    fs.mkdirSync(screenshotDir, { recursive: true })
    screenshotPath = path.join(screenshotDir, `gen_${id}.png`)
    fs.writeFileSync(screenshotPath, Buffer.from(screenshotBase64, 'base64'))
  }

  db.prepare(
    `INSERT INTO generation_step_logs (id, task_id, step_id, phase, message, detail, screenshot_path, message_code, message_params, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, taskId, phase, message, detail ?? null, screenshotPath,
    messageCode ?? null,
    messageParams ? JSON.stringify(messageParams) : null,
    new Date().toISOString(),
  )

  return id
}

/**
 * Send progress to UI AND persist to DB.
 * Use this for all meaningful progress events so they survive after the modal closes.
 * Stream deltas (streamDelta) are NOT persisted (too noisy, ephemeral by nature).
 */
export function sendAndLog(
  win: BrowserWindow | null,
  taskId: string,
  event: GenerationProgressEvent,
  detail?: string | null,
): void {
  // Always send to UI
  sendProgress(win, event)

  // Don't persist stream deltas or empty messages
  if (event.streamDelta || !event.message) return

  // Persist to DB
  const screenshotBase64 = event.screenshot ?? undefined
  logGenerationStep(
    taskId, event.phase, event.message, detail, screenshotBase64,
    event.messageCode, event.messageParams,
  )
}
