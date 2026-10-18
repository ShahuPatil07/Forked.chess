import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Chessboard } from 'react-chessboard'
import { Chess, type Square } from 'chess.js'
import { useQuery } from '@tanstack/react-query'
import {
  ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, FlipVertical2, RotateCcw,
  Undo2, Swords, Square as StopIcon, ClipboardPaste, Copy, Check,
} from 'lucide-react'
import { coachApi, type GameMoment, type PlayStrength } from '../../api/coach'

const DARK = '#1A1D36'
const LIGHT = '#343761'
export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

export interface BoardLine {
  rootFen: string
  sans: string[]
  fens: string[]          // fens[0] === rootFen; fens[i] = after i moves
  label: string
  kind: 'user' | 'coach' | 'game'
}

export interface CoachBoardState {
  line: BoardLine
  ply: number
  saved: { line: BoardLine; ply: number } | null   // the user's own board while a coach line is shown
  gamePgn?: string
  moments?: GameMoment[]
  play?: { userColor: 'white' | 'black'; strength: PlayStrength }
}

function userLine(fen: string): BoardLine {
  return { rootFen: fen, sans: [], fens: [fen], label: 'Your board', kind: 'user' }
}

/** Board state shared by the board panel and the chat (what the coach "sees"). */
export function useCoachBoard(initialFen = START_FEN) {
  const [state, setStateRaw] = useState<CoachBoardState>({ line: userLine(initialFen), ply: 0, saved: null })
  const stateRef = useRef(state)
  // Keep the ref in sync synchronously so move() can validate against the latest board.
  const setState = useCallback((next: CoachBoardState | ((prev: CoachBoardState) => CoachBoardState)) => {
    const value = typeof next === 'function' ? next(stateRef.current) : next
    stateRef.current = value
    setStateRaw(value)
  }, [])
  const fen = state.line.fens[Math.min(state.ply, state.line.fens.length - 1)]
  const movesContext = state.line.sans.slice(0, state.ply)

  const setPosition = useCallback((newFen: string, label = 'Your board') => {
    setState({ line: { ...userLine(newFen), label }, ply: 0, saved: null })
  }, [setState])

  /** Show a line from the coach; the user's own board is kept to return to. */
  const showLine = useCallback((rootFen: string, sans: string[], fens: string[], label: string,
                                kind: BoardLine['kind'] = 'coach', ply?: number, extra?: Partial<CoachBoardState>) => {
    const full = fens.length === sans.length + 1 ? fens : [rootFen]
    setState(prev => ({
      ...prev, ...extra,
      line: { rootFen, sans: full.length > 1 ? sans : [], fens: full, label, kind },
      ply: Math.max(0, Math.min(ply ?? (kind === 'game' ? 0 : sans.length), full.length - 1)),
      saved: kind === 'coach' ? (prev.saved ?? (prev.line.kind !== 'coach' ? { line: prev.line, ply: prev.ply } : null)) : null,
    }))
  }, [setState])

  const back = useCallback(() => {
    setState(prev => prev.saved ? { ...prev, line: prev.saved.line, ply: prev.saved.ply, saved: null } : prev)
  }, [setState])

  const goTo = useCallback((ply: number) => {
    setState(prev => ({ ...prev, ply: Math.max(0, Math.min(ply, prev.line.fens.length - 1)) }))
  }, [setState])

  /** A move on the board. Branches off the shown line like an analysis board. */
  const move = useCallback((from: string, to: string, promotion = 'q', expectFen?: string): string | null => {
    const prev = stateRef.current
    const cur = prev.line.fens[prev.ply]
    if (expectFen && cur !== expectFen) return null   // a stale engine reply
    const chess = new Chess(cur)
    let result
    try { result = chess.move({ from, to, promotion }) } catch { return null }
    if (!result) return null
    const sans = [...prev.line.sans.slice(0, prev.ply), result.san]
    const fens = [...prev.line.fens.slice(0, prev.ply + 1), chess.fen()]
    const keep = prev.line.sans[prev.ply] === result.san
    setState({
      ...prev,
      line: keep ? prev.line : { ...prev.line, sans, fens, label: prev.line.kind === 'game' && !prev.line.label.endsWith('(variation)') ? prev.line.label + ' (variation)' : prev.line.label },
      ply: prev.ply + 1,
    })
    return result.san
  }, [setState])

  const loadText = useCallback((text: string): string | null => {
    const t = text.trim()
    if (!t) return 'Paste a FEN or PGN.'
    try {
      const c = new Chess(t)
      setPosition(c.fen(), 'Pasted position')
      return null
    } catch { /* not a FEN */ }
    try {
      const c = new Chess()
      c.loadPgn(t)
      const history = c.history()
      const header = c.header() as Record<string, string | null>
      const root = header.FEN ?? START_FEN
      const replay = new Chess(root)
      const fens = [replay.fen()]
      for (const san of history) { replay.move(san); fens.push(replay.fen()) }
      const label = header.White && header.Black ? `${header.White} – ${header.Black}` : 'Pasted game'
      setState({ line: { rootFen: root, sans: history, fens, label, kind: 'game' }, ply: 0, saved: null, gamePgn: t })
      return null
    } catch {
      return 'That is not a valid FEN or PGN.'
    }
  }, [setPosition, setState])

  const startPlay = useCallback((startFen: string, userColor: 'white' | 'black', strength: PlayStrength) => {
    setState({ line: { ...userLine(startFen), label: `Game vs Coach (${strength})` }, ply: 0, saved: null,
               play: { userColor, strength } })
  }, [setState])
  const stopPlay = useCallback(() => setState(prev => ({ ...prev, play: undefined })), [setState])
  const setMoments = useCallback((moments: GameMoment[]) => setState(prev => ({ ...prev, moments })), [setState])

  return { state, fen, movesContext, setPosition, showLine, back, goTo, move, loadText, startPlay, stopPlay, setMoments, setState }
}

export type CoachBoardApi = ReturnType<typeof useCoachBoard>

const MOMENT_COLORS: Record<string, string> = {
  blunder: 'text-danger', mistake: 'text-orange-400', miss: 'text-orange-300',
  inaccuracy: 'text-amber-300', brilliant: 'text-cyan-300', great: 'text-sky-300',
}

function evalText(cp: number | null, mate: number | null) {
  if (mate != null) return `M${Math.abs(mate)}`
  if (cp == null) return '…'
  return `${cp >= 0 ? '+' : ''}${(cp / 100).toFixed(1)}`
}

export function CoachWorkspaceBoard({ board, busy }: { board: CoachBoardApi; busy: boolean }) {
  const { state, fen } = board
  const [orientation, setOrientation] = useState<'white' | 'black'>('white')
  const [paste, setPaste] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [width, setWidth] = useState(400)
  const wrapRef = useRef<HTMLDivElement>(null)
  const engineThinking = useRef(false)

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const w = entries[0].contentRect.width
      setWidth(Math.max(240, Math.min(520, Math.floor(w - 18))))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Keep orientation with the player's colour in play mode.
  useEffect(() => { if (state.play) setOrientation(state.play.userColor) }, [state.play])

  const { data: evalData } = useQuery({
    queryKey: ['coach-board-eval', fen],
    queryFn: () => fetch(`/api/analyse?fen=${encodeURIComponent(fen)}&depth=12`).then(r => r.json()),
    staleTime: Infinity, retry: false, enabled: !state.play,
  })
  const cp: number | null = evalData?.eval_cp ?? null
  const mate: number | null = evalData?.eval_mate ?? null
  const whitePct = mate != null ? (mate > 0 ? 96 : 4) : cp == null ? 50 : Math.max(4, Math.min(96, 50 + 50 * Math.tanh(cp / 400)))

  const chess = useMemo(() => { try { return new Chess(fen) } catch { return new Chess() } }, [fen])
  const gameOver = chess.isGameOver()
  const atEnd = state.ply >= state.line.fens.length - 1

  // Play mode: the coach replies when it's its turn at the end of the line.
  const moveRef = useRef(board.move)
  moveRef.current = board.move
  useEffect(() => {
    const play = state.play
    if (!play || gameOver || !atEnd || engineThinking.current) return
    const engineToMove = (chess.turn() === 'w') !== (play.userColor === 'white')
    if (!engineToMove) return
    engineThinking.current = true
    const requested = fen
    let fired = false
    const t = setTimeout(async () => {
      fired = true
      try {
        const res = await coachApi.engineMove(requested, play.strength)
        moveRef.current(res.move_uci.slice(0, 2), res.move_uci.slice(2, 4), res.move_uci[4] || 'q', requested)
      } catch { /* the user can stop/restart play */ }
      finally { engineThinking.current = false }
    }, 350)
    return () => { clearTimeout(t); if (!fired) engineThinking.current = false }
  }, [state.play, fen, atEnd, gameOver, chess])

  // ← / → step through the line (ignored while typing).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'ArrowLeft') { e.preventDefault(); board.goTo(state.ply - 1) }
      if (e.key === 'ArrowRight') { e.preventDefault(); board.goTo(state.ply + 1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [board, state.ply])

  function onDrop(from: Square, to: Square, piece: string): boolean {
    if (state.play) {
      const userTurn = (chess.turn() === 'w') === (state.play.userColor === 'white')
      if (!userTurn || !atEnd) return false
    }
    const promo = piece[1]?.toLowerCase() === 'p' && (to[1] === '8' || to[1] === '1') ? 'q' : undefined
    return !!board.move(from, to, promo)
  }

  const lastMove = state.ply > 0 ? (() => {
    try {
      const c = new Chess(state.line.fens[state.ply - 1])
      const m = c.move(state.line.sans[state.ply - 1])
      return m ? { from: m.from, to: m.to } : null
    } catch { return null }
  })() : null
  const squareStyles = lastMove ? {
    [lastMove.from]: { background: 'rgba(123,97,255,0.28)' },
    [lastMove.to]: { background: 'rgba(123,97,255,0.38)' },
  } : {}

  // Move list rows: [moveNumber, whiteIdx?, blackIdx?]
  const startTurnBlack = state.line.rootFen.split(' ')[1] === 'b'
  const startNo = parseInt(state.line.rootFen.split(' ')[5] || '1', 10) || 1
  const rows: { no: number; w?: number; b?: number }[] = []
  state.line.sans.forEach((_, i) => {
    const offset = i + (startTurnBlack ? 1 : 0)
    const no = startNo + Math.floor(offset / 2)
    const isWhite = offset % 2 === 0
    if (isWhite || !rows.length || rows[rows.length - 1].no !== no) rows.push({ no })
    if (isWhite) rows[rows.length - 1].w = i; else rows[rows.length - 1].b = i
  })
  const momentAt = (i: number) => state.moments?.find(m => m.ply === i + 1)

  return (
    <div className="card p-3 flex flex-col gap-2 min-h-0" ref={wrapRef}>
      <div className="flex items-center gap-1.5 text-xs">
        <span className={`px-2 py-0.5 rounded-md border truncate max-w-[60%] ${state.line.kind === 'coach' ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border text-text-1'}`}
          title={state.line.label}>{state.line.label}</span>
        {state.saved && (
          <button onClick={board.back} className="flex items-center gap-1 px-2 py-0.5 rounded-md text-text-1 hover:text-text-0 hover:bg-bg-2" title="Back to your board">
            <Undo2 size={12} /> My board
          </button>
        )}
        <div className="flex-1" />
        <button onClick={() => setOrientation(o => o === 'white' ? 'black' : 'white')} className="p-1 rounded text-text-2 hover:text-text-0 hover:bg-bg-2" title="Flip board"><FlipVertical2 size={13} /></button>
        <button onClick={() => { void navigator.clipboard?.writeText(fen); setCopied(true); setTimeout(() => setCopied(false), 1200) }}
          className="p-1 rounded text-text-2 hover:text-text-0 hover:bg-bg-2" title="Copy FEN">{copied ? <Check size={13} /> : <Copy size={13} />}</button>
        <button onClick={() => board.setPosition(START_FEN, 'Your board')} className="p-1 rounded text-text-2 hover:text-text-0 hover:bg-bg-2" title="Reset to the starting position"><RotateCcw size={13} /></button>
      </div>

      <div className="flex gap-2 justify-center">
        <div className="w-2.5 rounded overflow-hidden flex flex-col-reverse flex-shrink-0" style={{ height: width }} title={`Engine: ${evalText(cp, mate)}`}>
          <div className="bg-[#E8E8F0] transition-all duration-500" style={{ flex: whitePct }} />
          <div className="bg-bg-3 transition-all duration-500" style={{ flex: 100 - whitePct }} />
        </div>
        <Chessboard
          id="coach-workspace"
          position={fen}
          onPieceDrop={onDrop}
          boardOrientation={orientation}
          boardWidth={width}
          customDarkSquareStyle={{ backgroundColor: DARK }}
          customLightSquareStyle={{ backgroundColor: LIGHT }}
          customSquareStyles={squareStyles}
          customBoardStyle={{ borderRadius: '6px', boxShadow: busy ? '0 0 0 2px rgba(123,97,255,0.45)' : '0 0 0 1px rgba(123,97,255,0.15)' }}
          animationDuration={180}
        />
      </div>

      <div className="flex items-center justify-between text-xs">
        <span className="text-text-2 tabular-nums">
          {state.play ? (gameOver ? 'Game over' : (chess.turn() === 'w') === (state.play.userColor === 'white') ? 'Your move' : 'Coach is thinking…')
            : <>Eval <span className="text-text-0 font-medium">{evalText(cp, mate)}</span> · {chess.turn() === 'w' ? 'White' : 'Black'} to move</>}
        </span>
        <div className="flex items-center gap-0.5">
          <button onClick={() => board.goTo(0)} disabled={state.ply === 0} className="p-1 rounded hover:bg-bg-2 disabled:opacity-30"><ChevronsLeft size={14} /></button>
          <button onClick={() => board.goTo(state.ply - 1)} disabled={state.ply === 0} className="p-1 rounded hover:bg-bg-2 disabled:opacity-30"><ChevronLeft size={14} /></button>
          <button onClick={() => board.goTo(state.ply + 1)} disabled={atEnd} className="p-1 rounded hover:bg-bg-2 disabled:opacity-30"><ChevronRight size={14} /></button>
          <button onClick={() => board.goTo(state.line.fens.length - 1)} disabled={atEnd} className="p-1 rounded hover:bg-bg-2 disabled:opacity-30"><ChevronsRight size={14} /></button>
        </div>
      </div>

      {state.line.sans.length > 0 && (
        <div className="max-h-32 overflow-y-auto rounded-md bg-bg-1 border border-border px-2 py-1.5 text-xs leading-6">
          <button onClick={() => board.goTo(0)} className={`mr-1 px-1 rounded ${state.ply === 0 ? 'bg-accent/15 text-accent' : 'text-text-2 hover:text-text-0'}`}>start</button>
          {rows.map(r => (
            <span key={`${r.no}-${r.w ?? r.b}`} className="inline-flex items-center mr-1">
              <span className="text-text-2 mr-0.5">{r.no}.{r.w == null ? '..' : ''}</span>
              {[r.w, r.b].map(i => i == null ? null : (
                <button key={i} onClick={() => board.goTo(i + 1)}
                  className={`px-1 rounded ${state.ply === i + 1 ? 'bg-accent/15 text-accent' : 'text-text-1 hover:bg-bg-2'} ${momentAt(i) ? MOMENT_COLORS[momentAt(i)!.type] ?? '' : ''}`}
                  title={momentAt(i)?.type}>
                  {state.line.sans[i]}
                </button>
              ))}
            </span>
          ))}
        </div>
      )}

      {state.play ? (
        <div className="flex items-center gap-2 text-xs rounded-md border border-accent/30 bg-accent/10 px-2 py-1.5">
          <Swords size={13} className="text-accent" />
          <span className="text-text-1">Playing as {state.play.userColor} vs Coach · {state.play.strength}</span>
          <div className="flex-1" />
          <button onClick={board.stopPlay} className="flex items-center gap-1 text-text-2 hover:text-text-0"><StopIcon size={11} /> Stop</button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 text-xs">
          <PlayMenu onStart={(color, strength) => board.startPlay(fen, color, strength)} />
          <form className="flex-1 flex gap-1.5" onSubmit={e => { e.preventDefault(); const err = board.loadText(paste); setPasteError(err); if (!err) setPaste('') }}>
            <input value={paste} onChange={e => setPaste(e.target.value)} placeholder="Paste FEN or PGN…" className="input text-xs py-1 flex-1 min-w-0" aria-label="Paste FEN or PGN" />
            <button type="submit" className="btn-ghost border border-border px-2 py-1 flex items-center gap-1" title="Load onto the board"><ClipboardPaste size={12} /> Load</button>
          </form>
        </div>
      )}
      {pasteError && <p className="text-[11px] text-danger">{pasteError}</p>}
    </div>
  )
}

function PlayMenu({ onStart }: { onStart: (color: 'white' | 'black', strength: PlayStrength) => void }) {
  const [open, setOpen] = useState(false)
  const [color, setColor] = useState<'white' | 'black'>('white')
  const [strength, setStrength] = useState<PlayStrength>('intermediate')
  return (
    <div className="relative">
      <button onClick={() => setOpen(o => !o)} className="btn-ghost border border-border px-2 py-1 flex items-center gap-1" title="Play this position against the coach">
        <Swords size={12} /> Play
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 left-0 z-20 w-56 card p-2.5 space-y-2 shadow-lg">
          <div className="flex gap-1">
            {(['white', 'black'] as const).map(c => (
              <button key={c} onClick={() => setColor(c)} className={`flex-1 rounded px-2 py-1 border text-xs ${color === c ? 'border-accent/50 bg-accent/10 text-accent' : 'border-border text-text-1'}`}>{c}</button>
            ))}
          </div>
          <select value={strength} onChange={e => setStrength(e.target.value as PlayStrength)} className="input text-xs w-full" aria-label="Coach strength">
            <option value="beginner">Beginner</option><option value="intermediate">Intermediate</option>
            <option value="advanced">Advanced</option><option value="strong">Strong</option><option value="engine">Full engine</option>
          </select>
          <button onClick={() => { onStart(color, strength); setOpen(false) }} className="w-full rounded bg-accent hover:bg-accent-hover text-white text-xs py-1.5">Start from this position</button>
        </div>
      )}
    </div>
  )
}
