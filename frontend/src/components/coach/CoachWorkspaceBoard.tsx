import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Chessboard } from 'react-chessboard'
import type { Arrow } from 'react-chessboard/dist/chessboard/types'
import { Chess, type Square } from 'chess.js'
import { useQuery } from '@tanstack/react-query'
import {
  ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, FlipVertical2, RotateCcw, Undo2, Swords,
  Square as StopIcon, ClipboardPaste, Copy, Check, X, Lightbulb, Eye, Puzzle, Sparkles, LayoutGrid,
} from 'lucide-react'
import { coachApi, type BoardArrowEvent, type CoachStreamEvent, type GameMoment, type PuzzlePayload } from '../../api/coach'
import { ARROW_ALT, ARROW_BEST, ARROW_THREAT, BOARD_DARK, BOARD_LIGHT, HINT_SQUARE, LAST_MOVE, NEON_RGB, PUZZLE_WRONG } from '../../theme'
import { useBoardPublisher } from '../../features/share-screen/boardLink'

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
export const MAIA_MIN = 1100
export const MAIA_MAX = 1900   // Maia2's strongest setting
const MAIA_KEY = 'forked-maia-elo'
const MAX_TABS = 7

export function loadMaiaElo(): number {
  try {
    const v = Number(localStorage.getItem(MAIA_KEY))
    return v >= MAIA_MIN && v <= MAIA_MAX ? v : MAIA_MAX
  } catch { return MAIA_MAX }
}
function saveMaiaElo(v: number) { try { localStorage.setItem(MAIA_KEY, String(v)) } catch { /* private mode */ } }

export interface BoardLine {
  rootFen: string
  sans: string[]
  fens: string[]          // fens[0] === rootFen; fens[i] = after i moves
  label: string
  kind: 'user' | 'coach' | 'game'
}

export interface PuzzleState {
  id: string
  rating?: number
  themes?: string
  line: string[]          // Lichess solution in UCI; index 0 is the setup move (already on the board)
  next: number            // index of the move the user must find
  status: 'solving' | 'wrong' | 'solved'
  hint: boolean
  revealed: boolean
}

export interface CoachBoardState {
  line: BoardLine
  ply: number
  saved: { line: BoardLine; ply: number } | null   // the user's own board while a coach line is shown
  gamePgn?: string
  moments?: GameMoment[]
  play?: { userColor: 'white' | 'black'; elo: number }
  puzzle?: PuzzleState
  arrows?: { fen: string; arrows: BoardArrowEvent[] }
  offer?: ('play' | 'explain')[]
}

export type TabKind = 'board' | 'puzzle' | 'position' | 'game' | 'play'
export interface BoardTab { id: string; title: string; kind: TabKind; state: CoachBoardState }

function userLine(fen: string, label = 'Your board'): BoardLine {
  return { rootFen: fen, sans: [], fens: [fen], label, kind: 'user' }
}
function fresh(fen: string, label = 'Your board'): CoachBoardState {
  return { line: userLine(fen, label), ply: 0, saved: null }
}
const sameSpot = (a: string, b: string) => a.split(' ').slice(0, 4).join(' ') === b.split(' ').slice(0, 4).join(' ')

/** Play a move on a board state (branching off the shown line like an analysis board). */
function withMove(prev: CoachBoardState, from: string, to: string, promotion = 'q'): { state: CoachBoardState; san: string } | null {
  const cur = prev.line.fens[prev.ply]
  const chess = new Chess(cur)
  let result
  try { result = chess.move({ from, to, promotion }) } catch { return null }
  if (!result) return null
  const keep = prev.line.sans[prev.ply] === result.san
  const sans = [...prev.line.sans.slice(0, prev.ply), result.san]
  const fens = [...prev.line.fens.slice(0, prev.ply + 1), chess.fen()]
  return {
    san: result.san,
    state: {
      ...prev,
      line: keep ? prev.line : { ...prev.line, sans, fens,
        label: prev.line.kind === 'game' && !prev.line.label.endsWith('(variation)') ? prev.line.label + ' (variation)' : prev.line.label },
      ply: prev.ply + 1,
    },
  }
}

/** Board state shared by the board panel and the chat (what the coach "sees"), with browser-like tabs:
 *  puzzles, set-up positions and games vs Maia open in their own tab, so the user's board is never lost. */
export function useCoachBoard(initialFen = START_FEN) {
  const [tabs, setTabsRaw] = useState<BoardTab[]>(() => [{ id: 'main', title: 'My board', kind: 'board', state: fresh(initialFen) }])
  const [activeId, setActiveRaw] = useState('main')
  const tabsRef = useRef(tabs)
  const activeRef = useRef(activeId)
  const setTabs = useCallback((fn: (prev: BoardTab[]) => BoardTab[]) => {
    const value = fn(tabsRef.current)
    tabsRef.current = value
    setTabsRaw(value)
  }, [])
  const setActive = useCallback((id: string) => { activeRef.current = id; setActiveRaw(id) }, [])
  const current = useCallback(() => tabsRef.current.find(t => t.id === activeRef.current) ?? tabsRef.current[0], [])

  const active = tabs.find(t => t.id === activeId) ?? tabs[0]
  const state = active.state
  const fen = state.line.fens[Math.min(state.ply, state.line.fens.length - 1)]
  const movesContext = state.line.sans.slice(0, state.ply)

  const updateTab = useCallback((id: string, fn: (prev: CoachBoardState) => CoachBoardState) => {
    setTabs(prev => prev.map(t => t.id === id ? { ...t, state: fn(t.state) } : t))
  }, [setTabs])
  /** Update the active tab's state (all classic board actions work on the visible tab). */
  const setState = useCallback((next: CoachBoardState | ((prev: CoachBoardState) => CoachBoardState)) => {
    updateTab(current().id, prev => typeof next === 'function' ? next(prev) : next)
  }, [updateTab, current])

  const openTab = useCallback((title: string, kind: TabKind, st: CoachBoardState): string => {
    const id = Math.random().toString(36).slice(2, 10)
    setTabs(prev => {
      const next = [...prev, { id, title, kind, state: st }]
      while (next.length > MAX_TABS) next.splice(next.findIndex(t => t.id !== 'main' && t.id !== id), 1)
      return next
    })
    setActive(id)
    return id
  }, [setTabs, setActive])

  const closeTab = useCallback((id: string) => {
    if (id === 'main') return
    const prev = tabsRef.current
    const i = prev.findIndex(t => t.id === id)
    const next = prev.filter(t => t.id !== id)
    setTabs(() => next)
    if (activeRef.current === id) setActive(next[Math.max(0, i - 1)]?.id ?? 'main')
  }, [setTabs, setActive])

  const switchTab = useCallback((id: string) => { if (tabsRef.current.some(t => t.id === id)) setActive(id) }, [setActive])

  const setPosition = useCallback((newFen: string, label = 'Your board') => {
    setState({ line: userLine(newFen, label), ply: 0, saved: null })
  }, [setState])

  /** Show a line from the coach; the tab's own board is kept to return to. */
  const showLine = useCallback((rootFen: string, sans: string[], fens: string[], label: string,
                                kind: BoardLine['kind'] = 'coach', ply?: number, extra?: Partial<CoachBoardState>) => {
    const full = fens.length === sans.length + 1 ? fens : [rootFen]
    setState(prev => ({
      ...prev, ...extra,
      line: { rootFen, sans: full.length > 1 ? sans : [], fens: full, label, kind },
      ply: Math.max(0, Math.min(ply ?? (kind === 'game' ? 0 : sans.length), full.length - 1)),
      saved: kind === 'coach' ? (prev.saved ?? (prev.line.kind !== 'coach' ? { line: prev.line, ply: prev.ply } : null)) : null,
    }))
  }, [setState])

  const back = useCallback(() => {
    setState(prev => prev.saved ? { ...prev, line: prev.saved.line, ply: prev.saved.ply, saved: null } : prev)
  }, [setState])

  /** Take back the last move (in a game vs Maia: your move and her reply). */
  const undo = useCallback(() => setState(prev => {
    if (prev.puzzle || !prev.line.sans.length) return prev
    let n = 1
    if (prev.play && prev.line.fens.length >= 2) {
      const lastMover = new Chess(prev.line.fens[prev.line.fens.length - 2]).turn() === 'w' ? 'white' : 'black'
      if (lastMover !== prev.play.userColor) n = 2
    }
    n = Math.min(n, prev.line.sans.length)
    const sans = prev.line.sans.slice(0, -n)
    const fens = prev.line.fens.slice(0, prev.line.fens.length - n)
    return { ...prev, line: { ...prev.line, sans, fens }, ply: Math.min(prev.ply, sans.length) }
  }), [setState])

  const goTo = useCallback((ply: number) => {
    setState(prev => ({ ...prev, ply: Math.max(0, Math.min(ply, prev.line.fens.length - 1)) }))
  }, [setState])

  /** A move on the visible board. `expectFen` guards against stale engine replies. */
  const move = useCallback((from: string, to: string, promotion = 'q', expectFen?: string, tabId?: string): string | null => {
    const tab = tabId ? tabsRef.current.find(t => t.id === tabId) : current()
    if (!tab) return null
    const prev = tab.state
    if (expectFen && prev.line.fens[prev.ply] !== expectFen) return null
    const res = withMove(prev, from, to, promotion)
    if (!res) return null
    updateTab(tab.id, () => res.state)
    return res.san
  }, [current, updateTab])

  const loadText = useCallback((text: string): string | null => {
    const t = text.trim()
    if (!t) return 'Paste a FEN or PGN.'
    try {
      const c = new Chess(t)
      setPosition(c.fen(), 'Pasted position')
      return null
    } catch { /* not a FEN */ }
    try {
      const c = new Chess()
      c.loadPgn(t)
      const history = c.history()
      const header = c.header() as Record<string, string | null>
      const root = header.FEN ?? START_FEN
      const replay = new Chess(root)
      const fens = [replay.fen()]
      for (const san of history) { replay.move(san); fens.push(replay.fen()) }
      const label = header.White && header.Black ? `${header.White} – ${header.Black}` : 'Pasted game'
      setState({ line: { rootFen: root, sans: history, fens, label, kind: 'game' }, ply: 0, saved: null, gamePgn: t })
      return null
    } catch {
      return 'That is not a valid FEN or PGN.'
    }
  }, [setPosition, setState])

  /** A game vs Maia opens in its own tab, so the analysis board stays as it was. */
  const startPlay = useCallback((startFen: string, userColor: 'white' | 'black', elo = loadMaiaElo()) => {
    openTab('vs Maia', 'play', { ...fresh(startFen, 'Game vs Maia'), play: { userColor, elo } })
  }, [openTab])
  const stopPlay = useCallback(() => setState(prev => ({ ...prev, play: undefined })), [setState])
  const setPlayElo = useCallback((elo: number) => {
    saveMaiaElo(elo)
    setState(prev => prev.play ? { ...prev, play: { ...prev.play, elo } } : prev)
  }, [setState])
  const setMoments = useCallback((moments: GameMoment[]) => setState(prev => ({ ...prev, moments })), [setState])
  const setArrows = useCallback((arrowFen: string, arrows: BoardArrowEvent[]) => {
    setState(prev => ({ ...prev, arrows: { fen: arrowFen, arrows } }))
  }, [setState])

  const openPuzzle = useCallback((p: PuzzlePayload) => {
    if (!p.found || !p.fen) return
    const line = p.full_line_uci?.length ? p.full_line_uci : ['', p.solution_uci ?? '']
    openTab(`Puzzle${p.rating ? ' ' + p.rating : ''}`, 'puzzle', {
      ...fresh(p.fen, 'Puzzle'),
      puzzle: { id: p.puzzle_id ?? '', rating: p.rating, themes: p.themes, line, next: 1, status: 'solving', hint: false, revealed: false },
    })
  }, [openTab])

  const openPosition = useCallback((posFen: string, label: string, line?: { san: string[]; fens: string[] } | null,
                                    offer: ('play' | 'explain')[] = ['play', 'explain']) => {
    if (line && line.san.length && line.fens.length === line.san.length + 1) {
      // A line leading TO the position (opening moves) shows its end; a line FROM it starts at the position.
      const from = line.fens[0] === posFen
      openTab(label, 'position', {
        line: { rootFen: line.fens[0], sans: line.san, fens: line.fens, label, kind: 'coach' },
        ply: from ? 0 : line.san.length, saved: null, offer,
      })
    } else {
      openTab(label, 'position', { ...fresh(posFen, label), offer })
    }
  }, [openTab])

  /** Puzzle solving on the main board: right moves are kept and answered, wrong ones snap back. */
  const puzzleMove = useCallback((from: string, to: string): boolean => {
    const tab = current()
    const st = tab.state, pz = st.puzzle
    if (!pz || pz.status === 'solved' || st.ply !== st.line.fens.length - 1) return false
    const expected = pz.line[pz.next]
    if (!expected || expected.slice(0, 4) !== from + to) {
      updateTab(tab.id, prev => prev.puzzle ? { ...prev, puzzle: { ...prev.puzzle, status: 'wrong' } } : prev)
      window.setTimeout(() => updateTab(tab.id, prev => prev.puzzle?.status === 'wrong'
        ? { ...prev, puzzle: { ...prev.puzzle, status: 'solving' } } : prev), 800)
      return false
    }
    const res = withMove(st, from, to, expected[4] || 'q')
    if (!res) return false
    const afterUser = pz.next + 1
    const solved = afterUser >= pz.line.length
    updateTab(tab.id, () => ({ ...res.state, puzzle: { ...pz, next: solved ? afterUser : afterUser + 1, hint: false, status: solved ? 'solved' : 'solving' } }))
    const reply = pz.line[afterUser]
    if (!solved && reply) {
      window.setTimeout(() => {
        const t = tabsRef.current.find(x => x.id === tab.id)
        if (!t) return
        const r = withMove(t.state, reply.slice(0, 2), reply.slice(2, 4), reply[4] || 'q')
        if (r) updateTab(tab.id, () => ({ ...r.state, puzzle: t.state.puzzle }))
      }, 380)
    }
    return true
  }, [current, updateTab])

  const puzzleHint = useCallback(() => setState(prev => prev.puzzle ? { ...prev, puzzle: { ...prev.puzzle, hint: true } } : prev), [setState])
  const puzzleRetry = useCallback(() => setState(prev => prev.puzzle
    ? { ...prev, line: userLine(prev.line.rootFen, 'Puzzle'), ply: 0, puzzle: { ...prev.puzzle, next: 1, status: 'solving', hint: false, revealed: false } }
    : prev), [setState])
  const puzzleReveal = useCallback(() => setState(prev => {
    const pz = prev.puzzle
    if (!pz) return prev
    let st: CoachBoardState = { ...prev, line: userLine(prev.line.rootFen, 'Puzzle'), ply: 0 }
    for (const uci of pz.line.slice(1)) {
      const r = withMove(st, uci.slice(0, 2), uci.slice(2, 4), uci[4] || 'q')
      if (!r) break
      st = r.state
    }
    return { ...st, ply: 0, puzzle: { ...pz, next: pz.line.length, status: 'solved', revealed: true, hint: false } }
  }), [setState])

  return {
    state, fen, movesContext, tabs, activeId, activeKind: active.kind,
    setPosition, showLine, back, undo, goTo, move, loadText, startPlay, stopPlay, setPlayElo, setMoments, setState,
    setArrows, openTab, closeTab, switchTab, openPuzzle, openPosition, puzzleMove, puzzleHint, puzzleRetry, puzzleReveal,
  }
}

export type CoachBoardApi = ReturnType<typeof useCoachBoard>

/** Apply a coach stream event to the board. Returns true when the board changed (show it if hidden). */
export function applyCoachEvent(b: CoachBoardApi, evt: CoachStreamEvent): boolean {
  switch (evt.type) {
    case 'board':
      if (evt.game) b.showLine(evt.fen, evt.line.san, evt.line.fens, evt.label, 'game', 0, { gamePgn: evt.game.pgn, moments: undefined })
      else if (evt.label.startsWith('Pasted')) b.setPosition(evt.fen, evt.label)
      else b.showLine(evt.fen, evt.line.san, evt.line.fens, evt.label, 'coach')
      return true
    case 'position': b.openPosition(evt.fen, evt.label, evt.line, evt.offer); return true
    case 'puzzle': b.openPuzzle(evt.payload); return true
    case 'play': b.startPlay(evt.fen, evt.user_color, evt.elo ?? loadMaiaElo()); return true
    case 'arrows': b.setArrows(evt.fen, evt.arrows); return true
    case 'moments': b.setMoments(evt.moments); return true
    default: return false
  }
}

/** What the coach should know about the visible tab. */
export function boardInfo(b: CoachBoardApi): { kind: string; solved?: boolean } {
  if (b.state.puzzle) return { kind: 'puzzle', solved: b.state.puzzle.status === 'solved' }
  if (b.state.play) return { kind: 'play' }
  return { kind: b.activeKind }
}

const MOMENT_COLORS: Record<string, string> = {
  blunder: 'text-danger', mistake: 'text-orange-400', miss: 'text-orange-300',
  inaccuracy: 'text-amber-300', brilliant: 'text-cyan-300', great: 'text-sky-300',
}
const ARROW_COLOR: Record<string, string> = { best: ARROW_BEST, alt: ARROW_ALT, bad: ARROW_THREAT, threat: ARROW_THREAT }
const TAB_ICON: Record<TabKind, typeof Puzzle> = { board: LayoutGrid, puzzle: Puzzle, position: Sparkles, game: LayoutGrid, play: Swords }

function evalText(cp: number | null, mate: number | null) {
  if (mate != null) return `M${Math.abs(mate)}`
  if (cp == null) return '…'
  return `${cp >= 0 ? '+' : ''}${(cp / 100).toFixed(1)}`
}

export function CoachWorkspaceBoard({ board, busy, onAsk, liveSession }: {
  board: CoachBoardApi
  busy: boolean
  /** "Explain this position" etc. — sends a message to the coach. */
  onAsk?: (text: string) => void
  /** Share Screen: publish the visible position to the voice session. */
  liveSession?: string | null
}) {
  const { state, fen } = board
  const [orientation, setOrientation] = useState<'white' | 'black'>('white')
  const [paste, setPaste] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [width, setWidth] = useState(400)
  const wrapRef = useRef<HTMLDivElement>(null)
  const engineThinking = useRef(false)

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const w = entries[0].contentRect.width
      if (w > 0) setWidth(Math.max(240, Math.min(520, Math.floor(w - 18))))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Orientation follows the player in a game and the solver in a puzzle.
  const sideToMove = fen.split(' ')[1] === 'b' ? 'black' : 'white'
  useEffect(() => {
    if (state.play) setOrientation(state.play.userColor)
    else if (state.puzzle) setOrientation(new Chess(state.line.rootFen).turn() === 'w' ? 'white' : 'black')
  }, [board.activeId, state.play?.userColor, !!state.puzzle])   // eslint-disable-line react-hooks/exhaustive-deps

  const hideEval = !!state.play || (!!state.puzzle && state.puzzle.status !== 'solved')
  const { data: evalData } = useQuery({
    queryKey: ['coach-board-eval', fen],
    queryFn: () => fetch(`/api/analyse?fen=${encodeURIComponent(fen)}&depth=12`).then(r => r.json()),
    staleTime: Infinity, retry: false, enabled: !hideEval,
  })
  const cp: number | null = evalData?.eval_cp ?? null
  const mate: number | null = evalData?.eval_mate ?? null
  const whitePct = hideEval ? 50 : mate != null ? (mate > 0 ? 96 : 4) : cp == null ? 50 : Math.max(4, Math.min(96, 50 + 50 * Math.tanh(cp / 400)))

  const chess = useMemo(() => { try { return new Chess(fen) } catch { return new Chess() } }, [fen])
  const gameOver = chess.isGameOver()
  const atEnd = state.ply >= state.line.fens.length - 1

  // Share Screen publishes the exact visible position (with the last move) to the voice session.
  const published = useMemo(() => {
    const c = new Chess(state.line.rootFen)
    try { for (const san of state.line.sans.slice(0, state.ply)) c.move(san) } catch { /* line already validated */ }
    return c
  }, [state.line, state.ply])
  useBoardPublisher(liveSession ?? null, published, fen)

  // Play mode: Maia replies when it is its turn at the end of the line.
  const moveRef = useRef(board.move)
  moveRef.current = board.move
  const tabId = board.activeId
  useEffect(() => {
    const play = state.play
    if (!play || gameOver || !atEnd || engineThinking.current) return
    const engineToMove = (chess.turn() === 'w') !== (play.userColor === 'white')
    if (!engineToMove) return
    engineThinking.current = true
    const requested = fen
    let fired = false
    const t = setTimeout(async () => {
      fired = true
      try {
        const res = await coachApi.maiaMove(requested, play.elo)
        moveRef.current(res.move_uci.slice(0, 2), res.move_uci.slice(2, 4), res.move_uci[4] || 'q', requested, tabId)
      } catch { /* the user can stop/restart play */ }
      finally { engineThinking.current = false }
    }, 450)
    return () => { clearTimeout(t); if (!fired) engineThinking.current = false }
  }, [state.play, fen, atEnd, gameOver, chess, tabId])

  // ← / → step through the line (ignored while typing).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'ArrowLeft') { e.preventDefault(); board.goTo(state.ply - 1) }
      if (e.key === 'ArrowRight') { e.preventDefault(); board.goTo(state.ply + 1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [board, state.ply])

  function onDrop(from: Square, to: Square, piece: string): boolean {
    setSelected(null)
    if (state.puzzle && state.puzzle.status !== 'solved') return board.puzzleMove(from, to)
    if (state.play) {
      const userTurn = (chess.turn() === 'w') === (state.play.userColor === 'white')
      if (!userTurn || !atEnd) return false
    }
    const promo = piece[1]?.toLowerCase() === 'p' && (to[1] === '8' || to[1] === '1') ? 'q' : undefined
    return !!board.move(from, to, promo)
  }

  // Click-to-move: click a piece of the side to move, then its destination.
  const [selected, setSelected] = useState<Square | null>(null)
  useEffect(() => setSelected(null), [fen, board.activeId])
  function onSquareClick(square: Square) {
    const piece = chess.get(square)
    if (selected && selected !== square) {
      const from = chess.get(selected)
      if (from && chess.moves({ square: selected, verbose: true }).some(m => m.to === square)) {
        onDrop(selected, square, `${from.color}${from.type.toUpperCase()}`)
        return
      }
    }
    setSelected(piece && piece.color === chess.turn() && selected !== square ? square : null)
  }

  const lastMove = state.ply > 0 ? (() => {
    try {
      const c = new Chess(state.line.fens[state.ply - 1])
      const m = c.move(state.line.sans[state.ply - 1])
      return m ? { from: m.from, to: m.to } : null
    } catch { return null }
  })() : null
  const squareStyles: Record<string, React.CSSProperties> = lastMove ? {
    [lastMove.from]: { background: LAST_MOVE },
    [lastMove.to]: { background: LAST_MOVE },
  } : {}
  const pz = state.puzzle
  if (pz?.hint && pz.status !== 'solved' && pz.line[pz.next]) {
    squareStyles[pz.line[pz.next].slice(0, 2)] = { background: HINT_SQUARE }
  }
  if (selected) squareStyles[selected] = { background: HINT_SQUARE }
  const arrows: Arrow[] = state.arrows && sameSpot(state.arrows.fen, fen) && !(pz && pz.status !== 'solved')
    ? state.arrows.arrows.map(a => [a.from as Square, a.to as Square, ARROW_COLOR[a.kind] ?? ARROW_ALT])
    : []
  const ring = pz?.status === 'wrong' ? `0 0 0 2px ${PUZZLE_WRONG}` : pz?.status === 'solved' ? `0 0 0 2px rgba(${NEON_RGB},0.8)`
    : busy ? `0 0 0 2px rgba(${NEON_RGB},0.45)` : `0 0 0 1px rgba(${NEON_RGB},0.15)`

  // Move list rows: [moveNumber, whiteIdx?, blackIdx?]
  const startTurnBlack = state.line.rootFen.split(' ')[1] === 'b'
  const startNo = parseInt(state.line.rootFen.split(' ')[5] || '1', 10) || 1
  const rows: { no: number; w?: number; b?: number }[] = []
  state.line.sans.forEach((_, i) => {
    const offset = i + (startTurnBlack ? 1 : 0)
    const no = startNo + Math.floor(offset / 2)
    const isWhite = offset % 2 === 0
    if (isWhite || !rows.length || rows[rows.length - 1].no !== no) rows.push({ no })
    if (isWhite) rows[rows.length - 1].w = i; else rows[rows.length - 1].b = i
  })
  const momentAt = (i: number) => state.moments?.find(m => m.ply === i + 1)
  const solverColor = pz ? (new Chess(state.line.rootFen).turn() === 'w' ? 'White' : 'Black') : ''

  return (
    <div className="flex flex-col gap-1.5 min-h-0">
      {board.tabs.length > 1 && (
        <div className="flex items-end gap-1 overflow-x-auto px-1" role="tablist" aria-label="Boards">
          {board.tabs.map(t => {
            const Icon = TAB_ICON[t.kind]
            const on = t.id === board.activeId
            return (
              <div key={t.id} role="tab" aria-selected={on}
                className={`group flex items-center gap-1 pl-2 pr-1 py-1 rounded-t-md border border-b-0 text-[11px] whitespace-nowrap cursor-pointer select-none transition-colors
                  ${on ? 'bg-bg-1 border-accent/40 text-accent' : 'bg-bg-2/60 border-border text-text-2 hover:text-text-0'}`}
                onClick={() => board.switchTab(t.id)} title={t.title}>
                <Icon size={11} />
                <span className="max-w-[110px] truncate">{t.title}</span>
                {t.id !== 'main' ? (
                  <button onClick={e => { e.stopPropagation(); board.closeTab(t.id) }} aria-label={`Close ${t.title}`}
                    className="p-0.5 rounded opacity-60 hover:opacity-100 hover:bg-bg-3"><X size={10} /></button>
                ) : <span className="w-1" />}
              </div>
            )
          })}
        </div>
      )}
      <div className="card p-3 flex flex-col gap-2 min-h-0" ref={wrapRef}>
        <div className="flex items-center gap-1.5 text-xs">
          <span className={`px-2 py-0.5 rounded-md border truncate max-w-[60%] ${state.line.kind === 'coach' ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border text-text-1'}`}
            title={state.line.label}>{state.line.label}</span>
          {state.saved && (
            <button onClick={board.back} className="flex items-center gap-1 px-2 py-0.5 rounded-md text-text-1 hover:text-text-0 hover:bg-bg-2" title="Back to this board">
              <Undo2 size={12} /> Back
            </button>
          )}
          <div className="flex-1" />
          {!pz && state.line.sans.length > 0 && (
            <button onClick={board.undo} className="p-1 rounded text-text-2 hover:text-text-0 hover:bg-bg-2" title="Undo" aria-label="Undo"><Undo2 size={13} /></button>
          )}
          <button onClick={() => setOrientation(o => o === 'white' ? 'black' : 'white')} className="p-1 rounded text-text-2 hover:text-text-0 hover:bg-bg-2" title="Flip board"><FlipVertical2 size={13} /></button>
          <button onClick={() => { void navigator.clipboard?.writeText(fen); setCopied(true); setTimeout(() => setCopied(false), 1200) }}
            className="p-1 rounded text-text-2 hover:text-text-0 hover:bg-bg-2" title="Copy FEN">{copied ? <Check size={13} /> : <Copy size={13} />}</button>
          {board.activeKind === 'board' && (
            <button onClick={() => board.setPosition(START_FEN, 'Your board')} className="p-1 rounded text-text-2 hover:text-text-0 hover:bg-bg-2" title="Reset to the starting position"><RotateCcw size={13} /></button>
          )}
        </div>

        <div className="flex gap-2 justify-center">
          <div className={`w-2.5 rounded overflow-hidden flex flex-col-reverse flex-shrink-0 ${hideEval ? 'opacity-30' : ''}`} style={{ height: width }}
            title={hideEval ? 'Engine hidden' : `Engine: ${evalText(cp, mate)}`}>
            <div className="bg-text-0 transition-all duration-500" style={{ flex: whitePct }} />
            <div className="bg-bg-3 transition-all duration-500" style={{ flex: 100 - whitePct }} />
          </div>
          <Chessboard
            id="coach-workspace"
            position={fen}
            onPieceDrop={onDrop}
            onSquareClick={onSquareClick}
            boardOrientation={orientation}
            boardWidth={width}
            customArrows={arrows}
            customDarkSquareStyle={{ backgroundColor: BOARD_DARK }}
            customLightSquareStyle={{ backgroundColor: BOARD_LIGHT }}
            customSquareStyles={squareStyles}
            customBoardStyle={{ borderRadius: '6px', boxShadow: ring }}
            animationDuration={180}
          />
        </div>

        <div className="flex items-center justify-between text-xs">
          <span className="text-text-2 tabular-nums">
            {pz ? (pz.status === 'solved' ? (pz.revealed ? 'Solution shown' : 'Solved!') : pz.status === 'wrong' ? 'Not quite — try again' : `Find the best move for ${solverColor}`)
              : state.play ? (gameOver ? 'Game over' : (chess.turn() === 'w') === (state.play.userColor === 'white') ? 'Your move' : 'Maia is thinking…')
              : <>Eval <span className="text-text-0 font-medium">{evalText(cp, mate)}</span> · {sideToMove === 'white' ? 'White' : 'Black'} to move</>}
          </span>
          <div className="flex items-center gap-0.5">
            <button onClick={() => board.goTo(0)} disabled={state.ply === 0} className="p-1 rounded hover:bg-bg-2 disabled:opacity-30" aria-label="First move"><ChevronsLeft size={14} /></button>
            <button onClick={() => board.goTo(state.ply - 1)} disabled={state.ply === 0} className="p-1 rounded hover:bg-bg-2 disabled:opacity-30" aria-label="Previous move"><ChevronLeft size={14} /></button>
            <button onClick={() => board.goTo(state.ply + 1)} disabled={atEnd} className="p-1 rounded hover:bg-bg-2 disabled:opacity-30" aria-label="Next move"><ChevronRight size={14} /></button>
            <button onClick={() => board.goTo(state.line.fens.length - 1)} disabled={atEnd} className="p-1 rounded hover:bg-bg-2 disabled:opacity-30" aria-label="Last move"><ChevronsRight size={14} /></button>
          </div>
        </div>

        {state.line.sans.length > 0 && (
          <div className="max-h-32 overflow-y-auto rounded-md bg-bg-1 border border-border px-2 py-1.5 text-xs leading-6">
            <button onClick={() => board.goTo(0)} className={`mr-1 px-1 rounded ${state.ply === 0 ? 'bg-accent/15 text-accent' : 'text-text-2 hover:text-text-0'}`}>start</button>
            {rows.map(r => (
              <span key={`${r.no}-${r.w ?? r.b}`} className="inline-flex items-center mr-1">
                <span className="text-text-2 mr-0.5">{r.no}.{r.w == null ? '..' : ''}</span>
                {[r.w, r.b].map(i => i == null ? null : (
                  <button key={i} onClick={() => board.goTo(i + 1)}
                    className={`px-1 rounded ${state.ply === i + 1 ? 'bg-accent/15 text-accent' : 'text-text-1 hover:bg-bg-2'} ${momentAt(i) ? MOMENT_COLORS[momentAt(i)!.type] ?? '' : ''}`}
                    title={momentAt(i)?.type}>
                    {state.line.sans[i]}
                  </button>
                ))}
              </span>
            ))}
          </div>
        )}

        {pz ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs rounded-md border border-border bg-bg-1 px-2 py-1.5">
            <Puzzle size={13} className="text-accent" />
            <span className="text-text-1">Puzzle{pz.rating ? ` · ${pz.rating}` : ''}{pz.themes ? ` · ${pz.themes.split(' ').filter(t => !['short', 'long', 'veryLong', 'oneMove'].includes(t)).slice(0, 2).join(', ')}` : ''}</span>
            <div className="flex-1" />
            {pz.status !== 'solved' && <button onClick={board.puzzleHint} className="flex items-center gap-1 text-text-2 hover:text-accent"><Lightbulb size={11} /> Hint</button>}
            {pz.status !== 'solved' && <button onClick={board.puzzleReveal} className="flex items-center gap-1 text-text-2 hover:text-accent"><Eye size={11} /> Solution</button>}
            <button onClick={board.puzzleRetry} className="flex items-center gap-1 text-text-2 hover:text-accent"><RotateCcw size={11} /> Retry</button>
            {onAsk && <button onClick={() => onAsk('Give me another puzzle like this one')} className="text-text-2 hover:text-accent">Next ›</button>}
          </div>
        ) : state.play ? (
          <div className="flex flex-wrap items-center gap-2 text-xs rounded-md border border-accent/30 bg-accent/10 px-2 py-1.5">
            <Swords size={13} className="text-accent" />
            <span className="text-text-1">You ({state.play.userColor}) vs Maia</span>
            <MaiaSlider value={state.play.elo} onChange={board.setPlayElo} />
            <div className="flex-1" />
            <button onClick={board.stopPlay} className="flex items-center gap-1 text-text-2 hover:text-text-0"><StopIcon size={11} /> Stop</button>
          </div>
        ) : (
          <>
            {state.offer && state.offer.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                {state.offer.includes('play') && (
                  <button onClick={() => board.startPlay(fen, sideToMove)}
                    className="flex items-center gap-1 px-2 py-1 rounded-full border border-border text-text-1 hover:text-accent hover:border-accent/40">
                    <Swords size={11} /> Play vs Maia
                  </button>
                )}
                {state.offer.includes('explain') && onAsk && (
                  <button onClick={() => onAsk('Explain this position: what is the key idea and the plan for both sides?')}
                    className="flex items-center gap-1 px-2 py-1 rounded-full border border-border text-text-1 hover:text-accent hover:border-accent/40">
                    <Sparkles size={11} /> Explain
                  </button>
                )}
              </div>
            )}
            <div className="flex items-center gap-1.5 text-xs">
              <PlayMenu side={sideToMove} onStart={(color, elo) => board.startPlay(fen, color, elo)} />
              <form className="flex-1 flex gap-1.5" onSubmit={e => { e.preventDefault(); const err = board.loadText(paste); setPasteError(err); if (!err) setPaste('') }}>
                <input value={paste} onChange={e => setPaste(e.target.value)} placeholder="Paste FEN or PGN…" className="input text-xs py-1 flex-1 min-w-0" aria-label="Paste FEN or PGN" />
                <button type="submit" className="btn-ghost border border-border px-2 py-1 flex items-center gap-1" title="Load onto the board"><ClipboardPaste size={12} /> Load</button>
              </form>
            </div>
          </>
        )}
        {pasteError && <p className="text-[11px] text-danger">{pasteError}</p>}
      </div>
    </div>
  )
}

function MaiaSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-text-2" title="Maia's strength (1900 = strongest)">
      <input type="range" min={MAIA_MIN} max={MAIA_MAX} step={100} value={value}
        onChange={e => onChange(Number(e.target.value))} className="w-20 accent-accent" aria-label="Maia strength" />
      <span className="tabular-nums text-text-1 w-14">{value === MAIA_MAX ? `${value} max` : value}</span>
    </label>
  )
}

function PlayMenu({ side, onStart }: { side: 'white' | 'black'; onStart: (color: 'white' | 'black', elo: number) => void }) {
  const [open, setOpen] = useState(false)
  const [color, setColor] = useState<'white' | 'black'>(side)
  const [elo, setElo] = useState(loadMaiaElo)
  useEffect(() => { if (open) setColor(side) }, [open, side])
  return (
    <div className="relative">
      <button onClick={() => setOpen(o => !o)} className="btn-ghost border border-border px-2 py-1 flex items-center gap-1" title="Play this position against Maia">
        <Swords size={12} /> Play
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 left-0 z-20 w-60 card p-2.5 space-y-2 shadow-lg">
          <p className="text-[11px] text-text-2">Play this position against <span className="text-text-0">Maia</span>, a human-like engine.</p>
          <div className="flex gap-1">
            {(['white', 'black'] as const).map(c => (
              <button key={c} onClick={() => setColor(c)} className={`flex-1 rounded px-2 py-1 border text-xs ${color === c ? 'border-accent/50 bg-accent/10 text-accent' : 'border-border text-text-1'}`}>{c}</button>
            ))}
          </div>
          <MaiaSlider value={elo} onChange={v => { setElo(v); saveMaiaElo(v) }} />
          <button onClick={() => { onStart(color, elo); setOpen(false) }} className="w-full rounded bg-accent hover:bg-accent-hover text-accent-ink text-xs py-1.5">Start from this position</button>
        </div>
      )}
    </div>
  )
}
