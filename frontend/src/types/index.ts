export interface RepresentativeEvent {
  fen: string
  move_played: string
  best_move: string
  eval_drop_cp: number
  threat_type: string
  game_phase: string
  move_number: number
}

export interface ClusterSummary {
  cluster_id: string | number
  label: string
  size: number
  score: number
  rank: number
  dominant_threat_type: string
  dominant_game_phase: string
  mastery: number
  last_occurrence_unix: number | null
  next_review_unix: number | null
  representative_events: RepresentativeEvent[]
}

export interface ProfileStats {
  total_games: number
  total_mistakes: number
  top_threat: string
  threat_breakdown: Record<string, number>
  phase_breakdown: Record<string, number>
}

export interface ProfileResponse {
  username: string
  clusters: ClusterSummary[]
  stats: ProfileStats
}

export interface GameMistake {
  fen: string
  move_played_san: string
  best_move_uci: string
  eval_drop_cp: number
  threat_type: string
  game_phase: string
  move_number: number
  cluster_id: string | null
}

export interface GameSummary {
  game_id: string
  white_username?: string
  black_username?: string
  user_color?: string
  opponent?: string
  time_control?: string
  played_at_unix: number | null
  mistake_count: number
  phase_breakdown: Record<string, number>
  top_threat: string
  lichess_url: string
  game_url?: string
  mistakes: GameMistake[]
}

export interface ThreatStat {
  threat: string
  count: number
  avg_drop: number
}

export interface PhaseData {
  phase: string
  count: number
}

export interface MoveBucket {
  move_bucket: number
  label: string
  count: number
  avg_drop: number
}

export interface ScatterPoint {
  move_number: number
  eval_drop_cp: number
  threat_type: string
  game_phase: string
}

export interface AnalyticsData {
  username: string
  total_mistakes: number
  threat_stats: ThreatStat[]
  phase_breakdown: PhaseData[]
  moves_aggregated: MoveBucket[]
  scatter: ScatterPoint[]
}

export interface PuzzleItem {
  puzzle_id: string
  fen: string
  moves: string   // "triggerUCI solutionUCI1 responseUCI solutionUCI2 ..."
  rating: number
  themes: string
  threat: string
  game_url: string
}

export interface SessionItem {
  cluster_id: string
  cluster_label: string
  blindspot_rank: number
  missed_count: number
  puzzle: PuzzleItem
}

export interface SessionResponse {
  session_id: string
  items: SessionItem[]
}

export interface IngestProgress {
  type: 'progress' | 'done' | 'error' | 'heartbeat'
  job_id?: string
  stage?: 'fetching' | 'annotating' | 'clustering'
  games_done?: number
  games_total?: number
  mistakes_found?: number
  pct?: number
  message?: string
  clusters_count?: number
  username?: string
  error?: string
}

export interface UserSettings {
  username: string
  platform: 'lichess' | 'chesscom'
  elo: number
  has_profile: boolean
}

// Local user state (stored in Zustand + localStorage)
export interface UserState {
  username: string
  platform: 'lichess' | 'chesscom'
  elo: number
  activeJobId: string | null
}
