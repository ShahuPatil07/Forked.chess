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

const DARK_SQ  = '#1A1D36'
const LIGHT_SQ = '#343761'

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
}: {
  fen: string
  size?: number
  orientation?: 'white' | 'black'
}) {
  const cells = useMemo(() => {
    const arr = parseFenBoard(fen)
    return orientation === 'black' ? [...arr].reverse() : arr
  }, [fen, orientation])

  const cellPx  = size / 8
  const fontPx  = Math.max(8, Math.round(size / 8 * 0.9))

  return (
    <div
      className="rounded-[2px] overflow-hidden flex-shrink-0"
      style={{
        width:               size,
        height:              size,
        display:             'grid',
        gridTemplateColumns: `repeat(8, ${cellPx}px)`,
        gridTemplateRows:    `repeat(8, ${cellPx}px)`,
        boxShadow:           '0 0 0 1px rgba(123,97,255,0.18)',
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
              color:           isWhite ? '#EEEEF2' : '#0B0B0F',
              fontSize:        fontPx,
              lineHeight:      `${cellPx}px`,
              textAlign:       'center',
              fontWeight:      900,
              userSelect:      'none',
            }}
          >
            {piece ? PIECES[piece] : ''}
          </div>
        )
      })}
    </div>
  )
}

export const MiniBoardThumbnail = memo(MiniBoardThumbnailInner)
