import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown, ChevronUp, Plus, Route, Trash2, X } from 'lucide-react'
import type { ActivityId, Profile } from './api'
import { META } from './meta'

const GROUPS: { id: 'Reset' | 'Perception' | 'Thinking'; blurb: string }[] = [
  { id: 'Reset', blurb: 'Settle in' },
  { id: 'Perception', blurb: 'Fast board vision' },
  { id: 'Thinking', blurb: 'Slow, careful moves' },
]
const MAX_STEPS = 12

/** Build the routine that "Run my routine" plays, in order. Keyboard: every control is a button. */
export function RoutineBuilder({ profile, initial, onClose, onSave }: {
  profile: Profile
  initial: ActivityId[]
  onClose: () => void
  onSave: (steps: ActivityId[]) => Promise<void>
}) {
  const [steps, setSteps] = useState<ActivityId[]>(initial)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const est = steps.reduce((s, a) => s + (profile.activities[a]?.est_s ?? 45), 0)
  const move = (i: number, d: -1 | 1) => setSteps(s => {
    const j = i + d
    if (j < 0 || j >= s.length) return s
    const n = [...s]; [n[i], n[j]] = [n[j], n[i]]; return n
  })
  const save = async () => {
    setSaving(true); setErr('')
    try { await onSave(steps); onClose() } catch (e) { setErr(e instanceof Error ? e.message : 'Could not save') } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" role="dialog" aria-modal="true" aria-label="Edit routine">
      <motion.div className="absolute inset-0 bg-black/70 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} onClick={onClose} />
      <motion.div initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ type: 'spring', damping: 28, stiffness: 320 }}
        className="relative w-full sm:max-w-3xl max-h-[92vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl border border-border bg-bg-1 shadow-2xl">
        <div className="sticky top-0 z-10 bg-bg-1/95 backdrop-blur px-5 sm:px-6 py-4 border-b border-border flex items-center gap-3">
          <Route size={18} className="text-accent" />
          <div className="flex-1">
            <h2 className="font-display text-lg font-semibold text-text-0">Your routine</h2>
            <p className="text-xs text-text-2">The same steps, in the same order, every time you play. About {Math.max(1, Math.round(est / 60))} min.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-2 rounded-lg text-text-2 hover:text-text-0 hover:bg-bg-2"><X size={18} /></button>
        </div>

        <div className="grid md:grid-cols-2 gap-6 p-5 sm:p-6">
          {/* current routine */}
          <div>
            <p className="text-[11px] uppercase tracking-[0.2em] text-text-2 mb-2">Order · {steps.length}/{MAX_STEPS}</p>
            {steps.length === 0 && <p className="text-sm text-text-2 border border-dashed border-border rounded-xl p-6 text-center">Add steps from the right.</p>}
            <ol className="space-y-2">
              <AnimatePresence initial={false}>
                {steps.map((a, i) => {
                  const m = META[a]
                  const I = m.icon
                  return (
                    <motion.li key={`${a}-${i}`} layout initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 8 }}
                      className="flex items-center gap-2 rounded-xl border border-border bg-bg-2 pl-3 pr-1.5 py-2">
                      <span className="w-5 text-xs text-text-2 tabular-nums">{i + 1}</span>
                      <I size={15} className="text-accent flex-shrink-0" />
                      <span className="flex-1 text-sm text-text-0 truncate">{m.title}</span>
                      <button onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${m.title} up`} className="p-1.5 rounded-md text-text-2 hover:text-text-0 hover:bg-bg-3 disabled:opacity-25"><ChevronUp size={15} /></button>
                      <button onClick={() => move(i, 1)} disabled={i === steps.length - 1} aria-label={`Move ${m.title} down`} className="p-1.5 rounded-md text-text-2 hover:text-text-0 hover:bg-bg-3 disabled:opacity-25"><ChevronDown size={15} /></button>
                      <button onClick={() => setSteps(s => s.filter((_, j) => j !== i))} aria-label={`Remove ${m.title}`} className="p-1.5 rounded-md text-text-2 hover:text-danger hover:bg-danger/10"><Trash2 size={14} /></button>
                    </motion.li>
                  )
                })}
              </AnimatePresence>
            </ol>
          </div>

          {/* library */}
          <div className="space-y-4">
            {GROUPS.map(g => (
              <div key={g.id}>
                <p className="text-[11px] uppercase tracking-[0.2em] text-text-2 mb-2">{g.id} <span className="normal-case tracking-normal text-text-2/70">· {g.blurb}</span></p>
                <div className="grid grid-cols-1 gap-1.5">
                  {(Object.keys(META) as ActivityId[]).filter(a => META[a].group === g.id).map(a => {
                    const m = META[a]
                    const I = m.icon
                    const locked = a === 'two_candidates' && !profile.bank_ready
                    return (
                      <button key={a} disabled={steps.length >= MAX_STEPS || locked} onClick={() => setSteps(s => [...s, a])}
                        className="group flex items-center gap-2.5 rounded-xl border border-border hover:border-accent/50 bg-bg-1 hover:bg-bg-2 px-3 py-2 text-left disabled:opacity-40 disabled:pointer-events-none transition-colors">
                        <I size={15} className="text-text-1 group-hover:text-accent flex-shrink-0" />
                        <span className="flex-1 min-w-0">
                          <span className="block text-sm text-text-0">{m.title}</span>
                          <span className="block text-[11px] text-text-2 truncate">{m.pitch}</span>
                        </span>
                        <Plus size={15} className="text-text-2 group-hover:text-accent" />
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="sticky bottom-0 bg-bg-1/95 backdrop-blur px-5 sm:px-6 py-4 border-t border-border flex items-center gap-3">
          {err && <p className="text-xs text-danger flex-1">{err}</p>}
          <button onClick={() => setSteps([])} className="btn-ghost mr-auto" disabled={!steps.length}>Clear</button>
          <button onClick={onClose} className="btn-ghost">Cancel</button>
          <button onClick={save} disabled={!steps.length || saving} className="btn-primary px-6">{saving ? 'Saving…' : 'Save routine'}</button>
        </div>
      </motion.div>
    </div>
  )
}
