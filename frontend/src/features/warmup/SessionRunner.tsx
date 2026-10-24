import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowRight, Check, Flame, X } from 'lucide-react'
import {
  warmupApi, type ActivityId, type DrillItem, type EventRow, type Session, type Step, type Summary,
} from './api'
import { META } from './meta'
import { prefersReducedMotion, useBoardWidth } from './components/DrillBoard'
import type { Answer, DrillProps } from './drills/types'
import { CheckFlash } from './drills/CheckFlash'
import { DoubleCheckHunt } from './drills/DoubleCheckHunt'
import { LoosePieces } from './drills/LoosePieces'
import { ThreatCount } from './drills/ThreatCount'
import { WhatChanged } from './drills/WhatChanged'
import { OpponentThreat } from './drills/OpponentThreat'
import { TwoCandidates } from './drills/TwoCandidates'
import { EasySprint } from './drills/EasySprint'
import { BreathingReset, MoveNudge, SetupCheck, WorryDump } from './state/StateActivities'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DRILLS: Partial<Record<ActivityId, ComponentType<DrillProps<any>>>> = {
  check_flash: CheckFlash, double_check_hunt: DoubleCheckHunt, loose_pieces: LoosePieces, threat_count: ThreatCount,
  what_changed: WhatChanged, opponent_threat: OpponentThreat, two_candidates: TwoCandidates, easy_sprint: EasySprint,
}
/** Thinking drills: on a miss, the player clicks Next after studying the answer. */
const STUDY_ON_MISS = new Set<ActivityId>(['opponent_threat', 'two_candidates', 'easy_sprint'])
const ALWAYS_STUDY = new Set<ActivityId>(['two_candidates'])

interface Props {
  session: Session
  username: string
  onExit: () => void
  onFinished: (summary: Summary | null, usedIds: string[]) => void
}

interface Feedback { answer: Answer | null; ms: number }

export function SessionRunner({ session, username, onExit, onFinished }: Props) {
  const [stepIdx, setStepIdx] = useState(0)
  const [intro, setIntro] = useState(true)
  const step = session.steps[stepIdx]
  const buffer = useRef<EventRow[]>([])
  const used = useRef<string[]>([])
  const reducedMotion = useMemo(prefersReducedMotion, [])

  const flush = useCallback(async () => {
    const events = buffer.current.splice(0)
    if (!events.length) return
    try {
      await warmupApi.events({ session_id: session.id, username, band: session.band.id, time_control: session.time_control, events })
    } catch { buffer.current.unshift(...events) }
  }, [session, username])

  const nextStep = useCallback(async () => {
    await flush()
    if (stepIdx + 1 >= session.steps.length) {
      let summary: Summary | null = null
      try { summary = await warmupApi.finish(session.id, username) } catch { /* offline: still let them play */ }
      onFinished(summary, used.current)
      return
    }
    setStepIdx(i => i + 1)
    setIntro(true)
  }, [flush, stepIdx, session, username, onFinished])

  // Enter / Space starts a step from its intro card
  useEffect(() => {
    if (!intro) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setIntro(false) } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [intro])

  return (
    <div className="min-h-[calc(100vh-56px)] flex flex-col">
      {/* progress across the whole session */}
      <div className="sticky top-14 z-20 bg-bg-0/90 backdrop-blur-xl border-b border-border">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <button onClick={() => { void flush(); onExit() }} aria-label="Leave the warm-up" className="p-1.5 rounded-lg text-text-2 hover:text-text-0 hover:bg-bg-2"><X size={18} /></button>
          <div className="flex-1 flex gap-1.5" aria-label={`Step ${stepIdx + 1} of ${session.steps.length}`}>
            {session.steps.map((s, i) => (
              <div key={i} title={s.title} className={`h-1.5 flex-1 rounded-full transition-colors duration-300
                ${i < stepIdx ? 'bg-accent' : i === stepIdx ? 'bg-accent/50 animate-pulse' : 'bg-bg-3'}`} />
            ))}
          </div>
          <span className="text-xs text-text-2 tabular-nums">{stepIdx + 1}/{session.steps.length}</span>
        </div>
      </div>

      <div className="flex-1 max-w-5xl w-full mx-auto px-4 py-6">
        <AnimatePresence mode="wait">
          {intro ? (
            <motion.div key={`intro-${stepIdx}`} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
              <StepIntro step={step} onStart={() => setIntro(false)} />
            </motion.div>
          ) : step.kind === 'state' ? (
            <motion.div key={`state-${stepIdx}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <StateHeader step={step} />
              {step.activity === 'setup_check' && <SetupCheck timeControl={session.time_control} onDone={nextStep} />}
              {step.activity === 'breathing_reset' && <BreathingReset reducedMotion={reducedMotion} onDone={nextStep} />}
              {step.activity === 'worry_dump' && <WorryDump onDone={nextStep} />}
              {step.activity === 'move_nudge' && <MoveNudge onDone={nextStep} />}
            </motion.div>
          ) : (
            <motion.div key={`drill-${stepIdx}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <DrillStep step={step} session={session} reducedMotion={reducedMotion}
                log={e => { buffer.current.push(e); if (buffer.current.length >= 6) void flush() }}
                markUsed={id => used.current.push(id)} onDone={nextStep} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

function StepIntro({ step, onStart }: { step: Step; onStart: () => void }) {
  const m = META[step.activity]
  const I = m.icon
  return (
    <div className="max-w-lg mx-auto text-center pt-6 sm:pt-12">
      <span className="mx-auto w-16 h-16 rounded-2xl grid place-items-center border border-accent/40 bg-accent/10 text-accent shadow-neon-sm">
        <I size={28} />
      </span>
      <p className="mt-5 text-[11px] uppercase tracking-[0.25em] text-text-2">{m.group}{step.count ? ` · ${step.count} items` : ''}</p>
      <h2 className="font-display text-3xl sm:text-4xl font-semibold text-text-0 mt-2">{m.title}</h2>
      <p className="text-text-1 mt-3 leading-relaxed">{m.how}</p>
      {step.reason && <p className="mt-4 text-sm text-accent/90 border border-accent/25 bg-accent/[0.06] rounded-xl px-4 py-2.5">{step.reason}</p>}
      {m.keys && <p className="mt-3 text-xs text-text-2 [@media(pointer:coarse)]:hidden">Keys: {m.keys}</p>}
      <button onClick={onStart} autoFocus className="btn-primary mt-8 px-10 py-3.5 text-base inline-flex items-center gap-2">
        Start <ArrowRight size={17} /><kbd className="[@media(pointer:coarse)]:hidden text-[10px] opacity-60 ml-1">Enter</kbd>
      </button>
    </div>
  )
}

function StateHeader({ step }: { step: Step }) {
  const m = META[step.activity]
  const I = m.icon
  return (
    <div className="flex items-center justify-center gap-2 mb-6">
      <I size={18} className="text-accent" />
      <h2 className="font-display text-xl font-semibold text-text-0">{m.title}</h2>
    </div>
  )
}

// ── one drill step: item sequencing, adaptivity, time caps, feedback ────────

function DrillStep({ step, session, reducedMotion, log, markUsed, onDone }: {
  step: Step; session: Session; reducedMotion: boolean
  log: (e: EventRow) => void; markUsed: (id: string) => void; onDone: () => void
}) {
  const Drill = DRILLS[step.activity]!
  const m = META[step.activity]
  const [level, setLevel] = useState(step.level ?? 3)
  const usedIds = useRef(new Set<string>())
  const recent = useRef<boolean[]>([])
  const [done, setDone] = useState(0)
  const [right, setRight] = useState(0)
  const [streak, setStreak] = useState(0)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [boardRef, width] = useBoardWidth(step.activity === 'double_check_hunt' ? 640 : 520)
  const total = step.count ?? 5
  // time cap per item: relaxed on the first question, a little quicker after each one
  const timer = session.timer ?? { start_factor: 1, per_item: 0, min_factor: 1 }
  const capMs = step.cap_ms ? Math.round(step.cap_ms * Math.max(timer.min_factor, timer.start_factor - timer.per_item * done)) : null

  const pick = useCallback((lv: number): DrillItem | null => {
    const order = [lv, lv - 1, lv + 1, lv - 2, lv + 2].filter(x => x >= 1 && x <= 5)
    for (const l of order) {
      const it = (step.pools?.[String(l)] ?? []).find(x => !usedIds.current.has(x.id))
      if (it) return it
    }
    return null
  }, [step.pools])
  const [item, setItem] = useState<DrillItem | null>(() => pick(step.level ?? 3))
  useEffect(() => { if (item) usedIds.current.add(item.id) }, [item])

  const advance = useCallback(() => {
    setFeedback(null)
    if (done >= total) { onDone(); return }
    const nx = pick(level)
    if (!nx) { onDone(); return }
    setItem(nx)
  }, [done, total, level, pick, onDone])

  const answered = useCallback((a: Answer | null) => {
    if (!item || feedback) return
    const correct = !!a?.correct
    log({ drill_id: step.activity, item_id: item.id, correct, score: a?.score ?? (correct ? 1 : 0),
          response_ms: a ? Math.round(a.response_ms) : capMs ?? undefined, difficulty: item.level,
          extra: { ...(a?.extra ?? {}), ...(a ? {} : { timeout: true }) } })
    if (step.activity === 'easy_sprint') markUsed(item.id)
    setDone(d => d + 1)
    if (correct) { setRight(r => r + 1); setStreak(s => s + 1) } else setStreak(0)
    // adapt between items: ease below ~70%, harden on a perfect window
    recent.current.push(correct)
    const w = session.adaptive.window
    if (recent.current.length >= w) {
      const acc = recent.current.slice(-w).filter(Boolean).length / w
      if (acc < session.adaptive.ease_below && level > 1) { setLevel(l => l - 1); recent.current = [] }
      else if (acc > session.adaptive.harden_above && level < 5) { setLevel(l => l + 1); recent.current = [] }
    }
    setFeedback({ answer: a, ms: correct ? (step.kind === 'thinking' ? 900 : 520) : 1600 })
  }, [item, feedback, log, step, session.adaptive, level, markUsed, capMs])

  // time cap per item: relaxed on the first question, a little quicker after each one
  // (data/warmup_config.json "timer"); the ref keeps the timer from restarting on re-renders
  const answeredRef = useRef(answered)
  answeredRef.current = answered
  useEffect(() => {
    if (!item || feedback || !capMs) return
    const t = window.setTimeout(() => answeredRef.current(null), capMs)
    return () => clearTimeout(t)
  }, [item, feedback, capMs])

  // auto-advance after feedback (except where the answer is worth studying)
  const study = !!feedback && (ALWAYS_STUDY.has(step.activity) || (!feedback.answer?.correct && STUDY_ON_MISS.has(step.activity)))
  useEffect(() => {
    if (!feedback || study) return
    const t = window.setTimeout(advance, feedback.ms)
    return () => clearTimeout(t)
  }, [feedback, study, advance])
  useEffect(() => {
    if (!study) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); advance() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [study, advance])

  if (!item) return <p className="text-center text-text-2 py-10">No items for this drill right now. <button className="text-accent" onClick={onDone}>Continue</button></p>
  const I = m.icon
  const correct = feedback?.answer?.correct
  return (
    <div>
      <div className="flex items-center gap-3 mb-2">
        <I size={18} className="text-accent" />
        <h2 className="font-display text-lg font-semibold text-text-0">{m.title}</h2>
        <span className="text-xs text-text-2 tabular-nums">{Math.min(done + (feedback ? 0 : 1), total)} / {total}</span>
        <span className="hidden sm:inline-flex items-center gap-0.5 ml-1" title={`Difficulty ${level} of 5`}>
          {[1, 2, 3, 4, 5].map(l => <span key={l} className={`w-1.5 h-1.5 rounded-full ${l <= level ? 'bg-accent' : 'bg-bg-3'}`} />)}
        </span>
        <span className="ml-auto inline-flex items-center gap-3 text-xs">
          {streak >= 3 && <span className="inline-flex items-center gap-1 text-accent font-semibold"><Flame size={13} />{streak}</span>}
          <span className="text-text-2 tabular-nums">{right}/{done} right</span>
        </span>
      </div>
      {/* time-cap bar */}
      <div className="h-1 rounded-full bg-bg-3 overflow-hidden mb-5">
        {capMs && !feedback && (
          <motion.div key={item.id} className="h-full bg-accent" initial={{ width: '100%' }} animate={{ width: '0%' }}
            transition={{ duration: capMs / 1000, ease: 'linear' }} />
        )}
      </div>

      <div ref={boardRef} className="relative w-full max-w-[640px] mx-auto">
        <motion.div key={item.id} initial={{ opacity: 0, scale: .985 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: .15 }}
          className={`rounded-2xl transition-shadow duration-200 ${feedback ? (correct ? 'ring-[3px] ring-accent ring-offset-2 ring-offset-bg-0' : 'ring-[3px] ring-danger ring-offset-2 ring-offset-bg-0') : ''}`}>
          <Drill item={item} reveal={!!feedback} given={feedback?.answer ?? null} width={width}
            reducedMotion={reducedMotion} onAnswer={answered} />
        </motion.div>
        <AnimatePresence>
          {feedback && (
            <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className={`absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full text-xs font-semibold inline-flex items-center gap-1.5
                ${correct ? 'bg-accent text-accent-ink' : 'bg-danger text-text-0'}`}>
              {correct ? <Check size={12} /> : <X size={12} />}
              {feedback.answer ? (correct ? `${Math.round(feedback.answer.response_ms)} ms` : 'Not quite') : 'Time'}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {study && (
        <div className="flex justify-center mt-5">
          <button onClick={advance} autoFocus className="btn-primary px-8 inline-flex items-center gap-2">Next <ArrowRight size={15} /><kbd className="[@media(pointer:coarse)]:hidden text-[10px] opacity-60">Enter</kbd></button>
        </div>
      )}
    </div>
  )
}
