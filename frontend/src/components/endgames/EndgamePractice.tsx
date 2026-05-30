import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Chess } from 'chess.js'
import { Chessboard } from 'react-chessboard'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Bot, User, Flag, RotateCcw, Wifi, WifiOff, ShieldCheck, Loader2,
  Trophy, X as XIcon, MessageSquare, Shuffle, Settings2, Eye,
} from 'lucide-react'
import { useUserStore } from '../../store/userStore'
import { endgamesApi } from '../../api/endgames'
import type { EndgameLeaf } from '../../data/endgameTree'
import { PieceConfigurator, type ConfigPayload } from './PieceConfigurator'
import { useGameReview } from '../../hooks/useGameReview'

const BOARD_SIZE  = 460
const ELO_OPTIONS = [1100, 1300, 1500, 1700, 1900]

interface Props {
  forcedPosition: EndgameLeaf | null
  onAskCoach: (fen: string, category: string, description: string) => void
}

type WsMsg =
  | { type: 'game_start'; fen: string; user_color: 'white' | 'black'; target_elo: number }
  | { type: 'move_made';  move: string; fen: string; by: 'user' | 'bot' }
  | { type: 'thinking' }
  | { type: 'game_over';  result: string; reason: string }
  | { type: 'error';      message: string }

type GameStatus = 'configure' | 'ready' | 'connecting' | 'active' | 'finished'

interface ActivePosition {
  fen:          string
  description:  string
  material:     string
  source:       string
  evalCp:       number | null
  complexity?:  string
  syzygyResult: string | null
  sideToMove:   'white' | 'black'
  objective:    string
  category:     string
}

function pickClosestMaiaElo(userElo: number): number {
  return ELO_OPTIONS.reduce((c, e) =>
    Math.abs(e - userElo) < Math.abs(c - userElo) ? e : c, ELO_OPTIONS[0])
}

function uciToFrom(uci: string) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promo: uci[4] as string | undefined }
}

function deriveObjective(syzygy: string | null, evalCp: number | null, stm: 'white' | 'black'): string {
  if (syzygy) {
    if (syzygy === 'draw') return 'draw'
    const stmWins  = syzygy === 'win'  || syzygy === 'cursed-win'
    const stmLoses = syzygy === 'loss' || syzygy === 'blessed-loss'
    if (stmWins)  return stm === 'white' ? 'win_white' : 'win_black'
    if (stmLoses) return stm === 'white' ? 'win_black' : 'win_white'
  }
  if (evalCp === null) return 'depends'
  if (evalCp >  150) return 'win_white'
  if (evalCp < -150) return 'win_black'
  return 'draw'
}

function objectiveSummary(objective: string, stm: 'white' | 'black'): string {
  if (objective === 'draw')      return `${stm} to play — hold the draw`
  if (objective === 'win_white') return stm === 'white' ? `${stm} to play — win` : `${stm} to play — defend`
  if (objective === 'win_black') return stm === 'black' ? `${stm} to play — win` : `${stm} to play — defend`
  return `${stm} to play — outplay your opponent`
}

// ── Component ────────────────────────────────────────────────────────────────

export function EndgamePractice({ forcedPosition, onAskCoach }: Props) {
  const { username, elo: userElo } = useUserStore()

  const [maiaElo,   setMaiaElo]   = useState(pickClosestMaiaElo(userElo || 1500))
  const [position,  setPosition]  = useState<ActivePosition | null>(null)
  const [status,    setStatus]    = useState<GameStatus>('configure')
  const [loading,   setLoading]   = useState(false)
  const [loadErr,   setLoadErr]   = useState<string | null>(null)
  const [seenFens,  setSeenFens]  = useState<string[]>([])
  const lastConfig = useRef<ConfigPayload | null>(null)

  const fetchByConfig = useCallback(async (cfg: ConfigPayload, exclude: string[]) => {
    setLoading(true); setLoadErr(null)
    try {
      const r = await endgamesApi.practicePositionByConfig({
        white_pieces: cfg.white,
        black_pieces: cfg.black,
        description:  cfg.description,
        exclude_fens: exclude,
        maia_elo:     cfg.maiaElo,
      })
      const stm = r.side_to_move === 'black' ? 'black' : 'white'
      setPosition({
        fen:          r.fen,
        description:  r.description,
        material:     r.material,
        source:       r.source,
        evalCp:       r.eval_cp,
        complexity:   r.complexity,
        syzygyResult: r.syzygy_result,
        sideToMove:   stm,
        objective:    deriveObjective(r.syzygy_result, r.eval_cp, stm),
        category:     'custom',
      })
      setMaiaElo(cfg.maiaElo)
      setSeenFens(prev => [...prev, r.fen])
      setStatus('ready')
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : 'Failed to find a position')
    } finally {
      setLoading(false)
    }
  }, [])

  const handleFind = useCallback((cfg: ConfigPayload) => {
    lastConfig.current = cfg
    setSeenFens([])
    fetchByConfig(cfg, [])
  }, [fetchByConfig])

  const handleShuffle = useCallback(() => {
    if (!lastConfig.current) return
    fetchByConfig(lastConfig.current, seenFens)
  }, [fetchByConfig, seenFens])

  // Forced position from the Theory tab
  useEffect(() => {
    if (!forcedPosition) return
    const stm = forcedPosition.fen.split(' ')[1] === 'b' ? 'black' : 'white'
    const obj = forcedPosition.result === 'white_wins' ? 'win_white'
              : forcedPosition.result === 'black_wins' ? 'win_black'
              : forcedPosition.result === 'draw'       ? 'draw' : 'depends'
    setPosition({
      fen:          forcedPosition.fen,
      description:  forcedPosition.title + (forcedPosition.summary ? ` — ${forcedPosition.summary}` : ''),
      material:     forcedPosition.title,
      source:       'theory',
      evalCp:       null,
      syzygyResult: null,
      sideToMove:   stm,
      objective:    obj,
      category:     forcedPosition.category,
    })
    lastConfig.current = null
    setStatus('ready')
  }, [forcedPosition])

  // ── Game state ─────────────────────────────────────────────────────────────
  const chessRef = useRef(new Chess())
  const [fen,        setFen]        = useState<string>('')
  const [sanMoves,   setSanMoves]   = useState<string[]>([])
  const [userColor,  setUserColor]  = useState<'white' | 'black'>('white')
  const [isThinking, setIsThinking] = useState(false)
  const [gameResult, setGameResult] = useState<string | null>(null)
  const [connError,  setConnError]  = useState<string | null>(null)

  const [selectedSq,  setSelectedSq]  = useState<string | null>(null)
  const [optionSqs,   setOptionSqs]   = useState<Record<string, object>>({})
  const [lastMoveSqs, setLastMoveSqs] = useState<Record<string, object>>({})

  const wsRef        = useRef<WebSocket | null>(null)
  const userColorRef = useRef<'white' | 'black'>('white')
  useEffect(() => { userColorRef.current = userColor }, [userColor])

  const baseFen = position?.fen ?? ''
  const review  = useGameReview({
    baseFen, sanMoves, liveFen: fen || baseFen,
    enableKeyboard: status === 'active' || status === 'finished',
  })

  const startGame = useCallback(async () => {
    if (!position || !username) return
    setStatus('connecting'); setConnError(null)
    setGameResult(null); setSanMoves([]); setLastMoveSqs({}); setSelectedSq(null); setOptionSqs({})
    try {
      const res = await fetch('/api/bot-game/create', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          username, user_color: 'random',
          starting_fen: position.fen, target_elo: maiaElo,
        }),
      })
      if (!res.ok) throw new Error(await res.text())
      const { game_id, user_color } = await res.json() as
        { game_id: string; user_color: 'white' | 'black' }
      setUserColor(user_color)
      chessRef.current = new Chess(position.fen)
      setFen(position.fen)
      const ws = new WebSocket(`ws://localhost:8000/ws/bot-game/${game_id}`)
      wsRef.current = ws
      ws.onmessage = (evt) => handleWsMessage(evt.data)
      ws.onerror   = () => { setConnError('Connection error'); setStatus('ready') }
    } catch (e) {
      setConnError(e instanceof Error ? e.message : 'Failed to start game')
      setStatus('ready')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position, username, maiaElo])

  function handleWsMessage(raw: string) {
    let msg: WsMsg
    try { msg = JSON.parse(raw) } catch { return }
    switch (msg.type) {
      case 'game_start': setStatus('active'); setIsThinking(false); break
      case 'move_made': {
        const { from, to, promo } = uciToFrom(msg.move)
        try {
          const r = chessRef.current.move({ from, to, promotion: promo ?? 'q' })
          if (r) setSanMoves(prev => [...prev, r.san])
        } catch { /* ignore */ }
        setFen(msg.fen)
        setLastMoveSqs({
          [from]: { backgroundColor: 'rgba(123,97,255,0.22)' },
          [to]:   { backgroundColor: 'rgba(123,97,255,0.32)' },
        })
        setSelectedSq(null); setOptionSqs({})
        if (msg.by === 'bot') setIsThinking(false)
        break
      }
      case 'thinking':  setIsThinking(true); break
      case 'game_over': setStatus('finished'); setGameResult(msg.result); setIsThinking(false); break
      case 'error':     console.warn('[EndgamePractice]', msg.message); break
    }
  }

  useEffect(() => () => { wsRef.current?.close() }, [])

  useEffect(() => {
    if (position && status === 'ready') {
      wsRef.current?.close()
      chessRef.current = new Chess(position.fen)
      setFen(position.fen)
      setSanMoves([]); setLastMoveSqs({}); setGameResult(null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position?.fen])

  // ── Outcome verdict ────────────────────────────────────────────────────────
  const outcome = useMemo(() => {
    if (status !== 'finished' || !position || !gameResult) return null
    const userIsWhite = userColor === 'white'
    const userWon  = (gameResult === '1-0' && userIsWhite) || (gameResult === '0-1' && !userIsWhite)
    const userLost = (gameResult === '0-1' && userIsWhite) || (gameResult === '1-0' && !userIsWhite)
    const drew     = gameResult === '1/2-1/2'
    const obj = position.objective
    const wantUserWin  = (obj === 'win_white' && userIsWhite) || (obj === 'win_black' && !userIsWhite)
    const wantUserLoss = (obj === 'win_white' && !userIsWhite) || (obj === 'win_black' && userIsWhite)
    const wantDraw = obj === 'draw'

    if (obj === 'depends')
      return { ok: true, label: 'Practice complete', sub: 'Review the line and try a variation.' }
    if (wantUserWin && userWon)   return { ok: true,  label: 'Correct!', sub: 'You converted the theoretical win.' }
    if (wantUserWin && drew)      return { ok: false, label: 'You drew a winning position', sub: 'This is a win for you — try again.' }
    if (wantUserWin && userLost)  return { ok: false, label: 'You lost a winning position', sub: 'This is a win for you — try again.' }
    if (wantDraw && drew)         return { ok: true,  label: 'Correct draw!', sub: 'You held the theoretical draw.' }
    if (wantDraw && userWon)      return { ok: true,  label: 'Even better — you won!', sub: 'The position is a theoretical draw; Maia slipped.' }
    if (wantDraw && userLost)     return { ok: false, label: 'You lost a drawn position', sub: 'This should be a draw — try the correct defence.' }
    if (wantUserLoss && drew)     return { ok: true,  label: 'Heroic save!', sub: 'You drew a theoretically lost position.' }
    if (wantUserLoss && userWon)  return { ok: true,  label: 'Upset win!', sub: 'You won a position theory calls lost for you.' }
    if (wantUserLoss && userLost) return { ok: false, label: 'Lost as expected', sub: 'A tough hold — study the defensive idea.' }
    return null
  }, [status, position, gameResult, userColor])

  // ── Board interaction ──────────────────────────────────────────────────────
  const isMyTurn = useCallback(() => {
    if (status !== 'active' || isThinking || review.isReviewing) return false
    return (chessRef.current.turn() === 'w') === (userColorRef.current === 'white')
  }, [status, isThinking, review.isReviewing])

  function sendMove(uci: string) {
    if (wsRef.current?.readyState === WebSocket.OPEN)
      wsRef.current.send(JSON.stringify({ type: 'move', move: uci }))
  }

  function handleDrop(from: string, to: string): boolean {
    if (!isMyTurn()) return false
    const p = chessRef.current.get(from as any)
    const promo = p?.type === 'p' && ((p.color === 'w' && to[1] === '8') || (p.color === 'b' && to[1] === '1'))
    if (!chessRef.current.moves({ verbose: true }).some((m: any) => m.from === from && m.to === to)) return false
    sendMove(from + to + (promo ? 'q' : ''))
    return false
  }

  function handleSquareClick(sq: string) {
    if (!isMyTurn()) return
    if (selectedSq && optionSqs[sq] !== undefined) {
      const p = chessRef.current.get(selectedSq as any)
      const promo = p?.type === 'p' && ((p.color === 'w' && sq[1] === '8') || (p.color === 'b' && sq[1] === '1'))
      sendMove(selectedSq + sq + (promo ? 'q' : ''))
      setSelectedSq(null); setOptionSqs({}); return
    }
    const piece = chessRef.current.get(sq as any)
    if (piece && piece.color === chessRef.current.turn()) {
      setSelectedSq(sq)
      const styles: Record<string, object> = {}
      chessRef.current.moves({ square: sq as any, verbose: true }).forEach((m: any) => {
        styles[m.to] = {
          background: chessRef.current.get(m.to)
            ? 'radial-gradient(circle, rgba(255,77,77,0.35) 85%, transparent 85%)'
            : 'radial-gradient(circle, rgba(123,97,255,0.30) 40%, transparent 40%)',
          borderRadius: '50%',
        }
      })
      styles[sq] = { backgroundColor: 'rgba(123,97,255,0.22)' }
      setOptionSqs(styles)
    } else {
      setSelectedSq(null); setOptionSqs({})
    }
  }

  function handleResign() {
    if (wsRef.current?.readyState === WebSocket.OPEN)
      wsRef.current.send(JSON.stringify({ type: 'resign' }))
  }

  function reconfigure() {
    wsRef.current?.close()
    setStatus('configure')
    setPosition(null)
    setGameResult(null); setSanMoves([])
  }

  const squareStyles = useMemo(
    () => review.isReviewing ? {} : { ...lastMoveSqs, ...optionSqs },
    [review.isReviewing, lastMoveSqs, optionSqs],
  )

  // ── Render: configure ──────────────────────────────────────────────────────
  if (status === 'configure') {
    return (
      <div className="max-w-2xl mx-auto space-y-3">
        <PieceConfigurator onFind={handleFind} loading={loading} />
        {loadErr && <p className="text-xs text-danger text-center">{loadErr}</p>}
      </div>
    )
  }

  // ── Render: ready / active / finished ──────────────────────────────────────
  return (
    <div className="space-y-4">
      <div className="card px-4 py-2.5 flex items-center gap-3 flex-wrap">
        <span className="text-sm text-text-0 font-medium">✓ {position?.material}</span>
        <span className="text-text-2 text-xs">·</span>
        <span className="text-xs text-text-1">Maia {maiaElo}</span>
        {position?.complexity === 'high' && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent border border-accent/30">
            complex
          </span>
        )}
        <button onClick={reconfigure} className="ml-auto btn-ghost flex items-center gap-1.5 text-xs">
          <Settings2 size={12} /> Reconfigure
        </button>
      </div>

      <div className="flex flex-col xl:flex-row items-start gap-6">
        {/* Board */}
        <div className="flex-shrink-0 space-y-2">
          <div className="flex items-center gap-2 px-1">
            <Bot size={15} className="text-text-2" />
            <span className="text-sm font-medium text-text-0">Maia · {maiaElo}</span>
            {isThinking && (
              <span className="text-xs text-accent inline-flex items-center gap-1 ml-auto">
                thinking <Loader2 size={11} className="animate-spin" />
              </span>
            )}
          </div>

          <AnimatePresence>
            {review.isReviewing && (
              <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
                className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-accent/10 border border-accent/20 text-xs">
                <Eye size={12} className="text-accent" />
                <span className="text-accent">Reviewing move {(review.viewingIndex ?? 0) + 1}</span>
                <button onClick={review.backToLive} className="ml-auto text-accent underline hover:no-underline">
                  ✕ Back to live
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          <Chessboard
            position={review.displayFen || position?.fen || 'start'}
            boardOrientation={userColor}
            onPieceDrop={handleDrop}
            onSquareClick={handleSquareClick}
            arePiecesDraggable={isMyTurn()}
            boardWidth={BOARD_SIZE}
            customSquareStyles={squareStyles}
            customDarkSquareStyle={{ backgroundColor: '#1A1D36' }}
            customLightSquareStyle={{ backgroundColor: '#343761' }}
            customBoardStyle={{ borderRadius: '6px', boxShadow: '0 0 0 1px rgba(123,97,255,0.15)' }}
          />

          <div className="flex items-center gap-2 px-1">
            <User size={15} className="text-accent" />
            <span className="text-sm font-medium text-text-0">{username} · {userElo ?? '?'}</span>
            {isMyTurn() && <span className="ml-auto text-xs text-success font-medium">Your turn</span>}
          </div>
        </div>

        {/* Side panel */}
        <div className="flex-1 min-w-0 w-full space-y-3">
          {position && (
            <div className="card p-4 space-y-2.5">
              <p className="text-xs text-text-2 uppercase tracking-wider font-semibold">Position</p>
              <p className="text-sm text-text-0 leading-snug">{position.description}</p>
              <div className="flex items-center gap-2 text-[10px] text-text-2 flex-wrap">
                <span className="px-1.5 py-0.5 rounded bg-bg-2 border border-border">{position.material}</span>
                <span>{objectiveSummary(position.objective, position.sideToMove)}</span>
                {position.source !== 'theory' && (
                  <span className="px-1.5 py-0.5 rounded bg-bg-2 border border-border">
                    {position.source === 'puzzle_db' ? 'from real games' : 'engine-curated'}
                  </span>
                )}
              </div>
              {position.syzygyResult && (
                <div className="flex items-center gap-1.5 text-[10px] pt-1">
                  <ShieldCheck size={11} className="text-success" />
                  <span className="text-success font-medium">Syzygy: {position.syzygyResult}</span>
                </div>
              )}
            </div>
          )}

          {status === 'ready' && (
            <div className="flex gap-2">
              <button onClick={startGame} disabled={!username}
                className="btn-primary flex-1 flex items-center justify-center gap-1.5 text-sm disabled:opacity-40">
                <Wifi size={13} /> Start
              </button>
              {lastConfig.current && (
                <button onClick={handleShuffle} disabled={loading}
                  className="btn-ghost flex items-center justify-center gap-1.5 text-sm px-3 disabled:opacity-40">
                  {loading ? <Loader2 size={13} className="animate-spin" /> : <Shuffle size={13} />} Shuffle
                </button>
              )}
            </div>
          )}

          {status === 'active' && (
            <div className="flex gap-2">
              <button onClick={handleResign}
                className="btn-ghost flex-1 flex items-center justify-center gap-1.5 text-sm">
                <Flag size={13} /> Resign
              </button>
              {position && (
                <button onClick={() => onAskCoach(position.fen, position.category, position.description)}
                  className="btn-ghost flex-1 flex items-center justify-center gap-1.5 text-sm">
                  <MessageSquare size={13} /> Ask coach
                </button>
              )}
            </div>
          )}

          {status === 'connecting' && (
            <div className="card p-3 flex items-center gap-2 text-xs text-text-2">
              <Loader2 size={11} className="animate-spin text-accent" /> Connecting to engine…
            </div>
          )}
          {connError && (
            <div className="card border border-danger/30 bg-danger/10 p-3 text-xs text-danger flex items-center gap-2">
              <WifiOff size={12} /> {connError}
            </div>
          )}

          {sanMoves.length > 0 && (
            <div className="card p-3">
              <p className="text-[10px] text-text-2 uppercase tracking-wider font-semibold mb-2">
                Moves <span className="normal-case font-normal">· click or ← → to review</span>
              </p>
              <div className="font-mono text-xs leading-relaxed max-h-44 overflow-y-auto flex flex-wrap gap-x-1 gap-y-0.5">
                {sanMoves.map((s, i) => (
                  <button key={i} onClick={() => review.goToMove(i)}
                    className={`px-1 rounded transition-colors
                      ${review.highlightIndex === i
                        ? 'bg-accent/25 text-accent font-semibold'
                        : 'text-text-1 hover:bg-bg-2'}`}>
                    {i % 2 === 0 && <span className="text-text-2 mr-0.5">{Math.floor(i / 2) + 1}.</span>}{s}
                  </button>
                ))}
              </div>
            </div>
          )}

          <AnimatePresence>
            {status === 'finished' && outcome && (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                className={`card p-4 border ${outcome.ok ? 'border-success/40 bg-success/10' : 'border-danger/40 bg-danger/10'} space-y-2.5`}>
                <div className="flex items-center gap-2">
                  {outcome.ok ? <Trophy size={16} className="text-success" /> : <XIcon size={16} className="text-danger" />}
                  <p className={`text-sm font-bold ${outcome.ok ? 'text-success' : 'text-danger'}`}>{outcome.label}</p>
                </div>
                <p className="text-xs text-text-1">{outcome.sub}</p>
                <div className="flex gap-2 pt-1">
                  <button onClick={startGame}
                    className="btn-primary flex-1 flex items-center justify-center gap-1.5 text-sm">
                    <RotateCcw size={12} /> Replay
                  </button>
                  {lastConfig.current && (
                    <button onClick={handleShuffle}
                      className="btn-ghost flex-1 flex items-center justify-center gap-1.5 text-sm">
                      <Shuffle size={12} /> New position
                    </button>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}
