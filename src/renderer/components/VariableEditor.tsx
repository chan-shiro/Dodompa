import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { VariableDefinition } from '../lib/types'
import { suggestVariables } from '../lib/api'

interface VariableEditorProps {
  taskId: string
  variables: VariableDefinition[]
  onChange: (variables: VariableDefinition[]) => void
}

const TYPES: VariableDefinition['type'][] = ['string', 'number', 'secret']

function emptyVar(): VariableDefinition {
  return { key: '', label: '', type: 'string', required: false, default: '' }
}

function isValidKey(key: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)
}

export default function VariableEditor({ taskId, variables, onChange }: VariableEditorProps) {
  const { t } = useTranslation('variableEditor')
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [draft, setDraft] = useState<VariableDefinition>(emptyVar())
  const [addingNew, setAddingNew] = useState(false)
  const [keyError, setKeyError] = useState('')

  // AI suggestion state
  const [showAiPanel, setShowAiPanel] = useState(false)
  const [aiInstruction, setAiInstruction] = useState('')
  const [suggesting, setSuggesting] = useState(false)
  const [suggestions, setSuggestions] = useState<VariableDefinition[] | null>(null)
  const [aiError, setAiError] = useState('')
  const [acceptedKeys, setAcceptedKeys] = useState<Set<string>>(new Set())

  const typeLabel = (type: VariableDefinition['type']) => t(`types.${type}`)

  const startEdit = (idx: number) => {
    setEditingIdx(idx)
    setDraft({ ...variables[idx] })
    setAddingNew(false)
    setKeyError('')
  }

  const startAdd = () => {
    setAddingNew(true)
    setEditingIdx(null)
    setDraft(emptyVar())
    setKeyError('')
  }

  const cancelEdit = () => {
    setEditingIdx(null)
    setAddingNew(false)
    setKeyError('')
  }

  const validateAndSave = () => {
    if (!draft.key.trim()) { setKeyError(t('errors.keyRequired')); return }
    if (!isValidKey(draft.key)) { setKeyError(t('errors.keyPattern')); return }

    if (addingNew) {
      const duplicate = variables.some(v => v.key === draft.key)
      if (duplicate) { setKeyError(t('errors.keyDuplicate')); return }
      onChange([...variables, { ...draft, key: draft.key.trim() }])
    } else if (editingIdx !== null) {
      const updated = variables.map((v, i) => i === editingIdx ? { ...draft, key: draft.key.trim() } : v)
      onChange(updated)
    }
    cancelEdit()
  }

  const deleteVar = (idx: number) => {
    onChange(variables.filter((_, i) => i !== idx))
    if (editingIdx === idx) cancelEdit()
  }

  // ── AI suggestion ──

  const handleSuggest = async () => {
    setSuggesting(true)
    setAiError('')
    setSuggestions(null)
    setAcceptedKeys(new Set())
    try {
      const result = await suggestVariables({
        taskId,
        instruction: aiInstruction.trim() || undefined,
      })
      setSuggestions(result as VariableDefinition[])
      if (result.length === 0) setAiError(t('suggest.empty'))
    } catch (e) {
      setAiError((e as Error).message)
    } finally {
      setSuggesting(false)
    }
  }

  const acceptSuggestion = (v: VariableDefinition) => {
    // Don't add duplicates
    if (variables.some(existing => existing.key === v.key)) return
    onChange([...variables, v])
    setAcceptedKeys(prev => new Set([...prev, v.key]))
  }

  const acceptAll = () => {
    const existingKeys = new Set(variables.map(v => v.key))
    const toAdd = (suggestions ?? []).filter(s => !existingKeys.has(s.key))
    if (toAdd.length === 0) return
    onChange([...variables, ...toAdd])
    setAcceptedKeys(new Set((suggestions ?? []).map(s => s.key)))
  }

  const isEditing = editingIdx !== null || addingNew

  return (
    <div className="space-y-1.5">
      {/* Variable list */}
      {variables.map((v, idx) => (
        <div key={v.key}>
          {editingIdx === idx ? (
            <VariableForm
              draft={draft}
              keyError={keyError}
              onChange={setDraft}
              onSave={validateAndSave}
              onCancel={cancelEdit}
            />
          ) : (
            <div className="flex items-center gap-2 px-2 py-1.5 border border-notion-border rounded bg-notion-sidebar group">
              <code className="text-[11px] font-mono text-notion-accent bg-blue-50 px-1.5 py-0.5 rounded">
                {v.key}
              </code>
              <span className="text-xs text-notion-text-primary flex-1 truncate">{v.label || t('row.noLabel')}</span>
              <span className="text-[10px] text-notion-text-muted">{typeLabel(v.type)}</span>
              {v.required && (
                <span className="text-[10px] text-notion-danger font-medium">{t('row.requiredBadge')}</span>
              )}
              {v.default && (
                <span className="text-[10px] text-notion-text-muted">
                  {t('row.defaultLabel')} <code className="font-mono">{v.type === 'secret' ? '••••' : v.default}</code>
                </span>
              )}
              <div className="flex gap-1 opacity-0 group-hover:opacity-100">
                <button
                  onClick={() => startEdit(idx)}
                  disabled={isEditing}
                  className="px-1.5 py-0.5 text-[10px] text-notion-text-secondary hover:bg-notion-hover rounded disabled:opacity-30"
                >
                  {t('actions.edit')}
                </button>
                <button
                  onClick={() => deleteVar(idx)}
                  className="px-1.5 py-0.5 text-[10px] text-notion-danger hover:bg-red-50 rounded"
                >
                  {t('actions.delete')}
                </button>
              </div>
            </div>
          )}
        </div>
      ))}

      {/* New variable form */}
      {addingNew && (
        <VariableForm
          draft={draft}
          keyError={keyError}
          onChange={setDraft}
          onSave={validateAndSave}
          onCancel={cancelEdit}
          isNew
        />
      )}

      {/* Action buttons */}
      {!isEditing && (
        <div className="flex gap-1.5">
          <button
            onClick={startAdd}
            className="flex-1 flex items-center justify-center gap-1 px-2 py-1 text-xs text-notion-text-muted hover:text-notion-accent hover:bg-notion-hover rounded border border-dashed border-notion-border"
          >
            <span>+</span>
            <span>{t('actions.addManual')}</span>
          </button>
          <button
            onClick={() => { setShowAiPanel(v => !v); setSuggestions(null); setAiError('') }}
            className="flex items-center gap-1 px-2 py-1 text-xs text-notion-accent hover:bg-blue-50 rounded border border-dashed border-notion-accent/40"
          >
            {t('actions.suggestAi')}
          </button>
        </div>
      )}

      {/* AI suggestion panel */}
      {showAiPanel && !isEditing && (
        <div className="border border-notion-accent/30 rounded-lg p-3 bg-blue-50/30 space-y-2.5">
          <p className="text-xs font-medium text-notion-text-primary">{t('suggest.title')}</p>
          <p className="text-[10px] text-notion-text-muted">
            {t('suggest.description')}
          </p>

          {/* Optional instruction */}
          <div>
            <label className="block text-[10px] text-notion-text-muted mb-1">{t('suggest.instructionLabel')}</label>
            <input
              type="text"
              value={aiInstruction}
              onChange={e => setAiInstruction(e.target.value)}
              onKeyDown={e => {
                if (e.key !== 'Enter') return
                if (e.nativeEvent.isComposing || e.keyCode === 229) return
                handleSuggest()
              }}
              placeholder={t('suggest.instructionPlaceholder')}
              className="w-full px-2 py-1.5 text-xs border border-notion-border rounded focus:outline-none focus:ring-1 focus:ring-notion-accent bg-white"
              disabled={suggesting}
            />
          </div>

          <button
            onClick={handleSuggest}
            disabled={suggesting}
            className="px-3 py-1.5 bg-notion-accent text-white text-xs rounded hover:opacity-90 disabled:opacity-40"
          >
            {suggesting ? t('suggest.generating') : t('suggest.generate')}
          </button>

          {/* Error */}
          {aiError && (
            <p className="text-xs text-notion-text-muted bg-white border border-notion-border rounded p-2">
              {aiError}
            </p>
          )}

          {/* Suggestions */}
          {suggestions && suggestions.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-medium text-notion-text-secondary">
                  {t('suggest.countLabel', { count: suggestions.length })}
                </p>
                <button
                  onClick={acceptAll}
                  disabled={suggestions.every(s => acceptedKeys.has(s.key) || variables.some(v => v.key === s.key))}
                  className="px-2 py-0.5 text-[10px] bg-notion-success text-white rounded hover:opacity-90 disabled:opacity-40"
                >
                  {t('suggest.addAll')}
                </button>
              </div>

              {suggestions.map(s => {
                const alreadyExists = variables.some(v => v.key === s.key)
                const accepted = acceptedKeys.has(s.key) || alreadyExists
                return (
                  <div
                    key={s.key}
                    className={`flex items-center gap-2 p-2 rounded border ${accepted ? 'bg-green-50 border-green-200' : 'bg-white border-notion-border'}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <code className="text-[11px] font-mono text-notion-accent">{s.key}</code>
                        <span className="text-[10px] text-notion-text-muted">{typeLabel(s.type as VariableDefinition['type'])}</span>
                        {s.required && <span className="text-[10px] text-notion-danger">{t('row.requiredBadge')}</span>}
                      </div>
                      <p className="text-[10px] text-notion-text-secondary truncate">{s.label}</p>
                      {s.default && (
                        <p className="text-[10px] text-notion-text-muted font-mono">
                          {t('row.defaultLabel')} {s.type === 'secret' ? '••••' : s.default}
                        </p>
                      )}
                    </div>
                    {accepted ? (
                      <span className="text-[10px] text-notion-success font-medium flex-shrink-0">{t('suggest.added')}</span>
                    ) : (
                      <button
                        onClick={() => acceptSuggestion(s as VariableDefinition)}
                        className="px-2 py-1 text-[10px] bg-notion-accent text-white rounded hover:opacity-90 flex-shrink-0"
                      >
                        {t('suggest.add')}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Usage hint */}
      {variables.length > 0 && (
        <div className="mt-2 p-2 bg-notion-sidebar rounded text-[10px] text-notion-text-muted font-mono">
          <p className="font-sans text-notion-text-secondary font-medium mb-1">{t('usage.heading')}</p>
          {variables.map(v => (
            <p key={v.key}>
              <span className="text-notion-accent">ctx.input.{v.key}</span>
              <span className="font-sans text-notion-text-muted ml-2">// {v.label}{v.required ? t('usage.requiredSuffix') : ''}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Variable edit form ───

interface FormProps {
  draft: VariableDefinition
  keyError: string
  onChange: (v: VariableDefinition) => void
  onSave: () => void
  onCancel: () => void
  isNew?: boolean
}

function VariableForm({ draft, keyError, onChange, onSave, onCancel, isNew }: FormProps) {
  const { t } = useTranslation('variableEditor')
  return (
    <div className="border border-notion-accent/40 rounded p-3 bg-blue-50/30 space-y-2">
      <div className="grid grid-cols-2 gap-2">
        {/* Key */}
        <div>
          <label className="block text-[10px] text-notion-text-muted mb-0.5">
            {t('form.key')} <span className="text-notion-danger">{t('form.keyRequired')}</span>
          </label>
          <input
            type="text"
            value={draft.key}
            onChange={e => onChange({ ...draft, key: e.target.value })}
            placeholder={t('form.keyPlaceholder')}
            className={`w-full px-2 py-1 text-xs border rounded font-mono focus:outline-none focus:ring-1 focus:ring-notion-accent ${keyError ? 'border-notion-danger' : 'border-notion-border'}`}
            autoFocus={isNew}
            onKeyDown={e => { if (e.key === 'Enter') onSave() }}
          />
          {keyError && <p className="text-[10px] text-notion-danger mt-0.5">{keyError}</p>}
        </div>

        {/* Label */}
        <div>
          <label className="block text-[10px] text-notion-text-muted mb-0.5">{t('form.label')}</label>
          <input
            type="text"
            value={draft.label}
            onChange={e => onChange({ ...draft, label: e.target.value })}
            placeholder={t('form.labelPlaceholder')}
            className="w-full px-2 py-1 text-xs border border-notion-border rounded focus:outline-none focus:ring-1 focus:ring-notion-accent"
            onKeyDown={e => { if (e.key === 'Enter') onSave() }}
          />
        </div>

        {/* Type */}
        <div>
          <label className="block text-[10px] text-notion-text-muted mb-0.5">{t('form.type')}</label>
          <select
            value={draft.type}
            onChange={e => onChange({ ...draft, type: e.target.value as VariableDefinition['type'] })}
            className="w-full px-2 py-1 text-xs border border-notion-border rounded focus:outline-none focus:ring-1 focus:ring-notion-accent bg-white"
          >
            {TYPES.map(ty => (
              <option key={ty} value={ty}>{t(`types.${ty}`)}</option>
            ))}
          </select>
        </div>

        {/* Default */}
        <div>
          <label className="block text-[10px] text-notion-text-muted mb-0.5">{t('form.default')}</label>
          <input
            type={draft.type === 'secret' ? 'password' : 'text'}
            value={draft.default ?? ''}
            onChange={e => onChange({ ...draft, default: e.target.value })}
            placeholder={t('form.defaultPlaceholder')}
            className="w-full px-2 py-1 text-xs border border-notion-border rounded focus:outline-none focus:ring-1 focus:ring-notion-accent"
            onKeyDown={e => { if (e.key === 'Enter') onSave() }}
          />
        </div>
      </div>

      {/* Required toggle */}
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={draft.required}
          onChange={e => onChange({ ...draft, required: e.target.checked })}
          className="accent-notion-accent"
        />
        <span className="text-xs text-notion-text-secondary">{t('form.required')}</span>
      </label>

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={onSave}
          className="px-2 py-1 bg-notion-accent text-white text-xs rounded hover:opacity-90"
        >
          {isNew ? t('actions.addNew') : t('actions.save')}
        </button>
        <button
          onClick={onCancel}
          className="px-2 py-1 text-xs text-notion-text-secondary hover:bg-notion-hover rounded"
        >
          {t('actions.cancel')}
        </button>
      </div>
    </div>
  )
}
