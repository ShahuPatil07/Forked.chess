import { useState, useEffect, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Chess } from 'chess.js'
import { Chessboard } from 'react-chessboard'
import { motion } from 'framer-motion'
import { ChevronLeft, ChevronRight, RotateCcw, Undo2, Copy, Check } from 'lucide-react'
import type { Square } from 'chess.js'
import type { Arrow } from 'react-chessboard/dist/chessboard/types'

// ── Types ─────────────────────────────────────────────────────────────────────

interface NavPosition {
  fen: string
  label: string
  best_move_uci?: string   // used only at base before Stockfish responds
  mistake_uci?: string     // the move that was actually played (shown as red arrow)
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
      // sigmoid-like mapping: ±4 pawns fills most of the bar
      whitePct = 50 + 50 * Math.tanh(evalCp / 400)
      whitePct = Math.max(2, Math.min(98, whitePct))
      const pawns = Math.abs(evalCp / 100)
      label = (evalCp >= 0 ? '+' : '') + (pawns >= 10 ? (evalCp > 0 ? '+' : '-') + '10' : (evalCp / 100).toFixed(1))
    }
  }

  const blackPct = 100 - whitePct
  const showLabelTop    = whitePct <= 30   // label lives in black section
  const showLabelBottom = whitePct > 30    // label lives in white section

  return (
    <div className="flex flex-col items-center gap-1 flex-shrink-0">
      <div
        className="w-5 rounded overflow-hidden relative flex flex-col"
        style={{ height: boardH }}
      >
        {/* Black portion */}
        <div
          className="w-full bg-bg-3 flex items-start justify-center transition-[flex] duration-500 ease-out"
          style={{ flex: blackPct }}
        >
          {showLabelTop && (
            <span className="text-[9px] font-bold text-text-0 mt-1 leading-none">{label}</span>
          )}
        </div>
        {/* White portion */}
        <div
          className="w-full bg-[#E8E8F0] flex items-end justify-center transition-[flex] duration-500 ease-out"
          style={{ flex: whitePct }}
        >
          {showLabelBottom && (
            <span className="text-[9px] font-bold text-bg-0 mb-1 leading-none">{label}</span>
          )}
        </div>
      </div>
      {loading && (
        <div className="w-3 h-3 border border-accent border-t-transparent rounded-full animate-spin" />
      )}
    </div>
  )
}

// ── Move history strip ────────────────────────────────────────────────────────

function MoveStrip({ moves, current }: { moves: string[]; current: number }) {
  if (moves.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
      {moves.map((san, i) => (
        <span
          key={i}
          className={`text-xs px-1.5 py-0.5 rounded font-mono
            ${i === current ? 'bg-accent/20 text-accent' : 'bg-bg-2 text-text-1'}`}
        >
          {san}
        </span>
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

  // Move history within a base position
  const [chess,    setChess]    = useState<Chess>(() => new Chess(positions[navState?.index ?? 0]?.fen ?? START_FEN))
  const [fen,      setFen]      = useState(positions[navState?.index ?? 0]?.fen ?? START_FEN)
  const [sanMoves, setSanMoves] = useState<string[]>([])   // SAN labels for display
  const [moveIdx,  setMoveIdx]  = useState(-1)              // index into sanMoves (-1 = at base)

  // Click-to-move state
  const [selectedSq,  setSelectedSq]  = useState<Square | null>(null)
  const [optionSqs,   setOptionSqs]   = useState<Record<string, object>>({})
  const [lastMoveSqs, setLastMoveSqs] = useState<Record<string, object>>({})

  // Copied FEN toast
  const [copied, setCopied] = useState(false)

  // Navigate to a new base position (from positions array)
  function goToPosition(idx: number) {
    const newFen = positions[idx]?.fen ?? START_FEN
    const c = new Chess(newFen)
    setPosIdx(idx)
    setChess(c)
    setFen(newFen)
    setSanMoves([])
    setMoveIdx(-1)
    setSelectedSq(null)
    setOptionSqs({})
    setLastMoveSqs({})
  }

  // When posIdx changes from outside (e.g. arrow keys) reset the board
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

  // Are we at the base position (no user moves played yet)?
  const isAtBase = sanMoves.length === 0

  // Best-move arrow: show live Stockfish result.
  // While fetching (analysisLoading) hide the arrow entirely so the old one
  // doesn't linger — exactly how Lichess clears and redraws.
  // At the base position, fall back to pre-stored uci so the arrow appears
  // before Stockfish finishes (replaced once analysis returns).
  const liveBestMove: string | null = analysis?.best_move ?? null
  const bestMoveUci: string | null = analysisLoading
    ? (isAtBase ? (positions[posIdx]?.best_move_uci ?? null) : null)
    : (liveBestMove ?? (isAtBase ? (positions[posIdx]?.best_move_uci ?? null) : null))

  // Red "mistake" arrow shown only at the base position
  const mistakeUci: string | null = isAtBase
    ? (positions[posIdx]?.mistake_uci ?? null)
    : null

  const arrows: Arrow[] = [
    ...(mistakeUci && mistakeUci.length >= 4
      ? [[mistakeUci.slice(0, 2) as Square, mistakeUci.slice(2, 4) as Square, '#FF4D4D'] as Arrow]
      : []),
    ...(bestMoveUci && bestMoveUci.length >= 4
      ? [[bestMoveUci.slice(0, 2) as Square, bestMoveUci.slice(2, 4) as Square, '#7B61FF'] as Arrow]
      : []),
  ]

  // ── Square click (click-to-move) ────────────────────────────────────────────

  function handleSquareClick(square: Square) {
    const piece = chess.get(square)

    // If something is selected and we click a valid destination
    if (selectedSq && optionSqs[square] !== undefined) {
      makeMove(selectedSq, square)
      return
    }

    // Select own piece
    if (piece && piece.color === chess.turn()) {
      setSelectedSq(square)
      setOptionSqs(getMoveOptions(chess, square))
      return
    }

    // Deselect
    setSelectedSq(null)
    setOptionSqs({})
  }

  // ── Drag-and-drop ───────────────────────────────────────────────────────────

  function handlePieceDrop(from: string, to: string, piece: string): boolean {
    const promo = piece?.toLowerCase().slice(-1)
    return makeMove(from as Square, to as Square, promo === 'q' ? undefined : promo)
  }

  // ── Shared move logic ───────────────────────────────────────────────────────

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

    // Chess instance is mutable — we update the ref in-place so the fen
    // always reflects the latest state
    setChess(chess)
    return true
  }, [chess, sanMoves, moveIdx])

  function handleUndo() {
    chess.undo()
    const newFen  = chess.fen()
    const newIdx  = moveIdx - 1
    setFen(newFen)
    setMoveIdx(newIdx)
    setSelectedSq(null)
    setOptionSqs({})
    if (newIdx >= 0) {
      // rebuild last move highlight from the san list's last move is tricky;
      // just clear it
      setLastMoveSqs({})
    } else {
      setLastMoveSqs({})
    }
    setChess(chess)
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
            onPieceDrop={handlePieceDrop}
            onSquareClick={handleSquareClick}
            boardWidth={BOARD_SIZE}
            customSquareStyles={squareStyles}
            customArrows={arrows}
            customDarkSquareStyle={{ backgroundColor: '#1A1D36' }}
            customLightSquareStyle={{ backgroundColor: '#343761' }}
            customBoardStyle={{
              borderRadius: '6px',
              boxShadow: '0 0 0 1px rgba(123,97,255,0.15)',
            }}
          />
        </div>

        {/* Info panel */}
        <div className="flex-1 min-w-0 space-y-4" style={{ paddingTop: 4 }}>
          {/* Position label + nav */}
          {positions.length > 0 && (
            <div className="card p-4 space-y-3">
              <div className="flex items-center justify-between">
                <button
                  disabled={posIdx === 0}
                  onClick={() => goToPosition(posIdx - 1)}
                  className="p-1.5 rounded hover:bg-bg-2 disabled:opacity-30 transition-colors"
                >
                  <ChevronLeft size={16} className="text-text-1" />
                </button>
                <div className="text-center flex-1 px-2">
                  <p className="text-xs text-text-2">{posIdx + 1} / {positions.length}</p>
                  <p className="text-sm font-medium text-text-0 truncate mt-0.5">
                    {positions[posIdx]?.label ?? '—'}
                  </p>
                </div>
                <button
                  disabled={posIdx === positions.length - 1}
                  onClick={() => goToPosition(posIdx + 1)}
                  className="p-1.5 rounded hover:bg-bg-2 disabled:opacity-30 transition-colors"
                >
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
                  <span className="text-sm text-text-2">Analysing...</span>
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
              <span className="text-sm text-text-2">...</span>
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

          {/* Move history */}
          {sanMoves.length > 0 && (
            <div className="card p-4">
              <p className="text-xs text-text-2 mb-2">Moves played</p>
              <MoveStrip moves={sanMoves} current={moveIdx} />
            </div>
          )}

          {/* Controls */}
          <div className="flex gap-2">
            <button
              onClick={handleUndo}
              disabled={moveIdx < 0}
              className="btn-ghost flex items-center gap-1.5 text-sm disabled:opacity-30"
              title="Undo last move"
            >
              <Undo2 size={13} /> Undo
            </button>
            <button
              onClick={handleReset}
              disabled={sanMoves.length === 0}
              className="btn-ghost flex items-center gap-1.5 text-sm disabled:opacity-30"
              title="Reset to starting position"
            >
              <RotateCcw size={13} /> Reset
            </button>
          </div>

          {/* FEN */}
          <div className="card p-3">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs text-text-2">FEN</p>
              <button
                onClick={copyFen}
                className="flex items-center gap-1 text-xs text-text-2 hover:text-text-0 transition-colors"
              >
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
