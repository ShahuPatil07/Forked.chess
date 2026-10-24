import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { KeyMoment, KeyMoments } from '../../api/library'

/** Points lost by the mover in one move, from a key moment's evals. */
export function momentDrop(m: KeyMoment): string | null {
  const b = m.eval_before, a = m.eval_after
  if (!b || !a) return null
  if (b.mate != null || a.mate != null) {
    if (a.mate != null && b.mate == null) return 'allows mate'
    if (b.mate != null && a.mate == null) return 'misses mate'
    return null
  }
  if (b.cp == null || a.cp == null) return null
  // review evals are White's point of view; Stage-1 evals are already the mover's
  const sign = b.pov === 'mover' ? 1 : m.color === 'black' ? -1 : 1
  const before = sign * b.cp, after = sign * a.cp
  // Stage-1 stores mate as ±30000 "centipawns"
  if (after <= -10000 && before > -10000) return 'allows mate'
  if (before >= 10000 && after < 10000) return 'misses mate'
  const drop = (Math.max(-2000, Math.min(2000, before)) - Math.max(-2000, Math.min(2000, after))) / 100
  if (drop <= 0.05) return null
  return `−${drop.toFixed(1)} pts`
}

function MomentRow({ m, onOpen }: { m: KeyMoment; onOpen: (m: KeyMoment) => void }) {
  const drop = momentDrop(m)
  return (
    <button onClick={() => onOpen(m)}
      className="w-full text-left px-3 py-2 rounded-lg hover:bg-bg-2 flex items-center gap-3 group">
      <span className="text-[11px] text-text-2 tabular-nums w-10 flex-shrink-0">{m.move_number}{m.color === 'black' ? '…' : '.'}</span>
      <span className="min-w-0 flex-1">
        <span className="font-mono text-sm text-text-0">{m.san}</span>
        {m.best_san && <span className="text-[11px] text-text-2"> · best <span className="font-mono text-success">{m.best_san}</span></span>}
        {m.classification === 'miss' && <span className="text-[10px] text-warn ml-1.5">missed win</span>}
      </span>
      {drop && <span className="text-[11px] text-danger tabular-nums flex-shrink-0">{drop}</span>}
      <span className="text-[11px] text-accent opacity-0 group-hover:opacity-100 flex-shrink-0">open →</span>
    </button>
  )
}

/**
 * Two dropdowns: "Mistakes" (mistakes + missed wins) and "Blunders". Each row
 * opens the position with the move played and the best move.
 */
export function KeyMomentDropdowns({ moments, onOpen, emptyHint, compact = false }: {
  moments: KeyMoments | null | undefined
  onOpen: (m: KeyMoment) => void
  emptyHint?: string
  compact?: boolean
}) {
  const [open, setOpen] = useState<'mistakes' | 'blunders' | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  const mistakes = moments?.mistakes ?? []
  const blunders = moments?.blunders ?? []
  if (!moments) return emptyHint ? <span className="text-[11px] text-text-2">{emptyHint}</span> : null
  const btn = (kind: 'mistakes' | 'blunders', n: number) => (
    <button onClick={e => { e.stopPropagation(); setOpen(o => (o === kind ? null : kind)) }} disabled={!n}
      aria-expanded={open === kind}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 ${compact ? 'py-1' : 'py-1.5'} text-xs font-medium transition-colors disabled:opacity-40
        ${kind === 'blunders' ? 'border-danger/30 text-danger hover:bg-danger/10' : 'border-warn/30 text-warn hover:bg-warn/10'}
        ${open === kind ? (kind === 'blunders' ? 'bg-danger/10' : 'bg-warn/10') : ''}`}>
      <span className="tabular-nums">{n}</span> {kind === 'blunders' ? (n === 1 ? 'blunder' : 'blunders') : (n === 1 ? 'mistake' : 'mistakes')}
      <ChevronDown size={12} className={`transition-transform ${open === kind ? 'rotate-180' : ''}`} />
    </button>
  )
  const list = open === 'mistakes' ? mistakes : open === 'blunders' ? blunders : []
  return (
    <div ref={ref} className="relative inline-flex gap-1.5" onClick={e => e.stopPropagation()}>
      {btn('mistakes', mistakes.length)}
      {btn('blunders', blunders.length)}
      {open && list.length > 0 && (
        <div className="absolute right-0 top-full mt-1.5 z-40 w-[min(340px,85vw)] card p-1.5 shadow-2xl max-h-80 overflow-y-auto">
          <p className="px-3 pt-1.5 pb-1 text-[10px] uppercase tracking-wider text-text-2">
            {open === 'mistakes' ? 'Mistakes & missed wins' : 'Blunders'} — click to open the position
          </p>
          {list.map((m, i) => <MomentRow key={`${m.ply}-${i}`} m={m} onOpen={mm => { setOpen(null); onOpen(mm) }} />)}
        </div>
      )}
    </div>
  )
}
