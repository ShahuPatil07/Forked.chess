/**
 * Features 4 & 5 — Counterfactual Rating + Fingerprint Card API client.
 */

export interface CounterfactualCluster {
  cluster_id:      number | string
  cluster_rank:    number
  gain:            number
  games_recovered: number
}

export interface CounterfactualLadderStep {
  cluster_id:   number | string
  cluster_rank: number
  step_gain:    number
  cumulative:   number
  rating_after: number
}

export interface Counterfactual {
  username:         string
  actual_rating:    number
  total_gain:       number
  potential_rating: number
  games_recovered:  number
  n_games:          number
  has_result_data:  boolean
  per_cluster:      CounterfactualCluster[]
  ladder:           CounterfactualLadderStep[]
}

async function req<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(text || `HTTP ${res.status}`)
  }
  return res.json()
}

export interface StyleProfile {
  username:     string
  archetype:    string | null
  description?: string
  axis1:        number | null
  axis2:        number | null
  axis3:        number | null
  axis4:        number | null
  axis5:        number | null
  n_games:      number
  n_mistakes:   number
  insufficient: boolean
  computed_at:  string
}

export const insightsApi = {
  counterfactual: (username: string) =>
    req<Counterfactual>(`/api/profile/${username}/counterfactual`),

  style: (username: string) =>
    req<StyleProfile>(`/api/profile/${username}/style`),

  // DNA card is the canonical card now; cardUrl kept for any legacy callers.
  dnaCardUrl: (username: string) => `/api/profile/${username}/dna-card`,
  cardUrl:    (username: string) => `/api/profile/${username}/dna-card`,
}
