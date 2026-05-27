import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Chess } from 'chess.js'
import { Chessboard } from 'react-chessboard'
import { motion, AnimatePresence } from 'framer-motion'
import { Lightbulb, Check, X, ChevronRight, Zap, RotateCcw } from 'lucide-react'
import { useUserStore } from '../store/userStore'
import { api } from '../api'
import type { Square } from 'chess.js'
import type { SessionItem, SessionResponse } from '../types'

// ── Chess helpers ────────────────────────────────────────────────────────────

function applyUci(chess: Chess, uci: string): boolean {
  try {
    chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] ?? undefined })
    return true
  } catch {
    return false
  }
}

function getBoardOrientation(item: SessionItem): 'white' | 'black' {
  // Apply trigger move; the resulting turn is opponent's. User plays the opposite.
  const chess = new Chess(item.puzzle.fen)
  const triggerUci = item.puzzle.moves.split(' ')[0]
  applyUci(chess, triggerUci)
  return chess.turn() === 'w' ? 'black' : 'white'
}

// ── Types ────────────────────────────────────────────────────────────────────

type Phase = 'waiting' | 'correct_flash' | 'wrong_flash' | 'failed' | 'solved'

interface Attempt { cluster_id: string; correct: boolean; time_s: number }

// ── Custom board square styles for last move highlight ───────────────────────

function makeHighlight(uci: string) {
  if (!uci || uci.length < 4) return {}
  const from = uci.slice(0, 2)
  const to   = uci.slice(2, 4)
  return {
    [from]: { backgroundColor: 'rgba(123,97,255,0.25)' },
    [to]:   { backgroundColor: 'rgba(123,97,255,0.35)' },
  }
}

// ── Sub-components ───────────────────────────────────────────────────────────

function ContextPanel({ item, puzzleIdx, total }: { item: SessionItem; puzzleIdx: number; total: number }) {
  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className="badge bg-accent/15 text-accent border border-accent/20">#{item.blindspot_rank} Blindspot</span>
          <span className="text-xs text-text-2">{puzzleIdx + 1}/{total}</span>
        </div>
        <h2 className="text-base font-semibold text-text-0 leading-snug">{item.cluster_label}</h2>
        <p className="text-xs text-text-2 mt-1">
          Missed <span className="text-accent font-medium">{item.missed_count}</span> times
        </p>
      </div>

      {item.puzzle.threat && (
        <div className="bg-bg-2 rounded-md px-3 py-2">
          <p className="text-xs text-text-2 mb-0.5">Pattern</p>
          <p className="text-sm text-text-0 capitalize">{item.puzzle.threat.replace(/_/g, ' ')}</p>
        </div>
      )}

      {item.puzzle.game_url && (
        <div className="bg-bg-2 rounded-md px-3 py-2">
          <p className="text-xs text-text-2 mb-0.5">Source game</p>
          <a
            href={item.puzzle.game_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-accent hover:underline"
          >
            View on Lichess
          </a>
        </div>
      )}
    </div>
  )
}

function SessionComplete({ attempts, onRestart }: { attempts: Attempt[]; onRestart: () => void }) {
  const correct = attempts.filter(a => a.correct).length
  const pct = Math.round((correct / attempts.length) * 100)
  const navigate = useNavigate()
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6">
      <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="text-center">
        <div className="text-5xl mb-4">♞</div>
        <h2 className="text-2xl font-bold text-text-0">Session complete</h2>
        <p className="text-text-2 mt-2">{correct}/{attempts.length} correct · {pct}% accuracy</p>
      </motion.div>
      <div className="flex gap-3">
        <button onClick={onRestart} className="btn-ghost flex items-center gap-2">
          <RotateCcw size={14} /> Drill again
        </button>
        <button onClick={() => navigate('/dashboard')} className="btn-primary flex items-center gap-2">
          Dashboard <ChevronRight size={14} />
        </button>
      </div>
    </div>
  )
}

// ── Click-to-move helpers ─────────────────────────────────────────────────────

function getPuzzleMoveOptions(chess: Chess, square: Square): Record<string, object> {
  const moves = chess.moves({ square, verbose: true })
  const styles: Record<string, object> = {}
  moves.forEach((m) => {
    styles[m.to] = {
      background: chess.get(m.to)
        ? 'radial-gradient(circle, rgba(255,77,77,0.35) 85%, transparent 85%)'
        : 'radial-gradient(circle, rgba(123,97,255,0.30) 40%, transparent 40%)',
      borderRadius: '50%',
    }
  })
  styles[square] = { backgroundColor: 'rgba(123,97,255,0.22)' }
  return styles
}

// ── Puzzle board component ───────────────────────────────────────────────────

function PuzzleBoard({
  item,
  onResult,
}: {
  item: SessionItem
  onResult: (correct: boolean, hintUsed: boolean, time_s: number) => void
}) {
  const moves    = item.puzzle.moves.split(' ')
  const orient   = getBoardOrientation(item)

  const chessRef  = useRef(new Chess(item.puzzle.fen))
  const startTime = useRef(Date.now())

  const [fen,        setFen]        = useState(item.puzzle.fen)
  const [moveIdx,    setMoveIdx]    = useState(1)
  const [phase,      setPhase]      = useState<Phase>('waiting')
  const [wrongCount, setWrongCount] = useState(0)
  const [hintUsed,   setHintUsed]   = useState(false)
  const [highlight,  setHighlight]  = useState<Record<string, object>>({})

  // Click-to-move
  const [selectedSq, setSelectedSq] = useState<Square | null>(null)
  const [optionSqs,  setOptionSqs]  = useState<Record<string, object>>({})

  useEffect(() => {
    const chess = new Chess(item.puzzle.fen)
    chessRef.current = chess
    applyUci(chess, moves[0])
    setFen(chess.fen())
    setHighlight(makeHighlight(moves[0]))
    setMoveIdx(1)
    setPhase('waiting')
    setWrongCount(0)
    setHintUsed(false)
    setSelectedSq(null)
    setOptionSqs({})
    startTime.current = Date.now()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.puzzle.puzzle_id])

  const autoPlayOpponent = useCallback((nextIdx: number) => {
    if (nextIdx >= moves.length) return
    setTimeout(() => {
      const ok = applyUci(chessRef.current, moves[nextIdx])
      if (ok) {
        setFen(chessRef.current.fen())
        setHighlight(makeHighlight(moves[nextIdx]))
        setSelectedSq(null)
        setOptionSqs({})
        const afterIdx = nextIdx + 1
        if (afterIdx >= moves.length) {
          setPhase('solved')
          onResult(true, hintUsed, (Date.now() - startTime.current) / 1000)
        } else {
          setMoveIdx(afterIdx)
          setPhase('waiting')
        }
      }
    }, 480)
  }, [moves, hintUsed, onResult])

  function attemptMove(from: string, to: string, piece?: string): boolean {
    if (phase !== 'waiting') return false

    const expected = moves[moveIdx]
    const expFrom  = expected.slice(0, 2)
    const expTo    = expected.slice(2, 4)
    const expPromo = expected[4]
    const userPromo = piece?.toLowerCase().slice(-1)

    const isCorrect = from === expFrom && to === expTo && (!expPromo || userPromo === expPromo)

    setSelectedSq(null)
    setOptionSqs({})

    if (isCorrect) {
      applyUci(chessRef.current, expected)
      setFen(chessRef.current.fen())
      setHighlight(makeHighlight(expected))
      setPhase('correct_flash')

      const nextIdx = moveIdx + 1
      if (nextIdx >= moves.length) {
        setTimeout(() => {
          setPhase('solved')
          onResult(true, hintUsed, (Date.now() - startTime.current) / 1000)
        }, 300)
      } else {
        setTimeout(() => {
          setPhase('waiting')
          autoPlayOpponent(nextIdx)
        }, 300)
      }
      return true
    } else {
      const newWrong = wrongCount + 1
      setWrongCount(newWrong)
      setPhase('wrong_flash')
      setTimeout(() => {
        if (newWrong >= 2) {
          setPhase('failed')
          onResult(false, hintUsed, (Date.now() - startTime.current) / 1000)
        } else {
          setPhase('waiting')
        }
      }, 700)
      return false
    }
  }

  function handleDrop(from: string, to: string, piece: string): boolean {
    return attemptMove(from, to, piece)
  }

  function handleSquareClick(square: Square) {
    if (phase !== 'waiting') return

    // If a destination square is clicked after selection
    if (selectedSq && optionSqs[square] !== undefined) {
      attemptMove(selectedSq, square)
      return
    }

    const piece = chessRef.current.get(square)
    if (piece && piece.color === chessRef.current.turn()) {
      setSelectedSq(square)
      setOptionSqs(getPuzzleMoveOptions(chessRef.current, square))
    } else {
      setSelectedSq(null)
      setOptionSqs({})
    }
  }

  function showHint() {
    if (phase !== 'waiting' || moveIdx >= moves.length) return
    setHintUsed(true)
    const expected = moves[moveIdx]
    setHighlight({
      ...makeHighlight(expected),
      [expected.slice(0, 2)]: { backgroundColor: 'rgba(255,193,7,0.35)' },
    })
    setSelectedSq(null)
    setOptionSqs({})
  }

  function revealSolution() {
    setPhase('solved')
    setHighlight(makeHighlight(moves[moveIdx]))
  }

  const isDone = phase === 'solved' || phase === 'failed'
  const squareStyles = useMemo(() => ({ ...highlight, ...optionSqs }), [highlight, optionSqs])

  return (
    <div className="space-y-3">
      <AnimatePresence mode="wait">
        {phase === 'correct_flash' && (
          <motion.div key="correct"
            initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="flex items-center gap-2 text-success text-sm font-medium px-3 py-2 bg-success/10 rounded-md border border-success/20"
          >
            <Check size={14} /> Correct!
          </motion.div>
        )}
        {phase === 'wrong_flash' && (
          <motion.div key="wrong"
            initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="flex items-center gap-2 text-danger text-sm font-medium px-3 py-2 bg-danger/10 rounded-md border border-danger/20"
          >
            <X size={14} /> Not quite — {2 - wrongCount} attempt{wrongCount === 1 ? '' : 's'} left
          </motion.div>
        )}
        {phase === 'failed' && (
          <motion.div key="failed"
            initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
            className="flex items-center justify-between px-3 py-2 bg-danger/10 rounded-md border border-danger/20"
          >
            <span className="flex items-center gap-2 text-danger text-sm font-medium">
              <X size={14} /> Missed
            </span>
            <button onClick={revealSolution} className="text-xs text-text-2 hover:text-text-0 transition-colors">
              Show solution
            </button>
          </motion.div>
        )}
        {phase === 'solved' && (
          <motion.div key="solved"
            initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
            className="flex items-center gap-2 text-success text-sm font-medium px-3 py-2 bg-success/10 rounded-md border border-success/20"
          >
            <Check size={14} /> Solved!
          </motion.div>
        )}
      </AnimatePresence>

      <motion.div
        animate={phase === 'wrong_flash' ? { x: [0, -6, 6, -4, 4, 0] } : { x: 0 }}
        transition={{ duration: 0.35 }}
      >
        <Chessboard
          position={fen}
          onPieceDrop={handleDrop}
          onSquareClick={handleSquareClick}
          boardOrientation={orient}
          customSquareStyles={squareStyles}
          arePiecesDraggable={phase === 'waiting'}
          boardWidth={500}
          customDarkSquareStyle={{ backgroundColor: '#1A1D36' }}
          customLightSquareStyle={{ backgroundColor: '#343761' }}
          customBoardStyle={{
            borderRadius: '6px',
            boxShadow: '0 0 0 1px rgba(123,97,255,0.15)',
          }}
        />
      </motion.div>

      {!isDone && (
        <button
          onClick={showHint}
          disabled={hintUsed}
          className="flex items-center gap-1.5 text-xs text-text-2 hover:text-text-0 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Lightbulb size={12} />
          {hintUsed ? 'Hint used' : 'Show hint'}
        </button>
      )}
    </div>
  )
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function PuzzleSession() {
  const { username, elo } = useUserStore()
  const navigate = useNavigate()

  const [puzzleIdx, setPuzzleIdx]   = useState(0)
  const [attempts,  setAttempts]    = useState<Attempt[]>([])
  const [complete,  setComplete]    = useState(false)

  const { data, isLoading, error, refetch } = useQuery<SessionResponse>({
    queryKey: ['session', username, elo],
    queryFn:  () => api.getSession(username, elo || 1200, 12),
    enabled:  !!username,
    staleTime: 0,
  })

  function handleResult(correct: boolean, _hintUsed: boolean, time_s: number) {
    if (!data) return
    const item = data.items[puzzleIdx]
    const newAttempts = [...attempts, { cluster_id: String(item.cluster_id), correct, time_s }]
    setAttempts(newAttempts)

    setTimeout(() => {
      const next = puzzleIdx + 1
      if (next >= data.items.length) {
        // Submit results, then show complete screen
        api.completeSession(username, newAttempts).catch(() => {/* ignore */})
        setComplete(true)
      } else {
        setPuzzleIdx(next)
      }
    }, 1200)
  }

  function handleRestart() {
    setAttempts([])
    setPuzzleIdx(0)
    setComplete(false)
    refetch()
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (error || !data || data.items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <Zap size={20} className="text-text-2" />
        <p className="text-sm text-text-2">
          {error ? 'Failed to load session.' : 'No puzzles available yet.'}
        </p>
        <button onClick={() => navigate('/dashboard')} className="btn-ghost text-sm">Back</button>
      </div>
    )
  }

  if (complete) {
    return <SessionComplete attempts={attempts} onRestart={handleRestart} />
  }

  const item = data.items[puzzleIdx]
  const correct = attempts.filter(a => a.correct).length

  return (
    <div className="p-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-bold text-text-0">Drill Session</h1>
          <p className="text-xs text-text-2 mt-0.5">
            {puzzleIdx + 1} of {data.items.length} &middot; {correct} correct so far
          </p>
        </div>
        {/* Progress pills */}
        <div className="flex items-center gap-1">
          {data.items.map((_, i) => {
            const a = attempts[i]
            let bg = 'bg-bg-3'
            if (a) bg = a.correct ? 'bg-success' : 'bg-danger'
            else if (i === puzzleIdx) bg = 'bg-accent'
            return <div key={i} className={`w-2 h-2 rounded-full ${bg} transition-colors`} />
          })}
        </div>
      </div>

      <div className="grid grid-cols-5 gap-8 items-start">
        {/* Board */}
        <div className="col-span-3">
          <PuzzleBoard
            key={`${item.puzzle.puzzle_id}-${puzzleIdx}`}
            item={item}
            onResult={handleResult}
          />
        </div>

        {/* Context panel */}
        <div className="col-span-2 space-y-4 pt-2">
          <ContextPanel item={item} puzzleIdx={puzzleIdx} total={data.items.length} />

          {/* Accuracy tracker */}
          {attempts.length > 0 && (
            <div className="card p-3">
              <p className="text-xs text-text-2 mb-1.5">Session accuracy</p>
              <div className="h-1.5 bg-bg-3 rounded-full overflow-hidden">
                <motion.div
                  className="h-full bg-success rounded-full"
                  animate={{ width: `${Math.round((correct / attempts.length) * 100)}%` }}
                  transition={{ duration: 0.4 }}
                />
              </div>
              <p className="text-xs text-text-1 mt-1.5">
                {correct}/{attempts.length} &middot; {Math.round((correct / attempts.length) * 100)}%
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
