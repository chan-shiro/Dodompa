import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { StepMeta, AiFixResult } from '../lib/types'
import * as api from '../lib/api'

interface AiFixModalProps {
  taskId: string
  stepId: string
  step: StepMeta
  onClose: () => void
}

const confidenceColors: Record<string, { bg: string; text: string }> = {
  high: { bg: 'bg-green-50', text: 'text-notion-success' },
  medium: { bg: 'bg-yellow-50', text: 'text-notion-warning' },
  low: { bg: 'bg-red-50', text: 'text-notion-danger' },
}

export default function AiFixModal({ taskId, stepId, step, onClose }: AiFixModalProps) {
  const { t } = useTranslation('aiModal')
  const [analyzing, setAnalyzing] = useState(true)
  const [result, setResult] = useState<(AiFixResult & { aiLogId?: string }) | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    async function analyze() {
      try {
        const fixResult = await api.analyzeAndFix({
          taskId,
          stepId,
          stepCode: '', // Will be loaded from file on backend
          errorMessage: '',
          screenshotPath: '',
          htmlSnapshot: '',
          stepStatus: step.status === 'broken' ? 'broken' : 'flaky',
        })
        setResult(fixResult as AiFixResult & { aiLogId?: string })
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setAnalyzing(false)
      }
    }
    analyze()
  }, [taskId, stepId, step.status])

  const handleApprove = async () => {
    if (!result?.aiLogId) return
    setApplying(true)
    try {
      await api.applyFix(result.aiLogId, true)
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setApplying(false)
    }
  }

  const handleReject = async () => {
    if (!result?.aiLogId) return
    await api.applyFix(result.aiLogId, false)
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
      <div className="bg-white rounded shadow-xl w-[700px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 border-b border-notion-border flex items-center justify-between">
          <h3 className="text-sm font-semibold">{t('fix.title')}</h3>
          <button
            onClick={onClose}
            className="text-notion-text-muted hover:text-notion-text-primary"
          >
            {t('fix.close')}
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {analyzing ? (
            <div className="text-center py-12 text-notion-text-muted">
              <p className="text-sm mb-2">{t('fix.analyzing')}</p>
              <p className="text-xs">{t('fix.analyzingHint')}</p>
            </div>
          ) : error ? (
            <div className="p-2.5 bg-red-50 border border-red-200 rounded text-xs text-notion-danger">
              {error}
            </div>
          ) : result ? (
            <div className="space-y-3">
              {/* Analysis */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <h4 className="text-xs font-medium text-notion-text-primary">{t('fix.analysis')}</h4>
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${
                      confidenceColors[result.confidence]?.bg ?? 'bg-gray-100'
                    } ${confidenceColors[result.confidence]?.text ?? 'text-notion-text-muted'}`}
                  >
                    {t('fix.confidence', { level: result.confidence })}
                  </span>
                </div>
                <p className="text-xs text-notion-text-secondary bg-notion-sidebar p-2 rounded">
                  {result.analysis}
                </p>
              </div>

              {/* Code diff */}
              <div>
                <h4 className="text-xs font-medium text-notion-text-primary mb-2">
                  {t('fix.fixedCode')}
                </h4>
                <div className="border border-notion-border rounded overflow-hidden">
                  <pre className="p-2.5 text-[10px] font-mono bg-gray-50 overflow-x-auto whitespace-pre-wrap">
                    {result.fixedCode}
                  </pre>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {/* Footer */}
        {result && (
          <div className="px-4 py-3 border-t border-notion-border flex items-center gap-2">
            <button
              onClick={handleApprove}
              disabled={applying}
              className="px-2 py-1 bg-notion-success text-white text-xs rounded hover:opacity-90 disabled:opacity-50"
            >
              {applying ? t('fix.applying') : t('fix.approve')}
            </button>
            <button
              onClick={handleReject}
              className="px-2 py-1 text-xs text-notion-text-secondary hover:bg-notion-hover rounded"
            >
              {t('fix.reject')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
