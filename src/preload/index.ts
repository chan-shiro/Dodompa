import { contextBridge, ipcRenderer } from 'electron'

const electronAPI = {
  // Task management
  task: {
    list: () => ipcRenderer.invoke('task:list'),
    get: (id: string) => ipcRenderer.invoke('task:get', id),
    create: (name: string) => ipcRenderer.invoke('task:create', name),
    update: (id: string, data: unknown) => ipcRenderer.invoke('task:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('task:delete', id),
    deleteStep: (taskId: string, stepId: string) =>
      ipcRenderer.invoke('task:deleteStep', taskId, stepId),
    deleteAllSteps: (taskId: string) =>
      ipcRenderer.invoke('task:deleteAllSteps', taskId),
    readAllStepFiles: (taskId: string) =>
      ipcRenderer.invoke('task:readAllStepFiles', taskId),
    readStepFile: (taskId: string, stepFile: string) =>
      ipcRenderer.invoke('task:readStepFile', taskId, stepFile),
    writeStepFile: (taskId: string, stepFile: string, code: string) =>
      ipcRenderer.invoke('task:writeStepFile', taskId, stepFile, code),
    addStep: (taskId: string, stepType?: string) =>
      ipcRenderer.invoke('task:addStep', taskId, stepType),
    export: (taskId: string) =>
      ipcRenderer.invoke('task:export', taskId),
    import: () =>
      ipcRenderer.invoke('task:import'),
  },

  // Execution
  runner: {
    execute: (taskId: string, variables: Record<string, string>, fromStep?: string, toStep?: string, debugMode?: boolean) =>
      ipcRenderer.invoke('runner:execute', taskId, variables, fromStep, toStep, debugMode),
    rerunDebugStep: (taskId: string, stepId: string) =>
      ipcRenderer.invoke('runner:rerunDebugStep', taskId, stepId),
    endDebugSession: (taskId: string) =>
      ipcRenderer.invoke('runner:endDebugSession', taskId),
    confirmLogin: (executionId: string) =>
      ipcRenderer.invoke('runner:confirmLogin', executionId),
    onProgress: (cb: (event: unknown) => void) => {
      const handler = (_: unknown, e: unknown) => cb(e)
      ipcRenderer.on('runner:progress', handler)
      return () => ipcRenderer.removeListener('runner:progress', handler)
    },
  },

  // Logs
  log: {
    listExecutions: (taskId?: string) => ipcRenderer.invoke('log:listExecutions', taskId),
    getStepLogs: (executionId: string) => ipcRenderer.invoke('log:getStepLogs', executionId),
    listAiLogs: (taskId?: string) => ipcRenderer.invoke('log:listAiLogs', taskId),
    getStorageInfo: (taskId: string) => ipcRenderer.invoke('log:getStorageInfo', taskId),
    getTaskStats: () => ipcRenderer.invoke('log:getTaskStats'),
    cleanupOldData: (taskId: string, keepRecent?: number) =>
      ipcRenderer.invoke('log:cleanupOldData', taskId, keepRecent ?? 5),
  },

  // AI
  ai: {
    generateStep: (params: unknown) => ipcRenderer.invoke('ai:generateStep', params),
    analyzeAndFix: (params: unknown) => ipcRenderer.invoke('ai:analyzeAndFix', params),
    applyFix: (aiLogId: string, approved: boolean) =>
      ipcRenderer.invoke('ai:applyFix', aiLogId, approved),
    generateDescription: (params: { taskId: string }) =>
      ipcRenderer.invoke('ai:generateDescription', params),
    startAutonomousGeneration: (params: { taskId: string; instruction: string }) =>
      ipcRenderer.send('ai:startAutonomousGeneration', params),
    cancelGeneration: (taskId: string) =>
      ipcRenderer.invoke('ai:cancelGeneration', taskId),
    confirmLogin: (taskId: string) =>
      ipcRenderer.invoke('ai:confirmLogin', taskId),
    answerQuestion: (questionId: string, answer: string) =>
      ipcRenderer.invoke('ai:answerQuestion', questionId, answer),
    onGenerationProgress: (cb: (event: unknown) => void) => {
      const handler = (_: unknown, e: unknown) => cb(e)
      ipcRenderer.on('ai:generation-progress', handler)
      return () => ipcRenderer.removeListener('ai:generation-progress', handler)
    },
    getGenerationLogs: (taskId: string) => ipcRenderer.invoke('ai:getGenerationLogs', taskId),
    editStep: (params: { taskId: string; stepId: string; instruction: string }) =>
      ipcRenderer.invoke('ai:editStep', params),
    refactorTask: (params: { taskId: string; instruction: string; referenceTaskIds?: string[] }) =>
      ipcRenderer.invoke('ai:refactorTask', params),
    onRefactorProgress: (cb: (event: unknown) => void) => {
      const handler = (_: unknown, e: unknown) => cb(e)
      ipcRenderer.on('ai:refactor-progress', handler)
      return () => ipcRenderer.removeListener('ai:refactor-progress', handler)
    },
    onRefactorStream: (cb: (event: unknown) => void) => {
      const handler = (_: unknown, e: unknown) => cb(e)
      ipcRenderer.on('ai:refactor-stream', handler)
      return () => ipcRenderer.removeListener('ai:refactor-stream', handler)
    },
    suggestVariables: (params: { taskId: string; instruction?: string }) =>
      ipcRenderer.invoke('ai:suggestVariables', params),
  },

  // Profiles
  profile: {
    list: () => ipcRenderer.invoke('profile:list'),
    create: (name: string) => ipcRenderer.invoke('profile:create', name),
    delete: (profileId: string) => ipcRenderer.invoke('profile:delete', profileId),
    openBrowser: (profileId: string) => ipcRenderer.invoke('profile:openBrowser', profileId),
  },

  // Settings
  settings: {
    getProviders: () => ipcRenderer.invoke('settings:getProviders'),
    saveProvider: (config: unknown) => ipcRenderer.invoke('settings:saveProvider', config),
    deleteProvider: (id: string) => ipcRenderer.invoke('settings:deleteProvider', id),
    testProvider: (config: unknown) => ipcRenderer.invoke('settings:testProvider', config),
    fetchModels: (params: { type: string; apiKey: string; baseUrl?: string }) =>
      ipcRenderer.invoke('settings:fetchModels', params),
    getGeneral: () => ipcRenderer.invoke('settings:getGeneral'),
    saveGeneral: (settings: unknown) => ipcRenderer.invoke('settings:saveGeneral', settings),
    getSystemLocale: () => ipcRenderer.invoke('settings:getSystemLocale'),
    getUiLanguage: () => ipcRenderer.invoke('settings:getUiLanguage'),
  },

  // Knowledge
  knowledge: {
    list: () => ipcRenderer.invoke('knowledge:list'),
    get: (name: string) => ipcRenderer.invoke('knowledge:get', name),
    save: (entry: unknown) => ipcRenderer.invoke('knowledge:save', entry),
    delete: (name: string) => ipcRenderer.invoke('knowledge:delete', name),
  },

  // Screenshot
  screenshot: {
    read: (filePath: string) => ipcRenderer.invoke('screenshot:read', filePath),
  },

  // Desktop automation
  desktop: {
    checkPermission: () => ipcRenderer.invoke('desktop:checkPermission'),
    isSupported: () => ipcRenderer.invoke('desktop:isSupported'),
    listWindows: () => ipcRenderer.invoke('desktop:listWindows'),
    getTree: (pidOrApp: number | string, depth?: number) =>
      ipcRenderer.invoke('desktop:getTree', pidOrApp, depth),
    screenshot: (target?: { pid?: number }) =>
      ipcRenderer.invoke('desktop:screenshot', target),
    elementAtPoint: (x: number, y: number) =>
      ipcRenderer.invoke('desktop:elementAtPoint', x, y),
  },

  // Element Picker
  elementPicker: {
    onResult: (cb: (event: unknown) => void) => {
      const handler = (_: unknown, e: unknown) => cb(e)
      ipcRenderer.on('element-picker:result', handler)
      return () => ipcRenderer.removeListener('element-picker:result', handler)
    },
  },
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

export type ElectronAPI = typeof electronAPI
