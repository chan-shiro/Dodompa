import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { StepMeta } from '../lib/types'
import * as api from '../lib/api'
import DiffViewer from './DiffViewer'

interface AiEditModalProps {
  taskId: string
  step: StepMeta
  onClose: () => void
  onApplied: () => void
}

type Phase = 'input' | 'generating' | 'review' | 'applying'

export default function AiEditModal({ taskId, step, onClose, onApplied }: AiEditModalProps) {
  const { t } = useTranslation('aiModal')
  const [phase, setPhase] = useState<Phase>('input')
  const [instruction, setInstruction] = useState('')
  const [result, setResult] = useState<{
    editedCode: string
    summary: string
    aiLogId: string
    originalCode: string
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const handleGenerate = async () => {
    if (!instruction.trim()) return
    setPhase('generating')
    setError(null)
    try {
      const res = await api.editStep({ taskId, stepId: step.id, instruction })
      setResult(res)
      setPhase('review')
    } catch (err) {
      setError((err as Error).message)
      setPhase('input')
    }
  }

  const handleApprove = async () => {
    if (!result) return
    setPhase('applying')
    try {
      await api.applyFix(result.aiLogId, true)
      onApplied()
    } catch (err) {
      setError((err as Error).message)
      setPhase('review')
    }
  }

  const handleReject = async () => {
    if (!result) return
    await api.applyFix(result.aiLogId, false)
    onClose()
  }

  const handleBack = () => {
    setPhase('input')
    setResult(null)
    setError(null)
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-[720px] max-h-[85vh] flex flex-col">

        {/* Header */}
        <div className="px-4 py-3 border-b border-notion-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm">✏️</span>
            <h3 className="text-sm font-semibold text-notion-text-primary">{t('edit.title')}</h3>
            <span className="text-[10px] text-notion-text-muted bg-notion-hover px-2 py-0.5 rounded font-mono">
              {step.file}
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-notion-text-muted hover:text-notion-text-primary text-lg leading-none"
          >
            {t('edit.close')}
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4 space-y-4">

          {/* Instruction input (always visible in input/generating phases) */}
          {(phase === 'input' || phase === 'generating') && (
            <div>
              <label className="block text-xs font-medium text-notion-text-primary mb-1.5">
                {t('edit.instruction')}
              </label>
              <textarea
                ref={textareaRef}
                value={instruction}
                onChange={e => setInstruction(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    handleGenerate()
                  }
                }}
                placeholder={t('edit.instructionPlaceholder')}
                disabled={phase === 'generating'}
                className="w-full border border-notion-border rounded p-2.5 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-notion-accent disabled:bg-notion-sidebar disabled:text-notion-text-muted"
                rows={4}
              />
              <p className="text-[10px] text-notion-text-muted mt-1">
                {t('edit.generateHint')}
              </p>
            </div>
          )}

          {/* Generating state */}
          {phase === 'generating' && (
            <div className="text-center py-8 text-notion-text-muted">
              <div className="text-2xl mb-2 animate-pulse">🤖</div>
              <p className="text-sm">{t('edit.generating')}</p>
              <p className="text-xs mt-1">{t('edit.generatingHint')}</p>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="p-2.5 bg-red-50 border border-red-200 rounded text-xs text-notion-danger">
              {t('edit.error', { message: error })}
            </div>
          )}

          {/* Review phase */}
          {phase === 'review' && result && (
            <>
              {/* Summary */}
              <div className="p-3 bg-blue-50 border border-blue-200 rounded">
                <p className="text-xs font-medium text-blue-800 mb-0.5">{t('edit.summary')}</p>
                <p className="text-xs text-blue-700">{result.summary}</p>
              </div>

              {/* Instruction recap */}
              <div className="text-xs text-notion-text-muted bg-notion-sidebar rounded p-2">
                <span className="font-medium">{t('edit.instructionRecap')}</span> {instruction}
              </div>

              {/* Diff */}
              <div>
                <p className="text-xs font-medium text-notion-text-primary mb-1.5">{t('edit.diff')}</p>
                <div className="max-h-[350px] overflow-y-auto">
                  <DiffViewer oldCode={result.originalCode} newCode={result.editedCode} />
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-notion-border flex items-center gap-2">
          {phase === 'input' && (
            <>
              <button
                onClick={handleGenerate}
                disabled={!instruction.trim()}
                className="px-3 py-1.5 bg-notion-accent text-white text-xs rounded hover:opacity-90 disabled:opacity-40"
              >
                {t('edit.generate')}
              </button>
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-xs text-notion-text-secondary hover:bg-notion-hover rounded"
              >
                {t('edit.cancel')}
              </button>
            </>
          )}

          {phase === 'generating' && (
            <span className="text-xs text-notion-text-muted">{t('edit.generatingState')}</span>
          )}

          {phase === 'review' && result && (
            <>
              <button
                onClick={handleApprove}
                className="px-3 py-1.5 bg-notion-success text-white text-xs rounded hover:opacity-90"
              >
                {t('edit.approve')}
              </button>
              <button
                onClick={handleReject}
                className="px-3 py-1.5 text-xs text-notion-text-secondary hover:bg-notion-hover rounded"
              >
                {t('edit.reject')}
              </button>
              <button
                onClick={handleBack}
                className="px-3 py-1.5 text-xs text-notion-text-secondary hover:bg-notion-hover rounded ml-auto"
              >
                {t('edit.back')}
              </button>
            </>
          )}

          {phase === 'applying' && (
            <span className="text-xs text-notion-text-muted">{t('edit.applying')}</span>
          )}
        </div>
      </div>
    </div>
  )
}
