import { ipcMain, safeStorage } from 'electron'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { AiProviderConfig, GeneralSettings, UiLanguage } from '../../shared/types'
import { testProvider } from './aiService'

function getSettingsDir(): string {
  const dir = path.join(app.getPath('userData'), 'settings')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function getProvidersPath(): string {
  return path.join(getSettingsDir(), 'providers.json')
}

function getGeneralPath(): string {
  return path.join(getSettingsDir(), 'general.json')
}

function encryptApiKey(key: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(key).toString('base64')
  }
  return key
}

function decryptApiKey(encrypted: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch {
      return encrypted // fallback for unencrypted keys
    }
  }
  return encrypted
}

// Sentinel returned from settings:getProviders in place of the real API key.
// The renderer must send this value back unchanged on save if it doesn't want
// to rotate the key; the main process will then load the stored key from disk.
// Never equal to any real API key, and never persisted to disk.
const API_KEY_MASK = '__STORED_API_KEY__'

function readProviders(): AiProviderConfig[] {
  const filePath = getProvidersPath()
  if (!fs.existsSync(filePath)) return []
  const raw: AiProviderConfig[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  return raw.map((p) => ({ ...p, apiKey: decryptApiKey(p.apiKey) }))
}

/**
 * Renderer-safe provider list. The real API key never leaves the main process;
 * every non-empty key is replaced by {@link API_KEY_MASK}. Used by
 * `settings:getProviders` so that the renderer/devtools/logs can only see the
 * sentinel. Save/test/fetchModels flows handle the sentinel by loading the
 * stored key from disk on the main side.
 */
function readProvidersMasked(): AiProviderConfig[] {
  return readProviders().map((p) => ({
    ...p,
    apiKey: p.apiKey ? API_KEY_MASK : '',
  }))
}

/** Returns the stored (decrypted) API key for a provider id, or null if not found. */
function loadStoredApiKey(id: string): string | null {
  const providers = readProviders()
  const found = providers.find((p) => p.id === id)
  return found ? found.apiKey : null
}

/**
 * Resolves an incoming provider config that may contain the API key mask to a
 * fully-populated config whose apiKey is the real decrypted key. If the
 * incoming key is the mask and no stored key can be found (new provider, or id
 * mismatch), the apiKey is left as an empty string.
 */
function resolveMaskedApiKey(config: AiProviderConfig): AiProviderConfig {
  if (config.apiKey !== API_KEY_MASK) return config
  const stored = loadStoredApiKey(config.id)
  return { ...config, apiKey: stored ?? '' }
}

function writeProviders(providers: AiProviderConfig[]): void {
  const encrypted = providers.map((p) => ({
    ...p,
    apiKey: encryptApiKey(p.apiKey),
  }))
  fs.writeFileSync(getProvidersPath(), JSON.stringify(encrypted, null, 2))
}

async function fetchModelList(
  type: AiProviderConfig['type'],
  apiKey: string,
  baseUrl?: string
): Promise<string[]> {
  try {
    switch (type) {
      case 'anthropic': {
        const res = await fetch('https://api.anthropic.com/v1/models', {
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
        })
        if (!res.ok) throw new Error(`Anthropic API: ${res.status}`)
        const data = (await res.json()) as { data: Array<{ id: string }> }
        return data.data
          .map((m) => m.id)
          .filter((id) => id.includes('claude'))
          .sort()
      }

      case 'openai': {
        const res = await fetch('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${apiKey}` },
        })
        if (!res.ok) throw new Error(`OpenAI API: ${res.status}`)
        const data = (await res.json()) as { data: Array<{ id: string }> }
        return data.data
          .map((m) => m.id)
          .filter(
            (id) =>
              !id.includes('embedding') &&
              !id.includes('whisper') &&
              !id.includes('tts') &&
              !id.includes('dall-e') &&
              !id.includes('moderation')
          )
          .sort()
      }

      case 'google': {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100`
        )
        if (!res.ok) throw new Error(`Google API: ${res.status}`)
        const data = (await res.json()) as {
          models: Array<{
            name: string
            supportedGenerationMethods?: string[]
          }>
        }
        return data.models
          .filter((m) =>
            m.supportedGenerationMethods?.includes('generateContent')
          )
          .map((m) => m.name.replace('models/', ''))
          .sort()
      }

      case 'openai-compatible': {
        const base = baseUrl ?? 'https://api.openai.com/v1'
        const res = await fetch(`${base}/models`, {
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        })
        if (!res.ok) throw new Error(`API: ${res.status}`)
        const data = (await res.json()) as { data: Array<{ id: string }> }
        return data.data.map((m) => m.id).sort()
      }

      default:
        return []
    }
  } catch (err) {
    console.error('Failed to fetch models:', err)
    throw err
  }
}

export function getActiveProvider(): AiProviderConfig | null {
  const providers = readProviders()
  return providers.find((p) => p.isActive) ?? null
}

export function registerSettingsHandlers(): void {
  ipcMain.handle('settings:getProviders', async () => {
    // SECURITY: never return decrypted API keys to the renderer. Stored keys
    // are replaced by a sentinel that save/test/fetchModels know how to
    // resolve back to the real key on the main side.
    return readProvidersMasked()
  })

  ipcMain.handle('settings:saveProvider', async (_event, incoming: AiProviderConfig) => {
    // If the renderer returned the mask unchanged, preserve the stored key.
    const config = resolveMaskedApiKey(incoming)
    const providers = readProviders()
    const idx = providers.findIndex((p) => p.id === config.id)

    // If setting this provider as active, deactivate others
    if (config.isActive) {
      providers.forEach((p) => (p.isActive = false))
    }

    if (idx >= 0) {
      providers[idx] = config
    } else {
      providers.push(config)
    }

    writeProviders(providers)
  })

  ipcMain.handle('settings:deleteProvider', async (_event, id: string) => {
    const providers = readProviders().filter((p) => p.id !== id)
    writeProviders(providers)
  })

  ipcMain.handle(
    'settings:fetchModels',
    async (
      _event,
      params: {
        type: AiProviderConfig['type']
        apiKey: string
        baseUrl?: string
        /** Optional provider id. If apiKey is the mask, the stored key for this id is used. */
        providerId?: string
      }
    ): Promise<string[]> => {
      let apiKey = params.apiKey
      if (apiKey === API_KEY_MASK) {
        apiKey = (params.providerId && loadStoredApiKey(params.providerId)) || ''
      }
      return fetchModelList(params.type, apiKey, params.baseUrl)
    }
  )

  ipcMain.handle('settings:testProvider', async (_event, incoming: AiProviderConfig) => {
    // Same mask-resolution as save, so "接続テスト" works on existing providers
    // without forcing the user to retype their key.
    const config = resolveMaskedApiKey(incoming)
    // Delegate to AI service
    return testProvider(config)
  })

  ipcMain.handle('settings:getGeneral', async () => {
    const filePath = getGeneralPath()
    if (!fs.existsSync(filePath)) {
      return { playwrightExecutablePath: '', defaultHeadless: false, language: 'auto' as UiLanguage }
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    // Backfill language for older config files so the renderer never sees undefined.
    if (!parsed.language) parsed.language = 'auto'
    return parsed
  })

  ipcMain.handle('settings:saveGeneral', async (_event, settings: GeneralSettings) => {
    fs.writeFileSync(getGeneralPath(), JSON.stringify(settings, null, 2))
  })

  /**
   * Returns the OS locale (e.g. 'ja-JP', 'en-US'). The renderer uses this to
   * resolve the 'auto' language preference at app start.
   */
  ipcMain.handle('settings:getSystemLocale', async () => {
    return app.getLocale()
  })

  /**
   * Returns the effective UI language ('en' or 'ja'), resolving 'auto' against
   * the OS locale. Centralized here so prompts in the main process can also
   * read the user's UI language to produce localized AI output.
   */
  ipcMain.handle('settings:getUiLanguage', async () => {
    return resolveUiLanguage()
  })
}

/**
 * Read the saved language preference and resolve 'auto' to a concrete
 * language. Used both by the IPC handler and by main-process code that
 * localizes AI output via the `Respond in {lang}` prompt directive.
 */
export function resolveUiLanguage(): 'en' | 'ja' {
  const filePath = getGeneralPath()
  let pref: UiLanguage = 'auto'
  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      if (parsed.language === 'en' || parsed.language === 'ja') pref = parsed.language
      else if (parsed.language === 'auto') pref = 'auto'
    } catch {
      // fall through to 'auto'
    }
  }
  if (pref === 'en' || pref === 'ja') return pref
  const sys = app.getLocale() || ''
  return sys.toLowerCase().startsWith('ja') ? 'ja' : 'en'
}
