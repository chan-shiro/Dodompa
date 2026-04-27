import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AiProviderConfig, BrowserProfile, GeneralSettings, KnowledgeEntry, KnowledgePlatform, UiLanguage } from '../lib/types'
import * as api from '../lib/api'
import { useCompositionGuard } from '../lib/hooks'
import { setAppLanguage } from '../i18n'

function ProviderForm({
  provider,
  onSave,
  onCancel,
}: {
  provider: AiProviderConfig
  onSave: (p: AiProviderConfig) => void
  onCancel: () => void
}) {
  const { t } = useTranslation('settings')
  const [form, setForm] = useState(provider)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<boolean | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelError, setModelError] = useState<string | null>(null)

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    const ok = await api.testProvider(form)
    setTestResult(ok)
    setTesting(false)
  }

  const handleFetchModels = async () => {
    if (!form.apiKey) return
    setLoadingModels(true)
    setModelError(null)
    try {
      const list = await api.fetchModels({
        type: form.type,
        apiKey: form.apiKey,
        baseUrl: form.baseUrl,
        // Allow the main process to resolve API_KEY_MASK back to the stored key
        providerId: form.id,
      })
      setModels(list)
      if (list.length > 0 && !list.includes(form.model)) {
        setForm({ ...form, model: list[0] })
      }
    } catch {
      setModelError(t('providers.fetchFailed'))
      setModels([])
    } finally {
      setLoadingModels(false)
    }
  }

  // True when the current form is holding the server-side mask instead of a real key.
  const isMaskedKey = form.apiKey === api.API_KEY_MASK

  return (
    <div className="p-2.5 border border-notion-border rounded bg-notion-sidebar space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-[10px] text-notion-text-muted mb-1">{t('providers.name')}</label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="w-full px-2 py-1.5 border border-notion-border rounded text-xs bg-white focus:outline-none focus:ring-2 focus:ring-notion-accent/30"
          />
        </div>
        <div>
          <label className="block text-[10px] text-notion-text-muted mb-1">{t('providers.type')}</label>
          <select
            value={form.type}
            onChange={(e) => {
              setForm({ ...form, type: e.target.value as AiProviderConfig['type'], model: '' })
              setModels([])
              setModelError(null)
            }}
            className="w-full px-2 py-1.5 border border-notion-border rounded text-xs bg-white focus:outline-none"
          >
            <option value="anthropic">{t('providers.types.anthropic')}</option>
            <option value="openai">{t('providers.types.openai')}</option>
            <option value="google">{t('providers.types.google')}</option>
            <option value="openai-compatible">{t('providers.types.openaiCompatible')}</option>
          </select>
        </div>
      </div>

      {form.type === 'openai-compatible' && (
        <div>
          <label className="block text-[10px] text-notion-text-muted mb-1">{t('providers.baseUrl')}</label>
          <input
            type="text"
            value={form.baseUrl ?? ''}
            onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
            placeholder="https://api.openai.com/v1"
            className="w-full px-2 py-1.5 border border-notion-border rounded text-xs bg-white focus:outline-none focus:ring-2 focus:ring-notion-accent/30"
          />
        </div>
      )}

      <div>
        <label className="block text-[10px] text-notion-text-muted mb-1">{t('providers.apiKey')}</label>
        <div className="flex gap-1.5">
          <input
            type="password"
            value={isMaskedKey ? '' : form.apiKey}
            placeholder={isMaskedKey ? t('providers.apiKeySaved') : ''}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            className="flex-1 px-2 py-1.5 border border-notion-border rounded text-xs bg-white focus:outline-none focus:ring-2 focus:ring-notion-accent/30"
          />
          <button
            onClick={handleFetchModels}
            disabled={!form.apiKey || loadingModels}
            className="px-2 py-1 border border-notion-border text-xs rounded hover:bg-notion-hover disabled:opacity-50 whitespace-nowrap"
          >
            {loadingModels ? t('providers.fetchModels') + '...' : t('providers.fetchModels')}
          </button>
        </div>
      </div>

      <div>
        <label className="block text-[10px] text-notion-text-muted mb-1">{t('providers.model')}</label>
        {models.length > 0 ? (
          <select
            value={form.model}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
            className="w-full px-2 py-1.5 border border-notion-border rounded text-xs bg-white focus:outline-none"
          >
            <option value=""></option>
            {models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={form.model}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
            placeholder={
              form.type === 'anthropic' ? 'claude-sonnet-4-20250514' :
              form.type === 'openai' ? 'gpt-4o' :
              form.type === 'google' ? 'gemini-2.5-pro-preview-06-05' :
              'llama3'
            }
            className="w-full px-2 py-1.5 border border-notion-border rounded text-xs bg-white focus:outline-none focus:ring-2 focus:ring-notion-accent/30"
          />
        )}
        {modelError && (
          <p className="text-[10px] text-notion-danger mt-1">{modelError}</p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={form.isActive}
            onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
            className="rounded"
          />
          {t('providers.active')}
        </label>
      </div>

      <div className="flex items-center gap-2 pt-2">
        <button
          onClick={() => onSave(form)}
          className="px-2 py-1 bg-notion-accent text-white text-xs rounded hover:bg-neutral-700"
        >
          {t('providers.save')}
        </button>
        <button
          onClick={handleTest}
          disabled={testing}
          className="px-2 py-1 border border-notion-border text-xs rounded hover:bg-notion-hover disabled:opacity-50"
        >
          {testing ? t('providers.testConnection') + '...' : t('providers.testConnection')}
        </button>
        <button
          onClick={onCancel}
          className="px-2 py-1 text-xs text-notion-text-muted hover:bg-notion-hover rounded"
        >
          {t('providers.cancel')}
        </button>
        {testResult !== null && (
          <span className={`text-xs ${testResult ? 'text-notion-success' : 'text-notion-danger'}`}>
            {testResult ? t('providers.testSuccess') : t('providers.testFailure')}
          </span>
        )}
      </div>
    </div>
  )
}

export default function Settings() {
  const { t, i18n } = useTranslation('settings')
  const locale = i18n.language === 'ja' ? 'ja-JP' : 'en-US'
  const [providers, setProviders] = useState<AiProviderConfig[]>([])
  const [profiles, setProfiles] = useState<BrowserProfile[]>([])
  const [general, setGeneral] = useState<GeneralSettings>({
    playwrightExecutablePath: '',
    defaultHeadless: false,
    language: 'auto',
  })
  const [editingProvider, setEditingProvider] = useState<AiProviderConfig | null>(null)
  const [newProfileName, setNewProfileName] = useState('')
  const { compositionProps, isComposing } = useCompositionGuard()

  // Tabs
  const [activeTab, setActiveTab] = useState<'general' | 'knowledge'>('general')

  // Knowledge state
  const [knowledgeList, setKnowledgeList] = useState<KnowledgeEntry[]>([])
  const [knowledgeFilter, setKnowledgeFilter] = useState<KnowledgePlatform | 'all'>('all')
  const [editingKnowledge, setEditingKnowledge] = useState<KnowledgeEntry | null>(null)
  const [viewingKnowledge, setViewingKnowledge] = useState<KnowledgeEntry | null>(null)

  const loadKnowledge = () => api.listKnowledge().then(setKnowledgeList).catch(console.error)

  useEffect(() => {
    api.getProviders().then(setProviders).catch(console.error)
    api.listProfiles().then(setProfiles).catch(console.error)
    api.getGeneralSettings().then((g) => setGeneral({ language: 'auto', ...g })).catch(console.error)
    loadKnowledge()
  }, [])

  const handleSaveProvider = async (config: AiProviderConfig) => {
    await api.saveProvider(config)
    setEditingProvider(null)
    setProviders(await api.getProviders())
  }

  const handleDeleteProvider = async (id: string) => {
    if (!confirm(t('providers.confirmDelete'))) return
    await api.deleteProvider(id)
    setProviders(await api.getProviders())
  }

  const handleCreateProfile = async () => {
    if (!newProfileName.trim()) return
    await api.createProfile(newProfileName.trim())
    setNewProfileName('')
    setProfiles(await api.listProfiles())
  }

  const handleDeleteProfile = async (profileId: string) => {
    const p = profiles.find(x => x.id === profileId)
    if (!confirm(t('profiles.confirmDelete', { name: p?.name ?? '' }))) return
    await api.deleteProfile(profileId)
    setProfiles(await api.listProfiles())
  }

  const handleOpenBrowser = async (profileId: string) => {
    try {
      await api.openProfileBrowser(profileId)
      setProfiles(await api.listProfiles())
    } catch (err) {
      alert((err as Error).message)
    }
  }

  const handleSaveGeneral = async () => {
    await api.saveGeneralSettings(general)
  }

  const handleChangeLanguage = async (lang: UiLanguage) => {
    const next = { ...general, language: lang }
    setGeneral(next)
    await api.saveGeneralSettings(next)
    // Resolve 'auto' via main process so we know which concrete language to switch to.
    const effective = lang === 'auto' ? await api.getUiLanguage() : lang
    await setAppLanguage(effective)
  }

  const handleSaveKnowledge = async (entry: KnowledgeEntry) => {
    await api.saveKnowledge(entry)
    setEditingKnowledge(null)
    loadKnowledge()
  }

  const handleDeleteKnowledge = async (name: string) => {
    if (!confirm(t('knowledge.confirmDelete'))) return
    await api.deleteKnowledge(name)
    loadKnowledge()
  }

  const filteredKnowledge = knowledgeList.filter(k =>
    knowledgeFilter === 'all' || k.platform === knowledgeFilter
  )

  const platformLabel = (p: KnowledgePlatform) =>
    p === 'mac' ? t('knowledge.filter.mac') : p === 'windows' ? t('knowledge.filter.windows') : t('knowledge.filter.browser')

  const platformBadge = (p: KnowledgePlatform) => {
    const colors = { mac: 'bg-blue-100 text-blue-700', windows: 'bg-green-100 text-green-700', browser: 'bg-orange-100 text-orange-700' }
    return <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${colors[p]}`}>{platformLabel(p)}</span>
  }

  return (
    <div>
      <h1 className="text-base font-semibold text-notion-text-primary mb-4">{t('title')}</h1>

      {/* Tab navigation */}
      <div className="flex gap-4 border-b border-notion-border mb-4">
        <button
          onClick={() => setActiveTab('general')}
          className={`pb-2 text-xs font-medium border-b-2 ${activeTab === 'general' ? 'border-notion-accent text-notion-text-primary' : 'border-transparent text-notion-text-muted hover:text-notion-text-secondary'}`}
        >
          {t('tabs.general')}
        </button>
        <button
          onClick={() => setActiveTab('knowledge')}
          className={`pb-2 text-xs font-medium border-b-2 ${activeTab === 'knowledge' ? 'border-notion-accent text-notion-text-primary' : 'border-transparent text-notion-text-muted hover:text-notion-text-secondary'}`}
        >
          {t('tabs.knowledge')}
        </button>
      </div>

      {/* ─── Knowledge Tab ─── */}
      {activeTab === 'knowledge' && (
        <div>
          {/* Filter + Add */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex gap-1">
              {(['all', 'mac', 'windows', 'browser'] as const).map(f => (
                <button
                  key={f}
                  onClick={() => setKnowledgeFilter(f)}
                  className={`px-2 py-1 text-[10px] rounded ${knowledgeFilter === f ? 'bg-notion-accent text-white' : 'bg-notion-bg-secondary text-notion-text-muted hover:bg-notion-hover'}`}
                >
                  {f === 'all' ? t('knowledge.filter.all') : platformLabel(f as KnowledgePlatform)}
                </button>
              ))}
            </div>
            <button
              onClick={() => setEditingKnowledge({
                name: '', app: '', platform: 'browser', aliases: [], body: '', isBuiltin: false,
              })}
              className="px-2 py-1 bg-notion-accent text-white text-xs rounded hover:bg-neutral-700"
            >
              {t('knowledge.add')}
            </button>
          </div>

          {/* Knowledge editor */}
          {editingKnowledge && (
            <div className="mb-4 p-3 border border-notion-border rounded bg-notion-bg-secondary">
              <h3 className="text-xs font-semibold mb-2">{editingKnowledge.name ? t('knowledge.edit') : t('knowledge.add')}</h3>
              <div className="grid grid-cols-2 gap-2 mb-2">
                <div>
                  <label className="text-[10px] text-notion-text-muted block mb-0.5">{t('knowledge.form.name')}</label>
                  <input
                    value={editingKnowledge.name}
                    onChange={e => setEditingKnowledge({ ...editingKnowledge, name: e.target.value })}
                    placeholder="my-custom-app"
                    className="w-full px-2 py-1 border border-notion-border rounded text-xs focus:outline-none focus:ring-1 focus:ring-notion-accent/30"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-notion-text-muted block mb-0.5">{t('knowledge.form.displayName')}</label>
                  <input
                    value={editingKnowledge.app ?? ''}
                    onChange={e => setEditingKnowledge({ ...editingKnowledge, app: e.target.value })}
                    placeholder="My App"
                    className="w-full px-2 py-1 border border-notion-border rounded text-xs focus:outline-none focus:ring-1 focus:ring-notion-accent/30"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-notion-text-muted block mb-0.5">{t('knowledge.form.platform')}</label>
                  <select
                    value={editingKnowledge.platform}
                    onChange={e => setEditingKnowledge({ ...editingKnowledge, platform: e.target.value as KnowledgePlatform })}
                    className="w-full px-2 py-1 border border-notion-border rounded text-xs focus:outline-none"
                  >
                    <option value="mac">{t('knowledge.filter.mac')}</option>
                    <option value="windows">{t('knowledge.filter.windows')}</option>
                    <option value="browser">{t('knowledge.filter.browser')}</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-notion-text-muted block mb-0.5">{t('knowledge.form.aliases')}</label>
                  <input
                    value={(editingKnowledge.aliases ?? []).join(', ')}
                    onChange={e => setEditingKnowledge({ ...editingKnowledge, aliases: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                    placeholder="Slack, slack"
                    className="w-full px-2 py-1 border border-notion-border rounded text-xs focus:outline-none focus:ring-1 focus:ring-notion-accent/30"
                  />
                </div>
              </div>
              {editingKnowledge.platform === 'mac' && (
                <div className="mb-2">
                  <label className="text-[10px] text-notion-text-muted block mb-0.5">{t('knowledge.form.bundleIds')}</label>
                  <input
                    value={(editingKnowledge.bundleIds ?? []).join(', ')}
                    onChange={e => setEditingKnowledge({ ...editingKnowledge, bundleIds: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                    placeholder="com.example.app"
                    className="w-full px-2 py-1 border border-notion-border rounded text-xs focus:outline-none focus:ring-1 focus:ring-notion-accent/30"
                  />
                </div>
              )}
              <div className="mb-2">
                <label className="text-[10px] text-notion-text-muted block mb-0.5">{t('knowledge.form.body')}</label>
                <textarea
                  value={editingKnowledge.body}
                  onChange={e => setEditingKnowledge({ ...editingKnowledge, body: e.target.value })}
                  className="w-full px-2 py-1.5 border border-notion-border rounded text-xs h-48 resize-y font-mono focus:outline-none focus:ring-1 focus:ring-notion-accent/30"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => handleSaveKnowledge(editingKnowledge)}
                  disabled={!editingKnowledge.name.trim()}
                  className="px-2 py-1 bg-notion-accent text-white text-xs rounded hover:bg-neutral-700 disabled:opacity-50"
                >
                  {t('knowledge.form.save')}
                </button>
                <button
                  onClick={() => setEditingKnowledge(null)}
                  className="px-2 py-1 text-xs text-notion-text-muted hover:bg-notion-hover rounded"
                >
                  {t('knowledge.form.cancel')}
                </button>
              </div>
            </div>
          )}

          {/* Viewing modal for built-in knowledge */}
          {viewingKnowledge && (
            <div className="mb-4 p-3 border border-notion-border rounded bg-notion-bg-secondary">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-semibold">{viewingKnowledge.app ?? viewingKnowledge.name}</h3>
                  {platformBadge(viewingKnowledge.platform)}
                  <span className="text-[10px] text-notion-text-muted">{t('knowledge.builtin')}</span>
                </div>
                <button onClick={() => setViewingKnowledge(null)} className="text-xs text-notion-text-muted hover:text-notion-text-primary">
                  ✕
                </button>
              </div>
              {viewingKnowledge.aliases && viewingKnowledge.aliases.length > 0 && (
                <p className="text-[10px] text-notion-text-muted mb-1">{t('knowledge.form.aliases')}: {viewingKnowledge.aliases.join(', ')}</p>
              )}
              <pre className="text-[10px] text-notion-text-secondary whitespace-pre-wrap bg-white/50 border border-notion-border rounded p-2 max-h-64 overflow-y-auto font-mono">
                {viewingKnowledge.body}
              </pre>
            </div>
          )}

          {/* Knowledge list */}
          {filteredKnowledge.length === 0 ? (
            <p className="text-xs text-notion-text-muted py-4 text-center">{t('knowledge.empty')}</p>
          ) : (
            <div className="space-y-1.5">
              {filteredKnowledge.map(k => (
                <div key={k.name} className="flex items-center justify-between p-2 border border-notion-border rounded hover:bg-notion-hover">
                  <div className="flex items-center gap-2 min-w-0">
                    {platformBadge(k.platform)}
                    <span className="text-xs font-medium text-notion-text-primary truncate">{k.app ?? k.name}</span>
                    {k.isBuiltin && <span className="text-[10px] text-notion-text-muted shrink-0">{t('knowledge.builtin')}</span>}
                    {k.description && <span className="text-[10px] text-notion-text-muted truncate">{k.description}</span>}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    {k.isBuiltin ? (
                      <button
                        onClick={() => setViewingKnowledge(k)}
                        className="px-1.5 py-0.5 text-[10px] text-notion-text-muted hover:bg-notion-hover rounded"
                      >
                        {t('knowledge.edit')}
                      </button>
                    ) : (
                      <>
                        <button
                          onClick={() => setEditingKnowledge({ ...k })}
                          className="px-1.5 py-0.5 text-[10px] text-notion-text-muted hover:bg-notion-hover rounded"
                        >
                          {t('knowledge.edit')}
                        </button>
                        <button
                          onClick={() => handleDeleteKnowledge(k.name)}
                          className="px-1.5 py-0.5 text-[10px] text-notion-danger hover:bg-red-50 rounded"
                        >
                          {t('knowledge.delete')}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ─── General Tab ─── */}
      {activeTab === 'general' && <>

      {/* Language */}
      <section className="mb-6">
        <h2 className="text-sm font-semibold text-notion-text-primary mb-2">{t('language.title')}</h2>
        <p className="text-[10px] text-notion-text-muted mb-2">{t('language.description')}</p>
        <select
          value={general.language ?? 'auto'}
          onChange={(e) => handleChangeLanguage(e.target.value as UiLanguage)}
          className="w-56 px-2 py-1.5 border border-notion-border rounded text-xs bg-white focus:outline-none focus:ring-2 focus:ring-notion-accent/30"
        >
          <option value="auto">{t('language.auto')}</option>
          <option value="en">{t('language.en')}</option>
          <option value="ja">{t('language.ja')}</option>
        </select>
      </section>

      {/* AI Providers */}
      <section className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-notion-text-primary">{t('providers.title')}</h2>
          <button
            onClick={() =>
              setEditingProvider({
                id: crypto.randomUUID(),
                name: '',
                type: 'anthropic',
                apiKey: '',
                model: '',
                isActive: false,
              })
            }
            className="px-2 py-1 bg-notion-accent text-white text-xs rounded hover:bg-neutral-700"
          >
            {t('providers.add')}
          </button>
        </div>

        <div className="space-y-2">
          {providers.map((p) =>
            editingProvider?.id === p.id ? (
              <ProviderForm
                key={p.id}
                provider={editingProvider}
                onSave={handleSaveProvider}
                onCancel={() => setEditingProvider(null)}
              />
            ) : (
              <div
                key={p.id}
                className="flex items-center gap-2 p-2 border border-notion-border rounded"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-notion-text-primary">
                      {p.name}
                    </span>
                    {p.isActive && (
                      <span className="px-1.5 py-0.5 bg-green-50 text-notion-success text-[10px] rounded">
                        {t('providers.active')}
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] text-notion-text-muted">
                    {p.type} / {p.model}
                  </span>
                </div>
                <button
                  onClick={() => setEditingProvider(p)}
                  className="px-2 py-1 text-xs text-notion-text-secondary hover:bg-notion-hover rounded"
                >
                  {t('providers.edit')}
                </button>
                <button
                  onClick={() => handleDeleteProvider(p.id)}
                  className="px-2 py-1 text-xs text-notion-danger hover:bg-red-50 rounded"
                >
                  {t('providers.delete')}
                </button>
              </div>
            )
          )}

          {editingProvider && !providers.find((p) => p.id === editingProvider.id) && (
            <ProviderForm
              provider={editingProvider}
              onSave={handleSaveProvider}
              onCancel={() => setEditingProvider(null)}
            />
          )}
        </div>
      </section>

      {/* Profiles */}
      <section className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-notion-text-primary">
            {t('profiles.title')}
          </h2>
        </div>

        <p className="text-[10px] text-notion-text-muted mb-2">
          {t('profiles.description')}
        </p>

        <div className="space-y-2 mb-3">
          {profiles.map((p) => (
            <div
              key={p.id}
              className="flex items-center gap-2 p-2 border border-notion-border rounded"
            >
              <span className="text-xs font-medium text-notion-text-primary flex-1">
                {p.name}
              </span>
              <span className="text-[10px] text-notion-text-muted">
                {new Date(p.updatedAt).toLocaleDateString(locale)}
              </span>
              <button
                onClick={() => handleOpenBrowser(p.id)}
                className="px-2 py-1 border border-notion-border text-xs rounded hover:bg-notion-hover"
              >
                {t('profiles.open')}
              </button>
              <button
                onClick={() => handleDeleteProfile(p.id)}
                className="px-2 py-1 text-xs text-notion-danger hover:bg-red-50 rounded"
              >
                {t('profiles.delete')}
              </button>
            </div>
          ))}

          {profiles.length === 0 && (
            <p className="text-xs text-notion-text-muted py-2">
              {t('profiles.empty')}
            </p>
          )}
        </div>

        <div className="flex gap-2">
          <input
            type="text"
            value={newProfileName}
            onChange={(e) => setNewProfileName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !isComposing() && handleCreateProfile()}
            {...compositionProps}
            placeholder={t('profiles.namePlaceholder')}
            className="flex-1 px-2 py-1.5 border border-notion-border rounded text-xs focus:outline-none focus:ring-2 focus:ring-notion-accent/30"
          />
          <button
            onClick={handleCreateProfile}
            className="px-2 py-1 bg-notion-accent text-white text-xs rounded hover:bg-neutral-700"
          >
            {t('profiles.add')}
          </button>
        </div>
      </section>

      {/* General Settings */}
      <section>
        <h2 className="text-sm font-semibold text-notion-text-primary mb-3">{t('general.title')}</h2>

        <div className="space-y-3">
          <div>
            <label className="block text-xs text-notion-text-secondary mb-1">
              {t('general.playwrightPath')}
            </label>
            <input
              type="text"
              value={general.playwrightExecutablePath}
              onChange={(e) =>
                setGeneral({ ...general, playwrightExecutablePath: e.target.value })
              }
              placeholder={t('general.playwrightPathHint')}
              className="w-full px-2 py-1.5 border border-notion-border rounded text-xs focus:outline-none focus:ring-2 focus:ring-notion-accent/30"
            />
          </div>

          <div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={general.defaultHeadless}
                onChange={(e) =>
                  setGeneral({ ...general, defaultHeadless: e.target.checked })
                }
                className="rounded"
              />
              {t('general.defaultHeadless')}
            </label>
          </div>

          <button
            onClick={handleSaveGeneral}
            className="px-2 py-1 bg-notion-accent text-white text-xs rounded hover:bg-neutral-700"
          >
            {t('general.save')}
          </button>
        </div>
      </section>

      </>}
    </div>
  )
}
