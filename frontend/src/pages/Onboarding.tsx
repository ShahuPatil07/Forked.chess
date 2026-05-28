import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowRight, Loader2 } from 'lucide-react'
import { useUserStore } from '../store/userStore'
import { api } from '../api'

type Platform = 'lichess' | 'chesscom'

const CHESS_FACTS = [
  'The longest recorded chess game has 269 moves.',
  'There are more possible chess games than atoms in the observable universe.',
  'The word "checkmate" comes from the Persian phrase "Shah Mat" — the king is dead.',
  'Magnus Carlsen became a Grandmaster at age 13.',
  'The second player wins in fewer than 1% of recorded grandmaster games.',
]

export default function Onboarding() {
  const navigate = useNavigate()
  const { setUser, username: storedUser } = useUserStore()

  const [platform, setPlatform] = useState<Platform>('lichess')
  const [username, setUsername] = useState(storedUser || '')
  const [minGames, setMinGames] = useState(80)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [profileExists, setProfileExists] = useState(false)

  const fact = CHESS_FACTS[Math.floor(Date.now() / 10000) % CHESS_FACTS.length]

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!username.trim()) return
    setLoading(true)
    setError('')
    setProfileExists(false)

    try {
      const { has_profile } = await api.check(username.trim())
      setUser({ username: username.trim(), platform })

      if (has_profile) {
        // Show choice instead of silently skipping analysis
        setProfileExists(true)
        return
      }

      await startIngest()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  async function startIngest() {
    const { job_id } = await api.startIngest(username.trim(), platform, minGames)
    setUser({ activeJobId: job_id })
    navigate(`/loading/${job_id}`)
  }

  async function handleReanalyse() {
    setLoading(true)
    setError('')
    try {
      await startIngest()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  function handleViewDashboard() {
    navigate('/dashboard')
  }

  return (
    <div className="min-h-screen bg-bg-0 flex flex-col items-center justify-center px-4">
      {/* Background grid */}
      <div
        className="fixed inset-0 pointer-events-none opacity-[0.03]"
        style={{
          backgroundImage: 'linear-gradient(#7B61FF 1px, transparent 1px), linear-gradient(90deg, #7B61FF 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      />

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="w-full max-w-md relative"
      >
        {/* Logo */}
        <div className="text-center mb-10">
          <img
            src="/logo.png"
            alt="Forked"
            className="h-24 w-auto mx-auto mb-3 drop-shadow-[0_0_24px_rgba(123,97,255,0.35)]"
          />
          <h1 className="text-3xl font-bold text-text-0 tracking-tight">Forked</h1>
          <p className="text-text-1 mt-2 text-base">A coach who knows exactly how you lose.</p>
        </div>

        {/* Card */}
        <div className="card p-6 shadow-2xl shadow-black/50">
          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Platform toggle */}
            <div>
              <label className="block text-xs font-medium text-text-1 mb-2">Platform</label>
              <div className="grid grid-cols-2 gap-2">
                {(['lichess', 'chesscom'] as Platform[]).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPlatform(p)}
                    className={`py-2 rounded-md text-sm font-medium transition-all duration-150 border
                      ${platform === p
                        ? 'bg-accent/15 border-accent/40 text-accent'
                        : 'bg-bg-2 border-border text-text-1 hover:text-text-0 hover:border-border-hover'}`}
                  >
                    {p === 'lichess' ? 'Lichess' : 'Chess.com'}
                  </button>
                ))}
              </div>
            </div>

            {/* Username */}
            <div>
              <label className="block text-xs font-medium text-text-1 mb-2">Username</label>
              <input
                className="input"
                type="text"
                placeholder={platform === 'lichess' ? 'e.g. ShahuPatil07' : 'e.g. hikaru'}
                value={username}
                onChange={(e) => { setUsername(e.target.value); setProfileExists(false) }}
                autoFocus
              />
              <p className="text-xs text-text-2 mt-1.5">
                No login required — public games only.
              </p>
            </div>

            {/* Games slider */}
            <div>
              <label className="flex items-center justify-between text-xs font-medium text-text-1 mb-2">
                <span>Games to analyse</span>
                <span className="text-text-0 font-semibold">{minGames}</span>
              </label>
              <input
                type="range"
                min={20} max={200} step={10}
                value={minGames}
                onChange={(e) => setMinGames(Number(e.target.value))}
                className="w-full h-1.5 rounded-full accent-accent cursor-pointer"
              />
              <div className="flex justify-between text-xs text-text-2 mt-1">
                <span>20 (fast)</span>
                <span>200 (thorough)</span>
              </div>
            </div>

            {error && (
              <p className="text-sm text-danger bg-danger/10 border border-danger/20 rounded-md px-3 py-2">
                {error}
              </p>
            )}

            {profileExists ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-accent/10 border border-accent/20">
                  <div className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
                  <p className="text-xs text-text-1">
                    Profile found for <span className="text-text-0 font-semibold">{username}</span>
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={handleViewDashboard}
                    className="btn-ghost py-2.5 text-sm"
                  >
                    View dashboard
                  </button>
                  <button
                    type="button"
                    onClick={handleReanalyse}
                    disabled={loading}
                    className="btn-primary flex items-center justify-center gap-2 py-2.5 text-sm"
                  >
                    {loading
                      ? <><Loader2 size={14} className="animate-spin" /> Starting...</>
                      : <>Re-analyse {minGames} games <ArrowRight size={14} /></>}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="submit"
                disabled={!username.trim() || loading}
                className="btn-primary w-full flex items-center justify-center gap-2 py-2.5"
              >
                {loading ? (
                  <><Loader2 size={16} className="animate-spin" /> Connecting...</>
                ) : (
                  <>Analyse my games <ArrowRight size={16} /></>
                )}
              </button>
            )}
          </form>
        </div>

        {/* Chess fact */}
        <p className="text-center text-xs text-text-2 mt-6 px-4 leading-relaxed">
          {fact}
        </p>
      </motion.div>
    </div>
  )
}
