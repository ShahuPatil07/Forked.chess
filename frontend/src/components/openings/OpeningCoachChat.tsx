import { type FormEvent, useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Bot, Loader2, RotateCcw, Send, Sparkles, X, ExternalLink, BookMarked } from 'lucide-react'
import {
  START_FEN,
  openingsApi,
  type OpeningChatSource,
  type OpeningMove,
} from '../../api/openings'
import { useUserStore } from '../../store/userStore'
import { MiniBoardThumbnail } from './MiniBoardThumbnail'

interface OpeningCoachChatProps {
  selected:   { move: OpeningMove; path: string; depth: number } | null
  parentName: string | null
}

// ── Message types ────────────────────────────────────────────────────────────

type ChatPart =
  | { kind: 'user';      content: string }
  | { kind: 'assistant'; content: string; sources: OpeningChatSource[]; streaming?: boolean }
  | { kind: 'divider';   text: string }

const FALLBACK_GENERAL = [
  'Best openings for my rating?',
  'How to handle the Sicilian?',
  'Explain the Italian Game',
  "What's a solid opening for Black?",
]

// ── Component ────────────────────────────────────────────────────────────────

export function OpeningCoachChat({ selected, parentName }: OpeningCoachChatProps) {
  const { username, elo } = useUserStore()
  const [input, setInput]       = useState('')
  const [parts, setParts]       = useState<ChatPart[]>([])
  const [streaming, setStreaming] = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const [chips, setChips]       = useState<string[]>(FALLBACK_GENERAL)
  const [chipsLoading, setChipsLoading] = useState(false)
  const [contextActive, setContextActive] = useState(false)

  const scrollRef    = useRef<HTMLDivElement>(null)
  const lastSelected = useRef<string | null>(null)
  const abortRef     = useRef<AbortController | null>(null)

  const displayName = useMemo(() => {
    if (contextActive && selected) {
      return selected.move.name || parentName || 'Opening position'
    }
    return 'Opening coach'
  }, [parentName, selected, contextActive])

  const disabledReason = !username ? 'Set a profile first' : null

  // Auto-scroll
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [parts, streaming])

  // ── Sync context with tree selection ──────────────────────────────────────

  useEffect(() => {
    const key = selected?.path ?? null

    // Newly selected something
    if (key && key !== lastSelected.current) {
      setContextActive(true)
      lastSelected.current = key
      if (parts.length > 0) {
        const label = selected?.move.name || 'Opening position'
        setParts(prev => [...prev, { kind: 'divider', text: `${label} set as context` }])
      }
    }

    // Selection cleared externally (e.g. tree deselect)
    if (!key && lastSelected.current) {
      lastSelected.current = null
      setContextActive(false)
      if (parts.length > 0) {
        setParts(prev => [...prev, { kind: 'divider', text: 'Context cleared' }])
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.path])

  function clearContext() {
    setContextActive(false)
    lastSelected.current = null
    if (parts.length > 0) {
      setParts(prev => [...prev, { kind: 'divider', text: 'Context cleared' }])
    }
  }

  // ── Suggestion chip loader ────────────────────────────────────────────────

  const loadChips = useCallback(async () => {
    const eco  = contextActive ? (selected?.move.eco ?? '')  : ''
    const name = contextActive ? (selected?.move.name ?? '') : ''
    setChipsLoading(true)
    try {
      const res = await openingsApi.suggestions(eco, name, elo || null)
      setChips(res.chips.length > 0 ? res.chips : FALLBACK_GENERAL)
    } catch {
      setChips(FALLBACK_GENERAL)
    } finally {
      setChipsLoading(false)
    }
  }, [contextActive, selected, elo])

  useEffect(() => {
    loadChips()
  }, [loadChips])

  // ── Stream the chat response ──────────────────────────────────────────────

  const recentUserMessages = useMemo(() => {
    const msgs: { role: 'user' | 'assistant'; content: string }[] = []
    for (const p of parts) {
      if (p.kind === 'user')      msgs.push({ role: 'user',      content: p.content })
      if (p.kind === 'assistant') msgs.push({ role: 'assistant', content: p.content })
    }
    return msgs.slice(-8)
  }, [parts])

  async function sendMessage(text: string) {
    const message = text.trim()
    if (!message || !username || streaming) return

    // Append user message + placeholder assistant message
    setParts(prev => [
      ...prev,
      { kind: 'user',      content: message },
      { kind: 'assistant', content: '', sources: [], streaming: true },
    ])
    setInput('')
    setError(null)
    setStreaming(true)

    const ctrl = new AbortController()
    abortRef.current = ctrl

    let accumulated = ''
    let sources: OpeningChatSource[] = []

    try {
      await openingsApi.chatStream({
        username,
        message,
        fen:                  contextActive ? (selected?.move.fen_after ?? START_FEN) : START_FEN,
        moves:                contextActive ? (selected?.path ?? '')                  : '',
        opening_name:         contextActive ? (selected?.move.name ?? '')             : '',
        eco:                  contextActive ? (selected?.move.eco ?? '')              : '',
        use_position_context: contextActive,
        chat_history:         recentUserMessages,
      }, (evt) => {
        if (evt.type === 'meta') {
          sources = evt.sources
          // Patch the last assistant part with sources
          setParts(prev => {
            const next = [...prev]
            const last = next[next.length - 1]
            if (last?.kind === 'assistant') {
              next[next.length - 1] = { ...last, sources }
            }
            return next
          })
        } else if (evt.type === 'token') {
          accumulated += evt.text
          setParts(prev => {
            const next = [...prev]
            const last = next[next.length - 1]
            if (last?.kind === 'assistant') {
              next[next.length - 1] = { ...last, content: accumulated, sources }
            }
            return next
          })
        } else if (evt.type === 'error') {
          throw new Error(evt.message)
        }
      }, ctrl.signal)

      // Finalize streaming flag
      setParts(prev => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (last?.kind === 'assistant') {
          next[next.length - 1] = { ...last, streaming: false }
        }
        return next
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Opening coach unavailable'
      // Skip showing "aborted" messages
      if (!msg.toLowerCase().includes('abort')) setError(msg)
      // Remove the incomplete assistant message
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

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="card p-0 flex flex-col" style={{ minHeight: 480 }}>
      {/* Sticky header — stays visible while the card scrolls within the rail */}
      <div className="sticky top-0 z-10 px-4 pt-4 pb-3 bg-bg-1/95 backdrop-blur-sm
                      border-b border-border rounded-t-lg flex items-center gap-2">
        <div className="w-7 h-7 rounded-md bg-accent/15 border border-accent/20
                        flex items-center justify-center text-accent flex-shrink-0">
          <Bot size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-text-0 truncate">{displayName}</p>
          <p className="text-[10px] text-text-2 truncate">
            Grounded in Lichess stats + curated opening literature
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
        {contextActive && selected && (
          <motion.div
            initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
            className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-accent/8 border border-accent/20"
          >
            <MiniBoardThumbnail fen={selected.move.fen_after} size={26} />
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-medium text-text-0 truncate">
                {selected.move.name || parentName || 'Position'}
              </p>
              {selected.move.eco && (
                <p className="text-[10px] text-text-2">
                  ECO {selected.move.eco} · context active
                </p>
              )}
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
      <div className="flex-1 overflow-y-auto pr-1 space-y-2 min-h-[180px]">
        {parts.length === 0 ? (
          <div className="h-full min-h-[180px] flex flex-col justify-center text-center px-2">
            <Sparkles size={16} className="text-text-2 mx-auto mb-2" />
            <p className="text-xs text-text-1 font-medium">
              {contextActive ? 'Ask about this position' : 'Ask any opening question'}
            </p>
            <p className="text-[11px] text-text-2 leading-relaxed mt-1">
              Grounded in real Lichess data, Stockfish evaluation,
              {' '}and a curated chess opening corpus.
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
          // Assistant
          return (
            <div key={i}
              className="rounded-lg px-3 py-2 text-xs leading-relaxed
                         bg-bg-2 text-text-1 mr-3 border border-border space-y-1.5">
              <div className="whitespace-pre-wrap">
                {p.content || (
                  <span className="text-text-2 inline-flex items-center gap-1.5">
                    <Loader2 size={11} className="animate-spin text-accent" />
                    Thinking through the line…
                  </span>
                )}
                {p.streaming && p.content && (
                  <span className="inline-block w-1.5 h-3 bg-accent ml-0.5 align-middle animate-pulse" />
                )}
              </div>
              {p.sources && p.sources.length > 0 && !p.streaming && (
                <div className="flex items-center gap-1.5 flex-wrap pt-1 border-t border-border/50">
                  <BookMarked size={9} className="text-text-2 flex-shrink-0" />
                  <span className="text-[9px] text-text-2 uppercase tracking-wider">Sources:</span>
                  {p.sources.map((s, j) => (
                    <a key={j} href={s.url} target="_blank" rel="noopener noreferrer"
                      className="text-[10px] text-accent hover:underline inline-flex items-center gap-0.5">
                      {s.label}
                      <ExternalLink size={8} />
                    </a>
                  ))}
                </div>
              )}
            </div>
          )
        })}
        <div ref={scrollRef} />
      </div>

      {/* Suggestion chips */}
      <div className="grid grid-cols-2 gap-1.5">
        {chipsLoading && chips === FALLBACK_GENERAL
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

      {/* Error */}
      {error && (
        <p className="text-[11px] text-danger leading-relaxed">{error}</p>
      )}

      {/* Input */}
      <form onSubmit={handleSubmit} className="flex items-center gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={!!disabledReason}
          placeholder={disabledReason || 'Ask about openings, plans, traps, or move choices'}
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
