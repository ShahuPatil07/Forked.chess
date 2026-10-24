import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
  AlertCircle, AlertTriangle, ArrowRight, Bot, BookOpen, ChevronDown, Clock, Crosshair, Flame, Info,
  LayoutDashboard, Lightbulb, Play, Sparkles, Target, ThumbsUp, Zap,
} from 'lucide-react'
import { SectionHeader } from '../components/layout/SectionHeader'
import { useUserStore } from '../store/userStore'
import { api } from '../api'
import { BlindspotAlerts } from '../components/dashboard/BlindspotAlerts'
import { RatingImpact } from '../components/dashboard/RatingImpact'
import {
  ConversionCard, EvalArc, PairedBars, ProgressHistogram, SimpleBars, SkillRadar, TrendChart,
} from '../components/dashboard/charts'
import { insightsApi, type Insights } from '../api/insights'
import { platformName } from '../lib/ratings'
import { lossPts } from '../lib/format'
import { CHART } from '../theme'
import type { ClusterSummary } from '../types'

// ── blindspot cards (ranked by the Stage-2 v2 score) ─────────────────────────

type ChipTone = 'muted' | 'accent' | 'danger' | 'amber' | 'success'
const TONE_CLASS: Record<ChipTone, string> = {
  muted: 'text-text-2 bg-bg-3/60 border-border',
  accent: 'text-accent bg-accent/10 border-accent/25',
  danger: 'text-danger bg-danger/10 border-danger/25',
  amber: 'text-warn bg-warn/10 border-warn/25',
  success: 'text-success bg-success/10 border-success/25',
}

function Chip({ icon: Icon, children, tone = 'muted', title }: { icon?: typeof Flame; children: ReactNode; tone?: ChipTone; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-md border ${TONE_CLASS[tone]} whitespace-nowrap`}>
      {Icon && <Icon size={10} />}{children}
    </span>
  )
}

const STATUS_CHIP: Record<string, { label: string; tone: ChipTone; title: string }> = {
  confirmed: { label: 'Confirmed', tone: 'danger', title: 'You make this mistake clearly more often than players at your rating (≥90% sure)' },
  emerging: { label: 'Emerging', tone: 'amber', title: 'Probably more often than your peers, but not certain yet' },
  typical: { label: 'Typical', tone: 'muted', title: 'About as often as players at your rating' },
  strength: { label: 'Strength', tone: 'success', title: 'Less often than players at your rating' },
  insufficient_data: { label: 'Not enough data', tone: 'muted', title: 'Too few incidents to judge yet' },
}

function directionSummary(d: Record<string, number> | undefined): string | null {
  if (!d) return null
  const allowed = (d.allowed ?? 0) + (d.both ?? 0) / 2
  const missed = (d.missed ?? 0) + (d.both ?? 0) / 2
  if (allowed + missed < 0.2) return null
  return allowed >= missed ? `${Math.round(allowed * 100)}% walked into` : `${Math.round(missed * 100)}% missed shots`
}

function MasteryRing({ mastery }: { mastery: number }) {
  const r = 13, circ = 2 * Math.PI * r
  return (
    <svg width="36" height="36" viewBox="0 0 36 36" className="flex-shrink-0" aria-label={`Mastery ${Math.round(mastery * 100)}%`}>
      <circle cx="18" cy="18" r={r} fill="none" stroke={CHART.grid} strokeWidth="3" />
      <circle cx="18" cy="18" r={r} fill="none" stroke={CHART.you} strokeWidth="3" strokeDasharray={circ}
        strokeDashoffset={circ * (1 - mastery)} strokeLinecap="round" transform="rotate(-90 18 18)" style={{ transition: 'stroke-dashoffset .6s ease' }} />
      <text x="18" y="21.5" textAnchor="middle" fontSize="9" fill="#A3A3A3" fontWeight="600">{Math.round(mastery * 100)}</text>
    </svg>
  )
}

function BlindspotCard({ cluster, idx, gain }: { cluster: ClusterSummary; idx: number; gain?: number }) {
  const navigate = useNavigate()
  const e = cluster.enrichment
  const p = cluster.profile
  const cid = String(cluster.cluster_id)
  const status = p ? STATUS_CHIP[p.status] : undefined
  const rel = p?.relative_rate ?? null
  const dir = directionSummary(p?.direction)
  const hit = p?.hit_rate
  // v2 score = points lost per 10 games (0.75·excess over peers + 0.25·raw impact); ~1.0 is a severe leak
  const urgency = Math.min(100, Math.round(((cluster.score ?? 0) / 1.0) * 100))
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: idx * 0.05 }}
      className="card p-4 flex flex-col gap-3 hover:border-accent/30 transition-colors group">
      <div className="flex items-start gap-3">
        <span className="w-7 h-7 rounded-lg bg-bg-3 text-xs font-bold text-text-1 grid place-items-center flex-shrink-0">{cluster.rank ?? idx + 1}</span>
        <button onClick={() => navigate(`/blindspot/${cid}`)} className="flex-1 min-w-0 text-left">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-text-0 group-hover:text-accent transition-colors">{cluster.label}</p>
            {gain != null && gain > 0 && (
              <span className="text-[10px] font-semibold text-success bg-success/10 border border-success/25 px-1.5 py-0.5 rounded-full"
                title="Estimated rating points recoverable by fixing this pattern">+{gain} rating</span>
            )}
          </div>
          {cluster.skill && <p className="text-[11px] text-text-2 mt-0.5 leading-snug">{cluster.skill}</p>}
        </button>
        <MasteryRing mastery={cluster.mastery} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {status && <Chip tone={status.tone} title={p?.status_reasons?.length ? `${status.title}. Why: ${p.status_reasons.join('; ')}` : status.title}>{status.label}</Chip>}
        {rel != null && (
          <Chip tone={rel >= 1.3 ? 'danger' : rel <= 0.8 ? 'success' : 'muted'}
            title={`You: ${p!.rate_per_100.toFixed(2)} per 100 moves · players you faced: ${(p!.peer_rate_per_100 ?? 0).toFixed(2)}`}>
            {rel.toFixed(2)}× peers
          </Chip>
        )}
        {dir && <Chip tone="accent" title="Did you walk into the opponent's tactic, or miss your own?">{dir}</Chip>}
        {hit && hit.user != null && hit.opportunities >= 3 && (
          <Chip tone={hit.peer != null && hit.user_shrunk < hit.peer - 0.05 ? 'amber' : 'muted'}
            title={`Tactics of this kind you found when available (peers: ${hit.peer != null ? Math.round(hit.peer * 100) + '%' : 'n/a'})`}>
            finds {Math.round(hit.user * 100)}%
          </Chip>
        )}
        <Chip icon={Crosshair} title="Incidents in your games (repeats of one oversight count once)">{e?.incidents ?? cluster.size} incidents</Chip>
        {e && e.blunder_count > 0 && <Chip tone="danger" title="Blunders: lost 15%+ of your winning chances in one move">{e.blunder_count} blunders</Chip>}
        {e && <Chip icon={Flame} tone={e.avg_drop_cp >= 300 ? 'danger' : 'muted'} title="Average evaluation lost per incident">avg {lossPts(e.avg_drop_cp)}</Chip>}
        <Chip icon={BookOpen} tone="accent" title="Phase where this most often happens">{e?.dominant_phase ?? cluster.dominant_game_phase}</Chip>
        {e?.time_pressure_share != null && e.time_pressure_share > 0.15 && <Chip icon={Clock} tone="amber" title="Share made with under 30s on the clock">{Math.round(e.time_pressure_share * 100)}% time trouble</Chip>}
      </div>
      <div className="flex items-center gap-3 pt-0.5">
        <span className="text-[10px] text-text-2 uppercase tracking-wide flex-shrink-0">Urgency</span>
        <div className="flex-1 h-1.5 bg-bg-3 rounded-full overflow-hidden">
          <div className={`h-full rounded-full ${urgency > 66 ? 'bg-danger' : urgency > 33 ? 'bg-warn' : 'bg-success'}`} style={{ width: `${urgency}%` }} />
        </div>
        <button onClick={() => navigate('/session', { state: { clusterId: cid } })}
          className="text-[11px] font-semibold text-accent hover:text-accent/70 inline-flex items-center gap-1"><Zap size={11} /> Drill</button>
        <button onClick={() => navigate(`/replay/${cid}`)} className="text-[11px] text-text-2 hover:text-accent">Replay →</button>
      </div>
    </motion.div>
  )
}

// ── KPI tiles ────────────────────────────────────────────────────────────────

function Kpi({ label, value, sub, delta, tone }: { label: string; value: ReactNode; sub?: ReactNode; delta?: ReactNode; tone?: 'good' | 'bad' }) {
  return (
    <div className="card p-4 min-w-0">
      <p className="text-[11px] text-text-2">{label}</p>
      <p className="text-2xl sm:text-[28px] leading-tight font-semibold text-text-0 mt-1">{value}</p>
      {delta && <p className={`text-[11px] mt-0.5 ${tone === 'good' ? 'text-success' : tone === 'bad' ? 'text-danger' : 'text-text-2'}`}>{delta}</p>}
      {sub && <p className="text-[11px] text-text-2 mt-0.5">{sub}</p>}
    </div>
  )
}

function HeroRating({ insights }: { insights?: Insights }) {
  const { elo, platform } = useUserStore()
  const series = (insights?.trend ?? []).map(t => t.rating).filter((r): r is number => r != null)
  const W = 260, H = 54
  const lo = Math.min(...series), hi = Math.max(...series)
  const path = series.length > 1 ? series.map((r, i) => `${i ? 'L' : 'M'}${(i / (series.length - 1)) * W},${H - 4 - ((r - lo) / Math.max(1, hi - lo)) * (H - 8)}`).join(' ') : ''
  const change = series.length > 1 ? series[series.length - 1] - series[0] : null
  return (
    <div className="card p-5 relative overflow-hidden lg:row-span-2 flex flex-col">
      <div aria-hidden className="absolute -right-20 -top-20 w-64 h-64 rounded-full bg-accent/[0.06] blur-3xl" />
      <p className="text-[11px] text-text-2 relative">Your rapid rating · {platformName(platform)}</p>
      <p className="text-6xl font-semibold text-text-0 mt-2 relative leading-none">{elo || '—'}</p>
      {change != null && (
        <p className={`text-xs mt-2 relative ${change >= 0 ? 'text-success' : 'text-danger'}`}>
          {change >= 0 ? '▲' : '▼'} {Math.abs(change)} over your last {series.length} analysed games
        </p>
      )}
      {path && (
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-14 mt-auto pt-4 relative" preserveAspectRatio="none" aria-label="Rating across analysed games">
          <path d={path} fill="none" stroke={CHART.you} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        </svg>
      )}
      {insights?.overview.performance && (
        <p className="text-[11px] text-text-2 mt-2 relative">Performance in these games: <span className="text-text-1">{insights.overview.performance}</span> vs avg opponent {insights.overview.avg_opp_elo}</p>
      )}
    </div>
  )
}

const TONE_ICON = { danger: AlertTriangle, warn: AlertCircle, good: ThumbsUp, info: Lightbulb } as const
const TONE_STYLE = { danger: 'border-danger/30 text-danger', warn: 'border-warn/30 text-warn', good: 'border-success/30 text-success', info: 'border-accent/30 text-accent' } as const

function Findings({ items }: { items: Insights['findings'] }) {
  if (!items.length) return null
  return (
    <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
      {items.map((f, i) => {
        const Icon = TONE_ICON[f.tone]
        return (
          <motion.div key={f.title} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 * i }}
            className="card p-4 flex gap-3">
            <span className={`w-8 h-8 rounded-lg border grid place-items-center flex-shrink-0 ${TONE_STYLE[f.tone]}`}><Icon size={15} /></span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-text-0 leading-snug">{f.title}</p>
              <p className="text-xs text-text-2 mt-1 leading-relaxed">{f.body}</p>
            </div>
          </motion.div>
        )
      })}
    </div>
  )
}

function SectionTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-3 mt-10 mb-4">
      <h2 className="text-lg font-semibold text-text-0">{children}</h2>
      {sub && <span className="text-[11px] text-text-2">{sub}</span>}
    </div>
  )
}

// ── page ─────────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { username, platform } = useUserStore()
  const navigate = useNavigate()
  const [showAll, setShowAll] = useState(false)

  const { data, isLoading, error } = useQuery({
    queryKey: ['profile', username], queryFn: () => api.getProfile(username), enabled: !!username,
  })
  const { data: insights, isLoading: insightsLoading } = useQuery({
    queryKey: ['insights', username], queryFn: () => insightsApi.insights(username), enabled: !!username,
    staleTime: 5 * 60_000, retry: false,
  })
  const { data: cf } = useQuery({
    queryKey: ['counterfactual', username], queryFn: () => insightsApi.counterfactual(username), enabled: !!username,
    staleTime: 5 * 60_000, retry: false,
  })

  if (isLoading) {
    return <div className="flex items-center justify-center h-64"><div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" /></div>
  }
  if (error || !data) {
    return (
      <div className="max-w-lg mx-auto px-4 py-16 text-center">
        <AlertCircle size={22} className="text-text-2 mx-auto" />
        <p className="text-lg font-semibold text-text-0 mt-3">No blindspot profile yet</p>
        <p className="text-sm text-text-2 mt-1">Import your {platformName(platform)} games to build it — it takes a few minutes.</p>
        <button onClick={() => void api.startIngest(username, platform, 80).then(r => navigate(`/loading/${r.job_id}`))}
          className="btn-primary mt-5 inline-flex items-center gap-2"><Play size={14} /> Analyse my games</button>
      </div>
    )
  }

  const { stats, clusters } = data
  const sorted = [...clusters].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  const visible = showAll ? sorted : sorted.slice(0, 4)
  const gainByCluster: Record<string, number> = {}
  for (const c of cf?.per_cluster ?? []) gainByCluster[String(c.cluster_id)] = c.gain
  const o = insights?.overview

  const cmp = (you?: number | null, peer?: number | null, lowerIsBetter = true) => {
    if (you == null || peer == null) return { text: undefined, tone: undefined as 'good' | 'bad' | undefined }
    const better = lowerIsBetter ? you < peer : you > peer
    return { text: `peers ${peer}`, tone: (Math.abs(you - peer) < 0.05 * Math.max(1, Math.abs(peer)) ? undefined : better ? 'good' : 'bad') as 'good' | 'bad' | undefined }
  }
  const acc = cmp(o?.accuracy, o?.peer_accuracy, false)
  const mpg = cmp(o?.you_per_game.mistake, o?.peer_per_game.mistake)
  const bpg = cmp(o?.you_per_game.blunder, o?.peer_per_game.blunder)

  return (
    <div className="px-4 sm:px-6 lg:px-8 py-6 sm:py-8 max-w-7xl mx-auto">
      <SectionHeader icon={LayoutDashboard} title="Dashboard"
        description={`How you lose, measured on ${stats.total_games} analysed rapid games and compared with the players you faced in them.`}
        right={
          <div className="flex items-center gap-2">
            <button onClick={() => navigate('/bot-game')} className="btn-ghost hidden sm:flex items-center gap-2"><Bot size={14} /> Play Maia</button>
            <button onClick={() => navigate('/session')} className="btn-primary flex items-center gap-2"><Zap size={14} /> Drill</button>
          </div>
        } />

      <BlindspotAlerts />

      {/* headline */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-[1.25fr_1fr_1fr_1fr]">
        <div className="col-span-2 lg:col-span-1 lg:row-span-2"><HeroRating insights={insights} /></div>
        <Kpi label="Games analysed" value={stats.total_games} sub={o ? `${o.wins}W · ${o.draws}D · ${o.losses}L · score ${Math.round((o.score ?? 0) * 100)}%` : undefined} />
        <Kpi label="Accuracy" value={o?.accuracy != null ? `${o.accuracy}%` : '—'} delta={acc.text} tone={acc.tone} />
        <Kpi label="Rating if fixed" value={cf?.has_result_data ? cf.potential_rating : '—'}
          delta={cf?.has_result_data && cf.total_gain > 0 ? `+${cf.total_gain} from turning points` : undefined} tone="good" />
        <Kpi label="Mistakes per game" value={o?.you_per_game.mistake ?? '—'} delta={mpg.text} tone={mpg.tone} />
        <Kpi label="Blunders per game" value={o?.you_per_game.blunder ?? '—'} delta={bpg.text} tone={bpg.tone} />
        <Kpi label="Winning positions converted" value={insights?.conversion.you.conversion_rate != null ? `${Math.round(insights.conversion.you.conversion_rate * 100)}%` : '—'}
          delta={insights?.conversion.peer.conversion_rate != null ? `peers ${Math.round(insights.conversion.peer.conversion_rate * 100)}%` : undefined}
          tone={insights && (insights.conversion.you.conversion_rate ?? 0) < (insights.conversion.peer.conversion_rate ?? 0) ? 'bad' : 'good'} />
      </div>

      {insights && insights.findings.length > 0 && (
        <>
          <SectionTitle sub="computed from your games, not generated text"><span className="inline-flex items-center gap-2"><Sparkles size={16} className="text-accent" /> What your games say</span></SectionTitle>
          <Findings items={insights.findings} />
        </>
      )}

      <SectionTitle sub={`${sorted.length} families · Stage-2 score: excess vs peers + cost`}>Your blindspots — ranked by urgency</SectionTitle>
      <div className="grid md:grid-cols-2 gap-3">
        {visible.map((c, i) => <BlindspotCard key={c.cluster_id} cluster={c} idx={i} gain={gainByCluster[String(c.cluster_id)]} />)}
      </div>
      {sorted.length > 4 && (
        <button onClick={() => setShowAll(s => !s)} className="text-xs text-accent hover:text-accent/70 mt-3 inline-flex items-center gap-1">
          {showAll ? 'Show fewer' : `Show all ${sorted.length} blindspots`}<ChevronDown size={12} className={showAll ? 'rotate-180' : ''} />
        </button>
      )}

      <div className="grid lg:grid-cols-2 gap-3 mt-6">
        <RatingImpact />
        {insights ? <SkillRadar data={insights.radar} /> : <div className="card h-80 animate-pulse" />}
      </div>

      <SectionTitle sub={insightsLoading ? 'computing…' : o ? `${o.you_moves.toLocaleString()} of your moves · ${o.peer_moves.toLocaleString()} peer moves` : undefined}>The arc of your games</SectionTitle>
      {insights ? (
        <div className="grid xl:grid-cols-2 gap-3">
          <ProgressHistogram data={insights.progress} />
          <EvalArc data={insights.eval_arc} />
          <ConversionCard data={insights.conversion} />
          <PairedBars title="Mistakes by situation" tableHead="Situation" unit="%"
            subtitle="Share of your moves that are mistakes or blunders when you were ahead, level or behind (expected score ≥65% / between / ≤35%)."
            rows={insights.situations.map(s => ({ label: s.situation[0].toUpperCase() + s.situation.slice(1),
              you: s.you_rate != null ? +(s.you_rate * 100).toFixed(1) : null, peer: s.peer_rate != null ? +(s.peer_rate * 100).toFixed(1) : null }))} />
        </div>
      ) : <div className="grid xl:grid-cols-2 gap-3">{[0, 1, 2, 3].map(i => <div key={i} className="card h-80 animate-pulse" />)}</div>}

      {insights && (
        <>
          <SectionTitle>Habits</SectionTitle>
          <div className="grid lg:grid-cols-3 gap-3">
            <PairedBars title="Accuracy through the game" tableHead="Stage" unit="%"
              subtitle="Your accuracy in each third of the game vs your opponents'."
              rows={insights.stages.map(s => ({ label: s.stage.split(' ')[0], you: s.you, peer: s.peer }))} />
            <SimpleBars title="How long you thought before blundering" valueLabel="Blunders"
              subtitle={insights.clock.fast_blunder_share != null
                ? <><span className="text-text-0">{Math.round(insights.clock.fast_blunder_share * 100)}%</span> of blunders took under 5 seconds · median {insights.clock.median_blunder_think_s}s.</>
                : 'No clock data in these games.'}
              rows={insights.clock.think_buckets.map(b => ({ label: b.label, value: b.count }))} />
            <SimpleBars title="Which piece makes your mistakes" valueLabel="Mistakes + blunders" horizontal
              subtitle="The piece you moved on each mistake or blunder."
              rows={insights.pieces.map(p => ({ label: p.piece, value: p.count, note: `${p.count} (${Math.round(p.share * 100)}%)` }))} />
          </div>
          <div className="grid lg:grid-cols-[1.6fr_1fr] gap-3 mt-3">
            <TrendChart data={insights.trend} />
            <div className="grid gap-3">
              <SimpleBars title="How much each mistake cost" valueLabel="Incidents" height="h-40"
                subtitle="Winning chances lost in one move."
                rows={insights.severity.map(s => ({ label: s.label, value: s.count }))} />
              <div className="card p-4">
                <h3 className="text-sm font-semibold text-text-0">White vs Black</h3>
                <table className="w-full text-xs mt-3">
                  <thead><tr className="text-text-2"><th className="text-left font-medium pb-1.5"></th><th className="text-right font-medium">Games</th><th className="text-right font-medium">Score</th><th className="text-right font-medium">Accuracy</th><th className="text-right font-medium">Blunders/g</th></tr></thead>
                  <tbody>
                    {insights.colors.map(c => (
                      <tr key={c.color} className="border-t border-border">
                        <td className="py-1.5 text-text-1 capitalize">{c.color}</td>
                        <td className="text-right tabular-nums text-text-0">{c.games}</td>
                        <td className="text-right tabular-nums text-text-0">{c.score != null ? `${Math.round(c.score * 100)}%` : '—'}</td>
                        <td className="text-right tabular-nums text-text-0">{c.accuracy ?? '—'}%</td>
                        <td className="text-right tabular-nums text-text-0">{c.blunders_per_game ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}

      <div className="card p-4 mt-10 flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <Info size={16} className="text-text-2 flex-shrink-0" />
        <p className="text-xs text-text-2 leading-relaxed flex-1">
          Mistakes are judged by lost winning chances (Lichess's model: inaccuracy ≥5%, mistake ≥10%, blunder ≥15%), not raw centipawns.
          "Players you faced" are your opponents in the same games — a rating-matched baseline. Evaluations are shown in points (1 point = one pawn).
        </p>
        <button onClick={() => navigate('/session')} className="btn-ghost border border-border text-xs inline-flex items-center gap-1.5 flex-shrink-0"><Target size={12} /> Train these <ArrowRight size={12} /></button>
      </div>
    </div>
  )
}
