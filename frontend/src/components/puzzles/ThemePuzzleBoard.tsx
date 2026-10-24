import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Chess, type Square } from 'chess.js'
import { Chessboard } from 'react-chessboard'
import type { Arrow, PromotionPieceOption } from 'react-chessboard/dist/chessboard/types'
import { motion } from 'framer-motion'
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'
import {
  BOARD_DARK, BOARD_LIGHT, HINT_SQUARE, LAST_MOVE, NEON, NEON_RGB, PUZZLE_RIGHT, PUZZLE_WRONG_SQ, SUCCESS,
} from '../../theme'
import { themesApi, type ThemePuzzle } from '../../api/themes'

/** What happened on the board. The page turns these into results / strikes. */
export type BoardEvent =
  | { type: 'mistake'; uci: string; timeMs: number }
  | { type: 'solved'; timeMs: number; alt: boolean }
  | { type: 'revealed' }

export type BoardPhase = 'intro' | 'play' | 'wait' | 'done'

interface Props {
  puzzle: ThemePuzzle
  /** 0 = none, 1 = nudge text only, 2 = highlight the piece, 3 = show the move */
  hintLevel: number
  /** bump to play the rest of the solution on the board */
  revealKey: number
  onEvent: (e: BoardEvent) => void
  onPhase?: (p: BoardPhase) => void
  /** rush/streak keep moving: no stepping controls, shorter animations */
  fast?: boolean
  maxSize?: number
}

function fensFor(fen: string, moves: string[]): string[] {
  const c = new Chess(fen)
  const out = [c.fen()]
  for (const u of moves) {
    try { c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }) } catch { break }
    out.push(c.fen())
  }
  return out
}

const sq = (u: string) => [u.slice(0, 2) as Square, u.slice(2, 4) as Square] as const

export function ThemePuzzleBoard({ puzzle, hintLevel, revealKey, onEvent, onPhase, fast = false, maxSize = 620 }: Props) {
  const moves = useMemo(() => puzzle.moves.split(' '), [puzzle.moves])
  const fens = useMemo(() => fensFor(puzzle.fen, moves), [puzzle.fen, moves])
  const orientation = puzzle.color === 'w' ? 'white' : 'black'

  const [ply, setPly] = useState(0)                 // index into fens
  const [phase, setPhaseRaw] = useState<BoardPhase>('intro')
  const [altFen, setAltFen] = useState<string | null>(null)   // an accepted alternative (e.g. a different mate)
  const [altMove, setAltMove] = useState<string | null>(null)
  const [flash, setFlash] = useState<{ uci: string; ok: boolean } | null>(null)
  const [selected, setSelected] = useState<Square | null>(null)
  const [promo, setPromo] = useState<{ from: Square; to: Square } | null>(null)
  const [arrows, setArrows] = useState<Arrow[]>([])
  const [checking, setChecking] = useState(false)
  const startRef = useRef(Date.now())
  const revealing = useRef(false)
  const timers = useRef<number[]>([])
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  const setPhase = useCallback((p: BoardPhase) => { setPhaseRaw(p); onPhase?.(p) }, [onPhase])
  const later = (fn: () => void, ms: number) => { timers.current.push(window.setTimeout(fn, ms)) }

  // New puzzle: show the position, then play the opponent's trigger move.
  useEffect(() => {
    timers.current.forEach(clearTimeout); timers.current = []
    revealing.current = false
    setPly(0); setAltFen(null); setAltMove(null); setFlash(null); setSelected(null); setPromo(null); setArrows([])
    setPhase('intro')
    later(() => { setPly(1); setPhase('play'); startRef.current = Date.now() }, fast ? 250 : 650)
    return () => { timers.current.forEach(clearTimeout); timers.current = [] }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [puzzle.id])

  // Reveal: play the rest of the line with arrows.
  const revealSeen = useRef(revealKey)
  useEffect(() => {
    if (revealKey === revealSeen.current) return
    revealSeen.current = revealKey
    if (phase === 'done' || phase === 'intro') return
    revealing.current = true
    setPhase('wait'); setSelected(null); setFlash(null)
    let p = ply
    const step = () => {
      if (p >= moves.length) { setArrows([]); setPhase('done'); onEventRef.current({ type: 'revealed' }); return }
      const [f, t] = sq(moves[p])
      setArrows([[f, t, p % 2 === 1 ? SUCCESS : NEON]])
      p += 1
      setPly(p)
      later(step, fast ? 450 : 850)
    }
    later(step, fast ? 150 : 350)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealKey])

  const finish = useCallback((alt: boolean) => {
    setPhase('done'); setArrows([])
    onEventRef.current({ type: 'solved', timeMs: Date.now() - startRef.current, alt })
  }, [setPhase])

  const attempt = useCallback((from: Square, to: Square, promotion?: string): boolean => {
    if (phase !== 'play') return false
    const board = new Chess(fens[ply])
    const legal = board.moves({ verbose: true }).find(m => m.from === from && m.to === to)
    if (!legal) return false
    const needsPromo = !!legal.promotion
    const uci = `${from}${to}${needsPromo ? (promotion ?? 'q') : ''}`
    const expected = moves[ply]
    setSelected(null)

    if (uci === expected) {
      setFlash({ uci, ok: true })
      const next = ply + 1
      setPly(next)
      if (next >= moves.length) { finish(false); return true }
      setPhase('wait')
      later(() => {
        setFlash(null)
        setPly(next + 1)
        if (next + 1 >= moves.length) finish(false)
        else setPhase('play')
      }, fast ? 220 : 420)
      return true
    }

    // Any checkmate wins, as on Lichess.
    board.move({ from, to, promotion: needsPromo ? (promotion ?? 'q') : undefined })
    if (board.isCheckmate()) {
      setAltFen(board.fen()); setAltMove(uci); setFlash({ uci, ok: true })
      finish(true)
      return true
    }

    // Own-game puzzles come from engine lines that aren't unique: ask the engine.
    if (puzzle.source === 'game' && !checking) {
      setChecking(true); setPhase('wait')
      themesApi.checkMove(fens[ply], uci, expected).then(r => {
        setChecking(false)
        if (r.ok) {
          setAltFen(board.fen()); setAltMove(uci); setFlash({ uci, ok: true })
          finish(true)
        } else {
          wrong(uci)
        }
      }).catch(() => { setChecking(false); wrong(uci) })
      return true
    }
    wrong(uci)
    return false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, fens, ply, moves, finish, puzzle.source, checking])

  function wrong(uci: string) {
    setFlash({ uci, ok: false })
    setPhase('wait')
    onEventRef.current({ type: 'mistake', uci, timeMs: Date.now() - startRef.current })
    later(() => {
      setFlash(null)
      if (!revealing.current) setPhase('play')    // the page may be revealing the answer instead
    }, fast ? 350 : 650)
  }

  // ── input ─────────────────────────────────────────────────────────────────
  const solverTurn = new Chess(fens[Math.min(ply, fens.length - 1)]).turn()
  const isPromotion = (from: Square, to: Square) => {
    const b = new Chess(fens[ply])
    return b.moves({ verbose: true }).some(m => m.from === from && m.to === to && !!m.promotion)
  }

  function onDrop(from: Square, to: Square): boolean {
    return attempt(from, to)
  }

  function onPromotionPieceSelect(piece?: PromotionPieceOption, from?: Square, to?: Square): boolean {
    const f = from ?? promo?.from, t = to ?? promo?.to
    setPromo(null)
    if (!piece || !f || !t) return false
    return attempt(f, t, piece[1].toLowerCase())
  }

  function onSquareClick(square: Square) {
    if (phase !== 'play') return
    const b = new Chess(fens[ply])
    if (selected) {
      const ok = b.moves({ square: selected, verbose: true }).some(m => m.to === square)
      if (ok) {
        if (isPromotion(selected, square)) { setPromo({ from: selected, to: square }); return }
        attempt(selected, square)
        return
      }
    }
    const p = b.get(square)
    setSelected(p && p.color === b.turn() ? square : null)
  }

  // ── review stepping after the puzzle ──────────────────────────────────────
  const [view, setView] = useState<number | null>(null)
  useEffect(() => { setView(null) }, [puzzle.id])
  const canStep = phase === 'done' && !fast && !altFen
  useEffect(() => {
    if (!canStep) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,textarea,select')) return
      const cur = view ?? fens.length - 1
      if (e.key === 'ArrowLeft') { e.preventDefault(); setView(Math.max(1, cur - 1)) }
      if (e.key === 'ArrowRight') { e.preventDefault(); setView(Math.min(fens.length - 1, cur + 1)) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canStep, view, fens.length])

  const shownPly = canStep && view !== null ? view : ply
  const position = altFen ?? fens[Math.min(shownPly, fens.length - 1)]
  const lastUci = altMove ?? (shownPly > 0 ? moves[shownPly - 1] : null)

  // ── square styles ────────────────────────────────────────────────────────
  const styles = useMemo(() => {
    const s: Record<string, React.CSSProperties> = {}
    if (lastUci) {
      const [f, t] = sq(lastUci)
      s[f] = { backgroundColor: LAST_MOVE }
      s[t] = { backgroundColor: LAST_MOVE }
    }
    if (flash) {
      const [f, t] = sq(flash.uci)
      const c = flash.ok ? PUZZLE_RIGHT : PUZZLE_WRONG_SQ
      s[f] = { backgroundColor: c }
      s[t] = { backgroundColor: c }
    }
    if (phase === 'play' && hintLevel >= 2 && ply < moves.length) {
      const [f] = sq(moves[ply])
      s[f] = { ...s[f], boxShadow: `inset 0 0 0 4px ${HINT_SQUARE}`, backgroundColor: `rgba(${NEON_RGB},0.28)` }
    }
    if (selected && phase === 'play') {
      s[selected] = { ...s[selected], backgroundColor: `rgba(${NEON_RGB},0.3)` }
      const b = new Chess(fens[ply])
      for (const m of b.moves({ square: selected, verbose: true })) {
        s[m.to] = {
          ...s[m.to],
          background: b.get(m.to as Square)
            ? `radial-gradient(circle, transparent 58%, rgba(${NEON_RGB},0.55) 60%)`
            : `radial-gradient(circle, rgba(${NEON_RGB},0.45) 22%, transparent 24%)`,
        }
      }
    }
    return s
  }, [lastUci, flash, phase, hintLevel, ply, moves, selected, fens])

  const shownArrows: Arrow[] = useMemo(() => {
    if (arrows.length) return arrows
    if (phase === 'play' && hintLevel >= 3 && ply < moves.length) {
      const [f, t] = sq(moves[ply])
      return [[f, t, NEON]]
    }
    return []
  }, [arrows, phase, hintLevel, ply, moves])

  // ── sizing ────────────────────────────────────────────────────────────────
  const wrap = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(480)
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const measure = () => {
      const byHeight = window.innerHeight - 190
      setWidth(Math.max(260, Math.min(el.clientWidth, maxSize, byHeight)))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    return () => { ro.disconnect(); window.removeEventListener('resize', measure) }
  }, [maxSize])

  const shake = flash && !flash.ok

  return (
    <div ref={wrap} className="w-full">
      <motion.div
        className="mx-auto relative"
        style={{ width }}
        animate={shake ? { x: [0, -7, 7, -5, 5, 0] } : { x: 0 }}
        transition={{ duration: 0.32 }}
      >
        <Chessboard
          id={`theme-puzzle-${puzzle.id}`}
          position={position}
          boardWidth={width}
          boardOrientation={orientation}
          onPieceDrop={onDrop}
          onSquareClick={onSquareClick}
          onPromotionPieceSelect={onPromotionPieceSelect}
          onPromotionCheck={(from, to, piece) => (piece[1] === 'P' && isPromotion(from, to))}
          promotionToSquare={promo?.to ?? null}
          showPromotionDialog={!!promo}
          isDraggablePiece={({ piece }) => phase === 'play' && piece[0] === solverTurn}
          customSquareStyles={styles}
          customArrows={shownArrows}
          customDarkSquareStyle={{ backgroundColor: BOARD_DARK }}
          customLightSquareStyle={{ backgroundColor: BOARD_LIGHT }}
          customBoardStyle={{ borderRadius: 10, boxShadow: `0 0 0 1px rgba(${NEON_RGB},0.16), 0 24px 60px -24px rgba(0,0,0,0.8)` }}
          animationDuration={fast ? 140 : 260}
        />
        {checking && (
          <div className="absolute inset-x-0 bottom-3 flex justify-center pointer-events-none">
            <span className="text-xs px-3 py-1.5 rounded-full bg-bg-0/90 border border-border text-text-1">
              Checking your move with Stockfish…
            </span>
          </div>
        )}
      </motion.div>

      {canStep && (
        <div className="mx-auto mt-3 flex items-center justify-center gap-1" style={{ width }}>
          {[
            { icon: ChevronsLeft, to: 1, label: 'Start' },
            { icon: ChevronLeft, to: Math.max(1, (view ?? fens.length - 1) - 1), label: 'Back' },
            { icon: ChevronRight, to: Math.min(fens.length - 1, (view ?? fens.length - 1) + 1), label: 'Forward' },
            { icon: ChevronsRight, to: fens.length - 1, label: 'End' },
          ].map(({ icon: I, to, label }) => (
            <button key={label} onClick={() => setView(to)} title={label}
              className="w-10 h-9 grid place-items-center rounded-lg text-text-1 hover:text-accent hover:bg-bg-2 border border-border">
              <I size={16} />
            </button>
          ))}
          <span className="ml-3 text-[11px] text-text-2">← → to step through the line</span>
        </div>
      )}
    </div>
  )
}

/** SAN for every ply of a puzzle (trigger included), for move lists and hand-offs. */
export function puzzleSans(p: ThemePuzzle): { sans: string[]; fens: string[] } {
  const c = new Chess(p.fen)
  const sans: string[] = []
  const fens = [c.fen()]
  for (const u of p.moves.split(' ')) {
    try {
      const m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] })
      sans.push(m.san); fens.push(c.fen())
    } catch { break }
  }
  return { sans, fens }
}
