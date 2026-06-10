import { motion } from 'framer-motion'
import { Crosshair, Check, ChevronLeft } from 'lucide-react'
import { CameraFeed } from '../components/CameraFeed'
import type { GameTracker } from '../game/gameTracker'
import type { TrackerUpdate } from '../game/types'

interface Props {
  videoRef: React.RefObject<HTMLVideoElement>
  stream: MediaStream | null
  srcUrl?: string | null
  tracker: GameTracker
  update: TrackerUpdate
  onConfirm: () => void
  onBack: () => void
}

const confidenceTier = (c: number) => {
  if (c >= 0.85) return { color: '#0DC97F', label: 'Strong lock', cls: 'text-success' }
  if (c >= 0.7) return { color: '#F59E0B', label: 'Usable', cls: 'text-warn' }
  return { color: '#FF4D4D', label: 'Searching…', cls: 'text-danger' }
}

export function Calibration({ videoRef, stream, srcUrl = null, tracker, update, onConfirm, onBack }: Props) {
  const conf = update.cornerConfidence
  const tier = confidenceTier(conf)
  const ready = conf > 0.7

  return (
    <div className="max-w-xl mx-auto px-4 py-6">
      <button onClick={onBack} className="btn-ghost flex items-center gap-1 mb-3">
        <ChevronLeft size={15} /> Back
      </button>

      <CameraFeed
        videoRef={videoRef}
        stream={stream}
        srcUrl={srcUrl}
        tracker={tracker}
        className="aspect-video w-full mb-4"
      />

      {/* Confidence indicator */}
      <div className="card p-4 mb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="flex items-center gap-2 text-sm text-text-0">
            <Crosshair size={15} className="text-accent" /> Board detection
          </span>
          <span className={`flex items-center gap-1.5 text-sm font-semibold ${tier.cls}`}>
            <span
              className="w-2.5 h-2.5 rounded-full"
              style={{ backgroundColor: tier.color }}
            />
            {tier.label}
          </span>
        </div>
        <div className="h-2 rounded-full bg-bg-3 overflow-hidden">
          <motion.div
            className="h-full rounded-full"
            style={{ backgroundColor: tier.color }}
            animate={{ width: `${Math.round(conf * 100)}%` }}
            transition={{ duration: 0.2 }}
          />
        </div>
        {update.cornersDetected && ready && (
          <p className="text-xs text-success mt-2 flex items-center gap-1">
            <Check size={13} /> Board detected — corners locked to the grid.
          </p>
        )}
        {!ready && (
          <p className="text-xs text-text-2 mt-2">
            Make sure all four corners and the starting pieces are visible and the board fills
            most of the frame.
          </p>
        )}
      </div>

      <motion.button
        whileTap={{ scale: 0.98 }}
        onClick={onConfirm}
        disabled={!ready}
        className="btn-primary w-full flex items-center justify-center gap-2 py-3 text-base"
      >
        <Check size={18} /> Confirm starting position
      </motion.button>
      <p className="text-center text-[11px] text-text-2 mt-2">
        Tracking begins from the standard starting position.
      </p>
    </div>
  )
}
