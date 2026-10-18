import { useState } from 'react'
import { motion } from 'framer-motion'
import { GraduationCap, X } from 'lucide-react'

export const RATING_BUCKETS = ['Under 800', '800-1200', '1200-1600', '1600-2000', '2000+'] as const
export const STYLE_OPTIONS = [
  { value: 'simple', label: 'Short & simple', hint: 'The key idea in plain words' },
  { value: 'balanced', label: 'Balanced', hint: 'The idea plus one concrete line' },
  { value: 'detailed', label: 'Detailed', hint: 'Candidates, variations, nuance' },
] as const
const GOALS = ['Stop making blunders', 'Understand chess better', 'Reach a specific rating', 'Just enjoy improving']

export interface CoachLevel { rating_bucket: string; explanation_style: string; goal: string }

/** A short, static questionnaire: it only sets the language/depth of explanations. */
export function LevelQuestionnaire({ initial, onSave, onClose }: {
  initial?: CoachLevel | null
  onSave: (level: CoachLevel) => void
  onClose?: () => void
}) {
  const [rating, setRating] = useState(initial?.rating_bucket ?? '')
  const [style, setStyle] = useState(initial?.explanation_style ?? 'balanced')
  const [goal, setGoal] = useState(initial?.goal ?? '')
  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="card w-full max-w-md p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-accent/15 text-accent flex items-center justify-center"><GraduationCap size={18} /></div>
          <div className="flex-1">
            <h2 className="text-base font-semibold text-text-0">How should your coach talk to you?</h2>
            <p className="text-xs text-text-2 mt-0.5">Three quick questions. They set the language and depth of explanations — you can change them any time.</p>
          </div>
          {onClose && <button onClick={onClose} className="p-1 text-text-2 hover:text-text-0" aria-label="Close"><X size={15} /></button>}
        </div>
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-text-1">1. Your rating (any site, roughly)</p>
          <div className="flex flex-wrap gap-1.5">
            {RATING_BUCKETS.map(r => (
              <button key={r} onClick={() => setRating(r)} className={`px-2.5 py-1.5 rounded-md text-xs border ${rating === r ? 'border-accent/50 bg-accent/10 text-accent' : 'border-border text-text-1 hover:bg-bg-2'}`}>{r}</button>
            ))}
          </div>
        </div>
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-text-1">2. Explanations should be…</p>
          <div className="grid grid-cols-3 gap-1.5">
            {STYLE_OPTIONS.map(o => (
              <button key={o.value} onClick={() => setStyle(o.value)} className={`px-2 py-2 rounded-md text-left border ${style === o.value ? 'border-accent/50 bg-accent/10' : 'border-border hover:bg-bg-2'}`}>
                <span className={`block text-xs font-medium ${style === o.value ? 'text-accent' : 'text-text-0'}`}>{o.label}</span>
                <span className="block text-[10px] text-text-2 mt-0.5">{o.hint}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-text-1">3. Main goal</p>
          <div className="flex flex-wrap gap-1.5">
            {GOALS.map(g => (
              <button key={g} onClick={() => setGoal(g)} className={`px-2.5 py-1.5 rounded-md text-xs border ${goal === g ? 'border-accent/50 bg-accent/10 text-accent' : 'border-border text-text-1 hover:bg-bg-2'}`}>{g}</button>
            ))}
          </div>
        </div>
        <button disabled={!rating} onClick={() => onSave({ rating_bucket: rating, explanation_style: style, goal })}
          className="w-full rounded-md bg-accent hover:bg-accent-hover text-white text-sm py-2 disabled:opacity-40">Start coaching</button>
      </motion.div>
    </div>
  )
}
