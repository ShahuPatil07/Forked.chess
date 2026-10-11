import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
  Sparkles, Send, Loader2, MessageSquare, Crosshair, ClipboardPaste,
  BookOpen, Mic, MicOff, Volume2, VolumeX, RotateCcw, Bot,
  ChevronLeft, ChevronRight,
} from 'lucide-react'
import { SectionHeader } from '../components/layout/SectionHeader'
import { useUserStore } from '../store/userStore'
import { useAudioCoach } from '../hooks/useAudioCoach'
import { CoachBoard } from '../components/coach/CoachBoard'
import { InvestigationEvidence } from '../components/coach/InvestigationEvidence'
import {
  coachApi, type CoachMode, type CoachStreamEvent, type CoachChatMessage,
  type PuzzlePayload, type MistakePositionsPayload, type AnalyzePayload,
  type CoachQuestionnaire,
  type ExplainPayload,
} from '../api/coach'

// ── Questionnaire data ─────────────────────────────────────────────────────────

const Q = {
  rating: { key: 'rating_bucket', label: "What's your current rating?",
    opts: ['Under 800', '800-1200', '1200-1600', '1600-2000', '2000+'] },
  style:  { key: 'play_style', label: 'How do you play?',
    opts: ['Sharp & tactical', 'Solid & positional', 'Mixed / adaptable', 'Still figuring it out'] },
  goal:   { key: 'goal', label: 'Main goal right now?',
    opts: ['Reach a specific rating', 'Stop making blunders', 'Understand chess better', 'Beat a specific person', 'Just enjoy improving'] },
  study:  { key: 'study_time', label: 'Study time per week?',
    opts: ['< 1 hour', '1-3 hours', '3-7 hours', '7+ hours'] },
} as const

function Questionnaire({ onComplete }: { onComplete: () => void }) {
  const { username } = useUserStore()
  const [ans, setAns] = useState<Record<string, string>>({})
  const [struggle, setStruggle] = useState('')
  const [saving, setSaving] = useState(false)
  const ready = Q.rating && ['rating_bucket', 'play_style', 'goal', 'study_time'].every(k => ans[k])

  async function submit() {
    if (!ready || saving) return
    setSaving(true)
    try {
      await coachApi.saveQuestionnaire(username, {
        rating_bucket: ans.rating_bucket, play_style: ans.play_style,
        goal: ans.goal, study_time: ans.study_time, struggle,
      } as CoachQuestionnaire)
      onComplete()
    } finally { setSaving(false) }
  }

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
      className="max-w-xl mx-auto card p-6 space-y-6">
      <div className="text-center">
        <div className="w-10 h-10 rounded-xl bg-accent/15 border border-accent/25 flex items-center justify-center text-accent mx-auto mb-3">
          <Sparkles size={18} />
        </div>
        <h2 className="text-lg font-bold text-text-0">Meet your Forked Coach</h2>
        <p className="text-xs text-text-2 mt-1">90 seconds to set up. After this, your real games take over.</p>
      </div>

      {Object.values(Q).map(({ key, label, opts }) => (
        <div key={key}>
          <p className="text-sm font-medium text-text-1 mb-2">{label}</p>
          <div className="flex flex-wrap gap-2">
            {opts.map(o => (
              <button key={o} onClick={() => setAns(a => ({ ...a, [key]: o }))}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors
                  ${ans[key] === o
                    ? 'bg-accent/15 border-accent/40 text-accent'
                    : 'bg-bg-2 border-border text-text-1 hover:border-accent/30'}`}>
                {o}
              </button>
            ))}
          </div>
        </div>
      ))}

      <div>
        <p className="text-sm font-medium text-text-1 mb-2">Anything specific you're struggling with? <span className="text-text-2 font-normal">(optional)</span></p>
        <input value={struggle} maxLength={200} onChange={e => setStruggle(e.target.value)}
          placeholder="e.g. I always blunder in time pressure, I lose rook endgames"
          className="input text-sm" />
      </div>

      <button onClick={submit} disabled={!ready || saving}
        className="btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed">
        {saving ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
        Start coaching
      </button>
    </motion.div>
  )
}

// ── Chat message model ─────────────────────────────────────────────────────────

type Attachment =
  | { kind: 'puzzle'; data: PuzzlePayload }
  | { kind: 'positions'; data: MistakePositionsPayload }
  | { kind: 'analysis'; data: AnalyzePayload }
  | { kind: 'explanation'; data: ExplainPayload }

type Msg =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; streaming?: boolean; attachments: Attachment[]; toolRunning?: string | null; narrationSource?: 'groq' | 'c1' | 'template' }

const MODES: { mode: CoachMode; label: string; icon: any; placeholder: string }[] = [
  { mode: 'coach',  label: 'Coach',  icon: MessageSquare,    placeholder: 'Ask me anything about your chess…' },
  { mode: 'position', label: 'Position', icon: Sparkles, placeholder: 'Why does this move work? What happens if I choose the alternative?' },
  { mode: 'puzzle', label: 'Puzzle', icon: Crosshair,        placeholder: 'Ask for a puzzle on your top weakness…' },
  { mode: 'import', label: 'Import', icon: ClipboardPaste,   placeholder: 'Paste a FEN or PGN to analyse…' },
  { mode: 'theory', label: 'Theory', icon: BookOpen,         placeholder: 'Ask about any opening or endgame…' },
]

const TOOL_LABELS: Record<string, string> = {
  get_puzzle: 'Finding a puzzle…',
  get_mistake_positions: 'Pulling your real mistakes…',
  explain_position: 'Analysing the position…',
  narrate_evidence: 'Explaining the checked evidence…',
  analyze_pgn: 'Running the engine on your game…',
  get_opening_theory: 'Checking opening theory…',
  get_endgame_theory: 'Checking endgame theory…',
}

// ── Attachment rendering ───────────────────────────────────────────────────────

function PuzzleAttachment({ data }: { data: PuzzlePayload }) {
  if (!data.found || !data.fen) {
    return <p className="text-[11px] text-text-2 italic">{data.message || 'No puzzle found.'}</p>
  }
  return (
    <div className="mt-2 p-2 rounded-lg bg-bg-1 border border-border">
      <CoachBoard mode="puzzle" fen={data.fen} fullLineUci={data.full_line_uci}
        solutionUci={data.solution_uci} orientation={data.side_to_move} size={300} />
      <p className="text-[10px] text-text-2 mt-1.5">
        Puzzle {data.puzzle_id} · rating {data.rating}
        {data.themes ? ` · ${data.themes.split(' ').slice(0, 3).join(', ')}` : ''}
      </p>
    </div>
  )
}

// Navigable review of the user's real mistake positions (one board + prev/next
// + live eval) — the in-chat "review mode" board.
function PositionsAttachment({ data }: { data: MistakePositionsPayload }) {
  const [i, setI] = useState(0)
  const positions = data.positions ?? []
  if (!positions.length) return null
  const p = positions[Math.min(i, positions.length - 1)]

  const { data: evalData } = useQuery({
    queryKey: ['coach-eval', p.fen],
    queryFn: () => fetch(`/api/analyse?fen=${encodeURIComponent(p.fen)}&depth=12`).then(r => r.json()),
    staleTime: Infinity, retry: false,
  })
  const cp: number | null = evalData?.eval_cp ?? null
  const whitePct = cp == null ? 50 : Math.max(4, Math.min(96, 50 + 50 * Math.tanh(cp / 400)))

  return (
    <div className="mt-2 p-2.5 rounded-lg bg-bg-1 border border-border">
      <div className="flex items-stretch gap-2">
        {/* tiny eval bar */}
        <div className="w-3 rounded overflow-hidden flex flex-col-reverse flex-shrink-0" style={{ height: 200 }}>
          <div className="bg-[#E8E8F0]" style={{ flex: whitePct }} />
          <div className="bg-bg-3" style={{ flex: 100 - whitePct }} />
        </div>
        <CoachBoard mode="view" fen={p.fen} bestUci={p.best_move} size={200} />
      </div>
      <div className="flex items-center justify-between mt-2">
        <button onClick={() => setI(v => Math.max(0, v - 1))} disabled={i === 0}
          className="btn-ghost text-xs flex items-center gap-1 disabled:opacity-30"><ChevronLeft size={13} /> Prev</button>
        <span className="text-[11px] text-text-2 tabular-nums">{Math.min(i, positions.length - 1) + 1} / {positions.length}</span>
        <button onClick={() => setI(v => Math.min(positions.length - 1, v + 1))} disabled={i >= positions.length - 1}
          className="btn-ghost text-xs flex items-center gap-1 disabled:opacity-30">Next <ChevronRight size={13} /></button>
      </div>
      <p className="text-[10px] text-text-2 mt-1.5">
        move {p.move_number} · played <span className="text-danger">{p.move_played}</span> · −{p.eval_drop_cp}cp ·{' '}
        {p.threat_type?.replace(/_/g, ' ')} · <span className="text-success">best = green</span>
      </p>
    </div>
  )
}

function AnalysisAttachment({ data }: { data: AnalyzePayload }) {
  if (!data.ok) return <p className="text-[11px] text-text-2 italic">{data.message}</p>
  if (data.kind === 'fen' && data.fen) {
    if (data.explanation?.candidates) return <InvestigationEvidence data={data.explanation} />
    return (
      <div className="mt-2 p-2 rounded-lg bg-bg-1 border border-border inline-block">
        <CoachBoard mode="view" fen={data.fen} size={220} />
        {data.explanation?.eval && (
          <p className="text-[10px] text-text-2 mt-1">Engine eval: {data.explanation.eval}</p>
        )}
      </div>
    )
  }
  // PGN
  return (
    <div className="mt-2 p-2.5 rounded-lg bg-bg-1 border border-border text-[11px] text-text-1 space-y-1">
      <p className="text-text-2">{data.mistakes_found} mistakes across {data.plies_analysed} plies — biggest:</p>
      {(data.top_mistakes ?? []).slice(0, 5).map((m, i) => (
        <p key={i}>
          <span className="text-text-2">{m.move_number}{m.side === 'white' ? '.' : '…'}</span>{' '}
          <span className="text-danger font-medium">{m.move_played}</span>{' '}
          <span className="text-text-2">(−{m.eval_drop_cp}cp, best {m.best_move_uci})</span>
        </p>
      ))}
    </div>
  )
}

// ── Page ────────────────────────────────────────────────────────────────────────

export default function Coach() {
  const { username } = useUserStore()
  const [ready, setReady] = useState(false)
  const [investigateOnly, setInvestigateOnly] = useState(false)

  const { data: profile, isLoading, refetch } = useQuery({
    queryKey: ['coach-profile', username],
    queryFn: () => coachApi.getProfile(username),
    enabled: !!username,
  })

  useEffect(() => {
    if (profile?.questionnaire_complete) setReady(true)
  }, [profile])

  if (isLoading) {
    return <div className="flex items-center justify-center h-64">
      <Loader2 className="animate-spin text-accent" />
    </div>
  }

  return (
    <div className="p-8 max-w-3xl mx-auto h-full">
      <SectionHeader icon={Sparkles} title="Coach"
        description="Your personal coach — it knows your games, your blindspots, and your history." />
      {ready || investigateOnly
        ? <ChatView initialMode={investigateOnly ? 'position' : 'coach'} />
        : <>
            <button type="button" onClick={() => setInvestigateOnly(true)} className="btn-ghost mb-4 text-sm">Investigate a position now</button>
            <Questionnaire onComplete={() => { refetch(); setReady(true) }} />
          </>}
    </div>
  )
}

function ChatView({ initialMode = 'coach' }: { initialMode?: CoachMode }) {
  const { username } = useUserStore()
  const [mode, setMode] = useState<CoachMode>(initialMode)
  const [positionFen, setPositionFen] = useState('7k/6pp/8/8/8/8/R7/K7 w - - 0 1')
  const [focusMove, setFocusMove] = useState('')
  const [alternativeMove, setAlternativeMove] = useState('')
  const [budgetSeconds, setBudgetSeconds] = useState(8)
  const [useLlm, setUseLlm] = useState(true)
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [audioOn, setAudioOn] = useState(false)
  const audioOnRef = useRef(false)
  audioOnRef.current = audioOn

  const scrollRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const didGreet = useRef(false)
  const messagesRef = useRef<Msg[]>([])
  messagesRef.current = messages

  const audio = useAudioCoach((text) => { if (text.trim()) void send(text) })

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [messages, streaming])

  // Personalised greeting on first mount.
  useEffect(() => {
    if (!didGreet.current && username && initialMode !== 'position') {
      didGreet.current = true
      void send('', 'coach')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username])

  // Summarise the session into long-term memory when leaving the page.
  useEffect(() => {
    return () => {
      const texts: CoachChatMessage[] = messagesRef.current
        .filter(m => m.content.trim())
        .map(m => ({ role: m.role, content: m.content }))
      if (texts.length >= 3) void coachApi.updateMemory(username, texts)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const history = useMemo<CoachChatMessage[]>(() =>
    messages.filter(m => m.content.trim()).slice(-10).map(m => ({ role: m.role, content: m.content })),
    [messages])

  function patchLastAssistant(fn: (m: Extract<Msg, { role: 'assistant' }>) => Extract<Msg, { role: 'assistant' }>) {
    setMessages(prev => {
      const next = [...prev]
      for (let i = next.length - 1; i >= 0; i--) {
        const m = next[i]
        if (m.role === 'assistant') { next[i] = fn(m); break }
      }
      return next
    })
  }

  async function send(text: string, forceMode?: CoachMode) {
    const message = text.trim()
    const useMode = forceMode ?? mode
    // Allow empty only for the auto-greeting.
    if (streaming || (!message && didGreet.current && text !== '')) return
    if (!message && messagesRef.current.length > 0) return

    const baseHistory = history
    if (message) setMessages(prev => [...prev, { role: 'user', content: useMode === 'position' ? `${message}\n\nPosition: ${positionFen}${focusMove ? `\nMove: ${focusMove}` : ''}${alternativeMove ? `\nAlternative: ${alternativeMove}` : ''}` : message }])
    setMessages(prev => [...prev, { role: 'assistant', content: '', streaming: true, attachments: [], toolRunning: null }])
    setInput(''); setError(null); setStreaming(true)

    const ctrl = new AbortController()
    abortRef.current = ctrl
    let acc = ''

    try {
      await coachApi.chatStream(
        { username, message, mode: useMode, conversation_history: baseHistory,
          ...(useMode === 'position' ? { position_fen: positionFen, focus_move: focusMove || undefined,
            alternative_move: alternativeMove || undefined, budget_seconds: budgetSeconds, use_llm: useLlm } : {}) },
        (evt: CoachStreamEvent) => {
          if (evt.type === 'tool') {
            patchLastAssistant(m => ({ ...m, toolRunning: TOOL_LABELS[evt.name] ?? 'Working…' }))
          } else if (evt.type === 'tool_result') {
            const att = toAttachment(evt.name, evt.payload)
            if (evt.name === 'explain_position' && 'fen' in evt.payload && evt.payload.fen) setPositionFen(evt.payload.fen)
            patchLastAssistant(m => ({
              ...m, toolRunning: null,
              attachments: att ? [...m.attachments, att] : m.attachments,
            }))
          } else if (evt.type === 'token') {
            acc += evt.text
            patchLastAssistant(m => ({ ...m, content: acc, toolRunning: null }))
          } else if (evt.type === 'meta' && evt.narration_source) {
            patchLastAssistant(m => ({ ...m, narrationSource: evt.narration_source,
              attachments: m.attachments.map(att => att.kind === 'explanation'
                ? { ...att, data: { ...att.data, narration_source: evt.narration_source, narration_warnings: evt.narration_warnings } }
                : att) }))
          } else if (evt.type === 'error') {
            throw new Error(evt.message)
          }
        },
        ctrl.signal,
      )
      patchLastAssistant(m => ({ ...m, streaming: false }))
      if (audioOnRef.current && acc.trim()) audio.speak(acc)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Coach unavailable'
      if (!msg.toLowerCase().includes('abort')) setError(msg)
      patchLastAssistant(m => ({ ...m, streaming: false, toolRunning: null }))
      setMessages(prev => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (last?.role === 'assistant' && !last.content && last.attachments.length === 0) next.pop()
        return next
      })
    } finally {
      setStreaming(false); abortRef.current = null
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (input.trim()) send(input)
  }

  function clearChat() {
    abortRef.current?.abort()
    setMessages([]); setError(null); didGreet.current = false
    // re-greet
    if (mode !== 'position') setTimeout(() => { didGreet.current = true; void send('', 'coach') }, 50)
  }

  const placeholder = MODES.find(m => m.mode === mode)?.placeholder ?? 'Ask me anything…'

  return (
    <div className="card p-0 flex flex-col" style={{ height: 'calc(100vh - 220px)', minHeight: 460 }}>
      {/* Mode bar */}
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2.5 border-b border-border">
        {MODES.map(({ mode: m, label, icon: Icon }) => (
          <button key={m} onClick={() => setMode(m)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors
              ${mode === m ? 'bg-accent/15 text-accent border border-accent/30'
                           : 'text-text-2 hover:text-text-1 hover:bg-bg-2 border border-transparent'}`}>
            <Icon size={13} /> {label}
          </button>
        ))}
        <button
          onClick={() => { if (audio.supported) { setAudioOn(v => !v); audio.stopSpeaking() } }}
          disabled={!audio.supported}
          title={audio.supported ? 'Audio mode — speak & hear replies' : 'Audio needs Chrome or Edge'}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors
            ${!audio.supported ? 'text-text-2/40 cursor-not-allowed border-transparent'
              : audioOn ? 'bg-accent/15 text-accent border-accent/30'
              : 'text-text-2 hover:text-text-1 hover:bg-bg-2 border-transparent'}`}>
          {audioOn ? <Volume2 size={13} /> : <Mic size={13} />} Audio
        </button>
        <div className="flex-1" />
        {messages.length > 0 && (
          <button onClick={clearChat} className="p-1.5 rounded-md text-text-2 hover:text-text-0 hover:bg-bg-2" title="New session">
            <RotateCcw size={13} />
          </button>
        )}
      </div>

      {mode === 'position' && (
        <div className="px-3 py-3 border-b border-border space-y-2 text-xs">
          <label className="block text-text-1">Position FEN
            <input aria-label="Position FEN" value={positionFen} onChange={e => { setPositionFen(e.target.value); setFocusMove(''); setAlternativeMove('') }} className="input mt-1 text-xs font-mono" />
          </label>
          <div className="flex flex-wrap gap-2">
            <label className="flex-1 min-w-[100px] text-text-2">Your move (optional)
              <input aria-label="Focus move" value={focusMove} onChange={e => setFocusMove(e.target.value)} placeholder="SAN or UCI, e.g. Nf6+" className="input mt-1 text-xs" />
            </label>
            <label className="flex-1 min-w-[100px] text-text-2">Alternative (optional)
              <input aria-label="Alternative move" value={alternativeMove} onChange={e => setAlternativeMove(e.target.value)} placeholder="e.g. Ne3" className="input mt-1 text-xs" />
            </label>
            <label className="text-text-2">Analysis time
              <select aria-label="Analysis time" value={budgetSeconds} onChange={e => setBudgetSeconds(Number(e.target.value))} className="input mt-1 text-xs">
                <option value={3}>Quick · 3s</option><option value={8}>Standard · 8s</option><option value={15}>Deeper · 15s</option>
              </select>
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-text-2">
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={useLlm} onChange={e => setUseLlm(e.target.checked)} />Use AI wording</label>
            <span>Try:</span>
            {[
              ['Mate', '7k/6pp/8/8/8/8/R7/K7 w - - 0 1'],
              ['Fork', '8/3q3k/8/3N4/8/8/8/6K1 w - - 0 1'],
              ['Opening', 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3'],
            ].map(([label, fen]) => <button type="button" key={label} onClick={() => { setPositionFen(fen); setFocusMove(''); setAlternativeMove(''); setInput('Compare the candidates and explain what the lines establish.') }} className="text-accent hover:underline">{label}</button>)}
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 && !streaming && (
          <div className="h-full flex flex-col items-center justify-center text-center">
            <Bot size={20} className="text-text-2 mb-2" />
            <p className="text-sm text-text-1">{mode === 'position' ? 'Choose a position and ask your question below.' : 'Your coach is warming up…'}</p>
          </div>
        )}
        {messages.map((m, i) => m.role === 'user' ? (
          <div key={i} className="flex justify-end">
            <div className="max-w-[80%] rounded-2xl rounded-br-sm px-3.5 py-2 text-sm bg-accent/15 border border-accent/20 text-text-0 whitespace-pre-wrap">
              {m.content}
            </div>
          </div>
        ) : (
          <div key={i} className="flex justify-start">
            <div className="max-w-[92%] rounded-2xl rounded-bl-sm px-3.5 py-2.5 text-sm bg-bg-2 border border-border text-text-1 space-y-1">
              {!m.content && !m.attachments.length && (
                <span className="text-text-2 inline-flex items-center gap-1.5">
                  <Loader2 size={12} className="animate-spin text-accent" />
                  {m.toolRunning ?? 'Thinking…'}
                </span>
              )}
              {m.content && <div className="whitespace-pre-wrap leading-relaxed">{m.content}
                {m.streaming && <span className="inline-block w-1.5 h-3.5 bg-accent ml-0.5 align-middle animate-pulse" />}
              </div>}
              {m.narrationSource && <p className="text-[10px] text-text-2">{m.narrationSource !== 'template' ? 'AI wording from the evidence; verification labels apply to the checked claims below.' : 'Local evidence summary.'}</p>}
              {m.toolRunning && m.content && (
                <span className="text-[11px] text-text-2 inline-flex items-center gap-1.5">
                  <Loader2 size={11} className="animate-spin text-accent" /> {m.toolRunning}
                </span>
              )}
              {m.attachments.map((att, j) => (
                <div key={j}>
                  {att.kind === 'puzzle' && <PuzzleAttachment data={att.data} />}
                  {att.kind === 'positions' && <PositionsAttachment data={att.data} />}
                  {att.kind === 'analysis' && <AnalysisAttachment data={att.data} />}
                  {att.kind === 'explanation' && <InvestigationEvidence data={att.data} />}
                </div>
              ))}
            </div>
          </div>
        ))}
        <div ref={scrollRef} />
      </div>

      {error && <p className="px-4 pb-1 text-[11px] text-danger">{error}</p>}
      {audioOn && !audio.supported && (
        <p className="px-4 pb-1 text-[11px] text-amber-300">Audio mode requires Chrome or Edge.</p>
      )}
      {audioOn && audio.listening && (
        <p className="px-4 pb-1 text-[11px] text-accent flex items-center gap-1.5">
          <Mic size={11} className="animate-pulse" /> Listening… {audio.interim && <span className="text-text-2 italic">{audio.interim}</span>}
        </p>
      )}

      {/* Input */}
      <form onSubmit={handleSubmit} className="flex items-end gap-2 p-3 border-t border-border">
        {audioOn && audio.supported && (
          <button type="button"
            onClick={() => { audio.speaking && audio.stopSpeaking(); audio.listening ? audio.stopListening() : audio.startListening() }}
            title={audio.listening ? 'Stop listening' : 'Push to talk'}
            className={`w-9 h-9 rounded-md flex items-center justify-center flex-shrink-0 transition-colors border
              ${audio.listening ? 'bg-danger/20 text-danger border-danger/40 animate-pulse'
                : 'bg-bg-2 text-text-1 border-border hover:text-accent'}`}>
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
          rows={mode === 'import' ? 3 : 1}
          placeholder={audioOn ? 'Speak, or type…' : placeholder}
          className="input text-sm py-2 resize-none flex-1"
        />
        <button type="submit" disabled={streaming || !input.trim()}
          className="w-9 h-9 rounded-md bg-accent hover:bg-accent-hover text-white flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex-shrink-0">
          {streaming ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
        </button>
      </form>
    </div>
  )
}

function toAttachment(name: string, payload: any): Attachment | null {
  if (name === 'get_puzzle') return { kind: 'puzzle', data: payload as PuzzlePayload }
  if (name === 'get_mistake_positions') return { kind: 'positions', data: payload as MistakePositionsPayload }
  if (name === 'analyze_pgn') return { kind: 'analysis', data: payload as AnalyzePayload }
  if (name === 'explain_position') return { kind: 'explanation', data: payload as ExplainPayload }
  return null
}
