import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import type { TaskDefinition } from '../lib/types'
import * as api from '../lib/api'
import { useCompositionGuard } from '../lib/hooks'
import TaskCleanupModal from '../components/TaskCleanupModal'

function StatusBadge({ steps }: { steps: TaskDefinition['steps'] }) {
  const { t } = useTranslation('taskList')
  const broken = steps.filter((s) => s.status === 'broken').length
  const flaky = steps.filter((s) => s.status === 'flaky').length
  const stable = steps.filter((s) => s.status === 'stable').length

  if (broken > 0)
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-red-50 text-notion-danger">
        {t('status.broken', { count: broken })}
      </span>
    )
  if (flaky > 0)
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-yellow-50 text-notion-warning">
        {t('status.flaky', { count: flaky })}
      </span>
    )
  if (stable > 0)
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-green-50 text-notion-success">
        {t('status.stable')}
      </span>
    )
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-notion-text-muted">
      {t('status.unset')}
    </span>
  )
}

function useFormatLastRun() {
  const { t, i18n } = useTranslation('common')
  return (iso: string | null): string => {
    if (!iso) return '—'
    const d = new Date(iso)
    if (isNaN(d.getTime())) return '—'
    const now = Date.now()
    const diff = now - d.getTime()
    const minutes = Math.floor(diff / 60000)
    if (minutes < 1) return t('time.justNow')
    if (minutes < 60) return t('time.minutesAgo', { count: minutes })
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return t('time.hoursAgo', { count: hours })
    const days = Math.floor(hours / 24)
    if (days < 30) return t('time.daysAgo', { count: days })
    const locale = i18n.language === 'ja' ? 'ja-JP' : 'en-US'
    return d.toLocaleDateString(locale)
  }
}

export default function TaskList() {
  const [tasks, setTasks] = useState<TaskDefinition[]>([])
  const [stats, setStats] = useState<Record<string, api.TaskStats>>({})
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [showCleanup, setShowCleanup] = useState(false)
  const navigate = useNavigate()
  const { compositionProps, isComposing } = useCompositionGuard()
  const { t } = useTranslation('taskList')
  const formatLastRun = useFormatLastRun()

  const loadData = () => {
    api.listTasks().then(setTasks).catch(console.error)
    api.getTaskStats()
      .then((rows) => {
        const map: Record<string, api.TaskStats> = {}
        for (const r of rows) map[r.taskId] = r
        setStats(map)
      })
      .catch(console.error)
  }

  useEffect(() => {
    loadData()
  }, [])

  const handleCreate = async () => {
    if (!newName.trim()) return
    const task = await api.createTask(newName.trim())
    setNewName('')
    setCreating(false)
    navigate(`/tasks/${task.id}`)
  }

  const handleDelete = async (e: React.MouseEvent, task: TaskDefinition) => {
    e.stopPropagation()
    const name = typeof task.name === 'string' ? task.name : String(task.name ?? '')
    if (!confirm(t('confirmDelete', { name }))) return
    try {
      await api.deleteTask(task.id)
      loadData()
    } catch (err) {
      console.error(err)
      alert(t('deleteFailed', { message: (err as Error).message }))
    }
  }

  const handleEdit = (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation()
    navigate(`/tasks/${taskId}`)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-base font-semibold text-notion-text-primary">{t('title')}</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowCleanup(true)}
            disabled={tasks.length === 0}
            className="px-2 py-1 border border-notion-border text-xs rounded hover:bg-notion-hover disabled:opacity-40"
            title={t('cleanupTitle')}
          >
            {t('cleanup')}
          </button>
          <button
            onClick={async () => {
              const result = await api.importTask()
              if (result.success && result.taskId) {
                loadData()
              } else if (result.error) {
                alert(result.error)
              }
            }}
            className="px-2 py-1 border border-notion-border text-xs rounded hover:bg-notion-hover"
            title={t('importTitle')}
          >
            {t('import')}
          </button>
          <button
            onClick={() => setCreating(true)}
            className="px-2 py-1 bg-notion-accent text-white text-xs rounded hover:bg-neutral-700"
          >
            {t('newTask')}
          </button>
        </div>
      </div>

      {creating && (
        <div className="mb-3 p-2.5 border border-notion-border rounded bg-notion-sidebar">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !isComposing() && handleCreate()}
            {...compositionProps}
            placeholder={t('namePlaceholder')}
            className="w-full px-2 py-1.5 border border-notion-border rounded text-xs bg-white focus:outline-none focus:ring-2 focus:ring-notion-accent/30 focus:border-notion-accent"
            autoFocus
          />
          <div className="flex gap-2 mt-2">
            <button
              onClick={handleCreate}
              className="px-2 py-1 bg-notion-accent text-white text-xs rounded hover:bg-neutral-700"
            >
              {t('actions.create', { ns: 'common' })}
            </button>
            <button
              onClick={() => {
                setCreating(false)
                setNewName('')
              }}
              className="px-2 py-1 text-xs text-notion-text-secondary hover:bg-notion-hover rounded"
            >
              {t('actions.cancel', { ns: 'common' })}
            </button>
          </div>
        </div>
      )}

      {tasks.length === 0 && !creating ? (
        <div className="text-center py-16 text-notion-text-muted">
          <p className="text-sm mb-2">{t('empty')}</p>
          <p className="text-xs">{t('emptyHint')}</p>
        </div>
      ) : (
        <div className="border border-notion-border rounded overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-notion-sidebar border-b border-notion-border">
              <tr className="text-left text-notion-text-muted">
                <th className="px-3 py-2 font-medium">{t('columns.name')}</th>
                <th className="px-3 py-2 font-medium text-center">{t('columns.steps')}</th>
                <th className="px-3 py-2 font-medium">{t('columns.status')}</th>
                <th className="px-3 py-2 font-medium text-center">{t('columns.runs')}</th>
                <th className="px-3 py-2 font-medium text-center text-notion-success">{t('columns.success')}</th>
                <th className="px-3 py-2 font-medium text-center text-notion-danger">{t('columns.failed')}</th>
                <th className="px-3 py-2 font-medium">{t('columns.lastRun')}</th>
                <th className="px-3 py-2 font-medium text-right">{t('columns.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => {
                const s = stats[task.id]
                const taskName = typeof task.name === 'string' ? task.name : String(task.name?.name ?? task.name ?? '')
                return (
                  <tr
                    key={task.id}
                    onClick={() => navigate(`/tasks/${task.id}`)}
                    className="border-b border-notion-border last:border-0 hover:bg-notion-hover cursor-pointer"
                  >
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-notion-text-primary truncate max-w-[260px]">
                          {taskName}
                        </span>
                        {task.schedule && (
                          <span className="text-notion-accent" title={task.schedule}>⏰</span>
                        )}
                      </div>
                      {task.description && (
                        <p className="text-[10px] text-notion-text-muted mt-0.5 truncate max-w-[360px]">
                          {task.description}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center text-notion-text-secondary">
                      {task.steps.length}
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge steps={task.steps} />
                    </td>
                    <td className="px-3 py-2 text-center text-notion-text-secondary">
                      {s?.total ?? 0}
                    </td>
                    <td className="px-3 py-2 text-center text-notion-success font-medium">
                      {s?.success ?? 0}
                    </td>
                    <td className="px-3 py-2 text-center text-notion-danger font-medium">
                      {s?.failed ?? 0}
                    </td>
                    <td className="px-3 py-2 text-notion-text-muted text-[10px]">
                      {formatLastRun(s?.lastRunAt ?? null)}
                    </td>
                    <td className="px-2 py-2 text-right">
                      <div className="inline-flex items-center gap-0.5">
                        <button
                          onClick={(e) => handleEdit(e, task.id)}
                          className="w-6 h-6 inline-flex items-center justify-center text-notion-text-muted hover:text-notion-text-primary hover:bg-notion-border rounded"
                          title={t('actionHints.edit')}
                          aria-label={t('actionHints.edit')}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 20h9" />
                            <path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4 12.5-12.5z" />
                          </svg>
                        </button>
                        <button
                          onClick={(e) => handleDelete(e, task)}
                          className="w-6 h-6 inline-flex items-center justify-center text-notion-text-muted hover:text-notion-danger hover:bg-red-50 rounded"
                          title={t('actionHints.delete')}
                          aria-label={t('actionHints.delete')}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                            <path d="M10 11v6M14 11v6" />
                            <path d="M9 6V4a2 2 0 012-2h2a2 2 0 012 2v2" />
                          </svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {showCleanup && (
        <TaskCleanupModal
          tasks={tasks}
          stats={stats}
          onClose={() => setShowCleanup(false)}
          onDone={() => {
            setShowCleanup(false)
            loadData()
          }}
        />
      )}
    </div>
  )
}
