import { motion } from 'framer-motion'
import { ArrowRight, Camera, CheckCircle2, FileText, Film, History, ScanLine, Sparkles, Zap } from 'lucide-react'
import { ScanHistoryList, useScanHistory } from './ScanHistory'
import { SectionHeader } from '../ui/SectionHeader'

interface Props {
  onPickScoresheet: () => void
  onHistory: () => void
}

/**
 * OTB Scan landing. The scoresheet reader is the production path; live camera
 * tracking and video upload stay visible as beta / coming soon (not clickable).
 */
export function Home({ onPickScoresheet, onHistory }: Props) {
  const { data } = useScanHistory()
  const scans = data?.games ?? []
  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <SectionHeader
        icon={ScanLine}
        title="OTB Scan"
        description="Turn the paper scoresheet from your over-the-board game into a game you can review in about ten seconds."
        right={
          <button onClick={onHistory} className="btn-ghost border border-border text-sm inline-flex items-center gap-2">
            <History size={14} />Previous scans{scans.length ? ` (${scans.length})` : ''}
          </button>
        }
      />

      <motion.button
        initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
        whileTap={{ scale: 0.995 }}
        onClick={onPickScoresheet}
        className="group relative w-full text-left rounded-2xl border border-accent/40 bg-bg-1 p-6 sm:p-7 overflow-hidden shadow-neon-sm hover:shadow-neon transition-shadow"
      >
        <div aria-hidden className="absolute -top-24 -right-16 w-72 h-72 rounded-full bg-accent/10 blur-3xl" />
        <div className="relative flex items-start gap-5">
          <span className="flex-shrink-0 w-14 h-14 rounded-2xl bg-accent/15 border border-accent/40 grid place-items-center">
            <FileText size={26} className="text-accent" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-display text-2xl font-semibold text-text-0">Scan a scoresheet</p>
            <p className="text-sm text-text-1 mt-1.5 leading-relaxed max-w-lg">
              Snap a photo of your handwritten moves. We read every cell, rebuild the game move by move
              using the rules of chess, and hand it to Game Review or the Analysis Board.
            </p>
            <ul className="mt-4 grid sm:grid-cols-3 gap-2 text-xs text-text-1">
              {[
                [Zap, 'About 10 seconds a sheet'],
                [CheckCircle2, 'Every move checked for legality'],
                [Sparkles, 'Fixes slips like Nd7 for Nbd7'],
              ].map(([I, t]) => {
                const Icon = I as typeof Zap
                return (
                  <li key={t as string} className="flex items-center gap-1.5">
                    <Icon size={13} className="text-accent flex-shrink-0" />{t as string}
                  </li>
                )
              })}
            </ul>
            <span className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-accent">
              Upload scoresheet <ArrowRight size={16} className="group-hover:translate-x-0.5 transition-transform" />
            </span>
          </div>
        </div>
      </motion.button>

      {scans.length > 0 && (
        <div className="mt-8">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[11px] uppercase tracking-[0.2em] text-text-2">Recent scans</p>
            {scans.length > 3 && <button onClick={onHistory} className="text-xs text-accent">See all {scans.length} →</button>}
          </div>
          <ScanHistoryList games={scans.slice(0, 3)} compact />
        </div>
      )}

      <p className="text-[11px] uppercase tracking-[0.2em] text-text-2 mt-8 mb-3">In the lab</p>
      <div className="grid sm:grid-cols-2 gap-3">
        <SoonCard icon={Camera} title="Record a live game"
          body="Point your phone at the board and on-device vision tracks every move." />
        <SoonCard icon={Film} title="Upload a game video"
          body="Film from a steady angle and we'll pull the moves out of the video." />
      </div>
    </div>
  )
}

function SoonCard({ icon: Icon, title, body }: { icon: typeof Camera; title: string; body: string }) {
  return (
    <div aria-disabled className="card p-4 flex items-start gap-3 opacity-70 cursor-not-allowed select-none">
      <span className="flex-shrink-0 w-10 h-10 rounded-lg bg-bg-2 border border-border grid place-items-center">
        <Icon size={18} className="text-text-2" />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-text-1 flex items-center gap-2 flex-wrap">
          {title}
          <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border border-warn/40 text-warn">
            Beta · coming soon
          </span>
        </p>
        <p className="text-xs text-text-2 mt-1 leading-relaxed">{body}</p>
      </div>
    </div>
  )
}
