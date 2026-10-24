import { useEffect, useMemo, useRef, useState } from 'react'
import { Chess } from 'chess.js'
import type { Arrow, Square } from 'react-chessboard/dist/chessboard/types'
import type { OpponentThreatItem } from '../api'
import { DrillBoard, type Mark } from '../components/DrillBoard'
import { NEON } from '../../../theme'
import { choiceBtn, type DrillProps } from './types'

const NAMES: Record<string, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' }

/** The position with the OPPONENT to move (their threat, as if they got a free move). */
function threatBoard(fen: string): Chess | null {
  const parts = fen.split(' ')
  parts[1] = parts[1] === 'w' ? 'b' : 'w'
  parts[3] = '-'
  try { return new Chess(parts.join(' ')) } catch { return null }
}

/**
 * What does it threaten? The opponent's last move is highlighted. Answer by PLAYING
 * the threat for them: drag their piece (or tap it, then tap the square). If their
 * move threatens nothing, press "No threat". Tapping your own threatened piece also counts.
 * Ground truth is computed on the board (null-move probe + static exchange) — see
 * backend/warmup/chesskit.threats; every winning capture and every mate in one is accepted.
 */
export function OpponentThreat({ item, reveal, given, width, onAnswer }: DrillProps<OpponentThreatItem>) {
  const [fen, setFen] = useState(item.before)
  const [selected, setSelected] = useState<string | null>(null)
  const onset = useRef(performance.now())
  const done = useRef(false)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    done.current = false
    setFen(item.before); setReady(false); setSelected(null)
    const t = window.setTimeout(() => { setFen(item.fen); setReady(true); onset.current = performance.now() }, 550)
    return () => clearTimeout(t)
  }, [item.id, item.before, item.fen])

  const board = useMemo(() => new Chess(item.fen), [item.fen])
  const theirs = useMemo(() => threatBoard(item.fen), [item.fen])
  const myColor = board.turn()
  const theirColor = myColor === 'w' ? 'b' : 'w'
  const myKing = board.board().flat().find(p => p?.type === 'k' && p.color === myColor)?.square
  const answerMoves = item.answer.moves.map(u => u.slice(0, 4))

  const finish = (correct: boolean, extra: Record<string, unknown>) => {
    if (reveal || done.current || !ready) return
    done.current = true
    setSelected(null)
    onAnswer({ correct, response_ms: performance.now() - onset.current, extra })
  }
  const playThreat = (from: string, to: string): boolean => {
    if (!theirs) return false
    const mv = theirs.moves({ square: from as Square, verbose: true }).find(m => m.to === to)
    if (!mv) return false
    const uci = mv.from + mv.to
    finish(item.answer.kind !== 'none' && answerMoves.includes(uci), { said: 'move', move: uci + (mv.promotion ?? ''), san: mv.san })
    return false
  }
  const onSquare = (sq: string) => {
    if (reveal || !ready || done.current) return
    const piece = board.get(sq as Square)
    if (selected && theirs?.moves({ square: selected as Square, verbose: true }).some(m => m.to === sq)) {
      playThreat(selected, sq)
      return
    }
    if (piece && piece.color === theirColor) { setSelected(sq); return }
    if (piece && piece.color === myColor) {
      // tapping the piece (or king) that is under threat also answers
      const a = item.answer
      const correct = a.kind === 'capture' ? a.squares.includes(sq) : a.kind === 'mate' && sq === myKing
      finish(correct, { said: 'square', square: sq })
      return
    }
    setSelected(null)
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input')) return
      if (e.key === '0' || e.key.toLowerCase() === 'n') finish(item.answer.kind === 'none', { said: 'none' })
      if (e.key === 'Escape') setSelected(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const marks: Record<string, Mark> = { [item.last.slice(0, 2)]: 'last', [item.last.slice(2, 4)]: 'last' }
  if (selected && !reveal) {
    marks[selected] = 'selected'
    for (const m of theirs?.moves({ square: selected as Square, verbose: true }) ?? []) marks[m.to] = marks[m.to] ?? 'selected'
  }
  let arrows: Arrow[] = []
  let verdict = ''
  if (reveal) {
    const a = item.answer
    const playedMove = given?.extra?.move as string | undefined
    if (playedMove && !given?.correct) arrows.push([playedMove.slice(0, 2) as Square, playedMove.slice(2, 4) as Square, 'rgba(255,77,94,0.85)'])
    if (a.kind === 'none') verdict = 'No threat: that move didn\'t attack anything it could win, and there\'s no mate.'
    else {
      const mv = (playedMove && given?.correct ? playedMove : a.moves[0]) ?? ''
      let san = mv
      try { san = threatBoard(item.fen)!.move({ from: mv.slice(0, 2), to: mv.slice(2, 4), promotion: mv[4] ?? 'q' }).san } catch { /* keep uci */ }
      if (mv) arrows = [...arrows, [mv.slice(0, 2) as Square, mv.slice(2, 4) as Square, NEON]]
      for (const sq of a.squares) marks[sq] = 'target'
      const victim = a.kind === 'capture' ? board.get(a.squares[0] as Square) : null
      verdict = a.kind === 'mate'
        ? `They threaten mate: ${san}.`
        : `They threaten ${san}, winning your ${victim ? NAMES[victim.type] : 'piece'}${a.moves.length > 1 ? ` (${a.moves.length} winning captures in all)` : ''}.`
    }
    const sq = given?.extra?.square as string | undefined
    if (sq && !a.squares.includes(sq)) marks[sq] = 'wrong'
  }
  const side = item.orientation === 'white' ? 'White' : 'Black'

  return (
    <div className="flex flex-col items-center gap-4">
      <p className="text-sm text-text-1 text-center max-w-md">
        You are <b className="text-text-0">{side}</b>. Your opponent just played the highlighted move —
        <b className="text-accent"> play the threat for them</b> (drag their piece, or tap it then a square).
      </p>
      <DrillBoard id={`ot-${item.id}`} fen={fen} width={width} orientation={item.orientation} marks={marks} arrows={arrows}
        onSquare={onSquare} draggable={ready && !reveal} dragColor={theirColor} onDrop={playThreat} />
      {reveal ? (
        <p className={`text-sm font-medium text-center ${given?.correct ? 'text-accent' : 'text-text-0'}`}>{verdict}{item.own && <span className="text-accent"> · from one of your games</span>}</p>
      ) : (
        <div className="flex flex-wrap gap-3 w-full max-w-md items-center justify-center">
          <button className={choiceBtn} onClick={() => finish(item.answer.kind === 'none', { said: 'none' })} disabled={!ready}>
            No threat <kbd className="[@media(pointer:coarse)]:hidden ml-1 text-xs text-text-2">0</kbd>
          </button>
        </div>
      )}
    </div>
  )
}
