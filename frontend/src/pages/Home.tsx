import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useElementWidth } from '../hooks/useElementWidth'
import { Link, useNavigate } from 'react-router-dom'
import { Chess } from 'chess.js'
import { Chessboard } from 'react-chessboard'
import type { Square } from 'chess.js'
import { motion, useReducedMotion } from 'framer-motion'
import {
  ArrowRight, BookOpen, Bot, BrainCircuit, ChevronRight, Clock, Crown, Flame, Github, LayoutDashboard, Menu,
  MessageSquare, Microscope, Puzzle, ScanLine, ScanSearch, ShieldCheck, Sparkles, Target, TrendingUp, X, Zap,
} from 'lucide-react'
import { useUserStore } from '../store/userStore'
import { AuthPanel } from '../components/auth/AuthPanel'
import { ForkedLogo, ForkedWordmark } from '../components/layout/AppShell'
import { BOARD_DARK, BOARD_LIGHT, NEON } from '../theme'

// ── hero board: the Blackburne Shilling trap, told the way Forked reviews a game ──
// (every label checked with Stockfish depth 18: Nxf7?? −0.8 → −5.2, Be2?? allows Nf3#)
const DEMO_FEN = 'r1b1kbnr/pppp1ppp/8/4N1q1/2BnP3/8/PPPP1PPP/RNBQK2R w KQkq - 1 5'
const DEMO: { san: string | null; tag: string; title: string; body: string }[] = [
  { san: null, tag: 'Position', title: 'White to move. Greed is on the menu.',
    body: 'The knight on e5 can grab f7 and fork the queen and rook. But what is the black queen looking at?' },
  { san: 'Nxf7', tag: 'Blunder', title: 'Nxf7?? — the fork that loses.',
    body: 'It wins the exchange on paper and ignores g2. Evaluation: −0.8 → −5.2.' },
  { san: 'Qxg2', tag: 'Best', title: 'Qxg2! — the real point.',
    body: 'The queen hits the rook on h1 and the white king loses its shelter.' },
  { san: 'Rf1', tag: 'Good', title: 'Rf1 saves the rook…',
    body: '…but the e4-pawn and the king are still exposed.' },
  { san: 'Qxe4+', tag: 'Best', title: 'Qxe4+ — with check.',
    body: 'Only two ways to block. One of them is a disaster.' },
  { san: 'Be2', tag: 'Blunder', title: 'Be2?? — the natural block.',
    body: 'It looks safe. Forked would ask: what does the d4-knight attack after this?' },
  { san: 'Nf3#', tag: 'Checkmate', title: 'Nf3# — smothered.',
    body: 'Five moves after one greedy capture. This is the kind of pattern Forked finds in your own games and drills.' },
]

const TAG_COLOR: Record<string, string> = {
  Position: 'text-text-1 border-border', Blunder: 'text-[#f06470] border-[#f06470]/40',
  Best: 'text-[#9ecb76] border-[#9ecb76]/40', Good: 'text-[#94a38e] border-[#94a38e]/40',
  Checkmate: 'text-accent border-accent/50',
}

function HeroBoard() {
  const [step, setStep] = useState(0)
  const [boardRef, measured] = useElementWidth<HTMLDivElement>(320)
  const width = Math.min(400, measured)
  const reduce = useReducedMotion()
  useEffect(() => {
    if (reduce) return
    const t = window.setTimeout(() => setStep(s => (s + 1) % DEMO.length), step === DEMO.length - 1 ? 5200 : 3400)
    return () => clearTimeout(t)
  }, [step, reduce])
  const { fen, last } = useMemo(() => {
    const c = new Chess(DEMO_FEN)
    let lastMove: { from: string; to: string } | null = null
    for (const d of DEMO.slice(1, step + 1)) {
      const m = c.move(d.san!)
      lastMove = { from: m.from, to: m.to }
    }
    return { fen: c.fen(), last: lastMove }
  }, [step])
  const styles: Record<string, React.CSSProperties> = {}
  if (last) { styles[last.from] = { background: 'rgba(200,255,42,0.28)' }; styles[last.to] = { background: 'rgba(200,255,42,0.42)' } }
  const note = DEMO[step]
  const arrows: [Square, Square, string][] = step === 0 ? [['g5', 'g2', 'rgba(255,90,90,.85)']] : step === 5 ? [['d4', 'f3', NEON]] : []
  return (
    <div className="relative">
      <div aria-hidden className="absolute -inset-10 rounded-[40px] bg-accent/10 blur-3xl" />
      <div className="relative rounded-2xl border border-white/10 bg-bg-1/90 backdrop-blur-xl shadow-[0_30px_120px_-20px_rgba(0,0,0,.8)] overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 text-[10px] tracking-[0.2em] uppercase text-text-2">
          <span className="flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />Game review · live</span>
          <span>move {5 + Math.floor(step / 2)}</span>
        </div>
        <div className="px-4 pt-4 sm:px-6 sm:pt-6 flex justify-center">
          <div ref={boardRef} className="w-full max-w-[400px] min-w-0">
            <Chessboard id="landing-demo" position={fen} boardWidth={width} arePiecesDraggable={false} animationDuration={350}
              customDarkSquareStyle={{ backgroundColor: BOARD_DARK }} customLightSquareStyle={{ backgroundColor: BOARD_LIGHT }}
              customSquareStyles={styles} customArrows={arrows}
              customBoardStyle={{ borderRadius: 10, boxShadow: '0 0 0 1px rgba(200,255,42,0.15)' }} />
          </div>
        </div>
        <motion.div key={step} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="px-5 py-4 min-h-[124px]">
          <span className={`inline-flex text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border ${TAG_COLOR[note.tag]}`}>{note.tag}</span>
          <p className="font-display text-base font-semibold text-text-0 mt-2">{note.title}</p>
          <p className="text-xs text-text-1 leading-relaxed mt-1">{note.body}</p>
        </motion.div>
        <div className="flex gap-1.5 px-5 pb-4">
          {DEMO.map((_, i) => (
            <button key={i} aria-label={`Step ${i + 1}`} onClick={() => setStep(i)}
              className={`h-1 flex-1 rounded-full transition-colors ${i <= step ? 'bg-accent' : 'bg-bg-3'}`} />
          ))}
        </div>
      </div>
      {/* floating insight cards */}
      <FloatCard className="hidden lg:block -left-16 top-24" delay={0.6}>
        <p className="text-[10px] uppercase tracking-wider text-text-2">Blindspot</p>
        <p className="text-sm font-semibold text-text-0 mt-0.5">Loose pieces</p>
        <p className="text-[11px] text-danger mt-0.5">1.4× players at your level</p>
      </FloatCard>
      <FloatCard className="hidden lg:block -right-10 bottom-28" delay={0.9}>
        <p className="text-[10px] uppercase tracking-wider text-text-2">If you fix it</p>
        <p className="font-display text-xl font-semibold text-accent mt-0.5">+59 rating</p>
        <p className="text-[11px] text-text-2">from 22 recoverable games</p>
      </FloatCard>
    </div>
  )
}

function FloatCard({ children, className, delay }: { children: ReactNode; className: string; delay: number }) {
  return (
    <motion.div initial={{ opacity: 0, y: 14, scale: .96 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ delay, duration: .5 }}
      className={`absolute z-10 rounded-xl border border-white/10 bg-bg-2/90 backdrop-blur-xl px-4 py-3 shadow-2xl ${className}`}>
      {children}
    </motion.div>
  )
}

// ── content ───────────────────────────────────────────────────────────────────
const PILLARS: { id: string; kicker: string; title: string; blurb: string; items: { icon: typeof Target; name: string; pitch: string }[] }[] = [
  {
    id: 'understand', kicker: '01 · Understand', title: 'See exactly how you lose.',
    blurb: 'Not "you made 24 blunders". The patterns, the moments and the rating they cost — measured against players at your level.',
    items: [
      { icon: LayoutDashboard, name: 'Blindspot dashboard', pitch: 'Your mistakes grouped into 5 skill families, ranked against rating-matched peers, with the game-arc charts that show where your games turn.' },
      { icon: ScanSearch, name: 'Game Review', pitch: 'Every move labelled, accuracy, game rating, turning points and a coach that explains any move. Saved forever — reopen instantly.' },
      { icon: Clock, name: 'Game History', pitch: 'Every online game by time control, with your mistakes and blunders one click from the board, plus every game you played on Forked.' },
    ],
  },
  {
    id: 'train', kicker: '02 · Train', title: 'Train the moves you actually miss.',
    blurb: 'Practice that targets your blindspots, not a generic feed — and a routine that gets your eyes ready before you play.',
    items: [
      { icon: Target, name: 'Drills', pitch: 'Spaced-repetition puzzles aimed at your top blindspot families, with streaks and progress that keep you coming back.' },
      { icon: Puzzle, name: 'Puzzle Themes', pitch: 'Every Lichess theme plus finer sub-types, a rating per theme, Rush & Streak — and your own past mistakes as puzzles.' },
      { icon: Flame, name: 'Warm-Up', pitch: 'Three to ten minutes of board-vision drills on real positions before a game. Play the threat on the board, spot what changed.' },
    ],
  },
  {
    id: 'play', kicker: '03 · Play', title: 'Play opponents that play like people.',
    blurb: 'Human-like Maia from beginner to master — in your platform\'s rating — or full-strength Stockfish when you want the truth.',
    items: [
      { icon: Bot, name: 'Play vs Maia', pitch: 'Pick the exact rating on your Chess.com or Lichess scale. Optional analysed mode labels every move with a live eval bar.' },
      { icon: BookOpen, name: 'Openings', pitch: 'A live tree from millions of games at the rating bracket you choose, the plans behind 50 main openings, and play-it-out vs Maia.' },
      { icon: Crown, name: 'Endgames', pitch: 'Tablebase-verified theory you open one ending at a time, then practise any position against Stockfish or Maia.' },
    ],
  },
  {
    id: 'ask', kicker: '04 · Ask & explore', title: 'Ask why — and get an answer that\'s checked.',
    blurb: 'A coach that investigates with the engine before it speaks, a full analysis board, and your over-the-board games digitised.',
    items: [
      { icon: Sparkles, name: 'AI Coach', pitch: 'Board-aware chat and voice that verifies every chess claim with Stockfish. Your conversations — and their boards — are saved.' },
      { icon: Microscope, name: 'Analysis Board', pitch: 'Paste a PGN or FEN, branch any line, build a position in the board editor and send the game to a background review.' },
      { icon: ScanLine, name: 'OTB Scan', pitch: 'Photograph a handwritten scoresheet; every move is read, legality-checked and proofread, then reviewed in one click.' },
    ],
  },
]

const NUMBERS = [
  { value: '87%', label: 'right skill family on real-game blunders', sub: 'held-out test, up from 29%' },
  { value: '313K', label: 'themed puzzles indexed', sub: 'from the 5.9M Lichess database' },
  { value: '7-piece', label: 'endgames verified by tablebase', sub: 'Syzygy, perfect play' },
  { value: '600–2800', label: 'human-like opponent range', sub: 'Maia, on your platform\'s scale' },
]

const STEPS = [
  { icon: ShieldCheck, title: 'Create your account', body: 'Name, email, password and your Chess.com or Lichess username. Nothing to install, no game uploads.' },
  { icon: BrainCircuit, title: 'We read your games', body: 'Stockfish annotates your recent rapid games; a chess transformer classifies every mistake by what you missed or allowed.' },
  { icon: TrendingUp, title: 'Train what matters', body: 'Your dashboard ranks the leaks by rating cost. Drills, warm-ups and reviews close them — and the next game shows it.' },
]

function Reveal({ children, delay = 0, className = '' }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div className={className} initial={{ opacity: 0, y: 18 }} whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }} transition={{ duration: .5, delay, ease: 'easeOut' }}>
      {children}
    </motion.div>
  )
}

// ── page ──────────────────────────────────────────────────────────────────────
export default function Home() {
  const { token, username, account } = useUserStore()
  const signedIn = !!token && !!username
  const navigate = useNavigate()
  const [menu, setMenu] = useState(false)
  const join = () => document.getElementById('join')?.scrollIntoView({ behavior: 'smooth', block: 'center' })

  return (
    <div className="relative z-[2] min-h-full overflow-x-hidden">
      {/* nav */}
      <header className="sticky top-0 z-50 border-b border-white/5 bg-bg-0/70 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center gap-4">
          <Link to="/" className="flex items-center gap-2.5" aria-label="Forked home">
            <ForkedLogo className="h-8 w-8" /><ForkedWordmark className="text-xl" />
          </Link>
          <nav className="hidden md:flex items-center gap-7 ml-8 text-sm text-text-1" aria-label="Sections">
            <a href="#features" className="hover:text-text-0">Features</a>
            <a href="#how" className="hover:text-text-0">How it works</a>
            <a href="#numbers" className="hover:text-text-0">Under the hood</a>
          </nav>
          <div className="flex-1" />
          {signedIn ? (
            <button onClick={() => navigate('/home')} className="btn-primary text-sm inline-flex items-center gap-2">
              Open Forked <ArrowRight size={15} />
            </button>
          ) : (
            <div className="hidden sm:flex items-center gap-2">
              <Link to="/auth" className="btn-ghost text-sm">Sign in</Link>
              <button onClick={join} className="btn-primary text-sm inline-flex items-center gap-2">Get started <ArrowRight size={15} /></button>
            </div>
          )}
          {!signedIn && (
            <button className="sm:hidden p-2 text-text-1" aria-label="Menu" onClick={() => setMenu(m => !m)}>{menu ? <X size={20} /> : <Menu size={20} />}</button>
          )}
        </div>
        {menu && !signedIn && (
          <div className="sm:hidden border-t border-white/5 px-4 py-3 flex flex-col gap-2 bg-bg-0/95">
            <a href="#features" onClick={() => setMenu(false)} className="py-2 text-sm text-text-1">Features</a>
            <a href="#how" onClick={() => setMenu(false)} className="py-2 text-sm text-text-1">How it works</a>
            <Link to="/auth" className="py-2 text-sm text-text-1">Sign in</Link>
            <button onClick={() => { setMenu(false); join() }} className="btn-primary text-sm">Create account</button>
          </div>
        )}
      </header>

      {/* hero */}
      <section className="relative">
        <div aria-hidden className="absolute inset-0 grid-backdrop opacity-70 pointer-events-none" />
        <div aria-hidden className="absolute left-1/2 -translate-x-1/2 -top-40 w-[900px] max-w-full h-[420px] rounded-full bg-accent/[0.07] blur-[120px] pointer-events-none" />
        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 pt-14 sm:pt-20 pb-16 sm:pb-24 grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1.08fr)_minmax(0,1fr)] gap-14 lg:gap-16 items-center">
          <div className="min-w-0">
            <motion.p initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              className="inline-flex items-center gap-2 text-[10px] sm:text-[11px] font-semibold tracking-[0.16em] sm:tracking-[0.22em] uppercase text-accent border border-accent/25 bg-accent/[0.06] rounded-full px-3 py-1.5 max-w-full">
              <Zap size={12} /> The chess trainer built on your own games
            </motion.p>
            <motion.h1 initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: .08 }}
              className="font-display font-semibold text-[3.1rem] leading-[1.02] sm:text-7xl xl:text-[5.4rem] tracking-[-0.045em] mt-6">
              Every move<br />has a <span className="neon-text italic">reason.</span>
            </motion.h1>
            <motion.p initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: .16 }}
              className="text-base sm:text-lg text-text-1 leading-relaxed mt-6 max-w-xl">
              Forked reads the games you've already played, finds the exact patterns that cost you rating points,
              and trains them away — with a coach that checks every claim against Stockfish.
            </motion.p>
            <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: .24 }}
              className="flex flex-wrap items-center gap-3 mt-8">
              {signedIn ? (
                <button onClick={() => navigate('/dashboard')} className="btn-primary px-6 py-3 text-base inline-flex items-center gap-2">
                  Go to my dashboard <ArrowRight size={17} />
                </button>
              ) : (
                <>
                  <button onClick={join} className="btn-primary px-6 py-3 text-base inline-flex items-center gap-2">Create free account <ArrowRight size={17} /></button>
                  <Link to="/auth" className="px-5 py-3 rounded-lg border border-border hover:border-accent/40 text-sm font-semibold text-text-0 transition-colors">I have an account</Link>
                </>
              )}
            </motion.div>
            <p className="text-xs text-text-2 mt-4">
              {signedIn ? <>Signed in as <span className="text-text-1">{account?.name ?? username}</span>.</> : 'Free · Chess.com or Lichess · nothing to install'}
            </p>
            <div className="mt-10 grid grid-cols-3 gap-3 max-w-lg">
              {[['~3 min', 'to profile 150 games'], ['5', 'skill families vs peers'], ['9', 'training surfaces']].map(([v, l]) => (
                <div key={l} className="rounded-xl border border-border bg-bg-1/60 px-3 py-3">
                  <p className="font-display text-xl sm:text-2xl font-semibold text-text-0">{v}</p>
                  <p className="text-[11px] text-text-2 leading-snug mt-0.5">{l}</p>
                </div>
              ))}
            </div>
          </div>
          <motion.div initial={{ opacity: 0, y: 20, rotate: 1.5 }} animate={{ opacity: 1, y: 0, rotate: 0 }} transition={{ delay: .2, duration: .6 }}
            className="w-full max-w-[460px] mx-auto">
            <HeroBoard />
          </motion.div>
        </div>
      </section>

      {/* marquee */}
      <div className="border-y border-white/5 bg-bg-1/60 overflow-hidden" aria-hidden>
        <div className="flex gap-10 py-4 whitespace-nowrap animate-[marquee_38s_linear_infinite] w-max text-xs tracking-[0.25em] uppercase text-text-2">
          {Array.from({ length: 2 }).flatMap((_, k) => ['Blindspot profile', 'Game review', 'Human-like Maia', 'Stockfish-checked coach',
            'Tablebase endgames', 'Opening explorer', 'Warm-up drills', 'Puzzle themes', 'OTB scoresheet scan', 'Analysis board']
            .map(t => <span key={`${k}-${t}`} className="flex items-center gap-10">{t}<span className="text-accent">✦</span></span>))}
        </div>
      </div>

      {/* insight strip */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 py-20 sm:py-28">
        <Reveal className="max-w-3xl">
          <p className="text-[11px] tracking-[0.22em] uppercase text-accent">Why Forked</p>
          <h2 className="font-display text-4xl sm:text-5xl font-semibold tracking-[-0.03em] mt-3">Your games already know <span className="text-text-2">how you lose.</span></h2>
        </Reveal>
        <div className="mt-10 grid md:grid-cols-3 gap-4">
          {[
            ['“You made 24 blunders.”', 'Loose pieces: 1.4× as often as players you faced, mostly after move 30, costing ~59 rating points.'],
            ['A generic puzzle feed.', 'Drills drawn from the motifs you miss, plus your own past positions as puzzles.'],
            ['An accuracy number.', 'The game arc: where your eval collapses, which wins you threw, how fast you played the moves that lost.'],
          ].map(([before, after], i) => (
            <Reveal key={i} delay={i * .08}>
              <div className="h-full card p-6 hover:border-accent/30 transition-colors">
                <p className="text-sm text-text-2 line-through decoration-danger/60">{before}</p>
                <ChevronRight size={16} className="text-accent my-3" />
                <p className="text-base text-text-0 leading-relaxed">{after}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* features */}
      <section id="features" className="relative border-t border-white/5 bg-gradient-to-b from-bg-1/50 to-transparent">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-20 sm:py-28 space-y-20 sm:space-y-28">
          {PILLARS.map((p, pi) => (
            <div key={p.id} className="grid lg:grid-cols-[0.85fr_1.4fr] gap-8 lg:gap-14 items-start">
              <Reveal className="lg:sticky lg:top-28">
                <p className="text-[11px] tracking-[0.22em] uppercase text-accent">{p.kicker}</p>
                <h3 className="font-display text-3xl sm:text-4xl font-semibold tracking-[-0.03em] mt-3">{p.title}</h3>
                <p className="text-text-1 mt-4 leading-relaxed max-w-md">{p.blurb}</p>
              </Reveal>
              <div className="grid sm:grid-cols-2 gap-4">
                {p.items.map((f, i) => (
                  <Reveal key={f.name} delay={i * .07} className={i === 0 ? 'sm:col-span-2' : ''}>
                    <div className={`group h-full rounded-2xl border border-border bg-bg-1/80 p-6 hover:border-accent/40 hover:shadow-neon transition-all relative overflow-hidden ${i === 0 ? 'sm:p-7' : ''}`}>
                      <div aria-hidden className="absolute -right-16 -top-16 w-48 h-48 rounded-full bg-accent/[0.06] blur-2xl group-hover:bg-accent/[0.12] transition-colors" />
                      <span className="relative w-11 h-11 rounded-xl border border-accent/30 bg-accent/[0.07] text-accent grid place-items-center"><f.icon size={20} /></span>
                      <p className={`relative font-display font-semibold text-text-0 mt-5 ${i === 0 ? 'text-2xl' : 'text-xl'}`}>{f.name}</p>
                      <p className="relative text-sm text-text-1 leading-relaxed mt-2">{f.pitch}</p>
                      {i === 0 && pi === 0 && <MiniArc />}
                      {i === 0 && pi === 1 && <MiniStreak />}
                      {i === 0 && pi === 2 && <MiniLevels />}
                      {i === 0 && pi === 3 && <MiniChat />}
                    </div>
                  </Reveal>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* how it works */}
      <section id="how" className="max-w-7xl mx-auto px-4 sm:px-6 py-20 sm:py-28">
        <Reveal className="text-center max-w-2xl mx-auto">
          <p className="text-[11px] tracking-[0.22em] uppercase text-accent">How it works</p>
          <h2 className="font-display text-4xl sm:text-5xl font-semibold tracking-[-0.03em] mt-3">Three steps to your first insight.</h2>
        </Reveal>
        <div className="mt-12 grid md:grid-cols-3 gap-4 relative">
          <div aria-hidden className="hidden md:block absolute top-11 left-[16%] right-[16%] h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          {STEPS.map((s, i) => (
            <Reveal key={s.title} delay={i * .1}>
              <div className="relative card p-6 text-center h-full">
                <span className="mx-auto w-14 h-14 rounded-2xl grid place-items-center bg-bg-2 border border-accent/30 text-accent shadow-neon-sm relative z-10"><s.icon size={22} /></span>
                <p className="text-[11px] tracking-[0.2em] text-text-2 mt-5">STEP {i + 1}</p>
                <p className="font-display text-xl font-semibold text-text-0 mt-1">{s.title}</p>
                <p className="text-sm text-text-1 mt-2 leading-relaxed">{s.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* numbers */}
      <section id="numbers" className="border-y border-white/5 bg-bg-1/50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-16 sm:py-20 grid grid-cols-2 lg:grid-cols-4 gap-6">
          {NUMBERS.map((n, i) => (
            <Reveal key={n.label} delay={i * .06}>
              <p className="font-display text-4xl sm:text-5xl font-semibold neon-text tracking-tight">{n.value}</p>
              <p className="text-sm text-text-0 mt-2">{n.label}</p>
              <p className="text-xs text-text-2 mt-1">{n.sub}</p>
            </Reveal>
          ))}
        </div>
      </section>

      {/* join */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 py-20 sm:py-28 grid lg:grid-cols-2 gap-12 items-center">
        <Reveal>
          <p className="text-[11px] tracking-[0.22em] uppercase text-accent">Start now</p>
          <h2 className="font-display text-4xl sm:text-5xl font-semibold tracking-[-0.03em] mt-3">Find the reason behind <span className="neon-text">your</span> moves.</h2>
          <p className="text-text-1 mt-5 leading-relaxed max-w-lg">
            Create an account with your Chess.com or Lichess username. Forked imports your recent rapid games,
            builds your blindspot profile in a few minutes, and keeps it current as you play.
          </p>
          <ul className="mt-6 space-y-2.5 text-sm text-text-1">
            {['Your real rating, pulled live from your platform', 'Reviews and conversations saved to your account', 'Every number explained — no black boxes'].map(t => (
              <li key={t} className="flex items-center gap-2.5"><span className="w-5 h-5 rounded-full bg-accent/15 text-accent grid place-items-center"><MessageSquare size={11} /></span>{t}</li>
            ))}
          </ul>
        </Reveal>
        <div id="join">
          {signedIn ? (
            <div className="card p-8 text-center">
              <ForkedLogo className="h-14 w-14 mx-auto" />
              <p className="font-display text-2xl font-semibold mt-4">You're signed in.</p>
              <p className="text-sm text-text-2 mt-1">Pick up where you left off.</p>
              <button onClick={() => navigate('/home')} className="btn-primary mt-6 inline-flex items-center gap-2">Open Forked <ArrowRight size={15} /></button>
            </div>
          ) : <AuthPanel initialMode="register" compact />}
        </div>
      </section>

      <footer className="border-t border-white/5">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2.5"><ForkedLogo className="h-6 w-6" /><ForkedWordmark className="text-lg" /></div>
          <p className="text-sm text-text-2 italic">Every move has a reason.</p>
          <a href="https://github.com/ShahuPatil07/Forked.chess" target="_blank" rel="noreferrer" className="text-xs text-text-2 hover:text-text-0 inline-flex items-center gap-2"><Github size={15} /> Source</a>
        </div>
      </footer>
    </div>
  )
}

// ── tiny illustrations inside the lead feature cards ───────────────────────────
function MiniArc() {
  const pts = [50, 52, 55, 53, 58, 61, 57, 63, 66, 48, 40, 37]
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${(i / (pts.length - 1)) * 300},${80 - p}`).join(' ')
  return (
    <div className="relative mt-6 rounded-xl border border-border bg-bg-0/60 p-4">
      <div className="flex justify-between text-[10px] text-text-2 mb-1"><span>Average eval vs % of game</span><span className="text-danger">collapse at 75%</span></div>
      <svg viewBox="0 0 300 60" className="w-full h-16" aria-hidden>
        <line x1="0" x2="300" y1="30" y2="30" stroke="#2E2E2E" strokeDasharray="4 4" />
        <path d={d} fill="none" stroke={NEON} strokeWidth="2" />
        <circle cx={(9 / 11) * 300} cy={80 - 48} r="4" fill="#FF4D5E" />
      </svg>
    </div>
  )
}
function MiniStreak() {
  return (
    <div className="relative mt-6 flex items-end gap-1.5 h-16" aria-hidden>
      {[3, 5, 4, 7, 6, 9, 8, 11, 10, 13, 12, 15].map((h, i) => (
        <span key={i} className="flex-1 rounded-t bg-accent/70" style={{ height: `${h * 6}%`, opacity: .35 + i * .05 }} />
      ))}
      <span className="absolute right-0 -top-1 text-[11px] text-accent font-semibold inline-flex items-center gap-1"><Flame size={12} />12-day streak</span>
    </div>
  )
}
function MiniLevels() {
  return (
    <div className="relative mt-6 flex flex-wrap gap-1.5" aria-hidden>
      {['800', '1200', '1500', '1800', '2100', '2400', '2800', 'Stockfish'].map((l, i) => (
        <span key={l} className={`text-[11px] px-2.5 py-1 rounded-full border ${i === 3 ? 'border-accent text-accent-ink bg-accent font-semibold' : 'border-border text-text-1'}`}>{l}</span>
      ))}
    </div>
  )
}
function MiniChat() {
  return (
    <div className="relative mt-6 space-y-2 text-xs" aria-hidden>
      <p className="ml-auto w-fit max-w-[80%] rounded-2xl rounded-br-sm bg-accent/15 border border-accent/20 px-3 py-2 text-text-0">Why is Nf5 a mistake here?</p>
      <p className="w-fit max-w-[90%] rounded-2xl rounded-tl-sm bg-bg-2 border border-border px-3 py-2 text-text-1">
        It drops the d4 knight's watch on e6: after <span className="text-accent font-mono">…Bxf5 exf5 Qe7</span> Black wins the f5-pawn. <span className="text-success">✓ verified</span>
      </p>
    </div>
  )
}
