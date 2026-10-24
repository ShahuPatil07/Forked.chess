import { useEffect, useRef, useState, type MouseEvent } from 'react'
import type { WhatChangedItem } from '../api'
import { DrillBoard, type Mark } from '../components/DrillBoard'
import type { DrillProps } from './types'

const BLANK_MS = 250
const FILES = 'abcdefgh'

/** The square under a click on a board of `width` px with this orientation. */
function squareAt(e: MouseEvent<HTMLElement>, width: number, orientation: 'white' | 'black'): string | null {
  const r = e.currentTarget.getBoundingClientRect()
  const cell = width / 8
  const c = Math.floor((e.clientX - r.left) / cell), row = Math.floor((e.clientY - r.top) / cell)
  if (c < 0 || c > 7 || row < 0 || row > 7) return null
  const file = orientation === 'white' ? c : 7 - c
  const rank = orientation === 'white' ? 7 - row : row
  return `${FILES[file]}${rank + 1}`
}

/**
 * Change-blindness drill. A / blank / B / blank ... repeats until answered: the blank
 * (~250 ms) masks the motion cue, so the change has to be found by comparing positions.
 * Answer by TAPPING a square the piece moved from or to — taps register on every frame
 * (a transparent layer maps the tap to a square), so the flicker never eats a click.
 * Reduced motion: no flicker — A and B side by side, tap on B.
 */
export function WhatChanged({ item, reveal, given, width, reducedMotion, onAnswer }: DrillProps<WhatChangedItem>) {
  const layerA = useRef<HTMLDivElement>(null)
  const layerB = useRef<HTMLDivElement>(null)
  const blank = useRef<HTMLDivElement>(null)
  const firstB = useRef<number | null>(null)
  const done = useRef(false)
  const [tapped, setTapped] = useState<string | null>(null)

  useEffect(() => {
    done.current = false
    firstB.current = null
    setTapped(null)
    if (reducedMotion) { firstB.current = performance.now(); return }
    let raf = 0
    let t0: number | null = null
    let shown = ''
    const cycle = 2 * (item.show_ms + BLANK_MS)
    const show = (which: 'a' | 'b' | 'blank') => {
      if (which === shown) return
      shown = which
      if (layerA.current) layerA.current.style.visibility = which === 'a' ? 'visible' : 'hidden'
      if (layerB.current) layerB.current.style.visibility = which === 'b' ? 'visible' : 'hidden'
      if (blank.current) blank.current.style.visibility = which === 'blank' ? 'visible' : 'hidden'
    }
    const tick = (t: number) => {
      if (t0 === null) t0 = t
      const x = (t - t0) % cycle
      if (x < item.show_ms) show('a')
      else if (x < item.show_ms + BLANK_MS) show('blank')
      else if (x < 2 * item.show_ms + BLANK_MS) {
        if (firstB.current === null) firstB.current = t
        show('b')
      } else show('blank')
      if (!done.current) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [item.id, item.show_ms, reducedMotion])

  // On reveal (or answer), freeze on B
  useEffect(() => {
    if (!reveal) return
    done.current = true
    if (layerA.current) layerA.current.style.visibility = 'hidden'
    if (layerB.current) layerB.current.style.visibility = 'visible'
    if (blank.current) blank.current.style.visibility = 'hidden'
  }, [reveal])

  const tap = (sq: string | null) => {
    if (!sq || reveal || done.current) return
    done.current = true
    setTapped(sq)
    onAnswer({ correct: item.answer.includes(sq), response_ms: performance.now() - (firstB.current ?? performance.now()),
               extra: { tapped: sq } })
  }

  const marks: Record<string, Mark> = {}
  if (tapped && !reveal) marks[tapped] = 'selected'
  if (reveal) {
    marks[item.answer[0]] = 'missed'
    marks[item.answer[1]] = 'correct'
    const t = (given?.extra?.tapped as string | undefined) ?? tapped
    if (t && !item.answer.includes(t)) marks[t] = 'wrong'
  }
  const pieceLabel = pieceName(item.piece)

  if (reducedMotion) {
    const w = Math.floor((width - 12) / 2)
    return (
      <div className="flex flex-col items-center gap-3">
        <div className="flex gap-3">
          <div><p className="text-[11px] text-text-2 mb-1">Before</p>
            <DrillBoard id={`wa-${item.id}`} fen={item.fen_a} width={w} orientation={item.orientation} notation={false} /></div>
          <div><p className="text-[11px] text-text-2 mb-1">After: tap where a piece moved</p>
            <DrillBoard id={`wb-${item.id}`} fen={item.fen_b} width={w} orientation={item.orientation} marks={marks} onSquare={tap} notation={false} /></div>
        </div>
        {reveal && <p className="text-sm text-text-1">The <b className="text-text-0">{pieceLabel}</b> went {item.answer[0]} → {item.answer[1]}</p>}
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <p className="text-sm text-text-1 text-center">One piece moves between the two flashes. <b className="text-accent">Tap the square it left or the square it landed on.</b></p>
      <div className="relative" style={{ width, height: width }}>
        <div ref={layerA} className="absolute inset-0">
          <DrillBoard id={`wa-${item.id}`} fen={item.fen_a} width={width} orientation={item.orientation} />
        </div>
        <div ref={layerB} className="absolute inset-0" style={{ visibility: 'hidden' }}>
          <DrillBoard id={`wb-${item.id}`} fen={item.fen_b} width={width} orientation={item.orientation} marks={marks} />
        </div>
        <div ref={blank} className="absolute inset-0 rounded-lg bg-bg-2 pointer-events-none" style={{ visibility: 'hidden' }} />
        {/* tap layer: works on every frame of the flicker */}
        {!reveal && (
          <div className="absolute inset-0 cursor-pointer" role="button" aria-label="Tap the square that changed"
            onClick={e => tap(squareAt(e, width, item.orientation))} />
        )}
      </div>
      {reveal && <span className="text-sm text-text-1">The <b className="text-text-0">{pieceLabel}</b> went {item.answer[0]} → {item.answer[1]}</span>}
    </div>
  )
}

const pieceName = (p: string) => ({ p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' } as Record<string, string>)[p.toLowerCase()]
