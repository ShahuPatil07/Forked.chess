import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Chessboard } from 'react-chessboard'
import { Chess } from 'chess.js'
import type { Square } from 'chess.js'
import { ArrowRight, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Download, FileUp, FlipVertical2, Loader2, RotateCcw, ScanSearch, Sparkles, X } from 'lucide-react'
import { checkMove, reviewGame, type CheckMoveResult, type MoveClass, type OfficialAccuracy, type ReviewMove, type ReviewSummary } from '../api/gameReview'
import { ReviewGraph } from '../components/review/ReviewGraph'
import { RecentGames } from '../components/review/RecentGames'
import { useUserStore } from '../store/userStore'
import { coachApi, type AgentLine, type CoachChatMessage } from '../api/coach'
import { AnswerText } from '../components/coach/AnswerText'

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
const BAD: string[] = ['blunder', 'mistake', 'inaccuracy', 'miss']

export default function GameReview() {
  const navigate = useNavigate()
  const [pgn, setPgn] = useState(''), [quality, setQuality] = useState('standard')
  const [moves, setMoves] = useState<ReviewMove[]>([]), [summary, setSummary] = useState<ReviewSummary | null>(null)
  const [headers, setHeaders] = useState<Record<string, string>>({}), [initialFen, setInitialFen] = useState(new Chess().fen())
  const [total, setTotal] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [selected, setSelected] = useState(0), [flipped, setFlipped] = useState(false), [showImport, setShowImport] = useState(true)
  const [branch, setBranch] = useState<'played' | 'best' | 'custom' | null>(null), [branchPly, setBranchPly] = useState(0)
  const [customLine, setCustomLine] = useState<{ san: string[]; fens: string[]; label: string } | null>(null)
  const [chat, setChat] = useState<ReviewChatMsg[]>([]), [explaining, setExplaining] = useState(false)
  const [followUp, setFollowUp] = useState('')
  const [engine, setEngine] = useState('Stockfish')
  const [official, setOfficial] = useState<OfficialAccuracy | null>(null)
  const [retry, setRetry] = useState<{ checking: boolean; result?: CheckMoveResult; fen?: string } | null>(null)
  const { username, platform } = useUserStore()
  const abort = useRef<AbortController | null>(null), explainAbort = useRef<AbortController | null>(null)
  const boardWrap = useRef<HTMLDivElement>(null), [width, setWidth] = useState(480)
  const selectedButton = useRef<HTMLButtonElement>(null)
  const row = moves[selected - 1]
  const line = branch === 'best' ? row?.best_line : branch === 'played' ? row?.line : branch === 'custom' ? customLine ?? undefined : undefined
  const fen = retry ? (retry.fen ?? row?.before_fen ?? initialFen) : line?.fens[branchPly] ?? row?.fen ?? initialFen
  const score = row?.played_score ?? moves[0]?.best_score
  const evalLabel = score ? score.white_mate !== null ? `${score.white_mate < 0 ? '-' : '+'}M${Math.abs(score.white_mate)}` : `${(score.white_cp! / 100).toFixed(2)}` : '—'
  const whiteShare = score ? score.white_mate !== null ? score.white_mate > 0 ? 100 : 0 : 100 / (1 + Math.exp(-.00368208 * (score.white_cp ?? 0))) : 50

  useEffect(() => {
    const el = boardWrap.current; if (!el) return
    const observer = new ResizeObserver(() => setWidth(Math.max(180, Math.min(560, el.clientWidth - 24))))
    observer.observe(el); return () => observer.disconnect()
  }, [])
  useEffect(() => { selectedButton.current?.scrollIntoView({ block: 'nearest' }) }, [selected])
  useEffect(() => {
    setBranch(null); setBranchPly(0); setChat([]); setFollowUp(''); explainAbort.current?.abort(); setExplaining(false); setRetry(null)
  }, [selected])
  useEffect(() => () => { abort.current?.abort(); explainAbort.current?.abort() }, [])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement).tagName)) return
      if (event.key === 'ArrowLeft') { event.preventDefault(); setSelected(n => Math.max(0, n - 1)) }
      if (event.key === 'ArrowRight') { event.preventDefault(); setSelected(n => Math.min(moves.length, n + 1)) }
      if (event.key === 'Home') { event.preventDefault(); setSelected(0) }
      if (event.key === 'End') { event.preventDefault(); setSelected(moves.length) }
    }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key)
  }, [moves.length])

  async function start(text: string = pgn) {
    if (busy || !text.trim()) return
    const ctrl = new AbortController(); abort.current = ctrl
    explainAbort.current?.abort(); setChat([]); setExplaining(false)
    setBusy(true); setError(''); setHeaders({}); setInitialFen(new Chess().fen()); setMoves([]); setSummary(null); setSelected(0); setTotal(0); setBranch(null); setOfficial(null); setRetry(null)
    try {
      await reviewGame(text, quality, event => {
        if (event.type === 'start') {
          setTotal(event.total); setHeaders(event.headers); setInitialFen(event.initial_fen); setShowImport(false)
          // Face the board from the signed-in player's side, as Chess.com does.
          if (username) setFlipped((event.headers.Black ?? '').toLowerCase() === username.toLowerCase())
        }
        if (event.type === 'move') setMoves(old => [...old, event.move])
        if (event.type === 'done') { setSummary(event.summary); setEngine(event.engine); setOfficial(event.official_accuracy ?? null) }
      }, ctrl.signal)
    } catch (err) { setError(ctrl.signal.aborted ? 'Review cancelled. Partial moves remain available.' : err instanceof Error ? err.message : 'Review failed.') }
    finally { setBusy(false); abort.current = null }
  }
  async function upload(file?: File) {
    if (!file) return
    if (file.size > 150000) { setError('Choose a single PGN file under 150 KB.'); return }
    setPgn(await file.text()); setError('')
  }
  /** The Coach agent in Game Review mode: always explains or critiques THIS move, then takes follow-ups. */
  async function explain(question?: string) {
    if (!row || explaining) return
    const message = (question ?? '').trim() || (BAD.includes(row.classification)
      ? `Why is ${row.san} a ${row.classification}, and what should I have played instead?`
      : `Why is ${row.san} ${row.classification === 'book' ? 'a good opening move' : 'a strong move'}? What is the idea?`)
    const history: CoachChatMessage[] = chat.filter(m => m.content).map(m => ({ role: m.role, content: m.content, notes: m.notes, fen: m.fen }))
    let level: { rating_bucket?: string; explanation_style?: string } = {}
    try { level = JSON.parse(localStorage.getItem('forked-coach-level') || '{}') } catch { /* none */ }
    const ctrl = new AbortController(); explainAbort.current = ctrl; setExplaining(true); setFollowUp('')
    setChat(old => [...old, { role: 'user', content: message, lines: [] }, { role: 'assistant', content: '', lines: [] }])
    const patch = (fn: (m: ReviewChatMsg) => ReviewChatMsg) => setChat(old => old.map((m, i) => i === old.length - 1 ? fn(m) : m))
    try {
      await coachApi.chatStream({ username: 'review', mode: 'agent', message, conversation_history: history,
        position_fen: row.before_fen, level: level.rating_bucket, style: level.explanation_style,
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
  /** Retry: replay the mistake on the board; candidates from the review answer
   *  instantly, anything else is checked by the engine on the same scale. */
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
    const blob = new Blob([JSON.stringify({ headers, initial_fen: initialFen, moves, summary, engine, algorithm: 'forked-review-v1', complete: !!summary }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = 'forked-game-review.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const nextMoment = () => {
    const next = moves.find(m => m.ply > selected && ['mistake', 'blunder', 'miss', 'great', 'brilliant'].includes(m.classification))
    setSelected(next?.ply ?? moves.length)
  }
  return <div className="p-4 lg:p-6 max-w-[1500px] mx-auto" data-testid="game-review">
    <div className="flex flex-wrap items-center justify-between gap-3 mb-6"><div><h1 className="text-2xl font-semibold flex items-center gap-3"><ScanSearch className="text-accent" />Game Review</h1><p className="text-sm text-text-2 mt-1">Find the turning points. Understand your decisions.</p></div>
      <div className="flex gap-2">{!!moves.length && <button className="btn-ghost flex items-center gap-2" onClick={download}><Download size={15} />Export review</button>}<button className="btn-ghost border border-border" disabled={busy} onClick={() => setShowImport(v => !v)}>Import PGN</button></div></div>
    {showImport && <section className="card p-5 mb-5">
      <div className="flex flex-wrap justify-between gap-3 mb-3"><h2 className="font-medium">Bring a game to the board</h2><div className="flex gap-3 text-xs"><button className="text-accent" disabled={busy} onClick={() => setPgn(SAMPLE)}>Try the Opera game</button><label className="text-text-1 cursor-pointer flex items-center gap-2"><FileUp size={14} />Upload .pgn<input type="file" accept=".pgn,.txt" className="sr-only" aria-label="Upload PGN" disabled={busy} onChange={e => { void upload(e.target.files?.[0]); e.target.value = '' }} /></label></div></div>
      <div className="mb-4"><RecentGames defaultUser={username} defaultPlatform={platform} disabled={busy} onPick={text => { setPgn(text); void start(text) }} /></div>
      <p className="text-xs text-text-2 mb-2">Or paste a PGN</p>
      <textarea aria-label="PGN" className="input font-mono text-xs resize-y min-h-[130px]" placeholder={'[White "You"]\n[Black "Opponent"]\n\n1. e4 e5 2. Nf3 Nc6 ...'} value={pgn} disabled={busy} onChange={e => setPgn(e.target.value)} />
      <div className="flex flex-wrap items-center justify-between gap-3 mt-3"><p className="text-xs text-text-2">Local Stockfish. No account import. No daily review limit.</p><div className="flex gap-3"><select aria-label="Review quality" className="input !w-auto" value={quality} disabled={busy} onChange={e => setQuality(e.target.value)}><option value="quick">Quick</option><option value="standard">Standard</option><option value="deep">Deep</option></select><button onClick={() => void start()} disabled={busy || !pgn.trim()} className="btn-primary flex gap-2 items-center"><ScanSearch size={16} />Game review</button></div></div>
    </section>}
    {error && <p role="alert" className="text-sm text-amber-200 mb-4">{error}</p>}
    {busy && <div className="card p-4 mb-5"><div className="flex justify-between items-center text-sm mb-3"><span className="flex gap-2 items-center"><Loader2 size={14} className="animate-spin" />Reviewing move {moves.length} of {total || '…'}</span><button className="btn-ghost" onClick={() => abort.current?.abort()}><X size={14} />Cancel</button></div><div className="h-1 bg-bg-3 rounded"><div className="h-1 bg-accent rounded transition-all" style={{ width: `${total ? moves.length / total * 100 : 0}%` }} /></div></div>}
    <div className="grid xl:grid-cols-[minmax(0,1fr)_minmax(360px,470px)] gap-6">
      <section className="min-w-0">
        <div className="flex justify-between text-sm mb-3"><span>{headers[flipped ? 'White' : 'Black'] || (flipped ? 'White' : 'Black')}</span><span className="text-text-2">{headers.Result || 'Study'}</span></div>
        <div ref={boardWrap} className="flex gap-2 items-stretch min-w-0 overflow-x-clip">
          <div className={`w-4 bg-bg-3 rounded overflow-hidden flex flex-shrink-0 ${flipped ? 'flex-col' : 'flex-col-reverse'}`}><div className="bg-[#F0F0F0] transition-all" style={{ height: `${whiteShare}%` }} /></div>
          <div className="relative max-w-full flex-shrink" style={{ width, height: width }}>
          <Chessboard id="review-board" boardWidth={width} position={fen} boardOrientation={flipped ? 'black' : 'white'} arePiecesDraggable={!!retry && !retry.checking && !retry.result?.correct}
            onPieceDrop={(from, to, piece) => onRetryDrop(from, to, piece)}
            customDarkSquareStyle={{ backgroundColor: '#5C5C5C' }} customLightSquareStyle={{ backgroundColor: '#A9A9A9' }}
            customSquareStyles={row && !branch ? { [row.uci.slice(0, 2)]: { backgroundColor: '#b9a96188' }, [row.uci.slice(2, 4)]: { backgroundColor: '#b9a961bb' } } : {}}
            customArrows={branch === 'best' && branchPly === 0 && row ? [[row.best_uci.slice(0, 2) as Square, row.best_uci.slice(2, 4) as Square, '#9ecb76']] : []} />
          {row && !branch && !retry && <SquareIcon kind={row.classification} square={row.uci.slice(2, 4)} size={width} flipped={flipped} />}
          </div>
        </div>
        <div className="flex justify-between text-sm mt-3"><span>{headers[flipped ? 'Black' : 'White'] || (flipped ? 'Black' : 'White')}</span><span className="font-mono text-text-2">{evalLabel} · White perspective{branch ? ' (game position)' : ''}</span></div>
        <div className="flex justify-center gap-2 mt-4 items-center"><button aria-label="First position" className="btn-ghost" onClick={() => setSelected(0)} disabled={!selected}><ChevronsLeft size={20} /></button><button aria-label="Previous move" className="btn-ghost" onClick={() => setSelected(n => Math.max(0, n - 1))} disabled={!selected}><ChevronLeft size={20} /></button><span className="text-xs text-text-2 w-20 text-center">{selected} / {moves.length}</span><button aria-label="Next move" className="btn-ghost" onClick={() => setSelected(n => Math.min(moves.length, n + 1))} disabled={selected === moves.length}><ChevronRight size={20} /></button><button aria-label="Last position" className="btn-ghost" onClick={() => setSelected(moves.length)} disabled={selected === moves.length}><ChevronsRight size={20} /></button><button aria-label="Flip board" className="btn-ghost" onClick={() => setFlipped(v => !v)}><FlipVertical2 size={16} /></button></div>
        {!!moves.length && <div className="card mt-4 p-3"><ReviewGraph moves={moves} selected={selected} onSelect={setSelected} /><input aria-label="Navigate game" type="range" min={0} max={moves.length} value={selected} onChange={e => setSelected(Number(e.target.value))} className="w-full accent-lime-300 mt-2" /></div>}
        <button className="btn-ghost mt-3 text-xs" onClick={() => navigate(`/analysis?fen=${encodeURIComponent(fen)}`)}>Explore this position <ArrowRight size={12} className="inline ml-1" /></button>
      </section>
      <section className="min-w-0 space-y-4">
        <div className="grid grid-cols-2 gap-3">{(['white', 'black'] as const).map(side => {
          const sum = summary?.[side], rating = sum?.rating
          return <div key={side} className="card p-4" data-testid={`summary-${side}`}>
            <p className="text-xs text-text-2 uppercase tracking-wider truncate">{headers[side === 'white' ? 'White' : 'Black'] || side}</p>
            <p className="text-3xl font-semibold mt-2">{sum?.accuracy ?? '—'}<span className="text-sm text-text-2">{sum?.accuracy != null ? '%' : ''}</span></p>
            <p className="text-[11px] text-text-2">Accuracy{official?.[side] != null ? <> · Chess.com <span className="text-text-1 font-medium">{official[side]}</span></> : null}</p>
            <p className="text-xs text-text-2 mt-3">Game rating</p>
            {rating ? <><p className="text-lg font-semibold">{rating.estimate}</p><p className="text-[11px] text-text-2">likely {rating.low}–{rating.high}</p>
              {!rating.calibrated && <p className="text-[10px] text-amber-200 mt-1">Experimental estimate</p>}</>
              : <p className="text-xs text-text-2 mt-1">{summary ? 'Too few non-book decisions' : 'Available after review'}</p>}
          </div>
        })}</div>
        {summary && <PhaseAccuracy summary={summary} />}
        {row ? <div className="card p-4 border-accent/20"><div className="flex justify-between items-center"><span className="text-lg font-semibold">{row.move_number}{row.color === 'white' ? '.' : '…'} {row.san}</span><Badge kind={row.classification} /></div><p className="text-sm leading-relaxed text-text-1 mt-3">{row.explanation}</p>{row.opening && <p className="text-xs text-text-2 mt-2">{row.opening.eco} · {row.opening.name}</p>}<div className="flex flex-wrap gap-2 mt-4"><button className="btn-ghost border border-border text-xs" onClick={() => { setBranch('best'); setBranchPly(0) }}>Show best line</button><button className="btn-ghost border border-border text-xs" onClick={() => { setBranch('played'); setBranchPly(0) }}>Show played line</button>{BAD.includes(row.classification) && !busy && <button className="btn-ghost border border-border text-xs flex gap-1 items-center" onClick={() => { setBranch(null); setRetry(r => r ? null : { checking: false }) }}><RotateCcw size={12} />{retry ? 'Stop retry' : 'Retry'}</button>}<button className="btn-ghost text-accent text-xs flex gap-1 items-center" disabled={explaining || busy} onClick={() => void explain()}>{explaining ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}{BAD.includes(row.classification) ? 'Why was this wrong?' : 'Explain the idea'}</button></div>
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
          <p className="text-[10px] text-text-2 mt-3">Depth {row.depth} · best line depth {row.best_depth}{row.search_limited ? ' · bounded search' : ''}{row.forced ? ' · only legal move' : ''}</p></div> : <div className="card p-5 text-sm text-text-2">{moves.length ? 'Use the arrows or select a move to begin your review.' : 'Upload a PGN to discover where the game changed.'}</div>}
        <div className="card overflow-hidden"><div className="flex justify-between items-center px-4 py-3 border-b border-border"><h2 className="text-sm font-medium">Moves</h2><button className="text-xs text-accent" onClick={nextMoment} disabled={!moves.length}>Next key moment →</button></div><div className="max-h-[320px] overflow-y-auto grid grid-cols-2 gap-px bg-border">{moves.map(m => <button ref={selected === m.ply ? selectedButton : undefined} key={m.ply} style={m.ply === 1 && m.color === 'black' ? { gridColumnStart: 2 } : {}} onClick={() => setSelected(m.ply)} className={`flex justify-between items-center px-3 py-2.5 text-sm ${selected === m.ply ? 'bg-accent/20' : 'bg-bg-1 hover:bg-bg-2'}`} aria-label={`Move ${m.ply}: ${m.san}, ${CLASSIFICATION[m.classification].label}`}><span><span className="text-text-2 text-xs mr-2">{m.move_number}{m.color === 'white' ? '.' : '…'}</span>{m.san}</span><span className="font-bold text-xs" style={{ color: CLASSIFICATION[m.classification].color }}>{CLASSIFICATION[m.classification].symbol}</span></button>)}</div></div>
        {summary && <div className="card p-4 space-y-2"><div className="grid grid-cols-[1fr_40px_40px] text-xs text-text-2"><span>Move breakdown</span><span>White</span><span>Black</span></div>{(Object.keys(CLASSIFICATION) as MoveClass[]).map(kind => <div key={kind} className="grid grid-cols-[1fr_40px_40px] items-center text-sm"><Badge kind={kind} /><span>{summary.white.counts[kind] ?? 0}</span><span>{summary.black.counts[kind] ?? 0}</span></div>)}</div>}
      </section>
    </div>
    <details className="mt-6 card p-4 text-xs text-text-2 leading-relaxed"><summary className="cursor-pointer text-text-1">How this review is calculated</summary>
      <p className="mt-3">{engine} analyses the game locally. Move labels use Chess.com’s published expected-points bands (0.02 / 0.05 / 0.10 / 0.20), on a human expected-points curve fitted to real game results rather than the engine’s own model. Following Chess.com’s described rules, a Blunder needs a concrete punishment (material or mate); a large loss without one is a Mistake, and letting a winning chance slip after the opponent’s error is a Miss. Great is the only good move (not an obvious recapture); Brilliant is a sound, near-best piece or exchange sacrifice that was actually needed.</p>
      <p className="mt-2">Accuracy uses win-percentage loss per move with constants fitted to Chess.com’s stored accuracies (Published-Data API); for Chess.com games their official figure is shown alongside. Game rating is the rating at which that accuracy is typical on Chess.com, from thousands of rated games; it does not use the players’ own ratings. These are close approximations, not Chess.com’s CAPS2 code. Book moves use the CC0 Lichess opening reference.</p></details>
  </div>
}
