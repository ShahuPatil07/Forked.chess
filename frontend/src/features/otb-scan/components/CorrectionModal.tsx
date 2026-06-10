import { motion } from 'framer-motion'
import { AlertTriangle } from 'lucide-react'

interface Props {
  options: string[]
  onChoose: (move: string) => void
  onDismiss: () => void
}

// Shown when the tracker detects an ambiguous move (2+ legal moves match the
// board change). The user taps the move they actually played.
export function CorrectionModal({ options, onChoose, onDismiss }: Props) {
  if (options.length === 0) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="card p-5 w-full max-w-sm"
      >
        <div className="flex items-center gap-2 mb-1">
          <AlertTriangle size={16} className="text-warn" />
          <h2 className="text-sm font-bold text-text-0">Which move was played?</h2>
        </div>
        <p className="text-xs text-text-2 mb-4">
          The scanner saw a change that matches more than one legal move.
        </p>
        <div className="grid grid-cols-2 gap-2">
          {options.map((move) => (
            <button
              key={move}
              onClick={() => onChoose(move)}
              className="btn-primary text-base tabular-nums"
            >
              {move}
            </button>
          ))}
        </div>
        <button onClick={onDismiss} className="btn-ghost w-full mt-3">
          None of these — keep watching
        </button>
      </motion.div>
    </div>
  )
}
