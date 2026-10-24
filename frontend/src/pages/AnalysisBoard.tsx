import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Chess } from 'chess.js'
import { Chessboard } from 'react-chessboard'
import type { Square } from 'chess.js'
import type { Arrow } from 'react-chessboard/dist/chessboard/types'
import {
  ArrowUpToLine, Check, ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Copy, Cpu, FileUp, FlipVertical2,
  Hammer, Loader2, Microscope, ScanSearch, Sparkles, Trash2, Upload, X,
} from 'lucide-react'
import { SectionHeader } from '../components/layout/SectionHeader'
import { BoardEditor } from '../components/analysis/BoardEditor'
import { useBoardPublisher } from '../features/share-screen/boardLink'
import { useElementWidth } from '../hooks/useElementWidth'
import {
  ROOT, addMove, completeFen, deleteFrom, detectInput, fromMoves, isMainline, mainlineFrom, newTree, parsePgn,
  pathTo, promote, toPgn, type MoveTree,
} from '../lib/moveTree'
import { evalText, whiteShare } from '../lib/format'
import { followReview, libraryApi } from '../api/library'
import { useUserStore } from '../store/userStore'
import { BOARD_DARK, BOARD_LIGHT, NEON } from '../theme'

const START_FEN = new Chess().fen()

interface NavPosition { fen: string; label: string; best_move_uci?: string; mistake_uci?: string }
interface AnalysisNavState {
  positions?: NavPosition[]
  index?: number
  title?: string
  moves?: string[]          // SAN or UCI from the start
  pgn?: string
  ply?: number              // go to the position after this many plies (or before it with `before`)
  before?: boolean
  arrows?: { from: string; to: string; color: 'played' | 'best' }[]
  reviewId?: string
  fen?: string
}

interface EngineLine { uci: string[]; san: string; cp: number | null; mate: number | null; depth?: number }
interface AnalysisResult { best_move: string | null; eval_cp: number | null; eval_mate: number | null; lines?: EngineLine[]; game_over?: string }

type ReviewState = { status: 'idle' } | { status: 'starting' } | { status: 'running'; id: string; done: number; total: number } | { status: 'done'; id: string } | { status: 'error'; message: string }

function optionStyles(chess: Chess, square: Square): Record<string, React.CSSProperties> {
  const styles: Record<string, React.CSSProperties> = {}
  for (const m of chess.moves({ square, verbose: true })) {
    styles[m.to] = {
      background: chess.get(m.to as Square)
        ? 'radial-gradient(circle, rgba(255,77,77,0.35) 85%, transparent 85%)'
        : 'radial-gradient(circle, rgba(200,255,42,0.35) 40%, transparent 40%)',
      borderRadius: '50%',
    }
  }
  styles[square] = { backgroundColor: 'rgba(200,255,42,0.25)' }
  return styles
}

// ── move tree view ───────────────────────────────────────────────────────────

function MoveTreeView({ tree, current, onSelect }: { tree: MoveTree; current: string; onSelect: (id: string) => void }) {
  const curRef = useRef<HTMLButtonElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const b = curRef.current, box = boxRef.current
    if (!b || !box) return
    const top = b.offsetTop, bottom = top + b.offsetHeight
    if (top < box.scrollTop) box.scrollTop = top - 8
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight + 8
  }, [current])
  const renderLine = (fromId: string, depth: number, force: boolean): ReactNode[] => {
    const out: ReactNode[] = []
    let cur = tree.nodes[fromId]
    let forceNum = force
    while (cur && cur.children.length) {
      const [main, ...alts] = cur.children.map(c => tree.nodes[c])
      const [, turn, , , , full] = cur.fen.split(' ')
      const num = turn === 'w' ? `${full}.` : forceNum ? `${full}…` : ''
      out.push(
        <span key={main.id} className="inline-flex items-baseline">
          {num && <span className="text-text-2 mr-1 ml-1.5">{num}</span>}
          <button ref={main.id === current ? curRef : undefined} onClick={() => onSelect(main.id)}
            className={`px-1 py-0.5 rounded font-mono transition-colors ${main.id === current ? 'bg-accent text-accent-ink font-semibold' : depth ? 'text-text-1 hover:bg-bg-3' : 'text-text-0 hover:bg-bg-3'} ${main.game === false || (!main.game && depth === 0 && !tree.nodes[ROOT].children.some(c => tree.nodes[c].game)) ? '' : ''}`}>
            {main.san}
          </button>
        </span>,
      )
      forceNum = false
      for (const alt of alts) {
        out.push(
          <span key={`v-${alt.id}`} className={`${depth === 0 ? 'block my-1 pl-3 border-l-2 border-accent/30' : 'inline'} text-[12px]`}>
            <span className="text-text-2">(</span>
            <span className="inline-flex items-baseline">
              <span className="text-text-2 mr-1">{turn === 'w' ? `${full}.` : `${full}…`}</span>
              <button ref={alt.id === current ? curRef : undefined} onClick={() => onSelect(alt.id)}
                className={`px-1 py-0.5 rounded font-mono ${alt.id === current ? 'bg-accent text-accent-ink font-semibold' : 'text-text-1 hover:bg-bg-3'}`}>{alt.san}</button>
            </span>
            {renderLine(alt.id, depth + 1, false)}
            <span className="text-text-2">)</span>
          </span>,
        )
        forceNum = true
      }
      cur = main
    }
    return out
  }
  const empty = !tree.nodes[ROOT].children.length
  return (
    <div ref={boxRef} className="relative max-h-[42vh] lg:max-h-[340px] overflow-y-auto text-sm leading-7 pr-1">
      {empty ? <p className="text-xs text-text-2 italic">Play a move on the board, or load a game.</p> : renderLine(ROOT, 0, true)}
    </div>
  )
}

// ── eval bar ─────────────────────────────────────────────────────────────────

function EvalBar({ cp, mate, loading, height, flipped }: { cp: number | null; mate: number | null; loading: boolean; height: number; flipped: boolean }) {
  const pct = whiteShare(cp, mate)
  const label = evalText(cp, mate)
  return (
    <div className={`w-5 rounded overflow-hidden flex flex-shrink-0 relative ${flipped ? 'flex-col' : 'flex-col-reverse'}`} style={{ height }} aria-label={`Evaluation ${label}`}>
      <div className="bg-[#F0F0F0] transition-all duration-500" style={{ height: `${pct}%` }} />
      <div className="bg-bg-3 flex-1" />
      <span className={`absolute left-0 right-0 text-center text-[9px] font-bold ${pct > 50 !== flipped ? 'bottom-1 text-bg-0' : 'top-1 text-text-0'}`}>{loading ? '…' : label}</span>
    </div>
  )
}

// ── page ─────────────────────────────────────────────────────────────────────

export default function AnalysisBoard() {
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const navState = location.state as AnalysisNavState | null
  const { username } = useUserStore()

  const [mode, setMode] = useState<'analyse' | 'construct'>(searchParams.get('mode') === 'construct' ? 'construct' : 'analyse')
  const [tree, setTree] = useState<MoveTree>(() => newTree(START_FEN))
  const [current, setCurrent] = useState(ROOT)
  const [headers, setHeaders] = useState<Record<string, string>>({})
  const [title, setTitle] = useState<string>(navState?.title ?? 'Analysis Board')
  const [gamePgn, setGamePgn] = useState<string | null>(null)       // a loaded GAME (enables review)
  const [positions, setPositions] = useState<NavPosition[]>([])
  const [posIdx, setPosIdx] = useState(0)
  const [hintArrows, setHintArrows] = useState<Arrow[]>([])
  const [orient, setOrient] = useState<'white' | 'black'>('white')
  const [selectedSq, setSelectedSq] = useState<Square | null>(null)
  const [engineOn, setEngineOn] = useState(true)
  const [multipv, setMultipv] = useState(3)
  const [loadText, setLoadText] = useState('')
  const [loadOpen, setLoadOpen] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [copied, setCopied] = useState<'fen' | 'pgn' | null>(null)
  const [review, setReview] = useState<ReviewState>({ status: 'idle' })
  const reviewAbort = useRef<AbortController | null>(null)
  const [boardRef, measured] = useElementWidth<HTMLDivElement>(560)
  const width = Math.max(240, Math.min(720, measured - 28))

  const node = tree.nodes[current] ?? tree.nodes[ROOT]
  const fen = node.fen
  const chess = useMemo(() => {
    const c = new Chess(tree.rootFen)
    for (const id of pathTo(tree, current)) { try { c.move(tree.nodes[id].san) } catch { break } }
    return c
  }, [tree, current])
  const liveCoach = useBoardPublisher(searchParams.get('coachShare'), chess, fen)

  // ── loading ──────────────────────────────────────────────────────────────
  const loadGame = useCallback((t: MoveTree, last: string, h: Record<string, string>, pgn: string | null, goto?: string) => {
    setTree(t); setCurrent(goto ?? last); setHeaders(h); setGamePgn(pgn); setPositions([]); setHintArrows([])
    setReview({ status: 'idle' }); reviewAbort.current?.abort()
    if (h.White || h.Black) setTitle(`${h.White ?? '?'} – ${h.Black ?? '?'}`)
  }, [])

  const loadFen = useCallback((f: string, label = 'Position') => {
    const full = completeFen(f)
    try { new Chess(full) } catch (e) { throw new Error(e instanceof Error ? e.message : 'Invalid FEN') }
    setTree(newTree(full)); setCurrent(ROOT); setHeaders({}); setGamePgn(null); setHintArrows([])
    setReview({ status: 'idle' }); setTitle(label)
    setOrient(full.split(' ')[1] === 'b' ? 'black' : 'white')
  }, [])

  // hand-offs: router state or ?fen=
  useEffect(() => {
    const s = navState
    try {
      if (s?.pgn) {
        const g = parsePgn(s.pgn)
        const ids = mainlineFrom(g.tree)
        let goto = g.last
        if (s.ply != null) goto = (s.before ? (s.ply > 1 ? ids[s.ply - 2] : ROOT) : ids[s.ply - 1]) ?? g.last
        loadGame(g.tree, g.last, g.headers, s.pgn, goto)
        if (s.title) setTitle(s.title)
        if (s.arrows) setHintArrows(s.arrows.map(a => [a.from as Square, a.to as Square, a.color === 'best' ? NEON : 'rgba(255,90,90,0.9)']))
        if (s.reviewId) setReview({ status: 'done', id: s.reviewId })
      } else if (s?.moves?.length) {
        const { tree: t, last } = fromMoves(START_FEN, s.moves)
        const pgn = toPgn(t, { White: '?', Black: '?' })
        loadGame(t, last, {}, pgn)
        if (s.title) setTitle(s.title)
      } else if (s?.positions?.length) {
        setPositions(s.positions); setPosIdx(s.index ?? 0)
        const p = s.positions[s.index ?? 0]
        loadFen(p.fen, s.title ?? p.label)
        setHintArrows(arrowsFor(p))
      } else {
        const f = s?.fen || searchParams.get('fen')
        if (f) loadFen(f, 'Position analysis')
      }
    } catch (e) { setLoadError(e instanceof Error ? e.message : 'Could not load that game.') }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function arrowsFor(p: NavPosition): Arrow[] {
    const out: Arrow[] = []
    if (p.mistake_uci?.length && p.mistake_uci.length >= 4) out.push([p.mistake_uci.slice(0, 2) as Square, p.mistake_uci.slice(2, 4) as Square, 'rgba(255,90,90,0.9)'])
    if (p.best_move_uci?.length && p.best_move_uci.length >= 4) out.push([p.best_move_uci.slice(0, 2) as Square, p.best_move_uci.slice(2, 4) as Square, NEON])
    return out
  }

  function submitLoad(text = loadText) {
    setLoadError('')
    const kind = detectInput(text)
    try {
      if (kind === 'fen') { loadFen(text) }
      else if (kind === 'pgn') { const g = parsePgn(text); loadGame(g.tree, g.last, g.headers, text.trim(), ROOT) }
      else if (kind === 'empty') { setLoadError('Paste a PGN or a FEN first.'); return }
      else { setLoadError("That doesn't look like a PGN or a FEN."); return }
      setLoadOpen(false); setLoadText(''); setMode('analyse')
    } catch (e) { setLoadError(e instanceof Error ? e.message : 'Could not load that.') }
  }

  async function uploadFile(file?: File) {
    if (!file) return
    if (file.size > 300_000) { setLoadError('Choose a PGN file under 300 KB.'); return }
    const text = await file.text()
    setLoadText(text); submitLoad(text)
  }

  // ── moves ────────────────────────────────────────────────────────────────
  function play(from: string, to: string, promotion?: string): boolean {
    const res = addMove(tree, current, { from, to, promotion: promotion ?? 'q' })
    if (!res) return false
    setTree(res.tree); setCurrent(res.id); setSelectedSq(null); setHintArrows([])
    return true
  }
  function onDrop(from: string, to: string, piece: string): boolean {
    const promo = piece[1]?.toLowerCase() === 'p' && (to[1] === '8' || to[1] === '1') ? 'q' : undefined
    return play(from, to, promo)
  }
  function onSquareClick(sq: Square) {
    if (selectedSq) {
      const moves = chess.moves({ square: selectedSq, verbose: true })
      const m = moves.find(x => x.to === sq)
      if (m) { play(selectedSq, sq, m.promotion ? 'q' : undefined); return }
    }
    const piece = chess.get(sq)
    setSelectedSq(piece && piece.color === chess.turn() ? sq : null)
  }
  function playLine(uci: string[], count: number) {
    let t = tree, at = current
    for (const u of uci.slice(0, count)) {
      const res = addMove(t, at, { from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] })
      if (!res) break
      t = res.tree; at = res.id
    }
    setTree(t); setCurrent(at); setHintArrows([])
  }

  const goPrev = () => { if (node.parent) { setCurrent(node.parent); setHintArrows([]) } }
  const goNext = () => { if (node.children[0]) { setCurrent(node.children[0]); setHintArrows([]) } }
  const goStart = () => { setCurrent(ROOT); setHintArrows([]) }
  const goEnd = () => { const ml = mainlineFrom(tree, current); if (ml.length) setCurrent(ml[ml.length - 1]) }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,textarea,select') || mode !== 'analyse') return
      if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev() }
      if (e.key === 'ArrowRight') { e.preventDefault(); goNext() }
      if (e.key === 'Home') { e.preventDefault(); goStart() }
      if (e.key === 'End') { e.preventDefault(); goEnd() }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        // switch between sibling variations
        const p = node.parent ? tree.nodes[node.parent] : null
        if (!p) return
        e.preventDefault()
        const i = p.children.indexOf(node.id)
        const j = e.key === 'ArrowUp' ? i - 1 : i + 1
        if (p.children[j]) setCurrent(p.children[j])
      }
      if (e.key.toLowerCase() === 'f') setOrient(o => (o === 'white' ? 'black' : 'white'))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ── engine ───────────────────────────────────────────────────────────────
  const { data: analysis, isFetching: analysing } = useQuery<AnalysisResult>({
    queryKey: ['analysis', fen, multipv],
    queryFn: () => fetch(`/api/analyse?fen=${encodeURIComponent(fen)}&depth=16&multipv=${multipv}`).then(r => {
      if (!r.ok) throw new Error('Analysis failed')
      return r.json()
    }),
    staleTime: Infinity, retry: false, enabled: engineOn && mode === 'analyse',
  })
  const bestArrow: Arrow[] = engineOn && analysis?.best_move && !hintArrows.length
    ? [[analysis.best_move.slice(0, 2) as Square, analysis.best_move.slice(2, 4) as Square, 'rgba(200,255,42,0.75)']] : []

  // ── background review ────────────────────────────────────────────────────
  useEffect(() => () => reviewAbort.current?.abort(), [])
  async function startReview() {
    if (!gamePgn || !username) return
    setReview({ status: 'starting' })
    try {
      const r = await libraryApi.startReview(username, { pgn: gamePgn, quality: 'standard', source: 'analysis', title: title !== 'Analysis Board' ? title : undefined })
      if (r.status === 'done') { setReview({ status: 'done', id: r.review_id }); return }
      setReview({ status: 'running', id: r.review_id, done: 0, total: 0 })
      const ctrl = new AbortController(); reviewAbort.current = ctrl
      let done = 0, total = 0
      await followReview(username, r.review_id, e => {
        if (e.type === 'start') { total = e.total; setReview({ status: 'running', id: r.review_id, done, total }) }
        if (e.type === 'move') { done += 1; setReview({ status: 'running', id: r.review_id, done, total }) }
      }, ctrl.signal)
      setReview({ status: 'done', id: r.review_id })
    } catch (e) {
      if (reviewAbort.current?.signal.aborted) return
      setReview({ status: 'error', message: e instanceof Error ? e.message : 'Review failed.' })
    }
  }

  const copy = (what: 'fen' | 'pgn') => {
    const text = what === 'fen' ? fen : toPgn(tree, headers)
    void navigator.clipboard.writeText(text).then(() => { setCopied(what); setTimeout(() => setCopied(null), 1400) })
  }

  async function playFrom(f: string, engine: 'maia' | 'stockfish') {
    const res = await fetch('/api/bot-game/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, starting_fen: f, engine, user_color: 'random', context: { kind: 'analysis', name: 'Constructed position' } }),
    })
    if (res.ok) { const { game_id } = await res.json(); navigate(`/bot-game/${game_id}`) }
  }

  const lastMoveStyles: Record<string, React.CSSProperties> = node.uci ? {
    [node.uci.slice(0, 2)]: { backgroundColor: 'rgba(200,255,42,0.22)' }, [node.uci.slice(2, 4)]: { backgroundColor: 'rgba(200,255,42,0.32)' },
  } : {}
  const squareStyles = { ...lastMoveStyles, ...(selectedSq ? optionStyles(chess, selectedSq) : {}) }
  if (chess.inCheck()) {
    const k = chess.findPiece({ type: 'k', color: chess.turn() })[0]
    if (k) squareStyles[k] = { ...squareStyles[k], background: 'radial-gradient(circle, rgba(255,77,94,0.65) 30%, transparent 75%)' }
  }
  const inVariation = !isMainline(tree, current)
  const status = chess.isCheckmate() ? 'Checkmate' : chess.isStalemate() ? 'Stalemate' : chess.isDraw() ? 'Draw' : `${chess.turn() === 'w' ? 'White' : 'Black'} to move`

  return (
    <div className="px-3 sm:px-4 lg:px-6 py-4 sm:py-6 max-w-[1500px] mx-auto">
      {liveCoach.linked && (
        <div className="mb-5 rounded-xl border border-accent/30 bg-accent/10 p-4 flex items-center justify-between gap-3">
          <div><p className="text-sm font-semibold text-accent">Live coach board</p><p className="text-xs text-text-1 mt-1" role="status">{liveCoach.status}</p></div>
          <button className="btn-ghost" onClick={liveCoach.interrupt}>Interrupt coach</button>
        </div>
      )}
      <SectionHeader icon={Microscope} title="Analysis Board" description={mode === 'construct' ? 'Construct any position, then analyse it or play it out.' : `${title} · live Stockfish on every position · branch any line`}
        right={
          <div className="flex p-0.5 rounded-lg bg-bg-2 border border-border">
            {([['analyse', 'Analyse', Microscope], ['construct', 'Construct board', Hammer]] as const).map(([m, label, Icon]) => (
              <button key={m} onClick={() => setMode(m)} className={`px-2.5 sm:px-3 py-1.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5 ${mode === m ? 'bg-bg-3 text-accent' : 'text-text-2 hover:text-text-0'}`}>
                <Icon size={13} /><span className={m === 'construct' ? 'hidden sm:inline' : ''}>{label}</span>{m === 'construct' && <span className="sm:hidden">Construct</span>}
              </button>
            ))}
          </div>
        } />

      {mode === 'construct' ? (
        <BoardEditor initialFen={fen} onAnalyse={f => { loadFen(f, 'Constructed position'); setMode('analyse') }} onPlay={(f, e) => void playFrom(f, e)} />
      ) : (
        <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)] gap-5 lg:gap-6">
          {/* board */}
          <section className="min-w-0">
            <div ref={boardRef} className="mx-auto w-full" style={{ maxWidth: 760 }}>
              <div className="flex gap-2 items-stretch">
                {engineOn && <EvalBar cp={analysis?.eval_cp ?? null} mate={analysis?.eval_mate ?? null} loading={analysing} height={width} flipped={orient === 'black'} />}
                <Chessboard id="analysis-board" position={fen} boardOrientation={orient} boardWidth={width}
                  onPieceDrop={onDrop} onSquareClick={onSquareClick} customSquareStyles={squareStyles}
                  customArrows={[...hintArrows, ...bestArrow]}
                  customDarkSquareStyle={{ backgroundColor: BOARD_DARK }} customLightSquareStyle={{ backgroundColor: BOARD_LIGHT }}
                  customBoardStyle={{ borderRadius: 8, boxShadow: '0 0 0 1px rgba(200,255,42,0.15)' }} />
              </div>
              <div className="flex items-center justify-between gap-2 mt-3">
                <span className={`text-xs ${chess.isCheckmate() ? 'text-accent font-semibold' : 'text-text-2'}`}>{status}{inVariation ? ' · in a variation' : ''}</span>
                <div className="flex items-center gap-0.5">
                  <button className="btn-ghost px-2" onClick={goStart} aria-label="Start"><ChevronFirst size={18} /></button>
                  <button className="btn-ghost px-2" onClick={goPrev} aria-label="Previous move" disabled={!node.parent}><ChevronLeft size={18} /></button>
                  <button className="btn-ghost px-2" onClick={goNext} aria-label="Next move" disabled={!node.children.length}><ChevronRight size={18} /></button>
                  <button className="btn-ghost px-2" onClick={goEnd} aria-label="End of line"><ChevronLast size={18} /></button>
                  <button className="btn-ghost px-2" onClick={() => setOrient(o => (o === 'white' ? 'black' : 'white'))} aria-label="Flip board"><FlipVertical2 size={16} /></button>
                </div>
              </div>
              {positions.length > 1 && (
                <div className="card p-3 mt-3 flex items-center gap-2">
                  <button className="btn-ghost px-2" disabled={posIdx === 0} onClick={() => { const i = posIdx - 1; setPosIdx(i); loadFen(positions[i].fen, title); setHintArrows(arrowsFor(positions[i])) }}><ChevronLeft size={16} /></button>
                  <div className="flex-1 text-center min-w-0"><p className="text-[11px] text-text-2">{posIdx + 1} / {positions.length}</p><p className="text-sm text-text-0 truncate">{positions[posIdx]?.label}</p></div>
                  <button className="btn-ghost px-2" disabled={posIdx === positions.length - 1} onClick={() => { const i = posIdx + 1; setPosIdx(i); loadFen(positions[i].fen, title); setHintArrows(arrowsFor(positions[i])) }}><ChevronRight size={16} /></button>
                </div>
              )}
            </div>
          </section>

          {/* side */}
          <section className="min-w-0 space-y-3">
            {/* game actions */}
            {gamePgn ? (
              <div className="card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-text-0 truncate">{title}</p>
                    <p className="text-[11px] text-text-2">{mainlineFrom(tree).length} plies{headers.Result && headers.Result !== '*' ? ` · ${headers.Result}` : ''}{headers.Event && headers.Event !== '?' ? ` · ${headers.Event}` : ''}</p>
                  </div>
                  <button className="p-1.5 text-text-2 hover:text-text-0" title="Close game" onClick={() => loadFen(START_FEN, 'Analysis Board')}><X size={14} /></button>
                </div>
                <ReviewButton state={review} onStart={() => void startReview()} onOpen={id => navigate(`/game-review/${id}`)} />
              </div>
            ) : (
              <p className="text-[11px] text-text-2 px-1">Load a PGN to send the whole game to Game Review. A FEN loads a position to explore.</p>
            )}

            {/* load */}
            <div className="card p-4">
              <button className="w-full flex items-center justify-between text-sm font-medium" onClick={() => setLoadOpen(o => !o)} aria-expanded={loadOpen}>
                <span className="inline-flex items-center gap-2"><Upload size={14} className="text-accent" />Load a PGN or FEN</span>
                <span className="text-[11px] text-text-2">{loadOpen ? 'Hide' : 'Paste · upload'}</span>
              </button>
              {loadOpen && (
                <div className="mt-3 space-y-2">
                  <textarea className="input font-mono text-[11px] min-h-[110px]" value={loadText} onChange={e => setLoadText(e.target.value)}
                    placeholder={'Paste a full PGN (headers optional)\n…or a FEN like rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'} spellCheck={false} />
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-text-2">{loadText.trim() ? { pgn: 'Detected: PGN game', fen: 'Detected: FEN position', invalid: 'Not recognised', empty: '' }[detectInput(loadText)] : ''}</span>
                    <div className="flex gap-2">
                      <label className="btn-ghost border border-border text-xs inline-flex items-center gap-1.5 cursor-pointer"><FileUp size={12} />.pgn<input type="file" accept=".pgn,.txt" className="sr-only" onChange={e => { void uploadFile(e.target.files?.[0]); e.target.value = '' }} /></label>
                      <button className="btn-primary text-xs" onClick={() => submitLoad()}>Load</button>
                    </div>
                  </div>
                </div>
              )}
              {loadError && <p className="text-xs text-danger mt-2">{loadError}</p>}
            </div>

            {/* engine */}
            <div className="card p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium inline-flex items-center gap-2"><Cpu size={14} className="text-accent" />Stockfish
                  {analysing && <Loader2 size={12} className="animate-spin text-accent" />}</span>
                <div className="flex items-center gap-2">
                  <select className="input !w-auto py-1 text-xs" value={multipv} onChange={e => setMultipv(Number(e.target.value))} aria-label="Lines">
                    {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n} line{n > 1 ? 's' : ''}</option>)}
                  </select>
                  <button onClick={() => setEngineOn(v => !v)} className={`text-xs px-2 py-1 rounded-md border ${engineOn ? 'border-accent/40 text-accent' : 'border-border text-text-2'}`}>{engineOn ? 'On' : 'Off'}</button>
                </div>
              </div>
              {engineOn && (
                <div className="mt-3 space-y-1.5">
                  {analysis?.game_over ? <p className="text-xs text-text-2">Game over ({analysis.game_over.replace(/_/g, ' ')}).</p>
                    : (analysis?.lines ?? []).map((l, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs">
                        <span className={`font-mono font-semibold w-12 flex-shrink-0 text-right ${i === 0 ? 'text-accent' : 'text-text-1'}`}>{evalText(l.cp, l.mate)}</span>
                        <button className="font-mono text-text-1 text-left hover:text-text-0 leading-relaxed" title="Click to play this line on the board" onClick={() => playLine(l.uci, Math.min(l.uci.length, 6))}>
                          {l.san.split(' ').slice(0, 12).join(' ')}
                        </button>
                      </div>
                    ))}
                  {!analysis && analysing && <p className="text-xs text-text-2">Analysing…</p>}
                  {analysis?.lines?.[0]?.depth && <p className="text-[10px] text-text-2 pt-1">Depth {analysis.lines[0].depth} · click a line to add it as a variation</p>}
                </div>
              )}
            </div>

            {/* moves */}
            <div className="card p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">Moves</span>
                <div className="flex items-center gap-1">
                  {inVariation && <button className="text-[11px] px-2 py-1 rounded-md border border-border text-text-1 hover:text-accent inline-flex items-center gap-1" onClick={() => setTree(promote(tree, current))}><ArrowUpToLine size={11} />Promote</button>}
                  {current !== ROOT && <button className="text-[11px] px-2 py-1 rounded-md border border-border text-text-1 hover:text-danger inline-flex items-center gap-1" onClick={() => { const p = node.parent ?? ROOT; setTree(deleteFrom(tree, current)); setCurrent(p) }}><Trash2 size={11} />Delete from here</button>}
                </div>
              </div>
              <MoveTreeView tree={tree} current={current} onSelect={id => { setCurrent(id); setHintArrows([]) }} />
              <p className="text-[10px] text-text-2 mt-2">← → move · ↑ ↓ switch variation · F flip · moves played from any position create a new branch</p>
            </div>

            {/* export */}
            <div className="card p-3 space-y-2">
              <div className="flex items-center gap-2">
                <p className="text-[11px] text-text-2 flex-1 font-mono truncate" title={fen}>{fen}</p>
                <button onClick={() => copy('fen')} className="text-xs text-text-2 hover:text-text-0 inline-flex items-center gap-1">{copied === 'fen' ? <Check size={11} className="text-success" /> : <Copy size={11} />}FEN</button>
                <button onClick={() => copy('pgn')} className="text-xs text-text-2 hover:text-text-0 inline-flex items-center gap-1">{copied === 'pgn' ? <Check size={11} className="text-success" /> : <Copy size={11} />}PGN</button>
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="btn-ghost border border-border text-xs inline-flex items-center gap-1.5" onClick={() => navigate('/coach', { state: { position: { fen, label: 'From the Analysis Board', question: 'What is the plan for both sides here?' } } })}><Sparkles size={12} />Ask the coach</button>
                <button className="btn-ghost border border-border text-xs inline-flex items-center gap-1.5" onClick={() => setMode('construct')}><Hammer size={12} />Edit position</button>
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

function ReviewButton({ state, onStart, onOpen }: { state: ReviewState; onStart: () => void; onOpen: (id: string) => void }) {
  if (state.status === 'done') {
    return (
      <button onClick={() => onOpen(state.id)} className="btn-primary w-full mt-3 inline-flex items-center justify-center gap-2 py-2.5">
        <ScanSearch size={15} />Game review ready — open it
      </button>
    )
  }
  if (state.status === 'running' || state.status === 'starting') {
    const pct = state.status === 'running' && state.total ? Math.round((state.done / state.total) * 100) : 4
    return (
      <div className="relative w-full mt-3 rounded-lg border border-accent/50 overflow-hidden py-2.5 text-center text-sm font-semibold text-accent shadow-neon-sm" role="status">
        <div className="absolute inset-y-0 left-0 bg-accent/20 transition-all duration-500" style={{ width: `${pct}%` }} />
        <div className="absolute inset-0 bg-[linear-gradient(110deg,transparent_25%,rgba(200,255,42,0.18)_50%,transparent_75%)] bg-[length:200%_100%] animate-[shimmer_1.6s_linear_infinite]" />
        <span className="relative inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" />
          {state.status === 'starting' ? 'Starting review…' : state.total ? `Reviewing… ${state.done}/${state.total}` : 'Queued for review…'}</span>
        <p className="relative text-[10px] font-normal text-text-2 mt-0.5">Keep exploring — this runs in the background.</p>
      </div>
    )
  }
  return (
    <>
      <button onClick={onStart} className="btn-ghost border border-accent/40 text-accent w-full mt-3 inline-flex items-center justify-center gap-2 py-2.5 hover:bg-accent/10">
        <ScanSearch size={15} />Review this game
      </button>
      {state.status === 'error' && <p className="text-xs text-danger mt-2">{state.message}</p>}
    </>
  )
}
