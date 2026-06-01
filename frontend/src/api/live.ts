/**
 * Feature 1 (live sync + blindspot alerts) and Feature 2 (post-game debrief)
 * API client. Kept separate from index.ts so these endpoints are self-contained.
 * Vite proxies /api/* to the FastAPI backend.
 */

export interface BlindspotAlert {
  id:             string
  game_id:        string
  opponent:       string
  move_number:    number
  cluster_id:     number | string
  cluster_rank:   number
  similarity:     number
  eval_drop:      number
  fen:            string
  best_move:      string
  played_move:    string
  mastery_before: number | null
  mastery_after:  number | null
  timestamp:      string
  seen:           boolean
}

export interface DebriefMatch {
  move_number:    number
  fen:            string
  played:         string
  best:           string
  eval_drop:      number
  cluster_id:     number | string
  cluster_rank:   number
  similarity:     number
  mastery_before: number | null
  mastery_after:  number | null
}

export interface BotGameDebrief {
  matched:         DebriefMatch[]
  unmatched_count: number
  total_mistakes:  number
  has_profile:     boolean
}

export interface SyncStatus {
  last_synced_at: string | null
  is_syncing:     boolean
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(text || `HTTP ${res.status}`)
  }
  return res.json()
}

export const liveApi = {
  getAlerts: (username: string) =>
    req<{ username: string; alerts: BlindspotAlert[] }>(`/api/alerts/${username}`),

  markAlertsSeen: (username: string, alertIds: string[]) =>
    req<{ marked: number }>(`/api/alerts/${username}/mark-seen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alert_ids: alertIds }),
    }),

  getSyncStatus: (username: string) =>
    req<SyncStatus>(`/api/sync/status/${username}`),

  triggerSync: (username: string, platform = 'lichess') =>
    req<{ status: string }>(`/api/sync/trigger/${username}?platform=${platform}`, { method: 'POST' }),

  debriefBotGame: (gameId: string, username: string) =>
    req<BotGameDebrief>(`/api/bot-game/${gameId}/debrief`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    }),
}
