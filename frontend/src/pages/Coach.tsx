import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Sparkles, Send, Loader2, Mic, MicOff, Volume2, VolumeX, Check, AlertTriangle,
  GraduationCap, ChevronDown, Square as StopIcon, PanelLeftClose, PanelLeftOpen, History, Plus, Trash2, X,
} from 'lucide-react'
import { coachChatsApi, newChatId } from '../api/coachChats'
import { relativeTime } from '../lib/format'
import { SectionHeader } from '../components/layout/SectionHeader'
import { useUserStore } from '../store/userStore'
import { useAudioCoach } from '../hooks/useAudioCoach'
import {
  CoachWorkspaceBoard, useCoachBoard, applyCoachEvent, boardInfo, loadMaiaElo, START_FEN,
} from '../components/coach/CoachWorkspaceBoard'
import { AnswerText } from '../components/coach/AnswerText'
import { PositionEditor } from '../components/coach/PositionEditor'
import { LevelQuestionnaire, STYLE_OPTIONS, PROFILE_KEY, loadCoachProfile } from '../components/coach/LevelQuestionnaire'
import {
  coachApi, type AgentLine, type CoachChatMessage, type CoachIntent, type CoachProfile,
  type CoachStreamEvent, type ConfiguratorEvent,
} from '../api/coach'

interface Step { name: string; label: string; summary?: string; done: boolean }
type Msg =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; streaming: boolean; steps: Step[]; lines: AgentLine[];
      editors: ConfiguratorEvent[]; notes?: string; fen?: string; provider?: string; intent?: CoachIntent }

const BOARD_KEY = 'forked-coach-board-visible'
const loadProfile = loadCoachProfile

function loadBoardVisible(): boolean {
  try { return localStorage.getItem(BOARD_KEY) !== '0' } catch { return true }
}

export default function Coach() {
  return (
    <div className="p-4 lg:p-6 max-w-[1700px] mx-auto h-full">
      <SectionHeader icon={Sparkles} title="Coach"
        description="Ask about the board, any move, an opening, chess history — or ask for a puzzle or a position to play. Every chess claim is checked." />
      <CoachWorkspace />
    </div>
  )
}

function CoachWorkspace() {
  const { username } = useUserStore()
  const board = useCoachBoard(START_FEN)
  const [profile, setProfile] = useState<CoachProfile | null>(loadProfile)
  const [showProfile, setShowProfile] = useState(() => !loadProfile())
  const [boardVisible, setBoardVisibleRaw] = useState(loadBoardVisible)
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [audioOn, setAudioOn] = useState(false)
  const audioOnRef = useRef(false)
  audioOnRef.current = audioOn
  const scrollRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const messagesRef = useRef<Msg[]>([])
  messagesRef.current = messages
  const boardRef = useRef(board)
  boardRef.current = board
  const seenPuzzles = useRef<string[]>([])

  const audio = useAudioCoach(text => { if (text.trim()) void send(text) })

  // ── saved conversations ────────────────────────────────────────────────────
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const [chatId, setChatId] = useState<string>(() => params.get('chat') || newChatId())
  const [historyOpen, setHistoryOpen] = useState(false)
  const chatIdRef = useRef(chatId)
  chatIdRef.current = chatId
  const { data: chatList } = useQuery({
    queryKey: ['coach-chats', username], queryFn: () => coachChatsApi.list(username),
    enabled: !!username, staleTime: 15_000,
  })
  const saveChat = useCallback(async () => {
    const msgs = messagesRef.current.filter(m => m.content || (m.role === 'assistant' && (m.editors.length || m.lines.length)))
    if (!username || !msgs.length) return
    try {
      await coachChatsApi.save(username, chatIdRef.current, {
        messages: msgs.map(m => (m.role === 'assistant' ? { ...m, streaming: false } : m)),
        board: boardRef.current.snapshot(),
      })
      void qc.invalidateQueries({ queryKey: ['coach-chats', username] })
    } catch { /* history is best-effort */ }
  }, [username, qc])
  async function openChat(id: string) {
    abortRef.current?.abort()
    try {
      const doc = await coachChatsApi.get(username, id)
      setMessages(doc.messages as unknown as Msg[])
      boardRef.current.restore(doc.board)
      setChatId(id); setHistoryOpen(false); setError(null)
      if (doc.board) setBoardVisible(true)
      setParams({ chat: id }, { replace: true })
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not open that conversation.') }
  }
  function newChat() {
    abortRef.current?.abort()
    setMessages([]); setError(null); setChatId(newChatId()); setHistoryOpen(false)
    setParams({}, { replace: true })
  }
  async function deleteChat(id: string) {
    await coachChatsApi.remove(username, id).catch(() => undefined)
    void qc.invalidateQueries({ queryKey: ['coach-chats', username] })
    if (id === chatIdRef.current) newChat()
  }
  // deep link: /coach?chat=<id>
  useEffect(() => {
    const id = params.get('chat')
    if (id && username) void openChat(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username])

  // Hand-off from another page (e.g. Puzzle Themes "Ask the Coach"): open the position
  // in a board tab and pre-fill the question, then drop the router state so a refresh doesn't repeat it.
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => {
    const pos = (location.state as { position?: { fen: string; label: string; question?: string;
      line?: { san: string[]; fens: string[] } } } | null)?.position
    if (!pos?.fen) return
    board.openPosition(pos.fen, pos.label, pos.line ?? null, ['explain', 'play'])
    setBoardVisible(true)
    if (pos.question) setInput(pos.question)
    navigate(location.pathname, { replace: true, state: null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => { scrollRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }) }, [messages])

  function setBoardVisible(v: boolean) {
    setBoardVisibleRaw(v)
    try { localStorage.setItem(BOARD_KEY, v ? '1' : '0') } catch { /* private mode */ }
  }

  function saveProfile(p: CoachProfile) {
    setProfile(p); setShowProfile(false)
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)) } catch { /* private mode */ }
    if (username) {
      void coachApi.saveQuestionnaire(username, {
        rating_bucket: p.rating_bucket, explanation_style: p.explanation_style, goal: p.goal ?? '',
        learning: p.learning, vocabulary: p.vocabulary, tone: p.tone, notation: p.notation,
        play_style: '', study_time: '', struggle: '',
      }).catch(() => undefined)
    }
  }

  function patchAssistant(fn: (m: Extract<Msg, { role: 'assistant' }>) => Extract<Msg, { role: 'assistant' }>) {
    setMessages(prev => {
      const next = [...prev]
      for (let i = next.length - 1; i >= 0; i--) {
        const m = next[i]
        if (m.role === 'assistant') { next[i] = fn(m); break }
      }
      return next
    })
  }

  function onEvent(evt: CoachStreamEvent) {
    // Anything that puts something on the board brings the board back if it was hidden.
    if (applyCoachEvent(boardRef.current, evt)) {
      if (evt.type !== 'arrows' && evt.type !== 'moments') setBoardVisible(true)
      if (evt.type === 'puzzle' && evt.payload.puzzle_id) seenPuzzles.current = [...seenPuzzles.current, evt.payload.puzzle_id].slice(-150)
      return
    }
    switch (evt.type) {
      case 'intent':
        if (evt.intent === 'position') setBoardVisible(true)
        patchAssistant(m => ({ ...m, intent: evt.intent }))
        break
      case 'tool':
        patchAssistant(m => ({ ...m, steps: [...m.steps, { name: evt.name, label: evt.label ?? evt.name, done: false }] }))
        break
      case 'tool_done':
        patchAssistant(m => {
          const steps = [...m.steps]
          for (let i = steps.length - 1; i >= 0; i--) {
            if (steps[i].name === evt.name && !steps[i].done) { steps[i] = { ...steps[i], done: true, summary: evt.summary }; break }
          }
          return { ...m, steps }
        })
        break
      case 'configurator': patchAssistant(m => ({ ...m, editors: [...m.editors, evt] })); break
      case 'lines': patchAssistant(m => ({ ...m, lines: evt.lines })); break
      case 'retract': patchAssistant(m => ({ ...m, content: '' })); break
      case 'token': patchAssistant(m => ({ ...m, content: m.content + evt.text })); break
      case 'done': patchAssistant(m => ({ ...m, notes: evt.notes, fen: evt.fen, provider: evt.provider, intent: evt.intent ?? m.intent })); break
      case 'error': throw new Error(evt.message)
    }
  }

  async function send(text: string) {
    const message = text.trim()
    if (!message || streaming) return
    const history: CoachChatMessage[] = messagesRef.current
      .filter(m => m.content.trim())
      .slice(-10)
      .map(m => m.role === 'assistant'
        ? { role: 'assistant', content: m.content, notes: m.notes, fen: m.fen, intent: m.intent }
        : { role: 'user', content: m.content })
    setMessages(prev => [...prev, { role: 'user', content: message },
      { role: 'assistant', content: '', streaming: true, steps: [], lines: [], editors: [] }])
    setInput(''); setError(null); setStreaming(true)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const b = boardRef.current
    try {
      await coachApi.chatStream({
        username: username || 'guest', message, mode: 'agent', conversation_history: history,
        position_fen: b.fen, board_moves: b.movesContext, game_pgn: b.state.gamePgn,
        level: profile?.rating_bucket, style: profile?.explanation_style, profile,
        board_info: boardInfo(b), seen_puzzles: seenPuzzles.current, maia_elo: loadMaiaElo(),
      }, onEvent, ctrl.signal)
      const final = messagesRef.current[messagesRef.current.length - 1]
      if (audioOnRef.current && final?.role === 'assistant' && final.content) audio.speak(final.content)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Coach unavailable'
      if (!/abort/i.test(msg)) setError(msg)
    } finally {
      patchAssistant(m => ({ ...m, streaming: false, steps: m.steps.map(s => ({ ...s, done: true })) }))
      setMessages(prev => {
        const last = prev[prev.length - 1]
        return last?.role === 'assistant' && !last.content && !last.editors.length && !last.steps.length ? prev.slice(0, -1) : prev
      })
      setStreaming(false); abortRef.current = null
    }
  }

  // autosave when an answer finishes (messages + every board tab)
  const wasStreaming = useRef(false)
  useEffect(() => {
    if (wasStreaming.current && !streaming) void saveChat()
    wasStreaming.current = streaming
  }, [streaming, saveChat])

  function handleSubmit(e: FormEvent) { e.preventDefault(); void send(input) }

  const isStart = board.fen.split(' ')[0] === START_FEN.split(' ')[0]
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
  const suggestions = streaming ? [] : lastAssistant && lastAssistant.content
    ? lastAssistant.intent === 'general'
      ? ['Tell me more', 'Explain it simpler', 'Show me a famous game about this']
      : ['Explain it simpler', 'Go deeper', 'What if they defend differently?', 'What should I remember from this?']
    : board.state.puzzle
      ? ['Give me a hint', 'What theme is this puzzle?']
      : board.state.gamePgn
        ? ['Review this game', 'What was the turning point?', 'What is the main lesson from this game?']
        : isStart
          ? ['Give me a fork puzzle', 'Set up a rook endgame to play', 'What is the idea behind the Italian Game?', 'Who was the first world champion?']
          : ["What's the best move here, and why?", 'What is the plan for both sides?', 'What is my opponent threatening?', 'Which side is better and why?']

  const styleLabel = STYLE_OPTIONS.find(s => s.value === profile?.explanation_style)?.label ?? 'Balanced'

  return (
    <>
      {showProfile && <LevelQuestionnaire initial={profile} onSave={saveProfile} onClose={profile ? () => setShowProfile(false) : undefined} />}
      <div className={`grid gap-4 ${boardVisible ? 'lg:grid-cols-[minmax(300px,500px)_minmax(0,1fr)]' : ''}`} style={{ minHeight: 460 }}>
        <div className={`lg:overflow-y-auto ${boardVisible ? '' : 'hidden'}`} style={{ maxHeight: 'calc(100dvh - 201px)' }}>
          <CoachWorkspaceBoard board={board} busy={streaming} onAsk={text => void send(text)} />
          <p className="text-[11px] text-text-2 mt-2 px-1">
            The coach sees the board in the active tab. Move pieces, paste a FEN/PGN, or click moves in an answer to explore them.
          </p>
        </div>

        <div className="card p-0 flex flex-col min-w-0" style={{ height: 'calc(100dvh - 201px)', minHeight: 460 }}>
          <div className="flex flex-wrap items-center gap-1.5 px-3 py-2.5 border-b border-border">
            <button onClick={() => setBoardVisible(!boardVisible)} title={boardVisible ? 'Hide the board' : 'Show the board'}
              aria-pressed={boardVisible}
              className="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs text-text-2 hover:text-text-0 hover:bg-bg-2 border border-transparent">
              {boardVisible ? <PanelLeftClose size={13} /> : <PanelLeftOpen size={13} />} {boardVisible ? 'Hide board' : 'Board'}
            </button>
            <button onClick={() => setShowProfile(true)} title="Change how the coach explains"
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-text-1 hover:text-text-0 hover:bg-bg-2 border border-border">
              <GraduationCap size={13} className="text-accent" />
              {profile ? `${profile.rating_bucket} · ${styleLabel}` : 'Set your level'}
              <ChevronDown size={12} className="text-text-2" />
            </button>
            <button
              onClick={() => { if (audio.supported) { setAudioOn(v => !v); audio.stopSpeaking() } }}
              disabled={!audio.supported}
              title={audio.supported ? 'Audio mode — speak & hear replies' : 'Audio needs Chrome or Edge'}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors
                ${!audio.supported ? 'text-text-2/40 cursor-not-allowed border-transparent'
                  : audioOn ? 'bg-accent/15 text-accent border-accent/30' : 'text-text-2 hover:text-text-1 hover:bg-bg-2 border-transparent'}`}>
              {audioOn ? <Volume2 size={13} /> : <Mic size={13} />} Audio
            </button>
            <div className="flex-1" />
            <button onClick={() => setHistoryOpen(o => !o)} aria-expanded={historyOpen}
              className={`flex items-center gap-1 px-2 py-1.5 rounded-md text-xs border ${historyOpen ? 'border-accent/40 text-accent bg-accent/10' : 'border-transparent text-text-2 hover:text-text-0 hover:bg-bg-2'}`} title="Previous conversations">
              <History size={12} /> History{chatList?.chats.length ? ` (${chatList.chats.length})` : ''}
            </button>
            {messages.length > 0 && (
              <button onClick={newChat}
                className="flex items-center gap-1 px-2 py-1.5 rounded-md text-xs text-text-2 hover:text-text-0 hover:bg-bg-2" title="New conversation">
                <Plus size={12} /> New chat
              </button>
            )}
          </div>

          {historyOpen && (
            <div className="border-b border-border bg-bg-0/60 max-h-[45%] overflow-y-auto">
              <div className="flex items-center justify-between px-4 pt-3 pb-2">
                <p className="text-[11px] uppercase tracking-wider text-text-2">Your conversations</p>
                <button onClick={() => setHistoryOpen(false)} className="text-text-2 hover:text-text-0" aria-label="Close history"><X size={14} /></button>
              </div>
              {!chatList?.chats.length ? (
                <p className="px-4 pb-4 text-xs text-text-2">Conversations are saved automatically after each answer — with their boards.</p>
              ) : (
                <ul className="px-2 pb-2">
                  {chatList.chats.map(c => (
                    <li key={c.id} className={`group flex items-center gap-2 rounded-lg px-2 py-2 ${c.id === chatId ? 'bg-accent/10' : 'hover:bg-bg-2'}`}>
                      <button onClick={() => void openChat(c.id)} className="min-w-0 flex-1 text-left">
                        <p className={`text-sm truncate ${c.id === chatId ? 'text-accent' : 'text-text-0'}`}>{c.title}</p>
                        <p className="text-[11px] text-text-2 truncate">{relativeTime(c.updated_at)} · {c.messages} messages{c.preview ? ` · ${c.preview}` : ''}</p>
                      </button>
                      <button onClick={() => void deleteChat(c.id)} className="p-1.5 rounded text-text-2 opacity-0 group-hover:opacity-100 hover:text-danger" aria-label="Delete conversation"><Trash2 size={12} /></button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
            {messages.length === 0 && (
              <div className="h-full flex flex-col items-center justify-center text-center px-6">
                <div className="w-10 h-10 rounded-xl bg-accent/15 text-accent flex items-center justify-center mb-3"><Sparkles size={18} /></div>
                <p className="text-sm text-text-0 font-medium font-display">Your chess coach, with an engine behind every answer.</p>
                <p className="text-xs text-text-2 mt-1.5 max-w-md">
                  Ask why a move works, what the opponent threatens, or about any chess topic. Ask for a puzzle,
                  a famous position, or an endgame to play against Maia — it opens in a new board tab.
                </p>
              </div>
            )}
            {messages.map((m, i) => m.role === 'user' ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-br-sm px-3.5 py-2 text-sm bg-accent/15 border border-accent/20 text-text-0 whitespace-pre-wrap break-words">
                  {m.content.length > 600 ? m.content.slice(0, 600) + '…' : m.content}
                </div>
              </div>
            ) : (
              <div key={i} className="flex justify-start">
                <div className="w-full max-w-[900px] text-sm text-text-1 space-y-2">
                  {m.steps.length > 0 && <Steps steps={m.steps} />}
                  {!m.content && m.streaming && !m.steps.length && (
                    <span className="text-text-2 inline-flex items-center gap-1.5 text-xs"><Loader2 size={12} className="animate-spin text-accent" /> Thinking…</span>
                  )}
                  {m.content && (
                    <div className="rounded-2xl rounded-tl-sm px-4 py-3 bg-bg-2 border border-border">
                      <AnswerText text={m.content} lines={m.lines} onMove={(line, ply) => { setBoardVisible(true); board.showLine(line.start_fen, line.san, line.fens, line.label, 'coach', ply) }} />
                      {m.streaming && <span className="inline-block w-1.5 h-3.5 bg-accent/70 animate-pulse align-middle ml-0.5" aria-hidden="true" />}
                      {m.provider === 'fallback' && (
                        <p className="text-[10px] text-amber-300 mt-2 flex items-center gap-1"><AlertTriangle size={11} /> The AI model is unavailable — this is the engine-only summary.</p>
                      )}
                    </div>
                  )}
                  {m.editors.map((e, j) => (
                    <PositionEditor key={j} initial={e} onGenerated={pos => {
                      setBoardVisible(true)
                      board.openPosition(pos.fen, pos.material, null, ['play', 'explain'])
                    }} />
                  ))}
                  {m.lines.length > 0 && !m.streaming && (
                    <div className="flex flex-wrap gap-1.5">
                      {m.lines.slice(0, 5).map((l, j) => (
                        <button key={j} onClick={() => { setBoardVisible(true); board.showLine(l.start_fen, l.san, l.fens, l.label, 'coach', 0) }}
                          className="text-[11px] px-2 py-1 rounded-md border border-border text-text-2 hover:text-accent hover:border-accent/40"
                          title={l.san.join(' ')}>▶ {l.label}</button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            <div ref={scrollRef} />
          </div>

          {error && <p className="px-4 pb-1 text-[11px] text-danger">{error}</p>}
          {audioOn && audio.listening && (
            <p className="px-4 pb-1 text-[11px] text-accent flex items-center gap-1.5">
              <Mic size={11} className="animate-pulse" /> Listening… {audio.interim && <span className="text-text-2 italic">{audio.interim}</span>}
            </p>
          )}
          {suggestions.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-2">
              {suggestions.map(s => (
                <button key={s} onClick={() => void send(s)}
                  className="text-[11px] px-2.5 py-1 rounded-full border border-border text-text-1 hover:text-accent hover:border-accent/40 transition-colors">{s}</button>
              ))}
            </div>
          )}
          <form onSubmit={handleSubmit} className="flex items-end gap-2 p-3">
            {audioOn && audio.supported && (
              <button type="button"
                onClick={() => { if (audio.speaking) audio.stopSpeaking(); if (audio.listening) audio.stopListening(); else audio.startListening() }}
                title={audio.listening ? 'Stop listening' : 'Push to talk'}
                className={`w-9 h-9 rounded-md flex items-center justify-center flex-shrink-0 border
                  ${audio.listening ? 'bg-danger/20 text-danger border-danger/40 animate-pulse' : 'bg-bg-2 text-text-1 border-border hover:text-accent'}`}>
                {audio.listening ? <MicOff size={15} /> : <Mic size={15} />}
              </button>
            )}
            {audioOn && audio.speaking && (
              <button type="button" onClick={audio.stopSpeaking} title="Stop speaking"
                className="w-9 h-9 rounded-md flex items-center justify-center flex-shrink-0 bg-bg-2 text-text-1 border border-border hover:text-accent">
                <VolumeX size={15} />
              </button>
            )}
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(e) } }}
              rows={2}
              placeholder={audioOn ? 'Speak, or type…' : 'Ask about the board, any chess topic, or for a puzzle / position to play…'}
              className="input text-sm py-2 resize-none flex-1"
            />
            {streaming ? (
              <button type="button" onClick={() => abortRef.current?.abort()} title="Stop"
                className="w-9 h-9 rounded-md bg-bg-2 border border-border text-text-1 hover:text-danger flex items-center justify-center flex-shrink-0">
                <StopIcon size={13} />
              </button>
            ) : (
              <button type="submit" disabled={!input.trim()}
                className="w-9 h-9 rounded-md bg-accent hover:bg-accent-hover text-accent-ink flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex-shrink-0">
                <Send size={14} />
              </button>
            )}
          </form>
        </div>
      </div>
    </>
  )
}

function Steps({ steps }: { steps: Step[] }) {
  const [open, setOpen] = useState(false)
  const running = steps.find(s => !s.done)
  return (
    <div className="text-[11px]">
      <button onClick={() => setOpen(o => !o)} className="flex flex-wrap items-center gap-1.5 text-text-2 hover:text-text-1">
        {steps.map((s, i) => (
          <span key={i} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-border bg-bg-1">
            {s.done ? <Check size={10} className="text-success" /> : <Loader2 size={10} className="animate-spin text-accent" />}
            {s.label}
          </span>
        ))}
        {!running && <ChevronDown size={11} className={`transition-transform ${open ? 'rotate-180' : ''}`} />}
      </button>
      {open && (
        <ul className="mt-1.5 space-y-0.5 pl-1 text-text-2">
          {steps.filter(s => s.summary).map((s, i) => <li key={i}><span className="text-text-1">{s.label}:</span> {s.summary}</li>)}
        </ul>
      )}
    </div>
  )
}
