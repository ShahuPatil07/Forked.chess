import { motion } from 'framer-motion'
import { Camera, ScanLine, ShieldCheck, Loader2, AlertTriangle, ChevronLeft } from 'lucide-react'
import { SectionHeader } from '../ui/SectionHeader'

interface Props {
  onStart: () => void
  modelsReady: boolean
  modelError: string | null
  cameraError: string | null
  onBack?: () => void
}

export function Setup({ onStart, modelsReady, modelError, cameraError, onBack }: Props) {
  return (
    <div className="max-w-xl mx-auto px-4 py-8">
      {onBack && (
        <button onClick={onBack} className="btn-ghost flex items-center gap-1 mb-3">
          <ChevronLeft size={15} /> Back
        </button>
      )}
      <SectionHeader
        icon={ScanLine}
        title="Live recorder"
        description="Record an over-the-board game with your phone camera. The PGN flows straight into your Forked analysis."
      />

      {/* Angle diagram */}
      <div className="card p-5 mb-4">
        <p className="text-[10px] text-text-2 uppercase tracking-wider mb-3">
          Position your phone
        </p>
        <AngleDiagram />
        <p className="text-sm text-text-1 mt-3 leading-relaxed">
          Prop your phone at a <span className="text-text-0 font-semibold">30–45° angle</span>{' '}
          above the board so all four corners and every piece are visible. Keep it steady —
          a stand or a leaning object works best.
        </p>
      </div>

      <div className="card p-4 mb-4 flex items-start gap-3">
        <ShieldCheck size={18} className="text-success flex-shrink-0 mt-0.5" />
        <div>
          <p className="text-sm text-text-0 font-medium">No login needed</p>
          <p className="text-xs text-text-2 leading-relaxed">
            Everything runs on your device. Results go to your Forked profile.
          </p>
        </div>
      </div>

      {modelError && (
        <div className="card p-3 mb-4 flex items-center gap-2 border-danger/30">
          <AlertTriangle size={15} className="text-danger" />
          <p className="text-xs text-danger">{modelError}</p>
        </div>
      )}
      {cameraError && (
        <div className="card p-3 mb-4 flex items-center gap-2 border-danger/30">
          <AlertTriangle size={15} className="text-danger" />
          <p className="text-xs text-danger">{cameraError}</p>
        </div>
      )}

      <motion.button
        whileTap={{ scale: 0.98 }}
        onClick={onStart}
        disabled={!modelsReady}
        className="btn-primary w-full flex items-center justify-center gap-2 py-3 text-base"
      >
        {modelsReady ? (
          <>
            <Camera size={18} /> Start game
          </>
        ) : (
          <>
            <Loader2 size={18} className="animate-spin" /> Loading models…
          </>
        )}
      </motion.button>
      <p className="text-center text-[11px] text-text-2 mt-2">
        Two LeYOLO vision models (~8&nbsp;MB) load once, then cache for offline use.
      </p>
    </div>
  )
}

// Simple inline SVG showing the recommended phone angle over a board.
function AngleDiagram() {
  return (
    <svg viewBox="0 0 300 130" className="w-full h-auto">
      {/* board */}
      <polygon points="40,110 200,110 240,80 80,80" fill="#3a3a52" stroke="#5A5A72" />
      <polygon points="80,80 240,80 230,72 90,72" fill="#242436" />
      {/* phone */}
      <g transform="rotate(-38 250 40)">
        <rect x="232" y="10" width="36" height="62" rx="5" fill="#111118" stroke="#7B61FF" strokeWidth="2" />
        <circle cx="250" cy="64" r="2" fill="#5A5A72" />
        <rect x="237" y="16" width="26" height="40" rx="2" fill="#1A1A25" />
      </g>
      {/* angle arc */}
      <path d="M 200 110 A 60 60 0 0 1 235 70" fill="none" stroke="#7B61FF" strokeDasharray="3 3" />
      <text x="208" y="92" fill="#8A8AA4" fontSize="11">30–45°</text>
    </svg>
  )
}
