import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation, useSearchParams } from 'react-router-dom'
import { useUserStore } from './store/userStore'
import { authApi } from './api/auth'
import Landing from './pages/Home'
import AuthPage from './pages/AuthPage'
import Hub from './pages/Hub'
import AppShell, { PageFallback } from './components/layout/AppShell'
import { ChessBackground } from './components/layout/ChessBackground'
import { DevSignIn } from './components/auth/DevSignIn'
import { devSkipActive, resumeDevSkip } from './lib/devAuth'

// Every section is its own chunk: the first load only carries the landing page,
// sign-in, the shell and the hub. AppShell wraps its <Outlet/> in <Suspense>.
const Loading = lazy(() => import('./pages/Loading'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const BlindspotDetail = lazy(() => import('./pages/BlindspotDetail'))
const PuzzleSession = lazy(() => import('./pages/PuzzleSession'))
const PuzzleThemes = lazy(() => import('./pages/PuzzleThemes'))
const PuzzleTrainer = lazy(() => import('./pages/PuzzleTrainer'))
const GameHistory = lazy(() => import('./pages/GameHistory'))
const Settings = lazy(() => import('./pages/Settings'))
const AnalysisBoard = lazy(() => import('./pages/AnalysisBoard'))
const BotGame = lazy(() => import('./pages/BotGame'))
const OpeningExplorer = lazy(() => import('./pages/OpeningExplorer'))
const Endgames = lazy(() => import('./pages/Endgames'))
const MistakeReplay = lazy(() => import('./pages/MistakeReplay'))
const Coach = lazy(() => import('./pages/Coach'))
const ShareScreen = lazy(() => import('./pages/ShareScreen'))
const GameReview = lazy(() => import('./pages/GameReview'))
const WarmupPage = lazy(() => import('./features/warmup/WarmupPage'))
const WarmupLab = lazy(() => import('./features/warmup/WarmupLab'))
// OTB Scan pulls in TFJS (~1.6MB)
const OTBScanPage = lazy(() => import('./features/otb-scan/OTBScanPage'))

/** Signed-in only: unknown visitors go to the sign-in page and come back afterwards.
 *  In `npm run dev` the developer is signed in automatically instead (lib/devAuth.ts). */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { token, username } = useUserStore()
  const location = useLocation()
  if (!token || !username) {
    const next = location.pathname + location.search
    if (devSkipActive()) return <DevSignIn next={next} />
    return <Navigate to={`/auth?next=${encodeURIComponent(next)}`} replace />
  }
  return <>{children}</>
}

/** /dev — one link that signs in as the developer (when the backend allows it). */
function DevRoute() {
  const [params] = useSearchParams()
  const next = params.get('next') || '/home'
  resumeDevSkip()
  return <DevSignIn next={next.startsWith('/') ? next : '/home'} />
}

/** Re-validate a stored session once per load and refresh the account details. */
function SessionCheck() {
  const { token, signIn, clearUser } = useUserStore()
  useEffect(() => {
    if (!token) return
    authApi.me()
      .then(({ user }) => signIn(token, user))
      .catch(err => { if (/sign in/i.test(String(err))) clearUser() })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}

export default function App() {
  return (
    <BrowserRouter>
      <ChessBackground />
      <SessionCheck />
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/auth" element={<AuthPage />} />
        <Route path="/dev" element={<DevRoute />} />
        <Route path="/loading/:jobId" element={<RequireAuth><Suspense fallback={<PageFallback />}><Loading /></Suspense></RequireAuth>} />
        {/* Focused full-screen replay — outside AppShell */}
        <Route path="/replay/:clusterId" element={<RequireAuth><Suspense fallback={<PageFallback />}><MistakeReplay /></Suspense></RequireAuth>} />

        <Route element={<RequireAuth><AppShell /></RequireAuth>}>
          {/* Tree navigation: the hub of big blocks, then each section's sub-blocks */}
          <Route path="/home" element={<Hub />} />
          <Route path="/home/:section" element={<Hub />} />
          <Route path="/share-screen" element={<ShareScreen />} />
          <Route path="/game-review" element={<GameReview />} />
          <Route path="/game-review/:reviewId" element={<GameReview />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/coach" element={<Coach />} />
          <Route path="/blindspot/:id" element={<BlindspotDetail />} />
          <Route path="/session" element={<PuzzleSession />} />
          <Route path="/puzzles" element={<PuzzleThemes />} />
          <Route path="/warmup" element={<WarmupPage />} />
          <Route path="/warmup/lab" element={<WarmupLab />} />
          <Route path="/puzzles/:angle" element={<PuzzleTrainer />} />
          <Route path="/history" element={<GameHistory />} />
          <Route path="/analysis" element={<AnalysisBoard />} />
          <Route path="/otb-scan" element={<OTBScanPage />} />
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
