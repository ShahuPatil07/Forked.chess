import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
  Zap, Target, BookOpen, TrendingUp, ChevronRight, AlertCircle, Bot,
  LayoutDashboard, Clock, Flame, Crosshair, Activity, Gauge,
} from 'lucide-react'
import { SectionHeader } from '../components/layout/SectionHeader'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  PieChart, Pie, ScatterChart, Scatter, ZAxis,
} from 'recharts'
import { useUserStore } from '../store/userStore'
import { api } from '../api'
import { BlindspotAlerts } from '../components/dashboard/BlindspotAlerts'
import { RatingImpact } from '../components/dashboard/RatingImpact'
import { insightsApi } from '../api/insights'
import type { ClusterSummary, AnalyticsData } from '../types'

// ── Palette ──────────────────────────────────────────────────────────────────

const ACCENT    = '#7B61FF'
const PURPLE400 = '#a78bfa'
const PURPLE300 = '#c4b5fd'
const DANGER    = '#f87171'
const SUCCESS   = '#4ade80'
const AMBER      = '#fbbf24'
const GRID      = '#242436'
const TEXT2     = '#A0A0B8'

const THREAT_PALETTE = [ACCENT, PURPLE400, PURPLE300, '#818cf8', '#6366f1', '#a5b4fc', '#ddd6fe']
const PHASE_PALETTE: Record<string, string> = { opening: ACCENT, middlegame: PURPLE400, endgame: PURPLE300 }

// ── Small shared pieces ────────────────────────────────────────────────────────

function UrgencyBar({ score }: { score: number }) {
  // Scores are small (freq×recency×severity). Normalise against a sensible ceiling.
  const pct = Math.min(100, Math.round((score / 0.04) * 100))
  const color = pct > 66 ? 'bg-danger' : pct > 33 ? 'bg-accent' : 'bg-success'
  return (
    <div className="flex-1 h-1.5 bg-bg-3 rounded-full overflow-hidden">
      <div className={`h-full ${color} rounded-full transition-all duration-500`} style={{ width: `${pct}%` }} />
    </div>
  )
}

function MasteryRing({ mastery }: { mastery: number }) {
  const r = 12
  const circ = 2 * Math.PI * r
  const offset = circ * (1 - mastery)
  return (
    <svg width="34" height="34" viewBox="0 0 34 34" className="flex-shrink-0">
      <circle cx="17" cy="17" r={r} fill="none" stroke="#242436" strokeWidth="3" />
      <circle
        cx="17" cy="17" r={r}
        fill="none" stroke="#7B61FF" strokeWidth="3"
        strokeDasharray={circ}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform="rotate(-90 17 17)"
        style={{ transition: 'stroke-dashoffset 0.6s ease' }}
      />
      <text x="17" y="20.5" textAnchor="middle" fontSize="8" fill="#A0A0B8" fontWeight="600">
        {Math.round(mastery * 100)}
      </text>
    </svg>
  )
}

type ChipTone = 'muted' | 'accent' | 'danger' | 'amber' | 'success'
const TONE_CLASS: Record<ChipTone, string> = {
  muted:   'text-text-2 bg-bg-3/60 border-border',
  accent:  'text-accent bg-accent/10 border-accent/25',
  danger:  'text-danger bg-danger/10 border-danger/25',
  amber:   'text-amber-300 bg-amber-400/10 border-amber-400/25',
  success: 'text-success bg-success/10 border-success/25',
}

function Chip({ icon: Icon, children, tone = 'muted', title }:
  { icon?: any; children: React.ReactNode; tone?: ChipTone; title?: string }) {
  return (
    <span title={title}
      className={`inline-flex items-center gap-1 text-[10.5px] font-medium px-1.5 py-0.5
                  rounded-md border ${TONE_CLASS[tone]} whitespace-nowrap`}>
      {Icon && <Icon size={10} />}
      {children}
    </span>
  )
}

// ── Detailed blindspot card ─────────────────────────────────────────────────────

function recencyTag(days: number | null | undefined): { label: string; tone: ChipTone } | null {
  if (days == null) return null
  if (days < 14) return { label: 'Active', tone: 'danger' }
  if (days < 30) return { label: 'Recent', tone: 'amber' }
  return { label: 'Fading', tone: 'muted' }
}

function PhaseStrip({ breakdown }: { breakdown: Record<string, number> }) {
  const entries = Object.entries(breakdown)
  const total = entries.reduce((s, [, c]) => s + c, 0)
  if (!total) return null
  return (
    <div className="flex h-1.5 w-full rounded-full overflow-hidden bg-bg-3">
      {entries.map(([phase, c]) => (
        <div key={phase} title={`${phase}: ${c}`}
          style={{ width: `${(c / total) * 100}%`, background: PHASE_PALETTE[phase] ?? PURPLE300 }} />
      ))}
    </div>
  )
}

function BlindspotCard({ cluster, idx, gain }: { cluster: ClusterSummary; idx: number; gain?: number }) {
  const navigate = useNavigate()
  const e = cluster.enrichment
  const rec = recencyTag(e?.last_seen_days)
  const tp = e?.time_pressure_share ?? null
  const cid = String(cluster.cluster_id)

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: idx * 0.05, duration: 0.3 }}
      className="card p-4 flex flex-col gap-3 hover:border-accent/30 transition-colors group"
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="flex flex-col items-center gap-1 pt-0.5">
          <span className="w-6 h-6 rounded-md bg-bg-3 text-xs font-bold text-text-1 grid place-items-center">
            {cluster.rank ?? idx + 1}
          </span>
        </div>
        <button onClick={() => navigate(`/blindspot/${cid}`)} className="flex-1 min-w-0 text-left">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-text-0 truncate group-hover:text-accent transition-colors">
              {cluster.label}
            </p>
            {gain != null && gain > 0 && (
              <span className="text-[10px] font-semibold text-success bg-success/10 border border-success/25
                               px-1.5 py-0.5 rounded-full flex-shrink-0 tabular-nums"
                    title="Estimated rating points recoverable by fixing this pattern">
                +{gain} pts
              </span>
            )}
          </div>
          {cluster.skill && <p className="text-[11px] text-text-2 mt-0.5 leading-snug truncate">{cluster.skill}</p>}
        </button>
        <MasteryRing mastery={cluster.mastery} />
      </div>

      {/* Context chips */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip icon={Crosshair} title="Times this pattern appeared in your games">
          {cluster.size} mistakes
        </Chip>
        {e && (
          <Chip icon={Flame} tone={e.avg_drop_cp >= 300 ? 'danger' : 'muted'}
            title="Average evaluation lost when you make this mistake">
            avg −{e.avg_drop_cp}cp
          </Chip>
        )}
        <Chip icon={BookOpen} tone="accent" title="Game phase where this most often happens">
          {(e?.dominant_phase ?? cluster.dominant_game_phase)}
        </Chip>
        {tp != null && tp > 0 && (
          <Chip icon={Clock} tone={tp >= 0.4 ? 'amber' : 'muted'}
            title="Share of these mistakes made with under 30s on the clock">
            {Math.round(tp * 100)}% time pressure
          </Chip>
        )}
        {e && e.blunder_count > 0 && (
          <Chip tone="danger" title="Mistakes of 300cp or worse">
            {e.blunder_count} blunders
          </Chip>
        )}
        {rec && <Chip tone={rec.tone} title="Recency of the most recent occurrence">{rec.label}</Chip>}
      </div>

      {/* Phase distribution strip */}
      {e && <PhaseStrip breakdown={e.phase_breakdown} />}

      {/* Footer: urgency + actions */}
      <div className="flex items-center gap-3 pt-0.5">
        <span className="text-[10px] text-text-2 uppercase tracking-wide flex-shrink-0">Urgency</span>
        <UrgencyBar score={cluster.score} />
        <button
          onClick={() => navigate('/session', { state: { clusterId: cid } })}
          className="text-[11px] font-medium text-accent hover:text-accent/70 transition-colors whitespace-nowrap flex items-center gap-1 flex-shrink-0"
          title="Drill puzzles targeting this blindspot">
          <Zap size={11} /> Drill
        </button>
        <button
          onClick={() => navigate(`/replay/${cid}`)}
          className="text-[11px] text-text-2 hover:text-accent transition-colors whitespace-nowrap flex-shrink-0"
          title="Replay every real-game position where you made this mistake">
          Replay →
        </button>
      </div>
    </motion.div>
  )
}

// ── Hero stat band ──────────────────────────────────────────────────────────────

function HeroTile({ label, icon: Icon, children, delay }:
  { label: string; icon: any; children: React.ReactNode; delay: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay }}
      className="card p-4">
      <div className="flex items-center gap-1.5 text-text-2 text-[11px] mb-2">
        <Icon size={12} /> {label}
      </div>
      {children}
    </motion.div>
  )
}

// ── Analytics ───────────────────────────────────────────────────────────────────

function ChartCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="card p-5">
      <p className="text-xs font-semibold text-text-2 uppercase tracking-wider mb-0.5">{title}</p>
      {subtitle && <p className="text-xs text-text-2 mb-4">{subtitle}</p>}
      {!subtitle && <div className="mb-4" />}
      {children}
    </div>
  )
}

function SignalCards({ data }: { data: AnalyticsData }) {
  const sev = data.severity
  const tp  = data.time_pressure
  const maia = data.maia
  const hardPct = maia?.has_data && maia.buckets
    ? Math.round((maia.buckets[2].count / Math.max(1, maia.buckets.reduce((s, b) => s + b.count, 0))) * 100)
    : null

  return (
    <div className="grid grid-cols-3 gap-4 mb-5">
      {/* Severity */}
      <div className="card p-4">
        <div className="flex items-center gap-1.5 text-text-2 text-[11px] mb-2"><Flame size={12} /> Severity</div>
        {sev ? (
          <>
            <p className="text-2xl font-bold text-text-0">−{sev.avg_drop}<span className="text-sm text-text-2">cp avg</span></p>
            <div className="flex h-1.5 w-full rounded-full overflow-hidden bg-bg-3 mt-2">
              <div style={{ width: `${pctOf(sev.inaccuracies, sev)}%`, background: PURPLE300 }} />
              <div style={{ width: `${pctOf(sev.mistakes, sev)}%`, background: ACCENT }} />
              <div style={{ width: `${pctOf(sev.blunders, sev)}%`, background: DANGER }} />
            </div>
            <p className="text-[10px] text-text-2 mt-1.5">
              <span className="text-danger font-semibold">{sev.blunders}</span> blunders ·{' '}
              {sev.mistakes} mistakes
            </p>
          </>
        ) : <p className="text-xs text-text-2">No data</p>}
      </div>

      {/* Time pressure */}
      <div className="card p-4">
        <div className="flex items-center gap-1.5 text-text-2 text-[11px] mb-2"><Clock size={12} /> Time pressure</div>
        {tp?.has_data && tp.share != null ? (
          <>
            <p className="text-2xl font-bold text-text-0">{Math.round(tp.share * 100)}<span className="text-sm text-text-2">% under 30s</span></p>
            <div className="flex items-end gap-1 h-6 mt-2">
              {tp.buckets.map(b => {
                const max = Math.max(1, ...tp.buckets.map(x => x.count))
                return (
                  <div key={b.label} className="flex-1 flex flex-col items-center gap-0.5" title={`${b.label}: ${b.count}`}>
                    <div className="w-full rounded-sm bg-accent/70" style={{ height: `${(b.count / max) * 100}%` }} />
                  </div>
                )
              })}
            </div>
            <p className="text-[10px] text-text-2 mt-1">{tp.buckets.map(b => b.label).join(' · ')}</p>
          </>
        ) : <p className="text-xs text-text-2">No clock data in these games</p>}
      </div>

      {/* Maia difficulty */}
      <div className="card p-4">
        <div className="flex items-center gap-1.5 text-text-2 text-[11px] mb-2"><Gauge size={12} /> Difficulty</div>
        {maia?.has_data && hardPct != null ? (
          <>
            <p className="text-2xl font-bold text-text-0">{hardPct}<span className="text-sm text-text-2">% truly hard</span></p>
            <div className="flex h-1.5 w-full rounded-full overflow-hidden bg-bg-3 mt-2">
              {maia.buckets!.map((b, i) => {
                const total = Math.max(1, maia.buckets!.reduce((s, x) => s + x.count, 0))
                return <div key={b.label} title={`${b.label}: ${b.count}`}
                  style={{ width: `${(b.count / total) * 100}%`, background: [SUCCESS, AMBER, DANGER][i] }} />
              })}
            </div>
            <p className="text-[10px] text-text-2 mt-1.5">vs human (Maia) move likelihood</p>
          </>
        ) : <p className="text-xs text-text-2">No Maia data</p>}
      </div>
    </div>
  )
}

function pctOf(n: number, sev: { inaccuracies: number; mistakes: number; blunders: number }): number {
  const total = sev.inaccuracies + sev.mistakes + sev.blunders
  return total ? (n / total) * 100 : 0
}

function AnalyticsSection({ data }: { data: AnalyticsData }) {
  const phaseData = data.phase_breakdown.map(d => ({
    ...d,
    fill: PHASE_PALETTE[d.phase] ?? PURPLE300,
    label: d.phase.charAt(0).toUpperCase() + d.phase.slice(1),
  }))

  const threatData = data.threat_stats.slice(0, 8).map((t, i) => ({
    ...t,
    label: t.threat.replace(/_/g, ' '),
    fill: THREAT_PALETTE[i % THREAT_PALETTE.length],
  }))

  const moveBuckets = data.moves_aggregated.slice(0, 14)

  const scatterByPhase: Record<string, { x: number; y: number }[]> = {}
  for (const pt of data.scatter) {
    if (!scatterByPhase[pt.game_phase]) scatterByPhase[pt.game_phase] = []
    scatterByPhase[pt.game_phase].push({ x: pt.move_number, y: pt.eval_drop_cp })
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.2, duration: 0.4 }}
      className="mt-10"
    >
      <h2 className="text-xs font-semibold text-text-2 uppercase tracking-wider mb-5">Profile analytics</h2>

      {/* Signal cards */}
      <SignalCards data={data} />

      <div className="grid grid-cols-2 gap-5">
        {/* Mistakes by game phase — donut */}
        <ChartCard title="Mistakes by phase" subtitle="Distribution across game stages">
          <div className="flex items-center gap-4">
            <ResponsiveContainer width={140} height={140}>
              <PieChart>
                <Pie data={phaseData} dataKey="count" nameKey="label" cx="50%" cy="50%"
                  innerRadius={42} outerRadius={62} paddingAngle={3} strokeWidth={0}>
                  {phaseData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                </Pie>
                <Tooltip content={({ active, payload }) => {
                  if (!active || !payload?.length) return null
                  const d = payload[0].payload
                  return (
                    <div className="bg-bg-2 border border-border rounded-lg px-3 py-2 text-xs shadow-lg">
                      <p style={{ color: d.fill }}>{d.label}</p>
                      <p className="text-text-0 font-semibold">{d.count} mistakes</p>
                    </div>
                  )
                }} />
              </PieChart>
            </ResponsiveContainer>
            <div className="flex flex-col gap-2">
              {phaseData.map(d => (
                <div key={d.phase} className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: d.fill }} />
                  <span className="text-xs text-text-2 capitalize">{d.label}</span>
                  <span className="text-xs font-semibold text-text-0 ml-1">{d.count}</span>
                </div>
              ))}
            </div>
          </div>
        </ChartCard>

        {/* Threat types — avg eval drop */}
        <ChartCard title="Threat type severity" subtitle="Average centipawn loss per threat">
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={threatData} layout="vertical" margin={{ left: 4, right: 8 }}>
              <XAxis type="number" tick={{ fill: TEXT2, fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis dataKey="label" type="category" width={90} tick={{ fill: TEXT2, fontSize: 10 }} axisLine={false} tickLine={false} />
              <Tooltip content={({ active, payload }) => {
                if (!active || !payload?.length) return null
                const d = payload[0].payload
                return (
                  <div className="bg-bg-2 border border-border rounded-lg px-3 py-2 text-xs shadow-lg">
                    <p style={{ color: d.fill }} className="capitalize">{d.label}</p>
                    <p className="text-text-0">avg drop: <span className="font-semibold text-danger">{d.avg_drop}cp</span></p>
                    <p className="text-text-2">{d.count} mistakes</p>
                  </div>
                )
              }} cursor={{ fill: GRID }} />
              <Bar dataKey="avg_drop" radius={[0, 3, 3, 0]}>
                {threatData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Eval drop by move bucket — bar chart */}
        <ChartCard title="Mistakes by move number" subtitle="5-move buckets — count and average eval loss">
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={moveBuckets} margin={{ left: -16, right: 4 }}>
              <XAxis dataKey="label" tick={{ fill: TEXT2, fontSize: 9 }} axisLine={false} tickLine={false} />
              <YAxis yAxisId="count" orientation="left" tick={{ fill: TEXT2, fontSize: 9 }} axisLine={false} tickLine={false} />
              <YAxis yAxisId="drop" orientation="right" tick={{ fill: TEXT2, fontSize: 9 }} axisLine={false} tickLine={false} />
              <Tooltip content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null
                return (
                  <div className="bg-bg-2 border border-border rounded-lg px-3 py-2 text-xs shadow-lg">
                    <p className="text-text-2 mb-1">Moves {label}</p>
                    {payload.map((p: any, i: number) => (
                      <p key={i} style={{ color: p.color }}>{p.name}: {p.value}{p.name === 'avg drop' ? 'cp' : ''}</p>
                    ))}
                  </div>
                )
              }} cursor={{ fill: GRID }} />
              <Bar yAxisId="count" dataKey="count" name="mistakes" fill={ACCENT} opacity={0.85} radius={[3, 3, 0, 0]} />
              <Bar yAxisId="drop" dataKey="avg_drop" name="avg drop" fill={DANGER} opacity={0.7} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
          <div className="flex items-center gap-4 mt-2">
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-sm" style={{ background: ACCENT }} />
              <span className="text-xs text-text-2">Mistake count</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-sm" style={{ background: DANGER }} />
              <span className="text-xs text-text-2">Avg eval drop (cp)</span>
            </div>
          </div>
        </ChartCard>

        {/* Scatter: eval drop vs move number */}
        <ChartCard title="Eval drop vs move number" subtitle="Each dot is one mistake — coloured by game phase">
          <ResponsiveContainer width="100%" height={180}>
            <ScatterChart margin={{ left: -16, right: 4, bottom: 0 }}>
              <XAxis dataKey="x" name="Move" type="number" tick={{ fill: TEXT2, fontSize: 9 }} axisLine={false} tickLine={false}
                label={{ value: 'Move #', fill: TEXT2, fontSize: 9, position: 'insideBottom', offset: -2 }} />
              <YAxis dataKey="y" name="Drop (cp)" type="number" tick={{ fill: TEXT2, fontSize: 9 }} axisLine={false} tickLine={false} />
              <ZAxis range={[18, 18]} />
              <Tooltip content={({ active, payload }) => {
                if (!active || !payload?.length) return null
                const { x, y } = payload[0].payload
                return (
                  <div className="bg-bg-2 border border-border rounded-lg px-3 py-2 text-xs shadow-lg">
                    <p className="text-text-2">Move <span className="text-text-0 font-semibold">{x}</span></p>
                    <p className="text-danger font-semibold">−{y}cp</p>
                  </div>
                )
              }} cursor={{ strokeDasharray: '3 3', stroke: GRID }} />
              {Object.entries(scatterByPhase).map(([phase, pts]) => (
                <Scatter key={phase} name={phase} data={pts} fill={PHASE_PALETTE[phase] ?? PURPLE300} opacity={0.65} />
              ))}
            </ScatterChart>
          </ResponsiveContainer>
          <div className="flex items-center gap-4 mt-1">
            {Object.entries(PHASE_PALETTE).map(([phase, color]) => (
              <div key={phase} className="flex items-center gap-1.5">
                <div className="w-2.5 h-2.5 rounded-full" style={{ background: color }} />
                <span className="text-xs text-text-2 capitalize">{phase}</span>
              </div>
            ))}
          </div>
        </ChartCard>
      </div>
    </motion.div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { username, elo } = useUserStore()
  const navigate = useNavigate()
  const [showAll, setShowAll] = useState(false)

  const { data, isLoading, error } = useQuery({
    queryKey: ['profile', username],
    queryFn: () => api.getProfile(username),
    enabled: !!username,
  })

  const { data: analytics } = useQuery({
    queryKey: ['analytics', username],
    queryFn: () => api.getAnalytics(username),
    enabled: !!username,
    staleTime: 5 * 60 * 1000,
  })

  const { data: cf } = useQuery({
    queryKey: ['counterfactual', username],
    queryFn: () => insightsApi.counterfactual(username),
    enabled: !!username,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
  const { data: style } = useQuery({
    queryKey: ['style', username],
    queryFn: () => insightsApi.style(username),
    enabled: !!username,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })

  const gainByCluster: Record<string, number> = {}
  if (cf?.has_result_data) {
    for (const c of cf.per_cluster) gainByCluster[String(c.cluster_id)] = c.gain
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <AlertCircle size={20} className="text-danger" />
        <p className="text-sm text-text-2">Failed to load profile.</p>
        <button onClick={() => navigate('/')} className="btn-ghost text-sm">Return to start</button>
      </div>
    )
  }

  const { stats, clusters } = data
  const sorted = [...clusters].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  const visible = showAll ? sorted : sorted.slice(0, 4)
  const topBlindspot = sorted[0]

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <SectionHeader
        icon={LayoutDashboard}
        title="Dashboard"
        description={`Your blindspot map ranked by urgency · ${username}${elo ? ` · ${elo} ELO` : ''}`}
        right={
          <div className="flex items-center gap-2">
            <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
              onClick={() => navigate('/bot-game')} className="btn-ghost flex items-center gap-2">
              <Bot size={14} /> Play vs Maia
            </motion.button>
            <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
              onClick={() => navigate('/session')} className="btn-primary flex items-center gap-2">
              <Zap size={14} /> Start drilling
            </motion.button>
          </div>
        }
      />

      {/* Live blindspot alerts + sync status */}
      <BlindspotAlerts />

      {/* Hero stat band */}
      <div className="grid grid-cols-4 gap-4 mb-8">
        <HeroTile label="Games analysed" icon={BookOpen} delay={0}>
          <p className="text-3xl font-bold text-text-0">{stats.total_games.toLocaleString()}</p>
        </HeroTile>
        <HeroTile label="Mistakes logged" icon={Activity} delay={0.06}>
          <p className="text-3xl font-bold text-danger">{stats.total_mistakes.toLocaleString()}</p>
        </HeroTile>
        <HeroTile label="Blindspots" icon={Target} delay={0.12}>
          <p className="text-3xl font-bold text-accent">{clusters.length}</p>
          {topBlindspot && (
            <p className="text-[11px] text-text-2 mt-1 truncate">top: {topBlindspot.label}</p>
          )}
        </HeroTile>
        <HeroTile label="Rating potential" icon={TrendingUp} delay={0.18}>
          {cf?.has_result_data && cf.total_gain > 0 ? (
            <>
              <p className="text-3xl font-bold text-text-0 tabular-nums flex items-baseline gap-1">
                {cf.potential_rating}
                <span className="text-xs font-semibold text-success">+{cf.total_gain}</span>
              </p>
              <p className="text-[11px] text-text-2 mt-1">from {cf.actual_rating} · fix all blindspots</p>
            </>
          ) : (
            <>
              <p className="text-3xl font-bold text-text-0 tabular-nums">{elo || '—'}</p>
              <p className="text-[11px] text-text-2 mt-1">{style?.archetype ?? 'current rating'}</p>
            </>
          )}
        </HeroTile>
      </div>

      {/* Counterfactual rating ladder + shareable Chess DNA */}
      <RatingImpact />

      {/* Detailed blindspots */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-semibold text-text-2 uppercase tracking-wider">Your blindspots — ranked by urgency</h2>
        <span className="text-[11px] text-text-2">{sorted.length} found</span>
      </div>
      <div className="grid grid-cols-2 gap-4">
        {visible.map((cluster, i) => (
          <BlindspotCard key={cluster.cluster_id} cluster={cluster} idx={i}
            gain={gainByCluster[String(cluster.cluster_id)]} />
        ))}
      </div>
      {sorted.length > 4 && (
        <button onClick={() => setShowAll(!showAll)}
          className="text-xs text-accent hover:text-accent/70 mt-3 transition-colors flex items-center gap-1">
          {showAll ? 'Show less' : `Show all ${sorted.length} blindspots`}
          <ChevronRight size={12} className={showAll ? '-rotate-90' : 'rotate-90'} />
        </button>
      )}

      {/* Analytics charts */}
      {analytics && <AnalyticsSection data={analytics} />}
    </div>
  )
}
