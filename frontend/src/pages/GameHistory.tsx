import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
  AlertCircle, Bot, BookOpen, CheckCircle2, Clock, Crown, ExternalLink, Globe, Loader2, Microscope, RefreshCw,
  ScanLine, ScanSearch, Search, Sparkles, Trash2,
} from 'lucide-react'
import { SectionHeader } from '../components/layout/SectionHeader'
import { KeyMomentDropdowns } from '../components/review/KeyMoments'
import { useUserStore } from '../store/userStore'
import { historyApi, libraryApi, type KeyMoment, type LibraryGame, type PlatformGame } from '../api/library'
import { useOpenReview } from '../lib/review'
import { relativeTime, shortDate } from '../lib/format'
import { platformName } from '../lib/ratings'

type Tab = 'online' | 'forked'
const TIME_CLASSES = ['all', 'rapid', 'blitz', 'bullet', 'classical', 'daily'] as const

const SOURCE_FILTERS: { id: string; label: string; icon: typeof Bot }[] = [
  { id: '', label: 'All', icon: Sparkles },
  { id: 'maia', label: 'vs Maia', icon: Bot },
  { id: 'opening', label: 'Openings', icon: BookOpen },
  { id: 'endgame', label: 'Endgames', icon: Crown },
  { id: 'otb', label: 'OTB scans', icon: ScanLine },
  { id: 'reviewed', label: 'Reviewed', icon: ScanSearch },
]

function OutcomePill({ outcome }: { outcome: 'win' | 'loss' | 'draw' | null }) {
  if (!outcome) return <span className="text-[11px] text-text-2 w-12">—</span>
  const cls = outcome === 'win' ? 'text-success border-success/30 bg-success/10' : outcome === 'loss' ? 'text-danger border-danger/30 bg-danger/10' : 'text-text-1 border-border'
  return <span className={`text-[11px] font-semibold w-12 text-center px-1.5 py-0.5 rounded-md border ${cls}`}>{outcome === 'win' ? 'Won' : outcome === 'loss' ? 'Lost' : 'Draw'}</span>
}

function libOutcome(g: LibraryGame): 'win' | 'loss' | 'draw' | null {
  if (g.result === '1/2-1/2') return 'draw'
  if ((g.result !== '1-0' && g.result !== '0-1') || !g.user_color) return null
  return (g.result === '1-0') === (g.user_color === 'white') ? 'win' : 'loss'
}

function ReviewedBadge({ accuracy }: { accuracy?: number | null }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-success bg-success/10 border border-success/30 rounded-md px-1.5 py-0.5">
      <CheckCircle2 size={11} />Reviewed{accuracy != null ? ` · ${accuracy}%` : ''}
    </span>
  )
}

// ── online games ─────────────────────────────────────────────────────────────

function OnlineGames() {
  const { username, platform } = useUserStore()
  const navigate = useNavigate()
  const openReview = useOpenReview()
  const qc = useQueryClient()
  const [tc, setTc] = useState<(typeof TIME_CLASSES)[number]>('all')
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(40)
  const [starting, setStarting] = useState<string | null>(null)
  const { data, isLoading, error, isFetching, refetch } = useQuery({
    queryKey: ['history', username, platform],
    queryFn: () => historyApi.get(username, { platform }),
    enabled: !!username, staleTime: 5 * 60_000, retry: 1,
  })
  const games = useMemo(() => {
    let g = data?.games ?? []
    if (tc !== 'all') g = g.filter(x => x.time_class === tc)
    if (q) {
      const ql = q.toLowerCase()
      g = g.filter(x => `${x.white} ${x.black} ${x.opening ?? ''}`.toLowerCase().includes(ql))
    }
    return g
  }, [data, tc, q])

  function openMoment(g: PlatformGame, m: KeyMoment) {
    if (g.review.status === 'done' && g.moments_source === 'review') { navigate(`/game-review/${g.id}?ply=${m.ply}`); return }
    const arrows: { from: string; to: string; color: 'played' | 'best' }[] = []
    if (m.uci) arrows.push({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), color: 'played' })
    if (m.best_uci && m.best_uci !== m.uci) arrows.push({ from: m.best_uci.slice(0, 2), to: m.best_uci.slice(2, 4), color: 'best' })
    navigate('/analysis', { state: { pgn: g.pgn, ply: m.ply, before: true, arrows, title: `${g.white} – ${g.black} · move ${m.move_number}` } })
  }
  async function review(g: PlatformGame) {
    setStarting(g.id)
    try {
      await openReview({ pgn: g.pgn, source: 'platform', user_color: g.user_color, url: g.url, time_class: g.time_class, quality: 'standard' })
      void qc.invalidateQueries({ queryKey: ['history', username] })
    } finally { setStarting(null) }
  }

  if (isLoading) return <div className="card p-10 flex items-center justify-center gap-2 text-sm text-text-2"><Loader2 size={16} className="animate-spin text-accent" />Fetching your {platformName(platform)} games…</div>
  if (error || !data) return (
    <div className="card p-8 text-center">
      <AlertCircle size={18} className="mx-auto text-danger" />
      <p className="text-sm text-text-1 mt-2">{error instanceof Error ? error.message : 'Could not load your games.'}</p>
      <button className="btn-ghost border border-border mt-3 text-sm" onClick={() => void refetch()}>Try again</button>
    </div>
  )
  const counts = data.counts
  return (
    <div className="space-y-3">
      <div className="flex flex-col md:flex-row md:items-center gap-3">
        <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
          {TIME_CLASSES.filter(t => t === 'all' || counts[t]).map(t => (
            <button key={t} onClick={() => { setTc(t); setLimit(40) }}
              className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${tc === t ? 'bg-accent text-accent-ink border-accent' : 'border-border text-text-1 hover:text-text-0'}`}>
              {t === 'all' ? 'All' : t[0].toUpperCase() + t.slice(1)} <span className={tc === t ? 'opacity-70' : 'text-text-2'}>{counts[t] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <div className="relative md:w-64">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-2" />
          <input className="input pl-8 py-1.5 text-sm" placeholder="Opponent or opening…" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <button className="btn-ghost border border-border text-xs inline-flex items-center gap-1.5" disabled={isFetching}
          onClick={() => void historyApi.get(username, { platform, refresh: true }).then(d => qc.setQueryData(['history', username, platform], d))}>
          <RefreshCw size={12} className={isFetching ? 'animate-spin' : ''} />Refresh
        </button>
      </div>
      {data.stale && <p className="text-[11px] text-warn">Showing saved games — {platformName(platform)} couldn't be reached just now.</p>}
      {!games.length ? <p className="card p-8 text-center text-sm text-text-2">No games match.</p> : (
        <div className="card divide-y divide-border overflow-visible">
          {games.slice(0, limit).map((g, i) => {
            const me = g.user_color === 'white' ? g.white : g.black
            const opp = g.user_color === 'white' ? g.black : g.white
            const oppElo = g.user_color === 'white' ? g.black_elo : g.white_elo
            const myElo = g.user_color === 'white' ? g.white_elo : g.black_elo
            const reviewed = g.review.status === 'done'
            const running = g.review.status === 'queued' || g.review.status === 'running'
            const acc = reviewed ? g.review.accuracy?.[g.user_color] : null
            return (
              <motion.div key={g.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: Math.min(i, 12) * 0.015 }}
                className={`relative px-4 py-3 flex flex-col lg:flex-row lg:items-center gap-2 lg:gap-4 ${reviewed ? 'bg-success/[0.04]' : ''}`}>
                {reviewed && <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r bg-success" aria-hidden />}
                <div className="min-w-0 flex-1 flex items-center gap-3">
                  <OutcomePill outcome={g.outcome} />
                  <div className="min-w-0">
                    <p className="text-sm text-text-0 truncate">
                      <span className="text-text-2 text-xs mr-1.5">{g.user_color === 'white' ? '○' : '●'}</span>
                      vs <span className="font-medium">{opp}</span>{oppElo ? <span className="text-text-2 text-xs"> ({oppElo})</span> : null}
                      {g.url && <a href={g.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="inline-block ml-1.5 text-text-2 hover:text-accent align-middle" aria-label="Open on the site"><ExternalLink size={11} /></a>}
                    </p>
                    <p className="text-[11px] text-text-2 truncate">
                      {shortDate(g.played_at)} · {g.time_class}{g.time_control ? ` ${g.time_control}` : ''}{myElo ? ` · you ${myElo}` : ''}{g.opening ? ` · ${g.opening}` : ''}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap lg:justify-end">
                  {g.analysed && <span className="text-[10px] uppercase tracking-wider text-accent/80 border border-accent/25 rounded px-1.5 py-0.5" title="Included in your blindspot profile">blindspots</span>}
                  {reviewed ? (
                    <button onClick={() => navigate(`/game-review/${g.id}`)} title="Open the saved review — no recomputation"><ReviewedBadge accuracy={acc} /></button>
                  ) : running ? (
                    <button onClick={() => navigate(`/game-review/${g.id}`)} className="text-[11px] text-accent inline-flex items-center gap-1"><Loader2 size={11} className="animate-spin" />reviewing</button>
                  ) : (
                    <button onClick={() => void review(g)} disabled={starting === g.id}
                      className="text-xs px-2.5 py-1 rounded-lg border border-border text-text-1 hover:text-accent hover:border-accent/40 inline-flex items-center gap-1.5">
                      {starting === g.id ? <Loader2 size={12} className="animate-spin" /> : <ScanSearch size={12} />}Review
                    </button>
                  )}
                  <KeyMomentDropdowns compact moments={g.analysed || reviewed ? g.moments : null}
                    emptyHint="review to see mistakes" onOpen={m => openMoment(g, m)} />
                  <button onClick={() => navigate('/analysis', { state: { pgn: g.pgn, title: `${g.white} – ${g.black}` } })}
                    className="p-1.5 rounded-lg text-text-2 hover:text-accent hover:bg-bg-2" title="Open in Analysis Board"><Microscope size={14} /></button>
                </div>
              </motion.div>
            )
          })}
        </div>
      )}
      {games.length > limit && (
        <button className="w-full card py-2.5 text-sm text-text-1 hover:text-accent" onClick={() => setLimit(l => l + 40)}>Show more ({games.length - limit} left)</button>
      )}
      <p className="text-[11px] text-text-2">
        Mistakes and blunders come from your saved review when there is one, otherwise from your blindspot analysis (rapid games).
        Last fetched {relativeTime(data.fetched_at)}.
      </p>
    </div>
  )
}

// ── Forked games ─────────────────────────────────────────────────────────────

const SOURCE_ICON: Record<string, typeof Bot> = { maia: Bot, opening: BookOpen, endgame: Crown, otb: ScanLine, review: ScanSearch, platform: Globe, analysis: Microscope, coach: Sparkles }

function ForkedGames() {
  const { username } = useUserStore()
  const navigate = useNavigate()
  const openReview = useOpenReview()
  const qc = useQueryClient()
  const [source, setSource] = useState('')
  const [starting, setStarting] = useState<string | null>(null)
  const { data, isLoading, error } = useQuery({
    queryKey: ['library', username, source],
    queryFn: () => libraryApi.games(username, source === 'reviewed' ? { reviewed: true, limit: 300 } : { source: source || undefined, limit: 300 }),
    enabled: !!username,
    refetchInterval: q => (q.state.data?.games.some(g => g.review.status === 'queued' || g.review.status === 'running') ? 3000 : false),
    staleTime: 15_000,
  })
  async function review(g: LibraryGame) {
    setStarting(g.id)
    try {
      const full = g.pgn ? g : (await libraryApi.game(username, g.id)).game
      await openReview({ pgn: full.pgn!, source: g.source, user_color: g.user_color ?? undefined, quality: 'standard' })
    } finally { setStarting(null) }
  }
  async function analyse(g: LibraryGame) {
    const full = (await libraryApi.game(username, g.id)).game
    navigate('/analysis', { state: { pgn: full.pgn, title: g.title, reviewId: g.review.status === 'done' ? g.id : undefined } })
  }
  async function remove(g: LibraryGame) {
    if (!confirm(`Remove "${g.title}" from your Forked history?`)) return
    await libraryApi.deleteGame(username, g.id).catch(() => undefined)
    void qc.invalidateQueries({ queryKey: ['library', username] })
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
        {SOURCE_FILTERS.map(f => (
          <button key={f.id} onClick={() => setSource(f.id)}
            className={`flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${source === f.id ? 'bg-accent text-accent-ink border-accent' : 'border-border text-text-1 hover:text-text-0'}`}>
            <f.icon size={12} />{f.label}
          </button>
        ))}
      </div>
      {isLoading ? <div className="card p-10 flex items-center justify-center gap-2 text-sm text-text-2"><Loader2 size={16} className="animate-spin text-accent" />Loading…</div>
        : error ? <p className="card p-6 text-sm text-danger">{(error as Error).message}</p>
        : !data?.games.length ? (
          <div className="card p-8 text-center">
            <p className="text-sm text-text-0 font-medium">Nothing here yet</p>
            <p className="text-xs text-text-2 mt-1">Games you finish against Maia (including opening and endgame practice), games you review and scoresheets you confirm in OTB Scan collect here.</p>
          </div>
        ) : (
          <div className="card divide-y divide-border">
            {data.games.map(g => {
              const Icon = SOURCE_ICON[g.source] ?? Sparkles
              const reviewed = g.review.status === 'done'
              const running = g.review.status === 'queued' || g.review.status === 'running'
              const acc = reviewed ? (g.user_color ? g.review.accuracy?.[g.user_color] : null) : null
              return (
                <div key={g.id} className={`relative px-4 py-3 flex flex-col lg:flex-row lg:items-center gap-2 lg:gap-4 ${reviewed ? 'bg-success/[0.04]' : ''}`}>
                  {reviewed && <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r bg-success" aria-hidden />}
                  <div className="min-w-0 flex-1 flex items-center gap-3">
                    <span className="w-8 h-8 rounded-lg bg-bg-2 border border-border grid place-items-center text-accent flex-shrink-0" title={g.source_label}><Icon size={14} /></span>
                    <OutcomePill outcome={libOutcome(g)} />
                    <div className="min-w-0">
                      <p className="text-sm text-text-0 truncate">{g.title}</p>
                      <p className="text-[11px] text-text-2 truncate">{g.source_label} · {relativeTime(g.played_at)} · {Math.ceil(g.plies / 2)} moves{g.opening?.name ? ` · ${g.opening.name}` : ''}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap lg:justify-end">
                    {reviewed ? (
                      <button onClick={() => navigate(`/game-review/${g.id}`)} title="Open the saved review"><ReviewedBadge accuracy={acc} /></button>
                    ) : running ? (
                      <button onClick={() => navigate(`/game-review/${g.id}`)} className="text-[11px] text-accent inline-flex items-center gap-1"><Loader2 size={11} className="animate-spin" />reviewing {g.review.progress ? `${g.review.progress[0]}/${g.review.progress[1]}` : ''}</button>
                    ) : (
                      <button onClick={() => void review(g)} disabled={starting === g.id}
                        className="text-xs px-2.5 py-1 rounded-lg border border-border text-text-1 hover:text-accent hover:border-accent/40 inline-flex items-center gap-1.5">
                        {starting === g.id ? <Loader2 size={12} className="animate-spin" /> : <ScanSearch size={12} />}Review
                      </button>
                    )}
                    <KeyMomentDropdowns compact moments={reviewed ? (g.key_moments ?? { mistakes: [], blunders: [] }) : null}
                      emptyHint={running ? undefined : 'review to see mistakes'} onOpen={m => navigate(`/game-review/${g.id}?ply=${m.ply}`)} />
                    <button onClick={() => void analyse(g)} className="p-1.5 rounded-lg text-text-2 hover:text-accent hover:bg-bg-2" title="Open in Analysis Board"><Microscope size={14} /></button>
                    <button onClick={() => void remove(g)} className="p-1.5 rounded-lg text-text-2 hover:text-danger hover:bg-bg-2" title="Remove"><Trash2 size={13} /></button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
    </div>
  )
}

export default function GameHistory() {
  const [params, setParams] = useSearchParams()
  const tab: Tab = params.get('tab') === 'forked' ? 'forked' : 'online'
  const { platform } = useUserStore()
  return (
    <div className="px-4 sm:px-6 py-6 sm:py-8 max-w-6xl mx-auto">
      <SectionHeader icon={Clock} title="Game History"
        description="Every game you played online and on Forked — with the mistakes and blunders one click from the board." />
      <div className="flex p-1 rounded-xl bg-bg-1 border border-border mb-4 w-full sm:w-fit">
        {([['online', `${platformName(platform)} games`, Globe], ['forked', 'Forked games', Sparkles]] as const).map(([id, label, Icon]) => (
          <button key={id} onClick={() => setParams(id === 'online' ? {} : { tab: id })}
            className={`flex-1 sm:flex-none px-4 py-2 rounded-lg text-sm font-semibold inline-flex items-center justify-center gap-2 transition-colors ${tab === id ? 'bg-accent text-accent-ink' : 'text-text-1 hover:text-text-0'}`}>
            <Icon size={14} />{label}
          </button>
        ))}
      </div>
      {tab === 'online' ? <OnlineGames /> : <ForkedGames />}
    </div>
  )
}
