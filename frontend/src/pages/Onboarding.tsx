import { type FormEvent, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ArrowRight, ArrowDown, Loader2, RotateCcw, ShieldCheck, Sparkles, Menu, X,
  Check, Minus, Database, Cpu, Fingerprint, Target, BookOpen, Crown,
  Share2, Radio, AlertTriangle, Zap, Github, ChevronRight, Bot,
} from 'lucide-react'
import { useUserStore } from '../store/userStore'
import { api } from '../api'
import { ForkedWordmark } from '../components/layout/AppShell'
import { MiniBoardThumbnail } from '../components/openings/MiniBoardThumbnail'
import { ForkedIntro, shouldSkipIntro, markIntroSeen } from '../components/ForkedIntro'

type Platform = 'lichess' | 'chesscom'

// Flip to `true` to re-enable the cinematic homepage intro animation.
// When false, the page loads straight to content (the background knight stays).
const INTRO_ENABLED = false

// ── Static content ──────────────────────────────────────────────────────────────

const TRUST_BADGES = [
  'No login · username only',
  '83.1% threat classification accuracy',
  '100K+ Lichess puzzles indexed',
]

const PROBLEM_ROWS = [
  {
    before: '"You made 24 blunders"',
    after: 'Loose-piece awareness — 99 mistakes, avg −260cp, costing +31 rating points',
  },
  {
    before: 'Generic puzzle feed',
    after: 'Drills matched to your exact failure modes',
  },
  {
    before: 'Accuracy report',
    after: 'Live alert when you repeat a blindspot in a real game',
  },
]

const STEPS = [
  { icon: Database, title: 'Ingest',
    body: 'Enter your Lichess or Chess.com username. No login, no password. Forked fetches your last 80–200 public games automatically.' },
  { icon: Cpu, title: 'Classify',
    body: 'A chess transformer (83.1% accuracy, trained on 2M positions) reads every mistake and classifies the tactical motif — fork, pin, back-rank, loose piece, king safety.' },
  { icon: Fingerprint, title: 'Profile',
    body: 'Mistakes collapse into your 5 skill families, ranked by urgency. Each family gets a score, a mastery level, and an estimated rating cost.' },
  { icon: Target, title: 'Train',
    body: 'Spaced repetition serves puzzles from your weakest families. Blunder the same pattern live and the system detects it and resets that mastery.' },
]

const FEATURES = [
  { icon: Target, title: 'Your personal mistake map',
    body: '95 games → 315 mistakes → 5 skill families ranked by urgency. Not what everyone struggles with. What you struggle with.',
    diff: '↗ +67 rating points if fixed' },
  { icon: Radio, title: 'Instant feedback on every game',
    body: 'Background sync detects when you repeat a known weakness in a live game — within minutes. Resets your mastery and queues drills automatically.',
    diff: 'No manual trigger needed' },
  { icon: Bot, title: 'Play a human-like bot, get a real debrief',
    body: 'Full games against Maia2 — a human-move model tuned near your rating, with lifelike thinking time. Afterwards: a Stockfish accuracy report and a blindspot debrief that cross-references the game against your own clusters.',
    diff: 'Maia2 · accuracy report · blindspot debrief' },
  { icon: BookOpen, title: 'Opening tree with AI ideas on every node',
    body: 'Lazy-loaded tree from real Lichess games, filtered to your rating. Engine eval, WDL bars, and AI-generated typical ideas on every variation. Fuzzy search jumps to any named line.',
    diff: 'Better than Chess.com · better than Lichess' },
  { icon: Crown, title: 'Tablebase-verified endgame coaching',
    body: 'Theory tree of canonical positions (Syzygy-verified). Practice from any material config vs a human-like bot. Endgame coach cites tablebase results as verified fact.',
    diff: 'Syzygy verified · not generic AI text' },
  { icon: Share2, title: 'A shareable profile of how you play',
    body: '5 style axes (Tactical 88, Aggressive 62, Time calm 93) render your playing identity as "The Attacker". Counterfactual rating shows what fixing your blindspots is worth.',
    diff: 'Shareable card · /dna/{username}' },
]

type Cell = 'good' | 'partial' | 'bad'
const COMPARISON: { feature: string; forked: Cell; cc: Cell; lichess: Cell; chessable: Cell;
  labels?: Partial<Record<'forked' | 'cc' | 'lichess' | 'chessable', string>> }[] = [
  { feature: 'Uses your real games for training', forked: 'good', cc: 'bad', lichess: 'bad', chessable: 'bad' },
  { feature: 'Detects personal recurring blindspots', forked: 'good', cc: 'bad', lichess: 'bad', chessable: 'bad' },
  { feature: 'Live alert when you repeat a mistake', forked: 'good', cc: 'bad', lichess: 'bad', chessable: 'bad' },
  { feature: 'Agentic AI coach that knows your games', forked: 'good', cc: 'bad', lichess: 'bad', chessable: 'bad' },
  { feature: 'Spaced repetition per blindspot', forked: 'good', cc: 'bad', lichess: 'bad', chessable: 'partial' },
  { feature: 'Opening tree with eval + AI ideas', forked: 'good', cc: 'partial', lichess: 'partial', chessable: 'bad' },
  { feature: 'Endgame trainer vs human-like bot', forked: 'good', cc: 'partial', lichess: 'bad', chessable: 'bad' },
  { feature: 'Tablebase-verified endgame coach', forked: 'good', cc: 'bad', lichess: 'bad', chessable: 'bad' },
  { feature: 'Requires login', forked: 'good', cc: 'bad', lichess: 'bad', chessable: 'bad',
    labels: { forked: 'No', cc: 'Yes', lichess: 'Yes', chessable: 'Yes' } },
]

const STATS = [
  { value: '83.1%', label: 'Threat classification accuracy (Chessformer, 14 classes)' },
  { value: '100K+', label: 'Lichess puzzles indexed for drill retrieval' },
  { value: '2M',    label: 'Training positions for the chess transformer' },
]

const DEMO_MISTAKES = [
  { fen: 'r3k2r/2qnbpp1/2p2B1p/1p2p3/p3P3/1BNQ3P/PPP2PP1/2KR3R b kq - 0 15',
    move: 'Bxf6?', tag: 'loose piece', drop: '−355 cp', orient: 'black' as const },
  { fen: '2kr3r/pp3Q1p/2q3p1/2p1p2n/2N1P3/2P2P2/PP3P1P/R4RK1 b - - 1 16',
    move: 'Qxc4?', tag: 'king attack', drop: '−286 cp', orient: 'black' as const },
  { fen: 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 1',
    move: 'Ng5?', tag: 'pin tactic', drop: '−226 cp', orient: 'white' as const },
]

// ── Sticky header ───────────────────────────────────────────────────────────────

function Header({ loggedIn, onStart, onNav }: {
  loggedIn: boolean; onStart: () => void; onNav: (path: string) => void
}) {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const links = [
    { label: 'Features', action: () => document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' }), always: true },
    { label: 'Openings', action: () => onNav('/openings') },
    { label: 'Endgames', action: () => onNav('/endgames') },
    { label: 'Coach', action: () => onNav('/coach') },
  ]

  return (
    <header className={`fixed inset-x-0 top-0 z-50 transition-all duration-200
      ${scrolled ? 'border-b border-border bg-bg-0/80 backdrop-blur-xl' : 'border-b border-transparent'}`}>
      <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-3 sm:px-8">
        <button onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} className="flex items-center gap-2.5">
          <img src="/logo.png" alt="" className="h-8 w-auto drop-shadow-[0_0_14px_rgba(123,97,255,0.5)]" />
          <ForkedWordmark className="text-xl" />
        </button>

        <nav className="hidden items-center gap-1 md:flex">
          {links.map(l => (
            <button key={l.label}
              onClick={l.always || loggedIn ? l.action : undefined}
              disabled={!l.always && !loggedIn}
              title={!l.always && !loggedIn ? 'Available after you analyse your games' : undefined}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors
                ${(!l.always && !loggedIn)
                  ? 'cursor-not-allowed text-text-2/40'
                  : 'text-text-1 hover:bg-bg-2 hover:text-text-0'}`}>
              {l.label}
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <button onClick={onStart}
            className="btn-primary hidden items-center gap-1.5 px-3.5 py-2 text-sm sm:flex">
            Start analysis <ArrowRight size={14} />
          </button>
          <button onClick={() => setOpen(o => !o)}
            className="rounded-md border border-border bg-bg-1/70 p-2 text-text-1 md:hidden" aria-label="Menu">
            {open ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden border-b border-border bg-bg-0/95 backdrop-blur-xl md:hidden">
            <div className="flex flex-col gap-1 px-5 py-3">
              {links.map(l => (
                <button key={l.label}
                  onClick={() => { if (l.always || loggedIn) { l.action(); setOpen(false) } }}
                  disabled={!l.always && !loggedIn}
                  className={`rounded-md px-3 py-2 text-left text-sm font-medium
                    ${(!l.always && !loggedIn) ? 'text-text-2/40' : 'text-text-1 hover:bg-bg-2'}`}>
                  {l.label}{!l.always && !loggedIn && <span className="ml-2 text-[10px] text-text-2">after analysis</span>}
                </button>
              ))}
              <button onClick={() => { onStart(); setOpen(false) }} className="btn-primary mt-1 flex items-center justify-center gap-1.5 py-2.5 text-sm">
                Start analysis <ArrowRight size={14} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  )
}

// ── Hero animated 3-state mockup ─────────────────────────────────────────────────

/**
 * Hero visual — a faithful, live render of the real Dashboard inside a browser
 * frame. Drop a real capture at `frontend/public/dashboard.png` and it upgrades
 * to that screenshot automatically (the <img> fades in over this on load).
 */
function DashboardPreview() {
  const [hasShot, setHasShot] = useState(false)
  const R = 12, C = 2 * Math.PI * R
  const blindspots = [
    { rank: 1, label: 'Loose-piece awareness', mastery: 0,  size: 99, drop: 'avg −260cp', phase: 'opening',    hot: true },
    { rank: 2, label: 'Pins & skewers',        mastery: 18, size: 40, drop: 'avg −173cp', phase: 'middlegame', hot: false },
    { rank: 3, label: 'King safety',           mastery: 9,  size: 19, drop: 'avg −340cp', phase: 'middlegame', hot: true },
  ]
  return (
    <div className="relative mx-auto w-full max-w-[560px]">
      <div className="pointer-events-none absolute -inset-8 rounded-[2rem] bg-[radial-gradient(circle_at_55%_40%,rgba(123,97,255,0.24),transparent_70%)]" />
      <div className="relative overflow-hidden rounded-xl border border-border bg-bg-1/95 shadow-2xl shadow-black/50 backdrop-blur-md">
        {/* browser chrome */}
        <div className="flex items-center gap-1.5 border-b border-border bg-bg-0/70 px-3 py-2">
          <span className="h-2.5 w-2.5 rounded-full bg-danger/60" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400/60" />
          <span className="h-2.5 w-2.5 rounded-full bg-success/60" />
          <div className="ml-2 flex-1 rounded bg-bg-2 px-2 py-0.5 text-[10px] text-text-2">forked.chess/dashboard</div>
        </div>

        {/* live dashboard render */}
        <div className="relative p-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <p className="text-xs font-bold text-text-0">Dashboard</p>
              <p className="text-[10px] text-text-2">ShahuPatil27 · 1800 ELO</p>
            </div>
            <span className="inline-flex items-center gap-1 rounded-md bg-accent/15 px-2 py-1 text-[10px] font-semibold text-accent">
              <Share2 size={10} /> The Attacker
            </span>
          </div>

          {/* stat tiles */}
          <div className="mb-3 grid grid-cols-4 gap-2">
            {[['Games', '95', 'text-text-0'], ['Mistakes', '315', 'text-danger'], ['Blindspots', '5', 'text-accent'], ['Potential', '1867', 'text-success']].map(([l, v, c]) => (
              <div key={l} className="rounded-lg border border-border bg-bg-2/60 p-2">
                <p className="text-[9px] text-text-2">{l}</p>
                <p className={`text-base font-black ${c}`}>{v}</p>
              </div>
            ))}
          </div>

          {/* live alert */}
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-2">
            <AlertTriangle size={13} className="flex-shrink-0 text-danger" />
            <p className="min-w-0 flex-1 truncate text-[10px] text-text-1">Repeated <span className="font-semibold text-text-0">loose-piece</span> on move 22 vs pedrominarelli</p>
            <span className="flex items-center gap-0.5 rounded bg-accent px-1.5 py-0.5 text-[9px] font-semibold text-white"><Zap size={9} /> Drill</span>
          </div>

          {/* blindspot cards */}
          <p className="mb-1.5 text-[9px] font-semibold uppercase tracking-wider text-text-2">Your blindspots</p>
          <div className="space-y-1.5">
            {blindspots.map(b => (
              <div key={b.rank} className="flex items-center gap-2 rounded-lg border border-border bg-bg-1/70 p-2">
                <span className="grid h-5 w-5 flex-shrink-0 place-items-center rounded bg-bg-3 text-[10px] font-bold text-text-1">{b.rank}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px] font-semibold text-text-0">{b.label}</p>
                  <div className="mt-1 flex gap-1">
                    <span className="rounded bg-bg-3/60 px-1 py-0.5 text-[8px] text-text-2">{b.size}×</span>
                    <span className={`rounded px-1 py-0.5 text-[8px] ${b.hot ? 'bg-danger/15 text-danger' : 'bg-bg-3/60 text-text-2'}`}>{b.drop}</span>
                    <span className="rounded bg-accent/10 px-1 py-0.5 text-[8px] text-accent">{b.phase}</span>
                  </div>
                </div>
                <svg viewBox="0 0 32 32" className="h-8 w-8 flex-shrink-0 -rotate-90">
                  <circle cx="16" cy="16" r={R} fill="none" stroke="#242436" strokeWidth="3" />
                  <circle cx="16" cy="16" r={R} fill="none" stroke="#7B61FF" strokeWidth="3" strokeLinecap="round"
                    strokeDasharray={C} strokeDashoffset={C * (1 - b.mastery / 100)} />
                </svg>
              </div>
            ))}
          </div>

          <div className="mt-3 flex items-center justify-between rounded-lg border border-success/25 bg-success/10 px-3 py-2">
            <span className="text-[10px] text-text-1">Fix all blindspots</span>
            <span className="text-xs font-bold text-success">+67 rating →</span>
          </div>

          {/* real screenshot overlay (optional — appears only if the file exists) */}
          <img src="/dashboard.png" alt="Forked dashboard" onLoad={() => setHasShot(true)}
            className={`absolute inset-0 h-full w-full object-cover object-top transition-opacity duration-500 ${hasShot ? 'opacity-100' : 'opacity-0'}`} />
        </div>
      </div>
    </div>
  )
}

// ── Cycling demo mistakes (mini boards) ──────────────────────────────────────────

function DemoMistakes() {
  const [i, setI] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setI(v => (v + 1) % DEMO_MISTAKES.length), 2500)
    return () => clearInterval(id)
  }, [])
  const m = DEMO_MISTAKES[i]
  return (
    <div className="rounded-xl border border-border bg-bg-1/70 p-5 backdrop-blur-md">
      <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-text-2">What Forked sees</p>
      <AnimatePresence mode="wait">
        <motion.div key={i}
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.4 }}
          className="flex items-center gap-4">
          <MiniBoardThumbnail fen={m.fen} size={92} orientation={m.orient} />
          <div className="min-w-0 flex-1">
            <p className="font-mono text-lg font-bold text-text-0">{m.move}</p>
            <p className="mt-0.5 text-sm capitalize text-text-1">{m.tag}</p>
            <p className="mt-1 font-mono text-sm font-bold text-danger">{m.drop}</p>
          </div>
        </motion.div>
      </AnimatePresence>
      <div className="mt-4 flex gap-1.5">
        {DEMO_MISTAKES.map((_, idx) => (
          <span key={idx} className={`h-1 flex-1 rounded-full transition-colors duration-300 ${idx === i ? 'bg-accent' : 'bg-bg-3'}`} />
        ))}
      </div>
    </div>
  )
}

// ── Comparison cell ──────────────────────────────────────────────────────────────

function CompCell({ state, label }: { state: Cell; label?: string }) {
  if (label) {
    return <span className={`text-sm font-medium ${state === 'good' ? 'text-success' : 'text-text-2'}`}>{label}</span>
  }
  if (state === 'good') return <Check size={17} className="mx-auto text-success" />
  if (state === 'partial') return <Minus size={17} className="mx-auto text-amber-400" />
  return <X size={15} className="mx-auto text-text-2/50" />
}

// ── Onboarding form (reused in §5 and §8) ────────────────────────────────────────

function IntakePanel(props: {
  platform: Platform; setPlatform: (p: Platform) => void
  username: string; setUsername: (v: string) => void
  minGames: number; setMinGames: (v: number) => void
  loading: boolean; error: string; profileExists: boolean
  onSubmit: (e: FormEvent) => void; onViewDashboard: () => void; onReanalyse: () => void
}) {
  const { platform, setPlatform, username, setUsername, minGames, setMinGames,
    loading, error, profileExists, onSubmit, onViewDashboard, onReanalyse } = props
  const gamesLabel = minGames <= 40 ? 'fast' : minGames <= 120 ? 'balanced' : 'thorough'
  return (
    <div className="relative rounded-xl border border-border bg-bg-1/80 p-5 shadow-2xl shadow-black/40 backdrop-blur-xl">
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
              <button key={p} type="button" onClick={() => setPlatform(p)}
                className={`rounded-md border py-2 text-sm font-medium transition-all duration-150
                  ${platform === p
                    ? 'border-accent/50 bg-accent/15 text-accent shadow-[0_0_18px_rgba(123,97,255,0.12)]'
                    : 'border-border bg-bg-2 text-text-1 hover:border-border-hover hover:text-text-0'}`}>
                {p === 'lichess' ? 'Lichess' : 'Chess.com'}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-2 block text-xs font-medium text-text-1">Username</label>
          <input className="input" type="text"
            placeholder={platform === 'lichess' ? 'e.g. ShahuPatil07' : 'e.g. hikaru'}
            value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>

        <div>
          <label className="mb-2 flex items-center justify-between text-xs font-medium text-text-1">
            <span>Games to analyse</span>
            <span className="font-semibold text-text-0">{minGames} <span className="text-text-2">· {gamesLabel}</span></span>
          </label>
          <input type="range" min={20} max={200} step={10} value={minGames}
            onChange={(e) => setMinGames(Number(e.target.value))}
            className="h-1.5 w-full cursor-pointer rounded-full accent-accent" />
          <div className="mt-1 flex justify-between text-[11px] text-text-2">
            <span>20 fast</span><span>80 balanced</span><span>200 thorough</span>
          </div>
        </div>

        {error && (
          <p className="rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>
        )}

        {profileExists ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-md border border-accent/20 bg-accent/10 px-3 py-2">
              <div className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-accent" />
              <p className="text-xs text-text-1">Profile found for <span className="font-semibold text-text-0">{username}</span></p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={onViewDashboard} className="btn-ghost py-2.5 text-sm">View dashboard</button>
              <button type="button" onClick={onReanalyse} disabled={loading}
                className="btn-primary flex items-center justify-center gap-2 py-2.5 text-sm">
                {loading ? <><Loader2 size={14} className="animate-spin" /> Starting</> : <>Re-analyse <RotateCcw size={14} /></>}
              </button>
            </div>
          </div>
        ) : (
          <button type="submit" disabled={!username.trim() || loading}
            className="btn-primary flex w-full items-center justify-center gap-2 py-2.5">
            {loading ? <><Loader2 size={16} className="animate-spin" /> Connecting</> : <>Analyse my games <ArrowRight size={16} /></>}
          </button>
        )}
      </form>
      <p className="mt-3 text-center text-[11px] text-text-2">No account needed · Reads only public games · Takes ~40 seconds</p>
    </div>
  )
}

// ── Section heading helper ───────────────────────────────────────────────────────

function SectionTitle({ eyebrow, title, sub }: { eyebrow?: string; title: string; sub?: string }) {
  return (
    <div className="mx-auto mb-10 max-w-2xl text-center">
      {eyebrow && <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent">{eyebrow}</p>}
      <h2 className="mt-2 text-3xl font-black tracking-tight text-text-0 sm:text-4xl">{title}</h2>
      {sub && <p className="mx-auto mt-3 max-w-xl text-sm leading-7 text-text-1">{sub}</p>}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────────

export default function Onboarding() {
  const navigate = useNavigate()
  const { setUser, username: storedUser } = useUserStore()

  const [platform, setPlatform] = useState<Platform>('lichess')
  const [username, setUsernameState] = useState(storedUser || '')
  const [minGames, setMinGames] = useState(80)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [profileExists, setProfileExists] = useState(false)

  // Cinematic intro: plays once per browser session, honours reduced-motion.
  // Disabled via INTRO_ENABLED (start "done" so the page shows immediately).
  const [introDone, setIntroDone] = useState(() => (INTRO_ENABLED ? shouldSkipIntro() : true))
  const finishIntro = () => { markIntroSeen(); setIntroDone(true) }

  const setUsername = (value: string) => { setUsernameState(value); setProfileExists(false) }
  const scrollToStart = () => document.getElementById('start')?.scrollIntoView({ behavior: 'smooth' })

  async function startIngest() {
    const { job_id } = await api.startIngest(username.trim(), platform, minGames)
    setUser({ activeJobId: job_id })
    navigate(`/loading/${job_id}`)
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!username.trim()) return
    setLoading(true); setError(''); setProfileExists(false)
    try {
      const { has_profile } = await api.check(username.trim())
      setUser({ username: username.trim(), platform })
      if (has_profile) { setProfileExists(true); return }
      await startIngest()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally { setLoading(false) }
  }

  async function handleReanalyse() {
    setLoading(true); setError('')
    try { await startIngest() }
    catch (err: unknown) { setError(err instanceof Error ? err.message : 'Something went wrong') }
    finally { setLoading(false) }
  }

  const formProps = {
    platform, setPlatform, username, setUsername, minGames, setMinGames,
    loading, error, profileExists, onSubmit: handleSubmit,
    onViewDashboard: () => navigate('/dashboard'), onReanalyse: handleReanalyse,
  }

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-bg-0 text-text-0">
      {/* Background texture */}
      <div className="pointer-events-none absolute inset-0 opacity-[0.05]"
        style={{ backgroundImage: 'linear-gradient(#7B61FF 1px, transparent 1px), linear-gradient(90deg, #7B61FF 1px, transparent 1px)', backgroundSize: '48px 48px' }} />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[900px] bg-[radial-gradient(circle_at_20%_10%,rgba(123,97,255,0.20),transparent_40%),radial-gradient(circle_at_85%_15%,rgba(13,201,127,0.12),transparent_36%)]" />

      {/* Faint background knight watermark — the intro recedes into this */}
      <motion.img
        src="/logo.png"
        alt=""
        aria-hidden="true"
        className="pointer-events-none fixed left-1/2 top-1/2 z-0 w-[88vw] max-w-[820px] -translate-x-1/2 -translate-y-1/2 select-none blur-[14px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: introDone ? 0.05 : 0 }}
        transition={{ duration: 1.1, ease: 'easeOut' }}
      />

      <motion.div
        className="relative z-10"
        initial={false}
        animate={{ opacity: introDone ? 1 : 0 }}
        transition={{ duration: 0.6, delay: introDone ? 0.15 : 0 }}
      >
      <Header loggedIn={!!storedUser} onStart={scrollToStart} onNav={(p) => navigate(p)} />

      <main className="relative mx-auto max-w-7xl px-5 sm:px-8">
        {/* ── Section 1 — Hero ── */}
        <section className="grid min-h-screen items-center gap-10 pt-24 pb-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,560px)]">
          <div className="max-w-3xl">
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45 }}
              className="mb-5 inline-flex items-center gap-2 rounded-full border border-accent/25 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent">
              <Sparkles size={13} /> Personal chess training from your real losses
            </motion.div>

            <motion.h1 initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, delay: 0.05 }}
              className="text-4xl font-black leading-[0.98] tracking-tight sm:text-6xl lg:text-7xl">
              A coach who knows exactly how you lose.
            </motion.h1>

            <motion.p initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, delay: 0.12 }}
              className="mt-6 max-w-2xl text-base leading-8 text-text-1 sm:text-lg">
              Forked analyses your real games, finds the tactical and strategic patterns behind every mistake,
              and builds a personalised training plan that targets exactly those patterns — not generic puzzles.
            </motion.p>

            <div className="mt-6 flex flex-wrap gap-2">
              {TRUST_BADGES.map(b => (
                <span key={b} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-1/60 px-3 py-1 text-[11px] text-text-2">
                  <Check size={11} className="text-success" /> {b}
                </span>
              ))}
            </div>

            <div className="mt-8 flex flex-wrap gap-3">
              <button onClick={scrollToStart} className="btn-primary flex items-center gap-2 px-5 py-3 text-base">
                Analyse my games <ArrowRight size={16} />
              </button>
              <button onClick={() => document.getElementById('how')?.scrollIntoView({ behavior: 'smooth' })}
                className="btn-ghost flex items-center gap-2 border border-border bg-bg-1/50 px-5 py-3 text-base">
                See how it works <ArrowDown size={15} />
              </button>
            </div>
          </div>

          <motion.div initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.6, delay: 0.1 }}>
            <DashboardPreview />
          </motion.div>
        </section>

        {/* ── Section 2 — The problem ── */}
        <section className="border-t border-border/60 py-20">
          <div className="grid gap-10 lg:grid-cols-2 lg:gap-16">
            <div>
              <h2 className="text-3xl font-black leading-tight tracking-tight sm:text-4xl">
                Chess.com tells you what's wrong.<br /><span className="text-text-2">Nobody fixes it.</span>
              </h2>
              <p className="mt-6 max-w-md text-base leading-8 text-text-1">
                Every platform shows you accuracy scores and blunder counts. None of them know that
                <span className="text-text-0"> you specifically</span> miss back-rank threats 23 times a month —
                or build a drill plan around it.
              </p>
            </div>
            <div className="space-y-3">
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-1 text-[11px] font-semibold uppercase tracking-wider text-text-2">
                <span>Chess.com Insights</span><span /><span className="text-accent">Forked</span>
              </div>
              {PROBLEM_ROWS.map((r, i) => (
                <motion.div key={i} initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}
                  transition={{ duration: 0.35, delay: i * 0.08 }}
                  className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 rounded-lg border border-border bg-bg-1/60 p-3.5">
                  <p className="text-sm text-text-2 line-through decoration-text-2/40">{r.before}</p>
                  <ChevronRight size={16} className="text-accent" />
                  <p className="text-sm font-medium text-text-0">{r.after}</p>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Section 3 — Core loop ── */}
        <section id="how" className="border-t border-border/60 py-20">
          <SectionTitle eyebrow="The core loop" title="Four steps from your games to your improvement" />
          <div className="relative grid gap-4 md:grid-cols-4">
            <div className="pointer-events-none absolute left-0 right-0 top-9 hidden h-px bg-gradient-to-r from-transparent via-accent/30 to-transparent md:block" />
            {STEPS.map(({ icon: Icon, title, body }, i) => (
              <motion.div key={title} initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}
                transition={{ duration: 0.35, delay: i * 0.08 }}
                className="relative rounded-xl border border-border bg-bg-1/70 p-5 backdrop-blur-md">
                <div className="mb-4 flex items-center justify-between">
                  <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-accent/25 bg-accent/10 text-accent">
                    <Icon size={20} />
                  </div>
                  <span className="font-mono text-2xl font-black text-bg-3">0{i + 1}</span>
                </div>
                <h3 className="text-base font-bold text-text-0">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-text-1">{body}</p>
              </motion.div>
            ))}
          </div>
        </section>

        {/* ── Section 4 — Feature showcase ── */}
        <section id="features" className="border-t border-border/60 py-20">
          <SectionTitle eyebrow="Everything in one platform" title="Seven tools, one blindspot graph"
            sub="Each one is grounded in your real data or a tablebase — not generic AI text." />

          {/* Elevated flagship — the Forked Coach */}
          <motion.div initial={{ opacity: 0, y: 18 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: '-60px' }}
            transition={{ duration: 0.45 }}
            className="group relative mb-4 overflow-hidden rounded-2xl border border-accent/40
                       bg-gradient-to-br from-accent/15 via-bg-1/80 to-bg-1/80 p-6 backdrop-blur-md
                       transition-all duration-200 hover:border-accent/60 hover:shadow-[0_12px_44px_rgba(123,97,255,0.22)] sm:p-8">
            <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-[radial-gradient(circle,rgba(123,97,255,0.30),transparent_70%)]" />
            <div className="relative grid items-center gap-6 lg:grid-cols-2">
              <div>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/15 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-accent">
                  <Sparkles size={11} /> Capstone · new
                </span>
                <h3 className="mt-3 text-2xl font-black tracking-tight text-text-0">An AI coach that knows your games</h3>
                <p className="mt-3 max-w-md text-sm leading-7 text-text-1">
                  A persistent agentic coach that opens every session knowing your recent games, top blindspot, and
                  drill history. Shows inline puzzles you can solve, analyses pasted games, and remembers prior sessions.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {['Audio mode', '6 tools', 'Streaming', 'Remembers you'].map(t => (
                    <span key={t} className="rounded-md border border-accent/25 bg-accent/10 px-2 py-1 text-[11px] font-medium text-accent">{t}</span>
                  ))}
                </div>
              </div>

              {/* mini chat preview — show, don't tell */}
              <div className="rounded-xl border border-border bg-bg-0/60 p-3.5">
                <div className="mb-2 flex items-center gap-1.5">
                  <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/15 text-accent"><Sparkles size={12} /></span>
                  <span className="text-[11px] font-semibold text-text-1">Forked Coach</span>
                  <span className="ml-auto h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
                </div>
                <div className="space-y-2">
                  <p className="max-w-[92%] rounded-2xl rounded-bl-sm border border-border bg-bg-2 px-3 py-2 text-[11px] leading-relaxed text-text-1">
                    Welcome back. You repeated that loose-piece pattern on move 22 vs pedrominarelli — your mastery there is back to 0. Want to drill it, or review the game?
                  </p>
                  <p className="ml-auto max-w-[70%] rounded-2xl rounded-br-sm border border-accent/20 bg-accent/15 px-3 py-2 text-[11px] text-text-0">
                    show me a puzzle on it
                  </p>
                  <p className="flex items-center gap-1.5 text-[10px] text-text-2">
                    <Zap size={10} className="text-accent" /> serving a loose-piece puzzle at your rating…
                  </p>
                </div>
              </div>
            </div>
          </motion.div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, body, diff }, i) => (
              <motion.div key={title} initial={{ opacity: 0, y: 18 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: '-60px' }}
                transition={{ duration: 0.4, delay: (i % 3) * 0.06 }}
                className="group rounded-xl border border-border bg-bg-1/70 p-5 backdrop-blur-md transition-all duration-200
                           hover:-translate-y-1 hover:border-accent/40 hover:shadow-[0_8px_30px_rgba(123,97,255,0.12)]">
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg border border-accent/20 bg-accent/10 text-accent">
                  <Icon size={18} />
                </div>
                <h3 className="text-base font-bold text-text-0">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-text-1">{body}</p>
                <p className="mt-3 text-xs font-semibold text-accent">{diff}</p>
              </motion.div>
            ))}
          </div>
        </section>

        {/* ── Section 5 — Demo / onboarding ── */}
        <section id="start" className="border-t border-border/60 py-20">
          <SectionTitle eyebrow="Try it now" title="See your blindspots in 40 seconds"
            sub="Enter a username and Forked starts reading your games. No account, no password." />
          <div className="mx-auto grid max-w-4xl items-center gap-6 lg:grid-cols-2">
            <DemoMistakes />
            <div className="mx-auto w-full max-w-md">
              <IntakePanel {...formProps} />
            </div>
          </div>
        </section>

        {/* ── Section 6 — Comparison ── */}
        <section className="border-t border-border/60 py-20">
          <SectionTitle eyebrow="How it compares" title="Everything in one place. Nothing else comes close." />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-2">Feature</th>
                  <th className="rounded-t-lg bg-accent/10 px-4 py-3 text-center text-sm font-bold text-accent">Forked</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-text-2">Chess.com</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-text-2">Lichess</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-text-2">Chessable</th>
                </tr>
              </thead>
              <tbody>
                {COMPARISON.map((row, i) => (
                  <tr key={row.feature} className={i % 2 ? 'bg-bg-1/30' : ''}>
                    <td className="px-4 py-3 text-text-1">{row.feature}</td>
                    <td className="bg-accent/[0.06] px-4 py-3 text-center"><CompCell state={row.forked} label={row.labels?.forked} /></td>
                    <td className="px-4 py-3 text-center"><CompCell state={row.cc} label={row.labels?.cc} /></td>
                    <td className="px-4 py-3 text-center"><CompCell state={row.lichess} label={row.labels?.lichess} /></td>
                    <td className="px-4 py-3 text-center"><CompCell state={row.chessable} label={row.labels?.chessable} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* ── Section 7 — Social proof ── */}
        <section className="border-t border-border/60 py-20">
          <SectionTitle eyebrow="Built on real data, not vibes" title="The numbers behind the product" />
          <div className="grid gap-4 sm:grid-cols-3">
            {STATS.map((s, i) => (
              <motion.div key={s.value} initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}
                transition={{ duration: 0.4, delay: i * 0.08 }}
                className="rounded-xl border border-border bg-bg-1/70 p-6 text-center backdrop-blur-md">
                <p className="bg-gradient-to-br from-accent to-purple-300 bg-clip-text text-5xl font-black text-transparent">{s.value}</p>
                <p className="mx-auto mt-3 max-w-[220px] text-xs leading-5 text-text-2">{s.label}</p>
              </motion.div>
            ))}
          </div>
          <div className="mx-auto mt-8 max-w-2xl rounded-xl border border-accent/20 bg-accent/5 p-6 text-center">
            <p className="text-base leading-7 text-text-1">
              The feedback loop is the key: when you blunder the same pattern in a real game, the system detects it.
              <span className="text-text-0"> No static puzzle platform does this.</span>
            </p>
          </div>

          {/* Real social proof — open source, build it in the open */}
          <div className="mx-auto mt-8 flex flex-col items-center gap-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-text-2">Free &amp; open source</p>
            <a href="https://github.com/ShahuPatil07/Forked" target="_blank" rel="noopener noreferrer"
              className="group inline-flex items-center gap-3 rounded-xl border border-border bg-bg-1/70 px-4 py-3 transition-colors hover:border-accent/40">
              <Github size={18} className="text-text-1 group-hover:text-text-0" />
              <span className="text-sm font-semibold text-text-1 group-hover:text-text-0">ShahuPatil07/Forked</span>
              <img
                src="https://img.shields.io/github/stars/ShahuPatil07/Forked?style=flat&label=stars&color=7B61FF&labelColor=1A1D36&logo=github&logoColor=white"
                alt="GitHub stars" className="h-5" loading="lazy" />
            </a>
            <p className="text-[11px] text-text-2">Inspect the model, the pipeline, every prompt — nothing hidden.</p>
          </div>
        </section>

        {/* ── Section 8 — Final CTA ── */}
        <section className="border-t border-border/60 py-20">
          <div className="mx-auto max-w-xl text-center">
            <h2 className="text-4xl font-black tracking-tight sm:text-5xl">Find out how you lose. Fix it.</h2>
            <p className="mx-auto mt-4 max-w-md text-base leading-7 text-text-1">
              Enter your username. No account, no password. Results in 40 seconds.
            </p>
          </div>
          <div className="mx-auto mt-8 w-full max-w-md">
            <IntakePanel {...formProps} />
          </div>
          <div className="mt-6 flex flex-col items-center gap-2">
            <p className="text-[11px] text-text-2">Works with Lichess and Chess.com · Free · Open source</p>
            <a href="https://github.com/ShahuPatil07/Forked" target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-text-1 transition-colors hover:text-text-0">
              <Github size={13} /> ShahuPatil07/Forked
            </a>
          </div>
        </section>
      </main>

      <footer className="border-t border-border/60 py-8 text-center">
        <ForkedWordmark className="text-sm" />
        <p className="mt-1 text-[11px] text-text-2">A coach who knows exactly how you lose.</p>
      </footer>
      </motion.div>

      <AnimatePresence>
        {INTRO_ENABLED && !introDone && <ForkedIntro onDone={finishIntro} />}
      </AnimatePresence>
    </div>
  )
}
