import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TaskDefinition } from '../lib/types'
import * as api from '../lib/api'

type Category = 'never' | 'empty' | 'failing' | 'dormant'

interface Suggestion {
  category: Category
  task: TaskDefinition
  stat: api.TaskStats | undefined
  /** Pre-rendered reason shown to the user. */
  reason: string
}

interface TaskCleanupModalProps {
  tasks: TaskDefinition[]
  stats: Record<string, api.TaskStats>
  onClose: () => void
  onDone: () => void
}

const DORMANT_DAYS = 30
const FAILING_MIN_RUNS = 3
const FAILING_RATIO = 0.5

const categoryMeta: Record<Category, { icon: string; color: string }> = {
  empty: { icon: '📭', color: 'text-notion-text-muted' },
  never: { icon: '🆕', color: 'text-blue-600' },
  failing: { icon: '❌', color: 'text-notion-danger' },
  dormant: { icon: '💤', color: 'text-notion-warning' },
}

function useClassifyTask() {
  const { t } = useTranslation('cleanupModal')

  return (task: TaskDefinition, stat: api.TaskStats | undefined): Suggestion | null => {
    const total = stat?.total ?? 0
    const failed = stat?.failed ?? 0

    // Priority order: empty > never > failing > dormant (first match wins)
    if (task.steps.length === 0) {
      return {
        category: 'empty',
        task,
        stat,
        reason: t('categories.empty.reason'),
      }
    }
    if (total === 0) {
      return {
        category: 'never',
        task,
        stat,
        reason: t('categories.never.reason'),
      }
    }
    if (total >= FAILING_MIN_RUNS && failed / total >= FAILING_RATIO) {
      const pct = Math.round((failed / total) * 100)
      return {
        category: 'failing',
        task,
        stat,
        reason: t('categories.failing.reason', { total, failed, pct }),
      }
    }
    if (stat?.lastRunAt) {
      const diffDays = Math.floor(
        (Date.now() - new Date(stat.lastRunAt).getTime()) / (1000 * 60 * 60 * 24)
      )
      if (diffDays >= DORMANT_DAYS) {
        return {
          category: 'dormant',
          task,
          stat,
          reason: t('categories.dormant.reason', { days: diffDays }),
        }
      }
    }
    return null
  }
}

function useFormatDate() {
  const { i18n } = useTranslation()
  const locale = i18n.language === 'ja' ? 'ja-JP' : 'en-US'
  return (iso: string | null | undefined): string => {
    if (!iso) return '—'
    try {
      return new Date(iso).toLocaleDateString(locale)
    } catch {
      return '—'
    }
  }
}

export default function TaskCleanupModal({
  tasks,
  stats,
  onClose,
  onDone,
}: TaskCleanupModalProps) {
  const { t } = useTranslation('cleanupModal')
  const classifyTask = useClassifyTask()
  const formatDate = useFormatDate()
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const grouped = useMemo(() => {
    const groups: Record<Category, Suggestion[]> = {
      empty: [],
      never: [],
      failing: [],
      dormant: [],
    }
    for (const task of tasks) {
      const s = classifyTask(task, stats[task.id])
      if (s) groups[s.category].push(s)
    }
    return groups
    // classifyTask is stable per-render; inputs are tasks/stats.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, stats])

  const total =
    grouped.empty.length + grouped.never.length + grouped.failing.length + grouped.dormant.length

  const toggle = (taskId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }

  const toggleCategory = (category: Category) => {
    const ids = grouped[category].map((s) => s.task.id)
    const allSelected = ids.every((id) => selectedIds.has(id))
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (allSelected) {
        ids.forEach((id) => next.delete(id))
      } else {
        ids.forEach((id) => next.add(id))
      }
      return next
    })
  }

  const selectAll = () => {
    const all = new Set<string>()
    Object.values(grouped).forEach((list) =>
      list.forEach((s) => all.add(s.task.id))
    )
    setSelectedIds(all)
  }

  const clearSelection = () => setSelectedIds(new Set())

  const handleDelete = async () => {
    if (selectedIds.size === 0) return
    if (!confirm(t('confirmDelete', { count: selectedIds.size }))) return
    setDeleting(true)
    setError(null)
    try {
      for (const id of selectedIds) {
        await api.deleteTask(id)
      }
      onDone()
    } catch (err) {
      setError((err as Error).message || t('deleteFailed'))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl w-[720px] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-notion-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-notion-text-primary">{t('title')}</h3>
            {total > 0 && (
              <span className="text-[10px] text-notion-text-muted">
                {t('candidates', { count: total })}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-notion-text-muted hover:text-notion-text-primary text-lg leading-none"
          >
            {t('close')}
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4 space-y-4">
          {total === 0 ? (
            <div className="text-center py-12">
              <p className="text-3xl mb-2">{t('emptyIcon')}</p>
              <p className="text-sm text-notion-text-primary font-medium">{t('emptyTitle')}</p>
              <p className="text-xs text-notion-text-muted mt-1">
                {t('emptyHint')}
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 text-[10px]">
                <button
                  onClick={selectAll}
                  className="px-2 py-0.5 border border-notion-border rounded hover:bg-notion-hover"
                >
                  {t('selectAll')}
                </button>
                <button
                  onClick={clearSelection}
                  className="px-2 py-0.5 border border-notion-border rounded hover:bg-notion-hover"
                >
                  {t('clearSelection')}
                </button>
                <span className="ml-auto text-notion-text-muted">
                  {t('selectedCount', { count: selectedIds.size })}
                </span>
              </div>

              {(['empty', 'never', 'failing', 'dormant'] as Category[]).map((cat) => {
                const items = grouped[cat]
                if (items.length === 0) return null
                const meta = categoryMeta[cat]
                const ids = items.map((s) => s.task.id)
                const allSelected = ids.every((id) => selectedIds.has(id))
                const someSelected = ids.some((id) => selectedIds.has(id))
                const label = t(`categories.${cat}.label`)
                const description =
                  cat === 'failing'
                    ? t('categories.failing.description', { ratio: FAILING_RATIO * 100, min: FAILING_MIN_RUNS })
                    : cat === 'dormant'
                    ? t('categories.dormant.description', { days: DORMANT_DAYS })
                    : t(`categories.${cat}.description`)
                return (
                  <div key={cat} className="border border-notion-border rounded overflow-hidden">
                    <div className="px-3 py-2 bg-notion-sidebar border-b border-notion-border flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        ref={(el) => { if (el) el.indeterminate = !allSelected && someSelected }}
                        onChange={() => toggleCategory(cat)}
                        className="accent-notion-accent"
                      />
                      <span>{meta.icon}</span>
                      <span className={`text-xs font-medium ${meta.color}`}>{label}</span>
                      <span className="text-[10px] text-notion-text-muted">
                        {t('candidates', { count: items.length })}
                      </span>
                      <span className="text-[10px] text-notion-text-muted ml-auto">
                        {description}
                      </span>
                    </div>
                    <div className="divide-y divide-notion-border/50">
                      {items.map(({ task, stat, reason }) => {
                        const taskName =
                          typeof task.name === 'string'
                            ? task.name
                            : String(task.name ?? '')
                        return (
                          <label
                            key={task.id}
                            className="flex items-center gap-2 px-3 py-1.5 hover:bg-notion-hover/50 cursor-pointer"
                          >
                            <input
                              type="checkbox"
                              checked={selectedIds.has(task.id)}
                              onChange={() => toggle(task.id)}
                              className="accent-notion-accent"
                            />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-medium text-notion-text-primary truncate">
                                  {taskName}
                                </span>
                                <span className="text-[10px] text-notion-text-muted">
                                  {t('stepsLabel', { count: task.steps.length })}
                                </span>
                              </div>
                              <div className="text-[10px] text-notion-text-muted">
                                {reason}
                                {stat?.lastRunAt && cat !== 'never' && (
                                  <span className="ml-2">
                                    {t('lastRunAt', { date: formatDate(stat.lastRunAt) })}
                                  </span>
                                )}
                                {!stat?.lastRunAt && (
                                  <span className="ml-2">
                                    {t('createdAt', { date: formatDate(task.createdAt) })}
                                  </span>
                                )}
                              </div>
                            </div>
                          </label>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </>
          )}

          {error && (
            <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-notion-danger">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-notion-border flex items-center gap-2">
          <button
            onClick={handleDelete}
            disabled={deleting || selectedIds.size === 0}
            className="px-3 py-1.5 bg-notion-danger text-white text-xs rounded hover:opacity-90 disabled:opacity-40"
          >
            {deleting ? t('deleting') : t('deleteSelected', { count: selectedIds.size })}
          </button>
          <button
            onClick={onClose}
            disabled={deleting}
            className="ml-auto px-3 py-1.5 text-xs text-notion-text-secondary hover:bg-notion-hover rounded"
          >
            {t('footerClose')}
          </button>
        </div>
      </div>
    </div>
  )
}
