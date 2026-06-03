import { type FormEvent, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  ArrowRight,
  BarChart3,
  BookOpen,
  Brain,
  ChevronRight,
  Clock,
  Crosshair,
  Loader2,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Swords,
  Target,
  Zap,
} from 'lucide-react'
import { useUserStore } from '../store/userStore'
import { api } from '../api'
import { ForkedWordmark } from '../components/layout/AppShell'

type Platform = 'lichess' | 'chesscom'

const SIGNALS = [
  { label: 'Your games', value: '80-200', tone: 'text-text-0' },
  { label: 'Threat classes', value: '14', tone: 'text-accent' },
  { label: 'Puzzle index', value: '100K+', tone: 'text-success' },
]

const FEATURES = [
  {
    icon: Crosshair,
    title: 'Find the patterns you actually miss',
    body: 'Forked scans your real games, spots recurring tactical collapses, and groups them into named blindspots.',
  },
  {
    icon: Brain,
    title: 'Coach-level labels, not raw engine noise',
    body: 'Clusters become plain-English themes like missed pins, loose-piece tactics, or back-rank danger.',
  },
  {
    icon: Zap,
    title: 'Drills matched to your failure modes',
    body: 'The puzzle session targets nearby positions in the same feature space, then schedules reviews as you improve.',
  },
]

const PIPELINE = [
  { icon: BookOpen, title: 'Ingest', body: 'Fetch public Lichess or Chess.com games without account login.' },
  { icon: BarChart3, title: 'Analyse', body: 'Stockfish evaluates positions and flags meaningful evaluation drops.' },
  { icon: Target, title: 'Cluster', body: 'UMAP and HDBSCAN turn isolated mistakes into recurring personal patterns.' },
  { icon: Clock, title: 'Train', body: 'Spaced repetition keeps the right motifs coming back at the right time.' },
]

const MINI_EVENTS = [
  { move: 'Qb2?', tag: 'loose piece', drop: '-233 cp' },
  { move: 'Ne8?', tag: 'king attack', drop: '-316 cp' },
  { move: 'Bd2?', tag: 'pin tactic', drop: '-226 cp' },
]

function ForkedHeroMark() {
  return (
    <div className="relative mx-auto h-[280px] w-[280px] sm:h-[360px] sm:w-[360px]">
      <motion.div
        className="absolute inset-6 rounded-full"
        animate={{
          boxShadow: [
            '0 0 46px rgba(123,97,255,0.28), inset 0 0 44px rgba(123,97,255,0.08)',
            '0 0 82px rgba(13,201,127,0.22), inset 0 0 58px rgba(123,97,255,0.13)',
            '0 0 46px rgba(123,97,255,0.28), inset 0 0 44px rgba(123,97,255,0.08)',
          ],
        }}
        transition={{ duration: 4.8, repeat: Infinity, ease: 'easeInOut' }}
      />

      <motion.div
        className="absolute inset-0 rounded-full border border-accent/20"
        animate={{ rotate: 360 }}
        transition={{ duration: 26, repeat: Infinity, ease: 'linear' }}
      >
        <div className="absolute left-1/2 top-0 h-2 w-2 -translate-x-1/2 rounded-full bg-accent shadow-[0_0_18px_rgba(123,97,255,0.9)]" />
        <div className="absolute bottom-8 right-7 h-1.5 w-1.5 rounded-full bg-success shadow-[0_0_14px_rgba(13,201,127,0.8)]" />
      </motion.div>

      <motion.svg
        viewBox="0 0 360 360"
        className="absolute inset-0 h-full w-full overflow-visible"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="forkGlow" x1="80" y1="280" x2="300" y2="82" gradientUnits="userSpaceOnUse">
            <stop stopColor="#0DC97F" />
            <stop offset="0.55" stopColor="#7B61FF" />
            <stop offset="1" stopColor="#C4B5FD" />
          </linearGradient>
          <filter id="forkBlur" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <motion.path
          d="M92 266 C142 224 173 192 197 150 C212 124 234 99 282 74"
          fill="none"
          stroke="url(#forkGlow)"
          strokeWidth="7"
          strokeLinecap="round"
          filter="url(#forkBlur)"
          pathLength="1"
          initial={{ pathLength: 0, opacity: 0 }}
          animate={{ pathLength: [0.1, 1, 1], opacity: [0, 1, 0.78] }}
          transition={{ duration: 3.2, repeat: Infinity, repeatDelay: 1.4, ease: 'easeInOut' }}
        />
        <motion.path
          d="M260 88 L306 58 M266 101 L318 92 M252 78 L270 35"
          fill="none"
          stroke="url(#forkGlow)"
          strokeWidth="7"
          strokeLinecap="round"
          filter="url(#forkBlur)"
          pathLength="1"
          initial={{ pathLength: 0, opacity: 0 }}
          animate={{ pathLength: [0, 1, 1], opacity: [0, 1, 0.85] }}
          transition={{ duration: 1.4, repeat: Infinity, repeatDelay: 3.2, ease: 'easeOut' }}
        />
      </motion.svg>

      <motion.img
        src="/logo-knight-cutout.png"
        alt="Forked knight"
        className="absolute left-1/2 top-1/2 h-[68%] w-auto -translate-x-1/2 -translate-y-1/2 object-contain
                   drop-shadow-[0_0_38px_rgba(123,97,255,0.68)]"
        animate={{ y: [-8, 8, -8], scale: [1, 1.025, 1] }}
        transition={{ duration: 5.6, repeat: Infinity, ease: 'easeInOut' }}
      />

      <motion.div
        className="absolute left-4 top-16 rounded-md border border-border bg-bg-1/75 px-3 py-2 backdrop-blur-md"
        animate={{ y: [0, -8, 0] }}
        transition={{ duration: 4.2, repeat: Infinity, ease: 'easeInOut' }}
      >
        <p className="text-[10px] uppercase tracking-wider text-text-2">Pattern found</p>
        <p className="text-xs font-semibold text-text-0">Missed back-rank threats</p>
      </motion.div>

      <motion.div
        className="absolute bottom-14 right-2 rounded-md border border-success/25 bg-success/10 px-3 py-2 backdrop-blur-md"
        animate={{ y: [0, 8, 0] }}
        transition={{ duration: 4.8, repeat: Infinity, ease: 'easeInOut' }}
      >
        <p className="text-[10px] uppercase tracking-wider text-success">Next drill</p>
        <p className="text-xs font-semibold text-text-0">Pinned defender</p>
      </motion.div>
    </div>
  )
}

function IntakePanel({
  platform,
  setPlatform,
  username,
  setUsername,
  minGames,
  setMinGames,
  loading,
  error,
  profileExists,
  onSubmit,
  onViewDashboard,
  onReanalyse,
}: {
  platform: Platform
  setPlatform: (p: Platform) => void
  username: string
  setUsername: (v: string) => void
  minGames: number
  setMinGames: (v: number) => void
  loading: boolean
  error: string
  profileExists: boolean
  onSubmit: (e: FormEvent) => void
  onViewDashboard: () => void
  onReanalyse: () => void
}) {
  return (
    <div className="relative rounded-lg border border-border bg-bg-1/78 p-5 shadow-2xl shadow-black/40 backdrop-blur-xl">
      <div className="absolute inset-x-8 -top-px h-px bg-gradient-to-r from-transparent via-accent/80 to-transparent" />
      <div className="mb-4 flex items-center gap-2">
        <ShieldCheck size={16} className="text-success" />
        <p className="text-sm font-semibold text-text-0">Start with public games</p>
        <span className="ml-auto rounded bg-bg-2 px-2 py-0.5 text-[10px] font-medium text-text-2">No login</span>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className="mb-2 block text-xs font-medium text-text-1">Platform</label>
          <div className="grid grid-cols-2 gap-2">
            {(['lichess', 'chesscom'] as Platform[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPlatform(p)}
                className={`rounded-md border py-2 text-sm font-medium transition-all duration-150
                  ${platform === p
                    ? 'border-accent/50 bg-accent/15 text-accent shadow-[0_0_18px_rgba(123,97,255,0.12)]'
                    : 'border-border bg-bg-2 text-text-1 hover:border-border-hover hover:text-text-0'}`}
              >
                {p === 'lichess' ? 'Lichess' : 'Chess.com'}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-2 block text-xs font-medium text-text-1">Username</label>
          <input
            className="input"
            type="text"
            placeholder={platform === 'lichess' ? 'e.g. ShahuPatil07' : 'e.g. hikaru'}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
          />
          <p className="mt-1.5 text-xs text-text-2">Forked reads only public game history.</p>
        </div>

        <div>
          <label className="mb-2 flex items-center justify-between text-xs font-medium text-text-1">
            <span>Games to analyse</span>
            <span className="font-semibold text-text-0">{minGames}</span>
          </label>
          <input
            type="range"
            min={20}
            max={200}
            step={10}
            value={minGames}
            onChange={(e) => setMinGames(Number(e.target.value))}
            className="h-1.5 w-full cursor-pointer rounded-full accent-accent"
          />
          <div className="mt-1 flex justify-between text-xs text-text-2">
            <span>20 fast</span>
            <span>200 thorough</span>
          </div>
        </div>

        {error && (
          <p className="rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}

        {profileExists ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-md border border-accent/20 bg-accent/10 px-3 py-2">
              <div className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-accent" />
              <p className="text-xs text-text-1">
                Profile found for <span className="font-semibold text-text-0">{username}</span>
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={onViewDashboard} className="btn-ghost py-2.5 text-sm">
                View dashboard
              </button>
              <button
                type="button"
                onClick={onReanalyse}
                disabled={loading}
                className="btn-primary flex items-center justify-center gap-2 py-2.5 text-sm"
              >
                {loading ? <><Loader2 size={14} className="animate-spin" /> Starting</> : <>Re-analyse <RotateCcw size={14} /></>}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="submit"
            disabled={!username.trim() || loading}
            className="btn-primary w-full flex items-center justify-center gap-2 py-2.5"
          >
            {loading ? <><Loader2 size={16} className="animate-spin" /> Connecting</> : <>Analyse my games <ArrowRight size={16} /></>}
          </button>
        )}
      </form>
    </div>
  )
}

export default function Onboarding() {
  const navigate = useNavigate()
  const { setUser, username: storedUser } = useUserStore()

  const [platform, setPlatform] = useState<Platform>('lichess')
  const [username, setUsernameState] = useState(storedUser || '')
  const [minGames, setMinGames] = useState(80)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [profileExists, setProfileExists] = useState(false)

  const setUsername = (value: string) => {
    setUsernameState(value)
    setProfileExists(false)
  }

  const miniEvents = useMemo(() => MINI_EVENTS, [])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!username.trim()) return
    setLoading(true)
    setError('')
    setProfileExists(false)

    try {
      const { has_profile } = await api.check(username.trim())
      setUser({ username: username.trim(), platform })

      if (has_profile) {
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
    <div className="relative min-h-screen overflow-hidden bg-bg-0 text-text-0">
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.06]"
        style={{
          backgroundImage:
            'linear-gradient(#7B61FF 1px, transparent 1px), linear-gradient(90deg, #7B61FF 1px, transparent 1px)',
          backgroundSize: '48px 48px',
        }}
      />
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_18%_18%,rgba(123,97,255,0.22),transparent_34%),radial-gradient(circle_at_84%_24%,rgba(13,201,127,0.14),transparent_30%),radial-gradient(circle_at_55%_86%,rgba(167,139,250,0.12),transparent_34%)]" />

      <main className="relative mx-auto max-w-7xl px-5 py-6 sm:px-8 lg:px-10">
        <nav className="mb-8 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="/logo-knight-cutout.png" alt="" className="h-10 w-auto drop-shadow-[0_0_18px_rgba(123,97,255,0.55)]" />
            <ForkedWordmark className="text-2xl" />
          </div>
          <button
            onClick={() => document.getElementById('start')?.scrollIntoView({ behavior: 'smooth' })}
            className="hidden items-center gap-2 rounded-md border border-border bg-bg-1/70 px-3 py-2 text-sm text-text-1 backdrop-blur-md transition-colors hover:text-text-0 sm:flex"
          >
            Start analysis <ChevronRight size={14} />
          </button>
        </nav>

        <section className="grid min-h-[calc(100vh-120px)] items-center gap-10 lg:grid-cols-[minmax(0,1fr)_420px]">
          <div className="max-w-3xl">
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45 }}
              className="mb-5 inline-flex items-center gap-2 rounded-full border border-accent/25 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent"
            >
              <Sparkles size={13} />
              Personal chess training from your real losses
            </motion.div>

            <motion.h1
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, delay: 0.05 }}
              className="max-w-4xl text-5xl font-black leading-[0.95] tracking-tight text-text-0 sm:text-6xl lg:text-7xl"
            >
              A coach who knows exactly how you lose.
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, delay: 0.12 }}
              className="mt-6 max-w-2xl text-base leading-8 text-text-1 sm:text-lg"
            >
              Forked studies your public games, detects the tactical and strategic patterns behind your mistakes,
              then turns those blindspots into targeted drills, opening guidance, and spaced review.
            </motion.p>

            <div className="mt-8 grid max-w-xl grid-cols-3 gap-3">
              {SIGNALS.map((signal, index) => (
                <motion.div
                  key={signal.label}
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.35, delay: 0.18 + index * 0.06 }}
                  className="rounded-lg border border-border bg-bg-1/70 p-3 backdrop-blur-md"
                >
                  <p className={`text-xl font-black ${signal.tone}`}>{signal.value}</p>
                  <p className="mt-1 text-[11px] text-text-2">{signal.label}</p>
                </motion.div>
              ))}
            </div>

            <div className="mt-8 flex flex-wrap gap-3">
              <button
                onClick={() => document.getElementById('start')?.scrollIntoView({ behavior: 'smooth' })}
                className="btn-primary flex items-center gap-2 px-5 py-3"
              >
                Analyse my games <ArrowRight size={16} />
              </button>
              <button
                onClick={() => document.getElementById('story')?.scrollIntoView({ behavior: 'smooth' })}
                className="btn-ghost border border-border bg-bg-1/50 px-5 py-3"
              >
                See how it works
              </button>
            </div>
          </div>

          <motion.div
            initial={{ opacity: 0, scale: 0.94 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="relative"
          >
            <ForkedHeroMark />
          </motion.div>
        </section>

        <section id="story" className="py-16">
          <div className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent">What Forked does</p>
              <h2 className="mt-2 text-3xl font-black tracking-tight text-text-0 sm:text-4xl">It turns repeated mistakes into a training plan.</h2>
            </div>
            <p className="max-w-md text-sm leading-6 text-text-1">
              The point is not another generic puzzle feed. It is a feedback loop built from the positions where your own games went wrong.
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, body }, index) => (
              <motion.div
                key={title}
                initial={{ opacity: 0, y: 18 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-80px' }}
                transition={{ duration: 0.4, delay: index * 0.08 }}
                className="group rounded-lg border border-border bg-bg-1/72 p-5 backdrop-blur-md transition-colors hover:border-accent/35"
              >
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-md border border-accent/20 bg-accent/10 text-accent transition-transform group-hover:-translate-y-1">
                  <Icon size={18} />
                </div>
                <h3 className="text-base font-bold text-text-0">{title}</h3>
                <p className="mt-3 text-sm leading-6 text-text-1">{body}</p>
              </motion.div>
            ))}
          </div>
        </section>

        <section className="grid gap-6 py-12 lg:grid-cols-[minmax(0,1fr)_420px]">
          <div className="rounded-lg border border-border bg-bg-1/72 p-5 backdrop-blur-md">
            <div className="mb-5 flex items-center gap-2">
              <Swords size={17} className="text-accent" />
              <h2 className="text-lg font-bold text-text-0">A live map of how games slip away</h2>
            </div>
            <div className="space-y-3">
              {miniEvents.map((event, index) => (
                <motion.div
                  key={event.move}
                  initial={{ opacity: 0, x: -12 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.35, delay: index * 0.08 }}
                  className="grid grid-cols-[72px_minmax(0,1fr)_80px] items-center gap-3 rounded-md border border-border bg-bg-2/70 px-3 py-3"
                >
                  <p className="font-mono text-sm font-bold text-text-0">{event.move}</p>
                  <div>
                    <p className="text-sm font-medium text-text-1">{event.tag}</p>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-bg-3">
                      <motion.div
                        className="h-full rounded-full bg-gradient-to-r from-danger to-accent"
                        initial={{ width: 0 }}
                        whileInView={{ width: `${58 + index * 13}%` }}
                        viewport={{ once: true }}
                        transition={{ duration: 0.7, delay: 0.15 + index * 0.08 }}
                      />
                    </div>
                  </div>
                  <p className="text-right font-mono text-xs font-bold text-danger">{event.drop}</p>
                </motion.div>
              ))}
            </div>
          </div>

          <div id="start">
            <IntakePanel
              platform={platform}
              setPlatform={setPlatform}
              username={username}
              setUsername={setUsername}
              minGames={minGames}
              setMinGames={setMinGames}
              loading={loading}
              error={error}
              profileExists={profileExists}
              onSubmit={handleSubmit}
              onViewDashboard={handleViewDashboard}
              onReanalyse={handleReanalyse}
            />
          </div>
        </section>

        <section className="pb-16 pt-8">
          <div className="grid gap-4 md:grid-cols-4">
            {PIPELINE.map(({ icon: Icon, title, body }, index) => (
              <motion.div
                key={title}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.35, delay: index * 0.06 }}
                className="rounded-lg border border-border bg-bg-1/65 p-4 backdrop-blur-md"
              >
                <div className="mb-4 flex items-center justify-between">
                  <Icon size={16} className="text-accent" />
                  <span className="font-mono text-xs text-text-2">0{index + 1}</span>
                </div>
                <h3 className="text-sm font-bold text-text-0">{title}</h3>
                <p className="mt-2 text-xs leading-5 text-text-1">{body}</p>
              </motion.div>
            ))}
          </div>
        </section>
      </main>
    </div>
  )
}
