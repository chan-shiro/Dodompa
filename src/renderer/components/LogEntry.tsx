import type { StepLog } from '../lib/types'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as api from '../lib/api'

interface LogEntryProps {
  log: StepLog
}

export default function LogEntry({ log }: LogEntryProps) {
  const [screenshot, setScreenshot] = useState<string | null>(null)
  const [showScreenshot, setShowScreenshot] = useState(false)
  const { t } = useTranslation('logViewer')

  const handleViewScreenshot = async () => {
    if (!log.screenshotPath) return
    if (!screenshot) {
      const data = await api.readScreenshot(log.screenshotPath)
      setScreenshot(data)
    }
    setShowScreenshot(!showScreenshot)
  }

  const statusIcon =
    log.status === 'success' ? '✅' : log.status === 'failed' ? '❌' : '⏳'

  const duration =
    log.finishedAt && log.startedAt
      ? Math.round(
          (new Date(log.finishedAt).getTime() - new Date(log.startedAt).getTime()) / 1000
        )
      : null

  return (
    <div className="border-l-2 border-notion-border pl-3 py-2">
      <div className="flex items-center gap-2">
        <span>{statusIcon}</span>
        <span className="text-xs font-medium text-notion-text-primary">{log.stepId}</span>
        {duration !== null && (
          <span className="text-[10px] text-notion-text-muted">{duration}s</span>
        )}
        {log.screenshotPath && (
          <button
            onClick={handleViewScreenshot}
            className="text-[10px] text-notion-accent hover:underline"
          >
            {t('executionLogs.screenshotLink')}
          </button>
        )}
      </div>

      {log.error && (
        <p className="text-[10px] text-notion-danger mt-1 font-mono">{log.error}</p>
      )}

      {showScreenshot && screenshot && (
        <div className="mt-2">
          <img
            src={screenshot}
            alt="Screenshot"
            className="max-w-full rounded border border-notion-border"
            style={{ maxHeight: 300 }}
          />
        </div>
      )}
    </div>
  )
}
