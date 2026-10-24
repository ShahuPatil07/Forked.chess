import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Chessboard } from 'react-chessboard'
import { BarChart3, Bot, ExternalLink, Microscope, Sparkles } from 'lucide-react'
import { openingsApi, type OpeningMove, type OpeningPool } from '../../api/openings'
import { ideasForPath } from '../../data/openingIdeas'
import { BOARD_DARK, BOARD_LIGHT } from '../../theme'

const DETAIL_BOARD_PX = 260

interface OpeningDetailProps {
  selected:   { move: OpeningMove; path: string; depth: number } | null
  pool:       OpeningPool
  parentName: string | null
}

export function OpeningDetail({ selected, pool, parentName }: OpeningDetailProps) {
  if (!selected) {
    return (
      <div className="card p-5 flex flex-col items-center justify-center text-center h-full min-h-[360px]">
        <Sparkles size={20} className="text-text-2 mb-3" />
        <p className="text-sm text-text-1 font-medium mb-1">Select a move</p>
        <p className="text-xs text-text-2 leading-relaxed">
          Click any move in the tree to see the position, the engine's evaluation,
          how it scores in your games pool, and the plans behind the opening.
        </p>
      </div>
    )
  }
  return <DetailContent selected={selected} pool={pool} parentName={parentName} />
}

function DetailContent({ selected, pool, parentName }: { selected: NonNullable<OpeningDetailProps['selected']>; pool: OpeningPool; parentName: string | null }) {
  const { move, path } = selected
  const fen = move.fen_after
  const navigate = useNavigate()
  const displayName = move.name || parentName || 'Position'
  const curated = ideasForPath(path)
  const moves = path.split(' ').filter(Boolean)

  const evalQuery = useQuery({
    queryKey: ['opening-eval', fen],
    queryFn: () => openingsApi.getEval(fen),
    staleTime: Infinity, retry: false,
  })
  const evalDisplay = evalQuery.data?.eval

  function analyse() {
    navigate('/analysis', { state: { moves, title: displayName } })
  }
  function playMaia() {
    navigate('/bot-game', { state: { startingMoves: moves, context: { kind: 'opening', name: displayName } } })
  }

  return (
    <div className="card p-4 space-y-4">
      {/* Board — hover for actions (buttons below for touch) */}
      <div className="flex justify-center">
        <div className="relative group rounded-md">
          <Chessboard position={fen} boardWidth={DETAIL_BOARD_PX} arePiecesDraggable={false} boardOrientation="white"
            customDarkSquareStyle={{ backgroundColor: BOARD_DARK }} customLightSquareStyle={{ backgroundColor: BOARD_LIGHT }}
            customBoardStyle={{ borderRadius: '6px', boxShadow: '0 0 0 1px rgba(200,255,42,0.18)' }} />
          <div className="absolute inset-0 rounded-md opacity-0 group-hover:opacity-100 focus-within:opacity-100 flex flex-col items-center justify-center gap-2 bg-black/55 backdrop-blur-[1px] transition-opacity">
            <button onClick={analyse} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-accent text-accent-ink text-xs font-semibold shadow-lg">
              <Microscope size={13} />Open in Analysis
            </button>
            <button onClick={playMaia} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-bg-1 border border-accent/50 text-accent text-xs font-semibold shadow-lg">
              <Bot size={13} />Play it vs Maia
            </button>
          </div>
        </div>
      </div>

      <div>
        <span className="font-mono text-lg font-bold text-text-0">{move.san}</span>
        <p className="text-xs text-text-2 mt-0.5 leading-snug">{displayName}</p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-bg-2 px-2.5 py-1.5">
          <p className="text-[10px] text-text-2 uppercase tracking-wider">Played</p>
          <p className="text-sm font-bold text-text-0 tabular-nums mt-0.5">{move.popularity.toFixed(1)}%</p>
        </div>
        <div className="rounded-lg bg-bg-2 px-2.5 py-1.5" title="Stockfish, depth 16 — White's point of view, in points">
          <p className="text-[10px] text-text-2 uppercase tracking-wider">Engine</p>
          {evalQuery.isLoading ? (
            <div className="h-5 mt-0.5 flex items-center"><div className="w-3 h-3 border border-accent border-t-transparent rounded-full animate-spin" /></div>
          ) : evalDisplay ? (
            <p className={`text-sm font-bold mt-0.5 tabular-nums font-mono ${evalDisplay.includes('M') ? 'text-accent' : 'text-text-0'}`}>{evalDisplay.replace('-', '−')}</p>
          ) : <p className="text-sm text-text-2 mt-0.5">—</p>}
        </div>
      </div>

      <div>
        <div className="flex items-center gap-1.5 text-[10px] text-text-2 mb-1.5">
          <BarChart3 size={10} />
          <span>{pool.db === 'masters' ? 'Masters games (OTB, FIDE 2200+)' : `Lichess games in your pool`}</span>
          <span className="ml-auto tabular-nums">{move.games.toLocaleString()} games</span>
        </div>
        <div className="flex h-2 rounded overflow-hidden gap-[2px] bg-bg-0">
          <div className="bg-[#F0F0F0]" style={{ width: `${move.w}%` }} title={`White wins ${move.w.toFixed(1)}%`} />
          <div className="bg-[#6B6B6B]" style={{ width: `${move.d}%` }} title={`Draws ${move.d.toFixed(1)}%`} />
          <div className="bg-[#2E2E2E]" style={{ width: `${move.l}%` }} title={`Black wins ${move.l.toFixed(1)}%`} />
        </div>
        <div className="flex justify-between text-[10px] mt-1 tabular-nums">
          <span className="text-text-0">White {move.w.toFixed(1)}%</span>
          <span className="text-text-2">Draw {move.d.toFixed(1)}%</span>
          <span className="text-text-1">Black {move.l.toFixed(1)}%</span>
        </div>
      </div>

      <div>
        <p className="text-[10px] text-text-2 uppercase tracking-wider font-semibold mb-2 flex items-center gap-1.5">
          <Sparkles size={10} className="text-accent" />Typical ideas
          {curated && !curated.exact && <span className="normal-case tracking-normal font-normal">· {curated.idea.name}</span>}
        </p>
        {curated ? (
          <>
            <p className="text-xs text-text-1 leading-relaxed">{curated.idea.ideas}</p>
            <a href={curated.idea.source} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[10px] text-text-2 hover:text-accent mt-2">
              Source <ExternalLink size={9} />
            </a>
          </>
        ) : (
          <p className="text-xs text-text-2 leading-relaxed">No curated notes for this line yet — the main plans are written up for 53 major openings.</p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button onClick={analyse} className="btn-ghost border border-border text-xs inline-flex items-center justify-center gap-1.5"><Microscope size={13} />Analyse</button>
        <button onClick={playMaia} className="btn-primary text-xs inline-flex items-center justify-center gap-1.5"><Bot size={13} />Play vs Maia</button>
      </div>
    </div>
  )
}
