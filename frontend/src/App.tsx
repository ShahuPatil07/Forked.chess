import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useUserStore } from './store/userStore'
import Onboarding from './pages/Onboarding'
import Loading from './pages/Loading'
import Dashboard from './pages/Dashboard'
import BlindspotDetail from './pages/BlindspotDetail'
import PuzzleSession from './pages/PuzzleSession'
import GameHistory from './pages/GameHistory'
import Settings from './pages/Settings'
import AnalysisBoard from './pages/AnalysisBoard'
import AppShell from './components/layout/AppShell'

function RequireUser({ children }: { children: React.ReactNode }) {
  const { username } = useUserStore()
  if (!username) return <Navigate to="/" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Onboarding />} />
        <Route path="/loading/:jobId" element={<Loading />} />

        <Route element={<RequireUser><AppShell /></RequireUser>}>
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/blindspot/:id" element={<BlindspotDetail />} />
          <Route path="/session" element={<PuzzleSession />} />
          <Route path="/history" element={<GameHistory />} />
          <Route path="/analysis" element={<AnalysisBoard />} />
          <Route path="/settings" element={<Settings />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
