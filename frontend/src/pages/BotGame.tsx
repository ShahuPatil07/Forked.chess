import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Chess } from 'chess.js'
import { Chessboard } from 'react-chessboard'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Bot, User, RotateCcw, Flag, ChevronLeft, ChevronRight,
  Wifi, WifiOff, Microscope, Circle,
} from 'lucide-react'
import { api } from '../api'
import { SectionHeader, SectionHeaderStat } from '../components/layout/SectionHeader'
import { useUserStore } from '../store/userStore'
import type { Square } from 'chess.js'
import type { Arrow } from 'react-chessboard/dist/chessboard/types'

// ── Types ────────────────────────────────────────────────────────────────────

type WsMsg =
  | { type: 'game_start'; fen: string; user_color: 'white' | 'black'; target_elo: number }
  | { type: 'move_made';  move: string; fen: string; by: 'user' | 'bot' }
  | { type: 'thinking' }
  | { type: 'game_over';  result: string; reason: string }
  | { type: 'error';      message: string }

type GameStatus = 'connecting' | 'active' | 'finished'
type ConnStatus = 'connecting' | 'connected' | 'disconnected'
type Phase      = 'setup' | 'game' | 'analyze'

// ── Pure helpers ──────────────────────────────────────────────────────────────

function uciToFrom(uci: string) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promo: uci[4] as string | undefined }
}

function resultLabel(result: string, userColor: 'white' | 'black') {
  if (result === '1/2-1/2') return 'Draw'
  const whiteWon = result === '1-0'
  return (whiteWon && userColor === 'white') || (!whiteWon && userColor === 'black')
    ? 'You won!' : 'Maia won'
}

function resultSub(reason: string) {
  const map: Record<string, string> = {
    checkmate: 'by checkmate', resignation: 'by resignation',
    stalemate: 'draw by stalemate', insufficient_material: 'draw — insufficient material',
    seventy_five_moves: 'draw — 75-move rule', fivefold_repetition: 'draw — repetition',
  }
  return map[reason] ?? reason
}

function getMoveOptions(chess: Chess, square: Square): Record<string, object> {
  const styles: Record<string, object> = {}
  chess.moves({ square, verbose: true }).forEach((m) => {
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

function buildGamePositions(uciMoves: string[]): { fens: string[]; sans: string[] } {
  const chess = new Chess()
  const fens  = [chess.fen()]
  const sans: string[] = []
  for (const uci of uciMoves) {
    const { from, to, promo } = uciToFrom(uci)
    try {
      const r = chess.move({ from, to, promotion: promo ?? 'q' })
      if (r) { fens.push(chess.fen()); sans.push(r.san) }
    } catch { break }
  }
  return { fens, sans }
}

function fenKingSq(fen: string, color: 'w' | 'b'): string | null {
  const chess = new Chess(fen)
  const allSqs = chess.board().flat()
  const idx = allSqs.findIndex(sq => sq && sq.type === 'k' && sq.color === color)
  if (idx === -1) return null
  return 'abcdefgh'[idx % 8] + String(8 - Math.floor(idx / 8))
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ThinkingDots() {
  return (
    <span className="inline-flex gap-1 items-center ml-1">
      {[0, 1, 2].map((i) => (
        <motion.span key={i} className="w-1.5 h-1.5 rounded-full bg-accent"
          animate={{ opacity: [0.3, 1, 0.3], y: [0, -3, 0] }}
          transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.2 }} />
      ))}
    </span>
  )
}

function EvalBar({ evalCp, evalMate, loading, h }: {
  evalCp: number | null; evalMate: number | null; loading: boolean; h: number
}) {
  let whitePct = 50, label = '0.0'
  if (!loading) {
    if (evalMate !== null) {
      whitePct = evalMate > 0 ? 97 : 3
      label = `M${Math.abs(evalMate)}`
    } else if (evalCp !== null) {
      whitePct = Math.max(2, Math.min(98, 50 + 50 * Math.tanh(evalCp / 400)))
      const p = Math.abs(evalCp / 100)
      label = (evalCp >= 0 ? '+' : '') + (p >= 10 ? (evalCp > 0 ? '+' : '-') + '10' : (evalCp / 100).toFixed(1))
    }
  }
  const blackPct = 100 - whitePct
  return (
    <div className="flex flex-col items-center gap-1 flex-shrink-0">
      <div className="w-5 rounded overflow-hidden flex flex-col relative" style={{ height: h }}>
        <div className="w-full bg-bg-3 flex items-start justify-center transition-[flex] duration-500"
          style={{ flex: blackPct }}>
          {whitePct <= 30 && <span className="text-[9px] font-bold text-text-0 mt-1">{label}</span>}
        </div>
        <div className="w-full bg-[#E8E8F0] flex items-end justify-center transition-[flex] duration-500"
          style={{ flex: whitePct }}>
          {whitePct > 30 && <span className="text-[9px] font-bold text-bg-0 mb-1">{label}</span>}
        </div>
      </div>
      {loading && <div className="w-3 h-3 border border-accent border-t-transparent rounded-full animate-spin" />}
    </div>
  )
}

/** Compact clickable move-list (san pairs). currentIdx: index into moves array (-1 = start). */
function ClickMoveList({ moves, currentIdx, onNavigate, label, emptyText }: {
  moves: string[]; currentIdx: number; onNavigate: (idx: number) => void
  label?: string; emptyText?: string
}) {
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [currentIdx])

  if (moves.length === 0) {
    return <p className="text-xs text-text-2 italic px-1">{emptyText ?? 'No moves yet'}</p>
  }
  const pairs: { no: number; wi: number | null; bi: number | null }[] = []
  let i = 0
  while (i < moves.length) {
    pairs.push({ no: Math.floor(i / 2) + 1, wi: i, bi: i + 1 < moves.length ? i + 1 : null })
    i += 2
  }
  return (
    <div>
      {label && <p className="text-xs text-text-2 uppercase tracking-wider font-semibold mb-1.5">{label}</p>}
      <div className="font-mono text-xs max-h-48 overflow-y-auto space-y-0.5 pr-1">
        {pairs.map((p) => (
          <div key={p.no} className="flex items-stretch gap-0.5">
            <span className="text-text-2 w-6 flex-shrink-0 pt-0.5">{p.no}.</span>
            {[p.wi, p.bi].map((idx, j) => idx === null ? (
              <div key={j} className="flex-1" />
            ) : (
              <button key={j} onClick={() => onNavigate(idx)}
                className={`flex-1 text-left px-1.5 py-0.5 rounded transition-colors
                  ${currentIdx === idx ? 'bg-accent/25 text-accent font-semibold' : 'hover:bg-bg-2 text-text-0'}`}>
                {moves[idx]}
              </button>
            ))}
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  )
}

function ResignDialog({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
      className="rounded-lg border border-danger/30 bg-danger/10 p-4 space-y-3">
      <p className="text-sm text-text-0 font-medium">Resign this game?</p>
      <div className="flex gap-2">
        <button onClick={onConfirm}
          className="flex-1 py-1.5 rounded-md bg-danger/20 text-danger text-sm font-medium hover:bg-danger/30 transition-colors">
          Yes, resign
        </button>
        <button onClick={onCancel}
          className="flex-1 py-1.5 rounded-md bg-bg-2 text-text-1 text-sm hover:bg-bg-3 transition-colors">
          Cancel
        </button>
      </div>
    </motion.div>
  )
}

// ── ResultModal ───────────────────────────────────────────────────────────────

function ResultModal({ result, reason, userColor, onAnalyze, onPlayAgain, onDismiss }: {
  result: string; reason: string; userColor: 'white' | 'black'
  onAnalyze: () => void; onPlayAgain: () => void; onDismiss: () => void
}) {
  const label  = resultLabel(result, userColor)
  const sub    = resultSub(reason)
  const isWin  = label === 'You won!'
  const isDraw = result === '1/2-1/2'
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={onDismiss}>
      <motion.div initial={{ scale: 0.88, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 320, damping: 24 }}
        onClick={(e) => e.stopPropagation()}
        className="bg-bg-1 border border-border rounded-2xl p-8 max-w-xs w-full mx-4 shadow-2xl text-center space-y-5">
        <div>
          <p className={`text-3xl font-bold mb-1.5
            ${isDraw ? 'text-text-0' : isWin ? 'text-success' : 'text-danger'}`}>
            {label}
          </p>
          <p className="text-sm text-text-2 capitalize">{sub}</p>
        </div>
        <div className="flex flex-col gap-2">
          <button onClick={onAnalyze}
            className="btn-primary w-full flex items-center justify-center gap-2">
            <Microscope size={14} /> Analyze game
          </button>
          <button onClick={onPlayAgain} className="btn-ghost w-full">
            <RotateCcw size={13} className="inline mr-1.5" /> Play again
          </button>
          <button onClick={onDismiss}
            className="text-xs text-text-2 hover:text-text-1 transition-colors mt-1">
            View final position
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}

// ── SetupScreen ───────────────────────────────────────────────────────────────

function SetupScreen({ username, elo }: { username: string; elo: number | null }) {
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)

  async function startGame(color: 'white' | 'black' | 'random') {
    setCreating(true)
    try {
      const res = await fetch('/api/bot-game/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, user_color: color }),
      })
      if (!res.ok) throw new Error()
      const { game_id } = await res.json() as { game_id: string }
      navigate(`/bot-game/${game_id}`)
    } catch {
      setCreating(false)
    }
  }

  const colors = [
    { id: 'white' as const, label: 'White', icon: '♔', sub: 'You move first' },
    { id: 'random' as const, label: 'Random', icon: '⚄', sub: 'Surprise me' },
    { id: 'black' as const, label: 'Black', icon: '♚', sub: 'Maia moves first' },
  ]

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <SectionHeader
        icon={Bot}
        title="Play vs Maia"
        description={`Human-like AI opponent at ${(elo ?? 1500) + 50} ELO · pick a colour to start a fresh game`}
        right={<SectionHeaderStat label="Your rating" value={elo ? `${elo} ELO` : 'unknown'} />}
      />

      <div className="flex flex-col items-center justify-center min-h-[55vh] gap-8 mt-6">
        <div className="flex gap-4">
        {colors.map(({ id, label, icon, sub }) => (
          <motion.button key={id}
            whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
            disabled={creating}
            onClick={() => startGame(id)}
            className="w-36 py-6 flex flex-col items-center gap-2 rounded-xl border border-border
                       bg-bg-1 hover:border-accent/40 hover:bg-bg-2 transition-all disabled:opacity-50">
            <span className="text-3xl">{icon}</span>
            <span className="text-sm font-semibold text-text-0">{label}</span>
            <span className="text-xs text-text-2">{sub}</span>
          </motion.button>
        ))}
      </div>

      {creating && (
        <div className="flex items-center gap-2 text-sm text-text-2">
          <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          Creating game…
        </div>
      )}

        <button onClick={() => navigate('/dashboard')}
          className="btn-ghost flex items-center gap-1.5 text-sm">
          <ChevronLeft size={14} /> Back to dashboard
        </button>
      </div>
    </div>
  )
}

// ── AccuracyCard ──────────────────────────────────────────────────────────────

function AccuracyBar({ label, pct }: { label: string; pct: number | null }) {
  const v     = pct ?? 0
  const color = v >= 90 ? '#4ade80' : v >= 80 ? '#86efac' : v >= 70 ? '#facc15' : v >= 60 ? '#fb923c' : '#f87171'
  return (
    <div className="space-y-1">
      <div className="flex justify-between items-center">
        <span className="text-xs text-text-1 font-medium">{label}</span>
        {pct !== null
          ? <span className="text-xs font-bold tabular-nums" style={{ color }}>{pct.toFixed(1)}%</span>
          : <span className="text-xs text-text-2">—</span>}
      </div>
      <div className="h-1.5 bg-bg-3 rounded-full overflow-hidden">
        <motion.div className="h-full rounded-full" style={{ backgroundColor: color }}
          initial={{ width: 0 }} animate={{ width: `${v}%` }}
          transition={{ duration: 0.7, ease: 'easeOut' }} />
      </div>
    </div>
  )
}

function AccuracyCard({ moves, userColor }: { moves: string[]; userColor: 'white' | 'black' }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['botgame-accuracy', moves.join(',')],
    queryFn:  () => api.computeAccuracy(moves),
    enabled:  moves.length > 0,
    staleTime: Infinity,
    retry: false,
  })

  const whiteLabel = userColor === 'white' ? 'White (You)'  : 'White (Maia)'
  const blackLabel = userColor === 'black' ? 'Black (You)'  : 'Black (Maia)'

  return (
    <div className="card p-3 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-text-2 uppercase tracking-wider font-semibold">Accuracy</p>
        {isLoading && (
          <div className="flex items-center gap-1.5 text-xs text-text-2">
            <div className="w-3 h-3 border border-accent border-t-transparent rounded-full animate-spin" />
            Computing…
          </div>
        )}
      </div>
      {isError ? (
        <p className="text-xs text-danger">Could not compute accuracy</p>
      ) : (
        <>
          <AccuracyBar label={whiteLabel} pct={data?.white_accuracy ?? null} />
          <AccuracyBar label={blackLabel} pct={data?.black_accuracy ?? null} />
        </>
      )}
    </div>
  )
}

// ── AnalyzeView ───────────────────────────────────────────────────────────────

const ANALYZE_BOARD = 480

function AnalyzeView({ gameFens, gameSans, gameUci, userColor, onBack }: {
  gameFens: string[]; gameSans: string[]; gameUci: string[]
  userColor: 'white' | 'black'; onBack: () => void
}) {
  const [tab, setTab] = useState<'game' | 'explore'>('game')

  // ── Game tab state ────────────────────────────────────────────────────────
  // gameViewIdx: 0 = start pos, k = after k-th move
  const [gameViewIdx, setGameViewIdx] = useState(gameFens.length - 1)  // start at end

  // ── Explore tab state ─────────────────────────────────────────────────────
  // exploreBranchIdx: index into gameFens[] we branched from (0 = start)
  const [exploreBranchIdx, setExploreBranchIdx]   = useState(0)
  const [exploreUci,        setExploreUci]         = useState<string[]>([])
  const [exploreSan,        setExploreSan]         = useState<string[]>([])
  const [exploreViewIdx,    setExploreViewIdx]     = useState(-1)  // -1 = at branch point
  const exploreChessRef                            = useRef(new Chess())

  // Board interaction (shared between tabs)
  const [selectedSq,  setSelectedSq]  = useState<Square | null>(null)
  const [optionSqs,   setOptionSqs]   = useState<Record<string, object>>({})
  const [lastMoveSqs, setLastMoveSqs] = useState<Record<string, object>>({})

  // ── Current display FEN ───────────────────────────────────────────────────
  const displayFen = useMemo(() => {
    if (tab === 'game') return gameFens[gameViewIdx] ?? gameFens[0]
    // Explore: reconstruct from branch + explore moves up to viewIdx
    const base = gameFens[exploreBranchIdx] ?? gameFens[0]
    if (exploreViewIdx === -1) return base
    const chess = new Chess(base)
    const limit = exploreViewIdx + 1
    for (let i = 0; i < limit && i < exploreUci.length; i++) {
      const { from, to, promo } = uciToFrom(exploreUci[i])
      try { chess.move({ from, to, promotion: promo ?? 'q' }) } catch { break }
    }
    return chess.fen()
  }, [tab, gameViewIdx, exploreBranchIdx, exploreViewIdx, exploreUci, gameFens])

  // ── Last move highlight ───────────────────────────────────────────────────
  const lastMoveUci = useMemo(() => {
    if (tab === 'game') {
      if (gameViewIdx === 0) return null
      // reconstruct UCI from prev FEN → current FEN: we stored san, not uci
      // so just highlight nothing (we don't have UCI per se, use san)
      return null
    }
    if (exploreViewIdx >= 0 && exploreViewIdx < exploreUci.length) {
      return exploreUci[exploreViewIdx]
    }
    return null
  }, [tab, gameViewIdx, exploreViewIdx, exploreUci])

  useEffect(() => {
    if (!lastMoveUci) { setLastMoveSqs({}); return }
    setLastMoveSqs({
      [lastMoveUci.slice(0, 2)]: { backgroundColor: 'rgba(123,97,255,0.22)' },
      [lastMoveUci.slice(2, 4)]: { backgroundColor: 'rgba(123,97,255,0.32)' },
    })
  }, [lastMoveUci])

  // Check highlight
  const checkSq = useMemo(() => {
    try {
      const chess = new Chess(displayFen)
      if (!chess.isCheck()) return null
      return fenKingSq(displayFen, chess.turn())
    } catch { return null }
  }, [displayFen])

  // ── Stockfish analysis ────────────────────────────────────────────────────
  const { data: analysis, isFetching: analysisLoading } = useQuery({
    queryKey: ['bot-analysis', displayFen],
    queryFn: () => fetch(`/api/analyse?fen=${encodeURIComponent(displayFen)}&depth=14`).then(r => r.json()) as
      Promise<{ best_move: string | null; eval_cp: number | null; eval_mate: number | null }>,
    staleTime: Infinity,
    retry: false,
  })

  const bestArrow: Arrow[] = useMemo(() => {
    const bm = analysis?.best_move
    if (!bm || bm.length < 4) return []
    return [[bm.slice(0, 2) as Square, bm.slice(2, 4) as Square, '#7B61FF']]
  }, [analysis?.best_move])

  // ── Square styles ─────────────────────────────────────────────────────────
  const squareStyles = useMemo(() => {
    const s: Record<string, object> = { ...lastMoveSqs, ...optionSqs }
    if (checkSq) s[checkSq] = { ...s[checkSq], backgroundColor: 'rgba(239,68,68,0.4)' }
    return s
  }, [lastMoveSqs, optionSqs, checkSq])

  // ── Is explore board interactive? ─────────────────────────────────────────
  // Interactive only when at the end of the current explore line
  const exploreInteractive = tab === 'explore' && exploreViewIdx === exploreUci.length - 1

  // ── Game tab navigation ───────────────────────────────────────────────────
  function goToGamePos(idx: number) {
    setGameViewIdx(Math.max(0, Math.min(gameFens.length - 1, idx)))
    setSelectedSq(null); setOptionSqs({})
  }
  function handleGameMoveClick(moveIdx: number) {
    // moveIdx is the index in gameSans — position after that move = gameFens[moveIdx+1]
    goToGamePos(moveIdx + 1)
  }

  // ── Explore tab: set branch from game move ─────────────────────────────────
  function setExploreBranch(gameIdx: number) {
    // gameIdx: 0 = start, k = after k-th game move
    const clampedIdx = Math.max(0, Math.min(gameFens.length - 1, gameIdx))
    setExploreBranchIdx(clampedIdx)
    exploreChessRef.current = new Chess(gameFens[clampedIdx] ?? gameFens[0])
    setExploreUci([])
    setExploreSan([])
    setExploreViewIdx(-1)
    setSelectedSq(null); setOptionSqs({})
  }

  function handleExploreMoveClick(moveIdx: number) {
    // Navigate within explore branch (-1 = branch, 0..N-1)
    setExploreViewIdx(moveIdx)
    setSelectedSq(null); setOptionSqs({})
  }

  // ── Explore board interaction ─────────────────────────────────────────────
  function handleExploreDrop(from: string, to: string): boolean {
    if (!exploreInteractive) return false
    return tryExploreMove(from, to)
  }

  function handleExploreSquareClick(sq: Square) {
    if (!exploreInteractive) return
    if (selectedSq && optionSqs[sq] !== undefined) {
      tryExploreMove(selectedSq, sq)
      return
    }
    const chess = exploreChessRef.current
    const piece = chess.get(sq)
    if (piece && piece.color === chess.turn()) {
      setSelectedSq(sq); setOptionSqs(getMoveOptions(chess, sq))
    } else {
      setSelectedSq(null); setOptionSqs({})
    }
  }

  function tryExploreMove(from: string, to: string): boolean {
    const chess = exploreChessRef.current
    const isPawnPromo = (() => {
      const p = chess.get(from as Square)
      if (!p || p.type !== 'p') return false
      return (p.color === 'w' && to[1] === '8') || (p.color === 'b' && to[1] === '1')
    })()
    try {
      const result = chess.move({ from, to, promotion: isPawnPromo ? 'q' : undefined })
      if (!result) return false
      const uci = from + to + (isPawnPromo ? 'q' : '')
      setExploreUci(prev => [...prev, uci])
      setExploreSan(prev => [...prev, result.san])
      setExploreViewIdx(exploreUci.length)  // now at the new last move
      setSelectedSq(null); setOptionSqs({})
      return true
    } catch { return false }
  }

  // keyboard navigation
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (tab === 'game') {
        if (e.key === 'ArrowLeft')  goToGamePos(gameViewIdx - 1)
        if (e.key === 'ArrowRight') goToGamePos(gameViewIdx + 1)
      } else {
        const cur = exploreViewIdx
        if (e.key === 'ArrowLeft') {
          setExploreViewIdx(Math.max(-1, cur - 1))
          setSelectedSq(null); setOptionSqs({})
        }
        if (e.key === 'ArrowRight') {
          setExploreViewIdx(Math.min(exploreUci.length - 1, cur + 1))
          setSelectedSq(null); setOptionSqs({})
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, gameViewIdx, exploreViewIdx, exploreUci.length, gameFens.length])

  const gameMoveCurrentIdx = tab === 'game' ? gameViewIdx - 1 : exploreBranchIdx - 1

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button onClick={onBack} className="btn-ghost flex items-center gap-1.5 text-sm">
          <ChevronLeft size={14} /> Back to game
        </button>
        <div className="h-4 w-px bg-border" />
        <h1 className="text-lg font-bold text-text-0">Game Analysis</h1>
        <span className="text-xs text-text-2 ml-1">{gameSans.length} moves</span>
        <span className="text-xs text-text-2 ml-auto hidden sm:block">← → to navigate</span>
      </div>

      <div className="flex items-start gap-4">
        {/* Eval bar */}
        <EvalBar
          evalCp={analysis?.eval_cp ?? null}
          evalMate={analysis?.eval_mate ?? null}
          loading={analysisLoading}
          h={ANALYZE_BOARD}
        />

        {/* Board */}
        <div className="flex-shrink-0">
          <Chessboard
            position={displayFen}
            boardOrientation={userColor}
            onPieceDrop={handleExploreDrop}
            onSquareClick={tab === 'explore' ? handleExploreSquareClick : undefined}
            arePiecesDraggable={exploreInteractive}
            boardWidth={ANALYZE_BOARD}
            customSquareStyles={squareStyles}
            customArrows={bestArrow}
            customDarkSquareStyle={{ backgroundColor: '#1A1D36' }}
            customLightSquareStyle={{ backgroundColor: '#343761' }}
            customBoardStyle={{ borderRadius: '6px', boxShadow: '0 0 0 1px rgba(123,97,255,0.15)' }}
          />
          {/* Nav arrows */}
          <div className="flex gap-2 mt-2 justify-center">
            <button
              onClick={() => tab === 'game' ? goToGamePos(gameViewIdx - 1)
                : setExploreViewIdx(v => Math.max(-1, v - 1))}
              className="p-1.5 rounded hover:bg-bg-2 disabled:opacity-30 transition-colors"
              disabled={tab === 'game' ? gameViewIdx === 0 : exploreViewIdx === -1}>
              <ChevronLeft size={16} className="text-text-1" />
            </button>
            <button
              onClick={() => tab === 'game' ? goToGamePos(gameViewIdx + 1)
                : setExploreViewIdx(v => Math.min(exploreUci.length - 1, v + 1))}
              className="p-1.5 rounded hover:bg-bg-2 disabled:opacity-30 transition-colors"
              disabled={tab === 'game'
                ? gameViewIdx === gameFens.length - 1
                : exploreViewIdx === exploreUci.length - 1}>
              <ChevronRight size={16} className="text-text-1" />
            </button>
          </div>
        </div>

        {/* Right panel */}
        <div className="flex-1 min-w-0 space-y-3" style={{ paddingTop: 4 }}>

          {/* Accuracy — computed once for the full game */}
          <AccuracyCard moves={gameUci} userColor={userColor} />

          {/* Eval */}
          <div className="card p-3 flex items-center justify-between">
            <span className="text-xs text-text-2">Evaluation</span>
            {analysisLoading ? (
              <span className="text-xs text-text-2">…</span>
            ) : analysis?.eval_mate != null ? (
              <span className="text-sm font-bold text-accent">M{Math.abs(analysis.eval_mate)}</span>
            ) : analysis?.eval_cp != null ? (
              <span className={`text-sm font-bold ${analysis.eval_cp >= 0 ? 'text-text-0' : 'text-text-2'}`}>
                {analysis.eval_cp >= 0 ? '+' : ''}{(analysis.eval_cp / 100).toFixed(2)}
              </span>
            ) : <span className="text-xs text-text-2">—</span>}
          </div>

          {/* Best move */}
          {analysis?.best_move && (
            <div className="card p-3 flex items-center justify-between">
              <span className="text-xs text-text-2">Best move</span>
              <span className="font-mono text-xs text-accent font-semibold">
                {analysis.best_move.slice(0, 2)} → {analysis.best_move.slice(2, 4)}
                {analysis.best_move[4] ? `=${analysis.best_move[4].toUpperCase()}` : ''}
              </span>
            </div>
          )}

          {/* Tab switcher */}
          <div className="flex rounded-lg border border-border overflow-hidden">
            {(['game', 'explore'] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)}
                className={`flex-1 py-2 text-xs font-semibold transition-colors capitalize
                  ${tab === t ? 'bg-accent/15 text-accent' : 'text-text-2 hover:text-text-1 hover:bg-bg-2'}`}>
                {t === 'game' ? 'Moves Played' : 'Explore'}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="card p-3 space-y-3">
            {tab === 'game' ? (
              <>
                <p className="text-xs text-text-2">Click a move to navigate. Board is read-only.</p>
                <ClickMoveList
                  moves={gameSans}
                  currentIdx={gameViewIdx - 1}
                  onNavigate={handleGameMoveClick}
                  emptyText="No moves in this game"
                />
                {gameViewIdx === 0 && (
                  <p className="text-xs text-accent">Starting position</p>
                )}
              </>
            ) : (
              <>
                {/* Game moves up to branch */}
                <div>
                  <p className="text-xs text-text-2 mb-1">
                    Click any move to set branch point
                    <span className="text-accent ml-1">(move {exploreBranchIdx})</span>
                  </p>
                  <ClickMoveList
                    moves={gameSans}
                    currentIdx={gameMoveCurrentIdx}
                    onNavigate={(idx) => setExploreBranch(idx + 1)}
                    emptyText="No game moves"
                  />
                </div>

                {/* Explore branch */}
                {exploreSan.length > 0 ? (
                  <div className="border-t border-border pt-2">
                    <ClickMoveList
                      moves={exploreSan}
                      currentIdx={exploreViewIdx}
                      onNavigate={handleExploreMoveClick}
                      label="Your exploration"
                    />
                  </div>
                ) : (
                  <p className="text-xs text-text-2 border-t border-border pt-2">
                    {exploreInteractive
                      ? 'Play a move on the board to explore…'
                      : 'Navigate to a position to explore from'}
                  </p>
                )}

                {/* Explore status */}
                {exploreViewIdx < exploreUci.length - 1 && exploreUci.length > 0 && (
                  <p className="text-xs text-text-2">
                    Viewing move {exploreViewIdx + 1}/{exploreUci.length} — navigate to end to play
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Main BotGame component ────────────────────────────────────────────────────

const BOARD_SIZE  = 500
const START_FEN   = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

export default function BotGame() {
  const { gameId }         = useParams<{ gameId?: string }>()
  const navigate           = useNavigate()
  const { username, elo }  = useUserStore()

  const [phase, setPhase] = useState<Phase>(gameId ? 'game' : 'setup')

  // ── Game state ──────────────────────────────────────────────────────────────
  const chessRef   = useRef(new Chess())
  const uciHistRef = useRef<string[]>([])   // for analyze mode

  const [fen,        setFen]        = useState(START_FEN)
  const [userColor,  setUserColor]  = useState<'white' | 'black'>('white')
  const [targetElo,  setTargetElo]  = useState(1550)
  const [gameStatus, setGameStatus] = useState<GameStatus>('connecting')
  const [connStatus, setConnStatus] = useState<ConnStatus>('connecting')
  const [isThinking, setIsThinking] = useState(false)
  const [gameResult, setGameResult] = useState<string | null>(null)
  const [gameReason, setGameReason] = useState<string | null>(null)
  const [sanMoves,   setSanMoves]   = useState<string[]>([])
  const [showResult, setShowResult] = useState(false)

  // History view (null = live pos, number = index after that move)
  const [histViewIdx, setHistViewIdx] = useState<number | null>(null)
  const [histFens,    setHistFens]    = useState<string[]>([START_FEN])

  // Board interaction
  const [selectedSq,  setSelectedSq]  = useState<Square | null>(null)
  const [optionSqs,   setOptionSqs]   = useState<Record<string, object>>({})
  const [lastMoveSqs, setLastMoveSqs] = useState<Record<string, object>>({})
  const [checkSq,     setCheckSq]     = useState<string | null>(null)

  const [showResign,   setShowResign]   = useState(false)
  const [reconnectNum, setReconnectNum] = useState(0)
  const [reconnBanner, setReconnBanner] = useState(false)

  const wsRef          = useRef<WebSocket | null>(null)
  const reconnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const userColorRef   = useRef<'white' | 'black'>('white')

  useEffect(() => { userColorRef.current = userColor }, [userColor])

  // ── Computed FEN to display (live or historical view) ─────────────────────
  const displayFen = histViewIdx !== null ? (histFens[histViewIdx + 1] ?? START_FEN) : fen

  // ── Update board after applying a move ────────────────────────────────────
  const commitMove = useCallback((newFen: string, uci: string) => {
    setFen(newFen)
    setHistFens(prev => [...prev, newFen])
    setLastMoveSqs({
      [uci.slice(0, 2)]: { backgroundColor: 'rgba(123,97,255,0.22)' },
      [uci.slice(2, 4)]: { backgroundColor: 'rgba(123,97,255,0.32)' },
    })
    try {
      const chess = new Chess(newFen)
      if (chess.isCheck()) {
        setCheckSq(fenKingSq(newFen, chess.turn()))
      } else {
        setCheckSq(null)
      }
    } catch { setCheckSq(null) }
    setSelectedSq(null); setOptionSqs({})
  }, [])

  // ── WebSocket message handler ─────────────────────────────────────────────
  const handleMessage = useCallback((evt: MessageEvent) => {
    let msg: WsMsg
    try { msg = JSON.parse(evt.data) } catch { return }
    switch (msg.type) {
      case 'game_start': {
        chessRef.current = new Chess()
        uciHistRef.current = []
        setUserColor(msg.user_color)
        setTargetElo(msg.target_elo)
        setFen(START_FEN)
        setHistFens([START_FEN])
        setSanMoves([])
        setLastMoveSqs({}); setCheckSq(null)
        setGameStatus('active')
        setGameResult(null); setGameReason(null)
        setIsThinking(false); setHistViewIdx(null)
        setPhase('game')
        break
      }
      case 'move_made': {
        const { from, to, promo } = uciToFrom(msg.move)
        let san: string | null = null
        try {
          const r = chessRef.current.move({ from, to, promotion: promo ?? 'q' })
          san = r?.san ?? null
        } catch { /* ignore */ }
        if (san) setSanMoves(prev => [...prev, san!])
        uciHistRef.current.push(msg.move)
        commitMove(msg.fen, msg.move)
        if (msg.by === 'bot') setIsThinking(false)
        break
      }
      case 'thinking':    setIsThinking(true); break
      case 'game_over': {
        setGameStatus('finished')
        setGameResult(msg.result)
        setGameReason(msg.reason)
        setIsThinking(false)
        setTimeout(() => setShowResult(true), 600)
        break
      }
      case 'error': console.warn('[BotGame]', msg.message); break
    }
  }, [commitMove])

  // ── WebSocket connect / reconnect ─────────────────────────────────────────
  const connect = useCallback((gid: string) => {
    if (wsRef.current) {
      wsRef.current.onmessage = null; wsRef.current.onclose = null; wsRef.current.onerror = null
      wsRef.current.close()
    }
    setConnStatus('connecting')
    const ws = new WebSocket(`ws://localhost:8000/ws/bot-game/${gid}`)
    wsRef.current = ws
    ws.onopen    = () => { setConnStatus('connected'); setReconnBanner(false); setReconnectNum(0) }
    ws.onmessage = handleMessage
    ws.onerror   = () => { /* onclose fires after onerror */ }
    ws.onclose   = (e) => {
      if (e.code === 4004) { navigate('/bot-game'); return }
      setConnStatus('disconnected'); setReconnBanner(true)
      setReconnectNum(n => {
        const next = n + 1
        if (next <= 5) reconnTimerRef.current = setTimeout(() => connect(gid), 3000)
        return next
      })
    }
  }, [handleMessage, navigate])

  useEffect(() => {
    if (!gameId) { setPhase('setup'); return }
    setPhase('game')
    connect(gameId)
    return () => {
      if (reconnTimerRef.current) clearTimeout(reconnTimerRef.current)
      if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close() }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId])

  // ── User move ─────────────────────────────────────────────────────────────
  const sendMove = useCallback((uci: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN)
      wsRef.current.send(JSON.stringify({ type: 'move', move: uci }))
  }, [])

  const isMyTurn = useCallback(() => {
    if (gameStatus !== 'active' || isThinking || histViewIdx !== null) return false
    return (chessRef.current.turn() === 'w') === (userColorRef.current === 'white')
  }, [gameStatus, isThinking, histViewIdx])

  // ── Board interaction ─────────────────────────────────────────────────────
  function handleDrop(from: string, to: string): boolean {
    if (!isMyTurn()) return false
    const p = chessRef.current.get(from as Square)
    const isPawnPromo = p?.type === 'p'
      && ((p.color === 'w' && to[1] === '8') || (p.color === 'b' && to[1] === '1'))
    const uci = from + to + (isPawnPromo ? 'q' : '')
    if (!chessRef.current.moves({ verbose: true }).some(m => m.from === from && m.to === to)) return false
    sendMove(uci)
    return false
  }

  function handleSquareClick(sq: Square) {
    if (!isMyTurn()) return
    if (selectedSq && optionSqs[sq] !== undefined) {
      const p = chessRef.current.get(selectedSq)
      const isPawnPromo = p?.type === 'p'
        && ((p.color === 'w' && sq[1] === '8') || (p.color === 'b' && sq[1] === '1'))
      sendMove(selectedSq + sq + (isPawnPromo ? 'q' : ''))
      setSelectedSq(null); setOptionSqs({})
      return
    }
    const piece = chessRef.current.get(sq)
    if (piece && piece.color === chessRef.current.turn()) {
      setSelectedSq(sq); setOptionSqs(getMoveOptions(chessRef.current, sq))
    } else {
      setSelectedSq(null); setOptionSqs({})
    }
  }

  // ── History navigation ────────────────────────────────────────────────────
  function handleHistMoveClick(moveIdx: number) {
    // moveIdx = index in sanMoves; go to position AFTER that move
    setHistViewIdx(moveIdx)
    setSelectedSq(null); setOptionSqs({})
  }

  function returnToLive() {
    setHistViewIdx(null)
    setSelectedSq(null); setOptionSqs({})
  }

  // ── Resign ────────────────────────────────────────────────────────────────
  function handleResign() {
    if (wsRef.current?.readyState === WebSocket.OPEN)
      wsRef.current.send(JSON.stringify({ type: 'resign' }))
    setShowResign(false)
  }

  // ── Enter analyze mode ────────────────────────────────────────────────────
  function enterAnalyze() {
    setShowResult(false)
    setPhase('analyze')
  }

  // ── Play again ────────────────────────────────────────────────────────────
  function handlePlayAgain() {
    setShowResult(false)
    navigate('/bot-game')
  }

  // ── Square styles ─────────────────────────────────────────────────────────
  const liveSquareStyles = useMemo(() => {
    const s: Record<string, object> = histViewIdx !== null ? {} : { ...lastMoveSqs, ...optionSqs }
    if (checkSq && histViewIdx === null) s[checkSq] = { ...s[checkSq], backgroundColor: 'rgba(239,68,68,0.4)' }
    return s
  }, [lastMoveSqs, optionSqs, checkSq, histViewIdx])

  // ── Guard: setup screen ───────────────────────────────────────────────────
  if (phase === 'setup') return <SetupScreen username={username} elo={elo ?? null} />

  // ── Guard: analyze mode ───────────────────────────────────────────────────
  if (phase === 'analyze') {
    const uciSnapshot         = [...uciHistRef.current]
    const { fens, sans }      = buildGamePositions(uciSnapshot)
    return (
      <AnalyzeView
        gameFens={fens}
        gameSans={sans}
        gameUci={uciSnapshot}
        userColor={userColor}
        onBack={() => setPhase('game')}
      />
    )
  }

  // ── Game phase ────────────────────────────────────────────────────────────
  const myTurn  = isMyTurn()
  const botName = `Maia · ${targetElo}`

  // Which move index is "current" for the history list highlight
  const histCurrentIdx = histViewIdx !== null ? histViewIdx : sanMoves.length - 1

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Result modal */}
      <AnimatePresence>
        {showResult && gameResult && gameReason && (
          <ResultModal
            result={gameResult} reason={gameReason} userColor={userColor}
            onAnalyze={enterAnalyze}
            onPlayAgain={handlePlayAgain}
            onDismiss={() => setShowResult(false)}
          />
        )}
      </AnimatePresence>

      <SectionHeader
        icon={Bot}
        title="Play vs Maia"
        description={`Human-like AI tuned to ${targetElo} ELO · drag pieces to move · press Analyse after the game`}
        right={
          <div className="flex items-center gap-1.5">
            {connStatus === 'connected'
              ? <Wifi size={13} className="text-success" />
              : <WifiOff size={13} className="text-danger animate-pulse" />}
            <span className="text-xs text-text-2">
              {connStatus === 'connected' ? 'Connected'
                : connStatus === 'connecting' ? 'Connecting…'
                : `Reconnecting (${reconnectNum}/5)…`}
            </span>
          </div>
        }
      />

      <AnimatePresence>
        {reconnBanner && connStatus !== 'connected' && (
          <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="mb-4 px-4 py-2 bg-danger/10 border border-danger/30 rounded-lg text-sm text-danger">
            Connection lost — reconnecting…
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex items-start gap-6">
        {/* Board section */}
        <div className="flex-shrink-0 space-y-2">
          {/* Top player */}
          <div className="flex items-center gap-2 px-1">
            <Bot size={15} className="text-text-2 flex-shrink-0" />
            <span className="text-sm font-medium text-text-0">{botName}</span>
            {isThinking && (
              <span className="flex items-center gap-1 text-xs text-accent ml-auto">
                thinking <ThinkingDots />
              </span>
            )}
          </div>

          {/* History view banner */}
          <AnimatePresence>
            {histViewIdx !== null && (
              <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                className="flex items-center gap-2 px-3 py-1.5 bg-accent/10 border border-accent/20 rounded-md text-xs">
                <Circle size={7} className="text-accent fill-accent flex-shrink-0" />
                <span className="text-accent">Viewing move {histViewIdx + 1}</span>
                <button onClick={returnToLive}
                  className="ml-auto text-accent underline hover:no-underline">
                  Back to live
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          <motion.div
            animate={gameStatus === 'active' && myTurn && histViewIdx === null
              ? { boxShadow: '0 0 0 2px rgba(123,97,255,0.4)' }
              : { boxShadow: '0 0 0 0px transparent' }}
            transition={{ duration: 0.3 }} style={{ borderRadius: 8 }}>
            <Chessboard
              position={displayFen}
              boardOrientation={userColor}
              onPieceDrop={handleDrop}
              onSquareClick={handleSquareClick}
              arePiecesDraggable={myTurn && histViewIdx === null}
              boardWidth={BOARD_SIZE}
              customSquareStyles={liveSquareStyles}
              customDarkSquareStyle={{ backgroundColor: '#1A1D36' }}
              customLightSquareStyle={{ backgroundColor: '#343761' }}
              customBoardStyle={{ borderRadius: '6px', boxShadow: '0 0 0 1px rgba(123,97,255,0.15)' }}
            />
          </motion.div>

          {/* Bottom player */}
          <div className="flex items-center gap-2 px-1">
            <User size={15} className="text-accent flex-shrink-0" />
            <span className="text-sm font-medium text-text-0">{username} · {elo ?? '?'}</span>
            {myTurn && histViewIdx === null && (
              <span className="ml-auto text-xs text-success font-medium">Your turn</span>
            )}
          </div>
        </div>

        {/* Right panel */}
        <div className="flex-1 min-w-0 space-y-4" style={{ paddingTop: 32 }}>

          {/* Post-game actions (shown after modal is dismissed) */}
          {gameStatus === 'finished' && !showResult && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              className="flex gap-2 flex-wrap">
              <button onClick={enterAnalyze}
                className="btn-primary flex items-center gap-1.5 text-sm">
                <Microscope size={14} /> Analyze game
              </button>
              <button onClick={handlePlayAgain}
                className="btn-ghost flex items-center gap-1.5 text-sm">
                <RotateCcw size={13} /> Play again
              </button>
            </motion.div>
          )}

          {/* Resign */}
          <AnimatePresence>
            {showResign && (
              <ResignDialog onConfirm={handleResign} onCancel={() => setShowResign(false)} />
            )}
          </AnimatePresence>
          {gameStatus === 'active' && !showResign && (
            <button onClick={() => setShowResign(true)}
              className="flex items-center gap-1.5 text-sm text-text-2 hover:text-danger transition-colors">
              <Flag size={13} /> Resign
            </button>
          )}

          {/* Clickable move history */}
          <div className="card p-4">
            <p className="text-xs text-text-2 uppercase tracking-wider font-semibold mb-3">
              Moves played
              <span className="ml-2 font-normal normal-case">
                {sanMoves.length > 0 ? '— click to view' : ''}
              </span>
            </p>
            <ClickMoveList
              moves={sanMoves}
              currentIdx={histCurrentIdx}
              onNavigate={handleHistMoveClick}
              emptyText="Game not started"
            />
          </div>

          {/* Game info */}
          <div className="card p-4 space-y-2">
            <p className="text-xs text-text-2 uppercase tracking-wider font-semibold mb-1">Game info</p>
            {[
              ['You play', userColor, 'capitalize'],
              ['Maia ELO', targetElo, ''],
              ['Your ELO', elo ?? '?', ''],
              ['Moves', sanMoves.length, ''],
            ].map(([k, v, cls]) => (
              <div key={String(k)} className="flex justify-between text-xs">
                <span className="text-text-2">{k}</span>
                <span className={`text-text-0 font-medium ${cls}`}>{String(v)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
