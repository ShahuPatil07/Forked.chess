import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  Sparkles, Send, Loader2, Mic, MicOff, Volume2, VolumeX, RotateCcw, Check, AlertTriangle,
  GraduationCap, ChevronDown, Square as StopIcon,
} from 'lucide-react'
import { SectionHeader } from '../components/layout/SectionHeader'
import { useUserStore } from '../store/userStore'
import { useAudioCoach } from '../hooks/useAudioCoach'
import { CoachBoard } from '../components/coach/CoachBoard'
import { CoachWorkspaceBoard, useCoachBoard, START_FEN } from '../components/coach/CoachWorkspaceBoard'
import { AnswerText } from '../components/coach/AnswerText'
import { LevelQuestionnaire, STYLE_OPTIONS, type CoachLevel } from '../components/coach/LevelQuestionnaire'
import { coachApi, type AgentLine, type CoachChatMessage, type CoachStreamEvent, type PuzzlePayload } from '../api/coach'

interface Step { name: string; label: string; summary?: string; done: boolean }
type Msg =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; streaming: boolean; steps: Step[]; lines: AgentLine[];
      puzzles: PuzzlePayload[]; notes?: string; fen?: string; provider?: string }

const LEVEL_KEY = 'forked-coach-level'

function loadLevel(): CoachLevel | null {
  try { const raw = localStorage.getItem(LEVEL_KEY); return raw ? JSON.parse(raw) : null } catch { return null }
}

export default function Coach() {
  return (
    <div className="p-4 lg:p-6 max-w-[1700px] mx-auto h-full">
      <SectionHeader icon={Sparkles} title="Coach"
        description="Ask about the board, any move, an opening, or a whole game. Every claim is checked with Stockfish." />
      <CoachWorkspace />
    </div>
  )
}

function CoachWorkspace() {
  const { username } = useUserStore()
  const board = useCoachBoard(START_FEN)
  const [level, setLevel] = useState<CoachLevel | null>(loadLevel)
  const [showLevel, setShowLevel] = useState(() => !loadLevel())
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

  const audio = useAudioCoach(text => { if (text.trim()) void send(text) })

  useEffect(() => { scrollRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }) }, [messages])

  function saveLevel(l: CoachLevel) {
    setLevel(l); setShowLevel(false)
    try { localStorage.setItem(LEVEL_KEY, JSON.stringify(l)) } catch { /* private mode */ }
    if (username) {
      void coachApi.saveQuestionnaire(username, { rating_bucket: l.rating_bucket, explanation_style: l.explanation_style,
        goal: l.goal, play_style: '', study_time: '', struggle: '' }).catch(() => undefined)
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
    const b = boardRef.current
    switch (evt.type) {
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
      case 'board':
        if (evt.game) b.showLine(evt.fen, evt.line.san, evt.line.fens, evt.label, 'game', 0, { gamePgn: evt.game.pgn, moments: undefined })
        else if (evt.label.startsWith('Pasted')) b.setPosition(evt.fen, evt.label)
        else b.showLine(evt.fen, evt.line.san, evt.line.fens, evt.label, 'coach')
        break
      case 'moments': b.setMoments(evt.moments); break
      case 'play': b.startPlay(evt.fen, evt.user_color, evt.strength); break
      case 'puzzle': patchAssistant(m => ({ ...m, puzzles: [...m.puzzles, evt.payload] })); break
      case 'lines': patchAssistant(m => ({ ...m, lines: evt.lines })); break
      case 'token': patchAssistant(m => ({ ...m, content: m.content + evt.text })); break
      case 'done': patchAssistant(m => ({ ...m, notes: evt.notes, fen: evt.fen, provider: evt.provider })); break
      case 'error': throw new Error(evt.message)
    }
  }

  async function send(text: string) {
    const message = text.trim()
    if (!message || streaming) return
    const history: CoachChatMessage[] = messagesRef.current
      .filter(m => m.content.trim())
      .slice(-10)
      .map(m => m.role === 'assistant' ? { role: 'assistant', content: m.content, notes: m.notes, fen: m.fen } : { role: 'user', content: m.content })
    setMessages(prev => [...prev, { role: 'user', content: message },
      { role: 'assistant', content: '', streaming: true, steps: [], lines: [], puzzles: [] }])
    setInput(''); setError(null); setStreaming(true)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const b = boardRef.current
    try {
      await coachApi.chatStream({
        username: username || 'guest', message, mode: 'agent', conversation_history: history,
        position_fen: b.fen, board_moves: b.movesContext, game_pgn: b.state.gamePgn,
        level: level?.rating_bucket, style: level?.explanation_style,
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
        return last?.role === 'assistant' && !last.content && !last.puzzles.length ? prev.slice(0, -1) : prev
      })
      setStreaming(false); abortRef.current = null
    }
  }

  function handleSubmit(e: FormEvent) { e.preventDefault(); void send(input) }

  const isStart = board.fen.split(' ')[0] === START_FEN.split(' ')[0]
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
  const suggestions = streaming ? [] : lastAssistant && lastAssistant.content
    ? ['Explain it simpler', 'Go deeper', 'What if they defend differently?', 'What should I remember from this?']
    : board.state.gamePgn
      ? ['Review this game', 'What was the turning point?', 'What is the main lesson from this game?']
      : isStart
        ? ['What is the idea behind the Italian Game?', 'How should a beginner start a game?', 'Give me a fork puzzle', "Let's play a game, I'm White"]
        : ["What's the best move here, and why?", 'What is the plan for both sides?', 'What is my opponent threatening?', 'Which side is better and why?']

  const styleLabel = STYLE_OPTIONS.find(s => s.value === level?.explanation_style)?.label ?? 'Balanced'

  return (
    <>
      {showLevel && <LevelQuestionnaire initial={level} onSave={saveLevel} onClose={level ? () => setShowLevel(false) : undefined} />}
      <div className="grid gap-4 lg:grid-cols-[minmax(300px,500px)_minmax(0,1fr)]" style={{ minHeight: 460 }}>
        <div className="lg:overflow-y-auto" style={{ maxHeight: 'calc(100dvh - 145px)' }}>
          <CoachWorkspaceBoard board={board} busy={streaming} />
          <p className="text-[11px] text-text-2 mt-2 px-1">
            The coach sees this board. Move pieces, paste a FEN/PGN, or click moves in an answer to explore them here.
          </p>
        </div>

        <div className="card p-0 flex flex-col min-w-0" style={{ height: 'calc(100dvh - 145px)', minHeight: 460 }}>
          <div className="flex flex-wrap items-center gap-1.5 px-3 py-2.5 border-b border-border">
            <button onClick={() => setShowLevel(true)} title="Change how the coach explains"
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-text-1 hover:text-text-0 hover:bg-bg-2 border border-border">
              <GraduationCap size={13} className="text-accent" />
              {level ? `${level.rating_bucket} · ${styleLabel}` : 'Set your level'}
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
            {messages.length > 0 && (
              <button onClick={() => { abortRef.current?.abort(); setMessages([]); setError(null) }}
                className="flex items-center gap-1 px-2 py-1.5 rounded-md text-xs text-text-2 hover:text-text-0 hover:bg-bg-2" title="New conversation">
                <RotateCcw size={12} /> New chat
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
            {messages.length === 0 && (
              <div className="h-full flex flex-col items-center justify-center text-center px-6">
                <div className="w-10 h-10 rounded-xl bg-accent/15 text-accent flex items-center justify-center mb-3"><Sparkles size={18} /></div>
                <p className="text-sm text-text-0 font-medium">Your chess coach, with an engine behind every answer.</p>
                <p className="text-xs text-text-2 mt-1.5 max-w-md">
                  Ask why a move works, what happens after the natural alternative, what the opponent threatens,
                  or paste a game for a review. Follow-up questions keep the context — ask “why?” as often as you like.
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
                      <AnswerText text={m.content} lines={m.lines} onMove={(line, ply) => board.showLine(line.start_fen, line.san, line.fens, line.label, 'coach', ply)} />
                      {m.provider === 'fallback' && (
                        <p className="text-[10px] text-amber-300 mt-2 flex items-center gap-1"><AlertTriangle size={11} /> Free AI quota is busy — this is the engine-only summary.</p>
                      )}
                    </div>
                  )}
                  {m.puzzles.map((p, j) => p.found && p.fen ? (
                    <div key={j} className="p-2 rounded-lg bg-bg-1 border border-border inline-block">
                      <CoachBoard mode="puzzle" fen={p.fen} fullLineUci={p.full_line_uci} solutionUci={p.solution_uci} orientation={p.side_to_move} size={300} />
                      <p className="text-[10px] text-text-2 mt-1.5">Puzzle {p.puzzle_id} · rating {p.rating}{p.themes ? ` · ${p.themes.split(' ').slice(0, 3).join(', ')}` : ''}</p>
                    </div>
                  ) : null)}
                  {m.lines.length > 0 && !m.streaming && (
                    <div className="flex flex-wrap gap-1.5">
                      {m.lines.slice(0, 5).map((l, j) => (
                        <button key={j} onClick={() => board.showLine(l.start_fen, l.san, l.fens, l.label, 'coach', 0)}
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
              placeholder={audioOn ? 'Speak, or type…' : 'Ask about the board, a move, an opening — or paste a PGN…'}
              className="input text-sm py-2 resize-none flex-1"
            />
            {streaming ? (
              <button type="button" onClick={() => abortRef.current?.abort()} title="Stop"
                className="w-9 h-9 rounded-md bg-bg-2 border border-border text-text-1 hover:text-danger flex items-center justify-center flex-shrink-0">
                <StopIcon size={13} />
              </button>
            ) : (
              <button type="submit" disabled={!input.trim()}
                className="w-9 h-9 rounded-md bg-accent hover:bg-accent-hover text-white flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex-shrink-0">
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
