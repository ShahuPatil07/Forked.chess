import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Chessboard } from 'react-chessboard'
import { Chess } from 'chess.js'
import type { Square } from 'chess.js'
import { ArrowRight, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Download, FileUp, FlipVertical2, Loader2, ScanSearch, Sparkles, X } from 'lucide-react'
import { reviewGame, type MoveClass, type ReviewMove, type ReviewSummary } from '../api/gameReview'
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
  const abort = useRef<AbortController | null>(null), explainAbort = useRef<AbortController | null>(null)
  const boardWrap = useRef<HTMLDivElement>(null), [width, setWidth] = useState(480)
  const selectedButton = useRef<HTMLButtonElement>(null)
  const row = moves[selected - 1]
  const line = branch === 'best' ? row?.best_line : branch === 'played' ? row?.line : branch === 'custom' ? customLine ?? undefined : undefined
  const fen = line?.fens[branchPly] ?? row?.fen ?? initialFen
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
    setBranch(null); setBranchPly(0); setChat([]); setFollowUp(''); explainAbort.current?.abort(); setExplaining(false)
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

  async function start() {
    if (busy || !pgn.trim()) return
    const ctrl = new AbortController(); abort.current = ctrl
    explainAbort.current?.abort(); setChat([]); setExplaining(false)
    setBusy(true); setError(''); setHeaders({}); setInitialFen(new Chess().fen()); setMoves([]); setSummary(null); setSelected(0); setTotal(0); setBranch(null)
    try {
      await reviewGame(pgn, quality, event => {
        if (event.type === 'start') { setTotal(event.total); setHeaders(event.headers); setInitialFen(event.initial_fen); setShowImport(false) }
        if (event.type === 'move') setMoves(old => [...old, event.move])
        if (event.type === 'done') { setSummary(event.summary); setEngine(event.engine) }
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
      <textarea aria-label="PGN" className="input font-mono text-xs resize-y min-h-[130px]" placeholder={'[White "You"]\n[Black "Opponent"]\n\n1. e4 e5 2. Nf3 Nc6 ...'} value={pgn} disabled={busy} onChange={e => setPgn(e.target.value)} />
      <div className="flex flex-wrap items-center justify-between gap-3 mt-3"><p className="text-xs text-text-2">Local Stockfish. No account import. No daily review limit.</p><div className="flex gap-3"><select aria-label="Review quality" className="input !w-auto" value={quality} disabled={busy} onChange={e => setQuality(e.target.value)}><option value="quick">Quick</option><option value="standard">Standard</option><option value="deep">Deep</option></select><button onClick={start} disabled={busy || !pgn.trim()} className="btn-primary flex gap-2 items-center"><ScanSearch size={16} />Game review</button></div></div>
    </section>}
    {error && <p role="alert" className="text-sm text-amber-200 mb-4">{error}</p>}
    {busy && <div className="card p-4 mb-5"><div className="flex justify-between items-center text-sm mb-3"><span className="flex gap-2 items-center"><Loader2 size={14} className="animate-spin" />Reviewing move {moves.length} of {total || '…'}</span><button className="btn-ghost" onClick={() => abort.current?.abort()}><X size={14} />Cancel</button></div><div className="h-1 bg-bg-3 rounded"><div className="h-1 bg-accent rounded transition-all" style={{ width: `${total ? moves.length / total * 100 : 0}%` }} /></div></div>}
    <div className="grid xl:grid-cols-[minmax(0,1fr)_minmax(360px,470px)] gap-6">
      <section className="min-w-0">
        <div className="flex justify-between text-sm mb-3"><span>{headers[flipped ? 'White' : 'Black'] || (flipped ? 'White' : 'Black')}</span><span className="text-text-2">{headers.Result || 'Study'}</span></div>
        <div ref={boardWrap} className="flex gap-2 items-stretch">
          <div className={`w-4 bg-bg-3 rounded overflow-hidden flex flex-shrink-0 ${flipped ? 'flex-col' : 'flex-col-reverse'}`}><div className="bg-[#d5d2de] transition-all" style={{ height: `${whiteShare}%` }} /></div>
          <Chessboard id="review-board" boardWidth={width} position={fen} boardOrientation={flipped ? 'black' : 'white'} arePiecesDraggable={false}
            customDarkSquareStyle={{ backgroundColor: '#454161' }} customLightSquareStyle={{ backgroundColor: '#b8b2ce' }}
            customSquareStyles={row && !branch ? { [row.uci.slice(0, 2)]: { backgroundColor: '#b9a96188' }, [row.uci.slice(2, 4)]: { backgroundColor: '#b9a961bb' } } : {}}
            customArrows={branch === 'best' && branchPly === 0 && row ? [[row.best_uci.slice(0, 2) as Square, row.best_uci.slice(2, 4) as Square, '#9ecb76']] : []} />
        </div>
        <div className="flex justify-between text-sm mt-3"><span>{headers[flipped ? 'Black' : 'White'] || (flipped ? 'Black' : 'White')}</span><span className="font-mono text-text-2">{evalLabel} · White perspective{branch ? ' (game position)' : ''}</span></div>
        <div className="flex justify-center gap-2 mt-4 items-center"><button aria-label="First position" className="btn-ghost" onClick={() => setSelected(0)} disabled={!selected}><ChevronsLeft size={20} /></button><button aria-label="Previous move" className="btn-ghost" onClick={() => setSelected(n => Math.max(0, n - 1))} disabled={!selected}><ChevronLeft size={20} /></button><span className="text-xs text-text-2 w-20 text-center">{selected} / {moves.length}</span><button aria-label="Next move" className="btn-ghost" onClick={() => setSelected(n => Math.min(moves.length, n + 1))} disabled={selected === moves.length}><ChevronRight size={20} /></button><button aria-label="Last position" className="btn-ghost" onClick={() => setSelected(moves.length)} disabled={selected === moves.length}><ChevronsRight size={20} /></button><button aria-label="Flip board" className="btn-ghost" onClick={() => setFlipped(v => !v)}><FlipVertical2 size={16} /></button></div>
        {!!moves.length && <div className="card mt-4 p-3"><svg viewBox="0 0 600 100" className="w-full h-24" aria-label="Game advantage graph" role="img"><line x1="0" y1="50" x2="600" y2="50" stroke="#666" strokeDasharray="4" /><polyline fill="none" stroke="#a78bfa" strokeWidth="2" points={moves.map((m, i) => `${i * 600 / Math.max(1, moves.length - 1)},${100 - (m.played_score.white_mate !== null ? m.played_score.white_mate > 0 ? 100 : 0 : 100 / (1 + Math.exp(-.00368208 * (m.played_score.white_cp ?? 0))))}`).join(' ')} /><line x1={Math.max(0, selected - 1) * 600 / Math.max(1, moves.length - 1)} x2={Math.max(0, selected - 1) * 600 / Math.max(1, moves.length - 1)} y1="0" y2="100" stroke="#eee" opacity=".5" /></svg><input aria-label="Navigate game" type="range" min={0} max={moves.length} value={selected} onChange={e => setSelected(Number(e.target.value))} className="w-full accent-violet-500" /></div>}
        <button className="btn-ghost mt-3 text-xs" onClick={() => navigate(`/analysis?fen=${encodeURIComponent(fen)}`)}>Explore this position <ArrowRight size={12} className="inline ml-1" /></button>
      </section>
      <section className="min-w-0 space-y-4">
        <div className="grid grid-cols-2 gap-3">{(['white', 'black'] as const).map(side => <div key={side} className="card p-4"><p className="text-xs text-text-2 uppercase tracking-wider">{side} accuracy</p><p className="text-3xl font-semibold mt-2">{summary?.[side].accuracy ?? '—'}<span className="text-sm text-text-2">%</span></p><p className="text-xs text-text-2 mt-2">Estimated game strength</p>{summary?.[side].rating ? <><p className="font-medium mt-1">≈{summary[side].rating!.estimate} <span className="text-xs text-text-2">({summary[side].rating!.low}–{summary[side].rating!.high})</span></p><p className="text-[10px] text-amber-200 mt-1">Experimental estimate · not calibrated Elo</p></> : <p className="text-xs text-text-2 mt-1">{summary ? 'Too few non-book decisions to estimate' : 'Available after review'}</p>}</div>)}</div>
        {row ? <div className="card p-4 border-accent/20"><div className="flex justify-between items-center"><span className="text-lg font-semibold">{row.move_number}{row.color === 'white' ? '.' : '…'} {row.san}</span><Badge kind={row.classification} /></div><p className="text-sm leading-relaxed text-text-1 mt-3">{row.explanation}</p>{row.opening && <p className="text-xs text-text-2 mt-2">{row.opening.eco} · {row.opening.name}</p>}<div className="flex flex-wrap gap-2 mt-4"><button className="btn-ghost border border-border text-xs" onClick={() => { setBranch('best'); setBranchPly(0) }}>Show best line</button><button className="btn-ghost border border-border text-xs" onClick={() => { setBranch('played'); setBranchPly(0) }}>Show played line</button><button className="btn-ghost text-accent text-xs flex gap-1 items-center" disabled={explaining || busy} onClick={() => void explain()}>{explaining ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}{BAD.includes(row.classification) ? 'Why was this wrong?' : 'Explain the idea'}</button></div>
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
    <details className="mt-6 card p-4 text-xs text-text-2 leading-relaxed"><summary className="cursor-pointer text-text-1">How this review is calculated</summary><p className="mt-3">{engine} analyzes the game locally. Standard classification bands follow Chess.com’s published expected-points thresholds, using Stockfish’s own outcome model. Brilliant, Great and Miss are Forked heuristics. Accuracy uses Lichess-inspired win-loss and aggregation formulas. Game strength is an uncalibrated estimate from at least eight non-book, non-forced decisions. These are independent metrics, not Chess.com CAPS2 or official ratings; depth and position difficulty affect results. Player ratings and user profiles do not influence the calculation.</p><p className="mt-2">Book moves use the CC0 Lichess opening reference. All classifications are search findings, not exhaustive proofs. No hosted API is required for review; optional “Explain the idea” uses the same configured Coach narrator and local fallback.</p></details>
  </div>
}
