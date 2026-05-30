import { type FormEvent, useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Bot, Loader2, RotateCcw, Send, Sparkles, X, ExternalLink, BookMarked, ShieldCheck } from 'lucide-react'
import {
  endgamesApi,
  type EndgameCoachSource,
} from '../../api/endgames'
import { useUserStore } from '../../store/userStore'
import { ENDGAME_CATEGORY_LABELS, type EndgameCategory } from '../../data/endgameTree'

// ── Coach context (set by tabs to seed the next message) ─────────────────────

export interface CoachContext {
  fen:           string
  category:      string
  /** Pre-fill the input box with this question; user can still edit/submit. */
  prefillPrompt?: string
  label?:        string
}

interface Props {
  /** Set when the user clicks "Ask the coach" from Theory or Practice tab. */
  externalContext: CoachContext | null
  /** Reset so the same external context doesn't re-fire on every render. */
  onContextConsumed: () => void
}

// ── Internal types ───────────────────────────────────────────────────────────

type ChatPart =
  | { kind: 'user';      content: string }
  | { kind: 'assistant'; content: string; sources: EndgameCoachSource[]; syzygyVerified: boolean; streaming?: boolean }
  | { kind: 'divider';   text: string }

const FALLBACK_CHIPS = [
  'How to play the Lucena?',
  'Explain the Philidor position',
  'When is K+B+N vs K a draw?',
  'Rook endgame principles',
]

// ── Component ────────────────────────────────────────────────────────────────

export function EndgameCoach({ externalContext, onContextConsumed }: Props) {
  const { username, elo } = useUserStore()

  const [input,     setInput]     = useState('')
  const [parts,     setParts]     = useState<ChatPart[]>([])
  const [streaming, setStreaming] = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const [chips,     setChips]     = useState<string[]>(FALLBACK_CHIPS)
  const [chipsLoading, setChipsLoading] = useState(false)

  // Context owned by the coach (independent of tree/practice selection)
  const [ctx, setCtx]                   = useState<CoachContext | null>(null)
  const lastExternalRef                 = useRef<string | null>(null)
  const abortRef                        = useRef<AbortController | null>(null)
  const scrollRef                       = useRef<HTMLDivElement>(null)

  // ── Receive context from external tabs ────────────────────────────────────
  useEffect(() => {
    if (!externalContext) return
    const key = externalContext.fen + '|' + (externalContext.prefillPrompt ?? '')
    if (key === lastExternalRef.current) return
    lastExternalRef.current = key

    setCtx(externalContext)
    if (externalContext.prefillPrompt) setInput(externalContext.prefillPrompt)
    if (parts.length > 0) {
      const label = externalContext.label ?? `${ENDGAME_CATEGORY_LABELS[externalContext.category as EndgameCategory] ?? externalContext.category} position`
      setParts(prev => [...prev, { kind: 'divider', text: `${label} set as context` }])
    }
    onContextConsumed()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalContext])

  function clearContext() {
    setCtx(null)
    if (parts.length > 0) setParts(prev => [...prev, { kind: 'divider', text: 'Context cleared' }])
  }

  // ── Auto-scroll to latest ─────────────────────────────────────────────────
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [parts, streaming])

  // ── Suggestion chips ──────────────────────────────────────────────────────
  const loadChips = useCallback(async () => {
    const cat = ctx?.category ?? ''
    setChipsLoading(true)
    try {
      const res = await endgamesApi.coachSuggestions(cat, elo || null)
      setChips(res.chips.length > 0 ? res.chips : FALLBACK_CHIPS)
    } catch {
      setChips(FALLBACK_CHIPS)
    } finally {
      setChipsLoading(false)
    }
  }, [ctx?.category, elo])

  useEffect(() => { loadChips() }, [loadChips])

  // ── Send message ──────────────────────────────────────────────────────────
  const historyForBackend = useMemo(() => {
    const out: { role: 'user' | 'assistant'; content: string }[] = []
    for (const p of parts) {
      if (p.kind === 'user')      out.push({ role: 'user',      content: p.content })
      if (p.kind === 'assistant') out.push({ role: 'assistant', content: p.content })
    }
    return out.slice(-8)
  }, [parts])

  async function sendMessage(text: string) {
    const message = text.trim()
    if (!message || !username || streaming) return

    setParts(prev => [
      ...prev,
      { kind: 'user',      content: message },
      { kind: 'assistant', content: '', sources: [], syzygyVerified: false, streaming: true },
    ])
    setInput('')
    setError(null)
    setStreaming(true)

    const ctrl = new AbortController()
    abortRef.current = ctrl

    let accumulated  = ''
    let sources: EndgameCoachSource[] = []
    let syzVerified  = false

    try {
      await endgamesApi.coachStream({
        username,
        message,
        fen:          ctx?.fen ?? '',
        category:     ctx?.category ?? '',
        chat_history: historyForBackend,
      }, (evt) => {
        if (evt.type === 'meta') {
          sources     = evt.sources
          syzVerified = evt.syzygy_verified
          setParts(prev => {
            const next = [...prev]
            const last = next[next.length - 1]
            if (last?.kind === 'assistant') {
              next[next.length - 1] = { ...last, sources, syzygyVerified: syzVerified }
            }
            return next
          })
        } else if (evt.type === 'token') {
          accumulated += evt.text
          setParts(prev => {
            const next = [...prev]
            const last = next[next.length - 1]
            if (last?.kind === 'assistant') {
              next[next.length - 1] = { ...last, content: accumulated, sources, syzygyVerified: syzVerified }
            }
            return next
          })
        } else if (evt.type === 'error') {
          throw new Error(evt.message)
        }
      }, ctrl.signal)

      setParts(prev => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (last?.kind === 'assistant') next[next.length - 1] = { ...last, streaming: false }
        return next
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Coach unavailable'
      if (!msg.toLowerCase().includes('abort')) setError(msg)
      setParts(prev => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (last?.kind === 'assistant' && !last.content) next.pop()
        return next
      })
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    sendMessage(input)
  }

  function clearAll() {
    abortRef.current?.abort()
    setParts([])
    setError(null)
    setStreaming(false)
  }

  const disabledReason = !username ? 'Set a profile first' : null

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="card p-0 flex flex-col" style={{ minHeight: 600 }}>
      {/* Sticky header */}
      <div className="sticky top-0 z-10 px-4 pt-4 pb-3 bg-bg-1/95 backdrop-blur-sm
                      border-b border-border rounded-t-lg flex items-center gap-2">
        <div className="w-7 h-7 rounded-md bg-accent/15 border border-accent/20
                        flex items-center justify-center text-accent flex-shrink-0">
          <Bot size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-text-0 truncate">Endgame coach</p>
          <p className="text-[10px] text-text-2 truncate">
            Grounded in Syzygy tablebase + curated endgame literature
          </p>
        </div>
        {parts.length > 0 && (
          <button onClick={clearAll}
            className="p-1.5 rounded-md text-text-2 hover:text-text-0 hover:bg-bg-2"
            title="Clear chat">
            <RotateCcw size={12} />
          </button>
        )}
      </div>

      {/* Body */}
      <div className="px-4 pt-3 pb-4 space-y-3 flex flex-col flex-1">
        {/* Context indicator */}
        <AnimatePresence>
          {ctx && (
            <motion.div
              initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
              className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-accent/8 border border-accent/20"
            >
              <Sparkles size={11} className="text-accent flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-medium text-text-0 truncate">
                  {ctx.label ?? `Position context (${ENDGAME_CATEGORY_LABELS[ctx.category as EndgameCategory] ?? ctx.category})`}
                </p>
              </div>
              <button onClick={clearContext}
                className="p-1 rounded hover:bg-bg-3 text-text-2 hover:text-text-0"
                title="Use coach without position context">
                <X size={11} />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Conversation */}
        <div className="flex-1 overflow-y-auto pr-1 space-y-2 min-h-[260px]">
          {parts.length === 0 ? (
            <div className="h-full min-h-[260px] flex flex-col justify-center text-center px-2">
              <Sparkles size={16} className="text-text-2 mx-auto mb-2" />
              <p className="text-xs text-text-1 font-medium">
                {ctx ? 'Ask about this endgame' : 'Ask any endgame question'}
              </p>
              <p className="text-[11px] text-text-2 leading-relaxed mt-1">
                Tablebase-verified answers for ≤7-piece positions,
                {' '}grounded in classical endgame theory.
              </p>
            </div>
          ) : parts.map((p, i) => {
            if (p.kind === 'divider') {
              return (
                <div key={i} className="flex items-center gap-2 py-1.5">
                  <div className="flex-1 h-px bg-border" />
                  <span className="text-[10px] text-text-2 italic">{p.text}</span>
                  <div className="flex-1 h-px bg-border" />
                </div>
              )
            }
            if (p.kind === 'user') {
              return (
                <div key={i}
                  className="rounded-lg px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap
                             bg-accent/15 text-text-0 ml-6 border border-accent/20">
                  {p.content}
                </div>
              )
            }
            return (
              <div key={i}
                className="rounded-lg px-3 py-2 text-xs leading-relaxed
                           bg-bg-2 text-text-1 mr-3 border border-border space-y-1.5">
                <div className="whitespace-pre-wrap">
                  {p.content || (
                    <span className="text-text-2 inline-flex items-center gap-1.5">
                      <Loader2 size={11} className="animate-spin text-accent" />
                      Reasoning through the endgame…
                    </span>
                  )}
                  {p.streaming && p.content && (
                    <span className="inline-block w-1.5 h-3 bg-accent ml-0.5 align-middle animate-pulse" />
                  )}
                </div>

                {/* Badges below the response */}
                {!p.streaming && (p.syzygyVerified || (p.sources && p.sources.length > 0)) && (
                  <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-border/50">
                    {p.syzygyVerified && (
                      <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded
                                       bg-success/15 text-success border border-success/30 font-medium">
                        <ShieldCheck size={9} /> Tablebase verified
                      </span>
                    )}
                    {p.sources && p.sources.length > 0 && (
                      <>
                        <BookMarked size={9} className="text-text-2 flex-shrink-0" />
                        <span className="text-[9px] text-text-2 uppercase tracking-wider">Sources:</span>
                        {p.sources.map((s, j) => (
                          <a key={j} href={s.url} target="_blank" rel="noopener noreferrer"
                            className="text-[10px] text-accent hover:underline inline-flex items-center gap-0.5">
                            {s.label}
                            <ExternalLink size={8} />
                          </a>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })}
          <div ref={scrollRef} />
        </div>

        {/* Suggestion chips */}
        <div className="grid grid-cols-2 gap-1.5">
          {chipsLoading && chips === FALLBACK_CHIPS
            ? [0,1,2,3].map(i => (
                <div key={i} className="h-7 rounded-md bg-bg-2 border border-border animate-pulse" />
              ))
            : chips.slice(0, 4).map(prompt => (
                <button
                  key={prompt}
                  onClick={() => sendMessage(prompt)}
                  disabled={!!disabledReason || streaming}
                  className="px-2 py-1.5 rounded-md bg-bg-2 border border-border text-[10px]
                             text-text-1 hover:text-text-0 hover:bg-bg-3 text-left
                             disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {prompt}
                </button>
              ))}
        </div>

        {error && <p className="text-[11px] text-danger leading-relaxed">{error}</p>}

        <form onSubmit={handleSubmit} className="flex items-center gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={!!disabledReason}
            placeholder={disabledReason || 'Ask about any endgame — theory, plans, defences'}
            className="input text-xs py-2"
          />
          <button
            type="submit"
            disabled={!!disabledReason || streaming || !input.trim()}
            className="w-9 h-9 rounded-md bg-accent hover:bg-accent-hover text-white
                       flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed
                       transition-colors"
            title="Send"
          >
            {streaming ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          </button>
        </form>
      </div>
    </div>
  )
}
