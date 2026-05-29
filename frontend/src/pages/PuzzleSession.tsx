import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Chess } from 'chess.js'
import { Chessboard } from 'react-chessboard'
import { motion, AnimatePresence } from 'framer-motion'
import { Lightbulb, Check, X, ChevronRight, ChevronLeft, Zap, RotateCcw, Sword } from 'lucide-react'
import { useUserStore } from '../store/userStore'
import { api } from '../api'
import { ForkedWordmark } from '../components/layout/AppShell'
import { SectionHeader } from '../components/layout/SectionHeader'
import type { Square } from 'chess.js'
import type { Arrow } from 'react-chessboard/dist/chessboard/types'
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
  const chess = new Chess(item.puzzle.fen)
  applyUci(chess, item.puzzle.moves.split(' ')[0])
  // After the setup move, chess.turn() is the solver's color
  return chess.turn() === 'w' ? 'white' : 'black'
}

function makeHighlight(uci: string): Record<string, object> {
  if (!uci || uci.length < 4) return {}
  return {
    [uci.slice(0, 2)]: { backgroundColor: 'rgba(123,97,255,0.25)' },
    [uci.slice(2, 4)]: { backgroundColor: 'rgba(123,97,255,0.35)' },
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

type Phase = 'waiting' | 'correct_flash' | 'wrong_flash' | 'failed' | 'solved'
interface AttemptRecord { correct: boolean; time_s: number; cluster_id: string }

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

// ── ContextPanel ─────────────────────────────────────────────────────────────

function ContextPanel({ item, puzzleIdx, total }: { item: SessionItem; puzzleIdx: number; total: number }) {
  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className="badge bg-accent/15 text-accent border border-accent/20">
            #{item.blindspot_rank} Blindspot
          </span>
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
          <a href={item.puzzle.game_url} target="_blank" rel="noopener noreferrer"
            className="text-xs text-accent hover:underline">
            View on Lichess
          </a>
        </div>
      )}
    </div>
  )
}

// ── SessionComplete ───────────────────────────────────────────────────────────

function SessionComplete({ attempts, onRestart }: { attempts: AttemptRecord[]; onRestart: () => void }) {
  const correct = attempts.filter(a => a.correct).length
  const pct = attempts.length ? Math.round((correct / attempts.length) * 100) : 0
  const navigate = useNavigate()
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6">
      <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="text-center">
        <img src="/logo.png" alt="" className="h-14 w-auto mx-auto mb-4 opacity-90" />
        <h2 className="text-2xl font-bold text-text-0"><ForkedWordmark className="text-2xl" /> — Session complete</h2>
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

// ── PuzzleBoard ───────────────────────────────────────────────────────────────

const MAX_WRONG = 3

function PuzzleBoard({ item, onResult }: {
  item: SessionItem
  onResult: (correct: boolean, hintUsed: boolean, time_s: number) => void
}) {
  const moves    = item.puzzle.moves.split(' ')
  const orient   = getBoardOrientation(item)
  const chessRef = useRef(new Chess(item.puzzle.fen))
  const startRef = useRef(Date.now())

  const [fen,          setFen]          = useState(item.puzzle.fen)
  const [moveIdx,      setMoveIdx]      = useState(1)
  const [phase,        setPhase]        = useState<Phase>('waiting')
  const [wrongCount,   setWrongCount]   = useState(0)
  const [hintUsed,     setHintUsed]     = useState(false)
  const [highlight,    setHighlight]    = useState<Record<string, object>>({})
  const [selectedSq,   setSelectedSq]   = useState<Square | null>(null)
  const [optionSqs,    setOptionSqs]    = useState<Record<string, object>>({})
  const [solutionArrow, setSolutionArrow] = useState<Arrow[]>([])

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
    setSolutionArrow([])
    startRef.current = Date.now()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.puzzle.puzzle_id])

  const autoPlayOpponent = useCallback((nextIdx: number) => {
    if (nextIdx >= moves.length) return
    setTimeout(() => {
      const ok = applyUci(chessRef.current, moves[nextIdx])
      if (ok) {
        setFen(chessRef.current.fen())
        setHighlight(makeHighlight(moves[nextIdx]))
        setSolutionArrow([])
        setSelectedSq(null)
        setOptionSqs({})
        const afterIdx = nextIdx + 1
        if (afterIdx >= moves.length) {
          setPhase('solved')
          onResult(true, hintUsed, (Date.now() - startRef.current) / 1000)
        } else {
          setMoveIdx(afterIdx)
          setPhase('waiting')
        }
      }
    }, 480)
  }, [moves, hintUsed, onResult])

  // Animate the full remaining solution when the user exhausts their attempts.
  // Alternates green arrows (user moves) and accent arrows (opponent responses).
  const autoPlaySolution = useCallback((fromIdx: number) => {
    let i = fromIdx
    const step = () => {
      if (i >= moves.length) { setSolutionArrow([]); return }
      const uci    = moves[i]
      const isUser = (i - fromIdx) % 2 === 0   // 0, 2, 4 = user's correct moves
      const color  = isUser ? '#0DC97F' : '#7B61FF'

      applyUci(chessRef.current, uci)
      setFen(chessRef.current.fen())
      setHighlight({
        [uci.slice(0, 2)]: { backgroundColor: isUser ? 'rgba(13,201,127,0.22)' : 'rgba(123,97,255,0.18)' },
        [uci.slice(2, 4)]: { backgroundColor: isUser ? 'rgba(13,201,127,0.38)' : 'rgba(123,97,255,0.30)' },
      })
      setSolutionArrow([[uci.slice(0, 2) as Square, uci.slice(2, 4) as Square, color]])
      setSelectedSq(null); setOptionSqs({})
      i++
      if (i < moves.length) setTimeout(step, 950)
      else setSolutionArrow([])
    }
    setTimeout(step, 750)   // short delay so the fail banner renders first
  }, [moves])

  function attemptMove(from: string, to: string, piece?: string): boolean {
    if (phase !== 'waiting') return false

    // Ignore illegal moves — don't count them as attempts
    const legal = chessRef.current.moves({ verbose: true })
    if (!legal.some(m => m.from === from && m.to === to)) return false

    const expected = moves[moveIdx]
    const isCorrect =
      from === expected.slice(0, 2) &&
      to   === expected.slice(2, 4) &&
      (!expected[4] || (piece?.toLowerCase().slice(-1) ?? '') === expected[4])

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
          onResult(true, hintUsed, (Date.now() - startRef.current) / 1000)
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
        if (newWrong >= MAX_WRONG) {
          setPhase('failed')
          onResult(false, hintUsed, (Date.now() - startRef.current) / 1000)
          autoPlaySolution(moveIdx)   // animate full remaining solution
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
    const exp = moves[moveIdx]
    setHighlight({ ...makeHighlight(exp), [exp.slice(0, 2)]: { backgroundColor: 'rgba(255,193,7,0.35)' } })
    setSelectedSq(null)
    setOptionSqs({})
  }

  const isDone = phase === 'solved' || phase === 'failed'
  const attemptsLeft = MAX_WRONG - wrongCount
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
            <X size={14} /> Not quite — {attemptsLeft} attempt{attemptsLeft === 1 ? '' : 's'} left
          </motion.div>
        )}
        {phase === 'failed' && (
          <motion.div key="failed"
            initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
            className="px-3 py-2 bg-danger/10 rounded-md border border-danger/20"
          >
            <span className="flex items-center gap-2 text-danger text-sm font-medium">
              <X size={14} /> Missed — playing solution…
            </span>
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
          customArrows={solutionArrow}
          arePiecesDraggable={phase === 'waiting'}
          boardWidth={500}
          customDarkSquareStyle={{ backgroundColor: '#1A1D36' }}
          customLightSquareStyle={{ backgroundColor: '#343761' }}
          customBoardStyle={{ borderRadius: '6px', boxShadow: '0 0 0 1px rgba(123,97,255,0.15)' }}
        />
      </motion.div>

      {/* Attempt dots + hint */}
      {!isDone && (
        <div className="flex items-center gap-3">
          <div className="flex gap-1.5">
            {Array.from({ length: MAX_WRONG }).map((_, i) => (
              <div key={i} className={`w-2 h-2 rounded-full transition-colors
                ${i < wrongCount ? 'bg-danger' : 'bg-bg-3'}`} />
            ))}
          </div>
          <button
            onClick={showHint}
            disabled={hintUsed}
            className="flex items-center gap-1.5 text-xs text-text-2 hover:text-text-0 disabled:opacity-40 transition-colors"
          >
            <Lightbulb size={12} />
            {hintUsed ? 'Hint used' : 'Show hint'}
          </button>
        </div>
      )}
    </div>
  )
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function PuzzleSession() {
  const { username, elo } = useUserStore()
  const navigate = useNavigate()
  const location = useLocation()
  const { clusterId } = (location.state ?? {}) as { clusterId?: string }

  const [puzzleIdx,  setPuzzleIdx]  = useState(0)
  const [attempts,   setAttempts]   = useState<Record<number, AttemptRecord>>({})
  const [puzzleDone, setPuzzleDone] = useState(false)
  const [complete,   setComplete]   = useState(false)

  const { data, isLoading, error, refetch } = useQuery<SessionResponse>({
    queryKey: ['session', username, elo, clusterId ?? null],
    queryFn:  () => api.getSession(username, elo || 1200, 12, clusterId),
    enabled:  !!username,
    staleTime: 0,
  })

  function handleResult(correct: boolean, _hintUsed: boolean, time_s: number) {
    if (!data) return
    const item = data.items[puzzleIdx]
    setAttempts(prev => ({
      ...prev,
      [puzzleIdx]: { correct, time_s, cluster_id: String(item.cluster_id) },
    }))
    setPuzzleDone(true)
  }

  function goToPuzzle(i: number) {
    if (!data || i < 0 || i >= data.items.length) return
    setPuzzleIdx(i)
    setPuzzleDone(attempts[i] !== undefined)
  }

  function handleNext() {
    if (!data) return
    const next = puzzleIdx + 1

    if (next < data.items.length) {
      goToPuzzle(next)
      return
    }

    // At the last puzzle — check for unattempted ones before wrapping up
    const unattempted = data.items
      .map((_, i) => i)
      .filter(i => attempts[i] === undefined)

    if (unattempted.length > 0) {
      goToPuzzle(unattempted[0])
    } else {
      const allAttempts = Object.values(attempts)
      api.completeSession(username, allAttempts.map(a => ({
        cluster_id: a.cluster_id, correct: a.correct, time_s: a.time_s,
      }))).catch(() => {})
      setComplete(true)
    }
  }

  function handleRestart() {
    setAttempts({})
    setPuzzleIdx(0)
    setPuzzleDone(false)
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
    return <SessionComplete attempts={Object.values(attempts)} onRestart={handleRestart} />
  }

  const item = data.items[puzzleIdx]
  const correctCount   = Object.values(attempts).filter(a => a.correct).length
  const totalAttempted = Object.keys(attempts).length

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <SectionHeader
        icon={Sword}
        title={clusterId ? 'Targeted Drill' : 'Drill Session'}
        description={`Spaced-repetition puzzles for your top blindspots · Puzzle ${puzzleIdx + 1} of ${data.items.length}${totalAttempted > 0 ? ` · ${correctCount}/${totalAttempted} correct` : ''}`}
        right={
          <div className="flex items-center gap-1.5">
            {data.items.map((_, i) => {
              const a = attempts[i]
              const isCurrent = i === puzzleIdx
              const color = a
                ? (a.correct ? 'bg-success' : 'bg-danger')
                : isCurrent ? 'bg-accent' : 'bg-bg-3'
              return (
                <button
                  key={i}
                  onClick={() => goToPuzzle(i)}
                  title={`Puzzle ${i + 1}`}
                  className={`rounded-full transition-all duration-150 hover:scale-125
                    ${isCurrent ? 'w-3 h-3 scale-125' : 'w-2.5 h-2.5'}
                    ${color}`}
                />
              )
            })}
          </div>
        }
      />

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

          {/* Prev / Next — only when current puzzle is done */}
          {puzzleDone && (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex gap-2"
            >
              <button
                onClick={() => goToPuzzle(puzzleIdx - 1)}
                disabled={puzzleIdx === 0}
                className="btn-ghost flex items-center gap-1 text-sm flex-1 justify-center disabled:opacity-30"
              >
                <ChevronLeft size={14} /> Prev
              </button>
              <button
                onClick={handleNext}
                className="btn-primary flex items-center gap-1 text-sm flex-1 justify-center"
              >
                {(() => {
                  const remaining = data.items.filter((_, i) => i !== puzzleIdx && attempts[i] === undefined).length
                  if (puzzleIdx === data.items.length - 1) {
                    return remaining > 0 ? `${remaining} remaining` : 'Finish'
                  }
                  return 'Next'
                })()}
                <ChevronRight size={14} />
              </button>
            </motion.div>
          )}

          {/* Session accuracy */}
          {totalAttempted > 0 && (
            <div className="card p-3">
              <p className="text-xs text-text-2 mb-1.5">Session accuracy</p>
              <div className="h-1.5 bg-bg-3 rounded-full overflow-hidden">
                <motion.div
                  className="h-full bg-success rounded-full"
                  animate={{ width: `${Math.round((correctCount / totalAttempted) * 100)}%` }}
                  transition={{ duration: 0.4 }}
                />
              </div>
              <p className="text-xs text-text-1 mt-1.5">
                {correctCount}/{totalAttempted} · {Math.round((correctCount / totalAttempted) * 100)}%
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
