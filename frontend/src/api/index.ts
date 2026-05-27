import type {
  ProfileResponse,
  GameSummary,
  SessionResponse,
  UserSettings,
  IngestProgress,
  ClusterSummary,
  AnalyticsData,
} from '../types'

const BASE = ''  // proxied by Vite to http://localhost:8000

async function req<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, options)
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText)
    throw new Error(msg)
  }
  return res.json()
}

export const api = {
  check: (username: string) =>
    req<{ has_profile: boolean }>(`/api/check/${username}`),

  startIngest: (username: string, platform: string, minGames: number, apiKey?: string) =>
    req<{ job_id: string; status: string }>('/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, platform, min_games: minGames, api_key: apiKey }),
    }),

  getProfile: (username: string) =>
    req<ProfileResponse>(`/api/profile/${username}`),

  getCluster: (username: string, clusterId: string) =>
    req<ClusterSummary & { all_events: unknown[]; rank: number }>(
      `/api/cluster/${username}/${clusterId}`
    ),

  getGames: (username: string) =>
    req<{ username: string; games: GameSummary[]; total_games: number }>(
      `/api/games/${username}`
    ),

  getSession: (username: string, elo: number, n = 12) =>
    req<SessionResponse>(`/api/session/${username}?elo=${elo}&n=${n}`),

  completeSession: (username: string, results: { cluster_id: string; correct: boolean; time_s: number }[]) =>
    req<{ updated_clusters: string[] }>('/api/session/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, results }),
    }),

  getSettings: (username: string) =>
    req<UserSettings>(`/api/settings/${username}`),

  updateSettings: (username: string, data: Partial<{ elo: number; platform: string }>) =>
    req<UserSettings>(`/api/settings/${username}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),

  getAnalytics: (username: string) =>
    req<AnalyticsData>(`/api/analytics/${username}`),
}

export function subscribeToIngest(
  jobId: string,
  username: string,
  onUpdate: (evt: IngestProgress) => void,
): () => void {
  const es = new EventSource(`/api/ingest/status/${jobId}`)
  // Track whether a terminal event (done/error) was already received.
  // When the server sends one and closes the stream, EventSource fires
  // onerror too — we must not overwrite the real message in that case.
  let terminal = false

  es.onmessage = (e) => {
    try {
      const parsed = JSON.parse(e.data) as IngestProgress
      if (parsed.type === 'heartbeat') return
      onUpdate(parsed)
      if (parsed.type === 'done' || parsed.type === 'error') {
        terminal = true
        es.close()
      }
    } catch {
      // ignore parse errors
    }
  }
  es.onerror = () => {
    if (terminal) return
    es.close()
    // Server may have hot-reloaded or restarted — check if profile already completed
    ;(async () => {
      try {
        const res = await fetch(`/api/check/${username}`)
        if (res.ok) {
          const { has_profile } = await res.json() as { has_profile: boolean }
          if (has_profile) {
            onUpdate({ type: 'done', pct: 100, message: 'Profile ready — redirecting…', stage: 'clustering' })
            return
          }
        }
      } catch { /* network still down */ }
      onUpdate({
        type: 'error',
        pct: 0,
        message: 'Connection to server lost. The analysis may still be running — refresh the page to check.',
        stage: 'fetching',
      })
    })()
  }
  return () => es.close()
}
