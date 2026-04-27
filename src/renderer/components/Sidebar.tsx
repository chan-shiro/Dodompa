import { NavLink, useLocation } from 'react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TaskDefinition } from '../lib/types'
import * as api from '../lib/api'

function NavItem({
  to,
  icon,
  label,
  indent = false,
}: {
  to: string
  icon: string
  label: string
  indent?: boolean
}) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors ${
          indent ? 'ml-2' : ''
        } ${
          isActive
            ? 'bg-notion-hover text-notion-text-primary font-medium'
            : 'text-notion-text-secondary hover:bg-notion-hover'
        }`
      }
    >
      <span className="w-4 text-center text-sm">{icon}</span>
      <span className="truncate">{label}</span>
    </NavLink>
  )
}

export default function Sidebar() {
  const [tasks, setTasks] = useState<TaskDefinition[]>([])
  const location = useLocation()
  const { t } = useTranslation('sidebar')

  useEffect(() => {
    api.listTasks().then(setTasks).catch(console.error)
  }, [location.pathname])

  return (
    <aside className="w-48 flex-shrink-0 bg-notion-sidebar border-r border-notion-border flex flex-col">
      {/* Drag region for macOS title bar */}
      <div className="h-10 flex-shrink-0 draggable" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />

      <nav className="flex-1 px-1.5 pb-3 space-y-0.5 overflow-auto">
        <NavItem to="/tasks" icon="📋" label={t('taskList')} />

        {/* Task list */}
        {tasks.length > 0 && (
          <div className="mt-3">
            <p className="px-2 py-0.5 text-[10px] font-medium text-notion-text-muted uppercase tracking-wider">
              {t('tasksSection')}
            </p>
            {tasks.map((task) => (
              <NavItem
                key={task.id}
                to={`/tasks/${task.id}`}
                icon="📄"
                label={typeof task.name === 'string' ? task.name : String(task.name?.name ?? task.name ?? '')}
                indent
              />
            ))}
          </div>
        )}

        <div className="mt-3">
          <p className="px-3 py-1 text-xs font-medium text-notion-text-muted uppercase tracking-wider">
            {t('logsSection')}
          </p>
          <NavItem to="/logs" icon="📊" label={t('executionLogs')} indent />
        </div>

        <div className="mt-3">
          <NavItem to="/settings" icon="⚙️" label={t('settings')} />
        </div>
      </nav>
    </aside>
  )
}
