import { useEffect } from 'react'
import { motion } from 'framer-motion'

/**
 * Cinematic homepage cold-open: a burning knight, a thundery fork striking out
 * of it, and the screen vibrating on impact — then everything recedes and the
 * page is revealed (the faint background knight watermark lives in Onboarding).
 *
 * ~2.6s. Click or Esc to skip. The parent gates this on sessionStorage +
 * prefers-reduced-motion (see shouldSkipIntro), so this component just plays.
 */

const DURATION = 2.6 // seconds

const FORK_MAIN = 'M92 266 C142 224 173 192 197 150 C212 124 234 99 282 74'
const FORK_PRONGS = 'M260 88 L306 58 M266 101 L318 92 M252 78 L270 35'

export function shouldSkipIntro(): boolean {
  if (typeof window === 'undefined') return true
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
  const seen = sessionStorage.getItem('forked_intro_seen') === '1'
  return Boolean(reduce || seen)
}

export function markIntroSeen() {
  try { sessionStorage.setItem('forked_intro_seen', '1') } catch { /* ignore */ }
}

export function ForkedIntro({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, DURATION * 1000)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDone() }
    window.addEventListener('keydown', onKey)
    return () => { clearTimeout(timer); window.removeEventListener('keydown', onKey) }
  }, [onDone])

  return (
    <motion.div
      className="fixed inset-0 z-[100] flex items-center justify-center overflow-hidden bg-bg-0 cursor-pointer"
      onClick={onDone}
      initial={{ opacity: 1 }}
      animate={{ opacity: [1, 1, 1, 0] }}
      transition={{ duration: DURATION, times: [0, 0.6, 0.9, 1], ease: 'easeInOut' }}
    >
      {/* Screen-shake wrapper — jitter bursts on the lightning strike */}
      <motion.div
        className="relative flex items-center justify-center"
        animate={{
          x: [0, 0, -10, 9, -7, 5, -3, 0, 0],
          y: [0, 0, 6, -5, 4, -3, 2, 0, 0],
        }}
        transition={{ duration: DURATION, times: [0, 0.3, 0.34, 0.4, 0.46, 0.52, 0.58, 0.66, 1], ease: 'easeOut' }}
      >
        {/* Fire / ember glow building behind the knight */}
        <motion.div
          className="pointer-events-none absolute h-[460px] w-[460px] rounded-full"
          style={{
            background:
              'radial-gradient(circle, rgba(255,140,40,0.55) 0%, rgba(255,70,25,0.30) 38%, rgba(123,97,255,0.22) 64%, transparent 76%)',
          }}
          animate={{ scale: [0.55, 1, 1.12, 1.04, 0.85], opacity: [0, 0.9, 1, 0.95, 0] }}
          transition={{ duration: DURATION, times: [0, 0.35, 0.6, 0.85, 1], ease: 'easeInOut' }}
        />

        {/* Flickering ember core */}
        <motion.div
          className="pointer-events-none absolute h-[260px] w-[260px] rounded-full blur-2xl"
          style={{ background: 'radial-gradient(circle, rgba(255,180,80,0.6), transparent 70%)' }}
          animate={{ opacity: [0, 0.8, 0.5, 0.9, 0.4, 0], scale: [0.8, 1.05, 0.95, 1.1, 0.9, 0.8] }}
          transition={{ duration: DURATION, times: [0, 0.3, 0.45, 0.6, 0.8, 1], ease: 'easeInOut' }}
        />

        {/* The knight */}
        <motion.img
          src="/logo-knight-cutout.png"
          alt=""
          className="relative h-[46vh] max-h-[440px] w-auto select-none"
          style={{ filter: 'drop-shadow(0 0 34px rgba(255,110,40,0.7))' }}
          initial={{ scale: 0.7, opacity: 0 }}
          animate={{ scale: [0.7, 1.06, 1, 1, 0.88], opacity: [0, 1, 1, 1, 0] }}
          transition={{ duration: DURATION, times: [0, 0.3, 0.5, 0.85, 1], ease: 'easeOut' }}
        />

        {/* The thundery fork striking out of the knight */}
        <motion.svg
          viewBox="0 0 360 360"
          className="pointer-events-none absolute h-[58vh] max-h-[560px] w-auto overflow-visible"
          aria-hidden="true"
          animate={{ opacity: [0, 0, 1, 1, 0] }}
          transition={{ duration: DURATION, times: [0, 0.28, 0.4, 0.85, 1] }}
        >
          <defs>
            <linearGradient id="introFork" x1="80" y1="280" x2="300" y2="60" gradientUnits="userSpaceOnUse">
              <stop stopColor="#FFD27A" />
              <stop offset="0.45" stopColor="#FF8A3D" />
              <stop offset="0.8" stopColor="#7B61FF" />
              <stop offset="1" stopColor="#C4B5FD" />
            </linearGradient>
            <filter id="introBlur" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="5" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <motion.path
            d={FORK_MAIN} fill="none" stroke="url(#introFork)" strokeWidth="9"
            strokeLinecap="round" filter="url(#introBlur)" pathLength={1}
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: [0, 1, 1], opacity: [0, 1, 1] }}
            transition={{ duration: DURATION, times: [0.28, 0.42, 1], ease: 'easeOut' }}
          />
          <motion.path
            d={FORK_PRONGS} fill="none" stroke="url(#introFork)" strokeWidth="9"
            strokeLinecap="round" filter="url(#introBlur)" pathLength={1}
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: [0, 1, 1], opacity: [0, 1, 1] }}
            transition={{ duration: DURATION, times: [0.4, 0.52, 1], ease: 'easeOut' }}
          />
        </motion.svg>
      </motion.div>

      {/* Lightning flash on impact */}
      <motion.div
        className="pointer-events-none absolute inset-0 bg-white"
        animate={{ opacity: [0, 0, 0.75, 0, 0.45, 0] }}
        transition={{ duration: DURATION, times: [0, 0.33, 0.37, 0.44, 0.5, 0.6], ease: 'easeOut' }}
      />

      {/* Vignette to keep it cinematic */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_45%,rgba(0,0,0,0.55)_100%)]" />

      <button
        onClick={(e) => { e.stopPropagation(); onDone() }}
        className="absolute bottom-6 right-6 z-10 rounded-md border border-border/60 bg-bg-1/40 px-3 py-1.5 text-xs text-text-2 backdrop-blur-sm transition-colors hover:text-text-0"
      >
        Skip ›
      </button>
    </motion.div>
  )
}
