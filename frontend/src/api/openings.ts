/**
 * Opening Explorer API client.
 * All endpoints under /api/openings/* (proxied to backend by Vite).
 */

export interface OpeningMove {
  san:        string
  uci:        string
  name:       string
  eco:        string
  popularity: number
  w:          number    // white-win %
  d:          number    // draw %
  l:          number    // black-win %
  games:      number
  ideas:      string | null
  eval:       string | null
  fen_after:  string
}

export interface ExploreResponse {
  opening:    { name: string; eco: string } | null
  moves:      OpeningMove[]
  elo_bucket: string
}

export interface EvalResponse {
  eval:   string
  depth:  number
  cached: boolean
}

export interface IdeasResponse {
  ideas:  string
  cached: boolean
}

export interface OpeningChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface OpeningChatCandidate {
  san:        string
  uci:        string
  name:       string
  popularity: number
  white:      number
  draws:      number
  black:      number
  games:      number
}

export interface OpeningChatSource {
  label: string
  url:   string
}

export interface OpeningChatResponse {
  answer:          string
  elo:             number
  elo_bucket:      string
  opening_name:    string
  eco:             string
  candidate_moves: OpeningChatCandidate[]
  sources:         OpeningChatSource[]
}

export interface OpeningChatStreamMeta {
  type:            'meta'
  elo:             number
  elo_bucket:      string
  opening_name:    string
  eco:             string
  candidate_moves: OpeningChatCandidate[]
  sources:         OpeningChatSource[]
}

export type OpeningChatStreamEvent =
  | OpeningChatStreamMeta
  | { type: 'token'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

export interface OpeningChatSuggestResponse {
  eco:         string
  opening:     string
  rating_band: string
  chips:       string[]
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(text || `HTTP ${res.status}`)
  }
  return res.json()
}

export const openingsApi = {
  explore: (fen?: string, moves?: string, elo?: number | null) => {
    const params = new URLSearchParams()
    if (fen)              params.set('fen',   fen)
    if (moves)            params.set('moves', moves)
    if (elo != null)      params.set('elo',   String(elo))
    const qs = params.toString()
    return req<ExploreResponse>(`/api/openings/explore${qs ? '?' + qs : ''}`)
  },

  getEval: (fen: string) =>
    req<EvalResponse>(`/api/openings/eval?fen=${encodeURIComponent(fen)}`),

  getIdeas: (body: { fen: string; move: string; opening_name: string; side_to_move: string }) =>
    req<IdeasResponse>(`/api/openings/ideas`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    }),

  chat: (body: {
    username: string
    message: string
    fen: string
    moves: string
    opening_name?: string
    eco?: string
    use_position_context?: boolean
    chat_history?: OpeningChatMessage[]
  }) =>
    req<OpeningChatResponse>(`/api/openings/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    }),

  suggestions: (eco: string, openingName: string, elo: number | null) => {
    const p = new URLSearchParams()
    if (eco)          p.set('eco', eco)
    if (openingName)  p.set('opening_name', openingName)
    if (elo != null)  p.set('elo', String(elo))
    return req<OpeningChatSuggestResponse>(`/api/openings/chat/suggestions?${p.toString()}`)
  },

  /**
   * Stream chat tokens via fetch + manual ReadableStream parsing.
   * (EventSource only supports GET, so we use POST + manual SSE parse.)
   */
  chatStream: async (
    body: {
      username: string
      message: string
      fen: string
      moves: string
      opening_name?: string
      eco?: string
      use_position_context?: boolean
      chat_history?: OpeningChatMessage[]
    },
    onEvent: (evt: OpeningChatStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> => {
    const res = await fetch('/api/openings/chat/stream', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal,
    })
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(text || `HTTP ${res.status}`)
    }
    const reader  = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (!payload) continue
        try {
          const evt = JSON.parse(payload) as OpeningChatStreamEvent
          onEvent(evt)
          if (evt.type === 'done' || evt.type === 'error') return
        } catch { /* ignore malformed lines */ }
      }
    }
  },
}

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
