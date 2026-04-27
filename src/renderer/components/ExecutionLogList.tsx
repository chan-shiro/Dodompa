import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ExecutionLog, StepLog } from '../lib/types'
import * as api from '../lib/api'

export function ScreenshotThumb({
  path: filePath,
  label,
}: {
  path: string | null
  label: string
}) {
  const [src, setSrc] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (filePath) {
      api.readScreenshot(filePath).then(setSrc).catch(() => setSrc(null))
    }
  }, [filePath])

  if (!src) return null

  return (
    <div className="inline-block">
      <div className="text-[10px] text-notion-text-muted mb-0.5">{label}</div>
      <img
        src={src}
        alt={label}
        onClick={() => setExpanded(!expanded)}
        className={`rounded border border-notion-border cursor-pointer transition-all ${
          expanded ? 'max-w-full' : 'max-w-[160px] max-h-[90px]'
        } object-cover`}
      />
    </div>
  )
}

function SharedStateView({ json }: { json: string | null }) {
  const [expanded, setExpanded] = useState(false)
  const { t } = useTranslation('logViewer')

  if (!json) return null

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }

  const keys = Object.keys(parsed)
  if (keys.length === 0) return null

  return (
    <div className="mt-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-[10px] text-notion-text-muted hover:text-notion-text-secondary flex items-center gap-1"
      >
        <span>{expanded ? '▼' : '▶'}</span>
        <span>{t('executionLogs.sharedState', { count: keys.length })}</span>
      </button>
      {expanded && (
        <pre className="mt-1 px-2 py-1.5 bg-neutral-50 border border-notion-border rounded text-[10px] font-mono text-notion-text-secondary max-h-40 overflow-auto whitespace-pre-wrap">
          {JSON.stringify(parsed, null, 2)}
        </pre>
      )}
    </div>
  )
}

export function StepLogDetail({ sl }: { sl: StepLog }) {
  const [expanded, setExpanded] = useState(false)
  const { t, i18n } = useTranslation('logViewer')
  const locale = i18n.language === 'ja' ? 'ja-JP' : 'en-US'

  const duration =
    sl.finishedAt && sl.startedAt
      ? Math.round(
          (new Date(sl.finishedAt).getTime() - new Date(sl.startedAt).getTime()) / 1000
        )
      : null

  const statusIcon =
    sl.status === 'success' ? '✅' : sl.status === 'failed' ? '❌' : '⏳'

  return (
    <div className="border-t border-notion-border/50">
      <div
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 px-3 py-1.5 hover:bg-notion-hover/50 cursor-pointer"
      >
        <span className="text-xs">{statusIcon}</span>
        <span className="text-xs text-notion-text-primary font-medium min-w-[60px]">
          {sl.stepId}
        </span>
        {sl.stepDescription && (
          <span className="text-[10px] text-notion-text-secondary truncate flex-1">
            {sl.stepDescription}
          </span>
        )}
        {!sl.stepDescription && <span className="flex-1" />}
        {sl.pageTitle && (
          <span className="text-[10px] text-notion-text-muted truncate max-w-[200px]">
            {sl.pageTitle}
          </span>
        )}
        {duration !== null && (
          <span className="text-[10px] text-notion-text-muted tabular-nums">{duration}s</span>
        )}
        <span className="text-[10px] text-notion-text-muted">{expanded ? '▼' : '▶'}</span>
      </div>

      {expanded && (
        <div className="px-3 py-2 bg-neutral-50/50 space-y-2">
          {(sl.pageUrl || sl.pageTitle) && (
            <div className="flex flex-col gap-0.5">
              {sl.pageTitle && (
                <div className="text-[10px]">
                  <span className="text-notion-text-muted">{t('executionLogs.page')} </span>
                  <span className="text-notion-text-primary">{sl.pageTitle}</span>
                </div>
              )}
              {sl.pageUrl && (
                <div className="text-[10px] text-notion-text-muted truncate">{sl.pageUrl}</div>
              )}
            </div>
          )}

          <div className="flex gap-4 text-[10px] text-notion-text-muted">
            <span>{t('executionLogs.started', { time: new Date(sl.startedAt).toLocaleTimeString(locale) })}</span>
            {sl.finishedAt && (
              <span>{t('executionLogs.finished', { time: new Date(sl.finishedAt).toLocaleTimeString(locale) })}</span>
            )}
            {duration !== null && <span>{t('executionLogs.duration', { seconds: duration })}</span>}
          </div>

          {sl.error && (
            <div className="px-2 py-1.5 bg-red-50 border border-red-200 rounded text-[10px] text-notion-danger font-mono whitespace-pre-wrap">
              {sl.error}
            </div>
          )}

          {(sl.screenshotBeforePath || sl.screenshotPath) && (
            <div className="flex gap-3 flex-wrap">
              <ScreenshotThumb path={sl.screenshotBeforePath} label={t('executionLogs.before')} />
              <ScreenshotThumb
                path={sl.screenshotPath}
                label={sl.status === 'failed' ? t('executionLogs.afterFailure') : t('executionLogs.afterSuccess')}
              />
            </div>
          )}

          <SharedStateView json={sl.sharedState} />
        </div>
      )}
    </div>
  )
}

export function ExecutionLogItem({
  log,
  taskName,
}: {
  log: ExecutionLog
  taskName: string | null
}) {
  const [expanded, setExpanded] = useState(false)
  const [stepLogs, setStepLogs] = useState<StepLog[]>([])
  const { t, i18n } = useTranslation('logViewer')
  const locale = i18n.language === 'ja' ? 'ja-JP' : 'en-US'

  const handleExpand = async () => {
    if (!expanded && stepLogs.length === 0) {
      const logs = await api.getStepLogs(log.id)
      setStepLogs(logs)
    }
    setExpanded(!expanded)
  }

  const statusIcon =
    log.status === 'success' ? '✅' : log.status === 'failed' ? '❌' : '⏳'

  const duration =
    log.finishedAt && log.startedAt
      ? Math.round(
          (new Date(log.finishedAt).getTime() - new Date(log.startedAt).getTime()) / 1000
        )
      : null

  let variables: Record<string, string> | null = null
  if (log.variables) {
    try {
      variables = JSON.parse(log.variables)
    } catch { /* ignore */ }
  }

  return (
    <div className="border border-notion-border rounded overflow-hidden">
      <div
        onClick={handleExpand}
        className="flex items-center gap-2 p-2 hover:bg-notion-hover cursor-pointer"
      >
        <span>{statusIcon}</span>
        {taskName && (
          <span className="text-xs font-medium text-notion-text-primary">
            {taskName}
          </span>
        )}
        {variables && Object.keys(variables).length > 0 && (
          <span className="text-[10px] text-notion-text-muted">
            ({Object.entries(variables).map(([k, v]) => `${k}=${v}`).join(', ')})
          </span>
        )}
        <span className="flex-1" />
        <span className="text-[10px] text-notion-text-muted">
          {new Date(log.startedAt).toLocaleString(locale)}
        </span>
        {duration !== null && (
          <span className="text-[10px] text-notion-text-muted">({duration}s)</span>
        )}
        <span className="text-notion-text-muted text-xs">{expanded ? '▼' : '▶'}</span>
      </div>

      {expanded && (
        <div className="border-t border-notion-border bg-white">
          {log.error && (
            <div className="px-3 py-1.5 bg-red-50 text-[10px] text-notion-danger border-b border-red-100">
              {log.error}
            </div>
          )}
          {stepLogs.length === 0 ? (
            <div className="px-3 py-2 text-xs text-notion-text-muted">
              {t('executionLogs.noStepLogs')}
            </div>
          ) : (
            stepLogs.map((sl) => <StepLogDetail key={sl.id} sl={sl} />)
          )}
        </div>
      )}
    </div>
  )
}

/**
 * List of executions scoped to a single task. Used by the per-task log tab.
 * When `taskId` is omitted, shows all executions (used by the standalone log viewer).
 */
export default function ExecutionLogList({
  taskId,
  taskName,
}: {
  taskId: string
  taskName?: string | null
}) {
  const [logs, setLogs] = useState<ExecutionLog[]>([])
  const [loading, setLoading] = useState(true)
  const { t } = useTranslation('logViewer')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api.listExecutions(taskId)
      .then((data) => { if (!cancelled) setLogs(data) })
      .catch(() => { /* ignore */ })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [taskId])

  const stats = {
    total: logs.length,
    success: logs.filter((l) => l.status === 'success').length,
    failed: logs.filter((l) => l.status === 'failed').length,
  }

  const suffix = stats.total > 0 ? t('executionLogs.countSuffix', { success: stats.success, failed: stats.failed }) : ''

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-sm font-semibold text-notion-text-muted uppercase tracking-wider">
          {t('executionLogs.heading')}
        </h2>
        <span className="text-[10px] text-notion-text-muted">
          {t('executionLogs.count', { total: stats.total, suffix })}
        </span>
      </div>

      {loading ? (
        <div className="px-3 py-4 text-xs text-notion-text-muted text-center">{t('executionLogs.loading')}</div>
      ) : logs.length === 0 ? (
        <div className="px-3 py-4 text-xs text-notion-text-muted text-center border border-dashed border-notion-border rounded">
          {t('executionLogs.empty')}
        </div>
      ) : (
        <div className="space-y-2">
          {logs.map((log) => (
            <ExecutionLogItem key={log.id} log={log} taskName={taskName ?? null} />
          ))}
        </div>
      )}
    </div>
  )
}
