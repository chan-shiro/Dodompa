import { Routes, Route, Navigate } from 'react-router'
import Layout from './components/Layout'
import TaskList from './pages/TaskList'
import TaskDetail from './pages/TaskDetail'
import LogViewer from './pages/LogViewer'
import Settings from './pages/Settings'

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/tasks" replace />} />
        <Route path="/tasks" element={<TaskList />} />
        <Route path="/tasks/:id" element={<TaskDetail />} />
        <Route path="/logs" element={<LogViewer />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </Layout>
  )
}
