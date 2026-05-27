import type {
  ProfileResponse,
  GameSummary,
  SessionResponse,
  UserSettings,
  IngestProgress,
  ClusterSummary,
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
}

export function subscribeToIngest(
  jobId: string,
  onUpdate: (evt: IngestProgress) => void,
): () => void {
  const es = new EventSource(`/api/ingest/status/${jobId}`)
  es.onmessage = (e) => {
    try {
      onUpdate(JSON.parse(e.data))
    } catch {
      // ignore parse errors (heartbeats)
    }
  }
  es.onerror = () => es.close()
  return () => es.close()
}
