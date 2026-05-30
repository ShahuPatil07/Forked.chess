import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Chessboard } from 'react-chessboard'
import { motion } from 'framer-motion'
import { Sparkles, Sword, MessageSquare, ShieldCheck, Loader2, Microscope } from 'lucide-react'
import {
  ENDGAME_CATEGORY_LABELS,
  ENDGAME_DIFFICULTY_LABELS,
  ENDGAME_RESULT_LABELS,
  type EndgameLeaf,
  type EndgameResult,
} from '../../data/endgameTree'
import { endgamesApi } from '../../api/endgames'

const DETAIL_BOARD_PX = 240

interface Props {
  leaf:                EndgameLeaf | null
  onPracticeRequest:   (leaf: EndgameLeaf) => void
  onAskCoach:          (leaf: EndgameLeaf) => void
}

const RESULT_COLOR: Record<EndgameResult, string> = {
  white_wins: 'text-success',
  black_wins: 'text-text-0',
  draw:       'text-text-1',
  depends:    'text-accent',
}

const DIFFICULTY_BAR: Record<string, string> = {
  beginner:     'bg-success',
  intermediate: 'bg-accent',
  advanced:     'bg-danger',
}

export function EndgameDetail({ leaf, onPracticeRequest, onAskCoach }: Props) {
  if (!leaf) {
    return (
      <div className="card p-5 flex flex-col items-center justify-center text-center h-full min-h-[360px]">
        <Sparkles size={20} className="text-text-2 mb-3" />
        <p className="text-sm text-text-1 font-medium mb-1">Pick a position</p>
        <p className="text-xs text-text-2 leading-relaxed">
          Each leaf in the tree is a canonical theoretical position with a
          known result. Click any to see the position, Syzygy verification,
          and instructive ideas.
        </p>
      </div>
    )
  }
  return <DetailContent key={leaf.id} leaf={leaf}
                        onPracticeRequest={onPracticeRequest}
                        onAskCoach={onAskCoach} />
}

function DetailContent({ leaf, onPracticeRequest, onAskCoach }: Props & { leaf: EndgameLeaf }) {
  const navigate = useNavigate()
  // Syzygy verification — cached forever
  const syzygy = useQuery({
    queryKey:  ['endgame-syzygy', leaf.fen],
    queryFn:   () => endgamesApi.syzygy(leaf.fen),
    staleTime: Infinity,
    retry:     false,
  })

  const sideToMove = leaf.fen.split(' ')[1] === 'w' ? 'White' : 'Black'

  return (
    <div className="card p-4 space-y-4">
      {/* Board */}
      <div className="flex justify-center">
        <Chessboard
          position={leaf.fen}
          boardWidth={DETAIL_BOARD_PX}
          arePiecesDraggable={false}
          boardOrientation={sideToMove === 'White' ? 'white' : 'black'}
          customDarkSquareStyle={{ backgroundColor: '#1A1D36' }}
          customLightSquareStyle={{ backgroundColor: '#343761' }}
          customBoardStyle={{ borderRadius: '6px', boxShadow: '0 0 0 1px rgba(123,97,255,0.18)' }}
        />
      </div>

      {/* Title + difficulty */}
      <div>
        <p className="text-base font-bold text-text-0 leading-tight">{leaf.title}</p>
        <div className="flex items-center gap-2 mt-1 text-[10px] text-text-2">
          <span className={`w-1.5 h-1.5 rounded-full ${DIFFICULTY_BAR[leaf.difficulty]}`} />
          {ENDGAME_DIFFICULTY_LABELS[leaf.difficulty]}
          <span className="text-bg-3">·</span>
          {ENDGAME_CATEGORY_LABELS[leaf.category]}
          <span className="text-bg-3">·</span>
          {sideToMove} to move
        </div>
      </div>

      {/* Result + Syzygy verification */}
      <div className="card bg-bg-2 border-0 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-text-2 uppercase tracking-wider">Theoretical result</span>
          <span className={`text-sm font-bold ${RESULT_COLOR[leaf.result]}`}>
            {ENDGAME_RESULT_LABELS[leaf.result]}
          </span>
        </div>

        {/* Syzygy badge */}
        <div className="flex items-center gap-2 pt-1">
          {syzygy.isLoading ? (
            <span className="text-[10px] text-text-2 inline-flex items-center gap-1.5">
              <Loader2 size={10} className="animate-spin text-accent" />
              Querying tablebase…
            </span>
          ) : syzygy.data && syzygy.data.available && syzygy.data.category ? (
            <>
              <ShieldCheck size={11} className="text-success flex-shrink-0" />
              <span className="text-[10px] text-success font-medium">Syzygy verified</span>
              <span className="text-[10px] text-text-2">
                {syzygy.data.category}
                {syzygy.data.dtm !== null && `, DTM ${syzygy.data.dtm}`}
                {syzygy.data.best_move && (
                  <>  · best: <span className="font-mono text-text-1">{syzygy.data.best_move}</span></>
                )}
              </span>
            </>
          ) : (
            <span className="text-[10px] text-text-2 italic">
              {syzygy.data && !syzygy.data.available
                ? '>7 pieces — outside tablebase range'
                : 'Tablebase unavailable'}
            </span>
          )}
        </div>
      </div>

      {/* Summary */}
      {leaf.summary && (
        <div>
          <p className="text-[10px] text-text-2 uppercase tracking-wider font-semibold mb-2 flex items-center gap-1.5">
            <Sparkles size={10} className="text-accent" />
            Key idea
          </p>
          <p className="text-xs text-text-1 leading-relaxed">{leaf.summary}</p>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-col gap-2 pt-1">
        <motion.button
          whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.99 }}
          onClick={() => onPracticeRequest(leaf)}
          className="btn-primary w-full flex items-center justify-center gap-1.5 text-sm"
        >
          <Sword size={13} /> Practice this position
        </motion.button>
        <button
          onClick={() => onAskCoach(leaf)}
          className="btn-ghost w-full flex items-center justify-center gap-1.5 text-sm"
        >
          <MessageSquare size={13} /> Ask the coach
        </button>
        <button
          onClick={() => navigate(`/analysis?fen=${encodeURIComponent(leaf.fen)}`)}
          className="btn-ghost w-full flex items-center justify-center gap-1.5 text-sm"
        >
          <Microscope size={13} /> Open in Analysis Board →
        </button>
      </div>
    </div>
  )
}
