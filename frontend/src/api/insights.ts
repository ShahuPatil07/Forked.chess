/**
 * Dashboard analytics (backend/insights.py) + the counterfactual rating
 * (backend/counterfactual.py).
 */
import { errorMessage } from './auth'

export interface CounterfactualCluster {
  cluster_id: string
  label?: string
  cluster_rank: number
  gain: number
  games_recovered: number
  points_recovered: number
}

export interface CounterfactualLadderStep {
  cluster_id: string
  label?: string
  cluster_rank: number | null
  step_gain: number
  cumulative: number
  rating_after: number
}

export interface Counterfactual {
  username: string
  model: string
  actual_rating: number | null
  rating_source: string
  total_gain: number
  potential_rating: number | null
  games_recovered: number
  points_recovered: number
  n_games: number
  has_result_data: boolean
  score_rate?: number
  avg_opp_rating?: number
  performance_rating?: number
  per_cluster: CounterfactualCluster[]
  ladder: CounterfactualLadderStep[]
  examples: { game_id: string; family: string; move_number: number; played: string; best_uci: string; fen: string;
              es_before: number; es_after: number; result: number; recover: number }[]
}

export interface ProgressBin {
  x: number; label: string; you_moves: number; peer_moves: number
  you_inaccuracies: number; you_mistakes: number; you_blunders: number
  you_p: number; peer_p: number; you_p_blunder: number; peer_p_blunder: number
}
export interface ArcBin {
  x: number; avg: number | null; p25: number | null; p75: number | null; wp: number | null
  wp_win: number | null; wp_draw: number | null; wp_loss: number | null
}
export interface Insights {
  version: number
  overview: {
    games: number; wins: number; draws: number; losses: number; score: number | null
    avg_opp_elo: number | null; performance: number | null; rating_start: number | null; rating_end: number | null
    accuracy: number | null; peer_accuracy: number | null; avg_plies: number
    you: Record<'inaccuracy' | 'mistake' | 'blunder', number>; peer: Record<'inaccuracy' | 'mistake' | 'blunder', number>
    you_per_game: Record<'inaccuracy' | 'mistake' | 'blunder', number>; peer_per_game: Record<'inaccuracy' | 'mistake' | 'blunder', number>
    you_moves: number; peer_moves: number
  }
  progress: ProgressBin[]
  eval_arc: ArcBin[]
  conversion: {
    you: { winning_games: number; converted: number; drawn: number; lost: number; conversion_rate: number | null
           losing_games: number; saved: number; comebacks: number; save_rate: number | null }
    peer: { winning_games: number; conversion_rate: number | null; losing_games: number; save_rate: number | null }
    thrown: { game_id: string; url: string | null; opponent: string | null; peak: number; peak_move: number; outcome: string; played_at: number | null }[]
  }
  situations: { situation: 'ahead' | 'equal' | 'behind'; you_moves: number; peer_moves: number; you_rate: number | null; peer_rate: number | null }[]
  radar: { axis: string; key: string; you: number | null; detail: Record<string, unknown> }[]
  clock: { has_data: boolean; buckets: { label: string; count: number }[]; think_buckets: { label: string; count: number }[]
           fast_blunder_share: number | null; median_blunder_think_s: number | null; time_trouble_share: number | null }
  pieces: { piece: string; count: number; share: number }[]
  trend: { i: number; played_at: number | null; accuracy: number | null; blunders: number; rating: number | null; outcome: string | null; acc_avg: number | null; blunders_avg: number }[]
  colors: { color: 'white' | 'black'; games: number; score: number | null; accuracy: number | null; blunders_per_game: number | null }[]
  severity: { label: string; count: number }[]
  stages: { stage: string; you: number | null; peer: number | null }[]
  findings: { tone: 'danger' | 'warn' | 'good' | 'info'; title: string; body: string }[]
}

async function req<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

export const insightsApi = {
  counterfactual: (username: string) => req<Counterfactual>(`/api/profile/${encodeURIComponent(username)}/counterfactual`),
  insights: (username: string) => req<Insights>(`/api/insights/${encodeURIComponent(username)}`),
}
