import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Chess } from 'chess.js'
import { motion } from 'framer-motion'
import { ExternalLink, AlertCircle, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react'
import { useUserStore } from '../store/userStore'
import { api } from '../api'
import type { GameSummary, GameMistake } from '../types'

function formatDate(unix: number | null): string {
  if (!unix) return '—'
  return new Date(unix * 1000).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  })
}

function PhaseBar({ breakdown }: { breakdown: Record<string, number> }) {
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0)
  if (total === 0) return <span className="text-xs text-text-2">—</span>
  const phases = [
    { key: 'opening',     color: 'bg-accent/50' },
    { key: 'middlegame',  color: 'bg-accent' },
    { key: 'endgame',     color: 'bg-purple-400' },
  ]
  return (
    <div className="flex h-1.5 w-20 rounded-full overflow-hidden gap-0.5">
      {phases.map(({ key, color }) => {
        const pct = breakdown[key] ? (breakdown[key] / total) * 100 : 0
        return pct > 0 ? (
          <div key={key} className={`h-full ${color}`} style={{ width: `${pct}%` }} />
        ) : null
      })}
    </div>
  )
}

function MistakeRow({ mistake, idx, onClick }: { mistake: GameMistake; idx: number; onClick: () => void }) {
  return (
    <tr
      className={`${idx % 2 === 0 ? 'bg-bg-0' : 'bg-bg-1'} hover:bg-bg-2 cursor-pointer transition-colors`}
      onClick={onClick}
      title="Open in Analysis Board"
    >
      <td className="px-4 py-2 text-xs text-text-2 w-12">{mistake.move_number}</td>
      <td className="px-4 py-2">
        <span className="font-mono text-xs text-danger">{mistake.move_played_san || '—'}</span>
      </td>
      <td className="px-4 py-2 text-xs text-text-2 capitalize">
        {(mistake.threat_type ?? '').replace(/_/g, ' ')}
      </td>
      <td className="px-4 py-2 text-xs text-text-2 capitalize">{mistake.game_phase}</td>
      <td className="px-4 py-2 text-xs text-danger font-medium">-{mistake.eval_drop_cp}cp</td>
    </tr>
  )
}

function sanToUci(fen: string, san: string): string | undefined {
  try {
    const chess = new Chess(fen)
    const move = chess.move(san)
    return move ? `${move.from}${move.to}${move.promotion ?? ''}` : undefined
  } catch {
    return undefined
  }
}

function GameRow({ game, idx }: { game: GameSummary; idx: number }) {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()

  const displayTitle = game.white_username && game.black_username
    ? `${game.white_username} vs ${game.black_username}`
    : game.game_id.slice(-8)

  function openAnalysis(clickedIdx: number) {
    const positions = (game.mistakes ?? []).map((m) => ({
      fen: m.fen,
      label: `Move ${m.move_number} · ${(m.threat_type ?? '').replace(/_/g, ' ')} · -${m.eval_drop_cp}cp`,
      best_move_uci: m.best_move_uci,
      mistake_uci: sanToUci(m.fen, m.move_played_san),
    }))
    navigate('/analysis', {
      state: {
        positions,
        index: clickedIdx,
        title: `${displayTitle} · ${game.mistake_count} mistakes`,
      },
    })
  }

  const gameLink = game.game_url || game.lichess_url

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: idx * 0.03 }}
      className="border border-border rounded-lg overflow-hidden"
    >
      <div
        className="flex items-center gap-4 px-4 py-3 bg-bg-1 hover:bg-bg-2 cursor-pointer transition-colors"
        onClick={() => setOpen(!open)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm text-text-0 truncate max-w-[260px]">
              {displayTitle}
            </span>
            {gameLink && (
              <a
                href={gameLink}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-accent hover:text-accent/70 transition-colors flex-shrink-0"
              >
                <ExternalLink size={11} />
              </a>
            )}
          </div>
          <p className="text-xs text-text-2 mt-0.5">{formatDate(game.played_at_unix)}</p>
        </div>

        <div className="flex items-center gap-6 flex-shrink-0">
          <div className="text-right">
            <p className="text-sm font-bold text-danger">{game.mistake_count}</p>
            <p className="text-xs text-text-2">mistakes</p>
          </div>
          <div>
            <p className="text-xs text-text-2 mb-1 capitalize">
              {(game.top_threat ?? '').replace(/_/g, ' ')}
            </p>
            <PhaseBar breakdown={game.phase_breakdown} />
          </div>
          {open
            ? <ChevronUp size={14} className="text-text-2" />
            : <ChevronDown size={14} className="text-text-2" />
          }
        </div>
      </div>

      {open && game.mistakes && game.mistakes.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-t border-border bg-bg-0">
                {['#', 'Move', 'Threat', 'Phase', 'Drop'].map(h => (
                  <th key={h} className="px-4 py-2 text-left text-xs text-text-2 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {game.mistakes.map((m, i) => (
                <MistakeRow key={i} mistake={m} idx={i} onClick={() => openAnalysis(i)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </motion.div>
  )
}

export default function GameHistory() {
  const { username, platform } = useUserStore()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [backfilling, setBackfilling] = useState(false)

  const { data, isLoading, error } = useQuery({
    queryKey: ['games', username],
    queryFn: () => api.getGames(username),
    enabled: !!username,
  })

  async function handleBackfill() {
    setBackfilling(true)
    try {
      await fetch(`/api/backfill_meta/${username}?platform=${platform ?? 'lichess'}`, { method: 'POST' })
      await queryClient.invalidateQueries({ queryKey: ['games', username] })
    } finally {
      setBackfilling(false)
    }
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
        <p className="text-sm text-text-2">Failed to load game history.</p>
      </div>
    )
  }

  const games = data.games ?? []
  const needsBackfill = games.some(g => !g.white_username && !g.black_username)
  const filtered = search
    ? games.filter(g => {
        const q = search.toLowerCase()
        return g.game_id.toLowerCase().includes(q)
          || (g.white_username ?? '').toLowerCase().includes(q)
          || (g.black_username ?? '').toLowerCase().includes(q)
          || (g.opponent ?? '').toLowerCase().includes(q)
      })
    : games

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-text-0">Game History</h1>
          <p className="text-text-2 text-sm mt-1">{games.length} analysed games</p>
        </div>
        <div className="flex items-center gap-2">
          {needsBackfill && (
            <button
              onClick={handleBackfill}
              disabled={backfilling}
              className="btn-ghost flex items-center gap-1.5 text-xs"
              title="Fetch opponent names from Lichess"
            >
              <RefreshCw size={12} className={backfilling ? 'animate-spin' : ''} />
              {backfilling ? 'Fetching…' : 'Load opponent names'}
            </button>
          )}
          <input
            className="input w-52 text-sm"
            placeholder="Search opponent or game ID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-16 text-text-2 text-sm">
          {search ? 'No games match your search.' : 'No games analysed yet.'}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((game, i) => (
            <GameRow key={game.game_id} game={game} idx={i} />
          ))}
        </div>
      )}
    </div>
  )
}
