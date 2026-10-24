import { motion } from 'framer-motion'
import { ArrowDownRight, ArrowUpRight, Coffee, ExternalLink, Minus, RotateCcw, ShieldCheck, Sparkles } from 'lucide-react'
import type { ActivityId, Session, Summary } from './api'
import { META, TC_LABEL, fmtMs, pct } from './meta'

/** After the warm-up: how it went against the player's own usual, the one cue to carry in, and Play now. */
export function ReadyScreen({ session, summary, onPlay, onAgain, onHome }: {
  session: Session
  summary: Summary | null
  onPlay: () => void
  onAgain: () => void
  onHome: () => void
}) {
  const drills = Object.entries(summary?.drills ?? {}) as [ActivityId, Summary['drills'][string]][]
  const tilt = session.tilt
  const breakLeft = tilt.break_until ? Math.max(0, Math.round((tilt.break_until * 1000 - Date.now()) / 60000)) : 0
  const platformName = session.play_url.includes('lichess') ? 'Lichess' : 'Chess.com'

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 sm:py-12">
      <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} className="text-center">
        <span className="mx-auto w-16 h-16 rounded-full grid place-items-center bg-accent text-accent-ink shadow-neon">
          <ShieldCheck size={30} />
        </span>
        <h1 className="font-display text-4xl sm:text-5xl font-semibold text-text-0 mt-5">You're warmed up</h1>
        <p className="text-text-1 mt-2">
          {summary?.items ? <>{summary.items} items · <span className="text-accent font-semibold">{pct(summary.accuracy)}</span> right</> : 'Warm-up complete'}
          <span className="text-text-2"> · {TC_LABEL[session.time_control]} · {session.band.label}</span>
        </p>
      </motion.div>

      {/* the one cue */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: .1 }}
        className="mt-8 rounded-2xl border border-accent/40 bg-accent/[0.07] p-5 sm:p-6 text-center shadow-neon-sm">
        <p className="text-[11px] uppercase tracking-[0.25em] text-accent/80">Take this into the game</p>
        <p className="font-display text-xl sm:text-2xl text-text-0 mt-2 leading-snug">{session.cue}</p>
      </motion.div>

      {tilt.triggered && (
        <div className="mt-4 rounded-xl border border-warn/40 bg-warn/[0.07] px-4 py-3 flex items-start gap-3 text-sm">
          <Coffee size={17} className="text-warn mt-0.5 flex-shrink-0" />
          <p className="text-text-1">
            You've lost {tilt.streak} in a row. A break is worth considering{breakLeft > 0 ? `: another ${breakLeft} min makes it 30 since your last game` : ''}.
            It's your call.
          </p>
        </div>
      )}

      <div className="mt-6 grid gap-3 sm:grid-cols-[1fr_auto]">
        <a href={session.play_url} target="_blank" rel="noreferrer" onClick={onPlay}
          className="btn-primary py-4 text-lg inline-flex items-center justify-center gap-2">
          Play now on {platformName} <ExternalLink size={17} />
        </a>
        <button onClick={onAgain} className="btn-ghost border border-border py-4 inline-flex items-center justify-center gap-2">
          <RotateCcw size={15} /> Another round
        </button>
      </div>
      <p className="text-[11px] text-text-2 mt-2 text-center">
        Your next game in the next 30 minutes is reviewed by Stockfish and shown in your warm-up history.
      </p>

      {/* per-drill read-out vs the player's own usual */}
      {drills.length > 0 && (
        <div className="mt-10">
          <h2 className="text-xs uppercase tracking-[0.2em] text-text-2 mb-3">How it went</h2>
          <div className="rounded-2xl border border-border bg-bg-1 divide-y divide-border">
            {drills.map(([id, d]) => {
              const m = META[id]
              if (!m) return null
              const I = m.icon
              const b = d.baseline
              const accDelta = b ? d.accuracy - b.accuracy : null
              const msDelta = b && b.median_ms && d.median_ms ? d.median_ms - b.median_ms : null
              return (
                <div key={id} className="flex items-center gap-3 px-4 py-3">
                  <I size={16} className="text-accent flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-text-0 leading-snug">{m.title}</p>
                    <p className="text-[11px] text-text-2">{b ? `Usual ${pct(b.accuracy)} · ${fmtMs(b.median_ms)}` : 'No usual yet'}</p>
                  </div>
                  <Stat value={pct(d.accuracy)} delta={accDelta} good={accDelta !== null && accDelta > 0.04} bad={accDelta !== null && accDelta < -0.04} />
                  <Stat value={fmtMs(d.median_ms)} delta={msDelta} good={msDelta !== null && msDelta < -120} bad={msDelta !== null && msDelta > 120} faster />
                </div>
              )
            })}
          </div>
        </div>
      )}

      <p className="mt-8 text-[11px] text-text-2 leading-relaxed flex gap-2">
        <Sparkles size={12} className="flex-shrink-0 mt-0.5 text-text-2" />{session.honesty}
      </p>
      <button onClick={onHome} className="block mx-auto mt-6 text-sm text-text-2 hover:text-text-0">Back to Warm-Up</button>
    </div>
  )
}

function Stat({ value, delta, good, bad, faster }: { value: string; delta: number | null; good: boolean; bad: boolean; faster?: boolean }) {
  const Icon = delta === null ? null : good ? (faster ? ArrowDownRight : ArrowUpRight) : bad ? (faster ? ArrowUpRight : ArrowDownRight) : Minus
  const label = delta === null ? '' : good ? (faster ? 'faster than usual' : 'better than usual') : bad ? (faster ? 'slower than usual' : 'below usual') : 'about usual'
  return (
    <div className="w-20 text-right" title={label}>
      <p className="text-sm font-semibold text-text-0 tabular-nums">{value}</p>
      {Icon && (
        <p className={`text-[10px] inline-flex items-center gap-0.5 ${good ? 'text-accent' : bad ? 'text-warn' : 'text-text-2'}`}>
          <Icon size={11} />{good ? (faster ? 'faster' : 'better') : bad ? (faster ? 'slower' : 'lower') : 'usual'}
        </p>
      )}
    </div>
  )
}
