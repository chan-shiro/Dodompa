import { useEffect, useState, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { GenerationAgentKey, GenerationProgressEvent, StepPlan } from '../lib/types'
import * as api from '../lib/api'

interface LogLine {
  id: string
  phase: GenerationProgressEvent['phase']
  text: string
  timestamp: Date
  screenshot?: string   // base64
  html?: string         // HTML snapshot
  messageCode?: string
  messageParams?: Record<string, string | number>
}

interface GenerationStepLog {
  id: string
  task_id: string
  step_id: string | null
  phase: string
  message: string
  detail: string | null
  screenshot_path: string | null
  message_code: string | null
  message_params: string | null
  created_at: string
}

// ─── Agent Flow Strip ───
// Ordered pipeline of sub-agents. The strip highlights which agent is active,
// which are done, and which are upcoming. Displayed below the header for
// always-visible at-a-glance status.

interface AgentStage {
  key: GenerationAgentKey
  label: string
  /** i18n key for the hover description (under taskGeneration.stageDescs) */
  descKey: string
}

/** Per-step pipeline (repeated for each plan step) */
const STEP_PIPELINE: AgentStage[] = [
  { key: 'analyzing',  label: 'ANALYZE',  descKey: 'analyzing' },
  { key: 'actionPlan', label: 'ACTPLAN',  descKey: 'actionPlan' },
  { key: 'selector',   label: 'SELECT',   descKey: 'selector' },
  { key: 'codegen',    label: 'CODE',     descKey: 'codegen' },
  { key: 'executing',  label: 'EXEC',     descKey: 'executing' },
  { key: 'verifying',  label: 'VERIFY',   descKey: 'verifying' },
]

/** Agents that appear during retry / error recovery */
const RETRY_AGENTS: GenerationAgentKey[] = ['fixing', 'replan']

type AgentStatus = 'done' | 'active' | 'upcoming' | 'skipped'

function AgentFlowStrip({
  currentAgent,
  isDone,
  isError,
  currentStepIndex,
  totalSteps,
}: {
  currentAgent: GenerationAgentKey | null
  isDone: boolean
  isError: boolean
  currentStepIndex: number
  totalSteps: number
}) {
  const { t } = useTranslation('taskGeneration')
  // Determine status of each stage
  const getStatus = (stage: AgentStage, idx: number): AgentStatus => {
    if (isDone) return 'done'
    if (!currentAgent) return idx === 0 ? 'active' : 'upcoming'
    if (currentAgent === 'planning') return 'upcoming'

    // Retry/replan → show as active overlay, don't change pipeline state
    if (RETRY_AGENTS.includes(currentAgent)) {
      // during fixing/replan, the last agent that ran was the one before it
      return 'upcoming'
    }

    const curIdx = STEP_PIPELINE.findIndex(s => s.key === currentAgent)
    const stageIdx = idx
    if (curIdx < 0) return 'upcoming'
    if (stageIdx < curIdx) return 'done'
    if (stageIdx === curIdx) return 'active'
    return 'upcoming'
  }

  const statusDot = (status: AgentStatus) => {
    switch (status) {
      case 'done': return '✓'
      case 'active': return '●'
      case 'upcoming': return '○'
      case 'skipped': return '–'
    }
  }

  const statusColor = (status: AgentStatus) => {
    switch (status) {
      case 'done': return 'text-green-400'
      case 'active': return 'text-yellow-300'
      case 'upcoming': return 'text-neutral-600'
      case 'skipped': return 'text-neutral-700'
    }
  }

  const labelColor = (status: AgentStatus) => {
    switch (status) {
      case 'done': return 'text-green-400/70'
      case 'active': return 'text-yellow-200'
      case 'upcoming': return 'text-neutral-600'
      case 'skipped': return 'text-neutral-700'
    }
  }

  const isPlanningActive = currentAgent === 'planning' && !isDone
  const isPlanningDone = currentAgent !== 'planning' || isDone
  const isRetrying = currentAgent != null && RETRY_AGENTS.includes(currentAgent)

  return (
    <div className="flex items-center gap-0 px-3 py-1 bg-neutral-850 border-b border-neutral-700/50 overflow-x-auto">
      {/* PLAN stage */}
      <div className="flex items-center shrink-0" title={t('stageDescs.planning')}>
        <span className={`text-[9px] font-mono ${isPlanningActive ? 'text-yellow-300' : isPlanningDone ? 'text-green-400' : 'text-neutral-600'} ${isPlanningActive ? 'animate-pulse' : ''}`}>
          {isPlanningDone ? '✓' : isPlanningActive ? '●' : '○'}
        </span>
        <span className={`text-[8px] font-mono ml-0.5 ${isPlanningActive ? 'text-yellow-200' : isPlanningDone ? 'text-green-400/70' : 'text-neutral-600'}`}>
          PLAN
        </span>
      </div>

      {/* Separator */}
      <span className="text-neutral-700 text-[8px] mx-1 shrink-0">›</span>

      {/* Step indicator */}
      {totalSteps > 0 && (
        <>
          <span className="text-[8px] font-mono text-neutral-500 shrink-0">
            {t('stepCounter', { current: Math.min(currentStepIndex + 1, totalSteps), total: totalSteps })}
          </span>
          <span className="text-neutral-700 text-[8px] mx-1 shrink-0">:</span>
        </>
      )}

      {/* Per-step pipeline */}
      {STEP_PIPELINE.map((stage, idx) => {
        const status = getStatus(stage, idx)
        const isActive = status === 'active'
        const desc = t(`stageDescs.${stage.descKey}`)
        return (
          <div key={stage.key} className="flex items-center shrink-0">
            {idx > 0 && (
              <span className="text-neutral-700 text-[8px] mx-0.5">›</span>
            )}
            <span className={`text-[9px] font-mono ${statusColor(status)} ${isActive ? 'animate-pulse' : ''}`} title={desc}>
              {statusDot(status)}
            </span>
            <span className={`text-[8px] font-mono ml-0.5 ${labelColor(status)}`} title={desc}>
              {stage.label}
            </span>
          </div>
        )
      })}

      {/* Retry/Replan badge */}
      {isRetrying && (
        <span className="ml-2 px-1.5 py-0 text-[8px] font-mono bg-orange-500/20 text-orange-300 border border-orange-500/30 rounded animate-pulse shrink-0">
          {currentAgent === 'replan' ? '⟳ REPLAN' : '⟳ FIX'}
        </span>
      )}

      {/* Done / Error badge */}
      {isDone && !isError && (
        <span className="ml-2 px-1.5 py-0 text-[8px] font-mono bg-green-500/20 text-green-300 border border-green-500/30 rounded shrink-0">
          ✓ DONE
        </span>
      )}
      {isDone && isError && (
        <span className="ml-2 px-1.5 py-0 text-[8px] font-mono bg-red-500/20 text-red-300 border border-red-500/30 rounded shrink-0">
          ✕ ERROR
        </span>
      )}
    </div>
  )
}

interface TaskGenerationProps {
  taskId: string
  instruction: string
  onClose: (mode?: 'background' | 'close') => void
}

export default function TaskGeneration({ taskId, instruction, onClose }: TaskGenerationProps) {
  const { t, i18n } = useTranslation('taskGeneration')
  const locale = i18n.language === 'ja' ? 'ja-JP' : 'en-US'
  const [logs, setLogs] = useState<LogLine[]>([])
  const [streamBuffer, setStreamBuffer] = useState('')
  const [plan, setPlan] = useState<StepPlan[]>([])
  const [currentPhase, setCurrentPhase] = useState<GenerationProgressEvent['phase']>('planning')
  const [currentStepIndex, setCurrentStepIndex] = useState<number>(-1)
  const [stepStatuses, setStepStatuses] = useState<Record<number, 'pending' | 'generating' | 'executing' | 'fixing' | 'success' | 'error'>>({})
  const [isDone, setIsDone] = useState(false)
  const [waitingForLogin, setWaitingForLogin] = useState(false)
  const [activeQuestion, setActiveQuestion] = useState<{ id: string; text: string } | null>(null)
  const [questionAnswer, setQuestionAnswer] = useState('')
  const [started, setStarted] = useState(false)
  const [currentAgent, setCurrentAgent] = useState<GenerationAgentKey | null>(null)
  const [isError, setIsError] = useState(false)

  const logEndRef = useRef<HTMLDivElement>(null)
  const logContainerRef = useRef<HTMLDivElement>(null)
  const stepListRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [expandedHtml, setExpandedHtml] = useState<string | null>(null)
  const [expandedLogIds, setExpandedLogIds] = useState<Set<string>>(new Set())
  const programmaticScrollRef = useRef(false)
  const [rightTab, setRightTab] = useState<'steps' | 'logs'>('steps')
  const [genLogs, setGenLogs] = useState<GenerationStepLog[]>([])
  const [genLogsLoaded, setGenLogsLoaded] = useState(false)

  // Only disable auto-scroll on strong user gestures (wheel / touch)
  // Regular scroll events from programmatic scrollIntoView are ignored.
  const handleWheel = useCallback((e: React.WheelEvent) => {
    // Only upward scrolls disengage auto-scroll
    if (e.deltaY < 0) setAutoScroll(false)
  }, [])

  useEffect(() => {
    if (autoScroll && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs, streamBuffer, autoScroll])

  // Auto-scroll step list to current step
  useEffect(() => {
    if (currentStepIndex >= 0 && stepListRef.current) {
      const el = stepListRef.current.children[currentStepIndex] as HTMLElement
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }
    }
  }, [currentStepIndex])

  // Listen to generation progress
  useEffect(() => {
    const unsub = api.onGenerationProgress((event: GenerationProgressEvent) => {
      setCurrentPhase(event.phase)

      // Track fine-grained agent for the flow strip.
      // Prefer explicit `agent` field; fall back to phase-based mapping
      // for backward compat with older events.
      const agentFromPhase: Partial<Record<string, GenerationAgentKey>> = {
        planning: 'planning', analyzing: 'analyzing', selector: 'selector',
        executing: 'executing', verifying: 'verifying', fixing: 'fixing',
      }
      const agent = event.agent ?? agentFromPhase[event.phase]
      if (agent) setCurrentAgent(agent)

      if (event.stepIndex !== undefined) {
        setCurrentStepIndex(event.stepIndex)
      }

      if (event.plan) {
        setPlan(event.plan)
        const statuses: Record<number, 'pending'> = {}
        event.plan.forEach((_, idx) => { statuses[idx] = 'pending' })
        setStepStatuses(statuses)
      }

      if (event.stepIndex !== undefined) {
        setStepStatuses((prev) => {
          const next = { ...prev }
          if (event.phase === 'generating') next[event.stepIndex!] = 'generating'
          else if (event.phase === 'executing') next[event.stepIndex!] = 'executing'
          else if (event.phase === 'fixing') next[event.stepIndex!] = 'fixing'
          else if (event.phase === 'done') next[event.stepIndex!] = 'success'
          else if (event.phase === 'error') next[event.stepIndex!] = 'error'
          return next
        })

        if (event.message?.includes('✅')) {
          setStepStatuses((prev) => ({ ...prev, [event.stepIndex!]: 'success' }))
        }
        if (event.message?.includes('❌')) {
          setStepStatuses((prev) => ({ ...prev, [event.stepIndex!]: 'error' }))
        }
      }

      if (event.streamDelta) {
        setStreamBuffer((prev) => prev + event.streamDelta)
        return
      }

      if (event.message) {
        // When a message arrives and we have stream content, save it as a log entry first
        setStreamBuffer((prev) => {
          if (prev) {
            setLogs((logs) => [
              ...logs,
              { id: crypto.randomUUID(), phase: event.phase, text: prev, timestamp: new Date() },
            ])
          }
          return ''
        })
        setLogs((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            phase: event.phase,
            text: event.message,
            timestamp: new Date(),
            screenshot: event.screenshot,
            html: event.html,
            messageCode: event.messageCode,
            messageParams: event.messageParams,
          },
        ])
      }

      // Handle login wait
      if (event.phase === 'waitingForLogin') {
        setWaitingForLogin(true)
      } else {
        setWaitingForLogin(false)
      }

      // Handle user question
      if (event.phase === 'askingUser' && event.question) {
        setActiveQuestion({ id: event.question.id, text: event.question.text })
        setQuestionAnswer('')
      } else if (event.phase !== 'askingUser') {
        setActiveQuestion(null)
      }

      if (event.phase === 'done' || event.phase === 'error') {
        setStreamBuffer('')
        setIsDone(true)
        if (event.phase === 'error') setIsError(true)
      }
    })
    return unsub
  }, [])

  // Start generation
  useEffect(() => {
    if (!taskId || !instruction || started) return
    setStarted(true)

    setLogs([
      { id: crypto.randomUUID(), phase: 'planning', text: t('taskLabel', { instruction }), timestamp: new Date() },
    ])

    api.startAutonomousGeneration({ taskId, instruction }).catch((err) => {
      setLogs((prev) => [
        ...prev,
        { id: crypto.randomUUID(), phase: 'error', text: `❌ ${(err as Error).message}`, timestamp: new Date() },
      ])
      setIsDone(true)
    })
  }, [taskId, instruction, started])

  const handleConfirmLogin = () => {
    api.confirmLogin(taskId)
    setWaitingForLogin(false)
  }

  const handleSubmitAnswer = () => {
    if (!activeQuestion) return
    // Allow empty answer — means "keep the default / as-is"
    api.answerQuestion(activeQuestion.id, questionAnswer.trim())
    setActiveQuestion(null)
    setQuestionAnswer('')
  }

  const phaseLabel = (phase: GenerationProgressEvent['phase']) => {
    switch (phase) {
      case 'planning': return t('stages.plan')
      case 'analyzing': return t('stages.analyze')
      case 'generating': return t('stages.gen')
      case 'selector': return t('stages.select')
      case 'executing': return t('stages.exec')
      case 'verifying': return t('stages.verify')
      case 'fixing': return t('stages.fix')
      case 'waitingForLogin': return t('stages.login')
      case 'askingUser': return t('stages.ask')
      case 'done': return t('stages.done')
      case 'error': return t('stages.err')
    }
  }

  const phaseColor = (phase: GenerationProgressEvent['phase']) => {
    switch (phase) {
      case 'planning': return 'text-blue-400'
      case 'analyzing': return 'text-cyan-400'
      case 'generating': return 'text-purple-400'
      case 'selector': return 'text-indigo-400'
      case 'executing': return 'text-yellow-400'
      case 'verifying': return 'text-teal-400'
      case 'fixing': return 'text-orange-400'
      case 'waitingForLogin': return 'text-amber-300'
      case 'askingUser': return 'text-cyan-300'
      case 'done': return 'text-green-400'
      case 'error': return 'text-red-400'
    }
  }

  /** Resolve a message to its translated form if a messageCode is available. */
  const translateMsg = (
    code: string | undefined | null,
    params: Record<string, string | number> | undefined | null,
    fallback: string,
  ): string => {
    if (!code) return fallback
    const key = `progress.${code}`
    const result = t(key, { ...(params ?? {}), defaultValue: '' })
    return result || fallback
  }

  const stepStatusIcon = (status: string) => {
    switch (status) {
      case 'pending': return '○'
      case 'generating': return '◐'
      case 'executing': return '◑'
      case 'fixing': return '⚠'
      case 'success': return '●'
      case 'error': return '✕'
      default: return '○'
    }
  }

  const stepStatusColor = (status: string) => {
    switch (status) {
      case 'pending': return 'text-neutral-500'
      case 'generating': return 'text-purple-400'
      case 'executing': return 'text-yellow-400'
      case 'fixing': return 'text-orange-400'
      case 'success': return 'text-green-400'
      case 'error': return 'text-red-400'
      default: return 'text-neutral-500'
    }
  }

  // Auto-refresh DB logs when generation completes or when switching to logs tab
  useEffect(() => {
    if (isDone && rightTab === 'logs') {
      api.getGenerationLogs(taskId).then(l => { setGenLogs(l); setGenLogsLoaded(true) }).catch(() => {})
    }
  }, [isDone, rightTab, taskId])

  const genLogPhaseLabel = (phase: string) => {
    switch (phase) {
      case 'planning': return t('stages.plan')
      case 'analyzing': return t('stages.analyze')
      case 'selector': return t('stages.select')
      case 'generating': return t('stages.gen')
      case 'executing': return t('stages.exec')
      case 'verifying': return t('stages.verify')
      case 'fixing': return t('stages.fix')
      case 'error': return t('stages.err')
      case 'done': return t('stages.done')
      default: return phase.toUpperCase()
    }
  }

  const genLogPhaseColor = (phase: string) => {
    switch (phase) {
      case 'planning': return 'text-blue-400'
      case 'analyzing': return 'text-cyan-400'
      case 'selector': return 'text-indigo-400'
      case 'generating': return 'text-purple-400'
      case 'executing': return 'text-yellow-400'
      case 'verifying': return 'text-teal-400'
      case 'fixing': return 'text-orange-400'
      case 'error': return 'text-red-400'
      case 'done': return 'text-green-400'
      default: return 'text-neutral-400'
    }
  }

  function GenLogEntry({ log }: { log: GenerationStepLog }) {
    const [expanded, setExpanded] = useState(false)
    const [screenshotSrc, setScreenshotSrc] = useState<string | null>(null)

    const loadScreenshot = () => {
      if (log.screenshot_path && !screenshotSrc) {
        api.readScreenshot(log.screenshot_path).then(setScreenshotSrc).catch(() => {})
      }
    }

    const hasDetail = !!(log.detail || log.screenshot_path)

    return (
      <div className="rounded border border-neutral-700/50 bg-neutral-900/50 overflow-hidden">
        <div
          onClick={() => {
            if (hasDetail) {
              setExpanded(!expanded)
              if (!expanded) loadScreenshot()
            }
          }}
          className={`flex items-start gap-1.5 px-2 py-1 ${hasDetail ? 'cursor-pointer hover:bg-neutral-700/30' : ''}`}
        >
          <span className={`${genLogPhaseColor(log.phase)} font-mono text-[9px] shrink-0 w-12 text-right mt-px`}>
            [{genLogPhaseLabel(log.phase)}]
          </span>
          <span className="text-[10px] text-neutral-300 flex-1 break-all leading-snug">
            {translateMsg(
              log.message_code,
              log.message_params ? JSON.parse(log.message_params) : undefined,
              log.message,
            )}
          </span>
          <span className="text-[8px] text-neutral-600 shrink-0 mt-px">
            {new Date(log.created_at).toLocaleTimeString(locale)}
          </span>
          {hasDetail && (
            <span className="text-[9px] text-neutral-600 shrink-0 mt-px">
              {expanded ? '▼' : '▶'}
            </span>
          )}
        </div>

        {expanded && hasDetail && (
          <div className="border-t border-neutral-700/30 px-2 py-1.5 space-y-1.5 bg-neutral-950/50">
            {log.detail && (
              <pre className="text-[9px] font-mono text-neutral-400 max-h-[250px] overflow-auto whitespace-pre-wrap break-all leading-snug">
                {log.detail.length > 5000 ? log.detail.slice(0, 5000) + '\n...(truncated)' : log.detail}
              </pre>
            )}
            {screenshotSrc && (
              <img
                src={screenshotSrc}
                alt="Screenshot"
                className="max-w-full max-h-[180px] rounded border border-neutral-700 cursor-pointer hover:border-neutral-500"
                onClick={(e) => {
                  e.stopPropagation()
                  const w = window.open('', '_blank', 'width=1024,height=768')
                  if (w) w.document.write(`<img src="${screenshotSrc}" style="max-width:100%">`)
                }}
              />
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[90vw] h-[85vh] max-w-6xl rounded-lg overflow-hidden shadow-2xl flex bg-neutral-900">
        {/* Left: Log area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-2 bg-neutral-800 border-b border-neutral-700 shrink-0">
            <div className="flex items-center gap-2">
              <span className="text-xs text-neutral-400 font-mono">{t('title')}</span>
              {!isDone && (
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              )}
              <span className="text-[10px] text-neutral-600 font-mono truncate max-w-[400px]">
                {instruction}
              </span>
            </div>
            <div className="flex gap-2">
              {!isDone && (
                <button
                  onClick={() => {
                    api.cancelGeneration(taskId)
                    setIsDone(true)
                  }}
                  className="px-2 py-0.5 text-[10px] text-red-400 border border-red-400/30 rounded hover:bg-red-400/10"
                >
                  {t('cancel')}
                </button>
              )}
              <button
                onClick={() => onClose(isDone ? 'close' : 'background')}
                className="px-2 py-0.5 text-[10px] text-neutral-400 border border-neutral-600 rounded hover:bg-neutral-700"
              >
                {isDone ? t('close') : t('background')}
              </button>
            </div>
          </div>

          {/* Agent flow strip */}
          <AgentFlowStrip
            currentAgent={currentAgent}
            isDone={isDone}
            isError={isError}
            currentStepIndex={currentStepIndex}
            totalSteps={plan.length}
          />

          {/* Log output — independent scroll */}
          <div className="flex-1 relative min-h-0">
            <div
              ref={logContainerRef}
              onWheel={handleWheel}
              className="absolute inset-0 overflow-y-auto p-4 font-mono text-xs leading-relaxed"
            >
            {logs.map((line) => {
              const displayText = translateMsg(line.messageCode, line.messageParams, line.text)
              const lineCount = displayText.split('\n').length
              const isLong = lineCount > 3 || displayText.length > 200
              const isExpanded = expandedLogIds.has(line.id)
              const hasAttachments = !!(line.screenshot || line.html)
              const isCollapsible = isLong || hasAttachments

              // For collapsed long text: show first 2 lines or 150 chars
              const collapsedText = isLong && !isExpanded
                ? displayText.split('\n').slice(0, 2).join('\n').slice(0, 150) + '…'
                : displayText

              const toggleExpand = () => {
                if (!isCollapsible) return
                setExpandedLogIds(prev => {
                  const next = new Set(prev)
                  if (next.has(line.id)) next.delete(line.id)
                  else next.add(line.id)
                  return next
                })
              }

              return (
                <div key={line.id} className="mb-1">
                  <div
                    className={`flex gap-2 ${isCollapsible ? 'cursor-pointer hover:bg-neutral-800/50 rounded px-1 -mx-1' : ''}`}
                    onClick={toggleExpand}
                  >
                    <span className={`${phaseColor(line.phase)} shrink-0 w-14 text-right`}>
                      [{phaseLabel(line.phase)}]
                    </span>
                    <span className="text-neutral-300 whitespace-pre-wrap break-all flex-1">{collapsedText}</span>
                    {isCollapsible && (
                      <span className="text-neutral-600 shrink-0 text-[9px] mt-0.5">
                        {isExpanded ? '▼' : '▶'}
                        {!isExpanded && isLong && ` ${t('moreLines', { count: lineCount - 2 })}`}
                        {!isExpanded && hasAttachments && !isLong && ` ${t('details')}`}
                      </span>
                    )}
                  </div>

                  {/* Expanded content */}
                  {isExpanded && isLong && (
                    <div className="ml-16 mt-0.5 mb-1">
                      <pre className="p-2 bg-neutral-950 border border-neutral-700 rounded text-[9px] text-neutral-400 max-h-[400px] overflow-auto whitespace-pre-wrap break-all">
                        {displayText}
                      </pre>
                    </div>
                  )}

                  {/* Screenshot thumbnail — show when expanded or always for short logs */}
                  {line.screenshot && (isExpanded || !isLong) && (
                    <div className="ml-16 mt-1 mb-1">
                      <img
                        src={`data:image/jpeg;base64,${line.screenshot}`}
                        alt="Screenshot"
                        className="max-w-[320px] max-h-[200px] rounded border border-neutral-600 cursor-pointer hover:border-neutral-400 transition-colors"
                        onClick={(e) => {
                          e.stopPropagation()
                          const w = window.open('', '_blank', 'width=1024,height=768')
                          if (w) {
                            w.document.write(`<img src="data:image/jpeg;base64,${line.screenshot}" style="max-width:100%">`)
                          }
                        }}
                      />
                      <span className="text-[9px] text-neutral-600 mt-0.5 block">{t('clickToZoom')}</span>
                    </div>
                  )}

                  {/* HTML snapshot — show when expanded */}
                  {line.html && isExpanded && (
                    <div className="ml-16 mt-0.5 mb-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setExpandedHtml(expandedHtml === line.id ? null : line.id)
                        }}
                        className="text-[10px] text-blue-400 hover:text-blue-300 underline"
                      >
                        {expandedHtml === line.id ? t('hideHtml') : t('showHtml')}
                      </button>
                      {expandedHtml === line.id && (
                        <pre className="mt-1 p-2 bg-neutral-950 border border-neutral-700 rounded text-[9px] text-neutral-400 max-h-[300px] overflow-auto whitespace-pre-wrap break-all">
                          {line.html.slice(0, 10000)}
                          {line.html.length > 10000 && '\n...(truncated)'}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              )
            })}

            {streamBuffer && (
              <div className="flex gap-2 mb-0.5">
                <span className={`${phaseColor(currentPhase)} shrink-0 w-14 text-right`}>
                  [{phaseLabel(currentPhase)}]
                </span>
                <span className="text-neutral-400 whitespace-pre-wrap break-all">
                  {streamBuffer}
                  <span className="animate-pulse">▊</span>
                </span>
              </div>
            )}

            {!isDone && !streamBuffer && (
              <div className="flex gap-2 mb-0.5">
                <span className={`${phaseColor(currentPhase)} shrink-0 w-14 text-right`}>
                  [{phaseLabel(currentPhase)}]
                </span>
                <span className="text-neutral-500 animate-pulse">▊</span>
              </div>
            )}

            {/* Login confirmation banner */}
            {waitingForLogin && (
              <div className="my-2 p-3 bg-amber-900/30 border border-amber-500/40 rounded flex items-center justify-between">
                <div>
                  <p className="text-amber-200 text-xs font-medium">{t('loginRequired')}</p>
                  <p className="text-amber-300/70 text-[10px] mt-0.5">
                    {t('loginHint')}
                  </p>
                </div>
                <button
                  onClick={handleConfirmLogin}
                  className="px-3 py-1.5 bg-amber-500 text-black text-xs font-medium rounded hover:bg-amber-400 shrink-0 ml-3"
                >
                  {t('loginDone')}
                </button>
              </div>
            )}

            {/* User question banner */}
            {activeQuestion && (
              <div className="my-2 p-3 bg-cyan-900/30 border border-cyan-500/40 rounded">
                <p className="text-cyan-200 text-xs font-medium mb-2">❓ {activeQuestion.text}</p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={questionAnswer}
                    onChange={(e) => setQuestionAnswer(e.target.value)}
                    onKeyDown={(e) => {
                      // IME composition (isComposing / keyCode 229): ignore the Enter that confirms the IME.
                      if (e.key !== 'Enter') return
                      if (e.nativeEvent.isComposing || e.keyCode === 229) return
                      handleSubmitAnswer()
                    }}
                    placeholder={t('answerPlaceholder')}
                    className="flex-1 px-2 py-1.5 bg-neutral-800 border border-neutral-600 rounded text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
                    autoFocus
                  />
                  <button
                    onClick={handleSubmitAnswer}
                    className="px-3 py-1.5 bg-cyan-500 text-black text-xs font-medium rounded hover:bg-cyan-400 shrink-0"
                  >
                    {questionAnswer.trim() ? t('submitAnswer') : t('submitAnswerEmpty')}
                  </button>
                </div>
              </div>
            )}

            <div ref={logEndRef} />
            </div>
            {/* Floating scroll-to-bottom button */}
            {!autoScroll && (
              <button
                onClick={() => {
                  setAutoScroll(true)
                  programmaticScrollRef.current = true
                  logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
                  setTimeout(() => { programmaticScrollRef.current = false }, 300)
                }}
                className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 px-4 py-1.5 bg-neutral-700 border border-neutral-500 rounded-full text-[11px] text-neutral-200 hover:bg-neutral-600 shadow-lg backdrop-blur"
              >
                {t('scrollToLatest')}
              </button>
            )}
          </div>
        </div>

        {/* Right: Step plan + Generation logs — independent scroll */}
        <div className="w-64 shrink-0 bg-neutral-800 border-l border-neutral-700 flex flex-col">
          {/* Tab bar */}
          <div className="flex border-b border-neutral-700 shrink-0">
            <button
              onClick={() => setRightTab('steps')}
              className={`flex-1 px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider ${
                rightTab === 'steps'
                  ? 'text-neutral-200 border-b border-neutral-200'
                  : 'text-neutral-500 hover:text-neutral-400'
              }`}
            >
              {t('rightTab.steps')}
            </button>
            <button
              onClick={() => {
                setRightTab('logs')
                if (!genLogsLoaded) {
                  api.getGenerationLogs(taskId).then(l => { setGenLogs(l); setGenLogsLoaded(true) }).catch(() => {})
                }
              }}
              className={`flex-1 px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider ${
                rightTab === 'logs'
                  ? 'text-neutral-200 border-b border-neutral-200'
                  : 'text-neutral-500 hover:text-neutral-400'
              }`}
            >
              {t('rightTab.logs')}{genLogsLoaded ? ` (${genLogs.length})` : ''}
            </button>
          </div>

          {/* Steps tab */}
          {rightTab === 'steps' && (
            <div ref={stepListRef} className="flex-1 overflow-y-auto p-2 space-y-1">
              {plan.length === 0 && (
                <div className="text-[10px] text-neutral-500 text-center py-4">
                  {t('planning')}
                </div>
              )}
              {plan.map((step, idx) => (
                <div
                  key={idx}
                  className={`p-1.5 rounded text-xs ${
                    idx === currentStepIndex && !isDone ? 'bg-neutral-700' : 'bg-transparent'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className={`${stepStatusColor(stepStatuses[idx] ?? 'pending')} text-sm leading-none`}>
                      {stepStatusIcon(stepStatuses[idx] ?? 'pending')}
                    </span>
                    <span className="text-neutral-200 font-medium truncate">
                      {idx + 1}. {step.name}
                    </span>
                  </div>
                  <p className="text-[10px] text-neutral-500 mt-0.5 ml-5 line-clamp-2">
                    {step.description}
                  </p>
                </div>
              ))}
            </div>
          )}

          {/* Generation Logs tab */}
          {rightTab === 'logs' && (
            <div className="flex-1 overflow-y-auto">
              {/* Refresh button */}
              <div className="px-2 py-1 border-b border-neutral-700/50 flex items-center justify-between">
                <span className="text-[9px] text-neutral-500">
                  {t('generationLogsHint')}
                </span>
                <button
                  onClick={() => {
                    api.getGenerationLogs(taskId).then(l => { setGenLogs(l); setGenLogsLoaded(true) }).catch(() => {})
                  }}
                  className="text-[9px] text-neutral-500 hover:text-neutral-300 px-1"
                >
                  {t('refresh')}
                </button>
              </div>
              {!genLogsLoaded ? (
                <div className="text-[10px] text-neutral-500 text-center py-4">
                  {t('loadingLogs')}
                </div>
              ) : genLogs.length === 0 ? (
                <div className="text-[10px] text-neutral-500 text-center py-4">
                  {t('noLogs')}
                </div>
              ) : (
                <div className="p-1.5 space-y-1">
                  {genLogs.map((gl) => (
                    <GenLogEntry key={gl.id} log={gl} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
