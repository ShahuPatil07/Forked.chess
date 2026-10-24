import { useEffect, useRef } from 'react'
import type { ThreatCountItem } from '../api'
import { DrillBoard, type Mark } from '../components/DrillBoard'
import type { DrillProps } from './types'

export function ThreatCount({ item, reveal, given, width, onAnswer }: DrillProps<ThreatCountItem>) {
  const onset = useRef(performance.now())
  const done = useRef(false)
  useEffect(() => { onset.current = performance.now(); done.current = false }, [item.id])
  const pick = (n: number) => {
    if (reveal || done.current) return
    done.current = true
    const correct = n === item.answer || (n >= 5 && item.answer >= 5)
    onAnswer({ correct, response_ms: performance.now() - onset.current, extra: { said: n } })
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (/^[0-5]$/.test(e.key)) pick(Number(e.key)) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const marks: Record<string, Mark> = {}
  if (reveal) for (const sq of item.squares) marks[sq] = 'target'
  const said = given?.extra?.said as number | undefined
  const side = item.orientation === 'white' ? 'White' : 'Black'
  const hanging = item.variant === 'hanging' || item.variant === 'undefended'
  return (
    <div className="flex flex-col items-center gap-4">
      <p className="text-sm text-text-1 text-center max-w-md">
        You are <b className="text-text-0">{side}</b>. How many of your pieces are{' '}
        <b className="text-accent">{hanging ? 'hanging — free to take' : 'really in danger'}</b>?
        <span className="block text-[11px] text-text-2 mt-1">
          {hanging ? 'Attacked, and nothing can take back.' : 'The opponent wins material by taking them. A queen hitting a defended knight doesn\'t count.'}
          {' '}Knights, bishops, rooks and queens only.
        </span>
      </p>
      <DrillBoard id={`tc-${item.id}`} fen={item.fen} width={width} orientation={item.orientation} marks={marks} />
      <div className="grid grid-cols-6 gap-2 w-full max-w-md">
        {[0, 1, 2, 3, 4, 5].map(n => {
          const isTruth = reveal && (n === item.answer || (n === 5 && item.answer >= 5))
          const isWrong = reveal && said === n && !isTruth
          return (
            <button key={n} onClick={() => pick(n)} disabled={reveal}
              className={`h-14 rounded-xl border text-xl font-display font-semibold transition-all
                ${isTruth ? 'border-accent bg-accent text-accent-ink' : isWrong ? 'border-danger bg-danger/15 text-danger'
                  : 'border-border bg-bg-1 hover:border-accent/50 text-text-0'}`}>
              {n === 5 ? '5+' : n}
            </button>
          )
        })}
      </div>
    </div>
  )
}
