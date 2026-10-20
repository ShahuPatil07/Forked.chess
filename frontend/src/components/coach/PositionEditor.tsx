import { useState } from 'react'
import { Loader2, Minus, Plus, Shuffle, Check, Scale } from 'lucide-react'
import { coachApi, type ConfiguratorEvent, type GeneratedPosition, type PieceCounts } from '../../api/coach'

const ORDER: (keyof PieceCounts)[] = ['Q', 'R', 'B', 'N', 'P']
const MAX: PieceCounts = { Q: 1, R: 2, B: 2, N: 2, P: 8 }
const NAMES: Record<keyof PieceCounts, string> = { Q: 'Queen', R: 'Rook', B: 'Bishop', N: 'Knight', P: 'Pawn' }
const GLYPH = { white: { Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙' }, black: { Q: '♛', R: '♜', B: '♝', N: '♞', P: '♟' } }
const MAX_PER_SIDE = 7
const total = (c: PieceCounts) => ORDER.reduce((s, k) => s + c[k], 0)
const same = (a: PieceCounts, b: PieceCounts) => ORDER.every(k => a[k] === b[k])

function Side({ side, counts, onChange }: { side: 'white' | 'black'; counts: PieceCounts; onChange: (c: PieceCounts) => void }) {
  return (
    <div className="flex-1 min-w-0 space-y-1">
      <p className="text-[11px] font-medium text-text-1 capitalize">{side} <span className="text-text-2">· K + {total(counts)}</span></p>
      {ORDER.map(k => (
        <div key={k} className="flex items-center gap-1.5 text-xs">
          <span className="w-4 text-base leading-none text-text-0" aria-hidden="true">{GLYPH[side][k]}</span>
          <span className="flex-1 text-text-2 truncate">{NAMES[k]}</span>
          <button type="button" aria-label={`Fewer ${side} ${NAMES[k]}s`} disabled={!counts[k]}
            onClick={() => onChange({ ...counts, [k]: counts[k] - 1 })}
            className="w-5 h-5 rounded border border-border flex items-center justify-center text-text-1 hover:border-accent/40 disabled:opacity-30"><Minus size={10} /></button>
          <span className="w-4 text-center tabular-nums text-text-0">{counts[k]}</span>
          <button type="button" aria-label={`More ${side} ${NAMES[k]}s`} disabled={counts[k] >= MAX[k] || total(counts) >= MAX_PER_SIDE}
            onClick={() => onChange({ ...counts, [k]: counts[k] + 1 })}
            className="w-5 h-5 rounded border border-border flex items-center justify-center text-text-1 hover:border-accent/40 disabled:opacity-30"><Plus size={10} /></button>
        </div>
      ))}
    </div>
  )
}

/** The coach's reading of "set up a rook endgame" — pre-filled, adjustable, then generated.
 *  Balanced material gives an equal position; the user is to move. */
export function PositionEditor({ initial, onGenerated }: {
  initial: ConfiguratorEvent
  onGenerated: (pos: GeneratedPosition) => void
}) {
  const [white, setWhite] = useState<PieceCounts>(initial.white)
  const [black, setBlack] = useState<PieceCounts>(initial.black)
  const [color, setColor] = useState<'white' | 'black'>(initial.user_color)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [made, setMade] = useState<GeneratedPosition[]>([])
  const balanced = same(white, black)

  async function generate() {
    setBusy(true); setError(null)
    try {
      const pos = await coachApi.generatePosition(white, black, color, made.map(m => m.fen))
      setMade(m => [...m, pos])
      onGenerated(pos)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not build that position.')
    } finally { setBusy(false) }
  }

  return (
    <div className="rounded-xl border border-border bg-bg-1 p-3 space-y-3 max-w-md">
      <div className="flex items-center gap-2 text-xs">
        <Scale size={13} className="text-accent" />
        <span className="text-text-0 font-medium">{initial.label || 'Position editor'}</span>
        <span className="text-text-2">· adjust, then generate</span>
      </div>
      <div className="flex gap-4">
        <Side side="white" counts={white} onChange={setWhite} />
        <Side side="black" counts={black} onChange={setBlack} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-text-2">I play</span>
        {(['white', 'black'] as const).map(c => (
          <button key={c} type="button" onClick={() => setColor(c)}
            className={`px-2 py-0.5 rounded border capitalize ${color === c ? 'border-accent/50 bg-accent/10 text-accent' : 'border-border text-text-1'}`}>{c}</button>
        ))}
        <span className={`ml-auto text-[11px] ${balanced ? 'text-accent' : 'text-text-2'}`}>
          {balanced ? 'Balanced → an equal position' : 'Unbalanced → a practice position'}
        </span>
      </div>
      {error && <p className="text-[11px] text-danger">{error}</p>}
      <div className="flex items-center gap-2">
        <button type="button" onClick={generate} disabled={busy || total(white) + total(black) === 0}
          className="flex items-center gap-1.5 rounded-md bg-accent hover:bg-accent-hover text-accent-ink text-xs px-3 py-1.5 disabled:opacity-40">
          {busy ? <Loader2 size={12} className="animate-spin" /> : made.length ? <Shuffle size={12} /> : <Check size={12} />}
          {made.length ? 'Another one' : 'Generate position'}
        </button>
        {made.length > 0 && !busy && (
          <span className="text-[11px] text-text-2 truncate">On the board: {made[made.length - 1].description}</span>
        )}
      </div>
    </div>
  )
}
