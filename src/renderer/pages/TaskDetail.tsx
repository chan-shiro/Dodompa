import { useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import type { TaskDefinition, StepMeta, StepProgressEvent } from '../lib/types'
import * as api from '../lib/api'
import { useCompositionGuard } from '../lib/hooks'
import StepCard from '../components/StepCard'
import AiFixModal from '../components/AiFixModal'
import TaskRefactorModal from '../components/TaskRefactorModal'
import VariableEditor from '../components/VariableEditor'
import ExecutionLogList from '../components/ExecutionLogList'
import TaskGeneration from './TaskGeneration'
import type { VariableDefinition } from '../lib/types'

// ─── Generation Log History ───

interface GenerationStepLog {
  id: string
  task_id: string
  step_id: string | null
  phase: string
  message: string
  detail: string | null
  screenshot_path: string | null
  created_at: string
}

function GenerationLogModal({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const { t } = useTranslation('taskDetail')
  const [logs, setLogs] = useState<GenerationStepLog[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    api.getGenerationLogs(taskId)
      .then((data) => { if (!cancelled) { setLogs(data); setLoaded(true) } })
      .catch(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [taskId])

  const phaseLabel = (phase: string) => {
    switch (phase) {
      case 'planning': return 'PLAN'
      case 'analyzing': return 'ANALYZE'
      case 'selector': return 'SELECT'
      case 'generating': return 'GEN'
      case 'executing': return 'EXEC'
      case 'verifying': return 'VERIFY'
      case 'fixing': return 'FIX'
      case 'error': return 'ERR'
      case 'done': return 'DONE'
      default: return phase.toUpperCase()
    }
  }

  const phaseColor = (phase: string) => {
    switch (phase) {
      case 'planning': return 'text-blue-500'
      case 'analyzing': return 'text-cyan-500'
      case 'selector': return 'text-indigo-500'
      case 'generating': return 'text-purple-500'
      case 'executing': return 'text-yellow-600'
      case 'verifying': return 'text-teal-500'
      case 'fixing': return 'text-orange-500'
      case 'error': return 'text-red-500'
      case 'done': return 'text-green-500'
      default: return 'text-neutral-500'
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-[90vw] h-[85vh] max-w-6xl rounded-lg overflow-hidden shadow-2xl flex flex-col bg-neutral-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2 bg-neutral-800 border-b border-neutral-700">
          <div className="flex items-center gap-3">
            <span className="text-xs text-neutral-300 font-mono">{t('generationLog.title')}</span>
            {loaded && (
              <span className="text-[10px] text-neutral-500">{t('generationLog.count', { count: logs.length })}</span>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-white text-sm px-2 py-0.5 rounded hover:bg-neutral-700"
          >
            {t('generationLog.close')}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto bg-neutral-950">
          {!loaded ? (
            <div className="px-3 py-6 text-xs text-neutral-500 text-center">{t('generationLog.loading')}</div>
          ) : logs.length === 0 ? (
            <div className="px-3 py-6 text-xs text-neutral-500 text-center">{t('generationLog.empty')}</div>
          ) : (
            <div className="divide-y divide-neutral-800">
              {logs.map((log) => (
                <GenLogRow key={log.id} log={log} phaseLabel={phaseLabel} phaseColor={phaseColor} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function GenLogRow({
  log,
  phaseLabel,
  phaseColor,
}: {
  log: GenerationStepLog
  phaseLabel: (p: string) => string
  phaseColor: (p: string) => string
}) {
  const { t, i18n } = useTranslation('taskDetail')
  const locale = i18n.language === 'ja' ? 'ja-JP' : 'en-US'
  const [expanded, setExpanded] = useState(false)
  const [screenshotSrc, setScreenshotSrc] = useState<string | null>(null)

  const hasDetail = !!(log.detail || log.screenshot_path)

  const loadScreenshot = () => {
    if (log.screenshot_path && !screenshotSrc) {
      api.readScreenshot(log.screenshot_path).then(setScreenshotSrc).catch(() => {})
    }
  }

  return (
    <div className="bg-neutral-950">
      <div
        onClick={() => {
          if (hasDetail) {
            setExpanded(!expanded)
            if (!expanded) loadScreenshot()
          }
        }}
        className={`flex items-start gap-2 px-4 py-1.5 ${hasDetail ? 'cursor-pointer hover:bg-neutral-900' : ''}`}
      >
        <span className={`${phaseColor(log.phase)} font-mono text-[10px] shrink-0 w-14 text-right mt-px font-medium`}>
          [{phaseLabel(log.phase)}]
        </span>
        <span className="text-[11px] text-neutral-300 flex-1 break-all leading-snug whitespace-pre-wrap font-mono">
          {log.message}
        </span>
        <span className="text-[9px] text-neutral-600 shrink-0 mt-px font-mono">
          {new Date(log.created_at).toLocaleTimeString(locale)}
        </span>
        {hasDetail && (
          <span className="text-[9px] text-neutral-500 shrink-0 mt-px">
            {expanded ? '▼' : '▶'}
          </span>
        )}
      </div>

      {expanded && hasDetail && (
        <div className="px-4 py-2 bg-neutral-900 border-t border-neutral-800 space-y-2">
          {log.detail && (
            <pre className="text-[10px] font-mono text-neutral-300 max-h-[300px] overflow-auto whitespace-pre-wrap break-all bg-neutral-950 border border-neutral-800 rounded p-2">
              {log.detail.length > 8000 ? log.detail.slice(0, 8000) + '\n...(truncated)' : log.detail}
            </pre>
          )}
          {screenshotSrc && (
            <div>
              <img
                src={screenshotSrc}
                alt="Screenshot"
                className="max-w-[400px] max-h-[250px] rounded border border-neutral-700 cursor-pointer hover:border-neutral-500"
                onClick={(e) => {
                  e.stopPropagation()
                  const w = window.open('', '_blank', 'width=1024,height=768')
                  if (w) w.document.write(`<img src="${screenshotSrc}" style="max-width:100%">`)
                }}
              />
              <span className="text-[9px] text-neutral-500 mt-0.5 block">{t('generationLog.clickToZoom')}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Instruction Modal ───

function InstructionModal({
  task,
  onClose,
  onSave,
}: {
  task: TaskDefinition
  onClose: () => void
  onSave: (instruction: string) => Promise<void>
}) {
  const { t } = useTranslation('taskDetail')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(task.instruction ?? '')
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave(draft)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-[90vw] max-w-3xl max-h-[85vh] rounded-lg overflow-hidden shadow-2xl flex flex-col bg-white"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-notion-border">
          <h3 className="text-sm font-semibold text-notion-text-primary">{t('instruction.title')}</h3>
          <button
            onClick={onClose}
            className="text-notion-text-muted hover:text-notion-text-primary text-sm px-2 py-0.5 rounded hover:bg-notion-hover"
          >
            {t('instruction.close')}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {task.initialInstruction && (
            <div>
              <div className="text-[10px] text-notion-text-muted uppercase tracking-wider mb-1 font-medium">
                {t('instruction.initial')}
                {task.initialInstructionAt && (
                  <span className="ml-2 normal-case tracking-normal">
                    {new Date(task.initialInstructionAt).toLocaleString()}
                  </span>
                )}
              </div>
              <p className="text-xs text-notion-text-secondary whitespace-pre-wrap bg-notion-bg-secondary/50 border border-notion-border rounded px-3 py-2">
                {task.initialInstruction}
              </p>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-1">
              <div className="text-[10px] text-notion-text-muted uppercase tracking-wider font-medium">
                {task.initialInstruction && task.instruction !== task.initialInstruction
                  ? t('instruction.latest')
                  : t('instruction.current')}
              </div>
              {!editing && (
                <button
                  onClick={() => { setDraft(task.instruction ?? ''); setEditing(true) }}
                  className="text-[10px] text-notion-accent hover:underline"
                >
                  {t('instruction.edit')}
                </button>
              )}
            </div>
            {editing ? (
              <>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  className="w-full text-xs text-notion-text-secondary bg-notion-bg-secondary border border-notion-border rounded px-3 py-2 outline-none resize-none"
                  rows={8}
                  autoFocus
                />
                <div className="flex gap-2 mt-2">
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="px-3 py-1 bg-notion-accent text-white text-xs rounded hover:bg-neutral-700 disabled:opacity-50"
                  >
                    {saving ? t('instruction.saving') : t('instruction.save')}
                  </button>
                  <button
                    onClick={() => { setEditing(false); setDraft(task.instruction ?? '') }}
                    className="px-3 py-1 text-xs text-notion-text-secondary hover:bg-notion-hover rounded"
                  >
                    {t('instruction.cancel')}
                  </button>
                </div>
              </>
            ) : task.instruction ? (
              <p className="text-xs text-notion-text-secondary whitespace-pre-wrap bg-notion-bg-secondary/50 border border-notion-border rounded px-3 py-2">
                {task.instruction}
              </p>
            ) : (
              <p className="text-xs text-notion-text-muted italic">{t('instruction.empty')}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Storage Section (always expanded) ───

function StorageSection({ taskId }: { taskId: string }) {
  const { t } = useTranslation('taskDetail')
  const [info, setInfo] = useState<api.StorageInfo | null>(null)
  const [cleaning, setCleaning] = useState(false)

  const load = useCallback(async () => {
    const data = await api.getStorageInfo(taskId)
    setInfo(data)
  }, [taskId])

  useEffect(() => {
    setInfo(null)
    load()
  }, [taskId, load])

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const handleCleanup = async (keepRecent: number) => {
    const confirmMsg =
      keepRecent === 0
        ? t('storage.confirmAll')
        : t('storage.confirmOld', { keep: keepRecent })
    if (!confirm(confirmMsg)) return
    setCleaning(true)
    try {
      await api.cleanupOldData(taskId, keepRecent)
      await load()
    } finally {
      setCleaning(false)
    }
  }

  return (
    <div className="mb-4">
      <h2 className="text-sm font-semibold text-notion-text-muted uppercase tracking-wider mb-2">
        {t('storage.title')}
      </h2>
      {!info ? (
        <div className="px-3 py-2 text-xs text-notion-text-muted">{t('storage.loading')}</div>
      ) : (
        <div className="p-3 bg-notion-bg-secondary rounded border border-notion-border text-xs">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1">
            <div className="text-notion-text-muted">{t('storage.screenshots')}</div>
            <div>{t('storage.screenshotsValue', { count: info.screenshotCount, size: formatBytes(info.screenshotBytes) })}</div>
            <div className="text-notion-text-muted">{t('storage.executions')}</div>
            <div>{t('storage.executionsValue', { count: info.executionCount, steps: info.stepLogCount })}</div>
            <div className="text-notion-text-muted">{t('storage.generationLogs')}</div>
            <div>{t('storage.generationLogsValue', { count: info.generationLogCount })}</div>
            <div className="text-notion-text-muted">{t('storage.aiLogs')}</div>
            <div>{t('storage.aiLogsValue', { count: info.aiLogCount })}</div>
          </div>
          <div className="mt-3 pt-2 border-t border-notion-border flex items-center gap-2 flex-wrap">
            <button
              onClick={() => handleCleanup(5)}
              disabled={cleaning}
              className="px-2 py-1 text-[11px] text-notion-text-secondary border border-notion-border rounded hover:bg-notion-hover disabled:opacity-40"
            >
              {cleaning ? t('storage.cleanupOldBusy') : t('storage.cleanupOld')}
            </button>
            <button
              onClick={() => handleCleanup(0)}
              disabled={cleaning}
              className="px-2 py-1 text-[11px] text-notion-danger border border-notion-danger/30 rounded hover:bg-red-50 disabled:opacity-40"
            >
              {t('storage.cleanupAll')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function TaskDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { t } = useTranslation('taskDetail')
  const [task, setTask] = useState<TaskDefinition | null>(null)
  const [activeTab, setActiveTab] = useState<'detail' | 'logs'>('detail')
  const [showGenLogModal, setShowGenLogModal] = useState(false)
  const [showInstructionModal, setShowInstructionModal] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [editingDesc, setEditingDesc] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [running, setRunning] = useState(false)
  const [runProgress, setRunProgress] = useState<Record<string, string>>({})
  // Live AI fix output: current streaming tokens + recent status messages
  const [fixStream, setFixStream] = useState<{ stepId: string; buffer: string; message: string } | null>(null)
  const [showVarModal, setShowVarModal] = useState(false)
  const [variables, setVariables] = useState<Record<string, string>>({})
  const [showFixModal, setShowFixModal] = useState(false)
  const [fixStepId, setFixStepId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Element Picker result
  const [pickedElement, setPickedElement] = useState<api.ElementPickerResult | null>(null)

  // Runner login state
  const [runnerLoginInfo, setRunnerLoginInfo] = useState<{
    executionId: string
    stepId: string
    message: string
  } | null>(null)

  // Debug session state
  const [debugSessionActive, setDebugSessionActive] = useState(false)
  const [debugTargetStepId, setDebugTargetStepId] = useState<string | null>(null)

  // AI generation state
  const [showGenerate, setShowGenerate] = useState(false)
  const [genInstruction, setGenInstruction] = useState('')
  const [genGoal, setGenGoal] = useState('')
  const [generating, setGenerating] = useState(false)
  const [generatingDesc, setGeneratingDesc] = useState(false)
  const { compositionProps, isComposing } = useCompositionGuard()

  const loadTask = useCallback(async () => {
    if (!id) return
    const t = await api.getTask(id)
    setTask(t)
    setName(t.name)
    setDescription(t.description)
  }, [id])

  useEffect(() => {
    loadTask()
    // Clear stale state when switching tasks
    setError(null)
    setRunProgress({})
    setRunnerLoginInfo(null)
  }, [loadTask])

  useEffect(() => {
    const unsub = api.onStepProgress((event: StepProgressEvent) => {
      // Filter: only process events for the currently displayed task
      if (event.taskId && event.taskId !== id) return

      // Stream deltas: accumulate into fix stream buffer
      if (event.streamDelta) {
        setFixStream((prev) => {
          if (prev && prev.stepId === event.stepId) {
            return { ...prev, buffer: prev.buffer + event.streamDelta }
          }
          return { stepId: event.stepId, buffer: event.streamDelta ?? '', message: '' }
        })
        return
      }

      setRunProgress((prev) => ({ ...prev, [event.stepId]: event.status }))

      // When a new status message arrives, reset stream buffer and show message
      if (event.message) {
        setFixStream({ stepId: event.stepId, buffer: '', message: event.message })
      }

      if (event.status === 'failed' && event.error) {
        setError(event.error)
      }
      if (event.status === 'success') {
        // Clear stream after short delay so user sees the success message
        setTimeout(() => setFixStream(null), 2000)
      }
      if (event.status === 'waitingForLogin') {
        setRunnerLoginInfo({
          executionId: event.executionId,
          stepId: event.stepId,
          message: event.message ?? t('aiMessage'),
        })
      } else if (event.status === 'running' || event.status === 'success') {
        setRunnerLoginInfo(null)
      }
    })
    return unsub
  }, [id])

  // Element Picker listener
  useEffect(() => {
    let dismissTimer: ReturnType<typeof setTimeout> | null = null
    const unsub = api.onElementPickerResult((result) => {
      if (dismissTimer) clearTimeout(dismissTimer)
      setPickedElement(result)
      // Don't auto-dismiss while in picking mode (waiting for click)
      if (!result.picking) {
        dismissTimer = setTimeout(() => setPickedElement(null), 60000)
      }
    })
    return () => {
      unsub()
      if (dismissTimer) clearTimeout(dismissTimer)
    }
  }, [])

  const handleSaveName = async () => {
    if (!task) return
    await api.updateTask(task.id, { name })
    setEditingName(false)
    loadTask()
  }

  const handleSaveDesc = async () => {
    if (!task) return
    await api.updateTask(task.id, { description })
    setEditingDesc(false)
    loadTask()
  }

  const handleSaveInstruction = async (nextInstruction: string) => {
    if (!task) return
    await api.updateTask(task.id, { instruction: nextInstruction })
    loadTask()
  }

  const handleRun = async (fromStep?: string) => {
    if (!task) return
    setRunning(true)
    setRunProgress({})
    setError(null)
    try {
      await api.executeTask(task.id, variables, fromStep)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setRunning(false)
      loadTask()
    }
  }

  const handleDebug = async (stepId: string) => {
    if (!task) return
    // End any existing debug session first
    if (debugSessionActive) {
      try { await api.endDebugSession(task.id) } catch { /* */ }
    }
    setRunning(true)
    setRunProgress({})
    setError(null)
    setDebugTargetStepId(stepId)
    try {
      await api.debugStep(task.id, variables, stepId)
      setDebugSessionActive(true)
    } catch (err) {
      setError((err as Error).message)
      setDebugSessionActive(false)
      setDebugTargetStepId(null)
    } finally {
      setRunning(false)
      loadTask()
    }
  }

  const handleRerunDebug = async () => {
    if (!task || !debugTargetStepId) return
    setRunning(true)
    setRunProgress((prev) => ({ ...prev, [debugTargetStepId]: 'running' }))
    setError(null)
    try {
      await api.rerunDebugStep(task.id, debugTargetStepId)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setRunning(false)
      loadTask()
    }
  }

  const handleEndDebug = async () => {
    if (!task) return
    try {
      await api.endDebugSession(task.id)
    } catch { /* */ }
    setDebugSessionActive(false)
    setDebugTargetStepId(null)
  }

  const handleDelete = async () => {
    if (!task || !confirm(t('confirmDelete'))) return
    await api.deleteTask(task.id)
    navigate('/tasks')
  }

  const handleGenerateDescription = async () => {
    if (!task) return
    setGeneratingDesc(true)
    try {
      const desc = await api.generateDescription(task.id)
      setDescription(desc)
      await api.updateTask(task.id, { description: desc })
      loadTask()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setGeneratingDesc(false)
    }
  }

  const [activeGenInstruction, setActiveGenInstruction] = useState<string | null>(null)
  const [genMinimized, setGenMinimized] = useState(false)
  const [showRefactor, setShowRefactor] = useState(false)

  const handleGenerate = async () => {
    if (!task || !genInstruction.trim()) return
    // Save goal to task if provided
    if (genGoal.trim()) {
      await api.updateTask(task.id, { goal: genGoal.trim() })
    }
    setActiveGenInstruction(genInstruction)
    setShowGenerate(false)
    setGenInstruction('')
    setGenGoal('')
  }

  const handleRefactorApplied = async (affectedStepIds: string[]) => {
    setShowRefactor(false)
    if (!task) return
    // Refresh so the new code is reflected in the UI
    await loadTask()
    if (affectedStepIds.length === 0) return
    // Find the earliest affected step by order, and start a debug session
    // that runs up to (and including) that step so the user can verify.
    const freshTask = await api.getTask(task.id)
    const stepOrder = new Map(freshTask.steps.map((s, i) => [s.id, i]))
    const sortedIds = [...affectedStepIds].sort(
      (a, b) => (stepOrder.get(a) ?? 1e9) - (stepOrder.get(b) ?? 1e9)
    )
    const firstChangedStep = sortedIds[0]
    if (!firstChangedStep) return

    // Prefill variable defaults for the debug run
    const debugVars: Record<string, string> = { ...variables }
    freshTask.variables.forEach((v) => {
      if (v.default && !debugVars[v.key]) debugVars[v.key] = v.default
    })
    setVariables(debugVars)

    // End any stale debug session before starting a new one
    if (debugSessionActive) {
      try { await api.endDebugSession(task.id) } catch { /* ignore */ }
    }
    setRunning(true)
    setRunProgress({})
    setError(null)
    setDebugTargetStepId(firstChangedStep)
    try {
      await api.debugStep(task.id, debugVars, firstChangedStep)
      setDebugSessionActive(true)
    } catch (err) {
      setError((err as Error).message)
      setDebugSessionActive(false)
      setDebugTargetStepId(null)
    } finally {
      setRunning(false)
      loadTask()
    }
  }

  const handleDeleteStep = async (stepId: string) => {
    if (!task) return
    if (!confirm(t('confirmDeleteStep'))) return
    await api.deleteStep(task.id, stepId)
    loadTask()
  }

  const handleDeleteAllSteps = async () => {
    if (!task) return
    if (!confirm(t('confirmDeleteAllSteps', { count: task.steps.length }))) return
    await api.deleteAllSteps(task.id)
    loadTask()
  }

  const handleRequestFix = (stepId: string) => {
    setFixStepId(stepId)
    setShowFixModal(true)
  }

  if (!task) {
    return <div className="text-notion-text-muted">{t('loading')}</div>
  }

  return (
    <div>
      {/* Task name */}
      <div className="mb-1">
        {editingName ? (
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={handleSaveName}
            onKeyDown={(e) => e.key === 'Enter' && !isComposing() && handleSaveName()}
            {...compositionProps}
            className="text-base font-semibold w-full bg-transparent border-none outline-none text-notion-text-primary"
            autoFocus
          />
        ) : (
          <h1
            onClick={() => setEditingName(true)}
            className="text-base font-semibold text-notion-text-primary cursor-text hover:bg-notion-hover/50 rounded px-1 -mx-1"
          >
            {typeof task.name === 'string' ? task.name : String(task.name?.name ?? task.name ?? '')}
          </h1>
        )}
      </div>

      {/* Description */}
      <div className="mb-4 group/desc">
        {editingDesc ? (
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={handleSaveDesc}
            className="w-full text-xs text-notion-text-secondary bg-transparent border-none outline-none resize-none"
            placeholder={t('addDescription')}
            rows={2}
            autoFocus
          />
        ) : (
          <div className="flex items-start gap-2">
            <p
              onClick={() => setEditingDesc(true)}
              className="text-xs text-notion-text-muted cursor-text hover:bg-notion-hover/50 rounded px-1 -mx-1 py-1 flex-1"
            >
              {task.description || t('descriptionEmpty')}
            </p>
            <button
              onClick={handleGenerateDescription}
              disabled={generatingDesc}
              className="shrink-0 px-1.5 py-0.5 text-[10px] text-notion-text-muted border border-notion-border rounded hover:bg-notion-hover opacity-0 group-hover/desc:opacity-100 transition-opacity disabled:opacity-50"
              title={t('generateDescriptionTitle')}
            >
              {generatingDesc ? t('generateDescriptionGenerating') : t('generateDescription')}
            </button>
          </div>
        )}
      </div>

      {/* Tab header */}
      <div className="flex items-center gap-1 mb-4 border-b border-notion-border">
        <button
          onClick={() => setActiveTab('detail')}
          className={`px-3 py-1.5 text-xs font-medium rounded-t ${
            activeTab === 'detail'
              ? 'text-notion-text-primary border-b-2 border-notion-accent -mb-px'
              : 'text-notion-text-muted hover:text-notion-text-secondary'
          }`}
        >
          {t('tabs.detail')}
        </button>
        <button
          onClick={() => setActiveTab('logs')}
          className={`px-3 py-1.5 text-xs font-medium rounded-t ${
            activeTab === 'logs'
              ? 'text-notion-text-primary border-b-2 border-notion-accent -mb-px'
              : 'text-notion-text-muted hover:text-notion-text-secondary'
          }`}
        >
          {t('tabs.logs')}
        </button>
      </div>

      {/* Action bar */}
      <div className="flex items-center gap-2 mb-3">
        <button
          onClick={() => {
            if (task.variables.length > 0) {
              // Pre-fill defaults
              const defaults: Record<string, string> = {}
              task.variables.forEach(v => {
                if (v.default && !variables[v.key]) defaults[v.key] = v.default
              })
              if (Object.keys(defaults).length > 0) setVariables(prev => ({ ...defaults, ...prev }))
              setShowVarModal(true)
            } else {
              handleRun()
            }
          }}
          disabled={running || task.steps.length === 0}
          className="px-2 py-1 bg-notion-accent text-white text-xs rounded hover:bg-neutral-700 disabled:opacity-50"
        >
          {running ? t('runNowBusy') : t('runNow')}
        </button>
        <button
          onClick={() => {
            setShowGenerate(true)
            setGenGoal(task?.goal ?? '')
          }}
          className="px-2 py-1 border border-notion-border text-xs rounded hover:bg-notion-hover"
        >
          {t('generateStep')}
        </button>
        <button
          onClick={() => setShowRefactor(true)}
          disabled={task.steps.length === 0}
          className="px-2 py-1 border border-notion-border text-xs rounded hover:bg-notion-hover disabled:opacity-40"
          title={t('refactorTitle')}
        >
          {t('refactor')}
        </button>
        <button
          onClick={() => setShowInstructionModal(true)}
          className="px-2 py-1 border border-notion-border text-xs rounded hover:bg-notion-hover"
          title={t('instructionBtnTitle')}
        >
          {t('instructionBtn')}
        </button>
        <button
          onClick={() => setShowGenLogModal(true)}
          className="px-2 py-1 border border-notion-border text-xs rounded hover:bg-notion-hover"
          title={t('logBtnTitle')}
        >
          {t('logBtn')}
        </button>
        <button
          onClick={async () => {
            if (!task) return
            const result = await api.exportTask(task.id)
            if (result.success) {
              setError(null)
            }
          }}
          className="px-2 py-1 border border-notion-border text-xs rounded hover:bg-notion-hover"
          title={t('exportTitle')}
        >
          {t('export')}
        </button>
        <button
          onClick={handleDelete}
          className="ml-auto px-2 py-1 text-xs text-notion-danger hover:bg-red-50 rounded"
        >
          {t('delete')}
        </button>
      </div>

      {/* Runner login prompt */}
      {runnerLoginInfo && (
        <div className="mb-3 p-3 bg-amber-50 border border-amber-300 rounded flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-amber-800">{t('loginRequired')}</p>
            <p className="text-[10px] text-amber-600 mt-0.5">
              {t('loginHint')}
            </p>
          </div>
          <button
            onClick={() => {
              api.confirmRunnerLogin(runnerLoginInfo.executionId)
              setRunnerLoginInfo(null)
            }}
            className="px-3 py-1.5 bg-amber-500 text-white text-xs font-medium rounded hover:bg-amber-600 shrink-0 ml-3"
          >
            {t('loginDone')}
          </button>
        </div>
      )}

      {/* Error display */}
      {error && (
        <div className="mb-3 p-2 bg-red-50 border border-red-200 rounded text-xs text-notion-danger">
          {error}
        </div>
      )}

      {/* AI fix live output */}
      {fixStream && (fixStream.message || fixStream.buffer) && (
        <div className="mb-3 p-2 bg-blue-50 border border-blue-200 rounded text-xs">
          {fixStream.message && (
            <div className="font-medium text-blue-800 mb-1">{fixStream.message}</div>
          )}
          {fixStream.buffer && (
            <pre className="font-mono text-[10px] text-blue-900 whitespace-pre-wrap max-h-48 overflow-y-auto bg-white/70 p-2 rounded">
              {fixStream.buffer}
              <span className="animate-pulse">▊</span>
            </pre>
          )}
          {fixStream.buffer && (
            <div className="mt-1 text-[10px] text-blue-600">
              {t('aiOutputLabel', { count: fixStream.buffer.length.toLocaleString() })}
            </div>
          )}
        </div>
      )}

      {/* Debug session banner */}
      {debugSessionActive && debugTargetStepId && (
        <div className="mb-3 p-2 bg-yellow-50 border border-yellow-300 rounded flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs">
            <span>🐛</span>
            <span className="font-medium">{t('debugMode')}</span>
            <span className="text-notion-text-muted">
              {t('debugStep', { description: task.steps.find(s => s.id === debugTargetStepId)?.description ?? debugTargetStepId })}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleRerunDebug}
              disabled={running}
              className="px-2 py-1 bg-yellow-500 text-white text-xs font-medium rounded hover:bg-yellow-600 disabled:opacity-50"
            >
              {t('debugRerun')}
            </button>
            <button
              onClick={handleEndDebug}
              className="px-2 py-1 border border-yellow-400 text-xs rounded hover:bg-yellow-100"
            >
              {t('debugEnd')}
            </button>
          </div>
        </div>
      )}

      {activeTab === 'detail' && (
      <>
      {/* Variables (parameters) */}
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-notion-text-muted uppercase tracking-wider mb-2">
          {t('parameters', { count: task.variables.length })}
        </h2>
        <VariableEditor
          taskId={task.id}
          variables={task.variables}
          onChange={async (vars: VariableDefinition[]) => {
            await api.updateTask(task.id, { variables: vars })
            loadTask()
          }}
        />
      </div>

      {/* Steps */}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-notion-text-muted uppercase tracking-wider">
            {t('steps.heading', { count: task.steps.length })}
          </h2>
          {task.steps.length > 0 && (
            <button
              onClick={handleDeleteAllSteps}
              className="px-2 py-0.5 text-[10px] text-notion-danger hover:bg-red-50 rounded"
            >
              {t('steps.deleteAll')}
            </button>
          )}
        </div>
        {task.steps.length === 0 ? (
          <div className="text-center py-8 border border-dashed border-notion-border rounded text-notion-text-muted text-xs">
            <p>{t('steps.empty')}</p>
            <button
              onClick={async () => { await api.addStep(task.id); loadTask() }}
              className="mt-3 px-3 py-1.5 text-xs border border-dashed border-notion-border rounded hover:bg-notion-hover hover:text-notion-text-secondary"
            >
              {t('steps.addStep')}
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {task.steps.map((step) => (
              <StepCard
                key={step.id}
                taskId={task.id}
                step={step}
                runStatus={runProgress[step.id]}
                onRunFrom={() => handleRun(step.id)}
                onRerunDebug={debugSessionActive && debugTargetStepId === step.id ? () => handleRerunDebug() : undefined}
                debugActive={debugSessionActive && debugTargetStepId === step.id}
                onRequestFix={() => handleRequestFix(step.id)}
                onDelete={() => handleDeleteStep(step.id)}
                onUpdateTimeout={async (stepId, timeoutMs) => {
                  if (!task) return
                  const nextSteps = task.steps.map((s) =>
                    s.id === stepId ? { ...s, timeoutMs } : s
                  )
                  await api.updateTask(task.id, { steps: nextSteps })
                  loadTask()
                }}
              />
            ))}
            <button
              onClick={async () => { await api.addStep(task.id); loadTask() }}
              className="w-full py-2 border border-dashed border-notion-border rounded text-xs text-notion-text-muted hover:bg-notion-hover hover:text-notion-text-secondary"
            >
              {t('steps.addStep')}
            </button>
          </div>
        )}
      </div>

      {/* Schedule */}
      {task.schedule && (
        <div className="text-xs text-notion-text-secondary">
          <span className="font-medium">{t('schedule.label')}</span>{' '}
          <code className="bg-notion-hover px-2 py-0.5 rounded">{task.schedule}</code>
        </div>
      )}
      </>
      )}

      {activeTab === 'logs' && (
      <>
        {/* Storage Info (always expanded, on top) */}
        <StorageSection key={task.id} taskId={task.id} />

        {/* Execution Logs with screenshots (per-task scope) */}
        <ExecutionLogList taskId={task.id} taskName={task.name} />
      </>
      )}

      {/* Variable input modal */}
      {showVarModal && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-[420px]">
            <div className="px-4 py-3 border-b border-notion-border flex items-center justify-between">
              <h3 className="text-sm font-semibold">{t('runDialog.title')}</h3>
              <button onClick={() => setShowVarModal(false)} className="text-notion-text-muted hover:text-notion-text-primary">✕</button>
            </div>
            <div className="p-4 space-y-3">
              {task.variables.map((v) => (
                <div key={v.key}>
                  <label className="block text-xs font-medium text-notion-text-primary mb-1">
                    {v.label || v.key}
                    {v.required && <span className="text-notion-danger ml-1">*</span>}
                    <code className="ml-2 text-[10px] text-notion-text-muted font-mono bg-notion-hover px-1 rounded">ctx.input.{v.key}</code>
                  </label>
                  <input
                    type={v.type === 'secret' ? 'password' : 'text'}
                    value={variables[v.key] ?? ''}
                    onChange={(e) => setVariables((prev) => ({ ...prev, [v.key]: e.target.value }))}
                    placeholder={v.default ? t('runDialog.defaultHint', { value: v.type === 'secret' ? '••••' : v.default }) : ''}
                    className="w-full px-2 py-1.5 border border-notion-border rounded text-xs focus:outline-none focus:ring-1 focus:ring-notion-accent"
                    onKeyDown={e => { if (e.key === 'Enter' && !isComposing()) { setShowVarModal(false); handleRun() } }}
                    {...compositionProps}
                  />
                </div>
              ))}
            </div>
            <div className="px-4 py-3 border-t border-notion-border flex gap-2">
              <button
                onClick={() => {
                  // Apply defaults for empty required fields
                  const finalVars = { ...variables }
                  task.variables.forEach(v => {
                    if (!finalVars[v.key] && v.default) finalVars[v.key] = v.default
                  })
                  setVariables(finalVars)
                  setShowVarModal(false)
                  handleRun()
                }}
                disabled={task.variables.filter(v => v.required).some(v => !variables[v.key] && !v.default)}
                className="px-3 py-1.5 bg-notion-accent text-white text-xs rounded hover:bg-neutral-700 disabled:opacity-40"
              >
                {t('runDialog.run')}
              </button>
              <button
                onClick={() => setShowVarModal(false)}
                className="px-3 py-1.5 text-xs text-notion-text-secondary hover:bg-notion-hover rounded"
              >
                {t('runDialog.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* AI Generation modal */}
      {showGenerate && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white rounded shadow-xl p-4 w-[500px]">
            <h3 className="text-sm font-semibold mb-3">{t('generateDialog.title')}</h3>
            <label className="text-[10px] text-notion-text-muted uppercase tracking-wider font-medium block mb-1">
              {t('generateDialog.instruction')}
            </label>
            <textarea
              value={genInstruction}
              onChange={(e) => setGenInstruction(e.target.value)}
              placeholder={t('generateDialog.instructionPlaceholder')}
              className="w-full px-2 py-1.5 border border-notion-border rounded text-xs h-32 resize-none focus:outline-none focus:ring-2 focus:ring-notion-accent/30"
              autoFocus
            />
            <div className="mt-3">
              <label className="text-[10px] text-notion-text-muted uppercase tracking-wider font-medium block mb-1">
                {t('generateDialog.goal')}
              </label>
              <textarea
                value={genGoal}
                onChange={(e) => setGenGoal(e.target.value)}
                placeholder={t('generateDialog.goalPlaceholder')}
                className="w-full px-2 py-1.5 border border-notion-border rounded text-xs h-16 resize-none focus:outline-none focus:ring-2 focus:ring-notion-accent/30"
              />
            </div>
            <div className="flex gap-2 mt-3">
              <button
                onClick={handleGenerate}
                disabled={!genInstruction.trim()}
                className="px-2 py-1 bg-notion-accent text-white text-xs rounded hover:bg-neutral-700 disabled:opacity-50"
              >
                {t('generateDialog.start')}
              </button>
              <button
                onClick={() => {
                  setShowGenerate(false)
                  setGenInstruction('')
                  setGenGoal('')
                }}
                className="px-2 py-1 text-xs text-notion-text-secondary hover:bg-notion-hover rounded"
              >
                {t('generateDialog.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Task Refactor Modal */}
      {showRefactor && task && (
        <TaskRefactorModal
          currentTask={task}
          onClose={() => setShowRefactor(false)}
          onApplied={handleRefactorApplied}
        />
      )}

      {/* AI Fix Modal */}
      {showFixModal && fixStepId && task && (
        <AiFixModal
          taskId={task.id}
          stepId={fixStepId}
          step={task.steps.find((s) => s.id === fixStepId)!}
          onClose={() => {
            setShowFixModal(false)
            setFixStepId(null)
            loadTask()
          }}
        />
      )}

      {/* Generation Log Modal */}
      {showGenLogModal && (
        <GenerationLogModal taskId={task.id} onClose={() => setShowGenLogModal(false)} />
      )}

      {/* Instruction Modal */}
      {showInstructionModal && (
        <InstructionModal
          task={task}
          onClose={() => setShowInstructionModal(false)}
          onSave={handleSaveInstruction}
        />
      )}

      {/* AI Generation — stays mounted when minimized to preserve logs */}
      {activeGenInstruction && task && (
        <>
          {/* Minimized bar — click to restore */}
          {genMinimized && (
            <div
              onClick={() => setGenMinimized(false)}
              className="fixed bottom-4 right-4 z-40 px-4 py-2 bg-neutral-900 border border-neutral-600 rounded-lg shadow-xl cursor-pointer hover:bg-neutral-800 flex items-center gap-2"
            >
              <span className="inline-block w-2 h-2 rounded-full bg-green-400 animate-pulse" />
              <span className="text-xs text-neutral-300">{t('streamBanner.running')}</span>
              <span className="text-[10px] text-neutral-500">{t('streamBanner.clickToOpen')}</span>
            </div>
          )}
          {/* Full panel — hidden but mounted when minimized */}
          <div className={genMinimized ? 'hidden' : ''}>
            <TaskGeneration
              taskId={task.id}
              instruction={activeGenInstruction}
              onClose={(mode) => {
                if (mode === 'background') {
                  setGenMinimized(true)
                } else {
                  setActiveGenInstruction(null)
                  setGenMinimized(false)
                  loadTask()
                }
              }}
            />
          </div>
        </>
      )}

      {/* Element Picker Result */}
      {pickedElement && (
        <div className="fixed bottom-4 left-4 z-50 w-96 bg-white border border-notion-border rounded-lg shadow-xl overflow-hidden">
          <div className="px-3 py-2 bg-notion-sidebar border-b border-notion-border flex items-center justify-between">
            <span className="text-xs font-semibold text-notion-text-primary">{t('picker.title')}</span>
            <div className="flex gap-1">
              <button
                onClick={() => {
                  const el = pickedElement.element
                  if (!el) return
                  const text = `role: ${el.role}\ntitle: ${el.title}\npath: ${el.path}\nposition: (${el.position?.x}, ${el.position?.y})\nsize: ${el.size?.width}x${el.size?.height}\napp: ${pickedElement.app}\npid: ${pickedElement.pid}`
                  navigator.clipboard.writeText(text)
                }}
                className="px-1.5 py-0.5 text-[10px] text-notion-text-muted hover:bg-notion-hover rounded"
              >
                {t('picker.copy')}
              </button>
              <button
                onClick={() => setPickedElement(null)}
                className="px-1.5 py-0.5 text-[10px] text-notion-text-muted hover:text-notion-text-primary"
              >
                ✕
              </button>
            </div>
          </div>
          <div className="p-3 text-xs space-y-1">
            {pickedElement.picking ? (
              <div className="flex items-center gap-2 py-2">
                <span className="inline-block w-2 h-2 rounded-full bg-orange-400 animate-pulse" />
                <span className="text-notion-text-secondary">{t('picker.waiting')}</span>
              </div>
            ) : pickedElement.error ? (
              <p className="text-notion-danger">{t('picker.error', { message: pickedElement.error })}</p>
            ) : pickedElement.element ? (
              <>
                <div className="flex gap-2">
                  <span className="text-notion-text-muted w-12 shrink-0">App:</span>
                  <span className="font-mono">{pickedElement.app ?? '?'} (PID: {pickedElement.pid})</span>
                </div>
                <div className="flex gap-2">
                  <span className="text-notion-text-muted w-12 shrink-0">Role:</span>
                  <span className="font-mono text-blue-600">{pickedElement.element.role}</span>
                </div>
                <div className="flex gap-2">
                  <span className="text-notion-text-muted w-12 shrink-0">Title:</span>
                  <span className="font-mono">{pickedElement.element.title ?? t('picker.none')}</span>
                </div>
                {pickedElement.element.value && (
                  <div className="flex gap-2">
                    <span className="text-notion-text-muted w-12 shrink-0">Value:</span>
                    <span className="font-mono truncate">{pickedElement.element.value}</span>
                  </div>
                )}
                <div className="flex gap-2">
                  <span className="text-notion-text-muted w-12 shrink-0">Pos:</span>
                  <span className="font-mono">({pickedElement.element.position?.x}, {pickedElement.element.position?.y}) {pickedElement.element.size?.width}x{pickedElement.element.size?.height}</span>
                </div>
                <div className="flex gap-2">
                  <span className="text-notion-text-muted w-12 shrink-0">Path:</span>
                  <span className="font-mono text-[10px]">{pickedElement.element.path}</span>
                </div>
                {pickedElement.element.actions.length > 0 && (
                  <div className="flex gap-2">
                    <span className="text-notion-text-muted w-12 shrink-0">Actions:</span>
                    <span className="font-mono text-[10px]">{pickedElement.element.actions.join(', ')}</span>
                  </div>
                )}
              </>
            ) : (
              <p className="text-notion-text-muted">{t('picker.noElement', { x: pickedElement.point.x, y: pickedElement.point.y })}</p>
            )}
            <p className="text-[10px] text-notion-text-muted pt-1 border-t border-notion-border mt-2">
              {t('picker.hint')}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
