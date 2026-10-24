import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { BellOff, Check, Clock3, GlassWater, Lock, Wind } from 'lucide-react'
import { TC_LABEL } from '../meta'

/** Countdown that also works when the tab is backgrounded (wall-clock based). */
function useCountdown(seconds: number, running = true) {
  const [left, setLeft] = useState(seconds)
  const end = useRef(Date.now() + seconds * 1000)
  useEffect(() => { end.current = Date.now() + seconds * 1000; setLeft(seconds) }, [seconds])
  useEffect(() => {
    if (!running) return
    const t = window.setInterval(() => setLeft(Math.max(0, Math.ceil((end.current - Date.now()) / 1000))), 250)
    return () => clearInterval(t)
  }, [running, seconds])
  return left
}
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

// ── Setup Check ─────────────────────────────────────────────────────────────

export function SetupCheck({ timeControl, onDone }: { timeControl: string; onDone: () => void }) {
  const items = [
    { id: 'air', icon: Wind, label: 'Fresh air', sub: 'Open a window. Stuffy rooms are linked to more errors.' },
    { id: 'water', icon: GlassWater, label: 'Water nearby', sub: 'A glass within reach.' },
    { id: 'notif', icon: BellOff, label: 'Notifications off', sub: 'Phone face-down, other tabs closed.' },
    { id: 'tc', icon: Clock3, label: `${TC_LABEL[timeControl] ?? timeControl} chosen`, sub: 'Decided before you sit down, not mid-tilt.' },
  ]
  const [ticked, setTicked] = useState<string[]>([])
  return (
    <div className="max-w-xl mx-auto">
      <div className="grid sm:grid-cols-2 gap-3">
        {items.map(({ id, icon: I, label, sub }) => {
          const on = ticked.includes(id)
          return (
            <button key={id} onClick={() => setTicked(t => (on ? t.filter(x => x !== id) : [...t, id]))} aria-pressed={on}
              className={`text-left rounded-2xl border p-4 flex gap-3 items-start transition-all
                ${on ? 'border-accent/60 bg-accent/[0.08] shadow-neon-sm' : 'border-border bg-bg-1 hover:border-border-hover'}`}>
              <span className={`w-10 h-10 rounded-xl grid place-items-center flex-shrink-0 ${on ? 'bg-accent text-accent-ink' : 'bg-bg-2 text-text-1'}`}>
                {on ? <Check size={18} /> : <I size={18} />}
              </span>
              <span>
                <span className="block font-semibold text-text-0">{label}</span>
                <span className="block text-xs text-text-2 mt-0.5 leading-relaxed">{sub}</span>
              </span>
            </button>
          )
        })}
      </div>
      <button onClick={onDone} className="btn-primary w-full mt-5 py-3 text-base">
        {ticked.length === items.length ? 'All set: start' : 'Continue'}
      </button>
    </div>
  )
}

// ── Reset Breathing ─────────────────────────────────────────────────────────

const IN_S = 4, OUT_S = 6
export function BreathingReset({ reducedMotion, onDone }: { reducedMotion: boolean; onDone: () => void }) {
  const [total, setTotal] = useState(90)
  const [started, setStarted] = useState(false)
  const left = useCountdown(total, started)
  const [phase, setPhase] = useState<'in' | 'out'>('in')
  const [count, setCount] = useState(IN_S)
  useEffect(() => {
    if (!started) return
    const t0 = Date.now()
    const t = window.setInterval(() => {
      const x = ((Date.now() - t0) / 1000) % (IN_S + OUT_S)
      setPhase(x < IN_S ? 'in' : 'out')
      setCount(Math.ceil(x < IN_S ? IN_S - x : IN_S + OUT_S - x))
    }, 100)
    return () => clearInterval(t)
  }, [started])
  useEffect(() => { if (started && left === 0) onDone() }, [left, started, onDone])

  if (!started) {
    return (
      <div className="max-w-md mx-auto text-center">
        <p className="text-text-1">Slow your breathing to settle before you play: in for {IN_S}, out for {OUT_S}.</p>
        <div className="mt-5 flex justify-center gap-2">
          {[60, 90, 120].map(s => (
            <button key={s} onClick={() => setTotal(s)}
              className={`px-4 py-2 rounded-lg border text-sm ${total === s ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-1'}`}>
              {({ 60: '1 min', 90: '1½ min', 120: '2 min' } as Record<number, string>)[s]}
            </button>
          ))}
        </div>
        <button onClick={() => setStarted(true)} className="btn-primary mt-6 px-8 py-3 text-base">Start</button>
        <button onClick={onDone} className="block mx-auto mt-3 text-xs text-text-2 hover:text-text-0">Skip</button>
      </div>
    )
  }
  return (
    <div className="flex flex-col items-center gap-6 py-4">
      <div className="relative w-64 h-64 grid place-items-center">
        <div className="absolute inset-0 rounded-full border border-border" />
        {!reducedMotion && (
          <motion.div className="absolute rounded-full bg-accent/15 border-2 border-accent shadow-neon"
            animate={{ width: phase === 'in' ? 240 : 96, height: phase === 'in' ? 240 : 96 }}
            transition={{ duration: phase === 'in' ? IN_S : OUT_S, ease: 'easeInOut' }} />
        )}
        <div className="relative text-center">
          <p className="font-display text-3xl font-semibold text-text-0">{phase === 'in' ? 'Breathe in' : 'Breathe out'}</p>
          <p className="text-4xl font-display neon-text mt-1 tabular-nums">{count}</p>
        </div>
      </div>
      <p className="text-sm text-text-2 tabular-nums">{mmss(left)} left</p>
      <button onClick={onDone} className="text-xs text-text-2 hover:text-text-0">I'm settled: continue</button>
    </div>
  )
}

// ── Clear Your Head ─────────────────────────────────────────────────────────

/** The text lives only in this component's memory: never saved, never sent, gone when you continue. */
export function WorryDump({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState('')
  const [mins, setMins] = useState(3)
  const [started, setStarted] = useState(false)
  const left = useCountdown(mins * 60, started)
  return (
    <div className="max-w-xl mx-auto">
      <p className="text-text-1 text-sm leading-relaxed">
        Optional. Write whatever is on your mind about this game: nerves, the last loss, the rating. Getting it on paper
        frees attention for the board.
      </p>
      <p className="mt-2 text-xs text-accent inline-flex items-center gap-1.5"><Lock size={12} />Stays on this device. Not saved, not sent to Forked or the coach.</p>
      <textarea value={text} onChange={e => { setText(e.target.value); if (!started) setStarted(true) }}
        rows={7} className="input mt-4 resize-none leading-relaxed" placeholder="What's on your mind…" aria-label="Your thoughts (not saved)" />
      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="flex gap-1.5">
          {[2, 3, 5].map(m => (
            <button key={m} onClick={() => setMins(m)} disabled={started}
              className={`px-3 py-1 rounded-md text-xs border ${mins === m ? 'border-accent text-accent' : 'border-border text-text-2'}`}>{m} min</button>
          ))}
        </div>
        {started && <span className="text-xs text-text-2 tabular-nums">{mmss(left)}</span>}
        <button onClick={() => { setText(''); onDone() }} className="btn-primary">{text ? 'Let it go: continue' : 'Skip'}</button>
      </div>
    </div>
  )
}

// ── Move First ──────────────────────────────────────────────────────────────

export function MoveNudge({ onDone }: { onDone: () => void }) {
  const [mins, setMins] = useState(3)
  const [started, setStarted] = useState(false)
  const left = useCountdown(mins * 60, started)
  useEffect(() => { if (started && left === 0) onDone() }, [left, started, onDone])
  return (
    <div className="max-w-md mx-auto text-center">
      <p className="text-text-1">Stand up. Walk around, roll your shoulders, shake out your arms. A few minutes of movement wakes you up.</p>
      {!started ? (
        <>
          <div className="mt-5 flex justify-center gap-2">
            {[2, 3, 5].map(m => (
              <button key={m} onClick={() => setMins(m)}
                className={`px-4 py-2 rounded-lg border text-sm ${mins === m ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-1'}`}>{m} min</button>
            ))}
          </div>
          <button onClick={() => setStarted(true)} className="btn-primary mt-6 px-8 py-3 text-base">Start timer</button>
          <button onClick={onDone} className="block mx-auto mt-3 text-xs text-text-2 hover:text-text-0">Skip</button>
        </>
      ) : (
        <>
          <p className="font-display text-7xl font-semibold neon-text mt-6 tabular-nums">{mmss(left)}</p>
          <button onClick={onDone} className="btn-ghost border border-border mt-6">I'm back</button>
        </>
      )}
    </div>
  )
}
