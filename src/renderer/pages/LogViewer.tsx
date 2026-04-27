import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ExecutionLog, AiLog, TaskDefinition } from '../lib/types'
import * as api from '../lib/api'
import { ExecutionLogItem } from '../components/ExecutionLogList'

function AiLogItem({ log }: { log: AiLog }) {
  const [expanded, setExpanded] = useState(false)
  const { t, i18n } = useTranslation('logViewer')

  const typeLabel = log.type === 'generation' ? t('typeLabel.generation') : t('typeLabel.fix')
  const statusColor =
    log.status === 'approved'
      ? 'text-notion-success'
      : log.status === 'rejected'
      ? 'text-notion-danger'
      : 'text-notion-warning'

  const locale = i18n.language === 'ja' ? 'ja-JP' : 'en-US'

  return (
    <div className="border border-notion-border rounded overflow-hidden">
      <div
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 p-2 hover:bg-notion-hover cursor-pointer"
      >
        <span className="text-xs">{typeLabel}</span>
        <span className="text-xs text-notion-text-primary flex-1">{log.taskId}</span>
        {log.stepId && (
          <span className="text-[10px] text-notion-text-muted">{log.stepId}</span>
        )}
        <span className="text-[10px] text-notion-text-muted">{log.provider}/{log.model}</span>
        {log.tokensUsed && (
          <span className="text-[10px] text-notion-text-muted">{log.tokensUsed.toLocaleString()} tok</span>
        )}
        <span className={`text-[10px] font-medium ${statusColor}`}>{log.status}</span>
        <span className="text-[10px] text-notion-text-muted">
          {new Date(log.createdAt).toLocaleString(locale)}
        </span>
      </div>

      {expanded && (
        <div className="border-t border-notion-border bg-white p-2.5">
          <pre className="text-[10px] font-mono whitespace-pre-wrap text-notion-text-secondary max-h-60 overflow-auto">
            {log.response}
          </pre>
        </div>
      )}
    </div>
  )
}

export default function LogViewer() {
  const [tab, setTab] = useState<'execution' | 'ai'>('execution')
  const [execLogs, setExecLogs] = useState<ExecutionLog[]>([])
  const [aiLogs, setAiLogs] = useState<AiLog[]>([])
  const [tasks, setTasks] = useState<TaskDefinition[]>([])
  const { t } = useTranslation('logViewer')

  // Load tasks once for name resolution
  useEffect(() => {
    api.listTasks().then(setTasks).catch(console.error)
  }, [])

  useEffect(() => {
    if (tab === 'execution') {
      api.listExecutions().then(setExecLogs).catch(console.error)
    } else {
      api.listAiLogs().then(setAiLogs).catch(console.error)
    }
  }, [tab])

  const taskNameMap = new Map(tasks.map((t) => [t.id, t.name]))

  return (
    <div>
      <h1 className="text-base font-semibold text-notion-text-primary mb-3">{t('title')}</h1>

      {/* Tabs */}
      <div className="flex gap-1 mb-3 border-b border-notion-border">
        <button
          onClick={() => setTab('execution')}
          className={`px-2 py-1 text-xs font-medium border-b-2 -mb-px ${
            tab === 'execution'
              ? 'border-notion-accent text-notion-accent'
              : 'border-transparent text-notion-text-muted hover:text-notion-text-secondary'
          }`}
        >
          {t('tabs.execution')}
        </button>
        <button
          onClick={() => setTab('ai')}
          className={`px-2 py-1 text-xs font-medium border-b-2 -mb-px ${
            tab === 'ai'
              ? 'border-notion-accent text-notion-accent'
              : 'border-transparent text-notion-text-muted hover:text-notion-text-secondary'
          }`}
        >
          {t('tabs.ai')}
        </button>
      </div>

      {/* Content */}
      {tab === 'execution' ? (
        <div className="space-y-2">
          {execLogs.length === 0 ? (
            <p className="text-center py-12 text-notion-text-muted text-xs">
              {t('empty.execution')}
            </p>
          ) : (
            execLogs.map((log) => (
              <ExecutionLogItem
                key={log.id}
                log={log}
                taskName={taskNameMap.get(log.taskId) ?? null}
              />
            ))
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {aiLogs.length === 0 ? (
            <p className="text-center py-12 text-notion-text-muted text-xs">
              {t('empty.ai')}
            </p>
          ) : (
            aiLogs.map((log) => <AiLogItem key={log.id} log={log} />)
          )}
        </div>
      )}
    </div>
  )
}
