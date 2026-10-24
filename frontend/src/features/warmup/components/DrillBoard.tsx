import { forwardRef, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { Chessboard } from 'react-chessboard'
import type { Arrow, Square } from 'react-chessboard/dist/chessboard/types'
import { BOARD_DARK, BOARD_LIGHT, LAST_MOVE, NEON, NEON_RGB } from '../../../theme'

/**
 * Board for warm-up drills: real pieces, real geometry (react-chessboard), with
 *  - an optional region window ([file0, rank0, size]) for the mini-board check drills, done by
 *    cropping a full board so geometry stays exact;
 *  - colour-blind-safe marks: each mark differs by PATTERN as well as colour
 *    (solid ring = selected, filled = correct, white stripes = missed, red cross-hatch = wrong).
 */
export type Mark = 'selected' | 'correct' | 'missed' | 'wrong' | 'last' | 'target'

const MARK: Record<Mark, CSSProperties> = {
  selected: { boxShadow: `inset 0 0 0 4px ${NEON}`, backgroundColor: `rgba(${NEON_RGB},0.18)` },
  correct: { boxShadow: `inset 0 0 0 4px ${NEON}`, backgroundColor: `rgba(${NEON_RGB},0.55)` },
  missed: { boxShadow: 'inset 0 0 0 3px #F5F5F5', backgroundImage: 'repeating-linear-gradient(45deg, rgba(245,245,245,.5) 0 5px, transparent 5px 11px)' },
  wrong: { boxShadow: 'inset 0 0 0 3px #FF4D5E', backgroundImage: 'repeating-linear-gradient(45deg, rgba(255,77,94,.45) 0 4px, transparent 4px 9px), repeating-linear-gradient(-45deg, rgba(255,77,94,.45) 0 4px, transparent 4px 9px)' },
  last: { backgroundColor: LAST_MOVE },
  target: { boxShadow: `inset 0 0 0 5px ${NEON}`, backgroundImage: `radial-gradient(circle, rgba(${NEON_RGB},.55) 30%, transparent 32%)` },
}

interface Props {
  fen: string
  width: number
  orientation?: 'white' | 'black'
  window?: [number, number, number]
  marks?: Partial<Record<string, Mark>>
  arrows?: Arrow[]
  onSquare?: (sq: string) => void
  id: string
  notation?: boolean
  style?: CSSProperties
  draggable?: boolean
  onDrop?: (from: string, to: string) => boolean
  /** restrict dragging, e.g. to the opponent's pieces ('w' | 'b') */
  dragColor?: 'w' | 'b'
}

export const DrillBoard = forwardRef<HTMLDivElement, Props>(function DrillBoard(
  { fen, width, orientation = 'white', window, marks, arrows, onSquare, id, notation = true, style, draggable = false, onDrop, dragColor }, ref,
) {
  const k = window ? window[2] : 8
  const cell = width / k
  const full = cell * 8
  const styles = useMemo(() => {
    const s: Record<string, CSSProperties> = {}
    for (const [sq, m] of Object.entries(marks ?? {})) if (m) s[sq] = { ...(s[sq] ?? {}), ...MARK[m] }
    return s
  }, [marks])
  let left = 0, top = 0
  if (window) {
    const [f0, r0] = window
    if (orientation === 'white') { left = -f0 * cell; top = -(7 - (r0 + k - 1)) * cell }
    else { left = -(7 - (f0 + k - 1)) * cell; top = -r0 * cell }
  }
  return (
    <div ref={ref} style={{ width, height: width, overflow: 'hidden', position: 'relative', borderRadius: 8, ...style }}>
      <div style={{ position: 'absolute', left, top, width: full }}>
        <Chessboard id={id} position={fen} boardWidth={full} boardOrientation={orientation}
          arePiecesDraggable={draggable} onPieceDrop={onDrop ? (f, t) => onDrop(f, t) : undefined}
          isDraggablePiece={dragColor ? ({ piece }) => piece[0] === dragColor : undefined}
          onSquareClick={onSquare ? (sq: Square) => onSquare(sq) : undefined}
          customSquareStyles={styles} customArrows={arrows} showBoardNotation={notation && !window}
          customDarkSquareStyle={{ backgroundColor: BOARD_DARK }} customLightSquareStyle={{ backgroundColor: BOARD_LIGHT }}
          animationDuration={140} />
      </div>
    </div>
  )
})

/** Width that fits the container (and the viewport height on phones). */
export function useBoardWidth(max = 520): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(Math.min(max, 360))
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setW(Math.max(220, Math.min(max, el.clientWidth, window.innerHeight - 260)))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [max])
  return [ref, w]
}

/** Keyboard / screen-reader alternative to tapping: type squares like "e4". */
export function SquareInput({ onSquare, placeholder = 'Square, e.g. e4', disabled }: {
  onSquare: (sq: string) => void; placeholder?: string; disabled?: boolean
}) {
  const [v, setV] = useState('')
  const submit = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    const sq = v.trim().toLowerCase()
    if (/^[a-h][1-8]$/.test(sq)) { onSquare(sq); setV('') }
  }
  return (
    <input value={v} onChange={e => setV(e.target.value)} onKeyDown={submit} disabled={disabled}
      aria-label="Type a square" placeholder={placeholder}
      className="input !w-40 py-1.5 text-sm font-mono" />
  )
}

/** Reduced-motion preference: the OS setting, overridable on the Warm-Up page. */
export function prefersReducedMotion(): boolean {
  try {
    const o = localStorage.getItem('forked-warmup-reduced-motion')
    if (o !== null) return o === '1'
  } catch { /* private mode */ }
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}
