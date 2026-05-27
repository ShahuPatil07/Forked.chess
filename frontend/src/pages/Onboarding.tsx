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
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const fact = CHESS_FACTS[Math.floor(Date.now() / 10000) % CHESS_FACTS.length]

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!username.trim()) return
    setLoading(true)
    setError('')

    try {
      // Check if we already have data
      const { has_profile } = await api.check(username.trim())
      setUser({ username: username.trim(), platform })

      if (has_profile) {
        navigate('/dashboard')
        return
      }

      // Start ingestion
      const { job_id } = await api.startIngest(username.trim(), platform, 80)
      setUser({ activeJobId: job_id })
      navigate(`/loading/${job_id}`)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
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
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-accent/15 border border-accent/30 text-3xl mb-4">
            ♞
          </div>
          <h1 className="text-3xl font-bold text-text-0 tracking-tight">Pawnprint</h1>
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
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
              />
              <p className="text-xs text-text-2 mt-1.5">
                No login required — public games only.
              </p>
            </div>

            {error && (
              <p className="text-sm text-danger bg-danger/10 border border-danger/20 rounded-md px-3 py-2">
                {error}
              </p>
            )}

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
