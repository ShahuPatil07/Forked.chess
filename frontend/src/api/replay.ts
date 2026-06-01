/**
 * Feature 3 — Mistake Replay Mode API client.
 * Vite proxies /api/* to the FastAPI backend.
 */

export interface ReplayMistake {
  fen:             string
  move_played:     string   // UCI
  move_played_san: string
  best_move:       string   // UCI
  eval_drop:       number
  threat_type:     string
  game_phase:      string
  move_number:     number
  game_date:       number | null
  opponent:        string
  user_color:      'white' | 'black'
  time_control:    string
  game_url:        string
  game_id:         string
  similarity:      number
}

export interface ClusterMistakesResponse {
  cluster_id:   number | string
  cluster_rank: number
  mistakes:     ReplayMistake[]
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(text || `HTTP ${res.status}`)
  }
  return res.json()
}

export const replayApi = {
  getMistakes: (username: string, clusterId: string) =>
    req<ClusterMistakesResponse>(`/api/cluster/${username}/${clusterId}/mistakes`),

  getInsight: (username: string, clusterId: string) =>
    req<{ insight: string }>(`/api/cluster/${username}/${clusterId}/insight`),

  explain: (body: { fen: string; played: string; best: string; threat_type: string; user_elo?: number }) =>
    req<{ explanation: string }>(`/api/cluster/explain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  // Per-position "Notice" — unique to each board, cached per-FEN
  getNote: (body: { fen: string; played: string; best: string; threat_type: string }) =>
    req<{ note: string }>(`/api/cluster/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
}
