import { useEffect, useRef } from 'react'
import type { DoubleCheckItem } from '../api'
import { DrillBoard } from '../components/DrillBoard'
import type { DrillProps } from './types'

export function DoubleCheckHunt({ item, reveal, given, width, onAnswer }: DrillProps<DoubleCheckItem>) {
  const onset = useRef(performance.now())
  const done = useRef(false)
  useEffect(() => { onset.current = performance.now(); done.current = false }, [item.id])
  const cols = width < 420 ? 2 : 3
  const size = Math.floor((Math.min(width, 560) - (cols - 1) * 12) / cols) - 12
  const chosen = typeof given?.extra?.chosen === 'number' ? (given.extra.chosen as number) : null

  const pick = (k: number) => {
    if (done.current || reveal) return
    done.current = true
    onAnswer({ correct: k === item.answer, response_ms: performance.now() - onset.current, extra: { chosen: k } })
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { const n = Number(e.key); if (n >= 1 && n <= 6) pick(n - 1) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {item.boards.map((b, k) => {
        const right = reveal && k === item.answer
        const wrong = reveal && chosen === k && k !== item.answer
        return (
          <button key={k} onClick={() => pick(k)} aria-label={`Board ${k + 1}`}
            className={`relative rounded-xl p-1.5 border transition-all ${right ? 'border-accent shadow-neon bg-accent/10'
              : wrong ? 'border-danger bg-danger/10' : 'border-border bg-bg-2 hover:border-accent/50'}`}>
            <DrillBoard id={`dc-${item.id}-${k}`} fen={b.fen} width={size} window={b.window} />
            <span className="absolute top-2.5 left-2.5 w-6 h-6 rounded-md grid place-items-center text-xs font-bold bg-bg-0/85 text-text-0">{k + 1}</span>
            {reveal && <span className="absolute bottom-2.5 right-2.5 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-bg-0/85 text-text-1">
              {b.checkers === 2 ? 'double' : b.checkers === 1 ? 'check' : 'no check'}</span>}
          </button>
        )
      })}
    </div>
  )
}
