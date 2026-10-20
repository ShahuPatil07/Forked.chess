import { useState } from 'react'
import { motion } from 'framer-motion'
import { GraduationCap, X } from 'lucide-react'
import type { CoachProfile } from '../../api/coach'

export const RATING_BUCKETS = ['New / not sure', 'Under 800', '800-1200', '1200-1600', '1600-2000', '2000+'] as const
export const STYLE_OPTIONS = [
  { value: 'simple', label: 'Short & simple', hint: 'The key idea in plain words' },
  { value: 'balanced', label: 'Balanced', hint: 'The idea plus one concrete line' },
  { value: 'detailed', label: 'Detailed', hint: 'Candidates, variations, nuance' },
] as const
const LEARNING = [
  { value: 'ideas', label: 'Ideas in words', hint: 'Explain the plan, few moves' },
  { value: 'lines', label: 'Concrete lines', hint: 'Show me the moves that prove it' },
  { value: 'mix', label: 'A mix', hint: 'Idea first, then one line' },
] as const
const VOCAB = [
  { value: 'none', label: 'Plain words', hint: 'Explain every chess term' },
  { value: 'basic', label: 'The basics', hint: 'Fork, pin, skewer are fine' },
  { value: 'advanced', label: 'All of it', hint: 'Outposts, zugzwang, prophylaxis…' },
] as const
const TONES = [
  { value: 'encouraging', label: 'Encouraging', hint: 'Warm, points out what I got right' },
  { value: 'direct', label: 'Straight to the point', hint: 'No praise, no softening' },
  { value: 'socratic', label: 'Ask me first', hint: 'A guiding question, then the answer' },
] as const
const NOTATION = [
  { value: 'san', label: '“Nf3” is fine', hint: 'Standard chess notation' },
  { value: 'words', label: '“Knight to f3”', hint: 'Moves written in words' },
] as const
const GOALS = ['Stop making blunders', 'Understand chess better', 'Reach a specific rating', 'Just enjoy improving']

/** Kept as an alias: older code (and Game Review) call the profile a "level". */
export type CoachLevel = CoachProfile

/** Stored under the original key so Game Review keeps reading it. */
export const PROFILE_KEY = 'forked-coach-level'
export function loadCoachProfile(): CoachProfile | null {
  try { const raw = localStorage.getItem(PROFILE_KEY); return raw ? JSON.parse(raw) : null } catch { return null }
}

function Chips<T extends string>({ options, value, onChange }: {
  options: readonly { value: T; label: string; hint: string }[]; value: string; onChange: (v: T) => void
}) {
  return (
    <div className={`grid gap-1.5 ${options.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
      {options.map(o => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)}
          className={`px-2 py-2 rounded-md text-left border ${value === o.value ? 'border-accent/50 bg-accent/10' : 'border-border hover:bg-bg-2'}`}>
          <span className={`block text-xs font-medium ${value === o.value ? 'text-accent' : 'text-text-0'}`}>{o.label}</span>
          <span className="block text-[10px] text-text-2 mt-0.5">{o.hint}</span>
        </button>
      ))}
    </div>
  )
}

function Q({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-text-1">{n}. {title}</p>
      {children}
    </div>
  )
}

/** Seven quick taps. Answers only shape the coach's language, depth and tone — never its facts. */
export function LevelQuestionnaire({ initial, onSave, onClose }: {
  initial?: CoachProfile | null
  onSave: (profile: CoachProfile) => void
  onClose?: () => void
}) {
  const [rating, setRating] = useState(initial?.rating_bucket ?? '')
  const [learning, setLearning] = useState<string>(initial?.learning ?? 'mix')
  const [vocabulary, setVocabulary] = useState<string>(initial?.vocabulary ?? 'basic')
  const [style, setStyle] = useState(initial?.explanation_style ?? 'balanced')
  const [tone, setTone] = useState<string>(initial?.tone ?? 'direct')
  const [notation, setNotation] = useState<string>(initial?.notation ?? 'san')
  const [goal, setGoal] = useState(initial?.goal ?? '')
  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
        className="card w-full max-w-lg p-5 space-y-4 max-h-[92dvh] overflow-y-auto">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-accent/15 text-accent flex items-center justify-center"><GraduationCap size={18} /></div>
          <div className="flex-1">
            <h2 className="text-base font-semibold text-text-0 font-display">How should your coach talk to you?</h2>
            <p className="text-xs text-text-2 mt-0.5">Seven quick taps. They shape the language, depth and tone of every answer — change them any time.</p>
          </div>
          {onClose && <button onClick={onClose} className="p-1 text-text-2 hover:text-text-0" aria-label="Close"><X size={15} /></button>}
        </div>
        <Q n={1} title="Your rating (any site, roughly)">
          <div className="flex flex-wrap gap-1.5">
            {RATING_BUCKETS.map(r => (
              <button key={r} type="button" onClick={() => setRating(r)} className={`px-2.5 py-1.5 rounded-md text-xs border ${rating === r ? 'border-accent/50 bg-accent/10 text-accent' : 'border-border text-text-1 hover:bg-bg-2'}`}>{r}</button>
            ))}
          </div>
        </Q>
        <Q n={2} title="You learn best from…"><Chips options={LEARNING} value={learning} onChange={setLearning} /></Q>
        <Q n={3} title="Chess terms you're comfortable with"><Chips options={VOCAB} value={vocabulary} onChange={setVocabulary} /></Q>
        <Q n={4} title="Explanations should be…"><Chips options={STYLE_OPTIONS} value={style} onChange={setStyle} /></Q>
        <Q n={5} title="Coaching tone"><Chips options={TONES} value={tone} onChange={setTone} /></Q>
        <Q n={6} title="How should moves be written?"><Chips options={NOTATION} value={notation} onChange={setNotation} /></Q>
        <Q n={7} title="Main goal">
          <div className="flex flex-wrap gap-1.5">
            {GOALS.map(g => (
              <button key={g} type="button" onClick={() => setGoal(g)} className={`px-2.5 py-1.5 rounded-md text-xs border ${goal === g ? 'border-accent/50 bg-accent/10 text-accent' : 'border-border text-text-1 hover:bg-bg-2'}`}>{g}</button>
            ))}
          </div>
        </Q>
        <button disabled={!rating} onClick={() => onSave({
          rating_bucket: rating, explanation_style: style, goal,
          learning: learning as CoachProfile['learning'], vocabulary: vocabulary as CoachProfile['vocabulary'],
          tone: tone as CoachProfile['tone'], notation: notation as CoachProfile['notation'],
        })} className="w-full rounded-md bg-accent hover:bg-accent-hover text-accent-ink text-sm py-2 disabled:opacity-40">
          Start coaching
        </button>
      </motion.div>
    </div>
  )
}
