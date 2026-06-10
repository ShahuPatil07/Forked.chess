import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { RefreshCw, Flag, Radio, Hand } from 'lucide-react'
import { CameraFeed } from '../components/CameraFeed'
import { BoardDisplay } from '../components/BoardDisplay'
import { CorrectionModal } from '../components/CorrectionModal'
import type { GameTracker } from '../game/gameTracker'
import type { TrackerUpdate } from '../game/types'

interface Props {
  videoRef: React.RefObject<HTMLVideoElement>
  stream: MediaStream | null
  srcUrl?: string | null
  tracker: GameTracker
  update: TrackerUpdate
  onCorrect: (move: string) => boolean
  onDismiss: () => void
  onResync: () => Promise<boolean>
  onFinish: () => void
}

export function LiveGame({
  videoRef,
  stream,
  srcUrl = null,
  tracker,
  update,
  onCorrect,
  onDismiss,
  onResync,
  onFinish,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [boardWidth, setBoardWidth] = useState(320)
  const [selected, setSelected] = useState<string | null>(null)
  const [manualMode, setManualMode] = useState(false)
  const [resyncing, setResyncing] = useState(false)

  useEffect(() => {
    const measure = () => {
      const w = wrapRef.current?.clientWidth ?? 320
      setBoardWidth(Math.min(w, 420))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  const plies = update.moves.length
  const fullMoves = Math.ceil(plies / 2)

  const handleSquare = (square: string) => {
    if (!manualMode) return
    if (!selected) {
      setSelected(square)
      return
    }
    if (selected === square) {
      setSelected(null)
      return
    }
    const ok = onCorrect(selected + square) || onCorrect(selected + square + 'q')
    setSelected(null)
    if (ok) setManualMode(false)
  }

  const handleResync = async () => {
    setResyncing(true)
    try {
      await onResync()
    } finally {
      setResyncing(false)
    }
  }

  const squareStyles = selected
    ? { [selected]: { background: 'rgba(123,97,255,0.45)' } }
    : undefined

  return (
    <div ref={wrapRef} className="max-w-md mx-auto px-3 py-4">
      {/* Camera / video (locked corners) */}
      <CameraFeed
        videoRef={videoRef}
        stream={stream}
        srcUrl={srcUrl}
        tracker={tracker}
        className="aspect-video w-full mb-3"
      />

      {/* Status bar */}
      <div className="flex items-center justify-between mb-3">
        <span className="badge bg-accent/15 text-accent">
          <Radio size={11} /> Tracking
        </span>
        <span className="text-xs text-text-1 tabular-nums">
          Move {fullMoves} · {plies} plies
        </span>
        <span className="text-xs text-text-2 tabular-nums">
          {update.lastMove ? `last: ${update.lastMove}` : 'waiting…'}
        </span>
      </div>

      {/* Board */}
      <div className="flex justify-center mb-3">
        <BoardDisplay
          fen={update.fen}
          boardWidth={boardWidth}
          onSquareClick={handleSquare}
          customSquareStyles={squareStyles}
        />
      </div>

      {/* Controls */}
      <div className="grid grid-cols-3 gap-2">
        <button
          onClick={handleResync}
          disabled={resyncing}
          className="btn-ghost flex items-center justify-center gap-1.5 border border-border"
        >
          <RefreshCw size={14} className={resyncing ? 'animate-spin' : ''} /> Resync
        </button>
        <button
          onClick={() => {
            setManualMode((m) => !m)
            setSelected(null)
          }}
          className={`flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border transition-colors ${
            manualMode
              ? 'bg-accent/15 text-accent border-accent/40'
              : 'text-text-1 border-border hover:bg-bg-2'
          }`}
        >
          <Hand size={14} /> Manual
        </button>
        <button
          onClick={onFinish}
          className="btn-danger flex items-center justify-center gap-1.5"
        >
          <Flag size={14} /> Finish
        </button>
      </div>

      {manualMode && (
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="text-center text-xs text-accent mt-2"
        >
          {selected
            ? `From ${selected} — tap the destination square`
            : 'Tap the square you moved from, then the destination'}
        </motion.p>
      )}

      {update.state === 'correction_needed' && (
        <CorrectionModal
          options={update.correctionOptions}
          onChoose={(m) => onCorrect(m)}
          onDismiss={onDismiss}
        />
      )}
    </div>
  )
}
