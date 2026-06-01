import { motion } from 'framer-motion'
import type { StyleProfile } from '../api/insights'

const ARCHETYPE_DESC: Record<string, string> = {
  'The Attacker':   'You play sharp, risky chess and look for the kill',
  'The Tactician':  'You spot combinations but choose your battles',
  'The Gambiteer':  'You sacrifice material for initiative and complexity',
  'The Calculator': 'You calculate precisely and exploit tactical chaos',
  'The Strategist': 'You outmanoeuvre opponents with long-term plans',
  'The Grinder':    'You convert advantages slowly and surely',
  'The Pragmatist': 'You adapt your style to what the position demands',
  'The Fortress':   'You defend tenaciously and wait for opponent errors',
}

function axisLabel(axis: number, score: number | null): string {
  if (score === null) return '—'
  switch (axis) {
    case 1: return score > 50 ? 'Tactical'   : 'Positional'
    case 2: return score > 50 ? 'Aggressive' : 'Solid'
    case 3: return score > 50 ? 'Risk-taker' : 'Conservative'
    case 4: return score > 50 ? 'Middlegame' : 'Endgame'
    case 5: return score >= 50 ? 'Time calm' : 'Time pressure'
    default: return ''
  }
}

function AxisBar({ axis, score, delay }: { axis: number; score: number | null; delay: number }) {
  const label = axisLabel(axis, score)
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-text-1 w-24 flex-shrink-0">{label}</span>
      <div className="flex-1 h-2 rounded-full bg-bg-3 overflow-hidden">
        {score !== null && (
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: `${score}%` }}
            transition={{ delay, duration: 0.5, ease: 'easeOut' }}
            className="h-full rounded-full"
            style={{ background: 'linear-gradient(90deg, #7c6af7, #a78bfa)' }}
          />
        )}
      </div>
      <span className="text-xs font-semibold text-text-0 w-7 text-right tabular-nums flex-shrink-0">
        {score === null ? '—' : score}
      </span>
    </div>
  )
}

/**
 * Compact Chess DNA style block — archetype headline + 5 axis bars.
 * Used on the Dashboard and the public DNA page.
 */
export function ChessDNACard({ style }: { style: StyleProfile }) {
  if (style.insufficient || !style.archetype) {
    return (
      <div className="card p-5 text-center">
        <p className="text-sm text-text-1 font-medium">Play 50+ games to unlock your Chess DNA</p>
        <p className="text-xs text-text-2 mt-1">{style.n_games}/50 games analysed</p>
      </div>
    )
  }

  const desc = style.description || ARCHETYPE_DESC[style.archetype] || ''

  return (
    <div className="card p-5">
      <div className="flex items-center gap-1.5 text-xs text-text-2 uppercase tracking-wider mb-3">
        <span>🧬</span> Your chess style
      </div>
      <motion.h2
        initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
        className="text-2xl font-black tracking-tight"
        style={{ background: 'linear-gradient(135deg, #c4b5fd, #7c6af7)',
                 WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
                 backgroundClip: 'text' }}
      >
        {style.archetype}
      </motion.h2>
      <p className="text-xs text-text-2 mt-0.5 mb-4">{desc}</p>

      <div className="space-y-2">
        {[style.axis1, style.axis2, style.axis3, style.axis4, style.axis5].map((s, i) => (
          <AxisBar key={i} axis={i + 1} score={s} delay={i * 0.06} />
        ))}
      </div>
    </div>
  )
}
