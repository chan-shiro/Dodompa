import { useState, useEffect, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TaskDefinition } from '../lib/types'
import * as api from '../lib/api'
import type { RefactorPlan, RefactorOperation } from '../lib/api'

// ─── Simple line-based diff ───

interface DiffLine {
  type: 'same' | 'add' | 'remove'
  lineOld?: number
  lineNew?: number
  text: string
}

/**
 * Compute a simple line-based diff using the LCS (longest common subsequence) approach.
 * Good enough for code diffs of a few hundred lines.
 */
function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = (oldText || '').split('\n')
  const newLines = (newText || '').split('\n')

  // Build LCS table
  const m = oldLines.length
  const n = newLines.length
  // For very large files, fall back to simple side-by-side
  if (m * n > 500_000) {
    const result: DiffLine[] = []
    for (let i = 0; i < m; i++) result.push({ type: 'remove', lineOld: i + 1, text: oldLines[i] })
    for (let i = 0; i < n; i++) result.push({ type: 'add', lineNew: i + 1, text: newLines[i] })
    return result
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }

  // Backtrack to produce diff
  const result: DiffLine[] = []
  let i = m, j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ type: 'same', lineOld: i, lineNew: j, text: oldLines[i - 1] })
      i--; j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: 'add', lineNew: j, text: newLines[j - 1] })
      j--
    } else {
      result.push({ type: 'remove', lineOld: i, text: oldLines[i - 1] })
      i--
    }
  }
  return result.reverse()
}

function DiffView({ oldCode, newCode }: { oldCode: string; newCode: string }) {
  const { t } = useTranslation('refactorModal')
  const lines = useMemo(() => computeDiff(oldCode, newCode), [oldCode, newCode])

  if (!oldCode && !newCode) {
    return <pre className="px-3 py-2 text-[10px] text-neutral-500 font-mono">{t('noCode')}</pre>
  }

  return (
    <div className="font-mono text-[10px] leading-relaxed">
      {lines.map((line, idx) => {
        const bgColor =
          line.type === 'add' ? 'bg-green-900/30' :
          line.type === 'remove' ? 'bg-red-900/30' : ''
        const textColor =
          line.type === 'add' ? 'text-green-300' :
          line.type === 'remove' ? 'text-red-400' : 'text-neutral-400'
        const prefix =
          line.type === 'add' ? '+' :
          line.type === 'remove' ? '−' : ' '
        const lineNum = line.type === 'remove'
          ? (line.lineOld ?? '').toString().padStart(4)
          : (line.lineNew ?? '').toString().padStart(4)

        return (
          <div key={idx} className={`flex ${bgColor} hover:brightness-110`}>
            <span className="w-10 text-right pr-2 text-neutral-600 select-none shrink-0 border-r border-neutral-700/50">
              {lineNum}
            </span>
            <span className={`pl-1 shrink-0 w-4 select-none ${textColor}`}>{prefix}</span>
            <span className={`flex-1 whitespace-pre ${textColor}`}>{line.text}</span>
          </div>
        )
      })}
    </div>
  )
}

type OpKey = string

const keyOf = (op: RefactorOperation): OpKey =>
  op.op === 'add' ? `add:${op.tempId}` : `${op.op}:${op.stepId}`

interface TaskRefactorModalProps {
  currentTask: TaskDefinition
  onClose: () => void
  /**
   * Called after the user applies the refactor plan. Receives the list of
   * step IDs that were actually modified so the caller can start a debug
   * session targeting the first changed step.
   */
  onApplied: (affectedStepIds: string[]) => void
}

export default function TaskRefactorModal({ currentTask, onClose, onApplied }: TaskRefactorModalProps) {
  const { t } = useTranslation('refactorModal')
  const [instruction, setInstruction] = useState('')
  const [analyzing, setAnalyzing] = useState(false)
  const [progressMessages, setProgressMessages] = useState<string[]>([])
  const [plan, setPlan] = useState<RefactorPlan | null>(null)
  const [acceptedKeys, setAcceptedKeys] = useState<Set<OpKey>>(new Set())
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Live streaming code preview — updated as AI generates each operation's newCode
  const [streamOpIndex, setStreamOpIndex] = useState<number>(-1)
  const [streamCode, setStreamCode] = useState<string>('')
  const [streamStepId, setStreamStepId] = useState<string | undefined>(undefined)
  const [streamKind, setStreamKind] = useState<'newCode' | 'replace' | 'search' | undefined>(undefined)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const streamPreRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
    const unsub = api.onRefactorProgress((event) => {
      if (event.taskId === currentTask.id) {
        setProgressMessages(prev => [...prev, event.message])
      }
    })
    const unsubStream = api.onRefactorStream((event) => {
      if (event.taskId !== currentTask.id) return
      setStreamOpIndex(event.opIndex)
      setStreamStepId(event.stepIdHint)
      setStreamCode(event.code)
      setStreamKind(event.kind)
    })
    return () => { unsub(); unsubStream() }
  }, [currentTask.id])

  // Auto-scroll the streaming preview as new content arrives
  useEffect(() => {
    if (streamPreRef.current) {
      streamPreRef.current.scrollTop = streamPreRef.current.scrollHeight
    }
  }, [streamCode])

  const toggleOp = (key: OpKey) => {
    setAcceptedKeys(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handleAnalyze = async () => {
    if (!instruction.trim()) return
    setAnalyzing(true)
    setError(null)
    setProgressMessages([])
    setStreamOpIndex(-1)
    setStreamCode('')
    setStreamStepId(undefined)
    setStreamKind(undefined)
    try {
      const result = await api.refactorTask({
        taskId: currentTask.id,
        instruction: instruction.trim(),
        referenceTaskIds: [],
      })
      setPlan(result)
      // Pre-accept all proposed operations
      setAcceptedKeys(new Set(result.operations.map(keyOf)))
    } catch (err) {
      setError((err as Error).message || t('errors.analyze'))
    } finally {
      setAnalyzing(false)
    }
  }

  const handleApply = async () => {
    if (!plan) return
    const ops = plan.operations.filter(op => acceptedKeys.has(keyOf(op)))
    if (ops.length === 0) {
      onClose()
      return
    }
    setApplying(true)
    setError(null)
    try {
      // Order: deletes first, then modifies, then adds. Track affected step IDs
      // so the caller can open a debug session starting at the first changed step.
      const affectedIds: string[] = []

      // 1. Deletes
      for (const op of ops) {
        if (op.op === 'delete') {
          await api.deleteStep(currentTask.id, op.stepId)
        }
      }

      // 2. Modifies — write file, bump revision, reset status
      const modifyIds = new Set<string>()
      for (const op of ops) {
        if (op.op === 'modify') {
          await api.writeStepFile(currentTask.id, op.file, op.newCode)
          modifyIds.add(op.stepId)
          affectedIds.push(op.stepId)
        }
      }
      if (modifyIds.size > 0) {
        const fresh = await api.getTask(currentTask.id)
        const nextSteps = fresh.steps.map(s =>
          modifyIds.has(s.id)
            ? { ...s, aiRevisionCount: (s.aiRevisionCount ?? 0) + 1, status: 'untested' as const }
            : s
        )
        await api.updateTask(currentTask.id, { steps: nextSteps })
      }

      // 3. Adds — create a blank step of the right type, overwrite its file
      //    with the AI-generated code, set description, and reorder so it
      //    sits immediately after `afterStepId` (or at the top if null).
      for (const op of ops) {
        if (op.op !== 'add') continue
        const before = await api.addStep(currentTask.id, op.stepType)
        const newStep = before.steps[before.steps.length - 1]
        if (!newStep) continue
        await api.writeStepFile(currentTask.id, newStep.file, op.newCode)

        // Reorder: move the newly appended step to right after op.afterStepId
        const others = before.steps.filter(s => s.id !== newStep.id)
        let insertIndex: number
        if (op.afterStepId === null) {
          insertIndex = 0
        } else {
          const idx = others.findIndex(s => s.id === op.afterStepId)
          insertIndex = idx === -1 ? others.length : idx + 1
        }
        const reordered = [
          ...others.slice(0, insertIndex),
          { ...newStep, description: op.description, status: 'untested' as const, aiRevisionCount: 1 },
          ...others.slice(insertIndex),
        ].map((s, i) => ({ ...s, order: i + 1 }))
        await api.updateTask(currentTask.id, { steps: reordered })
        affectedIds.push(newStep.id)
      }

      onApplied(affectedIds)
    } catch (err) {
      setError((err as Error).message || t('errors.apply'))
    } finally {
      setApplying(false)
    }
  }

  // ── Render helpers ───────────────────────────────────────────

  const renderInputPhase = () => (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      <div>
        <label className="block text-xs font-medium text-notion-text-primary mb-1.5">
          {t('instruction')} <span className="text-notion-danger">{t('instructionRequired')}</span>
        </label>
        <p className="text-[10px] text-notion-text-muted mb-1.5">
          {t('instructionHint')}
        </p>
        <textarea
          ref={textareaRef}
          value={instruction}
          onChange={e => setInstruction(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              handleAnalyze()
            }
          }}
          placeholder={t('instructionPlaceholder')}
          disabled={analyzing}
          className="w-full border border-notion-border rounded p-2.5 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-notion-accent disabled:bg-notion-sidebar disabled:text-notion-text-muted"
          rows={5}
        />
        <p className="text-[10px] text-notion-text-muted mt-1">{t('generateHint')}</p>
      </div>


      {error && (
        <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-notion-danger">
          {error}
        </div>
      )}

      {/* Real-time progress messages */}
      {analyzing && progressMessages.length > 0 && (
        <div className="p-2 bg-blue-50/60 border border-blue-200 rounded text-xs space-y-0.5">
          {progressMessages.map((msg, i) => (
            <p key={i} className="text-notion-text-secondary">{msg}</p>
          ))}
        </div>
      )}

      {/* Live streaming code preview — shown while AI generates newCode or patches */}
      {analyzing && streamCode && (
        <div className="border border-notion-border rounded overflow-hidden">
          <div className="px-2 py-1 text-[10px] bg-[#2d2d2d] text-neutral-300 border-b border-[#444] flex items-center gap-3">
            <span>{t('streamHeader')}</span>
            <span className="text-neutral-500">
              op #{streamOpIndex + 1}
              {streamStepId ? ` · stepId=${streamStepId.slice(0, 12)}…` : ''}
            </span>
            {streamKind && (
              <span className={`px-1 rounded text-[9px] ${
                streamKind === 'newCode' ? 'bg-amber-900/40 text-amber-300' :
                streamKind === 'replace' ? 'bg-green-900/40 text-green-300' :
                'bg-red-900/40 text-red-300'
              }`}>
                {t(`streamLabels.${streamKind}`)}
              </span>
            )}
            <span className="ml-auto text-neutral-500">{t('streamChars', { count: streamCode.length.toLocaleString() })}</span>
          </div>
          <pre
            ref={streamPreRef}
            className="bg-[#1e1e1e] text-neutral-200 text-[10px] font-mono leading-relaxed p-2 overflow-auto whitespace-pre max-h-[260px]"
          >{streamCode}<span className="animate-pulse text-green-400">▊</span></pre>
        </div>
      )}
    </div>
  )

  const renderPreviewPhase = (currentPlan: RefactorPlan) => (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      {/* Rationale */}
      {currentPlan.rationale && (
        <div className="p-2.5 bg-blue-50/60 border border-blue-200 rounded">
          <p className="text-[10px] text-notion-text-muted font-medium mb-1">{t('rationale')}</p>
          <p className="text-xs text-notion-text-secondary whitespace-pre-wrap">{currentPlan.rationale}</p>
        </div>
      )}

      {/* Operation list */}
      {currentPlan.operations.length === 0 ? (
        <div className="p-4 border border-dashed border-notion-border rounded text-center">
          <p className="text-xs text-notion-text-muted">{t('noChanges')}</p>
          <p className="text-[10px] text-notion-text-muted mt-1">{t('noChangesHint')}</p>
        </div>
      ) : (
        <div>
          <p className="text-xs font-medium text-notion-text-primary mb-2">
            {t('summary', { accepted: acceptedKeys.size, total: currentPlan.operations.length })}
          </p>
          <div className="space-y-2">
            {currentPlan.operations.map((op) => {
              const k = keyOf(op)
              return (
                <OperationPreview
                  key={k}
                  operation={op}
                  accepted={acceptedKeys.has(k)}
                  onToggle={() => toggleOp(k)}
                />
              )
            })}
          </div>
        </div>
      )}

      {error && (
        <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-notion-danger">
          {error}
        </div>
      )}
    </div>
  )

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-[780px] max-h-[88vh] flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 border-b border-notion-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span>🔄</span>
            <h3 className="text-sm font-semibold text-notion-text-primary">
              {plan ? t('titlePreview') : t('titleInput')}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="text-notion-text-muted hover:text-notion-text-primary text-lg leading-none"
          >
            {t('close')}
          </button>
        </div>

        {/* Body */}
        {plan ? renderPreviewPhase(plan) : renderInputPhase()}

        {/* Footer */}
        <div className="px-4 py-3 border-t border-notion-border flex items-center gap-2">
          {plan ? (
            <>
              <button
                onClick={handleApply}
                disabled={applying || acceptedKeys.size === 0}
                className="px-3 py-1.5 bg-notion-accent text-white text-xs rounded hover:opacity-90 disabled:opacity-40 flex items-center gap-1.5"
              >
                {applying ? t('applyingCount') : t('applyCount', { count: acceptedKeys.size })}
              </button>
              <button
                onClick={() => { setPlan(null); setAcceptedKeys(new Set()); setError(null) }}
                disabled={applying}
                className="px-3 py-1.5 text-xs text-notion-text-secondary hover:bg-notion-hover rounded"
              >
                {t('back')}
              </button>
              <button
                onClick={onClose}
                disabled={applying}
                className="ml-auto px-3 py-1.5 text-xs text-notion-text-secondary hover:bg-notion-hover rounded"
              >
                {t('cancel')}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={handleAnalyze}
                disabled={!instruction.trim() || analyzing}
                className="px-3 py-1.5 bg-notion-accent text-white text-xs rounded hover:opacity-90 disabled:opacity-40 flex items-center gap-1.5"
              >
                {analyzing ? t('analyzing') : t('analyze')}
              </button>
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-xs text-notion-text-secondary hover:bg-notion-hover rounded"
              >
                {t('cancel')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

const opBadgeCls: Record<RefactorOperation['op'], string> = {
  modify: 'bg-blue-50 text-blue-700 border-blue-200',
  add: 'bg-green-50 text-green-700 border-green-200',
  delete: 'bg-red-50 text-red-700 border-red-200',
}

function OperationPreview({
  operation,
  accepted,
  onToggle,
}: {
  operation: RefactorOperation
  accepted: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation('refactorModal')
  const [expanded, setExpanded] = useState(false)
  const badgeCls = opBadgeCls[operation.op]
  const badgeLabel = t(`opBadges.${operation.op}`)

  const title =
    operation.op === 'add'
      ? operation.description
      : operation.description || (operation.op === 'delete' ? t('op.deletedTitle') : '')

  const subId =
    operation.op === 'add' ? t('op.addedStepSub', { type: operation.stepType }) : operation.stepId

  const originalCode = operation.op === 'add' ? '' : operation.originalCode
  const newCode = operation.op === 'delete' ? '' : operation.newCode
  const canExpand = operation.op !== 'delete' || !!originalCode

  return (
    <div className={`border rounded overflow-hidden ${accepted ? 'border-notion-accent/50' : 'border-notion-border opacity-60'}`}>
      <div className="flex items-center gap-2 px-3 py-2 bg-notion-sidebar">
        <input
          type="checkbox"
          checked={accepted}
          onChange={onToggle}
          className="accent-notion-accent"
        />
        <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded border ${badgeCls}`}>
          {badgeLabel}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-notion-text-muted truncate max-w-[180px]">{subId}</span>
            <span className="text-xs font-medium text-notion-text-primary truncate">
              {title}
            </span>
          </div>
          {operation.summary && (
            <p className="text-[10px] text-notion-text-secondary mt-0.5 whitespace-pre-wrap">
              {operation.summary}
            </p>
          )}
          {operation.op === 'add' && (
            <p className="text-[10px] text-notion-text-muted mt-0.5">
              {operation.afterStepId
                ? t('op.insertAfter', { id: operation.afterStepId.slice(0, 8) })
                : t('op.insertTop')}
            </p>
          )}
        </div>
        {canExpand && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="px-2 py-0.5 text-[10px] text-notion-text-secondary hover:bg-notion-hover rounded border border-notion-border"
          >
            {expanded ? t('diff.collapse') : t('diff.expand')}
          </button>
        )}
      </div>

      {expanded && (
        <div className="bg-[#1e1e1e] max-h-[400px] overflow-auto">
          <div className="px-2 py-1 text-[10px] text-neutral-400 bg-[#2d2d2d] border-b border-[#444] flex items-center gap-3">
            <span>{t('diff.heading')}</span>
            <span className="text-red-400">{t('diff.removed')}</span>
            <span className="text-green-400">{t('diff.added')}</span>
          </div>
          <DiffView oldCode={originalCode} newCode={newCode} />
        </div>
      )}
    </div>
  )
}
