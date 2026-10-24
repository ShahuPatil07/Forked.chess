import { useEffect, useRef, useState } from 'react'
import { Chess } from 'chess.js'
import type { CheckFlashItem } from '../api'
import { DrillBoard } from '../components/DrillBoard'
import { choiceBtn, type DrillProps } from './types'

/** Flash timing runs on requestAnimationFrame and hides the board by toggling a mask
 *  directly on the DOM (no React render in the timing path). */
export function CheckFlash({ item, reveal, given, width, onAnswer }: DrillProps<CheckFlashItem>) {
  const mask = useRef<HTMLDivElement>(null)
  const onset = useRef<number | null>(null)
  const [hidden, setHidden] = useState(false)
  const answered = useRef(false)
  const size = Math.min(width, 320)

  useEffect(() => {
    answered.current = false
    onset.current = null
    setHidden(false)
    if (mask.current) mask.current.style.opacity = '0'
    let raf = 0
    const tick = (t: number) => {
      if (onset.current === null) onset.current = t
      if (t - onset.current >= item.flash_ms) {
        if (mask.current) mask.current.style.opacity = '1'
        setHidden(true)
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [item.id, item.flash_ms])

  const answer = (check: boolean) => {
    if (answered.current || reveal) return
    answered.current = true
    onAnswer({ correct: check === item.answer, response_ms: performance.now() - (onset.current ?? performance.now()),
               extra: { said: check ? 'check' : 'none' } })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'c') answer(true)
      if (e.key === 'ArrowRight' || e.key.toLowerCase() === 'n') answer(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const king = new Chess(item.fen).board().flat().find(p => p?.type === 'k' && p.color === 'b')?.square
  const marks = reveal && king ? { [king]: item.answer ? 'target' as const : 'correct' as const } : undefined
  return (
    <div className="flex flex-col items-center gap-5">
      <div className="relative rounded-xl p-1.5 bg-bg-2 border border-border">
        <DrillBoard id={`cf-${item.id}`} fen={item.fen} width={size} window={item.window} marks={marks} />
        <div ref={mask} aria-hidden={!hidden}
          className="absolute inset-1.5 rounded-lg grid place-items-center bg-[repeating-linear-gradient(45deg,#151515_0_10px,#0C0C0C_10px_20px)] transition-opacity duration-75"
          style={{ opacity: 0, display: reveal ? 'none' : undefined }}>
          <span className="font-display text-5xl text-text-2">?</span>
        </div>
      </div>
      {reveal ? (
        <p className={`text-lg font-semibold ${given?.correct ? 'text-accent' : 'text-danger'}`}>
          {item.answer ? 'Check' : 'Not check'}{given ? (given.correct ? ' · right' : ' · missed') : ' · too slow'}
        </p>
      ) : (
        <div className="flex gap-3 w-full max-w-sm">
          <button className={choiceBtn} onClick={() => answer(true)}>Check <kbd className="[@media(pointer:coarse)]:hidden ml-1 text-xs text-text-2">←</kbd></button>
          <button className={choiceBtn} onClick={() => answer(false)}>Not check <kbd className="[@media(pointer:coarse)]:hidden ml-1 text-xs text-text-2">→</kbd></button>
        </div>
      )}
    </div>
  )
}
