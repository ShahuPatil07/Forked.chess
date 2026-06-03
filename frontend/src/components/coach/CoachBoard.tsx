import { useMemo, useRef, useState } from 'react'
import { Chessboard } from 'react-chessboard'
import { Chess, type Square } from 'chess.js'
import type { Arrow } from 'react-chessboard/dist/chessboard/types'
import { Lightbulb, Check, X, RotateCcw } from 'lucide-react'

const DARK = '#1A1D36'
const LIGHT = '#343761'
const GREEN = '#0DC97F'
const RED = '#FF4D4D'

interface CoachBoardProps {
  fen: string
  mode: 'puzzle' | 'view'
  /** Full Lichess solution line in UCI (incl. the setup move at index 0). */
  fullLineUci?: string[]
  /** Single fallback solution move if full line is absent. */
  solutionUci?: string
  orientation?: 'white' | 'black'
  /** view mode: highlight a played (red) and best (green) move. */
  playedUci?: string
  bestUci?: string
  size?: number
  onSolved?: () => void
}

function arrow(uci: string, color: string): Arrow | null {
  if (!uci || uci.length < 4) return null
  return [uci.slice(0, 2) as Square, uci.slice(2, 4) as Square, color]
}

export function CoachBoard({
  fen, mode, fullLineUci, solutionUci, orientation,
  playedUci, bestUci, size = 320, onSolved,
}: CoachBoardProps) {
  const chessRef = useRef(new Chess(fen))
  const [position, setPosition] = useState(fen)
  const [idx, setIdx] = useState(1)               // next expected USER move in fullLine
  const [status, setStatus] = useState<'solving' | 'wrong' | 'solved'>('solving')
  const [showHint, setShowHint] = useState(false)

  const orient: 'white' | 'black' = orientation
    ?? (new Chess(fen).turn() === 'w' ? 'white' : 'black')

  // The move the user must find right now.
  const expected: string | undefined = useMemo(() => {
    if (fullLineUci && fullLineUci.length > idx) return fullLineUci[idx]
    if (idx === 1) return solutionUci
    return undefined
  }, [fullLineUci, solutionUci, idx])

  const arrows: Arrow[] = useMemo(() => {
    if (mode === 'view') {
      return [arrow(bestUci ?? '', GREEN), arrow(playedUci ?? '', RED)].filter(Boolean) as Arrow[]
    }
    if (showHint && expected) {
      // Hint shows only the origin square direction, not the full move.
      return [arrow(expected.slice(0, 2) + expected.slice(0, 2), '#7B61FF')].filter(Boolean) as Arrow[]
    }
    return []
  }, [mode, bestUci, playedUci, showHint, expected])

  function applyUci(uci: string) {
    chessRef.current.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: (uci[4] as any) || 'q' })
    setPosition(chessRef.current.fen())
  }

  function handleDrop(from: string, to: string): boolean {
    if (mode !== 'puzzle' || status === 'solved') return false
    const exp = expected
    if (!exp) return false
    if (exp.slice(0, 4) !== from + to) {
      setStatus('wrong')
      setTimeout(() => setStatus('solving'), 700)
      return false   // snap back
    }
    // Correct — play the user move (use expected to get promotion right).
    applyUci(exp)
    let next = idx + 1
    // Auto-play the opponent's reply if the line continues.
    if (fullLineUci && fullLineUci.length > next) {
      const reply = fullLineUci[next]
      next += 1
      setTimeout(() => applyUci(reply), 250)
    }
    setShowHint(false)
    if (!fullLineUci || next >= fullLineUci.length) {
      setStatus('solved')
      onSolved?.()
    } else {
      setIdx(next)
    }
    return true
  }

  function reset() {
    chessRef.current = new Chess(fen)
    setPosition(fen); setIdx(1); setStatus('solving'); setShowHint(false)
  }

  const ringColor = status === 'solved' ? GREEN : status === 'wrong' ? RED : 'rgba(123,97,255,0.18)'

  return (
    <div className="inline-block">
      <Chessboard
        position={position}
        onPieceDrop={(s, t) => handleDrop(s, t)}
        boardOrientation={orient}
        arePiecesDraggable={mode === 'puzzle' && status !== 'solved'}
        customArrows={arrows}
        boardWidth={size}
        customDarkSquareStyle={{ backgroundColor: DARK }}
        customLightSquareStyle={{ backgroundColor: LIGHT }}
        customBoardStyle={{ borderRadius: '6px', boxShadow: `0 0 0 2px ${ringColor}`, transition: 'box-shadow .2s' }}
      />
      {mode === 'puzzle' && (
        <div className="flex items-center gap-2 mt-2">
          {status === 'solved' ? (
            <span className="flex items-center gap-1 text-[11px] font-semibold text-success">
              <Check size={12} /> Solved
            </span>
          ) : status === 'wrong' ? (
            <span className="flex items-center gap-1 text-[11px] font-semibold text-danger">
              <X size={12} /> Not quite — try again
            </span>
          ) : (
            <span className="text-[11px] text-text-2">
              {orient === 'white' ? 'White' : 'Black'} to move — find the best move
            </span>
          )}
          <div className="flex-1" />
          {status !== 'solved' && (
            <button onClick={() => setShowHint(true)}
              className="flex items-center gap-1 text-[11px] text-text-2 hover:text-accent transition-colors"
              title="Show a hint (which piece to move)">
              <Lightbulb size={12} /> Hint
            </button>
          )}
          <button onClick={reset}
            className="flex items-center gap-1 text-[11px] text-text-2 hover:text-text-0 transition-colors"
            title="Reset position">
            <RotateCcw size={12} /> Reset
          </button>
        </div>
      )}
    </div>
  )
}
