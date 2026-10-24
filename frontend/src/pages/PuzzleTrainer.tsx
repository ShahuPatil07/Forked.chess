import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ArrowLeft, ArrowRight, Check, ChevronDown, Eye, ExternalLink, Flame, Lightbulb, ListChecks, Microscope,
  MousePointerClick, Puzzle, RotateCcw, Sparkles, Timer, Trophy, X, Zap,
} from 'lucide-react'
import { SectionHeader } from '../components/layout/SectionHeader'
import { MiniBoardThumbnail } from '../components/openings/MiniBoardThumbnail'
import { ThemePuzzleBoard, puzzleSans, type BoardEvent, type BoardPhase } from '../components/puzzles/ThemePuzzleBoard'
import { useUserStore } from '../store/userStore'
import { useQueryClient } from '@tanstack/react-query'
import {
  themesApi, tagName, themeLabel, type AttemptResponse, type AttemptResult, type CatalogResponse, type Explanation,
  type ThemePuzzle, type TrainMode,
} from '../api/themes'
import { ForkedBadge, useThemesCatalog } from './PuzzleThemes'

// ── angle metadata ──────────────────────────────────────────────────────────

interface AngleMeta {
  title: string
  desc: string
  spot: string[]
  sub: string[]
  parent: string | null
  forked: boolean
  runnable: boolean      // Rush / Streak available
}

const SPECIAL: Record<string, Omit<AngleMeta, 'sub' | 'parent' | 'forked'> & { forked?: boolean }> = {
  weak: { title: 'Weak-spot mix', runnable: true, forked: true,
    desc: 'Built from your blindspot families, the motifs you miss in your own games, and your lowest-rated themes. Each puzzle says why it was picked.',
    spot: ['Each puzzle says which weakness it targets, so you know what you are training.', 'Your per-theme ratings update as you go, so the mix follows your progress.'] },
  game: { title: 'From your games', runnable: true, forked: true,
    desc: 'Every real-game position where you went wrong: your blunders and the tactics you missed. Stockfish checks your answer, so any move as good as the best counts.',
    spot: ['These are your real games, so the pattern will come up again.', 'Before moving, ask: what did my opponent’s last move change?'] },
  'game-blunders': { title: 'Your blunders', runnable: true, forked: true,
    desc: 'The positions where you made a mistake or blunder in your own games. Find the move you should have played. Stockfish accepts any move that keeps the position.',
    spot: ['Blunder-check before you move: what does my move allow?', 'Look at every check and capture your opponent gets after your move.'] },
  'game-missed': { title: 'Tactics you missed', runnable: true, forked: true,
    desc: 'Positions from your own games where a winning tactic was there and you didn’t play it. Any move Stockfish rates as winning counts.',
    spot: ['Before moving, ask: what did my opponent’s last move leave loose?', 'Checks, captures, threats: in that order.'] },
  review: { title: 'Missed puzzles', runnable: false, forked: true,
    desc: 'Puzzles you failed come back on a spaced schedule (6h, 3d, 7d, 21d) until you solve them four times in a row.',
    spot: ['Solving it again isn’t enough. Name the pattern before you move.'] },
}

function useAngleMeta(angle: string, catalog: CatalogResponse | undefined, customThemes: string[], match: string): AngleMeta {
  return useMemo(() => {
    if (SPECIAL[angle]) return { sub: [], parent: null, forked: false, ...SPECIAL[angle] }
    const themes = catalog?.categories.flatMap(c => c.themes) ?? []
    const name = (k: string) => themes.find(t => t.key === k)?.name ?? tagName(k)
    if (angle === 'custom') {
      return {
        title: customThemes.map(name).join(match === 'any' ? ' or ' : ' + ') || 'Custom set',
        desc: `A custom set: puzzles that are ${match === 'any' ? 'any of' : 'all of'} ${customThemes.map(name).join(', ')}.`,
        spot: customThemes.flatMap(k => themes.find(t => t.key === k)?.spot.slice(0, 1) ?? []),
        sub: [], parent: null, forked: true, runnable: true,
      }
    }
    const t = themes.find(x => x.key === angle)
    if (t) return { title: t.name, desc: t.desc, spot: t.spot, sub: t.sub, parent: t.parent, forked: t.forked, runnable: true }
    const fam = catalog?.openings.find(o => o.key === angle)
    const variation = catalog?.openings.flatMap(o => o.variations.map(v => ({ ...v, fam: o }))).find(v => v.key === angle)
    const title = fam?.name ?? (variation ? `${variation.fam.name}: ${variation.name}` : tagName(angle))
    return {
      title, desc: `Tactics that come straight out of the ${title}. These are the traps and shots that come up in this line.`,
      spot: ['Know the typical weaknesses of the structure: which squares and pieces get loose?'],
      sub: [], parent: variation ? variation.fam.key : null, forked: false, runnable: true,
    }
  }, [angle, catalog, customThemes, match])
}

// ── small persisted prefs ───────────────────────────────────────────────────

function usePref<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try { const raw = localStorage.getItem(key); return raw === null ? initial : JSON.parse(raw) as T } catch { return initial }
  })
  const set = useCallback((nv: T) => {
    setV(nv)
    try { localStorage.setItem(key, JSON.stringify(nv)) } catch { /* private mode */ }
  }, [key])
  return [v, set]
}

const DIFFICULTIES = ['easiest', 'easier', 'normal', 'harder', 'hardest'] as const

// ── page ────────────────────────────────────────────────────────────────────

export default function PuzzleTrainer() {
  const { angle = 'mix' } = useParams()
  const [params, setParams] = useSearchParams()
  const { data: catalog } = useThemesCatalog()
  const customThemes = useMemo(() => (params.get('themes') ?? '').split(',').filter(Boolean), [params])
  const match = (params.get('match') === 'any' ? 'any' : 'all') as 'any' | 'all'
  const meta = useAngleMeta(angle, catalog, customThemes, match)
  const mode = (params.get('mode') as TrainMode) || 'practice'
  const setMode = (m: TrainMode) => {
    const next = new URLSearchParams(params)
    if (m === 'practice') next.delete('mode'); else next.set('mode', m)
    setParams(next, { replace: true })
  }

  return (
    <div className="max-w-[1400px] mx-auto px-4 lg:px-6 pt-5 pb-12">
      <Link to="/puzzles" className="inline-flex items-center gap-1.5 text-xs text-text-2 hover:text-accent transition-colors">
        <ArrowLeft size={14} />All themes
      </Link>
      <div className="mt-3 flex flex-col md:flex-row md:items-start md:justify-between md:gap-6">
        <div className="min-w-0 flex-1">
          <SectionHeader icon={Puzzle} title={meta.title} description={meta.desc} />
        </div>
        {meta.runnable && <div className="mb-5 md:mt-1 flex-shrink-0"><ModeTabs mode={mode} onChange={setMode} /></div>}
      </div>
      {mode === 'practice' || !meta.runnable
        ? <PracticeMode key={`${angle}|${customThemes.join(',')}|${match}`} angle={angle} meta={meta} customThemes={customThemes} match={match} />
        : <RunMode key={`${angle}|${mode}|${customThemes.join(',')}`} angle={angle} meta={meta} mode={mode} customThemes={customThemes} match={match} />}
    </div>
  )
}

function ModeTabs({ mode, onChange }: { mode: TrainMode; onChange: (m: TrainMode) => void }) {
  const tabs: { id: TrainMode; label: string; icon: typeof Zap }[] = [
    { id: 'practice', label: 'Practice', icon: Puzzle }, { id: 'rush', label: 'Rush', icon: Timer }, { id: 'streak', label: 'Streak', icon: Flame },
  ]
  return (
    <div className="inline-flex rounded-xl border border-border bg-bg-1 p-1" role="tablist" aria-label="Training mode">
      {tabs.map(t => (
        <button key={t.id} role="tab" aria-selected={mode === t.id} onClick={() => onChange(t.id)}
          className={`inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors
            ${mode === t.id ? 'bg-accent text-accent-ink' : 'text-text-1 hover:text-text-0'}`}>
          <t.icon size={13} />{t.label}
        </button>
      ))}
    </div>
  )
}

// ── practice ────────────────────────────────────────────────────────────────

interface SessionEntry { puzzle: ThemePuzzle; result: AttemptResult; delta: number | null }

type Outcome = { kind: 'solved'; alt: boolean; hinted: boolean } | { kind: 'revealed' }

function PracticeMode({ angle, meta, customThemes, match }: {
  angle: string; meta: AngleMeta; customThemes: string[]; match: 'any' | 'all'
}) {
  const { username, elo } = useUserStore()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [difficulty, setDifficulty] = usePref<string>('forked-pt-difficulty', 'normal')
  const [color, setColor] = usePref<string>('forked-pt-color', '')
  const [autoNext, setAutoNext] = usePref<boolean>('forked-pt-autonext', false)

  const [puzzle, setPuzzle] = useState<ThemePuzzle | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hintLevel, setHintLevel] = useState(0)
  const [revealKey, setRevealKey] = useState(0)
  const [phase, setPhase] = useState<BoardPhase>('intro')
  const [missed, setMissed] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [attemptRes, setAttemptRes] = useState<AttemptResponse | null>(null)
  const [explanation, setExplanation] = useState<Explanation | null>(null)
  const [session, setSession] = useState<SessionEntry[]>([])
  const [replay, setReplay] = useState(false)
  const reported = useRef(false)
  const sessionIds = useRef<string[]>([])

  const reset = (p: ThemePuzzle, isReplay: boolean) => {
    reported.current = isReplay
    setPuzzle(p); setReplay(isReplay)
    setHintLevel(0); setMissed(false); setOutcome(null); setAttemptRes(null); setExplanation(null)
  }

  const loadNext = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const p = await themesApi.next({
          username, angle, difficulty, color: color || undefined, exclude: sessionIds.current,
          themes: angle === 'custom' ? customThemes : undefined, match, elo: elo || undefined,
        })
      sessionIds.current = [...sessionIds.current, p.id]
      reset(p, false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [angle, username, difficulty, color, customThemes, match, elo])

  useEffect(() => { void loadNext() }, [loadNext])

  const report = useCallback((result: AttemptResult, timeMs: number) => {
    if (reported.current || !puzzle) return
    reported.current = true
    const entry: SessionEntry = { puzzle, result, delta: null }
    setSession(s => [...s, entry])
    themesApi.attempt(username, puzzle, angle, result, timeMs, 'practice', elo || undefined).then(res => {
      setAttemptRes(res)
      setSession(s => s.map(e => e.puzzle.id === puzzle.id && e.delta === null ? { ...e, delta: res.rated ? res.rating.delta : null } : e))
      void queryClient.invalidateQueries({ queryKey: ['themes-catalog'] })
      void queryClient.invalidateQueries({ queryKey: ['themes-stats'] })
    }).catch(() => undefined)
  }, [puzzle, username, angle, elo, queryClient])

  const onEvent = useCallback((e: BoardEvent) => {
    if (e.type === 'mistake') {
      setMissed(true)
      report('loss', e.timeMs)
    } else if (e.type === 'solved') {
      setOutcome({ kind: 'solved', alt: e.alt, hinted: hintLevel > 0 })
      report(hintLevel > 0 ? 'hint' : 'win', e.timeMs)
    } else {
      setOutcome({ kind: 'revealed' })
      report('loss', 0)
    }
  }, [hintLevel, report])

  // explanation + auto-next once the puzzle is over
  useEffect(() => {
    if (!outcome || !puzzle) return
    let alive = true
    themesApi.explain(puzzle.fen, puzzle.moves).then(x => { if (alive) setExplanation(x) }).catch(() => undefined)
    if (autoNext && outcome.kind === 'solved' && !missed && !replay) {
      const t = window.setTimeout(() => void loadNext(), 1100)
      return () => { alive = false; clearTimeout(t) }
    }
    return () => { alive = false }
  }, [outcome, puzzle, autoNext, missed, replay, loadNext])

  // keyboard: H = next hint step, N / Enter = next puzzle
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,textarea,select')) return
      if (e.key === 'h' && phase === 'play' && !outcome) setHintLevel(l => Math.min(3, l + 1))
      if ((e.key === 'n' || e.key === 'Enter') && outcome) { e.preventDefault(); void loadNext() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, outcome, loadNext])

  const done = !!outcome
  const solverSide = puzzle?.color === 'w' ? 'White' : 'Black'

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px] items-start">
      <div className="min-w-0">
        {error && !puzzle ? (
          <EmptyState message={error} angle={angle} />
        ) : puzzle ? (
          <ThemePuzzleBoard puzzle={puzzle} hintLevel={hintLevel} revealKey={revealKey} onEvent={onEvent} onPhase={setPhase} />
        ) : (
          <div className="aspect-square max-w-[620px] mx-auto rounded-xl bg-bg-1 border border-border animate-pulse" />
        )}
        {session.length > 0 && (
          <SessionStrip session={session} current={puzzle?.id} onPick={p => reset(p, true)} />
        )}
      </div>

      <aside className="space-y-3 lg:sticky lg:top-20">
        {puzzle && (
          <StatusCard>
            <AnimatePresence mode="wait">
              {!done ? (
                <motion.div key={missed ? 'missed' : 'play'} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                  <div className="flex items-center gap-3">
                    <span className={`w-9 h-9 rounded-full grid place-items-center border ${puzzle.color === 'w' ? 'bg-text-0 border-text-0' : 'bg-bg-0 border-border-hover'}`} />
                    <div>
                      <p className={`font-display text-lg font-semibold ${missed ? 'text-danger' : 'text-text-0'}`}>
                        {missed ? 'Not the move' : 'Your turn'}
                      </p>
                      <p className="text-xs text-text-2">
                        {missed ? 'Puzzle failed. Keep looking, or reveal the solution.' : `Find the best move for ${solverSide}.`}
                      </p>
                    </div>
                  </div>
                  {replay && <p className="mt-3 text-[11px] text-text-2">Replaying from your session, unrated.</p>}
                  {puzzle.focus && (
                    <p className="mt-3 text-[11px] text-accent/90 border-l-2 border-accent/50 pl-2">
                      Training <b>{puzzle.focus.name}</b>: {puzzle.focus.reason}
                    </p>
                  )}
                  {puzzle.source === 'game' && puzzle.game && <GameOrigin p={puzzle} />}
                </motion.div>
              ) : (
                <motion.div key="done" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
                  <OutcomeHeader outcome={outcome!} missed={missed} res={attemptRes} replay={replay} puzzle={puzzle} />
                </motion.div>
              )}
            </AnimatePresence>
          </StatusCard>
        )}

        {puzzle && !done && (
          <HintLadder puzzle={puzzle} level={hintLevel} disabled={phase !== 'play'}
            onStep={() => setHintLevel(l => Math.min(3, l + 1))}
            onReveal={() => setRevealKey(k => k + 1)} />
        )}

        {puzzle && done && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => void loadNext()} disabled={loading} className="btn-primary col-span-2 inline-flex items-center justify-center gap-2">
                Next puzzle <ArrowRight size={15} />
                <kbd className="ml-1 text-[10px] font-mono opacity-60">N</kbd>
              </button>
              <button onClick={() => reset(puzzle, true)} className="btn-ghost border border-border inline-flex items-center justify-center gap-1.5">
                <RotateCcw size={13} />Retry
              </button>
              <AnalyseButton puzzle={puzzle} title={puzzle.hint.name} />
              <AskCoachButton puzzle={puzzle} className="col-span-2" />
            </div>
            <WhyItWorks explanation={explanation} />
            <PuzzleMeta puzzle={puzzle} />
          </>
        )}

        <SettingsRow difficulty={difficulty} setDifficulty={setDifficulty} color={color} setColor={setColor}
          autoNext={autoNext} setAutoNext={setAutoNext} hideDifficulty={['game', 'game-blunders', 'game-missed', 'review'].includes(angle)} />

        <ThemeGuide meta={meta} angle={angle} />
      </aside>
    </div>
  )
}

function StatusCard({ children }: { children: ReactNode }) {
  return <div className="card p-4 min-h-[88px]">{children}</div>
}

function GameOrigin({ p }: { p: ThemePuzzle }) {
  const g = p.game!
  const when = g.played_at ? new Date(g.played_at * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : null
  return (
    <div className="mt-3 rounded-lg border border-danger/25 bg-danger/[0.06] px-3 py-2 text-[11px] text-text-1 leading-relaxed">
      From your game{when ? ` on ${when}` : ''}, move {g.move_number}.
      {g.played_san ? <> You played <b className="text-danger">{g.played_san}</b>.</> : ' You missed the win here.'}
      {g.judgement ? <span className="text-text-2"> ({g.judgement})</span> : null}
      {g.kind === 'blunder' && <span className="block text-text-2">Find the move you should have played.</span>}
    </div>
  )
}

function OutcomeHeader({ outcome, missed, res, replay, puzzle }: {
  outcome: Outcome; missed: boolean; res: AttemptResponse | null; replay: boolean; puzzle: ThemePuzzle
}) {
  const clean = outcome.kind === 'solved' && !missed
  const title = outcome.kind === 'revealed' ? 'Solution shown' : missed ? 'Solved, after a miss' : outcome.alt ? 'Also wins!' : 'Solved!'
  const sub = outcome.kind === 'solved' && outcome.alt
    ? (puzzle.source === 'game'
      ? (puzzle.game?.kind === 'blunder' ? 'Stockfish rates your move as good as the best one.' : 'Stockfish agrees your move wins too.')
      : 'A different checkmate. Every mate counts.')
    : outcome.kind === 'solved' && outcome.hinted && !missed ? 'Solved with a hint: half credit.' : null
  return (
    <div>
      <div className="flex items-center gap-3">
        <span className={`w-9 h-9 rounded-full grid place-items-center ${clean ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger'}`}>
          {clean ? <Check size={18} /> : <X size={18} />}
        </span>
        <div className="flex-1 min-w-0">
          <p className={`font-display text-lg font-semibold ${clean ? 'text-success' : 'text-text-0'}`}>{title}</p>
          {sub && <p className="text-xs text-text-2">{sub}</p>}
        </div>
        {res && res.rated && !replay && (
          <motion.span initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
            className={`font-mono text-sm font-semibold px-2 py-1 rounded-md ${res.rating.delta >= 0 ? 'text-accent bg-accent/10' : 'text-danger bg-danger/10'}`}>
            {res.rating.delta >= 0 ? '+' : ''}{res.rating.delta}
          </motion.span>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-2">
        <span>Puzzle <b className="text-text-1">{puzzle.rating}</b></span>
        {res?.rated && <span>Your rating <b className="text-text-1">{res.rating.after}</b></span>}
        {puzzle.plays > 0 && <span>{puzzle.plays.toLocaleString()} plays</span>}
        {res?.review?.queued && !clean && <span className="text-warn">Back for review in {res.review.due_in_hours! >= 24 ? `${Math.round(res.review.due_in_hours! / 24)}d` : `${res.review.due_in_hours}h`}</span>}
        {res?.review?.graduated && <span className="text-success">Mastered: out of review</span>}
        {!res?.rated && !replay && puzzle.source !== 'game' && puzzle.source !== 'review' && res && <span>Already seen: unrated</span>}
      </div>
      {res && res.themes.length > 0 && !replay && (
        <div className="mt-2 flex flex-wrap gap-1">
          {res.themes.filter(t => !['short', 'long', 'veryLong', 'oneMove', 'crushing', 'advantage', 'middlegame', 'endgame', 'opening'].includes(t.theme)).slice(0, 4).map(t => (
            <span key={t.theme} className="text-[10px] px-1.5 py-0.5 rounded bg-bg-2 text-text-1">
              {themeLabel(t.theme)} <span className={t.after >= t.before ? 'text-accent' : 'text-danger'}>{t.after - t.before >= 0 ? '+' : ''}{t.after - t.before}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function HintLadder({ puzzle, level, disabled, onStep, onReveal }: {
  puzzle: ThemePuzzle; level: number; disabled: boolean; onStep: () => void; onReveal: () => void
}) {
  const steps = [
    { label: 'Nudge', icon: Lightbulb, hint: 'A pattern clue' },
    { label: 'Piece', icon: MousePointerClick, hint: 'Which piece moves' },
    { label: 'Move', icon: ArrowRight, hint: 'Show the move' },
  ]
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between">
        <p className="text-[11px] uppercase tracking-[0.18em] text-text-2">Hints</p>
        <p className="text-[10px] text-text-2">a hinted solve = half credit · <kbd className="font-mono">H</kbd></p>
      </div>
      <div className="mt-2.5 grid grid-cols-3 gap-1.5">
        {steps.map((s, i) => {
          const active = level > i
          const next = level === i
          return (
            <button key={s.label} onClick={onStep} disabled={disabled || !next} title={s.hint}
              className={`inline-flex items-center justify-center gap-1.5 text-xs py-2 rounded-lg border transition-colors
                ${active ? 'border-accent/50 bg-accent/10 text-accent' : next ? 'border-border text-text-0 hover:border-accent/40' : 'border-border text-text-2 opacity-50'}`}>
              <s.icon size={13} />{s.label}
            </button>
          )
        })}
      </div>
      <AnimatePresence>
        {level >= 1 && (
          <motion.p initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
            className="mt-3 text-sm text-text-0 leading-relaxed border-l-2 border-accent pl-3">
            {puzzle.hint.text}
            <span className="block text-[11px] text-text-2 mt-1">Theme: {puzzle.hint.name}</span>
          </motion.p>
        )}
      </AnimatePresence>
      <button onClick={onReveal} disabled={disabled}
        className="mt-3 w-full inline-flex items-center justify-center gap-1.5 text-xs py-2 rounded-lg text-text-2 hover:text-danger hover:bg-danger/10 transition-colors disabled:opacity-40">
        <Eye size={13} />View the solution
      </button>
    </div>
  )
}

function WhyItWorks({ explanation }: { explanation: Explanation | null }) {
  if (!explanation) return <div className="card p-4 h-28 animate-pulse" />
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2">
        <Sparkles size={14} className="text-accent" />
        <p className="text-sm font-semibold text-text-0">Why it works</p>
      </div>
      <p className="mt-2 text-sm text-accent">{explanation.summary}</p>
      {explanation.trigger && (
        <p className="mt-2 text-[11px] text-text-2">{explanation.trigger.side} had just played <b className="text-text-1">{explanation.trigger.san}</b>.</p>
      )}
      <ol className="mt-2 space-y-1.5">
        {explanation.steps.map((s, i) => (
          <li key={i} className={`text-xs leading-relaxed ${s.mine ? 'text-text-0' : 'text-text-2'}`}>
            <span className="font-mono text-text-2 mr-1.5">{s.move_no}{s.white ? '.' : '…'}</span>
            <b className={s.mine ? 'text-text-0' : 'text-text-1'}>{s.san}</b>
            {s.notes.length > 0 && <span>: {s.notes.join(', ')}</span>}
          </li>
        ))}
      </ol>
      {explanation.verified.length > 0 && (
        <p className="mt-3 text-[11px] text-text-2">
          Proven on the board: {explanation.verified.map(themeLabel).join(', ')}
        </p>
      )}
    </div>
  )
}

function PuzzleMeta({ puzzle }: { puzzle: ThemePuzzle }) {
  return (
    <div className="card p-4">
      <p className="text-[11px] uppercase tracking-[0.18em] text-text-2">Themes in this puzzle</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {puzzle.themes.map(t => (
          <Link key={t} to={`/puzzles/${t}`} className="text-[11px] px-2 py-0.5 rounded-full border border-border text-text-1 hover:text-accent hover:border-accent/40">
            {themeLabel(t)}
          </Link>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-2">
        {puzzle.opening && <span>{tagName(puzzle.opening.split(' ').slice(-1)[0])}</span>}
        {puzzle.game_url && (
          <a href={puzzle.game_url.startsWith('http') ? puzzle.game_url : `https://lichess.org/training/${puzzle.id}`} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-accent hover:underline">
            {puzzle.game_url.includes('/training/') ? `Lichess puzzle #${puzzle.id}` : 'Source game on Lichess'}<ExternalLink size={11} />
          </a>
        )}
        {puzzle.source === 'lichess' && <span>live from the Lichess API</span>}
      </div>
    </div>
  )
}

function AnalyseButton({ puzzle, title, className = '' }: { puzzle: ThemePuzzle; title: string; className?: string }) {
  const navigate = useNavigate()
  const open = () => {
    const { sans, fens } = puzzleSans(puzzle)
    const positions = fens.slice(1).map((fen, i) => ({ fen, label: i === 0 ? `Puzzle (after ${sans[0]})` : sans[i] }))
    navigate('/analysis', { state: { positions, index: 0, title: `Puzzle · ${title}` } })
  }
  return (
    <button onClick={open} className={`btn-ghost border border-border inline-flex items-center justify-center gap-1.5 ${className}`}>
      <Microscope size={13} />Analyse
    </button>
  )
}

function AskCoachButton({ puzzle, className = '' }: { puzzle: ThemePuzzle; className?: string }) {
  const navigate = useNavigate()
  const open = () => {
    const { sans, fens } = puzzleSans(puzzle)
    navigate('/coach', {
      state: {
        position: {
          fen: fens[1], label: `Puzzle ${puzzle.id.startsWith('g:') ? 'from your game' : `#${puzzle.id}`}`,
          line: { san: sans.slice(1), fens: fens.slice(1) },
          question: `In this puzzle the solution is ${sans.slice(1).filter((_, i) => i % 2 === 0).join(', ')}. Why does it work, and how do I spot this pattern in my own games?`,
        },
      },
    })
  }
  return (
    <button onClick={open} className={`inline-flex items-center justify-center gap-1.5 text-sm py-2 rounded-lg border border-accent/30 text-accent hover:bg-accent/10 ${className}`}>
      <Sparkles size={13} />Ask the Coach about it
    </button>
  )
}

function SettingsRow({ difficulty, setDifficulty, color, setColor, autoNext, setAutoNext, hideDifficulty }: {
  difficulty: string; setDifficulty: (v: string) => void; color: string; setColor: (v: string) => void
  autoNext: boolean; setAutoNext: (v: boolean) => void; hideDifficulty: boolean
}) {
  return (
    <div className="card p-4 space-y-3">
      {!hideDifficulty && (
        <div>
          <p className="text-[11px] uppercase tracking-[0.18em] text-text-2 mb-1.5">Difficulty <span className="normal-case tracking-normal">(vs your rating in this theme)</span></p>
          <div className="grid grid-cols-5 gap-1">
            {DIFFICULTIES.map(d => (
              <button key={d} onClick={() => setDifficulty(d)}
                className={`text-[11px] py-1.5 rounded-md capitalize transition-colors ${difficulty === d ? 'bg-accent text-accent-ink font-semibold' : 'bg-bg-2 text-text-1 hover:text-text-0'}`}>
                {d}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <div className="inline-flex rounded-lg bg-bg-2 p-0.5 text-[11px]">
          {[['', 'Either side'], ['w', 'White'], ['b', 'Black']].map(([v, l]) => (
            <button key={v} onClick={() => setColor(v)}
              className={`px-2.5 py-1 rounded-md whitespace-nowrap ${color === v ? 'bg-bg-3 text-text-0' : 'text-text-2 hover:text-text-0'}`}>{l}</button>
          ))}
        </div>
        <label className="inline-flex items-center gap-2 text-[11px] text-text-1 cursor-pointer select-none">
          <input type="checkbox" checked={autoNext} onChange={e => setAutoNext(e.target.checked)} className="accent-[#C8FF2A]" />
          Jump to next on solve
        </label>
      </div>
    </div>
  )
}

function ThemeGuide({ meta, angle }: { meta: AngleMeta; angle: string }) {
  const [open, setOpen] = useState(true)
  const { data: catalog } = useThemesCatalog()
  const mine = catalog?.user.themes[angle]
  const name = (k: string) => catalog?.categories.flatMap(c => c.themes).find(t => t.key === k)?.name ?? tagName(k)
  if (!meta.spot.length && !meta.sub.length && !mine) return null
  return (
    <div className="card p-4">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between">
        <span className="flex items-center gap-2 text-sm font-semibold text-text-0">
          <ListChecks size={14} className="text-accent" />How to spot it
          {meta.forked && <ForkedBadge />}
        </span>
        <ChevronDown size={14} className={`text-text-2 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <>
          {meta.spot.length > 0 && (
            <ul className="mt-3 space-y-2">
              {meta.spot.map((s, i) => (
                <li key={i} className="flex gap-2 text-xs text-text-1 leading-relaxed">
                  <span className="mt-1.5 w-1 h-1 rounded-full bg-accent flex-shrink-0" />{s}
                </li>
              ))}
            </ul>
          )}
          {mine && mine.n > 0 && (
            <p className="mt-3 text-[11px] text-text-2">
              Your <b className="text-text-1">{meta.title}</b> rating: <b className="text-accent">{mine.rating}</b> · {mine.n} played · {Math.round((mine.acc ?? 0) * 100)}% clean solves
            </p>
          )}
          {meta.sub.length > 0 && (
            <div className="mt-3">
              <p className="text-[11px] text-text-2 mb-1.5">Drill a sub-type</p>
              <div className="flex flex-wrap gap-1.5">
                {meta.sub.map(s => (
                  <Link key={s} to={`/puzzles/${s}`} className="text-[11px] px-2 py-0.5 rounded-full border border-accent/30 text-accent hover:bg-accent/10">{name(s)}</Link>
                ))}
              </div>
            </div>
          )}
          {meta.parent && (
            <p className="mt-3 text-[11px] text-text-2">Part of <Link to={`/puzzles/${meta.parent}`} className="text-accent hover:underline">{name(meta.parent)}</Link></p>
          )}
        </>
      )}
    </div>
  )
}

function SessionStrip({ session, current, onPick }: { session: SessionEntry[]; current?: string; onPick: (p: ThemePuzzle) => void }) {
  const solved = session.filter(s => s.result === 'win').length
  const net = session.reduce((a, s) => a + (s.delta ?? 0), 0)
  return (
    <div className="mt-5 max-w-[620px] mx-auto">
      <div className="flex items-center justify-between text-[11px] text-text-2 mb-2">
        <span>This session · {solved}/{session.length} clean</span>
        <span className={net >= 0 ? 'text-accent' : 'text-danger'}>{net >= 0 ? '+' : ''}{net} rating</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {session.map((s, i) => (
          <button key={`${s.puzzle.id}-${i}`} onClick={() => onPick(s.puzzle)} title={`Puzzle ${s.puzzle.rating}. Click to replay`}
            className={`min-w-[38px] h-8 px-1.5 rounded-md text-[10px] font-mono font-semibold border transition-transform hover:-translate-y-0.5
              ${s.result === 'win' ? 'bg-success/15 border-success/30 text-success' : s.result === 'hint' ? 'bg-warn/10 border-warn/30 text-warn' : 'bg-danger/10 border-danger/30 text-danger'}
              ${current === s.puzzle.id ? 'ring-1 ring-accent' : ''}`}>
            {s.delta === null ? (s.result === 'win' ? '✓' : s.result === 'hint' ? '½' : '✗') : `${s.delta >= 0 ? '+' : ''}${s.delta}`}
          </button>
        ))}
      </div>
    </div>
  )
}

function EmptyState({ message, angle }: { message: string; angle: string }) {
  return (
    <div className="aspect-square max-w-[620px] mx-auto rounded-xl border border-border bg-bg-1 grid place-items-center p-8 text-center">
      <div>
        <Puzzle size={26} className="mx-auto text-accent" />
        <p className="mt-3 text-text-0 font-medium">{angle === 'review' ? 'All caught up' : 'No puzzle here yet'}</p>
        <p className="mt-1 text-sm text-text-2 max-w-sm">{message}</p>
        <Link to="/puzzles" className="mt-4 inline-flex btn-primary text-sm">Browse themes</Link>
      </div>
    </div>
  )
}

// ── Rush / Streak ───────────────────────────────────────────────────────────

const RUSH_MS = 3 * 60_000
const RUSH_LIVES = 3

interface RunEntry { puzzle: ThemePuzzle; ok: boolean }

function RunMode({ angle, meta, mode, customThemes, match }: {
  angle: string; meta: AngleMeta; mode: 'rush' | 'streak' | TrainMode; customThemes: string[]; match: 'any' | 'all'
}) {
  const { username, elo } = useUserStore()
  const queryClient = useQueryClient()
  const { data: catalog } = useThemesCatalog()
  const isRush = mode === 'rush'
  const best = catalog?.user.runs[isRush ? 'rush' : 'streak']?.[angle]?.best ?? 0

  const [state, setState] = useState<'intro' | 'loading' | 'running' | 'over'>('intro')
  const [queue, setQueue] = useState<ThemePuzzle[]>([])
  const [idx, setIdx] = useState(0)
  const [log, setLog] = useState<RunEntry[]>([])
  const [endAt, setEndAt] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [skipUsed, setSkipUsed] = useState(false)
  const [result, setResult] = useState<{ best: number; previous: number; record: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const startedAt = useRef(0)
  const lock = useRef(false)

  const score = log.filter(e => e.ok).length
  const strikes = log.filter(e => !e.ok).length
  const puzzle = queue[idx]

  async function start() {
    setState('loading'); setError(null)
    try {
      const r = await themesApi.run({ username, angle, mode: isRush ? 'rush' : 'streak', themes: angle === 'custom' ? customThemes : undefined, match, elo: elo || undefined })
      if (!r.puzzles.length) throw new Error('No puzzles for this theme yet.')
      setQueue(r.puzzles); setIdx(0); setLog([]); setSkipUsed(false); setResult(null)
      startedAt.current = Date.now()
      setEndAt(Date.now() + RUSH_MS); setNow(Date.now())
      lock.current = false
      setState('running')
    } catch (e) {
      setError((e as Error).message); setState('intro')
    }
  }

  const finish = useCallback((entries: RunEntry[]) => {
    setState('over')
    const s = entries.filter(e => e.ok).length
    themesApi.runResult(username, angle, isRush ? 'rush' : 'streak', s, entries.length - s, Date.now() - startedAt.current)
      .then(r => { setResult(r); void queryClient.invalidateQueries({ queryKey: ['themes-catalog'] }) })
      .catch(() => undefined)
  }, [username, angle, isRush, queryClient])

  // clock
  useEffect(() => {
    if (state !== 'running' || !isRush) return
    const t = window.setInterval(() => setNow(Date.now()), 200)
    return () => clearInterval(t)
  }, [state, isRush])
  useEffect(() => {
    if (state === 'running' && isRush && now >= endAt) finish(log)
  }, [now, endAt, state, isRush, log, finish])

  const advance = useCallback((entries: RunEntry[]) => {
    const fails = entries.filter(e => !e.ok).length
    if ((isRush && fails >= RUSH_LIVES) || (!isRush && fails >= 1) || idx + 1 >= queue.length) { finish(entries); return }
    setIdx(i => i + 1)
    lock.current = false
  }, [isRush, idx, queue.length, finish])

  const onEvent = useCallback((e: BoardEvent) => {
    if (!puzzle || lock.current || state !== 'running') return
    if (e.type === 'revealed') return
    lock.current = true
    const ok = e.type === 'solved'
    const entries = [...log, { puzzle, ok }]
    setLog(entries)
    void themesApi.attempt(username, puzzle, angle, ok ? 'win' : 'loss', e.timeMs, isRush ? 'rush' : 'streak', elo || undefined).catch(() => undefined)
    window.setTimeout(() => advance(entries), ok ? 160 : 650)
  }, [puzzle, log, state, username, angle, isRush, elo, advance])

  const skip = () => {
    if (skipUsed || isRush || lock.current) return
    setSkipUsed(true)
    setIdx(i => Math.min(i + 1, queue.length - 1))
  }

  if (state === 'intro' || state === 'loading') {
    return (
      <div className="max-w-2xl mx-auto mt-6">
        <div className="card p-8 text-center relative overflow-hidden">
          <div aria-hidden className="absolute -top-24 left-1/2 -translate-x-1/2 w-[420px] h-[220px] rounded-full bg-accent/10 blur-3xl" />
          {isRush ? <Timer size={30} className="mx-auto text-accent relative" /> : <Flame size={30} className="mx-auto text-accent relative" />}
          <h2 className="font-display text-3xl font-semibold mt-4 relative">{meta.title} {isRush ? 'Rush' : 'Streak'}</h2>
          <p className="text-text-1 mt-3 relative max-w-md mx-auto">
            {isRush
              ? `Solve as many ${meta.title.toLowerCase()} puzzles as you can in 3 minutes. They start easy and get harder. Three mistakes and you're out.`
              : `How many ${meta.title.toLowerCase()} puzzles can you solve in a row? They get harder every time. One mistake ends it, and you get one skip.`}
          </p>
          <p className="text-xs text-text-2 mt-2 relative">Lichess Storm and Streak only use random puzzles. Here you pick the theme.</p>
          <div className="mt-6 flex items-center justify-center gap-6 relative">
            <div><p className="text-[11px] uppercase tracking-wider text-text-2">Your best</p><p className="font-display text-3xl neon-text">{best}</p></div>
          </div>
          <button onClick={start} disabled={state === 'loading'} className="btn-primary mt-6 px-8 py-3 text-base relative inline-flex items-center gap-2">
            {state === 'loading' ? 'Loading…' : <>Start <Zap size={16} /></>}
          </button>
          {error && <p className="mt-3 text-sm text-danger relative">{error}</p>}
        </div>
      </div>
    )
  }

  if (state === 'over') {
    const missed = log.filter(e => !e.ok)
    return (
      <div className="max-w-3xl mx-auto mt-6">
        <div className="card p-8 text-center relative overflow-hidden">
          <Trophy size={30} className={`mx-auto ${result?.record ? 'text-accent' : 'text-text-2'}`} />
          <p className="text-[11px] uppercase tracking-[0.2em] text-text-2 mt-3">{isRush ? 'Rush over' : 'Streak over'}</p>
          <p className="font-display text-6xl font-semibold neon-text mt-2 tabular-nums">{score}</p>
          {result?.record
            ? <p className="mt-2 text-accent font-medium">New personal best!{result.previous ? ` (was ${result.previous})` : ''}</p>
            : <p className="mt-2 text-text-2 text-sm">Best: {result?.best ?? best}</p>}
          {score > 0 && <p className="mt-1 text-xs text-text-2">Hardest solved: {Math.max(...log.filter(e => e.ok).map(e => e.puzzle.rating))}</p>}
          <button onClick={start} className="btn-primary mt-6 inline-flex items-center gap-2"><RotateCcw size={15} />Play again</button>
        </div>
        {missed.length > 0 && (
          <div className="mt-4 card p-5">
            <p className="text-sm font-semibold text-text-0">Your misses</p>
            <p className="text-xs text-text-2 mt-0.5">They're queued in <Link to="/puzzles/review" className="text-accent hover:underline">Missed puzzles</Link> for spaced review. Open one to see the line.</p>
            <div className="mt-3 flex flex-wrap gap-3">
              {missed.map(e => (
                <MissedThumb key={e.puzzle.id} puzzle={e.puzzle} />
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  const left = Math.max(0, endAt - now)
  const mm = Math.floor(left / 60000), ss = Math.floor((left % 60000) / 1000)
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px] items-start">
      <div className="min-w-0">
        {puzzle && <ThemePuzzleBoard puzzle={puzzle} hintLevel={0} revealKey={0} onEvent={onEvent} fast />}
      </div>
      <aside className="space-y-3 lg:sticky lg:top-20">
        <div className="card p-5 text-center">
          {isRush ? (
            <>
              <p className="text-[11px] uppercase tracking-[0.2em] text-text-2">Time</p>
              <p className={`font-display text-5xl font-semibold tabular-nums mt-1 ${left < 20_000 ? 'text-danger' : 'text-text-0'}`}>{mm}:{String(ss).padStart(2, '0')}</p>
              <div className="mt-3 h-1 rounded-full bg-bg-3 overflow-hidden">
                <div className={`h-full ${left < 20_000 ? 'bg-danger' : 'bg-accent'}`} style={{ width: `${(left / RUSH_MS) * 100}%` }} />
              </div>
            </>
          ) : (
            <p className="text-[11px] uppercase tracking-[0.2em] text-text-2">Streak</p>
          )}
          <p className="font-display text-6xl font-semibold neon-text tabular-nums mt-3">{score}</p>
          <p className="text-xs text-text-2">solved · best {best}</p>
          {isRush && (
            <div className="mt-4 flex justify-center gap-2" aria-label={`${RUSH_LIVES - strikes} lives left`}>
              {Array.from({ length: RUSH_LIVES }).map((_, i) => (
                <span key={i} className={`w-3 h-3 rounded-full ${i < strikes ? 'bg-danger' : 'bg-bg-3 border border-border-hover'}`} />
              ))}
            </div>
          )}
        </div>
        {puzzle && (
          <div className="card p-4 flex items-center justify-between text-xs">
            <span className="text-text-2">Puzzle {idx + 1}</span>
            <span className="text-text-1">{puzzle.color === 'w' ? 'White' : 'Black'} to play · <b className="text-text-0">{puzzle.rating}</b></span>
          </div>
        )}
        {!isRush && (
          <button onClick={skip} disabled={skipUsed} className="w-full btn-ghost border border-border disabled:opacity-40">
            {skipUsed ? 'Skip used' : 'Skip this puzzle (once)'}
          </button>
        )}
        <div className="flex flex-wrap gap-1">
          {log.map((e, i) => (
            <span key={i} className={`w-6 h-6 rounded text-[10px] font-mono grid place-items-center ${e.ok ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger'}`}>
              {e.ok ? '✓' : '✗'}
            </span>
          ))}
        </div>
        <button onClick={() => finish(log)} className="w-full text-xs text-text-2 hover:text-danger py-2">End run</button>
      </aside>
    </div>
  )
}

function MissedThumb({ puzzle }: { puzzle: ThemePuzzle }) {
  const navigate = useNavigate()
  const { sans, fens } = puzzleSans(puzzle)
  const open = () => navigate('/analysis', {
    state: { positions: fens.slice(1).map((fen, i) => ({ fen, label: i === 0 ? 'Puzzle' : sans[i] })), index: 0, title: `Missed puzzle · ${puzzle.rating}` },
  })
  return (
    <button onClick={open} className="group text-left">
      <div className="rounded-md overflow-hidden ring-1 ring-border group-hover:ring-accent/50">
        <MiniBoardThumbnail solid fen={fens[1] ?? puzzle.fen} size={96} orientation={puzzle.color === 'w' ? 'white' : 'black'} />
      </div>
      <p className="text-[10px] text-text-2 mt-1">{puzzle.rating} · {sans[1] ?? ''}</p>
    </button>
  )
}
