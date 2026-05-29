import { useState, useEffect, useCallback, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Chess } from 'chess.js'
import { Chessboard } from 'react-chessboard'
import { motion } from 'framer-motion'
import { ChevronLeft, ChevronRight, RotateCcw, Undo2, Copy, Check, FlipVertical2 } from 'lucide-react'
import type { Square } from 'chess.js'
import type { Arrow } from 'react-chessboard/dist/chessboard/types'

// ── Types ─────────────────────────────────────────────────────────────────────

interface NavPosition {
  fen: string
  label: string
  best_move_uci?: string
  mistake_uci?: string
}

interface AnalysisNavState {
  positions: NavPosition[]
  index: number
  title: string
}

interface AnalysisResult {
  best_move: string | null
  eval_cp: number | null
  eval_mate: number | null
}

// ── Eval bar ──────────────────────────────────────────────────────────────────

function EvalBar({ evalCp, evalMate, loading, boardH }: {
  evalCp: number | null
  evalMate: number | null
  loading: boolean
  boardH: number
}) {
  let whitePct = 50
  let label = '0.0'

  if (!loading) {
    if (evalMate !== null) {
      whitePct = evalMate > 0 ? 97 : 3
      label = `M${Math.abs(evalMate)}`
    } else if (evalCp !== null) {
      whitePct = 50 + 50 * Math.tanh(evalCp / 400)
      whitePct = Math.max(2, Math.min(98, whitePct))
      const pawns = Math.abs(evalCp / 100)
      label = (evalCp >= 0 ? '+' : '') + (pawns >= 10 ? (evalCp > 0 ? '+' : '-') + '10' : (evalCp / 100).toFixed(1))
    }
  }

  const blackPct = 100 - whitePct
  const showLabelTop    = whitePct <= 30
  const showLabelBottom = whitePct > 30

  return (
    <div className="flex flex-col items-center gap-1 flex-shrink-0">
      <div className="w-5 rounded overflow-hidden relative flex flex-col" style={{ height: boardH }}>
        <div className="w-full bg-bg-3 flex items-start justify-center transition-[flex] duration-500 ease-out"
          style={{ flex: blackPct }}>
          {showLabelTop && <span className="text-[9px] font-bold text-text-0 mt-1 leading-none">{label}</span>}
        </div>
        <div className="w-full bg-[#E8E8F0] flex items-end justify-center transition-[flex] duration-500 ease-out"
          style={{ flex: whitePct }}>
          {showLabelBottom && <span className="text-[9px] font-bold text-bg-0 mb-1 leading-none">{label}</span>}
        </div>
      </div>
      {loading && <div className="w-3 h-3 border border-accent border-t-transparent rounded-full animate-spin" />}
    </div>
  )
}

// ── Move list with chess notation ─────────────────────────────────────────────

function MoveList({ moves, currentIdx, onNavigate, baseFen }: {
  moves: string[]
  currentIdx: number   // -1 = at base (no moves played yet)
  onNavigate: (idx: number) => void
  baseFen: string
}) {
  // Determine starting move number + whose turn from the base FEN
  const fenParts  = baseFen.split(' ')
  const startMove = parseInt(fenParts[5] ?? '1', 10)
  const startTurn = fenParts[1] ?? 'w'   // 'w' | 'b'

  // Build display pairs: each entry is { moveNo, white, black }
  // where white/black are indices into `moves` (or null)
  type Pair = { moveNo: number; whiteIdx: number | null; blackIdx: number | null }
  const pairs: Pair[] = []

  let i = 0
  let moveNo = startMove

  // If black goes first at the base position, the first entry has no white move
  if (startTurn === 'b' && moves.length > 0) {
    pairs.push({ moveNo, whiteIdx: null, blackIdx: 0 })
    i = 1
    moveNo++
  }

  while (i < moves.length) {
    pairs.push({
      moveNo,
      whiteIdx: i < moves.length ? i : null,
      blackIdx: i + 1 < moves.length ? i + 1 : null,
    })
    i += 2
    moveNo++
  }

  if (pairs.length === 0) return null

  return (
    <div className="font-mono text-xs max-h-52 overflow-y-auto space-y-0.5 pr-1">
      {pairs.map((pair) => (
        <div key={pair.moveNo} className="flex items-stretch gap-0.5">
          <span className="text-text-2 w-6 flex-shrink-0 pt-0.5">{pair.moveNo}.</span>

          {/* White */}
          <button
            onClick={() => pair.whiteIdx !== null && onNavigate(pair.whiteIdx)}
            disabled={pair.whiteIdx === null}
            className={`flex-1 text-left px-1.5 py-0.5 rounded transition-colors
              ${pair.whiteIdx === null ? 'opacity-0 cursor-default' : ''}
              ${currentIdx === pair.whiteIdx
                ? 'bg-accent/25 text-accent font-semibold'
                : 'hover:bg-bg-2 text-text-0'}`}
          >
            {pair.whiteIdx !== null ? moves[pair.whiteIdx] : '…'}
          </button>

          {/* Black */}
          {pair.blackIdx !== null ? (
            <button
              onClick={() => onNavigate(pair.blackIdx!)}
              className={`flex-1 text-left px-1.5 py-0.5 rounded transition-colors
                ${currentIdx === pair.blackIdx
                  ? 'bg-accent/25 text-accent font-semibold'
                  : 'hover:bg-bg-2 text-text-0'}`}
            >
              {moves[pair.blackIdx]}
            </button>
          ) : (
            <div className="flex-1" />
          )}
        </div>
      ))}
    </div>
  )
}

// ── Click-to-move helpers ─────────────────────────────────────────────────────

function getMoveOptions(chess: Chess, square: Square): Record<string, object> {
  const moves = chess.moves({ square, verbose: true })
  const styles: Record<string, object> = {}
  moves.forEach((m) => {
    styles[m.to] = {
      background: chess.get(m.to)
        ? 'radial-gradient(circle, rgba(255,77,77,0.35) 85%, transparent 85%)'
        : 'radial-gradient(circle, rgba(123,97,255,0.35) 40%, transparent 40%)',
      borderRadius: '50%',
    }
  })
  styles[square] = { backgroundColor: 'rgba(123,97,255,0.25)' }
  return styles
}

// ── Main page ─────────────────────────────────────────────────────────────────

const BOARD_SIZE = 520
const START_FEN  = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

export default function AnalysisBoard() {
  const location = useLocation()
  const navigate  = useNavigate()
  const navState  = location.state as AnalysisNavState | null

  const positions: NavPosition[] = navState?.positions ?? []
  const title: string = navState?.title ?? 'Analysis Board'

  const [posIdx, setPosIdx] = useState(navState?.index ?? 0)

  const initFen = positions[navState?.index ?? 0]?.fen ?? START_FEN
  const baseFenRef = useRef<string>(initFen)

  // Mutable chess instance (mutated in place, triggers rerender via setChess)
  const [chess,    setChess]    = useState<Chess>(() => new Chess(initFen))
  const [fen,      setFen]      = useState(initFen)
  const [sanMoves, setSanMoves] = useState<string[]>([])
  const [moveIdx,  setMoveIdx]  = useState(-1)   // -1 = at base position

  // Click-to-move
  const [selectedSq,  setSelectedSq]  = useState<Square | null>(null)
  const [optionSqs,   setOptionSqs]   = useState<Record<string, object>>({})
  const [lastMoveSqs, setLastMoveSqs] = useState<Record<string, object>>({})

  // Copied FEN toast
  const [copied, setCopied] = useState(false)
  const [orient, setOrient] = useState<'white' | 'black'>('white')

  function goToPosition(idx: number) {
    const newFen = positions[idx]?.fen ?? START_FEN
    baseFenRef.current = newFen
    chess.load(newFen)
    setPosIdx(idx)
    setFen(newFen)
    setSanMoves([])
    setMoveIdx(-1)
    setSelectedSq(null)
    setOptionSqs({})
    setLastMoveSqs({})
    setChess(chess)
  }

  // Navigate within the move list (reconstruct from base + slice of sanMoves)
  function navigateToMove(targetIdx: number) {
    chess.load(baseFenRef.current)
    const slice = sanMoves.slice(0, targetIdx + 1)
    for (const san of slice) {
      try { chess.move(san) } catch { break }
    }
    setFen(chess.fen())
    setMoveIdx(targetIdx)
    setChess(chess)
    setSelectedSq(null)
    setOptionSqs({})
    setLastMoveSqs({})
  }

  useEffect(() => {
    goToPosition(posIdx)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Live Stockfish analysis
  const { data: analysis, isFetching: analysisLoading } = useQuery<AnalysisResult>({
    queryKey: ['analysis', fen],
    queryFn: () =>
      fetch(`/api/analyse?fen=${encodeURIComponent(fen)}&depth=14`).then(r => {
        if (!r.ok) throw new Error('Analysis failed')
        return r.json()
      }),
    staleTime: Infinity,
    retry: false,
  })

  const isAtBase = sanMoves.length === 0 || moveIdx === -1

  const liveBestMove: string | null = analysis?.best_move ?? null
  const bestMoveUci: string | null = analysisLoading
    ? (isAtBase ? (positions[posIdx]?.best_move_uci ?? null) : null)
    : (liveBestMove ?? (isAtBase ? (positions[posIdx]?.best_move_uci ?? null) : null))

  const mistakeUci: string | null = isAtBase ? (positions[posIdx]?.mistake_uci ?? null) : null

  const arrows: Arrow[] = [
    ...(mistakeUci && mistakeUci.length >= 4
      ? [[mistakeUci.slice(0, 2) as Square, mistakeUci.slice(2, 4) as Square, '#FF4D4D'] as Arrow]
      : []),
    ...(bestMoveUci && bestMoveUci.length >= 4
      ? [[bestMoveUci.slice(0, 2) as Square, bestMoveUci.slice(2, 4) as Square, '#7B61FF'] as Arrow]
      : []),
  ]

  // ── Square click ─────────────────────────────────────────────────────────────

  function handleSquareClick(square: Square) {
    const piece = chess.get(square)
    if (selectedSq && optionSqs[square] !== undefined) {
      makeMove(selectedSq, square)
      return
    }
    if (piece && piece.color === chess.turn()) {
      setSelectedSq(square)
      setOptionSqs(getMoveOptions(chess, square))
      return
    }
    setSelectedSq(null)
    setOptionSqs({})
  }

  // ── Drag-and-drop ─────────────────────────────────────────────────────────────

  function handlePieceDrop(from: string, to: string, piece: string): boolean {
    const promo = piece?.toLowerCase().slice(-1)
    return makeMove(from as Square, to as Square, promo === 'q' ? undefined : promo)
  }

  // ── Shared move logic ─────────────────────────────────────────────────────────

  const makeMove = useCallback((from: Square, to: Square, promotion?: string): boolean => {
    const move = chess.move({ from, to, promotion: promotion ?? 'q' })
    if (!move) return false

    const newFen  = chess.fen()
    const newSans = [...sanMoves.slice(0, moveIdx + 1), move.san]

    setFen(newFen)
    setSanMoves(newSans)
    setMoveIdx(newSans.length - 1)
    setSelectedSq(null)
    setOptionSqs({})
    setLastMoveSqs({
      [from]: { backgroundColor: 'rgba(123,97,255,0.22)' },
      [to]:   { backgroundColor: 'rgba(123,97,255,0.32)' },
    })
    setChess(chess)
    return true
  }, [chess, sanMoves, moveIdx])

  function handleUndo() {
    if (moveIdx < 0) return
    navigateToMove(moveIdx - 1)
  }

  function handleReset() {
    goToPosition(posIdx)
  }

  function copyFen() {
    navigator.clipboard.writeText(fen).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    })
  }

  const squareStyles = { ...lastMoveSqs, ...optionSqs }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate(-1)} className="btn-ghost flex items-center gap-1.5 text-sm">
          <ChevronLeft size={14} /> Back
        </button>
        <div className="h-4 w-px bg-border" />
        <h1 className="text-lg font-bold text-text-0 truncate max-w-md">{title}</h1>
      </div>

      <div className="flex items-start gap-4">
        {/* Eval bar */}
        <EvalBar
          evalCp={analysis?.eval_cp ?? null}
          evalMate={analysis?.eval_mate ?? null}
          loading={analysisLoading}
          boardH={BOARD_SIZE}
        />

        {/* Board */}
        <div className="flex-shrink-0">
          <Chessboard
            position={fen}
            boardOrientation={orient}
            onPieceDrop={handlePieceDrop}
            onSquareClick={handleSquareClick}
            boardWidth={BOARD_SIZE}
            customSquareStyles={squareStyles}
            customArrows={arrows}
            customDarkSquareStyle={{ backgroundColor: '#1A1D36' }}
            customLightSquareStyle={{ backgroundColor: '#343761' }}
            customBoardStyle={{ borderRadius: '6px', boxShadow: '0 0 0 1px rgba(123,97,255,0.15)' }}
          />
        </div>

        {/* Info panel */}
        <div className="flex-1 min-w-0 space-y-4" style={{ paddingTop: 4 }}>

          {/* Position navigator */}
          {positions.length > 0 && (
            <div className="card p-4 space-y-3">
              <div className="flex items-center justify-between">
                <button disabled={posIdx === 0} onClick={() => goToPosition(posIdx - 1)}
                  className="p-1.5 rounded hover:bg-bg-2 disabled:opacity-30 transition-colors">
                  <ChevronLeft size={16} className="text-text-1" />
                </button>
                <div className="text-center flex-1 px-2">
                  <p className="text-xs text-text-2">{posIdx + 1} / {positions.length}</p>
                  <p className="text-sm font-medium text-text-0 truncate mt-0.5">
                    {positions[posIdx]?.label ?? '—'}
                  </p>
                </div>
                <button disabled={posIdx === positions.length - 1} onClick={() => goToPosition(posIdx + 1)}
                  className="p-1.5 rounded hover:bg-bg-2 disabled:opacity-30 transition-colors">
                  <ChevronRight size={16} className="text-text-1" />
                </button>
              </div>
            </div>
          )}

          {/* Mistake + Best move */}
          <div className="card p-4 space-y-3">
            {mistakeUci && mistakeUci.length >= 4 && (
              <div>
                <p className="text-xs text-text-2 mb-1.5">Mistake played</p>
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-danger flex-shrink-0" />
                  <span className="font-mono text-danger font-medium">
                    {mistakeUci.slice(0, 2)} → {mistakeUci.slice(2, 4)}
                    {mistakeUci[4] ? `=${mistakeUci[4].toUpperCase()}` : ''}
                  </span>
                </div>
              </div>
            )}
            <div>
              <p className="text-xs text-text-2 mb-1.5">Best move</p>
              {analysisLoading && !bestMoveUci ? (
                <div className="flex items-center gap-2">
                  <div className="w-3.5 h-3.5 border border-accent border-t-transparent rounded-full animate-spin" />
                  <span className="text-sm text-text-2">Analysing…</span>
                </div>
              ) : bestMoveUci ? (
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${analysisLoading ? 'bg-text-2' : 'bg-accent'}`} />
                  <span className="font-mono text-text-0 font-medium">
                    {bestMoveUci.slice(0, 2)} → {bestMoveUci.slice(2, 4)}
                    {bestMoveUci[4] ? `=${bestMoveUci[4].toUpperCase()}` : ''}
                  </span>
                  {analysisLoading && (
                    <div className="w-2.5 h-2.5 border border-accent border-t-transparent rounded-full animate-spin ml-1" />
                  )}
                </div>
              ) : (
                <span className="text-sm text-text-2">—</span>
              )}
            </div>
          </div>

          {/* Evaluation */}
          <div className="card p-4">
            <p className="text-xs text-text-2 mb-2">Evaluation</p>
            {analysisLoading ? (
              <span className="text-sm text-text-2">…</span>
            ) : analysis?.eval_mate != null ? (
              <span className="text-lg font-bold text-accent">
                M{Math.abs(analysis.eval_mate)}
                <span className="text-xs text-text-2 font-normal ml-1">
                  ({analysis.eval_mate > 0 ? 'white' : 'black'} mates)
                </span>
              </span>
            ) : analysis?.eval_cp != null ? (
              <span className={`text-lg font-bold ${analysis.eval_cp >= 0 ? 'text-text-0' : 'text-text-2'}`}>
                {analysis.eval_cp >= 0 ? '+' : ''}{(analysis.eval_cp / 100).toFixed(2)}
              </span>
            ) : (
              <span className="text-sm text-text-2">—</span>
            )}
          </div>

          {/* Move list — proper chess notation with navigation */}
          <div className="card p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs text-text-2">Moves played</p>
              {sanMoves.length > 0 && (
                <button
                  onClick={() => navigateToMove(-1)}
                  className="text-xs text-text-2 hover:text-text-0 transition-colors"
                >
                  ↩ Start
                </button>
              )}
            </div>
            {sanMoves.length === 0 ? (
              <p className="text-xs text-text-2 italic">Play a move to begin</p>
            ) : (
              <MoveList
                moves={sanMoves}
                currentIdx={moveIdx}
                onNavigate={navigateToMove}
                baseFen={baseFenRef.current}
              />
            )}
          </div>

          {/* Controls */}
          <div className="flex gap-2">
            <button onClick={handleUndo} disabled={moveIdx < 0}
              className="btn-ghost flex items-center gap-1.5 text-sm disabled:opacity-30" title="Undo">
              <Undo2 size={13} /> Undo
            </button>
            <button onClick={handleReset} disabled={sanMoves.length === 0}
              className="btn-ghost flex items-center gap-1.5 text-sm disabled:opacity-30" title="Reset">
              <RotateCcw size={13} /> Reset
            </button>
            <button onClick={() => setOrient(o => o === 'white' ? 'black' : 'white')}
              className="btn-ghost flex items-center gap-1.5 text-sm" title="Flip board">
              <FlipVertical2 size={13} /> Flip
            </button>
          </div>

          {/* FEN */}
          <div className="card p-3">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs text-text-2">FEN</p>
              <button onClick={copyFen}
                className="flex items-center gap-1 text-xs text-text-2 hover:text-text-0 transition-colors">
                {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="font-mono text-xs text-text-1 break-all leading-relaxed">{fen}</p>
          </div>
        </div>
      </div>
    </div>
  )
}
