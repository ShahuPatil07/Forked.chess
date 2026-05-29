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
}

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
