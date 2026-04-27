/// <reference types="vite/client" />

interface Window {
  electronAPI: typeof import('./lib/api').electronAPI
}
