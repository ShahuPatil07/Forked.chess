import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Chessboard } from 'react-chessboard'
import { Chess } from 'chess.js'
import type { Square } from 'chess.js'
import {
  ArrowRight, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Clock, Download, Eye, FileUp, FlipVertical2,
  History, Loader2, Microscope, Plus, RotateCcw, ScanSearch, Sparkles, Trash2,
} from 'lucide-react'
import {
  checkMove, type CheckMoveResult, type MoveClass, type OfficialAccuracy, type ReviewMove, type ReviewSummary,
} from '../api/gameReview'
import { followReview, libraryApi, type LibraryGame, type KeyMoment } from '../api/library'
import { ReviewGraph } from '../components/review/ReviewGraph'
import { RecentGames } from '../components/review/RecentGames'
import { KeyMomentDropdowns } from '../components/review/KeyMoments'
import { SectionHeader } from '../components/layout/SectionHeader'
import { useUserStore } from '../store/userStore'
import { coachApi, type AgentLine, type CoachChatMessage, type CoachProfile } from '../api/coach'
import { AnswerText } from '../components/coach/AnswerText'
import { useElementWidth } from '../hooks/useElementWidth'
import { evalText, relativeTime, whiteShare } from '../lib/format'
import { useOpenReview } from '../lib/review'
import { BOARD_DARK, BOARD_LIGHT } from '../theme'

export const CLASSIFICATION: Record<MoveClass, { label: string; symbol: string; color: string }> = {
  brilliant: { label: 'Brilliant', symbol: '!!', color: '#37c4bd' }, great: { label: 'Great', symbol: '!', color: '#82aafa' },
  best: { label: 'Best', symbol: '★', color: '#9ecb76' }, excellent: { label: 'Excellent', symbol: '✓', color: '#93b788' },
  good: { label: 'Good', symbol: '✓', color: '#94a38e' }, book: { label: 'Book', symbol: '▤', color: '#c4a67c' },
  inaccuracy: { label: 'Inaccuracy', symbol: '?!', color: '#e8c157' }, mistake: { label: 'Mistake', symbol: '?', color: '#f29a52' },
  miss: { label: 'Miss', symbol: '×', color: '#e58a6c' }, blunder: { label: 'Blunder', symbol: '??', color: '#f06470' },
}
const SAMPLE = `[Event "Opera game"]
[White "Paul Morphy"]
[Black "Duke Karl / Count Isouard"]
[Result "1-0"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6
7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7
12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7
16. Qb8+ Nxb8 17. Rd8# 1-0`
const BAD: string[] = ['blunder', 'mistake', 'inaccuracy', 'miss']

function Badge({ kind }: { kind: MoveClass }) {
  const spec = CLASSIFICATION[kind]
  return <span className="inline-flex items-center gap-2 text-xs font-semibold" style={{ color: spec.color }}><span className="w-6 h-6 rounded-full flex items-center justify-center font-bold" style={{ background: spec.color + '20' }}>{spec.symbol}</span>{spec.label}</span>
}

function SquareIcon({ kind, square, size, flipped }: { kind: MoveClass; square: string; size: number; flipped: boolean }) {
  const spec = CLASSIFICATION[kind]
  const sq = size / 8
  const file = square.charCodeAt(0) - 97, rank = Number(square[1]) - 1
  const col = flipped ? 7 - file : file, row = flipped ? rank : 7 - rank
  const d = Math.max(18, sq * 0.42)
  return <span aria-hidden="true" data-testid="square-icon" className="absolute z-10 rounded-full flex items-center justify-center font-bold shadow-md pointer-events-none"
    style={{ left: Math.min(size - d, (col + 1) * sq - d * 0.7), top: Math.max(0, row * sq - d * 0.3), width: d, height: d, background: spec.color, color: '#050505', fontSize: d * 0.5 }}>{spec.symbol}</span>
}

const PHASE_LABEL = { opening: 'Opening', middlegame: 'Middlegame', endgame: 'Endgame' } as const
function PhaseAccuracy({ summary }: { summary: ReviewSummary }) {
  const phases = (['opening', 'middlegame', 'endgame'] as const).filter(p => summary.white.phases?.[p] || summary.black.phases?.[p])
  if (!phases.length) return null
  const cell = (acc: number | null | undefined) => acc == null ? <span className="text-text-2">—</span>
    : <span className={acc >= 85 ? 'text-emerald-300' : acc >= 65 ? 'text-text-0' : 'text-amber-200'}>{acc}</span>
  return <div className="card p-4" data-testid="phase-accuracy"><div className="grid grid-cols-[1fr_56px_56px] text-xs text-text-2 mb-2"><span>Accuracy by phase</span><span>White</span><span>Black</span></div>
    {phases.map(p => <div key={p} className="grid grid-cols-[1fr_56px_56px] text-sm py-0.5"><span>{PHASE_LABEL[p]}</span>{cell(summary.white.phases?.[p]?.accuracy)}{cell(summary.black.phases?.[p]?.accuracy)}</div>)}</div>
}

function article(word: string) { return /^[aeiou]/i.test(word) ? 'an' : 'a' }

function RetryPanel({ retry, color, onAgain, onSolution }: {
  retry: { checking: boolean; result?: CheckMoveResult }; color: 'white' | 'black'; onAgain: () => void; onSolution: () => void
}) {
  const r = retry.result
  return <div className="mt-3 rounded-lg border border-border bg-bg-2 p-3 text-sm" data-testid="retry-panel">
    {retry.checking ? <span className="inline-flex items-center gap-2 text-text-2"><Loader2 size={13} className="animate-spin" />Checking your move…</span>
      : r ? (r.correct
        ? <p className="text-emerald-300">Correct. {r.san} is {CLASSIFICATION[r.classification].label.toLowerCase()}.</p>
        : <div className="space-y-2"><p><span style={{ color: CLASSIFICATION[r.classification].color }}>{r.san} is {article(r.classification)} {CLASSIFICATION[r.classification].label.toLowerCase()}.</span> Try again.</p>
          <div className="flex gap-2"><button className="btn-ghost border border-border text-xs" onClick={onAgain}>Try again</button><button className="btn-ghost border border-border text-xs" onClick={onSolution}>Show solution</button></div></div>)
        : <p className="text-text-1">Find a better move for {color === 'white' ? 'White' : 'Black'}: drag a piece on the board.</p>}
  </div>
}

interface ReviewChatMsg { role: 'user' | 'assistant'; content: string; lines: AgentLine[]; notes?: string; fen?: string; status?: string }

function resultFor(g: LibraryGame): { text: string; cls: string } {
  const r = g.result
  if (r === '1/2-1/2') return { text: 'Draw', cls: 'text-text-1' }
  if (r !== '1-0' && r !== '0-1') return { text: '—', cls: 'text-text-2' }
  if (!g.user_color) return { text: r, cls: 'text-text-1' }
  const won = (r === '1-0') === (g.user_color === 'white')
  return won ? { text: 'Won', cls: 'text-success' } : { text: 'Lost', cls: 'text-danger' }
}

// ── stored reviews list ──────────────────────────────────────────────────────

function ReviewHistory({ activeId }: { activeId?: string }) {
  const { username } = useUserStore()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['library-reviews', username],
    queryFn: () => libraryApi.games(username, { limit: 200 }),
    enabled: !!username,
    refetchInterval: q => (q.state.data?.games.some(g => g.review.status === 'queued' || g.review.status === 'running') ? 3000 : false),
    staleTime: 10_000,
  })
  const games = (data?.games ?? []).filter(g => g.review.status !== 'none')
  const [q, setQ] = useState('')
  const shown = q ? games.filter(g => `${g.title} ${g.opening?.name ?? ''}`.toLowerCase().includes(q.toLowerCase())) : games
  async function remove(id: string) {
    if (!confirm('Remove this review from your history?')) return
    await libraryApi.deleteGame(username, id).catch(() => undefined)
    void qc.invalidateQueries({ queryKey: ['library-reviews', username] })
    if (id === activeId) navigate('/game-review')
  }
  return (
    <section className="card p-4 sm:p-5" data-testid="review-history">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <h2 className="font-medium flex items-center gap-2"><History size={16} className="text-accent" />Your reviewed games</h2>
        <input className="input !w-56 text-xs py-1.5" placeholder="Search players or openings…" value={q} onChange={e => setQ(e.target.value)} />
      </div>
      {isLoading ? <p className="text-xs text-text-2 py-4">Loading…</p> : !shown.length ? (
        <p className="text-xs text-text-2 py-4">{games.length ? 'Nothing matches that search.' : 'Reviews you run are saved here — reopen any of them instantly, move by move, without recomputing.'}</p>
      ) : (
        <div className="divide-y divide-border">
          {shown.map(g => {
            const res = resultFor(g)
            const acc = g.review.accuracy
            const mine = g.user_color ? acc?.[g.user_color] : null
            const running = g.review.status === 'queued' || g.review.status === 'running'
            return (
              <div key={g.id} role="button" tabIndex={0} onClick={() => navigate(`/game-review/${g.id}`)}
                onKeyDown={e => { if (e.key === 'Enter') navigate(`/game-review/${g.id}`) }}
                className={`py-3 px-2 -mx-2 rounded-lg flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 cursor-pointer hover:bg-bg-2/60 ${g.id === activeId ? 'bg-accent/[0.06]' : ''}`}>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-text-0 truncate">{g.title}</p>
                  <p className="text-[11px] text-text-2 truncate">
                    {g.source_label} · {relativeTime(g.review.completed_at ?? g.played_at)}{g.opening?.name ? ` · ${g.opening.name}` : ''}{g.time_class && g.time_class !== 'untimed' ? ` · ${g.time_class}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-3 sm:gap-4 flex-shrink-0 flex-wrap">
                  <span className={`text-xs font-semibold w-10 ${res.cls}`}>{res.text}</span>
                  {running ? (
                    <span className="text-xs text-accent inline-flex items-center gap-1.5 w-28"><Loader2 size={12} className="animate-spin" />
                      {g.review.progress ? `${g.review.progress[0]}/${g.review.progress[1]}` : 'queued'}</span>
                  ) : (
                    <span className="text-xs text-text-1 w-28 tabular-nums" title="Accuracy (white / black)">
                      {mine != null ? <><span className="text-text-0 font-semibold">{mine}%</span> you</> : acc ? `${acc.white ?? '—'}% / ${acc.black ?? '—'}%` : '—'}
                    </span>
                  )}
                  <KeyMomentDropdowns compact moments={g.review.status === 'done' ? (g.key_moments ?? { mistakes: [], blunders: [] }) : null}
                    onOpen={(m: KeyMoment) => navigate(`/game-review/${g.id}?ply=${m.ply}`)} />
                  <button onClick={e => { e.stopPropagation(); void remove(g.id) }} className="p-1.5 rounded text-text-2 hover:text-danger" aria-label="Remove review"><Trash2 size={13} /></button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

// ── import ───────────────────────────────────────────────────────────────────

function ImportPanel({ busy, onStart, defaultOpen }: { busy: boolean; onStart: (pgn: string, quality: string, source?: 'platform' | 'review') => void; defaultOpen: boolean }) {
  const { username, platform } = useUserStore()
  const [open, setOpen] = useState(defaultOpen)
  const [pgn, setPgn] = useState(''), [quality, setQuality] = useState('standard'), [error, setError] = useState('')
  useEffect(() => setOpen(defaultOpen), [defaultOpen])
  async function upload(file?: File) {
    if (!file) return
    if (file.size > 150000) { setError('Choose a single PGN file under 150 KB.'); return }
    setPgn(await file.text()); setError('')
  }
  return (
    <section className="card p-4 sm:p-5">
      <button className="w-full flex flex-wrap justify-between items-center gap-3" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <h2 className="font-medium flex items-center gap-2"><Plus size={16} className="text-accent" />Bring a game to the board</h2>
        <span className="text-xs text-text-2">{open ? 'Hide' : 'Recent games, paste or upload a PGN'}</span>
      </button>
      {open && (
        <div className="mt-4">
          <div className="flex flex-wrap justify-end gap-3 text-xs mb-3">
            <button className="text-accent" disabled={busy} onClick={() => setPgn(SAMPLE)}>Try the Opera game</button>
            <label className="text-text-1 cursor-pointer flex items-center gap-2"><FileUp size={14} />Upload .pgn<input type="file" accept=".pgn,.txt" className="sr-only" aria-label="Upload PGN" disabled={busy} onChange={e => { void upload(e.target.files?.[0]); e.target.value = '' }} /></label>
          </div>
          <div className="mb-4"><RecentGames defaultUser={username} defaultPlatform={platform} disabled={busy} onPick={text => onStart(text, quality, 'platform')} /></div>
          <p className="text-xs text-text-2 mb-2">Or paste a PGN</p>
          <textarea aria-label="PGN" className="input font-mono text-xs resize-y min-h-[120px]" placeholder={'[White "You"]\n[Black "Opponent"]\n\n1. e4 e5 2. Nf3 Nc6 ...'} value={pgn} disabled={busy} onChange={e => setPgn(e.target.value)} />
          {error && <p role="alert" className="text-xs text-amber-200 mt-2">{error}</p>}
          <div className="flex flex-wrap items-center justify-between gap-3 mt-3">
            <p className="text-xs text-text-2">Local Stockfish · reviews run in the background and are saved to your history.</p>
            <div className="flex gap-3">
              <select aria-label="Review quality" className="input !w-auto" value={quality} disabled={busy} onChange={e => setQuality(e.target.value)}>
                <option value="quick">Quick</option><option value="standard">Standard</option><option value="deep">Deep</option>
              </select>
              <button onClick={() => onStart(pgn, quality)} disabled={busy || !pgn.trim()} className="btn-primary flex gap-2 items-center"><ScanSearch size={16} />Review</button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

// ── page ─────────────────────────────────────────────────────────────────────

type HandOff = { pgn?: string; source?: string; meta?: Record<string, unknown>; user_color?: 'white' | 'black'; title?: string; quality?: 'quick' | 'standard' | 'deep' }

export default function GameReview() {
  const { reviewId } = useParams<{ reviewId?: string }>()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const location = useLocation()
  const qc = useQueryClient()
  const openReview = useOpenReview()
  const { username } = useUserStore()

  const [moves, setMoves] = useState<ReviewMove[]>([]), [summary, setSummary] = useState<ReviewSummary | null>(null)
  const [headers, setHeaders] = useState<Record<string, string>>({}), [initialFen, setInitialFen] = useState(new Chess().fen())
  const [total, setTotal] = useState(0), [status, setStatus] = useState<'idle' | 'queued' | 'running' | 'done' | 'error'>('idle')
  const [error, setError] = useState(''), [starting, setStarting] = useState(false)
  const [selected, setSelected] = useState(0), [flipped, setFlipped] = useState(false)
  const [userColor, setUserColor] = useState<'white' | 'black' | null>(null)
  const [beforeView, setBeforeView] = useState(false)
  const [branch, setBranch] = useState<'played' | 'best' | 'custom' | null>(null), [branchPly, setBranchPly] = useState(0)
  const [customLine, setCustomLine] = useState<{ san: string[]; fens: string[]; label: string } | null>(null)
  const [chat, setChat] = useState<ReviewChatMsg[]>([]), [explaining, setExplaining] = useState(false)
  const [followUp, setFollowUp] = useState('')
  const [engine, setEngine] = useState('Stockfish')
  const [official, setOfficial] = useState<OfficialAccuracy | null>(null)
  const [retry, setRetry] = useState<{ checking: boolean; result?: CheckMoveResult; fen?: string } | null>(null)
  const explainAbort = useRef<AbortController | null>(null)
  const selectedButton = useRef<HTMLButtonElement>(null)
  const moveListRef = useRef<HTMLDivElement>(null)
  const [boardRef, measured] = useElementWidth<HTMLDivElement>(520)
  const width = Math.max(240, Math.min(720, measured - 24))
  const focusPly = Number(params.get('ply') || 0)

  const busy = status === 'queued' || status === 'running'
  const row = moves[selected - 1]
  const line = branch === 'best' ? row?.best_line : branch === 'played' ? row?.line : branch === 'custom' ? customLine ?? undefined : undefined
  const showBefore = beforeView && !!row && !branch && !retry
  const fen = retry ? (retry.fen ?? row?.before_fen ?? initialFen) : showBefore ? row!.before_fen : line?.fens[branchPly] ?? row?.fen ?? initialFen
  const score = showBefore ? row?.best_score : row?.played_score ?? moves[0]?.best_score
  const evalLabel = score ? evalText(score.white_cp, score.white_mate, 2) : '—'
  const whitePct = score ? whiteShare(score.white_cp, score.white_mate) : 50

  // ── hand-off from another page: start the job, then land on its URL ──────────
  useEffect(() => {
    const handed = location.state as HandOff | null
    if (!handed?.pgn) return
    setStarting(true)
    openReview({ pgn: handed.pgn, quality: handed.quality ?? 'standard', source: (handed.source as never) ?? 'review',
                 meta: handed.meta, user_color: handed.user_color, title: handed.title }, { replace: true })
      .catch(e => { setError(e instanceof Error ? e.message : 'Could not start the review.'); navigate(location.pathname, { replace: true, state: null }) })
      .finally(() => setStarting(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key])

  // ── load a stored review, or follow the running job (replayable stream) ──────
  useEffect(() => {
    if (!reviewId || !username) { setStatus('idle'); setMoves([]); setSummary(null); setHeaders({}); return }
    const ctrl = new AbortController()
    let cancelled = false
    setError(''); setMoves([]); setSummary(null); setSelected(0); setBranch(null); setRetry(null); setOfficial(null); setChat([])
    const applyStored = (doc: { headers: Record<string, string>; initial_fen: string; moves: ReviewMove[]; summary: ReviewSummary; engine: string; official_accuracy: OfficialAccuracy | null; user_color: 'white' | 'black' | null }) => {
      setHeaders(doc.headers); setInitialFen(doc.initial_fen); setMoves(doc.moves); setTotal(doc.moves.length)
      setSummary(doc.summary); setEngine(doc.engine); setOfficial(doc.official_accuracy ?? null); setStatus('done')
      setUserColor(doc.user_color); setFlipped(doc.user_color === 'black')
    }
    ;(async () => {
      try {
        const res = await libraryApi.review(username, reviewId)
        if (cancelled) return
        if (res.status === 'done') { applyStored({ ...res.review, user_color: res.review.user_color ?? res.game?.user_color ?? null }); return }
        setStatus(res.status)
        const outcome = await followReview(username, reviewId, e => {
          if (cancelled) return
          if (e.type === 'queued') setStatus('queued')
          if (e.type === 'start') { setStatus('running'); setTotal(e.total); setHeaders(e.headers); setInitialFen(e.initial_fen); setMoves([]) }
          if (e.type === 'move') setMoves(old => [...old, e.move])
        }, ctrl.signal)
        if (cancelled) return
        if (outcome === 'done' || outcome === 'stored') {
          const fin = await libraryApi.review(username, reviewId)
          if (!cancelled && fin.status === 'done') applyStored({ ...fin.review, user_color: fin.review.user_color ?? fin.game?.user_color ?? null })
          void qc.invalidateQueries({ queryKey: ['library-reviews', username] })
        }
      } catch (err) {
        if (cancelled || ctrl.signal.aborted) return
        setStatus('error'); setError(err instanceof Error ? err.message : 'Could not load this review.')
      }
    })()
    return () => { cancelled = true; ctrl.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewId, username])

  // focus a ply from a link (?ply=N): show the position before that move, with both arrows
  useEffect(() => {
    if (!focusPly || moves.length < focusPly) return
    setSelected(focusPly); setBeforeView(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPly, moves.length >= focusPly])

  // keep the selected move visible inside the move list only (never scroll the page)
  useEffect(() => {
    const btn = selectedButton.current, box = moveListRef.current
    if (!btn || !box) return
    const top = btn.offsetTop, bottom = top + btn.offsetHeight   // box is position:relative → offsetParent
    if (top < box.scrollTop) box.scrollTop = top - 8
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight + 8
  }, [selected])
  useEffect(() => {
    setBranch(null); setBranchPly(0); setChat([]); setFollowUp(''); explainAbort.current?.abort(); setExplaining(false); setRetry(null)
  }, [selected])
  useEffect(() => () => { explainAbort.current?.abort() }, [])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement).tagName)) return
      if (event.key === 'ArrowLeft') { event.preventDefault(); setBeforeView(false); setSelected(n => Math.max(0, n - 1)) }
      if (event.key === 'ArrowRight') { event.preventDefault(); setBeforeView(false); setSelected(n => Math.min(moves.length, n + 1)) }
      if (event.key === 'Home') { event.preventDefault(); setSelected(0) }
      if (event.key === 'End') { event.preventDefault(); setSelected(moves.length) }
    }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key)
  }, [moves.length])

  async function start(text: string, quality: string, source: 'platform' | 'review' = 'review') {
    if (!text.trim()) return
    setStarting(true); setError('')
    try { await openReview({ pgn: text, quality: quality as 'quick' | 'standard' | 'deep', source }) }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not start the review.') }
    finally { setStarting(false) }
  }

  /** The Coach agent in Game Review mode: explains or critiques THIS move, then takes follow-ups. */
  async function explain(question?: string) {
    if (!row || explaining) return
    const message = (question ?? '').trim() || (BAD.includes(row.classification)
      ? `Why is ${row.san} a ${row.classification}, and what should I have played instead?`
      : `Why is ${row.san} ${row.classification === 'book' ? 'a good opening move' : 'a strong move'}? What is the idea?`)
    const history: CoachChatMessage[] = chat.filter(m => m.content).map(m => ({ role: m.role, content: m.content, notes: m.notes, fen: m.fen }))
    let level: Partial<CoachProfile> = {}
    try { level = JSON.parse(localStorage.getItem('forked-coach-level') || '{}') } catch { /* none */ }
    const ctrl = new AbortController(); explainAbort.current = ctrl; setExplaining(true); setFollowUp('')
    setChat(old => [...old, { role: 'user', content: message, lines: [] }, { role: 'assistant', content: '', lines: [] }])
    const patch = (fn: (m: ReviewChatMsg) => ReviewChatMsg) => setChat(old => old.map((m, i) => i === old.length - 1 ? fn(m) : m))
    try {
      await coachApi.chatStream({ username: 'review', mode: 'agent', message, conversation_history: history,
        position_fen: row.before_fen, level: level.rating_bucket, style: level.explanation_style,
        profile: level.rating_bucket ? level as CoachProfile : null,
        review: { move: row.san, classification: row.classification, best: row.best_san, move_number: row.move_number, color: row.color } }, event => {
        if (event.type === 'token') patch(m => ({ ...m, content: m.content + event.text }))
        if (event.type === 'tool') patch(m => ({ ...m, status: event.label ?? 'Analysing…' }))
        if (event.type === 'lines') patch(m => ({ ...m, lines: event.lines }))
        if (event.type === 'board' && !event.game) { setCustomLine({ san: event.line.san, fens: event.line.fens, label: event.label }); setBranch('custom'); setBranchPly(event.line.san.length) }
        if (event.type === 'done') patch(m => ({ ...m, notes: event.notes, fen: event.fen, status: undefined }))
        if (event.type === 'error') throw new Error(event.message)
      }, ctrl.signal)
    } catch { if (!ctrl.signal.aborted) patch(m => ({ ...m, content: m.content || 'Coach unavailable. The local review explanation is still shown above.' })) }
    finally { if (!ctrl.signal.aborted) { setExplaining(false); patch(m => ({ ...m, status: undefined })) } }
  }

  function onRetryDrop(from: string, to: string, piece: string): boolean {
    if (!row || !retry || retry.checking) return false
    const game = new Chess(row.before_fen)
    const promo = piece[1]?.toLowerCase() === 'p' && (to[1] === '8' || to[1] === '1') ? 'q' : undefined
    let mv
    try { mv = game.move({ from, to, promotion: promo }) } catch { return false }
    if (!mv) return false
    const uci = from + to + (promo ?? '')
    const known = row.candidates?.find(c => c.uci === uci)
    const bestExp = row.best_score.expected
    if (known && bestExp - known.expected < .02) {
      setRetry({ checking: false, fen: game.fen(), result: { san: mv.san, expected: known.expected, loss: bestExp - known.expected, classification: known.uci === row.best_uci ? 'best' : 'excellent', correct: true } })
      return true
    }
    setRetry({ checking: true, fen: game.fen() })
    checkMove(row.before_fen, uci, bestExp)
      .then(result => setRetry({ checking: false, fen: game.fen(), result }))
      .catch(() => setRetry({ checking: false, fen: row.before_fen }))
    return true
  }
  function showAgentLine(l: AgentLine, ply: number) { setCustomLine({ san: l.san, fens: l.fens, label: l.label }); setBranch('custom'); setBranchPly(ply) }
  function download() {
    const blob = new Blob([JSON.stringify({ headers, initial_fen: initialFen, moves, summary, engine, complete: !!summary }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = 'forked-game-review.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const nextMoment = () => {
    const next = moves.find(m => m.ply > selected && ['mistake', 'blunder', 'miss', 'great', 'brilliant'].includes(m.classification))
    setBeforeView(false); setSelected(next?.ply ?? moves.length)
  }
  const go = (n: number) => { setBeforeView(false); setSelected(Math.max(0, Math.min(moves.length, n))) }

  const pgnForAnalysis = useMemo(() => {
    if (!moves.length) return ''
    try {
      const c = new Chess(initialFen)
      for (const m of moves) c.move(m.san)
      for (const [k, v] of Object.entries(headers)) c.setHeader(k, v)
      return c.pgn()
    } catch { return '' }
  }, [moves, initialFen, headers])

  const arrows: [Square, Square, string][] = showBefore && row
    ? [[row.uci.slice(0, 2) as Square, row.uci.slice(2, 4) as Square, row.uci === row.best_uci ? '#9ecb76' : 'rgba(240,100,112,0.9)'],
       ...(row.uci !== row.best_uci ? [[row.best_uci.slice(0, 2) as Square, row.best_uci.slice(2, 4) as Square, '#9ecb76'] as [Square, Square, string]] : [])]
    : branch === 'best' && branchPly === 0 && row ? [[row.best_uci.slice(0, 2) as Square, row.best_uci.slice(2, 4) as Square, '#9ecb76']] : []
  const topName = headers[flipped ? 'White' : 'Black'] || (flipped ? 'White' : 'Black')
  const bottomName = headers[flipped ? 'Black' : 'White'] || (flipped ? 'Black' : 'White')
  const hasGame = !!reviewId

  return (
    <div className="px-3 sm:px-4 lg:px-6 py-4 sm:py-6 max-w-[1500px] mx-auto" data-testid="game-review">
      <SectionHeader icon={ScanSearch} title="Game Review" description="Find the turning points. Every review is saved — reopen it any time without recomputing."
        right={<div className="flex gap-2">
          {!!moves.length && <button className="btn-ghost hidden sm:flex items-center gap-2" onClick={download}><Download size={15} />Export</button>}
          {hasGame && <button className="btn-ghost border border-border flex items-center gap-2" onClick={() => navigate('/game-review')}><Plus size={14} />New</button>}
        </div>} />

      {error && <p role="alert" className="text-sm text-amber-200 mb-4">{error}</p>}
      {(starting || busy) && (
        <div className="card p-4 mb-4">
          <div className="flex justify-between items-center text-sm mb-3">
            <span className="flex gap-2 items-center"><Loader2 size={14} className="animate-spin text-accent" />
              {starting ? 'Starting the review…' : status === 'queued' ? 'Waiting for the engine (another review is running)…' : `Reviewing move ${moves.length} of ${total || '…'}`}</span>
            <span className="text-xs text-text-2">You can leave this page — it keeps running and is saved to your history.</span>
          </div>
          <div className="h-1 bg-bg-3 rounded"><div className="h-1 bg-accent rounded transition-all" style={{ width: `${total ? moves.length / total * 100 : 3}%` }} /></div>
        </div>
      )}

      {/* board first, big and central */}
      <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(340px,440px)] gap-5 lg:gap-6">
        <section className="min-w-0">
          <div ref={boardRef} className="mx-auto w-full" style={{ maxWidth: 760 }}>
            <div className="flex justify-between text-sm mb-2 px-1" style={{ maxWidth: width + 24 }}><span className="truncate">{topName}</span><span className="text-text-2">{headers.Result || ''}</span></div>
            <div className="flex gap-2 items-stretch">
              <div className={`w-4 bg-bg-3 rounded overflow-hidden flex flex-shrink-0 ${flipped ? 'flex-col' : 'flex-col-reverse'}`} style={{ height: width }}>
                <div className="bg-[#F0F0F0] transition-all" style={{ height: `${whitePct}%` }} />
              </div>
              <div className="relative" style={{ width, height: width }}>
                <Chessboard id="review-board" boardWidth={width} position={fen} boardOrientation={flipped ? 'black' : 'white'} arePiecesDraggable={!!retry && !retry.checking && !retry.result?.correct}
                  onPieceDrop={(from, to, piece) => onRetryDrop(from, to, piece)}
                  customDarkSquareStyle={{ backgroundColor: BOARD_DARK }} customLightSquareStyle={{ backgroundColor: BOARD_LIGHT }}
                  customBoardStyle={{ borderRadius: 8, boxShadow: '0 0 0 1px rgba(200,255,42,0.15)' }}
                  customSquareStyles={row && !branch && !showBefore ? { [row.uci.slice(0, 2)]: { backgroundColor: '#b9a96188' }, [row.uci.slice(2, 4)]: { backgroundColor: '#b9a961bb' } } : {}}
                  customArrows={arrows} />
                {row && !branch && !retry && !showBefore && <SquareIcon kind={row.classification} square={row.uci.slice(2, 4)} size={width} flipped={flipped} />}
              </div>
            </div>
            <div className="flex justify-between text-sm mt-2 px-1" style={{ maxWidth: width + 24 }}><span className="truncate">{bottomName}</span><span className="font-mono text-text-2">{evalLabel}{showBefore ? ' · before the move' : branch ? ' · line' : ''}</span></div>
            {showBefore && row && (
              <div className="mt-2 rounded-lg border border-border bg-bg-1 px-3 py-2 text-xs flex flex-wrap items-center gap-x-4 gap-y-1" style={{ maxWidth: width + 24 }}>
                <span><span className="inline-block w-3 h-0.5 bg-[#f06470] align-middle mr-1.5" />Played <span className="font-mono text-text-0">{row.san}</span></span>
                {row.uci !== row.best_uci && <span><span className="inline-block w-3 h-0.5 bg-[#9ecb76] align-middle mr-1.5" />Best <span className="font-mono text-text-0">{row.best_san}</span></span>}
                <button className="ml-auto text-accent" onClick={() => setBeforeView(false)}>Show after the move →</button>
              </div>
            )}
            <div className="flex justify-center gap-1 sm:gap-2 mt-3 items-center">
              <button aria-label="First position" className="btn-ghost" onClick={() => go(0)} disabled={!selected}><ChevronsLeft size={20} /></button>
              <button aria-label="Previous move" className="btn-ghost" onClick={() => go(selected - 1)} disabled={!selected}><ChevronLeft size={20} /></button>
              <span className="text-xs text-text-2 w-16 text-center tabular-nums">{selected} / {moves.length}</span>
              <button aria-label="Next move" className="btn-ghost" onClick={() => go(selected + 1)} disabled={selected === moves.length}><ChevronRight size={20} /></button>
              <button aria-label="Last position" className="btn-ghost" onClick={() => go(moves.length)} disabled={selected === moves.length}><ChevronsRight size={20} /></button>
              <button aria-label="Flip board" className="btn-ghost" onClick={() => setFlipped(v => !v)}><FlipVertical2 size={16} /></button>
            </div>
            {!!moves.length && <div className="card mt-3 p-3"><ReviewGraph moves={moves} selected={selected} onSelect={n => go(n)} /></div>}
            {!!moves.length && (
              <div className="flex flex-wrap gap-2 mt-3">
                <button className="btn-ghost border border-border text-xs inline-flex items-center gap-1.5" onClick={() => navigate('/analysis', { state: { pgn: pgnForAnalysis, ply: selected, title: `${headers.White ?? 'White'} – ${headers.Black ?? 'Black'}`, reviewId } })}>
                  <Microscope size={13} />Open in Analysis Board <ArrowRight size={12} />
                </button>
              </div>
            )}
          </div>
        </section>

        <section className="min-w-0 space-y-4">
          <div className="grid grid-cols-2 gap-3">{(['white', 'black'] as const).map(side => {
            const sum = summary?.[side], rating = sum?.rating
            return <div key={side} className={`card p-4 ${userColor === side ? 'border-accent/30' : ''}`} data-testid={`summary-${side}`}>
              <p className="text-xs text-text-2 uppercase tracking-wider truncate">{headers[side === 'white' ? 'White' : 'Black'] || side}{userColor === side ? ' · you' : ''}</p>
              <p className="text-3xl font-semibold mt-2">{sum?.accuracy ?? '—'}<span className="text-sm text-text-2">{sum?.accuracy != null ? '%' : ''}</span></p>
              <p className="text-[11px] text-text-2">Accuracy{official?.[side] != null ? <> · Chess.com <span className="text-text-1 font-medium">{official[side]}</span></> : null}</p>
              <p className="text-xs text-text-2 mt-3">Game rating</p>
              {rating ? <><p className="text-lg font-semibold">{rating.estimate}</p><p className="text-[11px] text-text-2">likely {rating.low}–{rating.high}</p></>
                : <p className="text-xs text-text-2 mt-1">{summary ? 'Too few non-book decisions' : 'Available after review'}</p>}
            </div>
          })}</div>
          {summary && <PhaseAccuracy summary={summary} />}
          {row ? <div className="card p-4 border-accent/20"><div className="flex justify-between items-center gap-2"><span className="text-lg font-semibold">{row.move_number}{row.color === 'white' ? '.' : '…'} {row.san}</span><Badge kind={row.classification} /></div>
            <p className="text-sm leading-relaxed text-text-1 mt-3">{row.explanation}</p>{row.opening && <p className="text-xs text-text-2 mt-2">{row.opening.eco} · {row.opening.name}</p>}
            <div className="flex flex-wrap gap-2 mt-4">
              <button className={`btn-ghost border text-xs inline-flex items-center gap-1.5 ${showBefore ? 'border-accent/40 text-accent' : 'border-border'}`} onClick={() => { setBranch(null); setRetry(null); setBeforeView(v => !v) }}><Eye size={12} />{showBefore ? 'After the move' : 'Played vs best'}</button>
              <button className="btn-ghost border border-border text-xs" onClick={() => { setBeforeView(false); setBranch('best'); setBranchPly(0) }}>Best line</button>
              <button className="btn-ghost border border-border text-xs" onClick={() => { setBeforeView(false); setBranch('played'); setBranchPly(0) }}>Played line</button>
              {BAD.includes(row.classification) && !busy && <button className="btn-ghost border border-border text-xs flex gap-1 items-center" onClick={() => { setBeforeView(false); setBranch(null); setRetry(r => r ? null : { checking: false }) }}><RotateCcw size={12} />{retry ? 'Stop retry' : 'Retry'}</button>}
              <button className="btn-ghost text-accent text-xs flex gap-1 items-center" disabled={explaining || busy} onClick={() => void explain()}>{explaining ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}{BAD.includes(row.classification) ? 'Why was this wrong?' : 'Explain the idea'}</button>
            </div>
            {retry && <RetryPanel retry={retry} color={row.color} onAgain={() => setRetry({ checking: false })} onSolution={() => { setRetry(null); setBranch('best'); setBranchPly(0) }} />}
            {line && <div className="flex flex-wrap gap-1 mt-3"><button className="btn-ghost text-xs" onClick={() => setBranchPly(0)}>Start</button>{line.san.map((san, i) => <button key={i} className={`px-2 py-1 rounded text-xs ${branchPly === i + 1 ? 'bg-accent/25 text-accent' : 'bg-bg-2'}`} onClick={() => setBranchPly(i + 1)}>{san}</button>)}<button className="btn-ghost text-xs" onClick={() => setBranch(null)}>Return to game</button></div>}
            {chat.length > 0 && <div className="mt-4 pt-3 border-t border-border space-y-3 text-sm" data-testid="review-coach">
              {chat.map((m, i) => m.role === 'user'
                ? (i > 0 ? <p key={i} className="text-xs text-text-2 text-right"><span className="inline-block px-2.5 py-1 rounded-xl bg-accent/15 text-text-0">{m.content}</span></p> : null)
                : <div key={i}>{m.content ? <AnswerText text={m.content} lines={m.lines} onMove={showAgentLine} /> : <span className="text-xs text-text-2 inline-flex items-center gap-1.5"><Loader2 size={12} className="animate-spin text-accent" />{m.status ?? 'Thinking…'}</span>}</div>)}
              {!explaining && <>
                <div className="flex flex-wrap gap-1.5">{(BAD.includes(row.classification)
                  ? ['What did it allow?', `Why is ${row.best_san} better?`, 'Explain it simpler']
                  : ['What if I had played something natural instead?', 'What was the opponent threatening?', 'Explain it simpler']).map(q =>
                  <button key={q} className="text-[11px] px-2.5 py-1 rounded-full border border-border text-text-1 hover:text-accent hover:border-accent/40" onClick={() => void explain(q)}>{q}</button>)}</div>
                <form className="flex gap-2" onSubmit={e => { e.preventDefault(); if (followUp.trim()) void explain(followUp) }}>
                  <input className="input text-xs flex-1" value={followUp} onChange={e => setFollowUp(e.target.value)} placeholder="Ask a follow-up about this move…" aria-label="Follow-up question" />
                  <button className="btn-ghost border border-border text-xs" disabled={!followUp.trim()}>Ask</button>
                </form>
              </>}
            </div>}
            <p className="text-[10px] text-text-2 mt-3">Depth {row.depth} · best line depth {row.best_depth}{row.search_limited ? ' · bounded search' : ''}{row.forced ? ' · only legal move' : ''}</p></div>
            : <div className="card p-5 text-sm text-text-2">{moves.length ? 'Use the arrows or pick a move to start your review.' : hasGame ? 'The review will appear here move by move.' : 'Bring a game below, or reopen one from your history.'}</div>}
          <div className="card overflow-hidden"><div className="flex justify-between items-center px-4 py-3 border-b border-border"><h2 className="text-sm font-medium">Moves</h2><button className="text-xs text-accent" onClick={nextMoment} disabled={!moves.length}>Next key moment →</button></div>
            <div ref={moveListRef} className="max-h-[320px] overflow-y-auto grid grid-cols-2 gap-px bg-border relative">{moves.map(m => <button ref={selected === m.ply ? selectedButton : undefined} key={m.ply} style={m.ply === 1 && m.color === 'black' ? { gridColumnStart: 2 } : {}} onClick={() => go(m.ply)} className={`flex justify-between items-center px-3 py-2.5 text-sm ${selected === m.ply ? 'bg-accent/20' : 'bg-bg-1 hover:bg-bg-2'}`} aria-label={`Move ${m.ply}: ${m.san}, ${CLASSIFICATION[m.classification].label}`}><span><span className="text-text-2 text-xs mr-2">{m.move_number}{m.color === 'white' ? '.' : '…'}</span>{m.san}</span><span className="font-bold text-xs" style={{ color: CLASSIFICATION[m.classification].color }}>{CLASSIFICATION[m.classification].symbol}</span></button>)}</div></div>
          {summary && <div className="card p-4 space-y-2"><div className="grid grid-cols-[1fr_40px_40px] text-xs text-text-2"><span>Move breakdown</span><span>White</span><span>Black</span></div>{(Object.keys(CLASSIFICATION) as MoveClass[]).map(kind => <div key={kind} className="grid grid-cols-[1fr_40px_40px] items-center text-sm"><Badge kind={kind} /><span>{summary.white.counts[kind] ?? 0}</span><span>{summary.black.counts[kind] ?? 0}</span></div>)}</div>}
        </section>
      </div>

      <div className="mt-6 space-y-5">
        <ImportPanel busy={starting} defaultOpen={!hasGame} onStart={(text, q, source) => void start(text, q, source)} />
        <ReviewHistory activeId={reviewId} />
      </div>

      <details className="mt-6 card p-4 text-xs text-text-2 leading-relaxed"><summary className="cursor-pointer text-text-1 inline-flex items-center gap-1.5"><Clock size={12} />How this review is calculated</summary>
        <p className="mt-3">{engine} analyses the game locally. Move labels use Chess.com's published expected-points bands (0.02 / 0.05 / 0.10 / 0.20), on a human expected-points curve fitted to real game results. A Blunder needs a concrete punishment (material or mate); a large loss without one is a Mistake, and letting a winning chance slip after the opponent's error is a Miss. Book moves form the opening prefix of the game: once a move isn't a book move, no later move can be.</p>
        <p className="mt-2">Accuracy uses win-percentage loss per move with constants fitted to Chess.com's stored accuracies; for Chess.com games their official figure is shown alongside. Evaluations are in points (1 point = one pawn).</p></details>
    </div>
  )
}
