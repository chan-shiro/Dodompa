import { ipcMain, dialog, BrowserWindow } from 'electron'
import { v4 as uuid } from 'uuid'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { TaskDefinition, StepMeta } from '../../shared/types'

function getTasksDir(): string {
  const dir = path.join(app.getPath('userData'), 'tasks')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function getTaskDir(taskId: string): string {
  return path.join(getTasksDir(), taskId)
}

function readTask(taskId: string): TaskDefinition {
  const filePath = path.join(getTaskDir(taskId), 'task.json')
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
}

/**
 * Returns true when the step's generated code calls `ctx.ai(...)` at runtime.
 * Matches patterns like `ctx.ai(`, `await ctx.ai(`, `ctx.ai<string>(`. Comments
 * that contain `ctx.ai(` also match — that's an acceptable false positive.
 * Best-effort: missing step files count as `false`.
 */
function stepUsesAi(taskId: string, step: StepMeta): boolean {
  try {
    const code = fs.readFileSync(path.join(getTaskDir(taskId), step.file), 'utf-8')
    return /\bctx\s*\.\s*ai\s*(?:<[^>]+>)?\s*\(/.test(code)
  } catch {
    return false
  }
}

/**
 * Return a shallow-copied task with each step's transient `usesAi` flag
 * populated. Does not mutate the on-disk task.json — the flag is derived
 * from the step code at read time, so edits are reflected immediately.
 */
function enrichTask(task: TaskDefinition): TaskDefinition {
  return {
    ...task,
    steps: task.steps.map((s) => ({ ...s, usesAi: stepUsesAi(task.id, s) })),
  }
}

function writeTask(task: TaskDefinition): void {
  const dir = getTaskDir(task.id)
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify(task, null, 2))
}

export function registerTaskHandlers(): void {
  ipcMain.handle('task:list', async () => {
    const tasksDir = getTasksDir()
    const entries = fs.readdirSync(tasksDir, { withFileTypes: true })
    const tasks: TaskDefinition[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const taskFile = path.join(tasksDir, entry.name, 'task.json')
      if (fs.existsSync(taskFile)) {
        try {
          tasks.push(enrichTask(JSON.parse(fs.readFileSync(taskFile, 'utf-8'))))
        } catch {
          // skip corrupted task files
        }
      }
    }
    return tasks.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )
  })

  ipcMain.handle('task:get', async (_event, id: string) => {
    return enrichTask(readTask(id))
  })

  ipcMain.handle('task:create', async (_event, nameOrObj: string | Record<string, unknown>) => {
    // Defensive: if an object is passed instead of string, extract the name
    const name = typeof nameOrObj === 'string' ? nameOrObj : String(nameOrObj?.name ?? nameOrObj)
    const now = new Date().toISOString()
    const task: TaskDefinition = {
      id: uuid(),
      name,
      description: '',
      profileId: '',
      steps: [],
      variables: [],
      createdAt: now,
      updatedAt: now,
    }
    writeTask(task)
    return task
  })

  ipcMain.handle(
    'task:update',
    async (_event, id: string, data: Partial<TaskDefinition>) => {
      const task = readTask(id)
      const updated = { ...task, ...data, id, updatedAt: new Date().toISOString() }
      writeTask(updated)
      return updated
    }
  )

  ipcMain.handle('task:delete', async (_event, id: string) => {
    const dir = getTaskDir(id)
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  ipcMain.handle(
    'task:deleteStep',
    async (_event, taskId: string, stepId: string) => {
      const task = readTask(taskId)
      const step = task.steps.find((s) => s.id === stepId)
      if (!step) return

      // Delete the step file
      const stepFile = path.join(getTaskDir(taskId), step.file)
      if (fs.existsSync(stepFile)) {
        fs.unlinkSync(stepFile)
      }
      // Also delete compiled .js if exists
      const compiledFile = stepFile.replace(/\.ts$/, '.js')
      if (fs.existsSync(compiledFile)) {
        fs.unlinkSync(compiledFile)
      }

      // Remove from task definition and re-order
      task.steps = task.steps.filter((s) => s.id !== stepId)
      task.steps.forEach((s, i) => { s.order = i + 1 })
      task.updatedAt = new Date().toISOString()
      writeTask(task)

      return task
    }
  )

  ipcMain.handle('task:deleteAllSteps', async (_event, taskId: string) => {
    const task = readTask(taskId)
    const taskDir = getTaskDir(taskId)

    // Delete all step files
    for (const step of task.steps) {
      const stepFile = path.join(taskDir, step.file)
      if (fs.existsSync(stepFile)) fs.unlinkSync(stepFile)
      const compiledFile = stepFile.replace(/\.ts$/, '.js')
      if (fs.existsSync(compiledFile)) fs.unlinkSync(compiledFile)
    }

    task.steps = []
    task.updatedAt = new Date().toISOString()
    writeTask(task)

    return task
  })

  ipcMain.handle(
    'task:addStep',
    async (_event, taskId: string, stepType?: 'browser' | 'desktop') => {
      const task = readTask(taskId)
      const type = stepType ?? 'browser'
      const nextOrder = task.steps.length + 1
      const stepNum = String(nextOrder).padStart(2, '0')
      const stepId = uuid()

      // Build filename, avoiding collisions
      let fileName = `step_${stepNum}_new.ts`
      const taskDir = getTaskDir(taskId)
      let suffix = 1
      while (fs.existsSync(path.join(taskDir, fileName))) {
        suffix++
        fileName = `step_${stepNum}_new_${suffix}.ts`
      }

      // Generate template code
      const templateCode = type === 'desktop'
        ? `import type { DesktopContext } from '../../shared/types';\nexport interface StepContext { profile: Record<string, string>; input: Record<string, string>; shared: Record<string, unknown>; ai: (prompt: string) => Promise<string>; }\n\nexport async function run(desktop: DesktopContext, ctx: StepContext): Promise<void> {\n  // TODO: implement this step\n}\n\nexport const meta = { description: 'New step', retryable: true, timeout: 30000 };\n`
        : `import type { Page, BrowserContext } from 'playwright-core';\nexport interface StepContext { profile: Record<string, string>; input: Record<string, string>; shared: Record<string, unknown>; ai: (prompt: string) => Promise<string>; }\n\nexport async function run(page: Page, context: BrowserContext, ctx: StepContext): Promise<void> {\n  // TODO: implement this step\n}\n\nexport const meta = { description: 'New step', retryable: true, timeout: 30000 };\n`

      fs.writeFileSync(path.join(taskDir, fileName), templateCode, 'utf-8')

      const newStep: StepMeta = {
        id: stepId,
        order: nextOrder,
        file: fileName,
        description: 'New step',
        type,
        status: 'untested' as const,
        lastSuccess: null,
        failCount: 0,
        aiRevisionCount: 0,
      }
      task.steps.push(newStep)
      task.updatedAt = new Date().toISOString()
      writeTask(task)

      return task
    }
  )

  ipcMain.handle('task:readAllStepFiles', async (_event, taskId: string) => {
    const task = readTask(taskId)
    const taskDir = getTaskDir(taskId)
    return task.steps.map(step => {
      const filePath = path.join(taskDir, step.file)
      let code: string | null = null
      try { code = fs.readFileSync(filePath, 'utf-8') } catch { /* missing */ }
      return { stepId: step.id, file: step.file, description: step.description, type: step.type, code }
    })
  })

  ipcMain.handle('task:readStepFile', async (_event, taskId: string, stepFile: string) => {
    const filePath = path.join(getTaskDir(taskId), stepFile)
    if (!fs.existsSync(filePath)) return null
    return fs.readFileSync(filePath, 'utf-8')
  })

  ipcMain.handle('task:writeStepFile', async (_event, taskId: string, stepFile: string, code: string) => {
    const filePath = path.join(getTaskDir(taskId), stepFile)
    fs.writeFileSync(filePath, code, 'utf-8')
  })

  // ─── Export ───
  ipcMain.handle('task:export', async (event, taskId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const task = readTask(taskId)
    const taskDir = getTaskDir(taskId)

    // Read all step code files
    const steps = task.steps.map(s => {
      let code = ''
      try { code = fs.readFileSync(path.join(taskDir, s.file), 'utf-8') } catch { /* skip */ }
      const name = s.file.replace(/^step_\d+_/, '').replace(/\.ts$/, '')
      return { order: s.order, name, description: s.description, type: s.type, code }
    })

    // Strip variable defaults (privacy)
    const cleanedVariables = (task.variables ?? []).map(v => {
      const { default: _default, ...rest } = v as Record<string, unknown>
      return rest
    })

    const exportData = {
      version: 1,
      exportedAt: new Date().toISOString(),
      task: {
        name: task.name,
        description: task.description,
        instruction: task.instruction,
        initialInstruction: task.initialInstruction,
        goal: task.goal,
        variables: cleanedVariables,
        steps,
      },
    }

    const dialogResult = await dialog.showSaveDialog(win!, {
      defaultPath: `${task.name}.dodompa`,
      filters: [{ name: 'Dodompa Task', extensions: ['dodompa'] }],
    })
    if (dialogResult.canceled || !dialogResult.filePath) return { success: false }

    fs.writeFileSync(dialogResult.filePath, JSON.stringify(exportData, null, 2), 'utf-8')
    return { success: true, path: dialogResult.filePath }
  })

  // ─── Import ───
  ipcMain.handle('task:import', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const dialogResult = await dialog.showOpenDialog(win!, {
      filters: [{ name: 'Dodompa Task', extensions: ['dodompa', 'todone'] }],
      properties: ['openFile'],
    })
    if (dialogResult.canceled || dialogResult.filePaths.length === 0) return { success: false }

    const filePath = dialogResult.filePaths[0]
    const raw = fs.readFileSync(filePath, 'utf-8')

    let data: { version?: number; task?: Record<string, unknown> }
    try {
      data = JSON.parse(raw)
    } catch {
      return { success: false, error: 'Failed to parse the file' }
    }

    if (!data.task || typeof data.task.name !== 'string') {
      return { success: false, error: 'Invalid task file' }
    }

    const imported = data.task
    const newId = uuid()
    const now = new Date().toISOString()
    const newTaskDir = getTaskDir(newId)
    fs.mkdirSync(newTaskDir, { recursive: true })

    // Write step code files and build step metadata
    const importedSteps = Array.isArray(imported.steps) ? imported.steps as Array<{
      order: number; name: string; description: string; type: string; code: string
    }> : []

    const stepMetas: StepMeta[] = importedSteps.map((s, idx) => {
      const order = s.order ?? (idx + 1) * 2 - 1
      const fileName = `step_${String(order).padStart(2, '0')}_${s.name}.ts`
      if (s.code) {
        fs.writeFileSync(path.join(newTaskDir, fileName), s.code, 'utf-8')
      }
      return {
        id: `step_${String(order).padStart(2, '0')}`,
        order,
        file: fileName,
        description: s.description ?? '',
        type: (s.type as 'browser' | 'desktop') ?? 'browser',
        status: 'stable' as const,
        lastSuccess: null,
        failCount: 0,
        aiRevisionCount: 0,
      }
    })

    const newTask: TaskDefinition = {
      id: newId,
      name: imported.name as string,
      description: (imported.description as string) ?? '',
      instruction: (imported.instruction as string) ?? undefined,
      initialInstruction: (imported.initialInstruction as string) ?? undefined,
      goal: (imported.goal as string) ?? undefined,
      profileId: '',
      steps: stepMetas,
      variables: Array.isArray(imported.variables) ? imported.variables : [],
      createdAt: now,
      updatedAt: now,
    }

    writeTask(newTask)
    return { success: true, taskId: newId, taskName: newTask.name }
  })
}

// Utility exports for other modules
export { getTaskDir, readTask, writeTask, getTasksDir }
