import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Accessibility, ArrowRight, BellOff, Brain, Check, Coffee, Dice5, ExternalLink, Eye, FlaskConical, Flame, History, Info,
  Layers, Loader2, Pencil, Play, Route, ScanSearch, Sparkles, Swords, Target, Timer, X, type LucideIcon,
} from 'lucide-react'
import { SectionHeader, SectionHeaderStat } from '../../components/layout/SectionHeader'
import { useUserStore } from '../../store/userStore'
import {
  warmupApi, type ActivityId, type Minutes, type Moment, type Profile, type Session, type Summary, type TimeControl, type Who,
} from './api'
import { META, TC_LABEL, fmtMs, pct } from './meta'
import { SessionRunner } from './SessionRunner'
import { ReadyScreen } from './ReadyScreen'
import { RoutineBuilder } from './RoutineBuilder'

const TCS: TimeControl[] = ['bullet', 'blitz', 'rapid', 'classical']
const LENGTHS: { m: Minutes; label: string; vision: number; thinking: number }[] = [
  { m: 3, label: 'Quick', vision: 1, thinking: 0 },
  { m: 5, label: 'Standard', vision: 2, thinking: 1 },
  { m: 10, label: 'Full', vision: 3, thinking: 2 },
]
const GROUPS: { id: 'Perception' | 'Thinking' | 'Reset'; title: string; blurb: string }[] = [
  { id: 'Perception', title: 'See the board', blurb: 'Fast, timed recognition on real positions: checks, loose pieces, attacks, changes.' },
  { id: 'Thinking', title: 'Think before you move', blurb: 'Slower drills for the habits that stop blunders: their threat, a second candidate.' },
  { id: 'Reset', title: 'Settle in', blurb: 'Your setup, your breathing, your head. Short and optional.' },
]

// per-viewer conveniences only (never state that must persist)
const LS = { tc: 'forked-warmup-tc', min: 'forked-warmup-min', rating: 'forked-warmup-rating', seen: 'forked-warmup-seen', rm: 'forked-warmup-reduced-motion' }
const lsGet = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const lsSet = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v) } catch { /* private mode */ } }

type View =
  | { kind: 'home' }
  | { kind: 'starting'; label: string }
  | { kind: 'control'; momentId: string; playUrl: string }
  | { kind: 'run'; session: Session; momentId: string | null }
  | { kind: 'ready'; session: Session; summary: Summary | null; momentId: string | null }

export default function WarmupPage() {
  const { username, platform, elo } = useUserStore()
  const qc = useQueryClient()
  const [tc, setTc] = useState<TimeControl>(() => (lsGet(LS.tc) as TimeControl) || 'blitz')
  const [minutes, setMinutes] = useState<Minutes>(() => (Number(lsGet(LS.min)) as Minutes) || 5)
  const [manual, setManual] = useState<number | null>(() => Number(lsGet(LS.rating)) || null)
  const [view, setView] = useState<View>({ kind: 'home' })
  const [err, setErr] = useState('')
  const [editRoutine, setEditRoutine] = useState(false)
  useEffect(() => lsSet(LS.tc, tc), [tc])
  useEffect(() => lsSet(LS.min, String(minutes)), [minutes])
  useEffect(() => lsSet(LS.rating, manual ? String(manual) : null), [manual])

  const who: Who = { username: username || 'Guest', platform, time_control: tc, elo: elo || undefined, rating: manual ?? undefined }
  const profileQ = useQuery<Profile>({
    queryKey: ['warmup-profile', who.username, platform, tc, manual],
    queryFn: () => warmupApi.profile(who),
    staleTime: 60_000,
  })
  const p = profileQ.data
  useEffect(() => { window.scrollTo({ top: 0 }) }, [view.kind])

  const seen = (): string[] => { try { return JSON.parse(lsGet(LS.seen) ?? '[]') } catch { return [] } }
  const start = async (opts: { routine?: boolean; activities?: ActivityId[]; label: string; pregame: boolean }) => {
    setErr('')
    setView({ kind: 'starting', label: opts.label })
    try {
      let momentId: string | null = null
      if (opts.pregame) {
        const mo = await warmupApi.moment(who)
        momentId = mo.moment_id
        if (mo.arm === 'control') { setView({ kind: 'control', momentId, playUrl: mo.play_url }); return }
      }
      const session = await warmupApi.session({ ...who, minutes, use_routine: opts.routine, activities: opts.activities,
                                                 moment_id: momentId ?? undefined, seen: seen() })
      setView({ kind: 'run', session, momentId })
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not start the warm-up')
      setView({ kind: 'home' })
    }
  }
  const finished = (session: Session, momentId: string | null) => (summary: Summary | null, used: string[]) => {
    lsSet(LS.seen, JSON.stringify([...seen(), ...used].slice(-400)))
    setView({ kind: 'ready', session, summary, momentId })
    void qc.invalidateQueries({ queryKey: ['warmup-profile'] })
  }
  const played = (momentId: string | null) => { if (momentId) void warmupApi.momentPlay(momentId).catch(() => {}) }

  if (view.kind === 'run') {
    return <SessionRunner session={view.session} username={who.username}
      onExit={() => { setView({ kind: 'home' }); void qc.invalidateQueries({ queryKey: ['warmup-profile'] }) }}
      onFinished={finished(view.session, view.momentId)} />
  }
  if (view.kind === 'ready') {
    return <ReadyScreen session={view.session} summary={view.summary}
      onPlay={() => played(view.momentId)}
      onAgain={() => start({ label: 'Building another round', pregame: false })}
      onHome={() => setView({ kind: 'home' })} />
  }
  if (view.kind === 'control') {
    return <ControlScreen platformName={platform === 'lichess' ? 'Lichess' : 'Chess.com'} playUrl={view.playUrl}
      onPlay={() => played(view.momentId)} onHome={() => setView({ kind: 'home' })} />
  }

  return (
    <div className="relative isolate">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[460px] -z-10">
        <div className="absolute inset-0 grid-backdrop" />
        <div className="absolute left-1/2 -translate-x-1/2 -top-40 w-[760px] max-w-full h-[320px] rounded-full bg-accent/10 blur-[110px]" />
      </div>
      <div className="max-w-6xl mx-auto px-4 lg:px-8 pt-6 pb-16">
        <SectionHeader icon={Flame} title="Warm-Up"
          description="A few minutes before you play: wake up your board vision on real positions, settle in, then go straight to your game."
          right={p && <SectionHeaderStat label="Band" value={<span className="text-accent font-semibold">{p.band.label}</span>} />} />

        {p?.tilt.triggered && <TiltBanner profile={p} />}
        {err && (
          <div className="mb-4 rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-text-0 flex items-center gap-2">
            <X size={15} className="text-danger" />{err}
            <button onClick={() => setErr('')} className="ml-auto text-text-2 hover:text-text-0 text-xs">Dismiss</button>
          </div>
        )}

        <div className="grid lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] gap-5">
          <PreFlight profile={p} loading={profileQ.isLoading} tc={tc} setTc={setTc} minutes={minutes} setMinutes={setMinutes}
            manual={manual} setManual={setManual} platform={platform} view={view}
            onStart={() => start({ label: 'Building your warm-up', pregame: true })}
            onRoutine={() => start({ routine: true, label: 'Loading your routine', pregame: true })}
            onEditRoutine={() => setEditRoutine(true)} />
          <div className="space-y-5">
            <FactsCard profile={p} />
            <HistoryCard history={p?.history ?? []} />
          </div>
        </div>

        <Library profile={p} disabled={view.kind === 'starting'}
          onTry={a => start({ activities: [a], label: `Loading ${META[a].title}`, pregame: false })}
          onCustom={ids => start({ activities: ids, label: 'Building your custom warm-up', pregame: true })} />

        <div className="mt-10 grid md:grid-cols-2 gap-5">
          <ExperimentCard profile={p} username={who.username}
            onChange={() => qc.invalidateQueries({ queryKey: ['warmup-profile'] })} />
          <MotionCard />
        </div>

        <p className="mt-10 text-[11px] text-text-2 leading-relaxed max-w-3xl flex gap-2">
          <Info size={12} className="flex-shrink-0 mt-0.5" />
          {p?.honesty ?? 'No study has yet tested pre-game chess warm-ups, so Forked measures your own games before and after to find out what helps you.'}
          {' '}Warm-up puzzles don't change your Puzzle Themes rating or your drill schedule.
        </p>
      </div>

      <AnimatePresence>
        {editRoutine && p && (
          <RoutineBuilder profile={p} initial={p.routine ?? ['setup_check', ...p.band.emphasis.slice(0, 2), ...p.band.thinking.slice(0, 1), 'easy_sprint']}
            onClose={() => setEditRoutine(false)}
            onSave={async steps => { await warmupApi.saveRoutine(who.username, steps); await qc.invalidateQueries({ queryKey: ['warmup-profile'] }) }} />
        )}
      </AnimatePresence>
    </div>
  )
}

// ── pre-flight ──────────────────────────────────────────────────────────────

function PreFlight({ profile: p, loading, tc, setTc, minutes, setMinutes, manual, setManual, platform, view, onStart, onRoutine, onEditRoutine }: {
  profile?: Profile; loading: boolean; tc: TimeControl; setTc: (t: TimeControl) => void; minutes: Minutes; setMinutes: (m: Minutes) => void
  manual: number | null; setManual: (r: number | null) => void; platform: string; view: View
  onStart: () => void; onRoutine: () => void; onEditRoutine: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(manual ? String(manual) : '')
  const starting = view.kind === 'starting'
  const r = p?.rating
  const source = r?.source === 'manual' ? 'set by you'
    : r?.source === 'profile' || !r?.source ? 'from your profile (no recent games at this speed)'
      : `your ${TC_LABEL[tc].toLowerCase()} rating on ${r.platform === 'lichess' ? 'Lichess' : 'Chess.com'}`
  const saveRating = () => { const n = Number(draft); setManual(n >= 100 && n <= 3500 ? Math.round(n) : null); setEditing(false) }

  return (
    <section className="relative flex flex-col rounded-3xl border border-border bg-bg-1/80 backdrop-blur p-5 sm:p-7 overflow-hidden">
      <div aria-hidden className="absolute -right-24 -top-24 w-72 h-72 rounded-full bg-accent/[0.07] blur-3xl" />
      <p className="text-[11px] uppercase tracking-[0.25em] text-accent/80">Before your next game</p>
      <h2 className="font-display text-2xl sm:text-3xl font-semibold text-text-0 mt-1.5">What are you about to play?</h2>

      <Label>Time control</Label>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" role="radiogroup" aria-label="Time control">
        {TCS.map(t => {
          const on = t === tc
          const rating = p?.ratings?.[t]
          return (
            <button key={t} role="radio" aria-checked={on} onClick={() => setTc(t)}
              className={`rounded-xl border px-3 py-2.5 text-left transition-all ${on ? 'border-accent bg-accent/10 shadow-neon-sm' : 'border-border bg-bg-2 hover:border-border-hover'}`}>
              <span className={`block text-sm font-semibold ${on ? 'text-accent' : 'text-text-0'}`}>{TC_LABEL[t]}</span>
              <span className="block text-[11px] text-text-2 tabular-nums">{rating ? `${rating}` : 'no recent games'}</span>
            </button>
          )
        })}
      </div>

      <Label>Length</Label>
      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Length">
        {LENGTHS.map(l => {
          const on = l.m === minutes
          return (
            <button key={l.m} role="radio" aria-checked={on} onClick={() => setMinutes(l.m)}
              className={`rounded-xl border px-3 py-2.5 transition-all ${on ? 'border-accent bg-accent/10 shadow-neon-sm' : 'border-border bg-bg-2 hover:border-border-hover'}`}>
              <span className={`block font-display text-xl font-semibold tabular-nums ${on ? 'text-accent' : 'text-text-0'}`}>{l.m}<span className="text-xs font-sans font-normal ml-0.5">min</span></span>
              <span className="block text-[11px] text-text-2">{l.label}</span>
            </button>
          )
        })}
      </div>
      <PlanStrip minutes={minutes} />

      {/* band / rating */}
      <div className="mt-5 rounded-xl border border-border bg-bg-2/60 px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        {loading || !p ? (
          <span className="text-sm text-text-2 inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" />Reading your recent games…</span>
        ) : (
          <>
            <span className="text-sm text-text-1">Tuned for <b className="text-text-0">{p.band.label}</b></span>
            <span className="text-xs text-text-2 tabular-nums">{r?.rating} · {source}</span>
            {editing ? (
              <span className="inline-flex items-center gap-1.5 ml-auto">
                <input autoFocus value={draft} onChange={e => setDraft(e.target.value.replace(/\D/g, ''))} onKeyDown={e => e.key === 'Enter' && saveRating()}
                  inputMode="numeric" aria-label="Your rating" placeholder="e.g. 1450" className="input !w-24 py-1 text-sm tabular-nums" />
                <button onClick={saveRating} className="p-1.5 rounded-md bg-accent text-accent-ink" aria-label="Use this rating"><Check size={14} /></button>
                {manual && <button onClick={() => { setManual(null); setDraft(''); setEditing(false) }} className="text-xs text-text-2 hover:text-text-0">Auto</button>}
              </span>
            ) : (
              <button onClick={() => setEditing(true)} className="ml-auto text-xs text-text-2 hover:text-accent inline-flex items-center gap-1"><Pencil size={11} />Set rating</button>
            )}
            {r?.note && <p className="basis-full text-[11px] text-text-2">{r.note}</p>}
          </>
        )}
      </div>

      <button onClick={onStart} disabled={starting || !p}
        className="btn-primary w-full mt-6 py-4 text-lg inline-flex items-center justify-center gap-2.5 group">
        {starting ? <><Loader2 size={18} className="animate-spin" />{view.label}…</> : <>I'm about to play <ArrowRight size={18} className="transition-transform group-hover:translate-x-0.5" /></>}
      </button>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        {p?.routine?.length ? (
          <>
            <button onClick={onRoutine} disabled={starting} className="btn-ghost border border-border inline-flex items-center gap-1.5">
              <Route size={14} className="text-accent" />Run my routine <span className="text-text-2">· {p.routine.length} steps</span>
            </button>
            <button onClick={onEditRoutine} className="btn-ghost text-xs">Edit</button>
          </>
        ) : (
          <button onClick={onEditRoutine} disabled={!p} className="btn-ghost inline-flex items-center gap-1.5 text-xs"><Route size={13} />Build a fixed routine</button>
        )}
        <span className="ml-auto text-[11px] text-text-2 hidden sm:inline">Then straight to {platform === 'lichess' ? 'Lichess' : 'Chess.com'}</span>
      </div>

      <ul className="mt-auto pt-7 grid sm:grid-cols-3 gap-3">
        {([
          [Timer, 'Timed for your clock', 'Faster limits before bullet, more time before classical.'],
          [Target, 'Mostly easy on purpose', 'Aim for about 85% right. It eases off if you miss a few.'],
          [ScanSearch, 'Then we check the game', 'Your next game is reviewed by Stockfish for blunders.'],
        ] as [LucideIcon, string, string][]).map(([I, t, d]) => (
          <li key={t} className="rounded-xl border border-border bg-bg-2/40 px-3.5 py-3">
            <I size={15} className="text-accent" />
            <p className="text-xs font-semibold text-text-0 mt-1.5">{t}</p>
            <p className="text-[11px] text-text-2 mt-0.5 leading-relaxed">{d}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}

function PlanStrip({ minutes }: { minutes: Minutes }) {
  const l = LENGTHS.find(x => x.m === minutes) ?? LENGTHS[1]
  const parts: { icon: LucideIcon; label: string; accent?: boolean }[] = [
    { icon: BellOff, label: 'Setup' },
    { icon: Eye, label: `${l.vision} vision drill${l.vision > 1 ? 's' : ''}` },
    ...(l.thinking ? [{ icon: Brain, label: `${l.thinking} thinking drill${l.thinking > 1 ? 's' : ''}` }] : []),
    { icon: Layers, label: 'Easy tactics' },
    { icon: Swords, label: 'Play', accent: true },
  ]
  return (
    <ol className="mt-3 flex flex-wrap items-center gap-y-2" aria-label="What this warm-up contains">
      {parts.map((p, i) => (
        <li key={p.label} className="flex items-center">
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]
            ${p.accent ? 'border-accent/50 text-accent bg-accent/10' : 'border-border text-text-1 bg-bg-2'}`}>
            <p.icon size={12} />{p.label}
          </span>
          {i < parts.length - 1 && <span aria-hidden className="w-3 h-px bg-border-hover mx-0.5" />}
        </li>
      ))}
    </ol>
  )
}

const Label = ({ children }: { children: ReactNode }) => <p className="text-[11px] uppercase tracking-[0.2em] text-text-2 mt-6 mb-2">{children}</p>

// ── tilt (advisory, never a block) ─────────────────────────────────────────

function TiltBanner({ profile: p }: { profile: Profile }) {
  const [hidden, setHidden] = useState(false)
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
  if (hidden) return null
  const left = p.tilt.break_until ? Math.max(0, Math.round(p.tilt.break_until - now / 1000)) : 0
  const copy = p.tilt_copy.replace('{streak}', String(p.tilt.streak))
  return (
    <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
      className="mb-5 rounded-2xl border border-warn/40 bg-warn/[0.07] px-4 sm:px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-3">
      <span className="w-10 h-10 rounded-xl grid place-items-center bg-warn/15 text-warn flex-shrink-0"><Coffee size={19} /></span>
      <div className="flex-1">
        <p className="text-sm text-text-0">{copy}</p>
        {left > 0 && <p className="text-xs text-text-2 mt-0.5 tabular-nums">30 minutes since your last game in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</p>}
      </div>
      <button onClick={() => setHidden(true)} className="btn-ghost border border-border text-xs self-start sm:self-auto">Warm up anyway</button>
    </motion.div>
  )
}

// ── own-game facts ──────────────────────────────────────────────────────────

function FactsCard({ profile: p }: { profile?: Profile }) {
  const f = p?.facts
  const max = Math.max(1, ...(f?.focus ?? []).map(x => x.count))
  return (
    <section className="rounded-3xl border border-border bg-bg-1 p-5">
      <div className="flex items-center gap-2">
        <Sparkles size={15} className="text-accent" />
        <h3 className="font-display font-semibold text-text-0">From your games</h3>
      </div>
      {!p ? <Skeleton rows={3} /> : f && f.games > 0 && f.focus.length ? (
        <>
          <p className="text-xs text-text-2 mt-1">Biggest losses in your last {f.games} analysed games. Warm-ups lean toward the drills for these.</p>
          <ul className="mt-4 space-y-3">
            {f.focus.slice(0, 4).map(x => (
              <li key={x.fact}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm text-text-0">{x.label}</span>
                  <span className="text-xs text-text-2 tabular-nums">{x.count}</span>
                </div>
                <div className="h-1.5 rounded-full bg-bg-3 mt-1.5 overflow-hidden">
                  <motion.div className="h-full rounded-full bg-accent" initial={{ width: 0 }} animate={{ width: `${(x.count / max) * 100}%` }} transition={{ duration: .6 }} />
                </div>
                <p className="text-[11px] text-text-2 mt-1">{x.drills.map(d => META[d]?.title).filter(Boolean).join(' · ')}</p>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-sm text-text-2 mt-3 leading-relaxed">No analysed games yet. Warm-ups work without them; once your games are imported they lean toward the mistakes you actually make.</p>
      )}
    </section>
  )
}

// ── history ─────────────────────────────────────────────────────────────────

function ago(ts: number) {
  const s = Date.now() / 1000 - ts
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

function HistoryCard({ history }: { history: Moment[] }) {
  return (
    <section className="rounded-3xl border border-border bg-bg-1 p-5">
      <div className="flex items-center gap-2">
        <History size={15} className="text-accent" />
        <h3 className="font-display font-semibold text-text-0">Recent warm-ups</h3>
      </div>
      {history.length === 0 ? (
        <p className="text-sm text-text-2 mt-3 leading-relaxed">Your warm-ups, and the games you play right after, show up here. Games are reviewed by Stockfish.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border">
          {history.slice(0, 6).map(m => (
            <li key={m.id} className="py-2.5">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-text-0">{TC_LABEL[m.time_control] ?? m.time_control}</span>
                {m.arm === 'control'
                  ? <span className="badge bg-bg-3 text-text-1">No warm-up · comparison</span>
                  : m.summary?.accuracy != null
                    ? <span className="badge bg-accent/10 text-accent">{pct(m.summary.accuracy)} drills</span>
                    : <span className="badge bg-bg-3 text-text-2">Left early</span>}
                <span className="ml-auto text-[11px] text-text-2">{ago(m.created_at)}</span>
              </div>
              {m.outcomes.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {m.outcomes.map(o => (
                    <a key={o.game_id} href={o.url ?? undefined} target="_blank" rel="noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-2 px-2 py-1 text-[11px] text-text-1 hover:border-accent/50">
                      <span className={`font-semibold ${o.result === 1 ? 'text-accent' : o.result === 0 ? 'text-danger' : 'text-text-0'}`}>
                        {o.result === 1 ? 'W' : o.result === 0 ? 'L' : o.result === 0.5 ? 'D' : '·'}
                      </span>
                      {o.blunders} blunder{o.blunders === 1 ? '' : 's'}{o.accuracy != null ? ` · ${Math.round(o.accuracy)}%` : ''}
                      {o.url && <ExternalLink size={10} />}
                    </a>
                  ))}
                </div>
              ) : <p className="text-[11px] text-text-2 mt-1">{Date.now() / 1000 - m.created_at < 3 * 3600 ? 'Looking for the game you played next…' : 'No game within 30 minutes'}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// ── drill library ───────────────────────────────────────────────────────────

function Library({ profile: p, disabled, onTry, onCustom }: {
  profile?: Profile; disabled: boolean; onTry: (a: ActivityId) => void; onCustom: (ids: ActivityId[]) => void
}) {
  const ids = Object.keys(META) as ActivityId[]
  const emphasis = useMemo(() => new Set([...(p?.band.emphasis ?? []), ...(p?.band.thinking ?? [])]), [p])
  const [custom, setCustom] = useState(false)
  const [picked, setPicked] = useState<ActivityId[]>([])
  const toggle = (a: ActivityId) => setPicked(list => (list.includes(a) ? list.filter(x => x !== a) : [...list, a]))
  const est = picked.reduce((sum, a) => sum + (p?.activities?.[a]?.est_s ?? 60), 0)
  return (
    <section className="mt-12">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-1">
        <div>
          <h2 className="font-display text-xl font-semibold text-text-0">Drill library</h2>
          <p className="text-xs text-text-2 mt-0.5">{custom ? 'Tick the drills you want, in the order you tick them, then start.' : 'Try any drill on its own, or build a custom warm-up from several.'}</p>
        </div>
        <button onClick={() => { setCustom(c => !c); setPicked([]) }}
          className={`text-sm px-3 py-1.5 rounded-lg border inline-flex items-center gap-2 transition-colors ${custom ? 'border-accent text-accent bg-accent/10' : 'border-border text-text-0 hover:border-accent/40'}`}>
          <Layers size={14} />{custom ? 'Cancel custom' : 'Custom warm-up'}
        </button>
      </div>
      {GROUPS.map(g => (
        <div key={g.id} className="mt-6">
          <p className="text-[11px] uppercase tracking-[0.2em] text-accent/80">{g.title}</p>
          <p className="text-xs text-text-2 mt-0.5 mb-3">{g.blurb}</p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {ids.filter(a => META[a].group === g.id).map((a, i) => {
              const m = META[a]
              const I = m.icon
              const b = p?.baselines?.[a]
              const locked = a === 'two_candidates' && p && !p.bank_ready
              return (
                <motion.button key={a} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * .04 }}
                  onClick={() => (custom ? toggle(a) : onTry(a))} disabled={disabled || !p || !!locked} aria-pressed={custom ? picked.includes(a) : undefined}
                  className={`hub-tile group p-4 flex flex-col gap-2 min-h-[150px] disabled:opacity-50 disabled:pointer-events-none ${custom && picked.includes(a) ? '!border-accent shadow-neon' : ''}`}>
                  <div className="flex items-start justify-between w-full">
                    <span className="w-10 h-10 rounded-xl grid place-items-center bg-bg-2 border border-border text-text-1 group-hover:text-accent group-hover:border-accent/40 transition-colors">
                      <I size={18} />
                    </span>
                    {custom ? (
                      <span className={`w-6 h-6 rounded-md border grid place-items-center text-[11px] font-bold ${picked.includes(a) ? 'bg-accent border-accent text-accent-ink' : 'border-border text-transparent'}`}>
                        {picked.includes(a) ? picked.indexOf(a) + 1 : '·'}
                      </span>
                    ) : emphasis.has(a) && <span className="badge bg-accent/10 text-accent">For your band</span>}
                  </div>
                  <span className="font-semibold text-text-0">{m.title}</span>
                  <span className="text-xs text-text-2 leading-relaxed flex-1">{m.pitch}</span>
                  <span className="flex items-center justify-between w-full text-[11px]">
                    <span className="text-text-2 tabular-nums">{b && b.items >= 5 ? `${pct(b.accuracy)} · ${fmtMs(b.median_ms)}` : locked ? 'Positions still loading' : ' '}</span>
                    {!custom && <span className="inline-flex items-center gap-1 text-text-1 group-hover:text-accent"><Play size={11} />Try</span>}
                  </span>
                </motion.button>
              )
            })}
          </div>
        </div>
      ))}
      {custom && (
        <div className="sticky bottom-4 z-30 mt-6">
          <div className="mx-auto max-w-2xl rounded-2xl border border-accent/40 bg-bg-1/95 backdrop-blur-xl shadow-neon px-4 py-3 flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-text-0">{picked.length ? `${picked.length} drill${picked.length > 1 ? 's' : ''} · about ${Math.max(1, Math.round(est / 60))} min` : 'Pick at least one drill'}</p>
              <p className="text-[11px] text-text-2 truncate">{picked.map(a => META[a].title).join(' → ') || 'Order follows the order you tick them.'}</p>
            </div>
            <button disabled={!picked.length || disabled} onClick={() => onCustom(picked)} className="btn-primary inline-flex items-center gap-2"><Play size={14} />Start custom warm-up</button>
          </div>
        </div>
      )}
    </section>
  )
}

// ── experiment consent + reduced motion ────────────────────────────────────

function ExperimentCard({ profile: p, username, onChange }: { profile?: Profile; username: string; onChange: () => void }) {
  const [busy, setBusy] = useState(false)
  const on = !!p?.consent
  const guest = username === 'Guest'
  const toggle = async () => {
    setBusy(true)
    try { await warmupApi.consent(username, !on); onChange() } finally { setBusy(false) }
  }
  return (
    <section className="rounded-3xl border border-border bg-bg-1 p-5">
      <div className="flex items-start gap-3">
        <span className="w-10 h-10 rounded-xl grid place-items-center bg-bg-2 border border-border text-accent flex-shrink-0"><FlaskConical size={18} /></span>
        <div className="flex-1">
          <h3 className="font-display font-semibold text-text-0">Find out if warm-ups help you</h3>
          <p className="text-xs text-text-2 mt-1 leading-relaxed">
            Opt in, and about half the times you press <i>I'm about to play</i> we'll skip the warm-up and send you straight to
            your game. Comparing your games with and without a warm-up is the only honest way to know. We show results once
            there are enough games both ways.
          </p>
        </div>
        <Toggle on={on} disabled={busy || !p || guest} onClick={toggle} label="Take part in the comparison" />
      </div>
      {guest && <p className="text-[11px] text-text-2 mt-3">Import your games first: the comparison needs your username.</p>}
    </section>
  )
}

function MotionCard() {
  const [on, setOn] = useState(() => lsGet(LS.rm) === '1')
  return (
    <section className="rounded-3xl border border-border bg-bg-1 p-5">
      <div className="flex items-start gap-3">
        <span className="w-10 h-10 rounded-xl grid place-items-center bg-bg-2 border border-border text-accent flex-shrink-0"><Accessibility size={18} /></span>
        <div className="flex-1">
          <h3 className="font-display font-semibold text-text-0">Reduce motion</h3>
          <p className="text-xs text-text-2 mt-1 leading-relaxed">
            No flicker or flashing: <i>What Changed?</i> shows the two boards side by side and the breathing circle stays still.
            Every drill also works from the keyboard.
          </p>
        </div>
        <Toggle on={on} onClick={() => { lsSet(LS.rm, on ? '0' : '1'); setOn(!on) }} label="Reduce motion" />
      </div>
    </section>
  )
}

function Toggle({ on, onClick, disabled, label }: { on: boolean; onClick: () => void; disabled?: boolean; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} onClick={onClick} disabled={disabled}
      className={`relative w-12 h-7 rounded-full flex-shrink-0 transition-colors disabled:opacity-40 ${on ? 'bg-accent' : 'bg-bg-3 border border-border-hover'}`}>
      <motion.span layout transition={{ type: 'spring', stiffness: 500, damping: 32 }}
        className={`absolute top-1 w-5 h-5 rounded-full ${on ? 'right-1 bg-accent-ink' : 'left-1 bg-text-1'}`} />
    </button>
  )
}

function Skeleton({ rows }: { rows: number }) {
  return <div className="mt-4 space-y-3">{Array.from({ length: rows }, (_, i) => <div key={i} className="h-8 rounded-lg bg-bg-2 animate-pulse" />)}</div>
}

// ── control arm ─────────────────────────────────────────────────────────────

function ControlScreen({ platformName, playUrl, onPlay, onHome }: { platformName: string; playUrl: string; onPlay: () => void; onHome: () => void }) {
  return (
    <div className="max-w-lg mx-auto px-4 py-14 text-center">
      <motion.span initial={{ rotate: -20, scale: .8, opacity: 0 }} animate={{ rotate: 0, scale: 1, opacity: 1 }} transition={{ type: 'spring', damping: 14 }}
        className="mx-auto w-16 h-16 rounded-2xl grid place-items-center border border-accent/40 bg-accent/10 text-accent shadow-neon-sm">
        <Dice5 size={30} />
      </motion.span>
      <p className="mt-5 text-[11px] uppercase tracking-[0.25em] text-text-2">Comparison game</p>
      <h1 className="font-display text-3xl sm:text-4xl font-semibold text-text-0 mt-2">No warm-up this time</h1>
      <p className="text-text-1 mt-3 leading-relaxed">
        The draw picked this game to be played without a warm-up. Go straight to your game: your games with and without a
        warm-up are compared, so you'll see what actually helps you.
      </p>
      <a href={playUrl} target="_blank" rel="noreferrer" onClick={onPlay}
        className="btn-primary w-full mt-8 py-4 text-lg inline-flex items-center justify-center gap-2">
        Play now on {platformName} <ExternalLink size={17} />
      </a>
      <button onClick={onHome} className="mt-4 text-sm text-text-2 hover:text-text-0">Back to Warm-Up</button>
    </div>
  )
}
