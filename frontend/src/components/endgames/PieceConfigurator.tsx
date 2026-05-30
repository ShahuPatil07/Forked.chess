import { useState, useMemo } from 'react'
import { motion } from 'framer-motion'
import { Loader2, Search, Shuffle } from 'lucide-react'
import type { PieceCounts } from '../../api/endgames'

const PIECE_ORDER: (keyof PieceCounts)[] = ['Q', 'R', 'B', 'N', 'P']
const PIECE_MAX: PieceCounts = { Q: 1, R: 2, B: 2, N: 2, P: 8 }
const MAX_PER_SIDE = 7

const WHITE_GLYPH: Record<string, string> = { Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙' }
const BLACK_GLYPH: Record<string, string> = { Q: '♛', R: '♜', B: '♝', N: '♞', P: '♟' }

const ELO_OPTIONS = [1100, 1300, 1500, 1700, 1900]

const PRESETS: { label: string; white: Partial<PieceCounts>; black: Partial<PieceCounts> }[] = [
  { label: 'K+R vs K+R',          white: { R: 1 },        black: { R: 1 } },
  { label: 'K+Q vs K+P',          white: { Q: 1 },        black: { P: 1 } },
  { label: 'K+R vs K+B',          white: { R: 1 },        black: { B: 1 } },
  { label: 'K+B+N vs K',          white: { B: 1, N: 1 },  black: {} },
  { label: 'Q+pawns vs Q+pawns',  white: { Q: 1, P: 2 },  black: { Q: 1, P: 2 } },
  { label: 'Rook ending',         white: { R: 1, P: 3 },  black: { R: 1, P: 2 } },
]

const ZERO: PieceCounts = { Q: 0, R: 0, B: 0, N: 0, P: 0 }

function full(partial: Partial<PieceCounts>): PieceCounts {
  return { ...ZERO, ...partial }
}

function total(c: PieceCounts): number {
  return PIECE_ORDER.reduce((s, k) => s + c[k], 0)
}

function label(c: PieceCounts): string {
  const parts = ['K']
  for (const k of PIECE_ORDER) {
    if (c[k] === 1) parts.push(k)
    else if (c[k] > 1) parts.push(`${c[k]}${k}`)
  }
  return parts.join(' + ')
}

/** Client-side mirror of the backend keyword parser (keeps buttons in sync). */
function parseText(text: string): { white: PieceCounts; black: PieceCounts } {
  const t = text.toLowerCase()
  const w = { ...ZERO }, b = { ...ZERO }
  if (t.includes('queen pawn') || t.includes('queen and pawn')) { w.Q = 1; w.P = 2; b.Q = 1; b.P = 1; return { white: w, black: b } }
  if (t.includes('rook pawn'))                                   { w.R = 1; w.P = 2; b.R = 1; b.P = 1; return { white: w, black: b } }
  if (t.includes('knight') && t.includes('bishop'))             { w.N = 1; b.B = 1; return { white: w, black: b } }
  if (t.includes('pawn ending') || t.includes('pawn endgame') || t.trim() === 'pawn') { w.P = 2; b.P = 2; return { white: w, black: b } }
  let matched = false
  if (t.includes('rook'))   { w.R = 1; b.R = 1; matched = true }
  if (t.includes('queen'))  { w.Q = 1; b.Q = 1; matched = true }
  if (t.includes('bishop')) { w.B = 1; b.B = 1; matched = true }
  if (t.includes('knight')) { w.N = 1; b.N = 1; matched = true }
  if (t.includes('pawn'))   { w.P = Math.max(w.P, 2); b.P = Math.max(b.P, 2); matched = true }
  if (!matched) { w.R = 1; b.R = 1 }
  return { white: w, black: b }
}

export interface ConfigPayload {
  white:       PieceCounts
  black:       PieceCounts
  description: string
  maiaElo:     number
}

interface Props {
  onFind:   (cfg: ConfigPayload) => void
  loading:  boolean
}

// ── Side column ──────────────────────────────────────────────────────────────

function SideColumn({
  side, counts, onInc, onDec,
}: {
  side: 'white' | 'black'
  counts: PieceCounts
  onInc: (k: keyof PieceCounts) => void
  onDec: (k: keyof PieceCounts) => void
}) {
  const glyphs = side === 'white' ? WHITE_GLYPH : BLACK_GLYPH
  return (
    <div className="flex-1 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-text-1 capitalize">{side}</span>
        <span className="text-[10px] text-text-2">{total(counts)}/{MAX_PER_SIDE}</span>
      </div>
      <div className="flex items-center gap-1.5 text-text-2 text-sm px-1">
        <span className="text-lg leading-none">{side === 'white' ? '♔' : '♚'}</span>
        <span className="text-[10px]">King (always)</span>
      </div>
      <div className="grid grid-cols-5 gap-1">
        {PIECE_ORDER.map(k => {
          const n = counts[k]
          const atMax = n >= PIECE_MAX[k] || total(counts) >= MAX_PER_SIDE
          return (
            <button
              key={k}
              onClick={() => onInc(k)}
              onContextMenu={(e) => { e.preventDefault(); onDec(k) }}
              title={`${k} — click +, right-click −`}
              className={`relative aspect-square rounded-md border text-lg flex items-center justify-center
                transition-colors select-none
                ${n > 0
                  ? 'bg-accent/15 border-accent/40 text-text-0'
                  : 'bg-bg-2 border-border text-text-2 hover:bg-bg-3'}
                ${atMax && n === 0 ? 'opacity-40' : ''}`}
            >
              {glyphs[k]}
              {n > 0 && (
                <span className="absolute -top-1 -right-1 bg-accent text-white text-[9px] font-bold
                                 rounded-full w-4 h-4 flex items-center justify-center">
                  {n}
                </span>
              )}
            </button>
          )
        })}
      </div>
      <p className="text-[11px] text-text-1 font-mono pt-0.5">{label(counts)}</p>
    </div>
  )
}

// ── Main ─────────────────────────────────────────────────────────────────────

export function PieceConfigurator({ onFind, loading }: Props) {
  const [white,   setWhite]   = useState<PieceCounts>(full({ R: 1, P: 3 }))
  const [black,   setBlack]   = useState<PieceCounts>(full({ R: 1, P: 2 }))
  const [text,    setText]    = useState('')
  const [maiaElo, setMaiaElo] = useState(1500)

  const inc = (setter: typeof setWhite, c: PieceCounts) => (k: keyof PieceCounts) => {
    if (c[k] >= PIECE_MAX[k] || total(c) >= MAX_PER_SIDE) return
    setter({ ...c, [k]: c[k] + 1 })
    setText('')   // manual edit clears the vague text
  }
  const dec = (setter: typeof setWhite, c: PieceCounts) => (k: keyof PieceCounts) => {
    if (c[k] <= 0) return
    setter({ ...c, [k]: c[k] - 1 })
    setText('')
  }

  function onTextChange(v: string) {
    setText(v)
    if (v.trim()) {
      const parsed = parseText(v)
      setWhite(parsed.white)
      setBlack(parsed.black)
    }
  }

  function applyPreset(p: typeof PRESETS[number]) {
    setWhite(full(p.white))
    setBlack(full(p.black))
    setText(p.label)
  }

  const valid = total(white) + total(black) >= 1
  const summary = useMemo(() => `${label(white)}  vs  ${label(black)}`, [white, black])

  function emit() {
    if (!valid) return
    onFind({ white, black, description: text.trim(), maiaElo })
  }

  return (
    <div className="card p-4 space-y-4">
      {/* Vague text input */}
      <div>
        <div className="relative">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-2 pointer-events-none" />
          <input
            value={text}
            onChange={(e) => onTextChange(e.target.value)}
            placeholder="e.g. queen pawn endgame, rook ending, knight vs bishop…"
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-border
                       bg-bg-1 text-text-0 placeholder:text-text-2
                       focus:outline-none focus:border-accent/60 focus:bg-bg-2 transition-colors"
          />
        </div>
        {/* Preset chips */}
        <div className="flex flex-wrap gap-1.5 mt-2">
          {PRESETS.map(p => (
            <button key={p.label} onClick={() => applyPreset(p)}
              className="px-2 py-1 rounded-md bg-bg-2 border border-border text-[10px]
                         text-text-1 hover:text-text-0 hover:bg-bg-3 transition-colors">
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Piece columns */}
      <div className="flex gap-4">
        <SideColumn side="white" counts={white}
          onInc={inc(setWhite, white)} onDec={dec(setWhite, white)} />
        <div className="w-px bg-border self-stretch" />
        <SideColumn side="black" counts={black}
          onInc={inc(setBlack, black)} onDec={dec(setBlack, black)} />
      </div>

      {/* Maia ELO */}
      <div>
        <p className="text-xs text-text-2 uppercase tracking-wider font-semibold mb-2">Maia ELO</p>
        <div className="grid grid-cols-5 gap-1.5">
          {ELO_OPTIONS.map(e => (
            <button key={e} onClick={() => setMaiaElo(e)}
              className={`py-1.5 rounded text-[11px] font-mono transition-colors
                ${maiaElo === e
                  ? 'bg-accent/15 text-accent border border-accent/40'
                  : 'bg-bg-2 text-text-1 border border-border hover:bg-bg-3'}`}>
              {e}
            </button>
          ))}
        </div>
      </div>

      {/* Summary + actions */}
      <div className="flex items-center justify-between pt-1">
        <p className="text-xs text-text-1 font-mono truncate">{summary}</p>
      </div>
      {!valid && (
        <p className="text-[11px] text-danger">Add at least one non-king piece.</p>
      )}
      <div className="flex gap-2">
        <motion.button
          whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.99 }}
          onClick={emit}
          disabled={!valid || loading}
          className="btn-primary flex-1 flex items-center justify-center gap-1.5 text-sm disabled:opacity-40"
        >
          {loading ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
          Find position
        </motion.button>
        <button
          onClick={emit}
          disabled={!valid || loading}
          title="Different position, same configuration"
          className="btn-ghost flex items-center justify-center gap-1.5 text-sm px-3 disabled:opacity-40"
        >
          <Shuffle size={13} /> Shuffle
        </button>
      </div>
    </div>
  )
}
