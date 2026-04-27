import type { ReactNode } from 'react'
import Sidebar from './Sidebar'

interface LayoutProps {
  children: ReactNode
}

export default function Layout({ children }: LayoutProps) {
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-auto bg-notion-bg">
        <div className="max-w-4xl mx-auto px-6 py-4">{children}</div>
      </main>
    </div>
  )
}
