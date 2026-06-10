import { motion } from 'framer-motion'
import { Camera, FileText, Film, ChevronRight, ScanLine } from 'lucide-react'
import { SectionHeader } from '../ui/SectionHeader'

interface Props {
  onPickLive: () => void
  onPickVideo: () => void
  onPickScoresheet: () => void
}

export function Home({ onPickLive, onPickVideo, onPickScoresheet }: Props) {
  return (
    <div className="max-w-xl mx-auto px-4 py-8">
      <SectionHeader
        icon={ScanLine}
        title="OTB Scan"
        description="Digitise an over-the-board game and send it straight to your Forked analysis. Three ways in."
      />

      <div className="space-y-3">
        <ModeCard
          icon={Camera}
          title="Record live game"
          body="Point your phone at the board. On-device vision tracks every move as you play."
          onClick={onPickLive}
        />
        <ModeCard
          icon={Film}
          title="Upload a video"
          body="Already filmed the game from a steady angle? Upload it and we track the moves."
          onClick={onPickVideo}
        />
        <ModeCard
          icon={FileText}
          title="Upload scoresheet"
          body="Photo or scan of your written moves. OCR turns it into a PGN in seconds."
          onClick={onPickScoresheet}
        />
      </div>

      <p className="text-center text-[11px] text-text-2 mt-5">
        No login needed · results go to your Forked profile.
      </p>
    </div>
  )
}

function ModeCard({
  icon: Icon,
  title,
  body,
  onClick,
}: {
  icon: typeof Camera
  title: string
  body: string
  onClick: () => void
}) {
  return (
    <motion.button
      whileTap={{ scale: 0.99 }}
      onClick={onClick}
      className="card w-full text-left p-4 flex items-center gap-4 hover:border-border-hover hover:bg-bg-2 transition-colors group"
    >
      <span className="flex-shrink-0 w-11 h-11 rounded-lg bg-accent/15 border border-accent/30 flex items-center justify-center">
        <Icon size={20} className="text-accent" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-text-0">{title}</span>
        <span className="block text-xs text-text-2 leading-relaxed mt-0.5">{body}</span>
      </span>
      <ChevronRight size={18} className="text-text-2 group-hover:text-accent flex-shrink-0" />
    </motion.button>
  )
}
