import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Zap, Target, BookOpen, TrendingUp, ChevronRight, AlertCircle } from 'lucide-react'
import { useUserStore } from '../store/userStore'
import { api } from '../api'
import type { ClusterSummary } from '../types'

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

export default function Dashboard() {
  const { username, elo } = useUserStore()
  const navigate = useNavigate()
  const [showAll, setShowAll] = useState(false)

  const { data, isLoading, error } = useQuery({
    queryKey: ['profile', username],
    queryFn: () => api.getProfile(username),
    enabled: !!username,
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
    </div>
  )
}
