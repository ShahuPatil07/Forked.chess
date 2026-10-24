import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Chess } from 'chess.js'
import { Chessboard } from 'react-chessboard'
import { ArrowLeft, Target, Zap, ExternalLink, Film, Users, TrendingUp, Crosshair, Clock } from 'lucide-react'
import type { ReactNode } from 'react'
import { useUserStore } from '../store/userStore'
import { api } from '../api'
import { insightsApi } from '../api/insights'
import { SectionHeader } from '../components/layout/SectionHeader'
import { useElementWidth } from '../hooks/useElementWidth'
import { BOARD_DARK, BOARD_LIGHT, CHART } from '../theme'
import type { ClusterProfileV2, RepresentativeEvent } from '../types'
import { lossPts } from '../lib/format'

// Same wording as the dashboard cards: every status is relative to the
// rating-matched opponents in your own games (Stage-2 v2).
const STATUS: Record<string, { label: string; cls: string; text: string }> = {
  confirmed: { label: 'Confirmed blindspot', cls: 'text-danger bg-danger/10 border-danger/25',
    text: 'You make this mistake clearly more often than the players you face (≥90% sure).' },
  emerging: { label: 'Emerging', cls: 'text-warn bg-warn/10 border-warn/25',
    text: 'Probably more often than your peers, but not certain yet.' },
  typical: { label: 'Typical', cls: 'text-text-2 bg-bg-3/60 border-border',
    text: 'About as often as players at your rating: still worth points, but not a personal weakness.' },
  strength: { label: 'Strength', cls: 'text-success bg-success/10 border-success/25',
    text: 'Less often than players at your rating.' },
  insufficient_data: { label: 'Not enough data', cls: 'text-text-2 bg-bg-3/60 border-border',
    text: 'Too few incidents to judge yet.' },
}

const DIRECTION_LABEL: Record<string, { label: string; text: string }> = {
  allowed: { label: 'Walked into it', text: 'your move allowed the tactic' },
  missed: { label: 'Missed the shot', text: 'the tactic was there for you' },
  both: { label: 'Both', text: 'missed a shot and allowed one' },
  quiet: { label: 'Quiet slip', text: 'no clear tactic, the position just got worse' },
}

const BUCKET_LABEL: Record<string, string> = { ahead: 'when ahead', equal: 'in equal positions', behind: 'when behind' }

function san(fen: string, uci: string | null | undefined): string {
  if (!uci) return '—'
  try {
    const c = new Chess(fen)
    return c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san
  } catch {
    return uci
  }
}

const pct = (x: number | null | undefined) => (x == null ? '—' : `${Math.round(x * 100)}%`)

function Tile({ icon: Icon, label, children, sub }: { icon: typeof Target; label: string; children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="card p-4 min-w-0">
      <p className="text-xs text-text-2 flex items-center gap-1.5 mb-1.5"><Icon size={12} className="text-accent shrink-0" />{label}</p>
      <div className="font-display text-2xl font-semibold text-text-0 tabular-nums leading-tight">{children}</div>
      {sub && <p className="text-[11px] text-text-2 mt-1 leading-snug">{sub}</p>}
    </div>
  )
}

function ShareBar({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-text-1">{label}{hint && <span className="text-text-2"> · {hint}</span>}</span>
        <span className="text-text-0 tabular-nums">{pct(value)}</span>
      </div>
      <div className="h-1.5 bg-bg-3 rounded-full overflow-hidden mt-1">
        <div className="h-full rounded-full" style={{ width: `${Math.round(value * 100)}%`, background: CHART.you }} />
      </div>
    </div>
  )
}

function PeerCompare({ p }: { p: ClusterProfileV2 }) {
  const you = p.rate_per_100, peer = p.peer_rate_per_100 ?? 0
  const max = Math.max(you, peer, 0.01)
  const rows = [
    { name: 'You', v: you, color: CHART.you },
    { name: 'Rating-matched peers', v: peer, color: CHART.peer },
  ]
  return (
    <div className="space-y-2" role="img" aria-label={`You ${you.toFixed(2)} vs peers ${peer.toFixed(2)} incidents per 100 moves`}>
      {rows.map(r => (
        <div key={r.name}>
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-text-1">{r.name}</span>
            <span className="text-text-0 tabular-nums">{r.v.toFixed(2)} per 100 moves</span>
          </div>
          <div className="h-2 bg-bg-3 rounded-full overflow-hidden mt-1">
            <div className="h-full rounded-full" style={{ width: `${(r.v / max) * 100}%`, background: r.color }} />
          </div>
        </div>
      ))}
    </div>
  )
}

function MiniBoard({ event, idx, onClick }: { event: RepresentativeEvent & { es_loss?: number; direction?: string }; idx: number; onClick: () => void }) {
  const [ref, width] = useElementWidth<HTMLDivElement>(160)
  const squareStyles: Record<string, object> = {}
  if (event.move_played) {
    squareStyles[event.move_played.slice(0, 2)] = { backgroundColor: 'rgba(255,77,77,0.30)' }
    squareStyles[event.move_played.slice(2, 4)] = { backgroundColor: 'rgba(255,77,77,0.40)' }
  }
  if (event.best_move) {
    squareStyles[event.best_move.slice(0, 2)] = { backgroundColor: 'rgba(13,201,127,0.25)' }
    squareStyles[event.best_move.slice(2, 4)] = { backgroundColor: 'rgba(13,201,127,0.35)' }
  }
  const orient = event.fen.split(' ')[1] === 'b' ? 'black' : 'white'
  return (
    <motion.button
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: idx * 0.05 }}
      onClick={onClick}
      className="card p-2.5 space-y-2 text-left cursor-pointer hover:border-accent/30 transition-colors group min-w-0"
      title="Open in Analysis Board"
    >
      <div className="relative" ref={ref}>
        <Chessboard
          position={event.fen}
          arePiecesDraggable={false}
          boardWidth={Math.max(120, width)}
          boardOrientation={orient}
          customSquareStyles={squareStyles}
          customDarkSquareStyle={{ backgroundColor: BOARD_DARK }}
          customLightSquareStyle={{ backgroundColor: BOARD_LIGHT }}
          customBoardStyle={{ borderRadius: '4px', boxShadow: '0 0 0 1px rgba(200,255,42,0.12)' }}
        />
        <div className="absolute inset-0 flex items-center justify-center bg-bg-0/0 group-hover:bg-bg-0/40 transition-colors rounded">
          <ExternalLink size={16} className="text-accent opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
      </div>
      <div className="space-y-0.5 text-xs">
        <p className="text-text-2">Move {event.move_number} · <span className="capitalize">{event.game_phase}</span></p>
        <p className="text-danger">Played <span className="font-mono font-semibold">{san(event.fen, event.move_played)}</span></p>
        <p className="text-success">Best <span className="font-mono font-semibold">{san(event.fen, event.best_move)}</span></p>
        <p className="text-text-2">
          {event.es_loss != null ? `−${Math.round(event.es_loss * 100)}% win chance` : lossPts(event.eval_drop_cp)}
        </p>
      </div>
    </motion.button>
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
  const { data: cf } = useQuery({
    queryKey: ['counterfactual', username], queryFn: () => insightsApi.counterfactual(username), enabled: !!username, staleTime: 5 * 60_000,
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

  const p = data.profile
  const status = p ? STATUS[p.status] : undefined
  const gain = cf?.per_cluster.find(c => c.cluster_id === String(data.cluster_id))
  const events = (data.representative_events ?? []) as (RepresentativeEvent & { es_loss?: number; direction?: string })[]
  const dir = p?.direction ?? {}
  const buckets = p?.context?.eval_bucket ?? {}

  return (
    <div className="px-4 py-6 sm:p-8 max-w-5xl mx-auto">
      <button onClick={() => navigate('/dashboard')}
        className="flex items-center gap-1.5 text-sm text-text-2 hover:text-text-0 transition-colors mb-4">
        <ArrowLeft size={14} /> Back to dashboard
      </button>

      <SectionHeader
        icon={Target}
        title={data.label}
        description={`#${data.rank} of your skill families by cost · ${data.size} incidents in your analysed games`}
      />

      <div className="flex flex-wrap items-center gap-2 -mt-2 mb-6">
        {status && (
          <span className={`text-xs font-medium px-2 py-1 rounded-md border ${status.cls}`} title={status.text}>{status.label}</span>
        )}
        <div className="flex flex-wrap gap-2 ml-auto">
          <button onClick={() => navigate(`/replay/${data.cluster_id}`)} className="btn-ghost flex items-center gap-2 text-sm">
            <Film size={13} /> Replay mistakes
          </button>
          <button onClick={() => navigate('/session', { state: { clusterId: String(data.cluster_id) } })}
            className="btn-primary flex items-center gap-2 text-sm">
            <Zap size={13} /> Drill this blindspot
          </button>
        </div>
      </div>
      {status && <p className="text-sm text-text-1 -mt-3 mb-6 max-w-2xl">{status.text}</p>}

      {p && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
            <Tile icon={Users} label="vs your peers"
              sub={p.relative_rate != null ? `${p.relative_rate.toFixed(2)}× the rate of the players you face` : undefined}>
              {p.p_worse_than_peers != null ? `${Math.round(p.p_worse_than_peers * 100)}%` : '—'}
              <span className="text-xs text-text-2 font-sans font-normal"> likely worse</span>
            </Tile>
            <Tile icon={TrendingUp} label="Rating if fixed" sub={gain ? `${gain.games_recovered.toFixed(1)} games turned around` : 'turning-point estimate'}>
              {gain ? <span className="text-accent">+{Math.round(gain.gain)}</span> : '—'}
            </Tile>
            <Tile icon={Crosshair} label="Tactics found" sub={p.hit_rate?.peer != null ? `peers find ${pct(p.hit_rate.peer)}` : 'when one was available'}>
              {pct(p.hit_rate?.user)}
            </Tile>
            <Tile icon={Clock} label="Cost per 10 games" sub={`avg −${Math.round(p.severity_es * 100)}% win chance per incident`}>
              {p.impact_pts_per_10.toFixed(1)}<span className="text-xs text-text-2 font-sans font-normal"> game pts</span>
            </Tile>
          </div>

          <div className="grid lg:grid-cols-3 gap-3 mb-8">
            <div className="card p-4 space-y-3">
              <p className="text-xs font-semibold text-text-2 uppercase tracking-wider">How often</p>
              <PeerCompare p={p} />
              <p className="text-[11px] text-text-2">80% range for you: {p.rate_ci80[0].toFixed(2)}–{p.rate_ci80[1].toFixed(2)} per 100 moves. Peers are the opponents in the same games.</p>
            </div>
            <div className="card p-4 space-y-2.5">
              <p className="text-xs font-semibold text-text-2 uppercase tracking-wider">How it happens</p>
              {Object.entries(DIRECTION_LABEL).filter(([k]) => (dir[k] ?? 0) > 0)
                .sort((a, b) => (dir[b[0]] ?? 0) - (dir[a[0]] ?? 0))
                .map(([k, d]) => <ShareBar key={k} label={d.label} hint={d.text} value={dir[k] ?? 0} />)}
            </div>
            <div className="card p-4 space-y-2.5">
              <p className="text-xs font-semibold text-text-2 uppercase tracking-wider">When it happens</p>
              {(['equal', 'ahead', 'behind'] as const).filter(k => buckets[k] != null).map(k => (
                <ShareBar key={k} label={BUCKET_LABEL[k]} value={buckets[k] ?? 0} />
              ))}
              {p.context.time_trouble_share != null && <ShareBar label="in time trouble" value={p.context.time_trouble_share} />}
              {p.context.involves_king_share != null && <ShareBar label="involves your king" value={p.context.involves_king_share} />}
            </div>
          </div>
        </>
      )}

      {events.length > 0 && (
        <div>
          <h2 className="text-xs font-semibold text-text-2 uppercase tracking-wider mb-3">
            Representative positions
            <span className="text-text-2 font-normal ml-2 normal-case">red = played · green = best move</span>
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {events.slice(0, 5).map((evt, i) => (
              <MiniBoard
                key={i}
                event={evt}
                idx={i}
                onClick={() => navigate('/analysis', {
                  state: {
                    positions: events.slice(0, 5).map(e => ({
                      fen: e.fen,
                      label: `Move ${e.move_number} · ${e.threat_type.replace(/_/g, ' ')} · ${lossPts(e.eval_drop_cp)}`,
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
