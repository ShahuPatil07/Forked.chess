/**
 * Construct board — a position editor in the spirit of lichess.org/editor,
 * extended:
 *   - drag pieces from the trays, drag on the board to move, drag off to delete;
 *   - or tap a tool (a piece, the eraser, or "move") and tap squares — works on phones;
 *   - right-click a square to clear it; the same piece placed twice toggles it off;
 *   - castling rights only offered when the king and rook are really at home,
 *     en-passant only offered on squares where a double push just happened;
 *   - every problem is named ("Black has 2 kings", "White pawn on the 8th rank",
 *     "The side not to move is in check") instead of a bare "invalid";
 *   - undo / redo, mirror colours, flip, start / empty, preset positions, material count;
 *   - hand-off: analyse it, or play it out against Maia or Stockfish.
 * Pure board logic — no engine or model is used while editing.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Chess } from 'chess.js'
import { Chessboard, ChessboardDnDProvider, SparePiece } from 'react-chessboard'
import type { Piece, Square } from 'react-chessboard/dist/chessboard/types'
import {
  Bot, Copy, Check, Eraser, FlipVertical2, Hand, Microscope, Redo2, RotateCcw, Trash2, Undo2, ArrowLeftRight, AlertTriangle, CheckCircle2,
} from 'lucide-react'
import { BOARD_DARK, BOARD_LIGHT } from '../../theme'
import { useElementWidth } from '../../hooks/useElementWidth'

type Placement = Record<string, Piece>   // square -> 'wK' etc.
type Tool = 'move' | 'erase' | Piece

const FILES = 'abcdefgh'
const PIECES: Piece[] = ['wK', 'wQ', 'wR', 'wB', 'wN', 'wP', 'bK', 'bQ', 'bR', 'bB', 'bN', 'bP']
const VALUE: Record<string, number> = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 }
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const NAME: Record<string, string> = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight', P: 'pawn' }

export const EDITOR_PRESETS: { group: string; items: { name: string; fen: string }[] }[] = [
  { group: 'Start', items: [{ name: 'Starting position', fen: START_FEN }, { name: 'Empty board (kings only)', fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1' }] },
  { group: 'Checkmates to learn', items: [
    { name: 'K+Q vs K', fen: '8/8/8/4k3/8/8/8/3QK3 w - - 0 1' },
    { name: 'K+R vs K', fen: '8/8/8/4k3/8/8/8/R3K3 w - - 0 1' },
    { name: 'K+2B vs K', fen: '8/8/8/4k3/8/8/8/2B1KB2 w - - 0 1' },
    { name: 'K+B+N vs K', fen: '7k/8/8/8/8/8/8/1N2KB2 w - - 0 1' },
  ] },
  { group: 'Rook endgames', items: [
    { name: 'Lucena position', fen: '1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1' },
    { name: 'Philidor position', fen: '4k3/8/3K4/3P4/8/8/r7/7R b - - 0 1' },
  ] },
  { group: 'Pawn endgames', items: [
    { name: 'Opposition', fen: '8/8/4k3/8/4K3/4P3/8/8 w - - 0 1' },
    { name: 'Outside passed pawn', fen: '8/5kpp/8/P7/8/6PP/5K2/8 w - - 0 1' },
  ] },
]

function fenToPlacement(fen: string): Placement {
  const out: Placement = {}
  const rows = fen.split(' ')[0].split('/')
  rows.forEach((row, r) => {
    let f = 0
    for (const ch of row) {
      if (/\d/.test(ch)) { f += Number(ch); continue }
      const color = ch === ch.toUpperCase() ? 'w' : 'b'
      out[`${FILES[f]}${8 - r}`] = `${color}${ch.toUpperCase()}` as Piece
      f++
    }
  })
  return out
}

function placementToBoardFen(p: Placement): string {
  const rows: string[] = []
  for (let r = 8; r >= 1; r--) {
    let row = '', empty = 0
    for (let f = 0; f < 8; f++) {
      const pc = p[`${FILES[f]}${r}`]
      if (!pc) { empty++; continue }
      if (empty) { row += empty; empty = 0 }
      row += pc[0] === 'w' ? pc[1] : pc[1].toLowerCase()
    }
    rows.push(row + (empty ? empty : ''))
  }
  return rows.join('/')
}

interface EditorState { placement: Placement; turn: 'w' | 'b'; castling: { K: boolean; Q: boolean; k: boolean; q: boolean }; ep: string; half: number; full: number }

function stateFromFen(fen: string): EditorState {
  const [, turn = 'w', cast = '-', ep = '-', half = '0', full = '1'] = fen.trim().split(/\s+/)
  return {
    placement: fenToPlacement(fen), turn: turn === 'b' ? 'b' : 'w',
    castling: { K: cast.includes('K'), Q: cast.includes('Q'), k: cast.includes('k'), q: cast.includes('q') },
    ep: ep || '-', half: Number(half) || 0, full: Math.max(1, Number(full) || 1),
  }
}

/** Castling rights that are actually possible in this placement. */
function castlingAllowed(p: Placement) {
  return {
    K: p.e1 === 'wK' && p.h1 === 'wR', Q: p.e1 === 'wK' && p.a1 === 'wR',
    k: p.e8 === 'bK' && p.h8 === 'bR', q: p.e8 === 'bK' && p.a8 === 'bR',
  }
}

/** Squares a pawn could just have double-pushed past (en-passant targets for the side to move). */
function epCandidates(p: Placement, turn: 'w' | 'b'): string[] {
  const out: string[] = []
  for (const f of FILES) {
    if (turn === 'w' && p[`${f}5`] === 'bP' && !p[`${f}6`] && !p[`${f}7`]) {
      const adj = [FILES[FILES.indexOf(f) - 1], FILES[FILES.indexOf(f) + 1]].filter(Boolean)
      if (adj.some(a => p[`${a}5`] === 'wP')) out.push(`${f}6`)
    }
    if (turn === 'b' && p[`${f}4`] === 'wP' && !p[`${f}3`] && !p[`${f}2`]) {
      const adj = [FILES[FILES.indexOf(f) - 1], FILES[FILES.indexOf(f) + 1]].filter(Boolean)
      if (adj.some(a => p[`${a}4`] === 'bP')) out.push(`${f}3`)
    }
  }
  return out
}

function buildFen(s: EditorState): string {
  const allowed = castlingAllowed(s.placement)
  const cast = (['K', 'Q', 'k', 'q'] as const).filter(k => s.castling[k] && allowed[k]).join('') || '-'
  const ep = epCandidates(s.placement, s.turn).includes(s.ep) ? s.ep : '-'
  return `${placementToBoardFen(s.placement)} ${s.turn} ${cast} ${ep} ${s.half} ${s.full}`
}

/** Every reason the position can't be played, in plain words. */
export function positionProblems(fen: string): string[] {
  const p = fenToPlacement(fen)
  const problems: string[] = []
  const count = (pc: string) => Object.values(p).filter(x => x === pc).length
  for (const c of ['w', 'b'] as const) {
    const side = c === 'w' ? 'White' : 'Black'
    const kings = count(`${c}K`)
    if (kings === 0) problems.push(`${side} has no king.`)
    if (kings > 1) problems.push(`${side} has ${kings} kings.`)
    const pawns = count(`${c}P`)
    if (pawns > 8) problems.push(`${side} has ${pawns} pawns (max 8).`)
    const total = Object.values(p).filter(x => x[0] === c).length
    if (total > 16) problems.push(`${side} has ${total} pieces (max 16).`)
    const extra = Math.max(0, count(`${c}Q`) - 1) + Math.max(0, count(`${c}R`) - 2) + Math.max(0, count(`${c}B`) - 2) + Math.max(0, count(`${c}N`) - 2)
    if (pawns + extra > 8) problems.push(`${side} has more promoted pieces than missing pawns allow.`)
  }
  for (const [sq, pc] of Object.entries(p)) {
    if (pc[1] === 'P' && (sq[1] === '1' || sq[1] === '8')) problems.push(`${pc[0] === 'w' ? 'White' : 'Black'} pawn on ${sq} (pawns can't stand on the 1st or 8th rank).`)
  }
  const wk = Object.keys(p).find(s => p[s] === 'wK'), bk = Object.keys(p).find(s => p[s] === 'bK')
  if (wk && bk && Math.abs(FILES.indexOf(wk[0]) - FILES.indexOf(bk[0])) <= 1 && Math.abs(Number(wk[1]) - Number(bk[1])) <= 1)
    problems.push('The kings are touching.')
  if (!problems.length) {
    // side NOT to move in check → impossible
    const parts = fen.split(' ')
    const flipped = [parts[0], parts[1] === 'w' ? 'b' : 'w', '-', '-', '0', '1'].join(' ')
    try {
      const c = new Chess(flipped, { skipValidation: true })
      if (c.inCheck()) problems.push(`${parts[1] === 'w' ? 'Black' : 'White'} is in check but it's ${parts[1] === 'w' ? 'White' : 'Black'}'s move.`)
    } catch { /* covered by validateFen below */ }
    try {
      const c = new Chess(fen, { skipValidation: true })
      if (c.inCheck()) {
        const attackers = c.attackers(c.findPiece({ type: 'k', color: c.turn() })[0] as Square, c.turn() === 'w' ? 'b' : 'w')
        if (attackers.length > 2) problems.push(`The king is attacked by ${attackers.length} pieces at once — impossible after one move.`)
      }
    } catch { /* ignore */ }
  }
  if (!problems.length) {
    try { new Chess(fen) } catch (e) { problems.push(e instanceof Error ? e.message.replace(/^Invalid FEN: /, '') : 'Invalid position.') }
  }
  return problems
}

export function BoardEditor({ initialFen, onAnalyse, onPlay }: {
  initialFen: string
  onAnalyse: (fen: string) => void
  onPlay: (fen: string, engine: 'maia' | 'stockfish') => void
}) {
  const [history, setHistory] = useState<EditorState[]>(() => [stateFromFen(initialFen)])
  const [cursor, setCursor] = useState(0)
  const [tool, setTool] = useState<Tool>('move')
  const [flip, setFlip] = useState(false)
  const [fenInput, setFenInput] = useState('')
  const [copied, setCopied] = useState(false)
  const [boardRef, measured] = useElementWidth<HTMLDivElement>(480)
  const width = Math.max(240, Math.min(560, measured))
  const sq = width / 8
  const state = history[cursor]
  const fen = useMemo(() => buildFen(state), [state])
  const problems = useMemo(() => positionProblems(fen), [fen])
  const allowed = castlingAllowed(state.placement)
  const eps = epCandidates(state.placement, state.turn)
  useEffect(() => { setFenInput(fen) }, [fen])

  const commit = useCallback((fn: (s: EditorState) => EditorState) => {
    setHistory(h => {
      const next = fn(h[cursor])
      return [...h.slice(0, cursor + 1), next].slice(-200)
    })
    setCursor(c => Math.min(c + 1, 199))
  }, [cursor])
  const place = (square: string, piece: Piece | null) => commit(s => {
    const placement = { ...s.placement }
    if (piece) placement[square] = piece; else delete placement[square]
    return { ...s, placement }
  })

  function onSquareClick(square: Square) {
    if (tool === 'move') return
    if (tool === 'erase') { if (state.placement[square]) place(square, null); return }
    place(square, state.placement[square] === tool ? null : tool)
  }
  function onPieceDrop(from: Square, to: Square, piece: Piece): boolean {
    commit(s => {
      const placement = { ...s.placement }
      delete placement[from]
      placement[to] = piece
      return { ...s, placement }
    })
    return true
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,textarea,select')) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); setCursor(c => Math.max(0, c - 1)) }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); setCursor(c => Math.min(history.length - 1, c + 1)) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [history.length])

  const load = (f: string) => commit(() => stateFromFen(f))
  const mirror = () => commit(s => {
    const placement: Placement = {}
    for (const [sqr, pc] of Object.entries(s.placement)) placement[`${sqr[0]}${9 - Number(sqr[1])}`] = `${pc[0] === 'w' ? 'b' : 'w'}${pc[1]}` as Piece
    return { ...s, placement, turn: s.turn === 'w' ? 'b' : 'w', castling: { K: s.castling.k, Q: s.castling.q, k: s.castling.K, q: s.castling.Q }, ep: '-' }
  })

  const material = useMemo(() => {
    const m = { w: 0, b: 0 }, counts: Record<string, number> = {}
    for (const pc of Object.values(state.placement)) { m[pc[0] as 'w' | 'b'] += VALUE[pc[1]]; counts[pc] = (counts[pc] ?? 0) + 1 }
    return { ...m, counts }
  }, [state.placement])

  const valid = problems.length === 0
  const toolBtn = (t: Tool, label: string, icon: React.ReactNode) => (
    <button onClick={() => setTool(t)} title={label} aria-pressed={tool === t}
      className={`h-9 px-2.5 rounded-lg border text-xs inline-flex items-center gap-1.5 ${tool === t ? 'border-accent bg-accent/15 text-accent' : 'border-border text-text-1 hover:text-text-0'}`}>{icon}{label}</button>
  )
  const tray = (color: 'w' | 'b') => (
    <div className="flex flex-wrap items-center justify-center gap-1 rounded-xl border border-border bg-bg-1 p-1.5">
      {PIECES.filter(p => p[0] === color).map(p => (
        <div key={p} onClick={() => setTool(t => (t === p ? 'move' : p))} title={`${color === 'w' ? 'White' : 'Black'} ${NAME[p[1]]} — drag, or tap then tap squares`}
          className={`rounded-lg cursor-pointer transition-colors ${tool === p ? 'bg-accent/25 ring-1 ring-accent' : 'hover:bg-bg-3'}`}>
          <SparePiece piece={p} width={Math.max(30, Math.min(52, sq * 0.82))} dndId="editor" />
        </div>
      ))}
    </div>
  )

  return (
    <ChessboardDnDProvider>
      <div className="grid lg:grid-cols-[minmax(0,1fr)_340px] gap-5">
        <div className="min-w-0">
          <div ref={boardRef} className="mx-auto w-full" style={{ maxWidth: 560 }}>
            {tray(flip ? 'w' : 'b')}
            <div className="my-2" onContextMenu={e => e.preventDefault()}>
              <Chessboard id="editor" boardWidth={width} position={placementToBoardFen(state.placement)}
                boardOrientation={flip ? 'black' : 'white'} arePiecesDraggable={tool === 'move' || tool === 'erase'}
                onPieceDrop={onPieceDrop} onSquareClick={onSquareClick}
                onSquareRightClick={s => { if (state.placement[s]) place(s, null) }}
                onSparePieceDrop={(piece, s) => { place(s, piece); return true }}
                dropOffBoardAction="trash" onPieceDropOffBoard={(s) => place(s, null)}
                customDarkSquareStyle={{ backgroundColor: BOARD_DARK }} customLightSquareStyle={{ backgroundColor: BOARD_LIGHT }}
                customBoardStyle={{ borderRadius: 8, boxShadow: valid ? '0 0 0 1px rgba(200,255,42,0.25)' : '0 0 0 1px rgba(255,77,94,0.5)' }}
                areArrowsAllowed={false} />
            </div>
            {tray(flip ? 'b' : 'w')}
            <div className="flex flex-wrap gap-1.5 mt-3 justify-center">
              {toolBtn('move', 'Move', <Hand size={13} />)}
              {toolBtn('erase', 'Eraser', <Eraser size={13} />)}
              <button className="h-9 px-2.5 rounded-lg border border-border text-xs text-text-1 hover:text-text-0 inline-flex items-center gap-1.5" onClick={() => setCursor(c => Math.max(0, c - 1))} disabled={cursor === 0} title="Undo (Ctrl+Z)"><Undo2 size={13} />Undo</button>
              <button className="h-9 px-2.5 rounded-lg border border-border text-xs text-text-1 hover:text-text-0 inline-flex items-center gap-1.5" onClick={() => setCursor(c => Math.min(history.length - 1, c + 1))} disabled={cursor >= history.length - 1} title="Redo (Ctrl+Y)"><Redo2 size={13} />Redo</button>
            </div>
            <p className="text-[11px] text-text-2 text-center mt-2">Drag from the trays, drag pieces off the board to delete, right-click to clear a square — or pick a tool and tap squares.</p>
          </div>
        </div>

        <div className="min-w-0 space-y-3">
          <div className="card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-2">To move</span>
              <div className="flex p-0.5 rounded-lg bg-bg-2 border border-border">
                {(['w', 'b'] as const).map(t => (
                  <button key={t} onClick={() => commit(s => ({ ...s, turn: t, ep: '-' }))}
                    className={`px-3 py-1 rounded-md text-xs font-semibold ${state.turn === t ? 'bg-bg-3 text-accent' : 'text-text-2'}`}>{t === 'w' ? 'White' : 'Black'}</button>
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs text-text-2 mb-1.5">Castling</p>
              <div className="grid grid-cols-2 gap-1.5">
                {([['K', 'White O-O'], ['Q', 'White O-O-O'], ['k', 'Black O-O'], ['q', 'Black O-O-O']] as const).map(([k, label]) => (
                  <label key={k} className={`flex items-center gap-2 text-xs rounded-lg border px-2 py-1.5 ${allowed[k] ? 'border-border text-text-1 cursor-pointer' : 'border-border/50 text-text-2/50 cursor-not-allowed'}`}
                    title={allowed[k] ? '' : 'King and rook must be on their starting squares'}>
                    <input type="checkbox" className="accent-[#C8FF2A]" disabled={!allowed[k]} checked={allowed[k] && state.castling[k]}
                      onChange={e => commit(s => ({ ...s, castling: { ...s.castling, [k]: e.target.checked } }))} />{label}
                  </label>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-text-2">En passant</span>
              <select className="input !w-auto py-1 text-xs" value={eps.includes(state.ep) ? state.ep : '-'} disabled={!eps.length}
                onChange={e => commit(s => ({ ...s, ep: e.target.value }))}>
                <option value="-">{eps.length ? 'none' : 'not possible'}</option>
                {eps.map(e => <option key={e} value={e}>{e}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-[11px] text-text-2">Halfmove clock<input type="number" min={0} max={150} className="input mt-1 py-1 text-xs" value={state.half} onChange={e => commit(s => ({ ...s, half: Math.max(0, Number(e.target.value) || 0) }))} /></label>
              <label className="text-[11px] text-text-2">Move number<input type="number" min={1} max={500} className="input mt-1 py-1 text-xs" value={state.full} onChange={e => commit(s => ({ ...s, full: Math.max(1, Number(e.target.value) || 1) }))} /></label>
            </div>
          </div>

          <div className="card p-4 space-y-2">
            <div className="grid grid-cols-2 gap-1.5">
              <button className="btn-ghost border border-border text-xs inline-flex items-center justify-center gap-1.5" onClick={() => load(START_FEN)}><RotateCcw size={12} />Start</button>
              <button className="btn-ghost border border-border text-xs inline-flex items-center justify-center gap-1.5" onClick={() => load('8/8/8/8/8/8/8/8 w - - 0 1')}><Trash2 size={12} />Clear</button>
              <button className="btn-ghost border border-border text-xs inline-flex items-center justify-center gap-1.5" onClick={() => setFlip(f => !f)}><FlipVertical2 size={12} />Flip board</button>
              <button className="btn-ghost border border-border text-xs inline-flex items-center justify-center gap-1.5" onClick={mirror} title="Mirror the position and swap colours"><ArrowLeftRight size={12} />Swap colours</button>
            </div>
            <select className="input text-xs" value="" onChange={e => e.target.value && load(e.target.value)} aria-label="Load a preset">
              <option value="">Load a preset position…</option>
              {EDITOR_PRESETS.map(g => <optgroup key={g.group} label={g.group}>{g.items.map(i => <option key={i.name} value={i.fen}>{i.name}</option>)}</optgroup>)}
            </select>
            <div className="text-[11px] text-text-2 flex flex-wrap gap-x-3">
              <span>Material: White {material.w} · Black {material.b}{material.w !== material.b ? ` (${material.w > material.b ? 'White' : 'Black'} +${Math.abs(material.w - material.b)})` : ''}</span>
            </div>
          </div>

          <div className="card p-4 space-y-2">
            <label className="text-[11px] text-text-2">FEN</label>
            <div className="flex gap-1.5">
              <input className="input font-mono text-[11px]" value={fenInput} onChange={e => setFenInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') load(fenInput) }} onBlur={() => { if (fenInput.trim() && fenInput !== fen) load(fenInput) }} spellCheck={false} />
              <button className="btn-ghost border border-border px-2" title="Copy FEN" onClick={() => navigator.clipboard.writeText(fen).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200) })}>
                {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
              </button>
            </div>
            {valid ? (
              <p className="text-xs text-success flex items-center gap-1.5"><CheckCircle2 size={13} />Legal position — ready to use.</p>
            ) : (
              <ul className="text-xs text-danger space-y-1">
                {problems.map(p => <li key={p} className="flex gap-1.5"><AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />{p}</li>)}
              </ul>
            )}
          </div>

          <div className="grid gap-2">
            <button className="btn-primary inline-flex items-center justify-center gap-2" disabled={!valid} onClick={() => onAnalyse(fen)}><Microscope size={15} />Analyse this position</button>
            <div className="grid grid-cols-2 gap-2">
              <button className="btn-ghost border border-border text-sm inline-flex items-center justify-center gap-1.5" disabled={!valid} onClick={() => onPlay(fen, 'maia')}><Bot size={14} />Play vs Maia</button>
              <button className="btn-ghost border border-border text-sm inline-flex items-center justify-center gap-1.5" disabled={!valid} onClick={() => onPlay(fen, 'stockfish')}><Bot size={14} />vs Stockfish</button>
            </div>
          </div>
        </div>
      </div>
    </ChessboardDnDProvider>
  )
}
