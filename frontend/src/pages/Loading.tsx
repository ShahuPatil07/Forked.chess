import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useUserStore } from '../store/userStore'
import { subscribeToIngest } from '../api'
import type { IngestProgress } from '../types'

const TIPS = [
  'Pawnprint clusters your mistakes, not just counts them.',
  'The "other" category often hides the most interesting patterns.',
  'Back-rank weaknesses are the most common blindspot after 1400 ELO.',
  'Spaced repetition beats marathon sessions for tactical memory.',
  'Most 1400-1600 players have 3-5 core recurring blindspots.',
  'Deep annotation finds patterns you wouldn\'t notice reviewing on your own.',
]

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="w-full h-1.5 bg-bg-3 rounded-full overflow-hidden">
      <motion.div
        className="h-full bg-gradient-to-r from-accent to-purple-400 rounded-full"
        initial={{ width: '0%' }}
        animate={{ width: `${pct}%` }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
      />
    </div>
  )
}

export default function Loading() {
  const { jobId } = useParams<{ jobId: string }>()
  const navigate = useNavigate()
  const { username, setUser } = useUserStore()
  const [progress, setProgress] = useState<IngestProgress>({
    type: 'progress', pct: 0, message: 'Starting...', stage: 'fetching',
  })
  const [tipIdx, setTipIdx] = useState(0)

  // Cycle tips every 8 seconds
  useEffect(() => {
    const id = setInterval(() => setTipIdx((i) => (i + 1) % TIPS.length), 8000)
    return () => clearInterval(id)
  }, [])

  // SSE subscription
  useEffect(() => {
    if (!jobId) return
    const unsubscribe = subscribeToIngest(jobId, (evt) => {
      setProgress(evt)
      if (evt.type === 'done') {
        setUser({ activeJobId: null })
        setTimeout(() => navigate('/dashboard'), 1200)
      }
      if (evt.type === 'error') {
        // stay on page, show error
      }
    })
    return unsubscribe
  }, [jobId, navigate, setUser])

  const pct = progress.pct ?? 0
  const isError = progress.type === 'error'
  const isDone  = progress.type === 'done'

  const stageLabel = {
    fetching:   'Fetching games',
    annotating: 'Annotating with Stockfish',
    clustering: 'Finding blindspot patterns',
  }[progress.stage ?? 'fetching'] ?? 'Working...'

  return (
    <div className="min-h-screen bg-bg-0 flex flex-col items-center justify-center px-4">
      <div
        className="fixed inset-0 pointer-events-none opacity-[0.03]"
        style={{
          backgroundImage: 'linear-gradient(#7B61FF 1px, transparent 1px), linear-gradient(90deg, #7B61FF 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      />

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-lg"
      >
        {/* Logo */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-accent/15 border border-accent/30 text-2xl mb-3">
            ♞
          </div>
          <h1 className="text-xl font-semibold text-text-0">
            {isDone ? 'Your profile is ready!' : 'Learning how you play...'}
          </h1>
          <p className="text-text-2 text-sm mt-1">
            {username && `Analysing ${username}'s games`}
          </p>
        </div>

        {/* Progress card */}
        <div className="card p-6 space-y-5">
          {/* Stage indicators */}
          <div className="flex items-center gap-3 text-sm">
            {(['fetching', 'annotating', 'clustering'] as const).map((s, i) => {
              const stageOrder = { fetching: 0, annotating: 1, clustering: 2 }
              const currentOrder = stageOrder[progress.stage ?? 'fetching']
              const done = stageOrder[s] < currentOrder || isDone
              const active = s === progress.stage && !isDone

              return (
                <div key={s} className="flex items-center gap-1.5">
                  <div className={`w-2 h-2 rounded-full transition-colors duration-300
                    ${done ? 'bg-success' : active ? 'bg-accent animate-pulse' : 'bg-bg-3'}`}
                  />
                  <span className={done || active ? 'text-text-0' : 'text-text-2'}>
                    {['Fetch', 'Annotate', 'Cluster'][i]}
                  </span>
                  {i < 2 && <span className="text-text-2 mx-1">·</span>}
                </div>
              )
            })}
          </div>

          {/* Progress bar */}
          <ProgressBar pct={isDone ? 100 : pct} />

          {/* Status message */}
          <div className="space-y-1">
            <p className="text-sm font-medium text-text-0">
              {isError ? 'Analysis failed' : isDone ? 'Complete!' : stageLabel}
            </p>
            <p className="text-xs text-text-1">
              {isError ? progress.message : progress.message ?? ''}
            </p>
          </div>

          {/* Stats row */}
          {!isError && (
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-bg-2 rounded-md p-3 text-center">
                <p className="text-lg font-bold text-text-0">
                  {isDone ? progress.mistakes_found : progress.games_done ?? 0}
                  {!isDone && <span className="text-text-2 text-sm font-normal">/{progress.games_total ?? '?'}</span>}
                </p>
                <p className="text-xs text-text-2 mt-0.5">{isDone ? 'Mistakes' : 'Games'}</p>
              </div>
              <div className="bg-bg-2 rounded-md p-3 text-center">
                <p className="text-lg font-bold text-text-0">
                  {isDone ? progress.clusters_count : progress.mistakes_found ?? 0}
                </p>
                <p className="text-xs text-text-2 mt-0.5">{isDone ? 'Blindspots' : 'Patterns'}</p>
              </div>
              <div className="bg-bg-2 rounded-md p-3 text-center">
                <p className="text-lg font-bold text-accent">{pct}%</p>
                <p className="text-xs text-text-2 mt-0.5">Progress</p>
              </div>
            </div>
          )}

          {isError && (
            <div className="space-y-3">
              <p className="text-sm text-danger bg-danger/10 border border-danger/20 rounded-md px-3 py-2">
                {progress.message}
              </p>
              <button
                onClick={() => navigate('/')}
                className="btn-ghost w-full text-center"
              >
                Try again
              </button>
            </div>
          )}

          {isDone && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="text-center"
            >
              <div className="inline-flex items-center gap-2 text-success text-sm font-medium">
                <div className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
                Redirecting to your dashboard...
              </div>
            </motion.div>
          )}
        </div>

        {/* Tip carousel */}
        <div className="mt-6 px-2">
          <AnimatePresence mode="wait">
            <motion.p
              key={tipIdx}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.3 }}
              className="text-xs text-text-2 text-center leading-relaxed"
            >
              {TIPS[tipIdx]}
            </motion.p>
          </AnimatePresence>
        </div>

        {!isDone && !isError && (
          <p className="text-xs text-text-2 text-center mt-4">
            Deep annotation takes 30–60 minutes. You can keep this tab open.
          </p>
        )}
      </motion.div>
    </div>
  )
}
