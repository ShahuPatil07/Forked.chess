import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Zap, Target, BookOpen, TrendingUp, ChevronRight, AlertCircle } from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  PieChart, Pie, ScatterChart, Scatter, ZAxis,
} from 'recharts'
import { useUserStore } from '../store/userStore'
import { api } from '../api'
import type { ClusterSummary, AnalyticsData } from '../types'

// ── Palette ──────────────────────────────────────────────────────────────────

const ACCENT    = '#7B61FF'
const PURPLE400 = '#a78bfa'
const PURPLE300 = '#c4b5fd'
const DANGER    = '#f87171'
const SUCCESS   = '#4ade80'
const GRID      = '#242436'
const TEXT2     = '#A0A0B8'

const THREAT_PALETTE = [ACCENT, PURPLE400, PURPLE300, '#818cf8', '#6366f1', '#a5b4fc', '#ddd6fe']
const PHASE_PALETTE  = { opening: ACCENT, middlegame: PURPLE400, endgame: PURPLE300 }

// ── Reusable chart tooltip ────────────────────────────────────────────────────

function DarkTooltip({ active, payload, label, formatter }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-bg-2 border border-border rounded-lg px-3 py-2 text-xs shadow-lg">
      {label !== undefined && <p className="text-text-2 mb-1">{label}</p>}
      {payload.map((p: any, i: number) => (
        <p key={i} style={{ color: p.color ?? TEXT2 }}>
          {formatter ? formatter(p.name, p.value) : `${p.name}: ${p.value}`}
        </p>
      ))}
    </div>
  )
}

// ── Dashboard sub-components ──────────────────────────────────────────────────

function UrgencyBar({ score }: { score: number }) {
  const pct = Math.min(100, Math.round(score * 100))
  const color = pct > 66 ? 'bg-danger' : pct > 33 ? 'bg-accent' : 'bg-success'
  return (
    <div className="w-20 h-1.5 bg-bg-3 rounded-full overflow-hidden">
      <div className={`h-full ${color} rounded-full transition-all duration-500`} style={{ width: `${pct}%` }} />
    </div>
  )
}

function MasteryRing({ mastery }: { mastery: number }) {
  const r = 10
  const circ = 2 * Math.PI * r
  const offset = circ * (1 - mastery)
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" className="flex-shrink-0">
      <circle cx="14" cy="14" r={r} fill="none" stroke="#242436" strokeWidth="2.5" />
      <circle
        cx="14" cy="14" r={r}
        fill="none" stroke="#7B61FF" strokeWidth="2.5"
        strokeDasharray={circ}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform="rotate(-90 14 14)"
        style={{ transition: 'stroke-dashoffset 0.6s ease' }}
      />
      <text x="14" y="18" textAnchor="middle" fontSize="7" fill="#A0A0B8" fontWeight="600">
        {Math.round(mastery * 100)}
      </text>
    </svg>
  )
}

function BlindspotRow({ cluster, idx }: { cluster: ClusterSummary; idx: number }) {
  const navigate = useNavigate()
  return (
    <motion.div
      initial={{ opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: idx * 0.04, duration: 0.3 }}
      onClick={() => navigate(`/blindspot/${cluster.cluster_id}`)}
      className="flex items-center gap-4 px-4 py-3.5 rounded-lg bg-bg-1 border border-border
                 hover:border-accent/30 hover:bg-bg-2 transition-all duration-150 cursor-pointer group"
    >
      <span className="w-5 text-xs font-bold text-text-2 text-center flex-shrink-0">
        {cluster.rank ?? idx + 1}
      </span>
      <MasteryRing mastery={cluster.mastery} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-text-0 truncate">{cluster.label}</p>
        <p className="text-xs text-text-2 mt-0.5">
          {cluster.size} mistakes &middot; {(cluster.dominant_threat_type ?? '').replace(/_/g, ' ')}
        </p>
      </div>
      <div className="flex items-center gap-4 flex-shrink-0">
        <UrgencyBar score={cluster.score} />
        <ChevronRight size={13} className="text-bg-3 group-hover:text-accent/60 transition-colors" />
      </div>
    </motion.div>
  )
}

// ── Analytics section ─────────────────────────────────────────────────────────

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

function AnalyticsSection({ data }: { data: AnalyticsData }) {
  // ── Phase donut ───────────────────────────────────────────────────────────
  const phaseColors: Record<string, string> = PHASE_PALETTE
  const phaseData = data.phase_breakdown.map(d => ({
    ...d,
    fill: phaseColors[d.phase] ?? PURPLE300,
    label: d.phase.charAt(0).toUpperCase() + d.phase.slice(1),
  }))

  // ── Threat bars ───────────────────────────────────────────────────────────
  const threatData = data.threat_stats.slice(0, 8).map((t, i) => ({
    ...t,
    label: t.threat.replace(/_/g, ' '),
    fill: THREAT_PALETTE[i % THREAT_PALETTE.length],
  }))

  // ── Move bucket bars ──────────────────────────────────────────────────────
  const moveBuckets = data.moves_aggregated.slice(0, 14)

  // ── Scatter ───────────────────────────────────────────────────────────────
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
      <h2 className="text-xs font-semibold text-text-2 uppercase tracking-wider mb-5">Analytics</h2>

      <div className="grid grid-cols-2 gap-5">
        {/* Mistakes by game phase — donut */}
        <ChartCard title="Mistakes by phase" subtitle="Distribution across game stages">
          <div className="flex items-center gap-4">
            <ResponsiveContainer width={140} height={140}>
              <PieChart>
                <Pie
                  data={phaseData}
                  dataKey="count"
                  nameKey="label"
                  cx="50%"
                  cy="50%"
                  innerRadius={42}
                  outerRadius={62}
                  paddingAngle={3}
                  strokeWidth={0}
                >
                  {phaseData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                </Pie>
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null
                    const d = payload[0].payload
                    return (
                      <div className="bg-bg-2 border border-border rounded-lg px-3 py-2 text-xs shadow-lg">
                        <p style={{ color: d.fill }}>{d.label}</p>
                        <p className="text-text-0 font-semibold">{d.count} mistakes</p>
                      </div>
                    )
                  }}
                />
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
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null
                  const d = payload[0].payload
                  return (
                    <div className="bg-bg-2 border border-border rounded-lg px-3 py-2 text-xs shadow-lg">
                      <p style={{ color: d.fill }} className="capitalize">{d.label}</p>
                      <p className="text-text-0">avg drop: <span className="font-semibold text-danger">{d.avg_drop}cp</span></p>
                      <p className="text-text-2">{d.count} mistakes</p>
                    </div>
                  )
                }}
                cursor={{ fill: GRID }}
              />
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
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null
                  return (
                    <div className="bg-bg-2 border border-border rounded-lg px-3 py-2 text-xs shadow-lg">
                      <p className="text-text-2 mb-1">Moves {label}</p>
                      {payload.map((p: any, i: number) => (
                        <p key={i} style={{ color: p.color }}>{p.name}: {p.value}{p.name === 'avg drop' ? 'cp' : ''}</p>
                      ))}
                    </div>
                  )
                }}
                cursor={{ fill: GRID }}
              />
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
              <XAxis
                dataKey="x" name="Move" type="number"
                tick={{ fill: TEXT2, fontSize: 9 }} axisLine={false} tickLine={false}
                label={{ value: 'Move #', fill: TEXT2, fontSize: 9, position: 'insideBottom', offset: -2 }}
              />
              <YAxis
                dataKey="y" name="Drop (cp)" type="number"
                tick={{ fill: TEXT2, fontSize: 9 }} axisLine={false} tickLine={false}
              />
              <ZAxis range={[18, 18]} />
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null
                  const { x, y } = payload[0].payload
                  return (
                    <div className="bg-bg-2 border border-border rounded-lg px-3 py-2 text-xs shadow-lg">
                      <p className="text-text-2">Move <span className="text-text-0 font-semibold">{x}</span></p>
                      <p className="text-danger font-semibold">−{y}cp</p>
                    </div>
                  )
                }}
                cursor={{ strokeDasharray: '3 3', stroke: GRID }}
              />
              {Object.entries(scatterByPhase).map(([phase, pts], i) => (
                <Scatter
                  key={phase}
                  name={phase}
                  data={pts}
                  fill={phaseColors[phase] ?? PURPLE300}
                  opacity={0.65}
                />
              ))}
            </ScatterChart>
          </ResponsiveContainer>
          <div className="flex items-center gap-4 mt-1">
            {Object.entries(phaseColors).map(([phase, color]) => (
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
  const visible = showAll ? sorted : sorted.slice(0, 6)

  return (
    <div className="p-8 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-text-0">Blindspot Profile</h1>
          <p className="text-text-2 text-sm mt-1">
            {username} &middot; {elo ? `${elo} ELO` : 'ELO unknown'}
          </p>
        </div>
        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={() => navigate('/session')}
          className="btn-primary flex items-center gap-2"
        >
          <Zap size={14} />
          Start drilling
        </motion.button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        {[
          { label: 'Games analysed', value: stats.total_games, icon: BookOpen, color: 'text-text-0' },
          { label: 'Blindspots found', value: clusters.length, icon: Target, color: 'text-accent' },
          { label: 'Mistakes logged', value: stats.total_mistakes, icon: TrendingUp, color: 'text-danger' },
        ].map(({ label, value, icon: Icon, color }, i) => (
          <motion.div
            key={label}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.08 }}
            className="card p-5"
          >
            <div className="flex items-center gap-2 text-text-2 text-xs mb-3">
              <Icon size={12} />
              {label}
            </div>
            <p className={`text-3xl font-bold ${color}`}>{value.toLocaleString()}</p>
          </motion.div>
        ))}
      </div>

      <div className="grid grid-cols-5 gap-6">
        {/* Blindspot list */}
        <div className="col-span-3">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-semibold text-text-2 uppercase tracking-wider">Ranked by urgency</h2>
          </div>
          <div className="space-y-1.5">
            {visible.map((cluster, i) => (
              <BlindspotRow key={cluster.cluster_id} cluster={cluster} idx={i} />
            ))}
          </div>
          {sorted.length > 6 && (
            <button
              onClick={() => setShowAll(!showAll)}
              className="text-xs text-accent hover:text-accent/70 mt-3 transition-colors"
            >
              {showAll ? 'Show less' : `+${sorted.length - 6} more`}
            </button>
          )}
        </div>

        {/* Threat breakdown */}
        <div className="col-span-2">
          <h2 className="text-xs font-semibold text-text-2 uppercase tracking-wider mb-3">Threat types</h2>
          <div className="card p-4 space-y-2.5">
            {Object.entries(stats.threat_breakdown)
              .sort((a, b) => b[1] - a[1])
              .map(([threat, count]) => {
                const pct = stats.total_mistakes > 0
                  ? Math.round((count / stats.total_mistakes) * 100)
                  : 0
                return (
                  <div key={threat}>
                    <div className="flex justify-between mb-1">
                      <span className="text-xs text-text-2 capitalize">{threat.replace(/_/g, ' ')}</span>
                      <span className="text-xs text-text-1">{count}</span>
                    </div>
                    <div className="h-1 bg-bg-3 rounded-full overflow-hidden">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${pct}%` }}
                        transition={{ duration: 0.6, ease: 'easeOut' }}
                        className="h-full bg-accent/50 rounded-full"
                      />
                    </div>
                  </div>
                )
              })}
          </div>

          {/* Quick links */}
          <div className="mt-4 card p-4 space-y-2">
            <h3 className="text-xs font-semibold text-text-2 uppercase tracking-wider mb-2">Quick links</h3>
            {[
              { label: 'Drill Session', path: '/session' },
              { label: 'Game History', path: '/history' },
              { label: 'Settings', path: '/settings' },
            ].map(({ label, path }) => (
              <button
                key={path}
                onClick={() => navigate(path)}
                className="flex items-center justify-between w-full text-sm text-text-1 hover:text-text-0 transition-colors group"
              >
                {label}
                <ChevronRight size={13} className="text-bg-3 group-hover:text-text-2 transition-colors" />
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Analytics charts */}
      {analytics && <AnalyticsSection data={analytics} />}
    </div>
  )
}
