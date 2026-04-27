import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import * as api from '../lib/api'

import enCommon from './locales/en/common.json'
import enSidebar from './locales/en/sidebar.json'
import enTaskList from './locales/en/taskList.json'
import enTaskDetail from './locales/en/taskDetail.json'
import enTaskGeneration from './locales/en/taskGeneration.json'
import enLogViewer from './locales/en/logViewer.json'
import enSettings from './locales/en/settings.json'
import enStepCard from './locales/en/stepCard.json'
import enVariableEditor from './locales/en/variableEditor.json'
import enCleanupModal from './locales/en/cleanupModal.json'
import enAiModal from './locales/en/aiModal.json'
import enRefactorModal from './locales/en/refactorModal.json'

import jaCommon from './locales/ja/common.json'
import jaSidebar from './locales/ja/sidebar.json'
import jaTaskList from './locales/ja/taskList.json'
import jaTaskDetail from './locales/ja/taskDetail.json'
import jaTaskGeneration from './locales/ja/taskGeneration.json'
import jaLogViewer from './locales/ja/logViewer.json'
import jaSettings from './locales/ja/settings.json'
import jaStepCard from './locales/ja/stepCard.json'
import jaVariableEditor from './locales/ja/variableEditor.json'
import jaCleanupModal from './locales/ja/cleanupModal.json'
import jaAiModal from './locales/ja/aiModal.json'
import jaRefactorModal from './locales/ja/refactorModal.json'

export const resources = {
  en: {
    common: enCommon,
    sidebar: enSidebar,
    taskList: enTaskList,
    taskDetail: enTaskDetail,
    taskGeneration: enTaskGeneration,
    logViewer: enLogViewer,
    settings: enSettings,
    stepCard: enStepCard,
    variableEditor: enVariableEditor,
    cleanupModal: enCleanupModal,
    aiModal: enAiModal,
    refactorModal: enRefactorModal,
  },
  ja: {
    common: jaCommon,
    sidebar: jaSidebar,
    taskList: jaTaskList,
    taskDetail: jaTaskDetail,
    taskGeneration: jaTaskGeneration,
    logViewer: jaLogViewer,
    settings: jaSettings,
    stepCard: jaStepCard,
    variableEditor: jaVariableEditor,
    cleanupModal: jaCleanupModal,
    aiModal: jaAiModal,
    refactorModal: jaRefactorModal,
  },
} as const

export type AppLanguage = 'en' | 'ja'

/** Resolve a system-locale string (e.g. "ja-JP", "en-US") to an app language. */
export function resolveLanguage(locale: string): AppLanguage {
  return locale.toLowerCase().startsWith('ja') ? 'ja' : 'en'
}

/**
 * Initialize i18next. The app always boots in English first so React doesn't
 * flash Japanese while we read the saved preference; we then switch to the
 * user's preference or resolved system locale asynchronously.
 */
export async function initI18n(): Promise<void> {
  await i18n.use(initReactI18next).init({
    resources,
    lng: 'en',
    fallbackLng: 'en',
    defaultNS: 'common',
    ns: Object.keys(resources.en),
    interpolation: {
      escapeValue: false, // React already escapes
    },
    returnEmptyString: false,
  })

  // Resolve the real language and switch if different.
  try {
    const lang = await api.getUiLanguage()
    if (lang !== i18n.language) {
      await i18n.changeLanguage(lang)
    }
  } catch {
    // Fall back to browser locale if IPC isn't ready.
    const lang = resolveLanguage(navigator.language || 'en')
    if (lang !== i18n.language) await i18n.changeLanguage(lang)
  }
}

export async function setAppLanguage(lang: AppLanguage): Promise<void> {
  if (i18n.language !== lang) await i18n.changeLanguage(lang)
}

export default i18n
