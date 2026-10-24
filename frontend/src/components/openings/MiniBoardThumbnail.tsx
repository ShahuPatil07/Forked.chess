import { memo, useMemo } from 'react'

/**
 * Lightweight 44px chess board thumbnail.
 *
 * Pure CSS grid + Unicode chess pieces — renders ~40 instances without
 * SVG cost. Used inside every OpeningTree node row.
 */

const PIECES: Record<string, string> = {
  P: '♙', N: '♘', B: '♗', R: '♖', Q: '♕', K: '♔',
  p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚',
}

/** Filled glyphs for both sides (coloured by CSS); U+FE0E forces text, not emoji, rendering. */
const SOLID: Record<string, string> = { p: '\u265F\uFE0E', n: '\u265E', b: '\u265D', r: '\u265C', q: '\u265B', k: '\u265A' }

const DARK_SQ  = '#5C5C5C'
const LIGHT_SQ = '#A9A9A9'

function parseFenBoard(fen: string): (string | null)[] {
  // 64-cell array, idx 0 = a8, idx 63 = h1 (visual row order)
  const board: (string | null)[] = Array(64).fill(null)
  const rows = fen.split(' ')[0].split('/')
  for (let r = 0; r < 8 && r < rows.length; r++) {
    let file = 0
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) {
        file += parseInt(ch, 10)
      } else {
        board[r * 8 + file] = ch
        file += 1
      }
    }
  }
  return board
}

function MiniBoardThumbnailInner({
  fen,
  size       = 44,
  orientation = 'white',
  solid      = false,
}: {
  fen: string
  size?: number
  orientation?: 'white' | 'black'
  /** larger filled pieces with an outline, for bigger thumbnails (Puzzle Themes cards) */
  solid?: boolean
}) {
  const cells = useMemo(() => {
    const arr = parseFenBoard(fen)
    return orientation === 'black' ? [...arr].reverse() : arr
  }, [fen, orientation])

  const cellPx  = size / 8
  const fontPx  = solid ? Math.max(9, Math.round(cellPx * 0.98)) : Math.max(8, Math.round(size / 8 * 0.9))

  return (
    <div
      className="rounded-[2px] overflow-hidden flex-shrink-0"
      style={{
        width:               size,
        height:              size,
        display:             'grid',
        gridTemplateColumns: `repeat(8, ${cellPx}px)`,
        gridTemplateRows:    `repeat(8, ${cellPx}px)`,
        boxShadow:           '0 0 0 1px rgba(200,255,42,0.18)',
      }}
    >
      {cells.map((piece, i) => {
        // i: 0..63 (a8..h1 for white orientation)
        const row     = Math.floor(i / 8)
        const col     = i % 8
        const isDark  = (row + col) % 2 === 1
        const isWhite = piece && piece === piece.toUpperCase()
        return (
          <div key={i}
            style={{
              backgroundColor: isDark ? DARK_SQ : LIGHT_SQ,
              color:           isWhite ? '#F5F5F5' : '#050505',
              fontSize:        fontPx,
              lineHeight:      `${cellPx}px`,
              textAlign:       'center',
              fontWeight:      900,
              userSelect:      'none',
              ...(solid && piece ? {
                textShadow: isWhite
                  ? '0 0 1px #050505, 0 0 1px #050505, 0 0 2px rgba(5,5,5,0.8)'
                  : '0 0 1px rgba(245,245,245,0.55)',
              } : {}),
            }}
          >
            {piece ? (solid ? SOLID[piece.toLowerCase()] : PIECES[piece]) : ''}
          </div>
        )
      })}
    </div>
  )
}

export const MiniBoardThumbnail = memo(MiniBoardThumbnailInner)
