/**
 * Endgames API client.
 * All endpoints under /api/endgames/* (proxied to backend by Vite).
 */

export interface EndgamePracticePosition {
  fen:          string
  category:     string
  difficulty:   string
  objective:    string         // "win_white" | "win_black" | "draw" | "depends"
  description:  string
  dtm:          number | null
}

export type PieceCounts = { Q: number; R: number; B: number; N: number; P: number }

export interface ByConfigRequest {
  white_pieces: Partial<PieceCounts>
  black_pieces: Partial<PieceCounts>
  description:  string
  exclude_fens: string[]
  maia_elo:     number
}

export interface ByConfigResponse {
  fen:           string
  description:   string
  source:        string         // "puzzle_db" | "generated"
  eval_cp:       number | null
  complexity:    string         // "high" | "moderate"
  syzygy_result: string | null  // "win" | "loss" | "draw" | ...
  side_to_move:  string         // "white" | "black"
  material:      string         // e.g. "K+Q+2P vs K+Q+P"
}

export interface EndgameSyzygy {
  fen:         string
  category:    string | null   // "win" | "loss" | "draw" | "cursed-win" | "blessed-loss"
  dtm:         number | null
  dtz:         number | null
  best_move:   string | null
  cached:      boolean
  available:   boolean         // false = >7 pieces, not in tablebase
}

export interface EndgameCoachSource { label: string; url: string }

export interface EndgameCoachChatMessage {
  role:    'user' | 'assistant'
  content: string
}

export interface EndgameCoachChatResponse {
  answer:           string
  elo:              number
  rating_band:      string
  sources:          EndgameCoachSource[]
  syzygy_verified:  boolean
}

export interface EndgameCoachStreamMeta {
  type:             'meta'
  elo:              number
  rating_band:      string
  sources:          EndgameCoachSource[]
  syzygy_verified:  boolean
  syzygy:           EndgameSyzygy | null
}

export type EndgameCoachStreamEvent =
  | EndgameCoachStreamMeta
  | { type: 'token'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

export interface EndgameCoachSuggestResponse {
  category:    string
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

export const endgamesApi = {
  practicePosition: (category: string, difficulty: string, excludeFens: string[] = []) => {
    const p = new URLSearchParams()
    p.set('category',   category)
    p.set('difficulty', difficulty)
    if (excludeFens.length) p.set('exclude_fens', excludeFens.join(','))
    return req<EndgamePracticePosition>(`/api/endgames/practice-position?${p.toString()}`)
  },

  practicePositionByConfig: (body: ByConfigRequest) =>
    req<ByConfigResponse>('/api/endgames/practice-position/by-config', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    }),

  syzygy: (fen: string) =>
    req<EndgameSyzygy>(`/api/endgames/syzygy?fen=${encodeURIComponent(fen)}`),

  coachSync: (body: {
    username: string; message: string; fen?: string; category?: string;
    chat_history?: EndgameCoachChatMessage[]
  }) =>
    req<EndgameCoachChatResponse>('/api/endgames/coach/chat', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    }),

  coachSuggestions: (category: string, elo: number | null) => {
    const p = new URLSearchParams()
    if (category)       p.set('category', category)
    if (elo != null)    p.set('elo', String(elo))
    return req<EndgameCoachSuggestResponse>(`/api/endgames/coach/suggestions?${p.toString()}`)
  },

  /**
   * Stream coach response. Mirrors openingsApi.chatStream exactly —
   * manual SSE parser since EventSource doesn't support POST.
   */
  coachStream: async (
    body: {
      username: string; message: string; fen?: string; category?: string;
      chat_history?: EndgameCoachChatMessage[]
    },
    onEvent: (evt: EndgameCoachStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> => {
    const res = await fetch('/api/endgames/coach/chat/stream', {
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
          const evt = JSON.parse(payload) as EndgameCoachStreamEvent
          onEvent(evt)
          if (evt.type === 'done' || evt.type === 'error') return
        } catch { /* ignore */ }
      }
    }
  },
}
