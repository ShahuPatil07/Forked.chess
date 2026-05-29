import { useState, useEffect } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { Chessboard } from 'react-chessboard'
import { motion, AnimatePresence } from 'framer-motion'
import { Copy, Check, MessageSquare, BarChart3, Sparkles } from 'lucide-react'
import { openingsApi, type OpeningMove } from '../../api/openings'

const DETAIL_BOARD_PX = 220

interface OpeningDetailProps {
  selected:   { move: OpeningMove; path: string; depth: number } | null
  eloBucket:  string
  parentName: string | null
}

export function OpeningDetail({ selected, eloBucket, parentName }: OpeningDetailProps) {
  if (!selected) {
    return (
      <div className="card p-5 flex flex-col items-center justify-center text-center h-full min-h-[360px]">
        <Sparkles size={20} className="text-text-2 mb-3" />
        <p className="text-sm text-text-1 font-medium mb-1">Select a move</p>
        <p className="text-xs text-text-2 leading-relaxed">
          Click any move in the tree to see the position, engine eval,
          win-rate from real games, and typical strategic ideas.
        </p>
      </div>
    )
  }

  return <DetailContent selected={selected} eloBucket={eloBucket} parentName={parentName} />
}

function DetailContent({
  selected, eloBucket, parentName,
}: {
  selected:   { move: OpeningMove; path: string; depth: number }
  eloBucket:  string
  parentName: string | null
}) {
  const { move } = selected
  const fen      = move.fen_after
  const sideToMove = fen.split(' ')[1] === 'w' ? 'white' : 'black'

  const displayName = move.name || parentName || 'Position'

  // Engine eval — cached forever
  const evalQuery = useQuery({
    queryKey:  ['opening-eval', fen],
    queryFn:   () => openingsApi.getEval(fen),
    staleTime: Infinity,
    retry:     false,
  })

  // Ideas — fire mutation on selection if not pre-cached in tree response
  const [ideasText,    setIdeasText]    = useState<string | null>(move.ideas)
  const [ideasFailed,  setIdeasFailed]  = useState(false)

  const ideasMutation = useMutation({
    mutationFn: () => openingsApi.getIdeas({
      fen,
      move:          move.san,
      opening_name:  displayName,
      side_to_move:  sideToMove,
    }),
    onSuccess: (r) => setIdeasText(r.ideas),
    onError:   ()  => setIdeasFailed(true),
  })

  useEffect(() => {
    setIdeasText(move.ideas)
    setIdeasFailed(false)
    if (move.ideas === null && !ideasMutation.isPending) {
      ideasMutation.mutate()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fen])

  // Copy prompt
  const [copied, setCopied] = useState(false)
  function copyPrompt() {
    const prompt = `Tell me more about ${displayName} — key plans, traps and model games`
    navigator.clipboard.writeText(prompt).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const evalDisplay = evalQuery.data?.eval

  return (
    <div className="card p-4 space-y-4 sticky top-4">
      {/* Board */}
      <div className="flex justify-center">
        <Chessboard
          position={fen}
          boardWidth={DETAIL_BOARD_PX}
          arePiecesDraggable={false}
          boardOrientation="white"
          customDarkSquareStyle={{ backgroundColor: '#1A1D36' }}
          customLightSquareStyle={{ backgroundColor: '#343761' }}
          customBoardStyle={{ borderRadius: '6px', boxShadow: '0 0 0 1px rgba(123,97,255,0.18)' }}
        />
      </div>

      {/* Move + name */}
      <div>
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-lg font-bold text-text-0">{move.san}</span>
          {move.eco && (
            <span className="text-[10px] font-semibold text-text-2 px-1.5 py-0.5 rounded
                             bg-bg-2 border border-border">
              {move.eco}
            </span>
          )}
        </div>
        <p className="text-xs text-text-2 mt-0.5 leading-snug">{displayName}</p>
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-2">
        <div className="flex-1 card bg-bg-2 border-0 px-2.5 py-1.5">
          <p className="text-[10px] text-text-2 uppercase tracking-wider">Popularity</p>
          <p className="text-sm font-bold text-text-0 tabular-nums mt-0.5">
            {move.popularity.toFixed(1)}%
          </p>
        </div>
        <div className="flex-1 card bg-bg-2 border-0 px-2.5 py-1.5">
          <p className="text-[10px] text-text-2 uppercase tracking-wider">Eval</p>
          {evalQuery.isLoading ? (
            <div className="h-4 mt-0.5 flex items-center">
              <div className="w-3 h-3 border border-accent border-t-transparent rounded-full animate-spin" />
            </div>
          ) : evalDisplay ? (
            <p className={`text-sm font-bold mt-0.5 tabular-nums font-mono
              ${evalDisplay.includes('M')
                ? 'text-accent'
                : evalDisplay.startsWith('+')
                  ? 'text-success'
                  : 'text-danger'}`}>
              {evalDisplay}
            </p>
          ) : (
            <p className="text-sm text-text-2 mt-0.5">—</p>
          )}
        </div>
      </div>

      {/* ELO bucket chip */}
      <div className="flex items-center gap-1.5 text-[10px]">
        <BarChart3 size={10} className="text-text-2" />
        <span className="text-text-2">
          Stats {eloBucket === 'all' ? '— all levels' : `at your level (${eloBucket})`}
        </span>
        <span className="text-text-2 ml-auto tabular-nums">{move.games.toLocaleString()} games</span>
      </div>

      {/* WDL bar */}
      <div>
        <div className="flex h-2 rounded overflow-hidden">
          <div className="bg-accent transition-all"
               style={{ width: `${move.w}%` }}
               title={`White wins ${move.w.toFixed(1)}%`} />
          <div className="bg-bg-3 transition-all"
               style={{ width: `${move.d}%` }}
               title={`Draws ${move.d.toFixed(1)}%`} />
          <div className="bg-[#111118] transition-all"
               style={{ width: `${move.l}%` }}
               title={`Black wins ${move.l.toFixed(1)}%`} />
        </div>
        <div className="flex justify-between text-[10px] mt-1 tabular-nums">
          <span className="text-accent font-medium">{move.w.toFixed(1)}% W</span>
          <span className="text-text-2">{move.d.toFixed(1)}% D</span>
          <span className="text-text-1 font-medium">{move.l.toFixed(1)}% L</span>
        </div>
      </div>

      {/* Typical ideas */}
      <div>
        <p className="text-[10px] text-text-2 uppercase tracking-wider font-semibold mb-2 flex items-center gap-1.5">
          <Sparkles size={10} className="text-accent" />
          Typical ideas
        </p>
        <AnimatePresence mode="wait">
          {ideasText ? (
            <motion.p
              key="ideas-text"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="text-xs text-text-1 leading-relaxed"
            >
              {ideasText}
            </motion.p>
          ) : ideasFailed ? (
            <motion.div key="ideas-error"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              className="text-xs text-text-2 italic">
              AI description unavailable right now —{' '}
              <button onClick={() => { setIdeasFailed(false); ideasMutation.mutate() }}
                className="text-accent underline hover:no-underline">retry</button>
            </motion.div>
          ) : (
            <motion.div key="ideas-loading"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="space-y-1.5">
              {[100, 92, 78].map((w, i) => (
                <div key={i} className="h-2.5 bg-bg-3 rounded animate-pulse"
                     style={{ width: `${w}%` }} />
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Copy prompt */}
      <button onClick={copyPrompt}
        className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-md
                   border border-border text-xs text-text-1 hover:bg-bg-2 hover:text-text-0 transition-colors">
        {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
        {copied ? 'Copied prompt' : 'Copy "ask coach" prompt'}
        <MessageSquare size={10} className="text-text-2 ml-1" />
      </button>
    </div>
  )
}
