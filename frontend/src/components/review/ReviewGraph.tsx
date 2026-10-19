import type { MoveClass, ReviewMove } from '../../api/gameReview'

const MARK: Partial<Record<MoveClass, string>> = {
  brilliant: '#37c4bd', great: '#82aafa', miss: '#e58a6c', mistake: '#f29a52', blunder: '#f06470',
}

function whitePct(m: ReviewMove): number {
  const s = m.played_score
  if (s.white_mate !== null) return s.white_mate > 0 ? 100 : 0
  return 100 / (1 + Math.exp(-0.00368208 * (s.white_cp ?? 0)))
}

/** Chess.com-style advantage chart: White's share as a filled area over the
 *  50% line, with dots on the moments that matter. Click to jump to a move. */
export function ReviewGraph({ moves, selected, onSelect }: { moves: ReviewMove[]; selected: number; onSelect: (ply: number) => void }) {
  const W = 600, H = 110
  const n = Math.max(1, moves.length)
  const x = (i: number) => (i / n) * W
  const y = (pct: number) => H - (pct / 100) * H
  const pts = [[0, 50], ...moves.map((m, i) => [i + 1, whitePct(m)])] as [number, number][]
  const area = `M0,${H} ` + pts.map(([i, p]) => `L${x(i).toFixed(1)},${y(p).toFixed(1)}`).join(' ') + ` L${x(n)},${H} Z`
  const line = pts.map(([i, p], k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(p).toFixed(1)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-28 cursor-pointer select-none" role="img" aria-label="Game advantage graph"
      onClick={e => {
        const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
        onSelect(Math.max(0, Math.min(moves.length, Math.round(((e.clientX - r.left) / r.width) * n))))
      }}>
      <rect x="0" y="0" width={W} height={H} fill="#121212" />
      <path d={area} fill="#EDEDED" />
      <line x1="0" y1={H / 2} x2={W} y2={H / 2} stroke="#6B6B6B" strokeDasharray="4 4" strokeWidth="1" />
      <path d={line} fill="none" stroke="#C8FF2A" strokeWidth="1.2" />
      {moves.map((m, i) => MARK[m.classification] && (
        <circle key={m.ply} cx={x(i + 1)} cy={y(whitePct(m))} r={4} fill={MARK[m.classification]} stroke="#050505" strokeWidth="1.2">
          <title>{`${m.move_number}${m.color === 'white' ? '.' : '…'} ${m.san} — ${m.classification}`}</title>
        </circle>
      ))}
      <line x1={x(selected)} x2={x(selected)} y1="0" y2={H} stroke="#D7FF5C" strokeWidth="1.5" opacity=".9" />
    </svg>
  )
}
