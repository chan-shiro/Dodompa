import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { StepMeta } from '../lib/types'
import { readStepFile, writeStepFile } from '../lib/api'

interface StepCardProps {
  taskId: string
  step: StepMeta
  runStatus?: string
  onRunFrom: () => void
  onRerunDebug?: () => void
  debugActive?: boolean
  onRequestFix: () => void
  onDelete: () => void
  /** Called when the user edits the per-step timeout override. */
  onUpdateTimeout?: (stepId: string, timeoutMs: number | undefined) => void | Promise<void>
}

const statusColors: Record<string, { bg: string; text: string; labelKey: string }> = {
  stable: { bg: 'bg-green-50', text: 'text-notion-success', labelKey: 'statusLabels.stable' },
  flaky: { bg: 'bg-yellow-50', text: 'text-notion-warning', labelKey: 'statusLabels.flaky' },
  broken: { bg: 'bg-red-50', text: 'text-notion-danger', labelKey: 'statusLabels.broken' },
  untested: { bg: 'bg-gray-100', text: 'text-notion-text-muted', labelKey: 'statusLabels.untested' },
}

const runStatusIcons: Record<string, string> = {
  running: '⏳',
  success: '✅',
  failed: '❌',
}

export default function StepCard({ taskId, step, runStatus, onRunFrom, onRerunDebug, debugActive, onRequestFix, onDelete, onUpdateTimeout }: StepCardProps) {
  const { t, i18n } = useTranslation('stepCard')
  const locale = i18n.language === 'ja' ? 'ja-JP' : 'en-US'
  const statusStyle = statusColors[step.status] ?? statusColors.untested
  const [expanded, setExpanded] = useState(false)
  const [timeoutEditing, setTimeoutEditing] = useState(false)
  const [timeoutDraft, setTimeoutDraft] = useState<string>(
    step.timeoutMs != null ? String(Math.round(step.timeoutMs / 1000)) : ''
  )
  const [code, setCode] = useState<string | null>(null)
  const [editedCode, setEditedCode] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)

  const handleToggle = useCallback(async () => {
    if (!expanded && code === null) {
      setLoading(true)
      try {
        const content = await readStepFile(taskId, step.file)
        setCode(content)
        setEditedCode(content)
      } finally {
        setLoading(false)
      }
    }
    setExpanded(v => !v)
    setEditing(false)
    setSaveMsg(null)
  }, [expanded, code, taskId, step.file])

  const handleSave = useCallback(async () => {
    if (editedCode === null) return
    setSaving(true)
    try {
      await writeStepFile(taskId, step.file, editedCode)
      setCode(editedCode)
      setSaveMsg(t('saved'))
      setEditing(false)
      setTimeout(() => setSaveMsg(null), 2000)
    } catch {
      setSaveMsg(t('saveFailed'))
    } finally {
      setSaving(false)
    }
  }, [editedCode, taskId, step.file, t])

  return (
    <div className="border border-notion-border rounded overflow-hidden">
      {/* Header row */}
      <div
        className="flex items-center gap-2 p-2 hover:bg-notion-hover/50 group cursor-pointer"
        onClick={handleToggle}
      >
        {/* Order number */}
        <span className="w-5 h-5 flex items-center justify-center rounded bg-notion-hover text-[10px] font-medium text-notion-text-secondary flex-shrink-0">
          {step.order}
        </span>

        {/* Run status indicator */}
        {runStatus && (
          <span className="text-xs flex-shrink-0">{runStatusIcons[runStatus] ?? ''}</span>
        )}

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-notion-text-primary truncate">
              {step.description || step.file}
            </span>
            <span
              className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${statusStyle.bg} ${statusStyle.text}`}
            >
              {t(statusStyle.labelKey)}
            </span>
            {step.usesAi && (
              <span
                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-50 text-purple-700 border border-purple-200"
                title={t('usesAiTitle')}
              >
                <span aria-hidden="true">✨</span>
                <span>{t('usesAiBadge')}</span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[10px] text-notion-text-muted">{step.file}</span>
            {step.lastSuccess && (
              <span className="text-[10px] text-notion-text-muted">
                {t('lastSuccess', { date: new Date(step.lastSuccess).toLocaleDateString(locale) })}
              </span>
            )}
            {step.failCount > 0 && (
              <span className="text-[10px] text-notion-danger">{t('failCount', { count: step.failCount })}</span>
            )}
            {step.aiRevisionCount > 0 && (
              <span className="text-[10px] text-notion-accent">{t('aiRevisionCount', { count: step.aiRevisionCount })}</span>
            )}
            {/* Per-step timeout editor */}
            {timeoutEditing ? (
              <span
                className="inline-flex items-center gap-1 text-[10px]"
                onClick={(e) => e.stopPropagation()}
              >
                <span className="text-notion-text-muted">⏱</span>
                <input
                  type="number"
                  min={1}
                  max={3600}
                  value={timeoutDraft}
                  onChange={(e) => setTimeoutDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const n = parseInt(timeoutDraft, 10)
                      const ms = isFinite(n) && n > 0 ? n * 1000 : undefined
                      onUpdateTimeout?.(step.id, ms)
                      setTimeoutEditing(false)
                    } else if (e.key === 'Escape') {
                      setTimeoutDraft(step.timeoutMs != null ? String(Math.round(step.timeoutMs / 1000)) : '')
                      setTimeoutEditing(false)
                    }
                  }}
                  placeholder={t('timeoutPlaceholder')}
                  className="w-12 px-1 py-0 border border-notion-border rounded text-[10px]"
                  autoFocus
                />
                <span className="text-notion-text-muted">{t('timeoutUnit')}</span>
                <button
                  onClick={() => {
                    const n = parseInt(timeoutDraft, 10)
                    const ms = isFinite(n) && n > 0 ? n * 1000 : undefined
                    onUpdateTimeout?.(step.id, ms)
                    setTimeoutEditing(false)
                  }}
                  className="text-notion-accent hover:underline"
                >
                  {t('save').replace('💾 ', '')}
                </button>
                {step.timeoutMs != null && (
                  <button
                    onClick={() => {
                      setTimeoutDraft('')
                      onUpdateTimeout?.(step.id, undefined)
                      setTimeoutEditing(false)
                    }}
                    className="text-notion-danger hover:underline"
                  >
                    {t('reset')}
                  </button>
                )}
              </span>
            ) : (
              <button
                onClick={(e) => { e.stopPropagation(); setTimeoutEditing(true) }}
                className="text-[10px] text-notion-text-muted hover:text-notion-text-secondary hover:underline"
                title={t('timeoutEditTitle')}
              >
                {step.timeoutMs != null
                  ? t('timeout', { seconds: Math.round(step.timeoutMs / 1000) })
                  : t('timeoutDefault')}
              </button>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1">
          <button
            onClick={(e) => { e.stopPropagation(); handleToggle() }}
            className="px-2 py-1 text-xs text-notion-text-secondary hover:bg-notion-hover rounded flex items-center gap-1"
            title={expanded ? t('hideCode') : t('showCode')}
          >
            <span>{expanded ? '▲' : '{ }'}</span>
            <span className="text-[10px]">{expanded ? t('close') : t('code')}</span>
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onRunFrom()
            }}
            className="px-2 py-1 text-xs text-notion-text-secondary hover:bg-notion-hover rounded opacity-0 group-hover:opacity-100"
            title={t('rerunFromHere')}
          >
            ▶
          </button>
          {debugActive && onRerunDebug && (
            <button
              onClick={(e) => { e.stopPropagation(); onRerunDebug() }}
              className="px-2 py-1 text-xs text-yellow-600 bg-yellow-50 hover:bg-yellow-100 rounded font-medium"
              title={t('rerunDebug')}
            >
              🔄
            </button>
          )}
          {(step.status === 'flaky' || step.status === 'broken') && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onRequestFix()
              }}
              className="px-2 py-1 text-xs text-notion-accent hover:bg-blue-50 rounded"
              title={t('aiFix')}
            >
              🔧
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            className="px-2 py-1 text-xs text-notion-danger hover:bg-red-50 rounded opacity-0 group-hover:opacity-100"
            title={t('deleteStep')}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Code panel */}
      {expanded && (
        <div className="border-t border-notion-border bg-[#1e1e1e]">
          {/* Toolbar */}
          <div className="flex items-center justify-between px-3 py-1.5 bg-[#2d2d2d] border-b border-[#444]">
            <div className="flex items-center gap-3">
              <span className="text-[10px] text-gray-400 font-mono">{step.file}</span>
              {editing && (
                <span className="text-[10px] text-yellow-400 font-medium">{t('editing')}</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {saveMsg && (
                <span className="text-[10px] text-gray-300">{saveMsg}</span>
              )}
              {editing ? (
                <>
                  <span className="text-[10px] text-gray-500">{t('saveHint')}</span>
                  <button
                    onClick={() => { setEditing(false); setEditedCode(code) }}
                    className="px-2 py-0.5 text-[10px] text-gray-300 hover:text-white rounded border border-[#555] hover:border-[#888]"
                  >
                    {t('cancel')}
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="px-2 py-0.5 text-[10px] bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50 font-medium"
                  >
                    {saving ? t('saving') : t('save')}
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setEditing(true)}
                  className="px-2.5 py-0.5 text-[10px] bg-[#444] hover:bg-[#555] text-gray-200 hover:text-white rounded border border-[#555] font-medium"
                >
                  {t('edit')}
                </button>
              )}
            </div>
          </div>

          {/* Code body */}
          {loading ? (
            <div className="px-4 py-3 text-xs text-gray-400 font-mono">{t('loading')}</div>
          ) : code === null ? (
            <div className="px-4 py-3 text-xs text-gray-400 font-mono">{t('fileNotFound')}</div>
          ) : editing ? (
            <textarea
              value={editedCode ?? ''}
              onChange={e => setEditedCode(e.target.value)}
              className="w-full bg-[#1e1e1e] text-gray-100 font-mono text-xs p-4 outline-none resize-none border-l-2 border-yellow-500"
              style={{ minHeight: '300px', tabSize: 2 }}
              spellCheck={false}
              autoFocus
              onKeyDown={e => {
                // Cmd+S / Ctrl+S to save
                if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  handleSave()
                  return
                }
                // Tab key inserts 2 spaces
                if (e.key === 'Tab') {
                  e.preventDefault()
                  const ta = e.currentTarget
                  const start = ta.selectionStart
                  const end = ta.selectionEnd
                  const newVal = ta.value.substring(0, start) + '  ' + ta.value.substring(end)
                  setEditedCode(newVal)
                  requestAnimationFrame(() => {
                    ta.selectionStart = ta.selectionEnd = start + 2
                  })
                }
              }}
            />
          ) : (
            <div className="relative group/code">
              <pre className="px-4 py-3 text-xs text-gray-100 font-mono overflow-x-auto whitespace-pre leading-relaxed max-h-[400px] overflow-y-auto">
                {code}
              </pre>
              <button
                onClick={() => setEditing(true)}
                className="absolute top-2 right-2 px-2 py-1 text-[10px] bg-[#333] hover:bg-[#444] text-gray-300 hover:text-white rounded border border-[#555] opacity-0 group-hover/code:opacity-100 transition-opacity"
              >
                {t('edit')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
