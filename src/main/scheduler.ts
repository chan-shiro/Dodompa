import cron from 'node-cron'
import fs from 'fs'
import path from 'path'
import { app, BrowserWindow } from 'electron'
import type { TaskDefinition } from '../shared/types'

const scheduledJobs = new Map<string, cron.ScheduledTask>()

function getTasksDir(): string {
  return path.join(app.getPath('userData'), 'tasks')
}

function loadAllTasks(): TaskDefinition[] {
  const tasksDir = getTasksDir()
  if (!fs.existsSync(tasksDir)) return []

  const entries = fs.readdirSync(tasksDir, { withFileTypes: true })
  const tasks: TaskDefinition[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const taskFile = path.join(tasksDir, entry.name, 'task.json')
    if (fs.existsSync(taskFile)) {
      try {
        tasks.push(JSON.parse(fs.readFileSync(taskFile, 'utf-8')))
      } catch { /* skip */ }
    }
  }
  return tasks
}

export function initScheduler(): void {
  const tasks = loadAllTasks()
  for (const task of tasks) {
    if (task.schedule) {
      scheduleTask(task)
    }
  }
}

export function scheduleTask(task: TaskDefinition): void {
  // Remove existing schedule if any
  unscheduleTask(task.id)

  if (!task.schedule || !cron.validate(task.schedule)) return

  const job = cron.schedule(task.schedule, async () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed()) {
      // Trigger execution via the runner
      win.webContents.send('runner:scheduled', {
        taskId: task.id,
        taskName: task.name,
      })
    }
  })

  scheduledJobs.set(task.id, job)
}

export function unscheduleTask(taskId: string): void {
  const existing = scheduledJobs.get(taskId)
  if (existing) {
    existing.stop()
    scheduledJobs.delete(taskId)
  }
}

export function getScheduledTaskIds(): string[] {
  return Array.from(scheduledJobs.keys())
}
