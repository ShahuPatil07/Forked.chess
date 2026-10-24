import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Chess, type Square } from 'chess.js'
import type { Arrow } from 'react-chessboard/dist/chessboard/types'
import type { TwoCandidatesItem } from '../api'
import { DrillBoard, type Mark } from '../components/DrillBoard'
import { NEON } from '../../../theme'
import type { DrillProps } from './types'

interface Cand { san: string; uci: string }

const evalText = (cp: number | undefined) =>
  cp === undefined ? 'not in the engine top 5' : Math.abs(cp) >= 9000 ? (cp > 0 ? 'mates' : 'gets mated') : `${cp >= 0 ? '+' : ''}${(cp / 100).toFixed(1)}`

export function TwoCandidates({ item, reveal, given, width, onAnswer }: DrillProps<TwoCandidatesItem>) {
  const [cands, setCands] = useState<Cand[]>([])
  const [selected, setSelected] = useState<Square | null>(null)
  const [typed, setTyped] = useState('')
  const [warn, setWarn] = useState('')
  const onset = useRef(performance.now())
  const done = useRef(false)
  const board = useMemo(() => new Chess(item.fen), [item.fen])
  useEffect(() => { setCands([]); setSelected(null); setWarn(''); onset.current = performance.now(); done.current = false }, [item.id])

  const add = (from: string, to: string): boolean => {
    if (reveal || cands.length >= 2) return false
    const c = new Chess(item.fen)
    let m
    try { m = c.move({ from, to, promotion: 'q' }) } catch { return false }
    const cand = { san: m.san, uci: m.from + m.to + (m.promotion ?? '') }
    if (cands.some(x => x.uci === cand.uci)) { setWarn('Pick a different move for your second candidate.'); return false }
    setWarn(''); setCands(cs => [...cs, cand]); setSelected(null)
    return false                                     // never leave the move on the board: the position resets
  }
  const onSquare = (sq: string) => {
    if (reveal || cands.length >= 2) return
    if (selected) {
      if (board.moves({ square: selected, verbose: true }).some(m => m.to === sq)) { add(selected, sq); return }
    }
    const p = board.get(sq as Square)
    setSelected(p && p.color === board.turn() ? (sq as Square) : null)
  }
  const typedMove = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    const c = new Chess(item.fen)
    try { const m = c.move(typed.trim()); add(m.from, m.to); setTyped('') } catch { setWarn(`"${typed}" isn't legal here.`) }
  }
  const choose = (c: Cand) => {
    if (done.current || reveal) return
    done.current = true
    const correct = item.best.includes(c.uci)
    onAnswer({ correct, response_ms: performance.now() - onset.current,
               extra: { chosen: c.san, candidates: cands.map(x => x.san), best_in_candidates: cands.some(x => item.best.includes(x.uci)) } })
  }

  const marks: Record<string, Mark> = { [item.last.slice(0, 2)]: 'last', [item.last.slice(2, 4)]: 'last' }
  if (selected) marks[selected] = 'selected'
  let arrows: Arrow[] = []
  if (reveal) {
    const best = item.best[0]
    const t = new Chess(item.fen).moves({ verbose: true }).find(m => m.san === item.tempting_san)
    arrows = [[best.slice(0, 2) as Square, best.slice(2, 4) as Square, NEON]]
    if (t) arrows.push([t.from as Square, t.to as Square, 'rgba(245,245,245,0.75)'])
  }
  const chosen = given?.extra?.chosen as string | undefined
  const shownCands = reveal ? ((given?.extra?.candidates as string[]) ?? cands.map(c => c.san)) : cands.map(c => c.san)
  const side = item.orientation === 'white' ? 'White' : 'Black'

  return (
    <div className="flex flex-col items-center gap-4">
      <p className="text-sm text-text-1 text-center">You are <b className="text-text-0">{side}</b>, after your opponent's highlighted move. Find <b className="text-accent">two</b> candidate moves before you choose.</p>
      <DrillBoard id={`tw-${item.id}`} fen={item.fen} width={width} orientation={item.orientation} marks={marks} arrows={arrows}
        onSquare={onSquare} draggable={!reveal && cands.length < 2} onDrop={(f, t) => add(f, t)} />
      <div className="grid grid-cols-2 gap-3 w-full max-w-md">
        {[0, 1].map(i => {
          const san = shownCands[i]
          const isBest = reveal && san && item.evals[san] !== undefined && item.best.some(u => {
            const m = new Chess(item.fen).moves({ verbose: true }).find(mm => mm.from + mm.to + (mm.promotion ?? '') === u)
            return m?.san === san
          })
          return (
            <div key={i} className={`rounded-xl border px-3 py-2.5 ${san ? 'border-accent/40 bg-accent/[0.06]' : 'border-dashed border-border'}`}>
              <p className="text-[10px] uppercase tracking-wider text-text-2">Candidate {i + 1}</p>
              <p className="font-mono text-lg text-text-0 mt-0.5">{san ?? '—'}</p>
              {reveal && san && <p className={`text-[11px] mt-0.5 ${isBest ? 'text-accent' : 'text-text-2'}`}>{evalText(item.evals[san])}{chosen === san ? ' · chosen' : ''}</p>}
            </div>
          )
        })}
      </div>
      {!reveal && cands.length < 2 && (
        <input value={typed} onChange={e => setTyped(e.target.value)} onKeyDown={typedMove} aria-label="Type a move"
          placeholder="Play on the board, or type a move (e.g. Nf3)" className="input max-w-md text-sm font-mono" />
      )}
      {warn && !reveal && <p className="text-xs text-warn">{warn}</p>}
      {!reveal && cands.length === 2 && (
        <div className="w-full max-w-md">
          <p className="text-xs text-text-2 mb-2 text-center">Which one do you play?</p>
          <div className="flex gap-3">
            {cands.map(c => (
              <button key={c.uci} onClick={() => choose(c)} className="flex-1 btn-primary py-3 font-mono text-base">{c.san}</button>
            ))}
          </div>
          <button onClick={() => setCands([])} className="mt-2 w-full text-xs text-text-2 hover:text-text-0">Start over</button>
        </div>
      )}
      {reveal && (
        <div className="text-sm text-center max-w-md leading-relaxed">
          <p className={given?.correct ? 'text-accent font-medium' : 'text-text-0 font-medium'}>
            Best: {item.best_san} ({evalText(item.evals[item.best_san])}). The tempting {item.tempting_san} only gets {evalText(item.evals[item.tempting_san])}.
          </p>
          <p className="text-text-2 text-xs mt-1">
            {given?.extra?.best_in_candidates ? 'You had the best move among your candidates.' : 'The best move was not among your two candidates.'}
          </p>
        </div>
      )}
    </div>
  )
}
