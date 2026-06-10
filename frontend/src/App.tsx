import { lazy, Suspense } from 'react'
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
import BotGame from './pages/BotGame'
import OpeningExplorer from './pages/OpeningExplorer'
import Endgames from './pages/Endgames'
import MistakeReplay from './pages/MistakeReplay'
import DNAPage from './pages/DNAPage'
import Coach from './pages/Coach'
import AppShell from './components/layout/AppShell'
import { ChessBackground } from './components/layout/ChessBackground'

// OTB Scan pulls in TFJS (~1.6MB) — lazy-load so it stays out of the main bundle.
const OTBScanPage = lazy(() => import('./features/otb-scan/OTBScanPage'))

function RequireUser({ children }: { children: React.ReactNode }) {
  const { username } = useUserStore()
  if (!username) return <Navigate to="/" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <BrowserRouter>
      <ChessBackground />
      <Routes>
        <Route path="/" element={<Onboarding />} />
        <Route path="/loading/:jobId" element={<Loading />} />
        {/* Public shareable Chess DNA — no auth. /card kept as legacy alias. */}
        <Route path="/dna/:username"  element={<DNAPage />} />
        <Route path="/card/:username" element={<DNAPage />} />
        {/* Focused full-screen replay — outside AppShell (no sidebar) */}
        <Route path="/replay/:clusterId" element={<RequireUser><MistakeReplay /></RequireUser>} />

        <Route element={<RequireUser><AppShell /></RequireUser>}>
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/coach" element={<Coach />} />
          <Route path="/blindspot/:id" element={<BlindspotDetail />} />
          <Route path="/session" element={<PuzzleSession />} />
          <Route path="/history" element={<GameHistory />} />
          <Route path="/analysis" element={<AnalysisBoard />} />
          <Route path="/otb-scan" element={
            <Suspense fallback={<div className="p-8 text-text-2 text-sm">Loading scanner…</div>}>
              <OTBScanPage />
            </Suspense>
          } />
          <Route path="/settings" element={<Settings />} />
          <Route path="/openings" element={<OpeningExplorer />} />
          <Route path="/endgames" element={<Endgames />} />
          <Route path="/bot-game"          element={<BotGame />} />
          <Route path="/bot-game/:gameId" element={<BotGame />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
