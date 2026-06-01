import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Chessboard } from 'react-chessboard'
import { ArrowLeft, Target, TrendingDown, Zap, ExternalLink, Film } from 'lucide-react'
import { useUserStore } from '../store/userStore'
import { api } from '../api'
import { SectionHeader } from '../components/layout/SectionHeader'
import type { RepresentativeEvent } from '../types'

function MiniBoard({ event, idx, onClick }: { event: RepresentativeEvent; idx: number; onClick: () => void }) {
  const squareStyles: Record<string, object> = {}
  if (event.move_played) {
    const from = event.move_played.slice(0, 2)
    const to   = event.move_played.slice(2, 4)
    squareStyles[from] = { backgroundColor: 'rgba(255,77,77,0.30)' }
    squareStyles[to]   = { backgroundColor: 'rgba(255,77,77,0.40)' }
  }
  if (event.best_move) {
    const bFrom = event.best_move.slice(0, 2)
    const bTo   = event.best_move.slice(2, 4)
    squareStyles[bFrom] = { backgroundColor: 'rgba(13,201,127,0.25)' }
    squareStyles[bTo]   = { backgroundColor: 'rgba(13,201,127,0.35)' }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: idx * 0.06 }}
      onClick={onClick}
      className="card p-3 space-y-2 cursor-pointer hover:border-accent/30 transition-colors group"
      title="Open in Analysis Board"
    >
      <div className="relative">
      <Chessboard
        position={event.fen}
        arePiecesDraggable={false}
        boardWidth={160}
        customSquareStyles={squareStyles}
        customDarkSquareStyle={{ backgroundColor: '#1A1D36' }}
        customLightSquareStyle={{ backgroundColor: '#343761' }}
        customBoardStyle={{ borderRadius: '4px', boxShadow: '0 0 0 1px rgba(123,97,255,0.12)' }}
      />
      <div className="absolute inset-0 flex items-center justify-center bg-bg-0/0 group-hover:bg-bg-0/40 transition-colors rounded">
        <ExternalLink size={16} className="text-accent opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
      </div>
      <div className="space-y-0.5 text-xs">
        <p className="text-text-2">
          Move {event.move_number} &middot;{' '}
          <span className="capitalize">{event.game_phase}</span>
        </p>
        <p className="text-danger">
          Played: <span className="font-mono">{event.move_played || '—'}</span>
        </p>
        <p className="text-success">
          Best: <span className="font-mono">{event.best_move || '—'}</span>
        </p>
        <p className="text-text-1">
          Drop: <span className="text-danger font-medium">-{event.eval_drop_cp}cp</span>
        </p>
      </div>
    </motion.div>
  )
}

export default function BlindspotDetail() {
  const { id } = useParams<{ id: string }>()
  const { username } = useUserStore()
  const navigate = useNavigate()

  const { data, isLoading } = useQuery({
    queryKey: ['cluster', username, id],
    queryFn: () => api.getCluster(username, id!),
    enabled: !!username && !!id,
  })

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <p className="text-sm text-text-2">Blindspot not found.</p>
        <button onClick={() => navigate('/dashboard')} className="btn-ghost text-sm">Back</button>
      </div>
    )
  }

  const masteryPct = Math.round((data.mastery ?? 0) * 100)
  const urgencyPct = Math.min(100, Math.round((data.score ?? 0) * 100))
  const events     = data.representative_events ?? []

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <button
        onClick={() => navigate('/dashboard')}
        className="flex items-center gap-1.5 text-sm text-text-2 hover:text-text-0 transition-colors mb-4"
      >
        <ArrowLeft size={14} /> Back to dashboard
      </button>

      <SectionHeader
        icon={Target}
        title={data.label}
        description={`Rank #${data.rank} blindspot · ${data.size} mistakes · ${(data.dominant_threat_type ?? '').replace(/_/g, ' ')} · ${(data.dominant_game_phase ?? '').replace(/_/g, ' ')}`}
        right={
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate(`/replay/${data.cluster_id}`)}
              className="btn-ghost flex items-center gap-2 text-sm"
            >
              <Film size={13} /> Replay mistakes
            </button>
            <button
              onClick={() => navigate('/session', { state: { clusterId: String(data.cluster_id) } })}
              className="btn-primary flex items-center gap-2 text-sm"
            >
              <Zap size={13} /> Drill this blindspot
            </button>
          </div>
        }
      />

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className="card p-4">
          <p className="text-xs text-text-2 flex items-center gap-1.5 mb-2">
            <TrendingDown size={11} /> Urgency score
          </p>
          <p className="text-2xl font-bold text-danger">{urgencyPct}</p>
          <div className="h-1.5 bg-bg-3 rounded-full mt-2 overflow-hidden">
            <div className="h-full bg-danger/70 rounded-full" style={{ width: `${urgencyPct}%` }} />
          </div>
        </div>
        <div className="card p-4">
          <p className="text-xs text-text-2 mb-2">Mastery</p>
          <p className="text-2xl font-bold text-accent">{masteryPct}%</p>
          <div className="h-1.5 bg-bg-3 rounded-full mt-2 overflow-hidden">
            <div className="h-full bg-accent rounded-full" style={{ width: `${masteryPct}%` }} />
          </div>
        </div>
        <div className="card p-4">
          <p className="text-xs text-text-2 mb-2">Occurrences</p>
          <p className="text-2xl font-bold text-text-0">{data.size}</p>
          <p className="text-xs text-text-2 mt-2">mistakes in cluster</p>
        </div>
      </div>

      {/* Representative positions */}
      {events.length > 0 && (
        <div>
          <h2 className="text-xs font-semibold text-text-2 uppercase tracking-wider mb-4">
            Representative positions
            <span className="text-text-2 font-normal ml-2 normal-case">
              Red = played &middot; Green = best move
            </span>
          </h2>
          <div className="grid grid-cols-5 gap-3">
            {events.slice(0, 5).map((evt, i) => (
              <MiniBoard
                key={i}
                event={evt}
                idx={i}
                onClick={() => navigate('/analysis', {
                  state: {
                    positions: events.slice(0, 5).map((e) => ({
                      fen: e.fen,
                      label: `Move ${e.move_number} · ${e.threat_type.replace(/_/g, ' ')} · -${e.eval_drop_cp}cp`,
                      best_move_uci: e.best_move,
                      mistake_uci: e.move_played,
                    })),
                    index: i,
                    title: `${data.label} · representative positions`,
                  },
                })}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
