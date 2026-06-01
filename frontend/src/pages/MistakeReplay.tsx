import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Chess } from 'chess.js'
import { Chessboard } from 'react-chessboard'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ChevronLeft, ChevronRight, ArrowLeft, Zap, Lightbulb, Sparkles, Loader2, X,
  RotateCcw, Undo2,
} from 'lucide-react'
import type { Square } from 'chess.js'
import type { Arrow } from 'react-chessboard/dist/chessboard/types'
import { useUserStore } from '../store/userStore'
import { api } from '../api'
import { replayApi, type ReplayMistake } from '../api/replay'

const BOARD = 440

function fmtDate(unix: number | null): string {
  if (!unix) return ''
  const d = new Date(unix * 1000)
  const days = Math.round((Date.now() - d.getTime()) / 86_400_000)
  if (days <= 0)  return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30)  return `${days} days ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// ── Eval bar (mirror of AnalysisBoard, oriented to the solver) ───────────────
function EvalBar({ cp, mate, orient, h, loading }: {
  cp: number | null; mate: number | null; orient: 'white' | 'black'; h: number; loading?: boolean
}) {
  let whitePct = 50
  let label = '0.0'
  if (mate !== null) {
    whitePct = mate > 0 ? 98 : 2
    label = `M${Math.abs(mate)}`
  } else if (cp !== null) {
    whitePct = Math.max(3, Math.min(97, 50 + 50 * Math.tanh(cp / 400)))
    label = (cp >= 0 ? '+' : '') + (cp / 100).toFixed(1)
  }
  const flexDir = orient === 'black' ? 'column' : 'column-reverse'
  return (
    <div className="flex flex-col items-center flex-shrink-0" style={{ height: h }}>
      <div className={`w-5 rounded overflow-hidden flex relative ${loading ? 'opacity-60' : ''}`}
        style={{ height: h, flexDirection: flexDir }}>
        <div className="bg-[#E8E8F0] flex items-end justify-center transition-[flex] duration-500"
          style={{ flex: whitePct }}>
          {whitePct > 50 && <span className="text-[8px] font-bold text-bg-0 mb-1">{label}</span>}
        </div>
        <div className="bg-bg-3 flex items-start justify-center transition-[flex] duration-500"
          style={{ flex: 100 - whitePct }}>
          {whitePct <= 50 && <span className="text-[8px] font-bold text-text-0 mt-1">{label}</span>}
        </div>
        {loading && (
          <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 flex justify-center">
            <Loader2 size={10} className="animate-spin text-accent" />
          </div>
        )}
      </div>
    </div>
  )
}

interface AnalysisResult { best_move: string | null; eval_cp: number | null; eval_mate: number | null }

export default function MistakeReplay() {
  const { clusterId } = useParams<{ clusterId: string }>()
  const { username, elo } = useUserStore()
  const navigate = useNavigate()

  const [idx, setIdx]   = useState(0)
  const [done, setDone] = useState(false)

  // "Why" explanation
  const [showWhy, setShowWhy]       = useState(false)
  const [why, setWhy]               = useState<string | null>(null)
  const [whyLoading, setWhyLoading] = useState(false)

  const { data, isLoading, isError } = useQuery({
    queryKey: ['cluster-mistakes', username, clusterId],
    queryFn:  () => replayApi.getMistakes(username, clusterId!),
    enabled:  !!username && !!clusterId,
  })
  const { data: profile } = useQuery({
    queryKey: ['profile', username],
    queryFn:  () => api.getProfile(username),
    enabled:  !!username,
  })

  const mistakes = useMemo(() => data?.mistakes ?? [], [data])
  const total    = mistakes.length
  const current: ReplayMistake | undefined = mistakes[idx]

  const label = (() => {
    const c = profile?.clusters?.find((c: any) => String(c.cluster_id) === String(clusterId))
    return c?.label ?? (data ? `Cluster #${data.cluster_rank}` : 'Cluster')
  })()

  // ── Exploration state — fresh Chess per position, replay user moves ─────────
  const chessRef = useRef(new Chess())
  const [boardFen, setBoardFen]   = useState<string>('')
  const [exploreSans, setExplore] = useState<string[]>([])  // moves played while exploring
  const [selectedSq, setSelectedSq] = useState<Square | null>(null)
  const [optionSqs, setOptionSqs]   = useState<Record<string, object>>({})
  const exploring = exploreSans.length > 0

  // Reset board whenever the position index changes
  useEffect(() => {
    if (!current) return
    chessRef.current = new Chess(current.fen)
    setBoardFen(current.fen)
    setExplore([])
    setSelectedSq(null); setOptionSqs({})
    setShowWhy(false); setWhy(null)
  }, [idx, current?.fen])

  // ── Per-position "Notice" — unique per FEN, persists for the whole position ─
  const { data: noteData, isFetching: noteLoading } = useQuery({
    queryKey: ['position-note', current?.fen],
    queryFn:  () => replayApi.getNote({
      fen: current!.fen, played: current!.move_played_san,
      best: current!.best_move, threat_type: current!.threat_type,
    }),
    enabled:  !!current,
    staleTime: Infinity,
  })

  // ── Live eval of the board (updates as you explore) ─────────────────────────
  const { data: analysis, isFetching: evalLoading } = useQuery<AnalysisResult>({
    queryKey: ['replay-eval', boardFen],
    queryFn:  () => fetch(`/api/analyse?fen=${encodeURIComponent(boardFen)}&depth=14`).then(r => r.json()),
    enabled:  !!boardFen,
    staleTime: Infinity,
  })

  const go = useCallback((delta: number) => {
    setIdx(i => {
      const next = i + delta
      if (next < 0) return 0
      if (next >= total) { setDone(true); return i }
      return next
    })
  }, [total])

  // Arrow keys: ← / → navigate positions (only when not mid-explore-typing)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'ArrowLeft')  { e.preventDefault(); go(-1) }
      if (e.key === 'ArrowRight') { e.preventDefault(); go(1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go])

  async function loadWhy() {
    if (!current) return
    setShowWhy(true)
    if (why) return
    setWhyLoading(true)
    try {
      const r = await replayApi.explain({
        fen: current.fen, played: current.move_played_san,
        best: current.best_move, threat_type: current.threat_type, user_elo: elo,
      })
      setWhy(r.explanation)
    } catch {
      setWhy('Could not load an explanation right now.')
    } finally {
      setWhyLoading(false)
    }
  }

  // ── Board interaction (free exploration) ────────────────────────────────────
  function applyMove(from: Square, to: Square): boolean {
    try {
      const mv = chessRef.current.move({ from, to, promotion: 'q' })
      if (!mv) return false
      setBoardFen(chessRef.current.fen())
      setExplore(s => [...s, mv.san])
      setSelectedSq(null); setOptionSqs({})
      return true
    } catch { return false }
  }
  function onDrop(from: string, to: string) { return applyMove(from as Square, to as Square) }
  function onSquareClick(sq: Square) {
    if (selectedSq && optionSqs[sq] !== undefined) { applyMove(selectedSq, sq); return }
    const piece = chessRef.current.get(sq)
    if (piece && piece.color === chessRef.current.turn()) {
      setSelectedSq(sq)
      const styles: Record<string, object> = {}
      chessRef.current.moves({ square: sq, verbose: true }).forEach((m: any) => {
        styles[m.to] = {
          background: chessRef.current.get(m.to)
            ? 'radial-gradient(circle, rgba(255,77,77,0.35) 85%, transparent 85%)'
            : 'radial-gradient(circle, rgba(123,97,255,0.35) 40%, transparent 40%)',
          borderRadius: '50%',
        }
      })
      styles[sq] = { backgroundColor: 'rgba(123,97,255,0.25)' }
      setSelectedSq(sq); setOptionSqs(styles)
    } else { setSelectedSq(null); setOptionSqs({}) }
  }
  function resetBoard() {
    if (!current) return
    chessRef.current = new Chess(current.fen)
    setBoardFen(current.fen); setExplore([]); setSelectedSq(null); setOptionSqs({})
  }
  function undoMove() {
    if (!exploring) return
    chessRef.current.undo()
    setBoardFen(chessRef.current.fen())
    setExplore(s => s.slice(0, -1))
    setSelectedSq(null); setOptionSqs({})
  }

  // Arrows + last-move highlight only on the ORIGINAL position (not while exploring)
  const arrows: Arrow[] = useMemo(() => {
    if (exploring || !current) return []
    const out: Arrow[] = []
    if (current.best_move?.length >= 4)
      out.push([current.best_move.slice(0, 2) as Square, current.best_move.slice(2, 4) as Square, '#0DC97F'])
    if (current.move_played?.length >= 4)
      out.push([current.move_played.slice(0, 2) as Square, current.move_played.slice(2, 4) as Square, '#8A8AA4'])
    return out
  }, [exploring, current])

  // ── States ────────────────────────────────────────────────────────────────
  if (isLoading) {
    return <div className="min-h-screen flex items-center justify-center bg-bg-0"><Loader2 size={22} className="animate-spin text-accent" /></div>
  }
  if (isError || total === 0 || !current) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-bg-0">
        <p className="text-sm text-text-2">No mistakes to replay for this pattern.</p>
        <button onClick={() => navigate('/dashboard')} className="btn-ghost text-sm">Back to dashboard</button>
      </div>
    )
  }
  if (done) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg-0 p-4">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
          className="card p-8 max-w-md text-center space-y-4">
          <Sparkles size={28} className="text-accent mx-auto" />
          <h2 className="text-xl font-bold text-text-0">You've reviewed all {total} mistakes.</h2>
          <p className="text-sm text-text-2">Ready to fix them?</p>
          <div className="flex gap-2 pt-1">
            <button onClick={() => { setDone(false); setIdx(0) }}
              className="btn-ghost flex-1 text-sm">Review again</button>
            <button onClick={() => navigate('/session', { state: { clusterId: String(clusterId) } })}
              className="btn-primary flex-1 flex items-center justify-center gap-1.5 text-sm">
              <Zap size={14} /> Start drill session
            </button>
          </div>
          <button onClick={() => navigate('/dashboard')}
            className="text-xs text-text-2 hover:text-text-1">Back to dashboard</button>
        </motion.div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-bg-0 flex flex-col items-center px-4 py-6">
      {/* Header */}
      <div className="w-full max-w-2xl flex items-center gap-3 mb-4">
        <button onClick={() => navigate('/dashboard')}
          className="flex items-center gap-1.5 text-sm text-text-2 hover:text-text-0 transition-colors">
          <ArrowLeft size={14} /> Exit
        </button>
        <div className="flex-1 text-center">
          <h1 className="text-sm font-bold text-text-0 truncate">{label}</h1>
          <p className="text-[11px] text-text-2">{total} mistakes</p>
        </div>
        <div className="w-12" />
      </div>

      {/* Position nav (prev / counter / next) */}
      <div className="flex items-center gap-4 mb-3">
        <button onClick={() => go(-1)} disabled={idx === 0}
          className="btn-ghost flex items-center gap-1 text-sm disabled:opacity-30">
          <ChevronLeft size={16} /> Prev
        </button>
        <span className="text-sm text-text-1 tabular-nums font-medium">{idx + 1} of {total}</span>
        <button onClick={() => go(1)}
          className="btn-ghost flex items-center gap-1 text-sm">
          Next <ChevronRight size={16} />
        </button>
      </div>

      {/* Board + eval bar */}
      <div className="flex items-stretch gap-2">
        <EvalBar
          cp={analysis?.eval_cp ?? null}
          mate={analysis?.eval_mate ?? null}
          orient={current.user_color}
          h={BOARD}
          loading={evalLoading}
        />
        <AnimatePresence mode="wait">
          <motion.div key={idx}
            initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }}
            transition={{ duration: 0.16 }}>
            <Chessboard
              position={boardFen || current.fen}
              onPieceDrop={onDrop}
              onSquareClick={onSquareClick}
              boardOrientation={current.user_color}
              customArrows={arrows}
              customSquareStyles={optionSqs}
              boardWidth={BOARD}
              customDarkSquareStyle={{ backgroundColor: '#1A1D36' }}
              customLightSquareStyle={{ backgroundColor: '#343761' }}
              customBoardStyle={{ borderRadius: '6px', boxShadow: '0 0 0 1px rgba(123,97,255,0.15)' }}
            />
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Explore controls */}
      <div className="w-full max-w-2xl mt-2 flex items-center gap-2 justify-center">
        {exploring ? (
          <>
            <span className="text-[11px] text-accent font-mono truncate max-w-[60%]">
              exploring: {exploreSans.join(' ')}
            </span>
            <button onClick={undoMove} className="btn-ghost flex items-center gap-1 text-xs">
              <Undo2 size={12} /> Undo
            </button>
            <button onClick={resetBoard} className="btn-ghost flex items-center gap-1 text-xs">
              <RotateCcw size={12} /> Reset
            </button>
          </>
        ) : (
          <span className="text-[11px] text-text-2">Drag pieces to explore · eval updates live</span>
        )}
      </div>

      {/* Move detail */}
      <div className="w-full max-w-2xl mt-3 space-y-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-danger">
            You played: <span className="font-mono font-semibold">{current.move_played_san}</span>
            <span className="text-text-2"> (−{current.eval_drop}cp)</span>
          </span>
          <span className="text-success">
            Best was: <span className="font-mono font-semibold">
              {current.best_move.slice(0, 2)}→{current.best_move.slice(2, 4)}
            </span>
          </span>
        </div>

        <p className="text-xs text-text-2 text-center">
          {current.opponent ? `vs ${current.opponent} · ` : ''}
          {current.time_control ? `${current.time_control} · ` : ''}
          Move {current.move_number}
          {current.game_date ? ` · ${fmtDate(current.game_date)}` : ''}
          {' · '}<span className="capitalize">{current.threat_type.replace(/_/g, ' ')}</span>
        </p>

        {/* Per-position Notice — always visible for the current board, unique each time */}
        <div className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 flex items-start gap-2 min-h-[44px]">
          <Sparkles size={13} className="text-accent mt-0.5 flex-shrink-0" />
          {noteLoading && !noteData ? (
            <p className="text-xs text-text-2 flex items-center gap-1.5">
              <Loader2 size={11} className="animate-spin text-accent" /> Reading the position…
            </p>
          ) : (
            <p className="text-xs text-text-1">
              <span className="text-accent font-medium">Notice: </span>
              {noteData?.note || 'Look for the tactical idea you missed here.'}
            </p>
          )}
        </div>

        {/* Why was this a mistake? */}
        <div>
          {!showWhy ? (
            <button onClick={loadWhy}
              className="w-full flex items-center justify-center gap-1.5 py-2 rounded-md
                         border border-border text-xs text-text-1 hover:bg-bg-2 hover:text-text-0 transition-colors">
              <Lightbulb size={12} /> Why was this a mistake here?
            </button>
          ) : (
            <div className="rounded-md border border-border bg-bg-1 p-3 relative">
              <button onClick={() => setShowWhy(false)}
                className="absolute top-2 right-2 p-0.5 rounded text-text-2 hover:text-text-0"><X size={12} /></button>
              {whyLoading ? (
                <p className="text-xs text-text-2 flex items-center gap-1.5">
                  <Loader2 size={11} className="animate-spin text-accent" /> Thinking…
                </p>
              ) : (
                <p className="text-xs text-text-1 leading-relaxed pr-4">{why}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
