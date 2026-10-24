import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Chess } from 'chess.js'
import { Chessboard } from 'react-chessboard'
import type { Square } from 'chess.js'
import type { Arrow } from 'react-chessboard/dist/chessboard/types'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Activity, Bot, ChevronLeft, ChevronRight, Cpu, Flag, Loader2, Microscope, RotateCcw, ScanSearch, Sparkles,
  Target, User, Wifi, WifiOff, X,
} from 'lucide-react'
import { wsUrl } from '../api/ws'
import { BotGameDebrief } from '../components/BotGameDebrief'
import { SectionHeader } from '../components/layout/SectionHeader'
import { useUserStore } from '../store/userStore'
import { useElementWidth } from '../hooks/useElementWidth'
import { evalText, whiteShare } from '../lib/format'
import { bothScales, chesscomToLichess, lichessToChesscom, platformName, toLichess } from '../lib/ratings'
import { useOpenReview } from '../lib/review'
import { libraryApi } from '../api/library'
import { CLASSIFICATION } from './GameReview'
import type { MoveClass } from '../api/gameReview'
import type { Platform } from '../types'
import { BOARD_DARK, BOARD_LIGHT } from '../theme'

type Engine = 'maia' | 'stockfish'
type Color = 'white' | 'black' | 'random'

interface Prefill {
  startingMoves?: string[]
  startingFen?: string
  context?: { kind: string; name?: string; [k: string]: unknown }
  engine?: Engine
  annotate?: boolean
  targetElo?: number
}

type WsMsg =
  | { type: 'game_start'; fen: string; starting_fen?: string; moves?: string[]; user_color: 'white' | 'black'; target_elo: number | null
      engine?: Engine; bot_name?: string; annotate?: boolean; status?: string; result?: string | null; library_id?: string | null }
  | { type: 'move_made'; move: string; fen: string; by: 'user' | 'bot' }
  | { type: 'thinking' }
  | { type: 'game_over'; result: string; reason: string; library_id?: string | null }
  | { type: 'error'; message: string }

interface Annotation { classification: MoveClass; san: string; best_san: string | null; best_uci: string | null; white_cp: number | null; white_mate: number | null; loss: number }

const RESULT_REASON: Record<string, string> = {
  checkmate: 'by checkmate', resignation: 'by resignation', stalemate: 'draw by stalemate',
  insufficient_material: 'draw — insufficient material', seventy_five_moves: 'draw — 75-move rule',
  threefold_repetition: 'draw — repetition', fivefold_repetition: 'draw — repetition', fifty_moves: 'draw — 50-move rule',
}

function levelLabel(engine: Engine, lichess: number): { name: string; detail: string } {
  if (engine === 'stockfish') return { name: 'Stockfish', detail: 'Full strength — the most accurate chess there is.' }
  if (lichess < 2000) return { name: 'Maia', detail: 'Human-like: trained on millions of real games, it makes the moves people at this level make — including their mistakes.' }
  return { name: 'Maia+', detail: "Maia's most human moves, each checked by Stockfish so it holds up at this level." }
}

// ── setup ─────────────────────────────────────────────────────────────────────

function SetupScreen({ prefill }: { prefill: Prefill }) {
  const navigate = useNavigate()
  const { username, elo, platform } = useUserStore()
  const [scale, setScale] = useState<Platform>(platform)
  const [rating, setRatingRaw] = useState(() => Math.round(((prefill.targetElo ?? elo ?? 1500) + 50) / 50) * 50)
  const touched = useRef(false)
  const setRating = (v: number) => { touched.current = true; setRatingRaw(v) }
  // follow the live rating (it arrives after sign-in) until the player picks a level
  useEffect(() => {
    if (!touched.current && !prefill.targetElo) setRatingRaw(Math.round(((scale === platform ? elo : scale === 'lichess' ? chesscomToLichess(elo) : lichessToChesscom(elo)) + 50) / 50) * 50)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elo])
  const [engine, setEngine] = useState<Engine>(prefill.engine ?? 'maia')
  const [annotate, setAnnotate] = useState(!!prefill.annotate)
  const [creating, setCreating] = useState<Color | null>(null)
  const [error, setError] = useState('')
  const lichess = toLichess(rating, scale)
  const lvl = levelLabel(engine, lichess)
  const startLine = useMemo(() => {
    if (!prefill.startingMoves?.length) return null
    const c = new Chess()
    try { for (const u of prefill.startingMoves) c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }) } catch { /* shown as far as legal */ }
    return c.pgn().replace(/\[.*?\]\s*/g, '').replace(/\s*\*\s*$/, '').trim()
  }, [prefill.startingMoves])
  // who moves first in the starting position (standard start, an opening line, or a custom FEN)
  const firstToMove: 'white' | 'black' = useMemo(() => {
    try {
      const c = new Chess(prefill.startingFen || undefined)
      for (const u of prefill.startingMoves ?? []) c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] })
      return c.turn() === 'w' ? 'white' : 'black'
    } catch { return 'white' }
  }, [prefill.startingMoves, prefill.startingFen])
  const colorOptions: [Color, string, string, string][] = [
    ['white', 'White', '♔', firstToMove === 'white' ? 'You move first' : 'The bot moves first'],
    ['random', firstToMove === 'white' && !prefill.startingMoves?.length && !prefill.startingFen ? 'Random' : 'Side to move',
     '⚄', firstToMove === 'white' && !prefill.startingMoves?.length && !prefill.startingFen ? 'Surprise me' : `You play ${firstToMove}`],
    ['black', 'Black', '♚', firstToMove === 'black' ? 'You move first' : 'The bot moves first'],
  ]

  function switchScale(p: Platform) {
    if (p === scale) return
    setRatingRaw(Math.round((p === 'lichess' ? chesscomToLichess(rating) : lichessToChesscom(rating)) / 50) * 50)
    setScale(p)
  }

  async function start(color: Color) {
    setCreating(color); setError('')
    try {
      const res = await fetch('/api/bot-game/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username, user_color: color, target_elo: rating, rating_scale: scale, engine, annotate,
          starting_moves: prefill.startingMoves, starting_fen: prefill.startingFen, context: prefill.context,
        }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail ?? 'Could not start the game.')
      const { game_id } = await res.json() as { game_id: string }
      navigate(`/bot-game/${game_id}`)
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not start the game.'); setCreating(null) }
  }

  const pct = ((rating - 600) / (2800 - 600)) * 100
  // the player's own rating expressed on the slider's scale
  const mine = Math.round((scale === platform ? elo : scale === 'lichess' ? chesscomToLichess(elo) : lichessToChesscom(elo)) / 50) * 50
  const quickPicks: [string, number][] = ([['Easier', mine - 200], ['My level', mine], ['Stretch', mine + 150], ['Tough', mine + 350]] as [string, number][])
    .filter(([, v]) => v >= 600 && v <= 2800)
  return (
    <div className="px-4 sm:px-6 py-6 sm:py-8 max-w-4xl mx-auto">
      <SectionHeader icon={Bot} title="Play vs Maia"
        description="A human-like opponent at the exact rating you choose — or full-strength Stockfish." />

      {(prefill.context?.name || startLine || prefill.startingFen) && (
        <div className="card p-4 mb-4 border-accent/30 flex items-start gap-3">
          <span className="w-9 h-9 rounded-lg bg-accent/10 text-accent grid place-items-center flex-shrink-0"><Target size={16} /></span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-text-0">{prefill.context?.name ?? 'Custom position'}</p>
            <p className="text-xs text-text-2 mt-0.5 font-mono truncate">{startLine ?? 'Starts from the position you chose'}</p>
          </div>
        </div>
      )}

      <div className="grid md:grid-cols-[1.3fr_1fr] gap-4">
        <div className="card p-5 space-y-5">
          <div>
            <p className="text-xs text-text-2 mb-2">Opponent</p>
            <div className="grid grid-cols-2 gap-2">
              {([['maia', 'Maia', 'Human-like', Sparkles], ['stockfish', 'Stockfish', 'Strongest', Cpu]] as const).map(([id, name, sub, Icon]) => (
                <button key={id} onClick={() => setEngine(id)}
                  className={`rounded-xl border p-3 text-left transition-colors ${engine === id ? 'border-accent bg-accent/10' : 'border-border hover:border-border-hover'}`}>
                  <Icon size={16} className={engine === id ? 'text-accent' : 'text-text-2'} />
                  <p className="text-sm font-semibold text-text-0 mt-2">{name}</p>
                  <p className="text-[11px] text-text-2">{sub}</p>
                </button>
              ))}
            </div>
          </div>

          {engine === 'maia' && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-text-2">Opponent rating</p>
                <div className="flex p-0.5 rounded-lg bg-bg-2 border border-border">
                  {(['chesscom', 'lichess'] as Platform[]).map(p => (
                    <button key={p} onClick={() => switchScale(p)} className={`px-2 py-1 rounded-md text-[11px] font-semibold ${scale === p ? 'bg-bg-3 text-accent' : 'text-text-2'}`}>{platformName(p)}</button>
                  ))}
                </div>
              </div>
              <div className="flex items-end gap-3">
                <p className="text-5xl font-semibold text-text-0 leading-none">{rating}</p>
                <p className="text-xs text-text-2 pb-1">{bothScales(rating, scale).split('≈')[1]?.trim() ? `≈ ${bothScales(rating, scale).split('≈')[1].trim()}` : ''}</p>
              </div>
              <input type="range" min={600} max={2800} step={50} value={rating} onChange={e => setRating(Number(e.target.value))}
                className="w-full mt-4 accent-[#C8FF2A]" aria-label="Opponent rating"
                style={{ background: `linear-gradient(to right, #C8FF2A ${pct}%, #1F1F1F ${pct}%)`, height: 4, borderRadius: 4 }} />
              <div className="flex justify-between text-[10px] text-text-2 mt-1"><span>600</span><span>1200</span><span>1800</span><span>2400</span><span>2800</span></div>
              <div className="flex flex-wrap gap-1.5 mt-3">
                {quickPicks.map(([label, val]) => (
                  <button key={label} onClick={() => setRating(val)}
                    className={`text-[11px] px-2 py-1 rounded-full border ${rating === val ? 'border-accent text-accent' : 'border-border text-text-1 hover:border-accent/40'}`}>{label} · {val}</button>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-xl border border-border bg-bg-2/50 p-3">
            <p className="text-sm font-semibold text-text-0 flex items-center gap-2">{lvl.name}{engine === 'maia' && <span className="text-[10px] font-normal text-text-2">plays at ≈{lichess} Lichess</span>}</p>
            <p className="text-xs text-text-2 mt-1 leading-relaxed">{lvl.detail}</p>
          </div>

          <label className="flex items-start gap-3 cursor-pointer rounded-xl border border-border p-3 hover:border-accent/30">
            <input type="checkbox" className="mt-0.5 accent-[#C8FF2A]" checked={annotate} onChange={e => setAnnotate(e.target.checked)} />
            <span>
              <span className="text-sm text-text-0 font-medium flex items-center gap-1.5"><Activity size={14} className="text-accent" />Analysed mode</span>
              <span className="block text-xs text-text-2 mt-0.5">Every move — yours and the bot's — is labelled (best, inaccuracy, blunder…) and the eval bar updates live.</span>
            </span>
          </label>
        </div>

        <div className="card p-5 flex flex-col">
          <p className="text-xs text-text-2 mb-3">Play as</p>
          <div className="grid gap-2">
            {colorOptions.map(([id, label, icon, sub]) => (
              <button key={id} onClick={() => void start(id)} disabled={creating !== null}
                className="flex items-center gap-3 rounded-xl border border-border bg-bg-1 hover:border-accent/50 hover:bg-bg-2 px-4 py-3 text-left transition-colors disabled:opacity-50">
                <span className="text-2xl w-8 text-center">{icon}</span>
                <span className="flex-1"><span className="block text-sm font-semibold text-text-0">{label}</span><span className="block text-[11px] text-text-2">{sub}</span></span>
                {creating === id ? <Loader2 size={16} className="animate-spin text-accent" /> : <ChevronRight size={16} className="text-text-2" />}
              </button>
            ))}
          </div>
          {error && <p className="text-xs text-danger mt-3">{error}</p>}
          <p className="text-[11px] text-text-2 mt-auto pt-4">Finished games are saved to Game History → Forked games, ready for a full review.</p>
        </div>
      </div>
    </div>
  )
}

// ── game ─────────────────────────────────────────────────────────────────────

function optionStyles(chess: Chess, square: Square): Record<string, React.CSSProperties> {
  const styles: Record<string, React.CSSProperties> = {}
  for (const m of chess.moves({ square, verbose: true })) {
    styles[m.to] = {
      background: chess.get(m.to as Square) ? 'radial-gradient(circle, rgba(255,77,77,0.35) 85%, transparent 85%)'
        : 'radial-gradient(circle, rgba(200,255,42,0.30) 40%, transparent 40%)', borderRadius: '50%',
    }
  }
  styles[square] = { backgroundColor: 'rgba(200,255,42,0.22)' }
  return styles
}

function GameScreen({ gameId }: { gameId: string }) {
  const navigate = useNavigate()
  const openReview = useOpenReview()
  const { username, elo } = useUserStore()
  const chessRef = useRef(new Chess())
  const [fens, setFens] = useState<string[]>([new Chess().fen()])
  const [ucis, setUcis] = useState<string[]>([])
  const [sans, setSans] = useState<string[]>([])
  const [prefillPlies, setPrefillPlies] = useState(0)
  const [userColor, setUserColor] = useState<'white' | 'black'>('white')
  const [botName, setBotName] = useState('Maia')
  const [engine, setEngine] = useState<Engine>('maia')
  const [annotate, setAnnotate] = useState(false)
  const [status, setStatus] = useState<'connecting' | 'active' | 'finished'>('connecting')
  const [conn, setConn] = useState<'connecting' | 'connected' | 'disconnected'>('connecting')
  const [thinking, setThinking] = useState(false)
  const [result, setResult] = useState<{ result: string; reason: string } | null>(null)
  const [libraryId, setLibraryId] = useState<string | null>(null)
  const [view, setView] = useState<number | null>(null)          // ply index being reviewed, null = live
  const [selectedSq, setSelectedSq] = useState<Square | null>(null)
  const [annotations, setAnnotations] = useState<Record<number, Annotation>>({})
  const [startEval, setStartEval] = useState<{ cp: number | null; mate: number | null } | null>(null)
  const [showResult, setShowResult] = useState(false)
  const [confirmResign, setConfirmResign] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [showDebrief, setShowDebrief] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const retries = useRef(0)
  const annotateRef = useRef(false)
  annotateRef.current = annotate
  const [boardRef, measured] = useElementWidth<HTMLDivElement>(560)
  const width = Math.max(240, Math.min(680, measured - (annotate ? 30 : 0)))

  const annotateMove = useCallback((ply: number, fenBefore: string, uci: string) => {
    fetch('/api/bot-game/annotate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fen: fenBefore, uci }) })
      .then(r => (r.ok ? r.json() : null))
      .then(a => { if (a) setAnnotations(prev => ({ ...prev, [ply]: a })) })
      .catch(() => undefined)
  }, [])

  const handle = useCallback((evt: MessageEvent) => {
    let msg: WsMsg
    try { msg = JSON.parse(evt.data) } catch { return }
    if (msg.type === 'game_start') {
      const c = new Chess(msg.starting_fen ?? undefined)
      const f = [c.fen()], s: string[] = [], u: string[] = []
      for (const mv of msg.moves ?? []) {
        try { const r = c.move({ from: mv.slice(0, 2), to: mv.slice(2, 4), promotion: mv[4] }); s.push(r.san); u.push(mv); f.push(c.fen()) } catch { break }
      }
      chessRef.current = c
      setFens(f); setSans(s); setUcis(u); setUserColor(msg.user_color); setBotName(msg.bot_name ?? 'Maia')
      setEngine(msg.engine ?? 'maia'); setAnnotate(!!msg.annotate); setLibraryId(msg.library_id ?? null)
      setPrefillPlies(prev => (prev || u.length))
      if (msg.status === 'finished' && msg.result) { setStatus('finished'); setResult({ result: msg.result, reason: '' }) }
      else setStatus('active')
      if (msg.annotate) {
        fetch(`/api/analyse?fen=${encodeURIComponent(c.fen())}&depth=14`).then(r => r.json()).then(a => setStartEval({ cp: a.eval_cp, mate: a.eval_mate })).catch(() => undefined)
      }
      return
    }
    if (msg.type === 'move_made') {
      const c = chessRef.current
      const before = c.fen()
      try {
        const r = c.move({ from: msg.move.slice(0, 2), to: msg.move.slice(2, 4), promotion: msg.move[4] })
        setSans(prev => { const ply = prev.length; if (annotateRef.current) annotateMove(ply, before, msg.move); return [...prev, r.san] })
        setUcis(prev => [...prev, msg.move]); setFens(prev => [...prev, c.fen()])
      } catch { /* out of sync — server is the source of truth on reconnect */ }
      if (msg.by === 'bot') setThinking(false)
      setSelectedSq(null)
      return
    }
    if (msg.type === 'thinking') { setThinking(true); return }
    if (msg.type === 'game_over') {
      setStatus('finished'); setThinking(false); setResult({ result: msg.result, reason: msg.reason })
      if (msg.library_id) setLibraryId(msg.library_id)
      setTimeout(() => setShowResult(true), 500)
    }
  }, [annotateMove])

  const connect = useCallback(() => {
    const ws = new WebSocket(wsUrl(`/ws/bot-game/${gameId}`))
    wsRef.current = ws
    setConn('connecting')
    ws.onopen = () => { setConn('connected'); retries.current = 0 }
    ws.onmessage = handle
    ws.onclose = e => {
      if (e.code === 4004) { navigate('/bot-game', { replace: true }); return }
      setConn('disconnected')
      if (retries.current < 5) { retries.current += 1; setTimeout(() => { if (wsRef.current === ws) connect() }, 2500) }
    }
  }, [gameId, handle, navigate])
  useEffect(() => {
    connect()
    return () => { const ws = wsRef.current; wsRef.current = null; if (ws) { ws.onclose = null; ws.close() } }
  }, [connect])

  const myTurn = status === 'active' && !thinking && view === null && (chessRef.current.turn() === 'w') === (userColor === 'white')
  const send = (uci: string) => { if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'move', move: uci })) }
  function tryMove(from: Square, to: Square): boolean {
    if (!myTurn) return false
    const m = chessRef.current.moves({ square: from, verbose: true }).find(x => x.to === to)
    if (!m) return false
    send(from + to + (m.promotion ? 'q' : ''))
    return false   // the server echoes the move
  }
  function onSquareClick(sq: Square) {
    if (!myTurn) return
    if (selectedSq) {
      const m = chessRef.current.moves({ square: selectedSq, verbose: true }).find(x => x.to === sq)
      if (m) { send(selectedSq + sq + (m.promotion ? 'q' : '')); setSelectedSq(null); return }
    }
    const p = chessRef.current.get(sq)
    setSelectedSq(p && p.color === chessRef.current.turn() ? sq : null)
  }

  // keyboard review
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,textarea')) return
      if (e.key === 'ArrowLeft') { e.preventDefault(); setView(v => Math.max(0, (v ?? sans.length) - 1)) }
      if (e.key === 'ArrowRight') { e.preventDefault(); setView(v => (v === null ? null : v + 1 >= sans.length ? null : v + 1)) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sans.length])

  const shownPly = view ?? sans.length               // position after `shownPly` plies
  const fen = fens[shownPly] ?? fens[fens.length - 1]
  const lastUci = shownPly > 0 ? ucis[shownPly - 1] : null
  const ann = shownPly > 0 ? annotations[shownPly - 1] : null
  const evalNow = ann ? { cp: ann.white_cp, mate: ann.white_mate } : shownPly === prefillPlies ? startEval : null
  const styles: Record<string, React.CSSProperties> = {}
  if (lastUci) { styles[lastUci.slice(0, 2)] = { backgroundColor: 'rgba(200,255,42,0.22)' }; styles[lastUci.slice(2, 4)] = { backgroundColor: 'rgba(200,255,42,0.32)' } }
  if (selectedSq && view === null) Object.assign(styles, optionStyles(chessRef.current, selectedSq))
  const viewChess = useMemo(() => new Chess(fen), [fen])
  if (viewChess.inCheck()) {
    const k = viewChess.findPiece({ type: 'k', color: viewChess.turn() })[0]
    if (k) styles[k] = { ...styles[k], background: 'radial-gradient(circle, rgba(255,77,94,0.65) 30%, transparent 75%)' }
  }
  const arrows: Arrow[] = annotate && ann && ann.best_uci && ann.best_uci !== ucis[shownPly - 1] && ['inaccuracy', 'mistake', 'blunder', 'miss'].includes(ann.classification)
    ? [[ann.best_uci.slice(0, 2) as Square, ann.best_uci.slice(2, 4) as Square, 'rgba(158,203,118,0.85)']] : []

  const userWon = result && ((result.result === '1-0' && userColor === 'white') || (result.result === '0-1' && userColor === 'black'))
  const drew = result?.result === '1/2-1/2'

  async function reviewGame() {
    setReviewing(true)
    try {
      if (libraryId) {
        const { game } = await libraryApi.game(username, libraryId)
        await openReview({ pgn: game.pgn!, source: game.source, user_color: userColor })
      } else {
        const c = new Chess(fens[0])
        for (const s of sans) c.move(s)
        c.setHeader('White', userColor === 'white' ? username : botName); c.setHeader('Black', userColor === 'black' ? username : botName)
        if (result) c.setHeader('Result', result.result)
        await openReview({ pgn: c.pgn(), source: 'maia', user_color: userColor })
      }
    } finally { setReviewing(false) }
  }
  function analyseGame() {
    const c = new Chess(fens[0])
    for (const s of sans) c.move(s)
    navigate('/analysis', { state: { pgn: c.pgn(), title: `You vs ${botName}`, ply: view ?? undefined } })
  }

  return (
    <div className="px-3 sm:px-4 lg:px-6 py-4 sm:py-6 max-w-[1400px] mx-auto">
      <SectionHeader icon={Bot} title="Play vs Maia" description={`${botName}${annotate ? ' · analysed mode' : ''} · arrows ← → to look back`}
        right={<span className="inline-flex items-center gap-1.5 text-xs text-text-2">{conn === 'connected' ? <Wifi size={13} className="text-success" /> : <WifiOff size={13} className="text-danger" />}{conn === 'connected' ? 'Connected' : conn === 'connecting' ? 'Connecting…' : 'Reconnecting…'}</span>} />

      <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(300px,400px)] gap-5 lg:gap-6">
        <section className="min-w-0">
          <div ref={boardRef} className="mx-auto w-full" style={{ maxWidth: 720 }}>
            <PlayerStrip icon={engine === 'stockfish' ? Cpu : Bot} name={botName} right={thinking ? <span className="text-xs text-accent inline-flex items-center gap-1.5">thinking <Loader2 size={12} className="animate-spin" /></span> : null} />
            <div className="flex gap-2 items-stretch my-2">
              {annotate && (
                <div className={`w-5 rounded overflow-hidden flex flex-shrink-0 relative ${userColor === 'black' ? 'flex-col' : 'flex-col-reverse'}`} style={{ height: width }}>
                  <div className="bg-[#F0F0F0] transition-all duration-500" style={{ height: `${evalNow ? whiteShare(evalNow.cp, evalNow.mate) : 50}%` }} />
                  <div className="bg-bg-3 flex-1" />
                  <span className="absolute inset-x-0 bottom-1 text-center text-[9px] font-bold text-bg-0 mix-blend-difference">{evalNow ? evalText(evalNow.cp, evalNow.mate) : '…'}</span>
                </div>
              )}
              <motion.div animate={{ boxShadow: myTurn ? '0 0 0 2px rgba(200,255,42,0.45)' : '0 0 0 0 rgba(0,0,0,0)' }} style={{ borderRadius: 8 }}>
                <Chessboard id="bot-board" position={fen} boardOrientation={userColor} boardWidth={width}
                  arePiecesDraggable={myTurn} onPieceDrop={(f, t) => tryMove(f as Square, t as Square)} onSquareClick={onSquareClick}
                  customSquareStyles={styles} customArrows={arrows}
                  customDarkSquareStyle={{ backgroundColor: BOARD_DARK }} customLightSquareStyle={{ backgroundColor: BOARD_LIGHT }}
                  customBoardStyle={{ borderRadius: 8, boxShadow: '0 0 0 1px rgba(200,255,42,0.15)' }} />
              </motion.div>
            </div>
            <PlayerStrip icon={User} name={`${username}${elo ? ` · ${elo}` : ''}`} right={myTurn ? <span className="text-xs text-success font-medium">Your move</span> : null} />
            {view !== null && (
              <div className="mt-2 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-accent/10 border border-accent/20 text-xs">
                <span className="text-accent">Viewing {shownPly ? `after ${moveLabel(fens[shownPly - 1])} ${sans[shownPly - 1]}` : 'the start'}</span>
                <button onClick={() => setView(null)} className="ml-auto text-accent underline">Back to live</button>
              </div>
            )}
          </div>
        </section>

        <section className="min-w-0 space-y-3">
          {annotate && (
            <div className="card p-4 min-h-[92px]">
              {ann ? (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-base font-semibold">{moveLabel(fens[shownPly - 1])} {ann.san}</span>
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold" style={{ color: CLASSIFICATION[ann.classification].color }}>
                      <span className="w-5 h-5 rounded-full grid place-items-center text-[10px] font-bold" style={{ background: CLASSIFICATION[ann.classification].color + '22' }}>{CLASSIFICATION[ann.classification].symbol}</span>
                      {CLASSIFICATION[ann.classification].label}
                    </span>
                  </div>
                  <p className="text-xs text-text-2 mt-2">
                    {ann.best_san && ann.best_san !== ann.san ? <>Best was <span className="font-mono text-success">{ann.best_san}</span> · </> : null}
                    eval {evalText(ann.white_cp, ann.white_mate)} (White's view)
                  </p>
                </>
              ) : <p className="text-xs text-text-2">{shownPly > prefillPlies ? 'Labelling the move…' : 'Every move will be labelled here as you play.'}</p>}
            </div>
          )}

          <div className="card p-4">
            <p className="text-xs text-text-2 uppercase tracking-wider font-semibold mb-2">Moves</p>
            <MoveGrid sans={sans} annotations={annotate ? annotations : {}} current={shownPly - 1} prefill={prefillPlies}
              startFen={fens[0]} onSelect={i => setView(i + 1 >= sans.length ? null : i + 1)} />
            <div className="flex justify-center gap-1 mt-2">
              <button className="btn-ghost px-2" onClick={() => setView(v => Math.max(0, (v ?? sans.length) - 1))} aria-label="Back"><ChevronLeft size={16} /></button>
              <button className="btn-ghost px-2" onClick={() => setView(v => (v === null ? null : v + 1 >= sans.length ? null : v + 1))} aria-label="Forward"><ChevronRight size={16} /></button>
            </div>
          </div>

          {status === 'active' && (
            confirmResign ? (
              <div className="card p-3 border-danger/30 flex items-center gap-2">
                <span className="text-sm flex-1">Resign this game?</span>
                <button className="btn-danger text-xs" onClick={() => { wsRef.current?.send(JSON.stringify({ type: 'resign' })); setConfirmResign(false) }}>Resign</button>
                <button className="btn-ghost text-xs" onClick={() => setConfirmResign(false)}>Cancel</button>
              </div>
            ) : (
              <button onClick={() => setConfirmResign(true)} className="text-sm text-text-2 hover:text-danger inline-flex items-center gap-1.5"><Flag size={13} />Resign</button>
            )
          )}

          {status === 'finished' && result && (
            <div className="card p-4 space-y-3">
              <p className={`text-lg font-semibold ${drew ? 'text-text-0' : userWon ? 'text-success' : 'text-danger'}`}>{drew ? 'Draw' : userWon ? 'You won' : `${botName} won`} <span className="text-xs font-normal text-text-2">{RESULT_REASON[result.reason] ?? ''}</span></p>
              <button onClick={() => void reviewGame()} disabled={reviewing} className="btn-primary w-full inline-flex items-center justify-center gap-2">
                {reviewing ? <Loader2 size={15} className="animate-spin" /> : <ScanSearch size={15} />}Game review
              </button>
              <div className="grid grid-cols-2 gap-2">
                <button onClick={analyseGame} className="btn-ghost border border-border text-sm inline-flex items-center justify-center gap-1.5"><Microscope size={14} />Analyse</button>
                <button onClick={() => navigate('/bot-game')} className="btn-ghost border border-border text-sm inline-flex items-center justify-center gap-1.5"><RotateCcw size={14} />New game</button>
              </div>
              <button onClick={() => setShowDebrief(d => !d)} className="text-xs text-accent">{showDebrief ? 'Hide' : 'Show'} blindspot debrief</button>
              {showDebrief && <BotGameDebrief gameId={gameId} username={username} />}
            </div>
          )}
        </section>
      </div>

      <AnimatePresence>
        {showResult && result && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/60 z-50 grid place-items-center p-4" onClick={() => setShowResult(false)}>
            <motion.div initial={{ scale: .92, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} onClick={e => e.stopPropagation()}
              className="card p-7 w-full max-w-sm text-center relative">
              <button onClick={() => setShowResult(false)} className="absolute right-3 top-3 text-text-2 hover:text-text-0" aria-label="Close"><X size={16} /></button>
              <p className={`text-3xl font-semibold ${drew ? 'text-text-0' : userWon ? 'text-success' : 'text-danger'}`}>{drew ? 'Draw' : userWon ? 'You won!' : `${botName} won`}</p>
              <p className="text-sm text-text-2 mt-1">{RESULT_REASON[result.reason] ?? ''}</p>
              <div className="grid gap-2 mt-6">
                <button onClick={() => void reviewGame()} disabled={reviewing} className="btn-primary inline-flex items-center justify-center gap-2 py-2.5">
                  {reviewing ? <Loader2 size={15} className="animate-spin" /> : <ScanSearch size={15} />}Game review
                </button>
                <button onClick={() => { setShowResult(false); analyseGame() }} className="btn-ghost border border-border inline-flex items-center justify-center gap-2"><Microscope size={14} />Analysis board</button>
                <button onClick={() => navigate('/bot-game')} className="btn-ghost inline-flex items-center justify-center gap-2"><RotateCcw size={14} />Play again</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function PlayerStrip({ icon: Icon, name, right }: { icon: typeof Bot; name: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-1">
      <Icon size={15} className="text-text-2" />
      <span className="text-sm font-medium text-text-0 truncate">{name}</span>
      <span className="ml-auto">{right}</span>
    </div>
  )
}

/** "12." for White's move from this position, "12…" for Black's. */
function moveLabel(fenBefore?: string): string {
  if (!fenBefore) return ''
  const [, turn, , , , full] = fenBefore.split(' ')
  return `${full}${turn === 'w' ? '.' : '…'}`
}

function MoveGrid({ sans, annotations, current, prefill, startFen, onSelect }: {
  sans: string[]; annotations: Record<number, Annotation>; current: number; prefill: number; startFen: string; onSelect: (i: number) => void
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => { const b = boxRef.current; if (b) b.scrollTop = b.scrollHeight }, [sans.length])
  if (!sans.length) return <p className="text-xs text-text-2 italic">No moves yet.</p>
  const [, turn, , , , full] = startFen.split(' ')
  const offset = turn === 'b' ? 1 : 0           // Black to move first: leave White's cell empty
  const firstNo = Number(full) || 1
  const rows: number[] = []
  for (let i = -offset; i < sans.length; i += 2) rows.push(i)
  const cell = (i: number) => {
    if (i < 0 || i >= sans.length) return <span />
    const a = annotations[i]
    const spec = a ? CLASSIFICATION[a.classification] : null
    return (
      <button onClick={() => onSelect(i)}
        className={`flex items-center justify-between px-2 py-1 rounded text-sm font-mono ${current === i ? 'bg-accent/20 text-text-0' : 'hover:bg-bg-2'} ${i < prefill ? 'text-text-2' : 'text-text-0'}`}>
        <span>{sans[i]}</span>
        {spec && <span className="text-[10px] font-bold" style={{ color: spec.color }} title={spec.label}>{spec.symbol}</span>}
      </button>
    )
  }
  return (
    <div ref={boxRef} className="max-h-72 overflow-y-auto">
      {rows.map((i, r) => (
        <div key={i} className="grid grid-cols-[2rem_1fr_1fr] gap-1 items-center">
          <span className="text-[11px] text-text-2 tabular-nums">{firstNo + r}.</span>{cell(i)}{cell(i + 1)}
        </div>
      ))}
      {prefill > 0 && <p className="text-[10px] text-text-2 mt-1">Grey moves were set up before the game started.</p>}
    </div>
  )
}

export default function BotGame() {
  const { gameId } = useParams<{ gameId?: string }>()
  const location = useLocation()
  const prefill = (location.state ?? {}) as Prefill
  if (gameId) return <GameScreen key={gameId} gameId={gameId} />
  return <SetupScreen prefill={prefill} />
}
