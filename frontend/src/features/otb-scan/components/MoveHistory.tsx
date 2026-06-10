interface Props {
  moves: string[]
  lastMove: string | null
}

// Compact two-column SAN move list.
export function MoveHistory({ moves }: Props) {
  const rows: { num: number; white: string; black: string }[] = []
  for (let i = 0; i < moves.length; i += 2) {
    rows.push({
      num: i / 2 + 1,
      white: moves[i],
      black: moves[i + 1] ?? '',
    })
  }

  return (
    <div className="card p-3 h-full overflow-y-auto">
      <p className="text-[10px] text-text-2 uppercase tracking-wider mb-2">Moves</p>
      {rows.length === 0 ? (
        <p className="text-xs text-text-2">No moves yet.</p>
      ) : (
        <div className="space-y-0.5 text-sm tabular-nums">
          {rows.map((r, i) => {
            const isLastRow = i === rows.length - 1
            return (
              <div key={r.num} className="flex gap-2">
                <span className="text-text-2 w-6 text-right">{r.num}.</span>
                <span
                  className={`w-14 ${isLastRow && !r.black ? 'text-accent font-semibold' : 'text-text-0'}`}
                >
                  {r.white}
                </span>
                <span
                  className={`w-14 ${isLastRow && r.black ? 'text-accent font-semibold' : 'text-text-0'}`}
                >
                  {r.black}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
