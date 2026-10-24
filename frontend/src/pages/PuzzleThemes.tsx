import { useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import type { LucideIcon } from 'lucide-react'
import {
  ArrowRight, BookOpen, Brain, CalendarDays, ChevronDown, Crosshair, Crown, Flame, Footprints, GitFork, Layers,
  Puzzle, RotateCcw, Ruler, Search, Shuffle, SlidersHorizontal, Sparkles, Swords, Target, Trophy, Wand2, X,
} from 'lucide-react'
import { SectionHeader, SectionHeaderStat } from '../components/layout/SectionHeader'
import { MiniBoardThumbnail } from '../components/openings/MiniBoardThumbnail'
import { useUserStore } from '../store/userStore'
import {
  compactCount, themesApi, type CatalogResponse, type OpeningFamily, type StatsResponse, type ThemeCategory,
  type ThemeItem, type ThemesUser,
} from '../api/themes'
import { NEON } from '../theme'
import { Chess } from 'chess.js'

const CATEGORY_ICON: Record<string, LucideIcon> = {
  recommended: Sparkles, phases: Layers, motifs: Crosshair, forkedTactics: GitFork, advanced: Brain,
  mates: Crown, matePatterns: Swords, forkedEndgames: Footprints, special: Wand2, goals: Target,
  lengths: Ruler, origin: Trophy,
}

export function useThemesCatalog() {
  const { username, elo } = useUserStore()
  return useQuery<CatalogResponse>({
    queryKey: ['themes-catalog', username],
    queryFn: () => themesApi.catalog(username, elo || undefined),
    staleTime: 30_000,
  })
}

export default function PuzzleThemes() {
  const { username } = useUserStore()
  const { data, isLoading, error } = useThemesCatalog()
  const { data: stats } = useQuery<StatsResponse>({
    queryKey: ['themes-stats', username], queryFn: () => themesApi.stats(username), staleTime: 30_000,
  })
  const [query, setQuery] = useState('')
  const [builder, setBuilder] = useState(false)

  const q = query.trim().toLowerCase()
  const categories = useMemo(() => {
    if (!data) return []
    if (!q) return data.categories
    return data.categories
      .map(c => ({ ...c, themes: c.themes.filter(t => `${t.name} ${t.desc} ${t.key}`.toLowerCase().includes(q)) }))
      .filter(c => c.themes.length)
  }, [data, q])

  return (
    <div className="relative isolate">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[420px] -z-10">
        <div className="absolute inset-0 grid-backdrop" />
        <div className="absolute left-1/2 -translate-x-1/2 -top-40 w-[760px] max-w-full h-[300px] rounded-full bg-accent/10 blur-[110px]" />
      </div>
      <div className="max-w-7xl mx-auto px-4 lg:px-8 pt-6 pb-16">
        <SectionHeader icon={Puzzle} title="Puzzle Themes"
          description="Every Lichess puzzle theme, split into finer sub-types, rated separately for each theme, and linked to the mistakes in your own games."
          right={data && <SectionHeaderStat label="Puzzle rating" value={<span className="text-accent font-semibold">{data.user.rating}{data.user.provisional ? '?' : ''}</span>} />} />

        {isLoading && <CatalogSkeleton />}
        {error && (
          <div className="card p-6 text-sm text-danger">Couldn't load the theme catalog: {(error as Error).message}</div>
        )}

        {data && (
          <>
            <div className="grid gap-4 lg:grid-cols-[1.05fr_1.35fr_1fr]">
              <RatingCard user={data.user} stats={stats} />
              <ForYouCard user={data.user} />
              <YourGamesCard user={data.user} />
            </div>

            {stats && stats.strengths.length + stats.weaknesses.length > 0 && <ThemeReport stats={stats} />}

            {/* filter bar */}
            <div className="sticky top-14 z-30 -mx-4 lg:-mx-8 px-4 lg:px-8 mt-8 py-3 bg-bg-0/85 backdrop-blur-xl border-y border-border">
              <div className="flex flex-col md:flex-row md:items-center gap-3">
                <div className="relative md:w-72 flex-shrink-0">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-2" />
                  <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search themes and openings…"
                    className="input pl-9 pr-8" aria-label="Search themes" />
                  {query && (
                    <button onClick={() => setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-text-2 hover:text-text-0" aria-label="Clear search">
                      <X size={14} />
                    </button>
                  )}
                </div>
                <nav className="flex gap-1.5 overflow-x-auto no-scrollbar min-w-0 flex-1" aria-label="Theme categories">
                  {data.categories.map(c => {
                    const I = CATEGORY_ICON[c.id] ?? Puzzle
                    return (
                      <a key={c.id} href={`#cat-${c.id}`}
                        className={`flex-shrink-0 inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-full border transition-colors
                          ${c.forked ? 'border-accent/30 text-accent hover:bg-accent/10' : 'border-border text-text-1 hover:text-text-0 hover:border-border-hover'}`}>
                        <I size={12} />{c.title}
                      </a>
                    )
                  })}
                  <a href="#cat-openings" className="flex-shrink-0 inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-full border border-border text-text-1 hover:text-text-0">
                    <BookOpen size={12} />Openings
                  </a>
                </nav>
                <button onClick={() => setBuilder(b => !b)}
                  className={`flex-shrink-0 inline-flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg border transition-colors
                    ${builder ? 'border-accent text-accent bg-accent/10' : 'border-border text-text-0 hover:border-accent/40'}`}>
                  <SlidersHorizontal size={14} />Custom set
                </button>
              </div>
              {builder && <CustomSetBuilder categories={data.categories} onClose={() => setBuilder(false)} />}
            </div>

            <div className="mt-8 space-y-12">
              {categories.map((c, i) => (
                <CategorySection key={c.id} category={c} user={data.user} index={i} />
              ))}
              <OpeningsSection openings={data.openings} query={q} user={data.user} />
              {q && !categories.length && !data.openings.some(o => o.name.toLowerCase().includes(q)) && (
                <p className="text-sm text-text-2">No theme or opening matches “{query}”.</p>
              )}
            </div>

            <p className="mt-14 text-[11px] text-text-2 leading-relaxed max-w-3xl">
              Puzzles come from the public-domain Lichess puzzle database.
              {data.source.db
                ? ` ${compactCount(data.source.puzzles)} hand-picked well-rated puzzles are indexed here from all ${compactCount(data.source.lichess_total)}, balanced across every theme and rating band`
                : ' The local index isn’t built yet, so puzzles stream live from the Lichess API'}
              {data.source.db ? ', with the live Lichess API as a fallback.' : '.'} Forked sub-themes are detected on the board with python-chess, using the same fork logic as Lichess’s own tagger.
            </p>
          </>
        )}
      </div>
    </div>
  )
}

// ── hero cards ──────────────────────────────────────────────────────────────

function Sparkline({ points }: { points: [number, number][] }) {
  if (points.length < 2) return null
  const ys = points.map(p => p[1])
  const lo = Math.min(...ys), hi = Math.max(...ys)
  const W = 220, H = 48
  const d = points.map((p, i) => {
    const x = (i / (points.length - 1)) * W
    const y = H - 4 - ((p[1] - lo) / Math.max(1, hi - lo)) * (H - 8)
    return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-12" preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={NEON} stopOpacity="0.22" />
          <stop offset="100%" stopColor={NEON} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d} L${W},${H} L0,${H} Z`} fill="url(#spark-fill)" />
      <path d={d} fill="none" stroke={NEON} strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function HeroCard({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}
      className={`card p-5 relative overflow-hidden ${className}`}>
      {children}
    </motion.div>
  )
}

function RatingCard({ user, stats }: { user: ThemesUser; stats?: StatsResponse }) {
  const acc = user.total ? Math.round((user.solved / user.total) * 100) : null
  return (
    <HeroCard>
      <p className="text-[11px] uppercase tracking-[0.2em] text-text-2">Puzzle rating</p>
      <div className="flex items-end gap-3 mt-2">
        <span className="font-display text-5xl font-semibold neon-text tabular-nums">{user.rating}</span>
        {user.provisional && <span className="text-xs text-text-2 mb-2" title="Provisional: a few more rated puzzles settle it">provisional</span>}
      </div>
      {stats && stats.history.length > 1
        ? <div className="mt-3"><Sparkline points={stats.history} /></div>
        : <p className="text-xs text-text-2 mt-3 leading-relaxed">
            {user.seeded_from
              ? `Seeded from your ${user.seeded_from} game rating, so your first puzzles are already at your level. Lichess starts everyone at 1500.`
              : 'Solve rated puzzles to calibrate. Each theme also gets its own rating.'}
          </p>}
      <div className="mt-4 grid grid-cols-3 gap-2 text-center">
        <MiniStat icon={Flame} label="Day streak" value={user.streak_days} />
        <MiniStat icon={CalendarDays} label="Today" value={`${user.today.w}/${user.today.n}`} />
        <MiniStat icon={Target} label="Accuracy" value={acc === null ? '–' : `${acc}%`} />
      </div>
    </HeroCard>
  )
}

function MiniStat({ icon: I, label, value }: { icon: LucideIcon; label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg bg-bg-2/70 border border-border px-2 py-2">
      <I size={13} className="mx-auto text-accent" />
      <p className="text-sm font-semibold text-text-0 mt-1 tabular-nums">{value}</p>
      <p className="text-[10px] text-text-2">{label}</p>
    </div>
  )
}

function ForYouCard({ user }: { user: ThemesUser }) {
  const navigate = useNavigate()
  return (
    <HeroCard className="border-accent/25">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] uppercase tracking-[0.2em] text-accent">Built for you</p>
        <span className="text-[10px] text-text-2">from your games + puzzle results</span>
      </div>
      {user.focus.length ? (
        <ul className="mt-3 space-y-1.5">
          {user.focus.slice(0, 4).map(f => (
            <li key={f.theme}>
              <Link to={`/puzzles/${f.theme}`} className="group flex items-center gap-3 rounded-lg px-2.5 py-2 -mx-1 hover:bg-bg-2 transition-colors">
                <span className="w-1.5 h-1.5 rounded-full bg-accent shadow-neon-sm flex-shrink-0" />
                <span className="text-sm text-text-0 font-medium">{f.name}</span>
                <span className="text-[11px] text-text-2 truncate flex-1">{f.reason}</span>
                <ArrowRight size={14} className="text-text-2 group-hover:text-accent flex-shrink-0" />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-text-1 leading-relaxed">
          Import your games and solve a few rated puzzles. We'll find the themes you actually lose to and line them up here.
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <button onClick={() => navigate('/puzzles/weak')} className="btn-primary text-sm inline-flex items-center gap-2">
          <Shuffle size={14} />Weak-spot mix
        </button>
        {user.review_due > 0 && (
          <button onClick={() => navigate('/puzzles/review')}
            className="text-sm px-3 py-2 rounded-lg border border-border text-text-0 hover:border-accent/40 inline-flex items-center gap-2">
            <RotateCcw size={14} />Review {user.review_due} missed
          </button>
        )}
      </div>
    </HeroCard>
  )
}

/** The board after the opponent's last move, i.e. the position the player faced. */
function facedFen(fen: string, uci: string): string {
  try {
    const c = new Chess(fen)
    c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
    return c.fen()
  } catch {
    return fen
  }
}

function YourGamesCard({ user }: { user: ThemesUser }) {
  const split = user.game_split ?? { blunders: 0, missed: user.game_puzzles }
  const s = user.game_sample
  const rows: { to: string; label: string; n: number; icon: LucideIcon; sub: string }[] = [
    { to: '/puzzles/game-blunders', label: 'Your blunders', n: split.blunders, icon: Swords, sub: 'find the move you should have played' },
    { to: '/puzzles/game-missed', label: 'Tactics you missed', n: split.missed, icon: Crosshair, sub: 'the win was there' },
  ]
  return (
    <HeroCard className="border-danger/25">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] uppercase tracking-[0.2em] text-danger">From your games</p>
        <span className="text-[10px] text-text-2">{user.game_puzzles} real positions</span>
      </div>
      {user.game_puzzles ? (
        <div className="mt-3 flex gap-4 items-start">
          {s && (
            <Link to="/puzzles/game" className="flex-shrink-0 rounded-md overflow-hidden ring-1 ring-border hover:ring-accent/50 transition" title={`Move ${s.move_number}${s.played_san ? ` · you played ${s.played_san}` : ''}`}>
              <MiniBoardThumbnail solid fen={facedFen(s.fen, s.moves)} size={104} orientation={s.color === 'w' ? 'white' : 'black'} />
            </Link>
          )}
          <ul className="min-w-0 flex-1 space-y-1">
            {rows.map(r => (
              <li key={r.to}>
                <Link to={r.to} aria-disabled={!r.n}
                  className={`group flex items-center gap-2.5 rounded-lg px-2 py-1.5 -mx-1 transition-colors ${r.n ? 'hover:bg-bg-2' : 'opacity-50 pointer-events-none'}`}>
                  <r.icon size={14} className="text-danger flex-shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-text-0 font-medium">{r.label} <span className="text-text-2 tabular-nums font-normal">· {r.n}</span></span>
                    <span className="block text-[11px] text-text-2 truncate">{r.sub}</span>
                  </span>
                  <ArrowRight size={14} className="text-text-2 group-hover:text-accent flex-shrink-0" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-3 text-sm text-text-1 leading-relaxed">
          Once your games are analysed, every position where you went wrong becomes a puzzle here.
        </p>
      )}
      {user.game_puzzles > 0 && (
        <Link to="/puzzles/game" className="mt-3 inline-flex items-center gap-1.5 text-sm text-accent font-medium">
          Practise all of them <ArrowRight size={14} />
        </Link>
      )}
    </HeroCard>
  )
}

function ThemeReport({ stats }: { stats: StatsResponse }) {
  const rows = [...stats.weaknesses.slice(0, 3), ...stats.strengths.slice(0, 3).reverse()]
    .filter((r, i, a) => a.findIndex(x => x.theme === r.theme) === i)
  const max = Math.max(60, ...rows.map(r => Math.abs(r.vs_overall)))
  return (
    <div className="card p-5 mt-4">
      <div className="flex items-center justify-between">
        <p className="text-[11px] uppercase tracking-[0.2em] text-text-2">Your theme report</p>
        <p className="text-[11px] text-text-2">theme rating vs your overall {stats.rating}</p>
      </div>
      <div className="mt-3 grid gap-x-8 gap-y-2 md:grid-cols-2">
        {rows.map(r => {
          const pct = Math.min(50, (Math.abs(r.vs_overall) / max) * 50)
          const up = r.vs_overall >= 0
          return (
            <Link key={r.theme} to={`/puzzles/${r.theme}`} className="group grid grid-cols-[9rem_1fr_3.5rem] items-center gap-3 text-xs">
              <span className="text-text-1 group-hover:text-accent truncate">{r.name}</span>
              <span className="relative h-2 rounded-full bg-bg-3">
                <span className="absolute top-0 bottom-0 left-1/2 w-px bg-border-hover" />
                <span className={`absolute top-0 bottom-0 rounded-full ${up ? 'bg-accent' : 'bg-danger'}`}
                  style={up ? { left: '50%', width: `${pct}%` } : { right: '50%', width: `${pct}%` }} />
              </span>
              <span className={`tabular-nums text-right ${up ? 'text-accent' : 'text-danger'}`}>{up ? '+' : ''}{r.vs_overall}</span>
            </Link>
          )
        })}
      </div>
    </div>
  )
}

// ── catalog ─────────────────────────────────────────────────────────────────

function CategorySection({ category, user, index }: { category: ThemeCategory; user: ThemesUser; index: number }) {
  const I = CATEGORY_ICON[category.id] ?? Puzzle
  const focus = new Set(user.focus.map(f => f.theme))
  return (
    <section id={`cat-${category.id}`} className="scroll-mt-32">
      <div className="flex items-start gap-3 mb-4">
        <span className={`w-9 h-9 rounded-xl grid place-items-center flex-shrink-0 border
          ${category.forked ? 'border-accent/40 bg-accent/10 text-accent shadow-neon-sm' : 'border-border bg-bg-1 text-text-1'}`}>
          <I size={16} />
        </span>
        <div className="min-w-0">
          <h2 className="font-display text-xl font-semibold text-text-0 flex items-center gap-2 flex-wrap">
            {category.title}
            {category.forked && <ForkedBadge />}
          </h2>
          <p className="text-sm text-text-2 mt-0.5 max-w-3xl">{category.blurb}</p>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {category.themes.map((t, i) => (
          <ThemeCard key={t.key} theme={t} user={user} index={index * 3 + i} focus={focus.has(t.key)} inForked={category.forked} />
        ))}
      </div>
    </section>
  )
}

export function ForkedBadge() {
  return (
    <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded border border-accent/40 text-accent bg-accent/[0.07]">
      Forked only
    </span>
  )
}

function ThemeCard({ theme, user, focus, index, inForked }: {
  theme: ThemeItem; user: ThemesUser; focus: boolean; index: number; inForked: boolean
}) {
  const navigate = useNavigate()
  const mine = user.themes[theme.key]
  const fromGames = user.game_by_theme[theme.key] ?? 0
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: '-40px' }}
      transition={{ duration: 0.25, delay: Math.min(index, 12) * 0.015 }}>
      <Link to={`/puzzles/${theme.key}`}
        className={`group flex gap-4 h-full rounded-xl border bg-bg-1/80 p-3.5 transition-all duration-200 hover:-translate-y-0.5
          ${focus ? 'border-accent/40 shadow-neon-sm' : 'border-border hover:border-accent/40'} hover:shadow-neon`}>
        <div className="flex-shrink-0 rounded-md overflow-hidden ring-1 ring-border group-hover:ring-accent/40 self-start">
          {theme.example
            ? <MiniBoardThumbnail solid fen={theme.example.fen} size={96} orientation={theme.example.color === 'w' ? 'white' : 'black'} />
            : <div className="w-[96px] h-[96px] grid place-items-center bg-bg-2 text-accent"><Shuffle size={22} /></div>}
        </div>
        <div className="min-w-0 flex-1 flex flex-col">
          <div className="flex items-start gap-2">
            <h3 className="font-display text-[15px] font-semibold text-text-0 leading-tight group-hover:text-accent transition-colors">{theme.name}</h3>
            {theme.forked && !inForked && <span className="mt-0.5 text-[9px] font-bold uppercase tracking-wider text-accent/90">Forked</span>}
            {focus && <span className="ml-auto mt-0.5 text-[9px] font-bold uppercase tracking-wider text-accent-ink bg-accent px-1.5 py-0.5 rounded">For you</span>}
          </div>
          <p className="text-xs text-text-2 mt-1 leading-relaxed line-clamp-2">{theme.desc}</p>
          <div className="mt-auto pt-2 flex items-center gap-x-3 gap-y-1 flex-wrap text-[11px]">
            <span className="text-text-1 tabular-nums">{compactCount(theme.count)} puzzles</span>
            {mine && mine.n > 0 && (
              <span className="inline-flex items-center gap-1.5 text-text-1" title={`${mine.n} played · ${Math.round((mine.acc ?? 0) * 100)}% solved`}>
                <span className="text-accent font-semibold tabular-nums">{mine.rating}</span>
                <span className="w-10 h-1 rounded-full bg-bg-3 overflow-hidden">
                  <span className="block h-full bg-accent" style={{ width: `${Math.round((mine.acc ?? 0) * 100)}%` }} />
                </span>
              </span>
            )}
            {fromGames > 0 && (
              <span className="text-danger/90" title="Positions from your own games where you missed this">×{fromGames} in your games</span>
            )}
          </div>
          {theme.sub.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {theme.sub.map(s => (
                <button key={s} onClick={e => { e.preventDefault(); e.stopPropagation(); navigate(`/puzzles/${s}`) }}
                  className="text-[10px] px-1.5 py-0.5 rounded border border-border text-text-2 hover:text-accent hover:border-accent/40 transition-colors">
                  {subLabel(s)}
                </button>
              ))}
            </div>
          )}
        </div>
      </Link>
    </motion.div>
  )
}

const SUB_LABEL: Record<string, string> = {
  knightFork: 'Knight', pawnFork: 'Pawn', queenFork: 'Queen', bishopFork: 'Bishop', rookFork: 'Rook', royalFork: 'Royal',
  queenSacrifice: 'Queen sac', exchangeSacrifice: 'Exchange sac', opposition: 'Opposition', pawnBreakthrough: 'Breakthrough',
  rookPawnVsRook: 'R+P vs R', oppositeBishops: 'Opposite bishops', bishopVsKnight: 'B vs N', rookVsMinor: 'R vs minor',
  queenVsRook: 'Q vs R',
}
const subLabel = (k: string) => SUB_LABEL[k] ?? k

function OpeningsSection({ openings, query, user }: { openings: OpeningFamily[]; query: string; user: ThemesUser }) {
  const [open, setOpen] = useState<string | null>(null)
  const [all, setAll] = useState(false)
  const list = useMemo(() => {
    if (!query) return openings
    return openings.filter(o => o.name.toLowerCase().includes(query) || o.variations.some(v => v.name.toLowerCase().includes(query)))
  }, [openings, query])
  if (!list.length) return null
  const shown = all || query ? list : list.slice(0, 24)
  return (
    <section id="cat-openings" className="scroll-mt-32">
      <div className="flex items-start gap-3 mb-4">
        <span className="w-9 h-9 rounded-xl grid place-items-center flex-shrink-0 border border-border bg-bg-1 text-text-1"><BookOpen size={16} /></span>
        <div>
          <h2 className="font-display text-xl font-semibold text-text-0">Openings</h2>
          <p className="text-sm text-text-2 mt-0.5">Tactics that come straight out of a specific opening. Train the traps in the lines you actually play.</p>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map(o => {
          const mine = user.themes[o.key]
          const expanded = open === o.key || (!!query && o.variations.some(v => v.name.toLowerCase().includes(query)))
          return (
            <div key={o.key} className="rounded-xl border border-border bg-bg-1/80 hover:border-accent/30 transition-colors">
              <div className="flex items-center gap-2 px-3.5 py-2.5">
                <Link to={`/puzzles/${o.key}`} className="min-w-0 flex-1 group">
                  <p className="text-sm text-text-0 font-medium truncate group-hover:text-accent">{o.name}</p>
                  <p className="text-[11px] text-text-2 tabular-nums">
                    {compactCount(o.count)} puzzles{mine?.n ? ` · you ${mine.rating}` : ''}
                  </p>
                </Link>
                {o.variations.length > 0 && (
                  <button onClick={() => setOpen(expanded ? null : o.key)} aria-expanded={expanded}
                    className="text-[11px] text-text-2 hover:text-accent inline-flex items-center gap-1 px-2 py-1 rounded-md hover:bg-bg-2">
                    {o.variations.length}<ChevronDown size={12} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
                  </button>
                )}
              </div>
              {expanded && (
                <ul className="border-t border-border px-2 py-1.5 max-h-56 overflow-y-auto">
                  {o.variations.map(v => (
                    <li key={v.key}>
                      <Link to={`/puzzles/${v.key}`} className="flex items-center justify-between gap-3 px-1.5 py-1.5 rounded-md text-xs hover:bg-bg-2 group">
                        <span className="text-text-1 group-hover:text-accent truncate">{v.name}</span>
                        <span className="text-text-2 tabular-nums flex-shrink-0">{compactCount(v.count)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )
        })}
      </div>
      {!query && list.length > 24 && (
        <button onClick={() => setAll(a => !a)} className="mt-3 btn-ghost text-sm">
          {all ? 'Show fewer' : `Show all ${list.length} openings`}
        </button>
      )}
    </section>
  )
}

// ── custom set builder ──────────────────────────────────────────────────────

function CustomSetBuilder({ categories, onClose }: { categories: ThemeCategory[]; onClose: () => void }) {
  const navigate = useNavigate()
  const [picked, setPicked] = useState<string[]>([])
  const [match, setMatch] = useState<'all' | 'any'>('all')
  const [filter, setFilter] = useState('')
  const all = useMemo(() => categories.filter(c => c.id !== 'recommended').flatMap(c => c.themes.map(t => ({ ...t, cat: c.title }))), [categories])
  const f = filter.trim().toLowerCase()
  const options = all.filter(t => !picked.includes(t.key) && (!f || t.name.toLowerCase().includes(f))).slice(0, f ? 40 : 28)
  const toggle = (k: string) => setPicked(p => p.includes(k) ? p.filter(x => x !== k) : [...p, k].slice(0, 5))
  const name = (k: string) => all.find(t => t.key === k)?.name ?? k
  const start = () => navigate(`/puzzles/custom?themes=${picked.join(',')}&match=${match}`)

  return (
    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="overflow-hidden">
      <div className="mt-3 rounded-xl border border-accent/25 bg-bg-1 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-text-0">Build a custom set</p>
            <p className="text-xs text-text-2 mt-0.5">Combine up to 5 themes, like <em>fork + endgame</em> or <em>pin or skewer</em>. Lichess only lets you train one theme at a time.</p>
          </div>
          <button onClick={onClose} className="text-text-2 hover:text-text-0" aria-label="Close builder"><X size={16} /></button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 min-h-[34px]">
          {picked.map((k, i) => (
            <span key={k} className="inline-flex items-center gap-1">
              {i > 0 && <span className="text-[10px] uppercase tracking-wider text-text-2 mx-1">{match === 'all' ? 'and' : 'or'}</span>}
              <button onClick={() => toggle(k)} className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-accent text-accent-ink font-semibold">
                {name(k)}<X size={11} />
              </button>
            </span>
          ))}
          {!picked.length && <span className="text-xs text-text-2">Pick themes below…</span>}
        </div>
        <div className="mt-3 flex flex-col md:flex-row gap-2 md:items-center">
          <input className="input md:w-64" placeholder="Filter themes…" value={filter} onChange={e => setFilter(e.target.value)} />
          <div className="inline-flex rounded-lg border border-border p-0.5 text-xs">
            {(['all', 'any'] as const).map(m => (
              <button key={m} onClick={() => setMatch(m)}
                className={`px-3 py-1.5 rounded-md ${match === m ? 'bg-bg-3 text-text-0' : 'text-text-2 hover:text-text-0'}`}>
                {m === 'all' ? 'Match all' : 'Match any'}
              </button>
            ))}
          </div>
          <button disabled={!picked.length} onClick={start} className="btn-primary text-sm md:ml-auto inline-flex items-center gap-2">
            Start set <ArrowRight size={14} />
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {options.map(t => (
            <button key={t.key} onClick={() => toggle(t.key)}
              className="text-xs px-2.5 py-1 rounded-full border border-border text-text-1 hover:text-accent hover:border-accent/40 transition-colors">
              {t.name}
            </button>
          ))}
        </div>
      </div>
    </motion.div>
  )
}

function CatalogSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        {[0, 1, 2].map(i => <div key={i} className="h-48 rounded-xl bg-bg-1 border border-border animate-pulse" />)}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 mt-8">
        {Array.from({ length: 9 }).map((_, i) => <div key={i} className="h-28 rounded-xl bg-bg-1 border border-border animate-pulse" />)}
      </div>
    </div>
  )
}
