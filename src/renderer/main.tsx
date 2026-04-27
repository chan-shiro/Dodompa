import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router'
import App from './App'
import { initI18n } from './i18n'
import './index.css'

initI18n()
  .catch((err) => console.error('i18n init failed', err))
  .finally(() => {
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <HashRouter>
          <App />
        </HashRouter>
      </React.StrictMode>
    )
  })
