import { useEffect, useMemo, useRef, useState } from 'react'
import { Chess, type Square } from 'chess.js'
import type { LooseItem } from '../api'
import { DrillBoard, SquareInput, type Mark } from '../components/DrillBoard'
import type { DrillProps } from './types'

export function LoosePieces({ item, reveal, given, width, onAnswer }: DrillProps<LooseItem>) {
  const [sel, setSel] = useState<string[]>([])
  const onset = useRef(performance.now())
  const done = useRef(false)
  const board = useMemo(() => new Chess(item.fen), [item.fen])
  useEffect(() => { setSel([]); onset.current = performance.now(); done.current = false }, [item.id])

  const toggle = (sq: string) => {
    if (reveal || done.current) return
    const p = board.get(sq as Square)
    if (!p || p.type === 'k' || (p.type === 'p' && !item.include_pawns)) return
    setSel(s => (s.includes(sq) ? s.filter(x => x !== sq) : [...s, sq]))
  }
  const submit = () => {
    if (reveal || done.current) return
    done.current = true
    const truth = new Set(item.answer)
    const tp = sel.filter(s => truth.has(s)).length
    const precision = sel.length ? tp / sel.length : (truth.size ? 0 : 1)
    const recall = truth.size ? tp / truth.size : 1
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0
    onAnswer({ correct: f1 === 1, score: Math.round(f1 * 1000) / 1000, response_ms: performance.now() - onset.current,
               extra: { tapped: sel } })
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter' && !(e.target as HTMLElement)?.closest('input')) submit() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const marks: Record<string, Mark> = {}
  const tapped = reveal ? ((given?.extra?.tapped as string[]) ?? []) : sel
  if (reveal) {
    for (const sq of item.answer) marks[sq] = tapped.includes(sq) ? 'correct' : 'missed'
    for (const sq of tapped) if (!item.answer.includes(sq)) marks[sq] = 'wrong'
  } else for (const sq of sel) marks[sq] = 'selected'

  return (
    <div className="flex flex-col items-center gap-4">
      <DrillBoard id={`lp-${item.id}`} fen={item.fen} width={width} orientation={item.orientation} marks={marks} onSquare={toggle} />
      <div className="flex flex-wrap items-center justify-center gap-3">
        <span className="text-sm text-text-1 tabular-nums">{sel.length} tapped</span>
        <SquareInput onSquare={toggle} disabled={reveal} />
        <button onClick={submit} disabled={reveal} className="btn-primary px-6">Done <kbd className="[@media(pointer:coarse)]:hidden ml-1 text-xs opacity-60">Enter</kbd></button>
      </div>
      {reveal && (
        <p className="text-sm text-text-1 text-center">
          Undefended: <span className="font-mono text-text-0">{item.answer.join(', ')}</span>
          {item.own && <span className="text-accent"> · from one of your games</span>}
        </p>
      )}
    </div>
  )
}
