import { useState } from 'react'
import { motion } from 'framer-motion'
import { Copy, Check, ArrowRight, RotateCcw, Trophy } from 'lucide-react'
import { SectionHeader } from '../ui/SectionHeader'
import { MoveHistory } from '../components/MoveHistory'
import { analyseWithForked } from '../api/forked'

interface Props {
  pgn: string
  moves: string[]
  onNewGame: () => void
  /** In-app hand-off to the Analysis Board. When provided it takes precedence
   *  over the standalone external open. */
  onAnalyse?: () => void
}

export function GameFinished({ pgn, moves, onNewGame, onAnalyse }: Props) {
  const [copied, setCopied] = useState(false)
  const [analysing, setAnalysing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pgn)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('Could not copy to clipboard')
    }
  }

  const analyse = async () => {
    if (onAnalyse) { onAnalyse(); return }
    setAnalysing(true)
    setError(null)
    // Standalone fallback: token wiring is left to the host app.
    const token = localStorage.getItem('forked_token')
    const res = await analyseWithForked(pgn, token)
    if (!res.ok) setError(res.error ?? 'Failed to send to Forked')
    setAnalysing(false)
  }

  return (
    <div className="max-w-xl mx-auto px-4 py-8">
      <SectionHeader
        icon={Trophy}
        title="Game recorded"
        description="Your over-the-board game is ready. Send it to Forked for a full blindspot debrief."
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
        <div className="card p-3">
          <p className="text-[10px] text-text-2 uppercase tracking-wider mb-2">PGN</p>
          <textarea
            readOnly
            value={pgn}
            onFocus={(e) => e.currentTarget.select()}
            className="input font-mono text-xs h-40 resize-none leading-relaxed"
          />
          <button onClick={copy} className="btn-ghost w-full mt-2 flex items-center justify-center gap-1.5 border border-border">
            {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
            {copied ? 'Copied' : 'Copy PGN'}
          </button>
        </div>
        <div className="h-56">
          <MoveHistory moves={moves} lastMove={null} />
        </div>
      </div>

      {error && <p className="text-xs text-danger mb-3">{error}</p>}

      <motion.button
        whileTap={{ scale: 0.98 }}
        onClick={analyse}
        disabled={analysing}
        className="btn-primary w-full flex items-center justify-center gap-2 py-3 text-base mb-2"
      >
        Analyse with Forked <ArrowRight size={18} />
      </motion.button>
      <button
        onClick={onNewGame}
        className="btn-ghost w-full flex items-center justify-center gap-1.5 border border-border py-2.5"
      >
        <RotateCcw size={15} /> New game
      </button>
    </div>
  )
}
